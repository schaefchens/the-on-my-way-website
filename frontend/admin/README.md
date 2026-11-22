# @omw/admin — the traveller's admin PWA

Mobile-first PWA under `/admin/`, served by the PHP API on the same origin (plan C "Admin PWA").
It talks only to `/api/v1/admin/*` (+ `GET /api/v1/health`) exactly as in
`api/src/Http/Routes.php` and `packages/contracts/src/api.ts`.

## Commands (repo root)

```sh
pnpm --filter @omw/admin mock-api        # typed mock API on http://127.0.0.1:51750 (login owner@example.org / reisetagebuch)
OMW_API_DEV_URL=http://127.0.0.1:51750 pnpm --filter @omw/admin dev   # http://127.0.0.1:5174/admin/
pnpm --filter @omw/admin build           # -> api/public/admin (emptied first)
pnpm --filter @omw/admin test            # Vitest: client, offline writes, persistence, conflicts, helpers, mock
PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin e2e   # port 51751 (OMW_ADMIN_E2E_PORT), build in .cache/admin-e2e/dist-<port>
pnpm --filter @omw/admin typecheck
pnpm --filter @omw/admin i18n:extract    # then translate src/locales/de/messages.po (en is the source)
pnpm --filter @omw/admin icons           # re-render PWA icons from public/icons/icon.svg
```

Design screenshots (not a test; needs the mock on 51750 and `vite --port 51752 --strictPort` with
`OMW_API_DEV_URL=http://127.0.0.1:51750`, because the RTL pseudo-locale exists only in dev builds):
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin shots --vp mobile --scheme dark --locale ar --only home,inbox`
→ `.cache/shots/admin/`.

## How it works

| Concern | Where | Notes |
|---|---|---|
| API client | `src/api/client.ts` | `credentials: 'include'`, `cache: 'no-store'`, `X-CSRF-Token` = `Me.csrfToken` on every mutating request (fetched first when unknown, refreshed once on 403 `csrf`), never a Bearer token. Errors are `ApiRequestError` (`status` 0 = network). 401 outside `/me`·`/session` → login with `?redirect=`. Dev builds validate responses against the contracts (`validate.dev.ts`, dynamic import). |
| Owner writes | `src/api/writes.ts`, `keys.ts`, `types.ts` | Every write has a mutation key whose defaults hold `mutationFn` + optimistic update, so paused writes restored after a reload can run. One scope: writes replay strictly in order. Network errors retry forever (paused while offline), 5xx/429 three times, other 4xx never. |
| Optimistic cache | `src/api/cache.ts` | Idempotent updaters; `CacheTx` snapshots exactly what it touched for rollback; pending writes are re-applied after a rollback or a refetch. Effective visibility/date/zone use `@omw/contracts/policy`. |
| Concurrency | `src/api/writes.ts`, `conflicts.ts` | PATCH/PUT carry `ifUpdatedAt`; a later queued edit of the same entity is rebased onto the version an earlier one produced. 409 `conflict` → newer version fetched → per-field (per-locale) three-way merge: automatic when fields differ, otherwise the conflict sheet (`components/conflict-dialog.tsx`). Creates use a client `p_` + ULID publicId (idempotent replays). The merged write after a 409 carries the fetched server version verbatim (`exactBase`, never rebased), rebases that do not lead to the server's version are pruned (a server rewound by a restore cannot loop), at most 2 automatic merges per entity and minute (then an error with "Try again"), and a new API feed id (`StatusResponse.backend.sync.feedId`) drops the whole version map. |
| Follow-up edits | `src/api/types.ts` (`writeBase`), `writes.ts` | An entity with `changeSeq` 0 exists only optimistically (note written offline, first annotation, new day row); its made-up `updatedAt` is never sent: the edit goes out with base `null` and is rebased onto the version our earlier write produced. Deletes forget the rebase map of the entity. |
| Rejected posts | `src/lib/rescue.ts`, `lib/drafts.ts` | The composer removes the draft on "Publish"; if the API then rejects the post for good (4xx other than 401/409, 5xx after retries) the text is put back into a draft (never over another one), with an "Open draft" toast. Home lists all drafts on the device (`/compose?draft=…`). Edit drafts keep the post's fields they started from (`original`), so an old draft never silently overwrites newer server text: the stale `ifUpdatedAt` gets a 409 and the per-locale merge decides. |
| Offline | `src/api/online.ts`, `persist.ts`, `outbox.ts` | Online = browser online AND API reachable (health probe with backoff). Query cache + pending writes persisted to IndexedDB (idb-keyval); auth/tokens never persisted. A write that hit 401 waits in the outbox and replays after the next login. The service worker (`src/sw.ts`) precaches the shell and never touches `/api/`. |
| Unsaved edits | `src/lib/drafted-form.ts`, `lib/drafts.ts` (field drafts), `components/unsaved.tsx` | Day editor and status description autosave a draft keyed by entity + the `updatedAt` the edit began on; coming back restores it ("Noch nicht gespeichert"). Only touched fields are sent, with that base (a change made elsewhere meanwhile goes through the 409 merge). Leaving while dirty asks Save / Discard / Keep editing (router blocker + beforeunload). A sent draft is dropped when the server confirms the write. |
| Live state | `src/lib/publish.ts` | "Live ✓ / Wird veröffentlicht…" from `StatusResponse.publish` vs. the change seq our writes returned and the newest capture; per item the contracts' `itemPublishState` rule (restated locally, see below), with `publishAt` (occurredAt + delay) for delayed-mode captures. Status polls every 10 s while something is on its way, else every 60 s. "Status unknown" (no data) is not "not published yet" (confirmed empty). |
| Feedback | `src/lib/notices.ts`, `lib/errors.ts` | One status toast + one undo offer + two errors at most; toasts older than 1.5 s go on navigation; a queued write says "Gespeichert – wird gesendet" until confirmed. Errors map status/code to warm copy, the technical text sits behind "Details". |
| Visibility | `src/lib/captures.ts`, `lib/mode-since.ts` | Un-hiding returns to the publish setting (`visibility: null`; explicit `public` only when the policy itself hides it), "Jetzt veröffentlichen" is the explicit release. Settings mirror the API's `publish.mode_since` rule and ask before a switch publishes waiting statuses. |
| Screens | `src/screens/*` | Login, Home, Inbox (+ item sheet), Days (+ editor), Composer, Trips (+ editor), Settings. Editors are lazy chunks. |
| About you | `src/screens/settings-profile.tsx`, `components/portrait.tsx`, `lib/profile.ts` | Name, greeting (de/en tabs, counter in code points like the contract) and portrait (`site.author`, `site.intro`, `site.avatar`), cleaned before sending; empty removes (null). The portrait picker pages through `GET /captures?kind=photo` (private previews, newest first; deleted, lost and processing photos are left out). The item sheet of a photo has "Use as portrait" (undo toast); a portrait hidden in the timeline gets a hint. A 422 on a profile write shows at its field while the section is open (`handleProfileWriteFailure`), else as the usual toast. Trips without a public day say they are not on the site yet. |
| People and access (wave 5) | `src/api/access.ts`, `screens/{people,person,safety,privacy}.tsx`, `components/{effect-badge,link-sheet,confirm-sheet,lock-card,password-sheet}.tsx`, `lib/{held-days,people,password-strength}.ts` | Immediate requests (spec-wave5 §7.2), never the offline queue: mutation keys outside `MUTATION_NAMES`, `retry: 0`, `networkMode: 'always'`; passwords only in a request's closure. The persister writes only queued owner writes and never a query with `meta.persist: false` (everything under `qk.access`), so names, devices and the Home pending cards (`GET /admin/access`) never reach IndexedDB; the persisted `/status` carries counts only. Each store-changing result shows its effect: "Wirksam ✓", "Noch nicht wirksam ⏳" (+ retry; polls `/admin/access` until no op is pending) or "Nicht gesendet – keine Verbindung". The departure-hold card and the portrait hint use the contracts' `leftPlaceAt`/`holdEndAt`/`portraitReleaseAt`. The common-password list of the strength hint is a lazy chunk. |
| UI kit | `src/components/ui.tsx`, `icons.tsx` | Tokens from `@omw/ui` (dawn/dusk), Fraunces SOFT headings, Playpen notes, native `<dialog>` sheets, native radios/checkboxes behind the pills and switches. Motion springs via `LazyMotion` (`reducedMotion: 'user'`). |

## Mock API (`e2e/mock/`)

`MockAdminApi` implements every admin route in memory and validates request bodies and its own
responses with the contract schemas (a response that drifts from the contract is a 500). It
enforces the session cookie, CSRF, `ifUpdatedAt` (409), idempotent post creates, trip overlap
(422), settings cross-field rules, the portrait rule of `site.avatar` (422 like the PHP API) and `publish.mode_since`, and simulates the backend: a publish
report that catches up `--publish-after` ms after the last write. Control endpoints for tests:
`POST /__mock/reset | publish | day/<date> | alerts | capture ({minutesAgo, caption}) | settings (stored as is) | revoke/<sourceKey>`,
`GET /__mock/state | log`. People and access (`e2e/mock/access.ts`, seeded with Oma, Paul, a revoked and a deleted
person, notice v1 and a set-up store; writer "direct" applies every action at once): `POST /__mock/access` (state as is:
`writerMode` `none` keeps ops pending, `storeId: null`, `gateCheck`, `noticeVersions: 0`, …) | `access/ack` (the Mac
applied everything) | `device` ({fid, label?, minutesAgo?, state?}: a join) | `notice` ({kind}) | `self-delete/<fid>`.
`e2e/people.spec.ts` covers the people and access screens. `e2e/owner-ux.spec.ts` covers the phone UX (save bars, drafts, toasts,
time-zone nudge, focus, delayed un-hiding, mode switches, error home).

The stack e2e takes `OMW_STACK_ROOT` too (default `.cache/e2e-stack`), so two runs never share a
state directory.

## Notes

- `itemPublishState` is restated in `src/lib/publish.ts` (`publishStateOf`, checked against the
  contracts by a unit test): any runtime import from `@omw/contracts/api` pulls all of its zod
  schemas plus zod (~55 kB gzip) into the bundle, because rolldown cannot drop chained zod calls.
- Browsers (Chromium/ICU) report some zones by legacy names (`Asia/Saigon`); the admin maps them
  to current IANA names (`src/lib/places.ts`) before sending, since the API validates against
  `DateTimeZone::listIdentifiers()`.
