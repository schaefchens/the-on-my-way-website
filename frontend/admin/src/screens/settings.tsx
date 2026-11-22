/**
 * Settings: people and access, safety options and the privacy notice (own screens), one-tap time
 * zone from this device, publish mode and delay (with what each means), about you (name,
 * greeting, portrait: settings-profile.tsx), site title, languages and search-engine visibility,
 * alert targets, this app's language and theme, API tokens (shown once), password change and
 * logout.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { ApiTokenInfo, PublishMode, Settings, SettingsPatch, TokenKind } from '@omw/contracts/api';
import { LOCALES, type LocaleCode } from '@omw/contracts/i18n';
import { effectiveCaptureVisibility } from '@omw/contracts/policy';
import { formatDateTime, formatRelative, formatTime } from '@omw/ui/locale';
import { type ThemePreference, useThemePreference } from '@omw/ui/theme';
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouteContext } from '@tanstack/react-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { cachedCaptures } from '../api/cache';
import { adminApi } from '../api/client';
import { qk } from '../api/keys';
import { capturesQuery, settingsQuery, statusQuery, tokensQuery } from '../api/queries';
import {
  AlertIcon,
  BellIcon,
  BookIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  GlobeIcon,
  KeyIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PeopleIcon,
  SendIcon,
  ShieldIcon,
  SunIcon,
  TrashIcon,
} from '../components/icons';
import { InstallAction } from '../components/install';
import { PUBLISH_MODE_LABEL } from '../components/labels';
import { PasswordSheet } from '../components/password-sheet';
import {
  Badge,
  Button,
  cx,
  Dialog,
  Field,
  IconButton,
  QueryError,
  ScreenHeader,
  Section,
  Segmented,
  SelectInput,
  Skeleton,
  Switch,
  TextInput,
} from '../components/ui';
import { ADMIN_LOCALES, activateLocale } from '../i18n';
import { friendlyError } from '../lib/errors';
import { useLocale, useNotifyWrite, usePendingWrites, useWrite } from '../lib/hooks';
import { switchReleases, waitingToPublish } from '../lib/mode-since';
import { notify } from '../lib/notices';
import { deviceTimeZone, zoneChoices, zoneLabel, zoneOffset } from '../lib/places';
import { logout } from '../session';
import { AboutYouSection } from './settings-profile';

/**
 * Locales the site may be published in: dev builds also offer the RTL pseudo-locale, and a
 * production build keeps showing it while the site is generated with it (an RTL test deploy),
 * so it can be switched off and is never dropped silently when another language is toggled.
 */
function siteLocales(current: readonly LocaleCode[]) {
  return LOCALES.filter((l) => !l.devOnly || import.meta.env.DEV || current.includes(l.code));
}

function notifyError(err: unknown) {
  const friendly = friendlyError(err);
  notify({ tone: 'error', message: friendly.message, ...(friendly.detail ? { detail: friendly.detail } : {}) });
}

function usePatchSettings() {
  const patch = useWrite('patchSettings');
  const notifyWrite = useNotifyWrite();
  return (p: SettingsPatch, message = msg`Saved`) => {
    patch({ patch: p });
    notifyWrite('settings', message);
  };
}

function TimeZoneSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const locale = useLocale();
  const save = usePatchSettings();
  const device = deviceTimeZone();
  const current = settings['timezone.current'];
  const same = current === device;
  return (
    <Section
      icon={ClockIcon}
      title={<Trans>Time zone</Trans>}
      description={
        <Trans>New statuses are sorted into days by this zone. Change it when you arrive somewhere new.</Trans>
      }
    >
      <div className="rounded-card bg-bg p-4">
        <p className="text-sm text-muted">
          <Trans>Current</Trans>
        </p>
        <p className="display-soft text-xl font-semibold">{zoneLabel(current, locale)}</p>
        <p className="text-sm text-muted">
          <Trans>
            {zoneOffset(current)} · it is {formatTime(new Date(), current, locale)} there
          </Trans>
        </p>
      </div>
      <div className="mt-4">
        {same ? (
          <p className="flex items-center gap-2 rounded-tile bg-success/12 px-4 py-3 text-sm font-bold text-success-strong">
            <CheckIcon className="size-5" />
            <Trans>Matches this device</Trans>
          </p>
        ) : (
          <Button
            size="lg"
            icon={ClockIcon}
            className="w-full"
            onClick={() => save({ 'timezone.current': device }, msg`Time zone updated`)}
          >
            <Trans>Use this device's zone ({zoneLabel(device, locale)})</Trans>
          </Button>
        )}
      </div>
      <details className="mt-4">
        <summary className="press inline-flex min-h-9 cursor-pointer list-none items-center rounded-pill px-2 text-sm font-bold text-muted hover:text-ink pointer-coarse:min-h-11">
          <Trans>Choose another zone</Trans>
        </summary>
        <Field label={<Trans>Time zone</Trans>} className="mt-2">
          {(ids) => (
            <SelectInput
              {...ids}
              value={current}
              onChange={(e) => save({ 'timezone.current': e.target.value }, msg`Time zone updated`)}
            >
              {zoneChoices(locale).map((z) => (
                <option key={z.tz} value={z.tz}>
                  {z.label} ({z.offset})
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        <p className="mt-2 text-xs text-muted">{t`Already captured statuses keep their day; fix single days in the day editor.`}</p>
      </details>
    </Section>
  );
}

const DELAY_PRESETS = [60, 180, 720, 1440];

/**
 * Waiting statuses a mode switch would publish at once, from what this device has cached (plus
 * the "waiting" list, fetched while the question is open). Visibility is re-evaluated with the
 * current settings: a delayed status may have become public since it was loaded.
 */
function useWaitingToPublish(settings: Settings, next: PublishMode | null): number {
  const qc = useQueryClient();
  const pending = useInfiniteQuery({ ...capturesQuery({ visibility: 'pending' }), enabled: next !== null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: recount when the pending list arrives
  return useMemo(() => (next ? waitingCountNow(qc, settings, next) : 0), [qc, settings, next, pending.data]);
}

/** A switch is counted on the whole waiting list: up to this many pages (CAPTURE_PAGE_SIZE each). */
const WAITING_PAGES_MAX = 50;
/** How long a switch waits for the waiting list before it asks without a full count. */
const WAITING_LIST_WAIT_MS = 3000;

/**
 * Loads the waiting list in full. It comes newest first, one page at a time, so what review ->
 * delayed publishes (the oldest) is on the last pages: counting only the first page could say
 * "nothing to publish" and switch without asking. True only when this load succeeded and reached
 * the last page (within WAITING_PAGES_MAX): only then may a count of 0 switch without asking.
 */
async function loadWaitingList(qc: QueryClient): Promise<boolean> {
  const options = capturesQuery({ visibility: 'pending' });
  const cached = qc.getQueryData(options.queryKey);
  const complete = !!cached && cached.pages.length > 0 && !cached.pages.at(-1)?.nextCursor;
  const data = await qc.fetchInfiniteQuery({ ...options, pages: WAITING_PAGES_MAX, staleTime: complete ? 10_000 : 0 });
  return data.pages.length > 0 && !data.pages.at(-1)?.nextCursor;
}

/** loadWaitingList, but never longer than `ms` and never throwing: false = not counted in full. */
function waitingListLoaded(qc: QueryClient, ms: number): { done: Promise<boolean>; within: Promise<boolean> } {
  const done = loadWaitingList(qc).catch(() => false);
  const within = Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
  return { done, within };
}

function waitingCountNow(qc: QueryClient, settings: Settings, next: PublishMode): number {
  const now = Date.now();
  const current = cachedCaptures(qc).map((c) => ({
    ...c,
    effectiveVisibility: effectiveCaptureVisibility(c, c.annotation, settings, now),
  }));
  return waitingToPublish(current, settings, next, now).length;
}

/** The open question: which mode, and whether the whole waiting list could be counted. */
interface ModeSwitch {
  mode: PublishMode;
  counted: boolean;
}

function ModeSwitchSheet({
  settings,
  pending,
  onCancel,
  onConfirm,
  onRecount,
}: {
  settings: Settings;
  pending: ModeSwitch | null;
  onCancel: () => void;
  onConfirm: (mode: PublishMode) => void;
  onRecount: () => Promise<void>;
}) {
  const { t } = useLingui();
  const next = pending?.mode ?? null;
  const count = useWaitingToPublish(settings, next);
  const [recounting, setRecounting] = useState(false);
  const all = next === 'instant';
  const counted = pending?.counted ?? true;
  let description: ReactNode;
  if (counted && all) {
    description = (
      <Plural
        value={count}
        _0="Nothing is waiting any more."
        one="# waiting status will be published now."
        other="# waiting statuses will be published now."
      />
    );
  } else if (counted) {
    description = (
      <Plural
        value={count}
        _0="No waiting status is older than the delay any more."
        one="# waiting status is older than the delay and will be published now."
        other="# waiting statuses are older than the delay and will be published now."
      />
    );
  } else if (count === 0) {
    // The list did not load (offline, a slow connection): never switch as if nothing waited.
    description = all ? (
      <Trans>
        Your waiting statuses could not be loaded just now (offline or a slow connection), so it is unclear how many
        there are. All of them will be published now.
      </Trans>
    ) : (
      <Trans>
        Your waiting statuses could not be loaded just now (offline or a slow connection), so it is unclear how many are
        older than the delay. Those will be published now.
      </Trans>
    );
  } else {
    description = all ? (
      <Plural
        value={count}
        one="At least # waiting status will be published now. Not all waiting statuses could be loaded (offline or a slow connection)."
        other="At least # waiting statuses will be published now. Not all waiting statuses could be loaded (offline or a slow connection)."
      />
    ) : (
      <Plural
        value={count}
        one="At least # waiting status is older than the delay and will be published now. Not all waiting statuses could be loaded (offline or a slow connection)."
        other="At least # waiting statuses are older than the delay and will be published now. Not all waiting statuses could be loaded (offline or a slow connection)."
      />
    );
  }
  return (
    <Dialog
      open={next !== null}
      onClose={onCancel}
      closeLabel={t`Close`}
      title={all ? <Trans>Publish what is waiting?</Trans> : <Trans>Publish the older waiting statuses?</Trans>}
      description={<span data-testid="mode-switch-count">{description}</span>}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            <Trans>Keep the current mode</Trans>
          </Button>
          <Button icon={SendIcon} onClick={() => next && onConfirm(next)}>
            <Trans>Switch and publish</Trans>
          </Button>
        </>
      }
    >
      <p className="rounded-tile bg-bg px-4 py-3 text-sm">
        <Trans>Statuses you hid stay hidden. Everything newer follows the new mode.</Trans>
      </p>
      {!counted && (
        <Button
          variant="secondary"
          className="mt-3"
          disabled={recounting}
          onClick={() => {
            setRecounting(true);
            void onRecount().finally(() => setRecounting(false));
          }}
        >
          {recounting ? <Trans>Counting…</Trans> : <Trans>Count again</Trans>}
        </Button>
      )}
    </Dialog>
  );
}

function PublishSection({ settings }: { settings: Settings }) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const save = usePatchSettings();
  const qc = useQueryClient();
  const [switchTo, setSwitchTo] = useState<ModeSwitch | null>(null);
  const mode = settings['publish.mode'];
  /** Marks the open question as counted once a load of the waiting list completes. */
  function countedWhen(done: Promise<boolean>, next: PublishMode) {
    void done.then((complete) => {
      if (complete) setSwitchTo((open) => (open?.mode === next ? { mode: next, counted: true } : open));
    });
  }
  async function chooseMode(next: PublishMode) {
    if (next === mode) return;
    // Releasing what waits is not undoable: ask first (review -> delayed, anything -> instant).
    // The waiting list is loaded first (bounded). Only a complete count of 0 switches without
    // asking; offline or on a slow connection the question comes with an "unclear" count.
    if (switchReleases(settings, next)) {
      const { done, within } = waitingListLoaded(qc, WAITING_LIST_WAIT_MS);
      const counted = await within;
      if (!counted || waitingCountNow(qc, settings, next) > 0) {
        setSwitchTo({ mode: next, counted });
        if (!counted) countedWhen(done, next);
        return;
      }
    }
    save({ 'publish.mode': next }, msg`Publish mode changed`);
  }
  const delay = settings['publish.delay_minutes'];
  const [hours, setHours] = useState(String(Math.round((delay / 60) * 10) / 10));
  useEffect(() => setHours(String(Math.round((delay / 60) * 10) / 10)), [delay]);
  const since = settings['publish.mode_since'];
  const parsedHours = Number(hours.replace(',', '.'));
  const hoursValid = Number.isFinite(parsedHours) && parsedHours >= 0 && parsedHours <= 8760;
  const explanation: Record<PublishMode, ReactNode> = {
    instant: <Trans>Every new status appears on the site within about a minute.</Trans>,
    delayed: (
      <Trans>
        New statuses appear after a delay, so nobody can see where you are right now. Hide something in the meantime and
        it never appears.
      </Trans>
    ),
    review: <Trans>New statuses wait in the inbox until you release them one by one.</Trans>,
  };
  return (
    <Section
      icon={SendIcon}
      title={<Trans>Publishing</Trans>}
      description={
        <Trans>What happens with new WhatsApp statuses. Your notes and stories have their own visibility.</Trans>
      }
    >
      <Segmented<PublishMode>
        label={t`Publish mode`}
        value={mode}
        className="w-full"
        onChange={(next) => void chooseMode(next)}
        options={(['instant', 'delayed', 'review'] as const).map((m) => ({
          value: m,
          label: i18n._(PUBLISH_MODE_LABEL[m]),
        }))}
      />
      <p className="mt-3 rounded-tile bg-bg px-4 py-3 text-sm">{explanation[mode]}</p>
      {mode !== 'instant' && since !== '1970-01-01T00:00:00.000Z' && (
        <p className="mt-2 px-1 text-xs text-muted">
          <Trans>
            Applies to statuses since {formatDateTime(since, deviceTimeZone(), locale)}. Everything published before
            stays online.
          </Trans>
        </p>
      )}
      {mode === 'instant' && (
        <p className="mt-2 px-1 text-xs text-muted">
          <Trans>Switching to instant publishes everything that is still waiting (unless you hid it).</Trans>
        </p>
      )}
      {mode === 'delayed' && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {DELAY_PRESETS.map((min) => {
              const h = min / 60;
              return (
                <button
                  key={min}
                  type="button"
                  aria-pressed={delay === min}
                  onClick={() => save({ 'publish.delay_minutes': min }, msg`Delay changed`)}
                  className={cx(
                    'press min-h-9 rounded-pill px-4 text-sm font-bold pointer-coarse:min-h-11',
                    delay === min ? 'bg-accent text-on-accent' : 'bg-blush text-ink hover:bg-blush-strong',
                  )}
                >
                  <Plural value={h} one="# hour" other="# hours" />
                </button>
              );
            })}
          </div>
          <div className="flex items-end gap-2">
            <Field
              label={<Trans>Delay in hours</Trans>}
              error={hoursValid ? null : t`0 to 8760 hours`}
              className="max-w-40"
            >
              {(ids) => (
                <TextInput {...ids} inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
              )}
            </Field>
            <Button
              variant="secondary"
              disabled={!hoursValid || Math.round(parsedHours * 60) === delay}
              onClick={() => save({ 'publish.delay_minutes': Math.round(parsedHours * 60) }, msg`Delay changed`)}
            >
              <Trans>Apply</Trans>
            </Button>
          </div>
        </div>
      )}
      <ModeSwitchSheet
        settings={settings}
        pending={switchTo}
        onCancel={() => setSwitchTo(null)}
        onConfirm={(next) => {
          setSwitchTo(null);
          save({ 'publish.mode': next }, msg`Publish mode changed`);
        }}
        onRecount={async () => {
          const next = switchTo?.mode;
          if (!next) return;
          // A load that is still retrying (backing off after network errors) starts over now.
          await qc.cancelQueries({ queryKey: capturesQuery({ visibility: 'pending' }).queryKey });
          const { done, within } = waitingListLoaded(qc, WAITING_LIST_WAIT_MS * 2);
          countedWhen(done, next);
          await within;
        }}
      />
      <div className="mt-5 border-t border-line pt-4">
        <Switch
          checked={settings['ingest.on_revoke'] === 'hide'}
          onChange={(on) => save({ 'ingest.on_revoke': on ? 'hide' : 'keep' })}
          label={<Trans>Hide statuses I delete on WhatsApp</Trans>}
          description={<Trans>Recommended. Otherwise a deleted status stays in the journal.</Trans>}
        />
      </div>
    </Section>
  );
}

function SiteSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const save = usePatchSettings();
  const [title, setTitle] = useState(settings['site.title']);
  const [confirmIndex, setConfirmIndex] = useState(false);
  useEffect(() => setTitle(settings['site.title']), [settings['site.title']]);
  const locales = settings['site.locales'];
  const def = settings['site.default_locale'];
  const available = siteLocales(locales);

  function toggleLocale(code: LocaleCode, on: boolean) {
    const next = on
      ? available.map((l) => l.code).filter((c) => c === code || locales.includes(c))
      : locales.filter((c) => c !== code);
    if (next.length === 0) return;
    save(
      { 'site.locales': next, ...(next.includes(def) ? {} : { 'site.default_locale': next[0] }) },
      msg`Languages changed`,
    );
  }

  return (
    <Section icon={GlobeIcon} title={<Trans>Website</Trans>}>
      <div className="flex items-end gap-2">
        <Field label={<Trans>Site title</Trans>} className="flex-1">
          {(ids) => <TextInput {...ids} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Button
          variant="secondary"
          disabled={!title.trim() || title.trim() === settings['site.title']}
          onClick={() => save({ 'site.title': title.trim() }, msg`Site title saved`)}
        >
          <Trans>Save</Trans>
        </Button>
      </div>
      <fieldset className="mt-5">
        <legend className="text-sm font-bold">
          <Trans>Languages of the site</Trans>
        </legend>
        <ul className="mt-2 space-y-2">
          {available.map((l) => {
            const on = locales.includes(l.code);
            return (
              <li key={l.code} className="flex items-center justify-between gap-3 rounded-tile bg-bg px-3 py-2">
                <label className="flex min-h-9 flex-1 items-center gap-3 font-semibold pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={on && locales.length === 1}
                    onChange={(e) => toggleLocale(l.code, e.target.checked)}
                    className="size-5 accent-[var(--omw-accent)]"
                  />
                  {l.label}
                  {l.devOnly && <Badge tone="neutral">RTL test</Badge>}
                </label>
                {on && (
                  <label className="flex min-h-9 items-center gap-2 text-sm text-muted pointer-coarse:min-h-11 pointer-coarse:px-1">
                    <input
                      type="radio"
                      name="default-locale"
                      checked={def === l.code}
                      onChange={() => save({ 'site.default_locale': l.code }, msg`Default language changed`)}
                      className="size-4 accent-[var(--omw-accent)]"
                    />
                    <Trans>default</Trans>
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>
      <div className="mt-5 border-t border-line pt-4">
        <Switch
          checked={settings['site.indexable']}
          onChange={(on) =>
            on ? setConfirmIndex(true) : save({ 'site.indexable': false }, msg`Hidden from search engines`)
          }
          label={<Trans>Findable by search engines</Trans>}
          description={
            settings['site.indexable'] ? (
              <Trans>Google & co. may list your journal.</Trans>
            ) : (
              <Trans>Off: only people with the link find the site.</Trans>
            )
          }
        />
      </div>
      <Dialog
        open={confirmIndex}
        onClose={() => setConfirmIndex(false)}
        closeLabel={t`Close`}
        title={<Trans>Let search engines find you?</Trans>}
        description={
          <Trans>
            Your journal, with places and dates, can then show up in search results for anyone. This is hard to undo:
            search engines keep copies for a while.
          </Trans>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmIndex(false)}>
              <Trans>Keep it private</Trans>
            </Button>
            <Button
              icon={AlertIcon}
              onClick={() => {
                save({ 'site.indexable': true }, msg`Findable by search engines`);
                setConfirmIndex(false);
              }}
            >
              <Trans>Yes, make it findable</Trans>
            </Button>
          </>
        }
      />
    </Section>
  );
}

function AlertsSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const save = usePatchSettings();
  const [email, setEmail] = useState(settings['alerts.email'] ?? '');
  const [ntfy, setNtfy] = useState(settings['alerts.ntfy_url'] ?? '');
  const [stale, setStale] = useState(String(settings['alerts.heartbeat_stale_minutes']));
  useEffect(() => {
    setEmail(settings['alerts.email'] ?? '');
    setNtfy(settings['alerts.ntfy_url'] ?? '');
    setStale(String(settings['alerts.heartbeat_stale_minutes']));
  }, [settings]);
  const emailOk = email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const ntfyOk = ntfy.trim() === '' || /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(ntfy.trim());
  const staleN = Number(stale);
  const staleOk = Number.isInteger(staleN) && staleN >= 1 && staleN <= 10080;
  const patch: SettingsPatch = {};
  if (email.trim() !== (settings['alerts.email'] ?? '')) patch['alerts.email'] = email.trim() || null;
  if (ntfy.trim() !== (settings['alerts.ntfy_url'] ?? '')) patch['alerts.ntfy_url'] = ntfy.trim() || null;
  if (staleOk && staleN !== settings['alerts.heartbeat_stale_minutes'])
    patch['alerts.heartbeat_stale_minutes'] = staleN;
  const dirty = Object.keys(patch).length > 0;
  return (
    <Section
      icon={BellIcon}
      title={<Trans>Alerts</Trans>}
      description={
        <Trans>Where to send a message when your computer at home stops checking in or WhatsApp logs out.</Trans>
      }
    >
      <div className="space-y-4">
        <Field label={<Trans>E-mail</Trans>} error={emailOk ? null : t`This does not look like an e-mail address.`}>
          {(ids) => (
            <TextInput
              {...ids}
              type="email"
              dir="ltr"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={<Trans>Push address (ntfy)</Trans>}
          hint={<Trans>Push notifications via ntfy.sh, e.g. https://ntfy.sh/my-secret-topic</Trans>}
          error={ntfyOk ? null : t`Use an http(s) address.`}
        >
          {(ids) => (
            <TextInput
              {...ids}
              type="url"
              inputMode="url"
              dir="ltr"
              value={ntfy}
              onChange={(e) => setNtfy(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={<Trans>Alert after (minutes without heartbeat)</Trans>}
          error={staleOk ? null : t`1 to 10080 minutes`}
          className="max-w-xs"
        >
          {(ids) => <TextInput {...ids} inputMode="numeric" value={stale} onChange={(e) => setStale(e.target.value)} />}
        </Field>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            disabled={!dirty || !emailOk || !ntfyOk || !staleOk}
            onClick={() => save(patch, msg`Alert settings saved`)}
          >
            <Trans>Save alerts</Trans>
          </Button>
        </div>
      </div>
    </Section>
  );
}

function AppSection() {
  const { t } = useLingui();
  const locale = useLocale();
  const [theme, setTheme] = useThemePreference();
  const appLocales = LOCALES.filter((l) => ADMIN_LOCALES.includes(l.code));
  return (
    <Section icon={MonitorIcon} title={<Trans>This app</Trans>}>
      <div className="space-y-5">
        <Field label={<Trans>Language of this app</Trans>}>
          {(ids) => (
            <SelectInput
              {...ids}
              value={locale}
              onChange={(e) => void activateLocale(e.target.value as LocaleCode, true)}
            >
              {appLocales.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-bold">
            <Trans>Appearance</Trans>
          </p>
          <Segmented<ThemePreference>
            label={t`Appearance`}
            value={theme}
            onChange={setTheme}
            className="w-full"
            options={[
              { value: 'system', label: t`System`, icon: MonitorIcon },
              { value: 'dawn', label: t`Dawn`, icon: SunIcon },
              { value: 'dusk', label: t`Dusk`, icon: MoonIcon },
            ]}
          />
        </div>
        <InstallAction className="w-full sm:w-auto" />
      </div>
    </Section>
  );
}

function TokenRow({ token, onRevoke }: { token: ApiTokenInfo; onRevoke: () => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  return (
    <li className="flex items-center gap-3 rounded-tile bg-bg px-3 py-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-pill bg-lilac text-violet">
        <KeyIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold">{token.name}</span>
        <span className="block text-xs text-muted">
          <code dir="ltr">{token.hint}</code> · {token.kind === 'app' ? t`App` : t`Computer at home`} ·{' '}
          {token.lastUsedAt ? (
            <Trans>used {formatRelative(token.lastUsedAt, locale)}</Trans>
          ) : (
            <Trans>never used</Trans>
          )}
        </span>
      </span>
      <IconButton label={t`Revoke ${token.name}`} icon={TrashIcon} size="sm" onClick={onRevoke} />
    </li>
  );
}

function TokensSection() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const q = useQuery(tokensQuery());
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TokenKind>('app');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiTokenInfo | null>(null);
  const create = useMutation({
    mutationFn: () => adminApi.createToken({ kind, name: name.trim() }),
    onSuccess: (res) => {
      setCreated(res.token);
      setCopied(false);
      setName('');
      void qc.invalidateQueries({ queryKey: qk.tokens });
    },
    onError: (err) => notifyError(err),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => adminApi.revokeToken(id),
    onSuccess: () => {
      notify({ tone: 'success', message: msg`Token revoked` });
      void qc.invalidateQueries({ queryKey: qk.tokens });
    },
    onError: (err) => notifyError(err),
  });
  const active = (q.data?.items ?? []).filter((tk) => tk.revokedAt === null);
  return (
    <Section
      icon={KeyIcon}
      title={<Trans>API tokens</Trans>}
      description={<Trans>For your computer at home and future apps. A token is shown only once.</Trans>}
    >
      <QueryError error={q.error} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton className="h-14" />}
      {q.data && active.length === 0 && (
        <p className="text-sm text-muted">
          <Trans>No tokens yet.</Trans>
        </p>
      )}
      <ul className="space-y-2">
        {active.map((tk) => (
          <TokenRow key={tk.id} token={tk} onRevoke={() => setRevoking(tk)} />
        ))}
      </ul>
      {created && (
        <div role="status" className="mt-4 rounded-card border-2 border-dashed border-accent bg-blush p-4">
          <p className="font-bold">
            <Trans>Your new token — copy it now, it will not be shown again:</Trans>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 rounded-tile bg-surface px-3 py-2 text-sm break-all select-all">
              {created}
            </code>
            <IconButton
              label={copied ? t`Copied` : t`Copy`}
              icon={copied ? CheckIcon : CopyIcon}
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(created).then(() => setCopied(true));
              }}
            />
          </div>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setCreated(null)}>
            <Trans>Done, I saved it</Trans>
          </Button>
        </div>
      )}
      <form
        className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <Field label={<Trans>Name</Trans>} className="flex-1">
          {(ids) => (
            <TextInput
              {...ids}
              maxLength={100}
              placeholder={t`e.g. Computer at home`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={<Trans>For</Trans>}>
          {(ids) => (
            <SelectInput {...ids} value={kind} onChange={(e) => setKind(e.target.value as TokenKind)}>
              <option value="app">{t`App (admin access)`}</option>
              <option value="backend">{t`Computer at home (sync)`}</option>
            </SelectInput>
          )}
        </Field>
        <Button type="submit" variant="secondary" icon={KeyIcon} busy={create.isPending} disabled={!name.trim()}>
          <Trans>Create token</Trans>
        </Button>
      </form>
      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        closeLabel={t`Close`}
        title={<Trans>Revoke this token?</Trans>}
        description={<Trans>Whatever uses “{revoking?.name}” loses access immediately.</Trans>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              <Trans>Keep</Trans>
            </Button>
            <Button
              className="bg-danger hover:bg-danger"
              icon={TrashIcon}
              busy={revoke.isPending}
              onClick={() => {
                if (revoking) revoke.mutate(revoking.id, { onSettled: () => setRevoking(null) });
              }}
            >
              <Trans>Revoke</Trans>
            </Button>
          </>
        }
      />
    </Section>
  );
}

function AccessLink({
  to,
  icon: IconCmp,
  title,
  description,
  badge,
}: {
  to: '/people' | '/settings/safety' | '/settings/privacy';
  icon: typeof PeopleIcon;
  title: ReactNode;
  description: ReactNode;
  badge?: number;
}) {
  return (
    <li>
      <Link to={to} className="press flex items-center gap-3 rounded-tile bg-bg px-3.5 py-3 hover:bg-blush/60">
        <span className="grid size-10 shrink-0 place-items-center rounded-pill bg-blush text-accent">
          <IconCmp className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-bold">{title}</span>
          <span className="block text-sm text-muted">{description}</span>
        </span>
        {badge ? <Badge tone="rose">{badge}</Badge> : null}
        <ChevronRightIcon className="size-5 text-muted" flip />
      </Link>
    </li>
  );
}

/** People and access, safety options, privacy notice (wave 5): their own screens. */
function AccessSection() {
  const status = useQuery(statusQuery());
  const pending = status.data?.access?.pendingDevices ?? 0;
  return (
    <Section icon={ShieldIcon} title={<Trans>Who sees your journey</Trans>}>
      <ul className="space-y-2">
        <AccessLink
          to="/people"
          icon={PeopleIcon}
          title={<Trans>People & access</Trans>}
          description={<Trans>Invite, allow devices, end access</Trans>}
          badge={pending}
        />
        <AccessLink
          to="/settings/safety"
          icon={ShieldIcon}
          title={<Trans>Safety</Trans>}
          description={<Trans>Release times, departure hold, lock, panic link</Trans>}
        />
        <AccessLink
          to="/settings/privacy"
          icon={BookIcon}
          title={<Trans>Privacy notice</Trans>}
          description={<Trans>What people read before they join</Trans>}
        />
      </ul>
    </Section>
  );
}

function AccountSection() {
  const { t } = useLingui();
  const { me } = useRouteContext({ from: '/authed' });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = usePendingWrites().length;
  const [confirm, setConfirm] = useState(false);
  const [changing, setChanging] = useState(false);
  async function doLogout() {
    // Leave the signed-in screens first, so nothing refetches (401) while the data is wiped.
    await navigate({ to: '/login' });
    await logout(qc);
  }
  return (
    <Section title={<Trans>Account</Trans>}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{me.displayName ?? me.email}</p>
          <p className="truncate text-sm text-muted">{me.email}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={KeyIcon} data-testid="password-open" onClick={() => setChanging(true)}>
            <Trans>Change password</Trans>
          </Button>
          <Button
            variant="secondary"
            icon={LogOutIcon}
            onClick={() => (pending > 0 ? setConfirm(true) : void doLogout())}
          >
            <Trans>Log out</Trans>
          </Button>
        </div>
      </div>
      <PasswordSheet open={changing} onClose={() => setChanging(false)} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        closeLabel={t`Close`}
        title={<Trans>Changes not sent yet</Trans>}
        description={
          <Plural
            value={pending}
            one="# change has not reached the server. Logging out deletes it from this device."
            other="# changes have not reached the server. Logging out deletes them from this device."
          />
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              <Trans>Stay logged in</Trans>
            </Button>
            <Button className="bg-danger hover:bg-danger" icon={LogOutIcon} onClick={() => void doLogout()}>
              <Trans>Log out anyway</Trans>
            </Button>
          </>
        }
      />
    </Section>
  );
}

export function SettingsScreen() {
  const q = useQuery(settingsQuery());
  return (
    <>
      <ScreenHeader eyebrow={<Trans>how your journal behaves</Trans>} title={<Trans>Settings</Trans>} />
      <div className="mb-5">
        <AccessSection />
      </div>
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        {q.data && (
          <>
            <div className="space-y-5">
              <TimeZoneSection settings={q.data} />
              <PublishSection settings={q.data} />
              <AlertsSection settings={q.data} />
            </div>
            <div className="space-y-5">
              <AboutYouSection settings={q.data} />
              <SiteSection settings={q.data} />
              <AppSection />
              <TokensSection />
              <AccountSection />
            </div>
          </>
        )}
        {!q.data && !q.isPending && (
          <div className="space-y-5">
            <AppSection />
            <AccountSection />
          </div>
        )}
      </div>
    </>
  );
}
