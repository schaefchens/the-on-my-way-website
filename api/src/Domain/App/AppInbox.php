<?php

declare(strict_types=1);

namespace Omw\Api\Domain\App;

use Omw\Api\Domain\BackendStatus;
use Omw\Api\Domain\Captures;
use Omw\Api\Domain\ChangeLog;
use Omw\Api\Domain\Policy;
use Omw\Api\Domain\Settings;
use Omw\Api\Domain\Time;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use Omw\Api\Infra\Fs;
use Omw\Api\Infra\Paths;
use Psr\Http\Message\StreamInterface;
use Psr\Log\LoggerInterface;
use RuntimeException;
use stdClass;

/**
 * The traveler app's transit inbox (app-plan §3.1, §3.6; contracts ./app and ./app-inbox).
 *
 * An entry goes phone -> inbox -> home archive and is a queue item here, never primary data:
 *
 *   receiving  slots open; the phone PATCHes chunks (tus 1.0 subset, sha256 per chunk)
 *   uploaded   media (+ preview) committed (sha256 of the whole file verified); text: at once
 *   fetching   the backend downloads (Range); a sleeping home computer just leaves it here
 *   archived   the backend acked media (+ preview): their bytes are deleted. The original (Q2 c)
 *              follows on its own, later, on Wi-Fi: committed, fetched and acked the same way
 *   withdrawn  she withdrew it; before the ack the bytes are deleted, after it (or while the
 *              backend fetched) the withdrawal is relayed to the backend (ingest.on_revoke)
 *   rejected   the backend cannot use it (reason shown in the app as "Needs you")
 *
 * Bytes live in var/app-inbox/<entryId>/<uploadId>.part (var/ is denied to the web). The disk
 * budget (APP_INBOX_MAX_BYTES) counts media and previews in full from the create on and originals
 * as they arrive; above it uploads get 507 and wait (the backend pulls promptly, then deletes).
 * Chunk uploads and content downloads take a transfer slot ({@see TransferSlots}).
 *
 * Idempotency: a create is keyed by (entryId, entryHash); chunks by Upload-Offset; commit, ack and
 * reject are no-ops when repeated. An entry id keeps its first content for good, also once
 * withdrawn: a moment she takes back and shares again comes with a new id (the app makes one).
 * Scope (Q4 a): a phone sees and changes only its own entries; the same app install connected
 * again takes over its earlier connections' entries ({@see AppPhones::pair()}).
 */
final class AppInbox
{
    public const DIR = 'app-inbox';
    public const HOUSEKEEPING_EVERY_SECONDS = 15 * 60;
    public const RETRY_FULL_SECONDS = 900;

    private const STATE_ARCHIVE_ONLY = 'backend.archive_only';
    private const STATE_BACKEND_SEEN = 'backend.seen_at';
    private const STATE_HOUSEKEEPING = 'housekeeping.at';
    private const LIVE_SLOTS = ['open', 'committed'];
    private const VISIBILITY_RANK = ['' => 0, 'pending' => 1, 'hidden' => 2];
    private const READ_BYTES = 65536;

    public function __construct(
        private readonly Db $db,
        private readonly Paths $paths,
        private readonly AppInboxConfig $config,
        private readonly TransferSlots $slots,
        private readonly ChangeLog $changes,
        private readonly Settings $settings,
        private readonly BackendStatus $backendStatus,
        private readonly LoggerInterface $logger,
    ) {
    }

    // =========================================================================================
    // App side

    /**
     * POST /app/entries (AppEntryCreate, schema-validated by the caller).
     *
     * @return array{created: bool, state: array<string, mixed>}
     */
    public function create(int $phoneId, stdClass $body): array
    {
        $entry = $body->entry;
        if (!$entry instanceof stdClass) {
            throw ApiException::validation('entry must be an object.');
        }
        $problems = AppRules::entryProblems($entry);
        if (!Time::isValidTimeZone($entry->tz ?? null)) {
            $problems[] = ['path' => ['tz'], 'message' => 'not a known IANA time zone'];
        }
        if ($problems !== []) {
            throw ApiException::validation('The entry breaks the app rules.', [
                'errors' => array_map(static fn (array $p): string => '/entry/' . implode('/', $p['path']) . ': ' . $p['message'], $problems),
            ]);
        }
        $entryId = (string) $entry->entryId;
        $hash = AppRules::entryHash($entry);

        $existing = $this->db->one('SELECT phone_id, entry_hash FROM app_entries WHERE entry_id = ?', [$entryId]);
        if ($existing !== null) {
            if ((int) $existing['phone_id'] !== $phoneId || (string) $existing['entry_hash'] !== $hash) {
                throw new ApiException(409, 'entry_conflict', 'An entry with this id but different content exists.');
            }

            return ['created' => false, 'state' => $this->stateOf($entryId)];
        }

        /** @var list<stdClass> $files */
        $files = array_values(array_filter(is_array($entry->files ?? null) ? $entry->files : [], static fn (mixed $f): bool => $f instanceof stdClass));
        $reserve = 0;
        foreach ($files as $file) {
            $role = (string) $file->role;
            $max = $this->config->fileMaxBytes($role);
            if ((int) $file->bytes > $max) {
                throw new ApiException(413, 'upload_too_large', sprintf('The %s file is larger than the inbox takes (%d bytes).', $role, $max), ['role' => $role, 'maxBytes' => $max]);
            }
            if ($role !== 'original') {
                $reserve += (int) $file->bytes;
            }
        }
        $this->housekeeping();
        if ($reserve > 0 && $this->usage() + $reserve > $this->config->maxBytes) {
            throw self::inboxFull();
        }

        $now = Clock::nowIso();
        $time = AppRules::correctOccurredAt((string) $entry->occurredAt, (string) $body->clientNow, $now);
        $choice = isset($entry->visibility) && is_string($entry->visibility) ? $entry->visibility : null;
        if ($time['heldBack'] && $choice !== 'hidden') {
            $choice = 'pending';
        }
        $localDate = isset($entry->localDate) && is_string($entry->localDate) ? $entry->localDate : null;
        $sourceKey = AppRules::sourceKey($entryId);

        $created = $this->db->write(function () use ($phoneId, $entryId, $sourceKey, $hash, $entry, $files, $now, $time, $choice, $localDate): bool {
            if ($this->db->scalar('SELECT 1 FROM app_entries WHERE entry_id = ?', [$entryId]) !== null) {
                return false; // a concurrent replay won the race
            }
            $state = $files === [] ? 'uploaded' : 'receiving';
            $this->db->exec(
                'INSERT INTO app_entries (entry_id, source_key, phone_id, entry_hash, entry_json, kind, state, occurred_at, clamped,
                                          held_back, received_at, uploaded_at, app_visibility, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$entryId, $sourceKey, $phoneId, $hash, self::encode($entry), (string) $entry->kind, $state, $time['occurredAt'],
                    $time['clamped'] ? 1 : 0, $time['heldBack'] ? 1 : 0, $now, $state === 'uploaded' ? $now : null, $choice, $now],
            );
            foreach ($files as $file) {
                $this->db->exec(
                    'INSERT INTO app_uploads (upload_id, entry_id, role, mimetype, bytes, sha256, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [self::newUploadId(), $entryId, (string) $file->role, (string) $file->mimetype, (int) $file->bytes, (string) $file->sha256Hex, $now, $now],
                );
            }
            if ($choice !== null || $localDate !== null) {
                $this->writeAnnotation($sourceKey, $choice, $localDate, true);
            }

            return true;
        });
        if ($created) {
            $this->logger->info('app entry {entryId} received ({kind}, {files} files{held})', [
                'entryId' => $entryId, 'kind' => (string) $entry->kind, 'files' => count($files), 'held' => $time['heldBack'] ? ', held back: older than 30 days' : '',
            ]);
        }

        return ['created' => $created, 'state' => $this->stateOf($entryId)];
    }

    /**
     * GET /app/entries/{entryId} (contract AppEntryState).
     *
     * @return array<string, mixed>
     */
    public function state(int $phoneId, string $entryId): array
    {
        $this->ownEntry($phoneId, $entryId);

        return $this->stateOf($entryId);
    }

    /**
     * GET /app/entries?ids=… (unknown ids and other phones' entries are left out).
     *
     * @param list<string> $entryIds
     * @return list<array<string, mixed>>
     */
    public function states(int $phoneId, array $entryIds): array
    {
        $out = [];
        foreach (array_values(array_unique($entryIds)) as $id) {
            if ($this->db->scalar('SELECT 1 FROM app_entries WHERE entry_id = ? AND phone_id = ?', [$id, $phoneId]) !== null) {
                $out[] = $this->stateOf($id);
            }
        }

        return $out;
    }

    /** DELETE /app/entries/{entryId}: withdraw in any state (no-op when already withdrawn). */
    public function withdraw(int $phoneId, string $entryId): void
    {
        $row = $this->ownEntry($phoneId, $entryId);
        if ($row['state'] === 'withdrawn') {
            return;
        }
        $relay = in_array($row['state'], ['fetching', 'archived'], true) ? 1 : 0;
        $now = Clock::nowIso();
        $paths = $this->db->write(function () use ($entryId, $relay, $now): array {
            $this->db->exec(
                "UPDATE app_entries SET state = 'withdrawn', withdrawn_at = ?, withdraw_relay = ?, updated_at = ? WHERE entry_id = ?",
                [$now, $relay, $now, $entryId],
            );

            return $this->dropSlots($entryId, null, 'deleted', $now);
        });
        $this->unlink($paths);
        $this->logger->info('app entry {entryId} withdrawn by the phone (relay to the backend: {relay})', ['entryId' => $entryId, 'relay' => $relay === 1 ? 'yes' : 'no']);
    }

    /**
     * Removes an app entry for good (DELETE /backend/captures/app:<id>, i.e. the backend purges
     * the capture): its row, its upload slots and any inbox files still on disk. Idempotent.
     */
    public function purge(string $entryId): bool
    {
        if (!AppRules::isEntryId($entryId)) {
            return false;
        }
        $now = Clock::nowIso();
        [$existed, $paths] = $this->db->write(function () use ($entryId, $now): array {
            $paths = $this->dropSlots($entryId, null, 'deleted', $now);
            $existed = $this->db->exec('DELETE FROM app_entries WHERE entry_id = ?', [$entryId]) > 0;

            return [$existed, $paths];
        });
        $this->unlink($paths);
        if ($existed) {
            $this->logger->info('app entry {entryId} purged by the backend', ['entryId' => $entryId]);
        }

        return $existed;
    }

    /**
     * PUT /app/visibility/{sourceKey} (AppVisibilityRequest): tighten her own app entry only.
     *
     * @return array<string, mixed> AppEntryState
     */
    public function setVisibility(int $phoneId, string $sourceKey, string $visibility): array
    {
        if (!str_starts_with($sourceKey, 'app:') || !AppRules::isEntryId(substr($sourceKey, 4))) {
            throw ApiException::forbidden('The app may only change its own app entries.');
        }
        $entryId = substr($sourceKey, 4);
        $row = $this->ownEntry($phoneId, $entryId);
        $this->db->write(function () use ($sourceKey, $entryId, $row, $visibility): void {
            $current = $this->db->scalar('SELECT visibility FROM annotations WHERE source_key = ?', [$sourceKey]);
            $current = is_string($current) ? $current : null;
            $mine = $row['app_visibility'] === null ? null : (string) $row['app_visibility'];
            if ($current !== null && $current !== $mine) {
                throw ApiException::forbidden('The owner decided about this moment in the admin.', 'owner_decided');
            }
            if ($current === $visibility) {
                return;
            }
            if (!isset(self::VISIBILITY_RANK[$visibility]) || self::VISIBILITY_RANK[$visibility] < self::VISIBILITY_RANK[$current ?? '']) {
                throw ApiException::forbidden('Only the owner can make this moment more visible again.', 'needs_owner');
            }
            $this->writeAnnotation($sourceKey, $visibility, null, false);
            $this->db->exec('UPDATE app_entries SET app_visibility = ?, updated_at = ? WHERE entry_id = ?', [$visibility, Clock::nowIso(), $entryId]);
        });

        return $this->stateOf($entryId);
    }

    /** @return array{offset: int, bytes: int} HEAD /app/uploads/{uploadId} */
    public function head(int $phoneId, string $uploadId): array
    {
        $slot = $this->ownSlot($phoneId, $uploadId);

        return ['offset' => (int) $slot['upload_offset'], 'bytes' => (int) $slot['bytes']];
    }

    /**
     * PATCH /app/uploads/{uploadId}: appends one chunk when the whole body arrived and its sha256
     * matches; nothing is appended otherwise. Returns the new offset.
     *
     * @param string|null $checksumHex parsed Upload-Checksum (null = header missing or malformed)
     */
    public function patch(int $phoneId, string $uploadId, int $offset, ?int $length, ?string $checksumHex, StreamInterface $body): int
    {
        $offset = max(0, $offset);
        $slot = $this->ownSlot($phoneId, $uploadId);
        $stored = (int) $slot['upload_offset'];
        $bytes = (int) $slot['bytes'];
        if ($slot['state'] !== 'open' || $offset !== $stored) {
            throw self::offsetMismatch($slot['state'] === 'open' ? $stored : $bytes);
        }
        if ($length === null) {
            throw new ApiException(411, 'length_required', 'Send the chunk with a Content-Length header.');
        }
        if ($checksumHex === null) {
            throw new ApiException(400, 'checksum_required', 'Send Upload-Checksum: sha256 <base64 digest of the chunk>.');
        }
        $chunkMax = $this->config->chunkMaxBytes();
        if ($length > $chunkMax || $offset + $length > $bytes) {
            throw new ApiException(413, 'upload_too_large', sprintf('Chunks are limited to %d bytes and must end within the file.', $chunkMax), ['chunkMaxBytes' => $chunkMax]);
        }
        if ($length === 0) {
            return $stored;
        }
        if ($slot['role'] === 'original' && $this->usage() + $length > $this->config->maxBytes) {
            throw self::inboxFull();
        }

        $transfer = $this->slots->acquire();
        $file = null;
        try {
            $path = $this->partPath((string) $slot['entry_id'], $uploadId);
            Paths::ensureDir(dirname($path));
            $file = @fopen($path, 'c+b');
            if ($file === false) {
                throw new RuntimeException('Cannot open ' . $path);
            }
            if (!flock($file, LOCK_EX | LOCK_NB)) {
                throw (new ApiException(503, 'transfer_busy', 'This file is being written by another request.'))->withHeaders(['Retry-After' => '10']);
            }
            // The offset may have moved while this request waited for its body.
            $now = (int) $this->db->scalar('SELECT upload_offset FROM app_uploads WHERE upload_id = ?', [$uploadId]);
            if ($now !== $offset) {
                throw self::offsetMismatch($now);
            }
            // Leftovers of a request that died after writing but before recording its chunk.
            ftruncate($file, max(0, $offset));
            fseek($file, $offset);
            $ctx = hash_init('sha256');
            $received = 0;
            while (!$body->eof() && $received <= $length) {
                $data = $body->read(min(self::READ_BYTES, $length + 1 - $received));
                if ($data === '') {
                    break;
                }
                $received += strlen($data);
                if ($received > $length) {
                    break;
                }
                hash_update($ctx, $data);
                if (fwrite($file, $data) !== strlen($data)) {
                    ftruncate($file, max(0, $offset));
                    throw new RuntimeException('Short write to ' . $path . ' (disk full?)');
                }
            }
            if ($received !== $length) {
                ftruncate($file, max(0, $offset));
                throw new ApiException(400, 'incomplete_chunk', sprintf('The body had %s bytes, Content-Length said %d.', $received > $length ? 'more' : (string) $received, $length));
            }
            if (!hash_equals($checksumHex, hash_final($ctx))) {
                ftruncate($file, max(0, $offset));
                throw (new ApiException(460, 'checksum_mismatch', 'The chunk does not match Upload-Checksum. Send it again.'))
                    ->withHeaders(['Upload-Offset' => (string) $offset, 'Tus-Resumable' => '1.0.0']);
            }
            fflush($file);
            if (function_exists('fsync')) {
                @fsync($file);
            }
            $new = $offset + $length;
            $updated = $this->db->write(fn (): int => $this->db->exec(
                "UPDATE app_uploads SET upload_offset = ?, updated_at = ? WHERE upload_id = ? AND upload_offset = ? AND state = 'open'",
                [$new, Clock::nowIso(), $uploadId, $offset],
            ));
            if ($updated !== 1) {
                ftruncate($file, max(0, $offset));
                throw self::offsetMismatch((int) $this->db->scalar('SELECT upload_offset FROM app_uploads WHERE upload_id = ?', [$uploadId]));
            }

            return $new;
        } finally {
            if (is_resource($file)) {
                flock($file, LOCK_UN);
                fclose($file);
            }
            TransferSlots::release($transfer);
        }
    }

    /**
     * POST /app/entries/{entryId}/commit (AppCommitRequest).
     *
     * @param list<string> $roles
     * @return array<string, mixed> AppEntryState
     */
    public function commit(int $phoneId, string $entryId, array $roles): array
    {
        $row = $this->ownEntry($phoneId, $entryId);
        if (in_array($row['state'], ['withdrawn', 'rejected'], true)) {
            throw self::gone($row['state']);
        }
        $slots = [];
        foreach ($this->db->all('SELECT * FROM app_uploads WHERE entry_id = ?', [$entryId]) as $slot) {
            $slots[(string) $slot['role']] = $slot;
        }
        $incomplete = [];
        $toVerify = [];
        foreach (array_values(array_unique($roles)) as $role) {
            $slot = $slots[$role] ?? null;
            if ($slot === null) {
                throw ApiException::validation(sprintf('This entry declared no "%s" file.', $role), ['errors' => ["/roles: no $role file"]]);
            }
            if ($slot['state'] === 'abandoned' || $slot['state'] === 'deleted') {
                throw self::gone('abandoned');
            }
            if ($slot['state'] !== 'open') {
                continue; // committed or archived already
            }
            if ((int) $slot['upload_offset'] !== (int) $slot['bytes']) {
                $incomplete[] = $role;
            } else {
                $toVerify[] = $slot;
            }
        }
        if ($incomplete !== []) {
            throw new ApiException(409, 'incomplete', 'Not every byte has arrived yet.', ['roles' => $incomplete]);
        }
        $mismatch = [];
        foreach ($toVerify as $slot) {
            $path = $this->partPath($entryId, (string) $slot['upload_id']);
            @set_time_limit(300);
            $sha = is_file($path) && filesize($path) === (int) $slot['bytes'] ? hash_file('sha256', $path) : null;
            $now = Clock::nowIso();
            if ($sha === (string) $slot['sha256']) {
                $this->db->write(fn (): int => $this->db->exec(
                    "UPDATE app_uploads SET state = 'committed', committed_at = ?, updated_at = ? WHERE upload_id = ? AND state = 'open'",
                    [$now, $now, (string) $slot['upload_id']],
                ));
            } else {
                // Start this file again from 0 (the phone resends it).
                @file_put_contents($path, '');
                $this->db->write(fn (): int => $this->db->exec(
                    "UPDATE app_uploads SET upload_offset = 0, updated_at = ? WHERE upload_id = ? AND state = 'open'",
                    [$now, (string) $slot['upload_id']],
                ));
                $mismatch[] = (string) $slot['role'];
                $this->logger->warning('app upload {uploadId} ({role}) failed its sha256 check; reset to 0', ['uploadId' => (string) $slot['upload_id'], 'role' => (string) $slot['role']]);
            }
        }
        $this->promoteIfUploaded($entryId);
        if ($mismatch !== []) {
            throw new ApiException(422, 'sha256_mismatch', 'The file does not match its sha256; it was reset to 0. Upload it again.', ['roles' => $mismatch]);
        }

        return $this->stateOf($entryId);
    }

    /** DELETE /app/uploads/{uploadId}: she gives up an original (tus termination). */
    public function abandon(int $phoneId, string $uploadId): void
    {
        $slot = $this->ownSlot($phoneId, $uploadId, true);
        if ($slot['role'] !== 'original') {
            throw ApiException::conflict('Only an original can be left out; withdraw the entry instead.');
        }
        if (!in_array($slot['state'], self::LIVE_SLOTS, true)) {
            return;
        }
        $now = Clock::nowIso();
        $this->db->write(fn (): int => $this->db->exec(
            "UPDATE app_uploads SET state = 'abandoned', updated_at = ? WHERE upload_id = ? AND state IN ('open', 'committed')",
            [$now, $uploadId],
        ));
        $this->unlink([$this->partPath((string) $slot['entry_id'], $uploadId)]);
    }

    /**
     * GET /app/hints (contract AppHints).
     *
     * @return array<string, mixed>
     */
    public function hints(): array
    {
        $policy = $this->settings->policy();
        $delayHours = $policy['publish.mode'] === 'delayed' ? round(((int) $policy['publish.delay_minutes']) / 60, 2) : 0;

        return [
            'archiveOnly' => $this->archiveOnly(),
            'delayHours' => $delayHours,
            'backendLastSeenAt' => $this->backendLastSeenAt(),
            'chunk' => $this->chunk(),
            'inboxFreeBytes' => max(0, $this->config->maxBytes - $this->usage()),
            'fileMaxBytes' => $this->config->fileMaxBytes('original'),
            'serverNow' => Clock::nowIso(),
        ];
    }

    // =========================================================================================
    // Backend side

    /**
     * GET /backend/app/entries (contract AppInboxResponse): what the backend has to do, oldest
     * first. $archiveOnly is the backend's switch as it reports it (null = not reported).
     *
     * @return array{items: list<array<string, mixed>>, hasMore: bool, serverNow: string}
     */
    public function pending(int $limit, ?bool $archiveOnly): array
    {
        $now = Clock::nowIso();
        $this->db->write(function () use ($archiveOnly, $now): void {
            $this->putState(self::STATE_BACKEND_SEEN, $now, $now);
            if ($archiveOnly !== null) {
                $this->putState(self::STATE_ARCHIVE_ONLY, $archiveOnly, $now);
            }
        });
        $this->housekeeping();
        $rows = $this->db->all(
            "SELECT e.*, p.name AS phone_name FROM app_entries e JOIN app_phones p ON p.id = e.phone_id
             WHERE e.state IN ('uploaded', 'fetching') OR e.withdraw_relay = 1
                OR (e.state = 'archived' AND EXISTS (SELECT 1 FROM app_uploads u WHERE u.entry_id = e.entry_id AND u.role = 'original' AND u.state = 'committed'))
             ORDER BY e.received_at, e.entry_id LIMIT ?",
            [$limit + 1],
        );
        $items = [];
        foreach (array_slice($rows, 0, $limit) as $row) {
            $items[] = $this->inboxItem($row);
        }

        return ['items' => $items, 'hasMore' => count($rows) > $limit, 'serverNow' => $now];
    }

    /**
     * GET /backend/app/uploads/{uploadId}/content: opens a committed file for a (Range) download
     * and takes a transfer slot, which the returned stream releases when it is closed.
     *
     * @return array{stream: FileRangeStream, start: int, length: int, total: int, sha256: string, mimetype: string, partial: bool}
     */
    public function openContent(string $uploadId, string $range): array
    {
        $slot = $this->db->one('SELECT u.*, e.state AS entry_state FROM app_uploads u JOIN app_entries e ON e.entry_id = u.entry_id WHERE u.upload_id = ?', [$uploadId]);
        if ($slot === null) {
            throw ApiException::notFound('No such upload.');
        }
        if ($slot['state'] !== 'committed') {
            throw $slot['state'] === 'open'
                ? ApiException::conflict('This file is not complete yet.')
                : self::gone((string) $slot['state']);
        }
        $total = (int) $slot['bytes'];
        $start = 0;
        $end = $total - 1;
        $partial = false;
        if ($range !== '') {
            if (preg_match('/^bytes=(\d{1,15})-(\d{0,15})$/D', trim($range), $m) !== 1 || (int) $m[1] >= $total
                || ($m[2] !== '' && (int) $m[2] < (int) $m[1])) {
                throw (new ApiException(416, 'range_not_satisfiable', 'Range must be "bytes=N-" or "bytes=N-M" within the file.'))
                    ->withHeaders(['Content-Range' => 'bytes */' . $total]);
            }
            $start = (int) $m[1];
            $end = $m[2] === '' ? $total - 1 : min($total - 1, (int) $m[2]);
            $partial = true;
        }
        $path = $this->partPath((string) $slot['entry_id'], $uploadId);
        $transfer = $this->slots->acquire();
        $handle = @fopen($path, 'rb');
        if ($handle === false) {
            TransferSlots::release($transfer);
            throw new ApiException(500, 'internal', 'The committed file is missing.');
        }
        if ($slot['entry_state'] === 'uploaded' && $slot['role'] !== 'original') {
            $now = Clock::nowIso();
            $this->db->write(fn (): int => $this->db->exec(
                "UPDATE app_entries SET state = 'fetching', fetching_at = ?, updated_at = ? WHERE entry_id = ? AND state = 'uploaded'",
                [$now, $now, (string) $slot['entry_id']],
            ));
        }

        return [
            'stream' => new FileRangeStream($handle, $start, $end - $start + 1, $transfer),
            'start' => $start,
            'length' => $end - $start + 1,
            'total' => $total,
            'sha256' => (string) $slot['sha256'],
            'mimetype' => (string) $slot['mimetype'],
            'partial' => $partial,
        ];
    }

    /** POST /backend/app/entries/{entryId}/ack (AppInboxAck): the home archive has these roles. */
    public function ack(string $entryId, stdClass $body): void
    {
        $row = $this->entryRow($entryId);
        /** @var list<string> $roles */
        $roles = array_values(array_unique(array_map('strval', is_array($body->roles ?? null) ? $body->roles : [])));
        $withdrawal = ($body->withdrawal ?? false) === true;
        $now = Clock::nowIso();
        if ($row['state'] === 'rejected') {
            throw self::gone('rejected');
        }
        if ($row['state'] === 'withdrawn') {
            if ($roles !== [] && !$withdrawal) {
                // It was withdrawn while the backend fetched: make sure the withdrawal reaches it.
                $this->db->write(fn (): int => $this->db->exec('UPDATE app_entries SET withdraw_relay = 1, updated_at = ? WHERE entry_id = ?', [$now, $entryId]));
                throw self::gone('withdrawn');
            }
            if ($withdrawal) {
                $this->db->write(fn (): int => $this->db->exec('UPDATE app_entries SET withdraw_relay = 0, updated_at = ? WHERE entry_id = ?', [$now, $entryId]));
            }

            return;
        }
        $paths = $this->db->write(function () use ($entryId, $row, $roles, $withdrawal, $now): array {
            $slots = [];
            foreach ($this->db->all('SELECT * FROM app_uploads WHERE entry_id = ?', [$entryId]) as $slot) {
                $slots[(string) $slot['role']] = $slot;
            }
            $paths = [];
            foreach ($roles as $role) {
                $slot = $slots[$role] ?? null;
                if ($slot === null) {
                    throw ApiException::validation(sprintf('This entry has no "%s" file.', $role));
                }
                if ($slot['state'] === 'open') {
                    throw ApiException::conflict(sprintf('The %s file was never committed; it cannot be archived.', $role));
                }
                if ($slot['state'] === 'committed') {
                    $this->db->exec(
                        "UPDATE app_uploads SET state = 'archived', archived_at = ?, updated_at = ? WHERE upload_id = ?",
                        [$now, $now, (string) $slot['upload_id']],
                    );
                    $paths[] = $this->partPath($entryId, (string) $slot['upload_id']);
                }
            }
            $mediaDone = !isset($slots['media']) || in_array('media', $roles, true) || $slots['media']['state'] === 'archived';
            if (in_array($row['state'], ['uploaded', 'fetching'], true) && $mediaDone) {
                $this->db->exec(
                    "UPDATE app_entries SET state = 'archived', archived_at = ?, updated_at = ? WHERE entry_id = ?",
                    [$now, $now, $entryId],
                );
            }
            if ($withdrawal) {
                $this->db->exec('UPDATE app_entries SET withdraw_relay = 0, updated_at = ? WHERE entry_id = ?', [$now, $entryId]);
            }

            return $paths;
        });
        $this->unlink($paths);
        if ($paths !== []) {
            $this->logger->info('app entry {entryId}: home archive acked {roles}', ['entryId' => $entryId, 'roles' => implode(', ', $roles)]);
        }
    }

    /** POST /backend/app/entries/{entryId}/reject (AppInboxReject). */
    public function reject(string $entryId, string $reason): void
    {
        $row = $this->entryRow($entryId);
        if (in_array($row['state'], ['rejected', 'withdrawn'], true)) {
            return;
        }
        if ($row['state'] === 'archived') {
            throw ApiException::conflict('The entry is archived already; it can only be withdrawn.');
        }
        $now = Clock::nowIso();
        $paths = $this->db->write(function () use ($entryId, $reason, $now): array {
            $this->db->exec(
                "UPDATE app_entries SET state = 'rejected', rejected_at = ?, reject_reason = ?, updated_at = ? WHERE entry_id = ?",
                [$now, mb_substr($reason, 0, 200), $now, $entryId],
            );

            return $this->dropSlots($entryId, null, 'deleted', $now);
        });
        $this->unlink($paths);
        $this->logger->warning('app entry {entryId} rejected by the backend: {reason}', ['entryId' => $entryId, 'reason' => $reason]);
    }

    // =========================================================================================
    // Admin side

    /**
     * GET /admin/app-entries/{sourceKey} (contract AppEntryAdminInfo).
     *
     * @return array<string, mixed>
     */
    public function adminInfo(string $sourceKey): array
    {
        $row = $this->db->one(
            "SELECT e.*, p.id AS p_id, p.name AS p_name, p.revoked_at AS p_revoked,
                    (SELECT u.state FROM app_uploads u WHERE u.entry_id = e.entry_id AND u.role = 'original') AS original_state
             FROM app_entries e JOIN app_phones p ON p.id = e.phone_id WHERE e.source_key = ?",
            [$sourceKey],
        );
        if ($row === null) {
            throw ApiException::notFound('No app entry with this key.');
        }

        return [
            'sourceKey' => $sourceKey,
            'state' => (string) $row['state'],
            'phone' => ['id' => (int) $row['p_id'], 'name' => (string) $row['p_name'], 'revoked' => $row['p_revoked'] !== null],
            'receivedAt' => (string) $row['received_at'],
            'clamped' => (int) $row['clamped'] === 1,
            'heldBack' => (int) $row['held_back'] === 1,
            'appVisibility' => $row['app_visibility'] === null ? null : (string) $row['app_visibility'],
            'originalArchived' => $row['original_state'] === 'archived',
            'rejectReason' => $row['reject_reason'] === null ? null : (string) $row['reject_reason'],
        ];
    }

    /** Bytes the inbox holds or has reserved (media and previews in full, originals as they arrive). */
    public function usage(): int
    {
        return (int) $this->db->scalar(
            "SELECT COALESCE(SUM(CASE WHEN role = 'original' THEN upload_offset ELSE bytes END), 0) FROM app_uploads WHERE state IN ('open', 'committed')",
        );
    }

    public function maxBytes(): int
    {
        return $this->config->maxBytes;
    }

    /** Q8 a: true until the backend reported that it publishes app entries. */
    public function archiveOnly(): bool
    {
        return $this->getState(self::STATE_ARCHIVE_ONLY) !== false;
    }

    // =========================================================================================
    // Housekeeping

    /**
     * At most every {@see HOUSEKEEPING_EVERY_SECONDS} (or when forced):
     * - entries still receiving whose uploads saw no request for {@see AppInboxConfig::STALE_SLOT_HOURS}
     *   hours are given up (review R6): removed with their slots and bytes, so the disk budget they
     *   reserved is free again even when their phone never comes back (reset, lost, connected
     *   anew). A phone that does come back gets 404 and sends the same create again (a replay,
     *   accepted as new), then uploads from 0;
     * - other partial uploads (originals) untouched that long start again from 0 (the phone's HEAD
     *   sees it; their bytes are freed);
     * - directories of finished entries are removed, rate windows pruned.
     *
     * @return array{abandonedEntries: int, staleSlots: int, dirsRemoved: int, ratePruned: int}|null null when not due
     */
    public function housekeeping(bool $force = false): ?array
    {
        $now = Clock::now();
        $last = $this->getState(self::STATE_HOUSEKEEPING);
        if (!$force && is_string($last) && $last > Clock::iso($now->modify('-' . self::HOUSEKEEPING_EVERY_SECONDS . ' seconds'))) {
            return null;
        }
        $nowIso = Clock::iso($now);
        $this->db->write(fn () => $this->putState(self::STATE_HOUSEKEEPING, $nowIso, $nowIso));
        $staleBefore = Clock::iso($now->modify('-' . AppInboxConfig::STALE_SLOT_HOURS . ' hours'));
        $abandoned = $this->abandonStaleEntries($staleBefore);
        $stale = $this->db->all(
            "SELECT upload_id, entry_id FROM app_uploads WHERE state = 'open' AND upload_offset > 0 AND updated_at < ?",
            [$staleBefore],
        );
        foreach ($stale as $slot) {
            $path = $this->partPath((string) $slot['entry_id'], (string) $slot['upload_id']);
            $handle = @fopen($path, 'c+b');
            if ($handle === false || !flock($handle, LOCK_EX | LOCK_NB)) {
                if (is_resource($handle)) {
                    fclose($handle);
                }
                continue; // being written right now
            }
            ftruncate($handle, 0);
            flock($handle, LOCK_UN);
            fclose($handle);
            $this->db->write(fn (): int => $this->db->exec(
                "UPDATE app_uploads SET upload_offset = 0, updated_at = ? WHERE upload_id = ? AND state = 'open'",
                [$nowIso, (string) $slot['upload_id']],
            ));
        }

        $dirs = 0;
        $root = $this->paths->var(self::DIR);
        foreach (is_dir($root) ? (scandir($root) ?: []) : [] as $name) {
            if (!AppRules::isEntryId($name)) {
                continue;
            }
            $live = $this->db->scalar("SELECT COUNT(*) FROM app_uploads WHERE entry_id = ? AND state IN ('open', 'committed')", [$name]);
            if ((int) $live === 0) {
                foreach (glob($root . '/' . $name . '/*') ?: [] as $file) {
                    Fs::remove($file);
                }
                if (@rmdir($root . '/' . $name)) {
                    ++$dirs;
                }
            }
        }

        $pruned = (new AppRateLimiter($this->db))->prune();
        if ($abandoned > 0 || $stale !== [] || $dirs > 0) {
            $this->logger->info('app inbox housekeeping: {abandoned} unfinished entries given up, {stale} stale partial uploads reset, {dirs} directories removed', [
                'abandoned' => $abandoned, 'stale' => count($stale), 'dirs' => $dirs,
            ]);
        }

        return ['abandonedEntries' => $abandoned, 'staleSlots' => count($stale), 'dirsRemoved' => $dirs, 'ratePruned' => $pruned];
    }

    /**
     * Removes entries in "receiving" that were received before $staleBefore and whose slots saw no
     * request since (see {@see housekeeping()}). An entry with a file being written right now is
     * left alone. Returns how many were removed.
     */
    private function abandonStaleEntries(string $staleBefore): int
    {
        $candidates = $this->db->all(
            "SELECT e.entry_id FROM app_entries e
             WHERE e.state = 'receiving' AND e.received_at < ?
               AND NOT EXISTS (SELECT 1 FROM app_uploads u WHERE u.entry_id = e.entry_id AND u.updated_at >= ?)",
            [$staleBefore, $staleBefore],
        );
        $removed = 0;
        foreach ($candidates as $candidate) {
            $entryId = (string) $candidate['entry_id'];
            $locks = [];
            try {
                foreach ($this->db->all("SELECT upload_id FROM app_uploads WHERE entry_id = ? AND state = 'open'", [$entryId]) as $slot) {
                    $path = $this->partPath($entryId, (string) $slot['upload_id']);
                    if (!is_file($path)) {
                        continue;
                    }
                    $handle = @fopen($path, 'c+b');
                    if ($handle === false) {
                        continue 2;
                    }
                    if (!flock($handle, LOCK_EX | LOCK_NB)) {
                        fclose($handle);
                        continue 2; // being written right now
                    }
                    $locks[] = $handle;
                }
                $paths = $this->db->write(function () use ($entryId, $staleBefore): ?array {
                    // Checked again inside the transaction: a request may have come in meanwhile.
                    $still = $this->db->scalar(
                        "SELECT 1 FROM app_entries e WHERE e.entry_id = ? AND e.state = 'receiving'
                           AND NOT EXISTS (SELECT 1 FROM app_uploads u WHERE u.entry_id = e.entry_id AND u.updated_at >= ?)",
                        [$entryId, $staleBefore],
                    );
                    if ($still === null) {
                        return null;
                    }
                    $paths = array_map(
                        fn (array $r): string => $this->partPath($entryId, (string) $r['upload_id']),
                        $this->db->all('SELECT upload_id FROM app_uploads WHERE entry_id = ?', [$entryId]),
                    );
                    $this->db->exec('DELETE FROM app_uploads WHERE entry_id = ?', [$entryId]);
                    $this->db->exec('DELETE FROM app_entries WHERE entry_id = ?', [$entryId]);

                    return $paths;
                });
            } finally {
                foreach ($locks as $handle) {
                    flock($handle, LOCK_UN);
                    fclose($handle);
                }
            }
            if ($paths === null) {
                continue;
            }
            $this->unlink($paths);
            ++$removed;
            $this->logger->info('app entry {entryId} given up: no upload for {hours} h, its reservation is free again', [
                'entryId' => $entryId, 'hours' => AppInboxConfig::STALE_SLOT_HOURS,
            ]);
        }

        return $removed;
    }

    // =========================================================================================
    // Internals

    /**
     * Contract AppEntryState of one entry.
     *
     * @return array<string, mixed>
     */
    private function stateOf(string $entryId): array
    {
        $row = $this->entryRow($entryId);
        $uploads = [];
        foreach ($this->db->all("SELECT * FROM app_uploads WHERE entry_id = ? AND state <> 'abandoned' ORDER BY role", [$entryId]) as $slot) {
            $state = (string) $slot['state'];
            $uploads[] = [
                'uploadId' => (string) $slot['upload_id'],
                'role' => (string) $slot['role'],
                'bytes' => (int) $slot['bytes'],
                'offset' => in_array($state, ['committed', 'archived'], true) ? (int) $slot['bytes'] : (int) $slot['upload_offset'],
                'committed' => in_array($state, ['committed', 'archived'], true),
                'archived' => $state === 'archived',
            ];
        }

        return [
            'entryId' => $entryId,
            'sourceKey' => (string) $row['source_key'],
            'state' => (string) $row['state'],
            'occurredAt' => (string) $row['occurred_at'],
            'receivedAt' => (string) $row['received_at'],
            'heldBack' => (int) $row['held_back'] === 1,
            'uploads' => $uploads,
            'chunk' => $this->chunk(),
            'backendLastSeenAt' => $this->backendLastSeenAt(),
            'rejectReason' => $row['reject_reason'] === null ? null : (string) $row['reject_reason'],
            'publish' => $this->publishFacts((string) $row['source_key'], (string) $row['state']),
        ];
    }

    /**
     * Publication facts once the backend mirrored the capture; null before and in archive-only
     * mode (contract AppEntryState.publish, ./api itemPublishState()).
     *
     * @return array{visibility: string, state: string, publishAt: string|null}|null
     */
    private function publishFacts(string $sourceKey, string $state): ?array
    {
        if ($state !== 'archived' || $this->archiveOnly()) {
            return null;
        }
        $capture = $this->db->one(
            'SELECT c.occurred_at, c.revoked_at, c.media_state, a.visibility FROM captures c LEFT JOIN annotations a ON a.source_key = c.source_key WHERE c.source_key = ?',
            [$sourceKey],
        );
        if ($capture === null) {
            return null;
        }
        $policy = $this->settings->policy();
        $occurredAt = (string) $capture['occurred_at'];
        $revokedAt = $capture['revoked_at'] === null ? null : (string) $capture['revoked_at'];
        $override = $capture['visibility'] === null ? null : (string) $capture['visibility'];
        $visibility = Policy::effectiveCaptureVisibility($occurredAt, $revokedAt, $override, $policy, Clock::nowIso());
        $publishAt = Policy::capturePublishAt($occurredAt, $revokedAt, $override, $policy);
        $mediaState = (string) $capture['media_state'];
        if ($visibility !== 'public' || $mediaState === 'lost') {
            $publishState = 'not_public';
        } else {
            $reports = $this->backendStatus->publishStatus();
            $changeSeq = $this->changes->latestSeq('annotation', $sourceKey);
            $covered = static function (array $r) use ($changeSeq, $occurredAt, $publishAt): bool {
                $through = is_string($r['capturesThrough'] ?? null) ? $r['capturesThrough'] : null;
                $at = is_string($r['at'] ?? null) ? $r['at'] : null;

                return ($r['ok'] ?? false) === true
                    && $changeSeq <= (int) ($r['feedSeq'] ?? -1)
                    && $through !== null && Time::millis($occurredAt) <= Time::millis($through)
                    && ($publishAt === null || ($at !== null && Time::millis($publishAt) <= Time::millis($at)));
            };
            $publishState = $reports === [] || $mediaState === 'pending' ? 'publishing'
                : (count(array_filter($reports, $covered)) === count($reports) ? 'live' : 'publishing');
        }

        return ['visibility' => $visibility, 'state' => $publishState, 'publishAt' => $publishAt];
    }

    /**
     * @param array<string, mixed> $row app_entries row + phone_name
     * @return array<string, mixed> contract AppInboxItem
     */
    private function inboxItem(array $row): array
    {
        $files = [];
        foreach ($this->db->all('SELECT * FROM app_uploads WHERE entry_id = ? ORDER BY role', [(string) $row['entry_id']]) as $slot) {
            $files[] = [
                'uploadId' => (string) $slot['upload_id'],
                'role' => (string) $slot['role'],
                'mimetype' => (string) $slot['mimetype'],
                'bytes' => (int) $slot['bytes'],
                'sha256Hex' => (string) $slot['sha256'],
                'state' => (string) $slot['state'],
            ];
        }

        return [
            'entryId' => (string) $row['entry_id'],
            'sourceKey' => (string) $row['source_key'],
            'state' => (string) $row['state'],
            'occurredAt' => (string) $row['occurred_at'],
            'receivedAt' => (string) $row['received_at'],
            'clamped' => (int) $row['clamped'] === 1,
            'heldBack' => (int) $row['held_back'] === 1,
            'phone' => ['id' => (int) $row['phone_id'], 'name' => (string) $row['phone_name']],
            'entry' => Captures::decode((string) $row['entry_json']),
            'files' => $files,
            'withdrawnAt' => (int) $row['withdraw_relay'] === 1 && $row['withdrawn_at'] !== null ? (string) $row['withdrawn_at'] : null,
        ];
    }

    /** @return array{minBytes: int, maxBytes: int} */
    private function chunk(): array
    {
        return ['minBytes' => $this->config->chunkMinBytes(), 'maxBytes' => $this->config->chunkMaxBytes()];
    }

    private function backendLastSeenAt(): ?string
    {
        $heartbeat = $this->backendStatus->lastHeartbeat()['receivedAt'] ?? null;
        $seen = $this->getState(self::STATE_BACKEND_SEEN);
        $seen = is_string($seen) ? $seen : null;
        if ($heartbeat === null) {
            return $seen;
        }

        return $seen === null || $heartbeat > $seen ? $heartbeat : $seen;
    }

    /** media (+ preview) committed -> uploaded */
    private function promoteIfUploaded(string $entryId): void
    {
        $now = Clock::nowIso();
        $this->db->write(fn (): int => $this->db->exec(
            "UPDATE app_entries SET state = 'uploaded', uploaded_at = ?, updated_at = ?
             WHERE entry_id = ? AND state = 'receiving'
               AND NOT EXISTS (SELECT 1 FROM app_uploads u WHERE u.entry_id = app_entries.entry_id AND u.role <> 'original' AND u.state = 'open')",
            [$now, $now, $entryId],
        ));
    }

    /**
     * The annotation of an app entry, written as the app (contract Annotation via the change
     * feed, like Captures::annotate()). $onlyIfNew: at create, never overwrite owner data.
     */
    private function writeAnnotation(string $sourceKey, ?string $visibility, ?string $localDate, bool $onlyIfNew): void
    {
        $row = $this->db->one('SELECT * FROM annotations WHERE source_key = ?', [$sourceKey]);
        if ($row !== null && $onlyIfNew) {
            return;
        }
        $next = [
            'description' => $row['description'] ?? null,
            'orig_locale' => $row['orig_locale'] ?? null,
            'visibility' => $visibility ?? ($row['visibility'] ?? null),
            'local_date_override' => $localDate ?? ($row['local_date_override'] ?? null),
        ];
        $now = Clock::nowIsoAfter($row === null ? null : (string) $row['updated_at']);
        $this->db->exec(
            'INSERT INTO annotations (source_key, description, orig_locale, visibility, local_date_override, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (source_key) DO UPDATE SET visibility = excluded.visibility, local_date_override = excluded.local_date_override,
                updated_at = excluded.updated_at',
            [$sourceKey, $next['description'], $next['orig_locale'], $next['visibility'], $next['local_date_override'], $now, $now],
        );
        $this->changes->append('annotation', $sourceKey, 'upsert', Captures::annotationDto([
            'a_key' => $sourceKey,
            'a_description' => $next['description'],
            'a_orig_locale' => $next['orig_locale'],
            'a_visibility' => $next['visibility'],
            'a_override' => $next['local_date_override'],
            'a_updated_at' => $now,
        ]));
    }

    /**
     * Marks the live slots of an entry (or only $role) as $state; returns their file paths.
     * Call inside Db::write(); unlink the paths after the commit.
     *
     * @return list<string>
     */
    private function dropSlots(string $entryId, ?string $role, string $state, string $now): array
    {
        $paths = [];
        $sql = "SELECT upload_id FROM app_uploads WHERE entry_id = ? AND state IN ('open', 'committed')" . ($role === null ? '' : ' AND role = ?');
        foreach ($this->db->all($sql, $role === null ? [$entryId] : [$entryId, $role]) as $slot) {
            $paths[] = $this->partPath($entryId, (string) $slot['upload_id']);
            $this->db->exec('UPDATE app_uploads SET state = ?, updated_at = ? WHERE upload_id = ?', [$state, $now, (string) $slot['upload_id']]);
        }

        return $paths;
    }

    /** @param list<string> $paths */
    private function unlink(array $paths): void
    {
        foreach ($paths as $path) {
            Fs::remove($path);
        }
    }

    /** @return array<string, mixed> */
    private function entryRow(string $entryId): array
    {
        $row = $this->db->one('SELECT * FROM app_entries WHERE entry_id = ?', [$entryId]);
        if ($row === null) {
            throw ApiException::notFound('No such entry.');
        }

        return $row;
    }

    /** @return array<string, mixed> */
    private function ownEntry(int $phoneId, string $entryId): array
    {
        $row = $this->entryRow($entryId);
        if ((int) $row['phone_id'] !== $phoneId) {
            throw ApiException::forbidden('This entry belongs to another phone.');
        }

        return $row;
    }

    /** @return array<string, mixed> */
    private function ownSlot(int $phoneId, string $uploadId, bool $allowFinished = false): array
    {
        $slot = $this->db->one(
            'SELECT u.*, e.phone_id, e.state AS entry_state FROM app_uploads u JOIN app_entries e ON e.entry_id = u.entry_id WHERE u.upload_id = ?',
            [$uploadId],
        );
        if ($slot === null) {
            throw ApiException::notFound('No such upload.');
        }
        if ((int) $slot['phone_id'] !== $phoneId) {
            throw ApiException::forbidden('This upload belongs to another phone.');
        }
        if (in_array($slot['entry_state'], ['withdrawn', 'rejected'], true)) {
            throw self::gone((string) $slot['entry_state']);
        }
        if (!$allowFinished && in_array($slot['state'], ['abandoned', 'deleted'], true)) {
            throw self::gone((string) $slot['state']);
        }

        return $slot;
    }

    private function partPath(string $entryId, string $uploadId): string
    {
        if (!AppRules::isEntryId($entryId) || preg_match('/^u_[A-Za-z0-9_-]{16,64}$/D', $uploadId) !== 1) {
            throw new RuntimeException('Invalid inbox path components.');
        }

        return $this->paths->var(self::DIR . '/' . $entryId . '/' . $uploadId . '.part');
    }

    private function getState(string $key): mixed
    {
        $value = $this->db->scalar('SELECT value FROM app_state WHERE key = ?', [$key]);

        return is_string($value) ? json_decode($value, true) : null;
    }

    private function putState(string $key, mixed $value, string $now): void
    {
        $this->db->exec(
            'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
            [$key, json_encode($value, JSON_THROW_ON_ERROR), $now],
        );
    }

    private static function newUploadId(): string
    {
        return 'u_' . rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '=');
    }

    private static function encode(stdClass $entry): string
    {
        return json_encode($entry, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    }

    private static function offsetMismatch(int $offset): ApiException
    {
        return (new ApiException(409, 'offset_mismatch', 'Upload-Offset does not match; continue from the returned offset.', ['offset' => $offset]))
            ->withHeaders(['Upload-Offset' => (string) $offset, 'Tus-Resumable' => '1.0.0']);
    }

    private static function gone(string $why): ApiException
    {
        return new ApiException(410, 'gone', sprintf('The upload is gone (%s).', $why), ['reason' => $why]);
    }

    private static function inboxFull(): ApiException
    {
        return (new ApiException(507, 'inbox_full', 'The inbox is full until the home computer fetched what is waiting. Try again later.'))
            ->withHeaders(['Retry-After' => (string) self::RETRY_FULL_SECONDS]);
    }
}
