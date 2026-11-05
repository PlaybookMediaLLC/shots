package publishing

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
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

// AuthorizationMemo carries the role a middleware's check read to the
// handler's first check of its own, so that check skips the session, user,
// membership and workspace queries it would repeat.
type AuthorizationMemo struct {
	last atomic.Pointer[authorizedRole]
}

// authorizedRole is an actor AuthorizeRole admitted, and the client it read with.
type authorizedRole struct {
	client                                  *ent.Client
	organizationID, userID, sessionID, role string
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

// RecordAuthorization keeps what AuthorizeRole admits under ctx in memo.
func RecordAuthorization(ctx context.Context, memo *AuthorizationMemo) context.Context {
	return context.WithValue(ctx, recordAuthorizationKey{}, memo)
}

// ReplayAuthorization lets the first AuthorizeRole under ctx reuse memo for
// the same actor and client. Every later check reads again, so a change the
// handler makes is always seen, and a transaction's repository has its own
// client, so a check under a row lock reads again too.
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
		current, err := r.AuthorizeSession(ctx, userID, sessionID)
		if err != nil {
			return "", err
		}
		if current.ActiveOrganizationID != nil && *current.ActiveOrganizationID != organizationID {
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
	if memo, _ := ctx.Value(recordAuthorizationKey{}).(*AuthorizationMemo); memo != nil {
		memo.last.Store(&authorizedRole{r.client, organizationID, userID, sessionID, role})
	}
	return role, nil
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
// workspace. Workspace creation and switching use this entry point.
func (r *Repository) AuthorizeSession(ctx context.Context, userID, sessionID string) (*ent.Session, error) {
	if userID == "" || sessionID == "" {
		return nil, ErrUnauthorized
	}
	now := time.Now().UTC()
	current, err := r.client.Session.Query().Where(
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

func (r *Repository) apiKey(ctx context.Context, organizationID, keyID string) (*ent.Apikey, error) {
	if organizationID == "" || keyID == "" {
		return nil, ErrUnauthorized
	}
	key, err := r.client.Apikey.Query().Where(apikey.ID(keyID), apikey.ReferenceID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if (key.Enabled != nil && !*key.Enabled) || (key.ExpiresAt != nil && !key.ExpiresAt.After(time.Now().UTC())) {
		return nil, ErrUnauthorized
	}
	return key, r.requireOperational(ctx, organizationID)
}

// AuthorizeSupportGrant rechecks a time-bound support grant for its user.
func (r *Repository) AuthorizeSupportGrant(ctx context.Context, organizationID, userID, grantID string) error {
	if organizationID == "" || userID == "" || grantID == "" {
		return ErrUnauthorized
	}
	exists, err := r.client.SupportAccessGrant.Query().Where(
		supportaccessgrant.ID(grantID), supportaccessgrant.OrganizationID(organizationID),
		supportaccessgrant.UserID(userID), supportaccessgrant.ExpiresAtGT(time.Now().UTC()),
		supportaccessgrant.RevokedAtIsNil(),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return ErrForbidden
	}
	return nil
}
