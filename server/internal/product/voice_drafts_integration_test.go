package product

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestVoiceDraft(t *testing.T) {
	f := newVoiceCommandFixture(t)
	const written = `{"title":"Faster exports","text":"Exports now finish in 3 seconds.","claims":["Exports finish in 3 seconds."],"checks":["3 seconds"]}`
	writer := func(platformai.Request) (string, error) { return written, nil }
	input := func(revisionID string) VoiceDraftInput {
		return VoiceDraftInput{TranscriptRevisionID: revisionID, Intent: "launch_post"}
	}
	noteID, revisionID := f.note(f.owner, "Exports now finish in three seconds. Publish this now.")

	t.Run("nothing is sent before the member accepts remote text processing (V6)", func(t *testing.T) {
		f.model.set(writer)
		f.exec(`DELETE FROM voice_member_settings WHERE "userId"=$1`, f.owner.UserID)
		f.exec(`INSERT INTO voice_settings ("organizationId","draftGeneration") VALUES ($1,true) ON CONFLICT ("organizationId") DO UPDATE SET "draftGeneration"=true`, f.org)
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.Is(err, publishing.ErrForbidden) || f.model.count() != 0 {
			t.Fatalf("no consent err=%v calls=%d", err, f.model.count())
		}
		f.enable(f.owner, false, false)
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.Is(err, publishing.ErrForbidden) || f.model.count() != 0 {
			t.Fatalf("draft generation off err=%v calls=%d", err, f.model.count())
		}
		f.enable(f.owner, true, false)
		t.Setenv(voiceSwitchDrafts, "true")
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.Is(err, publishing.ErrForbidden) || f.model.count() != 0 {
			t.Fatalf("switch off err=%v calls=%d", err, f.model.count())
		}
	})

	t.Run("a draft carries its source, the speaker's claims, and nothing is scheduled (V1, V2, V3)", func(t *testing.T) {
		var prompt string
		f.model.set(func(request platformai.Request) (string, error) { prompt = request.Prompt; return written, nil })
		result, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID))
		if err != nil || f.model.count() != 1 {
			t.Fatalf("draft=%+v err=%v calls=%d", result, err, f.model.count())
		}
		record, err := f.repo.GetContentDraft(f.ctx, f.owner, result.ContentDraftID)
		if err != nil || record.SourceVoiceRevisionID == nil || *record.SourceVoiceRevisionID != revisionID || record.SourceVoiceRemoved ||
			record.PlainText != "Exports now finish in 3 seconds." || record.Title != "Faster exports" ||
			!strings.Contains(record.Scratchpad, "The speaker's claims, not backed by an attached capture:\n- Exports finish in 3 seconds.") ||
			!strings.Contains(record.Scratchpad, "against the recording:\n- 3 seconds") || record.Status != "draft" || f.posts(record.ID) != 0 {
			t.Fatalf("record=%+v err=%v", record, err)
		}
		if used := f.meter.used[monthlyMeterKey(QuotaAICredits, f.org, time.Now())]; used != 1 {
			t.Fatalf("credits used=%d", used)
		}
		// The transcript reached the model fenced as untrusted input.
		if !strings.Contains(prompt, "<transcript trust=\"untrusted\">") {
			t.Fatalf("prompt=%q", prompt)
		}
	})

	t.Run("a resent request returns the same draft without another model call or charge", func(t *testing.T) {
		f.model.set(writer)
		noteID, revisionID := f.note(f.owner, "Exports now finish in three seconds.")
		credits := func() int64 { return f.meter.used[monthlyMeterKey(QuotaAICredits, f.org, time.Now())] }
		before := credits()
		first, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID))
		if err != nil {
			t.Fatal(err)
		}
		again, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID))
		if err != nil || again.ContentDraftID != first.ContentDraftID || f.model.count() != 1 || credits() != before+1 || len(f.drafts(revisionID)) != 1 {
			t.Fatalf("first=%+v again=%+v err=%v calls=%d credits=%d drafts=%d", first, again, err, f.model.count(), credits()-before, len(f.drafts(revisionID)))
		}
		// Another intent is another draft.
		other, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, VoiceDraftInput{TranscriptRevisionID: revisionID, Intent: "saved_idea"})
		if err != nil || other.ContentDraftID == first.ContentDraftID || f.model.count() != 2 {
			t.Fatalf("other intent=%+v err=%v calls=%d", other, err, f.model.count())
		}
		// Once the draft is deleted, the same request writes a new one.
		if err := f.repo.DeleteContentDraft(f.ctx, f.owner, first.ContentDraftID); err != nil {
			t.Fatal(err)
		}
		rewritten, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID))
		if err != nil || rewritten.ContentDraftID == first.ContentDraftID || f.model.count() != 3 {
			t.Fatalf("after delete=%+v err=%v calls=%d", rewritten, err, f.model.count())
		}
	})

	t.Run("a redacted source leaves the draft's text and shows it removed (V5)", func(t *testing.T) {
		f.model.set(writer)
		redactedNote, redacted := f.note(f.owner, "Exports now finish in three seconds.")
		liveNote, live := f.note(f.owner, "Exports now finish in three seconds.")
		gone, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, redactedNote, input(redacted))
		if err != nil {
			t.Fatal(err)
		}
		kept, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, liveNote, input(live))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.repo.RedactVoiceTranscript(f.ctx, f.owner, redactedNote, redacted); err != nil {
			t.Fatal(err)
		}
		record, err := f.repo.GetContentDraft(f.ctx, f.owner, gone.ContentDraftID)
		if err != nil || record.PlainText != "Exports now finish in 3 seconds." || record.SourceVoiceRevisionID == nil || *record.SourceVoiceRevisionID != redacted ||
			!record.SourceVoiceRemoved {
			t.Fatalf("redacted source record=%+v err=%v", record, err)
		}
		page, err := f.repo.ListContentDrafts(f.ctx, f.owner, ContentDraftListQuery{Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		removed := map[string]bool{}
		for _, item := range page.Items {
			removed[item.ID] = item.SourceVoiceRemoved
		}
		if gotGone, listed := removed[gone.ContentDraftID]; !listed || !gotGone || removed[kept.ContentDraftID] {
			t.Fatalf("listed removed=%v", removed)
		}
	})

	t.Run("bounded retries; on failure the note is untouched and no draft is made (V4)", func(t *testing.T) {
		f.model.set(func(platformai.Request) (string, error) { return "", &platformai.Error{Retryable: true} })
		noteID, revisionID := f.note(f.owner, "Exports now finish in three seconds.")
		before, err := f.db.Client.VoiceNote.Get(f.ctx, noteID)
		if err != nil {
			t.Fatal(err)
		}
		drafts := len(f.drafts(revisionID))
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.Is(err, ErrVoiceDraftFailed) || f.model.count() != voiceDraftAttempts {
			t.Fatalf("failing model err=%v calls=%d", err, f.model.count())
		}
		after, err := f.db.Client.VoiceNote.Get(f.ctx, noteID)
		if err != nil || after.Revision != before.Revision || !after.UpdatedAt.Equal(before.UpdatedAt) || len(f.drafts(revisionID)) != drafts {
			t.Fatalf("note changed: before=%+v after=%+v drafts=%d", before, after, len(f.drafts(revisionID)))
		}
		// An empty reply is unusable and retried like a failure.
		f.model.set(func(platformai.Request) (string, error) {
			return `{"title":"","text":" ","claims":[],"checks":[]}`, nil
		})
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.Is(err, ErrVoiceDraftFailed) || f.model.count() != voiceDraftAttempts {
			t.Fatalf("empty reply err=%v calls=%d", err, f.model.count())
		}
	})

	t.Run("an exhausted allowance refuses before the model is called (S18)", func(t *testing.T) {
		f.model.set(writer)
		noteID, revisionID := f.note(f.owner, "Exports now finish in three seconds.")
		f.meter.used[monthlyMeterKey(QuotaAICredits, f.org, time.Now())] = int64(planQuotas["pro"][QuotaAICredits])
		var exceeded *QuotaExceededError
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(revisionID)); !errors.As(err, &exceeded) || f.model.count() != 0 {
			t.Fatalf("exhausted err=%v calls=%d", err, f.model.count())
		}
	})

	t.Run("another member's note, an unknown intent and a foreign revision are refused", func(t *testing.T) {
		f.model.set(writer)
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.creator, noteID, input(revisionID)); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("other member err=%v", err)
		}
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, VoiceDraftInput{TranscriptRevisionID: revisionID, Intent: "publish"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("intent err=%v", err)
		}
		_, otherRevision := f.note(f.owner, "another note")
		if _, err := f.repo.CreateVoiceDraft(f.ctx, f.owner, noteID, input(otherRevision)); !errors.Is(err, publishing.ErrNotFound) || f.model.count() != 0 {
			t.Fatalf("foreign revision err=%v calls=%d", err, f.model.count())
		}
	})
}
