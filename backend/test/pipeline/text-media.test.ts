/** Text-status styling and the site-media read helpers used by the generator. */
import { AudioMedia, ImageSet, TextStyle, VideoMedia } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import {
  audioMediaFromCapture,
  DEFAULT_TEXT_STYLE,
  imageSetFromCapture,
  previewVariant,
  textStyleFromInbox,
  videoMediaFromCapture,
} from '../../src/pipeline/index.js';
import type { CaptureRow, ProcessedVariant } from '../../src/store/index.js';

describe('textStyleFromInbox', () => {
  it('maps ARGB colours and the font enum', () => {
    const style = textStyleFromInbox({
      body: 'Xin chào',
      bgArgb: 4290879551, // 0xFFC1A03F
      textArgb: 4294967295,
      font: 'SYSTEM_BOLD',
    });
    expect(style).toEqual({ body: 'Xin chào', bg: '#c1a03fff', fg: '#ffffffff', font: 'SYSTEM_BOLD' });
    expect(TextStyle.parse(style)).toEqual(style);
  });

  it('falls back to the default style for plain Conversation statuses', () => {
    expect(textStyleFromInbox({ body: 'plain', bgArgb: null, textArgb: null, font: null })).toEqual({
      body: 'plain',
      ...DEFAULT_TEXT_STYLE,
    });
  });
});

const SHA = 'ab12cd34ef56ab78901234567890abcdef1234567890abcdef1234567890abcd';
const v = (
  role: ProcessedVariant['role'],
  variant: string,
  format: ProcessedVariant['format'],
  w?: number,
  h?: number,
): ProcessedVariant => ({
  role,
  variant,
  format,
  ...(w ? { w } : {}),
  ...(h ? { h } : {}),
  relPath: `media/ab/${SHA.slice(0, 16)}_${variant}.${format}`,
  bytes: 100,
  sha256: SHA,
});

function row(kind: CaptureRow['kind'], variants: ProcessedVariant[], meta: CaptureRow['processedMeta']): CaptureRow {
  return {
    sourceKey: 'wa:ABC',
    publicId: 'e_aaaaaaaaaaaa',
    msgId: 'ABC',
    source: 'fixture',
    kind,
    occurredAt: '2026-11-15T02:12:00.000Z',
    receivedAt: null,
    tz: 'Asia/Ho_Chi_Minh',
    localDate: '2026-11-15',
    caption: null,
    text: null,
    media: null,
    sender: null,
    state: 'ready',
    downloadState: 'ok',
    downloadReason: null,
    downloadPermanent: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    archivePath: null,
    originalSha256: SHA,
    variants,
    processedMeta: meta,
    revokedAt: null,
    createdAt: '2026-11-15T02:12:00.000Z',
    updatedAt: '2026-11-15T02:12:00.000Z',
  };
}

describe('site media helpers', () => {
  const look = { color: '#112233', thumbhash: 'AAAA' };

  it('builds an ImageSet sorted by width with the OG image', () => {
    const r = row(
      'photo',
      [
        v('image', 'w640', 'webp', 640, 480),
        v('image', 'w320', 'webp', 320, 240),
        v('image', 'w320', 'avif', 320, 240),
        v('image', 'w640', 'avif', 640, 480),
        v('og', 'og', 'jpg', 1200, 630),
      ],
      { w: 640, h: 480, ...look },
    );
    const set = imageSetFromCapture(r, 'image');
    expect(ImageSet.parse(set)).toEqual(set);
    expect(set?.sources.webp.map((s) => s.w)).toEqual([320, 640]);
    expect(set?.og).toBe(`media/ab/${SHA.slice(0, 16)}_og.jpg`);
    expect(previewVariant(r)?.variant).toBe('w640');
    expect(imageSetFromCapture(row('photo', [], { w: 1, h: 1, ...look }), 'image')).toBeNull();
    expect(imageSetFromCapture(row('photo', r.variants ?? [], { w: 640, h: 480 }), 'image')).toBeNull();
  });

  it('builds VideoMedia (GIFs never have audio) and AudioMedia', () => {
    const variants = [
      v('video', 'video', 'mp4', 480, 480),
      v('poster', 'poster_w320', 'avif', 320, 320),
      v('poster', 'poster_w320', 'webp', 320, 320),
      v('poster', 'poster_w640', 'webp', 480, 480),
    ];
    const meta = { w: 480, h: 480, duration: 2, hasAudio: true, ...look };
    const video = videoMediaFromCapture(row('video', variants, meta));
    expect(VideoMedia.parse(video)).toEqual(video);
    expect(video?.hasAudio).toBe(true);
    expect(videoMediaFromCapture(row('gif', variants, meta))?.hasAudio).toBe(false);
    expect(previewVariant(row('gif', variants, meta))?.variant).toBe('poster_w640');
    expect(videoMediaFromCapture(row('video', variants.slice(1), meta))).toBeNull();

    const audio = audioMediaFromCapture(
      row('voice', [v('audio', 'voice', 'm4a')], { duration: 3, peaks: [0, 0.5, 1] }),
    );
    expect(AudioMedia.parse(audio)).toEqual(audio);
    expect(audioMediaFromCapture(row('voice', [], { duration: 3 }))).toBeNull();
    expect(previewVariant(row('voice', [], {}))).toBeNull();
  });
});
