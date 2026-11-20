/**
 * The traveler's learned WhatsApp LID (contracts wa.ts "Traveler identity"): the helper emits
 * `traveler {pn, lid}`; Node persists it in store.meta and passes it back as -traveler-lid on
 * every spawn. TRAVELER_LID (config.wa.travelerLid) overrides the learned value.
 */
import { LidDigits, PhoneDigits } from '@omw/contracts/wa';
import type { Config } from '../config.js';
import type { Store } from '../store/index.js';

export const META_TRAVELER_LID = 'wa.traveler_lid';
/** Phone number the persisted LID belongs to (a changed TRAVELER_PHONE invalidates it). */
export const META_TRAVELER_PN = 'wa.traveler_pn';

/** LID to pass to the helper, or null. */
export function knownTravelerLid(config: Config, store: Store): string | null {
  if (config.wa.travelerLid) return config.wa.travelerLid;
  const lid = store.meta.get(META_TRAVELER_LID);
  if (!lid || !LidDigits.safeParse(lid).success) return null;
  const pn = store.meta.get(META_TRAVELER_PN);
  if (config.wa.travelerPhone && pn && pn !== config.wa.travelerPhone) return null;
  return lid;
}

/**
 * Persists a learned LID. Ignored (returns false) when it belongs to another phone number than
 * the configured traveler, is malformed, or is already stored.
 */
export function persistTravelerLid(config: Config, store: Store, pn: string, lid: string | undefined): boolean {
  if (!lid || !LidDigits.safeParse(lid).success || !PhoneDigits.safeParse(pn).success) return false;
  if (config.wa.travelerPhone && pn !== config.wa.travelerPhone) return false;
  if (store.meta.get(META_TRAVELER_LID) === lid && store.meta.get(META_TRAVELER_PN) === pn) return false;
  store.transaction(() => {
    store.meta.set(META_TRAVELER_LID, lid);
    store.meta.set(META_TRAVELER_PN, pn);
    store.events.append('wa.traveler_lid', { pn, lid });
  });
  return true;
}
