# Traveler app: UX, interaction, motion and haptics

Status: design draft, 2026-11-20. Part of the app phase ("React Native, Android first").
Scope: how the app looks, moves, feels and flows. The data model, the WhatsApp encoding, the
video flattening pipeline and the API changes are covered by the sibling documents. This one
only lists what it needs from them (section 12).

Read before writing: `README.md`, `docs/PLAN.md` (C "Design system", "Admin PWA", "Journey
player"), `.cache/design-w5/owner-decisions.md`, `frontend/shared` (`theme.css`, `motion.ts`,
`fonts.ts`, README), `frontend/admin` (layout, home, inbox, composer, settings, status chips,
`app.css`, the de catalog for tone), `frontend/site/src/player` (text-status rendering),
`packages/contracts` (`wa.ts`, `site.ts`, `api.ts`, `policy.ts`, `i18n.ts`). Aligned with the app
owner decisions A1–A5 (`.cache/design-app/owner-decisions.md`) and with the sibling data-flow
document `.cache/design-app/flow.md` (`occurredAt` = the moment of "Share", the offline place
suggestion, the two-phase upload, the WhatsApp "My Status" share target).

Assumptions are marked **[A]**. Facts that change with platform versions are cited (section 14).

---

## 0. The binding frame: "stay WhatsApp status compatible"

Everything the traveler makes in the app is a WhatsApp status: the same three kinds, and only
what WhatsApp status can express. This sets the scope of the editor.

| Kind | What she can do in the app | What gets published |
|---|---|---|
| **Photo / video / GIF** | Crop and rotate, filters, text overlays (font, colour, text background, alignment), drawing (3 pens and a blur brush), emoji and stickers, trimming, mute, HD on/off, and a caption | One flattened image or video, with overlays **baked into the pixels on the phone**, plus the caption as separate text. GIF = a short muted loop (`gifPlayback`) |
| **Text** | Body text, a background colour, one of WhatsApp's 8 fonts (`FONT_NAMES` in `wa.ts`), emoji | `{body, bg ARGB, fg ARGB, font}`, the same fields as a captured text status (`InboxText` → `TextStyle`) |
| **Voice** | Hold to record, listen, record again | Audio (m4a/opus), with the waveform computed |

**Not in the app**, because WhatsApp encodes them as something other than pixels, caption or text
style, or because they don't fit the journal: music and music stickers, layouts/collages,
mentions, questions, "Add Yours", polls, link-preview cards (a URL stays plain text), AI edits,
"view once", and animated stickers on photos. Each of these can come back later as a decision
about the data model.

Additive metadata the UX uses: the overlay texts and sticker names become **alt text** (editable);
a **private original + edit list** is kept so she can re-edit later (§3.13). Neither is ever
published as a layer.

**UX rule that follows from this: WYSIWYG = what the site shows.** The editor preview is drawn by
the same engine that bakes the pixels [A: Skia on both, per the sibling pipeline doc]. The
text-status preview uses the site's font substitutes (`WA_FONTS`) and the site's size scale
(`textStatusScale`: ≤24 / ≤70 / ≤160 code points → xl/lg/md/sm). So the preview is the timeline
slide, pixel for pixel in proportion. Move `textStatusScale` from `frontend/site/src/player/items.ts`
into `@omw/ui` so the app imports the same function.

---

## 1. Principles and what each one changes

| Principle | Concrete consequence |
|---|---|
| **One hand, on the road** | All primary actions sit in the bottom 40 % of the screen (the thumb zone). The capture button is centred, 88 dp. There are no top-corner confirm buttons in the flows. Every sheet opens from the bottom and closes by dragging down. Editor tools that need precision (the colour slider) sit along the side edge, inset from the system back-gesture zone (§6). |
| **Few taps from "something lovely happened" to "posted"** | From the camera: **shutter → send = 2 taps**. The publish options are shown as one line above the send button ("Today · Hội An · on the site in about a minute ›"), not as a form. The sheet opens only when she taps that line. Undo replaces "Are you sure?". |
| **Works offline** | Offline is a normal state, not an error: no dialogs, no red. Every item shows what it is doing in plain words ("Waiting for Wi-Fi"). Nothing in capture, editing, drafts or the journal needs the network. |
| **Never loses anything** | Persist before acknowledge (like the backend's `meta.json` rule): a photo is written to app storage and fsynced **before** the shutter animation finishes. Drafts autosave on every change (300 ms debounce), including the edit list. The outbox survives app kill and reboot. Local originals are deleted only after the server has confirmed the archive copy by sha256. A copy goes into the phone's Photos by default. Back always saves a draft and says so. Disconnecting with unsent items asks first (as the admin's logout does). |
| **Calm** | Rose and violet dawn/dusk surfaces. At most one ambient animation per screen. No confetti, no badges with counts of things to do, no streaks. Notifications are silent. Haptics answer only her own touches (§5). |

---

## 2. Shape of the app

### 2.1 Decision: a soft "Today" home with a big capture button (not straight into the camera)

| | Open straight into the camera | **Today home + big capture button (chosen)** |
|---|---|---|
| Taps to a photo | 0 | 1 (the big button; the camera is pre-warmed on touch-down, so it is ready when the reveal ends) |
| Checking "is it live?" | Behind a swipe | The first thing she sees (sync pill + today's strip) |
| Text status, voice, picking from the gallery in the evening | Detour via the camera | Direct buttons next to the capture button |
| Battery, camera privacy dot, pocket launches | The camera starts on every launch | The camera starts only on intent |
| Feels like | a camera app | her journal, with a camera in it |

Speed is still covered three ways: the setting **"Open straight into the camera"** (off by
default), launcher **app shortcuts** (long-press the icon: Photo · Video · Text · Voice), and later
a Quick Settings tile [A: needs a small native module]. The app is also an **Android share
target** (images, videos, audio, text), so sharing from Google Photos or the system camera lands
directly in the editor.

### 2.2 Map

```
Today (home) ──tap ◉ / swipe up──▶ Camera ──shutter──▶ Editor ──send──▶ Today (item lands in strip)
   │  ├─ [▣] Gallery sheet ───────────────▶ Editor (multi)
   │  ├─ [Aa] Text-status maker ──────────▶ send
   │  ├─ sync pill ──▶ Queue sheet
   │  ├─ place chip ─▶ Day/place sheet
   │  └─ "Journal" ──▶ Journal (my entries, drafts, hidden) ──▶ Entry viewer ──▶ Edit / Hide / Move / Delete
   └─ portrait ─────▶ Settings
Camera and editor are always dark (dusk surfaces on near-black), whatever the theme. Today,
Journal and Settings follow the theme (system / dawn / dusk), like the admin and the site.
```

There is no tab bar. There are only three places (Today, Journal, Settings), and capture is the
centre of Today. This keeps the screen calm and the thumb on one button.

### 2.3 Taps from a moment to "posted"

| Path | Taps |
|---|---|
| App icon → ◉ → shutter → ➤ | 3 |
| Launcher shortcut "Photo" → shutter → ➤ | 2 after the shortcut |
| Gallery: [▣] → pick 3 → Next → ➤ | 6 (1 per photo) |
| Text status: [Aa] → type → ➤ | 2 + typing |
| Share from Google Photos → On My Way → ➤ | 3 |

---

## 3. Flows and screens

Wireframes are for a phone, portrait. `◉` capture, `➤` send, `›` opens something, `[ ]` button,
`( )` radio, `[●]` switch on.

### 3.1 First launch and pairing

Pairing uses **one URL format for every path**: `https://<api-host>/app/pair#<one-time code>`.
The code is in the fragment, so it never reaches server logs or link previews. It is valid for
10 minutes and works once. The app exchanges it for an `app` token (`api_tokens` kind `app`;
flow.md proposes a narrower `capture` scope), which is stored in the Android Keystore-backed
secure store. [A: needs a pairing endpoint and `/.well-known/assetlinks.json` on the API host for
Android App Links. flow.md §3.4 has the admin show the token itself as a QR; the one-time code
is preferred here because a QR on screen or in a screenshot then never carries a long-lived
token, and the same-phone link works. To reconcile, §12]

Why three paths: the traveler's admin PWA usually runs **on this same phone**, and a phone cannot
scan its own screen.

1. **Admin on another screen** (laptop, a helper's phone): it shows the QR, and the app scans it.
2. **Admin on this phone**: Admin → Settings → "Connect the app on this phone" opens the pair URL.
   The App Link opens the app, which is paired with no typing.
3. **Code**: 8 characters (`K7Q2-M9PX`, no 0/O/1/I), typed into the app.

```
① Welcome                          ② Connect                          ③ Hello
┌──────────────────────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────────┐
│                              │   │ ‹                            │   │                              │
│            ✈                 │   │ Connect to your website      │   │         ( portrait )         │
│                              │   │ ┌──────────────────────────┐ │   │                              │
│  On My Way                   │   │ │     camera viewfinder    │ │   │  Hello, Lea                  │
│  your travel journal         │   │ │       ┌────────┐         │ │   │  Connected to "On My Way" ✓  │
│                              │   │ │       │   QR   │         │ │   │                              │
│  Take photos, add a few      │   │ │       └────────┘         │ │   │  Everything you share here   │
│  words, and they appear on   │   │ └──────────────────────────┘ │   │  appears on your website,    │
│  your travel website, even   │   │ In the admin: Settings →     │   │  just like your WhatsApp     │
│  without WhatsApp.           │   │ "Connect a phone"            │   │  statuses.                   │
│                              │   │                              │   │                              │
│                              │   │ The admin is on this phone?  │   │                              │
│ [        Let's go        ]   │   │ [  Open the admin  ]         │   │ [      Start       ]         │
│     Deutsch · English        │   │ Type a code instead          │   │                              │
└──────────────────────────────┘   └──────────────────────────────┘   └──────────────────────────────┘
```

- The language follows the system (de/en), and the welcome screen offers a switch.
- **No permission wall.** The camera, microphone and notification permissions are asked just in
  time: the camera and microphone at the first capture, notifications at the first upload. Each
  request is preceded by one soft sentence ("To take photos, On My Way needs the camera."). If she
  declines, the place where it is needed shows a calm card with "Open settings". Location is never
  required (§3.9).
- On success: the QR frame morphs into a check, CONFIRM haptic, then ③ with her name and portrait
  (`site.author`, `site.avatar`). On an invalid or expired code: REJECT haptic and "This code has
  expired. Show a new one in the admin."
- The first time Today opens, one coach mark pulses gently on ◉ ("Tap to take a photo, hold for a
  video"), and only once.

### 3.2 Today (home)

```
┌──────────────────────────────┐
│ (◔)                 ✓ All live│  portrait → Settings · sync pill → Queue
│                              │
│ Good morning, Lea            │  Fraunces SOFT
│ Wed 18 Nov · day 23          │  Playpen Sans, accent
│ ┌──────────────────────────┐ │
│ │ ◎ Hội An 🇻🇳          ›   │ │  place chip (day place) · "Where are you today?" if empty
│ └──────────────────────────┘ │
│ Today                        │
│ ┌───┐┌───┐┌───┐┌───┐ →       │  polaroids, newest first; small state glyph on each
│ │ ✓ ││ ⏱ ││ ◔ ││Aa │         │  ✓ live · ⏱ appears later · ◔ uploading · Aa text status
│ └───┘└───┘└───┘└───┘         │
│ ✎ 1 draft · "Lanterns at…" › │  only when drafts exist
│                              │
│                              │
│  [▣]        ( ◉ )       [Aa] │  Gallery · Capture 88 dp · Text
│ Gallery    Capture      Text │
│ ───────── Journal ─────────  │  tap, or swipe up from the bottom
└──────────────────────────────┘
```

- The greeting reuses the admin's time-of-day logic (`Greeting` in `home.tsx`).
- The **place chip** reads today's `Day` (place, country). If it's empty, it says "Where are you
  today?". If the device time zone differs from `timezone.current`, a soft lilac card offers the
  switch in one tap (the admin's `TimeZoneNudge`, same copy).
- Hold ◉ to go straight into video recording. Swipe up on ◉ also opens the camera (the reveal
  follows the finger).
- Voice is a mode inside the camera (§3.3), and also an app shortcut. There is no fourth button
  here (calm).
- Empty day: the strip shows one dashed polaroid, "Nothing yet today. The first moment goes
  here." No guilt copy.
- From wave 5 on (followers): small, muted "♥ 12" counts appear under the live polaroids. They are
  never notifications.

### 3.3 Capture (photo, video, hold to record)

```
┌──────────────────────────────┐        recording (hold)
│ ✕                     ⚡A  ⟲ │        ┌──────────────────────────────┐
│                              │        │                    ● 0:12    │  timer; "· 0:48 left" from 0:45
│                              │        │                              │
│         viewfinder           │        │                              │
│   (tap: focus · double tap:  │        │   (slide up/down: zoom)      │
│    flip camera)              │        │                              │
│                              │        │                              │
│                0.6  1×  2×   │        │                              │
│                              │        │                              │
│  [▣]        (  ◯  )          │        │           (( ◉ ))            │  ring fills over 60 s
│  Text · PHOTO · Video · Voice│        │                              │
└──────────────────────────────┘        └──────────────────────────────┘
```

- **Modes** (a rail under the shutter, like WhatsApp's Photo/Video toggle): `Text · Photo · Video ·
  Voice`. Change them by swiping horizontally anywhere on the lower third, or by tapping a label.
  Each change gives a SEGMENT_TICK.
  - **Photo:** tap = photo. Hold = a quick video, recorded while holding. Slide the finger up or
    down while holding to zoom.
  - **Video:** tap to start, tap to stop (hands-free). This is also the accessible way to record
    video.
  - **Text** opens the text-status maker (§3.6). **Voice** opens the voice recorder (§3.7).
- **Length:** the ring fills over **60 s** (WhatsApp's status video limit; 90 s is in beta, so
  the limit is one constant to bump, §12). At the end, recording stops by itself with GESTURE_END.
  There is no error.
- **Volume keys** act as the shutter (Android convention): press = photo, hold = video.
- **Zoom stops** `0.6 · 1× · 2×` are shown only if the device has those lenses. Tap to jump; a
  pinch or vertical drag zooms continuously, with a SEGMENT_TICK when passing a labelled stop.
- **Capture feedback, no white flash:** the viewfinder dims to 85 % for 90 ms, and the shutter
  squishes. The frame is already saved by the time the dim ends. Then the still image stays
  exactly where it is while the editor tools fade in. Nothing jumps.
- **Pull down** on the viewfinder closes the camera back to Today (the stage follows the finger,
  as the site's player does). ✕ does the same.
- Flash: auto/on/off cycles with a label. The front camera uses a screen flash. Flip: ⟲ or a
  double tap.
- **No haptics during recording** (the microphone would pick up the motor). LONG_PRESS fires
  before the recorder starts, and GESTURE_END after it stops (§5).
- Camera permission denied: the viewfinder area shows a calm card, "The camera is off for On My
  Way. [Open settings]", and Text, Voice and Gallery still work.

### 3.4 Pick from the gallery (multi-select)

```
┌──────────────────────────────┐
│  (Today or camera, dimmed)   │
├──────────────────────────────┤  ← sheet, peek at 55 %, drag up to full
│            ───               │
│  Photos   Albums             │  ┐
│  ▢  ▢  ▢  ▢                  │  │ system-rendered embedded photo picker
│  ▢ ①▣  ▢ ②▣                  │  │ (accent = rose-600), includes cloud photos
│  ▢  ▢ ③▣  ▢                  │  ┘
├──────────────────────────────┤
│ ▣▣▣  3 selected   [ Next › ] │  our bar: thumbnails in selection order, tap to unselect
└──────────────────────────────┘
```

- **Android's embedded photo picker**: an in-app grid with continuous selection, rendered by the
  system, with **no storage permission**. It needs Android 14 + SDK Extensions 15. The fallback is
  the classic system picker (full screen, multi-select). Google Play restricts
  `READ_MEDIA_IMAGES/VIDEO` to gallery-type apps, so the app does **not** build its own grid.
  This also means there is no "recent photos" strip in the camera; the Gallery button is the way.
- The order of selection = the order of posting (numbers ①②③). Up to 30 items per batch [A].
- The picker strips GPS from EXIF by default. That is welcome (safety, see the wave-5 threat
  model). The **time taken** survives, stays private, and only drives the "Put it on that day?"
  suggestion (§3.9). The entry's time is the moment of Share.
- Next → the editor, with a thumbnail strip to switch between items (§3.5). Each item keeps its
  own caption and overlays.
- Mixed kinds are fine (photos + videos). Videos longer than 60 s open in the trimmer with the
  first 60 s selected and "Choose the best 60 seconds" written above it.

### 3.5 Editor (photo and video)

```
┌──────────────────────────────┐
│ ‹       ⌗   ☺   Aa   ✎   HD  │  back (= keep as draft) · crop · stickers · text · draw · HD
│ ▕▏▕▏▕▏▕▏▕▏▕▏▕▏▕▏ 0:00–0:42 🔇│  video only: trim strip + mute
│                              │
│        photo / video         │  overlays live on top; tap empty space = add text
│                              │
│            Film              │  filter name, shown for 0.7 s while swiping
│                              │
│ ▣ ▣ ▣  +                     │  multi-item strip (only for 2+ items) · + adds more
│ ┌──────────────────────────┐ │
│ │ Add a caption…        ☺  │ │  caption: separate text, not baked
│ └──────────────────────────┘ │
│ Today · Hội An · on the site │  publish line → publish sheet (§3.10)
│ in about a minute   ›   ( ➤ )│  send
└──────────────────────────────┘
```

**General**
- Swipe left or right on the media (when no tool is open and the touch is not on an overlay) =
  next/previous **filter**. Six gentle filters: `Original · Dawn · Dusk · Film · Mono · Pop`. Also
  available as a chip row in ⌗ (so there is a button too).
- **HD** (WhatsApp's HD toggle): off = standard quality, the WhatsApp-sized artifact that is
  published (fast on the road); on = full resolution. Independent of this, the untouched original
  can follow later on Wi-Fi for the private archive (owner decision A5, suggested; §3.14).
- **Safe zones:** while she drags an overlay into the top 10 % or bottom 18 %, a faint dashed
  guide appears: "Covered by the player's bars here". This is because the site player and
  WhatsApp both draw chrome there.
- **Undo** at every step (↶ appears in the top bar after the first change). Long-press ↶ = "Undo
  all".
- **Back** saves a draft (the item plus the edit list), slides the editor away, and shows a toast:
  "Saved as a draft". It never asks.

**Text overlay** (Aa, or tap on empty media)

```
┌──────────────────────────────┐
│ Done             A ▣A ▣  ≡   │  style: plain / pill / solid · align start-centre-end
│▲                             │
││          Hội An             │  live text, centred; the keyboard is up
││          at night_          │
│▼ size                      ● │  colour slider on the END edge, 32 dp inset
│                            ● │  (tap the top swatch for the full palette)
│ Aa  Aa  Aa  Aa  Aa  Aa  Aa  Aa│  the 8 WhatsApp fonts, each drawn in its own face
│ ┌───────── keyboard ───────┐ │
└──────────────────────────────┘
```

- Fonts: the same 8 as the text status, with the site's substitutes (Calistoga, Exo 2 800, Courier
  Prime 700, Nunito 800, Playpen 500, system sans, system bold, serif). The pixels are baked, so
  this is about recognisability, not encoding.
- Text background style: plain (with a soft shadow) → rounded pill (colour behind the text, white
  text) → solid (white behind coloured text). This mirrors WhatsApp's text background option.
- The size slider runs vertically on the start edge (inset), and pinching works too.
- Done → the text sits on the media. Then drag = move, pinch = scale, two-finger twist = rotate.
  Snap guides at the centre lines and at 0°/±90° (SEGMENT_TICK once per snap). Tap = edit again.
- Drag towards the bottom → the trash target rises. Over it, the overlay shrinks to 60 %
  (GESTURE_THRESHOLD_ACTIVATE); release = deleted (GESTURE_END, plus an undo toast).

**Draw** (✎)
- Three pens (thin, medium, marker) and a **blur brush** (pixelates what she paints over: faces,
  number plates, a hotel name. This is a safety tool, and WhatsApp has the same idea). Colour
  slider as above. ↶ undoes one stroke.
- One finger draws. Two fingers do nothing in draw mode (no accidental zooms).

**Stickers and emoji** (☺): a bottom sheet with two tabs.
- **Emoji**: a searchable grid (system colour emoji, the same font the bake uses), recent first.
- **Journal**: a small set in the site's style: a date stamp ("18 Nov"), a place stamp ("Hội An
  🇻🇳", from the day's place she set; place **name** only, never coordinates), washi tape, a paper
  plane, a heart, a "day 23" tag. The names become alt text.
- Adding a place stamp shows one gentle line, once per day: "Place names are visible to your
  followers once this is published." (flow.md §3.3; the delay protects the rest.)
- Placed stickers behave like text overlays (move, scale, rotate, trash).

**Crop and rotate** (⌗)

```
│ ✕ Cancel                   ✓ │
│    ┌───────────────────┐     │
│    │ rule-of-thirds    │     │  corner handles · drag the image inside the frame
│    └───────────────────┘     │
│   ·  ·  ·  ·  0°  ·  ·  ·  · │  straighten dial ±45° (tick every 5°, snap at 0°)
│ [⟲ 90°] [⇋]  Free 9:16 1:1 4:5 Original │
│ Original Dawn Dusk Film Mono Pop        │  filter chips (the button for the swipe)
```

**Trim** (video): a frame strip with start and end handles. The selection can never exceed 60 s;
the end handle stops there with GESTURE_THRESHOLD_ACTIVATE and the strip says "60 s max". Tap the
strip to scrub the preview; there are no haptics while scrubbing. 🔇 mutes. For clips of 6 s or
less, a "Loop as GIF" switch appears [A: WhatsApp's GIF toggle; verify that it still exists, §12].

### 3.6 Text-status maker

```
┌──────────────────────────────┐
│ ✕                            │
│                              │
│                              │
│        Xin chào              │  background = chosen colour; text white
│        Việt Nam! 🍜          │  size = the site's scale (shrinks as she types)
│                              │
│              ·  ·  ●  ·  ·   │  page dots: swipe left/right = background colour
│                   ⟨ 612 left⟩│  counter only after 600 of 700 characters
│ ☺      Aa      ◐       ( ➤ ) │  emoji · next font · palette · send
└──────────────────────────────┘
```

- **Background:** swipe horizontally for the next or previous colour (crossfade 240 ms,
  SEGMENT_TICK). ◐ opens the full palette as a sheet of named swatches.
- **Font:** tap Aa = next font (the text crossfades into the new face, SEGMENT_TICK). Long-press Aa
  = a chip row with all 8, each drawn in its face.
- **Palette** [A]: about 14 swatches, all ≥ 4.5:1 against white text: WhatsApp's own text-status
  backgrounds (exact ARGB values to be read from real captures in Phase 0, §12), plus 4 family
  colours: rose-600 `#BE4A74`, violet-700 `#5D3FA0`, plum-800 `#3B2341`, dusk `#1B1322`. The text
  colour stays white (`fg` = `#ffffffff`), as WhatsApp does.
- **Limit:** 700 characters [A: third-party figure; verify]. URLs stay plain text (no
  link-preview card).
- There is no caption: the body is the content. Send → the same publish line and sheet as media.

### 3.7 Voice status

```
┌──────────────────────────────┐        after recording
│ ✕                            │        ┌──────────────────────────────┐
│                              │        │ ✕                            │
│   ▁▂▅▇▆▃▂▁▃▅▆▄▂  (live)      │        │   ▁▂▅▇▆▃▂▁▃▅▆▄▂▁▂▃          │
│          0:12                │        │   ▶  0:00 / 0:23             │
│                              │        │                              │
│                       🔒 ↑   │        │  [ Record again ]            │
│   ‹ slide to cancel          │        │                              │
│              ( 🎙 )           │        │ Today · Hội An · …  ›  ( ➤ ) │
└──────────────────────────────┘        └──────────────────────────────┘
```

- Hold 🎙 to record (LONG_PRESS before the recording starts). Slide towards the start side to
  cancel (GESTURE_THRESHOLD_ACTIVATE at the line, then the recording is discarded with GESTURE_END).
  Slide up to 🔒 to lock hands-free (GESTURE_THRESHOLD_ACTIVATE). This is WhatsApp's voice-note
  grammar, so her thumbs already know it.
- Up to 60 s [A: verify]. Tap-to-start/stop through the 🔒 state is the accessible path.
- WhatsApp voice statuses also carry a background colour. The app shows the dusk background until
  the contract can store a colour for voice (§12). There is no picker until then.

### 3.8 Caption and description: decision

| Field | What it is | Language handling |
|---|---|---|
| **Caption** (media) / **body** (text status) | WhatsApp's caption: one text, verbatim, published as typed. It's on the main editor screen | **One language, no picker.** The site already shows captions untranslated (`EntryBase.caption`). Typed in any language, Vietnamese included. |
| **Description** (optional) | The owner annotation (`I18nText` + `origLocale`), the same as the admin's "describe" | Collapsed under "More for the website ›" in the publish sheet or the entry viewer. de/en tabs like the admin's `LocaleTabs`. The **original-language tab is auto-detected** on the device (ML Kit language identification, bundled model, offline). It applies only if confidence ≥ 0.5 and the result is de or en; otherwise the app language is used. Shown as a chip, "Written in English ›", that she can change. No translation in the app. |
| **Alt text** | For screen readers on the site. WhatsApp has the same field (`accessibilityLabel` on image and video messages, flow.md §1.2), so this is WhatsApp-expressible | Pre-filled from the **final, visible** overlay texts + sticker names ("Text: Hội An at night. Sticker: paper plane."). Deleted or covered text never leaks into it. Editable under "More". If empty, the site falls back to description → caption (plan C). |

Why: the WhatsApp-compatible artifact has exactly one caption. Asking for two languages at the
moment of capture would break "few taps". The site already has a path for translations later
(description per locale, "Original: …" label).

### 3.9 Day and place

The default is right without touching anything.
- **Time**: `occurredAt` = the moment she taps **Share** (corrected for clock skew by the API),
  as for a WhatsApp status. It is never the photo's EXIF time, because an old photo would then skip
  the publish delay (flow.md §3.2, binding for the UX).
- **Day** = the local date of that moment in the device zone, using the API's rules
  (`localDateFor`).
- **Older gallery photos:** when the time a photo was taken (kept privately) falls on another day,
  the editor shows one suggestion chip above the publish line: "This photo is from Tue 17 Nov.
  Put it on that day?" [Yes] [No]. Yes writes the existing `localDateOverride` annotation. It
  changes only the placement; the delay clock is untouched. For a batch, one chip covers all items
  of that day: "2 photos are from Tue 17 Nov".
- **Place** belongs to the **day** (the `Day` row: place, country), not to the entry, as in the
  admin. So she sets it once per day, not per photo.

```
├──────────────────────────────┤
│            ───               │
│ Which day?                   │
│ ‹ Mo16  Tu17  [We18]  Th19 › │  week strip, snaps per day (SEGMENT_TICK); dots = has entries
│ Taken on Tue 17 Nov ·        │  only when the time taken ≠ the day of posting
│ [ Put it on that day ]       │
│                              │
│ Where?                       │
│ ┌──────────────────────────┐ │
│ │ ◎ Hội An 🇻🇳              │ │  current day place
│ └──────────────────────────┘ │
│ Recent: Đà Nẵng · Huế · Hanoi│  chips from previous days (offline)
│ [ Type a place… ]            │  free text + country, offline (bundled city list)
│ [ ◎ Suggest from location ]  │  optional: coarse, one-shot, just-in-time permission
│                              │
│ [          Done          ]   │
└──────────────────────────────┘
```

- **Place suggestion** (flow.md §3.3): when today has no place yet, Today's place chip offers
  "Today in Hội An, Vietnam?" [Yes] [Not now]. It uses **coarse** location, one-shot, only while
  the app is open, and is reverse-geocoded **on the device** against a bundled offline city list
  (no Google Geocoder, works offline). Nothing is sent until she confirms. Coordinates never leave
  the phone and never reach an entry. The first suggestion asks for the permission with one
  sentence. If she declines, the chip becomes "Where are you today?" and she types.
- Wave 5 publishes the newest place as country only until a later place is public. Show that
  quietly where it matters: "Followers see 'Vietnam' until you move on."
- With a batch spanning several days, the sheet lists each day with its items ("3 moments · 2
  days").

### 3.10 Publish sheet (now / delayed / review)

This is consistent with the site's `publish.mode` (instant / delayed / review) and the admin's
wording. The default row always describes **what will actually happen**, computed with the shared
`policy.ts`.

```
├──────────────────────────────┤        delayed mode (12 h)            review mode
│            ───               │        ( ) As usual: appears at       ( ) As usual: waits until
│ Share 3 moments              │            21:40 (12 h from now)          you release it
│ ┌──────────────────────────┐ │        (●) Now: skip the delay        (●) Now: on the site in
│ │ 📅 Wed 18 Nov · Hội An  › │ │        ( ) Only for me (hidden)           about a minute
│ └──────────────────────────┘ │                                       ( ) Only for me (hidden)
│ When should it appear?       │
│ (●) As usual: on the site    │
│     in about a minute        │
│ ( ) Hold back: I'll release  │
│     it later                 │
│ ( ) Only for me (hidden)     │
│ Upload: automatically ›      │  per-entry override (A4): automatically / when I tap "Upload now"
│ More for the website ›       │  description de/en, alt text
│ [        Share  ➤        ]   │
└──────────────────────────────┘
```

- Mapping [A, §12]: "As usual" = no override (the policy decides, including wave 5's release slots
  once they land; the row shows the real time). "Now" = explicit `public` (the admin's "Publish
  now"). "Hold back" = `pending` until released from the Journal. "Only for me" = `hidden`. A fourth
  option, "At a time…", needs a per-entry `publishAt` override in the contract. The UX reserves
  the slot and keeps it off until that exists.
- **Upload** row (owner decision A4): shows the default from Settings ("automatically" or "when I
  tap Upload now") and lets her flip it for these entries only. With "Only on Wi-Fi" on and no
  Wi-Fi, the row reads "Upload: automatically, on Wi-Fi" so she knows it will wait.
- Whatever she picks, the publish line in the editor shows it next time (it is remembered per
  session, not forever: the next day starts at "As usual").
- **Share** = CONFIRM haptic at the moment the item is safely in the local outbox (not when it is
  uploaded). The sheet and editor fold into a polaroid that floats into Today's strip, and a toast
  says "Shared · Undo" for 8 s (longer with TalkBack, §7). Undo withdraws it (works in every upload
  state, flow.md §3.4) and turns it back into a draft.
- **Also on WhatsApp status** (only if "Offer WhatsApp sharing" is on in Settings): the toast
  grows into a small done card: "Shared ✓ · [Also on WhatsApp status] · Undo". One tap hands the
  very same baked file + caption to Android's share sheet, where WhatsApp's **"My Status"** target
  opens WhatsApp's own status editor, and she presses send there (flow.md §5.3). There is no
  decision to make before sharing, and nothing extra when she doesn't want it.
  - The app records the hand-off, so the backend suppresses the observer's twin (dedupe, flow.md
    §4).
  - Text statuses go to WhatsApp as an image card (the share sheet cannot carry font and
    background). The card says so: "WhatsApp gets this as a picture."
  - Voice: the button is hidden until audio sharing to "My Status" is verified.
  - If WhatsApp doesn't take the caption, the app copies it and says "Caption copied: paste it in
    WhatsApp."

### 3.11 Queue and sync status

One vocabulary everywhere (strip glyphs, journal tiles, the queue, notifications). It covers the
owner's list in A4 (prepared, waiting for connection, waiting for manual upload, uploading n %,
uploaded, live ✓) and reuses the admin's existing labels, so the two never disagree.

| State | en | de | Glyph |
|---|---|---|---|
| Baking overlays / encoding on the phone | Preparing… | Wird vorbereitet… | ◌ |
| Prepared; manual mode, waits for her tap | Ready to upload | Bereit zum Hochladen | ▢ |
| Waiting for connection: no network, or the API is unreachable | Waiting for network | Wartet aufs Netz (existing) | ☁̸ |
| Waiting for connection: "Only on Wi-Fi" (or videos/originals only on Wi-Fi) and on mobile data | Waiting for Wi-Fi | Wartet aufs WLAN | ≋ |
| Waiting for connection: roaming, and "also while roaming" is off | Waiting for Wi-Fi (roaming) | Wartet aufs WLAN (Roaming) | ≋ |
| Uploading (resumable chunks) | Uploading · 42 % | Wird hochgeladen · 42 % | ◔ |
| The API has it; the home computer hasn't picked it up yet | Uploaded | Hochgeladen | ↑ |
| Backend building / deploying | Publishing… | Wird veröffentlicht… (existing) | ✧ |
| Delayed policy | Appears at 21:40 | Erscheint um 21:40 | ⏱ |
| Review / held back | Waiting for your release | Wartet auf deine Freigabe | ⏸ |
| Hidden | Only for you | Nur für dich | ⊘ |
| On every publish target | Live ✓ | Live ✓ (existing) | ✓ |
| Permanent failure needing her | Needs you | Braucht dich | ! |

```
├──────────────────────────────┤
│            ───               │
│ On its way          [Upload now]│  shown when anything waits for a tap or for Wi-Fi
│ ▣  Preparing…           ◌    │
│ ▣  Ready to upload  [Upload] │  manual mode: per entry, or all with the button above
│ ▣  Waiting for Wi-Fi · 184 MB│
│ ▣  Uploading · 42 %     ◔    │
│ ▣  Uploaded. The website     │
│    updates when your home    │
│    computer is back (offline │
│    since 14:02). It's safe.  │  from the backend heartbeat (StatusResponse)
│ ▣  Appears at 21:40     ⏱    │
│ Originals for your archive   │
│ 6 waiting for Wi-Fi · 410 MB │  phase 2 (A5): private, never blocks publishing
│ Live today                   │
│ ▣ ▣ ▣ ▣  ✓                   │
└──────────────────────────────┘
```

**Upload trigger (owner decision A4)**
- **Automatic** (default [A]): uploads start by themselves when the connection allows.
- **Manual**: entries wait as "Ready to upload" until she taps **Upload now**, per entry or for
  all. The Settings default can be overridden per entry in the publish sheet (§3.10).
- **Only on Wi-Fi** (setting): automatic uploads pause on mobile data and resume on Wi-Fi.
  "Upload now" on mobile data asks **once per tap**: "You're on mobile data. Upload 184 MB
  anyway?" [Upload anyway] [Wait for Wi-Fi]. The finer option "Photos also on mobile data"
  keeps videos and originals on Wi-Fi.
- "Wi-Fi" means **unmetered** (Android network capabilities): a phone hotspot or a metered Wi-Fi
  counts as mobile data, and the state says so: "Waiting for Wi-Fi (this Wi-Fi is metered)".
- **Roaming**: when mobile uploads are allowed but "Also while roaming" is off (the default),
  uploads pause while roaming and the state says "(roaming)".
- **Originals later** (A5, suggested): the WhatsApp-sized artifact goes first, and the untouched
  original + edit list follow on Wi-Fi for the private archive (photos on by default, videos off,
  flow.md §1.2). They have their own quiet line in the queue and never hold back a "Live ✓".

**Mechanics and tone**
- The sync pill on Today summarises it: `✓ All live` · `◔ 2 on their way` · `≋ 2 wait for Wi-Fi`
  · `▢ 3 ready to upload` · `! 1 needs you`. A tap opens the sheet.
- Uploads run as **user-initiated data-transfer jobs** (Android 14+; they require a notification
  and support an "unmetered only" network constraint). They resume after app kill and reboot. The
  notification is silent and not promoted: "On My Way · uploading 2 moments · 63 %". On Android 16
  it uses `ProgressStyle` with one segment per item. When everything is uploaded, the notification
  goes away. There is **no** "Live ✓" notification, because she sees it in the app (calm).
- Errors are explained warmly with the details folded away (the admin's `friendlyError` pattern).
  Automatic retries go on forever while waiting for a connection. Only permanent failures become
  "Needs you", with one clear action.

### 3.12 Drafts

- Everything not yet shared is a draft: unsent captures, text statuses in progress, batches. They
  are created automatically and stored in app-private storage with the full edit list.
- Today shows "✎ 2 drafts ›" (only if any exist). The Journal has a "Drafts" filter.
- A draft opens exactly where she left it (the tool, the selected item of a batch, the caption
  cursor).
- Drafts never expire silently. After 30 days, one gentle line in the Journal: "3 drafts from
  October. Keep or discard?" She decides.
- A draft can be discarded by swiping it away (undo toast) or with "Discard" in its ⋯ menu.

### 3.13 My entries (Journal)

```
┌──────────────────────────────┐        Entry viewer (same rendering as the site player)
│ ‹ Journal                    │        ┌──────────────────────────────┐
│ [All] [Drafts 2] [Waiting]   │        │ ━━━━━━━━ ━━━━ ━━━━          │  segments like the site
│ [Hidden]                     │        │ ‹                       ⋯    │
│ Wed 18 Nov                   │        │                              │  date: Playpen
│ Hội An 🇻🇳 · 6 moments        │        │          photo               │  place: Fraunces SOFT
│ ┌───┐ ┌───┐ ┌───┐            │        │                              │
│ │ ✓ │ │ ⏱ │ │ ⊘ │            │        │ Lanterns everywhere ✨        │  caption
│ └───┘ └───┘ └───┘            │        │ ✓ Live · from the app        │  state + source (app / WhatsApp)
│ ┌───┐ ┌───┐ ┌───┐            │        │ ♥ 12 · 34 views (wave 5)     │
│ └───┘ └───┘ └───┘            │        │ [Edit] [Hide] [Move] [Delete]│
│ Tue 17 Nov · Đà Nẵng         │        └──────────────────────────────┘
└──────────────────────────────┘
```

- The Journal shows **all** entries of each day: from the app and captured from WhatsApp (read
  through the admin API), with a tiny source glyph. It is her journal, wherever the moment came
  from.
- A **tap** opens the viewer (swipe sideways = next/previous entry, swipe down = close, as on the
  site). A **long-press** starts selection (Google Photos convention, LONG_PRESS haptic); dragging
  then selects a range. The bottom bar offers Hide · Show · Move · Delete for the selection.
- **Edit**:
  - App entries with their source + edit list on the phone (30 days by default): the editor
    reopens with the overlays still movable. Re-editing always renders **on the phone** (there is
    no second renderer in the backend, flow.md §1.2). Sharing again uploads a new revision; the
    site entry keeps its id.
  - Older entries whose source is no longer on the phone: caption, description, day and
    visibility are editable now. If the original was archived, "Edit the picture" says: "The
    original is in your home archive. It'll be ready to edit once it's back on the phone."
    [A: fetch path, §12]. If no original was kept (video originals are off by default): "Only the
    published version exists, so the picture can't be re-edited. Everything else can."
  - WhatsApp captures: description, day and visibility only (like the admin's item sheet).
  - A status shared to WhatsApp stays as it was there: "The WhatsApp status doesn't change."
- **Hide / Show** with an undo toast (the admin's `useToggleVisibility` semantics: showing again
  returns to the publish setting; "Publish now" is the explicit release).
- **Move** opens the day sheet (§3.9) and becomes a `localDateOverride`.
- **Delete** (app entries): a dialog, "Delete this moment? It disappears from your website with the
  next update." [Keep] [Delete] → REJECT haptic. The entry leaves the site, and the phone keeps a
  private copy under Journal → ⋯ → "Recently deleted" for 30 days. For WhatsApp captures,
  "Delete" is "Hide" (the archive is the backend's).

### 3.14 Settings

```
┌──────────────────────────────┐
│ ‹ Settings                   │
│ (◔) Lea                      │
│     Connected to "On My Way" │
│ Uploads                      │
│   Start uploads              │
│   (●) Automatically          │  A4 default; the publish sheet can override per entry
│   ( ) When I tap "Upload now"│
│   Only on Wi-Fi          [●] │  never on mobile data (hotspot = mobile data)
│     Photos also on mobile    │  shown when "Only on Wi-Fi" is on: videos and
│     data                 [●] │  originals still wait for Wi-Fi (default [A])
│   Also while roaming     [ ] │  off by default
│   Originals for my archive   │  A5 (suggested): sent later, on Wi-Fi, private
│     Photos [●]  Videos [ ]   │  video originals off by default (size)
│   Keep a copy in Photos  [●] │  camera captures also go to Pictures/On My Way
│ Feel                         │
│   Haptics                [●] │  the system's touch-feedback setting still applies
│   Theme   System · Dawn · Dusk│
│   Language System · DE · EN  │  Android per-app language
│   Open straight into camera[ ]│
│ Privacy                      │
│   App lock   after 5 min  ›  │  fingerprint / face / PIN (system prompt)
│   Time zone  Asia/Ho_Chi_Minh›│  "Use this phone's time zone" in one tap
│ WhatsApp                     │
│   Offer "Also on WhatsApp    │
│   status"                [ ] │  the done card after Share (§3.10)
│ Storage                      │
│   1.2 GB of sent originals › │  "Free up": only items the archive has confirmed
│ Help                         │
│   Send a diagnostic report › │  logs without media or text
│ [ Disconnect this phone ]    │  asks first if anything is unsent
└──────────────────────────────┘
```

- **App lock** (default **on**, after 5 min in the background [A]). The lock protects publishing,
  the Journal and Settings. **Capture and drafts work without unlocking**, so a moment is never
  lost to a lock screen; sharing a draft asks for the unlock. This covers the wave-5 threat "stolen
  phone with a live admin session".
- Publish mode itself (instant/delayed/review) stays in the admin. The app shows it read-only with
  a link: "Publishing: delayed by 12 h (change in the admin ›)". [A: keeps one place of truth]

### 3.15 System surfaces

| Surface | Behaviour |
|---|---|
| Launcher shortcuts | Photo · Video · Text · Voice (static shortcuts). Each opens the matching mode directly. |
| Share target | `image/*`, `video/*`, `audio/*`, `text/plain` → the editor (multi), or the text-status maker for text. |
| Predictive back (target SDK 36: on by default) | Screens use the system's back preview. In the editor, back = save draft + slide away. In sheets, back = close the sheet. |
| Edge-to-edge (mandatory for target SDK 36) | Camera and editor draw under the status and navigation bars. Controls respect the insets. |
| Upload notification | Silent, one channel "Uploads". ProgressStyle on Android 16. Tap → queue sheet. |
| Quick Settings tile (later) | "On My Way: camera" [A: native module]. |

---

## 4. Motion spec

### 4.1 Tokens: the same springs as the site, numerically

The site's springs are Motion `visualDuration` + `bounce` (`@omw/ui/motion`). Motion turns them
into physics as damping ratio ζ = 1 − bounce, stiffness k = (2π / (1.2 · visualDuration))², damping
c = 2ζ√k, mass 1 (`motion-dom@14.14.0`, `animation/generators/spring.mjs`). Reanimated 4 springs
default to **mass 4**, and its `duration` is "perceptual" (actual = 1.5×), so a naive
`withSpring({duration: 350})` would **not** match. Use the physics form with `mass: 1`:

```ts
// @omw/ui/motion-native.ts (generated from SPRINGS so the two can never drift)
import { ReduceMotion } from 'react-native-reanimated';
const physics = (visualDuration: number, bounce = 0) => {
  const zeta = Math.max(1 - bounce, 0.05);
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { stiffness: root * root, damping: 2 * zeta * root, mass: 1, reduceMotion: ReduceMotion.System };
};
export const NATIVE_SPRINGS = {
  soft:   physics(0.35, 0.15), // k 223.8, c 25.43, ζ 0.85 · settles ≈ 0.49 s   cards, sheets, morphs
  snappy: physics(0.2),        // k 685.4, c 52.36, ζ 1.00 · settles ≈ 0.24 s   toggles, chips, press
  float:  physics(0.8, 0.1),   // k 42.8,  c 11.78, ζ 0.90 · settles ≈ 1.05 s   ambient, the send flight
} as const;
```

Tweens: `CROSSFADE` 240 ms `Easing.bezier(0.22, 1, 0.36, 1)` (= `--ease-soft`); `--ease-snappy`
`(0.3, 0.7, 0.4, 1)`; `--ease-float` `(0.45, 0, 0.2, 1)`. **Press**: scale 0.965 over 160 ms
ease-snappy (the admin's `press` utility).

For comparison (third-party summaries of Material 3 Expressive): the standard "default spatial"
spring is about k 700 / ζ 0.9 and the expressive slow one k 200 / ζ 0.8. Our `soft` (k 224, ζ 0.85)
sits at the gentle end of Android's own range, so it feels native but calmer. Bounce stays ≤ 0.15
everywhere: there is no wobble.

### 4.2 Named transitions

| # | Moment | Motion | Token | Reduced motion |
|---|---|---|---|---|
| 1 | ◉ → camera | A circular reveal grows from the button to full screen; the viewfinder fades in under it. The camera is pre-warmed on touch-down | soft (follows the finger on swipe-up) | crossfade 120 ms |
| 2 | Photo taken | Viewfinder dims to 85 % for 90 ms, shutter scales to 0.92 and back | 90 ms in / 160 ms out, snappy | dim only |
| 3 | Camera → editor | The still image stays put; tools fade in, 30 ms stagger, max 4 | snappy, opacity + 6 dp rise | opacity, no stagger |
| 4 | Recording ring | Linear by time (it's a clock, not a spring); rose → violet gradient | linear | the same (it's information) |
| 5 | Mode rail change | The pill slides under the label (admin `layoutId` pill); viewfinder chrome crossfades | snappy | instant |
| 6 | Tool open/close in editor | Toolbars crossfade with an 8 dp slide from their edge | snappy | crossfade 120 ms |
| 7 | Overlay added | Scale 0.9 → 1 at the centre | soft | appears |
| 8 | Overlay drag | Lifts: scale 1.03 + `shadow-lift`; drop settles | soft | no lift |
| 9 | Trash | Target rises from the bottom; over it, the overlay shrinks to 0.6 at 60 % opacity; release: scales into the bin | soft / snappy | target fades; overlay vanishes |
| 10 | Filter swipe | Interactive (follows the finger); commit with release velocity; the name pill shows for 0.7 s | soft | crossfade between filters |
| 11 | Text-status background | Colour crossfade (never a hard cut) | CROSSFADE 240 ms | 120 ms |
| 12 | Font change | Old face fades out with 4 dp up, new face in from 4 dp down | snappy | crossfade |
| 13 | Sheets | Rise from the bottom, follow the drag, dismiss with velocity; scrim 200 ms | soft | fade 120 ms |
| 14 | **Send** | The media folds into a polaroid (−1.2°, like the admin) and flies along a gentle arc into its slot in Today's strip; the strip opens a gap | float | crossfade into place |
| 15 | Upload progress | Ring on the thumbnail fills by bytes, smoothed | snappy (no overshoot) | stepped, no smoothing |
| 16 | Live ✓ | Chip morphs "Publishing…" → "Live"; the check stroke draws | 300 ms ease-soft | instant |
| 17 | First live of the day | A tiny paper plane drifts once across the day card (the site's signature) | float, 1.2 s, once a day | off |
| 18 | Remove from a list (hide, delete, discard) | Height collapses + fades; undo plays it backwards | soft | instant |
| 19 | Pairing success | QR frame → check | soft | instant |
| 20 | Place chip "here now" | `animate-here-now` ring, 2.4 s loop: the only ambient loop on Today | 2.4 s ease-float | off |

### 4.3 Rules

- Animate only `transform` and `opacity`, on the UI thread (Reanimated worklets + Gesture
  Handler). Never animate layout during capture or recording.
- Gesture-driven motion follows the finger 1:1 and hands its velocity to the spring on release.
- **Reduced motion** = Android "Remove animations" (Reanimated `ReduceMotion.System` /
  `useReducedMotion()`): spatial movement becomes ≤ 120 ms opacity, ambient loops and the paper
  plane are off, and the viewer has no Ken Burns. Progress rings and timers keep updating, because
  they carry information.
- At most one ambient animation per screen. Nothing loops in the camera or the editor.
- No camera flash effect, no screen shake, no bounce > 0.15, no parallax.

---

## 5. Haptics map

**Mechanism:** `View.performHapticFeedback` constants, which respect the system "Touch feedback"
setting by default and need no `VIBRATE` permission. Never use the `Vibrator` one-shots that
Android warns are too strong for feedback; expo-haptics' `impactAsync` / `notificationAsync` are
Vibrator-based on Android, so the app does not use them. Use `performAndroidHapticsAsync`
(expo-haptics, SDK 58) for the constants it covers, plus a ~30-line Expo module (`omw-haptics`)
that calls `ViewCompat.performHapticFeedback` with `HapticFeedbackConstantsCompat` for the rest
(`GESTURE_THRESHOLD_ACTIVATE/DEACTIVATE` are not in Expo's enum) and supplies fallbacks below API
34. Remove the `VIBRATE` permission that expo-haptics adds (manifest `tools:node="remove"`).

| Moment | Constant (API) | Feel |
|---|---|---|
| Shutter tap (photo saved) | `VIRTUAL_KEY` (1) | a crisp light click, like a button |
| Hold reaches video (before the recorder starts) | `LONG_PRESS` (0) | "you're holding" |
| Recording stopped, or the 60 s limit reached (after the recorder stops) | `GESTURE_END` (30) | soft end |
| Mode rail change · zoom passes a labelled stop · filter commits · font or background cycles · day strip snaps · publish option chosen | `SEGMENT_TICK` (34) | a tiny tick per discrete step |
| Colour slider crosses a swatch · straighten dial every 5° | `SEGMENT_FREQUENT_TICK` (34) | barely there (may be silent on some devices, which is fine) |
| Snap: centre guide, 0°/±90°, straighten 0° | `SEGMENT_TICK` (34) | once on entering the snap, never while held |
| Overlay picked up (drag starts) | `DRAG_START` (34) | lift |
| Over the trash · over voice "cancel" · voice "lock" reached · trim end at 60 s · journal swipe past the hide/show threshold · pull-to-refresh armed | `GESTURE_THRESHOLD_ACTIVATE` (34) | "release now and it happens" |
| Moved back out of any of those | `GESTURE_THRESHOLD_DEACTIVATE` (34) | its opposite |
| Overlay dropped in the trash · voice cancelled · undo | `GESTURE_END` (30) / `CLOCK_TICK` (21) | small, never alarming |
| **Shared** (item safely in the local outbox) | `CONFIRM` (30) | the one success feeling |
| Pairing succeeded | `CONFIRM` (30) | |
| **Delete a published entry** (dialog confirmed) | `REJECT` (30) | firmer, "careful": the warning the owner asked for |
| Something failed after her tap (expired pairing code, a retry she started failed) | `REJECT` (30) | |
| Settings switches | `TOGGLE_ON` / `TOGGLE_OFF` (34) | |
| Long-press in Journal (selection mode) | `LONG_PRESS` (0) | |

Rules:
1. **Haptics answer only her own touch.** Background events (uploaded, Live ✓, sync) never vibrate.
   "Success on posted" is the moment she taps Share.
2. **Not during recording** (video or voice): the microphone records the motor. Fire before start
   and after stop.
3. Debounce: at most one effect per 100 ms. None on scroll or continuous drags, only at discrete
   events.
4. In-app switch "Haptics" (default on). Off = no calls at all. The system setting is honoured
   automatically.
5. One meaning per constant, used consistently, so the feel becomes learnable (Android guidance).
6. Ordinary buttons (Upload now, Done, Next, sheet options other than discrete pickers) get the
   visual press only, as in standard Android. Haptics are kept for moments that carry meaning.

---

## 6. Gestures map

Every gesture has a visible button and a TalkBack action. A gesture is a shortcut, never the only
way.

| Where | Gesture | Result | Visible alternative | TalkBack custom action |
|---|---|---|---|---|
| Today | Swipe up on ◉ | Open the camera (reveal follows the finger) | Tap ◉ | "Open camera" |
| Today | Hold ◉ | Start a video right away | Camera → Video mode | – |
| Today, Journal | Long-press a tile | Selection mode; drag to select a range | ⋯ → "Select" | "Select" |
| Camera | Tap / hold shutter | Photo / video while holding | Video mode (tap start/stop) | "Take photo", "Start video" |
| Camera | Slide up/down while holding · pinch | Zoom | Zoom stop chips | "Zoom in/out" |
| Camera | Swipe left/right on the lower third | Change mode | Tap the mode label | the rail is a radio group |
| Camera | Double tap the viewfinder | Flip camera | ⟲ | "Switch camera" |
| Camera | Tap the viewfinder | Focus + exposure | – (automatic) | – |
| Camera | Pull down | Close | ✕ | Back |
| Camera | Volume key press / hold | Photo / video | Shutter | – |
| Editor | Swipe left/right on the media | Filter | ⌗ → filter chips | "Next filter", "Previous filter" |
| Editor | Tap empty media | Add text | Aa | "Add text" |
| Overlay | Drag / pinch / twist | Move / scale / rotate (with snapping) | Size slider; ⌗-style rotate buttons in the overlay's mini bar ("⟲ 15°", "Centre") | "Move up/down/left/right", "Bigger", "Smaller", "Rotate", "Centre" |
| Overlay | Drag to the bottom trash | Delete | Mini bar 🗑 | "Delete" |
| Overlay | Tap | Edit the text / sticker | – | "Edit" |
| Text-status maker | Swipe left/right | Background colour | ◐ palette | "Next colour" |
| Text-status maker | Tap / long-press Aa | Next font / all fonts | Long-press list is also in ◐ sheet | "Next font", "Choose font" |
| Voice | Hold 🎙, slide to the start side / up | Record, cancel / lock | Tap 🎙 in the locked mode | "Start recording", "Stop" |
| Viewer | Swipe sideways · swipe down | Next/previous · close | ‹ › buttons appear on tap · ‹ | "Next", "Previous" |
| Journal | Swipe a tile row backward / forward | Hide / show (admin's inbox grammar, mirrored in RTL) | Viewer → Hide/Show | "Hide", "Show" |
| Sheets | Drag down | Close | Back · tap the scrim | Back |
| Queue, Journal | Pull down | Check now | – (it syncs by itself) | – |

**Conflicts with system gestures.** Android's back gesture starts at both screen edges. Rules:
- No horizontal gesture may need to start in the outer 24 dp.
- The colour slider and size slider sit 32 dp inside the edge. Only those two use
  `systemGestureExclusionRects`, and only over their own height (well within Android's 200 dp per
  edge).
- Trim handles get 16 dp of extra touch area inwards, not outwards.

**Gesture priorities in the editor.** A touch on an overlay belongs to the overlay. A one-finger
horizontal drag on empty media = filter. A tap on empty media = add text. Two fingers on empty
media do nothing (no accidental zooming of the photo). In draw mode, one finger draws and nothing
else reacts.

**Discoverability without clutter.** Each gesture hint appears once, the first time the screen is
used, as a small pill with a soft pulsing dot ("Swipe for filters"). It never comes back after
she has used the gesture once. Settings → Help → "Show tips again".

---

## 7. Accessibility, RTL, languages

**TalkBack**
- Every control has a de/en label and a role. State chips read as text ("Live", "Waiting for
  Wi-Fi"), not only icons.
- Queue changes are announced politely in a live region ("2 of 3 uploaded") and grouped, never per
  percent.
- The shutter reads as "Take photo. Double-tap and hold for video." Video mode is the
  non-gesture path.
- On the editor canvas, each overlay is a node in z-order, with the custom actions from §6.
  Drawing is inherently visual. Text and stickers are the accessible ways to annotate, and alt
  text (§3.8) is offered after send if there are overlays and no alt text.
- Toasts with Undo stay at least 8 s, or longer: Android's recommended timeout for accessibility
  users (`AccessibilityManager.getRecommendedTimeoutMillis`).
- Focus order follows the visual order. Opening a sheet moves focus into it, and closing it
  returns focus to the trigger (as the site player does).

**Font scaling** (Android 14+ scales non-linearly up to 200 %)
- Today, Journal, sheets and Settings reflow at 200 % with no truncation of essential text (the
  greeting may wrap, the strip becomes 2 rows of larger tiles).
- Camera and editor chrome: icons keep their size, and labels cap at 1.3× (`maxFontSizeMultiplier`)
  so the viewfinder stays usable. Every icon still has a label for TalkBack.
- The text-status and overlay **content** does not scale with the system font (it is the
  artwork); the UI around it does.

**Contrast and targets**
- Tokens from `@omw/ui` (ink 13.3:1, accent with white 4.75:1, the admin's `success-strong` ≥ 6:1
  for "Live" chips).
- Chrome over photos: white icons on a 24 % black radial scrim + 1 dp shadow, so they work on snow
  and on night shots.
- Text-status palette: every swatch ≥ 4.5:1 with white.
- Touch targets ≥ 48 dp (Material) with ≥ 8 dp spacing. Shutter 80 dp, ◉ 88 dp, send 64 dp.
- Colour is never the only signal: states have glyph + word, and palette swatches have names for
  TalkBack ("Rose", "Plum", "Sea").

**RTL readiness** (ar is a dev pseudo-locale now, as on the site)
- Layout uses start/end everywhere (React Native `I18nManager` + logical styles). Only directional
  icons flip (‹ › ➤).
- Horizontal swipes use the site's `forwardSign` (forward = next). The text-status background
  pager and the filter swipe follow it.
- User text uses `writingDirection: 'auto'` (the equivalent of `dir="auto"`). Caption and overlay
  text are typed in her direction, independent of the UI.
- Not mirrored: the video **trim timeline** and media progress (Material: media direction is the
  tape, not time), the camera viewfinder, and pixel coordinates of overlays. Mirrored: the
  stories-style segment bars in the viewer, to match the site player (`origin-left
  rtl:origin-right`).
- QA in the pseudo-ar locale from day one.

**Languages**
- de + en at launch, Lingui catalogs like the admin (the app's own `messages.po`). German uses
  "du" and the admin's warm tone ("Was geht dir gerade durch den Kopf?").
- Android per-app language (Settings → Language) or system. Dates and times through the shared
  `@omw/ui/locale` formatters, in the traveler's zone.

---

## 8. What makes it feel "really easy and modern"

1. **The camera is warm before she asks**: pre-warmed on touch-down of ◉, kept warm for 10 s after
   the editor closes (a second shot is instant).
2. **Two taps, shutter → send.** The publish options are a sentence, not a form.
3. **The preview is the website**: same fonts, same text-status scale, the safe-zone guide for
   the player bars. No surprises after publishing.
4. **The send lands somewhere**: the polaroid flies into today's strip, where she can watch it
   become "Live ✓". This builds the right mental model ("it's here, it's on its way").
5. **Offline is a non-event**: no error dialogs, just plain states, with sizes ("184 MB"), and
   her choice of automatic or "Upload now" (A4), Wi-Fi only and roaming respected without
   questions.
6. **Undo instead of "Are you sure?"**, everywhere except deleting something live.
7. **Back never loses work**: it saves a draft and says so in four words.
8. **The day knows where she is**: one offline suggestion ("Today in Hội An, Vietnam?") at most
   once a day, recent places one tap away, and older gallery photos offered for their own day.
9. **Thumb-first**: everything that matters is in the bottom 40 %, and sheets come from below.
10. **WhatsApp muscle memory**: hold to record, slide to cancel, slide up to lock, swipe for
    filters, the side colour slider. She already knows the grammar.
11. **Haptics with meaning**: one vocabulary, quiet, never during recording.
12. **The keyboard moves with the content**: the caption field rides on the IME animation
    (window-insets-synchronised), and the media scales down smoothly instead of being covered.
13. **Edge-to-edge camera and editor** with predictive back. The app behaves like a current
    Android app, not a web view.
14. **Locks protect publishing, not moments**: capture works without unlocking.
15. **Privacy by default, gently**: GPS stripped, place as a chosen label, a blur brush for faces
    and plates, the delayed mode explained at the point of sharing ("appears at 21:40").
16. **One family**: Fraunces SOFT headings, Nunito UI, Playpen for dates and greetings, rose and
    violet dawn/dusk, polaroids with a slight tilt, washi tape on empty states, the paper plane once
    a day.
17. **Silent progress**: a quiet ProgressStyle notification while uploading, nothing when done.
18. **Nothing to manage**: no inbox counts, no "to-do". Drafts surface only if they exist.

---

## 9. Visual details (family resemblance)

- **Surfaces:** Today and Journal use `bg` with the admin's `app-backdrop` (a dawn glow at top
  start, lilac at bottom end) and `paper-grain`. Cards use `rounded-card` (24 dp) and `shadow-soft`.
  Sheets use `rounded-sheet` (32 dp) top corners.
- **Polaroids:** `polaroid` frame, −1.2° tilt in strips (the inbox look), the caption in Playpen
  below.
- **Type:** Fraunces SOFT 600 for titles (static instance [A: React Native on Android can't set
  arbitrary variable axes reliably, so ship static cuts like the site does for Playpen]), Nunito
  400/700/800 for the UI, Playpen 400/500 for dates, greetings and the empty states.
- **Buttons:** pill shape, `accent` fill with white (dawn) or dark (dusk) text, press squish 0.965.
  ◉ is a rose-600 → violet-700 gradient (the admin's logo tile), with a 4 dp `bg` ring.
- **Camera and editor:** near-black `#120C17` stage, dusk `surface` at 88 % with blur for toolbars,
  white glyphs with soft shadows, the accent only on the active tool and on ➤.
- **Icons:** the admin's line style (24 grid, 1.8 stroke, rounded joins), ported to SVG components.

---

## 10. Copy deck (core strings)

| Key | en | de |
|---|---|---|
| capture.hint | Tap for a photo, hold for a video | Tippen für ein Foto, halten für ein Video |
| editor.caption | Add a caption… | Bildunterschrift hinzufügen… |
| editor.back | Saved as a draft | Als Entwurf gespeichert |
| publish.line.instant | Today · {place} · on the site in about a minute | Heute · {place} · in etwa einer Minute auf der Seite |
| publish.line.delayed | Appears at {time} | Erscheint um {time} |
| publish.line.review | Waits until you release it | Wartet, bis du es freigibst |
| publish.now | Now: skip the delay | Jetzt: ohne Verzögerung |
| publish.hold | Hold back: I'll release it later | Zurückhalten: ich gebe es später frei |
| publish.hidden | Only for me (hidden) | Nur für mich (versteckt) |
| publish.share | Share | Teilen |
| toast.shared | Shared · Undo | Geteilt · Rückgängig |
| queue.ready | Ready to upload | Bereit zum Hochladen |
| queue.uploadNow | Upload now | Jetzt hochladen |
| queue.wifi | Waiting for Wi-Fi · {size} | Wartet aufs WLAN · {size} |
| queue.roaming | Waiting for Wi-Fi (roaming) | Wartet aufs WLAN (Roaming) |
| queue.mobileAsk | You're on mobile data. Upload {size} anyway? | Du bist im Mobilfunk. Trotzdem {size} hochladen? |
| queue.mobileYes / No | Upload anyway / Wait for Wi-Fi | Trotzdem hochladen / Aufs WLAN warten |
| queue.home | Uploaded. The website updates when your home computer is back. It's safe. | Hochgeladen. Die Seite wird aktualisiert, sobald dein Computer zu Hause wieder da ist. Es ist sicher. |
| queue.release | Waiting for your release | Wartet auf deine Freigabe |
| pill.all | All live | Alles live |
| place.ask | Where are you today? | Wo bist du heute? |
| place.suggest | Today in {city}, {country}? | Heute in {city}, {country}? |
| day.taken | This photo is from {day}. Put it on that day? | Dieses Foto ist vom {day}. Auf diesen Tag legen? |
| done.whatsapp | Also on WhatsApp status | Auch als WhatsApp-Status |
| done.textAsImage | WhatsApp gets this as a picture. | WhatsApp bekommt das als Bild. |
| delete.title | Delete this moment? | Diesen Moment löschen? |
| delete.body | It disappears from your website with the next update. | Er verschwindet mit dem nächsten Update von deiner Seite. |
| lock.capture | You can take photos now. Unlock to share. | Du kannst schon fotografieren. Zum Teilen entsperren. |
| pair.expired | This code has expired. Show a new one in the admin. | Dieser Code ist abgelaufen. Zeig im Admin einen neuen an. |

---

## 11. Acceptance checks (UX)

1. From a cold start, ◉ → shutter → ➤ on the traveler's phone: the camera is ready when the reveal
   ends (≤ 400 ms target [A]), and the item shows "Shared" ≤ 300 ms after ➤ (photo).
2. Kill the app right after the shutter: the photo is in Drafts on the next start. Kill it during
   an upload: the upload resumes without starting over.
3. Flight mode for a day of capturing: no error dialog, all states correct; Wi-Fi brings
   everything to "Live ✓" without a tap (automatic mode). In manual mode, the entries stay "Ready to
   upload" until "Upload now". With "Only on Wi-Fi", a phone hotspot does not start uploads, and
   "Upload now" on it asks once. While roaming with "Also while roaming" off, nothing goes over
   mobile data.
4. With "Remove animations" on: no spatial motion, everything still understandable.
5. TalkBack: post a photo with a text overlay, move the overlay, set the day, share. No gesture
   is required.
6. Font size 200 %: Today, sheets and Settings with no clipped essential text.
7. Pseudo-ar: swipes, pagers and back arrows mirrored; the trim timeline not mirrored.
8. Haptics: none while recording; none from background events; system touch feedback off = none.
9. The text-status preview and the site's `TextSlide` match for 5 lengths × 8 fonts (screenshot
   diff at the same aspect ratio).

---

## 12. Needs from the sibling documents (open questions)

| # | Question | UX default meanwhile |
|---|---|---|
| 1 | Per-entry visibility for "Hold back" (`pending` with an explicit override?) and a per-entry `publishAt` for "At a time…" | Three options; "At a time…" hidden |
| 2 | ~~`occurredAt` of gallery picks~~ **Settled by flow.md §3.2**: the moment of "Share"; the time taken only suggests a `localDateOverride` | Implemented in §3.9 |
| 3 | A background colour for voice statuses (WhatsApp sends one) | Fixed dusk background, no picker |
| 4 | Alt text field on the entry (flow.md §1.2 keeps it) and where the site reads it | Collected from the final visible layers; editable |
| 5 | Dedupe for "Also on WhatsApp status" (flow.md §4: hand-off marker + perceptual hash) | The done card is offered only once dedupe is live |
| 6 | Pairing: a one-time code exchanged for a token (this doc) vs. the token itself in the QR (flow.md §3.4); `assetlinks.json` on the API host; the `capture` scope, and whether it may read WhatsApp captures for the Journal | One-time code. Without read access to captures, the Journal shows app entries only |
| 7 | Limits to verify on the traveler's phone (Phase 0): video 60 s vs 90 s, text 700, caption 1024, voice 60 s, the GIF toggle for ≤ 6 s; the "My Status" share target, caption via `EXTRA_TEXT`, audio shares | Constants in one file; the clipboard fallback for the caption |
| 8 | WhatsApp's exact text-status background palette (ARGB) | 4 family colours + placeholders |
| 9 | Re-editing when the source is no longer on the phone (a fetch path from the archive via the API?) | Caption/meta edit only, plus the honest message |
| 10 | Link previews in text statuses | Out (a URL stays text) |
| 11 | The editor/bake engine (Skia) and video flattening (Media3 Transformer 1.11, flow.md §8), needed for the "Preparing…" time budget | "Preparing…" state with progress, never blocking the UI |
| 12 | Defaults for A4/A5: automatic upload; "Only on Wi-Fi" on with "Photos also on mobile data" on (photos go anywhere, videos and originals wait for Wi-Fi); "Also while roaming" off; photo originals on, video originals off | As in §3.14, marked [A] |

Assumptions to confirm: the traveler's phone runs **Android 14 or newer** (embedded photo picker,
the `SEGMENT_TICK`/threshold haptics; older versions get the fallbacks named above); one traveler
and one paired phone; de/en only.

---

## 13. Tech assumptions this UX relies on (checked 2026-11-20)

- Expo SDK 58 (React Native 0.88), Reanimated 4.x springs with `ReduceMotion`, expo-haptics v58
  `performAndroidHapticsAsync` / `AndroidHaptics`.
- Android 16 target: predictive back on by default, edge-to-edge without an opt-out,
  `ProgressStyle` notifications. Android 14: user-initiated data-transfer jobs, non-linear font
  scaling to 200 %. Embedded photo picker: Android 14 + SDK Extensions 15.
- Google Play restricts broad photo/video permissions, hence the system picker.

---

## 14. Sources

- WhatsApp status features: [WhatsApp blog, "More ways to express yourself on Status" (2025-05-29)](https://blog.whatsapp.com/more-ways-to-express-yourself-on-Status) · [Meta newsroom: music, layout, stickers](https://about.fb.com/news/2025/05/new-music-layout-sticker-options-whatsapp-status/) · [WhatsApp blog feature roundup (status stickers)](https://blog.whatsapp.com/new-feature-roundup-missed-call-messages-new-status-stickers-and-more) · [GSMArena: 2026 stickers and layout](https://m.gsmarena.com/whatsapp_rolls_out_new_year_2026_stickers_video_call_effects_and_more-news-70898.php) · [WhatsApp FAQ: create a status (Android)](https://faq.whatsapp.com/en/android/26000031)
- Status limits (third-party, to verify): [Android Authority: 60 s video status](https://androidauthority.com/whatsapp-video-status-3427340) · [Green-API: 90 s test](https://green-api.com/en/blog/2025/whatsapp-increases-status-length-to-90-seconds/) · [9to5Mac: music clips 30 s (2026-09)](https://9to5mac.com/2026/09/08/whatsapp-doubles-music-clip-length-for-status-updates/) · [GSMArena: 1-minute voice status](https://www.gsmarena.com/whatsapp_now_supports_oneminute_long_voice_status_updates-news-63025.php) · [typecount: 700 / 1,024 characters](https://typecount.com/blog/whatsapp-character-limit)
- WhatsApp "My Status" share target (via flow.md §5.3): [WABetaInfo 2.25.20.3](https://wabetainfo.com/whatsapp-beta-for-android-2-25-20-3-whats-new/) · Coarse location accuracy: [Android location permissions](https://developer.android.com/develop/sensors-and-location/location/permissions)
- WhatsApp editor tools: [WABetaInfo 2.23.3.4 (text editor, fonts)](https://wabetainfo.com/whatsapp-beta-for-android-2-23-3-4-whats-new/) · [Android Police: drawing tools](https://www.androidpolice.com/whatsapp-working-on-new-drawing-tools-for-images-and-videos/) · [WABetaInfo: blur tool](https://wabetainfo.com/whatsapp-is-working-on-a-blur-tool-for-the-media-editor/)
- Haptics: [Android: haptic feedback (View constants respect touch-feedback settings; avoid Vibrator one-shots)](https://developer.android.com/develop/ui/views/haptics/haptic-feedback) · [HapticFeedbackConstants](https://developer.android.com/reference/android/view/HapticFeedbackConstants) · [HapticFeedbackConstantsCompat](https://developer.android.com/reference/androidx/core/view/HapticFeedbackConstantsCompat) · [Android haptics UX foundation](https://source.android.com/docs/core/interaction/haptics/haptics-ux-foundation) · [expo-haptics v58](https://docs.expo.dev/versions/latest/sdk/haptics.md)
- Motion: [Reanimated 4 withSpring (perceptual duration, mass 4 default, ReduceMotion)](https://docs.swmansion.com/react-native-reanimated/docs/animations/withSpring/) · Motion spring math: `node_modules/.pnpm/motion-dom@14.14.0/.../animation/generators/spring.mjs` (local) · M3 Expressive spring values (third-party): [M3EMotion](https://pub.dev/documentation/m3e_slider/0.0.2/common_m3e_common/M3EMotion-class.html)
- Platform: [Expo SDK 58 changelog](https://expo.dev/changelog/sdk-58) · [Android 16 behavior changes (predictive back, edge-to-edge)](https://developer.android.com/about/versions/16/behavior-changes-16) · [Progress-centric notifications](https://developer.android.com/about/versions/16/features/progress-centric-notifications) · [User-initiated data transfer](https://developer.android.com/develop/background-work/background-tasks/uidt) · [Embedded photo picker](https://developer.android.com/training/data-storage/shared/photo-picker/embedded) · [Play photo/video permissions policy](https://support.google.com/googleplay/android-developer/answer/14115180) · [Android Authority: photo picker strips location](https://www.androidauthority.com/android-photo-picker-location-3683074/) · [ML Kit language identification (Android)](https://developers.google.com/ml-kit/language/identification/android)
- Bidirectionality: [Material bidirectionality (media progress not mirrored)](https://m2.material.io/go/design-bidirectionality) · [AOSP commit forcing media SeekBar LTR](https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/413150f2ada870c62b769d29646990805cb43a49)
- Accessibility (not fetched this session, standard references): [Android 14 non-linear font scaling](https://developer.android.com/about/versions/14/features#non-linear-font-scaling) · [Gesture navigation and exclusion rects](https://developer.android.com/develop/ui/views/touch-and-input/gestures/gesturenav) · [React Native accessibility actions](https://reactnative.dev/docs/accessibility#accessibility-actions)
