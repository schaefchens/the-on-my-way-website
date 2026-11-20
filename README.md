# On My Way

Turns a traveler's WhatsApp status posts into a multilingual, zoomable travel timeline that's lovely to look at. The site is published as static files, so it runs on any web host.

## Layout

| Path | What it is |
|---|---|
| `backend/` | Node.js + TypeScript in Docker, with a tiny Go helper built on [whatsmeow](https://github.com/tulir/whatsmeow). It captures the traveler's statuses through an observer WhatsApp number, processes the media, generates the static site and pushes it over SFTP. |
| `frontend/` | React + TypeScript (Vite): the public timeline (`site/`) and the owner's admin PWA (`admin/`). |
| `api/` | PHP 8.3 + Slim 4 + SQLite: owner content, admin backend, alerts. Not needed to view the site. |
| `packages/contracts/` | zod schemas shared by all parts, exported as JSON Schema for PHP. |
| `scripts/` | API deploy (`deploy-api.ts`), project-local Composer, the Docker fixture e2e (`docker-e2e.sh`). |
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
keeps the image `omw-backend:dev` (~770 MB; the first build also needs about 3 GB of Docker disk
for base images and build cache). Then, depending on what you want to do:

| Goal | Read |
|---|---|
| Run the backend in Docker day to day, backups, moving to a server | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| Link the observer WhatsApp number | [docs/OBSERVER.md](docs/OBSERVER.md) |
| Static host and PHP API: setup, deploy, cron, restore | [docs/HOSTING.md](docs/HOSTING.md), [api/README.md](api/README.md) |
| Backend development, configuration, CLI, control UI | [backend/README.md](backend/README.md) |
| Site and admin development | [frontend/README.md](frontend/README.md) |

Checks: `pnpm typecheck`, `pnpm test`, `pnpm lint` (Biome), `pnpm schemas:check` (contracts →
`api/schemas`); PHP: `scripts/composer test` and `scripts/composer stan`.

Secrets live only in the repo's `.env` (read literally by the tools, never `source`d) and in
`.secrets/`; both are git-ignored.

## Status

As of 2026-11-20.

**Works without a phone** (fixtures; all checks above pass, plus the Go helper's `make check` in
`backend/wa-helper`): capture → media pipeline → static site → local or SFTP publish; the PHP API
with the admin PWA; the backend ⇄ API sync. End-to-end runs:

| What | Command |
|---|---|
| Public site (timeline, player) | `pnpm --filter @omw/site e2e`, `pnpm exec playwright test -c frontend/site/playwright.player.config.ts` |
| Generated site from real backend output | recipe in [backend/README.md](backend/README.md#local-end-to-end-run-fixtures-no-phone-no-api) |
| Admin PWA against a mock / the whole local stack (PHP API + backend + site) | `pnpm --filter @omw/admin e2e` / `pnpm --filter @omw/admin e2e:stack` |
| Backend in Docker (fixtures) | `scripts/docker-e2e.sh` |

**Needs the phone (Phase 0, not started):** the WhatsApp helper has never run against WhatsApp.
Linking the observer number (QR or pairing code), receiving real statuses and media, and the
open questions in `backend/wa-helper/NOTES.md` §12 are next ([docs/OBSERVER.md](docs/OBSERVER.md),
[docs/PLAN.md](docs/PLAN.md)).

**Live hosts:** the site host serves a preview built from the fixtures plus synthetic owner content
(`noindex`), deployed over SFTP on 2026-11-20. The API host still runs an earlier build: deploy
the current one with `scripts/deploy-api.ts` (`--skip-http-checks` while HTTPS is blocked) and set
the real admin e-mail (`--set-admin-email=…`; it is still a placeholder). Since 2026-11-20 the
shared host drops HTTPS from the development machine's IP (SFTP still works, see Troubleshooting
in [docs/HOSTING.md](docs/HOSTING.md)), so the live pages have not been checked since; once HTTPS
answers again, run `scripts/deploy-api.ts --checks-only`.

**Not verified yet:** the Docker image `omw-backend:dev` predates the latest backend changes. The
rebuild and `scripts/docker-e2e.sh` are pending because Docker Desktop's disk is full (free space
or enlarge the disk under Settings → Resources first). Nothing has been tested on a real device
(iOS/Android PWA install, keyboard, notch).
