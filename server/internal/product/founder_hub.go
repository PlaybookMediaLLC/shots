package product

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/accountdeletionrequest"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroup"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/permissiongroupmember"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformfounderhubuser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformoauthclient"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformoauthconsent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformoauthrefreshtoken"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
	"github.com/google/uuid"
)

type FounderHubMember struct {
	EmailVerified     bool         `json:"emailVerified"`
	CreatedAt         time.Time    `json:"createdAt"`
	User              *CurrentUser `json:"user"`
	AccountUserID     uuid.UUID    `json:"accountUserId"`
	Role              string       `json:"role"`
	DeniedPermissions []string     `json:"deniedPermissions"`
	Permissions       []string     `json:"permissions"`
}

type FounderHubWorkspace struct {
	OrganizationID    string             `json:"organizationId"`
	WorkspaceID       uuid.UUID          `json:"workspaceId"`
	OwnerUserID       uuid.UUID          `json:"ownerUserId"`
	Name              string             `json:"name"`
	Role              string             `json:"role"`
	DeniedPermissions []string           `json:"deniedPermissions"`
	Permissions       []string           `json:"permissions"`
	Features          map[string]bool    `json:"features"`
	Members           []FounderHubMember `json:"members"`
	Owner             *FounderHubMember  `json:"owner"`
}

type FounderHubProfile struct {
	EmailVerified bool                  `json:"emailVerified"`
	Revision      string                `json:"revision"`
	CreatedAt     time.Time             `json:"createdAt"`
	User          *CurrentUser          `json:"user"`
	AccountUserID uuid.UUID             `json:"accountUserId"`
	Workspaces    []FounderHubWorkspace `json:"workspaces"`
}

type FounderHubSession struct {
	*FounderHubProfile
	SessionID string    `json:"sessionId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type FounderHubAuthorization struct {
	UserID    string    `json:"userId"`
	SessionID string    `json:"sessionId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// Frequent device polls need live grant checks, not every workspace member's identity.
func (c *Configuration) AuthorizeFounderHubSession(ctx context.Context, actor Actor) (*FounderHubAuthorization, error) {
	current, err := c.authorizeFounderHubGrant(ctx, actor, "shots-founder-hub", "")
	if err != nil {
		return nil, err
	}
	return &FounderHubAuthorization{UserID: actor.UserID, SessionID: current.ID, ExpiresAt: current.ExpiresAt}, nil
}

// Founder Hub credentials are usable only while their Shots session and OAuth grant live.
func (c *Configuration) GetFounderHubSession(ctx context.Context, actor Actor) (*FounderHubSession, error) {
	return c.founderHubSession(ctx, actor, "shots-founder-hub", "")
}

// Opaque API keys have no short JWT expiry, so a revoked refresh grant cannot authorize them.
func (c *Configuration) GetFounderHubKeySession(ctx context.Context, actor Actor) (*FounderHubSession, error) {
	return c.founderHubSession(ctx, actor, "shots-founder-hub", "founder-hub")
}

func (c *Configuration) GetFounderHubConnectorSession(ctx context.Context, actor Actor, clientID string) (*FounderHubSession, error) {
	if clientID == "" || clientID == "shots-founder-hub" || len(clientID) > 160 {
		return nil, publishing.ErrUnauthorized
	}
	return c.founderHubSession(ctx, actor, clientID, "founder-hub:meetings:read")
}

func (c *Configuration) founderHubSession(ctx context.Context, actor Actor, clientID, scope string) (*FounderHubSession, error) {
	current, err := c.authorizeFounderHubGrant(ctx, actor, clientID, scope)
	if err != nil {
		return nil, err
	}
	profile, err := c.GetFounderHubProfile(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	return &FounderHubSession{FounderHubProfile: profile, SessionID: current.ID, ExpiresAt: current.ExpiresAt}, nil
}

func (c *Configuration) authorizeFounderHubGrant(ctx context.Context, actor Actor, clientID, scope string) (*ent.Session, error) {
	current, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, err
	}
	client, err := c.client.PlatformOAuthClient.Query().Where(platformoauthclient.ClientID(clientID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if client.Disabled != nil && *client.Disabled {
		return nil, publishing.ErrUnauthorized
	}
	if clientID != "shots-founder-hub" {
		if client.Scopes == nil || !founderHubHasScope(*client.Scopes, scope) || client.SkipConsent != nil && *client.SkipConsent {
			return nil, publishing.ErrUnauthorized
		}
		consents, err := c.client.PlatformOAuthConsent.Query().Where(
			platformoauthconsent.ClientID(clientID), platformoauthconsent.UserID(actor.UserID),
		).Select(platformoauthconsent.FieldScopes).Strings(ctx)
		if err != nil {
			return nil, err
		}
		if !slices.ContainsFunc(consents, func(value string) bool { return founderHubHasScope(value, scope) }) {
			return nil, publishing.ErrUnauthorized
		}
	}
	grants := c.client.PlatformOAuthRefreshToken.Query().Where(
		platformoauthrefreshtoken.ClientID(clientID),
		platformoauthrefreshtoken.UserID(actor.UserID),
		platformoauthrefreshtoken.SessionID(actor.SessionID),
		platformoauthrefreshtoken.ExpiresAtGT(time.Now()),
	)
	if scope != "" {
		grants = grants.Where(platformoauthrefreshtoken.RevokedIsNil())
	}
	var active bool
	if scope == "" {
		active, err = grants.Exist(ctx)
	} else {
		var scopes []string
		scopes, err = grants.Select(platformoauthrefreshtoken.FieldScopes).Strings(ctx)
		active = slices.ContainsFunc(scopes, func(value string) bool {
			return founderHubHasScope(value, scope) && founderHubHasScope(value, "offline_access")
		})
	}
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, publishing.ErrUnauthorized
	}
	return current, nil
}

func founderHubHasScope(value, scope string) bool {
	var scopes []string
	return json.Unmarshal([]byte(value), &scopes) == nil && slices.Contains(scopes, scope)
}

// Private authority snapshot used by the issuer and trusted Founder Hub gateway.
func (c *Configuration) GetFounderHubProfile(ctx context.Context, userID string) (*FounderHubProfile, error) {
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	snapshot := *c
	snapshot.client = tx.Client()
	profile, err := snapshot.founderHubProfile(ctx, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return profile, nil
}

func (c *Configuration) founderHubProfile(ctx context.Context, userID string) (*FounderHubProfile, error) {
	deleting, err := c.client.AccountDeletionRequest.Query().Where(accountdeletionrequest.UserID(userID),
		accountdeletionrequest.StatusIn(accountdeletionrequest.StatusPROCESSING, accountdeletionrequest.StatusCOMPLETED)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if deleting {
		return nil, publishing.ErrUnauthorized
	}
	revision, err := c.client.PlatformFounderHubRevision.Get(ctx, "authority")
	if err != nil {
		return nil, err
	}
	actor := Actor{UserID: userID}
	person, err := c.client.User.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	accountUserID, err := c.founderHubUserID(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	result := &FounderHubProfile{EmailVerified: person.EmailVerified, Revision: strconv.FormatInt(revision.Revision, 10), User: &CurrentUser{ID: person.ID, Email: person.Email, Name: person.Name, Image: person.Image},
		AccountUserID: accountUserID, CreatedAt: person.CreatedAt, Workspaces: []FounderHubWorkspace{}}
	memberships, err := c.ListWorkspaces(ctx, actor)
	if err != nil {
		return nil, err
	}
	for _, membership := range memberships {
		if membership.IsScheduledForDeletion {
			continue
		}
		rows, err := c.client.Member.Query().Where(member.OrganizationID(membership.ID)).All(ctx)
		if err != nil {
			return nil, err
		}
		userIDs, memberIDs := make([]string, 0, len(rows)), make([]string, 0, len(rows))
		for _, row := range rows {
			userIDs = append(userIDs, row.UserID)
			memberIDs = append(memberIDs, row.ID)
		}
		people, err := c.client.User.Query().Where(user.IDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		deleting, err := c.client.AccountDeletionRequest.Query().Where(accountdeletionrequest.UserIDIn(userIDs...),
			accountdeletionrequest.StatusIn(accountdeletionrequest.StatusPROCESSING, accountdeletionrequest.StatusCOMPLETED)).Select(accountdeletionrequest.FieldUserID).Strings(ctx)
		if err != nil {
			return nil, err
		}
		identities, err := c.client.PlatformFounderHubUser.Query().Where(platformfounderhubuser.IDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		groups, err := c.client.PermissionGroup.Query().Where(permissiongroup.OrganizationID(membership.ID)).All(ctx)
		if err != nil {
			return nil, err
		}
		assignments, err := c.client.PermissionGroupMember.Query().Where(permissiongroupmember.IDIn(memberIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		peopleByID := make(map[string]*ent.User, len(people))
		for _, person := range people {
			peopleByID[person.ID] = person
		}
		identitiesByID := make(map[string]uuid.UUID, len(identities))
		for _, identity := range identities {
			identitiesByID[identity.ID] = identity.AccountUserID
		}
		assignmentsByID := make(map[string]*ent.PermissionGroupMember, len(assignments))
		for _, assignment := range assignments {
			assignmentsByID[assignment.ID] = assignment
		}
		var actorDenied []string
		members := make([]FounderHubMember, 0, len(rows))
		var owner *FounderHubMember
		for _, row := range rows {
			if slices.Contains(deleting, row.UserID) {
				continue
			}
			person := peopleByID[row.UserID]
			mapped, exists := identitiesByID[row.UserID]
			if person == nil || !exists {
				return nil, publishing.ErrConflict
			}
			denied := memberDeniedPermissions(row.Role, groups, assignmentsByID[row.ID])
			if row.UserID == actor.UserID {
				actorDenied = denied
			}
			projected := FounderHubMember{EmailVerified: person.EmailVerified, CreatedAt: person.CreatedAt, AccountUserID: mapped,
				User: &CurrentUser{ID: person.ID, Email: person.Email, Name: person.Name, Image: person.Image},
				Role: row.Role, DeniedPermissions: denied}
			if row.Role == "owner" {
				if owner != nil {
					return nil, publishing.ErrConflict
				}
				owner = &projected
			}
			banned := person.Banned != nil && *person.Banned && (person.BanExpires == nil || person.BanExpires.After(time.Now()))
			if banned && !slices.Contains(projected.DeniedPermissions, "workspace:read") {
				projected.DeniedPermissions = append(projected.DeniedPermissions, "workspace:read")
			}
			projected.Permissions = founderHubPermissions(projected.Role, projected.DeniedPermissions)
			members = append(members, projected)
		}
		if owner == nil {
			return nil, publishing.ErrConflict
		}
		workspace, err := c.client.PlatformFounderHubWorkspace.Get(ctx, membership.ID)
		if err != nil {
			return nil, err
		}
		entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(membership.ID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		_, _, features := evaluateBootstrapEntitlement(entitlement, time.Now())
		result.Workspaces = append(result.Workspaces, FounderHubWorkspace{
			OrganizationID: membership.ID, WorkspaceID: workspace.WorkspaceID, Name: membership.Name,
			OwnerUserID: owner.AccountUserID, Owner: owner, Members: members,
			Role: membership.Role, DeniedPermissions: actorDenied, Permissions: founderHubPermissions(membership.Role, actorDenied), Features: features,
		})
	}
	return result, nil
}

func founderHubPermissions(role string, denied []string) []string {
	return slices.DeleteFunc(workspaceroles.ForRole(role), func(permission string) bool { return slices.Contains(denied, permission) })
}

func (c *Configuration) founderHubUserID(ctx context.Context, userID string) (uuid.UUID, error) {
	mapping, err := c.client.PlatformFounderHubUser.Get(ctx, userID)
	if err != nil {
		return uuid.Nil, err
	}
	return mapping.AccountUserID, nil
}

func (c *Configuration) RevokeFounderHubSession(ctx context.Context, actor Actor) error {
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return err
	}
	return c.client.Session.DeleteOneID(actor.SessionID).Exec(ctx)
}
