package product

import (
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// There is no free plan: a workspace without a subscription cannot connect a
// channel, write or schedule until it subscribes, and cancelling closes it again.
func TestUnsubscribedWorkspaceCannotScheduleUntilItSubscribes(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo := w.ctx, w.repo.WithMonthlyMeter(&recordingMonthlyMeter{})
	add := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
	add("unpaid-x-"+w.id, "x")
	actor := publishing.Actor{Organization: w.org, UserID: w.owner.UserID, Type: "USER"}
	connect := publishing.CreateConnectionInput{ExternalAccountID: "unpaid-x-" + w.id, Platform: "x", SecretReference: "SOCIAL_API_KEY", ProviderSettings: map[string]any{}}
	var limit *PlanLimitError
	if _, err := repo.auth.CreateConnection(ctx, actor, connect); !errors.As(err, &limit) || limit.Name != LimitChannels {
		t.Fatalf("unsubscribed channel: %v", err)
	}
	var gate *FeatureNotEntitledError
	if _, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Unpaid draft"}); !errors.As(err, &gate) || gate.RequiredPlan != "pro" {
		t.Fatalf("unsubscribed draft: %v", err)
	}
	if _, err := repo.ListSocialSets(ctx, w.owner); !errors.As(err, &gate) {
		t.Fatalf("unsubscribed social sets: %v", err)
	}
	if _, err := repo.ConsumeWorkspaceQuota(ctx, w.owner, QuotaPosts, 0); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("unsubscribed posts: %v", err)
	}

	subscribe(t, ctx, repo, w.org, "pro")
	conn, err := repo.auth.CreateConnection(ctx, actor, connect)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "Paid draft"})
	if err != nil {
		t.Fatal(err)
	}
	input := ScheduleContentDraftInput{Version: draft.Version, ScheduledFor: time.Now().Add(24 * time.Hour), Queue: true,
		Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: conn.ID, Caption: "A scheduled post"}}}
	if result, err := repo.ScheduleContentDraft(ctx, w.owner, draft.ID, input); err != nil || !result.Created {
		t.Fatalf("subscribed schedule: %+v %v", result, err)
	}

	// Cancelling returns the workspace to no plan: its drafts stay, writing closes.
	if _, err := repo.SyncWorkspaceEntitlement(ctx, EntitlementSyncInput{EventID: "cancel-" + w.id, EventType: "test.cancel", ExpectedVersion: 1, OrganizationID: w.org, Plan: "free", Provider: "test", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreateContentDraft(ctx, w.owner, ContentDraftInput{Title: "After cancel"}); !errors.As(err, &gate) {
		t.Fatalf("cancelled draft: %v", err)
	}
	if kept, err := w.db.Client.ContentDraft.Get(ctx, draft.ID); err != nil || kept == nil {
		t.Fatalf("cancelling deleted a draft: %v", err)
	}
}
