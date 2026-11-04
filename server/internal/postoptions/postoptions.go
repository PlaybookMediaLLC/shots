// Package postoptions holds what a scheduled post carries beyond its text
// (RFC 013): follow-up actions after it is live, a poll, and how far a thread
// got. A leaf package, so the ent schema can use its types.
package postoptions

import (
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// AutoActions are what happens after a post is live, on channels that
// support them (X). Zero values are off.
type AutoActions struct {
	// RepostAtLikes reposts the post once it has this many likes.
	RepostAtLikes int `json:"repostAtLikes,omitempty"`
	// PlugAtLikes replies PlugText under the post once it has this many of
	// PlugMetric: likes (the default) or reposts. It plugs once.
	PlugAtLikes int    `json:"plugAtLikes,omitempty"`
	PlugText    string `json:"plugText,omitempty"`
	PlugMetric  string `json:"plugMetric,omitempty"`
	// QuoteAfterHours posts QuoteText as a native quote this many hours after
	// publication. The provider must grant native quote access at execution.
	QuoteAfterHours int    `json:"quoteAfterHours,omitempty"`
	QuoteText       string `json:"quoteText,omitempty"`
	// Retweets repost the post at each rule's time (RFC 025), and
	// UnretweetAfterMinutes removes each of those reposts this long after
	// it went up; 0 keeps them.
	Retweets              []RetweetRule `json:"retweets,omitempty"`
	UnretweetAfterMinutes int           `json:"unretweetAfterMinutes,omitempty"`
}

// Empty reports whether no action is set.
func (a AutoActions) Empty() bool {
	return a.RepostAtLikes == 0 && a.PlugAtLikes == 0 && a.QuoteAfterHours == 0 && len(a.Retweets) == 0
}

// RetweetRule is when to repost: AfterMinutes after publishing, or Days
// after the day it was published at the wall-clock time At ("15:04") in
// TimeZone. The two forms are kept apart: a wall-clock time stays put
// across a daylight-saving change, a duration does not.
type RetweetRule struct {
	AfterMinutes int    `json:"afterMinutes,omitempty"`
	Days         int    `json:"days,omitempty"`
	At           string `json:"at,omitempty"`
	TimeZone     string `json:"timeZone,omitempty"`
}

// When is the rule's time for a post published at publishedAt. A wall-clock
// time that does not exist that day (a spring-forward gap) moves forward
// by the gap, as Go's time.Date does.
func (r RetweetRule) When(publishedAt time.Time) (time.Time, error) {
	if r.At == "" {
		if r.AfterMinutes <= 0 {
			return time.Time{}, fmt.Errorf("retweet rule needs afterMinutes or at")
		}
		return publishedAt.Add(time.Duration(r.AfterMinutes) * time.Minute), nil
	}
	zone, err := time.LoadLocation(r.TimeZone)
	if err != nil || r.TimeZone == "" {
		return time.Time{}, fmt.Errorf("retweet rule time zone %q", r.TimeZone)
	}
	clock, err := time.Parse("15:04", r.At)
	if err != nil {
		return time.Time{}, fmt.Errorf("retweet rule time %q", r.At)
	}
	local := publishedAt.In(zone)
	return time.Date(local.Year(), local.Month(), local.Day()+r.Days, clock.Hour(), clock.Minute(), 0, 0, zone), nil
}

// Poll is a question's choices and how long it stays open.
type Poll struct {
	Multiple        bool     `json:"multiple,omitempty"`
	DurationMinutes int      `json:"durationMinutes"`
	Options         []string `json:"options"`
}

// ThreadProgress is how much of a thread is live: the replies posted, of
// how many, and the last live reply a resumed thread answers.
// ThreadReceipt records the exact successful continuation for attribution.
type ThreadReceipt struct {
	RemoteID    string    `json:"remoteId"`
	Position    int       `json:"position"`
	PublishedAt time.Time `json:"publishedAt"`
}

// PublicationReceipt retains a confirmed remote identity, including while processing is uncertain.
type PublicationReceipt struct {
	RemoteID   string `json:"remoteId"`
	URL        string `json:"url"`
	Visibility string `json:"visibility,omitempty"`
}

type ThreadProgress struct {
	Publication *PublicationReceipt `json:"publication,omitempty"`
	Quotes      []QuoteReceipt      `json:"quotes,omitempty"`
	Receipts    []ThreadReceipt     `json:"receipts,omitempty"`
	LastReplyID string              `json:"lastReplyId,omitempty"`
	Posted      int                 `json:"posted"`
	Total       int                 `json:"total"`
}

// QuoteReceipt preserves the native quote approval state of a published status.
type QuoteReceipt struct {
	PostID string `json:"postId"`
	State  string `json:"state"`
}

// Metrics are a live post's engagement counts by name (likes, reposts,
// replies, impressions, …), as its platform reports them.
type Metrics map[string]float64

// PublishOptions are a draft post's settings beyond its text (RFC 025):
// who can reply, its labels, where it goes, and what it quotes. Each field
// belongs to the platforms whose adapter sends it; scheduling refuses it
// anywhere else. Zero values are off.
type PublishOptions struct {
	YouTube *YouTubeOptions `json:"youtube,omitempty"`
	TikTok  *TikTokOptions  `json:"tiktok,omitempty"`
	// X: up to ten numeric user IDs tagged in attached photos.
	PhotoTagIDs   []string     `json:"photoTagIds,omitempty"`
	LinkPreview   *LinkPreview `json:"linkPreview,omitempty"`
	TaggedUserIDs []string     `json:"taggedUserIds,omitempty"`
	// X: who can reply (following, mentionedUsers, subscribers, verified);
	// empty is everyone. Replies never change who can see the post.
	ReplySettings string `json:"replySettings,omitempty"`
	// X: content labels.
	MadeWithAI      bool `json:"madeWithAi,omitempty"`
	PaidPartnership bool `json:"paidPartnership,omitempty"`
	// X: post to a community, and whether followers see it too.
	CommunityID        string `json:"communityId,omitempty"`
	ShareWithFollowers bool   `json:"shareWithFollowers,omitempty"`
	// X: the post this one quotes; LinkedIn: the post this one reshares.
	QuoteRemoteID string `json:"quoteRemoteId,omitempty"`
	// X: this reply quotes the thread's first post, once it is live.
	QuoteFirstPost bool `json:"quoteFirstPost,omitempty"`
	// X articles: the title and cover; the caption is the body.
	ArticleHTML         string `json:"articleHtml,omitempty"`
	ArticleTitle        string `json:"articleTitle,omitempty"`
	ArticleCoverAssetID string `json:"articleCoverAssetId,omitempty"`
	// LinkedIn: PUBLIC or CONNECTIONS; empty is PUBLIC.
	Visibility string `json:"visibility,omitempty"`
	// LinkedIn: a comment posted under the post once it is live.
	FirstComment string `json:"firstComment,omitempty"`
	// LinkedIn: a PDF asset posted as a document carousel, with its title.
	DocumentAssetID string `json:"documentAssetId,omitempty"`
	DocumentTitle   string `json:"documentTitle,omitempty"`
	// LinkedIn: a poll's question (X polls ask the post's text).
	PollQuestion string `json:"pollQuestion,omitempty"`
}

// Empty reports whether no option is set.
func (o PublishOptions) Empty() bool {
	return len(o.PhotoTagIDs) == 0 && len(o.TaggedUserIDs) == 0 && func() bool { o.TaggedUserIDs = nil; o.PhotoTagIDs = nil; return reflect.DeepEqual(o, PublishOptions{}) }()
}

// LivePostURL is a live post's address on its platform, where one can be
// built from its id.
func LivePostURL(platform string, remoteID *string) *string {
	if remoteID == nil || *remoteID == "" {
		return nil
	}
	var url string
	switch platform {
	case "x":
		url = "https://x.com/i/status/" + *remoteID
	case "linkedin", "linkedin-page":
		url = "https://www.linkedin.com/feed/update/" + *remoteID
	case "youtube":
		url = "https://www.youtube.com/watch?v=" + *remoteID
	case "bluesky":
		if uri, err := socialidentity.BlueskyPostURI(*remoteID); err == nil {
			parts := strings.Split(strings.TrimPrefix(uri, "at://"), "/")
			url = "https://bsky.app/profile/" + parts[0] + "/post/" + parts[2]
		}
	case "threads", "mastodon", "mastodon-custom":
		// These providers report a post's address as its id.
		if strings.HasPrefix(*remoteID, "https://") {
			url = *remoteID
		}
	}
	if url == "" {
		return nil
	}
	return &url
}
