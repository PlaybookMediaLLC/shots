package product

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationnode"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

type AutomationDispatcher interface {
	Start(context.Context, string, string, int) (string, error)
	Cancel(context.Context, string, int) error
}

func (c *Configuration) WithAutomationDispatcher(dispatcher AutomationDispatcher) *Configuration {
	c.automation = dispatcher
	return c
}

var ErrAutomationStopped = errors.New("release automation authorization withdrawn")

type AutomationRun struct {
	ID              string             `json:"id"`
	EventID         string             `json:"eventId"`
	DefinitionID    *string            `json:"definitionId"`
	VersionID       *string            `json:"versionId"`
	VersionRevision *int               `json:"versionRevision"`
	WorkflowID      string             `json:"workflowId"`
	TemporalRunID   string             `json:"temporalRunId"`
	Status          string             `json:"status"`
	CancelRequested bool               `json:"cancelRequested"`
	RecoveryAttempt int                `json:"recoveryAttempt"`
	FailureCode     string             `json:"failureCode"`
	Reason          string             `json:"reason"`
	Outputs         automation.Outputs `json:"outputs"`
	CreatedAt       time.Time          `json:"createdAt"`
	CompletedAt     *time.Time         `json:"completedAt"`
}

type AutomationEvent struct {
	ID          string                      `json:"id"`
	SourceAppID string                      `json:"sourceAppId"`
	DeliveryID  string                      `json:"deliveryId"`
	Snapshot    automation.Event            `json:"snapshot"`
	VersionIDs  []string                    `json:"versionIds"`
	Mode        string                      `json:"mode"`
	Disposition string                      `json:"disposition"`
	Reason      string                      `json:"reason"`
	ReceivedAt  time.Time                   `json:"receivedAt"`
	EnrichedAt  *time.Time                  `json:"enrichedAt"`
	Enrichment  map[string]automation.Value `json:"enrichment"`
}

type AutomationNodeExecution struct {
	NodeID      string              `json:"nodeId"`
	ActionKey   string              `json:"actionKey"`
	Status      string              `json:"status"`
	Attempts    int                 `json:"attempts"`
	FailureCode string              `json:"failureCode"`
	Decision    automation.Decision `json:"decision"`
	Outputs     automation.Outputs  `json:"outputs"`
	StartedAt   time.Time           `json:"startedAt"`
	CompletedAt *time.Time          `json:"completedAt"`
}

type AutomationHistoryItem struct {
	Event AutomationEvent `json:"event"`
	Run   AutomationRun   `json:"run"`
}
type AutomationRunDetail struct {
	AutomationHistoryItem
	Nodes []AutomationNodeExecution `json:"nodes"`
}

func automationRun(row *ent.ReleaseAutomationRun) AutomationRun {
	return AutomationRun{ID: row.ID, EventID: row.EventID, DefinitionID: row.DefinitionID, VersionID: row.VersionID, WorkflowID: row.WorkflowID, TemporalRunID: row.TemporalRunID, Status: row.Status, CancelRequested: row.CancelRequested, RecoveryAttempt: row.RecoveryAttempt, FailureCode: row.FailureCode, Reason: row.Reason, Outputs: row.Outputs, CreatedAt: row.CreatedAt, CompletedAt: row.CompletedAt}
}
func automationEvent(row *ent.ReleaseSourceEvent) AutomationEvent {
	snapshot := row.Snapshot
	snapshot.URL = automation.SafeEvidenceURL(snapshot.URL)
	return AutomationEvent{ID: row.ID, SourceAppID: row.SourceAppID, DeliveryID: row.DeliveryID, Snapshot: snapshot, VersionIDs: row.VersionIds, Mode: row.Mode, Disposition: row.Disposition, Reason: row.Reason, ReceivedAt: row.ReceivedAt, EnrichedAt: row.EnrichedAt, Enrichment: row.Enrichment}
}

// AutomationHistoryFilter narrows persisted run history. Every field is
// optional; tenant scope always comes from the actor, never the filter.
type AutomationHistoryFilter struct {
	Mode         string            `json:"mode"`
	Limit        int               `json:"limit"`
	Before       string            `json:"before"`
	DefinitionID string            `json:"definitionId"`
	VersionID    string            `json:"versionId"`
	SourceAppID  string            `json:"sourceAppId"`
	Family       automation.Family `json:"family"`
	Status       string            `json:"status"`
	Since        *time.Time        `json:"since"`
	Until        *time.Time        `json:"until"`
}

var automationRunStatuses = []string{"queued", "running", "succeeded", "skipped", "failed", "needs_attention", "cancelled"}

func (c *Configuration) ListAutomationHistory(ctx context.Context, actor Actor, filter AutomationHistoryFilter) ([]AutomationHistoryItem, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if filter.Limit < 0 || filter.Limit > 50 || (filter.Mode != "" && filter.Mode != "automation" && filter.Mode != "legacy") || (filter.Since != nil && filter.Until != nil && !filter.Since.Before(*filter.Until)) || len(filter.Before) > 64 || len(filter.DefinitionID) > 64 || len(filter.VersionID) > 64 || len(filter.SourceAppID) > 64 ||
		(filter.Family != "" && !automation.ValidFamily(filter.Family)) || (filter.Status != "" && !slices.Contains(automationRunStatuses, filter.Status)) {
		return nil, ErrInvalidInput
	}
	org := actor.OrganizationID
	query := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(org))
	if filter.Before != "" {
		query.Where(releaseautomationrun.IDLT(filter.Before))
	}
	if filter.DefinitionID != "" {
		query.Where(releaseautomationrun.DefinitionID(filter.DefinitionID))
	}
	if filter.VersionID != "" {
		query.Where(releaseautomationrun.VersionID(filter.VersionID))
	}
	if filter.Status != "" {
		query.Where(releaseautomationrun.Status(filter.Status))
	}
	if filter.Since != nil {
		query.Where(releaseautomationrun.CreatedAtGTE(*filter.Since))
	}
	if filter.Until != nil {
		query.Where(releaseautomationrun.CreatedAtLT(*filter.Until))
	}
	if filter.SourceAppID != "" || filter.Family != "" || filter.Mode != "" {
		query.Where(func(s *sql.Selector) {
			events := sql.Table(releasesourceevent.Table)
			matching := sql.Select(events.C(releasesourceevent.FieldID)).From(events).Where(sql.EQ(events.C(releasesourceevent.FieldOrganizationID), org))
			if filter.Mode != "" {
				matching.Where(sql.EQ(events.C(releasesourceevent.FieldMode), filter.Mode))
			}
			if filter.SourceAppID != "" {
				matching.Where(sql.EQ(events.C(releasesourceevent.FieldSourceAppID), filter.SourceAppID))
			}
			if filter.Family != "" {
				matching.Where(sqljson.ValueEQ(events.C(releasesourceevent.FieldSnapshot), string(filter.Family), sqljson.Path("family")))
			}
			s.Where(sql.In(s.C(releaseautomationrun.FieldEventID), matching))
		})
	}
	limit := filter.Limit
	if limit == 0 {
		limit = 50
	}
	runs, err := query.Order(ent.Desc(releaseautomationrun.FieldID)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	eventIDs, versionIDs := []string{}, []string{}
	for _, run := range runs {
		eventIDs = append(eventIDs, run.EventID)
		if run.VersionID != nil {
			versionIDs = append(versionIDs, *run.VersionID)
		}
	}
	events, err := c.client.ReleaseSourceEvent.Query().Where(releasesourceevent.IDIn(eventIDs...), releasesourceevent.OrganizationID(org)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]*ent.ReleaseSourceEvent{}
	for _, event := range events {
		byID[event.ID] = event
	}
	revisions, err := c.automationRevisions(ctx, org, versionIDs)
	if err != nil {
		return nil, err
	}
	result := []AutomationHistoryItem{}
	for _, run := range runs {
		event, ok := byID[run.EventID]
		if !ok {
			return nil, publishing.ErrNotFound
		}
		item := AutomationHistoryItem{Event: automationEvent(event), Run: automationRun(run)}
		if run.VersionID != nil {
			if revision, ok := revisions[*run.VersionID]; ok {
				item.Run.VersionRevision = &revision
			}
		}
		result = append(result, item)
	}
	return result, nil
}

func (c *Configuration) automationRevisions(ctx context.Context, org string, ids []string) (map[string]int, error) {
	result := map[string]int{}
	if len(ids) == 0 {
		return result, nil
	}
	versions, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.IDIn(ids...), releaseautomationversion.OrganizationID(org)).Select(releaseautomationversion.FieldID, releaseautomationversion.FieldRevision).All(ctx)
	for _, version := range versions {
		result[version.ID] = version.Revision
	}
	return result, err
}

// automationRunCounts separates automation events from legacy intake by admission mode.
func (c *Configuration) automationRunCounts(ctx context.Context, org, mode string) (map[string]int, error) {
	var rows []struct {
		Status string `json:"status"`
		Count  int    `json:"count"`
	}
	err := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(org), func(s *sql.Selector) {
		events := sql.Table(releasesourceevent.Table)
		s.Where(sql.In(s.C(releaseautomationrun.FieldEventID), sql.Select(events.C(releasesourceevent.FieldID)).From(events).Where(sql.And(sql.EQ(events.C(releasesourceevent.FieldOrganizationID), org), sql.EQ(events.C(releasesourceevent.FieldMode), mode)))))
	}).GroupBy(releaseautomationrun.FieldStatus).Aggregate(ent.Count()).Scan(ctx, &rows)
	result := map[string]int{}
	for _, status := range automationRunStatuses {
		result[status] = 0
	}
	for _, row := range rows {
		result[row.Status] = row.Count
	}
	return result, err
}

// AutomationRunSummary is a definition's newest run, for dashboards.
type AutomationRunSummary struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
}

// attachLastRuns adds each definition's newest run and its 30-day run count.
// Run IDs are time-ordered cuids, so the greatest ID is the newest run.
func (c *Configuration) attachLastRuns(ctx context.Context, org string, definitions []AutomationDefinition) error {
	var rows []struct {
		DefinitionID string `json:"definitionId"`
		Last         string `json:"last"`
		Count        int    `json:"count"`
	}
	err := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(org), releaseautomationrun.DefinitionIDNotNil(), releaseautomationrun.CreatedAtGTE(time.Now().AddDate(0, 0, -30))).
		GroupBy(releaseautomationrun.FieldDefinitionID).Aggregate(ent.As(ent.Max(releaseautomationrun.FieldID), "last"), ent.Count()).Scan(ctx, &rows)
	if err != nil || len(rows) == 0 {
		return err
	}
	ids := []string{}
	for _, row := range rows {
		ids = append(ids, row.Last)
	}
	runs, err := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.IDIn(ids...), releaseautomationrun.OrganizationID(org)).All(ctx)
	if err != nil {
		return err
	}
	for i := range definitions {
		for _, row := range rows {
			if row.DefinitionID != definitions[i].ID {
				continue
			}
			definitions[i].RecentRuns = row.Count
			for _, run := range runs {
				if run.ID == row.Last {
					definitions[i].LastRun = &AutomationRunSummary{ID: run.ID, Status: run.Status, CreatedAt: run.CreatedAt}
				}
			}
		}
	}
	return nil
}

func (c *Configuration) GetAutomationRun(ctx context.Context, actor Actor, id string) (*AutomationRunDetail, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	run, event, err := c.automationRunEvent(ctx, actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	revisions := map[string]int{}
	if run.VersionID != nil {
		if revisions, err = c.automationRevisions(ctx, actor.OrganizationID, []string{*run.VersionID}); err != nil {
			return nil, err
		}
	}
	nodes, err := c.client.ReleaseAutomationNode.Query().Where(releaseautomationnode.OrganizationID(actor.OrganizationID), releaseautomationnode.RunID(id)).Order(ent.Asc(releaseautomationnode.FieldStartedAt), ent.Asc(releaseautomationnode.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &AutomationRunDetail{AutomationHistoryItem: AutomationHistoryItem{Event: automationEvent(event), Run: automationRun(run)}, Nodes: []AutomationNodeExecution{}}
	if run.VersionID != nil {
		if revision, ok := revisions[*run.VersionID]; ok {
			result.Run.VersionRevision = &revision
		}
	}
	for _, node := range nodes {
		result.Nodes = append(result.Nodes, AutomationNodeExecution{NodeID: node.NodeID, ActionKey: node.ActionKey, Status: node.Status, Attempts: node.Attempts, FailureCode: node.FailureCode, Decision: node.Decision, Outputs: node.Outputs, StartedAt: node.StartedAt, CompletedAt: node.CompletedAt})
	}
	return result, nil
}

func (c *Configuration) automationRunEvent(ctx context.Context, org, id string) (*ent.ReleaseAutomationRun, *ent.ReleaseSourceEvent, error) {
	run, err := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, nil, err
	}
	event, err := c.client.ReleaseSourceEvent.Query().Where(releasesourceevent.ID(run.EventID), releasesourceevent.OrganizationID(org)).Only(ctx)
	return run, event, err
}

// A delayed activity from an earlier recovery must not resume a newer attempt.
func (c *Configuration) automationAttempt(ctx context.Context, org, id string, attempt int) (*ent.ReleaseAutomationRun, *ent.ReleaseSourceEvent, error) {
	run, event, err := c.automationRunEvent(ctx, org, id)
	if err != nil {
		return nil, nil, err
	}
	if run.RecoveryAttempt != attempt || !slices.Contains([]string{"queued", "running"}, run.Status) {
		return nil, nil, ErrAutomationStopped
	}
	return run, event, nil
}

func (c *Configuration) DisableReleaseAutomation(ctx context.Context, actor Actor, id string, revision int) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	definition, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := lockAutomationSource(ctx, tx, actor.OrganizationID, definition.SourceAppID); err != nil {
		return err
	}
	n, err := tx.ReleaseAutomation.Update().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.Revision(revision)).SetEnabled(false).AddRevision(1).SetModifiedBy(actor.UserID).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return publishing.ErrConflict
	}
	versions, err := tx.ReleaseAutomationVersion.Query().Where(releaseautomationversion.OrganizationID(actor.OrganizationID), releaseautomationversion.DefinitionID(id)).IDs(ctx)
	if err != nil {
		return err
	}
	if len(versions) > 0 {
		if err := cancelAutomationRuns(ctx, tx, actor.OrganizationID, definition.SourceAppID, versions); err != nil {
			return err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_disabled", "release_automation", id); err != nil {
		return err
	}
	return tx.Commit()
}

// ArchiveReleaseAutomation hides a definition and cancels pending work while retaining history.
// Restoring leaves the definition inactive; activation is always explicit.
func (c *Configuration) ArchiveReleaseAutomation(ctx context.Context, actor Actor, id string, revision int, archived bool) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	definition, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := lockAutomationSource(ctx, tx, actor.OrganizationID, definition.SourceAppID); err != nil {
		return err
	}
	n, err := tx.ReleaseAutomation.Update().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.Revision(revision)).SetArchived(archived).SetEnabled(false).AddRevision(1).SetModifiedBy(actor.UserID).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return publishing.ErrConflict
	}
	if archived {
		versions, err := tx.ReleaseAutomationVersion.Query().Where(releaseautomationversion.OrganizationID(actor.OrganizationID), releaseautomationversion.DefinitionID(id)).IDs(ctx)
		if err != nil {
			return err
		}
		if len(versions) > 0 {
			if err := cancelAutomationRuns(ctx, tx, actor.OrganizationID, definition.SourceAppID, versions); err != nil {
				return err
			}
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_archived", "release_automation", id, map[string]any{"archived": archived}); err != nil {
		return err
	}
	return tx.Commit()
}

// SetReleaseAutomationMode is the only way to leave sticky automation mode.
// Returning to legacy intake is explicit and cancels previously admitted work.
// A branch changes which pull-request base the source watches for new events;
// an empty branch watches the repository's default branch.
func (c *Configuration) SetReleaseAutomationMode(ctx context.Context, actor Actor, sourceID string, enabled bool, collectUnmatched *bool, branch *string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	if branch != nil && (len(*branch) > 255 || strings.ContainsAny(*branch, " ~^:?*[\\\x00") || strings.HasPrefix(*branch, "-") || strings.Contains(*branch, "..")) {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, sourceID)
	if err != nil {
		return err
	}
	if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
		return err
	}
	update := tx.SourceApp.UpdateOneID(sourceID).SetReleaseAutomation(enabled)
	if collectUnmatched != nil {
		update.SetAutomationCollectUnmatched(*collectUnmatched)
	}
	if branch != nil && *branch == "" {
		update.ClearBranch()
	} else if branch != nil {
		update.SetBranch(*branch)
	}
	if err := update.Exec(ctx); err != nil {
		return err
	}
	if source.ReleaseAutomation != enabled {
		if err := cancelAutomationRuns(ctx, tx, actor.OrganizationID, sourceID, nil); err != nil {
			return err
		}
	}
	metadata := map[string]any{"enabled": enabled}
	if branch != nil {
		metadata["branch"] = *branch
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_mode_changed", "source_app", sourceID, metadata); err != nil {
		return err
	}
	return tx.Commit()
}

func cancelAutomationRuns(ctx context.Context, tx *ent.Tx, org, sourceID string, versions []string) error {
	runs, err := tx.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(org), releaseautomationrun.CancelRequested(false), releaseautomationrun.StatusIn("queued", "running", "failed", "needs_attention")).All(ctx)
	if err != nil {
		return err
	}
	for _, run := range runs {
		event, err := tx.ReleaseSourceEvent.Query().Where(releasesourceevent.ID(run.EventID), releasesourceevent.OrganizationID(org), releasesourceevent.SourceAppID(sourceID)).Only(ctx)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		matches := versions == nil
		if run.VersionID != nil {
			matches = matches || slices.Contains(versions, *run.VersionID)
		} else {
			for _, id := range event.VersionIds {
				matches = matches || slices.Contains(versions, id)
			}
		}
		if matches {
			if err := requestAutomationCancel(ctx, tx, run); err != nil {
				return err
			}
		}
	}
	return nil
}

// StopWatchingAutomationSource revokes only this workspace's source selection.
func (c *Configuration) StopWatchingAutomationSource(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, id)
	if err != nil {
		return err
	}
	if source.Provider != "github" || source.GithubInstallationID == nil {
		return ErrInvalidInput
	}
	if err := tx.SourceApp.UpdateOneID(id).SetStatus(sourceapp.StatusARCHIVED).Exec(ctx); err != nil {
		return err
	}
	if err := cancelAutomationRuns(ctx, tx, actor.OrganizationID, id, nil); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.source_app_unwatched", "source_app", id); err != nil {
		return err
	}
	return tx.Commit()
}

func requestAutomationCancel(ctx context.Context, tx *ent.Tx, run *ent.ReleaseAutomationRun) error {
	if run.CancelRequested {
		return nil
	}
	if err := tx.ReleaseAutomationRun.UpdateOneID(run.ID).SetCancelRequested(true).SetReason("Cancellation requested; completed outputs are kept and an action may already be in flight.").Exec(ctx); err != nil {
		return err
	}
	return automationOutbox(ctx, tx, run.OrganizationID, run.ID, EventReleaseAutomationCancel, run.RecoveryAttempt)
}

func (c *Configuration) CancelReleaseAutomationRun(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := tx.ReleaseAutomationRun.Query().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	if !slices.Contains([]string{"queued", "running", "failed", "needs_attention"}, run.Status) {
		return publishing.ErrConflict
	}
	if err := requestAutomationCancel(ctx, tx, run); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_cancel_requested", "release_automation_run", id); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) RetryReleaseAutomationRun(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	run, event, err := c.automationRunEvent(ctx, actor.OrganizationID, id)
	if err != nil {
		return err
	}
	retryable := (run.Status == "failed" && run.FailureCode == "activity_failed") || run.Status == "needs_attention"
	if !retryable || run.CancelRequested {
		return publishing.ErrConflict
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	n, err := tx.ReleaseAutomationRun.Update().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(actor.OrganizationID), releaseautomationrun.StatusIn("failed", "needs_attention"), releaseautomationrun.CancelRequested(false), releaseautomationrun.RecoveryAttempt(run.RecoveryAttempt)).SetStatus("queued").ClearCompletedAt().SetFailureCode("").AddRecoveryAttempt(1).Save(ctx)
	if err != nil {
		return err
	}
	if n != 1 {
		return publishing.ErrConflict
	}
	if err := automationOutbox(ctx, tx, actor.OrganizationID, id, EventReleaseAutomationDispatch, run.RecoveryAttempt+1); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_retry_requested", "release_automation_run", id); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) automationCheckpoint(ctx context.Context, run *ent.ReleaseAutomationRun, event *ent.ReleaseSourceEvent) (*ent.SourceApp, error) {
	if run.CancelRequested {
		return nil, ErrAutomationStopped
	}
	if err := c.auth.AuthorizeWorkspace(ctx, run.OrganizationID); err != nil {
		if errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrUnauthorized) || errors.Is(err, publishing.ErrNotFound) {
			return nil, ErrAutomationStopped
		}
		return nil, err
	}
	source, err := c.client.SourceApp.Query().Where(sourceapp.ID(event.SourceAppID), sourceapp.OrganizationID(run.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if source.ReleaseAutomation != (event.Mode == "automation") {
		return nil, ErrAutomationStopped
	}
	if err := automationSourceAccess(ctx, c.client, source); err != nil {
		if errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrInvalidState) {
			return nil, ErrAutomationStopped
		}
		return nil, err
	}
	if run.DefinitionID != nil {
		allowed, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(*run.DefinitionID), releaseautomation.OrganizationID(run.OrganizationID), releaseautomation.Enabled(true)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, ErrAutomationStopped
		}
	}
	return source, nil
}

func (c *Configuration) dispatchReleaseAutomation(ctx context.Context, org, id string, cancel bool) error {
	run, event, err := c.automationRunEvent(ctx, org, id)
	if err != nil {
		return err
	}
	if c.automation == nil {
		return ErrStorageUnavailable
	}
	if cancel {
		if err := c.automation.Cancel(ctx, run.WorkflowID, run.RecoveryAttempt); err != nil {
			return err
		}
		// A not-yet-started workflow has no activity that could finish this row.
		if run.Status != "running" {
			return c.FinishReleaseAutomation(ctx, org, id, "cancelled", "cancelled", "Cancelled before further work; completed outputs are retained.", run.RecoveryAttempt)
		}
		return nil
	}
	if run.Status != "queued" && run.Status != "running" {
		return nil
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		if errors.Is(err, ErrAutomationStopped) {
			return c.FinishReleaseAutomation(ctx, org, id, "cancelled", "access_revoked", "Automation is disabled or access was revoked.", run.RecoveryAttempt)
		}
		return err
	}
	temporalID, err := c.automation.Start(ctx, org, id, run.RecoveryAttempt)
	if err != nil {
		slog.WarnContext(ctx, "release_automation_dispatch", "organization_id", org, "run_id", id, "status", "start_failed", "recovery_attempt", run.RecoveryAttempt)
		return err
	}
	slog.InfoContext(ctx, "release_automation_dispatch", "organization_id", org, "run_id", id, "temporal_run_id", temporalID, "dispatch_lag_ms", time.Since(event.ReceivedAt).Milliseconds(), "recovery_attempt", run.RecoveryAttempt)
	return c.client.ReleaseAutomationRun.UpdateOneID(id).SetTemporalRunID(temporalID).Exec(ctx)
}

func (c *Configuration) FinishReleaseAutomation(ctx context.Context, org, id, status, code, reason string, attempt int) error {
	if !slices.Contains([]string{"succeeded", "skipped", "failed", "cancelled", "needs_attention"}, status) || len(code) > 80 || len(reason) > 1000 {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := tx.ReleaseAutomationRun.Query().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(org)).Only(ctx)
	if err != nil {
		return err
	}
	// Serialize finish/retry so a late finish cannot overwrite a recovery.
	from := []string{"queued", "running"}
	if status == "cancelled" {
		from = append(from, "failed", "needs_attention")
	}
	n, err := tx.ReleaseAutomationRun.Update().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(org), releaseautomationrun.RecoveryAttempt(attempt), releaseautomationrun.StatusIn(from...)).SetStatus(status).Save(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		return nil
	}
	if run.CancelRequested && status != "succeeded" {
		status = "cancelled"
	}
	if run.VersionID != nil && strings.HasPrefix(run.Reason, "First matching definition") {
		reason = run.Reason + " " + reason
	}
	// Preserve a more specific node failure code (e.g. needs_auth,
	// destination_set_required, insufficient_credits) over the generic wrapper.
	if status == "needs_attention" && code == "configuration_invalid" {
		if failedNode, err := tx.ReleaseAutomationNode.Query().Where(releaseautomationnode.OrganizationID(org), releaseautomationnode.RunID(id), releaseautomationnode.StatusEQ("failed"), releaseautomationnode.FailureCodeNEQ("")).
			Order(ent.Desc(releaseautomationnode.FieldStartedAt), ent.Desc(releaseautomationnode.FieldID)).First(ctx); err == nil && failedNode.FailureCode != "" {
			code = failedNode.FailureCode
		}
	}
	if err := tx.ReleaseAutomationRun.UpdateOneID(id).SetStatus(status).SetFailureCode(code).SetReason(reason).SetCompletedAt(time.Now()).Exec(ctx); err != nil {
		return err
	}
	if err := tx.ReleaseSourceEvent.UpdateOneID(run.EventID).SetDisposition(status).SetReason(reason).Exec(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, Actor{OrganizationID: org, Kind: "service", Display: "release-automation", RequestID: id}, "product.release_automation_finished", "release_automation_run", id, map[string]any{"status": status, "failureCode": code}); err != nil {
		return err
	}
	// Selected runs notify the workspace; unmatched events and skips stay quiet.
	if kind := map[string]string{"succeeded": "workflow.completed", "failed": "workflow.needs_attention", "needs_attention": "workflow.needs_attention"}[status]; kind != "" && run.DefinitionID != nil {
		payload := map[string]any{"background": true, "status": status, "failureCode": code, "definitionId": *run.DefinitionID}
		if err := activity.Emit(ctx, tx, org, kind, "release_automation_run", id, "", fmt.Sprintf("%s:%d:%s", id, attempt, status), payload); err != nil {
			return err
		}
	}
	return tx.Commit()
}
