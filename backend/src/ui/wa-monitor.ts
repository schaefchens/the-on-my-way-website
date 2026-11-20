/**
 * WhatsApp state for the control UI and the heartbeat: wraps the WaSource (backend/src/capture),
 * fans its events out to SSE clients (live QR, connection state, pairing code) and answers
 * "what is the traveler match?".
 */
import { PhoneDigits, type WaCommand, type WaEvent, type WaState } from '@omw/contracts/wa';
import type { WaView } from '../sync/index.js';

/** The parts of capture's WaSourceState the UI reads (structural, see capture/types.ts). */
export interface WaSourceStateView {
  mode?: string;
  wa: WaState;
  reason?: string | null;
  detail?: string | null;
  until?: string | null;
  jid?: string | null;
  process?: string;
  restarts?: number;
  helperVersion?: string | null;
  nextRestartAt?: string | null;
  /** Last helper exit (capture/types.ts WaSourceState.lastExit). */
  lastExit?: { code: number | null; signal?: string | null; at: string; meaning: string } | null;
  qr?: { code: string; expiresAt: string } | null;
  pairCode?: string | null;
  traveler?: { pn: string | null; lid: string | null };
  lastStatusAt?: string | null;
  lastEventAt?: string | null;
  stats?: Record<string, number>;
}

export interface WaSourceLike {
  send(cmd: WaCommand): void;
  state(): WaSourceStateView;
  onEvent(cb: (e: WaEvent) => void): () => void;
  onStateChange?(cb: (s: WaSourceStateView) => void): () => void;
}

export interface WaSnapshot {
  mode: string | null;
  state: WaState;
  reason: string | null;
  detail: string | null;
  until: string | null;
  jid: string | null;
  process: string | null;
  restarts: number;
  helperVersion: string | null;
  nextRestartAt: string | null;
  /** Current pairing QR (null once expired or linked). */
  qr: { code: string; expiresAt: string } | null;
  /**
   * Expiry of the last QR when it ran out and no newer one came (the pairing window may have
   * ended: the helper then exits 7 and waits for a restart). Null while a valid QR exists.
   */
  qrExpiredAt?: string | null;
  /** Last helper exit: code 7 = the pairing window ended without a link (no automatic restart). */
  lastExit?: { code: number | null; at: string; meaning: string } | null;
  /** Pairing code while it is valid (WhatsApp accepts it for a few minutes). */
  pairCode: { code: string; at: string; validUntil?: string } | null;
  traveler: {
    /** TRAVELER_PHONE (digits) or what the helper reported. */
    pn: string | null;
    lid: string | null;
    lidSource: 'config' | 'learned' | null;
  };
  lastStatusAt: string | null;
  lastEventAt: string | null;
  stats: Record<string, number>;
}

export type WaMonitorEvent =
  | { type: 'state'; snapshot: WaSnapshot }
  | { type: 'qr'; code: string; expiresAt: string }
  | { type: 'pair_code'; code: string };

export interface WaMonitorOptions {
  travelerPhone: string | null;
  /** TRAVELER_LID override from the environment. */
  travelerLid: string | null;
  now?: () => Date;
}

/** How long WhatsApp accepts a pairing code (approximate; whatsmeow does not report it). */
export const PAIR_CODE_VALID_MS = 3 * 60_000;

/** Exit code of the helper when the pairing window ended without a link (restart-policy.ts). */
export const EXIT_PAIRING_ENDED = 7;

export class WaMonitor {
  private source: WaSourceLike | null = null;
  private readonly listeners = new Set<(e: WaMonitorEvent) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private lastPairCode: { code: string; at: string } | null = null;
  /** The newest QR seen (kept after it expired, to tell "expired" from "none yet"). */
  private lastQr: { code: string; expiresAt: string } | null = null;
  private learnedLid: string | null = null;
  private readonly now: () => Date;

  private readonly options: WaMonitorOptions;

  constructor(options: WaMonitorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  attach(source: WaSourceLike): void {
    this.detach();
    this.source = source;
    this.unsubscribe.push(source.onEvent((e) => this.handle(e)));
    if (source.onStateChange) {
      this.unsubscribe.push(
        source.onStateChange((s) => {
          // A (re)started helper or a link makes the old QR history meaningless.
          if (s.process === 'starting' || s.wa === 'open') this.lastQr = null;
          if (s.qr) this.lastQr = s.qr;
          // Process lifecycle (stopped / backoff / exit code) reaches open pages via SSE.
          this.emit({ type: 'state', snapshot: this.snapshot() });
        }),
      );
    }
  }

  detach(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.source = null;
  }

  private handle(e: WaEvent): void {
    switch (e.type) {
      case 'qr':
        this.lastQr = { code: e.code, expiresAt: e.expiresAt };
        this.emit({ type: 'qr', code: e.code, expiresAt: e.expiresAt });
        break;
      case 'pair_code':
        this.lastPairCode = { code: e.code, at: this.now().toISOString() };
        this.emit({ type: 'pair_code', code: e.code });
        break;
      case 'traveler':
        if (e.lid) this.learnedLid = e.lid;
        this.emit({ type: 'state', snapshot: this.snapshot() });
        break;
      case 'state':
      case 'ready':
        this.emit({ type: 'state', snapshot: this.snapshot() });
        break;
      default:
        break;
    }
  }

  private emit(e: WaMonitorEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // a broken SSE client must not affect the others
      }
    }
  }

  subscribe(cb: (e: WaMonitorEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  snapshot(): WaSnapshot {
    let s: WaSourceStateView | null = null;
    try {
      s = this.source?.state() ?? null;
    } catch {
      s = null;
    }
    const nowMs = this.now().getTime();
    const qr = s?.qr && Date.parse(s.qr.expiresAt) > nowMs && s.wa !== 'open' ? s.qr : null;
    const lastQr = s?.qr ?? this.lastQr;
    const qrExpiredAt =
      !qr && s?.wa !== 'open' && lastQr && Date.parse(lastQr.expiresAt) <= nowMs ? lastQr.expiresAt : null;
    const configLid = this.options.travelerLid;
    const learned = s?.traveler?.lid ?? this.learnedLid;
    const seenCode =
      this.lastPairCode ?? (s?.pairCode && s.lastEventAt ? { code: s.pairCode, at: s.lastEventAt } : null);
    const codeValidUntil = seenCode ? Date.parse(seenCode.at) + PAIR_CODE_VALID_MS : Number.NaN;
    // A stale code is never shown again (it would only fail on the phone).
    const pairCode =
      seenCode && Number.isFinite(codeValidUntil) && codeValidUntil > nowMs
        ? { ...seenCode, validUntil: new Date(codeValidUntil).toISOString() }
        : null;
    const exit = s?.lastExit ?? null;
    return {
      mode: s?.mode ?? null,
      state: s?.wa ?? 'closed',
      reason: s?.reason ?? null,
      detail: s?.detail ?? null,
      until: s?.until ?? null,
      jid: s?.jid ?? null,
      process: s?.process ?? null,
      restarts: s?.restarts ?? 0,
      helperVersion: s?.helperVersion ?? null,
      nextRestartAt: s?.nextRestartAt ?? null,
      qr,
      qrExpiredAt,
      lastExit: exit ? { code: exit.code, at: exit.at, meaning: exit.meaning } : null,
      pairCode: s?.wa === 'open' ? null : pairCode,
      traveler: {
        pn: this.options.travelerPhone ?? s?.traveler?.pn ?? null,
        lid: configLid ?? learned ?? null,
        lidSource: configLid ? 'config' : learned ? 'learned' : null,
      },
      lastStatusAt: s?.lastStatusAt ?? null,
      lastEventAt: s?.lastEventAt ?? null,
      stats: { ...(s?.stats ?? {}) },
    };
  }

  /** What the heartbeat reports. */
  view(): WaView {
    const snap = this.snapshot();
    return {
      state: snap.state,
      jid: snap.jid,
      travelerPn: snap.traveler.pn,
      travelerLid: snap.traveler.lid,
      stats: snap.stats,
    };
  }

  /**
   * Asks the helper for a pairing code for the OBSERVER phone number (the account being linked)
   * and waits for the `pair_code` event.
   */
  async requestPairCode(phoneInput: string, timeoutMs = 30_000): Promise<string> {
    const phone = normalizePhone(phoneInput);
    const parsed = PhoneDigits.safeParse(phone);
    if (!parsed.success) throw new PairCodeError('invalid_phone', 'Expected the phone number in international format');
    const source = this.source;
    if (!source) throw new PairCodeError('unavailable', 'WhatsApp source is not running');
    const state = this.snapshot().state;
    if (state === 'open') throw new PairCodeError('already_linked', 'Already linked (state open)');
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new PairCodeError('timeout', 'No pairing code from the helper (is it waiting for a link?)'));
      }, timeoutMs);
      const off = this.subscribe((e) => {
        if (e.type === 'pair_code') {
          clearTimeout(timer);
          off();
          resolve(e.code);
        }
      });
      try {
        source.send({ type: 'pair_code', phone: parsed.data });
      } catch (err) {
        clearTimeout(timer);
        off();
        reject(new PairCodeError('unavailable', err instanceof Error ? err.message : String(err)));
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Human wording (control UI): labels for the raw states, and what the link page should offer.

const WA_LABELS: Record<WaState, string> = {
  open: 'Linked',
  connecting: 'Connecting…',
  pairing: 'Pairing…',
  qr: 'Waiting for scan',
  closed: 'Disconnected',
  logged_out: 'Logged out – link again',
  stream_replaced: 'Replaced by another session',
  banned: 'Temporarily banned',
  error: 'Error',
};

/** "Waiting for scan" for "qr", etc.; fixture mode replays recordings and links nothing. */
export function waStateLabel(snapshot: Pick<WaSnapshot, 'state' | 'mode'>): string {
  if (snapshot.mode === 'fixture') return 'Fixture replay';
  return WA_LABELS[snapshot.state] ?? snapshot.state;
}

/**
 * What the link page shows:
 * - fixture: nothing to link (recorded statuses are replayed);
 * - linked: done;
 * - scan: a valid QR;
 * - renew: the helper stopped (exit 7 = the pairing window ended, it does not restart on its
 *   own) or the last QR expired without a newer one: offer "Show a new QR code";
 * - restarting: the helper restarts after an error (backoff);
 * - waiting: starting up, the first QR is on its way.
 */
export type LinkStep = 'fixture' | 'linked' | 'scan' | 'renew' | 'restarting' | 'waiting';

export function linkStep(wa: WaSnapshot): LinkStep {
  if (wa.mode === 'fixture') return 'fixture';
  if (wa.state === 'open') return 'linked';
  if (wa.qr) return 'scan';
  if (wa.process === 'stopped') return 'renew';
  if (wa.process === 'backoff') return 'restarting';
  if (wa.qrExpiredAt) return 'renew';
  return 'waiting';
}

/** The sentence above "Show a new QR code". */
export function renewText(wa: WaSnapshot): string {
  if (wa.process === 'stopped' && wa.lastExit && wa.lastExit.code !== EXIT_PAIRING_ENDED) {
    return `The WhatsApp helper stopped (${wa.lastExit.meaning}). Start it again to get a new code.`;
  }
  return 'This code expired — show a new one.';
}

export class PairCodeError extends Error {
  override name = 'PairCodeError';
  readonly code: 'invalid_phone' | 'unavailable' | 'already_linked' | 'timeout';

  constructor(code: 'invalid_phone' | 'unavailable' | 'already_linked' | 'timeout', message: string) {
    super(message);
    this.code = code;
  }
}

/** "+49 151 1234-5678" / "0049…" -> "4915112345678". */
export function normalizePhone(input: string): string {
  return input.replace(/[\s()+.-]/g, '').replace(/^00/, '');
}
