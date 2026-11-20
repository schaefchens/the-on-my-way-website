//go:build darwin || linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Child modes of the test binary for TestSecondHelperExitsTwoBeforeReady (see runLockChild).
const (
	lockChildEnv     = "WA_HELPER_LOCK_CHILD" // "helper": run main(); "hold": take the lock and wait
	lockChildDataDir = "WA_HELPER_LOCK_CHILD_DATA_DIR"
)

// lockedMessage is the expected lock error for an absolute dir (shown cleaned, like filepath.Abs
// does: TMPDIR may contain "..").
func lockedMessage(dir string) string {
	return fmt.Sprintf("another wa-helper is using %s (Docker and a manual run?)", filepath.Clean(dir))
}

// TestInstanceLockRejectsSecondHolder: a second lock attempt on the same data directory fails
// with the "another wa-helper" error until the first holder releases it.
func TestInstanceLockRejectsSecondHolder(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	path := filepath.Join(dir, "wa", lockFile)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("lock file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("lock file mode = %v, want 0600", info.Mode().Perm())
	}

	// flock locks belong to the open file description, so a second open in the same process
	// conflicts just like a second process would.
	second, err := acquireInstanceLock(dir)
	if second != nil || !errors.Is(err, errInstanceLocked) {
		t.Fatalf("second lock: got (%v, %v), want errInstanceLocked", second, err)
	}
	if got, want := err.Error(), lockedMessage(dir); got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
	if errors.Is(err, errLockUnsupported) {
		t.Error("a held lock must not be reported as unsupported")
	}

	if err := first.release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the lock file must stay after a release: %v", err)
	}
	third, err := acquireInstanceLock(dir)
	if err != nil {
		t.Fatalf("lock after release: %v", err)
	}
	_ = third.release()
}

// TestInstanceLockShowsAbsoluteDir: a relative data dir is shown absolute in the error, so the
// operator can tell which run is meant.
func TestInstanceLockShowsAbsoluteDir(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	first, err := acquireInstanceLock("state")
	if err != nil {
		t.Fatalf("first lock: %v", err)
	}
	defer func() { _ = first.release() }()
	_, err = acquireInstanceLock("state")
	cwd, _ := os.Getwd()
	if want := lockedMessage(filepath.Join(cwd, "state")); err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
}

func TestInstanceLockRetriesEINTRAndReportsUnsupportedFileSystems(t *testing.T) {
	orig := flock
	t.Cleanup(func() { flock = orig })

	calls := 0
	flock = func(fd int, how int) error {
		calls++
		if how != syscall.LOCK_EX|syscall.LOCK_NB {
			t.Errorf("flock how = %d, want LOCK_EX|LOCK_NB", how)
		}
		if calls < 3 {
			return syscall.EINTR
		}
		return orig(fd, how)
	}
	l, err := acquireInstanceLock(t.TempDir())
	if err != nil || calls != 3 {
		t.Fatalf("EINTR: err = %v after %d calls, want success after 3", err, calls)
	}
	_ = l.release()

	for _, errno := range []syscall.Errno{syscall.ENOLCK, syscall.ENOTSUP, syscall.EOPNOTSUPP, syscall.ENOSYS} {
		flock = func(int, int) error { return errno }
		_, err := acquireInstanceLock(t.TempDir())
		if !errors.Is(err, errLockUnsupported) || !errors.Is(err, errno) || errors.Is(err, errInstanceLocked) {
			t.Errorf("%v: err = %v, want errLockUnsupported wrapping it", errno, err)
		}
	}

	flock = func(int, int) error { return syscall.EBADF }
	_, err = acquireInstanceLock(t.TempDir())
	if err == nil || errors.Is(err, errLockUnsupported) || errors.Is(err, errInstanceLocked) {
		t.Errorf("EBADF: err = %v, want a plain (fatal) error", err)
	}
}

// TestSecondHelperExitsTwoBeforeReady runs the real main() in child processes: while another
// process holds DATA_DIR's lock, a helper prints the error, exits 2 and never emits `ready` nor
// opens session.db; once the holder is gone (even killed by SIGKILL), a helper starts normally.
func TestSecondHelperExitsTwoBeforeReady(t *testing.T) {
	if mode := os.Getenv(lockChildEnv); mode != "" {
		runLockChild(mode, os.Getenv(lockChildDataDir))
	}
	dir := t.TempDir()

	// Holder: another process with the lock, like a helper started by the Docker backend.
	holder := lockChild(t, "hold", dir)
	holderOut, err := holder.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	holder.Stderr = os.Stderr
	if err := holder.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = holder.Process.Kill(); _ = holder.Wait() })
	if line, err := bufio.NewReader(holderOut).ReadString('\n'); err != nil || line != "locked\n" {
		t.Fatalf("holder: %q, %v", line, err)
	}

	code, stdout, stderr := runHelperChild(t, dir)
	if code != exitConfig {
		t.Fatalf("exit code = %d, want %d\nstderr:\n%s", code, exitConfig, stderr)
	}
	if !strings.Contains(stderr, lockedMessage(dir)) {
		t.Errorf("stderr lacks %q:\n%s", lockedMessage(dir), stderr)
	}
	events := parseEvents(t, stdout)
	if len(events) != 1 || events[0]["type"] != "state" || events[0]["state"] != "error" ||
		events[0]["reason"] != "fatal" || events[0]["detail"] != lockedMessage(dir) {
		t.Errorf("stdout must carry only the state error event, got:\n%s", stdout)
	}
	if _, err := os.Stat(filepath.Join(dir, "wa", "session.db")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the second helper must not open session.db (stat: %v)", err)
	}

	// The holder crashes: the kernel releases its lock.
	if err := holder.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = holder.Wait()

	code, stdout, stderr = runHelperChild(t, dir)
	if code != exitOK {
		t.Fatalf("after the holder died: exit code = %d, want 0\nstderr:\n%s", code, stderr)
	}
	events = parseEvents(t, stdout)
	if len(events) != 1 || events[0]["type"] != "ready" {
		t.Errorf("want exactly the ready event, got:\n%s", stdout)
	}
	// A clean exit releases the lock as well: the next start succeeds too.
	if code, _, stderr = runHelperChild(t, dir); code != exitOK {
		t.Fatalf("after a clean exit: exit code = %d, want 0\nstderr:\n%s", code, stderr)
	}
}

// lockChild re-runs the test binary as a child in the given mode (see runLockChild). Without
// -test.paniconexit0 (only `go test` passes it), main() may exit 0 inside the child.
func lockChild(t *testing.T, mode, dataDir string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestSecondHelperExitsTwoBeforeReady$", "-test.count=1")
	cmd.Env = append(helperFreeEnv(), lockChildEnv+"="+mode, lockChildDataDir+"="+dataDir)
	return cmd
}

// helperFreeEnv is os.Environ() without the helper's own variables (config.go), so a developer's
// WA_MODE or TRAVELER_LID cannot change what the child helper does.
func helperFreeEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		switch name, _, _ := strings.Cut(kv, "="); name {
		case "DATA_DIR", "WA_MODE", "TRAVELER_PHONE", "TRAVELER_LID", "SEND_READ_RECEIPT", "LOG_LEVEL":
		default:
			env = append(env, kv)
		}
	}
	return env
}

// runHelperChild runs main() as a dry run (no network) on dataDir and returns its exit code.
func runHelperChild(t *testing.T, dataDir string) (code int, stdout, stderr string) {
	t.Helper()
	cmd := lockChild(t, "helper", dataDir)
	var out, errOut bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode(), out.String(), errOut.String()
	} else if err != nil {
		t.Fatalf("child: %v", err)
	}
	return 0, out.String(), errOut.String()
}

func parseEvents(t *testing.T, stdout string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimRight(stdout, "\n"), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("stdout line is not JSON: %q", line)
		}
		events = append(events, m)
	}
	return events
}

// runLockChild is the child side of TestSecondHelperExitsTwoBeforeReady. It never returns.
func runLockChild(mode, dataDir string) {
	switch mode {
	case "helper":
		os.Args = []string{"wa-helper", "-data-dir", dataDir, "-traveler-phone", "4915112345678",
			"-dry-run", "-stats-interval", "0", "-log-level", "warn"}
		main() // always exits
	case "hold":
		l, err := acquireInstanceLock(dataDir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "hold:", err)
			os.Exit(1)
		}
		fmt.Println("locked")
		time.Sleep(10 * time.Minute) // the parent kills it long before
		runtime.KeepAlive(l)
		fmt.Fprintln(os.Stderr, "hold: not killed in time")
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "lock child: unknown mode", mode)
	os.Exit(1)
}
