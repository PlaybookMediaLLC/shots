package product

import (
	"context"
	"slices"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitreviewdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitsourcepin"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasekit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"github.com/lucsky/cuid"
)

const EventKitPrepare = "release_readiness.kit_prepare_requested"
const EventKitExport = "release_readiness.export_requested"

type KitSnapshotExpectation struct {
	ArtifactRevisionID string `json:"artifactRevisionId"`
	SnapshotSHA256     string `json:"snapshotSha256"`
}
type PrepareReleaseKitInput struct {
	ExpectedRevision string                   `json:"expectedRevision"`
	Snapshots        []KitSnapshotExpectation `json:"snapshots"`
}

func lockKitDependencies(ctx context.Context, tx *ent.Tx, org, releaseID, revisionID string) error {
	if _, err := loadKitRevision(ctx, tx.Client(), org, releaseID, revisionID); err != nil {
		return err
	}
	pins, err := tx.KitSourcePin.Query().Where(kitsourcepin.OrganizationID(org), kitsourcepin.ReleaseID(releaseID), kitsourcepin.KitRevisionID(revisionID)).All(ctx)
	if err != nil {
		return err
	}
	ids := []string{}
	for _, p := range pins {
		ids = append(ids, p.EvidenceVersionIds...)
	}
	return lockEvidenceHeads(ctx, tx, org, sortedUnique(ids))
}

func (c *Configuration) PrepareReleaseKit(ctx context.Context, actor Actor, releaseID, revisionID, key string, input PrepareReleaseKitInput) (*ReadinessMutation, error) {
	if !qualificationID(revisionID) || len(input.Snapshots) < 1 || len(input.Snapshots) > releasekits.MaxArtifacts {
		return nil, ErrInvalidInput
	}
	policy := readinessCommandPolicy{permission: "release:create", lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockKitDependencies(ctx, tx, actor.OrganizationID, releaseID, revisionID)
	}}
	request := struct {
		RevisionID string                 `json:"revisionId"`
		Input      PrepareReleaseKitInput `json:"input"`
	}{revisionID, input}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_kit.prepare_requested", request, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
		if err != nil {
			return nil, err
		}
		kit, err := tx.ReleaseKit.Query().Where(releasekit.OrganizationID(actor.OrganizationID), releasekit.ID(revision.KitID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if revision.State != kitrevision.StateDRAFT || optionalString(kit.CurrentRevisionID) != revisionID {
			return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
		}
		artifacts, err := kitArtifacts(ctx, tx.Client(), revision)
		if err != nil {
			return nil, err
		}
		expected := map[string]string{}
		for _, e := range input.Snapshots {
			if !qualificationID(e.ArtifactRevisionID) || !assetHashPattern.MatchString(e.SnapshotSHA256) || expected[e.ArtifactRevisionID] != "" {
				return nil, ErrInvalidInput
			}
			expected[e.ArtifactRevisionID] = e.SnapshotSHA256
		}
		if len(expected) != len(artifacts) {
			return nil, ErrInvalidInput
		}
		for _, a := range artifacts {
			if expected[a.ID] != a.SnapshotSha256 {
				return nil, qualificationConflict("NATIVE_REVISION_CONFLICT", root.HeadRevision)
			}
			if a.PreparedAt == nil {
				if err := checkKitNativeCurrent(ctx, tx, actor.OrganizationID, a.Snapshot); err != nil {
					return nil, err
				}
			}
		}
		jobID := cuid.New()
		if err := tx.KitRevision.UpdateOneID(revisionID).SetState(kitrevision.StateBUILDING).SetPreparationJobID(jobID).Exec(ctx); err != nil {
			return nil, err
		}
		if err := kitOutbox(ctx, tx, actor.OrganizationID, EventKitPrepare, "kit_revision", revisionID, jobID); err != nil {
			return nil, err
		}
		return []string{revisionID, jobID}, nil
	})
}

func kitOutbox(ctx context.Context, tx *ent.Tx, org, event, kind, id, jobID string) error {
	return tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(org).SetType(event).SetAggregateType(kind).SetAggregateID(id).SetPayload(map[string]any{"schemaVersion": 1, "jobId": jobID, "id": id}).SetIdempotencyKey(event + ":" + jobID).Exec(ctx)
}

func checkKitNativeCurrent(ctx context.Context, tx *ent.Tx, org string, s releasekits.NativeSnapshot) error {
	switch s.Kind {
	case "DRAFT":
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, org, s.SourceID); err != nil {
			return err
		}
		row, err := tx.ContentDraft.Query().Where(contentdraft.OrganizationID(org), contentdraft.ID(s.SourceID)).Only(ctx)
		if ent.IsNotFound(err) {
			return publishing.ErrNotFound
		}
		if err != nil {
			return err
		}
		if strconv.Itoa(row.Version) != s.Revision {
			return qualificationConflict("NATIVE_REVISION_CONFLICT", 0)
		}
	case "CREATIVE":
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_creative_set WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, org, s.SourceID); err != nil {
			return err
		}
		row, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.OrganizationID(org), platformcreativeset.ID(s.SourceID), platformcreativeset.Archived(false)).Only(ctx)
		if ent.IsNotFound(err) {
			return publishing.ErrNotFound
		}
		if err != nil {
			return err
		}
		if strconv.Itoa(row.Revision) != s.Revision {
			return qualificationConflict("NATIVE_REVISION_CONFLICT", 0)
		}
	}
	for _, pin := range s.Assets {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM asset WHERE "organizationId"=$1 AND id=$2 FOR SHARE`, org, pin.ID); err != nil {
			return err
		}
		row, err := tx.Asset.Query().Where(asset.OrganizationID(org), asset.ID(pin.ID), asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
		if ent.IsNotFound(err) {
			return qualificationConflict("EVIDENCE_UNAVAILABLE", 0)
		}
		if err != nil {
			return err
		}
		if optionalString(row.Sha256) != pin.SHA256 {
			return qualificationConflict("SOURCE_CHANGED", 0)
		}
	}
	return nil
}

type DecideReleaseKitInput struct {
	ExpectedRevision     string `json:"expectedRevision"`
	ManifestSHA256       string `json:"manifestSha256"`
	DependencyToken      string `json:"dependencyToken"`
	ReviewType           string `json:"reviewType"`
	Decision             string `json:"decision"`
	Reason               string `json:"reason"`
	AssertionsConfirmed  bool   `json:"assertionsConfirmed"`
	ScreenshotsConfirmed bool   `json:"screenshotsConfirmed"`
	AudienceConfirmed    bool   `json:"audienceConfirmed"`
}

func (c *Configuration) DecideReleaseKit(ctx context.Context, actor Actor, releaseID, revisionID, key string, input DecideReleaseKitInput) (*ReadinessMutation, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if !qualificationID(revisionID) || !assetHashPattern.MatchString(input.ManifestSHA256) || !assetHashPattern.MatchString(input.DependencyToken) || !boundedEvidenceText(input.Reason, 8192) || !slices.Contains([]string{"CONTENT_COVERAGE", "FINAL_APPROVAL"}, input.ReviewType) || !slices.Contains([]string{"APPROVE", "REJECT", "WITHDRAW"}, input.Decision) {
		return nil, ErrInvalidInput
	}
	if input.ReviewType == "CONTENT_COVERAGE" && input.Decision == "APPROVE" && (!input.AssertionsConfirmed || !input.ScreenshotsConfirmed || !input.AudienceConfirmed) {
		return nil, ErrInvalidInput
	}
	policy := readinessCommandPolicy{permission: "release:approve", authorize: func(ctx context.Context, tx *ent.Tx) error {
		revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
		if err != nil {
			return err
		}
		if revision.ApproverUserID != actor.UserID {
			return publishing.ErrForbidden
		}
		return nil
	}, lockInputs: func(ctx context.Context, tx *ent.Tx) error {
		return lockKitDependencies(ctx, tx, actor.OrganizationID, releaseID, revisionID)
	}}
	request := struct {
		RevisionID string                `json:"revisionId"`
		Input      DecideReleaseKitInput `json:"input"`
	}{revisionID, input}
	return c.materialCommand(ctx, actor, releaseID, key, input.ExpectedRevision, "release_kit.decided", request, policy, func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) ([]string, error) {
		revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
		if err != nil {
			return nil, err
		}
		if revision.ManifestSha256 != input.ManifestSHA256 || (revision.State != kitrevision.StateREVIEWABLE && !(revision.State == kitrevision.StateAPPROVED && input.Decision == "WITHDRAW" && input.ReviewType == "FINAL_APPROVAL")) {
			return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
		}
		snapshot, _, _, err := loadKitReadiness(ctx, tx.Client(), actor, root, revision)
		if err != nil {
			return nil, err
		}
		if snapshot.DependencyToken != input.DependencyToken {
			return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
		}
		if input.Decision == "APPROVE" {
			check := snapshot
			if input.ReviewType == "CONTENT_COVERAGE" {
				check.CoverageApproved = true
				for i := range check.Artifacts {
					check.Artifacts[i].ScreenshotReviewed = true
				}
			}
			readiness := releasekits.Evaluate(check)
			if !readiness.CanApprove {
				return nil, kitBlocked(readiness)
			}
		}
		decision, err := tx.KitReviewDecision.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).SetKitRevisionID(revisionID).SetReviewType(kitreviewdecision.ReviewType(input.ReviewType)).SetDecision(kitreviewdecision.Decision(input.Decision)).SetManifestSha256(input.ManifestSHA256).SetDependencyToken(input.DependencyToken).SetPolicyVersion(releasekits.PolicyVersion).SetHumanUserID(actor.UserID).SetSessionID(actor.SessionID).SetReason(input.Reason).SetAssertionsConfirmed(input.AssertionsConfirmed).SetScreenshotsConfirmed(input.ScreenshotsConfirmed).SetAudienceConfirmed(input.AudienceConfirmed).Save(ctx)
		if err != nil {
			return nil, err
		}
		state := revision.State
		if input.Decision == "REJECT" {
			state = kitrevision.StateREJECTED
		} else if input.Decision == "WITHDRAW" {
			state = kitrevision.StateWITHDRAWN
		} else if input.ReviewType == "FINAL_APPROVAL" {
			state = kitrevision.StateAPPROVED
		}
		if state != revision.State {
			if err := tx.KitRevision.UpdateOneID(revisionID).SetState(state).Exec(ctx); err != nil {
				return nil, err
			}
		}
		if state == kitrevision.StateAPPROVED {
			if err := tx.ReleaseKit.UpdateOneID(revision.KitID).SetApprovedRevisionID(revisionID).Exec(ctx); err != nil {
				return nil, err
			}
		}
		return []string{decision.ID, revisionID}, nil
	})
}
