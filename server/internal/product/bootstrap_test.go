package product

import (
	"slices"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
)

func TestBootstrapEntitlementRespectsStatusDatesAndOverrides(t *testing.T) {
	t.Setenv("PLATFORM_CAMPAIGN_WORKFLOW", "")
	now := time.Date(2026, time.October, 14, 12, 0, 0, 0, time.UTC)
	plan, status, features := evaluateBootstrapEntitlement(nil, now)
	// There is no free plan: a workspace without a subscription has no features.
	if plan != "free" || status != "active" || features["asset:read"] || features["workspace:use"] || features["content:drafts"] || features["workspace:paid"] || features[advancedSchedulingFeature] {
		t.Fatalf("unsubscribed workspace has features: %s %s %+v", plan, status, features)
	}
	grace := now.Add(time.Hour)
	entitlement := &ent.WorkspaceEntitlement{Plan: "pro", Status: "past_due", GraceUntil: &grace,
		FeatureOverrides: map[string]any{"asset:update": false, "campaign:workflow": true}}
	plan, _, features = evaluateBootstrapEntitlement(entitlement, now)
	if plan != "pro" || features["asset:update"] || !features["asset:read"] || !features["workspace:use"] || !features["campaign:workflow"] {
		t.Fatalf("unexpected grace entitlement: %+v", features)
	}
	entitlement.ValidUntil = &now
	_, _, features = evaluateBootstrapEntitlement(entitlement, now)
	if features["asset:read"] || features["campaign:workflow"] {
		t.Fatalf("expired entitlement remained active: %+v", features)
	}
	t.Setenv("PLATFORM_CAMPAIGN_WORKFLOW", "enabled")
	_, _, features = evaluateBootstrapEntitlement(entitlement, now)
	if features["campaign:workflow"] || features["asset:read"] {
		t.Fatalf("rollout flag reopened an expired entitlement: %+v", features)
	}
	_, _, features = evaluateBootstrapEntitlement(nil, now)
	if features["campaign:workflow"] {
		t.Fatal("rollout flag granted paid campaign features to free workspace")
	}
}

func TestPaidPlansIncludeCampaignWorkflow(t *testing.T) {
	t.Setenv("PLATFORM_CAMPAIGN_WORKFLOW", "")
	now := time.Date(2026, time.October, 14, 12, 0, 0, 0, time.UTC)
	for _, plan := range []string{"pro", "business", "enterprise"} {
		_, _, features := evaluateBootstrapEntitlement(&ent.WorkspaceEntitlement{Plan: plan, Status: "active"}, now)
		if !features["campaign:workflow"] {
			t.Fatalf("%s plan lacks campaign:workflow", plan)
		}
	}
	if _, _, features := evaluateBootstrapEntitlement(&ent.WorkspaceEntitlement{Plan: "free", Status: "active"}, now); features["campaign:workflow"] {
		t.Fatal("free workspace has campaign:workflow")
	}
	if _, _, features := evaluateBootstrapEntitlement(&ent.WorkspaceEntitlement{Plan: "pro", Status: "canceled"}, now); features["campaign:workflow"] {
		t.Fatal("inactive workspace has campaign:workflow")
	}
	revoked := &ent.WorkspaceEntitlement{Plan: "business", Status: "active", FeatureOverrides: map[string]any{"campaign:workflow": false}}
	if _, _, features := evaluateBootstrapEntitlement(revoked, now); features["campaign:workflow"] {
		t.Fatal("override did not revoke campaign:workflow")
	}
	if minimumFeaturePlan["campaign:workflow"] != "pro" {
		t.Fatalf("campaign:workflow minimum plan = %s", minimumFeaturePlan["campaign:workflow"])
	}
}

// The onboarding agent is on for paid plans; internal limits it to granted
// workspaces, and disabled turns it off everywhere, overrides included.
func TestOnboardingAgentFlagModes(t *testing.T) {
	now := time.Date(2026, time.October, 17, 12, 0, 0, 0, time.UTC)
	paid := &ent.WorkspaceEntitlement{Plan: "pro", Status: "active"}
	granted := &ent.WorkspaceEntitlement{Plan: "pro", Status: "active", FeatureOverrides: map[string]any{OnboardingFeature: true}}
	free := &ent.WorkspaceEntitlement{Plan: "free", Status: "active"}
	for mode, want := range map[string][3]bool{"": {true, true, false}, "enabled": {true, true, false},
		"internal": {false, true, false}, "disabled": {false, false, false}} {
		t.Setenv("PLATFORM_ONBOARDING_AGENT", mode)
		for i, entitlement := range []*ent.WorkspaceEntitlement{paid, granted, free} {
			if _, _, features := evaluateBootstrapEntitlement(entitlement, now); features[OnboardingFeature] != want[i] {
				t.Fatalf("mode %q workspace %d: %v", mode, i, features[OnboardingFeature])
			}
		}
	}
}

// Every feature is granted on the plans at or above its minimum plan, the same
// table the web prices and labels with, so the two never disagree.
func TestFeaturesFollowTheirMinimumPlan(t *testing.T) {
	t.Setenv("PLATFORM_CAMPAIGN_WORKFLOW", "")
	t.Setenv("PLATFORM_ONBOARDING_AGENT", "")
	rank := []string{"free", "pro", "business", "enterprise"}
	now := time.Now().UTC()
	for _, plan := range rank {
		_, _, features := evaluateBootstrapEntitlement(&ent.WorkspaceEntitlement{Plan: plan, Status: "active"}, now)
		for feature, minimum := range minimumFeaturePlan {
			if feature == CreativeSetsFeature {
				continue // An environment switch gates it as well as the plan.
			}
			want := plan != "free" && slices.Index(rank, plan) >= slices.Index(rank, minimum)
			if features[feature] != want {
				t.Fatalf("%s %s=%v, want %v", plan, feature, features[feature], want)
			}
		}
	}
}
