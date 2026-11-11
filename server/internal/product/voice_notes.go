package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/project"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voiceaudiorun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicecommand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicenote"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicetranscriptrevision"
	"github.com/lucsky/cuid"
)

// Voice notes (implementation plan, section 4, rows 4-9). Each write is
// idempotent by its own key (plan 5.2); a deleted note stays as a tombstone
// so a replay from an offline phone answers 409 instead of recreating it.

// VoiceNoteIndexEntry is one row of the sync list comparison (plan 5.2).
type VoiceNoteIndexEntry struct {
	ID           string `json:"id"`
	ClientNoteID string `json:"clientNoteId"`
	Revision     int    `json:"revision"`
	Deleted      bool   `json:"deleted"`
}

// VoiceNoteListItem is a note in the inbox with the start of its current transcript.
type VoiceNoteListItem struct {
	VoiceNote
	Excerpt string `json:"excerpt"`
}

// VoiceNotePage is one inbox page, newest received first.
type VoiceNotePage struct {
	Notes      []VoiceNoteListItem `json:"notes"`
	NextCursor *string             `json:"nextCursor"`
}

// VoiceNoteListQuery pages the inbox.
type VoiceNoteListQuery struct {
	Limit  int
	Cursor string
}

// CreateVoiceNoteInput is a note as the phone recorded it.
type CreateVoiceNoteInput struct {
	ClientNoteID       string    `json:"clientNoteId"`
	Title              *string   `json:"title"`
	ProjectID          *string   `json:"projectId"`
	RecordedAt         time.Time `json:"recordedAt"`
	RecordedTimeZone   string    `json:"recordedTimeZone"`
	Locale             *string   `json:"locale"`
	DurationMs         *int      `json:"durationMs"`
	AudioUploadConsent *bool     `json:"audioUploadConsent"`
}

// UpdateVoiceNoteInput changes a note's labels. A null projectId clears it.
type UpdateVoiceNoteInput struct {
	ExpectedRevision int                   `json:"expectedRevision"`
	Title            *string               `json:"title"`
	ProjectID        OptionalValue[string] `json:"projectId"`
}

var voiceLocalePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,35}$`)

const voiceExcerptRunes = 200

// requireVoiceNotes refuses voice note work unless the server switch and the
// workspace both leave voice notes on. Deleting and redacting skip it: a
// member can always remove their own recordings.
func (c *Configuration) requireVoiceNotes(ctx context.Context, actor Actor) error {
	if voiceSwitchedOff(voiceSwitchAll) {
		return forbidden("Voice notes are turned off on this server.")
	}
	flags, _, err := c.voiceSettings(ctx, actor)
	if err != nil {
		return err
	}
	if !flags.VoiceNotes {
		return forbidden("Voice notes are off in this workspace.")
	}
	return nil
}

// openVoiceNotes admits a signed-in member to the workspace's voice notes.
func (c *Configuration) openVoiceNotes(ctx context.Context, actor Actor) error {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return err
	}
	return c.requireVoiceNotes(ctx, actor)
}

// liveVoiceNote reads the member's note for a change: voice notes must be on
// and the note not deleted (S7, S8).
func (c *Configuration) liveVoiceNote(ctx context.Context, actor Actor, id string) (*ent.VoiceNote, error) {
	row, err := c.ownedVoiceNote(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if err := c.requireVoiceNotes(ctx, actor); err != nil {
		return nil, err
	}
	if row.DeletedAt != nil {
		return nil, voiceNoteDeleted()
	}
	return row, nil
}

func voiceNoteDeleted() error { return conflict("This voice note was deleted.") }

// lockVoiceNote locks a note's row for the transaction and reads it again, so
// a concurrent delete or revision bump is seen.
func lockVoiceNote(ctx context.Context, tx *ent.Tx, id string) (*ent.VoiceNote, error) {
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM voice_note WHERE id=$1 FOR UPDATE`, id); err != nil {
		return nil, err
	}
	return tx.VoiceNote.Get(ctx, id)
}

// voiceRevisionLink is a revision's place in its note's history.
type voiceRevisionLink struct {
	id       string
	parentID *string
}

// transcriptConflict reports two revisions of one parent that nobody has
// chosen between since (S6). A pair is settled once the current revision
// descends from one of them: an edit made on top of the chosen text.
func transcriptConflict(links []voiceRevisionLink, current *string) bool {
	parent := map[string]string{}
	children := map[string]int{}
	for _, link := range links {
		if link.parentID != nil {
			parent[link.id] = *link.parentID
			children[*link.parentID]++
		}
	}
	settled := map[string]bool{}
	if current != nil {
		// Each strict ancestor of the current revision settles its siblings.
		ancestor, ok := parent[*current]
		for steps := 0; ok && steps < len(links); steps++ {
			var next string
			if next, ok = parent[ancestor]; ok {
				settled[next] = true
				ancestor = next
			}
		}
	}
	for id, count := range children {
		if count > 1 && !settled[id] {
			return true
		}
	}
	return false
}

// voiceNoteDetail reads a note's revisions, runs and command proposal.
func (c *Configuration) voiceNoteDetail(ctx context.Context, actor Actor, row *ent.VoiceNote) (*VoiceNoteDetail, error) {
	revisions, err := c.client.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.OrganizationID(row.OrganizationID),
		voicetranscriptrevision.NoteID(row.ID)).Order(ent.Asc(voicetranscriptrevision.FieldCreatedAt), ent.Asc(voicetranscriptrevision.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	runs, err := c.client.VoiceAudioRun.Query().Where(voiceaudiorun.OrganizationID(row.OrganizationID), voiceaudiorun.NoteID(row.ID)).
		Order(ent.Asc(voiceaudiorun.FieldRunIndex)).All(ctx)
	if err != nil {
		return nil, err
	}
	command, err := c.voiceCommandFor(ctx, actor, row.ID)
	if err != nil {
		return nil, err
	}
	links := make([]voiceRevisionLink, len(revisions))
	detail := &VoiceNoteDetail{Transcripts: make([]VoiceTranscriptRevision, len(revisions)), Runs: make([]VoiceAudioRun, len(runs)), Command: command}
	for i, revision := range revisions {
		links[i] = voiceRevisionLink{id: revision.ID, parentID: revision.ParentID}
		detail.Transcripts[i] = voiceTranscriptRecord(revision)
	}
	for i, run := range runs {
		detail.Runs[i] = voiceAudioRunRecord(run)
	}
	detail.VoiceNote = voiceNoteRecord(row, transcriptConflict(links, row.CurrentTranscriptRevisionID))
	return detail, nil
}

// voiceNoteView is the note alone, with its conflict flag.
func (c *Configuration) voiceNoteView(ctx context.Context, row *ent.VoiceNote) (VoiceNote, error) {
	conflicts, err := c.voiceConflicts(ctx, row.OrganizationID, []*ent.VoiceNote{row})
	if err != nil {
		return VoiceNote{}, err
	}
	return voiceNoteRecord(row, conflicts[row.ID]), nil
}

// voiceConflicts computes each note's conflict flag from the revisions' ids
// and parents alone, never their text.
func (c *Configuration) voiceConflicts(ctx context.Context, organizationID string, rows []*ent.VoiceNote) (map[string]bool, error) {
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.ID
	}
	revisions, err := c.client.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.OrganizationID(organizationID),
		voicetranscriptrevision.NoteIDIn(ids...)).Select(voicetranscriptrevision.FieldID, voicetranscriptrevision.FieldNoteID,
		voicetranscriptrevision.FieldParentID).All(ctx)
	if err != nil {
		return nil, err
	}
	links := map[string][]voiceRevisionLink{}
	for _, revision := range revisions {
		links[revision.NoteID] = append(links[revision.NoteID], voiceRevisionLink{id: revision.ID, parentID: revision.ParentID})
	}
	conflicts := make(map[string]bool, len(rows))
	for _, row := range rows {
		conflicts[row.ID] = transcriptConflict(links[row.ID], row.CurrentTranscriptRevisionID)
	}
	return conflicts, nil
}

// ListVoiceNoteIndex returns every note of the member in this workspace,
// tombstones included, for the phone to compare with its own list.
func (c *Configuration) ListVoiceNoteIndex(ctx context.Context, actor Actor) ([]VoiceNoteIndexEntry, error) {
	if err := c.openVoiceNotes(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.VoiceNote.Query().Where(voicenote.OrganizationID(actor.OrganizationID), voicenote.OwnerUserID(actor.UserID)).
		Order(ent.Asc(voicenote.FieldReceivedAt), ent.Asc(voicenote.FieldID)).
		Select(voicenote.FieldID, voicenote.FieldClientNoteID, voicenote.FieldRevision, voicenote.FieldDeletedAt).All(ctx)
	if err != nil {
		return nil, err
	}
	entries := make([]VoiceNoteIndexEntry, len(rows))
	for i, row := range rows {
		entries[i] = VoiceNoteIndexEntry{ID: row.ID, ClientNoteID: row.ClientNoteID, Revision: row.Revision, Deleted: row.DeletedAt != nil}
	}
	return entries, nil
}

type voiceNoteCursor struct {
	ID         string    `json:"id"`
	ReceivedAt time.Time `json:"r"`
}

// ListVoiceNotes is the member's inbox: live notes, newest received first
// (S14: the server's clock, not the phone's).
func (c *Configuration) ListVoiceNotes(ctx context.Context, actor Actor, query VoiceNoteListQuery) (*VoiceNotePage, error) {
	if err := c.openVoiceNotes(ctx, actor); err != nil {
		return nil, err
	}
	if query.Limit < 1 || query.Limit > 50 {
		query.Limit = 20
	}
	rows := c.client.VoiceNote.Query().Where(voicenote.OrganizationID(actor.OrganizationID), voicenote.OwnerUserID(actor.UserID),
		voicenote.DeletedAtIsNil())
	if query.Cursor != "" {
		var cursor voiceNoteCursor
		raw, err := base64.RawURLEncoding.DecodeString(query.Cursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.ID == "" {
			return nil, invalid("The page cursor is not valid.")
		}
		rows.Where(voicenote.Or(voicenote.ReceivedAtLT(cursor.ReceivedAt),
			voicenote.And(voicenote.ReceivedAt(cursor.ReceivedAt), voicenote.IDLT(cursor.ID))))
	}
	notes, err := rows.Order(ent.Desc(voicenote.FieldReceivedAt), ent.Desc(voicenote.FieldID)).Limit(query.Limit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	page := &VoiceNotePage{Notes: []VoiceNoteListItem{}}
	if len(notes) > query.Limit {
		notes = notes[:query.Limit]
		last := notes[len(notes)-1]
		encoded, _ := json.Marshal(voiceNoteCursor{ID: last.ID, ReceivedAt: last.ReceivedAt})
		next := base64.RawURLEncoding.EncodeToString(encoded)
		page.NextCursor = &next
	}
	conflicts, err := c.voiceConflicts(ctx, actor.OrganizationID, notes)
	if err != nil {
		return nil, err
	}
	current := []string{}
	for _, note := range notes {
		if note.CurrentTranscriptRevisionID != nil {
			current = append(current, *note.CurrentTranscriptRevisionID)
		}
	}
	// shortcut: reads whole current transcripts to cut excerpts (50 notes at
	// most); select a substring in SQL if pages grow.
	excerpts := map[string]string{}
	revisions, err := c.client.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.OrganizationID(actor.OrganizationID),
		voicetranscriptrevision.IDIn(current...)).Select(voicetranscriptrevision.FieldID, voicetranscriptrevision.FieldText).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, revision := range revisions {
		excerpts[revision.ID] = voiceExcerpt(revision.Text)
	}
	for _, note := range notes {
		item := VoiceNoteListItem{VoiceNote: voiceNoteRecord(note, conflicts[note.ID])}
		if note.CurrentTranscriptRevisionID != nil {
			item.Excerpt = excerpts[*note.CurrentTranscriptRevisionID]
		}
		page.Notes = append(page.Notes, item)
	}
	return page, nil
}

func voiceExcerpt(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= voiceExcerptRunes {
		return text
	}
	return string([]rune(text)[:voiceExcerptRunes]) + "…"
}

// validVoiceTitle trims a title and checks its length.
func validVoiceTitle(title *string) (string, error) {
	if title == nil {
		return "", nil
	}
	trimmed := strings.TrimSpace(*title)
	if utf8.RuneCountInString(trimmed) > 120 {
		return "", invalid("A voice note title has at most 120 characters.")
	}
	return trimmed, nil
}

// requireVoiceProject checks that a project belongs to the workspace.
func (c *Configuration) requireVoiceProject(ctx context.Context, actor Actor, id string) error {
	exists, err := c.client.Project.Query().Where(project.ID(id), project.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return invalid("This project is not in this workspace.")
	}
	return nil
}

// CreateVoiceNote stores a recorded note. A replay of the same clientNoteId
// returns the stored note, whatever it carries now (S1); a deleted note
// answers 409 and is never recreated (S7, S8). created is false on a replay.
func (c *Configuration) CreateVoiceNote(ctx context.Context, actor Actor, input CreateVoiceNoteInput) (*VoiceNoteDetail, bool, error) {
	if err := c.openVoiceNotes(ctx, actor); err != nil {
		return nil, false, err
	}
	replay := func() (*VoiceNoteDetail, bool, error) {
		row, err := c.client.VoiceNote.Query().Where(voicenote.OrganizationID(actor.OrganizationID), voicenote.OwnerUserID(actor.UserID),
			voicenote.ClientNoteID(input.ClientNoteID)).Only(ctx)
		if err != nil {
			return nil, false, err
		}
		if row.DeletedAt != nil {
			return nil, false, voiceNoteDeleted()
		}
		detail, err := c.voiceNoteDetail(ctx, actor, row)
		return detail, false, err
	}
	if input.ClientNoteID == "" || len(input.ClientNoteID) > 100 {
		return nil, false, invalid("clientNoteId must have 1 to 100 characters.")
	}
	if detail, created, err := replay(); !ent.IsNotFound(err) {
		return detail, created, err
	}
	title, err := validVoiceTitle(input.Title)
	if err != nil {
		return nil, false, err
	}
	switch {
	case input.RecordedAt.IsZero():
		return nil, false, invalid("recordedAt is required.")
	case !validTimeZone(input.RecordedTimeZone):
		return nil, false, invalid("recordedTimeZone must be an IANA time zone.")
	case input.Locale != nil && !voiceLocalePattern.MatchString(*input.Locale):
		return nil, false, invalid("locale must be a language tag of at most 35 characters.")
	case input.DurationMs != nil && (*input.DurationMs < 0 || *input.DurationMs > 24*60*60*1000):
		return nil, false, invalid("durationMs is out of range.")
	}
	if input.ProjectID != nil {
		if err := c.requireVoiceProject(ctx, actor, *input.ProjectID); err != nil {
			return nil, false, err
		}
	}
	err = c.client.VoiceNote.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetOwnerUserID(actor.UserID).
		SetClientNoteID(input.ClientNoteID).SetTitle(title).SetNillableProjectID(input.ProjectID).
		SetRecordedAt(input.RecordedAt.UTC().Truncate(time.Millisecond)).SetRecordedTimeZone(input.RecordedTimeZone).
		SetNillableLocale(input.Locale).SetNillableDurationMs(input.DurationMs).
		SetAudioUploadConsent(input.AudioUploadConsent != nil && *input.AudioUploadConsent).Exec(ctx)
	if ent.IsConstraintError(err) {
		// The same create raced in from a retry; it wrote the note.
		return replay()
	}
	if err != nil {
		return nil, false, err
	}
	detail, _, err := replay()
	return detail, err == nil, err
}

// GetVoiceNote returns the member's note, or its tombstone.
func (c *Configuration) GetVoiceNote(ctx context.Context, actor Actor, id string) (*VoiceNoteDetail, error) {
	row, err := c.ownedVoiceNote(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if err := c.requireVoiceNotes(ctx, actor); err != nil {
		return nil, err
	}
	return c.voiceNoteDetail(ctx, actor, row)
}

// UpdateVoiceNote renames a note or moves it to a project. These are labels:
// the last writer wins, and a replay whose values already match changes
// nothing, not even the revision.
func (c *Configuration) UpdateVoiceNote(ctx context.Context, actor Actor, id string, input UpdateVoiceNoteInput) (*VoiceNoteDetail, error) {
	if _, err := c.liveVoiceNote(ctx, actor, id); err != nil {
		return nil, err
	}
	if input.ExpectedRevision < 1 {
		return nil, invalid("expectedRevision is required.")
	}
	if input.ProjectID.Set && input.ProjectID.Value != nil {
		if err := c.requireVoiceProject(ctx, actor, *input.ProjectID.Value); err != nil {
			return nil, err
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := lockVoiceNote(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if row.DeletedAt != nil {
		return nil, voiceNoteDeleted()
	}
	update, changed := row.Update(), false
	if input.Title != nil {
		title, err := validVoiceTitle(input.Title)
		if err != nil {
			return nil, err
		}
		if title != row.Title {
			update.SetTitle(title)
			changed = true
		}
	}
	if input.ProjectID.Set && !sameOptional(input.ProjectID.Value, row.ProjectID) {
		if input.ProjectID.Value == nil {
			update.ClearProjectID()
		} else {
			update.SetProjectID(*input.ProjectID.Value)
		}
		changed = true
	}
	if changed {
		if row, err = update.AddRevision(1).Save(ctx); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.voiceNoteDetail(ctx, actor, row)
}

func sameOptional(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// DeleteVoiceNote deletes the member's note: it always succeeds for its
// owner, replays included, and wins over any older change (plan 5.2).
func (c *Configuration) DeleteVoiceNote(ctx context.Context, actor Actor, id string) error {
	row, err := c.ownedVoiceNote(ctx, actor, id)
	if err != nil {
		return err
	}
	if row.DeletedAt == nil {
		tx, err := c.client.Tx(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if row, err = lockVoiceNote(ctx, tx, id); err != nil {
			return err
		}
		if row.DeletedAt == nil {
			if err := deleteVoiceNoteTx(ctx, tx, actor, row, "owner"); err != nil {
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	c.purgeVoiceObjectsNow(ctx, id)
	return nil
}

// deleteVoiceNoteTx turns a live note into its tombstone: labels cleared,
// every transcript redacted, every run deleted (its object purged after the
// commit), a pending command proposal withdrawn, the revision bumped.
func deleteVoiceNoteTx(ctx context.Context, tx *ent.Tx, actor Actor, note *ent.VoiceNote, reason string) error {
	now := time.Now().UTC()
	redacted, err := tx.VoiceTranscriptRevision.Update().Where(voicetranscriptrevision.NoteID(note.ID), voicetranscriptrevision.RedactedAtIsNil()).
		SetText("").SetSegments([]schema.VoiceSegment{}).SetRedactedAt(now).Save(ctx)
	if err != nil {
		return err
	}
	runs, err := tx.VoiceAudioRun.Update().Where(voiceaudiorun.NoteID(note.ID), voiceaudiorun.StatusNEQ(voiceaudiorun.StatusDeleted)).
		SetStatus(voiceaudiorun.StatusDeleted).Save(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.VoiceCommand.Update().Where(voicecommand.NoteID(note.ID),
		voicecommand.StatusIn(voicecommand.StatusWaiting, voicecommand.StatusProposed)).SetStatus(voicecommand.StatusWithdrawn).Save(ctx); err != nil {
		return err
	}
	if err := tx.VoiceNote.UpdateOneID(note.ID).SetDeletedAt(now).SetTitle("").ClearProjectID().AddRevision(1).Exec(ctx); err != nil {
		return err
	}
	return appendConfigurationAudit(ctx, tx, actor, "product.voice_note_deleted", "voice_note", note.ID,
		map[string]any{"reason": reason, "redactedTranscripts": redacted, "deletedRuns": runs})
}

// purgeVoiceObjectsNow purges a note's deleted audio after its commit. A
// failure is logged and left to the voice sweep, which retries every run
// whose purge storage has not confirmed.
func (c *Configuration) purgeVoiceObjectsNow(ctx context.Context, noteID string) {
	if _, err := c.purgeVoiceObjects(ctx, 100, voiceaudiorun.NoteID(noteID)); err != nil {
		slog.WarnContext(ctx, "voice audio purge deferred to the sweep", "noteId", noteID, "error", err)
	}
}
