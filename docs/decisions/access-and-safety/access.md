# Access control for the public site: architectures (design wave 5)

Scope: who can see the traveler's timeline, and how to keep stalker-like people out, on this codebase
and on the owner's hosting (Hetzner shared hosting: Apache + `.htaccess`, PHP-FPM on the same
account, SFTP root = document root, no SSH). The contact form is designed in a separate part of
this wave and is mentioned here only where it touches access.

Read-only analysis as of 2026-11-20. No live host was contacted. Everything marked **verify** must
be checked on the real host (see §8 for a short probe checklist the owner can run).

---

## 0. Summary

- Today **everything is public to anyone who has the URL**: HTML (with the day's data inlined),
  the JSON data and every media file. The hostname is not a secret, because every TLS certificate
  goes into public Certificate Transparency logs. `noindex` only keeps polite crawlers away.
- The data that matters most for stalking is **where she is now and where she will be next**.
  Access control decides *who* sees it. A delay decides *when*. Coarse location decides *what*.
  You need all three, because access control alone fails as soon as one approved person forwards
  the link or takes screenshots.
- **Recommendation for this owner and host:**
  1. **Personal links per follower** (option C, "gate" variant). A small PHP script on the site
     host runs **only when a device joins**. Apache serves every page, JSON file and media file
     natively after a cookie-to-file check in `.htaccess`. The admin PWA manages people, devices
     and revocation (effective within seconds), plus an emergency "lock now" button. All of this
     works while the Mac backend is off.
  2. **Request to follow** (option E) on a lovely landing page for everyone else.
  3. Optionally, a **public teaser layer** (the hybrid): delayed by days, country-level only, no
     "here now". Strangers see something nice; approved people see the live journey.
  4. Quick wins that help in every option: stop publishing `lat`/`lng`, hide "here now" outside
     the trusted circle, no OG preview photo of the latest day.
- **Client-side encryption** (option D) is the only option that works on *any* static host and
  survives a host compromise. It is the right fallback if the site ever moves to a host without
  PHP. It costs the most to build, makes video and first paint worse, and cannot detect or limit
  forwarded links.

---

## 1. What the site exposes today (facts from the code)

| Fact | Where | Why it matters |
|---|---|---|
| Static files only; anyone with a URL gets everything. HTML day/story pages inline the whole day in the Boot JSON; home and trip pages pre-render the newest days. | `backend/src/generator/pages.ts`, `packages/contracts/src/site.ts` (`Boot.day`) | Protecting only the JSON or only the media is not enough: **HTML must be protected too**. |
| Data paths in JSON are relative to the site root; `basePath` comes from the Boot JSON at runtime. | `site.ts` header, `frontend/site/src/data/urls.ts`, `@omw/ui/picture` `resolveSiteUrl` | A secret path prefix, or a second "followers" tree under another `basePath`, needs almost no SPA changes. |
| Data fetches are same-origin GETs with the default credentials mode; `<img>`, `<video>` and `<link rel=preload crossorigin>` are same-origin too. | `frontend/site/src/data/fetch.ts` | Cookies and Basic-Auth credentials are sent automatically. A server-side gate needs **no frontend changes to authenticate**, only to handle "access ended". |
| `DayDetail` publishes `lat`/`lng` when the owner set them, but the site never reads them. | `backend/src/generator/model.ts` ~L419-420; no use in `frontend/site/src` | Exact coordinates are downloadable while nothing shows them. Drop them (quick win). |
| "Here now" chip: pulsing while the newest day's last moment is < 48 h old, then "Last seen here". | `frontend/site/src/components/decor.tsx` (`isLive`) | Real-time location signal. |
| The home page's `og:image` is the newest day's cover. | `pages.ts` ~L608-619 | Pasting the home link into WhatsApp shows her latest photo to everyone in the chat. |
| Media file names are `media/<aa>/<sha256-of-original[0:16]>_<variant>.<ext>`. | `backend/src/paths.ts` `mediaRelPath` | Unguessable, except to someone who has the original WhatsApp file (any status viewer). They can confirm that a status is on the site, but learn nothing new. |
| Cache headers: media `private, max-age=31536000, immutable`; HTML/JSON `no-cache`; assets `public, immutable`. | `backend/src/generator/extras.ts` `htaccess()` | Already right for gated content. Followers' browsers keep media for a year: revocation never deletes what a device already downloaded. |
| `.htaccess` is generated and "rewritten on every build". Dotfiles are denied by **basename** (`<FilesMatch "^\.">`). | `extras.ts` | Anything put into `/.htaccess` by hand (e.g. by konsoleH's directory protection) can be overwritten later. Files *inside* a dot-directory (`/.omw-access/f/x`) are **not** denied by that rule. |
| `robots.txt` says `Disallow: /` and pages carry `noindex`. | `extras.ts`, `pages.ts` | Google only sees `noindex` on pages it may crawl, so a URL linked from elsewhere can still be listed, without content. Minor. |
| The publisher's post-deploy check fetches `data/manifest.json` anonymously; an `error` result is only a warning. | `backend/src/publisher/httpcheck.ts`, `index.ts` ~L362-397 | Once gated, the check needs its own credentials. It also becomes the place to **assert that anonymous access is refused**. |
| The API already has CORS for `SITE_ORIGIN` on `/api/v1/public/*` (no routes yet), an alert engine (e-mail/ntfy) and login rate limiting. | `api/src/Http/Routes.php`, `Middleware/Cors.php`, `Domain/Alerts`, `Domain/Auth/LoginThrottle.php` | "Request to follow" and gate notifications can reuse all of these. |

---

## 2. Threat model

| Who | Typical path to the site | What helps | What does **not** help |
|---|---|---|---|
| Random strangers, search engines | Search, CT-log subdomain lists, link found in a public place | Any gate; `noindex`; secret path | — |
| Someone she knows but does not want following (ex, a creepy acquaintance) | A friend forwards the link, or he sees it on a friend's phone | Personal links, a **device limit per link**, revocation, request-to-follow with verification | One shared password (it gets forwarded too); `noindex` |
| An approved follower who turns out to be the problem | Has legitimate access | Revocation (stops *future* content); **delay** and **coarse location** (old content is less dangerous) | Nothing undoes what he already saw, saved or screenshotted |
| Someone already in her WhatsApp status audience | Sees the statuses live in WhatsApp | Her WhatsApp status privacy ("My contacts except…") | Anything on the website: **the website is not the only channel**. Keep both lists in mind. |
| Someone with access to a follower's phone (family iPad) | Opens the browser | Device list and per-device revocation | Encryption (the key is on that device too) |
| Host compromise (Hetzner account) | Reads files | Only option D (ciphertext at rest) | Any server-side gate |

What no technical measure here prevents: screenshots and re-sharing by approved people, recognisable
places in photos (hotel views, street signs), captions announcing plans ("tomorrow Hanoi!"), and
traffic analysis (when the manifest changes, she is active).

---

## 3. Hosting constraints (Hetzner, and what Apache can do)

- **Hetzner shared hosting:** Apache with `.htaccess`, PHP-FPM 8.5 (HOSTING.md), no SSH on this
  account, SFTP root = document root (so private bookkeeping files must live inside the document
  root and be denied explicitly). konsoleH has a built-in "directory protection" (username and
  password) feature ([Hetzner docs](https://docs.hetzner.com/konsoleh/account-management/configuration/htaccess)).
- **PHP concurrency is tiny:** 2 / 5 / 10 / 20 PHP processes for Webhosting S / M / L / XL
  ([hetzner.com/webhosting](https://www.hetzner.com/de/webhosting/)). This account has no SSH, so
  it is probably S or M (**verify**). If the API and the site share the account, they may share
  that pool (**verify**). Consequence: **never stream media through PHP**. One slow phone loading
  a 15 MB video would hold one of maybe 2 workers for a minute.
- **Absolute filesystem path** (needed by `AuthUserFile`, and by `RewriteCond … -f`): not
  documented publicly. Use `%{DOCUMENT_ROOT}` in rewrite conditions, and confirm it with a one-line
  PHP probe (`__DIR__`, `$_SERVER['DOCUMENT_ROOT']`). Another way: enable konsoleH directory
  protection on a test folder and read the `AuthUserFile` line it writes (**verify** that it
  writes one).
- **X-Sendfile:** `mod_xsendfile` is a third-party module ([tn123.org](https://tn123.org/mod_xsendfile/)).
  Whether Hetzner loads it is unknown. To check: `<IfModule mod_xsendfile.c>` header probe plus a
  PHP script that sends `X-Sendfile: <abs path>` with an empty body; if the file arrives, it works.
  The recommended design does not need it.

### Can `.htaccess` verify anything without PHP? (precise)

**mod_rewrite (`RewriteCond`/`RewriteRule`) can:**
- Regex-match any request variable (`%{HTTP_COOKIE}`, `%{QUERY_STRING}`, IP, user agent, `%{TIME}`
  as `YYYYMMDDhhmmss`). It can compare as integers or lexically. Equality is only against
  constants written into the file, or against another variable via the backreference trick
  `RewriteCond "%{HTTP_COOKIE}#%{ENV:X}" "k=([^;]+).*#\1$"`.
- Test the filesystem: `-f`, `-d`, `-s` on a path **built from request data**, e.g.
  `%{DOCUMENT_ROOT}/.omw-access/f/%1/%2 -f` after a cookie regex captured `%1`/`%2`. The `%N`
  backreferences come from the last matched `RewriteCond`
  ([mod_rewrite docs](https://httpd.apache.org/docs/2.4/mod/mod_rewrite.html#rewritecond)).
  **This is the useful primitive: a file-existence allowlist or session store that someone else
  maintains.**
- Set cookies with the `CO` flag (lifetime in minutes; `SameSite` only from httpd 2.4.47). The
  docs imply, without stating it, that the value may come from backreferences (**verify**). `CO`
  requires a `DOMAIN` field, so it **cannot set `__Host-` cookies**
  ([flags docs](https://httpd.apache.org/docs/2.4/rewrite/flags.html)).
- Answer with any status: `R=403` and `R=401` drop the substitution and go through
  `ErrorDocument`. Use `[END]` for internal rewrites in `.htaccess` to avoid loops (same page).

**mod_rewrite cannot:** hash, compute an HMAC, write state, count, or rate-limit. A cookie that
only carries an expiry time is worthless without a MAC, because the client can edit it.

**ap_expr in `<If>`** (Apache 2.4) has `md5()`, `sha1()`, `base64()`, regex backreferences
`$0..$9`, integer comparisons and `%{TIME}`
([expr docs](https://httpd.apache.org/docs/2.4/expr.html)). So a **keyed SHA-1 check with an expiry
is technically possible in pure `.htaccess`**: `sha1('secret' . $1 . $2) == $3 && $2 -gt %{TIME}`.
It is a home-made MAC (not HMAC, not constant-time) and depends on the backreferences working
inside function arguments, which the docs do not state. Use it only if PHP is unavailable.

**mod_auth_form + mod_session_cookie + mod_session_crypto** is Apache's own pretty login form with
an encrypted session cookie, without PHP ([mod_auth_form](https://httpd.apache.org/docs/2.4/mod/mod_auth_form.html),
[mod_session_crypto](https://httpd.apache.org/docs/2.4/mod/mod_session_crypto.html)). Whether these
modules are loaded on Hetzner is unknown. `AuthFormLoginRequiredLocation` is server/directory
context only, so in `.htaccess` you would use the "inline login" (`ErrorDocument 401`) variant.

---

## 4. Options

Effort scale: **S** ≤ 2 dev-days, **M** ≈ 3–7 dev-days, **L** ≈ 2–4 weeks (with tests and e2e
in this repo's style).

### A. Public with mitigations only

**How:** keep the site public and make what is public less dangerous.
1. `publish.mode = delayed` with a long delay. 24 h does not protect a 5-day stay; stays are
   often longer than the delay, so delay plus coarse location is what helps.
2. Coarse location: country only (or none) on public pages. Never publish `lat`/`lng`.
3. No "here now" chip; at most a neutral "latest moments" label.
4. Unguessable URL as a **path**, not a subdomain (subdomains show up in CT logs,
   [Let's Encrypt](https://letsencrypt.org/docs/ct-logs/)): `SITE_PUBLIC_URL=https://…/k7f3p9q2x8vw/`.
   This is supported today (`basePath`). **Rotation is cheap:** data JSON holds only relative
   paths, so rotating = one SFTP rename of the directory plus regenerating the HTML only. Media
   and data are not re-uploaded.
5. `noindex` already exists. Add `X-Robots-Tag: noindex` for every response (media, JSON). Either
   allow crawling so `noindex` is seen, or accept `Disallow` ([Google](https://developers.google.com/search/docs/crawling-indexing/block-indexing)).
6. No OG image of the latest day.

| Criterion | Assessment |
|---|---|
| Real protection | Weak. Whoever has the link sees everything (HTML, JSON, media) until the path rotates. No per-person anything. Caches: the content stays on devices that loaded it. Forwarding: unlimited and invisible. |
| Revocation | Only for everyone at once (rotate the path, resend the link to all). |
| UX | Best: just a link. |
| Owner effort | Minimal; rotate occasionally. |
| Host | Any static host. |
| Performance/CDN | Unchanged; fully cacheable. |
| Failure modes | The link spreads silently; the owner never knows. |

**Does NOT protect against:** anyone who once got the link; real-time tracking when the delay is
shorter than her stays; photos that show places.

**Code changes (S, path rotation S–M):**
- `packages/contracts/src/api.ts` settings: `site.location_precision` (`place|country|none`),
  `site.here_now` (bool). Then `pnpm schemas:check`, `api/src/Domain/Settings.php`,
  `frontend/admin/src/screens/settings.tsx`.
- `backend/src/generator/model.ts`: drop `lat`/`lng` (or the whole contract fields in `site.ts`
  with a `contractVersion` bump), apply the precision to `place`.
- `frontend/site/src/components/decor.tsx` / `timeline/rows.tsx`: honour a `TimelineIndex` flag
  for "here now".
- `backend/src/generator/pages.ts`: no `og:image` on home when not indexable.
- `backend/src/generator/extras.ts`: `X-Robots-Tag` header.
- Path rotation: `backend/src/publisher/cli.ts` command `rotate-path` (SFTP `rename`, update the
  target's `remoteRoot` and `SITE_PUBLIC_URL`, full HTML regeneration); docs/HOSTING.md.

### B. One shared password

**B1. Basic Auth** (`AuthType Basic`, `.htpasswd` uploaded by the publisher, bcrypt `$2y$` hashes,
which Apache 2.4 accepts).
**B2. Pretty login page, pure mod_rewrite:** a static form does GET `/_/pw?p=<passphrase>`;
`RewriteCond %{QUERY_STRING}` captures it; `RewriteCond %{DOCUMENT_ROOT}/.omw-access/pw/%1 -f`
checks it; `[CO=omw_pw:%1:<host>:525600:/:secure:httponly:lax,R=303]` sets the cookie (the
passphrase *is* the cookie). Every request then checks cookie → file.
**B3. PHP gate:** like C's gate below, with one password instead of personal links (and with rate
limiting).

| Criterion | Assessment |
|---|---|
| Real protection | Good against strangers: HTML, JSON and media are refused by the server. Browser caches: as in A. Forwarding: the password travels freely. |
| Revocation | None per person; change the password and tell everyone again. |
| UX | B1: the browser's native dialog asks for "username" and password. It confuses grandparents, has no logout, and remembering it on iOS or in home-screen apps is unreliable. `https://user:pass@host` links are no fix: Chrome blocks sub-resources with embedded credentials ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/lx-U_JR2BF0)). B2/B3: a nice page, but people must type a passphrase. |
| Owner effort | Low; rotating means messaging everyone. |
| Host | Apache only (Netlify, Cloudflare Pages and S3 have their own, often paid or third-party, mechanisms). B3 needs PHP. |
| Performance | Apache native; no PHP per request (B1, B2). |
| Failure modes | B1 via konsoleH directory protection: if it writes into `/.htaccess`, the generator's file replaces it **as soon as the generated `.htaccess` changes** (a generator version bump, a full deploy). The site then **silently becomes public again** (fail-open). B2: no rate limit, so the passphrase must be long (about 4 random words), and it lands in access logs and browser history. All: the publisher's HTTP check gets 401/403 and needs credentials. |

**Does NOT protect against:** forwarding; a former friend who still knows the password.

**Code changes:** B1 **S–M**: `extras.ts` `htaccess(site, access)` adds the auth block with a
`.well-known` exemption (`<If "%{REQUEST_URI} =~ m#^/\.well-known/#">Require all granted</If>`).
The publisher uploads `/.omw-access/htpasswd` outside the deploy record. A target field for the
absolute path in `backend/src/publisher/types.ts`. A setting for the password hash (computed by
the API with `password_hash(…, PASSWORD_BCRYPT)` and mirrored through the change feed).
`httpcheck.ts` sends credentials. B2 **M**: plus a static login page in `pages.ts` and the
rewrite rules. B3 **M**: see C.

### C. Personal links per follower, managed in the admin

Three variants were evaluated.

**C1. htpasswd with one user per follower** (the publisher regenerates `.htpasswd` on every change).
Per-person revocation works right away, because Basic Auth re-checks every request. The UX is B1's
(typing a username and password); a link that logs in by itself is not possible. **Effort M.** Not
recommended for grandparents.

**C2. PHP gate that serves files (signed HMAC cookie, key shared with the API).** It works on
paper, but on this host it is the wrong shape:
- Every image, JSON and video request goes through PHP-FPM. With 2–5 workers, a few followers
  watching videos block the site (and maybe the API).
- PHP must re-implement `Range`/206 (Safari needs it for `<video>`), `ETag`/304, `HEAD` and
  streaming without buffering. `memory_limit` and `max_execution_time` apply. FPM's wall-clock
  timeout is unknown.
- X-Sendfile would remove the worker cost, but its availability is unknown (§3).

**Effort M–L.** Not recommended on Hetzner.

**C3. The API issues short-lived signed tokens.** Something on the static host must verify them:
PHP (back to C2 or the gate below), or the ap_expr keyed-SHA-1 trick (§3). Revocation takes up to
the token lifetime, and refreshing requires the API to be up. That breaks the plan's rule that
**"nobody needs the API to view the site"**. Use API-signed identities later for API features
(hearts, comments), not for serving files. **Effort M–L.**

#### C-gate (recommended): PHP only to join, Apache serves everything natively

```
invite link  https://<site>/_/join/#t=<22-char secret>      (secret in the fragment: never sent to a server)
   │  static join page (no PHP) reads the fragment and shows "Hello! Open Lea's journey on this phone"
   ▼  POST /_/gate.php {t}                                   (the only PHP request per device)
gate.php: sha256(t) → .omw-access/i/<hash> → follower id; device count < limit?
   │  creates .omw-access/f/<followerId>/<sessionId>   (JSON: createdAt, "iPhone · Safari")
   ▼  Set-Cookie: __Host-omw=<followerId>.<sessionId>; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000
every later request: .htaccess
   RewriteRule ^\.omw-access(?:/|$) - [F,L]                       # bookkeeping never served
   RewriteRule ^(?:\.well-known/|assets/|_/|robots\.txt$|favicon\.) - [L]   # public parts
   RewriteCond %{DOCUMENT_ROOT}/.omw-access/locked -f             # emergency lock
   RewriteRule ^ /_/welcome/ [R=302,L]
   RewriteCond %{HTTP_COOKIE} (?:^|;\s*)__Host-omw=([a-z0-9]{12})\.([A-Za-z0-9_-]{43})(?:;|$)
   RewriteCond %{DOCUMENT_ROOT}/.omw-access/f/%1/%2 -f
   RewriteRule ^ - [L]                                             # valid device: Apache serves the file
   RewriteRule ^(?:data|media)/ - [F,L]                            # no session: 403 (SPA shows "access ended")
   RewriteRule ^ /_/welcome/ [R=302,L]                             # no session: pages go to the landing (E)
```

- **Who is the source of truth:** the API (followers, invites, device limit, the lock flag). The
  **API pushes** a signed full snapshot to `POST /_/gate.php?op=sync` on every admin change, and
  again from the existing 5-minute cron as a repair. The push is HMAC-SHA256 over a timestamp and
  the body, with a monotonic version against replays and a shared `ACCESS_SYNC_KEY` in both
  `.env`s. `gate.php` (holding a `flock`) writes or deletes invite files and follower
  directories. Its reply lists every follower's devices, which the admin then shows.
  - **The Mac backend is not involved**, so revocation and "lock now" work from the phone even
    while the Mac sleeps.
  - **The API is not needed for viewing:** existing devices are served by Apache alone, and joins
    use the replicated invite files. Only changes wait for the API.
- **Revocation:** a person = delete `f/<id>/` and their invite → their next request (the
  5-minute manifest poll, or the next navigation) gets 403 or the landing page. A device = delete
  one file. "New link" = new invite; the old link stops working; devices can stay or be dropped.
- **Forwarding defence:** a device limit per link (e.g. 2–3; an in-app browser counts as a
  device). Above the limit: "This personal link is already in use on 3 devices. Ask Lea for your
  own link" (plus a pre-filled request form, option E), and the owner gets an ntfy/e-mail
  ("Oma's link was tried on a 4th device"). A link forwarded *below* the limit still works, but
  the extra device shows up in the admin's device list (date, "Android · Chrome").
- **Link previews:** WhatsApp fetches a preview when the link is sent
  ([Meta docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/)).
  Because the secret is in the fragment and joining needs a POST from a button, a preview fetch
  neither sees nor uses up the invite. Shared day links preview as the neutral landing page:
  **no photo leaks through previews**. The trade-off: no pretty previews.
- **Cookie lifetime:** Chrome caps cookies at 400 days
  ([Chrome blog](https://developer.chrome.com/blog/cookie-max-age-expires)). An HttpOnly cookie
  set by the server is not subject to Safari's 7-day limit on storage written by scripts
  ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)), so grandma
  stays signed in. It must be `SameSite=Lax` (with `Strict`, a tap on a day link inside WhatsApp
  would arrive without the cookie).

| Criterion | Assessment |
|---|---|
| Real protection | HTML, JSON and media are refused by Apache without a valid device session; nothing private is reachable by URL alone. Browser caches: what a device already loaded stays in its HTTP cache (media `private`, 1 year), but the SPA can no longer start there (HTML/JSON are `no-cache` and refused). Forwarding: limited per link and visible. |
| Revocation | Per person and per device, effective within seconds of the API push; plus a global lock. |
| UX | Tap the personal link in WhatsApp, then one button. A new phone means tapping the link again. No passwords. |
| Owner effort | Admin: "Add person" (name, optional note) → share the link (Web Share → WhatsApp) → see devices → revoke. Approve requests (E). About 30 s per person. |
| Host | Apache + mod_rewrite + PHP on the **site** host (Hetzner: yes). Not "any static host": it becomes a capability of the publish target (`access: none | gate`). On hosts without PHP, use D, or that host's own access product. |
| Performance/CDN | Apache native serving (sendfile, Range, ETag) unchanged; one extra `stat()` per request; PHP only on join and sync. No CDN in front today. If one is added, every gated response must stay `private` (HTML/JSON need `private, no-cache` instead of `no-cache`). |
| Failure modes | *Fail-closed:* PHP broken (no new joins, existing devices fine), wrong `DOCUMENT_ROOT` (everyone locked out), `.htaccess` syntax error (500). *Fail-open:* the gate rules missing from `/.htaccess` (overwritten, deleted, or a host without mod_rewrite). Mitigations: the publisher asserts after every deploy that an **anonymous** `GET data/manifest.json` gets 403, and that its own service session gets 200, and alerts otherwise. As a second layer, combine with A's secret path. Also: a nested `.htaccess` with `Require all denied` in `.omw-access/` (defence in depth), and the gate files deployed in an earlier phase than `.htaccess`. |

**Does NOT protect against:** an approved person screenshotting or re-sharing; a forwarded link
used *within* the device limit until the owner notices; someone using an approved person's phone;
a compromise of the hosting account (the files are plaintext there); traffic analysis.

**Code changes (C-gate, L together with E):**
- **Contracts** `packages/contracts/src/api.ts`: `Follower`, `FollowerCreate`/`Patch`,
  `FollowerDevice`, `InviteLinkCreated` (the clear token is returned once), `AccessSnapshot`
  (API → gate), `GateSyncResult`; a setting `access.mode` (`public|followers|hybrid`), plus
  `access.device_limit_default`. Then `pnpm schemas:check` → `api/schemas/*.json`.
- **API:**
  - `api/migrations/0002_access.sql` (`followers`, `follower_invites` with sha256 hashes,
    `follower_devices` as reported by the gate, `follow_requests` for E, `access_state` with
    version and lock).
  - `api/src/Domain/Followers.php`, `api/src/Domain/AccessSync.php` (snapshot, HMAC, push via the
    existing `Infra/HttpClient` + `PublicAddressGuard`), `api/src/Http/Admin/FollowerController.php`.
  - Routes in `api/src/Http/Routes.php`: `admin.followers.*`, `admin.access.lock`.
  - A cron job in `Infra/CronRunner.php` (repair push); `ACCESS_SYNC_KEY` and `SITE_BASE_URL` in
    `.env` via `scripts/deploy-api.ts`.
- **Admin PWA:**
  - `frontend/admin/src/screens/followers.tsx`: list with device counts and last join; add;
    share link; new link; revoke person or device; a "Lock site now" switch.
  - `requests.tsx` for E; Home shows pending requests; settings get the access mode.
- **Generator:**
  - `backend/src/generator/extras.ts` `htaccess(site, access)` emits the rules above (generated,
    never hand-edited); `X-Robots-Tag`.
  - `pages.ts`: `renderWelcome()` (landing with the request form, no profile data unless the owner
    allows it) and `renderJoin()` (static page that reads `#t=`).
  - `generate.ts` plans `_/gate.php` (a vetted file shipped with the generator, **containing no
    secrets**: it reads `.omw-access/sync.key`); `output.ts` adds `_` to `isGeneratorPath`;
    `verify.ts` checks the CSP of the new pages; bump `GENERATOR_VERSION`.
- **Publisher:**
  - `backend/src/publisher/plan.ts`: gate files in an earlier phase than `.htaccess`.
  - A new `backend/src/publisher/access.ts`: uploads `.omw-access/sync.key` and the deny
    `.htaccess` once, outside the deploy record; manages its own service session
    `f/svc-publisher/<sid>`.
  - `httpcheck.ts`: anonymous-must-be-403 plus service-session-must-be-200.
- **Gate** `backend/src/generator/static/gate.php` (new, about 250 lines of plain PHP, no
  Composer): join (POST, rate limit per IP-hash with files, device limit, session file, cookie,
  redirect to `/<locale>/`), leave (delete own session), sync (verify the HMAC, apply the
  snapshot atomically, report devices, expire sessions older than 400 days). PHPUnit tests can run
  it with PHP's built-in server.
- **Site SPA:** `frontend/site/src/data/fetch.ts` maps 401/403 on data to `AccessEndedError`;
  `routes/root.tsx` shows a friendly "Your access has ended / ask for a new link" screen and calls
  `queryClient.clear()`; `components/site-header.tsx` gets "Sign out on this device".
- **Docs:** `docs/HOSTING.md` (requirements, probe, lock procedure); `README.md` status.

### D. Client-side encryption (any static host)

**How:**
- Every JSON file and every media file is encrypted at rest. Media: AES-256-GCM in fixed chunks
  (e.g. 64 KiB, each with its own nonce and tag, so large files can be decrypted progressively).
  Each file gets its own random file key (DEK), kept in the backend store so output stays
  deterministic (the generator's byte-identical incremental builds depend on that).
- DEKs live inside the encrypted day JSON. The JSON layer is encrypted with an epoch content key
  (CK).
- `data/keys.json` holds CK wrapped once per follower. The invite link carries a personal secret in
  the fragment: `https://site/#k=<id>.<secret>`. The page derives a key-encryption key (HKDF) and
  unwraps CK (AES-KW) with WebCrypto, stores the follower secret in IndexedDB, and strips the
  fragment from the address bar.
- To keep the API host out of the trust chain: the admin PWA generates the secret on the phone
  and sends only a **public key** (ECDH P-256) to the API. The backend, which holds CK, wraps CK to
  that public key. The API never sees a secret.

**Revocation, what it really costs:**
- *Minimum:* new CK (epoch + 1), re-encrypt the **JSON layer only** (a few MB), re-wrap for the
  remaining followers, publish. Media ciphertexts and DEKs do not change, because the revoked
  person already had them while they had access.
- *Also cut off re-fetching old media:* put media under an epoch directory
  (`media/<random-epoch>/…`) and **rename that one directory over SFTP** on rekey (O(1); the new
  JSON names the new directory).
- *Truly re-key everything:* re-encrypt and re-upload all media, about 10 GB per year by the
  plan's estimate (hours on a home uplink). Only needed if DEKs are presumed leaked to people who
  never had access.
- In every case, rekeying needs the **backend (Mac) online**: revocation waits while it sleeps.

**Decrypting media in the browser:**
- *Images:* fetch → decrypt → `Blob` → `URL.createObjectURL`. `<picture>`/`srcset` selection is
  lost (JS picks the variant), and so is progressive decode. Memory use is higher.
- *Video and voice:* simplest is to download the whole file, decrypt it to a Blob, then play. That
  means no streaming start, but status videos are short. MSE streaming exists on iPhone only from
  iOS 17.1 (ManagedMediaSource) ([WebKit 17.1](https://webkit.org/blog/14735/)), which leaves out
  older iPhones.
- *Service-worker decryption* keeps `<img srcset>`/`<video src>` unchanged and can answer `Range`
  from chunks. But the first visit is not controlled, the key has to be handed to the SW
  (IndexedDB), and in-app browsers built on WKWebView generally have no service workers
  ([Apple forums](https://developer.apple.com/forums/thread/773539)). So the Blob path is needed as
  a fallback anyway.

| Criterion | Assessment |
|---|---|
| Real protection | Strong against everyone without a key, including the host and any CDN. HTML must become content-free shells: no pre-rendered first screen, no inlined day, no OG image. Browser caches hold ciphertext; the key sits in the follower's IndexedDB. Forwarding: a forwarded link works fully and **undetectably** until a rekey. |
| Revocation | Per person, at the cost above. Never retroactive. |
| UX | Tap the link; works. Safari deletes script-written storage after 7 days of Safari use without a visit ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)); in-app browsers keep separate storage. Either way: "tap your link again". Slower first paint (no pre-render) and slower video start. |
| Owner effort | Like C; rekeying is automatic. |
| Host | **Any** static host, CDN-friendly. |
| Performance | Ciphertext is immutable and cacheable. WebCrypto AES-GCM is fast, but LCP loses the pre-rendered `<img>`, and videos download fully before playing. |
| Failure modes | A lost key means no access (resend the link). Leaked link = full access until rekey. A bug in the crypto layer = blank site for everyone. XSS = key theft (the strict CSP helps). Losing the backend's DEK store means old media can no longer be re-published. |

**Does NOT protect against:** forwarding (it cannot even detect it); screenshots; a malicious
follower extracting CK from their own browser and publishing it; traffic analysis (file sizes,
timing).

**Code changes (L, the largest):**
- `packages/contracts/src/site.ts`: encrypted envelopes for Manifest, Timeline, Day and Trip;
  `ImageSource`/`VideoMedia`/`AudioMedia` gain `k` (DEK) and chunk info; `keys.json` schema;
  `Boot` without `day`/`profile`; `contractVersion` bump.
- `backend/src/generator/media.ts` + `generate.ts`: encrypt variants instead of hard-linking them
  (`fsutil.linkOrCopy` path); store DEKs in `backend/src/store`; epoch handling; new
  `backend/src/crypto/`.
- `pages.ts`: shell pages only.
- `frontend/shared/src/picture.tsx` → an encrypted variant (variant choice, Blob lifecycle);
  `frontend/site/src/player/media.ts` (preload/decode), `player/video-pool.tsx` (Blob `src`), the
  voice player, Media Session artwork; `data/fetch.ts` (decrypt JSON); a new key module and
  "enter your link" screen; optional SW.
- API + admin for followers' public keys, as in C, minus the gate.

### E. "Request to follow"

**How:**
- Without access, a visitor sees only a lovely landing page (`/_/welcome/`). By default it shows no
  portrait, name or place, unless the owner opts in. It has a form: name, how they know her, a
  message, an optional contact.
- `POST /api/v1/public/follow-requests` over the existing CORS (`Cors.php`):
  - rate limits per IP-hash, reusing the `LoginThrottle` pattern;
  - a honeypot field; optionally self-hosted proof-of-work instead of a third-party CAPTCHA (no
    trackers);
  - length limits; JSON only.
- The owner gets ntfy or e-mail (`Domain/Alerts/ChannelNotifier`) and answers in the admin:
  **Approve** (creates the follower in C or D), **Decline**, or **Decline & mute** (silently
  ignore further requests carrying the same name or contact).
- **Getting the link to the person:**
  - (a) Best for family: the owner sends it herself via WhatsApp from the admin's share sheet.
    She knows the person, and no e-mail address is stored.
  - (b) Automatic: the form returns a request secret kept in that browser; the welcome page polls
    `GET …/follow-requests/<id>` with it, and after approval it receives the invite and joins
    directly. This breaks if they come back in another browser.
  - (c) E-mail, only with consent.
- **Never reveal "declined"** to the requester; after N days show "this request has expired". An
  explicit refusal can provoke exactly the person this is meant to keep away.

| Criterion | Assessment |
|---|---|
| Real protection | E itself protects nothing; it is the friendly front door for C or D. Its risk is **social engineering**: "I'm a friend from school". The admin must nudge: "Approve only people you can confirm another way." |
| Revocation | Via C or D. |
| UX | Strangers get a nice path instead of a dead end. |
| Owner effort | Reviewing requests (push notification → one tap). |
| Host | Needs the API (it exists), but not for viewing. |
| Failure modes | Spam (rate limit, honeypot, proof-of-work); harassment through the form (mute; the contact form has the same problem, so share the infrastructure); the welcome page reveals *that* a private site exists, and whose it is if it shows her name. |

**Data protection:** request data is personal data. Collect the minimum, explain it on the form,
delete declined and expired requests after e.g. 30 days, and log no IPs beyond hashed rate-limit
keys. The site is for family and friends, so the household exemption *may* apply, but an open
request form for strangers weakens that argument. Ask the owner, don't assume.

**Code changes (M on top of C):**
- Contracts: `FollowRequestCreate`, `FollowRequest`, `FollowRequestDecision`.
- `api/src/Http/Public/FollowRequestController.php` (new `Public` namespace as planned) plus
  routes in the `/public` group; migration (in `0002_access.sql`); alert kind
  `follow_request_new` in `AlertEngine`.
- Admin `screens/requests.tsx`; Home badge.
- Generator `renderWelcome()` with a small separate Vite entry (`frontend/site/src/welcome.tsx`),
  so the landing does not load the timeline bundle; Lingui strings in `locales/{de,en,ar}`.

### Hybrid: public teaser layer + followers layer

**How:** the generator builds **two trees from the same store**.
- `/` is public. Delayed by days (e.g. 7–14), country-level only, no here-now, no coordinates,
  optionally only entries she marks as public. It carries the "Request to follow" button.
- `/f/` is for followers: live (`instant`), full detail, behind C-gate (or encrypted with D).
- This fits the code well: the SPA already takes `basePath` from the Boot JSON, and all data paths
  are relative. So `/f/` is the same generator output with `basePath=/f/` and a different policy.
  The SPA needs no structural changes.
- Media of public items would be duplicated under `/f/media/`, unless the Boot JSON gets an
  optional `mediaBase` (a small contract change) so the follower tree can reference `/media/`.

| Criterion | Assessment |
|---|---|
| Protection | The followers layer as in C or D. The public layer is A-grade, but with **days of delay and no place names**, so it gives no real-time value to a stalker. |
| UX | Everyone sees *something* lovely; approved people see more. |
| Owner effort | One more setting ("what the public sees"); optional per-item "public" toggle. |
| Host | As C or D for `/f/`; the public part works anywhere. |
| Failure modes | Two policies, two trees: a bug can put a follower-only item into the public tree. That needs a vector test like `fixtures/vectors/policy.json`: an item marked followers-only must never appear in public output. |

**Code changes (M–L on top of C):**
- `packages/contracts/src/policy.ts` gets audience-aware visibility (`audienceVisibility()`, with
  shared PHP vectors in `api/src/Domain/Policy.php`).
- `backend/src/generator/model.ts` and `generate.ts`: two model passes and two trees; the
  dependency map doubles.
- Settings `public.delay_days`, `public.location_precision`, `public.kinds`.
- Admin item sheet gets an "also public" switch.
- Optional `Boot.mediaBase`.

---

## 5. Comparison

| | A public+mitigations | B shared password | C1 htpasswd/person | **C-gate** | C2 PHP serves files | D client crypto | E request | Hybrid |
|---|---|---|---|---|---|---|---|---|
| Strangers kept out (HTML, JSON, media) | no (obscurity) | yes | yes | **yes** | yes | yes | n/a | public part: no |
| Per-person revocation | no | no | yes | **yes, seconds** | yes | yes (rekey, needs Mac) | via C/D | via C/D |
| Forwarding limited/visible | no | no | no | **yes (device limit + list)** | yes | no | n/a | via C |
| Grandparent UX | best | poor (B1) / ok | poor | **good (tap link)** | good | good-ish (7-day storage, slower video) | good | good |
| Owner effort | none | low (re-share) | medium | **low** | low | low | per request | +1 setting |
| Any static host | yes | no | no | **no (Apache+PHP)** | no (PHP) | **yes** | API | as parts |
| Performance | best | native | native | **native** | poor on 2–5 PHP workers | worse LCP and video start | n/a | as parts |
| Survives host compromise | no | no | no | no | no | **yes** | n/a | as parts |
| Effort | S | S–M | M | **L (with E)** | M–L | L+ | M | +M–L |

---

## 6. Recommendation for this owner and host

The owner's concern is stalker-like people. The host is Hetzner with Apache and PHP. The users are
family and friends on phones, and she runs everything from the admin PWA. In that order:

1. **Now, cheap, in every option (S):**
   - stop publishing `lat`/`lng`;
   - no `og:image` of the latest day while not indexable;
   - "here now" off unless the viewer is a follower;
   - a location precision setting;
   - a secret `basePath` before real content goes live (the live preview is synthetic today).

   Until the gate exists, set `publish.mode=delayed` with a delay longer than a typical stay, or
   keep the site unannounced. The owner chose `instant`, which is fine *for followers*, not for an
   open site.
2. **Build C-gate + E (L):** personal links, device limit, device list, revocation and "lock now",
   all from the admin. Strangers get the welcome page and the request form; approved people get
   their link via WhatsApp from the admin.
   - The publisher's HTTP check asserts anonymous = 403 on every deploy (catches fail-open).
   - Keep the secret path as a second layer.
3. **Then, if she wants strangers to see something:** the hybrid public teaser (M–L).
4. **Keep D as the documented fallback** for a future move to a host without PHP, or if the owner
   ever needs protection from the hosting provider itself. Do not build it pre-emptively: it costs
   the most and is weakest against forwarding, which is this owner's main threat.

Not recommended: B1 via konsoleH as a long-term solution (silent fail-open when the generated
`.htaccess` changes, poor UX, no per-person revocation). It is acceptable as a short stopgap only
if the generator's `.htaccess` is checked after every deploy. C2 (PHP serving media) is not
recommended on 2–5 PHP workers.

---

## 7. Decision points for the owner

1. **Who sees what?**
   - (a) Followers only: everything behind personal links, strangers see only the welcome page.
   - (b) Hybrid: a public teaser plus a live followers area.
   - (c) Public with mitigations (A).
2. If hybrid: **how old** must public content be (e.g. 7 or 14 days)? **How precise** is the public
   location (country / none)? Which kinds may be public? Do her **name, greeting and portrait**
   (from the parallel profile wave) appear on public pages and on the welcome page?
3. **Device limit per personal link** (2? 3?). **Notify** her when a link is used on a new device,
   or tried above the limit?
4. **Request to follow:** allowed at all? Which fields? How do approved people get their link
   (she sends it via WhatsApp / automatically in the browser / e-mail)? What do declined people see
   (recommended: "pending", then "expired")?
5. **Followers see instantly** (keep `instant`) or also with a delay?
6. Is **PHP on the site host** acceptable (C-gate, Hetzner-specific), or must the site stay
   deployable to a pure static host (then D, with the costs above)?
7. Should there be a **"Lock everything now"** emergency switch in the admin? (Recommended: yes.)
8. **Retention:** how long to keep declined requests and device info ("iPhone · Safari", join
   date). Store no IP addresses?
9. Is the **contact form** (parallel design) visible to non-followers? It is a harassment channel
   too.
10. **Her WhatsApp status audience:** does it exclude the people she wants kept off the website?
    The website should not be wider than WhatsApp, and WhatsApp is not covered by any of this.

---

## 8. Probe checklist for the Hetzner site host (owner-run, a handful of requests)

Run this in a throwaway folder `/_probe-<random>/` and delete it afterwards. Keep the requests
few: HOSTING.md §10 notes that the host blocked HTTPS after a burst of probing.

1. `probe.php`: print `__DIR__`, `$_SERVER['DOCUMENT_ROOT']`, `PHP_VERSION`, `php_sapi_name()`,
   `ini_get('max_execution_time')`. Is PHP enabled for the site domain at all?
2. `.htaccess` with headers only inside `<IfModule>` blocks for `mod_rewrite.c`, `mod_headers.c`,
   `mod_xsendfile.c`, `mod_auth_form.c`, `mod_session_crypto.c`, and `<IfVersion >= 2.4.47>`
   (needs mod_version). Read the response headers.
3. Rewrite test: `RewriteCond %{DOCUMENT_ROOT}/_probe-x/flag -f` → `RewriteRule ^t$ ok.txt [END]`.
   Does `t` return `ok.txt` with the flag file present, and 404 without it?
4. Cookie test: `RewriteCond %{QUERY_STRING} v=([a-z0-9]{8})` →
   `RewriteRule ^c$ ok.txt [CO=probe:%1:<host>:5:/:secure:httponly:lax,END]`. Does `Set-Cookie`
   carry the captured value (backreference expansion in `CO`)?
5. X-Sendfile: `xs.php` sends `X-Sendfile: <__DIR__>/ok.txt` and no body. Do you get the file
   contents?
6. Does konsoleH directory protection write into the folder's `.htaccess` (and where is its
   `.htpasswd`)? This decides whether B1 via konsoleH would fail open.

---

## 9. Sources

- Apache expressions (ap_expr: md5/sha1/base64, `$0..$9`, `%{TIME}`, file tests): https://httpd.apache.org/docs/2.4/expr.html
- Apache rewrite flags (CO syntax, SameSite from 2.4.47, R with non-3xx, END vs L in .htaccess): https://httpd.apache.org/docs/2.4/rewrite/flags.html
- mod_rewrite RewriteCond backreferences: https://httpd.apache.org/docs/2.4/mod/mod_rewrite.html#rewritecond
- mod_auth_form: https://httpd.apache.org/docs/2.4/mod/mod_auth_form.html
- mod_session_crypto: https://httpd.apache.org/docs/2.4/mod/mod_session_crypto.html
- ap_expr base64/SHA1/MD5 added early in 2.4 (CHANGES excerpt): https://forge.etsi.org/rep/cyber/103523_MSP/tlmsp/tlmsp-apache-httpd/-/blame/master-tlmsp/CHANGES?page=4
- mod_xsendfile: https://tn123.org/mod_xsendfile/
- Hetzner konsoleH server configuration / directory protection: https://docs.hetzner.com/konsoleh/account-management/configuration/htaccess
- Hetzner Webhosting plans (PHP processes per plan): https://www.hetzner.com/de/webhosting/
- WebKit, 7-day cap on script-writable storage, home-screen apps exempt: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- WebKit, Safari 17.1 ManagedMediaSource on iPhone: https://webkit.org/blog/14735/
- Service workers in WKWebView (app-bound domains only): https://developer.apple.com/forums/thread/773539 and https://bugs.webkit.org/show_bug.cgi?id=206741
- Chrome blocks sub-resources with credentials in URLs: https://groups.google.com/a/chromium.org/g/blink-dev/c/lx-U_JR2BF0
- Chrome cookie expiry cap (400 days): https://developer.chrome.com/blog/cookie-max-age-expires
- WhatsApp link previews fetched on the sender's behalf: https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/ and https://www.macrumors.com/2020/10/26/link-previews-may-lead-to-security-vulnerabilities/
- Google: noindex vs robots.txt, X-Robots-Tag for non-HTML: https://developers.google.com/search/docs/crawling-indexing/block-indexing
- Let's Encrypt submits all certificates to CT logs: https://letsencrypt.org/docs/ct-logs/
