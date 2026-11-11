package product

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicemembersettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicenote"
)

// Voice capture: docs/plans/voice-capture-and-evidence-plan.md and its
// implementation plan, docs/plans/voice-capture-implementation.md. A note is
// private to its owner; every read and write goes through ownedVoiceNote.

// VoiceNote is the sync and inbox view of a note.
type VoiceNote struct {
	ID                          string     `json:"id"`
	ClientNoteID                string     `json:"clientNoteId"`
	Title                       string     `json:"title"`
	ProjectID                   *string    `json:"projectId"`
	RecordedAt                  time.Time  `json:"recordedAt"`
	RecordedTimeZone            string     `json:"recordedTimeZone"`
	ReceivedAt                  time.Time  `json:"receivedAt"`
	Locale                      *string    `json:"locale"`
	DurationMs                  *int       `json:"durationMs"`
	AudioUploadConsent          bool       `json:"audioUploadConsent"`
	Revision                    int        `json:"revision"`
	Deleted                     bool       `json:"deleted"`
	DeletedAt                   *time.Time `json:"deletedAt"`
	CurrentTranscriptRevisionID *string    `json:"currentTranscriptRevisionId"`
	// TranscriptConflict is true when two revisions share a parent and
	// neither was chosen since (S6).
	TranscriptConflict bool      `json:"transcriptConflict"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// VoiceNoteDetail is a note with its transcript revisions, audio runs and
// command proposal.
type VoiceNoteDetail struct {
	VoiceNote
	Transcripts []VoiceTranscriptRevision `json:"transcripts"`
	Runs        []VoiceAudioRun           `json:"runs"`
	Command     *VoiceCommand             `json:"command"`
}

// VoiceTranscriptRevision is one insert-only transcript revision.
type VoiceTranscriptRevision struct {
	ID               string                `json:"id"`
	ClientRevisionID string                `json:"clientRevisionId"`
	ParentID         *string               `json:"parentId"`
	Origin           string                `json:"origin"`
	Locale           *string               `json:"locale"`
	Engine           *string               `json:"engine"`
	Text             string                `json:"text"`
	Segments         []schema.VoiceSegment `json:"segments"`
	Redacted         bool                  `json:"redacted"`
	CreatedByUserID  string                `json:"createdByUserId"`
	CreatedAt        time.Time             `json:"createdAt"`
}

// VoiceAudioRun is one uploaded recording run.
type VoiceAudioRun struct {
	RunIndex      int    `json:"runIndex"`
	StartOffsetMs int    `json:"startOffsetMs"`
	DurationMs    *int   `json:"durationMs"`
	SampleRateHz  *int   `json:"sampleRateHz"`
	ContentType   string `json:"contentType"`
	Bytes         int64  `json:"bytes"`
	SHA256        string `json:"sha256"`
	Status        string `json:"status"`
}

// VoiceWorkspaceFlags are the per-workspace switches, all off by default.
type VoiceWorkspaceFlags struct {
	VoiceNotes      bool `json:"voiceNotes"`
	AudioUpload     bool `json:"audioUpload"`
	DraftGeneration bool `json:"draftGeneration"`
	VoiceCommands   bool `json:"voiceCommands"`
}

// VoiceMemberChoices are one member's choices in one workspace.
type VoiceMemberChoices struct {
	RemoteTextConsentAt *time.Time `json:"remoteTextConsentAt"`
	VoiceCommands       bool       `json:"voiceCommands"`
}

func voiceNoteRecord(row *ent.VoiceNote, conflict bool) VoiceNote {
	return VoiceNote{
		ID: row.ID, ClientNoteID: row.ClientNoteID, Title: row.Title, ProjectID: row.ProjectID,
		RecordedAt: row.RecordedAt, RecordedTimeZone: row.RecordedTimeZone, ReceivedAt: row.ReceivedAt,
		Locale: row.Locale, DurationMs: row.DurationMs, AudioUploadConsent: row.AudioUploadConsent,
		Revision: row.Revision, Deleted: row.DeletedAt != nil, DeletedAt: row.DeletedAt,
		CurrentTranscriptRevisionID: row.CurrentTranscriptRevisionID, TranscriptConflict: conflict,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func voiceTranscriptRecord(row *ent.VoiceTranscriptRevision) VoiceTranscriptRevision {
	segments := row.Segments
	if segments == nil {
		segments = []schema.VoiceSegment{}
	}
	return VoiceTranscriptRevision{
		ID: row.ID, ClientRevisionID: row.ClientRevisionID, ParentID: row.ParentID, Origin: string(row.Origin),
		Locale: row.Locale, Engine: row.Engine, Text: row.Text, Segments: segments,
		Redacted: row.RedactedAt != nil, CreatedByUserID: row.CreatedByUserID, CreatedAt: row.CreatedAt,
	}
}

func voiceAudioRunRecord(row *ent.VoiceAudioRun) VoiceAudioRun {
	return VoiceAudioRun{
		RunIndex: row.RunIndex, StartOffsetMs: row.StartOffsetMs, DurationMs: row.DurationMs,
		SampleRateHz: row.SampleRateHz, ContentType: row.ContentType, Bytes: row.Bytes, SHA256: row.Sha256,
		Status: string(row.Status),
	}
}

// ownedVoiceNote reads a note of the signed-in member. Another member's note,
// even in the same workspace, is not found rather than forbidden, so its
// existence never leaks. Deleted tombstones are returned; callers decide.
func (c *Configuration) ownedVoiceNote(ctx context.Context, actor Actor, id string) (*ent.VoiceNote, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.VoiceNote.Query().Where(voicenote.ID(id), voicenote.OrganizationID(actor.OrganizationID),
		voicenote.OwnerUserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("This voice note was not found.")
	}
	return row, err
}

// voiceSettings reads the workspace's switches and the member's choices,
// with the defaults (all off) when nothing was saved.
func (c *Configuration) voiceSettings(ctx context.Context, actor Actor) (VoiceWorkspaceFlags, VoiceMemberChoices, error) {
	var flags VoiceWorkspaceFlags
	var choices VoiceMemberChoices
	row, err := c.client.VoiceSettings.Get(ctx, actor.OrganizationID)
	switch {
	case err == nil:
		flags = VoiceWorkspaceFlags{VoiceNotes: row.VoiceNotes, AudioUpload: row.AudioUpload,
			DraftGeneration: row.DraftGeneration, VoiceCommands: row.VoiceCommands}
	case !ent.IsNotFound(err):
		return flags, choices, err
	}
	member, err := c.client.VoiceMemberSettings.Query().Where(voicemembersettings.OrganizationID(actor.OrganizationID),
		voicemembersettings.UserID(actor.UserID)).Only(ctx)
	switch {
	case err == nil:
		choices = VoiceMemberChoices{RemoteTextConsentAt: member.RemoteTextConsentAt, VoiceCommands: member.VoiceCommands}
	case !ent.IsNotFound(err):
		return flags, choices, err
	}
	return flags, choices, nil
}

// Server-side switches (plan 6.9): each turns a voice feature off for every
// workspace without an app release.
const (
	voiceSwitchAll         = "VOICE_DISABLED"
	voiceSwitchAudioUpload = "VOICE_AUDIO_UPLOAD_DISABLED"
	voiceSwitchDrafts      = "VOICE_DRAFTS_DISABLED"
	voiceSwitchParse       = "VOICE_COMMANDS_PARSE_DISABLED"
	voiceSwitchConfirm     = "VOICE_COMMANDS_CONFIRM_DISABLED"
)

// voiceSwitchedOff reports whether a server-side switch is set to true.
func voiceSwitchedOff(name string) bool {
	off, _ := strconv.ParseBool(os.Getenv(name))
	return off || (name != voiceSwitchAll && voiceSwitchedOff(voiceSwitchAll))
}
