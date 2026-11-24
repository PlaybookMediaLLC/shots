package product

import (
	"context"
	"errors"
	"math"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimsupport"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimsupportset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimverification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaimversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseevidence"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type SaveReleaseClaimInput struct {
	ExpectedRevision       string                       `json:"expectedRevision"`
	ClaimID                *string                      `json:"claimId"`
	ExpectedClaimVersionID *string                      `json:"expectedClaimVersionId"`
	Text                   string                       `json:"text"`
	Qualifiers             releasefacts.ClaimQualifiers `json:"qualifiers"`
	Origin                 string                       `json:"origin"`
}

func validClaimInput(input SaveReleaseClaimInput) bool {
	if !boundedEvidenceText(input.Text, releasefacts.MaxClaimTextBytes) || !slices.Contains([]string{"HUMAN", "AI"}, input.Origin) ||
		(input.ClaimID == nil) != (input.ExpectedClaimVersionID == nil) || (input.ClaimID != nil && (!qualificationID(*input.ClaimID) || !qualificationID(*input.ExpectedClaimVersionID))) {
		return false
	}
	for _, value := range []string{input.Qualifiers.Audience, input.Qualifiers.Availability, input.Qualifiers.Eligibility, input.Qualifiers.Limitations} {
		if len(value) > releasefacts.MaxClaimTextBytes || !utf8.ValidString(value) || strings.ContainsRune(value, 0) {
			return false
		}
	}
	return true
}

func (c *Configuration) SaveReleaseClaim(ctx context.Context, actor Actor, releaseID, key string, input SaveReleaseClaimInput) (*ReadinessMutation, error) {
	if !validClaimInput(input) {
		return nil, ErrInvalidInput
	}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_claim.saved", input, readinessCommandPolicy{permission: "release:create"},
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
			var claim *ent.ReleaseClaim
			var err error
			version := int64(1)
			if input.ClaimID == nil {
				claim, err = tx.ReleaseClaim.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).Save(ctx)
			} else {
				claim, err = releaseClaim(ctx, tx.Client(), actor.OrganizationID, releaseID, *input.ClaimID)
			}
			if err != nil {
				return nil, err
			}
			if input.ClaimID != nil {
				if claim.CurrentVersionID == nil || *claim.CurrentVersionID != *input.ExpectedClaimVersionID {
					return nil, qualificationConflict("CLAIM_CHANGED", root.HeadRevision)
				}
				previous, err := tx.ReleaseClaimVersion.Query().Where(releaseclaimversion.OrganizationID(actor.OrganizationID), releaseclaimversion.ReleaseID(releaseID), releaseclaimversion.ClaimID(claim.ID), releaseclaimversion.ID(*claim.CurrentVersionID)).Only(ctx)
				if err != nil {
					return nil, err
				}
				if previous.Version == math.MaxInt64 {
					return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
				}
				version = previous.Version + 1
			}
			row, err := createClaimVersion(ctx, tx, actor, releaseID, claim.ID, version, input.Text, input.Qualifiers, input.Origin, nil)
			if err != nil {
				return nil, err
			}
			if err := tx.ReleaseClaim.UpdateOneID(claim.ID).SetCurrentVersionID(row.ID).ClearCurrentSupportSetID().ClearCurrentDecisionID().Exec(ctx); err != nil {
				return nil, err
			}
			return []string{claim.ID, row.ID}, nil
		})
}

func createClaimVersion(ctx context.Context, tx *ent.Tx, actor Actor, releaseID, claimID string, version int64, text string, qualifiers releasefacts.ClaimQualifiers, origin string, specID *string) (*ent.ReleaseClaimVersion, error) {
	hash, _, err := releasefacts.CanonicalHash("shots.claim.v1", struct {
		Text       string                       `json:"text"`
		Qualifiers releasefacts.ClaimQualifiers `json:"qualifiers"`
	}{text, qualifiers})
	if err != nil {
		return nil, ErrInvalidInput
	}
	return tx.ReleaseClaimVersion.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetClaimID(claimID).
		SetVersion(version).SetNillableSpecID(specID).SetText(text).SetQualifiers(qualifiers).SetContentSha256(hash).SetOrigin(releaseclaimversion.Origin(origin)).SetAuthorID(actor.UserID).Save(ctx)
}

func releaseClaim(ctx context.Context, client *ent.Client, org, releaseID, id string) (*ent.ReleaseClaim, error) {
	row, err := client.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(org), releaseclaim.ReleaseID(releaseID), releaseclaim.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return row, err
}

type ClaimSupportInput struct {
	EvidenceVersionID      string                        `json:"evidenceVersionId"`
	ExpectedSourceSequence string                        `json:"expectedSourceSequence"`
	Relation               string                        `json:"relation"`
	Selector               releasefacts.EvidenceSelector `json:"selector"`
	ExclusionReason        string                        `json:"exclusionReason"`
}

type SetClaimSupportsInput struct {
	ExpectedRevision string              `json:"expectedRevision"`
	ClaimVersionID   string              `json:"claimVersionId"`
	Supports         []ClaimSupportInput `json:"supports"`
}

// The organization authority lock prevents source writers from changing this
// closure while its source heads are acquired in a stable order.
func lockEvidenceHeads(ctx context.Context, tx *ent.Tx, org string, versionIDs []string) error {
	rows, err := tx.EvidenceVersion.Query().Where(evidenceversion.OrganizationID(org), evidenceversion.IDIn(sortedUnique(versionIDs)...)).All(ctx)
	if err != nil {
		return err
	}
	if len(rows) != len(sortedUnique(versionIDs)) {
		return publishing.ErrNotFound
	}
	sources := []string{}
	for _, row := range rows {
		sources = append(sources, row.SourceID)
	}
	heads, err := tx.EvidenceSource.Query().Where(evidencesource.OrganizationID(org), evidencesource.IDIn(sortedUnique(sources)...)).All(ctx)
	if err != nil {
		return err
	}
	bindingIDs := []string{}
	for _, head := range heads {
		if head.SourceBindingID != nil {
			bindingIDs = append(bindingIDs, *head.SourceBindingID)
		}
	}
	bindings, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(org), releasesourcebinding.IDIn(sortedUnique(bindingIDs)...)).Order(ent.Asc(releasesourcebinding.FieldSourceAppID), ent.Asc(releasesourcebinding.FieldID)).All(ctx)
	if err != nil {
		return err
	}
	for _, binding := range bindings {
		err := lockReleaseSources(ctx, tx, org, []*ent.ReleaseSourceBinding{binding})
		var unavailable *SourceSelectionError
		// Retain authority locks, but permit a human to withdraw unavailable evidence.
		// Positive support separately requires live source access in the same transaction.
		if err != nil && !(errors.As(err, &unavailable) && unavailable.Reason == "SOURCE_UNAVAILABLE") && !errors.Is(err, publishing.ErrNotFound) {
			return err
		}
	}
	for _, id := range sortedUnique(sources) {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_evidence_source WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, org, id); err != nil {
			return err
		}
	}
	return nil
}

func (c *Configuration) SetClaimSupports(ctx context.Context, actor Actor, releaseID, claimID, key string, input SetClaimSupportsInput) (*ReadinessMutation, error) {
	if !qualificationID(claimID) || !qualificationID(input.ClaimVersionID) || input.Supports == nil || len(input.Supports) > releasefacts.MaxClaimSupports {
		return nil, ErrInvalidInput
	}
	ids := []string{}
	for _, support := range input.Supports {
		if !qualificationID(support.EvidenceVersionID) || !slices.Contains(releasefacts.SupportRelations, support.Relation) ||
			(support.ExclusionReason != "" && !boundedEvidenceText(support.ExclusionReason, releasefacts.MaxEvidenceRationaleBytes)) {
			return nil, ErrInvalidInput
		}
		if _, err := sourceSequence(&support.ExpectedSourceSequence); err != nil {
			return nil, err
		}
		ids = append(ids, support.EvidenceVersionID)
	}
	policy := readinessCommandPolicy{permission: "release:create", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockEvidenceHeads(ctx, tx, actor.OrganizationID, ids)
	}}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_claim.supports_changed", struct {
		ClaimID string                `json:"claimId"`
		Input   SetClaimSupportsInput `json:"input"`
	}{claimID, input}, policy,
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
			claim, err := releaseClaim(ctx, tx.Client(), actor.OrganizationID, releaseID, claimID)
			if err != nil {
				return nil, err
			}
			if claim.CurrentVersionID == nil || *claim.CurrentVersionID != input.ClaimVersionID {
				return nil, qualificationConflict("CLAIM_CHANGED", root.HeadRevision)
			}
			linked, err := tx.ReleaseEvidence.Query().Where(releaseevidence.OrganizationID(actor.OrganizationID), releaseevidence.ReleaseID(releaseID), releaseevidence.EvidenceVersionIDIn(sortedUnique(ids)...)).Count(ctx)
			if err != nil {
				return nil, err
			}
			if linked != len(sortedUnique(ids)) {
				return nil, publishing.ErrNotFound
			}
			records, err := releaseEvidenceRecords(ctx, tx.Client(), actor, ids)
			if err != nil {
				return nil, err
			}
			priorPins := map[string]releasefacts.SupportReference{}
			if claim.CurrentSupportSetID != nil {
				old, err := tx.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(actor.OrganizationID), claimsupportset.ID(*claim.CurrentSupportSetID)).Only(ctx)
				if err != nil {
					return nil, err
				}
				for _, pin := range old.SourcePins {
					hash, _, err := releasefacts.CanonicalHash("shots.evidence-selector.v1", pin.Selector)
					if err != nil {
						return nil, err
					}
					priorPins[pin.EvidenceVersionID+":"+pin.Relation+":"+hash] = pin
				}
			}
			pins := make([]releasefacts.SupportReference, 0, len(input.Supports))
			seen := map[string]bool{}
			for _, support := range input.Supports {
				evidence, exists := records[support.EvidenceVersionID]
				if !exists {
					return nil, publishing.ErrNotFound
				}
				selectorHash, _, err := releasefacts.CanonicalHash("shots.evidence-selector.v1", support.Selector)
				if err != nil {
					return nil, ErrInvalidInput
				}
				identity := support.EvidenceVersionID + ":" + support.Relation + ":" + selectorHash
				_, previouslyReviewed := priorPins[identity]
				if evidence.SourceSequence != support.ExpectedSourceSequence {
					return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
				}
				if !(support.ExclusionReason != "" && previouslyReviewed) {
					if !evidence.Available || !evidence.Current {
						return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
					}
					if evidence.Format == "TEXT" && evidence.Text != nil {
						err = support.Selector.ValidateText(*evidence.Text)
					} else if evidence.Format == "IMAGE" {
						redaction := ""
						if evidence.RedactionAssetID != nil {
							redaction = *evidence.RedactionAssetID
						}
						err = support.Selector.ValidateImage(evidence.SHA256, evidence.Width, evidence.Height, redaction)
					} else {
						return nil, ErrInvalidInput
					}
					if err != nil {
						return nil, ErrInvalidInput
					}
				}
				if seen[identity] {
					return nil, ErrInvalidInput
				}
				seen[identity] = true
				pins = append(pins, releasefacts.SupportReference{EvidenceVersionID: evidence.ID, EvidenceSHA256: evidence.SHA256, SourceID: evidence.SourceID, SourceSequence: evidence.SourceSequence, Relation: support.Relation, Selector: support.Selector, ExclusionReason: support.ExclusionReason})
			}
			// A replacement set cannot quietly drop contradictory passages.
			for identity, prior := range priorPins {
				if prior.Relation == "CONTRADICTS" && !seen[identity] {
					return nil, qualificationConflict("CONTRADICTION_NOT_REVIEWED", root.HeadRevision)
				}
			}
			sort.Slice(pins, func(i, j int) bool {
				a, b := pins[i], pins[j]
				if a.EvidenceVersionID != b.EvidenceVersionID {
					return a.EvidenceVersionID < b.EvidenceVersionID
				}
				if a.Relation != b.Relation {
					return a.Relation < b.Relation
				}
				ha, _, _ := releasefacts.CanonicalHash("shots.evidence-selector.v1", a.Selector)
				hb, _, _ := releasefacts.CanonicalHash("shots.evidence-selector.v1", b.Selector)
				return ha < hb
			})
			hash, _, err := releasefacts.CanonicalHash("shots.claim-supports.v1", pins)
			if err != nil {
				return nil, ErrInvalidInput
			}
			version := int64(1)
			previous, err := tx.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(actor.OrganizationID), claimsupportset.ClaimVersionID(input.ClaimVersionID)).Order(ent.Desc(claimsupportset.FieldVersion)).First(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			if previous != nil {
				if previous.Version == math.MaxInt64 {
					return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
				}
				version = previous.Version + 1
			}
			set, err := tx.ClaimSupportSet.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetClaimID(claimID).SetClaimVersionID(input.ClaimVersionID).
				SetVersion(version).SetSupportSha256(hash).SetSourcePins(pins).SetAuthorID(actor.UserID).Save(ctx)
			if err != nil {
				return nil, err
			}
			for _, pin := range pins {
				selectorHash, _, err := releasefacts.CanonicalHash("shots.evidence-selector.v1", pin.Selector)
				if err != nil {
					return nil, err
				}
				if err := tx.ClaimSupport.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetClaimID(claimID).SetClaimVersionID(input.ClaimVersionID).
					SetSupportSetID(set.ID).SetEvidenceVersionID(pin.EvidenceVersionID).SetRelation(claimsupport.Relation(pin.Relation)).SetSelector(pin.Selector).SetSelectorSha256(selectorHash).SetExclusionReason(pin.ExclusionReason).Exec(ctx); err != nil {
					return nil, err
				}
			}
			if err := tx.ReleaseClaim.UpdateOneID(claimID).SetCurrentSupportSetID(set.ID).ClearCurrentDecisionID().Exec(ctx); err != nil {
				return nil, err
			}
			return []string{set.ID}, nil
		})
}

type VerifyReleaseClaimInput struct {
	ExpectedRevision string `json:"expectedRevision"`
	ClaimVersionID   string `json:"claimVersionId"`
	ClaimSHA256      string `json:"claimSha256"`
	SupportSetID     string `json:"supportSetId"`
	SupportSHA256    string `json:"supportSha256"`
	Decision         string `json:"decision"`
	Reason           string `json:"reason"`
}

func assignedFactReviewer(ctx context.Context, tx *ent.Tx, actor Actor, releaseID string) error {
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(releaseID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if root.QualificationRevisionID == nil {
		return publishing.ErrForbidden
	}
	facts, err := tx.ReleaseQualification.Query().Where(releasequalification.OrganizationID(actor.OrganizationID), releasequalification.ReleaseID(releaseID), releasequalification.ID(*root.QualificationRevisionID)).Only(ctx)
	if err != nil {
		return err
	}
	if facts.FactReviewerUserID == nil || *facts.FactReviewerUserID != actor.UserID {
		return publishing.ErrForbidden
	}
	return nil
}

func (c *Configuration) VerifyReleaseClaim(ctx context.Context, actor Actor, releaseID, claimID, key string, input VerifyReleaseClaimInput) (*ReadinessMutation, error) {
	if !qualificationID(claimID) || !qualificationID(input.ClaimVersionID) || !qualificationID(input.SupportSetID) || len(input.ClaimSHA256) != 64 || len(input.SupportSHA256) != 64 ||
		!slices.Contains(releasefacts.ClaimDecisions, input.Decision) || !boundedEvidenceText(input.Reason, releasefacts.MaxEvidenceRationaleBytes) {
		return nil, ErrInvalidInput
	}
	var set *ent.ClaimSupportSet
	policy := readinessCommandPolicy{permission: "release:approve", authorize: func(ctx context.Context, tx *ent.Tx) error { return assignedFactReviewer(ctx, tx, actor, releaseID) }, lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		var err error
		set, err = tx.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(actor.OrganizationID), claimsupportset.ReleaseID(releaseID), claimsupportset.ClaimID(claimID), claimsupportset.ClaimVersionID(input.ClaimVersionID), claimsupportset.ID(input.SupportSetID)).Only(ctx)
		if ent.IsNotFound(err) {
			return publishing.ErrNotFound
		}
		if err != nil {
			return err
		}
		ids := []string{}
		for _, pin := range set.SourcePins {
			ids = append(ids, pin.EvidenceVersionID)
		}
		return lockEvidenceHeads(ctx, tx, actor.OrganizationID, ids)
	}}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_claim.verified", struct {
		ClaimID string                  `json:"claimId"`
		Input   VerifyReleaseClaimInput `json:"input"`
	}{claimID, input}, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		claim, err := releaseClaim(ctx, tx.Client(), actor.OrganizationID, releaseID, claimID)
		if err != nil {
			return nil, err
		}
		if claim.CurrentVersionID == nil || *claim.CurrentVersionID != input.ClaimVersionID || claim.CurrentSupportSetID == nil || *claim.CurrentSupportSetID != input.SupportSetID || set.SupportSha256 != input.SupportSHA256 {
			return nil, qualificationConflict("CLAIM_CHANGED", root.HeadRevision)
		}
		version, err := tx.ReleaseClaimVersion.Query().Where(releaseclaimversion.OrganizationID(actor.OrganizationID), releaseclaimversion.ReleaseID(releaseID), releaseclaimversion.ClaimID(claimID), releaseclaimversion.ID(input.ClaimVersionID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if version.ContentSha256 != input.ClaimSHA256 {
			return nil, qualificationConflict("CLAIM_CHANGED", root.HeadRevision)
		}
		if input.Decision == "SUPPORTED" {
			if !version.Qualifiers.Complete() {
				return nil, qualificationConflict("CLAIM_QUALIFIERS_MISSING", root.HeadRevision)
			}
			if reason, err := validateSupportedEvidence(ctx, tx.Client(), actor, set.SourcePins); err != nil {
				return nil, err
			} else if reason != "" {
				return nil, qualificationConflict(reason, root.HeadRevision)
			}
		}
		decision, err := tx.ClaimVerification.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetClaimID(claimID).SetClaimVersionID(version.ID).SetSupportSetID(set.ID).
			SetSupportSha256(set.SupportSha256).SetClaimSha256(version.ContentSha256).SetDecision(claimverification.Decision(input.Decision)).SetHumanUserID(actor.UserID).SetSessionID(actor.SessionID).SetReason(input.Reason).SetNillableSupersedesID(claim.CurrentDecisionID).Save(ctx)
		if err != nil {
			return nil, err
		}
		if err := tx.ReleaseClaim.UpdateOneID(claimID).SetCurrentDecisionID(decision.ID).Exec(ctx); err != nil {
			return nil, err
		}
		return []string{decision.ID}, nil
	})
}

func validateSupportedEvidence(ctx context.Context, client *ent.Client, actor Actor, pins []releasefacts.SupportReference) (string, error) {
	ids := []string{}
	for _, pin := range pins {
		ids = append(ids, pin.EvidenceVersionID)
	}
	records, err := releaseEvidenceRecords(ctx, client, actor, ids)
	if err != nil {
		return "", err
	}
	return supportedEvidenceReason(records, pins), nil
}

func supportedEvidenceReason(records map[string]ReleaseEvidenceRecord, pins []releasefacts.SupportReference) string {
	supported := false
	for _, pin := range pins {
		if pin.ExclusionReason != "" {
			continue
		}
		record, exists := records[pin.EvidenceVersionID]
		if !exists || !record.Available {
			return "EVIDENCE_UNAVAILABLE"
		}
		if !record.Current || record.SourceSequence != pin.SourceSequence || record.SHA256 != pin.EvidenceSHA256 {
			return "SOURCE_CHANGED"
		}
		if pin.Relation == "CONTRADICTS" {
			return "CONTRADICTION_NOT_REVIEWED"
		}
		if pin.Relation != "SUPPORTS" {
			continue
		}
		if record.Origin == "AI" {
			return "AI_EVIDENCE_UNCONFIRMED"
		}
		if record.Kind == "ATTESTATION" && !record.Attested {
			return "ATTESTATION_UNCONFIRMED"
		}
		supported = true
	}
	if !supported {
		return "SUPPORT_MISSING"
	}
	return ""
}

// This compact pin is shared by frozen kit manifests and current claim reads.
type ClaimPin struct {
	ClaimID        string `json:"claimId"`
	ClaimVersionID string `json:"claimVersionId"`
	ClaimSHA256    string `json:"claimSha256"`
	SupportSetID   string `json:"supportSetId"`
	SupportSHA256  string `json:"supportSha256"`
	DecisionID     string `json:"decisionId"`
}
