package product

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitexport"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"net/url"
	"time"
)

// Private bytes are returned only to a current human member. The web applies
// its visible preview watermark; this endpoint never grants export authority.
type KitArtifactPreview struct {
	Body      []byte `json:"body"`
	MediaType string `json:"mediaType"`
}

func (c *Configuration) GetKitArtifactPreview(ctx context.Context, actor Actor, releaseID, revisionID, artifactID string) (*KitArtifactPreview, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if !qualificationID(releaseID) || !qualificationID(revisionID) || !qualificationID(artifactID) {
		return nil, ErrInvalidInput
	}
	if err := c.authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	revision, err := loadKitRevision(ctx, c.client, actor.OrganizationID, releaseID, revisionID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, a := range revision.Manifest.Artifacts {
		if a.ArtifactRevisionID == artifactID {
			found = true
		}
	}
	if !found {
		return nil, publishing.ErrNotFound
	}
	artifact, err := c.client.KitArtifactRevision.Query().Where(kitartifactrevision.OrganizationID(actor.OrganizationID), kitartifactrevision.ReleaseID(releaseID), kitartifactrevision.ID(artifactID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if artifact.PreparedAt == nil {
		return nil, publishing.ErrInvalidState
	}
	body, err := c.readKitObject(ctx, optionalString(artifact.OutputKey), optionalString(artifact.OutputSha256), artifact.OutputBytes)
	if err != nil {
		return nil, err
	}
	if err := c.authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	return &KitArtifactPreview{Body: body, MediaType: artifact.MediaType}, nil
}

func (c *Configuration) kitDownloadURL(actor Actor, releaseID, exportID string) (string, error) {
	if c.assetDownloadCipher == nil || c.assetDownloadOrigin == "" {
		return "", ErrStorageUnavailable
	}
	actor.Display, actor.RequestID = "", ""
	token, err := c.sealAssetDownload(assetDownloadGrant{Actor: actor, ReleaseID: releaseID, KitExportID: exportID, ExpiresAt: time.Now().Add(assetDownloadLifetime()).Unix()})
	if err != nil {
		return "", err
	}
	return c.assetDownloadOrigin + "/api/v1/releases/" + url.PathEscape(releaseID) + "/kit-exports/" + url.PathEscape(exportID) + "/content?downloadToken=" + token, nil
}

// Every redemption rechecks the original principal and current kit dependencies,
// including after storage I/O; no unrevocable object-store redirect is exposed.
func (c *Configuration) ReadKitExportDownload(ctx context.Context, releaseID, exportID, token, requestID string) ([]byte, error) {
	grant, err := c.openDownloadGrant(token)
	if err != nil {
		return nil, err
	}
	if grant.AssetID != "" || grant.ReleaseID != releaseID || grant.KitExportID != exportID {
		return nil, publishing.ErrUnauthorized
	}
	actor := grant.Actor
	actor.RequestID = requestID
	if err := c.authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	row, err := c.client.KitExport.Query().Where(kitexport.OrganizationID(actor.OrganizationID), kitexport.ReleaseID(releaseID), kitexport.ID(exportID), kitexport.StateEQ(kitexport.StateREADY)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	check := func() error {
		return c.authorizedKitUse(ctx, actor, releaseID, row.KitRevisionID, func(context.Context, *ent.Tx, *ent.ReleaseReadiness, *ent.KitRevision) error { return nil })
	}
	if err := check(); err != nil {
		return nil, err
	}
	body, err := c.readKitObject(ctx, optionalString(row.ObjectKey), optionalString(row.Sha256), row.Bytes)
	if err != nil {
		return nil, err
	}
	if err := check(); err != nil {
		return nil, err
	}
	return body, nil
}
