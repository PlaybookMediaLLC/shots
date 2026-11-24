package product

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendactivation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/readinesscommandreceipt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"github.com/lucsky/cuid"
)

type ReleaseSourceChoice struct {
	BindingID        string `json:"bindingId"`
	ObservationID    string `json:"observationId"`
	ExpectedSequence string `json:"expectedSequence"`
}

type ReleaseSourceBrief struct {
	Title            string `json:"title"`
	BenefitStatement string `json:"benefitStatement"`
}

type SelectReleaseSourcesInput struct {
	ReleaseID        *string               `json:"releaseId"`
	NewRelease       *ReleaseSourceBrief   `json:"newRelease"`
	ExpectedRevision string                `json:"expectedRevision"`
	Sources          []ReleaseSourceChoice `json:"sources"`
}

type ReleaseSourceSelection struct {
	Created   bool   `json:"created"`
	ReleaseID string `json:"releaseId"`
	Revision  string `json:"revision"`
}

type SourceSelectionError struct {
	Reason    string  `json:"reason"`
	BindingID *string `json:"bindingId"`
	ReleaseID *string `json:"releaseId"`
}

func (e *SourceSelectionError) Error() string {
	switch e.Reason {
	case "SOURCE_UNAVAILABLE":
		return "Reconnect the source before selecting its evidence."
	case "SOURCE_ALREADY_ASSOCIATED":
		return "This source already belongs to a release. Open that release to review its evidence."
	case "SOURCE_ASSOCIATION_CONFLICT":
		return "These sources reference different releases. Review their associations before grouping them."
	case "SOURCE_ASSOCIATION_LIMIT":
		return "This source has too many existing release references to select safely. Review its associations first."
	case "SOURCE_LIMIT":
		return "A release can select at most 200 source objects."
	default:
		return "Source evidence changed. Reload it before saving this selection."
	}
}

func (e *SourceSelectionError) Unwrap() error {
	if e.Reason == "SOURCE_UNAVAILABLE" {
		return publishing.ErrForbidden
	}
	return publishing.ErrConflict
}

func (c *Configuration) SelectReleaseSources(ctx context.Context, actor Actor, key string, input SelectReleaseSourcesInput) (_ *ReleaseSourceSelection, failure error) {
	revision, err := strconv.ParseInt(input.ExpectedRevision, 10, 64)
	if err != nil || revision < 0 || strconv.FormatInt(revision, 10) != input.ExpectedRevision || !qualificationCommandKey(key) ||
		(input.ReleaseID == nil) == (input.NewRelease == nil) || len(input.Sources) == 0 || len(input.Sources) > 200 {
		return nil, ErrInvalidInput
	}
	if input.ReleaseID != nil && !qualificationID(*input.ReleaseID) {
		return nil, ErrInvalidInput
	}
	if input.NewRelease != nil {
		brief := *input.NewRelease
		brief.Title, brief.BenefitStatement = strings.TrimSpace(brief.Title), strings.TrimSpace(brief.BenefitStatement)
		if revision != 0 || !validReleaseBrief(brief.Title, brief.BenefitStatement, nil, nil, nil) {
			return nil, ErrInvalidInput
		}
		input.NewRelease = &brief
	}
	ids := make([]string, 0, len(input.Sources))
	choices := make(map[string]ReleaseSourceChoice, len(input.Sources))
	for _, choice := range input.Sources {
		sequence, err := strconv.ParseInt(choice.ExpectedSequence, 10, 64)
		if err != nil || sequence <= 0 || strconv.FormatInt(sequence, 10) != choice.ExpectedSequence || !qualificationID(choice.BindingID) || !qualificationID(choice.ObservationID) {
			return nil, ErrInvalidInput
		}
		if _, duplicate := choices[choice.BindingID]; duplicate {
			return nil, ErrInvalidInput
		}
		ids, choices[choice.BindingID] = append(ids, choice.BindingID), choice
	}
	input.Sources = slices.Clone(input.Sources)
	slices.SortFunc(input.Sources, func(a, b ReleaseSourceChoice) int { return strings.Compare(a.BindingID, b.BindingID) })
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	defer func() {
		var sqlError interface{ SQLState() string }
		if errors.Is(failure, context.DeadlineExceeded) || errors.As(failure, &sqlError) && slices.Contains([]string{"55P03", "40P01", "40001", "57014"}, sqlError.SQLState()) {
			failure = qualificationConflict("QUALIFICATION_UNAVAILABLE", revision)
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
		return nil, qualificationConflict("READINESS_DISABLED", revision)
	}
	query := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.IDIn(ids...))
	bindings, err := query.Clone().All(ctx)
	if err != nil {
		return nil, err
	}
	if len(bindings) != len(ids) {
		return nil, publishing.ErrNotFound
	}
	if err := lockReleaseSources(ctx, tx, actor.OrganizationID, bindings); err != nil {
		return nil, err
	}
	// Source locks cover both new receipts and authority-checked replays.
	kind, actorID := qualificationActor(actor)
	raw, err := json.Marshal(input)
	if err != nil {
		return nil, ErrInvalidInput
	}
	hash := sha256.Sum256(raw)
	digest := hex.EncodeToString(hash[:])
	receipt, err := tx.ReadinessCommandReceipt.Query().Where(readinesscommandreceipt.OrganizationID(actor.OrganizationID), readinesscommandreceipt.ActorKindEQ(readinesscommandreceipt.ActorKind(kind)),
		readinesscommandreceipt.ActorID(actorID), readinesscommandreceipt.Operation("source.select"), readinesscommandreceipt.CommandKey(key)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if receipt != nil {
		if receipt.RequestSha256 != digest {
			return nil, qualificationConflict("COMMAND_KEY_REUSED", revision)
		}
		return &ReleaseSourceSelection{ReleaseID: receipt.ReleaseID, Revision: receipt.ResponseRef.Revision}, tx.Commit()
	}
	bindings, err = query.Order(ent.Asc(releasesourcebinding.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		choice := choices[binding.ID]
		if choice.ExpectedSequence != strconv.FormatInt(binding.LastEventSequence, 10) {
			return nil, &SourceSelectionError{Reason: "SOURCE_CHANGED", BindingID: &binding.ID}
		}
		observation, err := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(actor.OrganizationID), releasesourceobservation.BindingID(binding.ID), releasesourceobservation.ID(choice.ObservationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		} else if err != nil {
			return nil, err
		}
		associations, err := releaseSourceAssociations(ctx, tx, binding, observation.OccurredAt)
		if err != nil {
			return nil, err
		}
		if len(associations) > 1 {
			return nil, &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_CONFLICT", BindingID: &binding.ID}
		}
		if len(associations) == 1 && (input.ReleaseID == nil || *input.ReleaseID != associations[0]) {
			return nil, &SourceSelectionError{Reason: "SOURCE_ALREADY_ASSOCIATED", BindingID: &binding.ID, ReleaseID: &associations[0]}
		}
	}
	releaseID := ""
	if input.ReleaseID != nil {
		releaseID = *input.ReleaseID
	} else {
		created, err := createReleaseInTx(ctx, tx, actor, CreateReleaseInput{Title: input.NewRelease.Title, BenefitStatement: input.NewRelease.BenefitStatement, SourceURLs: []string{}, IdempotencyKey: "source-selection:" + cuid.New()})
		if err != nil {
			return nil, err
		}
		releaseID = created.ID
		if err := appendConfigurationAudit(ctx, tx, actor, "product.release_created", "release", releaseID, map[string]any{"productSurfaceId": nil}); err != nil {
			return nil, err
		}
	}
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
		return nil, qualificationConflict("RELEASE_INACTIVE", revision)
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
	if root.HeadRevision != revision || revision == math.MaxInt64 {
		return nil, qualificationConflict("REVISION_CONFLICT", root.HeadRevision)
	}
	count, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.CanonicalReleaseID(releaseID), releasesourcebinding.IDNotIn(ids...)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count+len(ids) > 200 {
		return nil, &SourceSelectionError{Reason: "SOURCE_LIMIT", ReleaseID: &releaseID}
	}
	changed := false
	for _, binding := range bindings {
		if optionalText(binding.CanonicalReleaseID) == releaseID && optionalText(binding.SelectedObservationID) == choices[binding.ID].ObservationID &&
			binding.SelectedChangeSequence == binding.ChangeSequence && !binding.NeedsResolution {
			continue
		}
		changed = true
		if err := binding.Update().SetCanonicalReleaseID(releaseID).SetSelectedObservationID(choices[binding.ID].ObservationID).SetSelectedChangeSequence(binding.ChangeSequence).SetNeedsResolution(false).Exec(ctx); err != nil {
			return nil, err
		}
		if binding.ObjectKind == releasesourcebinding.ObjectKindPULL_REQUEST {
			number, err := strconv.Atoi(binding.ProviderObjectID)
			if err != nil {
				return nil, ErrInvalidInput
			}
			if _, err := tx.SourceChange.Update().Where(sourcechange.OrganizationID(actor.OrganizationID), sourcechange.SourceAppID(binding.SourceAppID), sourcechange.RepositoryID(binding.RepositoryID), sourcechange.Number(number), sourcechange.ReleaseIDIsNil()).SetReleaseID(releaseID).Save(ctx); err != nil {
				return nil, err
			}
		}
	}
	if changed {
		revision++
		if err := root.Update().SetHeadRevision(revision).SetNeedsReview(true).Exec(ctx); err != nil {
			return nil, err
		}
	}
	result := &ReleaseSourceSelection{Created: true, ReleaseID: releaseID, Revision: strconv.FormatInt(revision, 10)}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_sources_selected", "release", releaseID, map[string]any{"sources": input.Sources, "revision": result.Revision}); err != nil {
		return nil, err
	}
	if err := tx.ReadinessCommandReceipt.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).
		SetActorKind(readinesscommandreceipt.ActorKind(kind)).SetActorID(actorID).SetOperation("source.select").SetCommandKey(key).SetRequestSha256(digest).
		SetResponseRef(releasefacts.Result{Created: true, Revision: result.Revision}).Exec(ctx); err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

// Existing workflow receipts and explicit PR references are stronger than a new candidate request.
func releaseSourceAssociations(ctx context.Context, tx *ent.Tx, binding *ent.ReleaseSourceBinding, occurredAt time.Time) ([]string, error) {
	if moved, err := lineageSourceRelease(ctx, tx.Client(), binding.OrganizationID, binding); err != nil {
		return nil, err
	} else if moved != "" {
		return []string{moved}, nil
	}
	ids, keys := []string{}, []string{}
	if binding.CanonicalReleaseID != nil {
		ids = append(ids, *binding.CanonicalReleaseID)
	}
	prefix := "source:" + binding.SourceAppID + ":"
	if binding.ObjectKind == releasesourcebinding.ObjectKindPULL_REQUEST {
		number, err := strconv.Atoi(binding.ProviderObjectID)
		if err != nil || number <= 0 {
			return nil, ErrInvalidInput
		}
		change, err := tx.SourceChange.Query().Where(sourcechange.OrganizationID(binding.OrganizationID), sourcechange.SourceAppID(binding.SourceAppID), sourcechange.RepositoryID(binding.RepositoryID), sourcechange.Number(number)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if change != nil && change.ReleaseID != nil {
			ids = append(ids, *change.ReleaseID)
		}
		explicit, complete, err := sourceChangeReleaseCandidates(ctx, tx, binding.OrganizationID, binding.SourceAppID, binding.RepositoryID, number, occurredAt)
		if err != nil {
			return nil, err
		}
		if !complete {
			return nil, &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_LIMIT", BindingID: &binding.ID}
		}
		ids = append(ids, explicit...)
		keys = append(keys, prefix+"pr:"+binding.RepositoryID+":"+binding.ProviderObjectID)
	} else {
		if binding.Provider == "github" {
			semantic := prefix + "deployment:" + binding.RepositoryID + ":" + binding.ProviderObjectID
			keys = append(keys, semantic+":success", semantic+":qualified")
		}
		frontend, err := tx.FrontendSource.Query().Where(frontendsource.OrganizationID(binding.OrganizationID), frontendsource.ID(binding.SourceAppID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if frontend != nil {
			activations, err := tx.FrontendActivation.Query().Where(frontendactivation.OrganizationID(binding.OrganizationID), frontendactivation.SourceID(binding.SourceAppID), func(s *sql.Selector) {
				s.Where(sqljson.ValueEQ(frontendactivation.FieldSnapshot, binding.ProviderObjectID, sqljson.Path("deploymentId")))
			}).Limit(201).All(ctx)
			if err != nil {
				return nil, err
			}
			if len(activations) > 200 {
				return nil, &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_LIMIT", BindingID: &binding.ID}
			}
			for _, activation := range activations {
				keys = append(keys, "source:"+frontendGitHubSourceID(frontend)+":frontend:"+activation.ID)
			}
		}
	}
	if len(keys) > 0 {
		events, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(binding.OrganizationID), outboxevent.Type("release.ingested"), outboxevent.IdempotencyKeyIn(keys...)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, event := range events {
			ids = append(ids, event.AggregateID)
		}
	}
	return canonicalReleaseIDs(ctx, tx.Client(), binding.OrganizationID, ids)
}

// Selection and regrouping hold the same live source authority through commitment.
func lockReleaseSources(ctx context.Context, tx *ent.Tx, org string, bindings []*ent.ReleaseSourceBinding) error {
	sourceIDs := []string{}
	for _, binding := range bindings {
		sourceIDs = append(sourceIDs, binding.SourceAppID)
	}
	frontends, err := tx.FrontendSource.Query().Where(frontendsource.OrganizationID(org), frontendsource.IDIn(sortedUnique(sourceIDs)...)).All(ctx)
	if err != nil {
		return err
	}
	for _, frontend := range frontends {
		if frontend.GithubSourceID != "" {
			sourceIDs = append(sourceIDs, frontend.GithubSourceID)
		}
	}
	for _, id := range sortedUnique(sourceIDs) {
		source, err := lockAutomationSource(ctx, tx, org, id)
		if err != nil {
			return err
		}
		if source.GithubInstallationID != nil {
			if _, err := tx.PlatformExec(ctx, `SELECT id FROM github_installation WHERE id=$1 FOR SHARE`, *source.GithubInstallationID); err != nil {
				return err
			}
		}
		if err := releaseSourceAccess(ctx, tx.Client(), source); err != nil {
			if errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrInvalidState) || errors.Is(err, publishing.ErrNotFound) {
				return &SourceSelectionError{Reason: "SOURCE_UNAVAILABLE"}
			}
			return err
		}
	}
	return nil
}
