package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/session"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacedeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

var ErrInvalidInput = errors.New("invalid workspace input")
var ErrRateLimited = errors.New("Too many invitation emails. Please try again later.")

func (c *Configuration) AuthorizeSession(ctx context.Context, actor Actor) error {
	_, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	return err
}

type ActiveAccess struct {
	// DeniedPermissions is what the member's permission group subtracts from Role.
	DeniedPermissions []string `json:"deniedPermissions"`
	OrganizationID    string   `json:"organizationId"`
	Role              string   `json:"role"`
}

func (c *Configuration) GetActiveAccess(ctx context.Context, actor Actor) (*ActiveAccess, error) {
	current, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return nil, err
	}
	organizationID := ""
	if current.ActiveOrganizationID != nil {
		organizationID = *current.ActiveOrganizationID
	} else {
		membership, err := c.client.Member.Query().Where(member.UserID(actor.UserID)).Order(ent.Asc(member.FieldCreatedAt)).First(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrForbidden
		}
		if err != nil {
			return nil, err
		}
		organizationID = membership.OrganizationID
		if err := c.SetActiveWorkspace(ctx, actor, organizationID); err != nil {
			return nil, err
		}
	}
	role, err := c.auth.AuthorizedRole(ctx, organizationID, actor.UserID, actor.SessionID, readRoles...)
	if err != nil {
		return nil, err
	}
	if role == "member" {
		role = "viewer"
	}
	denied, err := deniedPermissions(ctx, c.client, organizationID, actor.UserID, role)
	if err != nil {
		return nil, err
	}
	return &ActiveAccess{DeniedPermissions: denied, OrganizationID: organizationID, Role: role}, nil
}

func (c *Configuration) AuthorizeSensitive(ctx context.Context, actor Actor) error {
	if err := c.auth.AuthorizeRole(ctx, actor.OrganizationID, actor.UserID, actor.SessionID, "owner"); err != nil {
		return err
	}
	current, err := c.auth.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
	if err != nil {
		return err
	}
	if time.Since(current.CreatedAt) > 15*time.Minute {
		return publishing.ErrUnauthorized
	}
	person, err := c.client.User.Query().Where(user.ID(actor.UserID)).Only(ctx)
	if err != nil {
		return err
	}
	if person.TwoFactorEnabled == nil || !*person.TwoFactorEnabled {
		return publishing.ErrForbidden
	}
	return nil
}

type CreateWorkspaceInput struct {
	Name                          string         `json:"name"`
	Slug                          string         `json:"slug"`
	TimeZone                      string         `json:"timeZone,omitempty"`
	IdempotencyKey                string         `json:"idempotencyKey,omitempty"`
	KeepCurrentActiveOrganization bool           `json:"keepCurrentActiveOrganization,omitempty"`
	Logo                          *string        `json:"logo,omitempty"`
	Metadata                      map[string]any `json:"metadata,omitempty"`
	// Where the creator heard about Shots. Optional; kept once per person.
	HeardAbout *SignupSourceInput `json:"heardAbout,omitempty"`
}

// SignupSourceInput is one platform_signup_source value, and a short detail
// that only "other" takes.
type SignupSourceInput struct {
	Source string `json:"source"`
	Detail string `json:"detail,omitempty"`
}

// WorkspaceCreationMember is the actual membership returned by atomic creation
// or authorized replay, including a role changed after the original request.
type WorkspaceCreationMember struct {
	ID             string    `json:"id"`
	OrganizationID string    `json:"organizationId"`
	UserID         string    `json:"userId"`
	Role           string    `json:"role"`
	CreatedAt      time.Time `json:"createdAt"`
}

type Workspace struct {
	ID                string                   `json:"id"`
	CreatedAt         time.Time                `json:"createdAt"`
	Logo              *string                  `json:"logo"`
	Name              string                   `json:"name"`
	Slug              string                   `json:"slug"`
	WorkspaceSettings *ent.WorkspaceSettings   `json:"workspaceSettings"`
	Metadata          *string                  `json:"metadata,omitempty"`
	CreationMember    *WorkspaceCreationMember `json:"creationMember,omitempty"`
}

type ListedWorkspaceDeletion struct {
	RequestedByUserID string    `json:"requestedByUserId"`
	ScheduledFor      time.Time `json:"scheduledFor"`
	Status            string    `json:"status"`
}

type ListedWorkspace struct {
	ID                     string                   `json:"id"`
	IsScheduledForDeletion bool                     `json:"isScheduledForDeletion"`
	Name                   string                   `json:"name"`
	Role                   string                   `json:"role"`
	Slug                   string                   `json:"slug"`
	WorkspaceDeletion      *ListedWorkspaceDeletion `json:"workspaceDeletion,omitempty"`
}

func (c *Configuration) ListWorkspaces(ctx context.Context, actor Actor) ([]ListedWorkspace, error) {
	memberships, err := c.client.Member.Query().Where(member.UserID(actor.UserID)).Order(ent.Asc(member.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ListedWorkspace, 0, len(memberships))
	for _, membership := range memberships {
		org, err := c.client.Organization.Get(ctx, membership.OrganizationID)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		deletion, err := c.client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationID(org.ID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if deletion != nil && deletion.Status != workspacedeletion.StatusCANCELLED &&
			(deletion.Status != workspacedeletion.StatusPENDING || deletion.RequestedByUserID != actor.UserID) {
			continue
		}
		role := membership.Role
		if role == "member" {
			role = "viewer"
		}
		item := ListedWorkspace{ID: org.ID, IsScheduledForDeletion: deletion != nil && deletion.Status == workspacedeletion.StatusPENDING,
			Name: org.Name, Role: role, Slug: org.Slug}
		if deletion != nil && deletion.Status == workspacedeletion.StatusPENDING {
			item.WorkspaceDeletion = &ListedWorkspaceDeletion{
				RequestedByUserID: deletion.RequestedByUserID,
				ScheduledFor:      deletion.ScheduledFor,
				Status:            string(deletion.Status),
			}
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Configuration) SetActiveWorkspace(ctx context.Context, actor Actor, organizationID string) error {
	membership, err := c.client.Member.Query().Where(member.OrganizationID(organizationID), member.UserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	deletion, err := c.client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationID(membership.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if deletion != nil && (deletion.Status == workspacedeletion.StatusPROCESSING || deletion.Status == workspacedeletion.StatusPURGED ||
		(deletion.Status == workspacedeletion.StatusPENDING && deletion.RequestedByUserID != actor.UserID)) {
		return forbidden("This workspace is scheduled for deletion.")
	}
	_, err = c.client.Session.Update().Where(session.ID(actor.SessionID), session.UserID(actor.UserID)).
		SetActiveOrganizationID(organizationID).Save(ctx)
	return err
}

func (c *Configuration) GetWorkspace(ctx context.Context, organizationID string) (*Workspace, error) {
	org, err := c.client.Organization.Query().Where(organization.ID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	settings, err := c.client.WorkspaceSettings.Query().Where(workspacesettings.ID(org.ID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	return &Workspace{ID: org.ID, CreatedAt: org.CreatedAt, Logo: org.Logo, Name: org.Name, Slug: org.Slug, WorkspaceSettings: settings}, nil
}

// NullableString distinguishes an omitted field from a deliberate null.
type NullableString struct {
	Set   bool
	Value *string
}

func (n *NullableString) UnmarshalJSON(data []byte) error {
	n.Set = true
	if bytes.Equal(data, []byte("null")) {
		n.Value = nil
		return nil
	}
	return json.Unmarshal(data, &n.Value)
}

type UpdateWorkspaceInput struct {
	// AIAgentEnabled is the AI kill switch; changing it is audited.
	AIAgentEnabled     *bool          `json:"aiAgentEnabled"`
	DefaultPublishTime *string        `json:"defaultPublishTime"`
	Description        NullableString `json:"description"`
	Locale             *string        `json:"locale"`
	Logo               NullableString `json:"logo"`
	Name               string         `json:"name"`
	Slug               string         `json:"slug"`
	TimeZone           *string        `json:"timeZone"`
}

func (c *Configuration) UpdateWorkspace(ctx context.Context, actor Actor, input UpdateWorkspaceInput) (*Workspace, error) {
	name, err := NormalizeWorkspaceName(input.Name)
	if err != nil {
		return nil, err
	}
	input.Name = name
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	org, err := tx.Organization.Query().Where(organization.ID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	update := tx.Organization.UpdateOneID(org.ID).SetName(input.Name).SetSlug(input.Slug)
	if input.Logo.Set {
		if input.Logo.Value == nil {
			update.ClearLogo()
		} else {
			update.SetLogo(*input.Logo.Value)
		}
	}
	org, err = update.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This workspace slug is already taken.")
	}
	if err != nil {
		return nil, err
	}
	settings, err := tx.WorkspaceSettings.Query().Where(workspacesettings.ID(org.ID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if settings == nil {
		settings, err = tx.WorkspaceSettings.Create().SetID(org.ID).Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	settingsUpdate := tx.WorkspaceSettings.UpdateOneID(org.ID)
	aiAgentChanged := input.AIAgentEnabled != nil && *input.AIAgentEnabled != settings.AiAgentEnabled
	if input.AIAgentEnabled != nil {
		settingsUpdate.SetAiAgentEnabled(*input.AIAgentEnabled)
	}
	if input.DefaultPublishTime != nil {
		settingsUpdate.SetDefaultPublishTime(*input.DefaultPublishTime)
	}
	if input.Description.Set {
		if input.Description.Value == nil || *input.Description.Value == "" {
			settingsUpdate.ClearDescription()
		} else {
			settingsUpdate.SetDescription(*input.Description.Value)
		}
	}
	if input.Locale != nil {
		settingsUpdate.SetLocale(*input.Locale)
	}
	if input.TimeZone != nil {
		settingsUpdate.SetTimeZone(*input.TimeZone)
	}
	settings, err = settingsUpdate.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_updated", "organization", org.ID); err != nil {
		return nil, err
	}
	if aiAgentChanged {
		action := "product.workspace_ai_agent_disabled"
		if *input.AIAgentEnabled {
			action = "product.workspace_ai_agent_enabled"
		}
		if err := appendConfigurationAudit(ctx, tx, actor, action, "organization", org.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Workspace{ID: org.ID, CreatedAt: org.CreatedAt, Logo: org.Logo, Name: org.Name, Slug: org.Slug, WorkspaceSettings: settings.Unwrap()}, nil
}
