package product

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatch"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentbatchitem"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/lucsky/cuid"
)

// Bulk scheduling (RFC 042): a batch holds up to contentBatchItemLimit
// separate posts in one social set, durably, so a refresh, a closed tab or
// another device reopens it. An item stages its caption, ordered media,
// accounts and intended time until its draft exists; the draft then owns the
// content, review and scheduled posts, and the item keeps its time and order.
// Scheduling uses the ordinary per-draft schedule, so idempotency, approval,
// quota and publication status stay in one place.

const contentBatchItemLimit = 100

// ContentBatchInput starts a batch in a social set (the default set when empty).
type ContentBatchInput struct {
	SocialSetID string `json:"socialSetId"`
	Title       string `json:"title"`
}

// ContentBatchRecord is a batch; Items is set when one batch is read.
type ContentBatchRecord struct {
	ArchivedAt  *time.Time               `json:"archivedAt"`
	CreatedAt   time.Time                `json:"createdAt"`
	ID          string                   `json:"id"`
	ItemCount   int                      `json:"itemCount"`
	Items       []ContentBatchItemRecord `json:"items,omitempty"`
	SocialSetID string                   `json:"socialSetId"`
	TimeZone    string                   `json:"timeZone"`
	Title       string                   `json:"title"`
	UpdatedAt   time.Time                `json:"updatedAt"`
}

// BatchMediaRecord is an attachment and what its asset holds now. Status is
// the asset's (UPLOADED, PENDING, FAILED, DELETED), "missing", or "local" for
// a selected file whose upload has not started.
type BatchMediaRecord struct {
	schema.BatchMedia
	Bytes      int    `json:"bytes,omitempty"`
	DurationMs *int   `json:"durationMs"`
	Height     *int   `json:"height"`
	MediaType  string `json:"mediaType,omitempty"`
	Status     string `json:"status"`
	Width      *int   `json:"width"`
}

// BatchDraftSummary is what a batch shows of an item's draft.
type BatchDraftSummary struct {
	ApprovedVersion      *int     `json:"approvedVersion"`
	AssetIDs             []string `json:"assetIds"`
	ChannelConnectionIDs []string `json:"channelConnectionIds"`
	PlainText            string   `json:"plainText"`
	ReviewStatus         string   `json:"reviewStatus"`
	Status               string   `json:"status"`
	Title                string   `json:"title"`
	Version              int      `json:"version"`
}

// ContentBatchItemRecord is one item with its draft and scheduled posts, the
// single record of what was scheduled and what was published.
type ContentBatchItemRecord struct {
	Caption              string             `json:"caption"`
	ChannelConnectionIDs []string           `json:"channelConnectionIds"`
	Draft                *BatchDraftSummary `json:"draft"`
	DraftID              *string            `json:"draftId"`
	ID                   string             `json:"id"`
	ImportKey            string             `json:"importKey"`
	Media                []BatchMediaRecord `json:"media"`
	Position             int                `json:"position"`
	Posts                []ContentDraftPost `json:"posts"`
	Timing               schema.BatchTiming `json:"timing"`
}

// ContentBatchItemInput stages one post. ImportKey makes a retry idempotent.
type ContentBatchItemInput struct {
	Caption              string              `json:"caption"`
	ChannelConnectionIDs []string            `json:"channelConnectionIds"`
	ImportKey            string              `json:"importKey"`
	Media                []schema.BatchMedia `json:"media"`
	Timing               schema.BatchTiming  `json:"timing"`
}

// ContentBatchItemUpdate changes what is set. Once an item has a draft only its
// time and position change here; its content is edited in Write.
type ContentBatchItemUpdate struct {
	Caption              *string              `json:"caption"`
	ChannelConnectionIDs *[]string            `json:"channelConnectionIds"`
	Media                *[]schema.BatchMedia `json:"media"`
	Position             *int                 `json:"position"`
	Timing               *schema.BatchTiming  `json:"timing"`
}

func batchRecord(row *ent.ContentBatch, set *ent.SocialSet, count int) ContentBatchRecord {
	record := ContentBatchRecord{ArchivedAt: row.ArchivedAt, CreatedAt: row.CreatedAt, ID: row.ID, ItemCount: count,
		SocialSetID: row.SocialSetID, Title: row.Title, UpdatedAt: row.UpdatedAt}
	if set != nil {
		record.TimeZone = set.TimeZone
	}
	return record
}

// CreateContentBatch starts a batch in a set the actor may write to.
func (c *Configuration) CreateContentBatch(ctx context.Context, actor Actor, input ContentBatchInput) (*ContentBatchRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(input.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		return nil, invalid("Name the batch in 1 to 200 characters.")
	}
	set, err := c.resolveSocialSet(ctx, actor, input.SocialSetID)
	if err != nil {
		return nil, err
	}
	row, err := c.client.ContentBatch.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSocialSetID(set.ID).
		SetTitle(title).SetNillableCreatedByUserID(projectActor(actor)).Save(ctx)
	if err != nil {
		return nil, err
	}
	record := batchRecord(row, set, 0)
	record.Items = []ContentBatchItemRecord{}
	return &record, nil
}

// ListContentBatches lists the open batches in sets the actor may see.
func (c *Configuration) ListContentBatches(ctx context.Context, actor Actor) ([]ContentBatchRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	sets, err := c.visibleSocialSets(ctx, c.client, actor)
	if err != nil {
		return nil, err
	}
	bySet := map[string]*ent.SocialSet{}
	ids := make([]string, 0, len(sets))
	for _, set := range sets {
		bySet[set.ID] = set
		ids = append(ids, set.ID)
	}
	rows, err := c.client.ContentBatch.Query().Where(contentbatch.OrganizationID(actor.OrganizationID), contentbatch.ArchivedAtIsNil(),
		contentbatch.SocialSetIDIn(ids...)).Order(ent.Desc(contentbatch.FieldCreatedAt), ent.Desc(contentbatch.FieldID)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]ContentBatchRecord, 0, len(rows))
	for _, row := range rows {
		count, err := c.client.ContentBatchItem.Query().Where(contentbatchitem.BatchID(row.ID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		records = append(records, batchRecord(row, bySet[row.SocialSetID], count))
	}
	return records, nil
}

// visibleBatch loads a batch of the workspace in a set the actor may see.
func visibleBatch(ctx context.Context, client *ent.Client, actor Actor, id string) (*ent.ContentBatch, *ent.SocialSet, error) {
	if !contentDraftRefPattern.MatchString(id) {
		return nil, nil, notFound("Batch not found.")
	}
	row, err := client.ContentBatch.Query().Where(contentbatch.ID(id), contentbatch.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, notFound("Batch not found.")
	}
	if err != nil {
		return nil, nil, err
	}
	set, err := visibleSocialSet(ctx, client, actor, row.SocialSetID)
	if err != nil {
		return nil, nil, notFound("Batch not found.")
	}
	return row, set, nil
}

// GetContentBatch reads a batch with every item, its media, its draft and the
// draft's scheduled posts.
func (c *Configuration) GetContentBatch(ctx context.Context, actor Actor, id string) (*ContentBatchRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	row, set, err := visibleBatch(ctx, c.client, actor, id)
	if err != nil {
		return nil, err
	}
	return c.batchWithItems(ctx, actor, row, set)
}

// batchWithItems reads a batch's items, or only those named by only, with their
// media, drafts and scheduled posts. Saving one item reads just that item, so
// uploading a whole batch stays linear in its size.
func (c *Configuration) batchWithItems(ctx context.Context, actor Actor, row *ent.ContentBatch, set *ent.SocialSet, only ...string) (*ContentBatchRecord, error) {
	query := c.client.ContentBatchItem.Query().Where(contentbatchitem.BatchID(row.ID), contentbatchitem.OrganizationID(actor.OrganizationID))
	if len(only) > 0 {
		query = query.Where(contentbatchitem.IDIn(only...))
	}
	items, err := query.Order(ent.Asc(contentbatchitem.FieldPosition), ent.Asc(contentbatchitem.FieldCreatedAt), ent.Asc(contentbatchitem.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	var draftIDs []string
	for _, item := range items {
		if item.DraftID != nil {
			draftIDs = append(draftIDs, *item.DraftID)
		}
	}
	drafts, err := c.client.ContentDraft.Query().Where(contentdraft.OrganizationID(actor.OrganizationID), contentdraft.IDIn(draftIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	draftsByID := map[string]*ent.ContentDraft{}
	for _, draft := range drafts {
		draftsByID[draft.ID] = draft
	}
	var assetIDs []string
	for _, item := range items {
		// Once drafted, the draft's attachments are the item's: the composer may have changed them.
		if item.DraftID != nil && draftsByID[*item.DraftID] != nil {
			item.Media = draftMedia(item.Media, draftsByID[*item.DraftID].AssetIds)
		}
		for _, media := range item.Media {
			assetIDs = append(assetIDs, media.AssetID, media.UploadAssetID)
		}
	}
	assets, err := c.client.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(assetIDs...)).All(ctx)
	if err != nil {
		return nil, err
	}
	assetsByID := map[string]*ent.Asset{}
	for _, row := range assets {
		assetsByID[row.ID] = row
	}
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftIDIn(draftIDs...)).
		WithChannelConnection().Order(ent.Asc(scheduledpost.FieldCreatedAt), ent.Asc(scheduledpost.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	postsByDraft := map[string][]ContentDraftPost{}
	for _, post := range posts {
		postsByDraft[*post.ContentDraftID] = append(postsByDraft[*post.ContentDraftID], contentDraftPost(post, post.Edges.ChannelConnection.Platform))
	}
	record := batchRecord(row, set, len(items))
	record.Items = make([]ContentBatchItemRecord, 0, len(items))
	for _, item := range items {
		entry := ContentBatchItemRecord{Caption: item.Caption, ChannelConnectionIDs: item.ChannelConnectionIds, DraftID: item.DraftID, ID: item.ID,
			ImportKey: item.ImportKey, Position: item.Position, Posts: []ContentDraftPost{}, Timing: item.Timing, Media: make([]BatchMediaRecord, 0, len(item.Media))}
		for _, media := range item.Media {
			// A file not uploaded yet keeps its own size, so the item can be saved back as it is.
			view := BatchMediaRecord{BatchMedia: media, Bytes: media.Bytes, Status: "local"}
			id := media.AssetID
			if id == "" {
				id = media.UploadAssetID
			}
			if id != "" {
				view.Status = "missing"
				if found := assetsByID[id]; found != nil {
					view.Status, view.MediaType, view.Bytes = string(found.Status), found.MediaType, found.Bytes
					view.Width, view.Height, view.DurationMs = found.Width, found.Height, found.DurationMs
				}
			}
			entry.Media = append(entry.Media, view)
		}
		if item.DraftID != nil {
			if draft := draftsByID[*item.DraftID]; draft != nil {
				entry.Draft = &BatchDraftSummary{ApprovedVersion: draft.ApprovedVersion, AssetIDs: draft.AssetIds, ChannelConnectionIDs: draft.ChannelConnectionIds,
					PlainText: draft.PlainText, ReviewStatus: string(draft.ReviewStatus), Status: string(draft.Status), Title: draft.Title, Version: draft.Version}
			}
			if found := postsByDraft[*item.DraftID]; found != nil {
				entry.Posts = found
			}
		}
		record.Items = append(record.Items, entry)
	}
	return &record, nil
}

// draftMedia lists a draft's attachments, keeping the file names they were staged with.
func draftMedia(staged []schema.BatchMedia, assetIDs []string) []schema.BatchMedia {
	names := map[string]string{}
	for _, media := range staged {
		names[media.AssetID] = media.FileName
	}
	media := make([]schema.BatchMedia, len(assetIDs))
	for i, id := range assetIDs {
		media[i] = schema.BatchMedia{AssetID: id, FileName: names[id]}
	}
	return media
}

// checkBatchTiming checks an intended time without resolving the queue.
func checkBatchTiming(timing schema.BatchTiming) error {
	switch timing.Mode {
	case "":
		if timing != (schema.BatchTiming{}) {
			return invalid("Choose a time or the queue for each item.")
		}
	case "time":
		if _, err := time.Parse("2006-01-02T15:04", timing.LocalTime); err != nil {
			return invalid("Give each item's time as YYYY-MM-DDTHH:MM.")
		}
		if _, err := time.LoadLocation(timing.TimeZone); timing.TimeZone == "" || err != nil {
			return invalid("Give each item's time in an IANA time zone, such as Europe/Paris.")
		}
		if timing.Disambiguation != "" && timing.Disambiguation != "earlier" && timing.Disambiguation != "later" {
			return invalid("A repeated local time is the earlier or the later one.")
		}
		if timing.ExpectedQueueSlot != nil {
			return invalid("An item goes at a time or in the queue, not both.")
		}
	case "queue":
		if timing.LocalTime != "" || timing.TimeZone != "" || timing.Disambiguation != "" {
			return invalid("A queued item takes the queue's next free slot.")
		}
	default:
		return invalid("Choose a time or the queue for each item.")
	}
	return nil
}

// checkBatchMedia checks an item's attachments: at most a post's worth, each
// an asset of this workspace or a selected file waiting to upload.
func checkBatchMedia(ctx context.Context, client *ent.Client, organizationID string, media []schema.BatchMedia, staged bool) error {
	if len(media) > contentDraftAssetLimit {
		return invalid(fmt.Sprintf("An item takes up to %d attachments.", contentDraftAssetLimit))
	}
	uploaded := []string{}
	for _, entry := range media {
		switch {
		case entry.AssetID != "":
			if entry.FileName != "" && !validAssetSegment(entry.FileName) || entry.UploadAssetID != "" || !contentDraftRefPattern.MatchString(entry.AssetID) {
				return invalid("Each attachment is an uploaded asset or a selected file.")
			}
			uploaded = append(uploaded, entry.AssetID)
		case staged && entry.FileName != "":
			if !validAssetSegment(entry.FileName) || len(entry.FileName) > 128 || entry.Bytes < 1 ||
				entry.UploadAssetID != "" && !contentDraftRefPattern.MatchString(entry.UploadAssetID) {
				return invalid("Each selected file needs a plain name and a size.")
			}
			if entry.UploadAssetID != "" {
				found, err := client.Asset.Query().Where(asset.ID(entry.UploadAssetID), asset.OrganizationID(organizationID)).Exist(ctx)
				if err != nil {
					return err
				}
				if !found {
					return invalid("A selected file's upload is not in this workspace.")
				}
			}
		default:
			return invalid("Each attachment is an uploaded asset or a selected file.")
		}
	}
	if len(uploaded) == 0 {
		return nil
	}
	count, err := client.Asset.Query().Where(asset.IDIn(uploaded...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED)).Count(ctx)
	if err != nil {
		return err
	}
	if count != distinctAssetCount(uploaded) {
		return invalid("Every attachment must be an uploaded asset of this workspace.")
	}
	return nil
}

func batchItemFingerprint(input ContentBatchItemInput) string {
	encoded, _ := json.Marshal(input)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

// AddContentBatchItems stages items at the end of a batch. A retried item
// (same import key and content) returns as it is; the same key with other
// content is refused. A batch holds at most contentBatchItemLimit items.
func (c *Configuration) AddContentBatchItems(ctx context.Context, actor Actor, batchID string, items []ContentBatchItemInput) (*ContentBatchRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if len(items) == 0 || len(items) > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Add 1 to %d items.", contentBatchItemLimit))
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, set, err := visibleBatch(ctx, tx.Client(), actor, batchID)
	if err != nil {
		return nil, err
	}
	if row.ArchivedAt != nil {
		return nil, conflict("This batch is closed. Start a new batch.")
	}
	// Item writers take turns on the batch so the count and positions hold.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_batch WHERE id=$1 FOR UPDATE`, row.ID); err != nil {
		return nil, err
	}
	existing, err := tx.ContentBatchItem.Query().Where(contentbatchitem.BatchID(row.ID)).All(ctx)
	if err != nil {
		return nil, err
	}
	byKey := map[string]*ent.ContentBatchItem{}
	position := 0
	for _, item := range existing {
		byKey[item.ImportKey] = item
		position = max(position, item.Position+1)
	}
	added := 0
	for _, input := range items {
		if len(input.ImportKey) < 16 || len(input.ImportKey) > 128 || strings.TrimSpace(input.ImportKey) != input.ImportKey {
			return nil, invalid("Each item needs an import key of 16 to 128 characters.")
		}
		fingerprint := batchItemFingerprint(input)
		if found := byKey[input.ImportKey]; found != nil {
			if found.Fingerprint != fingerprint {
				return nil, conflict("An item key was already used for a different item. Reload the batch.")
			}
			continue
		}
		if _, err := contentDraftText(input.Caption); err != nil {
			return nil, err
		}
		if err := checkBatchMedia(ctx, tx.Client(), actor.OrganizationID, input.Media, true); err != nil {
			return nil, err
		}
		if err := checkBatchTiming(input.Timing); err != nil {
			return nil, err
		}
		channels := []string{}
		if len(input.ChannelConnectionIDs) > 0 {
			if channels, err = contentDraftChannels(ctx, tx, actor.OrganizationID, &set.ID, input.ChannelConnectionIDs); err != nil {
				return nil, err
			}
		}
		media := input.Media
		if media == nil {
			media = []schema.BatchMedia{}
		}
		item, err := tx.ContentBatchItem.Create().SetID(cuid.New()).SetBatchID(row.ID).SetOrganizationID(actor.OrganizationID).
			SetImportKey(input.ImportKey).SetFingerprint(fingerprint).SetPosition(position).SetCaption(input.Caption).
			SetMedia(media).SetChannelConnectionIds(channels).SetTiming(input.Timing).Save(ctx)
		if err != nil {
			return nil, err
		}
		byKey[item.ImportKey] = item
		position++
		added++
	}
	if len(existing)+added > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("A batch holds up to %d posts. Start another batch for the rest.", contentBatchItemLimit))
	}
	if added > 0 {
		if err := tx.ContentBatch.UpdateOneID(row.ID).Exec(ctx); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetContentBatch(ctx, actor, row.ID)
}

// batchItem loads an item of a batch the actor may see, for writing.
func (c *Configuration) batchItem(ctx context.Context, tx *ent.Tx, actor Actor, batchID, itemID string) (*ent.ContentBatch, *ent.SocialSet, *ent.ContentBatchItem, error) {
	row, set, err := visibleBatch(ctx, tx.Client(), actor, batchID)
	if err != nil {
		return nil, nil, nil, err
	}
	if row.ArchivedAt != nil {
		return nil, nil, nil, conflict("This batch is closed. Start a new batch.")
	}
	item, err := lockedBatchItem(ctx, tx, actor, row.ID, itemID)
	return row, set, item, err
}

// lockedBatchItem loads an item of a batch under its row lock.
func lockedBatchItem(ctx context.Context, tx *ent.Tx, actor Actor, batchID, itemID string) (*ent.ContentBatchItem, error) {
	if !contentDraftRefPattern.MatchString(itemID) {
		return nil, notFound("Item not found.")
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM content_batch_item WHERE id=$1 AND "batchId"=$2 FOR UPDATE`, itemID, batchID); err != nil {
		return nil, err
	}
	item, err := tx.ContentBatchItem.Query().Where(contentbatchitem.ID(itemID), contentbatchitem.BatchID(batchID),
		contentbatchitem.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Item not found.")
	}
	return item, err
}

// UpdateContentBatchItem changes a staged item, or a drafted item's time and order.
func (c *Configuration) UpdateContentBatchItem(ctx context.Context, actor Actor, batchID, itemID string, input ContentBatchItemUpdate) (*ContentBatchItemRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, set, item, err := c.batchItem(ctx, tx, actor, batchID, itemID)
	if err != nil {
		return nil, err
	}
	if err := applyBatchItemUpdate(ctx, tx, actor, set, item, input); err != nil {
		return nil, err
	}
	if err := tx.ContentBatch.UpdateOneID(row.ID).Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.batchItemRecord(ctx, actor, batchID, itemID)
}

// applyBatchItemUpdate checks and writes one item's changes inside a transaction.
func applyBatchItemUpdate(ctx context.Context, tx *ent.Tx, actor Actor, set *ent.SocialSet, item *ent.ContentBatchItem, input ContentBatchItemUpdate) error {
	update := tx.ContentBatchItem.UpdateOneID(item.ID)
	if item.DraftID != nil && (input.Caption != nil || input.Media != nil || input.ChannelConnectionIDs != nil) {
		return conflict("This item is a draft now. Edit its content in Write.")
	}
	if input.Caption != nil {
		if _, err := contentDraftText(*input.Caption); err != nil {
			return err
		}
		update.SetCaption(*input.Caption)
	}
	if input.Media != nil {
		if err := checkBatchMedia(ctx, tx.Client(), actor.OrganizationID, *input.Media, true); err != nil {
			return err
		}
		update.SetMedia(*input.Media)
	}
	if input.ChannelConnectionIDs != nil {
		channels := []string{}
		if len(*input.ChannelConnectionIDs) > 0 {
			var err error
			if channels, err = contentDraftChannels(ctx, tx, actor.OrganizationID, &set.ID, *input.ChannelConnectionIDs); err != nil {
				return err
			}
		}
		update.SetChannelConnectionIds(channels)
	}
	if input.Timing != nil {
		if err := checkBatchTiming(*input.Timing); err != nil {
			return err
		}
		update.SetTiming(*input.Timing)
	}
	if input.Position != nil {
		if *input.Position < 0 || *input.Position > 10*contentBatchItemLimit {
			return invalid("Choose a position in the batch.")
		}
		update.SetPosition(*input.Position)
	}
	return update.Exec(ctx)
}

// ContentBatchItemPatch is one item's changes in a bulk update.
type ContentBatchItemPatch struct {
	ItemID string `json:"itemId"`
	ContentBatchItemUpdate
}

// UpdateContentBatchItems applies a bulk caption, account or time change as one
// operation: any refused item refuses them all, so no item is left half applied.
func (c *Configuration) UpdateContentBatchItems(ctx context.Context, actor Actor, batchID string, patches []ContentBatchItemPatch) (*ContentBatchRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if len(patches) == 0 || len(patches) > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Change 1 to %d items.", contentBatchItemLimit))
	}
	// Locks are taken in ID order so two bulk updates of a batch cannot deadlock.
	ordered := slices.SortedFunc(slices.Values(patches), func(a, b ContentBatchItemPatch) int { return strings.Compare(a.ItemID, b.ItemID) })
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, set, err := visibleBatch(ctx, tx.Client(), actor, batchID)
	if err != nil {
		return nil, err
	}
	if row.ArchivedAt != nil {
		return nil, conflict("This batch is closed. Start a new batch.")
	}
	for i, patch := range ordered {
		if i > 0 && ordered[i-1].ItemID == patch.ItemID {
			return nil, invalid("Change each item once.")
		}
		item, err := lockedBatchItem(ctx, tx, actor, row.ID, patch.ItemID)
		if err != nil {
			return nil, err
		}
		if err := applyBatchItemUpdate(ctx, tx, actor, set, item, patch.ContentBatchItemUpdate); err != nil {
			return nil, err
		}
	}
	if err := tx.ContentBatch.UpdateOneID(row.ID).Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetContentBatch(ctx, actor, row.ID)
}

func (c *Configuration) batchItemRecord(ctx context.Context, actor Actor, batchID, itemID string) (*ContentBatchItemRecord, error) {
	row, set, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return nil, err
	}
	batch, err := c.batchWithItems(ctx, actor, row, set, itemID)
	if err != nil {
		return nil, err
	}
	if len(batch.Items) == 0 {
		return nil, notFound("Item not found.")
	}
	return &batch.Items[0], nil
}

// RemoveContentBatchItem takes an item out of its batch. A draft it made stays in Write.
func (c *Configuration) RemoveContentBatchItem(ctx context.Context, actor Actor, batchID, itemID string) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	row, _, item, err := c.batchItem(ctx, tx, actor, batchID, itemID)
	if err != nil {
		return err
	}
	if err := tx.ContentBatchItem.DeleteOneID(item.ID).Exec(ctx); err != nil {
		return err
	}
	if err := tx.ContentBatch.UpdateOneID(row.ID).Exec(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

// ArchiveContentBatch closes a batch; its drafts and posts are unaffected.
func (c *Configuration) ArchiveContentBatch(ctx context.Context, actor Actor, batchID string) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	row, _, err := visibleBatch(ctx, c.client, actor, batchID)
	if err != nil {
		return err
	}
	return c.client.ContentBatch.UpdateOneID(row.ID).Where(contentbatch.ArchivedAtIsNil()).SetArchivedAt(time.Now()).Exec(ctx)
}

// CreateContentBatchItemDraft turns a staged item into its draft: the ordinary
// draft creation in the batch's set, with the item's media and accounts. The
// caller supplies the editor body for the item's caption and media.
//
// The draft is created and linked under the item's lock, the one staged edits
// take: a second save waits and returns the first one's draft, and an edit
// either lands before the save reads the item or waits and finds the draft.
// The item is its own receipt, so once its draft is deleted it can be saved again.
func (c *Configuration) CreateContentBatchItemDraft(ctx context.Context, actor Actor, batchID, itemID string, input ContentDraftInput) (*ContentBatchItemRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, _, item, err := c.batchItem(ctx, tx, actor, batchID, itemID)
	if err != nil {
		return nil, err
	}
	if item.DraftID == nil {
		assets := []string{}
		for _, media := range item.Media {
			if media.AssetID == "" {
				return nil, conflict("Finish uploading this item's files, or select them again, before saving it as a draft.")
			}
			assets = append(assets, media.AssetID)
		}
		if err := checkBatchMedia(ctx, tx.Client(), actor.OrganizationID, item.Media, false); err != nil {
			return nil, err
		}
		if input.AssetIDs != nil && !slices.Equal(input.AssetIDs, assets) {
			return nil, invalid("The draft's attachments must be the item's, in order.")
		}
		if input.PlainText != item.Caption {
			return nil, conflict("This item changed while it was being saved. Reload the batch and save it again.")
		}
		input.ImportKey, input.RequestKey, input.SocialSetID, input.AssetIDs = "", "", row.SocialSetID, assets
		input.ChannelConnectionIDs = item.ChannelConnectionIds
		draft, err := c.createContentDraft(ctx, tx, actor, input)
		if err != nil {
			return nil, err
		}
		if err := tx.ContentBatchItem.UpdateOneID(item.ID).SetDraftID(draft.ID).Exec(ctx); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.batchItemRecord(ctx, actor, batchID, itemID)
}

// BatchValidationRow asks whether one item's draft, at Version, can go to
// each target at the item's intended time.
type BatchValidationRow struct {
	ItemID  string                       `json:"itemId"`
	Targets []ContentDraftScheduleTarget `json:"targets"`
	Version int                          `json:"version"`
}

// BatchValidationResult is one item and account: whether it can be scheduled
// now, and if not, what to fix.
type BatchValidationResult struct {
	ChannelConnectionID string     `json:"channelConnectionId"`
	Error               string     `json:"error,omitempty"`
	ItemID              string     `json:"itemId"`
	ScheduledFor        *time.Time `json:"scheduledFor"`
	TimeZone            string     `json:"timeZone"`
	Valid               bool       `json:"valid"`
}

// ValidateContentBatch checks every item and account apart, with the gates
// scheduling applies, without charging quota or reserving anything. A time is
// resolved in its zone so a skipped or repeated hour is named per item; the
// queue's slots are rechecked when each item is scheduled.
func (c *Configuration) ValidateContentBatch(ctx context.Context, actor Actor, batchID string, rows []BatchValidationRow) ([]BatchValidationResult, error) {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	if len(rows) > contentBatchItemLimit {
		return nil, invalid(fmt.Sprintf("Check up to %d items at a time.", contentBatchItemLimit))
	}
	batch, err := c.GetContentBatch(ctx, actor, batchID)
	if err != nil {
		return nil, err
	}
	items := map[string]ContentBatchItemRecord{}
	for _, item := range batch.Items {
		items[item.ID] = item
	}
	results := []BatchValidationResult{}
	for _, row := range rows {
		item, ok := items[row.ItemID]
		if !ok {
			return nil, notFound("Item not found.")
		}
		var at *time.Time
		zone := batch.TimeZone
		timingErr := ""
		switch item.Timing.Mode {
		case "time":
			zone = item.Timing.TimeZone
			resolved, err := resolveLocalTime(item.Timing.LocalTime, zone, item.Timing.Disambiguation)
			switch {
			case err != nil:
				timingErr = err.Error()
			case !resolved.After(time.Now().Add(time.Minute)):
				timingErr = "Pick a time in the future."
			default:
				at = &resolved
			}
		case "queue":
			at = item.Timing.ExpectedQueueSlot
			if at == nil {
				timingErr = "Preview the queue to give this item a slot."
			}
		default:
			timingErr = "Choose a time or the queue for this item."
		}
		for _, target := range row.Targets {
			result := BatchValidationResult{ChannelConnectionID: target.ChannelConnectionID, ItemID: item.ID, ScheduledFor: at, TimeZone: zone}
			switch {
			case item.DraftID == nil:
				result.Error = "Save this item as a draft first."
			case timingErr != "":
				result.Error = timingErr
			default:
				input := ScheduleContentDraftInput{Version: row.Version, Targets: []ContentDraftScheduleTarget{target}, ScheduledFor: *at}
				if err := c.ValidateContentDraftSchedule(ctx, actor, *item.DraftID, input); err != nil {
					result.Error = err.Error()
				}
			}
			result.Valid = result.Error == ""
			results = append(results, result)
		}
	}
	return results, nil
}
