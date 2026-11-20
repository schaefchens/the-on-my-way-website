package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// fakeLIDs is an in-memory LID map (whatsmeow's CachedLIDMap returns an empty JID and a nil
// error for unknown mappings, and so does this fake).
type fakeLIDs struct {
	mu      sync.Mutex
	pnByLID map[string]string
	lidByPN map[string]string
	pnErr   error // returned by GetPNForLID (a failing LID map)
}

func (f *fakeLIDs) GetPNForLID(_ context.Context, lid types.JID) (types.JID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.pnErr != nil {
		return types.EmptyJID, f.pnErr
	}
	if pn, ok := f.pnByLID[lid.User]; ok {
		return types.NewJID(pn, types.DefaultUserServer), nil
	}
	return types.EmptyJID, nil
}

func (f *fakeLIDs) GetLIDForPN(_ context.Context, pn types.JID) (types.JID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if lid, ok := f.lidByPN[pn.User]; ok {
		return types.NewJID(lid, types.HiddenUserServer), nil
	}
	return types.EmptyJID, nil
}

type learned struct{ pn, lid string }

func newTestIdentity(self bool, pn, lid string) (*identity, *fakeLIDs, *[]learned) {
	lids := &fakeLIDs{pnByLID: map[string]string{}, lidByPN: map[string]string{}}
	id := newIdentity(self, pn, lid, lids)
	var got []learned
	id.onChange = func(pn, lid string) { got = append(got, learned{pn, lid}) }
	return id, lids, &got
}

func msgFrom(sender, alt types.JID) types.MessageInfo {
	return types.MessageInfo{MessageSource: types.MessageSource{Chat: types.StatusBroadcastJID, Sender: sender, SenderAlt: alt, IsGroup: true}}
}

var (
	pnJID      = types.NewJID(travelerPN, types.DefaultUserServer)
	lidJID     = types.NewJID(travelerLID, types.HiddenUserServer)
	lidDevice  = types.JID{User: travelerLID, Device: 12, Server: types.HiddenUserServer}
	otherPN    = types.NewJID("4915199999999", types.DefaultUserServer)
	otherLID   = types.NewJID("999999999999999", types.HiddenUserServer)
	ctxTimeout = context.Background()
)

func TestMatchByPhoneLearnsTheLIDFromTheStanza(t *testing.T) {
	id, _, got := newTestIdentity(false, travelerPN, "")
	if r := id.match(ctxTimeout, msgFrom(lidDevice, pnJID)); r != matchYes {
		t.Fatalf("match = %v", r)
	}
	if _, lid := id.current(); lid != travelerLID || len(*got) != 1 || (*got)[0] != (learned{travelerPN, travelerLID}) {
		t.Fatalf("learned %v", *got)
	}
	// Later LID-only stanzas match through the learned LID; nothing is reported twice.
	if r := id.match(ctxTimeout, msgFrom(lidJID, types.EmptyJID)); r != matchYes || len(*got) != 1 {
		t.Fatalf("lid-only match = %v, learned %v", r, *got)
	}
}

func TestMatchByConfiguredLID(t *testing.T) {
	id, _, got := newTestIdentity(false, travelerPN, travelerLID)
	if r := id.match(ctxTimeout, msgFrom(lidDevice, types.EmptyJID)); r != matchYes || len(*got) != 0 {
		t.Fatalf("match = %v, learned %v", r, *got)
	}
}

func TestMatchByLIDMap(t *testing.T) {
	id, lids, got := newTestIdentity(false, travelerPN, "")
	lids.pnByLID[travelerLID] = travelerPN
	if r := id.match(ctxTimeout, msgFrom(lidJID, types.EmptyJID)); r != matchYes {
		t.Fatalf("match = %v", r)
	}
	if len(*got) != 1 || (*got)[0].lid != travelerLID {
		t.Fatalf("learned %v", *got)
	}
	// A LID that maps to someone else is another sender.
	lids.pnByLID["999999999999999"] = "4915199999999"
	if r := id.match(ctxTimeout, msgFrom(otherLID, types.EmptyJID)); r != matchNo {
		t.Fatalf("other lid = %v", r)
	}
}

func TestUnknownLIDTriggersOneRateLimitedLookup(t *testing.T) {
	id, _, got := newTestIdentity(false, travelerPN, "")
	clock := &fakeClock{t: goldenNow}
	id.now = clock.now
	lookups := 0
	id.activeLookup = func(context.Context, types.JID) (string, error) {
		lookups++
		return "", nil // WhatsApp did not tell us
	}
	if r := id.match(ctxTimeout, msgFrom(otherLID, types.EmptyJID)); r != matchUnknownLID || lookups != 1 {
		t.Fatalf("match = %v lookups %d", r, lookups)
	}
	if r := id.match(ctxTimeout, msgFrom(otherLID, types.EmptyJID)); r != matchUnknownLID || lookups != 1 {
		t.Fatalf("rate limit: match = %v lookups %d", r, lookups)
	}
	clock.advance(lidLookupInterval + time.Second)
	id.activeLookup = func(context.Context, types.JID) (string, error) {
		lookups++
		return travelerLID, nil
	}
	if r := id.match(ctxTimeout, msgFrom(lidJID, types.EmptyJID)); r != matchYes || lookups != 2 || len(*got) != 1 {
		t.Fatalf("after lookup: match = %v lookups %d learned %v", r, lookups, *got)
	}
}

func TestEnsureLIDPrefersTheLIDMap(t *testing.T) {
	id, lids, got := newTestIdentity(false, travelerPN, "")
	lids.lidByPN[travelerPN] = travelerLID
	id.activeLookup = func(context.Context, types.JID) (string, error) {
		t.Fatal("no network lookup when the LID map knows the traveler")
		return "", nil
	}
	id.ensureLID(ctxTimeout)
	if len(*got) != 1 || (*got)[0].lid != travelerLID {
		t.Fatalf("learned %v", *got)
	}
	id.ensureLID(ctxTimeout) // known: no-op
	if len(*got) != 1 {
		t.Fatal("reported twice")
	}
}

func TestOtherSendersAndOwnStatuses(t *testing.T) {
	id, _, _ := newTestIdentity(false, travelerPN, travelerLID)
	if r := id.match(ctxTimeout, msgFrom(otherPN, types.EmptyJID)); r != matchNo {
		t.Fatalf("other pn = %v", r)
	}
	own := msgFrom(pnJID, types.EmptyJID)
	own.IsFromMe = true
	if r := id.match(ctxTimeout, own); r != matchOwnIgnored {
		t.Fatalf("own status in observer mode = %v", r)
	}
	unconfigured, _, _ := newTestIdentity(false, "", "")
	if r := unconfigured.match(ctxTimeout, msgFrom(pnJID, types.EmptyJID)); r != matchNo {
		t.Fatal("without a traveler nothing matches")
	}
}

func TestSelfModeIdentity(t *testing.T) {
	id, _, got := newTestIdentity(true, "", "")
	own := msgFrom(pnJID, types.EmptyJID)
	own.IsFromMe = true
	if id.match(ctxTimeout, own) != matchYes || id.match(ctxTimeout, msgFrom(pnJID, types.EmptyJID)) != matchNo {
		t.Fatal("self mode matches exactly the own statuses")
	}
	id.setSelf(travelerPN, travelerLID)
	id.setSelf(travelerPN, travelerLID)
	id.setSelf("not-a-number", "")
	if len(*got) != 1 || (*got)[0] != (learned{travelerPN, travelerLID}) {
		t.Fatalf("learned %v", *got)
	}
}

// Regression: a failing LID map used to fall through to matchNo, so a LID-only traveler status
// was counted as another sender and acked without being stored.
func TestLIDMapErrorIsUndecidable(t *testing.T) {
	id, lids, _ := newTestIdentity(false, travelerPN, "")
	lids.pnErr = errors.New("database is locked")
	if r := id.match(ctxTimeout, msgFrom(lidJID, types.EmptyJID)); r != matchError {
		t.Fatalf("lid-only stanza with a failing LID map = %v; want matchError", r)
	}
	// The phone-number identity decides on its own, whatever the LID map says.
	if r := id.match(ctxTimeout, msgFrom(lidJID, pnJID)); r != matchYes {
		t.Fatalf("lid + traveler pn = %v", r)
	}
	if r := id.match(ctxTimeout, msgFrom(otherLID, otherPN)); r != matchNo {
		t.Fatalf("lid + other pn = %v", r)
	}
}
