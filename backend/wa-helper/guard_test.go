package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGuardPendingWait(t *testing.T) {
	now := goldenNow
	code := 101
	cases := []struct {
		name      string
		g         guardState
		remaining time.Duration
		banned    bool
	}{
		{"empty", guardState{}, 0, false},
		{"ban over", guardState{BannedUntil: isoUTC(now.Add(-time.Minute))}, 0, false},
		{"ban active", guardState{BannedUntil: isoUTC(now.Add(time.Hour)), BanCode: &code}, time.Hour, true},
		{"cooldown active", guardState{StreamReplacedAt: isoUTC(now.Add(-time.Minute))}, streamReplacedCooldown - time.Minute, false},
		{"cooldown over", guardState{StreamReplacedAt: isoUTC(now.Add(-time.Hour))}, 0, false},
		{"clock went backwards", guardState{StreamReplacedAt: isoUTC(now.Add(24 * time.Hour))}, streamReplacedCooldown, false},
		{"ban outlasts cooldown", guardState{BannedUntil: isoUTC(now.Add(time.Hour)), BanCode: &code, StreamReplacedAt: isoUTC(now)}, time.Hour, true},
		{"cooldown outlasts ban", guardState{BannedUntil: isoUTC(now.Add(time.Minute)), StreamReplacedAt: isoUTC(now)}, streamReplacedCooldown, false},
		{"garbage", guardState{BannedUntil: "soon", StreamReplacedAt: "never"}, 0, false},
	}
	for _, tc := range cases {
		w := tc.g.pendingWait(now)
		if w.remaining != tc.remaining || w.banned != tc.banned {
			t.Errorf("%s: %+v; want remaining %v banned %v", tc.name, w, tc.remaining, tc.banned)
		}
		if tc.banned && (w.banCode == nil || *w.banCode != code) {
			t.Errorf("%s: ban code lost", tc.name)
		}
	}
}

func TestGuardFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wa", guardFile)
	if g, err := loadGuard(path); err != nil || g != (guardState{}) {
		t.Fatalf("missing file: %+v %v", g, err)
	}
	if err := updateGuard(path, func(g *guardState) { g.StreamReplacedAt = isoUTC(goldenNow) }); err != nil {
		t.Fatal(err)
	}
	if err := updateGuard(path, func(g *guardState) { g.BannedUntil = isoUTC(goldenNow.Add(time.Hour)) }); err != nil {
		t.Fatal(err)
	}
	g, err := loadGuard(path)
	if err != nil || g.StreamReplacedAt != isoUTC(goldenNow) || g.BannedUntil != isoUTC(goldenNow.Add(time.Hour)) {
		t.Fatalf("guard = %+v %v", g, err)
	}
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := updateGuard(path, func(g *guardState) { g.StreamReplacedAt = isoUTC(goldenNow) }); err != nil {
		t.Fatal("a corrupt guard file is replaced")
	}
}
