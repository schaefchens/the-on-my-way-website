package main

// Test fakes and helpers shared by the *_test.go files. Nothing here touches the network.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"go.mau.fi/whatsmeow/util/gcmutil"
	"go.mau.fi/whatsmeow/util/hkdfutil"
	"google.golang.org/protobuf/proto"
)

// fakeDL is one scripted DownloadToFile result: data is written, then err returned.
type fakeDL struct {
	data  []byte
	err   error
	block chan struct{} // if set, wait for it (or ctx) before answering
}

// fakeAPI implements waClient with scripted results and records every call.
type fakeAPI struct {
	mu          sync.Mutex
	downloads   []fakeDL
	paths       []string // DirectPath of every DownloadToFile call
	receipts    []types.MessageInfo
	receiptKeys [][]byte
	receiptErr  error
	inFlight    int
	maxInFlight int

	markRead   []markReadCall
	markErr    error
	logoutErr  error
	logouts    int
	pairCode   string
	pairErr    error
	pairPhones []string
	parser     *whatsmeow.Client // ParseWebMessage delegate (no network involved)
}

type markReadCall struct {
	ids    []types.MessageID
	chat   types.JID
	sender types.JID
}

func (f *fakeAPI) script(dls ...fakeDL) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.downloads = append(f.downloads, dls...)
}

func (f *fakeAPI) DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error {
	f.mu.Lock()
	f.paths = append(f.paths, msg.GetDirectPath())
	if len(f.downloads) == 0 {
		f.mu.Unlock()
		return errors.New("fakeAPI: unexpected download")
	}
	dl := f.downloads[0]
	f.downloads = f.downloads[1:]
	f.inFlight++
	if f.inFlight > f.maxInFlight {
		f.maxInFlight = f.inFlight
	}
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.inFlight--
		f.mu.Unlock()
	}()
	if dl.block != nil {
		select {
		case <-dl.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if dl.data != nil {
		if _, err := file.Write(dl.data); err != nil {
			return err
		}
	}
	return dl.err
}

func (f *fakeAPI) SendMediaRetryReceipt(_ context.Context, info *types.MessageInfo, key []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.receipts = append(f.receipts, *info)
	f.receiptKeys = append(f.receiptKeys, key)
	return f.receiptErr
}

func (f *fakeAPI) MarkRead(_ context.Context, ids []types.MessageID, _ time.Time, chat, sender types.JID, _ ...types.ReceiptType) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markRead = append(f.markRead, markReadCall{ids: ids, chat: chat, sender: sender})
	return f.markErr
}

func (f *fakeAPI) Logout(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logouts++
	return f.logoutErr
}

func (f *fakeAPI) PairPhone(_ context.Context, phone string, _ bool, _ whatsmeow.PairClientType, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pairPhones = append(f.pairPhones, phone)
	return f.pairCode, f.pairErr
}

func (f *fakeAPI) ParseWebMessage(chat types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
	return f.parser.ParseWebMessage(chat, webMsg)
}

func (f *fakeAPI) snapshot() (paths []string, receipts []types.MessageInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.paths...), append([]types.MessageInfo(nil), f.receipts...)
}

// lockedBuffer is a goroutine-safe io.Writer for the emitter.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

// events parses every emitted JSON line.
func (b *lockedBuffer) events(t *testing.T) []map[string]any {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("stdout line is not JSON: %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// ofType returns the emitted events of one type.
func (b *lockedBuffer) ofType(t *testing.T, typ string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, e := range b.events(t) {
		if e["type"] == typ {
			out = append(out, e)
		}
	}
	return out
}

// fakeClock is a settable clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// testPolicy keeps the real structure with tiny durations.
var testPolicy = mediaPolicy{
	backoff:        []time.Duration{time.Millisecond, 2 * time.Millisecond, 3 * time.Millisecond},
	retryWait:      time.Hour, // advanced explicitly with the fake clock
	maxReceipts:    2,
	hashRetries:    1,
	attemptTimeout: 5 * time.Second,
	receiptTimeout: time.Second,
}

type mediaFixture struct {
	t     *testing.T
	inbox string
	api   *fakeAPI
	out   *lockedBuffer
	stats *stats
	clock *fakeClock
	m     *mediaManager
	ctx   context.Context
	stop  context.CancelFunc
}

func newMediaFixture(t *testing.T, workers int) *mediaFixture {
	t.Helper()
	dir := t.TempDir() // registered first, so it is removed after the jobs below have stopped
	ctx, stop := context.WithCancel(context.Background())
	f := &mediaFixture{
		t: t, inbox: filepath.Join(dir, "inbox"), api: &fakeAPI{}, out: &lockedBuffer{},
		stats: &stats{}, clock: &fakeClock{t: goldenNow}, ctx: ctx, stop: stop,
	}
	em := newEmitter(f.out)
	em.now = f.clock.now
	f.m = newMediaManager(ctx, f.inbox, f.api, em, zerolog.Nop(), f.stats, workers, false)
	f.m.policy = testPolicy
	f.m.now = f.clock.now
	t.Cleanup(func() {
		stop()
		if !f.m.wait(5 * time.Second) {
			t.Error("media jobs did not stop")
		}
	})
	return f
}

// content is a deterministic media payload.
func content(name string) []byte { return []byte("media payload of " + name) }

func sha(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

var testMediaKey = bytes.Repeat([]byte{0x42}, 32)

// mediaStatus builds a status message of kind photo|video|gif|voice whose FileSHA256 matches
// content(id).
func mediaStatus(kind, id string) *waE2E.Message {
	fileSHA := sha(content(id))
	switch kind {
	case kindPhoto:
		return &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"), FileSHA256: fileSHA, FileEncSHA256: bytes.Repeat([]byte{9}, 32),
			MediaKey: testMediaKey, DirectPath: proto.String("/v/t62/" + id), Width: proto.Uint32(1080), Height: proto.Uint32(1920),
		}}
	case kindVideo, kindGIF:
		return &waE2E.Message{VideoMessage: &waE2E.VideoMessage{
			Mimetype: proto.String("video/mp4"), FileSHA256: fileSHA, FileEncSHA256: bytes.Repeat([]byte{9}, 32),
			MediaKey: testMediaKey, DirectPath: proto.String("/v/t62/" + id), FileLength: proto.Uint64(4096),
			Seconds: proto.Uint32(5), GifPlayback: proto.Bool(kind == kindGIF),
		}}
	case kindVoice:
		return &waE2E.Message{AudioMessage: &waE2E.AudioMessage{
			Mimetype: proto.String("audio/ogg; codecs=opus"), FileSHA256: fileSHA, FileEncSHA256: bytes.Repeat([]byte{9}, 32),
			MediaKey: testMediaKey, DirectPath: proto.String("/v/t62/" + id), PTT: proto.Bool(true), Seconds: proto.Uint32(3),
		}}
	}
	panic("unknown kind " + kind)
}

// persistStatus writes the meta.json of a traveler status into the fixture's inbox.
func (f *mediaFixture) persistStatus(kind, id, source string) inboxMeta {
	f.t.Helper()
	info := statusInfo(id, false)
	if source == sourceHistory {
		info.AddressingMode, info.StanzaTag, info.IsGroup = "", "", false
	}
	msg := mediaStatus(kind, id)
	meta, err := buildMeta(info, msg, msg, source, goldenNow, travelerPN, travelerLID)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := persistMeta(f.inbox, meta); err != nil {
		f.t.Fatal(err)
	}
	return meta
}

func (f *mediaFixture) meta(id string) inboxMeta {
	f.t.Helper()
	m, err := readMeta(f.inbox, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return m
}

// job returns a detached job for driving step() directly (no goroutine).
func (f *mediaFixture) job(id string) *mediaJob {
	return &mediaJob{msgID: id, wake: make(chan struct{}, 1)}
}

// mediaRetryEvent builds an events.MediaRetry exactly as the phone would encrypt it, so the
// real whatsmeow.DecryptMediaRetryNotification is exercised.
func mediaRetryEvent(t *testing.T, msgID string, mediaKey []byte, result waMmsRetry.MediaRetryNotification_ResultType, directPath string) *events.MediaRetry {
	t.Helper()
	notif := &waMmsRetry.MediaRetryNotification{StanzaID: proto.String(msgID), Result: result.Enum()}
	if directPath != "" {
		notif.DirectPath = proto.String(directPath)
	}
	plain, err := proto.Marshal(notif)
	if err != nil {
		t.Fatal(err)
	}
	key := hkdfutil.SHA256(mediaKey, nil, []byte("WhatsApp Media Retry Notification"), 32)
	iv := bytes.Repeat([]byte{7}, 12)
	ct, err := gcmutil.Encrypt(key, iv, plain, []byte(msgID))
	if err != nil {
		t.Fatal(err)
	}
	return &events.MediaRetry{Ciphertext: ct, IV: iv, MessageID: msgID, ChatID: types.StatusBroadcastJID, Timestamp: goldenNow}
}

// waitFor polls cond until it is true or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

var _ io.Writer = (*lockedBuffer)(nil)
