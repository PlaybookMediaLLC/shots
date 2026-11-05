package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
)

// RevokeProviderConnections ends the connections built on these integrations,
// in every workspace that holds them, because the account holder removed Shots
// at the provider or asked for their data to be deleted. It returns the posts it
// cancelled. Unlike a member removing an account, a post mid-publish doesn't
// hold it up: the token is going away either way. Published posts and their
// receipts stay with the workspace that made them.
func (c *Configuration) RevokeProviderConnections(ctx context.Context, integrationIDs []string, confirmationCode string) ([]string, error) {
	if len(integrationIDs) == 0 {
		return nil, nil
	}
	connections, err := c.client.ChannelConnection.Query().Where(channelconnection.ExternalAccountIDIn(integrationIDs...),
		channelconnection.StatusNEQ(channelconnection.StatusREVOKED)).All(ctx)
	if err != nil {
		return nil, err
	}
	cancelled := []string{}
	for _, connection := range connections {
		posts, err := c.revokeProviderConnection(ctx, connection, confirmationCode)
		cancelled = append(cancelled, posts...)
		if err != nil {
			return cancelled, err
		}
	}
	return cancelled, nil
}

func (c *Configuration) revokeProviderConnection(ctx context.Context, connection *ent.ChannelConnection, confirmationCode string) ([]string, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	actor := Actor{OrganizationID: connection.OrganizationID, Kind: "service", Display: "provider callback"}
	cancelled, err := cancelPosts(ctx, tx, actor, []string{connection.ID}, "account_revoked")
	if err != nil {
		return nil, err
	}
	if _, err := tx.ChannelConnection.UpdateOneID(connection.ID).SetStatus(channelconnection.StatusREVOKED).
		ClearDisplayName().ClearHandle().ClearAvatarURL().Save(ctx); err != nil {
		return nil, err
	}
	if connection.SocialSetID != nil {
		set, err := tx.SocialSet.Query().Where(socialset.ID(*connection.SocialSetID),
			socialset.OrganizationID(connection.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if set != nil {
			if err := dropAccountFromSetDefaults(ctx, tx, connection, set); err != nil {
				return nil, err
			}
		}
	}
	// The code lets support find this record from what Meta shows the person.
	if err := appendConfigurationAudit(ctx, tx, actor, "product.channel_account_revoked", "channel_connection", connection.ID,
		map[string]any{"cancelledPosts": len(cancelled), "confirmationCode": confirmationCode, "platform": connection.Platform}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return cancelled, nil
}
