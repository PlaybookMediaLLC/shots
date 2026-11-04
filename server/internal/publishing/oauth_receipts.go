package publishing

import (
	"context"
	"errors"
	"regexp"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
)

var ErrOAuthExchangeUncertain = errors.New("authorization is already being processed or its result is unknown; check the connection before starting a new authorization")
var ErrOAuthIdentityMismatch = errors.New("the authorized account is not the account being reconnected; choose the original account and try again")
var oauthReturnPath = regexp.MustCompile(`^/(?:settings/publishing-brands|publish)/[a-z0-9]{10,32}$`)

// OAuthStartOptions binds the intended account and navigation to one attempt.
type OAuthStartOptions struct {
	SocialSetID          *string
	ExpectedConnectionID *string
	ReturnPath           string
	Operation            string
	CreationVisibility   string
}

// OAuthContext contains only safe routing information for an authenticated callback.
type OAuthContext struct {
	OrganizationID string  `json:"organizationId"`
	SocialSetID    *string `json:"socialSetId"`
	ReturnPath     string  `json:"returnPath"`
	Operation      string  `json:"operation"`
	Completed      bool    `json:"completed"`
}

// ResolveOAuthContext ignores the selected workspace, not the authenticated
// person. Every subsequent request rechecks access to this original workspace.
func (r *Repository) ResolveOAuthContext(ctx context.Context, userID, sessionID, state, provider string) (*OAuthContext, error) {
	start, err := r.client.SocialOAuthStart.Query().Where(socialoauthstart.ID(state), socialoauthstart.UserID(userID),
		socialoauthstart.SessionID(sessionID), socialoauthstart.Provider(provider)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	actor := Actor{Organization: start.OrganizationID, UserID: userID, Type: "USER"}
	if _, err := r.OAuthStart(ctx, actor, sessionID, state, provider, nil); err != nil {
		return nil, err
	}
	path := start.ReturnPath
	if start.CreatedSocialSetID != nil {
		path = "/settings/publishing-brands/" + *start.CreatedSocialSetID
	}
	return &OAuthContext{OrganizationID: start.OrganizationID, SocialSetID: oauthTargetSet(start), ReturnPath: path,
		Operation: string(start.Operation), Completed: start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED}, nil
}

func oauthTargetSet(start *ent.SocialOAuthStart) *string {
	if start.Operation == socialoauthstart.OperationCREATE_SET {
		return start.CreatedSocialSetID
	}
	return start.SocialSetID
}

func authorizeOAuthTarget(ctx context.Context, client *ent.Client, actor Actor, setID *string) error {
	if setID == nil {
		return nil
	}
	set, err := client.SocialSet.Query().Where(socialset.ID(*setID), socialset.OrganizationID(actor.Organization), socialset.DeletedAtIsNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if set.Visibility == socialset.VisibilityPRIVATE && (set.OwnerUserID == nil || *set.OwnerUserID != actor.UserID) {
		return ErrNotFound
	}
	return nil
}

func (r *Repository) authorizeOAuth(ctx context.Context, actor Actor, sessionID string) error {
	if _, err := r.AuthorizeSession(ctx, actor.UserID, sessionID); err != nil {
		return err
	}
	allowed, err := r.client.Member.Query().Where(member.OrganizationID(actor.Organization), member.UserID(actor.UserID), member.RoleIn("owner", "admin")).Exist(ctx)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	return r.requireOperational(ctx, actor.Organization)
}

// Hold the session and membership through commitment; serialize account
// changes in this workspace. A workspace switch does not change the target.
func lockOAuthAuthority(ctx context.Context, tx *ent.Tx, actor Actor, sessionID string) error {
	found := false
	err := tx.PlatformQuery(ctx, `SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId"
        JOIN member m ON m."userId"=u.id AND m."organizationId"=$1
        JOIN organization o ON o.id=m."organizationId"
        WHERE s.id=$2 AND s."userId"=$3 AND s."expiresAt">$4 AND coalesce(u.banned,false)=false
        AND m.role IN ('owner','admin')
        AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=o.id AND d.status<>'CANCELLED')
        FOR UPDATE OF o FOR SHARE OF s,u,m`, []any{actor.Organization, sessionID, actor.UserID, time.Now().UTC()}, func(row entsql.ColumnScanner) error {
		var id string
		if err := row.Scan(&id); err != nil {
			return err
		}
		found = true
		return nil
	})
	if err != nil {
		return err
	}
	if !found {
		return ErrForbidden
	}
	return nil
}

func lockOAuthStart(ctx context.Context, tx *ent.Tx, actor Actor, sessionID, state, provider string) (*ent.SocialOAuthStart, error) {
	if err := lockOAuthAuthority(ctx, tx, actor, sessionID); err != nil {
		return nil, err
	}
	var found bool
	err := tx.PlatformQuery(ctx, `SELECT state FROM social_oauth_start WHERE state=$1 AND "organizationId"=$2 AND "userId"=$3 AND "sessionId"=$4 AND provider=$5 FOR UPDATE`,
		[]any{state, actor.Organization, actor.UserID, sessionID, provider}, func(row entsql.ColumnScanner) error {
			var id string
			if err := row.Scan(&id); err != nil {
				return err
			}
			found = true
			return nil
		})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrNotFound
	}
	start, err := tx.SocialOAuthStart.Get(ctx, state)
	if err != nil {
		return nil, err
	}
	if !oauthAttemptCurrent(start) {
		return nil, ErrNotFound
	}
	setID := oauthTargetSet(start)
	if setID != nil {
		// Settings edits and ownership changes take the same row lock.
		if err := tx.PlatformQuery(ctx, `SELECT id FROM social_set WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, []any{*setID, actor.Organization}, func(row entsql.ColumnScanner) error { var id string; return row.Scan(&id) }); err != nil {
			return nil, err
		}
	}
	if err := authorizeOAuthTarget(ctx, tx.Client(), actor, setID); err != nil {
		return nil, err
	}
	if start.Operation == socialoauthstart.OperationCREATE_SET {
		if err := authorizeOAuthCreation(ctx, tx.Client(), actor); err != nil {
			return nil, err
		}
	}
	return start, nil
}

func oauthAttemptCurrent(start *ent.SocialOAuthStart) bool {
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED {
		return start.CompletedAt != nil && start.CompletedAt.After(time.Now().UTC().Add(-24*time.Hour))
	}
	return start.ExpiresAt.After(time.Now().UTC())
}

// ClaimOAuthExchange allows exactly one external code exchange. A crash or
// ambiguous provider error leaves EXCHANGING, which must never be auto-retried.
func (r *Repository) ClaimOAuthExchange(ctx context.Context, actor Actor, sessionID, state, provider string) (*schema.SocialOAuthExchange, error) {
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	start, err := lockOAuthStart(ctx, tx, actor, sessionID, state, provider)
	if err != nil {
		return nil, err
	}
	switch start.ExchangeStatus {
	case socialoauthstart.ExchangeStatusEXCHANGED, socialoauthstart.ExchangeStatusCOMPLETED:
		if start.ExchangeReceipt.ID == "" {
			return nil, ErrConflict
		}
		receipt := start.ExchangeReceipt
		receipt.Completed = start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED
		return &receipt, tx.Commit()
	case socialoauthstart.ExchangeStatusEXCHANGING:
		return nil, ErrOAuthExchangeUncertain
	}
	if err := tx.SocialOAuthStart.UpdateOneID(state).SetExchangeStatus(socialoauthstart.ExchangeStatusEXCHANGING).Exec(ctx); err != nil {
		return nil, err
	}
	return nil, tx.Commit()
}

// SaveOAuthExchange stores safe identity evidence before the product connection
// is changed. The callback's next request can recover this result after a crash.
func (r *Repository) SaveOAuthExchange(ctx context.Context, actor Actor, sessionID, state, provider string, result schema.SocialOAuthExchange) error {
	result.Completed = false
	if result.ID == "" || len(result.ID) > 160 || len(result.Pages) > 500 {
		return ErrConflict
	}
	if (provider == "bluesky" || provider == "x" || result.Account != nil) && result.Account.Validate(provider, result.ID) != nil {
		return ErrConflict
	}
	for _, page := range result.Pages {
		if page.ID == "" || len(page.ID) > 160 || page.PageID == "" || len(page.PageID) > 160 || (page.Name != nil && len(*page.Name) > 500) {
			return ErrConflict
		}
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	start, err := lockOAuthStart(ctx, tx, actor, sessionID, state, provider)
	if err != nil {
		return err
	}
	if start.ExchangeStatus != socialoauthstart.ExchangeStatusEXCHANGING {
		return ErrConflict
	}
	if start.ExpectedConnectionID != nil {
		expected, err := tx.ChannelConnection.Query().Where(channelconnection.ID(*start.ExpectedConnectionID), channelconnection.OrganizationID(actor.Organization)).Only(ctx)
		if err != nil {
			return err
		}
		if expected.ExternalAccountID != result.ID || expected.Platform != provider {
			return ErrOAuthIdentityMismatch
		}
	}
	if err := tx.SocialOAuthStart.UpdateOneID(state).SetExchangeReceipt(result).SetExchangeStatus(socialoauthstart.ExchangeStatusEXCHANGED).Exec(ctx); err != nil {
		return err
	}
	return tx.Commit()
}
