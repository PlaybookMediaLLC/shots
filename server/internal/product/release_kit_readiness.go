package product

import (
	"context"
	"database/sql"
	"encoding/json"
	entsql "entgo.io/ent/dialect/sql"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidenceclearance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/evidencesource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitartifactrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitexport"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitreviewdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/kitsourcepin"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseclaim"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasekit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
)

type KitReadinessError struct {
	Reason          string                `json:"reason"`
	CurrentRevision string                `json:"currentRevision"`
	Blockers        []releasekits.Blocker `json:"blockers"`
}

func (e *KitReadinessError) Error() string {
	return "Review the release kit blockers before approving or delivering it."
}
func (e *KitReadinessError) Unwrap() error { return publishing.ErrConflict }
func kitBlocked(r releasekits.Readiness) *KitReadinessError {
	reason := "KIT_NOT_READY"
	for _, b := range r.Blockers {
		if b.Code == "SOURCE_CHANGED" {
			reason = "SOURCE_CHANGED"
			break
		}
	}
	return &KitReadinessError{Reason: reason, CurrentRevision: r.AggregateRevision, Blockers: r.Blockers}
}

type KitArtifactRecord struct {
	ID             string                  `json:"id"`
	Kind           string                  `json:"kind"`
	AudienceID     string                  `json:"audienceId"`
	Classification string                  `json:"classification"`
	SourceKind     string                  `json:"sourceKind"`
	SourceID       string                  `json:"sourceId"`
	SourceRevision string                  `json:"sourceRevision"`
	SnapshotSHA256 string                  `json:"snapshotSha256"`
	OutputSHA256   *string                 `json:"outputSha256"`
	Claims         []releasekits.ClaimLink `json:"claims"`
	Prepared       bool                    `json:"prepared"`
	Document       json.RawMessage         `json:"document"`
	Markdown       *string                 `json:"markdown"`
}

type KitDecisionRecord struct {
	ID             string    `json:"id"`
	ReviewType     string    `json:"reviewType"`
	Decision       string    `json:"decision"`
	HumanUserID    string    `json:"humanUserId"`
	Reason         string    `json:"reason"`
	ManifestSHA256 string    `json:"manifestSha256"`
	CreatedAt      time.Time `json:"createdAt"`
}

type KitHistoryRecord struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	State   string `json:"state"`
}
type ReleaseKitDetail struct {
	History                 []KitHistoryRecord     `json:"history"`
	ExportIDs               []string               `json:"exportIds"`
	ID                      string                 `json:"id"`
	KitID                   string                 `json:"kitId"`
	Version                 string                 `json:"version"`
	State                   string                 `json:"state"`
	ApproverUserID          string                 `json:"approverUserId"`
	QualificationRevisionID string                 `json:"qualificationRevisionId"`
	FailureCode             string                 `json:"failureCode"`
	Artifacts               []KitArtifactRecord    `json:"artifacts"`
	Omissions               []releasekits.Omission `json:"omissions"`
	Decisions               []KitDecisionRecord    `json:"decisions"`
	Readiness               releasekits.Readiness  `json:"readiness"`
}

func (c *Configuration) GetReleaseKit(ctx context.Context, actor Actor, releaseID, revisionID string) (*ReleaseKitDetail, error) {
	if !qualificationID(releaseID) || (revisionID != "" && !qualificationID(revisionID)) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	kit, err := tx.ReleaseKit.Query().Where(releasekit.OrganizationID(actor.OrganizationID), releasekit.ReleaseID(releaseID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if revisionID == "" {
		revisionID = optionalString(kit.CurrentRevisionID)
	}
	revision, err := loadKitRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, revisionID)
	if err != nil {
		return nil, err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(releaseID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	snapshot, artifacts, decisions, err := loadKitReadiness(ctx, tx.Client(), actor, root, revision)
	if err != nil {
		return nil, err
	}
	result := &ReleaseKitDetail{ID: revision.ID, KitID: kit.ID, Version: strconv.FormatInt(revision.Version, 10), State: string(revision.State), ApproverUserID: revision.ApproverUserID, QualificationRevisionID: revision.QualificationRevisionID, FailureCode: revision.FailureCode, Artifacts: []KitArtifactRecord{}, Omissions: revision.Manifest.Omissions, Decisions: []KitDecisionRecord{}, Readiness: releasekits.Evaluate(snapshot)}
	for _, row := range artifacts {
		a := KitArtifactRecord{ID: row.ID, Kind: string(row.Kind), AudienceID: row.AudienceID, Classification: string(row.Classification), SourceKind: row.Snapshot.Kind, SourceID: row.Snapshot.SourceID, SourceRevision: row.Snapshot.Revision, SnapshotSHA256: row.SnapshotSha256, OutputSHA256: row.OutputSha256, Claims: row.ClaimLinks, Prepared: row.PreparedAt != nil, Document: json.RawMessage("null")}
		if actor.IsSession() {
			a.Document = json.RawMessage(row.Snapshot.Document)
			a.Markdown = &row.Snapshot.Markdown
		} else {
			a.SourceID = ""
			a.Claims = []releasekits.ClaimLink{}
		}
		result.Artifacts = append(result.Artifacts, a)
	}
	for _, row := range decisions {
		d := KitDecisionRecord{ID: row.ID, ReviewType: string(row.ReviewType), Decision: string(row.Decision), ManifestSHA256: row.ManifestSha256, CreatedAt: row.CreatedAt}
		if actor.IsSession() {
			d.HumanUserID, d.Reason = row.HumanUserID, row.Reason
		}
		result.Decisions = append(result.Decisions, d)
	}
	history, err := tx.KitRevision.Query().Where(kitrevision.OrganizationID(actor.OrganizationID), kitrevision.ReleaseID(releaseID), kitrevision.VersionLTE(revision.Version)).Order(ent.Desc(kitrevision.FieldVersion)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	result.History = []KitHistoryRecord{}
	for _, r := range history {
		result.History = append(result.History, KitHistoryRecord{ID: r.ID, Version: strconv.FormatInt(r.Version, 10), State: string(r.State)})
	}
	result.ExportIDs, err = tx.KitExport.Query().Where(kitexport.OrganizationID(actor.OrganizationID), kitexport.ReleaseID(releaseID), kitexport.KitRevisionID(revisionID)).Order(ent.Desc(kitexport.FieldCreatedAt)).Limit(50).IDs(ctx)
	if err != nil {
		return nil, err
	}
	if result.ExportIDs == nil {
		result.ExportIDs = []string{}
	}
	return result, tx.Commit()
}

func loadKitRevision(ctx context.Context, client *ent.Client, org, releaseID, id string) (*ent.KitRevision, error) {
	r, err := client.KitRevision.Query().Where(kitrevision.OrganizationID(org), kitrevision.ReleaseID(releaseID), kitrevision.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return r, err
}

func kitArtifacts(ctx context.Context, client *ent.Client, revision *ent.KitRevision) ([]*ent.KitArtifactRevision, error) {
	ids := []string{}
	for _, a := range revision.Manifest.Artifacts {
		ids = append(ids, a.ArtifactRevisionID)
	}
	rows, err := client.KitArtifactRevision.Query().Where(kitartifactrevision.OrganizationID(revision.OrganizationID), kitartifactrevision.ReleaseID(revision.ReleaseID), kitartifactrevision.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) != len(ids) {
		return nil, ErrStorageUnavailable
	}
	byID := map[string]*ent.KitArtifactRevision{}
	for _, row := range rows {
		byID[row.ID] = row
	}
	ordered := []*ent.KitArtifactRevision{}
	for _, id := range ids {
		ordered = append(ordered, byID[id])
	}
	return ordered, nil
}

// Database loading is separate from the pure evaluator. A current APPROVED
// label never replaces live source, claim, qualification and authority checks.
func loadKitReadiness(ctx context.Context, client *ent.Client, actor Actor, root *ent.ReleaseReadiness, revision *ent.KitRevision) (releasekits.Snapshot, []*ent.KitArtifactRevision, []*ent.KitReviewDecision, error) {
	s := releasekits.Snapshot{RevisionID: revision.ID, ManifestHash: revision.ManifestSha256, AggregateRevision: strconv.FormatInt(root.HeadRevision, 10), ApproverID: revision.ApproverUserID, Prepared: revision.PreparedAt != nil, Artifacts: []releasekits.ArtifactStatus{}, Omissions: revision.Manifest.Omissions, DependencyBlockers: []releasekits.Blocker{}}
	fail := func(err error) (releasekits.Snapshot, []*ent.KitArtifactRevision, []*ent.KitReviewDecision, error) {
		return s, nil, nil, err
	}
	kit, err := client.ReleaseKit.Query().Where(releasekit.OrganizationID(actor.OrganizationID), releasekit.ReleaseID(root.ReleaseID), releasekit.ID(revision.KitID)).Only(ctx)
	if err != nil {
		return fail(err)
	}
	s.Current = optionalString(kit.CurrentRevisionID) == revision.ID && slices.Contains([]string{"DRAFT", "BUILDING", "REVIEWABLE", "APPROVED"}, string(revision.State)) && string(root.CanonicalState) == "ACTIVE"
	facts, err := qualificationRevision(ctx, client, actor.OrganizationID, root.ReleaseID, revision.QualificationRevisionID)
	if err != nil {
		return fail(err)
	}
	s.OwnerID = optionalString(facts.Facts.OwnerUserID)
	s.Requirements = facts.Facts.Requirements
	s.QualificationCurrent = optionalString(root.QualificationRevisionID) == facts.ID && !root.NeedsReview
	s.AvailabilityConfirmed = slices.Contains([]string{"PLANNED", "LIMITED", "GENERAL"}, facts.Facts.Rollout) && optionalString(facts.Facts.Availability) != ""
	needsReview, err := qualificationSourcesNeedReview(ctx, client, actor.OrganizationID, root.ReleaseID)
	if err != nil {
		return fail(err)
	}
	s.QualificationCurrent = s.QualificationCurrent && !needsReview
	if needsReview {
		s.DependencyBlockers = append(s.DependencyBlockers, releasekits.Blocker{Code: "SOURCE_CHANGED", ObjectID: facts.ID, RepairAction: "Review the changed release sources."})
	}
	decisions, err := client.KitReviewDecision.Query().Where(kitreviewdecision.OrganizationID(actor.OrganizationID), kitreviewdecision.KitRevisionID(revision.ID)).Order(ent.Desc(kitreviewdecision.FieldCreatedAt), ent.Desc(kitreviewdecision.FieldID)).Limit(100).All(ctx)
	if err != nil {
		return fail(err)
	}
	var coverage, final *ent.KitReviewDecision
	authorityIDs := []string{revision.ApproverUserID}
	if facts.Decision != nil {
		authorityIDs = append(authorityIDs, facts.Decision.HumanUserID)
	}
	for _, decision := range decisions {
		authorityIDs = append(authorityIDs, decision.HumanUserID)
		if decision.ReviewType == kitreviewdecision.ReviewTypeCONTENT_COVERAGE && coverage == nil {
			coverage = decision
		}
		if decision.ReviewType == kitreviewdecision.ReviewTypeFINAL_APPROVAL && final == nil {
			final = decision
		}
	}
	artifacts, err := kitArtifacts(ctx, client, revision)
	if err != nil {
		return fail(err)
	}
	claimIDs, assetIDs := []string{}, []string{}
	for _, a := range artifacts {
		for _, l := range a.ClaimLinks {
			claimIDs = append(claimIDs, l.ClaimID)
		}
		for _, p := range a.Snapshot.Assets {
			assetIDs = append(assetIDs, p.ID)
		}
	}
	claimRows, err := client.ReleaseClaim.Query().Where(releaseclaim.OrganizationID(actor.OrganizationID), releaseclaim.ReleaseID(root.ReleaseID), releaseclaim.IDIn(sortedUnique(claimIDs)...)).All(ctx)
	if err != nil {
		return fail(err)
	}
	// Loading private evidence is confined to this internal gate. DTO construction
	// above separately redacts all machine reads.
	internalActor := actor
	internalActor.Kind = "session"
	claims, err := releaseClaimRecords(ctx, client, internalActor, root.ReleaseID, claimRows)
	if err != nil {
		return fail(err)
	}
	claimByID := map[string]ReleaseClaimRecord{}
	evidenceIDs := []string{}
	for _, claim := range claims {
		claimByID[claim.ID] = claim
		for _, e := range claim.Evidence {
			evidenceIDs = append(evidenceIDs, e.ID)
		}
	}
	clearanceIDs := []string{}
	err = client.PlatformQuery(ctx, `SELECT DISTINCT ON ("evidenceVersionId") id FROM platform_evidence_clearance WHERE "organizationId"=$1 AND "evidenceVersionId"=ANY($2) ORDER BY "evidenceVersionId", "createdAt" DESC, id DESC`, []any{actor.OrganizationID, sortedUnique(evidenceIDs)}, func(row entsql.ColumnScanner) error {
		var id string
		if err := row.Scan(&id); err != nil {
			return err
		}
		clearanceIDs = append(clearanceIDs, id)
		return nil
	})
	if err != nil {
		return fail(err)
	}
	clearances, err := client.EvidenceClearance.Query().Where(evidenceclearance.OrganizationID(actor.OrganizationID), evidenceclearance.IDIn(clearanceIDs...)).All(ctx)
	if err != nil {
		return fail(err)
	}
	clearanceByID := map[string]*ent.EvidenceClearance{}
	for _, clearance := range clearances {
		if clearanceByID[clearance.EvidenceVersionID] == nil {
			clearanceByID[clearance.EvidenceVersionID] = clearance
			authorityIDs = append(authorityIDs, clearance.HumanUserID)
		}
	}
	authorities, err := currentReadinessApprovers(ctx, client, actor.OrganizationID, sortedUnique(authorityIDs))
	if err != nil {
		return fail(err)
	}
	s.Qualified = facts.Decision != nil && facts.Decision.Decision == "QUALIFIED" && authorities[facts.Decision.HumanUserID]
	s.CoverageAuthority = authorities[revision.ApproverUserID] && (coverage == nil || authorities[coverage.HumanUserID])
	s.CoverageApproved = coverage != nil && coverage.Decision == kitreviewdecision.DecisionAPPROVE && coverage.ManifestSha256 == revision.ManifestSha256 && coverage.AssertionsConfirmed && coverage.ScreenshotsConfirmed && coverage.AudienceConfirmed
	s.FinalApproved = final != nil && final.Decision == kitreviewdecision.DecisionAPPROVE && final.ManifestSha256 == revision.ManifestSha256 && revision.State == kitrevision.StateAPPROVED
	s.FinalAuthority = final != nil && authorities[final.HumanUserID]
	assets, err := client.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(sortedUnique(assetIDs)...), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
	if err != nil {
		return fail(err)
	}
	assetsByID := map[string]*ent.Asset{}
	for _, a := range assets {
		assetsByID[a.ID] = a
	}
	pins, err := client.KitSourcePin.Query().Where(kitsourcepin.OrganizationID(actor.OrganizationID), kitsourcepin.KitRevisionID(revision.ID)).Order(ent.Asc(kitsourcepin.FieldSourceID)).All(ctx)
	if err != nil {
		return fail(err)
	}
	sourceIDs := []string{}
	for _, p := range pins {
		sourceIDs = append(sourceIDs, p.SourceID)
	}
	heads, err := client.EvidenceSource.Query().Where(evidencesource.OrganizationID(actor.OrganizationID), evidencesource.IDIn(sourceIDs...)).Order(ent.Asc(evidencesource.FieldID)).All(ctx)
	if err != nil {
		return fail(err)
	}
	headByID := map[string]*ent.EvidenceSource{}
	tokens := []map[string]string{}
	for _, h := range heads {
		headByID[h.ID] = h
		tokens = append(tokens, map[string]string{"id": h.ID, "sequence": strconv.FormatInt(h.ChangeSequence, 10), "availability": string(h.Availability), "version": optionalString(h.CurrentVersionID)})
	}
	for _, p := range pins {
		h := headByID[p.SourceID]
		if h == nil || h.ChangeSequence != p.AcknowledgedSequence {
			s.DependencyBlockers = append(s.DependencyBlockers, releasekits.Blocker{Code: "SOURCE_CHANGED", ObjectID: p.SourceID, RepairAction: "Review the source and prepare a new kit revision."})
		}
		if h == nil || h.Availability != evidencesource.AvailabilityAVAILABLE {
			s.DependencyBlockers = append(s.DependencyBlockers, releasekits.Blocker{Code: "EVIDENCE_UNAVAILABLE", ObjectID: p.SourceID, RepairAction: "Restore or replace unavailable evidence."})
		}
	}
	claimTokens := []map[string]string{}
	for _, id := range sortedUnique(claimIDs) {
		claim := claimByID[id]
		decision := ""
		if claim.Decision != nil {
			decision = claim.Decision.ID
		}
		claimTokens = append(claimTokens, map[string]string{"id": id, "version": claim.VersionID, "decision": decision, "state": claim.State})
	}
	for _, a := range artifacts {
		status := releasekits.ArtifactStatus{ID: a.ID, AudienceID: a.AudienceID, Kind: string(a.Kind), Classification: string(a.Classification), HasContent: len(a.Snapshot.Document) > 4, HasOutput: a.PreparedAt != nil && a.OutputSha256 != nil && a.OutputKey != nil, HasClaims: len(a.ClaimLinks) > 0, ClaimsVerified: true, EvidenceAvailable: true, SourcesCurrent: true, AudienceSafe: true, ScreenshotReviewed: s.CoverageApproved}
		customer := false
		for _, r := range s.Requirements {
			if r.ID == a.AudienceID {
				customer = r.Kind == "CUSTOMER"
			}
		}
		if customer && a.Classification != kitartifactrevision.ClassificationCUSTOMER_CLEARED {
			status.AudienceSafe = false
		}
		for _, p := range a.Snapshot.Assets {
			live := assetsByID[p.ID]
			if live == nil || optionalString(live.Sha256) != p.SHA256 {
				status.EvidenceAvailable = false
			}
		}
		for _, l := range a.ClaimLinks {
			claim, ok := claimByID[l.ClaimID]
			if !ok || claim.VersionID != l.ClaimVersionID || optionalString(claim.SupportSetID) != l.SupportSetID || claim.Decision == nil || claim.Decision.ID != l.VerificationID || claim.State != "SUPPORTED" {
				status.ClaimsVerified = false
			}
			for _, e := range claim.Evidence {
				if !e.Available {
					status.EvidenceAvailable = false
				}
				if !e.Current {
					status.SourcesCurrent = false
				}
				if customer {
					clearance := clearanceByID[e.ID]
					if e.AccessClass != "CUSTOMER_CLEARED" || clearance == nil || !slices.Contains(clearance.AudienceIds, a.AudienceID) || !authorities[clearance.HumanUserID] {
						status.AudienceSafe = false
					}
					if e.SourceURL != nil && kitContainsSourceURL(a.Snapshot, *e.SourceURL) {
						status.AudienceSafe = false
					}
				}
			}
		}
		s.Artifacts = append(s.Artifacts, status)
	}
	token, _, err := releasefacts.CanonicalHash("shots.kit-dependencies.v1", map[string]any{"manifest": revision.ManifestSha256, "qualification": optionalString(root.QualificationRevisionID), "qualified": s.Qualified, "qualificationCurrent": s.QualificationCurrent, "current": s.Current, "sources": tokens, "claims": claimTokens, "authorities": authorities, "artifacts": s.Artifacts})
	if err != nil {
		return fail(err)
	}
	s.DependencyToken = token
	return s, artifacts, decisions, nil
}

func kitContainsSourceURL(snapshot releasekits.NativeSnapshot, sourceURL string) bool {
	// Snapshot JSON escapes ampersands and Unicode; match the encoded string too.
	encoded, _ := json.Marshal(sourceURL)
	return strings.Contains(snapshot.Markdown, sourceURL) || strings.Contains(snapshot.Document, string(encoded[1:len(encoded)-1]))
}
