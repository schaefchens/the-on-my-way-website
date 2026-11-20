//go:build darwin || linux

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// flock is syscall.Flock (a var so tests can simulate EINTR and file systems without locks).
var flock = syscall.Flock

// fileLock holds DATA_DIR/wa/helper.lock open with an exclusive flock(2).
type fileLock struct{ f *os.File }

// release closes the descriptor, which releases the lock. The file itself stays (lock.go).
func (l *fileLock) release() error { return l.f.Close() }

// acquireInstanceLock takes the single-instance lock of dataDir without blocking (lock.go).
// Errors: errInstanceLocked (another process holds it) and errLockUnsupported (the file system
// has no flock) both mean "exit 2"; any other error (e.g. permission denied) is fatal.
func acquireInstanceLock(dataDir string) (instanceLock, error) {
	dir := filepath.Join(dataDir, "wa")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, lockFile)
	// O_CLOEXEC is implied by os.OpenFile: no child process can inherit (and keep) the lock.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockExclusive(f); err != nil {
		_ = f.Close()
		switch {
		case errors.Is(err, syscall.EWOULDBLOCK):
			return nil, &lockedError{dataDir: displayDir(dataDir)}
		case errors.Is(err, syscall.ENOLCK), errors.Is(err, syscall.ENOTSUP),
			errors.Is(err, syscall.EOPNOTSUPP), errors.Is(err, syscall.ENOSYS):
			return nil, fmt.Errorf("cannot lock %s: %w (%w); put DATA_DIR on a local file system", path, errLockUnsupported, err)
		default:
			return nil, fmt.Errorf("lock %s: %w", path, err)
		}
	}
	return &fileLock{f: f}, nil
}

// lockExclusive takes an exclusive non-blocking flock on f, retrying when a signal interrupts
// the call. SyscallConn (not f.Fd) leaves the file's blocking mode alone.
func lockExclusive(f *os.File) error {
	raw, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var lockErr error
	if err := raw.Control(func(fd uintptr) {
		for {
			lockErr = flock(int(fd), syscall.LOCK_EX|syscall.LOCK_NB)
			if !errors.Is(lockErr, syscall.EINTR) {
				return
			}
		}
	}); err != nil {
		return err
	}
	return lockErr
}
