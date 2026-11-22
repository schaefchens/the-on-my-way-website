/**
 * Control UI pages (server-rendered). Each function returns the <main> content; server.ts wraps
 * it with layout(). Live parts are re-fetched by static/app.js as HTML fragments
 * (`data-fragment` containers) or via SSE (QR).
 */
import QRCode from 'qrcode';
import type { OutboxItem, QuarantinedItem } from '../store/index.js';
import type { CaptureRow } from '../store/types.js';
import { badge, clockTag, csrfField, formatBytes, html, raw, type SafeHtml, type Tone, timeTag } from './html.js';
import type { LogLine } from './log-ring.js';
import { bool, SECRET_KEYS, str } from './targets.js';
import type { AppStatus, DeployResultView } from './types.js';
import { linkStep, renewText, type WaSnapshot, waStateLabel } from './wa-monitor.js';

export function waTone(state: string): Tone {
  switch (state) {
    case 'open':
      return 'ok';
    case 'connecting':
    case 'pairing':
    case 'qr':
      return 'info';
    case 'closed':
      return 'warn';
    default:
      return 'bad';
  }
}

/** The WhatsApp state as a pill: human label, raw state on hover. */
export function waBadge(wa: Pick<WaSnapshot, 'state' | 'mode'>): SafeHtml {
  return badge(waStateLabel(wa), wa.mode === 'fixture' ? 'info' : waTone(wa.state), wa.state);
}

const CAPTURE_STATE_LABEL: Record<string, string> = {
  received: 'Received',
  archived: 'Archived',
  processed: 'Processed',
  awaiting_media: 'Waiting for media',
  ready: 'Ready',
  failed: 'Failed',
  media_lost: 'Media lost',
};

const WA_HINT: Record<string, string> = {
  open: 'Connected. New statuses of the traveler are captured as they arrive.',
  connecting: 'Connecting to WhatsApp…',
  qr: 'Not linked yet: open “Link WhatsApp” and scan the QR code with the observer phone.',
  pairing: 'Pairing accepted, finishing the link…',
  closed: 'Disconnected; reconnecting automatically.',
  logged_out: 'The linked device was logged out. Link it again (Link WhatsApp).',
  stream_replaced: 'Another session took over this link. Make sure only one backend runs, then restart it.',
  banned: 'WhatsApp temporarily banned this device. The backend waits until the ban ends.',
  error: 'The WhatsApp helper reported an error (see logs).',
};

export async function qrSvg(code: string): Promise<string> {
  return QRCode.toString(code, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 288 });
}

function card(title: string, body: SafeHtml, extraClass = ''): SafeHtml {
  return html`<section class="card ${extraClass}"><h2>${title}</h2>${body}</section>`;
}

function row(label: string, value: unknown): SafeHtml {
  return html`<div class="kv"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function postButton(
  action: string,
  label: string,
  csrf: string | null,
  opts: { fields?: Record<string, string>; tone?: 'primary' | 'secondary' | 'danger'; confirm?: string } = {},
): SafeHtml {
  const fields = Object.entries(opts.fields ?? {}).map(
    ([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`,
  );
  return html`<form method="post" action="${action}" class="inline" ${raw(opts.confirm ? `data-confirm="${escapeAttr(opts.confirm)}"` : '')}>
    ${csrfField(csrf)}${fields}<button type="submit" class="btn btn-${opts.tone ?? 'secondary'}">${label}</button></form>`;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------------------------
// Overview

/** Hint shown with a failed post-deploy check. */
const CHECK_HINT = 'Is the public URL of the target right? Does the host block this machine (firewall, rate limit)?';

/**
 * The publish state in words. A deploy whose post-deploy HTTP check failed is not "live": the
 * files are up, but nobody verified the site serves them.
 */
export function publishSummary(s: Pick<AppStatus, 'publish'>): { label: string; tone: Tone; unreachable: boolean } {
  const results = s.publish.lastResults;
  if (s.publish.targets === 0) return { label: 'no targets', tone: 'idle', unreachable: false };
  if (s.publish.running) return { label: 'deploying', tone: 'info', unreachable: false };
  if (results.length === 0) return { label: 'not deployed yet', tone: 'info', unreachable: false };
  if (!results.every((r) => r.ok)) return { label: 'failed', tone: 'bad', unreachable: false };
  const checkFailed = results.some((r) => r.httpCheck === 'error' || r.httpCheck === 'mismatch');
  if (checkFailed) {
    const mismatch = results.some((r) => r.httpCheck === 'mismatch');
    return {
      label: mismatch ? 'deployed, site shows another version' : 'deployed, site not reachable',
      tone: 'warn',
      unreachable: true,
    };
  }
  return { label: 'live', tone: 'ok', unreachable: false };
}

/**
 * The URL the post-deploy check fetched, per target (publisher/httpcheck.ts: the target's
 * public URL, else SITE_PUBLIC_URL for SFTP targets, + data/manifest.json).
 */
export function checkUrlsOf(
  targets: readonly Record<string, unknown>[],
  sitePublicUrl: string | null,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of targets) {
    const id = str(t, 'id');
    const base = str(t, 'publicBaseUrl') ?? (str(t, 'kind') === 'sftp' ? sitePublicUrl : null);
    if (!id || !base) continue;
    try {
      out.set(id, new URL('data/manifest.json', base.endsWith('/') ? base : `${base}/`).toString());
    } catch {
      // an invalid URL is reported by the target form
    }
  }
  return out;
}

export function overviewFragment(
  s: AppStatus,
  csrf: string | null,
  targets: readonly Record<string, unknown>[] = [],
): SafeHtml {
  const now = Date.parse(s.now);
  const checkUrls = checkUrlsOf(targets, s.site.publicUrl);
  const wa = s.wa;
  const captures = s.captures.byState;
  // Awaiting media has its own row below; "In pipeline" is what the media pipeline still has to do.
  const pipeline = (captures.received ?? 0) + (captures.archived ?? 0) + (captures.processed ?? 0);
  const problems = (captures.failed ?? 0) + (captures.media_lost ?? 0);
  const sync = s.sync;
  const syncTone: Tone = !sync.enabled
    ? 'idle'
    : sync.authPausedUntil || sync.lastPullError
      ? 'bad'
      : sync.queue.failed > 0
        ? 'warn'
        : 'ok';
  const lastResults = s.publish.lastResults;
  const publish = publishSummary(s);

  const waCard = card(
    'WhatsApp',
    html`<p class="state">${waBadge(wa)} <span class="muted">${wa.reason ?? ''}</span></p>
      <p class="hint">${wa.mode === 'fixture' ? 'Fixture mode: recorded statuses are replayed, nothing to link.' : (WA_HINT[wa.state] ?? '')}</p>
      <dl>
        ${row('Mode', s.wa.mode ?? '–')}
        ${row('Linked as', wa.jid ?? '–')}
        ${wa.detail ? row('Detail', wa.detail) : ''}
        ${wa.until ? row('Ban until', timeTag(wa.until, now)) : ''}
        ${row('Helper', html`${wa.process ?? '–'}${wa.helperVersion ? ` · ${wa.helperVersion}` : ''}${wa.restarts ? ` · ${wa.restarts} restarts` : ''}`)}
        ${row('Last event', timeTag(wa.lastEventAt, now))}
      </dl>
      ${wa.state !== 'open' && wa.mode !== 'fixture' ? html`<p><a class="btn btn-primary" href="/link">Link WhatsApp</a></p>` : ''}`,
  );

  const travelerCard = card(
    'Traveler match',
    html`<dl>
        ${row('Phone', wa.traveler.pn ? `+${wa.traveler.pn}` : html`<span class="muted">not set (fixture/self mode)</span>`)}
        ${row(
          'LID',
          wa.traveler.lid
            ? html`${wa.traveler.lid} ${badge(wa.traveler.lidSource ?? 'known', 'ok')}`
            : html`${badge('not learned yet', 'warn')} <span class="muted">learned from the first status</span>`,
        )}
        ${row('Last status', timeTag(s.captures.lastStatusAt, now))}
        ${row('Captured (helper)', String(wa.stats.captured ?? 0))}
        ${row('Other senders ignored', String(wa.stats.other_senders ?? 0))}
        ${wa.stats.undecryptable ? row('Undecryptable', badge(String(wa.stats.undecryptable), 'bad')) : ''}
      </dl>`,
  );

  const capturesCard = card(
    'Captures',
    html`<dl>
        ${row('Total', String(s.captures.total))}
        ${row('Ready', String(captures.ready ?? 0))}
        ${row('In pipeline', pipeline > 0 ? badge(String(pipeline), 'info') : '0')}
        ${row('Awaiting media', String(captures.awaiting_media ?? 0))}
        ${row('Failed / media lost', problems > 0 ? badge(String(problems), 'bad') : '0')}
        ${row('Disk free', formatBytes(s.disk.freeBytes))}
      </dl>
      <p><a href="/queue">Open the queue →</a></p>`,
  );

  const syncCard = card(
    'API sync',
    sync.enabled
      ? html`<p class="state">${badge(syncTone === 'ok' ? 'in sync' : syncTone === 'warn' ? 'retrying' : 'problem', syncTone)}</p>
        <dl>
          ${row('API', sync.baseUrl ?? '–')}
          ${row('Last pull', timeTag(sync.lastPullAt, now))}
          ${row('Feed', html`seq ${sync.feedSeq}${sync.rebuilding ? html` ${badge('rebuilding', 'info')}` : ''}`)}
          ${row('Outbox', html`${sync.queue.pending} pending${sync.queue.failed ? html`, ${badge(`${sync.queue.failed} failing`, 'warn')}` : ''}`)}
          ${row('Heartbeat', timeTag(sync.lastHeartbeatAt, now))}
          ${sync.quarantined ? row('Quarantined', badge(String(sync.quarantined), 'warn')) : ''}
          ${sync.authPausedUntil ? row('Auth', badge('token rejected', 'bad')) : ''}
          ${sync.lastPullError ? row('Pull error', html`<span class="error">${sync.lastPullError}</span>`) : ''}
          ${sync.lastPushError ? row('Push error', html`<span class="error">${sync.lastPushError}</span>`) : ''}
          ${sync.lastHeartbeatError ? row('Heartbeat error', html`<span class="error">${sync.lastHeartbeatError}</span>`) : ''}
        </dl>
        <div class="actions">${postButton('/actions/sync/pull', 'Pull now', csrf)}</div>`
      : html`<p class="state">${badge('disabled', 'idle')}</p>
        <p class="hint">No API configured (API_BASE_URL / API_TOKEN). The site is published from captures only, with default settings.</p>`,
  );

  const build = s.build;
  const siteCard = card(
    'Site',
    html`<dl>
        ${row('Generated', build.last ? html`v${build.last.version} · ${timeTag(build.last.at, now)}` : html`<span class="muted">never</span>`)}
        ${build.last ? row('Last run', `${build.last.full ? 'full' : 'incremental'} · ${build.last.changed} changed · ${build.last.removed} removed · ${build.last.durationMs} ms`) : ''}
        ${row('Status', build.running ? badge('generating', 'info') : build.pending ? badge(`${build.pending.full ? 'full rebuild' : `${build.pending.dates} days`} queued`, 'info') : badge('idle', 'idle'))}
        ${build.nextPublishAt ? row('Next delayed publish', html`${timeTag(build.nextPublishAt.at, now)} <span class="muted">(${build.nextPublishAt.dates.join(', ')})</span>`) : ''}
        ${build.lastError ? row('Error', html`<span class="error">${build.lastError}</span>`) : ''}
        ${row('Public URL', s.site.publicUrl ?? html`<span class="muted">SITE_PUBLIC_URL not set</span>`)}
      </dl>
      <div class="actions">${postButton('/actions/rebuild', 'Rebuild all', csrf, { fields: { full: '1' } })}</div>`,
  );

  const publishCard = card(
    'Publish',
    html`<p class="state">${badge(publish.label, publish.tone)}</p>
      ${publish.unreachable ? html`<p class="hint">The files were uploaded, but the site did not answer the check as expected. ${CHECK_HINT}</p>` : ''}
      <dl>
        ${row('Targets', String(s.publish.targets))}
        ${row('Last deploy', timeTag(s.publish.lastAt, now))}
        ${s.publish.state.lastVersion !== undefined ? row('Live version', `v${s.publish.state.lastVersion}`) : ''}
        ${s.publish.nextRetryAt ? row('Retry', timeTag(s.publish.nextRetryAt, now)) : ''}
      </dl>
      ${deployResultsTable(lastResults, checkUrls)}
      <div class="actions">
        ${s.publish.targets > 0 ? postButton('/actions/publish', 'Publish now', csrf, { tone: 'primary' }) : html`<a class="btn btn-primary" href="/publish">Add a publish target</a>`}
      </div>`,
  );

  return html`<div class="grid">${waCard}${travelerCard}${capturesCard}${siteCard}${publishCard}${syncCard}</div>`;
}

function checkCell(r: DeployResultView, url: string | undefined): SafeHtml {
  const failed = r.httpCheck === 'error' || r.httpCheck === 'mismatch';
  const label =
    r.httpCheck === 'ok'
      ? badge('site ok', 'ok', 'ok')
      : r.httpCheck === 'error'
        ? badge('not reachable', 'warn', 'error')
        : r.httpCheck === 'mismatch'
          ? badge('other version', 'warn', 'mismatch')
          : r.httpCheck === 'skipped'
            ? badge('not checked', 'idle', 'skipped')
            : html`–`;
  return html`${label}${r.httpDetail ? html` <span class="muted">${r.httpDetail}</span>` : ''}
    ${failed && url ? html`<div class="small">Checked <a href="${url}" rel="noreferrer noopener" target="_blank" class="mono">${url}</a></div>` : ''}
    ${failed ? html`<div class="muted small">${CHECK_HINT}</div>` : ''}`;
}

export function deployResultsTable(
  results: readonly DeployResultView[],
  checkUrls: ReadonlyMap<string, string> = new Map(),
): SafeHtml {
  if (results.length === 0) return html``;
  return html`<table class="table compact cards"><thead><tr><th>Target</th><th>Result</th><th>Files</th><th>Check</th></tr></thead><tbody>
    ${results.map(
      (r) => html`<tr>
        <td data-label="Target">${r.targetId}</td>
        <td data-label="Result">${r.ok ? badge(`v${r.version ?? '?'}`, 'ok') : badge('failed', 'bad')}${r.error ? html`<div class="error small">${r.error}</div>` : ''}</td>
        <td data-label="Files">↑${r.uploaded} ✕${r.deleted}${r.bytes !== undefined ? html` <span class="muted">${formatBytes(r.bytes)}</span>` : ''}${r.durationMs !== undefined ? html` <span class="muted">${Math.round(r.durationMs / 100) / 10} s</span>` : ''}</td>
        <td data-label="Check">${checkCell(r, checkUrls.get(r.targetId))}</td>
      </tr>`,
    )}</tbody></table>`;
}

export function overviewPage(
  s: AppStatus,
  csrf: string | null,
  targets: readonly Record<string, unknown>[] = [],
): SafeHtml {
  return html`<h1>Overview</h1>
    <div data-fragment="/fragments/overview" data-interval="5000">${overviewFragment(s, csrf, targets)}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Link WhatsApp

export interface PairCodeForm {
  /** The number as typed (kept after an error, so it is not typed again). */
  phone?: string;
  /** The code the helper just returned. */
  code?: string | null;
}

export async function linkPage(
  wa: WaSnapshot,
  csrf: string | null,
  pair: PairCodeForm | string | null,
  now: number,
): Promise<SafeHtml> {
  const form: PairCodeForm = typeof pair === 'string' ? { code: pair } : (pair ?? {});
  const step = linkStep(wa);
  if (step === 'fixture') {
    return html`<h1>Link WhatsApp</h1>
      <section class="card">
        <h2>Fixture mode – nothing to link</h2>
        <p class="state" data-wa-state>${waBadge(wa)}</p>
        <p class="hint">This backend replays recorded statuses (WA_MODE=fixture). To capture real statuses, run it with <code>WA_MODE=observer</code> and <code>TRAVELER_PHONE</code> (see docs/OBSERVER.md), then link the observer phone here.</p>
      </section>`;
  }
  const svg = wa.qr ? await qrSvg(wa.qr.code) : null;
  const message =
    step === 'linked'
      ? 'Linked ✓ — nothing to scan.'
      : step === 'renew'
        ? 'No code to scan right now.'
        : step === 'restarting'
          ? 'The WhatsApp helper restarts after an error; a new code follows.'
          : 'Waiting for a QR code from the helper…';
  const code = form.code ?? wa.pairCode?.code ?? null;
  const validUntil = wa.pairCode && (!form.code || wa.pairCode.code === form.code) ? wa.pairCode.validUntil : undefined;
  return html`<h1>Link WhatsApp</h1>
    <div class="grid two">
      <section class="card">
        <h2>Scan the QR code</h2>
        <p class="state" data-wa-state>${waBadge(wa)}</p>
        <div class="qr" data-qr data-expires="${wa.qr?.expiresAt ?? ''}">
          ${svg ? raw(svg) : html`<p class="muted qr-empty" data-qr-message>${message}</p>`}
        </div>
        <p class="muted small" data-qr-expiry>${wa.qr ? html`Valid until ${clockTag(wa.qr.expiresAt)}; a new code appears automatically.` : step === 'restarting' && wa.nextRestartAt ? html`Next try ${timeTag(wa.nextRestartAt, now)}.` : ''}</p>
        <div class="renew" data-qr-renew ${raw(step === 'renew' ? '' : 'hidden')}>
          <p class="renew-text" data-renew-text>${renewText(wa)}</p>
          ${postButton('/actions/wa/restart', 'Show a new QR code', csrf, { tone: 'primary' })}
        </div>
        <ol class="steps">
          <li>On the <strong>observer phone</strong>, open WhatsApp → <em>Settings</em> → <em>Linked devices</em>.</li>
          <li>Tap <em>Link a device</em> and scan this code.</li>
          <li>The state switches to <strong>Linked</strong> within a few seconds.</li>
        </ol>
      </section>
      <section class="card">
        <h2>…or use a pairing code</h2>
        <p class="hint">Enter the observer phone's own number (international format). WhatsApp then asks for the 8-character code on the phone: <em>Link a device</em> → <em>Link with phone number instead</em>.</p>
        <form method="post" action="/actions/pair-code" class="stack">
          ${csrfField(csrf)}
          <label>Observer phone number <input name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="+49 151 23456789" value="${form.phone ?? ''}" required aria-describedby="phone-hint">
            <span class="muted small" id="phone-hint">International format with the country code, e.g. +49 151 23456789.</span></label>
          <button type="submit" class="btn btn-primary">Get pairing code</button>
        </form>
        <p class="paircode" data-pair-code>${code ?? ''}</p>
        <p class="muted small center" data-pair-valid>${code && validUntil ? html`Code valid until ${clockTag(validUntil)}.` : ''}</p>
        <h3>Troubleshooting</h3>
        <ul class="small">
          <li>No QR? The helper may be backing off after an error — check <a href="/logs">Logs</a>.</li>
          <li>${postButton('/actions/wa/restart', 'Restart WhatsApp helper', csrf, { confirm: 'Restart the WhatsApp helper now?' })}</li>
        </ul>
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------------------------
// Queue

function shortKey(key: string): string {
  return key.length > 28 ? `${key.slice(0, 26)}…` : key;
}

function captureStateTone(state: string): Tone {
  if (state === 'ready') return 'ok';
  if (state === 'failed' || state === 'media_lost') return 'bad';
  if (state === 'awaiting_media') return 'warn';
  return 'info';
}

export function queueFragment(
  captures: readonly CaptureRow[],
  outbox: readonly OutboxItem[],
  quarantine: readonly QuarantinedItem[],
  csrf: string | null,
  now: number,
): SafeHtml {
  const capturesTable =
    captures.length === 0
      ? html`<p class="muted">Nothing waiting: every capture is ready.</p>`
      : html`<table class="table cards"><thead><tr><th>Status</th><th>Kind</th><th>State</th><th>Download</th><th>Tries</th><th>Error</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${captures.map((c) => {
          const retry = c.state === 'failed' || c.state === 'media_lost';
          const skip = ['awaiting_media', 'received', 'failed'].includes(c.state);
          return html`<tr>
            <td data-label="Status"><code title="${c.sourceKey}">${shortKey(c.sourceKey)}</code><div class="muted small">${timeTag(c.occurredAt, now)}</div></td>
            <td data-label="Kind">${c.kind}</td>
            <td data-label="State">${badge(CAPTURE_STATE_LABEL[c.state] ?? c.state, captureStateTone(c.state), c.state)}${c.revokedAt ? html` ${badge('revoked', 'idle')}` : ''}</td>
            <td data-label="Download">${c.downloadState}${c.downloadReason ? html`<div class="muted small">${c.downloadReason}${c.downloadPermanent ? ' (permanent)' : ''}</div>` : ''}</td>
            <td data-label="Tries">${c.attempts}${c.nextAttemptAt ? html`<div class="muted small">next ${timeTag(c.nextAttemptAt, now)}</div>` : ''}</td>
            <td data-label="Error" class="error small ${raw(c.lastError ? '' : 'empty')}">${c.lastError ?? ''}</td>
            <td class="nowrap cell-actions ${raw(retry || skip ? '' : 'empty')}">
              ${retry ? postButton('/actions/captures/retry', 'Retry', csrf, { fields: { sourceKey: c.sourceKey } }) : ''}
              ${skip ? postButton('/actions/captures/skip', 'Skip', csrf, { fields: { sourceKey: c.sourceKey }, tone: 'danger', confirm: 'Give up on this status? It is marked as media lost.' }) : ''}
            </td>
          </tr>`;
        })}</tbody></table>`;
  const outboxTable =
    outbox.length === 0
      ? html`<p class="muted">No failing API pushes.</p>`
      : html`<table class="table cards"><thead><tr><th>Kind</th><th>Key</th><th>Tries</th><th>Next</th><th>Error</th></tr></thead><tbody>
        ${outbox.map(
          (o) =>
            html`<tr><td data-label="Kind">${o.kind}</td><td data-label="Key"><code>${shortKey(o.key)}</code></td><td data-label="Tries">${o.attempts}</td><td data-label="Next">${timeTag(o.nextAttemptAt, now)}</td><td data-label="Error" class="error small">${o.lastError ?? ''}</td></tr>`,
        )}</tbody></table>`;
  const quarantineTable =
    quarantine.length === 0
      ? html`<p class="muted">No quarantined change-feed items.</p>`
      : html`<p class="hint">Owner changes the backend could not apply (kept out of the site; the previous value stays). Usually an API newer than this backend — update the backend.</p>
        <table class="table cards"><thead><tr><th>Seq</th><th>Entity</th><th>Key</th><th>Error</th><th>Received</th></tr></thead><tbody>
        ${quarantine.map(
          (q) =>
            html`<tr><td data-label="Seq">${q.seq ?? '–'}</td><td data-label="Entity">${q.entity ?? '–'}</td><td data-label="Key"><code>${q.key ?? '–'}</code></td><td data-label="Error" class="error small">${q.error.slice(0, 400)}</td><td data-label="Received">${timeTag(q.receivedAt, now)}</td></tr>`,
        )}</tbody></table>`;
  return html`${card('Captures not ready', capturesTable, 'wide')}${card('API outbox', outboxTable, 'wide')}${card('Change-feed quarantine', quarantineTable, 'wide')}`;
}

export function queuePage(fragment: SafeHtml, csrf: string | null, apiEnabled: boolean): SafeHtml {
  return html`<h1>Queue</h1>
    <div data-fragment="/fragments/queue" data-interval="10000">${fragment}</div>
    <section class="card wide">
      <h2>Maintenance</h2>
      <div class="actions">
        ${postButton('/actions/reprocess', 'Reprocess everything from the archive', csrf, { tone: 'danger', confirm: 'Re-run the media pipeline for every archived status? This can take a long time.' })}
        ${apiEnabled ? postButton('/actions/sync/resync', 'Push all captures to the API again', csrf, { confirm: 'Queue every capture (and its previews) for the API again?' }) : ''}
      </div>
    </section>`;
}

// ---------------------------------------------------------------------------------------------
// Publish

function accessSummary(t: Record<string, unknown>): SafeHtml {
  const gate = str(t, 'gateRoot') ?? str(t, 'gateDir');
  const store = str(t, 'accessStoreRoot') ?? str(t, 'accessStoreDir');
  if (!gate && !store && t.publish !== false) return html``;
  return html`<div class="muted small">${t.publish === false ? 'store only · ' : ''}${gate ? html`web root <code>${gate}</code>` : ''}${gate && store ? ' · ' : ''}${store ? html`access store <code>${store}</code>` : ''}</div>`;
}

function targetSummary(t: Record<string, unknown>): SafeHtml {
  const kind = str(t, 'kind');
  if (kind === 'local') return html`folder <code>${str(t, 'dir') ?? '?'}</code>${accessSummary(t)}`;
  const auth = str(t, 'auth');
  const pins = Array.isArray(t.hostKeys) ? t.hostKeys.length : 0;
  return html`<code>${str(t, 'username') ?? '?'}@${str(t, 'host') ?? '?'}:${str(t, 'port') ?? '22'}${str(t, 'remoteRoot') ?? '/'}</code>
    <div class="muted small">auth: ${auth ?? 'unknown'}${bool(t, 'hasPassword') ? ' · password set' : ''}${bool(t, 'hasPrivateKey') ? ' · key set' : ''}${str(t, 'privateKeyPath') ? ` · key file ${str(t, 'privateKeyPath')}` : ''} · ${pins} pinned host key${pins === 1 ? '' : 's'}${bool(t, 'trustOnFirstUse') ? ' · trust on first use' : ''}</div>${accessSummary(t)}`;
}

function targetStatus(t: Record<string, unknown>, now: number, checkUrl: string | undefined): SafeHtml {
  const id = str(t, 'id') ?? '';
  const status = t.status && typeof t.status === 'object' ? (t.status as Record<string, unknown>) : {};
  const blocked =
    status.authBlocked && typeof status.authBlocked === 'object'
      ? (status.authBlocked as Record<string, unknown>)
      : null;
  const last =
    status.lastDeploy && typeof status.lastDeploy === 'object' ? (status.lastDeploy as Record<string, unknown>) : null;
  return html`${typeof status.deployedVersion === 'number' ? badge(`v${status.deployedVersion}`, 'ok') : badge('never deployed', 'idle')}
    ${typeof status.deployedAt === 'string' ? html` ${timeTag(status.deployedAt, now)}` : ''}
    ${last && last.ok === false ? html`<div class="error small">${String(last.error ?? 'last deploy failed')}</div>` : ''}
    ${last && last.ok === true && (last.httpCheck === 'error' || last.httpCheck === 'mismatch') ? html`<div class="small">${badge(last.httpCheck === 'mismatch' ? 'deployed, site shows another version' : 'deployed, site not reachable', 'warn', String(last.httpCheck))}${checkUrl ? html` <span class="muted">checked</span> <span class="mono">${checkUrl}</span>` : ''}</div>` : ''}
    ${blocked ? html`<div class="error small">Login blocked after an authentication failure: ${String(blocked.message ?? '')}. <a href="/publish?edit=${encodeURIComponent(id)}#target-form">Check the login and save the target again</a> to retry.</div>` : ''}
    ${typeof status.deferredDeletes === 'number' && status.deferredDeletes > 0 ? html`<div class="muted small">${status.deferredDeletes} old assets kept for the grace period</div>` : ''}`;
}

export function targetForm(t: Record<string, unknown> | null, csrf: string | null): SafeHtml {
  const editing = t !== null;
  const v = (k: string) => (t ? (str(t, k) ?? '') : '');
  const kind = t ? (str(t, 'kind') ?? 'sftp') : 'sftp';
  const hostKeys =
    t && Array.isArray(t.hostKeys) ? t.hostKeys.filter((x): x is string => typeof x === 'string').join('\n') : '';
  const secretField = (name: string, label: string, isSet: boolean, textarea = false) => html`<label>${label}
      ${textarea ? html`<textarea name="${name}" rows="4" autocomplete="off" spellcheck="false" placeholder="${isSet ? '(set — leave empty to keep)' : ''}"></textarea>` : html`<input type="password" name="${name}" autocomplete="new-password" placeholder="${isSet ? '(set — leave empty to keep)' : ''}">`}
    </label>
    ${isSet ? html`<label class="check"><input type="checkbox" name="clear_${name}"> remove the stored ${label.toLowerCase()}</label>` : ''}`;
  return html`<form method="post" action="/actions/targets/save" class="stack target-form" data-target-form>
    ${csrfField(csrf)}
    <input type="hidden" name="mode" value="${editing ? 'edit' : 'create'}">
    <div class="row">
      <label>Id <input name="id" required pattern="[a-z0-9][a-z0-9\\-]{0,62}" value="${v('id')}" ${raw(editing ? 'readonly' : '')} placeholder="sftp-main"></label>
      <label>Kind
        <select name="kind" data-kind-select ${raw(editing ? 'disabled' : '')}>
          <option value="sftp" ${raw(kind === 'sftp' ? 'selected' : '')}>SFTP</option>
          <option value="local" ${raw(kind === 'local' ? 'selected' : '')}>Local folder</option>
        </select>
      </label>
      ${editing ? html`<input type="hidden" name="kind" value="${kind}">` : ''}
    </div>
    <label>Label <input name="label" value="${v('label')}" placeholder="Hetzner static host"></label>
    <label>Public URL of the site <input name="publicBaseUrl" type="url" value="${v('publicBaseUrl')}" placeholder="https://example.org/"> <span class="muted small">used for the post-deploy check</span></label>
    <label class="check"><input type="checkbox" name="enabled" ${raw(!t || bool(t, 'enabled') ? 'checked' : '')}> enabled</label>
    <input type="hidden" name="publish_field" value="1">
    <label class="check"><input type="checkbox" name="publish" ${raw(t?.publish !== false ? 'checked' : '')}> deploy the site here <span class="muted small">(off = store-only target for the access store writer and the lock button)</span></label>
    <fieldset data-kind="local" ${raw(kind === 'local' ? '' : 'class="dim"')}>
      <legend>Local folder</legend>
      <label>Directory <input name="dir" value="${v('dir')}" placeholder="/srv/www/omw"></label>
      <label>Web root (gate mode) <input name="gateDir" value="${v('gateDir')}" placeholder="/srv/www"> <span class="muted small">the directory must then be web root + "/" + the content folder</span></label>
      <label>Access store folder <input name="accessStoreDir" value="${v('accessStoreDir')}" placeholder="/srv/omw-store/site1"></label>
    </fieldset>
    <fieldset data-kind="sftp" ${raw(kind === 'sftp' ? '' : 'class="dim"')}>
      <legend>SFTP</legend>
      <div class="row">
        <label>Host <input name="host" value="${v('host')}" placeholder="sftp.example.org"></label>
        <label class="narrow">Port <input name="port" inputmode="numeric" value="${v('port')}" placeholder="22"></label>
      </div>
      <label>User <input name="username" autocomplete="off" value="${v('username')}"></label>
      ${secretField('password', 'Password', t ? bool(t, 'hasPassword') : false)}
      ${secretField('privateKey', 'Private key (OpenSSH/PEM)', t ? bool(t, 'hasPrivateKey') : false, true)}
      <label>…or private key file <input name="privateKeyPath" value="${v('privateKeyPath')}" placeholder="keys/id_ed25519 (relative to CONFIG_DIR)"></label>
      ${secretField('passphrase', 'Key passphrase', t ? bool(t, 'hasPassphrase') : false)}
      <label>Pinned host keys <textarea name="hostKeys" rows="3" spellcheck="false" placeholder="SHA256:… (one per line; empty = built-in pins for known hosts)">${hostKeys}</textarea></label>
      <label class="check"><input type="checkbox" name="trustOnFirstUse" ${raw(t && bool(t, 'trustOnFirstUse') ? 'checked' : '')}> trust and pin the first host key seen (only without pins)</label>
      <div class="row">
        <label>Remote root <input name="remoteRoot" value="${v('remoteRoot')}" placeholder="/"></label>
        <label class="narrow">Parallel transfers <input name="concurrency" inputmode="numeric" value="${v('concurrency')}" placeholder="4"></label>
      </div>
      <div class="row">
        <label>Web root (gate mode) <input name="gateRoot" value="${v('gateRoot')}" placeholder="/"> <span class="muted small">remote root must then be web root + "/" + the content folder</span></label>
        <label>Access store path <input name="accessStoreRoot" value="${v('accessStoreRoot')}" placeholder="/omw-store/site1"> <span class="muted small">as this login sees it</span></label>
      </div>
    </fieldset>
    <div class="actions"><button type="submit" class="btn btn-primary">${editing ? 'Save target' : 'Add target'}</button>${editing ? html` <a href="/publish" class="btn btn-secondary">Cancel</a>` : ''}</div>
  </form>`;
}

/**
 * "Website sperren" (spec-wave5 §5.6.6): only with a store target. Locks the site for everyone by
 * writing the store's `locked` file over this machine's own connection; works with the API down.
 * Unlocking is only possible in the admin (password).
 */
function lockSection(targets: readonly Record<string, unknown>[], s: AppStatus, csrf: string | null): SafeHtml {
  const store = targets.find(
    (t) => t.enabled !== false && (str(t, 'accessStoreRoot') !== null || str(t, 'accessStoreDir') !== null),
  );
  if (!store) return html``;
  const writer = s.access?.writer;
  return html`<section class="card wide" id="access-lock"><h2>Zugang</h2>
    <p class="hint">Sperrt die Website sofort für alle (über den Website-Speicher von <code>${str(store, 'id') ?? ''}</code>, auch wenn die API nicht erreichbar ist). Entsperren geht nur im Admin.</p>
    ${writer ? html`<p class="muted small">Speicher-Schreiber: ${writer}</p>` : ''}
    <div class="actions">${postButton('/actions/access/lock', 'Website sperren', csrf, { tone: 'danger', confirm: 'Website jetzt für alle sperren?' })}</div>
  </section>`;
}

export function publishPage(
  s: AppStatus,
  targets: readonly Record<string, unknown>[],
  editing: Record<string, unknown> | null,
  csrf: string | null,
): SafeHtml {
  const now = Date.parse(s.now);
  const checkUrls = checkUrlsOf(targets, s.site.publicUrl);
  const list =
    targets.length === 0
      ? html`<p class="muted">No publish targets yet. Add one below; a local folder is handy for testing.</p>`
      : html`<table class="table cards"><thead><tr><th>Target</th><th>Where</th><th>Deployed</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${targets.map((t) => {
          const id = str(t, 'id') ?? '';
          return html`<tr>
            <td data-label="Target"><strong>${id}</strong>${str(t, 'label') ? html`<div class="muted small">${str(t, 'label')}</div>` : ''}${bool(t, 'enabled') ? '' : html` ${badge('disabled', 'idle')}`}
              ${str(t, 'publicBaseUrl') ? html`<div class="small"><a href="${str(t, 'publicBaseUrl') ?? ''}" rel="noreferrer noopener" target="_blank">${str(t, 'publicBaseUrl')}</a></div>` : ''}</td>
            <td data-label="Where">${targetSummary(t)}</td>
            <td data-label="Deployed">${targetStatus(t, now, checkUrls.get(id))}</td>
            <td class="nowrap cell-actions">
              ${postButton('/actions/targets/test', 'Test', csrf, { fields: { id } })}
              ${postButton('/actions/publish', 'Publish', csrf, { fields: { targetId: id } })}
              <a class="btn btn-secondary" href="/publish?edit=${encodeURIComponent(id)}">Edit</a>
              ${postButton('/actions/targets/remove', 'Remove', csrf, { fields: { id }, tone: 'danger', confirm: `Remove target ${id}? Files on the server stay.` })}
            </td></tr>`;
        })}</tbody></table>`;
  // Defence in depth: never render secret values even if a publisher returned them.
  const safeEditing = editing ? Object.fromEntries(Object.entries(editing).filter(([k]) => !SECRET_KEYS.has(k))) : null;
  return html`<h1>Publish</h1>
    <div class="grid two">
      <section class="card">
        <h2>Site</h2>
        <dl>
          ${row('Generated', s.build.last ? html`v${s.build.last.version} · ${timeTag(s.build.last.at, now)}` : 'never')}
          ${row('Status', s.build.running ? 'generating…' : s.publish.running ? 'deploying…' : 'idle')}
        </dl>
        <div class="actions">
          ${postButton('/actions/rebuild', 'Rebuild all', csrf, { fields: { full: '1' } })}
          ${targets.length > 0 ? postButton('/actions/publish', 'Publish now', csrf, { tone: 'primary' }) : ''}
        </div>
      </section>
      <section class="card">
        <h2>Last deploy</h2>
        ${s.publish.lastResults.length > 0 ? deployResultsTable(s.publish.lastResults, checkUrls) : html`<p class="muted">No deploy in this run yet.</p>`}
        ${s.publish.state.lastError ? html`<p class="error small">${s.publish.state.lastError}</p>` : ''}
      </section>
    </div>
    <section class="card wide"><h2>Targets</h2>${list}</section>
    ${lockSection(targets, s, csrf)}
    <section class="card wide" id="target-form"><h2>${safeEditing ? `Edit ${str(safeEditing, 'id') ?? ''}` : 'Add a target'}</h2>
      <p class="hint">Passwords, keys and passphrases are write-only: they are stored in CONFIG_DIR on this machine and never shown or sent anywhere else.</p>
      ${targetForm(safeEditing, csrf)}
    </section>`;
}

// ---------------------------------------------------------------------------------------------
// Logs

export function logRows(lines: readonly LogLine[]): SafeHtml {
  return html`${lines.map(
    (l) =>
      html`<tr class="lvl-${l.levelLabel}" data-id="${l.id}"><td class="nowrap"><time datetime="${new Date(l.time).toISOString()}">${new Date(l.time).toISOString().slice(11, 19)}</time></td><td>${l.levelLabel}</td><td>${l.module ?? ''}</td><td>${l.msg}${l.extra ? html`<div class="muted small mono">${l.extra}</div>` : ''}</td></tr>`,
  )}`;
}

export function logsPage(
  lines: readonly LogLine[],
  events: readonly { id: number; ts: string; type: string; data: unknown }[],
  now: number,
): SafeHtml {
  return html`<h1>Logs</h1>
    <section class="card wide">
      <h2>Log tail <span class="muted small">(last ${lines.length} lines, live)</span></h2>
      <div class="logwrap"><table class="table log" data-log data-after="${lines.at(-1)?.id ?? 0}"><thead><tr><th>Time (UTC)</th><th>Level</th><th>Module</th><th>Message</th></tr></thead>
      <tbody>${logRows(lines)}</tbody></table></div>
    </section>
    <section class="card wide">
      <h2>Events</h2>
      <table class="table compact"><thead><tr><th>When</th><th>Type</th><th>Data</th></tr></thead><tbody>
      ${events.map((e) => html`<tr><td class="nowrap">${timeTag(e.ts, now)}</td><td>${e.type}</td><td class="mono small">${e.data === null ? '' : JSON.stringify(e.data).slice(0, 500)}</td></tr>`)}
      </tbody></table>
    </section>`;
}

// ---------------------------------------------------------------------------------------------
// Login

export function loginPage(next: string, error: string | null): SafeHtml {
  return html`<section class="card login">
    <h1>Control</h1>
    <p class="hint">Enter the CONTROL_TOKEN of this backend (see <code>.env</code> / <code>docker compose</code>).</p>
    ${error ? html`<p class="flash flash-error" role="alert">${error}</p>` : ''}
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="next" value="${next}">
      <label>Token <input name="token" type="password" autocomplete="current-password" required autofocus></label>
      <button type="submit" class="btn btn-primary">Log in</button>
    </form>
  </section>`;
}
