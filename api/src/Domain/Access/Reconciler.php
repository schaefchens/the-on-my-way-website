<?php

declare(strict_types=1);

namespace Omw\Api\Domain\Access;

use Omw\Api\Infra\Clock;
use Omw\Api\Infra\Db;

/**
 * Store repair (spec-wave5 §3.8.5): compares the desired state (the database) with a listing of
 * the store and returns DB imports and store fixes. {@see plan()} is pure (vectors:
 * fixtures/vectors/store-reconcile.json); {@see run()} reads the desired state, applies the
 * imports and enqueues the fixes in ONE write transaction.
 *
 * Modes (chosen by the database: restored_api while reconciled_epoch != epoch, §3.8.6):
 * - normal: delete every s/ file that is not the active session of an active device of an active
 *   follower with the same sid hash; delete h/<did> not awaiting a handoff; write missing
 *   tombstones; lock per DB except the sticky rule (a `locked` file newer than unlocked_at is
 *   imported, never deleted; an older one is deleted); report active sessions without a file
 *   (`missing`: they resume by key); delete strays below s/ and h/.
 * - restored_api: first import the store's tombstones (person revoked → revoke; deleted → erase
 *   again, deleted_by "restore"; device → revoke), tombstone every fid of the listing the DB does
 *   not know (never reused, D6), adopt the session file of a known active device, report the
 *   sessions of unknown devices as orphans; then the normal fixes on the imported state. It also
 *   resets every personal link and the panic link ({@see resetRestoredSecrets()}): the store keeps
 *   no record of a rotation, so a link rotated after the backup (often because it leaked) would
 *   otherwise work again. Connected devices keep their keys; the owner creates new links.
 *
 * Race-free: the listing reflects ops up to `listedThrough` (last_applied_op when it was taken);
 * every fix or lock import on a path that a later op touches is skipped (that op wins and is
 * applied next anyway), and devices touched by later ops are not reported missing.
 */
final class Reconciler
{
    public function __construct(
        private readonly Db $db,
        private readonly StoreOps $ops,
        private readonly OwnerNotices $notices,
    ) {
    }

    /**
     * @param array{
     *   locked: bool, lockedAt: string|null, lockedBy: string|null, unlockedAt: string|null,
     *   followers: array<string, array{state: string, at: string|null}>,
     *   devices: array<string, array{fid: string, state: string, sidHash: string|null, handoff: bool, revokedAt: string|null, together: bool}>
     * } $desired
     * @param array{marker?: string|null, locked: string|null, sessions: list<string>, handoffs: list<string>, tombstones: list<array{path: string, content: string}>, strays: list<string>} $listing
     * @param list<array{op: string, path: string}> $touched ops newer than the listing
     * @return array{
     *   imports: list<array<string, string>>,
     *   ops: list<array{op: string, path: string, content: string|null, exclusive: bool}>,
     *   report: array{deleted: int, missing: list<array{fid: string, did: string}>, orphans: list<array{fid: string, did: string}>, imported: list<string>}
     * }
     */
    public static function plan(string $mode, array $desired, array $listing, array $touched, string $now): array
    {
        $imports = [];
        $ops = [];
        $imported = [];
        $orphans = [];
        $deleted = 0;
        $followers = $desired['followers'];
        $devices = $desired['devices'];
        $locked = $desired['locked'];

        $isTouched = static function (string $path) use ($touched): bool {
            foreach ($touched as $t) {
                $p = $t['path'];
                if ($p === $path
                    || ($t['op'] === 'delete_prefix' && str_starts_with($path, $p))
                    || ($t['op'] === 'delete_tree' && str_starts_with($path, $p . '/'))) {
                    return true;
                }
                if ($t['op'] === 'put' && ($s = StoreLayout::parseSessionPath($p)) !== null
                    && str_starts_with($path, StoreLayout::sessionPrefix($s['fid'], $s['did']))) {
                    return true;
                }
            }

            return false;
        };
        $deviceTouched = static fn (string $fid, string $did): bool => $isTouched(StoreLayout::sessionPrefix($fid, $did) . str_repeat('A', 43))
            || $isTouched(StoreLayout::handoff($did));

        // 1. Lock (both modes; sticky rule).
        if ($listing['locked'] !== null) {
            if (!$locked && !$isTouched(StoreLayout::LOCKED)) {
                $file = self::parseLock($listing['locked']);
                $unlockedAt = $desired['unlockedAt'];
                if ($file === null || $unlockedAt === null || $file['at'] > $unlockedAt) {
                    $by = $file['by'] ?? 'mac';
                    $at = $file['at'] ?? $now;
                    $imports[] = ['kind' => 'lock', 'by' => $by, 'at' => $at];
                    $imported[] = 'lock (' . $by . ')';
                    $locked = true;
                } else {
                    $ops[] = self::op('delete', StoreLayout::LOCKED);
                }
            }
        } elseif ($locked && !$isTouched(StoreLayout::LOCKED)) {
            $ops[] = self::op('put', StoreLayout::LOCKED, StoreOps::json(['at' => $desired['lockedAt'] ?? $now, 'by' => $desired['lockedBy'] ?? 'admin']));
        }

        // 2. restored_api: imports from tombstones and session files.
        $tombstoned = [];
        $markUnknown = static function (string $fid) use (&$followers, &$imports, &$imported, &$tombstoned): void {
            if (isset($followers[$fid]) || isset($tombstoned[$fid])) {
                return;
            }
            $tombstoned[$fid] = true;
            $followers[$fid] = ['state' => 'deleted', 'at' => null];
            $imports[] = ['kind' => 'tombstone_fid', 'fid' => $fid];
            $imported[] = 'tombstoned ' . $fid;
        };
        if ($mode === 'restored_api') {
            foreach ($listing['tombstones'] as $t) {
                $content = self::parseTombstone($t['content']);
                $s = $content['s'] ?? 'revoked';
                $at = $content['at'] ?? $now;
                if (preg_match('#^t/(' . StoreLayout::FID . ')$#D', $t['path'], $m) === 1) {
                    $fid = $m[1];
                    if (!isset($followers[$fid])) {
                        $markUnknown($fid);
                    } elseif ($s === 'deleted' && $followers[$fid]['state'] !== 'deleted') {
                        $imports[] = ['kind' => 'erase_follower', 'fid' => $fid, 'at' => $at];
                        $imported[] = 'erased ' . $fid;
                        $followers[$fid] = ['state' => 'deleted', 'at' => $at];
                        foreach ($devices as $did => $d) {
                            if ($d['fid'] === $fid) {
                                unset($devices[$did]);
                            }
                        }
                    } elseif ($followers[$fid]['state'] === 'active') {
                        $imports[] = ['kind' => 'revoke_follower', 'fid' => $fid, 'at' => $at];
                        $imported[] = 'revoked ' . $fid;
                        $followers[$fid] = ['state' => 'revoked', 'at' => $at];
                        foreach ($devices as $did => $d) {
                            if ($d['fid'] === $fid && $d['state'] === 'pending') {
                                $devices[$did] = ['state' => 'declined', 'sidHash' => null, 'handoff' => false] + $d;
                            } elseif ($d['fid'] === $fid && $d['state'] === 'active') {
                                $devices[$did] = ['state' => 'revoked', 'sidHash' => null, 'handoff' => false, 'revokedAt' => $at, 'together' => true] + $d;
                            }
                        }
                    }
                } elseif (preg_match('#^t/(' . StoreLayout::FID . ')\.(' . StoreLayout::DID . ')$#D', $t['path'], $m) === 1) {
                    [$fid, $did] = [$m[1], $m[2]];
                    if (!isset($followers[$fid])) {
                        $markUnknown($fid);
                    } elseif (isset($devices[$did]) && $devices[$did]['fid'] === $fid && in_array($devices[$did]['state'], ['active', 'pending'], true)) {
                        $imports[] = ['kind' => 'revoke_device', 'fid' => $fid, 'did' => $did, 'at' => $at];
                        $imported[] = 'revoked device ' . $fid . '.' . $did;
                        $devices[$did] = ['state' => 'revoked', 'sidHash' => null, 'handoff' => false, 'revokedAt' => $at, 'together' => false] + $devices[$did];
                    }
                }
            }
            $adopted = [];
            $sessions = $listing['sessions'];
            sort($sessions, SORT_STRING);
            foreach ($sessions as $path) {
                $p = StoreLayout::parseSessionPath($path);
                if ($p === null) {
                    continue;
                }
                $markUnknown($p['fid']);
                $d = $devices[$p['did']] ?? null;
                if ($d === null) {
                    // An orphan is a device the restored database never knew (its key is lost);
                    // the devices of a person erased above are simply deleted.
                    if (!isset($desired['devices'][$p['did']])) {
                        $orphans[$p['fid'] . '.' . $p['did']] = ['fid' => $p['fid'], 'did' => $p['did']];
                    }

                    continue;
                }
                if ($d['fid'] === $p['fid'] && $d['state'] === 'active' && ($followers[$p['fid']]['state'] ?? null) === 'active'
                    && !isset($adopted[$p['did']]) && !$deviceTouched($p['fid'], $p['did'])) {
                    $hash = Tokens::hash($p['sid']);
                    $adopted[$p['did']] = true;
                    if ($d['sidHash'] !== $hash) {
                        $imports[] = ['kind' => 'adopt_session', 'fid' => $p['fid'], 'did' => $p['did'], 'sidHash' => $hash];
                        $imported[] = 'adopted ' . $p['fid'] . '.' . $p['did'];
                        $devices[$p['did']]['sidHash'] = $hash;
                    }
                }
            }
        }

        // 3. Session files.
        $present = [];
        foreach ($listing['sessions'] as $path) {
            $p = StoreLayout::parseSessionPath($path);
            if ($p === null) {
                continue;
            }
            $d = $devices[$p['did']] ?? null;
            $hash = Tokens::hash($p['sid']);
            $keep = $d !== null && $d['fid'] === $p['fid'] && $d['state'] === 'active'
                && ($followers[$p['fid']]['state'] ?? null) === 'active' && $d['sidHash'] === $hash;
            if ($keep) {
                $present[$p['did']] = true;
            } elseif (!$isTouched($path)) {
                $ops[] = self::op('delete', $path);
                ++$deleted;
            }
        }
        $missing = [];
        foreach ($devices as $did => $d) {
            if ($d['state'] === 'active' && $d['sidHash'] !== null && ($followers[$d['fid']]['state'] ?? null) === 'active'
                && !isset($present[$did]) && !$deviceTouched($d['fid'], (string) $did)) {
                $missing[] = ['fid' => $d['fid'], 'did' => (string) $did];
            }
        }

        // 4. Handoff markers.
        foreach ($listing['handoffs'] as $did) {
            $d = $devices[$did] ?? null;
            $wanted = $d !== null && $d['state'] === 'active' && $d['handoff'] && ($followers[$d['fid']]['state'] ?? null) === 'active';
            if (!$wanted && !$isTouched(StoreLayout::handoff($did))) {
                $ops[] = self::op('delete', StoreLayout::handoff($did));
                ++$deleted;
            }
        }

        // 5. Tombstones the store is missing (never deleted; a person's "revoked" is upgraded to "deleted").
        $actualT = [];
        foreach ($listing['tombstones'] as $t) {
            $actualT[$t['path']] = self::parseTombstone($t['content']);
        }
        foreach (self::desiredTombstones($followers, $devices, $now) as $path => $content) {
            if ($isTouched($path)) {
                continue;
            }
            if (!array_key_exists($path, $actualT)) {
                $ops[] = self::op('put', $path, StoreOps::json($content));
            } elseif ($content['s'] === 'deleted' && ($actualT[$path]['s'] ?? null) !== 'deleted') {
                $ops[] = self::op('put', $path, StoreOps::json($content));
            }
        }

        // 6. Strays below s/ and h/.
        foreach ($listing['strays'] as $stray) {
            if ((str_starts_with($stray, 's/') || str_starts_with($stray, 'h/')) && StoreLayout::kind($stray) === 'stray' && !$isTouched($stray)) {
                $ops[] = self::op('delete_tree', $stray);
                ++$deleted;
            }
        }

        ksort($orphans, SORT_STRING);
        usort($missing, static fn (array $a, array $b): int => strcmp($a['fid'] . $a['did'], $b['fid'] . $b['did']));

        return [
            'imports' => $imports,
            'ops' => $ops,
            'report' => ['deleted' => $deleted, 'missing' => $missing, 'orphans' => array_values($orphans), 'imported' => $imported],
        ];
    }

    /**
     * Tombstones the store should hold: t/<fid> for revoked and deleted people, t/<fid>.<did> for
     * devices revoked on their own (not together with their person).
     *
     * @param array<string, array{state: string, at: string|null}> $followers
     * @param array<string, array{fid: string, state: string, sidHash: string|null, handoff: bool, revokedAt: string|null, together: bool}> $devices
     * @return array<string, array{s: string, at: string}>
     */
    public static function desiredTombstones(array $followers, array $devices, string $now): array
    {
        $out = [];
        foreach ($followers as $fid => $f) {
            if ($f['state'] === 'revoked' || $f['state'] === 'deleted') {
                $out[StoreLayout::personTombstone((string) $fid)] = ['s' => $f['state'], 'at' => $f['at'] ?? $now];
            }
        }
        foreach ($devices as $did => $d) {
            if ($d['state'] === 'revoked' && !$d['together'] && ($followers[$d['fid']]['state'] ?? null) !== 'deleted') {
                $out[StoreLayout::deviceTombstone($d['fid'], (string) $did)] = ['s' => 'revoked', 'at' => $d['revokedAt'] ?? $now];
            }
        }
        ksort($out, SORT_STRING);

        return $out;
    }

    /**
     * The desired state from the database (inside the caller's transaction).
     *
     * @return array{
     *   locked: bool, lockedAt: string|null, lockedBy: string|null, unlockedAt: string|null,
     *   followers: array<string, array{state: string, at: string|null}>,
     *   devices: array<string, array{fid: string, state: string, sidHash: string|null, handoff: bool, revokedAt: string|null, together: bool}>
     * }
     */
    public function desired(): array
    {
        $state = $this->db->one('SELECT locked, locked_at, locked_by, unlocked_at FROM access_state WHERE id = 1') ?? [];
        $followers = [];
        $revokedAt = [];
        foreach ($this->db->all('SELECT id, state, revoked_at, deleted_at FROM followers') as $f) {
            $fid = (string) $f['id'];
            $at = $f['state'] === 'deleted' ? $f['deleted_at'] : $f['revoked_at'];
            $followers[$fid] = ['state' => (string) $f['state'], 'at' => is_string($at) ? $at : null];
            $revokedAt[$fid] = is_string($f['revoked_at']) ? $f['revoked_at'] : null;
        }
        $devices = [];
        foreach ($this->db->all('SELECT id, follower_id, state, session_hash, handoff_at, revoked_at FROM devices') as $d) {
            $fid = (string) $d['follower_id'];
            $devRevoked = is_string($d['revoked_at']) ? $d['revoked_at'] : null;
            $devices[(string) $d['id']] = [
                'fid' => $fid,
                'state' => (string) $d['state'],
                'sidHash' => is_string($d['session_hash']) ? $d['session_hash'] : null,
                'handoff' => $d['handoff_at'] !== null,
                'revokedAt' => $devRevoked,
                'together' => $devRevoked !== null && ($followers[$fid]['state'] ?? null) === 'revoked' && $devRevoked === ($revokedAt[$fid] ?? null),
            ];
        }

        return [
            'locked' => (int) ($state['locked'] ?? 0) === 1,
            'lockedAt' => is_string($state['locked_at'] ?? null) ? $state['locked_at'] : null,
            'lockedBy' => is_string($state['locked_by'] ?? null) ? $state['locked_by'] : null,
            'unlockedAt' => is_string($state['unlocked_at'] ?? null) ? $state['unlocked_at'] : null,
            'followers' => $followers,
            'devices' => $devices,
        ];
    }

    /**
     * Runs one reconcile on a listing taken while ops up to $listedThrough were applied: one write
     * transaction reads the desired state, applies the imports, enqueues the fixes and stores the
     * report. A restored_api run ends the restore freeze (reconciled_epoch = epoch).
     *
     * @param array{marker?: string|null, locked: string|null, sessions: list<string>, handoffs: list<string>, tombstones: list<array{path: string, content: string}>, strays: list<string>} $listing
     * @return array{at: string, mode: string, deleted: int, missing: list<array{fid: string, did: string}>, orphans: list<array{fid: string, did: string}>, imported: list<string>}
     */
    public function run(array $listing, int $listedThrough): array
    {
        return $this->db->write(function () use ($listing, $listedThrough): array {
            $state = $this->db->one('SELECT epoch, reconciled_epoch FROM access_state WHERE id = 1') ?? [];
            $mode = ($state['reconciled_epoch'] ?? null) !== ($state['epoch'] ?? null) ? 'restored_api' : 'normal';
            $now = Clock::nowIso();
            $plan = self::plan($mode, $this->desired(), $listing, $this->ops->touchedAfter($listedThrough), $now);
            foreach ($plan['imports'] as $import) {
                $this->applyImport($import, $now);
            }
            $reset = $mode === 'restored_api' ? $this->resetRestoredSecrets($now) : ['links' => 0, 'panicLink' => false];
            foreach ($plan['ops'] as $op) {
                $this->ops->enqueue($op['op'], $op['path'], $op['content'], $op['exclusive']);
            }
            $report = ['at' => $now, 'mode' => $mode] + $plan['report'];
            $report['imported'] = array_map(static fn (string $s): string => mb_substr($s, 0, 200), $report['imported']);
            $this->db->exec(
                'UPDATE access_state SET reconcile_report = ?, last_reconcile_at = ?, updated_at = ?' . ($mode === 'restored_api' ? ', reconciled_epoch = epoch' : '') . ' WHERE id = 1',
                [json_encode($report, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES), $now, $now],
            );
            $tombstoned = count(array_filter($plan['imports'], static fn (array $i): bool => $i['kind'] === 'tombstone_fid' || $i['kind'] === 'erase_follower'));
            if ($plan['report']['orphans'] !== [] || $tombstoned > 0 || $reset['links'] > 0 || $reset['panicLink']) {
                $people = array_values(array_unique(array_map(static fn (array $o): string => $o['fid'], $plan['report']['orphans'])));
                $this->notices->add('restore_reconciled', [
                    'devices' => count($plan['report']['orphans']),
                    'people' => $people,
                    'tombstoned' => $tombstoned,
                    'links' => $reset['links'],
                    'panicLink' => $reset['panicLink'],
                ]);
            }

            return $report;
        });
    }

    /**
     * After a restore of the API database: secrets the owner may have replaced after the backup
     * are back in the restored rows. Personal links and the panic link are reset (the admin's
     * "after a restore" card lists the people who need a new link); devices keep their keys.
     *
     * @return array{links: int, panicLink: bool}
     */
    private function resetRestoredSecrets(string $now): array
    {
        $links = $this->db->exec(
            "UPDATE followers SET link_hash = NULL, link_created_at = NULL, updated_at = ? WHERE kind = 'person' AND state = 'active' AND link_hash IS NOT NULL",
            [$now],
        );
        $panic = $this->db->exec('UPDATE access_state SET panic_hash = NULL, updated_at = ? WHERE id = 1 AND panic_hash IS NOT NULL', [$now]);

        return ['links' => $links, 'panicLink' => $panic > 0];
    }

    /** @param array<string, string> $import */
    private function applyImport(array $import, string $now): void
    {
        $fid = $import['fid'] ?? '';
        switch ($import['kind']) {
            case 'lock':
                $this->db->exec('UPDATE access_state SET locked = 1, locked_at = ?, locked_by = ?, updated_at = ? WHERE id = 1', [$import['at'], $import['by'], $now]);
                break;
            case 'revoke_follower':
                $at = $import['at'];
                $this->db->exec("UPDATE followers SET state = 'revoked', link_hash = NULL, link_created_at = NULL, revoked_at = ?, updated_at = ? WHERE id = ? AND state = 'active'", [$at, $now, $fid]);
                $this->db->exec("UPDATE devices SET state = 'declined', decided_at = ? WHERE follower_id = ? AND state = 'pending'", [$now, $fid]);
                $this->db->exec(
                    "UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = 'system', session_hash = NULL, pending_sid = NULL, handoff_at = NULL WHERE follower_id = ? AND state = 'active'",
                    [$at, $fid],
                );
                break;
            case 'erase_follower':
                FollowerData::eraseRows($this->db, $fid, 'restore', $import['at']);
                break;
            case 'revoke_device':
                $this->db->exec(
                    "UPDATE devices SET state = 'revoked', revoked_at = ?, revoked_by = 'system', session_hash = NULL, pending_sid = NULL, handoff_at = NULL WHERE id = ? AND follower_id = ? AND state IN ('active', 'pending')",
                    [$import['at'], $import['did'], $fid],
                );
                break;
            case 'adopt_session':
                $this->db->exec(
                    "UPDATE devices SET session_hash = ?, session_at = COALESCE(session_at, ?) WHERE id = ? AND follower_id = ? AND state = 'active'",
                    [$import['sidHash'], $now, $import['did'], $fid],
                );
                break;
            case 'tombstone_fid':
                $this->db->exec(
                    "INSERT OR IGNORE INTO followers (id, kind, state, created_at, updated_at, deleted_at, deleted_by) VALUES (?, 'person', 'deleted', ?, ?, ?, 'restore')",
                    [$fid, $now, $now, $now],
                );
                break;
        }
    }

    /** @return array{op: string, path: string, content: string|null, exclusive: bool} */
    private static function op(string $op, string $path, ?string $content = null): array
    {
        return ['op' => $op, 'path' => $path, 'content' => $content, 'exclusive' => true];
    }

    /** @return array{at: string, by: string}|null */
    public static function parseLock(string $content): ?array
    {
        $data = json_decode($content, true);
        if (!is_array($data) || !is_string($data['at'] ?? null) || !in_array($data['by'] ?? null, ['admin', 'panic', 'mac'], true)) {
            return null;
        }

        return ['at' => $data['at'], 'by' => (string) $data['by']];
    }

    /** @return array{s?: string, at?: string} */
    public static function parseTombstone(string $content): array
    {
        $data = json_decode($content, true);
        $out = [];
        if (is_array($data) && in_array($data['s'] ?? null, ['revoked', 'deleted'], true)) {
            $out['s'] = (string) $data['s'];
        }
        if (is_array($data) && is_string($data['at'] ?? null)) {
            $out['at'] = $data['at'];
        }

        return $out;
    }
}
