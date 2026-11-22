/**
 * The Mac fallback writer of the session-file store and the control UI's lock button
 * (spec-wave5 §3.8.4, §5.6.6).
 *
 * When the change feed says `access.needsWriter` (ACCESS_STORE_MODE=none, or the API's own writer
 * is failing or behind) and a store target exists (a publish target with accessStoreRoot /
 * accessStoreDir; store-only targets with publish: false are preferred), one run:
 *
 *   1. claim (POST /backend/access/claim): the lease (60 s) and ≤ 200 pending ops in id order;
 *   2. listingWanted → list the store and upload it (POST /backend/access/listing), which returns
 *      the reconcile ops (and extends the lease);
 *   3. read the marker over the Mac's own connection and REFUSE (ack with failed: store_mismatch,
 *      nothing applied) unless it carries the claimed storeId and epoch. Exceptions: while there is
 *      no marker, a claimed `init` op runs first (it creates the marker exclusively; no listing in
 *      that run, the API asks for none while init is pending), then the other ops in id order; and
 *      the epoch may differ for the one reconcile after an API restore (same storeId, listing
 *      uploaded in this run);
 *   4. apply the ops in order; before each, when lease.until − 10 s has passed, renew
 *      (POST /backend/access/renew) or stop at once when the lease is lost; every SFTP operation
 *      has a 5 s deadline; the first failure stops the run (order matters);
 *   5. rewrite the marker ({format, storeId, epoch, op, at}) and ack (POST /backend/access/ack).
 *
 * Like the API's applier: `init` also writes the store's deny-all `.htaccess` (harmless outside a
 * docroot, required for a store inside one, F3), a run that uploads a listing re-checks its bytes,
 * and a person tombstone `revoked` is upgraded to `deleted` (atomic replace, never back), so a
 * person revoked first and deleted later is erased again after an API restore (§3.8.6).
 *
 * One run at a time, at most every 15 s (the pull interval). An SSH authentication failure blocks
 * the store target like a publish target: no further login until the target is saved again.
 *
 * lockSite() (the "Website sperren" button): reads the marker (it must exist; the storeId of the
 * last claim is compared when known), then writes `locked` {"at","by":"mac"} exclusively, and
 * reports "locked" only after that. It needs neither the API nor PHP; only the admin unlocks.
 */
import {
  type AccessClaim,
  isValidStoreOpPath,
  STORE_HTACCESS,
  STORE_PATHS,
  StoreMarker,
  type StoreOp,
  StoreTombstone,
  storePathKind,
} from '@omw/contracts/access';
import type { Logger } from '../log.js';
import { destinationKey } from '../publisher/targets.js';
import { PublishError, type StoredTarget } from '../publisher/types.js';
import type { Store } from '../store/index.js';
import { type ApiClient, ApiRequestError } from '../sync/client.js';
import { redact, type StoreRemote } from './store-remote.js';

/** Margin before lease.until at which the writer renews (or stops). */
export const LEASE_MARGIN_MS = 10_000;
export const FALLBACK_MIN_INTERVAL_MS = 15_000;

/** The target the fallback writer and the lock button use, or null. */
export function storeTargetOf(targets: readonly StoredTarget[]): StoredTarget | null {
  const withStore = targets.filter(
    (t) => t.enabled && (t.kind === 'sftp' ? Boolean(t.accessStoreRoot) : Boolean(t.accessStoreDir)),
  );
  return withStore.find((t) => t.publish === false) ?? withStore[0] ?? null;
}

/** The state of a person tombstone's content ("revoked" | "deleted"), or null when unreadable. */
function tombstoneState(content: string | null): StoreTombstone['s'] | null {
  if (content === null) return null;
  try {
    const parsed = StoreTombstone.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data.s : null;
  } catch {
    return null;
  }
}

export interface FallbackDeps {
  log: Logger;
  store: Store;
  /** The API client (null without an API or while API traffic is paused after 401/403). */
  client: () => ApiClient | null;
  /** The publish targets (the store target is picked from them). */
  targets: () => readonly StoredTarget[];
  /** Opens the store of a target (StoreRemote over connectSftp or a local folder). */
  openStore: (target: StoredTarget) => Promise<StoreRemote>;
  now?: () => Date;
}

export type FallbackOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'no_lease' }
  | { status: 'refused'; reason: string }
  | { status: 'lease_lost'; applied: number }
  | { status: 'failed'; applied: number; opId: number; error: string }
  | { status: 'applied'; applied: number; through: number };

const BLOCK_KEY = (id: string) => `access.writer.blocked.${id}`;
const STORE_ID_KEY = 'access.store_id';

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export class AccessFallback {
  private readonly deps: FallbackDeps;
  private readonly now: () => Date;
  private running: Promise<FallbackOutcome> | null = null;
  private lastRunAt = 0;
  private needsWriter = false;
  /** The last outcome (control UI). */
  last: (FallbackOutcome & { at: string }) | null = null;

  constructor(deps: FallbackDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** The storeId of the last claim (the lock button compares the marker with it). */
  knownStoreId(): string | null {
    return this.deps.store.meta.get(STORE_ID_KEY) ?? null;
  }

  /** From the change feed (sync onAccess): runs the writer when the API asks for it. */
  noteNeedsWriter(needsWriter: boolean): void {
    this.needsWriter = needsWriter;
    if (needsWriter) void this.run().catch((err: unknown) => this.deps.log.error({ err }, 'access writer failed'));
  }

  /** The store target's login is blocked after an authentication failure (until it is saved again). */
  blocked(target: StoredTarget): { at: string; message: string } | null {
    const raw = this.deps.store.meta.get(BLOCK_KEY(target.id));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { dest?: string; updatedAt?: string; at: string; message: string };
      if (v.dest !== destinationKey(target) || v.updatedAt !== target.updatedAt) return null;
      return { at: v.at, message: v.message };
    } catch {
      return null;
    }
  }

  private block(target: StoredTarget, message: string): void {
    this.deps.store.meta.set(
      BLOCK_KEY(target.id),
      JSON.stringify({
        dest: destinationKey(target),
        updatedAt: target.updatedAt,
        at: this.now().toISOString(),
        message,
      }),
    );
  }

  /** One run (see the module header); concurrent calls share it, and runs are ≥ 15 s apart. */
  run(opts: { force?: boolean } = {}): Promise<FallbackOutcome> {
    if (this.running) return this.running;
    const t = this.now().getTime();
    if (!opts.force && t - this.lastRunAt < FALLBACK_MIN_INTERVAL_MS) {
      return Promise.resolve({ status: 'skipped', reason: 'ran less than 15 s ago' });
    }
    this.lastRunAt = t;
    const p = this.runOnce()
      .then((outcome) => {
        this.last = { ...outcome, at: this.now().toISOString() };
        return outcome;
      })
      .finally(() => {
        this.running = null;
      });
    this.running = p;
    return p;
  }

  private async runOnce(): Promise<FallbackOutcome> {
    const { log } = this.deps;
    const client = this.deps.client();
    if (!client) return { status: 'skipped', reason: 'no API (or API traffic paused)' };
    const target = storeTargetOf(this.deps.targets());
    if (!target) return { status: 'skipped', reason: 'no store target (accessStoreRoot/accessStoreDir)' };
    const blocked = this.blocked(target);
    if (blocked) return { status: 'skipped', reason: `store login blocked since ${blocked.at}` };

    let claim: AccessClaim = await client.claim({ holder: 'mac' });
    if (!claim.lease) return { status: 'no_lease' };
    const epoch = claim.epoch;
    let leaseUntil = Date.parse(claim.lease.until);
    if (claim.storeId) this.deps.store.meta.set(STORE_ID_KEY, claim.storeId);

    let store: StoreRemote;
    try {
      store = await this.deps.openStore(target);
    } catch (err) {
      if (err instanceof PublishError && err.code === 'auth') {
        this.block(target, err.message);
        log.error({ target: target.id }, 'access writer: store login failed; blocked until the target is saved again');
      }
      // Release the lease without applying anything (the API retries or applies itself).
      await this.ackQuietly(client, { epoch, appliedThrough: 0 });
      return { status: 'refused', reason: `cannot open the store: ${errorText(err)}` };
    }
    try {
      // The marker is checked BEFORE a listing is uploaded: a listing of a folder that is not the
      // initialised store must never reach the reconciler (when in doubt, refuse).
      const rawMarker = await store.read(STORE_PATHS.marker);
      // No marker yet: a claimed init op creates it first (never together with a listing).
      const initOp = rawMarker === null ? (claim.ops.find((o) => o.op === 'init') ?? null) : null;
      const listingWanted = claim.listingWanted && !initOp;
      const refusal = this.markerRefusal(rawMarker, claim, listingWanted);
      if (refusal) {
        const first = claim.ops[0];
        log.error({ target: target.id, reason: refusal }, 'access writer: store refused (marker)');
        await this.ackQuietly(client, {
          epoch,
          appliedThrough: 0,
          ...(first ? { failed: { opId: first.id, error: 'store_mismatch' } } : {}),
        });
        return { status: 'refused', reason: refusal };
      }
      if (listingWanted) {
        await this.checkHtaccess(store);
        const listing = await store.listing();
        claim = await client.uploadListing({ epoch, listing });
        if (!claim.lease) return { status: 'lease_lost', applied: 0 };
        leaseUntil = Date.parse(claim.lease.until);
      }
      const ops = claim.ops.slice(0, 200);
      let through = 0;
      let applied = 0;
      let initMarker: string | null = null;
      if (initOp) {
        try {
          initMarker = await this.apply(store, initOp);
        } catch (err) {
          const error = errorText(err);
          log.error({ opId: initOp.id, op: initOp.op, error }, 'access writer: op failed');
          await this.ackQuietly(client, { epoch, appliedThrough: 0, failed: { opId: initOp.id, error } });
          return { status: 'failed', applied, opId: initOp.id, error };
        }
      }
      for (const op of ops) {
        if (op === initOp) {
          // Applied first (above); it counts in id order for appliedThrough.
          through = op.id;
          applied++;
          continue;
        }
        if (this.now().getTime() >= leaseUntil - LEASE_MARGIN_MS) {
          const renewed = await client.renew({ epoch });
          if (!renewed.lease) {
            log.warn({ applied }, 'access writer: lease lost; stopping');
            return { status: 'lease_lost', applied };
          }
          leaseUntil = Date.parse(renewed.lease.until);
        }
        try {
          const marker = await this.apply(store, op);
          if (marker) initMarker = marker;
        } catch (err) {
          const error = errorText(err);
          log.error({ opId: op.id, op: op.op, path: redact(op.path), error }, 'access writer: op failed');
          await this.ackQuietly(client, { epoch, appliedThrough: through, failed: { opId: op.id, error } });
          return { status: 'failed', applied, opId: op.id, error };
        }
        through = op.id;
        applied++;
      }
      const storeId = claim.storeId ?? storeIdOf(initMarker);
      if (applied > 0 && storeId) {
        const marker: StoreMarker = { format: 1, storeId, epoch, op: through, at: this.now().toISOString() };
        await store.replace(STORE_PATHS.marker, `${JSON.stringify(marker)}\n`);
      }
      await client.ack({ epoch, appliedThrough: through });
      if (applied > 0) log.info({ applied, through }, 'access writer: store ops applied');
      return { status: 'applied', applied, through };
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409) return { status: 'lease_lost', applied: 0 };
      throw err;
    } finally {
      await store.close();
    }
  }

  /** Why the store may not be written (§3.8.4), or null. `raw` = the marker's content (null = none). */
  private markerRefusal(raw: string | null, claim: AccessClaim, listed: boolean): string | null {
    const first = claim.ops[0];
    if (raw === null) {
      if (claim.ops.some((o) => o.op === 'init') && !listed) return null;
      return claim.ops.length === 0 && !listed
        ? null
        : 'store marker missing: the store path does not point to the initialised store';
    }
    let marker: StoreMarker;
    try {
      marker = StoreMarker.parse(JSON.parse(raw));
    } catch {
      return 'store marker unreadable';
    }
    if (!claim.storeId) return first?.op === 'init' ? 'a store marker exists already' : 'the API has no store id yet';
    if (marker.storeId !== claim.storeId) return 'the store marker belongs to another store (storeId differs)';
    // The one reconcile after an API restore runs against the marker's old epoch (§3.8.6).
    if (marker.epoch !== claim.epoch && !listed) return 'the store marker has another epoch';
    return null;
  }

  /** Applies one op; returns the marker content for an `init`. */
  private async apply(store: StoreRemote, op: StoreOp): Promise<string | null> {
    if (!isValidStoreOpPath(op.op, op.path, op.exclusive)) throw new Error(`invalid store op path for ${op.op}`);
    switch (op.op) {
      case 'init': {
        const content = op.content ?? '';
        StoreMarker.parse(JSON.parse(content));
        await store.put(STORE_PATHS.marker, content, true);
        await store.put(STORE_PATHS.htaccess, STORE_HTACCESS, true);
        return content;
      }
      case 'put': {
        const content = op.content ?? '';
        if (op.path === STORE_PATHS.marker) {
          await store.replace(op.path, content);
          return null;
        }
        const created = await store.put(op.path, content, op.exclusive);
        if (
          !created &&
          storePathKind(op.path) === 'personTombstone' &&
          tombstoneState(content) === 'deleted' &&
          tombstoneState(await store.read(op.path)) !== 'deleted'
        ) {
          // Revoked first, deleted later: "revoked" → "deleted" (never back).
          await store.replace(op.path, content);
        }
        return null;
      }
      case 'delete':
        await store.delete(op.path);
        return null;
      case 'delete_prefix': {
        const slash = op.path.lastIndexOf('/');
        await store.deletePrefix(op.path.slice(0, slash), op.path.slice(slash + 1));
        return null;
      }
      case 'delete_tree':
        await store.deleteTree(op.path);
        return null;
    }
  }

  /** Rewrites the store's `.htaccess` when its bytes differ (a failure is only logged, like the API). */
  private async checkHtaccess(store: StoreRemote): Promise<void> {
    try {
      if ((await store.read(STORE_PATHS.htaccess)) !== STORE_HTACCESS) {
        await store.replace(STORE_PATHS.htaccess, STORE_HTACCESS);
      }
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'access writer: store .htaccess check failed');
    }
  }

  private async ackQuietly(client: ApiClient, body: Parameters<ApiClient['ack']>[0]): Promise<void> {
    try {
      await client.ack(body);
    } catch (err) {
      this.deps.log.warn({ err: errorText(err) }, 'access writer: ack failed (the API re-applies from its own state)');
    }
  }

  /**
   * The lock button: writes `locked` {"at","by":"mac"} exclusively after finding the store marker.
   * "locked" only when the file exists afterwards.
   */
  async lockSite(): Promise<{ ok: true; already: boolean } | { ok: false; error: string }> {
    const target = storeTargetOf(this.deps.targets());
    if (!target) return { ok: false, error: 'Kein Website-Speicher eingerichtet (Ziel mit Speicherpfad fehlt)' };
    const blocked = this.blocked(target);
    if (blocked) return { ok: false, error: `Anmeldung gesperrt seit ${blocked.at}: Ziel neu speichern` };
    let store: StoreRemote;
    try {
      store = await this.deps.openStore(target);
    } catch (err) {
      if (err instanceof PublishError && err.code === 'auth') this.block(target, err.message);
      return { ok: false, error: `Verbindung fehlgeschlagen: ${errorText(err)}` };
    }
    try {
      const raw = await store.read(STORE_PATHS.marker);
      if (raw === null) return { ok: false, error: 'Website-Speicher nicht gefunden – Pfad prüfen' };
      let marker: StoreMarker;
      try {
        marker = StoreMarker.parse(JSON.parse(raw));
      } catch {
        return { ok: false, error: 'Website-Speicher nicht lesbar – Pfad prüfen' };
      }
      const known = this.knownStoreId();
      if (known && marker.storeId !== known) {
        return { ok: false, error: 'Falscher Website-Speicher (andere Speicher-ID) – Pfad prüfen' };
      }
      const body = `${JSON.stringify({ at: this.now().toISOString(), by: 'mac' })}\n`;
      const created = await store.put(STORE_PATHS.locked, body, true);
      if (!(await store.exists(STORE_PATHS.locked)))
        return { ok: false, error: 'Sperre konnte nicht geschrieben werden' };
      this.deps.log.warn({ target: target.id, already: !created }, 'site locked from the control UI');
      return { ok: true, already: !created };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    } finally {
      await store.close();
    }
  }

  get pending(): boolean {
    return this.needsWriter;
  }
}

function storeIdOf(marker: string | null): string | null {
  if (!marker) return null;
  try {
    return StoreMarker.parse(JSON.parse(marker)).storeId;
  } catch {
    return null;
  }
}
