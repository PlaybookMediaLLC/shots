package product

import (
	"context"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/calendarmutation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

var errAutomationDraftDestination = invalid("Assign each capture workflow account to a shared social set in Publish settings, then retry the workflow.")

// Activation and execution must agree on accounts the service can use.
func (c *Configuration) automationDraftDestinations(ctx context.Context, client *ent.Client, org string, ids []string) ([]*ent.ChannelConnection, error) {
	connections, err := client.ChannelConnection.Query().Where(channelconnection.OrganizationID(org), channelconnection.IDIn(ids...), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(connections) != len(ids) {
		return nil, publishing.ErrNotFound
	}
	sets, err := c.visibleSocialSets(ctx, client, Actor{OrganizationID: org, Kind: "service"})
	if err != nil {
		return nil, err
	}
	for _, connection := range connections {
		if !slices.ContainsFunc(sets, func(set *ent.SocialSet) bool { return set.ID == optionalText(connection.SocialSetID) }) {
			return nil, errAutomationDraftDestination
		}
	}
	return connections, nil
}

// assetAspectClass classifies an image's orientation from its pixel dimensions.
func assetAspectClass(width, height *int) string {
	if width == nil || height == nil || *width <= 0 || *height <= 0 {
		return ""
	}
	w, h := *width, *height
	switch {
	case h*10 > w*11:
		return "portrait"
	case w*10 > h*11:
		return "landscape"
	default:
		return "square"
	}
}

// templateAspectClass maps known design templates to an aspect orientation as a
// fallback when rendered asset dimensions are absent.
func templateAspectClass(templateID string) string {
	switch templateID {
	case "layout-story-phone", "story-phone":
		return "portrait"
	case "layout-social-phone", "social-phone-card":
		return "square"
	default:
		return "landscape"
	}
}

// channelPreferredAspects orders aspect orientations for a Publish channel.
func channelPreferredAspects(channel string) []string {
	switch channel {
	case "instagram", "threads":
		return []string{"square", "portrait", "landscape"}
	case "tiktok", "pinterest":
		return []string{"portrait", "square", "landscape"}
	default:
		return []string{"landscape", "square", "portrait"}
	}
}

func automationCaptures(input automation.Outputs) []string {
	if len(input.CaptureAssetIDs) > 0 {
		return input.CaptureAssetIDs
	}
	if input.CaptureAssetID != "" {
		return []string{input.CaptureAssetID}
	}
	return nil
}

// pickDraftMediaForChannel returns the media IDs for one channel's draft:
// multi-capture runs attach one render per captured change; single-capture or
// render-only multi-template runs pick the render whose aspect fits the channel.
func pickDraftMediaForChannel(input automation.Outputs, channel string, aspectByAsset map[string]string) []string {
	captures := automationCaptures(input)
	if len(input.RenderedAssetIDs) == 0 {
		return captures
	}
	if len(captures) > 1 {
		return input.RenderedAssetIDs
	}
	if len(input.RenderedAssetIDs) == 1 {
		return input.RenderedAssetIDs
	}
	for _, want := range channelPreferredAspects(channel) {
		for _, id := range input.RenderedAssetIDs {
			if aspectByAsset[id] == want {
				return []string{id}
			}
		}
	}
	return input.RenderedAssetIDs[:1]
}

// automationDraftMedia returns default draft media without channel preferences
// (one render per captured change, or the first render for a single capture).
func automationDraftMedia(input automation.Outputs) []string {
	return pickDraftMediaForChannel(input, "", nil)
}

// automationDraftCandidateMedia is the full set of candidate assets that any
// channel's draft may attach (every rendered variant or capture).
func automationDraftCandidateMedia(input automation.Outputs) []string {
	if len(input.RenderedAssetIDs) > 0 {
		return input.RenderedAssetIDs
	}
	return automationCaptures(input)
}

// A captured campaign reaches Publish through the same draft owner as an
// editor export. The session-only editor handoff keeps its authorization.
func (c *Configuration) automationCampaignDrafts(ctx context.Context, actor Actor, input automation.Outputs) (automation.Outputs, error) {
	if input.CaptureAssetID == "" && len(input.CaptureAssetIDs) == 0 && len(input.RenderedAssetIDs) == 0 {
		return input, nil
	}
	if input.CampaignID == "" || len(input.PostIDs) == 0 {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return automation.Outputs{}, err
	}
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return automation.Outputs{}, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	defer tx.Rollback()
	// This lock also serializes retries and the session's campaign mutations.
	if err := mutableCampaign(ctx, tx, actor, input.CampaignID); err != nil {
		return automation.Outputs{}, err
	}
	owner, err := tx.Campaign.Query().Where(campaign.ID(input.CampaignID), campaign.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	media := automationDraftCandidateMedia(input)
	linked, err := tx.CampaignAsset.Query().Where(campaignasset.OrganizationID(actor.OrganizationID), campaignasset.CampaignID(owner.ID), campaignasset.AssetIDIn(media...)).
		Select(campaignasset.FieldAssetID).Strings(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	kinds, err := draftMediaKinds(ctx, tx.Asset, actor.OrganizationID, media)
	if err != nil {
		return automation.Outputs{}, err
	}
	for _, id := range media {
		if !slices.Contains(linked, id) || kinds[id] != "img" {
			return automation.Outputs{}, ErrCaptureRefused
		}
	}
	aspectByAsset := map[string]string{}
	if len(input.RenderedAssetIDs) > 1 {
		renderedAssets, err := tx.Asset.Query().Where(asset.OrganizationID(actor.OrganizationID), asset.IDIn(input.RenderedAssetIDs...)).
			Select(asset.FieldID, asset.FieldWidth, asset.FieldHeight).All(ctx)
		if err != nil {
			return automation.Outputs{}, err
		}
		for _, a := range renderedAssets {
			if cls := assetAspectClass(a.Width, a.Height); cls != "" {
				aspectByAsset[a.ID] = cls
			}
		}
		if len(aspectByAsset) < len(input.RenderedAssetIDs) {
			designs, err := tx.Design.Query().Where(design.OrganizationID(actor.OrganizationID), design.CampaignID(owner.ID), design.RenderedAssetIDIn(input.RenderedAssetIDs...)).
				Select(design.FieldRenderedAssetID, design.FieldTemplateID).All(ctx)
			if err != nil {
				return automation.Outputs{}, err
			}
			for _, d := range designs {
				if d.RenderedAssetID != nil && d.TemplateID != nil && aspectByAsset[*d.RenderedAssetID] == "" {
					aspectByAsset[*d.RenderedAssetID] = templateAspectClass(*d.TemplateID)
				}
			}
		}
	}
	connections, err := c.automationDraftDestinations(ctx, tx.Client(), actor.OrganizationID, input.DestinationIDs)
	if err != nil {
		return automation.Outputs{}, err
	}
	remaining := map[string][]*ent.ChannelConnection{}
	for _, id := range input.DestinationIDs {
		for _, connection := range connections {
			if connection.ID == id {
				remaining[draftPlatformChannels[connection.Platform]] = append(remaining[draftPlatformChannels[connection.Platform]], connection)
			}
		}
	}
	outputs := input
	outputs.DraftIDs = []string{}
	for _, id := range input.PostIDs {
		post, err := tx.CampaignPost.Query().Where(campaignpost.ID(id), campaignpost.OrganizationID(actor.OrganizationID), campaignpost.CampaignID(owner.ID)).Only(ctx)
		if err != nil {
			return automation.Outputs{}, err
		}
		channel := draftPlatformChannels[post.Channel]
		if channel == "" || len(remaining[channel]) == 0 {
			return automation.Outputs{}, invalid("A campaign post has no supported destination for its draft.")
		}
		connection := remaining[channel][0]
		remaining[channel] = remaining[channel][1:]
		key := handoffID("automation:" + owner.ID + ":" + post.ID)
		receipt, err := tx.CalendarMutation.Query().Where(calendarmutation.ID(calendarReceiptID(actor, key)), calendarmutation.OrganizationID(actor.OrganizationID), calendarmutation.ActorID(actor.UserID)).Only(ctx)
		if err == nil {
			id, _ := receipt.Result["draftId"].(string)
			saved, err := visibleContentDraft(ctx, tx.Client(), actor, id)
			if err != nil {
				return automation.Outputs{}, err
			}
			if optionalText(saved.CampaignID) != owner.ID || optionalText(saved.CampaignPostID) != post.ID {
				return automation.Outputs{}, ErrInvalidInput
			}
			// Recovery preserves all edits, including an archived or published draft.
			outputs.DraftIDs = append(outputs.DraftIDs, saved.ID)
			continue
		}
		if !ent.IsNotFound(err) {
			return automation.Outputs{}, err
		}
		if post.Status != campaignpost.StatusDRAFT && post.Status != campaignpost.StatusREADY_FOR_REVIEW {
			return automation.Outputs{}, conflict("Only campaign posts awaiting review can become new drafts.")
		}
		copy := strings.TrimSpace(post.Copy + "\n\n" + optionalText(post.CallToAction))
		channelMedia := pickDraftMediaForChannel(input, channel, aspectByAsset)
		attached := channelMedia[:min(len(channelMedia), max(1, draftMediaLimit(channel)))]
		draft, err := c.createContentDraft(ctx, tx, actor, ContentDraftInput{
			RequestKey: key, Title: owner.Name, PlainText: copy, PrimaryPlatform: channel,
			Body:     postBody([]PostPart{{Text: copy, AssetIDs: attached}}, kinds),
			AssetIDs: attached, SocialSetID: optionalText(connection.SocialSetID), ChannelConnectionIDs: []string{connection.ID},
			ReleaseID: optionalText(owner.ReleaseID), campaignID: owner.ID, campaignPostID: post.ID,
		})
		if err != nil {
			return automation.Outputs{}, err
		}
		outputs.DraftIDs = append(outputs.DraftIDs, draft.ID)
	}
	return outputs, tx.Commit()
}
