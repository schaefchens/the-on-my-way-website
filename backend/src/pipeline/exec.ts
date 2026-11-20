/**
 * Runs external tools (ffmpeg, ffprobe) with a timeout and an AbortSignal, never through a shell.
 * stdout is collected (bounded), stderr keeps only its tail for error messages.
 */
import { spawn } from 'node:child_process';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
}

/** FFMPEG_PATH / FFPROBE_PATH, default "ffmpeg" / "ffprobe" (looked up on PATH). */
export function toolPathsFromEnv(env: Record<string, string | undefined> = process.env): ToolPaths {
  const pick = (v: string | undefined, fallback: string) => (v && v.trim() !== '' ? v.trim() : fallback);
  return { ffmpeg: pick(env.FFMPEG_PATH, 'ffmpeg'), ffprobe: pick(env.FFPROBE_PATH, 'ffprobe') };
}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Max bytes of stdout kept (default 64 MiB); more fails the run. */
  maxStdoutBytes?: number;
  /** Bytes of stderr kept for error messages (default 8 KiB, tail). */
  stderrTailBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export class ToolError extends Error {
  override name = 'ToolError';
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly timedOut: boolean;

  constructor(
    message: string,
    details: { command: string; exitCode: number | null; signal: string | null; stderr: string; timedOut: boolean },
  ) {
    super(message);
    this.command = details.command;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stderr = details.stderr;
    this.timedOut = details.timedOut;
  }
}

/** Thrown when the caller's AbortSignal fired (shutdown); never recorded as a capture failure. */
export class AbortedError extends Error {
  override name = 'AbortError';
  constructor(message = 'aborted') {
    super(message);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AbortedError || (err instanceof Error && err.name === 'AbortError');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError();
}

/**
 * Demuxers the pipeline accepts for media originals (WhatsApp sends mp4/3gp/mov, webm, ogg/opus,
 * m4a/aac, mp3, amr; wav/flac for completeness): every ffmpeg/ffprobe input is opened with
 * -format_whitelist, so playlist-like formats that open FURTHER inputs (concat, hls, image2, …)
 * are refused before they read anything.
 */
export const INPUT_FORMAT_WHITELIST = 'mov,matroska,ogg,mp3,aac,wav,amr,flac';

/**
 * Input options for a LOCAL media file (W2-5), for ffmpeg ("-i" form) and ffprobe (positional):
 * only the `file` protocol (no http/tcp/udp/…, also not for nested opens of a demuxer), only the
 * media demuxers above, and the path as an explicit "file:" URL so a name can never be read as
 * another protocol ("concat:…", "http://…").
 */
export function localInputArgs(path: string, form: 'ffmpeg' | 'ffprobe' = 'ffmpeg'): string[] {
  const opts = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMAT_WHITELIST];
  return form === 'ffmpeg' ? [...opts, '-i', `file:${path}`] : [...opts, `file:${path}`];
}

/** Runs `command args…`; resolves on exit code 0, rejects with ToolError otherwise. */
export function runTool(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const maxStdout = options.maxStdoutBytes ?? 64 * 1024 * 1024;
  const tailBytes = options.stderrTailBytes ?? 8 * 1024;
  return new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let overflow = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        overflow = true;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > tailBytes * 2) stderr = stderr.slice(-tailBytes);
    });

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ stdout: Buffer.concat(chunks), stderr: stderr.slice(-tailBytes) });
    };

    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(
        new ToolError(code === 'ENOENT' ? `${command}: not found (set FFMPEG_PATH/FFPROBE_PATH)` : err.message, {
          command,
          exitCode: null,
          signal: null,
          stderr: '',
          timedOut: false,
        }),
      );
    });
    child.on('close', (exitCode, signal) => {
      if (aborted) return finish(new AbortedError(`${command} aborted`));
      const tail = stderr.slice(-tailBytes).trim();
      if (timedOut) {
        return finish(
          new ToolError(`${command} timed out after ${options.timeoutMs} ms`, {
            command,
            exitCode,
            signal,
            stderr: tail,
            timedOut: true,
          }),
        );
      }
      if (overflow) {
        return finish(
          new ToolError(`${command} produced more than ${maxStdout} bytes on stdout`, {
            command,
            exitCode,
            signal,
            stderr: tail,
            timedOut: false,
          }),
        );
      }
      if (exitCode !== 0) {
        const lastLine = tail.split('\n').at(-1) ?? '';
        return finish(
          new ToolError(`${command} exited with ${exitCode ?? signal}${lastLine ? `: ${lastLine}` : ''}`, {
            command,
            exitCode,
            signal,
            stderr: tail,
            timedOut: false,
          }),
        );
      }
      finish(null);
    });
  });
}
