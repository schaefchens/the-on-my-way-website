/**
 * The text-status maker (ux.md §3.6): exactly WhatsApp's text status, {body, bgArgb, textArgb,
 * font}. 12 backgrounds (swipe sideways, or ◐ for the named palette), 8 fonts (Aa = next, hold Aa
 * = all of them), the site's size scale (what she sees is what the site's TextSlide shows), white
 * text, ≤ 700 characters (the counter shows from 600). Background changes crossfade (240 ms).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { APP_LIMITS } from '@omw/contracts/app';
import type { FontName } from '@omw/contracts/wa';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { type ComponentRef, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  colorById,
  EMPTY_TEXT_DRAFT,
  fromAppText,
  isSystemFont,
  nextFont,
  stepColor,
  TEXT_STATUS_COLORS,
  TEXT_STATUS_FONTS,
  type TextStatusDraft,
  textRemaining,
  textStatusMetrics,
  textStatusProblem,
  toAppText,
} from '../core/text-status';
import { useOutbox } from '../outbox/outbox';
import { useShare } from '../outbox/use-share';
import { waFontStyle } from '../theme';
import { RoundButton } from '../ui/button';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';
import { CROSSFADE, REDUCED_FADE, SPRINGS } from '../ui/motion';
import { Press } from '../ui/press';
import { AS_USUAL, type PublishChoice, PublishSheet, usePublishLine } from '../ui/publish-sheet';
import { Sheet } from '../ui/sheet';
import { useColorNames, useFontNames } from '../ui/text-names';
import { useToast } from '../ui/toast';

export default function TextMaker() {
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const outbox = useOutbox();
  const toast = useToast();
  const reduced = useReducedMotion();
  const { share, sharing } = useShare();
  const params = useLocalSearchParams<{ id?: string }>();
  const existing = params.id ? outbox.get(params.id) : undefined;
  const [draft, setDraft] = useState<TextStatusDraft>(() =>
    existing?.text ? fromAppText(existing.text) : { ...EMPTY_TEXT_DRAFT },
  );
  const [prevColor, setPrevColor] = useState(draft.colorId);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fontsOpen, setFontsOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [choice, setChoice] = useState<PublishChoice>(AS_USUAL);
  const publishLine = usePublishLine(choice);
  const colorNames = useColorNames();
  const fontNames = useFontNames();
  const left = useRef(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);

  // A new text status opens with the keyboard (autoFocus alone loses the race with the screen's
  // fade on Android).
  useEffect(() => {
    if (existing) return;
    const timer = setTimeout(() => input.current?.focus(), 320);
    return () => clearTimeout(timer);
  }, []);

  // Background crossfade (240 ms; 120 ms with reduced motion).
  const fade = useSharedValue(1);
  const setColor = (colorId: string) => {
    if (colorId === draft.colorId) return;
    feedback.step();
    setPrevColor(draft.colorId);
    setDraft((d) => ({ ...d, colorId }));
    fade.value = 0;
    fade.value = withTiming(1, reduced ? REDUCED_FADE : CROSSFADE);
  };
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  // Font change: the text settles in from 4 dp below.
  const rise = useSharedValue(0);
  const setFont = (font: FontName) => {
    if (font === draft.font) return;
    feedback.step();
    setDraft((d) => ({ ...d, font }));
    if (!reduced) {
      rise.value = 4;
      rise.value = withSpring(0, SPRINGS.snappy);
    }
  };
  const riseStyle = useAnimatedStyle(() => ({ transform: [{ translateY: rise.value }] }));

  const swipe = usePanGesture({
    activeOffsetX: [-30, 30],
    failOffsetY: [-24, 24],
    runOnJS: true,
    onDeactivate: (e) => {
      if (Math.abs(e.translationX) > 60 || Math.abs(e.velocityX) > 600) {
        setColor(stepColor(draft.colorId, e.translationX < 0 ? 1 : -1).id);
      }
    },
  });

  const problem = textStatusProblem(draft);
  const remaining = textRemaining(draft.body);
  const metrics = textStatusMetrics(draft.body || 'Aa', width);
  const color = colorById(draft.colorId);
  const colorIndex = TEXT_STATUS_COLORS.findIndex((c) => c.id === draft.colorId);

  const saveDraft = async (): Promise<string | null> => {
    if (problem === 'empty') return null;
    const text = toAppText({ ...draft, body: draft.body.slice(0, APP_LIMITS.textChars) });
    if (existing) {
      await outbox.edit(existing.entryId, { text });
      return existing.entryId;
    }
    return outbox.createDraft({ kind: 'text', text });
  };

  const back = async () => {
    if (left.current) return;
    left.current = true;
    const id = await saveDraft().catch(() => null);
    if (id) toast.show({ message: t`Saved as a draft`, icon: 'Pencil', durationMs: 3000 });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheetOpen || paletteOpen) return false;
      void back();
      return true;
    });
    return () => sub.remove();
  });

  const onShare = async () => {
    setSheetOpen(false);
    if (problem) {
      feedback.reject();
      return;
    }
    left.current = true;
    const id = await saveDraft();
    if (!id || !(await share([id], choice))) left.current = false;
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colorById(prevColor).hex }]}
      behavior="padding"
      testID="text-screen"
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.hex }, fadeStyle]} />
      <GestureDetector gesture={swipe}>
        <View style={styles.flex} collapsable={false}>
          <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
            <RoundButton
              tone="glass"
              icon="Close"
              label={t`Close, keep as a draft`}
              onPress={() => void back()}
              testID="text-close"
            />
            <Text style={styles.colorName} accessibilityLiveRegion="polite">
              {colorNames[color.id]}
            </Text>
          </View>

          <View style={[styles.center, { paddingHorizontal: metrics.paddingHorizontal }]}>
            <Animated.View style={[styles.inputWrap, riseStyle]}>
              <TextInput
                ref={input}
                value={draft.body}
                onChangeText={(body) => setDraft((d) => ({ ...d, body }))}
                placeholder={t`Type something…`}
                placeholderTextColor="rgba(255,255,255,0.6)"
                multiline
                maxLength={APP_LIMITS.textChars}
                textAlign="center"
                style={[
                  styles.input,
                  waFontStyle(draft.font),
                  { fontSize: metrics.fontSize, lineHeight: metrics.lineHeight },
                ]}
                allowFontScaling={false}
                accessibilityLabel={t`Your text`}
                accessibilityHint={t`Swipe sideways for another background colour`}
                testID="text-input"
              />
            </Animated.View>
          </View>
        </View>
      </GestureDetector>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {fontsOpen ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.fontRow}
            accessibilityRole="radiogroup"
          >
            {TEXT_STATUS_FONTS.map((f) => (
              <Press
                key={f}
                onPress={() => setFont(f)}
                style={[styles.fontChip, draft.font === f && styles.fontChipOn]}
                accessibilityRole="radio"
                accessibilityState={{ selected: draft.font === f }}
                accessibilityLabel={fontNames[f]}
                testID={`font-${f}`}
              >
                <Text
                  style={[styles.fontChipText, waFontStyle(f), draft.font === f && styles.fontChipTextOn]}
                  allowFontScaling={false}
                >
                  {fontNames[f]}
                </Text>
              </Press>
            ))}
          </ScrollView>
        ) : null}
        {fontsOpen && isSystemFont(draft.font) ? (
          <Text style={styles.fontNote}>
            <Trans>Looks like each phone’s own font.</Trans>
          </Text>
        ) : null}

        <View
          style={styles.dots}
          accessible
          accessibilityLabel={t`Colour ${colorIndex + 1} of ${TEXT_STATUS_COLORS.length}`}
        >
          {TEXT_STATUS_COLORS.map((c) => (
            <View key={c.id} style={[styles.dot, c.id === draft.colorId && styles.dotOn]} />
          ))}
        </View>
        {remaining !== null ? (
          <Text style={styles.counter} accessibilityLiveRegion="polite">
            {t`${remaining} left`}
          </Text>
        ) : null}

        <View style={styles.tools}>
          <RoundButton
            tone="glass"
            icon="Palette"
            label={t`Colours`}
            onPress={() => setPaletteOpen(true)}
            testID="text-palette"
          />
          <Press
            onPress={() => setFont(nextFont(draft.font))}
            onLongPress={() => {
              feedback.step();
              setFontsOpen((o) => !o);
            }}
            style={styles.aa}
            accessibilityRole="button"
            accessibilityLabel={t`Next font: ${fontNames[nextFont(draft.font)]}`}
            accessibilityHint={t`Hold for all fonts`}
            accessibilityActions={[{ name: 'longpress', label: t`Choose font` }]}
            onAccessibilityAction={() => setFontsOpen((o) => !o)}
            testID="text-font"
          >
            <Text style={[styles.aaText, waFontStyle(draft.font)]} allowFontScaling={false}>
              Aa
            </Text>
          </Press>
          <Press
            style={styles.publishLine}
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            testID="publish-line"
          >
            <Text style={styles.publishText} numberOfLines={2}>
              {publishLine}
            </Text>
          </Press>
          <Press
            style={[styles.send, (problem !== null || sharing) && { opacity: 0.5 }]}
            disabled={problem !== null || sharing}
            onPress={() => void onShare()}
            accessibilityRole="button"
            accessibilityLabel={t`Share`}
            testID="send-button"
          >
            <Icon name="Send" size={26} color={color.hex} />
          </Press>
        </View>
      </View>

      <Sheet
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        title={t`Colour and font`}
        dark
        testID="palette-sheet"
      >
        <View style={styles.palette} accessibilityRole="radiogroup">
          {TEXT_STATUS_COLORS.map((c) => (
            <Press
              key={c.id}
              onPress={() => setColor(c.id)}
              style={styles.swatchCell}
              accessibilityRole="radio"
              accessibilityState={{ selected: draft.colorId === c.id }}
              accessibilityLabel={colorNames[c.id]}
              testID={`swatch-${c.id}`}
            >
              <View style={[styles.swatch, { backgroundColor: c.hex }, draft.colorId === c.id && styles.swatchOn]}>
                {draft.colorId === c.id ? <Icon name="Check" size={20} color="#ffffff" /> : null}
              </View>
              <Text style={styles.swatchName} numberOfLines={1}>
                {colorNames[c.id]}
              </Text>
            </Press>
          ))}
        </View>
        {/* The visible way to every font (holding Aa is the shortcut). */}
        <View style={styles.sheetFonts} accessibilityRole="radiogroup">
          {TEXT_STATUS_FONTS.map((f) => (
            <Press
              key={f}
              onPress={() => setFont(f)}
              style={[styles.fontChip, draft.font === f && styles.fontChipOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: draft.font === f }}
              accessibilityLabel={fontNames[f]}
              testID={`sheet-font-${f}`}
            >
              <Text
                style={[styles.fontChipText, waFontStyle(f), draft.font === f && styles.fontChipTextOn]}
                allowFontScaling={false}
              >
                {fontNames[f]}
              </Text>
            </Press>
          ))}
        </View>
        {isSystemFont(draft.font) ? (
          <Text style={styles.fontNote}>
            <Trans>Looks like each phone’s own font.</Trans>
          </Text>
        ) : null}
      </Sheet>

      <PublishSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        count={1}
        choice={choice}
        onChange={setChoice}
        onShare={() => void onShare()}
        daySuggestions={[]}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  colorName: { color: 'rgba(255,255,255,0.8)', fontFamily: 'Nunito', fontWeight: '700', fontSize: 14 },
  center: { flex: 1, justifyContent: 'center' },
  inputWrap: { width: '100%' },
  input: { color: '#ffffff', textAlign: 'center', writingDirection: 'auto', padding: 0 },
  bottom: { paddingHorizontal: 16, gap: 10 },
  fontRow: { gap: 8, paddingVertical: 2 },
  fontChip: {
    paddingHorizontal: 14,
    minHeight: 40,
    borderRadius: 20,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  fontChipOn: { backgroundColor: '#ffffff' },
  fontChipText: { color: '#ffffff', fontSize: 15 },
  fontChipTextOn: { color: '#2a1d30' },
  fontNote: { color: 'rgba(255,255,255,0.75)', fontFamily: 'Nunito', fontSize: 13 },
  dots: { flexDirection: 'row', alignSelf: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)' },
  dotOn: { backgroundColor: '#ffffff', transform: [{ scale: 1.4 }] },
  counter: { alignSelf: 'flex-end', color: '#ffffff', fontFamily: 'Nunito', fontWeight: '700', fontSize: 13 },
  tools: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  aa: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(18, 12, 23, 0.46)',
  },
  aaText: { color: '#ffffff', fontSize: 20 },
  publishLine: { flex: 1, minHeight: 48, justifyContent: 'center' },
  publishText: { color: 'rgba(255,255,255,0.9)', fontFamily: 'Nunito', fontWeight: '700', fontSize: 13 },
  send: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff',
  },
  palette: { flexDirection: 'row', flexWrap: 'wrap', paddingTop: 12, paddingBottom: 8, rowGap: 14 },
  swatchCell: { width: '25%', alignItems: 'center', gap: 6 },
  swatch: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    // Night on the dark sheet still needs an edge.
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  swatchOn: { borderWidth: 3, borderColor: '#ffffff' },
  swatchName: { color: '#e7d7ea', fontFamily: 'Nunito', fontSize: 12, maxWidth: 84 },
  sheetFonts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 12, paddingBottom: 6 },
});
