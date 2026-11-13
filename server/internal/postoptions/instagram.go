package postoptions

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// InstagramOptions are an Instagram post's settings beyond its caption, sent
// as the Graph API's media container parameters.
type InstagramOptions struct {
	// Collaborators are invited as co-authors: feed photos, carousels, reels.
	Collaborators []string `json:"collaborators,omitempty"`
	// UserTags tag accounts on the post's photos, or on the reel.
	UserTags []string `json:"userTags,omitempty"`
	// CoverAssetID is a reel's cover image (cover_url).
	CoverAssetID string `json:"coverAssetId,omitempty"`
	// ShareToFeed false keeps a reel off the profile grid; unset is
	// Instagram's default.
	ShareToFeed *bool `json:"shareToFeed,omitempty"`
	// TrialReel shows a reel to non-followers first (trial_params), and
	// TrialGraduation says how it reaches followers: MANUAL or SS_PERFORMANCE.
	TrialReel       bool   `json:"trialReel,omitempty"`
	TrialGraduation string `json:"trialGraduation,omitempty"`
	// Placement "story" posts one image or video as a story: no caption, and
	// none of the settings above.
	Placement string `json:"placement,omitempty"`
}

// Story reports whether the post is an Instagram story.
func (o *InstagramOptions) Story() bool { return o != nil && o.Placement == "story" }

// Instagram's documented and product limits.
const (
	InstagramCollaboratorLimit = 3
	InstagramUserTagLimit      = 20
)

// instagramUsername is a handle without its @: letters, digits, dots and
// underscores, up to 30, with no dot first, last or twice in a row.
var instagramUsername = regexp.MustCompile(`^[A-Za-z0-9_](?:[A-Za-z0-9_]|\.[A-Za-z0-9_])*$`)

// Reel reports whether a setting needs the post to be a reel: one video.
func (o *InstagramOptions) Reel() bool {
	return o != nil && (o.CoverAssetID != "" || o.ShareToFeed != nil || o.TrialReel || o.TrialGraduation != "")
}

// Validate checks the settings on their own; scheduling checks them against
// the post's media.
func (o *InstagramOptions) Validate() error {
	if o == nil {
		return nil
	}
	for _, list := range []struct {
		names []string
		limit int
		what  string
	}{{o.Collaborators, InstagramCollaboratorLimit, "collaborators"}, {o.UserTags, InstagramUserTagLimit, "tagged accounts"}} {
		if len(list.names) > list.limit {
			return fmt.Errorf("choose up to %d Instagram %s", list.limit, list.what)
		}
		seen := map[string]bool{}
		for _, name := range list.names {
			key := strings.ToLower(name)
			if len(name) > 30 || !instagramUsername.MatchString(name) || seen[key] {
				return fmt.Errorf("name distinct Instagram %s by username, without the @", list.what)
			}
			seen[key] = true
		}
	}
	if o.TrialGraduation != "" && (!o.TrialReel || !slices.Contains([]string{"MANUAL", "SS_PERFORMANCE"}, o.TrialGraduation)) {
		return fmt.Errorf("a trial reel graduates manually (MANUAL) or on performance (SS_PERFORMANCE)")
	}
	if o.Placement != "" && o.Placement != "story" {
		return fmt.Errorf("an Instagram post goes to the feed or, with placement story, to stories")
	}
	if o.Story() && (len(o.Collaborators) > 0 || len(o.UserTags) > 0 || o.Reel()) {
		return fmt.Errorf("a story takes no collaborators, tags, cover, grid choice or trial")
	}
	return nil
}

// ValidateInstagramOptions checks Instagram settings belong to an Instagram
// post and hold on their own; scheduling checks them against its media.
func ValidateInstagramOptions(channel string, o *InstagramOptions) error {
	if o == nil {
		return nil
	}
	if channel != "instagram" && channel != "instagram-standalone" {
		return fmt.Errorf("collaborators, tags, covers and trial reels are Instagram settings")
	}
	return o.Validate()
}

// CoverAsset is the image a video post sets as its cover: an Instagram
// reel's cover or a YouTube video's thumbnail. Empty when there is none.
func CoverAsset(youtube *YouTubeOptions, instagram *InstagramOptions) string {
	switch {
	case youtube != nil && youtube.ThumbnailAssetID != "":
		return youtube.ThumbnailAssetID
	case instagram != nil:
		return instagram.CoverAssetID
	}
	return ""
}
