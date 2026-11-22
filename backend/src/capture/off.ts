/**
 * OffSource (WA_MODE=off): no WhatsApp at all. Nothing is spawned, no connection is made, nothing
 * can be linked; captures come only from other sources (the traveler app inbox). It exists so a
 * live backend can archive app entries and publish the site while WhatsApp capture is switched
 * off on purpose (owner decision 2026-11-22: no WhatsApp for now).
 */

import type { WaCommand, WaEvent } from '@omw/contracts/wa';
import type { Logger } from '../log.js';
import type { WaSource, WaSourceState } from './types.js';

export class OffSource implements WaSource {
  private readonly log: Logger;
  private readonly current: WaSourceState = {
    mode: 'off',
    wa: 'closed',
    reason: null,
    detail: 'WhatsApp capture is switched off (WA_MODE=off)',
    until: null,
    jid: null,
    process: 'stopped',
    pid: null,
    helperVersion: null,
    restarts: 0,
    nextRestartAt: null,
    lastExit: null,
    qr: null,
    pairCode: null,
    traveler: { pn: null, lid: null },
    lastStatusAt: null,
    lastEventAt: null,
    stats: {},
    invalidLines: 0,
  };

  constructor(deps: { log: Logger }) {
    this.log = deps.log.child({ component: 'wa-source', mode: 'off' });
  }

  async start(): Promise<void> {
    this.log.info('WhatsApp capture is off (WA_MODE=off): no helper, no connection');
  }

  async stop(): Promise<void> {}

  send(cmd: WaCommand): void {
    this.log.warn({ cmd: cmd.type }, 'WhatsApp capture is off: command dropped');
  }

  state(): WaSourceState {
    return structuredClone(this.current);
  }

  onEvent(_cb: (e: WaEvent) => void): () => void {
    return () => {};
  }

  onStateChange(_cb: (s: WaSourceState) => void): () => void {
    return () => {};
  }
}
