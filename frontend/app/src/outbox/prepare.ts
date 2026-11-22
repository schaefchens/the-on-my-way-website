/**
 * "Preparing…": turns a shared draft into the files its AppEntry declares (app-plan §2.1, §3.1):
 * - photo: the published JPEG (≤ 2880 × 1600, no metadata, q90) from MediaExport.exportPhoto; while
 *   the native step is missing, expo-image-manipulator re-encodes it (a decoded bitmap written as a
 *   JPEG carries no EXIF at all). Plus the 640w preview and the untouched original (Q2 c).
 * - video: MediaExport.exportVideo (trim, mute, ≤ 1080p, ≤ 30 fps, metadata filtered) plus the
 *   original. Without the native step the entry stays "Preparing…" and is tried again later.
 * - voice: the recording itself (AAC in M4A) is the artifact.
 * - text: nothing to bake.
 * Every file gets its sha256 (streamed natively by expo-file-system) for AppFile.
 */
import { APP_LIMITS, APP_ORIGINAL_MIMETYPES, type AppEntry, type AppMedia } from '@omw/contracts/app';
import Constants from 'expo-constants';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';
import { MediaExport } from '../../modules/omw-native';
import { buildAppEntry, fitPhoto } from '../core/entry';
import { NOT_IMPLEMENTED, type OutboxError, type OutboxFile, type OutboxManifest } from '../core/outbox-machine';
import { trimForExport } from '../core/trim';
import { entryFile, fileFacts, freeBytes } from './fs-store';

export type PrepareResult =
  | { ok: true; files: OutboxFile[]; media?: AppMedia; entry: AppEntry }
  | { ok: false; error: OutboxError };

const MEDIA_NAME = { photo: 'media.jpg', video: 'media.mp4', voice: 'media.m4a' } as const;
const PREVIEW_NAME = 'preview.jpg';
/** Head room the phone keeps free while exporting. */
const MIN_FREE_BYTES = 200 * 1000 * 1000;

function clientInfo() {
  return {
    app: String(Constants.expoConfig?.extra?.versionName ?? Constants.expoConfig?.version ?? 'dev'),
    os: String(Platform.Version),
  };
}

function codeOf(e: unknown): string {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : 'ERR_UNEXPECTED';
}

function fail(code: string, message: string, permanent = false): PrepareResult {
  return { ok: false, error: { code, message, permanent } };
}

/** The untouched source as the archive original, when the contract accepts its type. */
async function originalFile(m: OutboxManifest): Promise<OutboxFile | null> {
  const src = m.source;
  if (!src || (m.kind !== 'photo' && m.kind !== 'video')) return null;
  const allowed: readonly string[] = APP_ORIGINAL_MIMETYPES[m.kind];
  if (!allowed.includes(src.mimetype)) return null;
  const facts = await fileFacts(m.entryId, src.name);
  if (facts.bytes <= 0 || facts.bytes > APP_LIMITS.originalMaxBytes) return null;
  return { role: 'original', name: src.name, mimetype: src.mimetype, ...facts };
}

async function savedJpeg(
  m: OutboxManifest,
  name: string,
  ref: {
    saveAsync(o: { format: SaveFormat; compress: number }): Promise<{ uri: string; width: number; height: number }>;
  },
  compress: number,
): Promise<{ width: number; height: number }> {
  const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress });
  await new File(saved.uri).move(entryFile(m.entryId, name), { overwrite: true });
  return { width: saved.width, height: saved.height };
}

/** The JS fallback for the photo export and, always, the 640w preview. */
async function photoWithManipulator(m: OutboxManifest, withMedia: boolean) {
  const source = entryFile(m.entryId, m.source?.name ?? '');
  const decoded = await ImageManipulator.manipulate(source.uri, {
    maxWidth: APP_LIMITS.photoMaxLongSide,
    maxHeight: APP_LIMITS.photoMaxLongSide,
  }).renderAsync();
  let size: { width: number; height: number } | null = null;
  if (withMedia) {
    const fit = fitPhoto(decoded.width, decoded.height);
    const ctx = ImageManipulator.manipulate(decoded);
    if (fit.width < decoded.width) ctx.resize({ width: fit.width, height: fit.height });
    size = await savedJpeg(m, MEDIA_NAME.photo, await ctx.renderAsync(), 0.9);
  }
  const previewWidth = Math.min(APP_LIMITS.previewWidth, decoded.width);
  const preview = await ImageManipulator.manipulate(decoded).resize({ width: previewWidth }).renderAsync();
  await savedJpeg(m, PREVIEW_NAME, preview, 0.8);
  let facts = await fileFacts(m.entryId, PREVIEW_NAME);
  if (facts.bytes > APP_LIMITS.previewMaxBytes) {
    await savedJpeg(m, PREVIEW_NAME, preview, 0.55);
    facts = await fileFacts(m.entryId, PREVIEW_NAME);
  }
  const previewFile: OutboxFile | null =
    facts.bytes <= APP_LIMITS.previewMaxBytes
      ? { role: 'preview', name: PREVIEW_NAME, mimetype: 'image/jpeg', ...facts }
      : null;
  return { size, previewFile };
}

async function preparePhoto(m: OutboxManifest): Promise<PrepareResult> {
  let size: { width: number; height: number } | null = null;
  let native = true;
  try {
    const r = await MediaExport.exportPhoto({
      jobId: `${m.entryId}-photo`,
      sourceUri: entryFile(m.entryId, m.source?.name ?? '').uri,
      outputUri: entryFile(m.entryId, MEDIA_NAME.photo).uri,
      maxLongSide: APP_LIMITS.photoMaxLongSide,
      maxShortSide: APP_LIMITS.photoMaxShortSide,
      quality: 0.9,
    });
    size = { width: r.width, height: r.height };
  } catch (e) {
    const code = codeOf(e);
    if (code !== NOT_IMPLEMENTED && code !== 'ERR_NATIVE_UNAVAILABLE') throw e;
    native = false;
  }
  const fallback = await photoWithManipulator(m, !native);
  size ??= fallback.size;
  if (!size) return fail('export_failed', 'No photo size');
  const media = await fileFacts(m.entryId, MEDIA_NAME.photo);
  const files: OutboxFile[] = [{ role: 'media', name: MEDIA_NAME.photo, mimetype: 'image/jpeg', ...media }];
  if (fallback.previewFile) files.push(fallback.previewFile);
  const original = await originalFile(m);
  if (original) files.push(original);
  return finish(m, files, { width: size.width, height: size.height });
}

async function prepareVideo(m: OutboxManifest): Promise<PrepareResult> {
  const src = m.source;
  if (!src) return fail('no_source', 'The video file is missing', true);
  const duration = src.durationMs ?? 0;
  const window = { startMs: m.edit?.trimStartMs ?? 0, endMs: m.edit?.trimEndMs ?? duration };
  let result: Awaited<ReturnType<typeof MediaExport.exportVideo>>;
  try {
    result = await MediaExport.exportVideo({
      jobId: `${m.entryId}-video`,
      sourceUri: entryFile(m.entryId, src.name).uri,
      outputUri: entryFile(m.entryId, MEDIA_NAME.video).uri,
      ...trimForExport(window, duration),
      ...(m.edit?.mute ? { mute: true } : {}),
      maxLongSide: APP_LIMITS.videoMaxLongSide,
      maxFps: 30,
    });
  } catch (e) {
    const code = codeOf(e);
    if (code === NOT_IMPLEMENTED || code === 'ERR_NATIVE_UNAVAILABLE') {
      return fail(NOT_IMPLEMENTED, 'The video step comes with an app update');
    }
    throw e;
  }
  const files: OutboxFile[] = [
    { role: 'media', name: MEDIA_NAME.video, mimetype: 'video/mp4', bytes: result.bytes, sha256Hex: result.sha256Hex },
  ];
  const original = await originalFile(m);
  if (original) files.push(original);
  const seconds = Math.round(((result.durationMs ?? window.endMs - window.startMs) / 1000) * 10) / 10;
  return finish(m, files, {
    width: result.width,
    height: result.height,
    seconds: Math.min(seconds, APP_LIMITS.videoSeconds),
  });
}

async function prepareVoice(m: OutboxManifest): Promise<PrepareResult> {
  const src = m.source;
  if (!src) return fail('no_source', 'The recording is missing', true);
  const facts = await fileFacts(m.entryId, src.name);
  const seconds = Math.min(APP_LIMITS.voiceSeconds, Math.round(((src.durationMs ?? 0) / 1000) * 10) / 10);
  return finish(m, [{ role: 'media', name: src.name, mimetype: 'audio/mp4', ...facts }], { seconds, ptt: true });
}

function finish(m: OutboxManifest, files: OutboxFile[], media?: AppMedia): PrepareResult {
  const built = buildAppEntry(m, { files, ...(media ? { media } : {}) }, clientInfo());
  if (!built.ok) {
    return fail('invalid_entry', built.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; '), true);
  }
  return { ok: true, files, ...(media ? { media } : {}), entry: built.entry };
}

/** Runs the kind's pipeline. Never throws: errors come back as transient or permanent. */
export async function prepareEntry(m: OutboxManifest): Promise<PrepareResult> {
  try {
    if (m.kind !== 'text' && freeBytes() < MIN_FREE_BYTES + (m.source?.bytes ?? 0)) {
      return fail('low_storage', 'The phone is almost full');
    }
    switch (m.kind) {
      case 'photo':
        return await preparePhoto(m);
      case 'video':
        return await prepareVideo(m);
      case 'voice':
        return await prepareVoice(m);
      case 'text':
        return finish(m, []);
    }
  } catch (e) {
    return fail(codeOf(e), e instanceof Error ? e.message : String(e));
  }
}

export const MEDIA_FILE_NAMES = MEDIA_NAME;
