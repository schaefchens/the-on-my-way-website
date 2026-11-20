// Command wa-helper is the WhatsApp capture helper of "On My Way" (docs/PLAN.md, section A1).
//
// It is a linked device of the observer account (or, with -mode self, of the traveler's own
// account) and keeps only the traveler's status posts. Protocol channel: stdout carries JSON
// lines ONLY (WaEvent); stdin carries WaCommand lines. Logs (ours and whatsmeow's) go to stderr.
// The protocol (events, commands, inbox files, exit codes) is specified ONLY by
// packages/contracts/src/wa.ts (D9). See README.md for running it and NOTES.md for the
// whatsmeow API notes and what is verified vs. pending the Phase-0 phone test.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	waLog "go.mau.fi/whatsmeow/util/log"

	// Pure-Go SQLite driver (no cgo). Registers the database/sql driver name "sqlite".
	_ "modernc.org/sqlite"
)

const (
	// helperVersion is reported in the ready event.
	helperVersion = "0.2.0"
	// sqliteDriver is the database/sql driver name registered by modernc.org/sqlite. whatsmeow passes the
	// same string to dbutil.ParseDialect, which maps every name starting with "sqlite" to the SQLite dialect.
	sqliteDriver = "sqlite"
	// deviceName is what the observer phone shows under "Linked devices" (store.DeviceProps.Os).
	deviceName = "On My Way"
	// shutdownGrace bounds waiting for media jobs after the context is cancelled.
	shutdownGrace = 10 * time.Second
)

// sessionDSN builds a modernc.org/sqlite URI for the whatsmeow session DB.
// foreign_keys is mandatory (sqlstore.Container.Upgrade fails without it); the others mirror
// mautrix's "sqlite3-fk-wal-fullsync" setup. All _pragma values are applied on every new connection.
func sessionDSN(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	q := "_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_txlock=immediate"
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(abs), RawQuery: q}).String(), nil
}

func openSessionStore(ctx context.Context, path string, log waLog.Logger) (*sqlstore.Container, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// The DB holds the device's private keys: create it 0600 (SQLite gives -wal/-shm the same mode).
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	dsn, err := sessionDSN(path)
	if err != nil {
		return nil, err
	}
	// sqlstore.New = sql.Open(dialect, dsn) + schema upgrade.
	return sqlstore.New(ctx, sqliteDriver, dsn, log)
}

func main() {
	// stdout is the protocol channel: events go to a private duplicate of fd 1, and fd 1 itself
	// now points at stderr, so stray writes by any library cannot corrupt it (stdio.go).
	stdout, err := protocolStdout()
	if err != nil {
		fmt.Fprintln(os.Stderr, "wa-helper: cannot isolate the protocol channel, using stdout as is:", err)
		stdout = os.Stdout
	}
	out := newEmitter(stdout)
	cfg, err := parseConfig(os.Args[1:], os.Getenv, os.Stderr)
	if errors.Is(err, flag.ErrHelp) {
		os.Exit(exitOK)
	}
	if err != nil {
		out.state("error", stateInfo{reason: "fatal", detail: "invalid configuration: " + err.Error()})
		fmt.Fprintln(os.Stderr, "wa-helper: invalid configuration:", err)
		os.Exit(exitConfig)
	}
	code, err := runSafely(cfg, out)
	if err != nil {
		out.state("error", stateInfo{reason: "fatal", detail: err.Error()})
		fmt.Fprintln(os.Stderr, "wa-helper:", err)
		if code == exitOK {
			code = exitFatal
		}
	}
	os.Exit(code)
}

// runSafely is run with a panic turned into a fatal error (exit 1): an unrecovered panic would
// exit with Go's status 2, which collides with exitConfig (README "Exit codes").
func runSafely(cfg config, out *emitter) (code int, err error) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "wa-helper: panic: %v\n%s", r, debug.Stack())
			code, err = exitFatal, fmt.Errorf("internal error: %v", r)
		}
	}()
	return run(cfg, out)
}

func run(cfg config, out *emitter) (int, error) {
	logger := zerolog.New(os.Stderr).Level(cfg.logLevel).With().Timestamp().Logger()
	waLogger := waLog.Zerolog(logger)
	setupSignalLog(logger) // libsignal would otherwise print to stdout (stdio.go)

	sigCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, stop := context.WithCancel(sigCtx)
	defer stop()

	// Device name on the observer phone. Must be set before the first pairing (it is sent in the
	// registration payload); changing it later has no effect on an existing link.
	store.SetOSInfo(deviceName, [3]uint32{0, 2, 0})

	// One helper per data directory (lock.go), taken before anything in it is opened. Held until
	// run returns; the OS releases it on any exit, including a crash.
	lock, err := acquireInstanceLock(cfg.dataDir)
	if errors.Is(err, errInstanceLocked) || errors.Is(err, errLockUnsupported) {
		return exitConfig, err // before `ready`: Node does not restart (fix the setup)
	} else if err != nil {
		return exitFatal, fmt.Errorf("lock the data directory: %w", err)
	}
	defer func() { _ = lock.release() }() // also keeps the lock file from being finalized early

	waDir := filepath.Join(cfg.dataDir, "wa")
	container, err := openSessionStore(ctx, filepath.Join(waDir, "session.db"), waLogger.Sub("Database"))
	if err != nil {
		return exitFatal, fmt.Errorf("open session store: %w", err)
	}
	defer container.Close()

	device, err := container.GetFirstDevice(ctx) // a fresh, unsaved device when the DB is empty
	if err != nil {
		return exitFatal, fmt.Errorf("load device: %w", err)
	}

	cli := whatsmeow.NewClient(device, waLogger.Sub("Client"))
	cli.SynchronousAck = true             // receipts only after all handlers returned true
	cli.EnableDecryptedEventBuffer = true // plaintext survives a crash between decrypt and ack
	cli.BackgroundEventCtx = logger.WithContext(context.WithoutCancel(ctx))
	// Presence: the helper never calls SendPresence and whatsmeow never sends it on its own, so
	// the observer phone keeps its notifications (delivery receipts go out as "inactive").

	st := &stats{}
	inboxDir := filepath.Join(cfg.dataDir, "inbox")
	self := cfg.mode == modeSelf
	travelerPN := cfg.travelerPhone
	if self {
		travelerPN = "" // learned from the linked account after connecting
	}
	id := newIdentity(self, travelerPN, cfg.travelerLID, container.LIDMap)
	id.onChange = func(pn, lid string) {
		f := map[string]any{"pn": pn}
		if lid != "" {
			f["lid"] = lid
		}
		out.emit("traveler", f)
	}
	id.activeLookup = func(ctx context.Context, pn types.JID) (string, error) {
		infos, err := cli.GetUserInfo(ctx, []types.JID{pn})
		if err != nil {
			logger.Warn().Err(err).Msg("traveler LID lookup failed")
			return "", err
		}
		for _, info := range infos {
			if !info.LID.IsEmpty() {
				return info.LID.User, nil
			}
		}
		return "", nil
	}

	media := newMediaManager(ctx, inboxDir, cli, out, logger.With().Str("component", "media").Logger(), st, cfg.mediaWorkers, self)
	h := &helper{
		ctx: ctx, stop: stop, cfg: cfg, cli: cli, out: out, log: logger, inboxDir: inboxDir,
		guardPath: filepath.Join(waDir, guardFile), id: id, media: media, stats: st, now: time.Now,
		own: func() (types.JID, types.JID) {
			if cli.Store.ID == nil {
				return types.EmptyJID, types.EmptyJID
			}
			return cli.Store.ID.ToNonAD(), cli.Store.LID.ToNonAD()
		},
	}
	cli.AddEventHandlerWithSuccessStatus(h.handleEvent)
	out.setOnFail(func(err error) {
		logger.Warn().Err(err).Msg("stdout is broken (Node went away), shutting down")
		h.exit(exitOK)
	})

	paired := cli.Store.ID != nil
	// A linked helper rides out a network failure at the first connect like any later one
	// (whatsmeow reconnects in the background, emitting Disconnected) instead of exiting fatal.
	// whatsmeow never auto-reconnects an unlinked store, so linking still fails fast.
	cli.InitialAutoReconnect = paired
	var qrChan <-chan whatsmeow.QRChannelItem
	if !paired {
		// Must be obtained BEFORE Connect(); it only registers an event handler.
		if qrChan, err = cli.GetQRChannel(ctx); err != nil {
			return exitFatal, fmt.Errorf("get QR channel: %w", err)
		}
		// Linking is in progress from now on: a pair_code command sent right after `ready` (or
		// during a guard wait) waits for the first QR code instead of being rejected.
		h.startPairing()
	}

	out.emit("ready", map[string]any{"version": helperVersion, "paired": paired, "mode": cfg.mode})
	if !cfg.connect {
		return exitOK, nil // dry run: everything is wired, nothing touched the network
	}

	if n, err := media.resume(); err != nil {
		logger.Error().Err(err).Msg("cannot scan the inbox for unfinished downloads")
	} else if n > 0 {
		logger.Info().Int("downloads", n).Msg("resuming unfinished media downloads once connected")
	}
	h.goSafe("stdin commands", func() { h.readCommands(os.Stdin) })
	h.goSafe("stats ticker", func() { h.periodicStats(cfg.statsInterval) })

	if h.waitGuard() {
		if qrChan != nil {
			h.goSafe("QR channel", func() { h.forwardQR(qrChan) })
		}
		if err := h.connect(cli.ConnectContext); err != nil {
			return exitFatal, err
		}
	}
	<-ctx.Done()

	cli.Disconnect() // does not log out; the link stays valid
	if !media.wait(shutdownGrace) {
		logger.Warn().Msg("media downloads did not stop in time")
	}
	h.exit(exitOK) // no-op when an exit code was set before
	if h.exitCode == exitLoggedOut {
		ensureSessionDeleted(container, logger)
	}
	h.emitStats()
	return h.exitCode, nil
}

// ensureSessionDeleted makes sure a logged-out device is gone from session.db before the
// process exits, so the next start shows a fresh QR instead of reconnecting with a dead session.
// whatsmeow deletes it itself on LoggedOut, but concurrently with our exit.
func ensureSessionDeleted(container *sqlstore.Container, logger zerolog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		dev, err := container.GetFirstDevice(ctx)
		if err == nil && dev.ID == nil {
			return // no linked device left
		}
		select {
		case <-ctx.Done():
			if err == nil && dev.ID != nil {
				if delErr := dev.Delete(context.Background()); delErr != nil {
					logger.Error().Err(delErr).Msg("cannot delete the logged-out session; delete wa/session.db to relink")
				}
			}
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}
