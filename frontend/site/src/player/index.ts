/**
 * Journey player chunk (plan C). routes/day.tsx imports this module lazily, so everything it
 * reaches (and the main bundle does not) lands in one chunk with a budget of 45 kB gzip.
 * The story sheet is a separate chunk (player/story-sheet.tsx, loaded by routes/story.tsx).
 */
export { JourneyPlayer, type JourneyPlayerProps } from './journey-player';
