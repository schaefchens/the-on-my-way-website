# wa-helper: whatsmeow pin and API notes

> **Protocol authority.** The helper's stdout events, stdin commands and inbox files (D9) are
> specified only by `packages/contracts/src/wa.ts`. That file also holds the whatsmeow event →
> `WaEvent` mapping, the media-download lifecycle and the LID rules. `inbox.go` implements it;
> `testdata/golden/` (written by `go test -run TestGolden -update`) is validated against the zod
> schemas by `packages/contracts/test/wa-golden.test.ts`. Where this file and `wa.ts` disagree,
> `wa.ts` wins. This file documents the whatsmeow API at the pinned commit.

Verified on 2026-11-19 (updated 2026-11-20 for helper v0.2.0) against the module source in the Go module cache. File references
(`file.go:line`) point into
`.cache/go/pkg/mod/go.mau.fi/whatsmeow@v0.0.0-20261116172437-19d61352436f/`.

`apicheck.go` holds compile-time checks for nearly every signature, field and constant below.
If a pin bump changes one of them, `go build` fails there. Behaviour (who acks when, what gets
deleted) is not compile-checked. That part is described here from reading the source.

## 1. The pin

| | |
|---|---|
| Module | `github.com/omw/wa-helper` (go 1.26.0; whatsmeow needs Go ≥ 1.26 because it uses `new(expr)`) |
| whatsmeow | `go.mau.fi/whatsmeow v0.0.0-20261116172437-19d61352436f`, which is master HEAD `19d6135` ("media: send Messenger's origin and user agent on media requests (#1356)", 2026-11-16) |
| go.sum | `h1:35MsRpG44DDnw7c9SPlkpNrGzyWRz9oJqCIs1T+Vdaw=` (checked against sum.golang.org; `go mod verify`: all modules verified) |
| SQLite driver | `modernc.org/sqlite v1.62.0`, pure Go, builds with `CGO_ENABLED=0` |
| Other direct deps | `github.com/rs/zerolog v1.35.1`, `google.golang.org/protobuf v1.36.12` (both already required by whatsmeow) |

### Evidence that the pin includes fix `06b1c29`

The fix is "client: remove special handling of status stanzas" (Tulir Asokan, 2026-11-16 14:25 +0200).
It closes #1323 and #1355.

1. **History.** A treeless clone of the repo (history only) lives in `.cache/git/whatsmeow.git`.
   - `git merge-base --is-ancestor 06b1c29 19d61352436f3aeb21ad2cf93c2e3599ac409415` exits 0, so 06b1c29 is an ancestor of the pinned commit.
   - `git log --oneline main` lists `06b1c29` five commits below `19d6135`:
     `19d6135, 2ecca2c, 8b5965b, b85641f, 7582b2e, 06b1c29, 18e9419, …`.
2. **Source.** The pinned module source contains every part of that commit's diff:
   - `client.go:323`: `"status": cli.handleEncryptedMessage,`. Before the fix this line was `cli.handleUnencryptedMessage`, which dropped non-newsletter `<status>` stanzas without decrypting them.
   - `message.go:62`: `info.StanzaTag = node.Tag`.
   - `types/message.go:114`: `StanzaTag string // message for normal messages, status for newsletters and status broadcasts, …`.
   - `handleUnencryptedMessage` and `IsNewsletterStatus` no longer exist anywhere in the module.

**Consequence.** Contacts' statuses that arrive as top-level `<status>` stanzas now go through the
normal decryption path. They are emitted as `events.Message` with `Info.Chat == types.StatusBroadcastJID`
and `Info.StanzaTag == "status"`. Statuses in classic `<message>` stanzas carry `StanzaTag == "message"`.
The skeleton counts `status` stanzas for the heartbeat's "stanza stats".

### Bumping the pin

Bump deliberately:

1. `go get go.mau.fi/whatsmeow@<commit>` with the cache env (see `Makefile`).
2. Run `make build vet test cross`.
3. Re-read the "behaviour" notes below in the diff.

## 2. Build (pure Go, no cgo)

```sh
cd backend/wa-helper
make build      # CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o bin/wa-helper .
make vet        # go vet ./...
make test       # go test -count=1 ./...  (local files + SQLite only, no network)
make race       # the same with -race (CGO_ENABLED=1)
make cross      # bin/wa-helper-darwin-arm64, bin/wa-helper-linux-amd64, bin/wa-helper-linux-arm64
make check      # fmt-check + vet + test + build + cross
```

**Caches.** The `Makefile` exports `GOPATH`, `GOMODCACHE`, `GOCACHE`, `GOTMPDIR` and `TMPDIR` under `<repo>/.cache/`,
plus `GOTOOLCHAIN=local`. It also exports `HOME=<repo>/.cache/home`, so Go's telemetry and env files
stay out of the real home directory (telemetry is set to `off` there).

**Sizes (2026-11-20, helper v0.2.0, go1.26.4, `-trimpath -ldflags '-s -w'`, `CGO_ENABLED=0`).**

| Target | Bytes | MiB |
|---|---|---|
| darwin/arm64 | 17,549,890 | 16.7 |
| linux/amd64 | 18,084,002 | 17.2 |
| linux/arm64 | 17,236,130 | 16.4 |

The Linux binaries are static ELF files. A plain `go build` without `-s -w` gives 25,325,650 B (darwin/arm64).

**Dependency check.** No package in the dependency graph has cgo files under `CGO_ENABLED=0`.
`github.com/mattn/go-sqlite3` appears in `go.mau.fi/util`'s go.mod but is not imported by anything we build.

**Dockerfile hint.** Use `golang:1.26-trixie` (the Dockerfile's `GO_IMAGE`) as the build stage with `CGO_ENABLED=0`, and copy the
single binary into the node image. No libc or sqlite packages are needed at runtime.

## 3. Session store: `sqlstore` + modernc

```go
import _ "modernc.org/sqlite"            // registers database/sql driver "sqlite" (sqlite.go:50,56)
// store/sqlstore/container.go:46
func New(ctx context.Context, dialect, address string, log waLog.Logger) (*Container, error)
```

**What `New` does.**
- It runs `sql.Open(dialect, address)`, then `NewWithDB(db, dialect, log)`, then `Upgrade(ctx)`.
- `dialect` is used both as the database/sql driver name and for `dbutil.ParseDialect`. ParseDialect (`go.mau.fi/util@v0.11.1/dbutil/database.go:39`) maps anything with the prefix `sqlite` (or `litestream`) to SQLite and `postgres*`/`pgx` to Postgres.
- So **`"sqlite"` (modernc's driver name) works as is.** No alias registration is needed.
- `log` may be nil (a no-op logger).

**Foreign keys are mandatory.** `Container.Upgrade` (`container.go:101`) runs `PRAGMA foreign_keys` and fails with
`foreign keys are not enabled` otherwise. Pragmas must be set per connection, so they go in the DSN.

**DSN we use** (`sessionDSN` in `main.go`):

```
file:///data/wa/session.db?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_txlock=immediate
```

- modernc applies each `_pragma` on every new connection. It also understands the mattn-style shorthands
  (`_foreign_keys`, `_journal_mode`, `_busy_timeout`, `_synchronous`) and `_txlock`. See `modernc.org/sqlite@v1.62.0/driver.go:90-215`
  and `sqlite.go:315`ff. `_pragma=…(…)` is used because it works in all modernc versions.
- The settings mirror mautrix's `sqlite3-fk-wal` (`go.mau.fi/util/dbutil/litestream/register.go`), with `synchronous=FULL`.
  The DB holds the signal ratchets, the volume is tiny, so durability wins over speed.
- The `file:` URI form must be absolute. `sessionDSN` builds it with `url.URL`, so special characters in paths are escaped.
- `openSessionStore` pre-creates the file with mode 0600, because it holds the device's private keys.

**Verified by `TestSessionStoreModernc`** (store_test.go):
- schema upgrade on a fresh DB, and on reopen (idempotent);
- `GetFirstDevice`, then `Save` (PutDevice), then reload;
- LID map put/get;
- the event buffer inside `DoDecryptionTxn` (an IMMEDIATE transaction);
- the buffer row surviving with cleared plaintext;
- `journal_mode` = `wal`;
- foreign-key cascade on `Device.Delete`;
- file mode 0600.

**Other Container API.**
- `GetFirstDevice(ctx) (*store.Device, error)` (`container.go:165`) returns the first stored device. If there is none, it returns `c.NewDevice()`: a fresh, **unsaved** device with `ID == nil`. Pairing saves it.
- `GetAllDevices`, `GetDevice(ctx, jid)`, `NewDevice()`, `Close()`.
- `Container.LIDMap *sqlstore.CachedLIDMap` (`container.go:32`, exported) is always usable.
- **Gotcha:** on a fresh `NewDevice()` the per-device stores, **including `device.LIDs`, are nil** until the device is saved. `initializeDevice`, `container.go:257`, sets them. Use `container.LIDMap` for LID lookups that may run before pairing.

## 4. Client and linking

```go
// client.go:271
func NewClient(deviceStore *store.Device, log waLog.Logger) *Client
```

**Defaults** (`client.go:279-312`): `EnableAutoReconnect: true`, `AutoTrustIdentity: true`,
`BackgroundEventCtx: context.Background()`.

**Logging.** `waLog.Zerolog(zerolog.Logger)` (`util/log/zerolog.go:23`).
Do **not** use `waLog.Stdout` (`util/log/log.go:81`): it writes to stdout, which is our JSON-lines protocol channel.
Some internals log via `zerolog.Ctx(ctx)`. Set `cli.BackgroundEventCtx = logger.WithContext(ctx)` to capture those too.

### Device name ("On My Way")

```go
// store/clientpayload.go:159
func SetOSInfo(name string, version [3]uint32)   // sets store.DeviceProps.Os + Version, UA OsVersion
store.SetOSInfo("On My Way", [3]uint32{0, 2, 0})
```

- `store.DeviceProps` (`clientpayload.go:124`, a `*waCompanionReg.DeviceProps`) is marshalled into the
  **registration** payload (`clientpayload.go:168-185`). So it only matters **before pairing**; renaming means relinking.
- Defaults: `Os: "whatsmeow"`, `PlatformType: UNKNOWN`.
- `store.DeviceProps.PlatformType` (e.g. `waCompanionReg.DeviceProps_DESKTOP`) controls the icon and the QR client type.
- **Unverified:** whether the phone shows `Os` alone or combines it with the platform. Check in Phase 0.

### QR linking

```go
// qrchan.go:221
func (cli *Client) GetQRChannel(ctx context.Context) (<-chan QRChannelItem, error)
type QRChannelItem struct { Event string; Error error; Code string; Timeout time.Duration;
    PasskeyRequest *events.PairPasskeyRequest; PasskeyConfirmation *events.PairPasskeyConfirmation }
```

- Call it **before** `Connect()`.
- Errors: `ErrQRAlreadyConnected` if connected, `ErrQRStoreContainsID` if already paired. The call itself only registers an event handler, with no network I/O. The skeleton's dry run relies on that.
- Items:
  - `Event == QRChannelEventCode` (`"code"`) with `Code` (the QR payload string) and `Timeout`: 60 s for the first code, 20 s for each later one, 6 codes, about 160 s in total;
  - terminal items: `QRChannelSuccess` (`"success"`), `QRChannelTimeout` (`"timeout"`, and the client disconnects), `QRChannelErrUnexpectedEvent`, `QRChannelClientOutdated`, `QRChannelScannedWithoutMultidevice`, or `Event == "error"` with `Error`.
- The pinned version also has passkey items (`"passkey-request"`, `"passkey-confirmation"`). They are not expected for a phone-scanned QR, so log them if they appear.

### Pairing code

```go
// pair-code.go:92
func (cli *Client) PairPhone(ctx context.Context, phone string, showPushNotification bool,
    clientType PairClientType, clientDisplayName string) (string, error)
```

- **Order:** `Connect()` first, then wait for the first QR item (or `*events.QR`), then call `PairPhone`.
- `phone`: non-digits are stripped. It must be international (no leading 0) and longer than 6 digits.
  Otherwise the call fails with `ErrPhoneNumberIsNotInternational` or `ErrPhoneNumberTooShort`.
- `clientType`: one of `PairClientUnknown "0"`, `PairClientChrome "1"`, `PairClientEdge "2"`, `PairClientFirefox "3"`,
  `PairClientIE "4"`, `PairClientOpera "5"`, `PairClientSafari "6"`, `PairClientElectron "7"`, `PairClientUWP "8"`,
  `PairClientOtherWebClient "9"`, `PairClientMacOS "c"`, `PairClientAndroid "e"` (`pair-code.go:32-47`).
  Per the doc comment, which one does not matter.
- `clientDisplayName` **must be `"Browser (OS)"`**, e.g. `"Chrome (Linux)"`. The server returns 400 otherwise.
- Returns `"XXXX-XXXX"` (`pair-code.go:142`), 8 characters of the alphabet `123456789ABCDEFGHJKLMNPQRSTVWXYZ`.
  It is valid within the same ~160 s QR window.
- On success, `*events.PairSuccess` / `QRChannelSuccess` follows. A reconnect comes next, then `*events.Connected`.

### Connect, Disconnect, Logout

| Call | Signature and behaviour |
|---|---|
| `Connect` (`client.go:530`) | `Connect() error` is `ConnectContext(cli.BackgroundEventCtx)`. Returns `ErrAlreadyConnected` or `store.ErrDeviceDeleted`. |
| `ConnectContext` (`client.go:553`) | `ConnectContext(ctx) error`. `ctx` becomes the **event-handler ctx and the auto-reconnect ctx**. Cancelling it stops both, and stops acks for in-flight nodes (`decryptMessages` returns early on `ctx.Err()`). With `InitialAutoReconnect` set, retryable initial failures reconnect in the background. |
| `Disconnect` (`client.go:711`) | `Disconnect()` closes the socket and emits **no** event. The link stays valid. |
| `Logout` (`client.go:761`) | `Logout(ctx) error` sends `remove-companion-device`. Only if that succeeds does it `Disconnect()` and `Store.Delete(ctx)`. Emits no `LoggedOut` event. |
| Also | `IsConnected()`, `IsLoggedIn()`, `WaitForConnection(timeout) bool`, and `ResetConnection()`, which forces a reconnect (useful after repeated `KeepAliveTimeout`). |
| Passive | After login whatsmeow sends `SetPassive(false)` itself (`connectionevents.go:216`). It **never sends presence on its own**: `SendPresence` is only called by the user. Delivery receipts go out as `type="inactive"` unless presence is "available" (`receipt.go:285-301`). That fits the "never send presence" rule. |

## 5. Events (`types/events/events.go`)

**Registration.**
- `AddEventHandler(func(any)) uint32` (`client.go:839`).
- `AddEventHandlerWithSuccessStatus(func(any) bool) uint32` (`client.go:846`).
- `dispatchEvent` (`client.go:1033`) calls handlers in order and stops at the first one returning `false`. It reports `handlerFailed`; see §6.
- A panic in a handler is recovered and logged, **but `handlerFailed` stays `false`, so the message
  is acked.** The helper therefore recovers panics in its own handler and returns `false`
  (`handleEvent` / `handleMessage` in `helper.go`, tested by `TestPanicWithholdsTheAck`).

### events.Message (`events.go:322`)

```go
type Message struct {
    Info types.MessageInfo; Message *waE2E.Message   // unwrapped (DeviceSent/Ephemeral/ViewOnce/Edited…)
    IsEphemeral, IsViewOnce, IsViewOnceV2, IsViewOnceV2Extension, IsDocumentWithCaption, IsLottieSticker, IsBotInvoke, IsEdit bool
    SourceWebMsg *waWeb.WebMessageInfo                 // set only when parsed from history sync
    UnavailableRequestID types.MessageID; RetryCount int; NewsletterMeta *NewsletterMessageMeta
    RawMessage *waE2E.Message                          // original, still wrapped
}
```

`types.MessageInfo` (`types/message.go:99`) embeds `MessageSource` (`types/message.go:27`):

| Field | Type | Status meaning |
|---|---|---|
| `Chat` | `types.JID` | `types.StatusBroadcastJID` = `status@broadcast` (`types/jid.go:42`). Compare with `==`. |
| `Sender` | `types.JID` | The poster, from the `participant` attr. Either `…@s.whatsapp.net` or `…@lid`, **may carry a device part**, so compare `ToNonAD()`/`.User`. |
| `SenderAlt` | `types.JID` | The other identity: `participant_pn`, or `participant_lid` when addressing mode is not lid. If missing and Sender is a PN, `decryptMessages` fills it from the LID store (`message.go:328-342`). |
| `AddressingMode` | `types.AddressingMode` | `"pn"` / `"lid"` / `""` (`types/message.go:15-18`). |
| `IsFromMe` | `bool` | Own (observer) statuses. Skip them. |
| `IsGroup` | `bool` | **true** for live statuses (broadcast server, `message.go:82-83`). |
| `ID` | `types.MessageID` (= `string`) | The WhatsApp message id. Internal only: becomes `sourceKey = "wa:<ID>"` (D4). |
| `Timestamp` | `time.Time` | Server `t` attribute, second precision. Use as `occurredAt`. |
| `PushName` | `string` | Notify name, may be empty. |
| `StanzaTag` | `string` | `"status"` or `"message"`, see §1. |
| Also | | `Type`, `MediaType`, `Category`, `Edit` (`types.EditAttribute`, e.g. `"7"` = sender revoke). |

**Filter:**

```go
info.Chat == types.StatusBroadcastJID && !info.IsFromMe && (match Sender or SenderAlt against traveler)
```

**One stanza can produce several events with the same `Info.ID`.**
- `decryptMessages` dispatches one `events.Message` per decrypted `<enc>` child (`message.go:343-486`).
- A status typically arrives as a `pkmsg` part carrying only `SenderKeyDistributionMessage` (+ `MessageContextInfo`), plus an `skmsg` part carrying the content.
- Skip the content-less part. `hasContent` in `inbox.go` does this; otherwise the second write would overwrite the first.

### events.HistorySync (`events.go:275`)

`HistorySync{ Data *waHistorySync.HistorySync; Notification *waE2E.HistorySyncNotification }`.

**Getting the statuses.**
- `Data.GetStatusV3Messages() []*waWeb.WebMessageInfo` (`proto/waHistorySync/WAWebProtobufsHistorySync.pb.go:651`).
- `Data.GetSyncType()` returns one of `HistorySync_INITIAL_BOOTSTRAP 0`, **`HistorySync_INITIAL_STATUS_V3 1`**, `FULL 2`, `RECENT 3`, `PUSH_NAME 4`, `NON_BLOCKING_DATA 5`, `ON_DEMAND 6`, `RECENT_CONVERSATIONS_ON_DEMAND 9` (`…pb.go:209-216`).
- Statuses are expected in `INITIAL_STATUS_V3`. Check `GetStatusV3Messages()` on **every** blob anyway: which type carries them is to be confirmed in Phase 0.

**Converting** to the same shape as live messages:
`cli.ParseWebMessage(types.StatusBroadcastJID, webMsg) (*events.Message, error)` (`client.go:1059`). Differences from live:

| Field | History value |
|---|---|
| `Info.IsGroup` | `false` (only `g.us` is a group there) |
| `Info.SenderAlt`, `AddressingMode`, `StanzaTag` | empty |
| `Info.Sender` | from `webMsg.Participant` or `Key.Participant` |
| `Info.Timestamp` | from `MessageTimestamp` |
| `SourceWebMsg` | set |

**Dispatch.**
- Runs in a background goroutine (`handleHistorySyncNotificationLoop`, `message.go:708`).
- **The handler's return value is ignored.** The `hist_sync` receipt is sent independently (`message.go:898-912`).
- After dispatch, whatsmeow deletes the blob from the media server.

**Strict persist-before-ack alternative:**
1. Set `cli.ManualHistorySyncDownload = true` and `cli.DisableManualHistorySyncReceipt = true`.
2. In the `events.Message` handler, take `evt.Message.GetProtocolMessage().GetHistorySyncNotification()` (only `IsFromMe`).
3. Call `cli.DownloadHistorySync(ctx, notif, true)` (`message.go:779`) and persist the result.
4. Then call `cli.SendProtocolMessageReceipt(ctx, info.ID, types.ReceiptTypeHistorySync)` (`message.go:1188`).

Recommendation for Phase 0: keep the default, automatic mode. Statuses at link time are a one-off.

### Connection and state events

| Event | Fields | whatsmeow behaviour |
|---|---|---|
| `Connected` (`:97`) | none | Logged in. Also emitted after each auto-reconnect. |
| `Disconnected` (`:272`) | none | Server or network closed the socket. Auto-reconnect follows (backoff 0, 2, 4 … s; `AutoReconnectHook func(error) bool`). |
| `LoggedOut` (`:135`) | `OnConnect bool; Reason ConnectFailureReason` | External unlink (401/403/406). **whatsmeow already called `Store.Delete`** (`connectionevents.go:44,129`). The `cli` is dead (`ErrDeviceDeleted`), so exit and let Node restart for a fresh QR. |
| `StreamReplaced` (`:147`) | none | Another process uses the same session. No auto-reconnect. Do **not** restart in a tight loop. |
| `TemporaryBan` (`:181`) | `Code TempBanReason; Expire time.Duration` | No auto-reconnect. |
| `KeepAliveTimeout` (`:104`) | `ErrorCount int; LastSuccess time.Time` | Informational. whatsmeow itself forces a reconnect (`ResetConnection`) once keepalives have failed for longer than `KeepAliveMaxFailTime` = 3 min (`keepalive.go:47`, with `EnableAutoReconnect`). `KeepAliveRestored` (`:111`) follows if pings recover. |
| `ConnectFailure` (`:250`) | `Reason ConnectFailureReason; Message string; Raw *waBinary.Node` | Only **unknown** reasons. Known ones become `LoggedOut`, `TemporaryBan` or `ClientOutdated`. 500/503 auto-reconnect silently. |
| `ClientOutdated` (`:257`) | none | 405: bump the whatsmeow pin. |
| `PermanentDisconnect` | interface, `PermanentDisconnectDescription() string` | Implemented by LoggedOut, StreamReplaced, ClientOutdated, CATRefreshError, TemporaryBan and ConnectFailure. A single type assertion catches all "won't reconnect" cases. |
| `OfflineSyncPreview` / `OfflineSyncCompleted` (`:574/:584`) | | Backlog after downtime. Useful for "caught up" in the heartbeat. |
| `UndecryptableMessage` (`:301`) | `Info`, `IsUnavailable`, `UnavailableType`, `DecryptFailMode` | whatsmeow automatically sends a retry receipt. Count these for statuses: the Phase-0 target is 0. |
| `PairSuccess` (`:52`) / `PairError` (`:61`) / `QR` (`:40`) | | Linking. |

### events.MediaRetry (`events.go:593`)

```go
type MediaRetry struct { Ciphertext, IV []byte; Error *MediaRetryError /* {Code int} */; Timestamp time.Time
    MessageID types.MessageID; ChatID types.JID; SenderID types.JID; FromMe bool }
```

## 6. Persist before ack

The relevant code is `message.go:301-495` and `receipt.go:112-138`.

**Options:**

```go
cli.SynchronousAck = true             // client.go:87  "acks for messages will only be sent after all event handlers return"
cli.EnableDecryptedEventBuffer = true // client.go:88
cli.AddEventHandlerWithSuccessStatus(func(evt any) bool { … })   // client.go:846
```

**What happens for an encrypted message, status included:**

1. `bufferedDecrypt` (`message.go:514`). With the buffer enabled:
   - the ciphertext hash is looked up first;
   - otherwise decryption and `PutBufferedEvent(hash, plaintext)` run in **one DB transaction**, `DoDecryptionTxn`. So the signal-state advance and the plaintext are stored atomically.
   - If the hash is already present with plaintext, that plaintext is returned again: a redelivery after our handler failed.
   - If it is present with cleared plaintext, the result is `ErrEventAlreadyProcessed`. That is logged and skipped, and the stanza is still acked.
2. The `events.Message` is dispatched.
   - **If any handler returns `false`**, `decryptMessages` returns at `message.go:457` **without** clearing the buffer **and without** sending the receipt. The server redelivers (offline queue) on the next connect, and step 1 hands back the buffered plaintext.
   - If all handlers return `true`, the buffered plaintext is cleared (the hash is kept for 14 days for dedup) and the receipt is sent.
3. With `SynchronousAck`, `backgroundIfAsyncAck` runs the receipt inline, after the handlers. Without it, the receipt goes out in a goroutine, possibly before the handler finished.
4. The same `false` rule holds for `UndecryptableMessage`: no retry receipt, no ack.

**Buffer housekeeping.** whatsmeow prunes old buffered hashes itself (`DeleteOldBufferedHashes`,
called from `message.go:479`). The helper does nothing here.

**Handler budget.**
- `handlerQueueLoop` (`client.go:940`) processes **one node at a time**. It waits up to 10×30 s per node before continuing in the background, which breaks ordering.
- So the handler must only write `inbox/<msgId>/…json` (raw proto + media keys) with fsync, then return.
- Media download happens **after** the ack, from the persisted keys. `writeFileAtomic` in `inbox.go` does tmp, fsync, rename, then directory fsync.

## 7. LID ↔ phone number

**Interface** `store.LIDStore` (`store/store.go:187`):

```go
PutManyLIDMappings(ctx, []store.LIDMapping) error           // LIDMapping{LID, PN types.JID}
PutLIDMapping(ctx, lid, pn types.JID) error                  // lid must be @lid, pn @s.whatsapp.net
GetPNForLID(ctx, lid types.JID) (types.JID, error)           // lidmap.go:128
GetLIDForPN(ctx, pn types.JID) (types.JID, error)            // lidmap.go:118
GetManyLIDsForPNs(ctx, pns []types.JID) (map[types.JID]types.JID, error)
```

**Lookup semantics.**
- Unknown mappings return an **empty JID with a nil error**. They are cached as negative until a `Put…` updates them.
- Results keep the source's `Device`. Calling with the wrong server is an error.

**Where to get the store.**
- `cli.Store.LIDs` works once the device is saved.
- `container.LIDMap` works always.
- `(*store.Device).GetAltJID(ctx, jid)` picks the direction automatically.

**How mappings are learned.** whatsmeow fills the map automatically from:
- every incoming message with `SenderAlt` (`message.go:51-55`, `StoreLIDPNMapping` at `client.go:1119`);
- history sync `PhoneNumberToLidMappings`;
- LID-migration sync messages;
- `IsOnWhatsApp`.

**Active lookup.** `cli.IsOnWhatsApp(ctx, []string{"+49…"}) ([]types.IsOnWhatsAppResponse, error)` (`user.go:176`):
- returns `JID` (LID when known) and `PhoneNumber`, and **stores the mapping**;
- it is a usync IQ query, not a message, but it is still network traffic, so call it once after `Connected` when the traveler's LID is unknown;
- `GetUserInfo(ctx, jids)` (`user.go:232`) also returns `UserInfo.LID`.

**Matching rule (implemented in `identity.match`, `identity.go`):**
1. Normalize `Sender` and `SenderAlt` with `ToNonAD()`.
2. Match a `@s.whatsapp.net` user directly against the traveler's digits.
3. Resolve a `@lid` user via `GetPNForLID`.
4. Report a learned LID in a `traveler {pn, lid}` event. Node persists it and passes it back as
   `-traveler-lid`, so matching works even if whatsmeow's map is reset (`identity.go`).
5. If an unknown `@lid` arrives while the traveler's LID is still unknown, run one active lookup
   (`GetUserInfo`, rate-limited to one per 5 min) before counting the status as `unmatched_lid`.
   A caller that arrives while that lookup is running waits for its answer instead of deciding
   without it (`TestMatchWaitsForAnInFlightLIDLookup`).
6. History sync: `DownloadHistorySync` is called with `synchronousStorage=false`, so whatsmeow
   stores a blob's `PhoneNumberToLidMappings` in a goroutine, possibly **after** the blob's
   statuses were dispatched. History statuses carry no `SenderAlt` and are never redelivered, so
   the helper reads the traveler's pair from every blob itself before matching its statuses
   (`identity.learnFromMapping`, `TestHistorySyncLearnsTheTravelerLIDFromTheBlob`).

## 8. Media

**Signatures** (`download.go`, `download-to-file.go`):

```go
func (cli *Client) Download(ctx context.Context, msg DownloadableMessage) ([]byte, error)          // download.go:213
func (cli *Client) DownloadToFile(ctx context.Context, msg DownloadableMessage, file File) error   // download-to-file.go:41
func (cli *Client) DownloadAny(ctx context.Context, msg *waE2E.Message) ([]byte, error)            // download.go:126, Deprecated
type DownloadableMessage interface { GetDirectPath() string; GetMediaKey() []byte; GetFileSHA256() []byte; GetFileEncSHA256() []byte }
type File interface { io.Reader; io.Writer; io.Seeker; io.ReaderAt; io.WriterAt; Truncate(int64) error; Stat() (os.FileInfo, error) } // *os.File fits
```

- `*waE2E.ImageMessage`, `VideoMessage`, `AudioMessage`, `DocumentMessage` and `StickerMessage` implement `DownloadableMessage`.
- **Use `DownloadToFile` with an `*os.File`** for videos. It streams and does not buffer the whole file.

**Integrity.**
- Both calls verify the ciphertext SHA-256 (`ErrInvalidMediaEncSHA256`), the HMAC (`ErrInvalidMediaHMAC`) and the **plaintext `FileSHA256`** (`ErrInvalidMediaSHA256`).
- So "verified against FileSHA256" is done by whatsmeow. On error the file contents are garbage: truncate or delete it.

**HTTP errors** (`errors.go:119-136`).
- `DownloadHTTPError{*http.Response}` has an `Is` that compares the status code.
- Test with `errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403 / …404 / …410)`.
- For these three codes (and `ErrInvalidMediaSHA256`), `DownloadMediaWithPath` stops immediately instead of trying the next media host (`download.go:276-282`).
- Network errors, HTTP/2 stream errors and 502/503/504/429 are retried up to 5 times on the same host (backoff 1–5 s or `Retry-After`; `download.go:326-358`, `go.mau.fi/util/retryafter`). Other errors are wrapped with `%w`, so `errors.Is` still works.

**Media retry** when the CDN copy is gone (`mediaretry.go`):

```go
func (cli *Client) SendMediaRetryReceipt(ctx context.Context, message *types.MessageInfo, mediaKey []byte) error // :77
func DecryptMediaRetryNotification(evt *events.MediaRetry, mediaKey []byte) (*waMmsRetry.MediaRetryNotification, error) // :123
```

**Flow:**
1. On 403/404/410, call `SendMediaRetryReceipt(ctx, &info, imageMsg.GetMediaKey())`. This is a `server-error` receipt to our own phone. It sends `<rmr jid=Chat from_me participant=Sender>`, and `participant` **only when `info.IsGroup`**.
2. Remember `msgId → (proto, mediaKey)`.
3. On `*events.MediaRetry` with the same `MessageID`, call `DecryptMediaRetryNotification(evt, mediaKey)`.
   - It fails with `ErrMediaNotAvailableOnPhone` (error code 2), or with `ErrUnknownMediaRetryError`.
   - Check `notif.GetResult() == waMmsRetry.MediaRetryNotification_SUCCESS`. The other results are `GENERAL_ERROR 0`, `NOT_FOUND 2` and `DECRYPTION_ERROR 3`.
4. Set `msg.DirectPath = proto.String(notif.GetDirectPath())` and download again.
5. **For history-synced statuses, set `info.IsGroup = true` before the retry receipt.** `ParseWebMessage` leaves it false, so `participant` would be missing. Phase 0 should confirm that the phone answers media retries for statuses at all.

**How `media.go` implements this:**
- **Keys come from disk.** The receipt's `MessageInfo` is rebuilt from `meta.json`: Chat
  `status@broadcast`, Sender from `sender.jid`, `IsGroup = true` always, `IsFromMe` only in self
  mode. The media key comes from `rawProtoB64`. Nothing is kept only in memory: an
  `events.MediaRetry` is matched by `MessageID` to `inbox/<id>/meta.json`, including answers that
  arrive after a restart.
- **Download path.** `DownloadToFile` writes into `inbox/<id>/.dl-*`. The helper hashes the file
  again against `FileSHA256`, fsyncs it and renames it to `original.<ext>`. A failed attempt never
  leaves a partial `original.*`.
- **Error mapping** (`classifyDownloadError`):
  - 403/404/410 and `ErrNoURLPresent` → media retry;
  - `ErrInvalidMediaSHA256`/`EncSHA256`/`HMAC` → hash mismatch, retried once, then permanent;
  - deadline exceeded, `ErrIQTimedOut` and net timeouts → `timeout`;
  - other `net.Error`, other HTTP status codes, `ErrNotConnected` and `ErrIQDisconnected` → `network`;
  - anything else → `unknown`.
  - A cancelled helper context leaves the state untouched.
- **Policy** (`defaultMediaPolicy`):
  - transient backoff 15 s / 1 min / 5 min / 15 min / 30 min, then `failed`;
  - wait 10 min for an answer;
  - at most 3 receipts per run, then `failed timeout`;
  - an attempt times out after 10 min;
  - concurrency is `-media-workers` (default 2);
  - attempts wait while disconnected.
- **One writer per status.** One goroutine per unfinished download owns that `meta.json`'s
  download state; redownload requests and retry answers are posted to it.

## 9. Status read receipt (optional "captured ✓")

```go
// receipt.go:202
func (cli *Client) MarkRead(ctx context.Context, ids []types.MessageID, timestamp time.Time, chat, sender types.JID,
    receiptTypeExtra ...types.ReceiptType) error
cli.MarkRead(ctx, []types.MessageID{info.ID}, time.Now(), types.StatusBroadcastJID, info.Sender)
```

- `participant` is added for non-user chats (status included), so `sender` is required.
- If the observer's read-receipt privacy is "none", whatsmeow sends `read-self` instead. That needs a privacy-settings fetch (network, cached).
- Off by default (`SEND_READ_RECEIPT=false`).

## 10. Message contents (`proto/waE2E/WAWebProtobufsE2E.pb.go`)

Use the nil-safe getters, e.g. `msg.GetImageMessage().GetCaption()` works on a nil message.

**Text status** — `ExtendedTextMessage` (`:9368`):
- `Text *string`;
- `TextArgb *uint32`, `BackgroundArgb *uint32`: fixed32 ARGB. Emit the **raw uint32** (or null when
  unset) as `text.bgArgb` / `text.textArgb`; Node converts it with `argbToRgbaHex` (contracts).
- `Font *ExtendedTextMessage_FontType` (`:3753`): `SYSTEM 0, SYSTEM_TEXT 1, FB_SCRIPT 2, SYSTEM_BOLD 6, MORNINGBREEZE_REGULAR 7, CALISTOGA_REGULAR 8, EXO2_EXTRABOLD 9, COURIERPRIME_BOLD 10`. These match D10 exactly, and `.String()` gives the D10 names.
- A plain `Conversation` string is possible too.

**Photo** — `ImageMessage` (`:10012`):
- `Caption`, `Mimetype`;
- `Width`/`Height *uint32`;
- media fields: `FileSHA256`, `FileEncSHA256`, `MediaKey`, `DirectPath`, `FileLength`, `JPEGThumbnail`.

**Video / GIF** — `VideoMessage` (`:8992`):
- `Seconds *uint32`, `GifPlayback *bool` (true means a GIF-style muted loop);
- `Width`/`Height *uint32`, `Caption`, `GifAttribution`, plus the same media fields.

**Voice** — `AudioMessage` (`:17290`):
- `PTT *bool` (true means a voice note), `Seconds *uint32`;
- `Waveform []byte` (in practice 64 samples, 0–100; verify with fixtures), `BackgroundArgb *uint32` (voice-status background);
- `Mimetype` (in practice `audio/ogg; codecs=opus`; verify with fixtures) and the media fields.

**Revoke** — `msg.GetProtocolMessage().GetType() == waE2E.ProtocolMessage_REVOKE` (`:3220`).
- The target status is `GetProtocolMessage().GetKey().GetID()`.
- It arrives as a normal `events.Message` in `status@broadcast` from the traveler. whatsmeow does not intercept non-own protocol messages (`message.go:894-896`).
- The stanza may also carry `Info.Edit == types.EditAttributeSenderRevoke` (`"7"`).

**Marshalling the raw proto** (`google.golang.org/protobuf/proto`):

```go
raw, _ := proto.Marshal(evt.RawMessage)    // *waE2E.Message for live AND history statuses
var m waE2E.Message; _ = proto.Unmarshal(raw, &m)   // reprocessing
```

- `ParseWebMessage` sets `RawMessage = webMsg.GetMessage()` (`client.go:1100`), so `RawMessage` is
  a `waE2E.Message` for history statuses too. Do **not** marshal `SourceWebMsg` (a
  `waWeb.WebMessageInfo`): `rawProtoB64` is always a `waE2E.Message` (contract `InboxMeta`).

- `encoding/json` encodes `[]byte` as base64.
- For a human-readable copy use `protojson.Marshal`. Its output is intentionally unstable, so never hash it.

## 11. What the helper does (v0.2.0)

Files:
- `main.go`: wiring;
- `config.go`: flags/env;
- `helper.go`: the event mapping, capture, history, linking and commands;
- `media.go`: the download lifecycle;
- `identity.go`: traveler matching;
- `inbox.go`: the files;
- `protocol.go`: events and command parsing;
- `guard.go`: the reconnect guard;
- `lock.go` (+ `lock_unix.go`, `lock_other.go`): the single-instance lock;
- `stats.go`.

Flags and env are listed in README.md.

- **Startup:**
  1. `store.SetOSInfo("On My Way")`;
  2. take the single-instance lock (below); held → exit 2;
  3. open `DATA_DIR/wa/session.db` (modernc, 0600);
  4. `GetFirstDevice`, then `NewClient` with `SynchronousAck` and `EnableDecryptedEventBuffer`;
  5. `AddEventHandlerWithSuccessStatus`;
  6. `GetQRChannel` when unpaired;
  7. emit `ready {version, paired, mode}`;
  8. resume unfinished downloads (they wait for the connection);
  9. start reading commands and the 60 s stats ticker;
  10. wait for `guard.json` (temporary ban / stream_replaced cooldown);
  11. `ConnectContext`.
  `-dry-run` stops after `ready`, without any network.
- **Single instance** (README "One helper per data directory"):
  - Before `session.db` is opened, the helper takes `flock(LOCK_EX|LOCK_NB)` on
    `DATA_DIR/wa/helper.lock`: `syscall.Flock` through `File.SyscallConn`, so the file keeps its
    blocking mode, with a retry on `EINTR`.
  - `EWOULDBLOCK` → "another wa-helper is using <absolute DATA_DIR> (Docker and a manual run?)",
    `state error (fatal)` with that detail, exit 2 before `ready`. `ENOLCK` / `ENOTSUP` /
    `EOPNOTSUPP` / `ENOSYS` (no flock on that file system) → exit 2 as well. Any other error →
    exit 1.
  - A flock belongs to the open file description, not to the process or the path. So a second
    `open` + `flock` in the same process conflicts too (that is what the unit test uses), and
    `close` or process death releases it. Go opens files `O_CLOEXEC`, so no child inherits it.
  - The file is never deleted. Deleting it while another helper is between `open` and `flock`
    would let two processes lock two different inodes.
  - The lock stays held until `run` returns, after `session.db` is closed (deferred in that
    order).
  - Measured 2026-11-20 with the Linux binary on Docker Desktop for Mac (Docker 29.9):
    - A second container on the same named volume (tmpfs-backed for the test) exits 2.
    - It starts normally once the holder is gone.
    - On a bind mount (`fakeowner` file system), a macOS process and a container, and also two
      containers, all lock at the same time. Docker Desktop bind mounts are not covered.
- **Capture (live and history):**
  - Keep `status@broadcast` messages with content. The skdm-only `<enc>` parts are skipped.
  - Keep only the traveler's statuses: observer mode matches the PN/LID, self mode takes
    `IsFromMe`.
  - The `meta.json` is written (`InboxMeta`, created once) **before the handler returns**. Then
    `status` is emitted and the media download is queued.
  - Revokes: `_revokes/<revoked id>.json`, then `revoke` is emitted.
  - Live: a write failure returns `false`, so there is no ack and WhatsApp redelivers. History: 3
    write attempts, then the status is counted in `persist_failed` (whatsmeow ignores the return
    value there).
- **Media download and retry:** see §8 and the lifecycle in `wa.ts`.
- **Commands:**
  - `pair_code` waits for the first QR code, then calls `PairPhone`.
  - `logout`: `Logout` → `state logged_out` → exit 3.
  - `mark_read` only with `-send-read-receipt` and in observer mode. It reads the sender from
    `meta.json`, then calls `MarkRead(status@broadcast, sender)`.
  - `redownload` only for `failed && !permanent`.
  - `stats`; `shutdown` → exit 0; stdin EOF → exit 0.
  - An invalid or inapplicable command emits a `warning` event (`invalid_command`,
    `command_rejected`, `command_failed`) and never stops the helper.
- **State events and exits** follow the table in `wa.ts`. The exit codes are in README.md.
  - `LoggedOut`: exit 3. Before exiting, the helper makes sure the device row is gone from
    `session.db`, so the next start shows a fresh QR.
  - `StreamReplaced`: exit 4 and `guard.json.streamReplacedAt`. The next start waits 5 min.
  - `TemporaryBan`: exit 6 and `guard.json.bannedUntil`. The next start emits `state banned`
    again and waits until then. A ban without an `expire` attribute (`Expire == 0`) counts as
    1 h (`unknownBanWait`), so the next start never reconnects at once while banned.
  - A panic in one of the helper's own goroutines becomes `state error (fatal)` and exit 1
    (commands: a `command_failed` warning). An unrecovered panic would exit with Go's status 2,
    which is also `exitConfig`; config errors always exit before `ready`. Panics inside
    whatsmeow's own goroutines cannot be caught: Node should treat exit 2 after `ready` like 1.
  - A shutdown during the dial (`ConnectContext`) is a clean exit with the shutdown's code.
  - `ClientOutdated`: exit 5.
  - Unknown `ConnectFailure` / `CATRefreshError`: exit 8.
  - QR timeout or pairing error: exit 7.
- **Never sends presence.** No `SendPresence` call exists in the helper.

## 12. Phase-0 checklist

Run it with `scripts/phase0.mjs` (README.md). Everything below the first list needs the real
phones.

**Verified here without WhatsApp** (unit tests, `go test ./...`, race detector clean):
- **Files.** Classification and `meta.json` building for photo, video, gif, voice, text (all 8 D10
  fonts, colours, unknown font), conversation, unsupported kinds and revoke. The golden files are
  validated against the zod schemas, including download `ok` / `retrying` / `failed` metas
  produced by the real lifecycle code.
- **Persist-before-ack.** The file is on disk when the handler returns. A write failure returns
  `false`. A panic returns `false`.
- **Media lifecycle,** run against a fake downloader with the real
  `DecryptMediaRetryNotification` (AES-GCM answers built like the phone's):
  - ok, hash mismatch, transient backoff and give-up;
  - 404 → receipt (`IsGroup = true` also for history statuses) → SUCCESS answer → new path → ok;
  - NOT_FOUND, not_on_phone, unknown codes, receipt bound;
  - resume after a restart, including an answer that arrives after the restart;
  - overdue receipt re-sent, bounded concurrency, shutdown mid-download.
- **Commands.** Parsing and every command path, including invalid, over-long and inapplicable
  lines.
- **Identity.** LID learning from a stanza, the LID map, a history blob's PN <-> LID pairs and an
  active lookup (rate-limited; concurrent callers wait for a running lookup); self mode.
- **Events and guard.** The connection-event mapping and exit codes; guard waits.
- **Real binary, no network.** Dry run, config error (exit 2), guard wait with stdin commands
  (exit 0). Its stdout validated with `parseWaEventLine`.
- **Single instance** (`lock_test.go`, also run on Linux arm64 in a container):
  - A second lock on the same `DATA_DIR` fails with the "another wa-helper" error until the first
    is released. `EINTR` is retried; file systems without flock are reported as unsupported.
  - The real `main()` exits 2 with only the `state error` event on stdout and never creates
    `session.db` while another process holds the lock.
  - After the holder is killed with `SIGKILL`, the next start succeeds; so does the one after a
    clean exit.

**Pending: needs the phones (Phase 0, plan "Rollout").** Record the answers here.
1. **Linking.** QR scan and pairing code. Does the phone list "On My Way"? Is a passkey ever
   requested? (The helper reports `pair_error` then.)
2. **Live statuses** from the traveler: photo, video, GIF, text in several fonts and colours,
   voice, on Android and iOS if possible.
   - All arrive (`status_stanzas` > 0 shows the new `<status>` stanza path).
   - `undecryptable` stays 0.
   - `addressingMode` / `stanzaTag` / `sender.jid` values as recorded.
3. **LID.** Is `traveler {pn, lid}` emitted on the first status or after `Connected`? Do LID-only
   stanzas match after a restart with `-traveler-lid`?
4. **History sync** at link time: in which sync type do statuses arrive (`INITIAL_STATUS_V3`
   expected)? Do they carry media keys that still download?
5. **Media availability** after a 2 h and a 26 h stop (`media_retry`, `media_retry_answers`, final
   states in `phase0-events.jsonl`). Does the phone answer media-retry receipts for **statuses** at
   all, and with which result?
6. **Revoke** of a posted status → `_revokes/<id>.json`.
7. **Read receipt** (`-send-read-receipt`, `read <msgId>`): does the traveler see the observer in
   "viewed by"?
8. **Notifications.** The observer phone keeps its notifications (no presence is ever sent).
9. **Real samples.** Waveform length and voice mimetype from real samples. These become fixtures.
10. **Unlink, stream_replaced, ban.** Unlink on the phone → `logged_out`, exit 3 → a fresh QR on
    restart. A second instance on the same `DATA_DIR` exits 2 (single-instance lock). To provoke
    `stream_replaced` and the cooldown, copy `wa/session.db` (while no helper runs) into another
    `DATA_DIR` and run a second helper there. Statuses that the copy acks land only in the copy's
    inbox, so use test statuses and delete the copy afterwards. Bans are hopefully never observed.
