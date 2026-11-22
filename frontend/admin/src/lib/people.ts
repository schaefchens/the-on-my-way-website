/**
 * Pure helpers of the People screens (spec-wave5 §7.3–§7.5). Types only from the contracts: a
 * runtime import of @omw/contracts/access would pull zod into the bundle, so the follower id
 * pattern is restated here (a unit test pins it to FOLLOWER_ID_RE).
 */
import type { AdminDevice, AdminFollower, FollowerTombstone, StoreReport } from '@omw/contracts/access';
import type { LocaleCode } from '@omw/contracts/i18n';
import { localDateFor } from '@omw/contracts/time';
import { dateTimeFormat } from '@omw/ui/locale';

export const FID_RE = /^[a-z2-7]{12}$/;

export function isFollowerId(value: unknown): value is string {
  return typeof value === 'string' && FID_RE.test(value);
}

/** The chip of a device: Waiting / Active / Removed / Declined / Signed out. */
export type DeviceChip = 'pending' | 'active' | 'removed' | 'declined' | 'signed_out';

export function deviceChip(d: Pick<AdminDevice, 'state' | 'revokedBy'>): DeviceChip {
  switch (d.state) {
    case 'pending':
      return 'pending';
    case 'active':
      return 'active';
    case 'declined':
      return 'declined';
    case 'revoked':
      return d.revokedBy === 'follower' ? 'signed_out' : 'removed';
  }
}

/** What kind of device a label names ("iPhone · Safari" → phone), for its icon (§3.3 Devices 1). */
export type DeviceKind = 'phone' | 'tablet' | 'computer' | 'other';

export function deviceKind(label: string): DeviceKind {
  const platform = label.split('·')[0]?.trim() ?? '';
  switch (platform) {
    case 'iPhone':
    case 'Android':
      return 'phone';
    case 'iPad':
      return 'tablet';
    case 'Mac':
    case 'Windows':
    case 'Linux':
      return 'computer';
    default:
      return 'other';
  }
}

export function countDevices(f: Pick<AdminFollower, 'devices'>, state: AdminDevice['state']): number {
  return f.devices.filter((d) => d.state === state).length;
}

/** Device list order: waiting first, then active, then the rest; newest first within each. */
export function sortDevices(devices: readonly AdminDevice[]): AdminDevice[] {
  const rank: Record<AdminDevice['state'], number> = { pending: 0, active: 1, revoked: 2, declined: 3 };
  return [...devices].sort((a, b) =>
    rank[a.state] !== rank[b.state] ? rank[a.state] - rank[b.state] : a.createdAt < b.createdAt ? 1 : -1,
  );
}

/** Calendar days between an instant and now in `tz` (0 = today, 1 = yesterday). */
export function daysAgo(iso: string, now: number, tz: string): number {
  const a = Date.parse(`${localDateFor(iso, tz)}T00:00:00Z`);
  const b = Date.parse(`${localDateFor(now, tz)}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** "20. Nov. 2026" in `tz` (invitation, end and deletion dates). */
export function formatDay(iso: string, locale: LocaleCode, tz: string): string {
  return dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(
    new Date(iso),
  );
}

/** "heute" / "gestern" / "vor 3 Tagen" (day granularity: last-seen times are coarse on purpose). */
export function formatDaysAgo(iso: string, locale: string, now: number, tz: string): string {
  const days = daysAgo(iso, now, tz);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-days, 'day');
}

const RESTORE_WINDOW_MS = 60 * 60_000;

export interface RestoreSummary {
  /** Devices that lost access and must join again with a new link (their person is still known). */
  devices: number;
  /** Their people's names (unique, in list order). */
  names: string[];
  /** People missing from the backup (now restore tombstones): invite them again. */
  people: number;
  /**
   * Active people without a personal link: the restore reset every link (a link replaced after
   * the backup must not work again), so each needs a new one before adding a device.
   */
  needLink: { id: string; name: string }[];
}

/**
 * The "after a restore" card (§3.8.6, §7.3) from the last reconcile report: orphaned sessions of
 * known people need a new link; fids the restored database did not know became tombstones; the
 * personal links were reset, so active people without a link are listed until the owner gives
 * them a new one.
 */
export function restoreSummary(
  report: StoreReport | null | undefined,
  followers: readonly (Pick<AdminFollower, 'id' | 'name'> & Partial<Pick<AdminFollower, 'state' | 'link'>>)[],
  tombstones: readonly Pick<FollowerTombstone, 'id' | 'deletedBy' | 'deletedAt'>[] = [],
): RestoreSummary | null {
  if (report?.mode !== 'restored_api') return null;
  const byId = new Map(followers.map((f) => [f.id, f.name]));
  // Restore tombstones written by THIS reconcile (an older restore's ones are not news).
  const at = Date.parse(report.at);
  const restoredIds = new Set(
    tombstones
      .filter((t) => t.deletedBy === 'restore' && Math.abs(Date.parse(t.deletedAt) - at) <= RESTORE_WINDOW_MS)
      .map((t) => t.id),
  );
  let devices = 0;
  const names: string[] = [];
  const unknown = new Set<string>();
  for (const o of report.orphans) {
    const name = byId.get(o.fid);
    if (name !== undefined) {
      devices += 1;
      if (!names.includes(name)) names.push(name);
    } else {
      unknown.add(o.fid);
    }
  }
  for (const id of restoredIds) unknown.add(id);
  const needLink = followers
    .filter((f) => f.state === 'active' && f.link === null)
    .map((f) => ({ id: f.id, name: f.name }));
  if (devices === 0 && unknown.size === 0 && needLink.length === 0) return null;
  return { devices, names, people: unknown.size, needLink };
}
