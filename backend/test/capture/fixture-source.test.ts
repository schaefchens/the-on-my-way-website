/** FixtureSource: atomic replay into the inbox, paced mode, crash leftovers, mode selection. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WaEvent } from '@omw/contracts/wa';
import { afterEach, describe, expect, it } from 'vitest';
import { createWaSource, FixtureSource, HelperSource } from '../../src/capture/index.js';
import { FIXTURE_INBOX, fixtureIndex, fixturesPresent, makeEnv, type TestEnv } from './env.js';

describe.skipIf(!fixturesPresent)('FixtureSource', () => {
  let env: TestEnv;
  afterEach(() => env?.cleanup());

  it('copies every fixture into the inbox and emits events in timestamp order', async () => {
    env = makeEnv({ prefix: 'fixture-src-' });
    // Leftovers of a replay that was killed half-way.
    mkdirSync(join(env.paths.inbox, '.fixture-3EB0AAAA.tmp-1-deadbeef-00112233'));
    writeFileSync(join(env.paths.revokes, '3EB0AAAA.json.tmp-1-deadbeef-00112233'), '{');
    const source = createWaSource({ config: env.config, log: env.log, paths: env.paths, store: env.store });
    expect(source).toBeInstanceOf(FixtureSource);
    const events: WaEvent[] = [];
    source.onEvent((e) => events.push(e));
    await source.start();

    const index = fixtureIndex();
    expect(readdirSync(env.paths.inbox).sort()).toEqual([...index.statuses.map((s) => s.msgId), '_revokes'].sort());
    expect(readdirSync(env.paths.revokes)).toEqual(['3EB029F28898501FA172.json']);
    for (const s of index.statuses) {
      const copied = readFileSync(join(env.paths.inbox, s.msgId, 'meta.json'));
      expect(copied.equals(readFileSync(join(FIXTURE_INBOX, s.msgId, 'meta.json')))).toBe(true);
      if (s.file) expect(existsSync(join(env.paths.inbox, s.msgId, s.file))).toBe(true);
    }
    expect(events.slice(0, 3).map((e) => e.type)).toEqual(['ready', 'state', 'traveler']);
    const statusIds = events.filter((e) => e.type === 'status').map((e) => (e as { msgId: string }).msgId);
    expect(statusIds).toEqual(
      [...index.statuses].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1)).map((s) => s.msgId),
    );
    const revokeAt = events.findIndex((e) => e.type === 'revoke');
    const revokedStatusAt = events.findIndex((e) => e.type === 'status' && e.msgId === '3EB029F28898501FA172');
    expect(revokeAt).toBeGreaterThan(revokedStatusAt);
    expect(source.tzHint?.('3EB0D4DF9C5342C8CF0B')).toBe('Europe/Berlin');
    expect(source.state()).toMatchObject({ mode: 'fixture', wa: 'open', traveler: { lid: '100000000000001' } });

    // A second replay never replaces existing inbox entries.
    const before = readFileSync(join(env.paths.inbox, index.statuses[0]?.msgId ?? '', 'meta.json'), 'utf8');
    await source.stop();
    await source.start();
    expect(readFileSync(join(env.paths.inbox, index.statuses[0]?.msgId ?? '', 'meta.json'), 'utf8')).toBe(before);
    source.send({ type: 'stats' });
    expect(events.at(-1)).toEqual({ type: 'stats', counters: { captured: 18 } });
    await source.stop();
  });

  it('paces the replay in the background and stops mid-way', async () => {
    env = makeEnv({ prefix: 'fixture-paced-', env: {} });
    const source = createWaSource({
      config: env.config,
      log: env.log,
      paths: env.paths,
      store: env.store,
      env: { WA_FIXTURE_PACE_MS: '40' },
    });
    const statuses: string[] = [];
    source.onEvent((e) => {
      if (e.type === 'status') statuses.push(e.msgId);
    });
    await source.start();
    expect(statuses.length).toBeLessThanOrEqual(1);
    // Wait for the condition, not a fixed time: under parallel load a copy can take longer than
    // the pace (the replay keeps its order but slows down).
    const deadline = Date.now() + 10_000;
    while (statuses.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await source.stop();
    const seen = statuses.length;
    expect(seen).toBeGreaterThan(1);
    expect(seen).toBeLessThan(18);
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses.length).toBe(seen);
  });

  it('uses the helper for observer and self mode', () => {
    env = makeEnv({ prefix: 'fixture-mode-', env: { WA_MODE: 'observer', TRAVELER_PHONE: '4915100000001' } });
    const source = createWaSource({ config: env.config, log: env.log, paths: env.paths, store: env.store });
    expect(source).toBeInstanceOf(HelperSource);
    expect(source.state()).toMatchObject({ mode: 'observer', process: 'stopped', traveler: { pn: '4915100000001' } });
  });
});
