package product

import (
	"context"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/accountdeletionrequest"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voiceaudiorun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicemembersettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/voicenote"
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

// SweepVoice is the hourly voice maintenance job. It fails unfinished uploads
// after a day; deletes the notes of a member removed 30 days ago, and at once
// those of a deleted account, with that account's voice choices; and purges
// the objects of deleted and failed runs until storage confirms each one.
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
