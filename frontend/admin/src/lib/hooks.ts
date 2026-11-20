/** React glue for the offline write machinery, connectivity and the UI locale. */
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react';
import type { LocaleCode } from '@omw/contracts/i18n';
import { isLocaleCode } from '@omw/contracts/i18n';
import { type Mutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MUTATION_NAMES, type MutationName } from '../api/keys';
import { connectivityStore, isOnline } from '../api/online';
import { statusQuery } from '../api/queries';
import { entityOf, type WriteVars } from '../api/types';
import { runWrite } from '../api/writes';
import { notifyWrite } from './notices';
import { lastChangeStore, notePublish, publishSummary } from './publish';
import { useStore } from './store';

export function useLocale(): LocaleCode {
  const { i18n } = useLingui();
  return isLocaleCode(i18n.locale) ? i18n.locale : 'de';
}

/** Fire-and-forget owner write (optimistic, queued offline, conflicts handled globally). */
export function useWrite<N extends MutationName>(name: N): (vars: WriteVars[N]) => void {
  const qc = useQueryClient();
  return useCallback((vars: WriteVars[N]) => void runWrite(qc, name, vars), [qc, name]);
}

export interface PendingInfo {
  id: number;
  name: MutationName;
  entity: string;
  paused: boolean;
}

function pendingInfo(m: Mutation<unknown, unknown, unknown, unknown>): PendingInfo | null {
  const key = m.options.mutationKey?.[0];
  if (typeof key !== 'string' || !(MUTATION_NAMES as string[]).includes(key)) return null;
  const name = key as MutationName;
  return {
    id: m.mutationId,
    name,
    entity: entityOf(name, m.state.variables as WriteVars[MutationName]),
    paused: m.state.isPaused,
  };
}

/** Owner writes that are queued or in flight. */
export function usePendingWrites(): PendingInfo[] {
  const all = useMutationState({
    filters: { status: 'pending' },
    select: (m) => pendingInfo(m as Mutation<unknown, unknown, unknown, unknown>),
  });
  return useMemo(() => all.filter((p): p is PendingInfo => p !== null), [all]);
}

/** Entities ("capture:wa:…", "day:2026-11-15", …) with a queued write. */
export function usePendingEntities(): ReadonlySet<string> {
  const pending = usePendingWrites();
  return useMemo(() => new Set(pending.map((p) => p.entity)), [pending]);
}

export function useConnectivity() {
  const c = useStore(connectivityStore);
  return { ...c, online: isOnline(c) };
}

/** Toast for a write just queued: "Saved – sending…", then `done` once the server confirmed it. */
export function useNotifyWrite(): (entity: string, done: MessageDescriptor) => void {
  const { online } = useConnectivity();
  return useCallback((entity: string, done: MessageDescriptor) => void notifyWrite(entity, done, online), [online]);
}

/** Site-wide "Live ✓ / publishing…" summary (status polled, faster while publishing). */
export function usePublishSummary() {
  const status = useQuery(statusQuery());
  const lastChange = useStore(lastChangeStore);
  const pending = usePendingWrites();
  const summary = publishSummary(status.data, lastChange, pending.length);
  const { lastAt, lastVersion } = summary;
  // Remembered for "status unknown right now" when the next start has no status at all.
  useEffect(() => notePublish({ lastAt, lastVersion }), [lastAt, lastVersion]);
  return { summary, status };
}

/** True after `ms` of `value` being true (avoids flashing indicators for quick work). */
export function useDelayedFlag(value: boolean, ms = 600): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

/** Re-renders every `ms` (relative times like "5 minutes ago"). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Form state seeded from server data: while the owner has not touched the form, every new
 * server version (first load, a save confirmed, a change from another device) re-seeds it; once
 * touched, the owner's edits win until `markSaved()` or `reset()`.
 */
export function useServerForm<F>(version: string | null | undefined, ready: boolean, make: () => F) {
  const [state, setState] = useState(() => ({ form: make(), version, ready, touched: false }));
  if (ready && !state.touched && (state.version !== version || !state.ready)) {
    // Derived-state update during render (React re-renders immediately, no effect flash).
    setState({ form: make(), version, ready, touched: false });
  }
  const edit = useCallback((fn: (form: F) => F) => setState((s) => ({ ...s, form: fn(s.form), touched: true })), []);
  const reset = () => setState({ form: make(), version, ready, touched: false });
  const markSaved = useCallback(() => setState((s) => ({ ...s, touched: false })), []);
  return { form: state.form, edit, reset, markSaved, touched: state.touched };
}

const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'time',
]);

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * On touch devices, while a text field has focus: <html data-typing> (the tab bar and the
 * Write button step aside, save bars sit on the keyboard) and --omw-kb = the height of the
 * layout viewport the on-screen keyboard covers (VisualViewport). See app.css.
 */
export function useTypingState(): void {
  useEffect(() => {
    const root = document.documentElement;
    const coarse = window.matchMedia?.('(pointer: coarse)');
    const vv = window.visualViewport;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      // After focus moved (focusout fires before the next field's focusin).
      frame = requestAnimationFrame(() => {
        const typing = !!coarse?.matches && isTextEntry(document.activeElement);
        if (typing) root.setAttribute('data-typing', '');
        else root.removeAttribute('data-typing');
        const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
        root.style.setProperty('--omw-kb', `${Math.round(typing ? covered : 0)}px`);
      });
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      root.removeAttribute('data-typing');
      root.style.removeProperty('--omw-kb');
    };
  }, []);
}
