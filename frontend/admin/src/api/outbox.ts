/**
 * Writes that failed with 401 (the session expired while they were queued) are kept here and
 * replayed after the next login, so an expired session never loses an edit. Persisted in
 * localStorage (plain JSON variables, see types.ts).
 */
import type { QueryClient } from '@tanstack/react-query';
import { createStore, localStore } from '../lib/store';
import type { MutationName } from './keys';
import type { WriteVars } from './types';
import { runWrite } from './writes';

const KEY = 'omw.admin.outbox';

export interface OutboxEntry {
  name: MutationName;
  vars: WriteVars[MutationName];
  at: string;
}

export const outboxStore = createStore<OutboxEntry[]>(localStore.read<OutboxEntry[]>(KEY, []));
outboxStore.subscribe(() => localStore.write(KEY, outboxStore.get().length ? outboxStore.get() : null));

export function addToOutbox(name: MutationName, vars: WriteVars[MutationName], now = new Date()): void {
  outboxStore.set((list) => [...list, { name, vars, at: now.toISOString() }]);
}

/** Replays the kept writes in their original order (they queue behind each other again). */
export async function flushOutbox(qc: QueryClient): Promise<number> {
  const entries = outboxStore.get();
  if (entries.length === 0) return 0;
  outboxStore.set([]);
  await Promise.all(entries.map((e) => runWrite(qc, e.name, e.vars as never)));
  return entries.length;
}

export function clearOutbox(): void {
  outboxStore.set([]);
}
