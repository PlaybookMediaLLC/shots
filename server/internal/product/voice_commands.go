package product

import (
	"context"
	"time"
)

// VoiceCommand is the confirmation card's view of a proposal (plan 5.4).
type VoiceCommand struct {
	ID                   string                  `json:"id"`
	TranscriptRevisionID string                  `json:"transcriptRevisionId"`
	Status               string                  `json:"status"`
	Action               string                  `json:"action"`
	Platform             *string                 `json:"platform"`
	Text                 *string                 `json:"text"`
	LocalTime            *string                 `json:"localTime"`
	TimeZone             string                  `json:"timeZone"`
	ScheduledFor         *time.Time              `json:"scheduledFor"`
	ChannelConnectionID  *string                 `json:"channelConnectionId"`
	Candidates           []VoiceCommandCandidate `json:"candidates"`
	Guessed              []string                `json:"guessed"`
	Flags                []string                `json:"flags"`
	AddedWords           []string                `json:"addedWords"`
	Notice               *string                 `json:"notice"`
	ContentDraftID       *string                 `json:"contentDraftId"`
	ScheduledPostID      *string                 `json:"scheduledPostId"`
	FailureReason        *string                 `json:"failureReason"`
	ExpiresAt            *time.Time              `json:"expiresAt"`
}

// VoiceCommandCandidate is a connected account the member may post to.
type VoiceCommandCandidate struct {
	ChannelConnectionID string `json:"channelConnectionId"`
	Platform            string `json:"platform"`
	Name                string `json:"name"`
}

// proposeVoiceCommand parses a new transcript revision into a proposal when
// the workspace and the member have voice commands on. It returns nil when no
// proposal applies. The voice-commands workstream implements it.
func (c *Configuration) proposeVoiceCommand(ctx context.Context, actor Actor, noteID, revisionID string) (*VoiceCommand, error) {
	return nil, nil
}

// voiceCommandFor returns the note's proposal, or nil. The voice-commands
// workstream implements it.
func (c *Configuration) voiceCommandFor(ctx context.Context, actor Actor, noteID string) (*VoiceCommand, error) {
	return nil, nil
}
