/**
 * Builds a contract-valid static data set for the site's dev server from the shared fixtures:
 *
 *   fixtures/generated/{index.json, owner.json, inbox/<msgId>/{meta.json, original.*}, inbox/_revokes/}
 *     -> frontend/site/dev-data/{data/manifest.json, data/timeline.json, data/days/*.json,
 *                                data/trips/*.json, media/<aa>/<sha16>_<variant>.<ext>}
 *
 * A deliberately simple stand-in for the backend pipeline + generator (plan A2/A4):
 * - photos: sharp, EXIF auto-orient, w320/w640/w1080 (no upscaling) as AVIF q50 + WebP q75,
 *   ThumbHash, dominant colour;
 * - videos/GIFs: poster frame via ffmpeg (same image treatment, "poster_w…"), H.264 remuxed with
 *   +faststart, anything else transcoded to H.264/AAC (GIFs muted);
 * - voice: AAC m4a 64 kbps mono, 64 peaks from the WhatsApp waveform (or computed);
 * - visibility, placement (overrides, Day.tz fixes) and trip membership via @omw/contracts/policy
 *   (D11), owner content from owner.json; only trips with a public day are published
 *   (publishedTrips), like the generator;
 * - the profile (site.author / site.intro / site.avatar) as timeline.json `profile`: the portrait
 *   is only a round crop of its photo at AVATAR_SIZES, also when the photo is not public itself.
 * Media names follow D8. Every written JSON file is re-read and validated with zod.
 *
 * Usage (from the repo root):
 *   pnpm --filter @omw/site dev-data            build/refresh (media are cached by name)
 *   pnpm --filter @omw/site dev-data --clean    start from an empty output directory
 *   pnpm --filter @omw/site dev-data:check      only validate an existing data set
 * Options: --fixtures <dir> (or OMW_FIXTURES_DIR), --out <dir> (or OMW_DEV_DATA_DIR),
 *          --base-path </x/>, --now <ISO> (evaluation time for publish.mode "delayed").
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Annotation, Day, Post, Trip, withSettingsDefaults } from '@omw/contracts/api';
import type { LocaleCode } from '@omw/contracts/i18n';
import { publicIdForSourceKey, publishedPostIdFromSha256Hex, waSourceKey } from '@omw/contracts/ids';
import {
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  publishedTrips,
  tripForDate,
} from '@omw/contracts/policy';
import {
  AVATAR_SIZES,
  type AvatarImage,
  DayDetail,
  type DaySummary,
  dayDataPath,
  type Entry,
  type ImageSet,
  MANIFEST_PATH,
  Manifest,
  SiteProfile,
  TIMELINE_PATH,
  TimelineIndex,
  TripDetail,
  type TripSummary,
  tripDataPath,
} from '@omw/contracts/site';
import { localDateFor } from '@omw/contracts/time';
import { argbToRgbaHex, InboxMeta, RevokeRecord } from '@omw/contracts/wa';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SITE_ROOT, '../..');

const { values: args } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    out: { type: 'string' },
    'base-path': { type: 'string', default: '/' },
    now: { type: 'string' },
    clean: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
});

function absolute(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

const FIXTURES = absolute(args.fixtures ?? process.env.OMW_FIXTURES_DIR ?? join(REPO_ROOT, 'fixtures/generated'));
const OUT = absolute(args.out ?? process.env.OMW_DEV_DATA_DIR ?? join(SITE_ROOT, 'dev-data'));
const BASE_PATH = args['base-path'] ?? '/';
const NOW = args.now ? new Date(args.now) : new Date();

const IMAGE_WIDTHS = [320, 640, 1080] as const;
const DEFAULT_TEXT_BG = 0xff3b2341; // plum, when WhatsApp sends no colour
const DEFAULT_TEXT_FG = 0xffffffff;

// ---------------------------------------------------------------------------------------------
// Small helpers

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** JSON with recursively sorted keys, so hashes do not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content hash used as `v` (D3 cache buster). */
const contentHash = (value: unknown) => sha256(canonicalJson(value)).slice(0, 16);

function mediaRel(sha: string, variant: string, ext: string): string {
  return `media/${sha.slice(0, 2)}/${sha.slice(0, 16)}_${variant}.${ext}`;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function ffmpeg(argv: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', ...argv], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const Probe = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
    }),
  ),
  format: z.object({ duration: z.string().optional() }),
});

async function ffprobe(file: string): Promise<z.infer<typeof Probe>> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height:format=duration',
    '-of',
    'json',
    file,
  ]);
  return Probe.parse(JSON.parse(stdout));
}

function hexColor({ r, g, b }: { r: number; g: number; b: number }): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

const written = new Set<string>(); // media rel paths referenced by this run

// ---------------------------------------------------------------------------------------------
// Media processing

async function processImage(
  input: Buffer,
  sha: string,
  prefix: 'w' | 'poster_w',
  nominalWidths: readonly number[] = IMAGE_WIDTHS,
): Promise<ImageSet> {
  const meta = await sharp(input).metadata();
  const W = meta.autoOrient.width;
  const H = meta.autoOrient.height;
  const widths = nominalWidths.filter((w) => w <= W);
  const plan = widths.length > 0 ? widths.map((w) => ({ nominal: w, w })) : [{ nominal: 320, w: W }];

  const sources: ImageSet['sources'] = { avif: [], webp: [] };
  for (const { nominal, w } of plan) {
    for (const ext of ['avif', 'webp'] as const) {
      const rel = mediaRel(sha, `${prefix}${nominal}`, ext);
      written.add(rel);
      const file = join(OUT, rel);
      if (!existsSync(file)) {
        await mkdir(dirname(file), { recursive: true });
        const pipeline = sharp(input).autoOrient().resize({ width: w, withoutEnlargement: true });
        const encoded = ext === 'avif' ? pipeline.avif({ quality: 50, effort: 4 }) : pipeline.webp({ quality: 75 });
        await encoded.toFile(`${file}.tmp`);
        await rename(`${file}.tmp`, file);
      }
      sources[ext].push({ w, src: rel });
    }
  }

  const small = await sharp(input)
    .autoOrient()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString('base64');
  const { dominant } = await sharp(input).stats();

  return { w: W, h: H, color: hexColor(dominant), thumbhash, sources };
}

async function posterFrame(file: string): Promise<Buffer> {
  for (const seek of ['0.4', '0']) {
    const png = await ffmpeg(['-ss', seek, '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
    if (png.length > 0) return png;
  }
  throw new Error(`No poster frame in ${file}`);
}

async function processVideo(file: string, sha: string, muted: boolean) {
  const poster = await processImage(await posterFrame(file), sha, 'poster_w');
  const probe = await ffprobe(file);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${file}`);
  const hasAudio = !muted && probe.streams.some((s) => s.codec_type === 'audio');

  const rel = mediaRel(sha, 'video', 'mp4');
  written.add(rel);
  const out = join(OUT, rel);
  if (!existsSync(out)) {
    await mkdir(dirname(out), { recursive: true });
    const audio = muted ? ['-an'] : ['-c:a', 'aac', '-b:a', '96k'];
    const codec =
      video.codec_name === 'h264'
        ? ['-c:v', 'copy', ...(muted ? ['-an'] : ['-c:a', 'copy'])]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', ...audio];
    await ffmpeg(['-y', '-i', file, ...codec, '-movflags', '+faststart', '-f', 'mp4', `${out}.tmp`]);
    await rename(`${out}.tmp`, out);
  }
  const duration = Number.parseFloat((await ffprobe(out)).format.duration ?? '0');
  // The poster is already oriented, so its size is the display size.
  return { src: rel, w: poster.w, h: poster.h, duration: Math.round(duration * 100) / 100, hasAudio, poster };
}

async function computePeaks(file: string, count = 64): Promise<number[]> {
  const pcm = await ffmpeg(['-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = Math.max(1, Math.floor(samples.length / count));
  const rms: number[] = [];
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * per; j < Math.min(samples.length, (i + 1) * per); j++) sum += (samples[j] ?? 0) ** 2;
    rms.push(Math.sqrt(sum / per) / 32768);
  }
  const max = Math.max(...rms, 1e-6);
  return rms.map((v) => Math.round((v / max) * 100) / 100);
}

async function processVoice(file: string, sha: string, waveformB64: string | undefined) {
  const rel = mediaRel(sha, 'voice', 'm4a');
  written.add(rel);
  const out = join(OUT, rel);
  if (!existsSync(out)) {
    await mkdir(dirname(out), { recursive: true });
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
      `${out}.tmp`,
    ]);
    await rename(`${out}.tmp`, out);
  }
  const duration = Number.parseFloat((await ffprobe(out)).format.duration ?? '0');
  const peaks = waveformB64
    ? [...Buffer.from(waveformB64, 'base64')].map((v) => Math.min(1, Math.max(0, v / 100)))
    : await computePeaks(file);
  return { src: rel, duration: Math.round(duration * 100) / 100, peaks };
}

// ---------------------------------------------------------------------------------------------
// Inputs

const FixtureIndex = z.object({
  statuses: z.array(z.object({ msgId: z.string(), tz: z.string(), localDate: z.string() })),
});

const OwnerFile = z.object({
  settings: z.record(z.string(), z.unknown()),
  trips: z.array(Trip),
  days: z.array(Day),
  posts: z.array(Post),
  annotations: z.array(Annotation),
});

interface Capture {
  sourceKey: string;
  publicId: string;
  meta: InboxMeta;
  dir: string;
  occurredAt: string;
  tz: string;
  localDate: string;
  revokedAt: string | null;
}

async function loadCaptures(defaultTz: string): Promise<Capture[]> {
  const index = FixtureIndex.parse(await readJson(join(FIXTURES, 'index.json')));
  const tzByMsg = new Map(index.statuses.map((s) => [s.msgId, s.tz]));
  const inbox = join(FIXTURES, 'inbox');
  const revokes = new Map<string, string>();
  const revokeDir = join(inbox, '_revokes');
  if (existsSync(revokeDir)) {
    for (const name of await readdir(revokeDir)) {
      if (!name.endsWith('.json')) continue;
      const rec = RevokeRecord.parse(await readJson(join(revokeDir, name)));
      revokes.set(rec.msgId, rec.at);
    }
  }
  const captures: Capture[] = [];
  for (const name of (await readdir(inbox)).sort()) {
    if (name.startsWith('_')) continue;
    const dir = join(inbox, name);
    const meta = InboxMeta.parse(await readJson(join(dir, 'meta.json')));
    const sourceKey = waSourceKey(meta.msgId);
    const tz = tzByMsg.get(meta.msgId) ?? defaultTz;
    captures.push({
      sourceKey,
      publicId: await publicIdForSourceKey(sourceKey),
      meta,
      dir,
      occurredAt: meta.timestamp,
      tz,
      localDate: localDateFor(meta.timestamp, tz),
      revokedAt: revokes.get(meta.msgId) ?? null,
    });
  }
  return captures;
}

// ---------------------------------------------------------------------------------------------
// Build

interface Placed {
  date: string;
  entry: Entry;
  /** ImageSet usable as a day/trip cover. */
  coverImage?: ImageSet;
  sourceKey?: string;
}

async function captureEntry(c: Capture, ann: Annotation | undefined, tz: string): Promise<Placed['entry'] | null> {
  const { meta } = c;
  const common = {
    id: c.publicId,
    at: c.occurredAt,
    tz,
    ...(meta.caption ? { caption: meta.caption } : {}),
    ...(ann?.description ? { description: ann.description } : {}),
    ...(ann?.origLocale ? { descriptionOrig: ann.origLocale } : {}),
  };
  if (meta.kind === 'text') {
    const text = meta.text;
    if (!text) return null;
    return {
      ...common,
      kind: 'text',
      text: {
        body: text.body,
        bg: argbToRgbaHex(text.bgArgb ?? DEFAULT_TEXT_BG),
        fg: argbToRgbaHex(text.textArgb ?? DEFAULT_TEXT_FG),
        font: text.font ?? 'SYSTEM',
      },
    };
  }
  if (meta.kind === 'unsupported' || meta.download.state !== 'ok' || !meta.download.file) return null;
  const file = join(c.dir, meta.download.file);
  const bytes = await readFile(file);
  const sha = sha256(bytes);
  switch (meta.kind) {
    case 'photo':
      return { ...common, kind: 'photo', image: await processImage(bytes, sha, 'w') };
    case 'video':
      return { ...common, kind: 'video', video: await processVideo(file, sha, false) };
    case 'gif':
      return {
        ...common,
        kind: 'gif',
        video: { ...(await processVideo(file, sha, true)), hasAudio: false },
        loop: true,
      };
    case 'voice':
      return { ...common, kind: 'voice', audio: await processVoice(file, sha, meta.media?.waveformB64) };
  }
}

/** The published id of an owner post, as the generator writes it (hashed: the ULID never leaks). */
function publishedPostIdOf(publicId: string): string {
  return publishedPostIdFromSha256Hex(createHash('sha256').update(`post:${publicId}`).digest('hex'));
}

function postEntry(post: Post, tz: string): Entry | null {
  const locales = Object.keys(post.content) as LocaleCode[];
  if (post.kind === 'note') {
    const note: Partial<Record<LocaleCode, string>> = {};
    for (const l of locales) {
      const body = post.content[l]?.body;
      if (body) note[l] = body;
    }
    return { id: publishedPostIdOf(post.publicId), kind: 'note', at: post.occurredAt, tz, note, orig: post.origLocale };
  }
  // Story titles are guaranteed by the contract (StoryLocaleContent); the URL is derived with
  // routePath(locale, {name: 'story', date, id}), never stored.
  const story: Partial<Record<LocaleCode, { title: string; body: string }>> = {};
  for (const l of locales) {
    const c = post.content[l];
    if (c) story[l] = { title: c.title, body: c.body };
  }
  if (Object.keys(story).length === 0) return null;
  return { id: publishedPostIdOf(post.publicId), kind: 'story', at: post.occurredAt, tz, story, orig: post.origLocale };
}

/**
 * The portrait of setting site.avatar (generator rule: the owner's choice wins over the photo's
 * own visibility, but a revoke under on_revoke = hide removes it): like the backend's
 * pipeline/avatar.ts, only a round crop of the photo (the circle `object-fit: cover` shows at the
 * focus point, transparent corners) at AVATAR_SIZES, never the photo's own variants.
 */
async function avatarFor(
  setting: { sourceKey: string; focus?: { x: number; y: number } } | undefined,
  captures: readonly Capture[],
  onRevoke: string,
): Promise<AvatarImage | undefined> {
  if (!setting) return undefined;
  const c = captures.find((x) => x.sourceKey === setting.sourceKey);
  if (c?.meta.kind !== 'photo' || c.meta.download.state !== 'ok' || !c.meta.download.file) {
    console.warn(`dev-data: site.avatar ${setting.sourceKey} is not a downloaded photo: no portrait`);
    return undefined;
  }
  if (c.revokedAt && onRevoke === 'hide') return undefined;
  const bytes = await readFile(join(c.dir, c.meta.download.file));
  const oriented = await sharp(bytes).autoOrient().toBuffer();
  const meta = await sharp(oriented).metadata();
  const size = Math.min(meta.width, meta.height);
  const fx = setting.focus?.x ?? 0.5;
  const fy = setting.focus?.y ?? 0.5;
  const left = Math.round((meta.width - size) * fx);
  const top = Math.round((meta.height - size) * fy);
  const key = sha256(JSON.stringify({ dev: 1, x: fx, y: fy })).slice(0, 8);
  const sha = sha256(bytes);
  const sizes = AVATAR_SIZES.filter((s) => s <= size);
  const sources: AvatarImage['sources'] = { avif: [], webp: [] };
  for (const edge of sizes.length > 0 ? sizes : [size]) {
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}"><circle cx="${edge / 2}" cy="${edge / 2}" r="${edge / 2}"/></svg>`,
    );
    for (const ext of ['avif', 'webp'] as const) {
      const rel = mediaRel(sha, `avatar_${key}_s${edge}`, ext);
      written.add(rel);
      const file = join(OUT, rel);
      if (!existsSync(file)) {
        await mkdir(dirname(file), { recursive: true });
        // The circle is applied to the resized square (two steps: sharp extracts before resizing).
        const square = await sharp(oriented)
          .extract({ left, top, width: size, height: size })
          .resize(edge, edge)
          .ensureAlpha()
          .png()
          .toBuffer();
        const round = sharp(square).composite([{ input: mask, blend: 'dest-in' }]);
        await (ext === 'avif' ? round.avif({ quality: 50, effort: 4 }) : round.webp({ quality: 75 })).toFile(
          `${file}.tmp`,
        );
        await rename(`${file}.tmp`, file);
      }
      sources[ext].push({ w: edge, src: rel });
    }
  }
  const smallest = sources.webp[0]?.src;
  if (!smallest) return undefined;
  const small = await sharp(join(OUT, smallest)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString('base64');
  const { dominant } = await sharp(oriented).extract({ left, top, width: size, height: size }).stats();
  const edge = sources.webp.at(-1)?.w ?? size;
  return { w: edge, h: edge, color: hexColor(dominant), thumbhash, sources };
}

function coverOf(entry: Entry): ImageSet | undefined {
  if (entry.kind === 'photo') return entry.image;
  if (entry.kind === 'video' || entry.kind === 'gif') return entry.video.poster;
  return undefined;
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

async function build(): Promise<void> {
  if (args.clean) await rm(OUT, { recursive: true, force: true });
  const owner = OwnerFile.parse(await readJson(join(FIXTURES, 'owner.json')));
  const settings = withSettingsDefaults(owner.settings);
  const annotations = new Map(owner.annotations.map((a) => [a.sourceKey, a]));
  const ownerDays = new Map(owner.days.map((d) => [d.localDate, d]));
  const captures = await loadCaptures(settings['timezone.current']);

  const placed: Placed[] = [];
  const skipped: string[] = [];
  const dayTz = (localDate: string) => ownerDays.get(localDate)?.tz ?? null;
  for (const c of captures) {
    const ann = annotations.get(c.sourceKey);
    const visibility = effectiveCaptureVisibility(
      { occurredAt: c.occurredAt, revokedAt: c.revokedAt },
      ann ?? null,
      settings,
      NOW,
    );
    if (visibility !== 'public' || c.meta.kind === 'unsupported') {
      skipped.push(`${c.meta.kind} ${c.meta.msgId} (${c.meta.kind === 'unsupported' ? 'unsupported' : visibility})`);
      continue;
    }
    const entry = await captureEntry(c, ann, effectiveTz(c, ann ?? null, dayTz(c.localDate)));
    if (!entry) {
      skipped.push(`${c.meta.kind} ${c.meta.msgId} (no media: download ${c.meta.download.state})`);
      continue;
    }
    const cover = coverOf(entry);
    placed.push({
      date: effectiveLocalDate(c, ann ?? null, dayTz(c.localDate)),
      entry,
      sourceKey: c.sourceKey,
      ...(cover ? { coverImage: cover } : {}),
    });
  }
  for (const post of owner.posts) {
    if (post.visibility !== 'public') {
      skipped.push(`${post.kind} ${post.publicId} (${post.visibility})`);
      continue;
    }
    const entry = postEntry(post, effectiveTz(post, null, dayTz(post.localDate)));
    if (entry) placed.push({ date: effectiveLocalDate(post, null, dayTz(post.localDate)), entry });
  }

  const coverBySourceKey = new Map(
    placed.filter((p) => p.sourceKey && p.coverImage).map((p) => [p.sourceKey as string, p.coverImage as ImageSet]),
  );
  const dates = [...new Set(placed.map((p) => p.date))].sort();
  // Trip membership comes from the trip date ranges only (contracts ./policy).
  const tripOf = (date: string): string | undefined => tripForDate(date, owner.trips) ?? undefined;

  // Days
  const summaries: DaySummary[] = [];
  const dayFiles = new Map<string, DayDetail>();
  dates.forEach((date, i) => {
    const items = placed
      .filter((p) => p.date === date)
      .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.entry.id.localeCompare(b.entry.id));
    const entries = items.map((p) => p.entry);
    const od = ownerDays.get(date);
    const tz = mostCommon(entries.map((e) => e.tz)) ?? settings['timezone.current'];
    const trip = tripOf(date);
    const orig = od?.title || od?.summary ? (od.origLocale ?? undefined) : undefined;
    const prev = dates[i - 1];
    const next = dates[i + 1];
    const body = {
      contractVersion: 1 as const,
      date,
      ...(od?.title ? { title: od.title } : {}),
      ...(od?.summary ? { summary: od.summary } : {}),
      ...(orig ? { orig } : {}),
      ...(od?.placeName ? { place: od.placeName } : {}),
      ...(od?.countryCode ? { country: od.countryCode } : {}),
      tz,
      ...(trip ? { trip } : {}),
      ...(prev ? { prev } : {}),
      ...(next ? { next } : {}),
      entries,
    };
    const v = contentHash(body);
    const detail = DayDetail.parse({ ...body, v });
    dayFiles.set(date, detail);

    const counts = { photo: 0, video: 0, gif: 0, voice: 0, text: 0, note: 0, story: 0 };
    for (const e of entries) counts[e.kind]++;
    const cover =
      (od?.coverSourceKey ? coverBySourceKey.get(od.coverSourceKey) : undefined) ??
      items.find((p) => p.coverImage)?.coverImage;
    summaries.push({
      date,
      v,
      ...(od?.title ? { title: od.title } : {}),
      ...(orig ? { orig } : {}),
      ...(od?.placeName ? { place: od.placeName } : {}),
      ...(od?.countryCode ? { country: od.countryCode } : {}),
      ...(trip ? { trip } : {}),
      tz,
      counts,
      ...(cover ? { cover } : {}),
      firstAt: entries[0]?.at ?? `${date}T00:00:00Z`,
      lastAt: entries.at(-1)?.at ?? `${date}T00:00:00Z`,
    });
  });

  // Trips: only those with at least one public day (planned trips stay off the site).
  const tripSummaries: TripSummary[] = [];
  const tripFiles = new Map<string, TripDetail>();
  for (const t of publishedTrips(owner.trips, dates)) {
    const tripDays = summaries.filter((d) => d.trip === t.slug);
    const cover =
      (t.coverSourceKey ? coverBySourceKey.get(t.coverSourceKey) : undefined) ?? tripDays.find((d) => d.cover)?.cover;
    const body = {
      contractVersion: 1 as const,
      slug: t.slug,
      title: t.title,
      ...(t.description ? { description: t.description } : {}),
      ...(t.origLocale ? { orig: t.origLocale } : {}),
      start: t.startDate,
      end: t.endDate,
      ...(cover ? { cover } : {}),
      days: tripDays.map((d) => d.date),
    };
    const v = contentHash(body);
    tripFiles.set(t.slug, TripDetail.parse({ ...body, v }));
    tripSummaries.push({
      slug: t.slug,
      v,
      title: t.title,
      ...(t.origLocale ? { orig: t.origLocale } : {}),
      start: t.startDate,
      end: t.endDate,
      ...(cover ? { cover } : {}),
      countries: [...new Set(tripDays.map((d) => d.country).filter((c): c is string => !!c))],
      dayCount: tripDays.length,
    });
  }

  // Profile (only when the owner set something usable)
  const author = typeof settings['site.author'] === 'string' ? settings['site.author'] : undefined;
  const intro = settings['site.intro'];
  const avatar = await avatarFor(settings['site.avatar'], captures, settings['ingest.on_revoke']);
  const profileValue = SiteProfile.parse({
    ...(author ? { author } : {}),
    ...(intro && Object.keys(intro).length > 0 ? { intro } : {}),
    ...(avatar ? { avatar } : {}),
  });
  const profile = Object.keys(profileValue).length > 0 ? profileValue : undefined;

  // Timeline + manifest (generatedAt/version only move when the content changes)
  const timelineV = contentHash({ trips: tripSummaries, days: summaries, ...(profile ? { profile } : {}) });
  const prevManifest = Manifest.safeParse(
    existsSync(join(OUT, MANIFEST_PATH)) ? await readJson(join(OUT, MANIFEST_PATH)) : null,
  );
  const unchanged = prevManifest.success && prevManifest.data.timeline.v === timelineV;
  const generatedAt = unchanged ? prevManifest.data.generatedAt : new Date().toISOString();
  const site = {
    title: settings['site.title'],
    locales: settings['site.locales'],
    defaultLocale: settings['site.default_locale'],
    basePath: BASE_PATH,
    indexable: settings['site.indexable'],
  };
  const siteUnchanged = prevManifest.success && JSON.stringify(prevManifest.data.site) === JSON.stringify(site);
  const version = prevManifest.success ? prevManifest.data.version + (unchanged && siteUnchanged ? 0 : 1) : 1;
  const timeline = TimelineIndex.parse({
    contractVersion: 1,
    generatedAt,
    trips: tripSummaries,
    days: summaries,
    ...(profile ? { profile } : {}),
  });
  const manifest = Manifest.parse({ contractVersion: 1, version, generatedAt, site, timeline: { v: timelineV } });

  // Write: day/trip files first, timeline, manifest last (like the publisher).
  await rm(join(OUT, 'data/days'), { recursive: true, force: true });
  await rm(join(OUT, 'data/trips'), { recursive: true, force: true });
  for (const [date, day] of dayFiles) await writeJsonAtomic(join(OUT, dayDataPath(date)), day);
  for (const [slug, trip] of tripFiles) await writeJsonAtomic(join(OUT, tripDataPath(slug)), trip);
  await writeJsonAtomic(join(OUT, TIMELINE_PATH), timeline);
  await writeJsonAtomic(join(OUT, MANIFEST_PATH), manifest);

  // Remove media no longer referenced (e.g. an item that became hidden).
  let removed = 0;
  const mediaDir = join(OUT, 'media');
  if (existsSync(mediaDir)) {
    for (const sub of await readdir(mediaDir)) {
      for (const name of await readdir(join(mediaDir, sub))) {
        const rel = `media/${sub}/${name}`;
        if (!written.has(rel)) {
          await rm(join(OUT, rel), { force: true });
          removed++;
        }
      }
    }
  }

  console.log(
    `dev-data: ${dates.length} days, ${tripFiles.size} trips, ${placed.length} entries, ` +
      `${profile ? `profile (${Object.keys(profile).join(', ')}), ` : ''}` +
      `${written.size} media files (${removed} removed), manifest v${version}${unchanged ? ' (unchanged)' : ''}`,
  );
  for (const s of skipped) console.log(`  skipped ${s}`);
}

// ---------------------------------------------------------------------------------------------
// Validation (re-reads everything from disk)

function collectMedia(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    if (value.startsWith('media/')) out.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectMedia(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectMedia(v, out);
  }
}

async function validate(): Promise<void> {
  const problems: string[] = [];
  const parse = async <T>(schema: z.ZodType<T>, rel: string): Promise<T | null> => {
    const file = join(OUT, rel);
    if (!existsSync(file)) {
      problems.push(`${rel}: missing`);
      return null;
    }
    const result = schema.safeParse(await readJson(file));
    if (!result.success) {
      problems.push(`${rel}:\n${z.prettifyError(result.error)}`);
      return null;
    }
    return result.data;
  };

  const manifest = await parse(Manifest, MANIFEST_PATH);
  const timeline = await parse(TimelineIndex, TIMELINE_PATH);
  const media = new Set<string>();
  let files = 2;
  if (manifest && timeline) {
    const { generatedAt: _g, contractVersion: _c, ...content } = timeline;
    if (contentHash(content) !== manifest.timeline.v) problems.push('manifest.timeline.v does not match timeline.json');
    collectMedia(timeline, media);
    const sorted = [...timeline.days].map((d) => d.date);
    if (sorted.join() !== [...sorted].sort().join()) problems.push('timeline.days not ascending');
    for (const summary of timeline.days) {
      const day = await parse(DayDetail, dayDataPath(summary.date));
      files++;
      if (!day) continue;
      const { v, ...body } = day;
      if (v !== summary.v || contentHash(body) !== v) problems.push(`${dayDataPath(summary.date)}: v mismatch`);
      const ats = day.entries.map((e) => e.at);
      if (ats.join() !== [...ats].sort().join())
        problems.push(`${dayDataPath(summary.date)}: entries not chronological`);
      collectMedia(day, media);
    }
    for (const summary of timeline.trips) {
      const trip = await parse(TripDetail, tripDataPath(summary.slug));
      files++;
      if (!trip) continue;
      const { v, ...body } = trip;
      if (v !== summary.v || contentHash(body) !== v) problems.push(`${tripDataPath(summary.slug)}: v mismatch`);
    }
  }
  for (const rel of media) if (!existsSync(join(OUT, rel))) problems.push(`${rel}: referenced but missing`);

  if (problems.length > 0) {
    console.error(`dev-data INVALID (${relative(process.cwd(), OUT)}):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(
    `dev-data valid: ${files} JSON files match @omw/contracts/site, ${media.size} referenced media files exist ` +
      `(${relative(process.cwd(), OUT) || '.'})`,
  );
}

if (!args.check) await build();
await validate();
