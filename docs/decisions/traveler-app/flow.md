# App entries: data flow and architecture

Part of the app design (Android first, React Native). Scope of this file: the path of an app entry
from the phone to the static site, data ownership, publish policy and safety, dedupe with
WhatsApp, the optional WhatsApp posting path, and the API/contract changes.

Status: design proposal, 2026-11-20. Read-only analysis of the repo at `d75b40b` plus the working
tree. Nothing in the repo was changed.

**Binding owner decision:** "stay WhatsApp status compatible with what we do". App entries use
the WhatsApp status model and only what a WhatsApp status can express. Overlays are baked into
the pixels on the device, the caption stays separate text, and the site renders app entries with
the same code as captured statuses.

Labels used below: **[verified]** = checked in the repo or a cited source; **[assumption]** =
not verified, with a way to check it; **[decision]** = needs the owner.

---

## 0. Summary (recommendations)

1. **An app entry is a capture from a second source, not owner content.** It gets
   `sourceKey = "app:<entryId>"`, its `publicId` comes from the existing D4 derivation, and it
   uses the kinds `photo | video | gif | voice | text`. The backend is its primary (like `wa:`
   captures). The API only relays it: an "app inbox" that holds the upload until the backend has
   archived it, then deletes the files. This mirrors how the WhatsApp servers relay a status to
   the observer. Owner edits after posting (description, hide, publish now, move day) stay
   **annotations** in the API, keyed by the same `sourceKey`. Section 2.
2. **The upload is two-phase and resumable.**
   - Phase 1 (needed to publish): the entry JSON, a 640w preview and the **baked artifact**,
     which is the WhatsApp-equivalent JPEG/MP4/OGG.
   - Phase 2 (optional, private, Wi-Fi only): the untouched **source original** and the
     **edit list**.

   Uploads use a tus-1.0-compatible chunk protocol (PATCH + `Upload-Offset`), with 4–8 MiB
   chunks on the API host. On Android, a user-initiated data transfer (UIDT) job runs them, so
   they survive app kills and connection loss. Section 1.
3. **Mac asleep → nothing is lost, nothing expires.** Entries wait in the API's app inbox, and
   the app shows "uploaded, waiting for the home computer". The app keeps its local copy until
   the backend reports *archived*. **API down → the app queues locally** and retries with
   backoff. Section 1.4.
4. **Publish policy is unchanged:** app entries go through `effectiveCaptureVisibility()` like
   every capture. They follow the instant/delayed/review modes, the wave-5 delay and release
   slots, the follower gate and the annotations. Two app-specific guards:
   - `occurredAt` is the moment she tapped "Share", corrected for device clock skew, never the
     photo's EXIF time. Otherwise an old photo would skip the delay.
   - Coordinates never leave the phone. A coarse place may be *suggested* for the day (country
     plus city, confirmed by her, subject to the wave-5 "newest place = country only" rule).
   Section 3.
5. **Dedupe is backend-side, with three signals in order:**
   - the known WhatsApp message id, when the backend sent the status;
   - an explicit "also shared to WhatsApp" marker from the app, plus a perceptual hash in a time
     window;
   - perceptual hash plus a time window alone, which only *suggests* a merge to the owner.

   The twin is suppressed by policy, and owner annotations can override that. Section 4.
6. **Do not post to WhatsApp from the backend with her number.**
   - Linking her primary account as a whatsmeow companion would put a device that receives all
     her private chats on the Mac.
   - It breaks the ToS clause on automated access.
   - It risks a ban on her main account.
   - whatsmeow computes the status audience from its own contact store, which can diverge from
     what her phone would use.

   Instead, use **Android's share sheet**: after posting in the app, one tap shares the same
   baked artifact. WhatsApp's own "My Status" share target opens WhatsApp's status editor, and
   she presses send. Section 5.
7. **Effort** (S ≤ 1 day, M 2–4 days, L 1–2 weeks, all **[assumption]** for one developer who
   knows the codebase):
   - contracts M;
   - API app inbox and upload protocol L;
   - backend app source, archive and dedupe L;
   - admin PWA additions M;
   - the app's upload queue (native UIDT module) M–L.

   Section 6.

---

## 1. End-to-end path of an app entry (without WhatsApp)

### 1.1 Overview

```
 Phone (RN app)                     API host (PHP, shared)                  Mac (backend, Docker)                 Site host
 ─────────────────                  ───────────────────────                 ─────────────────────                 ─────────
 compose + bake on device
 (Media3 / Skia; strip metadata)
   │ entry JSON + files manifest
   ├──POST /app/entries ───────────▶ app_entries row (receiving)
   │                                 app_uploads rows (offset 0)
   ├──PATCH /app/uploads/{id} ×n ──▶ var/app-inbox/<entry>/<rev>/<role>.part
   │  (tus offsets, 4–8 MiB,          per-chunk sha256, append, offset=size
   │   UIDT job, resumable)
   ├──POST …/commit ───────────────▶ sha256 of each complete file verified
   │                                 state: uploaded  ── changes feed hint ─▶ pull loop (15 s) sees appInbox.pending>0
   │                                                    ◀── GET /backend/app/entries?state=uploaded
   │                                                    ◀── GET /backend/app/uploads/{id}/content (Range, resumable)
   │                                                                          inbox-app/<entry>/… (sha256-verified)
   │                                                                          captures row source='app' (received)
   │                                                                          ARCHIVE_DIR/YYYY/MM/DD/app-<entry>.*  (fsync)
   │                                                    ◀── POST /backend/app/entries/{id}/ack (outbox, durable)
   │                                 files deleted, state: archived
   │                                                                          pipeline: sharp/ffmpeg (same code as wa:)
   │                                                    ◀── PUT /backend/captures/app:<entry> (CaptureMirror)
   │                                                    ◀── POST …/preview (640w WebP, replaces the app preview)
   │                                                                          generator (policy, release slots)
   │                                                                          publisher ───── SFTP ─────────────────▶ /media, /data, HTML
   │                                                    ◀── POST /backend/published (watermark)
   ├──GET /app/entries/{id} ───────▶ state + mirror + annotation + reports
   │   "Live ✓ / scheduled 20:00 / in review / waiting for home computer"
 local copy dropped after "archived" (configurable)
```

What is new and what is reused:

| Step | Reused as is | New |
|---|---|---|
| Ids | `SourceKey` already accepts any `<ns>:<id>` (`packages/contracts/src/common.ts:633`). `publicIdForSourceKey()` is namespace-agnostic (`ids.ts`). PHP `Ids::isSourceKey` and `Ids::publicIdForSourceKey` are too, and `BackendController::putCapture` checks publicId = D4 hash **[verified]**. | `APP_SOURCE_NS = 'app'`, `appSourceKey(entryId)` |
| Pipeline | `processOriginal()` (`backend/src/pipeline/index.ts`) for photo/video/gif/voice/text. sharp output carries no EXIF/XMP/ICC (`image.ts` header). Video and voice run with `-map_metadata -1` and bitexact (`video.ts` header). **[verified]** | none; the baked artifact plays the role of the "original" in D8 naming |
| State machine | `awaiting_media → received → archived → processed → ready` (`store/captures.ts`). "awaiting_media" here means "not yet downloaded from the API". | `captures.source` gains `'app'` (store migration v2; the CHECK currently allows `live/history/fixture`, `store/migrations.ts`) |
| Archive | the archive layout `YYYY/MM/DD/<id>.*` (`capture/archive.ts`) | record type `omw.app-entry` next to `omw.capture` (§6.2) |
| Mirror, previews, revokes | `PUT /backend/captures/{sourceKey}`, preview upload, revoke, all through the sync outbox | outbox kind `app_ack`; an app-inbox pull in the pull loop |
| Generator and site | the model takes "ready captures" of any source (`generator/model.ts`); site entries are `photo/video/gif/voice/text` | optional `alt` on entries; twin suppression (§4) |

### 1.2 What the phone uploads

| File (role) | Content | Size (typical) | When | Published? | Kept where |
|---|---|---|---|---|---|
| `entry` (JSON body, not a file) | the WhatsApp-compatible entry: kind, caption, text style, media facts, alt text, postedAt, tz, files manifest (§6.1) | < 8 KB | phase 1 | caption, text style, alt: yes, through the generator | backend capture row + archive record |
| `preview` | 640w WebP/JPEG of the baked artifact (video: poster). Same limits as `PREVIEW_UPLOAD` (≤ 512 KB) | 40–120 KB | phase 1 | no (admin and app only) | API `var/previews/` until the backend's own preview replaces it |
| `media` | **baked artifact**: JPEG (photo), H.264/AAC MP4 with faststart (video, GIF as a muted MP4 loop), Opus/OGG or AAC (voice). Overlays are flattened; no EXIF/GPS/XMP; no container location atom | photo 0.5–2 MB; video ≤ 90 s at ~6 Mbit/s ≈ ≤ 70 MB | phase 1 | yes, through the pipeline (variants) | backend archive (as the "original" of D8) |
| `edits` | the edit list: layers, crop/rotate, filter id, trim range, sticker ids, strokes. The app owns the schema (`editsSchema: 1`); API and backend treat it as opaque | ≤ 256 KB (capped) | phase 1 if small, else phase 2 | **never** | backend archive only |
| `source` | the untouched source original (camera file or gallery pick), GPS stripped by default (§3.3) | photo 3–15 MB; 4K video 300–600 MB | phase 2, Wi-Fi (and optionally charging) only | **never** | backend archive only |

Why both an artifact and an original:
- The artifact is what WhatsApp would publish, so the site, the share intent (§5) and a future
  backend-posting path all use one byte-identical file.
- The source original and the edit list allow re-editing later **on the device**: the app
  renders again and uploads a new revision. There is never a second renderer in the backend.

Evaluation of the additive metadata the owner allowed:

| Metadata | Verdict | Why |
|---|---|---|
| Overlay texts as alt text | **Keep (S).** | WhatsApp has the field: `ImageMessage.accessibilityLabel = 32` and `VideoMessage.accessibilityLabel = 26` in the pinned WAProto **[verified]**, `proto/waE2E/WAWebProtobufsE2E.proto` in `.cache/go/pkg/mod/go.mau.fi/whatsmeow@v0.0.0-20261116172437-19d61352436f/`. So alt text is WhatsApp-expressible, not just additive. Build it only from the *final, visible* text layers, so deleted or covered text never leaks. The site uses it for `<img alt>` / `aria-label` (description, then alt, then caption). |
| Private original + edit list | **Keep, but make it optional and deferred (M).** | The edit list is tiny, so always send it. Photo originals go on Wi-Fi by default. Video originals stay off by default (a setting; size cap e.g. 600 MB) because they dominate upload volume, API quota and PHP worker time, and video re-edits are rare. Originals never block publishing. |

### 1.3 Upload protocol on the shared host

Host limits (`docs/HOSTING.md`, live 2026-11): `upload_max_filesize`/`post_max_size` 50M,
`memory_limit` 128M, `max_execution_time` 60, 2–10 PHP workers, no SSH **[verified in repo docs]**.
Design consequences:

- **Chunks of 4 MiB on cellular and 8 MiB on Wi-Fi** (server maximum 8 MiB, announced in the
  create response). The request body is streamed `php://input` → temp file
  (`stream_copy_to_stream`), so memory stays constant. Each chunk is verified against
  `Upload-Checksum: sha256 <b64>` (tus checksum extension), then appended. The offset is the file
  size on disk, not a DB counter, so a crash mid-append resumes correctly.
- **Protocol:** a tus 1.0 core subset: `HEAD` (offset), `PATCH` with
  `Content-Type: application/offset+octet-stream` and `Upload-Offset`. A wrong offset gets 409
  plus the real offset. Creation goes through our own `POST /app/entries` (one call creates all
  upload slots for the entry). Clients: the native UIDT job uses plain OkHttp (about 150 lines);
  `tus-android-client` and tus-js-client also work with this subset.
  - tus-js-client runs in React Native except for persistent URL storage
    (https://unpkg.com/tus-js-client@4.3.1/README.md).
  - The PHP library `ankitpokhrel/tus-php` (v2.4.0, 2024-02-17; pulls guzzle, symfony, predis,
    carbon; https://packagist.org/packages/ankitpokhrel/tus-php) is heavier than the ~250 lines
    the subset needs, so implement the subset in `Domain/AppInbox.php`.
- **Worker protection.** Few PHP workers are shared with the admin PWA and the backend sync, so
  at most **2 concurrent upload requests** run, enforced with `flock` slot files in `var/cache/`.
  Requests beyond that get `503` + `Retry-After: 5`. The app runs one upload stream at a time.
- **[assumption]** Whether Apache/PHP-FPM on the Hetzner host holds a PHP worker while a slow
  client streams the request body (mod_proxy_fcgi streams; mod_fcgid buffers) is unknown.
  Probe it: send an 8 MiB PATCH throttled to 1 Mbit/s, meanwhile hit `/api/v1/health` from N
  parallel clients, and watch latency. If workers are held, lower the cellular chunk to 2 MiB.
  The chunk size is server-announced, so no app release is needed to change it.
- `max_execution_time` does not count stream I/O on Linux (PHP manual, `set_time_limit`), and
  multipart parsing is not used. The `commit` call hashes a whole file with `hash_file`: about
  2–3 s for 500 MB **[assumption: host disk speed]**.

**Backend download:** `GET /backend/app/uploads/{id}/content` with `Range` (32 MiB per request),
written to `DATA_DIR/inbox-app/<entryId>/<role>.part`. The download resumes from the local file
size, the backend verifies the sha256 from the entry manifest, then renames. Backend failure
classes follow `sync/client.ts` (transient, auth, permanent).

### 1.4 Failure scenarios

**Mac asleep for 12 hours.**
- The app finishes phase 1 and the entry reaches `uploaded`. `GET /app/entries/{id}` reports
  `waiting_for_backend` together with `backendLastSeenAt`; the API has it from the heartbeat
  (`backend_status.received_at`). The app shows *"Uploaded ✓ — waits for the home computer
  (offline since 02:10)"*.
- Nothing expires. The API holds the files until the backend acks them, unlike WhatsApp media,
  which has to be fetched before the CDN copy expires (PLAN A7 "≤ 12 h"). So app entries
  **relax** the Mac-sleep constraint: only WhatsApp captures depend on it.
- The owner can still act on a waiting entry: hide it, mark "publish now", describe it. Those are
  annotations, and `Captures::exists()` (`api/src/Domain/Captures.php:238`) is extended to accept
  known app entries, so `PATCH /admin/captures/app:<id>` works before the backend has seen the
  entry.
- When the Mac wakes, the pull loop sees `appInbox.pending > 0` in the next change-feed page
  (§6.3) and fetches the oldest entries first. Ordering does not matter for correctness:
  placement comes from `occurredAt`/`tz`, not arrival order.
- Instant mode: entries go live once processed, all in one deploy. Delayed mode (the wave-5
  default, 24 h): the sleep is invisible, because `publishAt = occurredAt + delay` is usually
  still in the future.
- Quota: 12 h of heavy use is about 30 photos (≈ 60 MB of artifacts) plus 5 videos (≈ 300 MB),
  plus deferred originals (≈ 0.3–2 GB if enabled). This sets the budget below.

**API down or unreachable (or the phone offline).**
- The app's local outbox (SQLite) holds the entry JSON, the baked files and the upload states.
  The app shows *"Saved on your phone — will upload when the server is reachable"*.
- The UIDT job has a network constraint, so Android starts it when the network returns. App
  retries use exponential backoff with jitter (15 s, then 1, 5, 15 and 60 min, capped), and
  `Retry-After` wins.
- **Android: user-initiated data transfer jobs** (API 34+): `JobInfo.Builder.setUserInitiated(true)`,
  `RUN_USER_INITIATED_JOBS`. They need a notification, are not subject to App Standby quotas, can
  run long, and may only be scheduled while the app is visible. There is no Jetpack library; use
  the WorkManager foreground-service fallback below API 34
  (https://developer.android.com/develop/background-work/background-tasks/uidt).
  - The user taps "Share" while the app is visible, so scheduling is allowed.
  - Persist the transfer state for `onStopJob`/process death; the tus offsets make this cheap.
  - Phase-2 originals use `NET_CAPABILITY_NOT_METERED` and optionally `setRequiresCharging`.
- While the API is down, WhatsApp captures keep publishing through the backend (PLAN data
  ownership), and the site stays up.

**Partial uploads.**
- Each upload slot resumes from `HEAD`.
- The app keeps the `uploadId`s in its outbox. If they are lost (reinstall), `POST /app/entries`
  with the same `entryId` returns the existing slots and offsets.
- A slot with no progress for **72 h** is deleted by cron. The app then gets 404 on `HEAD`,
  re-creates the slot and starts from 0. It still has the file.

**Wrong bytes.**
- A chunk checksum mismatch gives 460 (tus) or 422; the app re-sends the chunk.
- A whole-file sha256 mismatch at `commit` gives 422 `hash_mismatch` and resets the slot.
- A backend-side mismatch gives `POST /backend/app/entries/{id}/reject {reupload: true}`. The API
  resets the slot and the app sees `reupload_requested`. The app keeps its copy until
  `archived`, so this loop always heals.

**Invalid media** (undecodable, too large, wrong kind):
- the API rejects what it can check (size, magic bytes via `finfo`, declared kind/mimetype);
- the backend rejects decode failures after its retries (`recordFailure` → `failed`, then
  `reject {reupload: false, reason}`);
- the app shows *"Could not be processed"* with "try again" (a re-bake) or "discard".

**Idempotency.**

| Key | Generated by | Effect of a repeat |
|---|---|---|
| `entryId` (UUIDv7, lowercase; fits the `MsgId` regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`) | app, at "Share" | `POST /app/entries` with the same `(entryId, rev)` and the same `entryHash` → 200 + the current state. A different hash → 409 `conflict` |
| `uploadId` | API, one per `(entryId, rev, role)` | the same slot is returned again |
| chunk | offset | a retried chunk after a lost response → 409 + the real offset; the client continues from there |
| `commit` | – | repeatable; 200 with the state |
| backend insert | `sourceKey` | `captures.insert` is idempotent by primary key |
| ack | `(entryId, rev, role, sha256)` | repeatable; the API deletes a file only when the sha256 matches |
| mirror | `sourceKey` | `PUT` is idempotent, as today |

**Quotas and cleanup.**
- Hetzner's current plans have 10/50/100/300 GB of storage with 2/5/10/20 PHP processes, and
  overage costs €1.09/GB/month (https://www.hetzner.com/de/webhosting).
  **[assumption]** The live account is an older plan (128 MB memory per `HOSTING.md`). Its quota
  is not in the repo; read it in konsoleH.
- `disk_free_space()` reports the file system, not the account quota. So the API keeps its own
  budget (`APP_INBOX_MAX_BYTES`, default 3 GiB) from `SUM(app_uploads.bytes)` of undeleted files.
  - Phase-1 files are accepted up to the full budget.
  - Phase-2 originals only up to 50 % of it.
  - Above that: `507 quota_exceeded` + `Retry-After: 3600`; the app keeps the item queued.
- Cron (every 5 min, existing `bin/cron.php`):
  - deletes acked files (belt and braces);
  - deletes slots stale for 72 h;
  - deletes app previews whose capture preview has arrived;
  - alerts at 80 % of the budget, and when an `uploaded` entry is older than 24 h (the existing
    `heartbeat_stale` alert usually fires first).
- **Never auto-delete** a complete, un-acked entry: that would be data loss.
- Rows stay as small tombstones (`entryId → sourceKey, state, archivedAt`) for idempotency.
  Compact them after 90 days.

**What the app keeps.**
- The baked artifact stays until the backend reports `archived` (that is when the API deletes
  its copy), plus as long as the "share to WhatsApp" card is open.
- The edit list and the source reference (the gallery URI, or the camera file) stay until the
  traveler clears the entry from "Recent".
- Camera originals the app captured itself are saved to the gallery only if she wants it (a
  setting).

---

## 2. Where app entries live (data ownership)

### Options

| | A: new owner-content kind in the API (`posts.kind = photo…`) | B: new capture source in the backend (`app:<id>`) — **recommended** |
|---|---|---|
| Primary | API (metadata). Media is derived by the backend, so the primary is split | Backend, for everything about the posted item; the API is a transit queue |
| Rendering | posts render as note/story today. A media post would need a new site entry path, which the owner's rule ("same code as captured statuses") forbids | identical to WhatsApp captures: same `Entry` kinds, pipeline, generator and player |
| Durability | the API host would hold the only copy until the backend fetches it, and the API is not the archive | the archive on the Mac is the durable home, as for WhatsApp; the API copy is temporary, as the WhatsApp CDN is for the observer |
| Policy | posts carry their own visibility and skip the delay today (wave-5 E13 had to patch that) | `effectiveCaptureVisibility()`: mode, delay, review, revoke and annotations, already tested with shared vectors in TS and PHP |
| Change feed | the entry would travel in the owner feed with media facts the API cannot know | the feed is unchanged; the backend mirrors the capture to the API like any capture |
| Admin | a second media list | the inbox already lists captures; app entries show up with a small "App" badge |
| Revocation / delete | post delete | WhatsApp revoke semantics (`revokedAt`, `ingest.on_revoke`) |

### Recommendation: B, with exactly one primary per datum

Updated table (extends PLAN "Data ownership"):

| Datum | Primary | Mirror / copy | Notes |
|---|---|---|---|
| App entry **in transit** (entry JSON, artifact, preview, edits, source original) | — (queue item in the API app inbox) | — | Not a primary: deleted after the backend's ack. Like WhatsApp's servers for a status. |
| App entry **as a capture**: kind, occurredAt, tz, caption, text style, media facts, alt text, revision, withdrawn (`revokedAt`) | **Backend** (`captures`, archive record) | API (`captures` mirror via `PUT /backend/captures/app:<id>`) | The same table and contract (`CaptureMirror`) as `wa:` captures |
| Private source original + edit list | **Backend archive** only | — | Never mirrored, never published |
| Dedupe link (`twinOf`) | **Backend** | API mirror (additive `CaptureMirror.twinOf`) | Computed in the backend (it has both sets of pixels) |
| Owner data about the entry: description, visibility override (hide / publish now / review), `localDateOverride`, cover, portrait | **API** (`annotations` keyed by `app:<id>`) | Backend (change feed) | Unchanged mechanism |
| Day place, title, trips, settings (also those the app suggests) | **API** | Backend | The app writes them through the existing admin endpoints |
| Notes and stories written in the app | **API** (`posts`) | Backend | Not a WhatsApp concept; they stay posts |

Edits after posting, without breaking "one primary":
- Caption, alt-text and media fixes are **revisions** of the capture (`rev + 1`). They travel
  phone → API inbox → backend, and the backend applies them. Same `sourceKey`, so annotations,
  reactions (wave 5, keyed by entry id) and day placement survive.
  - A media revision has a new artifact sha256, so it gets new D8 file names. The publisher
    removes the old variants as obsolete.
  - `occurredAt` can never change in a revision (it is the delay clock, §3).
- Withdraw/delete from the app = a **revoke** relayed to the backend (`withdrawRequestedAt` in
  the inbox row → the backend sets `revokedAt` → mirror). `ingest.on_revoke` applies as for
  WhatsApp. "Hide" is a separate, reversible annotation.
- WhatsApp itself has no status edit, so revisions are our extension. They do not change *what*
  is published (one artifact + caption), which is what the compatibility rule is about.
  **[decision]** Ship revisions in v1 (M), or v1 = withdraw + new post (S, but loses the
  annotations).

---

## 3. Publish policy and safety

### 3.1 Same policy as captures

- `generator/model.ts` already selects "ready captures, kind ≠ unsupported,
  `effectiveCaptureVisibility() === 'public'`" without looking at the source **[verified]**. So
  `instant | delayed | review`, `publish.mode_since`, annotation overrides and revoke + hide
  apply to app entries for free.
- Wave 5 additions also apply as they land:
  - release slots (`publish.release_slots`);
  - notes and stories following the delay;
  - newest place as country only;
  - no `lat`/`lng` in site data;
  - the follower gate (the site host decides access, independent of the source);
  - the owner review checklist in the inbox.

  They live in `policy.ts`, `model.ts` and the gate, not in the capture source (wave-5
  proposal §3.1, §6.5).

### 3.2 The delay clock must not be bypassable

`publishAt = occurredAt + delay` (`policy.ts capturePublishAt`). For WhatsApp, `occurredAt` is
the server timestamp of the status, which is posting time. For app entries:

- `occurredAt` = **the moment she tapped "Share"** (`postedAt`), never the photo's EXIF or
  camera time. If a two-day-old photo of the hostel where she is staying were dated by its EXIF
  time, `occurredAt + 24 h` would already be past and it would go live at once.
- **Clock skew.** Every app request carries `clientNow`. The API computes
  `skew = serverNow − clientNow`, stores `occurredAt = postedAt + skew` when |skew| > 2 min, and
  rejects `postedAt` later than `receivedAt + 5 min` or earlier than `receivedAt − 30 days`.
  A phone set to the wrong year cannot backdate an entry past the delay.
- An entry queued offline for 30 h goes live as soon as it is processed in delayed-24 h mode.
  That matches what "delay" means: content older than the delay. Release slots (wave 5) still
  batch it.
- The photo's own date (`takenAt`) is kept **privately** (archive only) and used for one thing:
  the app may ask *"This photo is from Tue 18 Nov — put it on that day?"*. A yes writes the
  existing owner annotation `localDateOverride` (placement only; the delay clock is untouched).

### 3.3 Location: keep the exact location private

| Layer | Rule | Status |
|---|---|---|
| Gallery picks | Use the Android Photo Picker and **do not request `ACCESS_MEDIA_LOCATION`**. The picker hands out media with location EXIF redacted by default. A newer opt-in location API in the picker (Mainline, 2026) asks the user. Leave it off. | Press reports, not official docs: https://www.androidauthority.com/android-photo-picker-location-3683074/, https://issuetracker.google.com/issues/243294058. **[assumption]** for videos: check on her phone that `©xyz` is absent in picked MP4s. |
| In-app camera | Never write location (e.g. VisionCamera's location option off; CameraX without location metadata). | design rule |
| Baked artifact | Freshly encoded (JPEG / Media3 Transformer MP4 / Ogg). The app writes no metadata at all, and the backend strips again (sharp: no metadata; ffmpeg `-map_metadata -1`). | pipeline **[verified]** |
| Source original (phase 2, private) | GPS tags removed **on the device** before upload by default (`androidx.exifinterface` for JPEG/PNG/WebP; a remux without metadata for MP4). The option "keep location in my private archive" is off. HEIC: re-encode or upload without GPS stripping only if she opted in. **[assumption]** ExifInterface cannot write HEIF; check. | design rule |
| Entry JSON | **Has no coordinate field at all.** A location sticker is pixels with the place *name* only, never WhatsApp's `InteractiveAnnotation.location {degreesLatitude, degreesLongitude}` (which exists in the proto **[verified]**). | contract rule |
| Day place | The app may **suggest** `placeName` + `countryCode` for today through `PATCH /admin/days/{date}` and **never sends `lat`/`lng`** (wave 5 stops publishing them anyway). | existing endpoint |
| Publication | Wave-5 D2: the newest place appears as country only until a later place is public. | wave 5 |

**Should the app suggest the day's place from coarse location? Yes, carefully:**
- Request only `ACCESS_COARSE_LOCATION`. Approximate location is accurate to about 3 km²
  (https://developer.android.com/develop/sensors-and-location/location/permissions).
- One-shot, only on the compose screen. Never in the background, never stored.
  For apps targeting API 37+ that only need session-based location, Google Play requires the new
  location button (same page). This matters only if the app goes to Play.
- Reverse-geocode **on the device** against a bundled offline city list (GeoNames
  `cities15000`, a few MB). Android's `Geocoder` would send the coordinates to a Google backend
  **[assumption, typical implementation]**.
- Show *"Today in Hội An, Vietnam?"* only when the day has no place yet. Nothing is sent before
  she confirms.
- Device time zone: when it differs from the mirrored `timezone.current`, offer one tap to update
  the setting. This fixes the day assignment of **WhatsApp captures** too, which use that setting
  (`capture/ingest.ts resolveTz`). App entries carry their own `tz` (the device IANA zone at
  `postedAt`).
- Venue-level risk stays in the pixels: signs, room numbers, a location sticker with the hostel
  name. That is the wave-5 reasoning for the delay and the review checklist. The composer can
  show a gentle hint when a "place" sticker is added: "Place names are visible to followers once
  this is published."

### 3.4 Other safety points

- **Withdraw works in every state.**
  - Before ack: the API deletes the files and the row becomes a tombstone; the backend never
    sees it.
  - After ack: a revoke relay; `on_revoke=hide` hides it, and the publisher deletes its media
    immediately (PLAN A5).
  - The app also offers "Hide" (an annotation, works at once through the change feed) for when
    `on_revoke = keep`.
- **App token.**
  - Today `app` tokens have the `admin` scope (`TOKEN_KIND_SCOPES`, `api_tokens` CHECK). Add a
    narrower scope `capture`: create, upload, withdraw and read entries, read hints, suggest the
    day place. The full `admin` scope stays opt-in for the traveler (wave-5 D6).
  - Pairing: the admin PWA creates the token and shows it once as a QR code.
  - Storage: Android Keystore-backed storage.
  - Lost phone: revoke in the admin (exists).
- **API host compromise** (wave-5 threat "low / severe") exposes pending artifacts and previews,
  which are fresh. That is the same class of exposure as the private previews the API holds today.
  Optional hardening (M), not in v1: seal the phase-2 originals to a backend X25519 public key on
  the device (libsodium sealed box plus secretstream), so the API stores ciphertext only.

---

## 4. Dedupe: the same moment on WhatsApp and in the app

Without dedupe the site would show it twice: `wa:<msgId>` captured by the observer, and
`app:<entryId>`. WhatsApp re-encodes media (it resizes, recompresses JPEG and transcodes video),
so byte hashes never match.

### 4.1 Signals, strongest first

| # | Signal | When available | Action |
|---|---|---|---|
| 1 | **Known message id.** The backend sent the status itself (§5 option B) and chose the id up front (`cli.GenerateMessageID()` + `SendRequestExtra.ID`, `send.go:47,146` **[verified]**) | only with backend posting | link automatically and deterministically |
| 2 | **Explicit marker.** The app's "Also share to WhatsApp" button records `alsoToWhatsApp {sharedAt, artifactSha256}` in the entry (or in a later revision, if she shares afterwards) | share-intent path (§5 recommendation) | link automatically when a `wa:` capture from the traveler of the same kind arrives within **[sharedAt − 2 min, sharedAt + 6 h]** and the perceptual distance is below a **loose** threshold. She may have added more overlays in WhatsApp's editor. |
| 3 | **Perceptual hash + time window** | always | within ±72 h, same kind, distance below a **strict** threshold → **suggest** "Looks like the same as … — merge?" in the admin inbox; a one-tap merge. No automatic merge without signal 1 or 2. |

### 4.2 Hash definitions (backend, computed in the pipeline step, stored on the capture row)

- **Photo:** 64-bit DCT pHash of the oriented image (sharp → 32×32 grayscale → DCT → 8×8),
  plus the aspect ratio. Strict ≤ 6 bits, loose ≤ 12 bits **[assumption: tune on fixtures of
  WhatsApp-recompressed copies]**.
- **Video / GIF:** pHash of frames at 10 %, 50 % and 90 % of the duration plus the duration
  (±1 s, or "WhatsApp trimmed it": the WhatsApp copy is ≤ 90 s and starts with the same frame).
- **Voice:** duration ±0.5 s plus the correlation of the 64 waveform peaks (WhatsApp sends a
  waveform; `voice.ts` computes peaks).
- **Text:** an exact match of the normalised body plus font plus background ARGB.
  - Text statuses cannot be shared as *styled* text through Android's share sheet (§5.3). If she
    shares a rasterized text card, it arrives as a **photo**. Signal 2 links them across kinds
    (text ↔ photo).
  - Note: WhatsApp has `ImageMessage.imageSourceType = RASTERIZED_TEXT_STATUS` **[verified in
    the proto]**, so some WhatsApp "text" statuses may themselves arrive as images. That is
    worth a fixture in Phase 0.

### 4.3 What happens to a twin pair

- The backend stores `twin_of` on the **suppressed** capture and mirrors it (`CaptureMirror.twinOf`,
  additive).
- **Canonical:** the app entry (better quality, alt text, revisions), **unless** the `wa:` twin
  was already in a successful deploy. Then that one stays canonical, so public ids, deep links
  and wave-5 reactions do not move. In delayed mode both usually arrive before either is public,
  so the app entry wins.
- **Policy** (`policy.ts` + PHP `Policy`, shared vectors): after the annotation override check,
  `twinOf` set → `hidden`. An owner annotation `visibility: public` on the twin ("keep both") wins
  as always. That keeps the owner's choice in the API and the link in the backend.
- **Revokes:** if either member is revoked and `ingest.on_revoke = hide`, the **group** is hidden.
  Deleting it on WhatsApp means "take it down". **[decision]** (recommended: yes).
- **Admin:** "Also on WhatsApp ✓" on the canonical item, "Merged into …" on the twin, plus an
  "Unmerge" action (sets annotation `visibility: public` on the twin).

Effort: M in the backend (hashes, matcher, `twin_of`), S in the contracts (policy input + vectors
+ PHP mirror), S in the admin.

---

## 5. Optional: getting the entry onto WhatsApp status

### 5.1 How WhatsApp encodes a status (pinned WAProto, for both directions)

From `proto/waE2E/WAWebProtobufsE2E.proto` at the pinned whatsmeow commit `19d6135`
(2026-11-16) **[verified]**:

| Feature | Encoding | Our contract |
|---|---|---|
| Photo / video / GIF | `ImageMessage` / `VideoMessage`: media fields, `caption`, `width/height`, `seconds`, `gifPlayback`, `JPEGThumbnail`, **`accessibilityLabel`**, `imageSourceType` (`USER_IMAGE`, `AI_GENERATED`, `AI_MODIFIED`, `RASTERIZED_TEXT_STATUS`) | `kind`, `caption`, `media`, (new) `alt` |
| Drawing, text overlays, emoji and plain stickers, crop/rotate, filters | **no proto fields:** flattened into the pixels by WhatsApp's editor **[inference: no field exists for them]** | baked on the device (owner decision) |
| Interactive overlays (link sticker, location sticker, music, channel) | pixels **plus** `annotations` / `interactiveAnnotations`: a `polygonVertices` tap area and one of `location {lat, lng, name}`, `tapAction {title, tapURL}` (`statusLinkType RASTERIZED_LINK_*`), `embeddedContent.embeddedMusic` (licensed song ids) | **not supported**: location would leak coordinates, music is licensed, and links need tap areas on the site |
| Text status | `ExtendedTextMessage.text`, `textArgb`, `backgroundArgb`, `font` (the 8 enum values = `FONT_NAMES` in `wa.ts`); link preview fields `matchedText`, `title`, `description`, `JPEGThumbnail`, `previewType`, `linkPreviewMetadata`; `musicMetadata` | `text: InboxText` (body, ARGB, font) **identical to captures**; link previews: render the URL as text only, v1 |
| Voice status | `AudioMessage.ptt`, `seconds`, `waveform`, **`backgroundArgb`** (voice-status background colour) | `kind voice`, `media.waveformB64`; **gap:** `InboxMedia` does not keep `backgroundArgb` today. Add it (additive) for captures and app entries alike (S) |
| Mentions | `contextInfo.mentionedJID` + `statusMentionMessage` | not supported (identifies people) |
| Polls, questions, "add yours", reaction stickers | separate associated messages (`MessageAssociation` `STATUS_POLL`, `STATUS_QUESTION`, `STATUS_ADD_YOURS`, `STATUS_REACTION`) | not supported (interactive) |
| Audience | the status privacy list (contacts / except / only share with) plus `contextInfo.statusAudienceMetadata` (`CLOSE_FRIENDS`, `CUSTOM_LIST`) | no equivalent; the site has its own follower gate |

So "only what WhatsApp status can express" for the app means: **a photo/video/GIF with a caption
(+ alt), a text status in one of the 8 fonts with ARGB colours, a voice note (+ background
colour)**. Everything visual beyond that is pixels.

### 5.2 Option B: post from the backend with her number (whatsmeow, `WA_MODE=self`)

What it would take: a second helper instance linked to **her** account (the single-instance lock
is per `DATA_DIR`, so the observer helper keeps running separately). Plus a new `WaCommand`
`send_status {entryId, kind, file, caption, text}`. The helper calls `cli.Upload(…)`
(`upload.go:46`) and builds the message, then
`cli.SendMessage(ctx, types.StatusBroadcastJID, msg, SendRequestExtra{ID: preGeneratedId})`.

How the audience is computed when a companion sends a status **[verified in the pinned source,
`broadcast.go`]**:
- `GetStatusPrivacy()` IQ → `contacts | blacklist | whitelist`.
- whitelist → that list.
- otherwise: **all entries of whatsmeow's own contact store with a non-empty `FullName`**, minus
  the blacklist. Her own JID is appended.
- The contact store is filled by app-state sync (`critical_unblock_low` snapshot →
  `PutAllContactNames`, `appstate.go:190-196`). Until that sync completes, or if it fails, the
  audience is incomplete or empty.
- Close-friends or custom lists (`StatusAudienceMetadata`) are not handled.
- WhatsApp is testing status delivery to recently interacted non-mutual contacts (reported
  May 2026: https://piunikaweb.com/2026/05/20/whatsapp-update-lets-strangers-see-status/,
  https://wabetainfo.com/whatsapp-is-rolling-out-a-feature-to-share-status-updates-with-unsaved-phone-numbers/).
  whatsmeow would not reproduce that, so her audience could silently differ from what her phone
  would use.
- On a participant-hash mismatch for broadcasts, whatsmeow only logs (`send.go`, `case
  types.BroadcastServer: // TODO do something`), so some devices may silently miss the status.
- The README lists status sending as *"experimental, may not work for large contact lists"*
  (https://github.com/tulir/whatsmeow).

Other points:
- **Styling:** text statuses can be sent with the full styling (`ExtendedTextMessage` fields are
  free to set). Media can carry `caption` and `accessibilityLabel`.
- **Dedupe:** trivial (signal 1). The observer (or the self helper) captures `wa:<id>` with the id
  we chose.

**Risks:**
- **Privacy, the decisive one.** A companion device of her **primary** account receives *all*
  her new messages, and by default requests history sync (`store.DeviceProps.HistorySyncConfig`,
  `RequireFullSync=false` but recent sync on; `store/clientpayload.go:124-157`). The Mac would hold
  keys to her private chats. PLAN chose the observer design precisely so that "the traveler's own
  account is never touched".
- **ToS:** the WhatsApp Terms (EEA, effective 17 Aug 2026) forbid accessing or exploiting the
  services "directly or through automated means", and creating "software or APIs that function
  substantially the same as our Services"
  (https://www.whatsapp.com/legal/terms-of-service-eea). An unofficial companion that posts is
  exactly that.
- **Ban risk lands on her main account.** WhatsApp has temporarily or permanently blocked users
  of third-party clients before (https://techcrunch.com/?p=1108388). Losing her account while
  travelling is the worst outcome in this whole project.
- **Operational:**
  - linked devices are logged out if her phone stays offline for about 14 days (PLAN A8);
  - `stream_replaced`/ban states (wa.ts exit codes);
  - LID addressing changes;
  - the Mac must be awake to post (the opposite of what §1.4 achieves for app entries).
- **No official alternative:** the WhatsApp Cloud API offers no status posting. Meta lists status
  as "not supported" for numbers moved to the Cloud API
  (https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users).

### 5.3 Option A: Android share sheet ("Share to WhatsApp status") — recommended

- After an entry is posted in the app, the "Done" sheet offers **"Also on WhatsApp status"**. The
  tap fires `Intent.ACTION_SEND` with the **baked artifact** as `EXTRA_STREAM` (a
  `FileProvider` URI with `FLAG_GRANT_READ_URI_PERMISSION`) and the caption as `EXTRA_TEXT`, via
  `Intent.createChooser(...)`.
- Since mid-2025 WhatsApp publishes a **"My Status" target in the Android share sheet**. Tapping
  it routes the media straight into WhatsApp's status editor (WhatsApp beta 2.25.20.3, 1 Jul
  2025: https://wabetainfo.com/whatsapp-beta-for-android-2-25-20-3-whats-new/; on iOS from
  25.22.83).
- That is the closest Android allows: a third-party app cannot launch another app's
  direct-share shortcut itself, and WhatsApp documents no status-composer intent (none found).
  **[assumption]** The target has reached her phone's WhatsApp version. Fallback:
  `setPackage("com.whatsapp")` opens WhatsApp's own "Send to" picker, where "My status" is
  offered.
- **[assumption]** Whether `EXTRA_TEXT` pre-fills the status caption. Verify on her phone. If
  not, the app copies the caption to the clipboard and says so.
- **Text statuses:** the share sheet cannot carry font or background. The app offers "share as
  image": a 1080×1920 rasterized card, the same thing WhatsApp calls `RASTERIZED_TEXT_STATUS`.
  Dedupe links them through signal 2.
- **Voice:** **[assumption]** sharing an audio file to "My status" is probably not supported.
  Hide the button for voice until verified.
- She presses "send" in WhatsApp herself. The audience, ToS and account stay exactly as when she
  posts by hand. Zero ban risk, and nothing on the Mac.
- **Dedupe:** the app records `alsoToWhatsApp.sharedAt` (a small revision, or a `PATCH
  /app/entries/{id}/whatsapp-shared` that the backend reads with the entry). The observer captures
  the WhatsApp copy, and §4 signal 2 suppresses it. If she adds more stickers in WhatsApp's
  editor, the loose threshold or the admin "merge" handles it.

### 5.4 Recommendation

**Build option A** (S in the app, S for the marker, M for dedupe, which is needed anyway).
**Do not build option B** for her real account. If the owner still wants it later, the
prerequisites:
- a separate experiment with a spare number first;
- explicit consent from the traveler, with the history-sync and ToS consequences written down;
- `HistorySyncConfig` limits;
- a send-only helper that drops all non-status events without persisting them;
- a hard off-switch.

Effort for B: L (helper command, upload, audience diagnostics, a second helper supervision path,
failure UI), plus ongoing risk.

---

## 6. API endpoints and contract changes

### 6.1 Contracts (`packages/contracts`)

New module `src/app.ts` (sketch; zod 4, no transforms, exported to `api/schemas/`):

```ts
export const APP_SOURCE_NS = 'app';
/** UUIDv7, lowercase; satisfies the MsgId/SourceKey id pattern. */
export const AppEntryId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const AppEntryKind = z.enum(['photo', 'video', 'gif', 'voice', 'text']);   // CaptureKind minus unsupported
export const AppFileRole = z.enum(['preview', 'media', 'edits', 'source']);
export const AppFile = z.object({
  role: AppFileRole, mimetype: z.string().min(1).max(100), bytes: Count, sha256Hex: Sha256Hex,
  phase: z.enum(['publish', 'archive']),          // phase-1 vs deferred
});
export const AppMedia = z.object({                // WhatsApp-expressible facts only (cf. InboxMedia)
  width: z.int().positive().optional(), height: z.int().positive().optional(),
  seconds: z.number().min(0).max(APP_LIMITS.videoSeconds).optional(),
  gifPlayback: z.boolean().optional(), ptt: z.boolean().optional(),
  waveformB64: Base64.optional(), bgArgb: Argb.optional(),   // voice-status background (WA AudioMessage.backgroundArgb)
});
export const AppEntry = z.object({
  schema: z.literal(1),
  entryId: AppEntryId, rev: z.int().min(1),
  kind: AppEntryKind,
  postedAt: IsoUtc, tz: TimeZone,                 // "Share" tap, device clock / zone
  caption: z.string().max(APP_LIMITS.caption).optional(),   // media kinds only
  text: InboxText.optional(),                     // kind text only — the SAME schema as wa.ts
  media: AppMedia.optional(),
  alt: z.string().max(2000).optional(),           // final visible overlay texts -> accessibilityLabel
  takenAt: IsoUtc.optional(),                     // private; placement suggestion only
  alsoToWhatsApp: z.object({ sharedAt: IsoUtc, via: z.enum(['share_sheet', 'backend']) }).optional(),
  files: z.array(AppFile).max(4),
  client: z.object({ app: z.string().max(32), platform: z.enum(['android', 'ios']), os: z.string().max(32) }),
}).superRefine(/* text <-> kind, media <-> kind, files: 'media' required for media kinds, none for text */);
export const AppEntryCreate = z.object({ contractVersion: ContractVersion, clientNow: IsoUtc, entry: AppEntry });
export const AppUploadSlot = z.object({ uploadId: z.string(), role: AppFileRole, offset: Count, bytes: Count, complete: z.boolean() });
export const AppEntryState = z.object({
  entryId: AppEntryId, rev: z.int(), sourceKey: SourceKey, publicId: CapturePublicId,
  state: z.enum(['receiving', 'uploaded', 'fetching', 'archived', 'withdrawn', 'rejected']),
  reuploadRequested: z.array(AppFileRole), rejectReason: z.string().nullish(),
  uploads: z.array(AppUploadSlot), chunkBytes: z.int().positive(),
  backendLastSeenAt: IsoUtc.nullable(),
  // once mirrored: the same facts the admin shows
  capture: CaptureListItem.nullable(),
  publish: z.object({ state: z.enum(['live', 'publishing', 'not_public']), publishAt: IsoUtc.nullable() }).nullable(),
});
export const APP_LIMITS = { caption: 1024, textBody: 700, videoSeconds: 90, mediaBytes: 100 * MiB, sourceBytes: 600 * MiB,
                            editsBytes: 256 * KiB, chunkBytes: 8 * MiB } as const;   // [assumption] WhatsApp-like caps; 90 s per 2025 reports
```

Notes on the sketch:
- The WhatsApp caps above are **[assumption]**. The 90 s status video limit comes from 2025
  reports (https://green-api.com/en/blog/2025/whatsapp-increases-status-length-to-90-seconds/);
  the caption and text limits need checking against the WhatsApp app.
- `AppEntry` deliberately has **no** coordinates, no layer model, no mentions and no interactive
  annotations.

Changes to existing modules:

| Where | Change | Compat | Size |
|---|---|---|---|
| `ids.ts` | `APP_SOURCE_NS`, `appSourceKey(entryId)` | additive | S |
| `api.ts` `CaptureMirror` / `CaptureListItem` | optional `twinOf: SourceKey`, optional `alt: string` | additive (PHP stores them in new nullable columns) | S |
| `api.ts` `ChangesResponse` / `ChangesPage` | optional `appInbox: { pending: Count, oldestAt: IsoUtc.nullable() }`: a wake-up hint, so the backend fetches the inbox only when needed | additive (older backends strip it) | S |
| `api.ts` `TokenScope` / `TOKEN_KIND_SCOPES` | add `capture`; `app` tokens may have `['capture']` or `['admin']` | needs an API migration (CHECK constraint) | S |
| `api.ts` `Heartbeat` | `appInbox: { fetched: Count, failed: Count }` (optional) | additive | S |
| `api.ts` Settings | optional `app.keep_source_originals` (`none` / `photos` / `all`), `app.place_suggestions` (bool) | additive (unknown keys are skipped by old backends) | S |
| `policy.ts` | `CapturePolicyInput.twinOf?`, `twinRevokedAt?` → `hidden` after the override check; new vectors in `fixtures/vectors/policy.json`; PHP `Policy` mirror | logic change, vectors in both runtimes | S–M |
| `site.ts` `EntryBase` | optional `alt: string` | additive (the SPA ships in the same image) | S |
| `wa.ts` `InboxMedia` | optional `bgArgb` (voice background, also for WhatsApp captures) | additive | S |
| `API_SCHEMAS` | `AppEntryCreate`, `AppEntryState`, `AppEntryListResponse`, `AppInboxPage`, `AppAck`, `AppReject` | new | — |
| `contractVersion` | **no bump needed**: everything is additive. Deploy the API first, as usual | — | — |

### 6.2 Backend (`backend/src`)

| Change | Size |
|---|---|
| Store migration v2: `captures.source` CHECK + `'app'`; columns `app_rev`, `twin_of`, `alt_text`, `phash` (BLOB/hex), `wa_msg_id`; table `app_files(source_key, role, sha256, archive_rel, state)`; outbox kind `app_ack` (+ `app_reject`) | S |
| `capture/app-source.ts`: pull the app inbox (only when `appInbox.pending > 0` or every 5 min); Range download into `DATA_DIR/inbox-app/`; insert the capture (`source: 'app'`, `msgId: null`, `sender: null`, `tz`/`occurredAt` from the API-corrected entry); reuse `awaiting_media` → `received` | M |
| Archive: record type `omw.app-entry` (`entry` verbatim, `artifact`/`source`/`edits` file facts, `revokedAt`); file names `app-<entryId>.<ext>`, `app-<entryId>.source.<ext>`, `app-<entryId>.edits.json`; `backend reprocess` handles both record types | M |
| Ack after archive (outbox `app_ack`, durable, idempotent), reject on permanent failure | S |
| Revisions: a new `rev` → replace the artifact facts and rerun the pipeline (same `sourceKey`); `occurredAt` immutable | S–M |
| Withdraw relay → `revokedAt` (same path as WhatsApp revokes) | S |
| Dedupe: pHash in the pipeline, matcher on insert of either kind, `twin_of`, canonical rule, mirror | M |
| Generator: pass `twinOf` to policy; `alt` into entries | S |
| Control UI: app inbox counters, failed app entries (retry/reject) | S |

### 6.3 API (`api/`)

New route group `/api/v1/app` with its own middleware `AppAuth`:
- Bearer only, `app` token with scope `capture` or `admin`;
- **not** `RequireJsonBody`, because chunks are `application/offset+octet-stream`;
- every other app route still demands JSON.

| Method + path | Body → response | Notes | Size |
|---|---|---|---|
| `POST /api/v1/app/entries` | `AppEntryCreate` → 201 / 200 `AppEntryState` | validates kind/files/limits and the quota; clock-skew correction; idempotent per `(entryId, rev, entryHash)`, 409 on a different hash | M |
| `HEAD /api/v1/app/uploads/{uploadId}` | → 200, `Upload-Offset`, `Upload-Length` | tus core | S |
| `PATCH /api/v1/app/uploads/{uploadId}` | octet-stream chunk ≤ `chunkBytes`, `Upload-Offset`, `Upload-Checksum` → 204 + `Upload-Offset` | 409 offset mismatch, 460/422 checksum, 413, 503 + `Retry-After` (busy), 507 (quota) | M |
| `POST /api/v1/app/entries/{entryId}/commit` | → `AppEntryState` | needs all `phase: publish` files complete; hashes them; state → `uploaded`; stores the app preview in `var/previews/` | S |
| `GET /api/v1/app/entries/{entryId}` | → `AppEntryState` | joins the inbox row, capture mirror, annotation, settings, publish reports (`itemPublishState`, `capturePublishAt`) and the heartbeat time | M |
| `GET /api/v1/app/entries?cursor=&limit=` | → `AppEntryListResponse` | the app's "Recent" screen | S |
| `POST /api/v1/app/entries/{entryId}/revisions` | `AppEntryCreate` with `rev + 1` → `AppEntryState` | caption/alt/media fixes; `postedAt` must equal rev 1 | M |
| `POST /api/v1/app/entries/{entryId}/whatsapp-shared` | `{sharedAt}` → 204 | dedupe marker (§5.3) | S |
| `DELETE /api/v1/app/entries/{entryId}` | → 204 | withdraw: deletes files before the ack, relays a revoke after it | S |
| `GET /api/v1/app/hints` | → `{timezoneCurrent, today: Day \| null, publishMode, delayMinutes, releaseSlots?, quotaLeftBytes, backendLastSeenAt}` | feeds the composer: place suggestion, "goes live about 20:00" | S |
| `GET /api/v1/backend/app/entries?after=&limit=` | → `AppInboxPage` (entries with files to fetch, withdraw requests) | backend scope | S |
| `GET /api/v1/backend/app/uploads/{uploadId}/content` | → bytes, `Range`, `ETag = sha256` | streamed with `fpassthru` | S |
| `POST /api/v1/backend/app/entries/{entryId}/ack` | `AppAck {rev, files:[{role, sha256Hex}]}` → 204 | deletes the files, state → `archived` | S |
| `POST /api/v1/backend/app/entries/{entryId}/reject` | `AppReject {rev, reason, reupload: AppFileRole[]}` → 204 | | S |
| `GET /api/v1/backend/changes` | + `appInbox` hint | additive | S |
| `PATCH /api/v1/admin/captures/{app:…}` | existing `AnnotationPatch` | `Captures::exists()` also accepts known app entries | S |
| `GET /api/v1/admin/captures` | existing | also lists app entries that are not mirrored yet (synthesized items with `mediaState: 'pending'` and the app preview), so the inbox shows them during a Mac sleep | M |
| `PATCH /api/v1/admin/days/{date}`, `PATCH /api/v1/admin/settings`, `POST /api/v1/admin/posts` | existing | allowed for `capture`-scope tokens: only `placeName`/`countryCode` on days, only `timezone.current` in settings, notes/stories in posts **[decision]** | S |

Other API work:
- **Migration `0002_app_inbox.sql`:**
  - `app_entries` (entry_id PK, source_key UNIQUE, rev, state, entry_json, entry_hash, posted_at,
    occurred_at, clock_skew_ms, received_at, committed_at, archived_at, withdraw_requested_at,
    reject_reason, token_id, preview_path, also_to_whatsapp_at, created_at, updated_at);
  - `app_uploads` (upload_id PK, entry_id, rev, role, phase, mimetype, bytes, sha256, path,
    completed_at, acked_at, deleted_at, last_chunk_at);
  - new nullable `captures.twin_of`, `captures.alt`;
  - widen the `api_tokens` scope CHECK.

  S–M.
- **`var/app-inbox/`:** created by `Paths::ensureVar` (`SUBDIRS`), covered by the existing
  `var/.htaccess` "Require all denied". S.
- **Cron:**
  - delete stale slots and acked files;
  - delete app previews once the capture preview exists;
  - alerts `app_inbox_quota` and `app_inbox_stale`;
  - compact tombstones.

  S.
- **Doctor:** `var/app-inbox` writable; budget vs. free space; PATCH/HEAD reach PHP (some hosts
  block methods). S.
- **Upload concurrency slots** (`flock`) and the quota accounting. S.

Total API: **L**.

### 6.4 Admin PWA and app (only the parts this flow needs)

- **Admin:**
  - "App" badge and pending states in the inbox;
  - "Also on WhatsApp / merged" display and unmerge;
  - token creation with a QR code for pairing;
  - the app-inbox quota on Home.

  M.
- **App (flow-related only; UI elsewhere):**
  - local outbox (SQLite);
  - native UIDT upload module with a WorkManager FGS fallback below API 34;
  - entry-state polling while the "Recent" screen is open;
  - share-sheet hand-off;
  - on-device place suggestion.

  M–L.

---

## 7. Assumptions and open checks (ranked)

1. **The host keeps a PHP worker for slow uploads?** Probe as in §1.3; it sets the chunk size and
   the slot count.
2. **Account quota of the live Hetzner plan.** Read it in konsoleH and set `APP_INBOX_MAX_BYTES`
   from it.
3. **Share sheet on her phone:** is "My Status" present, does `EXTRA_TEXT` become the caption, is
   an audio share accepted?
4. **Photo Picker redaction for videos** (MP4 `©xyz`), and HEIC originals with ExifInterface.
5. **Perceptual-hash thresholds** against WhatsApp-recompressed copies. Record fixtures in
   Phase 0, including an image status with `imageSourceType = RASTERIZED_TEXT_STATUS`.
6. **WhatsApp limits** for caption length, text-status length and voice-status length.
7. **Revisions in v1** or not; group revoke for twins; `capture`-scope rights. **[decision]**

---

## 8. Context for the other parts (not this file's scope, checked while researching)

- **ffmpeg-kit:** the README says it is "officially retired"; development continues as
  `FFmpegKitNext` (README update July 2026,
  https://cdn.jsdelivr.net/gh/arthenica/ffmpeg-kit@main/README.md). The old binaries were removed
  from Maven Central in 2025, and registry pages report source-only `ffmpeg-kit-next` releases
  (https://www.nuget.org/packages/FFmpegKit.Net.Full.Android). Not a basis for the app.
- **Media3:** the newest stable is **1.11.1 (2026-09-10)**. 1.11.0 added an `OggMuxer` for
  Opus/Vorbis, which fits WhatsApp-style voice notes; 1.10 moved `LottieOverlay` to
  `media3-effect-lottie`. Transformer with overlay effects is the native path for baking video
  overlays (release notes: https://github.com/androidx/media/blob/release/RELEASENOTES.md; Media3
  1.10 blog: https://android-developers.googleblog.com/2026/03/media3-110-is-out.html).
- **Pipeline fit:** if the app outputs H.264 yuv420p + AAC, the backend only remuxes
  (`video.ts canRemux`), so processing on the Mac takes seconds.

## Sources

Repo (read-only):
- `docs/PLAN.md`, `README.md`, `docs/HOSTING.md`
- `packages/contracts/src/{common,ids,wa,api,site,policy}.ts`
- `backend/src/capture/{ingest,archive,sync-outbox,types}.ts`, `backend/src/pipeline/{index,image,video,text}.ts`,
  `backend/src/store/{migrations,types,outbox}.ts`, `backend/src/sync/{client,index}.ts`, `backend/src/generator/model.ts`
- `api/migrations/0001_init.sql`, `api/src/Http/Routes.php`, `api/src/Http/Backend/BackendController.php`,
  `api/src/Http/Middleware/AdminAuth.php`, `api/src/Http/RequireJsonBody.php`, `api/src/Domain/{Captures,Posts}.php`,
  `api/src/Infra/Paths.php`
- `backend/wa-helper/NOTES.md`, `README.md`, `config.go`, `identity.go`
- `.cache/design-w5/owner-decisions.md`, `.cache/design-w5/proposal.md`
- whatsmeow at the pinned commit (local module cache
  `.cache/go/pkg/mod/go.mau.fi/whatsmeow@v0.0.0-20261116172437-19d61352436f/`):
  - `broadcast.go`;
  - `send.go` (lines 47, 146–230, 295–345, 410–500);
  - `upload.go:46`;
  - `appstate.go:183–196, 295–310`;
  - `store/clientpayload.go:124–157`;
  - `proto/waE2E/WAWebProtobufsE2E.proto` (`ExtendedTextMessage` 1214, `ImageMessage` 1353,
    `VideoMessage` 1133, `InteractiveAnnotation` 1795, `ContextInfo` status fields 1408–1510,
    1688–1709, `MessageAssociation` 1720).

Web (accessed 2026-11-20):
- whatsmeow README (status sending experimental): https://github.com/tulir/whatsmeow
- WhatsApp Terms of Service (EEA, effective 17 Aug 2026): https://www.whatsapp.com/legal/terms-of-service-eea
- Third-party client bans (history): https://techcrunch.com/?p=1108388
- WhatsApp "My Status" share-sheet target, Android beta 2.25.20.3: https://wabetainfo.com/whatsapp-beta-for-android-2-25-20-3-whats-new/
- Status to non-mutual recent contacts (test, 2026): https://wabetainfo.com/whatsapp-is-rolling-out-a-feature-to-share-status-updates-with-unsaved-phone-numbers/, https://piunikaweb.com/2026/05/20/whatsapp-update-lets-strangers-see-status/
- Cloud API: status not supported: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Status video 90 s (secondary): https://green-api.com/en/blog/2025/whatsapp-increases-status-length-to-90-seconds/
- Android UIDT jobs: https://developer.android.com/develop/background-work/background-tasks/uidt
- Android location permissions and accuracy: https://developer.android.com/develop/sensors-and-location/location/permissions
- Photo Picker location redaction: https://www.androidauthority.com/android-photo-picker-location-3683074/, https://issuetracker.google.com/issues/243294058
- Hetzner web hosting plans: https://www.hetzner.com/de/webhosting
- tus-js-client (React Native): https://unpkg.com/tus-js-client@4.3.1/README.md; tus-php: https://packagist.org/packages/ankitpokhrel/tus-php
- ffmpeg-kit retirement: https://cdn.jsdelivr.net/gh/arthenica/ffmpeg-kit@main/README.md
- Media3 release notes: https://github.com/androidx/media/blob/release/RELEASENOTES.md (1.11.1, 2026-09-10)
