/**
 * Settings → "About you" (owner decision "personal touch"): the traveler's name, a short greeting
 * per language and a portrait picked from the captured photos. The site shows them as its home
 * hero, in the player's avatar ring and as the day-end sign-off. Each part saves on its own
 * through the queued settings patch; text is cleaned first (lib/profile.ts), empty removes it.
 * A rejected write (422) is shown next to its field while this section is on screen.
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Settings } from '@omw/contracts/api';
import { LOCALES, type LocaleCode } from '@omw/contracts/i18n';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { captureQuery } from '../api/queries';
import { CharRing } from '../components/char-ring';
import { AlertIcon, EyeOffIcon, HeartIcon, ImageIcon, TrashIcon } from '../components/icons';
import { PortraitPicker, PortraitPreview, useSetPortrait } from '../components/portrait';
import { Button, Field, LocaleTabs, Section, TextArea, TextInput } from '../components/ui';
import { ADMIN_LOCALES } from '../i18n';
import { filledLocales } from '../lib/forms';
import { useLocale, useNotifyWrite, useServerForm, useWrite } from '../lib/hooks';
import {
  AUTHOR_MAX,
  authorTooLong,
  claimProfileErrors,
  cleanAuthor,
  cleanIntro,
  cleanIntroText,
  clearProfileError,
  INTRO_MAX,
  introTooLong,
  previewGreeting,
  profileErrorStore,
  sameSetting,
  textLength,
} from '../lib/profile';
import { useStore } from '../lib/store';

/** Locales the owner writes in (dev-only pseudo-locales excluded). */
const GREETING_LOCALES = LOCALES.filter((l) => !l.devOnly && ADMIN_LOCALES.includes(l.code));

function InlineError({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p role="alert" data-testid={testId} className="mt-2 flex items-start gap-1.5 text-xs font-semibold text-danger">
      <AlertIcon className="size-3.5 translate-y-px" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** "On your site": the hero as visitors will see it, from what is typed right now. */
function SitePreview({
  name,
  greeting,
  greetingLocale,
  portrait,
}: {
  name: string;
  greeting: string;
  greetingLocale: LocaleCode;
  portrait: ReactNode;
}) {
  const empty = !name && !greeting;
  return (
    <figure className="mb-5 rounded-card bg-bg p-4 paper-grain">
      <figcaption className="mb-2 text-xs font-extrabold tracking-wider text-muted uppercase">
        <Trans>On your site</Trans>
      </figcaption>
      <div className="flex items-center gap-3.5">
        {portrait}
        <div className="min-w-0">
          {name && (
            <p
              dir="auto"
              data-user-text
              className="display-soft line-clamp-2 align-match-parent text-2xl leading-tight font-semibold break-words"
            >
              {name}
            </p>
          )}
          {greeting ? (
            <p
              lang={greetingLocale}
              dir="auto"
              data-user-text
              className="mt-0.5 align-match-parent font-hand text-[1.05rem] leading-snug break-words whitespace-pre-line text-accent"
            >
              {greeting}
            </p>
          ) : (
            empty && (
              <p className="font-hand text-[1.05rem] text-muted">
                <Trans>Nothing yet: the site shows its usual line.</Trans>
              </p>
            )
          )}
        </div>
      </div>
    </figure>
  );
}

export function AboutYouSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const uiLocale = useLocale();
  const patch = useWrite('patchSettings');
  const notifyWrite = useNotifyWrite();
  const setPortrait = useSetPortrait();
  const errors = useStore(profileErrorStore);
  // While this section is on screen, rejected profile writes are shown here, not as toasts.
  useEffect(() => claimProfileErrors(), []);

  // ---- name
  const storedName = settings['site.author'] ?? '';
  const [name, setName] = useState(storedName);
  useEffect(() => setName(storedName), [storedName]);
  const cleanName = cleanAuthor(name);
  const nameTooLong = authorTooLong(cleanName);
  const nameDirty = cleanName !== storedName;
  function saveName() {
    if (nameTooLong || !nameDirty) return;
    clearProfileError('site.author');
    patch({ patch: { 'site.author': cleanName || null } });
    notifyWrite('settings', cleanName ? msg`Name saved` : msg`Name removed`);
  }

  // ---- greeting
  const storedIntro = settings['site.intro'] ?? null;
  const intro = useServerForm(JSON.stringify(storedIntro), true, () => ({ ...(storedIntro ?? {}) }));
  const [tab, setTab] = useState<LocaleCode>(
    GREETING_LOCALES.some((l) => l.code === uiLocale) ? uiLocale : (GREETING_LOCALES[0]?.code ?? 'de'),
  );
  const text = intro.form[tab] ?? '';
  const cleanedIntro = cleanIntro(intro.form);
  const longLocales = introTooLong(intro.form);
  const introDirty = intro.touched && !sameSetting(cleanedIntro, storedIntro);
  function saveIntro() {
    if (longLocales.length > 0 || !introDirty) return;
    clearProfileError('site.intro');
    patch({ patch: { 'site.intro': cleanedIntro } });
    intro.markSaved();
    notifyWrite('settings', cleanedIntro ? msg`Greeting saved` : msg`Greeting removed`);
  }

  // ---- portrait
  const avatar = settings['site.avatar'] ?? null;
  const capture = useQuery({ ...captureQuery(avatar?.sourceKey ?? '-'), enabled: !!avatar });
  const c = avatar ? capture.data : undefined;
  const [picking, setPicking] = useState(false);
  const notInTimeline = !!c && c.effectiveVisibility !== 'public';
  const gone = !!c && (c.mediaState === 'lost' || (!!c.revokedAt && settings['ingest.on_revoke'] === 'hide'));

  /** "At most 60 characters" (one message for both limits). */
  const atMost = (max: number) => t`At most ${max} characters`;
  const otherLocales = longLocales.join(', ');

  // What a visitor in the tab's language sees (the site's pick: that language, else another).
  const preview = previewGreeting(intro.form, tab);

  return (
    <Section
      id="about-you"
      icon={HeartIcon}
      title={<Trans>About you</Trans>}
      description={
        <Trans>Your name, a few warm words and a portrait: visitors see who is on the road. All optional.</Trans>
      }
    >
      <SitePreview
        name={cleanName}
        greeting={preview?.text ?? ''}
        greetingLocale={preview?.locale ?? tab}
        portrait={avatar ? <PortraitPreview setting={avatar} capture={c} size="sm" /> : null}
      />

      {/* Name */}
      <div className="flex items-end gap-2">
        <Field
          label={<Trans>Your name</Trans>}
          className="flex-1"
          error={nameTooLong ? atMost(AUTHOR_MAX) : (errors['site.author'] ?? null)}
        >
          {(ids) => (
            <TextInput
              {...ids}
              data-testid="profile-name"
              autoComplete="nickname"
              maxLength={AUTHOR_MAX * 2}
              placeholder={t`e.g. Lea`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearProfileError('site.author');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveName();
              }}
            />
          )}
        </Field>
        <Button variant="secondary" disabled={!nameDirty || nameTooLong} onClick={saveName}>
          {cleanName || !storedName ? <Trans>Save</Trans> : <Trans>Remove</Trans>}
        </Button>
      </div>

      {/* Greeting */}
      <div className="mt-6 border-t border-line pt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold">
            <Trans>Greeting</Trans>
          </p>
          <LocaleTabs
            label={t`Language of the greeting`}
            locales={GREETING_LOCALES}
            value={tab}
            onChange={setTab}
            filled={new Set(filledLocales(intro.form))}
          />
        </div>
        <Field
          label={<span className="sr-only">{t`Greeting (${tab})`}</span>}
          hint={<Trans>Plain text, shown handwritten under your name. Write it in one language or both.</Trans>}
          error={
            longLocales.includes(tab)
              ? atMost(INTRO_MAX)
              : longLocales.length > 0
                ? t`Too long in another language: ${otherLocales}`
                : (errors['site.intro'] ?? null)
          }
        >
          {(ids) => (
            <TextArea
              {...ids}
              data-testid="profile-greeting"
              lang={tab}
              dir="auto"
              rows={3}
              maxLength={INTRO_MAX * 2}
              value={text}
              placeholder={t`Hello, lovely people! So glad you are coming along.`}
              onChange={(e) => {
                const value = e.target.value;
                intro.edit((f) => ({ ...f, [tab]: value }));
                clearProfileError('site.intro');
              }}
              className="resize-none font-hand text-lg leading-snug"
            />
          )}
        </Field>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <CharRing used={textLength(cleanIntroText(text))} max={INTRO_MAX} />
          <div className="flex gap-2">
            {introDirty && (
              <Button variant="ghost" size="sm" onClick={() => intro.reset()}>
                <Trans>Discard</Trans>
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={!introDirty || longLocales.length > 0} onClick={saveIntro}>
              {cleanedIntro || !storedIntro ? <Trans>Save greeting</Trans> : <Trans>Remove greeting</Trans>}
            </Button>
          </div>
        </div>
      </div>

      {/* Portrait */}
      <div className="mt-6 border-t border-line pt-5">
        <div className="flex items-center gap-4">
          <PortraitPreview setting={avatar} capture={c} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">
              <Trans>Portrait</Trans>
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {avatar ? (
                <Trans>A small round copy of the photo, never the full picture.</Trans>
              ) : (
                <Trans>No portrait yet. Pick one of your photos.</Trans>
              )}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                icon={ImageIcon}
                data-testid="portrait-change"
                onClick={() => setPicking(true)}
              >
                {avatar ? <Trans>Change</Trans> : <Trans>Choose a photo</Trans>}
              </Button>
              {avatar && (
                <Button size="sm" variant="ghost" icon={TrashIcon} onClick={() => setPortrait(null)}>
                  <Trans>Remove</Trans>
                </Button>
              )}
            </div>
          </div>
        </div>
        {notInTimeline && !gone && (
          <p
            data-testid="portrait-hidden-hint"
            className="mt-3 flex items-start gap-2 rounded-tile bg-lilac px-3 py-2 text-sm text-ink"
          >
            <EyeOffIcon className="size-4 translate-y-0.5 text-violet" />
            <Trans>This photo is not shown in your timeline, but it is still your portrait.</Trans>
          </p>
        )}
        {gone && (
          <p className="mt-3 flex items-start gap-2 rounded-tile bg-danger/12 px-3 py-2 text-sm text-ink">
            <AlertIcon className="size-4 translate-y-0.5 text-danger" />
            <Trans>
              This photo is gone (deleted on WhatsApp or lost), so the site shows no portrait. Pick another one.
            </Trans>
          </p>
        )}
        {errors['site.avatar'] && <InlineError testId="portrait-error">{errors['site.avatar']}</InlineError>}
        <PortraitPicker
          open={picking}
          current={avatar?.sourceKey ?? null}
          onClose={() => setPicking(false)}
          onPick={(sourceKey) => {
            setPicking(false);
            setPortrait({ sourceKey });
          }}
        />
      </div>
    </Section>
  );
}
