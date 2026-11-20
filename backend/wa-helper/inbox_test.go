package main

// Golden files of the D9 protocol: testdata/golden/*.json(l) are produced by inbox.go and
// validated against the zod contracts by packages/contracts/test/wa-golden.test.ts.
// Regenerate after an intended change:  go test -run TestGolden -update

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

var update = flag.Bool("update", false, "rewrite testdata/golden")

var (
	goldenNow   = time.Date(2026, 11, 15, 2, 12, 3, 0, time.UTC)
	travelerPN  = "4915100000001"
	travelerLID = "100000000000001"
)

func statusInfo(id string, lidOnly bool) types.MessageInfo {
	src := types.MessageSource{
		Chat:           types.StatusBroadcastJID,
		Sender:         types.JID{User: travelerLID, Device: 12, Server: types.HiddenUserServer},
		IsGroup:        true,
		AddressingMode: types.AddressingModeLID,
	}
	if !lidOnly {
		src.SenderAlt = types.NewJID(travelerPN, types.DefaultUserServer)
	}
	return types.MessageInfo{
		MessageSource: src, ID: id, PushName: "Reisende", StanzaTag: "status",
		Timestamp: time.Date(2026, 11, 15, 2, 12, 0, 0, time.UTC),
	}
}

func goldenCases() map[string]*waE2E.Message {
	sha := bytes.Repeat([]byte{0xab}, 32)
	return map[string]*waE2E.Message{
		"photo": {ImageMessage: &waE2E.ImageMessage{
			Caption: proto.String("Hội An"), Mimetype: proto.String("image/jpeg"), FileSHA256: sha,
			FileLength: proto.Uint64(123456), Width: proto.Uint32(1080), Height: proto.Uint32(1350),
			MediaKey: bytes.Repeat([]byte{1}, 32), DirectPath: proto.String("/v/t62/x"),
		}},
		"photo-no-size": {ImageMessage: &waE2E.ImageMessage{FileSHA256: sha, FileLength: proto.Uint64(1)}},
		"video": {VideoMessage: &waE2E.VideoMessage{
			Mimetype: proto.String("video/mp4"), FileSHA256: sha, FileLength: proto.Uint64(999),
			Width: proto.Uint32(720), Height: proto.Uint32(1280), Seconds: proto.Uint32(4),
		}},
		"gif": {VideoMessage: &waE2E.VideoMessage{
			FileSHA256: sha, FileLength: proto.Uint64(42), Seconds: proto.Uint32(2), GifPlayback: proto.Bool(true),
		}},
		"voice": {AudioMessage: &waE2E.AudioMessage{
			Mimetype: proto.String("audio/ogg; codecs=opus"), FileSHA256: sha, FileLength: proto.Uint64(9000),
			Seconds: proto.Uint32(3), PTT: proto.Bool(true), Waveform: []byte{0, 50, 100},
		}},
		"text": {ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String("Xin chào!"), BackgroundArgb: proto.Uint32(0xffc1a03f), TextArgb: proto.Uint32(0xffffffff),
			Font: waE2E.ExtendedTextMessage_CALISTOGA_REGULAR.Enum(),
		}},
		"conversation": {Conversation: proto.String("plain")},
		"unsupported":  {PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("?")}},
	}
}

func TestGoldenInboxFiles(t *testing.T) {
	dir := filepath.Join("testdata", "golden")
	files := map[string][]byte{}
	for name, msg := range goldenCases() {
		info := statusInfo("3EB0GOLDEN"+name, name == "conversation")
		source := sourceLive
		if name == "video" {
			source = sourceHistory
			info.AddressingMode, info.StanzaTag, info.IsGroup = "", "", false
		}
		meta, err := buildMeta(info, msg, msg, source, goldenNow, travelerPN, travelerLID)
		if err != nil {
			t.Fatal(err)
		}
		data, err := encodeJSONFile(meta)
		if err != nil {
			t.Fatal(err)
		}
		files["meta-"+name+".json"] = data
	}
	rev, _ := encodeJSONFile(revokeRecord{Schema: 1, MsgID: "3EB0GOLDENphoto", At: isoUTC(goldenNow)})
	files["revoke.json"] = rev

	// Download lifecycle: meta.json files as the media manager leaves them on disk.
	lifecycle := newMediaFixture(t, 1)
	lifecycle.m.setOnline(true)
	readFile := func(id string) []byte {
		data, err := os.ReadFile(metaPath(lifecycle.inbox, id))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	lifecycle.persistStatus(kindPhoto, "3EB0GOLDENok", sourceLive)
	lifecycle.api.script(fakeDL{data: content("3EB0GOLDENok")})
	lifecycle.m.step(lifecycle.job("3EB0GOLDENok"), nil, false)
	files["meta-photo-downloaded.json"] = readFile("3EB0GOLDENok")

	lifecycle.persistStatus(kindGIF, "3EB0GOLDENretry", sourceHistory)
	lifecycle.api.script(fakeDL{err: fmt.Errorf("download failed: %w", whatsmeow.ErrMediaDownloadFailedWith404)})
	retryJob := lifecycle.job("3EB0GOLDENretry")
	lifecycle.m.step(retryJob, nil, false)
	files["meta-gif-retrying.json"] = readFile("3EB0GOLDENretry")
	lifecycle.m.step(retryJob, []*events.MediaRetry{
		mediaRetryEvent(t, "3EB0GOLDENretry", testMediaKey, waMmsRetry.MediaRetryNotification_NOT_FOUND, ""),
	}, false)
	files["meta-gif-failed.json"] = readFile("3EB0GOLDENretry")

	var lines bytes.Buffer
	e := newEmitter(&lines)
	e.now = func() time.Time { return goldenNow }
	e.emit("ready", map[string]any{"version": helperVersion, "paired": false, "mode": modeObserver})
	e.state("connecting", stateInfo{})
	e.state("qr", stateInfo{})
	e.emit("qr", map[string]any{"code": "2@abc,def", "expiresAt": isoUTC(goldenNow.Add(60 * time.Second))})
	e.emit("pair_code", map[string]any{"code": "ABCD-EFGH"})
	e.state("pairing", stateInfo{reason: "pair_success", jid: "4915100000002@s.whatsapp.net"})
	e.state("open", stateInfo{jid: "4915100000002@s.whatsapp.net"})
	e.state("closed", stateInfo{reason: "disconnected"})
	e.state("closed", stateInfo{reason: "keepalive_timeout", code: intPtr(3)})
	e.state("open", stateInfo{reason: "keepalive_restored"})
	e.state("closed", stateInfo{reason: "pair_timeout"})
	e.state("closed", stateInfo{detail: "stream_replaced cooldown: not connecting before " + isoUTC(goldenNow.Add(streamReplacedCooldown))})
	e.state("banned", stateInfo{reason: "temporary_ban", code: intPtr(101), until: goldenNow.Add(time.Hour), detail: "ban"})
	e.state("logged_out", stateInfo{code: intPtr(401), detail: "logged out"})
	e.state("stream_replaced", stateInfo{detail: "another client took over this session"})
	e.state("error", stateInfo{reason: "pair_error", detail: "boom"})
	e.state("error", stateInfo{reason: "client_outdated"})
	e.state("error", stateInfo{reason: "connect_failure", code: intPtr(500), detail: "boom"})
	e.state("error", stateInfo{reason: "fatal", detail: "boom"})
	e.emit("status", map[string]any{"msgId": "3EB0GOLDENphoto", "source": sourceLive})
	e.emit("status", map[string]any{"msgId": "3EB0GOLDENvideo", "source": sourceHistory})
	e.emit("revoke", map[string]any{"msgId": "3EB0GOLDENphoto", "at": isoUTC(goldenNow)})
	e.emit("traveler", map[string]any{"pn": travelerPN, "lid": travelerLID})
	e.emit("traveler", map[string]any{"pn": travelerPN})
	var s stats
	s.captured.Add(2)
	e.emit("stats", map[string]any{"counters": s.counters(1)})
	e.warning(warnInvalidCommand, "", "", "not a JSON object")
	e.warning(warnCommandRejected, cmdRedownload, "3EB0GOLDENphoto", "download state is \"ok\"")
	e.warning(warnCommandFailed, cmdPairCode, "", "phone number too short")
	// media events exactly as the lifecycle above emitted them (ok, retrying, failed)
	lines.Write(lifecycle.out.buf.Bytes())
	files["events.jsonl"] = lines.Bytes()
	if n := len(lifecycle.out.ofType(t, "media")); n != 3 {
		t.Fatalf("lifecycle emitted %d media events; want 3", n)
	}

	for name, data := range files {
		path := filepath.Join(dir, name)
		if *update {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, data, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s missing (go test -run TestGolden -update): %v", path, err)
		}
		if !bytes.Equal(want, data) {
			t.Errorf("%s differs from the helper's output (go test -run TestGolden -update)\nwant:\n%s\ngot:\n%s", name, want, data)
		}
	}
	// Every golden file on disk must still be produced (no stale files the contract test reads).
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if _, ok := files[e.Name()]; !ok {
			t.Errorf("stale golden file %s (not produced by this test)", e.Name())
		}
	}
}

func TestBuildMetaClassification(t *testing.T) {
	sha := bytes.Repeat([]byte{0xab}, 32)
	font := func(f waE2E.ExtendedTextMessage_FontType) *waE2E.ExtendedTextMessage_FontType { return f.Enum() }
	type want struct {
		kind, caption, unsupported, state, mime string
		width, height, seconds                  uint32
		ptt, gif                                bool
		text                                    *inboxText
	}
	str := func(s string) *string { return &s }
	u32 := func(v uint32) *uint32 { return &v }
	cases := []struct {
		name string
		msg  *waE2E.Message
		want want
	}{
		{"photo", goldenCases()["photo"], want{kind: kindPhoto, caption: "Hội An", state: dlPending, mime: "image/jpeg", width: 1080, height: 1350}},
		{"photo without size or mimetype", goldenCases()["photo-no-size"], want{kind: kindPhoto, state: dlPending, mime: "image/jpeg"}},
		{"video", goldenCases()["video"], want{kind: kindVideo, state: dlPending, mime: "video/mp4", width: 720, height: 1280, seconds: 4}},
		{"video with caption", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Caption: proto.String("Mekong"), FileSHA256: sha}},
			want{kind: kindVideo, caption: "Mekong", state: dlPending, mime: "video/mp4"}},
		{"gif", goldenCases()["gif"], want{kind: kindGIF, state: dlPending, mime: "video/mp4", seconds: 2, gif: true}},
		{"voice", goldenCases()["voice"], want{kind: kindVoice, state: dlPending, mime: "audio/ogg; codecs=opus", seconds: 3, ptt: true}},
		{"audio (not ptt)", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{FileSHA256: sha, Mimetype: proto.String("audio/mp4")}},
			want{kind: kindVoice, state: dlPending, mime: "audio/mp4"}},
		{"text with font and colours", goldenCases()["text"], want{kind: kindText, state: dlNotApplicable,
			text: &inboxText{Body: "Xin chào!", BgArgb: u32(0xffc1a03f), TextArgb: u32(0xffffffff), Font: str("CALISTOGA_REGULAR")}}},
		{"text with an unknown font number", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String("?"), Font: waE2E.ExtendedTextMessage_FontType(4).Enum()}},
			want{kind: kindText, state: dlNotApplicable, text: &inboxText{Body: "?"}}},
		{"text without style", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("plain")}},
			want{kind: kindText, state: dlNotApplicable, text: &inboxText{Body: "plain"}}},
		{"transparent background is kept", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String("t"), BackgroundArgb: proto.Uint32(0), Font: font(waE2E.ExtendedTextMessage_SYSTEM)}},
			want{kind: kindText, state: dlNotApplicable, text: &inboxText{Body: "t", BgArgb: u32(0), Font: str("SYSTEM")}}},
		{"conversation", goldenCases()["conversation"], want{kind: kindText, state: dlNotApplicable, text: &inboxText{Body: "plain"}}},
		{"poll", goldenCases()["unsupported"], want{kind: kindUnsupported, state: dlNotApplicable, unsupported: "pollCreationMessageV3"}},
		{"location", &waE2E.Message{LocationMessage: &waE2E.LocationMessage{DegreesLatitude: proto.Float64(16)}},
			want{kind: kindUnsupported, state: dlNotApplicable, unsupported: "locationMessage"}},
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{FileSHA256: sha}},
			want{kind: kindUnsupported, state: dlNotApplicable, unsupported: "stickerMessage"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := buildMeta(statusInfo("X1", false), tc.msg, nil, sourceLive, goldenNow, travelerPN, "")
			if err != nil {
				t.Fatal(err)
			}
			w := tc.want
			if m.Kind != w.kind || m.Caption != w.caption || m.UnsupportedType != w.unsupported || m.Download.State != w.state {
				t.Fatalf("meta = %+v", m)
			}
			if isMediaKind(w.kind) {
				md := m.Media
				if md == nil || md.Mimetype != w.mime || md.Width != w.width || md.Height != w.height || md.Seconds != w.seconds ||
					(md.PTT != nil && *md.PTT) != w.ptt || (md.GifPlayback != nil && *md.GifPlayback) != w.gif || md.FileSha256B64 == "" {
					t.Fatalf("media = %+v", md)
				}
				if m.Text != nil {
					t.Fatal("media kinds carry no text")
				}
			} else if m.Media != nil {
				t.Fatal("non-media kinds carry no media")
			}
			if w.text != nil {
				got, _ := encodeJSONFile(m.Text)
				exp, _ := encodeJSONFile(w.text)
				if !bytes.Equal(got, exp) {
					t.Fatalf("text = %s; want %s", got, exp)
				}
			} else if m.Text != nil {
				t.Fatalf("unexpected text %+v", m.Text)
			}
			if m.RawProtoB64 == "" || m.Schema != 1 || m.Source != sourceLive {
				t.Fatalf("meta = %+v", m)
			}
		})
	}
}

func TestEveryD10FontMaps(t *testing.T) {
	want := []string{"SYSTEM", "SYSTEM_TEXT", "FB_SCRIPT", "SYSTEM_BOLD", "MORNINGBREEZE_REGULAR", "CALISTOGA_REGULAR", "EXO2_EXTRABOLD", "COURIERPRIME_BOLD"}
	numbers := []int32{0, 1, 2, 6, 7, 8, 9, 10} // FONT_TYPE_NUMBERS in wa.ts
	for i, name := range want {
		ft := waE2E.ExtendedTextMessage_FontType(numbers[i])
		msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("x"), Font: ft.Enum()}}
		m, _ := buildMeta(statusInfo("F1", false), msg, nil, sourceLive, goldenNow, travelerPN, "")
		if m.Text.Font == nil || *m.Text.Font != name || ft.String() != name {
			t.Errorf("font %d: %v (proto name %s); want %s", numbers[i], m.Text.Font, ft.String(), name)
		}
	}
}

func TestBuildMetaSenderAndTimestamps(t *testing.T) {
	photo := goldenCases()["photo"]
	p, _ := buildMeta(statusInfo("X3", false), photo, nil, sourceLive, goldenNow, travelerPN, "")
	if p.Sender.JID != travelerLID+"@lid" || p.Sender.PN != travelerPN || p.Sender.LID != travelerLID || p.Sender.PushName != "Reisende" {
		t.Errorf("sender = %+v", p.Sender)
	}
	if p.AddressingMode != "lid" || p.StanzaTag != "status" || p.Timestamp != "2026-11-15T02:12:00Z" || p.ReceivedAt != "2026-11-15T02:12:03.000Z" {
		t.Errorf("meta = %+v", p)
	}
	// LID-only stanza: the PN comes from the configuration, the LID from the stanza.
	c, _ := buildMeta(statusInfo("X4", true), photo, nil, sourceLive, goldenNow, travelerPN, "")
	if c.Sender.PN != travelerPN || c.Sender.LID != travelerLID {
		t.Errorf("lid-only sender = %+v", c.Sender)
	}
	// PN-addressed stanza with a device part: jid is non-AD.
	info := statusInfo("X5", true)
	info.Sender = types.JID{User: travelerPN, Device: 3, Server: types.DefaultUserServer}
	info.AddressingMode = types.AddressingModePN
	pn, _ := buildMeta(info, photo, nil, sourceLive, goldenNow, travelerPN, travelerLID)
	if pn.Sender.JID != travelerPN+"@s.whatsapp.net" || pn.Sender.LID != travelerLID || pn.AddressingMode != "pn" {
		t.Errorf("pn sender = %+v", pn)
	}
	// A missing timestamp never becomes year 0001.
	info.Timestamp = time.Time{}
	z, _ := buildMeta(info, photo, nil, sourceLive, goldenNow, travelerPN, "")
	if z.Timestamp != "2026-11-15T02:12:03Z" {
		t.Errorf("zero timestamp -> %q", z.Timestamp)
	}
	if _, err := buildMeta(info, nil, nil, sourceLive, goldenNow, travelerPN, ""); err == nil {
		t.Error("nil message must fail")
	}
}

func TestDownloadableOfUnwrapsAndKeepsKeys(t *testing.T) {
	inner := mediaStatus(kindVideo, "W1")
	// whatsmeow's UnwrapRaw order: deviceSent > ephemeral > viewOnce(V2) > …
	wrapped := &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
		ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: inner}}}}
	info := statusInfo("W1", false)
	unwrapped := (&events.Message{RawMessage: wrapped}).UnwrapRaw().Message
	meta, err := buildMeta(info, unwrapped, wrapped, sourceLive, goldenNow, travelerPN, "")
	if err != nil || meta.Kind != kindVideo {
		t.Fatalf("meta %+v %v", meta, err)
	}
	dm, err := downloadableOf(meta)
	if err != nil {
		t.Fatal(err)
	}
	if dm.GetDirectPath() != "/v/t62/W1" || !bytes.Equal(dm.GetMediaKey(), testMediaKey) {
		t.Fatalf("downloadable = %v", dm)
	}
	moved := withDirectPath(dm, "/v/new")
	if moved.GetDirectPath() != "/v/new" || dm.GetDirectPath() != "/v/t62/W1" {
		t.Fatal("withDirectPath must copy, not mutate")
	}
	meta.Kind = kindPhoto
	if _, err := downloadableOf(meta); err == nil {
		t.Fatal("kind/proto mismatch must fail")
	}
	meta.RawProtoB64 = ""
	if _, err := downloadableOf(meta); err == nil {
		t.Fatal("missing raw proto must fail")
	}
}

func TestMediaExt(t *testing.T) {
	for _, tc := range []struct{ kind, mime, want string }{
		{kindPhoto, "image/jpeg", "jpg"}, {kindPhoto, "image/webp", "webp"}, {kindPhoto, "", "jpg"},
		{kindVideo, "video/mp4", "mp4"}, {kindGIF, "video/mp4", "mp4"}, {kindVideo, "video/quicktime", "mov"},
		{kindVoice, "audio/ogg; codecs=opus", "ogg"}, {kindVoice, "AUDIO/MP4", "m4a"}, {kindVoice, "weird/thing", "ogg"},
		{kindVideo, "", "mp4"},
	} {
		got := mediaExt(tc.kind, tc.mime)
		if got != tc.want || !regexp.MustCompile(`^[a-z0-9]{1,8}$`).MatchString(got) {
			t.Errorf("mediaExt(%s, %q) = %q; want %q", tc.kind, tc.mime, got, tc.want)
		}
	}
}

func TestUpdateMetaRoundTripsEveryField(t *testing.T) {
	inbox := t.TempDir()
	for name, msg := range goldenCases() {
		meta, _ := buildMeta(statusInfo("RT"+name, false), msg, msg, sourceLive, goldenNow, travelerPN, travelerLID)
		if _, err := persistMeta(inbox, meta); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(metaPath(inbox, meta.MsgID))
		if _, err := updateMeta(inbox, meta.MsgID, func(*inboxMeta) error { return nil }); err != nil {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(metaPath(inbox, meta.MsgID))
		if !bytes.Equal(before, after) {
			t.Errorf("%s: a no-op update changed meta.json\n%s\n%s", name, before, after)
		}
	}
	if _, err := readMeta(inbox, "../etc"); err == nil {
		t.Fatal("invalid ids must be rejected")
	}
}

func TestMsgIDMatchesTheContract(t *testing.T) {
	for id, ok := range map[string]bool{
		"3EB0C767D26A1D8B7A3B": true, "AC2F9A": true, "a_b-c": true,
		"_revokes": false, "-x": false, "../x": false, "": false, "a/b": false,
	} {
		if validMsgID(id) != ok {
			t.Errorf("validMsgID(%q) = %v", id, !ok)
		}
	}
}

func TestPersistMetaKeepsAnExistingFile(t *testing.T) {
	inbox := t.TempDir()
	meta, _ := buildMeta(statusInfo("3EB0KEEP", false), goldenCases()["photo"], nil, "live", goldenNow, travelerPN, "")
	if created, err := persistMeta(inbox, meta); err != nil || !created {
		t.Fatalf("first write: %v %v", created, err)
	}
	meta.Caption = "changed"
	if created, err := persistMeta(inbox, meta); err != nil || created {
		t.Fatalf("second write must keep the file: %v %v", created, err)
	}
	data, _ := os.ReadFile(filepath.Join(inbox, "3EB0KEEP", inboxMetaFile))
	if bytes.Contains(data, []byte("changed")) {
		t.Fatal("meta.json was overwritten")
	}
	if err := persistRevoke(inbox, revokeRecord{Schema: 1, MsgID: "3EB0KEEP", At: isoUTC(goldenNow)}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(inbox, inboxRevokesDir, "3EB0KEEP.json")); err != nil {
		t.Fatal(err)
	}
}
