# Traveler app: styling feature set and data model (WhatsApp-status compatible)

Design note for the React Native traveler app (Android first). Date: 2026-11-20.
Binding inputs: the owner's decision "stay WhatsApp status compatible with what we do" and
`.cache/design-app/owner-decisions.md` (A1 to A5). Read-only research. Nothing in the repo was changed.

Effort scale used below: **S** = up to 1 day, **M** = 2 to 4 days, **L** = 1 to 2 weeks (one developer).
"Assumption" means not verified, and the text says how to verify it.

---

## 0. Summary

1. **An app entry is a WhatsApp status.** It has the same kinds (`photo`, `video`, `gif`, `voice`,
   `text`), the same fields (caption; text body, background ARGB, text ARGB, FontType enum; media
   facts; voice waveform) and the same rule: everything visual on a photo or video is pixels.
   WhatsApp itself works this way. Its protocol has no layer model. Its tappable status stickers
   (location, link, music) are rasterized pixels plus a tap polygon (`InteractiveAnnotation`), and
   layouts carry only an attribution marker (`LAYOUTS`) on one flattened image (§1.1).
2. **Identity:** `sourceKey = "app:<ULID>"`. The existing `publicId` derivation, the store, the API
   mirror, annotations, the generator and the site code work unchanged. The "source marker" is the
   sourceKey namespace (`wa` / `app`). No new published field is needed for it, and the site
   should not show it.
3. **Flattening on the device:**
   - The editor is one Skia scene (`@shopify/react-native-skia` 2.14.0, bundled with Expo SDK 58).
   - **Photos** are exported by drawing the same scene into a Skia offscreen surface (JPEG q90).
   - **Videos** use the same scene, rendered once as a full-frame transparent PNG at the output size.
     A small Kotlin Expo module burns it in with **Media3 Transformer 1.11.1**: `Crop`, rotation,
     `Presentation`, `SingleColorLut` filter, `OverlayEffect(BitmapOverlay)`, `ClippingConfiguration`
     trim, `setRemoveAudio` mute, HDR tone-mapped to SDR, H.264 + AAC.
   - **ffmpeg-kit is retired.** The repo was archived on 2026-07-02. Its successor FFmpegKitNext is
     source-only, and the library is LGPL/GPL. Do not use it.
   - **iOS later:** AVFoundation (`AVVideoComposition` + Core Image) with the same overlay PNG.
4. **Additive, compatibility-safe metadata:**
   - **Alt text.** WhatsApp's own protos carry `accessibilityLabel` on Image, Video and
     AudioMessage (verified in the pinned whatsmeow). So alt text *is* WhatsApp-compatible.
     **Recommended for v1:** generate it from the overlay texts, editable.
   - **Voice background** (`AudioMessage.backgroundArgb`). **Optional.**
   - **Rasterized-text flag** (`ImageMessage.imageSourceType = RASTERIZED_TEXT_STATUS`).
     **Optional.**
5. **Private original + edit list: not in v1.**
   - The app keeps a versioned **EditDoc** (JSON) on the device, and the original stays on the
     phone, so "edit again" works from the phone.
   - Uploading originals belongs to the still-unconfirmed A5 (originals on Wi-Fi). The same EditDoc
     schema can ride along then without any model change.
   - Re-editing replaces the artifact under the **same entry id** (`rev` + 1), so annotations and
     wave-5 reactions and views stay attached.
6. **Fonts:**
   - The app's text-status maker and overlay editor use exactly the site's WhatsApp substitutes:
     Calistoga, Exo 2, Courier Prime, Nunito (for MORNINGBREEZE), Playpen Sans (for FB_SCRIPT),
     plus the Android system sans and serif.
   - All are SIL OFL 1.1, so bundling is fine with the license text in the app's notices.
   - Morning Breeze is not bundled: its license is unclear.
   - Move the shared mapping (`WA_FONTS`, `textStatusScale`) into a package the app can import, so
     the preview equals the site.
7. **Contract and code impact (§4):**
   - `contracts`: S to M.
   - wa-helper extraction of the new optional fields: S.
   - Backend store migration + app ingest: M (the transport itself belongs to the upload design).
   - Generator: S. Site: S (the alt fallback chain, optional voice background). Admin: S.
   - The app editor and flatteners are the big item: L.
   - Because `CaptureMirror` is `additionalProperties: false`, deploy the **API first**.
8. **WhatsApp path:**
   - The very same JPEG/MP4 plus caption can go to WhatsApp via the Android share sheet. Photo,
     video and GIF go with full fidelity.
   - A text status cannot carry its colour/font through an intent. Share its rasterized image
     instead, or use the backend path.
   - **Either path makes the observer capture the status a second time.** The backend needs a
     `wa ↔ app` duplicate link (M) so the timeline does not show it twice.

---

## 1. What WhatsApp status creation supports (November 2026)

### 1.1 How WhatsApp encodes a status (evidence)

Source: the WAProto definitions in the whatsmeow version this repo pins
(`.cache/go/pkg/mod/go.mau.fi/whatsmeow@v0.0.0-20261116172437-19d61352436f/proto/waE2E/WAWebProtobufsE2E.proto`,
`…/proto/waStatusAttributions/WAStatusAttributions.proto`). A status is one `waE2E.Message` sent to
`status@broadcast`.

| Message | Fields that matter for styling | Line |
|---|---|---|
| `ExtendedTextMessage` (text status) | `text`, `textArgb` (fixed32), `backgroundArgb` (fixed32), `font` (FontType: SYSTEM 0, SYSTEM_TEXT 1, FB_SCRIPT 2, SYSTEM_BOLD 6, MORNINGBREEZE_REGULAR 7, CALISTOGA_REGULAR 8, EXO2_EXTRABOLD 9, COURIERPRIME_BOLD 10); link preview: `matchedText`, `title`, `description`, `JPEGThumbnail`, `previewType`, `linkPreviewMetadata`; `musicMetadata` | 1214–1274 |
| `ImageMessage` (photo) | `caption`, `width`, `height`, `mimetype`; `imageSourceType` (USER_IMAGE, AI_GENERATED, AI_MODIFIED, **RASTERIZED_TEXT_STATUS**); **`accessibilityLabel`**; `annotations` / `interactiveAnnotations`; `viewOnce` | 1353–1391 (1388, 1389) |
| `VideoMessage` (video, GIF) | `caption`, `seconds`, `gifPlayback`, `gifAttribution` (NONE, GIPHY, TENOR, KLIPY), **`accessibilityLabel`**, `annotations`, `processedVideos`, `videoSourceType` | 1133–1178 (1170) |
| `AudioMessage` (voice) | `PTT`, `seconds`, `waveform`, **`backgroundArgb`** (voice-status background), **`accessibilityLabel`** | 2565–2582 |
| `InteractiveAnnotation` | `polygonVertices` (normalized points), action oneof `location` / `newsletter` / `embeddedAction` / `tapAction` (link), `embeddedContent` (`embeddedMusic`), `statusLinkType` = **RASTERIZED_LINK_PREVIEW / RASTERIZED_LINK_TRUNCATED / RASTERIZED_LINK_FULL_URL** | 1795–1813 |
| `ContextInfo` | `mentionedJID` (private status mentions), `statusAttributions` (Type incl. **LAYOUTS**, MUSIC, AI_CREATED, RESHARE), `statusAudienceMetadata` (CLOSE_FRIENDS, CUSTOM_LIST), `statusSourceType` | 1652, 1695, 1699 |
| `MessageAssociation.AssociationType` | `STATUS_ADD_YOURS`, `STATUS_QUESTION`, `STATUS_REACTION`, `STICKER_ANNOTATION`, `HD_IMAGE_DUAL_UPLOAD`, `MOTION_PHOTO` … (separate linked messages) | 1720 ff. |

**What this tells us:**
- **Pixels:** text on media, drawings, emoji and stickers, crop, rotate and filters, and layouts
  (one image plus the `LAYOUTS` attribution). Location, link and music stickers are pixels too; a
  polygon annotation only makes them tappable (`RASTERIZED_*` link types).
- **Message fields:** the caption, the text-status body/colours/font, the voice waveform and
  background, the accessibility label, link-preview metadata, mentions, audience, music metadata,
  interactive-sticker associations, and `viewOnce`.

### 1.2 Inventory and our priority

Priority for a traveler's diary: **must** (v1), **should** (v1 if cheap, else v1.1), **later**,
**never**. Android unless noted. Most dates come from WABetaInfo; staged rollouts mean "available
to some users".

| Feature | WhatsApp today (Android; iOS notes) | Encoding | Our priority and why |
|---|---|---|---|
| **Text status: text + background colour** | Text composer; since 2025 a bar to pick the colour and font in one tap (beta 2.25.5.18, 2025-02-27) ([WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-5-18-whats-new/)). The text colour is white and only the background is chosen ([techcult](https://techcult.com/how-to-change-whatsapp-font-color-in-chat-and-status), low-quality source; assumption). Solid colours only (one `backgroundArgb`). | `ExtendedTextMessage` fields | **must.** It is a core WhatsApp format, and the site already renders it (TextSlide). |
| **Text status: fonts** | 8 FontType values (§1.1). Tap "T" to cycle; newer builds have a picker bar. iOS uses the same enum (same proto). | `font` enum | **must.** Same 8 values; the app shows our substitutes (§3.9). |
| **Text status: alignment** | Centred. The protocol has no alignment field (the left/centre/right options exist only for text on media). | none | **never** for text statuses. Our site centres too. |
| **Text status: emoji** | Emoji in the body. | characters in `text` | **must** (free). |
| **Text status: stickers, emoji stickers, drawing, music** | Added to the text composer in beta 2.25.19.13 (2025-06-24) ([WABetaInfo](https://wabetainfo.com/whatsapp-beta-for-android-2-25-19-13-whats-new/)). The proto value `ImageSourceType.RASTERIZED_TEXT_STATUS` strongly suggests such a decorated text status is sent as an **image** (assumption: verify in Phase 0 by posting one and checking `imageSourceType`). | photo + flag | **should.** Drawing or stickers on a coloured background are rasterized to a 9:16 photo (§3.4). Music: never. |
| **Text status: link preview** | A URL in a text status gets a preview card. In 2025/26 there are also rasterized link stickers on media (`StatusLinkPreviewMetadata.Style`, `RASTERIZED_LINK_*`). | `matchedText`, `title`, `description`, thumbnail; or pixels + tap polygon | **later.** Our capture keeps only the body today (`inbox.go` drops preview fields), so the URL shows as text. Add `link` for both sources together if the traveler ever wants it. |
| **Text status: private mentions** | Mention contacts privately. On media since 2024 ([WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-new-status-like-reaction-and-mention-features-on-ios-and-android/)); on text statuses in beta 2.26.25.2 (2026-06-24). Never shown as visible text ([WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-mentions-for-text-status-updates/)). | `ContextInfo.mentionedJID` | **never.** These are WhatsApp contacts. Our followers (wave 5) are a different audience. |
| **Photo / video / GIF with caption** | Pick from the gallery or capture; caption field. Video length: 60 s since 2024; 90 s reported in beta, not confirmed ([summary of reports](https://thenews.com.pk/latest/1171499-whatsapp-introduces-1-minute-video-status-updates)). | `caption` + media | **must.** The caption stays separate text (owner decision). Limit: 60 s per video entry. Longer clips are split into consecutive entries at trim time. |
| **Text on media: fonts, colours, background pill, alignment** | The revamped text editor added fonts Calistoga, Courier Prime, Damion, Exo 2, Morning Breeze; left/centre/right alignment; a text background colour (Android beta 2.23.7.17, 2023-03-31; iOS TestFlight 23.5.0.72 to 23.8.0.73) ([WABetaInfo](https://wabetainfo.com/whatsapp-is-releasing-a-new-text-editor-experience-on-android-beta/), [iOS](https://wabetainfo.com/whatsapp-beta-for-ios-23-8-0-73-whats-new/)). | pixels | **must.** This is the most used styling. Pixels, so any font is technically possible, but we offer the same set as text statuses for one consistent look (§3.9). |
| **Drawing / pen** | Pen with a colour slider and several widths, on photo, video and (since 2025) text. | pixels | **should.** Cheap with Skia paths; nice for maps and arrows in a diary. |
| **Emoji** | Emoji as freely placed elements. | pixels | **must.** Cheap (a paragraph layer). |
| **Stickers** | Sticker packs; animated stickers in status since the 2025/26 holiday update ([WABetaInfo](https://wabetainfo.com/whatsapp-announces-holiday-update-with-2026-stickers-and-fun-interactive-effects/)). | pixels (`STICKER_ANNOTATION` association for some) | **should** (static): a small own travel set (date + place stamp, flag, washi tape, plane). **later:** animated stickers (they would turn a photo into a video). |
| **Photo stickers (cut-out)** | Turn a photo into a resizable sticker; announced 2025-05-29 ([WhatsApp blog](https://blog.whatsapp.com/more-ways-to-express-yourself-on-Status)). | pixels | **later.** Needs subject segmentation (e.g. ML Kit). Fun but not core. |
| **Crop, rotate** | Crop and 90° rotate in the editor. | pixels | **must.** Presets: 9:16 (fills the site player), 4:5, 1:1, original, free. |
| **Filters** | Five filters since 2017: Pop, B&W, Cool, Chrome, Film; swipe up; no intensity ([Engadget](https://www.engadget.com/2017-06-06-whatsapp-photo-filters-albums.html), [TechRadar](https://www.techradar.com/news/whatsapp-for-ios-just-added-filters-and-albums-for-photos-and-videos)). Meta AI "styles" since 2025/26 regenerate the image ([digit.in](https://www.digit.in/news/apps/whatsapp-status-to-add-meta-ai-image-editing-and-animation-features-what-to-expect.html)). | pixels | **should** for photos (five LUT presets), **later** for videos (the same LUTs through Media3). AI styles: **never** (a diary should stay authentic; cost). |
| **Video trim** | Trim slider in the editor. | new file | **must.** |
| **Video mute** | Speaker toggle before posting, since 2021 ([The Star](https://thestar.com.my/tech/tech-news/2021/03/02/whatsapp-announces-new-feature-for-users-to-mute-audio-in-videos-before-sharing)). | new file without audio | **must** (`setRemoveAudio`). |
| **GIF** | `gifPlayback` video (muted loop). GIF search moved from Tenor (API shut down on 2026-06-30) to GIPHY ([WABetaInfo](https://wabetainfo.com/whatsapp-migrates-users-to-giphy-as-tenor-shuts-down-its-api/), [9to5Google](https://9to5google.com/2026/06/30/google-tenor-api-gif-updates/)). | VideoMessage `gifPlayback=true` | **should:** a "loop" toggle for own clips of 10 s or less (a muted MP4). **never:** GIF search (third-party API key and content licensing; not a diary thing). |
| **HD photo/video** | HD for chats since 2023 (HD photo ≈ 3024×4032 vs older standard 920×1280 ([MacRumors](https://www.macrumors.com/2023/08/18/whatsapp-hd-photos-send-high-res-images/))); HD for status was in beta from 2023 ([Android Central](https://www.androidcentral.com/apps-software/whatsapp-hd-toggle-for-sharing-high-resolution-media)). | `HD_*_DUAL_UPLOAD` associations | n/a: we always publish high quality, plus a "light" preset for mobile data (§3.5). |
| **Voice status** | Hold the mic button; up to 1 minute since May 2024 ([WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-voice-status-updates-up-to-1-minute-long/)); coloured background (`AudioMessage.backgroundArgb`). | PTT audio + waveform + background | **must:** record, waveform, 60 s cap. **should:** background colour (additive, §3.6). |
| **Music on status** | Song as a sticker or standalone; clip length doubled to 30 s in Sept 2026 ([9to5Mac](https://9to5mac.com/2026/09/08/whatsapp-doubles-music-clip-length-for-status-updates/)); lyrics (Dec 2025). | `EmbeddedMusic` (Meta's licensed catalogue ids) + pixels | **never.** Licensed catalogue, not reproducible, and copyright risk on a public site. |
| **Layouts / collages** | Up to 6 photos in one layout; announced 2025-05-29 ([WhatsApp blog](https://blog.whatsapp.com/more-ways-to-express-yourself-on-Status)). | one flattened image + `LAYOUTS` attribution | **should (v1.1).** High diary value ("today's four moments"). It is a photo entry: no model change. |
| **Add Yours, question sticker, reaction sticker** | Add Yours (2025-05); question sticker and emoji reaction sticker (beta 2.25.29.12 / 2.25.36.6, announced 2025-12-15) ([WABetaInfo](https://wabetainfo.com/whatsapp-announces-missed-call-messages-new-status-sticker-and-channel-questions/), [reaction sticker](https://wabetainfo.com/whatsapp-beta-for-android-2-25-36-6-whats-new/)). | associated messages + pixels | **never** as interactive WhatsApp features. Wave 5 gives the site its own reactions. |
| **Location / link stickers (tappable)** | Pixels + `InteractiveAnnotation` polygon with `location` / `tapAction`. | pixels + annotation | **should** as plain pixels: a place + date "passport stamp" sticker fits the site's design language. **never** tappable: place data belongs to the day (`days.place`). |
| **Audience (close friends, custom lists)** | Close Friends and lists (beta 2.26.5.x, Feb 2026) ([GSMArena](https://fo.gsmarena.com/whatsapp_custom_lists_close_friends_status_update_android_beta_users-news-71456.php)). | `statusAudienceMetadata` | **never** as a status field. "Publish / review first / hidden" maps to the existing annotation `visibility` (owner model, not the status). |
| **View once** | `viewOnce` exists on media messages (a chat feature); statuses expire after 24 h anyway. | flag | **never** (an archive is the point). |
| **Motion photos** | `MOTION_PHOTO` association (paired still + video). | 2 messages | **later.** Post the still. |
| **AI images / Meta AI edits** | AI-generated status images and AI styles (2025/26) ([WABetaInfo](https://wabetainfo.com/whatsapp-launches-new-ai-powered-tool-to-generate-status-images-on-ios-and-android/)). | `imageSourceType` AI_* | **never.** |
| **Ads, channels, reshares** | Status ads, channel reshare, `StatusReshare` attributions. | attributions | **never.** |

**iOS differences** (relevant only for the later iOS app):
- The protocol and therefore the model are identical.
- Historically, filters arrived on iOS first (2017). The new text editor reached TestFlight later
  than Android.
- HD resolutions were reported differently.
- iPhone sources are HEIC and Live Photos; post the still image of a Live Photo.
- Caveat for our app on iOS: Apple Color Emoji rasterized into published images is a licensing
  grey area. Bundle Noto Color Emoji (OFL) for overlays on iOS, which also looks the same as on
  Android.

---

## 2. How the repo represents and renders statuses today

**Capture contract** (`packages/contracts/src/wa.ts`):
- `FONT_NAMES` / `FontName` mirror WAProto FontType exactly. `FONT_TYPE_NUMBERS` and
  `fontNameFromType` map between names and numbers; unknown numbers become `null`.
- `argbToRgbaHex` turns ARGB uint32 into `#rrggbbaa`.
- `InboxText = {body, bgArgb|null, textArgb|null, font|null}`; the ARGB schema is module-private.
- `InboxMedia = {mimetype, fileSha256B64, fileLength, width?, height?, seconds?, ptt?, gifPlayback?, waveformB64?}`.
- `InboxMeta` (schema 1) enforces kind and field consistency. `CaptureKind` in `common.ts` is
  `photo | video | gif | voice | text | unsupported`.

**What the wa-helper extracts** (`backend/wa-helper/inbox.go` `buildMeta`):
- Caption, width/height/seconds, `gifPlayback`, `PTT`, waveform.
- Text with `BackgroundArgb` / `TextArgb` / `Font`. A plain `Conversation` becomes text without a style.
- **It does not extract:** `accessibilityLabel`, `AudioMessage.backgroundArgb`, `imageSourceType`,
  link-preview fields, annotations or attributions. All of them stay in `rawProtoB64`, so
  `backend reprocess` can recover them later.

**Normalization:**
- `backend/src/pipeline/text.ts`: `DEFAULT_TEXT_STYLE` is plum `#3b2341ff`, white text, `SYSTEM`.
- `backend/src/generator/model.ts` (`captureEntry`) does the same with ARGB defaults and builds the
  site `Entry`, with `caption` verbatim plus the owner `description`.

**Site contract** (`packages/contracts/src/site.ts`):
- `TextStyle = {body, bg: #rrggbbaa, fg, font: FontName}` (shared with the API mirror).
- `EntryBase = {id, at, tz, caption?, description?, descriptionOrig?}`. Photo is an `ImageSet`;
  video and GIF are `VideoMedia` (GIF: `hasAudio: false`, `loop: true`); voice is `AudioMedia`
  `{src, duration, peaks}`.
- **There is no layer or overlay concept anywhere.** That is exactly what the owner's decision needs.

**Rendering** (`frontend/site/src/player/slides.tsx`, `items.ts`, `chrome.tsx`):
- **TextSlide:**
  - Solid `bg` / `fg`; centred `whitespace-pre-line` text with `dir="auto"`.
  - Font via `waFontStyle(font)` (`frontend/shared/src/fonts.ts`).
  - Size via `textStatusScale(body)`: ≤24 characters → `10.5cqi`, ≤70 → `8cqi`, ≤160 → `6.4cqi`,
    else `5.2cqi`; padding `9cqi`. These are fractions of the slide width, so the app can mirror
    them exactly.
- **PhotoSlide:**
  - `object-cover` when h/w ≥ 1.6 (`PORTRAIT_RATIO`, i.e. 9:16 phone shots); otherwise `contain`
    over a thumbhash blur. Ken Burns applies.
  - The stage is the full viewport on phones and 9:16 on larger screens
    (`journey-player.tsx:664`). So a 9:16 photo on a 9:20 phone loses about 10 % on each side.
    This is the reason for the safe area in §3.5.
- **VideoSlide:** pooled `<video>`. GIFs are muted loops.
- **VoiceSlide:** fixed violet gradient, waveform from `peaks`.
- **Captions:** `CaptionBlock` renders caption and description as text at the bottom, line-clamped.
- **Alt text** (`items.ts buildItems`): description, else caption, else "".

**WhatsApp font substitutes** (`frontend/shared/src/fonts.ts`, `styles/theme.css`, generated
`styles/fonts.css`):

| FontName | Site substitute (weight) | Self-hosted subsets |
|---|---|---|
| SYSTEM | system-ui (400) | none |
| SYSTEM_TEXT | ui-serif / Georgia (400) | none |
| SYSTEM_BOLD | system-ui (700) | none |
| FB_SCRIPT | Playpen Sans Variable (500), the "hand" role | latin, latin-ext, vietnamese; Arabic and Hebrew cuts |
| MORNINGBREEZE_REGULAR | Nunito Variable (800) | latin, latin-ext, vietnamese, cyrillic … |
| CALISTOGA_REGULAR | Calistoga (400) | vietnamese, latin-ext, latin |
| EXO2_EXTRABOLD | Exo 2 Variable (800) | vietnamese, latin-ext, latin |
| COURIERPRIME_BOLD | Courier Prime (700) | latin-ext, latin (**no Vietnamese**: diacritics fall back to ui-monospace) |

---

## 3. Data model for app-created entries

### 3.1 Principle and identity

- An app entry is a **capture** whose source is the app. It goes through the same pipeline,
  `CaptureRow`, `CaptureMirror` and site `Entry`. It is not a new entry kind and not an owner
  `post`.
- `id` is a client-generated **ULID** (26 Crockford base32 characters), created when the traveler
  taps "Post". It makes the upload idempotent and works offline (A3).
  - `sourceKey = "app:" + id` fits the existing `SourceKey` regex `^[a-z]+:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.
  - `publicId = "e_" + base32(sha256(sourceKey))[0..12]`, unchanged (`ids.ts`).
  - The app id never appears in static output, just like WhatsApp msgIds.
- **Source marker** = the namespace of `sourceKey` (`wa` → WhatsApp, `app` → app). Derive it where
  needed (admin badge, dedupe, metrics). **Do not publish it on the site.** Viewers gain nothing
  from it, and wave 5's "zero information" spirit favours publishing less.
- **Ownership** (one primary per datum, plan A3):
  - The app's status facts are immutable like a WhatsApp status, except for an explicit re-edit
    (§3.8).
  - The API is only the inbox for uploads. Once the backend ingests an app status, the backend is
    its primary, exactly like a WhatsApp capture, and mirrors it back via
    `PUT /captures/app:<id>`.
  - Owner data (description, visibility, day move) stays in `annotations`, keyed by the same
    sourceKey. So the app may create an annotation together with the status, e.g. "review first"
    or "put on the day it was taken", without changing the status model.

### 3.2 Field mapping (1:1 with wa.ts)

| Concept | WAProto | Captured (`InboxMeta`, wa.ts) | App upload (`AppStatus`, new, §4.1) | Store / API mirror / site |
|---|---|---|---|---|
| id | message key id | `msgId` → `wa:<msgId>` | `id` (ULID) → `app:<id>` | `source_key`, `publicId` (unchanged) |
| time | message timestamp | `timestamp` | `postedAt` (when she tapped Post) | `occurred_at` → `Entry.at` |
| zone | none (setting `timezone.current`) | none | `tz` (device IANA zone) | `tz`, `local_date` |
| kind | which `*Message` | `kind` | `kind` ∈ photo, video, gif, voice, text | `kind` (same enum) |
| caption | `Image/VideoMessage.caption` | `caption` | `caption` (photo, video, gif only, as in WhatsApp) | `caption` → `Entry.caption` |
| text status | `ExtendedTextMessage.{text, backgroundArgb, textArgb, font}` | `text: InboxText` | `text: InboxText` (stricter: all set) | `text_json` → `TextStyle {body, bg, fg, font}` |
| media facts | mimetype, fileSHA256, fileLength, width, height, seconds, gifPlayback, PTT, waveform | `media: InboxMedia` | `media` (same shape) | variants → `ImageSet` / `VideoMedia` / `AudioMedia` |
| alt text | `*.accessibilityLabel` | **new optional** `media.accessibilityLabel` | `media.accessibilityLabel` | **new optional** `Entry.alt` |
| voice background | `AudioMessage.backgroundArgb` | **new optional** `media.bgArgb` | `media.bgArgb` | **new optional** `AudioMedia.bg` |
| rasterized text | `ImageMessage.imageSourceType` | **new optional** `media.imageSource` | `media.imageSource = 'rasterized_text_status'` | not published (an optional player hint, see §3.6) |
| deletion | `ProtocolMessage` REVOKE | `RevokeRecord` | `DELETE` of the app status | `revoked_at` (sticky), same `ingest.on_revoke` policy |
| app-only, private | none | none | `rev`, `client`, `waShare` | backend/API only; never published |

### 3.3 Rules per kind (what the app may produce)

| Kind | Artifact | Rules (enforced by the app and by `AppStatus` zod) |
|---|---|---|
| `photo` | JPEG (sRGB, no EXIF) | caption ≤ 1024 (assumption: WhatsApp's caption cap is about that); overlays already baked in; `width`/`height` required |
| `video` | MP4, H.264 + AAC (or no audio if muted) | ≤ 60 s (WhatsApp limit; split longer clips); caption allowed; `seconds`, `width`, `height` required |
| `gif` | MP4, H.264, **no audio**, `gifPlayback: true` | ≤ 10 s, muted loop (our player: `hasAudio: false`, `loop: true`) |
| `voice` | OGG/Opus (preferred) or M4A/AAC, mono | ≤ 60 s; `ptt: true`; `waveformB64` = 64 bytes 0–100 (as WhatsApp sends); no caption (WhatsApp has none on audio) |
| `text` | none | `body` 1–700 characters (assumption for WhatsApp parity; the site scales to `sm` above 160); `bgArgb` opaque (alpha FF); `textArgb` = `0xFFFFFFFF`; `font` set (never null); no caption |

### 3.4 Text statuses on the device

- **Fields:** exactly `InboxText`. `body` is plain text: no WhatsApp `*bold*` markup, which our
  site would not render.
- **Background palette.** WhatsApp's own palette is not published (searched; not found). That does
  not matter, because the field takes any ARGB. Offer 12 opaque colours from the dawn/dusk world.
  All pass white-text contrast ≥ 4.5:1 (computed with WCAG relative luminance):

  | Name | Hex | ARGB | White contrast |
  |---|---|---|---|
  | Plum (default, = `DEFAULT_TEXT_STYLE`) | #3B2341 | 0xFF3B2341 | 13.97 |
  | Rose | #BE4A74 | 0xFFBE4A74 | 4.75 |
  | Deep rose | #9C3A5E | 0xFF9C3A5E | 6.60 |
  | Berry | #7A2E5C | 0xFF7A2E5C | 8.85 |
  | Mauve | #8A4F7D | 0xFF8A4F7D | 6.01 |
  | Violet | #5D3FA0 | 0xFF5D3FA0 | 7.82 |
  | Lavender dusk | #7353B8 | 0xFF7353B8 | 5.74 |
  | Ocean | #1F5C8C | 0xFF1F5C8C | 7.08 |
  | Lagoon | #1E6B6E | 0xFF1E6B6E | 6.21 |
  | Forest | #2E6B45 | 0xFF2E6B45 | 6.35 |
  | Terracotta | #A8482E | 0xFFA8482E | 5.78 |
  | Night | #1B1322 | 0xFF1B1322 | 18.06 |

  The text colour is always white, which matches WhatsApp's UI (`textArgb` exists in the protocol,
  but pastel backgrounds with dark text would be a deviation; leave them out).
- **Fonts:** a picker bar with 8 samples, in enum order. The preview uses the site's exact
  substitute faces and the site's `textStatusScale` and `cqi` sizes (§3.9). What she sees is what
  the site shows.
- **Decorated text statuses** (drawing, stickers or placed emoji on a coloured background):
  - The composer switches to "rasterize" mode, mirroring WhatsApp's `RASTERIZED_TEXT_STATUS`.
  - Output: a **photo** 1080×1920 JPEG q92 with `imageSource: 'rasterized_text_status'` and
    `accessibilityLabel` = the body.
  - The body text is drawn with the same font, size and padding rules, so it looks identical to a
    pure text status.
  - A text status with only body emoji stays a `text` entry.

### 3.5 Flattening photos and videos on the device

**Architecture (one renderer for preview and export):**

```
EditDoc (JSON, normalized coords) ──► Skia scene (React components)
   ├─ on screen: <Canvas> over the photo / <VideoView> (expo-video) for video, gestures via RNGH + Reanimated
   ├─ photo export: Skia offscreen surface W×H: base image (cropped, rotated, LUT) + layers → JPEG
   └─ video export: Skia offscreen surface W×H: layers only (transparent) → overlay.png
                     └─► native module "omw-flatten" (Kotlin, Media3 Transformer) → MP4
```

- **Layer geometry is normalized** to the crop rectangle: positions 0–1, text size and stroke width
  as fractions of the output width. The editor (screen pixels) and the export (1080–2880 px) then
  render the same picture. This is the same trick the site uses with `cqi`.
- **Versions** (checked on npm 2026-11-20):
  - Expo SDK 58 (`expo` 58.0.26, SDK released 2026-09-29) bundles `react-native` 0.88.1,
    `@shopify/react-native-skia` 2.14.0, `react-native-reanimated` 4.7.1,
    `react-native-gesture-handler` ~3.3.0, `react-native-worklets` 0.13.0,
    `expo-image-manipulator` ~58.0.16, `expo-video` ~58.0.14, `expo-audio` ~58.0.12,
    `expo-haptics` ~58.0.8.
  - Media3: stable **1.11.1** (2026-09-10); 1.12.0-beta01 (2026-11-11) adds CodecDB encoder
    recommendations ([release notes](https://developer.android.com/jetpack/androidx/releases/media3)).

**Photo export (Skia; Android now, iOS later with the same code):**
1. Normalize the orientation first. Bake EXIF rotation with `expo-image-manipulator`
   (`manipulate(uri).renderAsync()`), and decode HEIC there if Skia cannot. Assumption: verify Skia's
   handling of EXIF orientation and HEIC on the traveler's phone.
2. Offscreen surface at the output size. Draw the base with crop, rotation and flip, and the filter
   as a 3D-LUT RuntimeEffect (the same LUT files as the video path). Then draw the layers:
   Paragraphs with the bundled fonts plus system emoji fallback, ink paths, sticker images.
3. Export with `makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, 90)`, written to the app's
   files dir. Compute the sha256 (native, streaming).
4. **No EXIF in the output** (GPS stripped by construction). Read `DateTimeOriginal` and GPS before
   flattening, for in-app suggestions only (§3.6).

**Video export (Android: Media3 Transformer in a small Expo module).** This is a sketch; check the
exact builder signatures against 1.11.1:

```kotlin
val overlay = BitmapOverlay.createStaticBitmapOverlay(BitmapFactory.decodeFile(overlayPng)) // W×H, transparent
val videoEffects = buildList {
  crop?.let { add(Crop(it.left, it.right, it.bottom, it.top)) }              // NDC of the oriented frame
  if (rotation != 0) add(ScaleAndRotateTransformation.Builder().setRotationDegrees(rotation.toFloat()).build())
  add(Presentation.createForWidthAndHeight(outW, outH, Presentation.LAYOUT_SCALE_TO_FIT))
  lut?.let { add(SingleColorLut.createFromBitmap(it)) }                       // filter (HALD N×N²)
  add(OverlayEffect(ImmutableList.of(overlay)))                               // text, ink, emoji, stickers: last, at output size
}
val item = EditedMediaItem.Builder(
    MediaItem.Builder().setUri(src)
      .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
        .setStartPositionMs(trimStart).setEndPositionMs(trimEnd).build())
      .build())
  .setRemoveAudio(mute || isGif)
  .setFrameRate(30)                                   // 1.10+: caps the output frame rate
  .setEffects(Effects(/* audio */ listOf(), videoEffects))
  .build()
val composition = Composition.Builder(EditedMediaItemSequence.Builder(item).build())
  .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)  // API 29+, SDR output like WhatsApp
  .build()
Transformer.Builder(context)
  .setVideoMimeType(MimeTypes.VIDEO_H264).setAudioMimeType(MimeTypes.AUDIO_AAC)
  .setEncoderFactory(DefaultEncoderFactory.Builder(context)
      .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
      .setEnableFallback(true).build())
  .addListener(listener)                               // progress → JS for a gentle progress ring
  .build()
  .start(composition, outPath)
```

Why this design, with sources:
- `OverlayEffect` blends `TextureOverlay`s onto every frame, last on top
  ([ref](https://developer.android.com/reference/androidx/media3/effect/OverlayEffect)).
  `BitmapOverlay.createStaticBitmapOverlay(Bitmap)` shows a bitmap "in the same position and size
  throughout the whole video" ([ref](https://developer.android.com/reference/androidx/media3/effect/BitmapOverlay)).
  Assumption: a bitmap of exactly the output size maps 1:1 with the default `StaticOverlaySettings`
  (verify in a unit test).
- `Crop` uses normalized device coordinates ([ref](https://developer.android.com/reference/androidx/media3/effect/Crop)).
  `SingleColorLut.createFromBitmap` takes a HALD image
  ([ref](https://developer.android.com/reference/androidx/media3/effect/SingleColorLut)).
- Trim, remove audio, scale, rotate and H.264/AAC output are documented in
  [Transformer transformations](https://developer.android.com/media/media3/transformer/transformations).
  **Do not enable** `experimentalSetMp4EditListTrimEnabled`: Google warns that edit-list trimming
  keeps the "deleted" pre-roll in the file. That is a privacy risk for a public site.
- HDR: phones record HLG/HDR10 by default more and more often. `HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL`
  ("supported on API 29+", "wider support and more consistent results") gives SDR BT.709, like
  WhatsApp ([ref](https://developer.android.com/reference/androidx/media3/transformer/Composition)).
- Speed: on a Pixel 9 Pro XL, a 10 s 720p clip resizes in ~1.2 s and mutes in ~0.2 s
  ([Android Developers Blog, 2025-03](https://android-developers.googleblog.com/2025/03/media-processing-performance-jetpack-media3-transformer.html)).
  Assumption: a 60 s 1080p export with overlay takes roughly 10–40 s on a mid-range phone; measure
  on the traveler's phone.
  - Run exports in a foreground service of type **`mediaProcessing`** (a 6 h per 24 h budget), so
    they survive leaving the app ([Android docs](https://developer.android.com/develop/background-work/services/fgs/service-types)).
  - Because of A3 (offline first), the export runs right after "Post", before any upload.
- **ffmpeg-kit:** "FFmpegKit has been officially retired". The repo was archived on 2026-07-02;
  FFmpegKitNext is "distributed as source only"; license LGPL 3.0, GPL with GPL options
  ([GitHub](https://github.com/arthenica/ffmpeg-kit)). Building FFmpeg ourselves for 16 KB-page
  Android plus licence review is not worth it, because Media3 does everything we need with hardware
  codecs.
- **Skia alone cannot encode video.** It can decode frames for preview, but has no encoder, so it
  draws only the overlay.
- Other RN options:
  - `react-native-media-toolkit` (Media3/AVFoundation: trim, crop, rotate; no overlays).
  - `@projectyoked/expo-media-engine` (overlay tracks, but alpha, and not Media3).
  - Neither covers our needs as cleanly as about 300 lines of our own Kotlin
    ([search summary](https://sirstig.github.io/projectyoked-expo-media-engine/alpha)).
- Video filter **preview** (only when video filters ship, "later"): draw `useVideo` frames in Skia
  with the same LUT shader.

**iOS (later), same contract for the native module:**
- `AVVideoComposition` with a Core Image handler: `CISourceOverCompositing` with the same overlay
  PNG, and `CIColorCube` with the same LUT. Use the iOS 16+ async initializer, or the iOS 26
  `AVVideoComposition.Configuration`
  ([Apple](https://developer.apple.com/documentation/avfoundation/avvideocomposition.md)).
- Trim via the time range, mute by leaving out the audio track, SDR BT.709 colour properties,
  export via `AVAssetExportSession` or `AVAssetWriter` for bitrate control.

**Quality targets:**

| Output | WhatsApp reference | Our target | Why |
|---|---|---|---|
| Photo | Standard was ~920×1280; HD ≈ 3024×4032 (chats, 2023) | JPEG q90, sRGB; short side ≤ 1600 px, long side ≤ 2880 px; never upscale; typically 1–2.5 MB | The site's biggest variant is 1600w (`IMAGE_WIDTHS`); a 9:16 portrait needs width 1600 natively. The backend makes AVIF/WebP. |
| Video "standard" | Reportedly 720p class, compressed (no official figure) | H.264 High, 8-bit yuv420p, SDR BT.709, long side ≤ 1920, ≤ 30 fps, ~5 Mbps; AAC-LC 128 kbps 48 kHz; ≈ 38 MB/min | Matches the backend's remux path (H.264 yuv420p + AAC → `+faststart` remux, no re-encode; `MAX_VIDEO_LONG_SIDE` 1920). The app's encode is the published quality. |
| Video "light" (mobile data, A4/A5) | ≈ WhatsApp | long side ≤ 1280, ~2.5 Mbps, AAC 96 kbps; ≈ 19 MB/min | A WhatsApp-sized first upload (A5). |
| GIF | MP4 `gifPlayback` | ≤ 10 s, long side ≤ 1280, ~3 Mbps, no audio | Muted loop in the player. |
| Voice | OGG/Opus PTT, ≤ 60 s | Opus in OGG, mono 48 kHz ~32 kbps (Android 10+ `MediaRecorder` OGG/OPUS); fallback AAC m4a 64 kbps; 64-value waveform | Opus is WhatsApp's PTT format, so the WhatsApp backend path can send it unchanged. The backend transcodes to AAC m4a for the site anyway. Assumption: check that `expo-audio` exposes OGG/Opus on Android, else add it to the native module. |
| Rasterized text status | image | 1080×1920 JPEG q92 | 9:16 fills the player (`PORTRAIT_RATIO` 1.6). |

**Safe area for overlays.** The site cover-fits 9:16 images on tall phones (about 10 % cut on each
side at 9:20), and its top chrome and caption block sit over the image. So the editor shows soft
guides:
- keep text within x 10–90 %;
- keep text out of the top 12 %;
- keep text out of the bottom 20 % when there is a caption.

This matches WhatsApp's own story chrome.

### 3.6 Additive, compatibility-safe metadata (evaluation)

| Metadata | WhatsApp-compatible? | Value | Recommendation |
|---|---|---|---|
| **Alt text** from overlay texts (`accessibilityLabel`) | **Yes, natively.** `ImageMessage.accessibilityLabel` (32), `VideoMessage.accessibilityLabel` (26), `AudioMessage.accessibilityLabel` (22) exist in WAProto. Whether WhatsApp's UI fills or reads them is unverified (searched; nothing public). | High. Overlay text exists only as pixels; without it a screen reader hears nothing. The site already wants alt text (plan C, WCAG). | **v1.** Default = the text layers in reading order (top to bottom, then start to end), joined with " · ", trimmed, ≤ 1000 characters. Editable in "More". Captured statuses get it too if WhatsApp sends one (helper change, S). Site alt chain becomes: owner description, else `alt`, else caption, else "". |
| **Source marker** `app` / `whatsapp` | Not a WhatsApp field; derived from `sourceKey`, so nothing is stored. | Admin filter or badge, dedupe, metrics. | **v1, derived only.** Not in site data. |
| **Voice background** (`bgArgb`) | Yes (`AudioMessage.backgroundArgb`). | Nice: her voice notes get her colour, like on WhatsApp. | **should.** Optional `AudioMedia.bg`; VoiceSlide uses it instead of the gradient when present. |
| **`imageSource: rasterized_text_status`** | Yes (`ImageMessage.imageSourceType`). | Lets the player skip Ken Burns on text images; lets the admin label them. | **optional.** Keep it in the store and mirror; publish only if the player uses it. |
| **"Taken at" day** for gallery media | Not a status field (WhatsApp uses the post time). | Posting yesterday's photo today should land on yesterday. | **No model change.** The app suggests "Put on Tue 18 Nov (when it was taken)?" and writes the existing annotation `localDateOverride`. |
| **Visibility at post time** | Not a status field (WhatsApp's audience lists are a different thing). | "Review first" for a sensitive photo. | **No model change:** annotation `visibility` (`pending` / `hidden`). |

### 3.7 Private original + edit list: worth it in v1?

**Recommendation: no server-side originals or edit lists in v1. Define the EditDoc now and keep it
on the device.**

- **Against v1 upload:**
  - Originals are large: 4K phone video ≈ 350–450 MB/min. They would have to travel through the
    shared PHP host (50 MB uploads, 60 s execution, 2–10 workers, limited disk), or wait for A5
    (originals on Wi-Fi), which is not confirmed yet.
  - A server-side re-render would need a second renderer (fonts, Skia layout, LUTs) that matches
    the device pixel for pixel, which is fragile.
  - WhatsApp itself cannot edit a posted status.
- **For on-device re-editing:**
  - Typos in overlay text happen.
  - Keeping the EditDoc (a few KB) plus a reference to the original (the gallery content URI, or a
    copy of in-app camera captures) makes "Edit again" cheap while the phone still has the original.
- **v1.1 (with A5):** upload `editdoc.json` + the original into the backend's private archive
  (`data/archive/…/app-<id>.orig.<ext>`, `…editdoc.json`). They are never published and never
  mirrored to the API. No model change is needed, because the EditDoc is versioned and opaque to
  the generator.

EditDoc v1 (app-internal; the zod schema can live in `packages/contracts/src/app-edit.ts` so a
later backend tool can read it):

```ts
const N = z.number().min(-1).max(2);              // normalized to the crop rect (may lie off-canvas)
const Layer = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string().max(500), font: FontName, colorArgb: Argb,
             bg: z.enum(['none', 'pill', 'solid']), bgArgb: Argb.optional(), align: z.enum(['start', 'center', 'end']),
             x: N, y: N, size: z.number().positive(), rot: z.number(), scale: z.number().positive() }),
  z.object({ t: z.literal('ink'), tool: z.enum(['pen', 'marker']), colorArgb: Argb, width: z.number().positive(),
             pts: z.array(z.number()) /* x0,y0,x1,y1,… */ }),
  z.object({ t: z.literal('emoji'), char: z.string().max(16), x: N, y: N, size: z.number(), rot: z.number() }),
  z.object({ t: z.literal('sticker'), id: z.string().max(40), params: z.record(z.string(), z.string()).optional(),
             x: N, y: N, scale: z.number(), rot: z.number() }),
]);
export const EditDoc = z.object({
  v: z.literal(1),
  base: z.object({ kind: z.enum(['photo', 'video', 'text']), uri: z.string(), sha256: Sha256Hex.optional(),
                   w: z.int(), h: z.int(), durationMs: z.int().optional() }),
  crop: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(),
                   rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]), flipX: z.boolean() }),
  trim: z.object({ startMs: z.int(), endMs: z.int() }).optional(),
  mute: z.boolean().optional(), loop: z.boolean().optional(),
  filter: z.enum(['pop', 'mono', 'cool', 'chrome', 'film']).optional(),
  textStatus: InboxText.optional(),
  layers: z.array(Layer).max(60),
  output: z.object({ preset: z.enum(['standard', 'light']), w: z.int(), h: z.int() }),
});
```

### 3.8 Re-edit, replace, delete

- **Re-edit** ("Edit again" on the phone): render, then upload `AppStatus` with the same `id` and
  `rev` + 1.
  - The backend replaces the media and facts of `app:<id>`. Variants are content-addressed, so the
    publisher's normal diff deletes the old files.
  - `sourceKey` and `publicId` stay. Annotations, wave-5 reactions, views and links keep pointing
    at the same entry.
  - Only `app:` captures may change; `wa:` facts stay immutable.
- **Delete:** the app sends a revoke. The backend sets `revoked_at` and applies the existing
  `ingest.on_revoke` policy. Same semantics as a WhatsApp delete.

### 3.9 Fonts on the device, and licensing

The text-status maker and the overlay text tool both use the **FontName enum** (overlay text is
pixels, but one font set keeps the look consistent and the APK small):

| FontName | App face (bundled TTF) | Matches site | Licence | Notes |
|---|---|---|---|---|
| SYSTEM | Android system sans (Roboto / Google Sans) | yes (`system-ui`) | system | iOS later: SF |
| SYSTEM_TEXT | Android `serif` (Noto Serif) | yes (`ui-serif`) | system | |
| SYSTEM_BOLD | system sans 700 | yes | system | |
| FB_SCRIPT | **Playpen Sans 500** (+ Arabic and Hebrew cuts) | yes (`--font-wa-script` = hand) | OFL-1.1 | WhatsApp's own face is a script (the repo notes Norican, OFL). Playpen is kept because it covers **Vietnamese**, which Norican does not (`@fontsource/norican` 5.3.0 ships only latin and latin-ext files, checked on unpkg). |
| MORNINGBREEZE_REGULAR | **Nunito 800** | yes | OFL-1.1 | Real Morning Breeze: licence unclear ("OFL" on Fontspace vs "free for personal use" elsewhere) ([search](https://www.fontspace.com/morning-breeze-font-f64724)). Do not bundle. |
| CALISTOGA_REGULAR | **Calistoga 400** | yes | OFL-1.1 | the real WhatsApp family |
| EXO2_EXTRABOLD | **Exo 2 800** | yes | OFL-1.1 | the real family |
| COURIERPRIME_BOLD | **Courier Prime 700** | yes | OFL-1.1 | the real family; no Vietnamese (falls back; same on the site) |

- **Licence checks:** the repo's installed `@fontsource*` packages declare `OFL-1.1` (Calistoga,
  Exo 2, Courier Prime, Nunito, Playpen Sans 5.3.0); npm `@fontsource/norican` and `/damion` 5.3.0
  are OFL-1.1 too.
- **OFL obligations:** the fonts may be bundled and embedded in an app. Ship the copyright + OFL
  text, e.g. in the app's "Licences" screen. Do not sell the fonts on their own. Renamed modified
  versions are needed only if a font has Reserved Font Names and we modify it (subsetting counts as
  modification; use unmodified TTFs, or check for RFNs before subsetting).
- **Source of TTFs:** React Native needs TTF/OTF, not WOFF2. Use `@expo-google-fonts/*` 0.4.x
  (calistoga, exo-2, courier-prime, nunito, playpen-sans) or the repo's own subsetting script
  (`scripts/fonts/subset-playpen.sh`) to emit TTF. Register the same files with `expo-font` (UI)
  and a Skia `TypefaceFontProvider` (render).
- **Emoji:** use the system emoji on Android (Noto Color Emoji, OFL). Bundle Noto Color Emoji on
  iOS (§1.2 caveat).
- **Shared code:** `WA_FONTS` / `waFontStyle` (frontend/shared) and `textStatusScale` (site
  `items.ts`) should move into a DOM-free shared module, e.g. `packages/contracts/src/wa-style.ts`
  or a new `packages/wa-style`. Then the app and the site use the same size thresholds (24, 70,
  160) and the same `cqi` ratios (10.5, 8, 6.4, 5.2; padding 9). **S.**

### 3.10 The optional WhatsApp path (same artifacts)

| Kind | Backend posting (whatsmeow `SendMessage` to `status@broadcast`, "experimental" per whatsmeow README; needs the *traveler's* account linked, which plan A1 rules out today) | Android share sheet (`ACTION_SEND`, `EXTRA_STREAM` + `EXTRA_TEXT`, `setPackage("com.whatsapp")`) |
|---|---|---|
| photo | `ImageMessage{caption, accessibilityLabel}` with the same JPEG: full fidelity | Same JPEG; `EXTRA_TEXT` becomes the caption ([SO answer, old](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/a/26779969)). She picks "My status" in WhatsApp's picker. Assumption: no intent extra preselects "My status"; verify on the phone. |
| video / gif | `VideoMessage{caption, seconds, gifPlayback}`: full fidelity | same MP4; WhatsApp may re-compress |
| text | `ExtendedTextMessage{text, backgroundArgb, textArgb, font}`: full fidelity | **Not expressible** through an intent. Share the rasterized 1080×1920 image (WhatsApp's own `RASTERIZED_TEXT_STATUS` idea), or the plain text. |
| voice | `AudioMessage{PTT, waveform, backgroundArgb}` with the Opus file: full fidelity | Likely arrives as an audio file, not a voice status (assumption) |

**Dedupe (required for either path).** The observer captures whatever the traveler posts to
WhatsApp, so the timeline would show the moment twice. The backend links a new `wa:` capture to a
recent `app:` capture and does not publish the `wa:` copy. The app copy is better quality and keeps
reactions.

- **Backend path:** the link is exact, because the backend knows the msgId it sent.
- **Share path:** match on the same kind, a time window after `waShare.at` (the app records when
  she tapped "Also share to WhatsApp"), and:
  - an equal caption plus a perceptual hash of the image or poster (dHash, small Hamming distance);
  - for text: body + font + background;
  - for voice: duration ±0.5 s.

  The admin shows "also on WhatsApp ✓" with an undo.

---

## 4. Contract changes (zod) and impact

### 4.1 Contracts (`packages/contracts`)

**`common.ts` (additive):**

```ts
export const APP_SOURCE_NS = 'app';
/** Client ULID of an app status (Crockford base32, 26 chars, uppercase). */
export const AppStatusId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { message: 'Expected a ULID' });
export function appSourceKey(id: string): string { return `${APP_SOURCE_NS}:${AppStatusId.parse(id)}`; }
export const CaptureOrigin = z.enum(['whatsapp', 'app']);
export type CaptureOrigin = z.infer<typeof CaptureOrigin>;
/** Derived, never stored: "wa:…" -> whatsapp, "app:…" -> app. */
export function captureOrigin(sourceKey: string): CaptureOrigin { /* parseSourceKey(sourceKey).ns */ }
```

**`wa.ts` (additive; `InboxMeta.schema` stays 1, all fields optional):**

```ts
export const Argb = z.int().min(0).max(0xffffffff);          // was module-private; export it
/** Named Wa… because site.ts already exports `ImageSource` (an image variant) through index.ts. */
export const WaImageSourceType = z.enum(['user', 'ai_generated', 'ai_modified', 'rasterized_text_status']);
export const InboxMedia = z.object({
  /* …existing fields… */
  /** Image/Video/AudioMessage.accessibilityLabel: alt text written by the sender or the app. */
  accessibilityLabel: z.string().max(2000).optional(),
  /** AudioMessage.backgroundArgb: the voice status background. */
  bgArgb: Argb.optional(),
  /** ImageMessage.imageSourceType, only when not USER_IMAGE. */
  imageSource: WaImageSourceType.optional(),
});
```

**New `app.ts`** (the upload record; reuses wa.ts shapes so the model is literally the same):

```ts
export const AppStatusKind = z.enum(['photo', 'video', 'gif', 'voice', 'text']);   // CaptureKind minus 'unsupported'
export const APP_LIMITS = { textBody: 700, caption: 1024, alt: 1000, videoSeconds: 60, gifSeconds: 10,
                            voiceSeconds: 60, photoMaxShortSide: 1600, photoMaxLongSide: 2880, videoMaxLongSide: 1920 } as const;
export const AppMedia = InboxMedia.extend({
  accessibilityLabel: z.string().max(APP_LIMITS.alt).optional(),
});
export const AppText = InboxText.extend({
  body: z.string().min(1).max(APP_LIMITS.textBody),
  bgArgb: z.int().min(0xff000000).max(0xffffffff),   // opaque; a plain range, so it exports to JSON Schema for PHP
  textArgb: Argb,
  font: FontName,
});
export const AppStatus = z.object({
  schema: z.literal(1),
  id: AppStatusId,
  rev: z.int().min(1),
  kind: AppStatusKind,
  postedAt: IsoUtc,
  tz: TimeZone,
  caption: z.string().max(APP_LIMITS.caption).optional(),
  text: AppText.optional(),
  media: AppMedia.optional(),
  /** Private, never published. */
  client: z.object({ app: z.string().max(32), platform: z.enum(['android', 'ios']) }).optional(),
  /** Private: she also shared it to WhatsApp (dedupe hint). */
  waShare: z.object({ at: IsoUtc, via: z.enum(['share_intent', 'backend']) }).optional(),
}).superRefine((s, ctx) => {
  // same kind rules as InboxMeta, plus: caption only for photo|video|gif; voice: media.ptt === true;
  // gif: media.gifPlayback === true; mimetype whitelist: image/jpeg | video/mp4 | audio/ogg;codecs=opus | audio/mp4;
  // seconds <= APP_LIMITS.*Seconds; width/height required for photo/video/gif.
});
```

**`site.ts` (additive, optional; no `contractVersion` bump: the site build ships in the same image
as the generator):**

```ts
const EntryBase = z.object({ /* … */
  /** Alt text of the status itself (WhatsApp accessibilityLabel / the app's overlay texts), verbatim. */
  alt: z.string().max(1000).optional(),
});
export const AudioMedia = z.object({ /* … */
  /** Voice status background (AudioMessage.backgroundArgb), "#rrggbbaa". */
  bg: RgbaColor.optional(),
});
```

**`api.ts` (additive):**
- `CaptureMirror` gets `alt: z.string().max(1000).nullish()` (and optionally `voiceBg: RgbaColor.nullish()`).
- `CaptureListItem` inherits them. The admin derives the origin from `sourceKey`, so no DTO field
  is needed.
- The app-upload endpoints and the change-feed variant for app statuses belong to the
  upload/transport design (A3/A4). They should carry `AppStatus` as defined above.
- Regenerate `api/schemas/*.json` (`pnpm schemas`).
- **`CaptureMirror.json` has `additionalProperties: false`** (checked). So the API must be deployed
  before a backend that sends the new fields (the plan's "API first" rule).

### 4.2 Impact and estimates

| Part | Change | Size |
|---|---|---|
| contracts | `common.ts` app ids + origin; wa.ts exports `Argb` + optional `InboxMedia` fields; new `app.ts`; `app-edit.ts` (EditDoc); `site.ts` `alt`, `AudioMedia.bg`; api.ts `CaptureMirror.alt`; tests + JSON-schema export | **S–M** |
| shared style module | Move `WA_FONTS`, `waFontStyle`, `textStatusScale` into a DOM-free package used by the site, admin and app | **S** |
| wa-helper (Go) | Extract `accessibilityLabel` (image, video, audio), `AudioMessage.BackgroundArgb`, `ImageMessage.ImageSourceType` into `media`; golden tests; `apicheck.go` getters | **S** |
| backend store | Migration: `captures.source` CHECK gains `'app'` (SQLite table rebuild); `rev`; app-ingest bookkeeping (upload id, `waShare`); `capture_links` (wa ↔ app) | **S–M** |
| backend ingest | Pull the app status + file from the API, verify sha256, archive as `app-<id>.<ext>` + `.json`, enqueue the existing pipeline (photo: as today; video: remux fast path; voice: Opus → AAC + waveform from the app or recomputed); `rev` replacement; revoke | **M** (transport and sync plumbing shared with the upload design) |
| backend dedupe | `wa` ↔ `app` matching (exact for the backend path, heuristic for the share path), suppression in the generator, admin link | **M** |
| generator | `Entry.alt` from `media.accessibilityLabel`; `AudioMedia.bg` from `media.bgArgb`; nothing else (same `captureEntry`) | **S** |
| API (PHP) | `captures` mirror: `alt` (+ voice background) columns or JSON; JSON-schema regen; validation | **S** (the upload endpoints are counted in the upload design: **M–L**) |
| site | `items.ts`: `alt: description ?? entry.alt ?? caption ?? ''`; optional VoiceSlide solid `bg`; optional no Ken Burns for rasterized text (only if published) | **S** |
| admin | Origin badge (derived), alt text read-only in the item sheet, "also on WhatsApp" link | **S** |
| app: text-status composer | Palette, font bar, live preview with the shared scale/fonts, rasterize mode | **M** |
| app: media editor | Skia scene: text (fonts, colours, pill, alignment), emoji, pen, stickers, crop/rotate, filters (photo), safe-area guides, gestures (pinch, rotate, drag to trash), haptics; EditDoc persistence | **L** |
| app: photo export | Skia offscreen render + JPEG + sha256 | **S–M** |
| app: video export module | Kotlin Expo module on Media3 1.11.1: crop/rotate/scale, LUT, overlay, trim, mute, HDR→SDR, bitrate presets, progress, `mediaProcessing` FGS; device tests | **M** |
| app: voice | Recorder (Opus/OGG), 64-peak waveform, colour, 60 s cap | **M** |
| app (iOS, later) | AVFoundation version of the video module; Noto emoji bundling | **M** |

**Rollout order:**
1. Contracts and the shared style module.
2. API deploy: accepts the new optional fields.
3. Backend: helper extraction, store migration, generator.
4. App ingest + dedupe.
5. Site/admin (they ship with the backend image and the API deploy respectively).
6. The app.

None of this changes how existing captured statuses render.

---

## 5. Open questions / verify on real devices (Phase 0 or the app spike)

1. Does WhatsApp send a decorated text status (drawing or stickers) as `ImageMessage` with
   `imageSourceType = RASTERIZED_TEXT_STATUS`? (Post one from the traveler's phone; check
   `rawProtoB64`.)
2. Does WhatsApp set `accessibilityLabel` on status media (auto alt text?) or show it to TalkBack
   users?
3. The WhatsApp limits on the traveler's build: text-status length, caption length, video length
   (60 vs 90 s).
4. Can a share intent land on "My status" directly? What does WhatsApp do with a shared Opus file?
5. Skia on the traveler's phone: EXIF orientation, HEIC decode, emoji fallback in Paragraph,
   offscreen 2880 px surface memory.
6. Media3: is the full-frame overlay 1:1? Measure export time for 60 s 1080p with overlay + LUT;
   check HDR tone-mapping on her camera's HDR video.
7. `expo-audio` on Android: is OGG/Opus recording possible, or does it need the native module?

---

## Sources

- whatsmeow pinned protos (local, read-only): `.cache/go/pkg/mod/go.mau.fi/whatsmeow@v0.0.0-20261116172437-19d61352436f/proto/waE2E/WAWebProtobufsE2E.proto`, `…/proto/waStatusAttributions/WAStatusAttributions.proto`; whatsmeow README "Sending status messages (experimental, may not work for large contact lists)".
- WhatsApp blog, "More ways to express yourself on Status" (2025-05-29): https://blog.whatsapp.com/more-ways-to-express-yourself-on-Status
- Meta newsroom, music/layout/sticker options (2025-05): https://about.fb.com/news/2025/05/new-music-layout-sticker-options-whatsapp-status/
- WABetaInfo: text editor (2023-03-31) https://wabetainfo.com/whatsapp-is-releasing-a-new-text-editor-experience-on-android-beta/ · iOS 23.8.0.73 https://wabetainfo.com/whatsapp-beta-for-ios-23-8-0-73-whats-new/ · text composer bar 2.25.5.18 https://wabetainfo.com/whatsapp-beta-for-android-2-25-5-18-whats-new/ · text status drawing/stickers 2.25.19.13 https://wabetainfo.com/whatsapp-beta-for-android-2-25-19-13-whats-new/ · text status mentions https://wabetainfo.com/whatsapp-is-rolling-out-mentions-for-text-status-updates/ · status mentions/likes https://wabetainfo.com/whatsapp-is-rolling-out-new-status-like-reaction-and-mention-features-on-ios-and-android/ · reaction sticker 2.25.36.6 https://wabetainfo.com/whatsapp-beta-for-android-2-25-36-6-whats-new/ · question/reaction stickers announced https://wabetainfo.com/whatsapp-announces-missed-call-messages-new-status-sticker-and-channel-questions/ · holiday stickers https://wabetainfo.com/whatsapp-announces-holiday-update-with-2026-stickers-and-fun-interactive-effects/ · voice status 1 min https://wabetainfo.com/whatsapp-is-rolling-out-voice-status-updates-up-to-1-minute-long/ · GIPHY after Tenor https://wabetainfo.com/whatsapp-migrates-users-to-giphy-as-tenor-shuts-down-its-api/ · AI status images https://wabetainfo.com/whatsapp-launches-new-ai-powered-tool-to-generate-status-images-on-ios-and-android/ · HD status (beta) https://wabetainfo.com/whatsapp-news-of-the-week-high-quality-photos-and-videos-for-status-updates/
- 9to5Mac, music clip 30 s (2026-09-08): https://9to5mac.com/2026/09/08/whatsapp-doubles-music-clip-length-for-status-updates/
- 9to5Google, Tenor API shutdown (2026-06-30): https://9to5google.com/2026/06/30/google-tenor-api-gif-updates/
- GSMArena, close friends/lists beta: https://fo.gsmarena.com/whatsapp_custom_lists_close_friends_status_update_android_beta_users-news-71456.php
- Video status 1 minute: https://thenews.com.pk/latest/1171499-whatsapp-introduces-1-minute-video-status-updates
- Mute before sharing (2021): https://thestar.com.my/tech/tech-news/2021/03/02/whatsapp-announces-new-feature-for-users-to-mute-audio-in-videos-before-sharing
- Filters (2017): https://www.engadget.com/2017-06-06-whatsapp-photo-filters-albums.html · https://www.techradar.com/news/whatsapp-for-ios-just-added-filters-and-albums-for-photos-and-videos
- Meta AI styles on status: https://www.digit.in/news/apps/whatsapp-status-to-add-meta-ai-image-editing-and-animation-features-what-to-expect.html
- HD photos (2023): https://www.macrumors.com/2023/08/18/whatsapp-hd-photos-send-high-res-images/ · HD status beta: https://www.androidcentral.com/apps-software/whatsapp-hd-toggle-for-sharing-high-resolution-media
- Text colour fixed to white (low-quality source): https://techcult.com/how-to-change-whatsapp-font-color-in-chat-and-status
- Media3 release notes (1.11.1 stable 2026-09-10; 1.12.0-beta01 2026-11-11): https://developer.android.com/jetpack/androidx/releases/media3 · Media3 1.10 blog: https://android-developers.googleblog.com/2026/03/media3-110-is-out.html
- Media3 Transformer transformations: https://developer.android.com/media/media3/transformer/transformations · OverlayEffect https://developer.android.com/reference/androidx/media3/effect/OverlayEffect · BitmapOverlay https://developer.android.com/reference/androidx/media3/effect/BitmapOverlay · SingleColorLut https://developer.android.com/reference/androidx/media3/effect/SingleColorLut · Crop https://developer.android.com/reference/androidx/media3/effect/Crop · Composition (HDR modes) https://developer.android.com/reference/androidx/media3/transformer/Composition · performance blog https://android-developers.googleblog.com/2025/03/media-processing-performance-jetpack-media3-transformer.html
- Android FGS `mediaProcessing`: https://developer.android.com/develop/background-work/services/fgs/service-types
- FFmpegKit retirement: https://github.com/arthenica/ffmpeg-kit (archived 2026-07-02, "Update (July 2026)")
- Apple AVVideoComposition: https://developer.apple.com/documentation/avfoundation/avvideocomposition.md
- RN media libraries (search summaries): https://sirstig.github.io/projectyoked-expo-media-engine/alpha · https://cdn.jsdelivr.net/npm/react-native-media-toolkit@2.3.5/README.md
- npm registry (2026-11-20): `expo` 58.0.26 (SDK 58 released 2026-09-29) and its `bundledNativeModules.json` (https://unpkg.com/expo@58.0.26/bundledNativeModules.json); `@shopify/react-native-skia` 2.14.0; `react-native` 0.88.1; `react-native-vision-camera` 5.2.4; `@fontsource/norican`, `@fontsource/damion` 5.3.0 OFL-1.1; `@expo-google-fonts/*` 0.4.x.
- Morning Breeze licence (conflicting): https://www.fontspace.com/morning-breeze-font-f64724
- Android share intent caption via EXTRA_TEXT (old): https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/a/26779969 · Android docs: https://developer.android.com/training/sharing/send
