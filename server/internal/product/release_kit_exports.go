package product

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitexport"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/lucsky/cuid"
)

func encodeKitAsset(mediaType string, body []byte) string {
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(body)
}

// RenderKit uses the existing signed web renderer, with immutable native inputs.
func (r *HTTPAutomationRenderer) RenderKit(ctx context.Context, input KitRenderRequest) (KitRenderOutput, error) {
	var result KitRenderOutput
	body, err := json.Marshal(input)
	if err != nil {
		return result, err
	}
	if len(body) > 140<<20 {
		return result, ErrRendererRefused
	}
	url := strings.TrimSuffix(r.URL, "/api/internal/workflow-renders") + "/api/internal/kit-renders"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-shots-signature", SignWorkflowRender(r.Key, body, time.Now()))
	response, err := r.HTTP.Do(request)
	if err != nil {
		return result, ErrAutomationRendererUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 && response.StatusCode < 500 && response.StatusCode != 429 {
		return result, ErrRendererRefused
	}
	if response.StatusCode != 200 {
		return result, ErrAutomationRendererUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, (140<<20)+1))
	if err != nil {
		return result, err
	}
	if len(raw) > 140<<20 {
		return result, ErrRendererRefused
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, ErrRendererRefused
	}
	return result, nil
}

type RequestKitExportInput struct {
	ExpectedRevision string   `json:"expectedRevision"`
	ManifestSHA256   string   `json:"manifestSha256"`
	AudienceIDs      []string `json:"audienceIds"`
}

func (c *Configuration) RequestKitExport(ctx context.Context, actor Actor, releaseID, revisionID, key string, input RequestKitExportInput) (*ReadinessMutation, error) {
	if !qualificationID(revisionID) || !assetHashPattern.MatchString(input.ManifestSHA256) || len(input.AudienceIDs) < 1 || len(input.AudienceIDs) > 20 || len(sortedUnique(input.AudienceIDs)) != len(input.AudienceIDs) {
		return nil, ErrInvalidInput
	}
	policy := readinessCommandPolicy{permission: "artifact:read", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockKitDependencies(ctx, tx, actor.OrganizationID, releaseID, revisionID)
	}}
	request := struct {
		RevisionID string                `json:"revisionId"`
		Input      RequestKitExportInput `json:"input"`
	}{revisionID, input}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_kit.export_requested", request, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
		if err != nil {
			return nil, err
		}
		if revision.ManifestSha256 != input.ManifestSHA256 {
			return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
		}
		snapshot, _, _, err := loadKitReadiness(ctx, tx.Client(), actor, root, revision)
		if err != nil {
			return nil, err
		}
		readiness := releasekits.Evaluate(snapshot)
		if !readiness.CanExportApproved {
			return nil, kitBlocked(readiness)
		}
		for _, id := range input.AudienceIDs {
			if !slices.ContainsFunc(snapshot.Requirements, func(a releasefacts.Audience) bool { return a.ID == id }) {
				return nil, ErrInvalidInput
			}
		}
		audiences := sortedUnique(input.AudienceIDs)
		scope, _, err := releasefacts.CanonicalHash("shots.kit-export-scope.v1", audiences)
		if err != nil {
			return nil, err
		}
		existing, err := tx.KitExport.Query().Where(kitexport.OrganizationID(actor.OrganizationID), kitexport.KitRevisionID(revisionID), kitexport.AudienceScope(scope), kitexport.ExportVersion(1)).Only(ctx)
		if err == nil {
			if existing.State == kitexport.StateFAILED {
				return nil, qualificationConflict("OUTPUT_INCOMPLETE", root.HeadRevision)
			}
			return []string{existing.ID, revisionID}, nil
		}
		if !ent.IsNotFound(err) {
			return nil, err
		}
		export, err := tx.KitExport.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetKitRevisionID(revisionID).SetAudienceIds(audiences).SetAudienceScope(scope).SetRequestedByUserID(actor.UserID).SetFileIndex(releasekits.PublicIndex{SchemaVersion: 1, ReleaseID: releaseID, KitRevisionID: revisionID, AudienceIDs: audiences, Files: []releasekits.File{}}).Save(ctx)
		if err != nil {
			return nil, err
		}
		if err := kitOutbox(ctx, tx, actor.OrganizationID, EventKitExport, "kit_export", export.ID, export.ID); err != nil {
			return nil, err
		}
		return []string{export.ID, revisionID}, nil
	})
}

func (c *Configuration) processKitExport(ctx context.Context, org, id string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	export, err := c.client.KitExport.Query().Where(kitexport.OrganizationID(org), kitexport.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	if export.State != kitexport.StateBUILDING {
		return nil
	}
	var artifacts []*ent.KitArtifactRevision
	gate := func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, revision *ent.KitRevision) error {
		snapshot, rows, _, err := loadKitReadiness(ctx, tx.Client(), Actor{OrganizationID: org}, root, revision)
		if err != nil {
			return err
		}
		readiness := releasekits.Evaluate(snapshot)
		if !readiness.CanExportApproved {
			return kitBlocked(readiness)
		}
		artifacts = rows
		return nil
	}
	if err := c.kitJobTransaction(ctx, org, export.ReleaseID, export.KitRevisionID, export.RequestedByUserID, "artifact:read", gate); err != nil {
		return c.failKitExport(ctx, export, kitFailureCode(err))
	}
	files := map[string][]byte{}
	index := export.FileIndex
	index.Files = []releasekits.File{}
	var total int64
	for _, a := range artifacts {
		if !slices.Contains(export.AudienceIds, a.AudienceID) {
			continue
		}
		total += a.OutputBytes
		if total > releasekits.MaxBundleBytes {
			return c.failKitExport(ctx, export, "BUNDLE_TOO_LARGE")
		}
		body, err := c.readKitObject(ctx, optionalString(a.OutputKey), optionalString(a.OutputSha256), a.OutputBytes)
		if err != nil {
			return c.failKitExport(ctx, export, "OUTPUT_MISSING")
		}
		name := kitManifestArtifact(a).FileName
		files[name] = body
		index.Files = append(index.Files, releasekits.File{Name: name, SHA256: optionalString(a.OutputSha256), ByteLength: len(body)})
	}
	bundle, err := releasekits.Bundle(index, files)
	if err != nil {
		return c.failKitExport(ctx, export, "INVALID_BUNDLE")
	}
	hash := releasefacts.ByteHash(bundle)
	key := "org/" + org + "/release-kits/exports/" + id + "/" + hash + ".zip"
	err = c.kitJobTransaction(ctx, org, export.ReleaseID, export.KitRevisionID, export.RequestedByUserID, "artifact:read", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, revision *ent.KitRevision) error {
		if err := gate(ctx, tx, root, revision); err != nil {
			return err
		}
		current, err := tx.KitExport.Query().Where(kitexport.OrganizationID(org), kitexport.ID(id)).Only(ctx)
		if err != nil {
			return err
		}
		if current.Sha256 != nil {
			if *current.Sha256 != hash {
				return ErrStorageUnavailable
			}
			return nil
		}
		entitlement, err := tx.WorkspaceEntitlement.Get(ctx, org)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		plan, _, _ := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
		if err := reserveStorage(ctx, tx, org, plan, len(bundle)); err != nil {
			return err
		}
		return tx.KitExport.UpdateOneID(id).SetObjectKey(key).SetSha256(hash).SetBytes(int64(len(bundle))).SetFileIndex(index).Exec(ctx)
	})
	if err != nil {
		return c.failKitExport(ctx, export, kitFailureCode(err))
	}
	if c.objects == nil {
		return c.failKitExport(ctx, export, "STORAGE_UNAVAILABLE")
	}
	if err := c.objects.Put(ctx, key, "application/zip", bytes.NewReader(bundle)); err != nil {
		return c.failKitExport(ctx, export, "STORAGE_UNAVAILABLE")
	}
	if _, err := c.readKitObject(ctx, key, hash, int64(len(bundle))); err != nil {
		return c.failKitExport(ctx, export, "OUTPUT_MISSING")
	}
	err = c.kitJobTransaction(ctx, org, export.ReleaseID, export.KitRevisionID, export.RequestedByUserID, "artifact:read", func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, revision *ent.KitRevision) error {
		if err := gate(ctx, tx, root, revision); err != nil {
			return err
		}
		_, err := tx.KitExport.Update().Where(kitexport.OrganizationID(org), kitexport.ID(id), kitexport.StateEQ(kitexport.StateBUILDING)).SetState(kitexport.StateREADY).Save(ctx)
		return err
	})
	if err != nil {
		return c.failKitExport(ctx, export, kitFailureCode(err))
	}
	return nil
}

func (c *Configuration) failKitExport(ctx context.Context, export *ent.KitExport, code string) error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := c.client.KitExport.Update().Where(kitexport.OrganizationID(export.OrganizationID), kitexport.ID(export.ID), kitexport.StateEQ(kitexport.StateBUILDING)).SetState(kitexport.StateFAILED).SetFailureCode(code).Save(ctx)
	return err
}

type KitExportRecord struct {
	ID          string                  `json:"id"`
	State       string                  `json:"state"`
	SHA256      *string                 `json:"sha256"`
	FailureCode string                  `json:"failureCode"`
	FileIndex   releasekits.PublicIndex `json:"fileIndex"`
	DownloadURL *string                 `json:"downloadUrl"`
}

// GetKitExport mints a short-lived URL only after authenticating the current
// caller and evaluating live dependencies. Stored bytes cannot be recalled.
func (c *Configuration) GetKitExport(ctx context.Context, actor Actor, releaseID, exportID string, download bool) (*KitExportRecord, error) {
	if !qualificationID(releaseID) || !qualificationID(exportID) {
		return nil, ErrInvalidInput
	}
	if err := c.authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	export, err := c.client.KitExport.Query().Where(kitexport.OrganizationID(actor.OrganizationID), kitexport.ReleaseID(releaseID), kitexport.ID(exportID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := &KitExportRecord{ID: export.ID, State: string(export.State), SHA256: export.Sha256, FailureCode: export.FailureCode, FileIndex: export.FileIndex}
	if !download {
		return result, nil
	}
	if export.State != kitexport.StateREADY || export.ObjectKey == nil || c.objects == nil {
		return nil, qualificationConflict("OUTPUT_INCOMPLETE", 0)
	}
	if _, err := c.readKitObject(ctx, *export.ObjectKey, optionalString(export.Sha256), export.Bytes); err != nil {
		return nil, ErrStorageUnavailable
	}
	url, err := c.kitDownloadURL(actor, releaseID, export.ID)
	if err != nil {
		return nil, err
	}
	err = c.authorizedKitUse(ctx, actor, releaseID, export.KitRevisionID, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness, revision *ent.KitRevision) error {
		return nil
	})
	if err != nil {
		return nil, err
	}
	result.DownloadURL = &url
	return result, nil
}

func (c *Configuration) authorizedKitUse(ctx context.Context, actor Actor, releaseID, revisionID string, apply func(context.Context, *ent.Tx, *ent.ReleaseReadiness, *ent.KitRevision) error) error {
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
	if err := lockQualificationAuthority(ctx, tx, actor, "artifact:read"); err != nil {
		return err
	}
	enabled, err := qualificationEnabled(ctx, tx.Client(), actor.OrganizationID)
	if err != nil {
		return err
	}
	if !enabled {
		return publishing.ErrForbidden
	}
	if err := lockKitDependencies(ctx, tx, actor.OrganizationID, releaseID, revisionID); err != nil {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR SHARE`, actor.OrganizationID, releaseID); err != nil {
		return err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(releaseID)).Only(ctx)
	if err != nil {
		return err
	}
	revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
	if err != nil {
		return err
	}
	snapshot, _, _, err := loadKitReadiness(ctx, tx.Client(), actor, root, revision)
	if err != nil {
		return err
	}
	readiness := releasekits.Evaluate(snapshot)
	if !readiness.CanExportApproved {
		return kitBlocked(readiness)
	}
	if err := apply(ctx, tx, root, revision); err != nil {
		return err
	}
	return tx.Commit()
}

var _ kitSnapshotRenderer = (*HTTPAutomationRenderer)(nil)
