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
	t.Run("the scheduled-posts route refuses drafts where approval is required", func(t *testing.T) {
		draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Route", PlainText: "Pending"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = repo.ReviewContentDraft(ctx, w.actor("creator"), draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "request"}); err != nil {
			t.Fatal(err)
		}
		input := publishing.CreateScheduledPostInput{Caption: "Text no one reviewed", ChannelConnectionID: connection.ID, ContentDraftID: draft.ID,
			IdempotencyKey: "route-" + w.id, ScheduledFor: time.Now().Add(48 * time.Hour).UTC()}
		publisher := w.actor("publisher")
		_, err = repo.CreateScheduledPost(ctx, publisher, input)
		if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("approval skipped through the scheduled-posts route: %v", err)
		}
		posts, err := repo.ListContentDraftPosts(ctx, w.owner, draft.ID)
		if err != nil || len(posts) != 0 {
			t.Fatalf("refused request queued posts=%+v err=%v", posts, err)
		}
		// With approval off the route schedules the draft as before.
		off, on := false, true
		if _, err = repo.UpdateContentDraftSettings(ctx, w.owner, ContentDraftSettingsUpdate{RequireApproval: &off}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = repo.UpdateContentDraftSettings(ctx, w.owner, ContentDraftSettingsUpdate{RequireApproval: &on})
		})
		created, err := repo.CreateScheduledPost(ctx, publisher, input)
		if err != nil || !created.Created || created.Post.ContentDraftID == nil || *created.Post.ContentDraftID != draft.ID {
			t.Fatalf("approval off: created=%+v err=%v", created, err)
		}
		if by := created.Post.ScheduledByUserID; by == nil || *by != publisher.UserID || created.Post.ApprovedByUserID != nil {
			t.Fatalf("route post accountability: scheduledBy=%v approvedBy=%v", by, created.Post.ApprovedByUserID)
		}
	})
	t.Run("self-approval can be refused; a scheduled post records who scheduled and approved", func(t *testing.T) {
		settings, err := repo.GetContentDraftSettings(ctx, w.owner)
		if err != nil || !settings.AllowSelfApproval {
			t.Fatalf("self-approval is not allowed by default: %+v %v", settings, err)
		}
		admin := w.actor("admin")
		draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Self", PlainText: "Self"})
		if err != nil {
			t.Fatal(err)
		}
		title := "Admin edit"
		draft, err = repo.UpdateContentDraft(ctx, admin, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title})
		if err != nil {
			t.Fatal(err)
		}
		// A one-person workspace keeps working: by default the last editor approves.
		if _, err = repo.ReviewContentDraft(ctx, admin, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); err != nil {
			t.Fatalf("default self-approval: %v", err)
		}
		if _, err = repo.ReviewContentDraft(ctx, admin, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "request"}); err != nil {
			t.Fatal(err)
		}
		off, on := false, true
		updated, err := repo.UpdateContentDraftSettings(ctx, w.owner, ContentDraftSettingsUpdate{AllowSelfApproval: &off})
		if err != nil || updated.AllowSelfApproval || !updated.RequireApproval {
			t.Fatalf("settings=%+v err=%v", updated, err)
		}
		t.Cleanup(func() {
			_, _ = repo.UpdateContentDraftSettings(ctx, w.owner, ContentDraftSettingsUpdate{AllowSelfApproval: &on})
		})
		if _, err = repo.ReviewContentDraft(ctx, admin, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); !errors.Is(err, publishing.ErrForbidden) {
			t.Fatalf("last editor approved with self-approval off: %v", err)
		}
		approver := w.actor("approver")
		approved, err := repo.ReviewContentDraft(ctx, approver, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"})
		if err != nil {
			t.Fatal(err)
		}
		publisher := w.actor("publisher")
		result, err := repo.ScheduleContentDraft(ctx, publisher, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(72 * time.Hour).UTC(),
			Version: approved.Version, Targets: []ContentDraftScheduleTarget{{Caption: "Self", ChannelConnectionID: connection.ID}}})
		if err != nil || len(result.Posts) != 1 {
			t.Fatalf("schedule approved draft: %+v %v", result, err)
		}
		post, err := w.db.Client.ScheduledPost.Get(ctx, result.Posts[0].ID)
		if err != nil {
			t.Fatal(err)
		}
		if post.ScheduledByUserID == nil || *post.ScheduledByUserID != publisher.UserID || post.ApprovedByUserID == nil || *post.ApprovedByUserID != approver.UserID ||
			post.ApprovedVersion == nil || *post.ApprovedVersion != approved.Version {
			t.Fatalf("scheduledBy=%v approvedBy=%v approvedVersion=%v", post.ScheduledByUserID, post.ApprovedByUserID, post.ApprovedVersion)
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
