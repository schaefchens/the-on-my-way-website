/**
 * Gate-mode deploys (spec-wave5 §5.6.1–§5.6.4, §8.4) against the fake SFTP server, with the real
 * generator output in gate mode: deploy order (gate _/ → root files → /.htaccess last → content
 * phases → manifest), /.htaccess only when changed, refusal without atomic replace, never touching
 * /<secret>/, /.omw-store/ or /.well-known/ from the gate deploy, the gate check after a deploy,
 * store-only targets, and the one-off migration (dry run lists legacy paths minus gate paths;
 * --confirm deletes).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturesPresent } from '../../src/generator/dev/fixtures.js';
import {
  createPublisher,
  encodeRecord,
  GATE_RECORD_NAME,
  type ServiceSessionSource,
  type StoredTarget,
} from '../../src/publisher/index.js';
import { createHarness, GATE_SECRET, type Harness } from '../generator/harness.js';
import { FakeServer } from './fakeRemote.js';
import { localTarget, sftpTarget, silentLog, staticTargets } from './helpers.js';

const present = fixturesPresent();
const CONTENT = `/${GATE_SECRET}`;
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

/** An Apache-like answer to the gate check's requests (spec-wave5 §5.6.3). */
function gateSite(opts: { version: () => number; neutral: () => Buffer; open?: boolean; valid?: Set<string> }) {
  const requests: { url: string; cookie: string | null; redirect: string | undefined }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers.cookie ?? null;
    requests.push({ url, cookie, redirect: init?.redirect });
    const path = new URL(url).pathname;
    const value = cookie?.split('=')[1] ?? null;
    const allowed = opts.open || (value !== null && (opts.valid?.has(value) ?? false));
    if (path.startsWith(`${CONTENT}/data/`)) {
      if (allowed && path === `${CONTENT}/data/manifest.json`) {
        return new Response(JSON.stringify({ version: opts.version() }), { status: 200 });
      }
      return allowed
        ? new Response('missing', { status: 404 })
        : new Response('Forbidden\n', { status: 403, headers: { 'content-length': '10' } });
    }
    return new Response(new Uint8Array(opts.neutral()), { status: 200 });
  };
  return { fetch, requests };
}

function setup(
  hh: Harness,
  opts: {
    server?: FakeServer;
    target?: StoredTarget;
    targets?: StoredTarget[];
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    serviceSession?: ServiceSessionSource | null;
  } = {},
) {
  const server = opts.server ?? new FakeServer();
  const target = opts.target ?? sftpTarget('live', { remoteRoot: CONTENT, gateRoot: '/' });
  const sleeps: number[] = [];
  const publisher = createPublisher({
    config: hh.config,
    log: silentLog,
    store: hh.store,
    targets: staticTargets(opts.targets ?? [target]),
    connect: async () => server.connect(),
    hashCacheFile: null,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch:
      opts.fetch ??
      (async () => {
        throw new Error('host blocks this IP');
      }),
    ...(opts.serviceSession !== undefined ? { serviceSession: opts.serviceSession } : {}),
    now: hh.clock,
  });
  return { server, publisher, sleeps };
}

/** Final paths in the order they were renamed into place (the moment a file went live). */
function liveOrder(server: FakeServer, from = 0): string[] {
  return server.log
    .slice(from)
    .filter((l) => l.startsWith('rename '))
    .map((l) => l.slice('rename '.length))
    .filter((p) => !p.split('/').some((s) => s.startsWith('.omw-')));
}

describe.skipIf(!present)('gate-mode deploy (spec-wave5 §5.6.2)', () => {
  it('order: gate _/assets → gate pages → robots, favicon, index.html → /.htaccess → content phases → manifest', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { server, publisher } = setup(h);
    const [r] = await publisher.deploy();
    expect(r?.ok, r?.error).toBe(true);
    const order = liveOrder(server);
    const htaccess = order.indexOf('/.htaccess');
    const firstContent = order.findIndex((p) => p.startsWith(`${CONTENT}/`));
    expect(htaccess).toBeGreaterThan(0);
    // /.htaccess is the last gate file; the content follows.
    expect(order.slice(0, htaccess).every((p) => !p.startsWith(`${CONTENT}/`))).toBe(true);
    expect(firstContent).toBe(htaccess + 1);
    const gate = order.slice(0, htaccess);
    const lastAsset = Math.max(...gate.map((p, i) => (p.startsWith('/_/assets/') ? i : -1)));
    const firstPage = gate.findIndex((p) => p.startsWith('/_/') && !p.startsWith('/_/assets/'));
    expect(lastAsset).toBeLessThan(firstPage);
    expect(gate.slice(-3)).toEqual(['/robots.txt', '/favicon.svg', '/index.html']);
    // The content tree keeps today's order: … pages (incl. its .htaccess) … manifest last.
    expect(order.at(-1)).toBe(`${CONTENT}/data/manifest.json`);
    expect(order).toContain(`${CONTENT}/.htaccess`);
    expect(order.indexOf(`${CONTENT}/.htaccess`)).toBeLessThan(order.indexOf(`${CONTENT}/data/manifest.json`));
    // The gate record lists exactly the gate tree.
    const record = JSON.parse(server.files.get(`/${GATE_RECORD_NAME}`)?.toString() ?? '{}') as {
      files: Record<string, string>;
    };
    expect(Object.keys(record.files).sort()).toEqual(
      gate
        .map((p) => p.slice(1))
        .concat('.htaccess')
        .sort(),
    );
    expect(r?.gate).toMatchObject({ htaccess: true });
    // A blocked host (network error) is never "gate open": the deploy stays ok.
    expect(r?.gateCheck?.result).toBe('error');
    expect(r?.httpCheck).toBe('error');
  });

  it('/.htaccess is uploaded only when it changed; an unchanged gate tree needs no connection', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { server, publisher } = setup(h);
    await publisher.deploy();
    const before = server.log.length;
    const connections = server.connections;
    const [same] = await publisher.deploy();
    expect(same?.ok).toBe(true);
    expect(server.connections).toBe(connections);
    expect(server.log.length).toBe(before);
    // A content change: content files only.
    h.clock.advance(60_000);
    h.store.owner.setSetting('site.title', 'Unterwegs mit Lea');
    await h.generator.generate();
    const mark = server.log.length;
    const [content] = await publisher.deploy();
    expect(content?.ok, content?.error).toBe(true);
    expect(content?.gate).toEqual({ uploaded: 0, deleted: 0, htaccess: false });
    expect(liveOrder(server, mark).every((p) => p.startsWith(`${CONTENT}/`))).toBe(true);
    // A gate change (default locale → page boot and neutral language order): /.htaccess untouched.
    h.store.owner.setSetting('site.default_locale', 'en');
    await h.generator.generate();
    const mark2 = server.log.length;
    const [gate] = await publisher.deploy();
    expect(gate?.ok, gate?.error).toBe(true);
    const changed = liveOrder(server, mark2).filter((p) => !p.startsWith(`${CONTENT}/`));
    expect(changed).toEqual(expect.arrayContaining(['/_/n/index.html', '/_/join/index.html', '/index.html']));
    expect(changed).not.toContain('/.htaccess');
    expect(gate?.gate?.htaccess).toBe(false);
  });

  it('refuses a connection without atomic replace (gate_config), before writing anything', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { server, publisher } = setup(h, { server: new FakeServer({ atomicReplace: false }) });
    const [r] = await publisher.deploy();
    expect(r?.ok).toBe(false);
    expect(r?.errorCode).toBe('gate_config');
    expect(r?.error).toMatch(/atomic replace/);
    expect(server.mutations).toBe(0);
  });

  it('refuses targets that cannot carry the gate (no gateRoot, content root not gateRoot/<secret>)', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    for (const target of [
      sftpTarget('a', { remoteRoot: CONTENT }),
      sftpTarget('b', { remoteRoot: '/www', gateRoot: '/' }),
      localTarget('c', join(h.dir, 'site', GATE_SECRET)),
      localTarget('d', join(h.dir, 'site', 'other'), { gateDir: join(h.dir, 'site') } as Partial<StoredTarget>),
    ]) {
      const { publisher, server } = setup(h as Harness, { target });
      const [r] = await publisher.deploy();
      expect([r?.ok, r?.errorCode], target.id).toEqual([false, 'gate_config']);
      expect(server.mutations, target.id).toBe(0);
    }
  });

  it('never touches /<secret>/, /.omw-store/ or /.well-known/ from the gate record; removes old gate files', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const server = new FakeServer();
    const keep = ['/.omw-store/s/abcdefghijkl/abcdefgh.x', '/.well-known/acme-challenge/tok', `${CONTENT}/de/old.html`];
    for (const p of [...keep, '/_/assets/gate-old.js']) {
      server.files.set(p, Buffer.from('x'));
      for (let d = dirname(p); d !== '/'; d = dirname(d)) server.dirs.add(d);
    }
    // A hand-edited gate record naming foreign paths.
    server.files.set(
      `/${GATE_RECORD_NAME}`,
      Buffer.from(
        JSON.stringify({
          format: 1,
          files: Object.fromEntries([...keep, '/_/assets/gate-old.js'].map((p) => [p.slice(1), 'a'.repeat(64)])),
        }),
      ),
    );
    const { publisher } = setup(h, { server });
    const [r] = await publisher.deploy();
    expect(r?.ok, r?.error).toBe(true);
    for (const p of keep) expect(server.files.has(p), p).toBe(true);
    expect(server.files.has('/_/assets/gate-old.js')).toBe(false);
    expect(r?.gate?.deleted).toBe(1);
  });

  it('refuses a content tree with another .htaccess (it could switch the gate off)', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    mkdirSync(join(h.outDir, 'de'), { recursive: true });
    writeFileSync(join(h.outDir, 'de', '.htaccess'), 'RewriteEngine Off\n');
    const { publisher, server } = setup(h);
    const [r] = await publisher.deploy();
    expect([r?.ok, r?.errorCode]).toEqual([false, 'gate_config']);
    expect(r?.error).toMatch(/another \.htaccess/);
    expect(server.mutations).toBe(0);
  });

  it('store-only targets (publish: false) are never deployed', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const storeOnly = sftpTarget('store', { publish: false, accessStoreRoot: '/omw-store/site1' });
    const { publisher, server } = setup(h, { targets: [storeOnly] });
    expect(await publisher.deploy()).toEqual([]);
    const [named] = await publisher.deploy({ targetId: 'store' });
    expect([named?.ok, named?.errorCode]).toEqual([false, 'config']);
    expect(server.connections).toBe(0);
  });

  it('a local target in gate mode: gate tree at gateDir, content at gateDir/<secret>', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const web = join(h.dir, 'web');
    const target = localTarget('local', join(web, GATE_SECRET), { gateDir: web } as Partial<StoredTarget>);
    const publisher = createPublisher({
      config: h.config,
      log: silentLog,
      store: h.store,
      targets: staticTargets([target]),
      hashCacheFile: null,
      fetch: async () => {
        throw new Error('offline');
      },
      sleep: async () => {},
    });
    const [r] = await publisher.deploy();
    expect(r?.ok, r?.error).toBe(true);
    const { existsSync, readFileSync } = await import('node:fs');
    expect(readFileSync(join(web, '.htaccess'), 'utf8')).toContain('# >>> omw gate v1');
    expect(existsSync(join(web, '_/n/index.html'))).toBe(true);
    expect(existsSync(join(web, GATE_SECRET, 'data/manifest.json'))).toBe(true);
    expect(existsSync(join(web, GATE_SECRET, '.htaccess'))).toBe(true);
    expect(existsSync(join(web, 'data'))).toBe(false);
  });
});

describe.skipIf(!present)('the gate check after a deploy (spec-wave5 §5.6.3)', () => {
  function sessions(): ServiceSessionSource & { values: string[] } {
    const values: string[] = [];
    let n = 0;
    return {
      values,
      rotate: async () => {
        const prev = values.at(-1) ?? null;
        const next = `abcdefghijkl.abcdefgh.${String(++n).repeat(43).slice(0, 43)}`;
        values.push(next);
        return {
          current: { name: '__Host-omw', value: next },
          previous: prev ? { name: '__Host-omw', value: prev } : null,
        };
      },
    };
  }

  it('passes with the new session accepted and the previous refused; skipped when nothing changed < 6 h', async () => {
    h = await createHarness({ gate: true });
    const r0 = await h.generator.generate();
    const { readFileSync } = await import('node:fs');
    const ss = sessions();
    const valid = new Set<string>();
    const site = gateSite({
      version: () => h?.store.meta.siteVersion() ?? r0.version,
      neutral: () => readFileSync(join(h?.gateOutDir ?? '', '_/n/index.html')),
      valid,
    });
    // The writer applied the newest session only.
    const rotating: ServiceSessionSource = {
      rotate: async () => {
        const r = await ss.rotate();
        valid.clear();
        if (r) valid.add(r.current.value);
        return r;
      },
    };
    const { publisher, sleeps } = setup(h, { fetch: site.fetch, serviceSession: rotating });
    const [first] = await publisher.deploy();
    expect(first?.gateCheck).toMatchObject({ by: 'mac', result: 'ok' });
    expect(first?.httpCheck).toBe('ok');
    // First run: no previous session, #5 skipped → 4 requests, 2 s apart, never following redirects.
    expect(site.requests).toHaveLength(4);
    expect(sleeps.filter((s) => s === 2000)).toHaveLength(3);
    expect(site.requests.every((q) => q.redirect === 'manual')).toBe(true);
    expect(site.requests.slice(0, 3).every((q) => q.cookie === null)).toBe(true);
    // Unchanged and checked less than 6 h ago: skipped without a request.
    const [again] = await publisher.deploy();
    expect(again?.gateCheck?.result).toBe('skipped');
    expect(site.requests).toHaveLength(4);
    // Older than 6 h: checked again, now with #5 (the previous session must be refused).
    h.clock.advance(6 * 60 * 60_000 + 1);
    const [later] = await publisher.deploy();
    expect(later?.gateCheck?.result).toBe('ok');
    expect(site.requests).toHaveLength(9);
    expect(site.requests.at(-1)?.cookie).toBe(`__Host-omw=${ss.values[0]}`);
  });

  it('gate_open re-uploads both .htaccess files once and fails the deploy when still open', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { readFileSync } = await import('node:fs');
    const site = gateSite({
      version: () => 1,
      neutral: () => readFileSync(join(h?.gateOutDir ?? '', '_/n/index.html')),
      open: true,
    });
    const { publisher, server } = setup(h, { fetch: site.fetch, serviceSession: null });
    const mark = server.log.length;
    const [r] = await publisher.deploy();
    expect(r?.ok).toBe(false);
    expect(r?.errorCode).toBe('gate_open');
    expect(r?.error).toMatch(/^gate_open: /);
    expect(r?.gateCheck?.result).toBe('gate_open');
    const renames = liveOrder(server, mark);
    expect(renames.filter((p) => p === '/.htaccess')).toHaveLength(2);
    expect(renames.filter((p) => p === `${CONTENT}/.htaccess`)).toHaveLength(2);
  });

  it('store_unverified (the created session is refused) travels in gateCheck without failing the deploy', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { readFileSync } = await import('node:fs');
    const site = gateSite({
      version: () => 1,
      neutral: () => readFileSync(join(h?.gateOutDir ?? '', '_/n/index.html')),
      valid: new Set(),
    });
    const { publisher } = setup(h, { fetch: site.fetch, serviceSession: sessions() });
    const [r] = await publisher.deploy();
    expect(r?.ok).toBe(true);
    expect(r?.gateCheck?.result).toBe('store_unverified');
    expect(r?.httpCheck).toBe('mismatch');
  });
});

describe.skipIf(!present)('migrate-to-gate (spec-wave5 §5.6.4)', () => {
  function legacyServer(): FakeServer {
    const server = new FakeServer();
    const legacy = [
      'de/index.html',
      'data/manifest.json',
      'media/ab/0123456789abcdef_w640.avif',
      'index.html',
      'robots.txt',
      '.htaccess',
      '404.html',
    ];
    for (const p of legacy) {
      server.files.set(`/${p}`, Buffer.from(`old ${p}`));
      for (let d = dirname(`/${p}`); d !== '/'; d = dirname(d)) server.dirs.add(d);
    }
    server.files.set(
      '/.omw-deploy.json.gz',
      encodeRecord({
        format: 'omw-deploy/1',
        target: 'live',
        version: 3,
        deployedAt: '2026-11-01T00:00:00.000Z',
        files: Object.fromEntries(legacy.map((p) => [p, ['a'.repeat(64), 1]])),
        obsoleteSince: {},
      }),
    );
    return server;
  }

  it('dry run lists the legacy root paths minus every gate tree path; --confirm deletes them and the record', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const server = legacyServer();
    const { publisher } = setup(h, { server });
    const dry = await publisher.migrateToGate('live');
    expect(dry.deploy.ok, dry.deploy.error).toBe(true);
    expect(dry.legacy).toEqual([
      '404.html',
      'data/manifest.json',
      'de/index.html',
      'media/ab/0123456789abcdef_w640.avif',
    ]);
    expect(dry.deleted).toBe(0);
    expect(server.files.get('/de/index.html')?.toString()).toBe('old de/index.html');
    // The gate tree replaced the colliding root files; the content went to /<secret>/.
    expect(server.files.get('/index.html')?.toString()).toContain('Privat · Private');
    expect(server.files.has(`${CONTENT}/data/manifest.json`)).toBe(true);
    const done = await publisher.migrateToGate('live', { confirm: true });
    expect(done.deleted).toBe(4);
    expect(done.recordRemoved).toBe(true);
    for (const p of done.legacy) expect(server.files.has(`/${p}`), p).toBe(false);
    expect(server.files.has('/.omw-deploy.json.gz')).toBe(false);
    expect(server.dirs.has('/de')).toBe(false);
    expect(server.files.has('/.htaccess')).toBe(true);
    expect(server.files.has(`${CONTENT}/.omw-deploy.json.gz`)).toBe(true);
  });

  it('refuses outside gate mode and for a target without gateRoot "/"', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const { publisher } = setup(h, {
      target: sftpTarget('live', { remoteRoot: `/www/${GATE_SECRET}`, gateRoot: '/www' }),
    });
    await expect(publisher.migrateToGate('live')).rejects.toThrow(/gateRoot "\/"/);
    const open = await createHarness();
    try {
      const { publisher: p2 } = setup(open);
      await expect(p2.migrateToGate('live')).rejects.toThrow(/ACCESS_MODE=gate/);
    } finally {
      open.cleanup();
    }
  });
});
