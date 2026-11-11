package product

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Scheduling identity and queue reservations: a previewed slot is reserved
// when it is still free, a retry replays only the same intent, concurrent
// submits converge, and each post keeps the zone its time was read in.
func TestContentDraftScheduleReliability(t *testing.T) {
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
	connect := func(platform string) string {
		t.Helper()
		addCredential(platform+"-"+id, platform)
		connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: userID, RequestID: owner.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: platform + "-" + id, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	xChannel, linkedinChannel := connect("x"), connect("linkedin")
	newDraft := func(text string) *ContentDraftRecord {
		t.Helper()
		draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: text, Title: text})
		if err != nil {
			t.Fatal(err)
		}
		return draft
	}
	targets := func(caption string) []ContentDraftScheduleTarget {
		return []ContentDraftScheduleTarget{{Caption: caption, ChannelConnectionID: xChannel}}
	}
	// Slots every four hours keep the queue's next slots close and predictable.
	slots := []schema.QueueSlot{}
	for day := 0; day < 7; day++ {
		for hour := 0; hour < 24; hour += 4 {
			slots = append(slots, schema.QueueSlot{Weekday: day, Time: time.Date(0, 1, 1, hour, 17, 0, 0, time.UTC).Format("15:04")})
		}
	}
	if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{PostingSlots: &slots}); err != nil {
		t.Fatal(err)
	}

	t.Run("a failed earlier batch row does not move the later rows' previewed slots", func(t *testing.T) {
		first, second := newDraft("Batch first"), newDraft("Batch second")
		times, err := repo.PreviewDraftBatchTimes(ctx, owner, DraftBatchTimesInput{Count: 2, Mode: "queue"})
		if err != nil || len(times) != 2 {
			t.Fatalf("times=%v err=%v", times, err)
		}
		// The first row fails at commit (here, a stale version); its slot stays free.
		stale := ScheduleContentDraftInput{Queue: true, ExpectedQueueSlot: &times[0], Version: first.Version + 5, Targets: targets("Batch first")}
		var version *ContentDraftVersionConflictError
		if _, err := repo.ScheduleContentDraft(ctx, owner, first.ID, stale); !errors.As(err, &version) {
			t.Fatalf("stale row err=%v", err)
		}
		result, err := repo.ScheduleContentDraft(ctx, owner, second.ID, ScheduleContentDraftInput{Queue: true,
			ExpectedQueueSlot: &times[1], Version: second.Version, Targets: targets("Batch second")})
		if err != nil || len(result.Posts) != 1 || !result.Posts[0].SlotAt.Equal(times[1]) {
			t.Fatalf("second row result=%+v err=%v; want its previewed slot %v", result, err, times[1])
		}
		// The corrected first row still takes the slot it previewed.
		fixed, err := repo.ScheduleContentDraft(ctx, owner, first.ID, ScheduleContentDraftInput{Queue: true,
			ExpectedQueueSlot: &times[0], Version: first.Version, Targets: targets("Batch first")})
		if err != nil || !fixed.Posts[0].SlotAt.Equal(times[0]) {
			t.Fatalf("first row result=%+v err=%v", fixed, err)
		}
	})

	t.Run("a previewed slot another request took is a conflict naming the next free slot", func(t *testing.T) {
		mine, rival := newDraft("Mine"), newDraft("Rival")
		previewed, err := repo.NextQueueSlot(ctx, owner, "")
		if err != nil {
			t.Fatal(err)
		}
		var wg sync.WaitGroup
		errs := make([]error, 2)
		results := make([]*ScheduleContentDraftResult, 2)
		for index, draft := range []*ContentDraftRecord{mine, rival} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[index], errs[index] = repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{Queue: true,
					ExpectedQueueSlot: &previewed, Version: draft.Version, Targets: targets(draft.Title)})
			}()
		}
		wg.Wait()
		won, lost := 0, -1
		for index, err := range errs {
			if err == nil {
				won++
				if !results[index].Posts[0].SlotAt.Equal(previewed) {
					t.Fatalf("winner took %v, not the previewed %v", results[index].Posts[0].SlotAt, previewed)
				}
			} else {
				lost = index
			}
		}
		if won != 1 || lost < 0 {
			t.Fatalf("errs=%v; want one winner and one conflict", errs)
		}
		var taken *QueueSlotTakenError
		if !errors.As(errs[lost], &taken) || !errors.Is(errs[lost], publishing.ErrConflict) || !taken.Next.After(previewed) {
			t.Fatalf("loser err=%#v; want a conflict naming the next free slot", errs[lost])
		}
		loser := []*ContentDraftRecord{mine, rival}[lost]
		if n, _ := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(loser.ID)).Count(ctx); n != 0 {
			t.Fatalf("the losing request scheduled %d posts", n)
		}
	})

	t.Run("a retry with a different time is a conflict, not a silent replay", func(t *testing.T) {
		draft := newDraft("Changed retry")
		at := time.Now().Add(6 * time.Hour).UTC().Truncate(time.Minute)
		first, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Version: draft.Version, Targets: targets("Changed retry")})
		if err != nil || !first.Created {
			t.Fatalf("first=%+v err=%v", first, err)
		}
		same, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Version: draft.Version, Targets: targets("Changed retry")})
		if err != nil || same.Created || same.Posts[0].ID != first.Posts[0].ID {
			t.Fatalf("same retry=%+v err=%v", same, err)
		}
		_, err = repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at.Add(time.Hour), Version: draft.Version, Targets: targets("Changed retry")})
		if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("changed time err=%v; want a conflict", err)
		}
		_, err = repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{PublishNow: true, Version: draft.Version, Targets: targets("Changed retry")})
		if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("publish now under a scheduled version err=%v; want a conflict", err)
		}
		posts, _ := repo.ListContentDraftPosts(ctx, owner, draft.ID)
		if len(posts) != 1 || !posts[0].ScheduledFor.Equal(at) || posts[0].Status != "SCHEDULED" {
			t.Fatalf("posts=%+v", posts)
		}
		// A deliberate new schedule names the draft's new version.
		again, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at.Add(time.Hour), Version: first.Draft.Version, Targets: targets("Changed retry")})
		if err != nil || !again.Created || len(again.Cancelled) != 1 {
			t.Fatalf("new schedule=%+v err=%v", again, err)
		}
	})

	t.Run("a post queued before intents existed keeps replaying by its key", func(t *testing.T) {
		draft := newDraft("Legacy retry")
		at := time.Now().Add(8 * time.Hour).UTC().Truncate(time.Minute)
		first, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at, Version: draft.Version, Targets: targets("Legacy retry")})
		if err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE scheduled_post SET "scheduleIntent"=NULL WHERE id=$1`, first.Posts[0].ID)
		replay, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: at.Add(time.Hour), Version: draft.Version, Targets: targets("Legacy retry")})
		if err != nil || replay.Created || replay.Posts[0].ID != first.Posts[0].ID || !replay.Posts[0].ScheduledFor.Equal(at) {
			t.Fatalf("legacy replay=%+v err=%v", replay, err)
		}
	})

	t.Run("concurrent identical submits converge on one schedule", func(t *testing.T) {
		draft := newDraft("Double click")
		at := time.Now().Add(7 * time.Hour).UTC().Truncate(time.Minute)
		input := ScheduleContentDraftInput{ScheduledFor: at, Version: draft.Version, Targets: []ContentDraftScheduleTarget{
			{Caption: "Double click", ChannelConnectionID: xChannel}, {Caption: "Double click", ChannelConnectionID: linkedinChannel}}}
		var wg sync.WaitGroup
		errs := make([]error, 4)
		results := make([]*ScheduleContentDraftResult, 4)
		for index := range errs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[index], errs[index] = repo.ScheduleContentDraft(ctx, owner, draft.ID, input)
			}()
		}
		wg.Wait()
		created := 0
		for index, err := range errs {
			if err != nil {
				t.Fatalf("submit %d err=%v; want a replay", index, err)
			}
			if results[index].Created {
				created++
			}
		}
		if n, _ := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID)).Count(ctx); created != 1 || n != 2 {
			t.Fatalf("created=%d posts=%d", created, n)
		}
	})

	t.Run("a batch of 50 drafts validates, schedules the valid ones and retries without duplicates", func(t *testing.T) {
		charged := func() (sum int64) {
			for _, used := range meter.used {
				sum += used
			}
			return sum
		}
		before := charged()
		drafts := make([]*ContentDraftRecord, 50)
		for index := range drafts {
			drafts[index] = newDraft(fmt.Sprintf("Batch %02d", index))
		}
		archived := newDraft("Batch archived")
		if err := db.Client.ContentDraft.UpdateOneID(archived.ID).SetStatus("archived").Exec(ctx); err != nil {
			t.Fatal(err)
		}
		// Validation rejects the archived draft before anything is scheduled.
		if err := repo.ValidateContentDraftSchedule(ctx, owner, archived.ID, ScheduleContentDraftInput{Queue: true, Version: archived.Version, Targets: targets("x")}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("archived draft validated: %v", err)
		}
		times, err := repo.PreviewDraftBatchTimes(ctx, owner, DraftBatchTimesInput{Count: 50, Mode: "queue"})
		if err != nil || len(times) != 50 {
			t.Fatalf("times=%d err=%v", len(times), err)
		}
		inputs := make([]ScheduleContentDraftInput, 50)
		for index, draft := range drafts {
			inputs[index] = ScheduleContentDraftInput{Queue: true, ExpectedQueueSlot: &times[index], Version: draft.Version, Targets: targets(draft.Title)}
			if err := repo.ValidateContentDraftSchedule(ctx, owner, draft.ID, inputs[index]); err != nil {
				t.Fatalf("validate %d: %v", index, err)
			}
		}
		// Row 10 changes after its preview and is refused at commit; the rows after it keep their slots.
		title := "Edited after preview"
		if _, err := repo.UpdateContentDraft(ctx, owner, drafts[10].ID, ContentDraftUpdate{BaseVersion: drafts[10].Version, Title: &title}); err != nil {
			t.Fatal(err)
		}
		for index, draft := range drafts {
			result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, inputs[index])
			if index == 10 {
				var stale *ContentDraftVersionConflictError
				if !errors.As(err, &stale) {
					t.Fatalf("edited row err=%v", err)
				}
				continue
			}
			if err != nil || !result.Created || !result.Posts[0].SlotAt.Equal(times[index]) {
				t.Fatalf("row %d result=%+v err=%v", index, result, err)
			}
		}
		// Retrying every row sends the same requests: nothing new is created or charged.
		for index, draft := range drafts {
			if index == 10 {
				continue
			}
			replay, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, inputs[index])
			if err != nil || replay.Created {
				t.Fatalf("retry %d replay=%+v err=%v", index, replay, err)
			}
		}
		// The corrected row takes the slot it previewed, still free.
		inputs[10].Version++
		if fixed, err := repo.ScheduleContentDraft(ctx, owner, drafts[10].ID, inputs[10]); err != nil || !fixed.Posts[0].SlotAt.Equal(times[10]) {
			t.Fatalf("corrected row=%+v err=%v", fixed, err)
		}
		ids := make([]string, 0, 50)
		for _, draft := range drafts {
			ids = append(ids, draft.ID)
		}
		posts, err := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftIDIn(ids...)).All(ctx)
		if err != nil || len(posts) != 50 {
			t.Fatalf("posts=%d err=%v", len(posts), err)
		}
		slots := map[int64]bool{}
		for _, post := range posts {
			slots[post.SlotAt.Unix()] = true
		}
		if len(slots) != 50 || charged()-before != 50 {
			t.Fatalf("distinct slots=%d charged=%d", len(slots), charged()-before)
		}
	})

	t.Run("only a reviewer sending the draft back stops its approved, queued snapshot", func(t *testing.T) {
		required := true
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			off := false
			_, _ = repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		}()
		draft := newDraft("Approved snapshot")
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(time.Hour), Version: draft.Version, Targets: targets("Approved snapshot")})
		if err != nil {
			t.Fatal(err)
		}
		id := result.Posts[0].ID
		exec(`UPDATE scheduled_post SET "scheduledFor"=now()-interval '1 second' WHERE id=$1`, id)
		eligibility := func(run string) string {
			t.Helper()
			if claimed, err := repo.auth.Claim(ctx, id, run, time.Now()); err != nil || !claimed {
				t.Fatalf("claim %s: %v %v", run, claimed, err)
			}
			job, err := repo.auth.LoadPublishJob(ctx, id, run)
			if err != nil {
				t.Fatal(err)
			}
			exec(`UPDATE scheduled_post SET status='SCHEDULED',"triggerRunId"=NULL WHERE id=$1`, id)
			return job.Ineligible
		}
		// An edit after scheduling, then a new review request, then approving the newer version.
		title := "Approved snapshot, edited"
		if _, err := repo.UpdateContentDraft(ctx, owner, draft.ID, ContentDraftUpdate{BaseVersion: result.Draft.Version, Title: &title}); err != nil {
			t.Fatal(err)
		}
		for _, action := range []string{"request", "approve"} {
			if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: result.Draft.Version + 1, Action: action}); err != nil {
				t.Fatal(err)
			}
			if reason := eligibility("run-" + action); reason != "" {
				t.Fatalf("after %s the queued snapshot is ineligible: %s", action, reason)
			}
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: result.Draft.Version + 1, Action: "changes"}); err != nil {
			t.Fatal(err)
		}
		for _, action := range []string{"request", "approve"} {
			if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: result.Draft.Version + 1, Action: action}); err != nil {
				t.Fatal(err)
			}
			if claimed, err := repo.auth.Claim(ctx, id, "rejected-"+action, time.Now()); err != nil || claimed {
				t.Fatalf("rejected snapshot claimed after %s: %v %v", action, claimed, err)
			}
			if _, err := repo.PublishQueuedContentDraftPost(ctx, owner, id); !errors.Is(err, publishing.ErrConflict) {
				t.Fatalf("rejected snapshot publish now after %s: %v", action, err)
			}
		}
		post, err := db.Client.ScheduledPost.Get(ctx, id)
		if err != nil || post.Status != scheduledpost.StatusCANCELLED || post.FailureCode == nil || *post.FailureCode != publishing.FailureChangesRequested {
			t.Fatalf("rejected post=%+v err=%v", post, err)
		}
		fresh, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(2 * time.Hour), Version: result.Draft.Version + 1, Targets: targets(title)})
		if err != nil || fresh.Posts[0].ID == id {
			t.Fatalf("fresh explicit reschedule=%+v err=%v", fresh, err)
		}
		// If a worker wins the claim, the review must not report a successful stop.
		if claimed, err := repo.auth.Claim(ctx, fresh.Posts[0].ID, "worker-won", time.Now().Add(3*time.Hour)); err != nil || !claimed {
			t.Fatalf("claim=%v err=%v", claimed, err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: fresh.Draft.Version, Action: "changes"}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("claimed review err=%v", err)
		}
		unchanged, err := repo.GetContentDraft(ctx, owner, draft.ID)
		if err != nil || unchanged.ReviewStatus != "approved" {
			t.Fatalf("failed review mutated state: %+v %v", unchanged, err)
		}
	})

	t.Run("a racing claim and rejection cannot both succeed", func(t *testing.T) {
		for attempt := 0; attempt < 8; attempt++ {
			draft := newDraft("Race review")
			queued, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(time.Hour), Version: draft.Version, Targets: targets("Race review")})
			if err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			var wg sync.WaitGroup
			var claimed bool
			var claimErr, reviewErr error
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				claimed, claimErr = repo.auth.Claim(ctx, queued.Posts[0].ID, "race", time.Now().Add(2*time.Hour))
			}()
			go func() {
				defer wg.Done()
				<-start
				_, reviewErr = repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Action: "changes", Version: queued.Draft.Version})
			}()
			close(start)
			wg.Wait()
			if claimErr != nil {
				t.Fatal(claimErr)
			}
			if claimed {
				if !errors.Is(reviewErr, publishing.ErrConflict) {
					t.Fatalf("claim succeeded but review err=%v", reviewErr)
				}
			} else {
				if reviewErr != nil {
					t.Fatal(reviewErr)
				}
				if _, err := repo.auth.LoadPublishJob(ctx, queued.Posts[0].ID, "race"); !errors.Is(err, publishing.ErrNotFound) {
					t.Fatalf("rejected snapshot load err=%v", err)
				}
			}
		}
	})

	t.Run("repeating a rejection cancels a new optional-review schedule", func(t *testing.T) {
		draft := newDraft("Optional review")
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "changes"}); err != nil {
			t.Fatal(err)
		}
		queued, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(time.Hour), Version: draft.Version, Targets: targets("Optional review")})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: queued.Draft.Version, Action: "changes"}); err != nil {
			t.Fatal(err)
		}
		post, err := db.Client.ScheduledPost.Get(ctx, queued.Posts[0].ID)
		if err != nil || post.Status != scheduledpost.StatusCANCELLED {
			t.Fatalf("repeat rejection: post=%+v err=%v", post, err)
		}
	})

	t.Run("first scheduling serializes with a concurrent rejection", func(t *testing.T) {
		required := true
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		defer func() {
			off := false
			_, _ = repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		}()
		draft := newDraft("First schedule review race")
		if _, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		started, proceed := make(chan struct{}), make(chan struct{})
		var release sync.Once
		defer release.Do(func() { close(proceed) })
		// Pause after the approval read, before revision insertion takes a draft FK lock.
		db.Client.ContentDraftRevision.Use(func(next ent.Mutator) ent.Mutator {
			return ent.MutateFunc(func(ctx context.Context, mutation ent.Mutation) (ent.Value, error) {
				if id, _ := mutation.(*ent.ContentDraftRevisionMutation).ContentDraftID(); id == draft.ID {
					close(started)
					<-proceed
				}
				return next.Mutate(ctx, mutation)
			})
		})
		done := make(chan error, 1)
		go func() {
			_, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{ScheduledFor: time.Now().Add(time.Hour), Version: draft.Version, Targets: targets("First schedule review race")})
			done <- err
		}()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("schedule did not reach revision insert")
		}
		reviewDone := make(chan error, 1)
		go func() {
			_, err := repo.ReviewContentDraft(ctx, owner, draft.ID, ContentDraftReviewInput{Version: draft.Version, Action: "changes"})
			reviewDone <- err
		}()
		var reviewErr error
		reviewFinished := false
		deadline := time.After(5 * time.Second)
		tick := time.NewTicker(5 * time.Millisecond)
		defer tick.Stop()
	waitReview:
		for {
			select {
			case reviewErr = <-reviewDone:
				reviewFinished = true
				break waitReview
			case <-deadline:
				t.Fatal("review did not reach its serialization boundary")
			case <-tick.C:
				var waiting bool
				err := db.SQL.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=((hashtext('content-draft-schedule:' || $1)::bigint & 4294967295)::oid))`, draft.ID).Scan(&waiting)
				if err != nil {
					t.Fatal(err)
				}
				if waiting {
					break waitReview
				}
			}
		}
		release.Do(func() { close(proceed) })
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		if !reviewFinished {
			reviewErr = <-reviewDone
		}
		if !errors.Is(reviewErr, publishing.ErrConflict) {
			t.Fatalf("stale review across first schedule err=%v", reviewErr)
		}
	})

	t.Run("a post keeps the zone its local time was read in", func(t *testing.T) {
		draft := newDraft("Tokyo time")
		local := time.Now().Add(72*time.Hour).In(time.FixedZone("JST", 9*3600)).Format("2006-01-02") + "T10:00"
		result, err := repo.ScheduleContentDraft(ctx, owner, draft.ID, ScheduleContentDraftInput{LocalTime: local, TimeZone: "Asia/Tokyo",
			Version: draft.Version, Targets: targets("Tokyo time")})
		if err != nil {
			t.Fatal(err)
		}
		post := result.Posts[0]
		if post.ScheduleTimeZone == nil || *post.ScheduleTimeZone != "Asia/Tokyo" || post.ScheduledFor.In(time.FixedZone("JST", 9*3600)).Format("15:04") != "10:00" {
			t.Fatalf("post zone=%v at=%v", post.ScheduleTimeZone, post.ScheduledFor)
		}
	})
}
