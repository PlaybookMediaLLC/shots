package product

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Per-platform publishing rules (RFC 025), checked on every schedule. The web
// checks the same (lib/write/capabilities.ts); Go is the authority. Sources:
// X API v2 POST /2/tweets (reply_settings, community_id, made_with_ai,
// paid_partnership, quote_tweet_id, poll), the LinkedIn Posts, Poll and
// Documents APIs (visibility, poll, document), and X's article endpoints.

var (
	xReplySettings     = []string{"following", "mentionedUsers", "subscribers", "verified"}
	linkedInVisibility = []string{"PUBLIC", "CONNECTIONS"}
	numericID          = regexp.MustCompile(`^[0-9]{1,30}$`)
	linkedInPostID     = regexp.MustCompile(`^urn:li:(?:share|ugcPost|activity):[0-9]{1,30}$`)
)

// checkPostOptions checks one post's settings against its channel. First is
// whether it is the first post; images is how many images it carries.
func checkPostOptions(channel string, options *postoptions.PublishOptions, first bool) error {
	var youtube *postoptions.YouTubeOptions
	var tiktok *postoptions.TikTokOptions
	if options != nil {
		youtube, tiktok = options.YouTube, options.TikTok
	}
	if err := postoptions.ValidateVideoOptions(channel, youtube, tiktok, true); err != nil {
		return invalid(err.Error())
	}
	if options == nil || options.Empty() {
		return nil
	}
	o := *options
	if err := postoptions.ValidateInstagramOptions(channel, o.Instagram); err != nil {
		return invalid(err.Error())
	}
	if cover := postoptions.CoverAsset(o.YouTube, o.Instagram); cover != "" && !contentDraftRefPattern.MatchString(cover) {
		return invalid("A cover or thumbnail is an uploaded image of this workspace.")
	}
	if err := postoptions.CheckPhotoTags(o.PhotoTagIDs); err != nil {
		return invalid(err.Error())
	}
	if o.LinkPreview != nil {
		if err := o.LinkPreview.Validate(); err != nil {
			return invalid(err.Error())
		}
		if channel != "bluesky" {
			return invalid("This provider has no verified API control for link preview removal.")
		}
	}
	if o.ShareWithFollowers && o.CommunityID == "" {
		return invalid("Share to timeline requires an X community.")
	}
	xOnly := len(o.PhotoTagIDs) > 0 || len(o.TaggedUserIDs) > 0 || o.ReplySettings != "" || o.MadeWithAI || o.PaidPartnership || o.CommunityID != "" || o.ShareWithFollowers ||
		o.ArticleTitle != "" || o.ArticleCoverAssetID != "" || o.ArticleHTML != ""
	linkedInOnly := o.Visibility != "" || o.DocumentAssetID != "" || o.DocumentTitle != "" || o.PollQuestion != ""
	switch {
	case xOnly && channel != "x":
		return invalid("Reply settings, labels, communities and articles are X settings.")
	case linkedInOnly && channel != "linkedin":
		return invalid("Visibility, documents and poll questions are LinkedIn settings here.")
	case o.FirstComment != "" && channel != "linkedin" && channel != "instagram":
		return invalid("First comments are for LinkedIn and Instagram posts.")
	case (o.QuoteRemoteID != "" || o.QuoteFirstPost) && channel != "x" && channel != "linkedin" && channel != "bluesky" && channel != "mastodon":
		return invalid("Quotes are for X, LinkedIn, Bluesky and supported Mastodon servers.")
	}
	if o.ReplySettings != "" && !slices.Contains(xReplySettings, o.ReplySettings) {
		return invalid("Replies are open to everyone, or limited to following, mentionedUsers, subscribers or verified.")
	}
	if o.CommunityID != "" && (!numericID.MatchString(o.CommunityID) || !first) {
		return invalid("A community is an X community's numeric id, set on the first post.")
	}
	if o.QuoteRemoteID != "" {
		if !first || o.QuoteFirstPost {
			return invalid("Only the first post quotes another post; a later post may quote the first.")
		}
		if channel == "x" && !numericID.MatchString(o.QuoteRemoteID) || channel == "linkedin" && !linkedInPostID.MatchString(o.QuoteRemoteID) {
			return invalid("The quoted post's id is not valid for " + channel + ".")
		}
	}
	if o.QuoteRemoteID != "" && channel == "bluesky" {
		if _, err := socialidentity.BlueskyPostURI(o.QuoteRemoteID); err != nil {
			return invalid("Choose a valid Bluesky post to quote.")
		}
	}
	if o.QuoteRemoteID != "" && channel == "mastodon" && !socialidentity.MastodonStatusURL(o.QuoteRemoteID) {
		return invalid("Choose a native Mastodon status URL.")
	}
	if o.QuoteFirstPost && channel == "linkedin" {
		return invalid("LinkedIn does not support thread finishers.")
	}
	if o.QuoteFirstPost && first {
		return invalid("The first post cannot quote itself.")
	}
	if o.DocumentTitle != "" && o.DocumentAssetID == "" {
		return invalid("A document title needs a PDF attachment.")
	}
	if o.Visibility != "" && !slices.Contains(linkedInVisibility, o.Visibility) {
		return invalid("A LinkedIn post is visible to anyone (PUBLIC) or connections (CONNECTIONS).")
	}
	if utf8.RuneCountInString(strings.TrimSpace(o.FirstComment)) > firstCommentLimit {
		return invalid(fmt.Sprintf("Keep the first comment under %d characters.", firstCommentLimit))
	}
	if o.DocumentAssetID != "" && !contentDraftRefPattern.MatchString(o.DocumentAssetID) ||
		utf8.RuneCountInString(o.DocumentTitle) > linkedInDocumentTitleLimit {
		return invalid("A document is a PDF of this workspace, with a title under 200 characters.")
	}
	if utf8.RuneCountInString(o.ArticleTitle) > articleTitleLimit {
		return invalid(fmt.Sprintf("Keep the article title under %d characters.", articleTitleLimit))
	}
	return nil
}

// checkPoll checks a poll against its platform's rules: X asks the post's
// text, with 2 to 4 options of 25 characters open 5 minutes to 7 days;
// LinkedIn asks its own question of 140 characters, with 2 to 4 options of 30
// characters, open 1, 3, 7 or 14 days. Neither takes media beside a poll.
func checkPoll(channel string, poll *postoptions.Poll, options *postoptions.PublishOptions, media int) error {
	if poll == nil {
		if options != nil && options.PollQuestion != "" {
			return invalid("A poll question needs the poll's options.")
		}
		return nil
	}
	if poll.Multiple && channel != "mastodon" {
		return invalid("Multiple-choice polls are supported only on Mastodon.")
	}
	if channel == "mastodon" {
		if options != nil && options.PollQuestion != "" {
			return invalid("Mastodon uses the post text as its poll question.")
		}
		if media > 0 {
			return invalid("A poll cannot have media.")
		}
		return nil
	}
	if len(poll.Options) < 2 || len(poll.Options) > 4 {
		return invalid("A poll has 2 to 4 choices.")
	}
	if media > 0 {
		return invalid(fmt.Sprintf("A %s poll cannot have images, video or a document; remove them or the poll.", channel))
	}
	switch channel {
	case "x":
		if err := socialidentity.CheckXPoll(poll.Options, poll.DurationMinutes, media, false); err != nil {
			return invalid(err.Error())
		}
		return nil
	case "threads":
		if options != nil && options.PollQuestion != "" {
			return invalid("Threads uses the post text as its poll question.")
		}
		if err := socialidentity.CheckThreadsPoll(poll.Options, poll.DurationMinutes, media, poll.Multiple); err != nil {
			return invalid(err.Error())
		}
		return nil
	case "linkedin":
		if options != nil && options.QuoteRemoteID != "" {
			return invalid("A LinkedIn reshare cannot contain a poll.")
		}
		question := ""
		if options != nil {
			question = options.PollQuestion
		}
		if err := socialidentity.CheckLinkedInPoll(question, poll.Options, poll.DurationMinutes, media, poll.Multiple); err != nil {
			return invalid(err.Error())
		}
		return nil
	default:
		return invalid("This platform does not support polls.")
	}
}

// Bluesky permits one media embed; an external card cannot displace attachments.
func checkLinkPreviewMedia(options *postoptions.PublishOptions, media int) error {
	if options != nil && options.LinkPreview != nil && !options.LinkPreview.Removed && media > 0 {
		return invalid("Remove the link preview or the attachments before publishing.")
	}
	return nil
}
