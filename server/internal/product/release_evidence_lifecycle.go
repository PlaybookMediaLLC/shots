package product

import (
	"context"
	"math"
	"slices"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseevidence"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type LinkReleaseEvidenceInput struct {
	ExpectedRevision       string `json:"expectedRevision"`
	EvidenceVersionID      string `json:"evidenceVersionId"`
	ExpectedSourceSequence string `json:"expectedSourceSequence"`
	Purpose                string `json:"purpose"`
}

// One retained snapshot can support several releases through explicit bindings.
func (c *Configuration) LinkReleaseEvidence(ctx context.Context, actor Actor, releaseID, key string, input LinkReleaseEvidenceInput) (*ReadinessMutation, error) {
	if !qualificationID(input.EvidenceVersionID) || !boundedEvidenceText(input.Purpose, 1000) {
		return nil, ErrInvalidInput
	}
	if _, err := sourceSequence(&input.ExpectedSourceSequence); err != nil {
		return nil, err
	}
	policy := readinessCommandPolicy{permission: "release:create", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockEvidenceHeads(ctx, tx, actor.OrganizationID, []string{input.EvidenceVersionID})
	}}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_evidence.linked", input, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		records, err := releaseEvidenceRecords(ctx, tx.Client(), actor, []string{input.EvidenceVersionID})
		if err != nil {
			return nil, err
		}
		row, exists := records[input.EvidenceVersionID]
		if !exists {
			return nil, publishing.ErrNotFound
		}
		if !row.Available || !row.Current || row.SourceSequence != input.ExpectedSourceSequence {
			return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
		}
		linked, err := tx.ReleaseEvidence.Query().Where(releaseevidence.OrganizationID(actor.OrganizationID), releaseevidence.ReleaseID(releaseID), releaseevidence.EvidenceVersionID(row.ID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if linked {
			return nil, qualificationConflict("EVIDENCE_ALREADY_ATTACHED", root.HeadRevision)
		}
		if err := tx.ReleaseEvidence.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetEvidenceVersionID(row.ID).SetPurpose(input.Purpose).SetAttachedByUserID(actor.UserID).Exec(ctx); err != nil {
			return nil, err
		}
		return []string{row.ID}, nil
	})
}

type ChangeEvidenceAccessInput struct {
	ExpectedRevision       string   `json:"expectedRevision"`
	EvidenceVersionID      string   `json:"evidenceVersionId"`
	ExpectedSourceSequence string   `json:"expectedSourceSequence"`
	Action                 string   `json:"action"`
	AudienceIDs            []string `json:"audienceIds"`
	Reason                 string   `json:"reason"`
}

func (c *Configuration) ChangeEvidenceAccess(ctx context.Context, actor Actor, releaseID, key string, input ChangeEvidenceAccessInput) (*ReadinessMutation, error) {
	if !qualificationID(input.EvidenceVersionID) || !slices.Contains([]string{"CLEAR_FOR_AUDIENCE", "REVOKE_CLEARANCE", "WITHDRAW", "TOMBSTONE"}, input.Action) || !boundedEvidenceText(input.Reason, 8192) || input.AudienceIDs == nil || len(input.AudienceIDs) > 20 || len(sortedUnique(input.AudienceIDs)) != len(input.AudienceIDs) {
		return nil, ErrInvalidInput
	}
	if (input.Action == "CLEAR_FOR_AUDIENCE") != (len(input.AudienceIDs) > 0) {
		return nil, ErrInvalidInput
	}
	for _, id := range input.AudienceIDs {
		if !qualificationID(id) {
			return nil, ErrInvalidInput
		}
	}
	expected, err := sourceSequence(&input.ExpectedSourceSequence)
	if err != nil {
		return nil, err
	}
	policy := readinessCommandPolicy{permission: "release:create", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockEvidenceHeads(ctx, tx, actor.OrganizationID, []string{input.EvidenceVersionID})
	}}
	if input.Action == "CLEAR_FOR_AUDIENCE" || input.Action == "REVOKE_CLEARANCE" {
		policy.permission = "release:approve"
		policy.authorize = func(ctx context.Context, tx *ent.Tx) error { return assignedFactReviewer(ctx, tx, actor, releaseID) }
	}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_evidence.access_changed", input, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		linked, err := tx.ReleaseEvidence.Query().Where(releaseevidence.OrganizationID(actor.OrganizationID), releaseevidence.ReleaseID(releaseID), releaseevidence.EvidenceVersionID(input.EvidenceVersionID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !linked {
			return nil, publishing.ErrNotFound
		}
		row, err := tx.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(actor.OrganizationID), evidenceversion.ID(input.EvidenceVersionID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		source, err := tx.EvidenceSource.Query().Where(evidencesource.OrganizationID(actor.OrganizationID), evidencesource.ID(row.SourceID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if source.ChangeSequence != expected || source.ChangeSequence == math.MaxInt64 {
			return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
		}
		update := tx.EvidenceSource.UpdateOneID(source.ID).SetChangeSequence(source.ChangeSequence + 1)
		switch input.Action {
		case "CLEAR_FOR_AUDIENCE", "REVOKE_CLEARANCE":
			if input.Action == "CLEAR_FOR_AUDIENCE" {
				records, err := releaseEvidenceRecords(ctx, tx.Client(), actor, []string{row.ID})
				if err != nil {
					return nil, err
				}
				record := records[row.ID]
				if !record.Available || !record.Current {
					return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
				}
				if root.QualificationRevisionID == nil {
					return nil, qualificationConflict("QUALIFICATION_REQUIRED", root.HeadRevision)
				}
				facts, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, *root.QualificationRevisionID)
				if err != nil {
					return nil, err
				}
				for _, id := range input.AudienceIDs {
					if !slices.ContainsFunc(facts.Facts.Requirements, func(a releasefacts.Audience) bool { return a.ID == id }) {
						return nil, ErrInvalidInput
					}
				}
				update.SetAccessClass(evidencesource.AccessClassCUSTOMER_CLEARED)
			} else {
				update.SetAccessClass(evidencesource.AccessClassPRIVATE_SOURCE)
			}
			if err := tx.EvidenceClearance.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetEvidenceVersionID(row.ID).SetAudienceIds(sortedUnique(input.AudienceIDs)).SetHumanUserID(actor.UserID).SetSessionID(actor.SessionID).SetReason(input.Reason).Exec(ctx); err != nil {
				return nil, err
			}
		case "WITHDRAW":
			update.SetAvailability(evidencesource.AvailabilityWITHDRAWN)
		case "TOMBSTONE":
			if row.AssetID != nil || row.RedactionAssetID != nil {
				return nil, qualificationConflict("DELETE_SOURCE_ASSET_FIRST", root.HeadRevision)
			}
			if row.TombstonedAt == nil {
				if err := eraseEvidenceVersion(ctx, tx, row.ID); err != nil {
					return nil, err
				}
			}
		}
		if err := update.Exec(ctx); err != nil {
			return nil, err
		}
		return []string{row.ID}, nil
	})
}

func eraseEvidenceVersion(ctx context.Context, tx *ent.Tx, id string) error {
	return tx.EvidenceVersion.UpdateOneID(id).SetTombstonedAt(time.Now().UTC()).ClearNormalizedText().ClearSourceURL().ClearAssetID().ClearRedactionAssetID().SetAttestationScope("").SetLimitations("").Exec(ctx)
}

// Called before the existing asset deletion outbox is committed. Storage cleanup
// can retry independently; evidence reads and approvals are already blocked.
func tombstoneAssetEvidence(ctx context.Context, tx *ent.Tx, org, id string) error {
	rows, err := tx.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(org), evidenceversion.TombstonedAtIsNil(), evidenceversion.Or(evidenceversion.AssetID(id), evidenceversion.RedactionAssetID(id))).All(ctx)
	if err != nil {
		return err
	}
	sources := []string{}
	for _, row := range rows {
		sources = append(sources, row.SourceID)
	}
	for _, sourceID := range sortedUnique(sources) {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_evidence_source WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, org, sourceID); err != nil {
			return err
		}
		if err := tx.EvidenceSource.UpdateOneID(sourceID).AddChangeSequence(1).Exec(ctx); err != nil {
			return err
		}
	}
	for _, row := range rows {
		if err := eraseEvidenceVersion(ctx, tx, row.ID); err != nil {
			return err
		}
	}
	return nil
}
