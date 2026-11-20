/**
 * Logging (pino). Pretty output in development when pino-pretty (a dev dependency) is
 * installed; JSON lines otherwise (production image, tests).
 *
 * `tee`: an extra in-process sink that receives every log line as JSON (e.g. the control UI's
 * log tail ring buffer). It is fed through pino.multistream, so it sees the same redacted lines.
 */
import { createRequire } from 'node:module';
import { type DestinationStream, type Logger, pino } from 'pino';
import type { LogLevel } from './config.js';

export type { Logger };

export interface LoggerOptions {
  level: LogLevel;
  /** Pretty-print (dev). Falls back to JSON if pino-pretty is not installed. */
  pretty?: boolean;
  name?: string;
  /** Also write every (redacted, JSON) log line to this sink, e.g. a ring buffer. */
  tee?: DestinationStream;
}

const REDACT = [
  'token',
  'password',
  'apiToken',
  '*.token',
  '*.password',
  '*.apiToken',
  'headers.authorization',
  '*.headers.authorization',
];

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** Synchronous pino-pretty stream (same options as the transport below). */
function prettyStream(): DestinationStream {
  const build = createRequire(import.meta.url)('pino-pretty') as (opts: Record<string, unknown>) => DestinationStream;
  return build({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' });
}

export function createLogger(options: LoggerOptions): Logger {
  const base = {
    level: options.level,
    name: options.name ?? 'omw',
    redact: { paths: REDACT, censor: '***' },
  };
  if (options.tee) {
    // multistream: every stream gets every line the logger emits (its level decides).
    const main: DestinationStream =
      options.pretty && prettyAvailable() ? prettyStream() : pino.destination({ fd: 1, sync: true });
    return pino(
      base,
      pino.multistream([
        { level: 'trace', stream: main },
        { level: 'trace', stream: options.tee },
      ]),
    );
  }
  if (options.pretty && prettyAvailable()) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(base);
}
