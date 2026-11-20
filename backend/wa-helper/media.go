package main

// Media download lifecycle of packages/contracts/src/wa.ts (header "Media download lifecycle"):
//
//	pending  -> ok                 downloaded, fsynced, verified against FileSHA256
//	pending  -> retrying           CDN copy gone (403/404/410, no direct path): media-retry
//	                               receipt sent to the phone, waiting for events.MediaRetry
//	pending|retrying -> failed     reason + permanent (expired, not_on_phone, hash_mismatch are
//	                               permanent; network, timeout, unknown are not)
//
// Every state lives in meta.json (rewritten atomically); nothing needed to resume is kept only in
// memory. A media-retry answer is matched to its status by MessageID -> inbox/<id>/meta.json,
// which also holds the media key, so answers that arrive after a restart are still handled.
//
// Each status with an unfinished download has one job goroutine (an actor): it alone writes that
// meta.json's download state, so redownload requests and retry answers are posted to it instead
// of racing with an attempt in flight. Network work is bounded by a semaphore (media workers) and
// gated on the connection being open.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// mediaAPI is the part of *whatsmeow.Client the downloader uses (a fake in tests).
type mediaAPI interface {
	DownloadToFile(ctx context.Context, msg whatsmeow.DownloadableMessage, file whatsmeow.File) error
	SendMediaRetryReceipt(ctx context.Context, message *types.MessageInfo, mediaKey []byte) error
}

// decryptRetryFunc is whatsmeow.DecryptMediaRetryNotification (injectable for tests).
type decryptRetryFunc func(evt *events.MediaRetry, mediaKey []byte) (*waMmsRetry.MediaRetryNotification, error)

type mediaPolicy struct {
	// backoff[i] is the delay after the (i+1)-th transient failure of a run; one more failure
	// than len(backoff) ends the run as failed (permanent=false, Node may send redownload).
	backoff []time.Duration
	// retryWait: how long to wait for the phone's media-retry answer before trying again (which
	// re-sends the receipt when the CDN copy is still gone).
	retryWait time.Duration
	// maxReceipts: media-retry receipts per run; then failed (timeout, permanent=false).
	maxReceipts int
	// hashRetries: extra attempts after a hash mismatch before failing permanently.
	hashRetries int
	// attemptTimeout bounds one DownloadToFile call (whatsmeow retries hosts internally).
	attemptTimeout time.Duration
	// receiptTimeout bounds one SendMediaRetryReceipt call.
	receiptTimeout time.Duration
}

var defaultMediaPolicy = mediaPolicy{
	backoff:        []time.Duration{15 * time.Second, time.Minute, 5 * time.Minute, 15 * time.Minute, 30 * time.Minute},
	retryWait:      10 * time.Minute,
	maxReceipts:    3,
	hashRetries:    1,
	attemptTimeout: 10 * time.Minute,
	receiptTimeout: 30 * time.Second,
}

type mediaManager struct {
	ctx     context.Context
	inbox   string
	api     mediaAPI
	decrypt decryptRetryFunc
	out     *emitter
	log     zerolog.Logger
	stats   *stats
	policy  mediaPolicy
	fromMe  bool // self mode: the statuses are our own (receipt attribute from_me)
	now     func() time.Time
	sem     chan struct{}

	mu       sync.Mutex
	jobs     map[string]*mediaJob
	online   bool
	onlineCh chan struct{} // closed while online
	wg       sync.WaitGroup
}

type mediaJob struct {
	msgID string
	wake  chan struct{} // capacity 1

	// guarded by mediaManager.mu
	answers []*events.MediaRetry
	reset   bool

	run mediaRun // owned by the job goroutine
}

// mediaRun is the per-run budget (a run starts with a job, a restart or a redownload).
type mediaRun struct {
	failures     int    // transient failures
	receipts     int    // media-retry receipts sent
	hashFailures int    // hash mismatches
	answered     bool   // the phone answered a receipt
	directPath   string // fresh path from a media-retry answer, used until it is gone as well
}

func newMediaManager(ctx context.Context, inbox string, api mediaAPI, out *emitter, log zerolog.Logger, st *stats, workers int, fromMe bool) *mediaManager {
	if workers < 1 {
		workers = 1
	}
	return &mediaManager{
		ctx: ctx, inbox: inbox, api: api, decrypt: whatsmeow.DecryptMediaRetryNotification,
		out: out, log: log, stats: st, policy: defaultMediaPolicy, fromMe: fromMe, now: time.Now,
		sem: make(chan struct{}, workers), jobs: map[string]*mediaJob{}, onlineCh: make(chan struct{}),
	}
}

// setOnline opens or closes the gate for network work (Connected / Disconnected).
func (m *mediaManager) setOnline(on bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case on && !m.online:
		close(m.onlineCh)
		m.online = true
	case !on && m.online:
		m.onlineCh = make(chan struct{})
		m.online = false
	}
}

func (m *mediaManager) waitOnline() error {
	m.mu.Lock()
	ch := m.onlineCh
	m.mu.Unlock()
	select {
	case <-ch:
		return nil
	case <-m.ctx.Done():
		return m.ctx.Err()
	}
}

// active returns the number of unfinished downloads with a job.
func (m *mediaManager) active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.jobs)
}

// post finds or starts the job of msgID, applies mutate under the lock and optionally wakes it.
func (m *mediaManager) post(msgID string, wake bool, mutate func(*mediaJob)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return
	}
	j, ok := m.jobs[msgID]
	if !ok {
		j = &mediaJob{msgID: msgID, wake: make(chan struct{}, 1)}
		m.jobs[msgID] = j
		m.wg.Add(1)
		go m.runJob(j)
	}
	if mutate != nil {
		mutate(j)
	}
	if wake {
		select {
		case j.wake <- struct{}{}:
		default:
		}
	}
}

// ensure makes sure an unfinished download of msgID has a job (no-op when it already has one;
// a running job is not woken, so its backoff holds).
func (m *mediaManager) ensure(msgID string) {
	if validMsgID(msgID) {
		m.post(msgID, false, nil)
	}
}

// redownload handles the redownload command: only a failed, non-permanent download (rule 2).
func (m *mediaManager) redownload(msgID string) error {
	meta, err := readMeta(m.inbox, msgID)
	if errors.Is(err, fs.ErrNotExist) {
		return errors.New("no such status in the inbox")
	} else if err != nil {
		return err
	}
	d := meta.Download
	switch {
	case !isMediaKind(meta.Kind):
		return fmt.Errorf("kind %q has nothing to download", meta.Kind)
	case d.State != dlFailed:
		return fmt.Errorf("download state is %q (only failed downloads are redownloaded)", d.State)
	case d.terminal():
		return fmt.Errorf("download failed permanently (%s)", d.Reason)
	}
	m.post(msgID, true, func(j *mediaJob) { j.reset = true })
	return nil
}

// onMediaRetry hands the phone's answer to a media-retry receipt to the status's job.
func (m *mediaManager) onMediaRetry(evt *events.MediaRetry) {
	m.stats.mediaRetryAnswers.Add(1)
	if !validMsgID(evt.MessageID) {
		return
	}
	if _, err := os.Stat(metaPath(m.inbox, evt.MessageID)); err != nil {
		m.log.Debug().Str("id", evt.MessageID).Msg("media retry answer for a message that is not in the inbox")
		return
	}
	m.post(evt.MessageID, true, func(j *mediaJob) { j.answers = append(j.answers, evt) })
}

// resume starts jobs for every pending or retrying download in the inbox (rule 1) and removes
// temporary files of interrupted writes in those directories. Jobs wait for the connection.
func (m *mediaManager) resume() (int, error) {
	entries, err := os.ReadDir(m.inbox)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	} else if err != nil {
		return 0, err
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if e.Name() == inboxRevokesDir {
			cleanTempFiles(filepath.Join(m.inbox, e.Name()))
			continue
		}
		if !validMsgID(e.Name()) {
			continue
		}
		meta, err := readMeta(m.inbox, e.Name())
		if err != nil {
			if !errors.Is(err, fs.ErrNotExist) {
				m.log.Warn().Err(err).Str("id", e.Name()).Msg("unreadable meta.json, not resuming")
			}
			continue
		}
		if !isMediaKind(meta.Kind) || meta.Source == "fixture" {
			continue
		}
		if s := meta.Download.State; s == dlPending || s == dlRetrying {
			cleanTempFiles(filepath.Join(m.inbox, e.Name()))
			m.ensure(meta.MsgID)
			n++
		}
	}
	return n, nil
}

// wait blocks until every job goroutine ended (after ctx is cancelled) or the timeout passed.
func (m *mediaManager) wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (m *mediaManager) runJob(j *mediaJob) {
	defer m.wg.Done()
	defer func() {
		if r := recover(); r != nil {
			m.log.Error().Interface("panic", r).Str("id", j.msgID).Msg("media job panicked")
			m.mu.Lock()
			delete(m.jobs, j.msgID)
			m.mu.Unlock()
		}
	}()
	var delay time.Duration
	for {
		if delay > 0 {
			t := time.NewTimer(delay)
			select {
			case <-t.C:
			case <-j.wake:
			case <-m.ctx.Done():
			}
			t.Stop()
		}
		select { // a wake that arrived while working is consumed by this round
		case <-j.wake:
		default:
		}
		if m.ctx.Err() != nil {
			m.drop(j)
			return
		}
		m.mu.Lock()
		answers, reset := j.answers, j.reset
		j.answers, j.reset = nil, false
		m.mu.Unlock()

		next, done := m.step(j, answers, reset)
		if m.ctx.Err() != nil {
			m.drop(j)
			return
		}
		if done {
			m.mu.Lock()
			if len(j.answers) == 0 && !j.reset {
				delete(m.jobs, j.msgID)
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
			next = 0 // something was posted meanwhile
		}
		delay = next
	}
}

func (m *mediaManager) drop(j *mediaJob) {
	m.mu.Lock()
	delete(m.jobs, j.msgID)
	m.mu.Unlock()
}

// step runs one round of a job: apply a redownload reset and media-retry answers, then attempt
// the download or wait. Returns the delay until the next round, or done.
func (m *mediaManager) step(j *mediaJob, answers []*events.MediaRetry, reset bool) (time.Duration, bool) {
	meta, err := readMeta(m.inbox, j.msgID)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			m.log.Error().Err(err).Str("id", j.msgID).Msg("cannot read meta.json, giving up on this download")
		}
		return 0, true
	}
	if !isMediaKind(meta.Kind) || meta.Media == nil || meta.Source == "fixture" {
		return 0, true
	}
	if reset {
		j.run = mediaRun{}
		if d := meta.Download; d.State == dlFailed && !d.terminal() {
			meta, err = m.save(meta.MsgID, false, func(d *inboxDownload, _ *inboxMedia) {
				d.State, d.Reason, d.Permanent, d.Error = dlPending, "", nil, ""
			})
			if err != nil {
				return 0, true
			}
		}
	}
	for _, a := range answers {
		var done bool
		if meta, done = m.applyAnswer(j, meta, a); done {
			return 0, true
		}
	}
	switch d := meta.Download; d.State {
	case dlPending:
	case dlRetrying:
		if j.run.directPath == "" {
			if left := m.retryWaitLeft(d); left > 0 {
				return left, false // the answer may still come
			}
		}
	default: // ok, not_applicable, failed (waits for Node's redownload)
		return 0, true
	}
	return m.attempt(j, meta)
}

// retryWaitLeft is the time left until the media-retry answer is considered overdue.
func (m *mediaManager) retryWaitLeft(d inboxDownload) time.Duration {
	at, err := time.Parse(time.RFC3339Nano, d.RetryRequestedAt)
	if err != nil {
		return 0
	}
	left := at.Add(m.policy.retryWait).Sub(m.now())
	if left > m.policy.retryWait { // clock went backwards
		left = m.policy.retryWait
	}
	return left
}

// applyAnswer handles one events.MediaRetry for the job's status.
func (m *mediaManager) applyAnswer(j *mediaJob, meta inboxMeta, evt *events.MediaRetry) (inboxMeta, bool) {
	if meta.Download.terminal() {
		return meta, true
	}
	dm, err := downloadableOf(meta)
	if err != nil {
		return m.fail(meta, reasonUnknown, false, err.Error())
	}
	notif, err := m.decrypt(evt, dm.GetMediaKey())
	switch {
	case errors.Is(err, whatsmeow.ErrMediaNotAvailableOnPhone):
		return m.fail(meta, reasonNotOnPhone, true, "the phone no longer has this media")
	case err != nil:
		return m.fail(meta, reasonUnknown, false, "media retry answer: "+err.Error())
	case notif.GetStanzaID() != "" && notif.GetStanzaID() != meta.MsgID:
		m.log.Warn().Str("id", meta.MsgID).Str("stanza", notif.GetStanzaID()).Msg("media retry answer for another stanza, ignored")
		return meta, false
	}
	switch notif.GetResult() {
	case waMmsRetry.MediaRetryNotification_SUCCESS:
		if notif.GetDirectPath() == "" {
			return m.fail(meta, reasonUnknown, false, "media retry answer without a direct path")
		}
		j.run.directPath, j.run.answered = notif.GetDirectPath(), true
		if meta.Download.State != dlPending {
			updated, err := m.save(meta.MsgID, false, func(d *inboxDownload, _ *inboxMedia) {
				d.State, d.Reason, d.Permanent, d.Error = dlPending, "", nil, ""
			})
			if err != nil {
				return meta, true
			}
			meta = updated
		}
		return meta, false
	case waMmsRetry.MediaRetryNotification_NOT_FOUND:
		return m.fail(meta, reasonExpired, true, "the phone answered NOT_FOUND")
	default:
		return m.fail(meta, reasonUnknown, false, "the phone answered "+notif.GetResult().String())
	}
}

// attempt downloads once and decides what comes next.
func (m *mediaManager) attempt(j *mediaJob, meta inboxMeta) (time.Duration, bool) {
	dm, err := downloadableOf(meta)
	if err != nil {
		_, done := m.fail(meta, reasonUnknown, false, err.Error())
		return 0, done
	}
	if j.run.directPath != "" {
		// The fresh path from a media-retry answer is kept for transient failures; only an
		// outGone result (the re-uploaded copy is gone as well) drops it.
		dm = withDirectPath(dm, j.run.directPath)
	}
	if m.waitOnline() != nil {
		return 0, true
	}
	select {
	case m.sem <- struct{}{}:
	case <-m.ctx.Done():
		return 0, true
	}
	defer func() { <-m.sem }()

	res := m.download(meta, dm)
	errText := ""
	if res.err != nil {
		errText = res.err.Error()
	}
	switch res.outcome {
	case outCanceled:
		return 0, true // shutdown: the state stays pending/retrying and resumes on the next start
	case outOK:
		if _, err := m.save(meta.MsgID, true, func(d *inboxDownload, med *inboxMedia) {
			d.State, d.File, d.Sha256Hex = dlOK, res.file, res.sha256Hex
			d.Attempts++
			d.Reason, d.Permanent, d.Error = "", nil, ""
			if med != nil && med.FileLength == 0 && res.size > 0 {
				med.FileLength = uint64(res.size)
			}
		}); err != nil {
			return m.transient(j, reasonUnknown, "persist: "+err.Error())
		}
		m.stats.mediaOK.Add(1)
		m.log.Info().Str("id", meta.MsgID).Str("file", res.file).Int64("bytes", res.size).Msg("media downloaded")
		return 0, true
	case outHash:
		j.run.hashFailures++
		if j.run.hashFailures > m.policy.hashRetries {
			_, done := m.failAttempt(meta, reasonHashMismatch, true, errText)
			return 0, done
		}
		return m.retryLater(j, meta, m.policy.backoff[0], errText)
	case outGone:
		j.run.directPath = "" // the fresh path (if any) is gone too; the next answer brings a new one
		if j.run.receipts >= m.policy.maxReceipts {
			reason := reasonTimeout // the phone never answered
			if j.run.answered {
				reason = reasonUnknown // it answered, but the new copy was gone as well
			}
			_, done := m.failAttempt(meta, reason, false, fmt.Sprintf("CDN copy gone after %d media-retry receipts: %s", j.run.receipts, errText))
			return 0, done
		}
		if m.hasAnswers(j) { // an answer is already waiting: no new receipt
			return m.retryLater(j, meta, 0, errText)
		}
		if meta.Sender.JID == "" {
			_, done := m.failAttempt(meta, reasonUnknown, false, "media gone and meta.json has no sender.jid for a media retry")
			return 0, done
		}
		if err := m.sendReceipt(meta, dm.GetMediaKey()); err != nil {
			return m.transientAttempt(j, meta, reasonNetwork, "media retry receipt: "+err.Error())
		}
		j.run.receipts++
		m.stats.mediaRetry.Add(1)
		now := m.now()
		if _, err := m.save(meta.MsgID, true, func(d *inboxDownload, _ *inboxMedia) {
			d.State, d.RetryRequestedAt, d.Error = dlRetrying, isoUTC(now), errText
			d.Attempts++
			d.Reason, d.Permanent = "", nil
		}); err != nil {
			return m.transient(j, reasonUnknown, "persist: "+err.Error())
		}
		m.log.Info().Str("id", meta.MsgID).Int("receipt", j.run.receipts).Msg("media gone from the CDN, asked the phone to re-upload it")
		return m.policy.retryWait, false
	default:
		return m.transientAttempt(j, meta, res.reason, errText)
	}
}

// transientAttempt records a failed attempt and schedules the next one (or gives up).
func (m *mediaManager) transientAttempt(j *mediaJob, meta inboxMeta, reason, errText string) (time.Duration, bool) {
	j.run.failures++
	if j.run.failures > len(m.policy.backoff) {
		_, done := m.failAttempt(meta, reason, false, errText)
		return 0, done
	}
	return m.retryLater(j, meta, m.policy.backoff[j.run.failures-1], errText)
}

// transient counts a local failure (e.g. meta.json not writable) without touching meta.json.
func (m *mediaManager) transient(j *mediaJob, reason, errText string) (time.Duration, bool) {
	j.run.failures++
	m.log.Error().Str("id", j.msgID).Str("reason", reason).Str("error", errText).Msg("media download bookkeeping failed")
	if j.run.failures > len(m.policy.backoff) {
		return 0, true
	}
	return m.policy.backoff[j.run.failures-1], false
}

// retryLater persists the attempt (state unchanged) and returns the delay.
func (m *mediaManager) retryLater(j *mediaJob, meta inboxMeta, delay time.Duration, errText string) (time.Duration, bool) {
	if _, err := m.save(meta.MsgID, false, func(d *inboxDownload, _ *inboxMedia) {
		d.Attempts++
		d.Error = errText
	}); err != nil {
		return m.transient(j, reasonUnknown, "persist: "+err.Error())
	}
	m.log.Warn().Str("id", meta.MsgID).Str("error", errText).Dur("retry_in", delay).Msg("media download failed, retrying")
	return delay, false
}

// failAttempt is fail() for the outcome of a download attempt (counts the attempt).
func (m *mediaManager) failAttempt(meta inboxMeta, reason string, permanent bool, errText string) (inboxMeta, bool) {
	return m.failWith(meta, reason, permanent, errText, true)
}

// fail marks the download failed (persist, then emit). Always ends the job.
func (m *mediaManager) fail(meta inboxMeta, reason string, permanent bool, errText string) (inboxMeta, bool) {
	return m.failWith(meta, reason, permanent, errText, false)
}

func (m *mediaManager) failWith(meta inboxMeta, reason string, permanent bool, errText string, countAttempt bool) (inboxMeta, bool) {
	updated, err := m.save(meta.MsgID, true, func(d *inboxDownload, _ *inboxMedia) {
		d.State, d.Reason, d.Permanent, d.Error = dlFailed, reason, boolPtr(permanent), errText
		if countAttempt {
			d.Attempts++
		}
	})
	if err != nil {
		return meta, true
	}
	m.stats.mediaFailed.Add(1)
	m.log.Warn().Str("id", meta.MsgID).Str("reason", reason).Bool("permanent", permanent).Str("error", errText).Msg("media download failed")
	return updated, true
}

// save rewrites the download state (and media facts) of meta.json; with emit it then emits the
// media event (state transitions to ok, retrying and failed).
func (m *mediaManager) save(msgID string, emit bool, fn func(d *inboxDownload, med *inboxMedia)) (inboxMeta, error) {
	updated, err := updateMeta(m.inbox, msgID, func(meta *inboxMeta) error {
		fn(&meta.Download, meta.Media)
		return nil
	})
	if err != nil {
		m.log.Error().Err(err).Str("id", msgID).Msg("cannot update meta.json")
		return inboxMeta{}, err
	}
	if emit {
		m.out.media(msgID, updated.Download)
	}
	return updated, nil
}

func (m *mediaManager) hasAnswers(j *mediaJob) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(j.answers) > 0
}

// sendReceipt asks the phone to re-upload the media. Statuses are broadcast-group messages, so
// IsGroup is always true (history-synced ones come with IsGroup=false from ParseWebMessage):
// whatsmeow then adds participant=<sender jid> to the <rmr> node.
func (m *mediaManager) sendReceipt(meta inboxMeta, mediaKey []byte) error {
	sender, err := types.ParseJID(meta.Sender.JID)
	if err != nil {
		return fmt.Errorf("sender.jid: %w", err)
	}
	info := &types.MessageInfo{
		MessageSource: types.MessageSource{
			Chat: types.StatusBroadcastJID, Sender: sender, IsFromMe: m.fromMe, IsGroup: true,
		},
		ID: meta.MsgID,
	}
	ctx, cancel := context.WithTimeout(m.ctx, m.policy.receiptTimeout)
	defer cancel()
	return m.api.SendMediaRetryReceipt(ctx, info, mediaKey)
}

// ---------------------------------------------------------------------------------------------
// One download attempt

type outcome int

const (
	outOK outcome = iota
	outCanceled
	outGone      // 403/404/410 or no direct path: ask the phone to re-upload
	outHash      // integrity check failed
	outTransient // network, timeout, unknown
)

type dlResult struct {
	outcome   outcome
	reason    string // failure reason for outTransient / outHash
	err       error
	file      string
	sha256Hex string
	size      int64
}

// download fetches the media into a temp file in inbox/<msgId>/, verifies it against
// FileSHA256, fsyncs it and renames it to original.<ext> (then fsyncs the directory).
func (m *mediaManager) download(meta inboxMeta, dm whatsmeow.DownloadableMessage) dlResult {
	dir := filepath.Join(m.inbox, meta.MsgID)
	tmp, err := os.CreateTemp(dir, tmpPrefixDownload+"*")
	if err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName) // no-op after the rename
	}()

	ctx, cancel := context.WithTimeout(m.ctx, m.policy.attemptTimeout)
	defer cancel()
	if err := m.api.DownloadToFile(ctx, dm, tmp); err != nil {
		o, reason := classifyDownloadError(m.ctx, err)
		return dlResult{outcome: o, reason: reason, err: err}
	}

	want, err := base64.StdEncoding.DecodeString(meta.Media.FileSha256B64)
	if err != nil || len(want) != sha256.Size {
		return dlResult{outcome: outHash, reason: reasonHashMismatch, err: errors.New("meta.json has no valid fileSha256B64")}
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	h := sha256.New()
	size, err := io.Copy(h, tmp)
	if err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	sum := h.Sum(nil)
	if !bytes.Equal(sum, want) {
		return dlResult{outcome: outHash, reason: reasonHashMismatch, err: errors.New("sha256 of the downloaded file does not match FileSHA256")}
	}
	if err := tmp.Sync(); err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	if err := tmp.Close(); err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	name := "original." + mediaExt(meta.Kind, meta.Media.Mimetype)
	if err := os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	if err := syncDir(dir); err != nil {
		return dlResult{outcome: outTransient, reason: reasonUnknown, err: err}
	}
	return dlResult{outcome: outOK, file: name, sha256Hex: hex.EncodeToString(sum), size: size}
}

// classifyDownloadError maps a whatsmeow download error to the lifecycle (wa.ts reasons).
func classifyDownloadError(parent context.Context, err error) (outcome, string) {
	switch {
	case parent.Err() != nil:
		return outCanceled, ""
	case errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403),
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404),
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410),
		errors.Is(err, whatsmeow.ErrNoURLPresent):
		return outGone, reasonExpired
	case errors.Is(err, whatsmeow.ErrInvalidMediaSHA256),
		errors.Is(err, whatsmeow.ErrInvalidMediaEncSHA256),
		errors.Is(err, whatsmeow.ErrInvalidMediaHMAC),
		errors.Is(err, whatsmeow.ErrInvalidUnencryptedMediaSHA256):
		return outHash, reasonHashMismatch
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, whatsmeow.ErrIQTimedOut):
		return outTransient, reasonTimeout
	}
	if netErr, ok := errors.AsType[net.Error](err); ok {
		if netErr.Timeout() {
			return outTransient, reasonTimeout
		}
		return outTransient, reasonNetwork
	}
	if _, ok := errors.AsType[whatsmeow.DownloadHTTPError](err); ok {
		return outTransient, reasonNetwork // 5xx / 429 after whatsmeow's own retries
	}
	switch {
	case errors.Is(err, whatsmeow.ErrNotConnected),
		errors.Is(err, whatsmeow.ErrIQDisconnected),
		errors.Is(err, io.ErrUnexpectedEOF),
		errors.Is(err, syscall.ECONNRESET),
		errors.Is(err, syscall.ECONNREFUSED),
		errors.Is(err, syscall.EPIPE):
		return outTransient, reasonNetwork
	}
	return outTransient, reasonUnknown
}
