import { describe, expect, it } from 'vitest';
import type { CaptureRow } from '../../src/store/types.js';
import { ControlAuth, parseCookies } from '../../src/ui/auth.js';
import { escapeHtml, html, raw, relativeTime } from '../../src/ui/html.js';
import { LogRing } from '../../src/ui/log-ring.js';
import { checkUrlsOf, publishSummary, queueFragment, waBadge } from '../../src/ui/pages.js';
import { isLoopbackHost, safeNext } from '../../src/ui/server.js';
import { targetInputFromForm } from '../../src/ui/targets.js';
import type { AppStatus, DeployResultView } from '../../src/ui/types.js';
import {
  linkStep,
  normalizePhone,
  PAIR_CODE_VALID_MS,
  PairCodeError,
  renewText,
  WaMonitor,
  waStateLabel,
} from '../../src/ui/wa-monitor.js';
import { FakeSource } from './fake-backend.js';

describe('ControlAuth', () => {
  it('issues sessions that verify, expire and can be revoked', () => {
    let now = 1_000_000;
    const auth = new ControlAuth('token-1234567890', { now: () => now, sessionTtlMs: 60_000 });
    const { cookie, session } = auth.issueSession();
    expect(auth.verifySession(cookie)).toEqual(session);
    expect(auth.verifySession(`${cookie}x`)).toBeNull();
    expect(auth.verifySession(cookie.replace(/^\d+/, String(now + 10_000_000)))).toBeNull(); // forged expiry
    expect(new ControlAuth('other-token-123456', { now: () => now }).verifySession(cookie)).toBeNull();
    now += 61_000;
    expect(auth.verifySession(cookie)).toBeNull();
    now -= 61_000;
    auth.revoke(session);
    expect(auth.verifySession(cookie)).toBeNull();
  });

  it('derives CSRF tokens from the session', () => {
    const auth = new ControlAuth('token-1234567890');
    const a = auth.issueSession().session;
    const b = auth.issueSession().session;
    expect(auth.verifyCsrf(a, auth.csrfToken(a))).toBe(true);
    expect(auth.verifyCsrf(a, auth.csrfToken(b))).toBe(false);
    expect(auth.verifyCsrf(a, undefined)).toBe(false);
  });

  it('checks tokens and Bearer headers', () => {
    const auth = new ControlAuth('token-1234567890');
    expect(auth.checkToken('token-1234567890')).toBe(true);
    expect(auth.checkToken('token-123456789')).toBe(false);
    expect(auth.checkBearer('Bearer token-1234567890')).toBe(true);
    expect(auth.checkBearer('bearer   token-1234567890 ')).toBe(true);
    expect(auth.checkBearer('Basic dG9rZW4=')).toBe(false);
    expect(auth.checkBearer(undefined)).toBe(false);
  });

  it('rate limits failed logins per address', () => {
    let now = 0;
    const auth = new ControlAuth('t'.repeat(16), { now: () => now, maxLoginFailures: 3, loginWindowMs: 1_000 });
    for (let i = 0; i < 3; i++) auth.recordLoginFailure('1.2.3.4');
    expect(auth.loginAllowed('1.2.3.4')).toBe(false);
    expect(auth.loginAllowed('5.6.7.8')).toBe(true);
    now = 2_000;
    expect(auth.loginAllowed('1.2.3.4')).toBe(true);
  });

  it('parses cookies', () => {
    expect(parseCookies('a=1; omw_ctl=x.y.z; b=%20')).toEqual({ a: '1', omw_ctl: 'x.y.z', b: ' ' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('html', () => {
  it('escapes interpolations unless raw()', () => {
    expect(html`<p title="${'"x"'}">${'<b>&'}</p>${raw('<i>ok</i>')}${null}${['<', raw('>')]}`.toString()).toBe(
      '<p title="&quot;x&quot;">&lt;b&gt;&amp;</p><i>ok</i>&lt;>',
    );
    expect(escapeHtml(`'`)).toBe('&#39;');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    expect(relativeTime('2026-11-18T11:59:30Z', now)).toBe('30 s ago');
    expect(relativeTime('2026-11-18T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-11-18T11:00:00Z', now)).toBe('1 h ago');
    expect(relativeTime('2026-11-18T14:00:00Z', now)).toBe('in 2 h');
    expect(relativeTime(null, now)).toBe('–');
  });
});

describe('server helpers', () => {
  it('only redirects to local paths', () => {
    expect(safeNext('/queue?x=1')).toBe('/queue?x=1');
    for (const bad of ['//evil', 'https://evil', '/\\evil', '/login', '/api/status', 42])
      expect(safeNext(bad)).toBe('/');
    // Browsers strip tab/CR/LF from a Location URL: "/\t/evil" would become "//evil" (open redirect).
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r\nSet-Cookie: x=1', '/ok\u0000x', '/a\u007f'])
      expect(safeNext(bad), JSON.stringify(bad)).toBe('/');
    expect(safeNext('/%09/x')).toBe('/%09/x'); // percent-encoded stays a same-origin path
  });

  it('knows loopback host names', () => {
    for (const h of ['localhost', 'a.localhost', '127.0.0.1', '127.1.2.3', '[::1]'])
      expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['example.org', '10.0.0.1', '0.0.0.0']) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe('LogRing', () => {
  it('keeps the newest lines and parses pino JSON', () => {
    const ring = new LogRing(3);
    for (let i = 1; i <= 5; i++)
      ring.write(`${JSON.stringify({ level: 40, time: i, msg: `m${i}`, pid: 1, extra: i })}\n`);
    ring.write('not json\n');
    const lines = ring.since(0);
    expect(lines.map((l) => l.msg)).toEqual(['m4', 'm5', 'not json']);
    expect(lines[0]).toMatchObject({ id: 4, levelLabel: 'warn', extra: '{"extra":4}' });
    expect(ring.since(5).map((l) => l.id)).toEqual([6]);
    expect(ring.lastId).toBe(6);
  });
});

describe('targetInputFromForm', () => {
  it('maps a local target', () => {
    expect(
      targetInputFromForm({ id: 'Local-Dev', kind: 'local', dir: ' /srv/www ', label: '', enabled: 'on' }),
    ).toEqual({
      id: 'local-dev',
      kind: 'local',
      label: null,
      enabled: true,
      publicBaseUrl: null,
      dir: '/srv/www',
    });
  });

  it('keeps secrets unless given or cleared; omits pins on create', () => {
    const created = targetInputFromForm({
      id: 'sftp-main',
      kind: 'sftp',
      host: 'h.example',
      username: 'u',
      password: 'p@ss w0rd ',
      privateKey: '-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----',
      hostKeys: '',
      port: 'x',
    });
    expect(created.password).toBe('p@ss w0rd ');
    expect(created.privateKey).toBe('-----BEGIN KEY-----\nabc\n-----END KEY-----\n');
    expect(created).not.toHaveProperty('hostKeys');
    expect(created).not.toHaveProperty('privateKeyPath');
    expect(Number.isNaN(created.port)).toBe(true);
    const edited = targetInputFromForm({
      mode: 'edit',
      id: 'sftp-main',
      kind: 'sftp',
      host: 'h',
      username: 'u',
      password: '',
      clear_privateKey: 'on',
      hostKeys: 'SHA256:a\nSHA256:b, SHA256:c',
    });
    expect(edited).not.toHaveProperty('password');
    expect(edited.privateKey).toBeNull();
    expect(edited.privateKeyPath).toBeNull();
    expect(edited.hostKeys).toEqual(['SHA256:a', 'SHA256:b', 'SHA256:c']);
  });
});

describe('WaMonitor', () => {
  it('reports the traveler match and hides expired QR codes', () => {
    let now = Date.parse('2026-11-18T12:00:00Z');
    const source = new FakeSource();
    const wa = new WaMonitor({ travelerPhone: '4915100000001', travelerLid: null, now: () => new Date(now) });
    wa.attach(source);
    source.emit({ type: 'qr', code: 'qr1', expiresAt: '2026-11-18T12:00:20.000Z' });
    expect(wa.snapshot().qr?.code).toBe('qr1');
    now += 30_000;
    expect(wa.snapshot().qr).toBeNull();
    expect(wa.snapshot().traveler).toEqual({ pn: '4915100000001', lid: null, lidSource: null });
    source.emit({ type: 'traveler', pn: '4915100000001', lid: '777' });
    expect(wa.snapshot().traveler).toEqual({ pn: '4915100000001', lid: '777', lidSource: 'learned' });
    expect(wa.view()).toMatchObject({ state: 'qr', travelerLid: '777' });
    const fixed = new WaMonitor({ travelerPhone: null, travelerLid: '999' });
    expect(fixed.snapshot().traveler).toEqual({ pn: null, lid: '999', lidSource: 'config' });
  });

  it('requests a pairing code and validates the phone', async () => {
    const source = new FakeSource();
    const wa = new WaMonitor({ travelerPhone: null, travelerLid: null });
    await expect(wa.requestPairCode('4915100000009')).rejects.toMatchObject({ code: 'unavailable' });
    wa.attach(source);
    await expect(wa.requestPairCode('0049 151 0000-0009')).resolves.toBe('ABCD-EFGH');
    expect(source.sent).toEqual([{ type: 'pair_code', phone: '4915100000009' }]);
    await expect(wa.requestPairCode('123')).rejects.toBeInstanceOf(PairCodeError);
    source.pairCodeReply = null;
    await expect(wa.requestPairCode('4915100000009', 30)).rejects.toMatchObject({ code: 'timeout' });
    source.emit({ type: 'state', state: 'open', at: '2026-11-18T12:00:00.000Z' });
    await expect(wa.requestPairCode('4915100000009')).rejects.toMatchObject({ code: 'already_linked' });
    expect(normalizePhone('+49 (151) 000.000-9')).toBe('491510000009');
  });
});

describe('link page steps and human labels', () => {
  const start = Date.parse('2026-11-20T12:00:00Z');

  function monitor(over: Partial<import('../../src/ui/wa-monitor.js').WaSourceStateView> = {}) {
    let now = start;
    const source = new FakeSource();
    source.current = { ...source.current, ...over };
    const wa = new WaMonitor({ travelerPhone: '4915100000001', travelerLid: null, now: () => new Date(now) });
    wa.attach(source);
    return { wa, source, advance: (ms: number) => (now += ms) };
  }

  it('offers a new QR code when the helper stopped after the QR window (exit 7)', () => {
    const { wa, source } = monitor();
    source.emit({ type: 'qr', code: 'qr1', expiresAt: '2026-11-20T12:00:20.000Z' });
    expect(linkStep(wa.snapshot())).toBe('scan');
    source.update({
      process: 'stopped',
      wa: 'closed',
      qr: null,
      lastExit: { code: 7, signal: null, at: '2026-11-20T12:03:00.000Z', meaning: 'pairing window ended' },
    });
    const snap = wa.snapshot();
    expect(linkStep(snap)).toBe('renew');
    expect(renewText(snap)).toBe('This code expired — show a new one.');
    expect(snap.lastExit).toEqual({ code: 7, at: '2026-11-20T12:03:00.000Z', meaning: 'pairing window ended' });
    expect(waStateLabel(snap)).toBe('Disconnected');
  });

  it('offers a new code when the last QR expired and no newer one came', () => {
    const { wa, source, advance } = monitor();
    source.emit({ type: 'qr', code: 'qr1', expiresAt: '2026-11-20T12:00:20.000Z' });
    advance(30_000);
    const snap = wa.snapshot();
    expect(snap.qr).toBeNull();
    expect(snap.qrExpiredAt).toBe('2026-11-20T12:00:20.000Z');
    expect(linkStep(snap)).toBe('renew');
    source.emit({ type: 'qr', code: 'qr2', expiresAt: '2026-11-20T12:01:00.000Z' });
    expect(linkStep(wa.snapshot())).toBe('scan');
    // A restarted helper starts from scratch (no stale "expired").
    source.update({ process: 'starting', qr: null, wa: 'connecting' });
    advance(60_000);
    expect(wa.snapshot().qrExpiredAt).toBeNull();
    expect(linkStep(wa.snapshot())).toBe('waiting');
  });

  it('explains a stop for another reason, a backoff, a link and fixture mode', () => {
    const stopped = monitor({
      process: 'stopped',
      wa: 'closed',
      lastExit: { code: 2, signal: null, at: '2026-11-20T11:59:00.000Z', meaning: 'invalid configuration' },
    }).wa.snapshot();
    expect(linkStep(stopped)).toBe('renew');
    expect(renewText(stopped)).toContain('invalid configuration');
    expect(linkStep(monitor({ process: 'backoff', wa: 'closed' }).wa.snapshot())).toBe('restarting');
    const linked = monitor({ wa: 'open' }).wa.snapshot();
    expect(linkStep(linked)).toBe('linked');
    expect(waStateLabel(linked)).toBe('Linked');
    const fixture = monitor({ wa: 'open', mode: 'fixture' }).wa.snapshot();
    expect(linkStep(fixture)).toBe('fixture');
    expect(waStateLabel(fixture)).toBe('Fixture replay');
  });

  it.each([
    ['qr', 'Waiting for scan'],
    ['open', 'Linked'],
    ['closed', 'Disconnected'],
    ['logged_out', 'Logged out – link again'],
  ] as const)('labels %s as "%s" and keeps the raw state as a title', (state, label) => {
    expect(waStateLabel({ state, mode: 'observer' })).toBe(label);
    expect(waBadge({ state, mode: 'observer' }).toString()).toContain(`title="${state}">${label}</span>`);
  });

  it('shows a pairing code only while it is valid', async () => {
    const { wa, source, advance } = monitor();
    source.pairCodeReply = 'ABCD-EFGH';
    await expect(wa.requestPairCode('4915100000009')).resolves.toBe('ABCD-EFGH');
    expect(wa.snapshot().pairCode).toEqual({
      code: 'ABCD-EFGH',
      at: '2026-11-20T12:00:00.000Z',
      validUntil: new Date(start + PAIR_CODE_VALID_MS).toISOString(),
    });
    advance(PAIR_CODE_VALID_MS + 1);
    expect(wa.snapshot().pairCode).toBeNull();
  });
});

describe('publish state in words', () => {
  const status = (lastResults: DeployResultView[]) =>
    ({ publish: { targets: 1, running: false, lastResults } }) as unknown as Pick<AppStatus, 'publish'>;
  const ok: DeployResultView = { targetId: 'local', ok: true, version: 3, uploaded: 1, deleted: 0 };

  it('is "live" only when the post-deploy check passed or was skipped', () => {
    expect(publishSummary(status([{ ...ok, httpCheck: 'ok' }]))).toMatchObject({ label: 'live', tone: 'ok' });
    expect(publishSummary(status([{ ...ok, httpCheck: 'skipped' }]))).toMatchObject({ label: 'live', tone: 'ok' });
    expect(publishSummary(status([{ ...ok, httpCheck: 'error', httpDetail: 'fetch failed' }]))).toEqual({
      label: 'deployed, site not reachable',
      tone: 'warn',
      unreachable: true,
    });
    expect(publishSummary(status([{ ...ok, httpCheck: 'mismatch' }]))).toMatchObject({ tone: 'warn' });
    expect(publishSummary(status([{ ...ok, ok: false }]))).toMatchObject({ label: 'failed', tone: 'bad' });
  });

  it('knows the URL the check fetched', () => {
    const urls = checkUrlsOf(
      [
        { id: 'local', kind: 'local', publicBaseUrl: 'http://127.0.0.1:19165' },
        { id: 'sftp-main', kind: 'sftp' },
        { id: 'sftp-other', kind: 'sftp', publicBaseUrl: 'https://other.example/site/' },
        { id: 'folder', kind: 'local' },
      ],
      'https://example.org/',
    );
    expect(Object.fromEntries(urls)).toEqual({
      local: 'http://127.0.0.1:19165/data/manifest.json',
      'sftp-main': 'https://example.org/data/manifest.json',
      'sftp-other': 'https://other.example/site/data/manifest.json',
    });
  });
});

describe('queue on a phone', () => {
  const row = (state: string, extra: Partial<CaptureRow> = {}): CaptureRow =>
    ({
      sourceKey: `wa:${state.toUpperCase()}1`,
      kind: 'photo',
      occurredAt: '2026-11-20T10:00:00.000Z',
      state,
      downloadState: 'failed',
      downloadReason: null,
      downloadPermanent: null,
      attempts: 3,
      nextAttemptAt: null,
      lastError: 'boom',
      revokedAt: null,
      ...extra,
    }) as unknown as CaptureRow;

  it('renders rows as labelled cards with the actions on their own line', () => {
    const htmlOut = queueFragment([row('failed'), row('media_lost')], [], [], 'csrf', Date.now()).toString();
    expect(htmlOut).toContain('<table class="table cards">');
    expect(htmlOut).toContain('data-label="State"');
    expect(htmlOut).toMatch(/class="nowrap cell-actions\s*">[\s\S]*Retry[\s\S]*Skip/);
    // Human state labels, raw state on hover.
    expect(htmlOut).toContain('title="media_lost">Media lost</span>');
    expect(htmlOut).toContain('title="failed">Failed</span>');
  });
});
