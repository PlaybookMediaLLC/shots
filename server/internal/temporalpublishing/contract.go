package temporalpublishing

import (
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// FailureUnknownDelivery identifies a mutation without a confirmed remote receipt.
// Both social workflow generations stop resubmitting this failure class.
const FailureUnknownDelivery = "unknown_delivery"

const (
	WorkflowNameV1          = "PostWorkflowV1"
	WorkflowNameV2          = "PostWorkflowV2"
	MissingWorkflowName     = "MissingPostWorkflow"
	MissingWorkflowID       = "missing-post-workflow"
	PrepareActivityName     = "PreparePostPublication"
	PublishActivityName     = "PublishPost"
	MarkUnknownActivityName = "MarkPostDeliveryUnknown"
	BeginActivityName       = "BeginPostPublication"
	SubmitActivityName      = "SubmitPost"
	CheckActivityName       = "CheckPostStatus"
	CompleteActivityName    = "CompletePostPublication"
	FailActivityName        = "FailPostPublication"
	RecoverActivityName     = "RecoverMissingPosts"
	AutoActionsActivityName = "RunPostAutoActions"
	CancelSignalName        = "cancel"
	PokeSignalName          = "poke"
	DefaultWorkflowQueue    = "main"
	DefaultActivityQueue    = "social"
	// cutover: the activity queue before the rename. Workflows started earlier
	// carry it in their input; delete it once they drain.
	LegacyActivityQueue = "postiz"
)

const (
	OutcomePublished = "PUBLISHED"
	OutcomeRetry     = "RETRY"
	OutcomeFailed    = "FAILED"
	OutcomeCancelled = "CANCELLED"
	OutcomePending   = "PENDING"
	OutcomeSkipped   = "SKIPPED"
	OutcomeUnknown   = "UNKNOWN"
)

type WorkflowInput struct {
	ActivityTaskQueue string
	ActivityTimeout   time.Duration
	MaxAttempts       int
	MainTaskQueue     string
	OrganizationID    string
	PostID            string
	RetryDelay        time.Duration
	ScheduledFor      time.Time
}

type WorkflowResult struct {
	FailureCode string
	Outcome     string
	ProviderID  string
}

type CancelSignal struct{}

type PokeSignal struct{}

type PrepareInput struct {
	PostID string
	RunID  string
}

type PreparedPublication struct {
	// AssetMediaType and AssetObjectKey are Assets[0]. Jobs recorded before
	// Assets existed carry only these, so both stay.
	AssetMediaType string
	AssetObjectKey string
	Assets         []publishing.MediaAsset `json:",omitempty"`
	// Replies follow the post as a thread; jobs from before threads have none.
	Replies     []publishing.PublishReply `json:",omitempty"`
	ReplyTo     string                    `json:",omitempty"`
	AutoActions *postoptions.AutoActions  `json:",omitempty"`
	Poll        *postoptions.Poll         `json:",omitempty"`
	// Write (RFC 025): the post's settings, a LinkedIn document and an
	// article cover. Jobs recorded before them have none.
	Options          *postoptions.PublishOptions `json:",omitempty"`
	Document         *publishing.MediaAsset      `json:",omitempty"`
	Cover            *publishing.MediaAsset      `json:",omitempty"`
	Caption          string
	DestinationID    string
	OrganizationID   string
	Platform         string
	PostID           string
	ProviderSettings map[string]any
	Ready            bool
	SecretReference  string
}

type PublishInput struct {
	AttemptNumber int
	Job           PreparedPublication
	MaxAttempts   int
	RetryDelay    time.Duration
	RunID         string
}

type PublishResult struct {
	Progress    *postoptions.ThreadProgress `json:",omitempty"`
	FailureCode string
	NextAttempt int
	Outcome     string
	ProviderID  string
	RetryAfter  time.Duration
	// ProviderMessage is the provider's explanation of a failure, for the attempt record.
	ProviderMessage string `json:",omitempty"`
}

type BeginInput struct {
	AttemptNumber int
	Job           PreparedPublication
	RunID         string
}

type BeginResult struct {
	AttemptID     string
	AttemptNumber int
}

type SubmitInput struct {
	Job PreparedPublication
}

type CheckInput struct {
	Job        PreparedPublication
	ProviderID string
}

type CompleteInput struct {
	Progress   *postoptions.ThreadProgress `json:",omitempty"`
	AttemptID  string
	Job        PreparedPublication
	ProviderID string
	RunID      string
}

type FailInput struct {
	AttemptID     string
	AttemptNumber int
	FailureCode   string
	Job           PreparedPublication
	RetryAt       time.Time
	RunID         string
	// ProviderMessage is kept on the attempt, redacted; empty from older histories.
	ProviderMessage string `json:",omitempty"`
}

type MarkUnknownInput struct {
	Progress      *postoptions.ThreadProgress `json:",omitempty"`
	AttemptNumber int
	PostID        string
	RunID         string
	// ProviderMessage is kept on the attempt, redacted; empty from older histories.
	ProviderMessage string `json:",omitempty"`
}

type ScheduleInput struct {
	OrganizationID string
	PostID         string
	ScheduledFor   time.Time
}

func WorkflowID(postID string) string { return "post_" + postID }

// AutoActionsInput runs a live post's follow-ups that are due now.
type AutoActionsInput struct {
	Job          PreparedPublication
	ProviderID   string
	Repost, Plug bool
	Quote        bool
}

// AutoActionsResult reports the follow-ups that are done.
type AutoActionsResult struct {
	Plugged, Quoted, Reposted bool
}
