/** Last deployed file list per publish target (path -> sha256, size). */
import type { Db } from './db.js';
import type { Clock } from './types.js';

export interface DeployedFile {
  path: string;
  sha256: string;
  size: number;
  deployedAt: string;
}

export type DeployEntry = Omit<DeployedFile, 'deployedAt'> & { deployedAt?: string };

export class DeployManifestRepo {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
  }

  targets(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT target FROM deploy_manifest ORDER BY target').all() as { target: string }[]
    ).map((r) => r.target);
  }

  /** path -> file, for one target. */
  get(target: string): Map<string, DeployedFile> {
    const rows = this.db
      .prepare(
        'SELECT path, sha256, size, deployed_at AS deployedAt FROM deploy_manifest WHERE target = ? ORDER BY path',
      )
      .all(target) as DeployedFile[];
    return new Map(rows.map((r) => [r.path, r]));
  }

  /** Records uploaded files (insert or update). */
  upsert(target: string, entries: readonly DeployEntry[]): void {
    const now = this.now().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO deploy_manifest (target, path, sha256, size, deployed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (target, path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size,
         deployed_at = excluded.deployed_at`,
    );
    this.db.transaction(() => {
      for (const e of entries) stmt.run(target, e.path, e.sha256, e.size, e.deployedAt ?? now);
    })();
  }

  /** Records deleted files. */
  remove(target: string, paths: readonly string[]): number {
    const stmt = this.db.prepare('DELETE FROM deploy_manifest WHERE target = ? AND path = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const p of paths) n += stmt.run(target, p).changes;
    })();
    return n;
  }

  /** Replaces the whole manifest of a target (e.g. after recovering it from the remote copy). */
  replace(target: string, entries: readonly DeployEntry[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM deploy_manifest WHERE target = ?').run(target);
      this.upsert(target, entries);
    })();
  }

  clear(target: string): number {
    return this.db.prepare('DELETE FROM deploy_manifest WHERE target = ?').run(target).changes;
  }
}
