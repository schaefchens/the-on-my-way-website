/**
 * Owner decision Q8 a (app-plan §6.2 done-when 10): with the archive-only switch on (APP_PUBLISH
 * off, the default), the generated site contains no entry from the traveler app, even a ready,
 * public one; switching publishing on brings it in with a full re-check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { publicIdForSourceKey } from '@omw/contracts/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGenerator } from '../../src/generator/index.js';
import { createLogger } from '../../src/log.js';
import { REPO_ROOT } from '../../src/paths.js';
import { createHarness, type Harness } from './harness.js';

const KEY = 'app:01JD3ZQ8X4V7N2K5M9P0R6S8TW';

function filesContaining(dir: string, needle: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(json|html|xml|txt)$/.test(name) && readFileSync(path, 'utf8').includes(needle)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const present = existsSync(join(REPO_ROOT, 'fixtures', 'generated', 'index.json'));

describe.skipIf(!present)('generator: app captures in archive-only mode', () => {
  let h: Harness;
  let publicId: string;

  beforeEach(async () => {
    h = await createHarness();
    publicId = await publicIdForSourceKey(KEY);
    h.store.captures.insert({
      sourceKey: KEY,
      publicId,
      msgId: null,
      source: 'app',
      kind: 'text',
      occurredAt: '2026-11-18T03:00:00.000Z',
      tz: 'Asia/Ho_Chi_Minh',
      text: { body: 'Hello from the app', bgArgb: 0xff7e57c2, textArgb: 0xffffffff, font: 'SYSTEM' },
      download: { state: 'not_applicable' },
    });
    expect(h.store.captures.markReady(KEY)).toBe(true);
  }, 30_000);
  afterEach(() => h.cleanup());

  it('leaves every app: capture out while APP_PUBLISH is off, and publishes it once it is on', async () => {
    await h.generator.generate({ full: true, reason: 'archive-only' });
    expect(filesContaining(h.outDir, publicId)).toEqual([]);
    expect(filesContaining(h.outDir, 'Hello from the app')).toEqual([]);

    const publishing = createGenerator({
      config: { ...h.config, app: { publish: true, pollSeconds: 60 } },
      log: createLogger({ level: 'silent' }),
      store: h.store,
      now: h.clock,
      siteDistDir: h.siteDist,
      validate: true,
    });
    const result = await publishing.generate({ reason: 'publishing on' });
    expect(result.full).toBe(true);
    expect(filesContaining(h.outDir, 'Hello from the app').length).toBeGreaterThan(0);
  }, 120_000);
});
