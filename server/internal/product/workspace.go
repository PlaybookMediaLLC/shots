package product

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

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
var ErrAIKeyEncryptionUnavailable = errors.New("API key encryption is not configured on this server")
var ErrAIKeyDecryptionFailed = errors.New("The stored OpenRouter API key could not be decrypted. Re-enter it in Settings → Models & usage.")

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
	// Every page reads this list, so it is three queries however many workspaces there are.
	ids := make([]string, 0, len(memberships))
	for _, membership := range memberships {
		ids = append(ids, membership.OrganizationID)
	}
	orgs, err := c.client.Organization.Query().Where(organization.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	orgByID := make(map[string]*ent.Organization, len(orgs))
	for _, org := range orgs {
		orgByID[org.ID] = org
	}
	deletions, err := c.client.WorkspaceDeletion.Query().Where(workspacedeletion.OrganizationIDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	deletionByOrg := make(map[string]*ent.WorkspaceDeletion, len(deletions))
	for _, deletion := range deletions {
		deletionByOrg[deletion.OrganizationID] = deletion
	}
	items := make([]ListedWorkspace, 0, len(memberships))
	for _, membership := range memberships {
		org := orgByID[membership.OrganizationID]
		if org == nil {
			continue
		}
		deletion := deletionByOrg[org.ID]
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
	AIAgentEnabled          *bool          `json:"aiAgentEnabled"`
	ReleaseReadinessEnabled *bool          `json:"releaseReadinessEnabled"`
	DefaultPublishTime      *string        `json:"defaultPublishTime"`
	Description             NullableString `json:"description"`
	Locale                  *string        `json:"locale"`
	Logo                    NullableString `json:"logo"`
	Name                    string         `json:"name"`
	Slug                    string         `json:"slug"`
	TimeZone                *string        `json:"timeZone"`
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
	if input.ReleaseReadinessEnabled != nil {
		if err := workspaceAdministrator(ctx, tx, actor, "workspace:update"); err != nil {
			return nil, err
		}
	}
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
	readinessChanged := input.ReleaseReadinessEnabled != nil && *input.ReleaseReadinessEnabled != settings.ReleaseReadinessEnabled
	if input.ReleaseReadinessEnabled != nil {
		settingsUpdate.SetReleaseReadinessEnabled(*input.ReleaseReadinessEnabled)
	}
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
	if readinessChanged {
		if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_release_readiness_changed", "organization", org.ID,
			map[string]any{"enabled": *input.ReleaseReadinessEnabled}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Workspace{ID: org.ID, CreatedAt: org.CreatedAt, Logo: org.Logo, Name: org.Name, Slug: org.Slug, WorkspaceSettings: settings.Unwrap()}, nil
}

// UpdateWorkspaceAISettingsInput updates workspace-wide AI preferences without
// touching organization identity fields (name, slug, logo).
type UpdateWorkspaceAISettingsInput struct {
	AIAgentEnabled   *bool          `json:"aiAgentEnabled"`
	AIModelDefaults  map[string]any `json:"aiModelDefaults"`
	AIInstructions   NullableString `json:"aiInstructions"`
	AIProviderAPIKey NullableString `json:"aiProviderApiKey"`
}

func validAIProviderAPIKey(key string) bool {
	if len(key) < 16 || len(key) > 512 {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < 0x21 || key[i] > 0x7e {
			return false
		}
	}
	return true
}

func formatAPIKeyHint(apiKey string) string {
	suffix := apiKey[len(apiKey)-4:]
	switch {
	case strings.HasPrefix(apiKey, "sk-or-"):
		return "sk-or-…" + suffix
	case strings.HasPrefix(apiKey, "sk-"):
		return "sk-…" + suffix
	default:
		return "…" + suffix
	}
}

func deriveWorkspaceAIKey(root []byte) []byte {
	sum := sha256.Sum256(append([]byte("shots-workspace-ai-key-v1:"), root...))
	return sum[:]
}

func sealWorkspaceAIKey(key []byte, organizationID, secret string) (string, error) {
	if len(key) != 32 {
		return "", ErrAIKeyEncryptionUnavailable
	}
	block, err := aes.NewCipher(deriveWorkspaceAIKey(key))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	aad := []byte("workspace-ai-key-v1:" + organizationID)
	sealed := gcm.Seal(nil, nonce, []byte(secret), aad)
	return base64.RawURLEncoding.EncodeToString(nonce) + "." + base64.RawURLEncoding.EncodeToString(sealed), nil
}

func openWorkspaceAIKey(key []byte, organizationID, sealed string) (string, error) {
	if len(key) != 32 {
		return "", ErrAIKeyEncryptionUnavailable
	}
	parts := strings.Split(sealed, ".")
	if len(parts) != 2 {
		return "", ErrAIKeyDecryptionFailed
	}
	nonce, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrAIKeyDecryptionFailed
	}
	ciphertext, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ErrAIKeyDecryptionFailed
	}
	block, err := aes.NewCipher(deriveWorkspaceAIKey(key))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(nonce) != gcm.NonceSize() {
		return "", ErrAIKeyDecryptionFailed
	}
	aad := []byte("workspace-ai-key-v1:" + organizationID)
	plain, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return "", ErrAIKeyDecryptionFailed
	}
	return string(plain), nil
}

func aiDefaultsContainBYOKTier(defaults map[string]any) bool {
	for _, raw := range defaults {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if tier, _ := entry["tier"].(string); tier != "" && tier != "fast" {
			return true
		}
	}
	return false
}

func stripBYOKTiersFromDefaults(defaults map[string]any) map[string]any {
	cleaned := make(map[string]any, len(defaults))
	for slot, raw := range defaults {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if tier, _ := entry["tier"].(string); tier == "fast" {
			cleaned[slot] = entry
		}
	}
	return cleaned
}

func (c *Configuration) UpdateWorkspaceAISettings(ctx context.Context, actor Actor, input UpdateWorkspaceAISettingsInput) (*Workspace, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := workspaceAdministrator(ctx, tx, actor, "workspace:update"); err != nil {
		return nil, err
	}
	org, err := tx.Organization.Query().Where(organization.ID(actor.OrganizationID), func(s *entsql.Selector) { s.ForUpdate() }).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	settings, err := tx.WorkspaceSettings.Query().Where(workspacesettings.ID(org.ID), func(s *entsql.Selector) { s.ForUpdate() }).Only(ctx)
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
	hasExistingKey := settings.AiProviderKeyEncrypted != nil && *settings.AiProviderKeyEncrypted != ""
	hasKeyAfter := hasExistingKey
	keyAuditAction := ""
	if input.AIProviderAPIKey.Set {
		if input.AIProviderAPIKey.Value == nil || strings.TrimSpace(*input.AIProviderAPIKey.Value) == "" {
			settingsUpdate.ClearAiProviderKeyEncrypted().ClearAiProviderKeyHint()
			hasKeyAfter = false
			if hasExistingKey {
				keyAuditAction = "product.workspace_ai_provider_key_removed"
			}
		} else {
			trimmed := strings.TrimSpace(*input.AIProviderAPIKey.Value)
			if !validAIProviderAPIKey(trimmed) {
				return nil, invalid("Enter a valid OpenRouter API key.")
			}
			sealed, err := sealWorkspaceAIKey(c.webhookKey, org.ID, trimmed)
			if err != nil {
				return nil, err
			}
			settingsUpdate.SetAiProviderKeyEncrypted(sealed).SetAiProviderKeyHint(formatAPIKeyHint(trimmed))
			hasKeyAfter = true
			keyAuditAction = "product.workspace_ai_provider_key_updated"
		}
	}
	if input.AIModelDefaults != nil {
		if !hasKeyAfter && aiDefaultsContainBYOKTier(input.AIModelDefaults) {
			return nil, invalid("Balanced and Deep models require your own OpenRouter API key.")
		}
		settingsUpdate.SetAiModelDefaults(input.AIModelDefaults)
	} else if !hasKeyAfter && aiDefaultsContainBYOKTier(settings.AiModelDefaults) {
		// Removing the workspace BYOK key resets any Balanced/Deep defaults back to Haiku.
		settingsUpdate.SetAiModelDefaults(stripBYOKTiersFromDefaults(settings.AiModelDefaults))
	}
	if input.AIInstructions.Set {
		if input.AIInstructions.Value == nil || strings.TrimSpace(*input.AIInstructions.Value) == "" {
			settingsUpdate.ClearAiInstructions()
		} else {
			settingsUpdate.SetAiInstructions(strings.TrimSpace(*input.AIInstructions.Value))
		}
	}
	settings, err = settingsUpdate.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.workspace_ai_settings_updated", "organization", org.ID); err != nil {
		return nil, err
	}
	if keyAuditAction != "" {
		if err := appendConfigurationAudit(ctx, tx, actor, keyAuditAction, "organization", org.ID); err != nil {
			return nil, err
		}
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

// GetWorkspaceAIProviderKey decrypts the workspace's BYOK OpenRouter API key
// for server-side assistant execution. Never exposed to browser clients.
func (c *Configuration) GetWorkspaceAIProviderKey(ctx context.Context, actor Actor) (*string, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if err := requireNotDenied(ctx, c.client, actor, "workspace:read"); err != nil {
		return nil, err
	}
	settings, err := c.client.WorkspaceSettings.Query().
		Where(workspacesettings.ID(actor.OrganizationID)).
		Select(workspacesettings.FieldAiAgentEnabled, workspacesettings.FieldAiProviderKeyEncrypted).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !settings.AiAgentEnabled {
		return nil, publishing.ErrForbidden
	}
	if settings.AiProviderKeyEncrypted == nil || *settings.AiProviderKeyEncrypted == "" {
		return nil, nil
	}
	plain, err := openWorkspaceAIKey(c.webhookKey, actor.OrganizationID, *settings.AiProviderKeyEncrypted)
	if err != nil {
		return nil, err
	}
	return &plain, nil
}
