#!/usr/bin/env node
// @ts-check
/**
 * Phase-0 runner: drives wa-helper from a terminal, without the Node backend.
 *
 *   node backend/wa-helper/scripts/phase0.mjs -data-dir <dir> -traveler-phone <digits> [more helper flags]
 *
 * - Spawns the helper (WA_HELPER_BIN, default backend/wa-helper/bin/wa-helper) with the given
 *   flags; its stderr logs go straight to this terminal.
 * - Prints every stdout event, renders `qr` codes as terminal QR codes, summarises captured
 *   statuses from their meta.json and appends every raw event line to
 *   <data-dir>/phase0-events.jsonl (with a receive timestamp) for the Phase-0 measurements.
 * - Terminal input becomes stdin commands: stats | shutdown | logout | pair <digits> |
 *   read <msgId> | redownload <msgId> | any raw JSON command line.
 * - Does not restart the helper: it prints the exit code's meaning and exits with it.
 *
 * Uses only node: modules plus `qrcode` (a backend dependency, resolved from backend/).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperBin = process.env.WA_HELPER_BIN ?? resolve(here, '..', 'bin', 'wa-helper');
const args = process.argv.slice(2);

/** @param {string} name */
function flagValue(name) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `-${name}` || a === `--${name}`) return args[i + 1];
    if (a.startsWith(`-${name}=`) || a.startsWith(`--${name}=`)) return a.slice(a.indexOf('=') + 1);
  }
  return undefined;
}

const dataDir = flagValue('data-dir') ?? process.env.DATA_DIR;
if (!dataDir) {
  console.error('usage: phase0.mjs -data-dir <dir> -traveler-phone <digits> [helper flags]');
  process.exit(2);
}
const eventsLog = join(resolve(dataDir), 'phase0-events.jsonl');

/** @type {{ toString(text: string, opts: { type: 'terminal'; small: boolean }): Promise<string> } | null} */
let qrcode = null;
try {
  qrcode = createRequire(resolve(here, '..', '..', 'package.json'))('qrcode');
} catch {
  console.error('[phase0] qrcode package not found (pnpm install in backend/); QR codes are printed as text');
}

const EXIT_CODES = {
  0: 'clean shutdown',
  1: 'fatal error (see the logs above)',
  2: 'invalid configuration',
  3: 'logged out: the next start shows a fresh QR code',
  4: 'stream replaced: another client uses this session (the next start waits 5 minutes)',
  5: 'client outdated: bump the whatsmeow pin',
  6: 'temporary ban: the next start waits until the ban has ended',
  7: 'linking window ended without a link: start again for a new QR code',
  8: 'connect failure: start again later',
};

const ts = () => new Date().toISOString().slice(11, 19);
/** @param {string} msg */
const say = (msg) => console.log(`${ts()} ${msg}`);

const child = spawn(helperBin, args, { stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin?.on('error', () => {}); // EPIPE after the helper exited
child.on('error', (err) => {
  console.error(`[phase0] cannot start ${helperBin}: ${err.message} (run: make -C backend/wa-helper build)`);
  process.exit(1);
});

/** @param {string} msgId */
function describeStatus(msgId) {
  try {
    const meta = JSON.parse(readFileSync(join(resolve(dataDir), 'inbox', msgId, 'meta.json'), 'utf8'));
    const bits = [meta.kind, meta.sender?.jid, meta.timestamp];
    if (meta.caption) bits.push(JSON.stringify(meta.caption));
    if (meta.text) bits.push(JSON.stringify(meta.text.body), `font=${meta.text.font}`, `bg=${meta.text.bgArgb}`);
    if (meta.media) bits.push(meta.media.mimetype, `${meta.media.fileLength} B`);
    if (meta.stanzaTag) bits.push(`stanza=${meta.stanzaTag}`);
    return bits.filter(Boolean).join(' · ');
  } catch (err) {
    return `(meta.json unreadable: ${/** @type {Error} */ (err).message})`;
  }
}

/** @param {string} line */
async function handleLine(line) {
  try {
    appendFileSync(eventsLog, `${JSON.stringify({ receivedAt: new Date().toISOString(), line })}\n`);
  } catch {
    // the data dir may not exist before the helper created it
  }
  /** @type {any} */
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    say(`!! non-JSON stdout line (protocol violation): ${line}`);
    return;
  }
  switch (e.type) {
    case 'qr':
      say(`QR code (valid until ${e.expiresAt}); scan it under WhatsApp > Linked devices > Link a device`);
      if (qrcode) console.log(await qrcode.toString(e.code, { type: 'terminal', small: true }));
      else console.log(e.code);
      break;
    case 'pair_code':
      say(`PAIRING CODE: ${e.code}  (WhatsApp > Linked devices > Link with phone number)`);
      break;
    case 'status':
      say(`status ${e.msgId} [${e.source}] ${describeStatus(e.msgId)}`);
      break;
    case 'media':
      say(`media ${e.msgId}: ${e.state}${e.reason ? ` (${e.reason}, permanent=${e.permanent})` : ''}${e.error ? ` – ${e.error}` : ''}`);
      break;
    case 'traveler':
      say(`traveler learned: pn=${e.pn} lid=${e.lid ?? '?'}  -> pass -traveler-lid ${e.lid ?? ''} next time`);
      break;
    case 'stats':
      say(`stats ${JSON.stringify(e.counters)}`);
      break;
    default:
      say(`${e.type} ${JSON.stringify({ ...e, type: undefined })}`);
  }
}

// Events are handled strictly in order (QR rendering is async).
let pending = Promise.resolve();
const out = createInterface({ input: /** @type {import('node:stream').Readable} */ (child.stdout) });
out.on('line', (line) => {
  pending = pending.then(() => handleLine(line)).catch((err) => say(`!! ${err.message}`));
});

const input = createInterface({ input: process.stdin });
input.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const [word, arg] = line.split(/\s+/, 2);
  /** @type {Record<string, unknown> | null} */
  let cmd = null;
  if (line.startsWith('{')) {
    child.stdin?.write(`${line}\n`);
    return;
  }
  if (word === 'stats' || word === 'shutdown' || word === 'logout') cmd = { type: word };
  else if (word === 'pair' && arg) cmd = { type: 'pair_code', phone: arg.replace(/\D/g, '') };
  else if (word === 'read' && arg) cmd = { type: 'mark_read', msgId: arg };
  else if (word === 'redownload' && arg) cmd = { type: 'redownload', msgId: arg };
  if (!cmd) {
    say('commands: stats | shutdown | logout | pair <digits> | read <msgId> | redownload <msgId> | {raw json}');
    return;
  }
  child.stdin?.write(`${JSON.stringify(cmd)}\n`);
});
input.on('close', () => child.stdin?.end()); // EOF on the terminal = shutdown

process.on('SIGINT', () => child.stdin?.write('{"type":"shutdown"}\n'));
// 'close' fires after the helper exited AND its stdout was fully read.
child.on('close', async (code, signal) => {
  await pending;
  const c = code ?? 1;
  say(`helper exited with ${signal ?? c}: ${EXIT_CODES[/** @type {keyof typeof EXIT_CODES} */ (c)] ?? 'unknown exit code'}`);
  process.exit(c);
});
