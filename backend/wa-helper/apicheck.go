package main

// Compile-time checks of the whatsmeow / modernc API surface documented in NOTES.md.
// Nothing here runs. If a whatsmeow pin bump changes one of these signatures or fields,
// `go build` fails here first, which tells us exactly which NOTES.md entry is stale.

import (
	"context"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waCompanionReg"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Function and method signatures.
var (
	_ func(context.Context, string, string, waLog.Logger) (*sqlstore.Container, error) = sqlstore.New
	_ func(*sqlstore.Container, context.Context) (*store.Device, error)                = (*sqlstore.Container).GetFirstDevice
	_ func(*sqlstore.Container, context.Context) error                                 = (*sqlstore.Container).Upgrade
	_ func(*store.Device, waLog.Logger) *whatsmeow.Client                              = whatsmeow.NewClient
	_ func(string, [3]uint32)                                                          = store.SetOSInfo

	_ func(*whatsmeow.Client, context.Context) (<-chan whatsmeow.QRChannelItem, error)                         = (*whatsmeow.Client).GetQRChannel
	_ func(*whatsmeow.Client, context.Context, string, bool, whatsmeow.PairClientType, string) (string, error) = (*whatsmeow.Client).PairPhone
	_ func(*whatsmeow.Client) error                                                                            = (*whatsmeow.Client).Connect
	_ func(*whatsmeow.Client, context.Context) error                                                           = (*whatsmeow.Client).ConnectContext
	_ func(*whatsmeow.Client)                                                                                  = (*whatsmeow.Client).Disconnect
	_ func(*whatsmeow.Client, context.Context) error                                                           = (*whatsmeow.Client).Logout
	_ func(*whatsmeow.Client) bool                                                                             = (*whatsmeow.Client).IsLoggedIn
	_ func(*whatsmeow.Client, whatsmeow.EventHandler) uint32                                                   = (*whatsmeow.Client).AddEventHandler
	_ func(*whatsmeow.Client, whatsmeow.EventHandlerWithSuccessStatus) uint32                                  = (*whatsmeow.Client).AddEventHandlerWithSuccessStatus
	_ func(*whatsmeow.Client, types.JID, *waWeb.WebMessageInfo) (*events.Message, error)                       = (*whatsmeow.Client).ParseWebMessage
	_ func(*whatsmeow.Client, context.Context, []string) ([]types.IsOnWhatsAppResponse, error)                 = (*whatsmeow.Client).IsOnWhatsApp
	_ func(*whatsmeow.Client, context.Context, []types.JID) (map[types.JID]types.UserInfo, error)              = (*whatsmeow.Client).GetUserInfo
	_ func(*events.Message) *events.Message                                                                    = (*events.Message).UnwrapRaw

	_ func(*whatsmeow.Client, context.Context, whatsmeow.DownloadableMessage) ([]byte, error)                                  = (*whatsmeow.Client).Download
	_ func(*whatsmeow.Client, context.Context, whatsmeow.DownloadableMessage, whatsmeow.File) error                            = (*whatsmeow.Client).DownloadToFile
	_ func(*whatsmeow.Client, context.Context, *waE2E.Message) ([]byte, error)                                                 = (*whatsmeow.Client).DownloadAny
	_ func(*whatsmeow.Client, context.Context, *types.MessageInfo, []byte) error                                               = (*whatsmeow.Client).SendMediaRetryReceipt
	_ func(*events.MediaRetry, []byte) (*waMmsRetry.MediaRetryNotification, error)                                             = whatsmeow.DecryptMediaRetryNotification
	_ func(*whatsmeow.Client, context.Context, []types.MessageID, time.Time, types.JID, types.JID, ...types.ReceiptType) error = (*whatsmeow.Client).MarkRead
	_ func(*whatsmeow.Client, context.Context, *waE2E.HistorySyncNotification, bool) (*waHistorySync.HistorySync, error)       = (*whatsmeow.Client).DownloadHistorySync
	_ func(*whatsmeow.Client, context.Context, types.MessageID, types.ReceiptType) error                                       = (*whatsmeow.Client).SendProtocolMessageReceipt

	_ store.LIDStore                                                     = (*sqlstore.CachedLIDMap)(nil)
	_ func(*store.Device, context.Context, types.JID) (types.JID, error) = (*store.Device).GetAltJID

	_ error = whatsmeow.ErrMediaDownloadFailedWith403
	_ error = whatsmeow.ErrMediaDownloadFailedWith404
	_ error = whatsmeow.ErrMediaDownloadFailedWith410
	_ error = whatsmeow.ErrInvalidMediaSHA256
	_ error = whatsmeow.ErrMediaNotAvailableOnPhone
	_ error = whatsmeow.ErrNoURLPresent
	_ error = whatsmeow.ErrInvalidMediaEncSHA256
	_ error = whatsmeow.ErrInvalidMediaHMAC
	_ error = whatsmeow.ErrInvalidUnencryptedMediaSHA256
	_ error = whatsmeow.ErrTooShortFile
	_ error = whatsmeow.ErrNotConnected
	_ error = whatsmeow.ErrIQTimedOut
	_ error = whatsmeow.ErrIQDisconnected
	_ error = whatsmeow.ErrUnknownMediaRetryError
	_ error = whatsmeow.DownloadHTTPError{}
)

// Client options and constants.
var _ = func(cli *whatsmeow.Client) {
	cli.SynchronousAck = true
	cli.EnableDecryptedEventBuffer = true
	cli.ManualHistorySyncDownload = false
	cli.DisableManualHistorySyncReceipt = false
	cli.EnableAutoReconnect = true
	cli.AutoReconnectHook = func(error) bool { return true }
	cli.BackgroundEventCtx = context.Background()
	store.DeviceProps.PlatformType = waCompanionReg.DeviceProps_DESKTOP.Enum()
	_ = []whatsmeow.PairClientType{whatsmeow.PairClientChrome, whatsmeow.PairClientFirefox, whatsmeow.PairClientSafari, whatsmeow.PairClientEdge}
	_ = []string{whatsmeow.QRChannelEventCode, whatsmeow.QRChannelEventError, whatsmeow.QRChannelSuccess.Event, whatsmeow.QRChannelTimeout.Event}
	_ = types.StatusBroadcastJID
	_ = []waHistorySync.HistorySync_HistorySyncType{waHistorySync.HistorySync_INITIAL_STATUS_V3, waHistorySync.HistorySync_INITIAL_BOOTSTRAP, waHistorySync.HistorySync_RECENT}
	_ = []waMmsRetry.MediaRetryNotification_ResultType{waMmsRetry.MediaRetryNotification_SUCCESS, waMmsRetry.MediaRetryNotification_NOT_FOUND,
		waMmsRetry.MediaRetryNotification_GENERAL_ERROR, waMmsRetry.MediaRetryNotification_DECRYPTION_ERROR}
	_ = (*waMmsRetry.MediaRetryNotification)(nil).GetStanzaID
	_ = (*waMmsRetry.MediaRetryNotification)(nil).GetDirectPath
	_ = []string{whatsmeow.QRChannelEventPasskeyRequest, whatsmeow.QRChannelClientOutdated.Event,
		whatsmeow.QRChannelScannedWithoutMultidevice.Event, whatsmeow.QRChannelErrUnexpectedEvent.Event}
	_ = types.ReceiptTypeHistorySync
}

// Event fields.
var _ = func(m *events.Message, u *events.UndecryptableMessage, hs *events.HistorySync, mr *events.MediaRetry,
	lo *events.LoggedOut, tb *events.TemporaryBan, ka *events.KeepAliveTimeout, cf *events.ConnectFailure, ps *events.PairSuccess,
) {
	var (
		_ types.JID             = m.Info.Chat
		_ types.JID             = m.Info.Sender
		_ types.JID             = m.Info.SenderAlt
		_ types.AddressingMode  = m.Info.AddressingMode
		_ bool                  = m.Info.IsFromMe
		_ bool                  = m.Info.IsGroup
		_ time.Time             = m.Info.Timestamp
		_ types.MessageID       = m.Info.ID
		_ string                = m.Info.PushName
		_ string                = m.Info.StanzaTag
		_ string                = m.Info.MediaType
		_ *waE2E.Message        = m.Message
		_ *waE2E.Message        = m.RawMessage
		_ *waWeb.WebMessageInfo = m.SourceWebMsg
		_ bool                  = m.IsViewOnce
		_ int                   = m.RetryCount
		_ types.MessageInfo     = u.Info
		_ bool                  = u.IsUnavailable

		_ *waHistorySync.HistorySync                = hs.Data
		_ *waE2E.HistorySyncNotification            = hs.Notification
		_ []*waWeb.WebMessageInfo                   = hs.Data.GetStatusV3Messages()
		_ waHistorySync.HistorySync_HistorySyncType = hs.Data.GetSyncType()

		_ types.MessageID         = mr.MessageID
		_ types.JID               = mr.ChatID
		_ types.JID               = mr.SenderID
		_ bool                    = mr.FromMe
		_ []byte                  = mr.Ciphertext
		_ *events.MediaRetryError = mr.Error

		_ string                      = mr.MessageID
		_ int                         = mr.Error.Code
		_ bool                        = lo.OnConnect
		_ events.ConnectFailureReason = lo.Reason
		_ events.TempBanReason        = tb.Code
		_ time.Duration               = tb.Expire
		_ int                         = ka.ErrorCount
		_ time.Time                   = ka.LastSuccess
		_ events.ConnectFailureReason = cf.Reason
		_ string                      = cf.Message
		_ types.JID                   = ps.ID
		_ types.JID                   = ps.LID
	)
	_ = events.Connected{}
	_ = events.Disconnected{}
	_ = events.StreamReplaced{}
	_ = events.KeepAliveRestored{}
	_ = events.ClientOutdated{}
	_ = events.CATRefreshError{}.Error
	_ = events.OfflineSyncCompleted{}.Count
}

// Message proto fields used for status kinds.
var _ = func(msg *waE2E.Message) {
	var (
		_ string                             = msg.GetConversation()
		_ uint32                             = msg.GetExtendedTextMessage().GetBackgroundArgb()
		_ uint32                             = msg.GetExtendedTextMessage().GetTextArgb()
		_ waE2E.ExtendedTextMessage_FontType = msg.GetExtendedTextMessage().GetFont()
		_ string                             = msg.GetExtendedTextMessage().GetText()

		_ string = msg.GetImageMessage().GetCaption()
		_ uint32 = msg.GetImageMessage().GetWidth()
		_ uint32 = msg.GetImageMessage().GetHeight()
		_ []byte = msg.GetImageMessage().GetFileSHA256()
		_ []byte = msg.GetImageMessage().GetMediaKey()
		_ string = msg.GetImageMessage().GetMimetype()

		_ bool   = msg.GetVideoMessage().GetGifPlayback()
		_ uint32 = msg.GetVideoMessage().GetSeconds()
		_ uint32 = msg.GetVideoMessage().GetWidth()
		_ uint32 = msg.GetVideoMessage().GetHeight()
		_ string = msg.GetVideoMessage().GetCaption()

		_ bool   = msg.GetAudioMessage().GetPTT()
		_ []byte = msg.GetAudioMessage().GetWaveform()
		_ uint32 = msg.GetAudioMessage().GetSeconds()
		_ uint32 = msg.GetAudioMessage().GetBackgroundArgb()

		_ waE2E.ProtocolMessage_Type = msg.GetProtocolMessage().GetType()
		_ *waCommon.MessageKey       = msg.GetProtocolMessage().GetKey()
	)
	_ = []waE2E.ExtendedTextMessage_FontType{
		waE2E.ExtendedTextMessage_SYSTEM, waE2E.ExtendedTextMessage_SYSTEM_TEXT, waE2E.ExtendedTextMessage_FB_SCRIPT,
		waE2E.ExtendedTextMessage_SYSTEM_BOLD, waE2E.ExtendedTextMessage_MORNINGBREEZE_REGULAR,
		waE2E.ExtendedTextMessage_CALISTOGA_REGULAR, waE2E.ExtendedTextMessage_EXO2_EXTRABOLD,
		waE2E.ExtendedTextMessage_COURIERPRIME_BOLD,
	}
	_ = waE2E.ProtocolMessage_REVOKE
	var _ whatsmeow.DownloadableMessage = msg.GetImageMessage()
	var _ whatsmeow.DownloadableMessage = msg.GetVideoMessage()
	var _ whatsmeow.DownloadableMessage = msg.GetAudioMessage()
}
