package product

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/billingentitlementevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/lucsky/cuid"
)

// EntitlementSyncInput is a signed billing provider event. The web facade
// verified its HMAC before forwarding it.
type EntitlementSyncInput struct {
	EventID                string          `json:"eventId"`
	EventType              string          `json:"eventType"`
	ExpectedVersion        int             `json:"expectedVersion"`
	ExternalCustomerID     *string         `json:"externalCustomerId"`
	ExternalSubscriptionID *string         `json:"externalSubscriptionId"`
	FeatureOverrides       map[string]bool `json:"featureOverrides"`
	GraceUntil             *time.Time      `json:"graceUntil"`
	OrganizationID         string          `json:"organizationId"`
	Plan                   string          `json:"plan"`
	Provider               string          `json:"provider"`
	Status                 string          `json:"status"`
	ValidUntil             *time.Time      `json:"validUntil"`
}

type EntitlementSyncResult struct {
	Replayed bool `json:"replayed"`
	Version  int  `json:"version"`
}

// WorkspaceEntitlementRecord is the owner-visible contract state; provider
// identifiers stay in the backend.
type WorkspaceEntitlementRecord struct {
	FeatureOverrides map[string]any `json:"featureOverrides"`
	GraceUntil       *time.Time     `json:"graceUntil"`
	LastSyncedAt     *time.Time     `json:"lastSyncedAt"`
	Plan             string         `json:"plan"`
	Status           string         `json:"status"`
	ValidUntil       *time.Time     `json:"validUntil"`
	Version          int            `json:"version"`
}

// EntitlementConflictError tells the provider which version to retry against.
type EntitlementConflictError struct{ Current int }

func (e EntitlementConflictError) Error() string {
	return fmt.Sprintf("Entitlement version conflict. Current version is %d.", e.Current)
}
func (e EntitlementConflictError) Unwrap() error { return publishing.ErrConflict }

func validEntitlementSync(input EntitlementSyncInput) bool {
	bounded := func(value *string) bool { return value == nil || len(*value) <= 255 }
	for feature := range input.FeatureOverrides {
		if _, ok := minimumFeaturePlan[feature]; !ok {
			return false
		}
	}
	return input.EventID != "" && len(input.EventID) <= 255 && input.EventType != "" && len(input.EventType) <= 120 &&
		input.ExpectedVersion >= 0 && bounded(input.ExternalCustomerID) && bounded(input.ExternalSubscriptionID) &&
		input.OrganizationID != "" && len(input.OrganizationID) <= 128 &&
		slices.Contains([]string{"free", "pro", "business", "enterprise"}, input.Plan) &&
		input.Provider != "" && len(input.Provider) <= 80 &&
		slices.Contains([]string{"active", "trialing", "past_due", "paused", "suspended", "cancelled"}, input.Status)
}

func entitlementReplay(ctx context.Context, client *ent.Client, input EntitlementSyncInput) (*EntitlementSyncResult, error) {
	event, err := client.BillingEntitlementEvent.Query().Where(
		billingentitlementevent.Provider(input.Provider), billingentitlementevent.EventID(input.EventID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &EntitlementSyncResult{Replayed: true, Version: event.EntitlementVersion}, nil
}

// SyncWorkspaceEntitlement applies a billing event once per provider event
// ID. Each change names the version it expects, so a stale event never
// overwrites newer contract state. Facade-only: no tenant principal exists.
func (c *Configuration) SyncWorkspaceEntitlement(ctx context.Context, input EntitlementSyncInput) (*EntitlementSyncResult, error) {
	if !validEntitlementSync(input) {
		return nil, ErrInvalidInput
	}
	result, err := c.syncWorkspaceEntitlement(ctx, input)
	if ent.IsConstraintError(err) {
		// A concurrent delivery of the same event won the race.
		if replay, replayErr := entitlementReplay(ctx, c.client, input); replayErr != nil || replay != nil {
			return replay, replayErr
		}
		return nil, publishing.ErrConflict
	}
	return result, err
}

func (c *Configuration) syncWorkspaceEntitlement(ctx context.Context, input EntitlementSyncInput) (*EntitlementSyncResult, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if replay, err := entitlementReplay(ctx, tx.Client(), input); err != nil || replay != nil {
		return replay, err
	}
	exists, err := workspaceplan.LockWorkspace(ctx, tx, input.OrganizationID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("workspace not found: %w", publishing.ErrNotFound)
	}
	if replay, err := entitlementReplay(ctx, tx.Client(), input); err != nil || replay != nil {
		return replay, err
	}
	current, err := tx.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(input.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	currentVersion := 0
	if current != nil {
		currentVersion = current.Version
	}
	if currentVersion != input.ExpectedVersion {
		return nil, EntitlementConflictError{Current: currentVersion}
	}
	version := currentVersion + 1
	overrides := make(map[string]any, len(input.FeatureOverrides))
	for feature, enabled := range input.FeatureOverrides {
		overrides[feature] = enabled
	}
	now := time.Now().UTC()
	if current != nil {
		// Prisma wrote absent optional fields as null; clear the old contract's values.
		update := tx.WorkspaceEntitlement.Update().
			Where(workspaceentitlement.ID(input.OrganizationID), workspaceentitlement.Version(currentVersion)).
			SetPlan(input.Plan).SetStatus(input.Status).SetFeatureOverrides(overrides).
			SetProvider(input.Provider).SetLastSyncedAt(now).SetVersion(version)
		if input.ValidUntil == nil {
			update.ClearValidUntil()
		} else {
			update.SetValidUntil(*input.ValidUntil)
		}
		if input.GraceUntil == nil {
			update.ClearGraceUntil()
		} else {
			update.SetGraceUntil(*input.GraceUntil)
		}
		if input.ExternalCustomerID == nil {
			update.ClearExternalCustomerID()
		} else {
			update.SetExternalCustomerID(*input.ExternalCustomerID)
		}
		if input.ExternalSubscriptionID == nil {
			update.ClearExternalSubscriptionID()
		} else {
			update.SetExternalSubscriptionID(*input.ExternalSubscriptionID)
		}
		updated, err := update.Save(ctx)
		if err != nil {
			return nil, err
		}
		if updated != 1 {
			return nil, EntitlementConflictError{Current: currentVersion}
		}
	} else if err := tx.WorkspaceEntitlement.Create().SetID(input.OrganizationID).
		SetPlan(input.Plan).SetStatus(input.Status).SetFeatureOverrides(overrides).
		SetNillableValidUntil(input.ValidUntil).SetNillableGraceUntil(input.GraceUntil).
		SetProvider(input.Provider).SetNillableExternalCustomerID(input.ExternalCustomerID).
		SetNillableExternalSubscriptionID(input.ExternalSubscriptionID).SetLastSyncedAt(now).
		SetVersion(version).Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.BillingEntitlementEvent.Create().SetID(cuid.New()).SetOrganizationID(input.OrganizationID).
		SetProvider(input.Provider).SetEventID(input.EventID).SetEventType(input.EventType).
		SetEntitlementVersion(version).Exec(ctx); err != nil {
		return nil, err
	}
	if err := publishing.AppendAudit(ctx, tx, publishing.AuditInput{
		Action: "billing.entitlement_changed", Actor: publishing.Actor{Display: input.Provider, RequestID: input.EventID, Type: "SERVICE"},
		EntityID: input.OrganizationID, EntityType: "workspace_entitlement", Organization: input.OrganizationID,
		Outcome: auditlog.OutcomeSUCCEEDED, Metadata: map[string]any{
			"currentVersion": currentVersion, "eventId": input.EventID, "eventType": input.EventType,
			"plan": input.Plan, "status": input.Status, "version": version,
		},
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &EntitlementSyncResult{Replayed: false, Version: version}, nil
}

// GetWorkspaceEntitlement is the owner's sensitive view of the contract.
func (c *Configuration) GetWorkspaceEntitlement(ctx context.Context, actor Actor) (*WorkspaceEntitlementRecord, error) {
	if err := c.AuthorizeSensitive(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return &WorkspaceEntitlementRecord{Plan: "free", Status: "active", Version: 0}, nil
	}
	if err != nil {
		return nil, err
	}
	return &WorkspaceEntitlementRecord{FeatureOverrides: row.FeatureOverrides, GraceUntil: row.GraceUntil,
		LastSyncedAt: row.LastSyncedAt, Plan: row.Plan, Status: row.Status, ValidUntil: row.ValidUntil,
		Version: row.Version}, nil
}
