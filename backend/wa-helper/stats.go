package main

import "sync/atomic"

// stats are the counters of the stats event (contract WaStatsEvent), all since helper start.
type stats struct {
	captured          atomic.Int64 // new inbox/<msgId>/meta.json files
	otherSenders      atomic.Int64 // statuses of other contacts (counted only, never stored)
	unmatchedLID      atomic.Int64 // subset of other_senders: @lid senders that could not be resolved
	undecryptable     atomic.Int64 // UndecryptableMessage in status@broadcast (Phase-0 target: 0)
	statusStanzas     atomic.Int64 // statuses that arrived as top-level <status> stanzas
	invalidID         atomic.Int64 // statuses / revokes with an id outside the contract's MsgId
	revokes           atomic.Int64 // revoke records written
	historyStatuses   atomic.Int64 // statuses seen in history syncs (StatusV3Messages)
	persistFailed     atomic.Int64 // history statuses that could not be written (live ones are not acked instead)
	handlerPanics     atomic.Int64 // recovered panics in the event handler (the message is not acked)
	mediaOK           atomic.Int64 // downloads verified and stored
	mediaFailed       atomic.Int64 // downloads that ended failed
	mediaRetry        atomic.Int64 // media-retry receipts sent to the phone
	mediaRetryAnswers atomic.Int64 // events.MediaRetry received
	invalidCommands   atomic.Int64 // stdin lines that were not valid commands
}

// counters returns the stats event's counters; mediaActive is the number of unfinished downloads.
func (s *stats) counters(mediaActive int) map[string]int64 {
	return map[string]int64{
		"captured":            s.captured.Load(),
		"other_senders":       s.otherSenders.Load(),
		"unmatched_lid":       s.unmatchedLID.Load(),
		"undecryptable":       s.undecryptable.Load(),
		"status_stanzas":      s.statusStanzas.Load(),
		"invalid_id":          s.invalidID.Load(),
		"revokes":             s.revokes.Load(),
		"history_statuses":    s.historyStatuses.Load(),
		"persist_failed":      s.persistFailed.Load(),
		"handler_panics":      s.handlerPanics.Load(),
		"media_ok":            s.mediaOK.Load(),
		"media_failed":        s.mediaFailed.Load(),
		"media_retry":         s.mediaRetry.Load(),
		"media_retry_answers": s.mediaRetryAnswers.Load(),
		"media_active":        int64(mediaActive),
		"invalid_commands":    s.invalidCommands.Load(),
	}
}
