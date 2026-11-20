package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

func TestMediaDownloadOK(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0OK1", sourceLive)
	f.api.script(fakeDL{data: content("3EB0OK1")})

	if _, done := f.m.step(f.job("3EB0OK1"), nil, false); !done {
		t.Fatal("a successful download must end the job")
	}
	m := f.meta("3EB0OK1")
	d := m.Download
	if d.State != dlOK || d.File != "original.jpg" || d.Attempts != 1 || d.Sha256Hex != hex.EncodeToString(sha(content("3EB0OK1"))) {
		t.Fatalf("download = %+v", d)
	}
	data, err := os.ReadFile(filepath.Join(f.inbox, "3EB0OK1", "original.jpg"))
	if err != nil || string(data) != string(content("3EB0OK1")) {
		t.Fatalf("original.jpg = %q, %v", data, err)
	}
	assertNoTempFiles(t, filepath.Join(f.inbox, "3EB0OK1"))
	ev := f.out.ofType(t, "media")
	if len(ev) != 1 || ev[0]["state"] != "ok" || ev[0]["msgId"] != "3EB0OK1" {
		t.Fatalf("media events = %v", ev)
	}
	if m.Media.FileLength != uint64(len(content("3EB0OK1"))) {
		t.Fatalf("fileLength should be learned when WhatsApp sent 0, got %d", m.Media.FileLength)
	}
	if f.stats.mediaOK.Load() != 1 {
		t.Fatal("media_ok not counted")
	}
}

func TestMediaFileNamesByKind(t *testing.T) {
	for kind, want := range map[string]string{kindPhoto: "original.jpg", kindVideo: "original.mp4", kindGIF: "original.mp4", kindVoice: "original.ogg"} {
		f := newMediaFixture(t, 1)
		f.m.setOnline(true)
		id := "3EB0" + strings.ToUpper(kind)
		f.persistStatus(kind, id, sourceLive)
		f.api.script(fakeDL{data: content(id)})
		f.m.step(f.job(id), nil, false)
		if got := f.meta(id).Download; got.State != dlOK || got.File != want {
			t.Errorf("%s: %+v; want file %s", kind, got, want)
		}
		if kind == kindVideo && f.meta(id).Media.FileLength != 4096 {
			t.Error("a known fileLength must not be overwritten")
		}
	}
}

func TestMediaHashMismatchRetriesOnceThenFailsPermanently(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindVideo, "3EB0HASH", sourceLive)
	f.api.script(fakeDL{data: []byte("corrupt")}, fakeDL{err: fmt.Errorf("download: %w", whatsmeow.ErrInvalidMediaSHA256)})
	j := f.job("3EB0HASH")

	delay, done := f.m.step(j, nil, false)
	if done || delay != testPolicy.backoff[0] {
		t.Fatalf("first mismatch: delay %v done %v", delay, done)
	}
	if d := f.meta("3EB0HASH").Download; d.State != dlPending || d.Attempts != 1 || d.Error == "" {
		t.Fatalf("after first mismatch: %+v", d)
	}
	if _, done := f.m.step(j, nil, false); !done {
		t.Fatal("second mismatch must end the job")
	}
	d := f.meta("3EB0HASH").Download
	if d.State != dlFailed || d.Reason != reasonHashMismatch || d.Permanent == nil || !*d.Permanent || d.Attempts != 2 {
		t.Fatalf("after second mismatch: %+v", d)
	}
	if _, err := os.Stat(filepath.Join(f.inbox, "3EB0HASH", "original.mp4")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a corrupt download must never become original.*")
	}
	assertNoTempFiles(t, filepath.Join(f.inbox, "3EB0HASH"))
	ev := f.out.ofType(t, "media")
	if len(ev) != 1 || ev[0]["state"] != "failed" || ev[0]["reason"] != "hash_mismatch" || ev[0]["permanent"] != true {
		t.Fatalf("media events = %v", ev)
	}
}

func TestMediaGoneSendsRetryReceiptAndUsesTheNewPath(t *testing.T) {
	for _, source := range []string{sourceLive, sourceHistory} {
		t.Run(source, func(t *testing.T) {
			f := newMediaFixture(t, 1)
			f.m.setOnline(true)
			f.persistStatus(kindPhoto, "3EB0GONE", source)
			f.api.script(fakeDL{err: fmt.Errorf("x: %w", whatsmeow.ErrMediaDownloadFailedWith404)})
			j := f.job("3EB0GONE")

			delay, done := f.m.step(j, nil, false)
			if done || delay != testPolicy.retryWait {
				t.Fatalf("gone: delay %v done %v", delay, done)
			}
			d := f.meta("3EB0GONE").Download
			if d.State != dlRetrying || d.RetryRequestedAt != isoUTC(goldenNow) || d.Attempts != 1 {
				t.Fatalf("after 404: %+v", d)
			}
			_, receipts := f.api.snapshot()
			if len(receipts) != 1 {
				t.Fatalf("receipts = %d", len(receipts))
			}
			r := receipts[0]
			// IsGroup must be true even for history statuses, or whatsmeow omits participant.
			if r.ID != "3EB0GONE" || r.Chat != types.StatusBroadcastJID || !r.IsGroup || r.IsFromMe ||
				r.Sender.String() != travelerLID+"@lid" {
				t.Fatalf("receipt info = %+v", r)
			}
			if string(f.api.receiptKeys[0]) != string(testMediaKey) {
				t.Fatal("receipt must carry the status's media key")
			}
			if ev := f.out.ofType(t, "media"); len(ev) != 1 || ev[0]["state"] != "retrying" {
				t.Fatalf("media events = %v", ev)
			}

			// The answer arrives (possibly much later): new direct path, download succeeds.
			f.api.script(fakeDL{data: content("3EB0GONE")})
			answer := mediaRetryEvent(t, "3EB0GONE", testMediaKey, waMmsRetry.MediaRetryNotification_SUCCESS, "/v/t62/new-path")
			if _, done := f.m.step(j, []*events.MediaRetry{answer}, false); !done {
				t.Fatal("answer + download must end the job")
			}
			if d := f.meta("3EB0GONE").Download; d.State != dlOK || d.Attempts != 2 {
				t.Fatalf("after answer: %+v", d)
			}
			paths, _ := f.api.snapshot()
			if len(paths) != 2 || paths[0] != "/v/t62/3EB0GONE" || paths[1] != "/v/t62/new-path" {
				t.Fatalf("download paths = %v", paths)
			}
		})
	}
}

// Regression: the fresh direct path from a media-retry answer was dropped before the download
// ran, so one transient error right after a successful answer fell back to the gone CDN path
// and spent another media-retry receipt. The fresh path is kept until it is gone as well.
func TestFreshPathSurvivesATransientFailure(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0FRESH", sourceLive)
	f.api.script(fakeDL{err: fmt.Errorf("x: %w", whatsmeow.ErrMediaDownloadFailedWith404)})
	j := f.job("3EB0FRESH")
	if _, done := f.m.step(j, nil, false); done {
		t.Fatal("404 must wait for the answer")
	}
	answer := mediaRetryEvent(t, "3EB0FRESH", testMediaKey, waMmsRetry.MediaRetryNotification_SUCCESS, "/v/t62/fresh")
	f.api.script(fakeDL{err: &net.OpError{Op: "read", Err: syscall.ECONNRESET}}, fakeDL{data: content("3EB0FRESH")})
	if delay, done := f.m.step(j, []*events.MediaRetry{answer}, false); done || delay != testPolicy.backoff[0] {
		t.Fatalf("transient failure: delay %v done %v", delay, done)
	}
	if _, done := f.m.step(j, nil, false); !done {
		t.Fatal("the retry with the fresh path must finish the job")
	}
	paths, receipts := f.api.snapshot()
	if len(receipts) != 1 || len(paths) != 3 || paths[1] != "/v/t62/fresh" || paths[2] != "/v/t62/fresh" {
		t.Fatalf("paths = %v, receipts = %d; want the fresh path twice and a single receipt", paths, len(receipts))
	}
	if d := f.meta("3EB0FRESH").Download; d.State != dlOK {
		t.Fatalf("download = %+v", d)
	}
}

func TestMediaRetryAnswers(t *testing.T) {
	cases := []struct {
		name      string
		evt       func(t *testing.T) *events.MediaRetry
		reason    string
		permanent bool
	}{
		{"not_found", func(t *testing.T) *events.MediaRetry {
			return mediaRetryEvent(t, "3EB0ANS", testMediaKey, waMmsRetry.MediaRetryNotification_NOT_FOUND, "")
		}, reasonExpired, true},
		{"not_on_phone", func(*testing.T) *events.MediaRetry {
			return &events.MediaRetry{MessageID: "3EB0ANS", Error: &events.MediaRetryError{Code: 2}}
		}, reasonNotOnPhone, true},
		{"unknown_error_code", func(*testing.T) *events.MediaRetry {
			return &events.MediaRetry{MessageID: "3EB0ANS", Error: &events.MediaRetryError{Code: 7}}
		}, reasonUnknown, false},
		{"general_error", func(t *testing.T) *events.MediaRetry {
			return mediaRetryEvent(t, "3EB0ANS", testMediaKey, waMmsRetry.MediaRetryNotification_GENERAL_ERROR, "")
		}, reasonUnknown, false},
		{"wrong_key", func(t *testing.T) *events.MediaRetry {
			return mediaRetryEvent(t, "3EB0ANS", make([]byte, 32), waMmsRetry.MediaRetryNotification_SUCCESS, "/x")
		}, reasonUnknown, false},
		{"success_without_path", func(t *testing.T) *events.MediaRetry {
			return mediaRetryEvent(t, "3EB0ANS", testMediaKey, waMmsRetry.MediaRetryNotification_SUCCESS, "")
		}, reasonUnknown, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newMediaFixture(t, 1)
			f.m.setOnline(true)
			f.persistStatus(kindVoice, "3EB0ANS", sourceLive)
			f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith410})
			j := f.job("3EB0ANS")
			f.m.step(j, nil, false) // -> retrying
			if _, done := f.m.step(j, []*events.MediaRetry{tc.evt(t)}, false); !done {
				t.Fatal("a final answer must end the job")
			}
			d := f.meta("3EB0ANS").Download
			if d.State != dlFailed || d.Reason != tc.reason || d.Permanent == nil || *d.Permanent != tc.permanent {
				t.Fatalf("download = %+v", d)
			}
			ev := f.out.ofType(t, "media")
			last := ev[len(ev)-1]
			if last["state"] != "failed" || last["reason"] != tc.reason || last["permanent"] != tc.permanent {
				t.Fatalf("last media event = %v", last)
			}
		})
	}
}

func TestMediaRetryAnswerForAnotherStanzaIsIgnored(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0MINE", sourceLive)
	f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith404})
	j := f.job("3EB0MINE")
	f.m.step(j, nil, false)
	other := mediaRetryEvent(t, "3EB0MINE", testMediaKey, waMmsRetry.MediaRetryNotification_SUCCESS, "/x")
	// Re-encrypt with a different stanza id inside but the same MessageID (AAD) is impossible to
	// forge without the key; simulate a decrypt function that returns another stanza.
	f.m.decrypt = func(*events.MediaRetry, []byte) (*waMmsRetry.MediaRetryNotification, error) {
		s, p, r := "OTHER", "/x", waMmsRetry.MediaRetryNotification_SUCCESS
		return &waMmsRetry.MediaRetryNotification{StanzaID: &s, DirectPath: &p, Result: &r}, nil
	}
	delay, done := f.m.step(j, []*events.MediaRetry{other}, false)
	if done || delay <= 0 || f.meta("3EB0MINE").Download.State != dlRetrying {
		t.Fatalf("foreign answer changed the state: delay %v done %v %+v", delay, done, f.meta("3EB0MINE").Download)
	}
}

func TestMediaRetryReceiptsAreBounded(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0SILENT", sourceLive)
	j := f.job("3EB0SILENT")
	for i := 0; i < testPolicy.maxReceipts; i++ {
		f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith404})
		if delay, done := f.m.step(j, nil, false); done || delay != testPolicy.retryWait {
			t.Fatalf("round %d: delay %v done %v", i, delay, done)
		}
		// Before the wait is over a round only waits (the answer may still come).
		f.clock.advance(testPolicy.retryWait / 2)
		if delay, done := f.m.step(j, nil, false); done || delay != testPolicy.retryWait/2 {
			t.Fatalf("round %d early: delay %v done %v", i, delay, done)
		}
		f.clock.advance(testPolicy.retryWait / 2)
	}
	f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith404})
	if _, done := f.m.step(j, nil, false); !done {
		t.Fatal("the job must give up after maxReceipts")
	}
	d := f.meta("3EB0SILENT").Download
	if d.State != dlFailed || d.Reason != reasonTimeout || *d.Permanent || d.Attempts != testPolicy.maxReceipts+1 {
		t.Fatalf("download = %+v", d)
	}
	if _, receipts := f.api.snapshot(); len(receipts) != testPolicy.maxReceipts {
		t.Fatalf("receipts = %d", len(receipts))
	}
	if f.stats.mediaRetry.Load() != int64(testPolicy.maxReceipts) {
		t.Fatal("media_retry must count the receipts")
	}
}

func TestMediaTransientFailuresBackOffThenFail(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindVideo, "3EB0NET", sourceLive)
	netErr := &net.OpError{Op: "read", Err: errors.New("connection reset")}
	j := f.job("3EB0NET")
	for i, want := range testPolicy.backoff {
		f.api.script(fakeDL{err: fmt.Errorf("failed to download media from last host: %w", netErr)})
		delay, done := f.m.step(j, nil, false)
		if done || delay != want {
			t.Fatalf("failure %d: delay %v done %v", i, delay, done)
		}
		if d := f.meta("3EB0NET").Download; d.State != dlPending || d.Attempts != i+1 {
			t.Fatalf("failure %d: %+v", i, d)
		}
	}
	f.api.script(fakeDL{err: netErr})
	if _, done := f.m.step(j, nil, false); !done {
		t.Fatal("must give up after the backoff schedule")
	}
	d := f.meta("3EB0NET").Download
	if d.State != dlFailed || d.Reason != reasonNetwork || *d.Permanent {
		t.Fatalf("download = %+v", d)
	}
	if ev := f.out.ofType(t, "media"); len(ev) != 1 || ev[0]["state"] != "failed" || ev[0]["permanent"] != false {
		t.Fatalf("pending retries must not emit events; got %v", ev)
	}
}

func TestMediaReceiptFailureIsTransient(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.api.receiptErr = whatsmeow.ErrNotConnected
	f.persistStatus(kindPhoto, "3EB0RCPT", sourceLive)
	f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith403})
	delay, done := f.m.step(f.job("3EB0RCPT"), nil, false)
	if done || delay != testPolicy.backoff[0] {
		t.Fatalf("delay %v done %v", delay, done)
	}
	if d := f.meta("3EB0RCPT").Download; d.State != dlPending || !strings.Contains(d.Error, "media retry receipt") {
		t.Fatalf("download = %+v", d)
	}
}

func TestMediaShutdownLeavesStateResumable(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0STOP", sourceLive)
	block := make(chan struct{})
	f.api.script(fakeDL{block: block})
	done := make(chan bool)
	go func() {
		_, d := f.m.step(f.job("3EB0STOP"), nil, false)
		done <- d
	}()
	waitFor(t, "download in flight", func() bool { p, _ := f.api.snapshot(); return len(p) == 1 })
	f.stop()
	if !<-done {
		t.Fatal("a cancelled attempt ends the job")
	}
	if d := f.meta("3EB0STOP").Download; d.State != dlPending || d.Attempts != 0 {
		t.Fatalf("shutdown must not record a failure: %+v", d)
	}
	if len(f.out.ofType(t, "media")) != 0 {
		t.Fatal("no media event on shutdown")
	}
	assertNoTempFiles(t, filepath.Join(f.inbox, "3EB0STOP"))
}

func TestRedownloadOnlyForNonPermanentFailures(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	ok := f.persistStatus(kindPhoto, "3EB0RDOK", sourceLive)
	_ = ok
	f.api.script(fakeDL{data: content("3EB0RDOK")})
	f.m.step(f.job("3EB0RDOK"), nil, false)
	f.persistStatus(kindPhoto, "3EB0RDPEND", sourceLive)
	f.persistStatus(kindPhoto, "3EB0RDPERM", sourceLive)
	if _, err := updateMeta(f.inbox, "3EB0RDPERM", func(m *inboxMeta) error {
		m.Download = inboxDownload{State: dlFailed, Reason: reasonExpired, Permanent: boolPtr(true), Attempts: 3}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"3EB0RDOK", "3EB0RDPEND", "3EB0RDPERM", "3EB0MISSING"} {
		if err := f.m.redownload(id); err == nil {
			t.Errorf("redownload(%s) must be rejected", id)
		}
	}

	// failed, non-permanent: reset to pending, a new run, downloaded.
	f.persistStatus(kindVoice, "3EB0RDNET", sourceLive)
	if _, err := updateMeta(f.inbox, "3EB0RDNET", func(m *inboxMeta) error {
		m.Download = inboxDownload{State: dlFailed, Reason: reasonNetwork, Permanent: boolPtr(false), Attempts: 6, Error: "x"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.api.script(fakeDL{data: content("3EB0RDNET")})
	if err := f.m.redownload("3EB0RDNET"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "redownload", func() bool { return f.meta("3EB0RDNET").Download.State == dlOK })
	if d := f.meta("3EB0RDNET").Download; d.Attempts != 7 || d.Reason != "" || d.Permanent != nil || d.Error != "" {
		t.Fatalf("download = %+v", d)
	}
	waitFor(t, "job exit", func() bool { return f.m.active() == 0 })
}

func TestResumeOnStart(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.persistStatus(kindPhoto, "3EB0RESPEND", sourceLive)
	f.persistStatus(kindVideo, "3EB0RESRETRY", sourceHistory)
	if _, err := updateMeta(f.inbox, "3EB0RESRETRY", func(m *inboxMeta) error {
		m.Download = inboxDownload{State: dlRetrying, Attempts: 1, RetryRequestedAt: isoUTC(goldenNow.Add(-time.Minute))}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.persistStatus(kindPhoto, "3EB0RESOK", sourceLive)
	if _, err := updateMeta(f.inbox, "3EB0RESOK", func(m *inboxMeta) error {
		m.Download = inboxDownload{State: dlOK, Attempts: 1, File: "original.jpg", Sha256Hex: strings.Repeat("0", 64)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(f.inbox, "3EB0RESPEND", tmpPrefixDownload+"123")
	if err := os.WriteFile(stale, []byte("half"), 0o600); err != nil {
		t.Fatal(err)
	}

	n, err := f.m.resume()
	if err != nil || n != 2 {
		t.Fatalf("resume = %d, %v", n, err)
	}
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale temp download not removed")
	}
	// Offline: nothing is downloaded yet.
	time.Sleep(20 * time.Millisecond)
	if p, _ := f.api.snapshot(); len(p) != 0 {
		t.Fatalf("downloads before the connection is open: %v", p)
	}
	f.api.script(fakeDL{data: content("3EB0RESPEND")})
	f.m.setOnline(true)
	waitFor(t, "pending download resumed", func() bool { return f.meta("3EB0RESPEND").Download.State == dlOK })
	// The retrying one waits for the phone's answer (retryRequestedAt is recent) ...
	if d := f.meta("3EB0RESRETRY").Download; d.State != dlRetrying {
		t.Fatalf("retrying download changed early: %+v", d)
	}
	// ... and an answer that arrives after the restart is still matched via meta.json.
	f.api.script(fakeDL{data: content("3EB0RESRETRY")})
	f.m.onMediaRetry(mediaRetryEvent(t, "3EB0RESRETRY", testMediaKey, waMmsRetry.MediaRetryNotification_SUCCESS, "/v/t62/fresh"))
	waitFor(t, "answer handled", func() bool { return f.meta("3EB0RESRETRY").Download.State == dlOK })
	waitFor(t, "jobs done", func() bool { return f.m.active() == 0 })
	if f.stats.mediaRetryAnswers.Load() != 1 {
		t.Fatal("media_retry_answers not counted")
	}
}

func TestOverdueRetryResendsTheReceiptOnStart(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0OVERDUE", sourceHistory)
	if _, err := updateMeta(f.inbox, "3EB0OVERDUE", func(m *inboxMeta) error {
		m.Download = inboxDownload{State: dlRetrying, Attempts: 1, RetryRequestedAt: isoUTC(goldenNow.Add(-2 * testPolicy.retryWait))}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith404})
	if n, _ := f.m.resume(); n != 1 {
		t.Fatal("not resumed")
	}
	waitFor(t, "receipt re-sent", func() bool { _, r := f.api.snapshot(); return len(r) == 1 })
	waitFor(t, "retryRequestedAt updated", func() bool {
		return f.meta("3EB0OVERDUE").Download.RetryRequestedAt == isoUTC(goldenNow)
	})
}

func TestMediaConcurrencyIsBounded(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	block := make(chan struct{})
	for _, id := range []string{"3EB0C1", "3EB0C2", "3EB0C3"} {
		f.persistStatus(kindPhoto, id, sourceLive)
	}
	// Scripted in call order; every call blocks until released, so overlap would be visible.
	f.api.script(fakeDL{block: block, err: errors.New("boom")}, fakeDL{block: block, err: errors.New("boom")}, fakeDL{block: block, err: errors.New("boom")})
	for _, id := range []string{"3EB0C1", "3EB0C2", "3EB0C3"} {
		f.m.ensure(id)
	}
	waitFor(t, "first download", func() bool { p, _ := f.api.snapshot(); return len(p) == 1 })
	time.Sleep(20 * time.Millisecond)
	close(block)
	waitFor(t, "all attempted", func() bool { p, _ := f.api.snapshot(); return len(p) >= 3 })
	f.api.mu.Lock()
	maxInFlight := f.api.maxInFlight
	f.api.mu.Unlock()
	if maxInFlight != 1 {
		t.Fatalf("max concurrent downloads = %d; want 1", maxInFlight)
	}
	f.stop()
	if !f.m.wait(time.Second) {
		t.Fatal("jobs did not stop after cancel")
	}
}

func TestSelfModeReceiptIsFromMe(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.fromMe = true
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0SELF", sourceLive)
	f.api.script(fakeDL{err: whatsmeow.ErrMediaDownloadFailedWith404})
	f.m.step(f.job("3EB0SELF"), nil, false)
	if _, r := f.api.snapshot(); len(r) != 1 || !r[0].IsFromMe || !r[0].IsGroup {
		t.Fatalf("receipts = %+v", r)
	}
}

func TestBrokenMetaFailsWithoutRetrying(t *testing.T) {
	f := newMediaFixture(t, 1)
	f.m.setOnline(true)
	f.persistStatus(kindPhoto, "3EB0BROKEN", sourceLive)
	if _, err := updateMeta(f.inbox, "3EB0BROKEN", func(m *inboxMeta) error { m.RawProtoB64 = "AAAA"; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, done := f.m.step(f.job("3EB0BROKEN"), nil, false); !done {
		t.Fatal("must end")
	}
	if d := f.meta("3EB0BROKEN").Download; d.State != dlFailed || d.Reason != reasonUnknown || *d.Permanent {
		t.Fatalf("download = %+v", d)
	}
	if p, _ := f.api.snapshot(); len(p) != 0 {
		t.Fatal("no download without media keys")
	}
}

func TestClassifyDownloadError(t *testing.T) {
	live := context.Background()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	http500 := whatsmeow.DownloadHTTPError{Response: &http.Response{StatusCode: 500}}
	cases := []struct {
		ctx     context.Context
		err     error
		outcome outcome
		reason  string
	}{
		{cancelled, context.Canceled, outCanceled, ""},
		{live, whatsmeow.ErrMediaDownloadFailedWith403, outGone, reasonExpired},
		{live, fmt.Errorf("wrapped: %w", whatsmeow.ErrMediaDownloadFailedWith404), outGone, reasonExpired},
		{live, whatsmeow.DownloadHTTPError{Response: &http.Response{StatusCode: 410}}, outGone, reasonExpired},
		{live, whatsmeow.ErrNoURLPresent, outGone, reasonExpired},
		{live, whatsmeow.ErrInvalidMediaSHA256, outHash, reasonHashMismatch},
		{live, whatsmeow.ErrInvalidMediaHMAC, outHash, reasonHashMismatch},
		{live, whatsmeow.ErrInvalidMediaEncSHA256, outHash, reasonHashMismatch},
		{live, context.DeadlineExceeded, outTransient, reasonTimeout},
		{live, fmt.Errorf("failed to query media connections: %w", whatsmeow.ErrIQTimedOut), outTransient, reasonTimeout},
		{live, &net.DNSError{Err: "no such host", IsTimeout: true}, outTransient, reasonTimeout},
		{live, &net.OpError{Op: "dial", Err: errors.New("refused")}, outTransient, reasonNetwork},
		{live, fmt.Errorf("last host: %w", http500), outTransient, reasonNetwork},
		{live, whatsmeow.ErrNotConnected, outTransient, reasonNetwork},
		{live, whatsmeow.ErrTooShortFile, outTransient, reasonUnknown},
		{live, errors.New("something else"), outTransient, reasonUnknown},
	}
	for i, tc := range cases {
		o, r := classifyDownloadError(tc.ctx, tc.err)
		if o != tc.outcome || r != tc.reason {
			t.Errorf("case %d (%v): got %v/%q; want %v/%q", i, tc.err, o, r, tc.outcome, tc.reason)
		}
	}
}

func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("temp file left behind in %s: %s", dir, e.Name())
		}
	}
}
