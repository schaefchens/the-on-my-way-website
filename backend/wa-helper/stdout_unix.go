//go:build darwin || linux

package main

import (
	"os"
	"syscall"
)

// protocolStdout returns the file the protocol events are written to: a private duplicate of
// fd 1. fd 1 itself is then pointed at stderr, so stray writes to os.Stdout (by any library)
// land in the log instead of corrupting the JSON-lines channel (see stdio.go).
//
// A side effect: a broken protocol pipe (Node went away) now makes writes fail with EPIPE
// instead of killing the process with SIGPIPE (Go only does that for fds 1 and 2); the emitter
// reports the first failure (emitter.setOnFail) and the helper shuts down cleanly.
func protocolStdout() (*os.File, error) {
	fd, err := syscall.Dup(1)
	if err != nil {
		return nil, err
	}
	syscall.CloseOnExec(fd)
	if err := redirectFD(2, 1); err != nil {
		_ = syscall.Close(fd)
		return nil, err
	}
	return os.NewFile(uintptr(fd), "protocol-stdout"), nil
}
