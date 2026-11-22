<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Config;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use RuntimeException;

/**
 * A person's devices (spec-wave5 §3.3 Devices, Q3 c): the first device (the person has none that
 * is active or revoked) joins without approval; every later one is pending until the owner allows
 * it. At most {@see MAX_PENDING} pending devices per person and ACCESS_MAX_DEVICES active ones.
 * The device key k is only stored as its sha256; the label is derived from the User-Agent
 * ({@see UserAgentLabel}), the raw UA is never stored.
 */
final class Devices
{
    public const MAX_PENDING = 3;
    public const PENDING_EXPIRY_DAYS = 14;

    public function __construct(
        private readonly Db $db,
        private readonly StoreOps $ops,
        private readonly Config $config,
    ) {
    }

    /**
     * The device a presented key belongs to, with its follower's state (f_state, f_kind, f_name,
     * f_revoked_at); null for an unknown key.
     *
     * @return array<string, mixed>|null
     */
    public function byKey(string $k): ?array
    {
        return $this->db->one(
            'SELECT d.*, f.state AS f_state, f.kind AS f_kind, f.name AS f_name, f.revoked_at AS f_revoked_at
             FROM devices d JOIN followers f ON f.id = d.follower_id WHERE d.key_hash = ?',
            [Tokens::hash($k)],
        );
    }

    /** @return array<string, mixed>|null */
    public function byId(string $did): ?array
    {
        if (!Tokens::isDeviceId($did)) {
            return null;
        }

        return $this->db->one(
            'SELECT d.*, f.state AS f_state, f.kind AS f_kind, f.name AS f_name, f.revoked_at AS f_revoked_at
             FROM devices d JOIN followers f ON f.id = d.follower_id WHERE d.id = ?',
            [$did],
        );
    }

    /** True when the person already has (or had) an approved device: a new one must wait (Q3 c). */
    public function mustWait(string $fid): bool
    {
        return $this->db->scalar("SELECT 1 FROM devices WHERE follower_id = ? AND state IN ('active', 'revoked') LIMIT 1", [$fid]) !== null;
    }

    public function pendingCount(string $fid): int
    {
        return (int) $this->db->scalar("SELECT COUNT(*) FROM devices WHERE follower_id = ? AND state = 'pending'", [$fid]);
    }

    public function activeCount(string $fid): int
    {
        return (int) $this->db->scalar("SELECT COUNT(*) FROM devices WHERE follower_id = ? AND state = 'active'", [$fid]);
    }

    /**
     * Creates a device (inside the caller's transaction): active for a first device, else pending.
     *
     * @return array{did: string, key: string}
     */
    public function create(string $fid, string $label, bool $first): array
    {
        return $this->db->write(function () use ($fid, $label, $first): array {
            $did = self::unusedId($this->db);
            $k = Tokens::token();
            $now = Clock::nowIso();
            $this->db->exec(
                'INSERT INTO devices (id, follower_id, state, first, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [$did, $fid, $first ? 'active' : 'pending', $first ? 1 : 0, Tokens::hash($k), mb_substr($label, 0, 60), $now],
            );

            return ['did' => $did, 'key' => $k];
        });
    }

    public static function unusedId(Db $db): string
    {
        for ($i = 0; $i < 10; ++$i) {
            $did = Tokens::deviceId();
            if ($db->scalar('SELECT 1 FROM devices WHERE id = ?', [$did]) === null) {
                return $did;
            }
        }
        throw new RuntimeException('Could not find an unused device id.');
    }

    /**
     * Owner: pending → active (the session is issued on the device's next poll).
     *
     * @throws ApiException 404, 409 device_limit, 409 conflict (not pending, person not active, restoring)
     */
    public function approve(string $did): void
    {
        $this->db->write(function () use ($did): void {
            $d = $this->person($did);
            if ($d['state'] === 'active') {
                return; // idempotent
            }
            if ($d['state'] !== 'pending' || $d['f_state'] !== 'active') {
                throw ApiException::conflict('Only a waiting device of an active person can be allowed.');
            }
            $restoring = $this->db->scalar('SELECT 1 FROM access_state WHERE id = 1 AND reconciled_epoch IS NOT epoch') !== null;
            if ($restoring) {
                throw ApiException::conflict('Restore: checking access… Try again in a few minutes.');
            }
            if ($this->activeCount((string) $d['follower_id']) >= $this->config->access->maxDevices) {
                throw new ApiException(409, 'device_limit', sprintf('This person already has %d active devices. Remove another device first.', $this->config->access->maxDevices));
            }
            $this->db->exec("UPDATE devices SET state = 'active', decided_at = ? WHERE id = ?", [Clock::nowIso(), $did]);
        });
    }

    /** Owner: pending → declined (idempotent for declined). */
    public function decline(string $did): void
    {
        $this->db->write(function () use ($did): void {
            $d = $this->person($did);
            if ($d['state'] === 'declined') {
                return;
            }
            if ($d['state'] !== 'pending') {
                throw ApiException::conflict('Only a waiting device can be declined.');
            }
            $this->db->exec("UPDATE devices SET state = 'declined', decided_at = ? WHERE id = ?", [Clock::nowIso(), $did]);
        });
    }

    /**
     * active → revoked (owner, follower = sign out, system); a pending device is declined instead.
     * Ops: device tombstone, the device's sessions and its handoff marker.
     *
     * @return int highest op id (0 = nothing to write)
     */
    public function revoke(string $did, string $by): int
    {
        return $this->db->write(function () use ($did, $by): int {
            $d = $this->db->one('SELECT * FROM devices WHERE id = ?', [$did]);
            if ($d === null) {
                throw ApiException::notFound('No such device.');
            }
            $now = Clock::nowIso();
            if ($d['state'] === 'pending') {
                $this->db->exec("UPDATE devices SET state = 'declined', decided_at = ? WHERE id = ?", [$now, $did]);

                return 0;
            }
            if ($d['state'] !== 'active') {
                return 0;
            }
            $fid = (string) $d['follower_id'];
            $this->db->exec(
                "UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = ?, session_hash = NULL, pending_sid = NULL, handoff_at = NULL WHERE id = ?",
                [$now, $by, $did],
            );
            $this->ops->enqueue('put', StoreLayout::deviceTombstone($fid, $did), StoreOps::json(['s' => 'revoked', 'at' => $now]));
            $this->ops->enqueue('delete_prefix', StoreLayout::sessionPrefix($fid, $did));

            return $this->ops->enqueue('delete', StoreLayout::handoff($did));
        });
    }

    /** Cron: pending devices older than 14 days are declined (revoked_by stays NULL). */
    public function expirePending(): int
    {
        $before = Clock::iso(Clock::now()->modify('-' . self::PENDING_EXPIRY_DAYS . ' days'));

        return $this->db->write(fn (): int => $this->db->exec(
            "UPDATE devices SET state = 'declined', decided_at = ? WHERE state = 'pending' AND created_at < ?",
            [Clock::nowIso(), $before],
        ));
    }

    /**
     * A device of a person (not of the service follower, not of a tombstone).
     *
     * @return array<string, mixed>
     */
    public function person(string $did): array
    {
        $d = $this->byId($did);
        if ($d === null || $d['f_kind'] !== 'person' || $d['f_state'] === 'deleted') {
            throw ApiException::notFound('No such device.');
        }

        return $d;
    }

    /**
     * Contract AdminDevice.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public static function dto(array $row): array
    {
        $s = static fn (mixed $v): ?string => is_string($v) ? $v : null;

        return [
            'id' => (string) $row['id'],
            'state' => (string) $row['state'],
            'label' => (string) $row['label'],
            'first' => (int) $row['first'] === 1,
            'createdAt' => (string) $row['created_at'],
            'decidedAt' => $s($row['decided_at']),
            'revokedAt' => $s($row['revoked_at']),
            'revokedBy' => $s($row['revoked_by']),
            'lastSeenAt' => $s($row['last_seen_at']),
            'sessionAt' => $s($row['session_at']),
        ];
    }
}
