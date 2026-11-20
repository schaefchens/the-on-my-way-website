package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

type helperFixture struct {
	*mediaFixture
	h    *helper
	lids *fakeLIDs
	own  types.JID
}

func newHelperFixture(t *testing.T, mode string) *helperFixture {
	t.Helper()
	mf := newMediaFixture(t, 1)
	container, err := openSessionStore(context.Background(), filepath.Join(t.TempDir(), "wa", "session.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { container.Close() })
	dev, err := container.GetFirstDevice(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	mf.api.parser = whatsmeow.NewClient(dev, nil) // ParseWebMessage only; never connected

	cfg := config{mode: mode, travelerPhone: travelerPN, mediaWorkers: 1}
	pn := travelerPN
	if mode == modeSelf {
		pn = ""
	}
	lids := &fakeLIDs{pnByLID: map[string]string{}, lidByPN: map[string]string{}}
	id := newIdentity(mode == modeSelf, pn, "", lids)
	em := mf.m.out
	id.onChange = func(pn, lid string) {
		f := map[string]any{"pn": pn}
		if lid != "" {
			f["lid"] = lid
		}
		em.emit("traveler", f)
	}
	hf := &helperFixture{mediaFixture: mf, lids: lids}
	hf.h = &helper{
		ctx: mf.ctx, stop: mf.stop, cfg: cfg, cli: mf.api, out: em, log: zerolog.Nop(), inboxDir: mf.inbox,
		guardPath: filepath.Join(t.TempDir(), "wa", guardFile), id: id, media: mf.m, stats: mf.stats, now: mf.clock.now,
		own: func() (types.JID, types.JID) {
			if hf.own.IsEmpty() {
				return types.EmptyJID, types.EmptyJID
			}
			return hf.own, types.NewJID("200000000000002", types.HiddenUserServer)
		},
	}
	return hf
}

func statusEvent(id string, msg *waE2E.Message) *events.Message {
	return &events.Message{Info: statusInfo(id, false), Message: msg, RawMessage: msg}
}

func TestLiveStatusIsPersistedBeforeTheAck(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	msg := mediaStatus(kindPhoto, "3EB0LIVE")
	if !f.h.handleEvent(statusEvent("3EB0LIVE", msg)) {
		t.Fatal("handler must report success after persisting")
	}
	// By the time the handler returned (and whatsmeow may ack), meta.json is on disk.
	m := f.meta("3EB0LIVE")
	if m.Source != sourceLive || m.Kind != kindPhoto || m.Download.State != dlPending || m.Sender.JID != travelerLID+"@lid" {
		t.Fatalf("meta = %+v", m)
	}
	if ev := f.out.ofType(t, "status"); len(ev) != 1 || ev[0]["msgId"] != "3EB0LIVE" || ev[0]["source"] != "live" {
		t.Fatalf("status events = %v", ev)
	}
	// The stanza carried both identities: the LID is learned and reported once.
	if ev := f.out.ofType(t, "traveler"); len(ev) != 1 || ev[0]["lid"] != travelerLID || ev[0]["pn"] != travelerPN {
		t.Fatalf("traveler events = %v", ev)
	}
	if f.stats.captured.Load() != 1 || f.stats.statusStanzas.Load() != 1 {
		t.Fatalf("counters = %v", f.stats.counters(0))
	}
	if f.m.active() != 1 {
		t.Fatal("the media download must be queued (it waits for the connection)")
	}
	// Redelivery (no ack reached WhatsApp): same file, status event again, not counted twice.
	if !f.h.handleEvent(statusEvent("3EB0LIVE", msg)) {
		t.Fatal("redelivery must succeed")
	}
	if f.stats.captured.Load() != 1 || len(f.out.ofType(t, "status")) != 2 || len(f.out.ofType(t, "traveler")) != 1 {
		t.Fatal("redelivery handled wrongly")
	}
}

func TestPersistFailureWithholdsTheAck(t *testing.T) {
	historyPersistRetryDelay = time.Millisecond
	f := newHelperFixture(t, modeObserver)
	// The inbox path is a file: nothing can be written below it.
	if err := os.MkdirAll(filepath.Dir(f.inbox), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.inbox, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	text := &waE2E.Message{Conversation: proto.String("hello")}
	if f.h.handleEvent(statusEvent("3EB0FAIL", text)) {
		t.Fatal("a live status that could not be persisted must not be acked")
	}
	if f.h.handleMessage(statusEvent("3EB0FAILH", text), sourceHistory) != true || f.stats.persistFailed.Load() != 1 {
		t.Fatal("history statuses cannot be redelivered: counted, handler continues")
	}
	revoke := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("3EB0GONE")}}}
	if f.h.handleEvent(statusEvent("3EB0REV", revoke)) {
		t.Fatal("an unpersisted revoke must not be acked")
	}
	if len(f.out.ofType(t, "status")) != 0 || len(f.out.ofType(t, "revoke")) != 0 {
		t.Fatal("no event without a persisted file")
	}
}

// Regression: with a failing LID map a LID-only traveler status was acked without being stored.
func TestUndecidableSenderWithholdsTheAck(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.lids.pnErr = errors.New("database is locked")
	evt := &events.Message{Info: statusInfo("3EB0LIDERR", true), Message: &waE2E.Message{Conversation: proto.String("hi")}}
	evt.RawMessage = evt.Message
	if f.h.handleEvent(evt) {
		t.Fatal("a status that may be the traveler's must not be acked unstored")
	}
	if _, err := os.Stat(metaPath(f.inbox, "3EB0LIDERR")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nothing is stored for an undecided sender: %v", err)
	}
	if f.stats.otherSenders.Load() != 0 {
		t.Fatal("not counted as another sender")
	}
	f.lids.pnErr = nil // the next delivery decides
	f.lids.pnByLID[travelerLID] = travelerPN
	if !f.h.handleEvent(evt) || f.meta("3EB0LIDERR").Kind != kindText {
		t.Fatal("redelivery after the LID map recovered must be captured")
	}
}

// Regression: status_stanzas counted every <enc> part (the skdm-only pkmsg part and the content
// part of one stanza), i.e. twice per status.
func TestStatusStanzasAreCountedOncePerStatus(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	skdm := &events.Message{Info: statusInfo("3EB0STANZA", false), Message: &waE2E.Message{
		SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{GroupID: proto.String("status@broadcast")},
	}}
	if !f.h.handleEvent(skdm) || !f.h.handleEvent(statusEvent("3EB0STANZA", &waE2E.Message{Conversation: proto.String("x")})) {
		t.Fatal("both parts are handled")
	}
	if n := f.stats.statusStanzas.Load(); n != 1 {
		t.Fatalf("status_stanzas = %d; want 1", n)
	}
}

// Regression: startPairing ran only after the guard wait, so a pair_code sent right after
// `ready` (or during a guard wait) was rejected as "no linking in progress". run() now starts
// the linking state before reading stdin; a pair_code then waits for the first QR code.
func TestPairCodeBeforeTheFirstQRCodeWaits(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.api.pairCode = "WXYZ-1234"
	f.h.startPairing()
	done := make(chan struct{})
	go func() { f.h.requestPairCode("4915100000002"); close(done) }()
	time.Sleep(20 * time.Millisecond) // the command arrives before any QR code
	if w := f.out.ofType(t, "warning"); len(w) != 0 {
		t.Fatalf("pair_code before the first QR code was rejected: %v", w)
	}
	ch := make(chan whatsmeow.QRChannelItem, 1)
	ch <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@first", Timeout: time.Minute}
	go f.h.forwardQR(ch)
	<-done
	if pc := f.out.ofType(t, "pair_code"); len(pc) != 1 || pc[0]["code"] != "WXYZ-1234" {
		t.Fatalf("pair_code events = %v", pc)
	}
	close(ch)
}

func TestPanicWithholdsTheAck(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.id = nil // match() panics
	if f.h.handleEvent(statusEvent("3EB0PANIC", &waE2E.Message{Conversation: proto.String("x")})) {
		t.Fatal("a panic must turn into false (whatsmeow's own recovery would ack)")
	}
	if f.stats.handlerPanics.Load() != 1 {
		t.Fatal("panic not counted")
	}
}

func TestOnlyTheTravelersStatusesAreStored(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	text := &waE2E.Message{Conversation: proto.String("hi")}

	other := statusEvent("3EB0OTHER", text)
	other.Info.Sender = types.NewJID("4915199999999", types.DefaultUserServer)
	other.Info.SenderAlt = types.EmptyJID
	unknownLID := statusEvent("3EB0ULID", text)
	unknownLID.Info.Sender = types.NewJID("999999999999999", types.HiddenUserServer)
	unknownLID.Info.SenderAlt = types.EmptyJID
	own := statusEvent("3EB0OWN", text)
	own.Info.IsFromMe = true
	notStatus := statusEvent("3EB0DM", text)
	notStatus.Info.Chat = types.NewJID(travelerPN, types.DefaultUserServer)
	skdmOnly := statusEvent("3EB0SKDM", &waE2E.Message{
		SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{GroupID: proto.String("status@broadcast")},
		MessageContextInfo:           &waE2E.MessageContextInfo{},
	})
	badID := statusEvent("_bad", text)

	for _, e := range []*events.Message{other, unknownLID, own, notStatus, skdmOnly, badID} {
		if !f.h.handleEvent(e) {
			t.Fatalf("%s: ignored statuses are still acked", e.Info.ID)
		}
	}
	for _, id := range []string{"3EB0OTHER", "3EB0ULID", "3EB0OWN", "3EB0DM", "3EB0SKDM"} {
		if _, err := os.Stat(filepath.Join(f.inbox, id)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s must not be stored", id)
		}
	}
	c := f.stats.counters(0)
	if c["other_senders"] != 2 || c["unmatched_lid"] != 1 || c["captured"] != 0 || c["invalid_id"] != 1 {
		t.Fatalf("counters = %v", c)
	}
}

func TestRevokeIsKeyedByTheRevokedStatus(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	revoke := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("3EB0TARGET"), RemoteJID: proto.String("status@broadcast")}}}
	if !f.h.handleEvent(statusEvent("3EB0REVOKEMSG", revoke)) {
		t.Fatal("revoke not acked")
	}
	data, err := os.ReadFile(filepath.Join(f.inbox, inboxRevokesDir, "3EB0TARGET.json"))
	if err != nil || !strings.Contains(string(data), `"msgId": "3EB0TARGET"`) {
		t.Fatalf("revoke record = %s, %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(f.inbox, "3EB0REVOKEMSG")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the revoke message itself is not a status")
	}
	if ev := f.out.ofType(t, "revoke"); len(ev) != 1 || ev[0]["msgId"] != "3EB0TARGET" || ev[0]["at"] != "2026-11-15T02:12:00.000Z" {
		t.Fatalf("revoke events = %v", ev)
	}
	edit := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum()}}
	bad := &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{
		Type: waE2E.ProtocolMessage_REVOKE.Enum(), Key: &waCommon.MessageKey{ID: proto.String("../x")}}}
	f.h.handleEvent(statusEvent("3EB0EDIT", edit))
	f.h.handleEvent(statusEvent("3EB0BADREV", bad))
	if len(f.out.ofType(t, "revoke")) != 1 || f.stats.invalidID.Load() != 1 || f.stats.revokes.Load() != 1 {
		t.Fatal("edits are ignored, invalid revoke targets counted")
	}
}

func TestHistorySyncStatusesArePersisted(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.id.setLID(travelerLID) // configured / learned earlier
	web := func(id, participant string, msg *waE2E.Message) *waWeb.WebMessageInfo {
		return &waWeb.WebMessageInfo{
			Key:              &waCommon.MessageKey{RemoteJID: proto.String("status@broadcast"), FromMe: proto.Bool(false), ID: proto.String(id), Participant: proto.String(participant)},
			MessageTimestamp: proto.Uint64(uint64(goldenNow.Add(-3 * time.Hour).Unix())),
			Message:          msg,
		}
	}
	sync := &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_INITIAL_STATUS_V3.Enum(),
		StatusV3Messages: []*waWeb.WebMessageInfo{
			web("3EB0H1", travelerPN+"@s.whatsapp.net", mediaStatus(kindVideo, "3EB0H1")),
			web("3EB0H2", travelerLID+"@lid", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("old")}}),
			web("3EB0H3", "4915199999999@s.whatsapp.net", &waE2E.Message{Conversation: proto.String("not ours")}),
		},
	}}
	f.h.handleEvent(sync)
	h1 := f.meta("3EB0H1")
	if h1.Source != sourceHistory || h1.Kind != kindVideo || h1.Sender.JID != travelerPN+"@s.whatsapp.net" || h1.StanzaTag != "" || h1.AddressingMode != "" {
		t.Fatalf("h1 = %+v", h1)
	}
	if h1.Timestamp != goldenNow.Add(-3*time.Hour).UTC().Format(time.RFC3339) || h1.RawProtoB64 == "" {
		t.Fatalf("h1 = %+v", h1)
	}
	if h2 := f.meta("3EB0H2"); h2.Kind != kindText || h2.Sender.PN != travelerPN {
		t.Fatalf("h2 = %+v", h2)
	}
	if _, err := os.Stat(filepath.Join(f.inbox, "3EB0H3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("other senders' history statuses are not stored")
	}
	ev := f.out.ofType(t, "status")
	if len(ev) != 2 || ev[0]["source"] != "history" {
		t.Fatalf("status events = %v", ev)
	}
	c := f.stats.counters(0)
	if c["history_statuses"] != 3 || c["captured"] != 2 || c["other_senders"] != 1 || c["status_stanzas"] != 0 {
		t.Fatalf("counters = %v", c)
	}
	// A duplicate history sync keeps the files (meta.json is created once).
	f.h.handleEvent(sync)
	if f.stats.captured.Load() != 2 {
		t.Fatal("history duplicates must not count as new captures")
	}
}

func TestSelfModeCapturesOwnStatuses(t *testing.T) {
	f := newHelperFixture(t, modeSelf)
	f.own = types.NewJID(travelerPN, types.DefaultUserServer)
	f.h.onConnected()
	if ev := f.out.ofType(t, "traveler"); len(ev) != 1 || ev[0]["pn"] != travelerPN || ev[0]["lid"] != "200000000000002" {
		t.Fatalf("traveler events = %v", ev)
	}
	mine := statusEvent("3EB0MINE", &waE2E.Message{Conversation: proto.String("mine")})
	mine.Info.IsFromMe = true
	mine.Info.Sender = types.NewJID(travelerPN, types.DefaultUserServer)
	theirs := statusEvent("3EB0THEIRS", &waE2E.Message{Conversation: proto.String("theirs")})
	f.h.handleEvent(mine)
	f.h.handleEvent(theirs)
	if m := f.meta("3EB0MINE"); m.Sender.PN != travelerPN || m.Sender.JID != travelerPN+"@s.whatsapp.net" {
		t.Fatalf("meta = %+v", m)
	}
	if _, err := os.Stat(filepath.Join(f.inbox, "3EB0THEIRS")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("self mode keeps only the linked account's statuses")
	}
}

func TestConnectionEventMapping(t *testing.T) {
	cases := []struct {
		name   string
		evt    any
		state  string
		reason string
		exit   int // -1: keeps running
	}{
		{"connected", &events.Connected{}, "open", "", -1},
		{"disconnected", &events.Disconnected{}, "closed", "disconnected", -1},
		{"keepalive", &events.KeepAliveTimeout{ErrorCount: 2}, "closed", "keepalive_timeout", -1},
		{"keepalive restored", &events.KeepAliveRestored{}, "open", "keepalive_restored", -1},
		{"pair success", &events.PairSuccess{ID: types.NewADJID(travelerPN, 0, 5)}, "pairing", "pair_success", -1},
		{"logged out", &events.LoggedOut{Reason: events.ConnectFailureLoggedOut}, "logged_out", "", exitLoggedOut},
		{"stream replaced", &events.StreamReplaced{}, "stream_replaced", "", exitStreamReplaced},
		{"temporary ban", &events.TemporaryBan{Code: events.TempBanSentToTooManyPeople, Expire: time.Hour}, "banned", "temporary_ban", exitTemporaryBan},
		{"connect failure", &events.ConnectFailure{Reason: 499, Message: "x"}, "error", "connect_failure", exitConnectFailure},
		{"client outdated", &events.ClientOutdated{}, "error", "client_outdated", exitClientOutdated},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newHelperFixture(t, modeObserver)
			f.own = types.NewJID("4915100000002", types.DefaultUserServer)
			if !f.h.handleEvent(tc.evt) {
				t.Fatal("connection events always return true")
			}
			ev := f.out.ofType(t, "state")
			if len(ev) != 1 || ev[0]["state"] != tc.state || (tc.reason != "" && ev[0]["reason"] != tc.reason) {
				t.Fatalf("state events = %v", ev)
			}
			exited := f.ctx.Err() != nil
			if (tc.exit >= 0) != exited || (exited && f.h.exitCode != tc.exit) {
				t.Fatalf("exit: cancelled=%v code=%d; want %d", exited, f.h.exitCode, tc.exit)
			}
			switch tc.name {
			case "connected":
				if ev[0]["jid"] != "4915100000002@s.whatsapp.net" || !f.m.online {
					t.Fatalf("connected: %v online=%v", ev[0], f.m.online)
				}
			case "temporary ban":
				if ev[0]["until"] != isoUTC(goldenNow.Add(time.Hour)) || ev[0]["code"] != float64(events.TempBanSentToTooManyPeople) {
					t.Fatalf("ban event = %v", ev[0])
				}
				if g, _ := loadGuard(f.h.guardPath); g.BannedUntil != isoUTC(goldenNow.Add(time.Hour)) {
					t.Fatalf("guard = %+v", g)
				}
			case "stream replaced":
				if g, _ := loadGuard(f.h.guardPath); g.StreamReplacedAt != isoUTC(goldenNow) {
					t.Fatalf("guard = %+v", g)
				}
			}
		})
	}
}

func TestFirstExitCodeWins(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.handleEvent(&events.LoggedOut{Reason: events.ConnectFailureLoggedOut})
	f.h.exit(exitOK) // e.g. stdin EOF while shutting down
	if f.h.exitCode != exitLoggedOut {
		t.Fatalf("exit code = %d", f.h.exitCode)
	}
}

func TestGuardMakesTheNextStartWait(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	if !f.h.waitGuard() {
		t.Fatal("no guard file: connect right away")
	}
	if err := updateGuard(f.h.guardPath, func(g *guardState) { g.BannedUntil = isoUTC(goldenNow.Add(time.Hour)) }); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool)
	go func() { done <- f.h.waitGuard() }()
	waitFor(t, "banned state", func() bool { return len(f.out.ofType(t, "state")) == 1 })
	if ev := f.out.ofType(t, "state")[0]; ev["state"] != "banned" || ev["until"] != isoUTC(goldenNow.Add(time.Hour)) {
		t.Fatalf("state = %v", ev)
	}
	f.stop() // shutdown while waiting
	if <-done {
		t.Fatal("waitGuard must report the shutdown")
	}
}

func TestCommandsNeverCrash(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.persistStatus(kindPhoto, "3EB0CMD", sourceLive)
	input := strings.Join([]string{
		`{"type":"stats"}`,
		`not json`,
		`{"type":"nope"}`,
		`{"type":"redownload"}`,
		`{"type":"redownload","msgId":"3EB0CMD"}`,
		`{"type":"mark_read","msgId":"3EB0CMD"}`,
		`{"type":"pair_code","phone":"+49151"}`,
		`{"type":"pair_code","phone":"4915100000002"}`,
		`{"type":"logout"}`,
		`{"type":"x","pad":"` + strings.Repeat("a", maxCommandLine) + `"}`,
		``,
		`{"type":"stats"}`,
	}, "\n")
	f.h.readCommands(strings.NewReader(input)) // returns at EOF
	if f.ctx.Err() == nil || f.h.exitCode != exitOK {
		t.Fatal("stdin EOF must shut the helper down with exit 0")
	}
	waitFor(t, "async command warnings", func() bool { return len(f.out.ofType(t, "warning")) == 9 })
	byCode := map[string]int{}
	for _, w := range f.out.ofType(t, "warning") {
		byCode[w["code"].(string)]++
	}
	if byCode[warnInvalidCommand] != 5 || byCode[warnCommandRejected] != 4 {
		t.Fatalf("warnings = %v", f.out.ofType(t, "warning"))
	}
	if len(f.out.ofType(t, "stats")) != 2 || f.stats.invalidCommands.Load() != 5 {
		t.Fatal("stats commands answered, invalid ones counted")
	}
	if f.api.logouts != 0 || len(f.api.pairPhones) != 0 || len(f.api.markRead) != 0 {
		t.Fatal("rejected commands must not reach WhatsApp")
	}
}

func TestShutdownCommand(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.readCommands(strings.NewReader(`{"type":"shutdown"}` + "\n" + `{"type":"logout"}` + "\n"))
	if f.ctx.Err() == nil || f.h.exitCode != exitOK {
		t.Fatal("shutdown must exit 0")
	}
}

func TestMarkReadSendsAStatusReadReceipt(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.cfg.sendReadReceipt = true
	f.persistStatus(kindPhoto, "3EB0READ", sourceLive)
	f.h.markRead("3EB0READ")
	if len(f.api.markRead) != 1 {
		t.Fatal("no receipt sent")
	}
	c := f.api.markRead[0]
	if c.chat != types.StatusBroadcastJID || c.sender.String() != travelerLID+"@lid" || len(c.ids) != 1 || c.ids[0] != "3EB0READ" {
		t.Fatalf("mark read = %+v", c)
	}
	f.api.markErr = whatsmeow.ErrNotConnected
	f.h.markRead("3EB0READ")
	f.h.markRead("3EB0NOPE")
	w := f.out.ofType(t, "warning")
	if len(w) != 2 || w[0]["code"] != warnCommandFailed || w[1]["code"] != warnCommandRejected || w[0]["msgId"] != "3EB0READ" {
		t.Fatalf("warnings = %v", w)
	}
	f.h.cfg.mode = modeSelf
	f.h.markRead("3EB0READ")
	if len(f.api.markRead) != 2 {
		t.Fatal("self mode never sends read receipts")
	}
}

func TestLogoutCommand(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.own = types.NewJID("4915100000002", types.DefaultUserServer)
	f.api.logoutErr = errors.New("server said no")
	f.h.logout()
	if w := f.out.ofType(t, "warning"); len(w) != 1 || w[0]["code"] != warnCommandFailed || f.ctx.Err() != nil {
		t.Fatalf("failed logout: %v", w)
	}
	f.api.logoutErr = nil
	f.h.logout()
	if s := f.out.ofType(t, "state"); len(s) != 1 || s[0]["state"] != "logged_out" || f.h.exitCode != exitLoggedOut {
		t.Fatalf("logout: %v exit %d", s, f.h.exitCode)
	}
}

func TestQRAndPairingCode(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.requestPairCode("4915100000002")
	if w := f.out.ofType(t, "warning"); len(w) != 1 || w[0]["code"] != warnCommandRejected {
		t.Fatalf("pair_code without linking in progress: %v", w)
	}
	f.h.cfg.pairPhone = "4915100000002"
	f.api.pairCode = "ABCD-EFGH"
	f.h.startPairing()
	ch := make(chan whatsmeow.QRChannelItem, 4)
	ch <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@first", Timeout: 60 * time.Second}
	ch <- whatsmeow.QRChannelItem{Event: whatsmeow.QRChannelEventCode, Code: "2@second", Timeout: 20 * time.Second}
	go f.h.forwardQR(ch)
	waitFor(t, "pair code", func() bool { return len(f.out.ofType(t, "pair_code")) == 1 })
	qr := f.out.ofType(t, "qr")
	if len(qr) != 2 || qr[0]["code"] != "2@first" || qr[0]["expiresAt"] != isoUTC(goldenNow.Add(60*time.Second)) {
		t.Fatalf("qr events = %v", qr)
	}
	if f.out.ofType(t, "pair_code")[0]["code"] != "ABCD-EFGH" || len(f.api.pairPhones) != 1 {
		t.Fatal("exactly one pairing code requested")
	}
	ch <- whatsmeow.QRChannelTimeout
	close(ch)
	waitFor(t, "exit", func() bool { return f.ctx.Err() != nil })
	if f.h.exitCode != exitPairingEnded {
		t.Fatalf("exit = %d", f.h.exitCode)
	}
	states := f.out.ofType(t, "state")
	if last := states[len(states)-1]; last["state"] != "closed" || last["reason"] != "pair_timeout" {
		t.Fatalf("last state = %v", last)
	}
}
