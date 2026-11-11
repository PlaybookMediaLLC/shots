package product

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

type ScheduleCampaignPostInput struct {
	ChannelConnectionID string `json:"channelConnectionId"`
	// CreativeVariantID attaches an approved visual of this campaign's designs.
	CreativeVariantID *string    `json:"creativeVariantId"`
	ScheduledAt       *time.Time `json:"scheduledAt"`
}

// campaignChannelPlatforms lists the connection platforms that publish each
// campaign post channel. Other channels cannot be scheduled.
var campaignChannelPlatforms = map[string][]string{
	"x":         {"x"},
	"linkedin":  {"linkedin"},
	"instagram": {"instagram", "instagram-standalone"},
}

// campaignChannelLimits mirrors bodyMax in CHANNEL_RULES (lib/launch/guards.ts):
// the copy plus the call to action, as posted. Other channels keep 3000.
var campaignChannelLimits = map[string]int{"x": 280, "linkedin": 3000, "instagram": 2200, "email": 5000, "changelog": 4000, "product_hunt": 260, "threads": 500, "bluesky": 300}

func campaignChannelLimit(channel string) int {
	if limit, ok := campaignChannelLimits[channel]; ok {
		return limit
	}
	return 3000
}

// campaignPostLength counts like the web: copy and call to action joined by a
// space, in UTF-16 code units (JavaScript's String.length).
func campaignPostLength(text, callToAction string) int {
	body := text
	if callToAction != "" {
		body += " " + callToAction
	}
	return len(utf16.Encode([]rune(body)))
}

type ScheduleCampaignPostResult struct {
	Post          CampaignPostItem   `json:"post"`
	ScheduledPost *ent.ScheduledPost `json:"-"`
}

func scheduledCampaignPostItem(post *ent.CampaignPost, scheduled *ent.ScheduledPost) CampaignPostItem {
	item := campaignPostItem(post)
	status := string(scheduled.Status)
	item.ScheduledPostStatus = &status
	return item
}

func nextCampaignPublishTime(now time.Time, timeZone, publishTime string) (time.Time, error) {
	zone, err := time.LoadLocation(timeZone)
	if err != nil {
		return time.Time{}, ErrInvalidInput
	}
	parsed, err := time.Parse("15:04", publishTime)
	if err != nil {
		return time.Time{}, ErrInvalidInput
	}
	local := now.In(zone)
	result := time.Date(local.Year(), local.Month(), local.Day(), parsed.Hour(), parsed.Minute(), 0, 0, zone)
	if !result.After(now) {
		result = time.Date(local.Year(), local.Month(), local.Day()+1, parsed.Hour(), parsed.Minute(), 0, 0, zone)
	}
	return result.UTC(), nil
}

func (c *Configuration) ScheduleCampaignPost(ctx context.Context, actor Actor, campaignID, postID string,
	input ScheduleCampaignPostInput) (*ScheduleCampaignPostResult, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	if input.ChannelConnectionID == "" {
		return nil, ErrInvalidInput
	}
	owned, err := c.client.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, publishing.ErrNotFound
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	post, err := tx.CampaignPost.Query().Where(campaignpost.ID(postID), campaignpost.CampaignID(campaignID),
		campaignpost.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// A cancelled or failed scheduled post can be replaced. UNKNOWN_DELIVERY
	// may have reached the channel, so it is never replaced.
	var prior *ent.ScheduledPost
	if post.Status == campaignpost.StatusSCHEDULED && post.ScheduledPostID != nil {
		scheduled, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(*post.ScheduledPostID),
			scheduledpost.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		switch scheduled.Status {
		case scheduledpost.StatusCANCELLED, scheduledpost.StatusFAILED:
			prior = scheduled
		case scheduledpost.StatusUNKNOWN_DELIVERY:
			return nil, conflict("This post may already be live. Check the channel before scheduling it again.")
		default:
			if scheduled.ChannelConnectionID != input.ChannelConnectionID {
				return nil, publishing.ErrConflict
			}
			return &ScheduleCampaignPostResult{Post: scheduledCampaignPostItem(post, scheduled), ScheduledPost: scheduled}, nil
		}
	}
	if (prior == nil && post.Status != campaignpost.StatusAPPROVED) || strings.TrimSpace(post.Copy) == "" {
		return nil, publishing.ErrConflict
	}
	if length, limit := campaignPostLength(post.Copy, optionalText(post.CallToAction)), campaignChannelLimit(post.Channel); length > limit {
		return nil, conflict(fmt.Sprintf("This %s post is %d characters with the call to action; the limit is %d.", post.Channel, length, limit))
	}
	// The term list may have changed since the copy was approved.
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, nil,
		optionalText(post.Title), post.Copy, optionalText(post.CallToAction)); err != nil {
		return nil, err
	}
	variantID := post.CreativeVariantID
	if input.CreativeVariantID != nil {
		variant, err := tx.CreativeVariant.Query().Where(creativevariant.ID(*input.CreativeVariantID),
			creativevariant.OrganizationID(actor.OrganizationID), creativevariant.StatusEQ(creativevariant.StatusAPPROVED),
			creativevariant.DesignIDNotNil()).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		owned := false
		if variant != nil {
			owned, err = tx.Design.Query().Where(design.ID(*variant.DesignID), design.CampaignID(campaignID),
				design.OrganizationID(actor.OrganizationID)).Exist(ctx)
			if err != nil {
				return nil, err
			}
		}
		if !owned {
			return nil, publishing.ErrNotFound
		}
		variantID = &variant.ID
	}
	if variantID == nil {
		return nil, conflict("Approve a visual for this post before scheduling it.")
	}
	connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(input.ChannelConnectionID),
		channelconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotEligible
	}
	if err != nil {
		return nil, err
	}
	if err := requireSharedAccount(ctx, tx.Client(), actor, connection); err != nil {
		return nil, err
	}
	if !slices.Contains(campaignChannelPlatforms[post.Channel], connection.Platform) {
		return nil, conflict("This channel cannot publish a " + post.Channel + " post.")
	}
	// The account's social set adds the phrases its voice avoids.
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, connection.SocialSetID,
		optionalText(post.Title), post.Copy, optionalText(post.CallToAction)); err != nil {
		return nil, err
	}
	scheduledAt := time.Time{}
	if input.ScheduledAt != nil {
		scheduledAt = input.ScheduledAt.UTC()
	} else {
		settings, err := tx.WorkspaceSettings.Get(ctx, actor.OrganizationID)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		zone, publishTime := "UTC", "09:00"
		if settings != nil {
			zone, publishTime = settings.TimeZone, settings.DefaultPublishTime
		}
		scheduledAt, err = nextCampaignPublishTime(time.Now(), zone, publishTime)
		if err != nil {
			return nil, err
		}
	}
	if !scheduledAt.After(time.Now()) {
		return nil, ErrInvalidInput
	}
	eligible, err := c.auth.IsEligible(ctx, actor.OrganizationID, *variantID, input.ChannelConnectionID)
	if err != nil {
		return nil, err
	}
	if !eligible {
		return nil, publishing.ErrNotEligible
	}
	refund, err := c.ChargeMonthlyQuota(ctx, actor.OrganizationID, QuotaPosts, 1)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			refund()
		}
	}()
	key, guard := "campaign-post:"+postID, []predicate.CampaignPost{
		campaignpost.StatusEQ(campaignpost.StatusAPPROVED), campaignpost.ScheduledPostIDIsNil()}
	if prior != nil {
		key += ":" + prior.ID
		guard = []predicate.CampaignPost{campaignpost.StatusEQ(campaignpost.StatusSCHEDULED), campaignpost.ScheduledPostID(prior.ID)}
	}
	scheduled, err := tx.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetVariantID(*variantID).SetChannelConnectionID(input.ChannelConnectionID).
		SetScheduledFor(scheduledAt).SetStatus(scheduledpost.StatusSCHEDULED).
		SetCaption(post.Copy).SetIdempotencyKey(key).SetNillableScheduledByUserID(schedulerID(actor)).Save(ctx)
	if err != nil {
		if ent.IsConstraintError(err) {
			return nil, publishing.ErrConflict
		}
		return nil, err
	}
	count, err := tx.CampaignPost.Update().Where(campaignpost.ID(postID), campaignpost.CampaignID(campaignID),
		campaignpost.OrganizationID(actor.OrganizationID)).Where(guard...).SetStatus(campaignpost.StatusSCHEDULED).
		SetScheduledAt(scheduledAt).SetScheduledPostID(scheduled.ID).SetCreativeVariantID(*variantID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, publishing.ErrConflict
	}
	for _, event := range []struct {
		action, entityType, entityID string
		metadata                     map[string]any
	}{
		{"post.scheduled", "scheduled_post", scheduled.ID, nil},
		{"product.campaign_post_scheduled", "campaign_post", postID,
			map[string]any{"campaignId": campaignID, "scheduledPostId": scheduled.ID}},
	} {
		if err := appendConfigurationAudit(ctx, tx, actor, event.action, event.entityType, event.entityID, event.metadata); err != nil {
			return nil, err
		}
	}
	updated, err := tx.CampaignPost.Get(ctx, postID)
	if err != nil {
		return nil, err
	}
	result := &ScheduleCampaignPostResult{Post: scheduledCampaignPostItem(updated, scheduled), ScheduledPost: scheduled}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	result.ScheduledPost = scheduled.Unwrap()
	return result, nil
}
