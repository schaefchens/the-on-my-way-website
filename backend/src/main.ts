/**
 * Entry point of `node dist/main.js` (Docker CMD, `pnpm start`, `pnpm dev`): runs `backend start`.
 * Everything else (one-shot commands, wiring of the real modules) lives in cli.ts and app.ts.
 */
import { runCli } from './cli.js';

const code = await runCli(['start', ...process.argv.slice(2)]);
if (code !== 0) process.exit(code);
