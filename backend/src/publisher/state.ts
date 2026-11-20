/**
 * Per-target deploy bookkeeping in the store's meta table (no schema migration needed):
 *
 *   publisher.target.<id>  TargetState (JSON)
 *   publisher.lock.<id>    DeployLock (JSON): one deploy per target across processes
 *
 * The deployed file list itself lives in store.deploys (deploy_manifest table): it is updated
 * after every single upload/delete, so it is exact up to the files in flight when a process dies;
 * those are listed in `pending` and treated as uncertain by the next deploy.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import type { Store } from '../store/index.js';
import type { DeployResult } from './types.js';

const PendingOps = z.object({
  startedAt: z.string(),
  /** Paths being uploaded. Uncertain unless store.deploys has them with deployedAt >= startedAt. */
  uploads: z.array(z.string()),
  /** Paths being deleted that were in store.deploys. Uncertain while still there. */
  deletes: z.array(z.string()),
  /** Paths being deleted that store.deploys did not know (leftovers): always uncertain. */
  probes: z.array(z.string()),
});
export type PendingOps = z.infer<typeof PendingOps>;

const TargetState = z.object({
  /** destinationKey() the state belongs to; a different key means "unknown". */
  dest: z.string(),
  /** store.deploys reflects the target (else recover from the remote record). */
  known: z.boolean(),
  version: z.int().nullable(),
  deployedAt: z.string().nullable(),
  obsoleteSince: z.record(z.string(), z.string()),
  pending: PendingOps.nullable(),
  authBlocked: z.object({ at: z.string(), message: z.string() }).nullable(),
  last: z.unknown().nullable(),
  /** recordContentHash() of the deploy record last written to the target (skip identical uploads). */
  recordHash: z.string().nullable().optional(),
  /** The legacy uncompressed /.omw-deploy.json is gone from the target. */
  legacyRecordGone: z.boolean().optional(),
});
export type TargetState = z.infer<typeof TargetState>;

export function emptyState(dest: string): TargetState {
  return {
    dest,
    known: false,
    version: null,
    deployedAt: null,
    obsoleteSince: {},
    pending: null,
    authBlocked: null,
    last: null,
  };
}

/**
 * Identifies this process incarnation. In Docker a restarted container usually gets the SAME pid
 * (tini = 1, node = its first child) and the same hostname, so "same host + same pid" does not mean
 * "this process": a lock left behind by a killed predecessor carries a different instance id.
 */
const PROCESS_INSTANCE = randomUUID();

const stateKey = (id: string) => `publisher.target.${id}`;
const lockKey = (id: string) => `publisher.lock.${id}`;

export class TargetStateRepo {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  get(id: string): TargetState | null {
    const raw = this.store.meta.get(stateKey(id));
    if (!raw) return null;
    try {
      const parsed = TargetState.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  set(id: string, state: TargetState): void {
    this.store.meta.set(stateKey(id), JSON.stringify(state));
  }

  update(id: string, dest: string, fn: (s: TargetState) => TargetState): TargetState {
    return this.store.transaction(() => {
      const next = fn(this.get(id) ?? emptyState(dest));
      this.set(id, next);
      return next;
    });
  }

  last(id: string): DeployResult | null {
    return (this.get(id)?.last as DeployResult | null | undefined) ?? null;
  }

  /** Forgets everything about a target (removed, or its destination changed). */
  forget(id: string): void {
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(stateKey(id), lockKey(id));
      this.store.deploys.clear(id);
    });
  }

  // --- cross-process lock -------------------------------------------------------------------

  /** Takes the deploy lock of a target; returns null when another live deploy holds it. */
  acquireLock(id: string, staleMs = 2 * 60_000): DeployLock | null {
    const me = {
      pid: process.pid,
      host: hostname(),
      instance: PROCESS_INSTANCE,
      token: `${process.pid}-${randomUUID()}`,
    };
    const ok = this.store.transaction(() => {
      const raw = this.store.meta.get(lockKey(id));
      if (raw) {
        try {
          const cur = JSON.parse(raw) as { pid: number; host: string; instance?: string; refreshedAt: string };
          const age = Date.now() - Date.parse(cur.refreshedAt);
          const sameHost = cur.host === me.host;
          // Our pid but another incarnation: the holder was killed and this process reuses its pid.
          const predecessor = sameHost && cur.pid === process.pid && cur.instance !== PROCESS_INSTANCE;
          const deadHere = sameHost && (predecessor || !pidAlive(cur.pid));
          if (!(age > staleMs || deadHere || Number.isNaN(age))) return false;
        } catch {
          // Corrupt lock: take it over.
        }
      }
      this.store.meta.set(lockKey(id), JSON.stringify({ ...me, refreshedAt: new Date().toISOString() }));
      return true;
    });
    if (!ok) return null;
    const refresh = () => {
      const raw = this.store.meta.get(lockKey(id));
      if (raw?.includes(me.token)) {
        this.store.meta.set(lockKey(id), JSON.stringify({ ...me, refreshedAt: new Date().toISOString() }));
      }
    };
    const timer = setInterval(refresh, Math.max(1000, Math.floor(staleMs / 4)));
    timer.unref?.();
    return {
      release: () => {
        clearInterval(timer);
        this.store.transaction(() => {
          const raw = this.store.meta.get(lockKey(id));
          if (raw?.includes(me.token)) this.store.db.prepare('DELETE FROM meta WHERE key = ?').run(lockKey(id));
        });
      },
    };
  }
}

export interface DeployLock {
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
