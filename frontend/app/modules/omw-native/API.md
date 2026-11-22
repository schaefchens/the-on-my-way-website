# omw-native: the app's local Expo module

The contract between the native work (Kotlin) and the UI work (TypeScript). The UI imports only
`modules/omw-native` (`index.ts`); the Kotlin side implements the five Expo modules below. Change
this file together with the code, and keep every change additive for the other side.

Status (native core of v0.5, 2026-11-21):

| Area | JS API | Kotlin | Status |
|---|---|---|---|
| TokenVault | `get/set/clear` | `OmwTokenVaultModule` + `TokenVault` (Keystore AES-GCM) | **done** (instrumented test) |
| Haptics | `haptic(constant)` + switch, throttle, suppression | `OmwHapticsModule` + `HapticMap` | **done** (JVM test) |
| Network | `getState()`, `addListener()` | `OmwNetworkModule` + `NetworkProbe` | **done** |
| Uploader settings | `getSettings()`, `setSettings()` | `UploadSettingsStore` (SharedPreferences) | **done** |
| Uploader | `configure`, `enqueue/cancel/withdraw/uploadNow/status`, 2 events | `OmwUploaderModule`, `UploadEngine`, `TusClient`, `UploadScheduler`, `UploadJobService` (UIDT), `UploadWorker` | **done** (JVM tests with MockWebServer + instrumented tests) |
| MediaExport | `exportVideo/exportPhoto/cancel`, progress event | `OmwMediaExportModule`, `VideoExporter` (Media3 1.9.1), `PhotoExporter`, `MediaExportService` | **done** (instrumented tests); `overlayPngUri` comes with v0.6 |

Without the native side (Vitest, web, Expo Go) every function has a defined fallback, listed per
function below; `isNativeAvailable()` tells the UI which world it is in. Wire formats (entries,
upload slots, error codes, limits) come from `@omw/contracts/app` (`packages/contracts/src/app.ts`).

```ts
import {
  TokenVault, MediaExport, Uploader, Network,
  haptic, setHapticsEnabled, hapticsEnabled, suppressHaptics,
  isNativeAvailable, NativeUnavailableError, uploadEntryStatus, uploadPercent,
  type UploadSettings, type UploadJob, type UploadStatus, type UploadOriginalStatus,
  type NetworkState, type HapticConstant, type ExportResult, type ExportErrorCode,
} from '../../modules/omw-native';
```

## TokenVault (`OmwTokenVault`)

| Function | Resolves | Without native |
|---|---|---|
| `TokenVault.get()` | `string \| null` (null = not paired, or the Keystore key is gone, e.g. after a device restore) | `null` |
| `TokenVault.set(token)` | `void`; JS rejects anything but `omw_` + 43 chars with `RangeError` | rejects `NativeUnavailableError` |
| `TokenVault.clear()` | `void` | no-op |

- The token comes from `POST /api/v1/app/pair` (`AppPairResponse`, scope `capture` only).
- Storage: AES-256-GCM with a non-exportable Android Keystore key (`omw.token-vault.v1`), the
  sealed bytes in `noBackupFilesDir/omw-token.vault` (never in a backup), written atomically.
  Format: version byte | 12-byte IV | ciphertext + tag. No user authentication is bound to the key:
  background uploads can't show a prompt, and a new fingerprint must not destroy the token.
  `allowBackup` is off for the whole app. A damaged file or a lost key reads as "not paired".
- The native uploader reads the same vault (`TokenVault(context).get()`); the token never goes
  into WorkManager data, JobInfo extras, logs or JS storage, only into the `Authorization` header.
- `set` and `clear` reschedule the uploader: jobs that waited as `unauthorized` go on with a new
  token (a refused token is remembered by its sha256 only).
- On `401 token_revoked` the app calls `clear()`, wipes server data and keeps the outbox.

## Haptics (`OmwHaptics`)

`haptic(constant: HapticConstant, now?: number): Promise<boolean>`: resolves true when Android
played it. It uses `View.performHapticFeedback` on the current window, so the system "Touch
feedback" setting applies and no `VIBRATE` permission exists (it is blocked in `app.config.ts`).

Constants (`HAPTIC_CONSTANTS`): `VIRTUAL_KEY`, `LONG_PRESS`, `KEYBOARD_TAP`, `CLOCK_TICK`,
`CONTEXT_CLICK`, `CONFIRM`, `REJECT`, `GESTURE_START`, `GESTURE_END`,
`GESTURE_THRESHOLD_ACTIVATE`, `GESTURE_THRESHOLD_DEACTIVATE`, `SEGMENT_TICK`,
`SEGMENT_FREQUENT_TICK`, `DRAG_START`, `TOGGLE_ON`, `TOGGLE_OFF`. Below their API level they fall
back to the nearest older constant (`HapticMap.kt`): the API 34 ones (`GESTURE_THRESHOLD_*`,
`SEGMENT_*`, `DRAG_START`, `TOGGLE_*`) → `CONTEXT_CLICK` / `CLOCK_TICK` / `LONG_PRESS`; the API 30
ones (`CONFIRM`, `REJECT`, `GESTURE_START/END`) → `CONTEXT_CLICK` / `LONG_PRESS` / `CLOCK_TICK` on 29.

Rules built into the JS facade (app-plan §5.3):
- at most one effect per 100 ms (`HAPTIC_MIN_INTERVAL_MS`);
- `setHapticsEnabled(false)` is the in-app switch (Settings › Vibration feedback);
- `const end = suppressHaptics()` silences everything while recording (nested; call `end()`);
- errors (unknown constant, no activity) resolve `false`, never throw.

The UI decides *when*: only for her own touches (map in app-plan §5.3), never for background
events. `src/ui/press.tsx` (`<Press feedback="VIRTUAL_KEY">`) is the usual entry point.

## Network (`OmwNetwork`)

| Function | Resolves | Without native |
|---|---|---|
| `Network.getState()` | `NetworkState` | `OFFLINE` |
| `Network.addListener(fn)` | `Subscription`; `fn(state)` on every change of the default network | no-op subscription |

```ts
interface NetworkState {
  connected: boolean;      // default network with INTERNET
  validated: boolean;      // NET_CAPABILITY_VALIDATED (no captive portal)
  unmetered: boolean;      // NOT_METERED: A4's "Wi-Fi"; hotspots / metered Wi-Fi are false
  roaming: boolean;        // no NOT_ROAMING capability
  transport: 'wifi' | 'cellular' | 'ethernet' | 'vpn' | 'other' | 'none';
  simOperator: string | null;      // MCC+MNC of the default data SIM (per-SIM roaming answer)
  simOperatorName: string | null;  // carrier name, e.g. "Viettel"
}
```

For UI hints only: the uploader evaluates the same facts natively and decides on its own.

## Uploader (`OmwUploader`)

### Configuration

| Function | Resolves | Without native |
|---|---|---|
| `Uploader.configure({ apiBaseUrl })` | `void`; rejects anything but `https://…` or `http://127.0.0.1…`/`localhost` (the latter only where the build allows cleartext) | rejects `NativeUnavailableError` |

The API base comes from the build (`extra.apiBaseUrl`), never from a pairing link. Calling
`configure` is **optional**: without it the uploader reads the same `extra.apiBaseUrl` from the
app config that expo-constants embeds in the APK (`assets/app.config`), with the same checks. A
value set by `configure` wins (stored in SharedPreferences `omw.upload-config`). No valid base =
jobs wait as `failed` + `blockedBy: 'unauthorized'` (error code `not_configured`).

### Settings

| Function | Resolves | Without native |
|---|---|---|
| `Uploader.getSettings()` | `UploadSettings` | `DEFAULT_UPLOAD_SETTINGS` |
| `Uploader.setSettings(patch)` | the full stored `UploadSettings`; unknown keys or wrong types reject | rejects `NativeUnavailableError` |

```ts
interface UploadSettings {
  mode: 'auto' | 'manual';   // default 'auto'
  wifiOnly: boolean;         // default true  (Q6 c: Wi-Fi only for everything)
  photosOnMobileData: boolean; // default false (A4's finer option: photos/text/voice on mobile data)
  roaming: boolean;          // default false (A4 "also while roaming")
  roamingAllowedSims: string[]; // MCC+MNC codes she allowed ("Allow on this SIM"), default []
}
```

Stored in SharedPreferences `omw.upload-settings` so the uploader reads them without JS. Every
change reschedules (a new rule may free or hold waiting jobs).

### Jobs

| Function | Resolves | Without native |
|---|---|---|
| `Uploader.enqueue(job: UploadJob)` | `void` once the job is durable; idempotent per `entryId` (below) | rejects `NativeUnavailableError` |
| `Uploader.cancel(entryId)` | `boolean` (false = unknown); stops a request in flight; no withdrawal | `false` |
| `Uploader.withdraw(entryId)` | `boolean`: a `DELETE` is owed (below); durable once resolved | rejects `NativeUnavailableError` |
| `Uploader.uploadNow({ entryId?, allowMetered? })` | number of jobs affected | `0` |
| `Uploader.status(entryId?)` | `UploadStatus[]` (one job or all) | `[]` |
| `Uploader.addProgressListener(fn)` | `Subscription`, `fn({ entryId, role, sentBytes, totalBytes })` after every chunk | no-op |
| `Uploader.addStateListener(fn)` | `Subscription`, `fn(UploadStatus)` when state, `blockedBy` or error change | no-op |

```ts
interface UploadJob {
  entryId: string;                 // the ULID of the entry
  entry: AppEntry;                 // @omw/contracts/app, exactly as POST /app/entries sends it
  files: { role: 'media' | 'preview' | 'original'; uri: string /* file:// in the outbox */ }[];
  mode?: 'auto' | 'manual';        // per-entry override from the publish sheet
}
interface UploadStatus {
  entryId: string;
  state: 'queued' | 'waiting' | 'uploading' | 'committing' | 'uploaded' | 'failed' | 'cancelled';
  sentBytes: number; totalBytes: number;      // media + preview (the artifact)
  blockedBy: null | 'manual' | 'no_network' | 'not_validated' | 'wifi_only' | 'roaming'
           | 'backoff' | 'server_busy' | 'inbox_full' | 'unauthorized';
  error: null | { code: string; message: string; permanent: boolean };
  updatedAt: string;               // ISO UTC
  original: null | UploadOriginalStatus;      // the private original's own line (Q2 c)
}
interface UploadOriginalStatus {
  state: 'queued' | 'waiting' | 'uploading' | 'uploaded' | 'failed';
  blockedBy: UploadStatus['blockedBy']; sentBytes: number; totalBytes: number;
  error: UploadStatus['error'];
}
```

`enqueue` validates the job (ULID, `entry.entryId === entryId`, roles, `file://` URIs, every
declared file exists with the declared size) and writes it to
`noBackupFilesDir/omw-uploads/<entryId>.json` (atomic; a file lock guards it across threads and
processes). `null` members of `entry` count as absent (AppEntry has no nullable field). The **same
entry again** (e.g. the outbox replaying its effects at app start) keeps the job as it is, status
included, even when its files are already gone; only a changed `mode` is applied while it has
not started. **"Try again"**: the same entry again for a job that `failed` for good restarts it
(the failure and its counters are cleared; after `not_found`, `gone`, `rejected`, `forbidden`,
`entry_conflict` or `protocol` it is created again from scratch, otherwise it asks for the offsets
first), so an enqueue is never a silent no-op. A **changed entry** under the same id starts over
(the API answers `entry_conflict` if it already had the old one → `failed`, permanent): the API
keeps an id's first content for good, also once withdrawn, so **the app sends a moment that goes
out again with other content, or after a permanent refusal, under a new id** and withdraws the
old one (outbox `wireId`, review R1/R2). An id that was withdrawn is refused (`IllegalStateException`).

`withdraw(entryId)` (Undo, Remove): forgets the job (aborting its request in flight) and records
the withdrawal in `noBackupFilesDir/omw-withdrawals/<entryId>.json`. A `DELETE
/api/v1/app/entries/{entryId}` is owed unless the job provably never reached the API (no create was
ever sent; the job keeps `createSent` from before the first create, so a create whose answer was
lost counts); without a job (never enqueued, or pruned) it is owed too and a `404` ends it. The
engine sends owed withdrawals **before any upload**, whatever the upload mode and `wifiOnly`, but
not while roaming unless allowed, and paced, backed off and retried like every request until the
API answers `204`, `404` or `410` (another `4xx`, e.g. `403` for another phone's entry, ends it too).
The record also refuses a later `enqueue` of the id (an enqueue racing the Undo can never upload
the undone moment); answered records are pruned after 7 days. Idempotent.

What one run does (`UploadEngine`, app-plan §6.2, owner decisions A4, Q2 c, Q6 c):
- one request at a time: owed withdrawals first; then per job, oldest first, `POST
  /api/v1/app/entries` (`AppEntryCreate`, `clientNow` = send time) → `PATCH` chunks (`APP_TUS`,
  `Upload-Checksum: sha256 <b64>`) → `POST …/commit` for `media` (+ `preview`) → the `original`
  the same way with its own commit, later and only on unmetered networks. **Media and previews
  of every job go before any original** (A5: the WhatsApp-sized version first): an original's
  next chunk is only sent while no job's media, preview or create can go, so an older video's
  original never holds back a newer moment (review R5). `HEAD` only after a failure (a PATCH
  without an answer, a 409 without an offset, an `incomplete` commit), never before every chunk;
- adaptive chunks inside the server's bounds: start 1 MiB, aim for ≤ 15 s per PATCH, at most
  double after a success, halve after any failure, 256 KiB–8 MiB in 64 KiB steps (`ChunkSizer`
  mirrors `nextChunkBytes`; vectors in `fixtures/vectors/app-chunks.json`); a 413 lowers that
  entry's maximum;
- `APP_REQUEST_BUDGET`: at most 10 requests per 10 s across all jobs and runs, ≥ 200 ms apart,
  persisted (a crash loop can't burst). Any error pauses the whole host: exponential backoff from
  2 s to 15 min with equal jitter, a longer `Retry-After` always wins; "Upload now" skips our own
  backoff but never the server's `Retry-After`; a 409 with an offset continues at once. The waits
  are wall-clock deadlines kept with the time they were set: when the clock goes back (she changes
  it while travelling, network time corrects it), a running wait is rebased to its own length
  from now and an expired one is forgotten, so a clock jump never stretches a wait (review R7);
- A4 rules (`UploadRules`) before every request: unmetered = Wi-Fi (a hotspot or metered Wi-Fi
  counts as mobile data); `wifiOnly` blocks metered networks except photos/text/voice with
  `photosOnMobileData` and entries released with `uploadNow({allowMetered:true})`; originals only
  ever on unmetered networks; on a metered network while roaming, uploads wait unless `roaming` or
  the data SIM is in `roamingAllowedSims`; without `NET_CAPABILITY_VALIDATED` nothing is sent
  (the run polls for a minute, then retries in 5 minutes);
- the token from `TokenVault`; `401` → every job `failed` + `blockedBy: 'unauthorized'`
  (`token_revoked` or `unauthorized`), kept until a new token is set. Pairing the same install
  again (`AppPairRequest.installId`) gives the new token this install's entries on the API, so the
  jobs continue where they stopped: same slots, same offsets (review R3);
- permanent failures (`failed`, `error.permanent`): `file_missing`, `file_changed`,
  `file_unreadable`, `entry_conflict` and other 4xx refusals, `sha256_mismatch` three times,
  `not_found` (slot lost four times), `gone` (withdrawn), `rejected`, `protocol`. A failure of the
  original only fails the `original` line; the entry stays `uploaded`;
- an original the API's inbox can't take (`413 upload_too_large` on create with
  `error.details.role = 'original'`, see `AppHints.fileMaxBytes`): the entry is created again
  **without** it, so the moment is not held up; the original stays on the phone and its line says
  `failed` / `upload_too_large`. A too-large media file fails the entry as usual (`needs_you`).

Scheduling (`UploadScheduler`):
- **API 34+:** one user-initiated data transfer (UIDT) job, scheduled while the app is visible
  (Share, "Upload now", settings, every app open): persisted (survives a reboot), with the network
  constraint of the A4 rules (`NOT_METERED` / `NOT_ROAMING` / any, VPNs allowed),
  `setEstimatedNetworkBytes`, and the silent progress notification Android requires ("Uploads"
  channel; one segment per moment on Android 16). When the system stops it (network lost), the
  request in flight is cancelled and the job is rescheduled. Follow-ups a finished run schedules
  from the background become WorkManager work (a UIDT can't be scheduled from there).
- **API 29–33:** a WorkManager worker with the same network constraint, ~9 minutes per run, then
  re-enqueued. No foreground service from the background (`ForegroundServiceStartNotAllowedException`
  on Android 12+).
- **Network lost mid-run** (she leaves the café Wi-Fi): the run stops before the next request
  (or the system stops the job). When the rest still needs the network the UIDT job was
  scheduled with (its `omw.need` extra), the job is kept (`jobFinished(params, true)` / `onStopJob`
  → true) **and** a WorkManager follow-up with the same constraint is enqueued beside it, since
  JobScheduler may not start a rescheduled UIDT while the app is in the background. Whichever
  starts first continues from the offset; the other finds the run busy. Otherwise a new job with
  the new constraint is scheduled. A stop by her in the Task Manager (`STOP_REASON_USER`) gets no
  follow-up: that waits until she opens the app.
- **Backup:** every UIDT job gets a WorkManager backup with the same network constraint, due 15
  minutes later (`UploadScheduler.backupDelayMs`). It uploads only when no run is active (one
  process, one run); while a long UIDT run is active it finds it busy and re-arms itself; a
  finished queue cancels both.
- **Process death** (low memory, an OEM killer, a crash) and **reboot**: JobScheduler and
  WorkManager bring the run back without opening the app; it resumes from the stored offset (a
  PATCH that was in flight is checked with one `HEAD`). JobScheduler reschedules a UIDT whose
  process died at once, but on the API 36 emulator it did not start it again for minutes; the
  WorkManager backup covers that. JobScheduler writes a persisted job to disk about 2 s after it
  was scheduled: a reboot within those seconds loses the UIDT job, and the WorkManager backup
  (kept in WorkManager's own database, rescheduled at boot) or the next app open takes over.
- **Force-stop** (Settings › Force stop, the Task Manager, or a swipe-away that some OEMs turn
  into a force-stop): Android removes every scheduled job of the app and delivers nothing to it
  until she opens the app again. **Uploads then resume only when she opens the app**: the bridge
  reconciles at creation and on every return to the foreground (`OnActivityEntersForeground`),
  and continues from the stored offsets, not from 0. This is a platform rule, not a bug; the OEM
  card in Settings explains it.
- A run that waits (backoff, budget, captive portal) is nudged when something changes (enqueue,
  "Upload now", settings, token) and looks again at once.
- **Network changes while the app is alive:** the bridge listens to the default network and, 1 s
  after the A4 facts changed (connected, validated, unmetered, roaming, data SIM), calls
  `UploadScheduler.onNetworkChanged`: an active run re-reads the queue, otherwise the waiting
  jobs' statuses are evaluated for the network she is on now (nothing is scheduled). Without it,
  a run stopped by losing Wi-Fi kept the reason it saw in the gap between networks
  (`no_network`) while she was already on mobile data.

`blockedBy`/`state` map onto the status vocabulary `APP_ENTRY_STATUSES` of `@omw/contracts/app`
(`uploadEntryStatus()` in `src/status.ts`): `manual` → `ready`,
`no_network`/`not_validated`/`backoff`/`server_busy`/`inbox_full` → `waiting_network`,
`wifi_only` → `waiting_wifi`, `roaming` → `waiting_roaming`, `queued`/`uploading`/`committing` →
`uploading`, `uploaded` → `uploaded` (then the server's `AppEntryState` decides `archived`,
`live`, …), `failed` → `needs_you`.

## MediaExport (`OmwMediaExport`)

| Function | Resolves | Without native |
|---|---|---|
| `MediaExport.exportVideo(req: VideoExportRequest)` | `ExportResult` | rejects `NativeUnavailableError` |
| `MediaExport.exportPhoto(req: PhotoExportRequest)` | `ExportResult` | rejects `NativeUnavailableError` |
| `MediaExport.cancel(jobId)` | `boolean` (false = unknown or finished) | `false` |
| `MediaExport.addProgressListener(fn)` | `Subscription`, `fn({ jobId, progress: 0..1 })` (≤ 4/s; photos send one `1`) | no-op |

```ts
interface VideoExportRequest {
  jobId: string; sourceUri: string /* content:// or file:// */; outputUri: string /* file:// in app storage */;
  trimStartMs?: number; trimEndMs?: number; mute?: boolean;
  maxLongSide?: number /* 1920 */; maxFps?: number /* 30 */; overlayPngUri?: string /* v0.6 */;
}
interface PhotoExportRequest {
  jobId: string; sourceUri: string; outputUri: string;
  maxLongSide?: number /* 2880 */; maxShortSide?: number /* 1600 */; quality?: number /* 0.9 */;
}
interface ExportResult {
  jobId: string; uri: string; mimetype: 'image/jpeg' | 'video/mp4';
  bytes: number; sha256Hex: string; width: number; height: number; durationMs?: number;
}
```

- **Video** (`VideoExporter`): Media3 Transformer + Effect **1.9.1** for every `androidx.media3`
  artifact (expo-video 58's version). Always re-encoded (a requested bitrate, ~0.1 bit/pixel/frame,
  1.5–8 Mbit/s): H.264 + AAC in MP4, SDR (HDR → SDR tone mapping with OpenGL, the decoder's own
  tone mapping as the fallback on API 31+), long side ≤ 1920 (`Presentation`), ≤ 30 fps
  (`FrameDropEffect`), trim by `ClippingConfiguration` (never an edit list) and at most 60 s from
  the start, `setRemoveAudio` for mute. The `InAppMp4Muxer.Factory(MetadataProvider)` keeps only
  `Mp4OrientationData`: no `©xyz` location, XMP, capture dates or `mdta` keys. Width and height of
  the result are the displayed (rotated) size.
- **Photo** (`PhotoExporter`): decoded pre-scaled (power-of-two sample size), EXIF orientation
  baked into the pixels, fitted inside 2880 × 1600 (never upscaled), sRGB, transparency on white,
  JPEG q90 by default, written by `Bitmap.compress`: no EXIF, XMP, GPS or gain map at all.
- Both write to a temp file and rename it into place (no half files), and return the file's
  sha256 for `AppFile`. Outputs must be `file://` inside the app's own storage.
- Exports run one at a time. A video export runs inside the foreground service
  `MediaExportService` (type `mediaProcessing` on API 35+, `dataSync` on 29–34) with a silent
  "Preparing" notification; start it at Share, while the app is visible (Android refuses it from
  the background; the export then still runs, just without that protection). On API 35+ the
  service's `onTimeout` cancels the export (`ERR_CANCELLED`).

## Errors

Kotlin throws `CodedException`s or rejects with a code; JS sees `error.code`:

| Code | Where |
|---|---|
| `ERR_UNKNOWN_HAPTIC` | `OmwHaptics.perform` with an unknown name (the facade resolves `false`) |
| `ERR_INVALID_REQUEST` | MediaExport: missing/invalid field (`EXPORT_ERROR_CODES`) |
| `ERR_INVALID_SOURCE` / `ERR_UNSUPPORTED_SOURCE` | MediaExport: source not `content://`/`file://`, unreadable, no video track |
| `ERR_INVALID_OUTPUT` | MediaExport: output not a `file://` inside the app's storage |
| `ERR_INVALID_TRIM` | MediaExport: empty trim range |
| `ERR_EXPORT_FAILED` | MediaExport: Transformer or encoder failure, timeout (20 min), write error |
| `ERR_CANCELLED` | MediaExport: `cancel(jobId)` or the service's timeout |
| `ERR_NOT_IMPLEMENTED` | MediaExport: `overlayPngUri` (v0.6) |
| `ERR_NATIVE_UNAVAILABLE` | JS: the native module is not linked (`NativeUnavailableError`) |
| `ERR_REACT_CONTEXT_LOST` | any module while the app shuts down |
| other (`IllegalArgumentException` → `ERR_UNEXPECTED`…) | invalid settings patch, job or API base |

Upload problems never reject: they are `UploadStatus.error` (codes above, or the API's
`APP_ERROR_CODES`).

## Layout and tests

```
modules/omw-native/
  index.ts                  the only import path for the UI
  src/*.ts                  typed wrappers + fallbacks (Vitest: frontend/app/test/omw-native.test.ts)
  expo-module.config.json   the five Kotlin modules (autolinked from frontend/app/modules)
  android/build.gradle      the Expo library (namespace app.omw.omwnative); deps in omw-native.gradle
  android/omw-native.gradle Media3 1.9.1, OkHttp 4.12.0, WorkManager 2.11.2, test setup (shared)
  android/src/main/java     plain Android: uploader, media export, token vault, haptics map
  android/src/expo/java     the five Expo bridges (the only files that import expo.*)
  android/src/test          JVM unit tests (MockWebServer: chunking, resume, budget, network rules)
  android/src/androidTest   instrumented tests (emulator): metadata, kill + resume, svc wifi/data
  android/src/sharedTest    FakeTusServer (the contract's API in memory) and test helpers
  android/harness/          builds src/main without React Native for both test kinds
```

```sh
# JVM unit tests (no emulator, ~15 s)
frontend/app/modules/omw-native/android/harness/gradle.sh :core:testDebugUnitTest
# instrumented tests on our emulator (holds the shared emulator lock; flips Wi-Fi/mobile data);
# `am instrument` directly, so Gradle's UTP artifacts are not needed; optional [Class[#method]]
scripts/app/with-emulator.sh -- frontend/app/modules/omw-native/android/harness/instrument.sh
# reboot check: a waiting UIDT job survives `adb reboot` and uploads by itself afterwards
scripts/app/with-emulator.sh -- frontend/app/modules/omw-native/android/harness/reboot-check.sh
# the bridges compile only inside the app build (after expo prebuild)
(cd frontend/app/android && ./gradlew :omw-native:compileDebugKotlin)
```

The instrumented tests need a working internet connection on the host (Android only marks a
network `VALIDATED` after its connectivity check) and UiAutomation for `svc wifi|data` (the
scripts stop a leftover Maestro driver, which holds it). They run the upload job service in its
own process (androidTest manifest) so a test can kill it mid-upload.

Both scripts first wait up to 60 s for a validated Wi-Fi network on the emulator
(`harness/emulator-net.sh`) and stop with exit 3 and a hint otherwise. After a network outage on
the host, the emulator's Wi-Fi (served by `netsimd`) stayed "connected" without an IP address;
rebooting the guest did not help, restarting the emulator and `netsimd` did
(`scripts/app/with-emulator.sh --stop`, `pkill -x netsimd` while no emulator runs, run again).

## Changes to this contract (additive)

- 2026-11-22 (review fixes): `Uploader.withdraw(entryId)` (durable withdrawals, sent first;
  `omw-withdrawals/`); the same entry again restarts a job that failed for good; a withdrawn id is
  refused by `enqueue`; media and previews of every job before any original; throttle deadlines
  survive a clock jump; the create sets `transfer.createSent` first.

- 2026-11-22 (integration): statuses follow network changes while the app is alive
  (`UploadScheduler.onNetworkChanged`, called by the bridge); no JS API change.
- 2026-11-21 (native core): `Uploader.configure` (optional; embedded `app.config` fallback),
  `UploadStatus.original` (`UploadOriginalStatus`), `EXPORT_ERROR_CODES` / `ExportErrorCode`, the
  types `UploaderConfig`, `UploadJobFile`, `UploadProgressEvent`, `UploadNowOptions`; re-enqueue
  of the same entry keeps the whole job; `null` members of an entry count as absent; an original
  refused with 413 at create is left on the phone (`original.error.code = 'upload_too_large'`).
