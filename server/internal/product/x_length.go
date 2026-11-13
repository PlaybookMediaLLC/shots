package product

import (
	"context"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// xLinkLength is X's length for one link, whatever its real length.
const xLinkLength = 23

// draftCountBudget is the time one request may spend counting the posts of
// the targets it checks (draftTargetConnections), up to 10 targets of 25 posts
// each. Ordinary posts take milliseconds, and a caption repeated across targets
// or checks is counted once.
const draftCountBudget = 2 * time.Second

type draftCountBudgetKey struct{}

// withDraftCountBudget gives every target check under ctx one shared budget,
// for a request that checks targets more than once.
func withDraftCountBudget(ctx context.Context) context.Context {
	return context.WithValue(ctx, draftCountBudgetKey{}, helpers.NewScanBudget(draftCountBudget))
}

// draftCountBudgetOf is the budget ctx shares, or a new one.
func draftCountBudgetOf(ctx context.Context) *helpers.ScanBudget {
	if budget, ok := ctx.Value(draftCountBudgetKey{}).(*helpers.ScanBudget); ok {
		return budget
	}
	return helpers.NewScanBudget(draftCountBudget)
}

// xLength uses the same twitter-text v3 parser as the X adapter, including
// NFC normalization, bare-domain URLs, and complete emoji sequences.
func xLength(text string, budget *helpers.ScanBudget) (int, error) {
	length, _, err := budget.ParseTweet(text, 280)
	return length, err
}

// fitsXPost reports whether text, plus extra characters, fits in one X post.
// Blank text does not, nor does text too complex to count.
func fitsXPost(text string, extra int, budget *helpers.ScanBudget) bool {
	length, err := xLength(text, budget)
	return strings.TrimSpace(text) != "" && err == nil && length+extra <= 280
}

// rubyWord is Ruby's [[:word:]]: Alphabetic, marks, decimal digits and
// connector punctuation. Alphabetic beyond letters and marks is the letter
// numbers and the circled and squared Latin letters.
const rubyWord = `[\pL\pM\p{Nl}\p{Nd}\p{Pc}\x{24B6}-\x{24E9}\x{1F130}-\x{1F149}\x{1F150}-\x{1F169}\x{1F170}-\x{1F189}]`

var rubyWordRe = regexp.MustCompile(`^` + rubyWord + `$`)

// mastodonMentionRe is Mastodon's Account::MENTION_RE (v4.7) without its
// lookbehind (?<![=/[:word:]]), which RE2 lacks: mastodonLength checks the
// rune before instead.
var mastodonMentionRe = regexp.MustCompile(`(?i)@([a-z0-9_]+(?:[.-]+[a-z0-9_]+)*)(?:@(` + rubyWord + `+(?:[.-]+` + rubyWord + `+)*))?`)

// mastodonMentionEndRe is twitter-text's end_mention_match: an at sign, a
// Latin accent or :// right after a match means it is not a mention.
var mastodonMentionEndRe = regexp.MustCompile(`^(?:[@＠\x{C0}-\x{D6}\x{D8}-\x{F6}\x{F8}-\x{24F}\x{253}\x{254}\x{256}\x{257}\x{259}\x{25B}\x{263}\x{268}\x{26F}\x{272}\x{289}\x{28B}\x{2BB}\x{300}-\x{36F}\x{1E00}-\x{1EFF}]|://)`)

// mastodonLength is Mastodon's StatusLengthValidator: grapheme clusters once
// each link with a protocol is 23 characters and each mention drops its domain.
func mastodonLength(text string, budget *helpers.ScanBudget) (int, error) {
	type entity struct {
		start, end int
		text       string
	}
	var entities []entity
	spans, err := budget.LinkSpans(text)
	if err != nil {
		return 0, err
	}
	for _, span := range spans {
		entities = append(entities, entity{span[0], span[1], strings.Repeat("x", 23)})
	}
	for _, m := range mastodonMentionRe.FindAllStringSubmatchIndex(text, -1) {
		before, _ := utf8.DecodeLastRuneInString(text[:m[0]])
		if before == '=' || before == '/' || rubyWordRe.MatchString(string(before)) ||
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
	return socialidentity.GraphemeLength(countable.String()), nil
}

// draftPostLength is a draft post's length on its channel: X's own count on
// X, Mastodon's on Mastodon, grapheme clusters on Bluesky, and UTF-16 units
// elsewhere. The composer's platformCaptionLength is the same rule; both are
// tested against testdata/caption-length-cases.json. X and Mastodon fail with
// helpers.ErrTextTooComplex on text their scans cannot finish in time, or
// within budget (nil bounds each text alone).
func draftPostLength(channel, text string, budget *helpers.ScanBudget) (int, error) {
	if channel == "x" {
		return xLength(strings.TrimSpace(text), budget)
	}
	if channel == "mastodon" {
		return mastodonLength(text, budget)
	}
	if channel == "bluesky" {
		return socialidentity.GraphemeLength(text), nil
	}
	return len(utf16.Encode([]rune(text))), nil
}
