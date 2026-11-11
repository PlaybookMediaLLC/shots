package publishing

import (
	"errors"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

var (
	ErrUnauthorized = errors.New("publishing session is invalid or expired")
	ErrForbidden    = errors.New("publishing permission is denied")
	ErrConflict     = errors.New("publishing resource already exists")
	ErrInvalidState = errors.New("publishing resource is in an invalid state")
	ErrNotFound     = errors.New("publishing resource was not found")
	ErrNotEligible  = errors.New("creative variant is not approved for publishing")
)

type Actor struct {
	Display      string
	Organization string
	RequestID    string
	Type         string
	UserID       string
}

type CreateConnectionInput struct {
	ExternalAccountID string
	Platform          string
	ProviderSettings  map[string]any
	SecretReference   string
	// SocialSetID is the set the account joins; nil is the default set.
	SocialSetID *string
}

type CreateScheduledPostInput struct {
	Caption             string
	ChannelConnectionID string
	IdempotencyKey      string
	ScheduledFor        time.Time
	// Exactly one of VariantID and ContentDraftID is set.
	VariantID      string
	ContentDraftID string
	// ScheduledBy is who queued the post, set by the product layer from its
	// actor; a request body or MCP arguments can never set it.
	ScheduledBy *string `json:"-"`
}

type CreateScheduledPostResult struct {
	Created bool
	Post    *ent.ScheduledPost
}

// MediaAsset is one stored file a post publishes.
type MediaAsset struct {
	DurationMs *int   `json:",omitempty"`
	AssetID    string `json:",omitempty"`
	MediaType  string
	ObjectKey  string
	// Alt describes an image (RFC 025); jobs recorded before it have none.
	Alt string `json:",omitempty"`
}

// PublishReply is a thread reply to publish after the post: its text and files.
type PublishReply struct {
	Assets  []MediaAsset
	Caption string
	// Options are the reply's own settings (RFC 025); replies from before
	// them have none.
	Options *postoptions.PublishOptions `json:",omitempty"`
	Poll    *postoptions.Poll           `json:",omitempty"`
}

type PublishJob struct {
	// AssetObjectKey and AssetMediaType are Assets[0], for callers that take one.
	AssetObjectKey string
	AssetMediaType string
	Assets         []MediaAsset
	// Replies follow the post as a thread, each answering the one before.
	Replies []PublishReply
	// ReplyTo is the live post a resumed thread answers; empty for a new post.
	ReplyTo     string
	AutoActions postoptions.AutoActions
	Poll        postoptions.Poll
	// Options are the first post's settings beyond its text (RFC 025).
	Options postoptions.PublishOptions
	// Document is a LinkedIn PDF posted as a document carousel; Cover is an
	// X article's cover image.
	Document        *MediaAsset
	Cover           *MediaAsset
	Connection      *ent.ChannelConnection
	Post            *ent.ScheduledPost
	WorkspaceActive bool
	// Ineligible says why a job may not publish when WorkspaceActive is false.
	Ineligible string
}

// Why a post did not publish, kept as its failure code. Provider failures
// keep the provider's status (see ProviderFailureCode).
const (
	// The workspace is being deleted, or the post's content was removed.
	FailureWorkspaceInactive = "WORKSPACE_INACTIVE"
	// The account was disconnected or removed from the workspace.
	FailureAccountUnavailable = "ACCOUNT_UNAVAILABLE"
	// A campaign variant is no longer approved.
	FailureApprovalRequired = "APPROVAL_REQUIRED"
	// The workspace approves drafts and a reviewer sent this one back.
	FailureChangesRequested = "CHANGES_REQUESTED"
	// An image, video or document was deleted before the post went out.
	FailureMediaUnavailable = "MEDIA_UNAVAILABLE"
	// The post could not start within the late publication window.
	FailureMissedWindow = "MISSED_WINDOW"
	// The provider may have received it; a person reconciles before a retry.
	FailureUnknownDelivery = "UNKNOWN_DELIVERY"
	// A person checked an unknown delivery and found it was not published.
	FailureNotLive = "NOT_LIVE"
	// The publisher refused before the post was published, for a named cause.
	// The account must be reconnected.
	FailureAccountReconnect = "ACCOUNT_RECONNECT"
	// The platform did not return the account's posting permissions.
	FailureProviderPermissions = "PROVIDER_PERMISSIONS"
	// The account cannot post with the chosen post options.
	FailurePostOptions = "POST_OPTIONS"
	// The video is longer than the account may post.
	FailureVideoTooLong = "VIDEO_TOO_LONG"
	// The platform does not take this media.
	FailureMediaUnsupported = "MEDIA_UNSUPPORTED"
	// Shots' publishing service is not configured or reachable.
	FailurePublisherUnavailable = "PUBLISHER_UNAVAILABLE"
	// Shots failed before the handoff, with no provider status.
	FailurePublisherError = "PUBLISHER_ERROR"
)

// StalledPost is a claimed post that has made no progress for a while.
type StalledPost struct {
	ID             string
	OrganizationID string
	RunID          string
}

type Attempt struct {
	ID     string
	Number int
}

type RecoverablePost struct {
	ID             string
	OrganizationID string
	ScheduledFor   time.Time
}

// AutomationReceipt is a live post's follow-up to record (RFC 025): its
// key, its kind and when it is first due.
type AutomationReceipt struct {
	DueAt time.Time
	Key   string
	Kind  string
}
