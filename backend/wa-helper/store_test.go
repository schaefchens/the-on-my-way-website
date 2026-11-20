package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// TestSessionStoreModernc proves that whatsmeow's sqlstore (schema upgrade, device row, LID map,
// decrypted-event buffer transactions, foreign-key cascades) works on the pure-Go modernc driver
// with the DSN from sessionDSN. Purely local: no network.
func TestSessionStoreModernc(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "wa", "session.db")

	container, err := openSessionStore(ctx, path, nil)
	if err != nil {
		t.Fatalf("sqlstore.New on modernc failed: %v", err)
	}
	if st, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if st.Mode().Perm() != 0o600 {
		t.Fatalf("session.db mode = %v; want 0600", st.Mode().Perm())
	}

	dev, err := container.GetFirstDevice(ctx)
	if err != nil {
		t.Fatalf("GetFirstDevice: %v", err)
	}
	if dev.ID != nil {
		t.Fatalf("fresh store returned a paired device")
	}
	// No network involved: NewClient + GetQRChannel only register handlers.
	cli := whatsmeow.NewClient(dev, nil)
	if _, err := cli.GetQRChannel(ctx); err != nil {
		t.Fatalf("GetQRChannel on unpaired device: %v", err)
	}

	// Simulate what pairing persists (fake identity data; never sent anywhere).
	jid := types.NewADJID("491700000001", 0, 7)
	dev.ID = &jid
	dev.LID = types.NewJID("123456789012345", types.HiddenUserServer)
	dev.Account = &waAdv.ADVSignedDeviceIdentity{
		Details: []byte{1}, AccountSignatureKey: make([]byte, 32), AccountSignature: make([]byte, 64), DeviceSignature: make([]byte, 64),
	}
	if err := dev.Save(ctx); err != nil {
		t.Fatalf("PutDevice: %v", err)
	}

	// LID <-> PN map (container-level, works before pairing as well).
	lid := types.NewJID("987654321098765", types.HiddenUserServer)
	pn := types.NewJID("491700000002", types.DefaultUserServer)
	if err := container.LIDMap.PutLIDMapping(ctx, lid, pn); err != nil {
		t.Fatalf("PutLIDMapping: %v", err)
	}
	if got, err := container.LIDMap.GetPNForLID(ctx, lid); err != nil || got != pn {
		t.Fatalf("GetPNForLID = %v, %v; want %v", got, err, pn)
	}

	// Decrypted-event buffer: insert inside a transaction (as whatsmeow's bufferedDecrypt does), then clear.
	var hash [32]byte
	hash[0] = 0xAB
	err = dev.EventBuffer.DoDecryptionTxn(ctx, func(ctx context.Context) error {
		return dev.EventBuffer.PutBufferedEvent(ctx, hash, []byte("plaintext"), time.Now())
	})
	if err != nil {
		t.Fatalf("DoDecryptionTxn/PutBufferedEvent: %v", err)
	}
	buf, err := dev.EventBuffer.GetBufferedEvent(ctx, hash)
	if err != nil || buf == nil || string(buf.Plaintext) != "plaintext" {
		t.Fatalf("GetBufferedEvent = %+v, %v", buf, err)
	}
	if err := dev.EventBuffer.ClearBufferedEventPlaintext(ctx, hash); err != nil {
		t.Fatalf("ClearBufferedEventPlaintext: %v", err)
	}
	if err := container.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Reopen: upgrade must be idempotent and the device must come back.
	container, err = openSessionStore(ctx, path, nil)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer container.Close()
	dev2, err := container.GetFirstDevice(ctx)
	if err != nil || dev2.ID == nil || *dev2.ID != jid || dev2.LID != dev.LID {
		t.Fatalf("reloaded device = %+v, %v", dev2, err)
	}
	buf, err = dev2.EventBuffer.GetBufferedEvent(ctx, hash)
	if err != nil || buf == nil || buf.Plaintext != nil {
		t.Fatalf("buffered hash should remain with cleared plaintext, got %+v, %v", buf, err)
	}

	// Pragmas are really applied: WAL persisted in the file, foreign keys cascade on device delete.
	dsn, _ := sessionDSN(path)
	db, err := sql.Open(sqliteDriver, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var mode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v; want wal", mode, err)
	}
	if err := dev2.Delete(ctx); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM whatsmeow_event_buffer").Scan(&n); err != nil || n != 0 {
		t.Fatalf("event buffer rows after device delete = %d, %v; want 0 (FK cascade)", n, err)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inbox", "ABC123", "meta.json")
	if err := writeFileAtomic(path, []byte(`{"msgId":"ABC123"}`)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != `{"msgId":"ABC123"}` {
		t.Fatalf("got %q, %v", data, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestMkdirAllDurable(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "inbox", "_revokes")
	if err := mkdirAllDurable(dir); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir = %v, %v", fi, err)
	}
	if err := mkdirAllDurable(dir); err != nil { // exists: no-op
		t.Fatal(err)
	}
	file := filepath.Join(root, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := mkdirAllDurable(filepath.Join(file, "sub")); err == nil {
		t.Fatal("a file in the way must fail")
	}
	if err := mkdirAllDurable(file); err == nil {
		t.Fatal("an existing file is not a directory")
	}
}

func TestHasContent(t *testing.T) {
	skdmOnly := &waE2E.Message{
		SenderKeyDistributionMessage: &waE2E.SenderKeyDistributionMessage{GroupID: proto.String("status@broadcast")},
		MessageContextInfo:           &waE2E.MessageContextInfo{},
	}
	text := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("hi")}}
	if hasContent(nil) || hasContent(skdmOnly) || !hasContent(text) {
		t.Fatal("hasContent misclassified")
	}
	if skdmOnly.SenderKeyDistributionMessage == nil {
		t.Fatal("hasContent mutated its input")
	}
}

func TestSessionDSN(t *testing.T) {
	dsn, err := sessionDSN("/data/wa/session.db")
	if err != nil {
		t.Fatal(err)
	}
	want := "file:///data/wa/session.db?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=busy_timeout(5000)&_txlock=immediate"
	if dsn != want {
		t.Fatalf("dsn = %s", dsn)
	}
}
