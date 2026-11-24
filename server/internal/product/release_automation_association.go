package product

import (
	"context"
	"strconv"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaselineagebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasereadiness"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

// Caller holds the source row lock shared with release creation. Explicit PR
// references and provider occurrence times establish membership, never arrival.
func associateLateSourceChange(ctx context.Context, tx *ent.Tx, actor Actor, source *ent.SourceApp, input CollectSourceChangeInput, changeID string) error {
	selected, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(actor.OrganizationID), releasesourcebinding.SourceAppID(input.SourceAppID),
		releasesourcebinding.ObjectKindEQ(releasesourcebinding.ObjectKindPULL_REQUEST), releasesourcebinding.RepositoryID(input.RepositoryID), releasesourcebinding.ProviderObjectID(strconv.Itoa(input.Number))).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	candidates := []string{}
	if selected != nil {
		moved, err := lineageSourceRelease(ctx, tx.Client(), actor.OrganizationID, selected)
		if err != nil {
			return err
		}
		if moved != "" {
			candidates = append(candidates, moved)
		}
	}
	if len(candidates) == 0 {
		var complete bool
		candidates, complete, err = sourceChangeReleaseCandidates(ctx, tx, actor.OrganizationID, input.SourceAppID, input.RepositoryID, input.Number, input.MergedAt)
		if err != nil {
			return err
		}
		if !complete {
			return appendConfigurationAudit(ctx, tx, actor, "product.source_change_association_unresolved", "source_change", changeID, map[string]any{"reason": "Too many explicit release references; manual association required."})
		}
		if selected != nil && selected.CanonicalReleaseID != nil {
			candidates = append(candidates, *selected.CanonicalReleaseID)
		}
	}
	candidates, err = canonicalReleaseIDs(ctx, tx.Client(), actor.OrganizationID, candidates)
	if err != nil {
		return err
	}
	if len(candidates) > 1 {
		return appendConfigurationAudit(ctx, tx, actor, "product.source_change_association_unresolved", "source_change", changeID, map[string]any{"reason": "Multiple releases explicitly reference this PR; no arrival-order guess was made."})
	}
	if len(candidates) == 0 {
		return nil
	}
	// A release may have been removed independently of its durable intake key.
	n, err := tx.Release.Update().Where(release.ID(candidates[0]), release.OrganizationID(actor.OrganizationID)).SetUpdatedAt(time.Now()).Save(ctx)
	if err != nil || n == 0 {
		return err
	}
	row, err := tx.Release.Query().Where(release.ID(candidates[0]), release.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	associated, err := tx.SourceChange.Update().Where(sourcechange.ID(changeID), sourcechange.OrganizationID(actor.OrganizationID), sourcechange.ReleaseIDIsNil()).SetReleaseID(row.ID).Save(ctx)
	if err != nil {
		return err
	}
	if associated == 0 {
		return nil
	}
	named := false
	for _, feature := range row.Features {
		named = named || feature.Number == input.Number
	}
	if !named && len(row.Features) < releasenotes.MaxFeatures && !ignoresAuthor(source, optionalText(input.AuthorLogin)) {
		kind, title := releasenotes.Title(input.Title)
		features := append(row.Features, releasenotes.Feature{Kind: kind, Title: title, Number: input.Number, URL: input.URL, Author: optionalText(input.AuthorLogin)})
		if err := row.Update().SetFeatures(features).Exec(ctx); err != nil {
			return err
		}
	}
	if err := invalidateReleaseQualification(ctx, tx, actor, row.ID); err != nil {
		return err
	}
	return appendConfigurationAudit(ctx, tx, actor, "product.source_change_associated", "source_change", changeID, map[string]any{"releaseId": row.ID, "reason": "Explicit source selection or PR reference and provider occurrence time."})
}

// Source locks serialize human selection with later automation of the same objects.
func selectedSourceRelease(ctx context.Context, tx *ent.Tx, org string, input IngestSourceReleaseInput, frontend *ent.FrontendActivation) (string, error) {
	enabled, err := qualificationEnabled(ctx, tx.Client(), org)
	if err != nil || input.automationAssociation == nil {
		return "", err
	}
	if !enabled {
		// Disabling new readiness work must preserve previously moved source ownership.
		moved, err := tx.ReleaseLineageBinding.Query().Where(releaselineagebinding.OrganizationID(org)).Exist(ctx)
		if err != nil || !moved {
			return "", err
		}
	}
	ids := []string{}
	var changes []*ent.SourceChange
	movedPRs := map[string]bool{}
	objects := []predicate.ReleaseSourceBinding{}
	evidence := input.automationAssociation
	if len(evidence.Numbers) > 0 && input.RepositoryID != nil {
		numbers := make([]string, 0, len(evidence.Numbers))
		for _, number := range evidence.Numbers {
			numbers = append(numbers, strconv.Itoa(number))
		}
		objects = append(objects, releasesourcebinding.And(releasesourcebinding.SourceAppID(input.SourceAppID), releasesourcebinding.RepositoryID(*input.RepositoryID),
			releasesourcebinding.ObjectKindEQ(releasesourcebinding.ObjectKindPULL_REQUEST), releasesourcebinding.ProviderObjectIDIn(numbers...)))
		if enabled {
			changes, err = tx.SourceChange.Query().Where(sourcechange.OrganizationID(org), sourcechange.SourceAppID(input.SourceAppID), sourcechange.RepositoryID(*input.RepositoryID),
				sourcechange.NumberIn(evidence.Numbers...), sourcechange.MergedAtLTE(evidence.Cutoff), sourcechange.ReleaseIDNotNil()).Limit(201).All(ctx)
			if err != nil {
				return "", err
			}
			if len(changes) > 200 {
				return "", &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_LIMIT"}
			}
		}
	}
	if frontend != nil {
		source, err := tx.FrontendSource.Query().Where(frontendsource.OrganizationID(org), frontendsource.ID(frontend.SourceID)).Only(ctx)
		if err != nil {
			return "", err
		}
		if frontendGitHubSourceID(source) != input.SourceAppID || !source.Enabled {
			return "", publishing.ErrForbidden
		}
		objects = append(objects, releasesourcebinding.And(releasesourcebinding.SourceAppID(source.ID), releasesourcebinding.ObjectKindEQ(releasesourcebinding.ObjectKindDEPLOYMENT),
			releasesourcebinding.ProviderObjectID(frontend.Snapshot.DeploymentID)))
	} else if parts := strings.Split(input.EventID, ":"); len(parts) == 4 && parts[0] == "deployment" && input.RepositoryID != nil && parts[1] == *input.RepositoryID {
		objects = append(objects, releasesourcebinding.And(releasesourcebinding.SourceAppID(input.SourceAppID), releasesourcebinding.RepositoryID(parts[1]),
			releasesourcebinding.ObjectKindEQ(releasesourcebinding.ObjectKindDEPLOYMENT), releasesourcebinding.ProviderObjectID(parts[2])))
	}
	if len(objects) > 0 {
		bindings, err := tx.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(org), releasesourcebinding.CanonicalReleaseIDNotNil(), releasesourcebinding.Or(objects...)).Limit(201).All(ctx)
		if err != nil {
			return "", err
		}
		if len(bindings) > 200 {
			return "", &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_LIMIT"}
		}
		pullRequests := []string{}
		for _, binding := range bindings {
			if binding.ObjectKind == releasesourcebinding.ObjectKindPULL_REQUEST {
				pullRequests = append(pullRequests, binding.ID)
			}
		}
		occurred := map[string]bool{}
		if len(pullRequests) > 0 {
			observed, err := tx.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(org), releasesourceobservation.BindingIDIn(pullRequests...),
				releasesourceobservation.OccurredAtLTE(evidence.Cutoff)).Unique(true).Select(releasesourceobservation.FieldBindingID).Strings(ctx)
			if err != nil {
				return "", err
			}
			for _, id := range observed {
				occurred[id] = true
			}
		}
		for _, binding := range bindings {
			if binding.ObjectKind == releasesourcebinding.ObjectKindPULL_REQUEST && !occurred[binding.ID] {
				continue
			}
			moved, err := lineageSourceRelease(ctx, tx.Client(), org, binding)
			if err != nil {
				return "", err
			}
			if moved != "" {
				if binding.ObjectKind == releasesourcebinding.ObjectKindPULL_REQUEST {
					movedPRs[binding.ProviderObjectID] = true
				}
				ids = append(ids, moved)
			} else if enabled {
				ids = append(ids, *binding.CanonicalReleaseID)
			}
		}
	}
	for _, change := range changes {
		if !movedPRs[strconv.Itoa(change.Number)] {
			ids = append(ids, *change.ReleaseID)
		}
	}
	ids, err = canonicalReleaseIDs(ctx, tx.Client(), org, ids)
	if err != nil {
		return "", err
	}
	if len(ids) == 0 {
		return "", nil
	}
	if len(ids) != 1 {
		return "", &SourceSelectionError{Reason: "SOURCE_ASSOCIATION_CONFLICT"}
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM release WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, org, ids[0]); err != nil {
		return "", err
	}
	row, err := tx.Release.Query().Where(release.OrganizationID(org), release.ID(ids[0])).Only(ctx)
	if err != nil {
		return "", err
	}
	root, err := tx.ReleaseReadiness.Query().Where(releasereadiness.OrganizationID(org), releasereadiness.ReleaseID(row.ID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return "", err
	}
	if row.Status == release.StatusARCHIVED || row.Status == release.StatusCANCELLED || root != nil && root.CanonicalState != releasereadiness.CanonicalStateACTIVE {
		return "", qualificationConflict("RELEASE_INACTIVE", 0)
	}
	return row.ID, nil
}

func sourceChangeReleaseCandidates(ctx context.Context, tx *ent.Tx, org, sourceID, repository string, number int, mergedAt time.Time) ([]string, bool, error) {
	candidates, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(org), outboxevent.Type("release.ingested"), func(s *sql.Selector) {
		s.Where(sqljson.ValueEQ(outboxevent.FieldPayload, sourceID, sqljson.Path("sourceAppId")))
		s.Where(sqljson.ValueEQ(outboxevent.FieldPayload, repository, sqljson.Path("associationRepository")))
		s.Where(sqljson.ValueContains(outboxevent.FieldPayload, number, sqljson.Path("associationNumbers")))
	}).Limit(101).All(ctx)
	if err != nil || len(candidates) > 100 {
		return nil, false, err
	}
	ids := []string{}
	for _, candidate := range candidates {
		text, _ := candidate.Payload["associationCutoff"].(string)
		cutoff, err := time.Parse(time.RFC3339Nano, text)
		if err == nil && !mergedAt.After(cutoff) {
			ids = append(ids, candidate.AggregateID)
		}
	}
	return sortedUnique(ids), true, nil
}
