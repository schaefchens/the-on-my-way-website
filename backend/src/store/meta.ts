/** meta table: schema_version (managed by migrations) and the monotonic site_version counter. */
import type { Db } from './db.js';

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
