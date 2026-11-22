# On My Way

Turns a traveler's WhatsApp status posts into a multilingual, zoomable travel timeline that's lovely to look at. The site is published as static files, so it runs on any web host.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Node.js + TypeScript in Docker, with a tiny Go helper built on [whatsmeow](https://github.com/tulir/whatsmeow). It captures the traveler's statuses through an observer WhatsApp number, processes the media, generates the static site and pushes it over SFTP. |
| `frontend/` | React + TypeScript (Vite): the public timeline (`site/`) and the owner's admin PWA (`admin/`). |
| `api/` | PHP 8.3 + Slim 4 + SQLite: owner content, admin backend, alerts. Not needed to view the site. |
| `packages/contracts/` | zod schemas shared by all parts, exported as JSON Schema for PHP. |
| `scripts/` | API deploy (`deploy-api.ts`), project-local Composer, the Docker fixture e2e (`docker-e2e.sh`), the handwriting-font subsetting (`fonts/`). |
| `docs/` | Plan and runbooks. |

## Getting started (Mac)

Needs Node 24 or newer (`.nvmrc`; the backend image runs Node 24), pnpm 10.13.1 (the
`packageManager` in `package.json`: `corepack enable pnpm` on Node 24, or
`npm install -g pnpm@10.13.1`), ffmpeg (Homebrew), and Docker Desktop or OrbStack for the backend.
Go 1.26 is only needed to run the WhatsApp helper outside Docker, PHP 8.3+ only for the API. All
tool caches stay in the git-ignored `.cache/` (see `.npmrc`).

```sh
pnpm install --frozen-lockfile     # all workspaces
pnpm fixtures                      # synthetic WhatsApp statuses -> fixtures/generated (uses ffmpeg)
PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm exec playwright install --only-shell chromium
scripts/docker-e2e.sh              # build the backend image, run capture -> site -> publish in Docker, test the site
```

`scripts/docker-e2e.sh` needs no phone, no API and no `.env`; it cleans up after itself and
keeps the image `omw-backend:dev` (~785 MB, Debian 13 trixie with ffmpeg 7.1). It builds with the
project's own buildx builder `omw-builder`; a cold build needs about 6-7 GB of free Docker disk at
its peak, and `docker buildx prune --builder omw-builder --reserved-space 2gb -f` trims the cache
afterwards. Then, depending on what you want to do:

| Goal | Read |
|---|---|
| Run the backend in Docker day to day, backups, moving to a server | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Link the observer WhatsApp number | [docs/OBSERVER.md](docs/OBSERVER.md) |
| Static host and PHP API: setup, deploy, cron, restore | [docs/HOSTING.md](docs/HOSTING.md), [api/README.md](api/README.md) |
| Backend development, configuration, CLI, control UI | [backend/README.md](backend/README.md) |
| Site and admin development | [frontend/README.md](frontend/README.md) |
| Followers and the access gate: hosting, runbooks, what is stored | [docs/HOSTING.md §11](docs/HOSTING.md#11-access-gate-wave-5-approval-only-followers), [docs/OPERATIONS.md](docs/OPERATIONS.md#followers-and-access), [docs/PRIVACY.md](docs/PRIVACY.md) |

Checks: `pnpm typecheck`, `pnpm test`, `pnpm lint` (Biome), `pnpm schemas:check` (contracts →
`api/schemas`); PHP: `scripts/composer test` and `scripts/composer stan`.

Secrets live only in the repo's `.env` (read literally by the tools, never `source`d) and in
`.secrets/`; both are git-ignored.

## Traveler app toolchain (Android)

The traveler app lives in `frontend/app` (`@omw/app`, Expo SDK 58; see
[frontend/app/README.md](frontend/app/README.md) and the native contract
[frontend/app/modules/omw-native/API.md](frontend/app/modules/omw-native/API.md)). It has no
`build` script, so `pnpm -r build` stays web-only. The Android toolchain is shared with other
projects on this Mac and is never installed or upgraded from here:

| Script | What |
|---|---|
| `source scripts/app/env.sh` | exports `ANDROID_HOME` (`~/Library/Android/sdk`), `JAVA_HOME` (Gradle's Temurin 17), `ANDROID_AVD_HOME` (`.cache/android-avd`, our AVD only), the main checkout's pnpm store/cache/state (also from git worktrees), `COMPOSER_HOME`, the Metro cache and `PATH` |
| `scripts/app/with-emulator.sh [--stop-after] -- <cmd>` | takes the shared emulator lock (`.cache/android-emulator.lock`, mkdir-based, stale locks of dead pids are removed), creates the AVD `omw-app` (API 36 arm64, 2 GB data) if needed, boots it headless with quickboot snapshots (serial `emulator-5580`), waits for boot, runs `<cmd>` with `ANDROID_SERIAL` set and keeps the emulator for the next caller. `--status`, `--stop`. It refuses to boot while another emulator runs or with less than 5 GB free |
| `scripts/app/install-maestro.sh` | pinned Maestro CLI (2.12.1, sha256-checked) into `.cache/maestro`; no global install |
| `scripts/app/build-fonts.sh [--check]` | the app's TTFs from the site's font files (needs the fonts venv of `scripts/fonts`) |
| `scripts/app/dev-api.sh [--port N] [--state DIR] [--pair] [--reverse] [--reset]` | the PHP API on `127.0.0.1:8080` with throwaway state in `.cache/app-dev-api/` (or `DIR`) for the app on the emulator (`adb reverse`); prints a pairing link (see [api/README.md](api/README.md#traveler-app-app-inbox)) |
| `scripts/app/release.sh --aab\|--apk --api-base-url URL` | signed release build (R8) with the upload key from `.secrets/` (`--create-upload-key` once, `--verify FILE`); checks the signer, the 16 KB page alignment and the permissions (`check-artifact.py`); output in `.cache/app-release/` |
| `scripts/app/e2e.sh` | the archive-only end-to-end run on the emulator (release APK, local API behind a bad link `e2e-proxy.mjs`, backend with `APP_PUBLISH=false`), ~15 min; log in `.cache/app-e2e/<run>/` |

Debug builds (`frontend/app/android`, generated by `expo prebuild`) take about 1 GB; delete
`frontend/app/android` when you no longer need it. Builds run only on the Mac, never in Docker.

Freeing disk space: `sh scripts/clean.sh -n` lists what would go, with sizes; drop `-n` to remove
it. By default it removes build outputs, test results, screenshots and agent scratch in `.cache/`.
- `--caches` also removes download/tool caches (pnpm store, Go, Playwright browsers, …).
- `--all` also removes `node_modules`, `api/vendor` and `composer.phar`.
- `--devices` also removes this project's Android emulator, and `--docker` the `omw-builder` cache and e2e leftovers.

It never touches `.secrets/`, `.env`, git worktrees (`.cache/wt/`), design notes (`.cache/design-*`), backups, `backend/data/` or `api/var/`.
It refuses to run while processes use `.cache/`. See the script's header for how to rebuild afterwards.

## Status

As of 2026-11-21.

**Works without a phone** (fixtures; all checks above pass, plus the Go helper's `make check` in
`backend/wa-helper`): capture → media pipeline → static site → local or SFTP publish; the PHP API
with the admin PWA; the backend ⇄ API sync. End-to-end runs:

| What | Command |
|---|---|
| Public site (timeline, player) | `pnpm --filter @omw/site e2e`, `pnpm exec playwright test -c frontend/site/playwright.player.config.ts` |
| Gate pages (join, info, wait, your data, panic) against a mock API | `pnpm --filter @omw/site e2e:gate` |
| Generated site from real backend output | recipe in [backend/README.md](backend/README.md#local-end-to-end-run-fixtures-no-phone-no-api) |
| The gate rules on a real Apache (127.0.0.1) | `pnpm --filter @omw/backend test:apache` |
| Admin PWA against a mock / the whole local stack (PHP API + backend + site; also the access gate with Apache in both store modes) | `pnpm --filter @omw/admin e2e` / `pnpm --filter @omw/admin e2e:stack` |
| Backend in Docker (fixtures) | `scripts/docker-e2e.sh` |

**Wave 5 (approval-only followers), built and tested locally, not deployed yet:** the access gate
(Apache `.htaccess` + a session-file store written by the API; neutral page for everyone else),
personal links with an information screen and consent records, device approval, revoke and lock
(admin, panic link, Mac button), "Your data" with export and delete-me, privacy notice versions,
the safety options (release slots, departure hold, here-now and time precision; all off by
default), the P0 privacy fixes (no coordinates, hashed post ids, neutral link previews, portrait
waits for its photo's release) and changing the admin password. The live host probe (P0b,
2026-11-20) passed 13/13: the live setup is `ACCESS_STORE_MODE=direct` with `__Host-` cookies.
Go-live order and acceptance checklist: [docs/HOSTING.md §11.11](docs/HOSTING.md#1111-go-live-order-and-acceptance-checklist);
runbooks: [docs/OPERATIONS.md](docs/OPERATIONS.md#followers-and-access); what is stored about
followers: [docs/PRIVACY.md](docs/PRIVACY.md).

**Traveler app (v0.5, archive-only, 2026-11-22):** the Android app captures photos, videos, text
statuses and voice notes and uploads them (Wi-Fi only by default, resumable) through the API inbox
into the home archive; nothing is published until the wave-5 gate. Proven on the emulator against
the local stack only: `scripts/app/e2e.sh` (26/26 checks: Wi-Fi-only hold, a 64 kbit/s link with drops, kill -9, airplane mode, manual "Upload now", Undo after the upload + Share again under a new id, sha256-verified archive of media and originals, an empty inbox and nothing published; see [frontend/app/e2e-log.md](frontend/app/e2e-log.md)). A signed release bundle for Google
Play's internal track is built by `scripts/app/release.sh --aab`; the owner's upload steps and the
checks that still need her phone are in [frontend/app/README.md](frontend/app/README.md).

**Needs the phone (Phase 0, not started):** the WhatsApp helper has never run against WhatsApp.
Linking the observer number (QR or pairing code), receiving real statuses and media, and the
open questions in `backend/wa-helper/NOTES.md` §12 are next ([docs/OBSERVER.md](docs/OBSERVER.md),
[docs/PLAN.md](docs/PLAN.md)).

**Live hosts:** the site host serves a preview built from the fixtures plus synthetic owner content
(`noindex`, still **open**: no gate yet), deployed over SFTP on 2026-11-20. The API host still runs an earlier build: deploy
the current one with `scripts/deploy-api.ts` (`--skip-http-checks` while HTTPS is blocked) and set
the real admin e-mail (`--set-admin-email=…`; it is still a placeholder). Since 2026-11-20 the
shared host drops HTTPS from the development machine's IP (SFTP still works, see Troubleshooting
in [docs/HOSTING.md](docs/HOSTING.md)), so the live pages have not been checked since; once HTTPS
answers again, run `scripts/deploy-api.ts --checks-only`.

**Docker:** `omw-backend:dev` was rebuilt on 2026-11-20 on Debian 13 trixie (Node 24.22,
ffmpeg 7.1.5; arm64 only, amd64 not rebuilt). The unit tests inside the image (contracts and
backend, incl. the edge-media test) and `scripts/docker-e2e.sh` (Playwright 26/26, graceful stop,
idempotent restart) pass.

**Not verified yet:** nothing has been tested on a real device (iOS/Android PWA install,
keyboard, notch).
