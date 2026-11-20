/**
 * Captures repository (primary data of the backend).
 *
 * State machine:
 *   awaiting_media -> received          the helper reported the download ok (setDownloadResult)
 *   awaiting_media -> media_lost        permanent download failure (or Node gave up, see wa.ts)
 *   received -> archived -> processed -> ready
 *   received|awaiting_media|failed -> media_lost   (terminal: the original can no longer be had)
 *   recordFailure(…, nextAttemptAt) keeps the state and schedules a retry;
 *   recordFailure(…, null) gives up -> failed; retry() resumes from the furthest completed step.
 * Media kinds start in awaiting_media unless their download is already ok; text and
 * unsupported statuses start in received and may go to ready directly. A capture that reached
 * archived/processed/ready is never moved to failed or media_lost by late download results.
 *
 * Revokes may arrive before their status (separate inbox files, startup rescans): applyRevoke()
 * parks them in pending_revokes and insert() applies them in the same transaction.
 */
import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import { localDateFor, toIsoUtc } from '@omw/contracts/time';
import {
  type DownloadFailureReason,
  type DownloadState,
  type InboxMedia,
  type InboxMeta,
  type InboxSender,
  type InboxText,
  isMediaKind,
} from '@omw/contracts/wa';
import type { Db } from './db.js';
import {
  type CaptureRow,
  type CaptureState,
  type Clock,
  NewCapture,
  ProcessedMeta,
  ProcessedVariant,
} from './types.js';

interface RawCaptureRow {
  source_key: string;
  public_id: string;
  msg_id: string | null;
  source: string;
  kind: string;
  occurred_at: string;
  received_at: string | null;
  tz: string;
  local_date: string;
  caption: string | null;
  text_json: string | null;
  media_json: string | null;
  sender_json: string | null;
  state: string;
  download_state: string;
  download_reason: string | null;
  download_permanent: number | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  archive_path: string | null;
  original_sha256: string | null;
  variants_json: string | null;
  processed_meta_json: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

const parseJson = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));
const toJson = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

function mapRow(r: RawCaptureRow): CaptureRow {
  return {
    sourceKey: r.source_key,
    publicId: r.public_id,
    msgId: r.msg_id,
    source: r.source as CaptureRow['source'],
    kind: r.kind as CaptureRow['kind'],
    occurredAt: r.occurred_at,
    receivedAt: r.received_at,
    tz: r.tz,
    localDate: r.local_date,
    caption: r.caption,
    text: parseJson<InboxText>(r.text_json),
    media: parseJson<InboxMedia>(r.media_json),
    sender: parseJson<InboxSender>(r.sender_json),
    state: r.state as CaptureState,
    downloadState: r.download_state as DownloadState,
    downloadReason: r.download_reason as DownloadFailureReason | null,
    downloadPermanent: r.download_permanent === null ? null : r.download_permanent === 1,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    archivePath: r.archive_path,
    originalSha256: r.original_sha256,
    variants: parseJson<ProcessedVariant[]>(r.variants_json),
    processedMeta: parseJson<ProcessedMeta>(r.processed_meta_json),
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface CaptureListFilter {
  states?: readonly CaptureState[];
  /** Raw stored local date (not the effective one; see capturesForEffectiveDate in queries.ts). */
  localDate?: string;
  /** Inclusive range of raw stored local dates. */
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** States the media pipeline works on. */
const ACTIVE_STATES: readonly CaptureState[] = ['received', 'archived', 'processed'];
/** States in which no processing has happened yet (late download results may still apply). */
const PRE_ARCHIVE_STATES: readonly CaptureState[] = ['awaiting_media', 'received', 'failed'];

const sqlList = (states: readonly CaptureState[]) => states.map((s) => `'${s}'`).join(', ');

export interface DownloadResult {
  state: DownloadState;
  reason?: DownloadFailureReason | undefined;
  permanent?: boolean | undefined;
  error?: string | undefined;
  /** For a transient failure: when Node wants to look at it again (e.g. send `redownload`). */
  retryAt?: Date | string | undefined;
}

/** Initial pipeline state of a new capture from its download state. */
export function initialCaptureState(
  kind: CaptureRow['kind'],
  download: { state: DownloadState; permanent?: boolean | undefined },
): CaptureState {
  if (!isMediaKind(kind)) return 'received';
  if (download.state === 'ok') return 'received';
  if (download.state === 'failed' && download.permanent === true) return 'media_lost';
  return 'awaiting_media';
}

/**
 * Maps a (validated) inbox meta.json to a NewCapture. `tz` is the zone in effect when the
 * status was captured (mirrored setting "timezone.current", or DEFAULT_TIMEZONE without an API).
 */
export async function newCaptureFromInbox(meta: InboxMeta, tz: string): Promise<NewCapture> {
  const sourceKey = waSourceKey(meta.msgId);
  const { state, reason, permanent, error } = meta.download;
  return {
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    msgId: meta.msgId,
    source: meta.source,
    kind: meta.kind,
    occurredAt: meta.timestamp,
    receivedAt: meta.receivedAt,
    tz,
    caption: meta.caption ?? null,
    text: meta.text ?? null,
    media: meta.media ?? null,
    sender: meta.sender,
    download: {
      state,
      ...(reason !== undefined ? { reason } : {}),
      ...(permanent !== undefined ? { permanent } : {}),
      ...(error !== undefined ? { error } : {}),
    },
  };
}

export class CaptureRepo {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /**
   * Inserts a new capture; an existing sourceKey is left untouched (idempotent). A revoke parked
   * for its msgId is applied in the same transaction.
   */
  insert(input: NewCapture): { inserted: boolean; row: CaptureRow } {
    const c = NewCapture.parse(input);
    const occurredAt = toIsoUtc(c.occurredAt);
    const localDate = c.localDate ?? localDateFor(occurredAt, c.tz);
    const download = c.download ?? { state: isMediaKind(c.kind) ? 'ok' : 'not_applicable' };
    const state = initialCaptureState(c.kind, download);
    const now = this.iso();
    return this.db
      .transaction(() => {
        const result = this.db
          .prepare(
            `INSERT INTO captures (source_key, public_id, msg_id, source, kind, occurred_at, received_at, tz,
               local_date, caption, text_json, media_json, sender_json, state, download_state, download_reason,
               download_permanent, last_error, created_at, updated_at)
             VALUES (@sourceKey, @publicId, @msgId, @source, @kind, @occurredAt, @receivedAt, @tz,
               @localDate, @caption, @text, @media, @sender, @state, @downloadState, @downloadReason,
               @downloadPermanent, @lastError, @now, @now)
             ON CONFLICT (source_key) DO NOTHING`,
          )
          .run({
            sourceKey: c.sourceKey,
            publicId: c.publicId,
            msgId: c.msgId,
            source: c.source,
            kind: c.kind,
            occurredAt,
            receivedAt: c.receivedAt ? toIsoUtc(c.receivedAt) : null,
            tz: c.tz,
            localDate,
            caption: c.caption ?? null,
            text: toJson(c.text),
            media: toJson(c.media),
            sender: toJson(c.sender),
            state,
            downloadState: download.state,
            downloadReason: download.reason ?? null,
            downloadPermanent: download.permanent === undefined ? null : download.permanent ? 1 : 0,
            lastError: download.error ?? null,
            now,
          });
        if (result.changes > 0 && c.msgId) {
          const pending = this.db.prepare('SELECT at FROM pending_revokes WHERE msg_id = ?').get(c.msgId) as
            | { at: string }
            | undefined;
          if (pending) {
            this.db.prepare('UPDATE captures SET revoked_at = ? WHERE source_key = ?').run(pending.at, c.sourceKey);
            this.db.prepare('DELETE FROM pending_revokes WHERE msg_id = ?').run(c.msgId);
          }
        }
        const row = this.get(c.sourceKey);
        if (!row) throw new Error(`Capture ${c.sourceKey} missing after insert`);
        return { inserted: result.changes > 0, row };
      })
      .immediate();
  }

  /** Refreshes WhatsApp metadata (e.g. after a re-download updated meta.json). */
  updateWaMetadata(
    sourceKey: string,
    data: { caption?: string | null; text?: InboxText | null; media?: InboxMedia | null; sender?: InboxSender | null },
  ): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { sourceKey, now: this.iso() };
    if (data.caption !== undefined) {
      sets.push('caption = @caption');
      params.caption = data.caption;
    }
    if (data.text !== undefined) {
      sets.push('text_json = @text');
      params.text = toJson(data.text);
    }
    if (data.media !== undefined) {
      sets.push('media_json = @media');
      params.media = toJson(data.media);
    }
    if (data.sender !== undefined) {
      sets.push('sender_json = @sender');
      params.sender = toJson(data.sender);
    }
    if (sets.length === 0) return false;
    return (
      this.db
        .prepare(`UPDATE captures SET ${sets.join(', ')}, updated_at = @now WHERE source_key = @sourceKey`)
        .run(params).changes > 0
    );
  }

  /**
   * Applies a download result reported by the helper (media event / meta.json rewrite):
   * - ok: awaiting_media -> received (download_state ok)
   * - failed + permanent: awaiting_media|failed -> media_lost
   * - failed (transient), pending, retrying: only while awaiting_media; a transient failure
   *   counts an attempt and schedules `retryAt`
   * Results for captures that are received (original present) or further are ignored (returns
   * false) unless they confirm the download, so a late or failing `redownload` can never
   * unpublish a processed capture.
   */
  setDownloadResult(sourceKey: string, result: DownloadResult): boolean {
    const params = {
      sourceKey,
      now: this.iso(),
      downloadState: result.state,
      reason: result.reason ?? null,
      permanent: result.permanent === undefined ? null : result.permanent ? 1 : 0,
      error: result.error ?? null,
      inc: result.state === 'failed' ? 1 : 0,
      retryAt: result.retryAt === undefined ? null : toIsoUtc(result.retryAt),
    };
    const set =
      'download_state = @downloadState, download_reason = @reason, download_permanent = @permanent, updated_at = @now';
    const media = "kind IN ('photo', 'video', 'gif', 'voice')";
    let sql: string;
    if (result.state === 'ok') {
      sql = `UPDATE captures SET ${set}, state = CASE WHEN state = 'awaiting_media' THEN 'received' ELSE state END,
               attempts = 0, next_attempt_at = NULL, last_error = NULL
             WHERE source_key = @sourceKey AND ${media} AND state IN ('awaiting_media', 'received', 'failed')`;
    } else if (result.state === 'failed' && result.permanent === true) {
      // Not from "received": its original is already in the inbox.
      sql = `UPDATE captures SET ${set}, state = 'media_lost', next_attempt_at = NULL,
               last_error = COALESCE(@error, 'media lost')
             WHERE source_key = @sourceKey AND ${media} AND state IN ('awaiting_media', 'failed')`;
    } else {
      sql = `UPDATE captures SET ${set}, attempts = attempts + @inc, next_attempt_at = @retryAt,
               last_error = COALESCE(@error, last_error)
             WHERE source_key = @sourceKey AND ${media} AND state = 'awaiting_media'`;
    }
    return this.db.prepare(sql).run(params).changes > 0;
  }

  get(sourceKey: string): CaptureRow | undefined {
    const r = this.db.prepare('SELECT * FROM captures WHERE source_key = ?').get(sourceKey) as
      | RawCaptureRow
      | undefined;
    return r ? mapRow(r) : undefined;
  }

  getByPublicId(publicId: string): CaptureRow | undefined {
    const r = this.db.prepare('SELECT * FROM captures WHERE public_id = ?').get(publicId) as RawCaptureRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  getByMsgId(msgId: string): CaptureRow | undefined {
    const r = this.db.prepare('SELECT * FROM captures WHERE msg_id = ?').get(msgId) as RawCaptureRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Chronological list (occurred_at ascending), filtered by RAW stored local dates. */
  list(filter: CaptureListFilter = {}): CaptureRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.localDate) {
      where.push('local_date = ?');
      params.push(filter.localDate);
    }
    if (filter.fromDate) {
      where.push('local_date >= ?');
      params.push(filter.fromDate);
    }
    if (filter.toDate) {
      where.push('local_date <= ?');
      params.push(filter.toDate);
    }
    let sql = 'SELECT * FROM captures';
    if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY occurred_at, source_key';
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return (this.db.prepare(sql).all(...params) as RawCaptureRow[]).map(mapRow);
  }

  /**
   * Generator candidates for effective local date `date`: ready, renderable captures whose raw
   * local date is date±1 without an override (a Day.tz fix can move them by one day), plus
   * captures overridden onto `date`. queries.ts narrows them with the policy.
   */
  effectiveDateCandidates(date: string, range: { from: string; to: string }): CaptureRow[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM captures c LEFT JOIN annotations a ON a.source_key = c.source_key
           WHERE c.state = 'ready' AND c.kind <> 'unsupported'
             AND ((a.local_date_override IS NULL AND c.local_date BETWEEN @from AND @to)
                  OR a.local_date_override = @date)
           ORDER BY c.occurred_at, c.source_key`,
        )
        .all({ date, from: range.from, to: range.to }) as RawCaptureRow[]
    ).map(mapRow);
  }

  /** Captures the pipeline should work on now (received/archived/processed, retry due). */
  listDue(limit = 50): CaptureRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM captures
         WHERE state IN (${ACTIVE_STATES.map(() => '?').join(', ')})
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY occurred_at, source_key
         LIMIT ?`,
      )
      .all(...ACTIVE_STATES, this.iso(), limit) as RawCaptureRow[];
    return rows.map(mapRow);
  }

  /** Media captures still waiting for the helper (oldest first), e.g. to send `redownload` or give up. */
  listAwaitingMedia(limit = 100): CaptureRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM captures WHERE state = 'awaiting_media' ORDER BY received_at, source_key LIMIT ?`)
        .all(limit) as RawCaptureRow[]
    ).map(mapRow);
  }

  private transition(
    sourceKey: string,
    set: string,
    params: Record<string, unknown>,
    from: readonly CaptureState[],
    extraWhere = '',
  ) {
    return (
      this.db
        .prepare(
          `UPDATE captures SET ${set}, attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = @now
           WHERE source_key = @sourceKey AND state IN (${sqlList(from)})${extraWhere}`,
        )
        .run({ ...params, sourceKey, now: this.iso() }).changes > 0
    );
  }

  /** Refuses media captures whose original has not been downloaded (download_state <> ok). */
  markArchived(sourceKey: string, data: { archivePath: string; originalSha256: string | null }): boolean {
    return this.transition(
      sourceKey,
      "state = 'archived', archive_path = @archivePath, original_sha256 = @originalSha256",
      { archivePath: data.archivePath, originalSha256: data.originalSha256 },
      ['received', 'archived', 'failed'],
      " AND (kind NOT IN ('photo', 'video', 'gif', 'voice') OR download_state = 'ok')",
    );
  }

  markProcessed(sourceKey: string, data: { variants: ProcessedVariant[]; processedMeta: ProcessedMeta }): boolean {
    const variants = ProcessedVariant.array().parse(data.variants);
    const meta = ProcessedMeta.parse(data.processedMeta);
    return this.transition(
      sourceKey,
      "state = 'processed', variants_json = @variants, processed_meta_json = @meta",
      { variants: JSON.stringify(variants), meta: JSON.stringify(meta) },
      ['received', 'archived', 'processed', 'failed', 'ready'],
    );
  }

  markReady(sourceKey: string): boolean {
    return this.transition(sourceKey, "state = 'ready'", {}, ['received', 'archived', 'processed', 'failed']);
  }

  /** Terminal; only before archiving (a processed/published capture keeps its variants). */
  markMediaLost(sourceKey: string, error: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE captures SET state = 'media_lost', last_error = ?, next_attempt_at = NULL, updated_at = ?
           WHERE source_key = ? AND state IN (${sqlList(PRE_ARCHIVE_STATES)})`,
        )
        .run(error, this.iso(), sourceKey).changes > 0
    );
  }

  /**
   * Counts a pipeline attempt (received/archived/processed only). With nextAttemptAt the state
   * stays and a retry is scheduled; with null -> failed.
   */
  recordFailure(sourceKey: string, error: string, nextAttemptAt: Date | string | null): boolean {
    const next = nextAttemptAt === null ? null : toIsoUtc(nextAttemptAt);
    return (
      this.db
        .prepare(
          `UPDATE captures
           SET attempts = attempts + 1, last_error = @error, next_attempt_at = @next,
               state = CASE WHEN @next IS NULL THEN 'failed' ELSE state END, updated_at = @now
           WHERE source_key = @sourceKey AND state IN (${sqlList(ACTIVE_STATES)})`,
        )
        .run({ sourceKey, error, next, now: this.iso() }).changes > 0
    );
  }

  /** Resumes a failed/media_lost capture from the furthest completed step. */
  retry(sourceKey: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE captures
           SET state = CASE WHEN variants_json IS NOT NULL THEN 'processed'
                            WHEN archive_path IS NOT NULL THEN 'archived'
                            WHEN kind IN ('photo', 'video', 'gif', 'voice') AND download_state <> 'ok'
                              THEN 'awaiting_media'
                            ELSE 'received' END,
               attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ?
           WHERE source_key = ? AND state IN ('failed', 'media_lost')`,
        )
        .run(this.iso(), sourceKey).changes > 0
    );
  }

  /** Sets (or clears with null) the revoke timestamp of an existing capture. */
  setRevoked(sourceKey: string, at: Date | string | null): boolean {
    return (
      this.db
        .prepare('UPDATE captures SET revoked_at = ?, updated_at = ? WHERE source_key = ?')
        .run(at === null ? null : toIsoUtc(at), this.iso(), sourceKey).changes > 0
    );
  }

  /**
   * Applies a RevokeRecord (msgId = the revoked status). If the status is not in the store yet,
   * the revoke is parked and applied by insert(). Returns "applied" or "pending".
   */
  applyRevoke(msgId: string, at: Date | string): 'applied' | 'pending' {
    const iso = toIsoUtc(at);
    const sourceKey = waSourceKey(msgId);
    return this.db
      .transaction(() => {
        if (this.setRevoked(sourceKey, iso)) return 'applied' as const;
        this.db
          .prepare(
            `INSERT INTO pending_revokes (msg_id, at, received_at) VALUES (?, ?, ?)
             ON CONFLICT (msg_id) DO UPDATE SET at = MIN(at, excluded.at)`,
          )
          .run(msgId, iso, this.iso());
        return 'pending' as const;
      })
      .immediate();
  }

  pendingRevokes(): { msgId: string; at: string }[] {
    return this.db.prepare('SELECT msg_id AS msgId, at FROM pending_revokes ORDER BY msg_id').all() as {
      msgId: string;
      at: string;
    }[];
  }

  /** Changes the time zone and recomputes local_date. */
  setTimezone(sourceKey: string, tz: string): boolean {
    const row = this.get(sourceKey);
    if (!row) return false;
    const localDate = localDateFor(row.occurredAt, tz);
    return (
      this.db
        .prepare('UPDATE captures SET tz = ?, local_date = ?, updated_at = ? WHERE source_key = ?')
        .run(tz, localDate, this.iso(), sourceKey).changes > 0
    );
  }

  /**
   * RAW stored local dates with capture counts (all states and kinds), ascending. Not what the
   * site shows: the generator uses capturesForEffectiveDate() (queries.ts) instead.
   */
  rawLocalDates(): { localDate: string; count: number }[] {
    return this.db
      .prepare(
        'SELECT local_date AS localDate, COUNT(*) AS count FROM captures GROUP BY local_date ORDER BY local_date',
      )
      .all() as { localDate: string; count: number }[];
  }

  /** Number of captures in any state. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM captures').get() as { n: number }).n;
  }

  countByState(): Record<CaptureState, number> {
    const out: Record<CaptureState, number> = {
      awaiting_media: 0,
      received: 0,
      archived: 0,
      processed: 0,
      ready: 0,
      failed: 0,
      media_lost: 0,
    };
    const rows = this.db.prepare('SELECT state, COUNT(*) AS n FROM captures GROUP BY state').all() as {
      state: CaptureState;
      n: number;
    }[];
    for (const r of rows) out[r.state] = r.n;
    return out;
  }
}
