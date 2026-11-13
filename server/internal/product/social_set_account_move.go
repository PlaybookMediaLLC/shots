package product

import (
	"context"
	"slices"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
)

// MoveSocialSetAccount keeps a connection active while moving it between
// profiles in the same workspace. Drafts and published history stay put.
func (c *Configuration) MoveSocialSetAccount(ctx context.Context, actor Actor, sourceID, connectionID, destinationID string) (*SocialSetRecord, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	if sourceID == destinationID {
		return nil, invalid("Choose another profile for this account.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Match connection/OAuth lock order and serialize moves in both directions.
	ids := []string{sourceID, destinationID}
	slices.Sort(ids)
	if err := lockSocialSetAuthority(ctx, tx, actor, ids[0]); err != nil {
		return nil, err
	}
	if err := lockSocialSet(ctx, tx, actor.OrganizationID, ids[1]); err != nil {
		return nil, err
	}
	if err := NewConfiguration(tx.Client()).authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	source, err := visibleSocialSet(ctx, tx.Client(), actor, sourceID)
	if err != nil {
		return nil, err
	}
	destination, err := visibleSocialSet(ctx, tx.Client(), actor, destinationID)
	if err != nil {
		return nil, err
	}
	if source.Visibility != destination.Visibility || source.Visibility == socialset.VisibilityPRIVATE &&
		(source.OwnerUserID == nil || destination.OwnerUserID == nil || *source.OwnerUserID != *destination.OwnerUserID) {
		return nil, conflict("Move accounts only between profiles with the same visibility and owner.")
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM channel_connection WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, connectionID, actor.OrganizationID); err != nil {
		return nil, err
	}
	connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(connectionID), channelconnection.OrganizationID(actor.OrganizationID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE), channelconnection.SocialSetIDIn(sourceID, destinationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("That connected account is no longer in this profile.")
	}
	if err != nil {
		return nil, err
	}
	if *connection.SocialSetID == destinationID {
		// A repeated confirmation does not move or audit the account twice.
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return c.socialSetRecord(ctx, actor, destination)
	}
	taken, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID), channelconnection.SocialSetID(destinationID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE), channelconnection.PlatformIn(socialplatform.Aliases(connection.Platform)...)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if taken {
		return nil, conflict("The destination profile already has an account on this platform.")
	}
	var busy bool
	if err := tx.PlatformQuery(ctx, `SELECT EXISTS (
		SELECT 1 FROM scheduled_post p WHERE p."organizationId"=$1 AND p."channelConnectionId"=$2 AND (
			p.status IN ('DRAFT','SCHEDULED','PROCESSING','UNKNOWN_DELIVERY') OR
			EXISTS (SELECT 1 FROM post_automation_run a WHERE a."scheduledPostId"=p.id AND (a.status='pending' OR a."failureCode"='UNKNOWN_DELIVERY')) OR
			EXISTS (SELECT 1 FROM post_deletion d WHERE d."scheduledPostId"=p.id AND d.status='pending')
		))`, []any{actor.OrganizationID, connectionID}, func(row entsql.ColumnScanner) error { return row.Scan(&busy) }); err != nil {
		return nil, err
	}
	if busy {
		return nil, conflict("Finish or cancel this account's queued posts and follow-ups, and reconcile uncertain deliveries, before moving it.")
	}
	if _, err := tx.ChannelConnection.UpdateOneID(connectionID).SetSocialSetID(destinationID).Save(ctx); err != nil {
		if ent.IsConstraintError(err) {
			return nil, conflict("The destination profile already has an account on this platform.")
		}
		return nil, err
	}
	if err := dropAccountFromSetDefaults(ctx, tx, connection, source); err != nil {
		return nil, err
	}
	if err := addAccountToSetDefaults(ctx, tx, connection, destination); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_account_moved", "channel_connection", connectionID,
		map[string]any{"sourceSocialSetId": sourceID, "destinationSocialSetId": destinationID}); err != nil {
		return nil, err
	}
	saved, err := tx.SocialSet.Get(ctx, destinationID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, saved)
}
