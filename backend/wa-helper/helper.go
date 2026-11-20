package main

// whatsmeow event -> WaEvent mapping, status capture (persist before ack), history-synced
// statuses, QR / pairing-code linking and the stdin commands. The mapping table and the
// supervisor policies are in the header of packages/contracts/src/wa.ts.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"runtime/debug"
	"sync"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Exit codes the Node supervisor acts on (also listed in the wa.ts header and README.md).
const (
	exitOK             = 0 // shutdown command, stdin EOF, SIGTERM/SIGINT
	exitFatal          = 1 // fatal startup/runtime error (state error, reason fatal)
	exitConfig         = 2 // invalid flags / environment, or another helper holds DATA_DIR (lock.go)
	exitLoggedOut      = 3 // unlinked: the next start shows a fresh QR; alert
	exitStreamReplaced = 4 // another client uses this session; the next start waits a cooldown
	exitClientOutdated = 5 // bump the whatsmeow pin
	exitTemporaryBan   = 6 // the next start waits until the ban has ended
	exitPairingEnded   = 7 // QR window over / pairing failed without a link; restart for a new QR
	exitConnectFailure = 8 // unknown connect failure (no auto-reconnect); restart with backoff
)

const (
	sourceLive    = "live"
	sourceHistory = "history"
	// pairDisplayName is sent with pairing-code linking; the server only accepts "Browser (OS)".
	pairDisplayName = "Chrome (Linux)"
	// commandTimeout bounds the WhatsApp calls behind stdin commands.
	commandTimeout = 30 * time.Second
	// pairReadyTimeout: how long a pair_code command waits for the websocket (first QR code).
	pairReadyTimeout = 60 * time.Second
)

// historyPersistRetryDelay separates the write attempts of a history status (a var for tests).
var historyPersistRetryDelay = 500 * time.Millisecond

// waClient is the part of *whatsmeow.Client the helper uses (a fake in tests).
type waClient interface {
	mediaAPI
	MarkRead(ctx context.Context, ids []types.MessageID, timestamp time.Time, chat, sender types.JID, receiptTypeExtra ...types.ReceiptType) error
	Logout(ctx context.Context) error
	PairPhone(ctx context.Context, phone string, showPushNotification bool, clientType whatsmeow.PairClientType, clientDisplayName string) (string, error)
	ParseWebMessage(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error)
}

type helper struct {
	ctx       context.Context
	stop      context.CancelFunc
	cfg       config
	cli       waClient
	out       *emitter
	log       zerolog.Logger
	inboxDir  string
	guardPath string
	id        *identity
	media     *mediaManager
	stats     *stats
	now       func() time.Time
	// own returns the linked account's phone-number JID and LID (empty before pairing).
	own func() (pn, lid types.JID)

	exitOnce sync.Once
	exitCode int

	pairMu    sync.Mutex
	pairing   bool          // a QR channel is active (the store was unlinked at start)
	pairEnded bool          // the QR channel finished (success, timeout, error)
	qrReady   chan struct{} // closed with the first QR code: the websocket is up, PairPhone allowed
	qrSeen    bool
}

// exit ends the helper; the first exit code wins (e.g. logged_out over a later stdin EOF).
func (h *helper) exit(code int) {
	h.exitOnce.Do(func() {
		h.exitCode = code
		h.stop()
	})
}

func (h *helper) emitStats() {
	h.out.emit("stats", map[string]any{"counters": h.stats.counters(h.media.active())})
}

// ---------------------------------------------------------------------------------------------
// whatsmeow events

// handleEvent is registered with AddEventHandlerWithSuccessStatus. Returning false for a message
// makes whatsmeow withhold the receipt (SynchronousAck), so WhatsApp redelivers it and the
// decrypted-event buffer hands the plaintext back. whatsmeow's own panic recovery would report
// success (and ack), so panics are recovered here and turned into false.
func (h *helper) handleEvent(rawEvt any) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			h.stats.handlerPanics.Add(1)
			h.log.Error().Interface("panic", r).Str("event", fmt.Sprintf("%T", rawEvt)).Bytes("stack", debug.Stack()).
				Msg("event handler panicked, withholding the ack")
			ok = false
		}
	}()
	switch evt := rawEvt.(type) {
	case *events.Message:
		return h.handleMessage(evt, sourceLive)
	case *events.UndecryptableMessage:
		if evt.Info.Chat == types.StatusBroadcastJID {
			h.stats.undecryptable.Add(1)
			h.log.Warn().Str("id", evt.Info.ID).Bool("unavailable", evt.IsUnavailable).Msg("undecryptable status (whatsmeow sent a retry receipt)")
		}
	case *events.HistorySync:
		h.handleHistorySync(evt) // whatsmeow ignores the return value for history syncs
	case *events.MediaRetry:
		h.media.onMediaRetry(evt)
	case *events.Connected:
		h.onConnected()
	case *events.Disconnected:
		h.media.setOnline(false)
		h.out.state("closed", stateInfo{reason: "disconnected"})
	case *events.KeepAliveTimeout:
		// whatsmeow itself forces a reconnect after 3 minutes without a successful keepalive.
		h.out.state("closed", stateInfo{reason: "keepalive_timeout", code: intPtr(evt.ErrorCount)})
	case *events.KeepAliveRestored:
		h.out.state("open", stateInfo{reason: "keepalive_restored"})
	case *events.LoggedOut:
		h.media.setOnline(false)
		h.out.state("logged_out", stateInfo{code: intPtr(int(evt.Reason)), detail: evt.Reason.String()})
		h.exit(exitLoggedOut)
	case *events.StreamReplaced:
		h.media.setOnline(false)
		now := h.now()
		if err := updateGuard(h.guardPath, func(g *guardState) { g.StreamReplacedAt = isoUTC(now) }); err != nil {
			h.log.Error().Err(err).Msg("cannot persist the stream_replaced guard")
		}
		h.out.state("stream_replaced", stateInfo{detail: fmt.Sprintf(
			"another client took over this session; the helper will not connect again before %s", isoUTC(now.Add(streamReplacedCooldown)))})
		h.exit(exitStreamReplaced)
	case *events.TemporaryBan:
		h.media.setOnline(false)
		wait, detail := evt.Expire, evt.String()
		if wait <= 0 {
			// whatsmeow reports 0 when the stanza had no expire attribute. A zero wait would let
			// the next start reconnect at once, while still banned.
			wait = unknownBanWait
			detail += fmt.Sprintf(" (no ban end received; not connecting again for %s)", unknownBanWait)
		}
		until := h.now().Add(wait)
		code := int(evt.Code)
		if err := updateGuard(h.guardPath, func(g *guardState) { g.BannedUntil, g.BanCode = isoUTC(until), &code }); err != nil {
			h.log.Error().Err(err).Msg("cannot persist the temporary-ban guard")
		}
		h.out.state("banned", stateInfo{reason: "temporary_ban", code: intPtr(code), until: until, detail: detail})
		h.exit(exitTemporaryBan)
	case *events.ConnectFailure:
		h.out.state("error", stateInfo{reason: "connect_failure", code: intPtr(int(evt.Reason)), detail: evt.Message})
		h.exit(exitConnectFailure)
	case *events.CATRefreshError:
		h.out.state("error", stateInfo{reason: "connect_failure", detail: fmt.Sprint(evt.Error)})
		h.exit(exitConnectFailure)
	case *events.ClientOutdated:
		h.out.state("error", stateInfo{reason: "client_outdated"})
		h.exit(exitClientOutdated)
	case *events.PairSuccess:
		h.out.state("pairing", stateInfo{reason: "pair_success", jid: evt.ID.ToNonAD().String()})
	case *events.OfflineSyncCompleted:
		h.log.Info().Int("count", evt.Count).Msg("offline backlog delivered")
	}
	return true
}

func (h *helper) onConnected() {
	pn, lid := h.own()
	jid := ""
	if !pn.IsEmpty() {
		jid = pn.ToNonAD().String()
	}
	h.out.state("open", stateInfo{jid: jid})
	h.media.setOnline(true)
	if h.cfg.mode == modeSelf {
		if h.cfg.travelerPhone != "" && pn.User != "" && pn.User != h.cfg.travelerPhone {
			h.log.Warn().Str("linked", pn.User).Str("configured", h.cfg.travelerPhone).
				Msg("self mode: the linked account is not TRAVELER_PHONE; capturing the linked account's statuses")
		}
		h.id.setSelf(pn.User, lid.User)
		return
	}
	h.goSafe("traveler LID lookup", func() { h.id.ensureLID(h.ctx) })
}

// goSafe runs fn in a goroutine of its own. An unrecovered panic would end the process with
// Go's exit status 2, which the supervisor reads as "invalid configuration" and does not
// restart; it becomes a fatal error (exit 1, restarted with backoff) instead.
func (h *helper) goSafe(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				h.log.Error().Interface("panic", r).Str("goroutine", name).Bytes("stack", debug.Stack()).Msg("internal error")
				h.out.state("error", stateInfo{reason: "fatal", detail: fmt.Sprintf("internal error in %s: %v", name, r)})
				h.exit(exitFatal)
			}
		}()
		fn()
	}()
}

// goCommand runs the WhatsApp call behind a stdin command in a goroutine of its own; a panic
// becomes a command_failed warning (a command never ends the helper).
func (h *helper) goCommand(cmd, msgID string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				h.log.Error().Interface("panic", r).Str("command", cmd).Bytes("stack", debug.Stack()).Msg("command panicked")
				h.out.warning(warnCommandFailed, cmd, msgID, fmt.Sprintf("internal error: %v", r))
			}
		}()
		fn()
	}()
}

// connect dials WhatsApp. A failure while the helper is already shutting down (SIGTERM, stdin
// EOF or the shutdown command during the dial) is not an error: the exit code stays the one the
// shutdown chose.
func (h *helper) connect(dial func(context.Context) error) error {
	h.out.state("connecting", stateInfo{})
	err := dial(h.ctx)
	if err == nil {
		return nil
	}
	if h.ctx.Err() != nil {
		h.log.Info().Err(err).Msg("connect interrupted by shutdown")
		return nil
	}
	h.exit(exitFatal)
	return fmt.Errorf("connect: %w", err)
}

// handleMessage captures one status. Returns false (no ack) when a live status could not be
// persisted. Recovers its own panics so one bad history status cannot stop the rest.
func (h *helper) handleMessage(evt *events.Message, source string) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			h.stats.handlerPanics.Add(1)
			h.log.Error().Interface("panic", r).Str("id", evt.Info.ID).Bytes("stack", debug.Stack()).Msg("status handler panicked")
			ok = false
		}
	}()
	info := evt.Info
	if info.Chat != types.StatusBroadcastJID {
		return true
	}
	if !hasContent(evt.Message) {
		// One stanza yields one event per <enc> child: the pkmsg part often carries only the
		// SenderKeyDistributionMessage, the skmsg part the actual status (same Info.ID).
		return true
	}
	if source == sourceLive && info.StanzaTag == "status" {
		h.stats.statusStanzas.Add(1) // once per status, not per <enc> part
	}
	switch h.id.match(h.ctx, info) {
	case matchYes:
	case matchOwnIgnored:
		return true
	case matchError:
		// The LID map could not be read: the sender may be the traveler. Never ack what may be
		// a traveler status without storing it; a live status is redelivered.
		h.log.Error().Str("id", info.ID).Str("sender", info.Sender.String()).Msg("cannot resolve the sender's LID, withholding the ack")
		return h.persistFailure(source)
	case matchUnknownLID:
		h.stats.unmatchedLID.Add(1)
		h.stats.otherSenders.Add(1)
		return true
	default:
		h.stats.otherSenders.Add(1) // counted only, never stored
		return true
	}

	if pm := evt.Message.GetProtocolMessage(); pm != nil {
		if pm.GetType() != waE2E.ProtocolMessage_REVOKE {
			return true // edits, ephemeral settings etc. are not statuses
		}
		return h.persistRevoke(info, pm.GetKey().GetID(), source)
	}

	if !validMsgID(info.ID) {
		h.stats.invalidID.Add(1)
		h.log.Warn().Str("id", info.ID).Msg("status id outside the contract's MsgId, skipping")
		return true
	}
	pn, lid := h.id.current()
	meta, err := buildMeta(info, evt.Message, evt.RawMessage, source, h.now(), pn, lid)
	if err != nil {
		h.log.Error().Err(err).Str("id", info.ID).Msg("cannot build meta.json")
		return h.persistFailure(source)
	}
	created, err := h.persistWithRetry(source, func() (bool, error) { return persistMeta(h.inboxDir, meta) })
	if err != nil {
		h.log.Error().Err(err).Str("id", info.ID).Str("source", source).Msg("cannot persist status")
		return h.persistFailure(source)
	}
	if created {
		h.stats.captured.Add(1)
		h.log.Info().Str("id", info.ID).Str("kind", meta.Kind).Str("source", source).Msg("status captured")
	}
	h.out.emit("status", map[string]any{"msgId": info.ID, "source": source})
	if isMediaKind(meta.Kind) {
		h.media.ensure(meta.MsgID) // downloads run after the ack, from the persisted keys
	}
	return true
}

func (h *helper) persistRevoke(info types.MessageInfo, target, source string) bool {
	// Keyed by the REVOKED status, never by the revoke message's own id (wa.ts).
	if !validMsgID(target) {
		h.stats.invalidID.Add(1)
		h.log.Warn().Str("id", target).Msg("revoke target outside the contract's MsgId, skipping")
		return true
	}
	at := info.Timestamp
	if at.IsZero() || at.Unix() <= 0 {
		at = h.now()
	}
	rec := revokeRecord{Schema: 1, MsgID: target, At: isoUTC(at)}
	if _, err := h.persistWithRetry(source, func() (bool, error) { return true, persistRevoke(h.inboxDir, rec) }); err != nil {
		h.log.Error().Err(err).Str("id", target).Msg("cannot persist revoke")
		return h.persistFailure(source)
	}
	h.stats.revokes.Add(1)
	h.log.Info().Str("id", target).Msg("status revoked")
	h.out.emit("revoke", map[string]any{"msgId": rec.MsgID, "at": rec.At})
	return true
}

// persistWithRetry runs write once for live statuses (failure = no ack = redelivery) and up to
// three times for history statuses (whatsmeow does not redeliver those).
func (h *helper) persistWithRetry(source string, write func() (bool, error)) (bool, error) {
	tries := 1
	if source == sourceHistory {
		tries = 3
	}
	var err error
	for i := 0; i < tries; i++ {
		var created bool
		if created, err = write(); err == nil {
			return created, nil
		}
		if i+1 < tries {
			select {
			case <-time.After(historyPersistRetryDelay):
			case <-h.ctx.Done():
				return false, err
			}
		}
	}
	return false, err
}

// persistFailure: live -> false (withhold the ack); history -> counted (cannot be redelivered).
func (h *helper) persistFailure(source string) bool {
	if source == sourceHistory {
		h.stats.persistFailed.Add(1)
		return true
	}
	return false
}

// handleHistorySync persists the statuses of a history sync blob like live ones (source
// "history"). Statuses are expected in INITIAL_STATUS_V3 blobs, but every blob is checked.
// The blob's phone-number <-> LID pairs are read first: history statuses name their sender by
// participant only (no SenderAlt), whatsmeow stores the pairs in its LID map in the background,
// and a history status that does not match now is lost for good (it is never redelivered).
func (h *helper) handleHistorySync(evt *events.HistorySync) {
	for _, m := range evt.Data.GetPhoneNumberToLidMappings() {
		pn, pnErr := types.ParseJID(m.GetPnJID())
		lid, lidErr := types.ParseJID(m.GetLidJID())
		if pnErr == nil && lidErr == nil {
			h.id.learnFromMapping(pn, lid)
		}
	}
	statuses := evt.Data.GetStatusV3Messages()
	if len(statuses) == 0 {
		return
	}
	h.log.Info().Str("sync_type", evt.Data.GetSyncType().String()).Int("statuses", len(statuses)).Msg("history sync with statuses")
	for _, webMsg := range statuses {
		msgEvt, err := h.cli.ParseWebMessage(types.StatusBroadcastJID, webMsg)
		if err != nil {
			h.log.Warn().Err(err).Msg("cannot parse a history status")
			continue
		}
		h.stats.historyStatuses.Add(1)
		h.handleMessage(msgEvt, sourceHistory)
	}
}

// ---------------------------------------------------------------------------------------------
// Linking

// startPairing is called when the store is unlinked and a QR channel exists.
func (h *helper) startPairing() {
	h.pairMu.Lock()
	defer h.pairMu.Unlock()
	h.pairing, h.pairEnded, h.qrReady, h.qrSeen = true, false, make(chan struct{}), false
}

func (h *helper) endPairing() {
	h.pairMu.Lock()
	defer h.pairMu.Unlock()
	h.pairEnded = true
}

// forwardQR turns QR channel items into protocol events. On the first code the websocket is up,
// so a pairing code (flag -pair-phone) may be requested.
func (h *helper) forwardQR(ch <-chan whatsmeow.QRChannelItem) {
	for item := range ch {
		switch item.Event {
		case whatsmeow.QRChannelEventCode:
			h.pairMu.Lock()
			first := !h.qrSeen
			if first {
				h.qrSeen = true
				close(h.qrReady)
			}
			h.pairMu.Unlock()
			h.out.state("qr", stateInfo{})
			h.out.emit("qr", map[string]any{"code": item.Code, "expiresAt": isoUTC(h.now().Add(item.Timeout))})
			if first && h.cfg.pairPhone != "" {
				h.goCommand(cmdPairCode, "", func() { h.requestPairCode(h.cfg.pairPhone) })
			}
		case whatsmeow.QRChannelSuccess.Event:
			h.endPairing() // the state event comes from events.PairSuccess (with the jid)
		case whatsmeow.QRChannelTimeout.Event:
			h.endPairing()
			if h.ctx.Err() == nil {
				h.out.state("closed", stateInfo{reason: "pair_timeout"})
				h.exit(exitPairingEnded)
			}
		case whatsmeow.QRChannelEventError:
			h.endPairing()
			h.out.state("error", stateInfo{reason: "pair_error", detail: fmt.Sprint(item.Error)})
			h.exit(exitPairingEnded)
		case whatsmeow.QRChannelClientOutdated.Event:
			h.endPairing()
			h.out.state("error", stateInfo{reason: "client_outdated"})
			h.exit(exitClientOutdated)
		case whatsmeow.QRChannelScannedWithoutMultidevice.Event:
			h.endPairing()
			h.out.state("error", stateInfo{reason: "pair_error", detail: "the QR code was scanned by a phone without multi-device support"})
			h.exit(exitPairingEnded)
		case whatsmeow.QRChannelErrUnexpectedEvent.Event:
			// A connection event (LoggedOut, TemporaryBan, ConnectFailure…) ended the window;
			// its own handler emits the state and exits.
			h.endPairing()
			h.log.Warn().Msg("QR channel ended by an unexpected connection event")
		case whatsmeow.QRChannelEventPasskeyRequest:
			h.out.state("error", stateInfo{reason: "pair_error", detail: "the phone asked for passkey linking, which the helper does not support; use the QR code or a pairing code"})
		default:
			h.log.Warn().Str("event", item.Event).Msg("unhandled QR channel item")
		}
	}
}

// requestPairCode asks WhatsApp for a pairing code ("XXXX-XXXX") for the observer number.
func (h *helper) requestPairCode(phone string) {
	h.pairMu.Lock()
	pairing, ended, ready := h.pairing, h.pairEnded, h.qrReady
	h.pairMu.Unlock()
	if !pairing || ended {
		h.out.warning(warnCommandRejected, cmdPairCode, "", "no linking in progress (already linked, or the window ended: restart the helper)")
		return
	}
	select {
	case <-ready:
	case <-time.After(pairReadyTimeout):
		h.out.warning(warnCommandFailed, cmdPairCode, "", "not connected to WhatsApp yet (network, or a ban / stream_replaced wait): no QR window to request a pairing code in; try again later")
		return
	case <-h.ctx.Done():
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, commandTimeout)
	defer cancel()
	code, err := h.cli.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, pairDisplayName)
	if err != nil {
		h.out.warning(warnCommandFailed, cmdPairCode, "", err.Error())
		return
	}
	h.out.emit("pair_code", map[string]any{"code": code})
}

// ---------------------------------------------------------------------------------------------
// stdin commands

// readCommands handles WaCommand lines until stdin ends (Node went away), then shuts down.
func (h *helper) readCommands(r io.Reader) {
	err := readLines(r, maxCommandLine, func(line []byte, lineErr error) {
		if lineErr != nil {
			h.stats.invalidCommands.Add(1)
			h.out.warning(warnInvalidCommand, "", "", lineErr.Error())
			return
		}
		cmd, err := parseCommand(line)
		if err != nil {
			h.stats.invalidCommands.Add(1)
			var ce *commandError
			typ := ""
			if errors.As(err, &ce) {
				typ = ce.Type
			}
			h.out.warning(warnInvalidCommand, typ, "", err.Error())
			return
		}
		h.dispatch(cmd)
	})
	if err != nil {
		h.log.Error().Err(err).Msg("reading stdin failed")
	}
	if h.ctx.Err() == nil {
		h.log.Info().Msg("stdin closed, shutting down")
	}
	h.exit(exitOK)
}

// dispatch runs one valid command. WhatsApp calls run in their own goroutine, so a slow call
// never blocks stdin (and shutdown).
func (h *helper) dispatch(cmd command) {
	defer func() {
		if r := recover(); r != nil {
			h.log.Error().Interface("panic", r).Str("command", cmd.Type).Bytes("stack", debug.Stack()).Msg("command panicked")
			h.out.warning(warnCommandFailed, cmd.Type, cmd.MsgID, fmt.Sprintf("internal error: %v", r))
		}
	}()
	switch cmd.Type {
	case cmdStats:
		h.emitStats()
	case cmdShutdown:
		h.exit(exitOK)
	case cmdLogout:
		h.goCommand(cmdLogout, "", h.logout)
	case cmdPairCode:
		h.goCommand(cmdPairCode, "", func() { h.requestPairCode(cmd.Phone) })
	case cmdMarkRead:
		h.goCommand(cmdMarkRead, cmd.MsgID, func() { h.markRead(cmd.MsgID) })
	case cmdRedownload:
		if err := h.media.redownload(cmd.MsgID); err != nil {
			h.out.warning(warnCommandRejected, cmdRedownload, cmd.MsgID, err.Error())
		}
	}
}

func (h *helper) logout() {
	if pn, _ := h.own(); pn.IsEmpty() {
		h.out.warning(warnCommandRejected, cmdLogout, "", "not linked")
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, commandTimeout)
	defer cancel()
	// Logout sends remove-companion-device and deletes the local session only if that worked.
	if err := h.cli.Logout(ctx); err != nil {
		h.out.warning(warnCommandFailed, cmdLogout, "", err.Error())
		return
	}
	h.media.setOnline(false)
	h.out.state("logged_out", stateInfo{detail: "logout command"})
	h.exit(exitLoggedOut)
}

// markRead sends the optional "captured ✓" status read receipt (off unless SEND_READ_RECEIPT).
func (h *helper) markRead(msgID string) {
	if !h.cfg.sendReadReceipt {
		h.out.warning(warnCommandRejected, cmdMarkRead, msgID, "read receipts are disabled (SEND_READ_RECEIPT=false)")
		return
	}
	if h.cfg.mode == modeSelf {
		h.out.warning(warnCommandRejected, cmdMarkRead, msgID, "self mode: own statuses get no read receipt")
		return
	}
	meta, err := readMeta(h.inboxDir, msgID)
	if errors.Is(err, fs.ErrNotExist) {
		h.out.warning(warnCommandRejected, cmdMarkRead, msgID, "no such status in the inbox")
		return
	} else if err != nil {
		h.out.warning(warnCommandFailed, cmdMarkRead, msgID, err.Error())
		return
	}
	sender, err := types.ParseJID(meta.Sender.JID)
	if err != nil || meta.Sender.JID == "" {
		h.out.warning(warnCommandRejected, cmdMarkRead, msgID, "meta.json has no sender.jid")
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, commandTimeout)
	defer cancel()
	if err := h.cli.MarkRead(ctx, []types.MessageID{msgID}, h.now(), types.StatusBroadcastJID, sender); err != nil {
		h.out.warning(warnCommandFailed, cmdMarkRead, msgID, err.Error())
		return
	}
	h.log.Info().Str("id", msgID).Msg("status read receipt sent")
}

// periodicStats emits the stats event every interval until shutdown.
func (h *helper) periodicStats(interval time.Duration) {
	if interval <= 0 {
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			h.emitStats()
		case <-h.ctx.Done():
			return
		}
	}
}

// waitGuard waits (emitting why) until a temporary ban has ended and the stream_replaced
// cooldown has passed. Returns false when the helper is shut down meanwhile.
func (h *helper) waitGuard() bool {
	g, err := loadGuard(h.guardPath)
	if err != nil {
		h.log.Warn().Err(err).Msg("unreadable guard.json, ignoring it")
		return true
	}
	w := g.pendingWait(h.now())
	if w.remaining <= 0 {
		return true
	}
	if w.banned {
		h.out.state("banned", stateInfo{reason: "temporary_ban", code: w.banCode, until: w.until,
			detail: "waiting for the temporary ban to end before connecting"})
	} else {
		h.out.state("closed", stateInfo{detail: fmt.Sprintf(
			"stream_replaced cooldown: not connecting before %s", isoUTC(w.until))})
	}
	h.log.Warn().Time("until", w.until).Bool("banned", w.banned).Msg("waiting before connecting")
	t := time.NewTimer(w.remaining)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-h.ctx.Done():
		return false
	}
}
