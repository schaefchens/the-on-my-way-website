import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BuildJob, BuildScheduler, Mutex, PublishRunner } from '../../src/app.js';
import type { DeployResult } from '../../src/publisher/index.js';

const log = { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-18T12:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('BuildScheduler', () => {
  it('debounces: runs 3 s after the last request with the union of dates', async () => {
    const jobs: BuildJob[] = [];
    const s = new BuildScheduler({ run: async (j) => void jobs.push(j), log });
    s.request({ dates: ['2026-11-18'], reason: 'captures' });
    await vi.advanceTimersByTimeAsync(1_000);
    s.request({ dates: ['2026-11-17', '2026-11-18'], reason: 'owner' });
    await vi.advanceTimersByTimeAsync(2_900);
    expect(jobs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(jobs).toEqual([{ full: false, dates: ['2026-11-17', '2026-11-18'], reason: 'captures,owner' }]);
  });

  it('runs at most 30 s after the first request even if requests keep coming', async () => {
    const runs: number[] = [];
    const start = Date.now();
    const s = new BuildScheduler({ run: async () => void runs.push(Date.now() - start), log });
    for (let t = 0; t < 40; t += 2) {
      s.request({ dates: [`2026-11-${String(10 + (t % 10)).padStart(2, '0')}`], reason: 'captures' });
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(runs[0]).toBe(30_000);
  });

  it('never overlaps runs; requests during a run form the next job; full is sticky', async () => {
    const jobs: BuildJob[] = [];
    const gate = deferred();
    let calls = 0;
    const s = new BuildScheduler({
      run: async (j) => {
        jobs.push(j);
        if (++calls === 1) await gate.promise;
      },
      log,
    });
    s.request({ dates: ['2026-11-01'], reason: 'a' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s.state().running).toBe(true);
    s.request({ dates: ['2026-11-02'], reason: 'b' });
    s.request({ full: true, reason: 'c' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobs).toHaveLength(1);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(jobs).toEqual([
      { full: false, dates: ['2026-11-01'], reason: 'a' },
      { full: true, dates: ['2026-11-02'], reason: 'b,c' },
    ]);
  });

  it('retries a failed generate with backoff and persists pending work', async () => {
    const saved: ({ dates: string[]; full: boolean } | null)[] = [];
    let fail = true;
    const jobs: BuildJob[] = [];
    const s = new BuildScheduler({
      run: async (j) => {
        jobs.push(j);
        if (fail) throw new Error('disk full');
      },
      log,
      retryBaseMs: 60_000,
      persist: { load: () => null, save: (st) => void saved.push(st) },
    });
    s.request({ dates: ['2026-11-05'], reason: 'captures' });
    expect(saved.at(-1)).toEqual({ dates: ['2026-11-05'], full: false });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(jobs).toHaveLength(1);
    expect(s.lastError).toBe('disk full');
    expect(saved.at(-1)).toEqual({ dates: ['2026-11-05'], full: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs).toHaveLength(1); // waits for the retry, no debounce re-run
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.reason).toBe('retry');
    expect(s.lastError).toBeNull();
    expect(saved.at(-1)).toBeNull();
  });

  it('restores persisted work and flushes on demand', async () => {
    const jobs: BuildJob[] = [];
    const s = new BuildScheduler({
      run: async (j) => void jobs.push(j),
      log,
      persist: { load: () => ({ dates: ['2026-11-09'], full: true }), save: () => {} },
    });
    expect(s.restore()).toBe(true);
    await s.flush();
    expect(jobs).toEqual([{ full: true, dates: ['2026-11-09'], reason: 'resume' }]);
    await s.flush(); // nothing pending: no-op
    expect(jobs).toHaveLength(1);
  });

  it('stop() waits for the running job and keeps pending work persisted', async () => {
    const saved: ({ dates: string[]; full: boolean } | null)[] = [];
    const gate = deferred();
    const s = new BuildScheduler({
      run: () => gate.promise,
      log,
      persist: { load: () => null, save: (st) => void saved.push(st) },
    });
    s.request({ dates: ['2026-11-01'], reason: 'a' });
    await vi.advanceTimersByTimeAsync(3_000);
    s.request({ dates: ['2026-11-02'], reason: 'b' });
    const stopped = s.stop();
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    expect(saved.at(-1)).toEqual({ dates: ['2026-11-02'], full: false });
  });
});

const ok = (targetId: string, version = 1): DeployResult => ({
  targetId,
  ok: true,
  version,
  uploaded: 1,
  deleted: 0,
  bytes: 10,
  durationMs: 5,
  httpCheck: 'ok',
});

describe('PublishRunner', () => {
  it('coalesces requests during a deploy into one follow-up deploy', async () => {
    const gate = deferred();
    const deploys: { targetId?: string; reason: string }[] = [];
    const runner = new PublishRunner({
      deploy: async (o) => {
        deploys.push(o);
        if (deploys.length === 1) await gate.promise;
        return [ok('local')];
      },
      hasTargets: () => true,
      onResults: () => {},
      log,
    });
    const first = runner.trigger('generate');
    const a = runner.trigger('generate');
    const b = runner.trigger('manual');
    const c = runner.trigger('generate', 'local');
    expect(a).toBe(b);
    expect(b).toBe(c);
    gate.resolve();
    await first;
    await a;
    expect(deploys).toEqual([{ reason: 'generate' }, { reason: 'generate,manual' }]);
  });

  it('retries failed deploys with backoff and resets after success', async () => {
    const results: DeployResult[][] = [];
    let fail = 2;
    const runner = new PublishRunner({
      deploy: async () => (fail-- > 0 ? [{ ...ok('sftp'), ok: false, error: 'timeout' }] : [ok('sftp')]),
      hasTargets: () => true,
      onResults: (r) => void results.push(r),
      log,
      retryBaseMs: 60_000,
    });
    await runner.trigger('generate');
    expect(runner.nextRetryAt).toBe(new Date(Date.now() + 60_000).toISOString());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(results).toHaveLength(2);
    expect(runner.nextRetryAt).toBe(new Date(Date.now() + 120_000).toISOString());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(results).toHaveLength(3);
    expect(results[2]?.[0]?.ok).toBe(true);
    expect(runner.nextRetryAt).toBeNull();
  });

  it('keeps retrying a failing target when another target is deployed on its own meanwhile', async () => {
    const calls: (string | undefined)[] = [];
    let sftpFails = 1;
    const runner = new PublishRunner({
      deploy: async (o) => {
        calls.push(o.targetId);
        if (o.targetId === 'local') return [ok('local')];
        return [ok('local'), sftpFails-- > 0 ? { ...ok('sftp'), ok: false, error: 'timeout' } : ok('sftp')];
      },
      hasTargets: () => true,
      onResults: () => {},
      log,
      retryBaseMs: 60_000,
    });
    await runner.trigger('generate'); // sftp fails -> retry of all targets in 60 s
    expect(runner.nextRetryAt).not.toBeNull();
    await runner.trigger('manual', 'local'); // a single-target deploy must not cancel that retry
    expect(runner.nextRetryAt).not.toBeNull();
    expect(runner.consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([undefined, 'local', undefined]);
    expect(runner.nextRetryAt).toBeNull();
    expect(runner.consecutiveFailures).toBe(0);
  });

  it('retries only the failed target of a single-target deploy', async () => {
    const calls: (string | undefined)[] = [];
    let fails = 1;
    const runner = new PublishRunner({
      deploy: async (o) => {
        calls.push(o.targetId);
        return [fails-- > 0 ? { ...ok('sftp'), ok: false, error: 'timeout' } : ok('sftp')];
      },
      hasTargets: () => true,
      onResults: () => {},
      log,
      retryBaseMs: 1_000,
    });
    await runner.trigger('manual', 'sftp');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(['sftp', 'sftp']);
    await runner.stop();
  });

  it('does nothing without targets and turns exceptions into failed results', async () => {
    let targets = false;
    const runner = new PublishRunner({
      deploy: async () => {
        throw new Error('boom');
      },
      hasTargets: () => targets,
      onResults: () => {},
      log,
    });
    expect(await runner.trigger('generate')).toEqual([]);
    targets = true;
    const r = await runner.trigger('generate');
    expect(r[0]).toMatchObject({ ok: false, error: 'boom' });
    await runner.stop();
  });
});

describe('Mutex', () => {
  it('serialises critical sections', async () => {
    vi.useRealTimers();
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
    });
    const b = m.run(async () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});
