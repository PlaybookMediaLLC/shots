package product

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/readinesscommandreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaselineage"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaselineagebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type ReleaseLineageParticipant struct {
	ReleaseID        string `json:"releaseId"`
	ExpectedRevision string `json:"expectedRevision"`
}

type MergeReleaseInput struct {
	ExpectedRevision string                      `json:"expectedRevision"`
	Sources          []ReleaseLineageParticipant `json:"sources"`
	BindingIDs       []string                    `json:"bindingIds"`
	Reason           string                      `json:"reason"`
}

type ReleaseSplitGroup struct {
	BindingIDs []string           `json:"bindingIds"`
	NewRelease ReleaseSourceBrief `json:"newRelease"`
}

type SplitReleaseInput struct {
	ExpectedRevision string              `json:"expectedRevision"`
	Groups           []ReleaseSplitGroup `json:"groups"`
	Reason           string              `json:"reason"`
}

type ReleaseLineageResult struct {
	Created    bool                            `json:"created"`
	ReleaseID  string                          `json:"releaseId"`
	Releases   []releasefacts.ReleaseReference `json:"releases"`
	LineageIDs []string                        `json:"lineageIds"`
}

type ReleaseLineageEntry struct {
	ID                   string    `json:"id"`
	Operation            string    `json:"operation"`
	SourceReleaseID      string    `json:"sourceReleaseId"`
	DestinationReleaseID string    `json:"destinationReleaseId"`
	SourceRevision       string    `json:"sourceRevision"`
	DestinationRevision  string    `json:"destinationRevision"`
	Reason               string    `json:"reason"`
	HumanUserID          string    `json:"humanUserId"`
	CreatedAt            time.Time `json:"createdAt"`
	BindingIDs           []string  `json:"bindingIds"`
}

type ReleaseLineageHistory struct {
	Items      []ReleaseLineageEntry `json:"items"`
	NextCursor *string               `json:"nextCursor"`
}

// History remains readable when readiness writes are disabled or the release is an alias.
func (c *Configuration) GetReleaseLineage(ctx context.Context, actor Actor, id, cursor string) (*ReleaseLineageHistory, error) {
	if !qualificationID(id) || cursor != "" && !qualificationID(cursor) {
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
	exists, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(id)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, publishing.ErrNotFound
	}
	query := tx.ReleaseLineage.Query().Where(releaselineage.OrganizationID(actor.OrganizationID),
		releaselineage.Or(releaselineage.SourceReleaseID(id), releaselineage.DestinationReleaseID(id)))
	if cursor != "" {
		query.Where(releaselineage.IDLT(cursor))
	}
	rows, err := query.Order(ent.Desc(releaselineage.FieldID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &ReleaseLineageHistory{Items: []ReleaseLineageEntry{}}
	if len(rows) > 50 {
		rows = rows[:50]
		result.NextCursor = &rows[len(rows)-1].ID
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	moves, err := tx.ReleaseLineageBinding.Query().Where(releaselineagebinding.OrganizationID(actor.OrganizationID), releaselineagebinding.LineageIDIn(ids...)).
		Order(ent.Asc(releaselineagebinding.FieldBindingID)).Limit(10001).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(moves) > 10000 {
		return nil, ErrStorageUnavailable
	}
	bindings := make(map[string][]string, len(rows))
	for _, move := range moves {
		bindings[move.LineageID] = append(bindings[move.LineageID], move.BindingID)
	}
	for _, row := range rows {
		members := bindings[row.ID]
		if members == nil {
			members = []string{}
		}
		result.Items = append(result.Items, ReleaseLineageEntry{ID: row.ID, Operation: string(row.Operation), SourceReleaseID: row.SourceReleaseID,
			DestinationReleaseID: row.DestinationReleaseID, SourceRevision: strconv.FormatInt(row.SourceRevision, 10), DestinationRevision: strconv.FormatInt(row.DestinationRevision, 10),
			Reason: row.Reason, HumanUserID: row.HumanUserID, CreatedAt: row.CreatedAt, BindingIDs: members})
	}
	return result, tx.Commit()
}

func lineageParticipants(participants []ReleaseLineageParticipant) (map[string]int64, error) {
	if len(participants) == 0 || len(participants) > 20 {
		return nil, ErrInvalidInput
	}
	result := make(map[string]int64, len(participants))
	for _, participant := range participants {
		revision, err := strconv.ParseInt(participant.ExpectedRevision, 10, 64)
		if err != nil || revision < 0 || strconv.FormatInt(revision, 10) != participant.ExpectedRevision || !qualificationID(participant.ReleaseID) {
			return nil, ErrInvalidInput
		}
		if _, duplicate := result[participant.ReleaseID]; duplicate {
			return nil, ErrInvalidInput
		}
		result[participant.ReleaseID] = revision
	}
	return result, nil
}

func lineageBindingIDs(ids []string) ([]string, error) {
	if len(ids) > 200 {
		return nil, ErrInvalidInput
	}
	result := slices.Clone(ids)
	slices.Sort(result)
	for i, id := range result {
		if !qualificationID(id) || i > 0 && result[i-1] == id {
			return nil, ErrInvalidInput
		}
	}
	return result, nil
}

// Grouping changes identity, so unlike evidence intake it requires a live human session.
func (c *Configuration) releaseLineageCommand(ctx context.Context, actor Actor, id, key, operation, reason string, participants []ReleaseLineageParticipant, bindingIDs []string, input any,
	apply func(context.Context, *ent.Tx, map[string]*ent.ReleaseReadiness, []*ent.ReleaseSourceBinding) (*ReleaseLineageResult, error)) (_ *ReleaseLineageResult, failure error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	expected, err := lineageParticipants(participants)
	if err != nil || !qualificationCommandKey(key) || !qualificationText(&reason, 4000) {
		return nil, ErrInvalidInput
	}
	ids := make([]string, 0, len(expected))
	for releaseID := range expected {
		ids = append(ids, releaseID)
	}
	slices.Sort(ids)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	defer func() {
		var sqlError interface{ SQLState() string }
		if errors.Is(failure, context.DeadlineExceeded) || errors.As(failure, &sqlError) && slices.Contains([]string{"55P03", "40P01", "40001", "57014"}, sqlError.SQLState()) {
			failure = qualificationConflict("QUALIFICATION_UNAVAILABLE", expected[id])
		}
	}()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SET LOCAL lock_timeout = '2s'`); err != nil {
		return nil, err
	}
	if err := lockQualificationAuthority(ctx, tx, actor, "release:create"); err != nil {
		return nil, err
	}
	enabled, err := qualificationEnabled(ctx, tx.Client(), actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, qualificationConflict("READINESS_DISABLED", expected[id])
	}
	raw, err := json.Marshal(struct {
		ReleaseID string `json:"releaseId"`
		Input     any    `json:"input"`
	}{id, input})
	if err != nil {
		return nil, ErrInvalidInput
	}
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	receipt, err := tx.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(actor.OrganizationID),
		readinesscommandreceipt.ActorKindEQ(readinesscommandreceipt.ActorKindSession), readinesscommandreceipt.ActorID(actor.UserID),
		readinesscommandreceipt.Operation(operation), readinesscommandreceipt.CommandKey(key)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if receipt != nil {
		if receipt.RequestSha256 != digest {
			return nil, qualificationConflict("COMMAND_KEY_REUSED", expected[id])
		}
		bindings, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.IDIn(bindingIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		if len(bindings) != len(bindingIDs) {
			return nil, publishing.ErrNotFound
		}
		if err := lockReleaseSources(ctx, tx, actor.OrganizationID, bindings); err != nil {
			return nil, err
		}
		return &ReleaseLineageResult{ReleaseID: receipt.ReleaseID, Releases: receipt.ResponseRef.Releases, LineageIDs: receipt.ResponseRef.LineageIDs}, tx.Commit()
	}
	bindings, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.CanonicalReleaseIDIn(ids...)).
		Order(ent.Asc(releasesourcebinding.FieldID)).Limit(201).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(bindings) > 200 {
		return nil, &SourceSelectionError{Reason: "SOURCE_LIMIT"}
	}
	if err := lockReleaseSources(ctx, tx, actor.OrganizationID, bindings); err != nil {
		return nil, err
	}
	owned := make(map[string]bool, len(bindings))
	for _, binding := range bindings {
		owned[binding.ID] = true
	}
	for _, bindingID := range bindingIDs {
		if !owned[bindingID] {
			return nil, publishing.ErrNotFound
		}
	}
	roots := make(map[string]*ent.ReleaseReadiness, len(ids))
	for _, releaseID := range ids {
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM release WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, actor.OrganizationID, releaseID); err != nil {
			return nil, err
		}
		row, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(releaseID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		} else if err != nil {
			return nil, err
		}
		if row.Status == release.StatusARCHIVED || row.Status == release.StatusCANCELLED {
			return nil, qualificationConflict("RELEASE_INACTIVE", expected[releaseID])
		}
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR UPDATE`, actor.OrganizationID, releaseID); err != nil {
			return nil, err
		}
		root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(releaseID)).Only(ctx)
		if ent.IsNotFound(err) {
			root, err = tx.ReleaseReadiness.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).Save(ctx)
		}
		if err != nil {
			return nil, err
		}
		if root.CanonicalState != releasereadiness.CanonicalStateACTIVE {
			if root.CanonicalState == releasereadiness.CanonicalStateMERGED {
				return nil, requireCanonicalRelease(ctx, tx.Client(), actor.OrganizationID, releaseID)
			}
			return nil, qualificationConflict("RELEASE_INACTIVE", root.HeadRevision)
		}
		if root.HeadRevision != expected[releaseID] || root.HeadRevision == math.MaxInt64 {
			return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
		}
		if root.FirstQualifiedAt != nil {
			return nil, qualificationConflict("RELEASE_ALREADY_QUALIFIED", root.HeadRevision)
		}
		if err := releaseLineageEligibility(ctx, tx, actor.OrganizationID, releaseID, root.HeadRevision); err != nil {
			return nil, err
		}
		roots[releaseID] = root
	}
	result, err := apply(ctx, tx, roots, bindings)
	if err != nil {
		return nil, err
	}
	if err := tx.ReadinessCommandReceipt.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(id).
		SetActorKind(readinesscommandreceipt.ActorKindSession).SetActorID(actor.UserID).SetOperation(operation).SetCommandKey(key).SetRequestSha256(digest).
		SetResponseRef(releasefacts.Result{Created: true, Releases: result.Releases, LineageIDs: result.LineageIDs}).Exec(ctx); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func appendReleaseLineage(ctx context.Context, tx *ent.Tx, actor Actor, operation, source, destination, reason string, sourceRevision, destinationRevision int64, bindings []string) (string, error) {
	id := cuid.New()
	if err := tx.ReleaseLineage.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetOperation(releaselineage.Operation(operation)).
		SetSourceReleaseID(source).SetDestinationReleaseID(destination).SetSourceRevision(sourceRevision).SetDestinationRevision(destinationRevision).
		SetReason(reason).SetHumanUserID(actor.UserID).SetSessionID(actor.SessionID).Exec(ctx); err != nil {
		return "", err
	}
	if len(bindings) > 0 {
		moves := make([]*ent.ReleaseLineageBindingCreate, 0, len(bindings))
		for _, bindingID := range bindings {
			moves = append(moves, tx.ReleaseLineageBinding.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetLineageID(id).SetBindingID(bindingID))
		}
		if err := tx.ReleaseLineageBinding.CreateBulk(moves...).Exec(ctx); err != nil {
			return "", err
		}
		if err := tx.ReleaseSourceBinding.Update().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.IDIn(bindings...)).SetCanonicalReleaseID(destination).Exec(ctx); err != nil {
			return "", err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_"+strings.ToLower(operation), "release", source,
		map[string]any{"lineageId": id, "destinationReleaseId": destination, "reason": reason, "bindingIds": bindings}); err != nil {
		return "", err
	}
	return id, nil
}

func (c *Configuration) MergeRelease(ctx context.Context, actor Actor, id, key string, input MergeReleaseInput) (*ReleaseLineageResult, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if len(input.Sources) == 0 || len(input.Sources) > 19 {
		return nil, ErrInvalidInput
	}
	var err error
	input.BindingIDs, err = lineageBindingIDs(input.BindingIDs)
	if err != nil {
		return nil, err
	}
	input.Reason = strings.TrimSpace(input.Reason)
	input.Sources = slices.Clone(input.Sources)
	slices.SortFunc(input.Sources, func(a, b ReleaseLineageParticipant) int { return strings.Compare(a.ReleaseID, b.ReleaseID) })
	participants := append([]ReleaseLineageParticipant{{ReleaseID: id, ExpectedRevision: input.ExpectedRevision}}, input.Sources...)
	return c.releaseLineageCommand(ctx, actor, id, key, "release.merge", input.Reason, participants, input.BindingIDs, input,
		func(ctx context.Context, tx *ent.Tx, roots map[string]*ent.ReleaseReadiness, bindings []*ent.ReleaseSourceBinding) (*ReleaseLineageResult, error) {
			moving := []string{}
			bySource := make(map[string][]string, len(input.Sources))
			for _, binding := range bindings {
				if *binding.CanonicalReleaseID != id {
					moving = append(moving, binding.ID)
					bySource[*binding.CanonicalReleaseID] = append(bySource[*binding.CanonicalReleaseID], binding.ID)
				}
			}
			if !slices.Equal(moving, input.BindingIDs) {
				return nil, qualificationConflict("SOURCE_SELECTION_CHANGED", roots[id].HeadRevision)
			}
			result := &ReleaseLineageResult{Created: true, ReleaseID: id, Releases: []releasefacts.ReleaseReference{}, LineageIDs: []string{}}
			survivor := roots[id]
			if err := survivor.Update().AddHeadRevision(1).SetNeedsReview(true).Exec(ctx); err != nil {
				return nil, err
			}
			result.Releases = append(result.Releases, releasefacts.ReleaseReference{ReleaseID: id, Revision: strconv.FormatInt(survivor.HeadRevision+1, 10)})
			for _, source := range input.Sources {
				root := roots[source.ReleaseID]
				if err := root.Update().AddHeadRevision(1).SetNeedsReview(true).SetCanonicalState(releasereadiness.CanonicalStateMERGED).SetMergedIntoReleaseID(id).Exec(ctx); err != nil {
					return nil, err
				}
				// Keep old URLs one hop from the survivor while immutable lineage retains each move.
				if err := tx.ReleaseReadiness.Update().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.MergedIntoReleaseID(source.ReleaseID)).SetMergedIntoReleaseID(id).Exec(ctx); err != nil {
					return nil, err
				}
				lineageID, err := appendReleaseLineage(ctx, tx, actor, "MERGE", source.ReleaseID, id, input.Reason, root.HeadRevision+1, survivor.HeadRevision+1, bySource[source.ReleaseID])
				if err != nil {
					return nil, err
				}
				result.LineageIDs = append(result.LineageIDs, lineageID)
				result.Releases = append(result.Releases, releasefacts.ReleaseReference{ReleaseID: source.ReleaseID, Revision: strconv.FormatInt(root.HeadRevision+1, 10)})
			}
			return result, nil
		})
}

func (c *Configuration) SplitRelease(ctx context.Context, actor Actor, id, key string, input SplitReleaseInput) (*ReleaseLineageResult, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if len(input.Groups) == 0 || len(input.Groups) > 20 {
		return nil, ErrInvalidInput
	}
	input.Reason = strings.TrimSpace(input.Reason)
	input.Groups = slices.Clone(input.Groups)
	ids := []string{}
	for i, group := range input.Groups {
		var err error
		group.BindingIDs, err = lineageBindingIDs(group.BindingIDs)
		group.NewRelease.Title = strings.TrimSpace(group.NewRelease.Title)
		group.NewRelease.BenefitStatement = strings.TrimSpace(group.NewRelease.BenefitStatement)
		if err != nil || len(group.BindingIDs) == 0 || !validReleaseBrief(group.NewRelease.Title, group.NewRelease.BenefitStatement, nil, nil, nil) {
			return nil, ErrInvalidInput
		}
		ids = append(ids, group.BindingIDs...)
		input.Groups[i] = group
	}
	ids, err := lineageBindingIDs(ids)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(input.Groups, func(a, b ReleaseSplitGroup) int { return strings.Compare(a.BindingIDs[0], b.BindingIDs[0]) })
	return c.releaseLineageCommand(ctx, actor, id, key, "release.split", input.Reason, []ReleaseLineageParticipant{{ReleaseID: id, ExpectedRevision: input.ExpectedRevision}}, ids, input,
		func(ctx context.Context, tx *ent.Tx, roots map[string]*ent.ReleaseReadiness, _ []*ent.ReleaseSourceBinding) (*ReleaseLineageResult, error) {
			root := roots[id]
			source, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(id)).Only(ctx)
			if err != nil {
				return nil, err
			}
			if err := root.Update().AddHeadRevision(1).SetNeedsReview(true).Exec(ctx); err != nil {
				return nil, err
			}
			result := &ReleaseLineageResult{Created: true, ReleaseID: id, Releases: []releasefacts.ReleaseReference{{ReleaseID: id, Revision: strconv.FormatInt(root.HeadRevision+1, 10)}}, LineageIDs: []string{}}
			for _, group := range input.Groups {
				created, err := createReleaseInTx(ctx, tx, actor, CreateReleaseInput{Title: group.NewRelease.Title, BenefitStatement: group.NewRelease.BenefitStatement,
					SourceURLs: []string{}, ProductSurfaceID: source.ProductSurfaceID, IdempotencyKey: "release-split:" + cuid.New()})
				if err != nil {
					return nil, err
				}
				if err := tx.ReleaseReadiness.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(created.ID).SetHeadRevision(1).SetNeedsReview(true).Exec(ctx); err != nil {
					return nil, err
				}
				lineageID, err := appendReleaseLineage(ctx, tx, actor, "SPLIT", id, created.ID, input.Reason, root.HeadRevision+1, 1, group.BindingIDs)
				if err != nil {
					return nil, err
				}
				result.LineageIDs = append(result.LineageIDs, lineageID)
				result.Releases = append(result.Releases, releasefacts.ReleaseReference{ReleaseID: created.ID, Revision: "1"})
			}
			return result, nil
		})
}

func releaseLineageEligibility(ctx context.Context, tx *ent.Tx, org, id string, revision int64) error {
	var reviewed bool
	err := tx.PlatformQuery(ctx, `SELECT
 EXISTS (SELECT 1 FROM release_spec WHERE "organizationId"=$1 AND "releaseId"=$2 AND "approvedAt" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM release_document WHERE "organizationId"=$1 AND "releaseId"=$2 AND "approvedAt" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM campaign_plan p JOIN campaign c ON c.id=p."campaignId" AND c."organizationId"=p."organizationId" WHERE c."organizationId"=$1 AND c."releaseId"=$2 AND p."approvedAt" IS NOT NULL)
 OR EXISTS (SELECT 1 FROM campaign_post p JOIN campaign c ON c.id=p."campaignId" AND c."organizationId"=p."organizationId" WHERE c."organizationId"=$1 AND c."releaseId"=$2 AND (p."approvedAt" IS NOT NULL OR p."scheduledPostId" IS NOT NULL))
 OR EXISTS (SELECT 1 FROM creative_variant v JOIN approval a ON a."variantId"=v.id AND a."organizationId"=v."organizationId" WHERE v."organizationId"=$1 AND v."releaseId"=$2 AND a.status='APPROVED')
 OR EXISTS (SELECT 1 FROM scheduled_post p LEFT JOIN creative_variant v ON v.id=p."variantId" AND v."organizationId"=p."organizationId" LEFT JOIN content_draft d ON d.id=p."contentDraftId" AND d."organizationId"=p."organizationId" LEFT JOIN campaign c ON c.id=d."campaignId" AND c."organizationId"=d."organizationId" WHERE p."organizationId"=$1 AND (v."releaseId"=$2 OR d."releaseId"=$2 OR c."releaseId"=$2))
 OR EXISTS (SELECT 1 FROM customer_communication c JOIN release_document d ON d.id=c."releaseDocumentId" AND d."organizationId"=c."organizationId" WHERE d."organizationId"=$1 AND d."releaseId"=$2)`, []any{org, id}, func(row entsql.ColumnScanner) error { return row.Scan(&reviewed) })
	if err != nil {
		return err
	}
	if reviewed {
		return qualificationConflict("RELEASE_HAS_REVIEWED_WORK", revision)
	}
	return nil
}

// New merges flatten aliases; traversal also keeps earlier chains safe to read.
func canonicalReleaseID(ctx context.Context, client *ent.Client, org, id string) (string, error) {
	seen := map[string]bool{}
	for {
		if seen[id] {
			return "", ErrStorageUnavailable
		}
		seen[id] = true
		root, err := client.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(org), releasereadiness.ReleaseID(id)).Only(ctx)
		if ent.IsNotFound(err) {
			return id, nil
		}
		if err != nil {
			return "", err
		}
		if root.CanonicalState != releasereadiness.CanonicalStateMERGED {
			return id, nil
		}
		if root.MergedIntoReleaseID == nil {
			return "", ErrStorageUnavailable
		}
		id = *root.MergedIntoReleaseID
	}
}

// Callers hold the organization or release lock until their write commits.
func requireCanonicalRelease(ctx context.Context, client *ent.Client, org, id string) error {
	root, err := client.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(org), releasereadiness.ReleaseID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if root.CanonicalState != releasereadiness.CanonicalStateMERGED {
		return nil
	}
	canonical, err := canonicalReleaseID(ctx, client, org, id)
	if err != nil {
		return err
	}
	conflict := qualificationConflict("CANONICAL_RELEASE_CHANGED", root.HeadRevision)
	conflict.CanonicalReleaseID = &canonical
	return conflict
}

func canonicalReleaseIDs(ctx context.Context, client *ent.Client, org string, ids []string) ([]string, error) {
	ids = sortedUnique(ids)
	roots, err := client.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(org), releasereadiness.ReleaseIDIn(ids...), releasereadiness.CanonicalStateEQ(releasereadiness.CanonicalStateMERGED)).All(ctx)
	if err != nil {
		return nil, err
	}
	aliases := make(map[string]string, len(roots))
	for _, root := range roots {
		canonical, err := canonicalReleaseID(ctx, client, org, root.ReleaseID)
		if err != nil {
			return nil, err
		}
		aliases[root.ReleaseID] = canonical
	}
	for i, id := range ids {
		if canonical := aliases[id]; canonical != "" {
			ids[i] = canonical
		}
	}
	return sortedUnique(ids), nil
}

// An explicit human move outranks immutable intake receipts that name the old release.
func lineageSourceRelease(ctx context.Context, client *ent.Client, org string, binding *ent.ReleaseSourceBinding) (string, error) {
	if binding.CanonicalReleaseID == nil {
		return "", nil
	}
	moved, err := client.ReleaseLineageBinding.Query().Where(releaselineagebinding.OrganizationID(org), releaselineagebinding.BindingID(binding.ID)).Exist(ctx)
	if err != nil || !moved {
		return "", err
	}
	return canonicalReleaseID(ctx, client, org, *binding.CanonicalReleaseID)
}
