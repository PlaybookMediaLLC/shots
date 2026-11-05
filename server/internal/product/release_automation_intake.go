package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/lucsky/cuid"
)

const EventReleaseAutomationDispatch = "release_automation.dispatch"
const EventReleaseAutomationCancel = "release_automation.cancel"

type AcceptGitHubEventInput struct {
	DeliveryID string          `json:"deliveryId"`
	EventName  string          `json:"eventName"`
	Body       json.RawMessage `json:"body"`
}

type GitHubEventAcceptance struct {
	Handled    int `json:"handled"`
	Duplicates int `json:"duplicates"`
}

// AcceptGitHubEvent is facade-only, after raw-body signature verification.
// All tenant receipts and dispatch intents commit atomically: a failed fan-out
// has no partial effects, and a redelivery can safely retry the whole envelope.
func (c *Configuration) AcceptGitHubEvent(ctx context.Context, input AcceptGitHubEventInput) (result *GitHubEventAcceptance, resultErr error) {
	started := time.Now()
	defer func() {
		accepted, duplicates, status := 0, 0, "ignored"
		if result != nil {
			accepted, duplicates = result.Handled, result.Duplicates
		}
		if accepted > 0 {
			status = "accepted"
		} else if duplicates > 0 {
			status = "duplicate"
		}
		if resultErr != nil {
			status = "persistence_failed"
			if errors.Is(resultErr, ErrInvalidInput) {
				status = "rejected"
			}
		}
		slog.InfoContext(ctx, "github_release_event", "delivery_id", input.DeliveryID, "status", status, "accepted", accepted, "duplicates", duplicates, "acceptance_ms", time.Since(started).Milliseconds())
	}()
	if input.DeliveryID == "" || len(input.DeliveryID) > 255 {
		return nil, ErrInvalidInput
	}
	evidence, err := automation.NormalizeGitHubEvidence(input.EventName, input.Body)
	if err != nil {
		return nil, ErrInvalidInput
	}
	installation, event, err := automation.NormalizeGitHub(input.EventName, input.Body)
	if err != nil && evidence == nil {
		return nil, ErrInvalidInput
	}
	if evidence != nil {
		installation = evidence.InstallationID
		if event == nil {
			event = &automation.Event{RepositoryID: evidence.RepositoryID}
		}
	}
	frontend, err := c.acceptGitHubFrontend(ctx, input)
	if err != nil {
		return nil, err
	}
	if event == nil {
		return &frontend, nil
	}
	sources, err := c.GitHubSources(ctx, installation, event.RepositoryID)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(sources, func(a, b *WebhookSource) int { return strings.Compare(a.ID, b.ID) })
	for attempt := 0; attempt < 3; attempt++ {
		result, err := c.acceptGitHubEvent(ctx, input.DeliveryID, *event, sources, evidence)
		if ent.IsConstraintError(err) {
			continue
		}
		if result != nil {
			result.Handled += frontend.Handled
			result.Duplicates += frontend.Duplicates
		}
		return result, err
	}
	return nil, errors.New("event acceptance contention")
}

func (c *Configuration) acceptGitHubEvent(ctx context.Context, delivery string, event automation.Event, sources []*WebhookSource, evidence *automation.GitHubEvidence) (*GitHubEventAcceptance, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result := &GitHubEventAcceptance{}
	origin, err := c.githubDeliveryOrigin(ctx, delivery)
	if err != nil {
		return nil, err
	}
	if origin != "live" {
		event.Origin = "historical"
	}
	for _, candidate := range sources {
		source, err := lockAutomationSource(ctx, tx, candidate.OrganizationID, candidate.ID)
		if err != nil {
			return nil, err
		}
		if evidence != nil {
			if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
				return nil, err
			}
			legacy, duplicate, err := recordGitHubObservation(ctx, tx, source, delivery, origin, *evidence)
			if err != nil {
				return nil, err
			}
			if !legacy || event.Family == "" || origin != "live" {
				if duplicate {
					result.Duplicates++
				} else {
					result.Handled++
				}
				continue
			}
		}
		// Tag pushes and milestones only exist as workflow triggers; a legacy
		// source has no behavior for them, so nothing is recorded.
		if !source.ReleaseAutomation && automation.FamilyVersion(event.Family) > 1 {
			continue
		}
		if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
			return nil, err
		}
		prior, err := tx.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(source.OrganizationID), releasesourceevent.SourceAppID(source.ID), releasesourceevent.SemanticKey(event.SemanticKey)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if prior {
			result.Duplicates++
			continue
		}
		versions := []string{}
		mode := "legacy"
		status, reason := "queued", "Accepted for the Release inbox."
		if source.ReleaseAutomation {
			mode = "automation"
			definitions, err := tx.ReleaseAutomation.Query().Where(releaseautomation.OrganizationID(source.OrganizationID), releaseautomation.SourceAppID(source.ID), releaseautomation.Family(string(event.Family)), releaseautomation.Enabled(true)).Order(ent.Asc(releaseautomation.FieldActivePriority), ent.Asc(releaseautomation.FieldID)).All(ctx)
			if err != nil {
				return nil, err
			}
			for _, definition := range definitions {
				if definition.ActiveVersionID != nil {
					versions = append(versions, *definition.ActiveVersionID)
				}
			}
			reason = "Workflows are checked in priority order; the first match runs."
			if len(versions) == 0 && !(event.Family == automation.Merged && source.AutomationCollectUnmatched) && !(event.Family == automation.Deployed && productionDeployment(event)) {
				status, reason = "skipped", "No active workflow handles this event, so nothing ran."
			}
		}
		if filter := automationSourceFilter(source, event); filter != "" {
			status, reason = "skipped", filter
		}
		if event.Origin == "historical" {
			status, reason = "skipped", "Historical import; marketing workflows never execute for backfill."
		}
		eventID, runID := cuid.New(), cuid.New()
		if _, err := tx.ReleaseSourceEvent.Create().SetID(eventID).SetOrganizationID(source.OrganizationID).SetSourceAppID(source.ID).SetSemanticKey(event.SemanticKey).SetDeliveryID(delivery).SetSnapshot(event).SetVersionIds(versions).SetCollectUnmatched(source.AutomationCollectUnmatched).SetMode(mode).SetDisposition(status).SetReason(reason).Save(ctx); err != nil {
			return nil, err
		}
		create := tx.ReleaseAutomationRun.Create().SetID(runID).SetOrganizationID(source.OrganizationID).SetEventID(eventID).SetWorkflowID("release-automation-" + runID).SetStatus(status).SetReason(reason)
		if status == "skipped" {
			create.SetCompletedAt(time.Now())
		}
		if _, err := create.Save(ctx); err != nil {
			return nil, err
		}
		if status == "queued" {
			if err := automationOutbox(ctx, tx, source.OrganizationID, runID, EventReleaseAutomationDispatch, 0); err != nil {
				return nil, err
			}
		}
		actor := Actor{OrganizationID: source.OrganizationID, Kind: "webhook", Display: source.ID, RequestID: delivery}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.release_event_accepted", "release_source_event", eventID, map[string]any{"runId": runID, "mode": mode, "disposition": status}); err != nil {
			return nil, err
		}
		result.Handled++
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func automationOutbox(ctx context.Context, tx *ent.Tx, org, runID, kind string, attempt int) error {
	return tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(org).SetType(kind).SetAggregateType("release_automation_run").SetAggregateID(runID).SetPayload(map[string]any{"runId": runID, "recoveryAttempt": attempt}).SetIdempotencyKey(fmt.Sprintf("%s:%s:%d", kind, runID, attempt)).Exec(ctx)
}

func eventString(event automation.Event, field string) string {
	value := event.Fields[field]
	if value.State != "available" || len(value.Values) != 1 {
		return ""
	}
	return value.Values[0]
}

func automationSourceFilter(source *ent.SourceApp, event automation.Event) string {
	switch event.Family {
	case automation.Published:
		value := event.Fields["release.prerelease"]
		if source.SkipPrereleases && (value.Boolean == nil || *value.Boolean) {
			return "Source excludes prereleases or the prerelease status is missing."
		}
	case automation.Merged:
		branch := event.DefaultBranch
		if source.Branch != nil {
			branch = *source.Branch
		}
		if branch == "" || eventString(event, "pr.base") != branch {
			return "This pull request does not target the watched branch."
		}
		if ignoresAuthor(source, eventString(event, "pr.author")) {
			return "This repository excludes pull requests from this author."
		}
		bot := event.Fields["pr.bot"]
		if source.IgnoreBotPullRequests && (bot.Boolean == nil || *bot.Boolean) {
			return "Source excludes bot pull requests or the author type is missing."
		}
	case automation.Deployed:
		if !source.ReleaseAutomation && !productionDeployment(event) {
			return "Only successful production deployments are captured."
		}
	case automation.TagPushed:
		if source.SkipPrereleases && eventString(event, "version.level") == "prerelease" {
			return "Source excludes prereleases; this tag is a prerelease version."
		}
	}
	return ""
}

func productionDeployment(event automation.Event) bool {
	if event.Production != nil {
		return true
	}
	value := event.Fields["deployment.production"]
	return value.Boolean != nil && *value.Boolean || strings.EqualFold(eventString(event, "deployment.environment"), "production")
}
