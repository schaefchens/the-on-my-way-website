# Critique of the wave-5 proposal ("C-gate")

Skeptical review of `proposal.md`, 2026-11-20. Read-only on the repo. No live host was contacted
(`*.schaefchens.de`, `www99.your-server.de`), and `.env` and `.secrets/` were not opened.

**How the claims were checked**
- I read the proposal, the three notes, and the code the proposal cites.
- I ran the proposal's `.htaccess` rules on macOS's built-in **Apache 2.4.66**
  (`/usr/sbin/httpd`, 127.0.0.1 only, no Docker).
  - Re-run with `sh .cache/design-w5/apache-probe/run.sh`.
  - The files: `root.htaccess` holds the proposal's rules verbatim, `content.htaccess` is what
    `extras.ts` emits today, and `root-fixed.htaccess` holds the hardened rules from §2.
- Web checks are cited inline and listed in §5.

---

## 0. Verdict

**Keep C-gate.** It is the right mechanism for this owner and host:
- PHP stays off the media path.
- The invite secret sits in the fragment.
- The cookie is server-set, `HttpOnly` and `__Host-`.
- Revocation per person and per device works without the Mac.

The alternatives are weaker for the reasons the proposal gives. But the design as written has
four problems.

1. **It fails "zero information" today.** I verified this on Apache.
   - Anyone who knows the secret base path can list which **dates** have posts and which
     **trip slugs** exist.
   - The secret path leaks whenever a follower pastes a day link into a group chat.
2. **It has a silent fail-open path.** I verified this too. One `RewriteEngine On` in the
   content folder's `.htaccess` switches the whole gate off for all content.
3. **It over-claims on timing.** Release slots hide *when the site changes*, not *when she
   posts*.
   - Every entry still carries its exact time, and the player shows it.
   - Notes and stories carry a millisecond timestamp in their public id.
4. **Its safety defaults still leave an approved ex roughly a day behind her during any stay
   longer than a day.** They also route every edge case through the owner, who may be offline
   for days.

None of these needs a different mechanism. Each needs one of the changes below.

---

## 1. Findings, most severe first

Severity:
- **Critical** breaks an owner requirement or a stated safety claim, and I verified it.
- **High** is a likely real-world harm or an outage of a safety function.
- **Medium** is a weakening.
- **Low** is a polish item.

### C1. Existence oracle: dates and trips can be listed without access (zero information broken)

**Problem.** Proposal §3.2 says "Apache refuses every non-public path *before* looking at the
requested file" (proposal.md:135). Apache does not work that way:
- **Directory walk before rewriting.** Apache maps the URL to the filesystem and runs mod_dir and
  the authz phase before per-directory mod_rewrite runs (in the fixup phase).
- **DirectorySlash.** mod_rewrite ignores URLs that map to an existing directory without a
  trailing slash, so mod_dir answers with a redirect. This is documented under
  `RewriteOptions AllowNoSlash` (§5).
- **Dotfile deny.** The generated `<FilesMatch "^\.">` deny (`extras.ts`) only fires inside
  existing directories.

**Evidence** (anonymous requests, proposal rules, `run.sh` case A):

| Request (no cookie) | Answer |
|---|---|
| `/s3cr3t/de/day/2026-11-18` (day exists) | **301** → `…/2026-11-18/` |
| `/s3cr3t/de/day/2026-11-19` (no posts) | 200 welcome |
| `/s3cr3t/de/trip/vietnam-2026` (trip exists) | **301** |
| `/s3cr3t/de/trip/thailand-2026` | 200 welcome |
| `/s3cr3t/de/day/2026-11-18/.x` | **403** |
| `/s3cr3t/de/day/2026-11-19/.x` | 200 welcome |

**Why it matters.** Someone who once saw a day link (`/<secret>/de/day/…`) can:
- test every date and learn on which days she posted, which is her activity pattern;
- see when the newest day appears, at slot granularity;
- confirm guessed trip slugs.

The proposal's own UX expects followers to share day links in groups (neutral previews, §3.2).
So the secret path is not a secret in practice.

**Change** (tested, `run.sh` case C):
- Add `DirectorySlash Off` and `RewriteOptions AllowNoSlash` at the root.
- Add a root `RewriteRule (?:^|/)\. - [F,L]` right after the ACME exemption, so every dot
  segment gets the same 403 whether or not the directory exists.
- Restore the slash redirect only for valid sessions (§2).
- Add a leak test to the Apache e2e: for pairs of existing and non-existing day, trip, story and
  dotfile paths, the anonymous answer (status, headers, body) must be byte-identical.
- Correct the claim on proposal.md:135 and the timing claim on :226. The directory walk does
  `stat()` the path and parse `.htaccess` files in directories that exist. That is
  microseconds and probably not measurable remotely, but it is not "doesn't depend".

**Cost:** S.

### C2. Silent fail-open: a content `.htaccess` with any rewrite directive disables the gate

**Problem.** The content moves to `/<secret>/` and keeps its own generated `.htaccess` (cache
headers, `ErrorDocument`, dotfile deny). In per-directory context, mod_rewrite does **not**
merge a parent's rules into a child that has its own rewrite configuration: "mod_rewrite
overrides rules when merging sections" (mod_rewrite docs, §5). Today's content `.htaccess` has
no rewrite directive, so the gate works by luck.

**Evidence** (`run.sh` case B): append a single `RewriteEngine On` to the content `.htaccess`,
and `GET /s3cr3t/data/manifest.json` with no cookie returns **200 and the content**. The same
happens for pages and media.

**Second window.** `.htaccess` changes "on every build" (`extras.ts`). `sftp.ts:349` falls back to
**delete + rename** when the server lacks `posix-rename@openssh.com`, which leaves a brief window
with no `.htaccess` at all.

**Change:**
- Add `RewriteOptions InheritDownBefore` (Apache ≥ 2.4.8) to the root rules. Case C shows that
  it closes the bypass.
- Add a generator test: the content `.htaccess` must never contain `Rewrite*` and never
  `IgnoreInherit`, because `IgnoreInherit` in a child cancels `InheritDownBefore`.
- Emit the gate block in **both** files: the root one and the content one. Then replacing one
  file never leaves the content open. The probe in §6.3 #5 must probe a deep content path, which
  it already does.
- The publisher refuses `access: gate` on a target without atomic replace. The publisher's
  "Test" already reports `atomic replace: yes/no` (`index.ts:538`).

**Cost:** S.

### C3. Posting times are not hidden: exact times in data and UI, and timestamps in post ids

**Problem.** The proposal says release slots hide "when exactly she posts" (proposal.md:597).
Its own table on :103 says exact times stay until P3, and it calls that "±12 h". That is
inconsistent: with exact times in the data, followers know the posting time to the second.
- Every `Entry.at` is the real `occurredAt` (`site.ts` `EntryBase.at`, `model.ts:174` for captures, `:218` for posts).
- `DaySummary.firstAt`/`lastAt` give the start and end of her day (`model.ts:454-455`).
- The UI **shows** clock times: `filmstrip.tsx:86` and `player/items.ts:47` call
  `formatTime(entry.at, …)`.
- **New finding:** note and story ids are client-made ULIDs, `p_` + a 10-character
  **millisecond timestamp** + random (`frontend/admin/src/api/client.ts:262`). They appear in
  day JSON, story URLs and shared links. They expose the moment the owner wrote the post, even
  after P3 coarsens `at`.

For an approved ex, this is the pattern-of-life data the proposal lists as a threat:
- when she wakes up;
- when she is back at the hostel;
- yesterday's exact timeline in a place where she probably still is.

**Change:**
- Move time coarsening into **P0**. The generator buckets `at` into 3-hour slots for every day
  (keep the order with +1 s offsets), and `firstAt`/`lastAt` come from the buckets.
  - The contract shape stays the same, so no `contractVersion` bump is needed.
  - Add a tiny additive flag so the UI shows "morning / afternoon / evening" instead of a fake
    "15:00".
- Publish posts under a hashed id, as captures already are (`e_` = base32(sha256(sourceKey))),
  for example `p_` + base32(sha256(ULID))[0..16].
  - There is no real content yet, so the URL change costs nothing now.
- Rewrite the D1 rationale honestly: slots hide when the site *changes*; bucketing hides when
  she *posts*.

**Cost:** S–M (generator + UI + vectors).

### H1. The defaults don't protect a stay longer than the delay, and captions defeat any delay

**Problem.** "Country only for the newest place" removes one label. During a 3-night stay the
follower still gets, about 24 h late, everything that names the place:
- photos and videos of the hostel;
- verbatim captions;
- text statuses;
- voice notes;
- owner-written day titles and summaries;
- the IANA `tz`, which narrows the region in multi-zone countries.

Captions that announce plans ("tomorrow Hanoi!", "flight at 7") are worse. A 24 h delay turns
them into "today she flies to Hanoi". The proposal admits this ("Does not: the photos
themselves") but leaves the only real fix, the departure gate, in P3 (M–L). Owner review is
passive in `delayed` mode: items release by themselves.

**Change:**
- Make the departure gate the default for the **media and text of the newest place**: a place
  goes live once a later place is public, capped at 7 days, as proposed.
  - Move it to P0/P1.
  - The data model already has per-day `placeName`, so "moved on" is "a later public day has
    another place".
  - Days without a place fall back to the cap.
- Add **auto-hold** for captions and text statuses matching plan or venue words
  (de/en/ar lists: morgen, tomorrow, heute Abend, flight/Flug, Gate, hostel/hotel, Zimmer/room,
  check-in, "heading to", "bis …").
  - Held items go to review with a push to the owner instead of auto-release.
  - Voice notes can't be scanned. Say so in the admin.
- Release slots batch **all additions**, including owner edits to day and trip text, the
  greeting and trip titles. **Removals** (hide, revoke, lock) stay immediate.
  - Today owner text edits to already public days skip any delay.

**Cost:** M (moves from P3; the policy has to be mirrored in PHP with vectors).

### H2. The portrait skips the delay and even "hidden"

**Problem.** `avatarFor()` (`model.ts:254-271`) accepts any **ready** photo capture. It checks
only `on_revoke`. It ignores whether the capture is pending (delayed or review) or hidden by the
owner. The comment at `model.ts:500-501` says so: the portrait "may add the small variants of a photo
that is not public itself". The natural choice of portrait is today's selfie, so its background
goes to every follower at the next publish, ignoring the 24 h delay.

**Change:**
- Allow only captures whose effective visibility is `public`.
- Or keep publishing the previous portrait until the new one's capture is public.
- Show an admin hint on the portrait picker.

**Cost:** S.

### H3. Restoring a backup can bring back revoked access

**Problem 1: API database restore.** The owner restores the API database per HOSTING §8.
- The snapshot `version` "only goes up" (anti-replay). After a restore it starts lower, so the
  gate **rejects every later snapshot as a replay**: revocations made after the restore never
  arrive.
- Revoked followers and unused invites in the restored database are active again.

**Problem 2: webspace restore.** Hetzner can restore the site webspace from its backups.
- That brings back the **session files of revoked devices**.
- It drops or brings back the `locked` flag.
- Device sessions are "gate primary" (§3.3), so nothing removes the revived files.

**Change:**
- Make the version `(epoch, counter)`. The epoch rotates on restore, just like `feed_id`
  (`rotateFeedId`), and the gate accepts a new epoch only with a fresh HMAC.
- The gate keeps **tombstones** for revoked follower ids, so a snapshot cannot re-add a
  tombstoned id. A re-invite creates a new id.
- The snapshot lists **all valid session ids**. The repair push deletes any session file it
  does not list, with a grace period for joins younger than the last push.
- The lock flag lives in the snapshot and is re-asserted every 5 minutes.
- Add a runbook line in HOSTING §8: "after a restore, review People".

**Cost:** S–M.

### H4. "Mac not needed" and "1–2 s" rest on unverified capabilities and one shared server

**Problem.**
- **Outbound HTTPS.** Revocation, lock, the 5-minute repair and the gate→API relay all need
  PHP to make outbound HTTPS calls. That is unverified (P0b). Without it, revocation needs the
  Mac.
- **One server.** The site and the API are on the **same server**: the publisher
  (`hostkeys.ts:14`) and `deploy-api.ts` (HOSTING.md:42) both pin `www99.your-server.de`.
  - HOSTING §10 records an IP block that cut HTTPS "to every site on that server".
  - The "API down / site up" rows in §3.3 only hold for app-level failures.
- **One PHP pool.** The panic link, joins and the public request form share the site's 2–5
  PHP-FPM workers. A slow-POST flood on `op=request` can make the **panic link unavailable**
  exactly when it is needed.

**Change:**
- Add **phone-relayed sync** as the fallback, or even the primary path:
  1. The API returns the HMAC-signed snapshot to the admin PWA.
  2. The phone POSTs it to `https://<site>/_/gate.php?op=sync` (CORS for that one op).
  3. The gate verifies the HMAC. The phone cannot forge a snapshot.

  This keeps "Mac not needed" true without server-to-server HTTPS.
- In `gate.php`, reject `request`/`form` ops early, before reading the body, using a file
  counter, a small `post_max_size`, `max_execution_time` 5 and a global per-minute cap.
- Document the Mac's SFTP lock as the path that also works when site PHP is saturated. Port 22
  stayed open during the observed block.
- P0b must answer, **before P1's design is frozen**:
  - outbound HTTPS;
  - pool separation between site and API;
  - `DirectorySlash` and `RewriteOptions` allowed in `.htaccess` (AllowOverride);
  - `posix-rename` on the SFTP server.

**Cost:** S–M.

### H5. Usability: every edge case lands on the owner, and the proposal's own copy contradicts itself

**Problem.**
- **Cookie jars are fragmented, and each one counts as a device.**
  - iOS home-screen web apps don't share storage with Safari (WebKit bug 181849, §5).
  - WhatsApp is preparing an opt-in in-app browser for iPhone with its own cookies (9to5Mac,
    2026-10-19, §5).
  - Browsers like DuckDuckGo wipe cookies on exit.

  So Oma's iPhone Safari, her home-screen icon and her iPad can already use up the limit of 3.
- **Contradictory copy.** S1 tells people "Öffne deinen persönlichen Link noch einmal". In any
  new cookie jar that leads straight into "Dieser Link wurde schon benutzt" (S3 and step 7),
  then to a request, then to the owner.
- **The root shows the request page to followers.** In the proposal's rules, a valid follower
  who opens `/` (a bookmark, the bare hostname, the old test URL) gets the **"request access"
  page**. Verified: `run.sh` case A, follower `/` → 200 welcome.
- **Owner offline.** Re-confirming a device, a lost phone and a new link all wait for the owner.
  She may be trekking without signal for days.
- **The add-device code is hard for grandparents.** The 15-minute code has to be moved from one
  device to the other.

**Change:**
- **Re-openable personal link.**
  - On a device that already has a session for that follower, the link just opens the journey.
    `gate.php` can see the cookie on the join POST.
  - On a new device it adds the device without asking while there is room under the limit and
    within a **join window** (48 h after first use).
  - After that, the device needs the owner's OK or a code.
  - Raise the limit to 4–5 "browser contexts".
- **Root redirect for session holders.** Valid sessions get `/` → 302 into the journey (tested,
  §2). Then bookmarks and home-screen icons survive a rotation of the secret path.
- **Join page names the owner of the link.** "Dieser Link ist für **Oma**. Bist du Oma?
  [Ja, öffnen] [Nein → eigenen Zugang anfragen]". Honest forwarders sort themselves out, and
  most forwarding is honest family.
- **QR code** on the first device for adding a device. Typing a 6-digit code is the fallback.
- **"Sign out on this device"** goes into a menu, behind a confirmation.
- **A co-admin with narrow rights** (a parent at home): approve devices and send links; cannot
  unlock, export or change safety settings. This covers the owner being offline. It could join
  the decision on D6.

**Cost:** M.

### H6. Revoke and lock must not ride the admin's offline write queue

**Problem.** Admin writes are "offline-resumable", replay "strictly in the order they were
made", and a 401 goes to an outbox "replayed after the next login" (`writes.ts:1-16`).
- A revoke queued behind a stuck 409 conflict, or behind a re-login, is not in effect.
- An optimistic update would show the person as removed.

The proposal's "In effect ✓ after the gate confirms" is right, but the queue is not mentioned.

**Change:**
- Revoke, remove device, lock and approve run on a **separate, immediate path**: never queued,
  idempotent, with an explicit "not yet in effect" state.
- When the request cannot go out, the screen offers the panic link.
- Generate invite secrets **on the phone** (WebCrypto) and send only the hash. A dropped
  response then never loses a link. "Share" stays disabled until the gate confirms the link is
  active.
- Re-login for approve becomes a 10-minute step-up window, so one bad connection does not mean
  one password entry per approval.

**Cost:** S–M.

### M1. The public pages still leak gender, name and "she is away"

**Problem.** The proposal's own public copy breaks requirement 3:
- S2 asks "Woher kennst du **sie**?" and answers "Wenn **sie** dich kennt…" (proposal.md:427,
  434). That tells everyone the traveler is female, which is exactly what a stalker wants to
  confirm.
- §3.3 step 1 uses "How do you know **Lea**?" and step 2 "If **Lea** knows you…". That is the
  name, while the first name is meant to be opt-in.
- S1 shows a plane and a dotted route under "Eine private Reise", and the hostname is
  `the-on-my-way-website.schaefchens.de` (in CT logs). Together they say: someone connected to
  this domain is away.
- The "Datenschutz" footer on S1 names the controller (owner) to *every* visitor, not only to
  people who fill in the form.

**Change:**
- Gender-neutral, name-free copy unless the opt-in is on:
  - "Woher kennt ihr euch?" / "How do you know each other?"
  - "Wenn ihr euch kennt, bekommst du einen persönlichen Link."
- Neutral design and title: "Privat · nur mit Einladung", with no travel motif.
- A neutral production hostname **before** real use.
- The privacy notice opens from inside the request sheet. Art. 13 applies "at the time when
  personal data are obtained".
- Raise the controller-name question to an owner decision (D7 in §4) instead of a footnote.

**Cost:** S.

### M2. The request form is an anonymous harassment and notification channel

**Problem.**
- **Free-text "Nachricht".** Anyone, behind rotating IPs, can send up to the global cap (20 a
  day) of abusive texts.
- **One push per request.** Each request triggers a push "🌸 New request". That is up to 20
  notifications a day the attacker controls.
- **Fake "already had access" requests.** "It's Oma, new phone, please resend" is the classic
  pretext. If D4 b/c is chosen, the link would go to the address the attacker typed in.

**Change:**
- No free-text field, or ≤ 140 characters, shown collapsed in the admin ("Text anzeigen").
- Request notifications only as a **daily digest**. Requests are not urgent.
- A request that claims an existing person shows a banner: "Behauptet, Oma zu sein. Ruf Oma an.
  Der neue Link geht nur an Omas bekannte Nummer." A re-issued link never goes to the contact
  typed into the form.
- An owner switch "Anfrageformular aus": the page then says "Frag die Familie nach deinem Link."
  - This also removes most of the GDPR tension, because no strangers' data is collected.
  - It strengthens the household-exemption argument.

**Cost:** S.

### M3. Push texts carry follower names through ntfy

**Problem.**
- The default `NTFY_SERVER` is `https://ntfy.sh` (HOSTING §5).
- An unreserved topic can be read by anyone who knows its name.
- The proposal's device notes contain labels: "Oma: new device, iPad · Safari", "Neues Gerät bei
  Oma".

**Change:**
- Push texts carry no names and no labels: "📱 1 neues Gerät · im Admin ansehen".
- The admin warns when `alerts.ntfy_url` is on ntfy.sh without `NTFY_TOKEN`.

**Cost:** S.

### M4. The ex who is also a WhatsApp contact: where the site is weaker than WhatsApp

**Where each channel is stronger.**
- **WhatsApp** is the live channel, and the site cannot fix it.
- **The site** is weaker in three ways:
  - **persistence**: statuses vanish after 24 h, the site keeps everything;
  - **aggregation**: the whole history, browsable as machine-readable JSON;
  - **visibility of watchers**: WhatsApp shows her who viewed a status; on the site only the
    owner sees a 6-hour "last seen".

**Audience flattening.** The observer number **merges her per-status audiences**: any status the
observer can see goes to *all* followers. She may change her status audience at any time, for
example "Only share with…", and the observer cannot tell which audience a status had. The notes
do not mention this.

**Change:**
- Add a rule to the traveler checklist: "Whatever the observer number can see goes to everyone
  on the site. Keep it out of narrow audiences."
- "Zugang beenden" ends with a reminder: "Also hide your WhatsApp status from him: Settings →
  Privacy → Status → My contacts except…".
- The traveler's own login (D6) gets the same reminder.

**Cost:** S.

### M5. Forwarding detection relies only on the user agent

**Problem.** "Oma: new device, iPhone · Safari" looks the same for Oma and for the man she
forwarded the link to.

**Change:**
- Add a "same network as Oma's other devices: yes/no" hint: a keyed hash of the /24 (IPv4) or
  /48 (IPv6) prefix, kept 30 days, never the IP itself.
- Add the join-page self-check from H5.

**Cost:** S.

### M6. 403 bursts may trigger the host's IP block, which also blocks the admin

**Problem.** HOSTING §10 records an IP block after about 25 rapid 4xx requests, which cut HTTPS
to every site on the server for at least 3 h. A lock or a revocation makes every open follower
tab fire a burst of 403s: the `<img>`/`srcset` and covers already in the DOM load before the SPA
reacts.
- A family behind one router can be blocked.
- If the owner shares that Wi-Fi, the owner loses the **admin** during an incident.

**Change:**
- Add the block's trigger to P0b. Ask Hetzner support.
- Test lock with 3 tabs open on the Apache e2e.
- If the trigger counts 4xx responses, answer gated data and media with a fixed neutral 200
  `no-store` body instead of 403. The SPA then treats "not JSON" as `AccessEnded`.

**Cost:** S.

### M7. Effort and buildability gaps

**Gaps the proposal does not cover.**
- **Two trees, one remote root.** A publish target has a single `remoteRoot` (`types.ts:88`).
  `phaseOf()` (`plan.ts:27`) and `isGeneratorPath()` (`output.ts:179`) assume paths relative to
  the content root (`media/`, `data/`, `<locale>/`).
  - The gate files, the welcome page and the root `.htaccess` live *above* `/<secret>/`.
  - So either targets get two roots, or OUT_DIR gains a prefix layer and the phase and
    ownership logic must handle it.
  - The proposal lists only "output.ts (`_/` paths)".
- **The mass-delete guard blocks the move.** Moving the live test content from `/` to
  `/<secret>/` deletes more than half of the deployed files, so the guard refuses
  (`deploy.ts:103-118`). Plan a one-off `--force` or a fresh target, plus the ordering: gate
  first, then upload, then delete the old root.
- **Losing `.omw-access/` is a mass support event.** If the folder is deleted by hand or lost,
  every follower needs a new link. With H3's API-held session list the gate can rebuild it.

**Sizes.**
- P0 grows by C3, H1 and H2: **M → L−**.
- P1 includes the security-critical `gate.php` and its tests, sync with HMAC, epochs and
  tombstones, two admin screens, the generator and publisher rework above, the welcome bundle as
  its own Vite entry, de/en/ar strings, and e2e. Realistically **4–6 weeks (L+)**, not "L".
- Split P1 so the site can go live sooner:
  - **P1a:** gate, People (invite, revoke), lock, publisher checks.
  - **P1b:** panic link, add-device QR, Mac lock button, anomaly hints.

**Test cost is lower than claimed.** The rules need no Docker container: macOS ships Apache
2.4.66 at `/usr/sbin/httpd`. `run.sh` starts it on 127.0.0.1 with a generated config. This
matters because the Docker disk is full (README).

### Low

- **L1. Clear-Site-Data.**
  - The open question is answered: Safari and iOS Safari support `cache`, `cookies` and
    `storage` from **17** (MDN BCD, §5).
  - Chrome's `cache` is marked partial, with "may cause seconds-long hangs".
  - It needs no PHP: Apache can set it from an env var when a cookie is present but invalid
    (tested, §2).
  - Also expire the stale cookie with a `Set-Cookie: __Host-omw=; Max-Age=0; …` added by
    `mod_headers`, so the clear doesn't repeat on every request.
  - Leaving out `"cookies"` is correct: MDN says it clears "the entire registered domain,
    including subdomains".
- **L2. The secret base path is oversold.**
  - It leaks with every shared day link, so it only stops hostname-only scanners.
  - Rotating it breaks the followers' home-screen `start_url`. H5's root redirect softens that.
  - Keep it, but call it what it is.
- **L3. `tz` under "country only".** For multi-zone countries (US, AU, BR, ID, RU), the IANA
  zone of the newest days narrows the region. Map it to one zone per country for the newest
  place, or render times on the server.
- **L4. Screenshots.** Media watermarks are rightly rejected. A cheap deterrent is a small
  per-follower label in the player chrome ("💌 für Oma"), which ends up in most screenshots.
  Cropping defeats it. Say so.
- **L5. Who reads messages to "Lea".** If owner ≠ traveler, the sheet should say who reads
  them ("Lea und <Owner>"). That is both transparency and trust.
- **L6. D4 b (e-mail invites).** Mail security scanners that pre-open links can burn
  single-use links. That is one more reason against b.

---

## 2. Hardened gate rules (tested on Apache 2.4.66)

`apache-probe/root-fixed.htaccess`, with `/s3cr3t/` standing in for the secret base path. To
be verified on Hetzner in P0b: AllowOverride must permit `DirectorySlash` and `RewriteOptions`.

```apache
RewriteEngine On
RewriteOptions InheritDownBefore AllowNoSlash        # C2: children can't drop the gate; C1: no 301 oracle
DirectorySlash Off                                   # C1
ErrorDocument 403 /_/403.txt
RewriteRule ^\.well-known/acme-challenge/ - [L]
RewriteRule (?:^|/)\. - [F,L]                        # C1: same 403 for every dot segment, existing or not
RewriteRule ^(?:_/|assets/|robots\.txt$|favicon\.|apple-touch-icon) - [L]
RewriteCond %{DOCUMENT_ROOT}/.omw-access/locked !-f
RewriteCond %{HTTP_COOKIE} (?:^|;\s*)__Host-omw=([a-z0-9]{12})\.([A-Za-z0-9_-]{43})(?:;|$)
RewriteCond %{DOCUMENT_ROOT}/.omw-access/f/%1/%2 -f
RewriteRule ^ - [E=OMW_OK:1]
RewriteCond %{ENV:OMW_OK} =1                         # followers only: trailing-slash redirect
RewriteCond %{REQUEST_FILENAME} -d
RewriteRule [^/]$ %{REQUEST_URI}/ [R=301,L]
RewriteCond %{ENV:OMW_OK} =1                         # H5: "/" opens the journey, not the request page
RewriteRule ^$ /s3cr3t/ [R=302,L]
RewriteCond %{ENV:OMW_OK} =1
RewriteRule ^ - [L]
RewriteCond %{HTTP_COOKIE} __Host-omw=               # stale or revoked cookie
RewriteRule ^ - [E=OMW_STALE:1]
RewriteRule (?:^|/)(?:data|media)/ - [F,L]
RewriteRule ^ /_/welcome/index.html [END]
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=OMW_STALE
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=REDIRECT_OMW_STALE
```

**Result** (`run.sh` case C, where the content `.htaccess` even contains `RewriteEngine On`):
- Anonymous requests to existing and missing days and trips get identical 200 welcome responses
  (same headers and size).
- Dot paths get an identical 403 everywhere.
- Data gets 403.
- A follower opening `/` gets a 302 into the journey.
- A stale cookie gets `Clear-Site-Data`.
- The lock flag gives 403 to everyone.

Also verified on 2.4.66:
- the cookie backreference inside `-f`;
- `END`;
- `%{DOCUMENT_ROOT}` under `mod_vhost_alias` `VirtualDocumentRoot` (correct in 2.4.66; Hetzner's
  setup still needs the probe).

---

## 3. Claims checked that hold up

| Claim | Check |
|---|---|
| Media never through PHP; `Range`/`ETag` native | Rules pass through with `-`; Apache serves natively |
| Secret in the `#` fragment, so preview fetchers can't use up invites | Correct: fragments are never sent |
| `CO` cannot set `__Host-` cookies | Apache flags docs: `CO` requires a domain |
| `Clear-Site-Data: "cookies"` would log the owner out of the admin | MDN: it affects the entire registered domain |
| Manifest is not bumped by captures that aren't public yet | `generate.ts` step 4: nothing is written without a public change. No "she just posted" leak through the manifest |
| GPS/EXIF and video `creation_time` stripped | `image.ts` (sharp default), `video.ts:66` `-map_metadata -1`, `voice.ts:111` |
| Capture ids reveal nothing | `e_` + base32(sha256(sourceKey)). Post ids do leak a timestamp, see C3 |
| `lat`/`lng`, trip `end` and `og:image` can be dropped without a contract bump | They are optional, except `TripSummary.end`, which is required: emit min(planned end, last public day) plus an additive "ongoing" flag for the "since 3 Nov" label |

---

## 4. Decisions for the owner that remain open (additions to D1–D6)

The question of public vs approval stays settled. Two new questions, plus one change to D3:

- **D7. Request form and privacy notice.**
  - a) Form on. The privacy notice inside the form names you (not Lea) as controller.
  - b) **No form (recommended).** The page says "Frag die Familie nach deinem Link". No
    strangers' data is collected, and the household exemption is easier to argue.
  - Have a lawyer check either option.
- **D8. Who covers when you are offline?**
  - a) Nobody: new devices wait for you.
  - b) **A co-admin with narrow rights (recommended):** approves devices and sends links; cannot
    unlock or export.
- **D3 revised:** "the link opens on up to 4 of that person's devices within 48 h of first use,
  then only with a code or your OK" (recommended), instead of "opens once".

---

## 5. Sources

- Apache mod_rewrite, `RewriteOptions` (`InheritDownBefore`, `AllowNoSlash`, "overrides rules
  when merging sections"): https://httpd.apache.org/docs/2.4/mod/mod_rewrite.html
- Apache rewrite flags (`CO` requires a domain, `END`): https://httpd.apache.org/docs/2.4/rewrite/flags.html
- MDN Clear-Site-Data (scope: `cache`/`storage` per origin, `cookies` per registered domain):
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data
- MDN browser-compat-data for Clear-Site-Data (Safari 17; Chrome `cache` partial, "seconds-long
  hangs"): https://github.com/mdn/browser-compat-data/blob/main/http/headers/Clear-Site-Data.json
- WebKit bug 181849, home-screen apps don't share storage with Safari: https://bugs.webkit.org/show_bug.cgi?id=181849
- 9to5Mac, WhatsApp's opt-in in-app browser for all links on iPhone (2026-10-19, not yet
  released): https://9to5mac.com/2026/10/19/whatsapp-may-soon-let-iphone-users-open-any-link-in-an-in-app-browser/
- Repo evidence: `frontend/admin/src/api/client.ts:262`, `backend/src/generator/model.ts:254-271,
  454-455`, `frontend/site/src/timeline/filmstrip.tsx:86`, `frontend/site/src/player/items.ts:47`,
  `backend/src/publisher/sftp.ts:349`, `plan.ts:27`, `deploy.ts:103-118`, `types.ts:88`,
  `output.ts:179`, `frontend/admin/src/api/writes.ts:1-16`, `backend/src/publisher/hostkeys.ts:14`,
  `docs/HOSTING.md` §5, §8, §10.
- Local probe: `.cache/design-w5/apache-probe/run.sh` (Apache 2.4.66, 127.0.0.1:18089).
