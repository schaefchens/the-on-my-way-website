import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { describe, expect, it } from 'vitest';
import { mergeEnv, parseDotenv, parseDotenvDetailed } from '../../src/publisher/dotenv.js';
import {
  defaultHostKeys,
  fingerprintOf,
  HOST_KEY_FINGERPRINT,
  keyTypeOf,
  parseFingerprints,
} from '../../src/publisher/hostkeys.js';
import { buildPlan, deleteGroups, phaseOf } from '../../src/publisher/plan.js';
import { tmpPathFor } from '../../src/publisher/record.js';
import { runPool, withTimeout } from '../../src/publisher/remote.js';
import { PublicBaseUrl, RemoteRoot } from '../../src/publisher/types.js';

describe('dotenv (literal)', () => {
  it('parses KEY=value lines without any shell interpretation', () => {
    const text = [
      '﻿# comment',
      '',
      'A=plain',
      'B="double quoted"',
      "C='single $HOME `x` \\n'",
      'D=p@$$w0rd#with"stuff\'',
      'export E = spaced value  ',
      'F=a=b=c',
      'G=',
      'H="unbalanced',
      '  # indented comment',
      'not a line',
      '1BAD=x',
      'A=override\r',
    ].join('\n');
    const r = parseDotenvDetailed(text);
    expect(r.values).toEqual({
      A: 'override',
      B: 'double quoted',
      C: 'single $HOME `x` \\n',
      D: 'p@$$w0rd#with"stuff\'',
      E: 'spaced value',
      F: 'a=b=c',
      G: '',
      H: '"unbalanced',
    });
    expect(r.invalidLines).toEqual([12, 13]);
  });

  it('strips exactly one pair of quotes and keeps inline "#" text', () => {
    expect(parseDotenv(`X=""quoted""\nY=a # not a comment\nZ="'`)).toEqual({
      X: '"quoted"',
      Y: 'a # not a comment',
      Z: `"'`,
    });
  });

  it('mergeEnv: real (non-empty) env wins over the file', () => {
    expect(mergeEnv({ A: 'file', B: 'file', C: 'file' }, { A: 'env', B: '', D: 'env' })).toEqual({
      A: 'env',
      B: 'file',
      C: 'file',
      D: 'env',
    });
  });
});

describe('host keys', () => {
  it('fingerprints the raw key blob like OpenSSH (SHA256, base64 without padding)', () => {
    const { public: pub } = ssh2.utils.generateKeyPairSync('ed25519');
    const blob = Buffer.from(pub.split(' ')[1] as string, 'base64');
    const fp = fingerprintOf(blob);
    expect(fp).toMatch(HOST_KEY_FINGERPRINT);
    expect(fp).toBe(`SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`);
    expect(keyTypeOf(blob)).toBe('ssh-ed25519');
    expect(keyTypeOf(Buffer.from([0, 0]))).toBeNull();
  });

  it('knows the pinned keys of the live host and validates user input', () => {
    expect(defaultHostKeys('WWW99.your-server.de')).toEqual([
      'SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs',
      'SHA256:gQnQinEqX7NMlkAYbI8WiXGzkSfQWisi2SxHo7B2ebQ',
    ]);
    expect(defaultHostKeys('example.org')).toEqual([]);
    expect(
      parseFingerprints(
        'SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs, SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs',
      ),
    ).toHaveLength(1);
    expect(() => parseFingerprints('MD5:aa:bb')).toThrow(/fingerprint/);
  });
});

describe('field schemas', () => {
  it('normalizes remote roots and public URLs', () => {
    expect(RemoteRoot.parse('/')).toBe('/');
    expect(RemoteRoot.parse('/www//site/')).toBe('/www/site');
    expect(RemoteRoot.safeParse('www').success).toBe(false);
    expect(RemoteRoot.safeParse('/a/../b').success).toBe(false);
    expect(PublicBaseUrl.parse('https://example.org/travel')).toBe('https://example.org/travel/');
    expect(PublicBaseUrl.safeParse('ftp://example.org/').success).toBe(false);
    expect(PublicBaseUrl.safeParse('https://example.org/?x=1').success).toBe(false);
  });

  it('derives deterministic temp names next to the target file', () => {
    expect(tmpPathFor('/www/data/manifest.json')).toBe('/www/data/.omw-tmp.manifest.json');
    expect(tmpPathFor('/index.html')).toBe('/.omw-tmp.index.html');
  });
});

describe('plan', () => {
  const sig = (s: string, size = 1) => ({ sha256: s.padEnd(64, '0'), size });
  const now = new Date('2026-11-19T10:00:00.000Z');

  it('classifies phases', () => {
    expect(phaseOf('media/ab/x_w320.avif')).toBe('immutable');
    expect(phaseOf('assets/app.js')).toBe('immutable');
    expect(phaseOf('data/days/2026-11-18.json')).toBe('data');
    expect(phaseOf('data/trips/vn.json')).toBe('data');
    expect(phaseOf('data/timeline.json')).toBe('index');
    expect(phaseOf('data/timeline-2026.json')).toBe('index');
    expect(phaseOf('data/manifest.json')).toBe('manifest');
    expect(phaseOf('de/index.html')).toBe('pages');
    expect(phaseOf('.htaccess')).toBe('pages');
  });

  it('orders uploads by phase and deletes referencing files first', () => {
    const desired = new Map([
      ['de/index.html', sig('a')],
      ['data/manifest.json', sig('m2')],
      ['data/timeline.json', sig('t2')],
      ['data/days/2026-11-19.json', sig('d')],
      ['media/aa/new_w320.avif', sig('n')],
      ['assets/app-new.js', sig('j')],
      ['robots.txt', sig('r')],
    ]);
    const deployed = new Map([
      ['de/index.html', sig('a')],
      ['data/manifest.json', sig('m1')],
      ['data/timeline.json', sig('t1')],
      ['data/days/2026-11-18.json', sig('old')],
      ['de/day/2026-11-18/index.html', sig('p')],
      ['media/aa/old_w320.avif', sig('o')],
      ['assets/app-old.js', sig('jo')],
    ]);
    const plan = buildPlan({ desired, deployed, now });
    expect(plan.uploads.map((u) => [u.path, u.reason])).toEqual([
      ['assets/app-new.js', 'new'],
      ['media/aa/new_w320.avif', 'new'],
      ['data/days/2026-11-19.json', 'new'],
      ['data/timeline.json', 'changed'],
      ['robots.txt', 'new'],
      ['data/manifest.json', 'changed'],
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.deletes).toEqual([
      'de/day/2026-11-18/index.html',
      'data/days/2026-11-18.json',
      'media/aa/old_w320.avif',
    ]);
    expect(deleteGroups(plan.deletes)).toEqual([
      ['de/day/2026-11-18/index.html'],
      ['data/days/2026-11-18.json'],
      ['media/aa/old_w320.avif'],
    ]);
    expect(plan.deferred).toEqual([
      { path: 'assets/app-old.js', since: now.toISOString(), dueAt: '2026-11-26T10:00:00.000Z' },
    ]);
    expect([...plan.obsoleteSince]).toEqual([['assets/app-old.js', now.toISOString()]]);
  });

  it('deletes assets once the grace period has passed', () => {
    const deployed = new Map([['assets/old.js', sig('x')]]);
    const since = new Map([['assets/old.js', '2026-11-10T10:00:00.000Z']]);
    const plan = buildPlan({ desired: new Map(), deployed, obsoleteSince: since, now });
    expect(plan.deletes).toEqual(['assets/old.js']);
    expect(plan.deferred).toEqual([]);
    expect(plan.obsoleteSince.size).toBe(0);
  });

  it('unknown remote: uploads everything, deletes only known-obsolete paths', () => {
    const desired = new Map([
      ['a.html', sig('a')],
      ['media/aa/keep_w320.avif', sig('k')],
    ]);
    const plan = buildPlan({
      desired,
      deployed: null,
      knownObsolete: ['media/aa/hidden_w320.avif', 'media/aa/keep_w320.avif'],
      now,
    });
    expect(plan.remoteKnown).toBe(false);
    expect(plan.uploads.map((u) => u.reason)).toEqual(['unknown', 'unknown']);
    expect(plan.deletes).toEqual(['media/aa/hidden_w320.avif']);
  });

  it('maybe-present paths are re-uploaded when desired and deleted (without grace) otherwise', () => {
    const desired = new Map([['a.html', sig('a')]]);
    const deployed = new Map([
      ['a.html', sig('a')],
      ['assets/x.js', sig('x')],
    ]);
    const plan = buildPlan({
      desired,
      deployed,
      maybePresent: new Set(['a.html', 'assets/x.js', 'media/aa/y_w320.avif']),
      now,
    });
    expect(plan.uploads.map((u) => [u.path, u.reason])).toEqual([['a.html', 'forced']]);
    expect(plan.deletes).toEqual(['assets/x.js', 'media/aa/y_w320.avif']);
  });

  it('full re-uploads unchanged files', () => {
    const m = new Map([['a.html', sig('a')]]);
    expect(buildPlan({ desired: m, deployed: m, now, full: true }).uploads).toHaveLength(1);
    expect(buildPlan({ desired: m, deployed: m, now }).uploads).toHaveLength(0);
  });
});

describe('remote helpers', () => {
  it('runPool bounds concurrency and stops after the first failure', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await expect(
      runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
        active++;
        peak = Math.max(peak, active);
        seen.push(n);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(peak).toBeLessThanOrEqual(3);
    expect(seen.length).toBeLessThan(8);
  });

  it('withTimeout rejects with a timeout RemoteError and runs the hook', async () => {
    let hook = false;
    await expect(
      withTimeout(
        20,
        'slow op',
        () => new Promise(() => {}),
        () => {
          hook = true;
        },
      ),
    ).rejects.toMatchObject({ code: 'timeout', transient: true });
    expect(hook).toBe(true);
  });
});
