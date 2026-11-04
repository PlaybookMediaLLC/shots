package product

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativesetversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type CreativeSetHandoffInput struct {
	BaseRevision int    `json:"baseRevision"`
	DeliveryID   string `json:"deliveryId"`
	CampaignID   string `json:"campaignId"`
	Channel      string `json:"channel"`
	Copy         string `json:"copy"`
}
type CreativeSetHandoffResult struct {
	CampaignID string `json:"campaignId"`
	DesignID   string `json:"designId"`
	PostID     string `json:"postId"`
}

func handoffID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return "c" + hex.EncodeToString(sum[:12])
}

// Attach a delivered snapshot atomically. Replays return the same candidate; revisions never rewrite earlier candidates.
func (c *Configuration) AttachCreativeSetDelivery(ctx context.Context, actor Actor, setID string, input CreativeSetHandoffInput) (*CreativeSetHandoffResult, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	_, supported := campaignChannelPlatforms[input.Channel]
	if input.BaseRevision < 1 || input.DeliveryID == "" || len(input.DeliveryID) > 80 || strings.TrimSpace(input.Copy) == "" || !supported || campaignPostLength(input.Copy, "") > campaignChannelLimit(input.Channel) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	owner, err := tx.Campaign.Query().Where(campaign.ID(input.CampaignID), campaign.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	set, err := tx.PlatformCreativeSet.Query().Where(platformcreativeset.ID(setID), platformcreativeset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// A code project has no delivery outputs; its images reach campaigns as linked assets.
	if set.Kind == platformcreativeset.KindCode {
		return nil, invalid("Code projects are not delivered this way. Save the image and add it to the campaign.")
	}
	designID := handoffID(actor.OrganizationID + ":" + setID + ":" + input.DeliveryID + ":" + owner.ID)
	postID := handoffID(designID + ":post")
	result := &CreativeSetHandoffResult{CampaignID: owner.ID, DesignID: designID, PostID: postID}
	existing, err := tx.Design.Query().Where(design.ID(designID), design.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err == nil {
		request, _ := existing.Critique["storyHandoff"].(map[string]any)
		if request["copy"] != input.Copy || request["channel"] != input.Channel {
			return nil, conflict("This delivery is already attached. Edit its draft in the campaign or deliver a new revision.")
		}
		return result, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	if err := requireCreativeSetAssets(ctx, tx, actor.OrganizationID, set.Document); err != nil {
		return nil, err
	}
	count, err := tx.PlatformCreativeSet.Update().Where(platformcreativeset.ID(setID), platformcreativeset.OrganizationID(actor.OrganizationID), platformcreativeset.Revision(input.BaseRevision)).SetRevision(input.BaseRevision).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 || set.Revision != input.BaseRevision {
		return nil, &CreativeSetRevisionConflictError{Current: set.Revision}
	}
	var delivery map[string]any
	items, _ := set.Document["deliveries"].([]any)
	for _, item := range items {
		candidate, _ := item.(map[string]any)
		if candidate["id"] == input.DeliveryID {
			delivery = candidate
			break
		}
	}
	ref, _ := delivery["asset"].(string)
	if !designAssetRef.MatchString(ref) {
		return nil, invalid("Save this delivery to workspace assets first.")
	}
	version, err := tx.PlatformCreativeSetVersion.Query().Where(platformcreativesetversion.OrganizationID(actor.OrganizationID), platformcreativesetversion.CreativeSetID(setID), platformcreativesetversion.Revision(int(number(delivery["revision"]))), platformcreativesetversion.KindEQ(platformcreativesetversion.KindNamed)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, conflict("The exact delivery revision was not retained. Render and deliver this output again.")
	}
	if err != nil {
		return nil, err
	}
	media, err := tx.Asset.Query().Where(asset.ID(strings.TrimPrefix(ref, "asset:")), asset.OrganizationID(actor.OrganizationID), asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var native map[string]any
	// A Story Set delivers an output; a canvas delivers one artboard.
	outputs, _ := version.Document["outputs"].([]any)
	if set.Kind == platformcreativeset.KindCanvas {
		outputs, _ = version.Document["artboards"].([]any)
	}
	for _, item := range outputs {
		output, _ := item.(map[string]any)
		if output["id"] == delivery["outputId"] {
			native, _ = output["document"].(map[string]any)
			break
		}
	}
	if native == nil {
		groups, _ := version.Document["storeGroups"].([]any)
		found := false
		for _, item := range groups {
			group, _ := item.(map[string]any)
			if group["id"] == delivery["outputId"] {
				found = true
				break
			}
		}
		if !found || set.Kind == platformcreativeset.KindCanvas || media.Width == nil || media.Height == nil {
			return nil, ErrInvalidInput
		}
		native = map[string]any{"version": 2, "image": map[string]any{"src": ref}, "canvas": map[string]any{"aspectRatio": "custom", "padding": 0, "size": map[string]any{"width": *media.Width, "height": *media.Height}}}
	}
	if err := requireDesignAssets(ctx, tx, actor.OrganizationID, native); err != nil {
		return nil, err
	}
	if err := requireAllowedCopy(ctx, tx.BrandProfile, actor.OrganizationID, input.Copy); err != nil {
		return nil, err
	}
	provenance := map[string]any{"setId": setID, "delivery": delivery, "versionId": version.ID, "copy": input.Copy, "channel": input.Channel}
	raw, _ := json.Marshal(provenance)
	renderKey := handoffID(string(raw))
	name, assetKind := set.Name+" · delivered story", "story-set-delivery"
	if set.Kind == platformcreativeset.KindCanvas {
		name, assetKind = set.Name+" · canvas artboard", "canvas-delivery"
	}
	_, err = tx.Design.Create().SetID(designID).SetOrganizationID(actor.OrganizationID).SetCampaignID(owner.ID).SetName(name).SetDocument(native).SetRenderedAssetID(media.ID).SetRenderKey(renderKey).SetCritique(map[string]any{"storyHandoff": provenance}).SetCreatedByUserID(actor.UserID).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	linked, err := tx.CampaignAsset.Query().Where(campaignasset.OrganizationID(actor.OrganizationID), campaignasset.CampaignID(owner.ID), campaignasset.AssetID(media.ID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !linked {
		_, err = tx.CampaignAsset.Create().SetID(handoffID(designID + ":asset")).SetOrganizationID(actor.OrganizationID).SetCampaignID(owner.ID).SetAssetID(media.ID).SetKind(assetKind).Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	_, err = tx.CampaignPost.Create().SetID(postID).SetOrganizationID(actor.OrganizationID).SetCampaignID(owner.ID).SetChannel(input.Channel).SetCopy(input.Copy).SetStatus(campaignpost.StatusDRAFT).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, creativeSetAction(set.Kind, "delivered"), "creativeSet", setID, map[string]any{"campaignId": owner.ID, "deliveryId": input.DeliveryID, "designId": designID, "postId": postID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
