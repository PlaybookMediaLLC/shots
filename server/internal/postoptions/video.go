package postoptions

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf16"
)

// YouTubeOptions preserves the creator's explicit upload metadata.
type YouTubeOptions struct {
	Title       string `json:"title"`
	Privacy     string `json:"privacy"`
	MadeForKids *bool  `json:"madeForKids,omitempty"`
}

// TikTokOptions contains the consent and controls required for direct video posts.
type TikTokOptions struct {
	CommercialContent bool   `json:"commercialContent,omitempty"`
	Privacy           string `json:"privacy"`
	AllowComments     bool   `json:"allowComments"`
	AllowDuet         bool   `json:"allowDuet"`
	AllowStitch       bool   `json:"allowStitch"`
	BrandOrganic      bool   `json:"brandOrganic"`
	BrandedContent    bool   `json:"brandedContent"`
	MadeWithAI        bool   `json:"madeWithAi"`
	Consent           bool   `json:"consent"`
}

// ValidateVideoOptions checks stored drafts permissively and scheduled snapshots completely.
func ValidateVideoOptions(channel string, youtube *YouTubeOptions, tiktok *TikTokOptions, complete bool) error {
	if youtube != nil && channel != "youtube" || tiktok != nil && channel != "tiktok" {
		return fmt.Errorf("video publishing settings belong to their selected platform")
	}
	if youtube != nil {
		length := len(utf16.Encode([]rune(strings.TrimSpace(youtube.Title))))
		if length > 100 || strings.ContainsAny(youtube.Title, "<>") || (youtube.Privacy != "" && !slices.Contains([]string{"public", "private", "unlisted"}, youtube.Privacy)) {
			return fmt.Errorf("choose a YouTube title of 2 to 100 characters without angle brackets and a valid privacy setting")
		}
		if complete && (length < 2 || youtube.Privacy == "" || youtube.MadeForKids == nil) {
			return fmt.Errorf("choose a YouTube title, privacy and audience before scheduling")
		}
	}
	if tiktok != nil {
		if tiktok.Privacy != "" && !slices.Contains([]string{"PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"}, tiktok.Privacy) {
			return fmt.Errorf("choose a permitted TikTok privacy setting")
		}
		if complete && tiktok.CommercialContent && !tiktok.BrandOrganic && !tiktok.BrandedContent {
			return fmt.Errorf("indicate whether this TikTok content promotes your brand or another brand")
		}
		if (tiktok.BrandOrganic || tiktok.BrandedContent) && !tiktok.CommercialContent {
			return fmt.Errorf("enable TikTok commercial content disclosure for promotional content")
		}
		if tiktok.BrandedContent && tiktok.Privacy == "SELF_ONLY" {
			return fmt.Errorf("branded TikTok content cannot be private")
		}
		if complete && (tiktok.Privacy == "" || !tiktok.Consent) {
			return fmt.Errorf("choose TikTok privacy and confirm publishing consent before scheduling")
		}
	}
	if complete && (channel == "youtube" && youtube == nil || channel == "tiktok" && tiktok == nil) {
		return fmt.Errorf("choose video publishing settings before scheduling")
	}
	return nil
}

// TikTokCreator contains current provider controls, never credentials.
type TikTokCreator struct {
	Nickname           string   `json:"nickname"`
	PrivacyLevels      []string `json:"privacyLevels"`
	MaxDurationSeconds int      `json:"maxDurationSeconds"`
	CommentDisabled    bool     `json:"commentDisabled"`
	DuetDisabled       bool     `json:"duetDisabled"`
	StitchDisabled     bool     `json:"stitchDisabled"`
}

// Check's refusals that need their own fix: a video outside the account's
// allowance, and creator permissions that are missing. A chosen privacy the
// account no longer offers is fixed in the post's options, like any other.
var (
	ErrVideoTooLong       = errors.New("video exceeds the TikTok account duration allowance or has no verified duration")
	ErrCreatorPermissions = errors.New("TikTok publishing permissions are unavailable; refresh the account before scheduling")
)

// Check refuses unavailable account controls and media outside the creator's allowance.
func (c *TikTokCreator) Check(o *TikTokOptions, durationMs int) error {
	if c == nil || o == nil || c.MaxDurationSeconds <= 0 {
		return ErrCreatorPermissions
	}
	if !slices.Contains(c.PrivacyLevels, o.Privacy) {
		return fmt.Errorf("the TikTok account no longer offers the chosen privacy")
	}
	if durationMs <= 0 || durationMs > c.MaxDurationSeconds*1000 {
		return ErrVideoTooLong
	}
	if o.AllowComments && c.CommentDisabled || o.AllowDuet && c.DuetDisabled || o.AllowStitch && c.StitchDisabled {
		return fmt.Errorf("TikTok account settings do not permit the selected interactions")
	}
	return nil
}
