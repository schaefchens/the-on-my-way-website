# Contact form: "Write to the traveler"

Design for wave 5, contact part. Status: proposal, nothing implemented. Written 2026-11-20 against
the working tree of `main` (uncommitted changes of the profile wave included). Read-only
analysis: no repo file was changed, no live host was contacted.

"Lea" stands for the traveler's display name (`site.author`, from the profile wave). Without a
name the UI falls back to neutral wording.

---

## 0. Summary

- **What visitors get.** A rose "💌 Write to Lea" button in the header on every page. On phones
  there is also a round 💌 button docked next to the zoom pill, a "Write to Lea about this moment"
  item in the player's ⋯ menu, and a "Write back" button on the day-end card under her sign-off.
  Each one opens a soft bottom sheet (a centred dialog on wide screens) with three fields: name,
  optional e-mail (only for a reply) and message. When the visitor came from the player, a
  removable chip says which day or moment the message is about.
- **How it works.** The site stays static. It reads a `contact` flag from `manifest.json`, then
  only calls the PHP API: `GET /api/v1/public/contact` (form state plus a proof-of-work
  challenge) and `POST /api/v1/public/contact` (the message). The existing `Cors` middleware
  allows only `SITE_ORIGIN`. Messages are stored in SQLite (new migration `0002_contact.sql`).
  The admin PWA gets a **Messages** screen with unread/read, archive, delete, block, "keep as
  evidence", reply and export.
- **Notifications.** The traveler is notified through the existing ntfy/e-mail code
  (`ChannelNotifier`). Pushes are batched and **contain no message text by default**, so ntfy.sh
  never sees a message and nothing upsetting pops up on her lock screen.
- **Replies.** Replies are written in the admin and sent by the API's mailer from a neutral
  address (`CONTACT_FROM`). Mode "mailbox" sets `Reply-To` to a neutral mailbox. Mode "no-reply"
  sets no `Reply-To` and adds a link back to the form. The traveler's private address and her
  phone's IP address never appear in the mail.
- **Abuse protection.** It is layered and uses no third-party service:
  - a honeypot field and a minimum fill time;
  - a self-hosted ALTCHA proof-of-work (MIT; PHP lib `altcha-org/altcha` ≥ 2.0.3, **pin 2.4.x**
    because of a high-severity bypass fixed only two days ago, see §4.2);
  - per-network, per-e-mail and global rate limits (a generalized version of `LoginThrottle`);
  - length, link and word filters, and duplicate detection;
  - fingerprint-free block lists (e-mail HMAC, network HMAC);
  - mute, close, and automatic pause after a flood.
  Blocked senders always get the normal "thank you", so they never learn that they are blocked.
- **Harassment.** Messages can be kept as evidence. The IP address and port are kept only for
  14 days, **sealed** with the owner's public key (the server cannot read them). An export for the
  police includes per-message SHA-256 hashes. A runbook is in §4.8.
- **GDPR.** Legal basis Art. 6(1)(f), a full notice text in de and en, messages auto-deleted
  after 6 months (configurable), IP data only hashed or sealed and only 14 days, no cookies and no
  browser storage.
- **Impressum.** For a purely private, ad-free diary for friends and family, § 5 DDG and
  § 18(1) MStV most likely do not require one. A public, growing audience is a grey area, and then
  an Impressum with a c/o address protects the home address. Not legal advice (§5.7).
- **Follow requests.** The same endpoint takes `purpose: "follow_request"` (e-mail required plus
  "How do you know Lea?"). Approving a request hands over to the access-control part (§6).
- **Effort.** Phase 1 (form, inbox, notifications, protection, blocking, retention, privacy page)
  is **L**. Phase 2 (replies, evidence export, filters UI) is **M**. Phase 3 (follow requests) is
  **M** and depends on the access-control design. Details in §7.

---

## 1. What already exists and gets reused

| Need | Existing code | Reuse |
|---|---|---|
| CORS for the site origin | `api/src/Http/Middleware/Cors.php`: only `SITE_ORIGIN`, `GET, POST`, header `Content-Type`, no credentials; the `/api/v1/public` group with a preflight route in `api/src/Http/Routes.php` ("hearts, comments, subscriptions come later") | Add the contact routes to this group as they are. A JSON POST is not a "simple" request, so the browser always sends a preflight, and a plain HTML form post from another site is refused (`Input::body()` answers 415). |
| Rate limiting | `api/src/Domain/Auth/LoginThrottle.php`: a sliding window per IP and per e-mail in `login_attempts`, with the check and the record in **one** `BEGIN IMMEDIATE` transaction | Extract the window logic (`wait()`, the atomic `begin()`) into `Infra/RateLimiter` with named buckets. `LoginThrottle` then becomes a thin user of it, so its tests keep passing. |
| Notification channels | `api/src/Domain/Alerts/ChannelNotifier.php` (Symfony Mailer via `MAIL_DSN`/`MAIL_FROM`, ntfy with `PublicAddressGuard` pinning, `NTFY_TOKEN` only for `NTFY_SERVER`), `Notification.php`, the `Notifier` interface | Add optional `priority`, `tags`, `click` and `recipients` fields to `Notification`. Contact notifications pass their own recipients (contact settings, falling back to `alerts.*`). |
| Alert state machine | `api/src/Domain/Alerts/AlertEngine.php` (`KINDS`, open/repeat/resolve) | New kind `contact_flood` (warning): opened when the flood breaker pauses the form, resolved when it reopens. |
| Cron and cleanup | `api/src/Infra/CronRunner.php` (jobs alerts, backup, cleanup), `Infra/Maintenance.php` | New job `contact`: notification digest, retention purge, pruning of hashes, sealed data, rate rows and used challenges. |
| Client IP | `Http\Input::clientIp()` = `REMOTE_ADDR` (proxies not trusted) | Also read `REMOTE_PORT` for the sealed evidence (needed behind carrier-grade NAT, §4.8). |
| Body limits, JSON only | `App::decodeJsonBody()` (1 MB), `Input::body()` (415/413/422) | Add a 16 KB cap for `/public/contact`, enforced in a small `PublicLimits` middleware before body parsing. |
| Security headers | `SecurityHeaders` (CORP `same-origin`, CSP `default-src 'none'`) | No change. CORP is only enforced on `no-cors` requests, and the site's `fetch` runs in `cors` mode. |
| Migrations | `api/migrations/0001_init.sql`, `Infra/Migrator`, `AutoSetup` (pending migrations apply on the next request) | `0002_contact.sql` (§3.3). |
| Admin auth, CSRF, JSON-only | `AdminAuth`, `RequireJsonBody`, CSRF header on the `/admin` group | New admin routes go into the same group and are protected automatically. |
| Admin offline cache | `frontend/admin/src/api/persist.ts` (IndexedDB; `meta.persist === false` opts out) | The message queries use `meta: { persist: false }`, so visitor messages are never written to the phone's IndexedDB (§5.4). |
| Site CSP | `backend/src/generator/pages.ts` `buildCsp()` (`connect-src 'self'`, `worker-src 'self'`, no `'unsafe-inline'`); `generator/verify.ts` parses it | Add the API origin to `connect-src` only when contact is on. Everything else stays. |
| Player sheet, focus handling | `frontend/site/src/player/story-sheet.tsx`, `focus-trap.ts`, `restore-focus.ts`, pause reason `'sheet'` in `player/machine.ts` | The contact sheet reuses these. Opening it in the player pauses playback with reason `'sheet'`, which also stops the day-end countdown (`canCountDown`). |
| Profile | `frontend/site/src/profile.tsx` (`useProfile()`: author, intro, avatar) | Button labels and the sheet title use `profile.author`. The hero's `ProfileIntro` deliberately has "no counts, no buttons", so the contact entry points stay out of it. |
| IDs | `api/src/Domain/Ids.php` (`p_`, `e_` + base32) | Message ids `m_` + 12 base32 characters. |
| Backups | API `VACUUM INTO` nightly, `BACKUP_KEEP=14`; the backend pulls them home, `API_BACKUP_KEEP=7` | Retention text: deleted messages can live on in backups for up to 14 days (§5.3). |

Note: the admin already has an **Inbox** (captured statuses). The new screen is therefore called
**Messages / Nachrichten**, so the two are never confused.

---

## 2. UX

### 2.1 Where the button lives

| Place | Form | Behaviour |
|---|---|---|
| **Header** (`site-header.tsx` `HeaderBar`, every page; also the pre-rendered twin in `backend/src/generator/twin.ts`, so it does not jump in when React mounts) | ≥ 640 px: a rose pill `💌 Write to Lea` (`bg-accent`, rose-600 `#BE4A74` with white text, 4.75:1) between the language switch and the theme toggle. < 640 px: a round 40 px button with an envelope-with-heart icon (44 px hit area like the language pills, L3-22) and `aria-label="Write to Lea"`. | It is an `<a href="/{locale}/contact/">` that the SPA intercepts: it opens the sheet and pushes `?write=1`, so Back closes the sheet. Without JS the link opens the contact page, which explains that the form needs JavaScript. |
| **Mobile dock** (timeline, < 640 px) | A round 💌 button docked at the end side of the zoom pill, inside `zoom-pill-dock` (shares its safe-area padding, so nothing overlaps). | It appears only once the header has scrolled out of view (IntersectionObserver), so the contact is always one thumb-tap away. Hidden while the player is open. With reduced motion it fades in instead of popping. |
| **Player ⋯ menu** (`OptionsMenu` in `player/chrome.tsx`) | Menu item `💌 Write to Lea about this moment` under mute and data saver. | Opens the sheet over the player (pause reason `'sheet'`). The reference chip is prefilled with the day and the current item. Closing resumes playback. No extra button on the stage, so tap and swipe zones stay as they are. |
| **Day-end card** (`player/day-end.tsx`) | Under the handwritten sign-off "Thanks for coming along! — Lea": a white-on-plum pill `💌 Write back`. Without a name: `💌 Send a message`. | It is the most natural moment to reply. Opening it stops the 3 s countdown (the `'sheet'` reason makes `canCountDown` false). Reference = the day. |
| **Story sheet** (end of a long story) | A quiet text button: "Write to Lea about this story". | Reference = the story (`p_…`). |
| **Contact page** `/{locale}/contact/` (generated) | The same form, full page. | Target of links in reply e-mails ("write again") and of the no-JS header link. Later the "request access" page (§6). |
| **Footer** (new, small) | `Privacy · Contact` (and `Imprint` if enabled) at the bottom of the timeline and in the sheet. | §5.6/§5.7. |

Labels by profile:

| | with `site.author` | without |
|---|---|---|
| de | „Schreib Lea" / „Lea schreiben" | „Nachricht schreiben" |
| en | "Write to Lea" | "Send a message" |

Optional, owner switch, off by default: a little handwritten "psst … schreib mir ✉︎" sticker
with a doodled arrow next to the header button on the first visit. It is decorative
(`aria-hidden`) and never stored, so it shows on every visit or not at all.

### 2.2 The sheet and the form

The sheet is cream (`#FFF8F6`) with paper grain and a strip of washi tape on top, like the note
cards. The heading is in the hand font (Playpen Sans): **„Ein paar Zeilen an Lea ✉︎" / "A few
lines for Lea ✉︎"**. On phones it is a bottom sheet: a drag handle, swipe down to close, the
`story-sheet.tsx` mechanics, full height when the keyboard opens (`visualViewport`). On ≥ 640 px
it is a centred dialog, `max-w-[32rem]`.

| Field | Rules (client and server) | Notes |
|---|---|---|
| **Name** `name` | required, 1–60 characters after trim, one line | `autocomplete="name"`. Placeholder "z. B. Tante Uschi" / "e.g. Aunt Sue". |
| **E-mail** `email` | optional, ≤ 254, a syntactically valid address (the same `z.email()` as `alerts.email`) | `type="email"`, `inputmode="email"`, `autocomplete="email"`. Hint: "Nur nötig, wenn du eine Antwort möchtest. Wird nie veröffentlicht oder weitergegeben." / "Only if you'd like a reply. Never published or shared." |
| **Message** `message` | required, 2–2000 characters after trim, at most `contact.link_limit` links (default 1) | `dir="auto"`, `lang` = page locale, auto-growing textarea. A counter appears from 1800 characters (`aria-live="polite"`, announced only at 1900 and 2000). |
| **Reference** `ref` | optional `{date: "YYYY-MM-DD", entry?: "e_…" \| "p_…"}` | Shown as a chip with the thumbnail and "Zu: Di., 18. Nov. · Hội An 🇻🇳" / "About: Tue, Nov 18 · Hội An 🇻🇳" plus a ✕. Never typed by the visitor. |
| **Honeypot** `website` | must be empty | Inside a wrapper with `aria-hidden="true"`, `inert`, visually hidden (not `display:none`, which some bots detect), `tabindex="-1"`, `autocomplete="off"`, label "Leave this empty". It is named `website` because naive bots fill it. Password managers rarely fill "website" when `autocomplete="off"` is set: check this in the e2e test with Chromium autofill. |
| **Proof of work** | invisible | It starts solving when the sheet opens. Nothing to click or solve for the visitor (§4.2). |
| *(hidden)* `locale` | the page locale | So replies use the visitor's language. |

Under the button there is a **one-sentence privacy notice** with a link (text in §5.6). There is
**no consent checkbox**: the legal basis is Art. 6(1)(f), not consent (§5.2), and a "I have read
the privacy policy" checkbox only adds friction.

Unsent text lives only in React state. Closing the sheet with text in it asks „Entwurf
verwerfen?" / "Discard your message?". Nothing goes to `localStorage` (§5.5).

### 2.3 States (de / en)

| State | Trigger | UI |
|---|---|---|
| Loading | the sheet opens, `GET /public/contact` runs | The fields are usable at once. In the background the state is fetched and the proof of work starts. |
| Ready | state `open`, challenge solved or still being solved | The submit button `Abschicken 💌` / `Send 💌` is enabled. If it is pressed before the proof of work has finished, it shows a soft spinner „Einen Moment …" / "Just a moment …" and sends automatically once solved (target ≤ 1.5 s on a mid-range phone). |
| Sending | POST is running | The button is busy (`aria-busy`). The fields are read-only, not disabled, so screen readers still read them. |
| **Success** | 202 | The envelope closes and a paper plane flies off along the route thread (with reduced motion: a fade and a ✓). Text: „Danke, {name}! Deine Nachricht ist bei Lea angekommen. 💌" / "Thank you, {name}! Your message has reached Lea. 💌". With an e-mail: „Wenn Lea antwortet, bekommst du eine E-Mail von {neutral address}." / "If Lea replies, you'll get an e-mail from {neutral address}." Buttons: „Noch eine Nachricht" / "Write another" and „Zurück" / "Back". Focus moves to the heading of the success card, announced by `role="status"`. |
| Field errors | client validation, or 422 with `details.fields` | Inline under each field (`aria-invalid`, `aria-describedby`), plus an error summary at the top that takes the focus. „Bitte sag uns deinen Namen." / "Please tell us your name." · „Das sieht nicht nach einer E-Mail-Adresse aus." / "That doesn't look like an e-mail address." · „Höchstens 2 000 Zeichen, bitte." / "2,000 characters at most, please." · „Bitte höchstens einen Link." / "At most one link, please." |
| Too many | 429 + `Retry-After` | „Du hast gerade schon ein paar Nachrichten geschickt. Versuch es bitte in {minutes} Minuten wieder." / "You've just sent a few messages. Please try again in {minutes} minutes." The text stays in the form. |
| Paused | `state: "paused"` (GET), or 503 `contact_paused` | Instead of the form: „Lea macht gerade eine kleine Nachrichtenpause 🌙 Schau später wieder vorbei." / "Lea is taking a little break from messages 🌙 Please check back later." Plus the owner's optional note (per locale, ≤ 160 characters). If the visitor had already typed, the text stays visible and copyable. |
| Closed | `state: "closed"` or 503 `contact_closed`, or the manifest flag off | The same tone, without "later". The header button disappears with the next publish (§3.1). |
| Offline / network error | `fetch` rejects, or no answer within 15 s | „Gerade keine Verbindung. Deine Nachricht bleibt hier stehen – versuch es gleich nochmal." / "No connection right now. Your message is still here, try again in a moment." Retry button. |
| Challenge failed | 400 `challenge_failed` (expired or replayed) | Silently fetch a new challenge, solve it and resend **once**. If that fails too, the generic error. |
| Generic | 5xx | „Das hat leider nicht geklappt. Deine Nachricht ist nicht verloren – probier es bitte nochmal." / "Sorry, that didn't work. Your message isn't lost, please try again." |

All strings go into Lingui (`frontend/site/src/locales/{de,en}/messages.po`, plus pseudo-`ar`
for the RTL check). Names and places are wrapped in `<bdi>`.

### 2.4 Accessibility checklist

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to the heading. Focus trap
  (`player/focus-trap.ts`), focus returns to the opener (`restore-focus.ts`), Esc closes (asks
  first when there is text).
- Visible labels, never placeholder-only. Hints are linked with `aria-describedby`. Required
  fields carry `aria-required` and are marked in words, not only with an asterisk.
- An error summary takes focus on submit. Live regions: `role="status"` for sending and success,
  `role="alert"` for errors.
- Targets ≥ 44 px (WCAG 2.5.8 needs only 24 px; the project uses 44 px, L3-22). Contrast as in
  the dawn and dusk palettes (rose-600 on white 4.75:1, focus ring `#8E6BD6`).
- **No visual captcha.** The proof of work needs no interaction, so it is also fine for blind and
  motor-impaired visitors. The honeypot is invisible to assistive technology (`aria-hidden`,
  `inert`).
- Logical CSS only (RTL). Only the paper-plane animation is mirrored.
- `prefers-reduced-motion`: no flight animation, no pop-in of the dock button.
- Works at 200 % zoom and 320 px width. The sheet scrolls and the button stays reachable above
  the keyboard.

---

## 3. Delivery and storage

### 3.1 Data flow

```
 visitor's browser (static site)                  PHP API (the-on-my-way-api…)              traveler / owner
 ───────────────────────────────                  ────────────────────────────              ────────────────
 manifest.json  site.contact = {endpoint}  ◀── generator (backend) reads Settings "contact.enabled"
     │ button visible?
 open sheet ── GET  /api/v1/public/contact ──▶ {state, note?, challenge, limits}
 solve PoW in a Worker (WebCrypto)
 submit ───── POST /api/v1/public/contact ──▶ checks (§3.2) → contact_messages (SQLite)
     ◀── 202 {ok:true}   (same answer for blocked/filtered/bot)  │
                                                                 ├─▶ after the response (fastcgi_finish_request),
                                                                 │    or at the latest the next cron run:
                                                                 │    ntfy / e-mail "💌 1 new message" ───▶ phone
                                                                 └─▶ admin PWA /admin/messages ◀─── reads, replies
 visitor's mailbox ◀── reply e-mail From: neutral address ◀── POST /admin/messages/{id}/replies
```

- **Button visibility** comes from the static manifest, so viewing stays API-free. New field
  `SiteInfo.contact?: { endpoint: string }` (`packages/contracts/src/site.ts`). The generator
  sets it when the setting `contact.enabled` is true and a public API URL is known: the backend's
  `API_BASE_URL`, or a new optional `PUBLIC_API_URL` when the backend talks to the API over
  another URL. `manifest.json` is fetched with `no-store`, so switching off takes effect with the
  next publish (about a minute while the backend runs).
- **The live state** (open, paused, closed, the note) comes from `GET /public/contact` every time
  the sheet opens. A pause therefore takes effect immediately, even while the backend sleeps.
- **CSP** of the generated pages (`buildCsp()`): `connect-src 'self' https://the-on-my-way-api.schaefchens.de`
  only when contact is on. `worker-src 'self'` is enough, because the solver worker is a
  Vite-built file in `/assets/`. Use the SHA-256 or PBKDF2 algorithm, which runs on WebCrypto
  and needs no WASM, so no `'wasm-unsafe-eval'` is needed. ALTCHA's Argon2 and Scrypt modes use
  `hash-wasm` and would need it, so don't use them. Update `generator/verify.ts` and its test.
- **The request** is `fetch(endpoint, {method:'POST', mode:'cors', credentials:'omit',
  referrerPolicy:'strict-origin', headers:{'Content-Type':'application/json'}})`. No cookies.

### 3.2 Public endpoints

`GET /api/v1/public/contact?locale=de` returns `200 ContactState`:

```jsonc
{
  "state": "open",                       // "open" | "paused" | "closed"
  "note": "Bin bis Sonntag offline 🌴",   // owner's note in the requested locale, optional
  "pausedUntil": null,                   // ISO, when auto-pause or the owner set an end
  "purposes": ["message"],               // + "follow_request" once access control exists (§6)
  "limits": { "name": 60, "message": 2000, "links": 1 },
  "challenge": { /* ALTCHA challenge object, absent unless state = "open" */ }
}
```

`POST /api/v1/public/contact` takes `ContactMessageCreate`:

```jsonc
{
  "purpose": "message",                  // or "follow_request"
  "name": "Tante Uschi",
  "email": "uschi@example.org",          // optional
  "message": "Was für ein schöner Sonnenuntergang!",
  "locale": "de",
  "ref": { "date": "2026-11-18", "entry": "e_abcdefghijkl" },   // optional
  "website": "",                          // honeypot
  "altcha": "<base64 payload>"            // proof-of-work solution
}
```

Answers:

| Status | Body | When |
|---|---|---|
| **202** | `{"ok":true}` | Accepted, **and also** for a filled honeypot, a submit faster than the minimum fill time, a blocked sender or a filtered message (all silent). |
| 400 | `challenge_failed` | Missing, invalid, expired or already used proof of work. |
| 403 | `origin` | The `Origin` header is missing or is not `SITE_ORIGIN`. Cheap against naive scripts; trivial to forge outside a browser. |
| 413 / 415 | as in `Input::body()` | Body > 16 KB, or not JSON. |
| 422 | `validation_failed` + `details.fields` | Lengths, e-mail syntax, link limit. Honest users get help here; content filters are **not** reported here (they work silently). |
| 429 | `rate_limited` + `Retry-After` | §4.3. |
| 503 | `contact_paused` / `contact_closed` | §4.6. |

**Order of checks** (cheap first; nothing is written before the proof of work is valid):

```php
// Http/Public/ContactController::create()
origin === SITE_ORIGIN                       else 403
Content-Length ≤ 16 KB, JSON, schema         else 413/415/422 (schema = ContactMessageCreate)
state open?                                   else 503
honeypot empty?                               else 202 + counter++ (nothing stored)
challenge signature + not expired (ALTCHA)    else 400
submittedAt − challenge.issuedAt ≥ 3 s?       else 202 silently (nothing stored)
BEGIN IMMEDIATE
  mark challenge used (INSERT … contact_challenges_used; conflict = replay) else 400
  rate limits (network, e-mail, global)       else 429   (global overflow → flood breaker, §4.6)
  validation: lengths, links                  else 422
  block lists (e-mail HMAC, network HMAC)     → store in folder "blocked" or drop (owner's choice)
  filters (words, duplicates)                 → folder "filtered", filter_reason
  INSERT contact_messages (folder "inbox")
COMMIT
respond 202; fastcgi_finish_request(); try the notification digest (§3.4)
```

The response does not depend on the outcome (blocked, filtered or accepted), and notifications
are sent after the response. The timing therefore differs only by a few milliseconds of DB work,
far below network jitter. That is good enough, not perfect.

### 3.3 Storage: migration `api/migrations/0002_contact.sql`

```sql
-- Messages from the public contact form (contracts ContactMessageCreate / AdminMessage).
-- Not owner content: never appended to change_log, never mirrored to the backend.
CREATE TABLE contact_messages (
    id               INTEGER PRIMARY KEY,
    public_id        TEXT NOT NULL UNIQUE CHECK (public_id GLOB 'm_?*'),
    purpose          TEXT NOT NULL DEFAULT 'message' CHECK (purpose IN ('message', 'follow_request')),
    folder           TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'archived', 'filtered', 'blocked')),
    filter_reason    TEXT CHECK (filter_reason IS NULL OR filter_reason IN
                       ('links', 'words', 'duplicate', 'blocked_email', 'blocked_network')),
    name             TEXT NOT NULL,
    email            TEXT,                         -- as entered (trimmed); NULL = no reply possible
    email_hash       TEXT,                         -- HMAC-SHA256(contact key, normalized e-mail), hex
    body             TEXT NOT NULL,
    body_sha256      TEXT NOT NULL,                -- integrity for evidence exports
    how_known        TEXT,                         -- follow requests only (§6)
    locale           TEXT NOT NULL,
    ref_date         TEXT CHECK (ref_date IS NULL OR ref_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    ref_entry        TEXT,                         -- e_… / p_… (validated as an id, not for existence)
    net_hash         TEXT,                         -- HMAC-SHA256(contact key, IPv4 /32 | IPv6 /64); NULLed after 14 days unless evidence
    net_sealed       BLOB,                         -- sodium sealed box {ip, port, ua, at} to the owner's public key; NULLed after 14 days unless evidence
    safety_hint      INTEGER NOT NULL DEFAULT 0,   -- 1 = asks for location / meeting (heuristic, §4.4)
    received_at      TEXT NOT NULL,
    read_at          TEXT,
    archived_at      TEXT,
    evidence_at      TEXT,                         -- "keep as evidence": exempt from auto-delete
    notified_at      TEXT,
    last_activity_at TEXT NOT NULL                 -- retention clock (received, replied, moved)
);
CREATE INDEX contact_messages_folder ON contact_messages (folder, received_at DESC);
CREATE INDEX contact_messages_email_hash ON contact_messages (email_hash) WHERE email_hash IS NOT NULL;
CREATE INDEX contact_messages_net_hash ON contact_messages (net_hash) WHERE net_hash IS NOT NULL;
CREATE INDEX contact_messages_unnotified ON contact_messages (received_at) WHERE notified_at IS NULL AND folder = 'inbox';

CREATE TABLE contact_replies (
    id          INTEGER PRIMARY KEY,
    message_id  INTEGER NOT NULL REFERENCES contact_messages (id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    locale      TEXT NOT NULL,
    mode        TEXT NOT NULL CHECK (mode IN ('mailbox', 'noreply')),
    status      TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
    error       TEXT,
    sent_at     TEXT NOT NULL
);

CREATE TABLE contact_blocks (
    id                INTEGER PRIMARY KEY,
    kind              TEXT NOT NULL CHECK (kind IN ('email', 'network')),
    value_hash        TEXT NOT NULL,                -- same HMAC as email_hash / net_hash
    label             TEXT NOT NULL,                -- masked for display: "ma•••@gmx.de", "Verbindung vom 18.11., 21:04"
    action            TEXT NOT NULL DEFAULT 'quarantine' CHECK (action IN ('quarantine', 'discard')),
    note              TEXT,
    source_message_id INTEGER REFERENCES contact_messages (id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL,
    expires_at        TEXT,                         -- e-mail: NULL (until unblocked); network: default +7 days
    UNIQUE (kind, value_hash)
);

-- Sliding-window rate limiting (Infra\RateLimiter buckets "contact.net", "contact.email", "contact.global").
CREATE TABLE rate_hits (
    id     INTEGER PRIMARY KEY,
    bucket TEXT NOT NULL,
    key    TEXT NOT NULL,                           -- HMAC or '*' (global); never a raw IP
    at     TEXT NOT NULL
);
CREATE INDEX rate_hits_bucket ON rate_hits (bucket, key, at);

-- ALTCHA replay protection: one row per solved challenge until it expires.
CREATE TABLE contact_challenges_used (
    signature  TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
);

-- Contact settings: API-only (not in `settings`, so they are not on the change feed and the
-- backend never mirrors filter words or notification targets). Only "contact.enabled" lives in
-- `settings`, because the generator needs it.
CREATE TABLE contact_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
);
```

**Secrets.** The HMAC key for `email_hash`, `net_hash` and the rate keys, and the ALTCHA HMAC
key, are generated by the API on first use into `var/contact-keys.json` (mode 600). `var/` is
already denied over HTTP and is part of the nightly backup. The remote `.env` therefore needs no
change: `scripts/deploy-api.ts` writes `.env` only on the first deploy. The **evidence public
key** (X25519, base64) is pasted into the admin contact settings, or set with
`deploy-api.ts --set-evidence-key=`. The matching **private key** never leaves the owner's Mac
(`.secrets/contact-evidence.key`, made by `scripts/contact-keys.ts`). `bin/doctor.php` gets a
check for `ext-sodium` (bundled with PHP ≥ 7.2 on most builds, but optional at compile time:
verify on the Hetzner account). Without sodium the form still works; it only stores no sealed
network data.

### 3.4 Notifying the traveler

- **Channels:** the existing ones. Contact settings `notify_email` and `notify_ntfy_url` fall
  back to `alerts.email` and `alerts.ntfy_url`. The traveler can then get her own ntfy topic
  while technical alerts keep going to the owner, if they are not the same person. The same
  safety rules apply: `PublicAddressGuard`, and `NTFY_TOKEN` only for `NTFY_SERVER`.
- **When:** right after the 202 (`fastcgi_finish_request()`; Hetzner runs PHP-FPM), otherwise at
  the next cron run. **At most one push per 10 minutes.** Later ones become a digest ("💌 3 new
  messages"). Messages in `filtered` and `blocked` never notify.
- **Content, setting `notify_preview`:**
  - `none` (**default**): title "💌 Neue Nachricht" / "💌 New message", body "Öffne Nachrichten
    im Admin." and nothing else. ntfy topics are readable by anyone who knows or guesses the
    topic name ([ntfy docs](https://docs.ntfy.sh/): "topic names are public"), and ntfy.sh is a
    third party. A message from a harasser also never lands on the lock screen unasked.
  - `name`: plus the sender's name and the reference ("von Tante Uschi · zu Di., 18. Nov.").
  - `full`: plus the first 200 characters. Only sensible with a self-hosted, token-protected ntfy
    or for the e-mail channel. The admin explains this next to the option.
- ntfy headers: `Priority: default`, `Tags: love_letter`, `Click: <APP_URL>/admin/messages/m_…`.
  This needs the new optional fields on `Notification`. Today `ChannelNotifier` maps severity
  only to high/urgent and the tags warning/rotating_light.
- **Optional forwarding by e-mail** (`deliver: "forward"`): each inbox message is also e-mailed
  to the traveler's own address, with `From` and `Reply-To` set to the **neutral** address. If
  she presses "Reply" in her mail app, the mail goes to the neutral mailbox, **not** to the
  visitor. The visitor's address appears only in the body, with a hint: „Bitte über den Admin
  antworten – sonst sieht die Person deine Adresse." / "Please reply from the admin, otherwise the
  sender sees your address." This is for a traveler who does not use the admin.

### 3.5 Admin: Messages

**Routes** (`frontend/admin/src/router.tsx`): `/messages?folder=&purpose=`,
`/messages/$id`, `/messages/blocked`. Contact settings are a new section in `/settings`.

**Navigation:** the side navigation (≥ 1024 px) gets a "Messages" entry with an unread count.
The **mobile tab bar stays as it is** (Home · Inbox · ✍ · Days · Settings: there is no room for
a sixth item at 360 px). Instead:
- the Home tab shows a rose dot when there are unread messages;
- Home shows a card on top, „💌 2 neue Nachrichten" / "💌 2 new messages", which opens the list.

This needs a field `contact: {unread, filtered, state, pausedUntil} | null` in
`StatusResponse`, so Home makes no extra request. If the owner prefers a real tab: replace
"Days" with "Messages" and reach Days and Trips from Home. Open question, §9.

**List** (`screens/messages.tsx`):
- Folder chips: **Inbox** (unread first, then newest), **Archived**, **Filtered** (with the reason
  "links", "words" or "duplicate"), **Blocked**, and a cross-folder filter **Evidence**.
- Each row shows the name, the first line (plain text), the reference chip, the time, an unread
  dot, an ✉︎ icon when an e-mail was given, a 🛡 icon when the safety hint is set, and "+2 more
  from this sender" when other messages share `email_hash` or `net_hash`.
- Swipe actions as in the captures Inbox: end side = archive, start side = mark read/unread.
  Delete only from the detail view.

**Detail** (`/messages/$id`):
- The message is rendered as **plain text** (`dir="auto"`, `white-space: pre-wrap`).
  **Links are not clickable**: they are shown as text with a "copy" button, against phishing.
- Reference: the thumbnail from the private preview (`/admin/captures/{sourceKey}/preview`) and a
  link to the day in the admin.
- **Safety hint banner** (when `safety_hint = 1`): „Fragt nach deinem Aufenthaltsort oder einem
  Treffen. Antworte nur, wenn du sicher weißt, wer das ist." / "Asks where you are or to meet.
  Only reply if you know for sure who this is."
- Actions:
  - **Reply** (disabled without an e-mail: "No e-mail address given");
  - Mark unread, Archive;
  - **Delete** (undo snackbar for 10 s, then a hard delete; evidence messages ask a second time);
  - **Block sender …**;
  - **Keep as evidence** (toggle);
  - Not spam (from Filtered);
  - **Export** (for one message, or for "all from this sender").
- Thread: the sent replies with time and status (`sent` / `failed` + retry).

**Block sheet:**
- ☑ „Diese E-Mail-Adresse blockieren" (if there is one) and ☑ „Diese Verbindung 7 Tage
  blockieren" (only while `net_hash` exists, i.e. ≤ 14 days after the message).
- What happens to their future messages: **„Still ablegen (als Beweis)"** (default, folder
  `blocked`, no notification) or **„Verwerfen"**.
- An honest note about the limits: „Eine neue E-Mail-Adresse oder ein anderes Netz umgeht die
  Sperre. Die Person erfährt nicht, dass sie blockiert ist." / "A new e-mail address or another
  network gets around the block. The person does not learn that they are blocked."
- `/messages/blocked` lists the blocks with their masked labels and expiry, and lets the owner
  unblock.

**Contact settings section** (`screens/settings.tsx`, new `Section` "Contact form"):

| Setting | Default | Notes |
|---|---|---|
| Contact form on | off (the owner switches it on) | `settings` key `contact.enabled`. Change feed → the button appears or disappears with the next publish. |
| Pause | – | „1 Stunde · 1 Tag · 1 Woche · bis …" → `paused_until`. Optional note per locale (≤ 160 characters). |
| Close | – | `state: closed` plus a note. The button stays until `contact.enabled` is switched off. |
| Auto-pause after a flood | on: > 20 accepted messages in 15 min → pause 60 min | §4.6. |
| Notify | ntfy and/or e-mail, falling back to the alert channels; preview `none` | §3.4. |
| Forward to e-mail | off | §3.4. |
| Reply mode | `mailbox` if `CONTACT_REPLY_TO` is configured, otherwise `noreply` | §3.6. Display name of the sender, e.g. „Lea (On My Way)". |
| Retention | 6 months (choices 1, 3, 6, 12, 24) | §5.3. |
| Link limit | 1 (0–3) | §4.4. |
| Filter words | empty list (one per line, ≤ 200 entries) | §4.4. |
| Evidence key | – | Public key (paste) plus the fingerprint for comparison. Without it, no network data is stored. |
| Privacy page details | – | Controller name, contact e-mail, optional c/o postal address, supervisory authority (§5.6). |

**Phone privacy:** every message query sets `meta: { persist: false }` (`api/persist.ts`). Lists
and bodies are therefore not stored in IndexedDB, and a deleted message is really gone from the
phone. The cost: messages cannot be read offline. The service worker already never caches
`/api/…`.

### 3.6 Replying without exposing the traveler

`POST /api/v1/admin/messages/{id}/replies` takes `{ "body": "…", "locale": "de" }` and returns
`201 MessageReply`, or `409 no_email` / `502 mail_failed` (stored as `failed`, can be retried).

The mail is built by a new `Domain\Contact\ReplyMailer`. The transport from `ChannelNotifier`
moves into an `Infra\MailSender` that both use.

```
From:      "Lea (On My Way)" <post@schaefchens.de>      ← CONTACT_FROM (operator config, .env)
Reply-To:  post@schaefchens.de                          ← mode "mailbox": CONTACT_REPLY_TO, a neutral mailbox
           (none)                                       ← mode "noreply": From = no-reply@…, no Reply-To
To:        uschi@example.org
Subject:   Re: Deine Nachricht an Lea
Body:      <the reply>
           ---
           Deine Nachricht vom 18.11.2026: „Was für ein schöner Sonnenuntergang!" (first 300 characters)
           [noreply] Antworten auf diese E-Mail kommen nicht an. Schreib gern wieder über
                     https://the-on-my-way-website.schaefchens.de/de/contact/
```

Rules:
- `CONTACT_FROM` and `CONTACT_REPLY_TO` are **operator settings in `.env`**, not admin settings.
  Whoever holds an admin token can then not make the API send mail with an arbitrary `From`.
  The domain must authorize the SMTP account behind `MAIL_DSN`: SPF, plus DKIM activated in
  konsoleH, plus a DMARC record
  ([Hetzner: DKIM, SPF, DMARC](https://docs.hetzner.com/konsoleh/account-management/email/mailsecurity)),
  otherwise the replies end up as spam.
- **Mailbox mode** is a real dialogue. The visitor's answer lands in a neutral mailbox (for
  example `post@…` on the Hetzner account) that the traveler can add to her phone's mail app,
  separate from her private address. It is not a relay: the API never sends to arbitrary
  recipients on its own.
- **No-reply mode** works one way. The mail says that answers are not read and links to the form.
  The envelope sender (`Return-Path`) should still be a mailbox that accepts bounces.
- No HTML tracking, no read receipt, no pixel. Plain text (plus an optional simple HTML part with
  the same content).
- The mail is created **on the server**: neither the traveler's IP address nor her device appear
  in the headers, only the API host's mail relay.
- **No automatic confirmation mail** to the visitor after sending, ever. Otherwise the form could
  be used to send mail to strangers ("subscription bombing") and to test addresses.
- The reply quotes at most 300 characters of the original, so the API cannot be used to bounce
  long spam texts.
- Replies count as activity (`last_activity_at`) and are deleted together with the message.
- The admin warns once before the first reply: „Deine Antwort verrät nichts über deinen Ort –
  außer, du schreibst ihn hinein." / "Your reply reveals nothing about where you are, unless you
  write it."

---

## 4. Abuse protection without third-party captchas

### 4.1 Layers at a glance

| Layer | Stops | Does **not** stop |
|---|---|---|
| CORS + `Origin` check + JSON-only | cross-site form posts, naive form-spam scripts | any non-browser client that sets the `Origin` header (trivial) |
| Honeypot | form-filling bots that fill every field | targeted bots, headless browsers that respect visibility |
| Minimum fill time (3 s after the challenge) | bots that post at once | scripts that simply wait. Also: a human who pastes a prepared text within 3 s gets a silent drop, which is why the limit is lenient. |
| Proof of work (ALTCHA) | mass spam: every message costs ~1 s of CPU in a browser | humans; a determined attacker with real CPUs (hundreds of messages are still cheap for them). **It does nothing against a single stalker.** |
| Rate limits per network | floods from one connection | VPN, Tor, mobile IP changes, IPv6 address rotation. It also hits innocent people behind the same carrier-grade NAT, hence the moderate limits. |
| Rate limit per e-mail | floods with the same address | e-mail is optional: leaving it empty bypasses this bucket |
| Global limit + auto-pause | floods from many sources (botnet) | an attacker who **wants** to close the form: they can trigger the pause on purpose (a DoS on the form, not on the site) |
| Length and link limits | link spam, novels | short abusive messages |
| Word filters, duplicates | known spam phrases, copy-paste floods | rewording, typos, other languages, emoji. False positives possible, hence "Filtered" instead of deleting. |
| Block lists (e-mail, network) | the same person on the same address or network | a new address or another network. No fingerprinting, on purpose (§4.5). |
| Silent block | the harasser escalating because they notice the block | them writing again; it also tells them nothing |
| Pause, close, access control | everything above, completely | – (the price: friends cannot write either) |

### 4.2 Proof of work: ALTCHA, self-hosted

What it is: the API signs a challenge (HMAC), the browser searches for a number whose hash meets
the challenge, and the API checks it in microseconds. No third party, no cookies, no tracking.

**Licence and maturity (checked 2026-11-20):**

| | Finding | Source |
|---|---|---|
| Licence | MIT for the widget, the server and the client libraries | [altcha.org/open-source-captcha](https://altcha.org/open-source-captcha/), [GitHub altcha-org/altcha](https://github.com/altcha-org/altcha), [GitHub altcha-lib-php](https://github.com/altcha-org/altcha-lib-php) |
| PHP library | `altcha-org/altcha`, PHP ≥ 8.1, **latest 2.4.0 (2026-11-17)**, ~2.2 M installs, 42 dependents. Argon2id needs `ext-sodium`. | [Packagist](https://packagist.org/packages/altcha-org/altcha) |
| Widget | npm `altcha` 3.7.0, MIT, one runtime dependency (`hash-wasm`), exports `./external`, `./workers/*`, `./lib`, `./i18n/*`. 34 kB gzipped (52 kB with all translations). Vendor claims WCAG 2.2 AA. | [npm registry](https://registry.npmjs.org/altcha/latest), [README 3.7.0](https://unpkg.com/altcha@3.7.0/README.md) |
| Strict CSP | the default bundle starts its worker from a `blob:`, so use `altcha/external` with separate worker and CSS files. Argon2/Scrypt need extra workers (WASM). | [ALTCHA CSP docs](https://altcha.org/docs/v2/content-security-policy-csp), README |
| Security history | **CVE-2025-68113 / GHSA-6gvq-jcmp-8959** (2025-12-16): the challenge parameters were not bound to the HMAC, so solutions could be replayed with a changed expiry; PHP fixed in 1.3.1. **CVE-2026-71481 / GHSA-82w8-65qw-gch6** (published **2026-11-18**): `verifySolution` in v2.0.0–2.0.2 skipped the HMAC check when the payload had no signature (full bypass, CVSS 7.5); fixed in 2.0.3. | [OSV GHSA-6gvq-jcmp-8959](https://osv.dev/vulnerability/GHSA-6gvq-jcmp-8959), [OSV GHSA-82w8-65qw-gch6](https://osv.dev/vulnerability/GHSA-82w8-65qw-gch6) |

**Assessment:** widely used, MIT, actively maintained. Two signature/replay flaws in twelve months
show that this code is security-sensitive. Therefore:
1. `composer require altcha-org/altcha:^2.4` (≥ 2.0.3 is a must). Run `composer audit` in CI.
2. **Own tests** for a payload without a signature, a foreign signature, a changed expiry, an
   expired payload and a replay. They must fail closed, independent of the library.
3. **Own replay table** (`contact_challenges_used`; the PHP library documents no replay
   protection of its own). Challenge expiry: 30 minutes.
4. Bind the challenge to the purpose (`data: {p: "contact"}`) and to the issue time, which is
   used for the minimum fill time.
5. **Spike (S, about 2 h):** confirm that widget 3.x and lib-php 2.4 speak the same protocol, and
   tune the cost so that a mid-range Android phone needs about 0.5–1.5 s. If widget 3.x and the
   PHP library do not match, pin the widget major that matches, or use the headless solver from
   `altcha/lib`.

**Integration (recommended): headless.** The ALTCHA widget UI is not used. A small `usePow()`
hook starts a module worker (`altcha/lib` solver, SHA-256 or PBKDF2 over WebCrypto), lazy-loaded
with the sheet. The site's own soft UI shows nothing at all, or the "Just a moment …" state. The
contact chunk stays well under the player budget (≤ 45 kB), and the initial bundle grows by 0 kB.

**Alternatives considered:**
- **Cap** (Apache-2.0, SHA-256 proof of work) has only a Node server library, so it would need a
  PHP port ([GitHub tiagozip/cap](https://github.com/tiagozip/cap),
  [trycap.dev](https://trycap.dev/about)).
- **Friendly Captcha**: the widget is open source, but the verification backend is proprietary
  and hosted, i.e. a third party ([Friendly Captcha on open source](https://friendlycaptcha.com/insights/open-source-captcha/)).
- **Own hashcash** (~150 lines): possible, but the ALTCHA advisories show how easy binding and
  replay are to get wrong. Better to use the maintained library plus our own tests.

### 4.3 Rate limits

`Infra\RateLimiter` is extracted from `LoginThrottle`. Check and record happen in one
`BEGIN IMMEDIATE`, so parallel requests count each other. Only accepted attempts count, or
attempts that passed the proof of work. Keys are HMACs, never raw IPs.

| Bucket | Key | Limit | Answer |
|---|---|---|---|
| `contact.net` | `net_hash` (IPv4 /32, IPv6 /64) | 3 per 10 min, 8 per 24 h | 429 + `Retry-After` |
| `contact.email` | `email_hash` | 5 per 24 h | 429 |
| `contact.global` | `*` | 20 per 15 min | the flood breaker (§4.6), then 503 `contact_paused` |
| `contact.notify` | `*` | 1 push per 10 min | digest |

The limits are constants with tests, like `LoginThrottle::MAX_PER_IP`. The global threshold is a
contact setting. `rate_hits` rows are deleted after 48 h (cron).

### 4.4 Content rules

- **Lengths:** name ≤ 60, message 2–2000, e-mail ≤ 254, `how_known` ≤ 280. Normalization:
  Unicode NFC; zero-width and bidi control characters are removed from the name (against
  spoofing in the admin list); the message keeps its line breaks.
- **Links:** count `https?://`, `www.` and bare `domain.tld/path` patterns. Over the limit the
  visitor gets 422 with help ("At most one link, please"). With `link_limit = 0`, messages with a
  link go to `filtered`.
- **Words:** the owner's list (case-insensitive after NFKC folding). A match moves the message to
  `filtered` (reason `words`), never deletes it. Default empty, because generic spam word lists
  produce false positives in de/en/vi.
- **Duplicates:** the same `body_sha256` (after whitespace normalization) within 24 h, from
  anyone, goes to `filtered` (reason `duplicate`).
- **Safety hint** (not a filter): a small word list in de/en ("wo bist du", "where are you",
  "hotel", "adresse", "address", "treffen", "meet", "welche stadt", "which city" …) sets
  `safety_hint`. The admin then shows the 🛡 banner. Purely a heuristic.
- Filters never reach the visitor (202), so spammers cannot tune against them.

### 4.5 Block lists (fingerprint-free)

- **E-mail:** `HMAC(key, lowercase(trim(email)))`, plus a masked label for display. Valid until
  the owner unblocks it. **Not normalized** for `+tags` or Gmail dots: it is cheap to get around
  either way, and normalizing would wrongly merge distinct addresses.
- **Network:** the `net_hash` of a message, only while it exists (≤ 14 days after the message).
  Expires after 7 days by default (IPs get reassigned; carrier-grade NAT shares IPs).
- **Deliberately not used:** browser fingerprinting (canvas, fonts, UA hashes), cookies,
  `localStorage` ids. They would be personal data on the visitor's device (TDDDG § 25) and would
  still be easy to get around. Consequence, said honestly: **someone with a new address and a new
  network is not recognized.** The last line of defence is a pause, closing the form, or the
  access-controlled mode.
- **Action** per block: `quarantine` (default; stored silently in `blocked` as evidence, no
  notification, deleted by retention unless evidence) or `discard` (nothing is stored; only a
  counter on the block).
- **Hashes are pseudonyms, not anonymous data.** Whoever holds the key can try all ~4 billion
  IPv4 addresses. Hashes therefore count as personal data and get short retention (§5.4). See
  the [AEPD/EDPS paper on hashing](https://edps.europa.eu/data-protection/our-work/publications/papers/introduction-hash-function-personal-data_en).

### 4.6 Mute, close, auto-pause

- **Pause** (owner, with an end, `paused_until`): the GET returns `paused` with the note, and the
  POST answers 503. Viewing the site is not affected.
- **Close** (owner, open-ended): the same, with the "closed" wording. Switching `contact.enabled`
  off also removes the button with the next publish and drops the API origin from the CSP.
- **Flood breaker** (automatic): when the global bucket overflows, `paused_until = now + 60 min`
  (configurable 15 min–24 h). An alert `contact_flood` (warning) opens through the existing
  `AlertEngine`: one notification, resolved when the pause ends. Messages accepted before the
  overflow stay. Limit, said honestly: an attacker can trigger this pause on purpose. That is
  accepted, because the alternative is a full inbox.
- **Mute notifications** without closing: notifications `off` (messages still arrive, silently).

### 4.7 What the form itself does not protect against

- **Social engineering:** "Hi, it's your cousin, where are you staying tonight?". The safety-hint
  banner and the advice in the admin help; the decision is the traveler's.
- **Information on the site itself** (the "here now" chip, instant publishing, photos with
  recognizable places): the protection part of wave 5 covers this, not this form.
- **Replies:** anything written in a reply is known to the recipient. A reply also confirms that
  messages are read, which can encourage a stalker.
- **Threats outside the form** (WhatsApp, Instagram, e-mail to known addresses).

### 4.8 Persistent harasser: block, keep evidence, export for the police

**In the admin (minutes):**
1. **Do not reply.** Do not confront.
2. **"Keep as evidence"** on every message of that person. This stops automatic deletion of the
   message **and** of its sealed network data (otherwise deleted after 14 days).
3. **Block** e-mail and network with the action "store silently". Further messages keep arriving
   as evidence, without any notification.
4. If necessary: **pause** the form, switch to delayed publishing, hide the "here now" chip
   (protection part).

**Export (within days, not weeks):**
5. In the admin, "Export for the police" (one message or all from this sender) produces a JSON
   file plus a printable HTML report. Per message it contains:
   - `public_id`, the receive time in UTC and Europe/Berlin, name, e-mail, the text and
     `body_sha256`;
   - the reference and folder history;
   - `net_sealed` (still sealed);
   - the export time, and a SHA-256 of the whole export.
6. On the Mac: `pnpm contact:evidence <export.json>` (`scripts/contact-evidence.ts`, using the
   private key in `.secrets/contact-evidence.key`) opens the sealed boxes. The report then also
   shows the **IP address, source port, User-Agent and the exact time** of each message.
   - **The port matters:** behind carrier-grade NAT (mobile networks) an IP address plus a time
     often does not identify a subscriber; the source port is needed as well. The draft German IP
     retention law also speaks of storing „IP‑Adressen und gegebenenfalls Portnummern"
     ([beck-aktuell, 2026-04-22](https://www.beck-aktuell.de/heute-im-recht/rechtspolitik-gesetzgebung/regierung-gesetzentwurf-ip-speicherpflicht-2026-04-22)).
   - **Speed matters:** today providers keep IP assignments for at most about seven days
     ([Bundestag hearing 2026-10-07](https://www.bundestag.de/dokumente/textarchiv/2026/kw41-pa-recht-ip-adressspeicherung-1221516);
     the BGH allowed seven days for operational purposes in
     [III ZR 391/13](https://netzpolitik.org/2014/bundesgerichtshof-provider-duerfen-ip-adressen-sieben-tage-vorratsdatenspeichern-aber-nur-fuer-netzbetrieb/)).
     A three-month IP retention (Drucksache 21/6581) is **still in committee** as of the hearing on
     2026-10-07, not law.
7. Plus screenshots from the admin (with the device clock visible).

**Report:**
8. To the online police station of the federal state (Onlinewache) or the local station. Possible
   offences are
   [§ 238 StGB Nachstellung](https://www.gesetze-im-internet.de/stgb/__238.html) (stalking,
   including repeated contact attempts by telecommunication),
   [§ 241 StGB Bedrohung](https://www.gesetze-im-internet.de/stgb/__241.html) (threats) and
   [§ 185 StGB Beleidigung](https://www.gesetze-im-internet.de/stgb/__185.html) (insult). An
   insult is prosecuted only on application, and the application must be filed **within three
   months** ([§ 77b StGB](https://www.gesetze-im-internet.de/stgb/__77b.html)).
9. Help: [HateAid](https://hateaid.org/) (counselling for digital violence, securing evidence,
   funding of legal costs), Weisser Ring. If the person is known, a protection order under the
   [Gewaltschutzgesetz § 1](https://www.gesetze-im-internet.de/gewschg/__1.html) (contact ban)
   is possible.
10. Protect the home address: an **Auskunftssperre** in the population register
    ([§ 51 BMG](https://www.gesetze-im-internet.de/bmg/__51.html): blocks register information
    when there is a danger, e.g. from stalking; free of charge; two years, renewable).

**Limits, said honestly:**
- **Evidence integrity:** SHA-256 per message and per export shows later changes, but it is not
  a qualified timestamp and not forensic chain-of-custody. For the police it is usually enough.
- **VPN or Tor:** the IP address is worthless.
- **A lost private key** means the sealed network data cannot be read.
- **Investigations** into low-level harassment are often dropped.

---

## 5. GDPR and German law (not legal advice)

> Everything in this section is a technical and organizational assessment based on public sources,
> **not legal advice**. Before going live publicly, have it checked by a lawyer or at least compare
> it with a reputable generator (e.g. the e-recht24 privacy generator).

### 5.1 Does the GDPR apply at all?

Yes, assume it does. The household exemption (Art. 2(2)(c) GDPR) covers purely personal
activities. Making personal data available on the internet to an indefinite number of people is
not covered; that is the CJEU's line since *Lindqvist* (C-101/01; see
[curia press release](https://curia.europa.eu/en/actu/communiques/cp03/aff/cp0396en.htm) and the
[Irish DPC FAQ](https://dataprotection.ie/en/faqs/general/what-household-exemption)). A contact
form open to anyone also processes strangers' data. IP addresses are personal data
(CJEU *Breyer*, [C-582/14](https://curia.europa.eu/juris/liste.jsf?num=C-582/14)). GDPR text:
[EUR-Lex 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj).

### 5.2 Legal basis

- **Receiving, storing and answering the message:** Art. 6(1)(f): the legitimate interest in
  receiving and answering messages that visitors send of their own accord. Art. 6(1)(b) does not
  fit, because there is no contract. **Consent (lit. a) is not needed and not advisable**: it can
  be withdrawn at any time and adds a checkbox
  ([IT-Recht Kanzlei](https://www.it-recht-kanzlei.de/dsgvo-datenschutz-kontaktformular-keine-einwilligung.html),
  [Dr. Datenschutz](https://www.dr-datenschutz.de/kontaktformulare-aber-mit-welcher-rechtsgrundlage/)).
- **Abuse protection** (hashes, rate limits, proof of work, sealed network data): Art. 6(1)(f),
  the legitimate interest in protecting the traveler and the service from spam and harassment and
  in being able to assert legal claims. Keeping evidence beyond the normal period: Art. 17(3)(e).
- **Balancing test (documented in `docs/PRIVACY.md`):**
  - the visitor writes voluntarily;
  - minimal fields, e-mail optional;
  - no tracking, no third parties for the content;
  - network data is short-lived and sealed;
  - the owner can decide only on the content, there is no automated decision with legal effect
    (filters only move messages into folders that a human reads; Art. 22 is not touched).
- **Special categories** (health and the like, when a visitor writes about them): incidental, not
  requested. Treat them with the same retention.

### 5.3 Data inventory and retention

| Data | Purpose | Where | Deleted |
|---|---|---|---|
| Name, message, reference, locale | deliver and answer the message | API SQLite (Hetzner, Germany) | **6 months** after the last activity (setting 1–24), at once on "delete", or on request |
| E-mail (optional) | reply | same | same |
| Replies | conversation | same | together with the message |
| `email_hash` | block list, grouping | same | together with the message; on a block entry: until unblocked |
| `net_hash` (HMAC of IP /32 or /64) | rate limit, network block | message row, `rate_hits`, `contact_blocks` | `rate_hits` after **48 h**; message row after **14 days**; block after **7 days** |
| `net_sealed` (IP, port, UA, time; encrypted to the owner) | evidence against abuse | message row | after **14 days**, unless marked as evidence |
| Evidence messages | legal claims, criminal complaint | same | when the owner removes the mark. The admin reminds every 6 months: "still needed?" |
| Messages in `filtered` | spam review | same | after **30 days** |
| Used challenges | replay protection | `contact_challenges_used` | at expiry (30 min) |
| Database backups | recovery | API host `var/backups` (14), owner's Mac (7) | the backups expire, i.e. **up to 14 days** after deletion |
| Web server access logs | hosting operation | Hetzner, for the API and the static host | by Hetzner's settings: check in konsoleH and state in the privacy notice |
| Notifications | inform the traveler | ntfy server / mailbox | default **without content** (§3.4) |

The API's own logs (Monolog) **never** log contact bodies, e-mails or IPs from the public
endpoint. Only counters go in (`contact accepted=1 filtered=0`).

### 5.4 IP addresses: "only hashed, only short-term"

- **Never stored in plain text.** On receipt the API computes `net_hash` (HMAC with a server key)
  and `net_sealed` (a libsodium `crypto_box_seal` to the owner's public key: the server can
  encrypt but not decrypt). Then the IP is forgotten.
- The hash enables rate limits and short blocks, and is deleted after 14 days at the latest
  (48 h in `rate_hits`).
- The sealed box enables evidence, and is deleted after 14 days unless evidence is kept. Even
  someone who copies the database or a backup cannot read the IPs without the Mac key.
- Without an evidence key configured, no sealed data is stored at all. Then there is only the
  hash, and evidence has no network data.
- The login throttle stores raw IPs in `login_attempts` for 30 days. That concerns only the admin
  login, not visitors, and is mentioned only for completeness.
- On the phone, messages are not cached in IndexedDB (§3.5).

### 5.5 Cookies and browser storage: none

The form sets no cookies (the ALTCHA option `setCookie` stays off) and writes nothing to
`localStorage`, `sessionStorage` or IndexedDB. Drafts live only in memory. The proof of work
computes in memory. So
[§ 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html) (consent for storage on and
access to the terminal device) is not triggered, and no banner is needed. Existing site storage
(the stored dawn/dusk theme choice, `player/prefs.ts`) belongs in the general privacy notice; it
is not part of this form.

### 5.6 Privacy notice texts

**Under the form (one sentence, with a link):**

- de: „Deine Nachricht, dein Name und – falls angegeben – deine E-Mail-Adresse werden gespeichert,
  damit Lea sie lesen und dir antworten kann, und nach 6 Monaten gelöscht. Zum Schutz vor
  Missbrauch verarbeiten wir deine IP-Adresse kurzzeitig, nur gehasht bzw. verschlüsselt. Keine
  Cookies, kein Tracking. [Datenschutzhinweise]"
- en: "Your message, your name and, if given, your e-mail address are stored so Lea can read and
  answer them, and deleted after 6 months. To prevent abuse we briefly process your IP address,
  only hashed or encrypted. No cookies, no tracking. [Privacy notice]"

**Section "Kontaktformular" of the privacy page `/{locale}/privacy/`** (generated; the parts in
[brackets] come from the contact settings):

> **Kontaktformular**
>
> **Verantwortlich:** [Name des Betreibers], [E-Mail-Adresse][, c/o-Postanschrift].
>
> **Welche Daten:** dein Name, deine Nachricht, optional deine E-Mail-Adresse und, falls du die
> Nachricht zu einem bestimmten Tag schreibst, dieser Tag bzw. Moment. Technisch verarbeiten wir
> außerdem deine IP-Adresse, die Uhrzeit und die Browser-Kennung (User-Agent).
>
> **Wozu und auf welcher Grundlage:** Wir speichern deine Nachricht, damit [Lea] sie lesen und
> – wenn du eine E-Mail-Adresse angibst – dir antworten kann (Art. 6 Abs. 1 lit. f DSGVO; unser
> berechtigtes Interesse ist, Nachrichten zu empfangen und zu beantworten, die du uns freiwillig
> schickst). Zum Schutz vor Spam und Belästigung (Art. 6 Abs. 1 lit. f DSGVO) speichern wir aus
> deiner IP-Adresse nur einen Hash-Wert (ein nicht im Klartext lesbares Kürzel) sowie IP-Adresse,
> Port, Uhrzeit und Browser-Kennung verschlüsselt, sodass sie auf dem Server nicht lesbar sind.
> Dein Browser löst beim Absenden eine kleine Rechenaufgabe (ALTCHA, selbst gehostet); dabei werden
> keine Daten an Dritte übertragen.
>
> **Empfänger:** Hosting durch Hetzner Online GmbH, Gunzenhausen (Auftragsverarbeitung nach Art. 28
> DSGVO). Antworten verschicken wir über den E-Mail-Server desselben Anbieters. Über neue Nachrichten
> werden wir per Push-Benachrichtigung [ntfy] informiert; diese enthält keine Inhalte deiner
> Nachricht. Keine Übermittlung in Drittländer.
>
> **Speicherdauer:** Nachrichten und Antworten löschen wir 6 Monate nach dem letzten Kontakt,
> früher auf deinen Wunsch. Hash-Werte der IP-Adresse löschen wir nach spätestens 14 Tagen, die
> verschlüsselten Verbindungsdaten ebenfalls nach 14 Tagen. Nur wenn eine Nachricht Anlass zu
> rechtlichen Schritten gibt (z. B. Bedrohung oder Nachstellung), bewahren wir sie und die
> Verbindungsdaten auf, bis die Sache erledigt ist (Art. 17 Abs. 3 lit. e DSGVO). Sicherungskopien
> werden nach spätestens 14 Tagen überschrieben.
>
> **Keine Cookies, kein Tracking:** Das Formular setzt keine Cookies und speichert nichts auf
> deinem Gerät.
>
> **Deine Rechte:** Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung
> (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch gegen die Verarbeitung auf Grundlage
> berechtigter Interessen (Art. 21 DSGVO). Schreib dazu an [E-Mail-Adresse]. Du kannst dich außerdem
> bei einer Datenschutz-Aufsichtsbehörde beschweren, z. B. bei [Aufsichtsbehörde des Bundeslandes
> des Betreibers] (Art. 77 DSGVO).

> **Contact form**
>
> **Controller:** [operator's name], [e-mail address][, c/o postal address].
>
> **What data:** your name, your message, optionally your e-mail address and, if you write about
> a particular day, that day or moment. Technically we also process your IP address, the time and
> your browser identifier (user agent).
>
> **Why and on what basis:** We store your message so that [Lea] can read it and, if you give an
> e-mail address, reply (Art. 6(1)(f) GDPR; our legitimate interest is receiving and answering
> messages you send us of your own accord). To protect against spam and harassment
> (Art. 6(1)(f) GDPR) we store only a hash (a code that cannot be read back as plain text) of your
> IP address, plus your IP address, port, time and browser identifier in encrypted form that
> cannot be read on the server. When you send the form, your browser solves a small computing task
> (ALTCHA, self-hosted); no data goes to third parties.
>
> **Recipients:** hosting by Hetzner Online GmbH, Gunzenhausen, Germany (processor under
> Art. 28 GDPR). Replies are sent through the same provider's mail server. We are told about new
> messages by a push notification [ntfy] that contains nothing of your message. No transfers to
> third countries.
>
> **Retention:** messages and replies are deleted 6 months after the last contact, earlier if you
> ask. IP hashes are deleted after 14 days at the latest, the encrypted connection data also after
> 14 days. Only if a message gives cause for legal action (e.g. threats or stalking) do we keep it
> and its connection data until the matter is settled (Art. 17(3)(e) GDPR). Backups are
> overwritten after 14 days at the latest.
>
> **No cookies, no tracking:** the form sets no cookies and stores nothing on your device.
>
> **Your rights:** access (Art. 15), rectification (Art. 16), erasure (Art. 17), restriction
> (Art. 18), portability (Art. 20) and objection to processing based on legitimate interests
> (Art. 21 GDPR). Write to [e-mail address]. You may also complain to a data protection
> supervisory authority, e.g. [authority of the operator's federal state] (Art. 77 GDPR).

To do around it:
- conclude the data processing agreement (Art. 28) with Hetzner in konsoleH;
- the privacy page also needs sections on the static site in general (Hetzner access logs, no
  cookies, the stored theme choice);
- if a self-hosted ntfy is not used: if ntfy.sh is used with preview `none`, no visitor data goes
  there (only "New message"); with `name` or `full`, list ntfy.sh as a recipient.

**Controller = the owner, not necessarily the traveler.** Art. 13(1)(a) requires the identity and
contact details of the controller. If the owner (who runs the site) is a different person from
the traveler, the owner is named, which keeps the traveler's identity and address out of it.

### 5.7 Impressum (§ 5 DDG, § 18 MStV) for a private, non-commercial site

- **§ 5 DDG** (the Digitale-Dienste-Gesetz replaced the TMG in 2024) applies to
  „geschäftsmäßige, in der Regel gegen Entgelt angebotene digitale Dienste"
  ([gesetze-im-internet.de](https://www.gesetze-im-internet.de/ddg/__5.html)). A private travel
  diary without ads, affiliate links, sponsoring or payment is **generally not** such a service.
- **§ 18(1) MStV** requires name and address from providers of telemedia „die nicht ausschließlich
  persönlichen oder familiären Zwecken dienen"
  ([MStV § 18](https://www.gesetze-bayern.de/Content/Document/MStV-18)). An online diary for
  friends and acquaintances or holiday photos for the family are the typical examples of purely
  private sites; ads or an affiliate link end that
  ([e-recht24, Impressum für die private Homepage](https://www.e-recht24.de/impressum/13095-impressum-fuer-die-private-homepage.html),
  [e-recht24, Blog-Impressum](https://www.e-recht24.de/impressum/6519-blog-impressum.html)). **The
  grey area** is a site that is reachable by anyone and addresses a wider public: then
  "ausschließlich persönlich" is hard to argue. § 18(2) MStV (a person responsible for
  journalistic-editorial content) concerns journalistic offers; purely personal travel accounts
  are commonly not counted as such (a secondary-source view, not checked against case law here).
- **Assessment for this site, not legal advice:**
  - as it is now (noindex, link only for friends and family, no ads, no affiliate links,
    non-commercial): **most likely no Impressum needed**;
  - it gets stronger if the site becomes access-controlled (§6);
  - it gets weaker if `site.indexable` is switched on, if it is shared publicly on social media, or
    if any monetization appears. Then an Impressum is recommended.
- **If an Impressum is needed, without publishing the home address:** name **the owner**, not the
  traveler, and use a **c/o address** (an Impressum service, or a trusted person). It must be a
  „ladungsfähige Anschrift" (an address where legal documents can actually be served); **a PO box
  is not enough**
  ([e-recht24, c/o address in the Impressum](https://www.e-recht24.de/impressum/8369-impressum-c-o-adresse.html)).
  Plus the Auskunftssperre (§4.8, step 10).
- Technically: an owner switch "Show imprint" with fields (name, c/o address, e-mail). The
  generator renders `/{locale}/imprint/` and the footer link. Without the switch there is no page
  and no link.

---

## 6. The same form as "request to follow"

If the protection part makes the site access-controlled (visitors need a personal link or
approval), the contact form becomes the door.

| | `purpose: "message"` | `purpose: "follow_request"` |
|---|---|---|
| Where | button and sheet as above | the locked site's landing page `/{locale}/` shows only the title, the optional greeting (the owner chooses: without portrait and without place) and „Möchtest du Leas Reise verfolgen? Frag sie kurz an." / "Would you like to follow Lea's journey? Ask her." |
| Fields | name, e-mail (optional), message | name, **e-mail required** (the invitation goes there), **„Woher kennst du Lea?" / "How do you know Lea?"** (required, ≤ 280), message (optional) |
| Limits | §4.3 | stricter: 2 per 24 h per network, 1 open request per e-mail |
| Admin | Messages → Inbox | Messages → filter "Requests" with the buttons **Approve**, **Decline** and **Block** |
| Approve | – | calls the access part's invite endpoint (e.g. `POST /admin/viewers {name, email, messageId}`). That part creates the personal access link; the mail goes out through the same `ReplyMailer` from the neutral address. **The invitation link is the e-mail verification**: only whoever can read the mailbox gets in. |
| Decline | – | default **silent** (no mail), optionally a friendly template. The request is deleted after 30 days. |
| Block | as §4.5 | as §4.5. Requests from blocked senders get the same "Thank you, Lea will get back to you" and never land in Requests. |

Safety advice in the admin, shown only for requests: „Kennst du die Person wirklich? Im Zweifel
kurz auf anderem Weg nachfragen (Anruf, gemeinsame Freunde)." / "Do you really know this person?
If in doubt, check another way (call, mutual friends)." The "How do you know Lea?" field is social
proof, not verification.

What the contact part prepares now so this is cheap later:
- `purpose` is in the schema, in `purposes` of the GET and in the table from the start;
- `how_known` is in the table;
- `ReplyMailer` can send template mails;
- the contact page `/{locale}/contact/` exists and can serve as the landing page.

---

## 7. Concrete code changes and estimates

S = up to half a day, M = 1–2 days, L = 3–5 days (one person, including tests).

### Phase 1: form, inbox, protection (≈ L overall)

| Area | Change | Files | Size |
|---|---|---|---|
| Contracts | `ContactMessageCreate`, `ContactState`, `ContactAccepted`, `AdminMessage`, `AdminMessageListQuery` and `…ListResponse`, `AdminMessagePatch` (`read`, `folder`, `evidence`), `ContactBlock(Create)`, `ContactSettings(Patch)`; `Settings` + `contact.enabled`; `StatusResponse` + `contact`; `SiteInfo` + `contact?`; `RouteName` + `contact`, `privacy`, `imprint`; JSON schema export (`api/schemas/*.json`) and `pnpm schemas:check` | `packages/contracts/src/{api,site}.ts`, `json-schema.ts`, tests | M |
| API migration | `0002_contact.sql` (§3.3) | `api/migrations/` | S |
| API rate limiter | extract `Infra/RateLimiter` from `LoginThrottle` (keep the behaviour and the tests); `rate_hits` | `api/src/Infra/RateLimiter.php`, `Domain/Auth/LoginThrottle.php` | M |
| API proof of work | `composer require altcha-org/altcha:^2.4`; `Domain/Contact/Challenge` (create, verify, replay, issue time); fail-closed tests; doctor checks for sodium and the ALTCHA version | `composer.json`, `src/Domain/Contact/Challenge.php`, `src/Infra/Doctor.php` | S |
| API intake | `Domain/Contact/Intake` (normalization, limits, links, words, duplicates, safety hint, blocks, folder choice), `Domain/Contact/Keys` (`var/contact-keys.json`), `Domain/Contact/Evidence::seal()` | `src/Domain/Contact/*` | M |
| API public HTTP | `Http/Public/ContactController` (GET state + challenge, POST), `Http/Middleware/PublicLimits` (16 KB), routes in the `/public` group | `src/Http/Public/`, `Routes.php` | S |
| API admin HTTP | `Http/Admin/MessageController` (list, get, patch, delete, block), `ContactSettingsController`; `StatusController` + contact summary | `src/Http/Admin/*` | M |
| API notifications and cron | `Notification` + priority/tags/click/recipients; `ChannelNotifier` honours them; `Domain/Contact/Notifier` (digest, 10-min throttle); `AlertEngine` kind `contact_flood`; `CronRunner` job `contact` (digest, retention, pruning) | `src/Domain/Alerts/*`, `src/Infra/CronRunner.php`, `Maintenance.php` | M |
| Backend generator | `SiteInfo.contact` from `contact.enabled` + `API_BASE_URL`/`PUBLIC_API_URL`; CSP `connect-src`; header button in the twin; pages `/{l}/contact/` and `/{l}/privacy/` (privacy texts from the contact settings: needs a backend pull of a public subset, `GET /backend/contact/public-info`); footer; `verify.ts` | `backend/src/generator/{pages,twin,model,generate,verify}.ts`, `backend/src/config.ts` | M |
| Site | `contact/contact-button.tsx` (header + dock), `contact/contact-sheet.tsx` (lazy; sheet mechanics from `story-sheet.tsx`), `contact/contact-form.tsx` (fields, validation, states), `contact/use-pow.ts` + worker, `contact/api.ts` (fetch, timeout, error mapping), the `?write=` search param in the router, entries in `OptionsMenu` and `DayEndCard`, reference from the player context, footer; Lingui de/en/ar-pseudo | `frontend/site/src/contact/*`, `components/site-header.tsx`, `timeline/zoom-pill.tsx`, `player/{chrome,day-end,story-sheet,journey-player}.tsx`, `router.tsx`, `locales/*` | L |
| Admin | `screens/messages.tsx` (list, folders, swipe), `screens/message.tsx` (detail, safety banner, block sheet), Home card + tab dot, side-nav entry, settings section (on/off, pause, notifications, retention, filters, privacy details); query keys with `persist: false`; i18n | `frontend/admin/src/screens/*`, `api/{queries,keys,writes}.ts`, `screens/layout.tsx`, `locales/*` | L |
| Tests | PHPUnit (§8), Vitest (form logic, error mapping, PoW hook with a fake worker), Playwright site (sheet, a11y, states with a mocked API, CSP of the generated page), Playwright admin (list, block, settings) | `api/tests/Http/Contact*Test.php`, `frontend/*/test`, `frontend/*/e2e` | M |
| Docs | HOSTING (sodium, DKIM/SPF/DMARC, `CONTACT_FROM`/`CONTACT_REPLY_TO`), OPERATIONS (harassment runbook §4.8), `docs/PRIVACY.md` (balancing test, retention) | `docs/*` | S |

### Phase 2: replies and evidence (≈ M)

| Area | Change | Size |
|---|---|---|
| API | `Infra/MailSender` (extracted from `ChannelNotifier`), `Domain/Contact/ReplyMailer`, `POST /admin/messages/{id}/replies`, `contact_replies`, optional forwarding | M |
| API | `GET /admin/messages/export?ids=…|sender=…` (JSON with hashes, sealed blobs) | S |
| Admin | reply composer (language, preview, warning on the first reply), thread, retry; export button + printable report (client-side from the JSON) | M |
| Scripts | `scripts/contact-keys.ts` (X25519 pair → `.secrets/`, prints the public key and fingerprint), `scripts/contact-evidence.ts` (opens sealed boxes, merges them into the report); dependency `libsodium-wrappers` (ISC) or the Node 24 built-ins plus a small sealed-box implementation | S |
| Config | `CONTACT_FROM`, `CONTACT_REPLY_TO` in `Config::knownKeys()`; `deploy-api.ts --set-evidence-key` | S |

### Phase 3: follow requests (≈ M, after the access-control design)

`purpose: follow_request` in the form (landing page), the Requests filter, Approve/Decline wired
to the invite endpoint of the access part, invitation and decline templates.

---

## 8. Tests and acceptance

PHPUnit (new `api/tests/Http/ContactPublicTest.php`, `ContactAdminTest.php`,
`Domain/ContactIntakeTest.php`, `Infra/RateLimiterTest.php`):
- CORS: preflight only for `SITE_ORIGIN`; a POST without or with a foreign `Origin` → 403; a
  form-encoded body → 415.
- Honeypot filled, or submitted < 3 s after the challenge → 202 and **no row**.
- Proof of work: missing, foreign signature, **no signature**, changed expiry, expired, replay → 400.
- Rate limits: the fourth message in 10 min → 429 with `Retry-After`; a global overflow →
  `paused_until` set, alert `contact_flood` open, then resolved.
- A blocked e-mail or network → 202, folder `blocked` (or no row with `discard`), no notification.
- Filters → `filtered` with the reason; duplicates; link limit → 422.
- Retention: after 6 months deleted; evidence stays; `net_hash` and `net_sealed` NULL after
  14 days; `rate_hits` after 48 h.
- Notification: preview `none` contains no name or text (assert on the ntfy body); throttle of
  1 per 10 min.
- No log line contains an e-mail, IP or message body (assert on the test logger).
- Reply: `From`/`Reply-To` per mode (Symfony `NullTransport`/`InMemory`), no Reply-To to the
  visitor in the forward, 409 without an e-mail.

Playwright (site): the button is visible in the header (both themes, RTL pseudo), opens the sheet,
focus trap, Esc, Back closes; success and every error state with a mocked API; no request to the
API while only viewing; CSP of the generated page allows exactly the API origin; axe without
violations.

Acceptance: a message written on a phone arrives in the admin in < 5 s, and the push (without
content) in < 1 min. A reply arrives from the neutral address and contains neither the traveler's
address nor her IP.

---

## 9. Open questions for the owner

1. **Who reads the messages:** the traveler herself in the admin (she is the owner), or someone
   else who screens first and forwards? This decides the defaults for notifications and
   forwarding. A second admin login for the traveler is not planned (`users.role` knows only
   `owner`).
2. **The neutral address:** which domain or mailbox (e.g. `post@schaefchens.de`)? Reply mode
   "mailbox" or "no-reply"?
3. **Retention:** is 6 months OK? Notification preview `none` as the default?
4. **Mobile admin navigation:** the Home card + tab dot (recommended), or a "Messages" tab instead
   of "Days"?
5. **The header label:** „Schreib Lea" or „Nachricht schreiben"? The "psst" sticker on or off?
6. **Impressum and privacy page:** who is named as the controller (owner, not the traveler)? Which
   federal state (supervisory authority)? Is a c/o address available, should one be needed?
7. **Evidence key:** do we set up the key pair on the Mac now (the private key also goes into the
   offline backup)?

---

## 10. Sources

- ALTCHA: [open-source-captcha](https://altcha.org/open-source-captcha/) ·
  [GitHub altcha](https://github.com/altcha-org/altcha) ·
  [GitHub altcha-lib-php](https://github.com/altcha-org/altcha-lib-php) ·
  [Packagist altcha-org/altcha](https://packagist.org/packages/altcha-org/altcha) ·
  [npm altcha latest](https://registry.npmjs.org/altcha/latest) ·
  [README 3.7.0](https://unpkg.com/altcha@3.7.0/README.md) ·
  [CSP docs](https://altcha.org/docs/v2/content-security-policy-csp) ·
  [OSV GHSA-6gvq-jcmp-8959 / CVE-2025-68113](https://osv.dev/vulnerability/GHSA-6gvq-jcmp-8959) ·
  [OSV GHSA-82w8-65qw-gch6 / CVE-2026-71481](https://osv.dev/vulnerability/GHSA-82w8-65qw-gch6)
- Alternatives: [Cap (GitHub)](https://github.com/tiagozip/cap) ·
  [trycap.dev/about](https://trycap.dev/about) ·
  [Friendly Captcha on open source](https://friendlycaptcha.com/insights/open-source-captcha/)
- ntfy: [docs.ntfy.sh](https://docs.ntfy.sh/)
- Mail: [Hetzner konsoleH: DKIM, SPF, DMARC](https://docs.hetzner.com/konsoleh/account-management/email/mailsecurity)
- GDPR: [Regulation (EU) 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) ·
  [CJEU Lindqvist press release](https://curia.europa.eu/en/actu/communiques/cp03/aff/cp0396en.htm) ·
  [Irish DPC: household exemption](https://dataprotection.ie/en/faqs/general/what-household-exemption) ·
  [CJEU Breyer C-582/14](https://curia.europa.eu/juris/liste.jsf?num=C-582/14) ·
  [AEPD/EDPS: hash functions as pseudonymisation](https://edps.europa.eu/data-protection/our-work/publications/papers/introduction-hash-function-personal-data_en) ·
  [IT-Recht Kanzlei: contact form needs no consent](https://www.it-recht-kanzlei.de/dsgvo-datenschutz-kontaktformular-keine-einwilligung.html) ·
  [Dr. Datenschutz: legal basis for contact forms](https://www.dr-datenschutz.de/kontaktformulare-aber-mit-welcher-rechtsgrundlage/) ·
  [§ 25 TDDDG](https://www.gesetze-im-internet.de/ttdsg/__25.html)
- Impressum: [§ 5 DDG](https://www.gesetze-im-internet.de/ddg/__5.html) ·
  [§ 18 MStV](https://www.gesetze-bayern.de/Content/Document/MStV-18) ·
  [e-recht24: private homepage](https://www.e-recht24.de/impressum/13095-impressum-fuer-die-private-homepage.html) ·
  [e-recht24: blog](https://www.e-recht24.de/impressum/6519-blog-impressum.html) ·
  [e-recht24: c/o address](https://www.e-recht24.de/impressum/8369-impressum-c-o-adresse.html)
- IP retention and evidence: [Bundestag hearing 2026-10-07 (Drucksache 21/6581)](https://www.bundestag.de/dokumente/textarchiv/2026/kw41-pa-recht-ip-adressspeicherung-1221516) ·
  [beck-aktuell on the draft (IP addresses and port numbers)](https://www.beck-aktuell.de/heute-im-recht/rechtspolitik-gesetzgebung/regierung-gesetzentwurf-ip-speicherpflicht-2026-04-22) ·
  [netzpolitik.org on BGH III ZR 391/13](https://netzpolitik.org/2014/bundesgerichtshof-provider-duerfen-ip-adressen-sieben-tage-vorratsdatenspeichern-aber-nur-fuer-netzbetrieb/)
- Criminal law and help: [§ 238 StGB](https://www.gesetze-im-internet.de/stgb/__238.html) ·
  [§ 241 StGB](https://www.gesetze-im-internet.de/stgb/__241.html) ·
  [§ 185 StGB](https://www.gesetze-im-internet.de/stgb/__185.html) ·
  [§ 77b StGB](https://www.gesetze-im-internet.de/stgb/__77b.html) ·
  [§ 1 GewSchG](https://www.gesetze-im-internet.de/gewschg/__1.html) ·
  [§ 51 BMG](https://www.gesetze-im-internet.de/bmg/__51.html) ·
  [HateAid](https://hateaid.org/)

Unverified in this pass (marked as such above): the protocol compatibility of ALTCHA widget 3.x
with lib-php 2.4 (spike), `ext-sodium` on the Hetzner account (doctor), Hetzner's log retention
for access logs (konsoleH), and the exact wording of Lindqvist paragraph 47 (only secondary
sources read).
