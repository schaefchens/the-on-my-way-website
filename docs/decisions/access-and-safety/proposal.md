# Wave 5 proposal: approval-only followers, revocation, contact

Status: **revised proposal for owner review**, 2026-11-20, second version. Inputs:

- the research notes in this folder: `threats.md` (threat model, prior art, safety levers),
  `access.md` (access-control options on Hetzner) and `contact.md` (contact form, abuse, GDPR).
  They hold the full evidence and sources.
- `critique.md`, a skeptical review of the first version, with Apache probes in `apache-probe/`.
- follow-up probes made for this revision in `apache-probe-rev/` (`sh run.sh`). They use macOS's
  built-in Apache 2.4.66 on 127.0.0.1 only and contact no live host.

Appendix A lists every critique point and what happened to it. Appendix B lists the probe
results.

The **owner decision of 2026-11-20** applies throughout:

- **Approval-only followers.** There is no public layer and no hybrid.
- **Per-person revocation** from the admin PWA.
- **Zero information without access.**

Where the notes recommend something else, this proposal overrides them: the public teaser, a
contact form open to everyone, a secret link as the main guard, and the "followers-only vs hybrid"
question.

**What changed since the first version**
- The gate rules are rewritten. The first version let anyone list existing dates and trips, and
  a single stray line in a generated file could switch the gate off. Both are fixed and tested.
- The session store moves out of the web root.
- Posting times are coarsened in P0, and post ids no longer carry a timestamp.
- By default, days at a place stay hidden until Lea has moved on.
- The personal link can be reopened on the same person's devices.
- The sync between API and website survives backup restores and works without the Mac and
  without server-to-server HTTPS.
- The public copy is neutral.
- Effort estimates are realistic now, and P1 is split into P1a and P1b.

"Lea" stands for the traveler's first name, "Oma" for an example follower. Effort scale (one
developer, tests included):

| Size | Effort |
|---|---|
| **S** | ≤ 2 days |
| **M** | 3–7 days |
| **L** | 2–4 weeks |
| **L+** | 4–6 weeks |

---

## 1. Summary for the owner

1. **Only people you approve can open the site.** Everyone else, at every address, gets the same
   plain "Private · invitation only" page with a "request access" button. It names nobody and
   shows no photo, place, date or travel motif. Link previews show only the same.
2. **Each person gets their own personal link,** which you send from your phone.
   - In the first 2 days, the link opens on up to 4 of that person's phones and tablets.
   - After that, a new device needs a QR code from one of their own devices, or your OK.
   - You see every device. A short note, without names, tells you about each new one.
3. **You can end one person's access, or remove one device, at any time.**
   - It takes effect within about 1–2 seconds of your phone reaching the website.
   - They keep only what they had already seen or saved.
4. **Safety defaults also apply to approved people,** because an approved person can still turn
   against Lea:
   - posts appear about a day later, in two batches a day;
   - days at a place stay hidden until she has moved on (at most 7 days);
   - times show only as "morning" or "evening";
   - there is no "here now" badge;
   - captions that mention plans or her hotel wait for your OK.

   A "lock everything" switch and a panic link for Lea work even when your Mac is off.
5. **Followers get an obvious "Write to Lea" button.** Strangers can only ask for access. You read
   everything in the admin, and nothing is ever sent back automatically.
6. **Time to build:** about 7–10 weeks of work before real travel content may go online (phases
   P0, P0b, P1a and P1b).

---

## 2. Threat model in brief

### 2.1 What the site reveals today (found in the code)

Anyone with the URL gets everything today. The HTML inlines each day's data, so protecting only
the JSON or the media would not be enough (access §1).

| # | What leaks today | Where | Why it matters |
|---|---|---|---|
| E1 | Instant publishing is the default: a status is on the site about 1 min after posting | `packages/contracts/src/api.ts` (`publish.mode`) | Shows where she is now |
| E2 | A "Now in <place> · 12 min ago" chip pulses for 48 h | `frontend/site/src/components/decor.tsx`, `site-header.tsx` | An explicit live-location signal |
| E3 | Exact time of every moment (`Entry.at`) and the first and last time per day (`firstAt`/`lastAt`). The site **shows** clock times | `backend/src/generator/model.ts` (`captureEntry`, `postEntry`, day summaries); `frontend/site/src/timeline/filmstrip.tsx:86`, `player/items.ts` | Her daily rhythm: when she wakes up, when she is back at the hostel |
| E4 | Exact `lat`/`lng` in the day files, never displayed | `model.ts` day body | Can be the hostel's exact location |
| E5 | Place and country of the newest day, in JSON and in pre-rendered HTML | `pages.ts` | Readable without JavaScript |
| E6 | Photos, videos and voice notes show venues, signs, room numbers and key cards | pipeline | GPS is stripped, but the picture isn't. AI tools geolocate photos in seconds (threats [C2]) |
| E7 | Name, greeting and portrait (wave 4) on home, in `<meta name="author">` and in the language picker's `<title>` | `pages.ts`, `twin.ts` | Recognition in person; face search |
| E8 | A trip's planned end date (her return date) | `model.ts` trip summaries | Someone can wait for her on arrival; her home is empty until then |
| E9 | Plain JSON at predictable paths. `manifest.json` can be polled at any rate | `site.ts`, `frontend/site/src/config.ts` | "She just posted" alerts and scraping take a few lines of code |
| E10 | The home link preview (`og:image`) is her newest photo | `pages.ts` | A pasted link shows the photo to a whole group chat |
| E11 | The hostname is in Certificate Transparency logs, and `noindex` only keeps polite crawlers away. The name itself says "on my way" | `docs/HOSTING.md` | The site can be found, and its name says someone is travelling |
| E12 | Switching the publish mode never unpublishes anything | `policy.ts` | No fast way back in an emergency |
| E13 | Owner notes and stories skip the delay. Owner edits to the text of days that are already public skip it too | `policy.ts` | "Just checked into the cutest hostel" goes out at once |
| E15 | No record of who looks (WhatsApp shows her who viewed a status) | – | She can't notice a watcher |
| **E16** | Note and story ids are `p_` + ULID. A ULID starts with a **millisecond timestamp**, and these ids appear in day JSON, story URLs and shared links | `frontend/admin/src/api/client.ts` (`newPostPublicId`) | The exact moment the owner wrote a post, even after times are coarsened |
| **E17** | The portrait may come from a photo that is still pending (delayed or in review) or hidden | `model.ts` `avatarFor()` checks only `state === 'ready'` and `on_revoke` | Today's selfie and its background reach every follower without the delay |
| **E18** | The IANA time zone of each day | `site.ts` `tz` | Narrows the region in countries with several zones (US, AU, BR, ID, RU) |

In short, today the site works almost like a live location feed for anyone who has the link
(threats §0).

Captures do not leak this way: their ids are `e_` + base32(sha256(sourceKey)), and nothing is
written to the manifest while no change is public (critique §3, checked).

### 2.2 Who we protect against, after this proposal

| Who | Likelihood / impact | Path in (new design) | Main defence | What still gets through |
|---|---|---|---|---|
| Stranger, crawler, web archive | low / medium | Hostname from CT logs; a link posted somewhere | The gate gives the same neutral page for every path. A neutral production address (D9) | That *some* private page is hosted at this address |
| Someone who saw a shared day link (so knows the secret path) | **high** / medium | Tries dates, trips or media under the secret path | Identical answers for existing and missing paths (tested, Appendix B) | Nothing beyond the neutral page |
| Someone a follower forwards the link to (grandma's choir, an uncle's Facebook) | **high** / medium | A forwarded personal link | The join page says "This link is for Oma. Are you Oma?" A 48 h join window, at most 4 devices, a note per new device with a network hint, neutral previews | A dishonest forwardee inside the window, until the owner removes the device. Screenshots and retelling by the follower |
| An ex or acquaintance she doesn't want. Most stalkers know their victim: 40 % partners, 42 % acquaintances (SPARC, US data) | medium / **severe** | A fake request ("Anna from the climbing club"), a friend's phone, a forwarded link | Approval plus a check through a known channel; the "claims to be X" banner; device notes; revocation | What he sees on someone else's phone |
| **An approved follower who turns into the threat** (an ex after a breakup, the guy from the hostel) | medium / **severe** | Already inside | Layer 1 defaults: delay, departure hold, coarse times, auto-hold of plan captions, no return date. Revocation in seconds; lock | Places she has left, at day-level precision; everything he saw before revocation |
| Scraper doing pattern-of-life analysis | low / high | Needs a valid session | Gate, release slots, time buckets, revocation | An approved follower can still copy what they are allowed to see |
| Harasser using a form | medium / medium | The followers' form, or the request form | Identity-bound followers' form; a short, collapsed note on requests with a daily digest; silent mute; filters; rate limits; evidence | Pretexting ("where are you staying?"): only her judgement helps |
| Her WhatsApp status audience | n/a | Sees her statuses live in WhatsApp | Her WhatsApp setting "My contacts except…". Keep the observer number out of narrow audiences (§3.5) | The site cannot fix this |
| Compromise of the hosting account | low / severe | Reads files on the host | Strong credentials, 2FA where offered, the session store outside the web root | Everything: files are plaintext on the host |
| A stolen phone with a live admin session | low / high | Uses the admin | Step-up login for unlock, approve and export (§3.3) | Until that session is revoked |
| Owner offline for days (trekking, flights) | high / low–medium | – | A co-admin with narrow rights (D8) | Device requests wait if there is no co-admin |

How harmful a disclosure is depends on how fresh and how precise it is, together. A venue photo
while she is still there is dangerous. The same photo after she has left is not.

- A **delay** removes freshness for short stays.
- A **departure hold** removes freshness for long stays.
- **Coarse places and times** remove precision and her daily rhythm.
- Photos keep venue-level precision, so the timing levers must carry the load (threats §3).

---

## 3. Protection concept

| Layer | Protects against | Does NOT protect against |
|---|---|---|
| 1 Safety defaults | An approved person turning dangerous; live tracking; ambush on her return; pattern-of-life analysis | Screenshots; her WhatsApp audience; voice notes and photos that announce plans (they can't be scanned) |
| 2 Access gate | Strangers, crawlers, link previews, people who know a shared URL, forwarded links reaching anyone ("zero information") | Approved people; a compromised hosting account |
| 3 Requests, invites, revocation | Forwarded links (detected and limited), lost phones, people who must go, restored backups reviving access | What they saw before; a liar who gets approved |
| 4 Panic switch | An acute situation: everything off in seconds, even with the Mac off | Anything already seen or saved; someone already nearby |
| 5 Contact and abuse protection | A contact channel that is not a public harassment channel | Pretexting by approved people; her other channels |

### 3.1 Layer 1: safety defaults (they also apply to approved followers)

All of these levers are in **P0**, before any real travel content goes live. Every policy change is
made in `packages/contracts/src/policy.ts`, mirrored in `api/src/Domain/Policy.php`, and covered by
shared vectors.

| Lever | Today | Recommended default | Protects against | Does not |
|---|---|---|---|---|
| Delay | `instant` | **24 h** for every addition: captures, notes, stories, and the owner's edits to day and trip text, the greeting and the portrait. "Publish now" per item, with a warning (D1) | Someone showing up during short stays | Stays longer than the delay (next rows) |
| Release slots (new) | Items go live whenever they are due | Due additions go live in **2 batches a day**, at fixed times (e.g. 08:00 and 20:00 Europe/Berlin). **Removals** (hide, revoke, lock) stay immediate | Learning *when the site changes*; "she just posted" alerts from polling | This alone does not hide *when she posts*: see time buckets |
| Departure hold (new) | – | Days at the **current place** stay unpublished until one of these happens: **a later day carries a different place**, the owner taps **"Lea has moved on"**, or **7 days** pass. The owner gets a push 12 h before the cap. "Later day" means any captured or annotated day, not a public one, so the rule cannot deadlock. Days without a place wait for the cap or the button (D1) | Venue photos, captions and voice notes while she is still at that place. Stays longer than the delay | The direction of travel and a predictable itinerary. A stay longer than the cap |
| Auto-hold (new) | – | Captions, text statuses and notes that contain plan or venue words go to review, with a push to the owner, instead of being released. Words (de/en/ar lists): morgen/tomorrow, heute Abend/tonight, Flug/flight, Gate, Hostel/Hotel, Zimmer/room, Check-in, "unterwegs nach"/"heading to", "bis …". The admin says plainly that voice notes and photos cannot be scanned | "Tomorrow Hanoi!" announcing her next place, which the departure hold alone would release while she is in Hanoi | Voice notes, text inside photos, rewording |
| Time buckets (new) | Exact `at`, `firstAt`/`lastAt`, shown as clock times | **3-hour buckets in local time** for every day. Order is kept with +1 s offsets; `firstAt`/`lastAt` come from the buckets. An additive flag makes the site show "night / morning / midday / afternoon / evening" instead of a fake "15:00" | Her daily rhythm. Exact posting times | The order of moments, and which bucket |
| Post ids (new) | `p_` + ULID (timestamp) | Published as `p_` + base32(sha256(ULID))[0..16], like captures. The URL change costs nothing now, because there is no real content yet | The exact writing time (E16) | – |
| Here-now chip | Live for 48 h | **Off**. The header shows only "Latest from 🇻🇳 Vietnam" (D2) | An explicit live signal | The country |
| Coordinates | `lat`/`lng` in day JSON | **Never published.** The site doesn't use them | Extracting the exact point. Blurring would not help: research recovered up to 85 % of Strava privacy zones (threats [ST3]) | – |
| Return date | Planned trip end published | **Hidden until it has passed** ("since 3 Nov"). `TripSummary.end` is required by the contract, so emit min(planned end, last public day) plus an additive `ongoing` flag | Ambush on her return; burglary of the empty home | – |
| Portrait (fix) | Any ready photo, even pending or hidden (E17) | Only from a capture whose effective visibility is public. Until the new one is public, the previous portrait stays. The portrait picker says so | The portrait bypassing the delay | An old portrait still shows her face to followers |
| Time zone | IANA zone per day (E18) | Released days are places she has left, so the leak is about the past. With D1 = b (no departure hold), map the newest place's zone to one zone per country | Narrowing the region of the current place | – |
| Identity | Public | **Followers only.** The landing page never shows it; the first name only as an opt-in | Recognition, face search by strangers | An approved follower still sees her face |
| Link previews | Newest photo | **Neutral everywhere**: no image, no names | Group-chat leaks | – |
| Owner review | None | A checklist in the admin inbox: hostel names, room numbers, key cards, boarding passes, signs, reflections, other people's faces | Venue or booking leaks from photos | What the owner misses |
| Screenshot label | – | A small "💌 für Oma" in the player chrome. It ends up in most screenshots | Casual re-sharing of screenshots (deterrence, and a hint to the source) | Cropping |

Why these defaults:
- Canada's travel advice says "Keep information about your accommodations private".
- Solo Female Travelers advise to "Post content online after you have left a place".
- German police say to post holiday photos once you are home (threats §6).
- Polarsteps added "hide current location" after its 2026 incident (threats §5.1).

If the family needs "is she OK right now?", 1:1 live location sharing serves that better than the
site: Find My, Google Maps or WhatsApp live location, for a limited time.

### 3.2 Layer 2: the access gate

**Choice: "C-gate" (access §4C), kept after the critique.**

- PHP runs only when a device joins and for a few small actions.
- On every other request, Apache serves the file natively after a cookie-to-file check in
  `.htaccess`.
- The API is the source of truth for followers. A signed snapshot keeps the gate's store in step.

Why this option, by requirement:

| Requirement | How C-gate meets it |
|---|---|
| Per-person revocation, fast | Revoking deletes that person's session files from the store. The next request is refused. About 1–2 s through a direct write or the phone relay (§3.3), with no Mac needed |
| Zero information without access | Without a valid session, every request gets one of two fixed answers: the neutral page, or a fixed 403 for data and media. It is **identical for existing and missing paths** (tested, Appendix B) |
| Works on Hetzner's limits | Only 2/5/10/20 PHP processes per plan (S/M/L/XL), so PHP must never serve media. Here it doesn't: images, video `Range` requests, ETags and caching stay native Apache |
| Grandparent UX | Tap a personal link in WhatsApp, confirm "Yes, that's me", done. No password |
| Forwarding visible and limited | "This link is for Oma" on the join page, a device list, a join window, a device limit, a note per new device |
| "Nobody needs the API to view" | Still true. Joining also works while the API is down |

**How it works**

```
Admin PWA (phone) ──HTTPS──▶ API (SQLite: followers, tombstones, invite hashes, devices,
   │                         session hashes, requests, messages, lock, sync epoch + counter)
   │  signed snapshot ◀──────┘
   │  (relay: the phone POSTs it to the gate)        sync paths, in order:
   ▼                                                  1 direct file write (same account, P0b)
Site host: Apache + 2 × .htaccess + /_/gate.php       2 phone relay  3 API push + 5-min repair
   session store OUTSIDE the web root: ~/omw-access/<site>/{f/<follower>/<session>, locked,
   tombstones, sync.key, outbox/}                     4 Mac over SFTP (lock and removals)
   request with cookie __Host-omw=<follower>.<session>
     ├─ store file exists, not locked → Apache serves HTML/JSON/media natively
     └─ otherwise → pages: the neutral page (same bytes for every path)
                    data/media: fixed 403 (same bytes for every path)
Backend (Mac) ──SFTP──▶ gate tree at the web root (root .htaccess, _/, welcome, robots, icons)
                        content tree under /<secret>/ (with its own copy of the gate block)
```

**Gate rules** (generated by `backend/src/generator/extras.ts`, never edited by hand; tested on
Apache 2.4.66, still to be confirmed on Hetzner in P0b). The **same block** goes into the root
`.htaccess` and into the content `.htaccess` under `/<secret>/`:

```apache
# Every path test uses %{REQUEST_URI}. Per-directory patterns are relative to whichever
# .htaccess the merged rules run in, and are matched against the full filesystem path for a
# directory requested without its trailing slash. Both were seen in the probes.
RewriteEngine On
RewriteOptions InheritDownBefore AllowNoSlash   # children can't drop the gate; no 301 oracle
DirectorySlash Off                              # no 301 oracle for existing directories
RewriteCond %{REQUEST_URI} ^/\.well-known/acme-challenge/
RewriteRule ^ - [L]
RewriteCond %{REQUEST_URI} (?:^|/)\.            # every dot segment: same 403, existing or not
RewriteRule ^ - [F,L]
RewriteCond %{REQUEST_URI} ^/(?:_/|assets/|robots\.txt$|favicon\.|apple-touch-icon)
RewriteRule ^ - [L]                             # public files at the ROOT only
RewriteCond <store>/locked !-f
RewriteCond %{HTTP_COOKIE} (?:^|;\s*)__Host-omw=([a-z0-9]{12})\.([A-Za-z0-9_-]{43})(?:;|$)
RewriteCond <store>/f/%1/%2 -f
RewriteRule ^ - [E=OMW_OK:1]
RewriteCond %{ENV:OMW_OK} =1                    # followers only: trailing-slash redirect
RewriteCond %{REQUEST_FILENAME} -d
RewriteCond %{REQUEST_URI} [^/]$
RewriteRule ^ %{REQUEST_URI}/ [R=301,L]
RewriteCond %{ENV:OMW_OK} =1                    # followers: "/" opens the journey
RewriteCond %{REQUEST_URI} =/
RewriteRule ^ /<secret>/ [R=302,L]
RewriteCond %{ENV:OMW_OK} =1
RewriteRule ^ - [L]                             # Apache serves natively
RewriteCond <store>/locked !-f                  # stale or revoked cookie (not during a lock)
RewriteCond %{HTTP_COOKIE} __Host-omw=
RewriteRule ^ - [E=OMW_STALE:1]
RewriteCond %{REQUEST_URI} ^/[^/]+/(?:data|media)/
RewriteRule ^ - [F,L]                           # fixed 403 body (/_/403.txt)
RewriteRule ^ /_/welcome/index.html [END]       # neutral page, every other path
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=OMW_STALE
Header always set Clear-Site-Data "\"cache\", \"storage\"" env=REDIRECT_OMW_STALE
Header always set Vary Cookie
```

`<store>` is the absolute path of the session store and `<secret>` the content folder. The root
file adds `Options -Indexes -MultiViews` and `ErrorDocument 403 /_/403.txt`. The content file
keeps today's generated MIME types, cache headers and dotfile deny, and adds the same
`ErrorDocument 403` and the block above.

**Details that matter**

- **The gate block lives in both files, and the publisher protects them.**
  - Either file alone keeps the content gated, so replacing one file never opens the content. This
    is tested with each file missing.
  - A generator test requires every `Rewrite*` line in the content file to belong to the generated
    block, and forbids `IgnoreInherit`, which would cancel `InheritDownBefore`.
  - The publisher uploads the two files one after the other, never at the same time.
  - The publisher refuses `access: gate` on a target without atomic replace. Its "Test" already
    reports `atomic replace: yes/no`, and without `posix-rename` the SFTP fallback is
    delete + rename, which leaves a short window without the file.
  - The publisher uploads a file only when its SHA-256 changed, so these windows occur only when
    the rules change, not on every build.
- **The session store is outside the web root**, e.g. `~/omw-access/<site>/`.
  - Without a root `.htaccess`, an in-root store and its `sync.key` were served to anyone
    (Appendix B, case F). Leaking that key would let someone forge snapshots.
  - `RewriteCond … -f` works on any absolute path (tested). P0b checks that Hetzner's Apache can
    stat that path and that PHP's `open_basedir` lets `gate.php` write there.
  - Fallback if not: keep the store in the web root, inside its own deny-all `.htaccess` that is
    uploaded once and never replaced, and keep the key in a `.php` file that only returns it.
- **The cookie** is `__Host-omw=<12-char follower id>.<256-bit session id>`.
  - Attributes: `Secure; HttpOnly; SameSite=Lax; Path=/`.
  - PHP sets it, because Apache's `CO` flag needs a domain and so cannot set `__Host-` cookies.
  - `Max-Age` is 400 days (Chrome's cap) and is refreshed by the 6-hourly hello.
  - Safari's 7-day limit applies only to storage written by scripts (WebKit), so it doesn't affect
    this cookie.
  - It must be `Lax`: with `Strict`, a tap on a link inside WhatsApp would arrive without the
    cookie.
- **The personal link** is `https://<site>/_/join/#t=<secret>`.
  - Browsers never send the part after `#` to a server. WhatsApp's preview fetch and e-mail
    scanners see only the neutral join page and cannot use up the link.
  - Joining needs a POST from a button press.
- **The secret base path** `/<16 random chars>/` is a thin layer, and this proposal treats it as
  one.
  - It stops scanners that know only the hostname.
  - It leaks with every shared day link.
  - Rotating it is one SFTP rename plus regenerated HTML, because `basePath` is baked into the HTML.
    The followers' root redirect keeps bookmarks and home-screen icons working after a rotation.
- **Caching:**
  - gated HTML and JSON: `private, no-cache`;
  - media: `private, max-age=1y, immutable`;
  - the neutral page: `no-cache`;
  - `Vary: Cookie` on all of them.
- **Clear-Site-Data comes from Apache, without PHP.**
  - A request with a stale or revoked cookie gets `Clear-Site-Data: "cache", "storage"`.
  - It is **not** sent during a lock, so unlocking needs no re-download.
  - It never includes `"cookies"`, because that clears the whole registered domain, including the
    admin.
  - The stale cookie is deliberately **not** expired. If the store were ever lost or restored
    wrongly, the cookies are what lets followers come back once the store is repaired (§3.3).
- **Last seen.**
  - The site calls `/_/gate.php?op=hello` at most once per 6 h per device. The gate updates "last
    seen" and returns the follower's label for the footer line "Shared personally with Oma".
  - Devices unseen for 180 days are dropped.
- **`gate.php`.**
  - About 400 lines of plain PHP with no Composer packages, shipped by the generator and holding no
    secrets. It reads the key from the store.
  - Operations: `join`, `check` (shows "This link is for Oma"), `addcode`, `leave`, `hello`, `form`,
    `request`, `message`, `panic`, `sync`.
  - `panic` and `sync` are handled first. `form` and `request` are rejected early, before the body
    is read, by a global per-minute counter file.
  - `/_/` has `LimitRequestBody 16384`, and requests use a short `max_execution_time`.
  - Rate limits are per hashed IP and use files.
- **Fail-open watch.**
  - After every deploy, the publisher sends a few anonymous request pairs:
    - an existing and a missing day;
    - a media file;
    - `/<secret>/data/manifest.json`;
    - a dotfile.

    Each pair must give byte-identical answers, the neutral page or the 403. The publisher's own
    service session must get 200. This replaces the anonymous check in `httpcheck.ts`.
  - The API cron repeats one anonymous probe every 5 min and raises the critical alert
    `site_gate_open`.
  - Probes stay rare, because the host blocked an IP after a burst of requests (HOSTING.md §10).

**Zero-information checklist**

| Requirement | How it is met | What remains visible |
|---|---|---|
| No name, portrait, greeting, trips, places, dates, counts, captions or media | All generated content is behind the gate: pages, data, media, `404.html`, the language picker and the web-app manifest. The neutral page is a fixed template without content fields; the only option is the opt-in first name. Public icons are generic, never the portrait | – |
| No JSON, HTML or media by URL | One of two fixed answers, identical for existing and missing paths, the secret folder included, with and without a trailing slash (tested) | Only if both `.htaccess` files are lost at once (watched every 5 min) |
| robots.txt | Fixed: `User-agent: *` / `Disallow: /` | – |
| Sitemap | Never generated in gate mode | – |
| OG/Twitter previews | Any URL fetched without a session gets the neutral page: `og:title` "Privat"/"Private", no image, no description. Gated pages also drop personal OG tags and `meta author` | – |
| Error pages | Strangers never see a 404. Pages get the neutral page, data and media get the fixed 403 | – |
| File names | Never exposed. Directory listings are off. Every dot segment gets the same 403 | – |
| Copy and design | Gender-neutral and name-free ("Woher kennt ihr euch?"); no plane or route motif | That *some* private page exists |
| Timing | Public files change only with software releases, so their `Last-Modified` doesn't follow her posts. **Correction to the first version:** Apache maps the URL to the filesystem before the rewrite rules run, so it does `stat()` the path and reads the `.htaccess` of directories that exist. The difference is microseconds and probably not measurable remotely, but it is not zero | Software release dates; certificate dates in CT logs |
| The API host | No public CORS routes. Requests and messages reach the API only through the gate. The phone-relay `sync` sends a CORS header only after the signature checks out (§3.3), so the gate never names the admin origin to strangers. Still public: `GET /api/v1/health` (version only) and the admin login | The API hostname exists (D9 decouples it from the site's address) |
| Form answers | The same "Thank you" for accepted, duplicate, blocked or locked | – |

### 3.3 Layer 3: requests, personal links, devices, revocation

**Flows**

| Step | What happens | Notes |
|---|---|---|
| 1. Request | A stranger opens any URL and sees the neutral page. "Request access" opens a sheet: name, "How do you know each other?", an optional note of at most 140 characters, and an optional phone or e-mail (only if D4 = b/c). The privacy notice opens inside the sheet. The sheet posts to `/_/gate.php?op=request`, which forwards it to the API, or keeps it in the gate's outbox while the API is down | Requests reach the owner as a **daily digest** without names. In the admin the note is collapsed ("Show text") |
| 2. Approve or decline | Admin → Requests. **Approve** creates the follower, and the phone itself generates the link secret (WebCrypto). The API and the gate only ever see its hash. **Decline** is silent. **Decline & mute** also silently ignores further requests from that contact. A request that names an existing follower ("Oma, new phone") shows a banner: "Claims to be Oma. Call Oma. A new link goes only to Oma's known number" | Requesters only ever see "Thank you. If you know each other, you'll get a personal link." Requests expire after 30 days |
| 3. Personal link | Sent through the phone's share sheet (WhatsApp) or by e-mail (D4). "Share" stays disabled until the gate confirms the link is active. The first use must happen within 7 days | The preview is neutral |
| 4. First device | The join page asks the gate (`op=check`): "Dieser Link ist für **Oma**. Bist du Oma?" with **[Ja, Reise öffnen]** and **[Nein, eigenen Zugang anfragen]**. "Ja" creates the session file, sets the cookie and redirects into the journey | Honest forwardees sort themselves out, and most forwarding is honest family. In an in-app browser, a hint suggests opening Safari or Chrome first |
| 5. More devices | **Join window:** for 48 h after the first use, the same link adds devices without asking, up to **4 per person**. iOS home-screen apps and in-app browsers keep their own cookies, so each counts. After that, or at the limit, the device needs a **QR code** shown on one of that person's devices (menu → "Add a device", 15 min, single use, with a 6-digit code as fallback), or the owner's or co-admin's OK. On a device that already has a session for that person, the link just opens the journey | Each new device gives the owner a note without names ("📱 1 new device"). The admin shows type, browser and whether the device is on the same network as that person's other devices (M5) |
| 6. Lost or new phone | With another device: scan the QR code. Without one: the person asks through a known channel. Admin → person → **Send new link** (the old link stops working) and **remove** the lost device, which the list shows with "last seen" | A found or stolen phone keeps access until its device is removed. A new link only ever goes to the contact the owner already knows, never to a contact typed into the request form |
| 7. Forwarded link | Inside the window: "This link is for Oma" stops honest people. A dishonest person gets in within the limit, and the owner sees "Oma: 3rd device, Android · Chrome, different network". Outside the window: "This device is new for Oma's link" → QR or "Ask for approval". The admin shows **Allow** or **Not Oma** (blocks the attempt and offers "Send Oma a new link") | This is the re-confirm step |
| 8. Revoke | Admin → person → **End access**: all their sessions and links are deleted and the follower id is tombstoned. Or remove a single device | Silent: they see the same neutral page as a stranger. An ended link shows the same text as an unknown one. People may still notice (Apple says the same about Find My, threats [AP1]). The confirmation reminds Lea to hide her WhatsApp status from that person too |

**Admin writes for access never go through the offline queue.**
- Today all admin writes go through one queue that replays strictly in order, and a 401 parks
  writes until the next login (`frontend/admin/src/api/writes.ts`). A revoke stuck behind a 409 or
  a re-login would look done but not be in effect.
- So revoke, remove device, lock, approve and allow-device run on a separate, immediate path:
  - they are never queued, never applied optimistically, and idempotent;
  - their state is shown explicitly ("not yet in effect");
  - if a request cannot go out, the screen offers the panic link.
- Approve, unlock and export ask for the password again. That opens a 10-minute step-up window, so
  a bad connection doesn't mean typing the password for every approval.

**How fast revocation works, and what a revoked person keeps**

| Situation | Path | Takes effect |
|---|---|---|
| Revoke a person or device, or lock, from the admin | API marks it, then the store is updated by a direct write (same account) or by the phone relaying the signed snapshot to `gate.php?op=sync` | **About 1–2 s.** The admin shows "In effect ✓" only after the gate confirms |
| The phone can't reach the website at that moment | The admin shows "not yet in effect ⏳" and offers the panic link. The API retries every 5 min (cron) if outbound HTTPS works; the Mac applies removals over SFTP within about 15 s while it runs | When any path works again. Alert `access_sync_failing` after 10 min |
| A revoked device with the site open in a tab | Its next request is refused: a new day, navigation, or the 5-minute manifest poll. The site then clears its memory and shows the neutral page | **At most about 5 min** for an idle open tab |

**A revoked person keeps:**
- Everything already seen: memory, screenshots, screen recordings, long-press-saved images, and
  anything they forwarded or told.
- Their browser's HTTP cache, where viewed media can stay on disk for up to a year.
  - The site can no longer open these files, because HTML and JSON are refused. Cache-inspection
    tools still can.
  - Each refused request with the stale cookie carries `Clear-Site-Data: "cache", "storage"`
    (MDN BCD):
    - Safari and iOS Safari 17+ and Firefox delete the cache and site storage.
    - Chrome's `cache` support is marked partial ("may cause seconds-long hangs", and some requests
      may still come from the cache).
  - This does nothing if the device never comes back online, or if files were already copied.
- Nothing new from the moment of revocation. **Revocation is never retroactive.**

**How the parts share the follower list and the keys**

| Item | Created by | Stored | Used for |
|---|---|---|---|
| `ACCESS_SYNC_KEY` (32 random bytes) | `scripts/access-keys.ts` on the Mac | API `.env` (`deploy-api.ts --set-access-key`), backend config, the gate store (uploaded by the publisher outside the deploy record, and re-uploaded if missing) | HMAC-SHA256 over direction, epoch, counter, issue time and body, in both directions (snapshots and events) |
| Sync version `(epoch, counter)` | API | API `meta`, and the gate's last accepted version | Anti-replay. The epoch rotates on every API restore, like `feed_id`. The gate accepts a new epoch only from a snapshot issued after the last accepted one and within 10 min of its own clock |
| Follower list (id, label, status, device limit) | API (primary) | A replica in the gate store. **The backend never gets names**, only follower ids for SFTP removals | Joining; the footer label |
| Tombstones (revoked follower ids) | API and gate | Both. The gate never re-adds a tombstoned id, and gate tombstones flow back to the API | A restored API database can't revive a revoked follower. A re-invite creates a new id |
| Link and add-device secrets (≥ 128 bit) | **The admin phone** (WebCrypto), or the gate for QR codes | Clear text only on the phone and in the share sheet. API and gate keep SHA-256 hashes | Joining |
| Session ids (256 bit) | `gate.php` on join | Cookie, plus a file name in the store. **The API keeps only their SHA-256**, so an API database leak gives no working cookies | Every request (file-exists check) |
| Device list (type, joined, last seen, network-prefix hash) | Gate on join; API is the record | API (from gate events); the gate store holds the session files | Admin display, anomaly notes, repair |
| Panic secrets (one each for owner and traveler) | API | Hashes in API and gate | The panic link (§3.4) |
| Lock flag | API (primary) | `<store>/locked`, re-asserted with every snapshot | Apache rule |

**Repair and restore**
- Every snapshot lists the hashes of all valid sessions. Within one epoch, the gate deletes any
  session file whose hash isn't listed, unless the file is younger than 10 min (its join event may
  still be in flight). This removes sessions revived by a **webspace restore**.
- After an **API restore**, the epoch changes.
  - The gate then deletes nothing unknown. It reports its sessions to the API.
  - The API re-adopts the sessions of followers it considers active, unless the gate has
    tombstoned them.
  - So devices that joined after the backup keep working, and revoked people stay out.
- If the store itself is lost, every follower would need a new link. Cookies are never expired by
  the gate, so the admin can instead offer: "Session files missing. Let personal links reopen
  without the window for 7 days?"
- HOSTING §8 gets a line: "After any restore, review People."

**Sync paths, in order of preference**

1. **Direct write**: if P0b shows that the API's PHP can write the site's store (same konsoleH
   account), the API applies changes itself. There is no network hop.
2. **Phone relay**: the API returns the signed snapshot to the admin. The phone POSTs it as
   `text/plain` to `https://<site>/_/gate.php?op=sync`, which is a simple request without a
   preflight. The gate checks the signature, applies the snapshot, and only then answers with
   `Access-Control-Allow-Origin` for the admin origin. The phone cannot forge a snapshot. This works
   without server-to-server HTTPS.
3. **API push and repair** every 5 min by cron, if P0b confirms outbound HTTPS from PHP.
4. **The Mac**: the backend control UI and the publisher apply lock and removals over SFTP. Port 22
   kept working during the observed IP block (HOSTING §10).

**When something is down**

The site and the API run on the **same server** (`www99.your-server.de` is pinned for both). So a
server-level failure such as the observed IP block takes out both at once. The rows below
separate application-level failures.

| Down | Viewing | Joining | Revoke / lock | Requests, messages | Admin |
|---|---|---|---|---|---|
| API app | ✓ | ✓ (links are replicated) | Panic link (gate) or Mac over SFTP; everything else waits | Kept in the gate outbox, delivered later | ✗ |
| Site web server | ✗ for everyone | ✗ | Queued; the direct write still works if the filesystem is up; applied on recovery | ✗ | ✓, with a "website unreachable" banner |
| Only PHP on the site host, or the PHP processes are exhausted | ✓ | ✗ (a friendly error) | Direct write (path 1), or Mac over SFTP; otherwise waits; alert | ✗ | ✓ (✗ if the API shares the same exhausted pool, P0b) |
| Whole server (IP block, outage) | ✗ | ✗ | Mac over SFTP if port 22 is open | ✗ | ✗ |
| Mac backend | ✓ (no new content) | ✓ | ✓ | ✓ | ✓ |
| Both `.htaccess` files lost | Content readable under the secret path | – | – | – | Critical alert within 5 min; the publisher re-uploads; the owner can rotate the path |

### 3.4 Layer 4: panic switch

| Action | Who and where | Takes effect | Needs | Undo |
|---|---|---|---|---|
| **Lock now.** Everyone, followers included, sees the neutral page. Nothing is deleted | Admin (shield button on Home, and in Safety) | About 1–2 s | API + one sync path | "Unlock" (step-up password) |
| **Panic link.** A personal bookmark, `/_/panic/#k=<secret>`, with one big button | Owner and **traveler**, without an admin login | About 1 s | Only the site host's PHP (`panic` is handled first) | Unlock in the admin |
| Lock from the Mac | Backend control UI (127.0.0.1:8787) writes the flag over SFTP | Seconds | Mac + SFTP; works even when the site's PHP is exhausted | Same |
| **Hide the last 14 days** (embargo) | Admin | At the next backend run | Mac (regeneration). Keep "Lock" on until then | Explicit undo |
| Pause messages and requests | Admin (also a standing switch "Request form off") | At once | API | Resume |

- The panic link opens a page and needs a POST from its button, so link previews can't trigger it.
- Someone who learns the secret can only *lock* the site, never unlock it.
- After a panic, the admin shows a checklist:
  - review people and devices;
  - rotate the secret path if a link leaked;
  - tell the close circle privately;
  - keep evidence;
  - check Lea's WhatsApp status audience.

**What the panic switch does not do:**
- recall anything already seen, scraped, cached or archived;
- affect her WhatsApp status audience;
- help against someone who is already physically nearby.

A flood on the request form can exhaust the site's PHP processes and delay the panic link. Early
rejection reduces this risk, and the Mac's SFTP lock and the direct write (path 1) get around it.

### 3.5 Layer 5: contact form and abuse protection

**Approved followers** get the contact design from contact.md §2, with one change: messages are
tied to the follower's identity.

- **Entry points:**
  - a rose pill "💌 Write to Lea" in the header (an icon on phones);
  - a 💌 button docked next to the zoom pill once the header scrolls away;
  - "Write to Lea about this moment" in the player's ⋯ menu;
  - "💌 Write back" on the day-end card;
  - a quiet link at the end of a story.
- **The sheet:** cream paper with washi tape and a hand-font heading. It shows:
  - "Signed as Oma" (from the gate);
  - who reads the messages ("Read by Lea", or "by Lea and <owner>" when they are different
    people);
  - the message (≤ 2000 characters) and the reference chip.

  An e-mail field appears only if replies are on (D5).
- **Transport:** a same-origin `POST /_/gate.php?op=message`. The gate checks the session and
  forwards the message to the API with an HMAC, or keeps it in its outbox.
  - The site's CSP stays `connect-src 'self'`.
  - The API keeps no public routes.

| Protection (followers' form) | Stops | Does not stop |
|---|---|---|
| Only reachable with a valid session; each message carries follower and device | Anonymous abuse; every message has a known sender | A forwarded device writing as "Oma" (it shows up in her device list) |
| Rate limits per follower (3 per 10 min, 20 per day) and a global cap (20 per 15 min, then auto-pause plus alert `contact_flood`) | Floods | A few nasty messages |
| Length and link limits (2000 characters, 1 link), duplicate detection, the owner's word list → "Filtered" folder (never deleted) | Spam, link drops | Rewording |
| A "safety hint" banner when a message asks where she is or to meet | Pretexting ("I'm your cousin, where are you staying?") | Her own judgement is the last line |
| **Silent mute** per follower (they still see "sent") and **End access** | Escalation after a visible block | Their other channels |
| No auto-reply, no read receipts, notifications without message text, at most 1 per 10 min | Lock-screen shocks; learning whether she reads | – |
| "Keep as evidence" plus export with SHA-256 per message (contact §4.8) | Losing evidence | It is not a qualified timestamp |

No proof-of-work captcha is needed here, because identity and per-follower limits do the job.

**Strangers** only get the request form (§3.3 step 1).

| Protection (request form) | Stops | Does not stop |
|---|---|---|
| Honeypot field; a minimum fill time of 3 s via a signed form token from `op=form`; early rejection in `gate.php` | Simple bots; PHP exhaustion by floods | Targeted bots |
| Per hashed IP: 2 per day; 1 open request per contact; global 20 per day, then the form pauses ("Requests are paused, please try later") | Floods | VPNs and IP rotation. An attacker can pause the form on purpose (viewing is not affected) |
| The note is at most 140 characters, collapsed in the admin. Links are filtered | Using the form as an anonymous message channel | Short abuse, which stays collapsed |
| Notifications only as a daily digest, without names | An attacker controlling her lock screen | – |
| The same "Thank you" for every outcome | Probing whether blocks or filters exist | – |
| The "claims to be X" banner; new links only to known contacts | "It's Oma, new phone" pretexting | A convincing call |
| An admin nudge: "Approve only people you can confirm another way (call, mutual friends)" | Most fake identities | A convincing liar |
| A "Request form off" switch: the page then says "Ask the family for your personal link" | Sustained abuse of the form | – |
| *Optional later:* ALTCHA proof-of-work, self-hosted, MIT. **Pin `altcha-org/altcha` `^2.4`** (CVE-2026-71481, a signature bypass in 2.0.0–2.0.2, fixed in 2.0.3), plus our own fail-closed tests (contact §4.2) | Mass spam | A single determined person |

**Messages in the admin** (contact §3.5, adapted):
- **Folders:** Inbox, Archived, Filtered, Requests, plus an Evidence filter. The sender is shown as
  the follower label with a device chip.
- **Phone privacy:** message and people queries set `persist: false`, so nothing is stored in the
  phone's IndexedDB.
- **Notifications:** sent through the existing `ChannelNotifier`.
  - Push texts never contain names or labels, e.g. "💌 1 new message", "📱 1 new device".
  - The admin warns when `alerts.ntfy_url` points to ntfy.sh without `NTFY_TOKEN`, because an
    unreserved ntfy.sh topic can be read by anyone who knows its name.
- **Retention:**

  | Data | Kept |
  |---|---|
  | Messages | 6 months |
  | Requests | 30 days after decision or expiry |
  | Rate-limit hashes | 48 h |
  | Network-prefix hashes | 30 days |
  | Evidence | Until removed |

**WhatsApp itself** stays the live channel, and the site cannot fix it. The site keeps more than
WhatsApp, because it is persistent and aggregated, and Lea sees less there about who watches. The
observer number also flattens her audiences: any status the observer can see goes to **all**
followers, even if she shared it with "Only share with…". The traveler checklist therefore says:
"Whatever the observer number can see goes to everyone on the site. Keep it out of narrow
audiences." "End access" ends with a reminder to also hide her status from that person (Settings →
Privacy → Status → My contacts except…).

---

## 4. Alternatives considered

| Option | What it would give | Why not |
|---|---|---|
| A. Public site with mitigations (secret URL, delay, coarse place) | Simplest; works on any host | Fails "approval-only" and "zero information". Whoever has the link sees everything; there is no per-person revocation and no forwarding detection. Polarsteps expired its secret links after the 2026 incident (threats [PS6]) |
| B. One shared password (Basic Auth or a passphrase page) | Cheap; native Apache | **Excluded by the owner:** it can't be revoked per person and gets forwarded with the link. Basic Auth set up through konsoleH can also silently fail open when the generated `.htaccess` changes (access §4B) |
| C1. One htpasswd login per follower | Per-person revocation works | Grandparents would type a username and password; no one-tap link. Chrome blocks `user:pass@` links for sub-resources (access §4B) |
| C2. PHP serves every file with a signed cookie | Full control per request | 2–5 PHP processes. Video `Range` requests and ETags in PHP; a few viewers could block the site and the API (access §3, §4C2) |
| C3. API-issued short-lived tokens | Central control | Viewing would depend on the API, which breaks "nobody needs the API to view". Revocation waits for the token lifetime |
| D. Client-side encryption on any static host | Works on any static host; survives a host compromise | See the table below. Leaks counts and timing to everyone; revocation needs the Mac; forwarding can't even be detected; slower first paint and video start. Kept as the documented fallback for a host without PHP, or if host compromise becomes the main concern |
| Apache `mod_auth_form` + `mod_session_crypto` | Login form without PHP | Unknown whether Hetzner loads them; it is a password form, not a link |
| Pure `.htaccess` keyed-SHA1 cookie (ap_expr) | No PHP at all | A home-made MAC, not constant-time, relying on undocumented behaviour. Only if PHP were unavailable (access §3) |
| Hybrid (public teaser plus followers area) | Strangers see something nice | **Excluded by the owner decision** |
| Per-follower watermarks in media | Leaks could be traced | Breaks content addressing, caching and the disk budget (threats L7d). The player label "für Oma" is the cheap substitute |

**What client-side encryption (D) still leaks on a static host.** These leaks are why it cannot
meet requirement 3 on its own:

| Leak, visible to anyone | Example |
|---|---|
| File count | The number of day files is the number of days she posted |
| File sizes | Video vs photo; how much she posted that day |
| Update times (`Last-Modified`, manifest changes) | When she posts, i.e. her daily rhythm and activity |
| Size of the key file | How many followers there are |
| Revocation | A new content key, the JSON re-encrypted, the media folder renamed. **Needs the Mac online** and is never retroactive |

Behind the gate these leaks disappear for strangers. D would then only add protection against a
host compromise, at the largest build cost (L+).

---

## 5. UX screens

Visual language from PLAN §C, for everything behind the gate:
- **Palette:** cream `#FFF8F6`, blush `#FCE7EE`, lilac `#EEE6FA`, plum ink `#3B2341`; buttons in
  rose-600 `#BE4A74` and violet-700 `#5D3FA0`; the dusk palette at night.
- **Type:** Fraunces (SOFT axis) for headings, Nunito for body text, Playpen Sans for handwritten
  touches.
- **Signature touches:** washi tape, paper grain, the dotted route with a paper plane.

The public pages (S1–S3) stay soft and friendly but **drop the travel motif**: no plane, no route,
no photo. All copy is in de and en, and RTL-ready.

**S1. Site: page for non-followers** (the same page at every URL, for revoked people too)
```
  (soft cream → lilac wash, paper grain; no plane, no route, no photo)
        Privat                                  ← Fraunces SOFT; opt-in: „Leas Seite"
  Diese Seite ist nur mit persönlicher Einladung sichtbar.
        [ Zugang anfragen ]                     ← rose-600 pill, white text
  Du hast einen persönlichen Link? Öffne ihn auf diesem Gerät.
  ─────────────────────────────────────────
  de · en                                       (privacy link: see D7)
```
The preview card says only "Privat" / "Private".

**S2. Site: request sheet** (a bottom sheet over S1)
```
  ✎ Zugang anfragen
  Dein Name*                 [ Tante Uschi                 ]
  Woher kennt ihr euch?*     [ Kletterverein, seit …       ]
  Kurze Notiz (max. 140)     [                             ]
  Telefon oder E-Mail        [ … ]          (only if D4 = b/c)
  [ Anfrage schicken ]
  ⓘ Wer deine Angaben liest und wie lange sie bleiben ›     (opens the notice inside the sheet)
  ── after sending (same for everyone) ──
  Danke! Wenn ihr euch kennt, bekommst du einen persönlichen Link.
```

**S3. Site: join page, device confirmation, footer**
```
  Dieser Link ist für Oma. 🌸
  Bist du Oma?     [ Ja, Reise öffnen ]     [ Nein – eigenen Zugang anfragen ]
  (in an in-app browser: „Öffne den Link am besten zuerst in Safari/Chrome.")
  ── after the 48 h window, or at 4 devices ──
  Dieses Gerät ist neu für Omas Link.
  [ QR-Code von Omas anderem Gerät scannen ]   [ Um Bestätigung bitten ]
  ── unknown or ended link (same text) ──
  Dieser Link ist nicht (mehr) gültig.   [ Zugang anfragen ]
  ── inside the journey ──
  footer: Persönlich geteilt mit Oma
  menu ⋯: Gerät hinzufügen (QR) · Auf diesem Gerät abmelden … (asks to confirm)
  player chrome: small „💌 für Oma"
```

**S4. Site: contact button and sheet (followers only)**
```
  header:  … de|en  [💌 Schreib Lea]  ☾            phone: round 💌 next to the zoom pill
  ┌ washi tape ─────────────────────────────┐
  │ Ein paar Zeilen an Lea ✉︎   (hand font)  │
  │ Unterschrieben als: Oma · Liest: Lea     │
  │ [ Was für ein schöner Sonnenuntergang! ] │
  │ (Zu: Di., 18. Nov. · Hội An 🇻🇳  ✕)      │
  │ [ Abschicken 💌 ]                         │
  └──────────────────────────────────────────┘
  success: a paper plane flies off along the route ·
  „Danke, Oma! Deine Nachricht ist bei Lea angekommen. 💌"
```
Times inside the journey read "am Abend", "am Morgen", never "19:42".

**A1. Admin: Home (phone)**
```
  🛡 Sicher · Fremde sehen nichts ✓ (geprüft vor 3 min)        [ Jetzt sperren ]
  🌸 2 Anfragen ›     💌 1 neue Nachricht ›     📱 Neues Gerät bei Oma ›
  ⏳ Hội An: 3 Tage warten, bis Lea weitergereist ist   [ Lea ist weitergereist ]
  🔎 2 Texte zur Prüfung (Pläne/Unterkunft erwähnt) ›
  (existing cards: backend health, last capture, last publish)
```
Pushes on the lock screen carry no names: "📱 1 neues Gerät", "🌸 Anfragen von heute: 2".

**A2. Admin: Requests**
```
  Tante Uschi · vor 2 h
  „Woher: Kletterverein, seit 2019"     Notiz anzeigen ›
  ⓘ Kennst du die Person wirklich? Im Zweifel kurz anders nachfragen (Anruf, gemeinsame Freunde).
  ⚠ (when a known name is claimed) Behauptet, Oma zu sein. Ruf Oma an.
     Ein neuer Link geht nur an Omas bekannte Nummer.
  [ Annehmen ]  [ Später ]  [ Ablehnen ▾ ]  (still · still & stumm)
  → after accepting: „Link für Tante Uschi erstellt. Öffnet sich 2 Tage lang auf bis zu
    4 ihrer Geräte." [ Per WhatsApp teilen ]  [ Kopieren ]   (enabled once the gate confirms)
```

**A3. Admin: People (followers)**
```
  ( O ) Oma           2 Geräte · zuletzt heute          ›
  ( T ) Tom           1 Gerät · zuletzt vor 3 Wochen     ›
  [ + Person einladen ]
  ── Oma ──
  📱 iPhone · Safari     seit 3. Nov · zuletzt heute                      [ Entfernen ]
  📱 iPad · Safari       seit 9. Nov · zuletzt gestern · gleiches Netz    [ Entfernen ]
  📱 Android · Chrome    seit heute · anderes Netz ⚠                      [ Entfernen ]
  [ Neuen Link senden ]  [ Nachrichten stummschalten ]  [ Zugang beenden ]
  „Zugang beenden": Oma sieht ab sofort nur noch die neutrale Seite. Was sie schon gesehen
  oder gespeichert hat, bleibt bei ihr.   → „Wirksam ✓" once the gate confirms,
  or „Noch nicht wirksam – Website nicht erreichbar [ Panik-Link ]"
```

**A4. Admin: Messages**
```
  [Eingang 3] [Archiv] [Gefiltert 1] [Anfragen 2] [Beweise]
  ● Oma 📱iPhone · zu 18. Nov · „Was für ein schöner …"            09:12
    Tom 📱Android · 🛡 „Wo genau wohnst du gerade? Ich bin …"       gestern
  detail: plain text, links not clickable · 🛡 „Fragt nach deinem Ort. Antworte nur, wenn du
  sicher bist, wer das ist."   [Archiv] [Als Beweis behalten] [Stummschalten] [Export] [Löschen]
```

**A5. Admin: Safety settings**
```
  🔒 Website sperren                         [ aus ]   (unlock asks for your password)
  Panik-Link   [ für mich ]  [ für Lea teilen ]
  Verzögerung                 24 h · Veröffentlichung um 08:00 und 20:00
  Orte                        erst wenn Lea weitergereist ist (höchstens 7 Tage)
  Uhrzeiten                   nur Tageszeit (Morgen, Abend …)
  Texte mit Plänen/Unterkunft zur Prüfung      [ an ]
  „Hier gerade"-Anzeige       aus
  Geräte pro Person           4 · in den ersten 48 h ohne Rückfrage
  Willkommensseite zeigt      nichts Persönliches  ( ) Vorname
  Anfrageformular             an · Tageszusammenfassung
  Kontaktformular             an · Benachrichtigung ohne Inhalt
  Co-Admin                    (D8)
  Letzte 14 Tage verbergen    [ … ]
```

---

## 6. Implementation plan

### 6.1 Phases

| Phase | Contents | Effort | Done when |
|---|---|---|---|
| **P0 Safety defaults** | Stop publishing `lat`/`lng`. Neutral OG and no `meta author`. "Here now" off plus the "Latest from <country>" label. Trip end hidden until passed (`end` = min(planned, last public day) + `ongoing`). Delayed 24 h plus release slots for all additions, owner text edits included; removals immediate. Departure hold with the "moved on" button and a 7-day cap. Auto-hold word lists. 3-hour time buckets plus the part-of-day flag and UI. Hashed post ids. Portrait only from public captures. Owner review checklist. Everything mirrored in `Policy.php` with shared vectors | **L−** (2–3 weeks) | Policy vectors pass in TS and PHP. Generator tests show no coordinates, no future end date, no `og:image`, no `at` off a bucket boundary, no ULID-shaped id, no portrait from a non-public capture |
| **P0b Host probe** (owner-run, §6.4) | Answers the open host questions **before the P1 design is frozen** | S | Answers recorded in HOSTING.md; the sync path and store location are chosen |
| **P1a Gate core** | `gate.php` (`join`, `check`, `hello`, `sync`, `lock`). Generated gate block in both `.htaccess` files. Session store outside the web root. Neutral page, join page, "access ended" in the SPA. Two publish roots and the one-off migration (§6.2). API tables, epoch, tombstones, session hashes. Phone relay (plus direct write if P0b allows). People screen (invite, revoke, devices) on the immediate path. Lock. Publisher and cron probes. Rule tests on Apache | **L** (3–4 weeks) | §6.3 items 1–5 |
| **P1b Gate comfort and resilience** | Panic link. Join window and QR add-device. Network-prefix hint. Mac "Lock site" button. Clear-Site-Data. Co-admin role (if D8 = b). Restore runbook and the "reopen links for 7 days" recovery. Lock test with several open tabs | M–L (1.5–2 weeks) | §6.3 items 6–8 |
| **P2 Requests and messages** | Request sheet via the gate (note ≤ 140, digest, claims banner, form switch). Requests screen. Followers' contact sheet and entry points. Messages screen. Notifications without names. Mute, filters, evidence export | L | A message from a follower's phone arrives in the admin in < 5 s; with the API down, it arrives after recovery |
| **P3 Extras** | Replies from a neutral address (if D5 = b); sealed IP evidence (ext-sodium); ALTCHA if spam appears; anomaly notes (e.g. a device unused for months becoming active); "Hide the last 14 days" | M–L | Per feature |

The rule until P1b passes: **no real travel content on the live host.** It serves synthetic test
content today, and capture (PLAN Phase 0) hasn't started, so this costs nothing now. P0 + P0b +
P1a + P1b take about **7–10 weeks**. P2 can follow while the site is already live for followers.

### 6.2 Modules touched

| Area | Files | Phase |
|---|---|---|
| Contracts | `packages/contracts/src/api.ts`: settings `site.here_now`, `site.recent_place_precision`, `publish.release_slots`, `publish.departure_hold` (cap days), `publish.autohold_words`, `access.*` (device limit, join window, landing first name, request form on/off), `contact.enabled`; types `Follower`, `FollowerDevice`, `LinkCreated`, `AccessSnapshot` (epoch, counter, issuedAt, followers, tombstones, session hashes, lock), `GateEvent`, `FollowRequest`, `AdminMessage`; `StatusResponse` plus an access/contact summary. `policy.ts`: delay for posts and owner edits, release slots, departure hold, auto-hold. `site.ts`: drop `lat`/`lng`; additive `ongoing` on trips and a time-precision flag. Additive optional fields follow the repo's versioning rule (site and data deploy together). Then `pnpm schemas:check` → `api/schemas/*.json` | P0, P1a, P2 |
| API | `migrations/0002_access.sql` (followers, tombstones, link hashes, devices, session hashes, requests, access_state with epoch/counter, events), `0003_contact.sql` (contact.md §3.3, with `follower_id`/`device_id` instead of public network hashes); `Domain/Access/{Followers,Links,Snapshot,GateSync}.php`; `Domain/Policy.php` (mirror and vectors); `Http/Admin/{FollowerController,RequestController,MessageController,SafetyController}.php`; `Http/Gate/GateController.php` (HMAC-authenticated `/api/v1/gate/events`); `Routes.php`; `Infra/RateLimiter` (extracted from `LoginThrottle`); `Infra/CronRunner` job `access` (repair push, event pull, anonymous probe); `AlertEngine` kinds `site_gate_open`, `access_sync_failing`, `follow_request_digest`, `device_new`, `contact_flood`; `Notification` with priority, tags and click, and no names; the epoch rotates in the restore bootstrap next to `rotateFeedId`; step-up window for unlock, approve and export | P1a, P1b, P2 |
| Gate | New `backend/src/generator/static/gate.php` | P1a |
| Generator | `extras.ts` (gate block in both files, robots, cache headers, `LimitRequestBody` for `/_/`); `pages.ts` (`renderWelcome`, `renderJoin`, `renderPanic`, privacy notice; neutral OG; picker and web-app manifest under the secret path; generic public icons); `model.ts` (precision, `lat`/`lng`, trip end, time buckets, hashed post ids, `avatarFor` visibility); `generate.ts` and `output.ts` (gate tree); `verify.ts` (**public-surface leak test**: render with a fixture profile and assert that no name, place, date or count appears in any public file; **`.htaccess` test**: no `Rewrite*` outside the generated block, no `IgnoreInherit`); `GENERATOR_VERSION` bump | P0, P1a |
| Publisher | **Two roots** per target: `gateRoot` (web root: root `.htaccess`, `_/`, neutral `index.html`, robots, icons) and `contentRoot` = `gateRoot/<secret>`. The existing plan, phase, ownership and deploy-record logic stays relative to `contentRoot`, so `phaseOf()` and `isGeneratorPath()` keep working; a small gate deploy (`access.ts`) handles the gate tree. Ordering: gate tree first, then content (with its own gate block), then the manifest. `access.ts` also handles the sync key, the service session, and the SFTP fallback for lock and removals. `httpcheck.ts`: identical anonymous pairs, service session 200. `targets.ts`/`types.ts`: `access: gate` capability; refuses a target without atomic replace or with an unprotected root. **Migration** of today's test content: deploy to the new `contentRoot` (a fresh deploy record, so the mass-delete guard is not involved), verify the gate, then delete the old root content with a one-off, explicitly confirmed cleanup | P1a |
| Site | `data/fetch.ts` (401/403 or a non-JSON answer → `AccessEnded`: stop all requests, clear the query cache, show the neutral page); `routes/root.tsx`; `components/decor.tsx` (label instead of chip); `components/site-header.tsx` (contact pill, footer label, menu: add device, sign out); part-of-day time display in `timeline/filmstrip.tsx` and `player/items.ts`; new `welcome.tsx` and `join.tsx` entry (a small Vite entry without the timeline); `contact/*` (contact.md §7, posting to `/_/gate.php?op=message`); `player/{chrome,day-end,story-sheet}.tsx` (contact entry points, "für Oma" label); Lingui de/en/pseudo-ar | P0–P2 |
| Admin | `screens/{people,requests,messages,message,safety}.tsx`; Home cards and shield; departure-hold card and "moved on" button; review queue for auto-held items; an **immediate access client** outside `writes.ts`; WebCrypto link secrets; Web Share; QR display; `persist: false` for messages and people; `settings.tsx` link to Safety; the portrait picker hint; an ntfy.sh warning | P0, P1a, P1b, P2 |
| Backend control UI | "Lock site" button (SFTP) | P1b |
| Scripts and docs | `scripts/access-keys.ts`; `deploy-api.ts --set-access-key`; HOSTING.md (requirements, probe answers, lock runbook, "after any restore, review People"); OPERATIONS.md (panic and harassment runbooks); new `docs/PRIVACY.md`; traveler checklist (WhatsApp audience rule); PLAN.md decisions table | P1a, P1b, P2 |
| Tests | PHPUnit for `gate.php` (built-in server) and the API. **The `.htaccess` rules run on the macOS built-in Apache** (`/usr/sbin/httpd` on 127.0.0.1, as in `apache-probe-rev/run.sh`), with no Docker needed; that matters because the Docker disk is full. A Linux runner would use the distribution's `apache2`. Playwright: neutral page identical on every path, neutral preview, revoke within 2 s, lock/unlock, Mac off, API off | P1a, P1b, P2 |

### 6.3 Acceptance (P1a items 1–5, P1b items 6–8)

1. **Anonymous requests show nothing.**
   - Pairs of an existing and a missing path, each must give byte-identical status, headers and
     body (except `Date`):
     - day, trip, story, data and media paths;
     - dotfiles;
     - the secret folder with and without a trailing slash.
   - No answer contains the fixture name, places, dates or counts.
   - A no-cookie preview fetch of a deep link shows only "Privat".
2. **The gate does not fail open.** Each of these cases still gates all content:
   - a content `.htaccess` with an extra `RewriteEngine On`;
   - the root `.htaccess` removed;
   - the content `.htaccess` removed.

   The store is not reachable over HTTP. The generator test rejects stray `Rewrite*` and
   `IgnoreInherit`. The publisher refuses gate mode without atomic replace.
3. **Revocation and lock work quickly.**
   - After a revoke in the admin, the device's next data request gets 403 within 2 s, both through
     the phone relay and through the direct write.
   - Lock shows everyone the neutral page.
   - Unlock restores access without re-joining.
   - A revoke issued while offline never shows "In effect".
4. **Outages are handled.**
   - With the Mac stopped, or with outbound HTTPS blocked, revoke, lock and joins still work.
   - With the API stopped, viewing, joins and the panic link still work, and requests are
     delivered afterwards.
5. **Restores don't revive access.**
   - After the API database is restored to an older backup, a follower revoked later stays out
     (tombstone), new snapshots are accepted (new epoch), and devices that joined after the backup
     keep working.
   - After session files are restored, the next sync deletes the revived ones.
6. **Device rules hold.**
   - The link reopens on the same device.
   - It adds up to 4 devices within 48 h.
   - A 5th device, or any device after the window, needs a QR code or the owner's OK.
   - "Not Oma" blocks the attempt.
7. **The panic link works under load.** With the request form flooded at its global cap, the panic
   link still locks within 2 s, and the Mac lock works with the site's PHP stopped.
8. **Lock with open tabs.** With 3 follower tabs open, a lock leads to a bounded number of refused
   requests. M6: if the host counts 4xx responses, switch gated data and media to a fixed neutral
   `200 no-store` body.

### 6.4 Host probe (P0b, owner-run)

- **Method:** follow the probe list from access §8. Use a throwaway folder, send a handful of
  requests spaced seconds apart, and delete everything afterwards.
- **Apache.** Does `AllowOverride` permit:
  - `DirectorySlash`;
  - `RewriteOptions InheritDownBefore AllowNoSlash`;
  - `Options`;
  - `Header`;
  - `LimitRequestBody`?

  Also: do the cookie backreference inside `-f` and `END` work?
- **Store.** Can `RewriteCond -f` see a path outside the web root? Can PHP write there under
  `open_basedir`?
- **SFTP.** Does the server support `posix-rename@openssh.com`? The publisher's "Test" shows
  `atomic replace`.
- **Account.** Are the site and the API in one konsoleH account, with a shared filesystem and a
  shared PHP process limit?
- **Network.** Can PHP make outbound HTTPS calls (curl or `allow_url_fopen`), and reach port 22?
- **Extensions.** Is `ext-sodium` loaded on both?
- **IP block.** What triggers it? Ask Hetzner support whether it counts 4xx responses or matches
  path patterns such as `/.env`. HOSTING §10 recorded it after probes of private paths.
- **Access logs.** How long are they kept, and can IPs be anonymised? This goes into the privacy
  notice.

### 6.5 What changes in the architecture

| Topic | PLAN today | After wave 5 |
|---|---|---|
| Static-first | Yes | **Yes.** Pages, JSON and media are pre-generated files served natively by Apache. PHP runs only for join, the 6-hourly hello, forms, sync and panic |
| Any static host | Yes | **No longer for the live site.** The live target needs Apache ≥ 2.4.8 + mod_rewrite + mod_headers + PHP ≥ 8.1 on the same host, `.htaccess` overrides for `RewriteOptions`/`DirectorySlash`, and atomic SFTP replace. That is accepted, and the publisher enforces it |
| What stays portable | – | The generator output and the SPA; the dev `local` target; the API (any PHP host); the gate on any Apache + PHP host with those overrides (most shared hosts; not checked beyond Hetzner); an equivalent nginx config on a self-run server; option D as the documented fallback for a pure static host |
| Publish targets | One `remoteRoot` | Two roots: the gate tree at the web root and the content under the secret folder |
| API needed to view | No | Still no. It is not even needed to join |
| Publishing default | `instant` | `delayed` 24 h plus release slots and the departure hold (D1) |
| Time data | Exact | 3-hour buckets in the published data; the originals stay on the Mac and in the API |
| Visitor features over CORS | Planned | No public API routes. Visitor input arrives only through the gate relay |
| Admin writes | One offline queue | Plus an immediate, non-queued path for access actions |
| Data ownership | Backend: captures; API: owner content | Plus: API is primary for followers, tombstones, links, devices (session hashes), requests, messages and lock; the gate store enforces sessions. The backend holds no follower names |

---

## 7. Decisions for the owner

Public vs approval is settled. These questions remain open.

**D1. How fresh should followers see Lea's posts?**
- a) Right away, as now.
- b) About a day later, released twice a day at fixed times.
- c) **b, plus: the days at a place stay hidden until she has moved on, for at most 7 days (you can
  release them earlier with one tap) (recommended).**

*Why c:* an approved person can turn into a threat, and a day's delay does not help during a
three-night stay, because the photos show the hostel. *What c costs:* the family sees each place
after she has left it, up to a week late on long stays. Days without a place name wait for the
cap or your tap. Times show only as the part of the day in every option.

**D2. What should followers see about where she is right now?**
- a) City plus the pulsing "here now" badge, as now.
- b) **No badge; only a quiet "Latest from 🇻🇳 Vietnam" label (recommended).**
- c) Nothing about the current country either.

**D3. How strict should a personal link be about extra phones and tablets?**
- a) It opens on up to 4 devices at any time, with a note for each. Easiest, but a forwarded link
  works until you notice.
- b) **It opens on up to 4 of that person's devices within 48 h of first use. After that only with
  a QR code from one of their devices, or your (or the co-admin's) OK (recommended).**
- c) Every device after the first waits for your OK.

**D4. How do approved people receive their link?**
- a) **You send it yourself from the admin via WhatsApp or the share button (recommended).** You
  choose the person and the channel.
- b) Automatically by e-mail to the address they typed in. Whoever controls that mailbox gets in,
  and an attacker can type in any address.
- c) You choose for each request.

**D5. Should Lea be able to answer messages through the site?**
- a) **Not at the start: she answers personally (e.g. WhatsApp) if she wants (recommended).** Less to
  build, nothing sent automatically.
- b) Yes, written in the admin and sent from a neutral address, so her own e-mail and phone number
  stay hidden (about M in P3; it needs an e-mail field in the sheet).
- c) Both.

**D6. Skip this one if you are the traveler yourself.** Otherwise, how does Lea get control?
- a) She uses your admin login.
- b) **Her own login with the same rights, plus her own panic link (recommended).**
- c) Only a panic link, no login.

**D7. Who is named in the request form's privacy notice?** Anyone who sends a request must be
told who receives their data (Art. 13 GDPR).
- a) **You (not Lea), with a neutral e-mail address. The notice opens inside the request sheet, so
  only people who start a request see it (recommended, because you asked for a request form).**
- b) Turn the form off. The page then says "Ask the family for your personal link", and no
  strangers' data is collected. This also makes the household exemption easier to argue.

Either way: whether the neutral page itself needs a privacy link because of the host's access logs
is a question for the lawyer (§8.2).

**D8. Who covers when you are offline?**
- a) Nobody: new devices and new links wait for you.
- b) **A co-admin with narrow rights, e.g. a parent at home (recommended).** They can approve
  devices, send new links and lock the site. They cannot unlock, export, read messages or change
  safety settings.

**D9. Which web address should the site use once real content goes live?**
- a) Keep `the-on-my-way-website.schaefchens.de`. The name says "on my way", and it sits next to
  the API name in public certificate logs.
- b) A neutral name on the same domain, e.g. `p.schaefchens.de`. No travel words, but still next to
  the API name in the same certificate logs.
- c) **A separate, neutral domain on the same Hetzner account, at a small yearly cost
  (recommended).** Nothing in public logs connects it to schaefchens.de or the API. Followers never
  contact the API, because messages go through the website.

The landing page's first name stays **off** by default. It is a switch in Safety (opt-in), not a
decision you have to make now.

---

## 8. Open risks and legal notes

### 8.1 Open risks

| Risk | Impact | Mitigation | Status |
|---|---|---|---|
| Hetzner behaviour unverified: overrides for `RewriteOptions`/`DirectorySlash`, `-f` outside the web root, cookie backreferences, `END`, atomic SFTP rename, a shared account, outbound HTTPS, PHP processes per plan | P1 design details | P0b before the P1 design freeze. The rules are tested locally on Apache 2.4.66 | Open |
| Gate rules lost or overwritten (fail-open) | Content exposed | The block in both files; `InheritDownBefore`; generator test; atomic replace only; publisher check after every deploy plus a 5-minute probe; critical alert; re-upload | Designed, tested locally |
| Session store or key exposed | Forged sessions | The store outside the web root (or a never-replaced deny file); the key only in the store, the API `.env` and the backend config | Designed |
| Backup restore revives access | A revoked person is back | Epoch, tombstones, session-hash repair, runbook line | Designed |
| Hosting account compromise | All content readable on the host | Strong unique konsoleH and Hetzner passwords, 2FA where Hetzner offers it, SFTP keys; option D only if this becomes the main concern | Residual |
| Site and API on one server, possibly one PHP pool | One failure takes out viewing, admin and panic | Direct write, phone relay, the Mac SFTP lock (port 22 survived the observed block), early rejection of forms | Partly open (P0b) |
| The host blocks IPs after bursts (seen 2026-11-20) | A family's shared IP locked out; the owner loses the admin on the same Wi-Fi | The site stops all requests after the first refusal; probes are rare; the trigger is asked in P0b; fallback to a neutral `200` body if 4xx responses are counted | Open |
| An approved follower is the threat | Sees places she has left, at day-level precision | Layer 1 defaults, device notes, revocation within seconds, lock | Residual |
| Social engineering of requests and new links | A stalker gets approved, or gets "Oma's" new link | Nudge to verify through a known channel; the "claims to be X" banner; new links only to known contacts | Residual |
| A forwarded link used inside the join window | A stranger gets in until the owner reacts | "This link is for Oma" page; at most 4 devices; a note with a network hint; one tap to remove | Accepted (D3) |
| Her WhatsApp status audience is wider than the site's, and the observer number flattens it | Live statuses outside the site; narrow-audience statuses reach all followers | Traveler checklist; reminder on "End access" | Her action |
| In-app browsers and home-screen apps have their own cookie jars | Extra devices; confused users | 4 devices; join window; QR; a hint on the join page. WhatsApp's in-app browser plans (9to5Mac, not yet released) to verify | Open |
| `Clear-Site-Data` support varies (Chrome `cache` partial) | A revoked device keeps cached media | Best effort only, stated honestly in §3.3 | Accepted |
| A stolen admin phone | Someone could unlock, approve or export | Step-up for these actions; sessions can be revoked from another device | Designed |
| `gate.php` is security-critical code written in-house | Bypass bugs | Small and dependency-free, fail-closed tests, review, Apache rule tests | Designed |
| Family misses "live" updates | Pressure to switch back to instant | 1:1 live location for parents (Find My, Google Maps, WhatsApp) | Advice |
| Operator ≠ traveler; home archive with GPS originals | Insider risk | D6; the archive stays on the Mac, on an encrypted disk, with backups | Advice |
| Effort | Later launch | P1 split into P1a/P1b; P2 after go-live | Planned |
| Research gaps | Some claims less certain | Polarsteps, FindPenguins, eSafety and Smartraveller rest on search excerpts; the FindPenguins delay is unverified; § 238 StGB, Hilfetelefon and Lindqvist ¶47 were not fetched or only read in secondary sources; WebKit bug 181849 and the 9to5Mac report are taken from the critique without a re-check | Noted |

### 8.2 Legal notes (not legal advice; have a lawyer check before launch)

- **Does the GDPR apply?**
  - Approval-only makes the household exemption (Art. 2(2)(c) GDPR) much easier to argue: the site
    no longer reaches "an indefinite number of people" (CJEU *Lindqvist*, C-101/01).
  - But the public request form processes strangers' data, and Hetzner logs IP addresses.
  - So act as if the GDPR applies: privacy notices, minimal data, retention limits, and a data
    processing agreement with Hetzner (Art. 28).
- **Legal bases:**
  - requests and messages: Art. 6(1)(f), with no consent checkbox (contact §5.2);
  - device data (type, join date, last seen, a 30-day keyed hash of the network prefix):
    Art. 6(1)(f), for security;
  - evidence kept beyond the normal period: Art. 17(3)(e).
- **Information duty (Art. 13):**
  - The request form's notice must name a controller (D7). It applies "at the time when personal
    data are obtained", so the notice opens inside the request sheet.
  - Name the owner, not the traveler, with a neutral e-mail address. If the owner shares Lea's
    surname, that is a real tension with "zero information". Have it checked.
  - Whether the neutral page needs a privacy link for the host's access logs is open. If the host
    can anonymise logs (P0b), the case for a link on that page gets weaker.
- **Push services:** ntfy.sh receives the push texts. Since they carry no names or content,
  little personal data flows; a self-hosted ntfy or a reserved topic with a token removes even
  that.
- **Cookies:** the session cookie is strictly necessary for a service the follower asked for
  (§ 25(2) no. 2 TDDDG), so no banner is needed. The request form sets no cookies.
- **Retention defaults:**

  | Data | Kept |
  |---|---|
  | Requests | 30 days after decision or expiry |
  | Devices | Until removed, or 180 days unseen |
  | Network-prefix hashes | 30 days |
  | Messages | 6 months |
  | Rate-limit hashes | 48 h |
  | Evidence | Until the matter is closed |
  | Backups | Up to 14 days after deletion |
  | Hetzner access logs | Per konsoleH (P0b) |
- **Impressum:**
  - § 5 DDG covers business-like services, which this isn't.
  - § 18(1) MStV exempts sites serving "ausschließlich persönlichen oder familiären Zwecken", and
    approval-only for family and friends is the strongest case for that.
  - So most likely no Impressum is needed. If it ever is, use the owner's name and a c/o address;
    a PO box is not enough (contact §5.7).
- **Photos of other people:** ask companions before publishing their faces (GDPR; § 22 KUG,
  publishing images of people needs their consent).
- **If harassment happens:**
  - Possible offences: § 238 StGB (stalking), § 241 (threats), § 185 (insult). An insult complaint
    must be filed within 3 months (§ 77b StGB).
  - Protection: a contact ban under GewSchG § 1, and a block on her address in the population
    register (§ 51 BMG).
  - Help: HateAid, and the helpline "Gewalt gegen Frauen" 116 016.
  - Report quickly: providers keep IP assignments for about 7 days today. The 3-month retention
    bill (Drucksache 21/6581) was still in committee at the 2026-10-07 hearing.
  - SHA-256 hashes in exports show later changes, but they are not a qualified timestamp.

---

## 9. Note: `owner-decisions.md` in this folder

A file `owner-decisions.md` (12:24, "authoritative") appeared in this folder after the first
version. This revision's task covered only the critique, so the file is **flagged here, not
applied**. Most of it fits this proposal. Where it differs, the orchestrator or the owner needs to
reconcile:

| Point in that file | Relation to this proposal |
|---|---|
| D1–D3 approval-only, per-person revocation, zero information | Identical |
| D4 gate split: the API does all logic and writes the session files over SFTP (phpseclib); the site host has only Apache + `.htaccess`; joining by `fetch` from the site to the API; `CO` sets the cookie, with a tiny PHP fallback | Same enforcement (cookie-to-file check), different place for the logic. Consequences:<br>• The `CO` flag cannot set `__Host-` cookies (Apache flags docs), so the "tiny PHP" fallback is in practice required.<br>• Joining would need the API to be up and a CORS route that names the API host on the public join page, which works against D9.<br>• The SFTP-from-PHP path is as unverified as outbound HTTPS.<br>If P0b shows one shared account, path 1 here (the API writes the store directly) is D4 without SFTP. A small site-side relay for join, forms and panic keeps the API host off the public pages |
| D5 no CDN now; later Bunny token auth for media only, `Cache-Control: private` | Compatible. Media URLs would then carry per-device tokens, and the gate stays in front of HTML and data |
| D6 stable, never-reused follower id | Compatible: tombstones, and a re-invite creates a new id |
| D7 reactions; D9 activity overview; D10 views and impressions analytics | Not in this proposal. They add per-follower tracking. For safety, D9 is a plus: Lea can spot an approved person's unusual interest. Batching and the small PHP pool need care (§3.2 hello pattern) |
| D8 revocation keeps data; D12 delete me | Compatible. D12 needs a "Your data" screen and erasure across the new tables |
| D11 an information screen before joining, versioned, confirmation stored | Fits step 4: the info screen would come before "Ja, Reise öffnen" |
| Contact: followers' form without name or e-mail fields | Matches, except D5 b, which needs an e-mail field for replies |

---

## 10. Key sources

Full lists are in threats.md §10, access.md §9, contact.md §10 and critique.md §5.

**Prior art and stalking research**
- Polarsteps statement on Follow the Money (2026-09-04): https://www.polarsteps.com/comment-follow-the-money
- SPARC stalking fact sheets (40 % intimate partner, 42 % acquaintance): https://www.stalkingawareness.org/fact-sheets-and-infographics/
- Strava privacy-zone inference, ACM CCS 2022: https://lepoch.at/files/epz-inference-attacks-ccs22.pdf
- Apple Personal Safety, location sharing: https://support.apple.com/guide/personal-safety/ips05ede4573/web
- Government of Canada, women travellers: https://travel.gc.ca/travelling/health-safety/women-travellers
- Solo Female Travelers tips: https://www.solofemaletravelers.club/solo-female-travel-tips
- 404 Media on GeoSpy (2025): https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/

**Hosting and Apache**
- Hetzner Webhosting plans (PHP processes per plan): https://www.hetzner.com/de/webhosting/
- Apache mod_rewrite (`RewriteOptions InheritDownBefore`, `AllowNoSlash`, `IgnoreInherit`; per-directory prefix stripping; `RewriteCond` file tests), fetched 2026-11-20: https://httpd.apache.org/docs/2.4/mod/mod_rewrite.html
- Apache rewrite flags (`CO` requires a domain, `END`): https://httpd.apache.org/docs/2.4/rewrite/flags.html

**Browsers and link previews**
- WhatsApp link previews: https://developers.facebook.com/documentation/business-messaging/whatsapp/link-previews/
- Chrome 400-day cookie cap: https://developer.chrome.com/blog/cookie-max-age-expires
- WebKit storage limits: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- MDN Clear-Site-Data: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Clear-Site-Data
- MDN browser-compat-data for Clear-Site-Data (Safari 17 for `cache`/`cookies`/`storage`; Chrome `cache` partial), fetched 2026-11-20: https://github.com/mdn/browser-compat-data/blob/main/http/headers/Clear-Site-Data.json
- WebKit bug 181849, home-screen apps don't share storage with Safari (via critique): https://bugs.webkit.org/show_bug.cgi?id=181849
- 9to5Mac on WhatsApp's planned in-app browser (2026-10-19, via critique): https://9to5mac.com/2026/10/19/whatsapp-may-soon-let-iphone-users-open-any-link-in-an-in-app-browser/
- Certificate Transparency (Let's Encrypt): https://letsencrypt.org/docs/ct-logs/

**ALTCHA**
- ALTCHA advisory GHSA-82w8-65qw-gch6 / CVE-2026-71481: https://osv.dev/vulnerability/GHSA-82w8-65qw-gch6

**German law and GDPR**
- § 25 TDDDG: https://www.gesetze-im-internet.de/ttdsg/__25.html
- § 5 DDG: https://www.gesetze-im-internet.de/ddg/__5.html
- § 18 MStV: https://www.gesetze-bayern.de/Content/Document/MStV-18
- § 22 KUG: https://www.gesetze-im-internet.de/kunsturhg/__22.html
- § 238 StGB: https://www.gesetze-im-internet.de/stgb/__238.html
- § 51 BMG: https://www.gesetze-im-internet.de/bmg/__51.html
- CJEU Lindqvist press release: https://curia.europa.eu/en/actu/communiques/cp03/aff/cp0396en.htm
- Bundestag hearing on IP retention (2026-10-07): https://www.bundestag.de/dokumente/textarchiv/2026/kw41-pa-recht-ip-adressspeicherung-1221516

---

## Appendix A: Critique handled

Verdicts: **Accepted**, **Accepted, changed** (the point is right, but the fix differs), **Partly**,
**Rejected**.

| Point | Verdict | What changed, or why not |
|---|---|---|
| Verdict "keep C-gate" | Accepted | C-gate stays |
| **C1** existence oracle (301 for existing dirs, dot paths) | Accepted, changed | Reproduced (`apache-probe/run.sh`, case A). The critique's fix still matched path patterns relative to the directory, which broke in two further cases (see R1 and R2 below). Final rules: `DirectorySlash Off`, `AllowNoSlash`, and **every path test anchored on `%{REQUEST_URI}`**. The slash redirect is restored for sessions only. Byte-identical pairs are in the acceptance tests. The claims "before looking at the file" and "timing doesn't depend" are corrected (§3.2) |
| **C2** silent fail-open via a content `.htaccess` | Accepted, changed | Reproduced (case B). `InheritDownBefore` is adopted, as is "the gate block in both files" (tested with each file missing). The critique's other fix, "forbid `Rewrite*` in the content file", contradicts "the gate block in both files". It becomes "no `Rewrite*` outside the generated block, never `IgnoreInherit`". Atomic replace is required. Correction: `.htaccess` is re-uploaded only when its SHA-256 changes, not on every build, so the window opens on rule changes only |
| **R1** (new, from probes) | Added | With the critique's hardened rules and a stray `RewriteEngine On` in the content file, `InheritDownBefore` runs the root rules relative to `/<secret>/`. Then `/<secret>/assets/…` and `/<secret>/robots.txt` were served to anonymous visitors, and a follower's `/<secret>/` redirected to itself (`apache-probe-rev`, case R1). Fixed by anchoring on `%{REQUEST_URI}` |
| **R2** (new, from probes) | Added | For a directory requested without its trailing slash, per-directory patterns are matched against the full filesystem path. A dot directory anywhere in the server path (here `/.cache/`) made the dot rule fire and turned `/<secret>` into a 403 oracle. Also fixed by anchoring on `%{REQUEST_URI}` |
| **R3** (new, from probes) | Added | Without a root `.htaccess` (the delete+rename window), the proposal's in-root store served `sync.key` and session files to anyone (case F). The store moves outside the web root (the `-f` test works there), with a never-replaced deny file as the fallback |
| **C3** exact times, ULID post ids | Accepted | Reproduced in code (`newPostPublicId`, `formatTime(entry.at…)`). 3-hour buckets, a part-of-day display and hashed post ids are now in **P0**. The D1 rationale is rewritten: slots hide when the site changes, buckets hide when she posts |
| **H1** long stays and plan captions | Accepted, changed | The departure hold is the default and in P0. The critique's definition ("a later *public* day") would deadlock, because the later place is itself held, so "moved on" uses any later captured or annotated day, the owner's button, or the cap. Places are owner-entered (`Day.placeName`), so days without a place wait for the cap; this is stated. Auto-hold words, and batching of all additions including owner edits, are adopted, with removals immediate |
| **H2** portrait bypasses delay and "hidden" | Accepted | Confirmed in `avatarFor()`. Fix in P0 |
| **H3** restores revive access | Accepted, changed | Epoch + counter, tombstones and a re-asserted lock are adopted. Two changes: the API keeps only **hashes** of session ids, so a database leak gives no cookies; and after an API restore (new epoch) the gate does **not** delete unknown sessions but has the API re-adopt them. Otherwise every device that joined after the backup would be thrown out |
| **H4** outbound HTTPS unverified; one server; one PHP pool | Accepted, changed | Phone relay adopted, but as a `text/plain` simple request whose CORS header is sent only after the signature checks out, so the admin origin is never named to strangers. A direct filesystem write (path 1) is added if P0b shows one account. Early rejection of forms; `panic` handled first; the Mac SFTP lock; P0b runs before the P1 design freeze |
| **H5** usability; contradictory copy; followers at `/` | Accepted | Re-openable personal link with a 48 h join window, 4 devices, "This link is for Oma. Are you Oma?", QR add-device, root redirect for sessions (tested), sign-out behind a confirmation, and a co-admin (D8). The S1 copy is fixed |
| **H6** access writes on the offline queue | Accepted | Immediate, non-queued path; secrets generated on the phone; "Share" disabled until the gate confirms; 10-minute step-up |
| **M1** gender, name and travel cues in public copy; privacy footer | Accepted | Neutral copy and design, the notice inside the sheet, a neutral address as D9. Caveat: the host's access logs may still require a privacy link on the neutral page (§8.2) |
| **M2** request form as a harassment channel | Partly | Accepted: a note ≤ 140 characters, collapsed; a daily digest; the claims banner; new links only to known contacts; a form-off switch. Not accepted: recommending "no form" by default. The owner's brief gives non-followers a request-access form, so D7 recommends keeping it and offers "off" as the alternative |
| **M3** names in ntfy pushes | Accepted | No names or labels in push texts; a warning for ntfy.sh without a token |
| **M4** WhatsApp audience flattening | Accepted | Traveler checklist rule; reminder on "End access" |
| **M5** forwarding detection only by user agent | Accepted | Keyed hash of the /24 or /48 prefix, kept 30 days, shown as "same / different network". It is informational only: mobile data and home Wi-Fi differ for the same person |
| **M6** 403 bursts and the IP block | Accepted, conditional | The trigger goes to P0b and a lock test with 3 tabs is added. The fallback to a neutral `200` body is used only if 4xx counting is confirmed: the observed block followed probes of private paths such as `/.env`, which may be a pattern rule rather than a 4xx count |
| **M7** two trees, mass-delete guard, sizes | Accepted | Two roots per target, with the plan logic unchanged relative to `contentRoot`; migration via a fresh content root and a one-off cleanup. P0 → L−; P1 → P1a (L) + P1b (M–L); 7–10 weeks before real content. macOS Apache for rule tests |
| **L1** Clear-Site-Data | Partly | Accepted: support data (re-checked in MDN BCD); sent by Apache without PHP (tested). Rejected: expiring the stale cookie. If the store is lost or restored wrongly, the cookies are what lets followers come back, and during a lock it would have forced everyone to re-join. Clear-Site-Data is also not sent during a lock |
| **L2** secret path oversold | Accepted | Described as a thin layer that stops hostname-only scanners |
| **L3** `tz` under "country only" | Accepted | Mostly moot under the departure hold; with D1 = b, one zone per country for the newest place |
| **L4** "für Oma" label | Accepted | In the player chrome; cropping defeats it |
| **L5** who reads messages | Accepted | "Read by Lea (and <owner>)" in the sheet |
| **L6** e-mail scanners burn single-use links | Rejected | The secret sits in the fragment and joining needs a button POST, so a scanner's fetch cannot use up a link. With re-openable links there is no single use left to burn. D4 still recommends a) for other reasons |
| §3: `TripSummary.end` is required | Accepted | `end` = min(planned end, last public day) plus an additive `ongoing` flag |
| D3 revised | Accepted | Now D3 b |
| D7 (form and controller name) | Partly | Kept as a decision, with the recommendation flipped to "form on, owner named inside the sheet" (see M2) |
| D8 co-admin | Accepted | Now D8, with narrow rights spelled out |

## Appendix B: Probe results

Reproduce with `sh .cache/design-w5/apache-probe-rev/run.sh`. It uses macOS Apache 2.4.66 on
127.0.0.1:18089 only. `/s3cr3t/` stands for the secret folder. The final rules are in
`apache-probe-rev/gate-block.in`.

| Case | Setup | Result |
|---|---|---|
| A, B (critique) | The first version's rules | 301 for existing days and trips; a stray `RewriteEngine On` opens the content: reproduced |
| R1 | The critique's hardened rules + `RewriteEngine On` in the content file | `/s3cr3t/assets/app-1234.js` and `/s3cr3t/robots.txt` served to anonymous visitors (200, real bytes); follower `/s3cr3t/` → 302 to itself |
| F | The first version's layout, root `.htaccess` missing | `/s3cr3t/data/manifest.json` 200; **`/.omw-access/sync.key` 200 and session files 200** |
| G1 | Final block in both files, store outside the web root | Anonymous: existing and missing days, trips, `/s3cr3t` vs `/s3cr4t` → identical 200 neutral page; data, media and dot paths → identical 403; store unreachable. Follower: `/` → 302 into the journey; `/s3cr3t` → 301 `/s3cr3t/`; content 200 |
| G2 | As G1, root `.htaccess` missing | Content still gated. Only root-level paths differ during the window (`/s3cr4t` → 404) |
| G3 | As G1, content `.htaccess` missing | Content still gated; identical answers |
| L | Lock flag | Followers get the neutral page and 403 for data; no `Clear-Site-Data` |
| H | Headers, anonymous existing vs missing day | Identical status, headers and size (only `Date` differs) |
| Stale cookie | A cookie whose session file doesn't exist | Neutral page or 403, with one `Clear-Site-Data: "cache", "storage"` header |

Not tested here: Hetzner's `AllowOverride`, its PHP `open_basedir` and SFTP rename support, and
timing differences over the network. These belong to P0b.
