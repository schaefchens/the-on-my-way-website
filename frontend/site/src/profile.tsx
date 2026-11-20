/**
 * Whose journey it is: the owner's profile (timeline.json `profile`, from the settings
 * site.author / site.intro / site.avatar), shown by the home hero, the player's avatar ring and
 * the day-end sign-off.
 *
 * Source: the loaded timeline; until it has arrived (a day page plays from its inlined day while
 * the timeline loads behind the player) the profile inlined in the page's Boot JSON. Without a
 * provider (unit tests, screens outside the locale layout) there is no profile, and every part
 * looks exactly as it did before profiles existed.
 *
 * The backend generator renders the same markup into the pre-rendered first screen
 * (backend/src/generator/twin.ts): keep both in step.
 */
import { type LocaleCode, type PickedText, pickText } from '@omw/contracts/i18n';
import type { AvatarImage, FocusPoint, SiteProfile } from '@omw/contracts/site';
import { Picture } from '@omw/ui/picture';
import { createContext, type ReactNode, useContext } from 'react';
import { useTimeline } from './data/hooks';
import { useSite } from './site';

const ProfileContext = createContext<SiteProfile | null>(null);

/** The profile to show: the timeline's once it is loaded, the Boot JSON's until then. */
export function profileFrom(
  timeline: { profile?: SiteProfile | undefined } | undefined,
  bootProfile: SiteProfile | null,
): SiteProfile | null {
  if (timeline) return hasProfile(timeline.profile) ? (timeline.profile ?? null) : null;
  return hasProfile(bootProfile) ? bootProfile : null;
}

export function hasProfile(profile: SiteProfile | null | undefined): profile is SiteProfile {
  return !!profile && (!!profile.author || !!profile.avatar || !!profile.intro);
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { boot } = useSite();
  const { data: timeline } = useTimeline();
  return <ProfileContext.Provider value={profileFrom(timeline, boot.profile)}>{children}</ProfileContext.Provider>;
}

/** A given profile for a subtree (component tests, previews). */
export function ProfileValueProvider({ profile, children }: { profile: SiteProfile | null; children: ReactNode }) {
  return <ProfileContext.Provider value={hasProfile(profile) ? profile : null}>{children}</ProfileContext.Provider>;
}

/** The owner's profile, or null when none is set (or outside the locale layout). */
export function useProfile(): SiteProfile | null {
  return useContext(ProfileContext);
}

/**
 * The greeting in the visitor's locale, else in another one (the caller marks it with `lang`
 * and dir="auto"): the same pick as every other owner text.
 */
export function greetingFor(profile: SiteProfile | null | undefined, locale: LocaleCode): PickedText | null {
  return pickText(profile?.intro, locale);
}

/**
 * CSS object-position of a portrait's focus point ("50% 40%"): physical image coordinates, so it
 * is never mirrored in RTL. Undefined without a focus (the browser centres the crop).
 */
export function focusPosition(focus: FocusPoint | undefined): string | undefined {
  if (!focus) return undefined;
  const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10}%`;
  return `${pct(focus.x)} ${pct(focus.y)}`;
}

/** The portrait as a round crop (the caller sizes the box). */
export function Portrait({
  image,
  sizes,
  className = '',
  loading = 'eager',
}: {
  image: AvatarImage;
  sizes: string;
  className?: string;
  loading?: 'eager' | 'lazy';
}) {
  const position = focusPosition(image.focus);
  return (
    <Picture
      image={image}
      alt=""
      sizes={sizes}
      loading={loading}
      fallbackWidth={320}
      className={className ? `size-full rounded-full object-cover ${className}` : 'size-full rounded-full object-cover'}
      style={position ? { objectPosition: position } : undefined}
    />
  );
}

/** Image sizes of the hero portrait (its box: 4.5rem, from the sm breakpoint 6rem). */
export const HERO_PORTRAIT_SIZES = '(min-width: 40rem) 96px, 72px';

/**
 * The hero's portrait: a soft circle with a gentle rose-to-violet ring. The ring has a fixed
 * size, so the page never shifts while the picture loads (colour + ThumbHash show meanwhile).
 */
export function HeroPortrait({ image }: { image: AvatarImage }) {
  return (
    <span
      aria-hidden="true"
      data-testid="hero-portrait"
      className="grid size-[4.5rem] shrink-0 place-items-center rounded-full bg-linear-to-br from-rose-300 via-lilac-300 to-violet-300 p-[3px] shadow-soft sm:size-24"
    >
      <span className="block size-full overflow-hidden rounded-full bg-bg p-[3px]">
        <Portrait image={image} sizes={HERO_PORTRAIT_SIZES} />
      </span>
    </span>
  );
}
