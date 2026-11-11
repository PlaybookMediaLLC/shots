package product

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/collab"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// Exercise the capability matrix against current stored memberships, real drafts,
// scoped account authority and revision-bound approval, without provider writes.
func TestTeamCollaborationRoles(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo := w.ctx, w.repo.WithMonthlyMeter(&recordingMonthlyMeter{}).WithCollabKey([]byte(strings.Repeat("s", 32)))
	subscribe(t, ctx, repo, w.org, "business")
	requireApproval := true
	if _, err := repo.UpdateContentDraftSettings(ctx, w.owner, ContentDraftSettingsUpdate{RequireApproval: &requireApproval}); err != nil {
		t.Fatal(err)
	}
	addCredential := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
	external := "x-" + w.id
	addCredential(external, "x")
	connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: w.org, UserID: w.owner.UserID, Type: "USER"}, publishing.CreateConnectionInput{ExternalAccountID: external, Platform: "x", SecretReference: "SOCIAL_API_KEY"})
	if err != nil {
		t.Fatal(err)
	}
	sets, err := repo.ListSocialSets(ctx, w.owner)
	if err != nil || len(sets.Items) != 1 {
		t.Fatalf("shared account fixture: sets=%+v err=%v", sets, err)
	}
	setID := sets.Items[0].ID
	for _, role := range []string{"owner", "admin", "creator", "approver", "publisher", "writer_publisher", "viewer"} {
		if role != "owner" {
			w.addMember(t, role, role)
		}
		t.Run(role, func(t *testing.T) {
			actor := w.actor(role)
			draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: role, PlainText: "Team policy"})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = repo.GetContentDraft(ctx, actor, draft.ID); err != nil {
				t.Fatalf("read: %v", err)
			}
			writes := role == "owner" || role == "admin" || role == "creator" || role == "writer_publisher"
			approves := role == "owner" || role == "admin" || role == "approver"
			publishes := role == "owner" || role == "admin" || role == "publisher" || role == "writer_publisher"
			manages := role == "owner" || role == "admin"
			want := func(action string, err error, allowed bool) {
				t.Helper()
				if allowed && err != nil || !allowed && !errors.Is(err, publishing.ErrForbidden) {
					t.Fatalf("%s allowed=%v err=%v", action, allowed, err)
				}
			}
			title := role + " edited"
			saved, err := repo.UpdateContentDraft(ctx, actor, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title})
			want("write", err, writes)
			if err == nil {
				draft = saved
			}
			token, err := repo.IssueContentDraftCollabToken(ctx, actor, draft.ID)
			if err != nil {
				t.Fatal(err)
			}
			if (token.Access == collab.AccessWrite) != writes {
				t.Fatalf("collab capability differs: %s", token.Access)
			}
			_, err = repo.ReviewContentDraft(ctx, actor, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "request"})
			want("request review", err, writes)
			_, err = repo.ReviewContentDraft(ctx, actor, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"})
			want("approve", err, approves)
			want("manage accounts", repo.auth.AuthorizeConnections(ctx, w.org, actor.UserID, actor.SessionID), manages)
			want("manage sets", repo.AuthorizeSocialSetConnection(ctx, actor, setID), manages)
			if _, err = repo.ReviewContentDraft(ctx, w.owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); err != nil {
				t.Fatal(err)
			}
			_, err = repo.ScheduleContentDraft(ctx, actor, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(48 * time.Hour).UTC(), Version: draft.Version, Targets: []ContentDraftScheduleTarget{{Caption: "Team policy", ChannelConnectionID: connection.ID}}})
			want("schedule approved content", err, publishes)
		})
	}
	t.Run("a stale reviewer cannot approve another writer's unseen content", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Seen by reviewer", PlainText: "Seen"})
		if err != nil {
			t.Fatal(err)
		}
		title := "Unseen writer edit"
		edited, err := repo.UpdateContentDraft(ctx, w.actor("writer_publisher"), draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title})
		if err != nil {
			t.Fatal(err)
		}
		for _, version := range []int{0, draft.Version} {
			_, err = repo.ReviewContentDraft(ctx, w.actor("approver"), draft.ID, ContentDraftReviewInput{Action: "approve", Version: version})
			if err == nil {
				t.Fatalf("accepted approval of version %d", version)
			}
			if version > 0 && (!errors.Is(err, publishing.ErrConflict) || !strings.Contains(err.Error(), "review the current content")) {
				t.Fatalf("stale review err=%v", err)
			}
		}
		current, err := repo.GetContentDraft(ctx, w.owner, draft.ID)
		if err != nil || current.ApprovedVersion != nil {
			t.Fatalf("stale approval persisted: %+v %v", current, err)
		}
		approved, err := repo.ReviewContentDraft(ctx, w.actor("approver"), draft.ID, ContentDraftReviewInput{Action: "approve", Version: edited.Version})
		if err != nil || approved.ApprovedVersion == nil || *approved.ApprovedVersion != edited.Version {
			t.Fatalf("re-review=%+v err=%v", approved, err)
		}
	})
	writer := w.actor("writer_publisher")
	draft, err := repo.CreateContentDraft(ctx, writer, ContentDraftInput{Title: "Demotion", PlainText: "Unapproved"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = repo.ScheduleContentDraft(ctx, writer, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(48 * time.Hour).UTC(), Version: draft.Version, Targets: []ContentDraftScheduleTarget{{Caption: "Unapproved", ChannelConnectionID: connection.ID}}})
	if !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("writer bypassed approval: %v", err)
	}
	token, err := repo.IssueContentDraftCollabToken(ctx, writer, draft.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = repo.UpdateMemberRole(ctx, w.owner, "member_writer_publisher_"+w.id, "viewer"); err != nil {
		t.Fatal(err)
	}
	title := "Stale write"
	if _, err = repo.UpdateContentDraft(ctx, writer, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("stale session edited: %v", err)
	}
	if err = repo.StoreCollabState(ctx, token.Token, draft.ID, []byte{1, 2, 3}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("stale collaboration token wrote: %v", err)
	}
	if err = repo.auth.AuthorizePublishing(ctx, w.org, writer.UserID, writer.SessionID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("demoted member published: %v", err)
	}
	foreign := writer
	foreign.OrganizationID = "other-workspace"
	if _, err = repo.GetContentDraft(ctx, foreign, draft.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("cross-workspace read: %v", err)
	}
}

// A handler's first check reuses the middleware's, still gating by role;
// every later check, and any check under a transaction's lock, reads again.
func TestRequestAuthorizationMemo(t *testing.T) {
	w := newTestWorkspace(t)
	for _, name := range []string{"reader", "leaver", "viewer"} {
		w.addMember(t, name, "viewer")
	}
	middleware := func(actor Actor) context.Context {
		t.Helper()
		var memo publishing.AuthorizationMemo
		if err := w.repo.AuthorizeRead(publishing.RecordAuthorization(w.ctx, &memo), actor); err != nil {
			t.Fatal(err)
		}
		return publishing.ReplayAuthorization(w.ctx, &memo)
	}

	reader := w.actor("reader")
	handler := middleware(reader)
	w.exec(t, `DELETE FROM member WHERE id=$1`, "member_reader_"+w.id)
	if err := w.repo.AuthorizeRead(handler, reader); err != nil {
		t.Fatalf("handler's first check read again: %v", err)
	}
	if err := w.repo.AuthorizeRead(handler, reader); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a later check reused the middleware's: %v", err)
	}

	leaver := w.actor("leaver")
	handler = middleware(leaver)
	w.exec(t, `DELETE FROM member WHERE id=$1`, "member_leaver_"+w.id)
	// The locked recheck refuses before LeaveWorkspace's own lookup would.
	if _, err := w.repo.LeaveWorkspace(handler, leaver); err != publishing.ErrForbidden {
		t.Fatalf("locked recheck reused the middleware's check: %v", err)
	}

	viewer := w.actor("viewer")
	if err := w.repo.auth.AuthorizePublishing(middleware(viewer), w.org, viewer.UserID, viewer.SessionID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("reused viewer published: %v", err)
	}
}
