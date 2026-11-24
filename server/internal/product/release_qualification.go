package product

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/readinesscommandreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalification"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasequalificationdecision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacesettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
	"github.com/lucsky/cuid"
)

// QualificationError carries repairable failures across the HTTP and SDK boundaries.
type QualificationError struct {
	Reason             string                 `json:"reason"`
	CurrentRevision    string                 `json:"currentRevision"`
	Blockers           []QualificationBlocker `json:"blockers"`
	CanonicalReleaseID *string                `json:"canonicalReleaseId,omitempty"`
}

func (e *QualificationError) Error() string {
	switch e.Reason {
	case "MISSING_FACTS":
		return "Complete the missing release facts before recording this decision."
	case "READINESS_DISABLED":
		return "Release qualification is disabled for this workspace."
	case "COMMAND_KEY_REUSED":
		return "This request key was already used for different release facts."
	case "CANONICAL_RELEASE_CHANGED":
		return "This release was merged. Open its canonical release."
	case "RELEASE_INACTIVE":
		return "Reopen this release before changing its qualification."
	case "QUALIFICATION_UNAVAILABLE":
		return "Release qualification is busy. Retry this request."
	case "SOURCE_CHANGED":
		return "Review changed or unavailable source evidence before making a qualification decision."
	case "SOURCE_SELECTION_CHANGED":
		return "The selected releases contain different sources. Reload and review the complete selection."
	case "RELEASE_ALREADY_QUALIFIED":
		return "A previously qualified release keeps its identity. Create related work instead of merging or splitting it."
	case "RELEASE_HAS_REVIEWED_WORK":
		return "This release has approved or publishing work. Keep its identity and create related work instead."
	default:
		return "The release changed. Reload its current facts before deciding."
	}
}

func (e *QualificationError) Unwrap() error {
	if e.Reason == "READINESS_DISABLED" {
		return publishing.ErrForbidden
	}
	if e.Reason == "QUALIFICATION_UNAVAILABLE" {
		return ErrStorageUnavailable
	}
	return publishing.ErrConflict
}

func qualificationConflict(reason string, revision int64) *QualificationError {
	return &QualificationError{Reason: reason, CurrentRevision: strconv.FormatInt(revision, 10), Blockers: []QualificationBlocker{}}
}

type CreateQualificationInput struct {
	ExpectedRevision string             `json:"expectedRevision"`
	Facts            releasefacts.Facts `json:"facts"`
	Reason           *string            `json:"reason"`
}

type DecideQualificationInput struct {
	ExpectedRevision        string     `json:"expectedRevision"`
	QualificationRevisionID string     `json:"qualificationRevisionId"`
	Decision                string     `json:"decision"`
	Reason                  string     `json:"reason"`
	RevisitAt               *time.Time `json:"revisitAt"`
}

type QualificationDecision struct {
	ID          string     `json:"id"`
	Decision    string     `json:"decision"`
	HumanUserID string     `json:"humanUserId"`
	Reason      string     `json:"reason"`
	RevisitAt   *time.Time `json:"revisitAt"`
	CreatedAt   time.Time  `json:"createdAt"`
}

type QualificationRevision struct {
	ID               string                     `json:"id"`
	Version          string                     `json:"version"`
	ParentRevisionID *string                    `json:"parentRevisionId"`
	Facts            releasefacts.Facts         `json:"facts"`
	AuthorKind       string                     `json:"authorKind"`
	AuthorID         string                     `json:"authorId"`
	CreatedAt        time.Time                  `json:"createdAt"`
	Decision         *QualificationDecision     `json:"decision"`
	SourceAssets     []QualificationSourceAsset `json:"sourceAssets"`
	Sources          []QualificationSource      `json:"sources"`
}

type QualificationSourceAsset struct {
	ID        string `json:"id"`
	FileName  string `json:"fileName"`
	MediaType string `json:"mediaType"`
}

type ReleaseQualificationDetail struct {
	ReleaseID          string                 `json:"releaseId"`
	CanonicalReleaseID string                 `json:"canonicalReleaseId"`
	CanonicalState     string                 `json:"canonicalState"`
	Revision           string                 `json:"revision"`
	FirstQualifiedAt   *time.Time             `json:"firstQualifiedAt"`
	Enabled            bool                   `json:"enabled"`
	NeedsReview        bool                   `json:"needsReview"`
	State              string                 `json:"state"`
	Current            *QualificationRevision `json:"current"`
	MissingFacts       []QualificationBlocker `json:"missingFacts"`
}

func (c *Configuration) authorizeQualification(ctx context.Context, actor Actor, permission string) error {
	if actor.Kind == "api_key" && permission != "release:approve" {
		return c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, permission)
	}
	if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	roles := readRoles
	if permission == "release:create" {
		roles = launchEditRoles
	} else if permission == "release:approve" {
		roles = launchApproveRoles
	}
	if err := c.authorizeRoles(ctx, actor, roles...); err != nil {
		return err
	}
	return requireNotDenied(ctx, c.client, actor, permission)
}

func qualificationEnabled(ctx context.Context, client *ent.Client, org string) (bool, error) {
	return client.WorkspaceSettings.Query().Where(workspacesettings.ID(org), workspacesettings.ReleaseReadinessEnabled(true)).Exist(ctx)
}

// GetReleaseQualification uses one snapshot so a concurrent decision cannot mix heads and facts.
func (c *Configuration) GetReleaseQualification(ctx context.Context, actor Actor, id string) (*ReleaseQualificationDetail, error) {
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	if _, err = tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(id)).Only(ctx); ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	enabled, err := qualificationEnabled(ctx, tx.Client(), actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	detail := &ReleaseQualificationDetail{ReleaseID: id, CanonicalReleaseID: id, CanonicalState: "ACTIVE", Revision: "0", Enabled: enabled,
		State: "NEEDS_FACTS", MissingFacts: qualificationMissingFacts(releasefacts.Facts{Rollout: "UNKNOWN"}, "QUALIFIED", 0)}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return detail, tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	detail.Revision, detail.FirstQualifiedAt, detail.CanonicalState, detail.NeedsReview = strconv.FormatInt(root.HeadRevision, 10), root.FirstQualifiedAt, string(root.CanonicalState), root.NeedsReview
	sourceReview, err := qualificationSourcesNeedReview(ctx, tx.Client(), actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	detail.NeedsReview = detail.NeedsReview || sourceReview
	if root.MergedIntoReleaseID != nil {
		detail.CanonicalReleaseID, err = canonicalReleaseID(ctx, tx.Client(), actor.OrganizationID, id)
		if err != nil {
			return nil, err
		}
	}
	if root.QualificationRevisionID != nil {
		current, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, id, *root.QualificationRevisionID)
		if err != nil {
			return nil, err
		}
		detail.Current = current
		detail.MissingFacts = qualificationMissingFacts(current.Facts, "QUALIFIED", len(current.Sources))
		if current.Decision != nil && !detail.NeedsReview {
			detail.State = current.Decision.Decision
		}
	}
	if root.CanonicalState == releasereadiness.CanonicalStateWITHDRAWN {
		detail.State = "WITHDRAWN"
	}
	return detail, tx.Commit()
}

// GetQualificationRevision keeps prior decisions readable without changing the effective head.
func (c *Configuration) GetQualificationRevision(ctx context.Context, actor Actor, releaseID, id string) (*QualificationRevision, error) {
	tx, err := c.client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "artifact:read"); err != nil {
		return nil, err
	}
	result, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, releaseID, id)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func qualificationRevision(ctx context.Context, client *ent.Client, org, releaseID, id string) (*QualificationRevision, error) {
	row, err := client.ReleaseQualification.Query().Where(releasequalification.OrganizationID(org), releasequalification.ReleaseID(releaseID), releasequalification.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	pins, err := client.ReleaseQualificationAsset.Query().Where(releasequalificationasset.OrganizationID(org), releasequalificationasset.ReleaseID(releaseID), releasequalificationasset.QualificationRevisionID(id)).
		Order(ent.Asc(releasequalificationasset.FieldAssetID)).All(ctx)
	if err != nil {
		return nil, err
	}
	facts := releasefacts.Facts{OwnerUserID: row.OwnerUserID, FactReviewerUserID: row.FactReviewerUserID, Rationale: row.Rationale, Rollout: string(row.Rollout),
		Availability: row.Availability, Exclusions: row.Exclusions, Eligibility: row.Eligibility, PlannedAvailability: row.PlannedAvailability, ReadyAt: row.ReadyAt,
		HumanBrief: row.HumanBrief, HumanBriefAuthorUserID: row.HumanBriefAuthorUserID, SourceURLs: row.SourceUrls, SourceAssetIDs: []string{}, Requirements: row.Requirements}
	for _, pin := range pins {
		facts.SourceAssetIDs = append(facts.SourceAssetIDs, pin.AssetID)
	}
	result := &QualificationRevision{ID: row.ID, Version: strconv.FormatInt(row.Version, 10), ParentRevisionID: row.ParentRevisionID, Facts: facts,
		AuthorKind: string(row.AuthorKind), AuthorID: row.AuthorID, CreatedAt: row.CreatedAt, SourceAssets: []QualificationSourceAsset{}}
	result.Sources, err = qualificationRevisionSources(ctx, client, org, releaseID, id)
	if err != nil {
		return nil, err
	}
	if len(facts.SourceAssetIDs) > 0 {
		assets, err := client.Asset.Query().Where(asset.OrganizationID(org), asset.IDIn(facts.SourceAssetIDs...)).Order(ent.Asc(asset.FieldID)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, source := range assets {
			result.SourceAssets = append(result.SourceAssets, QualificationSourceAsset{ID: source.ID, FileName: path.Base(source.ObjectKey), MediaType: source.MediaType})
		}
	}
	decision, err := client.ReleaseQualificationDecision.Query().Where(releasequalificationdecision.OrganizationID(org), releasequalificationdecision.ReleaseID(releaseID), releasequalificationdecision.QualificationRevisionID(id)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if decision != nil {
		result.Decision = &QualificationDecision{ID: decision.ID, Decision: string(decision.Decision), HumanUserID: decision.HumanUserID, Reason: decision.Reason, RevisitAt: decision.RevisitAt, CreatedAt: decision.CreatedAt}
	}
	return result, nil
}

func qualificationActor(actor Actor) (string, string) {
	if actor.IsSession() {
		return "session", actor.UserID
	}
	return "api_key", actor.KeyID
}

func lockQualificationAuthority(ctx context.Context, tx *ent.Tx, actor Actor, permission string) error {
	var err error
	if actor.IsSession() {
		err = lockWorkspaceMembership(ctx, tx, actor)
	} else if actor.Kind == "api_key" && permission != "release:approve" {
		var found bool
		found, err = workspaceplan.LockWorkspace(ctx, tx, actor.OrganizationID)
		if err == nil && !found {
			err = publishing.ErrNotFound
		}
		if err == nil {
			_, err = tx.PlatformExec(ctx, `SELECT id FROM apikey WHERE id=$1 AND "referenceId"=$2 FOR SHARE`, actor.KeyID, actor.OrganizationID)
		}
	} else {
		err = publishing.ErrForbidden
	}
	if err != nil {
		return err
	}
	configuration := NewConfiguration(tx.Client())
	if err := configuration.authorizeQualification(ctx, actor, permission); err != nil {
		return err
	}
	return configuration.requireWorkspaceFeature(ctx, actor.OrganizationID, "release:create")
}

// Readiness commands share authority, receipt and aggregate locking; all effects
// commit together. Input locks precede aggregate locks and never span I/O.
type readinessCommandPolicy struct {
	permission string
	authorize  func(context.Context, *ent.Tx) error
	lockInputs func(context.Context, *ent.Tx) error
}

func (c *Configuration) readinessCommand(ctx context.Context, actor Actor, id, key, expected, operation, reviewerRevision string, references releasefacts.Facts, input any,
	apply func(context.Context, *ent.Tx, *ent.ReleaseReadiness) (*releasefacts.Result, error), policies ...readinessCommandPolicy) (_ *releasefacts.Result, failure error) {
	revision, err := strconv.ParseInt(expected, 10, 64)
	if err != nil || revision < 0 || strconv.FormatInt(revision, 10) != expected || !qualificationID(id) || !qualificationCommandKey(key) {
		return nil, ErrInvalidInput
	}
	permission := "release:create"
	if reviewerRevision != "" {
		permission = "release:approve"
	}
	var policy readinessCommandPolicy
	if len(policies) > 0 {
		policy = policies[0]
		permission = policy.permission
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	defer func() {
		var sqlError interface{ SQLState() string }
		if errors.Is(failure, context.DeadlineExceeded) || (errors.As(failure, &sqlError) && slices.Contains([]string{"55P03", "40P01", "40001", "57014"}, sqlError.SQLState())) {
			failure = qualificationConflict("QUALIFICATION_UNAVAILABLE", revision)
		}
	}()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SET LOCAL lock_timeout = '2s'`); err != nil {
		return nil, err
	}
	if err = lockQualificationAuthority(ctx, tx, actor, permission); err != nil {
		return nil, err
	}
	enabled, err := qualificationEnabled(ctx, tx.Client(), actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, qualificationConflict("READINESS_DISABLED", revision)
	}
	if policy.authorize != nil {
		if err = policy.authorize(ctx, tx); err != nil {
			return nil, err
		}
	}
	if reviewerRevision != "" {
		facts, err := tx.ReleaseQualification.Query().Where(releasequalification.OrganizationID(actor.OrganizationID), releasequalification.ReleaseID(id), releasequalification.ID(reviewerRevision)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		} else if err != nil {
			return nil, err
		}
		if facts.FactReviewerUserID == nil || *facts.FactReviewerUserID != actor.UserID {
			return nil, publishing.ErrForbidden
		}
		references.OwnerUserID, references.FactReviewerUserID, references.HumanBriefAuthorUserID = facts.OwnerUserID, facts.FactReviewerUserID, facts.HumanBriefAuthorUserID
	}
	kind, actorID := qualificationActor(actor)
	raw, err := json.Marshal(struct {
		ReleaseID string `json:"releaseId"`
		Input     any    `json:"input"`
	}{id, input})
	if err != nil {
		return nil, ErrInvalidInput
	}
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	receipt, err := tx.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(actor.OrganizationID), readinesscommandreceipt.ActorKindEQ(readinesscommandreceipt.ActorKind(kind)),
		readinesscommandreceipt.ActorID(actorID), readinesscommandreceipt.Operation(operation), readinesscommandreceipt.CommandKey(key)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if receipt != nil {
		if receipt.RequestSha256 != digest {
			return nil, qualificationConflict("COMMAND_KEY_REUSED", revision)
		}
		result := receipt.ResponseRef
		result.Created = false
		return &result, tx.Commit()
	}
	if err = validateQualificationMembers(ctx, tx, actor, references); err != nil {
		return nil, err
	}
	if policy.lockInputs != nil {
		if err = policy.lockInputs(ctx, tx); err != nil {
			return nil, err
		}
	}
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM release WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, actor.OrganizationID, id); err != nil {
		return nil, err
	}
	releaseRow, err := tx.Release.Query().Where(release.OrganizationID(actor.OrganizationID), release.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if releaseRow.Status == release.StatusARCHIVED || releaseRow.Status == release.StatusCANCELLED {
		return nil, qualificationConflict("RELEASE_INACTIVE", revision)
	}
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR UPDATE`, actor.OrganizationID, id); err != nil {
		return nil, err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		root, err = tx.ReleaseReadiness.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(id).Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	if root.CanonicalState == releasereadiness.CanonicalStateMERGED {
		return nil, requireCanonicalRelease(ctx, tx.Client(), actor.OrganizationID, id)
	}
	if root.HeadRevision != revision || root.HeadRevision == math.MaxInt64 {
		return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
	}
	result, err := apply(ctx, tx, root)
	if err != nil {
		return nil, err
	}
	if err = tx.ReadinessCommandReceipt.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(id).
		SetActorKind(readinesscommandreceipt.ActorKind(kind)).SetActorID(actorID).SetOperation(operation).SetCommandKey(key).SetRequestSha256(digest).SetResponseRef(*result).Exec(ctx); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

func validateQualificationMembers(ctx context.Context, tx *ent.Tx, actor Actor, facts releasefacts.Facts) error {
	ids := []string{}
	for _, id := range []*string{facts.OwnerUserID, facts.FactReviewerUserID, facts.HumanBriefAuthorUserID} {
		if id != nil {
			ids = append(ids, *id)
		}
	}
	for _, id := range sortedUnique(ids) {
		if _, err := tx.PlatformExec(ctx, `SELECT m.id FROM member m JOIN "user" u ON u.id=m."userId" WHERE m."organizationId"=$1 AND m."userId"=$2 FOR SHARE OF m,u`, actor.OrganizationID, id); err != nil {
			return err
		}
		person, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(id)).Only(ctx)
		if ent.IsNotFound(err) {
			return publishing.ErrNotFound
		} else if err != nil {
			return err
		}
		active, err := tx.User.Query().Where(user.ID(id), user.Or(user.BannedIsNil(), user.Banned(false))).Exist(ctx)
		if err != nil {
			return err
		}
		if !active {
			return publishing.ErrNotFound
		}
		if facts.FactReviewerUserID != nil && id == *facts.FactReviewerUserID {
			if !workspaceroles.Allows(person.Role, launchApproveRoles...) {
				return ErrInvalidInput
			}
			if err := requireNotDenied(ctx, tx.Client(), Actor{OrganizationID: actor.OrganizationID, UserID: id}, "release:approve"); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateQualificationAssets(ctx context.Context, tx *ent.Tx, actor Actor, facts releasefacts.Facts) error {
	ids := sortedUnique(facts.SourceAssetIDs)
	if len(ids) == 0 {
		return nil
	}
	// IDs are validated before building the array; stable order avoids opposing source locks.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM asset WHERE "organizationId"=$1 AND id=ANY($2::text[]) ORDER BY id FOR SHARE`, actor.OrganizationID, "{"+strings.Join(ids, ",")+"}"); err != nil {
		return err
	}
	count, err := tx.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(ids...), asset.StatusEQ(asset.StatusUPLOADED), asset.Not(asset.ObjectKeyHasPrefix(videoPosterPrefix(actor.OrganizationID)))).Count(ctx)
	if err != nil {
		return err
	}
	if count != len(ids) {
		return publishing.ErrNotFound
	}
	return nil
}

func appendQualificationRevision(ctx context.Context, tx *ent.Tx, actor Actor, root *ent.ReleaseReadiness, facts releasefacts.Facts) (*ent.ReleaseQualification, error) {
	version := int64(1)
	if root.QualificationRevisionID != nil {
		previous, err := tx.ReleaseQualification.Query().Where(releasequalification.OrganizationID(actor.OrganizationID), releasequalification.ReleaseID(root.ReleaseID), releasequalification.ID(*root.QualificationRevisionID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if previous.Version == math.MaxInt64 {
			return nil, publishing.ErrConflict
		}
		version = previous.Version + 1
	}
	if facts.SourceURLs == nil {
		facts.SourceURLs = []string{}
	}
	if facts.Requirements == nil {
		facts.Requirements = []releasefacts.Audience{}
	}
	facts.Requirements = slices.Clone(facts.Requirements)
	for i := range facts.Requirements {
		if facts.Requirements[i].Materials == nil {
			facts.Requirements[i].Materials = []string{}
		}
		if facts.Requirements[i].Omissions == nil {
			facts.Requirements[i].Omissions = []releasefacts.Omission{}
		}
	}
	kind, author := qualificationActor(actor)
	row, err := tx.ReleaseQualification.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(root.ReleaseID).
		SetVersion(version).SetAggregateRevision(root.HeadRevision + 1).SetNillableParentRevisionID(root.QualificationRevisionID).
		SetNillableOwnerUserID(facts.OwnerUserID).SetNillableFactReviewerUserID(facts.FactReviewerUserID).SetNillableRationale(facts.Rationale).
		SetRollout(releasequalification.Rollout(facts.Rollout)).SetNillableAvailability(facts.Availability).SetNillableExclusions(facts.Exclusions).
		SetNillableEligibility(facts.Eligibility).SetNillablePlannedAvailability(facts.PlannedAvailability).SetNillableReadyAt(facts.ReadyAt).
		SetNillableHumanBrief(facts.HumanBrief).SetNillableHumanBriefAuthorUserID(facts.HumanBriefAuthorUserID).
		SetSourceUrls(facts.SourceURLs).SetRequirements(facts.Requirements).SetAuthorKind(releasequalification.AuthorKind(kind)).SetAuthorID(author).Save(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range facts.SourceAssetIDs {
		if err := tx.ReleaseQualificationAsset.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(root.ReleaseID).
			SetQualificationRevisionID(row.ID).SetAssetID(id).Exec(ctx); err != nil {
			return nil, err
		}
	}
	sources, err := qualificationSourceBindings(ctx, tx.Client(), actor.OrganizationID, root.ReleaseID)
	if err != nil {
		return nil, err
	}
	pins := []*ent.ReleaseQualificationSourceCreate{}
	for _, source := range sources {
		if source.SelectedObservationID != nil {
			pins = append(pins, tx.ReleaseQualificationSource.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(root.ReleaseID).
				SetQualificationRevisionID(row.ID).SetBindingID(source.ID).SetObservationID(*source.SelectedObservationID))
		}
	}
	if len(pins) > 0 {
		if err := tx.ReleaseQualificationSource.CreateBulk(pins...).Exec(ctx); err != nil {
			return nil, err
		}
	}
	return row, nil
}

func qualificationActivity(ctx context.Context, tx *ent.Tx, actor Actor, root *ent.ReleaseReadiness, revisionID, state string, facts releasefacts.Facts) error {
	participants := []string{}
	for _, id := range []*string{facts.OwnerUserID, facts.FactReviewerUserID} {
		if id != nil {
			participants = append(participants, *id)
		}
	}
	human := ""
	if actor.IsSession() {
		human = actor.UserID
	}
	return activity.Emit(ctx, tx, actor.OrganizationID, "release.qualification_changed", "release", root.ReleaseID, human,
		root.ReleaseID+":"+strconv.FormatInt(root.HeadRevision+1, 10), map[string]any{"qualificationRevisionId": revisionID, "state": state, "recipientUserIds": sortedUnique(participants)})
}

func (c *Configuration) CreateQualificationRevision(ctx context.Context, actor Actor, id, key string, input CreateQualificationInput) (*releasefacts.Result, error) {
	if !validQualificationFacts(input.Facts) || !qualificationText(input.Reason, 4000) {
		return nil, ErrInvalidInput
	}
	return c.readinessCommand(ctx, actor, id, key, input.ExpectedRevision, "qualification.revise", "", input.Facts, input,
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) (*releasefacts.Result, error) {
			if root.CanonicalState == releasereadiness.CanonicalStateWITHDRAWN {
				if input.Reason == nil || !actor.IsSession() {
					return nil, publishing.ErrForbidden
				}
				if err := NewConfiguration(tx.Client()).authorizeQualification(ctx, actor, "release:approve"); err != nil {
					return nil, err
				}
				previous, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, id, *root.QualificationRevisionID)
				if err != nil {
					return nil, err
				}
				if previous.Facts.FactReviewerUserID == nil || *previous.Facts.FactReviewerUserID != actor.UserID {
					return nil, publishing.ErrForbidden
				}
			}
			if err := validateQualificationAssets(ctx, tx, actor, input.Facts); err != nil {
				return nil, err
			}
			return reviseQualification(ctx, tx, actor, root, input.Facts, input.Reason)
		})
}

func reviseQualification(ctx context.Context, tx *ent.Tx, actor Actor, root *ent.ReleaseReadiness, facts releasefacts.Facts, reason *string) (*releasefacts.Result, error) {
	row, err := appendQualificationRevision(ctx, tx, actor, root, facts)
	if err != nil {
		return nil, err
	}
	needsReview, err := qualificationSourcesNeedReview(ctx, tx.Client(), actor.OrganizationID, root.ReleaseID)
	if err != nil {
		return nil, err
	}
	if err = tx.ReleaseReadiness.UpdateOneID(root.ID).SetQualificationRevisionID(row.ID).SetHeadRevision(root.HeadRevision + 1).
		SetNeedsReview(needsReview).SetCanonicalState(releasereadiness.CanonicalStateACTIVE).Exec(ctx); err != nil {
		return nil, err
	}
	if err = appendConfigurationAudit(ctx, tx, actor, "product.release_facts_revised", "release", root.ReleaseID, map[string]any{"qualificationRevisionId": row.ID, "revision": strconv.FormatInt(root.HeadRevision+1, 10), "reason": reason}); err != nil {
		return nil, err
	}
	if err = qualificationActivity(ctx, tx, actor, root, row.ID, "NEEDS_FACTS", facts); err != nil {
		return nil, err
	}
	return &releasefacts.Result{Created: true, Revision: strconv.FormatInt(root.HeadRevision+1, 10), QualificationRevisionID: row.ID}, nil
}

func (c *Configuration) DecideQualification(ctx context.Context, actor Actor, id, key string, input DecideQualificationInput) (*releasefacts.Result, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if !qualificationID(input.QualificationRevisionID) || !slices.Contains([]string{"QUALIFIED", "NO_COMMUNICATION", "DEFERRED", "WITHDRAWN", "REOPEN"}, input.Decision) ||
		!qualificationText(&input.Reason, 4000) || (input.RevisitAt != nil && (input.Decision != "DEFERRED" || input.RevisitAt.IsZero() || input.RevisitAt.Year() < 1 || input.RevisitAt.Year() > 9999)) {
		return nil, ErrInvalidInput
	}
	return c.readinessCommand(ctx, actor, id, key, input.ExpectedRevision, "qualification.decide", input.QualificationRevisionID, releasefacts.Facts{}, input,
		func(ctx context.Context, tx *ent.Tx, root *ent.ReleaseReadiness) (*releasefacts.Result, error) {
			if input.RevisitAt != nil && !input.RevisitAt.After(time.Now()) {
				return nil, ErrInvalidInput
			}
			if root.QualificationRevisionID == nil || *root.QualificationRevisionID != input.QualificationRevisionID || (root.CanonicalState == releasereadiness.CanonicalStateWITHDRAWN) != (input.Decision == "REOPEN") {
				return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
			}
			current, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, id, input.QualificationRevisionID)
			if err != nil {
				return nil, err
			}
			if input.Decision == "REOPEN" {
				if err = validateQualificationAssets(ctx, tx, actor, current.Facts); err != nil {
					return nil, err
				}
				// Reopening restores an unqualified draft; it cannot confirm rollout or edit facts.
				current.Facts.Rollout = "UNKNOWN"
				return reviseQualification(ctx, tx, actor, root, current.Facts, &input.Reason)
			}
			needsReview, err := qualificationSourcesNeedReview(ctx, tx.Client(), actor.OrganizationID, id)
			if err != nil {
				return nil, err
			}
			if input.Decision != "WITHDRAWN" && needsReview {
				return nil, qualificationConflict("SOURCE_CHANGED", root.HeadRevision)
			}
			if input.Decision != "WITHDRAWN" && (current.Decision != nil || root.NeedsReview) {
				return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
			}
			if err = validateQualificationAssets(ctx, tx, actor, current.Facts); err != nil {
				return nil, err
			}
			if missing := qualificationMissingFacts(current.Facts, input.Decision, len(current.Sources)); input.Decision != "WITHDRAWN" && len(missing) > 0 {
				return nil, &QualificationError{Reason: "MISSING_FACTS", CurrentRevision: strconv.FormatInt(root.HeadRevision, 10), Blockers: missing}
			}
			revisionID := current.ID
			update := tx.ReleaseReadiness.UpdateOneID(root.ID).SetHeadRevision(root.HeadRevision + 1).SetNeedsReview(false)
			if input.Decision == "WITHDRAWN" {
				current.Facts.Rollout = "WITHDRAWN"
				withdrawn, err := appendQualificationRevision(ctx, tx, actor, root, current.Facts)
				if err != nil {
					return nil, err
				}
				revisionID = withdrawn.ID
				update.SetQualificationRevisionID(revisionID).SetCanonicalState(releasereadiness.CanonicalStateWITHDRAWN)
			}
			decision, err := tx.ReleaseQualificationDecision.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(id).
				SetQualificationRevisionID(revisionID).SetDecision(releasequalificationdecision.Decision(input.Decision)).SetHumanUserID(actor.UserID).
				SetSessionID(actor.SessionID).SetReason(input.Reason).SetNillableRevisitAt(input.RevisitAt).Save(ctx)
			if err != nil {
				return nil, err
			}
			if input.Decision == "QUALIFIED" && root.FirstQualifiedAt == nil {
				update.SetFirstQualifiedAt(decision.CreatedAt)
			}
			if err = update.Exec(ctx); err != nil {
				return nil, err
			}
			if err = appendConfigurationAudit(ctx, tx, actor, "product.release_qualification_decided", "release", id, map[string]any{"qualificationRevisionId": revisionID, "decisionId": decision.ID, "decision": input.Decision}); err != nil {
				return nil, err
			}
			if err = qualificationActivity(ctx, tx, actor, root, revisionID, input.Decision, current.Facts); err != nil {
				return nil, err
			}
			return &releasefacts.Result{Created: true, Revision: strconv.FormatInt(root.HeadRevision+1, 10), QualificationRevisionID: revisionID, DecisionID: &decision.ID}, nil
		})
}

// The caller holds the release row lock. Legacy writes preserve facts and decisions
// but advance the fence even while qualification is disabled for new commands.
func invalidateReleaseQualification(ctx context.Context, tx *ent.Tx, actor Actor, id string) error {
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_release_readiness WHERE "organizationId"=$1 AND "releaseId"=$2 FOR UPDATE`, actor.OrganizationID, id); err != nil {
		return err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(actor.OrganizationID), releasereadiness.ReleaseID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if root.HeadRevision == math.MaxInt64 {
		return publishing.ErrConflict
	}
	if err := tx.ReleaseReadiness.UpdateOneID(root.ID).SetHeadRevision(root.HeadRevision + 1).SetNeedsReview(true).Exec(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_facts_invalidated", "release", id, map[string]any{"revision": strconv.FormatInt(root.HeadRevision+1, 10)}); err != nil {
		return err
	}
	if root.QualificationRevisionID == nil {
		return nil
	}
	current, err := qualificationRevision(ctx, tx.Client(), actor.OrganizationID, id, *root.QualificationRevisionID)
	if err != nil {
		return err
	}
	return qualificationActivity(ctx, tx, actor, root, current.ID, "NEEDS_FACTS", current.Facts)
}
