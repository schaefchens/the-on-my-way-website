/**
 * Publish targets and deploy results (plan A5).
 *
 * Targets live in CONFIG_DIR/targets.json (StoredTarget, secrets included, mode 0600). Everything
 * that leaves the publisher (control UI, logs, events, CLI output) uses PublishTargetPublic, which
 * never contains a password, private key or passphrase.
 */
import { posix } from 'node:path';
import { z } from 'zod';
import { HOST_KEY_FINGERPRINT } from './hostkeys.js';

/** Target id: also the PublishedReport.target name (≤ 64 chars). */
export const TargetId = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, { message: 'Expected a lowercase id like "sftp-main"' });

export const HostKeyFingerprint = z
  .string()
  .regex(HOST_KEY_FINGERPRINT, { message: 'Expected an OpenSSH fingerprint "SHA256:…" (43 base64 chars)' });

/** http(s) URL of the published site root; normalized to end with "/". */
export const PublicBaseUrl = z
  .url({ protocol: /^https?$/ })
  .refine(
    (u) => {
      const url = URL.parse(u);
      return url !== null && !url.search && !url.hash;
    },
    { message: 'No query or fragment allowed' },
  )
  .transform((u) => (u.endsWith('/') ? u : `${u}/`));

/** Absolute POSIX directory on the server, normalized ("/", "/www", "/sites/omw"). */
export const RemoteRoot = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => p.startsWith('/'), { message: 'Must be an absolute path' })
  .refine((p) => !p.split('/').includes('..'), { message: 'Must not contain ".."' })
  .refine((p) => /^[A-Za-z0-9._~@+/-]+$/.test(p), { message: 'Unsupported characters' })
  .transform(normalizeRemoteRoot);

export function normalizeRemoteRoot(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, '') : '/';
}

const Label = z.string().trim().min(1).max(80);
const Secret = z
  .string()
  .min(1)
  .max(64 * 1024);
const Iso = z.string().min(1);

const StoredBase = z.object({
  id: TargetId,
  label: Label.optional(),
  /** Disabled targets are skipped by deploy() without a targetId. */
  enabled: z.boolean(),
  /**
   * false = a store-only target (spec-wave5 §5.6.1: a separate SFTP account restricted to the
   * session-file store, used by the Mac fallback writer and the lock button); skipped by deploys.
   * Absent = true.
   */
  publish: z.boolean().optional(),
  /** Where the published site is reachable (HTTP check); null = no check. */
  publicBaseUrl: PublicBaseUrl.nullable(),
  createdAt: Iso,
  updatedAt: Iso,
});

export const StoredLocalTarget = StoredBase.extend({
  kind: z.literal('local'),
  /** Absolute directory the site is mirrored into (gate mode: gateDir/<secret>). */
  dir: z.string().min(1),
  /** Gate mode: absolute directory of the web root the gate tree (GATE_OUT_DIR) goes to. */
  gateDir: z.string().min(1).optional(),
  /** The session-file store as this machine sees it (Mac fallback writer, lock button). */
  accessStoreDir: z.string().min(1).optional(),
});
export type StoredLocalTarget = z.infer<typeof StoredLocalTarget>;

export const StoredSftpTarget = StoredBase.extend({
  kind: z.literal('sftp'),
  host: z.string().min(1).max(253),
  port: z.int().min(1).max(65535),
  username: z.string().min(1).max(128),
  password: Secret.optional(),
  /** PEM/OpenSSH private key (inline). */
  privateKey: Secret.optional(),
  /** Private key file, absolute or relative to CONFIG_DIR. */
  privateKeyPath: z.string().min(1).max(1024).optional(),
  passphrase: Secret.optional(),
  /** Pinned host key fingerprints; empty = refuse unless trustOnFirstUse. */
  hostKeys: z.array(HostKeyFingerprint),
  /** Accept and pin the first host key seen (only while hostKeys is empty). */
  trustOnFirstUse: z.boolean(),
  remoteRoot: RemoteRoot,
  /** Parallel transfers on the connection (1–8). */
  concurrency: z.int().min(1).max(8),
  /** Gate mode: the web root the gate tree goes to (usually "/"); remoteRoot = gateRoot/<secret>. */
  gateRoot: RemoteRoot.optional(),
  /** The session-file store as this login sees it (Mac fallback writer, lock button). */
  accessStoreRoot: RemoteRoot.optional(),
});
export type StoredSftpTarget = z.infer<typeof StoredSftpTarget>;

export const StoredTarget = z.discriminatedUnion('kind', [StoredLocalTarget, StoredSftpTarget]);
export type StoredTarget = z.infer<typeof StoredTarget>;

export const TargetsFile = z.object({
  format: z.literal(1),
  targets: z.array(StoredTarget),
});
export type TargetsFile = z.infer<typeof TargetsFile>;

// ---------------------------------------------------------------------------------------------
// Input (control UI / CLI). Secrets: absent = keep the stored one, null = remove it.

const InputBase = z.object({
  id: TargetId,
  label: Label.nullish(),
  enabled: z.boolean().optional(),
  publicBaseUrl: PublicBaseUrl.nullish(),
  /** false = store-only target (skipped by deploys). */
  publish: z.boolean().optional(),
});

export const LocalTargetInput = InputBase.extend({
  kind: z.literal('local'),
  /** Absolute, or relative to backend/. */
  dir: z.string().trim().min(1).max(1024),
  /** Gate mode: the web root (absolute, or relative to backend/); null removes it. */
  gateDir: z.string().trim().min(1).max(1024).nullish(),
  /** The session-file store (absolute, or relative to backend/); null removes it. */
  accessStoreDir: z.string().trim().min(1).max(1024).nullish(),
});

export const SftpTargetInput = InputBase.extend({
  kind: z.literal('sftp'),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:[\]-]+$/, { message: 'Expected a host name or IP address' }),
  port: z.int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(128),
  password: Secret.nullish(),
  privateKey: Secret.nullish(),
  privateKeyPath: z.string().trim().min(1).max(1024).nullish(),
  passphrase: Secret.nullish(),
  /** Omitted on create = the built-in pins for known hosts (see hostkeys.ts), else none. */
  hostKeys: z.array(HostKeyFingerprint).optional(),
  trustOnFirstUse: z.boolean().optional(),
  remoteRoot: RemoteRoot.optional(),
  concurrency: z.int().min(1).max(8).optional(),
  /** Gate mode: the web root ("/"); null removes it. */
  gateRoot: RemoteRoot.nullish(),
  /** The session-file store as this login sees it; null removes it. */
  accessStoreRoot: RemoteRoot.nullish(),
});

export const PublishTargetInput = z.discriminatedUnion('kind', [LocalTargetInput, SftpTargetInput]);
export type PublishTargetInput = z.input<typeof PublishTargetInput>;

// ---------------------------------------------------------------------------------------------
// Public view

export interface TargetStatusPublic {
  /** Last finished deploy of this target (any outcome). */
  lastDeploy: DeployResult | null;
  /** Version on the target according to the last successful deploy. */
  deployedVersion: number | null;
  deployedAt: string | null;
  /** Set after an SSH authentication failure: no more logins until the target is saved again. */
  authBlocked: { at: string; message: string } | null;
  /** Obsolete assets kept for the grace period. */
  deferredDeletes: number;
}

interface PublicBase {
  id: string;
  label: string | null;
  enabled: boolean;
  /** false = store-only target. */
  publish: boolean;
  publicBaseUrl: string | null;
  createdAt: string;
  updatedAt: string;
  status: TargetStatusPublic;
}

export interface LocalTargetPublic extends PublicBase {
  kind: 'local';
  dir: string;
  gateDir: string | null;
  accessStoreDir: string | null;
}

export interface SftpTargetPublic extends PublicBase {
  kind: 'sftp';
  host: string;
  port: number;
  username: string;
  auth: 'password' | 'key' | 'none';
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  privateKeyPath: string | null;
  hostKeys: string[];
  trustOnFirstUse: boolean;
  remoteRoot: string;
  concurrency: number;
  gateRoot: string | null;
  accessStoreRoot: string | null;
}

export type PublishTargetPublic = LocalTargetPublic | SftpTargetPublic;

// ---------------------------------------------------------------------------------------------
// Results

export type HttpCheck = 'ok' | 'mismatch' | 'skipped' | 'error';

export interface DeployResult {
  targetId: string;
  /** Transfer completed: every changed file is live, manifest switched, due deletes done. */
  ok: boolean;
  /** Manifest.version of the deployed OUT_DIR (null when unknown, e.g. not generated). */
  version: number | null;
  uploaded: number;
  deleted: number;
  /** Bytes uploaded (payload only). */
  bytes: number;
  durationMs: number;
  httpCheck: HttpCheck;
  error?: string;
  // --- additions beyond the B4a interface sketch (all optional) ---
  /** Machine-readable failure class (see PublishErrorCode). */
  errorCode?: PublishErrorCode;
  /** What the HTTP check saw ("version 12", "HTTP 404", …). */
  httpDetail?: string;
  /** Files already up to date. */
  unchanged?: number;
  /** Obsolete assets still on the target (grace period). */
  deferred?: number;
  /** SFTP logins used (0 when nothing had to be transferred). */
  connections?: number;
  /** True when the deployed state was rebuilt from the target (/.omw-deploy.json) or unknown. */
  recovered?: boolean;
  reason?: string;
  at?: string;
  /** Gate mode: the gate tree deploy (uploads/deletes at gateRoot) and the anonymous check. */
  gate?: { uploaded: number; deleted: number; htaccess: boolean };
  gateCheck?: import('@omw/contracts/access').GateCheckResult;
}

export type PublishErrorCode =
  | 'auth'
  | 'auth_blocked'
  | 'host_key'
  | 'config'
  | 'not_found'
  | 'not_generated'
  | 'out_dir_changed'
  | 'busy'
  | 'timeout'
  | 'connection'
  | 'remote'
  | 'internal'
  /** The mass-delete guard refused the deploy (L2-02 c); `backend publish --force` overrides it. */
  | 'refused'
  /** The target already serves a newer site version (state lost): regenerate above it (L2-02 d). */
  | 'version_behind'
  /** Not attempted: publishing is paused (restore in progress, first owner sync pending). */
  | 'paused'
  /**
   * Gate mode (spec-wave5 §5.6): the target cannot carry the gate (no gateRoot/gateDir, content
   * root not gateRoot/<secret>, no atomic replace, a generated .htaccess that fails verify).
   */
  | 'gate_config'
  /** Gate mode: the anonymous-must-be-refused check found the content open (§5.6.3). */
  | 'gate_open';

/** Error with a classification: `transient` errors are retried with a fresh connection. */
export class PublishError extends Error {
  override name = 'PublishError';
  readonly code: PublishErrorCode;
  readonly transient: boolean;

  constructor(code: PublishErrorCode, message: string, options: { transient?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.transient = options.transient ?? false;
  }
}

/** Planned work of one target (dry run / control UI preview). */
export interface PlanSummary {
  targetId: string;
  version: number | null;
  /** false = no deploy record available: everything is uploaded, only known-obsolete deleted. */
  remoteKnown: boolean;
  uploads: { path: string; phase: string; size: number; reason: 'new' | 'changed' | 'unknown' | 'forced' }[];
  deletes: string[];
  deferred: { path: string; since: string; dueAt: string }[];
  unchanged: number;
  uploadBytes: number;
  skipped: string[];
  /** Why deploy() would refuse this plan (version_behind, mass-delete guard); absent = it would run. */
  refusal?: string;
}
