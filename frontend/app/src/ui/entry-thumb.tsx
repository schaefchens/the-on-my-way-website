/**
 * A small picture of an outbox entry: the photo itself, a video tile, a text-status card in its
 * colour and font, or a voice tile. Used in Today's strip (as a polaroid), the queue and drafts.
 */
import { Image, StyleSheet, Text, View } from 'react-native';
import { formatClock } from '../core/entry';
import type { OutboxManifest } from '../core/outbox-machine';
import { colorByArgb, colorById, DEFAULT_TEXT_COLOR_ID } from '../core/text-status';
import { useOutbox } from '../outbox/outbox';
import { useTheme, waFontStyle } from '../theme';
import { Icon } from './icons';

export function thumbUri(m: OutboxManifest, fileUri: (id: string, name: string) => string): string | null {
  if (m.kind !== 'photo') return null;
  const preview = m.files.find((f) => f.role === 'preview');
  if (preview) return fileUri(m.entryId, preview.name);
  return m.source ? fileUri(m.entryId, m.source.name) : null;
}

export function EntryThumb({ m, size, radius = 4 }: { m: OutboxManifest; size: number; radius?: number }) {
  const theme = useTheme();
  const { fileUri } = useOutbox();
  const box = { width: size, height: size, borderRadius: radius };

  if (m.kind === 'photo') {
    const uri = thumbUri(m, fileUri);
    return uri ? (
      <Image source={{ uri, width: size * 2, height: size * 2 }} resizeMethod="resize" style={[box, styles.cover]} />
    ) : (
      <View style={[box, { backgroundColor: theme.colors.blush }]} />
    );
  }
  if (m.kind === 'text') {
    const color = m.text
      ? (colorByArgb(m.text.bgArgb) ?? colorById(DEFAULT_TEXT_COLOR_ID))
      : colorById(DEFAULT_TEXT_COLOR_ID);
    return (
      <View style={[box, styles.center, { backgroundColor: color.hex, padding: size * 0.08 }]}>
        <Text
          numberOfLines={4}
          style={[
            { color: '#ffffff', fontSize: Math.max(9, size * 0.13), textAlign: 'center' },
            m.text ? waFontStyle(m.text.font) : null,
          ]}
          maxFontSizeMultiplier={1}
        >
          {m.text?.body ?? 'Aa'}
        </Text>
      </View>
    );
  }
  if (m.kind === 'voice') {
    const bars = [0.35, 0.6, 0.9, 0.55, 0.75, 0.4, 0.65];
    return (
      <View style={[box, styles.center, { backgroundColor: theme.palette['violet-700'] ?? '#5d3fa0', gap: 6 }]}>
        <Icon name="Mic" size={size * 0.26} color="#ffffff" />
        <View style={styles.bars}>
          {bars.map((h, i) => (
            <View
              key={`b${i}`}
              style={{ width: 3, height: size * 0.22 * h, borderRadius: 2, backgroundColor: '#ffffffcc' }}
            />
          ))}
        </View>
      </View>
    );
  }
  // video
  const seconds = m.edit?.trimEndMs !== undefined ? m.edit.trimEndMs - (m.edit.trimStartMs ?? 0) : m.source?.durationMs;
  return (
    <View style={[box, styles.center, { backgroundColor: '#2a1f33' }]}>
      <Icon name="Play" size={size * 0.28} color="#ffffff" />
      {seconds ? (
        <Text style={[styles.duration, { fontSize: Math.max(10, size * 0.11) }]} maxFontSizeMultiplier={1.2}>
          {formatClock(seconds)}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { resizeMode: 'cover' },
  center: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  bars: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  duration: { position: 'absolute', bottom: 6, right: 8, color: '#ffffff', fontFamily: 'Nunito', fontWeight: '700' },
});
