package product

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"regexp"
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

// Mastodon counts a remote mention by its local part and any link as 23
// characters (StatusLengthValidator). The composer uses this pattern too
// (serialize.ts): one pass, the earlier match first, as Mastodon resolves
// overlaps. A link is the scheme and the URL characters after it (RFC 3986),
// less trailing punctuation; a word character is Ruby's [[:word:]].
const mastodonWord = `\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\x{24B6}-\x{24E9}\x{1F130}-\x{1F149}\x{1F150}-\x{1F169}\x{1F170}-\x{1F189}`
const mastodonHost = `[` + mastodonWord + `\x{06FD}\x{06FE}\x{0F0B}]+`

var mastodonEntity = regexp.MustCompile(`(?i)(https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*[A-Za-z0-9\-_~/#\[@$&(*+=%])|(^|[^=/` + mastodonWord + `])@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)@` + mastodonHost + `(?:[.-]+` + mastodonHost + `)*`)

// mastodonCountable is the text Mastodon counts: each link as 23 characters
// and each remote mention as its local part.
func mastodonCountable(text string) string {
	var out strings.Builder
	last := 0
	for _, m := range mastodonEntity.FindAllStringSubmatchIndex(text, -1) {
		out.WriteString(text[last:m[0]])
		if m[2] >= 0 {
			out.WriteString(strings.Repeat("x", 23))
		} else {
			out.WriteString(text[m[4]:m[5]] + "@" + text[m[6]:m[7]])
		}
		last = m[1]
	}
	out.WriteString(text[last:])
	return out.String()
}

// draftPostLength is a draft post's length on its channel: X's own count on
// X; grapheme clusters on Bluesky, and on Mastodon with each link as 23 and a
// remote mention as its local part; UTF-16 units elsewhere. The composer's
// platformCaptionLength is the same rule; both are tested against
// testdata/caption-length-cases.json.
func draftPostLength(channel, text string) int {
	if channel == "x" {
		return xLength(strings.TrimSpace(text))
	}
	if channel == "mastodon" {
		text = mastodonCountable(text)
	}
	if channel == "bluesky" || channel == "mastodon" {
		return socialidentity.GraphemeLength(text)
	}
	return len(utf16.Encode([]rune(text)))
}
