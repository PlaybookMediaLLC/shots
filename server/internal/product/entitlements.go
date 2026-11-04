package product

import (
	"context"
	"fmt"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
)

type EntitlementSummary struct {
	// CreditBalance is what is left of the workspace's purchased credit packs.
	CreditBalance int             `json:"creditBalance"`
	Features      map[string]bool `json:"features"`
	Plan          string          `json:"plan"`
	Status        string          `json:"status"`
}

type FeatureDecision struct {
	Allowed      bool   `json:"allowed"`
	CurrentPlan  string `json:"currentPlan"`
	RequiredPlan string `json:"requiredPlan"`
}

var minimumFeaturePlan = map[string]string{
	"asset:create": "pro", "asset:read": "pro", "asset:update": "pro", "asset:delete": "pro",
	"release:create": "pro", "source-app:create": "pro", "workspace:use": "pro", "workspace:paid": "pro", "content:scheduling-advanced": "pro", "enterprise:audit-drain": "enterprise",
	"enterprise:sso": "enterprise", "enterprise:scim": "enterprise", "campaign:workflow": "pro", "content:drafts": "pro",
	OnboardingFeature: "pro", CreativeSetsFeature: "pro", WhitelabelFeature: "enterprise",
}

// FeatureNotEntitledError reports a plan gate with the decision the web shows.
type FeatureNotEntitledError struct {
	Feature, CurrentPlan, RequiredPlan string
}

func (e *FeatureNotEntitledError) Error() string {
	return fmt.Sprintf("The %s capability is not available on the current workspace plan.", e.Feature)
}

// requireWorkspaceFeature refuses the call unless the workspace's current
// entitlement grants feature. A workspace without a subscription has none.
func (c *Configuration) requireWorkspaceFeature(ctx context.Context, organizationID, feature string) error {
	entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(organizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	plan, _, features := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	return requireFeature(features, plan, feature)
}

func requireFeature(features map[string]bool, plan, feature string) error {
	if features[feature] {
		return nil
	}
	return &FeatureNotEntitledError{Feature: feature, CurrentPlan: plan, RequiredPlan: minimumFeaturePlan[feature]}
}

func (c *Configuration) entitlementSummary(ctx context.Context, actor Actor) (*EntitlementSummary, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.WorkspaceEntitlement.Get(ctx, actor.OrganizationID)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	plan, status, features := evaluateBootstrapEntitlement(row, time.Now().UTC())
	return &EntitlementSummary{Features: features, Plan: plan, Status: status}, nil
}

// GetEntitlementSummary is the workspace's plan, standing, features, and
// purchased credit balance, for the Billing settings page.
func (c *Configuration) GetEntitlementSummary(ctx context.Context, actor Actor) (*EntitlementSummary, error) {
	summary, err := c.entitlementSummary(ctx, actor)
	if err != nil {
		return nil, err
	}
	if summary.CreditBalance, err = c.creditBalance(ctx, actor.OrganizationID); err != nil {
		return nil, err
	}
	return summary, nil
}

func (c *Configuration) GetFeatureDecision(ctx context.Context, actor Actor, feature string) (*FeatureDecision, error) {
	requiredPlan, ok := minimumFeaturePlan[feature]
	if !ok {
		return nil, ErrInvalidInput
	}
	summary, err := c.entitlementSummary(ctx, actor)
	if err != nil {
		return nil, err
	}
	return &FeatureDecision{Allowed: summary.Features[feature], CurrentPlan: summary.Plan, RequiredPlan: requiredPlan}, nil
}
