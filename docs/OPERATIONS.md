# Operations

Running the backend day to day: on this Mac first, on an always-on server later. WhatsApp linking
is in [OBSERVER.md](OBSERVER.md); the code and all settings are described in
[backend/README.md](../backend/README.md).

## What runs where

| Piece | Where | State |
|---|---|---|
| Backend container `omw-backend` | this Mac (Docker Desktop / OrbStack), later any Linux host | named volume `omw_omw-state` → `/data` (SQLite store, WhatsApp session, inbox); bind mount `backend/data/` (archive, generated site, publish config, media variants) |
| Static site | any static host (SFTP target) | rebuilt from the backend at any time |
| PHP API (optional) | any PHP host | owner content (primary!), its own backups (`api/var/backups`) |

Precious data: **`backend/data/archive/`** (every original status + metadata; `backend reprocess`
rebuilds everything else from it), **the API database** (owner notes, stories, settings), and
**`/data/wa/session.db`** (only saves a relink). Everything in `backend/data/out` and
`backend/data/media` can be regenerated.

## Run on the Mac by hand (Node, current live setup)

Owner decision (2026-11-23): the live backend runs with Node on this Mac, started by hand, with
WhatsApp off. App moments are archived at home and published on the gated site (since 2026-11-23). Start it with `scripts/live-backend.sh` (foreground,
Ctrl-C stops it cleanly). The same script runs any CLI command with the live configuration, e.g.
`scripts/live-backend.sh status` or `scripts/live-backend.sh publish --force`.
- **Private values:** `.secrets/live-backend.env` (`SITE_PUBLIC_URL` with the content folder,
  `API_BASE_URL`, `ACCESS_STORE_DIR`, `CONTROL_TOKEN`) and the backend token
  `.secrets/api-backend-token`.
- **State:** in `backend/data/`. The publish target, with its SFTP password, is in
  `backend/data/config/targets.json`.
- **Settings it runs with:** `WA_MODE=off` means no WhatsApp at all, so moments come only from the
  traveler app. `APP_PUBLISH=true` publishes app moments on the gated site, following the publish
  settings (instant, delayed, review); set it to `false` to go back to archive-only.
- **While it's stopped:** her moments wait in the API's app inbox (about 1 GB budget). The admin
  shows "backend silent" after 15 minutes; that is expected.
- Don't run the old fixture preview (`.cache/live-preview/`) at the same time: it publishes to the same
  target, and the script refuses to start while it runs.

## Run on the Mac (Docker)

Before the first start, put at least `CONTROL_TOKEN` (generate one with `openssl rand -base64 32`)
and `TRAVELER_PHONE` into the repository-root `.env` (read literally, never `source`d; all
variables are in the header of [backend/compose.yaml](../backend/compose.yaml)). Without them the
container exits with a configuration error and restarts in a loop. **`SFTP_*` values in `.env`
create a publish target on the first start and deploy the site there automatically**; leave them
out to add targets in the control UI instead. Keys only host tools use (`API_SFTP_*`,
`OPENAI_KEY`, …) are blanked by compose.yaml and never reach the container.

```sh
cd backend
docker compose up -d --build        # build the image and start (cold build ~5-7 min, image ~785 MB)
docker compose ps                   # "healthy" within ~10 s
open http://127.0.0.1:8787          # control UI, log in with CONTROL_TOKEN
```

The control UI is published on 127.0.0.1 only. The image (Debian 13 trixie) runs Node 24 as the
unprivileged user `node` (uid 1000) under tini, with Debian's ffmpeg 7.1 and the Go helper built in.
On a Docker Desktop shared with other projects, build with the project's own builder so its cache
stays separate (`docker compose build --builder omw-builder`, then `docker compose up -d`; setup
in [backend/README.md](../backend/README.md#docker)). A cold build needs ~6-7 GB free in Docker's VM.

Mac settings: Docker Desktop/OrbStack "start at login"; keep the Mac awake on power
(`sudo pmset -c sleep 0`, see OBSERVER.md); Docker's VM needs enough disk for the archive.

Without Docker (development): `pnpm --filter @omw/backend dev` (fixture mode) — see the README.

Check the image without a phone: `scripts/docker-e2e.sh` (from the repository root; needs
`pnpm install`, `pnpm fixtures` and Playwright's Chromium) builds `omw-backend:dev`, runs it with
compose in fixture mode as project `omw-e2e` (never touches the `omw` project, its container or
its volume, and never reads `.env`), waits for capture → media → site → local publish, runs the
generated-site Playwright spec against the published folder, checks a graceful stop and an
idempotent restart, and removes what it created. Ports 127.0.0.1:19180/19181
(`OMW_DOCKER_CONTROL_PORT`, `OMW_DOCKER_SITE_PORT`); `--help` lists the options.

Demo without a phone: `docker compose --profile demo up --build backend-demo` replays the
synthetic fixtures (built into the `demo` image) into `backend/data/demo/` (token
`omw-demo-control-token`, no publish target, no API). Stop `backend` first: both use port 8787.
To look at the result, serve `backend/data/demo/out` with the generator's static server from the
repository root (it handles `404.html` and byte ranges like a real host):
`TSX_DISABLE_CACHE=1 node --conditions=@omw/source --import tsx backend/src/generator/cli.ts serve --dir backend/data/demo/out --port 4173`,
then open http://127.0.0.1:4173/.

## Everyday commands

```sh
docker compose logs -f --since 10m backend           # JSON log lines (pino)
docker compose exec backend backend status           # one-screen health summary
docker compose exec backend backend status --json
docker compose exec backend backend generate --full  # rebuild the whole site
docker compose exec backend backend publish          # deploy now (all enabled targets)
docker compose exec backend backend publish --target sftp-main
docker compose exec backend backend reprocess        # re-run the media pipeline from the archive
docker compose restart backend                       # restart (graceful: SIGTERM, 60 s grace)
```

Use `exec` (the running container) for one-shot commands, not `docker compose run`. The
process lock `DATA_DIR/backend.lock` carries a heartbeat (refreshed every 10 s): a one-shot
writer (`generate`, `publish`, `reprocess`, `owner-import`) in another container refuses while the
daemon's heartbeat is younger than 30 s, with "The backend daemon is running (host …); use
`docker compose exec backend backend …`". Read-only `status` still works. `run` is only for
commands while the backend is stopped (backups below).

The control UI shows the same: **Overview** (health), **Queue** (stuck captures with retry/skip,
failing API pushes, quarantined owner changes), **Publish** (targets, rebuild, publish now, last
deploy), **Logs** (live tail of the last 2000 lines and the event log).

Log levels: `LOG_LEVEL=debug` in `.env` and `docker compose up -d` to apply. Docker keeps 5 × 10 MB
of logs per container.

## Relink WhatsApp

When the Overview shows `logged_out` (or after replacing the observer phone):

1. Make sure the observer phone is online and WhatsApp is open on it.
2. Control UI → Link WhatsApp → scan the new QR code (or use the pairing code).
3. If no QR appears within a minute: "Restart WhatsApp helper" on the same page, then check Logs.

Statuses posted while unlinked arrive after relinking only if they are still live; check the
Queue for `media_lost` items afterwards.

## Publish targets

Control UI → **Publish** → Add a target:

- **SFTP**: host, port, user, password or private key (pasted, or a file in `backend/data/config/`
  referenced relative to it), pinned host-key fingerprints (`SHA256:…`; built-in pins exist for
  known hosts; "trust on first use" pins the first key seen), remote root, public URL of the site
  (enables the post-deploy check of `/data/manifest.json`). Use **Test** before the first publish.
- **Local folder**: for development, or a folder another tool syncs.

Secrets are stored only in `backend/data/config/targets.json` (mode 0600) and never shown again,
logged or sent to the API. After an SSH authentication failure the target is blocked (no login
loops that could get the IP banned) until it is saved again.

Deploys are incremental and crash-safe (files first, `manifest.json` last; obsolete media deleted
right away, old assets after 7 days). A deploy runs after every site change; failed deploys retry
after 1, 2, 4 … 30 min, and every start completes an interrupted deploy. Files on the target get
mode 0644 and directories 0755 (set explicitly, whatever the host's umask). The publisher keeps
its file list next to the site as `/.omw-deploy.json.gz` (gzip, re-uploaded only when it changes;
older versions wrote `/.omw-deploy.json`, which is read once and then removed); the generated
`.htaccess` denies every dotfile.

**Mass-delete guard.** A deploy that would delete at least half of the files on the target (when
more than 20 are there) or every day (`data/days/*.json`) is refused: "refused: would delete X
of Y remote files; use backend publish --force". That protects the live site from an empty or
lost store. When the deletion is really wanted (e.g. the owner hid every day of a young site):
`docker compose exec backend backend publish --force`.

**Publishing paused.** `backend status` (and the control UI) show why deploys wait:
- "restoring N captures from the archive": the store was empty and is being rebuilt (below);
- "waiting for first owner-content sync": an API is configured and the owner mirror has not
  completed one pull of the change feed since it was created or rebuilt (no timeout: publishing
  without the owner's hide/move decisions could publish hidden items). A backend that synced once
  keeps publishing when the API is down;
- "restored from the archive without owner content: …": see the restore drill.

**CDN.** Media is served `Cache-Control: private, max-age=31536000, immutable`, so shared caches
never keep it; the publisher deletes the files of hidden or revoked items at once. If you ever put
a CDN in front of the static host, purge it on every hide and revoke (and check that it honours
`private`).

## Followers and access

Wave 5: only people the traveler invited see the site. Hosting, store and configuration:
[HOSTING.md §11](HOSTING.md#11-access-gate-wave-5-approval-only-followers); what is stored about
followers: [PRIVACY.md](PRIVACY.md). Everything below happens in the admin PWA (*Einstellungen →
Menschen & Zugang / Sicherheit / Datenschutzhinweise*) unless it says otherwise.

**Before the first invitation** (once): publish the privacy notice version 1 (*Datenschutzhinweise*:
name and e-mail of the person responsible; the texts are templates, not legal advice; joins are
refused while no version is published), then *Menschen → "Website-Speicher einrichten"*.

| Task | In the admin | What happens |
|---|---|---|
| Invite a person | *Menschen → Person einladen*, name → **Link erstellen**, then *Teilen* (WhatsApp) or *Link kopieren* | The link `https://<site>/_/join/#t=…` is shown **once**. The person sees an information screen ("Dieser Link ist für Oma." + the privacy notice) and joins with *Weiter*; consent is recorded. |
| A new device waits | Push "📱 1 neues Gerät wartet" → *Start*: **Erlauben** / **Ablehnen** (or the person's screen) | Every device after a person's first one waits for you (Q3 c). Allow only devices you can match to the person (label like "iPhone · Safari", time). At most `ACCESS_MAX_DEVICES` (5) active devices: remove one first. |
| New link (lost or forwarded) | person → **Neuen Link erstellen** | The old link stops working at once; devices that joined stay. |
| Remove a device | person → device → **Entfernen** | That device sees the neutral page from its next request; the others keep access. |
| End a person's access | person → **Zugang beenden** | All her devices are out; her data stays (D8). Also take her out of your WhatsApp status audience. |
| Delete everything about a person | person → **Löschen …** (tick the box) | Devices, consents and the name are erased; a nameless tombstone keeps the id from being reused. Followers can do the same themselves under *Deine Daten* ("Eine Person hat ihre Daten gelöscht" appears on Start). |
| Export a person's data | person → **Daten exportieren** | JSON `omw-follower-data/1` (answer to a data request by mail or phone). |
| Lock the site for everyone | *Start* or *Sicherheit* → **Jetzt sperren**; unlock with **Entsperren** + your password | Everyone, followers included, sees the neutral page; no cookies are cleared, so unlocking needs no re-join. |
| Lock without logging in | *Sicherheit → Panik-Link erstellen* (shown once; keep it like a password) | Opening the panic link and tapping *Website jetzt sperren* locks the site through the API. Unlock only in the admin. |
| Lock from the Mac | control UI → Publish → **Website sperren** | Writes the lock straight into the store over SFTP (works with the API down). Needs a target with a store path (`accessStoreRoot`); not available while no login can reach the store (HOSTING §11.6). |
| Change the privacy text | *Datenschutzhinweise* → edit → save → **Als Version N veröffentlichen** | Followers read and confirm the new version on their next visit. The button stays off while the saved text equals the current version (nobody has to confirm an unchanged text). |
| Change your password | *Einstellungen → Passwort ändern* | Every other session ends (app tokens too when ticked). Lost password: `scripts/deploy-api.ts --reset-admin-password` (HOSTING §7). |

**"Wirksam ✓" / "Noch nicht wirksam ⏳".** Every access action says whether it is already in the
store Apache checks. With the live writer (`direct`) it is in effect within a second. "Noch nicht
wirksam" means the writer could not reach the store: the API retries every 5 minutes (and the Mac
after 60 s when it has a store target); *Erneut versuchen* retries at once. "Nicht gesendet –
keine Verbindung" means the phone never reached the API: nothing happened, tap again when online.

**"Zugang nicht geprüft" / alert "access store unverified".** A writer found no store marker (or
one of another store), or the post-deploy check showed that a session it wrote is not seen by
Apache. Check that the API's and the backend's `ACCESS_STORE_DIR` name the same folder; after a
webspace restore that removed the store, run *Website-Speicher einrichten* again (devices resume
with their device key, nobody has to re-join).

**After a restore** of the API database: open *Menschen* and read the "after a restore" card. The
restore resets every personal link (a link replaced after the backup must not work again) and the
panic link; connected devices stay connected. Create a new link for each person the card lists who
wants to add a device, create the panic link again, and reset the admin password if you changed it
after the backup (HOSTING §8).

**Known residual of Q3 c (accepted):** whoever opens a fresh personal link **first** gets that
person's first device without your approval. If a link was forwarded before the person used it,
you will see a device you do not expect: remove it and create a new link. Until you do, that
device can read, export and delete the person's data under *Deine Daten*.

**Followers' side** (`https://<site>/_/…`, no app, no account): *Deine Daten* (via the menu on the
site) shows what is stored, exports it and has "Mich und alle meine Daten löschen" with a
deliberate confirmation; *Auf diesem Gerät abmelden* ends only that device. A waiting device sees
only itself there and can withdraw its request.

## Backups

| What | How |
|---|---|
| Archive | `backend/data/archive/` is a plain folder: include it in Time Machine / restic / rsync. |
| Backend store + WhatsApp session | volume `omw_omw-state`. The store can be rebuilt (`backend reprocess` + the API change feed); a copy saves time and a relink. In `backend/`: `docker compose stop backend`, then `docker compose run --rm --no-deps -T --entrypoint tar backend czf - -C /data . > omw-state.tgz`, then `docker compose start backend`. |
| Publish config | `backend/data/config/` (contains secrets — encrypt your backup) |
| API | nightly `VACUUM INTO` snapshots in `api/var/backups/` on the PHP host. With `API_BASE_URL` set, the backend pulls the newest one home once a day (`GET /api/v1/backend/backup/latest`, sha256-verified) into `DATA_DIR/api-backups/<date>-<sha8>.sqlite` (state volume, mode 0600; the newest `API_BACKUP_KEEP` = 7 are kept). Copy them out with the state volume, or `docker compose cp backend:/data/api-backups ./api-backups`. To restore the API from one: stop the API (maintenance), replace `api/var/app.sqlite` with the file (owner `www-data`/the PHP user, mode 0600), start it. If the restored API answers the backend with another feed id or a feed reset, the backend rebuilds its owner mirror by itself (and publishes only after that rebuild completed). |

Private data is owner-only: `backend/data/archive` (originals with their location data, raw
metadata of hidden statuses) and everything in `DATA_DIR` (store, inbox, session, API backups) is
written 0600 (directories 0700); `OUT_DIR` and `MEDIA_DIR` stay world-readable (0644/0755). A
backend from before this rule tightens `ARCHIVE_DIR` and `DATA_DIR` once at start (logged); on a
Linux host you can also do it by hand: `chmod -R go-rwx backend/data/archive` (and the volume).

**Restore drill** (lost state volume, new machine, Docker Desktop reset). The backend restores by
itself: a store without captures next to an archive with records is rebuilt from the archive at
start ("restoring N captures from the archive"), deploys stay paused until that work is drained,
the site version continues above the published one, and the mass-delete guard refuses anything
that would wipe the target. Still, follow this order:

1. Pause publishing first: restore `backend/data/config`, then disable the targets (control UI →
   Publish → edit → uncheck "enabled"), or keep `targets.json` aside until step 5.
2. Restore `backend/data/archive` (and `.env`), then `docker compose up -d`. Without a store the
   automatic restore starts; `backend reprocess` does the same by hand (also for a damaged store).
3. Wait until `backend status` shows nothing in the pipeline (no "restoring …").
4. Owner content: with an API, wait until the first change-feed pull completed ("waiting for first
   owner-content sync" is gone). Without an API it was in the lost store: `docker compose stop
   backend`, `docker compose run --rm backend backend owner-import <file>` (the last export), start
   again. After an automatic restore without an API, deploys stay paused until a manual publish.
5. Enable the targets, then `docker compose exec backend backend publish`. Check the result: the
   guard refuses a deploy that would delete most of the site; only use `publish --force` when that
   is really intended.

## Upgrades

```sh
git pull
cd backend && docker compose up -d --build
```

The store migrates itself (it refuses to open a database newer than the code). A new site build
or generator version regenerates all pages on the next start. When the contracts version changes,
deploy the API first (plan section D). The API and admin may also be ahead of the backend for a
while (e.g. the owner saves new "About you" settings first): an older backend skips feed items it
does not know yet and remembers their kinds; once upgraded, it replays the owner feed once at
startup (log: "feed items an older version ignored are known now"), so nothing has to be saved
again.

## Moving to a server

The image builds for linux/arm64 and linux/amd64 (`docker buildx build --platform linux/amd64 -f backend/Dockerfile -t omw-backend .`
from the repository root; on the server itself `docker compose up --build` builds natively).
All connections are outbound (WhatsApp, SFTP, API), so any small VPS works.

1. On the Mac: `cd backend && docker compose stop backend` (a linked device must never run twice:
   that ends in `stream_replaced`).
2. Copy the repository (or just `backend/`, `.env`, and build there), `backend/data/` (archive,
   config, media, out) and the state volume (tar it as shown under Backups; restoring the session
   avoids a relink).
3. On the server, in `backend/`: `docker compose build`, restore the volume
   (`docker compose run --rm --no-deps -T --entrypoint tar backend xzf - -C /data < omw-state.tgz`;
   compose creates `omw_omw-state` itself), `sudo chown -R 1000:1000 data`, then
   `docker compose up -d`.
4. Reach the control UI through an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 server`, then
   http://127.0.0.1:8787). For a VPN or reverse-proxy name, add it to `CONTROL_ALLOWED_HOSTS` and
   put TLS in front; never publish port 8787 on a public interface.
5. Check Overview: WhatsApp `open`, sync in order, then post a test status.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Container `unhealthy` / restarting | `docker compose logs backend` — configuration errors are printed at start (e.g. missing `CONTROL_TOKEN` or `TRAVELER_PHONE`). |
| "Another backend already runs on this DATA_DIR" | a second `backend start` inside the same container (e.g. via `exec`); stop it. A lock of another container counts as held while its heartbeat is younger than 30 s (a replaced container waits for that); older locks are taken over automatically. |
| "The backend daemon is running (host …); use docker compose exec …" | a one-shot command in a separate container (`docker compose run`) next to the running backend: use `exec`. |
| "refused: would delete X of Y remote files" | the mass-delete guard (Publish targets). Find out why the site shrank (empty store, a restore in progress, the owner hid everything); `backend publish --force` only when intended. |
| Publishing paused | `backend status` names the reason (Publish targets → "Publishing paused"). |
| Site not updating | Overview → Site (generate error?) and Publish (last deploy error, next retry); Queue for stuck captures. |
| API sync "token rejected" | create a new backend token in the admin (Settings → Tokens), put it into `API_TOKEN`, restart. |
| Quarantined owner changes | the API is newer than the backend: update the backend. |
| Disk filling up | `backend/data/archive` grows ~10 GB/year; the heartbeat reports free disk to the API (alerts). `backend status` shows the free space Docker's VM has left (Docker Desktop: Settings → Resources → disk limit). |
| `ENOSPC` / "no space left on device" in the logs | Docker Desktop's VM disk is full (often build cache: `docker system df`, `docker buildx du`). Free space there (`docker builder prune` removes the build cache of **every** project), or raise the disk limit. |
| "wa-helper: another wa-helper is using <dir> (Docker and a manual run?)" | two WhatsApp helpers on one data directory (e.g. the Docker backend and a manual Phase-0 run): stop the other one, then restart the helper in the control UI (Link WhatsApp). The helper exits 2 without touching the session; see `backend/wa-helper/README.md` ("One helper per data directory"; the lock does not work across Docker Desktop bind mounts). |
