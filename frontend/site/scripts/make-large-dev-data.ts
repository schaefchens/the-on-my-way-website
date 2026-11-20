/**
 * Synthetic LARGE data set for scale testing of the timeline (zoom anchoring, virtualization,
 * month grids, many trips): ~150 days over two years with three trips, written to
 * frontend/site/dev-data-large/ (git-ignored). The default dev-data is never touched; serve the
 * large set with
 *
 *   OMW_DEV_DATA_DIR=dev-data-large pnpm --filter @omw/site dev
 *
 * Images: a pool of synthetic "postcards" (SVG rendered by sharp) in w320/w640/w1080 AVIF + WebP
 * with ThumbHash and dominant colour; entries reuse the pool (media are content-addressed, D8).
 * Video and voice media are copied from ./dev-data (run `pnpm --filter @omw/site dev-data` first)
 * and reused. Everything is deterministic (seeded), validated with the zod contracts.
 *
 * Usage: pnpm --filter @omw/site dev-data:large [--out <dir>] [--today YYYY-MM-DD] [--clean]
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { I18nText, LocaleCode } from '@omw/contracts/i18n';
import {
  type AudioMedia,
  DayDetail,
  type DaySummary,
  type Entry,
  type ImageSet,
  Manifest,
  type TextStyle,
  TimelineIndex,
  TripDetail,
  type TripSummary,
  type VideoMedia,
} from '@omw/contracts/site';
import { addDays, localDateFor } from '@omw/contracts/time';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    today: { type: 'string' },
    clean: { type: 'boolean', default: false },
  },
});
const OUT = args.out
  ? isAbsolute(args.out)
    ? args.out
    : resolve(process.cwd(), args.out)
  : join(SITE_ROOT, 'dev-data-large');
const SOURCE = join(SITE_ROOT, 'dev-data');
const NOW = new Date();
// The current trip ends in Thailand: "today" is the traveler's date there.
const TODAY = args.today ?? localDateFor(NOW, 'Asia/Bangkok');

// ---------------------------------------------------------------------------------------------
// Deterministic randomness

let seed = 0x5eed1e55;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function captureId(n: number): string {
  const h = sha256(`large-${n}`);
  let out = '';
  for (let i = 0; i < 12; i++) out += B32[Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) % 32];
  return `e_${out}`;
}
const contentHash = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------------------------
// Image pool

const PALETTES: ReadonlyArray<[string, string, string]> = [
  ['#f8c868', '#f49a6c', '#c86a5a'],
  ['#9fd8e8', '#5aa6c8', '#2f5f8a'],
  ['#f7d0dd', '#cdb8f0', '#8e6bd6'],
  ['#b7e4c7', '#74c69d', '#2d6a4f'],
  ['#ffd6a5', '#ffadad', '#bd5f7d'],
  ['#e9edc9', '#ccd5ae', '#7f8f5a'],
  ['#c3e0ff', '#a0c4ff', '#5465b0'],
  ['#ffe5ec', '#ffb3c6', '#c9184a'],
  ['#fde2e4', '#fad2e1', '#a26769'],
  ['#d8e2dc', '#9d8189', '#5e4955'],
  ['#fff1c1', '#f4a261', '#264653'],
  ['#e0c3fc', '#8ec5fc', '#44476b'],
];

function postcardSvg(w: number, h: number, palette: [string, string, string], label: string, variant: number): string {
  const [a, b, c] = palette;
  const sunX = 0.2 + (variant % 5) * 0.15;
  const hill = (y: number, amp: number, phase: number) => {
    let d = `M0 ${h}`;
    for (let x = 0; x <= w; x += w / 16)
      d += ` L${x.toFixed(1)} ${(y + Math.sin((x / w) * 6.28 + phase) * amp).toFixed(1)}`;
    return `${d} L${w} ${h} Z`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
  <radialGradient id="s"><stop offset="0" stop-color="#fffbe6"/><stop offset="1" stop-color="#fffbe6" stop-opacity="0"/></radialGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${w * sunX}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.28}" fill="url(#s)"/>
  <path d="${hill(h * 0.68, h * 0.04, variant)}" fill="${c}" opacity=".55"/>
  <path d="${hill(h * 0.8, h * 0.05, variant * 2 + 1)}" fill="${c}" opacity=".85"/>
  <text x="50%" y="${h * 0.5}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${Math.round(w / 14)}" fill="#ffffff" fill-opacity=".92">${label}</text>
</svg>`;
}

function mediaRel(sha: string, variant: string, ext: string): string {
  return `media/${sha.slice(0, 2)}/${sha.slice(0, 16)}_${variant}.${ext}`;
}

async function imageSet(input: Buffer): Promise<ImageSet> {
  const sha = sha256(input);
  const meta = await sharp(input).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const sources: ImageSet['sources'] = { avif: [], webp: [] };
  for (const w of [320, 640, 1080].filter((x) => x <= W)) {
    for (const ext of ['avif', 'webp'] as const) {
      const rel = mediaRel(sha, `w${w}`, ext);
      const file = join(OUT, rel);
      if (!existsSync(file)) {
        await mkdir(dirname(file), { recursive: true });
        const p = sharp(input).resize({ width: w });
        await (ext === 'avif' ? p.avif({ quality: 50, effort: 2 }) : p.webp({ quality: 75 })).toFile(file);
      }
      sources[ext].push({ w, src: rel });
    }
  }
  const small = await sharp(input)
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const thumbhash = Buffer.from(rgbaToThumbHash(small.info.width, small.info.height, small.data)).toString('base64');
  const { dominant } = await sharp(input).stats();
  const color = `#${[dominant.r, dominant.g, dominant.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return { w: W, h: H, color, thumbhash, sources };
}

// ---------------------------------------------------------------------------------------------
// World

interface Place {
  name: string;
  country: string;
  tz: string;
}

const HOME: Place[] = [
  { name: 'Leipzig', country: 'DE', tz: 'Europe/Berlin' },
  { name: 'Berlin', country: 'DE', tz: 'Europe/Berlin' },
  { name: 'Dresden', country: 'DE', tz: 'Europe/Berlin' },
];

interface TripPlan {
  slug: string;
  title: I18nText;
  description: I18nText;
  start: string;
  days: number;
  stops: Place[];
}

const TRIPS: TripPlan[] = [
  {
    slug: 'iberia-2025',
    title: { de: 'Portugal & Spanien', en: 'Portugal & Spain' },
    description: {
      de: 'Drei Wochen mit dem Zug von Lissabon bis Barcelona: Kacheln, Meer und viel zu viele Pastéis.',
      en: 'Three weeks by train from Lisbon to Barcelona: tiles, sea and far too many pastéis.',
    },
    start: '2025-04-03',
    days: 22,
    stops: [
      { name: 'Lisboa', country: 'PT', tz: 'Europe/Lisbon' },
      { name: 'Porto', country: 'PT', tz: 'Europe/Lisbon' },
      { name: 'Sevilla', country: 'ES', tz: 'Europe/Madrid' },
      { name: 'Granada', country: 'ES', tz: 'Europe/Madrid' },
      { name: 'Barcelona', country: 'ES', tz: 'Europe/Madrid' },
    ],
  },
  {
    slug: 'japan-2025',
    title: { de: 'Japan im Herbst', en: 'Japan in autumn' },
    description: { de: 'Ahornrot, Onsen und Nachtzüge.' },
    start: '2025-10-10',
    days: 24,
    stops: [
      { name: 'Tōkyō', country: 'JP', tz: 'Asia/Tokyo' },
      { name: 'Hakone', country: 'JP', tz: 'Asia/Tokyo' },
      { name: 'Kyōto', country: 'JP', tz: 'Asia/Tokyo' },
      { name: 'Ōsaka', country: 'JP', tz: 'Asia/Tokyo' },
    ],
  },
  {
    slug: 'suedostasien-2026',
    title: { de: 'Südostasien', en: 'Southeast Asia' },
    description: {
      de: 'Von Hà Nội über Angkor bis nach Bangkok – ohne Rückflug.',
      en: 'From Hà Nội via Angkor to Bangkok – no return flight.',
    },
    start: '',
    days: 62,
    stops: [
      { name: 'Hà Nội', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'Hạ Long', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'Hội An', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'Sài Gòn', country: 'VN', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'Siem Reap', country: 'KH', tz: 'Asia/Phnom_Penh' },
      { name: 'Phnom Penh', country: 'KH', tz: 'Asia/Phnom_Penh' },
      { name: 'Bangkok', country: 'TH', tz: 'Asia/Bangkok' },
      { name: 'Chiang Mai', country: 'TH', tz: 'Asia/Bangkok' },
    ],
  },
];

const TITLES: Array<I18nText> = [
  { de: 'Erster Kaffee, erste Gasse', en: 'First coffee, first alley' },
  { de: 'Markt am Morgen', en: 'Morning market' },
  { de: 'Regen und Nudelsuppe', en: 'Rain and noodle soup' },
  { de: 'Sonnenuntergang am Wasser', en: 'Sunset by the water' },
  { de: 'Ein Tag im Zug', en: 'A day on the train' },
  { de: 'Tempel, so weit das Auge reicht', en: 'Temples as far as the eye can see' },
  { de: 'Wanderung über den Kamm', en: 'Hike along the ridge' },
  { de: 'Nichts tun. Herrlich.' },
  { de: 'Neue Freundinnen', en: 'New friends' },
  { de: 'Laternen und Lichter', en: 'Lanterns and lights' },
  { de: 'Fahrrad statt Bus', en: 'Bike instead of bus' },
  { de: 'Heimweh, ein bisschen' },
];

const NOTES: Array<I18nText> = [
  {
    de: 'Heute habe ich mich dreimal verlaufen und jedes Mal etwas Schönes gefunden.',
    en: 'Got lost three times today and found something lovely every time.',
  },
  { de: 'Notiz an mich: mehr Sonnencreme. Viel mehr.', en: 'Note to self: more sunscreen. Much more.' },
  { de: 'Die Oma vom Frühstücksstand hat mir ein Armband geschenkt 🥹' },
  { de: 'Zug verpasst, Sonnenaufgang bekommen. Fairer Tausch.', en: 'Missed the train, got the sunrise. Fair trade.' },
];

const TEXTS: TextStyle[] = [
  { body: 'Guten Morgen aus dem Nachtzug ☀️', bg: '#be4a74ff', fg: '#ffffffff', font: 'CALISTOGA_REGULAR' },
  { body: 'Wer will Postkarten? 💌', bg: '#5d3fa0ff', fg: '#ffffffff', font: 'FB_SCRIPT' },
  { body: '34 °C und ich liebe es', bg: '#f4a261ff', fg: '#3b2341ff', font: 'EXO2_EXTRABOLD' },
  { body: 'kurze Pause. bin glücklich.', bg: '#264653ff', fg: '#fff8f6ff', font: 'COURIERPRIME_BOLD' },
  { body: 'Heimweh nach Brezeln 🥨', bg: '#3b2341ff', fg: '#ffffffff', font: 'SYSTEM' },
];

// ---------------------------------------------------------------------------------------------

interface DayPlan {
  date: string;
  place: Place;
  trip: string | null;
}

function planDays(): DayPlan[] {
  const plans: DayPlan[] = [];
  const current = TRIPS[2] as TripPlan;
  current.start = addDays(TODAY, -(current.days - 1));
  for (const trip of TRIPS) {
    const per = Math.ceil(trip.days / trip.stops.length);
    for (let i = 0; i < trip.days; i++) {
      // Skip a few days so trips have gaps, but always keep the first and the last day.
      if (i > 0 && i < trip.days - 1 && rand() < 0.12) continue;
      plans.push({
        date: addDays(trip.start, i),
        place: trip.stops[Math.min(trip.stops.length - 1, Math.floor(i / per))] as Place,
        trip: trip.slug,
      });
    }
  }
  // Loose days at home, spread over two years (not inside trips).
  const taken = new Set(plans.map((p) => p.date));
  const first = addDays(TODAY, -720);
  let added = 0;
  while (added < 48) {
    const date = addDays(first, int(0, 700));
    if (taken.has(date) || TRIPS.some((t) => date >= t.start && date <= addDays(t.start, t.days - 1))) continue;
    taken.add(date);
    plans.push({ date, place: pick(HOME), trip: null });
    added++;
  }
  return plans.sort((a, b) => (a.date < b.date ? -1 : 1));
}

function isoAt(date: string, hour: number, minute: number, tz: string): string {
  // Wall clock in tz -> UTC (good enough for synthetic data: correct the offset once).
  const guess = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    hour,
    minute,
  );
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const shownMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  let offset = shownMinutes - (hour * 60 + minute);
  if (Number(parts.day) !== Number(date.slice(8, 10)))
    offset += Number(parts.day) > Number(date.slice(8, 10)) ? 1440 : -1440;
  return new Date(guess - offset * 60_000).toISOString().replace('.000Z', 'Z');
}

async function main(): Promise<void> {
  if (args.clean) await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // Reusable video/voice media from the default dev data.
  let video: VideoMedia | null = null;
  let gif: VideoMedia | null = null;
  let voice: AudioMedia | null = null;
  const dayDir = join(SOURCE, 'data/days');
  if (existsSync(dayDir)) {
    for (const name of await readdir(dayDir)) {
      const day = JSON.parse(await readFile(join(dayDir, name), 'utf8')) as { entries: Entry[] };
      for (const e of day.entries) {
        if (e.kind === 'video') video ??= e.video;
        if (e.kind === 'gif') gif ??= e.video;
        if (e.kind === 'voice') voice ??= e.audio;
      }
    }
  }
  const copyMedia = async (rel: string) => {
    const to = join(OUT, rel);
    if (!existsSync(to)) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(join(SOURCE, rel), to);
    }
  };
  for (const v of [video, gif]) {
    if (!v) continue;
    await copyMedia(v.src);
    for (const s of [...v.poster.sources.avif, ...v.poster.sources.webp]) await copyMedia(s.src);
  }
  if (voice) await copyMedia(voice.src);
  if (!video || !voice)
    console.warn('No video/voice in ./dev-data: run `pnpm --filter @omw/site dev-data` first; skipping those kinds.');

  const plans = planDays();
  // Image pool: one postcard per (place, variant), 3 variants per place, portrait and landscape.
  const pool = new Map<string, ImageSet[]>();
  const places = [...new Map(plans.map((p) => [p.place.name, p.place])).values()];
  let made = 0;
  for (const place of places) {
    const sets: ImageSet[] = [];
    for (let v = 0; v < 3; v++) {
      const portrait = v === 1;
      const [w, h] = portrait ? [1080, 1350] : [1600, 1200];
      const palette = PALETTES[(made + v * 5) % PALETTES.length] as [string, string, string];
      const png = await sharp(Buffer.from(postcardSvg(w, h, palette, place.name, made + v)))
        .png()
        .toBuffer();
      sets.push(await imageSet(png));
    }
    pool.set(place.name, sets);
    made++;
  }

  let n = 0;
  let postN = 0;
  const days: DayDetail[] = [];
  const summaries: DaySummary[] = [];
  for (const [i, plan] of plans.entries()) {
    const entries: Entry[] = [];
    const count = plan.trip ? int(3, 11) : int(1, 4);
    const isLatest = i === plans.length - 1;
    for (let k = 0; k < count; k++) {
      const minutes = 7 * 60 + Math.round(((k + rand() * 0.8) / count) * 14 * 60);
      let at = isoAt(plan.date, Math.floor(minutes / 60), minutes % 60, plan.place.tz);
      // The newest day is "live": its moments lie in the last hours, never in the future.
      if (isLatest) at = new Date(NOW.getTime() - (count - k) * 47 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
      const base = { at, tz: plan.place.tz };
      const roll = rand();
      const images = pool.get(plan.place.name) as ImageSet[];
      if (roll < 0.58 || k === 0) {
        entries.push({
          ...base,
          id: captureId(n++),
          kind: 'photo',
          image: pick(images),
          ...(rand() < 0.4 ? { caption: pick(['😍', 'Ausblick!', 'Kein Filter', `${plan.place.name} ❤️`]) } : {}),
        });
      } else if (roll < 0.68) {
        entries.push({ ...base, id: captureId(n++), kind: 'text', text: pick(TEXTS) });
      } else if (roll < 0.76 && video) {
        entries.push({ ...base, id: captureId(n++), kind: 'video', video });
      } else if (roll < 0.8 && gif) {
        entries.push({ ...base, id: captureId(n++), kind: 'gif', video: { ...gif, hasAudio: false }, loop: true });
      } else if (roll < 0.87 && voice) {
        entries.push({ ...base, id: captureId(n++), kind: 'voice', audio: voice });
      } else if (roll < 0.96) {
        entries.push({
          ...base,
          id: `p_note${String(postN++).padStart(4, '0')}`,
          kind: 'note',
          note: pick(NOTES),
          orig: 'de',
        });
      } else {
        entries.push({
          ...base,
          id: `p_story${String(postN++).padStart(4, '0')}`,
          kind: 'story',
          orig: 'de',
          story: {
            de: {
              title: `Ein langer Tag in ${plan.place.name}`,
              body: 'Es fing mit Regen an …\n\nUnd endete mit dem schönsten Abend der Reise.',
            },
            en: {
              title: `A long day in ${plan.place.name}`,
              body: 'It started with rain …\n\nAnd ended with the best evening of the trip.',
            },
          },
        });
      }
    }
    entries.sort((a, b) => (a.at < b.at ? -1 : 1));
    const title = rand() < 0.75 ? pick(TITLES) : undefined;
    const counts = { photo: 0, video: 0, gif: 0, voice: 0, text: 0, note: 0, story: 0 };
    for (const e of entries) counts[e.kind]++;
    const cover = entries.find((e) => e.kind === 'photo')?.image;
    const detail: DayDetail = {
      contractVersion: 1,
      date: plan.date,
      v: '',
      ...(title ? { title, orig: 'de' as LocaleCode } : {}),
      place: plan.place.name,
      country: plan.place.country,
      tz: plan.place.tz,
      ...(plan.trip ? { trip: plan.trip } : {}),
      ...(i > 0 ? { prev: plans[i - 1]?.date } : {}),
      ...(i < plans.length - 1 ? { next: plans[i + 1]?.date } : {}),
      entries,
    };
    detail.v = contentHash(detail);
    days.push(DayDetail.parse(detail));
    summaries.push({
      date: plan.date,
      v: detail.v,
      ...(title ? { title, orig: 'de' as LocaleCode } : {}),
      place: plan.place.name,
      country: plan.place.country,
      ...(plan.trip ? { trip: plan.trip } : {}),
      tz: plan.place.tz,
      counts,
      ...(cover ? { cover } : {}),
      firstAt: entries[0]?.at as string,
      lastAt: entries.at(-1)?.at as string,
    });
  }

  const trips: TripSummary[] = [];
  const tripDetails: TripDetail[] = [];
  for (const t of TRIPS) {
    const tripDays = summaries.filter((d) => d.trip === t.slug);
    const start = tripDays[0]?.date ?? t.start;
    const end = tripDays.at(-1)?.date ?? t.start;
    const cover = tripDays[Math.floor(tripDays.length / 3)]?.cover;
    const detail: TripDetail = {
      contractVersion: 1,
      slug: t.slug,
      v: '',
      title: t.title,
      description: t.description,
      orig: 'de',
      start,
      end,
      ...(cover ? { cover } : {}),
      days: tripDays.map((d) => d.date),
    };
    detail.v = contentHash(detail);
    tripDetails.push(TripDetail.parse(detail));
    trips.push({
      slug: t.slug,
      v: detail.v,
      title: t.title,
      orig: 'de',
      start,
      end,
      ...(cover ? { cover } : {}),
      countries: [...new Set(tripDays.map((d) => d.country).filter((c): c is string => !!c))],
      dayCount: tripDays.length,
    });
  }

  const generatedAt = NOW.toISOString();
  const timeline = TimelineIndex.parse({ contractVersion: 1, generatedAt, trips, days: summaries });
  const timelineV = contentHash(timeline);
  const manifest = Manifest.parse({
    contractVersion: 1,
    version: 1,
    generatedAt,
    site: { title: 'On My Way', locales: ['de', 'en'], defaultLocale: 'de', basePath: '/', indexable: false },
    timeline: { v: timelineV },
  });

  await rm(join(OUT, 'data'), { recursive: true, force: true });
  for (const d of days) await writeJson(join(OUT, 'data/days', `${d.date}.json`), d);
  for (const t of tripDetails) await writeJson(join(OUT, 'data/trips', `${t.slug}.json`), t);
  await writeJson(join(OUT, 'data/timeline.json'), timeline);
  await writeJson(join(OUT, 'data/manifest.json'), manifest);
  console.log(`dev-data-large: ${days.length} days, ${trips.length} trips, ${n + postN} entries -> ${OUT}`);
}

await main();
