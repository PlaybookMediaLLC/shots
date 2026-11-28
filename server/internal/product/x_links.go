package product

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"slices"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceaddon"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/xlinkpostusage"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/lucsky/cuid"
)

const (
	// AddonXLinks is the workspace add-on that keeps links in outbound X posts.
	AddonXLinks = "x_links"
	// DefaultXLinksLimit is the standard rolling 30-day X link post allowance.
	DefaultXLinksLimit = 40
	// XLinksWindowDays is the rolling quota window length in days.
	XLinksWindowDays = 30
	// XLinksWindow is the rolling quota window duration.
	XLinksWindow = XLinksWindowDays * 24 * time.Hour
	// XLinksMonthlyPriceUSD is the add-on's list price in whole US dollars.
	XLinksMonthlyPriceUSD = 10
)

// AddonSyncInput is a signed billing provider event for a workspace add-on.
type AddonSyncInput struct {
	AddonKey               string     `json:"addonKey"`
	CancelAtPeriodEnd      bool       `json:"cancelAtPeriodEnd"`
	CurrentPeriodEnd       *time.Time `json:"currentPeriodEnd"`
	CurrentPeriodStart     *time.Time `json:"currentPeriodStart"`
	EventID                string     `json:"eventId"`
	EventType              string     `json:"eventType"`
	ExpectedVersion        int        `json:"expectedVersion"`
	ExternalSubscriptionID *string    `json:"externalSubscriptionId"`
	GraceUntil             *time.Time `json:"graceUntil"`
	OrganizationID         string     `json:"organizationId"`
	Provider               string     `json:"provider"`
	QuotaLimit             *int       `json:"quotaLimit"`
	Status                 string     `json:"status"`
}

// AddonSyncResult is returned after applying or replaying an add-on sync event.
type AddonSyncResult struct {
	Replayed bool `json:"replayed"`
	Version  int  `json:"version"`
}

// XLinksAddonSummary is the Billing settings & composer snapshot of the X links add-on.
type XLinksAddonSummary struct {
	CancelsAt       *time.Time `json:"cancelsAt"`
	Enabled         bool       `json:"enabled"`
	Limit           *int       `json:"limit"`
	NextSlotAt      *time.Time `json:"nextSlotAt"`
	PriceMonthlyUSD int        `json:"priceMonthlyUsd"`
	Remaining       *int       `json:"remaining"`
	Status          string     `json:"status"`
	Used            int        `json:"used"`
	WindowDays      int        `json:"windowDays"`
}

// WorkspaceAddonsSummary groups paid add-on summaries for EntitlementSummary & Bootstrap.
type WorkspaceAddonsSummary struct {
	XLinks XLinksAddonSummary `json:"xLinks"`
}

// XLinkSendDecision is the policy outcome before publishing a tweet that contains links.
type XLinkSendDecision struct {
	AllowLinks    bool
	Limit         int
	NextSlotAt    *time.Time
	QuotaConsumed bool
	Reason        string
	Refund        func()
}

func validAddonSync(input AddonSyncInput) bool {
	bounded := func(value *string) bool { return value == nil || len(*value) <= 255 }
	if input.QuotaLimit != nil && *input.QuotaLimit < 0 {
		return false
	}
	return input.AddonKey == AddonXLinks &&
		input.EventID != "" && len(input.EventID) <= 255 &&
		input.EventType != "" && len(input.EventType) <= 120 &&
		input.ExpectedVersion >= 0 &&
		bounded(input.ExternalSubscriptionID) &&
		input.OrganizationID != "" && len(input.OrganizationID) <= 128 &&
		input.Provider != "" && len(input.Provider) <= 80 &&
		slices.Contains([]string{"active", "past_due", "paused", "canceled"}, input.Status)
}

func addonStandingActive(row *ent.WorkspaceAddon, now time.Time) bool {
	if row == nil {
		return false
	}
	switch row.Status {
	case "active":
		return true
	case "past_due":
		return row.GraceUntil != nil && row.GraceUntil.After(now)
	default:
		return false
	}
}

func effectiveXLinksLimit(row *ent.WorkspaceAddon) *int {
	if row == nil {
		limit := DefaultXLinksLimit
		return &limit
	}
	if row.QuotaLimit != nil {
		limit := *row.QuotaLimit
		return &limit
	}
	// Manual/Enterprise agreements may intentionally leave QuotaLimit nil (unlimited).
	if row.Provider == "manual" || row.Provider == "enterprise" {
		return nil
	}
	limit := DefaultXLinksLimit
	return &limit
}

// SyncWorkspaceAddon applies a verified billing event for a workspace add-on
// once per provider event ID with optimistic concurrency and an audit entry.
func (c *Configuration) SyncWorkspaceAddon(ctx context.Context, input AddonSyncInput) (*AddonSyncResult, error) {
	if !validAddonSync(input) {
		return nil, ErrInvalidInput
	}
	result, err := c.syncWorkspaceAddon(ctx, input)
	if ent.IsConstraintError(err) {
		if replay, replayErr := entitlementReplay(ctx, c.client, EntitlementSyncInput{Provider: input.Provider, EventID: input.EventID}); replayErr != nil || replay != nil {
			if replayErr != nil {
				return nil, replayErr
			}
			return &AddonSyncResult{Replayed: true, Version: replay.Version}, nil
		}
		return nil, publishing.ErrConflict
	}
	return result, err
}

func (c *Configuration) syncWorkspaceAddon(ctx context.Context, input AddonSyncInput) (*AddonSyncResult, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	replayInput := EntitlementSyncInput{Provider: input.Provider, EventID: input.EventID}
	if replay, err := entitlementReplay(ctx, tx.Client(), replayInput); err != nil || replay != nil {
		if err != nil {
			return nil, err
		}
		return &AddonSyncResult{Replayed: true, Version: replay.Version}, nil
	}
	exists, err := workspaceplan.LockWorkspace(ctx, tx, input.OrganizationID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("workspace not found: %w", publishing.ErrNotFound)
	}
	if replay, err := entitlementReplay(ctx, tx.Client(), replayInput); err != nil || replay != nil {
		if err != nil {
			return nil, err
		}
		return &AddonSyncResult{Replayed: true, Version: replay.Version}, nil
	}
	current, err := tx.WorkspaceAddon.Query().Where(
		workspaceaddon.OrganizationID(input.OrganizationID),
		workspaceaddon.AddonKey(input.AddonKey),
	).Only(ctx)
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
	now := time.Now().UTC()
	quotaLimit := input.QuotaLimit
	if quotaLimit == nil && input.Provider == "stripe" && input.AddonKey == AddonXLinks {
		def := DefaultXLinksLimit
		quotaLimit = &def
	}
	if current != nil {
		update := tx.WorkspaceAddon.Update().Where(
			workspaceaddon.ID(current.ID),
			workspaceaddon.Version(currentVersion),
		).
			SetStatus(input.Status).
			SetProvider(input.Provider).
			SetCancelAtPeriodEnd(input.CancelAtPeriodEnd).
			SetLastSyncedAt(now).
			SetVersion(version)
		if input.ExternalSubscriptionID == nil {
			update.ClearExternalSubscriptionID()
		} else {
			update.SetExternalSubscriptionID(*input.ExternalSubscriptionID)
		}
		if quotaLimit == nil {
			update.ClearQuotaLimit()
		} else {
			update.SetQuotaLimit(*quotaLimit)
		}
		if input.CurrentPeriodStart == nil {
			update.ClearCurrentPeriodStart()
		} else {
			update.SetCurrentPeriodStart(*input.CurrentPeriodStart)
		}
		if input.CurrentPeriodEnd == nil {
			update.ClearCurrentPeriodEnd()
		} else {
			update.SetCurrentPeriodEnd(*input.CurrentPeriodEnd)
		}
		if input.GraceUntil == nil {
			update.ClearGraceUntil()
		} else {
			update.SetGraceUntil(*input.GraceUntil)
		}
		updated, err := update.Save(ctx)
		if err != nil {
			return nil, err
		}
		if updated != 1 {
			return nil, EntitlementConflictError{Current: currentVersion}
		}
	} else {
		if err := tx.WorkspaceAddon.Create().
			SetID(cuid.New()).
			SetOrganizationID(input.OrganizationID).
			SetAddonKey(input.AddonKey).
			SetStatus(input.Status).
			SetProvider(input.Provider).
			SetNillableExternalSubscriptionID(input.ExternalSubscriptionID).
			SetNillableQuotaLimit(quotaLimit).
			SetNillableCurrentPeriodStart(input.CurrentPeriodStart).
			SetNillableCurrentPeriodEnd(input.CurrentPeriodEnd).
			SetCancelAtPeriodEnd(input.CancelAtPeriodEnd).
			SetNillableGraceUntil(input.GraceUntil).
			SetLastSyncedAt(now).
			SetVersion(version).
			Exec(ctx); err != nil {
			return nil, err
		}
	}
	if err := tx.BillingEntitlementEvent.Create().
		SetID(cuid.New()).
		SetOrganizationID(input.OrganizationID).
		SetProvider(input.Provider).
		SetEventID(input.EventID).
		SetEventType(input.EventType).
		SetEntitlementVersion(version).
		Exec(ctx); err != nil {
		return nil, err
	}
	if err := publishing.AppendAudit(ctx, tx, publishing.AuditInput{
		Action:       "billing.addon_changed",
		Actor:        publishing.Actor{Display: input.Provider, RequestID: input.EventID, Type: "SERVICE"},
		EntityID:     input.OrganizationID,
		EntityType:   "workspace_addon",
		Organization: input.OrganizationID,
		Outcome:      auditlog.OutcomeSUCCEEDED,
		Metadata: map[string]any{
			"addonKey":          input.AddonKey,
			"cancelAtPeriodEnd": input.CancelAtPeriodEnd,
			"currentVersion":    currentVersion,
			"eventId":           input.EventID,
			"eventType":         input.EventType,
			"status":            input.Status,
			"version":           version,
		},
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &AddonSyncResult{Replayed: false, Version: version}, nil
}

// GetXLinksSummary computes the workspace's live Links in X posts add-on status
// and rolling 30-day usage snapshot.
func (c *Configuration) GetXLinksSummary(ctx context.Context, orgID string, baseActive bool, now time.Time) (XLinksAddonSummary, error) {
	row, err := c.client.WorkspaceAddon.Query().Where(
		workspaceaddon.OrganizationID(orgID),
		workspaceaddon.AddonKey(AddonXLinks),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return XLinksAddonSummary{}, err
	}
	return c.summarizeXLinksRow(ctx, orgID, row, baseActive, now)
}

func (c *Configuration) summarizeXLinksRow(ctx context.Context, orgID string, row *ent.WorkspaceAddon, baseActive bool, now time.Time) (XLinksAddonSummary, error) {
	now = now.UTC()
	defaultLimit := DefaultXLinksLimit
	summary := XLinksAddonSummary{
		Limit:           &defaultLimit,
		PriceMonthlyUSD: XLinksMonthlyPriceUSD,
		Status:          "off",
		WindowDays:      XLinksWindowDays,
	}
	if row == nil {
		rem := defaultLimit
		summary.Remaining = &rem
		return summary, nil
	}
	limit := effectiveXLinksLimit(row)
	summary.Limit = limit

	addonActive := baseActive && addonStandingActive(row, now)
	summary.Enabled = addonActive
	switch {
	case addonActive && row.CancelAtPeriodEnd:
		summary.Status = "canceling"
		summary.CancelsAt = row.CurrentPeriodEnd
	case addonActive && row.Status == "past_due":
		summary.Status = "past_due"
	case addonActive:
		summary.Status = "active"
	case row.Status == "paused":
		summary.Status = "paused"
	default:
		summary.Status = "off"
	}

	since := now.Add(-XLinksWindow)
	var used int
	if err := c.client.PlatformQuery(ctx,
		`SELECT COUNT(*)::int FROM "x_link_post_usage" WHERE "organizationId"=$1 AND "refundedAt" IS NULL AND "consumedAt" >= $2`,
		[]any{orgID, since}, func(r entsql.ColumnScanner) error {
			return r.Scan(&used)
		}); err != nil {
		return summary, err
	}
	summary.Used = used
	if limit != nil {
		rem := max(*limit-used, 0)
		summary.Remaining = &rem
		if *limit > 0 && used >= *limit {
			offset := used - *limit
			var slotConsumedAt *time.Time
			if err := c.client.PlatformQuery(ctx,
				`SELECT "consumedAt" FROM "x_link_post_usage" WHERE "organizationId"=$1 AND "refundedAt" IS NULL AND "consumedAt" >= $2 ORDER BY "consumedAt" ASC OFFSET $3 LIMIT 1`,
				[]any{orgID, since, offset}, func(r entsql.ColumnScanner) error {
					return r.Scan(&slotConsumedAt)
				}); err != nil {
				return summary, err
			}
			if slotConsumedAt != nil {
				next := slotConsumedAt.UTC().Add(XLinksWindow)
				summary.NextSlotAt = &next
			}
		}
	}
	return summary, nil
}

// xLinkEnforcementMode returns "enforce" (default), "shadow", or "disabled".
func xLinkEnforcementMode() string {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("PLATFORM_X_LINK_ENFORCEMENT")))
	switch raw {
	case "", "enforce":
		return "enforce"
	case "disabled":
		return "disabled"
	case "shadow":
		return "shadow"
	default:
		slog.Warn("unrecognized PLATFORM_X_LINK_ENFORCEMENT value; defaulting to enforce", "value", raw)
		return "enforce"
	}
}

// PrepareXLinkSend atomically evaluates whether an outbound X tweet containing
// linkCount URLs may keep its links and, if so, reserves one rolling 30-day
// ledger slot deduplicated by (orgID, idempotencyKey).
func (c *Configuration) PrepareXLinkSend(ctx context.Context, orgID string, scheduledPostID *string, partKey, idempotencyKey string, linkCount int) (XLinkSendDecision, error) {
	mode := xLinkEnforcementMode()
	if mode == "disabled" || linkCount <= 0 {
		return XLinkSendDecision{AllowLinks: true}, nil
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return XLinkSendDecision{}, err
	}
	defer tx.Rollback()

	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('x-links:' || $1, 0))`, orgID); err != nil {
		return XLinkSendDecision{}, err
	}
	now := time.Now().UTC()
	entitlement, err := tx.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(orgID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return XLinkSendDecision{}, err
	}
	_, _, features := evaluateBootstrapEntitlement(entitlement, now)
	baseActive := features["workspace:use"]

	addon, err := tx.WorkspaceAddon.Query().Where(
		workspaceaddon.OrganizationID(orgID),
		workspaceaddon.AddonKey(AddonXLinks),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return XLinkSendDecision{}, err
	}
	if !baseActive || !addonStandingActive(addon, now) {
		if mode == "shadow" {
			slog.InfoContext(ctx, "x_links shadow: would strip links (add-on off)",
				"organizationId", orgID, "partKey", partKey, "linkCount", linkCount)
			return XLinkSendDecision{AllowLinks: true}, nil
		}
		return XLinkSendDecision{AllowLinks: false, Reason: "addon_disabled"}, nil
	}

	// Idempotent replay: if this exact post+part already reserved a non-refunded
	// slot, allow without consuming a second slot.
	existing, err := tx.XLinkPostUsage.Query().Where(
		xlinkpostusage.OrganizationID(orgID),
		xlinkpostusage.IdempotencyKey(idempotencyKey),
	).Only(ctx)
	if err == nil {
		if existing.RefundedAt == nil {
			usageID := existing.ID
			return XLinkSendDecision{
				AllowLinks:    true,
				QuotaConsumed: true,
				Refund:        func() { c.refundXLinkUsage(usageID) },
			}, nil
		}
	} else if !ent.IsNotFound(err) {
		return XLinkSendDecision{}, err
	}

	limit := effectiveXLinksLimit(addon)
	if limit != nil {
		since := now.Add(-XLinksWindow)
		var used int
		if err := tx.PlatformQuery(ctx,
			`SELECT COUNT(*)::int FROM "x_link_post_usage" WHERE "organizationId"=$1 AND "refundedAt" IS NULL AND "consumedAt" >= $2`,
			[]any{orgID, since}, func(row entsql.ColumnScanner) error {
				return row.Scan(&used)
			}); err != nil {
			return XLinkSendDecision{}, err
		}
		if used >= *limit {
			var nextSlot *time.Time
			if *limit > 0 {
				offset := used - *limit
				var slotConsumedAt *time.Time
				if err := tx.PlatformQuery(ctx,
					`SELECT "consumedAt" FROM "x_link_post_usage" WHERE "organizationId"=$1 AND "refundedAt" IS NULL AND "consumedAt" >= $2 ORDER BY "consumedAt" ASC OFFSET $3 LIMIT 1`,
					[]any{orgID, since, offset}, func(row entsql.ColumnScanner) error {
						return row.Scan(&slotConsumedAt)
					}); err != nil {
					return XLinkSendDecision{}, err
				}
				if slotConsumedAt != nil {
					t := slotConsumedAt.UTC().Add(XLinksWindow)
					nextSlot = &t
				}
			}
			if mode == "shadow" {
				slog.InfoContext(ctx, "x_links shadow: would reject (rolling 30d quota exceeded)",
					"organizationId", orgID, "used", used, "limit", *limit)
				return XLinkSendDecision{AllowLinks: true}, nil
			}
			return XLinkSendDecision{AllowLinks: false, Limit: *limit, Reason: "quota_exceeded", NextSlotAt: nextSlot}, nil
		}
	}

	var usageID string
	if existing != nil && existing.RefundedAt != nil {
		// Re-arm a previously refunded reservation on retry with fresh consumedAt.
		if err := tx.XLinkPostUsage.UpdateOneID(existing.ID).
			ClearRefundedAt().
			SetConsumedAt(now).
			SetLinkCount(linkCount).
			Exec(ctx); err != nil {
			return XLinkSendDecision{}, err
		}
		usageID = existing.ID
	} else {
		usageID = cuid.New()
		if err := tx.XLinkPostUsage.Create().
			SetID(usageID).
			SetOrganizationID(orgID).
			SetNillableScheduledPostID(scheduledPostID).
			SetPartKey(partKey).
			SetIdempotencyKey(idempotencyKey).
			SetLinkCount(linkCount).
			SetConsumedAt(now).
			Exec(ctx); err != nil {
			return XLinkSendDecision{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return XLinkSendDecision{}, err
	}
	return XLinkSendDecision{
		AllowLinks:    true,
		QuotaConsumed: true,
		Refund:        func() { c.refundXLinkUsage(usageID) },
	}, nil
}

func (c *Configuration) refundXLinkUsage(usageID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.client.XLinkPostUsage.UpdateOneID(usageID).SetRefundedAt(time.Now().UTC()).Exec(ctx); err != nil {
		slog.Error("x_link_post_usage refund failed", "usageId", usageID, "error", err)
	}
}
