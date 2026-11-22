/**
 * The system Photo Picker (expo-image-picker, no media permission): photos and videos, up to 30,
 * the selection order is the posting order. Every pick is copied into the outbox as a durable
 * draft before the editor opens. The picker removes GPS from the copies; the EXIF day stays
 * private and only drives "Put it on that day?".
 */
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';
import { exifLocalDate } from '../core/entry';
import { useOutbox } from './outbox';

export function pickedMimetype(asset: Pick<ImagePicker.ImagePickerAsset, 'mimeType' | 'uri' | 'type'>): string {
  if (asset.mimeType) return asset.mimeType;
  const ext = asset.uri.split('.').pop()?.toLowerCase();
  if (asset.type === 'video') return ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  if (ext === 'png') return 'image/png';
  if (ext === 'heic' || ext === 'heif') return `image/${ext}`;
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** Returns the draft ids in posting order, [] when she cancelled. */
export function useGalleryPick() {
  const outbox = useOutbox();
  const [busy, setBusy] = useState(false);

  const pick = useCallback(async (): Promise<string[]> => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 30,
      orderedSelection: true,
      exif: true,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return [];
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const asset of result.assets) {
        const exif = asset.exif as Record<string, unknown> | null | undefined;
        ids.push(
          await outbox.createDraft({
            kind: asset.type === 'video' ? 'video' : 'photo',
            origin: 'gallery',
            uri: asset.uri,
            how: 'copy',
            mimetype: pickedMimetype(asset),
            width: asset.width,
            height: asset.height,
            ...(asset.type === 'video' && asset.duration ? { durationMs: asset.duration } : {}),
            takenOn: asset.type === 'video' ? null : exifLocalDate(exif?.DateTimeOriginal ?? exif?.DateTime),
          }),
        );
      }
      return ids;
    } finally {
      setBusy(false);
    }
  }, [outbox]);

  return { pick, busy };
}
