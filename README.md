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

Freeing disk space: `sh scripts/clean.sh -n` lists what would go, with sizes; drop `-n` to remove
it. By default it removes build outputs, test results, screenshots and agent scratch in `.cache/`.
- `--caches` also removes download/tool caches (pnpm store, Go, Playwright browsers, …).
- `--all` also removes `node_modules`, `api/vendor` and `composer.phar`.
- `--devices` also removes this project's Android emulator, and `--docker` the `omw-builder` cache and e2e leftovers.

It never touches `.secrets/`, `.env`, git worktrees (`.cache/wt/`), the live site's publish state
(`.cache/live-preview/`), design notes (`.cache/design-*`), backups, `backend/data/` or `api/var/`.
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
