package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/rs/zerolog"
	signalLogger "go.mau.fi/libsignal/logger"
)

// stdioChildEnv makes the test binary act as a tiny helper process (see TestStdoutCarriesOnlyEvents).
const stdioChildEnv = "WA_HELPER_STDIO_CHILD"

// TestStdoutCarriesOnlyEvents runs the test binary as a child process with real pipes: after
// isolating the protocol channel and routing libsignal's logger, stray writes to os.Stdout and
// libsignal's own log lines (its default logger prints them to stdout) must end up on stderr,
// and stdout must carry exactly the emitted events.
func TestStdoutCarriesOnlyEvents(t *testing.T) {
	if os.Getenv(stdioChildEnv) == "1" {
		stdioChild()
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestStdoutCarriesOnlyEvents$", "-test.count=1")
	cmd.Env = append(os.Environ(), stdioChildEnv+"=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("child: %v\nstderr:\n%s", err, stderr.String())
	}
	lines := strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("stdout must carry exactly the 2 events, got:\n%s", stdout.String())
	}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil || m["type"] == nil {
			t.Fatalf("stdout line is not an event: %q", l)
		}
	}
	errOut := stderr.String()
	for _, want := range []string{"stray fmt.Println", "libsignal error line", "libsignal warning line"} {
		if !strings.Contains(errOut, want) {
			t.Errorf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	if strings.Contains(errOut, "SECRET-KEY-MATERIAL") || strings.Contains(stdout.String(), "SECRET-KEY-MATERIAL") {
		t.Error("libsignal debug output (key material) must be dropped")
	}
}

func stdioChild() {
	protocol, err := protocolStdout()
	if err != nil {
		fmt.Fprintln(os.Stderr, "protocolStdout:", err)
		os.Exit(3)
	}
	setupSignalLog(zerolog.New(os.Stderr))
	out := newEmitter(protocol)
	out.emit("ready", map[string]any{"version": "test"})
	fmt.Println("stray fmt.Println") // e.g. a debug print in a dependency
	signalLogger.Error("libsignal error line")
	signalLogger.Warning("libsignal warning line")
	signalLogger.Debug("SECRET-KEY-MATERIAL")
	out.emit("stats", map[string]any{"counters": map[string]int64{}})
	os.Exit(0)
}

// failingWriter fails every write (stdout of a parent that went away: EPIPE).
type failingWriter struct{ writes atomic.Int32 }

func (w *failingWriter) Write([]byte) (int, error) {
	w.writes.Add(1)
	return 0, errors.New("broken pipe")
}

func TestEmitterReportsABrokenStdoutOnce(t *testing.T) {
	w := &failingWriter{}
	e := newEmitter(w)
	var calls atomic.Int32
	e.setOnFail(func(error) { calls.Add(1) })
	e.emit("stats", map[string]any{"counters": map[string]int64{}})
	e.emit("stats", map[string]any{"counters": map[string]int64{}})
	// json.Encoder keeps the first write error: later events are not written at all.
	if calls.Load() != 1 || w.writes.Load() != 1 {
		t.Fatalf("onFail calls = %d, writes = %d; want 1, 1", calls.Load(), w.writes.Load())
	}
}
