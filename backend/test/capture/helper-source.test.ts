/**
 * HelperSource supervisor against a fake helper (node script): JSON-line parsing (invalid lines
 * logged + counted, never fatal), stderr re-logging, LID persistence and -traveler-lid on the next
 * spawn, minimal child environment, commands on stdin, restart with backoff after crashes, no
 * tight loop on stream_replaced, fresh QR after logged_out, spawn errors, shutdown escalation.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WaEvent } from '@omw/contracts/wa';
import { afterEach, describe, expect, it } from 'vitest';
import { HelperSource, type HelperSourceOptions, type WaSourceState } from '../../src/capture/index.js';
import { LineSplitter } from '../../src/capture/lines.js';
import { DEFAULT_RESTART_POLICY, exitMeaning, HELPER_EXIT, restartDelay } from '../../src/capture/restart-policy.js';
import { knownTravelerLid, META_TRAVELER_LID, META_TRAVELER_PN } from '../../src/capture/traveler.js';
import { BACKEND_ROOT } from '../../src/paths.js';
import { makeEnv, type TestEnv } from './env.js';

const FAKE = join(BACKEND_ROOT, 'test', 'capture', 'fake-helper.mjs');
const AT = '2026-11-19T10:00:00Z';

type Step = Record<string, unknown>;

async function until(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('HelperSource', () => {
  let env: TestEnv;
  let helper: HelperSource | null = null;

  const setup = (runs: Step[][], options: HelperSourceOptions = {}, envVars: Record<string, string> = {}) => {
    env = makeEnv({
      prefix: 'helper-',
      env: { WA_MODE: 'observer', TRAVELER_PHONE: '+49 151 00000001', LOG_LEVEL: 'debug', ...envVars },
    });
    const scenario = join(env.dir, 'scenario.json');
    writeFileSync(scenario, JSON.stringify({ runs }));
    helper = new HelperSource(
      { config: env.config, log: env.log, paths: env.paths, store: env.store },
      {
        bin: process.execPath,
        binArgs: [FAKE, scenario],
        random: () => 0.5, // no jitter
        policy: { baseDelayMs: 40, loggedOutDelayMs: 40, streamReplacedDelayMs: 60_000 },
        stopTimeoutMs: 2000,
        env: { ...process.env, API_TOKEN: 'secret-api-token', CONTROL_TOKEN: 'secret-control' },
        ...options,
      },
    );
    return helper;
  };
  const runs = () => (existsSync(join(env.dir, 'runs')) ? Number(readFileSync(join(env.dir, 'runs'), 'utf8')) : 0);
  const argv = () =>
    readFileSync(join(env.dir, 'argv.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { run: number; flags: string[]; env: Record<string, string | null> });
  const stdin = () =>
    existsSync(join(env.dir, 'stdin.jsonl'))
      ? readFileSync(join(env.dir, 'stdin.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      : [];

  afterEach(async () => {
    await helper?.stop();
    helper = null;
    env?.cleanup();
  });

  it('parses events, counts invalid lines, re-logs stderr and persists the learned LID', async () => {
    const h = setup([
      [
        { out: { type: 'ready', version: '0.1.0' } },
        { err: JSON.stringify({ level: 'warn', time: AT, message: 'zerolog says hi', module: 'Client' }) },
        { err: 'plain stderr text' },
        { out: 'this is not json' },
        { out: { type: 'bogus' } },
        { out: { type: 'qr', code: '2@abc', expiresAt: AT } },
        { out: { type: 'state', state: 'open', jid: '4915100000002@s.whatsapp.net', at: AT } },
        { out: { type: 'traveler', pn: '4915100000001', lid: '100000000000001' } },
        { out: { type: 'status', msgId: '3EB0AAAA', source: 'live' } },
        { out: { type: 'warning', code: 'command_rejected', command: 'mark_read' } },
      ],
    ]);
    const events: WaEvent[] = [];
    const states: WaSourceState[] = [];
    h.onEvent((e) => events.push(e));
    h.onStateChange((s) => states.push(s));
    await h.start();
    await until(() => events.some((e) => e.type === 'warning'), 5000, 'events');

    expect(events.map((e) => e.type)).toEqual(['ready', 'qr', 'state', 'traveler', 'status', 'warning']);
    const state = h.state();
    expect(state).toMatchObject({
      mode: 'observer',
      wa: 'open',
      jid: '4915100000002@s.whatsapp.net',
      process: 'running',
      helperVersion: '0.1.0',
      qr: null, // cleared once connected
      invalidLines: 2,
      traveler: { pn: '4915100000001', lid: '100000000000001' },
    });
    expect(state.lastStatusAt).not.toBeNull();
    expect(states.some((s) => s.qr?.code === '2@abc')).toBe(true);
    expect(env.store.meta.get(META_TRAVELER_LID)).toBe('100000000000001');
    expect(env.store.meta.get(META_TRAVELER_PN)).toBe('4915100000001');
    expect(env.store.events.recent({ type: 'wa.traveler_lid' })).toHaveLength(1);

    const invalid = env.records.filter((r) => r.msg === 'invalid line from wa-helper ignored');
    expect(invalid.map((r) => r.line)).toEqual(['this is not json', '{"type":"bogus"}']);
    const helperLogs = env.records.filter((r) => r.component === 'wa-helper');
    expect(helperLogs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 40, msg: 'zerolog says hi', module: 'Client' }),
        expect.objectContaining({ level: 30, msg: 'plain stderr text' }),
      ]),
    );

    // Flags and a minimal environment (no backend secrets).
    const [first] = argv();
    expect(first?.flags).toEqual([
      '-data-dir',
      env.paths.root,
      '-mode',
      'observer',
      '-traveler-phone',
      '4915100000001',
      '-send-read-receipt',
      'false',
      '-connect',
      '-log-level',
      'debug',
    ]);
    expect(first?.env).toEqual({
      DATA_DIR: env.paths.root,
      WA_MODE: 'observer',
      SEND_READ_RECEIPT: 'false',
      API_TOKEN: null,
      CONTROL_TOKEN: null,
    });

    // Commands go to stdin; the fake answers `stats`.
    h.send({ type: 'stats' });
    await until(() => h.state().stats.captured === 7, 5000, 'stats');
    h.send({ type: 'redownload', msgId: '3EB0AAAA' });
    await until(() => stdin().length === 2, 5000, 'stdin');
    expect(stdin().map((l) => JSON.parse(l))).toEqual([{ type: 'stats' }, { type: 'redownload', msgId: '3EB0AAAA' }]);
    // Invalid commands are refused before they reach the helper.
    h.send({ type: 'redownload', msgId: '../escape' } as never);
    expect(stdin()).toHaveLength(2);

    await h.stop();
    expect(h.state()).toMatchObject({ process: 'stopped', pid: null, wa: 'closed' });
    expect(stdin().at(-1)).toBe('{"type":"shutdown"}');
    expect(h.state().lastExit).toMatchObject({ code: 0, meaning: 'clean shutdown' });
    // Dropped while stopped (logged).
    h.send({ type: 'stats' });
    expect(env.records.some((r) => r.msg === 'helper not running: command dropped')).toBe(true);
  });

  it('restarts after crashes with exponential backoff and passes the learned LID on the next spawn', async () => {
    const h = setup([
      [{ out: { type: 'traveler', pn: '4915100000001', lid: '100000000000009' } }, { sleep: 50 }, { exit: 1 }],
      [{ exit: 1 }],
      [{ out: { type: 'ready', version: '0.1.0' } }, { out: { type: 'state', state: 'open', at: AT } }],
    ]);
    const exits: number[] = [];
    h.onStateChange((s) => {
      if (s.process === 'backoff' && s.lastExit && exits.length < 10)
        exits.push(Date.parse(s.nextRestartAt ?? '') - Date.parse(s.lastExit.at));
    });
    await h.start();
    await until(() => h.state().wa === 'open' && runs() === 3, 5000, 'third run');
    expect(h.state()).toMatchObject({ restarts: 2, process: 'running', lastExit: { code: 1, meaning: 'fatal error' } });
    expect([...new Set(exits)]).toEqual([40, 80]); // base, then doubled (no jitter in this test)
    const flags = argv().map((a) => a.flags);
    expect(flags[0]).not.toContain('-traveler-lid');
    expect(flags[1]).toEqual(expect.arrayContaining(['-traveler-lid', '100000000000009']));
    expect(flags[2]).toEqual(expect.arrayContaining(['-traveler-lid', '100000000000009']));
    expect(env.store.events.recent({ type: 'wa.helper_exit' })).toHaveLength(2);
  });

  it('never restarts in a tight loop after stream_replaced; restart() overrides the hold', async () => {
    const h = setup([
      [{ out: { type: 'state', state: 'stream_replaced', at: AT } }, { exit: HELPER_EXIT.streamReplaced }],
      [{ out: { type: 'ready', version: 'x' } }],
    ]);
    await h.start();
    await until(() => h.state().process === 'backoff', 5000, 'backoff');
    const s = h.state();
    expect(s).toMatchObject({ wa: 'stream_replaced', lastExit: { code: 4 } });
    expect(Date.parse(s.nextRestartAt ?? '') - Date.parse(s.lastExit?.at ?? '')).toBe(60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(runs()).toBe(1);
    await h.restart();
    await until(() => h.state().helperVersion === 'x', 5000, 'manual restart');
    expect(runs()).toBe(2);
  });

  it('restarts soon after logged_out for a fresh QR', async () => {
    const h = setup([
      [{ out: { type: 'state', state: 'logged_out', code: 401, at: AT } }, { exit: HELPER_EXIT.loggedOut }],
      [{ out: { type: 'qr', code: '2@fresh', expiresAt: AT } }],
    ]);
    await h.start();
    await until(() => h.state().qr?.code === '2@fresh', 5000, 'fresh QR');
    expect(h.state()).toMatchObject({ wa: 'qr', restarts: 1, lastExit: { code: 3 } });
    expect(env.records.some((r) => r.msg === 'wa-helper exited; restart scheduled' && r.level === 50)).toBe(true);
  });

  it('does not restart after an unused pairing window or invalid config until restart()', async () => {
    const h = setup([
      [{ out: { type: 'state', state: 'closed', reason: 'pair_timeout', at: AT } }, { exit: HELPER_EXIT.pairingEnded }],
      [{ exit: HELPER_EXIT.invalidConfig }],
      [{ out: { type: 'qr', code: '2@again', expiresAt: AT } }],
    ]);
    await h.start();
    await until(() => h.state().lastExit?.code === 7, 5000, 'pairing exit');
    await new Promise((r) => setTimeout(r, 200));
    expect(runs()).toBe(1);
    expect(h.state()).toMatchObject({ process: 'stopped', nextRestartAt: null, wa: 'closed', reason: 'pair_timeout' });
    await h.restart();
    await until(() => h.state().lastExit?.code === 2, 5000, 'config exit');
    await new Promise((r) => setTimeout(r, 200));
    expect(runs()).toBe(2);
    expect(h.state().process).toBe('stopped');
    expect(
      env.records.some((r) => r.msg === 'wa-helper exited; not restarting until restart()' && r.level === 50),
    ).toBe(true);
    await h.restart();
    await until(() => h.state().qr?.code === '2@again', 5000, 'QR after restart');
  });

  it('treats exit 2 AFTER ready as a crash (Go runtime panic): restarts with backoff', async () => {
    // Config errors exit 2 before `ready`; an unrecovered Go panic also exits 2 (after `ready`).
    const h = setup([
      [{ out: { type: 'ready', version: '0.2.0' } }, { exit: HELPER_EXIT.invalidConfig }],
      [{ out: { type: 'ready', version: '0.2.0' } }, { out: { type: 'qr', code: '2@after-crash', expiresAt: AT } }],
    ]);
    await h.start();
    await until(() => h.state().qr?.code === '2@after-crash', 5000, 'restart after the crash');
    expect(runs()).toBe(2);
    expect(h.state().lastExit).toMatchObject({ code: 2, meaning: expect.stringContaining('panic') });
    expect(env.records.some((r) => r.msg === 'wa-helper exited; restart scheduled' && r.level === 50)).toBe(true);
    expect(env.records.some((r) => r.msg === 'wa-helper exited; not restarting until restart()')).toBe(false);
  });

  it('backs off when the binary cannot be spawned', async () => {
    const h = setup([[]], { bin: join(BACKEND_ROOT, 'test', 'capture', 'missing-helper-binary'), binArgs: [] });
    await h.start();
    await until(() => h.state().process === 'backoff', 5000, 'backoff');
    expect(h.state().lastExit?.meaning).toMatch(/^spawn failed/);
    await until(() => h.state().restarts >= 1 && h.state().process === 'backoff', 5000, 'second attempt');
  });

  it('drops over-long lines and escalates to SIGTERM when the helper ignores shutdown', async () => {
    const h = setup(
      [
        [
          { ignoreStdin: true },
          { rawOut: `${'x'.repeat(1024 * 1024 + 10)}\n` },
          { out: { type: 'ready', version: 'y' } },
        ],
      ],
      {
        stopTimeoutMs: 200,
      },
    );
    await h.start();
    await until(() => h.state().helperVersion === 'y', 5000, 'ready after long line');
    expect(h.state().invalidLines).toBe(1);
    await h.stop();
    expect(h.state().lastExit?.signal).toBe('SIGTERM');
    expect(env.records.some((r) => r.msg === 'wa-helper did not stop in time: SIGTERM')).toBe(true);
  });

  it('never runs two helpers when restart()/start()/stop() overlap (double click in the control UI)', async () => {
    const h = setup([[{ out: { type: 'ready', version: 'r' } }]]);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pids = () => argv().map((a) => (a as unknown as { pid: number }).pid);
    await h.start();
    await until(() => h.state().helperVersion === 'r', 5000, 'first ready');

    await Promise.all([h.restart(), h.restart(), h.restart()]);
    // The fake writes its run counter before its argv record: wait for both (slow under load).
    await until(
      () => h.state().process === 'running' && runs() === 4 && pids().length === 4,
      10_000,
      'serialized restarts',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(runs()).toBe(4);
    expect(pids().filter(alive)).toHaveLength(1);
    expect(h.state().pid).toBe(pids().at(-1));

    // stop() racing a start(): the helper ends up running exactly once, then stops completely.
    await Promise.all([h.stop(), h.start()]);
    await until(() => h.state().process === 'running' && pids().length === 5, 10_000, 'running after stop+start');
    await new Promise((r) => setTimeout(r, 200));
    expect(pids().filter(alive)).toHaveLength(1);
    expect(h.state().pid).toBe(pids().at(-1));
    await h.stop();
    await until(() => pids().every((pid) => !alive(pid)), 5000, 'all helpers gone');
    expect(h.state()).toMatchObject({ process: 'stopped', pid: null, nextRestartAt: null });
  });

  it('survives store errors while handling helper events and exits (logged, never thrown)', async () => {
    const h = setup(
      [
        [
          { out: { type: 'ready', version: 's' } },
          { sleep: 300 },
          { out: { type: 'traveler', pn: '4915100000001', lid: '100000000000009' } },
          { out: { type: 'stats', counters: { captured: 3 } } },
          { exit: 1 },
        ],
        [{ out: { type: 'ready', version: 's2' } }],
      ],
      { policy: { baseDelayMs: 40 } },
    );
    const events: WaEvent[] = [];
    h.onEvent((e) => events.push(e));
    await h.start();
    await until(() => h.state().helperVersion === 's', 5000, 'ready');
    // The store fails underneath (here: closed; in production e.g. SQLITE_FULL): the traveler event
    // (persists the LID) and the exit (appends wa.helper_exit) both write to it.
    env.store.close();
    await until(() => h.state().helperVersion === 's2', 5000, 'restart after the exit');
    expect(events.map((e) => e.type)).toEqual(['ready', 'traveler', 'stats', 'ready']);
    expect(h.state()).toMatchObject({ stats: { captured: 3 }, restarts: 1, lastExit: { code: 1 } });
    const errors = env.records.filter((r) => r.level >= 50).map((r) => r.msg);
    expect(errors).toEqual(
      expect.arrayContaining(['handling a wa-helper event failed', 'recording the wa-helper exit failed']),
    );
  });

  it('passes WA_MODE=self and an explicit TRAVELER_LID', async () => {
    const h = setup([[{ out: { type: 'ready', version: 'z' } }]], {}, { WA_MODE: 'self', TRAVELER_LID: '555' });
    await h.start();
    await until(() => h.state().helperVersion === 'z', 5000, 'ready');
    const [first] = argv();
    expect(first?.env.WA_MODE).toBe('self');
    expect(first?.flags).toEqual(expect.arrayContaining(['-mode', 'self', '-traveler-lid', '555']));
  });
});

describe('restart policy', () => {
  const p = { ...DEFAULT_RESTART_POLICY, jitter: 0 };
  it('maps exit codes to delays', () => {
    expect(restartDelay(p, { code: 1 }, 1, 0, null)).toBe(1000);
    expect(restartDelay(p, { code: 1 }, 4, 0, null)).toBe(8000);
    expect(restartDelay(p, { code: 1 }, 40, 0, null)).toBe(p.maxDelayMs);
    expect(restartDelay(p, { code: null }, 2, 0, null)).toBe(2000);
    expect(restartDelay(p, { code: 2 }, 1, 0, null)).toBeNull();
    expect(restartDelay(p, { code: 3 }, 1, 0, null)).toBe(5000);
    expect(restartDelay(p, { code: 4 }, 1, 0, null)).toBe(60_000);
    expect(restartDelay(p, { code: 4 }, 3, 0, null)).toBe(240_000);
    expect(restartDelay(p, { code: 5 }, 1, 0, null)).toBe(p.clientOutdatedDelayMs);
    expect(restartDelay(p, { code: 6 }, 1, 1_000, 3_601_000)).toBe(3_600_000); // ban end
    expect(restartDelay(p, { code: 6 }, 1, 0, null)).toBe(p.banDelayMs);
    expect(restartDelay(p, { code: 7 }, 2, 0, null)).toBeNull();
    expect(restartDelay({ ...p, jitter: 0.25 }, { code: 1 }, 1, 0, null, () => 0)).toBe(750);
    expect(restartDelay({ ...p, jitter: 0.25 }, { code: 1 }, 1, 0, null, () => 1)).toBe(1250);
    expect(exitMeaning(8, null)).toBe('connect failure');
    expect(exitMeaning(null, 'SIGKILL')).toBe('killed by SIGKILL');
  });

  it('ignores a persisted LID that belongs to another phone number', () => {
    const env = makeEnv({ prefix: 'lid-', env: { WA_MODE: 'observer', TRAVELER_PHONE: '4915100000001' } });
    env.store.meta.set(META_TRAVELER_LID, '42');
    env.store.meta.set(META_TRAVELER_PN, '4915199999999');
    expect(knownTravelerLid(env.config, env.store)).toBeNull();
    env.store.meta.set(META_TRAVELER_PN, '4915100000001');
    expect(knownTravelerLid(env.config, env.store)).toBe('42');
    env.cleanup();
  });
});

describe('LineSplitter', () => {
  it('splits chunks, handles CRLF and multi-byte characters, and drops over-long lines', () => {
    const lines: string[] = [];
    const overflow: string[] = [];
    const s = new LineSplitter({
      maxLineLength: 10,
      onLine: (l) => lines.push(l),
      onOverflow: (h) => overflow.push(h),
    });
    const euro = Buffer.from('€');
    s.push('ab');
    s.push('c\r\nd');
    s.push(Buffer.concat([euro.subarray(0, 1)]));
    s.push(Buffer.concat([euro.subarray(1), Buffer.from('\n\n')]));
    s.push('0123456789ABC');
    s.push('DEF\nok\ntail');
    s.end();
    expect(lines).toEqual(['abc', 'd€', 'ok', 'tail']);
    expect(overflow).toEqual(['0123456789ABC']);
  });
});
