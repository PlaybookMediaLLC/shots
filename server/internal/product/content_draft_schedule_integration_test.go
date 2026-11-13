package product

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/thread"
	"github.com/lucsky/cuid"
)

// Scheduling a content draft: one post per channel, a double submit replays
// instead of duplicating, a stale version is refused, rescheduling replaces
// queued posts, captions are checked per channel, another workspace sees
// nothing, and every post has exactly one source.
func TestContentDraftScheduling(t *testing.T) {
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := cuid.New()
	org, other := "org_"+id, "other_"+id
	meter := &recordingMonthlyMeter{}
	repo := NewConfiguration(db.Client).WithMonthlyMeter(meter)
	actors := map[string]Actor{}
	for _, organization := range []string{org, other} {
		userID := "user_" + organization
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, userID, organization+"@example.test")
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
			"session_"+organization, userID, organization)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+organization, organization, userID)
		actors[organization] = Actor{OrganizationID: organization, UserID: userID, SessionID: "session_" + organization, RequestID: "request_" + id}
		subscribe(t, ctx, repo, organization, "pro")
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM scheduled_post WHERE "organizationId" IN ($1,$2)`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM content_draft WHERE "organizationId" IN ($1,$2)`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id IN ($1,$2)`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id IN ($1,$2)`, "user_"+org, "user_"+other)
	})
	owner, foreign := actors[org], actors[other]
	addCredential := socialCredentialFixture(t, ctx, db.SQL, org)
	connect := func(platform string) string {
		t.Helper()
		addCredential(platform+"-"+id, platform)
		connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: platform + "-" + id, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	xChannel, linkedinChannel, instagramChannel := connect("x"), connect("linkedin"), connect("instagram")

	draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: "Ship faster", Title: "Launch"})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	targets := []ContentDraftScheduleTarget{
		{Caption: "Ship faster on X", ChannelConnectionID: xChannel},
		{Caption: "Ship faster on LinkedIn, with more room to explain.", ChannelConnectionID: linkedinChannel},
	}

	t.Run("an over-limit caption and an imageless Instagram post are refused", func(t *testing.T) {
		long := []ContentDraftScheduleTarget{{Caption: strings.Repeat("a", 281), ChannelConnectionID: xChannel}}
		if _, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: long, Version: 1}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("over-limit X caption err=%v", err)
		}
		insta := []ContentDraftScheduleTarget{{Caption: "Hi", ChannelConnectionID: instagramChannel}}
		if _, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: insta, Version: 1}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("imageless Instagram err=%v", err)
		}
	})

	scheduled, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: targets, Version: 1})
	if err != nil || !scheduled.Created || len(scheduled.Posts) != 2 || len(scheduled.Scheduled) != 2 ||
		scheduled.Draft.Status != "scheduled" || scheduled.Draft.Version != 2 || len(scheduled.Draft.ChannelConnectionIDs) != 2 {
		t.Fatalf("scheduled=%+v err=%v", scheduled, err)
	}
	if scheduled.Posts[0].Caption != "Ship faster on X" || scheduled.Posts[0].Platform != "x" || scheduled.Posts[1].Platform != "linkedin" {
		t.Fatalf("posts=%+v", scheduled.Posts)
	}

	t.Run("a double submit replays the same posts", func(t *testing.T) {
		replay, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: targets, Version: 1})
		if err != nil || replay.Created || len(replay.Posts) != 2 {
			t.Fatalf("replay=%+v err=%v", replay, err)
		}
		if n, err := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID)).Count(ctx); err != nil || n != 2 {
			t.Fatalf("posts after replay=%d err=%v", n, err)
		}
	})

	t.Run("a stale version is refused", func(t *testing.T) {
		title := "Edited"
		if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: 2, Title: &title}); err != nil {
			t.Fatal(err)
		}
		_, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at,
			Targets: targets[:1], Version: 2})
		var stale *ContentDraftVersionConflictError
		if !errors.As(err, &stale) || stale.Current != 3 {
			t.Fatalf("stale schedule err=%v", err)
		}
	})

	t.Run("editing the draft leaves queued captions alone, and rescheduling replaces them", func(t *testing.T) {
		posts, err := repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if err != nil || len(posts) != 2 || posts[0].Status != "SCHEDULED" {
			t.Fatalf("posts=%+v err=%v", posts, err)
		}
		again, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at,
			Targets: []ContentDraftScheduleTarget{{Caption: "Edited for X", ChannelConnectionID: xChannel}}, Version: 3})
		if err != nil || !again.Created || len(again.Cancelled) != 2 || len(again.Posts) != 1 || again.Draft.Version != 4 {
			t.Fatalf("reschedule=%+v err=%v", again, err)
		}
		for _, cancelled := range again.Cancelled {
			post, err := db.Client.ScheduledPost.Get(ctx, cancelled)
			if err != nil || post.Status != scheduledpost.StatusCANCELLED {
				t.Fatalf("replaced post=%+v err=%v", post, err)
			}
		}
	})

	t.Run("another workspace sees nothing", func(t *testing.T) {
		if _, err := repo.ScheduleContentDraft(ctx, foreign, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: targets, Version: 4}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("foreign schedule err=%v", err)
		}
		if _, err := repo.ListContentDraftPosts(ctx, foreign, draft.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("foreign posts err=%v", err)
		}
		otherDraft, err := repo.CreateContentDraft(ctx, foreign, ContentDraftInput{})
		if err != nil {
			t.Fatal(err)
		}
		// The other workspace cannot target this workspace's channel.
		if _, err := repo.ScheduleContentDraft(ctx, foreign, otherDraft.ID, ScheduleContentDraftInput{ScheduledFor: at,
			Targets: targets[:1], Version: 1}); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("foreign channel err=%v", err)
		}
	})

	t.Run("the publish job sends the snapshotted caption, as text without an image", func(t *testing.T) {
		live, err := repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if err != nil || len(live) == 0 || live[0].Status != "SCHEDULED" {
			t.Fatalf("live=%+v err=%v", live, err)
		}
		store := publishing.NewRepository(db.Client)
		if claimed, err := store.Claim(ctx, live[0].ID, "run-"+id, at.Add(time.Minute)); err != nil || !claimed {
			t.Fatalf("claimed=%v err=%v", claimed, err)
		}
		job, err := store.LoadPublishJob(ctx, live[0].ID, "run-"+id)
		if err != nil || !job.WorkspaceActive || job.AssetObjectKey != "" || job.Post.Caption != "Edited for X" {
			t.Fatalf("job=%+v err=%v", job, err)
		}
	})

	t.Run("an oversized X selection fails atomically and an explicit selection is preserved", func(t *testing.T) {
		images := make([]string, 5)
		for i := range images {
			images[i] = cuid.New()
			exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,width,height,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',1,1,now(),now())`,
				images[i], org, fmt.Sprintf("org/%s/%d.png", org, i))
		}
		t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM asset WHERE "organizationId" = $1`, org) })
		gallery, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{AssetIDs: images, Title: "Gallery"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ScheduleContentDraft(ctx, owner, gallery.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: targets, Version: 1}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("five X images must fail, not truncate: %v", err)
		}
		if posts, err := repo.ListContentDraftPosts(ctx, owner, gallery.ID); err != nil || len(posts) != 0 {
			t.Fatalf("a rejected selection created posts: %+v %v", posts, err)
		}
		selected := append([]ContentDraftScheduleTarget(nil), targets...)
		for i := range selected {
			if selected[i].ChannelConnectionID == xChannel {
				selected[i].AssetIDs = images[:4]
			}
		}
		result, err := repo.ScheduleContentDraft(ctx, owner, gallery.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: selected, Version: 1})
		if err != nil {
			t.Fatal(err)
		}
		store := publishing.NewRepository(db.Client)
		want := map[string]int{xChannel: 4, linkedinChannel: 5}
		for _, post := range result.Scheduled {
			if claimed, err := store.Claim(ctx, post.ID, "run-"+post.ID, at.Add(time.Minute)); err != nil || !claimed {
				t.Fatalf("claimed=%v err=%v", claimed, err)
			}
			job, err := store.LoadPublishJob(ctx, post.ID, "run-"+post.ID)
			count := want[post.ChannelConnectionID]
			if err != nil || !job.WorkspaceActive || len(job.Assets) != count || job.AssetObjectKey != "org/"+org+"/0.png" ||
				job.Assets[count-1].ObjectKey != fmt.Sprintf("org/%s/%d.png", org, count-1) {
				t.Fatalf("channel %s job=%+v err=%v", post.ChannelConnectionID, job, err)
			}
		}

		// A target's own images (a rendered table among them) replace the
		// draft's, and must be this workspace's uploads.
		tables, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{AssetIDs: images[:1], Title: "Tables"})
		if err != nil {
			t.Fatal(err)
		}
		foreignImage := []ContentDraftScheduleTarget{{AssetIDs: []string{cuid.New()}, Caption: "Theirs", ChannelConnectionID: xChannel}}
		if _, err := repo.ScheduleContentDraft(ctx, owner, tables.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: foreignImage, Version: 1}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("foreign target image err=%v", err)
		}
		own := []ContentDraftScheduleTarget{{AssetIDs: []string{images[4], images[0]}, Caption: "Rendered", ChannelConnectionID: xChannel}}
		rendered, err := repo.ScheduleContentDraft(ctx, owner, tables.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: own, Version: 1})
		if err != nil || len(rendered.Scheduled) != 1 || len(rendered.Scheduled[0].AssetIds) != 2 || rendered.Scheduled[0].AssetIds[0] != images[4] {
			t.Fatalf("rendered=%+v err=%v", rendered, err)
		}
	})

	t.Run("an X thread posts its later posts as replies", func(t *testing.T) {
		photo := cuid.New()
		exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,width,height,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',1,1,now(),now())`,
			photo, org, "org/"+org+"/reply.png")
		threadDraft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Thread"})
		if err != nil {
			t.Fatal(err)
		}
		onLinkedIn := []ContentDraftScheduleTarget{{Caption: "One", ChannelConnectionID: linkedinChannel,
			Replies: []thread.Reply{{Caption: "Two"}}}}
		if _, err := repo.ScheduleContentDraft(ctx, owner, threadDraft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: onLinkedIn, Version: 1}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("LinkedIn replies err=%v", err)
		}
		foreignReply := []ContentDraftScheduleTarget{{Caption: "One", ChannelConnectionID: xChannel,
			Replies: []thread.Reply{{AssetIDs: []string{cuid.New()}, Caption: "Two"}}}}
		if _, err := repo.ScheduleContentDraft(ctx, owner, threadDraft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: foreignReply, Version: 1}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("foreign reply image err=%v", err)
		}
		onX := []ContentDraftScheduleTarget{{Caption: "One", ChannelConnectionID: xChannel,
			Replies: []thread.Reply{{AssetIDs: []string{photo}, Caption: " Two "}, {Caption: "Three"}}}}
		result, err := repo.ScheduleContentDraft(ctx, owner, threadDraft.ID, ScheduleContentDraftInput{ScheduledFor: at, Targets: onX, Version: 1})
		if err != nil || len(result.Scheduled) != 1 || len(result.Scheduled[0].Replies) != 2 {
			t.Fatalf("result=%+v err=%v", result, err)
		}
		post := result.Scheduled[0]
		store := publishing.NewRepository(db.Client)
		if claimed, err := store.Claim(ctx, post.ID, "run-"+post.ID, at.Add(time.Minute)); err != nil || !claimed {
			t.Fatalf("claimed=%v err=%v", claimed, err)
		}
		job, err := store.LoadPublishJob(ctx, post.ID, "run-"+post.ID)
		if err != nil || !job.WorkspaceActive || len(job.Replies) != 2 || job.Replies[0].Caption != "Two" ||
			len(job.Replies[0].Assets) != 1 || job.Replies[0].Assets[0].ObjectKey != "org/"+org+"/reply.png" ||
			job.Replies[1].Caption != "Three" {
			t.Fatalf("job=%+v err=%v", job, err)
		}
	})

	t.Run("a post has exactly one source", func(t *testing.T) {
		post := cuid.New()
		_, err := db.SQL.ExecContext(ctx, `INSERT INTO scheduled_post (id,"organizationId","channelConnectionId","scheduledFor",status,caption,"idempotencyKey","updatedAt") VALUES ($1,$2,$3,now(),'SCHEDULED','x',$1,now())`,
			post, org, xChannel)
		if err == nil || !strings.Contains(err.Error(), "scheduled_post_source_check") {
			t.Fatalf("sourceless post err=%v", err)
		}
	})

	t.Run("the list counts a replaced failure as history and an unconfirmed post always", func(t *testing.T) {
		counted, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: "Counted", Title: "Counted"})
		if err != nil {
			t.Fatal(err)
		}
		post := func(channel, status, age string) {
			t.Helper()
			exec(`INSERT INTO scheduled_post (id,"organizationId","channelConnectionId","contentDraftId","scheduledFor",status,caption,"idempotencyKey","createdAt","updatedAt")
				VALUES ($1,$2,$3,$4,now()+interval '1 day',$5::"ScheduledPostStatus",'x',$1,now()-$6::interval,now())`,
				cuid.New(), org, channel, counted.ID, status, age)
		}
		// X: a failure a retry published. LinkedIn: an unconfirmed post with a newer one.
		// Instagram: a failure whose retry was cancelled, so it needs attention again.
		post(xChannel, "FAILED", "2 hours")
		post(xChannel, "PUBLISHED", "1 hour")
		post(linkedinChannel, "UNKNOWN_DELIVERY", "2 hours")
		post(linkedinChannel, "SCHEDULED", "1 hour")
		post(instagramChannel, "FAILED", "2 hours")
		post(instagramChannel, "CANCELLED", "1 hour")
		// X again: a post that is publishing now is queued, not the next one scheduled.
		post(xChannel, "PROCESSING", "30 minutes")
		page, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Limit: 100})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if item.ID != counted.ID {
				continue
			}
			if item.AttentionPosts != 2 || item.CheckPosts != 1 || item.PublishedPosts != 1 || item.QueuedPosts != 2 ||
				item.PublishingPosts != 1 || item.NextPostAt == nil {
				t.Fatalf("attention=%d check=%d published=%d queued=%d publishing=%d next=%v", item.AttentionPosts,
					item.CheckPosts, item.PublishedPosts, item.QueuedPosts, item.PublishingPosts, item.NextPostAt)
			}
			return
		}
		t.Fatalf("draft %s not listed", counted.ID)
	})

	t.Run("a post sent to an app counts apart: posted, never published or failed", func(t *testing.T) {
		sent, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: "Sent", Title: "Sent to app"})
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO scheduled_post (id,"organizationId","channelConnectionId","contentDraftId","scheduledFor",status,caption,"idempotencyKey","remotePostId","updatedAt")
			VALUES ($1,$2,$3,$4,now()-interval '1 hour','SENT_TO_APP','x',$1,'v_inbox_file~v2.1',now())`, cuid.New(), org, xChannel, sent.ID)
		listed := func(view string) *ContentDraftRecord {
			t.Helper()
			page, err := repo.ListContentDrafts(ctx, owner, ContentDraftListQuery{Limit: 100, View: view})
			if err != nil {
				t.Fatal(err)
			}
			for i := range page.Items {
				if page.Items[i].ID == sent.ID {
					return &page.Items[i]
				}
			}
			return nil
		}
		item := listed("")
		if item == nil || item.SentToAppPosts != 1 || item.PublishedPosts != 0 || item.AttentionPosts != 0 || item.QueuedPosts != 0 || item.LastPublishedAt != nil {
			t.Fatalf("listed %+v", item)
		}
		if listed("posted") == nil || listed("drafts") != nil || listed("failed") != nil {
			t.Fatal("a draft sent to an app belongs with the posted drafts")
		}
	})

	t.Run("a draft with posts cannot be deleted", func(t *testing.T) {
		if err := repo.DeleteContentDraft(ctx, owner, draft.ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("delete err=%v", err)
		}
	})
}
