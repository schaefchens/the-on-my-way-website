package main

// Command-line / environment configuration. Every flag has an environment fallback so Node can
// pass either; flags win. Invalid configuration ends the helper with exitConfig (2).

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

const (
	modeObserver = "observer" // a separate observer account; keep the traveler's statuses
	modeSelf     = "self"     // the traveler's own account is linked; keep its own statuses
)

var (
	// Same regexes as PhoneDigits / LidDigits in packages/contracts/src/wa.ts.
	phoneDigitsPattern = regexp.MustCompile(`^[1-9]\d{5,15}$`)
	lidDigitsPattern   = regexp.MustCompile(`^\d{1,32}$`)
)

type config struct {
	dataDir         string
	mode            string
	travelerPhone   string // E.164 digits without "+"; may be empty in self mode
	travelerLID     string // digits; learned earlier and passed back by Node
	sendReadReceipt bool
	connect         bool
	pairPhone       string // digits; request a pairing code instead of scanning the QR
	mediaWorkers    int
	statsInterval   time.Duration
	logLevel        zerolog.Level
}

// parseConfig parses args (without the program name) with getenv as the environment fallback.
// Usage errors are written to usage.
func parseConfig(args []string, getenv func(string) string, usage io.Writer) (config, error) {
	envOr := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}
	fs := flag.NewFlagSet("wa-helper", flag.ContinueOnError)
	fs.SetOutput(usage)
	var (
		c                                   config
		mode, phone, lid, pair, level, read string
		dryRun                              bool
	)
	fs.StringVar(&c.dataDir, "data-dir", envOr("DATA_DIR", ""), "state dir holding wa/session.db and inbox/ (env DATA_DIR; required)")
	fs.StringVar(&mode, "mode", envOr("WA_MODE", modeObserver), "observer | self (env WA_MODE)")
	fs.StringVar(&phone, "traveler-phone", envOr("TRAVELER_PHONE", ""), "traveler phone number, international format (env TRAVELER_PHONE; required in observer mode)")
	fs.StringVar(&lid, "traveler-lid", envOr("TRAVELER_LID", ""), "traveler LID digits from an earlier traveler event (env TRAVELER_LID)")
	fs.StringVar(&read, "send-read-receipt", envOr("SEND_READ_RECEIPT", "false"), "allow the mark_read command to send status read receipts (env SEND_READ_RECEIPT)")
	fs.BoolVar(&c.connect, "connect", true, "connect to WhatsApp (-connect=false: open the store, print ready, exit)")
	fs.BoolVar(&dryRun, "dry-run", false, "same as -connect=false")
	fs.StringVar(&pair, "pair-phone", "", "on an unlinked store: request a pairing code for this observer number (same as the pair_code command)")
	fs.IntVar(&c.mediaWorkers, "media-workers", 2, "concurrent media downloads (1-8)")
	fs.DurationVar(&c.statsInterval, "stats-interval", 60*time.Second, "interval of the periodic stats event (0 disables)")
	fs.StringVar(&level, "log-level", envOr("LOG_LEVEL", "info"), "stderr log level: trace|debug|info|warn|error|fatal|silent (env LOG_LEVEL)")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() > 0 {
		return config{}, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	if dryRun {
		c.connect = false
	}

	var problems []string
	if strings.TrimSpace(c.dataDir) == "" {
		problems = append(problems, "-data-dir (or DATA_DIR) is required")
	}
	switch strings.ToLower(mode) {
	case modeObserver, modeSelf:
		c.mode = strings.ToLower(mode)
	case "fixture":
		problems = append(problems, "WA_MODE=fixture does not use the helper (Node replays fixtures itself)")
	default:
		problems = append(problems, fmt.Sprintf("-mode must be observer or self, got %q", mode))
	}
	if phone != "" {
		digits, err := normalizePhone(phone)
		if err != nil {
			problems = append(problems, "-traveler-phone: "+err.Error())
		}
		c.travelerPhone = digits
	} else if c.mode == modeObserver {
		problems = append(problems, "-traveler-phone (or TRAVELER_PHONE) is required in observer mode")
	}
	if lid != "" {
		if !lidDigitsPattern.MatchString(lid) {
			problems = append(problems, "-traveler-lid must be digits")
		}
		c.travelerLID = lid
	}
	if pair != "" {
		digits, err := normalizePhone(pair)
		if err != nil {
			problems = append(problems, "-pair-phone: "+err.Error())
		}
		c.pairPhone = digits
	}
	switch strings.ToLower(read) {
	case "true", "1", "yes":
		c.sendReadReceipt = true
	case "false", "0", "no", "":
	default:
		problems = append(problems, fmt.Sprintf("-send-read-receipt must be true or false, got %q", read))
	}
	if c.mediaWorkers < 1 || c.mediaWorkers > 8 {
		problems = append(problems, "-media-workers must be between 1 and 8")
	}
	if c.statsInterval < 0 || (c.statsInterval > 0 && c.statsInterval < time.Second) {
		problems = append(problems, "-stats-interval must be 0 or at least 1s")
	}
	lvl, err := parseLogLevel(level)
	if err != nil {
		problems = append(problems, err.Error())
	}
	c.logLevel = lvl
	if len(problems) > 0 {
		return config{}, errors.New(strings.Join(problems, "; "))
	}
	return c, nil
}

// normalizePhone strips formatting ("+49 151 …", "+49-151-…") and validates E.164 digits.
func normalizePhone(s string) (string, error) {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' || r == ' ' || r == '-' || r == '(' || r == ')' || r == '.' || r == '/':
		default:
			return "", fmt.Errorf("unexpected character %q in phone number", r)
		}
	}
	digits := b.String()
	if !phoneDigitsPattern.MatchString(digits) {
		return "", fmt.Errorf("%q is not an international number (country code first, no leading 0)", s)
	}
	return digits, nil
}

// parseLogLevel accepts zerolog's names plus Node's ("silent", "warning").
func parseLogLevel(s string) (zerolog.Level, error) {
	switch strings.ToLower(s) {
	case "silent", "off", "disabled":
		return zerolog.Disabled, nil
	case "warning":
		return zerolog.WarnLevel, nil
	}
	lvl, err := zerolog.ParseLevel(strings.ToLower(s))
	if err != nil || s == "" {
		return zerolog.InfoLevel, fmt.Errorf("invalid log level %q", s)
	}
	return lvl, nil
}
