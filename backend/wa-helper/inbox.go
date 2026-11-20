package main

// D9 inbox files, exactly as specified by packages/contracts/src/wa.ts (the only authority for
// the helper protocol). testdata/golden/ holds files written by these functions;
// packages/contracts/test/wa-golden.test.ts validates them with the zod schemas.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

const (
	inboxMetaFile   = "meta.json"
	inboxRevokesDir = "_revokes"
	// Prefixes of our temporary files inside inbox/<msgId>/ (never read by Node).
	tmpPrefixMeta     = ".tmp-"
	tmpPrefixDownload = ".dl-"
)

// Download states (contract DownloadState).
const (
	dlPending       = "pending"
	dlRetrying      = "retrying"
	dlOK            = "ok"
	dlFailed        = "failed"
	dlNotApplicable = "not_applicable"
)

// Download failure reasons (contract DownloadFailureReason).
const (
	reasonExpired      = "expired"
	reasonNotOnPhone   = "not_on_phone"
	reasonHashMismatch = "hash_mismatch"
	reasonNetwork      = "network"
	reasonTimeout      = "timeout"
	reasonUnknown      = "unknown"
)

// Capture kinds (contract CaptureKind).
const (
	kindPhoto       = "photo"
	kindVideo       = "video"
	kindGIF         = "gif"
	kindVoice       = "voice"
	kindText        = "text"
	kindUnsupported = "unsupported"
)

func isMediaKind(kind string) bool {
	return kind == kindPhoto || kind == kindVideo || kind == kindGIF || kind == kindVoice
}

// msgIDPattern is the contract's MsgId: path-safe and never starting with "_" (so no collision
// with "_revokes").
var msgIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func validMsgID(id string) bool { return msgIDPattern.MatchString(id) }

// fontNames: WAProto ExtendedTextMessage.FontType values that D10 knows; others become null.
var fontNames = map[waE2E.ExtendedTextMessage_FontType]string{
	waE2E.ExtendedTextMessage_SYSTEM:                "SYSTEM",
	waE2E.ExtendedTextMessage_SYSTEM_TEXT:           "SYSTEM_TEXT",
	waE2E.ExtendedTextMessage_FB_SCRIPT:             "FB_SCRIPT",
	waE2E.ExtendedTextMessage_SYSTEM_BOLD:           "SYSTEM_BOLD",
	waE2E.ExtendedTextMessage_MORNINGBREEZE_REGULAR: "MORNINGBREEZE_REGULAR",
	waE2E.ExtendedTextMessage_CALISTOGA_REGULAR:     "CALISTOGA_REGULAR",
	waE2E.ExtendedTextMessage_EXO2_EXTRABOLD:        "EXO2_EXTRABOLD",
	waE2E.ExtendedTextMessage_COURIERPRIME_BOLD:     "COURIERPRIME_BOLD",
}

type inboxSender struct {
	PN       string `json:"pn,omitempty"`
	LID      string `json:"lid,omitempty"`
	JID      string `json:"jid,omitempty"`
	PushName string `json:"pushName,omitempty"`
}

// inboxText: colours are the raw ARGB uint32 values (null when WhatsApp sends none).
type inboxText struct {
	Body     string  `json:"body"`
	BgArgb   *uint32 `json:"bgArgb"`
	TextArgb *uint32 `json:"textArgb"`
	Font     *string `json:"font"`
}

type inboxMedia struct {
	Mimetype      string `json:"mimetype"`
	FileSha256B64 string `json:"fileSha256B64"`
	FileLength    uint64 `json:"fileLength"`
	Width         uint32 `json:"width,omitempty"`   // omitted when WhatsApp sends 0
	Height        uint32 `json:"height,omitempty"`  // omitted when WhatsApp sends 0
	Seconds       uint32 `json:"seconds,omitempty"` // omitted when WhatsApp sends 0
	PTT           *bool  `json:"ptt,omitempty"`
	GifPlayback   *bool  `json:"gifPlayback,omitempty"`
	WaveformB64   string `json:"waveformB64,omitempty"`
}

type inboxDownload struct {
	State            string `json:"state"` // pending|retrying|ok|failed|not_applicable
	File             string `json:"file,omitempty"`
	Sha256Hex        string `json:"sha256Hex,omitempty"`
	Attempts         int    `json:"attempts"`
	Reason           string `json:"reason,omitempty"`
	Permanent        *bool  `json:"permanent,omitempty"`
	RetryRequestedAt string `json:"retryRequestedAt,omitempty"`
	Error            string `json:"error,omitempty"`
}

// terminal mirrors isTerminalDownload in wa.ts: the download can no longer change.
func (d inboxDownload) terminal() bool {
	return d.State == dlOK || d.State == dlNotApplicable || (d.State == dlFailed && d.Permanent != nil && *d.Permanent)
}

// inboxMeta is inbox/<msgId>/meta.json (contract InboxMeta, schema 1).
type inboxMeta struct {
	Schema          int           `json:"schema"`
	MsgID           string        `json:"msgId"`
	Source          string        `json:"source"` // live|history
	ReceivedAt      string        `json:"receivedAt"`
	Sender          inboxSender   `json:"sender"`
	Timestamp       string        `json:"timestamp"`
	Kind            string        `json:"kind"` // photo|video|gif|voice|text|unsupported
	Caption         string        `json:"caption,omitempty"`
	Text            *inboxText    `json:"text,omitempty"`
	Media           *inboxMedia   `json:"media,omitempty"`
	Download        inboxDownload `json:"download"`
	UnsupportedType string        `json:"unsupportedType,omitempty"`
	RawProtoB64     string        `json:"rawProtoB64"`
	AddressingMode  string        `json:"addressingMode,omitempty"`
	StanzaTag       string        `json:"stanzaTag,omitempty"`
}

// revokeRecord is inbox/_revokes/<msgId>.json; MsgID is the REVOKED status.
type revokeRecord struct {
	Schema int    `json:"schema"`
	MsgID  string `json:"msgId"`
	At     string `json:"at"`
}

func isoUTC(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func boolPtr(v bool) *bool { return &v }

// senderOf fills pn/lid/jid from the stanza; travelerPN/travelerLID complete what the stanza
// lacks (the sender was matched as the traveler before this is called).
func senderOf(info types.MessageInfo, travelerPN, travelerLID string) inboxSender {
	s := inboxSender{PushName: info.PushName}
	for _, jid := range []types.JID{info.Sender.ToNonAD(), info.SenderAlt.ToNonAD()} {
		switch jid.Server {
		case types.DefaultUserServer:
			s.PN = jid.User
		case types.HiddenUserServer:
			s.LID = jid.User
		}
	}
	if s.PN == "" {
		s.PN = travelerPN
	}
	if s.LID == "" {
		s.LID = travelerLID
	}
	if !info.Sender.IsEmpty() {
		s.JID = info.Sender.ToNonAD().String()
	}
	return s
}

// unsupportedFieldName returns the JSON name of the first populated content field, e.g.
// "pollCreationMessageV3".
func unsupportedFieldName(msg *waE2E.Message) string {
	name := "unknown"
	msg.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		switch fd.JSONName() {
		case "messageContextInfo", "senderKeyDistributionMessage":
			return true
		}
		name = fd.JSONName()
		return false
	})
	return name
}

func mimeOr(mime, fallback string) string {
	if mime == "" {
		return fallback
	}
	return mime
}

// hasContent reports whether msg carries anything besides key-distribution / context metadata.
func hasContent(msg *waE2E.Message) bool {
	if msg == nil {
		return false
	}
	c := proto.Clone(msg).(*waE2E.Message)
	c.SenderKeyDistributionMessage = nil
	c.MessageContextInfo = nil
	return proto.Size(c) > 0
}

// buildMeta classifies a status message into the contract's InboxMeta. msg is the unwrapped
// message (events.Message.Message), raw the original (events.Message.RawMessage, marshalled into
// rawProtoB64). Media downloads happen after the ack, so media kinds start "pending".
func buildMeta(info types.MessageInfo, msg, raw *waE2E.Message, source string, receivedAt time.Time, travelerPN, travelerLID string) (inboxMeta, error) {
	if msg == nil {
		return inboxMeta{}, errors.New("message without content")
	}
	if raw == nil {
		raw = msg
	}
	rawBytes, err := proto.Marshal(raw)
	if err != nil {
		return inboxMeta{}, err
	}
	ts := info.Timestamp
	if ts.IsZero() || ts.Unix() <= 0 {
		ts = receivedAt // WhatsApp always sends t; never write year 0001
	}
	m := inboxMeta{
		Schema:      1,
		MsgID:       info.ID,
		Source:      source,
		ReceivedAt:  isoUTC(receivedAt),
		Sender:      senderOf(info, travelerPN, travelerLID),
		Timestamp:   ts.UTC().Format(time.RFC3339),
		Download:    inboxDownload{State: dlNotApplicable},
		RawProtoB64: b64(rawBytes),
		StanzaTag:   info.StanzaTag,
	}
	if info.AddressingMode == types.AddressingModePN || info.AddressingMode == types.AddressingModeLID {
		m.AddressingMode = string(info.AddressingMode)
	}
	pending := inboxDownload{State: dlPending}

	switch {
	case msg.GetImageMessage() != nil:
		im := msg.GetImageMessage()
		m.Kind, m.Caption, m.Download = kindPhoto, im.GetCaption(), pending
		m.Media = &inboxMedia{
			Mimetype: mimeOr(im.GetMimetype(), "image/jpeg"), FileSha256B64: b64(im.GetFileSHA256()),
			FileLength: im.GetFileLength(), Width: im.GetWidth(), Height: im.GetHeight(),
		}
	case msg.GetVideoMessage() != nil:
		vm := msg.GetVideoMessage()
		m.Kind, m.Caption, m.Download = kindVideo, vm.GetCaption(), pending
		m.Media = &inboxMedia{
			Mimetype: mimeOr(vm.GetMimetype(), "video/mp4"), FileSha256B64: b64(vm.GetFileSHA256()),
			FileLength: vm.GetFileLength(), Width: vm.GetWidth(), Height: vm.GetHeight(), Seconds: vm.GetSeconds(),
		}
		if vm.GetGifPlayback() {
			m.Kind = kindGIF
			m.Media.GifPlayback = boolPtr(true)
		}
	case msg.GetAudioMessage() != nil:
		am := msg.GetAudioMessage()
		m.Kind, m.Download = kindVoice, pending
		m.Media = &inboxMedia{
			Mimetype: mimeOr(am.GetMimetype(), "audio/ogg; codecs=opus"), FileSha256B64: b64(am.GetFileSHA256()),
			FileLength: am.GetFileLength(), Seconds: am.GetSeconds(), PTT: boolPtr(am.GetPTT()),
		}
		if wf := am.GetWaveform(); len(wf) > 0 {
			m.Media.WaveformB64 = b64(wf)
		}
	case msg.GetExtendedTextMessage() != nil:
		et := msg.GetExtendedTextMessage()
		t := &inboxText{Body: et.GetText(), BgArgb: et.BackgroundArgb, TextArgb: et.TextArgb}
		if et.Font != nil {
			if name, ok := fontNames[et.GetFont()]; ok {
				t.Font = &name
			}
		}
		m.Kind, m.Text = kindText, t
	case msg.Conversation != nil:
		m.Kind, m.Text = kindText, &inboxText{Body: msg.GetConversation()}
	default:
		m.Kind, m.UnsupportedType = kindUnsupported, unsupportedFieldName(msg)
	}
	return m, nil
}

// mediaExt picks the file extension of original.<ext> from the mimetype (falling back by kind).
// The result always matches the contract's /^original\.[a-z0-9]{1,8}$/.
func mediaExt(kind, mimetype string) string {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(mimetype, ";", 2)[0]))
	switch base {
	case "image/jpeg", "image/jpg", "image/pjpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	case "image/gif":
		return "gif"
	case "image/heic":
		return "heic"
	case "video/mp4":
		return "mp4"
	case "video/3gpp":
		return "3gp"
	case "video/quicktime":
		return "mov"
	case "video/webm":
		return "webm"
	case "audio/ogg", "audio/opus":
		return "ogg"
	case "audio/mp4", "audio/m4a", "audio/x-m4a":
		return "m4a"
	case "audio/mpeg", "audio/mp3":
		return "mp3"
	case "audio/aac":
		return "aac"
	case "audio/amr":
		return "amr"
	}
	switch kind {
	case kindPhoto:
		return "jpg"
	case kindVoice:
		return "ogg"
	default:
		return "mp4"
	}
}

// downloadableOf decodes rawProtoB64 and returns the media sub-message for meta.Kind (with the
// media keys needed for download and media retry).
func downloadableOf(m inboxMeta) (whatsmeow.DownloadableMessage, error) {
	if m.RawProtoB64 == "" {
		return nil, errors.New("meta.json has no rawProtoB64")
	}
	raw, err := base64.StdEncoding.DecodeString(m.RawProtoB64)
	if err != nil {
		return nil, fmt.Errorf("rawProtoB64: %w", err)
	}
	var wrapped waE2E.Message
	if err := proto.Unmarshal(raw, &wrapped); err != nil {
		return nil, fmt.Errorf("rawProtoB64: %w", err)
	}
	msg := (&events.Message{RawMessage: &wrapped}).UnwrapRaw().Message
	var dm whatsmeow.DownloadableMessage
	switch m.Kind {
	case kindPhoto:
		if im := msg.GetImageMessage(); im != nil {
			dm = im
		}
	case kindVideo, kindGIF:
		if vm := msg.GetVideoMessage(); vm != nil {
			dm = vm
		}
	case kindVoice:
		if am := msg.GetAudioMessage(); am != nil {
			dm = am
		}
	}
	if dm == nil {
		return nil, fmt.Errorf("raw message has no %s media", m.Kind)
	}
	if len(dm.GetMediaKey()) == 0 {
		return nil, errors.New("media message has no mediaKey")
	}
	return dm, nil
}

// withDirectPath returns a copy of dm that downloads from directPath (from a media retry answer).
func withDirectPath(dm whatsmeow.DownloadableMessage, directPath string) whatsmeow.DownloadableMessage {
	switch v := dm.(type) {
	case *waE2E.ImageMessage:
		c := proto.Clone(v).(*waE2E.ImageMessage)
		c.DirectPath = proto.String(directPath)
		return c
	case *waE2E.VideoMessage:
		c := proto.Clone(v).(*waE2E.VideoMessage)
		c.DirectPath = proto.String(directPath)
		return c
	case *waE2E.AudioMessage:
		c := proto.Clone(v).(*waE2E.AudioMessage)
		c.DirectPath = proto.String(directPath)
		return c
	}
	return dm
}

// ---------------------------------------------------------------------------------------------
// Atomic files

// encodeJSONFile is the on-disk JSON format of inbox files: 2-space indent, trailing newline.
func encodeJSONFile(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil { // Encode appends '\n'
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeJSONAtomic(path string, v any) error {
	data, err := encodeJSONFile(v)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data)
}

// writeFileAtomic writes data to path via tmp file + fsync + rename + directory fsync. Missing
// directories are created durably (mkdirAllDurable), so a new inbox/<msgId>/ survives a crash
// right after the ack as well.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := mkdirAllDurable(dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, tmpPrefixMeta+"*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// mkdirAllDurable is os.MkdirAll(dir, 0o700) that also fsyncs the parent of every directory it
// creates. Without that, fsyncing a file and its own directory does not make the directory's
// entry in its parent durable: a crash could lose a freshly created inbox/<msgId>/ (and the
// meta.json inside) although the status was already acked.
func mkdirAllDurable(dir string) error {
	if fi, err := os.Stat(dir); err == nil {
		if fi.IsDir() {
			return nil
		}
		return &fs.PathError{Op: "mkdir", Path: dir, Err: syscall.ENOTDIR}
	}
	parent := filepath.Dir(dir)
	if parent != dir {
		if err := mkdirAllDurable(parent); err != nil {
			return err
		}
	}
	if err := os.Mkdir(dir, 0o700); err != nil && !errors.Is(err, fs.ErrExist) { // ErrExist: created concurrently
		return err
	}
	return syncDir(parent)
}

// metaMu serializes every create / read-modify-write of meta.json files in this process.
var metaMu sync.Mutex

func metaPath(inboxDir, msgID string) string {
	return filepath.Join(inboxDir, msgID, inboxMetaFile)
}

// persistMeta writes inbox/<msgId>/meta.json once; an existing file (redelivery, history
// duplicate, or a meta.json whose download state the helper already advanced) is kept.
func persistMeta(inboxDir string, m inboxMeta) (created bool, err error) {
	if !validMsgID(m.MsgID) {
		return false, fmt.Errorf("invalid msgId %q", m.MsgID)
	}
	metaMu.Lock()
	defer metaMu.Unlock()
	path := metaPath(inboxDir, m.MsgID)
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	return true, writeJSONAtomic(path, m)
}

func persistRevoke(inboxDir string, r revokeRecord) error {
	if !validMsgID(r.MsgID) {
		return fmt.Errorf("invalid msgId %q", r.MsgID)
	}
	return writeJSONAtomic(filepath.Join(inboxDir, inboxRevokesDir, r.MsgID+".json"), r)
}

// readMeta reads inbox/<msgId>/meta.json.
func readMeta(inboxDir, msgID string) (inboxMeta, error) {
	if !validMsgID(msgID) {
		return inboxMeta{}, fmt.Errorf("invalid msgId %q", msgID)
	}
	data, err := os.ReadFile(metaPath(inboxDir, msgID))
	if err != nil {
		return inboxMeta{}, err
	}
	var m inboxMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return inboxMeta{}, fmt.Errorf("%s: %w", metaPath(inboxDir, msgID), err)
	}
	if m.MsgID != msgID {
		return inboxMeta{}, fmt.Errorf("%s: msgId %q does not match its directory", metaPath(inboxDir, msgID), m.MsgID)
	}
	return m, nil
}

// updateMeta atomically rewrites meta.json with fn applied (read-modify-write under metaMu).
// fn returning an error leaves the file untouched.
func updateMeta(inboxDir, msgID string, fn func(*inboxMeta) error) (inboxMeta, error) {
	metaMu.Lock()
	defer metaMu.Unlock()
	m, err := readMeta(inboxDir, msgID)
	if err != nil {
		return inboxMeta{}, err
	}
	if err := fn(&m); err != nil {
		return inboxMeta{}, err
	}
	return m, writeJSONAtomic(metaPath(inboxDir, msgID), m)
}

// cleanTempFiles removes leftovers of interrupted atomic writes / downloads in dir.
func cleanTempFiles(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if n := e.Name(); strings.HasPrefix(n, tmpPrefixMeta) || strings.HasPrefix(n, tmpPrefixDownload) {
			_ = os.Remove(filepath.Join(dir, n))
		}
	}
}
