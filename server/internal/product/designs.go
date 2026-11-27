package product

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/approval"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

// Built-in media: an app path, or a media-library path such as backgrounds/x.webp.
var designBuiltinPath = regexp.MustCompile(`^/[\w./-]+$|^[\w-]+(/[\w.-]+)+$`)

func normalizeMediaHost(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.Contains(trimmed, "://") {
		parsed, err := url.Parse(trimmed)
		if err != nil {
			return ""
		}
		return strings.ToLower(parsed.Host)
	}
	return strings.ToLower(strings.TrimRight(trimmed, "/"))
}

func isTrustedMediaHost(host string) bool {
	lower := strings.ToLower(host)
	if lower == "assets.screenshot-studio.com" || lower == "shots-assets.oppulence.io" {
		return true
	}
	for _, envKey := range []string{"R2_PUBLIC_URL", "NEXT_PUBLIC_R2_PUBLIC_URL"} {
		if configured := normalizeMediaHost(os.Getenv(envKey)); configured != "" && lower == configured {
			return true
		}
	}
	return false
}

// isBuiltinOrMediaSource accepts built-in app/catalog paths and HTTPS URLs on
// the platform's own static R2 CDN host (matching lib/design/document.ts).
func isBuiltinOrMediaSource(ref string) bool {
	if strings.Contains(ref, "..") {
		return false
	}
	if designBuiltinPath.MatchString(ref) {
		return true
	}
	if !strings.HasPrefix(ref, "https://") {
		return false
	}
	parsed, err := url.Parse(ref)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if !isTrustedMediaHost(parsed.Host) {
		return false
	}
	return parsed.Path != "" && designBuiltinPath.MatchString(parsed.Path)
}

type CreateDesignInput struct {
	CampaignID     *string        `json:"campaignId"`
	Document       map[string]any `json:"document"`
	Name           string         `json:"name"`
	ParentDesignID *string        `json:"parentDesignId"`
	PlanAssetKey   *string        `json:"planAssetKey"`
	PlanVersion    *int           `json:"planVersion"`
	TemplateID     *string        `json:"templateId"`
	VariantLabel   *string        `json:"variantLabel"`
}

type DesignAsset struct {
	Height    *int   `json:"height"`
	ID        string `json:"id"`
	ObjectKey string `json:"objectKey"`
	Width     *int   `json:"width"`
}

type DesignRecord struct {
	CampaignID      *string        `json:"campaignId"`
	CreatedAt       time.Time      `json:"createdAt"`
	CreatedByUserID *string        `json:"createdByUserId"`
	Critique        map[string]any `json:"critique"`
	Document        map[string]any `json:"document"`
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	OrganizationID  string         `json:"organizationId"`
	ParentDesignID  *string        `json:"parentDesignId"`
	PlanAssetKey    *string        `json:"planAssetKey"`
	PlanVersion     *int           `json:"planVersion"`
	RenderedAsset   *DesignAsset   `json:"renderedAsset"`
	RenderedAssetID *string        `json:"renderedAssetId"`
	RenderKey       *string        `json:"renderKey"`
	TemplateID      *string        `json:"templateId"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	VariantLabel    *string        `json:"variantLabel"`
	// ApprovedVariant is the newest approved render. When its source asset is
	// not the current render, the design changed since approval.
	ApprovedVariant *ApprovedDesignVariant `json:"approvedVariant"`
}

// ApprovedDesignVariant names the approved creative variant of a design.
type ApprovedDesignVariant struct {
	ID            string `json:"id"`
	SourceAssetID string `json:"sourceAssetId"`
}

func designRecord(row *ent.Design) DesignRecord {
	return DesignRecord{CampaignID: row.CampaignID, CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID,
		Critique: row.Critique, Document: row.Document, ID: row.ID, Name: row.Name,
		OrganizationID: row.OrganizationID, ParentDesignID: row.ParentDesignID,
		PlanAssetKey: row.PlanAssetKey, PlanVersion: row.PlanVersion, RenderedAssetID: row.RenderedAssetID,
		RenderKey: row.RenderKey, TemplateID: row.TemplateID, UpdatedAt: row.UpdatedAt, VariantLabel: row.VariantLabel}
}

func designSource(value any, ids map[string]bool) bool {
	if value == nil {
		return true
	}
	ref, ok := value.(string)
	if !ok {
		return false
	}
	if strings.HasPrefix(ref, "asset:") {
		id := strings.TrimPrefix(ref, "asset:")
		if _, err := uuid.Parse(id); err != nil {
			return false
		}
		ids[id] = true
		return true
	}
	return isBuiltinOrMediaSource(ref)
}

// designDocumentVersions are the design document versions the backend stores.
var designDocumentVersions = map[float64]bool{1: true, 2: true}

var designAssetRef = regexp.MustCompile(`^asset:[0-9a-fA-F-]{36}$`)

// collectDesignAssetIDs adds every asset reference anywhere in a document
// value: sections such as slides and timelines may hold images too.
func collectDesignAssetIDs(value any, ids map[string]bool) bool {
	switch typed := value.(type) {
	case string:
		if strings.HasPrefix(typed, "blob:") {
			return false
		}
		if designAssetRef.MatchString(typed) {
			id := strings.TrimPrefix(typed, "asset:")
			if _, err := uuid.Parse(id); err != nil {
				return false
			}
			ids[id] = true
		}
	case []any:
		for _, item := range typed {
			if !collectDesignAssetIDs(item, ids) {
				return false
			}
		}
	case map[string]any:
		for _, item := range typed {
			if !collectDesignAssetIDs(item, ids) {
				return false
			}
		}
	}
	return true
}

func designAssetIDs(document map[string]any) ([]string, error) {
	version, _ := document["version"].(float64)
	if intVersion, ok := document["version"].(int); ok {
		version = float64(intVersion)
	}
	if document == nil || !designDocumentVersions[version] {
		return nil, ErrInvalidInput
	}
	image, ok := document["image"].(map[string]any)
	if !ok {
		return nil, ErrInvalidInput
	}
	ids := map[string]bool{}
	if !designSource(image["src"], ids) {
		return nil, ErrInvalidInput
	}
	if background, ok := document["background"].(map[string]any); ok && background["type"] == "image" {
		if background["value"] == nil || !designSource(background["value"], ids) {
			return nil, ErrInvalidInput
		}
	}
	for _, path := range [][2]string{{"devices", "mockups"}, {"slides", "items"}} {
		section, _ := document[path[0]].(map[string]any)
		items, _ := section[path[1]].([]any)
		for _, value := range items {
			item, ok := value.(map[string]any)
			if !ok {
				return nil, ErrInvalidInput
			}
			src := item["src"]
			if screen, ok := item["screen"].(map[string]any); ok {
				src = screen["src"]
			}
			if !designSource(src, ids) {
				return nil, ErrInvalidInput
			}
		}
	}
	if overlays, ok := document["overlays"].([]any); ok {
		for _, value := range overlays {
			overlay, ok := value.(map[string]any)
			if !ok || overlay["src"] == nil || !designSource(overlay["src"], ids) {
				return nil, ErrInvalidInput
			}
		}
	}
	// Later sections may hold images too; every asset reference is checked.
	if !collectDesignAssetIDs(document, ids) {
		return nil, ErrInvalidInput
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	return result, nil
}

func requireDesignAssets(ctx context.Context, tx *ent.Tx, organizationID string, document map[string]any) error {
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 1<<20 {
		return ErrInvalidInput
	}
	ids, err := designAssetIDs(document)
	if err != nil || len(ids) == 0 {
		return err
	}
	count, err := tx.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Count(ctx)
	if err != nil {
		return err
	}
	if count != len(ids) {
		return publishing.ErrNotFound
	}
	return nil
}

func (c *Configuration) CreateDesign(ctx context.Context, actor Actor, input CreateDesignInput) (*DesignRecord, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 200 ||
		(input.PlanVersion != nil && *input.PlanVersion < 1) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if input.CampaignID != nil {
		if err := mutableCampaign(ctx, tx, actor, *input.CampaignID); err != nil {
			return nil, err
		}
	}
	if err := requireDesignAssets(ctx, tx, actor.OrganizationID, input.Document); err != nil {
		return nil, err
	}
	if input.CampaignID != nil {
		owned, err := tx.Campaign.Query().Where(campaign.ID(*input.CampaignID),
			campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil || !owned {
			if err != nil {
				return nil, err
			}
			return nil, publishing.ErrNotFound
		}
	}
	if input.ParentDesignID != nil {
		owned, err := tx.Design.Query().Where(design.ID(*input.ParentDesignID),
			design.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil || !owned {
			if err != nil {
				return nil, err
			}
			return nil, publishing.ErrNotFound
		}
	}
	create := tx.Design.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetName(input.Name).SetDocument(input.Document)
	if input.CampaignID != nil {
		create.SetCampaignID(*input.CampaignID)
	}
	if input.ParentDesignID != nil {
		create.SetParentDesignID(*input.ParentDesignID)
	}
	if input.PlanAssetKey != nil {
		create.SetPlanAssetKey(*input.PlanAssetKey)
	}
	if input.PlanVersion != nil {
		create.SetPlanVersion(*input.PlanVersion)
	}
	if input.VariantLabel != nil {
		create.SetVariantLabel(*input.VariantLabel)
	}
	templateID := input.TemplateID
	if templateID == nil {
		if value, ok := input.Document["template"].(string); ok {
			templateID = &value
		}
	}
	if templateID != nil {
		create.SetTemplateID(*templateID)
	}
	if actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.design_created", "design", row.ID,
		map[string]any{"campaignId": input.CampaignID, "parentDesignId": input.ParentDesignID, "templateId": templateID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := designRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) GetDesign(ctx context.Context, actor Actor, id string) (*DesignRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Design.Query().Where(design.ID(id), design.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := designRecord(row)
	return &result, nil
}

func (c *Configuration) UpdateDesignDocument(ctx context.Context, actor Actor, id string, document map[string]any) error {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := mutableDesignCampaign(ctx, tx, actor, id); err != nil {
		return err
	}
	if err := requireDesignAssets(ctx, tx, actor.OrganizationID, document); err != nil {
		return err
	}
	update := tx.Design.Update().Where(design.ID(id), design.OrganizationID(actor.OrganizationID)).SetDocument(document)
	if template, ok := document["template"].(string); ok && template != "" {
		update.SetTemplateID(template)
	} else {
		update.ClearTemplateID()
	}
	count, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.design_updated", "design", id); err != nil {
		return err
	}
	return tx.Commit()
}

func (c *Configuration) SetDesignRender(ctx context.Context, actor Actor, id, assetID string, renderKey *string) error {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := mutableDesignCampaign(ctx, tx, actor, id); err != nil {
		return err
	}
	ownedAsset, err := tx.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Exist(ctx)
	if err != nil {
		return err
	}
	if !ownedAsset {
		return publishing.ErrNotFound
	}
	update := tx.Design.Update().Where(design.ID(id), design.OrganizationID(actor.OrganizationID)).SetRenderedAssetID(assetID)
	if renderKey == nil {
		update.ClearRenderKey()
	} else {
		update.SetRenderKey(*renderKey)
	}
	count, err := update.Save(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return publishing.ErrNotFound
	}
	return tx.Commit()
}

func (c *Configuration) ListCampaignDesigns(ctx context.Context, actor Actor, campaignID string) ([]DesignRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.Design.Query().Where(design.CampaignID(campaignID), design.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(design.FieldCreatedAt), ent.Asc(design.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	variants, err := c.client.CreativeVariant.Query().Where(creativevariant.DesignIDIn(ids...),
		creativevariant.OrganizationID(actor.OrganizationID), creativevariant.StatusEQ(creativevariant.StatusAPPROVED)).
		Order(ent.Desc(creativevariant.FieldRevision)).All(ctx)
	if err != nil {
		return nil, err
	}
	approved := map[string]*ApprovedDesignVariant{}
	for _, variant := range variants {
		if approved[*variant.DesignID] == nil {
			approved[*variant.DesignID] = &ApprovedDesignVariant{ID: variant.ID, SourceAssetID: variant.SourceAssetID}
		}
	}
	renderedIDs := []string{}
	for _, row := range rows {
		if row.RenderedAssetID != nil {
			renderedIDs = append(renderedIDs, *row.RenderedAssetID)
		}
	}
	rendered, err := c.client.Asset.Query().Where(asset.IDIn(renderedIDs...), asset.OrganizationID(actor.OrganizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	renderedByID := make(map[string]*ent.Asset, len(rendered))
	for _, media := range rendered {
		renderedByID[media.ID] = media
	}
	items := make([]DesignRecord, 0, len(rows))
	for _, row := range rows {
		item := designRecord(row)
		item.ApprovedVariant = approved[row.ID]
		if row.RenderedAssetID != nil {
			if media := renderedByID[*row.RenderedAssetID]; media != nil {
				item.RenderedAsset = &DesignAsset{Height: media.Height, ID: media.ID, ObjectKey: media.ObjectKey, Width: media.Width}
			}
		}
		items = append(items, item)
	}
	return items, nil
}

// ApproveCampaignDesign approves a design's current render for publishing. The
// render becomes a creative variant (one per design and render), so a later
// re-render never changes what was approved.
func (c *Configuration) ApproveCampaignDesign(ctx context.Context, actor Actor, campaignID, designID string) (*CreativeApprovalDecision, error) {
	return c.approveCampaignVisual(ctx, actor, campaignID, designID, "")
}

// ApproveCampaignAsset gives a fallback product shot the same immutable render
// approval and publishing lineage as editor designs.
func (c *Configuration) ApproveCampaignAsset(ctx context.Context, actor Actor, campaignID, assetID string) (*CreativeApprovalDecision, error) {
	return c.approveCampaignVisual(ctx, actor, campaignID, "", assetID)
}

func (c *Configuration) approveCampaignVisual(ctx context.Context, actor Actor, campaignID, designID, assetID string) (*CreativeApprovalDecision, error) {
	if err := c.authorizeDecision(ctx, actor, creativeApproveRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	owner, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if assetID != "" {
		link, err := tx.CampaignAsset.Query().Where(campaignasset.CampaignID(campaignID), campaignasset.AssetID(assetID),
			campaignasset.OrganizationID(actor.OrganizationID), campaignasset.KindIn("product-shot", "code-visual")).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		// mutableCampaign holds the parent lock, so retries cannot create two designs.
		existing, err := tx.Design.Query().Where(design.CampaignID(campaignID), design.OrganizationID(actor.OrganizationID), design.RenderedAssetID(assetID)).First(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if existing == nil {
			media, err := tx.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
			if ent.IsNotFound(err) {
				return nil, publishing.ErrNotFound
			}
			if err != nil {
				return nil, err
			}
			if media.Width == nil || media.Height == nil {
				return nil, conflict("The visual needs image dimensions before approval.")
			}
			existing, err = tx.Design.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
				SetName("Product shot").SetRenderedAssetID(assetID).SetNillablePlanAssetKey(link.PlanAssetKey).
				SetNillablePlanVersion(link.PlanVersion).SetNillableVariantLabel(link.VariantLabel).SetCreatedAt(link.CreatedAt).
				SetDocument(map[string]any{"version": 2, "canvas": map[string]any{"aspectRatio": "custom", "padding": 0,
					"size": map[string]any{"width": *media.Width, "height": *media.Height}},
					"image": map[string]any{"src": "asset:" + assetID, "scale": 100, "radius": 0}}).Save(ctx)
			if err != nil {
				return nil, err
			}
		}
		designID = existing.ID
	}
	row, err := tx.Design.Query().Where(design.ID(designID), design.CampaignID(campaignID),
		design.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if owner.ReleaseID == nil {
		return nil, conflict("Link this campaign to a release before approving a visual.")
	}
	var render *ent.Asset
	if row.RenderedAssetID != nil {
		render, err = tx.Asset.Query().Where(asset.ID(*row.RenderedAssetID), asset.OrganizationID(actor.OrganizationID),
			asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
	}
	if render == nil || render.Width == nil || render.Height == nil || *render.Width < 1 || *render.Height < 1 {
		return nil, conflict("Render this design before approving it.")
	}
	variant, err := tx.CreativeVariant.Query().Where(creativevariant.DesignID(row.ID),
		creativevariant.SourceAssetID(render.ID), creativevariant.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if variant == nil {
		ratio := designAspectRatio(*render.Width, *render.Height)
		current, err := tx.CreativeVariant.Query().Where(creativevariant.ReleaseID(*owner.ReleaseID),
			creativevariant.AspectRatio(ratio)).Order(ent.Desc(creativevariant.FieldRevision)).First(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		revision := 1
		if current != nil {
			revision = current.Revision + 1
		}
		variant, err = tx.CreativeVariant.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetReleaseID(*owner.ReleaseID).SetSourceAssetID(render.ID).SetDesignID(row.ID).
			SetRevision(revision).SetAspectRatio(ratio).SetStatus(creativevariant.StatusDRAFT).
			SetCreatedByUserID(actor.UserID).Save(ctx)
		if ent.IsConstraintError(err) {
			return nil, publishing.ErrConflict
		}
		if err != nil {
			return nil, err
		}
		if _, err := tx.Approval.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetVariantID(variant.ID).SetStatus(approval.StatusPENDING).Save(ctx); err != nil {
			return nil, err
		}
		if err := recordProductActivity(ctx, tx, actor, "variant.ready", "product.creative_variant_created", "creative_variant", variant.ID,
			map[string]any{"designId": row.ID}); err != nil {
			return nil, err
		}
	} else if variant.Status == creativevariant.StatusAPPROVED {
		// Approving the same render again changes nothing.
		decided, err := tx.Approval.Query().Where(approval.VariantID(variant.ID), approval.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if decided != nil && decided.Status == approval.StatusAPPROVED {
			return &CreativeApprovalDecision{Approval: creativeApprovalRecord(decided.Unwrap()),
				Variant: creativeVariantRecord(variant.Unwrap())}, nil
		}
	}
	decision, err := decideVariantTx(ctx, tx, actor, variant.ID, CreativeApprovalInput{Status: "APPROVED"})
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &CreativeApprovalDecision{Approval: creativeApprovalRecord(decision.approval.Unwrap()),
		Variant: creativeVariantRecord(decision.variant.Unwrap())}, nil
}

// designAspectRatio reduces render dimensions to a ratio such as 16:9.
func designAspectRatio(width, height int) string {
	a, b := width, height
	for b != 0 {
		a, b = b, a%b
	}
	return strconv.Itoa(width/a) + ":" + strconv.Itoa(height/a)
}
