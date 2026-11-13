package helpers

import (
	"regexp"
	"slices"
	"strconv"
	"strings"

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

// regexp2's IgnoreCase compares Unicode lowercase forms; a JavaScript /i
// regex without u compares uppercase forms and never folds a non-ASCII
// character onto ASCII. jsCaseStandIns maps each BMP unit on which the two
// disagree in the three case-insensitive regexes below to a unit regexp2
// matches as JavaScript matches the original. One unit for one, so indices
// hold. Derived on Node 22 (Unicode 17) by testing every BMP unit against
// each atom of those regexes, new RegExp(atom, 'i') in Node against regexp2
// on the stand-in; redo it when regexp2, Go's Unicode or twitter-text changes.
var jsCaseStandIns = map[rune]rune{
	// Match only where a Latin accent letter does: İ, Ʀ, Ⱥ, Ⱦ, Ʌ, ʀ, ʌ, ⱥ, ⱦ,
	// U+A7DC, and the iotas U+0399, U+03B9 and U+1FBE, which JavaScript folds
	// onto the combining U+0345.
	0x0130: 'À', 0x01a6: 'À', 0x023a: 'À', 0x023e: 'À', 0x0245: 'À', 0x0280: 'À',
	0x028c: 'À', 0x2c65: 'À', 0x2c66: 'À', 0xa7dc: 'À', 0x0399: 'À', 0x03b9: 'À',
	0x1fbe: 'À',
	// The Kelvin and Angstrom signs are no letter at all.
	0x212a: '×', 0x212b: '×',
	// Variant forms JavaScript folds onto the letter of a Greek or Cyrillic TLD.
	0x03f5: 'ε', 0x1c80: 'в', 0x1c81: 'д', 0x1c82: 'о', 0x1c83: 'с', 0x1c84: 'т',
	0x1c85: 'т', 0x1c86: 'ъ', 0x1c87: 'ѣ',
}

var (
	extractURLRe             = jsRegexp(extractURLSource, regexp2.IgnoreCase)
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
	normalized := utf16Units(nfcLikeJS(text))
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

// nfcLikeJS is JavaScript's normalize('NFC'). norm.NFC inserts U+034F after
// 30 combining marks in a row (Unicode's stream-safe format), which also
// keeps the marks after it from reordering or composing with the letter
// before; JavaScript does neither, so such text gets NFC by the book.
func nfcLikeJS(text string) string {
	if out := norm.NFC.String(text); strings.Count(out, norm.GraphemeJoiner) == strings.Count(text, norm.GraphemeJoiner) {
		return out
	}
	ccc := func(r rune) uint8 { return norm.NFD.PropertiesString(string(r)).CCC() }
	var runes []rune
	for _, r := range text {
		runes = append(runes, []rune(norm.NFD.String(string(r)))...)
	}
	// Canonical order: each run of combining marks sorted by class.
	for i := 0; i < len(runes); i++ {
		j := i
		for j < len(runes) && ccc(runes[j]) != 0 {
			j++
		}
		slices.SortStableFunc(runes[i:j], func(a, b rune) int { return int(ccc(a)) - int(ccc(b)) })
		i = j
	}
	// Canonical composition: a character joins the last starter unless a
	// character of class 0, or of its class or higher, stands between them.
	out := runes[:0] // in place: out never passes the rune being read
	starter := -1
	for _, r := range runes {
		class := ccc(r)
		if starter >= 0 && (starter == len(out)-1 || class != 0 && ccc(out[len(out)-1]) < class) {
			if composed := []rune(norm.NFC.String(string([]rune{out[starter], r}))); len(composed) == 1 {
				out[starter] = composed[0]
				continue
			}
		}
		out = append(out, r)
		if class == 0 {
			starter = len(out) - 1
		}
	}
	return string(out)
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
	// Only a link with a protocol counts, and the scan is slow on long runs.
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

	folded := slices.Clone(text)
	for i, c := range folded {
		if standIn, ok := jsCaseStandIns[c]; ok {
			folded[i] = standIn
		}
	}

	var urls []*urlEntity
	for m, _ := extractURLRe.FindRunesMatch(folded); m != nil; m, _ = extractURLRe.FindNextMatch(m) {
		before := m.GroupByNumber(2).Runes()
		url := m.GroupByNumber(3).Runes()
		protocol := m.GroupByNumber(4).Runes()
		domainGroup := m.GroupByNumber(5)
		domain := domainGroup.Runes()
		// JavaScript punycodes and searches the domain as written.
		written := text[domainGroup.Index : domainGroup.Index+domainGroup.Length]
		path := m.GroupByNumber(7).Runes()
		endPosition := m.Index + m.Length
		startPosition := endPosition - len(url)

		protocolLen := len(protocol)
		if protocolLen == 0 {
			protocolLen = len("https://")
		}
		if !isValidTweetURL(url, protocolLen, domain, written) {
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
				asciiDomain := written[am.Index : am.Index+am.Length]
				asciiStartPosition := indexRunes(written, asciiDomain, asciiEndPosition)
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
// domain carries the stand-ins the regexes need; written is the same span
// of the original text, which punycode encodes.
func isValidTweetURL(url []rune, protocolLen int, domain, written []rune) bool {
	if len(domain) >= 4 && string(domain[:4]) == "xn--" {
		// Punycode encoded url cannot contain non ASCII characters
		if ok, _ := validASCIIDomainRe.MatchRunes(domain); !ok {
			return false
		}
	}
	for _, label := range splitRunes(written, func(r rune) bool { return r == '.' }) {
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
