# Critique of the traveler-app plan (`app-plan.md`)

Skeptical review, 2026-11-20. Read-only on the repo. No live host was contacted, and `.env` and
`.secrets/` were not opened. Only this file was written.

**How the claims were checked**
- I read `app-plan.md`, the owner decisions (A1–A5 here, D1–D12 in `../design-w5/`), the relevant
  parts of the four research notes, and the wave-5 proposal sections the plan depends on.
- Repo code the critique relies on, all read today:
  - `packages/contracts/src/policy.ts` and `wa.ts`;
  - `frontend/site/src/player/{items.ts,slides.tsx}`;
  - `frontend/shared/src/{fonts.ts,styles/theme.css}`;
  - `backend/src/pipeline/{video.ts,voice.ts}`;
  - `api/migrations/0001_init.sql` and `api/src/Http/Middleware/AdminAuth.php`;
  - `docs/HOSTING.md` and `docs/PLAN.md`.
- **Media3 behaviour:** I read the source at tag **1.9.1** (the version expo-video 58 builds
  against) on GitHub (`SampleExporter`, `MuxerWrapper`, `InAppMp4Muxer`). I also checked that
  `FrameDropEffect` exists at tags 1.1.0 and 1.9.1.
- **Other version and platform facts** are web-checked today and cited in §6.

Labels: **[verified]** = checked in code or a cited source today. **[A]** = assumption, with the
check that settles it.

---

## 0. Verdict

**Keep the architecture.** Its core decisions are right:
- An app entry is a new capture source `app:<ULID>`.
- The API is only a transit inbox. The backend archive is the durable home.
- The pipeline, policy and renderer are the same for both sources. There is no layer model.
- Uploads use a hand-written tus subset.
- Time = Share, and the entry has no coordinate field.

It follows the owner's "stay WhatsApp status compatible" closely, and §9 resolves the notes'
disagreements sensibly.

**But it is not ready to build as written.**
1. **It ships too late.** About 24 dev-weeks pass before she can use it while travelling, and
   the "7–8 calendar weeks in parallel" figure assumes two people. A v0.5 of about 10–11 dev-weeks
   (§2) can reach her phone first. An archive-only mode lets her use it before wave-5 P1b.
2. **One safety hole (verified in code).** The proposed `capture` scope may write any
   annotation. In `policy.ts` an annotation `public` overrides everything, so a stolen phone could
   publish what the owner hid, and even statuses she deleted on WhatsApp.
3. **Two wave-5 gaps.**
   - The daily place chip becomes an input to the departure hold, and day trips release held days
     early.
   - Text baked into pixels escapes the auto-hold, although the app knows those words.
4. **The upload and background design.**
   - Fixed 4/8 MiB chunks with whole-chunk checksums can stall forever on bad links.
   - Two claims are wrong on Android: resuming after a force-stop, and a WorkManager foreground
     service started from the background.
   - The default "nothing while roaming" blocks travel eSIMs.
5. **Styling claims overreach.**
   - WYSIWYG is impossible for 3 of the 8 fonts.
   - The site crops and Ken-Burns photos beyond the planned safe area.
   - The alt chain drops the baked words as soon as the owner writes a description.
   - Media3 copies the source's GPS into the "metadata-free" artifact by default (verified in
     source).
6. **Two pieces of work are unnecessary.** The Media3 1.11.1-vs-1.9.1 decision and the Opus
   recorder module can both go.

---

## 1. Findings, most severe first

Severity:
- **Critical** breaks an owner requirement or a stated safety claim, and I verified it.
- **High** is a likely real-world failure or harm.
- **Medium** is a weakening or a wrong claim with a safety net behind it.
- **Low** is polish or a scope trim.

### C1. The `capture` scope can publish anything, including hidden and deleted statuses

**Problem.** The plan gives the app token, on a phone that may be stolen, the power to override
every publish rule:
- **§3.5 and Q4 (b):** the `capture` scope may write **annotations** (for all captures: "hide,
  move or describe them, see all moments including the WhatsApp ones").
- **§5.1:** the publish sheet's "Now" maps to `visibility: public`.
- **The policy:** in `policy.ts` an annotation override wins before anything else is checked
  [verified, `policy.ts:108–109`]:

```ts
const override = annotation?.visibility;
if (override) return override;          // before the revoke check and the delay
if (capture.revokedAt && settings['ingest.on_revoke'] === 'hide') return 'hidden';
```

`capturePublishAt` returns `occurredAt` for a `public` override (`policy.ts:135–136`), so the
item goes live in the next deploy. With a `capture` token, someone can therefore:
- publish **any WhatsApp status the owner hid** for safety reasons;
- re-publish a status **she deleted on WhatsApp**, because the override beats `revokedAt` +
  `on_revoke=hide`;
- skip the delay, the departure hold and the auto-hold for anything.

**Who can do it:**
- whoever holds her **unlocked** phone within the 5-minute lock grace (snatch theft usually
  happens while the phone is in use);
- whoever saw her PIN;
- or simply a buggy app build.

This contradicts the plan's own claims: §3.7 "a `capture`-scope token cannot touch followers…",
Q4 "if the phone is lost", and summary point 4.

**Change:**
1. A `capture` token may set `visibility` to `hidden` or `pending` on any capture. It may set
   **`public` only on `app:` entries that this token created**, so store `token_id` on
   `app_entries`. It may never clear or loosen an override that a session token (the owner) set:
   - either store `annotations.visibility_set_by`, with values `session` or `app`;
   - or refuse to loosen any existing override.
2. Describing or moving **WhatsApp** captures stays in the admin PWA. Q4 becomes (a) plus "hide
   anything".
3. "Now" needs a fresh `BiometricPrompt` (`BIOMETRIC_STRONG | DEVICE_CREDENTIAL`) with no grace
   period.
4. PHPUnit tests: a `capture` token gets 403 for `public` on a `wa:` key, on another token's
   entry and on a revoked key.
5. Raise this with wave 5. Should a `public` override ever beat a revoke? Today a "Publish now"
   on a status deleted on WhatsApp re-publishes it. Wave 5 keeps "Publish now" (proposal line
   154). Add a policy vector either way.

### H1. Upload transport: no progress on bad links, and the host's limits are not probed

**Problem.**
- **Partial chunks are wasted.** Each chunk is checksummed as a whole and appended only after it
  verifies (flow §1.3), so the bytes of a broken chunk are thrown away.
  - On links that drop every 1–2 MB (hostel Wi-Fi, trains, an EDGE fallback at about
    100–200 kbit/s), a 4 MiB chunk takes 3–6 minutes and may **never** complete.
  - The result is zero progress and repeated identical requests that drain the battery.
- **The network class is a poor proxy.** The size depends on mobile vs Wi-Fi (§9 "Chunking"), but
  hotel Wi-Fi is often slower than 5G. stack.md's adaptive 1–8 MiB was the better choice.
- **Wall-clock limits are unknown.** `max_execution_time` ignores stream I/O on Linux, which is
  correct. But PHP-FPM `request_terminate_timeout`, Apache `Timeout`/`ProxyTimeout` and
  `mod_reqtimeout` (stock default: body 20 s, extended at 500 B/s) are wall-clock or rate based.
  None is known for this host [A].
- **Workers can run out.**
  - "≤ 2 concurrent upload requests" can mean **all** PHP workers on a small plan. flow §1.3 cites
    "2/5/10/20 PHP processes" by plan, and the account's number is unknown [A].
  - The backend's own 32 MiB `Range` downloads (via `fpassthru`) hold workers too, and nothing
    counts them.
  - The admin, the backend sync, and wave 5's joins and analytics all compete for the same
    workers.
- **The host already blocked an IP.** It refused HTTPS from one IP for over 3 hours after
  about 25 rapid requests (`docs/HOSTING.md`, Troubleshooting). The cause is unconfirmed.
  - A retry loop from her phone (409/460/503) could trigger the same block [A].
  - It would cut her off for hours at a hostel.

**Change:**
1. **Adaptive chunk size, decided by the client.**
   - Start at 1 MiB and aim for at most about 15 s per `PATCH` at the measured throughput.
   - Double after each success, up to the server maximum (8 MiB). Halve after any failure, down to
     256 KiB.
   - The server announces only the minimum and maximum.
2. **Upload slots: 1 by default.** Set the real number from the probe: workers minus 2, at least 1.
   The backend's downloads use the same slot pool.
3. **A request budget in the client.**
   - At most about 10 requests per 10 s.
   - Exponential backoff with jitter on every 4xx and 5xx, except a 409 that carries the offset.
   - No `HEAD` before every chunk, only after a failure.
4. **Add to the host probe (M0 row 9):**
   - an 8 MiB `PATCH` throttled to 64 kbit/s;
   - a `PATCH` that stalls for 30 s mid-body (this finds the reqtimeout and wall-clock limits);
   - a binary `application/offset+octet-stream` body (does a WAF pass it?);
   - the account's PHP process count.
   Ask Hetzner support what triggers the IP block, instead of probing for it from the owner's IP.

### H2. "Nothing while roaming" by default blocks the usual travel setup

**Problem.** Q6 (a) and A4 turn roaming uploads **off** by default. Many travel data eSIMs only
work with data roaming on, and Android then reports the network as roaming [A: depends on the
provider; check her SIM/eSIM in M0 row 1]. Inside the EU, roam-like-at-home makes roaming free
anyway.

With this default:
- mobile uploads never start;
- entries sit in "Waiting for Wi-Fi (roaming)" for days;
- the wave-5 delay and the departure hold then work on stale data.

**Change:**
- Decide **per SIM**, not globally. The first time an upload would run on a roaming network,
  ask once: "You're using <carrier> abroad. Upload on it? Yes · Only photos, text and voice ·
  No".
- Remember the answer per SIM. `TelephonyManager.getSimOperator()` (MCC+MNC) needs no
  permission [A: confirm it distinguishes eSIM profiles on her phone].
- Q6's default becomes "ask once per SIM".
- Keep the home-SIM roaming warning.

### H3. Background uploads: claims Android cannot honour, and two uploaders

**Problem.**
- **M3 done-when 2** says uploads "resume after a force-stop … without opening the app
  (Android 14+)". That cannot happen:
  - a force-stop removes the app's scheduled jobs (AOSP "Remove scheduled jobs when an app is
    force-stopped");
  - Android 15 also cancels its pending intents;
  - nothing runs until she opens the app again.
  Some OEM "clean up" and swipe-away actions behave like a force-stop (the OEM risk row in §7)
  [A: depends on the model, M0 row 1].
- **§4 and §6.4: "WorkManager + `dataSync` FGS below API 34".** Since Android 12, a worker running
  in the background cannot promote itself to a foreground service. `setForeground` throws
  `ForegroundServiceStartNotAllowedException` [verified: Android FGS troubleshooting docs, Android
  12 FGS restrictions].
- **Two uploaders for one protocol.**
  - M1 builds a TS tus client plus expo-background-task (WorkManager, 15 min or more, stopped by a
    force-kill: stack.md §8.3).
  - M3 replaces it with a native uploader.
  - Building both costs time, adds a state handoff between JS and Kotlin, and the M1 version is not
    good enough for travel anyway.

**Change:**
1. Build **one native uploader, in v0.5**:
   - Android 14+: a UIDT job;
   - API 29–33: a plain WorkManager worker with network constraints that uploads chunks for about
     9 minutes per run and re-enqueues itself, **without** a foreground service;
   - no expo-background-task.
2. Keep the TS client in `app-core` only for the no-phone stack e2e test.
3. Opening the app is the **guaranteed** resume path. Rewrite done-when 2: "after process death and
   after a reboot, without opening the app; after a force-stop, as soon as she opens it".
4. Show the OEM "Allow background uploads" card from the first launch, not only in M3.
5. If her phone is on API 34 or newer (M0 row 1), test only the UIDT path on her phone. The pre-34
   path gets an emulator test.

### H4. The daily place chip feeds the departure hold, and day trips release held days early

**Problem.**
- **How the hold works.** Wave 5 keeps days at the current place unpublished until "a later day
  carries a different place", the owner taps "moved on", or 7 days pass (proposal §3.1, line
  156).
- **What the app adds.** It asks "Today in <nearest city of 15 000+>?" once a day, from coarse
  location (about 3 km²), and one tap writes `Day.placeName` (§2.2, §5.1).
- **What goes wrong.** A day trip (Hội An → Đà Nẵng and back), or a nearest-city mismatch,
  writes a **different** place for the next day. The hold then releases the earlier days while she
  still sleeps at the first place.
- **What the plan misses.** It treats the chip as a convenience (M2, "M") and never mentions the
  hold.

**Change:**
- Ask about the night, not the day: "Staying in Hội An tonight?", with "Day trip" as an answer
  that leaves the day's place unchanged.
- Put an explicit **"I've moved on"** button in the app. She knows when she has moved on; the
  owner at home may not. Wave 5's hold should count it.
- Add a policy vector: "a day trip does not release".
- Or cut the chip from v1. The place then stays an admin action, as wave 5 assumed.

### H5. Text baked into pixels escapes the wave-5 auto-hold, although the app knows the words

**Problem.**
- **What the auto-hold sees.** Wave 5 scans captions, text statuses and notes for plan and venue
  words, and admits that "text inside photos" cannot be scanned (proposal line 157).
- **What the app knows.** For app entries the overlay text is known exactly: it becomes the alt
  text. Place stamps put the place name into the pixels.
- **What the plan claims.** §3.7 says the auto-hold applies "automatically". It does not apply to
  overlay text.

**Change:**
- Feed `alt` (`accessibilityLabel`) into the auto-hold input in `policy.ts`, `Policy.php` and the
  shared vectors.
- This covers WhatsApp captures that carry an `accessibilityLabel` as well.
- When the caption or the overlay text hits the word list, the publish sheet hides "Now" and says
  why.

### H6. Too much before first use, and the timeline assumes two developers

**Problem.**
- **The arithmetic.** v1 = M0 1.5 + M1 12 + M2 4–5 + M3 6 ≈ **24 dev-weeks**, and real use also
  waits for wave-5 P1b.
- **The calendar figures assume two people.** "7–8 calendar weeks in parallel" and "about
  4 months" both assume server and app are built at the same time.
- **One developer is already booked.** The same developer is finishing wave 4 and building wave 5
  (P0 alone is "L−, 2–3 weeks", then P1a and P1b). Real use is then 7–9 months away
  [A: my estimate].
- **Ramp-up is not budgeted.** There is no JDK or Android Studio on the Mac yet, and this is the
  repo's first React Native and Gradle pipeline.
- **The urgency is real.** The request says her phone is Android "right now", and the plan's last
  owner question is whether she is already travelling.

**Change:**
- Cut v1 down to the **v0.5** in §2: about 10–11 dev-weeks including a slim M0. The editor comes
  as **v0.6** through a Play update.
- Add an **archive-only mode** until P1b passes:
  - app entries upload into the API inbox and the backend archive with an `only_archive` flag in
    the backend config;
  - the generator skips them, so nothing is published;
  - her diary and its backup work from her first day on the road;
  - publishing switches on once the gate is live.
  Owner question: does "no real travel content on the live host before P1b" also forbid the
  API host's **private** inbox (`var/`, denied)? See §5.

### M1. Media3 copies the source's location into the "metadata-free" artifact

**Problem.** The plan says the baked artifact carries **no metadata at all** (§3.3; flow §3.3:
"The app writes no metadata at all"). Media3 Transformer does the opposite by default
[verified in the source at tag 1.9.1]:
- `SampleExporter` copies `firstInputFormat.metadata` onto the output track format.
- `MuxerWrapper.addTrackFormat` then calls `muxer.addMetadataEntry()` for every entry.
- `Mp4Extractor` fills `Mp4LocationData` from the `©xyz` atom, and the 1.12.0-alpha01 release
  notes fix exactly that parsing.

So a GPS-tagged input leads to a GPS-tagged output. The likely inputs are:
- share-in from Google Photos or the gallery app (a content provider, not the redacting Photo
  Picker);
- a camera-app intent;
- a phone whose camera has location on.

**What still protects the site:** the backend strips again (`-map_metadata -1`,
`backend/src/pipeline/video.ts:66`) [verified].

**What is exposed:**
- the API inbox on shared hosting (fresh coordinates if that host is compromised);
- the v1.1 WhatsApp hand-off (WhatsApp re-encodes [A]);
- iOS later.

M1 done-when 6 only catches this if it tests the **app** artifact made from a **GPS-tagged** input.

**Change:**
- Use `InAppMp4Muxer.Factory(MetadataProvider)` (it exists in 1.9.1 [verified]) and remove
  everything except orientation in `updateMetadataEntries`. That includes `Mp4LocationData`,
  `XmpData` and timestamps.
- Add a Kotlin test: a GPS-tagged MP4, run through share-in → export, must have no `©xyz`/XMP in
  `ffprobe`.
- Same for photos: Skia's JPEG has no EXIF by construction. Test it anyway with a GPS-tagged HEIC
  that goes through `expo-image-manipulator`.

### M2. "WYSIWYG" is not achievable as specified

**Problem.**
- **System fonts.** Three of the eight fonts are the **viewer's** system fonts on the site
  [verified, `theme.css:76–77`, `fonts.ts:32–35`]:
  - `SYSTEM` and `SYSTEM_BOLD` use `system-ui`: SF on iPhones, Segoe UI on Windows, Roboto (or the
    OEM font) on Android;
  - `SYSTEM_TEXT` uses `ui-serif`/Georgia.
  The app cannot preview what a given follower will see.
- **Variable vs static fonts.** The site uses variable cuts of Nunito, Exo 2 and Playpen; the app
  plans static TTFs.
- **Photos are cropped and moved.** Tall images (h/w ≥ 1.6) are `object-cover`, and every photo
  slide has Ken Burns up to scale 1.07 plus a translate of up to 1.6 % [verified,
  `slides.tsx:55–58, 79–84, 141`].
  - A 9:16 photo on a 9:20 phone loses 10 % per side from the cover crop alone, and about 13–14 %
    with Ken Burns.
  - On 9:21 it loses about 15.5 %.
  - The planned guide "x 10–90 %" therefore lets baked text reach the cut edge.
- **The test cannot pass.** M2 done-when 1 and ux.md §11.9 (a screenshot diff of 8 fonts ×
  5 lengths within a small tolerance) cannot pass for the system fonts, and only holds at one
  aspect ratio.

**Change:**
- **Fonts:** either
  - (a) self-host OFL substitutes for `SYSTEM*` on the site (one sans, one serif) and bundle the
    same files in the app, which gives captured statuses a consistent look too; or
  - (b) keep the site as it is, restrict the golden test to the 5 self-hosted faces, and label
    `SYSTEM*` "looks like your phone's font" in the picker.
- **Guides:** widen them to **x 16–84 %**. Or have the editor preview the 9:20 crop as a dimmed
  frame.
- **Done-when:** rewrite it as "same font family, same line breaks, same size step" for the
  self-hosted faces at 9:16 and 9:20.

### M3. The alt chain throws away the baked words when a description exists

**Problem.** Today `alt = description ?? caption` [verified, `items.ts:49`]. The plan's new chain
is "description, else alt, else caption" (§2.1). Once the owner writes a de/en description, a
screen-reader user no longer hears the words that are visible on the photo. Those words are
exactly what alt text is for here.

**Change:**
- `alt = [overlayText ? "Text on image: " + overlayText : null, description].filter(Boolean).join(". ")`,
  localized.
- Leave the caption out, because the player already shows it as visible text.
- Default text on media to the pill or solid background style, so the baked text stays legible.
- Accept that baked text cannot be translated, and tell the owner so.

### M4. A stolen phone: the device side

**Problem.**
- **The lock grace is long.** It is 5 minutes, and the Journal (with WhatsApp captures,
  including hidden ones, under Q4 (b)) opens within it.
- **Revocation leaves the cache.** It only stops the server side. The phone keeps the cached
  journal and previews.
- **Only the owner can revoke.** She probably carries one phone, so she has to reach the owner
  first. There is no runbook for that.
- **Re-pairing loses entries.** Re-pairing after a false alarm (she finds the phone) would lose
  the outbox if pairing resets the app state [A: unspecified].

**Change:**
- The Journal and "Now" need authentication every time. Capture and drafts stay open. Keep the
  grace for the rest at 1 minute.
- On a `401 token_revoked`, wipe the cached server data (journal, previews, hints). Keep her
  unsent outbox sealed until she re-pairs and authenticates.
- Re-pairing keeps the outbox: entries are keyed by ULID, not by token.
- Add a one-page emergency card for the owner: revoke the device, lock the site (wave 5), check
  pending app entries.

### M5. The WhatsApp path: "the very same artifacts" holds only for photos and videos

**Problem.**
- **Only photos and videos are reported.** WhatsApp's "My Status" share target takes photos and
  videos into WhatsApp's **status editor** (Android beta 2.25.20.3; iOS 25.22.83) [verified:
  press reports]. There, she can add more decorations before sending. Text and audio shares to
  status are not reported.
- **Text cards change kind.** A text card shared as a picture becomes an `ImageMessage`, so the
  observer captures a **photo**. The planned "exact text match" dedupe cannot pair it with the app
  text entry.
- **Voice may not work at all** [A].
- **Reaching "My Status" takes several steps.** The system chooser's Direct Share row is ranked by
  the system, so finding "My Status" is not one tap. And WhatsApp's own fonts (Norican, Morning
  Breeze) differ from our substitutes.

**Change:**
1. **Hand-off by explicit intent.** Send `ACTION_SEND` with `setPackage("com.whatsapp")`
   (`com.whatsapp.w4b` for Business). WhatsApp's own picker then shows "My status" first, which
   makes the flow deterministic.
2. **Text cards:** test in M0 row 8 whether `text/plain` sent to "My status" yields a real text
   status. If it does, prefer it: it is field-compatible and exact-text dedupe works. WhatsApp
   picks the colour and font.
3. **The simplest v1.1 that needs no dedupe:** "Also on WhatsApp" marks the app entry **Only for
   me** once handed off, and the observer's `wa:` copy is the published one. Build the plan's
   pHash dedupe (M) only if the owner wants the app copy (higher quality, alt text) to win.
4. **Keep Q1's advice against backend posting**, and add one more reason: it reverses the PLAN's
   founding decision "the traveler's own account is never touched" (PLAN, Decisions made).

### M6. "Edit again" (revisions) does not say how it interacts with the delay

**Problem.** Q3 (b) is recommended, and §3.3 says re-edits keep the id. It never says whether a
new revision is an "addition" under wave 5's delay. There are two possible readings:
- **Delayed:** the old revision stays live meanwhile, or the entry vanishes until the slot.
- **Immediate:** a re-edit can add a place stamp that goes out at once.

There is also a simpler fact the plan misses: under the 24-hour default, **most fixes happen
before anything is public**, and then withdrawing and re-sharing costs nothing (no reactions
exist yet).

**Change:**
- **v1:** only "Replace before it appears". The new entry inherits `postedAt` and withdraws the
  old one. This is about 2 days of work instead of M.
- **v1.1:** revisions after publication. The old revision stays live until the new one passes the
  delay. "Take the old one down now" is a separate, immediate action.

### M7. Disk quota: the inbox can take the API down with it

**Problem.**
- `APP_INBOX_MAX_BYTES` defaults to 3 GiB, but the account quota is unknown (§10.6).
- The API's SQLite database lives in the same `var/`.
- If the site and the API share one account (`HOSTING.md`: "They can be the same Hetzner
  account"), the site's media grows into the same quota (PLAN: about 10 GB a year).
- A full quota means `SQLITE_FULL`. Then the admin, the backend sync and wave 5's gate logic all
  fail.

**Change:**
- Set the budget to at most 10 % of the quota that konsoleH shows. Refuse uploads with 507
  before that point.
- The doctor and cron also alert on the API database's free headroom.
- Originals (v1.1) count against half of the budget, as planned.

### M8. Android 2026 facts that change Q7

**Problem.** The plan places developer verification in "2027". It has been **enforced since
2026-09-30** in Brazil, Indonesia, Singapore and **Thailand**; the global rollout is in 2027.
**Limited-distribution accounts** (free, no identity verification, for personal use) launched in
August 2026 [verified, §6].

**Consequences:**
- The sideload fallback could fail while she is in Thailand or Indonesia [A: whether this
  depends on the device's region or SIM].
- adb still works.

**Change:**
- Q7 (a), Play internal testing, stays the recommendation, now with this reason.
- Q7 (b) gets a note: "in some countries since 2026-09-30, unless the app is registered (free
  limited-distribution account) or installed by cable".

---

### Low

**L1. Media3: the 1.11.1-vs-1.9.1 decision is a false choice.**
- `FrameDropEffect.createDefaultFrameDropEffect(30f)` caps the frame rate and exists at tags
  1.1.0 and 1.9.1 [verified]. `setFrameRate` (1.10) is not needed.
- Stay on expo-video's 1.9.1 for every `androidx.media3:*` artifact, and drop the M0 decision.
- Forcing 1.11.1 under expo-video is the riskier path.

**L2. Opus voice in Kotlin is not needed in v1.**
- The backend transcodes every voice note to AAC m4a and **computes the 64 waveform peaks itself**
  when none are sent [verified, `voice.ts:1–5`].
- Audio sent to "My Status" is unproven (M5).
- Use expo-audio (AAC m4a, with metering for the live UI only) and drop `VoiceRecorder`, the
  waveform upload and M0 row 6. The contract already accepts `audio/mp4`.

**L3. The `mediaProcessing` foreground service.**
- The type exists from API 35. On older versions it can be declared, but `onTimeout` is never
  called, so the service must stop itself [verified, `ServiceInfo` docs].
- If M0 shows exports under about 1 minute, run them in the foreground with a visible ring and
  resume them on the next open. That avoids a foreground-service declaration (and its Play demo
  video) in v0.5.

**L4. Pairing.**
- A 10-minute TTL is too short for a code sent across time zones by chat.
- Allow up to 24 h when the code is single-use, and alert the owner when it is consumed.
- Drop App Links and `assetlinks.json` in v0.5: they add a public file on the API host and a
  deploy step. Use "Open on this phone" as a plain `omw://` link from the admin she already uses,
  plus the typed code. Add the QR later.

**L5. The clock-skew rule.**
- "Reject `postedAt` older than `receivedAt` − 30 days" loses entries that waited longer in a
  forgotten manual queue.
- Accept them with `pending` and an admin note instead.

**L6. Rasterized text statuses (v1.1).**
- They would get Ken Burns and the cover crop like any photo, so a full-bleed text card loses its
  edges on tall phones.
- When `imageSource = rasterized_text_status`, the player should use `contain` and skip Ken Burns.
  The same code applies to both sources, so the owner's rule still holds.

**L7. Shared packages.**
- Do not move tokens into a new `@omw/tokens` while waves 4 and 5 edit `frontend/shared`.
  Generate a JSON snapshot (palette, springs, `WA_FONTS`, the `textStatusScale` thresholds) for
  the app instead.
- Keep `EditDoc` in the app package, not in `packages/contracts`: the server treats it as opaque.
- Add the `edits` and `source` file roles when they are used. Adding an enum value later is an
  additive change.

**L8. Tests.**
- Emulators (API 29 and 36) and Maestro in CI do not fit a Mac-only setup with a nearly full
  Docker VM.
- Run them on a device locally before each Play release. CI keeps Vitest, PHPUnit and the
  no-phone stack e2e.

**L9. Covers, tiles, the portrait and OG show baked overlays.**
- This follows from the owner's decision. The clean original must not be used for covers, because
  it is not WhatsApp-equivalent.
- Tell the owner, so a photo with stickers is not picked as the day cover or the wave-4 portrait
  by accident.

**L10. Play declarations and the privacy policy.**
- The plan expects the Play Console declarations for the FGS types and `RUN_USER_INITIATED_JOBS`
  (§6.4), but no privacy-policy page. A privacy-policy URL is likely required for an app with
  camera, microphone and location permissions, even on internal testing [A: check in the Play
  Console].
- That page must be neutral to respect D3: no name, no destination, no link to the site.
- Budget S for it.

**L11. "Identical numbers" for Skia colour matrices and Media3 `RgbMatrix` [A].**
- The two may apply in different working colour spaces (gamma vs linear), and Skia keeps the
  offset in a separate fifth column.
- Add a pixel test before v1.1 filters ship.

---

## 2. Scope: what reaches her phone first

### 2.1 v0.5, "trip-ready core" (target about 10–11 dev-weeks after a slim M0) [A: estimates]

| Area | In v0.5 | Moved out (where to) |
|---|---|---|
| Capture | **expo-camera** (tap = photo, hold = video, flip, flash, pinch zoom) or the system camera intent, chosen in M0 | VisionCamera v5 on the alpha CameraX, volume-key shutter, slide-to-zoom, pre-warm (v1.x) |
| Gallery / share-in | Photo Picker multi-select; share-in (copied into the outbox at once) | launcher shortcuts (v1.x) |
| Text status | 12 colours, 8 fonts, the site's size steps | – |
| Photo / video | caption; video trim + mute + transcode on Media3 **1.9.1**, metadata stripped (M1) | overlays (v0.6) |
| Voice | expo-audio AAC, 60 s, hold / slide to cancel | Opus module, voice background colour (drop / v1.1) |
| Publish sheet | As usual · Hold back · Only for me, with the delay line from settings | "Now" (v0.6, with biometric + C1 rules); `/app/hints` slot prediction (v1.x) |
| Uploads | **native** uploader (UIDT on 34+, plain WorkManager below), adaptive chunks (H1), per-SIM roaming (H2), Wi-Fi-only switch, manual / automatic | TS uploader, expo-background-task (drop) |
| Safety | narrow `capture` scope (C1), app lock, token in a Keystore-backed store read by the native uploader | place chip (drop or v1.x, H4); Journal auth rules (with the Journal) |
| App UI | Today + queue sheet, Settings, de/en, 5 key transitions, haptics via `performAndroidHapticsAsync` + 2 native constants | Journal viewer, Recently deleted, 15 more transitions, pseudo-ar QA beyond a smoke test (v1.x) |
| Pairing | typed code + `omw://` link from the admin | QR, App Links (v1.x) |
| Server | contracts (`app.ts` minimal), migration (scope CHECK, `app_entries`, `app_uploads`, `pairing_codes`), pairing, entries / tus / commit / state / withdraw, backend inbox endpoints, backend `app-source`, admin "Connect a phone" + App badge, quota / cron / doctor; **archive-only switch** (H6) | revisions (v1.1, M6), pending previews in the admin, wa-helper `accessibilityLabel` extraction (do it with PLAN Phase 0) |
| Distribution | Play internal testing (Q7 a) | – |

Effort, roughly:
- **Server:** about 4 dev-weeks (the plan's 5–5.5 minus hints, revisions, the alt chain, pending
  previews and the wa-helper work).
- **App:** about 6–6.5 dev-weeks. The plan's 7 weeks, with:
  - the camera going from M to S (expo-camera);
  - the voice recorder going from M to S;
  - the TS uploader (M) replaced by the native one (L).
- **Slim M0:** about 1 week:
  - rows 1, 2, 4, 5 and 9;
  - row 8 as far as possible without the observer;
  - row 3 only as a choice between expo-camera and the system camera.

### 2.2 v0.6, "styling" (about 4–5 dev-weeks)

- Skia overlays on photos (text, emoji, crop/rotate) and the same overlay PNG on video.
- Wider safe-area guides (M2), drafts, undo.
- Alt text plus the site's alt chain (M3) and the auto-hold on `alt` (H5).
- "Now" with biometric (C1).
- "Replace before it appears" (M6).

### 2.3 Later (v1.x / v1.1)

The custom camera, the Journal viewer, revisions after publication, the place chip (only in
H4's form), drawing and blur, stickers, filters, layouts, "Also on WhatsApp" in M5's dedupe-free
form, originals to the archive (Q2), iOS.

---

## 3. Tech claims re-checked

| Claim in the plan | Finding | Status |
|---|---|---|
| Media3 1.11.1 stable (2026-09-10); 1.12.0-beta01 (2026-11-11) | Matches the release notes | confirmed |
| "Output frame-rate cap only from 1.10 (`setFrameRate`)" | `setFrameRate` as a maximum output rate is new in 1.10.0, but `FrameDropEffect` already caps the rate at tags 1.1.0 and 1.9.1 | **misleading** → L1 |
| "Baked artifact carries no metadata" (video) | Media3 1.9.1 carries the input `Format.metadata` into the muxer (`SampleExporter` → `MuxerWrapper.addTrackFormat` → `addMetadataEntry`). `InAppMp4Muxer.MetadataProvider` can remove it | **wrong by default** → M1 |
| Backend strips metadata again | `video.ts:66` uses `-map_metadata -1`, bitexact | confirmed |
| Opus via `MediaRecorder` from API 29; expo-audio has no Opus | Correct, but not needed (backend transcodes and computes peaks: `voice.ts:1–5`) | correct, **unneeded** → L2 |
| `mediaProcessing` FGS type | `ServiceInfo`: added in API 35, usable earlier without `onTimeout`; `dataSync` from API 29 | confirmed, detail → L3 |
| "WorkManager + `dataSync` FGS below API 34" for background resume | Android 12+ blocks starting an FGS from the background, including `setForeground` in workers | **wrong** → H3 |
| "Resume after force-stop without opening the app" | AOSP removes the jobs of a force-stopped app; Android 15 also cancels its pending intents | **wrong** → H3 |
| ffmpeg-kit retired, repo archived 2026-07-02 | GitHub API: `archived: true`, last push 2026-07-02 | confirmed |
| VisionCamera v5 on an alpha CameraX | v5 released 2026-04-16; 5.1.1 moved to CameraX 1.7.0-alpha02 | consistent |
| expo-sharing receiving is experimental (SDK 58) | v58 docs: "This functionality is currently experimental" | confirmed |
| Photo Picker redacts GPS | Yes. A teardown (2026-06-30) shows a future opt-in "Include location?" that appears only when the app requests location. Share-in is **not** covered → M1 | confirmed, scope note |
| "My Status" share target | Photos and videos into WhatsApp's status editor; text and audio not reported | partly → M5 |
| 16 KB pages: Play deadline 2027-02-01 | Google's 16 KB page states 2027-02-01 for updates | consistent |
| Developer verification "2027" | Enforced since 2026-09-30 in BR/ID/SG/TH; global 2027; limited-distribution accounts exist | **outdated** → M8 |
| An `app` token is full admin today | `0001_init.sql:186` forces `["admin"]`; `AdminAuth.php:58–65` accepts app bearers | confirmed (the plan fixes it; C1 tightens the fix) |
| An annotation override wins | `policy.ts:108–109, 135–136` | confirmed → C1 |
| The site crops tall photos and runs Ken Burns | `slides.tsx:55–58, 79–84, 141` | confirmed → M2 |
| `SYSTEM*` fonts on the site | `theme.css:76–77` (system-ui / ui-serif) | confirmed → M2 |
| The site's alt chain | `items.ts:49` (description ?? caption) | confirmed → M3 |

---

## 4. Edits to `app-plan.md`, section by section

- **§1, point 4:** "a lost phone can be cut off": add "and cannot publish anything early or
  un-hide anything" once C1 is applied.
- **§2.1:**
  - the alt chain as in M3;
  - "No EXIF, no GPS" for video depends on the muxer metadata filter (M1).
- **§2.2:** replace it with v0.5 (§2.1 here). The editor moves to v0.6.
- **§3.3:**
  - Location: share-in and camera intents bypass the picker redaction; strip on export (M1).
  - Withdraw: add "Replace before it appears" (M6).
- **§3.5:**
  - capture-scope rules from C1;
  - one upload slot by default, with downloads in the same pool;
  - chunk sizing from H1;
  - pairing TTL as in L4;
  - drop `assetlinks.json` in v0.5.
- **§3.7:**
  - the auto-hold also reads `alt` (H5);
  - the place-chip interaction with the departure hold (H4);
  - the archive-only mode before P1b (H6).
- **§4 stack table:**
  - Media3: pin 1.9.1 and use `FrameDropEffect`; `InAppMp4Muxer` with a `MetadataProvider`;
  - Voice: expo-audio AAC;
  - Upload client: native only;
  - Camera: expo-camera in v0.5;
  - Haptics unchanged.
- **§6:**
  - milestones as in §2 here;
  - M3 done-when 2 reworded (H3);
  - M2 done-when 1 reworded (M2);
  - M1 done-when 6 tests a GPS-tagged input from share-in (M1).
- **§7 risks:** add these rows:
  - the IP block triggered by her own retries (H1);
  - travel eSIMs counted as roaming (H2);
  - disk quota taking the API down (M7);
  - the departure hold released by a day trip (H4).
- **§8:**
  - Q4 → (a) plus "hide anything" (C1);
  - Q6 default → "ask once per SIM" (H2);
  - Q7 with the 2026-09-30 note (M8);
  - Q1 (b) via an explicit WhatsApp intent, and the dedupe-free variant (M5);
  - Q3 → "replace before it appears" in v1, (b) in v1.1 (M6).
- **§10 open checks:** add these checks:
  - her SIM/eSIM roaming flag;
  - the account's PHP process count and the wall-clock / reqtimeout limits;
  - WAF tolerance for binary bodies;
  - whether sending `text/plain` to "My status" creates a text status;
  - whether developer verification applies by device region or SIM.

---

## 5. Questions this adds for the owner

1. **Archive-only before P1b.** May the app upload real entries into the API host's **private**
   inbox (`var/`, denied, deleted after the backend's ack) and the home archive before the
   follower gate is live? Nothing would be published.
   - Yes: she can use the app from day one.
   - No: the app waits for P1b.
2. **"Now" in the app.** Should the traveler be able to skip the delay from her phone at all,
   given C1 and a stolen-phone risk? If yes, it is limited to her own app entries and always needs
   her fingerprint or PIN.
3. **Who marks "moved on".** Should the traveler be able to tap "I've moved on" in the app
   (H4)? It releases the days of the place she has left.
4. **Information still needed:**
   - which SIM or eSIM she travels with (H2);
   - the hosting plan's PHP process count (H1);
   - whether the site and the API share one hosting account and quota (M7).

---

## 6. Sources (accessed 2026-11-20)

Repo (read-only):
- `packages/contracts/src/policy.ts:102–142`
- `packages/contracts/src/wa.ts:322–343`
- `frontend/site/src/player/items.ts:49`
- `frontend/site/src/player/slides.tsx:55–58, 79–84, 141, 455–460, 481–505`
- `frontend/shared/src/fonts.ts:31–40`
- `frontend/shared/src/styles/theme.css:76–83`
- `backend/src/pipeline/video.ts:5–14, 66`
- `backend/src/pipeline/voice.ts:1–5`
- `api/migrations/0001_init.sql:168–186`
- `api/src/Http/Middleware/AdminAuth.php:58–65`
- `docs/HOSTING.md` (§ live setup, Troubleshooting)
- `docs/PLAN.md` (Decisions made)
- `.cache/design-w5/proposal.md` (lines 154–157, 735)

Media3 (source at tag 1.9.1):
- https://github.com/androidx/media/blob/1.9.1/libraries/transformer/src/main/java/androidx/media3/transformer/SampleExporter.java
- https://github.com/androidx/media/blob/1.9.1/libraries/transformer/src/main/java/androidx/media3/transformer/MuxerWrapper.java
- https://github.com/androidx/media/blob/1.9.1/libraries/transformer/src/main/java/androidx/media3/transformer/InAppMp4Muxer.java
- https://github.com/androidx/media/blob/1.9.1/libraries/effect/src/main/java/androidx/media3/effect/FrameDropEffect.java (also present at tag 1.1.0)
- Release notes (1.10.0 `setFrameRate`; 1.12.0-alpha01 `Mp4LocationData` parsing; 1.11.1 / 1.12.0-beta01 dates): https://developer.android.com/jetpack/androidx/releases/media3
- https://developer.android.com/reference/androidx/media3/effect/FrameDropEffect
- https://developer.android.com/reference/androidx/media3/transformer/InAppMp4Muxer.MetadataProvider

Android platform:
- FGS types (`MEDIA_PROCESSING` API 35, `DATA_SYNC` API 29): https://developer.android.com/reference/android/content/pm/ServiceInfo
- FGS from the background, Android 12+: https://developer.android.com/about/versions/12/foreground-services
- WorkManager `setForeground` and `ForegroundServiceStartNotAllowedException`: https://developer.android.com/develop/background-work/services/fgs/troubleshooting
- Using WorkManager on Android 12: https://medium.com/androiddevelopers/using-workmanager-on-android-12-f7d483ca0ecb
- Force-stop removes jobs (AOSP): https://android.googlesource.com/platform/frameworks/base/+/ee7805b
- Android 15 force-stop cancels pending intents: https://www.androidauthority.com/android-15-killing-app-3451796/
- Photo Picker location (teardown, 2026-06-30): https://www.androidauthority.com/android-photo-picker-location-3683074/
- 16 KB pages (2027-02-01): https://developer.android.com/16kb-page-size

Distribution:
- Developer verification (enforced 2026-09-30 in BR/ID/SG/TH; adb; limited distribution): https://developer.android.com/developer-verification/guides
- https://android-developers.googleblog.com/2026/06/android-developer-verification.html
- https://support.google.com/android-developer-console/answer/16561738

Libraries:
- expo-sharing receiving is experimental (v58): https://docs.expo.dev/versions/latest/sdk/sharing/
- VisionCamera v5 (2026-04-16): https://margelo.com/blog/whats-new-in-visioncamera-v5
- VisionCamera 5.1.1 (CameraX 1.7.0-alpha02): https://www.github.com/mrousavy/react-native-vision-camera/releases
- ffmpeg-kit archived (GitHub API: archived, last push 2026-07-02): https://github.com/arthenica/ffmpeg-kit

WhatsApp:
- "My Status" share target, Android (photos and videos only; "routed to the status update
  editor"): https://wabetainfo.com/whatsapp-beta-for-android-2-25-20-3-whats-new/
- iOS: https://wabetainfo.com/whatsapp-for-ios-25-22-83-whats-new/
