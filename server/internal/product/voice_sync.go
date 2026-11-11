package product

import (
	"context"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicecommand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicetranscriptrevision"
	"github.com/lucsky/cuid"
)

// Transcript revisions (implementation plan, section 4, rows 10-11) are
// insert-only: two devices editing offline produce two revisions, and the
// note shows that a choice is needed (S6).

// AddVoiceTranscriptInput is one revision as the phone or the web wrote it.
type AddVoiceTranscriptInput struct {
	ClientRevisionID string                `json:"clientRevisionId"`
	ParentID         *string               `json:"parentId"`
	Origin           string                `json:"origin"`
	Locale           *string               `json:"locale"`
	Engine           *string               `json:"engine"`
	Text             string                `json:"text"`
	Segments         []schema.VoiceSegment `json:"segments"`
}

// VoiceTranscriptResult is the stored revision, the note after it, and the
// command proposal parsed from it, if any.
type VoiceTranscriptResult struct {
	Revision VoiceTranscriptRevision `json:"revision"`
	Note     VoiceNote               `json:"note"`
	Command  *VoiceCommand           `json:"command"`
}

// voiceMaxRevisions bounds a note's transcript history.
const voiceMaxRevisions = 50

func validVoiceTranscript(input AddVoiceTranscriptInput) error {
	limit := voiceNoteLimits.MaxTranscriptChars
	switch {
	case input.ClientRevisionID == "" || len(input.ClientRevisionID) > 100 || strings.ContainsRune(input.ClientRevisionID, 0):
		return invalid("clientRevisionId must have 1 to 100 characters and no NUL characters.")
	case input.Origin != "on_device" && input.Origin != "remote" && input.Origin != "user_edit":
		return invalid("origin must be on_device, remote or user_edit.")
	case input.Locale != nil && !voiceLocalePattern.MatchString(*input.Locale):
		return invalid("locale must be a language tag of at most 35 characters.")
	case input.Engine != nil && (*input.Engine == "" || utf8.RuneCountInString(*input.Engine) > 64 || strings.ContainsRune(*input.Engine, 0)):
		return invalid("engine must have 1 to 64 characters and no NUL characters.")
	case utf8.RuneCountInString(input.Text) > limit:
		return invalid("A transcript has at most 100,000 characters.")
	case strings.ContainsRune(input.Text, 0):
		return invalid("A transcript cannot contain NUL characters.")
	}
	total := 0
	for _, segment := range input.Segments {
		total += utf8.RuneCountInString(segment.Text)
		if segment.StartMs < 0 || segment.EndMs < segment.StartMs || total > limit || strings.ContainsRune(segment.Text, 0) {
			return invalid("Each segment needs 0 <= startMs <= endMs and no NUL characters, and the segments at most 100,000 characters.")
		}
	}
	return nil
}

// becomesCurrent applies the current-revision rule: an edit by the member is
// current; the phone's transcript only when nothing is; a remote transcript
// never replaces the member's edit (S9).
func becomesCurrent(origin voicetranscriptrevision.Origin, current *ent.VoiceTranscriptRevision) bool {
	switch {
	case origin == voicetranscriptrevision.OriginUserEdit || current == nil:
		return true
	case origin == voicetranscriptrevision.OriginRemote:
		return current.Origin != voicetranscriptrevision.OriginUserEdit
	}
	return false
}

// AddVoiceTranscript stores a revision, idempotent on clientRevisionId: a
// replay returns the stored revision and never overwrites it. created is
// false on a replay. A new revision is parsed for a command proposal; a
// failed parse never fails the write (the sweep retries it).
func (c *Configuration) AddVoiceTranscript(ctx context.Context, actor Actor, noteID string, input AddVoiceTranscriptInput) (*VoiceTranscriptResult, bool, error) {
	if _, err := c.liveVoiceNote(ctx, actor, noteID); err != nil {
		return nil, false, err
	}
	if err := validVoiceTranscript(input); err != nil {
		return nil, false, err
	}
	if input.Segments == nil {
		input.Segments = []schema.VoiceSegment{}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	note, err := lockVoiceNote(ctx, tx, noteID)
	if err != nil {
		return nil, false, err
	}
	if note.DeletedAt != nil {
		return nil, false, voiceNoteDeleted()
	}
	revision, err := tx.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.NoteID(noteID),
		voicetranscriptrevision.ClientRevisionID(input.ClientRevisionID)).Only(ctx)
	created := ent.IsNotFound(err)
	if err != nil && !created {
		return nil, false, err
	}
	if created {
		revisions, err := tx.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.NoteID(noteID)).Count(ctx)
		if err != nil {
			return nil, false, err
		}
		if revisions >= voiceMaxRevisions {
			return nil, false, conflict("This note has 50 transcript revisions, the most a note may hold.")
		}
		if input.ParentID != nil {
			exists, err := tx.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.ID(*input.ParentID),
				voicetranscriptrevision.NoteID(noteID)).Exist(ctx)
			if err != nil {
				return nil, false, err
			}
			if !exists {
				return nil, false, invalid("parentId is not a revision of this note.")
			}
		}
		var current *ent.VoiceTranscriptRevision
		if note.CurrentTranscriptRevisionID != nil {
			if current, err = tx.VoiceTranscriptRevision.Get(ctx, *note.CurrentTranscriptRevisionID); err != nil {
				return nil, false, err
			}
		}
		origin := voicetranscriptrevision.Origin(input.Origin)
		revision, err = tx.VoiceTranscriptRevision.Create().SetID(cuid.New()).SetOrganizationID(note.OrganizationID).SetNoteID(noteID).
			SetClientRevisionID(input.ClientRevisionID).SetNillableParentID(input.ParentID).SetOrigin(origin).
			SetNillableLocale(input.Locale).SetNillableEngine(input.Engine).SetText(input.Text).SetSegments(input.Segments).
			SetCreatedByUserID(actor.UserID).Save(ctx)
		if err != nil {
			return nil, false, err
		}
		update := note.Update().AddRevision(1)
		if becomesCurrent(origin, current) {
			update.SetCurrentTranscriptRevisionID(revision.ID)
		}
		if note, err = update.Save(ctx); err != nil {
			return nil, false, err
		}
	}
	// The command row is queued with the revision, so a parse that fails below
	// still leaves it for the sweep (K25).
	var queued *ent.VoiceCommand
	var transcript string
	if created {
		if queued, transcript, err = c.queueVoiceCommandTx(ctx, tx, actor, note, revision.ID); err != nil {
			return nil, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	var command *VoiceCommand
	if created {
		if command, err = c.parseQueuedVoiceCommand(ctx, actor, note, queued, transcript); err != nil {
			slog.WarnContext(ctx, "voice command proposal failed", "noteId", noteID, "revisionId", revision.ID, "error", err)
			command = nil
		}
	} else if command, err = c.voiceCommandFor(ctx, actor, noteID); err != nil {
		return nil, false, err
	}
	view, err := c.voiceNoteView(ctx, note)
	if err != nil {
		return nil, false, err
	}
	return &VoiceTranscriptResult{Revision: voiceTranscriptRecord(revision), Note: view, Command: command}, created, nil
}

// RedactVoiceTranscript clears one revision's text and segments through the
// audited purge path (D1). A pending command proposal parsed from it is
// withdrawn. Redacting again changes nothing.
func (c *Configuration) RedactVoiceTranscript(ctx context.Context, actor Actor, noteID, revisionID string) (*VoiceTranscriptRevision, error) {
	if _, err := c.ownedVoiceNote(ctx, actor, noteID); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := lockVoiceNote(ctx, tx, noteID); err != nil {
		return nil, err
	}
	revision, err := tx.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.ID(revisionID), voicetranscriptrevision.NoteID(noteID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("This transcript revision was not found.")
	}
	if err != nil {
		return nil, err
	}
	if revision.RedactedAt == nil {
		if revision, err = redactVoiceTranscriptTx(ctx, tx, actor, revision); err != nil {
			return nil, err
		}
		if err := c.recordVoiceDeletion(ctx, "voice_transcript", revision.OrganizationID, revisionID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := voiceTranscriptRecord(revision)
	return &result, nil
}

// redactVoiceTranscriptTx clears a revision of a locked note: its text and
// segments, a pending proposal parsed from it, and the words of any command
// row that can no longer be confirmed. It audits the purge (D1).
func redactVoiceTranscriptTx(ctx context.Context, tx *ent.Tx, actor Actor, revision *ent.VoiceTranscriptRevision) (*ent.VoiceTranscriptRevision, error) {
	noteID := revision.NoteID
	revision, err := revision.Update().SetText("").SetSegments([]schema.VoiceSegment{}).SetRedactedAt(time.Now().UTC()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := tx.VoiceCommand.Update().Where(voicecommand.NoteID(noteID), voicecommand.TranscriptRevisionID(revision.ID),
		voicecommand.StatusIn(voicecommand.StatusWaiting, voicecommand.StatusProposed)).SetStatus(voicecommand.StatusWithdrawn).Save(ctx); err != nil {
		return nil, err
	}
	// A row withdrawn earlier may hold this revision's words under a newer revision's id.
	if err := scrubVoiceCommand(ctx, tx, noteID); err != nil {
		return nil, err
	}
	if err := tx.VoiceNote.UpdateOneID(noteID).AddRevision(1).Exec(ctx); err != nil {
		return nil, err
	}
	return revision, appendConfigurationAudit(ctx, tx, actor, "product.voice_transcript_redacted", "voice_transcript_revision", revision.ID,
		map[string]any{"noteId": noteID})
}
