//go:build !darwin && !linux

package main

// noLock: platforms other than darwin and linux are not supported targets (README "Build and
// test"); they compile, but run without the single-instance lock.
type noLock struct{}

func (noLock) release() error { return nil }

func acquireInstanceLock(string) (instanceLock, error) { return noLock{}, nil }
