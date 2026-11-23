# Owner decisions: follower access and social features (2026-11-20)

These are authoritative and override the research notes and proposal drafts.

## Access
- **D1 Approval-only.** Only people the traveler approved see the site. There is no public layer and no hybrid. A shared password is not acceptable as the main mechanism.
- **D2 Per-person revocation.** She revokes any single person's access later, from the admin, without affecting the others.
- **D3 Zero information without access.** Nothing personal and nothing fetchable reaches anyone without access, including through link previews, robots.txt, the sitemap and error pages. Only a neutral "request access" page is allowed.
- **D4 Gate split (preferred; depends on host tests).**
  - The API host (PHP) does all the logic: invite links, joining, device registration, the device limit, the device list, revocation and alerts.
  - The site host is only Apache + `.htaccess`. On every request it checks whether a file for the device's cookie exists in a hidden, denied folder.
  - The API creates and deletes these files on the site host over SFTP (phpseclib), ideally with a dedicated SFTP account restricted to that folder.
  - Joining: the invite link points to the site (secret in the `#fragment`). A static join page sends the secret to the API by `fetch`. The API registers the device, writes its file and returns a handoff. The site host's `.htaccess` sets the long-lived cookie (`CO` flag) and redirects into the timeline.
  - Fallback if the `CO`-from-backreference test fails on Hetzner: a tiny PHP file on the site host only for setting the cookie.
- **D5 CDN.** None for now. The upgrade path is Bunny with token authentication (SHA256, `token_path=/media/`, short-lived per-device tokens) for media only, while HTML and data stay behind the origin gate. All gated responses are `Cache-Control: private`.

## Identity and social
- **D6 Stable follower ID.**
  - Each follower has a unique, opaque, never-reused ID. All data references this ID: devices, reactions, views, messages, activity.
  - The name and other details are resolved from the ID.
  - She gives the person a name when she creates their invite link.
  - Devices and sessions are children of the follower ID.
- **D7 Reactions.** Followers see only counts. The traveler sees counts and who reacted.
- **D8 Revocation keeps data.** Past reactions, views and messages of a revoked follower stay and keep counting. Only access ends.
- **D9 Activity overview.** It exists for the traveler: per-follower activity (visits, times, patterns) to understand patterns and spot unusual behavior.
- **D10 Views and impressions analytics.**
  - Useful across the site: per follower and in aggregate. Which days and items were opened, views per item, impressions (items seen in the timeline), player plays and completion.
  - First-party only, through the API, with no third-party trackers.
  - Viewing must never depend on it: batch the events and tolerate the API being down.
  - Mind the tiny PHP worker pool on shared hosting.

## Joining and data rights
- **D11 Information first.** When someone opens their invite link, they first see an information screen before anything else, and join only after confirming it ("Continue"; not a pre-ticked box). The screen states:
  * what is collected under their stable ID: devices, visits and times, views and impressions per day and item, slideshow plays, reactions, messages;
  * who sees it (the traveler sees names; other followers see only counts);
  * why it is collected and how long it is kept (kept after access ends, until deletion);
  * their rights, including the delete-me button;
  * who is responsible, and a contact.
  The text is in de and en and versioned. The API stores which version a follower confirmed and when. A changed text is shown again on the next visit.
  The "request access" page for non-followers shows its own short privacy note for the request form.
- **D12 Delete me (required).**
  * Every follower has a "Delete me and all my data" button on the site (in a small "Your data" screen, which also shows what is stored about them and can export it).
  * It needs a deliberate confirmation step. It then revokes all their devices at once and erases everything that references their ID: devices, views, impressions, activity, reactions (so counts drop), messages, and the request.
  * Left behind: an anonymous tombstone (ID, "deleted on <date>", no name), so the ID is never reused, and a notice to the traveler ("A follower deleted their data").
  * The admin has the same "Delete all data of this person" action for requests that come in by other channels.
  * This is the one exception to D8 (revocation keeps data): deletion is not revocation.

## Contact
- Non-followers get only the "request access" form.
- Approved followers get a contact button and form; their identity is known, so there are no name or e-mail fields.

## Answers to the proposal's decisions (2026-11-20, after proposal.md)

These override proposal.md where they differ.
- **Q0 → b: strictly API-only.**
  - **No PHP on the site host:**
    - The site host runs only Apache + `.htaccess`, which checks the device cookie against the session files.
    - The API (PHP) does all the logic: links, joining, devices, approvals, revocation, lock, forms. It writes and deletes the session files on the site host.
      * **Write path:** directly, if P0b shows one shared account and filesystem. Otherwise over SFTP with phpseclib.
      * **Fallback writer:** the Mac over SFTP.
  - **Joining needs the API to be up:**
    - The join page, the info screen and the request form are static pages on the site. They talk to the API by fetch (CORS, only the site origin).
    - The cookie is set by Apache's `CO` flag from a handoff, so it can't use the `__Host-` prefix.
    - Verify in P0b that `CO` works with a backreference. If it doesn't, the fallback (only while site and API share a registrable domain) is that the API sets a cookie scoped to the shared parent domain. Document what that costs.
  - Accept the weaker cookies; document the trade-offs.
- **Q1: not answered yet.**
  - Make it configurable.
  - Keep the existing publish modes (instant/delayed/review).
  - Add the new options as settings, all off by default: release slots (e.g. twice a day) and the departure hold (≤ 7 days, a "moved on" tap).
  - The default stays as now (instant) until the owner says otherwise.
- **Q2 → a + an option to hide.** City plus the "here now" badge as now, with a setting to hide the badge. Optionally also "only country" (offer it as a choice: city+badge / country only / nothing).
- **Q3 → c.** Every device after a follower's first one waits for the owner's OK in the admin, which shows a pending-device list and sends a notification.
- **Q4 → a + e-mail.**
  - The owner sends each personal link herself (WhatsApp / share sheet).
  - Followers MAY give an e-mail address and opt in to optional e-mail notifications (e.g. new entries). This needs double opt-in and an unsubscribe link in every mail.
  - The e-mail lives under the follower ID and is erased by delete-me.
- **Q5 → a.** No replies through the site at first.
- **Q6 → a.**
  - **Login:** one admin login, which the traveler uses too. There is no separate traveler role and no co-admin.
  - **Lock:** the lock switch is in the admin.
  - **Panic link (optional):** a secret URL handled by the API that locks the site without logging in. Include it only if cheap.
- **Q7 → configurable.** The privacy notice data (responsible person, contact address and e-mail, texts for the request form and the info screen in de/en) are settings the owner maintains in the admin. They are versioned for D11 consent records. Ship sensible template texts that are marked "not legal advice".
- **Q8 → a.** No co-admin; new devices and links wait for the owner.
- **Q9 → configurable domain, existing domain for now.**
  - Keep the-on-my-way-website.schaefchens.de now.
  - Nothing may hardcode it: site origin, API CORS origin and cookie settings all come from config.
  - Document the constraint that site and API should share a registrable domain for the cookie fallback and for same-site identity requests (D6/D7). Note what breaks otherwise.

## Implementation split (orchestrator)
- **Wave 5:**
  - P0 safety fixes that need no decision:
    * remove lat/lng from the published data;
    * hashed post IDs;
    * neutral OG previews;
    * the portrait not bypassing the delay;
    * trip end date min(planned, last public day);
    * time buckets only if configurable (off by default, owner-configurable).
  - Configurable safety options (Q1/Q2).
  - The access gate (Q0 b).
  - Follower IDs, personal links, device approval (Q3 c), revocation, lock.
  - Info screen + consent records (D11) and privacy settings (Q7).
  - "Your data" with export and delete-me (D12).
  - The neutral pages.
  - The configurable domain (Q9).
- **Wave 6:**
  - Request-access form for strangers and the owner's request inbox.
  - Followers' contact messages (Q5 a: no replies).
  - Follower e-mail + double opt-in notifications (Q4).
  - Reactions (counts; the owner sees names).
  - Views/impressions analytics and the activity overview.

## Added to wave 5 (2026-11-20, found missing by the owner)
- **Change password in the admin** (there is none today):
  - Settings → "Change password": the current password + a new one (min. 12 characters, strength hint), Argon2id (bcrypt fallback), rate-limited.
  - On success, every other session is ended.
  - API endpoint: PUT /api/v1/admin/me/password (CSRF).
- **Recovery:** `scripts/deploy-api.ts --reset-admin-password` generates a new random password, ships only its hash through var/bootstrap.json (like --set-admin-email), and writes the clear text to .secrets/api-admin.txt.
