//go:build !darwin && !linux

package main

import "os"

// protocolStdout: on platforms without the fd redirect (not a supported target) the events go
// to os.Stdout directly; setupSignalLog still keeps libsignal's output off it.
func protocolStdout() (*os.File, error) { return os.Stdout, nil }
