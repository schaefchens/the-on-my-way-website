import type { WaCommand, WaEvent } from '@omw/contracts/wa';
import { Store } from '../../src/store/index.js';
import { LogRing } from '../../src/ui/log-ring.js';
import type { AppStatus, ControlBackend, DeployResultView } from '../../src/ui/types.js';
import { WaMonitor, type WaSourceLike, type WaSourceStateView } from '../../src/ui/wa-monitor.js';

export class FakeSource implements WaSourceLike {
  sent: WaCommand[] = [];
  current: WaSourceStateView = {
    wa: 'qr',
    mode: 'observer',
    process: 'running',
    traveler: { pn: '4915100000001', lid: null },
    stats: {},
  };
  private listeners = new Set<(e: WaEvent) => void>();
  private stateListeners = new Set<(s: WaSourceStateView) => void>();

  onStateChange(cb: (s: WaSourceStateView) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Like HelperSource.update(): process lifecycle, exit codes, QR cleared. */
  update(patch: Partial<WaSourceStateView>): void {
    this.current = { ...this.current, ...patch };
    for (const l of this.stateListeners) l(this.current);
  }
  /** Answer pair_code commands with this code (null = never answer). */
  pairCodeReply: string | null = 'ABCD-EFGH';

  send(cmd: WaCommand): void {
    this.sent.push(cmd);
    if (cmd.type === 'pair_code' && this.pairCodeReply) {
      const code = this.pairCodeReply;
      setTimeout(() => this.emit({ type: 'pair_code', code }), 5);
    }
  }
  state(): WaSourceStateView {
    return this.current;
  }
  onEvent(cb: (e: WaEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(e: WaEvent): void {
    if (e.type === 'qr') this.current = { ...this.current, wa: 'qr', qr: { code: e.code, expiresAt: e.expiresAt } };
    if (e.type === 'state')
      this.current = { ...this.current, wa: e.state, ...(e.state === 'open' ? { qr: null } : {}) };
    for (const l of this.listeners) l(e);
  }
}

export function sampleStatus(over: Partial<AppStatus> = {}): AppStatus {
  const now = new Date().toISOString();
  return {
    app: 'omw-backend',
    version: '0.1.0-test',
    env: 'test',
    startedAt: now,
    now,
    uptimeS: 1,
    stopping: false,
    wa: {
      mode: 'observer',
      state: 'open',
      reason: null,
      detail: null,
      until: null,
      jid: '4915100000009@s.whatsapp.net',
      process: 'running',
      restarts: 0,
      helperVersion: '1.0',
      nextRestartAt: null,
      qr: null,
      pairCode: null,
      traveler: { pn: '4915100000001', lid: '123', lidSource: 'learned' },
      lastStatusAt: now,
      lastEventAt: now,
      stats: { captured: 2 },
    },
    captures: { byState: { ready: 2, failed: 1 }, total: 3, lastStatusAt: now },
    ingest: {},
    disk: { freeBytes: 10 * 1024 ** 3 },
    sync: {
      enabled: true,
      baseUrl: 'https://api.example.org',
      authPausedUntil: null,
      lastPullAt: now,
      lastPullError: null,
      lastPushAt: now,
      lastPushError: null,
      lastHeartbeatAt: now,
      lastHeartbeatError: null,
      feedId: 'feed_aaaaaaaa',
      feedSeq: 5,
      rebuilding: false,
      quarantined: 0,
      queue: { pending: 0, failed: 0, oldestAt: null },
    },
    build: { running: false, pending: null, last: null, lastError: null, nextPublishAt: null },
    publish: {
      running: false,
      queued: false,
      targets: 1,
      state: {},
      lastResults: [],
      lastAt: null,
      nextRetryAt: null,
    },
    site: { publicUrl: 'https://example.org/', outDir: '/tmp/out' },
    ...over,
  };
}

export interface FakeBackend extends ControlBackend {
  calls: string[];
  source: FakeSource;
  targetList: Record<string, unknown>[];
  saved: Record<string, unknown>[];
  statusValue: AppStatus;
}

export function fakeBackend(): FakeBackend {
  const store = Store.memory();
  const source = new FakeSource();
  const wa = new WaMonitor({ travelerPhone: '4915100000001', travelerLid: null });
  wa.attach(source);
  const logRing = new LogRing(100);
  const calls: string[] = [];
  const results: DeployResultView[] = [{ targetId: 'local', ok: true, version: 3, uploaded: 2, deleted: 0 }];
  const b: FakeBackend = {
    calls,
    source,
    store,
    wa,
    logRing,
    statusValue: sampleStatus(),
    targetList: [
      {
        id: 'sftp-main',
        kind: 'sftp',
        label: '<script>alert(1)</script>',
        enabled: true,
        publicBaseUrl: 'https://example.org/',
        host: 'www99.your-server.de',
        port: 22,
        username: 'user',
        auth: 'password',
        hasPassword: true,
        hasPrivateKey: false,
        hasPassphrase: false,
        privateKeyPath: null,
        hostKeys: ['SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs'],
        trustOnFirstUse: false,
        remoteRoot: '/',
        concurrency: 4,
        status: {
          lastDeploy: null,
          deployedVersion: 3,
          deployedAt: new Date().toISOString(),
          authBlocked: null,
          deferredDeletes: 0,
        },
      },
    ],
    saved: [],
    async status() {
      return b.statusValue;
    },
    targets: {
      list: () => b.targetList,
      save: (input) => {
        calls.push('targets.save');
        if (!input.id) throw new Error('id: Expected a lowercase id');
        b.saved.push(input);
        return { ...input, password: undefined };
      },
      remove: (id) => {
        calls.push(`targets.remove:${id}`);
      },
      test: async (id) => {
        calls.push(`targets.test:${id}`);
        return { ok: true, detail: 'connected, root writable' };
      },
    },
    async rebuild(full) {
      calls.push(`rebuild:${full}`);
      return { version: 4, changed: 3, removed: 0, full, durationMs: 12 };
    },
    async publishNow(targetId, opts) {
      calls.push(`publish:${targetId ?? 'all'}${opts?.force ? ':force' : ''}`);
      return results;
    },
    async reprocess(sourceKey) {
      calls.push(`reprocess:${sourceKey ?? 'all'}`);
      return 2;
    },
    pairCode: (phone) => wa.requestPairCode(phone, 500),
    retryCapture(sourceKey) {
      calls.push(`retry:${sourceKey}`);
      return { ok: true, detail: `Retrying ${sourceKey}.` };
    },
    skipCapture(sourceKey) {
      calls.push(`skip:${sourceKey}`);
      return { ok: false, detail: 'not skippable' };
    },
    async syncPull() {
      calls.push('sync.pull');
      return 1;
    },
    resyncCaptures() {
      calls.push('sync.resync');
      return 5;
    },
    async restartWa() {
      calls.push('wa.restart');
      return { ok: true, detail: 'restarted' };
    },
    quarantined: () => [],
  };
  return b;
}
