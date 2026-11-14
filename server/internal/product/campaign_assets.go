package product

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentangle"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// The campaign studio's reads and writes (lib/ai/tools): assets linked to a
// campaign with their plan provenance, generated copy, and in-place design
// edits. Writes need release:create, the same roles as the launch pipeline.

// CampaignAssetLink is one campaign asset with its upload status.
type CampaignAssetLink struct {
	CampaignAssetItem
	AssetStatus string `json:"assetStatus"`
}

type LinkCampaignAssetInput struct {
	Caption      *string `json:"caption"`
	Kind         string  `json:"kind"`
	PlanAssetKey *string `json:"planAssetKey"`
	PlanVersion  *int    `json:"planVersion"`
	VariantLabel *string `json:"variantLabel"`
	// Workflow recovery must not replace a person's caption or provenance.
	preserveExisting bool
}

type SaveCampaignCopyInput struct {
	Angles []CampaignAngleInput `json:"angles"`
	Posts  []CampaignPostInput  `json:"posts"`
}

type ReplaceDesignInput struct {
	Document     map[string]any `json:"document"`
	Name         *string        `json:"name"`
	VariantLabel *string        `json:"variantLabel"`
}

func studioTooLong(value *string, max int) bool {
	return value != nil && utf8.RuneCountInString(*value) > max
}

func campaignAssetLink(link *ent.CampaignAsset, media *ent.Asset) *CampaignAssetLink {
	item := &CampaignAssetLink{AssetStatus: string(media.Status), CampaignAssetItem: CampaignAssetItem{
		AssetID: link.AssetID, CampaignID: link.CampaignID, Caption: link.Caption, CreatedAt: link.CreatedAt,
		ID: link.ID, Kind: link.Kind, OrganizationID: link.OrganizationID, PlanAssetKey: link.PlanAssetKey,
		PlanVersion: link.PlanVersion, VariantLabel: link.VariantLabel}}
	item.Asset.Height, item.Asset.ID, item.Asset.MediaType = media.Height, media.ID, media.MediaType
	item.Asset.ObjectKey, item.Asset.Width = media.ObjectKey, media.Width
	return item
}

// GetCampaignAsset finds the link between a campaign and one of its assets.
func (c *Configuration) GetCampaignAsset(ctx context.Context, actor Actor, campaignID, assetID string) (*CampaignAssetLink, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	link, err := c.client.CampaignAsset.Query().Where(campaignasset.CampaignID(campaignID), campaignasset.AssetID(assetID),
		campaignasset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	media, err := c.client.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return campaignAssetLink(link, media), nil
}

// LinkCampaignAsset attaches a workspace asset to a campaign. Linking the
// same asset again (a re-render that reused its asset) replaces the caption
// and provenance and keeps the kind.
func (c *Configuration) LinkCampaignAsset(ctx context.Context, actor Actor, campaignID, assetID string, input LinkCampaignAssetInput) (*CampaignAssetLink, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.Kind) == "" || len(input.Kind) > 64 || studioTooLong(input.Caption, 4000) ||
		studioTooLong(input.PlanAssetKey, 20) || studioTooLong(input.VariantLabel, 20) ||
		(input.PlanVersion != nil && *input.PlanVersion < 1) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	owned, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, publishing.ErrNotFound
	}
	media, err := tx.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	link, err := tx.CampaignAsset.Query().Where(campaignasset.CampaignID(campaignID), campaignasset.AssetID(assetID)).Only(ctx)
	switch {
	case ent.IsNotFound(err):
		link, err = tx.CampaignAsset.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetCampaignID(campaignID).SetAssetID(assetID).SetKind(input.Kind).SetNillableCaption(input.Caption).
			SetNillablePlanAssetKey(input.PlanAssetKey).SetNillablePlanVersion(input.PlanVersion).
			SetNillableVariantLabel(input.VariantLabel).Save(ctx)
	case err == nil && !input.preserveExisting:
		update := tx.CampaignAsset.UpdateOne(link).SetNillableCaption(input.Caption).
			SetNillablePlanAssetKey(input.PlanAssetKey).SetNillablePlanVersion(input.PlanVersion).
			SetNillableVariantLabel(input.VariantLabel)
		if input.Caption == nil {
			update.ClearCaption()
		}
		if input.PlanAssetKey == nil {
			update.ClearPlanAssetKey()
		}
		if input.PlanVersion == nil {
			update.ClearPlanVersion()
		}
		if input.VariantLabel == nil {
			update.ClearVariantLabel()
		}
		link, err = update.Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return campaignAssetLink(link, media), nil
}

// SaveCampaignCopy adds generated angles and draft posts to a campaign. The
// angles go after any existing ones so a second run never overwrites the first.
func (c *Configuration) SaveCampaignCopy(ctx context.Context, actor Actor, campaignID string, input SaveCampaignCopyInput) error {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return err
	}
	// The same angle and post rules as a new campaign's.
	if len(input.Angles) == 0 || len(input.Posts) == 0 || !validCampaignCreate(CreateCampaignInput{
		Angles: input.Angles, Name: "copy", Objective: "copy", Posts: input.Posts}) {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return err
	}
	owned, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !owned {
		return publishing.ErrNotFound
	}
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, nil, campaignPostTexts(input.Posts)...); err != nil {
		return err
	}
	offset := 0
	last, err := tx.ContentAngle.Query().Where(contentangle.CampaignID(campaignID)).Order(ent.Desc(contentangle.FieldPosition)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if last != nil {
		offset = last.Position + 1
	}
	angleIDs := make([]string, len(input.Angles))
	for index, angle := range input.Angles {
		angleIDs[index] = cuid.New()
		if _, err := tx.ContentAngle.Create().SetID(angleIDs[index]).SetOrganizationID(actor.OrganizationID).
			SetCampaignID(campaignID).SetHook(angle.Hook).SetPosition(offset + index).SetTitle(angle.Title).Save(ctx); err != nil {
			if ent.IsConstraintError(err) {
				// Another save took these positions first.
				return publishing.ErrConflict
			}
			return err
		}
	}
	builders := make([]*ent.CampaignPostCreate, 0, len(input.Posts))
	for _, post := range input.Posts {
		create := tx.CampaignPost.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
			SetChannel(post.Channel).SetCopy(post.Copy).SetNillableCallToAction(post.CallToAction).SetStatus(campaignpost.StatusDRAFT)
		if post.AngleIndex != nil {
			create.SetAngleID(angleIDs[*post.AngleIndex])
		}
		builders = append(builders, create)
	}
	if _, err := tx.CampaignPost.CreateBulk(builders...).Save(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_copy_generated", "campaign", campaignID,
		map[string]any{"angleCount": len(input.Angles), "postCount": len(input.Posts)}); err != nil {
		return err
	}
	return tx.Commit()
}

// ReplaceDesign edits a design in place: its document and, when given, its
// name and A/B label.
func (c *Configuration) ReplaceDesign(ctx context.Context, actor Actor, id string, input ReplaceDesignInput) error {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return err
	}
	if input.Name != nil {
		input.Name = TrimOptional(input.Name)
		if input.Name == nil {
			return ErrInvalidInput
		}
	}
	if studioTooLong(input.Name, 200) || studioTooLong(input.VariantLabel, 20) {
		return ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := mutableDesignCampaign(ctx, tx, actor, id); err != nil {
		return err
	}
	if err := requireDesignAssets(ctx, tx, actor.OrganizationID, input.Document); err != nil {
		return err
	}
	count, err := tx.Design.Update().Where(design.ID(id), design.OrganizationID(actor.OrganizationID)).
		SetDocument(input.Document).SetNillableName(input.Name).SetNillableVariantLabel(input.VariantLabel).Save(ctx)
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
