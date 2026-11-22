/**
 * People, devices, lock, store, privacy notice and owner notices of the mock admin API
 * (spec-wave5 §3.3/§3.5/§3.12), strict like the rest of the mock: bodies validated with the
 * contract schemas, responses checked by the caller (MockAdminApi.#out).
 *
 * The site store is simulated: with writer mode "direct"/"sftp" every action is applied at once
 * (effect.applied), with "none" (the Mac writes) its ops stay pending until `ack()`. Test control:
 * setState() (writer mode, store, gate check, …), addDevice() (a join), addNotice(), ack().
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  type AccessStatus,
  type AccessSummary,
  type AdminDevice,
  type AdminFollower,
  type Effect,
  FollowerCreate,
  type FollowerDataExport,
  FollowerDeleteRequest,
  FollowerPatch,
  type FollowerTombstone,
  type GateCheckResult,
  LockRequest,
  NoticeReadRequest,
  type OwnerNotice,
  PrivacyNotice,
  PrivacyNoticeDraft,
  PrivacyPublishRequest,
  type PrivacyState,
  type PublicNotice,
  type StoreReport,
} from '@omw/contracts/access';
import { PasswordChange } from '@omw/contracts/api';
import type { LocaleCode } from '@omw/contracts/i18n';
import type { z } from 'zod';
import { type SeedAccess, seedAccess } from './seed';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
export const MOCK_SITE_ORIGIN = 'https://site.example.org';
export const MOCK_MAX_DEVICES = 5;

interface MDevice {
  id: string;
  state: AdminDevice['state'];
  first: boolean;
  label: string;
  createdAt: string;
  decidedAt: string | null;
  revokedAt: string | null;
  revokedBy: AdminDevice['revokedBy'];
  lastSeenAt: string | null;
  sessionAt: string | null;
}

interface MConsent {
  version: number;
  confirmedAt: string;
  locale: LocaleCode;
}

interface MFollower {
  id: string;
  state: 'active' | 'revoked' | 'deleted';
  name: string | null;
  note: string | null;
  linkCreatedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  deletedAt: string | null;
  deletedBy: FollowerTombstone['deletedBy'] | null;
  devices: MDevice[];
  consents: MConsent[];
}

interface MVersion {
  version: number;
  notice: z.infer<typeof PrivacyNotice>;
  sha256: string;
  publishedAt: string;
}

export interface MockAccessState {
  siteOrigin: string | null;
  writerMode: 'direct' | 'sftp' | 'none';
  writerBlocked: boolean;
  writerError: string | null;
  storeId: string | null;
  locked: boolean;
  lockedAt: string | null;
  lockedBy: 'admin' | 'panic' | 'mac' | null;
  unlockedAt: string | null;
  panicLink: boolean;
  pendingOps: number;
  oldestPendingOpAt: string | null;
  lastAppliedAt: string | null;
  restoring: boolean;
  mismatch: boolean;
  lastReconcile: StoreReport | null;
  storeProofAt: string | null;
  gateCheck: GateCheckResult | null;
}

export interface AccessReply {
  status: number;
  json?: unknown;
  error?: { code: string; message: string; details?: unknown };
  /** Contract output schema name for the caller's response check. */
  schema?: string;
}

type Body = unknown;

const TEMPLATE: Record<'de' | 'en', z.infer<typeof PrivacyNotice>['texts'][LocaleCode]> = {
  de: {
    title: 'Datenschutzhinweise',
    intro:
      'Diese Seite zeigt Reiseerlebnisse nur Menschen, die persönlich eingeladen wurden. Bevor du beitrittst, erklären wir kurz, was dabei gespeichert wird.',
    collected:
      'Unter einer zufälligen Kennung, die nur für dich angelegt wurde, speichern wir: den Namen, den die einladende Person für dich eingetragen hat; für jedes Gerät, mit dem du beitrittst, Gerätetyp und Browser (z. B. „iPhone · Safari“), wann es beigetreten ist und wann es die Seite zuletzt geöffnet hat; wann du welche Version dieser Hinweise bestätigt hast.\n\nAuf deinem Gerät speichern wir nur Cookies, die für den Zugang nötig sind: eine Sitzung, einen Geräteschlüssel und beim Beitreten kurzlebige Hilfs-Cookies. Der Webhoster protokolliert technisch bedingt IP-Adressen in Server-Logs.',
    audience:
      'Die einladende Person sieht deinen Namen, deine Geräte und wann sie zuletzt genutzt wurden. Andere eingeladene Personen sehen nichts davon.',
    purpose:
      'Die Daten dienen nur dazu, die Seite ausschließlich eingeladenen Personen zu zeigen, neue Geräte freizugeben und Missbrauch wie weitergeleitete Links zu erkennen.',
    retention:
      'Die Daten bleiben gespeichert, solange du eingeladen bist, und auch nachdem dein Zugang beendet wurde, bis du oder die einladende Person sie löscht. Sicherungskopien auf dem Server werden nach höchstens 14 Tagen überschrieben; heruntergeladene Sicherungskopien löscht die einladende Person spätestens nach derselben Frist.',
    rights:
      'Du kannst jederzeit Auskunft verlangen, deine Daten exportieren, berichtigen und löschen lassen. Du kannst dich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren.',
  },
  en: {
    title: 'Privacy information',
    intro:
      'This page shows travel moments only to people who were personally invited. Before you join, here is what is stored.',
    collected:
      'Under a random identifier created just for you, we store: the name the person who invited you entered for you; for each device you join with, its type and browser (e.g. "iPhone · Safari"), when it joined and when it last opened the page; when you confirmed which version of this information.\n\nYour device keeps only cookies that are needed for access: a session, a device key and, while joining, short-lived helper cookies. For technical reasons the web host logs IP addresses in its server logs.',
    audience:
      'The person who invited you sees your name, your devices and when they were last used. Other invited people see none of this.',
    purpose:
      'The data is used only to show the page to invited people, to approve new devices and to notice misuse such as forwarded links.',
    retention:
      'The data is kept while you are invited and also after your access has ended, until you or the person who invited you deletes it. Backups on the server are overwritten after at most 14 days; the person who invited you deletes downloaded backup copies within the same period.',
    rights:
      'You can ask what is stored, export it, have it corrected and deleted at any time. You can also complain to a data protection authority.',
  },
};

const TEXT_KEYS = ['title', 'intro', 'collected', 'audience', 'purpose', 'retention', 'rights'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function randomB32(n: number): string {
  return [...randomBytes(n)].map((b) => B32[b % 32]).join('');
}

const err = (status: number, code: string, message: string, details?: unknown): AccessReply => ({
  status,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

export class MockAccess {
  readonly now: () => number;
  state!: MockAccessState;
  #followers = new Map<string, MFollower>();
  #draft!: z.infer<typeof PrivacyNoticeDraft>;
  #versions: MVersion[] = [];
  #notices: Array<OwnerNotice & { data?: unknown }> = [];
  #nextNotice = 1;
  #siteLocales: () => readonly LocaleCode[];

  constructor(now: () => number, siteLocales: () => readonly LocaleCode[]) {
    this.now = now;
    this.#siteLocales = siteLocales;
    this.reset();
  }

  #iso(minutesAgo = 0): string {
    return new Date(this.now() - minutesAgo * 60_000).toISOString();
  }

  reset(seed: SeedAccess = seedAccess()): void {
    const now = this.#iso();
    this.state = {
      siteOrigin: MOCK_SITE_ORIGIN,
      writerMode: 'direct',
      writerBlocked: false,
      writerError: null,
      storeId: seed.storeReady ? 'a1b2c3d4e5f60718' : null,
      locked: false,
      lockedAt: null,
      lockedBy: null,
      unlockedAt: null,
      panicLink: false,
      pendingOps: 0,
      oldestPendingOpAt: null,
      lastAppliedAt: seed.storeReady ? this.#iso(30) : null,
      restoring: false,
      mismatch: false,
      lastReconcile: seed.storeReady
        ? { at: this.#iso(4), mode: 'normal', deleted: 0, missing: [], orphans: [], imported: [] }
        : null,
      storeProofAt: null,
      gateCheck: seed.storeReady ? { at: this.#iso(50), by: 'mac', result: 'ok', detail: null } : null,
    };
    this.#draft = {
      controller: seed.noticePublished ? { name: 'Lena Beispiel', email: 'lena@example.org' } : { name: '', email: '' },
      texts: { de: { ...TEMPLATE.de }, en: { ...TEMPLATE.en } },
    };
    this.#versions = [];
    if (seed.noticePublished) {
      const notice = PrivacyNotice.parse(this.#draft);
      this.#versions.push({ version: 1, notice, sha256: sha256(canonical(notice)), publishedAt: this.#iso(12 * 1440) });
    }
    this.#notices = [];
    this.#nextNotice = 1;
    this.#followers.clear();
    for (const f of seed.followers) {
      const createdAt = this.#iso(f.createdDaysAgo * 1440);
      if (f.state === 'deleted') {
        this.#followers.set(f.id, {
          id: f.id,
          state: 'deleted',
          name: null,
          note: null,
          linkCreatedAt: null,
          createdAt,
          revokedAt: null,
          deletedAt: createdAt,
          deletedBy: f.deletedBy ?? 'follower',
          devices: [],
          consents: [],
        });
        continue;
      }
      const revokedAt = f.state === 'revoked' ? this.#iso(2 * 1440) : null;
      this.#followers.set(f.id, {
        id: f.id,
        state: f.state,
        name: f.name,
        note: f.note,
        linkCreatedAt: f.state === 'active' ? createdAt : null,
        createdAt,
        revokedAt,
        deletedAt: null,
        deletedBy: null,
        devices: f.devices.map((d) => ({
          id: d.id,
          state: d.state,
          first: d.first,
          label: d.label,
          createdAt: this.#iso(d.createdMinutesAgo),
          decidedAt: d.first ? null : this.#iso(d.createdMinutesAgo - 5),
          revokedAt: d.state === 'revoked' ? revokedAt : null,
          revokedBy: d.state === 'revoked' ? (d.revokedBy ?? 'owner') : null,
          lastSeenAt: d.lastSeenMinutesAgo === null ? null : this.#iso(d.lastSeenMinutesAgo),
          sessionAt: d.state === 'active' ? this.#iso(d.createdMinutesAgo) : null,
        })),
        consents:
          seed.noticePublished && f.devices.length > 0 ? [{ version: 1, confirmedAt: createdAt, locale: 'de' }] : [],
      });
    }
    void now;
  }

  // -------------------------------------------------------------------------------------------
  // Test control

  setState(patch: Partial<MockAccessState> & { noticeVersions?: 0 }): void {
    const { noticeVersions, ...rest } = patch;
    this.state = { ...this.state, ...rest };
    if (noticeVersions === 0) {
      this.#versions = [];
      this.#draft = { ...this.#draft, controller: { name: '', email: '' } };
    }
  }

  /** A device joins (the public join flow): pending unless it is the person's first. */
  addDevice(fid: string, opts: { label?: string; minutesAgo?: number; state?: 'pending' | 'active' } = {}): string {
    const f = this.#followers.get(fid);
    if (f?.state !== 'active') throw new Error(`no active follower ${fid}`);
    const first = !f.devices.some((d) => d.state === 'active' || d.state === 'revoked');
    const state = opts.state ?? (first ? 'active' : 'pending');
    const id = randomB32(8);
    const at = this.#iso(opts.minutesAgo ?? 0);
    f.devices.push({
      id,
      state,
      first: state === 'active' && first,
      label: opts.label ?? 'iPhone · Safari',
      createdAt: at,
      decidedAt: null,
      revokedAt: null,
      revokedBy: null,
      lastSeenAt: state === 'active' ? at : null,
      sessionAt: state === 'active' ? at : null,
    });
    const v = this.#currentVersion();
    if (v && !f.consents.some((c) => c.version === v.version)) {
      f.consents.push({ version: v.version, confirmedAt: at, locale: 'de' });
    }
    return id;
  }

  addNotice(kind: OwnerNotice['kind'], data?: unknown): number {
    const id = this.#nextNotice++;
    this.#notices.push({ id, kind, createdAt: this.#iso(), readAt: null, ...(data !== undefined ? { data } : {}) });
    return id;
  }

  /** The Mac applied everything (ack). */
  ack(): void {
    this.state = { ...this.state, pendingOps: 0, oldestPendingOpAt: null, lastAppliedAt: this.#iso() };
  }

  snapshot() {
    return {
      state: this.state,
      followers: [...this.#followers.values()],
      versions: this.#versions.map((v) => ({ version: v.version, sha256: v.sha256, publishedAt: v.publishedAt })),
      notices: this.#notices,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Views

  #summary(): AccessSummary {
    const s = this.state;
    let pending = 0;
    for (const f of this.#followers.values()) {
      if (f.state === 'active') pending += f.devices.filter((d) => d.state === 'pending').length;
    }
    return {
      locked: s.locked,
      lockedAt: s.lockedAt,
      lockedBy: s.lockedBy,
      pendingDevices: pending,
      pendingOps: s.pendingOps,
      oldestPendingOpAt: s.oldestPendingOpAt,
      writer: { mode: s.writerMode, blocked: s.writerBlocked, error: s.writerError },
      restoring: s.restoring,
      mismatch: s.mismatch,
      unreadNotices: this.#notices.filter((n) => n.readAt === null).length,
      noticeVersion: this.#currentVersion()?.version ?? null,
    };
  }

  summary(): AccessSummary {
    return this.#summary();
  }

  #status(): AccessStatus {
    const s = this.state;
    const pending: AccessStatus['pending'] = [];
    for (const f of this.#followers.values()) {
      if (f.state !== 'active' || !f.name) continue;
      for (const d of f.devices) {
        if (d.state === 'pending')
          pending.push({ did: d.id, fid: f.id, name: f.name, label: d.label, createdAt: d.createdAt });
      }
    }
    pending.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return {
      ...this.#summary(),
      panicLink: s.panicLink,
      siteOrigin: s.siteOrigin,
      cookieMode: 'headers',
      lastReconcile: s.lastReconcile,
      lastAppliedAt: s.lastAppliedAt,
      storeId: s.storeId,
      storeProofAt: s.storeProofAt,
      gateCheck: s.gateCheck,
      pending: pending.slice(0, 3),
    };
  }

  #device(d: MDevice): AdminDevice {
    return { ...d };
  }

  #follower(f: MFollower): AdminFollower {
    if (f.state === 'deleted' || f.name === null) throw new Error('tombstone has no view');
    const latest = [...f.consents].sort((a, b) => b.version - a.version)[0] ?? null;
    const seen =
      f.devices
        .map((d) => d.lastSeenAt)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1) ?? null;
    return {
      id: f.id,
      name: f.name,
      note: f.note,
      state: f.state,
      createdAt: f.createdAt,
      revokedAt: f.revokedAt,
      link: f.linkCreatedAt ? { createdAt: f.linkCreatedAt } : null,
      devices: f.devices.map((d) => this.#device(d)),
      consent: latest ? { version: latest.version, confirmedAt: latest.confirmedAt } : null,
      lastSeenAt: seen,
    };
  }

  #currentVersion(): MVersion | undefined {
    return this.#versions.at(-1);
  }

  /** ops: how many store ops the action enqueues (applied at once unless the Mac writes). */
  #effect(ops: number): Effect {
    const s = this.state;
    if (ops === 0)
      return { applied: true, via: s.writerMode === 'none' ? 'mac' : s.writerMode, pendingOps: s.pendingOps };
    if (s.writerMode === 'none' || s.writerBlocked) {
      this.state = {
        ...s,
        pendingOps: s.pendingOps + ops,
        oldestPendingOpAt: s.oldestPendingOpAt ?? this.#iso(),
      };
      return { applied: false, via: 'pending', pendingOps: this.state.pendingOps };
    }
    this.state = { ...s, lastAppliedAt: this.#iso() };
    return { applied: true, via: s.writerMode, pendingOps: 0 };
  }

  #privacyState(): PrivacyState {
    const current = this.#currentVersion();
    const publicNotice: PublicNotice | null = current
      ? { ...current.notice, version: current.version, publishedAt: current.publishedAt }
      : null;
    return {
      draft: this.#draft,
      draftSha256: sha256(canonical(this.#draft)),
      current: publicNotice,
      versions: this.#versions.map((v) => ({ version: v.version, publishedAt: v.publishedAt, sha256: v.sha256 })),
      problems: this.#problems(),
    };
  }

  #problems(): string[] {
    const out: string[] = [];
    const d = this.#draft;
    if (!d.controller.name.trim()) out.push('controller.name is empty');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.controller.email.trim()))
      out.push('controller.email is not an e-mail address');
    const locales = new Set<LocaleCode>(['de', 'en', ...this.#siteLocales()]);
    for (const l of locales) {
      for (const k of TEXT_KEYS) {
        if (!(d.texts[l]?.[k] ?? '').trim()) out.push(`texts.${l}.${k} is empty`);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Routes (below /api/v1/admin)

  route(
    method: string,
    segs: string[],
    body: Body,
    ctx: { ownerPassword: string; ownerEmail: string },
  ): AccessReply | null {
    const [resource, id, extra] = segs;
    switch (resource) {
      case 'followers':
        return this.#followersRoute(method, id, extra, body);
      case 'devices':
        return this.#devicesRoute(method, id, extra);
      case 'access':
        return this.#accessRoute(method, id, body, ctx);
      case 'privacy':
        return this.#privacyRoute(method, id, body);
      case 'notices':
        return this.#noticesRoute(method, id, body);
      default:
        return null;
    }
  }

  /** PUT /me/password (handled with the owner's session store by MockAdminApi). */
  changePassword(
    body: Body,
    ctx: { ownerPassword: string; ownerEmail: string },
  ): AccessReply & { newPassword?: string; revokeAppTokens?: boolean } {
    const parsed = PasswordChange.safeParse(body);
    if (!parsed.success) return err(422, 'validation_failed', parsed.error.issues.map((i) => i.message).join('; '));
    const p = parsed.data;
    if (p.currentPassword !== ctx.ownerPassword) return err(403, 'wrong_password', 'The current password is not right');
    if (p.newPassword === p.currentPassword)
      return err(422, 'validation_failed', 'The new password equals the current one.');
    if (p.newPassword.toLowerCase() === ctx.ownerEmail.toLowerCase()) {
      return err(422, 'validation_failed', 'The new password must not be the e-mail address.');
    }
    return { status: 204, newPassword: p.newPassword, revokeAppTokens: p.revokeAppTokens };
  }

  #followersRoute(method: string, fid: string | undefined, extra: string | undefined, body: Body): AccessReply {
    if (!fid) {
      if (method === 'GET') {
        const persons = [...this.#followers.values()];
        const items = persons
          .filter((f) => f.state !== 'deleted')
          .sort((a, b) => (a.state !== b.state ? (a.state === 'active' ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1))
          .map((f) => this.#follower(f));
        const tombstones = persons
          .filter((f) => f.state === 'deleted')
          .sort((a, b) => ((a.deletedAt ?? '') < (b.deletedAt ?? '') ? 1 : -1))
          .map((f) => ({
            id: f.id,
            state: 'deleted' as const,
            deletedAt: f.deletedAt ?? '',
            deletedBy: f.deletedBy ?? 'owner',
          }));
        return { status: 200, json: { items, tombstones }, schema: 'FollowerListResponse' };
      }
      if (method !== 'POST') return err(405, 'method_not_allowed', 'GET or POST');
      const parsed = FollowerCreate.safeParse(body);
      if (!parsed.success) return err(422, 'validation_failed', parsed.error.issues.map((i) => i.message).join('; '));
      if (!this.state.siteOrigin) return err(409, 'config_missing', 'SITE_ORIGIN is not configured');
      let id = randomB32(12);
      while (this.#followers.has(id)) id = randomB32(12);
      const at = this.#iso();
      const f: MFollower = {
        id,
        state: 'active',
        name: parsed.data.name,
        note: parsed.data.note ?? null,
        linkCreatedAt: at,
        createdAt: at,
        revokedAt: null,
        deletedAt: null,
        deletedBy: null,
        devices: [],
        consents: [],
      };
      this.#followers.set(id, f);
      const link = {
        url: `${this.state.siteOrigin}/_/join/#t=${randomBytes(32).toString('base64url')}`,
        createdAt: at,
      };
      return { status: 201, json: { follower: this.#follower(f), link }, schema: 'FollowerCreated' };
    }
    const f = this.#followers.get(fid);
    if (!f || f.state === 'deleted') return err(404, 'not_found', 'Unknown person');
    if (!extra) {
      if (method === 'GET') return { status: 200, json: this.#follower(f), schema: 'AdminFollower' };
      if (method !== 'PATCH') return err(405, 'method_not_allowed', 'GET or PATCH');
      const parsed = FollowerPatch.safeParse(body);
      if (!parsed.success) return err(422, 'validation_failed', parsed.error.issues.map((i) => i.message).join('; '));
      if (parsed.data.name !== undefined) f.name = parsed.data.name;
      if (parsed.data.note !== undefined) f.note = parsed.data.note;
      return { status: 200, json: this.#follower(f), schema: 'AdminFollower' };
    }
    switch (`${method} ${extra}`) {
      case 'POST link': {
        if (f.state !== 'active') return err(409, 'conflict', 'Access ended');
        const at = this.#iso();
        f.linkCreatedAt = at;
        const link = {
          url: `${this.state.siteOrigin}/_/join/#t=${randomBytes(32).toString('base64url')}`,
          createdAt: at,
        };
        return { status: 200, json: { link }, schema: 'PersonalLinkCreated' };
      }
      case 'POST revoke': {
        let ops = 0;
        if (f.state === 'active') {
          const at = this.#iso();
          f.state = 'revoked';
          f.revokedAt = at;
          f.linkCreatedAt = null;
          for (const d of f.devices) {
            if (d.state === 'pending') {
              d.state = 'declined';
              d.decidedAt = at;
            } else if (d.state === 'active') {
              d.state = 'revoked';
              d.revokedAt = at;
              d.revokedBy = 'owner';
              d.sessionAt = null;
            }
          }
          ops = 2 + f.devices.length;
        }
        const effect = this.#effect(ops);
        return {
          status: 200,
          json: { effect, follower: this.#follower(f), status: this.#summary() },
          schema: 'AccessActionResult',
        };
      }
      case 'GET export':
        return { status: 200, json: this.#export(f), schema: 'FollowerDataExport' };
      case 'POST delete': {
        const parsed = FollowerDeleteRequest.safeParse(body);
        if (!parsed.success) return err(422, 'validation_failed', 'confirm must be true');
        const ops = 2 + f.devices.length;
        this.#erase(f, 'owner');
        return {
          status: 200,
          json: { effect: this.#effect(ops), status: this.#summary() },
          schema: 'AccessActionResult',
        };
      }
      default:
        return err(404, 'not_found', `No route ${method} followers/${fid}/${extra}`);
    }
  }

  #erase(f: MFollower, by: 'owner' | 'follower'): void {
    const at = this.#iso();
    f.state = 'deleted';
    f.name = null;
    f.note = null;
    f.linkCreatedAt = null;
    f.revokedAt = null;
    f.createdAt = at;
    f.deletedAt = at;
    f.deletedBy = by;
    f.devices = [];
    f.consents = [];
    if (by === 'follower') this.addNotice('follower_deleted', { at });
  }

  /** The follower deletes themselves (public me/delete), for tests of the tombstone + notice. */
  selfDelete(fid: string): boolean {
    const f = this.#followers.get(fid);
    if (!f || f.state === 'deleted') return false;
    this.#erase(f, 'follower');
    return true;
  }

  #export(f: MFollower): FollowerDataExport {
    const view = this.#follower(f);
    return {
      format: 'omw-follower-data/1',
      exportedAt: this.#iso(),
      follower: {
        id: f.id,
        name: view.name,
        since: f.createdAt,
        state: view.state,
        linkCreatedAt: f.linkCreatedAt,
        revokedAt: f.revokedAt,
      },
      devices: f.devices.map((d) => ({
        id: d.id,
        label: d.label,
        state: d.state,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        decidedAt: d.decidedAt,
        revokedAt: d.revokedAt,
        revokedBy: d.revokedBy,
      })),
      consents: f.consents.flatMap((c) => {
        const v = this.#versions.find((x) => x.version === c.version);
        return v ? [{ ...c, notice: v.notice }] : [];
      }),
      categories: [
        { key: 'devices', count: f.devices.length },
        { key: 'consents', count: f.consents.length },
      ],
    };
  }

  #findDevice(did: string): { f: MFollower; d: MDevice } | null {
    for (const f of this.#followers.values()) {
      const d = f.devices.find((x) => x.id === did);
      if (d) return { f, d };
    }
    return null;
  }

  #devicesRoute(method: string, did: string | undefined, extra: string | undefined): AccessReply {
    if (!did || method !== 'POST') return err(405, 'method_not_allowed', 'POST only');
    const found = this.#findDevice(did);
    if (!found || found.f.state === 'deleted') return err(404, 'not_found', 'Unknown device');
    const { f, d } = found;
    const at = this.#iso();
    let ops = 0;
    switch (extra) {
      case 'approve':
        if (this.state.restoring) return err(409, 'restoring', 'Access is being checked after a restore');
        if (d.state === 'pending') {
          if (f.devices.filter((x) => x.state === 'active').length >= MOCK_MAX_DEVICES) {
            return err(409, 'device_limit', `At most ${MOCK_MAX_DEVICES} active devices`);
          }
          d.state = 'active';
          d.decidedAt = at;
        }
        break;
      case 'decline':
        if (d.state === 'pending') {
          d.state = 'declined';
          d.decidedAt = at;
        }
        break;
      case 'revoke':
        if (d.state === 'active') {
          d.state = 'revoked';
          d.revokedAt = at;
          d.revokedBy = 'owner';
          d.sessionAt = null;
          ops = 3;
        }
        break;
      default:
        return err(404, 'not_found', `No route devices/${did}/${extra}`);
    }
    return {
      status: 200,
      json: {
        effect: this.#effect(ops),
        device: this.#device(d),
        follower: this.#follower(f),
        status: this.#summary(),
      },
      schema: 'AccessActionResult',
    };
  }

  #accessRoute(method: string, sub: string | undefined, body: Body, ctx: { ownerPassword: string }): AccessReply {
    if (!sub) {
      if (method !== 'GET') return err(405, 'method_not_allowed', 'GET only');
      return { status: 200, json: this.#status(), schema: 'AccessStatus' };
    }
    switch (`${method} ${sub}`) {
      case 'POST lock': {
        const parsed = LockRequest.safeParse(body);
        if (!parsed.success) return err(422, 'validation_failed', 'Bad lock request');
        let ops = 0;
        if (parsed.data.locked) {
          if (!this.state.locked) {
            this.state = { ...this.state, locked: true, lockedAt: this.#iso(), lockedBy: 'admin' };
            ops = 1;
          }
        } else {
          if (parsed.data.password !== ctx.ownerPassword) return err(403, 'forbidden', 'Wrong password');
          if (this.state.locked) {
            this.state = { ...this.state, locked: false, lockedAt: null, lockedBy: null, unlockedAt: this.#iso() };
            ops = 1;
          }
        }
        return {
          status: 200,
          json: { effect: this.#effect(ops), status: this.#summary() },
          schema: 'AccessActionResult',
        };
      }
      case 'POST retry': {
        this.state = { ...this.state, writerBlocked: false, writerError: null };
        if (this.state.writerMode !== 'none') this.ack();
        return { status: 200, json: this.#status(), schema: 'AccessStatus' };
      }
      case 'POST store-init': {
        if (!this.state.storeId) this.state = { ...this.state, storeId: randomBytes(8).toString('hex') };
        return {
          status: 200,
          json: { effect: this.#effect(1), status: this.#summary() },
          schema: 'AccessActionResult',
        };
      }
      case 'POST panic-link': {
        if (!this.state.siteOrigin) return err(409, 'config_missing', 'SITE_ORIGIN is not configured');
        this.state = { ...this.state, panicLink: true };
        return {
          status: 200,
          json: { url: `${this.state.siteOrigin}/_/panic/#k=${randomBytes(32).toString('base64url')}` },
          schema: 'PanicLinkCreated',
        };
      }
      case 'DELETE panic-link':
        this.state = { ...this.state, panicLink: false };
        return { status: 204 };
      default:
        return err(404, 'not_found', `No route ${method} access/${sub}`);
    }
  }

  #privacyRoute(method: string, sub: string | undefined, body: Body): AccessReply {
    if (!sub && method === 'GET') return { status: 200, json: this.#privacyState(), schema: 'PrivacyState' };
    if (sub === 'draft' && method === 'PUT') {
      const parsed = PrivacyNoticeDraft.safeParse(body);
      if (!parsed.success) return err(422, 'validation_failed', parsed.error.issues.map((i) => i.message).join('; '));
      this.#draft = parsed.data;
      return { status: 200, json: this.#privacyState(), schema: 'PrivacyState' };
    }
    if (sub === 'publish' && method === 'POST') {
      const parsed = PrivacyPublishRequest.safeParse(body);
      if (!parsed.success) return err(422, 'validation_failed', 'ifDraftSha256 missing');
      if (parsed.data.ifDraftSha256 !== sha256(canonical(this.#draft))) {
        return err(409, 'conflict', 'The draft changed in the meantime');
      }
      const problems = this.#problems();
      const notice = PrivacyNotice.safeParse(this.#draft);
      if (problems.length > 0 || !notice.success)
        return err(422, 'notice_incomplete', 'The notice is incomplete', problems);
      const version = (this.#currentVersion()?.version ?? 0) + 1;
      this.#versions.push({
        version,
        notice: notice.data,
        sha256: sha256(canonical(notice.data)),
        publishedAt: this.#iso(),
      });
      return { status: 200, json: this.#privacyState(), schema: 'PrivacyState' };
    }
    return err(404, 'not_found', `No route ${method} privacy/${sub ?? ''}`);
  }

  #noticesRoute(method: string, sub: string | undefined, body: Body): AccessReply {
    if (!sub && method === 'GET') {
      const items = this.#notices.map(({ data: _d, ...n }) => n).sort((a, b) => b.id - a.id);
      return { status: 200, json: { items }, schema: 'OwnerNoticeList' };
    }
    if (sub === 'read' && method === 'POST') {
      const parsed = NoticeReadRequest.safeParse(body);
      if (!parsed.success) return err(422, 'validation_failed', 'ids missing');
      const at = this.#iso();
      for (const n of this.#notices) if (parsed.data.ids.includes(n.id)) n.readAt ??= at;
      return { status: 204 };
    }
    return err(404, 'not_found', `No route ${method} notices/${sub ?? ''}`);
  }
}
