package product

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/thread"
	"github.com/lucsky/cuid"
)

// Content drafts, round two: the queue fills free slots, a post moves
// without a new charge, approval gates scheduling, share links read and take
// comments, revisions are kept, and a stopped thread resumes.
func TestContentDraftPlatform(t *testing.T) {
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
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	id := cuid.New()
	org := "org_" + id
	userID := "user_" + org
	meter := &recordingMonthlyMeter{}
	repo := NewConfiguration(db.Client).WithMonthlyMeter(meter)
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, userID, org+"@example.test")
	exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, org)
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
		"session_"+org, userID, org)
	exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+org, org, userID)
	subscribe(t, ctx, repo, org, "pro")
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM scheduled_post WHERE "organizationId" = $1`, org)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM content_draft WHERE "organizationId" = $1`, org)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id = $1`, org)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id = $1`, userID)
	})
	owner := Actor{OrganizationID: org, UserID: userID, SessionID: "session_" + org, RequestID: "request_" + id}
	addCredential := socialCredentialFixture(t, ctx, db.SQL, org)
	addCredential("x-"+id, "x")
	connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: userID, RequestID: owner.RequestID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: "x-" + id, Platform: "x", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
	if err != nil {
		t.Fatal(err)
	}
	newDraft := func(text string) *ContentDraftRecord {
		t.Helper()
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: text, Title: text})
		if err != nil {
			t.Fatal(err)
		}
		return draft
	}
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	schedule := func(draft *ContentDraftRecord, when time.Time) (*ScheduleContentDraftResult, error) {
		return repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: when, Version: draft.Version,
			Targets: []ContentDraftScheduleTarget{{Caption: draft.Title, ChannelConnectionID: connection.ID}}})
	}

	t.Run("the queue fills the next free slot", func(t *testing.T) {
		settings, err := repo.GetContentDraftSettings(ctx, owner)
		if err != nil || len(settings.PostingSlots) != 5 || settings.RequireApproval {
			t.Fatalf("defaults=%+v err=%v", settings, err)
		}
		// Every day at 07:30 UTC (the workspace has no time zone set).
		slots := []schema.QueueSlot{}
		for day := 0; day < 7; day++ {
			slots = append(slots, schema.QueueSlot{Weekday: day, Time: "07:30"})
		}
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{PostingSlots: &slots}); err != nil {
			t.Fatal(err)
		}
		bad := []schema.QueueSlot{{Weekday: 9, Time: "25:00"}}
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{PostingSlots: &bad}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("bad slot err=%v", err)
		}
		first, err := repo.NextQueueSlot(ctx, owner, "")
		if err != nil || first.Hour() != 7 || first.Minute() != 30 || !first.After(time.Now()) {
			t.Fatalf("first=%v err=%v", first, err)
		}
		if _, err := schedule(newDraft("Queued one"), first); err != nil {
			t.Fatal(err)
		}
		second, err := repo.NextQueueSlot(ctx, owner, "")
		if err != nil || !second.Equal(first.Add(24*time.Hour)) {
			t.Fatalf("second=%v first=%v err=%v", second, first, err)
		}
	})

	t.Run("batch preview does not mutate and changed queue times are rejected", func(t *testing.T) {
		draft := newDraft("Bulk preview")
		rival := newDraft("Takes previewed slot")
		t.Cleanup(func() {
			exec(`DELETE FROM scheduled_post WHERE "contentDraftId" IN ($1,$2)`, draft.ID, rival.ID)
			exec(`DELETE FROM content_draft WHERE id IN ($1,$2)`, draft.ID, rival.ID)
		})
		times, err := repo.PreviewDraftBatchTimes(ctx, owner, DraftBatchTimesInput{Count: 2, Mode: "queue"})
		if err != nil || len(times) != 2 || !times[1].After(times[0]) {
			t.Fatalf("times %v: %v", times, err)
		}
		input := ScheduleContentDraftInput{Queue: true, ExpectedQueueSlot: &times[0], Version: draft.Version, Targets: []ContentDraftScheduleTarget{{Caption: "Bulk preview", ChannelConnectionID: connection.ID}}}
		if err := repo.ValidateContentDraftSchedule(ctx, owner, draft.ID, input); err != nil {
			t.Fatal(err)
		}
		posts, err := repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if err != nil || len(posts) != 0 {
			t.Fatal("preflight created posts", err)
		}
		if _, err := schedule(rival, times[0]); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, input); !errors.Is(err, publishing.ErrConflict) {
			t.Fatal("changed queue silently moved batch", err)
		}
		posts, _ = repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if len(posts) != 0 {
			t.Fatal("conflicting row was scheduled")
		}
		input.ExpectedQueueSlot = &times[1]
		result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, input)
		if err != nil || len(result.Posts) != 1 {
			t.Fatal("remaining slot failed", err)
		}
		replay, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, input)
		if err != nil || replay.Posts[0].ID != result.Posts[0].ID {
			t.Fatal("batch retry duplicated post", err)
		}
	})

	t.Run("a queued post moves without another charge", func(t *testing.T) {
		draft := newDraft("Move me")
		result, err := schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		total := func() (sum int64) {
			for _, used := range meter.used {
				sum += used
			}
			return sum
		}
		charged := total()
		later := at.Add(3 * time.Hour)
		moved, err := repo.MoveContentDraftPost(ctx, owner, result.Posts[0].ID, later)
		if err != nil || moved.Cancelled != result.Posts[0].ID || !moved.Post.ScheduledFor.Equal(later) || total() != charged {
			t.Fatalf("moved=%+v err=%v charges=%d/%d", moved, err, total(), charged)
		}
		if _, err := repo.MoveContentDraftPost(ctx, owner, result.Posts[0].ID, later); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("moving a cancelled post err=%v", err)
		}
		// Calendar tag attribution follows the visible draft, not unrelated workspace tags.
		if err := db.Client.ContentDraft.UpdateOneID(draft.ID).SetTagIds([]string{"calendar-tag"}).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		calendar, err := repo.ListContentDraftPostsBetween(ctx, owner, at, at.Add(24*time.Hour), "")
		if err != nil || len(calendar) != 1 || calendar[0].DraftTitle != "Move me" {
			t.Fatalf("calendar=%+v err=%v", calendar, err)
		}
		if len(calendar[0].TagIDs) != 1 || calendar[0].TagIDs[0] != "calendar-tag" {
			t.Fatalf("calendar tags=%v", calendar[0].TagIDs)
		}
	})

	t.Run("the calendar leaves out a failure that a retry replaced", func(t *testing.T) {
		draft := newDraft("Failed then retried")
		result, err := schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		failed := result.Posts[0].ID
		if err := db.Client.ScheduledPost.UpdateOneID(failed).SetStatus(scheduledpost.StatusFAILED).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		shown := func() bool {
			calendar, err := repo.ListContentDraftPostsBetween(ctx, owner, at.Add(-time.Hour), at.Add(time.Hour), "")
			if err != nil {
				t.Fatal(err)
			}
			for _, post := range calendar {
				if post.ID == failed {
					return true
				}
			}
			return false
		}
		if !shown() {
			t.Fatal("a failure with no retry must show on the calendar")
		}
		// The retry goes out now, outside this range; the failure is history.
		if _, err := repo.RetryContentDraftPost(ctx, owner, failed); err != nil {
			t.Fatal(err)
		}
		if shown() {
			t.Fatal("a failure that a retry replaced still shows on the calendar")
		}
	})

	t.Run("concurrent calendar moves replace a queued post once", func(t *testing.T) {
		draft := newDraft("Concurrent move")
		result, err := schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		start := make(chan struct{})
		results := make(chan error, 8)
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				_, err := repo.MoveContentDraftPost(ctx, owner, result.Posts[0].ID, at.Add(time.Duration(i+1)*time.Hour))
				results <- err
			}(i)
		}
		close(start)
		wg.Wait()
		close(results)
		wins := 0
		for err := range results {
			if err == nil {
				wins++
			} else if !errors.Is(err, publishing.ErrConflict) {
				t.Fatal(err)
			}
		}
		count, err := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID), scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED)).Count(ctx)
		if err != nil || wins != 1 || count != 1 {
			t.Fatalf("wins=%d queued=%d err=%v", wins, count, err)
		}
	})

	t.Run("TF-031 concurrent moves replace a commitment once", func(t *testing.T) {
		result, err := schedule(newDraft("Concurrent move"), at.Add(72*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		outcomes := make(chan error, 2)
		var group sync.WaitGroup
		for i := 0; i < 2; i++ {
			group.Add(1)
			go func(index int) {
				defer group.Done()
				<-start
				_, err := repo.MoveContentDraftPost(ctx, owner, result.Posts[0].ID, at.Add(time.Duration(80+index)*time.Hour))
				outcomes <- err
			}(i)
		}
		close(start)
		group.Wait()
		close(outcomes)
		won := 0
		for err := range outcomes {
			if err == nil {
				won++
			} else if !errors.Is(err, publishing.ErrConflict) {
				t.Fatal(err)
			}
		}
		if won != 1 {
			t.Fatalf("%d moves committed; want exactly one", won)
		}
	})

	t.Run("TF-031 swaps are atomic and preserve jitter and immutable content", func(t *testing.T) {
		one, err := schedule(newDraft("Swap first"), at.Add(100*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		two, err := schedule(newDraft("Swap second"), at.Add(110*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE scheduled_post SET "naturalOffsetSeconds"=120 WHERE id=$1`, one.Posts[0].ID)
		swapped, err := repo.SwapContentDraftPosts(ctx, owner, one.Posts[0].ID, two.Posts[0].ID)
		if err != nil || len(swapped) != 2 {
			t.Fatalf("swap: %v %v", swapped, err)
		}
		for _, moved := range swapped {
			if moved.Post.Caption == "Swap first" && (!moved.Post.SlotAt.Equal(two.Posts[0].ScheduledFor) || !moved.Post.ScheduledFor.Equal(two.Posts[0].ScheduledFor.Add(2*time.Minute))) {
				t.Fatalf("lost natural time: %+v", moved.Post)
			}
			old, err := db.Client.ScheduledPost.Get(ctx, moved.Cancelled)
			if err != nil || old.Status != scheduledpost.StatusCANCELLED {
				t.Fatalf("old commitment: %v %v", old, err)
			}
		}
		if _, err := repo.SwapContentDraftPosts(ctx, owner, one.Posts[0].ID, two.Posts[0].ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("stale swap: %v", err)
		}
		// A worker's claim refuses the entire swap, including the untouched post.
		exec(`UPDATE scheduled_post SET status='PROCESSING' WHERE id=$1`, swapped[1].Post.ID)
		if _, err := repo.SwapContentDraftPosts(ctx, owner, swapped[0].Post.ID, swapped[1].Post.ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("claimed swap: %v", err)
		}
		untouched, _ := db.Client.ScheduledPost.Get(ctx, swapped[0].Post.ID)
		if untouched.Status != scheduledpost.StatusSCHEDULED {
			t.Fatal("failed swap changed the other post")
		}
	})

	t.Run("TF-034 repurpose copies published evidence, not later edits or publication jobs", func(t *testing.T) {
		source := newDraft("Published evidence")
		result, err := schedule(source, at.Add(120*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE scheduled_post SET status='PUBLISHED', "remotePostId"='123456789' WHERE id=$1`, result.Posts[0].ID)
		exec(`UPDATE scheduled_post SET poll='{"durationMinutes":60,"options":["A","B"]}', "publishOptions"='{"madeWithAi":true}' WHERE id=$1`, result.Posts[0].ID)
		exec(`UPDATE content_draft SET "plainText"='Later edited text' WHERE id=$1`, source.ID)
		copy, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "repurpose", Target: &draftdoc.Target{SourceDraftID: source.ID}})
		if err != nil {
			t.Fatal(err)
		}
		if copy.ID == source.ID || copy.PlainText != "Published evidence" || copy.Target.SourcePostID != result.Posts[0].ID || copy.Target.RemoteID != "123456789" || copy.Status != "draft" {
			t.Fatalf("wrong repurpose: %+v", copy)
		}
		first := copy.Body[0].(map[string]any)
		if first["poll"] == nil || first["disclosures"] == nil {
			t.Fatalf("published poll or disclosure lost: %+v", first)
		}
		posts, err := repo.ListContentDraftPosts(ctx, owner, copy.ID)
		if err != nil || len(posts) != 0 {
			t.Fatalf("repurpose scheduled a job: %+v %v", posts, err)
		}
		if _, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Kind: "repurpose", Target: &draftdoc.Target{SourceDraftID: newDraft("Unpublished").ID}}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("unpublished source: %v", err)
		}
	})

	t.Run("publish now consumes the queued snapshot once and replays after a lost response", func(t *testing.T) {
		draft := newDraft("The queued snapshot")
		queued, err := schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		usage := func() int64 {
			var total int64
			for _, value := range meter.used {
				total += value
			}
			return total
		}
		before := usage()
		var results [2]*MovedDraftPost
		var failures [2]error
		var wait sync.WaitGroup
		for i := range results {
			wait.Add(1)
			go func(i int) {
				defer wait.Done()
				results[i], failures[i] = repo.PublishQueuedContentDraftPost(ctx, owner, queued.Posts[0].ID)
			}(i)
		}
		wait.Wait()
		for _, err := range failures {
			if err != nil {
				t.Fatal(err)
			}
		}
		if results[0].Post.ID != results[1].Post.ID || results[0].Post.Caption != draft.Title || results[0].Post.ScheduledFor.After(time.Now()) || usage() != before {
			t.Fatalf("duplicate, changed snapshot, timer or quota: %+v %+v", results[0], results[1])
		}
		old, _ := db.Client.ScheduledPost.Get(ctx, queued.Posts[0].ID)
		if old.Status != scheduledpost.StatusCANCELLED {
			t.Fatal("old timer still executable")
		}
		if _, err := db.Client.ScheduledPost.UpdateOneID(results[0].Post.ID).SetStatus(scheduledpost.StatusPROCESSING).Save(ctx); err != nil {
			t.Fatal(err)
		}
		replay, err := repo.PublishQueuedContentDraftPost(ctx, owner, old.ID)
		if err != nil || replay.Post.ID != results[0].Post.ID || replay.Post.Status != "PROCESSING" {
			t.Fatalf("replay=%+v err=%v", replay, err)
		}
	})

	t.Run("publish now refuses a worker claim and revoked approval", func(t *testing.T) {
		queued, err := schedule(newDraft("Already publishing"), at)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Client.ScheduledPost.UpdateOneID(queued.Posts[0].ID).SetStatus(scheduledpost.StatusPROCESSING).Save(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.PublishQueuedContentDraftPost(ctx, owner, queued.Posts[0].ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("worker claim: %v", err)
		}
		required := true
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			off := false
			_, _ = repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		}()
		draft := newDraft("Approved for scheduling")
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		queued, err = schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		// An approval remains valid across scheduling's non-content version bump.
		if _, err := repo.PublishQueuedContentDraftPost(ctx, owner, queued.Posts[0].ID); err != nil {
			t.Fatal(err)
		}
		draft = newDraft("Review revoked after scheduling")
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		queued, err = schedule(draft, at)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "changes"}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.PublishQueuedContentDraftPost(ctx, owner, queued.Posts[0].ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("revoked approval: %v", err)
		}
		old, _ := db.Client.ScheduledPost.Get(ctx, queued.Posts[0].ID)
		if old.Status != scheduledpost.StatusSCHEDULED {
			t.Fatal("failed command consumed original timer")
		}
		// Approving a corrected edit approves the edit, not the queued snapshot it replaced.
		current, err := repo.GetContentDraft(ctx, owner, draft.ID)
		if err != nil {
			t.Fatal(err)
		}
		title := "Corrected after review"
		if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: current.Version, Title: &title}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.PublishQueuedContentDraftPost(ctx, owner, queued.Posts[0].ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("withdrawn snapshot published under a later approval: %v", err)
		}
	})

	t.Run("approval gates scheduling at the approved version", func(t *testing.T) {
		required := true
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			off := false
			_, _ = repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		})
		draft := newDraft("Needs review")
		if _, err := schedule(draft, at); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("unreviewed schedule err=%v", err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "request"}); err != nil {
			t.Fatal(err)
		}
		approved, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "approve", Note: "Ship it"})
		if err != nil || approved.ReviewStatus != "approved" || approved.ApprovedVersion == nil || *approved.ApprovedVersion != draft.Version {
			t.Fatalf("approved=%+v err=%v", approved, err)
		}
		title := "Edited after approval"
		edited, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := schedule(edited, at); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("schedule after an edit err=%v", err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		if _, err := schedule(edited, at.Add(time.Hour)); err != nil {
			t.Fatalf("approved schedule err=%v", err)
		}
	})

	t.Run("a share link reads the draft and takes guest comments", func(t *testing.T) {
		draft := newDraft("Shared")
		shared, err := repo.ShareContentDraft(ctx, owner, draft.ID, true)
		if err != nil || shared.ShareToken == nil {
			t.Fatalf("shared=%+v err=%v", shared, err)
		}
		view, err := repo.AddGuestComment(ctx, *shared.ShareToken, GuestCommentInput{Name: "Ana", Text: "Love it"})
		if err != nil || view.Title != "Shared" || len(view.GuestComments) != 1 || view.GuestComments[0]["name"] != "Ana" {
			t.Fatalf("view=%+v err=%v", view, err)
		}
		if _, err := repo.AddGuestComment(ctx, *shared.ShareToken, GuestCommentInput{Name: "", Text: "x"}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("nameless comment err=%v", err)
		}
		if _, err := repo.ShareContentDraft(ctx, owner, draft.ID, false); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.GetSharedContentDraft(ctx, *shared.ShareToken); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("revoked link err=%v", err)
		}
	})

	t.Run("published reading uses confirmed immutable thread and revokes", func(t *testing.T) {
		draft := newDraft("Private next revision")
		shared, err := repo.ShareContentDraft(ctx, owner, draft.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		post, err := db.Client.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(org).SetContentDraftID(draft.ID).SetChannelConnectionID(connection.ID).SetScheduledFor(time.Now()).SetPublishedAt(time.Now()).SetStatus(scheduledpost.StatusPUBLISHED).SetCaption("Published root").SetRemotePostID("123").SetIdempotencyKey("unroll:" + draft.ID).SetReplies([]thread.Reply{{Caption: "Confirmed reply"}, {Caption: "Unsent private reply"}}).SetThreadProgress(postoptions.ThreadProgress{Posted: 1, Total: 2, LastReplyID: "456"}).Save(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { exec(`DELETE FROM scheduled_post WHERE id=$1`, post.ID) })
		view, err := repo.GetSharedContentDraft(ctx, *shared.ShareToken)
		if err != nil || !view.Published || view.PlainText != "Published root\n\nConfirmed reply" || len(view.Body) != 0 || view.PublishedURL == nil {
			t.Fatalf("unsafe published reading: %+v %v", view, err)
		}
		if view.Title != "Published root" {
			t.Fatal("later draft title leaked", view.Title)
		}
		resumed, err := db.Client.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(org).SetContentDraftID(draft.ID).SetChannelConnectionID(connection.ID).SetScheduledFor(time.Now()).SetPublishedAt(time.Now()).SetStatus(scheduledpost.StatusPUBLISHED).SetCaption("Resumed reply").SetRemotePostID("789").SetReplyTo("456").SetIdempotencyKey("unroll-resumed:" + draft.ID).Save(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { exec(`DELETE FROM scheduled_post WHERE id=$1`, resumed.ID) })
		view, err = repo.GetSharedContentDraft(ctx, *shared.ShareToken)
		if err != nil || view.PlainText != "Published root\n\nConfirmed reply\n\nResumed reply" {
			t.Fatalf("confirmed continuation missing: %+v %v", view, err)
		}
		if _, err := repo.ShareContentDraft(ctx, owner, draft.ID, false); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.GetSharedContentDraft(ctx, *shared.ShareToken); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatal("revoked published thread accessible", err)
		}
	})

	t.Run("revisions keep the draft as it was", func(t *testing.T) {
		draft := newDraft("First words")
		title := "Second words"
		if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: draft.Version, Title: &title}); err != nil {
			t.Fatal(err)
		}
		revisions, err := repo.ListContentDraftRevisions(ctx, owner, draft.ID)
		if err != nil || len(revisions) != 1 || revisions[0].Title != "Second words" {
			t.Fatalf("revisions=%+v err=%v", revisions, err)
		}
		one, err := repo.GetContentDraftRevision(ctx, owner, draft.ID, revisions[0].ID)
		if err != nil || one.Body == nil {
			t.Fatalf("revision=%+v err=%v", one, err)
		}
	})

	t.Run("a stopped thread resumes from its last live reply", func(t *testing.T) {
		draft := newDraft("Thread")
		result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Version: draft.Version,
			Targets: []ContentDraftScheduleTarget{{Caption: "One", ChannelConnectionID: connection.ID,
				Replies: []thread.Reply{{Caption: "Two"}, {Caption: "Three"}, {Caption: "Four"}}}}})
		if err != nil {
			t.Fatal(err)
		}
		postID := result.Posts[0].ID
		if _, err := repo.ResumeContentDraftThread(ctx, owner, postID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("resume before live err=%v", err)
		}
		if _, err := db.Client.ScheduledPost.UpdateOneID(postID).SetStatus(scheduledpost.StatusPUBLISHED).SetRemotePostID("remote-1").
			SetThreadProgress(postoptions.ThreadProgress{LastReplyID: "remote-2", Posted: 1, Total: 3}).Save(ctx); err != nil {
			t.Fatal(err)
		}
		resumed, err := repo.ResumeContentDraftThread(ctx, owner, postID)
		if err != nil || resumed.Scheduled.Caption != "Three" || resumed.Scheduled.ReplyTo == nil ||
			*resumed.Scheduled.ReplyTo != "remote-2" || len(resumed.Scheduled.Replies) != 1 {
			t.Fatalf("resumed=%+v err=%v", resumed, err)
		}
		posts, err := repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if err != nil || len(posts) != 2 || !strings.HasPrefix(*posts[1].URL, "https://x.com/i/status/remote-1") {
			t.Fatalf("posts=%+v err=%v", posts, err)
		}
		best, err := repo.BestPostingTimes(ctx, owner, "")
		if err != nil || len(best) != 3 || !best[0].At.After(time.Now()) {
			t.Fatalf("best=%+v err=%v", best, err)
		}
	})
	t.Run("best-time suggestions never borrow private set engagement", func(t *testing.T) {
		private, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Private metrics", Visibility: "PRIVATE"})
		if err != nil {
			t.Fatal(err)
		}
		privateDraft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Private engagement source", SocialSetID: private.ID})
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 5; i++ {
			id := cuid.New()
			_, err := db.Client.ScheduledPost.Create().SetID(id).SetOrganizationID(org).SetContentDraftID(privateDraft.ID).SetChannelConnectionID(connection.ID).SetSocialSetID(private.ID).SetScheduledFor(time.Now().Add(-time.Hour)).SetPublishedAt(time.Now().Add(-time.Hour)).SetStatus(scheduledpost.StatusPUBLISHED).SetCaption("private").SetIdempotencyKey(id).SetMetrics(postoptions.Metrics{"likes": 900}).SetMetricsAt(time.Now()).Save(ctx)
			if err != nil {
				t.Fatal(err)
			}
		}
		defaults, err := repo.BestPostingTimes(ctx, owner, "")
		if err != nil || len(defaults) == 0 || defaults[0].Score != nil || defaults[0].SamplePosts != 0 || !strings.Contains(defaults[0].Reason, "insufficient history") {
			t.Fatalf("private engagement leaked into default set: %v %v", defaults, err)
		}
		personal, err := repo.BestPostingTimes(ctx, owner, private.ID)
		if err != nil || len(personal) == 0 || personal[0].Score == nil || *personal[0].Score != 900 || personal[0].SamplePosts != 5 || !strings.Contains(personal[0].Reason, "most engagement") {
			t.Fatalf("private set's own history unavailable: %v %v", personal, err)
		}
	})

	t.Run("queue swap is atomic and concurrent replay cannot duplicate", func(t *testing.T) {
		first, err := schedule(newDraft("Swap first"), at.Add(72*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		second, err := schedule(newDraft("Swap second"), at.Add(73*time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		outcomes := make(chan error, 6)
		for range 6 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := repo.SwapContentDraftPosts(ctx, owner, first.Posts[0].ID, second.Posts[0].ID)
				outcomes <- err
			}()
		}
		wg.Wait()
		close(outcomes)
		success := 0
		for err := range outcomes {
			if err == nil {
				success++
			} else if !errors.Is(err, publishing.ErrConflict) {
				t.Fatal(err)
			}
		}
		if success != 1 {
			t.Fatalf("swap winners %d", success)
		}
		for _, pair := range []struct {
			draft string
			at    time.Time
		}{{first.Draft.ID, second.Posts[0].ScheduledFor}, {second.Draft.ID, first.Posts[0].ScheduledFor}} {
			posts, err := repo.ListContentDraftPosts(ctx, owner, pair.draft)
			if err != nil {
				t.Fatal(err)
			}
			active := 0
			for _, post := range posts {
				if post.Status == "SCHEDULED" {
					active++
					if !post.ScheduledFor.Equal(pair.at) {
						t.Fatalf("wrong swapped time: %v", post.ScheduledFor)
					}
				}
			}
			if active != 1 {
				t.Fatalf("active copies %d", active)
			}
		}
	})

}
