/**
 * Publish-target form <-> publisher input (backend/src/publisher/types.ts PublishTargetInput).
 * Secrets are write-only: an empty password/key/passphrase field keeps the stored value, the
 * "remove" checkbox clears it (null), and the public view only says whether one is set.
 */
export type FormFields = Record<string, string | undefined>;

const trimmed = (v: string | undefined) => (typeof v === 'string' ? v.trim() : '');
const checked = (v: string | undefined) => v === 'on' || v === 'true' || v === '1';

function secret(form: FormFields, name: string): string | null | undefined {
  if (checked(form[`clear_${name}`])) return null;
  const v = form[name];
  // Keep secrets verbatim (keys need their newlines); only an all-blank field means "unchanged".
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  return name === 'privateKey' ? `${v.replace(/\r\n/g, '\n').trim()}\n` : v;
}

function int(v: string | undefined): number | undefined {
  const t = trimmed(v);
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) ? n : Number.NaN; // NaN fails validation with a clear message
}

/** Builds the publisher input from the submitted form (validation is the publisher's job). */
export function targetInputFromForm(form: FormFields): Record<string, unknown> {
  const creating = form.mode !== 'edit';
  const kind = trimmed(form.kind) === 'local' ? 'local' : 'sftp';
  const label = trimmed(form.label);
  const publicBaseUrl = trimmed(form.publicBaseUrl);
  const base: Record<string, unknown> = {
    id: trimmed(form.id).toLowerCase(),
    kind,
    label: label === '' ? null : label,
    enabled: checked(form.enabled),
    publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl,
  };
  // The "publish" checkbox only counts when the form rendered it (older forms leave it unchanged).
  if (form.publish_field === '1') base.publish = checked(form.publish);
  /** Optional path field (spec-wave5 §5.6.1): empty = unset (null on edit, omitted on create). */
  const optionalPath = (name: string) => {
    const v = trimmed(form[name]);
    if (v !== '') return v;
    return creating ? undefined : null;
  };
  const paths = (names: string[]) => {
    const out: Record<string, unknown> = {};
    for (const n of names) {
      const v = optionalPath(n);
      if (v !== undefined && (v !== null || form[n] !== undefined)) out[n] = v;
    }
    return out;
  };
  if (kind === 'local') return { ...base, dir: trimmed(form.dir), ...paths(['gateDir', 'accessStoreDir']) };
  const out: Record<string, unknown> = {
    ...base,
    host: trimmed(form.host),
    username: trimmed(form.username),
    trustOnFirstUse: checked(form.trustOnFirstUse),
  };
  const port = int(form.port);
  if (port !== undefined) out.port = port;
  const concurrency = int(form.concurrency);
  if (concurrency !== undefined) out.concurrency = concurrency;
  const remoteRoot = trimmed(form.remoteRoot);
  if (remoteRoot !== '') out.remoteRoot = remoteRoot;
  Object.assign(out, paths(['gateRoot', 'accessStoreRoot']));
  const keyPath = trimmed(form.privateKeyPath);
  if (keyPath !== '') out.privateKeyPath = keyPath;
  else if (!creating) out.privateKeyPath = null;
  for (const name of ['password', 'privateKey', 'passphrase']) {
    const v = secret(form, name);
    if (v !== undefined) out[name] = v;
  }
  const hostKeys = trimmed(form.hostKeys)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // On create, no pins = the publisher's built-in pins for known hosts.
  if (hostKeys.length > 0 || !creating) out.hostKeys = hostKeys;
  return out;
}

export const str = (t: Record<string, unknown>, key: string): string | null => {
  const v = t[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
};

export const bool = (t: Record<string, unknown>, key: string): boolean => t[key] === true;

/** Never leak a secret into HTML even if a publisher returns one by mistake. */
export const SECRET_KEYS = new Set(['password', 'privateKey', 'passphrase']);
