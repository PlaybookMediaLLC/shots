package integration

import (
	"context"
	"errors"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// ErrRefreshChanged means a connection changed while refresh was in flight.
// Its result must neither replace newer credentials nor change connection health.
var ErrRefreshChanged = errors.New("the connected account changed during refresh; retry using its current state")

// refreshSnapshot contains only in-process data, never workflow arguments.
type refreshSnapshot struct {
	connection *ent.Integration
	linked     []*ent.Integration
}

func sameOptional[T comparable](a, b *T) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func sameRefreshState(before, current *ent.Integration) bool {
	if before == nil || current == nil || current.DeletedAt != nil || current.Disabled || current.RefreshNeeded || current.InBetweenSteps || current.Token == "" {
		return false
	}
	if before.ID != current.ID || before.OrganizationID != current.OrganizationID || before.ProviderIdentifier != current.ProviderIdentifier ||
		before.InternalID != current.InternalID || before.Token != current.Token || !sameOptional(before.RefreshToken, current.RefreshToken) ||
		!sameOptional(before.CustomInstanceDetails, current.CustomInstanceDetails) || !sameOptional(before.RootInternalID, current.RootInternalID) {
		return false
	}
	if before.UpdatedAt == nil || current.UpdatedAt == nil {
		return before.UpdatedAt == nil && current.UpdatedAt == nil
	}
	return before.UpdatedAt.Equal(*current.UpdatedAt)
}

// lockRefresh takes the account's refresh lock until unlock: a rotating refresh
// token spent twice can revoke the account, and the version check only stops
// the second write, not the second provider call. Linked accounts share their
// root's lock. The lock is held by an otherwise idle transaction; a refresh
// already holding it answers ErrRefreshChanged.
func (r *Repository) lockRefresh(ctx context.Context, account *ent.Integration) (unlock func(), err error) {
	root := account.InternalID
	if account.RootInternalID != nil && *account.RootInternalID != "" {
		root = *account.RootInternalID
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	locked := false
	rows, err := tx.QueryContext(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`,
		"social-refresh:"+account.OrganizationID+":"+account.ProviderIdentifier+":"+root)
	if err == nil {
		if rows.Next() {
			err = rows.Scan(&locked)
		}
		if err == nil {
			err = rows.Err()
		}
		_ = rows.Close()
	}
	if err != nil || !locked {
		_ = tx.Rollback()
		if err == nil {
			err = ErrRefreshChanged
		}
		return nil, err
	}
	return func() { _ = tx.Rollback() }, nil
}

// prepareRefresh checks authority before the remote call and remembers the
// versions of linked accounts. Row locks are never held over provider HTTP;
// only lockRefresh's advisory lock is.
func (r *Repository) prepareRefresh(ctx context.Context, before *ent.Integration, linked bool) (*refreshSnapshot, error) {
	if before == nil {
		return nil, ErrRefreshChanged
	}
	current, err := r.GetIntegrationByID(ctx, before.OrganizationID, before.ID)
	if err != nil {
		return nil, err
	}
	if !sameRefreshState(before, current) {
		return nil, ErrRefreshChanged
	}
	active, err := current.QueryOrganization().Where(organization.DeletedAtIsNil()).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, ErrRefreshChanged
	}
	snapshot := &refreshSnapshot{connection: current}
	if linked {
		root := current.InternalID
		if current.RootInternalID != nil && *current.RootInternalID != "" {
			root = *current.RootInternalID
		}
		snapshot.linked, err = r.client.Integration.Query().Where(
			integration.OrganizationID(current.OrganizationID), integration.ProviderIdentifier(current.ProviderIdentifier),
			integration.RootInternalID(root), integration.IDNEQ(current.ID), integration.DeletedAtIsNil(),
			integration.Disabled(false), integration.RefreshNeeded(false), integration.InBetweenSteps(false),
		).Order(ent.Asc(integration.FieldID)).All(ctx)
	}
	return snapshot, err
}

// withCurrentRefresh serializes completion with account/workspace mutations.
// Version and decoded credential comparisons work with randomized encryption;
// querying equality against the encrypted token column would not.
func (r *Repository) withCurrentRefresh(ctx context.Context, before *ent.Integration, change func(*ent.Tx, *ent.Integration) error) error {
	if before == nil {
		return ErrRefreshChanged
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Organization.Query().Where(organization.ID(before.OrganizationID), organization.DeletedAtIsNil()).ForUpdate().Only(ctx)
	if ent.IsNotFound(err) {
		return ErrRefreshChanged
	}
	if err != nil {
		return err
	}
	current, err := tx.Integration.Query().Where(integration.ID(before.ID), integration.OrganizationID(before.OrganizationID)).ForUpdate().Only(ctx)
	if ent.IsNotFound(err) {
		return ErrRefreshChanged
	}
	if err != nil {
		return err
	}
	if !sameRefreshState(before, current) {
		return ErrRefreshChanged
	}
	if err := change(tx, current); err != nil {
		return err
	}
	return tx.Commit()
}

func applyRefresh(update *ent.IntegrationUpdateOne, auth *integrations.AuthTokenDetails) *ent.IntegrationUpdateOne {
	update.SetToken(auth.AccessToken)
	if auth.RefreshToken != "" {
		update.SetRefreshToken(&auth.RefreshToken)
	}
	if auth.NonExpiring {
		update.ClearTokenExpiration()
	} else if auth.ExpiresIn > 0 {
		update.SetTokenExpiration(time.Now().Add(time.Duration(auth.ExpiresIn) * time.Second))
	}
	return update
}

func (r *Repository) saveRefresh(ctx context.Context, snapshot *refreshSnapshot, auth *integrations.AuthTokenDetails) error {
	if auth.Verification != nil {
		if err := auth.Verification.Validate(snapshot.connection.ProviderIdentifier, snapshot.connection.InternalID); err != nil {
			return err
		}
	}
	return r.withCurrentRefresh(ctx, snapshot.connection, func(tx *ent.Tx, current *ent.Integration) error {
		update := applyRefresh(tx.Integration.UpdateOne(current), auth)
		if auth.Verification != nil {
			update.SetVerifiedAccountKey(auth.Verification.AccountKey).SetVerifiedAccountKind(auth.Verification.AccountKind).
				SetVerifiedScopes(auth.Verification.GrantedScopes).SetVerifiedCapabilities(&auth.Verification.Capabilities).SetIdentityVerifiedAt(time.Now().UTC())
		}
		if err := update.Exec(ctx); err != nil {
			return err
		}
		for _, before := range snapshot.linked {
			linked, err := tx.Integration.Query().Where(integration.ID(before.ID), integration.OrganizationID(before.OrganizationID)).ForUpdate().Only(ctx)
			if ent.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			// Removal, reconnection, provider changes and new credentials on a
			// sibling all win over propagation from an earlier refresh.
			if !sameRefreshState(before, linked) {
				continue
			}
			if err := applyRefresh(tx.Integration.UpdateOne(linked), auth).Exec(ctx); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) markRefreshFailure(ctx context.Context, before *ent.Integration, betweenSteps bool) error {
	return r.withCurrentRefresh(ctx, before, func(tx *ent.Tx, current *ent.Integration) error {
		update := tx.Integration.UpdateOne(current)
		if betweenSteps {
			update.SetInBetweenSteps(true)
		} else {
			update.SetRefreshNeeded(true)
		}
		return update.Exec(ctx)
	})
}
