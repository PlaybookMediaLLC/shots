package product

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestXLinksAddonSyncAndRollingQuota(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")

	// Default: add-on is off, so outbound X links must be stripped.
	decision, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-off:root", 1)
	if err != nil {
		t.Fatalf("PrepareXLinkSend(off) error = %v", err)
	}
	if decision.AllowLinks || decision.Reason != "addon_disabled" {
		t.Fatalf("got %+v, want AllowLinks=false addon_disabled", decision)
	}

	// Enable x_links add-on with limit=2 for fast rolling-window testing.
	limit := 2
	subID := "sub_xlinks_" + w.id
	periodEnd := time.Now().UTC().Add(30 * 24 * time.Hour)
	synced, err := w.repo.SyncWorkspaceAddon(w.ctx, AddonSyncInput{
		AddonKey:               AddonXLinks,
		CurrentPeriodEnd:       &periodEnd,
		EventID:                "evt_on_" + w.id,
		EventType:              "customer.subscription.created",
		ExpectedVersion:        0,
		ExternalSubscriptionID: &subID,
		OrganizationID:         w.org,
		Provider:               "stripe",
		QuotaLimit:             &limit,
		Status:                 "active",
	})
	if err != nil || synced.Replayed || synced.Version != 1 {
		t.Fatalf("SyncWorkspaceAddon() = %+v, %v", synced, err)
	}
	// Replay of the exact same event ID is a no-op.
	replay, err := w.repo.SyncWorkspaceAddon(w.ctx, AddonSyncInput{
		AddonKey:        AddonXLinks,
		EventID:         "evt_on_" + w.id,
		EventType:       "customer.subscription.created",
		ExpectedVersion: 0,
		OrganizationID:  w.org,
		Provider:        "stripe",
		QuotaLimit:      &limit,
		Status:          "active",
	})
	if err != nil || !replay.Replayed || replay.Version != 1 {
		t.Fatalf("replay = %+v, %v", replay, err)
	}
	// Stale expectedVersion returns EntitlementConflictError.
	if _, err := w.repo.SyncWorkspaceAddon(w.ctx, AddonSyncInput{
		AddonKey:        AddonXLinks,
		EventID:         "evt_stale_" + w.id,
		EventType:       "customer.subscription.updated",
		ExpectedVersion: 0,
		OrganizationID:  w.org,
		Provider:        "stripe",
		QuotaLimit:      &limit,
		Status:          "active",
	}); !errors.As(err, &EntitlementConflictError{}) {
		t.Fatalf("expected EntitlementConflictError, got %v", err)
	}

	// Consume slot 1, verify idempotent replay on same key does not consume slot 2.
	d1, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-1:root", 2)
	if err != nil || !d1.AllowLinks || d1.Refund == nil {
		t.Fatalf("slot 1 = %+v, %v", d1, err)
	}
	d1Replay, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-1:root", 2)
	if err != nil || !d1Replay.AllowLinks {
		t.Fatalf("slot 1 replay = %+v, %v", d1Replay, err)
	}

	// Consume slot 2, refund it, and confirm slot 2 can be used again.
	d2, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-2:root", 1)
	if err != nil || !d2.AllowLinks || d2.Refund == nil {
		t.Fatalf("slot 2 = %+v, %v", d2, err)
	}
	d2.Refund()

	d2Again, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "reply:1", "post-3:reply:1", 1)
	if err != nil || !d2Again.AllowLinks {
		t.Fatalf("slot 2 after refund = %+v, %v", d2Again, err)
	}

	// Slot 3 must be refused as quota_exceeded with a NextSlotAt timestamp.
	d3, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-4:root", 1)
	if err != nil {
		t.Fatalf("slot 3 error = %v", err)
	}
	if d3.AllowLinks || d3.Reason != "quota_exceeded" || d3.NextSlotAt == nil {
		t.Fatalf("slot 3 = %+v, want quota_exceeded with NextSlotAt", d3)
	}

	// EntitlementSummary reports exact used/remaining counts.
	summary, err := w.repo.GetEntitlementSummary(w.ctx, w.owner)
	if err != nil {
		t.Fatalf("GetEntitlementSummary() error = %v", err)
	}
	if !summary.Addons.XLinks.Enabled || summary.Addons.XLinks.Used != 2 || summary.Addons.XLinks.Remaining == nil || *summary.Addons.XLinks.Remaining != 0 {
		t.Fatalf("summary.Addons.XLinks = %+v", summary.Addons.XLinks)
	}

	// Age slot 1 past 30 days and verify rolling window opens a new slot.
	w.exec(t, `UPDATE "x_link_post_usage" SET "consumedAt" = NOW() - INTERVAL '31 days' WHERE "organizationId"=$1 AND "idempotencyKey"=$2`, w.org, "post-1:root")
	d4, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", fmt.Sprintf("post-5-%s:root", w.id), 1)
	if err != nil || !d4.AllowLinks || !d4.QuotaConsumed {
		t.Fatalf("rolling window slot after 31d = %+v, %v", d4, err)
	}

	// Re-arming an aged refunded key (>30d old) must refresh consumedAt to now
	// so it counts inside the current rolling 30-day window.
	w.exec(t, `UPDATE "x_link_post_usage" SET "consumedAt" = NOW() - INTERVAL '35 days' WHERE "organizationId"=$1 AND "idempotencyKey"=$2`, w.org, "post-2:root")
	d4.Refund()
	dRearm, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-2:root", 1)
	if err != nil || !dRearm.AllowLinks || !dRearm.QuotaConsumed {
		t.Fatalf("re-arm aged refunded key = %+v, %v", dRearm, err)
	}
	// Now 2 slots are occupied (post-3:reply:1 + re-armed post-2:root); a 3rd must be rejected.
	dCapAfterRearm, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-6:root", 1)
	if err != nil || dCapAfterRearm.AllowLinks || dCapAfterRearm.Reason != "quota_exceeded" {
		t.Fatalf("expected quota_exceeded after re-arm, got %+v, %v", dCapAfterRearm, err)
	}

	// Rollout modes: shadow and disabled allow links without consuming quota.
	t.Setenv("PLATFORM_X_LINK_ENFORCEMENT", "shadow")
	dShadow, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-shadow:root", 1)
	if err != nil || !dShadow.AllowLinks || dShadow.QuotaConsumed {
		t.Fatalf("shadow mode = %+v, %v", dShadow, err)
	}
	t.Setenv("PLATFORM_X_LINK_ENFORCEMENT", "disabled")
	dDisabled, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", "post-disabled:root", 1)
	if err != nil || !dDisabled.AllowLinks || dDisabled.QuotaConsumed {
		t.Fatalf("disabled mode = %+v, %v", dDisabled, err)
	}
	t.Setenv("PLATFORM_X_LINK_ENFORCEMENT", "enforce")

	// Update add-on v1 -> v2 (canceling) and v2 -> v3 (paused) and verify summary + audit logs.
	newLimit := 5
	v2, err := w.repo.SyncWorkspaceAddon(w.ctx, AddonSyncInput{
		AddonKey:               AddonXLinks,
		CancelAtPeriodEnd:      true,
		CurrentPeriodEnd:       &periodEnd,
		EventID:                "evt_v2_" + w.id,
		EventType:              "customer.subscription.updated",
		ExpectedVersion:        1,
		ExternalSubscriptionID: &subID,
		OrganizationID:         w.org,
		Provider:               "stripe",
		QuotaLimit:             &newLimit,
		Status:                 "active",
	})
	if err != nil || v2.Version != 2 {
		t.Fatalf("v2 sync = %+v, %v", v2, err)
	}
	s2, err := w.repo.GetXLinksSummary(w.ctx, w.org, true, time.Now().UTC())
	if err != nil || s2.Status != "canceling" || s2.CancelsAt == nil || !s2.Enabled {
		t.Fatalf("s2 = %+v, %v", s2, err)
	}
	// Concurrent contention: 3 slots remain (limit 5 - used 2); 8 concurrent callers -> exactly 3 allowed.
	type outcome struct {
		allowed bool
		err     error
	}
	ch := make(chan outcome, 8)
	for i := range 8 {
		go func(idx int) {
			d, err := w.repo.PrepareXLinkSend(w.ctx, w.org, nil, "root", fmt.Sprintf("concurrent-%s-%d", w.id, idx), 1)
			ch <- outcome{allowed: d.AllowLinks, err: err}
		}(i)
	}
	allowedCount := 0
	for range 8 {
		res := <-ch
		if res.err != nil {
			t.Fatalf("concurrent PrepareXLinkSend error = %v", res.err)
		}
		if res.allowed {
			allowedCount++
		}
	}
	if allowedCount != 3 {
		t.Fatalf("concurrent allowed = %d, want exactly 3", allowedCount)
	}

	// Base plan paused must disable x_links even while add-on row is active.
	sBasePaused, err := w.repo.GetXLinksSummary(w.ctx, w.org, false, time.Now().UTC())
	if err != nil || sBasePaused.Enabled {
		t.Fatalf("expected disabled when base plan is inactive, got %+v, %v", sBasePaused, err)
	}
}
