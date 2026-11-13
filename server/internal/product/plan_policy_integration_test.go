package product

import (
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
)

// A plan the backend does not sell, such as a legacy Team or Agency
// subscription, resolves to no paid access for everything the web shows and
// everything the server enforces; a feature override cannot turn it into one.
func TestUnknownPlansResolveTheSameForUIAndServer(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	for _, plan := range []string{"team", "agency"} {
		w.exec(t, `UPDATE workspace_entitlement SET plan=$2, status='active', "featureOverrides"='{"workspace:use":true,"content:drafts":true}'::jsonb WHERE "organizationId"=$1`, w.org, plan)
		summary, err := w.repo.GetEntitlementSummary(w.ctx, w.owner)
		if err != nil || summary.Plan != "free" {
			t.Fatalf("%s summary=%+v err=%v", plan, summary, err)
		}
		for feature, allowed := range summary.Features {
			if allowed {
				t.Fatalf("%s grants %s", plan, feature)
			}
		}
		for quota, included := range summary.Allowances {
			if included != 0 {
				t.Fatalf("%s includes %d %s", plan, included, quota)
			}
		}
		if decision, err := w.repo.GetFeatureDecision(w.ctx, w.owner, "content:drafts"); err != nil || decision.Allowed {
			t.Fatalf("%s drafts decision=%+v err=%v", plan, decision, err)
		}
		if _, err := w.repo.ConsumeWorkspaceQuota(w.ctx, w.owner, QuotaPosts, 0); !errors.Is(err, ErrQuotaExceeded) {
			t.Fatalf("%s has a post allowance: %v", plan, err)
		}
		var limit *workspaceplan.LimitError
		if err := workspaceplan.RequireCapacity(w.ctx, w.db.Client, w.org, workspaceplan.Channels, 0); !errors.As(err, &limit) || !limit.Inactive {
			t.Fatalf("%s holds channels: %v", plan, err)
		}
	}
	// The plan the backend sells reports what it enforces.
	w.exec(t, `UPDATE workspace_entitlement SET plan='pro', "featureOverrides"=NULL WHERE "organizationId"=$1`, w.org)
	summary, err := w.repo.GetEntitlementSummary(w.ctx, w.owner)
	if err != nil || summary.Allowances[QuotaAICredits] != 600 || summary.Allowances[QuotaPosts] != 250 || summary.Allowances[QuotaEmails] != 5_000 {
		t.Fatalf("pro allowances=%+v err=%v", summary, err)
	}
}

// A downgrade or a lapse keeps what the workspace already holds and refuses
// more: members stay, accounts stay connected, and posts already queued (and
// charged) still publish; a new seat, account or post needs a plan that covers it.
func TestDowngradeKeepsWhatExistsAndRefusesMore(t *testing.T) {
	f := newPostFixture(t)
	f.addMember(t, "writer", "writer_publisher")
	queued, err := f.repo.CreatePost(f.ctx, f.key, f.input("Queued before the downgrade", f.li))
	if err != nil {
		t.Fatal(err)
	}
	version := 1
	for _, change := range []EntitlementSyncInput{
		{EventID: "downgrade-" + f.id, EventType: "test.downgraded", OrganizationID: f.org, Plan: "free", Provider: "test", Status: "active"},
		{EventID: "lapse-" + f.id, EventType: "test.cancelled", OrganizationID: f.org, Plan: "pro", Provider: "test", Status: "cancelled"},
	} {
		change.ExpectedVersion = version
		synced, err := f.repo.SyncWorkspaceEntitlement(f.ctx, change)
		if err != nil {
			t.Fatal(err)
		}
		version = synced.Version
		members := f.db.Client.Member.Query().Where(member.OrganizationID(f.org)).CountX(f.ctx)
		accounts := f.db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(f.org), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).CountX(f.ctx)
		if members != 2 || accounts != 2 {
			t.Fatalf("%s removed what the workspace holds: members=%d accounts=%d", change.EventType, members, accounts)
		}
		var limit *PlanLimitError
		if err := f.repo.RequireSeat(f.ctx, f.org, true); !errors.As(err, &limit) {
			t.Fatalf("%s admitted another seat: %v", change.EventType, err)
		}
		if err := f.repo.RequireChannel(f.ctx, f.org, "another-account"); !errors.As(err, &limit) {
			t.Fatalf("%s admitted another account: %v", change.EventType, err)
		}
		if _, err := f.repo.CreatePost(f.ctx, f.key, f.input("Queued after "+change.EventType, f.x)); err == nil {
			t.Fatalf("%s queued a new post", change.EventType)
		}
	}
	post := queued.Scheduled[0].ID
	store := publishing.NewRepository(f.db.Client)
	if claimed, err := store.Claim(f.ctx, post, "run-"+post, f.future.Add(time.Minute)); err != nil || !claimed {
		t.Fatalf("claimed=%v err=%v", claimed, err)
	}
	if job, err := store.LoadPublishJob(f.ctx, post, "run-"+post); err != nil || job.Ineligible != "" {
		t.Fatalf("a post queued before the lapse=%+v err=%v", job, err)
	}
}
