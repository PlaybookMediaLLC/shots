package product

import (
	"context"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// Publishing an edited campaign visual. A creative rendered by a release
// workflow or the campaign studio opens in the screenshot editor; the export
// comes back here and becomes an ordinary Publish draft that still names its
// campaign, so review and scheduling stay in Publish while the campaign keeps
// both the edited image and a way to reach the post written from it.

// The kind a campaign asset link gets when an edited export is attached.
const editorExportAssetKind = "editor-export"

// CampaignPublishDraftInput is one edited visual becoming a draft: the
// exported asset, the campaign post whose copy it was written for, and the
// draft itself, written by the composer that owns the body format.
type CampaignPublishDraftInput struct {
	AssetID string `json:"assetId"`
	// CampaignPostID is the generated post the copy came from; it must belong
	// to this campaign, so the provenance recorded is real.
	CampaignPostID string            `json:"campaignPostId"`
	Caption        *string           `json:"caption"`
	Draft          ContentDraftInput `json:"draft"`
}

// CreateCampaignPublishDraft attaches an edited export to a campaign and
// creates the Publish draft for it, in one transaction: a failure leaves
// neither. The caller needs both the campaign's editing role and the content
// draft role and plan, because it writes in both places. A retry carrying the
// same request key returns the first draft instead of writing a second.
func (c *Configuration) CreateCampaignPublishDraft(ctx context.Context, actor Actor, campaignID string, input CampaignPublishDraftInput) (*ContentDraftRecord, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if strings.TrimSpace(input.AssetID) == "" || studioTooLong(input.Caption, 4000) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Locks the campaign for this transaction, so an archive cannot land
	// between the checks below and the draft.
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
	media, err := tx.Asset.Query().Where(asset.ID(input.AssetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if input.CampaignPostID != "" {
		source, err := tx.CampaignPost.Query().Where(campaignpost.ID(input.CampaignPostID),
			campaignpost.OrganizationID(actor.OrganizationID)).Only(ctx)
		if ent.IsNotFound(err) || (err == nil && source.CampaignID != owner.ID) {
			return nil, invalid("That post belongs to another campaign.")
		}
		if err != nil {
			return nil, err
		}
	}
	// Linking the export keeps the edited image on the campaign's asset board
	// beside the creative it came from. The same asset published again keeps
	// one link and takes the newer caption, so a retry adds nothing and a
	// second edit does not leave the first post's words on the board.
	link, err := tx.CampaignAsset.Query().Where(campaignasset.OrganizationID(actor.OrganizationID),
		campaignasset.CampaignID(owner.ID), campaignasset.AssetID(media.ID)).Only(ctx)
	switch {
	case ent.IsNotFound(err):
		create := tx.CampaignAsset.Create().SetID(handoffID(owner.ID + ":" + media.ID + ":export")).
			SetOrganizationID(actor.OrganizationID).SetCampaignID(owner.ID).SetAssetID(media.ID).
			SetKind(editorExportAssetKind).SetNillableCaption(input.Caption)
		if _, err := create.Save(ctx); err != nil {
			if ent.IsConstraintError(err) {
				// Another handoff linked the same asset first.
				return nil, publishing.ErrConflict
			}
			return nil, err
		}
	case err != nil:
		return nil, err
	case input.Caption != nil:
		if _, err := tx.CampaignAsset.UpdateOne(link).SetNillableCaption(input.Caption).Save(ctx); err != nil {
			return nil, err
		}
	}
	draft := input.Draft
	if !slices.Contains(draft.AssetIDs, media.ID) {
		draft.AssetIDs = append(slices.Clone(draft.AssetIDs), media.ID)
	}
	// Only this path may name a campaign: the field is not readable from the
	// draft API's own input, so a draft cannot claim a campaign the caller
	// has no role on.
	draft.campaignID, draft.campaignPostID = owner.ID, input.CampaignPostID
	record, err := c.createContentDraft(ctx, tx, actor, draft)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return record, nil
}
