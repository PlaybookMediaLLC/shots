package product

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformsignupsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformworkspacecreation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

var creationSlugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func normalizeWorkspaceCreation(input CreateWorkspaceInput) (CreateWorkspaceInput, string, string, error) {
	name, err := NormalizeWorkspaceName(input.Name)
	input.Name, input.Slug = name, strings.TrimSpace(input.Slug)
	if err != nil || len(input.Slug) < 2 || len(input.Slug) > 100 || !creationSlugPattern.MatchString(input.Slug) {
		return input, "", "", ErrInvalidInput
	}
	if input.TimeZone == "" {
		input.TimeZone = "UTC"
	}
	if len(input.TimeZone) > 100 {
		return input, "", "", ErrInvalidInput
	}
	if _, err := time.LoadLocation(input.TimeZone); err != nil {
		return input, "", "", ErrInvalidInput
	}
	if input.Logo != nil {
		parsed, err := url.Parse(*input.Logo)
		if err != nil || len(*input.Logo) > 2048 || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil {
			return input, "", "", ErrInvalidInput
		}
	}
	if input.Metadata != nil {
		encoded, err := json.Marshal(input.Metadata)
		if err != nil || len(encoded) > 8192 || !validWorkspaceMetadata(input.Metadata, 0) {
			return input, "", "", ErrInvalidInput
		}
	}
	if input.HeardAbout != nil {
		heard := *input.HeardAbout
		heard.Detail = strings.TrimSpace(heard.Detail)
		if platformsignupsource.SourceValidator(platformsignupsource.Source(heard.Source)) != nil ||
			utf8.RuneCountInString(heard.Detail) > 200 ||
			// Postgres refuses NUL in text, so control characters are a 400, not a failed transaction.
			strings.IndexFunc(heard.Detail, unicode.IsControl) >= 0 ||
			(heard.Detail != "" && heard.Source != string(platformsignupsource.SourceOther)) {
			return input, "", "", ErrInvalidInput
		}
		input.HeardAbout = &heard
	}
	// Older clients have a stable, caller-chosen slug. Preserve their retry
	// identity independently of subsequent changes to the organization's slug.
	key := "slug:" + input.Slug
	if input.IdempotencyKey != "" {
		parsed, err := uuid.Parse(input.IdempotencyKey)
		if err != nil || parsed == uuid.Nil {
			return input, "", "", ErrInvalidInput
		}
		key = "key:" + parsed.String()
	}
	hash, err := workspaceCreationFingerprint(input)
	if err != nil {
		return input, "", "", err
	}
	return input, key, hash, nil
}

func workspaceCreationFingerprint(input CreateWorkspaceInput) (string, error) {
	input.IdempotencyKey = ""
	// The answer is not part of the workspace, and only the first one is kept:
	// a retry that changed it still replays the workspace it made.
	input.HeardAbout = nil
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

func validWorkspaceMetadata(value any, depth int) bool {
	switch value := value.(type) {
	case map[string]any:
		if depth >= 3 {
			return false
		}
		for _, child := range value {
			if !validWorkspaceMetadata(child, depth+1) {
				return false
			}
		}
	case []any:
		if depth >= 3 {
			return false
		}
		for _, child := range value {
			if !validWorkspaceMetadata(child, depth+1) {
				return false
			}
		}
	case string, float32, float64, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, bool, nil:
	default:
		return false
	}
	return true
}

// CreateWorkspace commits the organization, owner, settings, audit, and retry
// receipt together. Callers may preserve their current editor's workspace.
func (c *Configuration) CreateWorkspace(ctx context.Context, actor Actor, input CreateWorkspaceInput) (*Workspace, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	// Keep the pre-NFC fingerprint for receipts written before the name-policy
	// upgrade. The web validates creation names without rewriting retry payloads.
	legacy := input
	legacy.Name, legacy.Slug = strings.TrimSpace(legacy.Name), strings.TrimSpace(legacy.Slug)
	legacyHash, err := workspaceCreationFingerprint(legacy)
	if err != nil {
		return nil, ErrInvalidInput
	}
	input, key, hash, err := normalizeWorkspaceCreation(input)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Serialize creations by actor, including requests in different sessions.
	// Lock the user before the session, matching account-deletion FK ordering.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, actor.UserID); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM session WHERE id=$1 AND "userId"=$2 FOR UPDATE`, actor.SessionID, actor.UserID); err != nil {
		return nil, err
	}
	auth := publishing.NewRepository(tx.Client())
	if _, err := auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID); err != nil {
		return nil, err
	}
	receipt, err := tx.PlatformWorkspaceCreation.Query().Where(
		platformworkspacecreation.UserID(actor.UserID), platformworkspacecreation.RequestKey(key),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if receipt != nil {
		if receipt.RequestHash != hash && receipt.RequestHash != legacyHash {
			return nil, conflict("This creation request was already used with different details.")
		}
		return replayWorkspaceCreation(ctx, tx, actor, receipt.OrganizationID)
	}
	now := time.Now().UTC()
	create := tx.Organization.Create().SetID(uuid.NewString()).SetName(input.Name).SetSlug(input.Slug).SetCreatedAt(now).SetNillableLogo(input.Logo)
	if len(input.Metadata) > 0 {
		metadata, err := json.Marshal(input.Metadata)
		if err != nil {
			return nil, err
		}
		create.SetMetadata(string(metadata))
	}
	org, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This workspace slug is already taken.")
	}
	if err != nil {
		return nil, err
	}
	// The membership trigger must attribute this join to the verified creator,
	// so notification projection can suppress their own manual action.
	if _, err := tx.PlatformExec(ctx, `SELECT set_config('platform.activity_actor',$1,true)`, actor.UserID); err != nil {
		return nil, err
	}
	owner, err := tx.Member.Create().SetID(uuid.NewString()).SetOrganizationID(org.ID).
		SetUserID(actor.UserID).SetRole("owner").SetCreatedAt(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := tx.WorkspaceSettings.Create().SetID(org.ID).SetTimeZone(input.TimeZone).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := recordSignupSource(ctx, tx, actor.UserID, org.ID, input.HeardAbout, now); err != nil {
		return nil, err
	}
	if !input.KeepCurrentActiveOrganization {
		updated, err := tx.Session.Update().Where(session.ID(actor.SessionID), session.UserID(actor.UserID), session.ExpiresAtGT(time.Now())).SetActiveOrganizationID(org.ID).Save(ctx)
		if err != nil {
			return nil, err
		}
		if updated != 1 {
			return nil, publishing.ErrUnauthorized
		}
	}
	actor.OrganizationID = org.ID
	if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_created", "organization", org.ID); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformWorkspaceCreation.Create().SetID(uuid.NewString()).SetOrganizationID(org.ID).
		SetUserID(actor.UserID).SetRequestKey(key).SetRequestHash(hash).SetCreatedAt(now).Save(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return createdWorkspaceResult(org, owner, settings.Unwrap()), nil
}

// recordSignupSource keeps where the creator heard about Shots, once per
// person: a later workspace keeps the first answer. CreateWorkspace holds the
// user's row lock, so two creations cannot both find no answer.
func recordSignupSource(ctx context.Context, tx *ent.Tx, userID, organizationID string, heard *SignupSourceInput, now time.Time) error {
	if heard == nil {
		return nil
	}
	answered, err := tx.PlatformSignupSource.Query().Where(platformsignupsource.UserID(userID)).Exist(ctx)
	if err != nil || answered {
		return err
	}
	create := tx.PlatformSignupSource.Create().SetID(uuid.NewString()).SetUserID(userID).
		SetOrganizationID(organizationID).SetSource(platformsignupsource.Source(heard.Source)).SetCreatedAt(now)
	if heard.Detail != "" {
		create.SetDetail(heard.Detail)
	}
	_, err = create.Save(ctx)
	return err
}

func replayWorkspaceCreation(ctx context.Context, tx *ent.Tx, actor Actor, organizationID string) (*Workspace, error) {
	// A receipt grants no ongoing access: removed members and deleted workspaces
	// cannot be recovered through an old creation request.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM organization WHERE id=$1 FOR UPDATE`, organizationID); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE`, organizationID, actor.UserID); err != nil {
		return nil, err
	}
	membership, err := tx.Member.Query().Where(member.OrganizationID(organizationID), member.UserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrForbidden
	}
	if err != nil {
		return nil, err
	}
	if err := publishing.NewRepository(tx.Client()).AuthorizeWorkspace(ctx, organizationID); err != nil {
		return nil, err
	}
	org, err := tx.Organization.Get(ctx, organizationID)
	if err != nil {
		return nil, err
	}
	settings, err := tx.WorkspaceSettings.Get(ctx, organizationID)
	if err != nil {
		return nil, err
	}
	// Never switch the current workspace on replay: the actor may have moved
	// to another editor while the original response was delayed or lost.
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return createdWorkspaceResult(org, membership, settings.Unwrap()), nil
}

func createdWorkspaceResult(org *ent.Organization, membership *ent.Member, settings *ent.WorkspaceSettings) *Workspace {
	return &Workspace{ID: org.ID, CreatedAt: org.CreatedAt, Logo: org.Logo, Metadata: org.Metadata, Name: org.Name, Slug: org.Slug, WorkspaceSettings: settings,
		CreationMember: &WorkspaceCreationMember{ID: membership.ID, OrganizationID: membership.OrganizationID, UserID: membership.UserID, Role: membership.Role, CreatedAt: membership.CreatedAt}}
}
