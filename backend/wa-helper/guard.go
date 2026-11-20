package main

// Reconnect guard: DATA_DIR/wa/guard.json remembers a temporary ban and the last
// stream_replaced across restarts. Before connecting, the helper waits (connected to nothing)
// until the ban has ended / the cooldown has passed, so no supervisor restart policy can turn
// either into a reconnect loop.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"time"
)

const (
	guardFile = "guard.json"
	// streamReplacedCooldown: minimum time between a stream_replaced and the next connect.
	streamReplacedCooldown = 5 * time.Minute
	// unknownBanWait: how long the helper stays away after a temporary ban whose end WhatsApp
	// did not send (events.TemporaryBan.Expire == 0).
	unknownBanWait = time.Hour
)

type guardState struct {
	BannedUntil      string `json:"bannedUntil,omitempty"`
	BanCode          *int   `json:"banCode,omitempty"`
	StreamReplacedAt string `json:"streamReplacedAt,omitempty"`
}

func loadGuard(path string) (guardState, error) {
	var g guardState
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return g, nil
	} else if err != nil {
		return g, err
	}
	return g, json.Unmarshal(data, &g)
}

func updateGuard(path string, fn func(*guardState)) error {
	g, err := loadGuard(path)
	if err != nil {
		g = guardState{} // a corrupt guard file is replaced
	}
	fn(&g)
	return writeJSONAtomic(path, g)
}

// guardWait is what the helper must wait for before connecting.
type guardWait struct {
	until     time.Time // zero: connect right away
	banned    bool      // the wait is a temporary ban (else: the stream_replaced cooldown)
	banCode   *int
	remaining time.Duration
}

// pendingWait returns the wait required at now; the later of ban end and cooldown end wins.
func (g guardState) pendingWait(now time.Time) guardWait {
	var w guardWait
	if t, err := time.Parse(time.RFC3339Nano, g.BannedUntil); err == nil && t.After(now) {
		w.until, w.banned, w.banCode = t, true, g.BanCode
	}
	if t, err := time.Parse(time.RFC3339Nano, g.StreamReplacedAt); err == nil {
		end := t.Add(streamReplacedCooldown)
		if t.After(now) { // the clock went backwards: never wait longer than one cooldown
			end = now.Add(streamReplacedCooldown)
		}
		if end.After(now) && end.After(w.until) {
			w.until, w.banned, w.banCode = end, false, nil
		}
	}
	if !w.until.IsZero() {
		w.remaining = w.until.Sub(now)
	}
	return w
}
