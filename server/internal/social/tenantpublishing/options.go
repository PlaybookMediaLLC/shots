package tenantpublishing

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Write (RFC 025): a post's settings become its adapter's settings JSON on
// top of the connection's own. Only fields the adapter reads are written.

// postSettings merges a post's options over the connection's settings for
// its platform. rootID is the thread's first post once it is live, for a
// reply that quotes it; empty while the first post does not exist yet.
func postSettings(platform string, base map[string]any, options *postoptions.PublishOptions, rootID string) (json.RawMessage, error) {
	settings := maps.Clone(base)
	if settings == nil {
		settings = map[string]any{}
	}
	if options != nil {
		if options.LinkPreview != nil {
			if platform != "bluesky" {
				return nil, fmt.Errorf("this provider has no verified link preview control")
			}
			settings["link_preview"] = options.LinkPreview
		}

		if options.ShareWithFollowers && (platform != "x" || options.CommunityID == "") {
			return nil, fmt.Errorf("share to timeline requires an X community")
		}
		if err := postoptions.ValidateVideoOptions(platform, options.YouTube, options.TikTok, true); err != nil {
			return nil, err
		}
		switch platform {
		case "youtube":
			settings["title"] = options.YouTube.Title
			settings["type"] = options.YouTube.Privacy
			settings["selfDeclaredMadeForKids"] = "no"
			if *options.YouTube.MadeForKids {
				settings["selfDeclaredMadeForKids"] = "yes"
			}
			if len(options.YouTube.Tags) > 0 {
				tags := make([]map[string]string, len(options.YouTube.Tags))
				for i, tag := range options.YouTube.Tags {
					tags[i] = map[string]string{"value": tag, "label": tag}
				}
				settings["tags"] = tags
			}
			settings["containsSyntheticMedia"] = options.YouTube.ContainsSyntheticMedia
		case "instagram", "instagram-standalone":
			if err := instagramSettings(platform, settings, options.Instagram); err != nil {
				return nil, err
			}
		case "pinterest":
			o := options.Pinterest
			if err := postoptions.ValidatePinterestOptions(platform, o, true); err != nil {
				return nil, err
			}
			settings["board"] = o.BoardID
			if o.Title != "" {
				settings["title"] = o.Title
			}
			if o.Link != "" {
				settings["link"] = o.Link
			}
		case "tiktok":
			o := options.TikTok
			settings["content_posting_method"] = "DIRECT_POST"
			settings["privacy_level"] = o.Privacy
			settings["comment"], settings["duet"], settings["stitch"] = o.AllowComments, o.AllowDuet, o.AllowStitch
			settings["brand_organic_toggle"], settings["brand_content_toggle"] = o.BrandOrganic, o.BrandedContent
			settings["video_made_with_ai"], settings["autoAddMusic"] = o.MadeWithAI, "no"
		case "x":
			if options.QuoteFirstPost && rootID == "" && options.QuoteRemoteID == "" {
				return nil, fmt.Errorf("the first post has no confirmed provider identity")
			}
			xSettings(settings, *options, rootID)
		case "bluesky", "mastodon", "mastodon-custom":
			if options.QuoteRemoteID != "" {
				settings["quote_uri"] = options.QuoteRemoteID
			} else if options.QuoteFirstPost {
				if rootID == "" {
					return nil, fmt.Errorf("the first post has no confirmed provider identity")
				}
				settings["quote_uri"] = rootID
			}
		case "linkedin", "linkedin-page":
			if options.Visibility != "" {
				settings["visibility"] = options.Visibility
			}
			if options.DocumentTitle != "" {
				settings["document_title"] = options.DocumentTitle
			}
			if options.QuoteRemoteID != "" {
				settings["reshare_parent"] = options.QuoteRemoteID
			}
		}
	}
	if platform == "x" {
		// The X adapter requires who can reply; unset is everyone.
		if _, ok := settings["who_can_reply_post"]; !ok {
			settings["who_can_reply_post"] = "everyone"
		}
	}
	return json.Marshal(settings)
}

// instagramSettings writes a post's Instagram options as the adapter reads
// them; the cover travels with the media (Publish).
func instagramSettings(platform string, settings map[string]any, o *postoptions.InstagramOptions) error {
	if err := postoptions.ValidateInstagramOptions(platform, o); err != nil {
		return err
	}
	if o == nil {
		return nil
	}
	if o.Story() {
		settings["post_type"] = "story"
	}
	if len(o.Collaborators) > 0 {
		labels := make([]map[string]string, len(o.Collaborators))
		for i, name := range o.Collaborators {
			labels[i] = map[string]string{"label": name}
		}
		settings["collaborators"] = labels
	}
	if len(o.UserTags) > 0 {
		settings["user_tags"] = o.UserTags
	}
	if o.ShareToFeed != nil {
		settings["share_to_feed"] = *o.ShareToFeed
	}
	if o.TrialReel {
		// Without a graduation the adapter sends MANUAL, Instagram's default.
		settings["is_trial_reel"] = true
		if o.TrialGraduation != "" {
			settings["graduation_strategy"] = o.TrialGraduation
		}
	}
	return nil
}

func xSettings(settings map[string]any, options postoptions.PublishOptions, rootID string) {
	if len(options.TaggedUserIDs) == 0 {
		options.TaggedUserIDs = options.PhotoTagIDs
	}
	if len(options.TaggedUserIDs) > 0 {
		settings["tagged_user_ids"] = options.TaggedUserIDs
	}
	if options.ReplySettings != "" {
		settings["who_can_reply_post"] = options.ReplySettings
	}
	if options.MadeWithAI {
		settings["made_with_ai"] = true
	}
	if options.PaidPartnership {
		settings["paid_partnership"] = true
	}
	if options.CommunityID != "" {
		settings["community"] = "https://x.com/i/communities/" + options.CommunityID
		// X changelog (July 2025): broadcast the community post to followers.
		// Keep explicit false; omitting it lets provider defaults change intent.
		settings["share_with_followers"] = options.ShareWithFollowers
	}
	switch {
	case options.QuoteRemoteID != "":
		settings["quote_tweet_id"] = options.QuoteRemoteID
	case options.QuoteFirstPost && rootID != "":
		settings["quote_tweet_id"] = rootID
	}
	if options.ArticleTitle != "" {
		settings["post_type"] = "article"
		settings["article_title"] = options.ArticleTitle
		settings["article_status"] = "published"
	}
}

// articleCover signs an article's cover for the X adapter, which uploads it.
func (p *Publisher) articleCover(ctx context.Context, input socialapi.PublishInput, settings json.RawMessage) (json.RawMessage, error) {
	if input.Cover == nil || input.Options == nil || input.Options.ArticleCoverAssetID == "" {
		return settings, nil
	}
	media, err := p.signedMedia(ctx, input.OrganizationID, []publishing.MediaAsset{*input.Cover})
	if err != nil || len(media) == 0 {
		return nil, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(settings, &decoded); err != nil {
		return nil, err
	}
	decoded["article_cover"] = map[string]any{"id": input.Cover.ObjectKey, "path": media[0].Path}
	return json.Marshal(decoded)
}

// pollFor is a post's poll as adapters take it: whole hours for those that
// read hours, the exact minutes for those that read minutes, and LinkedIn's
// question.
func pollFor(poll *postoptions.Poll, options *postoptions.PublishOptions) *integrations.PollDetails {
	details := pollDetails(poll)
	if details == nil {
		return nil
	}
	details.DurationMinutes = poll.DurationMinutes
	details.Multiple = poll.Multiple
	if options != nil {
		details.Question = strings.TrimSpace(options.PollQuestion)
	}
	return details
}

// AccountStanding projects verified account capabilities. Editable settings
// and workspace plans never establish account-specific publishing access.
func (p *Publisher) AccountStanding(ctx context.Context, organizationID, destinationID, platform, secretReference string) (product.AccountStanding, error) {
	if platform != "x" && platform != "mastodon-custom" && platform != "tiktok" {
		return product.AccountStanding{}, nil
	}
	account, provider, _, err := p.account(ctx, organizationID, destinationID, platform, secretReference, nil)
	if err != nil {
		return product.AccountStanding{}, err
	}
	if platform == "tiktok" {
		reader, ok := provider.(interface {
			CreatorInfo(context.Context, string) (*postoptions.TikTokCreator, error)
		})
		if !ok {
			return product.AccountStanding{}, fmt.Errorf("TikTok creator information unavailable")
		}
		creator, err := reader.CreatorInfo(ctx, account.Token)
		return product.AccountStanding{TikTokCreator: creator}, err
	}
	if platform == "mastodon-custom" {
		quotes := socialidentity.CanQuoteMastodon(*account.VerifiedCapabilities, account.VerifiedScopes)
		return product.AccountStanding{PollLimits: account.VerifiedCapabilities.Polls, MastodonQuotes: &quotes}, nil
	}
	caps := account.VerifiedCapabilities.X
	limit := caps.PostTextLimit()
	return product.AccountStanding{Premium: caps.LongPostMaxWeightedCharacters != nil, XCaptionLimit: &limit, XArticles: caps.Articles, XQuotes: socialidentity.XEnterpriseQuotesEnabled(), XVideoMaxSeconds: caps.VideoMaxDurationSeconds}, nil
}

// Mentions looks a mention up with the account (RFC 025): an X user by
// username, a LinkedIn organization by vanity name. A lookup that finds
// nothing returns none; a platform without a lookup returns none too.
func (p *Publisher) Mentions(ctx context.Context, organizationID, destinationID, platform, secretReference, query string) ([]product.Mention, error) {
	account, provider, _, err := p.account(ctx, organizationID, destinationID, platform, secretReference, nil)
	if err != nil {
		return nil, err
	}
	finder, ok := provider.(interface {
		Mention(context.Context, string, string, string, *socialent.Integration) ([]integrations.MentionResult, bool, error)
	})
	if !ok {
		return nil, socialapi.NewError(409, false, "This provider connection does not support mention lookup.")
	}
	found, _, err := finder.Mention(ctx, account.Token, query, account.InternalID, account)
	if err != nil {
		return nil, socialapi.NewError(502, false, "Mention lookup was refused or unavailable. Check the connection permissions and try again.")
	}
	mentions := make([]product.Mention, 0, len(found))
	for _, item := range found {
		mention := product.Mention{Image: item.Image, Label: item.Label}
		switch platform {
		case "x":
			mention.Kind, mention.Handle, mention.ProviderID = "person", item.ID, item.NativeID
		case "linkedin", "linkedin-page":
			mention.Kind, mention.ProviderID = "organization", "urn:li:organization:"+item.ID
		default:
			continue
		}
		mentions = append(mentions, mention)
	}
	return mentions, nil
}

// PeopleMentions searches followers through the connected Page's own grant.
func (p *Publisher) PeopleMentions(ctx context.Context, organizationID, destinationID, platform, secretReference, query string) ([]product.Mention, error) {
	if platform != "linkedin-page" {
		return nil, socialapi.NewError(409, false, "Connect a LinkedIn Page with approved follower lookup access to search people.")
	}
	account, provider, _, err := p.account(ctx, organizationID, destinationID, platform, secretReference, nil)
	if err != nil {
		return nil, err
	}
	finder, ok := provider.(interface {
		People(context.Context, string, string, string) ([]integrations.MentionResult, error)
	})
	if !ok {
		return nil, socialapi.NewError(409, false, "This connection does not support LinkedIn people lookup.")
	}
	found, err := finder.People(ctx, account.Token, query, account.InternalID)
	if err != nil {
		return nil, socialapi.NewError(409, false, "LinkedIn people lookup requires an approved Page connection with r_organization_followers access. Reconnect after enabling this permission.")
	}
	out := []product.Mention{}
	for _, person := range found {
		out = append(out, product.Mention{Kind: "person", Label: person.Label, ProviderID: person.ID})
	}
	return out, nil
}
