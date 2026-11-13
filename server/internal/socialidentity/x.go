package socialidentity

import (
	"regexp"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
)

var xAccountID = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
var xSubscription = regexp.MustCompile(`^[A-Za-z0-9 _-]{1,40}$`)

// XAccountID validates the native decimal account ID, never a mutable handle.
func XAccountID(value string) bool {
	if !xAccountID.MatchString(value) {
		return false
	}
	_, err := strconv.ParseUint(value, 10, 64)
	return err == nil
}

// XCapabilities separates an observed OAuth 1.0a access level from documented
// standard-post limits. Subscription metadata does not prove premium API access.
// Account-specific long-post and video allowances remain unknown until verified.
type XCapabilities struct {
	OAuth1AccessLevel             string  `json:"oauth1AccessLevel"`
	SubscriptionType              *string `json:"subscriptionType"`
	StandardMaxWeightedCharacters int     `json:"standardMaxWeightedCharacters"`
	CharactersReservedPerURL      int     `json:"charactersReservedPerUrl"`
	MaxImages                     int     `json:"maxImages"`
	MaxGIFs                       int     `json:"maxGifs"`
	MaxVideos                     int     `json:"maxVideos"`
	ImageMaxBytes                 int64   `json:"imageMaxBytes"`
	GIFMaxBytes                   int64   `json:"gifMaxBytes"`
	LongPostMaxWeightedCharacters *int    `json:"longPostMaxWeightedCharacters"`
	Articles                      *bool   `json:"articles"`
	VideoMaxBytes                 *int64  `json:"videoMaxBytes"`
	VideoMaxDurationSeconds       *int    `json:"videoMaxDurationSeconds"`
}

// XVerifiedAccountLimits derives documented account features only from the
// authenticated users/me subscription_type. Unknown subscription names remain
// unknown; an editable Verified flag or developer API plan is not evidence.
func XVerifiedAccountLimits(accessLevel string, subscriptionType *string) XCapabilities {
	caps := XStandardPostLimits(accessLevel, subscriptionType)
	if subscriptionType == nil {
		return caps
	}
	var articles bool
	// X's documented post-video limits per tier live in limits.json.
	video := medialimits.Limits.Destinations["x"].Video.Accounts["standard"]
	switch *subscriptionType {
	case "None":
	case "Basic", "Premium", "PremiumPlus":
		long := 25000
		caps.LongPostMaxWeightedCharacters = &long
		articles = *subscriptionType != "Basic"
		video = medialimits.Limits.Destinations["x"].Video.Accounts["premium"]
	default:
		return caps
	}
	videoBytes, videoSeconds := video.MaxBytes, video.MaxMs/1000
	caps.Articles, caps.VideoMaxBytes, caps.VideoMaxDurationSeconds = &articles, &videoBytes, &videoSeconds
	return caps
}

// PostTextLimit is the verified long-post limit, or the standard post contract
// when an older or incomplete snapshot has no long-post entitlement.
func (c XCapabilities) PostTextLimit() int {
	if c.LongPostMaxWeightedCharacters != nil {
		return *c.LongPostMaxWeightedCharacters
	}
	return c.StandardMaxWeightedCharacters
}

// XStandardPostLimits pins the public standard-post/media contract. It does not
// infer billing access, quota, premium capabilities, or a successful publication.
func XStandardPostLimits(accessLevel string, subscriptionType *string) XCapabilities {
	return XCapabilities{OAuth1AccessLevel: accessLevel, SubscriptionType: subscriptionType,
		StandardMaxWeightedCharacters: 280, CharactersReservedPerURL: 23,
		MaxImages: 4, MaxGIFs: 1, MaxVideos: 1, ImageMaxBytes: 5000000, GIFMaxBytes: 15000000}
}

// Validate accepts only supported write grants and the pinned standard contract.
func (c XCapabilities) Validate() error {
	if (c.OAuth1AccessLevel != "read-write" && c.OAuth1AccessLevel != "read-write-directmessages") ||
		(c.SubscriptionType != nil && !xSubscription.MatchString(*c.SubscriptionType)) ||
		c.StandardMaxWeightedCharacters != 280 || c.CharactersReservedPerURL != 23 ||
		c.MaxImages != 4 || c.MaxGIFs != 1 || c.MaxVideos != 1 || c.ImageMaxBytes != 5000000 || c.GIFMaxBytes != 15000000 {
		return ErrInvalid
	}
	// Older snapshots deliberately stored unknown allowances. They remain
	// readable but cannot gain a capability solely from subscription metadata.
	expected := XVerifiedAccountLimits(c.OAuth1AccessLevel, c.SubscriptionType)
	if c.LongPostMaxWeightedCharacters != nil && (expected.LongPostMaxWeightedCharacters == nil || *c.LongPostMaxWeightedCharacters != *expected.LongPostMaxWeightedCharacters) ||
		c.Articles != nil && (expected.Articles == nil || *c.Articles != *expected.Articles) ||
		c.VideoMaxBytes != nil && (expected.VideoMaxBytes == nil || *c.VideoMaxBytes != *expected.VideoMaxBytes) ||
		c.VideoMaxDurationSeconds != nil && (expected.VideoMaxDurationSeconds == nil || *c.VideoMaxDurationSeconds != *expected.VideoMaxDurationSeconds) ||
		(c.VideoMaxBytes == nil) != (c.VideoMaxDurationSeconds == nil) {
		return ErrInvalid
	}
	return nil
}
