# Owner decisions: traveler app (2026-11-20)

These are authoritative and override the research notes and plan drafts.

- **A1 Android first** (the traveler's phone is Android); iOS later. React Native.
- **A2 WhatsApp-status compatible data model.**
  - Overlays (text, drawing, emoji/stickers, crop, filters) are baked into the photo or video on the device. The caption is separate text.
  - Text statuses are text + background ARGB + WhatsApp's font enum (the same fields as `wa.ts`). Voice statuses are audio.
  - There is no layer model on the site. Only additive metadata is allowed: alt text, a source marker, an optional private original + edit list.
- **A3 Offline first.** Everything is prepared on the phone without a connection: editing, flattening, compressing. Uploads go in small resumable chunks, which matters on slow mobile data.
- **A4 Upload trigger.** Two ways, chosen by the traveler:
  * **Automatic:** upload starts by itself when there is a connection (optionally only on Wi-Fi, e.g. for videos);
  * **Manual:** entries wait on the phone until she taps "Upload now" later (per entry or all at once).
  
  A setting holds the default, and the publish sheet can override it per entry.
  * **Wi-Fi only (setting):** "Upload only on Wi-Fi, never on mobile data", for all uploads.
    - When it is on, automatic uploads pause on mobile data and resume on Wi-Fi. "Upload now" on mobile data asks once ("You're on mobile data, upload anyway?").
    - Optional finer control: photos also on mobile data, videos/originals only on Wi-Fi.
    - Detect it with Android's network capabilities: treat "unmetered" as Wi-Fi, so a phone hotspot or metered Wi-Fi counts as mobile data. Also pause while roaming if mobile uploads are allowed but roaming isn't (a separate toggle "also while roaming", off by default). The queue always shows the state of each entry: prepared, waiting for connection, waiting for manual upload, uploading n %, uploaded, live ✓.
- **A5 (suggested, not yet confirmed).** Send a WhatsApp-sized version first and upload the full-quality originals later on Wi-Fi for the archive.

## Answers to app-plan.md decisions (2026-11-20)

These override app-plan.md where they differ.
- **Context:** the traveler is ALREADY TRAVELING. This raises the priority of capture (Phase 0 observer) and of the app's archive-only mode.
- **Q1 → b.** From v1.1, "Also on WhatsApp" hands the same baked picture and caption to WhatsApp through an explicit intent, and she presses send herself. No backend posting with her number.
- **Q2 → c, full backup.**
  - Photo AND video originals go to the private home archive (on Wi-Fi, per Q6).
  - Reason: phones get lost and their storage fills up fast.
  - Implied follow-up (suggested, to confirm): once the home archive has verified a backup (checksum), the app may offer "free up space on the phone".
  - The API transit inbox must handle large videos within its disk budget: stream them through in chunks, and the backend pulls them promptly.
- **Q3 → c.** "Edit again" after a moment is live, keeping reactions (v1.1).
- **Q4 → a.** A lost or stolen phone's app token can share and hide only her own moments, and needs a fingerprint for anything that loosens visibility.
- **Q5 → b + owner reasoning.** "WhatsApp status is only active 24h anyways but the website is permanent." The site keeps the moment when the WhatsApp copy is deleted.
  - Note: the 24 h expiry never removes anything. Only an active delete (revoke) does, through the setting `ingest.on_revoke` (default hide).
  - Changing that default to keep is to be confirmed with the owner.
- **Q6 → c.** The default is automatic, Wi-Fi only for everything. Roaming off.
- **Q7 → a.** Google Play internal testing. The accounts already exist.
- **Q8 → a.** Archive-only use before the wave-5 gate: entries reach the home archive, and nothing is published until the gate passes.
- **Q9 → a.** "Now" from the phone only for her own app moments, with a fingerprint.
- **Q10 → the app asks.** The app asks whether she wants to mark that she moved on (the input to the departure hold). Exact wording and timing per the UX spec: an evening prompt "Staying here tonight? / Moved on".
- **Q11 → b.** The owner's "Publish now" wins: a later WhatsApp delete does not remove it from the site.
- **Q5 follow-up (owner, 2026-11-20): "do hide".**
  - `ingest.on_revoke` stays `hide` by default: an active delete on WhatsApp hides the moment on the site (protection against "oops" posts). The 24 h expiry never removes anything.
  - The setting stays switchable in the admin.
  - Q11 b stands: an explicit owner "Publish now" override still wins over a later WhatsApp delete (policy rule 1).
