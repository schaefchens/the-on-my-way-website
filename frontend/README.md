# Frontend

| Package | Path | What |
|---|---|---|
| `@omw/ui` | `shared/` | Design tokens (Tailwind v4 theme, dawn/dusk), fonts, Motion presets, locale helpers, `<Picture>`. See [shared/README.md](shared/README.md). |
| `@omw/site` | `site/` | Public timeline SPA: Vite base `./`, built into the backend image; the generator copies it to `/assets/`. |
| `@omw/admin` | `admin/` | Admin PWA under `/admin/`, built into `api/public/admin` and deployed with the PHP API. |
| `@omw/app` | `app/` | The traveler app (Expo SDK 58, React Native, Android first). No `build` script; see [app/README.md](app/README.md). Its stack differs from the table below. |

Stack (versions pinned in each `package.json`): React 19.3, Vite 8.3 (Rolldown), TypeScript 7, Tailwind CSS 4.3 (`@tailwindcss/vite`), TanStack Router 1.170 (code-based routes) and Query 5, Motion 14 (`motion/react`, `LazyMotion`), Lingui 6.12, vite-plugin-pwa 2 (admin), Vitest 5.

## Commands (run from the repo root)

```sh
pnpm --filter @omw/site dev-data        # build site/dev-data from fixtures/generated (run `pnpm fixtures` first)
pnpm --filter @omw/site dev             # http://127.0.0.1:5173/de/  (serves /data and /media from dev-data)
pnpm --filter @omw/site build           # site/dist (+ dist/.vite/manifest.json) and the gate bundle site/dist/gate
pnpm --filter @omw/site build:gate      # only the gate bundle (vite.gate.config.ts)
pnpm --filter @omw/site e2e:gate        # gate pages in Chromium against a mock site host + API (needs build:gate)
pnpm --filter @omw/admin dev            # http://127.0.0.1:5174/admin/  (/api -> http://127.0.0.1:8080)
pnpm --filter @omw/admin build          # -> api/public/admin (emptied first)
pnpm --filter @omw/site i18n:extract    # update src/locales/*/messages.po (same for @omw/admin)
pnpm -r --filter "./frontend/*" test    # Vitest
pnpm -r --filter "./frontend/*" typecheck
PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin e2e:stack   # whole stack: real PHP API + backend + site (needs both builds)
```

Useful env:
- `OMW_DEV_DATA_DIR`: the directory the site dev server serves `/data` and `/media` from. Point it at `backend/data/out` to use the real generator output.
- `OMW_FIXTURES_DIR`: input for `dev-data`.
- `VITE_AUTH_STUB=1`: the admin fakes a logged-in owner, for UI work without PHP.
- `OMW_API_DEV_URL`: the admin's proxy target.

## Site: contract with the backend generator

- **Mount point:** `<div id="omw-root">`. The generator pre-renders the first screen inside it. `main.tsx` starts everything at once (message catalog, manifest, the boot's `timeline.json?v=<timelineV>`, the route's loaders and, on day/story pages, the player and story-sheet chunks), waits until they have settled, then calls `createRoot` once, replacing the first screen. There is no hydration.
- **Boot JSON:** `<script id="omw-boot" type="application/json">` with the `Boot` shape from `@omw/contracts/site`. `basePath` comes only from here (D3). If `day` is inlined, its day and story routes start from it without waiting for the manifest or the timeline (the timeline loads behind the player at low priority); `profile` (the timeline's `SiteProfile`) is inlined next to it, so the player's avatar ring shows the owner's portrait before `timeline.json` arrives (`src/profile.tsx`: the timeline's profile wins once loaded). If `timelineV` is present, exactly `<basePath>data/timeline.json?v=<timelineV>` is requested at startup, in parallel with the manifest, which only confirms it (another hash: that timeline is loaded instead). Preload it as `<link rel="preload" as="fetch" crossorigin href="…">`: the app requests data files as plain CORS GETs with the default credentials mode and no custom headers, so the preload is reused. Escape `<`, `>`, `&`, U+2028 and U+2029 inside the script; `escapeJsonForHtml` in `site/vite/dev-data-plugin.ts` is the reference.
- **Assets:** the build uses Vite base `./`, so one build works under any basePath. Read `site/dist/.vite/manifest.json` (entry `index.html`) and emit absolute, basePath-prefixed `<script type="module">`, CSS and `modulepreload` tags. Lazy chunks and fonts are referenced relative to the importing file, so they work from `/assets/` without further work. `site/dist/index.html` works only at `/`: it is for `vite preview`, not for deployment.
- **Routes:** these must exist as directories with an `index.html`: `<locale>/`, `<locale>/day/<date>/`, `<locale>/day/<date>/story/<p_id>/`, `<locale>/trip/<slug>/` (trailing slash always). Generate them for exactly the locales in `Manifest.site.locales` (setting `site.locales`, which may include the pseudo-locale `ar` on an RTL test deployment): the SPA enables locales at runtime from the manifest, so unknown or unconfigured locales and unknown days show the SPA's 404 screen. Story URLs are derived with `routePath(locale, {name: 'story', date, id})` (no stored path). `/404.html` gets a boot block with route `notFound` (it carries the basePath for any URL depth).
- **Data:** the manifest is fetched with `cache: 'no-store'` and `?t=<now>`. Every other data file is fetched as `?v=<hash>` and cached immutably by TanStack Query. Every request has a 15 s deadline; timeouts, network errors and 5xx are retried twice before the error screens show. The manifest is polled every 5 minutes; when it changes, the "New moments ✨" toast appears.
- **Profile (who travels):** `timeline.json` `profile` drives the home hero (portrait in a ring, name, greeting in the visitor's language or else marked with its `lang`), the player's avatar ring (fallback: the day's first picture) and the day-end sign-off (only with a name). Nothing set: the site looks as before. The portrait is its own round crop of the chosen photo (square files of 96/192/288 px with transparent corners, made by `backend/src/pipeline/avatar.ts` at the owner's focus point), never the photo's own variants, so a photo hidden from the timeline shows nothing but that circle. The generator's twin (`backend/src/generator/twin.ts`) renders the same hero and avatar markup, so the swap to React does not move them.
- **Tailwind:** the first screen uses inline `.omw-fs*` CSS and Tailwind classes; `site/src/app.css` already `@source`s `backend/src/generator`, so classes used there survive the build.
- **Dev data:** `site/scripts/make-dev-data.ts` is a stand-in for pipeline + generator. It is useful as an executable spec: D8 names, D11 policy, content hashes, chronological entries, covers. It validates its output with zod. `--check` validates only.

## Site: the gate bundle (wave 5, access gate)

- **What:** the static pages of the gate tree, `/_/{join,info,wait,ended,me,panic}/` (personal link + information screen + consent, waiting for approval, access ended, "Your data" with export and delete-me, the panic link). Vanilla TypeScript (`site/src/gate/`), no React, no zod, its own CSS with the dawn/dusk tokens; ≤ 25 kB gzip JS + CSS (`test/gate/bundle.test.ts` checks the built files), no source maps (the gate tree is public and the generator's leak test scans it).
- **Build output:** `site/dist/gate/.vite/manifest.json`, entry `src/gate/main.ts` → `assets/gate-<hash>.js` + one CSS file; the generator copies them to `/_/assets/` (`backend/src/generator/site-build.ts` `readGateBuild`). The backend Docker image refuses to build without it.
- **Boot:** each gate page carries `<script type="application/json" id="omw-gate">` (`GateBoot` from `@omw/contracts/access`: page, locales, API base, cookie names and domain, build hash) and an empty `<main id="omw-gate-root">`.
- **API:** `POST <apiPublicBase>{join/check, join, device/poll, me/*, panic}` as `text/plain` JSON without credentials (credentials only in cookie mode `parent`); the device key travels in the body, never in a URL. Every navigation, timer and storage access goes through `env.ts`; `safeTarget()` lets only the fixed gate targets through.
- **`access-lite.ts`:** copies of the few contract constants and `parseLinkFragment` the bundle needs (any value import from `@omw/contracts/access` would pull in zod); `test/gate/access-lite.test.ts` pins them to the contracts and to `fixtures/vectors/access-paths.json`.
- **SPA side** (`site/src/access/`): `Boot.access` switches on the gate behaviour: a refused data request (403, or the neutral page instead of JSON) stops polling, empties the cache and asks `me/hello` (ended → `/_/ended/`, locked → "not available right now", active → resume); `me/hello` also runs after a handoff and at most every 5 minutes per tab (a changed privacy notice → `/_/info/#reconfirm`); the header menu gets "Deine Daten" and "Auf diesem Gerät abmelden", the footer "Persönlich geteilt mit {name}".

## Admin: contract with the PHP API

- **Endpoints:** `/api/v1/admin/...`, exactly as in `api/src/Http/Routes.php`: `POST/DELETE /session`, `GET /me`, `PUT /me/password`, `/status`, `/captures[/{sourceKey}]`, `/posts`, `/days[/{date}]`, `/trips`, `/settings`, and (wave 5) `/followers…`, `/devices/{did}/…`, `/access…`, `/privacy…`, `/notices…`.
- **Access actions** (invite, allow/decline/remove a device, end access, delete, lock, store set-up, panic link, privacy, password) are sent once, outside the offline write queue, and never persisted: People, names and the full access status stay out of IndexedDB (the saved status keeps only counts). Each store-changing action shows "Wirksam ✓", "Noch nicht wirksam ⏳" (keeps checking) or "Nicht gesendet – keine Verbindung" (`components/effect-badge.tsx`).
- **Requests:** `credentials: 'same-origin'`. Every mutating request sends `X-CSRF-Token` with `Me.csrfToken`. Error bodies are `ApiError`, and a 401 on `/me` means "logged out". In dev builds, responses are checked against `@omw/contracts/api` and mismatches are logged to the console.
- **Serving:** PHP must serve `api/public/admin/index.html` for every `/admin/*` path that is not a file (SPA fallback). It must send `sw.js` and `index.html` with `Cache-Control: no-cache`; `assets/*` are immutable.
- **Service worker:** scope `/admin/`. It precaches the app shell (JS, CSS, HTML, icons, manifest), caches fonts on first use, and never touches `/api/`.

## Decisions

- **Lingui:** macros (`Trans`, `Plural`, `useLingui` from `@lingui/react/macro`) are compiled by `@lingui/vite-plugin`'s native transform (`macroTransform: true`), so there is no Babel. The Babel route (`@rolldown/plugin-babel` + `linguiTransformerBabelPreset`) also worked and produced an identical bundle; the plugin recommends the native transform and will make it the default in its next major. Catalogs are PO files compiled on import and lazy-loaded per locale. The source locale is `en`, with a German translation. **`ar` is the dev-only pseudo-locale:** Lingui pseudo-localizes it with `rightToLeft: true`. Dev builds always route it; production builds route it only when `Manifest.site.locales` contains it (RTL test deployments), and the admin offers it only in dev builds.
- **No zod in production bundles:** `@omw/contracts` modules mix helpers (`LOCALES`, `pickText`, …) with zod schemas built at module level. The Vite builds set `treeshake.manualPureFunctions: ['z']`, so unused schemas and zod itself are dropped. That took the site entry from 152 to 132 kB gzip. Dev-only validation is imported dynamically behind `import.meta.env.DEV`.
- **Motion:** `LazyMotion` + `m.*`. The `domAnimation` feature bundle (19 kB gzip) loads lazily.
- **Fonts:** only `.woff2` files, and only the needed subsets (see `shared/README.md`).
- **Ports:** site 5173, admin 5174, plus site preview 4175 and admin preview 4176. 4173 is left for the static preview of `backend/data/out` (D12).
