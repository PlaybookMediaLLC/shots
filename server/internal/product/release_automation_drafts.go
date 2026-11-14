package product

import (
	"context"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/calendarmutation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
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

// A captured campaign reaches Publish through the same draft owner as an
// editor export. The session-only editor handoff keeps its authorization.
func (c *Configuration) automationCampaignDrafts(ctx context.Context, actor Actor, input automation.Outputs) (automation.Outputs, error) {
	if input.CaptureAssetID == "" {
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
	linked, err := tx.CampaignAsset.Query().Where(campaignasset.OrganizationID(actor.OrganizationID), campaignasset.CampaignID(owner.ID), campaignasset.AssetID(input.CaptureAssetID)).Exist(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	kinds, err := draftMediaKinds(ctx, tx.Asset, actor.OrganizationID, []string{input.CaptureAssetID})
	if err != nil {
		return automation.Outputs{}, err
	}
	if !linked || kinds[input.CaptureAssetID] != "img" {
		return automation.Outputs{}, ErrCaptureRefused
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
		draft, err := c.createContentDraft(ctx, tx, actor, ContentDraftInput{
			RequestKey: key, Title: owner.Name, PlainText: copy, PrimaryPlatform: channel,
			Body:     postBody([]PostPart{{Text: copy, AssetIDs: []string{input.CaptureAssetID}}}, kinds),
			AssetIDs: []string{input.CaptureAssetID}, SocialSetID: optionalText(connection.SocialSetID), ChannelConnectionIDs: []string{connection.ID},
			ReleaseID: optionalText(owner.ReleaseID), campaignID: owner.ID, campaignPostID: post.ID,
		})
		if err != nil {
			return automation.Outputs{}, err
		}
		outputs.DraftIDs = append(outputs.DraftIDs, draft.ID)
	}
	return outputs, tx.Commit()
}
