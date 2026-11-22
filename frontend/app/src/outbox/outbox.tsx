/**
 * OutboxProvider: the app's outbox as React state, on top of the folders (fs-store), the index
 * (index-db), the state machine (core/outbox-machine) and the native uploader (omw-native).
 *
 * - Every change goes through apply(): transition -> durable manifest write -> index -> state ->
 *   effects. Writes per entry are serialized; exports run one at a time.
 * - Entries are keyed by their folder id (entryId); the uploader and the API know them by their
 *   wire id (wireIdOf), which changes after Undo and "Try again". Withdrawals of old wire ids stay
 *   in the manifest until Uploader.withdraw has them (it then sends the DELETE durably); a
 *   discard hands them over before the folder goes.
 * - share() resolves only after every manifest is on disk in phase "preparing": that is when the
 *   UI may say "Shared ✓" (CONFIRM haptic).
 * - On every start and every return to the foreground it reconciles: folders -> index, resumes
 *   "preparing" exports, re-enqueues "prepared" entries, asks the uploader for its job states, and
 *   (paired, gently throttled) the API for entries the home computer may have archived.
 */
import type { AppEntryKind, AppText } from '@omw/contracts/app';
import { getRandomBytes } from 'expo-crypto';
import { getCalendars } from 'expo-localization';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  DEFAULT_UPLOAD_SETTINGS,
  Network,
  type NetworkState,
  OFFLINE,
  TokenVault,
  Uploader,
  type UploadNowOptions,
  type UploadSettings,
  type UploadStatus,
} from '../../modules/omw-native';
import { AppApiError, apiBaseUrl, fetchEntryStates, fetchHints } from '../api/client';
import {
  deriveStatus,
  type EntryStatusView,
  newDraft,
  type OutboxChoice,
  type OutboxEffect,
  type OutboxEvent,
  type OutboxManifest,
  type OutboxSource,
  type StatusContext,
  transition,
  uploaderResumed,
  wireIdOf,
} from '../core/outbox-machine';
import { monotonicUlid } from '../core/ulid';
import { useAppSettings } from '../state/app-settings';
import {
  deleteEntryDir,
  ensureEntryDir,
  entryFile,
  importIntoEntry,
  listEntryIds,
  readManifest,
  writeManifest,
} from './fs-store';
import { loadIndex, rebuildIndex, removeFromIndex, upsertIndex } from './index-db';
import { prepareEntry } from './prepare';

const nextUlid = monotonicUlid((n) => getRandomBytes(n));

export function deviceTimeZone(): string {
  try {
    return getCalendars()[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/dng': 'dng',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
};

export type DraftInput =
  | {
      kind: 'photo' | 'video';
      origin: 'camera' | 'gallery';
      uri: string;
      how: 'move' | 'copy';
      mimetype: string;
      width?: number;
      height?: number;
      durationMs?: number;
      takenOn?: string | null;
    }
  | { kind: 'voice'; uri: string; durationMs: number }
  | { kind: 'text'; text: AppText };

export interface OutboxApi {
  ready: boolean;
  /** Newest first. */
  entries: OutboxManifest[];
  get(entryId: string): OutboxManifest | undefined;
  statusOf(m: OutboxManifest): EntryStatusView | null;
  statusContext: StatusContext;
  uploadSettings: UploadSettings | null;
  setUploadSettings(patch: Partial<UploadSettings>): Promise<void>;
  network: NetworkState;
  paired: boolean;
  setPaired(paired: boolean): void;
  createDraft(input: DraftInput): Promise<string>;
  edit(entryId: string, patch: Extract<OutboxEvent, { type: 'edit' }>['patch']): Promise<void>;
  /** Durable before it resolves (then say "Shared ✓"). Order of ids = posting order. */
  share(entryIds: readonly string[], choices?: Readonly<Record<string, OutboxChoice>>): Promise<void>;
  undo(entryIds: readonly string[]): Promise<void>;
  retry(entryId: string): Promise<void>;
  discard(entryId: string): Promise<void>;
  uploadNow(options?: UploadNowOptions): Promise<number>;
  /** Native job states + (throttled) server states. */
  refresh(options?: { server?: boolean }): Promise<void>;
  /** The last share, for the send flight on Today. */
  lastShared: { ids: string[]; at: number } | null;
  fileUri(entryId: string, name: string): string;
}

/** Exported for component tests (a fake OutboxApi); screens use useOutbox(). */
export const OutboxContext = createContext<OutboxApi | null>(null);

export function useOutbox(): OutboxApi {
  const ctx = useContext(OutboxContext);
  if (!ctx) throw new Error('useOutbox outside OutboxProvider');
  return ctx;
}

/** Hands withdrawals to the native uploader (durable there); throws when it can't take them. */
async function handWithdrawals(ids: readonly string[]): Promise<void> {
  for (const id of ids) await Uploader.withdraw(id);
}

function sortNewestFirst(list: OutboxManifest[]): OutboxManifest[] {
  return [...list].sort((a, b) => (a.entryId < b.entryId ? 1 : -1));
}

/** A folder without a manifest (a crash while a draft was being made): keep what is there. */
function recoverOrphan(entryId: string, now: string): OutboxManifest | null {
  const candidates: { name: string; kind: AppEntryKind; mimetype: string }[] = [
    ...Object.entries(EXTENSIONS).map(([mimetype, ext]) => ({
      name: `source.${ext}`,
      kind: (mimetype.startsWith('video/') ? 'video' : 'photo') as AppEntryKind,
      mimetype,
    })),
    { name: 'media.m4a', kind: 'voice', mimetype: 'audio/mp4' },
  ];
  for (const c of candidates) {
    const file = entryFile(entryId, c.name);
    if (file.exists && (file.size ?? 0) > 0) {
      return newDraft({
        entryId,
        kind: c.kind,
        origin: c.kind === 'voice' ? 'voice' : 'camera',
        now,
        source: { name: c.name, mimetype: c.mimetype, bytes: file.size ?? 0 },
      });
    }
  }
  return null;
}

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { settings: appSettings, update: updateAppSettings } = useAppSettings();
  const [entries, setEntries] = useState<Record<string, OutboxManifest>>({});
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const [ready, setReady] = useState(false);
  const [uploadSettings, setUploadSettingsState] = useState<UploadSettings | null>(null);
  const [network, setNetwork] = useState<NetworkState>(OFFLINE);
  const [paired, setPaired] = useState(false);
  const pairedRef = useRef(paired);
  pairedRef.current = paired;
  const [progress, setProgress] = useState<Record<string, { sent: number; total: number }>>({});
  const [lastShared, setLastShared] = useState<{ ids: string[]; at: number } | null>(null);
  const chains = useRef(new Map<string, Promise<unknown>>());
  const exportChain = useRef<Promise<unknown>>(Promise.resolve());
  const lastServerCheck = useRef(0);

  const put = useCallback((m: OutboxManifest) => {
    entriesRef.current = { ...entriesRef.current, [m.entryId]: m };
    setEntries(entriesRef.current);
    void upsertIndex(m).catch(() => {});
  }, []);

  const drop = useCallback((entryId: string) => {
    const { [entryId]: _gone, ...rest } = entriesRef.current;
    entriesRef.current = rest;
    setEntries(rest);
    void removeFromIndex(entryId).catch(() => {});
  }, []);

  /** Serializes work per entry. */
  const serial = useCallback(<T,>(entryId: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.current.get(entryId) ?? Promise.resolve();
    const next = prev.then(task, task);
    chains.current.set(
      entryId,
      next.catch(() => {}),
    );
    return next;
  }, []);

  const apply = useCallback(
    (entryId: string, event: OutboxEvent): Promise<OutboxManifest> =>
      serial(entryId, async () => {
        const current = entriesRef.current[entryId] ?? readManifest(entryId);
        if (!current) throw new Error(`Unknown entry ${entryId}`);
        const { next, effects } = transition(current, event, new Date().toISOString());
        if (effects.some((e) => e.type === 'delete_folder')) {
          // The folder holds the withdrawals until the uploader has them: hand them over first.
          for (const e of effects) if (e.type === 'withdraw') await handWithdrawals(e.ids);
          deleteEntryDir(entryId);
          drop(entryId);
          return next;
        }
        try {
          await writeManifest(next);
        } catch (e) {
          // Keep memory in step with the disk (the truth), whichever revision made it there.
          const disk = readManifest(entryId);
          if (disk) put(disk);
          throw e;
        }
        put(next);
        for (const effect of effects) void runEffect(next, effect);
        return next;
      }),
    [serial, put, drop],
  );

  const applyQuietly = useCallback(
    (entryId: string, event: OutboxEvent) => apply(entryId, event).catch(() => undefined),
    [apply],
  );

  const runEffect = async (m: OutboxManifest, effect: OutboxEffect): Promise<void> => {
    switch (effect.type) {
      case 'prepare': {
        const job = exportChain.current.then(async () => {
          const latest = entriesRef.current[m.entryId];
          if (latest?.phase !== 'preparing') return;
          const result = await prepareEntry(latest);
          if (result.ok) {
            await applyQuietly(m.entryId, {
              type: 'prepared',
              files: result.files,
              ...(result.media ? { media: result.media } : {}),
              entry: result.entry,
            });
          } else {
            await applyQuietly(m.entryId, { type: 'prepare_failed', error: result.error, wireId: wireIdOf(latest) });
          }
        });
        exportChain.current = job.catch(() => {});
        return;
      }
      case 'enqueue': {
        const latest = entriesRef.current[m.entryId] ?? m;
        // Undone meanwhile (a draft again): nothing to send.
        if (!latest.entry || latest.phase !== 'prepared') return;
        const wireId = wireIdOf(latest);
        try {
          await Uploader.enqueue({
            entryId: wireId,
            entry: latest.entry,
            files: latest.files.map((f) => ({ role: f.role, uri: entryFile(latest.entryId, f.name).uri })),
            ...(latest.choice.mode ? { mode: latest.choice.mode } : {}),
          });
          await applyQuietly(latest.entryId, { type: 'enqueued' });
          const [status] = await Uploader.status(wireId);
          if (status) await applyQuietly(latest.entryId, { type: 'upload', status });
        } catch (e) {
          const code = typeof e === 'object' && e && 'code' in e ? String((e as { code: unknown }).code) : 'enqueue';
          await applyQuietly(latest.entryId, {
            type: 'enqueue_failed',
            error: { code, message: e instanceof Error ? e.message : String(e), permanent: false },
          });
        }
        return;
      }
      case 'withdraw':
        try {
          await handWithdrawals(effect.ids);
          await applyQuietly(m.entryId, { type: 'withdrawals_handed', ids: effect.ids });
        } catch {
          // Stays in the manifest: the next reconcile (app start, back in the foreground) hands it over.
        }
        return;
      case 'delete_folder':
        return;
    }
  };

  const onUploadStatus = useCallback(
    (status: UploadStatus) => {
      // Statuses are keyed by wire id; an old one (after Undo or "Try again") matches nothing.
      const m = Object.values(entriesRef.current).find((x) => wireIdOf(x) === status.entryId);
      if (!m) return;
      // A failed entry comes back when the uploader resumed it (e.g. after pairing again).
      const resumed = uploaderResumed(m, status);
      if (m.phase !== 'enqueued' && m.phase !== 'uploaded' && m.phase !== 'prepared' && !resumed) return;
      const u = m.upload;
      const same =
        u &&
        u.state === status.state &&
        u.blockedBy === status.blockedBy &&
        u.sentBytes === status.sentBytes &&
        u.original?.state === status.original?.state &&
        u.original?.sentBytes === status.original?.sentBytes;
      if (same && !resumed) return;
      void applyQuietly(m.entryId, { type: 'upload', status });
    },
    [applyQuietly],
  );

  const refreshServer = useCallback(async () => {
    if (!pairedRef.current) return;
    const now = Date.now();
    if (now - lastServerCheck.current < 60_000) return;
    lastServerCheck.current = now;
    const token = await TokenVault.get().catch(() => null);
    if (!token) return;
    try {
      const hints = await fetchHints(token);
      updateAppSettings({
        hints: {
          archiveOnly: hints.archiveOnly,
          delayHours: hints.delayHours,
          backendLastSeenAt: hints.backendLastSeenAt,
          at: new Date().toISOString(),
        },
      });
      const byWire = new Map(
        Object.values(entriesRef.current)
          .filter((m) => m.phase === 'uploaded' || (m.phase === 'enqueued' && m.upload?.state === 'uploaded'))
          .map((m) => [wireIdOf(m), m.entryId]),
      );
      if (byWire.size === 0) return;
      const states = await fetchEntryStates(token, [...byWire.keys()]);
      for (const s of states) {
        const entryId = byWire.get(s.entryId);
        if (!entryId) continue;
        await applyQuietly(entryId, {
          type: 'server',
          server: {
            state: s.state,
            heldBack: s.heldBack,
            publish: s.publish,
            backendLastSeenAt: s.backendLastSeenAt,
            checkedAt: new Date().toISOString(),
          },
        });
      }
    } catch (e) {
      if (e instanceof AppApiError && (e.code === 'token_revoked' || e.code === 'unauthorized')) {
        // Revoked: forget the token and what the server told us; the outbox stays sealed here.
        await TokenVault.clear().catch(() => {});
        setPaired(false);
        updateAppSettings({ pairing: null, hints: null });
      }
    }
  }, [applyQuietly, updateAppSettings]);

  const reconcileNative = useCallback(async () => {
    const all = Object.values(entriesRef.current);
    for (const m of all) {
      if (m.withdrawals && m.withdrawals.length > 0) void runEffect(m, { type: 'withdraw', ids: m.withdrawals });
      if (m.phase === 'preparing') void runEffect(m, { type: 'prepare' });
      if (m.phase === 'prepared') void runEffect(m, { type: 'enqueue' });
    }
    const statuses = await Uploader.status().catch(() => [] as UploadStatus[]);
    for (const s of statuses) onUploadStatus(s);
  }, [onUploadStatus]);

  // Boot: index first (fast), then the folders (truth), then resume.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const indexed = await loadIndex();
      if (alive && indexed.length > 0) {
        entriesRef.current = Object.fromEntries(indexed.map((m) => [m.entryId, m]));
        setEntries(entriesRef.current);
      }
      const now = new Date().toISOString();
      const manifests: OutboxManifest[] = [];
      for (const id of listEntryIds()) {
        let m = readManifest(id);
        if (!m) {
          m = recoverOrphan(id, now);
          if (m) await writeManifest(m).catch(() => {});
        }
        if (m) manifests.push(m);
      }
      if (!alive) return;
      entriesRef.current = Object.fromEntries(manifests.map((m) => [m.entryId, m]));
      setEntries(entriesRef.current);
      void rebuildIndex(manifests).catch(() => {});
      // The uploader sends to the build's API base only (never a link's); stored natively, so
      // background runs know it without JS. Before any enqueue.
      await Uploader.configure({ apiBaseUrl: apiBaseUrl() }).catch(() => {});
      const [s, n, token] = await Promise.all([
        Uploader.getSettings().catch(() => ({ ...DEFAULT_UPLOAD_SETTINGS, roamingAllowedSims: [] })),
        Network.getState().catch(() => OFFLINE),
        TokenVault.get().catch(() => null),
      ]);
      if (!alive) return;
      setUploadSettingsState(s);
      setNetwork(n);
      setPaired(token !== null);
      pairedRef.current = token !== null;
      setReady(true);
      await reconcileNative();
      await refreshServer();
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const subs = [
      Network.addListener(setNetwork),
      Uploader.addStateListener(onUploadStatus),
      Uploader.addProgressListener((e) =>
        setProgress((prev) => ({ ...prev, [e.entryId]: { sent: e.sentBytes, total: e.totalBytes } })),
      ),
    ];
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reconcileNative();
        void refreshServer();
      }
    });
    return () => {
      for (const s of subs) s.remove();
      app.remove();
    };
  }, [onUploadStatus, reconcileNative, refreshServer]);

  const statusContext = useMemo<StatusContext>(
    () => ({
      settings: uploadSettings ?? DEFAULT_UPLOAD_SETTINGS,
      network,
      paired,
      archiveOnly: appSettings.hints?.archiveOnly ?? true,
      now: new Date().toISOString(),
    }),
    [uploadSettings, network, paired, appSettings.hints?.archiveOnly],
  );

  const statusOf = useCallback(
    (m: OutboxManifest) => {
      const view = deriveStatus(m, statusContext);
      const p = progress[wireIdOf(m)];
      if (view?.status === 'uploading' && p && p.total > 0) {
        return { ...view, percent: Math.min(100, Math.floor((p.sent / p.total) * 100)) };
      }
      return view;
    },
    [statusContext, progress],
  );

  const createDraft = useCallback(
    async (input: DraftInput): Promise<string> => {
      const entryId = nextUlid();
      const now = new Date().toISOString();
      ensureEntryDir(entryId);
      let m: OutboxManifest;
      if (input.kind === 'text') {
        m = newDraft({ entryId, kind: 'text', origin: 'text', now, text: input.text });
      } else if (input.kind === 'voice') {
        const { bytes } = await importIntoEntry(entryId, input.uri, 'media.m4a', 'move');
        const source: OutboxSource = { name: 'media.m4a', mimetype: 'audio/mp4', bytes, durationMs: input.durationMs };
        m = newDraft({ entryId, kind: 'voice', origin: 'voice', now, source });
      } else {
        const ext = EXTENSIONS[input.mimetype] ?? (input.kind === 'video' ? 'mp4' : 'jpg');
        const name = `source.${ext}`;
        const { bytes } = await importIntoEntry(entryId, input.uri, name, input.how);
        const source: OutboxSource = {
          name,
          mimetype: input.mimetype,
          bytes,
          ...(input.width ? { width: input.width } : {}),
          ...(input.height ? { height: input.height } : {}),
          ...(input.durationMs ? { durationMs: input.durationMs } : {}),
          ...(input.takenOn ? { takenOn: input.takenOn } : {}),
        };
        m = newDraft({ entryId, kind: input.kind, origin: input.origin, now, source });
      }
      await writeManifest(m);
      put(m);
      return entryId;
    },
    [put],
  );

  const api = useMemo<OutboxApi>(
    () => ({
      ready,
      entries: sortNewestFirst(Object.values(entries)),
      get: (id) => entries[id],
      statusOf,
      statusContext,
      uploadSettings,
      async setUploadSettings(patch) {
        setUploadSettingsState((prev) => (prev ? { ...prev, ...patch } : prev));
        const stored = await Uploader.setSettings(patch);
        setUploadSettingsState(stored);
      },
      network,
      paired,
      setPaired: (p) => {
        pairedRef.current = p;
        setPaired(p);
        if (p) {
          lastServerCheck.current = 0;
          void reconcileNative();
          void refreshServer();
        }
      },
      createDraft,
      async edit(entryId, patch) {
        await apply(entryId, { type: 'edit', patch });
      },
      async share(entryIds, choices) {
        const at = Date.now();
        const tz = deviceTimeZone();
        for (const [i, id] of entryIds.entries()) {
          const choice = choices?.[id];
          await apply(id, {
            type: 'share',
            at: new Date(at + i).toISOString(),
            tz,
            ...(choice ? { choice } : {}),
          });
        }
        setLastShared({ ids: [...entryIds], at });
      },
      async undo(entryIds) {
        for (const id of entryIds) await apply(id, { type: 'undo', freshId: nextUlid() }).catch(() => undefined);
      },
      async retry(entryId) {
        await apply(entryId, { type: 'retry', freshId: nextUlid() });
      },
      async discard(entryId) {
        await apply(entryId, { type: 'discard' });
      },
      async uploadNow(options = {}) {
        const n = await Uploader.uploadNow(options);
        await reconcileNative();
        return n;
      },
      async refresh(options = {}) {
        await reconcileNative();
        if (options.server) await refreshServer();
      },
      lastShared,
      fileUri: (entryId, name) => entryFile(entryId, name).uri,
    }),
    [
      ready,
      entries,
      statusOf,
      statusContext,
      uploadSettings,
      network,
      paired,
      createDraft,
      apply,
      reconcileNative,
      refreshServer,
      lastShared,
    ],
  );

  return <OutboxContext.Provider value={api}>{children}</OutboxContext.Provider>;
}
