package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"path"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/lucsky/cuid"
)

// assetClassificationPoster marks a video's opening frame: a child asset the
// library shows in place of downloading the video, and never lists by itself.
const assetClassificationPoster = "poster"

func videoPosterPrefix(organizationID string) string {
	return "org/" + organizationID + "/" + assetClassificationPoster + "/"
}

func isVideoPoster(objectKey string) bool {
	parts := strings.Split(objectKey, "/")
	return len(parts) >= 3 && parts[2] == assetClassificationPoster
}

type AssetListItem struct {
	FileName       string    `json:"fileName"`
	PosterAssetID  string    `json:"posterAssetId,omitempty"`
	Classification string    `json:"classification"`
	ProjectID      string    `json:"projectId,omitempty"`
	ProjectName    string    `json:"projectName,omitempty"`
	UploadedBy     string    `json:"uploadedBy,omitempty"`
	ID             string    `json:"id"`
	Bytes          int       `json:"bytes"`
	CreatedAt      time.Time `json:"createdAt"`
	Height         *int      `json:"height"`
	MediaType      string    `json:"mediaType"`
	Width          *int      `json:"width"`
}

type AssetPage struct {
	Assets     []AssetListItem `json:"assets"`
	NextCursor *string         `json:"nextCursor"`
}

// AssetListOptions applies filters before pagination, with a stable total order.
type AssetListOptions struct {
	Search         string
	Classification string
	Limit          int
	Cursor         string
	Type           string
	Sort           string
}

type assetCursor struct {
	ID             string    `json:"id"`
	CreatedAt      time.Time `json:"at"`
	OrganizationID string    `json:"org"`
	Type           string    `json:"type"`
	Sort           string    `json:"sort"`
}

func encodeAssetCursor(cursor assetCursor) string {
	body, _ := json.Marshal(cursor)
	return "v1." + base64.RawURLEncoding.EncodeToString(body)
}

func decodeAssetCursor(value, org, kind, sort string) (*assetCursor, error) {
	if len(value) > 512 || !strings.HasPrefix(value, "v1.") {
		return nil, ErrInvalidInput
	}
	body, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, "v1."))
	if err != nil {
		return nil, ErrInvalidInput
	}
	var cursor assetCursor
	if json.Unmarshal(body, &cursor) != nil || !validAssetSegment(cursor.ID) || cursor.CreatedAt.IsZero() ||
		cursor.OrganizationID != org || cursor.Type != kind || cursor.Sort != sort {
		return nil, ErrInvalidInput
	}
	return &cursor, nil
}

func (c *Configuration) ListAssets(ctx context.Context, actor Actor, options AssetListOptions) (*AssetPage, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if options.Type == "" {
		options.Type = "all"
	}
	if options.Sort == "" {
		options.Sort = "newest"
	}
	if options.Limit < 1 || options.Limit > 100 ||
		(options.Type != "all" && options.Type != "image" && options.Type != "video") ||
		(options.Sort != "newest" && options.Sort != "oldest") {
		return nil, ErrInvalidInput
	}
	if len(options.Search) > 200 {
		return nil, ErrInvalidInput
	}
	if options.Classification != "" && options.Classification != "input" && options.Classification != "export" && options.Classification != "derived" && options.Classification != "capture" {
		return nil, ErrInvalidInput
	}
	conditions := []predicate.Asset{asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED),
		asset.Not(asset.ObjectKeyHasPrefix(videoPosterPrefix(actor.OrganizationID)))}
	if search := strings.TrimSpace(options.Search); search != "" {
		conditions = append(conditions, asset.ObjectKeyContainsFold(search))
	}
	if options.Classification != "" {
		conditions = append(conditions, asset.ObjectKeyHasPrefix("org/"+actor.OrganizationID+"/"+options.Classification+"/"))
	}
	if options.Type != "all" {
		conditions = append(conditions, asset.MediaTypeHasPrefix(options.Type+"/"))
	}
	if options.Cursor != "" {
		cursor, err := decodeAssetCursor(options.Cursor, actor.OrganizationID, options.Type, options.Sort)
		if err != nil {
			return nil, err
		}
		// The boundary is carried in the cursor, so deleting its row cannot break paging.
		boundary := asset.Or(asset.CreatedAtLT(cursor.CreatedAt), asset.And(asset.CreatedAtEQ(cursor.CreatedAt), asset.IDLT(cursor.ID)))
		if options.Sort == "oldest" {
			boundary = asset.Or(asset.CreatedAtGT(cursor.CreatedAt), asset.And(asset.CreatedAtEQ(cursor.CreatedAt), asset.IDGT(cursor.ID)))
		}
		conditions = append(conditions, boundary)
	}
	order := ent.Desc
	if options.Sort == "oldest" {
		order = ent.Asc
	}
	rows, err := c.client.Asset.Query().Where(conditions...).Order(order(asset.FieldCreatedAt), order(asset.FieldID)).Limit(options.Limit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	page := &AssetPage{Assets: make([]AssetListItem, 0, options.Limit)}
	hasMore := len(rows) > options.Limit
	if hasMore {
		rows = rows[:options.Limit]
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	origins := map[string]*ent.AuditLog{}
	if len(ids) > 0 {
		events, err := c.client.AuditLog.Query().Where(auditlog.OrganizationID(actor.OrganizationID), auditlog.EntityType("asset"), auditlog.EntityIDIn(ids...), auditlog.Action("product.asset_upload_signed")).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, event := range events {
			if event.EntityID != nil {
				origins[*event.EntityID] = event
			}
		}
	}
	posters := map[string]string{}
	if len(ids) > 0 {
		children, err := c.client.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED),
			asset.ParentAssetIDIn(ids...), asset.ObjectKeyHasPrefix(videoPosterPrefix(actor.OrganizationID))).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, child := range children {
			posters[*child.ParentAssetID] = child.ID
		}
	}
	for _, row := range rows {
		item := AssetListItem{PosterAssetID: posters[row.ID], ID: row.ID, Bytes: row.Bytes, CreatedAt: row.CreatedAt, Height: row.Height, MediaType: row.MediaType, Width: row.Width, FileName: path.Base(row.ObjectKey)}
		parts := strings.Split(row.ObjectKey, "/")
		if len(parts) >= 3 {
			item.Classification = parts[2]
		}
		if origin := origins[row.ID]; origin != nil {
			item.ProjectID, _ = origin.Metadata["projectId"].(string)
			item.ProjectName, _ = origin.Metadata["projectName"].(string)
			if origin.ActorDisplay != nil {
				item.UploadedBy = *origin.ActorDisplay
			}
		}
		page.Assets = append(page.Assets, item)
	}
	if hasMore {
		last := rows[len(rows)-1]
		cursor := encodeAssetCursor(assetCursor{ID: last.ID, CreatedAt: last.CreatedAt, OrganizationID: actor.OrganizationID, Type: options.Type, Sort: options.Sort})
		page.NextCursor = &cursor
	}
	return page, nil
}

type AssetDeletionResult string

const (
	AssetDeleted  AssetDeletionResult = "deleted"
	AssetInUse    AssetDeletionResult = "in-use"
	AssetMissing  AssetDeletionResult = "not-found"
	AssetNotReady AssetDeletionResult = "not-ready"
)

func (c *Configuration) DeleteAsset(ctx context.Context, actor Actor, assetID string) (AssetDeletionResult, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return "", err
	}
	owned, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusNEQ(asset.StatusDELETED)).Only(ctx)
	if ent.IsNotFound(err) {
		return AssetMissing, nil
	}
	if err != nil {
		return "", err
	}
	entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return "", err
	}
	plan, _, features := evaluateBootstrapEntitlement(entitlement, time.Now().UTC())
	if err := requireFeature(features, plan, "asset:delete"); err != nil {
		return "", err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	current, err := tx.Asset.Query().Where(asset.ID(owned.ID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return AssetMissing, nil
	}
	if err != nil {
		return "", err
	}
	if current.Status == asset.StatusDELETED {
		return AssetMissing, nil
	}
	if current.Status != asset.StatusUPLOADED {
		return AssetNotReady, nil
	}
	// Serialize against Story Set writes before testing their references.
	locked, err := tx.Asset.Update().Where(asset.ID(current.ID), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).SetStatus(asset.StatusUPLOADED).Save(ctx)
	if err != nil {
		return "", err
	}
	if locked != 1 {
		return AssetNotReady, nil
	}
	inSet, err := creativeSetUsesAsset(ctx, tx, actor.OrganizationID, current.ID)
	if err != nil {
		return "", err
	}
	if inSet {
		return AssetInUse, nil
	}
	variantCount, err := tx.CreativeVariant.Query().Where(
		creativevariant.OrganizationID(actor.OrganizationID), creativevariant.SourceAssetID(current.ID),
	).Count(ctx)
	if err != nil {
		return "", err
	}
	if variantCount > 0 {
		return AssetInUse, nil
	}
	// A draft, a post that has not finished, or a bulk batch still needs it.
	var needed bool
	if err := tx.Client().PlatformQuery(ctx, `SELECT platform_asset_in_use_v1($1, $2, false)`, []any{actor.OrganizationID, current.ID},
		func(row entsql.ColumnScanner) error { return row.Scan(&needed) }); err != nil {
		return "", err
	}
	if needed {
		return AssetInUse, nil
	}
	changed, err := tx.Asset.Update().Where(asset.ID(current.ID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).SetStatus(asset.StatusDELETED).Save(ctx)
	if err != nil {
		return "", err
	}
	if changed != 1 {
		return AssetMissing, nil
	}
	if _, err := tx.OutboxEvent.Delete().Where(outboxevent.OrganizationID(actor.OrganizationID),
		outboxevent.AggregateID(current.ID), outboxevent.AggregateType("asset"), outboxevent.DeliveredAtIsNil()).Exec(ctx); err != nil {
		return "", err
	}
	if _, err := tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("asset.deleted").SetAggregateType("asset").SetAggregateID(current.ID).
		SetPayload(map[string]any{"assetId": current.ID}).SetIdempotencyKey("asset.deleted:" + current.ID).Save(ctx); err != nil {
		return "", err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.asset_deletion_requested", "asset", current.ID); err != nil {
		return "", err
	}
	// A video's poster goes with it, through the same storage cleanup.
	posters, err := tx.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.ParentAssetID(current.ID),
		asset.StatusEQ(asset.StatusUPLOADED), asset.ObjectKeyHasPrefix(videoPosterPrefix(actor.OrganizationID))).All(ctx)
	if err != nil {
		return "", err
	}
	for _, poster := range posters {
		if err := tx.Asset.UpdateOneID(poster.ID).SetStatus(asset.StatusDELETED).Exec(ctx); err != nil {
			return "", err
		}
		if _, err := tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetType("asset.deleted").SetAggregateType("asset").SetAggregateID(poster.ID).
			SetPayload(map[string]any{"assetId": poster.ID}).SetIdempotencyKey("asset.deleted:" + poster.ID).Save(ctx); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return AssetDeleted, nil
}
