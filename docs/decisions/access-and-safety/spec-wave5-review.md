# Review of `spec-wave5.md` (skeptical pass, 2026-11-20)

Scope: the wave-5 spec (sections 0–11, Appendix A), its `apache-probe-w5/` and `p0b/` kits, read against
`owner-decisions.md` (authoritative) and the repo as it stands (HEAD `149fb33`, clean tree).
No live host was contacted. Local runs: macOS Apache 2.4.66 on 127.0.0.1:18091/18094 and `php -S`
on 127.0.0.1:18093, all stopped afterwards. Nothing in the repo was changed.

## 0. Verdict

The spec is buildable in outline, and the Apache gate holds up. I reproduced every claimed result, and
about 50 extra adversarial cases found no oracle and no new fail-open (§C). Fix these before building:

1. **Critical C1:** pending and declined devices can read, export and **delete** the person's data.
2. **High H1:** the handoff URL carries the long-term session and the device key.
   Both end up in browser history, history sync and the site access log, and the URL can be used for login fixation.
   A variant with no secrets in the URL works on local Apache (§C.3).
3. Four Medium buildability breaks:
   - WP0 cannot end green: the seeded-settings test fails (M1).
   - `verify.ts` rejects the spec's own content `.htaccess` (M2).
   - phpseclib is not available offline (M3).
   - A contract field disagrees with the endpoint table (L-group).
4. **Medium M4:** a false "Wirksam ✓" is possible when the Mac writes to a different store than the one Apache reads.

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | C1 |
| High | 1 | H1 |
| Medium | 10 | M1–M10 |
| Low | 13 | L1–L13 |
| Nit | 12 | N1–N12 |

---

## A. Compliance with `owner-decisions.md`

| Requirement | Status | Notes |
|---|---|---|
| Q0 b: no PHP on the site host | **OK** | Apache + `.htaccess` only. The D4 "tiny PHP" fallback is dropped in favour of F1/F2, which is correct under Q0 b. |
| Q0: `CO` from a backreference, weaker cookies accepted | **OK, deviation flagged** | The `mod_headers` primary path is *stronger* than the owner's text and is flagged at the top of the spec. The owner accepted weaker *cookie attributes*. That does not cover long-term credentials in a URL (H1). H1's fix still uses a backreference, now taken from a cookie, so the owner's "CO with a backreference" stays valid for F1. |
| D1/D3: zero information without access | **OK, with L5** | Verified: anonymous answers are byte-identical, including across folders (§C.2). The public gate bundle still says "Reise" (L5). |
| D2: per-person revocation | **OK** | |
| Q3 c: device approval after the first device | **Broken by C1** | An unapproved (pending) device can act as the person on the D12 endpoints. Reopening the link also creates duplicate pending devices (M6). |
| D4: "the device limit" | **Partial (L9)** | Only a cap of 3 pending devices. No cap on active devices, and no statement that approval replaces one. |
| D6: never-reused id | **OK, with L8** | After an API restore, fids that exist only in the store are not tombstoned. |
| D11: information first, versioned, de+en | **Partial (M5, N7)** | "Shown again on the next visit" becomes "within 6 h". De+en are required only when `site.locales` has both. |
| D12: delete me, export, tombstone, owner notice | **OK in design, exploitable (C1)** | The tombstone keeps `created_at`, `kind` and `deleted_by` beyond "ID + deleted on" (N8). "Second call answers `deleted`" is impossible after erasure (N9). |
| Q6: one login, lock in admin, panic link | **OK** | |
| Q7: configurable privacy data, templates "not legal advice" | **OK, with L10** | The template's backup sentence is wrong in two cases (L10). It says "two cookies"; there are three, or four with H1's fix (N10). |
| Q9: configurable domain | **OK, with L4** | The hostname-grep test fails on an existing placeholder (L4). F1/F2 need a cookie `Domain` in the bundle contracts (M7). |
| Owner addition: change password, recovery | **OK, with N11** | App tokens survive "every other session is ended" (N11). |
| Implementation split (wave 5 list) | **OK** | All P0 items are present. Wave-6 items are correctly deferred. |

---

## B. Findings

### C1 (Critical): pending and declined devices can read, export and delete the person's data

**Where:** §3.4 rows `me/data`, `me/export` and `me/delete`. The auth column reads "key, any state of a non-deleted follower"; `me/delete` is "same as data". §6.2.3 shows the "Deine Daten" link to every device that has a key cookie.

**Problem.** A pending device is by definition unapproved (Q3 c). It is exactly what a forwarded personal link produces, and that is the misuse the notice says the data helps to detect. With its own key, such a device can:
- read `FollowerDataView`: all devices, their states and last-seen times (an activity pattern that D9 reserves for the traveler), plus the consent history;
- export the data;
- call `me/delete`, which erases the person and revokes all their devices, irreversibly.

A declined device keeps the same powers from `/_/ended/`.

**Failure scenario.**
1. Oma's link is forwarded. A stranger opens it and becomes pending.
2. The stranger goes to `/_/me/` (a public page), taps "Mich und alle meine Daten löschen…".
3. Oma loses access and her record is gone. The owner only gets "Eine Person hat ihre Daten gelöscht".

**Fix.**
- Authorise `me/data`, `me/export` and `me/delete` only when one of these holds:
  - the device is `active`;
  - the device is `revoked` **and** the follower is `revoked`, so a person whose access ended keeps the D12 rights on devices she really used.
- Pending and declined devices get only:
  - `me/notice` and `me/consent`;
  - `me/signout`, which withdraws the request;
  - a minimal `me/data` variant (this device's label and state, no follower data and no other devices).
- Answer `me/delete` from those devices with `ended`.
- Make the `/_/ended/` "Deine Daten" link conditional on that answer.
- Add a PHPUnit matrix: device state (pending, active, revoked-by-owner, revoked-by-follower, declined) × follower state (active, revoked) × endpoint (data, export, delete, signout, notice, consent).

### H1 (High): the handoff URL holds the long-term credentials; fixation is possible

**Where:** §2.3.2, §2.3.3, the `HandoffPath`/`handoffPath()` contract, P0b T4.

**Problem.** `/_/h/<fid>.<did>.<sid>.<k>` contains two credentials:
- the gate cookie value, valid for 400 days and usable by hand-crafting the cookie long after the one-time marker is gone;
- the device key `k`, which mints new sessions via `resume` and authorises `me/delete` and `me/export`.

The URL lands in:
- browser history, and Safari/Chrome **history sync**, for example a family iPad on a shared Apple ID;
- the site host's access log, with unknown retention and readers.

It also enables **login fixation**: anyone holding a fresh handoff URL can make another browser adopt their identity with a cross-site link. In wave 6 the victim's reactions and messages would then be filed under the attacker's id, and the attacker could export them.

The spec justifies the URL with Q0's "accept the weaker cookies". That decision was about cookie attributes, not about secrets in URLs. Verified: the spec's rule sets all three cookies for a request that carries no cookies at all (`review-probe/logs/review-output.txt` R5).

**Fix (verified on local Apache, §C.3, `review-probe/review-v2.sh`).** Put no secrets in the URL.
1. Before navigating, the gate page writes `__Host-omw_s=<fid>.<did>.<sid>` (`Max-Age=120; Secure; SameSite=Strict`, JS-set) next to the key cookie it already writes, then calls `location.replace('/_/h/')`.
2. Apache accepts the handoff only when all of these hold:
   - the Strict key cookie is present (Strict cookies are never sent on a cross-site navigation, which kills fixation);
   - the marker `h/<did>` exists;
   - the session file exists;
   - the site is not locked.
3. Apache then copies the values into the HttpOnly `__Host-omw` and a server-set `__Host-omw_k`, and expires `__Host-omw_s`.

Rule text (replaces the first handoff rule of §2.4.1):
```apache
RewriteCond %{REQUEST_URI} =/_/h/
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{KK}}=([A-Za-z0-9_-]{43})(?:;|$)
RewriteRule ^ - [E=OMW_HK:%1]
RewriteCond %{ENV:OMW_HK} ^[A-Za-z0-9_-]{43}$
RewriteCond %{HTTP_COOKIE} (?:^|;\s*){{SK}}=([a-z2-7]{12})\.([a-z2-7]{8})\.([A-Za-z0-9_-]{43})(?:;|$)
RewriteCond {{STORE}}/h/%2 -f
RewriteCond {{STORE}}/s/%1/%2.%3 -f
RewriteCond {{STORE}}/locked !-f
RewriteRule ^ /{{SECRET}}/ [R=303,L,E=OMW_SET:%1.%2.%3,E=OMW_KEY:%{ENV:OMW_HK}]
```
Root cookie section, added:
```apache
Header always add Set-Cookie "{{SK}}=; Path=/; Max-Age=0; {{SEC}}SameSite=Strict" env=OMW_SET
```
Results (§C.3):
- valid → 303 and the cookies;
- no key cookie, no cookies, the old 4-part URL, a wrong sid, locked, or marker gone → 303 to `/` without cookies;
- the rolling refresh is unchanged.

Ripple effects:
- `HandoffPath` becomes `'/_/h/' | '/'`; `Active` gets `session: "<fid>.<did>.<sid>"`; `HANDOFF_PATH_RE` and `handoffPath()` go.
- `GATE_COOKIE_NAMES` gains `s`.
- F1 uses the same cookie captures in `CO=` (backreferences from the cookie RewriteCond).
- P0b T4 becomes "cookie-sourced handoff". For the browser path, add a static `site/hs.html` that writes the two test cookies by JS and navigates, so the request count stays ≤ 13.
- Optional extra: also check `Sec-Fetch-Site` when present.

The residual (sid inside a 120-second JS cookie) equals what the JS already holds today.

### M1 (Medium, buildability): WP0 cannot "end green"

**Where:** §9 WP0, §4.2 settings.

**Problem.**
- The new keys `publish.release_slots`, `publish.departure_hold`, `site.here_now` and `site.time_precision` are non-optional in `SettingsShape`, so the exported `Settings.json` lists them in `required`. I checked the required list in today's `api/schemas/Settings.json`: it is every non-clearable key.
- `api/tests/ContractSchemaTest::testSeededSettingsMatchSettings` validates the rows seeded by the migrations against that schema.
- The rows are only added by `0002_access.sql`, which belongs to WP1. So after WP0, `scripts/composer test` is red.

**Fix.** Split the migration:
- `0002_settings_w5.sql` (settings rows + change_log) goes into WP0's keep-green list;
- `0003_access.sql` (everything else) goes to WP1.

Also state the live deploy order (API before backend) in WP5.

### M2 (Medium, buildability): `verify.ts` rejects the spec's own content `.htaccess`

**Where:** §2.4.3 vs §5.5.

**Problem.**
- §2.4.3 keeps today's `htaccess(site)` "with these changes". That function emits `<FilesMatch "^\.">` / `    Require all denied` (`backend/src/generator/extras.ts`).
- §5.5 forbids any line outside the gate block that matches `/^\s*(Rewrite\w*|Require|…)\b/i`.
- The generated file therefore fails its own check.

**Fix.** In gate mode, drop that `FilesMatch` block from `contentHtaccess()`; the gate's dot rule plus the server's `.ht*` deny cover it. Alternatively, allow exactly that 3-line block. I ran the gate with the block present (`review-probe/content-spec.in`) and found no difference in anonymous answers, so either choice is safe.

### M3 (Medium, buildability): phpseclib is not available offline

**Where:** WP1, §3.8.1.

**Problem.** `phpseclib/phpseclib` is in neither `api/vendor/` nor `.cache/composer/cache/files/`. Neither are its dependencies `paragonie/constant_time_encoding` and `paragonie/random_compat` (phpseclib 3.0 requires both). WP1 therefore needs network access to packagist and GitHub dist downloads, and `deploy-api.ts` builds `vendor/` locally.

**Fix.**
- WP1 step 1: `scripts/composer require phpseclib/phpseclib:^3.0` on a networked machine, committing `composer.lock` (3 packages).
- Until then, code against the spec's `SftpClient` interface with the fake, so everything else in WP1 is testable offline.
- Record in P0b which crypto extensions exist (`sodium`, `gmp`, `bcmath`; the kit already collects them, but §10.4 only looks at `openssl`). Without sodium and gmp, phpseclib falls back to pure-PHP Curve25519/RSA. That costs seconds per connection and breaks the "1–3 s" in §3.10.
- Optionally probe `extension_loaded('ssh2')` as an alternative.

### M4 (Medium): the store has no identity check; the Mac can "apply" ops to the wrong folder

**Where:** §3.8.4, §5.6.6, `AccessAck`, §3.5 `Effect.applied`.

**Problem.** Two independent settings must name the same folder:
- the API's `ACCESS_STORE_DIR`/`_SFTP_ROOT` and the Mac's `accessStoreRoot`, as the writers;
- the backend's `ACCESS_STORE_DIR`, which is baked into the `.htaccess`.

Nothing checks that the folder a writer writes is the folder Apache reads. Failure scenario:
1. The API writer is down.
2. The Mac claims, applies the ops into a wrong or empty folder, writes a fresh marker there and calls `ack`.
3. The API marks the ops applied, and the admin shows "Wirksam ✓".
4. The revoked device keeps access, because the real store still has its file and the API cannot reconcile while its own writer is down.

The heartbeat compares only `site.origin`.

**Fix.**
- Add `storeId` (random, written once at store init) to `.omw-store.json` and `access_state`. `claim` returns it.
- The Mac refuses to apply (and alerts) unless the marker exists with the same `storeId` and epoch. Initialising an empty store becomes an explicit admin action.
- `SiteHeartbeat` gains the configured `storeDir`, and the API compares it with its own.
- Add an end-to-end acceptance check (also see §D): after a deploy, gatecheck #4 (the service session must be accepted) plus a new **#5**: the previous service-session cookie, rotated through the writer, must be **refused**. This proves both put and delete reach the folder Apache reads.
- Define #4/#5 failures as the critical alert `access_store_unverified`, not `gate_open`.

### M5 (Medium, D11): a changed notice is not shown "on the next visit"

**Where:** §1.7, §6.3 `hello.ts`.

**Problem.** `me/hello` runs only after a handoff or when `localStorage['omw.helloAt']` is older than 6 h. A follower who visits 1 h after the owner publishes v2 does not see it, and D11 says "next visit". Clear-Site-Data or private browsing make this erratic anyway.

**Fix**, either of:
- call `me/hello` once per tab session (`sessionStorage`) instead of every 6 h; that is a handful of requests per follower and day;
- or publish the current notice version through the change feed (non-personal setting `privacy.version`) into `Boot`, and call hello when it differs from the locally confirmed version.

Add a stack-e2e step: publish v2, then the next page load of A shows the reconfirm screen, with `helloAt` *not* cleared. Today's step 8 clears it.

### M6 (Medium): reopening the link from a pending device creates duplicate pending devices

**Where:** §3.4 `join/check` (`known_device` only for *active* keys), §6.2.2 text ("Du kannst diese Seite schließen und später deinen Link wieder öffnen").

**Problem.** Following the spec's own advice:
1. A pending device reopens the link.
2. `join/check` answers `ok`, and `join` creates a **new** pending device.
3. After three reopenings, `too_many_pending` locks the person out of adding devices.
4. The owner sees duplicates labelled "iPhone · Safari".

**Fix.** `join/check` with a `k` that is a *pending* device of the same follower answers a new status `pending_device`, and the page goes to `/_/wait/`. Contract: add it to `JoinCheckResponse`. Test: reopen ×3, still one pending device.

### M7 (Medium, F1/F2 only): JS-set host-only cookies duplicate the server's `Domain` cookies

**Where:** §2.8 F1/F2, §6.2 `cookies.ts`, `GateBoot`, `Boot.access`.

**Problem.**
- In F1, Apache's `CO` always adds `domain=<host>`. In F2, the API sets `Domain=<parent>`.
- The gate JS writes `omw_k` (and deletes `omw_h`) **without** `Domain`, so Chrome and Firefox keep two `omw_k` cookies.
- After a re-join, the stale one can come first. `document.cookie` parsing and Apache's regex both take the first match, so the device presents an old key (`ended`) or the delete of `omw_h` silently fails.
- Verified with Apache that the first duplicate wins: valid-then-stale → 200, stale-then-valid → 403 (§C.2 R4).

**Fix.**
- Add `cookieDomain` (nullable) to `GateBoot` and `Boot.access`.
- In `co`/`parent` modes, `cookies.ts` writes and deletes with that `Domain`.
- Test the cookie strings per mode.

### M8 (Medium, shared hosting): request paths block PHP workers on the store lock

**Where:** §3.8.3.

**Problem.**
- Every `join`/`poll`/admin action calls `applyNow()`: a blocking `flock` with a 5 s wait, then an SFTP connect (1–3 s, more without sodium/gmp), up to 10 s per request.
- With Hetzner's few FPM workers, a family burst (several joins) plus the admin plus the backend's 15-s pulls can exhaust the pool. That is critique H4 again.
- The spec also does not forbid holding a SQLite write transaction across store I/O. If an implementer wraps the apply loop in `Db::write()`, every writer waits on network I/O (busy_timeout 5 s, then errors).

**Fix (MUST rules).**
- Request paths use `LOCK_NB`. If the lock is held, answer `activating` or `effect.applied=false` at once.
- The lock holder keeps re-reading pending ops until none remain or its deadline passes, so ops enqueued meanwhile are not left for cron.
- Each op's `applied_at` is committed in its own short transaction; no DB transaction spans SFTP or filesystem calls.

### M9 (Medium): the SFTP credential scope of the API is decided implicitly

**Where:** §3.1 `ACCESS_STORE_SFTP_*`, §10.4 P0b-2 ("…; else the site login").

**Problem.** If no restricted account is possible, the spec falls back to putting the **site's full SFTP login** into the API's `.env`. The API is the larger attack surface: a public PHP app on a shared host. A leaked `.env` or an RCE would then let an attacker rewrite the site's `.htaccess`, removing the gate, read everything, or deface the site. D4 asks for a restricted account "ideally".

Note also that the site's SFTP root is the docroot. A store "outside every docroot" is reachable only by `direct` or by a separately rooted account. So `sftp` with the site login forces F3.

**Fix.**
- Make "the site login in the API" an explicit owner decision with this trade-off spelled out.
- Default the no-restricted-account branch to `ACCESS_STORE_MODE=none` (the Mac writer) instead.
- Prefer `_KEY_FILE` over `_PASSWORD`.
- `Doctor` warns when the configured SFTP user can list the site docroot outside the store.

### M10 (Medium): the Mac lease can expire mid-apply; the reconciler can re-lock after an unlock

**Where:** §3.8.3–3.8.5.

**Problem 1: lease expiry.**
1. The Mac's 60-s lease expires during a slow apply, and the API takes over.
2. The API applies a later `delete s/f/d.S` (a revoke).
3. The Mac, unaware, then applies the earlier `put s/f/d.S`.
4. The revoked device has access again until the next normal reconcile (≤ 5 min with direct/sftp, never with `none`).

**Problem 2: reconcile against unlock.**
1. A reconcile reads the DB at T1 (locked).
2. The owner unlocks at T2, which enqueues `delete locked`.
3. The reconcile enqueues its fix `put locked` at T3, after the unlock.
4. The site re-locks. The next reconcile imports the file (sticky rule), so the DB is locked again.

**Fix.**
- The Mac checks `lease.until − 10 s` before each op and stops, or renews through a `POST /backend/access/renew`. Cap ops per claim at 200.
- The reconciler reads the desired state and enqueues its fixes in **one** write transaction (with the listing taken before, under the lease), or re-validates each fix against the DB at enqueue time.

### L1: the handoff can fail if a freshly written file is not yet visible to Apache

If the site's Apache and the API's PHP see the webspace through a caching network filesystem (Hetzner layout unknown), a file created a moment ago may be negative-cached:
- the handoff fails (303 to `/`, then neutral page, then resume, then a new session);
- deletes are seen late, which breaks the "< 1 s" claim.

**Fix:**
- Add P0b T11/T12: PHP creates a file and Apache checks it with `-f` within 200 ms; PHP deletes it and Apache sees it gone within N s.
- Send failed handoffs to `/_/join/#handoff-retry` instead of `/`, so the page retries once after 2 s.

### L2: the resume throttle lives in `sessionStorage`, which Clear-Site-Data wipes

`Clear-Site-Data: "storage"` also clears sessionStorage, and it is sent on every refusal with a stale cookie. The 5-minute throttle in the neutral script therefore never holds. If the handoff keeps failing (L1, misconfiguration), each device loops resume → issue until the `issue` limit (6/h) or 429.

**Fix:** keep the throttle in a cookie (`omw_r`, `Max-Age=300`). Clear-Site-Data never clears cookies here.

### L3: Safari's 7-day cap hits pending devices

The JS-set key cookie of a pending device is capped at 7 days in Safari. The owner has 14 days to approve. An approval after day 7 strands the device, and the follower creates a new pending one.

**Fix:**
- Also refresh `{{KK}}` server-side on `/_/(wait|join|info|me|ended)/` page loads: the same `E=OMW_RK` mechanism, placed before the `^/(?:_/|…)` pass-through.
- Or decline pending devices after 7 days and say so in the admin.

### L4: the Q9 hostname grep fails on an existing file

`backend/src/ui/pages.ts:511` has `placeholder="www99.your-server.de"`, and §5.1's test fails on it. WP2 owns the file: change the placeholder to `sftp.example.org`, or add the file to the allow-list.

### L5: the public gate bundle reveals "Reise"

The public gate bundle contains "bevor du die Reise sehen kannst" (§6.2.1). It is fetchable anonymously at `/_/assets/gate-*.js`, which is critique M1 ("she is away").

**Fix:**
- Use neutral copy ("…bevor du die Seite sehen kannst").
- Extend the §5.5 leak test with a small deny-list of generic words for the gate tree: Reise, reist, journey, travel, trip, unterwegs, sie/she as subject.
- Also drop the fallback file name `on-my-way-data.json` from the bundle (use `data.json`).

### L6: the orphan semantics after an API restore contradict themselves

§3.8.6 says devices that joined after the backup "keep working (orphans)". But `me/hello` with their unknown key answers `ended`, and the SPA navigates them to `/_/ended/` within ≤ 6 h. They also cannot resume.

**Fix:** state the real outcome (rejoin with a new link), or have the restore reconcile create placeholder follower rows (`name='(nach Wiederherstellung)'`) for orphan fids so the owner can re-approve.

### L7: the admin Home card lacks data

The card "Neues Gerät für {name} · {label} · vor {n} Min." with Allow/Decline needs device ids, names and labels. `AccessSummary` has only `pendingDevices: Count`.

**Fix:** add `pending: z.array({did, fid, name, label, createdAt}).max(3)` to `AccessSummary`, or specify that Home also queries `qk.access.followers`.

### L8: an API restore can lose fids, so D6 "never reused" breaks

The restore reconcile imports `t/<fid>` only as "revoke/erase", and only for fids it knows. Fids that exist only in `t/` or `s/` (created after the backup) get no DB row.

**Fix:** insert tombstone rows (`deleted_by='restore'`, or `state='revoked'` for `s/`-only fids) for every unknown fid in the listing, so creation retries skip them.

### L9: D4 "device limit"

**Fix:** add `access.max_active_devices` (default 5, owner-configurable; approving beyond it requires removing one), or record in §11 that per-device approval replaces a limit (an owner decision).

### L10: the privacy template overstates backup deletion

"Sicherungskopien werden nach höchstens 14 Tagen überschrieben" is wrong in two cases:
- `BACKUP_KEEP` is configurable;
- HOSTING §4 tells the owner to download `var/backups/` over SFTP regularly, and those copies live on.

**Fix:** fill the number from `BACKUP_KEEP` when seeding the draft, and add a runbook line: delete downloaded copies older than N days.

### L11: the post-deploy gate check is blind from the Mac while Hetzner blocks its IP

**Fix:**
- State in §5.6.3 that `error` does **not** fail the publish report.
- Make `ACCESS_GATE_PROBE` (P0b-6) the primary detector when it is available.
- When neither works, show "Gate-Prüfung nicht möglich" in the admin, so it is not silently absent.

### L12: the gate-mode content CSP keeps `worker-src 'self'`

The site registers no service worker today (only `frontend/admin` has `sw.ts`). A future site worker could serve cached data to a revoked device and bypass refusals.

**Fix:**
- Gate mode: `worker-src 'none'`.
- A `verify.ts` rule: no `serviceWorker.register` in the site bundle.
- One line in §3.10 on why. Clear-Site-Data "storage" would also unregister a worker, but only on a refused request.

### L13: no HSTS and no https redirect on the site host

The gate headers set neither. Add `Strict-Transport-Security` (with an `expr=%{HTTPS}=='on'` guard) and, in production, an http→https redirect as the first gate rule; it is uniform, so no oracle. This keeps the `Secure` cookies from being probed or overwritten over http in F1/F2.

### Nits

- **N1:** §3.6 lists `report?` in `AccessAck`, but the zod `AccessAck` has no `report`. Since the reconcile runs in the API, remove it from §3.6.
- **N2:** `Origin` regex: `siteAccessProblems` mentions `::1`, but the regex has no bracketed IPv6.
- **N3:** `{{STORE}}` goes into a `RewriteCond` TestString. Restrict `ACCESS_STORE_DIR` to `^/[A-Za-z0-9._/-]+$` so `%`/`$` cannot appear.
- **N4:** `device/poll` for an active device that already has a session is unspecified. Answer `active{handoff:'/'}`.
- **N5:** `known_device` could call `join {resume}` directly instead of `/` → neutral → resume.
- **N6:** WP2 adds the Dockerfile check for `dist/gate` before WP3 provides it. Move it to WP5 or guard it.
- **N7:** D11 says de **and** en. Require both in the notice regardless of `site.locales`.
- **N8:** D12 tombstone = "ID, deleted on <date>". The spec also keeps `created_at`, `kind` and `deleted_by`. Either justify (no personal data) or drop `created_at`.
- **N9:** `me/delete` "second call answers `deleted`" is impossible once `devices` rows are gone. Say `ended`.
- **N10:** Appendix A says "zwei Cookies". There are three today (`omw`, `omw_k`, `omw_h`), four with H1's fix.
- **N11:** Password change keeps `kind='app'` tokens, which have admin scope. The owner said "every other session is ended". Revoke app tokens too, or ask.
- **N12:** On macOS's case-insensitive filesystem, a sid with flipped case passes `-f` (verified: 200). The harness is therefore weaker than Linux production. Run `backend/test/gate` with a store on a case-sensitive volume (hdiutil image) or in Linux CI, and add the flipped-case case there.

Also worth stating (no change needed):
- `TRACE` is answered `200 message/http` (an echo) on gated paths. It is a server default, carries no content, and browsers cannot send it.
- Encoded-slash and NUL URLs get Apache's default 404 (236 B) before `.htaccess` runs. It is uniform and not personal.
- A `join/check` for a valid link tells the link holder whether the person already has a device (`deviceMustWait`).
- The `pub` 1200/h cap lets a flooder block joins (accepted DoS).
- `rl_salt` rotation resets windows at UTC midnight.
- WP0's "S, 2–3 days" is optimistic: it implements `nextReleaseSlot` with DST, time buckets, all of `access.ts` and the vectors. Plan 4–5 days.

---

## C. Local verification (127.0.0.1 only)

Everything is in `.cache/design-w5/review-probe/`, a copy of `apache-probe-w5/` plus my scripts. The author's folders are untouched, except `p0b/test/`, the scratch folder `localtest.sh` recreates.

### C.1 Reproduction
- `review-probe/run.sh` (the author's script, run in my copy) produced output byte-identical to `apache-probe-w5/logs/run-output.txt` (port normalised). See `review-probe/logs/run-original.txt`.
- `diff` of `apache-probe-w5/gate-block.in` against the §2.4.1 text: only placeholder spellings differ (`{{STORE}}` vs `__STORE__`), so the harness tests the spec's exact rules.
- `p0b/localtest.sh`: **13/13 pass**, re-run today.
- The author's harness uses a reduced content `.htaccess` (`apache-probe-rev/content.htaccess`), not the §2.4.3 file. My `review-probe/content-spec.in` follows §2.4.3, with `Referrer-Policy same-origin`, `X-Frame-Options`, `private` Cache-Control and `ErrorDocument 403`. All R-cases below use it.

### C.2 Extra cases (`review-probe/review.sh` → `logs/review-output.txt`)

| Case | Result |
|---|---|
| R1 headers and body: data 403 in the secret folder vs another folder (`/a1/data/x` vs `/a2/data/x`, `/zz…/media/…`), `.nope` in content vs elsewhere, `/a1/.htaccess` vs `/.htaccess`, pages and days with and without slash | **All identical** (status, headers minus Date, body hash). No header oracle from the content file's `Header always` lines. |
| R2 methods | OPTIONS and POST identical for a1/a2. TRACE is a 200 echo for both (no content). |
| R3 traversal into the public `/_/` prefix | `/_/../a1/data/…`, `/_/%2e%2e/…`, `/robots.txt/../…`, `/.well-known/acme-challenge/../../…`, `//a1/data/…` and `?x=/_/` all give 403 or the neutral page. `%2f` and `%00` give Apache's default 404. **No bypass.** |
| R4 duplicate cookies | The first `__Host-omw` in the header wins (M7). A prefixed name (`x__Host-omw`), a quoted value, or a session path that is a directory are all refused. |
| R5 the spec's handoff with no cookies at all | 303 + all three `Set-Cookie` headers (H1) |
| R6 content `.htaccess` + `RewriteOptions IgnoreInherit` / `Inherit` / `Require all granted` / `Options +Indexes` | still gated |
| R6 content `.htaccess` + `RewriteEngine Off` (also inside `<IfModule>`) | **fails open**, as the spec states |
| R7 a stray `de/.htaccess` with `RewriteEngine Off` | **fails open for that subtree** (`RewriteEngine On` there is harmless). Covered by "no other `.htaccess`" in verify, but not by gatecheck #1–#3. Accepted, because it needs SFTP access. |
| R8 locked + valid cookie | `/` → neutral; `/_/join/` still served |
| R9 follower headers under §2.4.3 | `private, no-cache` for HTML; `private, max-age=31536000, immutable` for media; refresh cookies only on pages |
| macOS flipped-case sid | accepted (N12) |

### C.3 Proposed handoff without URL secrets (`review-probe/review-v2.sh` → `logs/review-v2-output.txt`)

| Request | Result |
|---|---|
| `/_/h/` + Strict key cookie + `__Host-omw_s` + marker | 303 → `/<secret>/`; `__Host-omw` (HttpOnly, Lax), `__Host-omw_k`, `__Host-omw_s=; Max-Age=0`, `__Host-omw_h` |
| session cookie only, no key cookie (a cross-site navigation drops Strict cookies) | 303 → `/`, no cookies |
| no cookies / old 4-part URL / wrong sid / locked / marker gone | 303 → `/`, no cookies |
| follower page | rolling refresh unchanged |

No `httpd` or `php -S` from these runs is left running.

---

## D. Missing tests and acceptance criteria

Add to §8 and WP5:

1. **D12 authorisation matrix** (C1): PHPUnit, device state × follower state × endpoint; plus a site e2e where a pending device opens `/_/me/` and sees no follower data and no delete button.
2. **Handoff** (H1):
   - Apache harness: no-key-cookie refusal, cookie-sourced handoff, `__Host-omw_s` expiry;
   - site test: the gate page never puts sid or k into a URL (`location.replace` argument is `/_/h/`);
   - stack: the handoff URL from history plus a fresh context gives the neutral page even within 10 min.
3. **End-to-end store proof** (M4): gatecheck #4 (fresh service session accepted) and #5 (rotated one refused) after every gate deploy, and from the API cron when P0b-6 allows it. Stack variant with `ACCESS_STORE_MODE=none` (the Mac writer): revoke, ack, then the device is refused. Today's stack test runs only `direct`.
4. **Keep-green proof for WP0** (M1): the WP0 definition of done includes `scripts/composer test`, with the settings migration in place.
5. **Generator/verify** (M2): the real `contentHtaccess()` output passes `verifyHtaccess()`. The neutral page's CSP hashes equal sha256 of its inline script and style bytes, so a mismatch cannot silently break the resume script.
6. **Apache harness additions:**
   - data/media 403 across folders, which equals case A across folders (R1);
   - duplicate-cookie order (R4);
   - the traversal set (R3);
   - a stray subdirectory `.htaccess` (R7, expected fail-open, guarded by verify);
   - KK refresh on `/_/wait/` if L3 is adopted;
   - on a case-sensitive store volume (N12).
7. **Concurrency** (M8): 5 parallel `join` requests against `php -S` with a slow fake writer. None waits more than about 1 s for the lock; the ops are applied in id order.
8. **D11 next visit** (M5): stack step without clearing `helloAt`.
9. **Pending re-open** (M6): reopen the link 3× from a pending device; still one pending device.
10. **F1/F2 cookie strings** (M7): gate bundle unit tests per `cookieMode` (`Domain` present, deletion with `Domain`).
11. **Privacy of logs:** a test that app and cron logs never contain a follower name, link secret, key or sid (Monolog processor or grep in PHPUnit).
12. **Live acceptance checklist** (WP5, manual, with spaced requests from a non-blocked network such as the Brave Tor window):
    - (a) anonymous: a day URL gives the neutral page, a data URL gives 403, and their headers are equal;
    - (b) real phone join: iOS Safari, iOS tap from WhatsApp, Android Chrome from WhatsApp; record how many "devices" each path creates, because in-app browser jars may not be detectable by UA;
    - (c) revoke latency measured against the §3.10 claim for the chosen writer;
    - (d) lock/unlock;
    - (e) delete-me end to end;
    - (f) a restore drill on a copy (epoch rotation → `restoring` → reconcile).
13. **P0b kit additions:**
    - T4' cookie-sourced handoff (H1), keeping ≤ 13 requests (replace T4);
    - T11/T12 file-visibility latency (L1);
    - decision rows for `sodium`/`gmp`/`ssh2` (M3).
    - In `p0b.php`:
      - space the 13 server-side requests 5 s apart and split `step=site` into two calls, to stay under any FPM wall-clock limit. They come from the server's own IP and include a 403 and a 404, the pattern that triggered the host's block.
      - limit the docroot search in `step=env` to the account's own home: it climbs four levels and `scandir()`s them, which on a shared host can list other customers' folder names.

---

## E. Spec edits in order (for the author)

1. §3.4/§3.3: D12 authorisation rule (C1).
2. §2.3.2/§2.4.1/§2.4.2/§4.1/§6.2.1/§10: handoff without URL secrets (H1).
3. §9 WP0 and §3.2: split the migration (M1).
4. §2.4.3: drop the dotfile `FilesMatch` in gate mode (M2).
5. WP1: phpseclib acquisition step and the `SftpClient`-first order; §10.4 extension rows (M3).
6. §2.2/§3.8/§5.6.3: `storeId`, heartbeat `storeDir`, gatecheck #5, alert (M4).
7. §6.3: hello once per tab session or by notice version (M5).
8. §3.4: `pending_device` status (M6).
9. §4.1/§6.2: `cookieDomain` for F1/F2 (M7).
10. §3.8.3: `LOCK_NB`, drain loop, no DB transaction across I/O (M8).
11. §3.1/§10.4: an owner decision for the site-login fallback; key auth (M9).
12. §3.8.4/§3.8.5: lease checks; atomic reconcile enqueue (M10).
13. The Low and Nit items as convenient.
