/**
 * Splits a byte stream into UTF-8 lines with a hard per-line limit, so a misbehaving child process
 * can never make Node buffer unbounded data. Over-long lines are reported (truncated) via
 * `onOverflow` and skipped up to the next newline.
 */
import { StringDecoder } from 'node:string_decoder';

export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private discarding = false;
  private readonly maxLineLength: number;
  private readonly onLine: (line: string) => void;
  private readonly onOverflow: (head: string) => void;

  constructor(options: {
    maxLineLength?: number;
    onLine: (line: string) => void;
    onOverflow?: (head: string) => void;
  }) {
    this.maxLineLength = options.maxLineLength ?? 1024 * 1024;
    this.onLine = options.onLine;
    this.onOverflow = options.onOverflow ?? (() => {});
  }

  push(chunk: Buffer | string): void {
    this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
  }

  /** Flushes a trailing line without newline (stream end). */
  end(): void {
    this.consume(this.decoder.end());
    if (this.buffer.length > 0 && !this.discarding) this.emit(this.buffer);
    this.buffer = '';
    this.discarding = false;
  }

  private consume(text: string): void {
    let rest = text;
    for (;;) {
      const nl = rest.indexOf('\n');
      if (nl === -1) {
        if (this.discarding) return;
        this.buffer += rest;
        if (this.buffer.length > this.maxLineLength) {
          this.onOverflow(this.buffer.slice(0, 200));
          this.buffer = '';
          this.discarding = true;
        }
        return;
      }
      const piece = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = '';
      if (line.length > this.maxLineLength) {
        this.onOverflow(line.slice(0, 200));
        continue;
      }
      this.emit(line);
    }
  }

  private emit(line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.trim().length > 0) this.onLine(trimmed);
  }
}
