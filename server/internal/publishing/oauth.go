package publishing

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/lucsky/cuid"
)

const oauthLifetime = time.Hour

// StartOAuth records an authorization attempt and its immutable target.
func (r *Repository) StartOAuth(ctx context.Context, actor Actor, sessionID, state, provider, secretReference string, options OAuthStartOptions) error {
	if err := ValidateOAuthStartOptions(options); err != nil {
		return err
	}
	if options.ReturnPath != "" && !oauthReturnPath.MatchString(options.ReturnPath) {
		return ErrConflict
	}
	if err := r.AuthorizeRole(ctx, actor.Organization, actor.UserID, sessionID, "owner", "admin"); err != nil {
		return err
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := lockOAuthAuthority(ctx, tx, actor, sessionID); err != nil {
		return err
	}
	if _, err := validateOAuthIntent(ctx, tx.Client(), actor, provider, options); err != nil {
		return err
	}
	operation := oauthOperation(options)
	_, err = tx.SocialOAuthStart.Create().
		SetID(state).SetOrganizationID(actor.Organization).SetUserID(actor.UserID).SetSessionID(sessionID).
		SetProvider(provider).SetSecretReference(secretReference).SetNillableSocialSetID(options.SocialSetID).
		SetOperation(operation).SetCreationVisibility(options.CreationVisibility).
		SetNillableExpectedConnectionID(options.ExpectedConnectionID).SetReturnPath(options.ReturnPath).
		SetExpiresAt(time.Now().UTC().Add(oauthLifetime)).Save(ctx)
	if ent.IsConstraintError(err) {
		return ErrConflict
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repository) OAuthStart(ctx context.Context, actor Actor, sessionID, state, provider string, integrationID *string) (*ent.SocialOAuthStart, error) {
	if err := r.authorizeOAuth(ctx, actor, sessionID); err != nil {
		return nil, err
	}
	query := r.client.SocialOAuthStart.Query().Where(
		socialoauthstart.ID(state),
		socialoauthstart.OrganizationID(actor.Organization),
		socialoauthstart.UserID(actor.UserID),
		socialoauthstart.SessionID(sessionID),
		socialoauthstart.Provider(provider),
	)
	if integrationID != nil {
		query.Where(socialoauthstart.IntegrationID(*integrationID))
	}
	start, err := query.Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !oauthAttemptCurrent(start) {
		return nil, ErrNotFound
	}
	if err := authorizeOAuthTarget(ctx, r.client, actor, oauthTargetSet(start)); err != nil {
		return nil, err
	}
	if start.Operation == socialoauthstart.OperationCREATE_SET {
		if err := authorizeOAuthCreation(ctx, r.client, actor); err != nil {
			return nil, err
		}
	}
	return start, nil
}

func (r *Repository) RememberInstagramIntegration(ctx context.Context, actor Actor, sessionID, state, integrationID string, providers ...string) error {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	provider := "instagram"
	if len(providers) > 0 {
		provider = providers[0]
	}
	if !socialidentity.RequiresPageSelection(provider) {
		return ErrConflict
	}
	start, err := lockOAuthStart(ctx, tx, actor, sessionID, state, provider)
	if err != nil {
		return err
	}
	if start.ExchangeReceipt.ID != integrationID || (start.IntegrationID != nil && *start.IntegrationID != integrationID) {
		return ErrConflict
	}
	if err := tx.SocialOAuthStart.UpdateOneID(state).SetIntegrationID(integrationID).Exec(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

// FinishOAuth commits the connection and its replay receipt together.
// The caller verifies the remote integration before entering this transaction.
func (r *Repository) FinishOAuth(ctx context.Context, actor Actor, sessionID, state, provider, integrationID string) (*ent.ChannelConnection, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	start, err := lockOAuthStart(ctx, tx, actor, sessionID, state, provider)
	if err != nil {
		return nil, err
	}
	if start.ExchangeReceipt.ID != integrationID || (socialidentity.RequiresPageSelection(provider) && (start.IntegrationID == nil || *start.IntegrationID != integrationID)) {
		return nil, ErrConflict
	}
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED {
		if start.CompletedConnectionID == nil {
			return nil, ErrConflict
		}
		connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(*start.CompletedConnectionID), channelconnection.OrganizationID(actor.Organization),
			channelconnection.ExternalAccountID(integrationID), channelconnection.Platform(provider), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, ErrConflict
		}
		if err != nil {
			return nil, err
		}
		if target := oauthTargetSet(start); target != nil && (connection.SocialSetID == nil || *connection.SocialSetID != *target) {
			return nil, ErrConflict
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return connection.Unwrap(), nil
	}
	if start.ExchangeStatus != socialoauthstart.ExchangeStatusEXCHANGED {
		return nil, ErrOAuthExchangeUncertain
	}
	if (provider == "bluesky" || provider == "x") && start.ExchangeReceipt.Account.Validate(provider, integrationID) != nil {
		return nil, ErrConflict
	}
	if err := workspaceplan.RequireChannel(ctx, tx.Client(), actor.Organization, integrationID); err != nil {
		return nil, err
	}
	connection, err := tx.ChannelConnection.Query().Where(
		channelconnection.OrganizationID(actor.Organization),
		channelconnection.Provider("social"),
		channelconnection.ExternalAccountID(integrationID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		if start.ExpectedConnectionID != nil {
			return nil, ErrOAuthIdentityMismatch
		}
		var setID *string
		if start.Operation == socialoauthstart.OperationCREATE_SET {
			setID, err = createOAuthSocialSet(ctx, tx, actor, start)
		} else {
			setID, err = targetSocialSet(ctx, tx, actor.Organization, provider, start.SocialSetID)
		}
		if err != nil {
			return nil, err
		}
		connection, err = tx.ChannelConnection.Create().
			SetID(cuid.New()).
			SetOrganizationID(actor.Organization).
			SetProvider("social").
			SetExternalAccountID(integrationID).
			SetPlatform(provider).
			SetProviderSettings(map[string]any{}).
			SetSecretReference(start.SecretReference).
			SetStatus(channelconnection.StatusACTIVE).
			SetNillableSocialSetID(setID).
			SetCreatedByUserID(actor.UserID).
			Save(ctx)
		if ent.IsConstraintError(err) {
			return nil, ErrConflict
		}
		if err != nil {
			return nil, err
		}
		if err := enableDefaultPlatform(ctx, tx, setID, provider); err != nil {
			return nil, err
		}
		if err := activity.Emit(ctx, tx, actor.Organization, "integration.connected", "channel_connection", connection.ID, actor.UserID, "connected:"+connection.ID, map[string]any{"ownerUserId": actor.UserID}); err != nil {
			return nil, err
		}
		if err := appendAudit(ctx, tx, auditInput{
			Action: "post.connection_created", Actor: actor, EntityID: connection.ID,
			EntityType: "channel_connection", Organization: actor.Organization, Outcome: auditlog.OutcomeSUCCEEDED,
		}); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	} else if start.Operation == socialoauthstart.OperationCREATE_SET {
		return nil, ErrAccountInAnotherSet
	} else if start.ExpectedConnectionID != nil && connection.ID != *start.ExpectedConnectionID {
		return nil, ErrOAuthIdentityMismatch
	} else if connection.Platform != provider || connection.SecretReference != start.SecretReference {
		return nil, ErrConflict
	} else if connection, err = reconnect(ctx, tx, actor, connection, start.SocialSetID); err != nil {
		return nil, err
	}
	if account := start.ExchangeReceipt.Account; account != nil {
		if account.Validate(provider, integrationID) != nil {
			return nil, ErrConflict
		}
		connection, err = tx.ChannelConnection.UpdateOne(connection).SetDisplayName(account.Name).SetHandle(account.Handle).SetAvatarURL(account.AvatarURL).Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	completed := tx.SocialOAuthStart.UpdateOneID(state).SetExchangeStatus(socialoauthstart.ExchangeStatusCOMPLETED).
		SetCompletedConnectionID(connection.ID).SetCompletedAt(time.Now().UTC())
	if start.Operation == socialoauthstart.OperationCREATE_SET {
		completed.SetNillableCreatedSocialSetID(connection.SocialSetID)
	}
	if err := completed.Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return connection.Unwrap(), nil
}

// reconnect renews an account the workspace already holds. An active account
// stays in its set, and asking to add it to a different set is refused rather
// than silently moving it. A removed account keeps its original set and
// lineage; choosing another set requires an explicit transfer.
func reconnect(ctx context.Context, tx *ent.Tx, actor Actor, connection *ent.ChannelConnection, requested *string) (*ent.ChannelConnection, error) {
	if requested != nil && (connection.SocialSetID == nil || *connection.SocialSetID != *requested) {
		return nil, ErrAccountInAnotherSet
	}
	if err := authorizeOAuthTarget(ctx, tx.Client(), actor, connection.SocialSetID); err != nil {
		return nil, err
	}
	if connection.Status == channelconnection.StatusACTIVE {
		return connection, nil
	}
	setID, err := targetSocialSet(ctx, tx, actor.Organization, connection.Platform, connection.SocialSetID)
	if err != nil {
		return nil, err
	}
	update := tx.ChannelConnection.UpdateOneID(connection.ID).SetStatus(channelconnection.StatusACTIVE)
	if setID == nil {
		update.ClearSocialSetID()
	} else {
		update.SetSocialSetID(*setID)
	}
	restored, err := update.Save(ctx)
	if err != nil {
		if ent.IsConstraintError(err) {
			return nil, ErrSocialSetSlotTaken
		}
		return nil, err
	}
	if err := enableDefaultPlatform(ctx, tx, setID, connection.Platform); err != nil {
		return nil, err
	}
	if err := appendAudit(ctx, tx, auditInput{
		Action: "post.connection_restored", Actor: actor, EntityID: connection.ID,
		EntityType: "channel_connection", Organization: actor.Organization, Outcome: auditlog.OutcomeSUCCEEDED,
	}); err != nil {
		return nil, err
	}
	return restored, nil
}
