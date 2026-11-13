package product

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestMemberCommentsUseOneDatabaseConnection(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "business")
	w.addMember(t, "viewer", "viewer")
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Pool pressure"})
	if err != nil {
		t.Fatal(err)
	}
	// A transaction already occupies the only connection. Authorizing through
	// the non-transactional repository here would wait for itself indefinitely.
	w.db.SQL.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(w.ctx, 5*time.Second)
	defer cancel()
	_, err = w.repo.MutateContentDraftComment(ctx, w.actor("viewer"), draft.ID, ContentDraftCommentInput{
		Action: "add", BaseVersion: draft.Version, CommentID: "one-connection", Text: "Still available",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemberCommentsPreserveContentAndAuthority(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo := w.ctx, w.repo
	subscribe(t, ctx, repo, w.org, "business")
	w.addMember(t, "viewer", "viewer")
	w.addMember(t, "approver", "approver")
	viewer, approver := w.actor("viewer"), w.actor("approver")
	draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Approved content", PlainText: "Do not change", Body: []any{map[string]any{"type": "p", "children": []any{map[string]any{"text": "Do not change"}}}}})
	if err != nil {
		t.Fatal(err)
	}
	draft, err = repo.ReviewContentDraft(ctx, w.owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"})
	if err != nil {
		t.Fatal(err)
	}
	original := *draft
	add := ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, CommentID: "first", Text: "Please check the wording", MentionUserIDs: []string{approver.UserID}}
	draft, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, add)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Title != original.Title || draft.PlainText != original.PlainText || !reflect.DeepEqual(draft.Body, original.Body) || draft.ReviewStatus != "approved" || draft.ApprovedVersion == nil || *draft.ApprovedVersion != draft.Version {
		t.Fatalf("comment changed content/approval: %+v", draft)
	}
	if _, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, add); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("replayed add: %v", err)
	}
	threads, err := parseActivityDiscussions(draft.Discussions)
	if err != nil || len(threads.Threads) != 1 || len(threads.Threads[0].Comments) != 1 || threads.Threads[0].Comments[0].UserID != viewer.UserID {
		t.Fatalf("canonical comment: %+v %v", threads, err)
	}
	for _, kind := range []string{"comment.created", "comment.on_your_draft", "member.mentioned"} {
		count, err := repo.client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.AggregateID(draft.ID), outboxevent.Type("activity."+kind)).Count(ctx)
		if err != nil || count != 1 {
			t.Fatalf("%s events=%d err=%v", kind, count, err)
		}
	}
	if _, err = repo.MutateContentDraftComment(ctx, approver, draft.ID, ContentDraftCommentInput{Action: "edit", BaseVersion: draft.Version, ThreadID: "first", CommentID: "first", Text: "Forged edit"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("another author edited: %v", err)
	}
	if _, err = repo.MutateContentDraftComment(ctx, approver, draft.ID, ContentDraftCommentInput{Action: "delete", BaseVersion: draft.Version, ThreadID: "first", CommentID: "first"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("another author deleted: %v", err)
	}
	draft, err = repo.MutateContentDraftComment(ctx, approver, draft.ID, ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, ThreadID: "first", CommentID: "reply", Text: "Checked"})
	if err != nil {
		t.Fatal(err)
	}
	draft, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, ContentDraftCommentInput{Action: "edit", BaseVersion: draft.Version, ThreadID: "first", CommentID: "first", Text: "Updated comment"})
	if err != nil {
		t.Fatal(err)
	}
	resolved := true
	draft, err = repo.MutateContentDraftComment(ctx, approver, draft.ID, ContentDraftCommentInput{Action: "resolve", BaseVersion: draft.Version, ThreadID: "first", Resolved: &resolved})
	if err != nil {
		t.Fatal(err)
	}
	// The history tells a resolve from a reopen.
	history, err := repo.ListContentDraftActivity(ctx, approver, draft.ID, "")
	if err != nil || history.Items[0].Action != "product.content_draft_comment_resolve" || history.Items[0].Metadata["resolved"] != true {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	draft, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, ContentDraftCommentInput{Action: "delete", BaseVersion: draft.Version, ThreadID: "first", CommentID: "first"})
	if err != nil {
		t.Fatal(err)
	}
	threads, _ = parseActivityDiscussions(draft.Discussions)
	if len(threads.Threads) != 1 || len(threads.Threads[0].Comments) != 1 || threads.Threads[0].Comments[0].ID != "reply" || !threads.Threads[0].Resolved {
		t.Fatalf("deleting root lost reply: %+v", threads)
	}
	reused := add
	reused.BaseVersion = draft.Version
	if _, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, reused); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("deleted ID reused: %v", err)
	}
	private, err := repo.CreateSocialSet(ctx, w.owner, SocialSetInput{Name: "Private", Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	secret, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Private draft", SocialSetID: private.ID})
	if err != nil {
		t.Fatal(err)
	}
	hidden := ContentDraftCommentInput{Action: "add", BaseVersion: secret.Version, CommentID: "hidden", Text: "Denied"}
	if _, err = repo.MutateContentDraftComment(ctx, viewer, secret.ID, hidden); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("private draft commented: %v", err)
	}
	title := "forbidden"
	if _, err = repo.UpdateContentDraft(ctx, viewer, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer edited body: %v", err)
	}
	for _, kind := range []string{"api_key", "service", "support", "webhook"} {
		actor := viewer
		actor.Kind = kind
		if _, err = repo.MutateContentDraftComment(ctx, actor, draft.ID, add); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("%s impersonated commenter: %v", kind, err)
		}
	}
	if _, err = repo.RemoveMember(ctx, w.owner, "member_viewer_"+w.id); err != nil {
		t.Fatal(err)
	}
	add.BaseVersion = draft.Version
	add.CommentID = "removed"
	if _, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, add); !errors.Is(err, publishing.ErrForbidden) && !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("removed member commented: %v", err)
	}
}

func TestMemberCommentsConcurrentVersionAndScope(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo := w.ctx, w.repo
	subscribe(t, ctx, repo, w.org, "business")
	w.addMember(t, "viewer", "viewer")
	viewer := w.actor("viewer")
	draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Concurrent"})
	if err != nil {
		t.Fatal(err)
	}
	inputs := []ContentDraftCommentInput{{Action: "add", BaseVersion: draft.Version, CommentID: "one", Text: "One"}, {Action: "add", BaseVersion: draft.Version, CommentID: "two", Text: "Two"}}
	results := make([]error, 2)
	var wg sync.WaitGroup
	for i := range inputs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = repo.MutateContentDraftComment(ctx, viewer, draft.ID, inputs[i])
		}(i)
	}
	wg.Wait()
	successes, conflicts := 0, 0
	for _, err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, publishing.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent outcomes: %v", results)
	}
	fresh, err := repo.GetContentDraft(ctx, viewer, draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, err := range results {
		if err != nil {
			inputs[i].BaseVersion = fresh.Version
			fresh, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, inputs[i])
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	threads, _ := parseActivityDiscussions(fresh.Discussions)
	if len(threads.Threads) != 2 {
		t.Fatalf("lost comments: %+v", threads)
	}
	input := ContentDraftCommentInput{Action: "add", BaseVersion: fresh.Version, CommentID: "bad-mention", Text: "No", MentionUserIDs: []string{"other-user"}}
	if _, err = repo.MutateContentDraftComment(ctx, viewer, draft.ID, input); err == nil {
		t.Fatal("foreign mention accepted")
	}
	foreign := viewer
	foreign.OrganizationID = "other-workspace"
	if _, err = repo.MutateContentDraftComment(ctx, foreign, draft.ID, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("foreign scope: %v", err)
	}
}
