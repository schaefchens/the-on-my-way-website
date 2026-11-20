/**
 * requestAnimationFrame clock of the journey player. It writes the current item's progress
 * (0..1) into a sink, a MotionValue in the app, so the progress bars, Ken Burns and the voice
 * waveform update every frame without React re-rendering.
 *
 * - Timer items: elapsed time accumulates only while running (pausing freezes it exactly).
 * - Media items: progress is read from the media element (`source()` in ms); the element's
 *   "ended" event finishes the item, the clock never does.
 * The frame loop runs only while running, so a paused player costs nothing.
 */

export interface FrameScheduler {
  request(cb: (time: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

export interface ProgressSink {
  set(value: number): void;
}

export interface ClockItem {
  durationMs: number;
  /** Current media time in ms; when given, the clock follows it instead of counting itself. */
  source?: (() => number | null) | undefined;
  /** Called once when a timer item reaches its duration. */
  onEnd?: (() => void) | undefined;
}

export const browserScheduler: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
};

export class ItemClock {
  private item: ClockItem | null = null;
  private elapsed = 0;
  private running = false;
  private last = 0;
  private handle: number | null = null;
  private done = false;
  private readonly scheduler: FrameScheduler;
  private readonly sink: ProgressSink;

  constructor(scheduler: FrameScheduler, sink: ProgressSink) {
    this.scheduler = scheduler;
    this.sink = sink;
  }

  /** Starts a new item at 0 (stopped until setRunning(true)). */
  load(item: ClockItem): void {
    this.item = item;
    this.elapsed = 0;
    this.done = false;
    this.sink.set(0);
    if (this.running) this.last = this.scheduler.now();
  }

  /** Shows a fixed progress (e.g. 1 for the day-end card) without a running item. */
  hold(progress: number): void {
    this.item = null;
    this.stopLoop();
    this.sink.set(clamp01(progress));
  }

  setDuration(durationMs: number): void {
    if (!this.item || !(durationMs > 0)) return;
    this.item = { ...this.item, durationMs };
    this.emit();
  }

  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    if (running) {
      this.last = this.scheduler.now();
      this.schedule();
    } else {
      // Account for the time since the last frame, so pause/resume never loses or adds time.
      this.advance(this.scheduler.now());
      this.stopLoop();
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  elapsedMs(): number {
    return this.elapsed;
  }

  progress(): number {
    const d = this.item?.durationMs ?? 0;
    return d > 0 ? clamp01(this.elapsed / d) : 0;
  }

  dispose(): void {
    this.stopLoop();
    this.running = false;
    this.item = null;
  }

  private schedule(): void {
    if (this.handle !== null || !this.running) return;
    this.handle = this.scheduler.request(this.tick);
  }

  private stopLoop(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }

  private readonly tick = (time: number): void => {
    this.handle = null;
    if (!this.running) return;
    this.advance(time);
    if (this.running && !this.done) this.schedule();
  };

  private advance(time: number): void {
    const item = this.item;
    const dt = Math.max(0, time - this.last);
    this.last = time;
    if (!item || this.done) return;
    if (item.source) {
      const mediaMs = item.source();
      if (mediaMs !== null && Number.isFinite(mediaMs)) this.elapsed = Math.max(0, mediaMs);
      this.emit();
      return;
    }
    this.elapsed = Math.min(item.durationMs, this.elapsed + dt);
    this.emit();
    if (this.elapsed >= item.durationMs) {
      this.done = true;
      this.stopLoop();
      item.onEnd?.();
    }
  }

  private emit(): void {
    this.sink.set(this.progress());
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}
