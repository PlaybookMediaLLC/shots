package product

import (
	"context"
	"fmt"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/accountdeletionrequest"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voiceaudiorun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicemembersettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicenote"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicetranscriptrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
)

const (
	// voiceUploadWindow is how long a signed run may stay unfinished (D5).
	voiceUploadWindow = 24 * time.Hour
	// voiceRemovedMemberGrace is how long a removed member's notes are kept
	// (owner decision 6, D7).
	voiceRemovedMemberGrace = 30 * 24 * time.Hour
)

// voiceOwnerIsMember matches notes whose owner is (or, with false, is no
// longer) a member of the note's workspace.
func voiceOwnerIsMember(isMember bool) predicate.VoiceNote {
	return func(s *entsql.Selector) {
		m := entsql.Table(member.Table)
		membership := entsql.Select(m.C(member.FieldID)).From(m).Where(entsql.And(
			entsql.ColumnsEQ(m.C(member.FieldOrganizationID), s.C(voicenote.FieldOrganizationID)),
			entsql.ColumnsEQ(m.C(member.FieldUserID), s.C(voicenote.FieldOwnerUserID))))
		if isMember {
			s.Where(entsql.Exists(membership))
		} else {
			s.Where(entsql.NotExists(membership))
		}
	}
}

// voiceOwnerAccountDeleted matches notes whose owner's account deletion was
// carried out (D2). That job anonymizes the user row rather than deleting
// it, so no foreign key removes their notes.
func voiceOwnerAccountDeleted() predicate.VoiceNote {
	return func(s *entsql.Selector) {
		r := entsql.Table(accountdeletionrequest.Table)
		s.Where(entsql.Exists(entsql.Select(r.C(accountdeletionrequest.FieldID)).From(r).Where(entsql.And(
			entsql.ColumnsEQ(r.C(accountdeletionrequest.FieldUserID), s.C(voicenote.FieldOwnerUserID)),
			entsql.EQ(r.C(accountdeletionrequest.FieldStatus), accountdeletionrequest.StatusCOMPLETED)))))
	}
}

// voiceWorkspacePurged matches rows of a workspace whose purge ran at least
// voicePurgeAfter ago. The purge keeps the organization row, so no foreign
// key removes them, and by then no upload URL signed before it is valid.
func voiceWorkspacePurged(column string) func(*entsql.Selector) {
	return func(s *entsql.Selector) {
		w := entsql.Table(workspacedeletion.Table)
		s.Where(entsql.Exists(entsql.Select(w.C(workspacedeletion.FieldID)).From(w).Where(entsql.And(
			entsql.ColumnsEQ(w.C(workspacedeletion.FieldOrganizationID), s.C(column)),
			entsql.EQ(w.C(workspacedeletion.FieldStatus), workspacedeletion.StatusPURGED),
			entsql.LT(w.C(workspacedeletion.FieldPurgedAt), time.Now().Add(-voicePurgeAfter))))))
	}
}

// voiceWorkspaceBatch is how many objects of purged workspaces one sweep deletes.
const voiceWorkspaceBatch = 500

// sweepPurgedWorkspaces removes the voice data of purged workspaces: every
// run's object first, while a row still names it, then the notes (their
// revisions, runs and commands cascade) and the voice settings.
func (c *Configuration) sweepPurgedWorkspaces(ctx context.Context) (int, error) {
	runs, err := c.client.VoiceAudioRun.Query().Where(voiceaudiorun.ObjectPurgedAtIsNil(),
		predicate.VoiceAudioRun(voiceWorkspacePurged(voiceaudiorun.FieldOrganizationID))).Limit(voiceWorkspaceBatch).All(ctx)
	if err != nil {
		return 0, err
	}
	for _, run := range runs {
		if c.objects == nil {
			return 0, ErrStorageUnavailable
		}
		if err := c.objects.Delete(ctx, run.ObjectKey); err != nil {
			return 0, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
		if err := c.client.VoiceAudioRun.UpdateOneID(run.ID).SetObjectPurgedAt(time.Now().UTC()).Exec(ctx); err != nil {
			return 0, err
		}
	}
	if len(runs) == voiceWorkspaceBatch {
		// More objects are left; no row goes before they do.
		return len(runs), nil
	}
	notes, err := c.client.VoiceNote.Delete().Where(predicate.VoiceNote(voiceWorkspacePurged(voicenote.FieldOrganizationID))).Exec(ctx)
	if err != nil {
		return len(runs), err
	}
	if _, err := c.client.VoiceSettings.Delete().Where(predicate.VoiceSettings(voiceWorkspacePurged(voicesettings.FieldID))).Exec(ctx); err != nil {
		return len(runs) + notes, err
	}
	_, err = c.client.VoiceMemberSettings.Delete().Where(predicate.VoiceMemberSettings(voiceWorkspacePurged(voicemembersettings.FieldOrganizationID))).Exec(ctx)
	return len(runs) + notes, err
}

// SweepVoice is the hourly voice maintenance job. It fails unfinished uploads
// after a day; deletes the notes of a member removed 30 days ago, and at once
// those of a deleted account, with that account's voice choices; removes a
// purged workspace's voice data; and purges the objects of deleted and failed
// runs until storage confirms each one.
func (c *Configuration) SweepVoice(ctx context.Context) (int, error) {
	now := time.Now().UTC()
	expired, err := c.client.VoiceAudioRun.Update().Where(voiceaudiorun.StatusEQ(voiceaudiorun.StatusPending),
		voiceaudiorun.UpdatedAtLT(now.Add(-voiceUploadWindow))).
		SetStatus(voiceaudiorun.StatusFailed).SetFailureReason("The upload was not completed within 24 hours.").Save(ctx)
	if err != nil {
		return 0, err
	}
	// shortcut: checks every live note's membership each hour; record member
	// removals as they happen if notes reach the millions.
	if _, err := c.client.VoiceNote.Update().Where(voicenote.DeletedAtIsNil(), voicenote.OwnerRemovedAtIsNil(), voiceOwnerIsMember(false)).
		SetOwnerRemovedAt(now).Save(ctx); err != nil {
		return expired, err
	}
	// A member added back within the grace period keeps their notes.
	if _, err := c.client.VoiceNote.Update().Where(voicenote.OwnerRemovedAtNotNil(), voiceOwnerIsMember(true)).
		ClearOwnerRemovedAt().Save(ctx); err != nil {
		return expired, err
	}
	count := expired
	for _, sweep := range []struct {
		reason string
		due    predicate.VoiceNote
	}{
		{"account_deleted", voiceOwnerAccountDeleted()},
		{"member_removed", voicenote.And(voicenote.OwnerRemovedAtLT(now.Add(-voiceRemovedMemberGrace)), voiceOwnerIsMember(false))},
	} {
		deleted, err := c.sweepVoiceNotes(ctx, sweep.reason, sweep.due)
		count += deleted
		if err != nil {
			return count, err
		}
	}
	if _, err := c.client.VoiceMemberSettings.Delete().Where(func(s *entsql.Selector) {
		r := entsql.Table(accountdeletionrequest.Table)
		s.Where(entsql.Exists(entsql.Select(r.C(accountdeletionrequest.FieldID)).From(r).Where(entsql.And(
			entsql.ColumnsEQ(r.C(accountdeletionrequest.FieldUserID), s.C(voicemembersettings.FieldUserID)),
			entsql.EQ(r.C(accountdeletionrequest.FieldStatus), accountdeletionrequest.StatusCOMPLETED)))))
	}).Exec(ctx); err != nil {
		return count, err
	}
	removed, err := c.sweepPurgedWorkspaces(ctx)
	count += removed
	if err != nil {
		return count, err
	}
	purged, err := c.purgeVoiceObjects(ctx, 200)
	return count + purged, err
}

// sweepVoiceNotes deletes up to 100 live notes that are due, each through the
// owner's own deletion path, rechecked under its row lock.
func (c *Configuration) sweepVoiceNotes(ctx context.Context, reason string, due predicate.VoiceNote) (int, error) {
	notes, err := c.client.VoiceNote.Query().Where(voicenote.DeletedAtIsNil(), due).Order(ent.Asc(voicenote.FieldID)).Limit(100).IDs(ctx)
	if err != nil {
		return 0, err
	}
	deleted := 0
	for _, id := range notes {
		done, err := func() (bool, error) {
			tx, err := c.client.Tx(ctx)
			if err != nil {
				return false, err
			}
			defer tx.Rollback()
			if _, err := tx.PlatformExec(ctx, `SELECT id FROM voice_note WHERE id=$1 FOR UPDATE`, id); err != nil {
				return false, err
			}
			note, err := tx.VoiceNote.Query().Where(voicenote.ID(id), voicenote.DeletedAtIsNil(), due).Only(ctx)
			if ent.IsNotFound(err) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			actor := Actor{OrganizationID: note.OrganizationID, Kind: "service", Display: "voice-maintenance"}
			if err := deleteVoiceNoteTx(ctx, tx, actor, note, reason); err != nil {
				return false, err
			}
			return true, tx.Commit()
		}()
		if err != nil {
			return deleted, err
		}
		if done {
			deleted++
		}
	}
	return deleted, nil
}

// ReplayVoiceDeletion deletes again a member's voice deletion that a database
// restore brought back (the deletion ledger, docs/deployment.md): a note
// through the owner's deletion path, a note's audio, or one transcript's
// text. A record the restored database never had, or already deleted,
// changes nothing. It reports whether anything was deleted again.
func (c *Configuration) ReplayVoiceDeletion(ctx context.Context, kind, organizationID, id string) (bool, error) {
	noteID := id
	switch kind {
	case "voice_note", "voice_audio":
	case "voice_transcript":
		revision, err := c.client.VoiceTranscriptRevision.Query().Where(voicetranscriptrevision.ID(id),
			voicetranscriptrevision.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		noteID = revision.NoteID
	default:
		return false, fmt.Errorf("unknown voice deletion kind %q", kind)
	}
	exists, err := c.client.VoiceNote.Query().Where(voicenote.ID(noteID), voicenote.OrganizationID(organizationID)).Exist(ctx)
	if err != nil || !exists {
		return false, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	note, err := lockVoiceNote(ctx, tx, noteID)
	if err != nil {
		return false, err
	}
	actor := Actor{OrganizationID: organizationID, Kind: "service", Display: "deletion-ledger-replay"}
	changed := false
	switch kind {
	case "voice_note":
		if changed = note.DeletedAt == nil; changed {
			err = deleteVoiceNoteTx(ctx, tx, actor, note, "ledger_replay")
		}
	case "voice_audio":
		var deleted int
		deleted, err = deleteVoiceAudioTx(ctx, tx, actor, noteID)
		changed = deleted > 0
	case "voice_transcript":
		var revision *ent.VoiceTranscriptRevision
		if revision, err = tx.VoiceTranscriptRevision.Get(ctx, id); err == nil && revision.RedactedAt == nil {
			_, err = redactVoiceTranscriptTx(ctx, tx, actor, revision)
			changed = true
		}
	}
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	c.purgeVoiceObjectsNow(ctx, noteID)
	return changed, nil
}
