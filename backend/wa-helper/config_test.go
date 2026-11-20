package main

import (
	"io"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestConfigFromEnvironment(t *testing.T) {
	c, err := parseConfig(nil, env(map[string]string{
		"DATA_DIR": "/data", "TRAVELER_PHONE": "+49 151-000 00001", "TRAVELER_LID": travelerLID,
		"SEND_READ_RECEIPT": "true", "LOG_LEVEL": "silent", "WA_MODE": "observer",
	}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.dataDir != "/data" || c.travelerPhone != "4915100000001" || c.travelerLID != travelerLID || !c.sendReadReceipt ||
		c.logLevel != zerolog.Disabled || c.mode != modeObserver || !c.connect || c.mediaWorkers != 2 || c.statsInterval != time.Minute {
		t.Fatalf("config = %+v", c)
	}
}

func TestFlagsOverrideTheEnvironment(t *testing.T) {
	c, err := parseConfig([]string{"-data-dir", "/x", "-mode", "self", "-log-level", "warning", "-dry-run",
		"-media-workers", "4", "-stats-interval", "0", "-send-read-receipt=false"},
		env(map[string]string{"DATA_DIR": "/data", "WA_MODE": "observer", "SEND_READ_RECEIPT": "1"}), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.dataDir != "/x" || c.mode != modeSelf || c.logLevel != zerolog.WarnLevel || c.connect || c.mediaWorkers != 4 ||
		c.statsInterval != 0 || c.sendReadReceipt || c.travelerPhone != "" {
		t.Fatalf("config = %+v", c)
	}
}

func TestConfigErrors(t *testing.T) {
	base := map[string]string{"DATA_DIR": "/data", "TRAVELER_PHONE": "4915100000001"}
	cases := map[string]struct {
		args []string
		env  map[string]string
		want string
	}{
		"no data dir":       {nil, map[string]string{"TRAVELER_PHONE": "4915100000001"}, "-data-dir"},
		"observer no phone": {nil, map[string]string{"DATA_DIR": "/d"}, "required in observer mode"},
		"fixture mode":      {[]string{"-mode", "fixture"}, base, "fixture"},
		"bad mode":          {[]string{"-mode", "spy"}, base, "observer or self"},
		"national number":   {[]string{"-traveler-phone", "0151 0000001"}, base, "international"},
		"letters in phone":  {[]string{"-traveler-phone", "49151abc"}, base, "unexpected character"},
		"bad lid":           {[]string{"-traveler-lid", "12a"}, base, "-traveler-lid"},
		"bad pair phone":    {[]string{"-pair-phone", "123"}, base, "-pair-phone"},
		"bad receipt flag":  {[]string{"-send-read-receipt", "maybe"}, base, "send-read-receipt"},
		"bad log level":     {[]string{"-log-level", "loud"}, base, "log level"},
		"workers":           {[]string{"-media-workers", "0"}, base, "media-workers"},
		"stats interval":    {[]string{"-stats-interval", "10ms"}, base, "stats-interval"},
		"positional args":   {[]string{"extra"}, base, "unexpected arguments"},
		"unknown flag":      {[]string{"-nope"}, base, "not defined"},
	}
	for name, tc := range cases {
		_, err := parseConfig(tc.args, env(tc.env), io.Discard)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v; want it to mention %q", name, err, tc.want)
		}
	}
	// Self mode needs no traveler phone.
	if _, err := parseConfig([]string{"-mode", "self"}, env(map[string]string{"DATA_DIR": "/d"}), io.Discard); err != nil {
		t.Errorf("self mode without TRAVELER_PHONE: %v", err)
	}
}
