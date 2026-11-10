package product

import (
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestAgentCommentsKeepIdentityApprovalAndScope(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "business")
	keyID := "comment_key_" + w.id
	w.exec(t, `INSERT INTO apikey(id,name,"referenceId",key,enabled,permissions,"createdAt","updatedAt") VALUES($1,'Review assistant',$2,'hashed',true,'{"artifact":["read"],"draft":["write"]}',now(),now())`, keyID, w.org)
	key := Actor{OrganizationID: w.org, Kind: "api_key", KeyID: keyID, Display: "Untrusted display"}
	body := []any{map[string]any{"type": "post_break", "id": "post1", "children": []any{map[string]any{"text": ""}}}, map[string]any{"type": "p", "children": []any{map[string]any{"text": "Evidence matters. Keep the conclusion precise."}}}}
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Review me", Body: body, PlainText: "Evidence matters. Keep the conclusion precise."})
	if err != nil {
		t.Fatal(err)
	}
	draft, err = w.repo.ReviewContentDraft(w.ctx, w.owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"})
	if err != nil {
		t.Fatal(err)
	}
	original := *draft
	input := ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, CommentID: "agent-first", Text: "Cite the evidence.", Anchor: &DraftCommentAnchor{Platform: "x", PostID: "post1", Quote: "Evidence matters."}}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("draft:write implicitly comments: %v", err)
	}
	w.exec(t, `UPDATE apikey SET permissions='{"artifact":["read"],"draft":["comment"]}' WHERE id=$1`, keyID)
	draft, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(draft.Body, original.Body) || draft.PlainText != original.PlainText || draft.ReviewStatus != "approved" || draft.ApprovedVersion == nil || *draft.ApprovedVersion != draft.Version {
		t.Fatal("comment changed approved publication")
	}
	threads, err := parseActivityDiscussions(draft.Discussions)
	if err != nil || len(threads.Threads) != 1 || threads.Threads[0].Comments[0].UserID != "api-key:"+keyID {
		t.Fatalf("impersonation: %+v %v", threads, err)
	}
	users := draft.Discussions["users"].(map[string]any)
	if users["api-key:"+keyID].(map[string]any)["name"] != "Review assistant (API key)" {
		t.Fatal("caller forged author name", users)
	}
	thread := draft.Discussions["threads"].([]any)[0].(map[string]any)
	if thread["scope"] != "text" || thread["postId"] != "post1" || thread["documentContent"] != "Evidence matters." {
		t.Fatal("anchor lost", thread)
	}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("retry duplicated comment", err)
	}
	events, err := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type("activity.comment.created")).All(w.ctx)
	if err != nil || len(events) != 1 || events[0].Payload["actorUserId"] != "" {
		t.Fatalf("nonhuman activity impersonated a member: %+v %v", events, err)
	}
	// A real member replying preserves the key's authoritative attribution.
	draft, err = w.repo.MutateContentDraftComment(w.ctx, w.owner, draft.ID, ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, ThreadID: "agent-first", CommentID: "human-reply", Text: "Will add a source."})
	if err != nil {
		t.Fatal(err)
	}
	users = draft.Discussions["users"].(map[string]any)
	if users["api-key:"+keyID] == nil {
		t.Fatal("human save lost key identity")
	}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "edit", BaseVersion: draft.Version, ThreadID: "agent-first", CommentID: "human-reply", Text: "Forged"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("key edited human reply", err)
	}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "delete_thread", BaseVersion: draft.Version, ThreadID: "agent-first"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("key erased human replies", err)
	}
	resolved := true
	draft, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "resolve", BaseVersion: draft.Version, ThreadID: "agent-first", Resolved: &resolved})
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"open", "resolved"} {
		result, err := w.repo.ListContentDraftComments(w.ctx, key, draft.ID, status, "x")
		if err != nil {
			t.Fatal(err)
		}
		want := 0
		if status == "resolved" {
			want = 1
		}
		if len(result.Discussions["threads"].([]any)) != want {
			t.Fatal("status filter", result)
		}
	}
	result, err := w.repo.ListContentDraftComments(w.ctx, key, draft.ID, "all", "linkedin")
	if err != nil || len(result.Discussions["threads"].([]any)) != 0 {
		t.Fatal("platform filter", result, err)
	}
	invalid := ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, CommentID: "bad-anchor", Text: "Invalid", Anchor: &DraftCommentAnchor{Platform: "x", PostID: "post1", Quote: "not in the post"}}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, invalid); err == nil {
		t.Fatal("invented text span accepted")
	}
	private, err := w.repo.CreateSocialSet(w.ctx, w.owner, SocialSetInput{Name: "Private", Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	hidden, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Hidden", SocialSetID: private.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, hidden.ID, ContentDraftCommentInput{Action: "add", BaseVersion: hidden.Version, CommentID: "hidden", Text: "No"}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("private set leaked", err)
	}
	other := newTestWorkspace(t)
	foreign := key
	foreign.OrganizationID = other.org
	if _, err = w.repo.ListContentDraftComments(w.ctx, foreign, draft.ID, "all", ""); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatal("cross-workspace key read", err)
	}
	w.exec(t, `UPDATE apikey SET enabled=false WHERE id=$1`, keyID)
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, CommentID: "revoked", Text: "No"}); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatal("revoked key wrote", err)
	}
}

func TestAgentCommentsConcurrentAddAndThreadDeletion(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	keyID := "concurrent_comments_" + w.id
	w.exec(t, `INSERT INTO apikey(id,"referenceId",key,enabled,permissions,"createdAt","updatedAt") VALUES($1,$2,'hashed',true,'{"artifact":["read"],"draft":["comment"]}',now(),now())`, keyID, w.org)
	key := Actor{OrganizationID: w.org, Kind: "api_key", KeyID: keyID}
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Concurrent comments"})
	if err != nil {
		t.Fatal(err)
	}
	errorsByCall := make([]error, 6)
	var wg sync.WaitGroup
	for i := range errorsByCall {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errorsByCall[i] = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "add", BaseVersion: draft.Version, CommentID: "same-request", Text: "One comment"})
		}(i)
	}
	wg.Wait()
	success := 0
	for _, err := range errorsByCall {
		if err == nil {
			success++
		} else if !errors.Is(err, publishing.ErrConflict) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatalf("%d duplicate writes", success)
	}
	fresh, err := w.repo.GetContentDraft(w.ctx, w.owner, draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "delete_thread", BaseVersion: fresh.Version, ThreadID: "same-request"})
	if err != nil {
		t.Fatal(err)
	}
	if len(fresh.Discussions["threads"].([]any)) != 0 {
		t.Fatal("thread not deleted")
	}
	if _, err = w.repo.MutateContentDraftComment(w.ctx, key, draft.ID, ContentDraftCommentInput{Action: "add", BaseVersion: fresh.Version, CommentID: "same-request", Text: "Replay after deletion"}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("deleted receipt reused", err)
	}
}
