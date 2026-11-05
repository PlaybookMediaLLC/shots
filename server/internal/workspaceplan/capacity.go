// Package workspaceplan shares subscription standing and held-resource limits
// between product operations and publishing commitments.
package workspaceplan

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
)

const (
	Seats    = "seats"
	Channels = "channels"
)

// limits mirrors the Packaging table in RFC 023. An unsubscribed workspace
// keeps its owner's seat and connects no social channel.
var limits = map[string]map[string]int{
	"free":       {Seats: 1, Channels: 0},
	"pro":        {Seats: 10, Channels: 15},
	"business":   {Seats: math.MaxInt32, Channels: 100},
	"enterprise": {Seats: math.MaxInt32, Channels: math.MaxInt32},
}

type LimitError struct {
	Limit      int
	Name, Plan string
	Inactive   bool
}

func (e *LimitError) Error() string {
	noun := map[string]string{Seats: "seats", Channels: "social channels"}[e.Name]
	if e.Inactive {
		return fmt.Sprintf("Restore the workspace subscription to add %s.", noun)
	}
	if e.Plan == "free" {
		return fmt.Sprintf("Choose a plan to add %s.", noun)
	}
	return fmt.Sprintf("The %s plan includes %d %s. Upgrade the plan to add more.", strings.ToUpper(e.Plan[:1])+e.Plan[1:], e.Limit, noun)
}

// Resolve evaluates plan standing at the point of use; expiration boundaries
// are exclusive and a past-due subscription needs an unexpired grace period.
func Resolve(row *ent.WorkspaceEntitlement, now time.Time) (plan, status string, active bool) {
	plan, status, active = "free", "active", true
	if row == nil {
		return
	}
	status = row.Status
	if _, known := limits[row.Plan]; known {
		plan = row.Plan
	} else {
		active = false
		return
	}
	active = (status == "active" || status == "trialing" ||
		(status == "past_due" && row.GraceUntil != nil && row.GraceUntil.After(now))) &&
		(row.ValidUntil == nil || row.ValidUntil.After(now))
	return
}

// LockWorkspace serializes capacity commitments and billing changes. Callers
// hold this lock until their resource and audit writes commit together.
func LockWorkspace(ctx context.Context, tx *ent.Tx, org string) (bool, error) {
	found := false
	err := tx.PlatformQuery(ctx, `SELECT id FROM organization WHERE id=$1 FOR UPDATE`, []any{org}, func(row entsql.ColumnScanner) error {
		var id string
		if err := row.Scan(&id); err != nil {
			return err
		}
		found = true
		return nil
	})
	return found, err
}

// RequireCapacity is a preflight unless client belongs to a transaction that
// holds LockWorkspace; resource creation must check again in that transaction.
func RequireCapacity(ctx context.Context, client *ent.Client, org, name string, held int) error {
	limit, plan, active, err := capacityLimit(ctx, client, org, name)
	if err != nil {
		return err
	}
	if !active || held >= limit {
		return &LimitError{Limit: limit, Name: name, Plan: plan, Inactive: !active}
	}
	return nil
}

// capacityLimit is the limit of the workspace's plan, and whether it stands.
func capacityLimit(ctx context.Context, client *ent.Client, org, name string) (limit int, plan string, active bool, err error) {
	row, err := client.WorkspaceEntitlement.Get(ctx, org)
	if err != nil && !ent.IsNotFound(err) {
		return 0, "", false, err
	}
	plan, _, active = Resolve(row, time.Now().UTC())
	if row != nil {
		if enabled, ok := row.FeatureOverrides["workspace:use"].(bool); ok && !enabled {
			active = false
		}
	}
	return limits[plan][name], plan, active, nil
}

// ChannelUsage is the workspace's active accounts and how many it may hold:
// none when its plan does not stand, nil when its plan has no limit.
func ChannelUsage(ctx context.Context, client *ent.Client, org string) (held int, limit *int, err error) {
	held, err = client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
	if err != nil {
		return 0, nil, err
	}
	allowed, _, active, err := capacityLimit(ctx, client, org, Channels)
	if err != nil {
		return 0, nil, err
	}
	if !active {
		allowed = 0
	}
	if allowed == math.MaxInt32 {
		return held, nil, nil
	}
	return held, &allowed, nil
}

// RequireChannel allows an active account to renew without an additional slot.
// Restoring a removed or revoked account consumes capacity again.
func RequireChannel(ctx context.Context, client *ent.Client, org, external string) error {
	known, err := client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org),
		channelconnection.Provider("social"), channelconnection.ExternalAccountID(external), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return err
	}
	held := 0
	if !known {
		held, err = client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
		if err != nil {
			return err
		}
	}
	return RequireCapacity(ctx, client, org, Channels, held)
}
