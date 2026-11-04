package product

import (
	"context"
	"errors"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// ChannelAccountState is what the Channels page shows about an account
// beyond its row: its verified health and how many of its posts wait to publish.
type ChannelAccountState struct {
	Health      string `json:"health"`
	QueuedPosts int    `json:"queuedPosts"`
}

// ChannelAccountStates reads the health and queued-post count of a
// workspace's connections, by connection ID. Queued means what removing the
// account would cancel: drafts and scheduled posts.
func (c *Configuration) ChannelAccountStates(ctx context.Context, organizationID string, connections []*ent.ChannelConnection) (map[string]ChannelAccountState, error) {
	health, err := connectionHealth(ctx, c.client, organizationID, connections)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(connections))
	for _, connection := range connections {
		ids = append(ids, connection.ID)
	}
	var counts []struct {
		ConnectionID string `json:"channelConnectionId"`
		Count        int    `json:"count"`
	}
	if len(ids) > 0 {
		if err := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(organizationID),
			scheduledpost.ChannelConnectionIDIn(ids...),
			scheduledpost.StatusIn(scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED)).
			GroupBy(scheduledpost.FieldChannelConnectionID).Aggregate(ent.Count()).Scan(ctx, &counts); err != nil {
			return nil, err
		}
	}
	queued := make(map[string]int, len(counts))
	for _, count := range counts {
		queued[count.ConnectionID] = count.Count
	}
	states := make(map[string]ChannelAccountState, len(connections))
	for _, connection := range connections {
		states[connection.ID] = ChannelAccountState{Health: health[connection.ID], QueuedPosts: queued[connection.ID]}
	}
	return states, nil
}

// RemoveChannelAccount takes an account out of the workspace, whether it is in
// a publishing brand or in none: its queued posts are cancelled (refused while
// one is publishing), it is disabled so nothing further publishes through it,
// and its published posts and receipts stay. An account in another person's
// private brand is not found.
func (c *Configuration) RemoveChannelAccount(ctx context.Context, actor Actor, connectionID string) (*SocialSetRemoval, error) {
	if err := c.authorizeDecision(ctx, actor, socialSetManageRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(connectionID),
		channelconnection.OrganizationID(actor.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("That account is not connected to this workspace.")
	}
	if err != nil {
		return nil, err
	}
	var set *ent.SocialSet
	if connection.SocialSetID != nil {
		if set, err = visibleSocialSet(ctx, tx.Client(), actor, *connection.SocialSetID); err != nil {
			if errors.Is(err, publishing.ErrNotFound) {
				return nil, notFound("That account is not connected to this workspace.")
			}
			return nil, err
		}
	}
	cancelled, err := removeAccount(ctx, tx, actor, connection, set)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SocialSetRemoval{CancelledPostIDs: cancelled}, nil
}

// AuthorizeChannelManage admits a signed-in owner or admin, who manage the
// workspace's connected accounts.
func (c *Configuration) AuthorizeChannelManage(ctx context.Context, actor Actor) error {
	return c.authorizeDecision(ctx, actor, socialSetManageRoles...)
}
