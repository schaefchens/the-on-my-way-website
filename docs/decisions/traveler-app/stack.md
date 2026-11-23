# Traveler app: React Native stack and project setup (Android first)

Research for the "On My Way" traveler app, as of **2026-11-20**. Versions come from the npm registry,
Maven and the vendors' docs on that day (links in §15). Anything marked **Assumption** or **(verify)**
has not been confirmed and needs a spike or an owner answer.

Scope: the stack and the project setup. The exact WhatsApp encoding parameters (JPEG size and
quality, the video bitrate/resolution/length caps, the overlay font set, voice codec) belong to the
sibling WhatsApp-encoding research. This document only says *where* in the stack each one is applied.

---

## 0. Summary

- **Expo SDK 58** (React Native 0.88.1, React 19.3.0, Hermes V1, New Architecture only) with
  development builds and Continuous Native Generation, **expo-router 58**. Not bare React Native, not
  Expo Go. One **local Expo module (Kotlin)** for what JS can't do well: the Media3 video export
  (bakes overlays, trims, transcodes) and the background uploader.
- **Build locally on the Mac** (Gradle, no Docker). Use EAS Build (free tier) only for iOS later.
  Distribute through **Google Play internal testing**, with a signed APK over adb as the fallback.
- **Camera:** VisionCamera 5.2.x. **Picker:** expo-image-picker (the system Photo Picker, no media
  permissions). **Editor:** `@shopify/react-native-skia` 2.14.0 (the v2 line Expo validates, not the
  brand-new Graphite v3). **Video:** expo-video for playback, Media3 Transformer for the export.
  ffmpeg-kit is retired; don't use it.
- **Motion:** Reanimated 4.7 and Gesture Handler 3.3 (hook API). **Haptics:** expo-haptics, Android path
  only through `performAndroidHapticsAsync` (`View.performHapticFeedback`, which respects the system
  "touch feedback" switch).
- **Offline-first:** per-entry outbox folders are the durable truth, with expo-sqlite as the index.
  Uploads use a **hand-written tus 1.0 subset** on the PHP API (chunks ≤ 8 MiB, resumable, checksummed).
  The client is a JS tus client first, then a native UIDT/WorkManager uploader before the traveler
  depends on it.
- **Auth:** QR pairing in the admin mints an `app` token (the kind already exists). It lives in
  Keystore-backed storage, with an optional biometric app lock. Narrow the app token's power before
  wave 5 (§9).
- **Monorepo:** `frontend/app` (`@omw/app`) in the existing pnpm 10 workspace, isolated installs, reusing
  `@omw/contracts` (zod 4.6.7) from source through a Metro condition. Lingui 6.12 de/en plus pseudo-ar.
  Tests: Vitest for the framework-free logic, jest-expo for components, Maestro for e2e.

---

## 1. Constraints taken from the repo

| Fact | Where | Consequence for the app |
|---|---|---|
| Owner decision: app entries are WhatsApp statuses. Overlays are baked into pixels on the device; the caption stays text; text statuses are `body + bgArgb + textArgb + font` (FontName enum) | task, `packages/contracts/src/wa.ts` (`InboxText`, `InboxMedia`, `FONT_TYPE_NUMBERS`) | The editor needs an exporter that flattens to JPEG and MP4 on the device. No layer model leaves the phone (apart from optional private metadata). The app validates its entry manifest with the same zod pieces. |
| Tokens `omw_` + 43 base64url, sha256 at rest; kinds `session`/`backend`/`app`; `app` always has scope `["admin"]` (DB `CHECK` + `TOKEN_KIND_SCOPES`) | `api/src/Domain/Auth/ApiTokens.php`, `api/migrations/0001_init.sql`, `contracts/src/api.ts:722` | The app can already call `/api/v1/admin/*` with `Authorization: Bearer` (no CSRF, `Middleware/AdminAuth.php`). Pairing and uploads are new endpoints. |
| Mutating `/admin/*` requests must have JSON bodies (`RequireJsonBody`, 415 otherwise) | `api/src/Http/Routes.php` | Binary chunk uploads need their own route group outside `/admin`. |
| Hosting: Apache + PHP-FPM 8.5, `upload_max_filesize`/`post_max_size` 50M, `memory_limit` 128M, `max_execution_time` 60, 2–10 PHP workers, no SSH | `docs/HOSTING.md`, task | Small chunks, streamed to disk; never buffer a file in PHP memory; one upload at a time per device. |
| The live hosts drop HTTPS from the development machine's IP since 2026-11-20 | `README.md` | A phone on the same home Wi-Fi is blocked too. Develop against the local PHP API (`php -S`) over `adb reverse` (§10). |
| Workspace: pnpm 10.13.1, `packages/*`, `backend`, `frontend/*`; Node ≥ 24 (`.nvmrc` 24; the Mac runs 26.11.1); TS 7.0.2; zod 4.6.7; React 19.3.1 (web); Lingui 6.12.0; Vitest 5.1.1; Biome 2.6.8; all tool caches in `.cache/` | root `package.json`, `pnpm-workspace.yaml`, `.npmrc` | Expo 58 needs Node 22.13+/24.3+/26+ (OK). The app pins React **19.3.0** (§10). Put Gradle and Metro caches under `.cache/` too. |
| Contracts export `@omw/source` conditions to the TS sources, which use `.js` import specifiers | `packages/contracts/package.json`, `src/*.ts` | Metro needs a custom condition plus a `.js`→`.ts` fallback (§10). |
| Docker VM is shared and nearly full | memory | Android builds run natively on the Mac, never in Docker. |
| Mac tooling seen: Android SDK in `~/Library/Android/sdk`, `adb` and `maestro` on PATH, **no Java runtime on PATH** | local check | Point `JAVA_HOME` at Android Studio's bundled JBR (JDK 17+). **Assumption:** Android Studio is installed. |

---

## 2. Platform: Expo SDK 58 vs bare React Native

**Current state (verified):**
- Expo SDK 58 was released on 2026-10-15. The latest is `expo@58.0.26` (2026-11-17), with
  React Native **0.88.1**, React **19.3.0** and react-native-web 0.21.0.
- Android: min 7 (API 24), compileSdk 37, targetSdk 36. iOS: 16.4+, Xcode 26.4+.
- Node: 22.13+ / 24.3+ / 26+ (odd majors unsupported).
- SDK 58 also: AGP 9 compatible; R8 on by default in release builds; prebuilt `expo-modules-core` on
  Android; `NODE_ENV` set by the command; React Native 0.87's strict TypeScript API is the default.
  Expo Go for 58 lags, so use development builds. ([SDK 58 changelog][sdk58], [version table][expo-versions])
- The Legacy Architecture was removed in SDK 55. Everything below assumes the New Architecture. SDK 57
  carried a Hermes V1 memory regression with Reanimated/Worklets, fixed in 57.0.9 ([SDK 57][sdk57]).
  Keep the habit of reading the patch notes.
- SDKs live about one year. SDK 59 is likely in spring 2027 **(assumption from the cadence)**.
- targetSdk 36 meets Google Play's rule that new apps and updates target API 36 from 2026-08-31
  ([target API][play-target]).

**Recommendation: Expo (CNG + `expo-dev-client`), not bare React Native.**
- *Why:* every library we need ships as an Expo SDK module or has config-plugin/autolinking support.
  `npx expo prebuild` regenerates `android/` from `app.config.ts`, so there is no hand-maintained native
  project. Local Expo modules give us a clean Kotlin escape hatch (Media3, uploader). The same app gets
  an iOS build later without a second native project.
- *Bare RN* would only make sense for a large custom native codebase; ours is about 1–2k lines of
  Kotlin.
- *Expo Go* is impossible: Skia, VisionCamera and our own module need a development build.
- **expo-router 58** (`~58.0.32`): file-based routes, typed links, deep links for the pairing QR and
  share-in, native tabs (stable in 58). It's the default for SDK 58 and costs nothing extra.
  Note the 58 rework: deterministic route keys, much of the forked React Navigation surface removed
  ([SDK 58][sdk58]).
- **minSdk:** raise it from 24 to **29** (Android 10) via `expo-build-properties`. That means scoped
  storage only, a more mature MediaCodec and Media3 path, and fewer code paths to test.
  **Assumption:** the traveler's phone runs Android 10 or newer. Confirm the model and version first;
  it also decides the camera spike (§4).
- **16 KB pages:** Play blocks updates without 16 KB support from **2027-02-01**
  ([page sizes][pagesize]). Expo 58 and RN 0.88 are fine. Check every prebuilt `.so` (Skia,
  VisionCamera, Nitro) with `zipalign -c -P 16 -v 4 app.apk` in CI. This is also another reason to avoid
  the retired ffmpeg-kit binaries (§6).

Risk: the yearly SDK upgrade, with Router and native-module churn. Mitigation: pin exact versions, as
the repo already does (`npx expo install --fix` writes `~` ranges; pin them afterwards), and run
`npx expo-doctor` in CI.

---

## 3. Builds and distribution

### Builds
| Option | What | Cost | Use it for |
|---|---|---|---|
| Local: `npx expo run:android` (debug, dev client) and `npx expo prebuild` → `./gradlew bundleRelease` / `assembleRelease` | Gradle on the Mac with the Android SDK (present) and JDK 17+ (Android Studio's JBR) | free | **Daily development and Android releases** |
| `eas build --local` | Same as EAS cloud but on the Mac; needs an Expo login; no cache; "Secret" env vars unavailable ([local builds][eas-local]) | free (quota use not documented; **verify**) | Optional, if `eas.json` profiles are preferred |
| EAS Build (cloud) | Free plan: 15 Android + 15 iOS builds, low-priority queue, 45-min timeout. Starter $19/month ([pricing][eas-pricing]) | free / $19 | **iOS later** (no local Xcode signing hassle); uploads the source to Expo |
| EAS Update (OTA JS) | Free plan: 1,000 MAUs ([pricing][eas-pricing]) | free | Optional: JS hotfixes while the traveler is abroad (`runtimeVersion` from the fingerprint policy). Off by default; Play internal releases arrive in minutes anyway |

Keep Gradle's cache in the repo, following the `.cache/` convention: `GRADLE_USER_HOME=$PWD/.cache/gradle`.
Point Metro's `cacheStores` at `.cache/metro`. The Android SDK and Studio stay global installs, the
owner's existing setup. The upload keystore belongs in `.secrets/`, which this research did not open.
Use Play App Signing so that losing the upload key is recoverable.

### Distribution for one Android phone
| Channel | Facts (verified) | Verdict |
|---|---|---|
| **Play Console internal testing** | Up to 100 testers. New builds reach testers "within minutes" and "might not be subject to standard Play policy or security reviews". The first link can take hours ([internal testing][play-internal]). One-time US$25 registration with identity verification (third-party sources agree; **verify** on signup). Play developers are verified automatically for the new Android developer verification ([dev verification][devverif]) | **Recommended.** Updates arrive through the Play Store anywhere in the world. Covers the 2027 verification rule. No sideloading toggles on the traveler's phone |
| Direct APK (adb or a link) | adb stays exempt from developer verification. From **2027, globally**, installing an unregistered APK needs adb or the new "advanced flow" with a mandatory 24-hour wait. Brazil, Indonesia, Singapore and Thailand since 2026-09-30. A free "limited distribution" account (up to 20 devices, no ID) launched in 2026-08 ([dev verification][devverif]) | Fallback for emergencies and for the first USB install |
| Firebase App Distribution | Still sideloading ("unknown sources") plus a Firebase project. Same 2027 verification caveat | Not needed |

### iOS later
- Apple Developer Program: **99 USD per membership year** ([enroll][apple-enroll]).
- TestFlight: up to 100 internal testers (team members); up to 10,000 external testers after a beta
  App Review of the first build ([TestFlight][testflight]).
- SDK 58 builds for iOS 27 with the scene life cycle by default.
- Build with EAS (cloud) or locally with Xcode 26.4+.
- The traveler's iPhone would join as an internal tester, which needs a team role. Alternative: an
  external tester through a public link.

---

## 4. Camera

| | **react-native-vision-camera 5.2.4** (2026-10-29) | **expo-camera 58.0.14** |
|---|---|---|
| Architecture | Nitro Modules rewrite (v5.0.0 on 2026-04-16). Peers: `react-native-nitro-modules` 0.37.2, `react-native-nitro-image` 0.15.2. Outputs API (`usePhotoOutput`, `useVideoOutput`), constraints-based format negotiation ([v5 blog][vc5]) | Expo module, follows the SDK cadence |
| Android backend | CameraX **1.7.0-alpha03**, pinned in its `build.gradle` (stable 1.7.0 now exists on Maven) | CameraX **1.6.0** (stable) |
| Photo/video | `capturePhoto` (in-memory) / `capturePhotoToFile`, video recorder with a custom path, fps/HDR constraints, `prepareSettings` for fast capture | `takePictureAsync`, `recordAsync` (maxDuration/maxFileSize, `videoQuality` 2160p–480p, bitrate). Codec choice is iOS only |
| Flash, torch, zoom | Torch strength API, `zoom` (animatable), native zoom gesture listener (5.2.4), tap-to-focus with listeners (5.2.4), manual AE/AF/AWB | `flash` off/on/auto/**screen**, `enableTorch`, `zoom` 0–1, `facing`, `mirror`, stabilization modes. **Autofocus and lens selection are iOS only** ([docs][expo-camera]) |
| QR | `react-native-vision-camera-barcode-scanner` 5.2.4 (ML Kit) | Built-in `barcodeScannerSettings` |
| Extras | `react-native-vision-camera-skia` (Skia preview/effects), frame processors through `react-native-worklets` | `scanDocumentAsync` (new in 58) |
| Stability notes | Many Android fixes through 5.0.9–5.2.4 (executor starvation, HardwareBuffer leaks, recorder disposal). An open abort when two sessions share an output (#4156; not our pattern) ([releases][vc-releases]) | Fewer knobs, fewer moving parts |

**Recommendation:**
- **VisionCamera 5.2.x for the capture screen.** The WhatsApp-like camera is the heart of the app:
  - tap = photo, hold = video, slide up while holding = zoom;
  - tap-to-focus, double-tap = flip, pinch = zoom, flash cycle;
  - zoom and focus driven from the UI thread through Reanimated shared values, with no React
    re-render per frame.
  
  expo-camera can't focus on Android and is coarser for live zoom.
- **One camera library only.** Two would mean two CameraX versions, and Gradle resolves to one (the
  higher), which is a silent risk. Use VisionCamera's barcode package for the pairing QR.
- **Spike first (half a day, on the traveler's phone or the same model):**
  - cold start to preview;
  - photo latency;
  - a 60 s 1080p30 recording while zooming;
  - front camera, low light, thermal;
  - run expo-camera's example on the same phone in the same session.
  
  If VisionCamera misbehaves on that device, fall back to expo-camera. Both are CameraX, so the UX code
  above the camera (gestures, haptics, layout) stays the same.
- Try forcing CameraX **1.7.0 stable** under VisionCamera (Gradle resolution strategy) in the spike.
  Keep it only if VisionCamera's API use compiles and works **(verify)**.
- Record high quality (1080p30 H.264 or HEVC, VisionCamera defaults). The WhatsApp-like final encode
  happens in the export step (§6), so capture settings don't need to match WhatsApp.
- Permissions: `CAMERA`, `RECORD_AUDIO` via `app.config.ts` `android.permissions` (VisionCamera needs no
  config plugin for Expo; [guide][vc-guide]).

---

## 5. Picking media from the gallery

**expo-image-picker 58.0.10** with `launchImageLibraryAsync({ mediaTypes: ['images','videos'],
allowsMultipleSelection: true, selectionLimit: 30, quality: 1, exif: false })`:
- **Uses the Android system Photo Picker.** The merged manifest declares the
  `photopicker_activity:0:required` Play-services backport and **no `READ_MEDIA_*` permissions**: only
  `CAMERA` and the legacy storage permissions capped at API 32 ([manifest][picker-manifest]). The
  changelog removed `READ_MEDIA_IMAGES/VIDEO` in v16 ([search summary][picker-search]).
- That keeps us clear of Google Play's **Photo and Video Permissions policy**. Since 2025-05-28, broad
  media access is only for apps whose core function needs it, with a Play Console declaration
  ([policy][play-photos]).
- Multi-select of photos and videos together. Returns `uri`, `width/height`, `duration` (ms),
  `mimeType`, `fileSize`, `assetId`.
- `allowsEditing` is ignored with multi-select. That's irrelevant: our editor does crop and rotate.
- Animated GIFs stay animated only with `quality: 1` and no editing ([docs][expo-picker]).
- **Copy every picked URI into the entry's outbox folder immediately.** The grant on a `content://`
  URI is not a durable reference across process death, and the outbox must be self-contained (§8).
- **EXIF location:** the Photo Picker redacts GPS by default, even with `ACCESS_MEDIA_LOCATION`
  ([issue 243294058][picker-gps-issue]). A user-controlled location toggle is rolling out in the picker
  ([Android Authority][picker-gps]). Don't build anything on EXIF GPS. WhatsApp statuses carry no
  location anyway. If we want a place hint, take an optional coarse `expo-location` fix at creation
  time, as private metadata.
- **Android 14+ partial access** (`READ_MEDIA_VISUAL_USER_SELECTED`) only matters once we use
  **expo-media-library** (58.0.14), which adds that permission to the manifest
  ([manifest][ml-manifest]; `accessPrivileges: 'limited'`, `presentPermissionsPicker()` on Android 14+
  ([docs][expo-ml])). **Not in v1.** Needed only for a WhatsApp-style "recent photos" strip in the
  camera or for "save to gallery". If added later, request `granularPermissions: ['photo','video']`
  and design for `limited`.
- The **embedded Photo Picker** (androidx `photopicker` 1.0.0-alpha02, callable on API 34+, Compose
  artifact needs AGP 9.2) would give an inline gallery without permissions
  ([release notes][photopicker-rel]). It's alpha; revisit in 2027 through the local module.
- **Share into the app** (from Gallery, Files, or another app's share sheet): `expo-sharing` 58 can now
  *receive* shares (`useIncomingShare`, Android intent filters for single and multiple MIME types), but
  the docs call it **experimental** ([docs][expo-sharing]). Alternative: `expo-share-intent` 9.0.0
  (peer `expo ^58`, last release 2026-10-21). Start with expo-sharing's receiver, since it's first-party,
  and fall back if it breaks.

---

## 6. Editor, export (the WhatsApp-equivalent baking), video and trimming

### 6.1 Skia: which line
| | `@shopify/react-native-skia` **2.14.0** | `react-native-skia` **3.10.2** |
|---|---|---|
| Status | The v2 line under the old scope stops at 2.14 (2026-10-01). v2 continues as `react-native-skia@2` (2.15.5, 2026-11-10) on the 2.x branch ([README][skia-readme]) | v3.0.0 on 2026-10-02, **35 releases in 7 weeks** ([npm][npm]) |
| Backend | Ganesh (OpenGL on Android), single-threaded; runs on every device | Graphite on **Vulkan 1.1 (required)**, multi-threaded. **minSdk 26.** Without Vulkan the canvas stays blank ([install][skia3-install]) |
| Expo | **Version recommended for SDK 58** ([Expo docs][expo-skia], `bundledNativeModules.json`) | Dev build only, not validated by Expo |
| APIs we need | `drawAsImage(element, size)`, `drawAsPicture`, `SkImage.encodeToBytes(ImageFormat.JPEG|PNG|WEBP, quality)` ([typings][skia2-offscreen]), Paragraph and fonts, `useVideo`, Reanimated shared values as props | Snapshot and encode async. **`useVideo`/`Skia.Video` removed** (moved to react-native-webgpu) ([migration][skia3-migration]) |
| Peers | react ≥ 19, RN ≥ 0.78, Reanimated ≥ 4, Worklets ≥ 0.7; no install scripts (binaries are npm deps) | Same plus the Dawn binaries |

**Recommendation:** `@shopify/react-native-skia@2.14.0` now.
- Move to `react-native-skia@2.15.x` (same native module, renamed) when Expo's recommended version moves
  or a v2 fix is needed. Don't install both.
- Re-evaluate v3 with SDK 59, once it has settled and Expo validates it. Graphite's speed doesn't matter
  for a one-frame export.
- `react-native-vision-camera-skia` declares a peer on `@shopify/react-native-skia`, which is consistent
  with staying on v2.

### 6.2 Editor features → stack
| Feature (WhatsApp status parity) | Implementation | Result on export |
|---|---|---|
| Text on media (font, colour, background pill, alignment) | Skia `Paragraph` with bundled TTFs plus system font fallback (colour emoji from the system font). Layer transform from RNGH 3 `usePanGesture`/`usePinchGesture`/`useRotationGesture` → Reanimated shared values → Skia `transform` | Pixels. The texts are also kept as **alt text** (additive, private or public as decided) |
| Drawing (pen sizes, colours) | RNGH pan → smoothed `SkPath` (quadratic smoothing on the UI thread via worklets) | Pixels |
| Emoji and stickers | Emoji: Paragraph glyphs at large size. Stickers: PNG/WebP `SkImage` layers | Pixels |
| Crop, rotate, flip | Skia matrix on the base layer (or `expo-image-manipulator` 58.0.16 for photo pre-scaling) | Pixels / video `Presentation` + crop |
| Filters | **Define every filter as one colour matrix.** Skia `ColorMatrix` for photos and the live preview; Media3 `RgbMatrix` (4×4) for video, from the same numbers, so photo and video look identical | Pixels |
| Caption | Plain `TextInput` (with `react-native-keyboard-controller` 1.22.7 for the keyboard-attached bar) | **Separate text field** (`caption`) |
| Text status (no media) | RN `Text` on a coloured background using the WhatsApp font substitutes (the same files the site uses, §10). Colour and font pickers with `Segment_Tick` haptics | **No pixels.** `{ body, bgArgb, textArgb, font }`, as in `InboxText` |
| Voice status | `expo-audio` 58.0.12 recorder: AAC in MPEG-4 (Android encoders: aac/he_aac/aac_eld; **no Opus** in its options ([docs][expo-audio])). `isMeteringEnabled` → our own 64-bucket peak array (0–100) like WhatsApp's `waveform` | Audio file + waveform. The WhatsApp path transcodes to Opus on the backend (ffmpeg) if needed |

Fonts: `@fontsource` ships woff2/woff only, and Android native needs **TTF/OTF** (expo-font embeds them
at build time; SDK 58 added variable-font support ([SDK 58][sdk58])). Build TTF subsets for
Fraunces, Nunito and Playpen Sans plus the WhatsApp substitutes (Calistoga, Exo 2, Courier Prime, …),
from the same upstream sources as `frontend/shared`, with the existing `scripts/fonts` (fonttools)
tooling. Put them in `frontend/app/assets/fonts/`.

### 6.3 Export pipeline (on device)
- **Photo:**
  1. Pre-scale the source to the export size (`expo-image-manipulator`, or Skia `MakeImageFromEncoded`
     + scaled draw). A 12 MP RGBA texture is about 48 MB, so don't keep full resolution in the editor.
  2. Render with `drawAsImage(<Group>base + layers</Group>, {width, height})` and encode with
     `encodeToBytes(ImageFormat.JPEG, q)`.
  3. Write the result with `expo-file-system` (`File.write` is **async** in 58), then sha256 it with
     `File.digest('SHA-256')`.
  
  Long edge and quality come from the WhatsApp research.
- **Video:**
  1. Skia renders **only the overlay layer** as a transparent PNG at the output resolution.
  2. The local Kotlin module runs **Media3 Transformer** on the source with:
     - `MediaItem.ClippingConfiguration` (trim);
     - `Presentation` (scale/crop);
     - `RgbMatrix` (filter);
     - `OverlayEffect(BitmapOverlay)` (the baked overlay);
     - output H.264 + AAC MP4 at WhatsApp-like settings.
  3. Progress events go to JS.
  
  Transformer documents trimming and overlays as built-ins ([Transformer][media3-transformer]). Media3
  1.8 added a fast trim-only path, `experimentalSetMp4EditListTrimEnabled`, useful when nothing else
  changes ([Media3 1.10][media3-110]).
- **Media3 version:** `expo-video` 58.0.14 compiles against **Media3 1.9.1** ([build.gradle][expovideo-gradle]),
  and all `androidx.media3:*` artifacts must share one version. So either pin `media3-transformer` and
  `media3-effect` to **1.9.1** (recommended first), or move everything to 1.11.1 (latest stable,
  2026-09-11) and re-test expo-video. 1.12.0-beta01 adds CodecDB encoder recommendations, worth a look
  later ([releases][media3-rel]).
- **Where it runs:** in the foreground while the "Sharing…" sheet shows progress, the way WhatsApp does
  it. If the user leaves the app mid-export, continue in a `mediaProcessing` foreground service
  (Android 15+, about 6 h budget ([data transfer options][dto])), or restart the export on return.
  Measure export time for a 60 s clip on the phone in the spike.
  **Assumption:** a few seconds to tens of seconds on a mid-range device.
- **Static overlays only in v1.** Media3 can do time-varying overlays (`BitmapOverlay`/`TextureOverlay`
  with per-timestamp bitmaps), but animated stickers depend on what WhatsApp itself supports (WhatsApp
  research).
- **Picked animated GIFs:** Media3 can't decode GIF. v1 uploads the GIF as is when there are no
  overlays; the backend already turns GIFs into muted looping MP4. With overlays, export the first frame
  as a photo or block overlays **(open question for the WhatsApp research)**.

### 6.4 Video playback and trimming UI
- **expo-video 58.0.14** for preview and trim:
  - `VideoView` + `useVideoPlayer`, `loop`, `muted`;
  - `scrubbingModeOptions` for drag-seeking (Android suppresses playback while scrubbing);
  - `generateThumbnailsAsync(times, {maxWidth})` for the filmstrip under the trim handles;
  - use `surfaceType="textureView"` when a Skia canvas overlays the video ([docs][expo-video]).
- **Trim on the device, not on the server.** The export re-encodes anyway to bake overlays, so trimming
  is free there. A server-side trim would:
  - upload the full original over hotel Wi-Fi;
  - depend on the backend being awake (the Mac at home);
  - break "what gets published is WhatsApp-equivalent and made on the phone".
- **ffmpeg-kit:** retired. The repo is **archived** (GitHub API: `archived: true`), and the prebuilt
  binaries were removed in 2025 ([retirement][ffmpegkit-retired]). Community forks exist, but bring
  16 KB-alignment, licensing (GPL/LGPL builds) and +20–60 MB size risks **(size: assumption)**. **Not
  used.** `react-native-compressor` 2.0.6 (active, 2026-11-02) could be a plain-transcode fallback; it
  can't bake overlays.

---

## 7. Motion, gestures and haptics

- **react-native-reanimated 4.7.1** (Expo 58 bundles it with `react-native-worklets` 0.13.0):
  - 4.8.0 (2026-11-19) needs worklets 0.14 and supports RN 0.87–0.89. Stay on the Expo-bundled pair
    until the next `expo install --fix`.
  - Reanimated 4 is New-Architecture only ([compatibility][rea-compat]).
  - Port the site's motion presets as numbers: soft 0.35 s / bounce 0.15, snappy 0.2 s, float 0.8 s
    (`frontend/shared/src/motion.ts`). Use `withSpring({ duration, dampingRatio })` and layout/entering
    animations with the same feel.
  - Respect reduced motion: `ReduceMotion.System` on animations plus `useReducedMotion()`, which also
    turns off the Ken Burns-style previews **(API names from the Reanimated docs; verify against 4.7)**.
- **react-native-gesture-handler 3.3.0** (Expo-bundled; 3.5.0 latest; 3.0.0 on 2026-05-28):
  - New hook API (`usePanGesture`, `usePinchGesture`, `useTapGesture`, `useRotationGesture`) and relation
    hooks (`useSimultaneousGestures`, `useExclusiveGestures`, `useCompetingGestures`).
  - `onStart/onEnd` → `onActivate/onDeactivate`; min RN 0.82.
  - Relations can't mix the hook API with the legacy API ([upgrade guide][rngh3]). So avoid third-party
    gesture components built on v2: `@gorhom/bottom-sheet` 5.2.14 was last released 2026-05-09, before
    RNGH 3. Build the 3–4 sheets we need (tool trays, colour picker, share sheet) with RNGH 3 +
    Reanimated, or use expo-router's `formSheet` presentation.
- **Haptics: expo-haptics 58.0.8.**
  - Verified in its Kotlin source ([HapticsModule.kt][haptics-src]):
    - `performAndroidHapticsAsync(type)` calls `View.performHapticFeedback(...)`;
    - `impactAsync`, `notificationAsync` and `selectionAsync` call `Vibrator.vibrate(createWaveform(...))`.
  - Android's guidance: `performHapticFeedback` honours the system `HAPTIC_FEEDBACK_ENABLED` setting and
    needs no `VIBRATE` permission. Raw `createWaveform`/one-shot vibrations are "often too loud" and
    discouraged. Since API 33, only privileged apps can ignore the user's touch-feedback setting
    ([haptics guide][android-haptics], [constants][haptic-constants]).
  - **Rule:** on Android use only `performAndroidHapticsAsync`, behind one facade
    (`ui/haptics.ts: haptic('capture'|...)`), plus an in-app "Haptics" switch. `impactAsync` stays
    iOS-only.

  | App event | `AndroidHaptics` constant | API level |
  |---|---|---|
  | Shutter (photo) | `Virtual_Key` | 5 |
  | Hold starts recording / stops | `Gesture_Start` / `Gesture_End` | 30 |
  | Pick up a sticker or text layer | `Drag_Start` (fallback `Long_Press`) | 34 / 3 |
  | Layer snaps to centre guide; colour, font or filter swatch steps; zoom detents (1×, 2×) | `Segment_Tick` | 34 |
  | Continuous slider (pen size, trim handle) | `Segment_Frequent_Tick` (meant to be very soft) | 34 |
  | Drag over the trash zone / back out | `Gesture_Threshold_Activate` / `_Deactivate` | 34 |
  | Flash, mute toggle | `Toggle_On` / `Toggle_Off` | 34 |
  | Entry queued / published | `Confirm` | 30 |
  | Upload failed, pairing rejected | `Reject` | 30 |

  On devices below a constant's API level, the facade falls back to the nearest older constant
  (`Clock_Tick` 21, `Context_Click` 23, `Long_Press` 3).
- **Optional later:** `react-native-pulsar` 1.7.0 (Software Mansion; presets, worklet-callable,
  realtime composer) for richer iOS haptics ([Pulsar][pulsar]). Not needed for Android v1.

---

## 8. Offline-first storage and the upload queue

### 8.1 Local storage
- **The durable truth is the outbox folder per entry**, the same pattern as the backend's
  `inbox/<msgId>/meta.json`:
  ```
  <documents>/outbox/<entryId>/manifest.json   # WhatsApp-shaped entry (zod-validated) + upload state
  <documents>/outbox/<entryId>/media.jpg|mp4|m4a
  <documents>/outbox/<entryId>/original.*       # optional, private (re-editing)
  <documents>/outbox/<entryId>/edit.json        # optional, private edit list (layers, crop, filter)
  ```
  Write it atomically (temp file → rename) with `expo-file-system` (`File`, `Directory`, `Paths`).
  An entry is "queued" once its folder is complete.
- **expo-sqlite 58.0.18** as a rebuildable **index** (list screens, search, status chips) plus
  `expo-sqlite/kv-store` for small preferences. Drizzle (`drizzle-orm` 0.45.4 supports expo-sqlite) is
  optional.
- **Not needed:** MMKV 4.3.2 (Nitro) and op-sqlite 19.0.5. They're faster, but they add native modules
  for a queue of a few hundred rows.
- **Don't open the same SQLite file from Kotlin and from expo-sqlite.** Two SQLite copies in one process
  can corrupt a database: one copy's `close()` silently drops the other's POSIX locks ([SQLite: how to
  corrupt §2.3][sqlite-corrupt]). The native uploader therefore reads the outbox *files* and writes its
  progress to `upload-state.json`, never to the SQLite index.

### 8.2 Transport: a hand-written tus 1.0 subset on the PHP API
- **Protocol:** tus 1.0.0 core + `creation` + `checksum` + `termination` ([spec][tus]):
  - `POST` (Upload-Length, Upload-Metadata with entryId, role, mime, sha256) → `201 Location`;
  - `HEAD` → `Upload-Offset` (`Cache-Control: no-store`);
  - `PATCH` with `Content-Type: application/offset+octet-stream` and `Upload-Offset`, optionally
    `Upload-Checksum: sha1 <b64>` → `204` with the new offset;
  - `409` on an offset mismatch, `460` on a checksum mismatch;
  - honour `X-HTTP-Method-Override` in case the host or its WAF blocks PATCH or DELETE.
- **Why tus and not our own format:** the same effort, standard semantics, and proven clients:
  - `tus-js-client` (v5 pre-releases, active);
  - `tus-java-client` 0.5.1 / `tus-android-client` 0.1.12 (repo active Nov 2026);
  - `TUSKit` 3.7.1 for iOS background sessions later.
- **Why not tus-php:** it's maintained (last push 2026-07, tag v2.4.0) but heavy for this host. It pulls
  Guzzle, Carbon, Predis, Symfony console/http-foundation/event-dispatcher/mime 6/7 and ramsey/uuid.
  Its state cache is Redis/APCu, or a file cache the README calls "not recommended for production"
  ([tus-php][tus-php]).
- **The PHP part:** about 250 lines in Slim on the existing SQLite (`uploads` table) and
  `var/uploads/<id>.part`.
- **Server rules sized for Hetzner shared hosting:**
  - **Chunk size adaptive, 1–8 MiB, aiming at ≤ 15 s per request.**
    - **Assumption (needs a host test):** Apache streams the request body to PHP-FPM, so a slow chunk
      holds one of only 2–10 workers.
    - Small chunks also keep each request far below the 50M cap and the 60 s limit.
  - Stream `php://input` → `fopen('c')`, `fseek(offset)`, `stream_copy_to_stream`, `fflush`, then
    update the offset in one `BEGIN IMMEDIATE` transaction. No file is ever held in PHP's 128 MB of
    memory.
  - On completion, verify the full sha256 from `Upload-Metadata` (`hash_file`), then mark it ready.
  - Per-entry `Tus-Max-Size`; per-device rate limit; **one upload in flight per device**.
  - Expire abandoned uploads in the existing cron (`Upload-Expires`, e.g. 7 days).
  - A route group `/api/v1/app/uploads` with its own `AppAuth` middleware (Bearer `app` token).
    It's outside `/admin` because of `RequireJsonBody`.
  - Watch the host disk quota (**assumption: unknown**). The backend pulls the media quickly
    (`GET /api/v1/backend/uploads/{id}` with `Range`), archives it, acks, and the API then deletes its
    copy and keeps only the private preview.
- **Entry submit:**
  - Once all of an entry's files are complete, the app sends `PUT /api/v1/app/entries/{sourceKey}` with
    an idempotent JSON body: the WhatsApp-shaped entry; `sourceKey = "app:<ulid>"`, which already
    matches the `SourceKey` regex.
  - The API appends to `change_log`, so the backend sees app entries in the same change feed.
  - **Assumption:** the data-model research confirms that app entries are "captures" with namespace
    `app` (backend-primary media, API-primary metadata).
- **Originals and edit lists** (the owner's "private original for re-editing") are optional roles of
  the same upload:
  - default "photos only, Wi-Fi only";
  - videos only when unmetered and charging;
  - a 60 s 4K original can be several hundred MB, a cost the host's disk and hotel Wi-Fi should not
    pay by default.

### 8.3 Client: two phases
1. **Phase A (MVP, development).** A small TS tus client in `@omw/app-core`, reading chunks with
   `expo-file-system` `File.open()` → `FileHandle.offset` / `readBytes(n)` and sending them with
   `expo/fetch`. Not `tus-js-client` in React Native: it reads the file via `fetch(uri).blob()`, which
   has failed above about 100 MB on Android ([tus-js-client #508][tus-508]).
   - It runs while the app is in the foreground: a "Sharing… 3 of 5" bar, `expo-keep-awake`.
   - **expo-background-task 58.0.13** retries when backgrounded. It's WorkManager under the hood:
     ≥ 15 min inexact interval, runs only with network and battery OK, stops after a user force-kill
     until the next app start ([docs][expo-bgtask]). It's a safety net, not a transport.
   - `expo-file-system`'s `sessionType: 'background'` is iOS-only; Android ignores it ([docs][expo-fs]).
2. **Phase B (before the traveler relies on it): a native uploader in the local module.**
   - On **Android 14+**, a **user-initiated data transfer (UIDT) job**: `JobInfo.setUserInitiated(true)`,
     `RUN_USER_INITIATED_JOBS`, a progress notification, `setEstimatedNetworkBytes`, `setPersisted`.
     Google recommends UIDT for "uploading a photo" started by the user. These jobs are exempt from
     standby-bucket quotas and are retried after system stops ([UIDT][uidt], [options][dto]).
   - On **API 29–33**, WorkManager expedited work plus a long-running worker with a `dataSync`
     foreground service.
   - HTTP through OkHttp (already in the RN app), the same tus subset; resume = `HEAD`, then continue.
   - Network request with `NET_CAPABILITY_VALIDATED`, so hotel captive portals don't burn retries.
     `NOT_METERED` only for originals.
   - Events stream to JS; the JS UI shows the same state either way.
   - **Rejected:** Vydia's `react-native-background-upload` (last push 2024-04); thewidlarzgroup's
     Background Uploader SDK (closed-source private tarball, own foreground service; licence unknown
     ([page][twg]).

---

## 9. Auth: app tokens, pairing, secure storage

**What exists:**
- `ApiTokens::KINDS = session|backend|app`; `app` always gets `["admin"]` and must belong to a user.
- Optional `expiresAt`; `last_used_at` is touched at most once a minute; admins revoke tokens in
  Settings (`DELETE /admin/tokens/{id}`).
- `AdminAuth` accepts `Bearer` tokens of kind `app` for every `/api/v1/admin/*` route, without CSRF.
- So an app token today is **full admin**: token management, settings and, in wave 5, follower
  revocation and deletion.

**Pairing by QR (new endpoints):**
1. The admin PWA (logged-in session) calls `POST /api/v1/admin/devices/pairings`. The API creates a
   one-time code: 128 bits, base32, stored as sha256, **TTL 5 min, single use**. The response carries
   the code and the QR payload `omw://pair?api=<API base URL>&c=<code>&v=1`.
2. The admin shows the QR (rendered client-side) plus a short manual fallback code.
3. The app scans it (VisionCamera barcode package) and calls `POST /api/v1/app/pair`
   `{ code, deviceName, platform, appVersion }`. This is unauthenticated and rate-limited like login.
   Consuming the code and creating the token happen in one transaction. The response is the
   `TokenCreated` shape (token shown once).
4. The token is named after the device (e.g. "Pixel 8a, traveler app"), so the existing token list
   doubles as the device list. Revoking it makes the app return to the pairing screen on the next 401.
5. Expiry: sliding, e.g. 180 days, extended on use like sessions **(suggestion)**.

**Narrow the token before wave 5 (decision for the owner and the API work).** Pick one:
- (a) a new scope `capture`, with an allow-list: app uploads and entries, reading own entries, days and
  settings read, timezone set;
- (b) keep `admin` but deny app tokens the token, pairing and (wave 5) follower-delete routes.

Either way it touches the `api_tokens` `CHECK` constraint, `TOKEN_KIND_SCOPES` and the exported schema.
A stolen, unlocked phone should not be able to delete followers or mint tokens.

**Storage:**
- **expo-secure-store 58.0.3:**
  - values encrypted with an Android Keystore key, in SharedPreferences;
  - the config plugin excludes them from Android backup;
  - lost on uninstall, which is fine: re-pair ([docs][expo-securestore]).
- **Don't** use `requireAuthentication` for the API token:
  - those keys are invalidated when a fingerprint or face is added, so the token is lost;
  - a background upload job can't show a biometric prompt.
- **Phase B:** the native uploader needs the token without JS, so the local module keeps the canonical
  copy, AES-GCM-wrapped with its own non-exportable Keystore key in `noBackupFilesDir`. JS reads it
  through the module. Never put the token into WorkManager input data or JobInfo extras: both are
  persisted outside our control.
- **Biometric app lock (optional setting):** `expo-local-authentication` 58.0.3 gates the UI on open and
  after N minutes in the background, with a device-credential fallback. It is deliberately *not* bound
  to the token key, so uploads keep running while the app is locked.

---

## 10. Monorepo integration

- **Location:** `frontend/app`, package `@omw/app`. The existing `frontend/*` glob picks it up with no
  workspace change, next to `site` and `admin`. The Kotlin module lives inside it (`modules/omw-native`).
- **pnpm 10.13.1, isolated `node-linker` (default):**
  - Supported since SDK 54; the hoisted linker is only a fallback ([monorepos][expo-monorepo]).
  - Autolinking's module resolution is automatic for monorepo apps since SDK 55.
  - `expo/metro-config` configures watch folders and module paths by itself. Don't hand-set
    `watchFolders`, `extraNodeModules` or `disableHierarchicalLookup`.
  - **Every native module must be a direct dependency of `@omw/app`**: Nitro peers, worklets, Skia,
    VisionCamera packages.
  - Checked: the main native packages have no install or postinstall scripts (Skia ships binaries as
    npm deps), so `onlyBuiltDependencies` stays as it is **(confirm on the first `pnpm install`)**.
- **React versions:**
  - RN 0.88.1 needs **React 19.3.0** exactly (Expo's table); the web apps use 19.3.1.
  - Isolated installs keep them apart. `pnpm why --depth=10 react-native` must show one copy.
  - Never import `@omw/ui` into the app: it's DOM, Tailwind and `motion/react`. Move the
    framework-free parts into a DOM-free subpath or a small `packages/tokens`:
    - palette hex values;
    - spring numbers;
    - `WA_FONTS` spec;
    - date and locale helpers.
- **`@omw/contracts` from source in Metro:**
  - Metro reads `exports` by default since 0.82 ([Metro config][metro-config]). Add `'@omw/source'` to
    `resolver.unstable_conditionNames`, keeping the `react-native` default.
  - The TS sources import siblings as `./common.js`, and Metro has no `.js`→`.ts` substitution
    ([metro#886][metro-886]). Add a ~15-line `resolveRequest` in `metro.config.ts`: for relative `.js`
    specifiers from `packages/*/src`, retry `.ts`. SDK 57+ loads `metro.config.ts` natively
    ([TS guide][expo-ts]).
  - `@stzhu/metro-ts-resolver` does this too, but its peer is TypeScript ≤ 6. The repo uses TS 7.0.2.
  - Alternative: consume the built `dist` (`default` condition), at the cost of a watch build.
- **TypeScript:**
  - `tsconfig.json` extends `expo/tsconfig.base`: `module: preserve`, `moduleResolution: bundler`,
    `customConditions: ["react-native"]`, no `baseUrl`, so it's TS 7-compatible on paper
    ([file][expo-tsbase]).
  - Add `"@omw/source"` to `customConditions` and copy the root's strict flags. Don't extend the root
    `tsconfig.base.json` (NodeNext).
  - Typecheck with the repo's TS 7.0.2 **(verify RN 0.88 typings under TS 7; Expo docs don't mention
    TS 7)**.
- **zod 4.6.7 on Hermes:** the schemas work. zod's JIT compiles validators with `new Function` and falls
  back when eval is unavailable ([z.compile][zod-compile]). Hermes supports global eval but compiles at
  runtime, so set `z.config({ jitless: true })` at app start and measure **(assumption)**.
- **Lingui 6.12.0:**
  - `@lingui/core` and `@lingui/react`, the Babel macro, and `@lingui/metro-transformer` (6.12.0) to
    compile `.po` on import ([Lingui RN][lingui-rn]).
  - `I18nProvider defaultComponent={Text}`.
  - Catalogs in `frontend/app/src/locales/{en,de,ar}/messages.po`, with `ar` as the dev-only pseudo-RTL
    locale like `site`/`admin`.
- **Intl on Hermes:**
  - Lingui's guide suggests `@formatjs/intl-locale` 5.5.0 and `@formatjs/intl-pluralrules` 7.1.0
    (`polyfill-force`). FormatJS lists PluralRules as native in current Hermes, so add them only if a
    runtime check fails **(verify)**.
  - Hermes lacks `Intl.DisplayNames`, which `countryName`/`languageName` use
    ([FormatJS][formatjs-hermes]). Polyfill it if those helpers come along.
- **RTL and locales:**
  - **RTL is on by default in SDK 58.** Test the pseudo-ar locale with `I18nManager.forceRTL` + reload.
    `expo-localization` 58.0.5 `supportedLocales` enables per-app language in Android settings
    ([localization][expo-l10n]).
  - Physical gesture directions get the site's `fwd = rtl ? -1 : 1` treatment.
- **Scripts:**
  - The root runs `pnpm -r build|test|typecheck`. Give `@omw/app` `typecheck`, `test`, `lint` (Biome),
    `i18n:extract`, `start`, `android`, `prebuild`, `release:android` and `e2e`.
  - **No `build` script**, so `pnpm -r build` stays web-only and never starts Gradle.
- **Development loop:**
  - Dev client on a USB or Wi-Fi-adb phone or an emulator.
  - API calls go to the local PHP API (`php -S 127.0.0.1:8080 -t public public/index.php`) through
    `adb reverse tcp:8080 tcp:8080`. That works around the host's IP block and keeps test traffic off
    the live hosts.

### Testing
| Layer | Tool (version) | What |
|---|---|---|
| Framework-free TS (`packages/app-core`) | **Vitest 5.1.1** (repo standard) | tus client against a fake server, outbox state machine, entry → contract mapping (`InboxText`/`InboxMedia`), haptics map, chunk-size adaptation |
| RN components | **jest-expo 58.0.15** + Jest 30.5.2 + @testing-library/react-native 14.1.0 | editor tool logic, pairing screen, queue screen, i18n (pseudo-ar) |
| PHP endpoints | PHPUnit (existing) | tus conformance: offset 409, replayed chunk, checksum 460, max size 413, expiry, method override, auth, idempotent entry PUT |
| End-to-end | **Maestro CLI 2.12.1** (installed on the Mac; Expo's recommended e2e tool for EAS Workflows ([e2e][expo-e2e])) on an emulator and the real phone | pair via a deep link, text status, photo with text overlay, offline → online upload, kill during upload → resume |
| Not chosen | Detox 20.51.3 (last release 2026-05-30) | Gray-box and stronger sync, but heavier setup; Maestro is enough for a handful of flows |

---

## 11. Push notifications (later: wave-5 reactions and messages)

- **expo-notifications 58.1.9.**
  - Android needs Firebase Cloud Messaging (FCM v1 credentials) ([setup][expo-push]).
  - SDK 58 shows foreground notifications by default (breaking) and adds `largeIcon` ([SDK 58][sdk58]).
  - Android 13+ needs the runtime `POST_NOTIFICATIONS` permission (platform rule).
  - Use one channel for "Reactions and messages" and a separate silent channel for upload progress
    (the native uploader).
- **Sending:**
  - **Option A:** Expo Push Service (`getExpoPushTokenAsync`). The PHP side just POSTs JSON. A third
    party (Expo) sees the payloads.
  - **Option B (preferred for privacy):** `getDevicePushTokenAsync` and direct **FCM HTTP v1** from PHP,
    signing an RS256 JWT with `openssl_sign` (available on shared hosting). Only Google is involved,
    which Android requires anyway.
  - Batch reaction pushes in the 5-minute cron rather than inside follower requests, to respect the tiny
    PHP worker pool.
  - Payloads carry counts and IDs only (D7: the traveler sees who reacted, inside the app after fetching).
- Not for v1. Pairing and uploads don't need push.

---

## 12. The optional WhatsApp path (stack view only)

- **Android share intent:** `expo-sharing` `shareAsync(fileUri, { mimeType })` opens the system share
  sheet. The traveler picks WhatsApp → "My status". Because the artifact is already flattened and
  WhatsApp-like, WhatsApp receives exactly what the site shows (it may re-encode).
- **Text statuses can't carry colour or font through an intent.** WhatsApp receives plain text, and the
  traveler would pick the style again **(verify in the WhatsApp research)**.
- **Backend posting with the traveler's number** (whatsmeow) is a backend concern. The app only needs a
  per-entry flag, "also post to WhatsApp", in the entry JSON.

---

## 13. Risks

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| VisionCamera v5 issues on the traveler's specific phone (young major, CameraX alpha) | medium / high | Spike on that device; expo-camera fallback; try CameraX 1.7.0 stable |
| Media3 export quality, speed or compatibility on a mid-range SoC (HDR sources, odd rotations, 10-bit HEVC from the camera) | medium / high | Spike with real camera files; force SDR tone-mapping; record H.264 in-app; CodecDB (1.12) later |
| Media3 version clash with expo-video | high if ignored / build or runtime errors | Pin all `androidx.media3:*` to expo-video's 1.9.1 |
| Apache/PHP-FPM holds a worker during slow chunk uploads; a WAF blocks PATCH | unknown / medium | Small adaptive chunks; one upload per device; `X-HTTP-Method-Override`; host test with the owner's OK |
| Host disk quota fills with originals | medium / medium | Originals optional and Wi-Fi-only; backend pulls and API deletes; alert on free disk (doctor already checks) |
| Skia v2 → v3 rename and churn | certain over 2027 / low | Stay on the Expo-validated v2; switch package names in one commit when Expo moves |
| App token = full admin | certain today / high in wave 5 | New scope or deny-list (§9); biometric lock; revocation |
| Play policy (photo permissions) | low with the Photo Picker / high if violated | No `READ_MEDIA_*`; review the merged manifest on every release |
| SDK yearly upgrade | certain / medium | Pin, `expo-doctor` in CI, upgrade between trips |
| Developer verification 2027 | certain / low via Play | Play internal testing (auto-registered) |

---

## 14. Recommended stack

| Area | Choice | Version (2026-11-20) | Maturity | Why | Main risk |
|---|---|---|---|---|---|
| Framework | Expo SDK (CNG, dev builds) | `expo` 58.0.26 | stable, SDK released 2026-10-15 | Config-plugin native setup, local modules, iOS later for free | Yearly SDK churn |
| Runtime | React Native, React, Hermes V1, New Arch | 0.88.1, 19.3.0 | stable | Required by SDK 58 | React differs from the web's 19.3.1 (isolated installs) |
| Navigation | expo-router | 58.0.32 | stable (58 core rework) | Deep links for pairing and share-in, native tabs | Migration notes for custom navigators |
| Android config | minSdk 29, targetSdk 36, compileSdk 37 (`expo-build-properties` 58.0.12) | – | – | Fewer legacy paths; meets the Play target rule | Traveler's phone must be ≥ Android 10 (confirm) |
| Camera | react-native-vision-camera (+ nitro-modules, nitro-image, barcode-scanner) | 5.2.4 (+ 0.37.2, 0.15.2, 5.2.4) | v5 since 2026-04; active | Focus, smooth zoom, hold-to-record UX, one lib for capture and QR | CameraX alpha pin; fallback expo-camera 58.0.14 |
| Gallery | expo-image-picker (system Photo Picker) | 58.0.10 | stable | No media permissions; multi-select of photos and videos | No inline recents strip (needs media-library or the embedded picker later) |
| Share-in / out | expo-sharing (receive: experimental) | 58.0.23 | send stable, receive experimental | First-party; send to WhatsApp via the share sheet | Fallback `expo-share-intent` 9.0.0 |
| Editor and photo export | @shopify/react-native-skia (v2, Ganesh) | 2.14.0 (→ `react-native-skia@2.15.x`) | stable, Expo-validated | Text, paths, matrices, `drawAsImage` + `encodeToBytes` | v3 Graphite transition in 2027 |
| Photo pre-scale | expo-image-manipulator | 58.0.16 | stable | Cheap resize/rotate before Skia | – |
| Video export (bake, trim, transcode) | Local Expo module (Kotlin) with Media3 Transformer + Effect | Media3 1.9.1 (aligned with expo-video) | stable | Hardware codecs, `OverlayEffect`, clipping, `RgbMatrix` | Device codec quirks; we own the Kotlin |
| Video playback, filmstrip | expo-video | 58.0.14 | stable | Scrubbing mode, thumbnails, ExoPlayer inside | `textureView` needed under overlays |
| Voice | expo-audio (recorder + metering) | 58.0.12 | stable | AAC m4a + our waveform | No Opus on device (backend transcodes for WhatsApp) |
| Fonts | expo-font (TTF embedded) | 58.0.12 | stable | Same faces as the site, variable fonts in 58 | TTF subsets must be built (scripts/fonts) |
| Animation | react-native-reanimated + react-native-worklets | 4.7.1 + 0.13.0 | stable | UI-thread springs, layout animations, reduced motion | Hermes V1 + worklets regressions (watch patch notes) |
| Gestures | react-native-gesture-handler (hook API) | 3.3.0 | v3 since 2026-05 | Pinch, rotate and pan composition for layers | Third-party v2-based components |
| Keyboard | react-native-keyboard-controller | 1.22.7 | stable | Caption bar above the keyboard | – |
| Haptics | expo-haptics, `performAndroidHapticsAsync` only | 58.0.8 | stable | `View.performHapticFeedback`, respects the touch-feedback setting, no `VIBRATE` | Constants ≥ API 34 need fallbacks |
| Local DB | expo-sqlite (+ kv-store) | 58.0.18 | stable | Index and drafts; first-party | Never shared with Kotlin (§8.1) |
| Files | expo-file-system (`File`, `FileHandle`, `digest`) | 58.0.14 | stable | Chunk reads, sha256, atomic outbox | `File.write` async in 58 |
| Upload protocol | tus 1.0 subset (core, creation, checksum, termination), hand-written in Slim | spec 1.0.0 | spec stable | Resumable, 1–8 MiB chunks fit 50 MB / 60 s / few workers | Host buffering behaviour (test) |
| Upload client A | Own TS tus client + expo-background-task (WorkManager) | 58.0.13 | stable | Works in weeks; testable with Vitest | Background resumes are slow (≥ 15 min) |
| Upload client B | Native uploader: UIDT job (API 34+) / WorkManager FGS fallback, OkHttp | Android platform API | stable APIs | Survives app kills and reboots, progress notification | Our Kotlin to maintain |
| Network state | expo-network | 58.0.5 | stable | Online/metered hints for the UI | Native uploader decides authoritatively |
| Auth storage | expo-secure-store (phase A) → Keystore vault in the local module (phase B) | 58.0.3 | stable | Keystore-backed, excluded from backup | No `requireAuthentication` for the token |
| App lock | expo-local-authentication | 58.0.3 | stable | Optional biometric gate | – |
| Pairing | Admin-minted one-time code → `app` token, QR scanned in-app | new API endpoints | – | Existing token kind, revocable in Settings | Scope too wide until §9 is done |
| Contracts | @omw/contracts (zod) from source via the `@omw/source` Metro condition | zod 4.6.7 | stable | One schema for app, API (JSON Schema) and backend | `.js`→`.ts` resolver shim |
| i18n | Lingui (+ metro transformer), expo-localization | 6.12.0, 58.0.5 | stable | Same toolchain as site and admin; RTL default in SDK 58 | Intl gaps in Hermes (DisplayNames) |
| Unit tests | Vitest (framework-free) / jest-expo + RNTL | 5.1.1 / 58.0.15 + 14.1.0 | stable | Repo standard plus the RN standard | Two runners |
| E2E | Maestro CLI | 2.12.1 | stable | Simple YAML flows, already on the Mac | Device farm later if needed |
| Builds | Local Gradle (Android); EAS Build free tier (iOS later) | eas-cli 27.11.0 | stable | No Docker, no cloud for Android | JDK not on PATH yet |
| Distribution | Play Console internal testing; adb APK fallback | – | – | Updates anywhere, covers 2027 verification | US$25 + identity verification |
| Push (later) | expo-notifications + FCM HTTP v1 from PHP | 58.1.9 | stable | No extra third party beyond Google | Firebase project needed |
| Not used | ffmpeg-kit (archived), tus-php (heavy), MMKV/op-sqlite (unneeded), expo-media-library (v1), `@gorhom/bottom-sheet` (pre-RNGH 3), Skia v3 (too young), expo-camera (fallback only) | – | – | – | – |

---

## 15. Project layout in the monorepo

```
the-on-my-way-website/
├─ pnpm-workspace.yaml                 unchanged globs (packages/*, backend, frontend/*)
├─ packages/
│  ├─ contracts/src/app.ts             NEW: AppPairRequest/Response, AppEntry (WhatsApp-shaped: kind, caption,
│  │                                   text = InboxText, media = InboxMedia, occurredAt, tz, alt?, flags),
│  │                                   UploadMetadata (tus), exported to api/schemas like the rest
│  ├─ app-core/                        NEW (optional, recommended): framework-free TS, Vitest
│  │  └─ src/ tus-client.ts · outbox-state.ts · entry-mapping.ts · chunking.ts · haptics-map.ts
│  └─ tokens/                          NEW (or a DOM-free @omw/ui subpath): palette, springs, WA font spec
├─ frontend/
│  ├─ site/ · admin/ · shared/         unchanged (admin gains the "Pair a phone" QR screen)
│  └─ app/                             NEW @omw/app (Expo SDK 58, Android first)
│     ├─ app.config.ts                 id, plugins: expo-build-properties (minSdk 29), expo-localization
│     │                                (supportedLocales), expo-font, expo-sharing (receive), expo-audio,
│     │                                permissions (CAMERA, RECORD_AUDIO, RUN_USER_INITIATED_JOBS, …)
│     ├─ eas.json                      development (dev client APK) · preview (APK) · production (AAB)
│     ├─ metro.config.ts               expo/metro-config + '@omw/source' + .js→.ts fallback + .cache/metro
│     ├─ babel.config.js · lingui.config.ts · tsconfig.json · jest.config.ts
│     ├─ src/
│     │  ├─ app/                       expo-router: (tabs)/capture · (tabs)/journal · (tabs)/settings ·
│     │  │                             editor/[draftId] · text-status · voice · entry/[id] · pair · +native-intent.ts
│     │  ├─ capture/                   VisionCamera screen, hold-to-record, zoom/focus gestures
│     │  ├─ editor/                    Skia scene, layers (text, draw, sticker), crop, filters, export
│     │  ├─ media/                     photo export (Skia), video export (native module), filter matrices
│     │  ├─ outbox/                    folders + manifest (zod), expo-sqlite index, queue UI state
│     │  ├─ sync/                      API client (contracts), pairing, phase-A uploader glue
│     │  ├─ ui/                        tokens, springs, haptics facade, sheets, buttons
│     │  └─ locales/{en,de,ar}/messages.po
│     ├─ modules/omw-native/           local Expo module
│     │  ├─ android/src/main/java/…    MediaExport.kt (Media3) · UploadJobService.kt (UIDT) ·
│     │  │                             UploadWorker.kt (WorkManager fallback) · TusClient.kt (OkHttp) · TokenVault.kt
│     │  ├─ ios/                       later
│     │  ├─ src/index.ts               typed API + events
│     │  └─ expo-module.config.json
│     ├─ assets/fonts/                 TTF subsets (built by scripts/fonts)
│     ├─ .maestro/                     pair.yaml · photo-text.yaml · text-status.yaml · offline-resume.yaml
│     └─ package.json                  start · android · prebuild · release:android · typecheck · test · e2e · i18n:extract
├─ api/
│  ├─ src/Http/App/                    NEW: PairController · UploadController (tus subset) · EntryController
│  ├─ src/Http/Middleware/AppAuth.php  NEW: Bearer app token, scope check, rate limits
│  ├─ src/Http/Admin/DeviceController  NEW: create pairing code (admin session)
│  ├─ migrations/0002_app.sql          NEW: pairing_codes, uploads, (scope change for app tokens)
│  └─ var/uploads/                     NEW, git-ignored: *.part files
└─ backend/src/sync/                   pulls app entries + media (Range GET), archives, acks
```

Generated and ignored: `frontend/app/android/` and `ios/` (CNG, git-ignored), `.cache/gradle`,
`.cache/metro`.

### Suggested first spikes (before committing to the plan)
1. Expo 58 skeleton in `frontend/app`, dev build on a phone, `@omw/contracts` imported through the
   Metro condition, Lingui de/en/pseudo-ar, `pnpm -r typecheck` green with TS 7.
2. Camera on the traveler's phone model: VisionCamera vs expo-camera (§4).
3. Skia: 1080×1920 photo + text, emoji and drawing → JPEG via `drawAsImage`; time and memory.
4. Media3: a 60 s phone video + PNG overlay + trim → H.264/AAC MP4; time, size, thermal.
5. tus subset in the local PHP API + the TS client: kill the app mid-upload, toggle airplane mode,
   resume. Only then a host test on Hetzner (worker holding, PATCH through Apache/WAF), with the owner's
   go-ahead. This research made no requests to the live hosts.

---

## 16. Open questions and assumptions

- **Traveler's phone:** model, Android version, Vulkan, free storage. Decides minSdk 29, the camera
  choice and export settings.
- **Host behaviour:** does Apache stream request bodies to PHP-FPM (worker held), is there a wall-clock
  limit, does a WAF filter PATCH or `application/offset+octet-stream`, and what is the disk quota?
- **App token scope** (§9): a new `capture` scope or an admin deny-list. Owner and API decision.
- **Originals:** keep them at all? Photos only? Videos only on Wi-Fi and while charging?
- **Alt text from overlays:** public (published as `alt`, additive) or private only?
- From the WhatsApp research: JPEG long edge and quality, video caps (resolution, bitrate, max length),
  the overlay font set, GIF handling, voice codec, what a share intent carries.
- Whether JDK, Android Studio and an emulator image may be installed or updated on the Mac (global
  tools, outside the repo).

---

## Sources (accessed 2026-11-20)

[sdk58]: https://expo.dev/changelog/sdk-58
[sdk57]: https://expo.dev/changelog/sdk-57
[expo-versions]: https://docs.expo.dev/versions/latest/
[npm]: https://registry.npmjs.org/ "npm registry dist-tags and publish times, queried 2026-11-20"
[bundled]: https://unpkg.com/expo@58.0.26/bundledNativeModules.json
[play-target]: https://developer.android.com/google/play/requirements/target-sdk
[pagesize]: https://developer.android.com/guide/practices/page-sizes
[eas-local]: https://docs.expo.dev/build-reference/local-builds/
[eas-pricing]: https://expo.dev/pricing
[play-internal]: https://support.google.com/googleplay/android-developer/answer/9845334
[devverif]: https://developer.android.com/blog/posts/android-developer-verification-rolling-out-to-all-developers-on-play-console-and-android-developer-console
[apple-enroll]: https://developer.apple.com/programs/enroll/
[testflight]: https://developer.apple.com/testflight/
[vc5]: https://margelo.com/blog/whats-new-in-visioncamera-v5
[vc-releases]: https://github.com/margelo/react-native-vision-camera/releases
[vc-guide]: https://visioncamera.margelo.com/docs/guides
[vc-gradle]: https://unpkg.com/react-native-vision-camera@5.2.4/android/build.gradle
[expo-camera]: https://docs.expo.dev/versions/latest/sdk/camera/
[expocam-gradle]: https://unpkg.com/expo-camera@58.0.14/android/build.gradle
[expo-picker]: https://docs.expo.dev/versions/latest/sdk/imagepicker/
[picker-manifest]: https://unpkg.com/expo-image-picker@58.0.10/android/src/main/AndroidManifest.xml
[picker-search]: https://unpkg.com/expo-image-picker@16.0.5/CHANGELOG.md
[ml-manifest]: https://unpkg.com/expo-media-library@58.0.14/android/src/main/AndroidManifest.xml
[expo-ml]: https://docs.expo.dev/versions/latest/sdk/media-library/
[play-photos]: https://support.google.com/googleplay/android-developer/answer/14115180
[picker-gps-issue]: https://issuetracker.google.com/issues/243294058
[picker-gps]: https://www.androidauthority.com/android-photo-picker-location-3683074/
[photopicker-rel]: https://developer.android.com/jetpack/androidx/releases/photopicker
[expo-sharing]: https://docs.expo.dev/versions/latest/sdk/sharing/
[skia-readme]: https://github.com/Shopify/react-native-skia
[skia-releases]: https://github.com/Shopify/react-native-skia/releases
[skia3-install]: https://wcandillon.github.io/react-native-skia/docs/getting-started/installation
[skia3-migration]: https://wcandillon.github.io/react-native-skia/docs/getting-started/migration
[expo-skia]: https://docs.expo.dev/versions/v58.0.0/sdk/skia/
[skia2-offscreen]: https://unpkg.com/@shopify/react-native-skia@2.14.0/lib/typescript/src/renderer/Offscreen.d.ts
[expo-audio]: https://docs.expo.dev/versions/latest/sdk/audio/
[media3-transformer]: https://developer.android.com/media/media3/transformer
[media3-110]: https://android-developers.googleblog.com/2026/03/media3-110-is-out.html
[media3-rel]: https://github.com/androidx/media/releases
[expovideo-gradle]: https://unpkg.com/expo-video@58.0.14/android/build.gradle
[dto]: https://developer.android.com/develop/background-work/background-tasks/data-transfer-options
[expo-video]: https://docs.expo.dev/versions/latest/sdk/video/
[ffmpegkit-retired]: https://dev.to/lucquebec/ffmpegkit-is-retired-heres-how-to-fix-your-android-build-ndk-r26c-patch-35j0
[ffmpegkit-repo]: https://github.com/arthenica/ffmpeg-kit
[rea-compat]: https://docs.swmansion.com/react-native-reanimated/docs/guides/compatibility/
[rngh3]: https://docs.swmansion.com/react-native-gesture-handler/docs/guides/upgrading-to-3/
[rngh-changelog]: https://swmansion.com/changelog/react-native-gesture-handler/
[expo-haptics]: https://docs.expo.dev/versions/latest/sdk/haptics/
[haptics-src]: https://unpkg.com/expo-haptics@58.0.8/android/src/main/java/expo/modules/haptics/HapticsModule.kt
[android-haptics]: https://developer.android.com/develop/ui/views/haptics/haptic-feedback
[haptic-constants]: https://developer.android.com/reference/android/view/HapticFeedbackConstants
[pulsar]: https://docs.swmansion.com/pulsar/sdk/react-native/
[sqlite-corrupt]: https://www.sqlite.org/howtocorrupt.html
[tus]: https://tus.io/protocols/resumable-upload
[tus-php]: https://github.com/ankitpokhrel/tus-php
[tus-508]: https://www.github.com/tus/tus-js-client/issues/508
[expo-bgtask]: https://docs.expo.dev/versions/latest/sdk/background-task/
[expo-fs]: https://docs.expo.dev/versions/latest/sdk/filesystem/
[uidt]: https://developer.android.com/develop/background-work/background-tasks/uidt
[twg]: https://sdk.thewidlarzgroup.com/background-uploader
[expo-securestore]: https://docs.expo.dev/versions/latest/sdk/securestore/
[expo-monorepo]: https://docs.expo.dev/guides/monorepos/
[metro-config]: https://metrobundler.dev/docs/configuration/
[metro-886]: https://github.com/facebook/metro/issues/886
[expo-ts]: https://docs.expo.dev/guides/typescript/
[expo-tsbase]: https://unpkg.com/expo@58.0.26/tsconfig.base.json
[zod-compile]: https://zod.dev/blog/introducing-z-compile
[lingui-rn]: https://lingui.dev/tutorials/react-native
[formatjs-hermes]: https://formatjs.github.io/docs/guides/react-native-hermes
[expo-l10n]: https://docs.expo.dev/guides/localization/
[expo-e2e]: https://docs.expo.dev/eas/workflows/examples/e2e-tests/
[expo-push]: https://docs.expo.dev/push-notifications/push-notifications-setup/
[expo-modules]: https://docs.expo.dev/modules/get-started/

- Expo: [SDK 58][sdk58], [SDK 57][sdk57], [versions table][expo-versions],
  [bundledNativeModules.json 58.0.26][bundled], [monorepos][expo-monorepo], [Metro][metro-config],
  [TypeScript][expo-ts], [tsconfig.base][expo-tsbase], [local builds][eas-local], [pricing][eas-pricing],
  [local modules][expo-modules], [e2e with Maestro][expo-e2e], [push setup][expo-push],
  [localization/RTL][expo-l10n]
- Expo modules: [camera][expo-camera] ([gradle][expocam-gradle]), [image picker][expo-picker]
  ([manifest][picker-manifest], [v16 changelog][picker-search]), [media library][expo-ml]
  ([manifest][ml-manifest]), [sharing][expo-sharing], [video][expo-video]
  ([gradle][expovideo-gradle]), [audio][expo-audio], [haptics][expo-haptics] ([source][haptics-src]),
  [background task][expo-bgtask], [file system][expo-fs], [secure store][expo-securestore],
  [Skia page][expo-skia]
- VisionCamera: [v5 blog][vc5], [releases][vc-releases], [guide][vc-guide], [gradle][vc-gradle]
- Skia: [README][skia-readme], [releases][skia-releases], [v3 install][skia3-install],
  [v3 migration][skia3-migration], [v2 Offscreen typings][skia2-offscreen]
- Media3 and ffmpeg-kit: [Transformer][media3-transformer], [Media3 1.10][media3-110],
  [releases][media3-rel], [ffmpeg-kit retired][ffmpegkit-retired], [ffmpeg-kit repo (archived)][ffmpegkit-repo]
- Software Mansion: [Reanimated compatibility][rea-compat], [Gesture Handler 3 upgrade][rngh3],
  [changelog][rngh-changelog], [Pulsar][pulsar]
- Android platform: [haptic feedback][android-haptics], [HapticFeedbackConstants][haptic-constants],
  [UIDT jobs][uidt], [data transfer options][dto], [16 KB pages][pagesize], [target API][play-target],
  [Photo Picker releases][photopicker-rel], [picker GPS issue][picker-gps-issue],
  [picker GPS toggle][picker-gps]
- Google Play and Apple: [photo/video permissions policy][play-photos], [internal testing][play-internal],
  [developer verification][devverif], [Apple enrollment][apple-enroll], [TestFlight][testflight]
- Uploads and storage: [tus 1.0][tus], [tus-php][tus-php], [tus-js-client #508][tus-508],
  [TWG Background Uploader][twg], [SQLite corruption §2.3][sqlite-corrupt]
- Tooling: [Metro configuration][metro-config], [metro#886][metro-886], [zod z.compile][zod-compile],
  [Lingui RN][lingui-rn], [FormatJS on Hermes][formatjs-hermes]
- Versions not linked individually come from the [npm registry][npm] and the GitHub API, both queried
  on 2026-11-20: VisionCamera 5.2.4; Reanimated 4.8.0; RNGH 3.5.0; Maestro cli-2.12.1; Detox 20.51.3;
  tus clients; ffmpeg-kit `archived: true`.
