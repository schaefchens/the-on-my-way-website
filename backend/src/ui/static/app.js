// On My Way control UI: progressive enhancement only (every page works without JS).
// Loaded as a module from /static (CSP: script-src 'self'; no inline scripts or styles).

const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ?? '';

// Confirmation and busy state for action forms.
document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const question = form.dataset.confirm;
  if (question && !window.confirm(question)) {
    event.preventDefault();
    return;
  }
  form.classList.add('busy');
  for (const button of form.querySelectorAll('button')) button.disabled = true;
});

async function getHtml(url) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'text/html' } });
  if (res.status === 401) {
    window.location.reload();
    return null;
  }
  return res.ok ? res.text() : null;
}

// Live fragments: <div data-fragment="/fragments/x" data-interval="5000">.
for (const el of document.querySelectorAll('[data-fragment]')) {
  const url = el.getAttribute('data-fragment');
  const every = Number(el.getAttribute('data-interval') || 10000);
  let inFlight = false;
  setInterval(async () => {
    if (document.hidden || inFlight || el.querySelector('form.busy')) return;
    inFlight = true;
    try {
      const text = await getHtml(url);
      // Same-origin, server-escaped markup; CSP blocks any script in it anyway.
      if (text !== null) {
        el.innerHTML = text;
        localizeTimes(el);
      }
    } catch {
      // backend restarting: keep the last view
    } finally {
      inFlight = false;
    }
  }, every);
}

// Target form: show the fieldset of the selected kind.
const kindSelect = document.querySelector('[data-kind-select]');
if (kindSelect instanceof HTMLSelectElement) {
  const sync = () => {
    for (const fs of document.querySelectorAll('fieldset[data-kind]')) {
      const active = fs.getAttribute('data-kind') === kindSelect.value;
      fs.hidden = !active;
      fs.classList.remove('dim');
    }
  };
  kindSelect.addEventListener('change', sync);
  sync();
} else {
  for (const fs of document.querySelectorAll('fieldset[data-kind].dim')) fs.hidden = true;
}

// Times rendered as "14:05 UTC" by the server: show them in this browser's local time.
const localizeTimes = (root = document) => {
  for (const el of root.querySelectorAll('time[data-local-time]')) {
    const d = new Date(el.getAttribute('datetime') || '');
    if (!Number.isNaN(d.getTime())) el.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
};
localizeTimes();

// Link page: live QR / state / pairing code via SSE. The server sends the human label and the
// step to show (scan | renew | restarting | waiting | linked), so an open page follows the
// helper: when the QR window ends (helper exit 7, no automatic restart) it offers a new code.
const qrBox = document.querySelector('[data-qr]');
if (qrBox) {
  const stateBox = document.querySelector('[data-wa-state]');
  const expiryBox = document.querySelector('[data-qr-expiry]');
  const renewBox = document.querySelector('[data-qr-renew]');
  const renewTextBox = document.querySelector('[data-renew-text]');
  const pairBox = document.querySelector('[data-pair-code]');
  const pairValidBox = document.querySelector('[data-pair-valid]');
  const EXPIRED = 'This code expired — show a new one.';
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const message = (text) => {
    const p = document.createElement('p');
    p.className = 'muted qr-empty';
    p.setAttribute('data-qr-message', '');
    p.textContent = text;
    qrBox.replaceChildren(p);
    qrBox.dataset.expires = '';
  };
  const showRenew = (show, text) => {
    if (!renewBox) return;
    renewBox.hidden = !show;
    if (show && text && renewTextBox) renewTextBox.textContent = text;
  };
  const setBadge = (label, tone, raw) => {
    if (!stateBox) return;
    const badge = document.createElement('span');
    badge.className = `badge badge-${tone || 'bad'}`;
    badge.textContent = label || raw;
    if (raw && raw !== label) badge.title = raw;
    stateBox.replaceChildren(badge);
  };
  const showQr = (svgText, expiresAt) => {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg.nodeName.toLowerCase() !== 'svg') return;
    qrBox.replaceChildren(document.importNode(svg, true));
    qrBox.classList.remove('expired');
    qrBox.dataset.expires = expiresAt;
    showRenew(false);
    if (expiryBox) expiryBox.textContent = `Valid until ${clock(expiresAt)}; a new code appears automatically.`;
  };
  const expire = () => {
    qrBox.classList.add('expired');
    if (expiryBox) expiryBox.textContent = EXPIRED;
    showRenew(true, EXPIRED);
  };
  setInterval(() => {
    const exp = Date.parse(qrBox.dataset.expires || '');
    if (!Number.isNaN(exp) && exp < Date.now() && !qrBox.classList.contains('expired')) expire();
  }, 1000);
  const source = new EventSource('/api/wa/stream');
  source.addEventListener('qr', (e) => {
    const data = JSON.parse(e.data);
    showQr(data.svg, data.expiresAt);
  });
  source.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    setBadge(data.label, data.tone, data.state);
    switch (data.step) {
      case 'linked':
        message('Linked ✓ — nothing to scan.');
        showRenew(false);
        if (expiryBox) expiryBox.textContent = '';
        break;
      case 'scan':
        if (data.qrSvg) showQr(data.qrSvg, data.qrExpiresAt);
        break;
      case 'renew':
        // Keep a faded QR on screen if one is there; the button gets the next one.
        if (qrBox.querySelector('svg')) qrBox.classList.add('expired');
        else message('No code to scan right now.');
        if (expiryBox) expiryBox.textContent = '';
        showRenew(true, data.renewText || EXPIRED);
        break;
      case 'restarting':
        message('The WhatsApp helper restarts after an error; a new code follows.');
        showRenew(false);
        if (expiryBox) expiryBox.textContent = data.nextRestartAt ? `Next try at ${clock(data.nextRestartAt)}.` : '';
        break;
      case 'waiting':
        if (!qrBox.querySelector('svg') || qrBox.classList.contains('expired')) {
          message('Waiting for a QR code from the helper…');
          if (expiryBox) expiryBox.textContent = '';
        }
        showRenew(false);
        break;
      default:
        break;
    }
    if (pairBox && pairValidBox && data.pairCode === undefined && pairBox.textContent) {
      // The code expired (or the link succeeded): a stale code would only fail on the phone.
      pairBox.textContent = '';
      pairValidBox.textContent = '';
    }
  });
  source.addEventListener('pair_code', (e) => {
    const data = JSON.parse(e.data);
    if (pairBox) pairBox.textContent = data.code;
    if (pairValidBox) pairValidBox.textContent = '';
  });
  // A shown pairing code disappears when it is no longer valid.
  const validTime = pairValidBox?.querySelector('time[datetime]');
  const validUntil = Date.parse(validTime?.getAttribute('datetime') || '');
  if (!Number.isNaN(validUntil)) {
    setTimeout(
      () => {
        if (pairBox) pairBox.textContent = '';
        if (pairValidBox) pairValidBox.textContent = 'That code expired — request a new one.';
      },
      Math.max(0, validUntil - Date.now()),
    );
  }
}

// Logs page: append new lines.
const logTable = document.querySelector('[data-log]');
if (logTable) {
  const body = logTable.querySelector('tbody');
  const wrap = logTable.closest('.logwrap');
  let after = Number(logTable.getAttribute('data-after') || 0);
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
  const cell = (text, cls) => {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  };
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(`/api/logs?after=${after}`, {
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrf },
      });
      if (!res.ok) return;
      const { lines } = await res.json();
      if (!Array.isArray(lines) || lines.length === 0) return;
      const atBottom = wrap ? wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 8 : false;
      for (const l of lines) {
        const tr = document.createElement('tr');
        tr.className = `lvl-${l.levelLabel}`;
        tr.append(
          cell(new Date(l.time).toISOString().slice(11, 19), 'nowrap'),
          cell(l.levelLabel),
          cell(l.module ?? ''),
        );
        const msg = cell(l.msg);
        if (l.extra) {
          const extra = document.createElement('div');
          extra.className = 'muted small mono';
          extra.textContent = l.extra;
          msg.append(extra);
        }
        tr.append(msg);
        body.append(tr);
        after = Math.max(after, l.id);
      }
      while (body.rows.length > 1000) body.deleteRow(0);
      if (wrap && atBottom) wrap.scrollTop = wrap.scrollHeight;
    } catch {
      // ignore
    }
  }, 2000);
}
