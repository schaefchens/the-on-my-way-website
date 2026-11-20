/**
 * Static site generator (plan A4, D3): store (captures + owner mirror) + MEDIA_DIR + the built
 * SPA (frontend/site/dist) -> OUT_DIR.
 *
 *   const generator = createGenerator({ config, log, store });
 *   const result = await generator.generate();                     // incremental (model diff)
 *   await generator.generate({ dates: ['2026-11-15'], reason: 'feed' });
 *   await generator.generate({ full: true, reason: 'startup' });   // re-check everything
 *
 * Calls are serialised (a call waits for the previous one). See generate.ts for the algorithm,
 * pages.ts for the HTML contract and state.ts for what is persisted in the store.
 */
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { REPO_ROOT } from '../paths.js';
import type { Store } from '../store/index.js';
import { type GenerateOptions, type GenerateResult, type GenerationContext, runGeneration } from './generate.js';
import { resetState } from './state.js';

export type { GenerateOptions, GenerateResult } from './generate.js';
export { FeedCatchingUpError, GENERATOR_VERSION, GeneratorValidationError } from './generate.js';
export { UnsafeOutDirError } from './output.js';
export { LOCALE_COOKIE, ROOT_ELEMENT_ID } from './pages.js';
export { SiteBuildError } from './site-build.js';

/** Default location of the built SPA (the Docker image may put it elsewhere: pass siteDistDir). */
export const DEFAULT_SITE_DIST_DIR = join(REPO_ROOT, 'frontend', 'site', 'dist');

export interface Generator {
  generate(opts?: GenerateOptions): Promise<GenerateResult>;
  outDir: string;
  /** Forgets the persisted state: the next run is full and re-stamps every page. */
  reset(): Promise<void>;
  /** True while a run is in progress or queued. */
  busy(): boolean;
}

export interface GeneratorDeps {
  config: Config;
  log: Logger;
  store: Store;
  now?: () => Date;
  /** Built SPA (default: config.siteDistDir = SITE_DIST_DIR, else DEFAULT_SITE_DIST_DIR). */
  siteDistDir?: string;
  /** Validate JSON/Boot against the contracts (default: on unless NODE_ENV=production). */
  validate?: boolean;
  /** Write /.htaccess for Apache hosts (default true). */
  htaccess?: boolean;
}

export function createGenerator(deps: GeneratorDeps): Generator {
  const log = deps.log.child({ module: 'generator' });
  const ctx: GenerationContext = {
    config: deps.config,
    log,
    store: deps.store,
    now: deps.now ?? (() => new Date()),
    siteDistDir: deps.siteDistDir ?? deps.config.siteDistDir ?? DEFAULT_SITE_DIST_DIR,
    outDir: deps.config.dirs.out,
    mediaDir: deps.config.dirs.media,
    validate: deps.validate ?? deps.config.env !== 'production',
    htaccess: deps.htaccess ?? true,
  };
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    pending++;
    const run = queue.then(fn, fn).finally(() => {
      pending--;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    outDir: ctx.outDir,
    generate: (opts = {}) => enqueue(() => runGeneration(ctx, opts)),
    reset: () =>
      enqueue(async () => {
        resetState(ctx.store);
      }),
    busy: () => pending > 0,
  };
}
