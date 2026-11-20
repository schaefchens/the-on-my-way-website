/**
 * "New in the inbox": captures that occurred after the owner last left the inbox on this device.
 * A per-device convenience (localStorage), not owner data.
 */
import { createStore, localStore } from './store';

const KEY = 'omw.admin.inboxSeenAt';

export const inboxSeenStore = createStore<string | null>(localStore.read<string | null>(KEY, null));
inboxSeenStore.subscribe(() => localStore.write(KEY, inboxSeenStore.get()));

export function isNew(occurredAt: string, seenAt: string | null): boolean {
  return seenAt !== null && occurredAt > seenAt;
}

/** Marks everything up to `newest` as seen (never moves backwards). */
export function markSeen(newest: string | null | undefined): void {
  if (!newest) return;
  const prev = inboxSeenStore.get();
  if (prev === null || newest > prev) inboxSeenStore.set(newest);
}
