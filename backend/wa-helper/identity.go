package main

// Traveler identity (wa.ts header "Traveler identity"). Observer mode: a status is the
// traveler's when Info.Sender or Info.SenderAlt (non-AD) is the configured phone number or the
// traveler's LID. The LID is configured (-traveler-lid, persisted by Node from earlier traveler
// events), learned from a stanza carrying both identities, resolved through whatsmeow's LID map,
// or looked up actively (usync) once after connecting. Self mode: the traveler is the linked
// account itself, so exactly our own (IsFromMe) statuses are the traveler's.

import (
	"context"
	"sync"
	"time"

	"go.mau.fi/whatsmeow/types"
)

// lidStore is the part of whatsmeow's store.LIDStore used here (container.LIDMap, usable even
// before pairing).
type lidStore interface {
	GetPNForLID(ctx context.Context, lid types.JID) (types.JID, error)
	GetLIDForPN(ctx context.Context, pn types.JID) (types.JID, error)
}

type identity struct {
	self           bool
	lids           lidStore
	activeLookup   func(ctx context.Context, pn types.JID) (string, error) // usync; nil disables
	onChange       func(pn, lid string)                                    // emits the traveler event
	now            func() time.Time
	lookupInterval time.Duration

	mu         sync.Mutex
	pn         string // E.164 digits; in self mode learned from the device after connecting
	lid        string
	lastLookup time.Time
	lookupDone chan struct{} // non-nil while an active lookup runs; closed when it has ended
}

// matchResult of one status sender.
type matchResult int

const (
	matchNo         matchResult = iota // another sender (or, in observer mode, our own status)
	matchYes                           // the traveler
	matchUnknownLID                    // a @lid sender that could not be resolved
	matchOwnIgnored                    // observer mode: the observer's own status (not counted)
	matchError                         // the LID map failed: undecidable (withhold the ack)
)

const (
	// lidLookupInterval rate-limits active LID lookups (one usync query each).
	lidLookupInterval = 5 * time.Minute
	// lidLookupTimeout bounds one active lookup (and so the wait of concurrent callers).
	lidLookupTimeout = 10 * time.Second
)

func newIdentity(self bool, pn, lid string, lids lidStore) *identity {
	return &identity{self: self, pn: pn, lid: lid, lids: lids, now: time.Now, lookupInterval: lidLookupInterval}
}

func (id *identity) current() (pn, lid string) {
	id.mu.Lock()
	defer id.mu.Unlock()
	return id.pn, id.lid
}

// match decides whether info's sender is the traveler.
func (id *identity) match(ctx context.Context, info types.MessageInfo) matchResult {
	if id.self {
		if info.IsFromMe {
			return matchYes
		}
		return matchNo
	}
	if info.IsFromMe {
		return matchOwnIgnored
	}
	pn, _ := id.current()
	if pn == "" {
		return matchNo
	}
	var unknownLID string
	lookupFailed, otherPN := false, false
	for _, jid := range []types.JID{info.Sender.ToNonAD(), info.SenderAlt.ToNonAD()} {
		switch jid.Server {
		case types.DefaultUserServer:
			if jid.User == pn {
				id.learnFromPair(info.Sender, info.SenderAlt)
				return matchYes
			}
			otherPN = jid.User != ""
		case types.HiddenUserServer:
			if id.isLID(jid.User) {
				return matchYes
			}
			if id.lids == nil {
				unknownLID = jid.User
				continue
			}
			resolved, err := id.lids.GetPNForLID(ctx, jid)
			switch {
			case err != nil:
				lookupFailed = true // decided below, unless the other identity matches
			case resolved.User == pn:
				id.setLID(jid.User)
				return matchYes
			case resolved.IsEmpty():
				unknownLID = jid.User
			}
		}
	}
	if lookupFailed && !otherPN { // with a non-matching phone number the answer is known: not the traveler
		return matchError
	}
	if unknownLID != "" {
		if _, lid := id.current(); lid == "" {
			// Our traveler's LID is unknown: one (rate-limited) active lookup may resolve it.
			id.ensureLID(ctx)
			if id.isLID(unknownLID) {
				return matchYes
			}
		}
		return matchUnknownLID
	}
	return matchNo
}

func (id *identity) isLID(user string) bool {
	_, lid := id.current()
	return lid != "" && lid == user
}

// learnFromMapping takes the traveler's LID from a phone-number <-> LID pair that WhatsApp sent
// (history sync PhoneNumberToLidMappings). whatsmeow stores those pairs in its LID map only in
// the background, possibly after the blob's statuses were dispatched, so the helper reads them
// itself before matching the blob's statuses.
func (id *identity) learnFromMapping(pn, lid types.JID) {
	if id.self || lid.Server != types.HiddenUserServer || lid.User == "" {
		return
	}
	if pn.Server != types.DefaultUserServer && pn.Server != types.LegacyUserServer {
		return
	}
	if cur, _ := id.current(); cur != "" && pn.User == cur {
		id.setLID(lid.User)
	}
}

// learnFromPair stores the LID when the stanza carries both identities (Sender + SenderAlt).
func (id *identity) learnFromPair(sender, senderAlt types.JID) {
	for _, jid := range []types.JID{sender.ToNonAD(), senderAlt.ToNonAD()} {
		if jid.Server == types.HiddenUserServer && jid.User != "" {
			id.setLID(jid.User)
		}
	}
}

// setLID records a learned LID and reports it (Node persists it and passes it back as
// -traveler-lid on the next spawn).
func (id *identity) setLID(lid string) {
	id.mu.Lock()
	changed := lid != "" && lid != id.lid && lidDigitsPattern.MatchString(lid)
	if changed {
		id.lid = lid
	}
	pn := id.pn
	id.mu.Unlock()
	if changed && id.onChange != nil && pn != "" {
		id.onChange(pn, lid)
	}
}

// setSelf (self mode) takes the traveler's identity from the linked account.
func (id *identity) setSelf(pn, lid string) {
	if !phoneDigitsPattern.MatchString(pn) {
		return
	}
	id.mu.Lock()
	changed := pn != id.pn || (lid != "" && lid != id.lid)
	id.pn = pn
	if lid != "" {
		id.lid = lid
	}
	lid = id.lid
	id.mu.Unlock()
	if changed && id.onChange != nil {
		id.onChange(pn, lid)
	}
}

// ensureLID resolves the traveler's LID from whatsmeow's LID map or, at most once per
// lookupInterval, with an active usync lookup (which also fills the LID map). A caller that
// arrives while a lookup is running waits for its answer: deciding without it would count a
// LID-only traveler status as another sender's and ack it unstored (e.g. a status or a history
// sync right after the post-Connected lookup started).
func (id *identity) ensureLID(ctx context.Context) {
	if id.self {
		return
	}
	pn, lid := id.current()
	if pn == "" || lid != "" {
		return
	}
	pnJID := types.NewJID(pn, types.DefaultUserServer)
	if id.lids != nil {
		if found, err := id.lids.GetLIDForPN(ctx, pnJID); err == nil && !found.IsEmpty() {
			id.setLID(found.User)
			return
		}
	}
	if id.activeLookup == nil {
		return
	}
	id.mu.Lock()
	if inFlight := id.lookupDone; inFlight != nil {
		id.mu.Unlock()
		select { // bounded by the running lookup's own timeout
		case <-inFlight:
		case <-ctx.Done():
		}
		return
	}
	if !id.lastLookup.IsZero() && id.now().Sub(id.lastLookup) < id.lookupInterval {
		id.mu.Unlock()
		return
	}
	id.lastLookup = id.now()
	done := make(chan struct{})
	id.lookupDone = done
	id.mu.Unlock()
	defer func() { // after setLID, so waiting callers see the result
		id.mu.Lock()
		id.lookupDone = nil
		id.mu.Unlock()
		close(done)
	}()
	ctx, cancel := context.WithTimeout(ctx, lidLookupTimeout)
	defer cancel()
	if found, err := id.activeLookup(ctx, pnJID); err == nil && found != "" {
		id.setLID(found)
	}
}
