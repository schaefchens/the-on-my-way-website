/**
 * Fake wa-helper for the supervisor tests.
 *
 *   node fake-helper.mjs <scenario.json> [helper flags …]
 *
 * scenario.json: { "runs": [[step, …], …] } — run N uses runs[min(N, last)]. Steps:
 *   { "out": object | string }   one stdout line (objects are JSON-encoded)
 *   { "rawOut": string }         raw stdout bytes (no newline added)
 *   { "err": string }            one stderr line
 *   { "sleep": ms }
 *   { "exit": code }
 *   { "ignoreStdin": true }      ignore shutdown/EOF (tests the SIGTERM escalation)
 * After the steps the process stays alive until `shutdown` or stdin EOF.
 * Records argv and selected env (argv.jsonl) and every stdin line (stdin.jsonl) next to the
 * scenario. Writes are synchronous so nothing is lost on process.exit (pipes are async on macOS).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [scenarioPath, ...flags] = process.argv.slice(2);
const dir = dirname(scenarioPath);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const countFile = join(dir, 'runs');
const run = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
writeFileSync(countFile, String(run + 1));
appendFileSync(
  join(dir, 'argv.jsonl'),
  `${JSON.stringify({
    run,
    pid: process.pid,
    flags,
    env: {
      DATA_DIR: process.env.DATA_DIR ?? null,
      WA_MODE: process.env.WA_MODE ?? null,
      SEND_READ_RECEIPT: process.env.SEND_READ_RECEIPT ?? null,
      API_TOKEN: process.env.API_TOKEN ?? null,
      CONTROL_TOKEN: process.env.CONTROL_TOKEN ?? null,
    },
  })}\n`,
);

const steps = scenario.runs[Math.min(run, scenario.runs.length - 1)] ?? [];
let ignoreStdin = false;
const out = (value) => writeSync(1, `${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    appendFileSync(join(dir, 'stdin.jsonl'), `${line}\n`);
    let cmd = null;
    try {
      cmd = JSON.parse(line);
    } catch {
      out({ type: 'warning', code: 'invalid_command' });
      continue;
    }
    if (cmd.type === 'stats') out({ type: 'stats', counters: { captured: 7, other_senders: 2 } });
    if (cmd.type === 'shutdown' && !ignoreStdin) process.exit(0);
  }
});
process.stdin.on('end', () => {
  if (!ignoreStdin) process.exit(0);
});

for (const step of steps) {
  if (step.ignoreStdin) ignoreStdin = true;
  if (step.out !== undefined) out(step.out);
  if (step.rawOut !== undefined) writeSync(1, step.rawOut);
  if (step.err !== undefined) writeSync(2, `${step.err}\n`);
  if (step.sleep) await new Promise((resolve) => setTimeout(resolve, step.sleep));
  if (step.exit !== undefined) process.exit(step.exit);
}
setInterval(() => {}, 1000);
