package helpers

import (
	"regexp"
	"strings"
	"time"
)

var (
	xHasEditorHTMLTagRe = regexp.MustCompile(`(?i)</?(?:p|div|br|a|strong|em|b|i|u|span|ul|ol|li|h[1-6]|blockquote)(?:[\s>/]|$)`)
	xMarkdownLinkRe     = regexp.MustCompile(`\[([^\]\n]*)\]\(([^)\s]+)\)`)
	xLeadingSpaceRe     = regexp.MustCompile(`\n[ \t]+`)
	xTrailingSpaceRe    = regexp.MustCompile(`[ \t]+\n`)
	xMultiNewlineRe     = regexp.MustCompile(`\n{3,}`)
	xHorizontalRunsRe   = regexp.MustCompile(`[ \t]{2,}`)
)

// XLinkSpans returns the UTF-8 byte ranges of every URL in text that X
// linkifies into a t.co entity (both scheme'd URLs and bare domains with any
// valid IANA TLD), using twitter-text@3.1.0's canonical extractor.
func XLinkSpans(text string) ([][2]int, error) {
	return xLinkSpans(text, time.Time{})
}

func xLinkSpans(text string, deadline time.Time) ([][2]int, error) {
	if !strings.ContainsRune(text, '.') {
		return nil, nil
	}
	urls, err := extractURLsWithIndices(shiftSurrogates(utf16Units(text)), true, deadline)
	if err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return nil, nil
	}
	offsets := make([]int, 0, len(text)+1)
	for i, r := range text {
		offsets = append(offsets, i)
		if r > 0xffff {
			offsets = append(offsets, i)
		}
	}
	offsets = append(offsets, len(text))
	spans := make([][2]int, 0, len(urls))
	for _, u := range urls {
		if u.start < 0 || u.end > len(offsets)-1 || u.start >= u.end {
			continue
		}
		spans = append(spans, [2]int{offsets[u.start], offsets[u.end]})
	}
	return spans, nil
}

// FlattenXTweetText normalizes editor HTML to the plain tweet text X receives,
// shared with x.Provider's toTweetText so link inspection sees the exact
// outbound text without corrupting plain text angle brackets like "<Button>".
func FlattenXTweetText(message string) string {
	if !xHasEditorHTMLTagRe.MatchString(message) {
		return StripHTMLValidation("normal", message, StripOptions{
			ReplaceBold: true,
			Plain:       true,
		})
	}
	input := message
	if !hasPRe.MatchString(input) {
		input = "<p>" + input + "</p>"
	}
	return StripHTMLValidation("normal", input, StripOptions{
		ReplaceBold: true,
		Plain:       false,
	})
}

// InspectXLinks reports how many X-linkified URLs appear in message after
// flattening to plain tweet text. Propagates ErrTextTooComplex when the scan
// exceeds its CPU budget.
func InspectXLinks(message string) (int, error) {
	spans, err := XLinkSpans(FlattenXTweetText(message))
	if err != nil {
		return 0, err
	}
	return len(spans), nil
}

// StripXLinkSpans removes URLs from already-flattened plain text using
// precomputed spans (and cleans markdown link syntax like [label](url)),
// returning the cleaned text and total removed link count.
func StripXLinkSpans(plain string, spans [][2]int) (string, int) {
	if len(spans) == 0 {
		return plain, 0
	}
	removed := 0
	// First unwrap markdown links [label](url) whose target is a URL so we
	// don't leave dangling "[label]()" or "[]()".
	unwrapped := xMarkdownLinkRe.ReplaceAllStringFunc(plain, func(match string) string {
		parts := xMarkdownLinkRe.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		label, target := parts[1], parts[2]
		targetSpans, err := XLinkSpans(target)
		if err != nil || len(targetSpans) == 0 {
			return match
		}
		removed += len(targetSpans)
		return label
	})
	if removed > 0 {
		var err error
		spans, err = XLinkSpans(unwrapped)
		if err != nil || len(spans) == 0 {
			return cleanStrippedXText(unwrapped), removed
		}
		plain = unwrapped
	}
	var b strings.Builder
	b.Grow(len(plain))
	cursor := 0
	for _, span := range spans {
		if span[0] < cursor {
			continue
		}
		b.WriteString(plain[cursor:span[0]])
		cursor = span[1]
		removed++
	}
	b.WriteString(plain[cursor:])
	return cleanStrippedXText(b.String()), removed
}

// StripXLinks removes every URL that X would linkify into a t.co entity from
// message (flattening HTML if present), tidies leftover whitespace and blank
// lines, and returns the cleaned text and count of removed links.
// Emails (user@example.com), @mentions, #hashtags, and $CASHTAGS are preserved.
func StripXLinks(message string) (string, int, error) {
	plain := FlattenXTweetText(message)
	spans, err := XLinkSpans(plain)
	if err != nil {
		return "", 0, err
	}
	cleaned, removed := StripXLinkSpans(plain, spans)
	return cleaned, removed, nil
}

func cleanStrippedXText(text string) string {
	text = xHorizontalRunsRe.ReplaceAllLiteralString(text, " ")
	text = xTrailingSpaceRe.ReplaceAllLiteralString(text, "\n")
	text = xLeadingSpaceRe.ReplaceAllLiteralString(text, "\n")
	text = xMultiNewlineRe.ReplaceAllLiteralString(text, "\n\n")
	return jsTrim(text)
}
