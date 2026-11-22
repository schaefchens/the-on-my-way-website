# End-to-end log: traveler app v0.5, archive-only (emulator)

`scripts/app/e2e.sh`, 2026-11-22 10:59–11:16 UTC, after the review fixes (R1–R11): **26 of 26 checks
passed** (17 min). It adds step 9b (Undo after the API has it, edit, Share again) to the 24 checks
of the earlier run. The first run after the fixes had all other checks green but failed the new
re-share check (it looked for the exact edited text, which Maestro's cursor placement changes) and
then stopped in step 10 on a script race; both are fixed in the script, and this is the clean run.

- **Build:** release APK `omw-traveler-0.5.0-20261122-149fb33-dirty-468650-emulator.apk` (R8, signed
  with the upload key, API `http://127.0.0.1:8080` on the phone; expo-camera built from source
  without ML Kit).
- **Device:** our emulator `omw-app` (API 36, arm64, AOSP userdebug), virtual camera, silent
  microphone.
- **Stack:** local only. The PHP API ran on `php -S 127.0.0.1:18080` with a fresh state. The bad
  link was `e2e-proxy.mjs` on 18090, reached through `adb reverse`. The backend ran in fixture
  mode with `APP_PUBLISH=false` and one local target. No live host and no WhatsApp were contacted.
- **Run folder:** `.cache/app-e2e/20261122T105901Z/` (git-ignored): `e2e.log`, `proxy.jsonl` (every
  request), `archive-check.txt`, `phone-sha256.txt`, the logs and the screenshots `shots/e2e-0*.png`
  (`e2e-07-undone-draft.png`: the draft back on Today after Undo).

```
10:59:01 run 20261122T105901Z: APK .cache/app-release/omw-traveler-0.5.0-20261122-149fb33-dirty-468650-emulator.apk, emulator emulator-5580, 9 GB free
10:59:07 PASS  install — fresh install of omw-traveler-0.5.0-20261122-149fb33-dirty-468650-emulator.apk, adb reverse 8080 -> proxy -> API
10:59:45 PASS  pair — admin code typed in the app; app_phones: 1 (scope capture)
11:02:59 PASS  capture — photo (virtual camera), text status, voice note, trimmed + muted video shared on mobile data
11:03:29 PASS  wifi-only holds mobile data — 0 upload requests, 0 entries on the API after 30+ s on mobile data
11:03:42 PASS  queue: waiting for Wi-Fi — the queue sheet says "Waiting for Wi-Fi"
11:03:42       the phone's outbox holds 6 files (hashes in phone-sha256.txt)
11:06:02 PASS  slow link: progress — 64 kbit/s + 300 ms + a drop every 1 MB: 8 PATCHes (7 ok, 1 cut by a drop), 879977 bytes on the server after 134 s
11:06:02 PASS  slow link: chunks shrink — chunk size of non-tail PATCHes 262144 first, 262144 latest, 262144 smallest (the contract starts at 1 MiB; floor 256 KiB; aim <= 15 s per PATCH)
11:06:04 PASS  kill — kill -9 of the app (pid 17477) while u_7KoT5h4gspWBHR3xyqGfKw was at 262144 of 1140659 bytes
11:07:47 PASS  resume after kill — resumed by itself, without opening the app; first PATCH for u_7KoT5h4gspWBHR3xyqGfKw at Upload-Offset 262144 (server had 262144 before the kill, not 0)
11:08:35 PASS  airplane mode — 0 upload requests reached the link in 40 s of airplane mode
11:09:04 PASS  resume after airplane mode — first PATCH for u_7KoT5h4gspWBHR3xyqGfKw at Upload-Offset 524288 (server had 524288)
11:09:54 PASS  wifi-only mid-upload — no request started in 40 s on mobile data with Wi-Fi only on (0); the PATCH in flight ended 29 s after Wi-Fi went off (client_aborted)
11:10:35 PASS  resume on Wi-Fi — first PATCH for u_7KoT5h4gspWBHR3xyqGfKw at Upload-Offset 524288 (server had 524288)
11:10:40 PASS  all uploaded — 4 of 4 entries uploaded, 0 upload slots still open, 2 originals committed
11:12:01 PASS  queue: uploaded — the queue says "Uploaded" while the home computer is off
11:12:47 PASS  manual: waits — "Upload automatically" off: the new text status says "Ready to upload"
11:13:17 PASS  manual: nothing sent — 0 upload requests in 30+ s while it waits for the tap
11:13:40 PASS  manual: Upload now — after "Upload now": 5 of 5 entries uploaded; automatic mode is on again
11:14:27 PASS  undo after upload — the typo reached the API (01M81FCYBR6T300QTQ183AGMW1) and Undo brought back the draft; the uploader withdrew it: 1 DELETE answered 204, state withdrawn
11:14:27 PASS  share again: new id — the edited status ("Arrived in Hoi Ann Hoi An") went out as 01M81FD56GDFR770ARWS5M97ZB (uploaded), not as 01M81FCYBR6T300QTQ183AGMW1; entry_conflict answers: 0
11:14:43 PASS  archived — 6 of 6 entries archived by the home backend, 6 s after it started; the undone typo in the archive: 0 files
11:14:43 PASS  inbox freed — 0 payload files left in the API's app inbox, usedBytes 0 (admin); upload slots: archived:6
11:14:48 PASS  archive: sha256 + originals — 6 records {'photo': 1, 'text': 3, 'voice': 1, 'video': 1} ; problems: none
      photo media        22172 B  sha256 3e77513fb06ca417…  declared=archive=yes  phone=yes
      photo original     28242 B  sha256 2004faa66f466695…  declared=archive=yes  phone=yes
      photo preview       7945 B  sha256 a5848805d8970987…  declared=archive=yes  phone=yes
      voice media       116378 B  sha256 037ade9cfa8cedef…  declared=archive=yes  phone=yes
      video media       443096 B  sha256 054de524bc663254…  declared=archive=yes  phone=yes
      video original   1140659 B  sha256 db2b053dc0c95c60…  declared=archive=yes  phone=yes
      video: media 0.97 s (1280,720,), original 38.97 s, audio streams in media: none
11:14:50 PASS  nothing published — 0 of 13 app ids/publicIds in the published site (140 files, 14 pages from the WhatsApp fixtures); leaks: 0; app captures in the home store: 6
11:16:12 PASS  app: all safe — the queue is empty, "Safe at home today", the pill says "All safe"
11:16:13 PASS  request budget — 45 requests in the run; at most 7 in any 10 s window (limit 10)
         16  PATCH /api/v1/app/uploads/*
          7  POST /api/v1/app/entries
          6  GET /api/v1/app/hints
          6  HEAD /api/v1/app/uploads/*
          5  POST /api/v1/app/entries/*/commit
          3  GET /api/v1/app/entries
          1  POST /api/v1/app/pair
          1  DELETE /api/v1/app/entries/01M81FCYBR6T300QTQ183AGMW1
11:16:13 result: 26 passed, 0 failed — .cache/app-e2e/20261122T105901Z/summary.md
11:16:13 cleanup
```

## What the checks show

- **Wi-Fi only (default)** held all four moments on mobile data. Not even the entry was created,
  and the queue said "Waiting for Wi-Fi".
- **Bad link (64 kbit/s, 300 ms delay, a drop every 1 MB):** the uploads kept going. After a drop,
  one `HEAD` found the server's offset and the upload continued from there. The chunk size stayed
  at the 256 KiB floor, because the sizer had measured the slow link on the first small files.
- **`kill -9` mid-upload:** the system restarted the upload by itself within about a minute,
  without opening the app. It continued at the server's offset (262144), not at 0.
- **Airplane mode:** no request reached the link for 40 s. Afterwards the upload resumed at the
  offset.
- **Wi-Fi off mid-upload:** no request was started on mobile data. The PATCH that was already in
  flight was cut by the app; with Wi-Fi back, the upload resumed at the offset.
- **Manual mode:** a new moment waited as "Ready to upload", with nothing sent, until
  "Upload now".
- **Undo after the API had it (new, review R2/R4):** a text status went up at once; "Undo" 3 s
  later brought the draft back, and the native uploader withdrew the entry on the API (one
  `DELETE`, 204, 7 s after its create; durable, paced, no JS budget involved). The edited status
  went out under a **new id** (`201`, no `entry_conflict`) and was archived; the undone one never
  reached the archive. (Maestro's tap put the cursor mid-text, so the edit kept part of the old
  text; the check looks for the new text in it.)
- **Home backend:** it archived all 6 entries 6 s after it started. Every archived file, originals
  included (Q2 c), has the sha256 the phone declared, and it is the phone's own file (hashed on the
  phone before upload). The video was trimmed from 39.0 s to 1.0 s, has no audio track and is
  1280×720. The API inbox ended empty (0 bytes), and the app said "All safe".
- **Nothing published:** none of the app ids or publicIds appear in the generated or published
  site. That site holds 14 pages built from the WhatsApp fixtures.
- **Request budget:** 45 requests in the whole run, and at most 7 in any 10 s window (the limit is
  10).

## Bugs found and fixed with the review (2026-11-22)

- **A moment the home computer refused flipped back to "Uploaded".** Every return to the app
  replays the uploader's job statuses, and the path that brings back a failed entry an older
  build had marked as failed took the finished job's "uploaded" for a resume. The queue never
  said "Needs you" for a server rejection. Fix: `uploaderResumed()` never resumes an entry the
  server refused (jest test; seen fixed on the emulator, `.cache/shots/app/review-fix/`).
- **The e2e script could stop silently in step 10:** under `pipefail`, `find` over the API's inbox
  fails when the backend's ack deletes a file meanwhile. Now never fatal.

## Bugs found and fixed while building this run

- **The queue showed the wrong reason after a Wi-Fi loss.** A run stopped by losing Wi-Fi kept the
  `no_network` reason it saw in the gap between networks. On mobile data the queue therefore said
  "Waiting for network" instead of "Waiting for Wi-Fi". This also made one instrumented test flaky
  (1 of 2 runs failed). Fix: the bridge now listens to the default network and re-evaluates the
  statuses (`UploadScheduler.onNetworkChanged`). The test then passed 4 times in a row.
- **The release manifest carried `SYSTEM_ALERT_WINDOW`** from the template, a permission Play
  flags. It is now blocked, and `check-artifact.py` fails on it.
