/**
 * meta table: schema_version (managed by migrations), the monotonic site_version counter and
 * small generator facts such as "portrait.published" (the portrait the last run published, kept
 * while a newly chosen one waits for its release, spec-wave5 §5.2).
 */
import { SiteAvatarSetting } from '@omw/contracts/api';
import type { Db } from './db.js';

/** Meta key of the portrait the last generator run published: {"sourceKey","focus"}. */
export const PORTRAIT_PUBLISHED_KEY = 'portrait.published';

export class MetaRepo {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    if (key === 'schema_version') throw new Error('schema_version is managed by migrations');
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** The portrait the last run published, or null (unset or unreadable). */
  portraitPublished(): SiteAvatarSetting | null {
    const raw = this.get(PORTRAIT_PUBLISHED_KEY);
    if (!raw) return null;
    try {
      const r = SiteAvatarSetting.safeParse(JSON.parse(raw));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  /** Records the portrait a run published (null forgets it: the run published none). */
  setPortraitPublished(value: SiteAvatarSetting | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(PORTRAIT_PUBLISHED_KEY);
      return;
    }
    const v = SiteAvatarSetting.parse(value);
    this.set(
      PORTRAIT_PUBLISHED_KEY,
      JSON.stringify({ sourceKey: v.sourceKey, ...(v.focus ? { focus: v.focus } : {}) }),
    );
  }

  schemaVersion(): number {
    return Number.parseInt(this.get('schema_version') ?? '0', 10);
  }

  /** Version of the last generated site (0 = never generated). */
  siteVersion(): number {
    return Number.parseInt(this.get('site_version') ?? '0', 10);
  }

  /**
   * Raises the site version to at least `floor` (never lowers it): a store that lost its state
   * continues above the version a target already serves (L2-02 d). The next release is floor + 1.
   */
  raiseSiteVersion(floor: number): void {
    if (!Number.isInteger(floor) || floor < 0) throw new RangeError(`Invalid site version: ${floor}`);
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('site_version', CAST(@v AS TEXT))
         ON CONFLICT (key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), @v) AS TEXT)`,
      )
      .run({ v: floor });
  }

  /** Atomically increments and returns the site version (Manifest.version). */
  nextSiteVersion(): number {
    const r = this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('site_version', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         RETURNING value`,
      )
      .get() as { value: string };
    return Number.parseInt(r.value, 10);
  }
}
