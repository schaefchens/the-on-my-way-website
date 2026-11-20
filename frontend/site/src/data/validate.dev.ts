/**
 * Dev-only schema checks (imported dynamically behind `import.meta.env.DEV`, so neither zod nor
 * the schemas end up in production chunks).
 */
import { Boot, DayDetail, Manifest, TimelineIndex, TripDetail } from '@omw/contracts/site';
import { z } from 'zod';
import type { SiteBoot } from '../boot';
import type { SiteDataName, SiteDataTypes } from './fetch';

const SCHEMAS = { Manifest, TimelineIndex, DayDetail, TripDetail } as const;

export class ContractViolation extends Error {
  constructor(name: string, details: string) {
    super(`${name} does not match @omw/contracts/site:\n${details}`);
    this.name = 'ContractViolation';
  }
}

export function validateSiteData<K extends SiteDataName>(name: K, data: unknown): SiteDataTypes[K] {
  const result = SCHEMAS[name].safeParse(data);
  if (!result.success) {
    const error = new ContractViolation(name, z.prettifyError(result.error));
    console.error(error.message, data);
    throw error;
  }
  return result.data as SiteDataTypes[K];
}

/** Logs (does not throw) when the page's boot JSON violates the contract. */
export function validateBoot(boot: SiteBoot): boolean {
  if (boot.source !== 'document') return true;
  const result = Boot.safeParse(boot.raw);
  if (!result.success) console.error(`Boot JSON does not match @omw/contracts/site:\n${z.prettifyError(result.error)}`);
  return result.success;
}
