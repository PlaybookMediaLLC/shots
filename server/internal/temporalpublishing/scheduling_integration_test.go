package temporalpublishing_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/lucsky/cuid"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// fixtureProvider is an isolated social provider: it records every
// publication and answers by caption prefix. Nothing leaves the process.
type fixtureProvider struct {
	mu      sync.Mutex
	calls   map[string][]time.Time
	refuse  map[string]int
	release chan struct{}
	started chan struct{}
}

func (p *fixtureProvider) PublishesSynchronously() bool { return true }

func (p *fixtureProvider) Publish(_ context.Context, input socialapi.PublishInput) (string, error) {
	p.mu.Lock()
	p.calls[input.Caption] = append(p.calls[input.Caption], time.Now())
	calls := len(p.calls[input.Caption])
	refusals := p.refuse[input.DestinationID]
	if refusals > 0 {
		p.refuse[input.DestinationID]--
	}
	p.mu.Unlock()
	switch {
	case refusals > 0, strings.HasPrefix(input.Caption, "refuse"):
		return "", socialapi.NewError(400, false, "rejected")
	case strings.HasPrefix(input.Caption, "lost"):
		return "", socialapi.NewError(502, true, "response lost")
	case strings.HasPrefix(input.Caption, "busy") && calls == 1:
		return "", socialapi.NewError(429, false, "slow down")
	case strings.HasPrefix(input.Caption, "slow"):
		p.started <- struct{}{}
		<-p.release
	}
	return "remote-" + input.PostID, nil
}

func (p *fixtureProvider) Status(context.Context, socialapi.StatusInput) (socialapi.StatusResult, error) {
	return socialapi.StatusResult{}, errors.New("direct receipts are never polled")
}

func (p *fixtureProvider) count(caption string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.calls[caption])
}

// receiptLossStore fails to record a receipt for chosen posts, as a database
// outage after the provider accepted would.
type receiptLossStore struct {
	*publishing.Repository
	lose sync.Map
}

func (s *receiptLossStore) Complete(ctx context.Context, post *ent.ScheduledPost, attempt publishing.Attempt, providerID, runID string) error {
	if _, lost := s.lose.Load(post.ID); lost {
		return errors.New("database unavailable")
	}
	return s.Repository.Complete(ctx, post, attempt, providerID, runID)
}

type unlimitedMeter struct{}

func (unlimitedMeter) Meter(_ context.Context, _ string, amount, limit int64) (quota.MonthlyUsage, error) {
	return quota.MonthlyUsage{Used: amount, Remaining: limit - amount}, nil
}

// Scheduling through the real publication path: product scheduling in
// PostgreSQL, temporalpublishing.PostWorkflowV2 on a real Temporal server, and the isolated
// provider above. It covers the documented failure model end to end.
func TestSchedulingThroughTemporal(t *testing.T) {
	url, address := os.Getenv("PUBLISHING_TEST_DATABASE_URL"), os.Getenv("PUBLISHING_TEST_TEMPORAL_ADDRESS")
	if url == "" || address == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL and PUBLISHING_TEST_TEMPORAL_ADDRESS are not set")
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
	repo := product.NewConfiguration(db.Client).WithMonthlyMeter(unlimitedMeter{})
	accounts := publishing.NewRepository(db.Client)
	// workspace creates a Pro workspace whose owner may schedule, with one
	// account per "name:platform".
	workspace := func(names ...string) (product.Actor, map[string]string) {
		t.Helper()
		id := cuid.New()
		org, user, remote := "org_"+id, "user_"+id, "social-org_"+id
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, user, id+"@example.test")
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, org)
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "session_"+id, user, org)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+id, org, user)
		exec(`INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Fixture',now())`, remote)
		exec(`INSERT INTO social_tenant_binding ("organizationId","goOrganizationId","secretReference") VALUES ($1,$2,$3)`, org, remote, "SOCIAL_FIXTURE_"+id)
		t.Cleanup(func() {
			for _, query := range []string{
				`DELETE FROM publication_attempt WHERE "organizationId"=$1`, `DELETE FROM scheduled_post WHERE "organizationId"=$1`,
				`DELETE FROM content_draft WHERE "organizationId"=$1`, `DELETE FROM social_tenant_binding WHERE "organizationId"=$1`,
				`DELETE FROM organization WHERE id=$1`,
			} {
				_, _ = db.SQL.ExecContext(ctx, query, org)
			}
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Integration" WHERE "organizationId"=$1`, remote)
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Organization" WHERE id=$1`, remote)
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, user)
		})
		actor := product.Actor{OrganizationID: org, UserID: user, SessionID: "session_" + id, RequestID: "request_" + id}
		if _, err := repo.SyncWorkspaceEntitlement(ctx, product.EntitlementSyncInput{EventID: "test-" + id, EventType: "test.subscribed",
			OrganizationID: org, Plan: "pro", Provider: "test", Status: "active"}); err != nil {
			t.Fatal(err)
		}
		connections := map[string]string{}
		for _, named := range names {
			account, platform, _ := strings.Cut(named, ":")
			external := account + "-" + id
			exec(`INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,'Fixture',$3,'social','fixture-only-credential')`, external, remote, platform)
			connection, err := accounts.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: user, RequestID: actor.RequestID, Type: "USER"},
				publishing.CreateConnectionInput{ExternalAccountID: external, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
			if err != nil {
				t.Fatal(err)
			}
			connections[account] = connection.ID
		}
		return actor, connections
	}
	owner, connections := workspace("main:linkedin", "second:threads")

	provider := &fixtureProvider{calls: map[string][]time.Time{}, refuse: map[string]int{}, release: make(chan struct{}), started: make(chan struct{}, 1)}
	store := &receiptLossStore{Repository: accounts}
	temporal, err := client.Dial(client.Options{HostPort: address})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(temporal.Close)
	if err := temporalpublishing.RegisterSearchAttributes(ctx, temporal, "default"); err != nil {
		t.Fatal(err)
	}
	queue := "scheduling-test-" + cuid.New()
	scheduler := temporalpublishing.NewScheduler(temporal, temporalpublishing.SchedulerConfig{ActivityTaskQueue: queue, ActivityTimeout: 30 * time.Second, MaxAttempts: 3,
		Namespace: "default", RetryDelay: 2 * time.Second, WorkflowTaskQueue: queue})
	activities := temporalpublishing.NewActivities(store, provider)
	w := worker.New(temporal, queue, worker.Options{})
	w.RegisterWorkflowWithOptions(temporalpublishing.PostWorkflowV2, workflow.RegisterOptions{Name: temporalpublishing.WorkflowNameV2})
	for name, fn := range map[string]any{temporalpublishing.PrepareActivityName: activities.Prepare, temporalpublishing.BeginActivityName: activities.Begin,
		temporalpublishing.CompleteActivityName: activities.CompleteV2, temporalpublishing.FailActivityName: activities.FailV2, temporalpublishing.MarkUnknownActivityName: activities.MarkUnknown,
		temporalpublishing.SubmitActivityName: activities.Submit, temporalpublishing.PlanAutomationsActivityName: activities.PlanAutomations} {
		w.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: name})
	}
	if err := w.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)

	// Every post below is due at the same instant, 40 seconds out.
	due := time.Now().Add(40 * time.Second).UTC().Truncate(time.Second)
	schedule := func(actor product.Actor, caption string, accountIDs ...string) *product.ScheduleContentDraftResult {
		t.Helper()
		draft, err := repo.CreateContentDraft(ctx, actor, product.ContentDraftInput{PlainText: caption, Title: caption})
		if err != nil {
			t.Fatal(err)
		}
		targets := []product.ContentDraftScheduleTarget{}
		for _, id := range accountIDs {
			targets = append(targets, product.ContentDraftScheduleTarget{Caption: caption, ChannelConnectionID: id})
		}
		result, err := repo.ScheduleContentDraft(ctx, actor, draft.ID, product.ScheduleContentDraftInput{ScheduledFor: due, Version: draft.Version, Targets: targets})
		if err != nil {
			t.Fatalf("schedule %s: %v", caption, err)
		}
		return result
	}
	start := func(post *ent.ScheduledPost) {
		t.Helper()
		if err := scheduler.Start(ctx, temporalpublishing.ScheduleInput{OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor}); err != nil {
			t.Fatal(err)
		}
	}
	post := func(id string) *ent.ScheduledPost {
		t.Helper()
		row, err := db.Client.ScheduledPost.Get(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return row
	}
	settle := func(id string, statuses ...scheduledpost.Status) *ent.ScheduledPost {
		t.Helper()
		deadline := time.Now().Add(90 * time.Second)
		for {
			row := post(id)
			for _, status := range statuses {
				if row.Status == status {
					return row
				}
			}
			if time.Now().After(deadline) {
				t.Fatalf("post %s is %s; want %v", id, row.Status, statuses)
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	code := func(row *ent.ScheduledPost) string {
		if row.FailureCode == nil {
			return ""
		}
		return *row.FailureCode
	}

	ok := schedule(owner, "ok post", connections["main"])
	refused := schedule(owner, "refuse post", connections["main"])
	lost := schedule(owner, "lost post", connections["main"])
	busy := schedule(owner, "busy post", connections["main"])
	provider.refuse["second-"+strings.TrimPrefix(owner.OrganizationID, "org_")] = 1
	split := schedule(owner, "split post", connections["main"], connections["second"])
	cancelled := schedule(owner, "cancelled post", connections["main"])
	slow := schedule(owner, "slow post", connections["main"])
	receipt := schedule(owner, "receipt post", connections["main"])
	store.lose.Store(receipt.Posts[0].ID, true)
	late := schedule(owner, "late post", connections["main"])
	restart := schedule(owner, "restart post", connections["main"])
	lostAgain := schedule(owner, "lost after requeue post", connections["main"])
	planned, err := repo.CreateContentDraft(ctx, owner, product.ContentDraftInput{PlainText: "planned post", Title: "planned post"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Client.ContentDraft.UpdateOneID(planned.ID).SetChannelConnectionIds([]string{connections["main"]}).Exec(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.PlanContentDraft(ctx, owner, planned.ID, product.ContentDraftPlanInput{PlannedFor: &due, TimeZone: "UTC"}); err != nil {
		t.Fatal(err)
	}
	// The media post keeps an image that is gone by the time it is due.
	asset := cuid.New()
	exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,width,height,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',68,1,1,'UPLOADED',now(),now())`, asset, owner.OrganizationID, "org/"+owner.OrganizationID+"/"+asset+".png")
	mediaDraft, err := repo.CreateContentDraft(ctx, owner, product.ContentDraftInput{PlainText: "media post", Title: "media post"})
	if err != nil {
		t.Fatal(err)
	}
	media, err := repo.ScheduleContentDraft(ctx, owner, mediaDraft.ID, product.ScheduleContentDraftInput{ScheduledFor: due, Version: mediaDraft.Version,
		Targets: []product.ContentDraftScheduleTarget{{Caption: "media post", ChannelConnectionID: connections["main"], AssetIDs: []string{asset}}}})
	if err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE asset SET status='PENDING' WHERE id=$1`, asset)
	// A separate workspace that approves drafts withdraws approval after scheduling.
	reviewer, reviewed := workspace("main:linkedin")
	required := true
	if _, err := repo.UpdateContentDraftSettings(ctx, reviewer, product.ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
		t.Fatal(err)
	}
	approvalDraft, err := repo.CreateContentDraft(ctx, reviewer, product.ContentDraftInput{PlainText: "approval post", Title: "approval post"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ReviewContentDraft(ctx, reviewer, approvalDraft.ID, product.ContentDraftReviewInput{Version: approvalDraft.Version, Action: "approve"}); err != nil {
		t.Fatal(err)
	}
	approval, err := repo.ScheduleContentDraft(ctx, reviewer, approvalDraft.ID, product.ScheduleContentDraftInput{ScheduledFor: due, Version: approvalDraft.Version,
		Targets: []product.ContentDraftScheduleTarget{{Caption: "approval post", ChannelConnectionID: reviewed["main"]}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ReviewContentDraft(ctx, reviewer, approvalDraft.ID, product.ContentDraftReviewInput{Version: approval.Draft.Version, Action: "changes"}); err != nil {
		t.Fatal(err)
	}
	// A separate workspace whose account the provider revokes after scheduling.
	revokedOwner, revokedAccounts := workspace("main:linkedin")
	revoked := schedule(revokedOwner, "revoked post", revokedAccounts["main"])
	exec(`UPDATE channel_connection SET status='REVOKED' WHERE id=$1`, revokedAccounts["main"])

	// The API wakes each post's workflow; the late and restart posts' wakeups are "lost".
	for _, result := range []*product.ScheduleContentDraftResult{ok, refused, lost, busy, split, cancelled, slow, receipt, media, approval, revoked} {
		for _, row := range result.Scheduled {
			start(row)
		}
	}
	unschedule, err := repo.MutateCalendar(ctx, owner, product.CalendarCommand{Key: cuid.New(), Action: "unschedule",
		Items: []product.CalendarPlacement{{DraftID: cancelled.Draft.ID, Version: cancelled.Draft.Version, CalendarVersion: cancelled.Draft.CalendarVersion, PostID: cancelled.Posts[0].ID}}})
	if err != nil || len(unschedule.Cancelled) != 1 {
		t.Fatalf("unschedule=%+v err=%v", unschedule, err)
	}
	if err := scheduler.Cancel(ctx, cancelled.Posts[0].ID); err != nil {
		t.Fatal(err)
	}

	t.Run("nothing publishes before it is due", func(t *testing.T) {
		time.Sleep(5 * time.Second)
		for _, caption := range []string{"ok post", "refuse post", "lost post", "busy post", "split post", "slow post"} {
			if n := provider.count(caption); n != 0 {
				t.Fatalf("%s reached the provider %d times early", caption, n)
			}
		}
		if row := post(ok.Posts[0].ID); row.Status != scheduledpost.StatusSCHEDULED {
			t.Fatalf("ok post is %s before it is due", row.Status)
		}
	})

	t.Run("a cancellation racing a provider call reports the real state", func(t *testing.T) {
		select {
		case <-provider.started:
		case <-time.After(90 * time.Second):
			t.Fatal("the slow post never reached the provider")
		}
		_, err := repo.MutateCalendar(ctx, owner, product.CalendarCommand{Key: cuid.New(), Action: "unschedule",
			Items: []product.CalendarPlacement{{DraftID: slow.Draft.ID, Version: slow.Draft.Version, CalendarVersion: slow.Draft.CalendarVersion, PostID: slow.Posts[0].ID}}})
		if !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("unschedule during the provider call err=%v; want a conflict", err)
		}
		close(provider.release)
		row := settle(slow.Posts[0].ID, scheduledpost.StatusPUBLISHED)
		if row.RemotePostID == nil || provider.count("slow post") != 1 {
			t.Fatalf("slow post=%+v calls=%d", row, provider.count("slow post"))
		}
	})

	t.Run("a due post publishes once with its content and a provider receipt", func(t *testing.T) {
		row := settle(ok.Posts[0].ID, scheduledpost.StatusPUBLISHED)
		if row.RemotePostID == nil || *row.RemotePostID != "remote-"+row.ID || row.PublishedAt == nil || row.PublishedAt.Before(due) {
			t.Fatalf("published row=%+v", row)
		}
		provider.mu.Lock()
		first := provider.calls["ok post"][0]
		provider.mu.Unlock()
		if first.Before(due) {
			t.Fatalf("published at %v, before %v", first, due)
		}
		attempt, err := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(row.ID)).Only(ctx)
		if err != nil || attempt.Outcome == nil || *attempt.Outcome != publicationattempt.OutcomeSUCCEEDED || *attempt.ProviderPostID != *row.RemotePostID {
			t.Fatalf("attempt=%+v err=%v", attempt, err)
		}
		// A dispatcher replay starts nothing new.
		start(row)
		time.Sleep(2 * time.Second)
		if n := provider.count("ok post"); n != 1 {
			t.Fatalf("ok post reached the provider %d times", n)
		}
	})

	t.Run("a refusal fails once; a lost response is never retried blindly", func(t *testing.T) {
		if row := settle(refused.Posts[0].ID, scheduledpost.StatusFAILED); code(row) != "400" || provider.count("refuse post") != 1 {
			t.Fatalf("refused=%+v calls=%d", row, provider.count("refuse post"))
		}
		row := settle(lost.Posts[0].ID, scheduledpost.StatusUNKNOWN_DELIVERY)
		if code(row) != publishing.FailureUnknownDelivery || provider.count("lost post") != 1 {
			t.Fatalf("lost=%+v calls=%d", row, provider.count("lost post"))
		}
		if _, err := repo.RetryContentDraftPost(ctx, owner, row.ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("retrying an unknown delivery err=%v", err)
		}
		reconciled, err := repo.ReconcileContentDraftPost(ctx, owner, row.ID, product.ReconcileInput{Live: true, URL: "https://www.linkedin.com/feed/update/urn:li:share:123/"})
		if err != nil || reconciled.Status != "PUBLISHED" || provider.count("lost post") != 1 {
			t.Fatalf("reconciled=%+v err=%v", reconciled, err)
		}
	})

	t.Run("a rate limit retries into one publication", func(t *testing.T) {
		row := settle(busy.Posts[0].ID, scheduledpost.StatusPUBLISHED)
		if provider.count("busy post") != 2 || row.RemotePostID == nil {
			t.Fatalf("busy=%+v calls=%d", row, provider.count("busy post"))
		}
	})

	t.Run("one destination fails alone and its retry does not republish the other", func(t *testing.T) {
		var mainPost, secondPost *ent.ScheduledPost
		for _, scheduled := range split.Posts {
			row := settle(scheduled.ID, scheduledpost.StatusPUBLISHED, scheduledpost.StatusFAILED)
			if scheduled.ChannelConnectionID == connections["main"] {
				mainPost = row
			} else {
				secondPost = row
			}
		}
		if mainPost.Status != scheduledpost.StatusPUBLISHED || secondPost.Status != scheduledpost.StatusFAILED || provider.count("split post") != 2 {
			t.Fatalf("main=%s second=%s calls=%d", mainPost.Status, secondPost.Status, provider.count("split post"))
		}
		retried, err := repo.RetryContentDraftPost(ctx, owner, secondPost.ID)
		if err != nil {
			t.Fatal(err)
		}
		start(retried.Scheduled)
		settle(retried.Scheduled.ID, scheduledpost.StatusPUBLISHED)
		if _, err := repo.RetryContentDraftPost(ctx, owner, mainPost.ID); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("retrying a published destination err=%v", err)
		}
		if provider.count("split post") != 3 || post(mainPost.ID).Status != scheduledpost.StatusPUBLISHED {
			t.Fatalf("split calls=%d", provider.count("split post"))
		}
	})

	t.Run("cancelled and planned content never reaches the provider", func(t *testing.T) {
		time.Sleep(time.Until(due.Add(3 * time.Second)))
		if row := post(cancelled.Posts[0].ID); row.Status != scheduledpost.StatusCANCELLED || provider.count("cancelled post") != 0 {
			t.Fatalf("cancelled=%s calls=%d", row.Status, provider.count("cancelled post"))
		}
		recoverable, err := accounts.ListRecoverablePosts(ctx, time.Time{}, time.Now(), 1000)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range recoverable {
			if row.ID == cancelled.Posts[0].ID {
				t.Fatal("the dispatcher would start a cancelled post")
			}
		}
		if n, _ := db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(planned.ID)).Count(ctx); n != 0 || provider.count("planned post") != 0 {
			t.Fatalf("planned draft has %d posts and %d provider calls", n, provider.count("planned post"))
		}
	})

	t.Run("missing media and withdrawn approval stop a post before sending", func(t *testing.T) {
		if row := settle(media.Posts[0].ID, scheduledpost.StatusFAILED); code(row) != publishing.FailureMediaUnavailable || provider.count("media post") != 0 {
			t.Fatalf("media=%+v calls=%d", row, provider.count("media post"))
		}
		if row := settle(approval.Posts[0].ID, scheduledpost.StatusCANCELLED); code(row) != publishing.FailureChangesRequested || provider.count("approval post") != 0 {
			t.Fatalf("approval=%+v calls=%d", row, provider.count("approval post"))
		}
	})

	t.Run("an account revoked after scheduling stops its post before sending", func(t *testing.T) {
		if row := settle(revoked.Posts[0].ID, scheduledpost.StatusCANCELLED); code(row) != publishing.FailureAccountUnavailable || provider.count("revoked post") != 0 {
			t.Fatalf("revoked=%+v calls=%d", row, provider.count("revoked post"))
		}
	})

	t.Run("a post past its late window fails without sending", func(t *testing.T) {
		exec(`UPDATE scheduled_post SET "scheduledFor"=now()-interval '2 hours' WHERE id=$1`, late.Posts[0].ID)
		start(post(late.Posts[0].ID))
		if row := settle(late.Posts[0].ID, scheduledpost.StatusFAILED); code(row) != publishing.FailureMissedWindow || provider.count("late post") != 0 {
			t.Fatalf("late=%+v calls=%d", row, provider.count("late post"))
		}
		if _, err := repo.RetryContentDraftPost(ctx, owner, late.Posts[0].ID); err != nil {
			t.Fatalf("a missed post can be published knowingly: %v", err)
		}
	})

	// stall leaves a post as a run that rate-limited once, then vanished before its next send.
	stall := func(id, run string) {
		t.Helper()
		exec(`INSERT INTO publication_attempt (id,"organizationId","scheduledPostId","attemptNumber","startedAt","completedAt",outcome,"failureCode")
			VALUES ($1,$2,$3,1,now()-interval '30 minutes',now()-interval '29 minutes','FAILED','429')`, cuid.New(), owner.OrganizationID, id)
		exec(`UPDATE scheduled_post SET status='PROCESSING',"triggerRunId"=$2,"updatedAt"=now()-interval '20 minutes' WHERE id=$1`, id, run)
	}
	attempts := func(id string) []*ent.PublicationAttempt {
		t.Helper()
		rows, err := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(id)).
			Order(ent.Asc(publicationattempt.FieldAttemptNumber)).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}

	t.Run("a post claimed by a worker that vanished before sending is queued again and publishes once", func(t *testing.T) {
		id := restart.Posts[0].ID
		stall(id, "vanished-run")
		stalled, err := accounts.ListStalledPosts(ctx, time.Now().Add(-15*time.Minute), 1000)
		if err != nil || !containsStalled(stalled, id) {
			t.Fatalf("stalled=%v err=%v", stalled, err)
		}
		if running, err := scheduler.Running(ctx, id, "vanished-run"); err != nil || running {
			t.Fatalf("running=%v err=%v", running, err)
		}
		outcome, err := accounts.ReleaseStalled(ctx, id, "vanished-run")
		if err != nil || outcome != "requeued" {
			t.Fatalf("outcome=%q err=%v", outcome, err)
		}
		start(post(id))
		if row := settle(id, scheduledpost.StatusPUBLISHED); provider.count("restart post") != 1 || row.RemotePostID == nil {
			t.Fatalf("restart=%+v calls=%d", row, provider.count("restart post"))
		}
		// The new run numbers after the earlier attempt instead of overwriting it.
		rows := attempts(id)
		if len(rows) != 2 || *rows[0].FailureCode != "429" || *rows[1].Outcome != publicationattempt.OutcomeSUCCEEDED || rows[1].AttemptNumber != 2 {
			t.Fatalf("attempts=%+v", rows)
		}
	})

	t.Run("a requeued post whose next send is lost waits for a person, and is never sent again", func(t *testing.T) {
		id := lostAgain.Posts[0].ID
		stall(id, "vanished-run-2")
		if outcome, err := accounts.ReleaseStalled(ctx, id, "vanished-run-2"); err != nil || outcome != "requeued" {
			t.Fatalf("outcome=%q err=%v", outcome, err)
		}
		start(post(id))
		row := settle(id, scheduledpost.StatusUNKNOWN_DELIVERY)
		rows := attempts(id)
		if provider.count("lost after requeue post") != 1 || code(row) != publishing.FailureUnknownDelivery || len(rows) != 2 ||
			*rows[0].FailureCode != "429" || rows[1].CompletedAt == nil || *rows[1].FailureCode != publishing.FailureUnknownDelivery {
			t.Fatalf("row=%+v attempts=%+v calls=%d", row, rows, provider.count("lost after requeue post"))
		}
		if outcome, err := accounts.ReleaseStalled(ctx, id, *row.TriggerRunID); err != nil || outcome != "" {
			t.Fatalf("an unknown delivery was released again: %q %v", outcome, err)
		}
	})

	t.Run("a receipt that cannot be recorded is reconciled, never resent", func(t *testing.T) {
		id := receipt.Posts[0].ID
		deadline := time.Now().Add(90 * time.Second)
		for provider.count("receipt post") == 0 && time.Now().Before(deadline) {
			time.Sleep(250 * time.Millisecond)
		}
		row := post(id)
		if row.Status != scheduledpost.StatusPROCESSING || row.TriggerRunID == nil {
			t.Fatalf("receipt post=%+v", row)
		}
		// The workflow keeps retrying the write; here it is lost instead.
		if err := temporal.TerminateWorkflow(ctx, temporalpublishing.WorkflowID(id), "", "simulated loss"); err != nil {
			t.Fatal(err)
		}
		if running, err := scheduler.Running(ctx, id, *row.TriggerRunID); err != nil || running {
			t.Fatalf("running=%v err=%v", running, err)
		}
		outcome, err := accounts.ReleaseStalled(ctx, id, *row.TriggerRunID)
		if err != nil || outcome != "unknown_delivery" {
			t.Fatalf("outcome=%q err=%v", outcome, err)
		}
		row = post(id)
		if row.Status != scheduledpost.StatusUNKNOWN_DELIVERY || code(row) != publishing.FailureUnknownDelivery || provider.count("receipt post") != 1 {
			t.Fatalf("receipt post=%+v calls=%d", row, provider.count("receipt post"))
		}
		start(row)
		time.Sleep(2 * time.Second)
		if provider.count("receipt post") != 1 {
			t.Fatal("an unknown delivery was sent again")
		}
	})
}

func containsStalled(posts []publishing.StalledPost, id string) bool {
	for _, post := range posts {
		if post.ID == id {
			return true
		}
	}
	return false
}
