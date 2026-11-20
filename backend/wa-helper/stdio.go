package main

// Protocol-channel hygiene: stdout carries WaEvent JSON lines and nothing else (wa.ts).
//
// Not every dependency honours that on its own. go.mau.fi/libsignal has a package-level logger
// that, unless configured, prints its Info/Warning/Error lines to stdout with fmt.Println. It does
// so on ordinary decryption paths (SessionCipher.DecryptWithRecord logs a warning whenever the
// current session state fails and older states are tried, "Unable to verify ciphertext mac"
// etc.), and whatsmeow never configures it. Two measures keep the channel clean:
//
//  1. setupSignalLog routes libsignal's logger to zerolog on stderr (its debug output, which
//     contains key material, is dropped);
//  2. protocolStdout (stdout_unix.go) gives the emitter a private duplicate of fd 1 and points
//     fd 1 itself at stderr, so whatever else writes to os.Stdout ends up in the log.

import (
	"github.com/rs/zerolog"
	signalLogger "go.mau.fi/libsignal/logger"
)

// signalLog adapts zerolog to libsignal's logger.Loggable.
type signalLog struct{ log zerolog.Logger }

// Debug is dropped: libsignal logs cipher keys and session records at debug level.
func (signalLog) Debug(string, string) {}

func (s signalLog) Info(caller, msg string) { s.log.Debug().Str("caller", caller).Msg(msg) }

// Warning and Error are logged as warnings: libsignal reports recoverable steps (e.g. a failed
// attempt with the current session state before an older one succeeds); whatsmeow logs the
// final outcome of a decryption itself.
func (s signalLog) Warning(caller, msg string) { s.log.Warn().Str("caller", caller).Msg(msg) }

func (s signalLog) Error(caller, msg string) { s.log.Warn().Str("caller", caller).Msg(msg) }

func (signalLog) Configure(string) {}

// setupSignalLog must run before the WhatsApp client decrypts anything (libsignal's logger is a
// process-wide global without synchronisation).
func setupSignalLog(log zerolog.Logger) {
	var l signalLogger.Loggable = signalLog{log: log.With().Str("component", "libsignal").Logger()}
	signalLogger.Setup(&l)
}
