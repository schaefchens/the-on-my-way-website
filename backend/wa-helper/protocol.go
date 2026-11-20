package main

// stdout events (WaEvent) and stdin commands (WaCommand) of the D9 protocol, exactly as
// specified by packages/contracts/src/wa.ts. stdout carries these JSON lines and nothing else.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------------------------
// Events

// emitter writes protocol events as JSON lines. Safe for concurrent use.
type emitter struct {
	mu     sync.Mutex
	enc    *json.Encoder
	now    func() time.Time
	onFail func(error) // called once, on the first failed write
	failed bool
}

func newEmitter(w io.Writer) *emitter {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	return &emitter{enc: enc, now: time.Now}
}

// setOnFail registers fn for the first failed write (stdout broken: Node is gone).
func (e *emitter) setOnFail(fn func(error)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onFail = fn
}

func (e *emitter) emit(typ string, fields map[string]any) {
	line := make(map[string]any, len(fields)+1)
	for k, v := range fields {
		line[k] = v
	}
	line["type"] = typ
	e.mu.Lock()
	err := e.enc.Encode(line) // Encode appends '\n' and writes the line in one Write call
	var report func(error)
	if err != nil && !e.failed {
		e.failed, report = true, e.onFail
	}
	e.mu.Unlock()
	if report != nil {
		report(err)
	}
}

// stateInfo holds the optional fields of a state event; zero values are omitted.
type stateInfo struct {
	reason string
	code   *int
	until  time.Time
	detail string
	jid    string
}

func (e *emitter) state(state string, info stateInfo) {
	f := map[string]any{"state": state, "at": isoUTC(e.now())}
	if info.reason != "" {
		f["reason"] = info.reason
	}
	if info.code != nil {
		f["code"] = *info.code
	}
	if !info.until.IsZero() {
		f["until"] = isoUTC(info.until)
	}
	if info.detail != "" {
		f["detail"] = info.detail
	}
	if info.jid != "" {
		f["jid"] = info.jid
	}
	e.emit("state", f)
}

// media emits the media event for a download state that was just persisted. Only the states
// ok, retrying and failed are events (pending is internal).
func (e *emitter) media(msgID string, d inboxDownload) {
	f := map[string]any{"msgId": msgID, "state": d.State}
	switch d.State {
	case dlOK, dlRetrying:
	case dlFailed:
		f["reason"] = d.Reason
		f["permanent"] = d.Permanent != nil && *d.Permanent
	default:
		return
	}
	if d.Error != "" && d.State != dlOK {
		f["error"] = d.Error
	}
	e.emit("media", f)
}

// Warning codes (contract WaWarningEvent).
const (
	warnInvalidCommand  = "invalid_command"
	warnCommandRejected = "command_rejected"
	warnCommandFailed   = "command_failed"
)

func (e *emitter) warning(code, command, msgID, detail string) {
	f := map[string]any{"code": code}
	if command != "" && len(command) <= 32 {
		f["command"] = command
	}
	if validMsgID(msgID) {
		f["msgId"] = msgID
	}
	if detail != "" {
		f["detail"] = detail
	}
	e.emit("warning", f)
}

func intPtr(v int) *int { return &v }

// ---------------------------------------------------------------------------------------------
// Commands

// Command types (contract WaCommand).
const (
	cmdPairCode   = "pair_code"
	cmdLogout     = "logout"
	cmdMarkRead   = "mark_read"
	cmdRedownload = "redownload"
	cmdStats      = "stats"
	cmdShutdown   = "shutdown"
)

// command is a validated WaCommand.
type command struct {
	Type  string
	Phone string // pair_code
	MsgID string // mark_read, redownload
}

// commandError describes an invalid command line; Type is set when the line had a string type.
type commandError struct {
	Type string
	Msg  string
}

func (e *commandError) Error() string { return e.Msg }

// parseCommand validates one stdin line like the zod schema WaCommand does: an object with a
// known "type" and the fields that type requires; unknown keys are ignored (zod strips them).
func parseCommand(line []byte) (command, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(line))
	if err := dec.Decode(&raw); err != nil || raw == nil {
		return command{}, &commandError{Msg: "not a JSON object"}
	}
	if dec.More() {
		return command{}, &commandError{Msg: "trailing data after the JSON object"}
	}
	str := func(key string) (string, bool) {
		v, ok := raw[key]
		if !ok {
			return "", false
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return "", false
		}
		return s, true
	}
	typ, ok := str("type")
	if !ok {
		return command{}, &commandError{Msg: `missing or non-string "type"`}
	}
	c := command{Type: typ}
	switch typ {
	case cmdLogout, cmdStats, cmdShutdown:
	case cmdPairCode:
		phone, ok := str("phone")
		if !ok || !phoneDigitsPattern.MatchString(phone) {
			return command{}, &commandError{Type: typ, Msg: `"phone" must be E.164 digits without "+"`}
		}
		c.Phone = phone
	case cmdMarkRead, cmdRedownload:
		id, ok := str("msgId")
		if !ok || !validMsgID(id) {
			return command{}, &commandError{Type: typ, Msg: `"msgId" must be a path-safe message id`}
		}
		c.MsgID = id
	default:
		return command{}, &commandError{Msg: fmt.Sprintf("unknown command type %q", truncate(typ, 32))}
	}
	return c, nil
}

// maxCommandLine bounds one stdin line; longer lines are discarded with a warning.
const maxCommandLine = 64 * 1024

// errLineTooLong is passed to the line callback for a discarded over-long line.
var errLineTooLong = errors.New("command line too long")

// readLines calls fn for every newline-terminated line of r (also a final unterminated one).
// Over-long lines are skipped and reported as errLineTooLong, so one bad line never stops the
// reader. Returns on EOF or a read error.
func readLines(r io.Reader, max int, fn func(line []byte, err error)) error {
	br := bufio.NewReaderSize(r, 4096)
	var buf []byte
	tooLong := false
	for {
		chunk, err := br.ReadSlice('\n')
		if len(chunk) > 0 && !tooLong {
			if len(buf)+len(chunk) > max+1 { // +1: the newline itself
				tooLong, buf = true, buf[:0]
			} else {
				buf = append(buf, chunk...)
			}
		}
		switch {
		case err == nil: // end of line
			if tooLong {
				fn(nil, errLineTooLong)
			} else if line := bytes.TrimSpace(buf); len(line) > 0 {
				fn(line, nil)
			}
			buf, tooLong = buf[:0], false
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default: // EOF or read error: flush a final unterminated line
			if tooLong {
				fn(nil, errLineTooLong)
			} else if line := bytes.TrimSpace(buf); len(line) > 0 {
				fn(line, nil)
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
