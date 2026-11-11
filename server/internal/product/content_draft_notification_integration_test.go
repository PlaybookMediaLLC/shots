package product

import (
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestDraftPublishNoticePreferenceKeepsApprovalAndContent(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "business")
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{PlainText: "Publish as reviewed"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err = w.repo.ReviewContentDraft(w.ctx, w.owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"})
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	saved, err := w.repo.UpdateContentDraftProperties(w.ctx, w.owner, draft.ID, ContentDraftPropertiesInput{SuppressSlackOnPublish: &enabled})
	if err != nil || !saved.SuppressSlackOnPublish || saved.Version != draft.Version || saved.ReviewStatus != "approved" || saved.ApprovedVersion == nil || *saved.ApprovedVersion != draft.Version || saved.PlainText != draft.PlainText {
		t.Fatal("notification preference changed publication", saved, err)
	}
	read, err := w.repo.GetContentDraft(w.ctx, w.owner, draft.ID)
	if err != nil || !read.SuppressSlackOnPublish {
		t.Fatal("preference not persisted", err)
	}
	foreign := newTestWorkspace(t)
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "business")
	if _, err = foreign.repo.UpdateContentDraftProperties(foreign.ctx, foreign.owner, draft.ID, ContentDraftPropertiesInput{SuppressSlackOnPublish: &enabled}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("foreign draft mutated", err)
	}
}
