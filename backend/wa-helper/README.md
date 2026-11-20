# wa-helper

The WhatsApp capture helper of "On My Way" (plan A1). A small Go binary built on
[whatsmeow](https://github.com/tulir/whatsmeow). It is a linked device of the observer account
(or, in self mode, of the traveler's own account) and archives the traveler's status posts into an
inbox directory that the Node backend ingests.

- **Protocol:** stdout carries JSON lines only (events), stdin takes JSON lines (commands), and
  the inbox files are the durable source of truth. The one authority for all of it is
  [`packages/contracts/src/wa.ts`](../../packages/contracts/src/wa.ts) (D9).
- **whatsmeow API notes** and what is verified so far vs. what still needs the Phase-0 phone test:
  [NOTES.md](NOTES.md).

## Build and test

```sh
make -C backend/wa-helper build     # bin/wa-helper for this machine (WA_HELPER_BIN default)
make -C backend/wa-helper check     # gofmt check, vet, unit tests, build, cross builds
make -C backend/wa-helper cross     # bin/wa-helper-{darwin-arm64,linux-amd64,linux-arm64}
make -C backend/wa-helper race      # tests with the race detector (needs cgo)
make -C backend/wa-helper golden    # rewrite testdata/golden after an intended protocol change
pnpm --filter @omw/contracts exec vitest run test/wa-golden.test.ts   # golden files vs. zod
```

- **Pure Go.** `CGO_ENABLED=0`; SQLite is `modernc.org/sqlite`. The Linux binaries are static.
- **Caches.** The Makefile keeps every Go cache under `<repo>/.cache/`.
- **No network in tests.** They use temp directories, a local SQLite store and fakes of the
  whatsmeow client.

## Running it

The Node backend spawns the helper and supervises it. To run it by hand, see the
[Phase-0 runner](#phase-0-runner-terminal) below.

```sh
bin/wa-helper -data-dir /data -traveler-phone 4915112345678 [-traveler-lid 123456789012345]
```

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `-data-dir` | `DATA_DIR` | required | State dir: `wa/session.db`, `wa/guard.json`, `inbox/`. Pass it as an absolute path. |
| `-mode` | `WA_MODE` | `observer` | `observer`: keep the statuses of `-traveler-phone`. `self`: the linked account *is* the traveler, so keep its own statuses. `fixture` is rejected, because Node replays fixtures itself. |
| `-traveler-phone` | `TRAVELER_PHONE` | required in observer mode | International number. `+`, spaces, `-`, `(`, `)`, `.` and `/` are stripped; no leading 0. |
| `-traveler-lid` | `TRAVELER_LID` | – | The traveler's LID as reported in an earlier `traveler` event. Node persists it and passes it back on every spawn. |
| `-send-read-receipt` | `SEND_READ_RECEIPT` | `false` | Allows the `mark_read` command to send the optional "captured ✓" status read receipt. |
| `-pair-phone` | – | – | Unlinked store only: request a pairing code for this observer number, the same as the `pair_code` command. |
| `-connect` / `-dry-run` | – | connect | `-dry-run` (= `-connect=false`): open the store, print `ready`, exit 0. No network. |
| `-media-workers` | – | `2` | Concurrent media downloads (1–8). |
| `-stats-interval` | – | `60s` | Interval of the periodic `stats` event; `0` disables it. |
| `-log-level` | `LOG_LEVEL` | `info` | stderr log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |

Flags win over the environment. The helper never reads `.env` files.

### Linking (first start)

With an empty `wa/session.db`, the helper emits `state qr` plus one `qr {code, expiresAt}` per
code. There are 6 codes, about 160 s in total. Render `code` as a QR code. On the observer phone,
go to WhatsApp › Linked devices › Link a device and scan it. The phone lists the link as
"On My Way".

To link without a camera, send `{"type":"pair_code","phone":"<observer digits>"}` (or start with
`-pair-phone`). The helper answers with `pair_code {code}`. On the phone, go to Linked devices ›
Link with phone number and type that code.

When the window ends without a link, the helper emits `state closed (pair_timeout)` and exits 7.
Start it again for new codes.

### Exit codes (supervisor policy)

| Code | Meaning | What Node should do |
|---|---|---|
| 0 | `shutdown` command, stdin EOF, SIGTERM/SIGINT | nothing |
| 1 | fatal error (`state error, reason fatal` was emitted) | restart with backoff, alert after repeats |
| 2 | invalid configuration, or another helper already uses `DATA_DIR` ([single instance](#one-helper-per-data-directory)); always before `ready` | do not restart; fix the config / stop the other helper. Exit 2 **after** `ready` is Go's status for a crash in a library goroutine (unrecovered panic, fatal runtime error): treat it like 1 |
| 3 | logged out (unlinked on the phone, or the `logout` command); the session is deleted | restart: a fresh QR follows; alert |
| 4 | stream replaced: another client uses this session | alert. A restart is safe: the helper waits 5 min (`wa/guard.json`) before connecting |
| 5 | client outdated (405) | do not restart in a loop; bump the whatsmeow pin |
| 6 | temporary ban (`state banned` with `until`) | restart whenever: the helper waits until `until` before connecting. A ban without an end from WhatsApp counts as 1 h |
| 7 | the linking window ended without a link (QR timeout, pair error) | restart when a new QR is wanted |
| 8 | unknown connect failure (whatsmeow will not reconnect) | restart with backoff |

whatsmeow handles transient disconnects and keepalive failures itself (auto-reconnect). They show
up only as `state closed` / `state open` events, and the process keeps running.

### Data directory

```
DATA_DIR/
├─ wa/helper.lock         single-instance lock (empty, mode 0600, never deleted)
├─ wa/session.db          whatsmeow session (device keys!), mode 0600, WAL
├─ wa/guard.json          temporary-ban end / last stream_replaced (reconnect guard)
└─ inbox/
   ├─ <msgId>/meta.json   InboxMeta: created once before the ack; later only `download` changes
   ├─ <msgId>/original.<ext>   the verified media file (jpg, mp4, ogg, …)
   └─ _revokes/<msgId>.json    RevokeRecord of the revoked status
```

- **Atomic writes.** Every file is written to a temp file, fsynced, renamed, and then the
  directory is fsynced.
- **Leftovers.** Temp files start with `.tmp-` or `.dl-`. The helper removes stale ones when it
  resumes.
- **Node's side.** Node only copies out of `inbox/<msgId>/`, and only deletes a directory once its
  download is terminal (rules 1–4 in `wa.ts`).

### One helper per data directory

Two helpers on one `DATA_DIR` (say, the one the Docker backend runs and a manual Phase-0 run)
would share one WhatsApp session: each connect makes WhatsApp drop the other (`stream_replaced`),
and both would write the same inbox. So before it opens `wa/session.db`, the helper takes an
exclusive, non-blocking `flock` on `DATA_DIR/wa/helper.lock`. If another process holds it, the
helper exits 2 before `ready`, without touching the session or the inbox. It prints this on stderr
(and as the `state error` detail):

```
wa-helper: another wa-helper is using /data (Docker and a manual run?)
```

- **No stale locks.** The kernel releases the lock when the process exits, also after a crash or
  `SIGKILL`. The empty file stays; never delete it by hand while a helper runs.
- **Restarts.** The Node supervisor waits for the old helper to exit before it spawns the next one,
  so it does not trip over its own lock. Exit 2 is not restarted automatically: stop the other
  helper, then restart from the control UI. One case needs that click: outside Docker, a backend
  that crashed and is started again within seconds may meet its old helper still shutting down
  (stdin EOF, up to 10 s while downloads finish). In Docker the whole container goes down with the
  backend, so the case does not occur.
- **Scope.** The lock works between processes that share a kernel and a file system: processes on
  one machine, and containers that share the `/data` named volume (`docker compose exec`/`run`
  next to the running backend). It does **not** work on Docker Desktop bind mounts. Measured on
  Docker Desktop for Mac (Docker 29.9, the mount shows up as file system `fakeowner` in the
  container): on a bind-mounted directory, a macOS process and a container, and even two
  containers, all got the lock at the same time. Keep `DATA_DIR` on the named volume
  (the compose default, which WAL needs anyway). On a Linux host, a bind mount shares the host
  kernel, so the lock should hold there too (standard `flock` behaviour, not tested here).
- **File systems without `flock`** (some network mounts: `ENOLCK`, `ENOTSUP`) also exit 2, with
  "put DATA_DIR on a local file system". Other lock-file errors (for example permission denied)
  are fatal (exit 1).
- **Platforms.** darwin and linux. Other platforms compile but run without the lock.

### Media downloads

Downloads run after the ack, from the media keys persisted in `rawProtoB64`, with at most
`-media-workers` in parallel and only while connected.

- **Success.** Download → temp file → sha256 compared with `FileSHA256` → fsync → `original.<ext>`
  → `download.state ok` + `media ok`.
- **Transient errors** (network, timeout, unknown). Retried after 15 s, 1 min, 5 min, 15 min and
  30 min, then `failed` (permanent=false). Node may send `redownload`, which starts a fresh run.
- **CDN copy gone** (403/404/410, no direct path). A media-retry receipt asks the phone to
  re-upload the file; the state becomes `retrying` and `media retrying` is emitted. The phone's
  answer (`events.MediaRetry`) is matched by message id to `meta.json`, so it still works after a
  restart.
  - `SUCCESS` → download from the new path.
  - `NOT_FOUND` → `failed expired` (permanent).
  - Media gone from the phone → `failed not_on_phone` (permanent).
  - No answer within 10 min → the receipt is sent again, at most 3 per run, then `failed timeout`
    (not permanent).
- **Hash mismatch** twice → `failed hash_mismatch` (permanent).
- **Restart.** On start, every `pending` / `retrying` download in the inbox is resumed. An overdue
  `retrying` one gets a new receipt.
- **Shutdown.** A shutdown mid-download leaves the state unchanged, so it resumes on the next
  start.

## Phase-0 runner (terminal)

`scripts/phase0.mjs` drives the helper from a terminal, without the Node backend:

- it renders QR codes in the terminal and summarises every captured status;
- it appends every event (with a receive timestamp) to `<data-dir>/phase0-events.jsonl`;
- it turns typed lines into commands: `stats`, `shutdown`, `logout`, `pair <digits>`,
  `read <msgId>`, `redownload <msgId>`, or raw JSON.

```sh
make -C backend/wa-helper build
node backend/wa-helper/scripts/phase0.mjs -data-dir "$PWD/backend/data/state" \
  -traveler-phone <traveler digits> [-traveler-lid <digits>] [-log-level debug]
```

It needs `pnpm install` (for the backend's `qrcode` package) and never restarts the helper. The
checklist of what to try with the phones is in [NOTES.md](NOTES.md#12-phase-0-checklist).
