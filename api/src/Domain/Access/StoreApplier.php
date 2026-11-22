<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use LogicException;
use Omw\Api\Config;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Paths;
use Omw\Api\Infra\Store\StoreWriter;
use Omw\Api\Infra\Store\StoreWriterException;
use Omw\Api\Infra\Store\StoreWriterFactory;
use Psr\Log\LoggerInterface;
use Throwable;

/**
 * Applies pending store ops with the API's own writer (spec-wave5 §3.8.3). It never blocks a PHP
 * worker on another writer and no database transaction ever spans a filesystem or SFTP call:
 *
 *   0. refuses to run inside an open transaction (LogicException);
 *   1. flock(var/cache/store.lock, LOCK_EX|LOCK_NB): held elsewhere → "not applied" at once (the
 *      holder drains the queue);
 *   2. takes the lease (lease_holder api, 60 s) in a short transaction, unless the Mac holds an
 *      unexpired one;
 *   3. opens the writer (none / blocked / backing off after a failure → "not applied") and checks
 *      the store marker: it must carry access_state.store_id. Exceptions: a pending init op is
 *      applied first while no marker exists; a marker whose epoch differs from the database's
 *      (while not restoring) puts the database into "restoring", so the restored_api reconcile
 *      repairs whatever diverged. A missing or foreign marker stops everything (writer_error
 *      "store_unverified: …", alert access_store_unverified);
 *   4. applies pending ops in id order, each committed in its own short transaction; before each
 *      op it stops when the lease (minus 10 s) or the deadline ran out, renewing the lease when
 *      time allows; the first failure stops the run (order matters);
 *   5. drains: ops enqueued meanwhile by requests that got "not applied" are applied too;
 *   6. optionally reconciles (§3.8.5), then rewrites the marker {format, storeId, epoch, op, at}
 *      (the epoch stays the marker's own while restoring) and releases lease and lock.
 *
 * A session put's path is redacted once applied. The F3 deny-all .htaccess is written with the
 * marker by the init op and re-checked by every reconcile.
 */
final class StoreApplier
{
    public const LOCK = 'cache/store.lock';
    public const LEASE_SECONDS = 60;
    public const LEASE_MARGIN_SECONDS = 10;
    /** After a writer failure (not auth), request paths wait this long before connecting again; cron always tries. */
    public const BACKOFF_SECONDS = 60;

    public function __construct(
        private readonly Db $db,
        private readonly Paths $paths,
        private readonly Config $config,
        private readonly StoreWriterFactory $writers,
        private readonly StoreOps $ops,
        private readonly Reconciler $reconciler,
        private readonly ?LoggerInterface $logger = null,
    ) {
    }

    /**
     * @param float $deadlineSeconds 8 for requests, 20 for cron
     * @param bool  $reconcile       also run the repair job (cron, retry, restores)
     * @return array{ran: bool, reason: string|null, applied: int, pending: int, reconciled: bool}
     */
    public function applyNow(float $deadlineSeconds = 8.0, bool $reconcile = false): array
    {
        if ($this->db->pdo()->inTransaction()) {
            throw new LogicException('StoreApplier::applyNow() must not run inside a database transaction.');
        }
        $deadline = microtime(true) + $deadlineSeconds;
        $result = ['ran' => false, 'reason' => null, 'applied' => 0, 'pending' => 0, 'reconciled' => false];
        if ($this->config->access->storeMode === 'none') {
            return ['reason' => 'none', 'pending' => $this->ops->pendingCount()] + $result;
        }
        $this->paths->ensureVar();
        $lock = @fopen($this->paths->var(self::LOCK), 'c');
        if ($lock === false) {
            return ['reason' => 'lock_file', 'pending' => $this->ops->pendingCount()] + $result;
        }
        try {
            if (!flock($lock, LOCK_EX | LOCK_NB)) {
                return ['reason' => 'busy', 'pending' => $this->ops->pendingCount()] + $result;
            }
            try {
                if (!$this->takeLease()) {
                    return ['reason' => 'mac', 'pending' => $this->ops->pendingCount()] + $result;
                }
                try {
                    $result = $this->runLocked($deadline, $deadlineSeconds, $reconcile);
                } finally {
                    $this->releaseLease();
                }
            } finally {
                flock($lock, LOCK_UN);
            }
        } finally {
            fclose($lock);
        }
        $result['pending'] = $this->ops->pendingCount();

        return $result;
    }

    /**
     * Effect of an action whose ops end at $maxOpId (contract Effect): applied when none of its
     * ops is pending any more.
     *
     * @return array{applied: bool, via: string, pendingOps: int}
     */
    public function effect(int $maxOpId): array
    {
        $mode = $this->config->access->storeMode;
        $pending = $this->ops->pendingCount();
        if ($maxOpId === 0 || $this->ops->pendingUpTo($maxOpId) === 0) {
            $by = $maxOpId === 0 ? null : $this->db->scalar('SELECT applied_by FROM store_ops WHERE id = ?', [$maxOpId]);
            $via = $by === 'mac' || ($by === null && $mode === 'none') ? 'mac' : ($mode === 'none' ? 'mac' : $mode);

            return ['applied' => true, 'via' => $via, 'pendingOps' => $pending];
        }

        return ['applied' => false, 'via' => $mode === 'none' ? 'mac' : 'pending', 'pendingOps' => $pending];
    }

    /**
     * The store as the writer sees it (contract StoreListing).
     *
     * @return array{marker: string|null, locked: string|null, sessions: list<string>, handoffs: list<string>, tombstones: list<array{path: string, content: string}>, strays: list<string>}
     */
    public static function listing(StoreWriter $writer): array
    {
        $sessions = [];
        $handoffs = [];
        $tombstones = [];
        $strays = [];
        $addStray = static function (string $path) use (&$strays): void {
            if (count($strays) < 1000) {
                $strays[] = preg_match('#^[\x21-\x7e]{1,200}$#D', $path) === 1 ? $path : '?';
            }
        };
        foreach ($writer->list('s') as $name) {
            $dir = 's/' . $name;
            if (StoreLayout::kind($dir) === 'sessionDir' && $writer->isDir($dir)) {
                foreach ($writer->list($dir) as $file) {
                    $path = $dir . '/' . $file;
                    StoreLayout::kind($path) === 'session' ? $sessions[] = $path : $addStray($path);
                }
            } else {
                $addStray($dir);
            }
        }
        foreach ($writer->list('h') as $name) {
            Tokens::isDeviceId($name) ? $handoffs[] = $name : $addStray('h/' . $name);
        }
        foreach ($writer->list('t') as $name) {
            $path = 't/' . $name;
            $kind = StoreLayout::kind($path);
            if ($kind === 'personTombstone' || $kind === 'deviceTombstone') {
                $tombstones[] = ['path' => $path, 'content' => mb_substr((string) $writer->read($path), 0, 1000)];
            } else {
                $addStray($path);
            }
        }
        foreach ($writer->list('') as $name) {
            if (!in_array($name, [StoreLayout::MARKER, StoreLayout::LOCKED, StoreLayout::HTACCESS, 's', 'h', 't'], true)) {
                $addStray($name);
            }
        }
        $marker = $writer->read(StoreLayout::MARKER);
        $locked = $writer->read(StoreLayout::LOCKED);

        return [
            'marker' => $marker === null ? null : mb_substr($marker, 0, 1000),
            'locked' => $locked === null ? null : mb_substr($locked, 0, 1000),
            'sessions' => array_slice($sessions, 0, 10_000),
            'handoffs' => array_slice($handoffs, 0, 10_000),
            'tombstones' => array_slice($tombstones, 0, 10_000),
            'strays' => $strays,
        ];
    }

    /** @return array{storeId: string, epoch: string, op: int, at: string}|null */
    public static function parseMarker(?string $raw): ?array
    {
        $data = $raw === null ? null : json_decode($raw, true);
        if (!is_array($data) || ($data['format'] ?? null) !== 1 || !is_string($data['storeId'] ?? null) || preg_match('/^[0-9a-f]{16}$/D', $data['storeId']) !== 1
            || !is_string($data['epoch'] ?? null) || preg_match('/^[0-9a-f]{16}$/D', $data['epoch']) !== 1 || !is_int($data['op'] ?? null) || !is_string($data['at'] ?? null)) {
            return null;
        }

        return ['storeId' => $data['storeId'], 'epoch' => $data['epoch'], 'op' => $data['op'], 'at' => $data['at']];
    }

    public static function markerJson(string $storeId, string $epoch, int $op): string
    {
        return json_encode(['format' => 1, 'storeId' => $storeId, 'epoch' => $epoch, 'op' => $op, 'at' => Clock::nowIso()], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
    }

    /** @return array{ran: bool, reason: string|null, applied: int, pending: int, reconciled: bool} */
    private function runLocked(float $deadline, float $deadlineSeconds, bool $reconcile): array
    {
        $result = ['ran' => true, 'reason' => null, 'applied' => 0, 'pending' => 0, 'reconciled' => false];
        $state = $this->state();
        if ($state['writer_blocked_at'] !== null) {
            return ['reason' => 'blocked'] + $result;
        }
        if ($deadlineSeconds < 15 && $this->inBackoff()) {
            return ['reason' => 'backoff'] + $result;
        }
        try {
            $writer = $this->writers->open();
        } catch (StoreWriterException $e) {
            $this->writerFailed($e);

            return ['reason' => 'writer'] + $result;
        }
        if ($writer === null) {
            return ['reason' => 'none'] + $result;
        }
        try {
            $verified = $this->verify($writer, $state);
            if ($verified === null) {
                return ['reason' => 'store_unverified'] + $result;
            }
            $marker = $verified;
            $state = $this->state();
            $failed = false;
            $result['applied'] += $this->loop($writer, $deadline, $failed);
            if ($reconcile && !$failed && microtime(true) < $deadline - 2) {
                $listedThrough = (int) $this->state()['last_applied_op'];
                $this->checkHtaccess($writer);
                $this->reconciler->run(self::listing($writer), $listedThrough);
                $result['reconciled'] = true;
                $result['applied'] += $this->loop($writer, $deadline, $failed);
            }
            $state = $this->state();
            $restoring = $state['reconciled_epoch'] !== $state['epoch'];
            $epoch = $restoring && $marker !== false ? $marker['epoch'] : (string) $state['epoch'];
            $lastOp = (int) $state['last_applied_op'];
            if ($result['applied'] > 0 || $marker === false || $marker['epoch'] !== $epoch || $marker['op'] !== $lastOp) {
                $writer->replace(StoreLayout::MARKER, self::markerJson((string) $state['store_id'], $epoch, $lastOp));
            }
            if (!$failed) {
                $this->setWriterError(null);
            }
        } catch (StoreWriterException $e) {
            $this->writerFailed($e);

            return ['reason' => 'writer'] + $result;
        } finally {
            $writer->close();
        }

        return $result;
    }

    /**
     * Checks the store marker; applies a pending init op first when there is none.
     *
     * @param array<string, mixed> $state
     * @return array{storeId: string, epoch: string, op: int, at: string}|false|null the marker, false = just
     *         initialised, null = refused (store_unverified recorded)
     */
    private function verify(StoreWriter $writer, array $state): array|false|null
    {
        $storeId = $state['store_id'];
        if (!is_string($storeId)) {
            $this->setWriterError('store_unverified: the store is not initialised yet (Admin → Website-Speicher einrichten)');

            return null;
        }
        $raw = $writer->read(StoreLayout::MARKER);
        if ($raw === null) {
            $init = $this->ops->pendingInit();
            if ($init === null) {
                $this->setWriterError('store_unverified: the store marker is missing (initialise the store again)');

                return null;
            }
            $writer->replace(StoreLayout::HTACCESS, StoreLayout::HTACCESS_CONTENT);
            $writer->put(StoreLayout::MARKER, self::markerJson($storeId, (string) $state['epoch'], (int) $state['last_applied_op']), true);
            $raw = $writer->read(StoreLayout::MARKER);
            $marker = self::parseMarker($raw);
            if ($marker === null || $marker['storeId'] !== $storeId) {
                $this->setWriterError('store_unverified: the store marker belongs to another store');

                return null;
            }
            $this->ops->markApplied([$init], 'api');

            return false;
        }
        $marker = self::parseMarker($raw);
        if ($marker === null || $marker['storeId'] !== $storeId) {
            $this->setWriterError($marker === null ? 'store_unverified: the store marker is unreadable' : 'store_unverified: the store marker belongs to another store');

            return null;
        }
        if ($marker['epoch'] !== $state['epoch'] && $state['reconciled_epoch'] === $state['epoch']) {
            // The store and the database went separate ways (a webspace or database copy from
            // another time): repair like after a restore before any join is allowed again.
            $this->logger?->warning('Store marker epoch differs from the database: reconciling as after a restore');
            $this->db->write(fn (): int => $this->db->exec('UPDATE access_state SET reconciled_epoch = NULL, updated_at = ? WHERE id = 1', [Clock::nowIso()]));
        }
        // A pending init op with a marker present is a no-op (the marker is never overwritten).
        $init = $this->ops->pendingInit();
        if ($init !== null) {
            $this->ops->markApplied([$init], 'api');
        }

        return $marker;
    }

    private function loop(StoreWriter $writer, float $deadline, bool &$failed): int
    {
        $applied = 0;
        while (!$failed) {
            $batch = $this->ops->pending(50);
            if ($batch === []) {
                break; // drained (also of ops enqueued meanwhile)
            }
            foreach ($batch as $op) {
                $now = microtime(true);
                if ($now >= $deadline) {
                    return $applied;
                }
                // Per-op lease check (one cheap read): stop when the lease is gone, renew it when
                // less than LEASE_MARGIN_SECONDS are left and the deadline allows another op.
                $leaseUntil = $this->leaseUntil();
                if ($leaseUntil === null) {
                    return $applied;
                }
                if ($now >= $leaseUntil - self::LEASE_MARGIN_SECONDS && ($deadline - $now < 1 || !$this->renewLease())) {
                    return $applied;
                }
                try {
                    $this->applyOp($writer, $op);
                } catch (StoreWriterException $e) {
                    $this->ops->markFailed($op['id'], $e->reason . ': ' . $e->getMessage());
                    if (in_array($e->reason, ['connect', 'auth', 'host_key', 'site_login', 'config'], true)) {
                        throw $e;
                    }
                    $this->logger?->warning('Store op {id} failed: {error}', ['id' => $op['id'], 'error' => $e->getMessage()]);
                    $this->setWriterError(mb_substr($e->reason . ': ' . $e->getMessage(), 0, 500));
                    $failed = true;

                    return $applied;
                }
                $this->ops->markApplied([$op['id']], 'api');
                ++$applied;
            }
        }

        return $applied;
    }

    /** @param array{id: int, op: string, path: string, content: string|null, exclusive: bool} $op */
    public static function applyOp(StoreWriter $writer, array $op): void
    {
        $path = $op['path'];
        if (!StoreLayout::isValidOpPath($op['op'], $path, $op['exclusive'])) {
            throw new StoreWriterException('path', 'Refused op ' . $op['op'] . ' ' . StoreLayout::redact($path));
        }
        switch ($op['op']) {
            case 'init':
                break; // handled by the marker check (only ever creates a missing marker)
            case 'put':
                if ($path === StoreLayout::MARKER) {
                    $writer->replace($path, (string) $op['content']);
                    break;
                }
                $writer->put($path, (string) $op['content'], true);
                if (StoreLayout::kind($path) === 'personTombstone' && (Reconciler::parseTombstone((string) $op['content'])['s'] ?? null) === 'deleted'
                    && (Reconciler::parseTombstone((string) $writer->read($path))['s'] ?? null) !== 'deleted') {
                    // A person revoked first and deleted later: "revoked" → "deleted" (atomic, never back),
                    // so a restored database erases her again (§3.8.6).
                    $writer->replace($path, (string) $op['content']);
                }
                break;
            case 'delete':
                StoreLayout::kind($path) === 'stray' ? $writer->deleteTree($path) : $writer->delete($path);
                break;
            case 'delete_prefix':
                $slash = (int) strrpos($path, '/');
                $writer->deletePrefix(substr($path, 0, $slash), substr($path, $slash + 1));
                break;
            case 'delete_tree':
                $writer->deleteTree($path);
                break;
        }
    }

    private function checkHtaccess(StoreWriter $writer): void
    {
        try {
            if ($writer->read(StoreLayout::HTACCESS) !== StoreLayout::HTACCESS_CONTENT) {
                $writer->replace(StoreLayout::HTACCESS, StoreLayout::HTACCESS_CONTENT);
            }
        } catch (StoreWriterException $e) {
            $this->logger?->warning('Store .htaccess check failed: {error}', ['error' => $e->getMessage()]);
        }
    }

    /** @return array<string, mixed> */
    private function state(): array
    {
        return $this->db->one('SELECT * FROM access_state WHERE id = 1') ?? [];
    }

    private function takeLease(): bool
    {
        return $this->db->write(function (): bool {
            $row = $this->state();
            $now = Clock::now();
            if (($row['lease_holder'] ?? null) === 'mac' && is_string($row['lease_until'] ?? null) && $row['lease_until'] > Clock::iso($now)) {
                return false;
            }
            $this->db->exec(
                "UPDATE access_state SET lease_holder = 'api', lease_until = ?, updated_at = ? WHERE id = 1",
                [Clock::iso($now->modify('+' . self::LEASE_SECONDS . ' seconds')), Clock::iso($now)],
            );

            return true;
        });
    }

    private function renewLease(): bool
    {
        return $this->db->write(function (): bool {
            $now = Clock::now();

            return $this->db->exec(
                "UPDATE access_state SET lease_until = ?, updated_at = ? WHERE id = 1 AND lease_holder = 'api'",
                [Clock::iso($now->modify('+' . self::LEASE_SECONDS . ' seconds')), Clock::iso($now)],
            ) === 1;
        });
    }

    private function releaseLease(): void
    {
        try {
            $this->db->write(fn (): int => $this->db->exec(
                "UPDATE access_state SET lease_holder = NULL, lease_until = NULL, updated_at = ? WHERE id = 1 AND lease_holder = 'api'",
                [Clock::nowIso()],
            ));
        } catch (Throwable $e) {
            $this->logger?->warning('Could not release the store lease: {error}', ['error' => $e->getMessage()]);
        }
    }

    /** End of the API's lease as a unix timestamp comparable with microtime(); null when the API does not hold it. */
    private function leaseUntil(): ?float
    {
        $row = $this->db->one('SELECT lease_holder, lease_until FROM access_state WHERE id = 1');
        $until = $row['lease_until'] ?? null;
        if (($row['lease_holder'] ?? null) !== 'api' || !is_string($until)) {
            return null;
        }
        // The frozen test clock and the real clock differ: measure the lease relative to "now".
        $left = (new \DateTimeImmutable($until))->getTimestamp() - Clock::now()->getTimestamp();

        return microtime(true) + $left;
    }

    private function inBackoff(): bool
    {
        $at = $this->db->scalar("SELECT value FROM meta WHERE key = 'store_writer_failed_at'");

        return is_string($at) && $at > Clock::iso(Clock::now()->modify('-' . self::BACKOFF_SECONDS . ' seconds'));
    }

    private function writerFailed(StoreWriterException $e): void
    {
        $now = Clock::nowIso();
        $error = mb_substr($e->reason . ': ' . $e->getMessage(), 0, 500);
        $this->logger?->warning('Store writer failed: {error}', ['error' => $error]);
        $this->db->write(function () use ($e, $now, $error): void {
            if ($e->reason === 'auth') {
                $this->db->exec('UPDATE access_state SET writer_blocked_at = ?, writer_error = ?, updated_at = ? WHERE id = 1', [$now, $error, $now]);
            } else {
                $this->db->exec('UPDATE access_state SET writer_error = ?, updated_at = ? WHERE id = 1', [$error, $now]);
            }
            $this->db->exec(
                "INSERT INTO meta (key, value) VALUES ('store_writer_failed_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                [$now],
            );
        });
    }

    private function setWriterError(?string $error): void
    {
        $this->db->write(function () use ($error): void {
            $this->db->exec('UPDATE access_state SET writer_error = ?, updated_at = ? WHERE id = 1 AND (writer_error IS NOT ? )', [$error, Clock::nowIso(), $error]);
            if ($error === null) {
                $this->db->exec("DELETE FROM meta WHERE key = 'store_writer_failed_at'");
            }
        });
    }

    /** Owner pressed "Retry": clears the auth block once. */
    public function clearBlock(): void
    {
        $this->db->write(function (): void {
            $this->db->exec('UPDATE access_state SET writer_blocked_at = NULL, writer_error = NULL, updated_at = ? WHERE id = 1', [Clock::nowIso()]);
            $this->db->exec("DELETE FROM meta WHERE key = 'store_writer_failed_at'");
        });
    }
}
