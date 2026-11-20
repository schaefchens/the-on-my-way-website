package main

import "syscall"

// redirectFD makes newfd refer to the same open file as oldfd (dup2 does not exist on
// linux/arm64; dup3 with flags 0 is equivalent for oldfd != newfd).
func redirectFD(oldfd, newfd int) error { return syscall.Dup3(oldfd, newfd, 0) }
