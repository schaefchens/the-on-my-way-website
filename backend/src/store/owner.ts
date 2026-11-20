/**
 * Owner-content mirror (API is primary): posts, annotations, days, trips, settings.
 * Filled from the change feed (GET /api/v1/backend/changes) via applyChanges().
 *
 * Robustness rules (contracts ./api, "Change feed"):
 * - Items are parsed ONE BY ONE (parseChangeItem). Unknown entities/setting keys (newer API) are
 *   ignored with an event; invalid items are quarantined (feed_quarantine + event) and the last
 *   good value stays. Each item is applied in its own savepoint. The cursor always advances to
 *   the page's nextSeq, so no single item can block the feed.
 * - Ignored items are remembered by kind (sync_state FEED_IGNORED_KEY, besides the
 *   "feed.item_ignored" events of older versions). A newer backend that knows such a kind
 *   replays the feed once at startup (replayIgnoredIfKnown -> beginRebuild): e.g. profile
 *   settings saved in a newer admin before the backend was upgraded are not lost.
 * - Feed identity: the first page stores the API's feedId. A different feedId (API restored or
 *   reinstalled) or a 409 "feed_reset" starts a REBUILD: the cursor goes back to 0 and every
 *   mirrored row is marked unconfirmed (seq = NULL) but kept, so hidden overrides and
 *   descriptions stay in force while the API is replayed. When the replay reaches the end
 *   (hasMore = false), rows the new feed did not confirm are swept.
 */
import {
  type Annotation,
  Annotation as AnnotationSchema,
  CHANGE_ENTITIES,
  type ChangeEntity,
  type ChangeItem,
  ChangesPage,
  type Day,
  Day as DaySchema,
  isSettingKey,
  type Post,
  Post as PostSchema,
  parseChangeItem,
  parseSettingValue,
  type SettingKey,
  type Settings,
  type Trip,
  Trip as TripSchema,
  withSettingsDefaults,
} from '@omw/contracts/api';
import { effectiveLocalDate, tripForDate } from '@omw/contracts/policy';
import { addDays, dateRange } from '@omw/contracts/time';
import type { Db } from './db.js';
import type { EventRepo } from './events.js';
import { FEED_IGNORED_EVENTS_KEY, FEED_IGNORED_KEY, type SyncStateRepo } from './syncState.js';
import type { Clock } from './types.js';

export interface ChangeSummary {
  /** Items applied (items at or below the stored cursor are skipped). */
  applied: number;
  /** Already applied earlier (seq <= cursor). */
  skipped: number;
  /** Unknown entity or setting key (newer API): ignored. */
  ignored: number;
  /** Invalid items, kept out of the mirror (see feed_quarantine). */
  quarantined: number;
  /** New feed cursor. */
  cursor: number;
  /** Effective local dates whose content may have changed (sorted). */
  localDates: string[];
  /** Trip slugs whose content may have changed (sorted). */
  trips: string[];
  /** A setting changed: everything may need regeneration. */
  settingsChanged: boolean;
  /**
   * The feed changed identity: nothing was applied, the cursor is 0 and the caller must pull
   * again from 0 (the mirror is rebuilt from the replay).
   */
  reset: boolean;
  /** A rebuild finished with this page (unconfirmed rows swept): regenerate everything. */
  rebuilt: boolean;
}

export interface QuarantinedItem {
  id: number;
  feedId: string | null;
  seq: number | null;
  entity: string | null;
  key: string | null;
  raw: unknown;
  error: string;
  receivedAt: string;
}

/** Kind of an ignored change-feed item (FEED_IGNORED_KEY). */
interface IgnoredKind {
  entity: string;
  key?: string;
}

/** At most this many distinct ignored kinds are remembered. */
const IGNORED_KINDS_MAX = 200;

/** Whether this version applies items of that kind (a known entity; for settings a known key). */
function isKnownKind(kind: IgnoredKind): boolean {
  if (!(CHANGE_ENTITIES as readonly string[]).includes(kind.entity)) return false;
  return kind.entity !== 'setting' || kind.key === undefined || isSettingKey(kind.key);
}

const MIRROR_TABLES: Readonly<Record<ChangeEntity, { table: string; key: string }>> = {
  post: { table: 'posts', key: 'public_id' },
  annotation: { table: 'annotations', key: 'source_key' },
  day: { table: 'days', key: 'local_date' },
  trip: { table: 'trips', key: 'slug' },
  setting: { table: 'settings', key: 'key' },
};

export class OwnerRepo {
  private readonly db: Db;
  private readonly now: Clock;
  private readonly syncState: SyncStateRepo;
  private readonly events: EventRepo | undefined;

  constructor(db: Db, now: Clock, syncState: SyncStateRepo, events?: EventRepo) {
    this.db = db;
    this.now = now;
    this.syncState = syncState;
    this.events = events;
  }

  // ----------------------------------------------------------------------------- posts

  getPost(publicId: string): Post | undefined {
    const r = this.db.prepare('SELECT data_json FROM posts WHERE public_id = ?').get(publicId) as
      | { data_json: string }
      | undefined;
    return r ? (JSON.parse(r.data_json) as Post) : undefined;
  }

  /** Posts by their STORED local date (see Placement in contracts ./policy). */
  listPosts(filter: { localDate?: string } = {}): Post[] {
    const rows = (
      filter.localDate
        ? this.db
            .prepare('SELECT data_json FROM posts WHERE local_date = ? ORDER BY occurred_at, public_id')
            .all(filter.localDate)
        : this.db.prepare('SELECT data_json FROM posts ORDER BY occurred_at, public_id').all()
    ) as { data_json: string }[];
    return rows.map((r) => JSON.parse(r.data_json) as Post);
  }

  upsertPost(post: Post, seq: number | null = null): void {
    const p = PostSchema.parse(post);
    this.db
      .prepare(
        `INSERT INTO posts (public_id, kind, occurred_at, local_date, visibility, data_json, updated_at, seq)
         VALUES (@publicId, @kind, @occurredAt, @localDate, @visibility, @data, @updatedAt, @seq)
         ON CONFLICT (public_id) DO UPDATE SET kind = excluded.kind, occurred_at = excluded.occurred_at,
           local_date = excluded.local_date, visibility = excluded.visibility, data_json = excluded.data_json,
           updated_at = excluded.updated_at, seq = excluded.seq`,
      )
      .run({
        publicId: p.publicId,
        kind: p.kind,
        occurredAt: new Date(p.occurredAt).toISOString(),
        localDate: p.localDate,
        visibility: p.visibility,
        data: JSON.stringify(p),
        updatedAt: p.updatedAt,
        seq,
      });
  }

  deletePost(publicId: string): boolean {
    return this.db.prepare('DELETE FROM posts WHERE public_id = ?').run(publicId).changes > 0;
  }

  // ----------------------------------------------------------------------------- annotations

  getAnnotation(sourceKey: string): Annotation | undefined {
    const r = this.db.prepare('SELECT data_json FROM annotations WHERE source_key = ?').get(sourceKey) as
      | { data_json: string }
      | undefined;
    return r ? (JSON.parse(r.data_json) as Annotation) : undefined;
  }

  /** All annotations keyed by sourceKey. */
  annotationMap(): Map<string, Annotation> {
    const rows = this.db.prepare('SELECT source_key, data_json FROM annotations').all() as {
      source_key: string;
      data_json: string;
    }[];
    return new Map(rows.map((r) => [r.source_key, JSON.parse(r.data_json) as Annotation]));
  }

  upsertAnnotation(annotation: Annotation, seq: number | null = null): void {
    const a = AnnotationSchema.parse(annotation);
    this.db
      .prepare(
        `INSERT INTO annotations (source_key, visibility, local_date_override, data_json, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_key) DO UPDATE SET visibility = excluded.visibility,
           local_date_override = excluded.local_date_override, data_json = excluded.data_json,
           updated_at = excluded.updated_at, seq = excluded.seq`,
      )
      .run(a.sourceKey, a.visibility ?? null, a.localDateOverride ?? null, JSON.stringify(a), a.updatedAt, seq);
  }

  deleteAnnotation(sourceKey: string): boolean {
    return this.db.prepare('DELETE FROM annotations WHERE source_key = ?').run(sourceKey).changes > 0;
  }

  // ----------------------------------------------------------------------------- days

  getDay(localDate: string): Day | undefined {
    const r = this.db.prepare('SELECT data_json FROM days WHERE local_date = ?').get(localDate) as
      | { data_json: string }
      | undefined;
    return r ? (JSON.parse(r.data_json) as Day) : undefined;
  }

  /** Time-zone fix of a day (Day.tz), or null. */
  dayTz(localDate: string): string | null {
    const r = this.db.prepare('SELECT tz FROM days WHERE local_date = ?').get(localDate) as
      | { tz: string | null }
      | undefined;
    return r?.tz ?? null;
  }

  listDays(): Day[] {
    return (this.db.prepare('SELECT data_json FROM days ORDER BY local_date').all() as { data_json: string }[]).map(
      (r) => JSON.parse(r.data_json) as Day,
    );
  }

  upsertDay(day: Day, seq: number | null = null): void {
    const d = DaySchema.parse(day);
    this.db
      .prepare(
        `INSERT INTO days (local_date, tz, data_json, updated_at, seq) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (local_date) DO UPDATE SET tz = excluded.tz, data_json = excluded.data_json,
           updated_at = excluded.updated_at, seq = excluded.seq`,
      )
      .run(d.localDate, d.tz ?? null, JSON.stringify(d), d.updatedAt, seq);
  }

  deleteDay(localDate: string): boolean {
    return this.db.prepare('DELETE FROM days WHERE local_date = ?').run(localDate).changes > 0;
  }

  // ----------------------------------------------------------------------------- trips

  getTrip(slug: string): Trip | undefined {
    const r = this.db.prepare('SELECT data_json FROM trips WHERE slug = ?').get(slug) as
      | { data_json: string }
      | undefined;
    return r ? (JSON.parse(r.data_json) as Trip) : undefined;
  }

  listTrips(): Trip[] {
    return (
      this.db.prepare('SELECT data_json FROM trips ORDER BY start_date, slug').all() as { data_json: string }[]
    ).map((r) => JSON.parse(r.data_json) as Trip);
  }

  /** Trip containing `date` (trip date ranges are the only source, contracts ./policy). */
  tripForDate(date: string): string | null {
    return tripForDate(date, this.listTrips());
  }

  upsertTrip(trip: Trip, seq: number | null = null): void {
    const t = TripSchema.parse(trip);
    this.db
      .prepare(
        `INSERT INTO trips (slug, start_date, end_date, data_json, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date,
           data_json = excluded.data_json, updated_at = excluded.updated_at, seq = excluded.seq`,
      )
      .run(t.slug, t.startDate, t.endDate, JSON.stringify(t), t.updatedAt, seq);
  }

  deleteTrip(slug: string): boolean {
    return this.db.prepare('DELETE FROM trips WHERE slug = ?').run(slug).changes > 0;
  }

  // ----------------------------------------------------------------------------- settings

  /** Mirrored settings merged over SETTINGS_DEFAULTS (never throws). */
  settings(): Settings {
    return withSettingsDefaults(this.rawSettings());
  }

  rawSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  }

  /** Validated write (throws on invalid values; the feed path validates before calling it). */
  setSetting<K extends SettingKey>(key: K, value: Settings[K], seq: number | null = null): void {
    const v = parseSettingValue(key, value);
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at, seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at,
           seq = excluded.seq`,
      )
      .run(key, JSON.stringify(v), this.now().toISOString(), seq);
  }

  deleteSetting(key: SettingKey): boolean {
    return this.db.prepare('DELETE FROM settings WHERE key = ?').run(key).changes > 0;
  }

  // ----------------------------------------------------------------------------- change feed

  /**
   * Applies one page of the change feed (validated item by item, see the file header) and stores
   * the new cursor, atomically. Throws only for a malformed envelope (transport problem: nothing
   * is changed, the caller retries).
   */
  applyChanges(response: unknown): ChangeSummary {
    const page = ChangesPage.parse(response);
    return this.db
      .transaction((): ChangeSummary => {
        const summary: ChangeSummary = {
          applied: 0,
          skipped: 0,
          ignored: 0,
          quarantined: 0,
          cursor: this.syncState.feedCursor(),
          localDates: [],
          trips: [],
          settingsChanged: false,
          reset: false,
          rebuilt: false,
        };
        const storedFeedId = this.syncState.feedId();
        if (storedFeedId !== undefined && storedFeedId !== page.feedId) {
          this.beginRebuild(page.feedId, `feed id changed (${storedFeedId} -> ${page.feedId})`);
          return { ...summary, cursor: 0, reset: true, settingsChanged: true };
        }
        if (storedFeedId === undefined) this.syncState.setFeedId(page.feedId);

        const cursor = summary.cursor;
        const dates = new Set<string>();
        const trips = new Set<string>();
        let maxSeq = cursor;
        for (const raw of page.items) {
          const parsed = parseChangeItem(raw);
          const seq = parsed.status === 'ok' ? parsed.item.seq : parsed.seq;
          if (seq !== null && seq <= cursor) {
            summary.skipped++;
            continue;
          }
          if (seq !== null) maxSeq = Math.max(maxSeq, seq);
          switch (parsed.status) {
            case 'ok':
              try {
                this.db.transaction(() =>
                  this.applyItem(parsed.item, dates, trips, () => {
                    summary.settingsChanged = true;
                  }),
                )();
                summary.applied++;
              } catch (err) {
                this.quarantine(page.feedId, raw, seq, parsed.item.entity, parsed.item.key, String(err));
                summary.quarantined++;
              }
              break;
            case 'unknown_entity':
            case 'unknown_key':
              summary.ignored++;
              if (parsed.entity) this.noteIgnored(parsed.entity, parsed.status === 'unknown_key' ? parsed.key : null);
              this.events?.append('feed.item_ignored', {
                seq,
                entity: parsed.entity,
                ...(parsed.status === 'unknown_key' ? { key: parsed.key } : {}),
              });
              break;
            case 'invalid':
              this.quarantine(page.feedId, raw, seq, parsed.entity, parsed.key, parsed.error);
              summary.quarantined++;
              break;
          }
        }
        for (const date of dates) {
          const trip = this.tripForDate(date);
          if (trip) trips.add(trip);
        }
        const next = Math.max(maxSeq, page.nextSeq, cursor);
        this.syncState.setFeedCursor(next);
        this.syncState.setCatchingUp(page.hasMore);
        if (!page.hasMore && this.syncState.rebuildPending()) {
          this.sweepUnconfirmed();
          summary.rebuilt = true;
          summary.settingsChanged = true;
        }
        return { ...summary, cursor: next, localDates: [...dates].sort(), trips: [...trips].sort() };
      })
      .immediate();
  }

  /** Remembers the kind of an ignored item (deduplicated, bounded). */
  private noteIgnored(entity: string, key: string | null): void {
    const list = this.syncState.getJson<IgnoredKind[]>(FEED_IGNORED_KEY) ?? [];
    if (list.some((i) => i.entity === entity && (i.key ?? null) === key)) return;
    if (list.length >= IGNORED_KINDS_MAX) return;
    list.push(key === null ? { entity } : { entity, key });
    this.syncState.setJson(FEED_IGNORED_KEY, list);
  }

  /**
   * Feed items an older version of this backend ignored (unknown entity or setting key) whose
   * kind this version knows: the cursor moved past them, so only a replay brings them in. Starts
   * a rebuild (replay from seq 0, rows kept until it completes) when there are any. Sources: the
   * remembered kinds, and the "feed.item_ignored" events (all a version before that wrote) not
   * looked at before. Call at startup, before the first pull. Returns the now-known kinds.
   */
  replayIgnoredIfKnown(): string[] {
    return this.db
      .transaction((): string[] => {
        const kinds = this.syncState.getJson<IgnoredKind[]>(FEED_IGNORED_KEY) ?? [];
        const seenEvents = Number(this.syncState.get(FEED_IGNORED_EVENTS_KEY) ?? 0);
        let lastEvent = seenEvents;
        for (const e of this.events?.recent({ type: 'feed.item_ignored', limit: 10_000 }) ?? []) {
          lastEvent = Math.max(lastEvent, e.id);
          if (e.id <= seenEvents) continue;
          const data = e.data as { entity?: unknown; key?: unknown } | null;
          if (typeof data?.entity !== 'string') continue;
          kinds.push(typeof data.key === 'string' ? { entity: data.entity, key: data.key } : { entity: data.entity });
        }
        if (lastEvent > seenEvents) this.syncState.set(FEED_IGNORED_EVENTS_KEY, String(lastEvent));
        const known = [...new Set(kinds.filter(isKnownKind).map((k) => k.key ?? k.entity))].sort();
        if (known.length === 0) return [];
        // The replay records again whatever is still unknown to this version.
        this.syncState.delete(FEED_IGNORED_KEY);
        if (this.syncState.feedCursor() === 0 && !this.syncState.rebuildPending()) return known; // nothing pulled yet
        this.beginRebuild(null, `feed items an older version ignored are known now: ${known.join(', ')}`);
        return known;
      })
      .immediate();
  }

  /**
   * Starts a mirror rebuild (feed id changed, or the API answered 409 "feed_reset"): cursor 0,
   * all rows unconfirmed but kept until the replay completes.
   */
  beginRebuild(feedId: string | null, reason: string): void {
    this.db
      .transaction(() => {
        for (const { table } of Object.values(MIRROR_TABLES)) this.db.prepare(`UPDATE ${table} SET seq = NULL`).run();
        this.syncState.setFeedCursor(0);
        if (feedId) this.syncState.setFeedId(feedId);
        this.syncState.setRebuildPending(true);
        // The rebuilt mirror must be complete again before anything is published (L2-02), and
        // until the replay reaches the end of the feed the mirror is a mix of old and new (L2-03).
        this.syncState.setOwnerSynced(null);
        this.syncState.setCatchingUp(true);
        this.events?.append('feed.rebuild_started', { feedId, reason });
      })
      .immediate();
  }

  private sweepUnconfirmed(): void {
    const removed: Record<string, number> = {};
    for (const [entity, { table }] of Object.entries(MIRROR_TABLES)) {
      removed[entity] = this.db.prepare(`DELETE FROM ${table} WHERE seq IS NULL`).run().changes;
    }
    this.syncState.setRebuildPending(false);
    this.events?.append('feed.rebuild_finished', { removed });
  }

  private quarantine(
    feedId: string,
    raw: unknown,
    seq: number | null,
    entity: string | null,
    key: string | null,
    error: string,
  ): void {
    const receivedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO feed_quarantine (feed_id, seq, entity, key, raw_json, error, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(feedId, seq, entity, key, JSON.stringify(raw) ?? 'null', error.slice(0, 4000), receivedAt);
    // Keep the last good value: during a rebuild it must not be swept as "unconfirmed".
    const target = entity && key ? MIRROR_TABLES[entity as ChangeEntity] : undefined;
    if (target && seq !== null) {
      this.db.prepare(`UPDATE ${target.table} SET seq = ? WHERE ${target.key} = ? AND seq IS NULL`).run(seq, key);
    }
    this.events?.append('feed.item_quarantined', { seq, entity, key, error: error.slice(0, 500) });
  }

  quarantined(limit = 50): QuarantinedItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, feed_id, seq, entity, key, raw_json, error, received_at FROM feed_quarantine
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      feed_id: string | null;
      seq: number | null;
      entity: string | null;
      key: string | null;
      raw_json: string;
      error: string;
      received_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      seq: r.seq,
      entity: r.entity,
      key: r.key,
      raw: JSON.parse(r.raw_json) as unknown,
      error: r.error,
      receivedAt: r.received_at,
    }));
  }

  quarantineCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM feed_quarantine').get() as { n: number }).n;
  }

  /** Deletes quarantined feed items received before `before`; returns the number deleted. */
  pruneQuarantine(before: Date): number {
    return this.db.prepare('DELETE FROM feed_quarantine WHERE received_at < ?').run(before.toISOString()).changes;
  }

  /** Effective local date of a stored item with the current day mirror (contracts ./policy). */
  private effectiveDate(
    item: { occurredAt: string; tz: string; localDate: string },
    annotation: Annotation | undefined,
  ): string {
    return effectiveLocalDate(item, annotation ?? null, this.dayTz(item.localDate));
  }

  private applyItem(item: ChangeItem, dates: Set<string>, trips: Set<string>, onSetting: () => void): void {
    switch (item.entity) {
      case 'post': {
        const old = this.getPost(item.key);
        if (old) dates.add(this.effectiveDate(old, undefined));
        if (item.op === 'delete') this.deletePost(item.key);
        else {
          this.upsertPost(item.data, item.seq);
          dates.add(this.effectiveDate(item.data, undefined));
        }
        return;
      }
      case 'annotation': {
        const old = this.getAnnotation(item.key);
        const capture = this.db
          .prepare('SELECT occurred_at AS occurredAt, tz, local_date AS localDate FROM captures WHERE source_key = ?')
          .get(item.key) as { occurredAt: string; tz: string; localDate: string } | undefined;
        if (capture) dates.add(this.effectiveDate(capture, old));
        else if (old?.localDateOverride) dates.add(old.localDateOverride);
        if (item.op === 'delete') this.deleteAnnotation(item.key);
        else {
          this.upsertAnnotation(item.data, item.seq);
          if (capture) dates.add(this.effectiveDate(capture, item.data));
          else if (item.data.localDateOverride) dates.add(item.data.localDateOverride);
        }
        return;
      }
      case 'day': {
        const oldTz = this.dayTz(item.key);
        dates.add(item.key);
        if (item.op === 'delete') this.deleteDay(item.key);
        else this.upsertDay(item.data, item.seq);
        const newTz = item.op === 'delete' ? null : (item.data.tz ?? null);
        if (oldTz !== newTz) {
          // A tz fix re-dates the day's items and may move them to the neighbouring days.
          dates.add(addDays(item.key, -1));
          dates.add(addDays(item.key, 1));
        }
        return;
      }
      case 'trip': {
        const old = this.getTrip(item.key);
        trips.add(item.key);
        const addRange = (t: Trip) => {
          for (const d of dateRange(t.startDate, t.endDate)) dates.add(d);
        };
        if (old) addRange(old);
        if (item.op === 'delete') this.deleteTrip(item.key);
        else {
          this.upsertTrip(item.data, item.seq);
          addRange(item.data);
        }
        return;
      }
      case 'setting': {
        onSetting();
        if (item.op === 'delete') this.deleteSetting(item.key);
        else this.setSetting(item.key, item.data.value as Settings[typeof item.key], item.seq);
        return;
      }
    }
  }
}
