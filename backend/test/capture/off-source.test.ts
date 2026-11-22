import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createWaSource, OffSource } from '../../src/capture/index.js';
import { linkStep, waStateLabel } from '../../src/ui/wa-monitor.js';
import { makeEnv, type TestEnv } from './env.js';

describe('OffSource (WA_MODE=off)', () => {
  let env: TestEnv;
  afterEach(() => env?.cleanup());

  it('starts nothing, emits nothing and offers nothing to link', async () => {
    env = makeEnv({ prefix: 'off-src-', env: { WA_MODE: 'off' } });
    expect(env.config.wa.mode).toBe('off');
    const source = createWaSource({ config: env.config, log: env.log, paths: env.paths, store: env.store });
    expect(source).toBeInstanceOf(OffSource);

    const events: unknown[] = [];
    const states: unknown[] = [];
    source.onEvent((e) => events.push(e));
    source.onStateChange?.((s) => states.push(s));
    await source.start();
    source.send({ type: 'logout' } as never);
    await source.stop();

    expect(events).toEqual([]);
    expect(states).toEqual([]);
    const s = source.state();
    expect(s).toMatchObject({ mode: 'off', wa: 'closed', process: 'stopped', pid: null, qr: null, pairCode: null });
    // Nothing was written to the WhatsApp inbox.
    expect(readdirSync(env.paths.inbox).filter((f) => f !== '_revokes')).toEqual([]);

    const snapshot = { ...s, state: s.wa } as never;
    expect(waStateLabel(snapshot)).toBe('Off');
    expect(linkStep(snapshot)).toBe('fixture');
  });
});
