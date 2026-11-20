import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/paths.js';
import type { Clock } from '../src/store/index.js';

/** Temp directories live inside the repo (.cache/tmp, git-ignored), never in the OS temp dir. */
export function makeTempDir(prefix = 'backend-test-'): { dir: string; cleanup: () => void } {
  const base = join(REPO_ROOT, '.cache', 'tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A controllable clock. */
export function fakeClock(start = '2026-11-19T10:00:00.000Z'): Clock & {
  set(iso: string): void;
  advance(ms: number): void;
} {
  let t = new Date(start).getTime();
  const clock = (() => new Date(t)) as Clock & { set(iso: string): void; advance(ms: number): void };
  clock.set = (iso: string) => {
    t = new Date(iso).getTime();
  };
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}
