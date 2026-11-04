package product

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/integrationconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/project"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sharelink"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Share links publish one workspace asset at an unguessable URL. The web
// facade serves the public page and reads the bytes through the internal
// endpoints; nothing here is reachable without the service token.

const (
	shareTitleLimit       = 200
	shareDescriptionLimit = 5000
	shareAltTextLimit     = 1500
	shareMaxLifetime      = 366 * 24 * time.Hour
	shareListLimit        = 200
)

var shareEditRoles = []string{"owner", "admin", "creator"}

// ShareLinkInput publishes an asset. ExpiresAt is optional; a link without
// one lasts until it is revoked.
type ShareLinkInput struct {
	Access        string     `json:"access"`
	AltText       *string    `json:"altText"`
	AssetID       string     `json:"assetId"`
	Description   *string    `json:"description"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	PosterAssetID *string    `json:"posterAssetId"`
	ProjectID     *string    `json:"projectId"`
	Title         string     `json:"title"`
	// Code is a Code Studio document to embed as text; it is frozen at creation.
	Code map[string]any `json:"code,omitempty"`
}

// ShareLinkUpdate changes a link's text or access. A nil field is left as is;
// ClearExpiry removes the expiry.
type ShareLinkUpdate struct {
	Access      *string    `json:"access"`
	AltText     *string    `json:"altText"`
	ClearExpiry bool       `json:"clearExpiry"`
	Description *string    `json:"description"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	Title       *string    `json:"title"`
}

// ShareLinkRecord is a link as its workspace sees it.
type ShareLinkRecord struct {
	Access        string     `json:"access"`
	AltText       *string    `json:"altText"`
	AssetID       string     `json:"assetId"`
	CreatedAt     time.Time  `json:"createdAt"`
	Description   *string    `json:"description"`
	ExpiresAt     *time.Time `json:"expiresAt"`
	Height        *int       `json:"height"`
	ID            string     `json:"id"`
	MediaType     string     `json:"mediaType"`
	PosterAssetID *string    `json:"posterAssetId"`
	ProjectID     *string    `json:"projectId"`
	RevokedAt     *time.Time `json:"revokedAt"`
	Title         string     `json:"title"`
	Token         string     `json:"token"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	Width         *int       `json:"width"`
}

// PublicShareLink is what a share page may show: no IDs beyond the workspace
// it belongs to, which the facade needs to check workspace-only access.
type PublicShareLink struct {
	Access          string         `json:"access"`
	AltText         *string        `json:"altText"`
	CreatedAt       time.Time      `json:"createdAt"`
	Description     *string        `json:"description"`
	ExpiresAt       *time.Time     `json:"expiresAt"`
	Height          *int           `json:"height"`
	MediaType       string         `json:"mediaType"`
	OrganizationID  string         `json:"organizationId"`
	PosterMediaType *string        `json:"posterMediaType"`
	Title           string         `json:"title"`
	Width           *int           `json:"width"`
	Code            map[string]any `json:"code,omitempty"`
}

func newShareToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func limitedText(value *string, limit int) (*string, bool) {
	if value == nil {
		return nil, true
	}
	trimmed := strings.TrimSpace(*value)
	if utf8.RuneCountInString(trimmed) > limit {
		return nil, false
	}
	if trimmed == "" {
		return nil, true
	}
	return &trimmed, true
}

func validShareAccess(access string) bool {
	return access == string(sharelink.AccessPUBLIC) || access == string(sharelink.AccessWORKSPACE)
}

func validShareExpiry(expiresAt *time.Time) bool {
	if expiresAt == nil {
		return true
	}
	now := time.Now()
	return expiresAt.After(now) && expiresAt.Before(now.Add(shareMaxLifetime))
}

func shareLinkRecord(row *ent.ShareLink, media *ent.Asset) ShareLinkRecord {
	record := ShareLinkRecord{Access: string(row.Access), AltText: row.AltText, AssetID: row.AssetID,
		CreatedAt: row.CreatedAt, Description: row.Description, ExpiresAt: row.ExpiresAt, ID: row.ID,
		PosterAssetID: row.PosterAssetID, ProjectID: row.ProjectID, RevokedAt: row.RevokedAt, Title: row.Title,
		Token: row.Token, UpdatedAt: row.UpdatedAt}
	if media != nil {
		record.MediaType, record.Width, record.Height = media.MediaType, media.Width, media.Height
	}
	return record
}

func (c *Configuration) uploadedAsset(ctx context.Context, tx *ent.Tx, organizationID, assetID string) (*ent.Asset, error) {
	row, err := tx.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(organizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, fmt.Errorf("%w: the asset is not an uploaded file in this workspace", ErrInvalidInput)
	}
	return row, err
}

// CreateShareLink publishes an uploaded asset of the workspace.
func (c *Configuration) CreateShareLink(ctx context.Context, actor Actor, input ShareLinkInput) (*ShareLinkRecord, error) {
	if err := c.authorizeRoles(ctx, actor, shareEditRoles...); err != nil {
		return nil, err
	}
	input.Title = strings.TrimSpace(input.Title)
	description, okDescription := limitedText(input.Description, shareDescriptionLimit)
	altText, okAlt := limitedText(input.AltText, shareAltTextLimit)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > shareTitleLimit || !okDescription || !okAlt ||
		!validShareAccess(input.Access) || !validShareExpiry(input.ExpiresAt) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	media, err := c.uploadedAsset(ctx, tx, actor.OrganizationID, input.AssetID)
	if err != nil {
		return nil, err
	}
	if input.PosterAssetID != nil {
		poster, err := c.uploadedAsset(ctx, tx, actor.OrganizationID, *input.PosterAssetID)
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(poster.MediaType, "image/") {
			return nil, fmt.Errorf("%w: the poster must be an image", ErrInvalidInput)
		}
	}
	if input.ProjectID != nil {
		exists, err := tx.Project.Query().Where(project.ID(*input.ProjectID), project.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, publishing.ErrNotFound
		}
	}
	if input.Code != nil {
		// An embed is public text: it may hold only code, never a workspace asset.
		if creativeSetKind(input.Code) != platformcreativeset.KindCode {
			return nil, invalid("Embed a Code Studio document.")
		}
		ids, err := codeDocumentAssetIDs(input.Code)
		if err != nil {
			return nil, err
		}
		if len(ids) > 0 {
			return nil, invalid("Remove the footer logo before embedding code.")
		}
	}
	token, err := newShareToken()
	if err != nil {
		return nil, err
	}
	create := tx.ShareLink.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetToken(token).
		SetAssetID(media.ID).SetNillablePosterAssetID(input.PosterAssetID).SetNillableProjectID(input.ProjectID).
		SetTitle(input.Title).SetNillableDescription(description).SetNillableAltText(altText).
		SetAccess(sharelink.Access(input.Access)).SetNillableExpiresAt(input.ExpiresAt)
	if actor.IsSession() && actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	if input.Code != nil {
		create.SetCode(input.Code)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.share_link_created", "share_link", row.ID,
		map[string]any{"access": input.Access, "assetId": media.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := shareLinkRecord(row.Unwrap(), media)
	return &record, nil
}

// ListShareLinks lists the workspace's links, newest first, revoked ones included.
func (c *Configuration) ListShareLinks(ctx context.Context, actor Actor) ([]ShareLinkRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.ShareLink.Query().Where(sharelink.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(sharelink.FieldCreatedAt)).Limit(shareListLimit).All(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.AssetID)
	}
	assets, err := c.client.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(actor.OrganizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*ent.Asset, len(assets))
	for _, media := range assets {
		byID[media.ID] = media
	}
	items := make([]ShareLinkRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, shareLinkRecord(row, byID[row.AssetID]))
	}
	return items, nil
}

// GetShareLink reads one of the workspace's links, revoked or not.
func (c *Configuration) GetShareLink(ctx context.Context, actor Actor, id string) (*ShareLinkRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.ShareLink.Query().Where(sharelink.ID(id), sharelink.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	media, err := c.client.Asset.Query().Where(asset.ID(row.AssetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	record := shareLinkRecord(row, media)
	return &record, nil
}

// UpdateShareLink changes a live link's text, access, or expiry.
func (c *Configuration) UpdateShareLink(ctx context.Context, actor Actor, id string, input ShareLinkUpdate) (*ShareLinkRecord, error) {
	if err := c.authorizeRoles(ctx, actor, shareEditRoles...); err != nil {
		return nil, err
	}
	description, okDescription := limitedText(input.Description, shareDescriptionLimit)
	altText, okAlt := limitedText(input.AltText, shareAltTextLimit)
	if !okDescription || !okAlt || (input.Access != nil && !validShareAccess(*input.Access)) ||
		!validShareExpiry(input.ExpiresAt) || (input.ClearExpiry && input.ExpiresAt != nil) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.ShareLink.Query().Where(sharelink.ID(id), sharelink.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.RevokedAt != nil {
		return nil, fmt.Errorf("%w: the link was revoked", publishing.ErrInvalidState)
	}
	update := row.Update()
	if input.Title != nil {
		title := strings.TrimSpace(*input.Title)
		if title == "" || utf8.RuneCountInString(title) > shareTitleLimit {
			return nil, ErrInvalidInput
		}
		update.SetTitle(title)
	}
	if input.Description != nil {
		if description == nil {
			update.ClearDescription()
		} else {
			update.SetDescription(*description)
		}
	}
	if input.AltText != nil {
		if altText == nil {
			update.ClearAltText()
		} else {
			update.SetAltText(*altText)
		}
	}
	if input.Access != nil {
		update.SetAccess(sharelink.Access(*input.Access))
	}
	if input.ClearExpiry {
		update.ClearExpiresAt()
	} else if input.ExpiresAt != nil {
		update.SetExpiresAt(*input.ExpiresAt)
	}
	saved, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.share_link_updated", "share_link", row.ID); err != nil {
		return nil, err
	}
	media, err := tx.Asset.Query().Where(asset.ID(saved.AssetID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := shareLinkRecord(saved.Unwrap(), media)
	return &record, nil
}

// RevokeShareLink turns a link off for good. Revoking twice is a no-op.
func (c *Configuration) RevokeShareLink(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeRoles(ctx, actor, shareEditRoles...); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, err := tx.ShareLink.Query().Where(sharelink.ID(id), sharelink.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if row.RevokedAt != nil {
		return tx.Commit()
	}
	if err := row.Update().SetRevokedAt(time.Now()).Exec(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.share_link_revoked", "share_link", row.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) liveShareLink(ctx context.Context, token string) (*ent.ShareLink, error) {
	if len(token) < 20 || len(token) > 64 {
		return nil, publishing.ErrNotFound
	}
	row, err := c.client.ShareLink.Query().Where(sharelink.Token(token), sharelink.RevokedAtIsNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if row.ExpiresAt != nil && !row.ExpiresAt.After(time.Now()) {
		return nil, publishing.ErrNotFound
	}
	return row, nil
}

// ResolveShareLink reads a live link by its token for the share page. An
// unknown, revoked, or expired token is not found.
func (c *Configuration) ResolveShareLink(ctx context.Context, token string) (*PublicShareLink, error) {
	row, err := c.liveShareLink(ctx, token)
	if err != nil {
		return nil, err
	}
	media, err := c.client.Asset.Query().Where(asset.ID(row.AssetID), asset.OrganizationID(row.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := &PublicShareLink{Access: string(row.Access), AltText: row.AltText, CreatedAt: row.CreatedAt,
		Description: row.Description, ExpiresAt: row.ExpiresAt, Height: media.Height, MediaType: media.MediaType,
		OrganizationID: row.OrganizationID, Title: row.Title, Width: media.Width, Code: row.Code}
	if row.PosterAssetID != nil {
		poster, err := c.client.Asset.Query().Where(asset.ID(*row.PosterAssetID), asset.OrganizationID(row.OrganizationID),
			asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
		if err == nil {
			result.PosterMediaType = &poster.MediaType
		}
	}
	return result, nil
}

// ShareLinkObjectURL returns a short-lived signed URL for a live link's media
// ("media") or poster ("poster"), and its media type. Storage serves the bytes
// and range requests; nothing passes through the backend.
func (c *Configuration) ShareLinkObjectURL(ctx context.Context, token, variant string) (string, string, error) {
	row, err := c.liveShareLink(ctx, token)
	if err != nil {
		return "", "", err
	}
	assetID := row.AssetID
	if variant == "poster" {
		if row.PosterAssetID == nil {
			return "", "", publishing.ErrNotFound
		}
		assetID = *row.PosterAssetID
	} else if variant != "media" {
		return "", "", ErrInvalidInput
	}
	media, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(row.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return "", "", publishing.ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if c.objects == nil {
		return "", "", ErrStorageUnavailable
	}
	url, err := c.objects.SignDownload(ctx, media.ObjectKey)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return url, media.MediaType, nil
}

// Integrations: Slack, Notion, and Figma connections. Owners and admins
// connect and disconnect; creators use connections to deliver work, which
// may refresh their tokens.

var integrationUseRoles = []string{"owner", "admin", "creator"}

// IntegrationInput connects (or reconnects) a provider account.
type IntegrationInput struct {
	DisplayName          string     `json:"displayName"`
	EncryptedCredentials string     `json:"encryptedCredentials"`
	ExternalID           string     `json:"externalId"`
	Provider             string     `json:"provider"`
	Scopes               []string   `json:"scopes"`
	TokenExpiresAt       *time.Time `json:"tokenExpiresAt"`
}

// IntegrationCredentialsUpdate stores refreshed credentials.
type IntegrationCredentialsUpdate struct {
	EncryptedCredentials string     `json:"encryptedCredentials"`
	TokenExpiresAt       *time.Time `json:"tokenExpiresAt"`
}

// IntegrationRecord is a connection without its credentials.
type IntegrationRecord struct {
	CreatedAt       time.Time  `json:"createdAt"`
	CreatedByUserID *string    `json:"createdByUserId"`
	DisplayName     string     `json:"displayName"`
	ExternalID      string     `json:"externalId"`
	ID              string     `json:"id"`
	Provider        string     `json:"provider"`
	Scopes          []string   `json:"scopes"`
	TokenExpiresAt  *time.Time `json:"tokenExpiresAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

// IntegrationWithCredentials is a connection with its encrypted credentials, for the facade only.
type IntegrationWithCredentials struct {
	IntegrationRecord
	EncryptedCredentials string `json:"encryptedCredentials"`
}

func integrationRecord(row *ent.IntegrationConnection) IntegrationRecord {
	scopes := row.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	return IntegrationRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, DisplayName: row.DisplayName,
		ExternalID: row.ExternalID, ID: row.ID, Provider: string(row.Provider), Scopes: scopes,
		TokenExpiresAt: row.TokenExpiresAt, UpdatedAt: row.UpdatedAt}
}

func validCredentials(value string) bool {
	return value != "" && len(value) <= 16384
}

// SaveIntegration connects a provider account, replacing the credentials of
// an existing connection to the same account.
func (c *Configuration) SaveIntegration(ctx context.Context, actor Actor, input IntegrationInput) (*IntegrationRecord, error) {
	if err := c.Authorize(ctx, actor); err != nil {
		return nil, err
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	provider := integrationconnection.Provider(input.Provider)
	if provider == integrationconnection.ProviderSLACK {
		return nil, fmt.Errorf("%w: connect Slack through backend OAuth", ErrInvalidInput)
	}
	if integrationconnection.ProviderValidator(provider) != nil || input.ExternalID == "" || len(input.ExternalID) > 200 ||
		input.DisplayName == "" || utf8.RuneCountInString(input.DisplayName) > 200 ||
		!validCredentials(input.EncryptedCredentials) || len(input.Scopes) > 50 {
		return nil, ErrInvalidInput
	}
	if input.Scopes == nil {
		input.Scopes = []string{}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	existing, err := tx.IntegrationConnection.Query().Where(integrationconnection.OrganizationID(actor.OrganizationID),
		integrationconnection.ProviderEQ(provider), integrationconnection.ExternalID(input.ExternalID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	var row *ent.IntegrationConnection
	if existing != nil {
		update := existing.Update().SetDisplayName(input.DisplayName).SetEncryptedCredentials(input.EncryptedCredentials).
			SetScopes(input.Scopes)
		if input.TokenExpiresAt != nil {
			update.SetTokenExpiresAt(*input.TokenExpiresAt)
		} else {
			update.ClearTokenExpiresAt()
		}
		row, err = update.Save(ctx)
	} else {
		create := tx.IntegrationConnection.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetProvider(provider).SetExternalID(input.ExternalID).SetDisplayName(input.DisplayName).
			SetEncryptedCredentials(input.EncryptedCredentials).SetScopes(input.Scopes).
			SetNillableTokenExpiresAt(input.TokenExpiresAt)
		if actor.IsSession() && actor.UserID != "" {
			create.SetCreatedByUserID(actor.UserID)
		}
		row, err = create.Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "integration.connected", "product.integration_connected", "integration_connection", row.ID,
		map[string]any{"provider": input.Provider}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := integrationRecord(row.Unwrap())
	return &record, nil
}

// ListIntegrations lists the workspace's connections, without credentials.
func (c *Configuration) ListIntegrations(ctx context.Context, actor Actor) ([]IntegrationRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.IntegrationConnection.Query().Where(integrationconnection.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(integrationconnection.FieldProvider), ent.Asc(integrationconnection.FieldDisplayName)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]IntegrationRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, integrationRecord(row))
	}
	return items, nil
}

func (c *Configuration) integration(ctx context.Context, actor Actor, id string) (*ent.IntegrationConnection, error) {
	row, err := c.client.IntegrationConnection.Query().Where(integrationconnection.ID(id),
		integrationconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return row, err
}

// IntegrationCredentials returns a connection with its encrypted credentials, to deliver work through it.
func (c *Configuration) IntegrationCredentials(ctx context.Context, actor Actor, id string) (*IntegrationWithCredentials, error) {
	if err := c.authorizeRoles(ctx, actor, integrationUseRoles...); err != nil {
		return nil, err
	}
	row, err := c.integration(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if row.Provider == integrationconnection.ProviderSLACK {
		return nil, publishing.ErrForbidden
	}
	return &IntegrationWithCredentials{IntegrationRecord: integrationRecord(row), EncryptedCredentials: row.EncryptedCredentials}, nil
}

// UpdateIntegrationCredentials stores credentials refreshed while delivering work.
func (c *Configuration) UpdateIntegrationCredentials(ctx context.Context, actor Actor, id string, input IntegrationCredentialsUpdate) error {
	if err := c.authorizeRoles(ctx, actor, integrationUseRoles...); err != nil {
		return err
	}
	if !validCredentials(input.EncryptedCredentials) {
		return ErrInvalidInput
	}
	row, err := c.integration(ctx, actor, id)
	if err != nil {
		return err
	}
	if row.Provider == integrationconnection.ProviderSLACK {
		return publishing.ErrForbidden
	}
	update := row.Update().SetEncryptedCredentials(input.EncryptedCredentials)
	if input.TokenExpiresAt != nil {
		update.SetTokenExpiresAt(*input.TokenExpiresAt)
	} else {
		update.ClearTokenExpiresAt()
	}
	return update.Exec(ctx)
}

// DeleteIntegration disconnects a provider account and forgets its credentials.
func (c *Configuration) DeleteIntegration(ctx context.Context, actor Actor, id string) error {
	if err := c.Authorize(ctx, actor); err != nil {
		return err
	}
	row, err := c.integration(ctx, actor, id)
	if err != nil {
		return err
	}
	if row.Provider == integrationconnection.ProviderSLACK {
		if c.notifications == nil {
			return notifications.ErrUnavailable
		}
		return c.notifications.Disconnect(ctx, notifications.Principal{OrganizationID: actor.OrganizationID, UserID: actor.UserID, SessionID: actor.SessionID, Kind: actor.Kind}, id)
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	deleted, err := tx.IntegrationConnection.Delete().Where(integrationconnection.ID(id),
		integrationconnection.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return publishing.ErrNotFound
	}
	if err := recordProductActivity(ctx, tx, actor, "integration.disconnected", "product.integration_disconnected", "integration_connection", id); err != nil {
		return err
	}
	return tx.Commit()
}
