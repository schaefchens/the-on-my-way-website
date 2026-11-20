/**
 * A periodic task that never overlaps itself: runs `fn`, waits `interval`, repeats. kick() runs it
 * as soon as possible (or right after the current run). Timers are unref'd, so a loop never
 * keeps the process alive by itself.
 */
export interface LoopLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

export class Loop {
  private timer: NodeJS.Timeout | null = null;
  private dueAt = Number.POSITIVE_INFINITY;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  /** Last failure message: a repeated identical failure is logged at debug level only. */
  private lastFailure: string | null = null;

  private readonly name: string;
  private readonly intervalMs: () => number;
  private readonly fn: () => Promise<unknown>;
  private readonly log: LoopLogger | undefined;

  constructor(name: string, intervalMs: () => number, fn: () => Promise<unknown>, log?: LoopLogger) {
    this.name = name;
    this.intervalMs = intervalMs;
    this.fn = fn;
    this.log = log;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  start(initialDelayMs = 0): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(initialDelayMs);
  }

  /** Run soon (within `delayMs`); if a run is in progress, run once more right after it. */
  kick(delayMs = 0): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (Date.now() + delayMs < this.dueAt) this.schedule(delayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = Number.POSITIVE_INFINITY;
    await this.running;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(ms, 2 ** 31 - 1));
    this.dueAt = Date.now() + delay;
    this.timer = setTimeout(() => void this.run(), delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    this.timer = null;
    this.dueAt = Number.POSITIVE_INFINITY;
    if (this.stopped || this.running) return;
    this.running = (async () => {
      try {
        await this.fn();
        if (this.lastFailure !== null) this.log?.info({ loop: this.name }, `${this.name} recovered`);
        this.lastFailure = null;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (text === this.lastFailure) this.log?.debug({ err: text, loop: this.name }, `${this.name} still failing`);
        else this.log?.warn({ err: text, loop: this.name }, `${this.name} failed`);
        this.lastFailure = text;
      }
    })();
    await this.running;
    this.running = null;
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.schedule(0);
    } else {
      this.schedule(this.intervalMs());
    }
  }
}
