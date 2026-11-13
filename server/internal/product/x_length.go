package product

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// xLinkLength is X's length for one link, whatever its real length.
const xLinkLength = 23

// xLength uses the same twitter-text v3 parser as the X adapter, including
// NFC normalization, bare-domain URLs, and complete emoji sequences.
func xLength(text string) int {
	return helpers.WeightedLength(text)
}

// mastodonMentionRe is Mastodon's Account::MENTION_RE (v4.7) without its
// lookbehind (?<![=/[:word:]]), which RE2 lacks: mastodonLength checks the
// rune before instead.
var mastodonMentionRe = regexp.MustCompile(`(?i)@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@([\pL\pM\p{Nd}\p{Pc}]+(?:[.-]+[\pL\pM\p{Nd}\p{Pc}]+)*))?`)

// mastodonMentionEndRe is twitter-text's end_mention_match: an at sign, a
// Latin accent or :// right after a match means it is not a mention.
var mastodonMentionEndRe = regexp.MustCompile(`^(?:[@＠\x{C0}-\x{D6}\x{D8}-\x{F6}\x{F8}-\x{24F}\x{253}\x{254}\x{256}\x{257}\x{259}\x{25B}\x{263}\x{268}\x{26F}\x{272}\x{289}\x{28B}\x{2BB}\x{300}-\x{36F}\x{1E00}-\x{1EFF}]|://)`)

// mastodonLength is Mastodon's StatusLengthValidator: grapheme clusters once
// each link with a protocol is 23 characters and each mention drops its domain.
func mastodonLength(text string) int {
	type entity struct {
		start, end int
		text       string
	}
	var entities []entity
	for _, span := range helpers.LinkSpans(text) {
		entities = append(entities, entity{span[0], span[1], strings.Repeat("x", 23)})
	}
	for _, m := range mastodonMentionRe.FindAllStringSubmatchIndex(text, -1) {
		before, _ := utf8.DecodeLastRuneInString(text[:m[0]])
		if before == '=' || before == '/' || unicode.In(before, unicode.L, unicode.M, unicode.Nd, unicode.Pc) ||
			mastodonMentionEndRe.MatchString(text[m[1]:]) ||
			m[4] >= 0 && utf8.RuneCountInString(text[m[4]:m[5]]) > 253 {
			continue
		}
		entities = append(entities, entity{m[0], m[1], text[m[0]:m[3]]})
	}
	slices.SortFunc(entities, func(a, b entity) int { return a.start - b.start })
	var countable strings.Builder
	at := 0
	for _, e := range entities {
		if e.start < at {
			continue // overlaps the entity before, as remove_overlapping_entities drops it
		}
		countable.WriteString(text[at:e.start])
		countable.WriteString(e.text)
		at = e.end
	}
	countable.WriteString(text[at:])
	return socialidentity.GraphemeLength(countable.String())
}

// draftPostLength is a draft post's length on its channel: X's own count on
// X, Mastodon's on Mastodon, grapheme clusters on Bluesky, and UTF-16 units
// elsewhere. The composer's platformCaptionLength is the same rule; both are
// tested against testdata/caption-length-cases.json.
func draftPostLength(channel, text string) int {
	if channel == "x" {
		return xLength(strings.TrimSpace(text))
	}
	if channel == "mastodon" {
		return mastodonLength(text)
	}
	if channel == "bluesky" {
		return socialidentity.GraphemeLength(text)
	}
	return len(utf16.Encode([]rune(text)))
}
