package product

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"strings"
	"unicode/utf16"
)

// xLinkLength is X's length for one link, whatever its real length.
const xLinkLength = 23

// xLength uses the same twitter-text v3 parser as the X adapter, including
// NFC normalization, bare-domain URLs, and complete emoji sequences.
func xLength(text string) int {
	return helpers.WeightedLength(text)
}

// draftPostLength is a draft post's length on its channel: X's own count on
// X, grapheme clusters on Bluesky and Mastodon, and UTF-16 units elsewhere.
// The composer's platformCaptionLength is the same rule; both are tested
// against testdata/caption-length-cases.json.
func draftPostLength(channel, text string) int {
	if channel == "x" {
		return xLength(strings.TrimSpace(text))
	}
	if channel == "bluesky" || channel == "mastodon" {
		return socialidentity.GraphemeLength(text)
	}
	return len(utf16.Encode([]rune(text)))
}
