# Phase plan: the traveler app (React Native, Android first)

Status: **plan for owner review, revision 2**, 2026-11-20.
- Revision 1 combined the four research notes in this folder: `styling.md` (WhatsApp encoding,
  data model, flattening), `stack.md` (libraries, builds, uploads, auth), `flow.md` (data flow,
  ownership, safety, dedupe, API) and `ux.md` (screens, motion, haptics, gestures).
- Revision 2 applies the skeptical review in `app-critique.md`. **Appendix A** lists every critique
  point with the verdict (accepted, accepted with changes, rejected) and the reason.
- The full evidence for unchanged parts is in the notes; §9 records how they were reconciled.

Binding inputs:
- the owner's request (a React Native app, Android first, for capturing and sharing travel moments
  without WhatsApp, with WhatsApp-style styling, a modern calm UI, gentle animation, haptics and
  gestures);
- the owner decision "**stay WhatsApp status compatible with what we do**";
- app owner decisions A1–A5 (`owner-decisions.md` here). A4 sets "also while roaming" **off by
  default**; this plan keeps that default (§5.1, Q6);
- wave-5 owner decisions D1–D12 (`../design-w5/owner-decisions.md`) and the wave-5 proposal's
  safety defaults (`../design-w5/proposal.md` §3.1) and its rule "no real travel content on the
  live host until P1b passes" (§6.1 there).

Nothing in the repo was changed for this plan, and no live host was contacted. `.env` and
`.secrets/` were not opened.

Labels: **[A]** = assumption, with how to check it · **[verified]** = checked in the repo or a cited
source · † = version or platform fact re-checked on 2026-11-20 (in revision 1 or 2).

Effort scales (one developer who knows the codebase, tests included):
- **Work items:** S ≤ 1 day · M 2–4 days · L 1–2 weeks (the research notes' scale).
- **Milestones:** S ≤ 2 dev-weeks · M 3–6 dev-weeks · L more than 6 dev-weeks.
- The repo has no React Native, Gradle or Kotlin code yet, and the Mac has no JDK. The ramp-up is
  budgeted in M0.

---

## 1. Summary for the owner

1. The traveler gets an Android app, "On My Way". She takes or picks photos and videos, writes
   coloured text cards, records voice notes, and (from v0.6) decorates pictures with words and emoji.
   She taps Share, and the moment appears on the website like her WhatsApp statuses.
2. Everything she makes is exactly what a WhatsApp status could be. Decorations are painted into
   the picture on the phone, and the caption stays separate text. The website shows app posts with
   the same code as WhatsApp posts. Later, the same picture can go on to WhatsApp with one tap.
3. It works without a connection. Moments wait safely on the phone and upload in small pieces that
   shrink on bad connections. Uploads keep going after she leaves the app or restarts the phone.
   If she force-closes the app, they continue when she opens it again.
4. The same privacy rules apply as for WhatsApp posts. Only approved followers see anything, posts
   appear with the delay, and the exact location never leaves the phone (the app also removes it
   from videos). The app on its own can **never** publish a WhatsApp status early, un-hide what you
   hid, or bring back a deleted status. A lost phone can be cut off from the admin.
5. The look is calm, rose and violet like the website, with soft animations and light vibration
   feedback only where it means something. The gestures are the ones she knows from WhatsApp.
6. We advise against letting the home computer post to WhatsApp with her number (Q1). iOS comes
   later.
7. It comes in steps:

   | Step | What she gets | Effort (one developer) |
   |---|---|---|
   | M0 | A 1–2 week test on her real phone and the hosting | about 1.5 dev-weeks |
   | **v0.5** "trip-ready" | Camera, gallery, text cards, voice, video trim, captions, safe uploads | about **11–12 dev-weeks** more |
   | v0.6 "styling" | Words, emoji, crop on photos and videos; "Now"; fix before it appears | about 5 dev-weeks |
   | v1 "journal" | Her journal, place questions, polish, field test | about 5–6 dev-weeks |

   **v0.5 reaches her phone after about 13 dev-weeks** (about 3 months). Before the wave-5 follower
   gate is finished, the app can run **archive-only**: her moments are uploaded and kept in the
   private home archive, but nothing is published (Q8).
8. The decisions for you are in §8.

---

## 2. Scope

### 2.1 What "WhatsApp status compatible" means in practice

| Kind | What the app produces (the published artifact) | Message fields (as in WhatsApp) | Rendered by |
|---|---|---|---|
| Photo | One JPEG with every overlay **baked into the pixels** on the phone (text, emoji, crop/rotate; later drawing, stickers, filters). No EXIF at all: Skia writes none, and a test feeds a GPS-tagged input | `caption` (separate text), `width/height`, alt text (`accessibilityLabel`, v0.6) | the site's existing PhotoSlide |
| Video | One H.264 + AAC MP4 (SDR, ≤ 1080p, ≤ 30 fps), trimmed to ≤ 60 s, overlays baked in (v0.6), optionally muted. **The muxer drops all source metadata except orientation** (Media3 copies GPS by default, §3.3) | `caption`, `seconds`, `width/height`, alt text | VideoSlide |
| GIF (v1.1) | A muted looping MP4 (`gifPlayback`) of ≤ 10 s | as video, `gifPlayback: true` | VideoSlide (loop) |
| Text | **No pixels.** `{body, bgArgb, textArgb, font}`, the same `InboxText` fields as captured statuses; font = one of WhatsApp's 8 `FontType` values | as captured | TextSlide |
| Voice | AAC-LC in M4A (`audio/mp4`), ≤ 60 s. The backend computes the 64-peak waveform, as it already does for captured statuses without one | `ptt`, `seconds` (waveform derived on the Mac) | VoiceSlide |

Evidence for this model [verified in the pinned whatsmeow protos, styling.md §1.1, flow.md §5.1]:
- WhatsApp has **no layer model**. Text, drawing, stickers, crop and filters are pixels. Even
  location, link and music stickers are pixels with a tap area on top. Layouts are one flattened
  image.
- The fields WhatsApp sends separately are the caption, the text-status body, colours and font, the
  voice waveform and background, `accessibilityLabel`, link-preview data, mentions, audience,
  music ids and interactive-sticker associations.
- So "same model as WhatsApp" is exact.

Two compatibility notes:
- **Voice codec.** WhatsApp records OGG/Opus. The app records AAC, because the backend converts
  every voice note to AAC M4A anyway [verified, `backend/src/pipeline/voice.ts:1–5`], so the
  published file is identical in form. Voice is not offered to WhatsApp's status (M0 row 8).
- **Fonts.** Three of the eight WhatsApp fonts (`SYSTEM`, `SYSTEM_BOLD`, `SYSTEM_TEXT`) render in
  each viewer's own system font on the site [verified, `frontend/shared/src/fonts.ts:32–40`,
  `theme.css:76–77`]. WhatsApp itself behaves the same way (Roboto on Android, SF on iPhone). The
  app labels them "Looks like each phone's own font" and does not promise a pixel match for them.

Additive metadata (allowed by A2):

| Metadata | Verdict |
|---|---|
| **Alt text** | **v0.6, published, editable.** WhatsApp's own field (`ImageMessage`/`VideoMessage.accessibilityLabel`). The app pre-fills it in her language as "Text on image: <the final visible words>", plus sticker names. Deleted or covered text never leaks into it. The site **combines** it with the owner's description (§3.7), and wave 5's auto-hold also scans it (§3.8) |
| **Source marker** (`app` / `whatsapp`) | **v0.5, derived** from the `sourceKey` namespace, never stored or published. Admin and app badge only |
| **Voice background colour** | **v1.1** (also extracted for captured statuses) |
| **Rasterized-text flag** (`imageSourceType = RASTERIZED_TEXT_STATUS`) | **v1.1**, with decorated text statuses. The player then shows the image contained, without the cover crop and Ken Burns (applies to both sources) |
| **Private original + edit list** | **On the phone from v0.6** ("Fix before it appears"). Uploading them to the private home archive follows Q2, from v1.1. The upload contract gets the `edits` and `source` file roles **when they are first used** (an additive enum change). Never published, never mirrored |

### 2.2 v0.5 "trip-ready core" (must)

- **Capture:** in-app camera (expo-camera unless M0 says otherwise): tap = photo, hold = video
  (stops at 60 s), pinch zoom, double-tap to flip, flash.
- **Gallery:** multi-pick of photos and videos through the system Photo Picker, with no media
  permission. The selection order is the posting order.
- **Text statuses:** body ≤ 700 characters, 12 background colours (all ≥ 4.5:1 with white text),
  the 8 WhatsApp fonts shown with the site's substitutes, and the site's size scale.
- **Photo, video and voice with a caption.** Video: trim to ≤ 60 s, mute, export on the phone.
  Voice: up to 60 s, hold to record, slide to cancel.
- **Publish sheet:** "As usual" (with the delay from the settings: "appears in about 24 h"), "Hold
  back", "Only for me". "Put it on that day?" for gallery photos taken on an earlier day.
- **Offline outbox and a native background uploader** with adaptive chunks, the A4 rules
  (automatic/manual, Wi-Fi only, photos also on mobile data) and roaming remembered **per SIM**.
  One status vocabulary, from "Preparing…" to "Archived ✓" / "Live ✓".
- **Today screen** with the queue sheet. **Settings.** **App lock** (fingerprint, face or PIN).
- **Pairing** by a one-time code, typed or opened as an `omw://` link (QR scan if expo-camera's
  barcode scanner works in M0).
- **Server:** the app inbox on the API, the backend's `app:` source, the narrow `capture` token
  scope (§3.4), the archive-only switch (§3.8), the admin's "Connect a phone" and App badge.
- **de/en**, a pseudo-ar smoke test, TalkBack labels, font scaling, reduced motion.
- Haptics on her own touches (§5.3) and 3 signature transitions (camera reveal, send, Live ✓).

### 2.3 v0.6 "styling" (about 5 dev-weeks)

- Skia editor on photos and video: text overlays (8 fonts, colour, plain/pill/solid with **pill as
  the default** for legibility, alignment), emoji, crop/rotate/flip with presets, safe-area guides
  (§5.1), snap guides, the trash, undo/redo, the TalkBack mini bar.
- Photo bake (Skia offscreen → JPEG). Video bake: the overlay as a transparent PNG →
  Media3 `OverlayEffect` + `Crop`/rotation.
- Drafts (autosaved edit document, Back = draft).
- Alt text (pre-filled, editable), the site's combined alt chain, and the auto-hold on alt text
  (needs wave-5 P0).
- **"Now"** on her own app entries, with a fresh fingerprint/PIN every time (§3.4), if Q9 = yes.
- **"Fix before it appears"** (§3.3), replacing an entry that is not yet public.
- Share-in from other apps (Google Photos, the gallery app): it copies into the outbox at once and
  strips metadata like every other input.
- Admin: pending app entries with their preview, so the owner can hide one while the Mac sleeps.

### 2.4 v1 "journal and polish" (about 5–6 dev-weeks)

- **Journal:** her entries per day, plus WhatsApp captures read-only (Q4), a viewer that renders like
  the site, Hide/Show, "Recently deleted" for 30 days.
- **Place, if Q10 = yes:** "Staying in <city> tonight?" with "Day trip" as an answer, and an "I've
  moved on" button for wave 5's departure hold (§3.8). Not built before wave-5 P0 has the hold.
- Motion pass (the remaining named transitions), full TalkBack and 200 % font QA, pseudo-ar QA.
- Launcher shortcuts, "Keep a copy in Photos" via MediaStore (no permission).
- The camera upgrade to VisionCamera (tap-to-focus, slide-to-zoom, volume-key shutter), if M0 shows
  it runs on the now-stable CameraX 1.7.0 †.
- The field test (§6.4) and 7 days of owner dogfooding, then onboarding the traveler.

### 2.5 v1.1 (should, about 6 dev-weeks)

- Drawing: 3 pens, plus a **blur brush** for faces, plates and hotel names (a safety tool; WhatsApp
  has one too).
- Own static stickers: date stamp, place-name stamp (the name only), washi tape, paper plane, heart,
  day tag.
- Filters as colour matrices, only after a pixel test shows that Skia and Media3 `RgbMatrix` give
  the same result (they may work in different colour spaces [A]).
- "Loop as GIF" for clips of 6 s or less. Voice background colour.
- Decorated text statuses rasterized to a 1080×1920 photo flagged `rasterized_text_status`, shown
  contained on the site.
- Layouts (up to 6 photos in one image).
- **"Also on WhatsApp"** (Q1, §2.6).
- Originals and edit lists to the private archive (Q2).
- Revisions after publication (`rev + 1`, same id), if the owner wants them after using v0.6's
  "Fix before it appears" (Q3).
- The embedded photo picker (inline grid), once the androidx library is stable.

### 2.6 Later and never

| Item | Notes |
|---|---|
| **iOS** | The same JS. The video module gets an AVFoundation version (`AVVideoComposition` + Core Image with the same overlay PNG and colour matrices) with the same metadata filter. Bundle Noto Color Emoji, because Apple emoji baked into published pixels is a licensing grey area. Apple Developer Program 99 USD/year, TestFlight, EAS Build free tier |
| **The optional WhatsApp path** | **Recommended form (v1.1):** "Also on WhatsApp" sends the same baked JPEG/MP4 and the caption by an **explicit intent** to WhatsApp (`ACTION_SEND`, `setPackage("com.whatsapp")`, or `com.whatsapp.w4b`), whose own picker lists "My status" [A: check in M0 row 8]. She presses send in WhatsApp. Back in the app, one question: "Posted on WhatsApp?" Yes → the app copy becomes "Only for me", and the observer's `wa:` capture is the published one. **No dedupe is needed.** Text cards: if M0 shows that `text/plain` sent to "My status" makes a real text status, they go that way (WhatsApp then picks colour and font); otherwise they are not offered. Voice is not offered. pHash dedupe (M) only if the owner wants the app copy to win (higher quality, alt text) |
| **Backend posting with her number** | **Not recommended** (Q1). It needs her own account linked to the Mac (all her chats would reach it), it reverses PLAN's founding decision "The traveler's own account is never touched" [verified, `docs/PLAN.md:24`], it breaks WhatsApp's terms, and her account could be blocked while abroad. If it is ever built: a spare number first, her written consent, a send-only helper, an off switch (flow.md §5.4) |
| **Admin features in the app** (wave 5): followers, messages, reaction counts, views | Each needs the `admin` scope plus wave 5's step-up. Until then the admin PWA does it. The Journal can show quiet "♥ 12 · 34 views" lines once wave 5 has them |
| **Push notifications** | expo-notifications with **FCM HTTP v1 sent directly from PHP** (an RS256 JWT via `openssl_sign`), batched in the 5-minute cron. Counts and ids only |
| Also later | link previews (both sources at once), animated stickers, cut-out photo stickers, motion photos, a Quick Settings tile, fetching an archived original back to the phone |
| **Never** | music, mentions, Add Yours / question / reaction / poll stickers, audience lists, view once, AI styles, GIF search, tappable location stickers (coordinates) |

---

## 3. Architecture and data flow

### 3.1 The path of an app entry

```
 PHONE (On My Way app)                API HOST (PHP · Hetzner shared)        HOME MAC (backend · Docker)               SITE HOST (Apache · wave-5 gate)
 ─────────────────────                ───────────────────────────────        ───────────────────────────               ────────────────────────────────
 camera · Photo Picker · text · voice
 editor (Skia, v0.6)
 bake on the device:
   photo → JPEG (Skia / image-manipulator, no EXIF)
   video → MP4 (Media3 1.9.1, metadata filtered)
   text  → {body,bgArgb,textArgb,font}
   voice → AAC M4A
 outbox/<ULID>/ manifest.json + media  (durable before "Shared ✓")
   │
   ├─ POST /app/entries ───────────────▶ app_entries row (receiving, token_id)
   ├─ PATCH /app/uploads/{id} × n ─────▶ var/app-inbox/…part  (tus offsets, sha256 per chunk;
   │  native uploader (UIDT / WorkManager)  1 transfer slot, shared with the backend's downloads)
   │  adaptive chunks 256 KiB – 8 MiB, ≤ 15 s each, ≤ 10 requests / 10 s
   ├─ POST …/commit ───────────────────▶ state uploaded ── appInbox hint in /changes ──▶ pull loop (15 s)
   │                                                     ◀── GET …/content (Range) ──── inbox-app/ → archive app-<id>.*
   │                                                     ◀── POST …/ack ─────────────── (durable outbox)
   │                                     files deleted, state archived                 SAME pipeline as wa: captures
   │                                     captures mirror ◀── PUT /backend/captures/app:<id>
   │                                                                                    generator: same policy, same Entry
   │                                                                                    archive-only switch: live target skips app:
   │                                                                                    publisher ── SFTP ──────────────────▶ /media /data HTML
   ├─ GET /app/entries/{id} ◀──── "Uploaded · waiting for the home computer (offline since 02:10)"            (followers only)
   │                              "Archived ✓" · "Appears in about 24 h" · "Live ✓"
   └─ v1.1: explicit intent → WhatsApp "My status" → "Posted?" yes → app copy Only for me; observer's wa: copy is published
```

Why it needs almost no new rendering code [verified, flow.md §1.1]:
- `SourceKey` already accepts any `<ns>:<id>`, and `publicIdForSourceKey()` (TS and PHP) does not
  care about the namespace.
- The pipeline (`processOriginal`), the store state machine and the generator (which picks "ready
  captures" with `effectiveCaptureVisibility() === 'public'`) do not look at the source.
- The sharp/ffmpeg steps strip metadata again on the Mac (`-map_metadata -1`, bitexact
  [verified, `backend/src/pipeline/video.ts:66`]).
- An H.264 yuv420p + AAC upload takes the backend's remux fast path, which takes seconds.

### 3.2 Data ownership (one primary per datum, extends PLAN "Data ownership")

| Datum | Primary | Copy | Notes |
|---|---|---|---|
| App entry **in transit** (entry JSON, artifact, preview) | none: a queue item in the API's app inbox | – | Deleted after the backend's sha256-checked ack, like WhatsApp's servers for a status |
| App entry **as a capture**: kind, occurredAt, tz, caption, text style, media facts, alt text, revokedAt | **Backend** (`captures`, archive record `omw.app-entry`) | API `captures` mirror via `PUT /backend/captures/app:<id>` | The same table and `CaptureMirror` contract as `wa:` captures |
| Which token created an app entry (`app_entries.token_id`) | **API** | – | Needed for the scope rules (§3.4) |
| Private source original + edit list | the phone (v0.6); the **backend archive** from v1.1 (Q2) | – | Never mirrored, never published |
| Owner data about the entry: description, visibility override (+ **who set it**: `owner` or `app`), `localDateOverride`, cover, portrait | **API** `annotations`, keyed by `app:<id>` | Backend via the change feed | The app writes only what §3.4 allows |
| Day place, time zone, trips, settings | **API** | Backend | The app writes none of these in v0.5/v0.6; v1 only the place answers of Q10 |
| Outbox, drafts, edit document, local originals | **the phone** | – | The durable truth until the backend reports `archived` |

The Mac can sleep: entries wait in the API inbox and nothing expires. So app entries **relax** the
"Mac never sleeps more than 12 h" rule, which only WhatsApp media needs.

### 3.3 Identity, time, location and corrections

- **Id:** a client ULID made at "Share" (the repo already uses ULIDs for post ids), so
  `sourceKey = "app:<ULID>"`. `publicId` comes from the existing hash. The ULID never appears in
  static output.
- **Time:** `occurredAt` = the moment she taps Share. The API corrects it for clock skew
  (`clientNow`). It is **never** the photo's EXIF time, because that would let an old photo skip the
  publish delay. The time a photo was taken stays on the phone and only drives the "Put it on that
  day?" suggestion, which writes `localDateOverride` on that entry.
  - A future time or a skew beyond 24 h is clamped to the server's receive time.
  - An entry posted more than 30 days before it arrives (a forgotten manual queue) is **accepted as
    "Hold back"** with an admin note, not rejected.
- **Location:**
  - The entry contract has **no coordinate field**.
  - The Photo Picker redacts GPS in photos, and the app never requests `ACCESS_MEDIA_LOCATION`. The
    in-app camera writes no location.
  - **Videos:** Media3 Transformer copies the input's metadata, including `Mp4LocationData` (the
    `©xyz` atom), into the output by default [verified by the critique in the 1.9.1 source:
    `SampleExporter` → `MuxerWrapper.addTrackFormat` → `addMetadataEntry`]. The export therefore
    uses `InAppMp4Muxer.Factory(MetadataProvider)`, which exists in 1.9.1 † and whose
    `updateMetadataEntries(Set<Metadata.Entry>)` removes every entry except orientation (location,
    XMP, timestamps). Share-in (v0.6) and camera files do not pass the picker's redaction, so this
    matters.
  - **Photos:** Skia's JPEG has no EXIF by construction; expo-image-manipulator re-encodes HEIC and
    rotated photos. Both are tested with a GPS-tagged input.
  - The backend strips everything again. The site never depended on the app for this.
  - The place belongs to the day. In v0.5/v0.6 it stays an admin action. v1 adds the evening
    question of Q10, reverse-geocoded **on the phone** from a one-shot **coarse** fix against a
    bundled city list (GeoNames `cities15000`), and sent as `placeName` + `countryCode` only.
- **Withdraw** works in every state. Before the ack, the API deletes the files. After it, a revoke
  is relayed and `ingest.on_revoke` applies, as for a WhatsApp delete.
- **Fix before it appears** (v0.6), replacing Q3 (b) for now. While an entry is not yet public, "Edit
  again" reopens the editor from the source and edit document kept on the phone. Share then creates
  a **new** entry with `replaces: <old id>`. The API:
  - checks that the same token created the old entry and that it is not public;
  - gives the new entry the old `occurredAt`, so the delay does not restart and is not skipped;
  - copies the old entry's annotation (owner description, visibility);
  - withdraws the old entry.

  Once an entry is public, the choice is "Take it down" (immediate) and share again. Revisions after
  publication come later (v1.1, if wanted).

### 3.4 What an app token may do (the `capture` scope)

The rule: **tighten freely, loosen only with fresh authentication, never loosen what the owner set,
and publish early only her own app entries.** Revision 1 let the scope write any annotation. That
was a hole, because an annotation override wins before the revoke check and the delay
[verified, `packages/contracts/src/policy.ts:108–109, 135–136`]:

```ts
const override = annotation?.visibility;
if (override) return override;          // before the revoke check and the delay
if (capture.revokedAt && settings['ingest.on_revoke'] === 'hide') return 'hidden';
```

| Action from the app | `app:` entry made by this token | `app:` entry made by another device | `wa:` capture |
|---|---|---|---|
| Create, upload, withdraw before ack | yes | – | – |
| Set `pending` ("Hold back") or `hidden` ("Only for me", Hide) | yes | yes (v1 Journal) | yes (v1 Journal, if Q4 = a) |
| Clear an `app`-set `pending`/`hidden` (back to "As usual") | yes, **fresh auth** | no | yes, **fresh auth**, only if the app set it |
| Clear or change an **owner**-set override | **no** | **no** | **no** |
| Set `public` ("Now") | v0.6, **fresh auth**, only if Q9 = yes and no auto-hold word matched | no | **no** |
| `localDateOverride` ("Put it on that day?") | yes | no | no (admin) |
| Description, day text, place, time zone, settings, tokens, followers, messages | no | no | no |
| v1, if Q10 = yes: tonight's place, "I've moved on" | the day of her entries; "moved on" needs **fresh auth** | | |

Implementation:
- **API:** a dedicated route, `PUT /app/visibility/{sourceKey}`, guarded by `AppVisibilityRules`.
  The `capture` scope never reaches the admin annotation routes. The API stores
  `annotations.visibility_set_by` (`owner` | `app`) and `app_entries.token_id`.
- **"Fresh auth"** = `BiometricPrompt` with `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` and no grace
  period, on the phone. The server cannot verify it, so the server-side rules above are the real
  limit. Fresh auth only stops a casual thief with an unlocked phone.
- **PHPUnit:** a `capture` token gets 403 for `public` on a `wa:` key, on another token's entry,
  on a revoked capture, and for loosening an owner override. It gets 403 on tokens, settings,
  followers and the admin annotation routes.
- **Today an `app` token is a full admin token** [verified, `api/migrations/0001_init.sql:186`
  forces `["admin"]`; `AdminAuth.php:58–65` accepts app bearers]. The migration widens the CHECK
  so that `app` tokens can carry `["capture"]`, and pairing issues only that.
- **Cross-wave question for wave-5 P0** (Q11): should a `public` override ever beat a WhatsApp
  delete? Today an owner's "Publish now" on a status she deleted on WhatsApp brings it back.
  Recommendation: the revoke wins. A policy vector records the decision either way.
- **The admin PWA on her phone** [A: check whether the traveler is logged into the admin on the
  same phone; D2 and D7 suggest she uses the admin]. If she is, that session is a stronger key than
  the app token. Wave 5's step-up window should then also cover "Publish now" and un-hiding.

### 3.5 Contract changes (`packages/contracts`, all additive, no `contractVersion` bump)

| Module | Change | When | Size |
|---|---|---|---|
| `common.ts` / `ids.ts` | `APP_SOURCE_NS = 'app'`, `AppEntryId` (ULID), `appSourceKey()`, derived `captureOrigin()` | v0.5 | S |
| `wa.ts` | export `Argb`; optional `InboxMedia.accessibilityLabel` (v0.6), `.bgArgb` and `.imageSource` (`WaImageSourceType`, v1.1). They apply to captured statuses too | v0.6/v1.1 | S |
| new `app.ts` | `AppEntry` `{schema 1, entryId, kind, postedAt, tz, caption?, text?: AppText (InboxText, all set, opaque bg, white text), media?: InboxMedia facts, localDate?, replaces? (v0.6), visibility?: 'pending'\|'hidden', files[] {role media/preview, mimetype, bytes, sha256Hex}, client}`; `AppEntryCreate {contractVersion, clientNow, entry}`; `AppEntryState`; `AppUploadSlot {id, offset, chunkMin, chunkMax}`; pairing types; `APP_LIMITS` (caption 1024, text 700, alt 1000, video 60 s, voice 60 s, photo ≤ 1600 short / 2880 long side, video long side ≤ 1920, media 100 MiB, chunk 256 KiB–8 MiB). Mimetypes: `image/jpeg`, `video/mp4`, `audio/mp4`. The `superRefine` mirrors `InboxMeta`'s kind rules. **No** coordinates, layers, mentions, interactive annotations or `takenAt` | v0.5 | M |
| `site.ts` | optional `EntryBase.alt` (v0.6), `AudioMedia.bg` and the rasterized-text flag (v1.1) | v0.6/v1.1 | S |
| `api.ts` | `CaptureMirror`/`CaptureListItem`: optional `alt`. `ChangesResponse.appInbox {pending, oldestAt}` (a wake-up hint). `TokenScope` + `capture`. Optional `Heartbeat.appInbox`. `AppVisibilityRequest`. `AppHints`. New `API_SCHEMAS` entries | v0.5 | S–M |
| `policy.ts` | v0.6: the wave-5 auto-hold input also reads `alt` (with wave-5 P0's word lists). Q11's vector. Shared vectors in `fixtures/vectors/policy.json`, mirrored in PHP `Policy` | v0.6 | S |

Not in the contracts:
- The edit document (`EditDoc v1`, styling.md §3.7) stays inside the app package. The server treats
  it as opaque.
- No new `@omw/tokens` package while waves 4 and 5 edit `frontend/shared`. A script generates a
  JSON snapshot for the app (palette, springs, `WA_FONTS`, the `textStatusScale` thresholds), and a
  test fails when the snapshot is stale. The package move can follow once the waves settle.

Deploy order (PLAN D): contracts → **API first** (`CaptureMirror.json` has `additionalProperties:
false` [verified]) → backend + site → admin → app.

### 3.6 API changes (`api/`, v0.5 total **L−**)

A new route group `/api/v1/app` with its own `AppAuth` middleware: Bearer `app` token with scope
`capture`. It is exempt from `RequireJsonBody` only for the binary chunk route.

| Endpoint | Purpose | When | Size |
|---|---|---|---|
| `POST /admin/devices/pairings` (session) | One-time code: 128 bit, stored as sha256, **single use**, valid **1 h by default, up to 24 h** (the owner picks, because the code may travel by chat across time zones). Returns `omw://pair#<code>` and an 8-character typed form | v0.5 | S |
| `POST /app/pair` (unauthenticated, rate-limited like login) | `{code, deviceName, platform, appVersion}` → `TokenCreated` (kind `app`, scope `capture`, named after the device, sliding expiry about 180 days). Consuming the code and creating the token happen in one transaction. **Alert to the owner** ("A phone was connected: <device>") | v0.5 | S |
| `POST /app/entries` | `AppEntryCreate` → `AppEntryState`. Validates limits and quota, corrects clock skew, records `token_id`, applies `visibility`/`localDate` as `app`-set annotations, creates the upload slots. Idempotent per `(entryId, entryHash)`; 409 on a different hash. With `replaces` (v0.6): the rules of §3.3 | v0.5 | M |
| `HEAD` / `PATCH /app/uploads/{id}` | tus 1.0 core subset: `Upload-Offset`, `application/offset+octet-stream`, `Upload-Checksum: sha256` per chunk. 409 with the offset on a mismatch, 460 on a checksum mismatch, 413, **503 + `Retry-After` when the transfer slot is busy**, 507 when the budget is full. `X-HTTP-Method-Override` in case the host blocks PATCH | v0.5 | M |
| `POST /app/entries/{id}/commit` | Verifies each complete file's sha256; state → `uploaded`; keeps the 640w preview | v0.5 | S |
| `GET /app/entries/{id}`, `GET /app/entries` | State + capture mirror + effective visibility + `backendLastSeenAt` | v0.5 | M |
| `DELETE /app/entries/{id}` | Withdraw | v0.5 | S |
| `PUT /app/visibility/{sourceKey}` | The rules of §3.4 | v0.5 (own entries), v1 (Journal) | S–M |
| `GET /app/hints` | v0.5: publish mode, delay, `backendLastSeenAt`, budget left. v1: release slots and departure-hold state for "Appears tomorrow ~08:00" | v0.5/v1 | S |
| `GET /backend/app/entries`, `GET /backend/app/uploads/{id}/content` (Range, `fpassthru`), `POST …/ack`, `POST …/reject` | The backend side of the inbox. Content downloads take the **same transfer slot** as uploads | v0.5 | S–M |
| existing admin routes | `Captures::exists()` accepts known app entries, so the owner can hide or describe an entry while the Mac sleeps. Device list with "Disconnect". `GET /admin/captures` lists pending app entries with their preview (v0.6) | v0.5/v0.6 | M |

Other API work:
- **Migration** (numbered after wave 5's `0002_access`/`0003_contact`, whichever lands first):
  `app_entries` (with `token_id`, `replaces_id`), `app_uploads`, `pairing_codes`;
  `annotations.visibility_set_by`; nullable `captures.alt`; the widened `api_tokens` scope CHECK
  [verified, `0001_init.sql:186`]. S–M.
- **`var/app-inbox/`** under the existing deny rule.
- **Transfer slots.** One by default, enforced with `flock`. They are shared by upload `PATCH`es
  and the backend's content downloads, because the account's PHP workers are few and the admin, the
  sync and wave 5's gate also need them. After the host probe, the value becomes workers − 2, at
  least 1. JSON requests do not take a slot.
- **Disk budget.** The API's SQLite database lives in the same `var/`, and the site may share the
  account quota (`docs/HOSTING.md`: "They can be the same Hetzner account"). A full quota means
  `SQLITE_FULL`, and the admin, the sync and wave 5's gate fail with it. So:
  - `APP_INBOX_MAX_BYTES` is at most **10 % of the account quota** shown in konsoleH (1 GiB until the
    quota is known);
  - uploads get 507 before that point; originals (v1.1) may use at most half of it;
  - the doctor and cron alert at 80 % of the budget and on low free space for the database.
- **Cron:** deletes stale slots (72 h), acked files and replaced previews; alerts when an entry has
  waited more than 24 h; compacts tombstones after 90 days.
- **Doctor:** `var/app-inbox` writable; PATCH and HEAD reach PHP; a binary body passes.
- No App Links and no `/.well-known/assetlinks.json` in v0.5: pairing uses the typed code and the
  `omw://` link. App Links can come with the QR in v1 if the custom link proves awkward.

### 3.7 Backend, site and admin changes

| Change | When | Size |
|---|---|---|
| Store migration v2: `captures.source` CHECK + `'app'`; `alt_text`; `app_files`; outbox kinds `app_ack`, `app_reject` | v0.5 | S |
| `capture/app-source.ts`: pull the inbox when `appInbox.pending > 0` (else every 5 min); Range download into `DATA_DIR/inbox-app/`, backing off on 503; sha256 check; archive as `app-<id>.<ext>` + an `omw.app-entry` record; durable ack; reject with a reason | v0.5 | M |
| Withdraw relay → `revokedAt`; replaced entries (v0.6) are withdrawn the same way | v0.5 | S |
| **Archive-only switch** (`APP_PUBLISH_LIVE=false` in the backend config): the live publish target treats `app:` captures as hidden, and the local preview target renders them [A: per-target filtering; S to add if the generator lacks it] | v0.5 | S |
| Generator: `Entry.alt` from `media.accessibilityLabel` | v0.6 | S |
| wa-helper (Go): extract `accessibilityLabel`, `AudioMessage.backgroundArgb` and `imageSourceType` for captured statuses (they are already kept in `rawProtoB64`) | with PLAN Phase 0 | S |
| Control UI: app-inbox counters, failed app entries | v0.5 | S |
| v1.1: "Posted on WhatsApp?" handling is app + API only (visibility `hidden`, set by `app`). pHash dedupe only if the owner asks for it | v1.1 | S (M with dedupe) |

**Site** (v0.6): the alt chain in `items.ts`. Today it is `description ?? caption` [verified,
`frontend/site/src/player/items.ts:49`]. It becomes:

```
alt = [description?.text, entry.alt].filter(Boolean).join('. ') || caption || ''
```

So the owner's description no longer hides the words that are baked into the picture. The caption
stays the fallback, because the player already shows it as visible text. Behaviour for today's
captures (no `alt`) is unchanged. v1.1: a solid VoiceSlide background when `bg` is set, and
rasterized text statuses shown contained, without the cover crop or Ken Burns.

**Admin PWA:** "Connect a phone" (typed code + `omw://` link, choice of 1 h or 24 h; QR display if
wave 5 has added a QR component by then), device list with Disconnect, the App badge (v0.5);
pending app entries with previews and the inbox budget on Home (v0.6).

**Docs:** an emergency card in `docs/OPERATIONS.md`: disconnect the phone, lock the site (wave 5),
check pending app entries, re-pair after a false alarm (the outbox survives, §5.1).

### 3.8 How it fits wave 5 (approval-only followers)

- **The app never talks to the site host.** It talks only to the API, with its own token. It is
  not a follower, holds no gate cookie, and needs nothing from the gate.
- **The same policy for every source.** App entries go through `effectiveCaptureVisibility()`, so
  they get wave 5's defaults: the 24 h delay and the release slots, the departure hold, 3-hour
  time buckets, no coordinates and no "here now". The publish sheet shows the outcome in words.
- **Auto-hold and baked words (v0.6).** Wave 5 scans captions, text statuses and notes, and says
  plainly that "text inside photos" cannot be scanned (proposal §3.1). For app entries the app
  knows those words: they are the alt text. So the auto-hold input also reads `alt`, in `policy.ts`,
  `Policy.php` and the vectors. This covers WhatsApp captures that carry an `accessibilityLabel`,
  too. The app runs the same word lists (from `@omw/contracts`) before Share: on a match, the
  publish sheet hides "Now" and says why. If she deletes the words from the alt text on purpose,
  the server cannot see them. The auto-hold is a net against accidents, not against her own choice.
- **The departure hold and places.** The hold releases a place's days when "a later day carries a
  different place" (proposal §3.1). A daily "Today in <city>?" chip would release held days after
  a day trip or a nearest-city mismatch. So revision 2 **cuts the daily chip**. Places stay an admin
  action in v0.5/v0.6. v1 offers, if Q10 = yes:
  - an evening question "Staying in Hội An tonight?" with "Yes", "Day trip" (no change) and
    "Somewhere else";
  - an "I've moved on" button (fresh auth), which counts like the owner's "moved on";
  - a policy vector "a day trip does not release".
- **Before P1b: archive-only (Q8).** The wave-5 rule "no real travel content on the live host until
  P1b passes" exists because the site has no gate yet. With Q8 = yes, real app entries pass through
  the API's private, denied inbox (deleted after the ack) into the home archive, and the live
  target publishes none of them. When P1b passes, the owner turns the switch off, and the archived
  entries go through the normal delay from then on.
- **Reactions and views** (D7, D10) are keyed by the public entry id. "Fix before it appears"
  happens before anything is public, so nothing is lost. Deleting a follower (D12) never touches
  captures.
- **A stolen phone** (§3.4, §5.1): the token can only tighten, publish nothing but its own entries
  (with fresh auth), and is revoked from the admin.
- **Shared files.** v0.5 does not edit `policy.ts`. It shares only the API migration numbering and
  `Routes.php` with wave 5. v0.6 (auto-hold on alt) and v1 (moved on) need wave-5 P0 merged first.

---

## 4. Stack (versions as of 2026-11-20)

Sources: stack.md §14 (npm registry, Maven, vendor docs), with the re-checks marked †.

| Area | Choice | Version | Why | Main risk |
|---|---|---|---|---|
| Framework | Expo SDK with CNG and dev builds (no Expo Go, no bare RN) | `expo` 58.0.26; SDK 58 released 2026-10-15 † | Config plugins, local Kotlin modules, iOS later from the same project | Yearly SDK upgrade: pin exact versions, `expo-doctor` before releases, upgrade between trips |
| Runtime | React Native, React, Hermes V1, New Architecture only | 0.88.1 †, React 19.3.0 | Required by SDK 58 | The web apps use React 19.3.1, so isolated pnpm installs keep them apart |
| Navigation | expo-router | 58.0.32 | `omw://` pairing link | Churn from the router rework in 58 |
| Android config | minSdk **29**, targetSdk 36, compileSdk 37 (`expo-build-properties` 58.0.12) | – | Fewer legacy paths; Media3 tone mapping needs API 29 | Her phone must run Android ≥ 10 [A, M0 row 1] |
| Camera (v0.5) | **expo-camera** (CameraX-based; photo, video, zoom, flip, flash, barcode scanning for the QR) | 58.0.14 | Smallest risk for v0.5; first-party | No tap-to-focus [A, check in M0] |
| Camera (v1 candidate) | react-native-vision-camera + nitro-modules 0.37.2, nitro-image 0.15.2 | 5.2.4 † (npm latest) | Tap-to-focus, slide-to-zoom, hold-to-record | It was built on CameraX 1.7.0-alpha03; **CameraX 1.7.0 is stable since 2026-11-18** †, so M0 tries forcing it. One camera library only |
| Gallery | expo-image-picker (system Photo Picker) | 58.0.10 | No `READ_MEDIA_*` permissions; multi-select | No inline grid yet (embedded picker is alpha) |
| Share in (v0.6) / out (v1.1) | expo-sharing (receiving is experimental †) | 58.0.23 | First-party | Fallback `expo-share-intent` 9.0.0; out is an explicit intent from `omw-native` |
| Editor + photo bake (v0.6) | `@shopify/react-native-skia` (v2, Ganesh) | 2.14.0 | Paragraph + fonts, paths, colour matrices, `drawAsImage` + `encodeToBytes(JPEG)` | v3 (Graphite, needs Vulkan) too young: re-evaluate with SDK 59 |
| Photo pre-scale | expo-image-manipulator | 58.0.16 | Bakes EXIF orientation, decodes HEIC, re-encodes without metadata | Test with a GPS-tagged HEIC |
| Video export | Local Kotlin module `omw-native` with **Media3 Transformer + Effect 1.9.1**, pinned for every `androidx.media3:*` artifact (the version expo-video 58.0.14 builds against †). `FrameDropEffect.createDefaultFrameDropEffect(30f)` caps the frame rate (present since 1.1.0 †); `InAppMp4Muxer.Factory(MetadataProvider)` filters metadata †; `OverlayEffect`, `Presentation`, `Crop`, `ClippingConfiguration`, `setRemoveAudio`, `HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL` | 1.9.1 | Hardware codecs, built-in overlay and trim, about 300 lines of Kotlin. No version clash with expo-video | Never use edit-list trimming (it keeps the cut part in the file) |
| Export in the background | A foreground service started at Share while the app is visible: type `mediaProcessing` on API 35+, `dataSync` on API 29–34 (its documented uses include "local file processing" †). It stops itself when done and never waits for `onTimeout` (absent below API 35 †) | platform | The export survives the screen turning off | Play Console FGS declarations (§6.6) |
| Video playback, filmstrip | expo-video | 58.0.14 | Trim UI, thumbnails, `surfaceType="textureView"` under the Skia overlay | – |
| Voice | **expo-audio**: AAC in M4A, `isMeteringEnabled` for the live level UI only, `record({ forDuration: 60 })` † | 58.0.12 | The backend converts and computes the waveform anyway | – |
| Fonts | expo-font with TTFs: Calistoga, Courier Prime, Fraunces, plus **static instances cut from the site's variable files** (Playpen Sans 500, Nunito 800, Exo 2 800) with `fonttools varLib.instancer`, all OFL-1.1, built with `scripts/fonts` | 58.0.12 | The same outlines as the site at the site's weights | Ship the OFL texts in "Licences" |
| Animation | react-native-reanimated + react-native-worklets | 4.7.1 + 0.13.0 | UI-thread springs, `ReduceMotion.System` | Watch Hermes V1 + worklets patch notes |
| Gestures | react-native-gesture-handler (hook API) | 3.3.0 | Pinch, rotate and pan composition | No v2-based components: we build our own 3–4 sheets |
| Keyboard | react-native-keyboard-controller | 1.22.7 | Caption bar on the keyboard animation | – |
| Haptics | expo-haptics `performAndroidHapticsAsync` **only**, plus `omw-native.haptic()` for `GESTURE_THRESHOLD_ACTIVATE/DEACTIVATE` (not in Expo's enum †). Remove the `VIBRATE` permission that expo-haptics adds † | 58.0.8 | Respects the system "Touch feedback" switch | Constants from API 34 need fallbacks |
| Local storage | Per-entry outbox folders (expo-file-system `File`/`FileHandle`/`digest`) as the truth; expo-sqlite as a rebuildable index for the UI | 58.0.14 / 58.0.18 | Survives kills and reboots; atomic writes | Kotlin never opens the SQLite file; the uploader reads the manifests |
| Upload protocol | tus 1.0 core subset, hand-written in Slim (about 250 lines) | spec 1.0.0 | Resumable chunks within 50 MB / 60 s / few workers | Host timeouts and WAF: probe (M0 row 9) |
| Upload client | **One native uploader in `omw-native` from v0.5** (Kotlin, OkHttp): UIDT job on API 34+; a plain WorkManager worker on API 29–33 (§6.2); adaptive chunks; request budget; `NET_CAPABILITY_VALIDATED`; roaming per SIM. The TS client in `packages/app-core` exists only for the no-phone stack test | platform APIs | Survives process death and reboots; UIDT is exempt from standby quotas † | Our Kotlin; OEM task killers (§7) |
| Network state | `ConnectivityManager`/`NetworkCapabilities` in the uploader (unmetered = Wi-Fi; `NOT_ROAMING`); `SubscriptionManager.getDefaultDataSubscriptionId()` + `TelephonyManager.getSimOperator()` (no permission) for the per-SIM roaming answer; expo-network for UI hints | platform, 58.0.5 | A4 rules | Whether eSIM profiles are told apart [A, M0 row 1] |
| Auth storage | `TokenVault` in `omw-native` from v0.5: an AES-GCM key in the Android Keystore, an encrypted file excluded from backup, readable by JS and by the uploader | platform | The uploader needs the token without JS | – |
| App lock, fresh auth | expo-local-authentication (`BIOMETRIC_STRONG | DEVICE_CREDENTIAL`) | 58.0.3 | App lock and the no-grace prompts of §3.4 | – |
| Contracts | `@omw/contracts` from source via a Metro `@omw/source` condition + a ~15-line `.js`→`.ts` resolver | zod 4.6.7 (`jitless: true` on Hermes [A]) | One schema for the app, the API and the backend | Resolver shim |
| i18n | Lingui + metro transformer, expo-localization | 6.12.0, 58.0.5 | Same toolchain as the site and admin | Hermes lacks `Intl.DisplayNames`: polyfill if needed |
| Tests | Vitest 5.1.1 (framework-free core), jest-expo 58.0.15 + RNTL 14.1.0, Maestro CLI 2.12.1 (local), PHPUnit, Kotlin unit and instrumented tests | – | Repo standards plus the RN standards | Two JS runners |
| Builds | Local Gradle on the Mac (JDK 17+ from Android Studio's JBR; caches in `.cache/gradle`, `.cache/metro`). Never in Docker (the VM is nearly full). EAS Build only for iOS later | eas-cli 27.11.0 | Free | JDK/Android Studio install needs the owner's OK |
| Distribution | Google Play **internal testing**; adb APK as the fallback | – | Updates through the Play Store anywhere | US$25 + identity verification (Q7) |
| Not used | ffmpeg-kit (retired; repo archived 2026-07-02 †), Skia v3, MMKV/op-sqlite, expo-secure-store (replaced by `TokenVault`), expo-background-task, expo-media-library, `@gorhom/bottom-sheet`, Detox, Expo push service, a Kotlin Opus recorder, Media3 1.10+/1.11 | – | – | – |

Layout in the monorepo:
- `frontend/app` (`@omw/app`, no `build` script, so `pnpm -r build` stays web-only), with
  `modules/omw-native` (Kotlin: `MediaExport`, `ExportService`, `UploadJobService`, `UploadWorker`,
  `TusClient`, `TokenVault`, `Haptics`, `WhatsAppHandoff` in v1.1) and the edit document types;
- `packages/app-core` (framework-free TS: outbox state machine, contract mapping, A4 decisions,
  chunk sizing reference, the test client; Vitest);
- `api/src/Http/App/*`;
- `backend/src/capture/app-source.ts`.

`android/` is generated (CNG) and git-ignored.

---

## 5. Screens, flows, motion, haptics, gestures (condensed from ux.md)

### 5.1 Shape and flows

There is no tab bar, only three places: **Today** (home, with capture in the centre), **Journal**
(v1) and **Settings**. The camera and the editor are always dark; the rest follows the theme
(system, dawn, dusk). Every primary action sits in the bottom 40 % (thumb zone), and sheets come
from below.

| Path | Taps |
|---|---|
| Icon → ◉ → shutter → ➤ | 3 |
| Text status: Aa → type → ➤ | 2 + typing |
| Launcher shortcut "Photo" → shutter → ➤ (v1) | 2 |
| Share from Google Photos → On My Way → ➤ (v0.6) | 3 |

```
 Today                              Camera                             Editor (photo/video, v0.6)
┌──────────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────────┐
│ (◔)                 ✓ All safe│   │ ✕                     ⚡A  ⟲ │   │ ‹     ↶   ⌗   ☺   Aa         │
│ Good morning, {name}         │   │                              │   │ ▕▏▕▏▕▏▕▏ 0:00–0:42  🔇       │ video: trim + mute
│ Wed 18 Nov · day 23          │   │      viewfinder              │   │ ░│                      │░   │ ░ = may be cut on
│ Today  ┌──┐┌──┐┌──┐┌──┐      │   │  2× tap flip · pinch zoom    │   │ ░│   photo / video      │░   │   taller phones
│        │✓ ││⏱ ││◔ ││Aa│      │   │                              │   │ ░│ ┆ text guides 16–84 %┆│░   │ overlays: drag,
│        └──┘└──┘└──┘└──┘      │   │            0.6  1×  2×       │   │ ░│                      │░   │ pinch, twist,
│ ✎ 1 draft ›                  │   │                              │   │ ┌──────────────────────────┐ │ drag to trash
│                              │   │  [▣]       (  ◯  )           │   │ │ Add a caption…        ☺  │ │ caption = text
│  [▣]       ( ◉ )        [Aa] │   │ Text · PHOTO · Video · Voice │   │ └──────────────────────────┘ │
│ Gallery   Capture       Text │   └──────────────────────────────┘   │ Today · appears in ~24 h ›(➤)│
│ ───────── Journal (v1) ───── │    tap = photo · hold = video;       └──────────────────────────────┘
└──────────────────────────────┘    ring fills over 60 s

 Text status                        Publish sheet                      Queue sheet
┌──────────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────────┐
│ ✕                            │   │ Share 3 moments              │   │ On its way      [Upload now] │
│                              │   │ 📅 Wed 18 Nov              › │   │ ▣ Preparing…            ◌    │
│        Xin chào              │   │ When should it appear?       │   │ ▣ Ready to upload [Upload]   │
│        Việt Nam! 🍜          │   │ (●) As usual: in about 24 h  │   │ ▣ Waiting for Wi-Fi · 184 MB │
│                              │   │ ( ) Now (v0.6, fingerprint)  │   │ ▣ Roaming on "Viettel"       │
│ swipe ⇆ = background colour  │   │ ( ) Hold back                │   │   [Allow on this SIM]        │
│              ·  ·  ●  ·  ·   │   │ ( ) Only for me              │   │ ▣ Uploading · 42 %      ◔    │
│ ☺      Aa      ◐       ( ➤ ) │   │ Upload: automatically ›      │   │ ▣ Uploaded. Waiting for the  │
│ emoji  next font palette     │   │ [        Share  ➤        ]   │   │   home computer (since 14:02)│
└──────────────────────────────┘   └──────────────────────────────┘   │ Archived ✓ / Live ✓  ▣ ▣ ▣   │
                                                                      └──────────────────────────────┘
```

Key flows (ux.md §3 has the full versions; changes from revision 2 in bold):
- **First launch and pairing.** Welcome → Connect → Hello. **Paths: type the 8-character code, or
  tap the `omw://` link** (from the admin on the same phone, or from a chat that makes it tappable).
  QR scanning if expo-camera's scanner works (M0). No permission wall: camera, microphone and
  notification permissions are asked just in time, each with one sentence first.
- **Capture.** No white flash: the viewfinder dims for 90 ms. The photo is fsynced before the
  animation ends. Video stops by itself at 60 s.
- **Gallery.** The system Photo Picker, multi-select up to 30 items. Videos longer than 60 s open
  in the trimmer ("Choose the best 60 seconds").
- **Editor (v0.6).**
  - Tap on empty media = add text. Overlays: drag, pinch and twist, with snap guides; drag to the
    trash to delete. Back = save a draft, without asking. Undo at every step.
  - **Guides.** The site fills the screen with tall photos (h/w ≥ 1.6, `object-cover`) and adds Ken
    Burns up to scale 1.07 with a small drift [verified, `frontend/site/src/player/slides.tsx:54–58,
    79–84, 141`]. A 9:16 picture loses about 10 % per side on a 9:20 phone from the crop alone,
    about 13–14 % with Ken Burns, and up to about 16 % on 9:21. So text snaps within **x 16–84 %**,
    out of the top 12 %, and out of the bottom 20 % when there is a caption. The editor shows the
    9:20 crop as a dimmed band ("may be cut on taller phones").
- **Caption, description, alt text.**
  - The **caption** is one verbatim text with no language picker.
  - The de/en **description** stays an owner/admin field (it is not in the app until Q4 changes).
  - The **alt text** (v0.6) is pre-filled as "Text on image: …" and editable. Baked words cannot be
    translated; the owner's description can be.
- **Day.** Time = Share. An older gallery photo only offers "This photo is from Tue 17 Nov. Put it
  on that day?". **No daily place chip** (§3.8).
- **Publish sheet.**

  | Option | Maps to | When |
  |---|---|---|
  | "As usual" | no override; the time comes from the settings (v0.5) or the shared policy with slots and hold (v1) | v0.5 |
  | "Hold back" | `pending`, set by `app` | v0.5 |
  | "Only for me" | `hidden`, set by `app` | v0.5 |
  | "Now" | `public` on her own app entry, **fresh fingerprint/PIN**, with wave 5's warning; hidden when an auto-hold word matched or Q9 = no | v0.6 |

  Changing "Hold back" or "Only for me" back to "As usual" later also needs fresh auth. The
  per-entry upload override (A4) is here. **Share** = CONFIRM haptic once the entry is safely in
  the outbox, a polaroid flies into Today's strip, and "Shared · Undo" shows for 8 s (longer with
  TalkBack).
- **Queue.** One vocabulary in de and en, reusing the admin's labels: Preparing… · Ready to upload
  · Waiting for network · Waiting for Wi-Fi · **Roaming on <carrier>: [Allow on this SIM]** ·
  Uploading n % · Uploaded · Archived ✓ (archive-only) · Appears at … · Only for you · Live ✓ ·
  Needs you. Hotspots and metered Wi-Fi count as mobile data. "Upload now" on mobile data asks
  once per tap.
- **Roaming, per SIM.** A4's "also while roaming" stays **off by default**. Travel data eSIMs
  usually report roaming [A], so a single global switch would leave entries waiting for days. The
  answer is therefore remembered **per SIM** (MCC+MNC of the data subscription). The first time
  entries wait because of roaming, Today shows one calm card: "You're using <carrier> abroad.
  Upload on it? Yes · Only photos, text and voice · No". The queue row offers the same action. The
  home SIM keeps its roaming warning.
- **Uploads after a force-stop.** The OEM "Allow background uploads" card (with the right settings
  path for her phone's brand) shows from the first launch, once.
- **Journal (v1).**
  - All entries per day, with a tiny source glyph; a viewer that renders like the site player.
  - Long-press to select; Hide, Show (fresh auth), Move (her app entries only).
  - Deleted app entries stay in "Recently deleted" on the phone for 30 days.
- **Settings.**
  - Uploads: automatic/manual, Wi-Fi only, photos also on mobile data, roaming per SIM (list).
  - Haptics, theme, language, open straight into the camera.
  - App lock: on by default; after 5 min (choices: immediately, 1 min, 5 min). Capture and drafts
    work while locked; Share, the Journal and the queue need the unlock.
  - Free up space, diagnostic report, disconnect.
  - The publish mode is shown read-only, with a link to the admin.
- **Revoked or disconnected.** On `401 token_revoked`, the app wipes everything it fetched from
  the server (journal cache, previews, hints). Her unsent outbox stays sealed on the phone. Pairing
  again (after fresh auth) keeps it, because entries are keyed by ULID, not by token.

### 5.2 Motion (gentle; it supports the function)

The site's springs as Reanimated physics with **`mass: 1`** (Reanimated defaults to mass 4 and a
"perceptual" duration, so a naive `withSpring({duration})` would not match). The numbers are
generated from the site's `SPRINGS` into the app's token snapshot:

| Token | Stiffness / damping | Use |
|---|---|---|
| soft | 223.8 / 25.43 (ζ 0.85, settles ≈ 0.49 s) | sheets, cards, morphs, overlay add/drop |
| snappy | 685.4 / 52.36 (ζ 1.0, ≈ 0.24 s) | toggles, chips, press, tool bars |
| float | 42.8 / 11.78 (ζ 0.9, ≈ 1.05 s) | the send flight, the once-a-day paper plane |

Signature transitions (out of 20, ux.md §4.2). v0.5 has the first three; v1 adds the rest:
- a circular camera reveal from ◉;
- the send: media folds into a polaroid and flies into Today's strip;
- the "Live ✓" / "Archived ✓" check stroke;
- the viewfinder dims on the shot; the still image stays put while the editor tools fade in; the
  text-status background crossfades (240 ms); interactive filter swipes (v1.1); one paper plane on
  the first live moment of the day.

Rules:
- only `transform` and `opacity`, on the UI thread;
- gestures follow the finger 1:1 and hand their velocity to the spring;
- bounce ≤ 0.15, at most one ambient animation per screen, nothing loops in the camera or the
  editor;
- **reduced motion** turns movement into ≤ 120 ms fades and switches off ambient loops and the
  paper plane. Progress rings and timers keep updating, because they carry information.

### 5.3 Haptics (only for her own touches)

| Moment | Android constant (API) |
|---|---|
| Shutter | `VIRTUAL_KEY` (1) |
| Hold → video (before the recorder starts) / stop (after it stops) | `LONG_PRESS` (0) / `GESTURE_END` (30) |
| Mode rail, zoom stops, font/colour steps, snap guides | `SEGMENT_TICK` (34) |
| Continuous sliders (colour, straighten every 5°) | `SEGMENT_FREQUENT_TICK` (34) |
| Overlay picked up | `DRAG_START` (34) |
| Over the trash, voice cancel reached, trim end at 60 s / back out | `GESTURE_THRESHOLD_ACTIVATE` / `_DEACTIVATE` (34, via `omw-native`) |
| **Shared** (safely in the outbox), pairing succeeded | `CONFIRM` (30) |
| Deleting a published entry confirmed; an action she started failed | `REJECT` (30) |
| Settings switches | `TOGGLE_ON` / `TOGGLE_OFF` (34) |

Rules: never during recording (the microphone would pick up the motor); never for background
events (uploaded, Live ✓ and sync stay silent); at most one effect per 100 ms; an in-app switch on
top of the system setting; ordinary buttons get only the visual press; below API 34, the nearest
older constant (`CLOCK_TICK`, `CONTEXT_CLICK`, `LONG_PRESS`).

### 5.4 Gestures (every gesture has a visible button and a TalkBack action)

| Where | Gesture | Visible alternative |
|---|---|---|
| Today | swipe up on ◉ = camera; hold ◉ = video | tap ◉; Video mode |
| Camera | tap/hold shutter; pinch = zoom; swipe the lower third = mode; double tap = flip; pull down = close (v1: slide-to-zoom, volume keys) | zoom chips, mode labels, ⟲, ✕ |
| Editor (v0.6) | tap empty media = text; overlay drag/pinch/twist, drag to trash | Aa, the overlay mini bar (bigger, smaller, rotate 15°, centre, 🗑) |
| Text status | swipe = background; tap/long-press Aa = font | ◐ palette sheet |
| Voice | hold 🎙, slide to the start side = cancel (v1: slide up = lock) | tap to start/stop |
| Viewer, sheets, Journal | swipe sideways, swipe down to close, long-press select | ‹ › buttons, ⋯ menu |

- **System back:** no horizontal gesture may start in the outer 24 dp. Edge sliders sit 32 dp
  inside the edge and claim `systemGestureExclusionRects` only over their own height.
- **Priorities in the editor:** a touch on an overlay belongs to the overlay; a tap on empty media
  adds text; two fingers on empty media do nothing; in draw mode (v1.1), only drawing reacts.
- **RTL:** swipes and pagers mirror. The trim timeline, the viewfinder and overlay coordinates do
  not.

---

## 6. Milestones

Sizes use the milestone scale (S ≤ 2, M 3–6, L > 6 dev-weeks). Each milestone ends with a demo on
the traveler's phone (or the same model). All estimates are [A].

### 6.1 M0: spike on the real phone and the host (go/no-go). **S, about 1.5 dev-weeks**

| # | Spike | Records |
|---|---|---|
| 1 | Phone facts (owner): model, Android version (≥ 10; ≥ 14 for UIDT), free storage, WhatsApp version, OEM battery settings; **her SIM/eSIM, whether Android reports it as roaming, and whether `getSimOperator()` tells the profiles apart** | minSdk; uploader paths to test; OEM card text; roaming default |
| 2 | Toolchain (with the owner's OK to install a JDK and Android Studio outside the repo): Expo 58 skeleton in `frontend/app`, a release build with R8, `@omw/contracts` through the Metro condition, Lingui de/en/pseudo-ar, `pnpm -r typecheck` green with TS 7.0.2 | the monorepo approach works; ramp-up done |
| 3 | Camera: expo-camera on her phone (cold start, photo latency, a 60 s 1080p30 recording while zooming, front camera, low light, the barcode scanner for the QR, tap-to-focus or not). Half a day: VisionCamera 5.2.4 forced onto CameraX 1.7.0 stable | v0.5 camera = expo-camera (or the named blocker); the v1 candidate |
| 4 | Skia (half a day): a 1080×1920 photo + text in the 5 self-hosted fonts + emoji → JPEG; memory at 2880 px | the v0.6 bake is feasible |
| 5 | Media3 1.9.1: a 60 s phone video (incl. HDR / 10-bit HEVC / 60 fps if the camera makes them) + a full-frame overlay PNG + trim + mute + `FrameDropEffect(30)` + the metadata filter → H.264/AAC, inside the export foreground service. Measures: time, size, thermal; overlay 1:1; no edit list; **no `©xyz`/XMP from a GPS-tagged input** | export time for the "Preparing…" budget |
| 6 | Uploads: the tus subset in the local PHP API (`php -S` + `adb reverse`) + a first Kotlin uploader; kill mid-upload, airplane mode, a 64 kbit/s throttled link with drops (Android emulator network shaping or a proxy), resume | protocol shape; chunk-size bounds |
| 7 | WhatsApp facts on her phone: the explicit intent to `com.whatsapp` with an image + `EXTRA_TEXT` (does "My status" come first? does the caption arrive?); **`text/plain` to "My status"** (a real text status?); an audio share; the video limit (60 vs 90 s). With the observer (PLAN Phase 0) where available: a decorated text status as `RASTERIZED_TEXT_STATUS`, whether `accessibilityLabel` is filled, the exact text-status palette | `APP_LIMITS`; Q1 details |
| 8 | **Host probe** (owner-run, with the owner's go-ahead; combine with wave-5 P0b): an 8 MiB `PATCH` throttled to 64 kbit/s; a `PATCH` that stalls 30 s mid-body (finds `mod_reqtimeout` and wall-clock limits); a binary `application/offset+octet-stream` body (does a WAF pass it?); do PATCH and HEAD reach PHP; does a slow upload hold a PHP worker; the account's PHP process count; the disk quota (konsoleH); whether site and API share one account and quota. **Ask Hetzner support what triggers the IP block** instead of probing for it | slot count, chunk maximum, `APP_INBOX_MAX_BYTES` |
| 9 | Owner: Play Console account (Q7); a neutral privacy-policy page (no name, no destination, no link to the site, per D3) | distribution path |

**Done when:** every row has a recorded answer, each library is go or no-go with a fallback named,
and the limits, slot count and chunk bounds are set. No open "unknown" blocks v0.5.

### 6.2 v0.5 "trip-ready core". **L, about 11–12 dev-weeks** (server ≈ 4.5, app ≈ 7)

| Part | Items (item sizes) |
|---|---|
| Contracts (≈ 0.5 week) | `app.ts`, ids, `api.ts` additions, schema export (M); token JSON snapshot + staleness test (S); fixtures for app entries, shared by Vitest and PHPUnit (S) |
| API (≈ 2 weeks) | migration (S–M); `AppAuth` + pairing with TTL choice and the pairing alert (S–M); entries + tus + commit + state + list + withdraw (M+M); `PUT /app/visibility` with the §3.4 rules and their PHPUnit cases (S–M); minimal `/app/hints` (S); backend inbox endpoints (S–M); transfer slot, budget, cron, doctor (S–M); admin `Captures::exists`, device list (S) |
| Backend (≈ 1.5 weeks) | store migration v2, `app-source.ts`, archive record, ack/reject, withdraw relay, control UI counters (M–L); archive-only switch (S) |
| Admin (≈ 0.5 week) | "Connect a phone" screen, App badge, Disconnect (M) |
| App (≈ 7 weeks) | skeleton, theme, token snapshot, fonts, router, Lingui (M); pairing + `TokenVault` (M); Today + queue sheet + status vocabulary (M); camera with expo-camera (S–M); Photo Picker + copy into the outbox (S); photo export: pre-scale, orientation, no metadata, JPEG q90, sha256 (S); `omw-native` MediaExport + export service + trim/mute UI (M+M); text-status maker (M); voice with expo-audio (S); caption + publish sheet + "Put it on that day?" (S–M); outbox + index + state machine (M); **native uploader** (L, below); Settings + app lock + OEM card (S–M); haptics facade + 3 transitions (S–M); release setup: keystore in `.secrets/`, Play App Signing, internal track, FGS/UIDT declarations, 16 KB page check (S–M) |

The native uploader (L):
- **Android 14+ (API 34):** one UIDT job per upload run, scheduled when she taps Share or "Upload
  now" (the app is visible then, which UIDT requires †). It has `setPersisted(true)` (survives a
  reboot), `setEstimatedNetworkBytes`, the network constraints from the A4 rules, and a silent
  progress notification (required †). It returns `jobFinished(params, true)` to retry with backoff.
- **API 29–33:** a WorkManager worker with the same network constraints. It uploads for about
  9 minutes per run and re-enqueues itself. It does **not** promote itself to a foreground service
  from the background: Android 12+ throws `ForegroundServiceStartNotAllowedException` there. On
  API 29–30, and whenever the app is visible, it may use `setForeground(dataSync)`.
- **Every app open** reconciles the outbox with the server (`HEAD` on unfinished slots) and
  reschedules. This is the guaranteed path after a force-stop, or after she stops the job in the
  Task Manager (both remove scheduled work †).
- **Chunks:** client-adaptive between the server's `chunkMin` and `chunkMax` (256 KiB–8 MiB). Start
  at 1 MiB, aim for ≤ 15 s per `PATCH` at the measured throughput, double after a success, halve
  after any failure. sha256 per chunk.
- **Request budget:** at most about 10 requests per 10 s. Exponential backoff with jitter on every
  4xx/5xx except a 409 that carries the offset, honouring `Retry-After`. `HEAD` only after a
  failure, not before every chunk. `NET_CAPABILITY_VALIDATED`, so captive portals don't burn
  retries.

**Deliverable:** on her phone, photo, video, text and voice entries go from the app through the
local stack into the archive and the local preview, rendered by the unchanged site code. The admin
shows them with an App badge. With Q8 = yes, she can use it on the road in archive-only mode.

**Done when:**
1. All four kinds appear on the local preview in the same form as the matching WhatsApp fixtures:
   a TextSlide in the chosen font and colour, a VideoSlide that plays the trimmed, muted MP4, and a
   VoiceSlide with the waveform the backend computed.
2. A day in flight mode loses nothing. In automatic mode, Wi-Fi brings everything to "Archived ✓"
   or "Live ✓" with no tap. In manual mode, entries wait as "Ready to upload". A hotspot does not
   count as Wi-Fi. On a roaming SIM, entries wait until one "Allow on this SIM".
3. On a 64 kbit/s link that drops every 1 MB, uploads keep making progress (the chunk size falls to
   256 KiB), and the app never sends more than 10 requests in 10 s.
4. After process death and after a reboot, uploads resume **without opening the app**. After a
   force-stop, they resume **as soon as she opens it**. Both resume from the offset, not from 0.
5. With the Mac stopped for 12 h, entries show "Uploaded · waiting for the home computer". After the
   restart they are archived once, with nothing duplicated.
6. Replaying any request (entry create, chunk, commit, ack) changes nothing (PHPUnit + Vitest).
7. A GPS-tagged input video and a GPS-tagged HEIC produce app artifacts without `©xyz`, XMP or EXIF
   GPS (Kotlin test, checked with `ffprobe`/`exiftool`).
8. `occurredAt` = Share time, even for a two-day-old gallery photo. A phone set to the wrong year
   cannot backdate an entry. An entry that waited 40 days arrives as "Hold back" with an admin note.
9. The §3.4 PHPUnit cases pass.
10. With the archive-only switch on, the live target's generated output contains no app entry
    (generator test).

### 6.3 v0.6 "styling". **M, about 5 dev-weeks**

- Skia scene with the edit document (normalized coordinates): text overlays, emoji,
  crop/rotate/flip with presets, guides of §5.1, snap guides, the trash, undo/redo, the TalkBack
  mini bar (L).
- Gestures through RNGH 3 hooks and Reanimated; `omw-native.haptic()` thresholds (S).
- Drafts with 300 ms autosave; Back = draft; batches with a per-item caption and overlays (M).
- Photo bake (S–M); video bake with the overlay PNG on top of v0.5's module (S).
- Alt text from the final visible layers, editable; the site's alt chain; the auto-hold reading
  `alt` in TS, PHP and the vectors, coordinated with wave-5 P0 (S–M).
- "Now" with fresh auth and the §3.4 rule (S). "Fix before it appears" in API, backend and app (M).
- Share-in through expo-sharing, copied into the outbox at once (S–M). Admin: pending app entries
  with previews (S).

**Done when:**
1. For the 5 self-hosted faces (Calistoga, Courier Prime, Exo 2, Nunito for Morning Breeze, Playpen
   Sans for Norican), at 9:16 and 9:20: the app's preview and the site's rendering (Playwright on
   the generated output) have the same font family, the same line breaks and the same size step.
   The 3 system fonts are checked for line breaks only on an Android Chrome rendering.
2. A 60 s 1080p video with an overlay exports within the M0 budget [A: target ≤ 40 s on her phone],
   continues with the screen off, and keeps its progress ring.
3. The alt text reaches the site's `<img alt>` together with the owner's description. Deleted
   overlay text never appears in it.
4. An overlay word from the auto-hold list sends the entry to review and hides "Now".
5. Killing the app mid-edit reopens the draft exactly where she left it.
6. "Fix before it appears" keeps the original `occurredAt` and the owner's description, and the old
   entry never goes live.

### 6.4 v1 "journal and polish". **M, about 5–6 dev-weeks**

- **Journal** with the viewer, Hide/Show (fresh auth to loosen), Move for her app entries, "Recently
  deleted", the cache wipe on revoke (L).
- If Q10 = yes and wave-5 P0 is merged: the evening place question with "Day trip", "I've moved
  on" with fresh auth, `/app/hints` with slots and hold state, the policy vector (M).
- Motion pass (the remaining named transitions + reduced motion) (M). TalkBack actions, 200 %
  font scale, pseudo-ar QA (M).
- Launcher shortcuts, "Keep a copy in Photos" (S). VisionCamera, if M0 row 3 said go (M).
- **Field test:** a day in flight mode, a throttled hotel Wi-Fi with a captive portal, roaming on a
  travel eSIM, the OEM battery saver on, a phone restart mid-upload; battery and thermal
  measurements (M).
- Owner dogfooding for 7 days, then onboarding the traveler: pairing, a one-page "how it works",
  the WhatsApp audience note, the emergency card for the owner.

**Done when:**
1. ux.md §11 acceptance checks 1–8 pass on her phone. Check 9 (WYSIWYG) is replaced by v0.6
   done-when 1.
2. A full day of normal use (20 photos, 3 videos, 2 voice notes) costs ≤ 10 % battery beyond her
   baseline [A: target; measure].
3. 7 days of owner use with no lost entry and no "Needs you" without a clear action.
4. After a revoke, the app shows no server data and keeps the unsent outbox; re-pairing sends it.

**Gate for publishing real app content:** v0.5 done **and** wave-5 P1b done. Archive-only use can
start right after v0.5 if Q8 = yes.

### 6.5 Test strategy

| Layer | Tool | What |
|---|---|---|
| Framework-free TS (`packages/app-core`) | Vitest 5.1.1 | outbox state machine, entry → contract mapping (`InboxText`/`InboxMedia`), A4 + per-SIM decisions, chunk-size reference, alt-text builder, haptics map, publish line; the test tus client against a fake server (409 with offset, replayed chunk, 460, 503/`Retry-After`, 507) |
| Contracts | Vitest + PHPUnit on shared fixtures (`fixtures/app/*.json`, `fixtures/vectors/policy.json`) | the same app entries accepted or rejected in TS and PHP; auto-hold on alt (v0.6); Q11's vector; "a day trip does not release" (v1) |
| API | PHPUnit | tus conformance, idempotency, transfer slot, budget/507, skew and the 30-day rule, the §3.4 scope cases, withdraw before/after ack, "fix before it appears", pairing TTL and single use |
| Backend | Vitest | app source with a fake API, Range resume, 503 backoff, sha256 mismatch → reject, archive record and `backend reprocess`, withdraw → revoke, archive-only switch, generator `alt` |
| **No-phone stack e2e** | extend `pnpm --filter @omw/admin e2e:stack` with a scripted "fake app" client (Node, using `app-core`) | phone → API → backend → site for all kinds, without a device |
| Native module | Kotlin unit tests (OkHttp `MockWebServer` for the uploader: adaptive chunks, budget, backoff) and instrumented tests on the emulator and her phone | overlay mapped 1:1 (pixel probe), trim accuracy, no edit list, **no metadata from GPS-tagged inputs**, HDR→SDR, frame cap, UIDT/WorkManager resume after process death and reboot |
| RN components | jest-expo 58.0.15 + RNTL 14.1.0 | pairing, publish sheet wording per policy mode, queue states, roaming card, editor tool logic, pseudo-ar |
| Golden images (v0.6) | Playwright screenshots of the site's TextSlide/PhotoSlide vs app screenshots | v0.6 done-when 1 |
| E2E on devices | Maestro CLI 2.12.1 (`.maestro/`): pair via the `omw://` link, text status, photo, offline → online, kill during upload → resume | **run locally** on an emulator and her phone before each Play release |
| Manual | her phone + emulators API 29 and 36; TalkBack, 200 % font, reduced motion | each milestone demo |

The repo has no hosted CI today [verified: no `.github/workflows`]. The repo's usual local checks
(`pnpm` scripts, PHPUnit, the stack e2e) cover the JS and PHP parts. Emulators and Maestro run on
the Mac before releases, not on every change.

### 6.6 Sequencing with the other waves (one developer)

1. **Wave 4** finishes first (in flight).
2. **M0** can start right after. Its owner-run parts (phone facts, host probe, Play account) can
   happen even earlier.
3. **v0.5** does not edit `policy.ts`, so it can go before or after wave-5 P0. It coordinates only
   the API migration number and `Routes.php`.
4. **Two orders** (the owner chooses; Q8):

   | Order | First use by her | Publishing real app content |
   |---|---|---|
   | **A (recommended if she is travelling now):** wave 4 → M0 + v0.5 (archive-only) → wave-5 P0, P0b, P1a, P1b → switch on publishing → v0.6 → v1 | about 13 dev-weeks after wave 4 | about 20–23 dev-weeks after wave 4 |
   | B: wave 4 → wave-5 P0–P1b → M0 + v0.5 → v0.6 → v1 | about 20–23 dev-weeks after wave 4 | at the same time as first use |

5. **v0.6** needs wave-5 P0 (auto-hold), and **v1's place features** need wave-5 P0's hold.
6. The app does not depend on PLAN Phase 0 (the WhatsApp observer). It even gives the site a source
   when the observer is down. M0 row 7's observer parts and v1.1's WhatsApp hand-off need it.

### 6.7 Distribution to the traveler's phone

- **Development (M0–v0.5):** a debug dev-client APK over USB/Wi-Fi adb to her phone or a phone of the
  same model. API calls go to the local PHP API through `adb reverse`, so no traffic reaches the
  live hosts.
- **From v0.5 on:** release builds (R8 on) to the Play Console **internal testing** track: up to
  100 testers, builds that arrive in minutes, and updates through the Play Store anywhere. Play App
  Signing; the upload keystore lives in `.secrets/`. The Play Console needs the FGS-type
  declarations (`mediaProcessing`, `dataSync`) under Policy › App content †, the Data safety form
  and a privacy-policy URL [A: whether internal testing already requires them; check in M0 row 9].
- **Fallback:** a signed APK over adb.
- **Developer verification** has been enforced for users in Brazil, Indonesia, Singapore and
  Thailand **since 2026-09-30**, and goes global in 2027 †. Play developers are registered
  automatically. Outside Play, an unregistered app needs the "advanced flow", and a free
  **limited-distribution** account (no identity check, up to 20 devices) is the alternative †.
  Whether adb installs stay exempt: [A] (the critique says yes; re-check before relying on it).
- **OTA JS updates** (EAS Update): off. Play internal releases arrive in minutes anyway.
- **Versioning:** `versionCode` from the build script, `versionName` = date + short git SHA. The app
  sends `client.app` with each entry, so problems can be traced to a build.

---

## 7. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **A stolen or snatched unlocked phone** | medium / high | §3.4: the token can only tighten and publish its own entries; fresh auth for every loosening and for "Now"; the owner's pairing alert and Disconnect; the cache wipe on revoke; the emergency card. Residual: an admin PWA session on the same phone (§3.4, [A]) |
| **A leaked pairing code** (sent by chat) | low / medium | Single use, 1 h default (24 h at most), rate-limited, an owner alert when consumed, the scope limits of §3.4 |
| **Battery**: camera, exports, uploads | medium / medium | The camera runs only on screen. Exports run once, right after Share, as a visible foreground job. Uploads run only under network constraints, never by polling. No background location. Measured in the v1 field test |
| **OEM background limits** (task killers, battery savers, swipe-away as force-stop) | high / medium | UIDT jobs, persisted transfer state, resume on every app open, the OEM card from the first launch [A: per-brand settings paths, dontkillmyapp.com-style]. Field test with the OEM saver on |
| **Upload stalls abroad** (slow, flaky, captive Wi-Fi) | high / medium | Adaptive 256 KiB–8 MiB chunks aimed at ≤ 15 s, sha256 per chunk, `NET_CAPABILITY_VALIDATED`, backoff with jitter and `Retry-After`, WhatsApp-sized artifacts first (A5) |
| **Her own retries trigger the host's IP block** (seen 2026-11-20 after ~25 rapid requests, cause unconfirmed [verified, `docs/HOSTING.md` §10]) | low–medium / high (hours offline) | The request budget (≤ 10 per 10 s), no `HEAD` before every chunk, backoff on every error. Ask Hetzner what triggers it. The outbox keeps everything; an alert when an entry has waited > 24 h |
| **Travel eSIMs count as roaming** | high / medium | Roaming remembered per SIM, one calm question the first time entries wait (§5.1) |
| **The API host's PHP workers** | medium / medium | One transfer slot by default, shared with the backend's downloads; 503 + `Retry-After`; the real count from the probe |
| **Disk quota takes the API down** (SQLite in the same `var/`, possibly the same account as the site) | low–medium / high | `APP_INBOX_MAX_BYTES` ≤ 10 % of the quota, 507 before it, alerts on budget and database headroom, prompt pull and delete, originals off by default |
| **Phone storage** fills with outbox files and originals | medium / medium | Check free space before export, with a calm card when it's low. Delete artifacts once `archived`. Keep local originals only while "Fix before it appears" can apply (v0.6) or 30 days. "Free up space" in Settings |
| **Location leaks** | low after mitigation / severe | No coordinate field; Photo Picker redaction; no `ACCESS_MEDIA_LOCATION`; the Media3 metadata filter and EXIF-free JPEGs, tested with GPS-tagged inputs; stripped again on the Mac; time = Share; all wave-5 defaults; blur brush (v1.1) |
| **Baked words announce plans** | medium / medium | The auto-hold reads the alt text (v0.6); the app's own check hides "Now"; place stamps carry the name only |
| **A day trip releases held days** | – (avoided) | No daily place chip; v1's question is about the night, with "Day trip" (§3.8) |
| **WhatsApp terms and account** | low with the intent / severe with backend posting | Only the explicit intent: she presses send herself. Backend posting is not built (Q1). The observer stays passive |
| **Google Play policies** | low / high if violated | No `READ_MEDIA_*`, declared FGS types and UIDT, targetSdk 36, 16 KB pages checked before Play's 2027-02-01 deadline, no `VIBRATE`, no fine location, a neutral privacy-policy page |
| **Library risk** (camera, Skia v2→v3, the yearly Expo SDK) | medium / medium | expo-camera in v0.5, VisionCamera only after M0; Media3 pinned to expo-video's 1.9.1; exact versions; upgrade between trips |
| **Device-specific video** (HDR, 10-bit HEVC, odd rotations, 60 fps) | medium / high | Tone-map to SDR, `FrameDropEffect` to 30 fps, test with her real camera files |
| **Preview drift** between the app and the site | medium / low | Shared token snapshot, static instances of the site's fonts, golden tests for the 5 self-hosted faces; system fonts labelled honestly |
| **Covers and the portrait show baked overlays** | certain / low | Follows from the owner's decision (the clean original is not WhatsApp-equivalent). The admin's cover and portrait pickers say so |
| **Fonts and emoji licensing** | low / medium | OFL fonts with their notices; no Morning Breeze; Noto Color Emoji on iOS later |
| **One developer, waves 4 and 5 in parallel** | high / medium | v0.5 first, thin steps, the archive-only mode, the no-phone stack e2e |

---

## 8. Decisions for the owner

These are written for a non-technical reader. Each has a recommendation; once answered they
become A6 onward.

**Q1. Should moments from the app also reach WhatsApp?**
- (a) No. The app and WhatsApp stay separate.
- (b) **Recommended (from v1.1):** after sharing, one tap opens WhatsApp with the very same picture
  and caption, and she presses send there herself. Back in the app, she answers "Posted on
  WhatsApp?". If yes, the website shows the WhatsApp copy, and the app copy stays private, so
  nothing appears twice. Text cards go along only if WhatsApp accepts them as real text cards (we
  test this); voice notes stay in the app.
- (c) The home computer posts to WhatsApp automatically with her number.

  Not recommended. It would have to connect to her personal WhatsApp account, so the computer could
  receive all her private chats. It reverses the project's founding rule that her account is never
  touched, it breaks WhatsApp's terms, and her account could be blocked while she is abroad.

**Q2. What happens to the full-quality originals?** (confirms A5)
- (a) They stay only on her phone.
- (b) **Recommended:** additionally, photo originals go to the private home archive, only on Wi-Fi.
  Video originals stay on the phone because they are huge. From v1.1.
- (c) Photos and videos both go to the archive, only on Wi-Fi and while charging.

  Whatever you choose, the website always shows the WhatsApp-sized version.

**Q3. How does she fix a moment she has already shared?** (a typo in the words on a photo, a wrong
caption)
- (a) Delete it and share it again.
- (b) **Recommended:** "Fix before it appears" (v0.6). While a moment is still waiting for its
  delay, she edits it and it is replaced in place, keeping its time and your notes. With the 24-hour
  delay, that covers most fixes. Once a moment is live, she takes it down and shares it again.
- (c) Also "Edit again" after it is live, keeping reactions (about a week more; v1.1).

**Q4. What may the app do if the phone is lost or stolen before you disconnect it?**
- (a) **Recommended:** share her own moments; see her own and the WhatsApp moments; hide any of
  them; publish early only her own app moments, and only with her fingerprint. It cannot un-hide
  anything you hid, change descriptions or days, or touch followers, messages and settings.
- (b) Only share and see her own app moments.
- (c) Everything the admin can do.

**Q5. If she deletes a WhatsApp status that she also shared in the app, should it disappear from
the website too?** This matters only if you later choose the dedupe variant of Q1 (b), where the
app copy is the published one.
- (a) **Recommended:** yes. Deleting it on WhatsApp means "take it down" everywhere.
- (b) No. Only the WhatsApp copy goes.

**Q6. Default upload behaviour** (A4; she can change it in Settings and per moment)
- (a) **Recommended:** automatic. Photos, text cards and voice notes upload on any connection.
  Videos and originals wait for Wi-Fi. Roaming stays off, as A4 says, but the app asks once per SIM
  card the first time moments wait abroad ("Upload on it? Yes · Only photos, text and voice · No").
  Travel eSIMs usually count as roaming, so without the question her moments could wait for days.
- (b) As (a), but with no question: roaming only through the Settings switch.
- (c) Automatic, but only on Wi-Fi for everything.
- (d) Manual. Nothing leaves the phone until she taps "Upload now".

**Q7. How does the app get onto her phone?**
- (a) **Recommended:** a private Google Play test listing that only invited people can see. Updates
  arrive through the Play Store wherever she is. It costs US$25 once, and the account holder must
  verify their identity with Google. Whose Google account should hold it?
- (b) An install file over a USB cable. It is free, but every update needs the computer. Since
  30 September 2026, Android already blocks unregistered install files for users in Brazil,
  Indonesia, Singapore and Thailand (worldwide from 2027), unless the app is registered (a free
  "limited distribution" account covers up to 20 phones) or installed by cable.

**Q8. May the app be used before the follower gate is finished ("archive-only")?**
- (a) **Recommended if she is travelling now:** yes. Her moments upload to the private, locked inbox
  on the API host (deleted after the home computer has them) and into the home archive. Nothing is
  published until the follower gate passes its final tests. She can use the app about two months
  earlier.
- (b) No. The app waits until the gate is finished.

**Q9. Should the traveler be able to skip the delay ("Now") from her phone at all?**
- (a) **Recommended:** yes, for her own app moments only, with her fingerprint or PIN every time,
  and never when the words look like plans ("tomorrow", "hotel", "flight", …).
- (b) No. Only the admin can publish early.

**Q10. Who says where she is staying?**
- (a) **Recommended (v1):** the app asks in the evening "Staying in Hội An tonight?" (Yes · Day trip
  · Somewhere else), and she can tap "I've moved on" (with her fingerprint), which lets the days of
  the place she has left appear.
- (b) Only you, in the admin, as the follower plan assumes.

**Q11. (for the follower plan) If she deletes a status on WhatsApp after you pressed "Publish
now", should the website keep it?**
- (a) **Recommended:** no. A deletion on WhatsApp always wins.
- (b) Yes. Your "Publish now" wins (today's behaviour).

**Defaults we will use unless you object:**
- Words written on photos also become the description read aloud to blind and low-vision followers
  (she can edit it). They cannot be translated, unlike your descriptions.
- The app lock is on, after 5 minutes (she can shorten it).
- Videos are limited to 60 s (90 s only if her WhatsApp allows it).
- Vibration feedback is on.
- Photos with words or stickers on them make poor day covers or portraits: the pickers say so.
- Pairing codes are valid for 1 hour (24 hours if you choose it when sending one by chat).

**What we need from you (information, not decisions):**
- the traveler's phone model, Android version and WhatsApp version;
- **which SIM or eSIM she travels with**;
- a go-ahead for the host test on Hetzner (M0 row 8), the disk quota and **the number of PHP
  processes** from konsoleH, and **whether the site and the API share one hosting account**;
- whether **she is logged into the admin on her travel phone**;
- OK to install a JDK and Android Studio on the Mac, outside the repo;
- whether she is travelling already (it decides Q8 and the order in §6.6).

---

## 9. How the research notes were reconciled (updated in revision 2)

| Topic | Notes said | Plan decision |
|---|---|---|
| Entry id | styling: ULID; flow: UUIDv7 | **ULID** (the repo already uses ULIDs for posts; both fit the `SourceKey` regex) |
| Media3 version | styling: 1.11.1; stack: pin 1.9.1 to match expo-video | **1.9.1 everywhere**. `FrameDropEffect` (since 1.1.0) caps the frame rate, so 1.10's `setFrameRate` is not needed; `InAppMp4Muxer.MetadataProvider` exists in 1.9.1 † |
| Filters | styling: HALD LUTs; stack: colour matrices | **Colour matrices**, v1.1, after a Skia-vs-Media3 pixel test |
| Voice codec | styling: Opus/OGG; stack: expo-audio AAC | **expo-audio AAC**; the backend converts and computes the waveform [verified, `voice.ts:1–5`]; no Kotlin recorder |
| Haptic threshold constants | stack: via expo-haptics; ux: not in Expo's enum | `omw-native.haptic()` provides them; remove `VIBRATE` † |
| Pairing | flow: the token as a QR; stack/ux: a one-time code | **One-time code**, single use, 1 h default / 24 h max, typed or as an `omw://` link; QR if cheap; no App Links in v0.5 |
| Chunking | stack: adaptive 1–8 MiB; flow: fixed 4/8 MiB, ≤ 2 concurrent | **Adaptive, client-decided, 256 KiB–8 MiB**, ≤ 15 s per request; **1 transfer slot** shared with the backend's downloads; the server announces only the bounds |
| Upload client | stack: TS first, native later | **Native from v0.5**; the TS client only for the no-phone e2e |
| Video length | styling/ux: 60 s; flow: 90 s | **60 s** constant; raise it only after M0 row 7 |
| Alt text location | styling: `media.accessibilityLabel`; flow: `entry.alt` | `media.accessibilityLabel` → site `Entry.alt`, **combined** with the description |
| `takenAt` in the contract | flow: private field | **Not sent**: "Put it on that day?" runs on the phone and writes `localDateOverride` |
| Edit list upload | styling: no; flow: always | On the phone; file roles added when Q2 makes them upload (v1.1) |
| Photo picker | ux: embedded picker; stack: classic | **Classic system Photo Picker**; embedded later |
| Camera | stack: VisionCamera with an expo-camera fallback | **expo-camera in v0.5**; VisionCamera for v1 if M0 shows it on stable CameraX 1.7.0 |
| Motion numbers | stack: `withSpring({duration, dampingRatio})`; ux: physics with `mass: 1` | **ux's physics numbers**, generated from the site's springs |
| HD toggle | ux: HD on/off; styling: standard/light presets | Presets: **standard** (photo ≤ 2880 px long side q90; video ≤ 1080p ~5 Mbps) by default; **light** (720p ~2.5 Mbps) through a "smaller videos" setting |
| Text-status palette | styling: 12 colours; ux: about 14 | styling's **12** (all ≥ 4.5:1 with white) in v0.5; WhatsApp's exact colours once observer captures show them |
| Shared tokens | stack: new `@omw/tokens` package | **A generated JSON snapshot** while waves 4/5 edit `frontend/shared` |
| App lock default | stack: optional; ux: on after 5 min | **On after 5 min**; capture and drafts work while locked; fresh auth for loosening and "Now" |

---

## 10. Open checks (consolidated)

1. Her phone: model, Android ≥ 10 (≥ 14 for UIDT and the newer haptics), storage, OEM battery
   behaviour; her SIM/eSIM, its roaming flag, and whether profiles are told apart (M0 row 1).
2. expo-camera on that phone (tap-to-focus, barcode scanner); VisionCamera on CameraX 1.7.0 stable
   (M0 row 3).
3. Media3 1.9.1: overlay 1:1, 60 s export time inside the foreground service, HDR tone mapping, the
   metadata filter on GPS-tagged inputs (M0 row 5).
4. Whether the Photo Picker also strips location from **videos** (`©xyz`); the filter makes the
   app safe either way.
5. Hetzner: PHP process count, wall-clock and `mod_reqtimeout` limits, a WAF on binary bodies,
   PATCH/HEAD, a worker held during slow uploads, the disk quota, a shared account, what triggers the
   IP block (M0 row 8).
6. WhatsApp on her phone: the explicit intent and "My status", `EXTRA_TEXT` as the caption,
   `text/plain` as a text status, audio, limits (M0 row 7).
7. With the observer (PLAN Phase 0): `RASTERIZED_TEXT_STATUS`, `accessibilityLabel` on status media,
   WhatsApp's text-status palette.
8. Play Console: whether internal testing already requires the privacy policy, the Data safety form
   and the FGS declarations; whether a UIDT declaration exists.
9. Developer verification: whether it applies by device region or SIM, and whether adb stays
   exempt.
10. Whether the traveler is logged into the admin PWA on her travel phone (§3.4).
11. zod `jitless` performance on Hermes; RN 0.88 typings under TS 7.0.2.
12. Whether the generator can filter per publish target (archive-only switch, §3.7).

---

## Sources

Research notes (full citations inside): `styling.md`, `stack.md`, `flow.md`, `ux.md` in this
folder, and the review `app-critique.md`. Also `owner-decisions.md` (A1–A5),
`../design-w5/owner-decisions.md` (D1–D12) and `../design-w5/proposal.md` (§3.1 safety defaults,
§6.1 phases and the P1b rule).

Repo facts (read-only, re-read for revision 2):
- `packages/contracts/src/policy.ts:102–142` (the override wins before the revoke check and the
  delay; `capturePublishAt`);
- `frontend/site/src/player/items.ts:49` (`alt: description?.text ?? entry.caption?.trim() ?? ''`);
- `frontend/site/src/player/slides.tsx:54–58, 79–84, 141` (portrait ratio 1.6, Ken Burns table,
  `object-cover` for tall images);
- `frontend/shared/src/fonts.ts:25–40`, `frontend/shared/src/styles/theme.css:76–83` (`SYSTEM*` =
  the viewer's system fonts; variable cuts of Playpen Sans, Nunito, Exo 2);
- `backend/src/pipeline/voice.ts:1–15` (peaks computed when no waveform is sent),
  `backend/src/pipeline/video.ts:66` (`-map_metadata -1`);
- `api/migrations/0001_init.sql:165–186` (token kinds; `app` forced to `["admin"]`),
  `api/src/Http/Middleware/AdminAuth.php:52–65` (app bearers accepted as admin);
- `docs/HOSTING.md` §10 (the IP block), `docs/PLAN.md:24` ("The traveler's own account is never
  touched"), `docs/PLAN.md:156` (`timezone.current`);
- no `.github/workflows` in the repo.

Re-checked for revision 2 (accessed 2026-11-20):
- CameraX releases (1.7.0 stable 2026-11-18; rc02 2026-11-04): https://developer.android.com/jetpack/androidx/releases/camera
- react-native-vision-camera on npm (latest 5.2.4): https://registry.npmjs.org/react-native-vision-camera/latest
- Media3 `InAppMp4Muxer` at tag 1.9.1 (`MetadataProvider.updateMetadataEntries(Set<Metadata.Entry>)`, `Factory(MetadataProvider)`): https://github.com/androidx/media/blob/1.9.1/libraries/transformer/src/main/java/androidx/media3/transformer/InAppMp4Muxer.java
- UIDT jobs (scheduled only while visible; notification required; `setPersisted`; Task Manager stop prevents rescheduling; standby-quota exempt): https://developer.android.com/develop/background-work/background-tasks/uidt
- FGS types (`mediaProcessing` 6 h/24 h and no `onTimeout` below API 35; `dataSync` includes "local file processing"; `shortService` ≈ 3 min; Play declarations under Policy › App content): https://developer.android.com/develop/background-work/services/fgs/service-types
- Developer verification (enforced 2026-09-30 in BR/ID/SG/TH; global 2027; limited distribution, no identity check, up to 20 devices): https://developer.android.com/developer-verification/guides
- expo-audio v58 (AAC/mpeg4, `isMeteringEnabled`, `forDuration`): https://docs.expo.dev/versions/latest/sdk/audio/
- Play user data policy (camera/microphone as sensitive data; privacy policy in listing and app): https://support.google.com/googleplay/android-developer/answer/10144311

Carried over from the critique (its §6, accessed 2026-11-20):
- Media3 1.9.1 `SampleExporter`, `MuxerWrapper`, `FrameDropEffect` (also at 1.1.0): https://github.com/androidx/media/tree/1.9.1
- FGS from the background on Android 12+: https://developer.android.com/about/versions/12/foreground-services · WorkManager `setForeground` troubleshooting: https://developer.android.com/develop/background-work/services/fgs/troubleshooting
- Force-stop removes jobs (AOSP): https://android.googlesource.com/platform/frameworks/base/+/ee7805b · Android 15 force-stop: https://www.androidauthority.com/android-15-killing-app-3451796/
- WhatsApp "My Status" share target (Android beta 2.25.20.3, photos and videos): https://wabetainfo.com/whatsapp-beta-for-android-2-25-20-3-whats-new/

Carried over from revision 1:
- Expo SDK 58 changelog: https://expo.dev/changelog/sdk-58 · expo-video 58.0.14 build.gradle (`androidxMedia3Version = "1.9.1"`): https://unpkg.com/expo-video@58.0.14/android/build.gradle
- Media3 releases: https://developer.android.com/jetpack/androidx/releases/media3 · Transformer: https://developer.android.com/media/media3/transformer/transformations · OverlayEffect: https://developer.android.com/reference/androidx/media3/effect/OverlayEffect
- expo-haptics v58: https://docs.expo.dev/versions/latest/sdk/haptics/ · Haptics guidance: https://developer.android.com/develop/ui/views/haptics/haptic-feedback
- ffmpeg-kit (archived): https://github.com/arthenica/ffmpeg-kit
- Play photo/video permissions: https://support.google.com/googleplay/android-developer/answer/14115180 · internal testing: https://support.google.com/googleplay/android-developer/answer/9845334 · 16 KB pages: https://developer.android.com/guide/practices/page-sizes
- tus 1.0: https://tus.io/protocols/resumable-upload
- WhatsApp Terms (EEA): https://www.whatsapp.com/legal/terms-of-service-eea · whatsmeow: https://github.com/tulir/whatsmeow
- Photo Picker location redaction: https://www.androidauthority.com/android-photo-picker-location-3683074/
- Reanimated `withSpring`: https://docs.swmansion.com/react-native-reanimated/docs/animations/withSpring/
- Apple Developer Program: https://developer.apple.com/programs/enroll/

---

## Appendix A. Critique handled

Verdicts: **Accepted** (applied as proposed) · **Accepted, changed** (the problem is real; the fix
differs, reason given) · **Rejected** (reason given).

| # | Critique point | Verdict | What changed in the plan | Reason |
|---|---|---|---|---|
| C1 | The `capture` scope can publish anything (override beats revoke and delay) | **Accepted, extended** | §3.4 rule table; a dedicated `PUT /app/visibility` route instead of the admin annotation routes; `token_id`, `visibility_set_by`; fresh auth for "Now" and **every** loosening (also un-hiding an app-set hide); PHPUnit cases; Q4 rewritten; Q11 for wave 5 | Verified in `policy.ts:108–109`. Extended because un-hiding an "Only for me" entry is also loosening, and because an admin PWA session on the same phone would be a stronger key than the app token (§3.4, open check 10) |
| C1.5 | Should `public` ever beat a revoke? | **Accepted** | Q11, recommended "the revoke wins", plus a policy vector | It is a wave-5 policy decision, so it is raised there, not decided here |
| H1 | Uploads stall on bad links; host limits unprobed | **Accepted** | Adaptive client-side chunks 256 KiB–8 MiB (≤ 15 s); 1 transfer slot shared with backend downloads; request budget; `HEAD` only after failures; M0 row 8 extended; ask Hetzner about the block | The fixed 4/8 MiB design and the uncounted downloads were real gaps. Keeping partial chunk bytes (tus core allows it) was considered and left out: whether Apache passes a partial body to PHP-FPM is unknown, and adaptive chunks work either way |
| H2 | "Nothing while roaming" blocks travel eSIMs | **Accepted, changed** | A4's default stays **off**; the answer is remembered per SIM, with one calm question the first time entries wait; Q6 offers it as the recommendation and keeps the plain switch as (b) | A4 is a binding owner decision ("off by default"), so the plan does not flip the default. Asking once per SIM fixes the stall without overriding A4 |
| H3 | Force-stop resume and background FGS claims are wrong; two uploaders | **Accepted** | One native uploader in v0.5 (UIDT on 34+, plain WorkManager on 29–33, `setForeground` only where allowed); resume after force-stop only on app open; the OEM card from first launch; the TS client only for tests; v0.5 done-when 4 rewritten; expo-secure-store replaced by `TokenVault` | Confirmed in the UIDT docs (scheduling only while visible; a Task Manager stop prevents rescheduling) and the FGS docs |
| H4 | The daily place chip releases held days after a day trip | **Accepted** | The daily chip is cut; v1 asks about the night with "Day trip"; "I've moved on" with fresh auth; a policy vector; Q10 | The hold's release condition ("a later day carries a different place") makes the daily chip unsafe |
| H5 | Baked text escapes the auto-hold | **Accepted** | The auto-hold reads `alt` (v0.6, TS + PHP + vectors); the app checks before Share and hides "Now" | The app knows the words exactly. Limit stated: deliberate deletion from the alt text is her choice |
| H6 | 24 dev-weeks before use; calendar figures assume two developers | **Accepted, changed** | v0.5 / v0.6 / v1 split; archive-only mode (Q8); two sequencing orders for one developer (§6.6); no "in parallel" calendar figures | The direction is right, but the estimate is **about 13 dev-weeks** (M0 1.5 + v0.5 11–12), not the critique's 10–11. Its v0.5 adds app lock, Settings, haptics, transitions, the OEM card, the native uploader (L) and the §3.4 rules without adding their cost, and no ramp-up. To keep v0.5 lean, share-in moved to v0.6 and only 3 transitions remain |
| M1 | Media3 copies GPS into the "metadata-free" video | **Accepted** | `InAppMp4Muxer.Factory(MetadataProvider)` (verified to exist in 1.9.1); GPS-tagged input tests for video and HEIC; v0.5 done-when 7 | Verified by the critique in source; the API inbox, the WhatsApp hand-off and iOS would otherwise see coordinates |
| M2 | WYSIWYG impossible for system fonts; crop and Ken Burns beyond the guides | **Accepted, option (b)** | System fonts labelled "looks like each phone's own font"; golden tests for the 5 self-hosted faces at 9:16 and 9:20 (family, line breaks, size step); static font instances cut from the site's variable files; guides at x 16–84 % plus a dimmed 9:20 band | Option (a) (self-hosting substitutes for `SYSTEM*` on the site) was rejected: WhatsApp itself renders these fonts in each device's font, so (b) is the faithful choice and changes nothing for captured statuses |
| M3 | The alt chain drops baked words when a description exists | **Accepted, changed** | `alt = [description, entry.alt].join('. ') || caption`; the app pre-fills "Text on image: …" itself; pill default for text | The prefix lives in the app's alt text, not in the site, because `accessibilityLabel` is WhatsApp's free alt-text field: a captured status's label may not be overlay text, so the site must not label it as such. Description first, because it describes the scene; caption only as the fallback (unchanged behaviour for today's captures) |
| M4 | The stolen phone on the device: lock grace, cache, re-pairing | **Accepted in part** | Cache wipe on `401 token_revoked` with the outbox sealed; re-pairing keeps the outbox; the emergency card; fresh auth for every loosening, "Now", "moved on" | **Rejected:** "auth every time for the Journal" and a 1-minute grace. After C1 the Journal can only tighten, and its content is a subset of what an unlocked phone already shows (her Photos, her WhatsApp). The grace stays 5 min by default, with "immediately" and "1 min" as choices |
| M5 | "The very same artifacts" holds only for photos and videos | **Accepted** | Explicit intent to `com.whatsapp`; `text/plain` test in M0; the dedupe-free v1.1 ("Posted?" → app copy private, `wa:` copy published); pHash dedupe only on request; Q5 made conditional; the PLAN founding rule added to Q1 | Simpler and needs no matching. The "Posted?" question was added so that a cancelled send in WhatsApp doesn't leave the moment unpublished |
| M6 | Revisions vs the delay are undefined | **Accepted** | v0.6 "Fix before it appears" (new id, `replaces`, inherits `occurredAt`, copies the annotation, withdraws the old one); revisions after publication in v1.1 if wanted; Q3 rewritten | It reuses withdraw + create, and under the 24 h delay it covers most fixes |
| M7 | A full inbox can take the API down | **Accepted** | Budget ≤ 10 % of the quota (1 GiB until known), 507 earlier, headroom alerts, the shared-account question | SQLite shares `var/` [verified via `docs/HOSTING.md`] |
| M8 | Developer verification already enforced since 2026-09-30 | **Accepted** | §6.7 and Q7 updated, including limited-distribution accounts | Verified on the developer-verification guide. adb exemption kept as [A] |
| L1 | Media3 1.11.1 vs 1.9.1 is a false choice | **Accepted** | Pinned 1.9.1, `FrameDropEffect`; the M0 decision dropped | Avoids a version clash with expo-video |
| L2 | No Opus module needed | **Accepted** | expo-audio AAC with metering; the Kotlin recorder, the waveform upload and the Opus M0 row dropped | Verified in `voice.ts`; expo-audio v58 supports metering and `forDuration` |
| L3 | `mediaProcessing` details; skip the FGS in v0.5 | **Accepted in part** | The service stops itself and never waits for `onTimeout` (absent below API 35); `dataSync` on API 29–34 | **Rejected:** dropping the FGS. She will often lock the phone right after Share, and a backgrounded process is cached and frozen, so exports would stall until the next open. The FGS starts while the app is visible, which is always allowed. `dataSync` officially covers "local file processing", and `shortService`'s ≈ 3 min is too tight for slow phones |
| L4 | Pairing: TTL too short; drop App Links | **Accepted, changed** | Single use, **1 h default, 24 h max** (owner picks), consumption alert; App Links and `assetlinks.json` dropped from v0.5; `omw://` link + typed code; QR if expo-camera scans | A 24 h default widens the window when the code sits in a chat; the owner can choose 24 h when needed. A custom scheme can be claimed by another app, so single use + the alert remain the protection |
| L5 | Don't reject entries older than 30 days | **Accepted** | Accepted as "Hold back" with an admin note; done-when 8 | A forgotten manual queue must not lose moments |
| L6 | Rasterized text statuses get cropped and Ken-Burned | **Accepted** | v1.1: contained, no Ken Burns, for both sources | Same code for both sources, so the owner's rule holds |
| L7 | Don't move tokens; keep EditDoc in the app; add file roles when used | **Accepted** | Generated JSON snapshot with a staleness test; edit document in the app package; `edits`/`source` roles later | Avoids conflicts with waves 4 and 5 |
| L8 | Emulators and Maestro in CI don't fit | **Accepted** | Local runs before releases; the JS/PHP checks and the stack e2e stay as they are | The repo has no hosted CI at all [verified], and the Docker VM is full |
| L9 | Covers and portraits show baked overlays | **Accepted** | Owner default and a picker hint | It follows from the owner's decision |
| L10 | Privacy-policy page missing | **Accepted** | M0 row 9; a neutral page per D3; open check 8 | Play's user-data policy treats camera and microphone as sensitive; whether internal testing already requires it stays [A] |
| L11 | Skia and Media3 colour matrices may differ | **Accepted** | A pixel test gates v1.1 filters | Different working colour spaces are plausible [A] |
| §2 | v0.5 contents | **Accepted, changed** | §2.2 follows the critique's cut, with three differences: share-in → v0.6 (experimental receiving API; the Photo Picker covers existing media); "Put it on that day?" stays (S, keeps days right); a minimal `/app/hints` stays (the publish line needs the delay) | Lean v0.5 without losing correctness |
| §5 | New owner questions | **Accepted** | Q8 (archive-only), Q9 ("Now"), Q10 (who marks moved on), Q11 (revoke vs override); SIM/eSIM, PHP processes, shared account and the admin-on-phone question under "What we need from you" | – |
| §3 | Re-checked tech claims | **Accepted, extended** | Also re-checked: CameraX 1.7.0 is now stable (2026-11-18), which makes VisionCamera a realistic v1 candidate; the UIDT and FGS details above | – |
