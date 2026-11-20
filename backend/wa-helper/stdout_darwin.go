package main

import "syscall"

// redirectFD makes newfd refer to the same open file as oldfd.
func redirectFD(oldfd, newfd int) error { return syscall.Dup2(oldfd, newfd) }
