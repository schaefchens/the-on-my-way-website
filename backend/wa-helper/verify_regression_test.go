package main

// Regression tests from the independent verification of the helper (B1). Each test names the
// failure it guards against.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// A LID-only traveler status that arrived while the post-Connected LID lookup was still running
// was rate-limited away (lastLookup was already set), counted as unmatched_lid and acked
// without being stored. Concurrent callers now wait for the running lookup.
func TestMatchWaitsForAnInFlightLIDLookup(t *testing.T) {
	id, _, got := newTestIdentity(false, travelerPN, "")
	started, release := make(chan struct{}), make(chan struct{})
	lookups := 0
	id.activeLookup = func(ctx context.Context, _ types.JID) (string, error) {
		lookups++
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		return travelerLID, nil
	}
	go id.ensureLID(context.Background()) // what onConnected does
	<-started

	result := make(chan matchResult, 1)
	go func() { result <- id.match(context.Background(), msgFrom(lidJID, types.EmptyJID)) }()
	select {
	case r := <-result:
		t.Fatalf("match returned %v while the lookup was still running", r)
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case r := <-result:
		if r != matchYes {
			t.Fatalf("match = %v; want matchYes once the lookup found the traveler's LID", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("match never returned")
	}
	if lookups != 1 || len(*got) != 1 || (*got)[0] != (learned{travelerPN, travelerLID}) {
		t.Fatalf("lookups %d, learned %v", lookups, *got)
	}
}

func TestLearnFromMapping(t *testing.T) {
	id, _, got := newTestIdentity(false, travelerPN, "")
	id.learnFromMapping(otherPN, otherLID)                                                // someone else
	id.learnFromMapping(lidJID, pnJID)                                                    // swapped servers
	id.learnFromMapping(types.NewJID(travelerPN, types.LegacyUserServer), types.EmptyJID) // no LID
	if len(*got) != 0 {
		t.Fatalf("learned %v from foreign or malformed pairs", *got)
	}
	id.learnFromMapping(types.NewJID(travelerPN, types.LegacyUserServer), lidJID) // "@c.us" spelling
	if _, lid := id.current(); lid != travelerLID || len(*got) != 1 {
		t.Fatalf("lid %q, learned %v", lid, *got)
	}
	self, _, selfGot := newTestIdentity(true, travelerPN, "")
	self.learnFromMapping(pnJID, lidJID)
	if len(*selfGot) != 0 {
		t.Fatal("self mode takes its identity from the linked device only")
	}
}

// whatsmeow stores a history blob's PhoneNumberToLidMappings in the background, possibly after
// the blob's statuses were dispatched. A traveler status named only by its LID was then
// counted as unmatched_lid and lost (history statuses are never redelivered).
func TestHistorySyncLearnsTheTravelerLIDFromTheBlob(t *testing.T) {
	f := newHelperFixture(t, modeObserver) // traveler LID unknown, LID map empty, no active lookup
	sync := &events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_INITIAL_STATUS_V3.Enum(),
		PhoneNumberToLidMappings: []*waHistorySync.PhoneNumberToLIDMapping{
			{PnJID: proto.String("4915199999999@s.whatsapp.net"), LidJID: proto.String("999999999999999@lid")},
			{PnJID: proto.String(travelerPN + "@s.whatsapp.net"), LidJID: proto.String(travelerLID + "@lid")},
		},
		StatusV3Messages: []*waWeb.WebMessageInfo{{
			Key: &waCommon.MessageKey{
				RemoteJID: proto.String("status@broadcast"), FromMe: proto.Bool(false),
				ID: proto.String("3EB0HLID"), Participant: proto.String(travelerLID + "@lid"),
			},
			MessageTimestamp: proto.Uint64(uint64(goldenNow.Add(-time.Hour).Unix())),
			Message:          &waE2E.Message{Conversation: proto.String("posted before the link")},
		}},
	}}
	f.h.handleEvent(sync)
	if m := f.meta("3EB0HLID"); m.Source != sourceHistory || m.Sender.PN != travelerPN || m.Sender.LID != travelerLID {
		t.Fatalf("meta = %+v", m)
	}
	if ev := f.out.ofType(t, "traveler"); len(ev) != 1 || ev[0]["lid"] != travelerLID {
		t.Fatalf("traveler events = %v", ev)
	}
	if c := f.stats.counters(0); c["unmatched_lid"] != 0 || c["captured"] != 1 {
		t.Fatalf("counters = %v", c)
	}
}

// A TemporaryBan without an expire attribute (Expire == 0) stored bannedUntil = now, so the
// next start connected again at once, while still banned.
func TestBanWithoutAnEndStillKeepsTheHelperAway(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.handleEvent(&events.TemporaryBan{Code: events.TempBanSentToTooManyPeople})
	until := isoUTC(goldenNow.Add(unknownBanWait))
	ev := f.out.ofType(t, "state")
	if len(ev) != 1 || ev[0]["state"] != "banned" || ev[0]["until"] != until || !strings.Contains(ev[0]["detail"].(string), "no ban end") {
		t.Fatalf("state events = %v", ev)
	}
	g, err := loadGuard(f.h.guardPath)
	if err != nil || g.BannedUntil != until {
		t.Fatalf("guard = %+v, %v", g, err)
	}
	if w := g.pendingWait(goldenNow.Add(time.Minute)); !w.banned || w.remaining != unknownBanWait-time.Minute {
		t.Fatalf("wait one minute later = %+v", w)
	}
	if f.h.exitCode != exitTemporaryBan {
		t.Fatalf("exit code = %d", f.h.exitCode)
	}
}

// A shutdown (SIGTERM, stdin EOF, shutdown command) during the dial made ConnectContext fail and
// the helper exit 1 with a bogus "state error (fatal)".
func TestShutdownDuringConnectIsClean(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	err := f.h.connect(func(ctx context.Context) error {
		f.h.exit(exitOK) // the shutdown command arrives while dialling
		<-ctx.Done()
		return ctx.Err()
	})
	if err != nil || f.h.exitCode != exitOK {
		t.Fatalf("err %v, exit code %d; want a clean exit 0", err, f.h.exitCode)
	}
	for _, e := range f.out.ofType(t, "state") {
		if e["state"] == "error" {
			t.Fatalf("no error state on a requested shutdown: %v", e)
		}
	}

	g := newHelperFixture(t, modeObserver)
	err = g.h.connect(func(context.Context) error { return errors.New("dial tcp: no route to host") })
	if err == nil || g.h.exitCode != exitFatal || g.ctx.Err() == nil {
		t.Fatalf("a real connect failure is fatal: err %v, exit %d", err, g.h.exitCode)
	}
}

// A panic in a helper goroutine ended the process with Go's exit status 2, which the
// supervisor reads as "invalid configuration" and never restarts.
func TestGoroutinePanicsDoNotExitWithTheConfigCode(t *testing.T) {
	f := newHelperFixture(t, modeObserver)
	f.h.goSafe("test", func() { panic("boom") })
	waitFor(t, "fatal exit", func() bool { return f.ctx.Err() != nil })
	if f.h.exitCode != exitFatal {
		t.Fatalf("exit code = %d; want %d", f.h.exitCode, exitFatal)
	}
	if ev := f.out.ofType(t, "state"); len(ev) != 1 || ev[0]["reason"] != "fatal" {
		t.Fatalf("state events = %v", ev)
	}

	// Commands: a panic becomes a command_failed warning and the helper keeps running.
	g := newHelperFixture(t, modeObserver)
	g.h.goCommand(cmdMarkRead, "3EB0X", func() { panic("boom") })
	waitFor(t, "warning", func() bool { return len(g.out.ofType(t, "warning")) == 1 })
	g.h.media = nil // makes the synchronous redownload path panic
	g.h.dispatch(command{Type: cmdRedownload, MsgID: "3EB0Y"})
	w := g.out.ofType(t, "warning")
	if len(w) != 2 || w[0]["code"] != warnCommandFailed || w[0]["msgId"] != "3EB0X" || w[1]["command"] != cmdRedownload {
		t.Fatalf("warnings = %v", w)
	}
	if g.ctx.Err() != nil {
		t.Fatal("a command must never end the helper")
	}
}
