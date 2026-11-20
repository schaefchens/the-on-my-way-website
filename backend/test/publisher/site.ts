/**
 * Synthetic generated sites for publisher tests (shape of the A4 output, not the real
 * generator): content-addressed media and assets, day files with `v` hashes, a timeline, a
 * manifest and HTML pages that reference all of them by absolute path.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SiteSpec {
  version: number;
  /** Frontend build id: changes the asset names. */
  build: string;
  /** date -> public item ids */
  days: Record<string, string[]>;
  /** Extra files (path -> content). */
  extra?: Record<string, string>;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function mediaPaths(item: string): string[] {
  const h = sha(`item:${item}`);
  return [`media/${h.slice(0, 2)}/${h.slice(0, 16)}_w320.avif`, `media/${h.slice(0, 2)}/${h.slice(0, 16)}_w640.webp`];
}

export function assetPaths(build: string): { js: string; css: string } {
  return {
    js: `assets/app-${sha(`js:${build}`).slice(0, 8)}.js`,
    css: `assets/app-${sha(`css:${build}`).slice(0, 8)}.css`,
  };
}

/** All files of a site (path -> content). */
export function siteFiles(spec: SiteSpec): Map<string, string> {
  const files = new Map<string, string>();
  const assets = assetPaths(spec.build);
  files.set(assets.js, `console.log(${JSON.stringify(spec.build)});\n`);
  files.set(assets.css, `/* ${spec.build} */ body{margin:0}\n`);
  const dayIndex: { date: string; v: string }[] = [];
  const dates = Object.keys(spec.days).sort();
  for (const date of dates) {
    const entries = (spec.days[date] ?? []).map((id) => {
      const media = mediaPaths(id);
      for (const m of media) files.set(m, `binary:${m}:${id}`);
      return { id, media };
    });
    const v = sha(JSON.stringify({ date, entries })).slice(0, 12);
    files.set(`data/days/${date}.json`, JSON.stringify({ date, v, entries }));
    dayIndex.push({ date, v });
    for (const locale of ['de', 'en']) {
      files.set(
        `${locale}/day/${date}/index.html`,
        page(
          spec,
          `${locale} ${date}`,
          entries.flatMap((e) => e.media),
        ),
      );
    }
  }
  const tv = sha(JSON.stringify(dayIndex)).slice(0, 12);
  files.set('data/timeline.json', JSON.stringify({ v: tv, days: dayIndex }));
  files.set('data/manifest.json', JSON.stringify({ version: spec.version, timeline: { v: tv } }));
  const firstMedia = dates.length ? mediaPaths(spec.days[dates[0] as string]?.[0] ?? 'none').slice(0, 1) : [];
  for (const locale of ['de', 'en']) files.set(`${locale}/index.html`, page(spec, `${locale} home`, firstMedia));
  files.set('index.html', '<!doctype html><a href="/de/">de</a> <a href="/en/">en</a>');
  files.set('404.html', page(spec, 'not found', []));
  files.set('robots.txt', 'User-agent: *\nDisallow: /\n');
  for (const [p, c] of Object.entries(spec.extra ?? {})) files.set(p, c);
  return files;
}

function page(spec: SiteSpec, title: string, media: string[]): string {
  const a = assetPaths(spec.build);
  return `<!doctype html><html><head><title>${title}</title><link rel="stylesheet" href="/${a.css}"><script type="module" src="/${a.js}"></script></head><body>${media.map((m) => `<img src="/${m}">`).join('')}<script id="omw-boot" type="application/json">{"manifestVersion":${spec.version}}</script></body></html>`;
}

/** Writes a site into `dir` (emptied first). */
export function writeSite(dir: string, spec: SiteSpec): Map<string, string> {
  rmSync(dir, { recursive: true, force: true });
  const files = siteFiles(spec);
  for (const [p, c] of files) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return files;
}

/**
 * Reference integrity of a published site: every file referenced by a page, the timeline, a day
 * file or the manifest exists. Returns human-readable problems (empty = consistent).
 */
export function referenceProblems(files: ReadonlyMap<string, Buffer | string>): string[] {
  const problems: string[] = [];
  const has = (p: string) => files.has(p);
  const text = (p: string) => files.get(p)?.toString() ?? '';
  for (const [p] of files) {
    if (p.endsWith('.html')) {
      for (const m of text(p).matchAll(/(?:src|href)="\/([^"]+)"/g)) {
        const ref = m[1] as string;
        if (ref.endsWith('/')) continue; // page links
        if (!has(ref)) problems.push(`${p} -> ${ref}`);
      }
    }
    if (/^data\/days\/.+\.json$/.test(p)) {
      const day = JSON.parse(text(p)) as { entries: { media: string[] }[] };
      for (const e of day.entries) for (const m of e.media) if (!has(m)) problems.push(`${p} -> ${m}`);
    }
  }
  if (has('data/timeline.json')) {
    const tl = JSON.parse(text('data/timeline.json')) as { days: { date: string; v: string }[] };
    for (const d of tl.days) if (!has(`data/days/${d.date}.json`)) problems.push(`timeline -> ${d.date}`);
  }
  if (has('data/manifest.json') && !has('data/timeline.json')) problems.push('manifest -> timeline missing');
  return problems;
}

/**
 * "The manifest only points to uploaded data": when the target's manifest is the new one, every
 * file of the new site is present with the new content.
 */
export function manifestProblems(
  remote: ReadonlyMap<string, Buffer | string>,
  desired: ReadonlyMap<string, string>,
): string[] {
  const m = remote.get('data/manifest.json')?.toString();
  if (m !== desired.get('data/manifest.json')) return [];
  const problems: string[] = [];
  for (const [p, c] of desired) {
    const r = remote.get(p)?.toString();
    if (r !== c) problems.push(`${p}: ${r === undefined ? 'missing' : 'stale'} while the new manifest is live`);
  }
  return problems;
}
