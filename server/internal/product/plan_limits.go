package product

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/invitation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
)

const (
	LimitSeats    = workspaceplan.Seats
	LimitChannels = workspaceplan.Channels
)

// PlanLimitError preserves the product error contract for shared plan limits.
type PlanLimitError = workspaceplan.LimitError

func (c *Configuration) requirePlanCapacity(ctx context.Context, org, name string, held int) error {
	return workspaceplan.RequireCapacity(ctx, c.client, org, name, held)
}

// RequireSeat refuses adding a member when the workspace's members already
// fill its plan's seats. With invitations set, a pending invitation holds a
// seat too: it is checked before inviting, and not again on acceptance.
func (c *Configuration) RequireSeat(ctx context.Context, org string, invitations bool) error {
	held, err := c.client.Member.Query().Where(member.OrganizationID(org)).Count(ctx)
	if err != nil {
		return err
	}
	if invitations {
		pending, err := c.client.Invitation.Query().Where(invitation.OrganizationID(org),
			invitation.Status("pending"), invitation.ExpiresAtGT(time.Now().UTC())).Count(ctx)
		if err != nil {
			return err
		}
		held += pending
	}
	return c.requirePlanCapacity(ctx, org, LimitSeats, held)
}

// RequireChannel is an early check; publishing checks again inside its write
// transaction. A removed account needs a slot when it is restored.
func (c *Configuration) RequireChannel(ctx context.Context, org, externalAccountID string) error {
	return workspaceplan.RequireChannel(ctx, c.client, org, externalAccountID)
}

// ChannelCapacity is how many accounts a workspace holds and may hold.
type ChannelCapacity struct {
	Held int `json:"held"`
	// Limit is nil when the plan has none.
	Limit *int `json:"limit"`
}

// GetChannelCapacity reads the workspace's account capacity; its route authorizes the actor.
func (c *Configuration) GetChannelCapacity(ctx context.Context, actor Actor) (*ChannelCapacity, error) {
	held, limit, err := workspaceplan.ChannelUsage(ctx, c.client, actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	return &ChannelCapacity{Held: held, Limit: limit}, nil
}
