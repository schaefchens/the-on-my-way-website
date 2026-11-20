/**
 * In-memory ring buffer of the latest pino lines (control UI log tail). It is a pino destination
 * stream: pass it as `tee` to createLogger(). Lines are already redacted by pino.
 */
export interface LogLine {
  /** Monotonic id (for "?after=" polling). */
  id: number;
  /** Epoch ms (pino "time"). */
  time: number;
  level: number;
  levelLabel: string;
  msg: string;
  /** Child logger "module" (or "component") binding, if any. */
  module: string | null;
  /** Remaining fields as compact JSON (truncated). */
  extra: string;
}

const LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const OMIT = new Set(['time', 'level', 'msg', 'pid', 'hostname', 'name', 'module', 'component', 'v']);
const MAX_EXTRA = 2_000;

export class LogRing {
  private readonly lines: LogLine[] = [];
  private nextId = 1;

  private readonly capacity: number;

  constructor(capacity = 1_000) {
    this.capacity = capacity;
  }

  /** pino DestinationStream. */
  write(chunk: string): void {
    for (const raw of chunk.split('\n')) {
      if (raw.trim().length === 0) continue;
      this.push(raw);
    }
  }

  private push(raw: string): void {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { msg: String(parsed) };
    } catch {
      obj = { msg: raw };
    }
    const level = typeof obj.level === 'number' ? obj.level : 30;
    const extraObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (!OMIT.has(k)) extraObj[k] = v;
    let extra = Object.keys(extraObj).length > 0 ? JSON.stringify(extraObj) : '';
    if (extra.length > MAX_EXTRA) extra = `${extra.slice(0, MAX_EXTRA)}…`;
    this.lines.push({
      id: this.nextId++,
      time: typeof obj.time === 'number' ? obj.time : Date.now(),
      level,
      levelLabel: LEVELS[level] ?? String(level),
      msg: typeof obj.msg === 'string' ? obj.msg.slice(0, 2_000) : '',
      module: typeof obj.module === 'string' ? obj.module : typeof obj.component === 'string' ? obj.component : null,
      extra,
    });
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** Lines with id > after (oldest first), at most `limit` (the newest ones). */
  since(after = 0, limit = 500): LogLine[] {
    const out = this.lines.filter((l) => l.id > after);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}
