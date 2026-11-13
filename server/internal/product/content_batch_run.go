package product

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatch"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatchitem"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatchrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// A run is one pass over a batch. A submit run freezes each item's schedule and
// a Temporal workflow applies them through ScheduleContentDraft, so approval,
// quota and idempotency stay in one place and closing the tab stops nothing. A
// render run freezes concepts while a browser renders them. Neither replaces a
// post or an asset as the record of what exists.

const (
	batchRunSubmit = "submit"
	batchRunRender = "render"

	batchRunRunning    = "RUNNING"
	batchRunFinished   = "FINISHED"
	batchRunSuperseded = "SUPERSEDED"

	batchItemPending     = "PENDING"
	batchItemDone        = "DONE"
	batchItemFailed      = "FAILED"
	batchItemUnconfirmed = "UNCONFIRMED"
)

// ErrBatchRunNotStarted is a run that is saved but whose workflow did not start.
var ErrBatchRunNotStarted = errors.New("The schedule is saved, but it could not start. Try again: nothing is scheduled twice.")

// BatchRunStarter starts a submit run's workflow; starting twice is harmless.
type BatchRunStarter interface {
	StartBatchRun(ctx context.Context, organizationID, runID string) error
}

// WithBatchRuns sets what starts submit runs.
func (c *Configuration) WithBatchRuns(starter BatchRunStarter) *Configuration {
	c.batchRuns = starter
	return c
}

// BatchRunRecord is a run and what happened to each of its items.
type BatchRunRecord struct {
	CreatedAt string                `json:"createdAt"`
	ID        string                `json:"id"`
	Items     []schema.BatchRunItem `json:"items"`
	Kind      string                `json:"kind"`
	Status    string                `json:"status"`
	UpdatedAt string                `json:"updatedAt"`
}

func batchRunRecord(run *ent.ContentBatchRun) *BatchRunRecord {
	items := make([]schema.BatchRunItem, len(run.Items))
	for i, item := range run.Items {
		item.Schedule = nil // What was frozen is for the worker; the draft shows it to people.
		items[i] = item
	}
	return &BatchRunRecord{CreatedAt: run.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"), ID: run.ID, Items: items, Kind: run.Kind,
		Status: run.Status, UpdatedAt: run.UpdatedAt.UTC().Format("2006-01-02T15:04:05.000Z")}
}

func (c *Configuration) latestBatchRun(ctx context.Context, batchID, kind string) (*BatchRunRecord, error) {
	run, err := c.client.ContentBatchRun.Query().Where(contentbatchrun.BatchID(batchID), contentbatchrun.Kind(kind)).
		Order(ent.Desc(contentbatchrun.FieldCreatedAt), ent.Desc(contentbatchrun.FieldID)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return batchRunRecord(run), nil
}

func checkRunKey(key string) error {
	if len(key) < 16 || len(key) > 128 || strings.TrimSpace(key) != key {
		return invalid("A run needs a request key of 16 to 128 characters.")
	}
	return nil
}

func runFingerprint(value any) string {
	encoded, _ := json.Marshal(value)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

// runForKey is the run a request key already made, or nil; the same key asking
// for something else is refused.
func runForKey(ctx context.Context, client *ent.Client, batchID, key, fingerprint string) (*ent.ContentBatchRun, error) {
	run, err := client.ContentBatchRun.Query().Where(contentbatchrun.BatchID(batchID), contentbatchrun.RequestKey(key)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if run.Fingerprint != fingerprint {
		return nil, conflict("That request key was already used for something else. Reload the batch.")
	}
	return run, nil
}

// BatchSubmitItem is what was asked of one item, with its frozen schedule or why
// the web could not build it.
type BatchSubmitItem struct {
	ChannelConnectionIDs []string                   `json:"channelConnectionIds"`
	ItemID               string                     `json:"itemId"`
	Refusal              string                     `json:"refusal"`
	Schedule             *ScheduleContentDraftInput `json:"schedule"`
}

// BatchSubmitInput is a schedule of many items. RequestKey makes a retry replay.
type BatchSubmitInput struct {
	Items      []BatchSubmitItem `json:"items"`
	RequestKey string            `json:"requestKey"`
}

// SubmitContentBatch records what to schedule and starts its workflow. Only a
// person with a real session may ask. The run then keeps going after they sign out
// or switch workspace, as a post they queued would, until they lose their account,
// role or membership: those refuse the rest of the run.
func (c *Configuration) SubmitContentBatch(ctx context.Context, actor Actor, batchID string, input BatchSubmitInput) (*BatchRunRecord, error) {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	if err := checkRunKey(input.RequestKey); err != nil {
		return nil, err
	}
	if len(input.Items) == 0 || len(input.Items) > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Schedule 1 to %d items.", contentBatchItemLimit))
	}
	row, _, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return nil, err
	}
	if row.ArchivedAt != nil {
		return nil, conflict("This batch is closed. Start a new batch.")
	}
	// What was asked, not the schedule built for it: scheduling moves the draft's
	// version, so a retry after the run went through builds a different request.
	asked := make([][2]any, len(input.Items))
	for i, item := range input.Items {
		asked[i] = [2]any{item.ItemID, item.ChannelConnectionIDs}
	}
	fingerprint := runFingerprint(asked)
	run, err := runForKey(ctx, c.client, row.ID, input.RequestKey, fingerprint)
	if err != nil {
		return nil, err
	}
	if run == nil {
		if run, err = c.createSubmitRun(ctx, actor, row, input, fingerprint); err != nil {
			return nil, err
		}
	}
	if run.Status == batchRunRunning {
		if c.batchRuns == nil || c.batchRuns.StartBatchRun(ctx, actor.OrganizationID, run.ID) != nil {
			return nil, ErrBatchRunNotStarted
		}
	}
	return batchRunRecord(run), nil
}

func (c *Configuration) createSubmitRun(ctx context.Context, actor Actor, row *ent.ContentBatch, input BatchSubmitInput, fingerprint string) (*ent.ContentBatchRun, error) {
	stored, err := c.client.ContentBatchItem.Query().Where(contentbatchitem.BatchID(row.ID), contentbatchitem.OrganizationID(actor.OrganizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[string]*ent.ContentBatchItem{}
	for _, item := range stored {
		byID[item.ID] = item
	}
	items := make([]schema.BatchRunItem, 0, len(input.Items))
	seen := map[string]bool{}
	pending := false
	for _, entry := range input.Items {
		item := byID[entry.ItemID]
		if item == nil {
			return nil, notFound("Item not found.")
		}
		if seen[item.ID] {
			return nil, invalid("Schedule each item once.")
		}
		seen[item.ID] = true
		next := schema.BatchRunItem{ItemID: item.ID, Status: batchItemFailed}
		switch {
		case entry.Refusal != "":
			next.Error = entry.Refusal
		case entry.Schedule == nil:
			return nil, invalid("Each item needs its schedule, or why it cannot go.")
		case item.DraftID == nil:
			next.Error = "Save this item as a draft first."
		default:
			schedule, err := json.Marshal(entry.Schedule)
			if err != nil {
				return nil, err
			}
			next.DraftID, next.Schedule, next.Status = *item.DraftID, schedule, batchItemPending
			pending = true
		}
		items = append(items, next)
	}
	status := batchRunFinished
	if pending {
		status = batchRunRunning
	}
	create := c.client.ContentBatchRun.Create().SetID(cuid.New()).SetBatchID(row.ID).SetOrganizationID(actor.OrganizationID).
		SetKind(batchRunSubmit).SetRequestKey(input.RequestKey).SetFingerprint(fingerprint).SetStatus(status).SetItems(items).
		SetNillableCreatedByUserID(projectActor(actor))
	run, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		// Two submits with one key: the loser returns the winner's run.
		if existing, err := runForKey(ctx, c.client, row.ID, input.RequestKey, fingerprint); err != nil || existing != nil {
			return existing, err
		}
	}
	return run, err
}

// BatchRunStep is what one workflow step did: whether the run is done, and the
// post workflows to start or stop.
type BatchRunStep struct {
	Cancelled []string
	Done      bool
	Scheduled []*ent.ScheduledPost
}

// batchRunRefusal tells a definite answer, which is the item's outcome, from a
// failure to get one, which Temporal retries: scheduling replays, so that is safe.
func batchRunRefusal(err error) bool {
	var (
		user      userError
		stale     *ContentDraftVersionConflictError
		taken     *QueueSlotTakenError
		clocks    *LocalTimeError
		entitled  *FeatureNotEntitledError
		exceeded  *QuotaExceededError
		terms     *ProhibitedTermsError
		planLimit *PlanLimitError
	)
	if errors.As(err, &user) || errors.As(err, &stale) || errors.As(err, &taken) || errors.As(err, &clocks) ||
		errors.As(err, &entitled) || errors.As(err, &exceeded) || errors.As(err, &terms) || errors.As(err, &planLimit) {
		return true
	}
	for _, kind := range []error{publishing.ErrUnauthorized, publishing.ErrForbidden, publishing.ErrNotFound, publishing.ErrConflict,
		publishing.ErrInvalidState, publishing.ErrNotEligible, ErrInvalidInput, ErrQuotaExceeded, ErrStorageQuota, ErrObjectMissing} {
		if errors.Is(err, kind) {
			return true
		}
	}
	return false
}

func batchRunRefusalText(err error) string {
	var user userError
	switch {
	case errors.As(err, &user):
		return err.Error()
	case errors.Is(err, publishing.ErrUnauthorized), errors.Is(err, publishing.ErrForbidden):
		return "You can no longer schedule in this workspace: your account, role or membership changed, or it is being deleted."
	}
	return err.Error()
}

// settleBatchRunItem writes one item's outcome under the run's lock and closes
// the run when nothing is left waiting.
func (c *Configuration) settleBatchRunItem(ctx context.Context, runID string, settle func(run *ent.ContentBatchRun, items []schema.BatchRunItem) error) (*ent.ContentBatchRun, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_batch_run WHERE id=$1 FOR UPDATE`, runID); err != nil {
		return nil, err
	}
	run, err := tx.ContentBatchRun.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	items := run.Items
	if err := settle(run, items); err != nil {
		return nil, err
	}
	status := run.Status
	if status == batchRunRunning && firstPendingItem(items) < 0 {
		status = batchRunFinished
	}
	saved, err := tx.ContentBatchRun.UpdateOneID(runID).SetItems(items).SetStatus(status).Save(ctx)
	if err != nil {
		return nil, err
	}
	return saved, tx.Commit()
}

func firstPendingItem(items []schema.BatchRunItem) int {
	for i, item := range items {
		if item.Status == batchItemPending {
			return i
		}
	}
	return -1
}

// ScheduleNextBatchRunItem schedules a submit run's next waiting item, as the
// person who asked. Their account, role and membership are read again for each
// item; their session is not, because they already asked. A definite refusal is
// that item's outcome and the run goes on.
func (c *Configuration) ScheduleNextBatchRunItem(ctx context.Context, organizationID, runID string) (*BatchRunStep, error) {
	run, err := c.client.ContentBatchRun.Query().Where(contentbatchrun.ID(runID), contentbatchrun.OrganizationID(organizationID),
		contentbatchrun.Kind(batchRunSubmit)).Only(ctx)
	if err != nil {
		return nil, err
	}
	at := firstPendingItem(run.Items)
	if run.Status != batchRunRunning || at < 0 {
		if _, err := c.settleBatchRunItem(ctx, runID, func(*ent.ContentBatchRun, []schema.BatchRunItem) error { return nil }); err != nil {
			return nil, err
		}
		return &BatchRunStep{Done: true}, nil
	}
	item := run.Items[at]
	var input ScheduleContentDraftInput
	if err := json.Unmarshal(item.Schedule, &input); err != nil {
		return nil, err
	}
	// A run has no one to answer a repeat warning: its rows were reviewed when submitted.
	input.ConfirmDuplicate = true
	actor := Actor{OrganizationID: organizationID, RequestID: runID}
	if run.CreatedByUserID != nil {
		actor.UserID = *run.CreatedByUserID
	}
	result, err := c.ScheduleContentDraft(publishing.ForStartedRun(ctx), actor, item.DraftID, input)
	if err != nil && !batchRunRefusal(err) {
		return nil, err
	}
	step := &BatchRunStep{}
	saved, settleErr := c.settleBatchRunItem(ctx, runID, func(_ *ent.ContentBatchRun, items []schema.BatchRunItem) error {
		if err != nil {
			items[at].Status, items[at].Error = batchItemFailed, batchRunRefusalText(err)
			return nil
		}
		items[at].Status = batchItemDone
		for _, post := range result.Posts {
			items[at].PostIDs = append(items[at].PostIDs, post.ID)
		}
		return nil
	})
	if settleErr != nil {
		return nil, settleErr
	}
	if result != nil {
		step.Cancelled, step.Scheduled = result.Cancelled, result.Scheduled
	}
	step.Done = saved.Status != batchRunRunning
	return step, nil
}

// MarkBatchRunItemUnconfirmed settles the next item when retries found no answer,
// so one stuck item does not stop the rest. A later schedule of it replays.
func (c *Configuration) MarkBatchRunItemUnconfirmed(ctx context.Context, organizationID, runID string) error {
	found, err := c.client.ContentBatchRun.Query().Where(contentbatchrun.ID(runID), contentbatchrun.OrganizationID(organizationID)).Exist(ctx)
	if err != nil || !found {
		return err
	}
	_, err = c.settleBatchRunItem(ctx, runID, func(_ *ent.ContentBatchRun, items []schema.BatchRunItem) error {
		if at := firstPendingItem(items); at >= 0 {
			items[at].Status = batchItemUnconfirmed
			items[at].Error = "No confirmation came back. Check again before retrying: a retry cannot schedule it twice."
		}
		return nil
	})
	return err
}

// BatchRenderInput names the concepts to freeze. RequestKey makes a retry replay.
type BatchRenderInput struct {
	ItemIDs    []string `json:"itemIds"`
	RequestKey string   `json:"requestKey"`
}

// CreateContentBatchRender freezes concepts for a browser to render, and retires
// any earlier render of the batch, so a tab left open cannot attach an old video.
func (c *Configuration) CreateContentBatchRender(ctx context.Context, actor Actor, batchID string, input BatchRenderInput) (*BatchRunRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if err := checkRunKey(input.RequestKey); err != nil {
		return nil, err
	}
	if len(input.ItemIDs) == 0 || len(input.ItemIDs) > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Render 1 to %d videos.", contentBatchItemLimit))
	}
	row, _, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return nil, err
	}
	if row.ArchivedAt != nil {
		return nil, conflict("This batch is closed. Start a new batch.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Render starts take turns on the batch, so one is current when this commits.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_batch WHERE id=$1 FOR UPDATE`, row.ID); err != nil {
		return nil, err
	}
	fingerprint := runFingerprint(input)
	if run, err := runForKey(ctx, tx.Client(), row.ID, input.RequestKey, fingerprint); err != nil {
		return nil, err
	} else if run != nil {
		return batchRunRecord(run), tx.Commit()
	}
	items := make([]schema.BatchRunItem, 0, len(input.ItemIDs))
	seen := map[string]bool{}
	for _, id := range input.ItemIDs {
		if seen[id] {
			return nil, invalid("Render each video once.")
		}
		seen[id] = true
		item, err := lockedBatchItem(ctx, tx, actor, row.ID, id)
		if err != nil {
			return nil, err
		}
		switch {
		case item.Grid == nil:
			return nil, invalid("Only template videos render.")
		case item.DraftID != nil:
			return nil, conflict("This video is a draft now. Edit it in Write.")
		}
		for _, slot := range item.Grid.Slots {
			if slot.AssetID == "" {
				return nil, invalid("Add every image or clip of a video before it renders.")
			}
		}
		items = append(items, schema.BatchRunItem{Grid: item.Grid, ItemID: item.ID, Status: batchItemPending})
	}
	if err := tx.ContentBatchRun.Update().Where(contentbatchrun.BatchID(row.ID), contentbatchrun.Kind(batchRunRender),
		contentbatchrun.Status(batchRunRunning)).SetStatus(batchRunSuperseded).Exec(ctx); err != nil {
		return nil, err
	}
	run, err := tx.ContentBatchRun.Create().SetID(cuid.New()).SetBatchID(row.ID).SetOrganizationID(actor.OrganizationID).
		SetKind(batchRunRender).SetRequestKey(input.RequestKey).SetFingerprint(fingerprint).SetStatus(batchRunRunning).SetItems(items).
		SetNillableCreatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return batchRunRecord(run), nil
}

// BatchRenderReport is what a browser made of one concept: its video, or why not.
type BatchRenderReport struct {
	AssetID  string `json:"assetId"`
	Error    string `json:"error"`
	FileName string `json:"fileName"`
}

// ReportContentBatchRender records one video and attaches it to its item, in one
// transaction, only if the concept is still what was frozen. A retry replays.
func (c *Configuration) ReportContentBatchRender(ctx context.Context, actor Actor, batchID, runID, itemID string, report BatchRenderReport) (*BatchRunRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if (report.AssetID == "") == (report.Error == "") {
		return nil, invalid("Report a video or why it could not be made.")
	}
	if len(report.Error) > 500 {
		report.Error = report.Error[:500]
	}
	row, _, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return nil, err
	}
	run, err := c.batchRun(ctx, actor, row.ID, runID)
	if err != nil {
		return nil, err
	}
	if run.Kind != batchRunRender {
		return nil, notFound("Render not found.")
	}
	saved, err := c.settleBatchRunItem(ctx, run.ID, func(locked *ent.ContentBatchRun, items []schema.BatchRunItem) error {
		at := -1
		for i := range items {
			if items[i].ItemID == itemID {
				at = i
			}
		}
		if at < 0 {
			return notFound("Item not found.")
		}
		// A lost response retried: the first answer stands.
		if items[at].Status == batchItemDone {
			if report.AssetID != items[at].AssetID {
				return conflict("This video was already recorded.")
			}
			return nil
		}
		if locked.Status == batchRunSuperseded {
			return conflict("A newer render replaced this one.")
		}
		if report.Error != "" {
			items[at].Status, items[at].Error = batchItemFailed, report.Error
			return nil
		}
		if err := c.attachRenderedVideo(ctx, actor, row.ID, items[at], report); err != nil {
			return err
		}
		items[at].Status, items[at].AssetID, items[at].Error = batchItemDone, report.AssetID, ""
		return nil
	})
	if err != nil {
		return nil, err
	}
	return batchRunRecord(saved), nil
}

// attachRenderedVideo makes a video the item's media if its concept has not moved on.
func (c *Configuration) attachRenderedVideo(ctx context.Context, actor Actor, batchID string, frozen schema.BatchRunItem, report BatchRenderReport) error {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	item, err := lockedBatchItem(ctx, tx, actor, batchID, frozen.ItemID)
	if err != nil {
		return err
	}
	if item.DraftID != nil {
		return conflict("This video is a draft now. Edit it in Write.")
	}
	if !reflect.DeepEqual(item.Grid, frozen.Grid) {
		return conflict("This video changed while it rendered. Render it again.")
	}
	media := []schema.BatchMedia{{AssetID: report.AssetID, FileName: report.FileName}}
	if err := checkBatchMedia(ctx, tx.Client(), actor.OrganizationID, media, false); err != nil {
		return err
	}
	video, err := tx.Asset.Query().Where(asset.ID(report.AssetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(video.MediaType, "video/") {
		return invalid("A rendered template's output must be a video.")
	}
	if err := tx.ContentBatchItem.UpdateOneID(item.ID).SetMedia(media).Exec(ctx); err != nil {
		return err
	}
	if err := tx.ContentBatch.Update().Where(contentbatch.ID(batchID)).Exec(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) batchRun(ctx context.Context, actor Actor, batchID, runID string) (*ent.ContentBatchRun, error) {
	if !contentDraftRefPattern.MatchString(runID) {
		return nil, notFound("Run not found.")
	}
	run, err := c.client.ContentBatchRun.Query().Where(contentbatchrun.ID(runID), contentbatchrun.BatchID(batchID),
		contentbatchrun.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Run not found.")
	}
	return run, err
}

// GetContentBatchRun reads a run of a batch the actor may see.
func (c *Configuration) GetContentBatchRun(ctx context.Context, actor Actor, batchID, runID string) (*BatchRunRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	row, _, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return nil, err
	}
	run, err := c.batchRun(ctx, actor, row.ID, runID)
	if err != nil {
		return nil, err
	}
	return batchRunRecord(run), nil
}
