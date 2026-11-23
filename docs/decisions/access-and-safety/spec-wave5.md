# Wave 5 build specification: access gate (API-only), followers, consent, data rights, safety options

Status: **buildable spec, revision 2**, 2026-11-20. Scope = "Wave 5" of `owner-decisions.md`
(Implementation split). Revision 2 applies `spec-wave5-review.md`; Appendix B lists every review
point with "accepted / modified / rejected" and a reason.
Authority: `owner-decisions.md` (D1–D12, Q0–Q9) overrides `proposal.md`. This spec replaces the
gate parts of `proposal.md` (no `gate.php`, no phone relay, no signed snapshots, no co-admin, no
join window, no QR add-device).

Main changes in revision 2: no secret in any URL (the handoff is the fixed path `/_/h/` and reads a
120-second transfer cookie plus the `SameSite=Strict` key cookie, §2.3.2); only active devices (and
devices that ended with their person's access) may read, export or delete the person's data
(§3.3 "D12 rights"); a store identity check and an end-to-end store proof (§2.2, §5.6.3); a
non-blocking applier (§3.8.3); the settings migration moves into WP0 (§3.2, §9).

**One deliberate deviation from the owner text (flag for the owner):** Q0 says Apache sets the
cookie with the `CO` flag and therefore cannot use `__Host-`. Local tests show Apache can set the
same cookie from the handoff with `mod_headers` (`Header always add Set-Cookie "…%{ENV}e…"`),
which allows `__Host-` (host-only, no `Domain`, `Max-Age`). This spec makes that the primary
path and keeps `CO` exactly as the owner described as fallback F1, then the parent-domain cookie
as F2 (§2.3, §2.8). P0b tests all three. Nothing else in the owner's decisions changes.

Verified locally (macOS Apache 2.4.66, PHP 8.5, 127.0.0.1 only, no live host contacted):
- `apache-probe-w5r/run.sh` (revision 2): the exact gate rules of §2.4 with the content
  `.htaccess` of §2.4.3; §8.2 cases A–M incl. the cookie-sourced handoff, the gate-page key
  refresh, the https redirect + HSTS, http dev names and the F1 `CO` variant (results in
  `apache-probe-w5r/logs/run-output.txt`); case P: a flipped-case session id is refused on a
  case-sensitive store volume and accepted on macOS's default volume
  (`apache-probe-w5r/logs/case-sensitivity.txt`). Cases N and O (duplicate cookies, traversal)
  are the reviewer's `review-probe/review.sh`, on rules revision 2 does not change.
- `p0b/localtest.sh`: the revised P0b kit of §10 end to end against local Apache + `php -S`
  (13/13 pass).

Markers used below:
- **[P0b-n]** a choice that depends on host probe result n (§10.4). Each one names its fallback.
- **MUST/SHOULD** are normative. Field names, paths, regexes and status codes are exact.

Contents: 0 Overview · 1 Flows · 2 Site host gate · 3 API · 4 Contracts · 5 Backend generator and
publisher · 6 Site · 7 Admin · 8 Tests · 9 Work packages · 10 P0b checklist · 11 Open questions ·
A Privacy notice templates · B Review disposition.

---

## 0. Overview

### 0.1 What wave 5 delivers

| Area | Delivers |
|---|---|
| Gate (site host) | Apache `.htaccess` only. A request passes when the device's cookie names an existing session file in the store and the site is not locked. Everyone else gets one neutral page (pages) or one fixed 403 (data, media, dotfiles), byte-identical for existing and missing paths. |
| API | Followers (stable opaque id, tombstones), personal links (hash only), devices (pending/active/revoked/declined; every device after the first waits for the owner, Q3 c; a cap on active devices), session issuing, revoke person/device, lock (+ optional panic link), privacy notice versions and consent records (D11), "Your data" view/export/delete-me (D12, active devices only), store writer (direct / SFTP / Mac) with a store identity check, repair and restore handling, rate limits. |
| Contracts | `packages/contracts/src/access.ts` (all new payloads), new settings keys, release/hold/bucket policy functions, `publishedPostId`, shared vectors, JSON Schema export. |
| Backend | Gate tree generation (root `.htaccess`, neutral page, `/_/` gate pages, 403 body, robots, icons), content `.htaccess` with the same gate block, P0 safety fixes, Q1/Q2 options, two-root publishing with the anonymous-refused check, the Mac fallback store writer, Q9 config. |
| Site | Static gate pages (join + info screen, wait, ended, your data, info re-confirm, panic) as a small vanilla-TS bundle; SPA: access-ended handling, hello, menu "Your data" / "Sign out on this device", here-now modes, part-of-day times. |
| Admin | People (create with name, share link once, devices approve/decline/remove, end access, export, delete, tombstones), Lock, Privacy settings with versions, Safety settings, Home badges/cards, immediate (non-queued) access client. |

Not in wave 5 (wave 6): request-access form and inbox, follower contact messages, follower
e-mail and notifications, reactions, views/analytics, activity overview.

### 0.2 Architecture

```
 follower browser                                   site host (Apache + .htaccess only, NO PHP)
 ───────────────                                    ───────────────────────────────────────────
 taps https://<site>/_/join/#t=<link secret>  ───▶  /_/join/  static page + /_/assets/gate-*.js
   │  fetch (CORS, text/plain JSON, no cookies)        │
   ▼                                                   │  every other request:
 API  https://<api>/api/v1/public/…                    │   cookie __Host-omw=<fid>.<did>.<sid>
   │ registers device, records consent,                │   RewriteCond <store>/s/<fid>/<did>.<sid> -f
   │ writes  <store>/s/<fid>/<did>.<sid>               │   and <store>/locked absent
   │         <store>/h/<did>   (handoff marker)        │   → serve natively, else neutral / 403
   │ returns {handoff:'/_/h/', session, deviceKey}     │
   ▼                                                   │
 JS writes __Host-omw_k=<k> (Strict) and               │
   __Host-omw_s=<fid>.<did>.<sid> (120 s), then        │
 location.replace('/_/h/')  (no secret in the URL) ──▶ .htaccess: Strict key cookie + transfer cookie
                                                       + marker + session exist, not locked →
                                                       Set-Cookie __Host-omw (HttpOnly, Lax)
                                                       Set-Cookie __Host-omw_k (JS-readable, Strict)
                                                       expire __Host-omw_s; 303 → /<secret>/

 store writer (API side):  direct filesystem [P0b-1] │ SFTP via phpseclib, restricted account [P0b-2] │ none → Mac
 admin PWA (owner's phone) ──▶ API admin routes (session cookie + CSRF, unchanged)
 backend (Mac) ──SFTP──▶ gate tree at the web root + content tree at /<secret>/ (publisher)
              ──HTTPS─▶ API backend routes (change feed incl. new settings; access ops fallback)
```

Data ownership additions: the API is primary for followers, tombstones, link hashes, devices,
consents, notice versions, lock and the store's desired state. The store on the site host is a
projection of that state (plus store tombstones that survive an API restore, §3.8.6). The backend
never receives follower names.

### 0.3 Identifiers and secrets

| Thing | Format | Where | Stored by the API as |
|---|---|---|---|
| Follower id `fid` | `^[a-z2-7]{12}$` (base32 of 8 random bytes, first 12 chars; 60 bits) | cookie, store paths, all follower data | plain (PK), never reused (tombstones stay) |
| Device id `did` | `^[a-z2-7]{8}$` (40 bits), globally unique | cookie, store paths | plain (PK) |
| Token (link secret `t`, session id `sid`, device key `k`, panic key) | `^[A-Za-z0-9_-]{43}$` = base64url(32 random bytes), no padding | link fragment / cookie / store file name / cookie / panic fragment | lowercase hex sha256 of the 43-char string; `sid` and `k` never stored in clear (one exception: §3.8.3 `pending_sid`) |
| Gate cookie value ("session value") | `<fid>.<did>.<sid>` (65 chars) | `__Host-omw`; for ≤ 120 s also the JS-set transfer cookie `__Host-omw_s` | – |
| Handoff path | the fixed path `/_/h/` (carries no secret) | one navigation | – |
| Store id | `^[0-9a-f]{16}$` (8 random bytes), written once at store init | store marker, `access_state.store_id` | plain |
| Personal link | `<SITE_ORIGIN>/_/join/#t=<t>` | owner's share sheet | `followers.link_hash` |

Random generation: PHP `random_bytes`, TS `crypto.getRandomValues`. Comparison of presented
tokens: look up by `sha256` hash (unique index), never by prefix.

---

## 1. Flows

### 1.1 First device (follower has never had an approved device)
1. Owner: Admin → People → "Invite a person" → name "Oma" → API creates `fid`, link secret,
   returns the link once → owner shares it (WhatsApp / share sheet).
2. Oma taps the link. `/_/join/` loads (static). JS reads `#t`, removes the fragment from the
   address bar (`history.replaceState`), calls `POST join/check {t, k?}`.
3. API answers `ok` with `follower.name`, the current privacy notice (all locales) and
   `deviceMustWait: false`. The page shows the **information screen** (D11): "Dieser Link ist
   für Oma." + the notice + "Weiter" (not pre-ticked, no checkbox needed: the button is the
   confirmation) + "Abbrechen".
4. "Weiter" → `POST join {t, consentVersion, locale, k?}` → API records consent, creates device
   `did` (state `active`, first device), creates key `k`, issues a session (`sid`), writes
   `s/<fid>/<did>.<sid>` and `h/<did>` to the store, returns
   `{status:'active', handoff:'/_/h/', session:'<fid>.<did>.<sid>', deviceKey}`.
5. JS writes the key cookie `__Host-omw_k=<k>` (`SameSite=Strict`; JS-set, so a failed handoff can
   resume) and the **transfer cookie** `__Host-omw_s=<fid>.<did>.<sid>` (`Max-Age=120`,
   `SameSite=Strict`), then `location.replace('/_/h/')`. No secret ever appears in a URL.
6. Apache checks: the Strict key cookie is present (it is never sent on a cross-site navigation,
   which rules out login fixation), the transfer cookie names an existing session file, the
   handoff marker exists, the site is not locked → sets `__Host-omw` (HttpOnly), re-sets
   `__Host-omw_k` server-side (400 days, not subject to ITP's 7-day cap), expires `__Host-omw_s`,
   sets `__Host-omw_h=1` (10 min) and 303 → `/<secret>/` → language picker → `/<secret>/de/`.
   Any failure → 303 → `/_/join/#handoff-failed` (one retry, then resume, §6.2.1).
7. The SPA starts, sees `__Host-omw_h`, calls `POST me/hello {k}` → API deletes the handoff
   marker (one-time), updates last seen, returns the follower name for the footer.

Residual of Q3 c (accepted by the owner's decision, stated in OPERATIONS): whoever opens a fresh
personal link **first** gets the person's first device without approval. If the link was forwarded
before the person used it, the owner sees a device she does not expect and removes it (or rotates
the link). That device has the D12 rights of an active device (§3.3) until she does.

### 1.2 Any later device (Q3 c)
Steps 2–4 as above, but `deviceMustWait: true` is shown on the info screen ("Dieses Gerät muss
noch bestätigt werden") and `join` answers `{status:'pending', deviceKey}`. The page stores `k`
(JS cookie) and goes to `/_/wait/`; that page load already makes Apache re-set the key cookie
server-side (400 days, §2.3.1), so Safari's 7-day cap on script cookies cannot strand a device that
waits longer for approval. The API raises the `devices_pending` alert (push without names:
"📱 1 neues Gerät wartet") and the admin shows the device (label "iPhone · Safari", time).
The wait page polls `POST device/poll {k}`. Owner taps "Allow" → device `active` (refused with
`device_limit` when the person already has `ACCESS_MAX_DEVICES` active devices, §3.3). The next
poll issues the session and returns `{status:'active', handoff:'/_/h/', session}` → steps 5–7.
"Decline" → device `declined` → poll returns `ended` → `/_/ended/`. Reopening the personal link
on a waiting device goes straight back to `/_/wait/` (`pending_device`, no second device).

### 1.3 Resume (same device, session file missing)
A device with a valid key whose gate cookie is refused (store lost, webspace restore, the 400-day
cookie expired) sees the neutral page. The neutral page's inline script sees `__Host-omw_k`, and
(at most once per 5 minutes, remembered in the cookie `__Host-omw_r`) goes to `/_/join/#resume` →
`POST join {resume: true, k}` (no `t`) → active device and not locked → new session +
`{handoff, session}` → steps 5–6 → in. Revoked/declined → `/_/ended/`. Locked → "Gerade nicht
verfügbar". The personal link on a known active device goes to `/` (its session is usually valid;
if not, this resume chain takes over), never creating a device or an approval.

### 1.4 Revoke a device / a person (D2, D8)
Owner taps "Remove device" or "End access" → API sets states, writes store tombstones, deletes
the session file(s) and handoff marker (immediate store write, §3.10 latency). The device's next
request to the site gets the neutral page / 403. Data stays (D8). The SPA, on its next data
request, gets 403 → asks `me/hello` → `ended` → `/_/ended/`.

### 1.5 Lock / unlock (Q6)
Lock writes `<store>/locked`; every request (followers included) gets the neutral page / 403;
no Clear-Site-Data. Unlock (password re-entry) deletes it; cookies still work, nothing to re-join.

### 1.6 Delete me (D12)
`/_/me/` (on an active device, or a device that ended together with the person's access, §3.3
"D12 rights") → "Meine Daten löschen…" → deliberate confirmation (§6.2.6) → `POST me/delete` →
API erases everything referencing `fid`, keeps an anonymous tombstone (`fid`, `deleted_at`,
`deleted_by`, no name, no invitation date), revokes all sessions, queues the owner notice "Eine
Person hat ihre Daten gelöscht" (no name). The page clears `__Host-omw_k` and site storage and
shows "Deine Daten wurden gelöscht". A waiting (pending) or declined device sees only its own
device entry and can withdraw its request; it can neither read nor delete the person's data.

### 1.7 Changed privacy text
The owner publishes notice version N+1. On the next visit (every SPA start, at most once per 5
minutes per tab, and when a tab becomes visible again after ≥ 30 minutes; always after a
handoff, §6.3) `me/hello` returns `notice.required: true` → SPA navigates to
`/_/info/#reconfirm` → info screen → "Weiter" → `me/consent` → back to the journey.

---

## 2. The gate on the site host (no PHP)

### 2.1 Layout of the site docroot (SFTP root `/` of the site account)

```
/.htaccess                  root rules (§2.4.2), generated, uploaded LAST in the gate tree
/index.html                 = the neutral page bytes (safety net while /.htaccess is missing)
/robots.txt                 "User-agent: *\nDisallow: /\n"
/favicon.svg                generic icon (a soft dot; never the portrait, no travel motif)
/_/index.html               = the neutral page bytes
/_/n/index.html             THE neutral page (target of every refusal, §2.5)
/_/403.txt                  "Forbidden\n" (fixed 403 body for data, media and dot paths)
/_/join/  /_/info/  /_/wait/  /_/ended/  /_/me/  /_/panic/     index.html each (§2.6, §6.2)
/_/assets/gate-<hash>.js, gate-<hash>.css (+ chunks)          gate bundle (public, no personal data)
/.omw-gate.json             gate-tree deploy record (publisher; dot path → 403)
/<secret>/                  content tree = today's OUT_DIR with basePath "/<secret>/"; has its own
                            /.htaccess with the SAME gate block (§2.4.3) and /.omw-deploy.json.gz
/.omw-store/                ONLY in fallback layout F3 (§2.8)
/.well-known/               never touched (ACME)
```

`<secret>`: `^[a-z0-9]{20}$`, chosen once (backend config, §5.1), part of `SITE_PUBLIC_URL`. It is
a thin layer (stops hostname-only scanners; leaks with any shared deep link). Rotation = new
`SITE_PUBLIC_URL` + full deploy + legacy cleanup (§5.6.4); bookmarks keep working because `/`
redirects followers to the current `/<secret>/`.

### 2.2 Session-file store

**Where.** Preferred: outside every docroot, `STORE = <account home>/omw-store/<siteKey>`
(`siteKey` default `site1`) **[P0b-3: Apache can `-f` there]**. Fallback F3:
`STORE = <site docroot>/.omw-store` (§2.8). The absolute path as Apache sees it is baked into
both `.htaccess` files (`ACCESS_STORE_DIR`, backend) and used by the direct writer
(`ACCESS_STORE_DIR`, API). Writers that use SFTP address it relative to their SFTP root
(`ACCESS_STORE_SFTP_ROOT` API, `accessStoreRoot` backend target). `ACCESS_STORE_DIR` must match
`^/[A-Za-z0-9._/-]+$` with no `..` segment and no `//` (it goes into `RewriteCond` test strings,
so `%`, `$`, spaces and quotes can never appear).

**Store identity (one store, proven end to end).** Three settings must name the same folder: the
backend's `ACCESS_STORE_DIR` (what Apache reads), the API writer's path and the Mac's
`accessStoreRoot`. Nothing in the paths themselves proves that, so:
1. The store is initialised once by an explicit admin action ("Website-Speicher einrichten",
   `POST /admin/access/store-init`): the API creates `access_state.store_id` (16 hex) and enqueues
   the op `init`, which writes the marker **only if no marker exists**.
2. Every writer (API or Mac) reads the marker before applying anything and refuses (alert
   `access_store_unverified`, ops stay pending) unless it exists with the same `storeId` and
   `epoch` (the `init` op itself and the restore rules of §3.8.6 are the only exceptions). A
   missing marker therefore stops all writers until the owner initialises again (same `storeId`).
3. The heartbeat reports the backend's `storeDir`; with `ACCESS_STORE_MODE=direct` the API compares
   it with its own `ACCESS_STORE_DIR` (alert `access_store_unverified` on a difference).
4. The post-deploy gate check and the API's periodic store proof (§5.6.3, §3.9) show that a session
   the writer just **created** is accepted by Apache and the one it just **deleted** is refused.
   Only that proves the writer writes the folder Apache reads; until it has passed once after a
   writer or path change, the admin shows "Zugang noch nicht geprüft".

**Layout.**

| Path (relative to STORE) | Content | Meaning | Written by |
|---|---|---|---|
| `.omw-store.json` | `{"format":1,"storeId":"<16 hex>","epoch":"<16 hex>","op":<last applied op id>,"at":"<ISO>"}` | store marker; identity (above) and restore detection (§3.8.6) | `init` (exclusive), then every op batch (rewritten; the only rewritten file) |
| `s/<fid>/<did>.<sid>` | empty | the device's current session is valid | session issue |
| `h/<did>` | empty | one handoff for this device may be used | session issue; deleted after use (§2.3.3) |
| `locked` | `{"at":"<ISO>","by":"admin"\|"panic"\|"mac"}` | site locked for everyone | lock |
| `t/<fid>` | `{"s":"revoked"\|"deleted","at":"<ISO>"}` | person tombstone (survives an API restore) | revoke person / delete |
| `t/<fid>.<did>` | `{"s":"revoked","at":"<ISO>"}` | device tombstone | revoke device / sign out |
| `.htaccess` | `Require all denied` + `Options -Indexes` | F3 only: deny HTTP access | writer init, verified by repair |

Nothing in any file is secret. **The secret is the session file's name** (`sid`, 256 bits): whoever
can list `s/` can mint cookies. That equals "access to the hosting account", which already exposes
all content (accepted residual, proposal §2.2). Hardening: directories mode `0711`, files `0600`
(Apache only needs to traverse to `stat()`; other local users cannot list) **[P0b-4 → fallback
0755/0644]**. Existence-only files (`s/`, `h/`, `locked`, `t/`) are created once with exclusive
create and never rewritten (a rewrite via delete+rename would open a window, e.g. unlock a
locked site). Only `.omw-store.json` is replaced (temp + rename).

Alternative considered and rejected: hashing the file name in Apache (`ap_expr sha1()` with regex
backreferences in `RewriteCond expr`). It depends on less portable ap_expr features and only
helps against read-only leaks of the store, which also leak the content.

### 2.3 Cookies, handoff, SameSite and Secure

#### 2.3.1 Cookies (production, https)

| Cookie | Value | Set by | Attributes | Read by |
|---|---|---|---|---|
| `__Host-omw` | `<fid>.<did>.<sid>` | Apache, handoff + rolling refresh on page loads | `Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax` (no Domain) | Apache gate only |
| `__Host-omw_k` | device key `k` | JS right after `join`/`poll` (`Max-Age=1209600`), then Apache at the handoff, on gate pages and by the rolling refresh | `Path=/; Max-Age=34560000; Secure; SameSite=Strict` (no HttpOnly: JS reads it) | site JS → sent in the JSON body to the API; Apache at the handoff (proof of a same-site navigation) |
| `__Host-omw_s` (transfer) | `<fid>.<did>.<sid>` | JS right before `location.replace('/_/h/')`; Apache expires it at the handoff | `Path=/; Max-Age=120; Secure; SameSite=Strict` | Apache at the handoff only |
| `__Host-omw_h` | `1` | Apache at the handoff | `Path=/; Max-Age=600; Secure; SameSite=Strict` | SPA: "a handoff just happened → hello now" (then JS deletes it) |
| `__Host-omw_r` | `1` | the neutral page's script | `Path=/; Max-Age=300; Secure; SameSite=Strict` | the neutral page's script: resume at most once per 5 min (a cookie, because `Clear-Site-Data: "storage"` wipes `sessionStorage` on every refusal) |

- **SameSite=Lax** on the gate cookie is required: a tap on a link in WhatsApp (or any other app or
  site) is a cross-site top-level navigation; `Strict` would arrive without the cookie and show
  the neutral page. `Lax` still withholds it from cross-site subresource requests and POSTs.
- **Strict** on the key and transfer cookies: they are never needed cross-site (JS on the site
  origin reads and writes them). The handoff requires the Strict key cookie, so a cross-site
  link to `/_/h/` can never complete a handoff (no login fixation, §2.3.2).
- **Secure** everywhere in production. Local http development (`SITE_PUBLIC_URL` with `http:` and a
  loopback host) uses the names `omw`, `omw_k`, `omw_s`, `omw_h`, `omw_r` **without** `Secure` and
  without the `__Host-` prefix; the generator derives this from the URL, nothing else switches it.
- **F1/F2 only:** the server-set cookies carry a `Domain` (F1: the site host, F2: the parent
  domain). JS must write and delete `omw_k`, `omw_s` with the **same** `Domain`
  (`GateBoot.cookieDomain`, `Boot.access.cookieDomain`), else the browser keeps two cookies of one
  name and the first one sent wins (verified: valid-then-stale 200, stale-then-valid 403). In
  `headers` mode both sides are host-only, so they are one cookie.
- **`__Host-` is possible** because the cookies are emitted with `mod_headers`
  (`Header always add Set-Cookie "…%{ENV}e…"`), not with the `CO` flag (which always adds
  `domain=`). Verified locally (§8.2 case B) **[P0b-5 → F1 (CO) → F2 (parent domain)]**.
- **Max-Age 400 days** (Chrome's cap) plus a **rolling refresh**: every gated page response
  (request URI ending in `/`) re-sends both cookies with their current values, so an active
  follower never expires. Data and media responses never carry `Set-Cookie`. The key cookie alone
  is also re-sent on the gate pages `/_/{join,info,wait,ended,me}/` when the request carries it.
- **Safari ITP**: server-set cookies are not subject to the 7-day cap of script-written storage;
  the JS-set `__Host-omw_k` (pending devices, failed handoffs) is replaced by a server-set one on
  the next gate page load (for a pending device: the navigation to `/_/wait/` right after `join`)
  and at the handoff. Home-screen web apps and in-app browsers have their own cookie jars: each is a
  device (first one free, others need the owner's OK, Q3 c). The join page shows a hint in in-app
  browsers ("Öffne den Link am besten in Safari/Chrome").
- **Clear-Site-Data** `"cache", "storage"` is sent with every refusal that carried a gate cookie
  while the site is not locked (stale or revoked). Never `"cookies"` (it would clear the whole
  registrable domain, including the admin) and never during a lock. The stale cookie is not
  expired: the key cookie is what lets a device resume (§1.3).

#### 2.3.2 Handoff (no secret in the URL)

The handoff URL is the fixed path **`/_/h/`**. The credentials travel in two cookies the gate page
writes just before it navigates: the key cookie `__Host-omw_k=<k>` (`SameSite=Strict`) and the
transfer cookie `__Host-omw_s=<fid>.<did>.<sid>` (`Max-Age=120`, `SameSite=Strict`). Apache
answers (rules in §2.4.1):
- the key cookie is present and well-formed AND the transfer cookie is well-formed AND the marker
  `h/<did>` exists AND `s/<fid>/<did>.<sid>` exists AND not locked → **303** to `/<secret>/` with
  `Set-Cookie` for `__Host-omw` (the transfer value), `__Host-omw_k` (the key cookie's value, now
  server-set), `__Host-omw_s=; Max-Age=0` and `__Host-omw_h=1`, plus `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`;
- anything else (no key cookie, no or malformed transfer cookie, marker gone, session gone, locked,
  any other path under `/_/h`) → **303** to `/_/join/#handoff-failed` without cookies (§6.2.1:
  one retry while the transfer cookie lives, else `/`).

Why this shape (it replaces revision 1's `/_/h/<fid>.<did>.<sid>.<k>`, which put the 400-day
session and the device key into browser history, history sync and the host's access log, and let
anyone holding a fresh URL plant their identity in another browser with a cross-site link):
- **No secret in a URL:** history, history sync, access logs and `Referer` only ever see `/_/h/`.
  `location.replace` and the 303 also keep `/_/h/` itself out of the history.
- **No login fixation:** browsers never send `SameSite=Strict` cookies on a cross-site navigation,
  so an attacker's link to `/_/h/` arrives without the key cookie and fails; the attacker cannot set
  `__Host-` cookies for the site origin either (verified: transfer cookie alone, no cookies, old
  4-part URL → all refused).
- **Residual:** the session value sits in a JS-readable cookie for ≤ 120 s, which equals what the
  page's JS holds anyway (it received it from the API). A browser that blocks script-written
  cookies entirely cannot join; such browsers also cannot keep the key cookie and were never
  supported.

#### 2.3.3 One-time semantics

The marker `h/<did>` limits how long a transfer value can be turned into server cookies:
1. The API writes the marker together with the session file (same op batch) and records
   `devices.handoff_at`.
2. The SPA's first start after the handoff sees `__Host-omw_h`, deletes it and any leftover
   `__Host-omw_s` (JS), and calls `me/hello {k}`. The API, seeing `handoff_at IS NOT NULL` for
   that device, enqueues `delete h/<did>` and sets `handoff_at = NULL` (applied at once by the
   writer, §3.8).
3. Cron deletes markers whose `handoff_at` is older than 10 minutes (covers JS-less visits).
4. Issuing a new session, revoking, signing out and deleting always delete the marker.

Worst case a handoff can be completed for ≤ 15 minutes (10-minute TTL + 5-minute cron), and only
by a browser that holds both the device's key cookie and the transfer value, i.e. that device.

### 2.4 Generated `.htaccess` files (exact)

Placeholders: `{{STORE}}` absolute store path without trailing slash; `{{SECRET}}` the content
folder; `{{CK}}`/`{{KK}}`/`{{SK}}`/`{{HK}}` cookie names (`__Host-omw`/`__Host-omw_k`/
`__Host-omw_s`/`__Host-omw_h`, or `omw`/`omw_k`/`omw_s`/`omw_h` for http dev); `{{SEC}}` =
`Secure; ` or empty; `{{HOST}}` the site host; `{{CSP_N}}`/`{{CSP_G}}` (§2.5); `{{CT}}` = the
`mod_mime` block of today's `extras.ts` `htaccess()`. Lines marked `[https]` are emitted only when
`SITE_PUBLIC_URL` is https **and** `ACCESS_HTTPS_REDIRECT=true` (§5.1, **[P0b-10]**); lines marked
`[hsts]` only when `SITE_PUBLIC_URL` is https.

#### 2.4.1 The gate block (byte-identical in both files)

```apache
# >>> omw gate v1 (generated; identical in both .htaccess files; never edit) >>>
RewriteEngine On
RewriteOptions InheritDownBefore AllowNoSlash
DirectorySlash Off
RewriteCond %{REQUEST_URI} ^/\.well-known/acme-challenge/[A-Za-z0-9_-]+$
RewriteRule ^ - [L]
RewriteCond %{HTTPS} !=on                                                    [https]
RewriteRule ^ https://{{HOST}}%{REQUEST_URI} [R=301,L]                       [https]
RewriteCond %{REQUEST_URI} (?:^|/)\.
RewriteRule ^ - [F,L]
RewriteCond %{REQUEST_URI} =/_/h/
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{KK}}=([A-Za-z0-9_-]{43})(?:;|$)
RewriteRule ^ - [E=OMW_HK:%1]
RewriteCond %{ENV:OMW_HK} ^[A-Za-z0-9_-]{43}$
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{SK}}=([a-z2-7]{12})\.([a-z2-7]{8})\.([A-Za-z0-9_-]{43})(?:;|$)
RewriteCond {{STORE}}/h/%2 -f
RewriteCond {{STORE}}/s/%1/%2.%3 -f
RewriteCond {{STORE}}/locked !-f
RewriteRule ^ /{{SECRET}}/ [R=303,L,E=OMW_SET:%1.%2.%3,E=OMW_KEY:%{ENV:OMW_HK}]
RewriteCond %{REQUEST_URI} ^/_/h(?:/|$)
RewriteRule ^ /_/join/#handoff-failed [R=303,L,NE]
RewriteCond %{REQUEST_URI} ^/_/(?:n|join|info|wait|ended|me|panic)$
RewriteRule ^ %{REQUEST_URI}/ [R=301,L]
RewriteCond %{REQUEST_URI} ^/_/(?:join|info|wait|ended|me)/$
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{KK}}=([A-Za-z0-9_-]{43})(?:;|$)
RewriteRule ^ - [E=OMW_RK:%1]
RewriteCond %{REQUEST_URI} ^/(?:_/|robots\.txt$|favicon\.svg$)
RewriteRule ^ - [L]
RewriteCond {{STORE}}/locked !-f
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{CK}}=([a-z2-7]{12})\.([a-z2-7]{8})\.([A-Za-z0-9_-]{43})(?:;|$)
RewriteCond {{STORE}}/s/%1/%2.%3 -f
RewriteRule ^ - [E=OMW_OK:1,E=OMW_C:%1.%2.%3]
RewriteCond %{ENV:OMW_OK} =1
RewriteCond %{REQUEST_FILENAME} -d
RewriteCond %{REQUEST_URI} [^/]$
RewriteRule ^ %{REQUEST_URI}/ [R=301,L]
RewriteCond %{ENV:OMW_OK} =1
RewriteCond %{REQUEST_URI} =/
RewriteRule ^ /{{SECRET}}/ [R=302,L]
RewriteCond %{ENV:OMW_OK} =1
RewriteCond %{REQUEST_URI} /$
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{KK}}=([A-Za-z0-9_-]{43})(?:;|$)
RewriteRule ^ - [E=OMW_RK:%1]
RewriteCond %{ENV:OMW_OK} =1
RewriteCond %{REQUEST_URI} /$
RewriteRule ^ - [E=OMW_RC:%{ENV:OMW_C}]
RewriteCond %{ENV:OMW_OK} =1
RewriteRule ^ - [L]
RewriteCond {{STORE}}/locked !-f
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{CK}}=
RewriteRule ^ - [E=OMW_STALE:1]
RewriteCond %{REQUEST_URI} ^/[^/]+/(?:data|media)/
RewriteRule ^ - [F,L]
RewriteRule ^ /_/n/index.html [END]
Header always set Vary "Cookie"
Header always set X-Robots-Tag "noindex, nofollow, noarchive"
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=OMW_STALE
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=REDIRECT_OMW_STALE
# <<< omw gate v1 <<<
```

The `[https]`/`[hsts]` tags are not part of the emitted text (the generator drops the tag, or the
whole line). Why each part (all verified in `apache-probe-w5r/run.sh`):
- Every path test uses `%{REQUEST_URI}`. Per-directory patterns are relative to whichever file's
  merged rules run, and match the full filesystem path for a directory requested without its
  slash (proposal Appendix B, R1/R2). `InheritDownBefore` runs the root's copy first in the
  content directory, so rules a child file adds before or after cannot pre-empt it.
- `DirectorySlash Off` + `AllowNoSlash`: no 301 oracle for existing directories; the follower
  rule re-adds the slash redirect for sessions only.
- The https redirect (production, **[P0b-10]**) comes right after the ACME pass-through (http-01
  challenges stay on http) and before everything else; it is uniform for every path (verified:
  existing and missing paths, data, dot paths and `/_/h/` all get the same 301 shape). It uses the
  configured host, never `%{HTTP_HOST}`. It is emitted only when P0b shows that `%{HTTPS}` is `on`
  for https requests (behind a TLS-terminating proxy it would loop).
- Handoff: `%1..%3` come from the transfer cookie (the last *regex* condition) and survive the
  following `-f` conditions; the key value is carried in `OMW_HK` from the rule before, and the
  handoff rule only fires when that rule matched (the Strict key cookie was sent). Every failure,
  including `/_/h` without slash and old 4-part URLs, goes to the one fixed target
  `/_/join/#handoff-failed` (`NE` keeps the `#`).
- Key refresh on gate pages: a pending device's JS-set key cookie becomes server-set on its next
  gate page load (exactly one `Set-Cookie`, only when the request carries a well-formed key cookie;
  never on the neutral page or `/_/assets/`).
- Anonymous answers: pages (any path, existing or not, incl. `/<secret>/assets/*.js`) → 200 with
  the neutral page bytes; `/<x>/data/…`, `/<x>/media/…` and every dot path → 403 with `/_/403.txt`.
  Status, headers and size are identical for existing and missing paths (case H).
- Lock: `locked` present → nobody sets `OMW_OK`, nobody gets `OMW_STALE` (no Clear-Site-Data).

#### 2.4.2 Root `/.htaccess`

```apache
# Generated by the On My Way site generator (gate tree). Do not edit: rewritten by the publisher.
Options -Indexes -MultiViews
DirectoryIndex index.html
ErrorDocument 403 /_/403.txt
ErrorDocument 404 /_/n/index.html
{{CT}}
{{GATE BLOCK §2.4.1}}
# >>> omw gate cookies v1 (root only) >>>
Header always add Set-Cookie "{{CK}}=%{OMW_SET}e; Path=/; Max-Age=34560000; {{SEC}}HttpOnly; SameSite=Lax" env=OMW_SET
Header always add Set-Cookie "{{KK}}=%{OMW_KEY}e; Path=/; Max-Age=34560000; {{SEC}}SameSite=Strict" env=OMW_KEY
Header always add Set-Cookie "{{SK}}=; Path=/; Max-Age=0; {{SEC}}SameSite=Strict" env=OMW_SET
Header always add Set-Cookie "{{HK}}=1; Path=/; Max-Age=600; {{SEC}}SameSite=Strict" env=OMW_SET
Header always add Set-Cookie "{{CK}}=%{OMW_RC}e; Path=/; Max-Age=34560000; {{SEC}}HttpOnly; SameSite=Lax" env=OMW_RC
Header always add Set-Cookie "{{CK}}=%{REDIRECT_OMW_RC}e; Path=/; Max-Age=34560000; {{SEC}}HttpOnly; SameSite=Lax" env=REDIRECT_OMW_RC
Header always add Set-Cookie "{{KK}}=%{OMW_RK}e; Path=/; Max-Age=34560000; {{SEC}}SameSite=Strict" env=OMW_RK
Header always add Set-Cookie "{{KK}}=%{REDIRECT_OMW_RK}e; Path=/; Max-Age=34560000; {{SEC}}SameSite=Strict" env=REDIRECT_OMW_RK
Header always set Strict-Transport-Security "max-age=31536000"                [hsts]
<If "%{REQUEST_URI} =~ m#^/_/(?!assets/)#">
    Header always set Cache-Control "no-store"
    Header always set Referrer-Policy "no-referrer"
    Header always set X-Content-Type-Options "nosniff"
</If>
<If "%{REQUEST_URI} =~ m#^/_/(?:n/|index\.html$|$)#">
    Header always set Content-Security-Policy "{{CSP_N}}"
</If>
<If "%{REQUEST_URI} =~ m#^/_/(?:join|info|wait|ended|me|panic)/#">
    Header always set Content-Security-Policy "{{CSP_G}}"
</If>
<If "%{REQUEST_URI} =~ m#^/_/assets/#">
    Header always set Cache-Control "public, max-age=31536000, immutable"
</If>
# <<< omw gate cookies v1 <<<
```

`apache-probe-w5r/gate-block.in` and `root-extra.in` carry this section's exact text (the
`[https]`/`[hsts]` lines as `#HTTPS#`/`#HSTS#` switches); `run.sh` passes with them (incl. the
`{{SK}}` expiry and the `{{HK}}` cookie), and the CSP / `X-Robots-Tag` / `Cache-Control` /
`Strict-Transport-Security` headers were checked on a refused day URL (`{{CSP_N}}`, `no-store`),
`/_/join/` (`{{CSP_G}}`) and `/_/assets/…` (`public, immutable`). HSTS is sent unconditionally in
production (browsers ignore it on http, so no `%{HTTPS}` guard is needed); no `includeSubDomains`
(other hosts under the parent domain are not ours to pin).

The `Set-Cookie` lines live only in the root file: `Header` directives of both files merge for
content requests, so a copy in the content file would emit every cookie twice. Losing the root
file (publisher window) only stops cookie refresh, never the gate. The `<If>` blocks match the
URI after internal redirects, so the neutral page served for any refused path gets
`Cache-Control: no-store` and `{{CSP_N}}` (verified: case H headers).

#### 2.4.3 Content `/<secret>/.htaccess` (gate mode)

Today's `htaccess(site)` from `extras.ts` with these changes, then the gate block appended
(`contentHtaccess(site, cfg)`; the exact gate-mode output is `apache-probe-w5r/content.in` + the
block):
- drop the `<FilesMatch "^\.">` / `Require all denied` block: the gate's dot rule (403 for every
  dot path, followers included) and the server's `.ht*` deny cover it, and §5.5 forbids `Require`
  outside the gate block (verified: no difference in any answer);
- add `ErrorDocument 403 /_/403.txt` (keep `ErrorDocument 404 /<secret>/404.html`: only followers
  ever reach a 404 inside the content tree);
- every `Cache-Control` becomes private: html/json/xml/txt → `private, no-cache`;
  js/mjs/css/woff2/avif/webp/jpg/mp4/m4a → `private, max-age=31536000, immutable`; the media
  pattern stays `private, max-age=31536000, immutable` (D5: all gated responses private);
- `Referrer-Policy "same-origin"` (instead of `strict-origin-when-cross-origin`).

In open mode (`ACCESS_MODE=open`, dev/fixtures) the content `.htaccess` stays exactly as today.

### 2.5 Neutral page, 403 body, CSP

Neutral page `/_/n/index.html` (also `/index.html`, `/_/index.html`): a fixed template with no
content field. Language order follows `site.default_locale` (de first, else en first); nothing
else varies. Exact structure (inline CSS and script are fixed strings; their CSP hashes go into
`{{CSP_N}}`):

```html
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Privat · Private</title>
<meta property="og:title" content="Privat · Private">
<meta property="og:type" content="website">
<style>/* fixed: cream→lilac wash, plum ink, rose button; dusk palette in dark mode; no images */</style>
</head>
<body>
<main>
<h1><span lang="de">Privat</span> · <span lang="en">Private</span></h1>
<p lang="de">Diese Seite ist nur mit persönlicher Einladung sichtbar.</p>
<p lang="en">This page is only visible with a personal invitation.</p>
<details>
<summary><span lang="de">Du hast einen persönlichen Link?</span> · <span lang="en">Have a personal link?</span></summary>
<p><span lang="de">Öffne ihn auf diesem Gerät oder füge ihn hier ein.</span> <span lang="en">Open it on this device or paste it here.</span></p>
<form id="p"><input id="u" type="url" inputmode="url" autocomplete="off" aria-label="Link"><button type="submit">→</button></form>
</details>
</main>
<script>/* NEUTRAL_SCRIPT, below */</script>
</body>
</html>
```

`NEUTRAL_SCRIPT` (generator constant; `{{KK}}`, `{{RK}}` (`__Host-omw_r` / `omw_r`) and `{{SEC}}`
substituted):
```js
(function(){try{var c=document.cookie.split('; '),h=function(n){return c.some(function(x){return x.indexOf(n+'=')===0})};if(h('{{KK}}')&&!h('{{RK}}')){document.cookie='{{RK}}=1; Path=/; Max-Age=300; {{SEC}}SameSite=Strict';location.replace('/_/join/#resume');return;}}catch(e){}var f=document.getElementById('p');if(f)f.addEventListener('submit',function(e){e.preventDefault();var m=/#t=([A-Za-z0-9_-]{43})/.exec(document.getElementById('u').value);if(m)location.assign('/_/join/#t='+m[1]);});})();
```
The throttle lives in a cookie because every refusal with a stale gate cookie carries
`Clear-Site-Data: "cache", "storage"`, which empties `sessionStorage` but never cookies; a
`sessionStorage` throttle would let a failing device loop resume → issue until the rate limit.
The throttle cookie is only ever written by JS, so it needs no `Domain` in F1/F2.
(The paste field serves home-screen apps and in-app browsers, which cannot open a link inside
themselves. The neutral page never contacts the API: no API origin appears on it, D3. Wave 6 adds
the "request access" button and sheet to this page; wave 5 ships none.)

`{{CSP_N}}` = `default-src 'none'; script-src 'sha256-<NEUTRAL_SCRIPT>'; style-src 'sha256-<CSS>'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`.
`{{CSP_G}}` = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src {{API_ORIGIN}}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`.

`/_/403.txt` = `Forbidden\n`. Link previews (WhatsApp, iMessage, mail scanners) of any URL get
the neutral page (no cookie): title "Privat · Private", no image, no description.

### 2.6 Gate pages (static)

Each of `/_/{join,info,wait,ended,me,panic}/index.html` is generated (§5.4) from one template:
`<html lang dir>`, title "Privat · Private" (no personal OG), `<link rel=stylesheet>` +
`<script type=module>` of the gate bundle, a `<noscript>` line ("Bitte JavaScript aktivieren /
Please enable JavaScript"), and the boot JSON `<script type="application/json" id="omw-gate">`
(contract `GateBoot`, §4.2). The page markup is an empty `<main id="omw-gate-root">`; the bundle
renders the states (§6.2). The pages contain no personal data and no content path (`<secret>`
never appears in the gate tree). They name the API origin (unavoidable for `fetch`; the API
hostname is in the same CT logs as the site anyway).

### 2.7 Fail-open and oracle analysis (results of `apache-probe-w5r/run.sh` and `review-probe/review.sh`)

| Case | Result |
|---|---|
| Both files present (G1) | All anonymous answers identical; followers served; store unreachable over HTTP |
| Root `.htaccess` missing (publisher window) | Content still gated by its own copy; root paths show `/index.html` (= neutral bytes) |
| Content `.htaccess` missing | Content still gated by the root copy (`InheritDownBefore`) |
| Content file with extra `RewriteEngine On` / `RewriteRule ^ - [L]` before its rules | Still gated (root copy runs first) |
| Content file containing `RewriteEngine Off` | **Fails open** (rewriting is disabled for that directory, inherited rules included). Guards: the generator and the publisher refuse any `.htaccess` under the content tree other than the generated one; `verify.ts` and the deploy check reject `RewriteEngine Off`, `IgnoreInherit`, `Require`, `Satisfy`, `AuthMerging`, `SetEnvIf*` and any `Rewrite*` line outside the block; the post-deploy anonymous check (§5.6.3) catches it on the live host |
| Both files missing | Content open; caught by the post-deploy check; the publisher re-uploads |
| A stray `.htaccess` in a content subdirectory with `RewriteEngine Off` (also inside `<IfModule>`) | **Fails open for that subtree** (review R7); `RewriteEngine On` there is harmless. Needs SFTP access to plant; guarded by the "no other `.htaccess`" rule of `verify.ts` and the publisher, not by the gate check (it probes only fixed paths). Accepted. |
| Content file with `RewriteOptions IgnoreInherit`/`Inherit`, `Require all granted`, `Options +Indexes` | Still gated (review R6) |
| Store path wrong or store deleted | Fails **closed** (everyone refused); writers refuse to write without the matching store marker (§2.2), alert `access_store_unverified`; after the owner re-initialises, resume via key re-creates sessions |
| Lock file unreadable | Same permission rules as session files; if Apache can `stat` sessions it can `stat` `locked` (P0b-4) |
| Duplicate cookies of one name | The first one in the `Cookie` header wins (review R4); only reachable in F1/F2 through host-only vs `Domain` duplicates, prevented by `cookieDomain` (§2.3.1). A prefixed look-alike name, a quoted value, or a session path that is a directory are refused. |
| Path tricks into the public `/_/` prefix | `/_/../<secret>/data/…`, `/_/%2e%2e/…`, `//<secret>/…`, `?x=/_/` → 403 or the neutral page; `%2f` and `%00` → Apache's default 404 before `.htaccess` runs (uniform, not personal). No bypass (review R3). |

Residual oracles and accepted behaviour: Apache maps the URI to the filesystem and reads
`.htaccess` of existing directories before the rewrite; the timing difference is microseconds (not
zero). `Last-Modified` and `ETag` of the neutral page follow software releases only. `TRACE` is
answered by the server core with a `200 message/http` echo on every path (no content; browsers
cannot send it; `.htaccess` cannot disable it). On macOS's default case-insensitive volume a
session id with flipped case passes `-f` (the Linux host is case-sensitive; the Apache test suite
runs its store on a case-sensitive volume, §8.2).

### 2.8 Fallbacks

| Id | Trigger (P0b) | Change |
|---|---|---|
| **F1** CO flag | T4 fails (no `Set-Cookie` from `mod_headers` env), T5 passes | Cookie names `omw`, `omw_k`, `omw_s`, `omw_h`, `omw_r` (no prefix). The handoff conditions stay as in §2.4.1; its rule becomes `RewriteRule ^ /{{SECRET}}/ [R=303,L,CO=omw:%1.%2.%3:{{HOST}}:576000:/:secure:httponly:lax,CO=omw_k:%{ENV:OMW_HK}:{{HOST}}:576000:/:secure:false:strict,CO=omw_h:1:{{HOST}}:10:/:secure:false:strict,CO=omw_s:x:{{HOST}}:-1:/:secure:false:strict]` (backreferences from the transfer-cookie capture, the key from `OMW_HK`, the transfer cookie expired by a negative lifetime: all verified, `apache-probe-w5r` case K). Refresh: replace `E=OMW_RC:…` by `CO=omw:%{ENV:OMW_C}:{{HOST}}:576000:/:secure:httponly:lax` and both `E=OMW_RK:%1` by `CO=omw_k:%1:{{HOST}}:576000:/:secure:false:strict`. Drop the root cookie section (HSTS stays). The gate JS writes and deletes `omw_k`/`omw_s` with `Domain={{HOST}}` (`cookieDomain`, §2.3.1). Cost: `domain=<site host>` cookies (sent to subdomains of the site host, none exist), `expires` instead of `Max-Age`, no `__Host-` protection: a cookie of the same name set for the parent domain by any other `*.<parent>` site can shadow ours (denial of service; it cannot grant access without a valid session file), and a page on such a sibling host is same-site, so it could also send Strict cookies it planted (fixation needs a hostile sibling host: accepted with F1). |
| **F2** parent-domain cookie | T4 and T5 fail | The API sets the cookies itself in the responses of `join`, `device/poll` and `join` with `resume` (`fetch(..., {credentials:'include'})`; only these routes and `me/hello` answer with `Access-Control-Allow-Credentials: true`): `omw=<fid>.<did>.<sid>; Domain=<ACCESS_COOKIE_DOMAIN>; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax` and `omw_k=<k>; Domain=…; Path=/; Max-Age=34560000; Secure; SameSite=Strict`. No handoff path, no transfer cookie and no marker: the answer is `handoff:'/'` without `session`, and the page navigates to `/`. The gate JS writes and deletes `omw_k` with `Domain=<ACCESS_COOKIE_DOMAIN>`. Refresh: `me/hello` (credentials included) re-sets both cookies when the request's own `omw` cookie hashes to the device's `session_hash`. **Requires site and API under the same registrable domain** (Q9). Cost: the session cookie is sent to every host under that domain (the API host and any other site there can read and overwrite it); no `__Host-`; it breaks when the site moves to a separate domain. |
| **F3** store in the docroot | T3 `out` fails, or no writer can reach a folder outside the site docroot (an `sftp` writer that uses the site's own login sees only the docroot, so it always forces F3) | `STORE = <site docroot>/.omw-store`; the writer creates `STORE/.htaccess` (`Require all denied`, `Options -Indexes`) first and the repair job re-checks its bytes; the dot rule and the server's `.ht*` deny add two more layers. The publisher never lists, uploads or deletes `/.omw-store/`. |
| **F4** world-readable modes | T3 `out711` fails | Directories `0755`, files `0644` (`ACCESS_STORE_DIR_MODE`, `ACCESS_STORE_FILE_MODE`). Other local users on the shared host could list session ids; accept and document. |
| **F5** directives refused | T1/T7 fail (500 or no inheritance) | Stop and report to the owner: without `InheritDownBefore` the stray-rule protection is gone (acceptable with the publisher guards); without `DirectorySlash Off` existing directories leak through 301s (not acceptable: needs a redesign of the content URLs). |
| **F6** no https redirect | P0b-10: `%{HTTPS}` is not `on` for https requests (TLS ends at a proxy) | `ACCESS_HTTPS_REDIRECT=false`: the `[https]` lines are not emitted; HSTS stays (it makes browsers that ever saw the site use https). Ask Hetzner whether http→https can be switched on in konsoleH. |
| **F7** files appear late | P0b-11: T11 needs the 2-second retry, or T12 still sees the deleted file | Document the measured delay in §3.10 and HOSTING; the join page's `#handoff-failed` retry (§6.2.1) already waits 2 s once. If T11 fails even after 2 s, `direct` is not used (P0b-1 → `sftp`/`none`). |

---

## 3. The API

### 3.1 Configuration (`api/.env`, `Config.php`, `.env.example`)

| Key | Default | Meaning |
|---|---|---|
| `SITE_ORIGIN` | – (exists) | Site origin. Now also: personal link base (`<SITE_ORIGIN>/_/join/#t=`), panic link base, the only CORS origin. **Required** when `ACCESS_STORE_MODE` is not `none` or when any follower exists (admin `POST /followers` answers 409 `config_missing` otherwise). |
| `ACCESS_STORE_MODE` | `none` | `direct` \| `sftp` \| `none` (§3.8). **[P0b-1/P0b-2]** |
| `ACCESS_STORE_DIR` | – | `direct`: absolute store path (same string as the backend's `ACCESS_STORE_DIR`), `^/[A-Za-z0-9._/-]+$`, no `..` segment, no `//`. Must be inside `open_basedir`. |
| `ACCESS_STORE_SFTP_HOST`, `_PORT` (22), `_USER`, `_KEY_FILE` (+ `_KEY_PASSPHRASE`) or `_PASSWORD`, `_HOSTKEYS`, `_ROOT` | – | `sftp`: phpseclib login; `_HOSTKEYS` comma-separated `SHA256:<43 base64>` (www99: the two pins from HOSTING §2); `_ROOT` = store path as this SFTP user sees it. Key auth is preferred (`_KEY_FILE` in `var/keys/`, deny-all); a password is accepted. Meant for a **dedicated SFTP account restricted to the store folder** (D4). |
| `ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN` | `false` | Owner decision (§11): `true` allows the `sftp` writer to use a login that can see the site docroot (the site's own SFTP account). With `false` the writer refuses such a login (`StoreWriterException('site_login')`: after connecting, the SFTP root `/` contains any of `.htaccess`, `_`, `index.html`, `.omw-gate.json`) and the API runs as `none` (the Mac writes). Trade-off: with the site login in the API's `.env`, a leaked `.env` or a code-execution bug in the public PHP app lets an attacker rewrite the site's `.htaccess` (remove the gate), read all content and deface the site. |
| `ACCESS_STORE_DIR_MODE` / `ACCESS_STORE_FILE_MODE` | `0711` / `0600` | **[P0b-4 → 0755/0644]** |
| `ACCESS_COOKIE_MODE` | `headers` | `headers` \| `co` \| `parent` (must equal the backend's). Only `parent` (F2) changes API behaviour. |
| `ACCESS_COOKIE_DOMAIN` | – | `parent` only: the shared parent domain, e.g. `schaefchens.de`; must be a dot-suffix of both the site host and the API host (checked at boot). |
| `ACCESS_MAX_DEVICES` | `5` | Active devices per person (1–20). `approve` beyond it answers 409 `device_limit` ("Entferne zuerst ein anderes Gerät"). The first device never counts against a full list (a person has at most this many). |
| `ACCESS_GATE_PROBE` | `false` | Cron probes the site **[P0b-6: outbound HTTPS works]**: the anonymous check once per hour and the store proof once per 6 h (§3.9). |

`Config::fromArray` validates these (mode values, absolute dir and its character set, origin
syntax, octal modes, host-key syntax, device cap range) and throws like the existing keys.
`Doctor` gets a check `access_store` (writer reachable, marker readable with the expected
`storeId`, modes; for `sftp`: a warning when the login can list anything outside the store) and
the admin doctor shows it.

### 3.2 Migrations `api/migrations/0002_settings_w5.sql` (WP0) and `0003_access.sql` (WP1)

Two files, because the new settings keys are required in the exported `Settings.json` from WP0 on
and `ContractSchemaTest::testSeededSettingsMatchSettings` validates the migrated rows against it:
the settings rows must exist as soon as the contract has the keys. `Migrator` applies files in
lexical order, so the split changes nothing at runtime.

`0002_settings_w5.sql` (WP0):

```sql
-- 0002_settings_w5: new settings (Q1/Q2, time precision), announced on the change feed like 0001 did
-- (spec-wave5.md §4.2). Conventions as in 0001.
INSERT INTO settings (key, value, updated_at) VALUES
    ('publish.release_slots',  '{"enabled":false,"times":["08:00","20:00"]}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('publish.departure_hold', '{"enabled":false,"maxDays":7}',               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.here_now',          '"city_badge"',                                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.time_precision',    '"exact"',                                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
INSERT INTO change_log (entity, entity_key, op, data, created_at)
SELECT 'setting', key, 'upsert', json_object('value', json(value)), updated_at FROM settings
WHERE key IN ('publish.release_slots', 'publish.departure_hold', 'site.here_now', 'site.time_precision')
ORDER BY key;
```

`0003_access.sql` (WP1):

```sql
-- 0003_access: followers, devices, privacy notices + consent, lock and the site-store projection
-- (spec-wave5.md §3). Conventions as in 0001 (ISO UTC timestamps with ms, json_valid guards).

CREATE TABLE followers (
    id              TEXT PRIMARY KEY CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z2-7]*'),
    kind            TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'service')),
    state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'deleted')),
    name            TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
    note            TEXT CHECK (note IS NULL OR length(note) <= 200),          -- owner-only memo
    link_hash       TEXT UNIQUE CHECK (link_hash IS NULL OR length(link_hash) = 64),
    link_created_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    revoked_at      TEXT,
    deleted_at      TEXT,
    deleted_by      TEXT CHECK (deleted_by IS NULL OR deleted_by IN ('follower', 'owner', 'restore')),
    -- a tombstone keeps only id, kind, state, deleted_at, deleted_by (D12); created_at and
    -- updated_at are overwritten with deleted_at (the invitation date is not kept), revoked_at is NULL
    CHECK (state <> 'deleted' OR (name IS NULL AND note IS NULL AND link_hash IS NULL AND link_created_at IS NULL AND revoked_at IS NULL AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND created_at = deleted_at)),
    CHECK (state = 'deleted' OR name IS NOT NULL),
    CHECK (state = 'active' OR link_hash IS NULL)
);
CREATE INDEX followers_state ON followers (state, created_at);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY CHECK (length(id) = 8 AND id NOT GLOB '*[^a-z2-7]*'),
    follower_id  TEXT NOT NULL REFERENCES followers (id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked', 'declined')),
    first        INTEGER NOT NULL DEFAULT 0 CHECK (first IN (0, 1)),   -- joined without approval (Q3 c)
    key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
    label        TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60),  -- "iPhone · Safari" (no raw UA)
    session_hash TEXT CHECK (session_hash IS NULL OR length(session_hash) = 64),
    session_at   TEXT,
    pending_sid  TEXT CHECK (pending_sid IS NULL OR length(pending_sid) = 43),  -- §3.8.3 only
    handoff_at   TEXT,
    created_at   TEXT NOT NULL,
    decided_at   TEXT,
    revoked_at   TEXT,
    revoked_by   TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('owner', 'follower', 'system')),
    last_seen_at TEXT,
    CHECK (state = 'active' OR (session_hash IS NULL AND pending_sid IS NULL AND handoff_at IS NULL))
);
CREATE INDEX devices_follower ON devices (follower_id, state);
CREATE INDEX devices_pending ON devices (created_at) WHERE state = 'pending';

-- Privacy notice (D11, Q7): one editable draft, immutable published versions, consent records.
CREATE TABLE privacy_notice_draft (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    notice     TEXT NOT NULL CHECK (json_valid(notice)),   -- contract PrivacyNoticeDraft
    updated_at TEXT NOT NULL
);
CREATE TABLE privacy_notice_versions (
    version      INTEGER PRIMARY KEY CHECK (version >= 1),
    notice       TEXT NOT NULL CHECK (json_valid(notice)), -- contract PrivacyNotice
    sha256       TEXT NOT NULL CHECK (length(sha256) = 64),-- of the canonical JSON
    published_at TEXT NOT NULL
);
CREATE TABLE consents (
    id             INTEGER PRIMARY KEY,
    follower_id    TEXT NOT NULL REFERENCES followers (id) ON DELETE CASCADE,
    device_id      TEXT REFERENCES devices (id) ON DELETE SET NULL,
    notice_version INTEGER NOT NULL REFERENCES privacy_notice_versions (version),
    locale         TEXT NOT NULL,
    confirmed_at   TEXT NOT NULL
);
CREATE INDEX consents_follower ON consents (follower_id, notice_version);

-- Lock, epoch and writer state (single row).
CREATE TABLE access_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    store_id         TEXT CHECK (store_id IS NULL OR length(store_id) = 16), -- NULL until store-init (§2.2)
    epoch            TEXT NOT NULL CHECK (length(epoch) = 16),   -- rotated by the restore bootstrap
    reconciled_epoch TEXT,                                       -- != epoch: joins frozen (§3.8.6)
    locked           INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    locked_at        TEXT,
    locked_by        TEXT CHECK (locked_by IS NULL OR locked_by IN ('admin', 'panic', 'mac')),
    unlocked_at      TEXT,                                       -- sticky-lock import only for newer files (§3.3)
    panic_hash       TEXT CHECK (panic_hash IS NULL OR length(panic_hash) = 64),
    last_applied_op  INTEGER NOT NULL DEFAULT 0,
    last_applied_at  TEXT,
    lease_holder     TEXT CHECK (lease_holder IS NULL OR lease_holder IN ('api', 'mac')),
    lease_until      TEXT,
    writer_blocked_at TEXT,                                     -- SFTP auth failure: no retries
    writer_error     TEXT,
    last_reconcile_at TEXT,
    reconcile_report TEXT CHECK (reconcile_report IS NULL OR json_valid(reconcile_report)), -- StoreReport
    gate_check       TEXT CHECK (gate_check IS NULL OR json_valid(gate_check)), -- GateCheckResult (newest of Mac / cron)
    store_proof_at   TEXT,                                       -- last passed "created accepted + deleted refused"
    updated_at       TEXT NOT NULL
);
INSERT INTO access_state (id, epoch, reconciled_epoch, updated_at)
SELECT 1, e, e, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (SELECT lower(hex(randomblob(8))) AS e);

-- Outbox of store operations, applied strictly in id order by one holder of the lease.
CREATE TABLE store_ops (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch      TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('init', 'put', 'delete', 'delete_prefix', 'delete_tree')),
    path       TEXT NOT NULL,          -- store-relative (StoreLayout regexes); a session put is redacted after apply
    content    TEXT,                   -- put only; never secret
    exclusive  INTEGER NOT NULL DEFAULT 1 CHECK (exclusive IN (0, 1)), -- put: never overwrite (0 only for the marker)
    created_at TEXT NOT NULL,
    applied_at TEXT,
    applied_by TEXT CHECK (applied_by IS NULL OR applied_by IN ('api', 'mac')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX store_ops_pending ON store_ops (id) WHERE applied_at IS NULL;

-- Rate limiting (hashed subjects; pruned after 48 h).
CREATE TABLE rate_events (
    bucket TEXT NOT NULL,              -- "<kind>:<first 32 hex of sha256(subject + meta.rl_salt)>"
    at     TEXT NOT NULL
);
CREATE INDEX rate_events_bucket ON rate_events (bucket, at);
INSERT INTO meta (key, value) VALUES ('rl_salt', lower(hex(randomblob(16))));

-- One-shot owner notices without names ("A follower deleted their data").
CREATE TABLE owner_notices (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('follower_deleted', 'restore_reconciled', 'store_mismatch')),
    data         TEXT CHECK (data IS NULL OR json_valid(data)),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    read_at      TEXT
);
```

The draft notice is seeded lazily from `api/src/Domain/Access/privacy-template.json` (Appendix A)
when `GET /admin/privacy` finds no draft row. No version exists until the owner publishes one.

### 3.3 Domain rules

Services (namespace `Omw\Api\Domain\Access`): `Tokens`, `StoreLayout`, `Followers`, `Devices`,
`Sessions`, `PrivacyNotices`, `Consents`, `AccessState`, `StoreOps`, `StoreApplier`,
`Reconciler`, `FollowerData`, `UserAgentLabel`, `OwnerNotices`. All writes run in
`Db::write()` (BEGIN IMMEDIATE); store ops are enqueued **in the same transaction** as the state
change and applied **after commit** (§3.8.3). **No database transaction ever spans a filesystem
or SFTP call** (§3.8.3). No access state is ever written to `change_log` (the backend never
mirrors followers).

**Followers**
1. `create(name, note?)`: name = AuthorName rules (1–60, one trimmed line); id = random fid,
   retried up to 5 times against ALL rows (tombstones included: never reused, D6); link secret
   `t` → `link_hash`, `link_created_at`. Returns `PersonalLink {url, createdAt}` once.
2. `rotateLink(fid)`: active only; new `t`; the old link stops working; devices unaffected.
3. `patch(fid, {name?, note?})`: active or revoked.
4. `revoke(fid)` (D2): state `revoked`, `link_hash`/`link_created_at` NULL, `revoked_at = now`;
   every device `pending` → `declined`, `active` → `revoked` (`revoked_by='owner'`,
   `revoked_at` = the **same** `now`, which marks "ended together with the person", see "D12 rights"
   below). Ops:
   `put t/<fid> {"s":"revoked","at":…}`, `delete_tree s/<fid>`, `delete h/<did>` per device.
   Data stays (D8). Idempotent; a revoked person cannot be re-activated (re-invite = new fid).
5. `delete(fid, by)` (D12): §3.3 FollowerData rule 3.
6. Service follower (`kind='service'`, name `Publisher`): created on first
   `GET /backend/access/service-session`; never listed, counted, exported or shown.

**Devices**
1. `label` from `User-Agent` (`UserAgentLabel::of`): platform ∈ {iPhone, iPad, Android, Mac,
   Windows, Linux, Gerät} × browser ∈ {Safari, Chrome, Firefox, Edge, Samsung, WhatsApp,
   Instagram, Facebook, Browser} → `"iPhone · Safari"`. The raw UA is never stored.
2. First device: `first = 1` iff the follower has no device in state `active` or `revoked`.
   Such a device is created `active`; every other new device is `pending` (Q3 c).
3. At most 3 `pending` devices per follower; a further join answers
   `unavailable`/`too_many_pending`. A join that presents the key of a **pending device of the
   same follower** creates nothing: `join/check` answers `pending_device` and `join` answers
   `pending` for that device (reopening the link while waiting must not create duplicates). A
   key of a declined, revoked or unknown device is treated as no key (a new device).
4. `approve(did)`: pending → active, `decided_at`; refused with 409 `device_limit` when the
   follower already has `ACCESS_MAX_DEVICES` active devices. The session is issued on the
   device's next poll. `decline(did)`: pending → declined. Pending devices older than 14 days are
   declined by cron (`revoked_by` stays NULL, `decided_at` set).
5. `revoke(did, by)`: active → revoked (`by` = owner \| follower (sign out) \| system), clears
   `session_hash`, `pending_sid`, `handoff_at` (also on person revoke and delete). Ops:
   `put t/<fid>.<did> {"s":"revoked",…}`, `delete_prefix s/<fid>/<did>.`, `delete h/<did>`.

**Sessions** — `issue(device, k)` (k = the key the request presented; never stored):
1. Preconditions: device `active`, follower `active`, `locked = 0`,
   `reconciled_epoch = epoch`; else the caller answers `unavailable` with the reason.
2. At most 6 issues per device per hour (rate bucket `issue`).
3. `sid = token()`; ops `delete_prefix s/<fid>/<did>.`, `put s/<fid>/<did>.<sid>` (exclusive),
   `put h/<did>`; `session_hash = sha256(sid)`, `session_at = now`, `handoff_at = now`,
   `pending_sid = sid`.
4. After commit: `StoreApplier::applyNow()` (non-blocking, §3.8.3). If every op of this batch is
   applied: clear `pending_sid`, answer `active` with `handoff = "/_/h/"` and
   `session = "<fid>.<did>.<sid>"` (the key is never part of a handoff: the page already holds
   it). Otherwise answer `activating` (`pollAfterMs: 3000`); `device/poll` returns
   `{handoff:'/_/h/', session}` from `pending_sid` once the ops are applied (by another request, by
   cron or by the Mac) and then clears it. A `pending_sid` older than 30 minutes is discarded and
   the next poll issues again.
5. `ACCESS_COOKIE_MODE=parent` (F2): no handoff and no `h/` op; the response carries the two
   `Set-Cookie` headers instead and `handoff = "/"` without `session`.

**Privacy notice and consent (D11, Q7)**
1. Draft: `PUT /admin/privacy/draft` stores a `PrivacyNoticeDraft` (empty strings allowed).
2. Publish: requires a complete `PrivacyNotice` (controller name + e-mail, every section in `de`
   **and** `en` (D11) and in every further `site.locales` locale; 422 `notice_incomplete` with the
   missing paths otherwise) and
   `ifDraftSha256` = sha256 of the draft the admin showed (409 `conflict` otherwise). Writes
   version = max + 1, the canonical JSON and its sha256. Versions are immutable.
3. Joining needs a published version: without one, `join/check` answers
   `unavailable`/`notice_missing`.
4. `join` requires `consentVersion` = current version (else `consent_outdated` with the
   notice); every successful join writes a `consents` row (follower, device, version, locale).
5. `notice.required` (hello) = the follower's highest consented version < current version.
   `me/consent {k, version, locale}` writes a row for the current version only.

**Lock and panic (Q6)**
1. `lock(by)`: `locked=1`, `locked_at`, `locked_by`; op `put locked {"at","by"}`. Idempotent.
2. `unlock(password)`: verifies the owner's password (`Passwords::verify` against the logged-in
   user; 403 `forbidden` on mismatch, counted in `login_attempts` like a login); `locked=0`,
   `unlocked_at = now`; op `delete locked`.
3. Panic link (optional, cheap): `POST /admin/access/panic-link` creates a key → `panic_hash`,
   returns `<SITE_ORIGIN>/_/panic/#k=<key>` once; `DELETE` clears it. `POST /public/panic {key}`
   locks when the hash matches; the answer is always `{ok: true}`.
4. Sticky lock: a `locked` file found in the store while the DB says unlocked (e.g. the Mac's
   control-UI lock, §5.6.6) is imported (`locked=1, locked_by` from the file) **only when the
   file's `at` is later than `unlocked_at`** (or `unlocked_at` is NULL); an older file is a
   leftover of a lock the owner already ended and is deleted by an ordinary op. The repair job
   never deletes a newer one; only an admin unlock removes it.

**D12 rights (who may read, export and delete a person's data)** — enforced in one place,
`FollowerData::rightsOf(device)`, for `me/data`, `me/export` and `me/delete`:
- **full** when the device is `active` and the follower `active`; or the device is `revoked`, the
  follower `revoked`, and `device.revoked_at = follower.revoked_at` (the device was in use until
  the person's access ended, so she keeps her D12 rights on the devices she really used);
- **limited** for every other device of a non-deleted follower (`pending`, `declined`, revoked on
  its own, or revoked before the person): `me/data` answers `limited` with only this device's
  label, state and creation time; `me/export` and `me/delete` answer `ended`; `me/notice`,
  `me/consent` (pending only) and `me/signout` (pending: withdraws the request) work as in §3.4;
- **none** (unknown key, deleted follower): `ended` everywhere.
A pending device is exactly what a forwarded link produces; it must never see the person's other
devices and last-seen times (an activity pattern D9 reserves for the owner) nor erase the person.

**Your data (D12) — `FollowerData`**
1. `view(fid, did)` (full rights) → `FollowerDataView` (§4.1): name, since, state, this device,
   all devices (label, state, created, last seen), consents (version, date, locale), stored
   categories with counts (wave 5: `devices`, `consents`; wave 6 adds views, reactions, messages,
   e-mail).
2. `export(fid)` (full rights) → `FollowerDataExport`: everything in the view plus each confirmed
   notice version's full text; `Content-Disposition: attachment; filename="on-my-way-data-<YYYY-MM-DD>.json"`.
3. `delete(fid, by)` (full rights, or the owner): one transaction: delete `devices` and
   `consents` rows of fid (wave 6: also views, impressions, activity, reactions, messages, e-mail,
   requests); the follower row becomes a tombstone (`state='deleted'`, `name/note/link_*`,
   `revoked_at` NULL, `created_at = updated_at = deleted_at`, `deleted_by`); ops
   `put t/<fid> {"s":"deleted",…}`, `delete_tree s/<fid>`, `delete h/<did>` per device; an
   `owner_notices` row `follower_deleted` (data `{"at": …}`, no name), delivered right after the
   response (§3.9). A second call finds no device for the key and answers `ended`. Backups keep
   the data until they age out (`BACKUP_KEEP` days, stated in the notice, plus downloaded copies,
   Appendix A); an API restore re-applies the deletion from the store tombstone (§3.8.6). The
   tombstone keeps `kind` (to filter the service follower) and `deleted_by` (the owner's list
   says who deleted); neither is personal.

### 3.4 Public endpoints (site → API, CORS)

Group `/api/v1/public` with middleware `Cors` (existing; add
`Access-Control-Expose-Headers: Content-Disposition, Retry-After`) → `PublicGuard` (new: global
cap, `Content-Length` ≤ 8192 else 413 before reading, maintenance) → controller. Requests are
`POST` with `Content-Type: text/plain;charset=UTF-8` and a JSON object body (a CORS "simple
request": no preflight, no cookies, `credentials:'omit'`; `application/json` is accepted too).
Bodies are validated against `api/schemas/<Name>.json`. Every answer is `200` JSON with a
`status` discriminator, except `400 validation_failed`, `413`, `429 rate_limited` (+`Retry-After`),
`503 busy|maintenance`. Unknown/rotated/revoked links and unknown keys get the same answer as
each other (`invalid` resp. `ended`).

| Route | Body → Response (contract) | Auth | Behaviour |
|---|---|---|---|
| `POST /public/join/check` | `JoinCheckRequest {t, k?}` → `JoinCheckResponse` | link | `invalid` \| `unavailable{reason}` \| `known_device` (k is an active device of this follower; the page goes to `/`, or to the info screen when `noticeRequired`) \| `pending_device` (k is a pending device of this follower; the page goes to `/_/wait/`) \| `ok{follower:{name}, notice: PublicNotice, deviceMustWait}` |
| `POST /public/join` | `JoinRequest {t?, resume?, k?, consentVersion?, locale}` → `JoinResponse` | link, or key when `resume` | New device: `consentVersion` must be current → consent row → device (first: active + issue; else pending) → `active{handoff:'/_/h/', session, deviceKey}` \| `activating{deviceKey}` \| `pending{deviceKey}`. Resume (`resume: true`, `k`, no `t`): active device → issue → `active{handoff, session}`/`activating`; revoked/declined/unknown → `ended`; locked → `unavailable{locked}`. Link given with a known active `k` → treated as resume; with a pending `k` of the same follower → `pending` for that device (no new device). |
| `POST /public/device/poll` | `DeviceKeyRequest {k}` → `DevicePollResponse` | key | `pending{pollAfterMs}` \| `activating{pollAfterMs}` \| `active{handoff:'/_/h/', session}` (issues when active and no session/pending handoff) \| `active{handoff:'/'}` (active with a session already applied: just go to `/`) \| `ended` \| `unavailable{reason}` |
| `POST /public/me/hello` | `DeviceKeyRequest {k}` → `MeHelloResponse` | key, active | Updates `last_seen_at` (at most every 6 h), clears the handoff marker when `handoff_at` is set, returns `active{follower:{name}, device:{id,label}, notice:{version, required}}`; non-active → `ended`; locked → `unavailable{locked}` |
| `POST /public/me/notice` | `DeviceKeyRequest {k}` → `MeNoticeResponse` | key, active/pending | `ok{notice: PublicNotice, confirmedVersion}` \| `ended` \| `unavailable{notice_missing}` |
| `POST /public/me/consent` | `MeConsentRequest {k, version, locale}` → `MeHelloResponse` | key, active/pending | records consent for the current version (`consent_outdated` if `version` is stale) |
| `POST /public/me/data` | `DeviceKeyRequest` → `MeDataResponse` | key; D12 rights (§3.3) | full → `ok{data: FollowerDataView}`; limited → `limited{device:{label, state, createdAt}}`; none → `ended` |
| `POST /public/me/export` | `DeviceKeyRequest` → `FollowerDataExport` \| `MeSimpleResponse{ended}` | key; full D12 rights | attachment download; limited/none → `ended` |
| `POST /public/me/signout` | `DeviceKeyRequest` → `MeSimpleResponse` (`signed_out` \| `ended`) | key, active/pending | active → revoked (`by follower`), pending → declined (the request is withdrawn) |
| `POST /public/me/delete` | `MeDeleteRequest {k, confirm:'delete-all-my-data'}` → `MeSimpleResponse` (`deleted` \| `ended`) | key; full D12 rights | §3.3 FollowerData 3 (`by follower`); limited/none → `ended` |
| `POST /public/panic` | `PanicRequest {key}` → `PanicResponse {ok:true}` | panic key | locks on match |

### 3.5 Admin endpoints (session cookie + CSRF as today; JSON)

| Route | Body → Response | Notes |
|---|---|---|
| `GET /admin/followers` | → `FollowerListResponse {items: AdminFollower[], tombstones: FollowerTombstone[]}` | persons only; `items` active first, then revoked; newest first |
| `POST /admin/followers` | `FollowerCreate {name, note?}` → `FollowerCreated {follower, link}` (201) | link shown once |
| `GET /admin/followers/{fid}` | → `AdminFollower` | incl. devices, consent, last seen |
| `PATCH /admin/followers/{fid}` | `FollowerPatch {name?, note?}` → `AdminFollower` | |
| `POST /admin/followers/{fid}/link` | `{}` → `PersonalLinkCreated {link}` | rotates |
| `POST /admin/followers/{fid}/revoke` | `{}` → `AccessActionResult` | |
| `GET /admin/followers/{fid}/export` | → `FollowerDataExport` (attachment) | |
| `POST /admin/followers/{fid}/delete` | `FollowerDeleteRequest {confirm: true}` → `AccessActionResult` | `by owner` |
| `POST /admin/devices/{did}/approve` | `{}` → `AccessActionResult` | 409 `device_limit` at `ACCESS_MAX_DEVICES` active devices |
| `POST /admin/devices/{did}/decline` | `{}` → `AccessActionResult` | |
| `POST /admin/devices/{did}/revoke` | `{}` → `AccessActionResult` | |
| `GET /admin/access` | → `AccessStatus` | lock, writer, pending ops, reconcile report, panic link set?, notice version, origins, store id, last gate check, up to 3 pending devices with names (not persisted by the admin, §7.2) |
| `POST /admin/access/lock` | `LockRequest {locked: true}` \| `{locked: false, password}` → `AccessActionResult` | |
| `POST /admin/access/retry` | `{}` → `AccessStatus` | clears `writer_blocked_at` once and applies pending ops now |
| `POST /admin/access/store-init` | `{}` → `AccessActionResult` | creates `store_id` when NULL (else keeps it) and enqueues `init` (§2.2); the admin offers it only while the store is uninitialised or the marker is missing |
| `POST /admin/access/panic-link` / `DELETE …` | `{}` → `PanicLinkCreated {url}` / 204 | |
| `GET /admin/privacy` | → `PrivacyState {draft, draftSha256, current: PublishedNotice\|null, versions: NoticeVersionInfo[]}` | |
| `PUT /admin/privacy/draft` | `PrivacyNoticeDraft` → `PrivacyState` | |
| `POST /admin/privacy/publish` | `PrivacyPublishRequest {ifDraftSha256}` → `PrivacyState` | 422 `notice_incomplete`, 409 `conflict` |
| `GET /admin/notices` / `POST /admin/notices/read` | → `OwnerNoticeList` / `{ids}` → 204 | |
| `GET /admin/status` (existing) | `StatusResponse` + additive `access: AccessSummary` | one request feeds Home |
| `PATCH /admin/settings` (existing) | new keys (§4.3) | `publish.moved_on_at` is set by the "moved on" button |

`AccessActionResult = {effect: Effect, follower?: AdminFollower, device?: AdminDevice, status?: AccessSummary}`
with `Effect = {applied: boolean, via: 'direct'|'sftp'|'mac'|'pending', pendingOps: number}`:
`applied=true` means every op of this action is in the store ("In effect ✓"). These routes are
idempotent; the admin calls them outside the offline write queue (§7.2).

### 3.6 Backend endpoints (Bearer backend token)

| Route | Body → Response | Behaviour |
|---|---|---|
| `GET /backend/changes` (existing) | `ChangesResponse` + additive `access?: {needsWriter: boolean}` | `true` when `ACCESS_STORE_MODE=none`, or the oldest pending op is older than 60 s, or `writer_blocked_at` is set, or a reconcile is due and the API cannot list the store |
| `POST /backend/access/claim` | `AccessClaimRequest {holder:'mac'}` → `AccessClaim {lease: {until}\|null, storeId, epoch, ops: StoreOp[], listingWanted: boolean}` | grants the lease for 60 s when free or expired; `ops` = the first ≤ 200 pending ops in id order (raw paths); `storeId` = `access_state.store_id` (null → the Mac applies only an `init` op); `listingWanted` = a reconcile is due and the API cannot list the store itself |
| `POST /backend/access/renew` | `AccessRenewRequest {epoch}` → `AccessLease {lease: {until}\|null}` | extends the Mac's lease by 60 s while it holds it; `lease: null` = lost (stop at once) |
| `POST /backend/access/listing` | `StoreListingUpload {epoch, listing: StoreListing}` → `AccessClaim` | the API runs the reconciler (§3.8.5) on the Mac's listing, applies the DB-side imports, enqueues the store-side fixes as ordinary ops and returns them (lease extended) |
| `POST /backend/access/ack` | `AccessAck {epoch, appliedThrough, failed?: {opId, error}}` → 204 | marks ops `≤ appliedThrough` applied (`applied_by='mac'`), redacts session paths, releases the lease; 409 `conflict` if the epoch changed or the Mac no longer holds the lease (then the API re-applies from its own `last_applied_op`; ops are idempotent) |
| `GET /backend/access/service-session` (`?rotate=1` optional) | → `ServiceSession {cookieName, cookieValue, expiresAt}` | creates the service follower/device on first use (its `key_hash` is the hash of a random key that is thrown away); issues a fresh session (ops `delete_prefix` + `put` session, **no** handoff marker; rotates the previous one) when none is active, it is older than 24 h, or `rotate=1`; answers 503 `busy` until the ops are applied; `cookieName` = `__Host-omw` when `SITE_ORIGIN` is https and `ACCESS_COOKIE_MODE=headers`, else `omw`; the backend keeps the value (and the previous one, for gate check #5) in memory only |
| `POST /backend/heartbeat` (existing) | `Heartbeat` + additive `site?: SiteHeartbeat` | the API compares `site.origin` with `SITE_ORIGIN` → alert `site_origin_mismatch`; with `direct`, `site.storeDir` with `ACCESS_STORE_DIR` → alert `access_store_unverified` |
| `POST /backend/published` (existing) | `PublishedReport` + additive `gateCheck?: GateCheckResult` | stores the newest gate check in `access_state.gate_check`; `store_unverified` raises `access_store_unverified` (critical), `gate_open` raises `publish_failing` (critical) |

### 3.7 Rate limits

Subjects are hashed: `bucket = kind + ':' + substr(sha256(subject + meta.rl_salt), 0, 32)`;
`rl_salt` rotates daily (cron); rows older than 48 h are pruned. Check-and-record is one
`BEGIN IMMEDIATE` transaction (like `LoginThrottle`). Generic `Infra\RateLimiter::hit(kind,
subject, limit, windowSeconds): int $retryAfter`.

| Kind | Subject | Limit |
|---|---|---|
| `pub` (global) | – | 1200 public requests / hour → 503 `busy` (`Retry-After: 60`); alert `public_flood` (warning) |
| `ip` | client IP | 60 / 10 min across `join/check`, `join`, `panic` |
| `link` | link hash | 30 / hour (`join/check` + `join`) |
| `join_ip` | client IP | 10 new devices / hour |
| `poll` | key hash | 1 / 3 s (burst 3), 1200 / day |
| `me` | key hash | 60 / hour (`hello`, `notice`, `consent`, `data`) |
| `export` | key hash | 6 / hour |
| `danger` | key hash | 5 / hour (`signout`, `delete`) |
| `issue` | device id | 6 / hour |
| `panic_ip` | client IP | 10 / hour |

Failures (invalid link, unknown key) count like successes. The answer to a limited request is
429 with `Retry-After`; the site pages show "Zu viele Versuche, bitte später noch einmal".
Accepted residuals: a flooder can exhaust the global `pub` cap and block joins for up to an hour
(viewing is unaffected: it never needs the API); the daily `rl_salt` rotation resets every window
at UTC midnight. A `join/check` with a valid link tells the link holder whether the person
already has a device (`deviceMustWait`); the holder of a valid link is meant to be that person.

### 3.8 Store writer, ops, repair, restore

#### 3.8.1 Interface (`api/src/Infra/Store/`)

```php
interface StoreWriter {
    public function mode(): string;                          // 'direct' | 'sftp'
    /** Creates the file; with $exclusive an existing file is left as is (no rewrite). */
    public function put(string $rel, string $content, bool $exclusive): void;
    public function replace(string $rel, string $content): void;   // temp + rename (marker only)
    public function delete(string $rel): void;                // missing = ok
    public function deletePrefix(string $relDir, string $namePrefix): int;  // e.g. ("s/<fid>", "<did>.")
    public function deleteTree(string $relDir): void;         // missing = ok
    /** @return list<string> entry names; [] when missing */
    public function list(string $relDir): array;
    public function read(string $rel): ?string;               // small files only (marker, tombstone, locked)
    public function close(): void;
}
```
- Every `$rel` is checked against `StoreLayout::isValidPath()` (regexes from §2.2; no `..`, no
  leading `/`) before any filesystem call; directories are created on demand with
  `ACCESS_STORE_DIR_MODE`, files get `ACCESS_STORE_FILE_MODE`.
- `DirectStoreWriter(root)`: `fopen($p, 'x')` for exclusive puts, `tempnam` in the same dir +
  `rename()` for `replace`, `clearstatcache()` before reads.
- `SftpStoreWriter` (`phpseclib/phpseclib ^3.0`, new Composer dependency; it pulls
  `paragonie/constant_time_encoding` and `paragonie/random_compat`; none of the three is in
  `api/vendor` or the local Composer cache, so WP1 fetches them once on a networked machine, §9):
  it talks to the server through the small `SftpClient` interface (fake in tests, phpseclib in
  production); connect and every operation with a 5 s timeout; verify the host key:
  `base64_encode(hash('sha256', <raw key blob>, true))` without padding, prefixed `SHA256:`, must
  be in `_HOSTKEYS` (else `StoreWriterException('host_key')`); login with key (preferred) or
  password; **an authentication failure sets `access_state.writer_blocked_at` and is never
  retried** until the owner presses "Retry" (the host bans repeated failures); right after login
  it refuses a login that sees the site docroot unless `ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN=true`
  (§3.1); exclusive put = `stat` then `put`; `replace` = `put(tmp)` + `posix_rename` when the
  server advertises `posix-rename@openssh.com`, else `delete` + `rename`. Without the `sodium` and
  `gmp` extensions phpseclib falls back to pure-PHP key exchange, which costs seconds per
  connection (P0b records both; §3.10).
- `StoreWriterFactory::fromConfig()` returns `null` for `none`.

#### 3.8.2 Ops

`StoreOps::enqueue(op, path, content?)` inside the caller's transaction. Op kinds: `init` (the
marker, only if none exists), `put` (exclusive, except `.omw-store.json`), `delete`,
`delete_prefix` (`path` = `s/<fid>/<did>.`), `delete_tree`. After an op that created a session
file is applied, its `path` is rewritten to `s/<fid>/<did>.<redacted>` so the database keeps no
usable `sid`.

#### 3.8.3 Applier (never blocks a PHP worker on another writer)

The host has few PHP-FPM workers. Request paths must never wait for the store lock, and no
database transaction may span a filesystem or SFTP call (busy_timeout is 5 s; a transaction held
across network I/O would make every other writer fail).

`StoreApplier::applyNow(deadlineSeconds)` (requests: 8 s; cron: 20 s):
0. Throws `LogicException` when called while a database transaction is open (`Db::write()`
   joins nested calls into the outer transaction, so a call from inside a write would make that
   transaction span the store I/O). Callers run it after their `Db::write()` returned.
1. `flock(var/cache/store.lock, LOCK_EX | LOCK_NB)`. Held by another process → return "not
   applied" at once (that holder drains the queue, step 5).
2. Short write transaction: take the lease (`lease_holder='api'`, `lease_until=now+60s`) unless
   `mac` holds an unexpired lease (then release the lock, return "not applied"). Commit.
3. Open the writer (none / blocked → release, return "not applied"). Read the marker: it must
   carry `access_state.store_id` and `epoch` (§2.2), else alert `access_store_unverified`,
   release, return "not applied" (exceptions: an `init` op at the head of the queue; the restore
   cases of §3.8.6).
4. Loop over pending ops in id order. Before each op: stop when `lease_until − 10 s` or the
   deadline has passed (renewing the lease in a short transaction when ops remain and the deadline
   allows). Apply the op (I/O, no transaction), then commit its `applied_at`, `applied_by='api'`
   and `last_applied_op` in **its own short transaction**. On the first failure: `attempts+1`,
   `last_error` (short transaction), stop: order matters.
5. **Drain:** when the loop ran out of ops, re-read the queue once more; ops enqueued meanwhile by
   requests that returned "not applied" are applied now, not left for cron.
6. `replace .omw-store.json {format, storeId, epoch, op: last_applied_op, at}`; release the lease
   (short transaction) and the lock; close the writer.

Callers: every access action (after commit), `join`, `device/poll`, `me/*` that enqueue ops,
cron, `POST /admin/access/retry`. The response reports `effect.applied` (false when another
process holds the lock; the admin then shows "Noch nicht wirksam" until its next poll of
`/admin/access`, usually within seconds). A join that gets "not applied" answers `activating`.

#### 3.8.4 Mac fallback writer

When `changes.access.needsWriter` is true, the backend (§5.6.6) calls `claim`; if
`listingWanted`, it lists the store and uploads it (`listing`), receiving the reconcile ops. Then
it reads the marker over its own SFTP connection (target with `accessStoreRoot`) and **refuses
to apply** (it calls `ack` with `failed: {opId: <first>, error: 'store_mismatch'}`, which raises
`access_store_unverified`) unless the marker exists with the claimed `storeId` and `epoch` (only
an `init` op may run without a marker). It applies at most the ≤ 200 claimed ops in order;
before each op it checks `lease.until − 10 s` and renews through `POST /backend/access/renew`
when needed, stopping at once when the lease is lost; every SFTP operation has a 5 s timeout, so
an op can never outlive the lease. Then it writes the marker and calls `ack`. While the Mac
holds the lease the API applies nothing. Ops are idempotent and applied by one holder at a time
in id order, so double application after a lost `ack` is harmless and a later `delete` can never
be overtaken by an earlier `put`.

#### 3.8.5 Reconcile (repair job; pure core shared with the backend)

`Reconciler::plan(StoreSnapshot $desired, StoreListing $actual): ReconcilePlan` (pure PHP, tested
with `fixtures/vectors/store-reconcile.json`). It exists only in the API: with `direct`/`sftp` the
applier lists the store itself; with the Mac, the Mac uploads its listing
(`POST /backend/access/listing`) and receives the resulting ops. The plan has two parts: DB
imports (applied by the API) and store fixes (enqueued as ordinary ops).

- `desired` (from the DB): epoch, `lastOp`, `locked`, active sessions `{fid, did, sidHash}`,
  devices awaiting a handoff `{did}`, tombstones `{fid, did?, s}`.
- `actual` (`StoreListing`): marker content, `locked` content or null, every `s/<fid>/<did>.<sid>`
  path (the reconciler hashes `sid`), `h/` names, `t/` names with contents.
- Modes:
  - `normal` (same epoch): delete every `s/` file that is not an active session with the same
    hash (unknown fid, unknown did, revoked, stale sid); delete `h/<did>` not awaiting a handoff;
    write missing tombstones; `locked` per DB, except the sticky rule (§3.3 Lock 4: a `locked`
    file newer than `unlocked_at` is imported, never deleted); report active sessions whose file
    is missing (`missing`), which resume by key.
  - `restored_api` (marker epoch ≠ DB epoch, §3.8.6): import tombstones (`t/<fid>` revoked →
    revoke in DB; deleted → run the erasure again with `deleted_by='restore'`; `t/<fid>.<did>` →
    revoke that device); adopt files of known active devices (set `session_hash` from the file
    name); **insert a tombstone row** (`state='deleted'`, `deleted_by='restore'`, no name) for
    every fid seen anywhere in the listing (`s/`, `t/`) that the DB does not know, so a restored
    database can never hand out that id again (D6); delete the sessions of devices the DB does not
    know (`orphans`, reported with their fid): their keys are unknown to the API, so they could
    never say hello, resume or reach "Your data" anyway; import `locked` (sticky rule).
- **Race-free order** (no transaction across I/O, no stale fix):
  1. under the applier lease and after the pending ops are applied, note
     `listedThrough = last enqueued op id`, then take the listing (I/O, no transaction);
  2. in **one** write transaction: read the desired state, compute the plan, apply the DB
     imports, and enqueue the store fixes, **skipping every path touched by an op with
     `id > listedThrough`** (an unlock, revoke or issue enqueued while the listing ran wins; it is
     applied next anyway).
  So a reconcile that saw `locked` before an unlock can neither re-lock the site nor import the
  old lock (the file's `at` is older than `unlocked_at`).
- Every run writes `access_state.reconcile_report` (`StoreReport {at, mode, deleted, missing,
  orphans, imported}`) and raises/resolves the alert `access_store_mismatch` when `missing` is
  non-empty; orphans and restore tombstones produce one owner notice `restore_reconciled`.
- Runs: every cron run (the listing is one directory per follower: cheap with `direct`, about a
  second with `sftp`), after an epoch change, and on `POST /admin/access/retry`.

#### 3.8.6 Restores

- **API database restored** (HOSTING §8): the bootstrap flag `rotateFeedId` now also sets
  `access_state.epoch = lower(hex(randomblob(8)))` (new `Bootstrapper` step). Until a
  `restored_api` reconcile has run (`reconciled_epoch = epoch`), `join`, `device/poll`,
  resume and `approve` answer `unavailable`/`restoring` and the admin shows "Restore: checking
  access…". The reconcile runs at the next cron run or immediately on the first admin
  `GET /admin/access` after the restore. The writers accept the marker's old epoch for this one
  reconcile (same `storeId` required), then write the new epoch. Outcomes:
  - revoked people stay out and deleted people stay deleted (store tombstones);
  - devices revoked after the backup cannot resume (tombstone `t/<fid>.<did>` imported before any
    join is allowed);
  - **devices that joined after the backup lose access**: their keys are not in the restored
    database, so their sessions are removed (orphans). A person the database still knows reopens
    her personal link (if it was not rotated after the backup) and the device joins again (as
    first device when she has no other, else it waits for the owner's OK). A person created after
    the backup is unknown: her fid becomes a restore tombstone and the owner invites her again
    (new link, new fid);
  - the owner notice `restore_reconciled` says how many devices and people are affected and, for
    known people, their names in the admin (never in push texts).
- **Webspace restored** (old store files back): the store marker's `op` is lower than
  `last_applied_op` (same `storeId`) → a `normal` reconcile deletes every revived session,
  re-writes tombstones and the lock. Within one cron interval (≤ 5 min) with `direct`/`sftp`, or
  the next Mac claim. A webspace restore from before the store existed (no marker) stops the
  writers until the owner initialises the store again (§2.2); every device then resumes by key.
- Runbook lines in `docs/HOSTING.md` §8: "After any restore, open Admin → People and read the
  'after a restore' card; tell the people it lists to reopen their link."

### 3.9 Cron, alerts, notices

`CronRunner` gets a job `access` (runs after `alerts`):
1. `StoreApplier::applyNow(20)`; reconcile (§3.8.5).
2. Delete handoff markers with `handoff_at` older than 10 min (`delete h/<did>`, `handoff_at=NULL`).
3. Decline pending devices older than 14 days.
4. Deliver undelivered `owner_notices` (`ChannelNotifier`, no names).
5. Rotate `meta.rl_salt` once per UTC day; prune `rate_events` older than 48 h.
6. Optional `ACCESS_GATE_PROBE=true` **[P0b-6]**, the primary detector while the Mac's checks
   are blind (the host blocks the Mac's IP, HOSTING §10):
   - once per hour: `GET <SITE_ORIGIN>/<random 20 chars>/data/x.json` without cookies must be 403
     with body `Forbidden\n`; else critical alert `site_gate_open`;
   - once per 6 h, only with `direct`/`sftp`: the **store proof**: rotate the service session
     (§3.6), apply, then `GET <SITE_ORIGIN>/` (no redirect following) with the new cookie must be
     302 (the gate sends followers to the content folder) and with the previous cookie 200 (the
     neutral page); else critical alert `access_store_unverified`; on success
     `store_proof_at = now`. (The API does not need to know the content folder for this.)
   At most three requests per hour from the API host, none of them to a dot path.
   The results are stored like the Mac's (`access_state.gate_check`).

`AlertEngine::KINDS` += `devices_pending` (warning, "1 neues Gerät wartet auf deine Bestätigung"
/ "N …"; resolves when none is pending), `access_store_failing` (critical; a pending op older than
10 min or `writer_blocked_at` set), `access_store_unverified` (critical; marker missing or with
another `storeId`, heartbeat `storeDir` differs, or the store proof / gate check #4–#5 failed),
`access_store_mismatch` (warning), `site_origin_mismatch` (warning), `public_flood` (warning),
`site_gate_open` (critical, optional probe). Messages never contain names. Immediate delivery:
after the response of `join` (new pending device) and
`me/delete`, call `fastcgi_finish_request()` when available, then run
`AlertEngine::run(only: ['devices_pending'])` resp. deliver the new notice; otherwise cron does
it within 5 minutes.

### 3.10 How revocation and lock propagate

| Writer | Path | Revoke / lock / unlock in effect after | Notes |
|---|---|---|---|
| `direct` [P0b-1] | API PHP writes the store files in the same request | **< 1 s** after the admin's tap reaches the API, if P0b-11 shows files are visible to Apache at once (else + the measured delay) | needs one account/filesystem + `open_basedir` |
| `sftp` [P0b-2] | API PHP → phpseclib → site host | **1–3 s** (connect + key exchange) with `sodium` + `gmp`; several seconds without them | needs outbound TCP 22 from PHP and a dedicated SFTP account restricted to the store folder (the site's own login only by owner decision, §3.1) |
| `none` → Mac | backend sync loop sees `needsWriter`, claims, applies | **≤ 15–20 s** while the Mac runs; never while it is off | the admin shows "Noch nicht wirksam ⏳" until `ack`; the default whenever neither `direct` nor a restricted SFTP account is possible |
| any, writer failing | op stays pending; cron retries every 5 min; the Mac takes over after 60 s | as soon as one path works | alert `access_store_failing` after 10 min |

After the store change, Apache refuses the device's **next** request: a navigation, a new day
file, the 5-minute manifest poll. An open tab can still show what is already in memory and in
the HTTP cache (media are cached `private, immutable` for a year); `Clear-Site-Data` on the
first refused request empties cache and storage where supported (Safari/Firefox fully, Chrome
partly). Revocation is never retroactive.

### 3.11 The device's identity towards the API (decision)

**Token, not an API-host cookie.** The device key `k` lives in the site-origin cookie
`__Host-omw_k` (server-set by Apache at the handoff, JS-readable, `SameSite=Strict`) and is sent in
the JSON body of simple CORS requests (`text/plain`, `credentials:'omit'`).

| | API-host cookie (`credentials:'include'`) | **Token in a site cookie, sent in the body** |
|---|---|---|
| Needs site and API on one registrable domain | yes (same-site, else third-party cookie) | **no** |
| Safari ITP | first-party only while same-site; blocked when the domain moves (Q9) | server-set site cookie: no 7-day cap |
| CORS | `Allow-Credentials`, exact origin, preflights for JSON | simple requests, **no preflight** (saves PHP workers) |
| CSRF | needs a token/header | none: nothing ambient |
| XSS on the site | cookie HttpOnly | key readable by script (the gate cookie stays HttpOnly); the site's CSP has no `unsafe-inline` and hashes every inline script |

The API never accepts the gate cookie as an identity (except F2's refresh check), and the key
never opens the site by itself: it only proves the device to the API and can mint a new session
through `resume` (rate-limited, revocable). Neither the key nor the session value ever travels in
a URL (§2.3.2).

Service worker: the site registers none, and in gate mode its CSP says `worker-src 'none'`
(§5.4). A worker could answer from its own cache after access ended and bypass the gate's
refusals; `Clear-Site-Data: "storage"` would unregister one only on a refused request.

### 3.12 Change password and recovery (added to wave 5 by the owner, 2026-11-20)

- `PUT /api/v1/admin/me/password` (session + CSRF; Bearer app tokens refused with 403) with
  `PasswordChange` → **204**.
  1. Rate limit: `LoginThrottle::begin(ip, user.email)` before verifying (a wrong current
     password is recorded as a failed login; 429 + `Retry-After` at the existing limits).
  2. `currentPassword` must verify (`Passwords::verify`), else **403** `wrong_password`
     (generic message).
  3. `newPassword`: `Passwords::weakness()` with `MIN_LENGTH` raised from 10 to **12** (also
     applies to `bin/create-admin.php`); must differ from the current one and from the e-mail
     address; else 422 `validation_failed` with the reason.
  4. Hash with `Passwords::hash()` (Argon2id, bcrypt fallback) and store it with a new
     `Users::setPassword(userId, hash, keepTokenId, revokeAppTokens)`: revokes every **other**
     session token of the user (`kind='session'`) and keeps the current one; with
     `revokeAppTokens: true` it also revokes the user's `kind='app'` tokens (they carry the
     `admin` scope, so someone who had the old password could have made one to stay in). Backend
     tokens are never touched (they belong to the Mac; revoking them would stop publishing). The
     admin shows the box only when the user has app tokens, ticked by default (§7.8).
  5. Logged without the password; no alert.
- Recovery stays `scripts/deploy-api.ts --reset-admin-password` (it already generates a random
  24-character password, ships only Argon2id/bcrypt hashes in `var/bootstrap.json` and writes the
  clear text to `.secrets/api-admin.txt`; the bootstrap revokes all sessions). Wave 5 adds a test
  that the generated password passes the new 12-character minimum and a line in HOSTING §7.

---

## 4. Contracts (`packages/contracts`)

Rules as today: no transforms/defaults in exported schemas; rules JSON Schema cannot express are
listed in the module header and enforced in PHP with the same semantics; `pnpm schemas` writes
`api/schemas/<Name>.json`; `contractVersion` stays `1` (all changes are additive for the API;
`DayDetail` loses two optional output fields, which no consumer reads).

### 4.1 New module `src/access.ts` (exported from `src/index.ts`; imports `common`, `i18n`, `site`)

```ts
// ids and tokens
export const FollowerId = z.string().regex(/^[a-z2-7]{12}$/, { message: 'Expected a follower id' });
export const DeviceId = z.string().regex(/^[a-z2-7]{8}$/, { message: 'Expected a device id' });
export const AccessToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, { message: 'Expected a 43-char token' });
export const Epoch = z.string().regex(/^[0-9a-f]{16}$/);
export const StoreId = z.string().regex(/^[0-9a-f]{16}$/);
/** "<fid>.<did>.<sid>": the gate cookie value, the transfer cookie value, the service session. */
export const GateSession = z.string().regex(/^[a-z2-7]{12}\.[a-z2-7]{8}\.[A-Za-z0-9_-]{43}$/);
export const FollowerName = AuthorName;                      // site.ts: one trimmed line, 1..60
export const FollowerNote = z.string().max(200);
/** "https://host[:port]" lowercase, no path. */
export const Origin = z.string().regex(/^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/);
export const PublicApiBase = z.string().regex(/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/api\/v1\/public\/$/);

// cookies, handoff, links (pure helpers; PHP mirrors them in Domain\Access\StoreLayout)
export const GATE_COOKIE_NAMES = {
  secure: { session: '__Host-omw', key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h', resume: '__Host-omw_r' },
  insecure: { session: 'omw', key: 'omw_k', transfer: 'omw_s', handoff: 'omw_h', resume: 'omw_r' }, // http loopback dev and F1/F2
} as const;
/** The only handoff path; it never carries a secret (§2.3.2). */
export const HANDOFF_PATH = '/_/h/';
/** Where Apache sends every failed handoff. */
export const HANDOFF_FAILED_PATH = '/_/join/#handoff-failed';
export const TRANSFER_COOKIE_MAX_AGE = 120;
export function gateCookieValue(fid: string, did: string, sid: string): string;   // "<fid>.<did>.<sid>"
export function personalLinkUrl(siteOrigin: string, linkSecret: string): string;  // <origin>/_/join/#t=<t>
export function panicLinkUrl(siteOrigin: string, key: string): string;            // <origin>/_/panic/#k=<k>
export function parseLinkFragment(hash: string): { t?: string; k?: string; mode?: 'resume' | 'reconfirm' | 'view' | 'handoff-failed' };

// store layout (§2.2)
export const STORE_PATHS = {
  marker: '.omw-store.json', locked: 'locked',
  session: (fid: string, did: string, sid: string) => `s/${fid}/${did}.${sid}`,
  sessionDir: (fid: string) => `s/${fid}`, sessionPrefix: (did: string) => `${did}.`,
  handoff: (did: string) => `h/${did}`,
  personTombstone: (fid: string) => `t/${fid}`, deviceTombstone: (fid: string, did: string) => `t/${fid}.${did}`,
} as const;
export const StoreMarker = z.object({ format: z.literal(1), storeId: StoreId, epoch: Epoch, op: Count, at: IsoUtc });
export const StoreTombstone = z.object({ s: z.enum(['revoked', 'deleted']), at: IsoUtc });
export const StoreLock = z.object({ at: IsoUtc, by: z.enum(['admin', 'panic', 'mac']) });

// domain / origin config (Q9)
export const AccessMode = z.enum(['open', 'gate']);
export const CookieMode = z.enum(['headers', 'co', 'parent']);
export const SiteAccessConfig = z.object({
  mode: AccessMode,
  siteOrigin: Origin,
  /** "/<secret>/" in gate mode (one segment, ^[a-z0-9]{20}$), "/" or the basePath in open mode. */
  contentPath: BasePath,
  apiPublicBase: PublicApiBase,
  cookieMode: CookieMode,
  /** co: the site host; parent: the shared parent domain. */
  cookieDomain: z.string().regex(/^[a-z0-9.-]+$/).optional(),
  /** Absolute store path as Apache sees it (gate mode); safe inside a RewriteCond test string. */
  storeDir: z.string().regex(/^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/).optional(),
  /** Production only: emit the http→https redirect (P0b-10). */
  httpsRedirect: z.boolean(),
});
/** Cross-field rules (backend config and the API boot call the same checks). */
export function siteAccessProblems(cfg: SiteAccessConfig): string[];
//  gate ⇒ storeDir set, without a ".." segment or "//"; contentPath matches ^/[a-z0-9]{20}/$;
//  siteOrigin https unless host is 127.0.0.0/8 | localhost; httpsRedirect ⇒ siteOrigin https;
//  co ⇒ cookieDomain === site host; parent ⇒ cookieDomain is a dot-suffix of the site host AND of
//  the API host and has ≥ 2 labels.
export const SiteHeartbeat = z.object({ origin: Origin, access: AccessMode, cookieMode: CookieMode,
  storeDir: z.string().max(300).nullable() });

// gate pages (§2.6, §6.2)
export const GatePage = z.enum(['join', 'info', 'wait', 'ended', 'me', 'panic']);
export const GateBoot = z.object({
  page: GatePage,
  api: PublicApiBase,
  locales: z.array(LocaleCode).min(1),
  defaultLocale: LocaleCode,
  cookies: z.object({ session: z.string().min(1), key: z.string().min(1), transfer: z.string().min(1),
    handoff: z.string().min(1), resume: z.string().min(1), secure: z.boolean() }),
  cookieMode: CookieMode,
  /** F1/F2: the Domain the JS must use when it writes or deletes key/transfer cookies; null = host-only. */
  cookieDomain: z.string().regex(/^[a-z0-9.-]+$/).nullable(),
  build: z.string().min(1).max(64),
});

// privacy notice (D11, Q7): plain text, paragraphs separated by a blank line, no markup
const NoticeParagraphs = z.string().min(1).max(4000);
export const NoticeTexts = z.object({
  title: z.string().min(1).max(120),
  intro: NoticeParagraphs,      // what this is
  collected: NoticeParagraphs,  // what is stored under the person's id
  audience: NoticeParagraphs,   // who sees what (traveler sees names; followers only counts)
  purpose: NoticeParagraphs,    // why
  retention: NoticeParagraphs,  // how long (kept after access ends, until deletion; backups)
  rights: NoticeParagraphs,     // rights incl. "Delete me", where to complain
});
export const NoticeController = z.object({
  name: z.string().min(1).max(120), email: z.email().max(254), address: z.string().max(300).optional(),
});
export const PrivacyNotice = z.object({
  controller: NoticeController,
  /** Every site locale must be present (checked by the API against site.locales). */
  texts: z.partialRecord(LocaleCode, NoticeTexts).refine((v) => Object.keys(v).length > 0).meta({ minProperties: 1 }),
});
export const PrivacyNoticeDraft = z.object({
  controller: z.object({ name: z.string().max(120), email: z.string().max(254), address: z.string().max(300).optional() }),
  texts: z.partialRecord(LocaleCode, z.object({
    title: z.string().max(120), intro: z.string().max(4000), collected: z.string().max(4000), audience: z.string().max(4000),
    purpose: z.string().max(4000), retention: z.string().max(4000), rights: z.string().max(4000),
  }).partial()),
});
export const PublicNotice = PrivacyNotice.extend({ version: z.int().min(1), publishedAt: IsoUtc });
export const NoticeVersionInfo = z.object({ version: z.int().min(1), publishedAt: IsoUtc, sha256: Sha256Hex });
export const PrivacyState = z.object({
  draft: PrivacyNoticeDraft, draftSha256: Sha256Hex, current: PublicNotice.nullable(),
  versions: z.array(NoticeVersionInfo), problems: z.array(z.string()),  // why the draft cannot be published yet
});
export const PrivacyPublishRequest = z.object({ ifDraftSha256: Sha256Hex });

// public (site → API)
export const UnavailableReason = z.enum(['locked', 'restoring', 'notice_missing', 'too_many_pending', 'store']);
const Invalid = z.object({ status: z.literal('invalid') });
const Ended = z.object({ status: z.literal('ended') });
const Unavailable = z.object({ status: z.literal('unavailable'), reason: UnavailableReason });
const PollAfter = z.int().min(500).max(60_000);
/** "/_/h/" (with `session`: write the transfer cookie, then navigate) or "/" (already has a
 *  session, or F2: the cookies came with the API response). */
export const HandoffPath = z.enum(['/_/h/', '/']);
export const JoinCheckRequest = z.object({ t: AccessToken, k: AccessToken.optional() });
export const JoinCheckResponse = z.discriminatedUnion('status', [
  Invalid, Unavailable,
  z.object({ status: z.literal('known_device'), noticeRequired: z.boolean() }),
  z.object({ status: z.literal('pending_device') }),
  z.object({ status: z.literal('ok'), follower: z.object({ name: FollowerName }), notice: PublicNotice, deviceMustWait: z.boolean() }),
]);
/** New device: t + consentVersion. Resume: resume=true + k, no t. (PHP enforces; 400 otherwise.) */
export const JoinRequest = z.object({
  t: AccessToken.optional(), k: AccessToken.optional(), resume: z.literal(true).optional(),
  consentVersion: z.int().min(1).optional(), locale: LocaleCode,
});
/** `session` is present exactly when `handoff` is "/_/h/" (PHP enforces; a header rule below). */
const Active = z.object({ status: z.literal('active'), handoff: HandoffPath, session: GateSession.optional(),
  deviceKey: AccessToken.optional() });
const Activating = z.object({ status: z.literal('activating'), pollAfterMs: PollAfter, deviceKey: AccessToken.optional() });
const Pending = z.object({ status: z.literal('pending'), pollAfterMs: PollAfter, deviceKey: AccessToken.optional() });
export const JoinResponse = z.discriminatedUnion('status', [
  Invalid, Ended, Unavailable, Active, Activating, Pending,
  z.object({ status: z.literal('consent_outdated'), notice: PublicNotice }),
]);
export const DeviceKeyRequest = z.object({ k: AccessToken });
export const DevicePollResponse = z.discriminatedUnion('status', [Ended, Unavailable, Active, Activating, Pending]);
export const MeHelloResponse = z.discriminatedUnion('status', [
  Ended, Unavailable,
  z.object({ status: z.literal('active'), follower: z.object({ name: FollowerName }),
    device: z.object({ id: DeviceId, label: z.string().max(60) }),
    notice: z.object({ version: z.int().min(1), required: z.boolean() }).nullable() }),
]);
export const MeNoticeResponse = z.discriminatedUnion('status', [
  Ended, Unavailable, z.object({ status: z.literal('ok'), notice: PublicNotice, confirmedVersion: z.int().min(1).nullable() }),
]);
export const MeConsentRequest = z.object({ k: AccessToken, version: z.int().min(1), locale: LocaleCode });
export const MeDeleteRequest = z.object({ k: AccessToken, confirm: z.literal('delete-all-my-data') });
export const MeSimpleResponse = z.object({ status: z.enum(['signed_out', 'deleted', 'ended']) });
export const PanicRequest = z.object({ key: AccessToken });
export const PanicResponse = z.object({ ok: z.literal(true) });

// data view / export (D12)
export const DeviceState = z.enum(['pending', 'active', 'revoked', 'declined']);
export const DataCategoryKey = z.enum(['devices', 'consents', 'visits', 'views', 'reactions', 'messages', 'email']);
export const DataDevice = z.object({ id: DeviceId, label: z.string().max(60), state: DeviceState,
  createdAt: IsoUtc, lastSeenAt: IsoUtc.nullable(), thisDevice: z.boolean() });
export const DataConsent = z.object({ version: z.int().min(1), confirmedAt: IsoUtc, locale: LocaleCode });
export const FollowerDataView = z.object({
  follower: z.object({ id: FollowerId, name: FollowerName, since: IsoUtc, state: z.enum(['active', 'revoked']) }),
  devices: z.array(DataDevice), consents: z.array(DataConsent),
  categories: z.array(z.object({ key: DataCategoryKey, count: Count })),
  noticeVersion: z.int().min(1).nullable(),
});
export const MeDataResponse = z.discriminatedUnion('status', [
  Ended,
  z.object({ status: z.literal('ok'), data: FollowerDataView }),
  /** Pending, declined or separately revoked device (§3.3 D12 rights): only this device. */
  z.object({ status: z.literal('limited'), device: z.object({ label: z.string().max(60), state: DeviceState, createdAt: IsoUtc }) }),
]);
export const FollowerDataExport = z.object({
  format: z.literal('omw-follower-data/1'), exportedAt: IsoUtc,
  follower: z.object({ id: FollowerId, name: FollowerName, since: IsoUtc, state: z.enum(['active', 'revoked']),
    linkCreatedAt: IsoUtc.nullable(), revokedAt: IsoUtc.nullable() }),
  devices: z.array(DataDevice.omit({ thisDevice: true }).extend({ decidedAt: IsoUtc.nullable(),
    revokedAt: IsoUtc.nullable(), revokedBy: z.enum(['owner', 'follower', 'system']).nullable() })),
  consents: z.array(DataConsent.extend({ notice: PrivacyNotice })),
  categories: z.array(z.object({ key: DataCategoryKey, count: Count })),
});

// admin
export const AdminDevice = z.object({ id: DeviceId, state: DeviceState, label: z.string().max(60), first: z.boolean(),
  createdAt: IsoUtc, decidedAt: IsoUtc.nullable(), revokedAt: IsoUtc.nullable(),
  revokedBy: z.enum(['owner', 'follower', 'system']).nullable(), lastSeenAt: IsoUtc.nullable(), sessionAt: IsoUtc.nullable() });
export const AdminFollower = z.object({ id: FollowerId, name: FollowerName, note: FollowerNote.nullable(),
  state: z.enum(['active', 'revoked']), createdAt: IsoUtc, revokedAt: IsoUtc.nullable(),
  link: z.object({ createdAt: IsoUtc }).nullable(), devices: z.array(AdminDevice),
  consent: z.object({ version: z.int().min(1), confirmedAt: IsoUtc }).nullable(), lastSeenAt: IsoUtc.nullable() });
export const FollowerTombstone = z.object({ id: FollowerId, state: z.literal('deleted'),
  deletedAt: IsoUtc, deletedBy: z.enum(['follower', 'owner', 'restore']) });
export const FollowerListResponse = z.object({ items: z.array(AdminFollower), tombstones: z.array(FollowerTombstone) });
export const FollowerCreate = z.object({ name: FollowerName, note: FollowerNote.optional() });
export const FollowerPatch = z.object({ name: FollowerName.optional(), note: FollowerNote.nullable().optional() });
export const PersonalLink = z.object({ url: z.url({ protocol: /^https?$/ }), createdAt: IsoUtc });
export const FollowerCreated = z.object({ follower: AdminFollower, link: PersonalLink });
export const PersonalLinkCreated = z.object({ link: PersonalLink });
export const FollowerDeleteRequest = z.object({ confirm: z.literal(true) });
export const WriterMode = z.enum(['direct', 'sftp', 'none']);
export const Effect = z.object({ applied: z.boolean(), via: z.enum(['direct', 'sftp', 'mac', 'pending']), pendingOps: Count });
export const StoreReport = z.object({ at: IsoUtc, mode: z.enum(['normal', 'restored_api']), deleted: Count,
  missing: z.array(z.object({ fid: FollowerId, did: DeviceId })), orphans: z.array(z.object({ fid: FollowerId, did: DeviceId })),
  imported: z.array(z.string().max(200)) });
export const AccessSummary = z.object({
  locked: z.boolean(), lockedAt: IsoUtc.nullable(), lockedBy: z.enum(['admin', 'panic', 'mac']).nullable(),
  pendingDevices: Count, pendingOps: Count, oldestPendingOpAt: IsoUtc.nullable(),
  writer: z.object({ mode: WriterMode, blocked: z.boolean(), error: z.string().max(500).nullable() }),
  restoring: z.boolean(), mismatch: z.boolean(), unreadNotices: Count, noticeVersion: z.int().min(1).nullable(),
});
export const GateCheckResult = z.object({ at: IsoUtc, by: z.enum(['mac', 'api']),
  result: z.enum(['ok', 'gate_open', 'store_unverified', 'error', 'skipped']), detail: z.string().max(300).nullable() });
/** Not persisted by the admin (names): Home's pending-device cards read it (§7.5). */
export const PendingDeviceCard = z.object({ did: DeviceId, fid: FollowerId, name: FollowerName,
  label: z.string().max(60), createdAt: IsoUtc });
export const AccessStatus = AccessSummary.extend({
  panicLink: z.boolean(), siteOrigin: Origin.nullable(), cookieMode: CookieMode,
  lastReconcile: StoreReport.nullable(), lastAppliedAt: IsoUtc.nullable(),
  storeId: StoreId.nullable(), storeProofAt: IsoUtc.nullable(), gateCheck: GateCheckResult.nullable(),
  pending: z.array(PendingDeviceCard).max(3),
});
export const AccessActionResult = z.object({ effect: Effect, follower: AdminFollower.optional(),
  device: AdminDevice.optional(), status: AccessSummary.optional() });
export const LockRequest = z.discriminatedUnion('locked', [
  z.object({ locked: z.literal(true) }),
  z.object({ locked: z.literal(false), password: z.string().min(1).max(1000) }),
]);
export const PanicLinkCreated = z.object({ url: z.url({ protocol: /^https?$/ }) });
export const OwnerNoticeKind = z.enum(['follower_deleted', 'restore_reconciled', 'store_mismatch']);
export const OwnerNotice = z.object({ id: z.int().positive(), kind: OwnerNoticeKind, createdAt: IsoUtc, readAt: IsoUtc.nullable() });
export const OwnerNoticeList = z.object({ items: z.array(OwnerNotice) });
export const NoticeReadRequest = z.object({ ids: z.array(z.int().positive()).min(1).max(100) });

// backend access sync (§3.6)
export const StoreOp = z.object({ id: z.int().positive(), op: z.enum(['init', 'put', 'delete', 'delete_prefix', 'delete_tree']),
  path: z.string().min(1).max(200), content: z.string().max(1000).nullable(), exclusive: z.boolean() });
export const StoreListing = z.object({
  marker: z.string().max(1000).nullable(), locked: z.string().max(1000).nullable(),
  sessions: z.array(z.string().regex(/^s\/[a-z2-7]{12}\/[a-z2-7]{8}\.[A-Za-z0-9_-]{43}$/)).max(10_000),
  handoffs: z.array(DeviceId).max(10_000),
  tombstones: z.array(z.object({ path: z.string().regex(/^t\/[a-z2-7]{12}(?:\.[a-z2-7]{8})?$/), content: z.string().max(1000) })).max(10_000),
  strays: z.array(z.string().max(200)).max(1000),   // anything else found (reported, deleted when inside s/ h/)
});
export const AccessClaimRequest = z.object({ holder: z.literal('mac') });
export const AccessClaim = z.object({ lease: z.object({ until: IsoUtc }).nullable(), storeId: StoreId.nullable(),
  epoch: Epoch, ops: z.array(StoreOp).max(200), listingWanted: z.boolean() });
export const AccessRenewRequest = z.object({ epoch: Epoch });
export const AccessLease = z.object({ lease: z.object({ until: IsoUtc }).nullable() });
export const StoreListingUpload = z.object({ epoch: Epoch, listing: StoreListing });
export const AccessAck = z.object({ epoch: Epoch, appliedThrough: Count,
  failed: z.object({ opId: z.int().positive(), error: z.string().max(500) }).optional() });
export const ServiceSession = z.object({ cookieName: z.string().min(1), cookieValue: GateSession, expiresAt: IsoUtc });
```

Header rules for PHP (enforced before any write, 422/400 as noted): `JoinRequest` shape (§3.4);
`PrivacyNotice.texts` must contain `de`, `en` and every `site.locales` locale (422
`notice_incomplete`); `StoreOp.path` and every listing path matched against `StoreLayout` per op
kind; an `Active` answer carries `session` if and only if `handoff` is `/_/h/` (tested in the
contract samples and in PHPUnit).

### 4.2 Changes to existing modules

`src/api.ts`
- Settings (+ defaults, PHP `Settings::DEFAULTS/KEYS` mirrored):

  ```ts
  const HHMM = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  export const ReleaseSlots = z.object({ enabled: z.boolean(), times: z.array(HHMM).min(1).max(6).meta({ uniqueItems: true }) });
  export const DepartureHold = z.object({ enabled: z.boolean(), maxDays: z.int().min(1).max(7) });
  'publish.release_slots': ReleaseSlots,        // default { enabled: false, times: ['08:00', '20:00'] }
  'publish.departure_hold': DepartureHold,      // default { enabled: false, maxDays: 7 }
  'publish.moved_on_at': IsoUtc.optional(),     // clearable; the "moved on" button sets it to now
  'site.here_now': HereNow,                     // default 'city_badge' (today's behaviour)
  'site.time_precision': TimePrecision,         // default 'exact' (today's behaviour)
  ```
  `CLEARABLE_SETTING_KEYS` += `publish.moved_on_at`; `SettingsPatch` gets it as
  `.nullable().optional()`; `settingsProblems()` += "release slot times must be ascending and
  unique" (PHP mirror in `Settings::problems`). In time, `times` are wall-clock times in
  `timezone.current`.
- `Heartbeat` += `site: SiteHeartbeat.optional()`.
- `PublishedReport` += `gateCheck: GateCheckResult.optional()` (the Mac's post-deploy check, §5.6.3).
- `ChangesResponse` and `ChangesPage` += `access: z.object({ needsWriter: z.boolean() }).optional()`.
- `StatusResponse` += `access: AccessSummary.optional()` (counts only, no names: the status query
  is persisted in the admin's IndexedDB).
- `API_SCHEMAS` += (io in brackets) `JoinCheckRequest`[in], `JoinCheckResponse`[out],
  `JoinRequest`[in], `JoinResponse`[out], `DeviceKeyRequest`[in], `DevicePollResponse`[out],
  `MeHelloResponse`[out], `MeNoticeResponse`[out], `MeConsentRequest`[in], `MeDeleteRequest`[in],
  `MeSimpleResponse`[out], `MeDataResponse`[out], `FollowerDataExport`[out], `PanicRequest`[in],
  `PanicResponse`[out], `FollowerListResponse`[out], `AdminFollower`[out], `FollowerCreate`[in],
  `FollowerPatch`[in], `FollowerCreated`[out], `PersonalLinkCreated`[out], `FollowerDeleteRequest`[in],
  `AccessActionResult`[out], `AccessStatus`[out], `LockRequest`[in], `PanicLinkCreated`[out],
  `PrivacyNoticeDraft`[in], `PrivacyNotice`[out], `PrivacyState`[out], `PrivacyPublishRequest`[in],
  `OwnerNoticeList`[out], `NoticeReadRequest`[in], `AccessClaimRequest`[in], `AccessClaim`[out],
  `AccessRenewRequest`[in], `AccessLease`[out],
  `StoreListingUpload`[in], `AccessAck`[in], `ServiceSession`[out], `StoreMarker`[out],
  `StoreTombstone`[out], `StoreLock`[out]. (`api.ts` imports these from `./access.js`; the
  registry stays in `api.ts`.)

`src/site.ts`
- `DayDetail`: remove `lat` and `lng` (E4).
- `export const HereNow = z.enum(['city_badge', 'city', 'country', 'none'])`,
  `export const TimePrecision = z.enum(['exact', 'part_of_day'])`;
  `SiteInfo` += `hereNow: HereNow.optional()`, `timePrecision: TimePrecision.optional()` (absent =
  `city_badge` / `exact`).
- `Boot` += `access: z.object({ api: PublicApiBase-regex, cookies: z.object({ key: z.string(), transfer: z.string(), handoff: z.string() }), cookieMode: CookieMode-enum, cookieDomain: z.string().nullable() }).optional()`
  (present in gate mode; defined inline in `site.ts` to avoid an import cycle).

`src/policy.ts` (header text extended; vectors `fixtures/vectors/release.json`)
```ts
export interface ReleaseSettings {
  'publish.release_slots': { enabled: boolean; times: readonly string[] };
  'publish.departure_hold': { enabled: boolean; maxDays: number };
  'publish.moved_on_at'?: string | undefined;
  'timezone.current': string;
}
/** First slot instant >= `at` (wall clock `times` in `tz`); `at` itself when slots are off.
 *  DST: a slot inside a gap fires at the first instant after it; an ambiguous one at the earlier. */
export function nextReleaseSlot(at: Instant, slots: ReleaseSettings['publish.release_slots'], tz: string): string;
/** "Hội An " / "hội an" → "hội an"; blank → null (NFC, trim, collapse spaces, toLowerCase). */
export function placeKey(place: string | null | undefined): string | null;
export interface HoldDay { date: string; place: string | null; firstAt: string }
/** For each date: firstAt of the earliest LATER date whose placeKey is non-null and differs from
 *  this date's non-null placeKey; null when this date has no place or no such later date. */
export function leftPlaceAt(days: readonly HoldDay[]): Map<string, string | null>;
/** null = hold off; else min(entryAt + maxDays·24h, moved_on_at if moved_on_at >= entryAt, leftAt). */
export function holdEndAt(entryAt: Instant, leftAt: string | null, s: ReleaseSettings): string | null;
/** null when publishAt is null; else nextReleaseSlot(max(publishAt, holdEnd ?? publishAt)). */
export function entryReleaseAt(publishAt: string | null, holdEnd: string | null, s: ReleaseSettings): string | null;
/** Portrait (P0): override 'pending' → null; revoked+hide → null; an override 'hidden' is ignored
 *  (wave 4: a hidden photo may be the portrait); review mode → occurredAt (the pick is the review);
 *  'public' override → occurredAt; else capturePublishAt(); then entryReleaseAt with the hold. */
export function portraitReleaseAt(capture: CapturePolicyInput, annotation: AnnotationPolicyInput | null | undefined,
  settings: PolicySettings & ReleaseSettings, holdEnd: string | null): string | null;
```
`HoldDay`s are built from **every** item of a date (captures of any visibility except
revoked-and-hidden, and posts of any visibility), so held and pending days still count as "she
is there". Release slots and the hold never change `effectiveCaptureVisibility()` (API and admin
semantics stay); they only delay when a public item is emitted by the generator. Removals stay
immediate.

`src/time.ts` (vectors `fixtures/vectors/time-buckets.json`)
```ts
export type PartOfDay = 'night' | 'morning' | 'midday' | 'afternoon' | 'evening';
/** 3-hour bucket of the local wall time: 00,03,21 night · 06,09 morning · 12 midday · 15 afternoon · 18 evening. */
export function timeBucket(at: Instant, tz: string): { startHour: 0 | 3 | 6 | 9 | 12 | 15 | 18 | 21; partOfDay: PartOfDay };
/** at − (local (hour mod 3)·3600 + minute·60 + second + ms) + index seconds (ISO, ms = 000). */
export function coarsenToBucket(at: Instant, tz: string, index: number): string;
export function zonedWallTimeToUtc(date: string, hhmm: string, tz: string): string; // used by nextReleaseSlot
```

`src/ids.ts` (vectors added to `fixtures/vectors/ids.json`)
```ts
/** Published id of an owner post: "p_" + base32(sha256("post:" + publicId))[0..16] (E16). */
export function publishedPostIdFromSha256Hex(digestHex: string): string;
export async function publishedPostId(publicId: string): Promise<string>;
```
Matches the existing `PostPublicId` regex, so story routes and `NoteEntry`/`StoryEntry` ids keep
their schema.

### 4.3 JSON Schema export and vectors
- `pnpm schemas` regenerates `api/schemas/*.json` (+ `index.json`); `pnpm schemas:check` in CI.
- New vector files (TS tests in `packages/contracts/test/vectors.test.ts`; PHP in
  `api/tests/Domain/VectorsTest.php` only where PHP has a port):
  `release.json` (TS), `time-buckets.json` (TS), `ids.json` + `publishedPost` cases (TS),
  `access-paths.json` (TS + PHP: cookie value, link URL, store paths, path regex accept/reject
  lists, `ACCESS_STORE_DIR` accept/reject list), `store-reconcile.json` (PHP: desired + listing →
  DB imports + ops, both modes, sticky lock older/newer than `unlocked_at`, ops newer than the
  listing skipped, orphans removed, unknown fids tombstoned, missing, stray files).

### 4.4 Added to wave 5 by the owner: change password (contract)

`src/api.ts`: `export const PasswordChange = z.object({ currentPassword: z.string().min(1).max(1000), newPassword: z.string().min(12).max(4096), revokeAppTokens: z.boolean() })`
(+ registry `PasswordChange`[in]). API behaviour in §3.12.

---

## 5. Backend: generator and publisher

### 5.1 Configuration (`backend/src/config.ts`, `backend/README.md`)

| Env | Default | Meaning |
|---|---|---|
| `ACCESS_MODE` | `open` | `gate` turns on everything in §5.4–5.7 (live hosting). `open` = today's output plus the P0 fixes and options (dev, fixtures, Docker e2e). |
| `SITE_PUBLIC_URL` | (exists) | In gate mode: `https://<site host>/<secret>/` with `<secret>` = `^[a-z0-9]{20}$`, exactly one path segment (generate once: `node -e "…"` documented). Its origin is the site origin; its path is the content basePath. |
| `API_PUBLIC_URL` | origin of `API_BASE_URL` | The API origin the browser calls (CSP `connect-src`, gate pages). Required in gate mode. |
| `ACCESS_STORE_DIR` | – | Absolute store path as Apache sees it **[P0b-3]**, `^/[A-Za-z0-9._/-]+$`, no `..`, no `//`. Required in gate mode. |
| `ACCESS_COOKIE_MODE` | `headers` | `headers` \| `co` (F1) \| `parent` (F2) **[P0b-5]** |
| `ACCESS_COOKIE_DOMAIN` | – | `co`: the site host; `parent`: the shared parent domain |
| `ACCESS_HTTPS_REDIRECT` | `false` | `true` emits the http→https redirect (§2.4.1) **[P0b-10]**; only with an https `SITE_PUBLIC_URL` |
| `GATE_OUT_DIR` | `backend/data/out-gate` | Where the gate tree is generated (sibling of `OUT_DIR`, never inside it) |

`loadConfig()` builds a `SiteAccessConfig` (§4.1) and rejects the config on
`siteAccessProblems()`. In gate mode `site.indexable` is ignored (always `noindex`, no sitemap; a
warning is logged once). Nothing in `backend/src` may contain a hostname literal: a unit test
greps `backend/src`, `api/src`, `frontend/*/src` and `packages/contracts/src` for
`schaefchens` and for `your-server.de` outside `publisher/hostkeys.ts` and fails on a hit (Q9).
WP2 changes the one existing hit, the SFTP host placeholder in `backend/src/ui/pages.ts`
(`placeholder="www99.your-server.de"`), to `sftp.example.org`.

### 5.2 P0 safety fixes (both modes)

| Fix | Where | Exact rule |
|---|---|---|
| No coordinates | `model.ts` | `DayDetail` never gets `lat`/`lng` (contract removes them, §4.2). The owner's `Day.lat/lng` stay in the API and the mirror. |
| Hashed post ids (E16) | `model.ts` `postEntry()` | `id = publishedPostIdFromSha256Hex(sha256Hex('post:' + post.publicId))` via `node:crypto`. Story routes use that id. Generator test: no published id matches `^p_[0-9A-HJKMNP-TV-Z]{26}$` (ULID). |
| Neutral OG (E10, E7) | `pages.ts` `documentHead()` | Every page: `og:title` = `t.privateTitle` ("Privat" / "Private"), `og:type=website`, `twitter:card=summary`; **no** `og:description`, `og:image*`, `og:url`, `og:site_name`, `<meta name="author">`; `<meta name="description">` = `t.privateTitle`. `<title>` stays page-specific (tabs, history, accessibility). The picker page likewise. |
| Portrait respects the delay (E17) | `model.ts` `avatarFor()`/`profileFor()` | The portrait is published only when `portraitReleaseAt(...) <= now` (§4.2; hold and slots included). Otherwise the **previously published** portrait stays: store meta key `portrait.published` = `{"sourceKey","focus"}` written after each run that published a portrait; the model falls back to it when it is still a valid ready photo and its own `portraitReleaseAt <= now`; else no portrait. `nextRunAt` includes the pending portrait's release instant. The admin's portrait picker shows "Erscheint, sobald das Foto veröffentlicht ist" when the release is in the future. |
| Trip end clamp (E8) | `model.ts` trip summaries/details | `end = min(trip.endDate, last public day of the trip)` in `TripSummary` and `TripDetail` (`start` unchanged). Test: no published `end` is later than the trip's last public day. |
| Time buckets (configurable) | `model.ts` | Only when `site.time_precision = 'part_of_day'`: each published entry's `at` = `coarsenToBucket(at, entry.tz, i)` where `i` = 0-based index among the day's entries in the same bucket, ordered by original `(at, id)`; `firstAt/lastAt` follow. `SiteInfo.timePrecision = 'part_of_day'`. Default `exact` = today. |

`GENERATOR_VERSION` → 6 (forces a full run that re-stamps every page).

### 5.3 Q1/Q2 options in the model (`model.ts`, all off by default)

1. Build `HoldDay[]` for every effective local date that has any item (captures of any
   visibility except revoked-and-hidden, posts of any visibility): `place = Day.placeName`,
   `firstAt` = earliest item instant of that date. `leftAt = leftPlaceAt(days)`.
2. For every item that is public by today's rules: `publishAt` = `capturePublishAt()` (captures)
   or `occurredAt` (posts); `holdEnd = holdEndAt(at, leftAt.get(date), settings)`;
   `releaseAt = entryReleaseAt(publishAt, holdEnd, settings)`. The item is emitted only when
   `releaseAt <= now`. Days, trips, covers and counts are built from emitted items only.
3. `nextRunAt` = the smallest future `releaseAt` (plus the portrait's). The app's scheduler
   already re-runs the generator at `nextRunAt`.
4. **Here-now** (`site.here_now`), applied to the *current stay* = the trailing run of emitted
   days whose `placeKey` equals the newest emitted day's `placeKey` (just the newest day when it
   has no place):
   - `city_badge` (default): unchanged;
   - `city`: unchanged data; `SiteInfo.hereNow = 'city'` (the SPA shows no "Now in"/"Here now"
     badge and no pulse);
   - `country`: the current stay's days lose `place` in `DaySummary`, `DayDetail` and pages
     (country kept); `hereNow = 'country'`;
   - `none`: the current stay's days lose `place` **and** `country`; `hereNow = 'none'`.
   When the departure hold is enabled, `city_badge` is emitted as `city` (the newest released
   day is by definition a place she has left). Owner-written titles, captions and descriptions
   are never changed (the admin says so next to the option). The IANA `tz` of those days stays
   (documented residual).
5. Day `v` hashes include the changed fields, so the dependency map re-renders affected pages.

### 5.4 Gate tree (`backend/src/generator/gate.ts`, `gate-pages.ts`; gate mode only)

`renderGateTree(ctx): Map<path, bytes>` produces exactly the files of §2.1 (except `/<secret>/`
and `/.omw-gate.json`):
- `/.htaccess` (§2.4.2) from `extras.ts` `rootHtaccess(cfg, csp)`; `/<secret>/.htaccess` comes
  from `extras.ts` `contentHtaccess(site, cfg)` and is part of `OUT_DIR` as today.
- the neutral page (§2.5) for `/index.html`, `/_/index.html`, `/_/n/index.html` (same bytes);
- `/_/403.txt`, `/robots.txt`, `/favicon.svg` (constant SVG in `gate-pages.ts`);
- the six gate pages (§2.6) with `GateBoot` (`api = API_PUBLIC_URL + 'api/v1/public/'`,
  `locales`/`defaultLocale` from settings, cookie names per §2.3.1, `cookieDomain` = null in
  `headers` mode, else `ACCESS_COOKIE_DOMAIN`, `build` = the gate bundle hash);
- `/_/assets/**` copied from the gate bundle build (`frontend/site/dist/gate/`, read by
  `site-build.ts` `readGateBuild()`: `.vite/manifest.json` entry `src/gate/main.ts` → `file`,
  `css[]`, imported chunks; `SiteBuildError` when missing in gate mode).
Written atomically into `GATE_OUT_DIR` (same `writeAtomic` helpers); stray files in
`GATE_OUT_DIR` are removed on full runs. The gate tree's inputs (config, locales, build hash)
are part of the generator state hash, so a change triggers its rewrite.

Content tree changes in gate mode (`pages.ts`, `generate.ts`):
- CSP meta: `connect-src 'self' <API origin>` and `worker-src 'none'` (instead of `'self'`: the
  site registers no service worker, and one must never be able to serve cached content to a
  device whose access ended, §3.11);
- `Boot.access = {api, cookies: {key, transfer, handoff}, cookieMode, cookieDomain}`;
- `robots.txt`/`sitemap.xml` are not written into `OUT_DIR` (the gate tree's robots.txt rules);
- `.htaccess` per §2.4.3.

### 5.5 `verify.ts` additions

- Gate tree: every file in `GATE_OUT_DIR` passes a **public-surface leak test**: given the
  fixture profile and model, no file contains the author name, any place name, country name,
  trip title/slug, any date of the content (`YYYY-MM-DD`), any entry id, any media hash, the
  `<secret>`, or a count; and no file (the gate bundle included) contains one of the generic
  words that say "someone is away" (whole word, case-insensitive): `Reise`, `reist`, `Reisen`,
  `unterwegs`, `Urlaub`, `journey`, `travel`, `travels`, `trip`, `vacation`, `she`, `her`. Only
  the allowed files exist. (German `sie` is not on the list: in the du-form gate texts it would
  only match unrelated uses; the gate strings are reviewed as part of WP3.)
- `.htaccess`: the block between `# >>> omw gate v1` and `# <<< omw gate v1 <<<` is byte-identical
  in both files and equals `gateBlock(cfg)`; outside it, no line matches
  `/^\s*(Rewrite\w*|Require|Satisfy|Order|Allow|Deny|AuthMerging|SetEnvIf\w*)\b/i` (the root's
  cookie section is checked against `rootCookieSection(cfg)` exactly); `IgnoreInherit` and
  `RewriteEngine Off` appear nowhere; no other `.htaccess` exists in either tree. The real
  `contentHtaccess()` output passes this check (it has no `FilesMatch` dot block in gate mode,
  §2.4.3), tested with the generator's own output, not a hand-written sample.
- Neutral page: the CSP hashes in `{{CSP_N}}` equal sha256 of the exact inline script and style
  bytes of the generated page (a mismatch would silently disable the resume script).
- Content: no day JSON has `lat`/`lng`; no HTML has `og:image`, `og:description`, `og:url` or
  `meta name="author"`; no published post id is ULID-shaped; trip `end` ≤ last trip day; in gate
  mode no site bundle file contains `serviceWorker.register` and every page's CSP has
  `worker-src 'none'`.

### 5.6 Publisher: targets, deploy order, the anonymous-refused check

#### 5.6.1 Targets (`publisher/types.ts`, `targets.ts`, control UI target form)

New optional fields on both target kinds:
- `gateRoot` (sftp, `RemoteRoot`) / `gateDir` (local): where `GATE_OUT_DIR` goes (the web root,
  usually `/`). In gate mode required; the content root (`remoteRoot`/`dir`) must then equal
  `gateRoot + '/' + <secret>` (validated; error code `gate_config`).
- `accessStoreRoot` (sftp, `RemoteRoot`) / `accessStoreDir` (local): the store as this login
  sees it, for the Mac fallback writer and the lock button (§5.6.6). Optional.
- `publish: boolean` (default `true`): `false` = a store-only target (separate SFTP account
  restricted to the store, **[P0b-2]**), skipped by deploys.

A gate-mode deploy to an SFTP target **refuses** (`gate_config`) when the connection lacks
`posix-rename@openssh.com` (`atomicReplace=false`): a delete+rename window on a `.htaccess` must
never happen. The "Test" result shows it as today.

#### 5.6.2 Deploy order (gate mode, `publisher/index.ts` + new `publisher/gate.ts`)

1. **Gate tree** (`gate.ts`, own small record `/.omw-gate.json` at `gateRoot`: path → sha256):
   upload changed files under `_/` (assets first, then pages), then `robots.txt`,
   `favicon.svg`, `index.html`; then **`/.htaccess` last and only when its hash changed**; then
   delete obsolete gate files. Never lists or touches `/<secret>/`, `/.omw-store/`,
   `/.well-known/`, or any path not in the gate record.
2. **Content tree**: today's algorithm unchanged, relative to the content root (immutable →
   data → index → pages incl. `/<secret>/.htaccess` → manifest → deletes). The two `.htaccess`
   files are therefore never replaced at the same moment.
3. **Gate check** (§5.6.3). `gate_open` → `ok:false`, `errorCode:'gate_open'`, the publisher
   re-uploads both `.htaccess` files once (forced) and checks again; still failing → the
   PublishedReport carries `error: 'gate_open: …'` and the API raises `publish_failing`
   immediately (critical when the error starts with `gate_open`). `store_unverified`, `error`
   and `skipped` leave `ok` as the upload result and travel in `gateCheck` (§5.6.3).
In open mode the deploy is today's (single root, `httpcheck.ts`).

#### 5.6.3 Anonymous-must-be-refused check (`publisher/gatecheck.ts`)

At most **5 requests, 2 s apart**, only after a deploy that changed something in the gate tree or
a `.htaccess`, after a change of the writer or store settings, or when the last successful check
is older than 6 h (otherwise skipped):

| # | Request (no cookies unless stated) | Must be | Failure is |
|---|---|---|---|
| 1 | `GET <origin>/<secret>/data/manifest.json?t=<now>` | 403, body = `/_/403.txt` bytes | `gate_open` |
| 2 | `GET <origin>/<secret>/data/days/0000-00-00.json` | identical status, `content-length` and body to #1 | `gate_open` |
| 3 | `GET <origin>/<secret>/<defaultLocale>/` | 200, body = neutral page bytes (sha256 equal) | `gate_open` |
| 4 | #1 with `Cookie: <cookieName>=<new value>` | 200 JSON whose `version` = the deployed version (replaces `httpcheck.ts` in gate mode) | `store_unverified` (the session the writer just created is not in the folder Apache reads) |
| 5 | #1 with `Cookie: <cookieName>=<previous value>` | 403 | `store_unverified` (the delete did not reach that folder) |

Before #4 the publisher asks `GET /backend/access/service-session?rotate=1` (keeping the previous
value in memory) and waits until it is applied (503 `busy` → retry every 2 s, up to 30 s; with
`none` the Mac's own writer applies it first). #4 and #5 together prove that **both** put and
delete reach the folder Apache reads (§2.2). Without an API, #4–#5 are `skipped`; without a
previous value (first run), #5 is `skipped`.

A network error or timeout is `error`, never `gate_open`: the host may be blocking the Mac's IP
(HOSTING §10). `error` and `skipped` do **not** fail the publish report (`ok` stays as the upload
result); the report carries `gateCheck` (§4.2), the API stores it, and the admin shows "Gate-Prüfung
nicht möglich (seit …)" when neither this check nor the API's probe (§3.9) has succeeded for
24 h, so a blind spot is never silent. `gate_open` fails the report (below); `store_unverified`
raises the critical alert `access_store_unverified` and the admin shows "Zugang nicht geprüft".

#### 5.6.4 Migration of the live preview (one-off)

`backend publish --migrate-to-gate <targetId>`:
1. Generate in gate mode; check that the target has `gateRoot='/'` and the content root
   `/<secret>`.
2. Upload the gate tree with `/.htaccess` last. From that moment every old root path answers
   the neutral page (no sessions exist yet).
3. Deploy the content tree into `/<secret>/` with a fresh deploy record (everything uploaded; the
   mass-delete guard is not involved).
4. Run the gate check.
5. List the legacy root record (`/.omw-deploy.json.gz` at `/`) and print the paths it would
   delete (old `de/`, `en/`, `data/`, `media/`, `assets/`, `404.html`, …) minus every gate-tree
   path; delete only with `--confirm`, then delete the legacy record.

#### 5.6.5 Q9: configurable domain

All origins come from config: backend `SITE_PUBLIC_URL`, `API_PUBLIC_URL`,
`ACCESS_COOKIE_*`; API `SITE_ORIGIN`, `APP_URL`, `ACCESS_COOKIE_*`. The heartbeat's `site`
field lets the API alert on a mismatch. **Constraint (documented in HOSTING):** with
`ACCESS_COOKIE_MODE=headers` or `co`, site and API may live on different registrable domains;
nothing breaks (the device key travels in the request body, §3.11). Only F2 (`parent`) needs one
shared registrable domain; moving the site to its own domain then breaks every session at once.
Same-site is **not** needed for D6/D7 identity requests (wave 6 reactions use the same key). A
domain change (any mode) loses every cookie (they are host-bound): each person reopens their
personal link; the first device rejoins without approval only if the person never had one, so
the runbook says: before switching, tell followers; afterwards approve the devices in People.

#### 5.6.6 Mac fallback writer and lock button (`backend/src/access/`)

- `access/store-remote.ts`: store operations over the existing `connectSftp()` (or the local
  filesystem for local targets) on the target with `accessStoreRoot`: `init`, `put(exclusive)`,
  `replace`, `delete`, `deletePrefix`, `deleteTree`, `list`, `read` → same semantics as §3.8.1;
  every SFTP operation has a 5 s timeout.
- `access/fallback.ts`: the sync loop (`sync/index.ts`) passes `changes.access.needsWriter`;
  when true (and a store target exists): `claim` → if `listingWanted`: list the store
  (`StoreListing`) → `listing` → read the marker and check `storeId` + `epoch` (§3.8.4; mismatch →
  `ack` with `failed: store_mismatch`, nothing applied) → apply the returned ops in order,
  checking `lease.until − 10 s` before each and renewing (`POST /backend/access/renew`) or
  stopping → replace the marker → `ack`. One run at a time; it runs at most every 15 s (the pull
  interval). Authentication failures block the target exactly like publish targets (never
  retried).
- Control UI: "Website sperren" button on the targets page (only with a store target): reads the
  marker (it must exist; the last known `storeId` from `claim` is compared when the Mac has one),
  then writes `locked` `{"at","by":"mac"}` exclusively and reports "Gesperrt" only after that;
  a missing marker reports "Website-Speicher nicht gefunden – Pfad prüfen". The API imports the
  lock at its next reconcile (sticky lock, §3.3). Works with the API down and with PHP exhausted.
  Unlock only in the admin.
- `sync/client.ts`: `claim()`, `renew()`, `uploadListing()`, `ack()`, `serviceSession(rotate)`;
  heartbeat adds `site: {origin, access, cookieMode, storeDir}`; the publish report adds
  `gateCheck`.

### 5.7 Preview server (`generator/serve.ts`)

In gate mode it serves `GATE_OUT_DIR` at `/` and `OUT_DIR` at `/<secret>/` **without** enforcing
the gate (it prints so); gate behaviour is tested only with Apache (§8.2).

---

## 6. Site (`frontend/site`)

### 6.1 Gate bundle build

- New entry `src/gate/main.ts` (vanilla TypeScript, no React, no Lingui runtime), CSS
  `src/gate/gate.css` (Tailwind 4 with `@source` limited to `src/gate/**`, theme tokens from
  `@omw/ui/styles/theme.css`, system font stack; soft cream → lilac background; **no** plane,
  route or photo motif).
- `vite.gate.config.ts`: `base: './'`, `build.outDir: 'dist/gate'`, `emptyOutDir: true`,
  `manifest: true`, `rolldownOptions.input: 'src/gate/main.ts'`, single chunk preferred.
- `package.json`: `"build": "vite build && vite build -c vite.gate.config.ts"`. (The Dockerfile
  check `test -f frontend/site/dist/gate/.vite/manifest.json` is added in WP5, once WP3 has
  landed, so WP2 never breaks the Docker build.)
- Budget: ≤ 25 KB gzip JS + CSS together.
- Strings: `src/gate/strings.ts`, a typed table `{de, en}` (+ the dev pseudo-locale `ar` for RTL
  checks; `dir` from `textDirection()`), keys listed in §6.2. Language: the first of
  `navigator.languages` that is in `GateBoot.locales`, else `defaultLocale`; a de|en switch on
  every page (remembered in `localStorage['omw.gate.lang']`, try/catch).

### 6.2 Gate pages (behaviour)

Shared modules: `api.ts` (`post(path, body)`: `fetch(api + path, {method:'POST', mode:'cors',
credentials: cookieMode === 'parent' ? 'include' : 'omit', headers: {'Content-Type':
'text/plain;charset=UTF-8'}, body: JSON.stringify(body), cache: 'no-store', referrerPolicy:
'no-referrer'})`, 15 s timeout, parses with the contract schemas in dev builds only);
`cookies.ts` (read/write/delete the key and transfer cookies with the names from
`GateBoot.cookies`; key cookie: `<key>=<k>; Path=/; Max-Age=1209600; SameSite=Strict`, transfer
cookie: `<transfer>=<session>; Path=/; Max-Age=120; SameSite=Strict`, each + `; Secure` when
`secure` and + `; Domain=<cookieDomain>` when `cookieDomain` is not null (F1/F2, §2.3.1);
deletion uses the same `Path`/`Domain` with `Max-Age=0`; a unit test per `cookieMode` pins the
exact strings); `handoff.ts` (`go(session)`: write the transfer cookie, then
`location.replace('/_/h/')`; the only way any page starts a handoff; neither `sid` nor `k` ever
enters a URL);
`notice.ts` (renders a `PublicNotice` in one locale: title, sections with headings from the
string table, controller block, "Version N · gültig seit …"); `boot.ts` (reads `#omw-gate`).
Every network error shows "Keine Verbindung. Erneut versuchen" with a retry button; 429 shows
"Zu viele Versuche. Bitte später noch einmal."

#### 6.2.1 `/_/join/` (personal link, resume)
1. Parse `location.hash` (`parseLinkFragment`), then `history.replaceState(null, '', '/_/join/')`
   (the secret leaves the address bar). Keep `t` in memory only.
2. `#resume` → `join {resume:true, k, locale}` (no `t`; if no key cookie → show "invalid").
3. `#handoff-failed` (Apache refused `/_/h/`, §2.3.2): if the transfer cookie still exists and
   `sessionStorage['omw.hr']` is unset: set it, wait 2 s (a file written a moment ago may not be
   visible to Apache yet, P0b-11), `location.replace('/_/h/')`. Otherwise
   `location.replace('/')`: a device with a valid session lands in the journey; any other gets
   the neutral page, whose script resumes by key at most once per 5 minutes (§1.3). A stranger
   without cookies ends on the neutral page. (`/_/` responses never carry `Clear-Site-Data`, so
   `sessionStorage` survives here.)
4. `#t=…` → `join/check {t, k?}`:
   - `invalid` → "Dieser Link ist nicht (mehr) gültig. Frag die Person, die ihn dir geschickt hat."
   - `unavailable` → `locked`/`restoring`/`store`: "Gerade nicht verfügbar. Bitte später noch
     einmal versuchen." [Erneut versuchen]; `notice_missing`: same text; `too_many_pending`:
     "Für diesen Link warten schon mehrere Geräte auf Bestätigung."
   - `known_device` → `noticeRequired` ? go to `/_/info/#reconfirm` : `location.replace('/')`.
   - `pending_device` → `location.replace('/_/wait/')` (no new device).
   - `ok` → **information screen**: heading "Dieser Link ist für {name}." · the notice
     (§6.2.7) · when `deviceMustWait`: "Dieses Gerät muss noch bestätigt werden, bevor du die
     Seite sehen kannst." · in-app browser hint when the UA matches
     `/FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)/` ("Öffne den Link am besten in Safari oder
     Chrome; sonst zählt diese App als eigenes Gerät.") · buttons **[Weiter]** (primary) and
     [Abbrechen] (→ neutral `/`). No pre-ticked box (D11). The gate bundle is public, so none of
     its strings may say that someone travels or is away (§5.5 word list).
5. [Weiter] → `join {t, k?, consentVersion: notice.version, locale}`:
   - `consent_outdated` → re-render the new notice (rare).
   - `active` → write the key cookie (if `deviceKey`); `handoff === '/_/h/'` → `go(session)`
     (transfer cookie + `location.replace('/_/h/')`), `'/'` → `location.replace('/')`.
   - `activating` → write the key cookie; poll `device/poll` every `pollAfterMs` (max 2 min),
     then `active` → as above; timeout → "Dauert länger als gedacht…" [Erneut versuchen].
   - `pending` → write the key cookie; `location.replace('/_/wait/')` (that page load makes
     Apache re-set the key cookie server-side, §2.3.1).
   - `ended` → `/_/ended/`; `invalid`/`unavailable` as above.

#### 6.2.2 `/_/wait/` (waiting for approval)
Reads the key cookie (none → "invalid" text with a hint to reopen the link). Polls
`device/poll {k}`: every 10 s for 2 min, then every 30 s up to 30 min, then stops with
[Erneut prüfen]; pauses while `document.hidden`, polls at once on `visibilitychange` to visible.
Texts: "Fast geschafft! Die Person, die dich eingeladen hat, bestätigt dieses Gerät. Du kannst
diese Seite schließen und später deinen Link wieder öffnen." (Reopening the link on this device
comes back here: `pending_device`.) A small link "Anfrage zurückziehen" → `/_/me/#signout`.
`active` with `/_/h/` → `go(session)`; `active` with `/` → `location.replace('/')`; `ended` →
`/_/ended/`.

#### 6.2.3 `/_/ended/`
"Kein Zugang auf diesem Gerät. Wenn du glaubst, dass das ein Irrtum ist, frag die Person, die
dich eingeladen hat." When a key cookie exists the page asks `me/data {k}` and shows the link
"Deine Daten" → `/_/me/` only for `ok` (full D12 rights: the device ended together with the
person's access, §3.3). `#deleted` variant: "Deine Daten wurden gelöscht." (no link, no request).

#### 6.2.4 `/_/info/`
`#reconfirm[&return=<path>]`: `me/notice {k}` → show the notice with "Die Datenschutzhinweise
haben sich geändert." and [Weiter] → `me/consent {k, version, locale}` → `location.replace(return
|| '/')` (`return` must start with `/` and contain no `//`). `#view`: same notice, read-only, with
"Zurück". `ended` → `/_/ended/`.

#### 6.2.5 `/_/me/` (Your data, D12)
`me/data {k}`:
- `limited` (a waiting or declined device, §3.3): only "Dieses Gerät: {label} · {state chip} ·
  seit {date}" and, while pending, **[Anfrage zurückziehen]** (`me/signout` → `declined`, then
  delete the key cookie). No other device, no name, no export, no delete button. A line explains:
  "Deine Daten kannst du auf einem bestätigten Gerät einsehen, exportieren und löschen, oder du
  bittest die Person, die dich eingeladen hat."
- `ok` → shows: "Persönlich geteilt mit {name} seit {date}"; this device (label); other
devices (label, state chip, since, last seen); confirmed notice versions (version, date) with a
link "Datenschutzhinweise ansehen" (`/_/info/#view`); "Was gespeichert ist" (categories with
counts); buttons:
- **[Daten exportieren]** → `me/export` → download (`Blob`, file name from
  `Content-Disposition`, fallback `data.json`: the public bundle names nothing).
- **[Auf diesem Gerät abmelden]** (also reachable as `/_/me/#signout`, which opens the
  confirmation directly) → confirm sheet ("Um dieses Gerät wieder zu nutzen, öffne deinen Link
  erneut; die Person, die dich eingeladen hat, muss es dann neu bestätigen.") → `me/signout` →
  delete the key cookie, clear `localStorage`/`sessionStorage` (try/catch) → "Abgemeldet."
- **[Mich und alle meine Daten löschen…]** → §6.2.6.
- Link back to the journey (`/`) when the device is active.
`ended` → "Für dieses Gerät sind keine Daten (mehr) gespeichert."

#### 6.2.6 Delete me: deliberate confirmation
A full-screen sheet: what will be deleted (from the categories), "Das kann nicht rückgängig
gemacht werden. Du verlierst sofort den Zugang auf allen Geräten.", an **unticked** checkbox
"Ich verstehe, dass alles endgültig gelöscht wird", and a red button "Jetzt endgültig löschen"
that is disabled until the box is ticked; [Abbrechen] has the focus by default. On press:
`me/delete {k, confirm:'delete-all-my-data'}` → `deleted` → delete the key cookie, clear
storage, `location.replace('/_/ended/#deleted')`.

#### 6.2.7 Information screen content (D11)
Order: `texts.title`; `intro`; headings "Was gespeichert wird" (`collected`), "Wer was sieht"
(`audience`), "Wozu und wie lange" (`purpose`, `retention`), "Deine Rechte" (`rights`, plus the
fixed sentence "Unter „Deine Daten“ kannst du alles einsehen, exportieren und löschen."),
"Verantwortlich" (`controller.name`, `address`, `email` as `mailto:`), footer "Version {n} ·
{publishedAt as date}". Paragraph text is rendered as text nodes (never HTML); blank lines
split paragraphs.

#### 6.2.8 `/_/panic/`
Reads `#k`, removes it from the address bar, shows one big button "Website jetzt sperren" →
`panic {key}` → "Gesperrt (wenn der Link gültig war). Entsperren geht nur im Admin."

### 6.3 SPA changes

| File | Change |
|---|---|
| `src/data/fetch.ts` | New `AccessEndedError extends DataFetchError`: thrown for status 403, and for a 200 whose `Content-Type` is not JSON (the neutral page). |
| `src/access/access.ts` (new) | `AccessState` store: `'ok' \| 'checking' \| 'locked' \| 'unavailable'`. `onAccessEnded()`: stop the manifest poll, `queryClient.cancelQueries()` + `clear()`, then (gate mode only) `me/hello {k}`: `unavailable/locked` → state `locked`; `ended` → `location.replace('/_/ended/')`; `active` (store glitch) → `location.replace('/_/join/#resume')`; network error or no key → state `unavailable`. Open mode: state `unavailable`. |
| `src/access/hello.ts` (new) | Gate mode only. "A visit" (D11): call `me/hello` on every SPA start (after the first render, `requestIdleCallback`) unless one succeeded in this tab less than 5 minutes ago (`sessionStorage['omw.helloAt']`), always when the handoff cookie exists (delete it and any leftover transfer cookie first), and when the tab becomes visible after ≥ 30 minutes hidden. `active` → store `follower.name` in `sessionStorage['omw.name']`; `notice.required` → `location.assign('/_/info/#reconfirm&return=' + encodeURIComponent(location.pathname))`; `ended` → `/_/ended/`. Errors are ignored (viewing never depends on the API). Load: a few requests per follower and day (the `me` limit is 60/h). |
| `src/access/ended-screen.tsx` (new) | Full-screen states: `locked`/`unavailable` → "Die Reise ist gerade nicht verfügbar." [Erneut versuchen] (reload) and, in gate mode, a link "Deine Daten" (`/_/me/`). |
| `src/routes/root.tsx` | Wraps the outlet in `AccessBoundary` (renders the ended screen when the state is not `ok`); the router's `errorComponent` routes `AccessEndedError` to `onAccessEnded()`. |
| `src/data/queries.ts` | `shouldRetry` never retries `AccessEndedError`; the manifest poll stops on it. |
| `src/components/site-header.tsx` | Gate mode: menu entries "Deine Daten" (`/_/me/`) and "Auf diesem Gerät abmelden" (`/_/me/#signout`); footer line "Persönlich geteilt mit {name}" when known. Hero: `hereNow` = `city_badge` → today; `city` → "Zuletzt in {place}" without live styling or relative "vor 12 Min."; `country` → "Zuletzt in {flag} {country name}"; `none` → no latest-place pill. |
| `src/components/decor.tsx`, `src/timeline/rows.tsx` | `LatestDayChip` only for `city_badge`. |
| `src/timeline/filmstrip.tsx`, `src/player/items.ts`, `src/timeline/rows-overview.tsx` | `timePrecision === 'part_of_day'` → `partOfDayLabel(entry.at, entry.tz)` ("morgens", "mittags", "nachmittags", "abends", "nachts" / "in the morning", …) instead of `formatTime`; relative times in the hero show days only ("heute", "gestern", "vor 3 Tagen"). |
| `src/boot.ts`, `src/site.tsx` | expose `Boot.access` and `SiteInfo.hereNow/timePrecision` via the site context. |
| `src/locales/*/messages.po` | new strings (de, en, pseudo-ar). |

The SPA never calls the API for viewing; `me/hello` is fire-and-forget.

---

## 7. Admin PWA (`frontend/admin`)

### 7.1 Routes and navigation
- New routes (`router.tsx`, lazy like the editors): `/people`, `/people/$fid`,
  `/settings/safety`, `/settings/privacy`.
- Side navigation (≥ 1024 px): "Menschen" between Trips and Settings, with a numeric badge =
  `access.pendingDevices`. Phone tab bar unchanged; the Settings tab shows a dot badge while
  devices are pending; Home has a People tile.
- `settings.tsx`: new list entries "Menschen & Zugang" (→ `/people`), "Sicherheit"
  (→ `/settings/safety`), "Datenschutzhinweise" (→ `/settings/privacy`); Account section gets
  "Passwort ändern" (§7.8).

### 7.2 Immediate access client (`src/api/access.ts`)
Access actions never go through `writes.ts` (offline queue, optimistic updates, 401 parking):
- plain `fetch` via the existing request primitive of `client.ts` (same CSRF header), wrapped in
  `useMutation({ retry: 0, networkMode: 'always' })` with mutation keys outside `MUTATION_NAMES`
  (never dehydrated);
- queries `qk.access.{status, followers, follower(fid), privacy, notices}` with
  `meta: { persist: false }` (nothing about people is stored in IndexedDB), `refetchOnWindowFocus`,
  Home polls `status` every 60 s while visible;
- every result shows its `effect`: `applied` → "Wirksam ✓"; not applied → "Noch nicht wirksam ⏳
  – der Website-Speicher ist gerade nicht erreichbar" + [Erneut versuchen]
  (`POST /admin/access/retry`); network failure → "Nicht gesendet – keine Verbindung" (never a
  success state); 401 → login (the action is not replayed).

### 7.3 People (`screens/people.tsx`)
- List: active people ("Oma · 2 Geräte · zuletzt heute", badge "1 wartet"), then "Zugang beendet"
  (revoked), then "Gelöscht" tombstones ("Person · gelöscht am 20. Nov. 2026 · von ihr selbst" /
  "von dir" / "bei Wiederherstellung"; no name, D12).
- [+ Person einladen] → sheet: name (required, 1–60), private note (optional, ≤ 200, "nur für
  dich") → `POST /followers` → **link sheet**: the URL (selectable), [Teilen]
  (`navigator.share({ text })`, text in de or en via a toggle: "Hallo {name}! Hier ist dein
  persönlicher Link zu meiner Reise. Bitte gib ihn nicht weiter: {url}"), [Kopieren]; the line
  "Der Link wird nur jetzt angezeigt. Geht er verloren, erstelle einen neuen; verbundene Geräte
  bleiben verbunden." Closing the sheet discards the link from memory.
- Banner when no notice version is published: "Bevor jemand beitreten kann, veröffentliche die
  Datenschutzhinweise." (→ `/settings/privacy`). Banner while the store is not initialised:
  "Website-Speicher einrichten" [Einrichten] (`POST /admin/access/store-init`, §2.2). Card while
  `restoring` and after a restore (§3.8.6, from the `restore_reconciled` notice): "Nach einer
  Wiederherstellung: N Geräte müssen ihren Link neu öffnen ({names}); M Personen fehlen in der
  Sicherung und müssen neu eingeladen werden." [OK].

### 7.4 Person (`screens/person.tsx`)
- Header: name (editable inline), note, "eingeladen am …", consent "Hinweise v{n} bestätigt am …".
- Devices: label, state chip (Wartet / Aktiv / Entfernt / Abgelehnt / Abgemeldet), since, last
  seen; actions: pending → [Erlauben] [Ablehnen] (with the hint "Erlaube nur Geräte, die du
  dieser Person zuordnen kannst. Im Zweifel kurz nachfragen."; `device_limit` → "{name} hat
  schon {n} Geräte. Entferne zuerst eines."); active → [Entfernen] (confirm).
- Actions: [Neuen Link erstellen] (confirm: "Der alte Link funktioniert dann nicht mehr.") →
  link sheet; [Daten exportieren] (download `FollowerDataExport`); [Zugang beenden] (confirm:
  "{name} sieht ab sofort nur noch die neutrale Seite. Was {name} schon gesehen hat, bleibt bei
  ihr/ihm. Gespeicherte Daten bleiben erhalten." + "Nimm {name} auch in WhatsApp aus deinem
  Status-Publikum."); [Alle Daten dieser Person löschen…] (sheet with an unticked checkbox, red
  button, irreversible; → tombstone).

### 7.5 Home (`screens/home.tsx`)
- Top card when `status.access.pendingDevices > 0`: Home then also fetches `GET /admin/access`
  (`qk.access.status`, not persisted, so names never reach IndexedDB) and renders
  `AccessStatus.pending`: "📱 Neues Gerät für {name} · {label} · vor {n} Min." [Erlauben]
  [Ablehnen] (up to 3, then "+ N weitere" → People).
- Shield card: unlocked: "🛡 Nur eingeladene Personen sehen die Reise" [Jetzt sperren] (confirm:
  "Alle sehen sofort nur die neutrale Seite, auch eingeladene Personen. Nichts wird gelöscht.");
  locked: "🔒 Gesperrt seit {time} (Admin/Panik-Link/Mac)" [Entsperren] (password dialog).
  Pending ops / writer blocked: "⏳ Änderungen noch nicht wirksam" [Erneut versuchen].
- People tile (count, badge). Owner notices ("Eine Person hat ihre Daten gelöscht · 20. Nov."
  [OK] → read). Departure hold card when the hold is on and days are held (computed client-side
  with `leftPlaceAt`/`holdEndAt` from the day list): "{place}: {n} Tage warten, bis sie
  weitergereist ist (spätestens {date})" [Sie ist weitergereist] → `PATCH settings
  {'publish.moved_on_at': now}`.

### 7.6 Safety settings (`screens/safety.tsx`; settings use the existing queued settings write)
- Publish mode: link to the existing section (unchanged).
- Release slots: switch (default off) + up to 6 times (chips, sorted before saving); explainer
  "Neues erscheint nur zu diesen Uhrzeiten ({timezone.current}). Entfernen wirkt sofort."
- Departure hold: switch (off) + "höchstens N Tage" (1–7) + [Sie ist weitergereist] + explainer.
- "Hier gerade"-Anzeige: four radio cards with mini previews: "Ort + Badge (wie bisher)", "Ort
  ohne Badge", "Nur das Land", "Nichts"; note "Eigene Titel und Bildunterschriften werden nicht
  verändert."
- Uhrzeiten: "Genau" (default) / "Nur Tageszeit (morgens, abends …)".
- Lock (same card as Home) and Panic link: [Panik-Link erstellen] → shown once with [Teilen]
  [Kopieren]; [Neu erstellen]; [Deaktivieren].
- Access status: writer mode, last applied, pending ops, last repair report, errors, [Erneut
  versuchen]; store: "eingerichtet" / [Website-Speicher einrichten]; "Zugang geprüft am …"
  (`storeProofAt` or a passed gate check #4–#5) or "Zugang noch nicht geprüft"; last gate check
  (`gateCheck`: ok / offen! / nicht geprüft / "Gate-Prüfung nicht möglich (seit …)").

### 7.7 Privacy settings (`screens/privacy.tsx`)
- Banner "Vorlage – keine Rechtsberatung. Bitte prüfen und anpassen."
- Controller: name, e-mail, address (optional).
- Texts per locale (tabs per `site.locales`): title, intro, collected, audience, purpose,
  retention, rights (plain text areas; blank line = new paragraph); live preview with the gate
  page's rendering rules.
- [Entwurf speichern] (`PUT /privacy/draft`, online only); [Als Version {n+1} veröffentlichen]
  (disabled while `problems` is non-empty, lists them) → confirm "Alle Personen sehen den neuen
  Text beim nächsten Besuch und bestätigen ihn." → `POST /privacy/publish {ifDraftSha256}`.
- Version history (version, date, sha256 prefix), each viewable read-only.

### 7.8 Change password (owner addition)
Settings → Account → [Passwort ändern] → sheet: current password, new password, repeat; a
strength hint (length ≥ 12 required; "schwach/mittel/stark" from length + character classes +
a 1 000-word common-password list shipped as a lazy chunk; hint only); when the user has app
tokens, a checkbox "Auch alle App-Zugänge (N Tokens) beenden", ticked by default
(`revokeAppTokens`); submit → `PUT /admin/me/password` → toast "Passwort geändert. Andere Geräte
wurden abgemeldet."; errors:
`wrong_password` ("Das aktuelle Passwort stimmt nicht."), 429 ("Zu viele Versuche…"), 422 (reason).

### 7.9 Other
- `settings-profile.tsx` portrait picker: hint "Das Porträt erscheint erst, wenn das Foto
  veröffentlicht ist (Verzögerung/Freigabe)." when `portraitReleaseAt > now`.
- Push texts never contain names (API side).
- Lingui catalogs de/en/ar updated.

---

## 8. Tests

### 8.1 Contracts (`packages/contracts/test`)
`access.test.ts` (every schema accepts the samples and rejects: bad ids, 42/44-char tokens,
`handoff` with a path or query beyond `/_/h/`, an old 4-part handoff path, `JoinRequest`
combinations, `LockRequest` without password, `PrivacyNotice` without a locale, a `GateSession`
with a fourth part, an `ACCESS_STORE_DIR`
with `%`, `$`, a space, `..` or `//`); `siteAccessProblems` table; helper round trips
(`gateCookieValue`, `personalLinkUrl`, `parseLinkFragment` incl. `#handoff-failed`, `STORE_PATHS`);
`vectors.test.ts` for `release.json`, `time-buckets.json` (incl. DST days in Europe/Berlin and
America/New_York, midnight, index ordering), `ids.json` (`publishedPostId`), `access-paths.json`;
`json-schema.test.ts` drift; settings defaults/patch for the new keys.

### 8.2 Apache harness (`backend/test/gate/`)
- `apache-harness.ts`: finds an Apache binary (`OMW_HTTPD`, `/usr/sbin/httpd`, `httpd`,
  `apache2` on `PATH`) and its module directory (`/usr/libexec/apache2`,
  `/usr/lib/apache2/modules`, `/usr/lib64/httpd/modules`), writes an `httpd.conf` like
  `apache-probe-w5/httpd.conf.in` (prefork, rewrite, headers, dir, mime, env, setenvif, authz;
  `AllowOverride All`; `<Files ".ht*"> Require all denied`) for a free port on 127.0.0.1, a
  docroot under `.cache/apache-test/<run>/` and the store on a **case-sensitive** volume (Linux:
  any directory; macOS: a small `Case-sensitive APFS` disk image created with `hdiutil` and
  attached with `-mountpoint` inside `.cache/apache-test/`, detached afterwards; macOS's default
  volume would accept a session id with flipped case, verified), starts/stops
  `httpd -f <absolute path> -k start|stop`.
- `apache.test.ts` (`describe.skipIf(!apache)`; script `pnpm --filter @omw/backend test:apache`;
  part of CI on macOS and Linux with `apache2`): generates the real gate tree
  (`renderGateTree`) and a fixture content tree (the real `contentHtaccess` output + a few
  pages, data and media files) and asserts every case of `apache-probe-w5r/run.sh` and of the
  review's `review-probe/review.sh`:
  A anonymous pairs byte-identical (status, headers minus `Date`, body) for existing/missing
  days, trips, stories, `/<secret>` with/without slash, data, media, assets, dot paths, `/x`;
  data/media 403 inside the secret folder equal to another folder (`/<secret>/data/x` vs
  `/zzz…/data/x`), `/<secret>/.omw-deploy.json.gz` equal to `/.nope`;
  B handoff (§2.3.2): valid key cookie + transfer cookie + marker + session → 303 `/<secret>/`
  with the exact four `Set-Cookie` strings (`__Host-omw`, `__Host-omw_k`, `__Host-omw_s=; Max-Age=0`,
  `__Host-omw_h`), `no-store`, `no-referrer`; transfer cookie without key cookie, no cookies, old
  4-part URL, wrong sid, malformed transfer cookie, locked, marker gone, `/_/h` without slash →
  303 `/_/join/#handoff-failed` without cookies;
  C follower page refresh cookies, data and media without `Set-Cookie`, `/` → 302, dir → 301
  slash, missing page → content 404; C′ `/_/wait/` and `/_/me/` with a key cookie → exactly one
  `Set-Cookie` (key), without → none, neutral page and `/_/assets/` with a key cookie → none,
  malformed key cookie → none; D stale cookie → neutral/403 + one `Clear-Site-Data`, never on
  `/_/`; E lock → refused, no `Clear-Site-Data`, handoff refused, `/_/join/` still served;
  F content `.htaccess` missing / with prepended stray rules / `IgnoreInherit` / `Require all
  granted` / `Options +Indexes` → still gated, and `verifyHtaccess()` rejects a file containing
  `RewriteEngine Off`; a stray `de/.htaccess` with `RewriteEngine Off` fails open for that subtree
  (asserted as the known residual, and `verify` rejects the tree); G root `.htaccess` missing →
  content gated; H header equality; I `/_/` pages public with `{{CSP_G}}`, neutral page with
  `{{CSP_N}}` and **no API origin** anywhere in its headers or body; J http-dev names (`omw`,
  `omw_s`, no `Secure`); K `ACCESS_COOKIE_MODE=co` variant (CO cookies from the transfer-cookie
  capture and `OMW_HK`, transfer cookie expired by a negative lifetime, CO refresh); L the store
  directory is not reachable over HTTP in layout F3 (`/.omw-store/...` → 403); M https redirect
  on (uniform 301 to `https://<host><path>?<query>` for existing, missing, data, dot and handoff
  paths; ACME still 200) and HSTS on every response; N duplicate `__Host-omw` cookies: the first
  wins; prefixed look-alike names, quoted values and a session path that is a directory are
  refused; O traversal set (`/_/../<secret>/data/…`, `/_/%2e%2e/…`, `//<secret>/…`, `?x=/_/`) →
  403 or neutral; P flipped-case session id → refused (case-sensitive store volume).

### 8.3 API (PHPUnit, `api/tests`)
- `Domain/Access/FollowersTest` (create/rotate/revoke/delete, id never reused, tombstone shape
  incl. `created_at = deleted_at`, name rules), `DevicesTest` (first device rule, 3-pending cap,
  reopening with a pending key ×3 → still one pending device, active-device cap
  `device_limit`, approve/decline/expiry, labels), `SessionsTest` (issue ops, `session` in the
  answer and never the key, redaction after apply, `activating` with a failing writer and the
  `pending_sid` path, one-time marker clearing via hello and cron TTL),
  `PrivacyNoticesTest` (draft, completeness incl. de+en with `site.locales = ['de']`, publish
  versions, sha conflict, consent required),
  `FollowerDataTest` (view/export content, delete erases rows + ops + notice, a second call
  answers `ended`), **`FollowerDataRightsTest`** (the D12 matrix: device state {pending, active,
  revoked by owner alone, revoked by follower, revoked together with the person, declined} ×
  follower state {active, revoked} × endpoint {data, export, delete, signout, notice, consent};
  expected: full rights only for active+active and revoked-together+revoked; `limited`/`ended`
  everywhere else; never another device's data in a `limited` answer),
  `ReconcilerTest` (vectors `store-reconcile.json`), `StoreApplierTest` (order, stop at first
  failure, lease vs Mac, per-op lease check, marker with `storeId`, refusal on a missing or
  foreign marker, `init` only without a marker, drain of ops enqueued during a run, no open
  transaction during writer calls: a fake writer asserts that the PDO connection is not in a transaction (`inTransaction()` is false)),
  `DirectStoreWriterTest` (temp dir: exclusive put, modes, prefix/tree delete, path validation
  rejects `..`, absolute, unknown shapes), `SftpStoreWriterTest` (against the backend's test SSH
  server is not available in PHP → a fake `SftpClient` interface; host-key pin, auth-failure
  blocking, refusal of a site login), `RateLimiterTest`, `UserAgentLabelTest`,
  **`LogPrivacyTest`** (runs join, hello, data, delete, revoke and cron with a capturing Monolog
  handler and asserts that no record contains a follower name, a link secret, a key or a sid).
- **Concurrency** (`Infra/StoreApplierConcurrencyTest`, `php -S` with 4 workers and a slow fake
  writer of 2 s per op): 5 parallel `join` requests; none waits more than about 1 s for the lock
  (the others answer `activating`), and every op is applied once, in id order, by the lock holder's
  drain.
- `Http/PublicJoinTest`, `Http/PublicMeTest`, `Http/PanicTest` (statuses of §3.4 incl.
  identical answers for unknown/rotated/revoked links, `pending_device`, CORS headers on every
  answer incl. 429, `text/plain` bodies, 413 before parsing, global cap 503),
  `Http/AdminFollowersTest`, `Http/AdminAccessTest` (lock/unlock with password, `unlocked_at`,
  retry, store-init), `Http/AdminPrivacyTest`, `Http/AdminPasswordTest` (§3.12: wrong current →
  403 + login_attempts, 12-char minimum, other sessions revoked and the current kept, app tokens
  kept with `revokeAppTokens:false` and revoked with `true`, backend tokens always kept, 429),
  `Http/BackendAccessTest` (claim with `storeId` and ≤ 200 ops, renew, lease loss → 409 on ack,
  listing, service-session incl. `rotate=1`, `changes.access.needsWriter`, heartbeat `storeDir`
  mismatch → alert, publish report `gateCheck` → stored and alerted),
  `Infra/CronJobsTest` (access job; probe once per hour; store proof once per 6 h with 302/200),
  `Infra/BootstrapRestoreTest` (rotateFeedId rotates the access epoch; joins `restoring` until
  reconcile; tombstones re-imported; deleted person erased again; unknown fids tombstoned;
  orphan sessions removed and reported), `Infra/ReconcileRaceTest` (an unlock committed between
  listing and plan: no re-lock, old lock file deleted; a lock file newer than `unlocked_at`:
  imported), `ContractSchemaTest` (new schemas), `VectorsTest` (`access-paths.json`).

### 8.4 Backend (vitest)
- `generator/model.test.ts` + `regressions.test.ts`: §5.2 table (no lat/lng, hashed ids, trip
  clamp, buckets on/off, portrait waits for its release and the previous portrait stays),
  §5.3 (slots, hold incl. moved-on and cap, here-now variants and the current-stay rule,
  `nextRunAt`).
- `generator/html.test.ts`: neutral OG on every page kind; CSP `connect-src` and
  `worker-src 'none'` in gate mode.
- `generator/gate.test.ts`: gate tree file list, neutral page byte-identity across paths and
  runs, CSP hashes equal the inline bytes, leak test with the fixture profile and the word list,
  `.htaccess` exactness, `verifyHtaccess` accepts the real `contentHtaccess()` output and rejects
  the forbidden lines; `[https]`/`[hsts]` lines only when configured.
- `publisher/gate-deploy.test.ts` (fake remote): order (gate `_/` → root files → `/.htaccess`
  last → content phases → manifest), `/.htaccess` only when changed, refusal without atomic
  replace, never touching `/<secret>/`, `/.omw-store/`, `/.well-known/`; migration command
  (dry run lists legacy paths minus gate paths; `--confirm` deletes).
- `publisher/gatecheck.test.ts` (fake fetch): pass, `gate_open` (200 JSON anonymously),
  `store_unverified` (#4 refused, or #5 still accepted), error on timeout does not fail the
  report, at most 5 requests 2 s apart, skipped when nothing changed < 6 h, `gateCheck` in the
  report.
- `access/fallback.test.ts` (fake API + local store dir): claim → listing → ops → ack; a store
  without marker or with another `storeId` → nothing applied, `failed: store_mismatch`; lease
  check before each op, renew, stop on lease loss; ≤ 200 ops; auth failure blocks; lock button
  writes `locked` exclusively and only after finding the marker.
- `config.test.ts`: gate config validation, `siteAccessProblems`, the hostname grep (green after
  the `pages.ts` placeholder change).

### 8.5 Site
- `test/gate/*.test.ts` (jsdom, fake `fetch`): join state machine for every response status
  incl. `pending_device` and `#handoff-failed` (one retry while the transfer cookie lives, then
  `/`), fragment removed from the URL, key and transfer cookies written before the handoff and
  the argument of every `location.replace`/`assign` is `/_/h/`, `/`, or a gate page (never
  containing a sid or key), cookie strings per `cookieMode` (`Domain` present in `co`/`parent`,
  deletion with the same `Domain`), wait-page polling schedule and visibility pause, info
  rendering as text (an HTML payload in a notice stays text), `/_/me/` with `limited` shows no
  other device, no name and no delete/export button, `/_/ended/` shows "Deine Daten" only for
  `ok`, delete button disabled until the box is ticked, signout clears cookie and storage,
  `return` path validation; the neutral script resumes at most once per 5 minutes even after
  `sessionStorage` was cleared (throttle cookie).
- `test/access.test.tsx`: `AccessEndedError` on 403 and on HTML; `onAccessEnded` branches;
  hello on every start with the 5-minute tab throttle, on visibility after ≥ 30 minutes, and the
  handoff cookie trigger; header menu only in gate mode; hero for the four `hereNow` values;
  part-of-day labels.
- `e2e/gate.spec.ts` (Playwright, no Apache): a static server for a generated gate tree plus an
  in-test mock API: join first device, pending → approve → handoff, pending device opens
  `/_/me/` (no follower data, no delete button), ended, me (export, delete), info reconfirm,
  panic; checks that no request leaves for any origin but the site and the mock API, and that
  no request URL ever contains the mock's session value or key.

### 8.6 Admin
- `test/access.test.ts`: effect rendering, no persistence of access queries (incl. the Home
  pending cards from `AccessStatus`), held-days computation.
- `e2e/people.spec.ts` (mock API, extended `e2e/mock/api.ts`/`server.ts`/`seed.ts`): store init
  banner, invite + link sheet (share/copy, shown once), approve/decline, `device_limit` message,
  remove device, end access, export, delete person → tombstone without invitation date,
  lock/unlock with password, privacy draft → publish, safety options save, access status
  ("Zugang noch nicht geprüft", "Gate-Prüfung nicht möglich"), change password with and without
  the app-token box.

### 8.7 Whole-stack e2e (`frontend/admin/e2e/stack/access-flow.stack.ts`)
A second stack instance (own root `.cache/e2e-stack-gate`, ports API 8081, control 8788, site
4174) in gate mode, skipped when no Apache binary is found:
- API: `php -S`, `ACCESS_STORE_MODE=direct`, `ACCESS_STORE_DIR=<root>/store`,
  `SITE_ORIGIN=http://127.0.0.1:4174`; backend: `ACCESS_MODE=gate`,
  `SITE_PUBLIC_URL=http://127.0.0.1:4174/<secret>/`, `API_PUBLIC_URL=http://127.0.0.1:8081/`,
  `ACCESS_STORE_DIR=<root>/store`, one local target (`dir=<root>/site/<secret>`,
  `gateDir=<root>/site`, `accessStoreDir=<root>/store`); Apache serves `<root>/site` on 4174
  (harness of §8.2). http loopback → cookie names `omw*` without `Secure`.
- Steps (serial): (0) admin initialises the store; (1) admin publishes notice v1;
  (2) anonymous context: day page → neutral, data → 403; (3) admin invites "Oma", reads the link;
  (4) context A opens it → info screen shows "Oma" + notice → Weiter → timeline; footer
  "Persönlich geteilt mit Oma"; no request URL in A's history or the Apache access log contains
  A's sid or key; (5) context B opens the same link → "muss bestätigt werden" → wait page; B
  reopens the link 3× → still one pending device; B opens `/_/me/` → only its own device, no
  delete button; admin Home shows the device; Allow → B in the timeline within 15 s; (6) admin
  removes B → B's next navigation ends on `/_/ended/`; A still works; (7) lock → A reload →
  neutral page, no `Clear-Site-Data`; unlock with password → A in; (8) admin publishes v2 → a new
  page of A (nothing cleared) → reconfirm → back; (9) a fresh context C navigates to `/_/h/`, then
  to `/_/h/` with only a copied transfer cookie (a cross-site navigation drops the Strict key
  cookie) → neutral page both times, within 10 minutes of A's handoff; (10) a revoked session
  file copied back into the store → `php bin/cron.php` → gone; (11) A: Your data → export JSON
  (`format omw-follower-data/1`, 2 consents) → delete me → `/_/ended/#deleted`; admin People shows
  the tombstone and the notice.
- Variant `ACCESS_STORE_MODE=none` (the Mac writer, own run): invite, join (A waits in
  `activating` until the backend's loop applies), revoke a device → the admin shows "Noch nicht
  wirksam" until `ack`, then the device is refused; a backend whose `accessStoreDir` points to an
  empty folder applies nothing (`store_mismatch`) and the admin never shows "Wirksam ✓".

---

## 9. Work packages

Order: **WP0** first (alone) → **WP1, WP2, WP3, WP4 in parallel** → **WP5**. Every package
ends green on `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm schemas:check`,
`scripts/composer test`, `scripts/composer stan` (and its own extra suites). Packages never edit
each other's files except where a row below says so.

### WP0 Contracts (M, ~4–5 days; blocks everything)
Files:
- `packages/contracts/src/access.ts` (new, §4.1), `src/index.ts` (export)
- `packages/contracts/src/api.ts` (settings keys + defaults + `CLEARABLE` + `SettingsPatch` +
  `settingsProblems`, `Heartbeat.site`, `PublishedReport.gateCheck`,
  `ChangesResponse/ChangesPage.access`, `StatusResponse.access`, `PasswordChange`, registry),
  `src/site.ts` (`DayDetail` −lat/lng, `HereNow`, `TimePrecision`, `SiteInfo`, `Boot.access`),
  `src/policy.ts`, `src/time.ts`, `src/ids.ts`
- `packages/contracts/test/{access.test.ts (new), api.test.ts, site.test.ts, policy.test.ts, time.test.ts, ids.test.ts, vectors.test.ts, samples.ts}`
- `fixtures/vectors/{release.json, time-buckets.json, access-paths.json}` (new), `ids.json`
- `api/schemas/*.json` (generated by `pnpm schemas`)
- Keep-green touches outside contracts (and nothing more): `api/migrations/0002_settings_w5.sql`
  (§3.2: without the seeded rows `ContractSchemaTest::testSeededSettingsMatchSettings` fails as
  soon as the new keys are required in `Settings.json`), `api/src/Domain/Settings.php`
  (`DEFAULTS`, `KEYS`, `CLEARABLE`, `WRITE_ORDER`, `problems()` for the slot order — the PHP test
  `testKeyListsMatchTheContract` requires it), `backend/src/generator/model.ts` (drop the two
  `lat`/`lng` lines), `frontend/site/scripts/make-dev-data.ts` (drop `lat`/`lng`) +
  regenerated dev data.
Definition of done: the common green list above, explicitly including `scripts/composer test`
with `0002_settings_w5.sql` applied. The estimate covers `nextReleaseSlot` with DST, the time
buckets, all of `access.ts` and the vectors.

### WP1 API (L, ~2–3 weeks)
Step 1 (needs network once): on a networked machine run
`scripts/composer require phpseclib/phpseclib:^3.0` and commit `api/composer.json` +
`composer.lock` (phpseclib, `paragonie/constant_time_encoding`, `paragonie/random_compat`;
none is in `api/vendor` or the local cache today). Until then, and for all tests, the SFTP writer
is built against the `SftpClient` interface with its fake, so the rest of WP1 is testable offline.
Files:
- `api/composer.json` + `composer.lock` (`phpseclib/phpseclib ^3.0`), `api/.env.example`,
  `api/README.md`
- `api/migrations/0003_access.sql` (§3.2)
- `api/src/Config.php`, `api/src/App.php` (DI), `api/src/Http/Routes.php`
- `api/src/Http/Middleware/Cors.php` (expose headers; credentials only for F2 routes),
  `api/src/Http/Middleware/PublicGuard.php` (new)
- `api/src/Http/Public/{PublicBody,JoinController,MeController,PanicController}.php` (new)
- `api/src/Http/Admin/{FollowerController,DeviceController,AccessController,PrivacyController,NoticeController}.php`
  (new), `StatusController.php` (`access` summary), `SessionController.php` (+ `password`)
- `api/src/Http/Backend/AccessSyncController.php` (new), `BackendController.php` (`changes.access`,
  heartbeat `site`)
- `api/src/Domain/Access/{Tokens,StoreLayout,Followers,Devices,Sessions,PrivacyNotices,Consents,AccessState,StoreOps,StoreApplier,Reconciler,FollowerData,UserAgentLabel,OwnerNotices}.php`
  + `privacy-template.json` (Appendix A) (new)
- `api/src/Domain/Auth/{Passwords.php (MIN_LENGTH 12), Users.php (setPassword keepTokenId revokeAppTokens)}`
- `api/src/Infra/Store/{StoreWriter,DirectStoreWriter,SftpStoreWriter,StoreWriterFactory,StoreWriterException,SftpClient}.php`
  (new), `api/src/Infra/RateLimiter.php` (new)
- `api/src/Infra/{CronRunner,Maintenance,Bootstrapper,Doctor}.php`,
  `api/src/Domain/Alerts/AlertEngine.php`
- `fixtures/vectors/store-reconcile.json` (new, PHP-only)
- tests of §8.3
Interfaces provided: §3.4 public, §3.5 admin, §3.6 backend routes exactly as the contracts say;
store layout §2.2; error codes `config_missing`, `notice_incomplete`, `wrong_password`,
`conflict`, `rate_limited`, `busy`, `device_limit`.
Internal order: D12 rights + their matrix test first (§3.3), then the applier rules of §3.8.3
with the concurrency test, then everything else.

### WP2 Backend generator and publisher (L, ~2–3 weeks)
Files:
- `backend/src/config.ts`, `backend/README.md`
- `backend/src/generator/{model.ts, pages.ts, strings.ts, extras.ts, generate.ts, site-build.ts, verify.ts, state.ts, serve.ts}`,
  `backend/src/generator/{gate.ts, gate-pages.ts}` (new)
- `backend/src/publisher/{types.ts, targets.ts, index.ts, cli.ts}`,
  `backend/src/publisher/{gate.ts, gatecheck.ts}` (new)
- `backend/src/access/{store-remote.ts, fallback.ts, service-session.ts}` (new),
  `backend/src/sync/{index.ts, client.ts}`, `backend/src/app.ts` (wire the fallback loop)
- `backend/src/ui/{targets.ts, pages.ts, server.ts, static/app.js}` (target fields, lock button,
  the SFTP host placeholder `sftp.example.org`)
- `backend/src/store/meta.ts` (`portrait.published` helpers)
- `backend/test/gate/{apache-harness.ts, apache.test.ts}`, `backend/test/generator/{gate.test.ts, model.test.ts, html.test.ts, regressions.test.ts, harness.ts}`,
  `backend/test/publisher/{gate-deploy.test.ts, gatecheck.test.ts}`, `backend/test/access/fallback.test.ts`,
  `backend/test/config.test.ts`, `backend/package.json` (`test:apache`)
Needs from WP3: the gate bundle build (`frontend/site/dist/gate/.vite/manifest.json`, entry
`src/gate/main.ts`). Until WP3 lands, tests use a stub build in
`backend/test/generator/fixtures/gate-build/` with the same manifest shape.
Internal order: P0 fixes (§5.2) → options (§5.3) → gate tree + `.htaccess` + verify (§5.4–5.5)
→ Apache harness (§8.2) → publisher (§5.6) → fallback writer (§5.6.6).

### WP3 Site (M, ~1–1.5 weeks)
Files:
- `frontend/site/vite.gate.config.ts` (new), `frontend/site/package.json` (build script)
- `frontend/site/src/gate/{main.ts, boot.ts, api.ts, cookies.ts, handoff.ts, strings.ts, notice.ts, dom.ts, gate.css}`,
  `frontend/site/src/gate/pages/{join.ts, wait.ts, ended.ts, info.ts, me.ts, panic.ts}` (new)
- `frontend/site/src/access/{access.ts, hello.ts, ended-screen.tsx}` (new)
- `frontend/site/src/{data/fetch.ts, data/queries.ts, routes/root.tsx, router.tsx, boot.ts, site.tsx}`,
  `src/components/{site-header.tsx, decor.tsx}`, `src/timeline/{filmstrip.tsx, rows.tsx, rows-overview.tsx}`,
  `src/player/items.ts`, `src/locales/{de,en,ar}/messages.po`
- `frontend/site/test/gate/*.test.ts`, `test/access.test.tsx`, `e2e/gate.spec.ts` (+ a small
  mock API in `e2e/gate-mock.ts`)
Interfaces: consumes `GateBoot` (`#omw-gate`), `Boot.access`, `SiteInfo.hereNow/timePrecision`,
public API (§3.4). Produces `dist/gate/` (§6.1).

### WP4 Admin (M, ~1–1.5 weeks)
Files:
- `frontend/admin/src/api/{access.ts (new), keys.ts, queries.ts, client.ts}`
- `frontend/admin/src/router.tsx`, `src/screens/{people.tsx, person.tsx, safety.tsx, privacy.tsx}` (new),
  `src/screens/{home.tsx, layout.tsx, settings.tsx, settings-profile.tsx}`
- `frontend/admin/src/components/{link-sheet.tsx, confirm-sheet.tsx, effect-badge.tsx, password-sheet.tsx}` (new)
- `frontend/admin/src/lib/held-days.ts` (new), `src/locales/{de,en,ar}/messages.po`
- `frontend/admin/e2e/mock/{api.ts, server.ts, seed.ts}`, `e2e/people.spec.ts` (new),
  `test/access.test.ts` (new)
Interfaces: admin API (§3.5, §3.12), settings keys (§4.2).

### WP5 Integration, docs, P0b application (M, ~4–5 days; after WP1–WP4 and P0b)
Files:
- `frontend/admin/e2e/stack/{stack.ts, access-flow.stack.ts (new)}`, `playwright.stack.config.ts`
  (both store modes, §8.7)
- `backend/Dockerfile` (the gate build check `test -f frontend/site/dist/gate/.vite/manifest.json`)
- `scripts/deploy-api.ts` (`--set-env-file=<file>`: merges `ACCESS_*` keys into the remote `.env`
  without printing values; a test for the existing `--reset-admin-password` password length)
- `docs/HOSTING.md` (gate requirements, store, P0b answers, cookie trade-offs, Q9 constraint,
  restore lines, migration; "delete downloaded backup copies older than `BACKUP_KEEP` days"),
  `docs/OPERATIONS.md` (revoke, lock, panic link, Mac lock, restore, store init, the first-device
  residual of Q3 c), `docs/PRIVACY.md` (new: what is stored where, cookies, templates not legal
  advice), `docs/PLAN.md` (decisions table: Q0 b, Q1 configurable, Q2, Q3 c, Q6, Q7, Q9;
  architecture rows), `README.md` (status), `backend/README.md` (gate env)
- Live configuration from P0b (§10.4), the one-off migration (§5.6.4) and the first gate deploy.
- **Live deploy order:** API first (`deploy-api.ts`: migrations `0002` and `0003` run; the
  change feed announces the new settings), then the backend (it then mirrors the new settings and
  generates with them), then "Website-Speicher einrichten" in the admin, then the gate migration.
- **Live acceptance checklist** (manual, with spaced requests from a network the host does not
  block, e.g. Brave's Tor window; ≥ 8 s between requests):
  (a) anonymous: a day URL gives the neutral page, a data URL gives 403, and their headers match
  the local harness; (b) real phone joins: iOS Safari, iOS tap from WhatsApp, Android Chrome from
  WhatsApp; record how many devices each path creates (in-app browser jars may not be detectable
  by UA); (c) revoke latency against §3.10 for the chosen writer; (d) lock/unlock; (e) delete-me
  end to end; (f) a restore drill on a copy (epoch rotation → `restoring` → reconcile); (g) the
  gate check (#1–#5) and, with `ACCESS_GATE_PROBE`, the API's store proof pass once.

### Interfaces between packages (summary)

| From → To | Interface | Defined in |
|---|---|---|
| WP0 → all | zod schemas, pure helpers, vectors | §4 |
| WP1 ↔ WP3 | public routes, statuses (`pending_device`, `limited`), `{handoff, session}`, cookie names, key-in-body | §3.4, §2.3, §4.1 |
| WP1 ↔ WP4 | admin routes, `AccessActionResult.effect`, `AccessStatus.pending`, error codes | §3.5, §3.12 |
| WP1 ↔ WP2 | settings via change feed; `changes.access`; claim/renew/listing/ack/service-session (`rotate`); heartbeat `site` (`storeDir`); publish report `gateCheck`; store layout + marker (`storeId`) | §3.6, §2.2 |
| WP2 ↔ WP3 | `dist/gate/.vite/manifest.json` (entry `src/gate/main.ts`); `#omw-gate` `GateBoot`; `Boot.access`; `SiteInfo` flags | §5.4, §6.1 |
| WP2 ↔ Apache ↔ WP1 | `.htaccess` text and the store path the API writes | §2.4, §2.2 |

---

## 10. P0b host probe (for the orchestrator)

Kit (revision 2, tested locally with `p0b/localtest.sh`, 13/13): `.cache/design-w5/p0b/site/*`
and `.cache/design-w5/p0b/api/p0b.php`. **Never upload or request anything else; delete everything
afterwards.** Space the orchestrator's own HTTPS requests at least **8 s** apart (HOSTING §10).
The probe script spaces its own requests to the site **5 s** apart and makes at most 5 per call
(three calls), so no single PHP request runs longer than about 25 s; those requests come from the
API server's own IP and include one 403 (T9) and no 404 (the 404 text is only requested by the
orchestrator in step 1b, and only when needed). The script lists only directories owned by its
own uid (it climbs from the API docroot only while the parent is owned by the account), so it
never shows other customers' folder names. The user noted that Brave's Tor window can reach the
hosts: the JSON answers are readable directly in the browser, and DevTools → Network shows the
headers for the browser path. Tor exits may be rate-limited; keep the spacing.

### 10.1 Prepare (local)
- `R = "p0b-" + 12 random [a-z0-9]`, `KEY` = 40 random `[A-Za-z0-9]`.
- `p0b-<R>.php` = `api/p0b.php` with `__KEY__`, `__R__`, `__SITE_ORIGIN__`
  (`https://the-on-my-way-website.schaefchens.de`), `__SFTP_HOST__` (`www99.your-server.de`).
- `.htaccess` v1 = `site/htaccess.in` with `__R__`, `__HOST__` = site host, and `__OUT__`,
  `__OUT7__`, `__IN__`, `__FRESH__` = `/nonexistent`.

### 10.2 SFTP uploads (no HTTPS)
Site login (root = site docroot): `/<R>/.htaccess` (v1), `/<R>/marker-<R>.txt` (`p0b-<R>`),
`/<R>/ok.txt`, `/<R>/no.txt`, `/<R>/n/index.html`, `/<R>/inh/.htaccess`,
`/<R>/inh/sub/index.html`, `/<R>/hs.html` (from `site/`), `/<R>/.st/.htaccess`
(= `site/st.htaccess`), empty files
`/<R>/.st/s/abcdefghijkl/abcdefgh.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` and
`/<R>/.st/h/abcdefgh`.
API login (root = API docroot): `/public/p0b-<R>.php`.
SFTP-only facts to record: `realpath('.')` of both logins and whether `..` lists anything (a login
that can leave its docroot can reach a store outside it, §2.8 F3); the site login's
`posix-rename@openssh.com` support (control UI → Publish → Test → "atomic replace").

### 10.3 Requests, in order, with the expected results

Orchestrator → API (each ≥ 8 s after the previous request of any kind):

| # | Request | Expected result |
|---|---|---|
| 1 | `GET https://<api>/p0b-<R>.php?k=<KEY>&step=env&create=1` | JSON: `php` (`version` 8.5.x, `ext` incl. `openssl`, ideally `sodium` and `gmp`; `ssh2` recorded; `open_basedir`, `max_execution_time`, `fastcgi_finish_request`), `site.found` / `docroot` / `sameOwner` / `writable`, `storeBase`, `out.ok` + `out.renameOverwrite`, `out711.ok`, `inByPhp.ok`, `fresh.base`, `sftpPort.ok` + banner `SSH-2.0-…`, `siteHttps.status` = 200 with body `YES` (the script's one request to `/<R>/ok.txt`), `selfHttps`. It also makes the store test folders. |
| 1b | only if `site.found` is false: `GET https://<site>/<R>/missing` | 404 with body `P0B-404 docroot=<abs> file=<abs> uri=/<R>/missing https=on` (gives the site docroot as Apache sees it) |
| – | SFTP (no HTTPS): upload `.htaccess` v2 | `__OUT__ = out.path`, `__OUT7__ = out711.path`, `__IN__ = <site docroot>/<R>/.st`, `__FRESH__ = fresh.base` (each `/nonexistent` when absent) |

Server path (when `siteHttps.status` was 200): three calls; each JSON has `tests` with `pass` per
test, `passed`, `total`, `skipped`.

| # | Request | Site requests made by PHP (5 s apart) and their expected results |
|---|---|---|
| 2 | `GET https://<api>/p0b-<R>.php?k=<KEY>&step=site&part=1` | **T2 paths** `/<R>/ok.txt` → 200, headers `x-p0b-file` (absolute path Apache uses), `x-p0b-docroot`, `x-p0b-https` (`on` expected); **T3 out** `/<R>/t/out` → `YES`; **T3 out711** `/<R>/t/out711` → `YES`; **T3 in** `/<R>/t/in` → `YES`; **T9 dot** `/<R>/.st/s/…` → 403 |
| 3 | `…&step=site&part=2` | **T7 inherit+noslash** `/<R>/inh/sub` → 200 `NEUTRAL`; **T8 END+If** `/<R>/x/y` → `NEUTRAL` + `Cache-Control: no-store`; **T6 cookie ok** `/<R>/c/` with `__Host-p0b=<fid>.<did>.<sid>` → `YES`; **T10 cookie stale** `/<R>/c/` with a wrong sid → `NO` + `Clear-Site-Data` |
| 4 | `…&step=site&part=3` | **T4 handoff (cookie-sourced, §2.3.2)** `/<R>/h/` with `__Host-p0b_k=<43×K>; __Host-p0b_s=<fid>.<did>.<43×A>` → 303 to `/<R>/c/` with exactly three `Set-Cookie`: `__Host-p0b=<fid>.<did>.<43×A>; …`, `__Host-p0b_k=<43×K>; …`, `__Host-p0b_s=; Path=/; Max-Age=0; …`; **T5 CO (F1)** `/<R>/co/` with `p0b_k=<43×K>; p0b_s=<fid>.<did>.<43×A>` → 303 with `p0bco=<fid>.<did>.<43×A>; …domain=<site host>`, `p0bck=<43×K>; …` and `p0b_s=x; …expires=<past>`; **T11 fresh visible**: PHP creates `<fresh.base>/s/abcdefghijkl/abcdefgh.<43×F>`, then at once `/<R>/t/fresh` → `YES` (on `NO`, one retry after 2 s is recorded as `retryAfter2s`); **T12 deleted gone**: PHP deletes it, then at once `/<R>/t/fresh` → `NO` (same retry rule). T11/T12 are `skipped` when `fresh.base` is null. |

Browser path instead of 2–4 (when `siteHttps.status` was not 200), from the Tor window, ≥ 8 s
apart, DevTools → Network open:

| # | Request | Expected result |
|---|---|---|
| B1 | `/<R>/ok.txt` | `YES`; response headers `X-P0b-File`, `X-P0b-Docroot`, `X-P0b-Https: on` |
| B2–B4 | `/<R>/t/out`, `/<R>/t/out711`, `/<R>/t/in` | `YES` each |
| B5 | `/<R>/.st/s/abcdefghijkl/abcdefgh.<43×A>` | 403 `NO` |
| B6, B7 | `/<R>/inh/sub`, `/<R>/x/y` | `NEUTRAL` each; B7 with `Cache-Control: no-store` |
| B8 | `/<R>/hs.html` → shows "cookies written: 4 (expect 4)" → press **T4** | `/<R>/h/` 303 → `/<R>/c/` showing `YES` (this also covers T6); three `Set-Cookie: __Host-p0b…` on the 303 |
| B9 | back to `/<R>/hs.html` (it rewrites the cookies) → press **T5** | `/<R>/co/` 303 → `/<R>/ok.txt` `YES`; `Set-Cookie: p0bco=…; domain=<site host>`, `p0bck=…`, `p0b_s=x; expires=<past>` |
| B10 | API `…&step=fresh&op=create`, then at once `/<R>/t/fresh` | `YES` (coarse: seconds, not milliseconds) |
| B11 | API `…&step=fresh&op=delete`, then at once `/<R>/t/fresh` | `NO` |

(T10 needs a hand-made stale HttpOnly cookie and is not needed for a decision: its rules are the
gate's, verified locally.)

Cleanup:

| # | Request | Expected result |
|---|---|---|
| 5 | `GET https://<api>/p0b-<R>.php?k=<KEY>&step=cleanup` | `removed`: every created test folder `true`; `self: true` |
| – | SFTP | delete `/<R>/` on the site; confirm `public/p0b-<R>.php` is gone |

Totals: orchestrator → API 5 requests (+1b when needed); PHP → site 1 + 13; browser path about
11 site requests + 2 API requests instead of calls 2–4.

### 10.4 Expected answers and decisions

| Id | Look at | Good answer | Decision if good | If not |
|---|---|---|---|---|
| P0b-1 | step 1 `site.found`, `site.sameOwner`, `site.writable`, `out.ok`, `php.open_basedir`; and P0b-11 | true / true / true / true, the store base inside `open_basedir`; T11 `YES` | API `ACCESS_STORE_MODE=direct`, `ACCESS_STORE_DIR=<storeBase>/omw-store/site1` | P0b-2 |
| P0b-2 | `sftpPort.ok`, banner `SSH-2.0-…`; and whether a **restricted** SFTP account (only the store folder) can be created (konsoleH / Hetzner's answer) | port 22 reachable from PHP and a restricted account possible | `sftp` with that restricted account (owner creates it; key auth preferred) | `none`: the Mac is the only writer (latency §3.10). The site's own login in the API only if the owner decides so explicitly (§11, `ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN`); it forces F3 |
| P0b-3 | `T3 out` | `YES` | store outside the docroot | F3 (`T3 in` must be `YES`) |
| P0b-4 | `T3 out711` | `YES` | modes 0711/0600 | F4 (0755/0644) |
| P0b-5 | `T4 handoff` (cookie-sourced: three `__Host-p0b…` cookies incl. the `Max-Age=0` expiry, 303 to `/<R>/c/`) | pass | `ACCESS_COOKIE_MODE=headers` (`__Host-` cookies) | `T5 CO` pass → `co` (F1); else `parent` (F2) only while site and API share a registrable domain (they do today: `schaefchens.de`) |
| P0b-6 | step 1 `siteHttps` | 200 `YES` | `ACCESS_GATE_PROBE=true` allowed (hourly probe + 6-hourly store proof) | false; the Mac's gate check is then the only detector, and the admin says when it is blind |
| P0b-7 | `T2 paths` (headers), `T7 inherit+noslash`, `T8 END+If`, `T6`, `T9 dot`, `T10` | all pass; `x-p0b-file` shows the absolute path Apache uses | gate block as specified; `ACCESS_STORE_DIR` (backend) = the absolute path as Apache sees it | F5: stop and report |
| P0b-8 | SFTP `atomic replace` of the site login | yes | gate deploys allowed | stop: the publisher refuses gate mode without atomic replace |
| P0b-9 | `php.fastcgi_finish_request`, `php.max_execution_time` | true, ≥ 30 | immediate notices after the response | cron-only notices (≤ 5 min) |
| P0b-10 | `x-p0b-https` on T2 (or the `https=` field of the 1b body) | `on` | `ACCESS_HTTPS_REDIRECT=true` | F6 (no redirect, HSTS only) |
| P0b-11 | `T11 fresh visible`, `T12 deleted gone` | `YES` / `NO` at the first try | `direct` latency "< 1 s" holds | retry needed → F7 (document the delay); `T11` `NO` even after 2 s → no `direct` |
| P0b-12 | `php.ext` | `sodium` and `gmp` present | `sftp` latency 1–3 s | `sftp` still works but each connection costs seconds: prefer `none` only if the measured revoke latency is worse than the Mac's |

Ask Hetzner support in writing (no requests needed): what triggers the observed IP block (4xx
counts? paths like `/.env`?), access-log retention and IP anonymisation (for the privacy text),
PHP-FPM processes and the FPM request timeout on the plan, whether an SFTP sub-account can be
limited to a folder outside a docroot, and whether http→https can be forced in konsoleH.

---

## 11. Open questions and owner decisions

**Blocking: none.** WP0–WP4 can start now; P0b (§10) only selects configuration (writer, store
place, file modes, cookie mode, https redirect) and every branch has its fallback.

Owner decisions this spec needs, each with a safe default that is built and shipped as is:
1. **The site's own SFTP login inside the API** (only relevant if P0b shows no shared filesystem
   and no restricted SFTP account is possible). Default: **no**, the Mac writes the store
   (`ACCESS_STORE_MODE=none`): revocation takes effect within 15–20 s while the Mac runs and not
   at all while it is off. "Yes" (`ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN=true`) gives 1–3 s
   revocation at any time, but a leaked API `.env` or a code-execution bug in the public PHP app
   would then let an attacker remove the gate, read all content and deface the site.
2. **Device cap** (D4 "the device limit"): default 5 active devices per person
   (`ACCESS_MAX_DEVICES`), on top of approving every further device (Q3 c).
3. **App tokens on password change** (owner text: "every other session is ended"): default:
   the sheet offers to end them, ticked (§3.12); backend tokens are never ended.

Decisions taken in this spec where the owner left room:
- Q1 (unanswered) is implemented as settings, all off: `publish.mode` keeps `instant` as the
  default; release slots apply to new captures and posts (not to the owner's later text edits);
  the departure hold is per entry (cap, "moved on" tap, or a later day at another place).
- Q2's "hide the badge" is the option "city without badge"; "only country" and "nothing" also
  strip the place (and country) of the current stay in the data, not just in the UI.
- The panic link is included (cheap: one public route, one static page).
- No join window and no QR add-device (Q3 c makes every further device wait for the owner).
- Q0's "the cookie is set by Apache's `CO` flag": `mod_headers` is the primary path because it
  allows `__Host-` cookies; `CO` stays as F1 exactly as described, now fed from the transfer
  cookie instead of the URL (the owner accepted weaker cookie *attributes*, not credentials in
  URLs).
- Owner actions before real followers join: fill the controller fields and publish privacy
  notice version 1 (joins are refused until then); initialise the website store in the admin;
  create the restricted store SFTP account if P0b selects `sftp`.

---

## Appendix A: privacy notice template (`api/src/Domain/Access/privacy-template.json`)

Seeded as the draft; marked "Vorlage – keine Rechtsberatung / Template – not legal advice" in the
admin. It describes what wave 5 really stores; **wave 6 must publish a new version** before it
stores views, reactions, messages or e-mail addresses. `{backupDays}` is replaced with the API's
`BACKUP_KEEP` when the draft is seeded (the owner can edit it like any other text). The notice is
delivered by the API only to holders of a valid link or key, never in the public gate bundle, so
it may say what the page is about.

**de**
- title: Datenschutzhinweise
- intro: Diese Seite zeigt Reiseerlebnisse nur Menschen, die persönlich eingeladen wurden. Bevor
  du beitrittst, erklären wir kurz, was dabei gespeichert wird.
- collected: Unter einer zufälligen Kennung, die nur für dich angelegt wurde, speichern wir: den
  Namen, den die einladende Person für dich eingetragen hat; für jedes Gerät, mit dem du
  beitrittst, Gerätetyp und Browser (z. B. „iPhone · Safari“), wann es beigetreten ist und wann
  es die Seite zuletzt geöffnet hat; wann du welche Version dieser Hinweise bestätigt hast.

  Auf deinem Gerät speichern wir nur Cookies, die für den Zugang nötig sind: eine Sitzung, einen
  Geräteschlüssel und beim Beitreten kurzlebige Hilfs-Cookies. Der Webhoster protokolliert
  technisch bedingt IP-Adressen in Server-Logs.
- audience: Die einladende Person sieht deinen Namen, deine Geräte und wann sie zuletzt genutzt
  wurden. Andere eingeladene Personen sehen nichts davon.
- purpose: Die Daten dienen nur dazu, die Seite ausschließlich eingeladenen Personen zu zeigen,
  neue Geräte freizugeben und Missbrauch wie weitergeleitete Links zu erkennen.
- retention: Die Daten bleiben gespeichert, solange du eingeladen bist, und auch nachdem dein
  Zugang beendet wurde, bis du oder die einladende Person sie löscht. Sicherungskopien auf dem
  Server werden nach höchstens {backupDays} Tagen überschrieben; heruntergeladene
  Sicherungskopien löscht die einladende Person spätestens nach derselben Frist.
- rights: Du kannst jederzeit Auskunft verlangen, deine Daten exportieren, berichtigen und
  löschen lassen. Du kannst dich außerdem bei einer Datenschutz-Aufsichtsbehörde beschweren.

**en**
- title: Privacy information
- intro: This page shows travel moments only to people who were personally invited. Before you
  join, here is what is stored.
- collected: Under a random identifier created just for you, we store: the name the person who
  invited you entered for you; for each device you join with, its type and browser (e.g.
  "iPhone · Safari"), when it joined and when it last opened the page; when you confirmed which
  version of this information.

  Your device keeps only cookies that are needed for access: a session, a device key and, while
  joining, short-lived helper cookies. For technical reasons the web host logs IP addresses in its
  server logs.
- audience: The person who invited you sees your name, your devices and when they were last used.
  Other invited people see none of this.
- purpose: The data is used only to show the page to invited people, to approve new devices and
  to notice misuse such as forwarded links.
- retention: The data is kept while you are invited and also after your access has ended, until
  you or the person who invited you deletes it. Backups on the server are overwritten after at
  most {backupDays} days; the person who invited you deletes downloaded backup copies within the
  same period.
- rights: You can ask what is stored, export it, have it corrected and deleted at any time. You
  can also complain to a data protection authority.

Controller fields start empty (`name`, `email`, optional `address`); publishing is blocked until
they are filled. The request-form note of Q7 arrives in wave 6 with the form (an optional
per-locale field `requestNote`, published as a new version).

---

## Appendix B: review disposition (`spec-wave5-review.md`)

Every point of the review, with the decision and a short reason. "Modified" = the problem is
accepted and fixed, but differently from the review's suggestion. Rules marked "verified" were
re-run on local Apache 2.4.66 (`apache-probe-w5r/`, 127.0.0.1 only).

### Critical and high

| Id | Decision | Where | Reason |
|---|---|---|---|
| C1 pending/declined devices can read, export, delete | **Accepted** | §3.3 "D12 rights", §3.4, §4.1 `MeDataResponse.limited`, §6.2.3, §6.2.5, §8.3 matrix | A pending device is what a forwarded link produces; it must not see the person's devices or erase her. "Revoked together with the person" is defined precisely as `device.revoked_at = follower.revoked_at`, so a device the owner removed on its own never regains rights when the person is later revoked. |
| H1 credentials in the handoff URL, login fixation | **Accepted** (verified) | §2.3.2, §2.4.1, §2.4.2, §1.1, §4.1, §6.2, §8.2 B, §10 T4 | The owner accepted weaker cookie attributes, not long-term secrets in history, history sync and access logs. The review's rule is used unchanged except the failure target (L1). |
| H1 optional extra: also check `Sec-Fetch-Site` | **Rejected** | – | The Strict key cookie already proves a same-site navigation; an extra header condition adds a browser-variance failure mode and another P0b unknown for no gain. |

### Medium

| Id | Decision | Where | Reason |
|---|---|---|---|
| M1 WP0 cannot end green | **Accepted** | §3.2 (two migrations), §9 WP0 + WP5 deploy order | Confirmed: `testSeededSettingsMatchSettings` validates the migrated rows against `Settings.json`. |
| M2 `verify` rejects the spec's own content `.htaccess` | **Accepted** (drop variant) (verified) | §2.4.3, §5.5 | Dropping the dot `FilesMatch` keeps the verify rule simple; the gate's dot rule answers 403 for every dot path, followers included (identical answers verified). |
| M3 phpseclib not available offline | **Accepted** | §3.8.1, §9 WP1 step 1, §10 P0b-12 | One networked `composer require`; `SftpClient` fake first; `sodium`/`gmp`/`ssh2` recorded by the kit. |
| M4 false "Wirksam ✓" when the Mac writes elsewhere | **Accepted** | §2.2 store identity, §3.5 store-init, §3.6 claim/heartbeat, §3.8.3–3.8.4, §3.9, §5.6.3 #4–#5 | `storeId` + explicit init + end-to-end proof (a created session accepted, a deleted one refused). Addition: the API's cron store proof uses `GET /` (302 vs 200), so the API never needs the content folder name. |
| M5 changed notice not shown "on the next visit" | **Modified** | §1.7, §6.3 `hello.ts` | Neither suggested option alone: per tab session misses tabs kept open for days, and publishing the version through the change feed couples notice publishing to a site rebuild. Chosen: hello on every SPA start (5-minute per-tab throttle) and when a tab becomes visible after ≥ 30 min. |
| M6 reopening creates duplicate pending devices | **Accepted** | §3.3 Devices 3, §3.4, §4.1, §6.2.1, §8 | `pending_device` + `join` returns the same pending device. |
| M7 JS host-only vs server `Domain` cookies (F1/F2) | **Accepted** | §2.3.1, §2.8, §4.1 `GateBoot.cookieDomain`, §4.2 `Boot.access`, §6.2 `cookies.ts` | First-wins duplicates would present stale keys. |
| M8 store lock and SFTP inside requests exhaust PHP workers | **Accepted** | §3.3, §3.8.3, §8.3 concurrency test | `LOCK_NB`, drain loop, one short transaction per op, never a transaction across I/O. |
| M9 site's full SFTP login in the API decided implicitly | **Accepted** | §3.1 `ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN`, §3.8.1, §10.4 P0b-2, §11 decision 1 | Owner decision with the default `none` (Mac writer); key auth preferred; the writer refuses a login that sees the docroot unless allowed; noted that the site login forces F3. |
| M10 lease expiry mid-apply; reconcile re-locks after unlock | **Accepted** (extended) | §3.6 renew, §3.8.3–3.8.5, §3.3 Lock 4 | Lease check before every op, renew, ≤ 200 ops per claim, 5 s op timeouts. For the reconcile, a single transaction alone is not enough (the listing is older than the transaction), so fixes skip every path touched by ops newer than the listing, and the sticky lock is imported only when the file is newer than `unlocked_at`. |

### Low

| Id | Decision | Where | Reason |
|---|---|---|---|
| L1 freshly written file not yet visible | **Accepted** | §2.4.1 (failure target), §6.2.1 `#handoff-failed`, §2.8 F7, §10 T11/T12 (P0b-11) | Unknown host filesystem; one 2-second retry costs nothing. Failure target is `/_/join/#handoff-failed` for everyone (uniform, public tree, verified). |
| L2 resume throttle in `sessionStorage` | **Accepted** | §2.3.1 `__Host-omw_r`, §2.5 `NEUTRAL_SCRIPT` | `Clear-Site-Data: "storage"` wipes it on every refusal. |
| L3 Safari 7-day cap on pending devices | **Accepted** (server refresh option) (verified) | §2.3.1, §2.4.1, §1.2 | The navigation to `/_/wait/` right after `join` already makes the key cookie server-set (exactly one `Set-Cookie`, none on the neutral page or assets). |
| L4 hostname grep hits `pages.ts` placeholder | **Accepted** | §5.1, §9 WP2 | Confirmed at `backend/src/ui/pages.ts:511`; placeholder becomes `sftp.example.org`. |
| L5 public gate bundle says "Reise" | **Accepted** (word list without German `sie`) | §6.2.1, §6.2.5, §5.5 | Neutral copy and `data.json`. German `sie` is ambiguous (formal "you", "they") and would produce false hits; English `she`/`her` are on the list. |
| L6 orphan semantics contradict themselves | **Modified** | §3.8.5, §3.8.6, §3.5, §7.3 | Stated the real outcome. Placeholder follower rows would not help: the orphan devices' keys are not in the restored DB, so they can never talk to the API. Orphan sessions are therefore removed by the restore reconcile and the owner gets a notice naming the known people to tell; the "keep orphans" option and its route are gone. |
| L7 Home card lacks data | **Modified** | §4.1 `AccessStatus.pending`, §7.5 | Names go into `AccessStatus` (not persisted), not `AccessSummary`: the status query is persisted in IndexedDB (`frontend/admin/src/api/queries.ts`), and nothing about people may be. |
| L8 restore can lose fids | **Accepted** | §3.8.5 `restored_api` | Unknown fids in the listing become restore tombstones. |
| L9 D4 "device limit" | **Modified** | §3.1 `ACCESS_MAX_DEVICES`, §3.3, §3.5, §7.4, §11 decision 2 | A cap is added, as API config (default 5) rather than a synced setting: it is a safety bound, not a day-to-day choice, and it keeps the contract and change feed smaller. |
| L10 backup sentence wrong | **Accepted** | Appendix A, §9 WP5 HOSTING line | `{backupDays}` from `BACKUP_KEEP`, downloaded copies named. |
| L11 gate check blind from the Mac | **Accepted** | §5.6.3, §3.9, §7.6, §4.2 `PublishedReport.gateCheck` | `error`/`skipped` never fail the report; the API's probe is primary when available; the admin says when no check has succeeded for 24 h. |
| L12 `worker-src 'self'` in gate mode | **Accepted** | §5.4, §5.5, §3.11 | No worker today; prevent one from ever serving content after access ended. |
| L13 no HSTS, no https redirect | **Accepted** (probe-dependent) (verified) | §2.4.1 `[https]`, §2.4.2 `[hsts]`, §5.1, §2.8 F6, §10 P0b-10 | HSTS is sent without an `%{HTTPS}` guard (browsers ignore it on http). The redirect uses the configured host and is emitted only if P0b shows `%{HTTPS}=on`, because behind a TLS proxy it would loop. Verified uniform for all path kinds; ACME stays on http. |

### Nits

| Id | Decision | Reason |
|---|---|---|
| N1 `report?` in §3.6 `AccessAck` | **Accepted** | Removed; the reconcile report is written by the API. |
| N2 `::1` vs the `Origin` regex | **Accepted** (drop `::1`) | Dev uses `127.0.0.1`/`localhost`; no bracketed IPv6 needed. |
| N3 `ACCESS_STORE_DIR` characters | **Accepted** | `^/[A-Za-z0-9._/-]+$`, no `..`, no `//` (§2.2, §3.1, §4.1, §5.1). |
| N4 `device/poll` for an active device with a session | **Accepted** | `active{handoff:'/'}` (§3.4). |
| N5 `known_device` could resume directly | **Rejected** | Going to `/` keeps a valid session (no store write, no PHP worker on SFTP); a missing session falls through to the throttled resume. |
| N6 Dockerfile check before WP3 | **Accepted** | Moved to WP5 (§6.1, §9). |
| N7 D11 de **and** en | **Accepted** | Required regardless of `site.locales` (§3.3, §4.1). |
| N8 tombstone keeps more than "ID + deleted on" | **Accepted** (partly) | `created_at` is overwritten with `deleted_at` and dropped from the contract; `kind` and `deleted_by` stay (not personal; needed to filter the service follower and to label the owner's list) (§3.2, §3.3). |
| N9 second delete answers `deleted` | **Accepted** | `ended` (§3.3). |
| N10 "zwei Cookies" | **Accepted** | The template no longer counts cookies (the number varies by mode). |
| N11 app tokens survive a password change | **Accepted** (as an offered, pre-ticked choice) | App tokens carry the `admin` scope, so they are offered for revocation (default ticked); backend tokens never (§3.12, §7.8, §11 decision 3). |
| N12 macOS case-insensitive store | **Accepted** (verified) | Harness store on a case-sensitive volume; flipped case refused there, accepted on the default volume (`apache-probe-w5r/logs/case-sensitivity.txt`). |

### "Also worth stating" and §D (missing tests)

| Item | Decision | Where |
|---|---|---|
| `TRACE` echo, encoded-slash/NUL 404, `deviceMustWait` disclosure, `pub` cap DoS, `rl_salt` reset | **Accepted** as documented residuals | §2.7, §3.7 |
| WP0 "2–3 days" optimistic | **Accepted** | §9 WP0: M, 4–5 days |
| §D 1 D12 matrix + pending device e2e | **Accepted** | §8.3 `FollowerDataRightsTest`, §8.5 e2e, §8.7 step 5 |
| §D 2 handoff tests | **Accepted** | §8.2 B, §8.5 (no sid/k in any URL), §8.7 step 9 |
| §D 3 end-to-end store proof, `none` stack variant | **Accepted** | §5.6.3 #4–#5, §3.9, §8.7 variant |
| §D 4 WP0 keep-green proof | **Accepted** | §9 WP0 definition of done |
| §D 5 real `contentHtaccess()` passes verify; CSP hashes | **Accepted** | §5.5, §8.4 |
| §D 6 harness additions | **Accepted** | §8.2 A, C′, F, M–P |
| §D 7 concurrency | **Accepted** | §8.3 |
| §D 8 D11 next visit without clearing | **Accepted** | §8.7 step 8 |
| §D 9 pending reopen ×3 | **Accepted** | §8.3, §8.7 step 5 |
| §D 10 F1/F2 cookie strings | **Accepted** | §6.2 `cookies.ts`, §8.5 |
| §D 11 privacy of logs | **Accepted** | §8.3 `LogPrivacyTest` |
| §D 12 live acceptance checklist | **Accepted** | §9 WP5 |
| §D 13 P0b kit: T4′, T11/T12, crypto rows, 5 s spacing in split calls, home-limited search | **Accepted** (three calls of ≤ 5 instead of two of ≤ 7, to stay near 25 s per PHP request; the search is limited to directories owned by the script's uid, since the docroot may not be under `$HOME` on Hetzner) | §10, `p0b/` (re-tested 13/13) |

### Changes made beyond the review
- The API's anonymous probe runs once per hour instead of every cron run (5 min): fewer 403s
  from the server's own IP, the pattern that triggered the host's IP block.
- `/_/h` without a trailing slash and any `/_/h/<anything>` go to the same failure target.
- The `init` store op, `access_state.unlocked_at`, `gate_check` and `store_proof_at` columns, and
  the `POST /backend/access/renew` and `POST /admin/access/store-init` routes support M4/M10/L11.
- The Mac's lock button reports "Gesperrt" only after finding the store marker (M4 applied to the
  one Mac write that does not go through `claim`).
