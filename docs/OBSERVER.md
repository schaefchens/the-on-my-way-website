# Observer setup

How to connect the backend to WhatsApp (plan A8). The backend never touches the traveler's own
account: it is a **linked device of a second WhatsApp account, the "observer"**, which has the
traveler as a contact and therefore sees the traveler's statuses. The backend keeps only statuses
whose sender is the traveler; everything else is counted and dropped.

```
Traveler's phone ──status──▶ WhatsApp ──▶ observer account (spare phone at home = primary device)
                                                │ linked device "On My Way"
                                                ▼
                                   backend (wa-helper, whatsmeow)
```

## 1. Get a second number and phone

1. Get a SIM or eSIM with its own number (a cheap prepaid plan is fine; it must receive one SMS
   or call for registration, and stay active — some prepaid numbers expire when unused).
2. Install WhatsApp on a **spare phone** and register the new number. This phone is the
   observer's primary device. (WhatsApp Business works too.)
3. Set a neutral profile name and photo, e.g. "On My Way".

## 2. Make the traveler's statuses visible to the observer

WhatsApp shows a status only to people who are in the poster's contacts **and** allowed by the
status privacy setting. Both directions matter:

1. On the **observer phone**: save the traveler's number as a contact.
2. On the **traveler's phone**: save the observer number as a contact.
3. On the **traveler's phone**: WhatsApp → Updates (Status) → ⋮ → Status privacy. Use
   "My contacts", or "My contacts except…" without the observer, or "Only share with…" including
   the observer.
4. Check: let the traveler post a test status; it must appear under Updates on the observer phone.

## 3. Keep the observer phone healthy

Linked devices stay linked only while the primary phone is alive:

- Keep it **on the charger and on Wi-Fi**, permanently. Mobile data off is fine.
- Turn **battery optimisation off** for WhatsApp (Android: Settings → Apps → WhatsApp → Battery →
  Unrestricted; iOS: Background App Refresh on).
- **Open WhatsApp on the observer phone at least once a week.** WhatsApp logs linked devices out
  after about 14 days without the primary phone being online.
- Notifications may stay on; the backend never sends presence or read receipts (unless
  `SEND_READ_RECEIPT=true`), so the phone keeps getting its notifications.
- Don't use the observer account for chatting, and never link a second backend to it.

## 4. Configure and start the backend

In `.env` at the repository root (Docker reads it; see [OPERATIONS.md](OPERATIONS.md)):

```
# the TRAVELER's number, international format, digits only
TRAVELER_PHONE=4915112345678
CONTROL_TOKEN=<long random string, e.g. from: openssl rand -base64 32>
WA_MODE=observer
```

Docker reads this file literally: comments only on their own line (a `# …` after a value
becomes part of the value), no quotes, no `export`. `WA_MODE=observer` is the default in Docker.

Start it with Docker: `cd backend && docker compose up -d --build` (see
[OPERATIONS.md](OPERATIONS.md); `SFTP_*` values in `.env` also create a publish target and deploy).
Open **http://127.0.0.1:8787** and log in with `CONTROL_TOKEN`.

Without Docker (on the Mac), `.env` is **not** read: build the helper once
(`make -C backend/wa-helper build`, Go 1.26) and pass the variables on the command line, from the
repository root:
`WA_MODE=observer TRAVELER_PHONE=4915112345678 pnpm --filter @omw/backend dev` (development
token `omw-dev-control-token`, state in `backend/data/`). Use one or the other, never both: the
observer account must only ever be linked to one backend.

## 5. Link

**QR code (recommended):**

1. Control UI → **Link WhatsApp**. The QR code appears within a few seconds and refreshes by
   itself (codes expire after ~20–60 s).
2. On the **observer phone**: WhatsApp → Settings → **Linked devices** → **Link a device** → scan.
3. The state switches to **open**. The device shows up as "On My Way" on the phone.

**Pairing code (no camera, or the backend runs elsewhere):**

1. Control UI → Link WhatsApp → "…or use a pairing code": enter the **observer's** own number
   (international format), or run `backend pair-code +49151…` (in Docker:
   `docker compose exec backend backend pair-code +49151…`).
2. On the observer phone: Linked devices → Link a device → **Link with phone number instead**,
   enter the 8-character code.

After linking, statuses that are still live (less than 24 h old) arrive through history sync.

## 6. Smoke test

1. The traveler posts a photo status.
2. Control UI → Overview: **Traveler match** shows the LID as "learned" after the first status,
   "Last status" updates, and the capture appears (Queue → nothing stuck).
3. Within about a minute: Site → new version generated, Publish → deployed (with a target), and
   the status is on the static site.
4. The traveler deletes the status ("Delete for everyone"): it disappears from the site, media
   included (`ingest.on_revoke=hide`, the default).

## Keep the computer awake (Mac)

Media of a status must be downloaded while WhatsApp still has it (roughly 24 h after posting,
sometimes less). Statuses posted while the backend sleeps arrive later as offline messages, but
their media may already be gone (`media_lost`). So:

- Run Docker Desktop or OrbStack, set to start at login; the container restarts by itself
  (`restart: unless-stopped`).
- Prevent sleep **on power**: `sudo pmset -c sleep 0` (display sleep is fine:
  `sudo pmset -c displaysleep 10`), or System Settings → Energy → "Prevent automatic sleeping
  when the display is off". Alternatively a LaunchAgent running `caffeinate -s`.
- Never let the Mac sleep for more than ~12 h, and don't close the lid of a laptop without an
  external display. Move the backend to an always-on host early ([OPERATIONS.md](OPERATIONS.md)).

## When things go wrong

| Control UI shows | Meaning | Do |
|---|---|---|
| `qr` | not linked | link (step 5) |
| `closed`, reason `disconnected` | network hiccup | nothing; it reconnects |
| `logged_out` | the phone removed the device, or 14 days offline | open WhatsApp on the observer phone, then relink |
| `stream_replaced` | another client took over this session | make sure only one backend runs on this session; restart |
| `banned` (temporary) | WhatsApp rate limit / ban | wait until "Ban until"; do not relink in a loop |
| `error`, `client_outdated` | whatsmeow too old | update the backend image (helper pin) |
| LID "not learned yet" for days | no status from the traveler matched | check step 2 (contacts + privacy) and `TRAVELER_PHONE` |
| "Other senders ignored" grows, nothing captured | statuses of other contacts arrive, the traveler's don't | same as above |
| captures stuck in `awaiting_media` | download pending/retrying | keep the observer phone online (media retry goes through it); after `MEDIA_GIVE_UP_HOURS` they become `media_lost` |

Relinking is safe: the archive, the store and the site are untouched; only the WhatsApp session
in `/data/wa` is replaced.
