package product

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimpathbinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaimversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasespec"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type ImportReleaseSpecInput struct {
	ExpectedRevision string `json:"expectedRevision"`
	SpecID           string `json:"specId"`
}

func (c *Configuration) ImportReleaseSpecClaims(ctx context.Context, actor Actor, releaseID, key string, input ImportReleaseSpecInput) (*ReadinessMutation, error) {
	if input.SpecID != "" && !qualificationID(input.SpecID) {
		return nil, ErrInvalidInput
	}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_claim.legacy_imported", input, readinessCommandPolicy{permission: "release:create"}, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		if input.SpecID == "" {
			return backfillReleaseSpecClaims(ctx, tx, actor, root)
		}
		spec, err := tx.ReleaseSpec.Query().Where(releasespec.OrganizationID(actor.OrganizationID), releasespec.ReleaseID(releaseID), releasespec.ID(input.SpecID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		_, ids, err := importSpecClaims(ctx, tx, actor, spec, nil, false)
		if err != nil {
			return nil, err
		}
		return append([]string{spec.ID}, ids...), nil
	})
}

// Called in the existing spec transaction. Ordinary legacy approvals retain
// their history; this bridge can only create unresolved claim coverage.
func importNewReleaseSpec(ctx context.Context, tx *ent.Tx, actor Actor, spec, previous *ent.ReleaseSpec) error {
	enabled, err := qualificationEnabled(ctx, tx.Client(), actor.OrganizationID)
	if err != nil || !enabled {
		return err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR UPDATE`, actor.OrganizationID, spec.ReleaseID); err != nil {
		return err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(spec.ReleaseID)).Only(ctx)
	if ent.IsNotFound(err) {
		root, err = tx.ReleaseReadiness.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(spec.ReleaseID).Save(ctx)
	}
	if err != nil {
		return err
	}
	if root.HeadRevision == math.MaxInt64 {
		return publishing.ErrConflict
	}
	content, _, err := importSpecClaims(ctx, tx, actor, spec, previous, true)
	if err != nil {
		return err
	}
	if err := tx.ReleaseSpec.UpdateOneID(spec.ID).SetContent(content).Exec(ctx); err != nil {
		return err
	}
	spec.Content = content
	return tx.ReleaseReadiness.UpdateOneID(root.ID).AddHeadRevision(1).Exec(ctx)
}

func importSpecClaims(ctx context.Context, tx *ent.Tx, actor Actor, spec, previous *ent.ReleaseSpec, enrich bool) (json.RawMessage, []string, error) {
	existing, err := tx.ClaimPathBinding.Query().Where(claimpathbinding.OrganizationID(actor.OrganizationID), claimpathbinding.SpecID(spec.ID)).Order(ent.Asc(claimpathbinding.FieldLegacyPath)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	if len(existing) > 0 {
		ids := []string{}
		for _, binding := range existing {
			ids = append(ids, binding.ClaimVersionID)
		}
		return spec.Content, ids, nil
	}
	paths, document, err := releasefacts.LegacySpecClaims(spec.Content)
	if err != nil {
		return nil, nil, ErrInvalidInput
	}
	origin := "AI"
	if spec.Origin == "human" {
		origin = "HUMAN"
	}
	seen := map[string]bool{}
	ids := []string{}
	for i := range paths {
		path := &paths[i]
		var claim *ent.ReleaseClaim
		var version *ent.ReleaseClaimVersion
		qualifiers := releasefacts.ClaimQualifiers{}
		number := int64(1)
		if path.ClaimID != "" {
			if !qualificationID(path.ClaimID) || !qualificationID(path.ClaimVersionID) || seen[path.ClaimID] {
				return nil, nil, ErrInvalidInput
			}
			claim, err = releaseClaim(ctx, tx.Client(), actor.OrganizationID, spec.ReleaseID, path.ClaimID)
			if err != nil {
				return nil, nil, err
			}
			if claim.CurrentVersionID == nil || *claim.CurrentVersionID != path.ClaimVersionID {
				return nil, nil, publishing.ErrConflict
			}
			version, err = tx.ReleaseClaimVersion.Query().Where(releaseclaimversion.OrganizationID(actor.OrganizationID), releaseclaimversion.ReleaseID(spec.ReleaseID), releaseclaimversion.ClaimID(claim.ID), releaseclaimversion.ID(path.ClaimVersionID)).Only(ctx)
			if err != nil {
				return nil, nil, err
			}
			if version.Text != path.Text {
				if version.Version == math.MaxInt64 {
					return nil, nil, publishing.ErrConflict
				}
				qualifiers, number = version.Qualifiers, version.Version+1
				version = nil
			}
		} else {
			claim, err = tx.ReleaseClaim.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(spec.ReleaseID).Save(ctx)
			if err != nil {
				return nil, nil, err
			}
		}
		seen[claim.ID] = true
		if version == nil {
			version, err = createClaimVersion(ctx, tx, actor, spec.ReleaseID, claim.ID, number, path.Text, qualifiers, origin, &spec.ID)
			if err != nil {
				return nil, nil, err
			}
			if err := tx.ReleaseClaim.UpdateOneID(claim.ID).SetCurrentVersionID(version.ID).ClearCurrentSupportSetID().ClearCurrentDecisionID().Exec(ctx); err != nil {
				return nil, nil, err
			}
		}
		path.ClaimID, path.ClaimVersionID = claim.ID, version.ID
		if err := tx.ClaimPathBinding.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(spec.ReleaseID).SetSpecID(spec.ID).SetLegacyPath(path.Path).SetClaimID(claim.ID).SetClaimVersionID(version.ID).Exec(ctx); err != nil {
			return nil, nil, err
		}
		ids = append(ids, version.ID)
	}
	if previous != nil {
		bindings, err := tx.ClaimPathBinding.Query().Where(claimpathbinding.OrganizationID(actor.OrganizationID), claimpathbinding.SpecID(previous.ID)).All(ctx)
		if err != nil {
			return nil, nil, err
		}
		for _, binding := range bindings {
			if !seen[binding.ClaimID] {
				if _, err := tx.ReleaseClaim.Update().Where(releaseclaim.OrganizationID(actor.OrganizationID), releaseclaim.ReleaseID(spec.ReleaseID), releaseclaim.ID(binding.ClaimID), releaseclaim.CurrentVersionID(binding.ClaimVersionID)).ClearCurrentDecisionID().Save(ctx); err != nil {
					return nil, nil, err
				}
			}
		}
	}
	if err := importLegacySpecSources(ctx, tx, actor, spec); err != nil {
		return nil, nil, err
	}
	if !enrich {
		return spec.Content, ids, nil
	}
	content, err := releasefacts.BindSpecClaims(document, paths)
	return content, ids, err
}

// Legacy labels are namespaced by immutable spec ID. They remain unverified
// imported text; neither a source label nor an old spec approval proves support.
func importLegacySpecSources(ctx context.Context, tx *ent.Tx, actor Actor, spec *ent.ReleaseSpec) error {
	var sources []struct {
		ID        string `json:"id"`
		Excerpt   string `json:"excerpt"`
		URL       string `json:"url"`
		Status    string `json:"status"`
		FetchedAt string `json:"fetchedAt"`
	}
	if json.Unmarshal(spec.Sources, &sources) != nil || len(sources) > 100 {
		return ErrInvalidInput
	}
	seen := map[string]bool{}
	for _, item := range sources {
		if item.Status != "ok" || item.Excerpt == "" {
			continue
		}
		if !qualificationID(item.ID) || seen[item.ID] {
			return ErrInvalidInput
		}
		seen[item.ID] = true
		text, err := releasefacts.NormalizeEvidenceText(item.Excerpt)
		if err != nil {
			return ErrInvalidInput
		}
		var sourceURL *string
		if item.URL != "" && item.URL != "brief" {
			sourceURL = &item.URL
			if !evidenceReferenceURL(sourceURL) {
				return ErrInvalidInput
			}
		}
		identity := releasefacts.ByteHash([]byte("legacy:" + spec.ID + ":" + item.ID))
		exists, err := tx.EvidenceSource.Query().Where(evidencesource.OrganizationID(actor.OrganizationID), evidencesource.KindEQ(evidencesource.KindTEXT), evidencesource.IdentitySha256(identity)).Exist(ctx)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		source, err := tx.EvidenceSource.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetKind(evidencesource.KindTEXT).SetIdentitySha256(identity).SetChangeSequence(0).Save(ctx)
		if err != nil {
			return err
		}
		observed := spec.CreatedAt
		if at, err := time.Parse(time.RFC3339, item.FetchedAt); err == nil && !at.After(time.Now().Add(time.Minute)) {
			observed = at
		}
		row, err := tx.EvidenceVersion.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSourceID(source.ID).SetFormat(evidenceversion.FormatTEXT).SetOrigin(evidenceversion.OriginAI).
			SetRawSha256(releasefacts.ByteHash([]byte(item.Excerpt))).SetNormalizedSha256(releasefacts.ByteHash([]byte(text))).SetNormalizationVersion("legacy-text-v1").SetNormalizedText(text).SetNillableSourceURL(sourceURL).
			SetProviderRevision("legacy:" + spec.ID + ":" + item.ID).SetByteLength(int64(len(text))).SetObservedAt(observed).SetAuthorID(actor.UserID).Save(ctx)
		if err != nil {
			return err
		}
		if err := tx.EvidenceSource.UpdateOneID(source.ID).SetCurrentVersionID(row.ID).SetChangeSequence(1).Exec(ctx); err != nil {
			return err
		}
		if err := tx.ReleaseEvidence.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(spec.ReleaseID).SetEvidenceVersionID(row.ID).SetPurpose("Unverified legacy source " + item.ID + " from spec " + spec.ID).SetAttachedByUserID(actor.UserID).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Five specs bound row creation within the command deadline; the durable cursor
// advances in the same transaction. Invalid legacy rows never partially import.
func backfillReleaseSpecClaims(ctx context.Context, tx *ent.Tx, actor Actor, root *ent.ReleaseReadiness) ([]string, error) {
	progress := root.ClaimImportProgress
	if progress.Done {
		return []string{root.ID}, nil
	}
	query := tx.ReleaseSpec.Query().Where(releasespec.OrganizationID(actor.OrganizationID), releasespec.ReleaseID(root.ReleaseID))
	if progress.Cursor != "" {
		at, id, err := decodeTimeCursor(progress.Cursor)
		if err != nil {
			return nil, err
		}
		query.Where(releasespec.Or(releasespec.CreatedAtGT(at), releasespec.And(releasespec.CreatedAtEQ(at), releasespec.IDGT(id))))
	}
	specs, err := query.Order(ent.Asc(releasespec.FieldCreatedAt), ent.Asc(releasespec.FieldID)).Limit(6).All(ctx)
	if err != nil {
		return nil, err
	}
	progress.Done = len(specs) <= 5
	if len(specs) > 5 {
		specs = specs[:5]
	}
	progress.InvalidSpecIDs = []string{}
	for _, spec := range specs {
		exists, err := tx.ClaimPathBinding.Query().Where(claimpathbinding.OrganizationID(actor.OrganizationID), claimpathbinding.SpecID(spec.ID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if exists {
			progress.Skipped++
		} else {
			if _, err := tx.PlatformExec(ctx, "SAVEPOINT legacy_claim_import"); err != nil {
				return nil, err
			}
			_, _, importErr := importSpecClaims(ctx, tx, actor, spec, nil, false)
			if importErr != nil {
				if !errors.Is(importErr, ErrInvalidInput) && !errors.Is(importErr, publishing.ErrConflict) && !errors.Is(importErr, publishing.ErrNotFound) {
					return nil, importErr
				}
				if _, err := tx.PlatformExec(ctx, "ROLLBACK TO SAVEPOINT legacy_claim_import"); err != nil {
					return nil, err
				}
				progress.Invalid++
				progress.InvalidSpecIDs = append(progress.InvalidSpecIDs, spec.ID)
			} else {
				progress.Imported++
			}
			if _, err := tx.PlatformExec(ctx, "RELEASE SAVEPOINT legacy_claim_import"); err != nil {
				return nil, err
			}
		}
		progress.Cursor = encodeTimeCursor(spec.CreatedAt, spec.ID)
	}
	if err := tx.ReleaseReadiness.UpdateOneID(root.ID).SetClaimImportProgress(progress).Exec(ctx); err != nil {
		return nil, err
	}
	return []string{root.ID}, nil
}
