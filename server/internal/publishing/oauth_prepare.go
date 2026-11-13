package publishing

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
)

// PrepareOAuth checks the same authority and intent as commitment before the
// adapter receives any credentials. Reconnect returns the existing adapter ID.
func (r *Repository) PrepareOAuth(ctx context.Context, actor Actor, sessionID, provider string, options OAuthStartOptions) (string, error) {
	if err := r.AuthorizeRole(ctx, actor.Organization, actor.UserID, sessionID, "owner", "admin"); err != nil {
		return "", err
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if err := lockOAuthAuthority(ctx, tx, actor, sessionID); err != nil {
		return "", err
	}
	id, err := validateOAuthIntent(ctx, tx.Client(), actor, provider, options)
	if err != nil {
		return "", err
	}
	return id, tx.Commit()
}

func validateOAuthIntent(ctx context.Context, client *ent.Client, actor Actor, provider string, options OAuthStartOptions) (string, error) {
	if err := ValidateOAuthStartOptions(options); err != nil {
		return "", err
	}
	if options.ReturnPath != "" && !oauthReturnPath.MatchString(options.ReturnPath) {
		return "", ErrConflict
	}
	if err := authorizeOAuthTarget(ctx, client, actor, options.SocialSetID); err != nil {
		return "", err
	}
	if oauthOperation(options) == socialoauthstart.OperationCREATE_SET {
		if err := authorizeOAuthCreation(ctx, client, actor); err != nil {
			return "", err
		}
		if err := workspaceplan.RequireChannel(ctx, client, actor.Organization, ""); err != nil {
			return "", err
		}
	}
	if options.ExpectedConnectionID == nil {
		return "", nil
	}
	connection, err := client.ChannelConnection.Query().Where(channelconnection.ID(*options.ExpectedConnectionID), channelconnection.OrganizationID(actor.Organization)).Only(ctx)
	if ent.IsNotFound(err) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if connection.Provider != "social" || socialplatform.Adapter(connection.Platform) != provider || connection.SocialSetID == nil || options.SocialSetID == nil || *connection.SocialSetID != *options.SocialSetID {
		return "", ErrConflict
	}
	return connection.ExternalAccountID, nil
}
