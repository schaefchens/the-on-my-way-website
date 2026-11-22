<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * "Your data" (D12, spec-wave5 §3.3): view, export and delete of everything stored under a
 * person's id, and the one place that decides who may do that ({@see rightsOf()}):
 *
 * - full: the device is active and its person active; or the device is revoked, the person
 *   revoked and both have the SAME revoked_at (the device was in use until the person's access
 *   ended);
 * - limited: every other device of a person that is not deleted (pending, declined, revoked on
 *   its own or before the person): it sees only its own label, state and creation time and can
 *   withdraw its request; it never sees the person's other devices nor erases her;
 * - none: unknown key, deleted person, the service follower.
 */
final class FollowerData
{
    public function __construct(
        private readonly Db $db,
        private readonly StoreOps $ops,
        private readonly Consents $consents,
        private readonly PrivacyNotices $notices,
        private readonly OwnerNotices $ownerNotices,
    ) {
    }

    /**
     * @param array<string, mixed>|null $device a Devices::byKey() row (with f_state, f_kind, f_revoked_at)
     * @return 'full'|'limited'|'none'
     */
    public static function rightsOf(?array $device): string
    {
        if ($device === null || ($device['f_kind'] ?? null) !== 'person' || !in_array($device['f_state'] ?? null, ['active', 'revoked'], true)) {
            return 'none';
        }
        if ($device['state'] === 'active' && $device['f_state'] === 'active') {
            return 'full';
        }
        if ($device['state'] === 'revoked' && $device['f_state'] === 'revoked'
            && is_string($device['revoked_at']) && $device['revoked_at'] === $device['f_revoked_at']) {
            return 'full';
        }

        return 'limited';
    }

    /** @return array<string, mixed> contract FollowerDataView (full rights only) */
    public function view(string $fid, string $thisDid): array
    {
        $f = $this->follower($fid);
        $devices = [];
        foreach ($this->db->all('SELECT * FROM devices WHERE follower_id = ? ORDER BY created_at, id', [$fid]) as $d) {
            $devices[] = [
                'id' => (string) $d['id'],
                'label' => (string) $d['label'],
                'state' => (string) $d['state'],
                'createdAt' => (string) $d['created_at'],
                'lastSeenAt' => is_string($d['last_seen_at']) ? $d['last_seen_at'] : null,
                'thisDevice' => $d['id'] === $thisDid,
            ];
        }
        $consents = $this->consents->list($fid);

        return [
            'follower' => ['id' => $fid, 'name' => (string) $f['name'], 'since' => (string) $f['created_at'], 'state' => (string) $f['state']],
            'devices' => $devices,
            'consents' => $consents,
            'categories' => [
                ['key' => 'devices', 'count' => count($devices)],
                ['key' => 'consents', 'count' => count($consents)],
            ],
            'noticeVersion' => $this->notices->currentVersion(),
        ];
    }

    /** @return array<string, mixed> contract FollowerDataExport */
    public function export(string $fid): array
    {
        $f = $this->follower($fid);
        $devices = [];
        foreach ($this->db->all('SELECT * FROM devices WHERE follower_id = ? ORDER BY created_at, id', [$fid]) as $d) {
            $s = static fn (mixed $v): ?string => is_string($v) ? $v : null;
            $devices[] = [
                'id' => (string) $d['id'],
                'label' => (string) $d['label'],
                'state' => (string) $d['state'],
                'createdAt' => (string) $d['created_at'],
                'lastSeenAt' => $s($d['last_seen_at']),
                'decidedAt' => $s($d['decided_at']),
                'revokedAt' => $s($d['revoked_at']),
                'revokedBy' => $s($d['revoked_by']),
            ];
        }
        $consents = [];
        foreach ($this->consents->list($fid) as $c) {
            $notice = $this->notices->notice($c['version']);
            if ($notice !== null) {
                $consents[] = $c + ['notice' => $notice];
            }
        }

        return [
            'format' => 'omw-follower-data/1',
            'exportedAt' => Clock::nowIso(),
            'follower' => [
                'id' => $fid,
                'name' => (string) $f['name'],
                'since' => (string) $f['created_at'],
                'state' => (string) $f['state'],
                'linkCreatedAt' => is_string($f['link_created_at']) ? $f['link_created_at'] : null,
                'revokedAt' => is_string($f['revoked_at']) ? $f['revoked_at'] : null,
            ],
            'devices' => $devices,
            'consents' => $consents,
            'categories' => [
                ['key' => 'devices', 'count' => count($devices)],
                ['key' => 'consents', 'count' => count($consents)],
            ],
        ];
    }

    /**
     * Erases everything referencing $fid (one transaction): devices and consents (wave 6 adds its
     * tables here), the store-op history of the person, the person row becomes an anonymous
     * tombstone; store tombstone "deleted", all sessions and handoff markers deleted; a follower's
     * own deletion queues the owner notice.
     *
     * @param 'follower'|'owner' $by
     * @return int highest op id
     */
    public function delete(string $fid, string $by): int
    {
        return $this->db->write(function () use ($fid, $by): int {
            $this->follower($fid);
            $now = Clock::nowIso();
            $dids = array_map(static fn (array $r): string => (string) $r['id'], $this->db->all('SELECT id FROM devices WHERE follower_id = ? ORDER BY id', [$fid]));
            // First the rows (and the op history), then this deletion's own ops: they are all that
            // is left of the person in store_ops (the tombstone and the deletes, pruned after 7 days).
            self::eraseRows($this->db, $fid, $by, $now);
            $max = $this->ops->enqueue('put', StoreLayout::personTombstone($fid), StoreOps::json(['s' => 'deleted', 'at' => $now]));
            $max = $this->ops->enqueue('delete_tree', StoreLayout::sessionDir($fid));
            foreach ($dids as $did) {
                $max = $this->ops->enqueue('delete', StoreLayout::handoff($did));
            }
            if ($by === 'follower') {
                $this->ownerNotices->add('follower_deleted', ['at' => $now]);
            }

            return $max;
        });
    }

    /**
     * The database part of an erasure (also used by the restore reconcile, deleted_by "restore";
     * inside the caller's transaction). Besides the rows it removes the person's store-op history
     * (paths name her id and her devices' ids, and their times show when each device joined,
     * resumed and was removed) and her id from the last reconcile report and the restore notices.
     * Ops enqueued after this call (the erasure's own tombstone and deletes) are kept.
     */
    public static function eraseRows(Db $db, string $fid, string $by, string $at): void
    {
        $dids = array_map(static fn (array $r): string => (string) $r['id'], $db->all('SELECT id FROM devices WHERE follower_id = ?', [$fid]));
        self::forgetStoreOps($db, $fid, $dids);
        self::forgetInReports($db, $fid);
        $db->exec('DELETE FROM consents WHERE follower_id = ?', [$fid]);
        $db->exec('DELETE FROM devices WHERE follower_id = ?', [$fid]);
        $db->exec(
            "UPDATE followers SET state = 'deleted', name = NULL, note = NULL, link_hash = NULL, link_created_at = NULL,
                revoked_at = NULL, deleted_at = ?, deleted_by = ?, created_at = ?, updated_at = ? WHERE id = ? AND state <> 'deleted'",
            [$at, $by, $at, $at, $fid],
        );
    }

    /**
     * Deletes every store op (applied or still pending) on a path of the person: t/<fid>,
     * t/<fid>.<did>, s/<fid>, s/<fid>/…, h/<did>. Dropping a pending one is safe because the
     * erasure's own ops (enqueued afterwards) delete the same session files and handoff markers and
     * write the "deleted" tombstone; a device tombstone is not needed for an erased person. An
     * applier that already holds such an op applies it and then skips the missing row.
     *
     * @param list<string> $dids
     */
    private static function forgetStoreOps(Db $db, string $fid, array $dids): void
    {
        $tPrefix = StoreLayout::personTombstone($fid) . '.';
        $sPrefix = StoreLayout::sessionDir($fid) . '/';
        $db->exec(
            'DELETE FROM store_ops WHERE path = ? OR path = ? OR substr(path, 1, ?) = ? OR substr(path, 1, ?) = ?',
            [StoreLayout::personTombstone($fid), StoreLayout::sessionDir($fid), strlen($tPrefix), $tPrefix, strlen($sPrefix), $sPrefix],
        );
        foreach ($dids as $did) {
            $db->exec('DELETE FROM store_ops WHERE path = ?', [StoreLayout::handoff($did)]);
        }
    }

    /** Removes the fid from the stored reconcile report and from restore notices (their `people`). */
    private static function forgetInReports(Db $db, string $fid): void
    {
        $raw = $db->scalar('SELECT reconcile_report FROM access_state WHERE id = 1');
        $report = is_string($raw) && str_contains($raw, $fid) ? json_decode($raw, true) : null;
        if (is_array($report)) {
            foreach (['missing', 'orphans'] as $key) {
                if (is_array($report[$key] ?? null)) {
                    $report[$key] = array_values(array_filter($report[$key], static fn (mixed $e): bool => !is_array($e) || ($e['fid'] ?? null) !== $fid));
                }
            }
            if (is_array($report['imported'] ?? null)) {
                $report['imported'] = array_values(array_filter($report['imported'], static fn (mixed $e): bool => !is_string($e) || !str_contains($e, $fid)));
            }
            $db->exec('UPDATE access_state SET reconcile_report = ? WHERE id = 1', [json_encode($report, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)]);
        }
        foreach ($db->all("SELECT id, data FROM owner_notices WHERE data IS NOT NULL AND instr(data, ?) > 0", [$fid]) as $row) {
            $data = json_decode((string) $row['data'], true);
            if (!is_array($data)) {
                continue;
            }
            if (is_array($data['people'] ?? null)) {
                $data['people'] = array_values(array_filter($data['people'], static fn (mixed $p): bool => $p !== $fid));
            }
            $db->exec('UPDATE owner_notices SET data = ? WHERE id = ?', [json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), (int) $row['id']]);
        }
    }

    /** @return array<string, mixed> an active or revoked person */
    private function follower(string $fid): array
    {
        $f = $this->db->one("SELECT * FROM followers WHERE id = ? AND kind = 'person' AND state IN ('active', 'revoked')", [$fid]);
        if ($f === null) {
            throw new \Omw\Api\Http\ApiException(404, 'not_found', 'No such person.');
        }

        return $f;
    }
}
