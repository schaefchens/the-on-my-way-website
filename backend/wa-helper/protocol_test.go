package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseCommandFollowsTheContract(t *testing.T) {
	valid := map[string]command{
		`{"type":"stats"}`:                                    {Type: cmdStats},
		`{"type":"shutdown","extra":1}`:                       {Type: cmdShutdown}, // unknown keys are ignored (zod strips them)
		`{"type":"logout"}`:                                   {Type: cmdLogout},
		`{"type":"pair_code","phone":"4915100000002"}`:        {Type: cmdPairCode, Phone: "4915100000002"},
		`{"type":"mark_read","msgId":"3EB0C767D26A1D8B7A3B"}`: {Type: cmdMarkRead, MsgID: "3EB0C767D26A1D8B7A3B"},
		`{"type":"redownload","msgId":"AC2F9A_x-1"}`:          {Type: cmdRedownload, MsgID: "AC2F9A_x-1"},
		` {"msgId":"AC2F9A","type":"redownload"} `:            {Type: cmdRedownload, MsgID: "AC2F9A"},
	}
	for line, want := range valid {
		got, err := parseCommand([]byte(line))
		if err != nil || got != want {
			t.Errorf("parseCommand(%s) = %+v, %v; want %+v", line, got, err, want)
		}
	}
	invalid := map[string]string{ // line -> command type reported in the warning
		``:                                  "",
		`null`:                              "",
		`[]`:                                "",
		`"stats"`:                           "",
		`{"type":"stats"} {"type":"stats"}`: "",
		`{"type":1}`:                        "",
		`{"kind":"stats"}`:                  "",
		`{"type":"reboot"}`:                 "",
		`{"type":"pair_code"}`:              cmdPairCode,
		`{"type":"pair_code","phone":"+4915100"}`:    cmdPairCode,
		`{"type":"pair_code","phone":"015100000"}`:   cmdPairCode,
		`{"type":"pair_code","phone":4915100000002}`: cmdPairCode,
		`{"type":"mark_read"}`:                       cmdMarkRead,
		`{"type":"mark_read","msgId":"_revokes"}`:    cmdMarkRead,
		`{"type":"redownload","msgId":"../../x"}`:    cmdRedownload,
		`{"type":"redownload","msgId":""}`:           cmdRedownload,
	}
	for line, typ := range invalid {
		_, err := parseCommand([]byte(line))
		var ce *commandError
		if !errors.As(err, &ce) || ce.Type != typ {
			t.Errorf("parseCommand(%s) = %v; want a commandError with type %q", line, err, typ)
		}
	}
}

func TestReadLines(t *testing.T) {
	long := strings.Repeat("x", 100)
	input := "a\r\n\n  b  \n" + long + "\nc\nlast-without-newline"
	var got []string
	var tooLong int
	err := readLines(strings.NewReader(input), 50, func(line []byte, err error) {
		if errors.Is(err, errLineTooLong) {
			tooLong++
			return
		}
		got = append(got, string(line))
	})
	if err != nil || tooLong != 1 || strings.Join(got, "|") != "a|b|c|last-without-newline" {
		t.Fatalf("lines %q, too long %d, err %v", got, tooLong, err)
	}
	// A line longer than bufio's buffer is skipped, the reader keeps going.
	huge := strings.Repeat("y", 3*maxCommandLine)
	got, tooLong = nil, 0
	_ = readLines(strings.NewReader(huge+"\n"+`{"type":"stats"}`+"\n"), maxCommandLine, func(line []byte, err error) {
		if err != nil {
			tooLong++
			return
		}
		got = append(got, string(line))
	})
	if tooLong != 1 || len(got) != 1 || got[0] != `{"type":"stats"}` {
		t.Fatalf("after a huge line: %q, too long %d", got, tooLong)
	}
}

func TestMediaEventShapes(t *testing.T) {
	var buf bytes.Buffer
	e := newEmitter(&buf)
	e.now = func() time.Time { return goldenNow }
	e.media("A1", inboxDownload{State: dlPending, Error: "x"}) // internal state: no event
	e.media("A1", inboxDownload{State: dlOK, File: "original.jpg", Error: "stale"})
	e.media("A1", inboxDownload{State: dlRetrying, Error: "404"})
	e.media("A1", inboxDownload{State: dlFailed, Reason: reasonNetwork, Permanent: boolPtr(false)})
	want := `{"msgId":"A1","state":"ok","type":"media"}
{"error":"404","msgId":"A1","state":"retrying","type":"media"}
{"msgId":"A1","permanent":false,"reason":"network","state":"failed","type":"media"}
`
	if buf.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", buf.String(), want)
	}
	buf.Reset()
	e.warning(warnInvalidCommand, strings.Repeat("t", 40), "../bad", "")
	if buf.String() != `{"code":"invalid_command","type":"warning"}`+"\n" {
		t.Fatalf("over-long command types and invalid msgIds are left out: %s", buf.String())
	}
}
