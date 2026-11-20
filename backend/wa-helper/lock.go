package main

// Single-instance lock: at most one wa-helper per data directory.
//
// Two helpers on the same DATA_DIR (for example the one the Docker backend supervises and a
// manual Phase-0 run) would share one WhatsApp session: each connect makes WhatsApp drop the
// other with stream_replaced, so they would keep replacing each other every cooldown, and both
// would write the same inbox. Before the session store is opened, the helper therefore takes an
// exclusive, non-blocking flock(2) on DATA_DIR/wa/helper.lock (lock_unix.go). A second helper
// fails with errInstanceLocked and exits 2 (invalid configuration) before `ready`, so the Node
// supervisor does not restart it (wa.ts "Helper exit codes"). It never opens session.db or the
// inbox.
//
// The lock belongs to the open file, not to the file's existence: the kernel releases it when
// the process exits or crashes (even on SIGKILL), so there is never a stale lock to clean up.
// The file itself is never deleted, not even on a clean exit: deleting it while another helper
// waits to open it would let two processes lock two different inodes. It stays empty.

import (
	"errors"
	"fmt"
	"path/filepath"
)

// lockFile is the lock's name inside DATA_DIR/wa (next to session.db).
const lockFile = "helper.lock"

var (
	// errInstanceLocked matches (errors.Is) every lockedError.
	errInstanceLocked = errors.New("data directory locked by another wa-helper")
	// errLockUnsupported: the data directory's file system has no flock (e.g. some network
	// mounts). Also a configuration problem: a restart cannot fix it, moving DATA_DIR can.
	errLockUnsupported = errors.New("the file system does not support file locks")
)

// lockedError reports that another process holds DATA_DIR/wa/helper.lock.
type lockedError struct{ dataDir string }

func (e *lockedError) Error() string {
	return fmt.Sprintf("another wa-helper is using %s (Docker and a manual run?)", e.dataDir)
}

func (e *lockedError) Is(target error) bool { return target == errInstanceLocked }

// instanceLock is a held single-instance lock. The *os.File inside must stay reachable while
// the lock is needed: a garbage-collected file is closed by its finalizer, which releases the
// lock. Callers keep it alive with `defer lock.release()`.
type instanceLock interface {
	release() error
}

// displayDir is the data directory as shown in the lock error: absolute when possible, so the
// operator can tell which of two runs (container path vs. host path) is meant.
func displayDir(dataDir string) string {
	if abs, err := filepath.Abs(dataDir); err == nil {
		return abs
	}
	return dataDir
}
