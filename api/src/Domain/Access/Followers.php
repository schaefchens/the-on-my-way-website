<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Config;
use Omw\Api\Http\ApiException;
use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;
use RuntimeException;
use stdClass;

/**
 * People the owner invited (spec-wave5 §3.3 Followers, D6): a stable opaque id that is never
 * reused (tombstones stay), a name, an owner-only note and the personal link (only its sha256 is
 * stored; the link is shown once). Revoking keeps the data (D8); a revoked person cannot be
 * re-activated (re-invite = new id). The service follower ("Publisher", kind service) is the
 * backend's own identity for gate checks and is never listed, counted, exported or shown.
 */
final class Followers
{
    public const SERVICE_NAME = 'Publisher';

    public function __construct(
        private readonly Db $db,
        private readonly StoreOps $ops,
        private readonly Config $config,
        private readonly Consents $consents,
    ) {
    }

    /**
     * @return array{fid: string, link: array{url: string, createdAt: string}}
     *
     * @throws ApiException 409 config_missing when SITE_ORIGIN is not set
     */
    public function create(string $name, ?string $note): array
    {
        $origin = $this->origin();

        return $this->db->write(function () use ($name, $note, $origin): array {
            $fid = null;
            for ($i = 0; $i < 5 && $fid === null; ++$i) {
                $candidate = Tokens::followerId();
                if ($this->db->scalar('SELECT 1 FROM followers WHERE id = ?', [$candidate]) === null) {
                    $fid = $candidate;
                }
            }
            if ($fid === null) {
                throw new RuntimeException('Could not find an unused follower id.');
            }
            $t = Tokens::token();
            $now = Clock::nowIso();
            $this->db->exec(
                "INSERT INTO followers (id, kind, state, name, note, link_hash, link_created_at, created_at, updated_at)
                 VALUES (?, 'person', 'active', ?, ?, ?, ?, ?, ?)",
                [$fid, $name, $note === '' ? null : $note, Tokens::hash($t), $now, $now, $now],
            );

            return ['fid' => $fid, 'link' => ['url' => StoreLayout::personalLinkUrl($origin, $t), 'createdAt' => $now]];
        });
    }

    /**
     * New personal link (active people only); the old one stops working, devices are unaffected.
     *
     * @return array{url: string, createdAt: string}
     */
    public function rotateLink(string $fid): array
    {
        $origin = $this->origin();

        return $this->db->write(function () use ($fid, $origin): array {
            $row = $this->get($fid);
            if ($row['state'] !== 'active') {
                throw ApiException::conflict('Only an active person gets a new link (re-invite instead).');
            }
            $t = Tokens::token();
            $now = Clock::nowIso();
            $this->db->exec('UPDATE followers SET link_hash = ?, link_created_at = ?, updated_at = ? WHERE id = ?', [Tokens::hash($t), $now, $now, $fid]);

            return ['url' => StoreLayout::personalLinkUrl($origin, $t), 'createdAt' => $now];
        });
    }

    /** FollowerPatch (schema-valid): name and/or note (null clears the note). Active or revoked people. */
    public function patch(string $fid, stdClass $patch): void
    {
        $this->db->write(function () use ($fid, $patch): void {
            $this->get($fid);
            $now = Clock::nowIso();
            if (property_exists($patch, 'name') && is_string($patch->name)) {
                $this->db->exec('UPDATE followers SET name = ?, updated_at = ? WHERE id = ?', [$patch->name, $now, $fid]);
            }
            if (property_exists($patch, 'note')) {
                $note = is_string($patch->note) && $patch->note !== '' ? $patch->note : null;
                $this->db->exec('UPDATE followers SET note = ?, updated_at = ? WHERE id = ?', [$note, $now, $fid]);
            }
        });
    }

    /**
     * Ends a person's access (D2; idempotent): link dropped, pending devices declined, active ones
     * revoked with the SAME revoked_at as the person ("ended together", D12 rights), store
     * tombstone, all sessions and handoff markers deleted. Data stays (D8).
     *
     * @return int highest op id (0 when already revoked)
     */
    public function revoke(string $fid): int
    {
        return $this->db->write(function () use ($fid): int {
            $row = $this->get($fid);
            if ($row['state'] !== 'active') {
                return 0;
            }
            $now = Clock::nowIso();
            $this->db->exec("UPDATE followers SET state = 'revoked', link_hash = NULL, link_created_at = NULL, revoked_at = ?, updated_at = ? WHERE id = ?", [$now, $now, $fid]);
            $dids = array_map(static fn (array $r): string => (string) $r['id'], $this->db->all('SELECT id FROM devices WHERE follower_id = ? ORDER BY id', [$fid]));
            $this->db->exec("UPDATE devices SET state = 'declined', decided_at = ? WHERE follower_id = ? AND state = 'pending'", [$now, $fid]);
            $this->db->exec(
                "UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = 'owner', session_hash = NULL, pending_sid = NULL, handoff_at = NULL
                 WHERE follower_id = ? AND state = 'active'",
                [$now, $fid],
            );
            $max = $this->ops->enqueue('put', StoreLayout::personTombstone($fid), StoreOps::json(['s' => 'revoked', 'at' => $now]));
            $max = $this->ops->enqueue('delete_tree', StoreLayout::sessionDir($fid));
            foreach ($dids as $did) {
                $max = $this->ops->enqueue('delete', StoreLayout::handoff($did));
            }

            return $max;
        });
    }

    /**
     * A person (active or revoked; not a tombstone, not the service follower).
     *
     * @return array<string, mixed>
     *
     * @throws ApiException 404
     */
    public function get(string $fid): array
    {
        $row = Tokens::isFollowerId($fid)
            ? $this->db->one("SELECT * FROM followers WHERE id = ? AND kind = 'person' AND state IN ('active', 'revoked')", [$fid])
            : null;

        return $row ?? throw ApiException::notFound('No such person.');
    }

    /** @return array<string, mixed>|null the active person whose personal link hashes to $hash */
    public function byLinkHash(string $hash): ?array
    {
        return $this->db->one("SELECT * FROM followers WHERE link_hash = ? AND state = 'active' AND kind = 'person'", [$hash]);
    }

    /** @return array{items: list<array<string, mixed>>, tombstones: list<array<string, mixed>>} FollowerListResponse */
    public function list(): array
    {
        $items = [];
        foreach ($this->db->all(
            "SELECT * FROM followers WHERE kind = 'person' AND state IN ('active', 'revoked') ORDER BY state = 'active' DESC, created_at DESC, id",
        ) as $row) {
            $items[] = $this->dto($row);
        }
        $tombstones = [];
        foreach ($this->db->all("SELECT id, deleted_at, deleted_by FROM followers WHERE kind = 'person' AND state = 'deleted' ORDER BY deleted_at DESC, id") as $row) {
            $tombstones[] = ['id' => (string) $row['id'], 'state' => 'deleted', 'deletedAt' => (string) $row['deleted_at'], 'deletedBy' => (string) $row['deleted_by']];
        }

        return ['items' => $items, 'tombstones' => $tombstones];
    }

    /**
     * Contract AdminFollower.
     *
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    public function dto(array $row): array
    {
        $fid = (string) $row['id'];
        $devices = array_map(
            static fn (array $d): array => Devices::dto($d),
            $this->db->all('SELECT * FROM devices WHERE follower_id = ? ORDER BY created_at, id', [$fid]),
        );
        $lastSeen = $this->db->scalar('SELECT MAX(last_seen_at) FROM devices WHERE follower_id = ?', [$fid]);

        return [
            'id' => $fid,
            'name' => (string) $row['name'],
            'note' => $row['note'] === null ? null : (string) $row['note'],
            'state' => (string) $row['state'],
            'createdAt' => (string) $row['created_at'],
            'revokedAt' => $row['revoked_at'] === null ? null : (string) $row['revoked_at'],
            'link' => $row['link_created_at'] === null ? null : ['createdAt' => (string) $row['link_created_at']],
            'devices' => $devices,
            'consent' => $this->consents->latest($fid),
            'lastSeenAt' => is_string($lastSeen) ? $lastSeen : null,
        ];
    }

    /**
     * The service follower and its device (created on first use; its key is a random value that is
     * thrown away, so nobody can use the device through the public routes).
     *
     * @return array{fid: string, did: string}
     */
    public function service(): array
    {
        return $this->db->write(function (): array {
            $row = $this->db->one("SELECT d.id AS did, f.id AS fid FROM followers f JOIN devices d ON d.follower_id = f.id
                WHERE f.kind = 'service' AND f.state = 'active' AND d.state = 'active' ORDER BY d.created_at LIMIT 1");
            if ($row !== null) {
                return ['fid' => (string) $row['fid'], 'did' => (string) $row['did']];
            }
            $fid = (string) ($this->db->scalar("SELECT id FROM followers WHERE kind = 'service' AND state = 'active' LIMIT 1") ?? '');
            $now = Clock::nowIso();
            if ($fid === '') {
                do {
                    $fid = Tokens::followerId();
                } while ($this->db->scalar('SELECT 1 FROM followers WHERE id = ?', [$fid]) !== null);
                $this->db->exec(
                    "INSERT INTO followers (id, kind, state, name, created_at, updated_at) VALUES (?, 'service', 'active', ?, ?, ?)",
                    [$fid, self::SERVICE_NAME, $now, $now],
                );
            }
            $did = Devices::unusedId($this->db);
            $this->db->exec(
                "INSERT INTO devices (id, follower_id, state, first, key_hash, label, created_at, decided_at) VALUES (?, ?, 'active', 1, ?, 'Publisher', ?, ?)",
                [$did, $fid, Tokens::hash(Tokens::token()), $now, $now],
            );

            return ['fid' => $fid, 'did' => $did];
        });
    }

    private function origin(): string
    {
        $origin = $this->config->siteOrigin;
        if ($origin === '' || !StoreLayout::isOrigin($origin)) {
            throw new ApiException(409, 'config_missing', 'SITE_ORIGIN is not configured on the API: personal links need the site\'s address.');
        }

        return $origin;
    }
}
