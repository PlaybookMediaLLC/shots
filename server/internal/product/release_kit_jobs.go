package product

import (
	"bytes"
	"context"
	"errors"
	"io"
	"slices"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
)

type KitRenderRequest struct {
	OrganizationID string                     `json:"organizationId"`
	ArtifactID     string                     `json:"artifactId"`
	Snapshot       releasekits.NativeSnapshot `json:"snapshot"`
	// Pinned bytes are resolved by the Go owner, never fetched from a live URL.
	Assets     map[string]string `json:"assets"`
	AssetPaths map[string]string `json:"assetPaths"`
}
type KitRenderOutput struct {
	Body            []byte `json:"body"`
	MediaType       string `json:"mediaType"`
	RendererVersion string `json:"rendererVersion"`
}
type kitSnapshotRenderer interface {
	RenderKit(context.Context, KitRenderRequest) (KitRenderOutput, error)
}

// Jobs carry persisted delegation and current membership, never an expiring
// browser cookie. Revocation and organization deletion hold the same locks.
func (c *Configuration) kitJobTransaction(ctx context.Context, org, releaseID, revisionID, userID, permission string, apply func(context.Context, *ent.Tx, *ent.ReleaseReadiness, *ent.KitRevision) error) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SET LOCAL lock_timeout = '2s'`); err != nil {
		return err
	}
	found, err := workspaceplan.LockWorkspace(ctx, tx, org)
	if err != nil {
		return err
	}
	if !found {
		return publishing.ErrNotFound
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR SHARE`, userID); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE`, org, userID); err != nil {
		return err
	}
	active, err := tx.User.Query().Where(user.ID(userID), user.Or(user.BannedIsNil(), user.Banned(false))).Exist(ctx)
	if err != nil {
		return err
	}
	if !active {
		return publishing.ErrForbidden
	}
	role, err := memberRole(ctx, tx.Client(), org, userID)
	if err != nil {
		return err
	}
	roles := readRoles
	if permission == "release:create" {
		roles = launchEditRoles
	}
	if permission == "release:approve" {
		roles = launchApproveRoles
	}
	if !workspaceroles.Allows(role, roles...) {
		return publishing.ErrForbidden
	}
	if err := requireNotDenied(ctx, tx.Client(), Actor{OrganizationID: org, UserID: userID}, permission); err != nil {
		return err
	}
	config := NewConfiguration(tx.Client())
	if err := config.auth.AuthorizeWorkspace(ctx, org); err != nil {
		return err
	}
	if err := config.requireWorkspaceFeature(ctx, org, "release:create"); err != nil {
		return err
	}
	enabled, err := qualificationEnabled(ctx, tx.Client(), org)
	if err != nil {
		return err
	}
	if !enabled {
		return publishing.ErrForbidden
	}
	if err := lockKitDependencies(ctx, tx, org, releaseID, revisionID); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM release WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, org, releaseID); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR UPDATE`, org, releaseID); err != nil {
		return err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(org), releasereadiness.ReleaseID(releaseID)).Only(ctx)
	if err != nil {
		return err
	}
	revision, err := loadKitRevision(ctx, tx.Client(), org, releaseID, revisionID)
	if err != nil {
		return err
	}
	if err := apply(ctx, tx, root, revision); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) processKitPreparation(ctx context.Context, org, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	revision, err := c.client.KitRevision.Query().Where(kitrevision.OrganizationID(org), kitrevision.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	if revision.State != kitrevision.StateBUILDING {
		return nil
	}
	var artifacts []*ent.KitArtifactRevision
	err = c.kitJobTransaction(ctx, org, revision.ReleaseID, id, revision.RequestedByUserID, "release:create", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, current *ent.KitRevision) error {
		if current.State != kitrevision.StateBUILDING {
			return publishing.ErrInvalidState
		}
		snapshot, rows, _, err := loadKitReadiness(ctx, tx.Client(), Actor{OrganizationID: org}, root, current)
		if err != nil {
			return err
		}
		if !snapshot.Current {
			return publishing.ErrInvalidState
		}
		artifacts = rows
		return nil
	})
	if err != nil {
		return c.failKitPreparation(ctx, revision, kitFailureCode(err))
	}
	if c.objects == nil {
		return c.failKitPreparation(ctx, revision, "STORAGE_UNAVAILABLE")
	}
	var total int64
	for _, a := range artifacts {
		if a.PreparedAt != nil {
			if _, err := c.readKitObject(ctx, optionalString(a.OutputKey), optionalString(a.OutputSha256), a.OutputBytes); err != nil {
				return c.failKitPreparation(ctx, revision, "OUTPUT_MISSING")
			}
			total += a.OutputBytes
			continue
		}
		paths := map[string]string{}
		for _, image := range artifacts {
			if image.Snapshot.Kind == "ASSET" && image.AudienceID == a.AudienceID {
				paths[image.Snapshot.SourceID] = kitManifestArtifact(image).FileName
			}
		}
		output, err := c.renderKitArtifact(ctx, org, a, paths)
		if err != nil {
			return c.failKitPreparation(ctx, revision, kitFailureCode(err))
		}
		total += int64(len(output.Body))
		if total > releasekits.MaxBundleBytes {
			return c.failKitPreparation(ctx, revision, "BUNDLE_TOO_LARGE")
		}
		if err := c.persistKitArtifact(ctx, revision, a, output); err != nil {
			return c.failKitPreparation(ctx, revision, kitFailureCode(err))
		}
	}
	if total > releasekits.MaxBundleBytes {
		return c.failKitPreparation(ctx, revision, "BUNDLE_TOO_LARGE")
	}
	err = c.kitJobTransaction(ctx, org, revision.ReleaseID, id, revision.RequestedByUserID, "release:create", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, current *ent.KitRevision) error {
		if current.State != kitrevision.StateBUILDING {
			if current.PreparedAt != nil {
				return nil
			}
			return publishing.ErrInvalidState
		}
		snapshot, rows, _, err := loadKitReadiness(ctx, tx.Client(), Actor{OrganizationID: org}, root, current)
		if err != nil {
			return err
		}
		if !snapshot.Current {
			return publishing.ErrInvalidState
		}
		if len(snapshot.DependencyBlockers) > 0 {
			return kitBlocked(releasekits.Evaluate(snapshot))
		}
		manifest := current.Manifest
		manifest.Artifacts = []releasekits.Artifact{}
		for _, a := range rows {
			if a.PreparedAt == nil {
				return ErrStorageUnavailable
			}
			// New snapshots must still match the inputs acknowledged before the
			// job. Reused prepared artifacts intentionally ignore scratch edits.
			wasNew := slices.ContainsFunc(artifacts, func(before *ent.KitArtifactRevision) bool { return before.ID == a.ID && before.PreparedAt == nil })
			if wasNew {
				if err := checkKitNativeCurrent(ctx, tx, org, a.Snapshot); err != nil {
					return err
				}
			}
			manifest.Artifacts = append(manifest.Artifacts, kitManifestArtifact(a))
		}
		hash, canonical, err := releasefacts.CanonicalHash("shots.release-kit.v1", manifest)
		if err != nil {
			return err
		}
		return tx.KitRevision.UpdateOneID(id).SetManifest(manifest).SetManifestSha256(hash).SetManifestCanonical(string(canonical)).SetPreparedAt(time.Now().UTC()).SetState(kitrevision.StateREVIEWABLE).Exec(ctx)
	})
	if err != nil {
		return c.failKitPreparation(ctx, revision, kitFailureCode(err))
	}
	return nil
}

func kitFailureCode(err error) string {
	var conflict *QualificationError
	if errors.As(err, &conflict) {
		return conflict.Reason
	}
	var gate *KitReadinessError
	if errors.As(err, &gate) {
		return gate.Reason
	}
	if errors.Is(err, publishing.ErrForbidden) {
		return "REQUESTER_REVOKED"
	}
	if errors.Is(err, ErrStorageQuota) {
		return "STORAGE_QUOTA"
	}
	if errors.Is(err, ErrRendererRefused) || errors.Is(err, ErrInvalidInput) {
		return "RENDER_REFUSED"
	}
	return "PREPARATION_FAILED"
}

func (c *Configuration) failKitPreparation(ctx context.Context, revision *ent.KitRevision, code string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	// Failure is durable product state, even when the requester's membership
	// was revoked. This cannot approve, export or create new work.
	_, err := c.client.KitRevision.Update().Where(kitrevision.OrganizationID(revision.OrganizationID), kitrevision.ID(revision.ID), kitrevision.StateEQ(kitrevision.StateBUILDING)).SetState(kitrevision.StateFAILED).SetFailureCode(code).Save(ctx)
	return err
}

func (c *Configuration) readKitObject(ctx context.Context, key, hash string, size int64) ([]byte, error) {
	if c.objects == nil || key == "" || size <= 0 || size > releasekits.MaxBundleBytes {
		return nil, ErrStorageUnavailable
	}
	body, err := c.openObject(ctx, key)
	if err != nil {
		return nil, err
	}
	defer body.Close()
	raw, err := io.ReadAll(io.LimitReader(body, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) != size || releasefacts.ByteHash(raw) != hash {
		return nil, ErrStorageUnavailable
	}
	return raw, nil
}

func (c *Configuration) renderKitArtifact(ctx context.Context, org string, a *ent.KitArtifactRevision, paths map[string]string) (KitRenderOutput, error) {
	if a.OutputKey != nil {
		body, err := c.readKitObject(ctx, *a.OutputKey, optionalString(a.OutputSha256), a.OutputBytes)
		if err == nil {
			return KitRenderOutput{Body: body, MediaType: a.MediaType, RendererVersion: a.RendererVersion}, nil
		}
	}
	result := KitRenderOutput{RendererVersion: releasekits.ExporterVersion}
	switch a.Snapshot.Kind {
	case "TEMPLATE":
		result.Body = []byte(a.Snapshot.Markdown)
		result.MediaType = "text/markdown; charset=utf-8"
	case "ASSET":
		if len(a.Snapshot.Assets) != 1 {
			return result, ErrInvalidInput
		}
		pin := a.Snapshot.Assets[0]
		body, err := c.readKitObject(ctx, pin.ObjectKey, pin.SHA256, pin.ByteLength)
		if err != nil {
			return result, err
		}
		result.Body, result.MediaType = body, pin.MediaType
	default:
		renderer, ok := c.automationRenderer.(kitSnapshotRenderer)
		if !ok {
			return result, ErrAutomationRendererUnavailable
		}
		request := KitRenderRequest{OrganizationID: org, ArtifactID: a.ID, Snapshot: a.Snapshot, Assets: map[string]string{}, AssetPaths: paths}
		for _, pin := range a.Snapshot.Assets {
			body, err := c.readKitObject(ctx, pin.ObjectKey, pin.SHA256, pin.ByteLength)
			if err != nil {
				return result, err
			}
			request.Assets[pin.ID] = encodeKitAsset(pin.MediaType, body)
		}
		var err error
		result, err = renderer.RenderKit(ctx, request)
		if err != nil {
			return result, err
		}
	}
	if len(result.Body) == 0 || len(result.Body) > releasekits.MaxBundleBytes || result.RendererVersion != releasekits.ExporterVersion {
		return result, ErrRendererRefused
	}
	if a.Kind == kitartifactrevision.KindSCREENSHOT {
		if !slices.Contains([]string{"image/png", "image/jpeg", "image/webp"}, result.MediaType) {
			return result, ErrRendererRefused
		}
		if err := verifyAssetBytes(result.MediaType, bytes.NewReader(result.Body)); err != nil {
			return result, err
		}
	} else if result.MediaType != "text/markdown; charset=utf-8" || len(result.Body) > releasekits.MaxDocumentBytes {
		return result, ErrRendererRefused
	}
	if a.OutputSha256 != nil && *a.OutputSha256 != releasefacts.ByteHash(result.Body) {
		return result, ErrRendererRefused
	}
	return result, nil
}

func (c *Configuration) persistKitArtifact(ctx context.Context, revision *ent.KitRevision, a *ent.KitArtifactRevision, output KitRenderOutput) error {
	hash := releasefacts.ByteHash(output.Body)
	key := "org/" + revision.OrganizationID + "/release-kits/artifacts/" + a.ID + "/" + hash
	err := c.kitJobTransaction(ctx, revision.OrganizationID, revision.ReleaseID, revision.ID, revision.RequestedByUserID, "release:create", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, current *ent.KitRevision) error {
		if current.State != kitrevision.StateBUILDING {
			return publishing.ErrInvalidState
		}
		row, err := tx.KitArtifactRevision.Query().Where(kitartifactrevision.OrganizationID(revision.OrganizationID), kitartifactrevision.ID(a.ID)).Only(ctx)
		if err != nil {
			return err
		}
		if row.OutputSha256 != nil {
			if *row.OutputSha256 != hash {
				return ErrRendererRefused
			}
			return nil
		}
		entitlement, err := tx.WorkspaceEntitlement.Get(ctx, revision.OrganizationID)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		plan, _, _ := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
		if err := reserveStorage(ctx, tx, revision.OrganizationID, plan, len(output.Body)); err != nil {
			return err
		}
		return tx.KitArtifactRevision.UpdateOneID(a.ID).SetOutputKey(key).SetOutputSha256(hash).SetOutputBytes(int64(len(output.Body))).SetMediaType(output.MediaType).SetRendererVersion(output.RendererVersion).Exec(ctx)
	})
	if err != nil {
		return err
	}
	// Reserving the durable key before I/O makes crash leftovers discoverable
	// by retry and workspace cleanup; a retry must reproduce the reserved hash.
	if err := c.objects.Put(ctx, key, output.MediaType, bytes.NewReader(output.Body)); err != nil {
		return err
	}
	if _, err := c.readKitObject(ctx, key, hash, int64(len(output.Body))); err != nil {
		return err
	}
	return c.kitJobTransaction(ctx, revision.OrganizationID, revision.ReleaseID, revision.ID, revision.RequestedByUserID, "release:create", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, current *ent.KitRevision) error {
		if current.State != kitrevision.StateBUILDING {
			return publishing.ErrInvalidState
		}
		row, err := tx.KitArtifactRevision.Query().Where(kitartifactrevision.OrganizationID(revision.OrganizationID), kitartifactrevision.ID(a.ID)).Only(ctx)
		if err != nil {
			return err
		}
		if row.PreparedAt != nil {
			return nil
		}
		return tx.KitArtifactRevision.UpdateOneID(a.ID).SetPreparedAt(time.Now().UTC()).Exec(ctx)
	})
}
