package product

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicemembersettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// VoiceSettings is what the phone and the web read before recording or
// syncing (implementation plan, section 4, rows 1-3).
type VoiceSettings struct {
	Workspace VoiceWorkspaceFlags `json:"workspace"`
	Member    VoiceMemberChoices  `json:"member"`
	CanManage bool                `json:"canManage"`
	// MinAppVersion is the oldest app that may sync, 0.0.0 when the server sets
	// none; the app enforces it (S17).
	MinAppVersion string        `json:"minAppVersion"`
	Limits        VoiceLimits   `json:"limits"`
	Switches      VoiceSwitches `json:"switches"`
}

// VoiceLimits are the recording and text limits the app applies.
type VoiceLimits struct {
	MaxNoteMs          int `json:"maxNoteMs"`
	WarnAtMs           int `json:"warnAtMs"`
	MinNoteMs          int `json:"minNoteMs"`
	MaxTranscriptChars int `json:"maxTranscriptChars"`
	MaxCommandChars    int `json:"maxCommandChars"`
}

// VoiceSwitches is true for each feature the server-side switches leave on.
type VoiceSwitches struct {
	Notes       bool `json:"notes"`
	AudioUpload bool `json:"audioUpload"`
	Drafts      bool `json:"drafts"`
	Parse       bool `json:"parse"`
	Confirm     bool `json:"confirm"`
}

// voiceNoteLimits: 30 minutes with a warning at 25 (owner decision 5).
var voiceNoteLimits = VoiceLimits{MaxNoteMs: 30 * 60 * 1000, WarnAtMs: 25 * 60 * 1000, MinNoteMs: 1000,
	MaxTranscriptChars: 100000, MaxCommandChars: voiceCommandTextLimit}

// VoiceWorkspaceFlagsInput changes only the flags it names.
type VoiceWorkspaceFlagsInput struct {
	VoiceNotes      *bool `json:"voiceNotes"`
	AudioUpload     *bool `json:"audioUpload"`
	DraftGeneration *bool `json:"draftGeneration"`
	VoiceCommands   *bool `json:"voiceCommands"`
}

// VoiceMemberSettingsInput changes only the choices it names.
type VoiceMemberSettingsInput struct {
	RemoteTextConsent *bool `json:"remoteTextConsent"`
	VoiceCommands     *bool `json:"voiceCommands"`
}

// GetVoiceSettings returns the workspace flags, the member's choices and the
// server's limits and switches to any signed-in member.
func (c *Configuration) GetVoiceSettings(ctx context.Context, actor Actor) (*VoiceSettings, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	flags, choices, err := c.voiceSettings(ctx, actor)
	if err != nil {
		return nil, err
	}
	canManage := true
	if err := c.authorizeRoles(ctx, actor, "owner", "admin"); errors.Is(err, publishing.ErrForbidden) {
		canManage = false
	} else if err != nil {
		return nil, err
	}
	minimum := os.Getenv("VOICE_MIN_APP_VERSION")
	if minimum == "" {
		minimum = "0.0.0"
	}
	return &VoiceSettings{Workspace: flags, Member: choices, CanManage: canManage, MinAppVersion: minimum, Limits: voiceNoteLimits,
		Switches: VoiceSwitches{Notes: !voiceSwitchedOff(voiceSwitchAll), AudioUpload: !voiceSwitchedOff(voiceSwitchAudioUpload),
			Drafts: !voiceSwitchedOff(voiceSwitchDrafts), Parse: !voiceSwitchedOff(voiceSwitchParse), Confirm: !voiceSwitchedOff(voiceSwitchConfirm)}}, nil
}

// UpdateVoiceWorkspaceSettings changes the workspace's voice flags. Only an
// owner or admin, signed in, may; every change is audited.
func (c *Configuration) UpdateVoiceWorkspaceSettings(ctx context.Context, actor Actor, input VoiceWorkspaceFlagsInput) (*VoiceSettings, error) {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin"); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('voice-settings:' || $1))`, actor.OrganizationID); err != nil {
		return nil, err
	}
	var before VoiceWorkspaceFlags
	row, err := tx.VoiceSettings.Get(ctx, actor.OrganizationID)
	switch {
	case err == nil:
		before = VoiceWorkspaceFlags{VoiceNotes: row.VoiceNotes, AudioUpload: row.AudioUpload, DraftGeneration: row.DraftGeneration, VoiceCommands: row.VoiceCommands}
	case !ent.IsNotFound(err):
		return nil, err
	}
	after := before
	for _, change := range []struct {
		value  *bool
		target *bool
	}{{input.VoiceNotes, &after.VoiceNotes}, {input.AudioUpload, &after.AudioUpload},
		{input.DraftGeneration, &after.DraftGeneration}, {input.VoiceCommands, &after.VoiceCommands}} {
		if change.value != nil {
			*change.target = *change.value
		}
	}
	if row == nil {
		err = tx.VoiceSettings.Create().SetID(actor.OrganizationID).SetVoiceNotes(after.VoiceNotes).SetAudioUpload(after.AudioUpload).
			SetDraftGeneration(after.DraftGeneration).SetVoiceCommands(after.VoiceCommands).SetUpdatedByUserID(actor.UserID).Exec(ctx)
	} else {
		err = row.Update().SetVoiceNotes(after.VoiceNotes).SetAudioUpload(after.AudioUpload).SetDraftGeneration(after.DraftGeneration).
			SetVoiceCommands(after.VoiceCommands).SetUpdatedByUserID(actor.UserID).Exec(ctx)
	}
	if err != nil {
		return nil, err
	}
	if after != before {
		if err := appendConfigurationAudit(ctx, tx, actor, "product.voice_settings_updated", "voice_settings", actor.OrganizationID,
			map[string]any{"before": before, "after": after}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetVoiceSettings(ctx, actor)
}

// UpdateVoiceMemberSettings changes the member's own choices. Commands send
// transcript text to a model, so they need the consent; withdrawing consent
// turns them off (the table's check enforces the pair).
func (c *Configuration) UpdateVoiceMemberSettings(ctx context.Context, actor Actor, input VoiceMemberSettingsInput) (*VoiceSettings, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('voice-member:' || $1 || ':' || $2))`, actor.OrganizationID, actor.UserID); err != nil {
		return nil, err
	}
	row, err := tx.VoiceMemberSettings.Query().Where(voicemembersettings.OrganizationID(actor.OrganizationID),
		voicemembersettings.UserID(actor.UserID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	var choices VoiceMemberChoices
	if row != nil {
		choices = VoiceMemberChoices{RemoteTextConsentAt: row.RemoteTextConsentAt, VoiceCommands: row.VoiceCommands}
	}
	if input.RemoteTextConsent != nil {
		switch {
		case !*input.RemoteTextConsent:
			choices.RemoteTextConsentAt, choices.VoiceCommands = nil, false
		case choices.RemoteTextConsentAt == nil:
			now := time.Now().UTC()
			choices.RemoteTextConsentAt = &now
		}
	}
	if input.VoiceCommands != nil {
		if *input.VoiceCommands && choices.RemoteTextConsentAt == nil {
			return nil, invalid("Voice commands send your transcripts to a model provider. Consent to that first.")
		}
		choices.VoiceCommands = *input.VoiceCommands
	}
	if row == nil {
		err = tx.VoiceMemberSettings.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetUserID(actor.UserID).
			SetNillableRemoteTextConsentAt(choices.RemoteTextConsentAt).SetVoiceCommands(choices.VoiceCommands).Exec(ctx)
	} else {
		update := row.Update().SetVoiceCommands(choices.VoiceCommands)
		if choices.RemoteTextConsentAt == nil {
			update.ClearRemoteTextConsentAt()
		} else {
			update.SetRemoteTextConsentAt(*choices.RemoteTextConsentAt)
		}
		err = update.Exec(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetVoiceSettings(ctx, actor)
}
