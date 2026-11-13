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

// A plan value the backend does not sell (billing sync refuses one, so only a
// hand-edited or migrated row can carry it) grants nothing anywhere, whatever
// its feature overrides; a sold plan that no longer stands includes nothing
// either. The web's summary and the server's checks give the same answer.
func TestUnknownPlansResolveTheSameForUIAndServer(t *testing.T) {
	w := newTestWorkspace(t)
	w.repo.WithMonthlyMeter(&recordingMonthlyMeter{})
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	// The plan the backend sells reports what it enforces.
	summary, err := w.repo.GetEntitlementSummary(w.ctx, w.owner)
	if err != nil {
		t.Fatal(err)
	}
	for name := range monthlyQuotas {
		if summary.Allowances[name] != planQuotas["pro"][name] {
			t.Fatalf("pro %s=%d", name, summary.Allowances[name])
		}
	}
	if left, err := w.repo.ConsumeWorkspaceQuota(w.ctx, w.owner, QuotaPosts, 0); err != nil || left != summary.Allowances[QuotaPosts] {
		t.Fatalf("pro posts left=%d err=%v", left, err)
	}
	past := time.Now().Add(-time.Hour)
	for name, change := range map[string]string{
		"unknown plan":  `UPDATE workspace_entitlement SET plan='agency', status='active', "featureOverrides"='{"workspace:use":true,"content:drafts":true}'::jsonb WHERE "organizationId"=$1`,
		"expired grace": `UPDATE workspace_entitlement SET plan='pro', status='past_due', "graceUntil"=$2, "featureOverrides"=NULL WHERE "organizationId"=$1`,
	} {
		args := []any{w.org}
		if name == "expired grace" {
			args = append(args, past)
		}
		w.exec(t, change, args...)
		summary, err := w.repo.GetEntitlementSummary(w.ctx, w.owner)
		if err != nil {
			t.Fatal(err)
		}
		for feature, allowed := range summary.Features {
			if allowed {
				t.Fatalf("%s grants %s", name, feature)
			}
		}
		for quota, included := range summary.Allowances {
			if included != 0 {
				t.Fatalf("%s includes %d %s", name, included, quota)
			}
		}
		if decision, err := w.repo.GetFeatureDecision(w.ctx, w.owner, "content:drafts"); err != nil || decision.Allowed {
			t.Fatalf("%s drafts decision=%+v err=%v", name, decision, err)
		}
		if _, err := w.repo.ConsumeWorkspaceQuota(w.ctx, w.owner, QuotaPosts, 0); !errors.Is(err, ErrQuotaExceeded) {
			t.Fatalf("%s has a post allowance: %v", name, err)
		}
		var limit *workspaceplan.LimitError
		if err := workspaceplan.RequireCapacity(w.ctx, w.db.Client, w.org, workspaceplan.Channels, 0); !errors.As(err, &limit) || !limit.Inactive {
			t.Fatalf("%s holds channels: %v", name, err)
		}
	}
}

// A cancellation, or a past-due subscription whose grace ran out, keeps what
// the workspace already holds and refuses more: members stay, accounts stay
// connected, and posts already queued (and charged) still publish; a new
// member, account or post needs a plan that stands.
func TestDowngradeKeepsWhatExistsAndRefusesMore(t *testing.T) {
	f := newPostFixture(t)
	f.repo.WithInvitationMailer(&recordingInvitationMailer{})
	f.addMember(t, "writer", "writer_publisher")
	queued, err := f.repo.CreatePost(f.ctx, f.key, f.input("Queued before the downgrade", f.li))
	if err != nil {
		t.Fatal(err)
	}
	charged := func() (total int64) {
		for _, used := range f.meter.used {
			total += used
		}
		return total
	}
	before := charged()
	expired := time.Now().Add(-time.Hour)
	version := 1
	for _, change := range []EntitlementSyncInput{
		// What Stripe reports for a cancelled, unpaid or paused subscription.
		{EventID: "cancel-" + f.id, EventType: "test.cancelled", OrganizationID: f.org, Plan: "free", Provider: "test", Status: "active"},
		// A failed payment whose grace period has run out; no event marks the end.
		{EventID: "lapse-" + f.id, EventType: "test.past_due", OrganizationID: f.org, Plan: "pro", Provider: "test", Status: "past_due", GraceUntil: &expired},
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
		var seat *PlanLimitError
		if _, err := f.repo.InviteMember(f.ctx, f.owner, change.EventID+"@example.test", "viewer"); !errors.As(err, &seat) {
			t.Fatalf("%s invited another member: %v", change.EventType, err)
		}
		var channel *workspaceplan.LimitError
		if _, err := f.repo.auth.CreateConnection(f.ctx, publishing.Actor{Organization: f.org, UserID: f.owner.UserID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: "another-" + change.EventID, Platform: "linkedin", SecretReference: "SOCIAL_API_KEY",
				ProviderSettings: map[string]any{}}); !errors.As(err, &channel) {
			t.Fatalf("%s connected another account: %v", change.EventType, err)
		}
		var feature *FeatureNotEntitledError
		if _, err := f.repo.CreatePost(f.ctx, f.key, f.input("Queued after "+change.EventType, f.x)); !errors.As(err, &feature) {
			t.Fatalf("%s queued a new post: %v", change.EventType, err)
		}
	}
	if after := charged(); after != before {
		t.Fatalf("the queued post was charged again or refunded: %d then %d", before, after)
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
