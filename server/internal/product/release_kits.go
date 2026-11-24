package product

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/claimsupportset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaimversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasekit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/lucsky/cuid"
)

type KitClaimInput struct {
	NodeID         string `json:"nodeId"`
	ClaimVersionID string `json:"claimVersionId"`
}

type KitArtifactInput struct {
	ExistingArtifactID     *string         `json:"existingArtifactId"`
	Kind                   string          `json:"kind"`
	AudienceID             string          `json:"audienceId"`
	Classification         string          `json:"classification"`
	SourceKind             string          `json:"sourceKind"`
	SourceID               string          `json:"sourceId"`
	ExpectedNativeRevision string          `json:"expectedNativeRevision"`
	OutputID               string          `json:"outputId"`
	Claims                 []KitClaimInput `json:"claims"`
}

type CreateReleaseKitInput struct {
	ExpectedRevision        string             `json:"expectedRevision"`
	ExpectedKitRevisionID   *string            `json:"expectedKitRevisionId"`
	QualificationRevisionID string             `json:"qualificationRevisionId"`
	ApproverUserID          string             `json:"approverUserId"`
	Artifacts               []KitArtifactInput `json:"artifacts"`
}

func validKitInput(input CreateReleaseKitInput) bool {
	if !qualificationID(input.QualificationRevisionID) || !qualificationID(input.ApproverUserID) || len(input.Artifacts) < 1 || len(input.Artifacts) > releasekits.MaxArtifacts || (input.ExpectedKitRevisionID != nil && !qualificationID(*input.ExpectedKitRevisionID)) {
		return false
	}
	claims := map[string]bool{}
	for _, item := range input.Artifacts {
		if item.ExistingArtifactID != nil {
			if !qualificationID(*item.ExistingArtifactID) {
				return false
			}
			continue
		}
		if !slices.Contains(releasefacts.MaterialKinds, item.Kind) || !qualificationID(item.AudienceID) || !slices.Contains([]string{"INTERNAL_MATERIAL", "CUSTOMER_CLEARED"}, item.Classification) || !slices.Contains([]string{"TEMPLATE", "DRAFT", "ASSET", "CREATIVE"}, item.SourceKind) || len(item.Claims) > 100 || len(item.OutputID) > 128 {
			return false
		}
		if item.SourceKind != "TEMPLATE" && (item.SourceID == "" || len(item.SourceID) > 128 || len(item.ExpectedNativeRevision) > 64 || item.ExpectedNativeRevision == "") {
			return false
		}
		if (item.SourceKind == "ASSET" || item.SourceKind == "CREATIVE") != (item.Kind == "SCREENSHOT") {
			return false
		}
		seen := map[string]bool{}
		for _, claim := range item.Claims {
			if !boundedEvidenceText(claim.NodeID, 128) || !qualificationID(claim.ClaimVersionID) || seen[claim.NodeID+":"+claim.ClaimVersionID] {
				return false
			}
			seen[claim.NodeID+":"+claim.ClaimVersionID] = true
			claims[claim.ClaimVersionID] = true
		}
	}
	return len(claims) <= 100
}

// CreateReleaseKitRevision declares replacement explicitly; ordinary editor
// autosaves leave an already frozen artifact and its approval history intact.
func (c *Configuration) CreateReleaseKitRevision(ctx context.Context, actor Actor, releaseID, key string, input CreateReleaseKitInput) (*ReadinessMutation, error) {
	if !validKitInput(input) {
		return nil, ErrInvalidInput
	}
	policy := readinessCommandPolicy{permission: "release:create", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		ids, sets := []string{}, []string{}
		for _, a := range input.Artifacts {
			if a.ExistingArtifactID != nil {
				links, err := tx.KitArtifactClaim.Query().Where(kitartifactclaim.OrganizationID(actor.OrganizationID), kitartifactclaim.ReleaseID(releaseID), kitartifactclaim.ArtifactRevisionID(*a.ExistingArtifactID)).All(ctx)
				if err != nil {
					return err
				}
				for _, l := range links {
					if l.SupportSetID != nil {
						sets = append(sets, *l.SupportSetID)
					}
				}
			} else {
				for _, l := range a.Claims {
					ids = append(ids, l.ClaimVersionID)
				}
			}
		}
		claims, err := tx.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(actor.OrganizationID), releaseclaim.ReleaseID(releaseID), releaseclaim.CurrentVersionIDIn(sortedUnique(ids)...)).All(ctx)
		if err != nil {
			return err
		}
		for _, claim := range claims {
			if claim.CurrentSupportSetID != nil {
				sets = append(sets, *claim.CurrentSupportSetID)
			}
		}
		return lockKitSupportSets(ctx, tx, actor.OrganizationID, releaseID, sets)
	}}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_kit.revised", input, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		if root.QualificationRevisionID == nil || *root.QualificationRevisionID != input.QualificationRevisionID {
			return nil, qualificationConflict("QUALIFICATION_REQUIRED", root.HeadRevision)
		}
		facts, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, input.QualificationRevisionID)
		if err != nil {
			return nil, err
		}
		approvers, err := currentReadinessApprovers(ctx, tx.Client(), actor.OrganizationID, []string{input.ApproverUserID})
		if err != nil {
			return nil, err
		}
		if !approvers[input.ApproverUserID] {
			return nil, publishing.ErrForbidden
		}
		kit, err := tx.ReleaseKit.Query().Where(releasekit.OrganizationID(actor.OrganizationID), releasekit.ReleaseID(releaseID)).Only(ctx)
		if ent.IsNotFound(err) {
			if input.ExpectedKitRevisionID != nil {
				return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
			}
			kit, err = tx.ReleaseKit.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).Save(ctx)
		} else if err == nil && (input.ExpectedKitRevisionID == nil || kit.CurrentRevisionID == nil || *input.ExpectedKitRevisionID != *kit.CurrentRevisionID) {
			return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
		}
		if err != nil {
			return nil, err
		}
		if kit.LastVersion == math.MaxInt64 {
			return nil, ErrInvalidInput
		}
		if kit.CurrentRevisionID != nil {
			if err := tx.KitRevision.UpdateOneID(*kit.CurrentRevisionID).SetState(kitrevision.StateSUPERSEDED).Exec(ctx); err != nil {
				return nil, err
			}
		}
		revisionID := cuid.New()
		manifest := releasekits.Manifest{SchemaVersion: 1, ReleaseID: releaseID, KitRevisionID: revisionID, QualificationRevisionID: facts.ID, RequirementRevision: facts.Version, Artifacts: []releasekits.Artifact{}, Omissions: []releasekits.Omission{}, SourcePins: []releasekits.SourcePin{}, RendererVersion: releasekits.ExporterVersion}
		for _, requirement := range facts.Facts.Requirements {
			for _, omission := range requirement.Omissions {
				manifest.Omissions = append(manifest.Omissions, releasekits.Omission{AudienceID: requirement.ID, Material: omission.Material, OwnerID: optionalString(facts.Facts.OwnerUserID), Reason: omission.Reason})
			}
		}
		revision, err := tx.KitRevision.Create().SetID(revisionID).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetKitID(kit.ID).SetVersion(kit.LastVersion + 1).SetQualificationRevisionID(facts.ID).SetApproverUserID(input.ApproverUserID).SetRequestedByUserID(actor.UserID).SetManifest(manifest).Save(ctx)
		if err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		claimVersions := map[string]bool{}
		sets := []string{}
		for order, item := range input.Artifacts {
			artifact, err := snapshotKitArtifact(ctx, tx, actor, releaseID, item)
			if err != nil {
				return nil, err
			}
			if seen[artifact.ID] {
				return nil, ErrInvalidInput
			}
			seen[artifact.ID] = true
			if !slices.ContainsFunc(facts.Facts.Requirements, func(a releasefacts.Audience) bool { return a.ID == artifact.AudienceID }) {
				return nil, ErrInvalidInput
			}
			for _, link := range artifact.ClaimLinks {
				claimVersions[link.ClaimVersionID] = true
				if len(claimVersions) > 100 {
					return nil, ErrInvalidInput
				}
				if link.SupportSetID != "" {
					sets = append(sets, link.SupportSetID)
				}
			}
			if err := tx.KitMember.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetKitRevisionID(revision.ID).SetArtifactRevisionID(artifact.ID).SetAudienceID(artifact.AudienceID).SetRequirementID(artifact.AudienceID + ":" + string(artifact.Kind)).SetDisplayOrder(order).Exec(ctx); err != nil {
				return nil, err
			}
			manifest.Artifacts = append(manifest.Artifacts, kitManifestArtifact(artifact))
		}
		manifest.SourcePins, err = kitSourceClosure(ctx, tx, actor.OrganizationID, releaseID, revisionID, sets)
		if err != nil {
			return nil, err
		}
		if err := tx.KitRevision.UpdateOneID(revision.ID).SetManifest(manifest).Exec(ctx); err != nil {
			return nil, err
		}
		if err := tx.ReleaseKit.UpdateOneID(kit.ID).SetCurrentRevisionID(revision.ID).SetLastVersion(kit.LastVersion + 1).Exec(ctx); err != nil {
			return nil, err
		}
		return []string{revision.ID, kit.ID}, nil
	})
}

func lockKitSupportSets(ctx context.Context, tx *ent.Tx, org, releaseID string, ids []string) error {
	sets, err := tx.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(org), claimsupportset.ReleaseID(releaseID), claimsupportset.IDIn(sortedUnique(ids)...)).All(ctx)
	if err != nil {
		return err
	}
	versions := []string{}
	for _, set := range sets {
		for _, pin := range set.SourcePins {
			versions = append(versions, pin.EvidenceVersionID)
		}
	}
	return lockEvidenceHeads(ctx, tx, org, sortedUnique(versions))
}

func kitSourceClosure(ctx context.Context, tx *ent.Tx, org, releaseID, revisionID string, setIDs []string) ([]releasekits.SourcePin, error) {
	sets, err := tx.ClaimSupportSet.Query().Where(claimsupportset.OrganizationID(org), claimsupportset.ReleaseID(releaseID), claimsupportset.IDIn(sortedUnique(setIDs)...)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]releasekits.SourcePin{}
	for _, set := range sets {
		for _, pin := range set.SourcePins {
			p, exists := byID[pin.SourceID]
			if exists && p.AcknowledgedSequence != pin.SourceSequence {
				return nil, qualificationConflict("SOURCE_CHANGED", 0)
			}
			p.SourceID, p.AcknowledgedSequence = pin.SourceID, pin.SourceSequence
			p.EvidenceVersionIDs = append(p.EvidenceVersionIDs, pin.EvidenceVersionID)
			byID[p.SourceID] = p
		}
	}
	ids := []string{}
	for id := range byID {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	result := []releasekits.SourcePin{}
	for _, id := range ids {
		pin := byID[id]
		pin.EvidenceVersionIDs = sortedUnique(pin.EvidenceVersionIDs)
		sequence, err := strconv.ParseInt(pin.AcknowledgedSequence, 10, 64)
		if err != nil {
			return nil, err
		}
		if err := tx.KitSourcePin.Create().SetID(cuid.New()).SetOrganizationID(org).SetReleaseID(releaseID).SetKitRevisionID(revisionID).SetSourceID(id).SetAcknowledgedSequence(sequence).SetEvidenceVersionIds(pin.EvidenceVersionIDs).Exec(ctx); err != nil {
			return nil, err
		}
		result = append(result, pin)
	}
	return result, nil
}

func kitManifestArtifact(a *ent.KitArtifactRevision) releasekits.Artifact {
	ext := ".md"
	if string(a.Kind) == "SCREENSHOT" {
		mediaType := a.MediaType
		if mediaType == "" && a.Snapshot.Kind == "ASSET" && len(a.Snapshot.Assets) == 1 {
			mediaType = a.Snapshot.Assets[0].MediaType
		}
		switch mediaType {
		case "image/jpeg":
			ext = ".jpg"
		case "image/webp":
			ext = ".webp"
		default:
			ext = ".png"
		}
	}
	return releasekits.Artifact{ArtifactRevisionID: a.ID, AudienceID: a.AudienceID, Kind: string(a.Kind), Classification: string(a.Classification), FileName: a.AudienceID + "/" + strings.ToLower(string(a.Kind)) + "-" + a.ID + ext, SnapshotSHA256: a.SnapshotSha256, OutputSHA256: optionalString(a.OutputSha256), ClaimMapSHA256: a.ClaimMapSha256}
}

func snapshotKitArtifact(ctx context.Context, tx *ent.Tx, actor Actor, releaseID string, input KitArtifactInput) (*ent.KitArtifactRevision, error) {
	if input.ExistingArtifactID != nil {
		row, err := tx.KitArtifactRevision.Query().Where(kitartifactrevision.OrganizationID(actor.OrganizationID), kitartifactrevision.ReleaseID(releaseID), kitartifactrevision.ID(*input.ExistingArtifactID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		return row, err
	}
	links := []releasekits.ClaimLink{}
	claims := []*ent.ReleaseClaimVersion{}
	for _, link := range input.Claims {
		version, err := tx.ReleaseClaimVersion.Query().Where(releaseclaimversion.OrganizationID(actor.OrganizationID), releaseclaimversion.ReleaseID(releaseID), releaseclaimversion.ID(link.ClaimVersionID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		claim, err := releaseClaim(ctx, tx.Client(), actor.OrganizationID, releaseID, version.ClaimID)
		if err != nil {
			return nil, err
		}
		if optionalString(claim.CurrentVersionID) != version.ID {
			return nil, qualificationConflict("REVISION_CONFLICT", 0)
		}
		links = append(links, releasekits.ClaimLink{NodeID: link.NodeID, ClaimID: claim.ID, ClaimVersionID: version.ID, SupportSetID: optionalString(claim.CurrentSupportSetID), VerificationID: optionalString(claim.CurrentDecisionID)})
		claims = append(claims, version)
	}
	snapshot, err := kitNativeSnapshot(ctx, tx, actor, input, claims)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(links, func(a, b releasekits.ClaimLink) int {
		if order := strings.Compare(a.NodeID, b.NodeID); order != 0 {
			return order
		}
		return strings.Compare(a.ClaimVersionID, b.ClaimVersionID)
	})
	claimHash, _, err := releasefacts.CanonicalHash("shots.kit-claims.v1", links)
	if err != nil {
		return nil, err
	}
	row, err := tx.KitArtifactRevision.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetKind(kitartifactrevision.Kind(input.Kind)).SetAudienceID(input.AudienceID).SetClassification(kitartifactrevision.Classification(input.Classification)).SetSnapshot(snapshot).SetSnapshotSha256(releasefacts.ByteHash(raw)).SetClaimLinks(links).SetClaimMapSha256(claimHash).Save(ctx)
	if err != nil {
		return nil, err
	}
	for _, link := range links {
		create := tx.KitArtifactClaim.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetArtifactRevisionID(row.ID).SetNodeID(link.NodeID).SetClaimID(link.ClaimID).SetClaimVersionID(link.ClaimVersionID)
		if link.SupportSetID != "" {
			create.SetSupportSetID(link.SupportSetID)
		}
		if link.VerificationID != "" {
			create.SetVerificationID(link.VerificationID)
		}
		if err := create.Exec(ctx); err != nil {
			return nil, err
		}
	}
	return row, nil
}
