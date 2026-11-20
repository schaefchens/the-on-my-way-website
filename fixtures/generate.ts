/**
 * Synthetic, deterministic fixtures (no phone, no copyrighted material).
 *
 *   pnpm fixtures
 *
 * Writes
 *   fixtures/generated/inbox/<msgId>/{meta.json, original.<ext>}   InboxMeta per status (D9)
 *   fixtures/generated/inbox/_revokes/<msgId>.json                RevokeRecord
 *   fixtures/generated/owner.json                                 owner content as API entities
 *                                                                 + the same as a change feed page
 *   fixtures/generated/index.json                                 what was generated (tz, dates, …)
 *   fixtures/vectors/{ids,time,policy,mode-switch,placement,trips}.json
 *                                                                 cross-runtime test vectors (PHP)
 *
 *   pnpm fixtures --owner-only
 *
 * rewrites only owner.json and the vectors from the existing fixtures/generated/index.json (no
 * media work, nothing else in fixtures/generated is touched), e.g. after changing the demo owner
 * content below.
 *
 * The owner content is the demo/preview owner: a trip, day titles, notes, a story, descriptions
 * and the profile (site.author "Lea", a greeting per locale, a portrait from a fixture photo).
 *
 * Besides the happy path the statuses cover: a photo whose download is still pending (no
 * original), a video whose media is permanently lost, a colourless text status (Conversation),
 * one "live" and one "history" status (with sender.jid + raw proto), and a lid-only sender.
 * rawProtoB64 is a placeholder ("fixture:…" bytes, not a real protobuf) on every status.
 *
 * Needs ffmpeg (libx264, libx265, libopus) on PATH. Text in photos is rendered by sharp/librsvg
 * through fontconfig; its cache is kept in .cache/fontconfig.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Annotation,
  Annotation as AnnotationSchema,
  ChangesResponse,
  type Day,
  Day as DaySchema,
  type Post,
  Post as PostSchema,
  SETTINGS_DEFAULTS,
  Settings,
  type Trip,
  Trip as TripSchema,
} from '@omw/contracts/api';
import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import {
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  MODE_SINCE_EPOCH,
  nextModeSince,
  type PolicySettings,
  tripForDate,
} from '@omw/contracts/policy';
import { localDateFor, localTimeFor } from '@omw/contracts/time';
import {
  type FontName,
  type InboxDownload,
  type InboxKind,
  InboxMeta,
  type InboxSender,
  type InboxText,
  RevokeRecord,
  type StatusSource,
} from '@omw/contracts/wa';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'fixtures', 'generated');
const INBOX = join(OUT, 'inbox');
const VECTORS = join(ROOT, 'fixtures', 'vectors');
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

// Keep fontconfig's cache inside the repo: our own config file lists the system font dirs and a
// cache dir under .cache/ (the embedded default config would write to /usr/local/var/cache).
const fontconfigDir = join(ROOT, '.cache', 'fontconfig');
mkdirSync(join(fontconfigDir, 'cache'), { recursive: true });
const fontsConf = join(fontconfigDir, 'fonts.conf');
writeFileSync(
  fontsConf,
  `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/System/Library/Fonts</dir>
  <dir>/Library/Fonts</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir>${join(fontconfigDir, 'cache')}</cachedir>
</fontconfig>
`,
);
process.env.FONTCONFIG_FILE = fontsConf;
process.env.XDG_CACHE_HOME = join(ROOT, '.cache', 'xdg');
const { default: sharp } = await import('sharp');
sharp.cache(false);
sharp.concurrency(1);

// ---------------------------------------------------------------------------------------------
// helpers

const TRAVELER = {
  pn: '4915100000001',
  lid: '100000000000001',
  jid: '100000000000001@lid',
  pushName: 'Reisende',
} as const;
const FEED_ID = 'f1x7ure0feed0000000000000000001';
const HCM = 'Asia/Ho_Chi_Minh';
const BERLIN = 'Europe/Berlin';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const addSeconds = (iso: string, s: number) => new Date(new Date(iso).getTime() + s * 1000).toISOString();

function msgIdFor(key: string): string {
  // WhatsApp-like: "3EB0" + 16 uppercase hex chars
  return `3EB0${sha256(`omw-fixture:${key}`).toString('hex').slice(0, 16).toUpperCase()}`;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

const BITEXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface PhotoSpec {
  w: number;
  h: number;
  from: string;
  to: string;
  label: string;
  sub: string;
  /** EXIF orientation 6: stored rotated, must be displayed rotated 90° clockwise. */
  exifRotate?: boolean;
}

async function makePhoto(spec: PhotoSpec): Promise<Buffer> {
  const { w, h } = spec;
  const big = Math.round(Math.min(w, h) * 0.11);
  const small = Math.round(big * 0.42);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${spec.from}"/>
      <stop offset="1" stop-color="${spec.to}"/>
    </linearGradient>
    <radialGradient id="sun" cx="0.75" cy="0.25" r="0.35">
      <stop offset="0" stop-color="#fff6d8" stop-opacity="0.85"/>
      <stop offset="1" stop-color="#fff6d8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/>
  <rect width="${w}" height="${h}" fill="url(#sun)"/>
  <path d="M0 ${h * 0.78} Q ${w * 0.25} ${h * 0.7} ${w * 0.5} ${h * 0.77} T ${w} ${h * 0.74} V ${h} H 0 Z" fill="#000" fill-opacity="0.12"/>
  <text x="${w / 2}" y="${h * 0.48}" font-family="Helvetica Neue, Helvetica, Arial, DejaVu Sans, sans-serif"
        font-size="${big}" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeXml(spec.label)}</text>
  <text x="${w / 2}" y="${h * 0.48 + big * 0.9}" font-family="Helvetica Neue, Helvetica, Arial, DejaVu Sans, sans-serif"
        font-size="${small}" fill="#ffffff" fill-opacity="0.85" text-anchor="middle">${escapeXml(spec.sub)}</text>
</svg>`;
  let img = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: spec.from });
  if (spec.exifRotate)
    img = sharp(await img.png().toBuffer())
      .rotate(270)
      .withMetadata({ orientation: 6 });
  return img.jpeg({ quality: 80, chromaSubsampling: '4:2:0', mozjpeg: false }).toBuffer();
}

function makeVideo(
  path: string,
  opts: { w: number; h: number; seconds: number; codec: 'h264' | 'hevc'; audio: boolean; freq?: number },
): void {
  const args = ['-f', 'lavfi', '-i', `testsrc2=size=${opts.w}x${opts.h}:rate=25:duration=${opts.seconds}`];
  if (opts.audio)
    args.push('-f', 'lavfi', '-i', `sine=frequency=${opts.freq ?? 440}:sample_rate=44100:duration=${opts.seconds}`);
  if (opts.codec === 'h264') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p', '-threads', '1');
  } else {
    args.push(
      '-c:v',
      'libx265',
      '-preset',
      'fast',
      '-crf',
      '34',
      '-pix_fmt',
      'yuv420p',
      '-tag:v',
      'hvc1',
      '-x265-params',
      'log-level=error:pools=none:frame-threads=1',
    );
  }
  if (opts.audio) args.push('-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-shortest');
  else args.push('-an');
  args.push(...BITEXACT, '-movflags', '+faststart', path);
  ffmpeg(args);
}

function makeVoice(path: string, seconds: number): void {
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:sample_rate=48000:duration=${seconds}`,
    '-af',
    'volume=0.6',
    '-c:a',
    'libopus',
    '-b:a',
    '24k',
    '-ac',
    '1',
    ...BITEXACT,
    path,
  ]);
}

/** 64 bytes 0..100 like WhatsApp's ptt waveform. */
function waveform(): Buffer {
  const out = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) {
    const env = Math.sin((Math.PI * i) / 63);
    out[i] = Math.round(100 * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.7))));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// statuses

interface BaseSpec {
  key: string;
  timestamp: string;
  tz: string;
  caption?: string;
  /** Default "fixture". */
  source?: StatusSource;
  /** Default TRAVELER (pn + lid + jid). */
  sender?: InboxSender;
  /** Media kinds only: a download that did not succeed (no original file is written). */
  download?: Pick<InboxDownload, 'state' | 'attempts' | 'reason' | 'permanent' | 'retryRequestedAt' | 'error'>;
}
type StatusSpec =
  | (BaseSpec & { kind: 'photo'; photo: PhotoSpec })
  | (BaseSpec & { kind: 'video'; video: { w: number; h: number; seconds: number; codec: 'h264' | 'hevc' } })
  | (BaseSpec & { kind: 'gif'; video: { w: number; h: number; seconds: number } })
  | (BaseSpec & { kind: 'voice'; seconds: number })
  | (BaseSpec & {
      kind: 'text';
      text: { body: string; bgArgb: number | null; textArgb: number | null; font: FontName | null };
    })
  | (BaseSpec & { kind: 'unsupported'; unsupportedType: string });

const label = (place: string, iso: string, tz: string) => `${place} · ${localTimeFor(iso, tz)}`;

const STATUSES: StatusSpec[] = [
  // Berlin, 2026-11-12 (before departure). 23:30Z on the 11th = 00:30 local on the 12th.
  {
    key: 'berlin-text',
    kind: 'text',
    timestamp: '2026-11-11T23:30:00Z',
    tz: BERLIN,
    text: {
      body: 'Koffer gepackt! Morgen geht’s los ✈️',
      bgArgb: 0xff8b6990,
      textArgb: 0xffffffff,
      font: 'CALISTOGA_REGULAR',
    },
  },
  {
    key: 'berlin-photo',
    kind: 'photo',
    timestamp: '2026-11-12T08:15:00Z',
    tz: BERLIN,
    caption: 'Tschüss Berlin',
    photo: { w: 1600, h: 1200, from: '#7d8fb3', to: '#e8b4a0', label: '', sub: 'Berlin' },
  },
  // Hà Nội, 2026-11-14
  {
    key: 'hanoi-photo',
    kind: 'photo',
    timestamp: '2026-11-14T01:40:00Z',
    tz: HCM,
    caption: 'Angekommen in Hà Nội',
    photo: { w: 1080, h: 1350, from: '#f2a65a', to: '#c85a7c', label: '', sub: 'Hà Nội' },
  },
  {
    key: 'hanoi-video',
    kind: 'video',
    timestamp: '2026-11-14T05:20:00Z',
    tz: HCM,
    caption: 'Mopeds überall',
    video: { w: 720, h: 1280, seconds: 4, codec: 'h264' },
  },
  {
    key: 'hanoi-text-vi',
    kind: 'text',
    timestamp: '2026-11-14T12:00:00Z',
    tz: HCM,
    text: { body: 'Xin chào Việt Nam! Phở ngon quá 🍜', bgArgb: 0xffc1a03f, textArgb: 0xffffffff, font: 'SYSTEM_BOLD' },
  },
  // Hội An, 2026-11-15
  {
    key: 'hoian-photo-morning',
    kind: 'photo',
    timestamp: '2026-11-15T02:12:00Z',
    tz: HCM,
    caption: 'Hội An',
    photo: { w: 1600, h: 1200, from: '#f6d365', to: '#fda085', label: '', sub: 'Altstadt' },
  },
  {
    key: 'hoian-gif',
    kind: 'gif',
    timestamp: '2026-11-15T04:30:00Z',
    tz: HCM,
    video: { w: 480, h: 480, seconds: 2 },
  },
  {
    key: 'hoian-voice',
    kind: 'voice',
    timestamp: '2026-11-15T09:45:00Z',
    tz: HCM,
    seconds: 3,
  },
  {
    key: 'hoian-photo-revoked',
    kind: 'photo',
    timestamp: '2026-11-15T11:05:00Z',
    tz: HCM,
    caption: 'Laternen (verwackelt)',
    photo: { w: 1080, h: 1350, from: '#3a1c71', to: '#d76d77', label: '', sub: 'gelöscht' },
  },
  {
    key: 'hoian-text-ar',
    kind: 'text',
    timestamp: '2026-11-15T16:30:00Z',
    tz: HCM,
    text: { body: 'مرحبا من هوي آن 🏮', bgArgb: 0xff243640, textArgb: 0xfff0e6d2, font: 'SYSTEM' },
  },
  // Hội An, 2026-11-16 — 18:30Z on the 15th is 01:30 local on the 16th
  {
    key: 'hoian-photo-night',
    kind: 'photo',
    timestamp: '2026-11-15T18:30:00Z',
    tz: HCM,
    caption: 'Noch wach',
    photo: { w: 1080, h: 1350, from: '#141e30', to: '#243b55', label: '', sub: 'EXIF orientation 6', exifRotate: true },
  },
  {
    key: 'hoian-video-hevc',
    kind: 'video',
    timestamp: '2026-11-16T03:00:00Z',
    tz: HCM,
    caption: 'Bootsfahrt',
    video: { w: 720, h: 1280, seconds: 3, codec: 'hevc' },
  },
  {
    key: 'hoian-unsupported',
    kind: 'unsupported',
    timestamp: '2026-11-16T06:00:00Z',
    tz: HCM,
    unsupportedType: 'pollCreationMessageV3',
  },
  {
    key: 'hoian-text-en',
    kind: 'text',
    timestamp: '2026-11-16T15:00:00Z',
    tz: HCM,
    text: { body: 'Good night, Hội An ✨', bgArgb: 0xff7e90a3, textArgb: 0xff111111, font: 'COURIERPRIME_BOLD' },
  },
  // Sài Gòn, 2026-11-17
  {
    key: 'saigon-photo',
    kind: 'photo',
    timestamp: '2026-11-17T00:50:00Z',
    tz: HCM,
    caption: 'Sài Gòn',
    photo: { w: 1600, h: 1200, from: '#43cea2', to: '#185a9d', label: '', sub: 'Bến Thành' },
  },
  // Edge cases of the capture pipeline (no original files).
  {
    key: 'saigon-photo-pending',
    kind: 'photo',
    timestamp: '2026-11-17T03:10:00Z',
    tz: HCM,
    caption: 'Chợ Bến Thành',
    source: 'live',
    photo: { w: 1080, h: 1350, from: '#ffffff', to: '#000000', label: '', sub: '' },
    download: { state: 'pending', attempts: 0 },
  },
  {
    key: 'saigon-video-lost',
    kind: 'video',
    timestamp: '2026-11-17T05:00:00Z',
    tz: HCM,
    source: 'history',
    video: { w: 720, h: 1280, seconds: 5, codec: 'h264' },
    download: {
      state: 'failed',
      attempts: 2,
      reason: 'expired',
      permanent: true,
      retryRequestedAt: '2026-11-17T05:01:00Z',
      error: 'media retry: NOT_FOUND',
    },
  },
  {
    key: 'saigon-text-plain',
    kind: 'text',
    timestamp: '2026-11-17T14:00:00Z',
    tz: HCM,
    source: 'live',
    sender: { lid: TRAVELER.lid, jid: TRAVELER.jid },
    text: { body: 'Plain text status without colours (Conversation)', bgArgb: null, textArgb: null, font: null },
  },
];

const PLACE: Record<string, string> = {
  'berlin-photo': 'Berlin',
  'hanoi-photo': 'Hà Nội',
  'hoian-photo-morning': 'Hội An',
  'hoian-photo-revoked': 'Hội An',
  'hoian-photo-night': 'Hội An',
  'saigon-photo': 'Sài Gòn',
};

const REVOKED: Record<string, string> = { 'hoian-photo-revoked': '2026-11-15T11:20:00Z' };

interface IndexEntry {
  key: string;
  msgId: string;
  sourceKey: string;
  publicId: string;
  kind: InboxKind;
  timestamp: string;
  tz: string;
  localDate: string;
  localTime: string;
  file: string | null;
  bytes: number;
  source: StatusSource;
  download: InboxDownload['state'];
  revokedAt: string | null;
  notes: string[];
}

async function writeStatus(spec: StatusSpec): Promise<IndexEntry> {
  const msgId = msgIdFor(spec.key);
  const dir = join(INBOX, msgId);
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  let file: string | null = null;
  let media: InboxMeta['media'];
  let text: InboxText | undefined;
  let unsupportedType: string | undefined;

  const failedDownload = spec.download;
  switch (spec.kind) {
    case 'photo': {
      if (failedDownload) {
        media = { mimetype: 'image/jpeg', fileSha256B64: '', fileLength: 0, width: spec.photo.w, height: spec.photo.h };
        notes.push(`download ${failedDownload.state} (no original)`);
        break;
      }
      const photo = { ...spec.photo, label: label(PLACE[spec.key] ?? '?', spec.timestamp, spec.tz) };
      const buf = await makePhoto(photo);
      file = 'original.jpg';
      writeFileSync(join(dir, file), buf);
      const meta = await sharp(buf).metadata();
      media = { mimetype: 'image/jpeg', fileSha256B64: '', fileLength: 0, width: meta.width, height: meta.height };
      if (photo.exifRotate) notes.push('stored 1350x1080 with EXIF orientation 6 (display 1080x1350)');
      notes.push(photo.w > photo.h ? 'landscape' : 'portrait');
      break;
    }
    case 'video': {
      if (failedDownload) {
        media = {
          mimetype: 'video/mp4',
          fileSha256B64: '',
          fileLength: 0,
          width: spec.video.w,
          height: spec.video.h,
          seconds: spec.video.seconds,
        };
        notes.push(`download ${failedDownload.state} (no original)`);
        break;
      }
      file = 'original.mp4';
      makeVideo(join(dir, file), { ...spec.video, audio: true, freq: spec.video.codec === 'hevc' ? 330 : 440 });
      media = {
        mimetype: 'video/mp4',
        fileSha256B64: '',
        fileLength: 0,
        width: spec.video.w,
        height: spec.video.h,
        seconds: spec.video.seconds,
      };
      notes.push(spec.video.codec === 'hevc' ? 'HEVC/AAC (needs transcode)' : 'H.264/AAC (remux only)');
      break;
    }
    case 'gif': {
      file = 'original.mp4';
      makeVideo(join(dir, file), { ...spec.video, codec: 'h264', audio: false });
      media = {
        mimetype: 'video/mp4',
        fileSha256B64: '',
        fileLength: 0,
        width: spec.video.w,
        height: spec.video.h,
        seconds: spec.video.seconds,
        gifPlayback: true,
      };
      notes.push('gif playback (muted H.264 loop)');
      break;
    }
    case 'voice': {
      file = 'original.ogg';
      makeVoice(join(dir, file), spec.seconds);
      media = {
        mimetype: 'audio/ogg; codecs=opus',
        fileSha256B64: '',
        fileLength: 0,
        seconds: spec.seconds,
        ptt: true,
        waveformB64: waveform().toString('base64'),
      };
      notes.push('ptt voice (Ogg/Opus)');
      break;
    }
    case 'text':
      text = { ...spec.text };
      break;
    case 'unsupported':
      unsupportedType = spec.unsupportedType;
      notes.push('unsupported message type (must stay hidden)');
      break;
  }
  if (spec.kind === 'text' && spec.text.bgArgb === null) notes.push('no colours/font (Conversation)');
  // Not a real protobuf: placeholder bytes so consumers can exercise the field.
  const rawProtoB64 = Buffer.from(`fixture:${spec.kind}:${spec.key}`).toString('base64');

  let download: InboxMeta['download'] = { state: 'not_applicable', attempts: 0 };
  let bytes = 0;
  if (file && media) {
    const buf = readFileSync(join(dir, file));
    const digest = sha256(buf);
    bytes = buf.length;
    media = { ...media, fileSha256B64: digest.toString('base64'), fileLength: buf.length };
    download = { state: 'ok', file, sha256Hex: digest.toString('hex'), attempts: 1 };
  } else if (media && failedDownload) {
    // FileSHA256/FileLength as announced in the message (we never saw the file).
    media = { ...media, fileSha256B64: sha256(`announced:${spec.key}`).toString('base64'), fileLength: 123_456 };
    download = { ...failedDownload };
  }
  const source = spec.source ?? 'fixture';
  if (source !== 'fixture') notes.push(`source ${source}`);
  const sender = spec.sender ?? { ...TRAVELER };
  if (!sender.pn) notes.push('lid-only sender');

  const meta = InboxMeta.parse({
    schema: 1,
    msgId,
    source,
    receivedAt: addSeconds(spec.timestamp, 3).replace('.000Z', 'Z'),
    sender,
    timestamp: spec.timestamp,
    kind: spec.kind,
    ...(spec.caption ? { caption: spec.caption } : {}),
    ...(text ? { text } : {}),
    ...(media ? { media } : {}),
    download,
    ...(unsupportedType ? { unsupportedType } : {}),
    rawProtoB64,
    ...(source === 'live' ? { addressingMode: 'lid' as const, stanzaTag: 'status' } : {}),
  } satisfies InboxMeta);
  writeFileSync(join(dir, 'meta.json'), json(meta));

  const revokedAt = REVOKED[spec.key] ?? null;
  if (revokedAt) {
    mkdirSync(join(INBOX, '_revokes'), { recursive: true });
    writeFileSync(
      join(INBOX, '_revokes', `${msgId}.json`),
      json(RevokeRecord.parse({ schema: 1, msgId, at: revokedAt })),
    );
    notes.push('revoked (inbox/_revokes)');
  }

  const sourceKey = waSourceKey(msgId);
  return {
    key: spec.key,
    msgId,
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    kind: spec.kind,
    timestamp: spec.timestamp,
    tz: spec.tz,
    localDate: localDateFor(spec.timestamp, spec.tz),
    localTime: localTimeFor(spec.timestamp, spec.tz),
    file,
    bytes,
    source,
    download: download.state,
    revokedAt,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// owner content

function ownerContent(byKey: Map<string, IndexEntry>) {
  const sk = (key: string) => {
    const e = byKey.get(key);
    if (!e) throw new Error(`unknown status ${key}`);
    return e.sourceKey;
  };
  const settings = Settings.parse({
    ...SETTINGS_DEFAULTS,
    'timezone.current': HCM,
    // The profile: whose journey it is (plain text; the greeting is shown handwritten).
    'site.author': 'Lea',
    'site.intro': {
      de: 'Hallo ihr Lieben! Schön, dass ihr mit mir unterwegs seid.',
      en: 'Hello, lovely people! So glad you’re coming along with me.',
    },
    'site.avatar': { sourceKey: sk('hanoi-photo'), focus: { x: 0.5, y: 0.4 } },
  });

  const trips: Trip[] = [
    TripSchema.parse({
      slug: 'vietnam-2026',
      title: { de: 'Vietnam 2026', en: 'Vietnam 2026' },
      description: {
        de: 'Von Hà Nội über Hội An nach Sài Gòn.',
        en: 'From Hà Nội via Hội An to Sài Gòn.',
      },
      origLocale: 'de',
      startDate: '2026-11-14',
      endDate: '2026-11-17',
      coverSourceKey: sk('hoian-photo-morning'),
      updatedAt: '2026-11-14T00:00:00Z',
    }),
  ];

  const days: Day[] = [
    DaySchema.parse({
      localDate: '2026-11-14',
      title: { de: 'Ankunft in Hà Nội', en: 'Arriving in Hà Nội' },
      origLocale: 'de',
      placeName: 'Hà Nội',
      countryCode: 'VN',
      lat: 21.0285,
      lng: 105.8542,
      coverSourceKey: sk('hanoi-photo'),
      updatedAt: '2026-11-14T14:00:00Z',
    }),
    DaySchema.parse({
      localDate: '2026-11-15',
      title: { de: 'Laternen in Hội An', en: 'Lanterns in Hội An' },
      summary: {
        de: 'Altstadt, Schneiderei, und abends tausend Laternen am Fluss.',
        en: 'Old town, a tailor shop, and a thousand lanterns on the river at night.',
      },
      origLocale: 'de',
      placeName: 'Hội An',
      countryCode: 'VN',
      lat: 15.8801,
      lng: 108.338,
      coverSourceKey: sk('hoian-photo-morning'),
      updatedAt: '2026-11-15T15:00:00Z',
    }),
    DaySchema.parse({
      localDate: '2026-11-17',
      title: { de: 'Sài Gòn', en: 'Sài Gòn' },
      origLocale: 'de',
      placeName: 'Sài Gòn',
      countryCode: 'VN',
      lat: 10.7769,
      lng: 106.7009,
      coverSourceKey: null,
      updatedAt: '2026-11-17T10:00:00Z',
    }),
  ];

  type PostInput = Post extends unknown ? Omit<Post, 'localDate'> : never;
  const post = (p: PostInput): Post => PostSchema.parse({ ...p, localDate: localDateFor(p.occurredAt, p.tz) });
  const posts: Post[] = [
    post({
      publicId: 'p_n01hanoi26',
      kind: 'note',
      occurredAt: '2026-11-14T13:30:00Z',
      tz: HCM,
      content: {
        de: { body: 'Erste Schale Phở. Ich glaube, ich bleibe für immer.' },
        en: { body: 'First bowl of phở. I think I’m staying forever.' },
      },
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-14T13:31:00Z',
    }),
    post({
      publicId: 'p_n02hoian26',
      kind: 'note',
      occurredAt: '2026-11-16T08:00:00Z',
      tz: HCM,
      content: {
        en: { body: 'Rain all morning, coffee all afternoon. Cà phê trứng is dessert in a cup.' },
        de: { body: 'Vormittags Regen, nachmittags Kaffee. Cà phê trứng ist Nachtisch im Glas.' },
      },
      origLocale: 'en',
      visibility: 'public',
      updatedAt: '2026-11-16T08:05:00Z',
    }),
    post({
      publicId: 'p_s01lantern',
      kind: 'story',
      occurredAt: '2026-11-15T14:00:00Z',
      tz: HCM,
      content: {
        de: {
          title: 'Die Nacht der Laternen',
          body: [
            '## Vollmond über dem Thu Bồn',
            '',
            'Einmal im Monat, bei Vollmond, wird in der Altstadt von **Hội An** der Strom abgedreht.',
            'Dann leuchten nur noch Laternen – aus Seide, aus Papier, in allen Farben.',
            '',
            '- eine Kerze im Papierschiffchen kostet 10.000 Đồng',
            '- man wünscht sich *leise* etwas',
            '- und lässt sie den Fluss hinuntertreiben',
            '',
            '> „Đi một ngày đàng, học một sàng khôn.“ – Wer einen Tag reist, lernt einen Korb voll Weisheit.',
            '',
            'Mehr dazu: [Hội An auf Wikipedia](https://de.wikipedia.org/wiki/H%E1%BB%99i_An).',
          ].join('\n'),
        },
        en: {
          title: 'The night of the lanterns',
          body: [
            '## Full moon over the Thu Bồn',
            '',
            'Once a month, at full moon, the old town of **Hội An** switches off the street lights.',
            'Only lanterns glow then – silk, paper, every colour.',
            '',
            '- a candle in a paper boat costs 10,000 đồng',
            '- you make a *quiet* wish',
            '- and let it drift down the river',
            '',
            '> “Đi một ngày đàng, học một sàng khôn.” – Travel one day, gain a basket of wisdom.',
            '',
            'More: [Hội An on Wikipedia](https://en.wikipedia.org/wiki/H%E1%BB%99i_An).',
          ].join('\n'),
        },
      },
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-15T15:30:00Z',
    }),
  ];

  const annotations: Annotation[] = [
    AnnotationSchema.parse({
      sourceKey: sk('hoian-photo-morning'),
      description: {
        de: 'Gelbe Häuser, Bougainvillea und der erste Kaffee des Tages.',
        en: 'Yellow houses, bougainvillea and the first coffee of the day.',
      },
      origLocale: 'de',
      visibility: null,
      localDateOverride: null,
      updatedAt: '2026-11-15T03:00:00Z',
    }),
    AnnotationSchema.parse({
      sourceKey: sk('hoian-photo-night'),
      description: { de: 'Gehört noch zum Laternenabend.', en: 'Still part of the lantern night.' },
      origLocale: 'de',
      visibility: null,
      localDateOverride: '2026-11-15',
      updatedAt: '2026-11-16T02:00:00Z',
    }),
    AnnotationSchema.parse({
      sourceKey: sk('hoian-text-en'),
      visibility: 'hidden',
      localDateOverride: null,
      updatedAt: '2026-11-16T15:10:00Z',
    }),
  ];

  // Same content as a change-feed page (settings first, then trips, days, posts, annotations).
  const items: unknown[] = [];
  let seq = 0;
  for (const [key, value] of Object.entries(settings)) {
    items.push({ seq: ++seq, entity: 'setting', key, op: 'upsert', data: { value } });
  }
  for (const t of trips) items.push({ seq: ++seq, entity: 'trip', key: t.slug, op: 'upsert', data: t });
  for (const d of days) items.push({ seq: ++seq, entity: 'day', key: d.localDate, op: 'upsert', data: d });
  for (const p of posts) items.push({ seq: ++seq, entity: 'post', key: p.publicId, op: 'upsert', data: p });
  for (const a of annotations)
    items.push({ seq: ++seq, entity: 'annotation', key: a.sourceKey, op: 'upsert', data: a });
  const changes = ChangesResponse.parse({ feedId: FEED_ID, items, nextSeq: seq, hasMore: false });

  return { contractVersion: 1, settings, trips, days, posts, annotations, changes };
}

// ---------------------------------------------------------------------------------------------
// cross-runtime vectors (committed; PHP re-implements ids/time/policy and must match)

async function writeVectors(entries: IndexEntry[]): Promise<void> {
  mkdirSync(VECTORS, { recursive: true });
  const keys = ['wa:ABC123', 'wa:3EB0C767D26A1D8B7A3B', ...entries.map((e) => e.sourceKey)];
  const ids = [];
  for (const sourceKey of keys) ids.push({ sourceKey, publicId: await publicIdForSourceKey(sourceKey) });
  writeFileSync(
    join(VECTORS, 'ids.json'),
    json({ description: 'publicId = "e_" + base32_rfc4648_lower(sha256(utf8(sourceKey)))[0..12] (D4)', cases: ids }),
  );

  const instants: [string, string][] = [
    ['2026-11-15T16:59:59Z', HCM],
    ['2026-11-15T17:00:00Z', HCM],
    ['2026-11-15T18:30:00Z', HCM],
    ['2026-11-11T23:30:00Z', BERLIN],
    ['2026-03-29T00:59:00Z', BERLIN],
    ['2026-03-29T01:00:00Z', BERLIN],
    ['2026-03-29T22:00:00Z', BERLIN],
    ['2026-10-25T00:30:00Z', BERLIN],
    ['2026-10-25T01:30:00Z', BERLIN],
    ['2026-10-25T23:00:00Z', BERLIN],
    ['2026-03-08T04:59:00Z', 'America/New_York'],
    ['2026-03-08T07:00:00Z', 'America/New_York'],
    ['2026-11-02T03:59:00Z', 'America/New_York'],
    ['2026-11-18T09:59:00Z', 'Pacific/Kiritimati'],
    ['2026-11-18T10:00:00Z', 'Pacific/Kiritimati'],
    ['2026-11-18T10:00:00Z', 'Pacific/Pago_Pago'],
    ['2026-11-18T11:00:00Z', 'Pacific/Pago_Pago'],
    ['2026-11-18T18:15:00Z', 'Asia/Kathmandu'],
    ['2026-01-15T00:00:00Z', 'Australia/Lord_Howe'],
    ['2026-07-15T00:00:00Z', 'Australia/Lord_Howe'],
    ['2026-01-01T00:00:00Z', 'UTC'],
  ];
  writeFileSync(
    join(VECTORS, 'time.json'),
    json({
      description: 'localDate/localTime of an ISO UTC instant in an IANA zone (D6)',
      cases: instants.map(([isoUtc, tz]) => ({
        isoUtc,
        tz,
        localDate: localDateFor(isoUtc, tz),
        localTime: localTimeFor(isoUtc, tz),
      })),
    }),
  );

  const occurredAt = '2026-11-18T02:00:00Z';
  const cases = [];
  for (const mode of ['instant', 'delayed', 'review'] as const) {
    // mode_since: default (applies to all), exactly occurredAt (applies), 1 s later (capture is older)
    for (const modeSince of [MODE_SINCE_EPOCH, occurredAt, '2026-11-18T02:00:01Z']) {
      for (const onRevoke of ['hide', 'keep'] as const) {
        for (const revokedAt of [null, '2026-11-18T03:00:00Z']) {
          for (const override of [null, 'public', 'hidden', 'pending'] as const) {
            for (const now of ['2026-11-18T13:59:59Z', '2026-11-18T14:00:00Z']) {
              const settings: PolicySettings = {
                'publish.mode': mode,
                'publish.mode_since': modeSince,
                'publish.delay_minutes': 720,
                'ingest.on_revoke': onRevoke,
              };
              const capture = { occurredAt, revokedAt };
              const annotation = { visibility: override };
              cases.push({
                settings,
                capture,
                annotation,
                now,
                expected: effectiveCaptureVisibility(capture, annotation, settings, now),
              });
            }
          }
        }
      }
    }
  }
  writeFileSync(
    join(VECTORS, 'policy.json'),
    json({
      description:
        'effectiveCaptureVisibility(capture, annotation, settings, now) (D11); captures older than ' +
        'publish.mode_since are evaluated as "instant"',
      cases,
    }),
  );

  // Mode switches: publish.mode_since after a settings change (nextModeSince, PHP
  // Policy::nextModeSince) and what it does to the captures waiting at that moment, judged at the
  // switch. Covers every mode pair, delay changes and earlier cut-offs; in particular review ->
  // delayed, which releases exactly the waiting statuses older than the NEW delay.
  const switchAt = '2026-11-20T10:00:00.000Z';
  const switchCaptures = [
    { label: 'before the earlier cut-off', occurredAt: '2026-11-17T09:59:59.999Z' },
    { label: 't-24h', occurredAt: '2026-11-19T10:00:00.000Z' },
    { label: 't-12h', occurredAt: '2026-11-19T22:00:00.000Z' },
    { label: 't-12h+1ms', occurredAt: '2026-11-19T22:00:00.001Z' },
    { label: 't-6h', occurredAt: '2026-11-20T04:00:00.000Z' },
    { label: 't-6h+1ms', occurredAt: '2026-11-20T04:00:00.001Z' },
    { label: 'before the recent cut-off', occurredAt: '2026-11-20T05:59:59.999Z' },
    { label: 't-2h', occurredAt: '2026-11-20T08:00:00.000Z' },
    { label: 't', occurredAt: switchAt },
  ];
  const switches = [];
  for (const from of ['instant', 'delayed', 'review'] as const) {
    for (const to of ['instant', 'delayed', 'review'] as const) {
      for (const modeSince of [MODE_SINCE_EPOCH, '2026-11-17T10:00:00.000Z', '2026-11-20T06:00:00.000Z']) {
        for (const d0 of [360, 720]) {
          for (const d1 of [0, 360, 720]) {
            const before: PolicySettings = {
              'publish.mode': from,
              'publish.delay_minutes': d0,
              'ingest.on_revoke': 'hide',
              'publish.mode_since': modeSince,
            };
            const after = { 'publish.mode': to, 'publish.delay_minutes': d1 };
            const since = nextModeSince(before, after, switchAt);
            const settingsAfter: PolicySettings = { ...before, ...after, 'publish.mode_since': since };
            const vis = (st: PolicySettings) =>
              switchCaptures.map((c) => effectiveCaptureVisibility({ occurredAt: c.occurredAt }, null, st, switchAt));
            switches.push({
              before,
              after,
              now: switchAt,
              modeSince: since,
              visibilityBefore: vis(before),
              visibilityAfter: vis(settingsAfter),
            });
          }
        }
      }
    }
  }
  writeFileSync(
    join(VECTORS, 'mode-switch.json'),
    json({
      description:
        'nextModeSince(before, after, now) -> modeSince; visibilityBefore/visibilityAfter[i] = ' +
        'effectiveCaptureVisibility(captures[i], no annotation, before | after + modeSince, now). Only ' +
        '-> instant, review -> delayed and a shorter delay while delayed release waiting captures, ' +
        'exactly those at least as old as the new delay; nothing that was public before the switch ' +
        'becomes pending. mode_since is inclusive: a capture at exactly the switch instant ("t") ' +
        'already falls under the new mode.',
      captures: switchCaptures,
      cases: switches,
    }),
  );

  // Placement: localDateOverride > Day.tz fix of the stored local date > stored localDate/tz.
  const placementItems = [
    { occurredAt: '2026-11-15T18:30:00Z', tz: HCM, localDate: '2026-11-16' },
    { occurredAt: '2026-11-15T16:59:59Z', tz: HCM, localDate: '2026-11-15' },
    { occurredAt: '2026-11-18T10:00:00Z', tz: 'Pacific/Kiritimati', localDate: '2026-11-19' },
    { occurredAt: '2026-03-29T00:30:00Z', tz: BERLIN, localDate: '2026-03-29' },
  ];
  const placement = [];
  for (const item of placementItems) {
    for (const annotation of [null, { localDateOverride: null }, { localDateOverride: '2026-11-17' }]) {
      for (const dayTz of [null, BERLIN, 'Pacific/Pago_Pago', 'America/New_York']) {
        placement.push({
          item,
          annotation,
          dayTz,
          localDate: effectiveLocalDate(item, annotation, dayTz),
          tz: effectiveTz(item, annotation, dayTz),
        });
      }
    }
  }
  writeFileSync(
    join(VECTORS, 'placement.json'),
    json({
      description:
        'effectiveLocalDate/effectiveTz(item, annotation, dayTz): override > Day.tz of the stored local date > stored',
      cases: placement,
    }),
  );

  // Trips: inclusive date ranges; overlaps (rejected by the API) resolve to the earliest start, then slug.
  const trips = [
    { slug: 'vietnam-2026', startDate: '2026-11-14', endDate: '2026-11-17' },
    { slug: 'berlin', startDate: '2026-11-01', endDate: '2026-11-12' },
    { slug: 'a-overlap', startDate: '2026-11-16', endDate: '2026-11-20' },
    { slug: 'same-start-b', startDate: '2026-12-01', endDate: '2026-12-02' },
    { slug: 'same-start-a', startDate: '2026-12-01', endDate: '2026-12-03' },
  ];
  const dates = [
    '2026-10-31',
    '2026-11-01',
    '2026-11-12',
    '2026-11-13',
    '2026-11-14',
    '2026-11-16',
    '2026-11-17',
    '2026-11-18',
    '2026-11-21',
    '2026-12-01',
    '2026-12-03',
  ];
  writeFileSync(
    join(VECTORS, 'trips.json'),
    json({
      description: 'tripForDate(date, trips): inclusive ranges; overlaps resolve to the earliest start, then slug',
      trips,
      cases: dates.map((date) => ({ date, trip: tripForDate(date, trips) })),
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// main

function dirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    total += st.isDirectory() ? dirSize(p) : st.size;
  }
  return total;
}

/** Writes via a temp file + rename, so readers never see a half-written file. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

if (process.argv.includes('--owner-only')) {
  const index = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) as { statuses: IndexEntry[] };
  const owner = ownerContent(new Map(index.statuses.map((e) => [e.key, e])));
  writeFileAtomic(join(OUT, 'owner.json'), json(owner));
  await writeVectors(index.statuses);
  console.log(`Rewrote ${relative(ROOT, join(OUT, 'owner.json'))} and ${relative(ROOT, VECTORS)} (media untouched)`);
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(INBOX, { recursive: true });

const entries: IndexEntry[] = [];
for (const spec of STATUSES) entries.push(await writeStatus(spec));
const byKey = new Map(entries.map((e) => [e.key, e]));

const owner = ownerContent(byKey);
writeFileSync(join(OUT, 'owner.json'), json(owner));

// Validate everything we wrote by reading it back.
for (const e of entries) {
  InboxMeta.parse(JSON.parse(readFileSync(join(INBOX, e.msgId, 'meta.json'), 'utf8')));
}
for (const name of readdirSync(join(INBOX, '_revokes'))) {
  RevokeRecord.parse(JSON.parse(readFileSync(join(INBOX, '_revokes', name), 'utf8')));
}

writeFileSync(
  join(OUT, 'index.json'),
  json({
    description:
      'Synthetic fixtures generated by `pnpm fixtures` (fixtures/generate.ts). tz = zone in effect when captured.',
    traveler: TRAVELER,
    statuses: entries,
    days: [...new Set(entries.map((e) => `${e.localDate} ${e.tz}`))].sort(),
  }),
);

await writeVectors(entries);

const total = dirSize(OUT);
if (total > MAX_TOTAL_BYTES) {
  throw new Error(`Fixtures are ${(total / 1048576).toFixed(1)} MB, limit is 10 MB`);
}

const counts = entries.reduce<Record<string, number>>((acc, e) => {
  acc[e.kind] = (acc[e.kind] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `Generated ${entries.length} statuses (${Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ')}), ${Object.keys(REVOKED).length} revoke, owner.json, vectors — ` +
    `${(total / 1024).toFixed(0)} KB in ${relative(ROOT, OUT)}`,
);
