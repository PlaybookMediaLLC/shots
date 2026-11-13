package helpers

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/dlclark/regexp2"
	"golang.org/x/text/unicode/norm"
)

// twitter-text@3.1.0 parseTweet with the v3 config (the backend passes
// the same values as configs.defaults, only maxWeightedTweetLength varies).
// Everything runs on UTF-16 code units so indices match JavaScript.

const (
	tweetScale                = 100
	tweetDefaultWeight        = 200
	tweetTransformedURLLength = 23
	tweetMaxURLLength         = 4096
	tweetMaxTcoSlugLength     = 40
)

var tweetRanges = []struct{ start, end, weight int }{
	{0, 4351, 100},
	{8192, 8205, 100},
	{8208, 8223, 100},
	{8242, 8247, 100},
}

// regexp2 mangles runs of literal surrogates (`\ud83c\uddfa` never matches)
// and its alternation optimizations then misbehave, so surrogate code units
// are moved to plane 15 (+0xF0000) in both the patterns and the input.
const surrogateShift = 0xf0000

var surrogateEscapeRe = regexp.MustCompile(`\\u[dD][89a-fA-F][0-9a-fA-F]{2}`)

func jsRegexp(source string, opts regexp2.RegexOptions) *regexp2.Regexp {
	source = surrogateEscapeRe.ReplaceAllStringFunc(source, func(escape string) string {
		v, _ := strconv.ParseUint(escape[2:], 16, 32)
		return string(rune(v + surrogateShift))
	})
	return regexp2.MustCompile(source, regexp2.ECMAScript|opts)
}

// shiftSurrogates prepares UTF-16 units for a jsRegexp.
func shiftSurrogates(units []rune) []rune {
	out := make([]rune, len(units))
	for i, c := range units {
		if c >= 0xd800 && c <= 0xdfff {
			c += surrogateShift
		}
		out[i] = c
	}
	return out
}

func unshiftSurrogates(runes []rune) []rune {
	out := make([]rune, len(runes))
	for i, c := range runes {
		if c >= 0xd800+surrogateShift && c <= 0xdfff+surrogateShift {
			c -= surrogateShift
		}
		out[i] = c
	}
	return out
}

var (
	// \G makes an attempt match only at the index it is given.
	extractURLAtRe           = jsRegexp(`\G(?:`+extractURLSource+`)`, regexp2.IgnoreCase)
	validTLDAtRe             = jsRegexp(`\G`+validTLDSource(), regexp2.IgnoreCase)
	validASCIIDomainRe       = jsRegexp(validASCIIDomainSource, regexp2.IgnoreCase)
	validTcoURLRe            = jsRegexp(validTcoURLSource, regexp2.IgnoreCase)
	invalidURLWithoutProtoRe = jsRegexp(invalidURLWithoutProtocolPrecedingCharsSource, 0)
	invalidCharsRe           = jsRegexp(invalidCharsSource, 0)
	twemojiRe                = jsRegexp(twemojiSource, 0)
)

// TextSlicer returns the slice bounds of text within the length limit (twitter-text for x).
func TextSlicer(integrationType string, end int, text string) (int, int) {
	if integrationType != "x" {
		return 0, end
	}
	_, valid, validRangeEnd := parseTweet(text, end)
	if valid {
		return 0, end
	}
	return 0, validRangeEnd
}

// WeightedLength is twitter-text parseTweet(text).weightedLength.
func WeightedLength(text string) int {
	weighted, _, _ := parseTweet(text, 280)
	return weighted
}

// ValidTweetText applies twitter-text's invalid-character and weighted-length
// rules together. Empty text is handled separately by media-only publishers.
func ValidTweetText(text string, limit int) bool {
	_, valid, _ := parseTweet(text, limit)
	return valid
}

// CountLength counts the length of text for a provider.
func CountLength(integrationType, text string) int {
	if integrationType == "x" {
		return WeightedLength(text)
	}
	if integrationType == "threads" {
		return len(text) // TextEncoder: UTF-8 bytes
	}
	return jsLength(text)
}

func parseTweet(text string, maxWeightedTweetLength int) (weightedLength int, valid bool, validRangeEnd int) {
	normalized := utf16Units(norm.NFC.String(text))
	shifted := shiftSurrogates(normalized)

	// Hash all entities by their startIndex for fast lookup
	urlEntities := map[int]int{}
	for _, u := range extractURLsWithIndices(shifted, true) {
		urlEntities[u.start] = len(u.url)
	}
	emojiEntities := map[int]int{}
	for m, _ := twemojiRe.FindRunesMatch(shifted); m != nil; m, _ = twemojiRe.FindNextMatch(m) {
		emojiEntities[m.Index] = m.Length
	}

	weighted := 0
	validDisplayIndex := 0
	valid = true
	for charIndex := 0; charIndex < len(normalized); charIndex++ {
		if urlLen, ok := urlEntities[charIndex]; ok {
			weighted += tweetTransformedURLLength * tweetScale
			charIndex += urlLen - 1
		} else if emojiLen, ok := emojiEntities[charIndex]; ok {
			weighted += tweetDefaultWeight
			charIndex += emojiLen - 1
		} else {
			if isSurrogatePair(normalized, charIndex) {
				charIndex++
			}
			weighted += characterWeight(normalized[charIndex])
		}

		// Only test for validity of character if it is still valid
		if valid && charIndex < len(normalized) {
			ok, _ := invalidCharsRe.MatchRunes(shifted[charIndex : charIndex+1])
			valid = !ok
		}
		if valid && weighted <= maxWeightedTweetLength*tweetScale {
			validDisplayIndex = charIndex
		}
	}

	weightedLength = weighted / tweetScale
	valid = valid && weightedLength > 0 && weightedLength <= maxWeightedTweetLength
	validDisplayIndex += jsLength(text) - len(normalized)
	return weightedLength, valid, validDisplayIndex
}

func isSurrogatePair(text []rune, i int) bool {
	if i < len(text)-1 {
		c, next := text[i], text[i+1]
		return 0xd800 <= c && c <= 0xdbff && 0xdc00 <= next && next <= 0xdfff
	}
	return false
}

func characterWeight(unit rune) int {
	for _, r := range tweetRanges {
		if int(unit) >= r.start && int(unit) <= r.end {
			return r.weight
		}
	}
	return tweetDefaultWeight
}

type urlEntity struct {
	url        []rune
	start, end int
}

// LinkSpans are the byte ranges of the links in text that start with a
// protocol: twitter-text's extractUrlsWithIndices with
// extractUrlsWithoutProtocol: false, as Mastodon finds the links it counts.
func LinkSpans(text string) [][2]int {
	// Only a link with a protocol counts.
	if !strings.Contains(text, "://") {
		return nil
	}
	offsets := make([]int, 0, len(text)+1) // the byte offset of each UTF-16 unit
	for i, r := range text {
		offsets = append(offsets, i)
		if r > 0xffff {
			offsets = append(offsets, i)
		}
	}
	offsets = append(offsets, len(text))
	var spans [][2]int
	for _, u := range extractURLsWithIndices(shiftSurrogates(utf16Units(text)), false) {
		spans = append(spans, [2]int{offsets[u.start], offsets[u.end]})
	}
	return spans
}

// extractURLsWithIndices is twitter-text's extractUrlsWithIndices, on
// surrogate-shifted units.
func extractURLsWithIndices(text []rune, withoutProtocol bool) []*urlEntity {
	if !slices.Contains(text, '.') {
		return nil
	}

	var urls []*urlEntity
	for _, m := range urlMatches(text) {
		before := m.GroupByNumber(2).Runes()
		url := m.GroupByNumber(3).Runes()
		protocol := m.GroupByNumber(4).Runes()
		domain := m.GroupByNumber(5).Runes()
		path := m.GroupByNumber(7).Runes()
		endPosition := m.Index + m.Length
		startPosition := endPosition - len(url)

		protocolLen := len(protocol)
		if protocolLen == 0 {
			protocolLen = len("https://")
		}
		if !isValidTweetURL(url, protocolLen, domain) {
			continue
		}

		// extract ASCII-only domains.
		if len(protocol) == 0 {
			if !withoutProtocol {
				continue
			}
			if ok, _ := invalidURLWithoutProtoRe.MatchRunes(before); ok {
				continue
			}

			var lastURL *urlEntity
			asciiEndPosition := 0
			for am, _ := validASCIIDomainRe.FindRunesMatch(domain); am != nil; am, _ = validASCIIDomainRe.FindNextMatch(am) {
				asciiDomain := am.Runes()
				asciiStartPosition := indexRunes(domain, asciiDomain, asciiEndPosition)
				asciiEndPosition = asciiStartPosition + len(asciiDomain)
				lastURL = &urlEntity{
					url:   asciiDomain,
					start: startPosition + asciiStartPosition,
					end:   startPosition + asciiEndPosition,
				}
				urls = append(urls, lastURL)
			}

			// no ASCII-only domain found. Skip the entire URL.
			if lastURL == nil {
				continue
			}

			// lastUrl only contains domain. Need to add path and query if they exist.
			if len(path) > 0 {
				if i := indexRunes(url, domain, 0); i >= 0 {
					lastURL.url = slices.Concat(url[:i], lastURL.url, url[i+len(domain):])
				}
				lastURL.end = endPosition
			}
			continue
		}

		// In the case of t.co URLs, don't allow additional path characters.
		if tm, _ := validTcoURLRe.FindRunesMatch(url); tm != nil {
			if len(tm.GroupByNumber(1).Runes()) > tweetMaxTcoSlugLength {
				continue
			}
			url = tm.Runes()
			endPosition = startPosition + len(url)
		}
		urls = append(urls, &urlEntity{url: url, start: startPosition, end: endPosition})
	}
	return urls
}

// urlMatches is extractUrl's matches as its scan from index 0 finds them, but
// tries the regex only where urlStarts says one starts. Scanning from every
// index is quadratic on long runs of letters, which is any CJK text, because
// each start rescans the run.
func urlMatches(text []rune) []*regexp2.Match {
	starts := urlStarts(text)
	var matches []*regexp2.Match
	for s := 0; s < len(text); s++ {
		if !starts[s] {
			continue
		}
		if m, _ := extractURLAtRe.FindRunesMatchStartingAt(text, s); m != nil {
			matches = append(matches, m)
			s = m.Index + m.Length - 1
		}
	}
	return matches
}

// urlStarts reports at each index whether extractUrl matches from there.
func urlStarts(text []rune) []bool {
	domains := domainStarts(text)
	domainAt := func(i int) bool { return domains[i] || domains[i+protocolLength(text, i)] }
	starts := make([]bool, len(text))
	for s, c := range text {
		// validUrlPrecedingChars is one character or the start of text.
		starts[s] = urlPrecedingChar(c) && domainAt(s+1) || s == 0 && domainAt(0)
	}
	return starts
}

// domainStarts reports at each index whether validDomain matches there:
// labels of domain characters, - and _ that each end in a dot, then a TLD.
// What follows a label's dot does not depend on where the label starts, so
// one right-to-left pass settles each dot once.
func domainStarts(text []rune) []bool {
	starts := make([]bool, len(text)+1)
	for dot := len(text) - 1; dot > 0; dot-- {
		if text[dot] != '.' || !domainChar(text[dot-1]) {
			continue
		}
		// The label is a subdomain when a domain follows, or the domain name,
		// which has no _, when a TLD follows.
		subdomain, name := starts[dot+1], false
		if !subdomain {
			m, _ := validTLDAtRe.FindRunesMatchStartingAt(text, dot+1)
			name = m != nil
		}
		underscore := false
		for x := dot - 1; x >= 0 && (text[x] == '-' || text[x] == '_' || domainChar(text[x])); x-- {
			underscore = underscore || text[x] == '_'
			starts[x] = domainChar(text[x]) && (subdomain || name && !underscore)
		}
	}
	return starts
}

// notDomainChars is what validDomainChars excludes: ASCII punctuation but
// " and `, spaces, the invalid characters and the directional marks.
const notDomainChars = "\t\n\v\f\r !#$%&'()*+,-./:;<=>?@[\\]^_{|}~\u0085\u00a0\u061c\u1680\u180e" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u200e\u200f\u2028\u2029" +
	"\u202a\u202b\u202c\u202d\u202e\u202f\u205f\u2066\u2067\u2068\u2069\u3000\ufeff\ufffe\uffff"

func domainChar(c rune) bool { return !strings.ContainsRune(notDomainChars, c) }

// urlPrecedingChar is validUrlPrecedingChars' character class as regexp2's
// IgnoreCase reads it: on the lowercased character.
func urlPrecedingChar(c rune) bool {
	c = unicode.ToLower(c)
	return !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.ContainsRune("@$#\uff20\uff03\ufeff\ufffe\uffff", c))
}

// protocolLength is the length of the https?:// extractUrl reads at i, or 0.
func protocolLength(text []rune, i int) int {
next:
	for _, protocol := range [...]string{"https://", "http://"} {
		if i+len(protocol) > len(text) {
			continue
		}
		for j := range len(protocol) {
			if unicode.ToLower(text[i+j]) != rune(protocol[j]) {
				continue next
			}
		}
		return len(protocol)
	}
	return 0
}

// validTLDSource is validDomain's TLD alternatives, cut from extractURLSource
// after the last label's dot.
func validTLDSource() string {
	const lastLabelEnd, tldEnd = `\.)(?:(?:(?:`, `|(?:xn--[\-0-9a-z]+))`
	start, end := strings.Index(extractURLSource, lastLabelEnd), strings.Index(extractURLSource, tldEnd)
	if start < 0 || end < start {
		panic("twitter-text: no TLD alternatives in extractURLSource")
	}
	return extractURLSource[start+len(`\.)`) : end+len(tldEnd)]
}

func indexRunes(s, sub []rune, from int) int {
	for i := from; i+len(sub) <= len(s); i++ {
		if slices.Equal(s[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// isValidTweetURL is extractUrlsWithIndices' isValidUrl. twitter-text's
// idna.toAscii returns the domain unchanged when every label punycodes to
// 1..63 characters, so only the label check and the total length matter.
func isValidTweetURL(url []rune, protocolLen int, domain []rune) bool {
	if len(domain) >= 4 && string(domain[:4]) == "xn--" {
		// Punycode encoded url cannot contain non ASCII characters
		if ok, _ := validASCIIDomainRe.MatchRunes(domain); !ok {
			return false
		}
	}
	for _, label := range splitRunes(domain, func(r rune) bool { return r == '.' }) {
		if n := punycodeToASCIILength(unshiftSurrogates(label)); n < 1 || n > 63 {
			return false
		}
	}
	return protocolLen+len(url) <= tweetMaxURLLength
}

func splitRunes(s []rune, sep func(rune) bool) [][]rune {
	var out [][]rune
	start := 0
	for i, r := range s {
		if sep(r) {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// punycodeToASCIILength is len(punycode@1.4.1 toASCII(label)) for UTF-16 units.
func punycodeToASCIILength(label []rune) int {
	parts := splitRunes(label, func(r rune) bool { return r == '.' || r == 0x3002 || r == 0xff0e || r == 0xff61 })
	total := len(parts) - 1
	for _, part := range parts {
		nonASCII := slices.ContainsFunc(part, func(r rune) bool { return r < 0x20 || r > 0x7e })
		if !nonASCII {
			total += len(part)
			continue
		}
		total += 4 + len(punycodeEncode(ucs2Decode(part)))
	}
	return total
}

// ucs2Decode combines surrogate pairs into code points (lone ones stay).
func ucs2Decode(units []rune) []rune {
	out := make([]rune, 0, len(units))
	for i := 0; i < len(units); i++ {
		if isSurrogatePair(units, i) {
			out = append(out, (units[i]-0xd800)<<10+(units[i+1]-0xdc00)+0x10000)
			i++
			continue
		}
		out = append(out, units[i])
	}
	return out
}

// punycodeEncode is RFC 3492 encode (punycode.js encode).
func punycodeEncode(input []rune) string {
	const (
		base        = 36
		tMin        = 1
		tMax        = 26
		skew        = 38
		damp        = 700
		initialBias = 72
		initialN    = 128
	)
	digit := func(d int) byte {
		if d < 26 {
			return byte('a' + d)
		}
		return byte('0' + d - 26)
	}
	adapt := func(delta, numPoints int, first bool) int {
		if first {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / numPoints
		k := 0
		for delta > ((base-tMin)*tMax)/2 {
			delta /= base - tMin
			k += base
		}
		return k + (base-tMin+1)*delta/(delta+skew)
	}

	var out []byte
	for _, r := range input {
		if r < 0x80 {
			out = append(out, byte(r))
		}
	}
	basicLength := len(out)
	handled := basicLength
	if basicLength > 0 {
		out = append(out, '-')
	}

	n, delta, bias := initialN, 0, initialBias
	for handled < len(input) {
		m := int(^uint(0) >> 1)
		for _, r := range input {
			if int(r) >= n && int(r) < m {
				m = int(r)
			}
		}
		delta += (m - n) * (handled + 1)
		n = m
		for _, r := range input {
			if int(r) < n {
				delta++
			}
			if int(r) == n {
				q := delta
				for k := base; ; k += base {
					t := k - bias
					if k <= bias {
						t = tMin
					} else if k >= bias+tMax {
						t = tMax
					}
					if q < t {
						break
					}
					out = append(out, digit(t+(q-t)%(base-t)))
					q = (q - t) / (base - t)
				}
				out = append(out, digit(q))
				bias = adapt(delta, handled+1, handled == basicLength)
				delta = 0
				handled++
			}
		}
		delta++
		n++
	}
	return string(out)
}
