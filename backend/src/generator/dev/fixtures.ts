/**
 * DEV/TEST ONLY: seeds a Store and MEDIA_DIR from the shared fixtures (fixtures/generated,
 * `pnpm fixtures`), standing in for the capture pipeline so the generator can be exercised
 * and previewed without WhatsApp:
 *
 *   inbox/<msgId>/meta.json -> captures (newCaptureFromInbox, tz from index.json) -> revokes ->
 *   media variants (D8 names) -> markArchived/markProcessed/markReady; owner.json "changes" ->
 *   store.owner.applyChanges().
 *
 * Media modes:
 * - "dummy": tiny placeholder files with the right names (fast; for unit tests that never decode
 *   media), except the photos' WebP variants up to 640 px: small solid-colour images of the
 *   declared size, so the portrait's round crop (pipeline/avatar.ts) can be made from them;
 * - "real":  sharp (AVIF/WebP at 320/640/1080/1600 without upscaling, OG JPEG 1200x630,
 *   ThumbHash, dominant colour) and ffmpeg (poster frame, H.264 mp4 +faststart, AAC m4a,
 *   waveform peaks), like frontend/site/scripts/make-dev-data.ts. Outputs are content-addressed
 *   and reused when they already exist in MEDIA_DIR.
 * Not used by the production code path (nothing in index.ts imports it).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ChangesResponse } from '@omw/contracts/api';
import { InboxMeta, RevokeRecord } from '@omw/contracts/wa';
import { type MediaExt, type MediaVariant, mediaFilePath, mediaRelPath, REPO_ROOT } from '../../paths.js';
import { newCaptureFromInbox, type ProcessedMeta, type ProcessedVariant, type Store } from '../../store/index.js';

const execFileAsync = promisify(execFile);

export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures', 'generated');

export interface FixtureIndexEntry {
  key: string;
  msgId: string;
  sourceKey: string;
  publicId: string;
  kind: string;
  tz: string;
  localDate: string;
}

export interface SeedOptions {
  store: Store;
  mediaDir: string;
  media: 'dummy' | 'real';
  fixturesDir?: string;
  /** Override captions by fixture key (e.g. XSS probes in tests). */
  captions?: Record<string, string>;
  /** Apply owner.json's change feed (default true). */
  owner?: boolean;
}

export interface SeedResult {
  index: FixtureIndexEntry[];
  /** fixture key -> sourceKey */
  keys: Record<string, string>;
  ready: number;
}

export function fixturesPresent(dir = FIXTURES_DIR): boolean {
  return existsSync(join(dir, 'index.json')) && existsSync(join(dir, 'owner.json'));
}

export function readFixtureIndex(dir = FIXTURES_DIR): FixtureIndexEntry[] {
  return (JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { statuses: FixtureIndexEntry[] }).statuses;
}

export async function seedFromFixtures(opts: SeedOptions): Promise<SeedResult> {
  const dir = opts.fixturesDir ?? FIXTURES_DIR;
  const { store } = opts;
  const index = readFixtureIndex(dir);
  const inbox = join(dir, 'inbox');
  const keys: Record<string, string> = {};
  let ready = 0;
  const revokesDir = join(inbox, '_revokes');
  for (const name of existsSync(revokesDir) ? readdirSync(revokesDir) : []) {
    const r = RevokeRecord.parse(JSON.parse(readFileSync(join(revokesDir, name), 'utf8')));
    store.captures.applyRevoke(r.msgId, r.at);
  }
  for (const entry of index) {
    const meta = InboxMeta.parse(JSON.parse(readFileSync(join(inbox, entry.msgId, 'meta.json'), 'utf8')));
    const capture = await newCaptureFromInbox(meta, entry.tz);
    const caption = opts.captions?.[entry.key];
    if (caption !== undefined) capture.caption = caption;
    const { row } = store.captures.insert(capture);
    keys[entry.key] = row.sourceKey;
    if (row.state !== 'received') continue;
    if (row.kind === 'text' || row.kind === 'unsupported') {
      store.captures.markReady(row.sourceKey);
      ready++;
      continue;
    }
    const file = meta.download.file ? join(inbox, entry.msgId, meta.download.file) : null;
    const sha = meta.download.sha256Hex;
    if (!file || !sha) continue;
    const processed =
      opts.media === 'real'
        ? await realVariants(row.kind, file, sha, opts.mediaDir, meta.media?.waveformB64)
        : await dummyVariants(row.kind, sha, opts.mediaDir, meta.media?.width, meta.media?.height, meta.media?.seconds);
    store.captures.markArchived(row.sourceKey, { archivePath: `fixture/${entry.msgId}`, originalSha256: sha });
    store.captures.markProcessed(row.sourceKey, processed);
    store.captures.markReady(row.sourceKey);
    ready++;
  }
  if (opts.owner !== false) {
    const owner = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { changes: unknown };
    store.owner.applyChanges(ChangesResponse.parse(owner.changes));
  }
  return { index, keys, ready };
}

// ---------------------------------------------------------------------------------------------
// Variants

const WIDTHS = [320, 640, 1080, 1600] as const;

async function writeVariant(
  mediaDir: string,
  sha: string,
  variant: MediaVariant,
  ext: MediaExt,
  produce: (target: string) => Promise<void>,
): Promise<{ relPath: string; bytes: number; sha256: string }> {
  const relPath = mediaRelPath(sha, variant, ext);
  const file = mediaFilePath(mediaDir, relPath);
  if (!existsSync(file)) {
    await fsp.mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await produce(tmp);
    await fsp.rename(tmp, file);
  }
  const bytes = await fsp.readFile(file);
  return { relPath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function fakeColor(sha: string): string {
  return `#${sha.slice(0, 6)}`;
}

async function dummyVariants(
  kind: string,
  sha: string,
  mediaDir: string,
  width = 1600,
  height = 1200,
  seconds = 5,
): Promise<{ variants: ProcessedVariant[]; processedMeta: ProcessedMeta }> {
  const variants: ProcessedVariant[] = [];
  const put = async (role: ProcessedVariant['role'], variant: MediaVariant, ext: MediaExt, w?: number, h?: number) => {
    const decodable = role === 'image' && ext === 'webp' && w && h && w <= 640;
    const out = await writeVariant(mediaDir, sha, variant, ext, async (t) => {
      if (!decodable) return fsp.writeFile(t, `dummy ${variant}.${ext}\n`);
      const { default: sharp } = await import('sharp');
      await sharp({ create: { width: w, height: h, channels: 3, background: fakeColor(sha) } })
        .webp({ quality: 50, effort: 0 })
        .toFile(t);
    });
    variants.push({ role, variant, format: ext, ...(w ? { w } : {}), ...(h ? { h } : {}), ...out });
  };
  const image = async (role: 'image' | 'poster', prefix: 'w' | 'poster_w') => {
    const widths = WIDTHS.filter((w) => w <= width);
    for (const w of widths.length > 0 ? widths : [320]) {
      const h = Math.round((w / width) * height);
      for (const ext of ['avif', 'webp'] as const) await put(role, `${prefix}${w}` as MediaVariant, ext, w, h);
    }
    await put('og', 'og', 'jpg', 1200, 630);
  };
  const base = { w: width, h: height, thumbhash: 'AAAAAAAA', color: fakeColor(sha) };
  switch (kind) {
    case 'photo':
      await image('image', 'w');
      return { variants, processedMeta: base };
    case 'video':
    case 'gif':
      await image('poster', 'poster_w');
      await put('video', 'video', 'mp4', width, height);
      return { variants, processedMeta: { ...base, duration: seconds } };
    case 'voice':
      await put('audio', 'voice', 'm4a');
      return {
        variants,
        processedMeta: { duration: seconds, peaks: Array.from({ length: 64 }, (_, i) => ((i * 37) % 100) / 100) },
      };
    default:
      throw new Error(`No media for kind ${kind}`);
  }
}

async function ffmpeg(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...args], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function probe(
  file: string,
): Promise<{ streams: { codec_type: string; codec_name?: string }[]; duration: number }> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name:format=duration',
    '-of',
    'json',
    file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams: { codec_type: string; codec_name?: string }[];
    format: { duration?: string };
  };
  return { streams: parsed.streams, duration: Number.parseFloat(parsed.format.duration ?? '0') };
}

async function realImage(
  input: Buffer,
  sha: string,
  mediaDir: string,
  role: 'image' | 'poster',
  variants: ProcessedVariant[],
): Promise<ProcessedMeta> {
  const { default: sharp } = await import('sharp');
  const { rgbaToThumbHash } = await import('thumbhash');
  const meta = await sharp(input).metadata();
  const W = meta.autoOrient?.width ?? meta.width ?? 0;
  const H = meta.autoOrient?.height ?? meta.height ?? 0;
  const widths = WIDTHS.filter((w) => w <= W);
  const plan = widths.length > 0 ? widths.map((w) => ({ nominal: w, w })) : [{ nominal: 320, w: W }];
  const prefix = role === 'image' ? 'w' : 'poster_w';
  for (const { nominal, w } of plan) {
    const h = Math.round((w / W) * H);
    for (const ext of ['avif', 'webp'] as const) {
      const out = await writeVariant(mediaDir, sha, `${prefix}${nominal}` as MediaVariant, ext, async (t) => {
        const p = sharp(input).autoOrient().resize({ width: w, withoutEnlargement: true });
        await (ext === 'avif' ? p.avif({ quality: 50, effort: 2 }) : p.webp({ quality: 75 })).toFile(t);
      });
      variants.push({ role, variant: `${prefix}${nominal}`, format: ext, w, h, ...out });
    }
  }
  const og = await writeVariant(mediaDir, sha, 'og', 'jpg', async (t) => {
    await sharp(input).autoOrient().resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 80, mozjpeg: true }).toFile(t);
  });
  variants.push({ role: 'og', variant: 'og', format: 'jpg', w: 1200, h: 630, ...og });
  const small = await sharp(input)
    .autoOrient()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString('base64');
  const { dominant } = await sharp(input).stats();
  const color = `#${[dominant.r, dominant.g, dominant.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return { w: W, h: H, thumbhash, color };
}

async function realVariants(
  kind: string,
  file: string,
  sha: string,
  mediaDir: string,
  waveformB64: string | undefined,
): Promise<{ variants: ProcessedVariant[]; processedMeta: ProcessedMeta }> {
  const variants: ProcessedVariant[] = [];
  if (kind === 'photo') {
    return { variants, processedMeta: await realImage(await fsp.readFile(file), sha, mediaDir, 'image', variants) };
  }
  if (kind === 'video' || kind === 'gif') {
    let poster = await ffmpeg(['-ss', '0.4', '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
    if (poster.length === 0)
      poster = await ffmpeg(['-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
    const imageMeta = await realImage(poster, sha, mediaDir, 'poster', variants);
    const info = await probe(file);
    const muted = kind === 'gif';
    const h264 = info.streams.some((s) => s.codec_type === 'video' && s.codec_name === 'h264');
    const hasAudio = !muted && info.streams.some((s) => s.codec_type === 'audio');
    const out = await writeVariant(mediaDir, sha, 'video', 'mp4', async (t) => {
      const codec = h264
        ? ['-c:v', 'copy', ...(muted ? ['-an'] : ['-c:a', 'copy'])]
        : [
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '26',
            '-pix_fmt',
            'yuv420p',
            ...(muted ? ['-an'] : ['-c:a', 'aac', '-b:a', '96k']),
          ];
      await ffmpeg(['-y', '-i', file, ...codec, '-movflags', '+faststart', '-f', 'mp4', t]);
    });
    variants.push({ role: 'video', variant: 'video', format: 'mp4', w: imageMeta.w, h: imageMeta.h, ...out });
    const duration = Math.round((await probe(mediaFilePath(mediaDir, out.relPath))).duration * 100) / 100;
    return { variants, processedMeta: { ...imageMeta, duration, hasAudio } };
  }
  if (kind === 'voice') {
    const out = await writeVariant(mediaDir, sha, 'voice', 'm4a', async (t) => {
      await ffmpeg([
        '-y',
        '-i',
        file,
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-ac',
        '1',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        t,
      ]);
    });
    variants.push({ role: 'audio', variant: 'voice', format: 'm4a', ...out });
    const duration = Math.round((await probe(mediaFilePath(mediaDir, out.relPath))).duration * 100) / 100;
    const peaks = waveformB64
      ? [...Buffer.from(waveformB64, 'base64')].map((v) => Math.min(1, Math.max(0, v / 100)))
      : Array.from({ length: 64 }, () => 0.5);
    return { variants, processedMeta: { duration, peaks } };
  }
  throw new Error(`No media for kind ${kind}`);
}
