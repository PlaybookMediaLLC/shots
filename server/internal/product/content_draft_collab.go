package product

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/collab"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
)

// Real-time co-editing of content drafts (RFC 013). The backend issues a
// short-lived token per draft, user and access level; the collaboration
// server presents it to authorize a connection and on every load and store
// of the Yjs state. The collaboration server never reads the database.

// collabStateLimit bounds one stored Yjs document state.
const collabStateLimit = 5 << 20

// WithCollabEpochs shares the collaboration access counts between backend
// replicas. Without it they live in this process.
func (c *Configuration) WithCollabEpochs(epochs collab.Epochs) *Configuration {
	c.collabEpochs = epochs
	return c
}

// CollabEpochs reports the access counts the collaboration server polls: the
// global count and the count of each workspace with a live session.
func (c *Configuration) CollabEpochs(ctx context.Context, organizationIDs []string) (int64, map[string]int64, error) {
	return c.collabEpochs.Read(ctx, organizationIDs)
}

// collabAccessChanged tells live collaboration sessions in organizationID, or
// in every workspace when it is "", to authorize again. Call it after the
// change commits. A failure is logged: sessions still re-authorize on their own
// within a minute.
func (c *Configuration) collabAccessChanged(ctx context.Context, organizationID string) {
	if err := c.collabEpochs.Bump(ctx, organizationID); err != nil {
		slog.WarnContext(ctx, "collab_access_change_unpublished", "organization_id", organizationID, "error", err)
	}
}

// WithCollabKey sets the key that signs collaboration tokens. Without one,
// collaboration is unavailable.
func (c *Configuration) WithCollabKey(key []byte) *Configuration {
	c.collabKey = key
	return c
}

// CollabToken admits the browser to one draft's document.
type CollabToken struct {
	Access       collab.Access `json:"access"`
	DocumentName string        `json:"documentName"`
	ExpiresAt    time.Time     `json:"expiresAt"`
	Token        string        `json:"token"`
}

// CollabGrant is who a connection is and what it may do, for the
// collaboration server.
type CollabGrant struct {
	Kind           string        `json:"kind,omitempty"`
	Access         collab.Access `json:"access"`
	DraftID        string        `json:"draftId"`
	OrganizationID string        `json:"organizationId"`
	User           struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"user"`
}

// ErrCollabUnavailable means the backend has no collaboration signing key.
var ErrCollabUnavailable = errors.New("collaboration is not configured")

// collabWritable reports whether a member may edit: the role allows it, and no
// permission group denies artifact:edit. The collab server has no web gate.
func collabWritable(ctx context.Context, client *ent.Client, organizationID, userID, role string) (bool, error) {
	if !workspaceroles.Allows(role, contentDraftEditRoles...) {
		return false, nil
	}
	denied, err := deniedPermissions(ctx, client, organizationID, userID, role)
	if err != nil {
		return false, err
	}
	return !slices.Contains(denied, "artifact:edit"), nil
}

// memberAccess is what a workspace member's current role allows, or an error
// when they are no longer a member.
func memberAccess(ctx context.Context, client *ent.Client, organizationID, userID string) (collab.Access, error) {
	row, err := client.Member.Query().Where(member.OrganizationID(organizationID), member.UserID(userID)).Only(ctx)
	if ent.IsNotFound(err) || ent.IsNotSingular(err) {
		return "", publishing.ErrForbidden
	}
	if err != nil {
		return "", err
	}
	writable, err := collabWritable(ctx, client, organizationID, userID, row.Role)
	if err != nil {
		return "", err
	}
	if writable {
		return collab.AccessWrite, nil
	}
	return collab.AccessRead, nil
}

// IssueContentDraftCollabToken gives the signed-in member a token for one
// draft: read-write with artifact:edit, read-only otherwise.
func (c *Configuration) IssueContentDraftCollabToken(ctx context.Context, actor Actor, draftID string) (*CollabToken, error) {
	if len(c.collabKey) == 0 {
		return nil, ErrCollabUnavailable
	}
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	draft, err := visibleContentDraft(ctx, c.client, actor, draftID)
	if err != nil {
		return nil, err
	}
	access, err := memberAccess(ctx, c.client, actor.OrganizationID, actor.UserID)
	if err != nil {
		return nil, err
	}
	expires := time.Now().Add(collab.TokenTTL)
	token, err := collab.Sign(c.collabKey, collab.Claims{Generation: draft.CollabGeneration, Access: access, DraftID: draftID, ExpiresAt: expires.Unix(),
		OrganizationID: actor.OrganizationID, UserID: actor.UserID, SessionID: actor.SessionID})
	if err != nil {
		return nil, err
	}
	return &CollabToken{Access: access, DocumentName: collab.DocumentNameAt(draftID, draft.CollabGeneration), ExpiresAt: expires, Token: token}, nil
}

// collabClaims verifies a token for draftID (or for documentName when
// draftID is empty), and that the draft is still the workspace's.
func (c *Configuration) collabClaims(ctx context.Context, token, documentName, draftID string, grace time.Duration) (collab.Claims, error) {
	if len(c.collabKey) == 0 {
		return collab.Claims{}, ErrCollabUnavailable
	}
	claims, err := collab.Verify(c.collabKey, token, time.Now(), grace)
	if err != nil {
		return collab.Claims{}, publishing.ErrUnauthorized
	}
	expectedName := collab.DocumentNameFor(claims.Kind, claims.DraftID)
	if claims.Kind != "creative-set" {
		expectedName = collab.DocumentNameAt(claims.DraftID, claims.Generation)
	}
	if (documentName != "" && documentName != expectedName) || (draftID != "" && draftID != claims.DraftID) {
		return collab.Claims{}, publishing.ErrForbidden
	}
	// The session check reads the member's role; it decides read or write below,
	// so the membership is queried once per authorization.
	role, err := c.auth.AuthorizedRole(ctx, claims.OrganizationID, claims.UserID, claims.SessionID, readRoles...)
	if err != nil {
		return collab.Claims{}, err
	}
	if claims.Kind != "creative-set" {
		if err := c.requireWorkspaceFeature(ctx, claims.OrganizationID, contentDraftFeature); err != nil {
			return collab.Claims{}, err
		}
	}
	var owned bool
	if claims.Kind == "creative-set" {
		owned, err = c.client.PlatformCreativeSet.Query().Where(platformcreativeset.ID(claims.DraftID), platformcreativeset.OrganizationID(claims.OrganizationID)).Exist(ctx)
	} else {
		// The draft must still be one the token's person may see: a private
		// set's draft closes to everyone else even mid-session.
		_, err = visibleContentDraft(ctx, c.client, Actor{OrganizationID: claims.OrganizationID, UserID: claims.UserID, Kind: "session"}, claims.DraftID)
		owned = err == nil
		if errors.Is(err, publishing.ErrNotFound) {
			err = nil
		}
	}
	if err != nil {
		return collab.Claims{}, err
	}
	if !owned {
		return collab.Claims{}, publishing.ErrNotFound
	}
	if claims.Kind != "creative-set" {
		// A member moved out of a restricted set loses the draft on the next
		// load or store, even with a token that has not expired.
		draft, err := c.client.ContentDraft.Get(ctx, claims.DraftID)
		if err != nil {
			return collab.Claims{}, err
		}
		if draft.CollabGeneration != claims.Generation {
			return collab.Claims{}, publishing.ErrForbidden
		}
		visible, err := contentDraftVisible(ctx, c.client, Actor{OrganizationID: claims.OrganizationID, UserID: claims.UserID}, draft)
		if err != nil {
			return collab.Claims{}, err
		}
		if !visible {
			return collab.Claims{}, publishing.ErrNotFound
		}
	}
	writable, err := collabWritable(ctx, c.client, claims.OrganizationID, claims.UserID, role)
	if err != nil {
		return collab.Claims{}, err
	}
	if !writable {
		claims.Access = collab.AccessRead
	}
	return claims, nil
}

// AuthorizeCollab admits a connection to documentName: the token must be
// current, for that document, and its user still a member. A demoted member
// is admitted read-only.
func (c *Configuration) AuthorizeCollab(ctx context.Context, token, documentName string) (*CollabGrant, error) {
	claims, err := c.collabClaims(ctx, token, documentName, "", 0)
	if err != nil {
		return nil, err
	}
	// collabClaims already lowered a member who may not edit to read-only.
	access := claims.Access
	person, err := c.client.User.Query().Where(user.ID(claims.UserID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	grant := &CollabGrant{Kind: claims.Kind, Access: access, DraftID: claims.DraftID, OrganizationID: claims.OrganizationID}
	grant.User.ID, grant.User.Name = person.ID, person.Name
	return grant, nil
}

// LoadCollabState returns the draft's stored Yjs state, or nil before the
// first store.
func (c *Configuration) LoadCollabState(ctx context.Context, token, draftID string) ([]byte, error) {
	claims, err := c.collabClaims(ctx, token, "", draftID, collab.StoreGrace)
	if err != nil {
		return nil, err
	}
	if claims.Kind == "creative-set" {
		return nil, publishing.ErrForbidden
	}
	row, err := c.client.ContentDraft.Query().Where(contentdraft.ID(draftID),
		contentdraft.OrganizationID(claims.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if row.CollabGeneration != claims.Generation {
		return nil, publishing.ErrForbidden
	}
	if row.CollabState == nil {
		return nil, nil
	}
	return *row.CollabState, nil
}

// StoreCollabState saves the draft's Yjs state on behalf of a read-write
// connection. The Plate body is saved separately by the editor's autosave.
func (c *Configuration) StoreCollabState(ctx context.Context, token, draftID string, state []byte) error {
	claims, err := c.collabClaims(ctx, token, "", draftID, collab.StoreGrace)
	if err != nil {
		return err
	}
	if claims.Access != collab.AccessWrite || claims.Kind == "creative-set" {
		return publishing.ErrForbidden
	}
	if len(state) == 0 || len(state) > collabStateLimit {
		return invalid("The collaboration state is empty or too large.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Hold the current membership and session through persistence. Removal must
	// either follow this authorized commit or complete before its fresh check.
	for _, lock := range []struct {
		query string
		args  []any
	}{
		{`SELECT id FROM organization WHERE id=$1 FOR SHARE`, []any{claims.OrganizationID}},
		{`SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE`, []any{claims.OrganizationID, claims.UserID}},
		{`SELECT id FROM session WHERE id=$1 AND "userId"=$2 FOR SHARE`, []any{claims.SessionID, claims.UserID}},
		{`SELECT id FROM "user" WHERE id=$1 FOR SHARE`, []any{claims.UserID}},
	} {
		if _, err := tx.PlatformExec(ctx, lock.query, lock.args...); err != nil {
			return err
		}
	}
	bound := *c
	bound.client, bound.auth = tx.Client(), publishing.NewRepository(tx.Client())
	claims, err = bound.collabClaims(ctx, token, "", draftID, collab.StoreGrace)
	if err != nil {
		return err
	}
	if claims.Access != collab.AccessWrite {
		return publishing.ErrForbidden
	}
	count, err := tx.ContentDraft.Update().Where(contentdraft.ID(draftID),
		contentdraft.OrganizationID(claims.OrganizationID), contentdraft.CollabGeneration(claims.Generation)).SetCollabState(state).Save(ctx)
	if err != nil {
		return err
	}
	if count != 1 {
		return publishing.ErrNotFound
	}
	return tx.Commit()
}
