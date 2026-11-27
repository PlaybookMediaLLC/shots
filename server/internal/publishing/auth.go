package publishing

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/supportaccessgrant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
)

// AuthorizePublishing verifies the web session and role against Ent. Headers
// from the web tier provide identifiers, but do not establish authorization.
func (r *Repository) AuthorizePublishing(ctx context.Context, organizationID, userID, sessionID string) error {
	return r.AuthorizeRole(ctx, organizationID, userID, sessionID, "owner", "admin", "publisher")
}

// AuthorizeConnections reserves account administration for owners and admins.
func (r *Repository) AuthorizeConnections(ctx context.Context, organizationID, userID, sessionID string) error {
	return r.AuthorizeRole(ctx, organizationID, userID, sessionID, "owner", "admin")
}

type recordAuthorizationKey struct{}
type replayAuthorizationKey struct{}

// AuthorizationMemo carries the role, session, API key or support grant a
// middleware's check read to later checks on the same ent.Client, avoiding
// repeated session, user, membership, API-key and workspace-deletion queries.
type AuthorizationMemo struct {
	last    atomic.Pointer[authorizedRole]
	session atomic.Pointer[authorizedSession]
	apiKey  atomic.Pointer[authorizedAPIKey]
	support atomic.Pointer[authorizedSupportGrant]
}

// authorizedRole is an actor AuthorizeRole admitted, and the client it read with.
type authorizedRole struct {
	client                                  *ent.Client
	organizationID, userID, sessionID, role string
}

// authorizedSession is a session AuthorizeSession admitted, and the client it read with.
type authorizedSession struct {
	client            *ent.Client
	userID, sessionID string
	current           *ent.Session
}

type authorizedAPIKey struct {
	client                *ent.Client
	organizationID, keyID string
	key                   *ent.Apikey
}

type authorizedSupportGrant struct {
	client                          *ent.Client
	organizationID, userID, grantID string
	expiresAt                       time.Time
}

// startedRunKey marks work a person already authorized when they started it.
type startedRunKey struct{}

// ForStartedRun is for background work a person started from a real session. It
// may finish after they sign out or move to another workspace, as a post they
// queued would, so AuthorizeRole under ctx asks for neither. Every other check
// still applies each time: the account exists and is not banned, and it holds the
// role in a workspace that is not being deleted.
func ForStartedRun(ctx context.Context) context.Context {
	return context.WithValue(ctx, startedRunKey{}, true)
}

// delegatedSessionKey marks a session acting through an OAuth client whose live grant was checked.
type delegatedSessionKey struct{}

// ForDelegatedSession is for an OAuth client, such as Founder Hub, acting for a
// person's live session after the caller verified the client's grant. The client
// names its workspace on each request, so AuthorizeRole under ctx does not hold
// it to the browser's active workspace. Every other check still applies: the
// session is live, the account is active, and it holds the role in a workspace
// that is not being deleted.
func ForDelegatedSession(ctx context.Context) context.Context {
	return context.WithValue(ctx, delegatedSessionKey{}, true)
}

// IsDelegatedSession reports whether ctx is marked by ForDelegatedSession.
func IsDelegatedSession(ctx context.Context) bool {
	delegated, _ := ctx.Value(delegatedSessionKey{}).(bool)
	return delegated
}

// RecordAuthorization keeps what AuthorizeRole or AuthorizeSession admits
// under ctx in memo.
func RecordAuthorization(ctx context.Context, memo *AuthorizationMemo) context.Context {
	return context.WithValue(ctx, recordAuthorizationKey{}, memo)
}

// ReplayAuthorization lets the first AuthorizeRole, and the first
// AuthorizeSession, under ctx reuse memo for the same actor and client. Every
// later check reads again, so a change the handler makes is always seen, and a
// transaction's repository has its own client, so a check under a row lock
// reads again too.
func ReplayAuthorization(ctx context.Context, memo *AuthorizationMemo) context.Context {
	return context.WithValue(ctx, replayAuthorizationKey{}, memo)
}

// AuthorizeRole rechecks the session, active workspace, membership, and
// deletion state in the backend. A forwarded role header is never trusted.
func (r *Repository) AuthorizeRole(ctx context.Context, organizationID, userID, sessionID string, allowedRoles ...string) error {
	_, err := r.AuthorizedRole(ctx, organizationID, userID, sessionID, allowedRoles...)
	return err
}

// AuthorizedRole is AuthorizeRole, returning the member's stored role.
func (r *Repository) AuthorizedRole(ctx context.Context, organizationID, userID, sessionID string, allowedRoles ...string) (string, error) {
	startedRun, _ := ctx.Value(startedRunKey{}).(bool)
	if organizationID == "" || userID == "" || (sessionID == "" && !startedRun) {
		return "", ErrUnauthorized
	}
	if memo, _ := ctx.Value(replayAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		last := memo.last.Swap(nil)
		if last != nil && last.client == r.client && last.organizationID == organizationID &&
			last.userID == userID && last.sessionID == sessionID {
			if !workspaceroles.Allows(last.role, allowedRoles...) {
				return "", ErrForbidden
			}
			return last.role, nil
		}
	}
	if startedRun {
		if err := r.requireActivePerson(ctx, userID); err != nil {
			return "", err
		}
	} else {
		// One query admits the usual request. A refusal falls through to the
		// reads below, so it returns the error each check returns on its own.
		role, admitted, err := r.admittedRole(ctx, organizationID, userID, sessionID)
		if err != nil {
			return "", err
		}
		if admitted {
			if !workspaceroles.Allows(role, allowedRoles...) {
				return "", ErrForbidden
			}
			r.recordRole(ctx, organizationID, userID, sessionID, role)
			return role, nil
		}
		current, err := r.authorizeSession(ctx, userID, sessionID)
		if err != nil {
			return "", err
		}
		if current.ActiveOrganizationID != nil && *current.ActiveOrganizationID != organizationID && !IsDelegatedSession(ctx) {
			return "", ErrForbidden
		}
	}
	participants, err := r.client.Member.Query().Where(
		member.OrganizationID(organizationID), member.UserID(userID),
	).All(ctx)
	if err != nil {
		return "", err
	}
	if len(participants) != 1 {
		return "", ErrForbidden
	}
	role := participants[0].Role
	if !workspaceroles.Allows(role, allowedRoles...) {
		return "", ErrForbidden
	}
	if err := r.requireOperational(ctx, organizationID); err != nil {
		return "", err
	}
	r.recordRole(ctx, organizationID, userID, sessionID, role)
	return role, nil
}

// admittedRole reads in one query what AuthorizedRole checks for a session:
// a live session of an active account, an active workspace that is this one
// or none (any, for a delegated session), exactly one membership, and no
// deletion in progress. It returns the role, or false when any check refuses.
func (r *Repository) admittedRole(ctx context.Context, organizationID, userID, sessionID string) (string, bool, error) {
	var roles []string
	err := r.client.PlatformQuery(ctx, `SELECT m.role FROM session s JOIN "user" u ON u.id=s."userId"
        JOIN member m ON m."userId"=u.id AND m."organizationId"=$1
        WHERE s.id=$2 AND s."userId"=$3 AND s."expiresAt">$4 AND coalesce(u.banned,false)=false
        AND ($5::boolean OR s."activeOrganizationId" IS NULL OR s."activeOrganizationId"=$1)
        AND NOT EXISTS (SELECT 1 FROM workspace_deletion d WHERE d."organizationId"=$1 AND d.status<>'CANCELLED')`,
		[]any{organizationID, sessionID, userID, time.Now().UTC(), IsDelegatedSession(ctx)}, func(row entsql.ColumnScanner) error {
			var role string
			if err := row.Scan(&role); err != nil {
				return err
			}
			roles = append(roles, role)
			return nil
		})
	if err != nil || len(roles) != 1 {
		return "", false, err
	}
	return roles[0], true, nil
}

// recordRole keeps an admitted role for the handler's first check.
func (r *Repository) recordRole(ctx context.Context, organizationID, userID, sessionID, role string) {
	if memo, _ := ctx.Value(recordAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		memo.last.Store(&authorizedRole{r.client, organizationID, userID, sessionID, role})
	}
}

// requireOperational rejects a workspace that is scheduled for deletion.
func (r *Repository) requireOperational(ctx context.Context, organizationID string) error {
	deletion, err := r.client.WorkspaceDeletion.Query().Where(
		workspacedeletion.OrganizationID(organizationID),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if deletion != nil && deletion.Status != workspacedeletion.StatusCANCELLED {
		return ErrForbidden
	}
	return nil
}

// AuthorizeSession validates a user session without requiring an active
// workspace. Workspace creation and switching use this entry point. Its first
// call under ReplayAuthorization can return the middleware's session unread.
func (r *Repository) AuthorizeSession(ctx context.Context, userID, sessionID string) (*ent.Session, error) {
	if memo, _ := ctx.Value(replayAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		last := memo.session.Swap(nil)
		if last != nil && last.client == r.client && last.userID == userID && last.sessionID == sessionID {
			return last.current, nil
		}
	}
	current, err := r.authorizeSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if memo, _ := ctx.Value(recordAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		memo.session.Store(&authorizedSession{r.client, userID, sessionID, current})
	}
	return current, nil
}

// authorizeSession reads the session and its account. AuthorizedRole calls it
// directly, so a role check never records or replays a session check.
func (r *Repository) authorizeSession(ctx context.Context, userID, sessionID string) (*ent.Session, error) {
	if userID == "" || sessionID == "" {
		return nil, ErrUnauthorized
	}
	now := time.Now().UTC()
	// One query admits a live session of an active account. A refusal reads
	// again step by step below, so it returns the same error as before.
	activeAccount := predicate.Session(func(s *entsql.Selector) {
		s.Where(entsql.ExprP(`EXISTS (SELECT 1 FROM "user" u WHERE u.id=` + s.C(session.FieldUserID) + ` AND coalesce(u.banned,false)=false)`))
	})
	current, err := r.client.Session.Query().Where(
		session.ID(sessionID), session.UserID(userID), session.ExpiresAtGT(now), activeAccount,
	).Only(ctx)
	if err == nil || !ent.IsNotFound(err) {
		return current, err
	}
	current, err = r.client.Session.Query().Where(
		session.ID(sessionID), session.UserID(userID), session.ExpiresAtGT(now),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if err := r.requireActivePerson(ctx, userID); err != nil {
		return nil, err
	}
	return current, nil
}

// requireActivePerson rejects an account that is gone or banned.
func (r *Repository) requireActivePerson(ctx context.Context, userID string) error {
	person, err := r.client.User.Query().Where(user.ID(userID)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrUnauthorized
	}
	if err != nil {
		return err
	}
	if person.Banned != nil && *person.Banned {
		return ErrForbidden
	}
	return nil
}

// AuthorizeWorkspace admits a service caller acting for an existing,
// operational workspace. The web facade authenticated the caller with a
// webhook signature, render token, or job identity before forwarding it.
func (r *Repository) AuthorizeWorkspace(ctx context.Context, organizationID string) error {
	if organizationID == "" {
		return ErrUnauthorized
	}
	exists, err := r.client.Organization.Query().Where(organization.ID(organizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return r.requireOperational(ctx, organizationID)
}

// AuthorizeAPIKey rechecks that an organization API key is still enabled,
// unexpired, and issued for this workspace. The facade checked its scope.
func (r *Repository) AuthorizeAPIKey(ctx context.Context, organizationID, keyID string) error {
	_, err := r.apiKey(ctx, organizationID, keyID)
	return err
}

// AuthorizeAPIKeyScope also requires the key to hold scope, read from Better
// Auth's {"resource": ["action"]} permissions. Scheduling uses it so the
// backend checks the scope itself rather than trust the facade (RFC 026).
func (r *Repository) AuthorizeAPIKeyScope(ctx context.Context, organizationID, keyID, scope string) error {
	key, err := r.apiKey(ctx, organizationID, keyID)
	if err != nil {
		return err
	}
	var permissions map[string][]string
	if key.Permissions != nil {
		_ = json.Unmarshal([]byte(*key.Permissions), &permissions)
	}
	resource, action, _ := strings.Cut(scope, ":")
	if !slices.Contains(permissions[resource], action) {
		return ErrForbidden
	}
	return nil
}

// AuthorizeVerifiedAPIKey validates an already-loaded API key row's enabled,
// expiry, and workspace operational state once and records it in the request's
// AuthorizationMemo when present.
func (r *Repository) AuthorizeVerifiedAPIKey(ctx context.Context, key *ent.Apikey) error {
	if key == nil || key.ReferenceID == "" || key.ID == "" {
		return ErrUnauthorized
	}
	if (key.Enabled != nil && !*key.Enabled) || (key.ExpiresAt != nil && !key.ExpiresAt.After(time.Now().UTC())) {
		return ErrUnauthorized
	}
	if err := r.requireOperational(ctx, key.ReferenceID); err != nil {
		return err
	}
	if memo, _ := ctx.Value(recordAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		memo.apiKey.Store(&authorizedAPIKey{
			client:         r.client,
			organizationID: key.ReferenceID,
			keyID:          key.ID,
			key:            key,
		})
	}
	return nil
}

func (r *Repository) apiKey(ctx context.Context, organizationID, keyID string) (*ent.Apikey, error) {
	if organizationID == "" || keyID == "" {
		return nil, ErrUnauthorized
	}
	if memo, _ := ctx.Value(replayAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		if last := memo.apiKey.Swap(nil); last != nil && last.client == r.client &&
			last.organizationID == organizationID && last.keyID == keyID {
			if last.key.ExpiresAt != nil && !last.key.ExpiresAt.After(time.Now().UTC()) {
				return nil, ErrUnauthorized
			}
			return last.key, nil
		}
	}
	key, err := r.client.Apikey.Query().Where(apikey.ID(keyID), apikey.ReferenceID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if err := r.AuthorizeVerifiedAPIKey(ctx, key); err != nil {
		return nil, err
	}
	return key, nil
}

// AuthorizeSupportGrant rechecks a time-bound support grant for its user.
func (r *Repository) AuthorizeSupportGrant(ctx context.Context, organizationID, userID, grantID string) error {
	if organizationID == "" || userID == "" || grantID == "" {
		return ErrUnauthorized
	}
	now := time.Now().UTC()
	if memo, _ := ctx.Value(replayAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		if last := memo.support.Swap(nil); last != nil && last.client == r.client &&
			last.organizationID == organizationID && last.userID == userID && last.grantID == grantID {
			if !last.expiresAt.After(now) {
				return ErrForbidden
			}
			return nil
		}
	}
	grant, err := r.client.SupportAccessGrant.Query().Where(
		supportaccessgrant.ID(grantID), supportaccessgrant.OrganizationID(organizationID),
		supportaccessgrant.UserID(userID), supportaccessgrant.ExpiresAtGT(now),
		supportaccessgrant.RevokedAtIsNil(),
	).Select(supportaccessgrant.FieldID, supportaccessgrant.FieldExpiresAt).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	if memo, _ := ctx.Value(recordAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		memo.support.Store(&authorizedSupportGrant{
			client:         r.client,
			organizationID: organizationID,
			userID:         userID,
			grantID:        grantID,
			expiresAt:      grant.ExpiresAt,
		})
	}
	return nil
}
