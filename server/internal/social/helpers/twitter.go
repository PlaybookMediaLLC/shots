package helpers

import (
	"errors"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
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

// regexp2 still backtracks badly through a URL path that is a long run of
// parenthesised groups: "https://a.co/" + "(a)" x 8,000 took 7 s. So one call
// of the URL regex gets linkScanBudget, and one text's scan linkScanBudget
// plus linkScanPerUnit for each of its UTF-16 units up to linkScanMaxUnits,
// the longest caption (an X Article); ordinary text uses a small fraction of
// either.
// shortcut: a link whose path is a long run of parenthesised groups cannot be
// counted. Match the path by hand if such links must count.
const (
	linkScanBudget   = 200 * time.Millisecond
	linkScanMaxUnits = 100_000
)

// linkScanPerUnit is a variable only so tests that check what a text counts
// can lift it: a loaded machine can spend a text's budget on work that takes
// a fraction of it unloaded.
var linkScanPerUnit = 20 * time.Microsecond

// ErrTextTooComplex is a text whose links the URL scan could not find within
// its budget. Callers refuse it, since any count would be a guess. It replaces
// regexp2's timeout error, which quotes the whole text.
var ErrTextTooComplex = errors.New("the text is too long or too complex to count its links")

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
	// \G makes an attempt match only at the index it is given.
	extractURLAtRe = jsRegexp(`\G(?:`+extractURLSource+`)`, regexp2.IgnoreCase)
	validTLDAtRe   = jsRegexp(`\G`+validTLDSource(), regexp2.IgnoreCase)
	// validAsciiDomain's label character, cut from its source.
	asciiLabelCharRe         = jsRegexp(`^`+validASCIIDomainSource[len(`(?:(?:`):strings.Index(validASCIIDomainSource, `+)\.)+`)]+`$`, regexp2.IgnoreCase)
	validTcoURLRe            = jsRegexp(validTcoURLSource, regexp2.IgnoreCase)
	invalidURLWithoutProtoRe = jsRegexp(invalidURLWithoutProtocolPrecedingCharsSource, 0)
	invalidCharsRe           = jsRegexp(invalidCharsSource, 0)
	twemojiRe                = jsRegexp(twemojiSource, 0)
)

// Only the URL regex's path backtracks badly, so only it can time out; the
// others are linear and never return an error.
func init() {
	extractURLAtRe.MatchTimeout = linkScanBudget
}

// A ScanBudget is the time one caller may spend counting many texts, such as
// all the posts of a draft: each count gets the time left and is charged what
// it took, a count after the budget is spent fails at once, and a text counted
// again is not counted again. It is not safe for concurrent use. A nil
// *ScanBudget bounds each text on its own.
type ScanBudget struct {
	left   time.Duration
	tweets map[string]tweetCount
	spans  map[string][][2]int
}

// tweetCount is a text's parseTweet without a length limit.
type tweetCount struct {
	weighted int
	valid    bool
}

func NewScanBudget(d time.Duration) *ScanBudget {
	return &ScanBudget{left: d, tweets: map[string]tweetCount{}, spans: map[string][][2]int{}}
}

// spend runs one count within the budget and charges it what it took.
func (b *ScanBudget) spend(count func(deadline time.Time) error) error {
	if b.left <= 0 {
		return ErrTextTooComplex
	}
	start := time.Now()
	err := count(start.Add(b.left))
	b.left -= time.Since(start)
	return err
}

// ParseTweet is twitter-text parseTweet within the budget: text's weighted
// length, and whether it is valid within limit (no invalid characters, and
// 1 to limit weighted).
func (b *ScanBudget) ParseTweet(text string, limit int) (weighted int, valid bool, err error) {
	if b == nil {
		weighted, valid, _, err = parseTweet(text, limit, time.Time{})
		return weighted, valid, err
	}
	count, ok := b.tweets[text]
	if !ok {
		if err := b.spend(func(deadline time.Time) (err error) {
			count.weighted, count.valid, _, err = parseTweet(text, math.MaxInt32, deadline)
			return err
		}); err != nil {
			return 0, false, err
		}
		b.tweets[text] = count
	}
	return count.weighted, count.valid && count.weighted <= limit, nil
}

// TextSlicer returns the slice bounds of text within the length limit (twitter-text for x).
func TextSlicer(integrationType string, end int, text string) (int, int, error) {
	if integrationType != "x" {
		return 0, end, nil
	}
	_, valid, validRangeEnd, err := parseTweet(text, end, time.Time{})
	if err != nil {
		return 0, 0, err
	}
	if valid {
		return 0, end, nil
	}
	return 0, validRangeEnd, nil
}

// WeightedLength is twitter-text parseTweet(text).weightedLength.
func WeightedLength(text string) (int, error) {
	weighted, _, _, err := parseTweet(text, 280, time.Time{})
	return weighted, err
}

// ValidTweetText applies twitter-text's invalid-character and weighted-length
// rules together. Empty text is handled separately by media-only publishers.
func ValidTweetText(text string, limit int) (bool, error) {
	_, valid, _, err := parseTweet(text, limit, time.Time{})
	return valid, err
}

// CountLength counts the length of text for a provider.
func CountLength(integrationType, text string) (int, error) {
	if integrationType == "x" {
		return WeightedLength(text)
	}
	if integrationType == "threads" {
		return len(text), nil // TextEncoder: UTF-8 bytes
	}
	return jsLength(text), nil
}

// parseTweet is twitter-text parseTweet, finding links by deadline when it is set.
func parseTweet(text string, maxWeightedTweetLength int, deadline time.Time) (weightedLength int, valid bool, validRangeEnd int, err error) {
	normalized := utf16Units(nfcLikeJS(text))
	shifted := shiftSurrogates(normalized)

	// Hash all entities by their startIndex for fast lookup
	urls, err := extractURLsWithIndices(shifted, true, deadline)
	if err != nil {
		return 0, false, 0, err
	}
	urlEntities := map[int]int{}
	for _, u := range urls {
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
	return weightedLength, valid, validDisplayIndex, nil
}

// nfcLikeJS is JavaScript's normalize('NFC'). norm.NFC inserts U+034F after
// 30 combining marks in a row (Unicode's stream-safe format), which also
// keeps the marks after it from reordering or composing with the letter
// before; JavaScript does neither, so such text gets NFC by the book.
func nfcLikeJS(text string) string {
	if out := norm.NFC.String(text); strings.Count(out, norm.GraphemeJoiner) == strings.Count(text, norm.GraphemeJoiner) {
		return out
	}
	type unit struct {
		r     rune
		class uint8
	}
	var units []unit
	for _, r := range text {
		for _, d := range norm.NFD.String(string(r)) {
			units = append(units, unit{d, norm.NFD.PropertiesString(string(d)).CCC()})
		}
	}
	// Canonical order: each run of combining marks sorted by class.
	for i := 0; i < len(units); i++ {
		j := i
		for j < len(units) && units[j].class != 0 {
			j++
		}
		slices.SortStableFunc(units[i:j], func(a, b unit) int { return int(a.class) - int(b.class) })
		i = j
	}
	// Canonical composition: a character joins the last starter unless a
	// character of class 0, or of its class or higher, stands between them.
	out := units[:0] // in place: out never passes the unit being read
	starter := -1
	for _, u := range units {
		if starter >= 0 && (starter == len(out)-1 || u.class != 0 && out[len(out)-1].class < u.class) {
			if composed := []rune(norm.NFC.String(string([]rune{out[starter].r, u.r}))); len(composed) == 1 {
				out[starter].r = composed[0]
				continue
			}
		}
		out = append(out, u)
		if u.class == 0 {
			starter = len(out) - 1
		}
	}
	var b strings.Builder
	for _, u := range out {
		b.WriteRune(u.r)
	}
	return b.String()
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
func LinkSpans(text string) ([][2]int, error) { return linkSpans(text, time.Time{}) }

// LinkSpans is the package's LinkSpans within the budget.
func (b *ScanBudget) LinkSpans(text string) ([][2]int, error) {
	if b == nil {
		return linkSpans(text, time.Time{})
	}
	spans, ok := b.spans[text]
	if !ok {
		if err := b.spend(func(deadline time.Time) (err error) {
			spans, err = linkSpans(text, deadline)
			return err
		}); err != nil {
			return nil, err
		}
		b.spans[text] = spans
	}
	return spans, nil
}

func linkSpans(text string, deadline time.Time) ([][2]int, error) {
	// Only a link with a protocol counts.
	if !strings.Contains(text, "://") {
		return nil, nil
	}
	offsets := make([]int, 0, len(text)+1) // the byte offset of each UTF-16 unit
	for i, r := range text {
		offsets = append(offsets, i)
		if r > 0xffff {
			offsets = append(offsets, i)
		}
	}
	offsets = append(offsets, len(text))
	urls, err := extractURLsWithIndices(shiftSurrogates(utf16Units(text)), false, deadline)
	if err != nil {
		return nil, err
	}
	var spans [][2]int
	for _, u := range urls {
		spans = append(spans, [2]int{offsets[u.start], offsets[u.end]})
	}
	return spans, nil
}

// extractURLsWithIndices is twitter-text's extractUrlsWithIndices, on
// surrogate-shifted units. A match never contains ASCII whitespace, which can
// only be its first, preceding character, and always contains a dot. So the
// scan runs word by word, each with the space before it, and skips the words
// with no dot, or, when only links with a protocol count, with no "://": one
// regexp2 call never sees more than one word. It fails with
// ErrTextTooComplex once the text's budget, or limit when it is set and
// sooner, runs out; each call is bounded, but a text of many slow words makes
// many calls.
func extractURLsWithIndices(text []rune, withoutProtocol bool, limit time.Time) ([]*urlEntity, error) {
	deadline := time.Now().Add(linkScanBudget + time.Duration(min(len(text), linkScanMaxUnits))*linkScanPerUnit)
	if !limit.IsZero() && limit.Before(deadline) {
		deadline = limit
	}
	var urls []*urlEntity
	for start, end := 0, 0; start < len(text); start = end {
		for end = start + 1; end < len(text) && !isASCIISpace(text[end]); end++ {
		}
		word := text[start:end]
		if !slices.Contains(word, '.') || !withoutProtocol && indexRunes(word, []rune("://"), 0) < 0 {
			continue
		}
		if time.Now().After(deadline) {
			return nil, ErrTextTooComplex
		}
		found, err := extractWordURLs(word, start, withoutProtocol, deadline)
		if err != nil {
			return nil, err
		}
		urls = append(urls, found...)
	}
	return urls, nil
}

func isASCIISpace(r rune) bool { return r == ' ' || r >= '\t' && r <= '\r' }

// extractWordURLs scans one word that starts at offset in the text.
func extractWordURLs(word []rune, offset int, withoutProtocol bool, deadline time.Time) ([]*urlEntity, error) {
	folded := slices.Clone(word)
	for i, c := range folded {
		if standIn, ok := jsCaseStandIns[c]; ok {
			folded[i] = standIn
		}
	}

	matches, err := urlMatches(folded, deadline)
	if err != nil {
		return nil, err
	}
	var urls []*urlEntity
	for _, m := range matches {
		before := m.GroupByNumber(2).Runes()
		url := m.GroupByNumber(3).Runes()
		protocol := m.GroupByNumber(4).Runes()
		domainGroup := m.GroupByNumber(5)
		domain := domainGroup.Runes()
		// JavaScript punycodes and searches the domain as written.
		written := word[domainGroup.Index : domainGroup.Index+domainGroup.Length]
		path := m.GroupByNumber(7).Runes()
		endPosition := offset + m.Index + m.Length
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
			asciiEnds := asciiDomainEnds(domain)
			for ai := 0; ai < len(domain); ai++ {
				if asciiEnds[ai] < 0 {
					continue
				}
				asciiDomain := written[ai:asciiEnds[ai]]
				ai = asciiEnds[ai] - 1
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
	return urls, nil
}

// urlMatches is extractUrl's matches as its scan from index 0 finds them, but
// tries the regex only where urlEnds says one starts. Scanning from every
// index is quadratic on long runs of letters, which is any CJK text, because
// each start rescans the run.
func urlMatches(text []rune, deadline time.Time) ([]*regexp2.Match, error) {
	ends := urlEnds(text)
	var matches []*regexp2.Match
	for s := 0; s < len(text); s++ {
		end := ends[s]
		if end < 0 {
			continue
		}
		if time.Now().After(deadline) {
			return nil, ErrTextTooComplex
		}
		// Only a port, path or query runs past the domain. Without one the
		// regex need not see the labels after it, which its greedy subdomain
		// loop would otherwise reread for every match in a long chain.
		if end == len(text) || strings.ContainsRune(":/?", text[end]) {
			end = len(text)
		}
		m, err := extractURLAtRe.FindRunesMatchStartingAt(text[:end], s)
		if err != nil {
			return nil, ErrTextTooComplex
		}
		if m != nil {
			matches = append(matches, m)
			s = m.Index + m.Length - 1
		}
	}
	return matches, nil
}

// urlEnds is, at each index, where the domain of extractUrl's match from
// there ends, or -1.
func urlEnds(text []rune) []int {
	domains := domainEnds(text)
	domainAt := func(i int) int {
		if p := protocolLength(text, i); p > 0 && domains[i+p] >= 0 {
			return domains[i+p]
		}
		return domains[i]
	}
	ends := make([]int, len(text))
	for s, c := range text {
		// validUrlPrecedingChars is one character or the start of text.
		ends[s] = -1
		if urlPrecedingChar(c) {
			ends[s] = domainAt(s + 1)
		}
		if ends[s] < 0 && s == 0 {
			ends[s] = domainAt(0)
		}
	}
	return ends
}

// domainEnds is, at each index, where validDomain's match from there ends,
// or -1: labels of domain characters, - and _ that each end in a dot, then a
// TLD. What follows a label's dot does not depend on where the label starts,
// so one right-to-left pass settles each dot once.
func domainEnds(text []rune) []int {
	ends := slices.Repeat([]int{-1}, len(text)+1)
	for dot := len(text) - 1; dot > 0; dot-- {
		if text[dot] != '.' || !domainChar(text[dot-1]) {
			continue
		}
		// The greedy regex takes the label as a subdomain when a domain
		// follows, else as the domain name, which has no _, before a TLD.
		subdomain, name := ends[dot+1], -1
		if subdomain < 0 {
			name = tldEnd(text, dot+1)
		}
		underscore := false
		for x := dot - 1; x >= 0 && (text[x] == '-' || text[x] == '_' || domainChar(text[x])); x-- {
			underscore = underscore || text[x] == '_'
			switch {
			case !domainChar(text[x]):
			case subdomain >= 0:
				ends[x] = subdomain
			case !underscore:
				ends[x] = name
			}
		}
	}
	return ends
}

// asciiDomainEnds is domainEnds for validAsciiDomain, whose labels are any
// run of asciiLabelCharRe characters before a dot, then the same TLDs.
func asciiDomainEnds(text []rune) []int {
	ends := slices.Repeat([]int{-1}, len(text)+1)
	asciiLabelChar := func(c rune) bool { ok, _ := asciiLabelCharRe.MatchRunes([]rune{c}); return ok }
	for dot := len(text) - 1; dot > 0; dot-- {
		if text[dot] != '.' || !asciiLabelChar(text[dot-1]) {
			continue
		}
		end := ends[dot+1]
		if end < 0 {
			end = tldEnd(text, dot+1)
		}
		for x := dot - 1; x >= 0 && asciiLabelChar(text[x]); x-- {
			ends[x] = end
		}
	}
	return ends
}

// tldEnd is where validDomain's TLD from i ends, or -1.
func tldEnd(text []rune, i int) int {
	if m, _ := validTLDAtRe.FindRunesMatchStartingAt(text, i); m != nil {
		return m.Index + m.Length
	}
	return -1
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
// domain carries the stand-ins the regexes need; written is the same span
// of the original text, which punycode encodes.
func isValidTweetURL(url []rune, protocolLen int, domain, written []rune) bool {
	if len(domain) >= 4 && string(domain[:4]) == "xn--" {
		// Punycode encoded url cannot contain non ASCII characters
		if !slices.ContainsFunc(asciiDomainEnds(domain), func(end int) bool { return end >= 0 }) {
			return false
		}
	}
	for _, label := range splitRunes(written, func(r rune) bool { return r == '.' }) {
		// Over 2×63 units are over 63 code points, and punycode spends at
		// least one character on each: don't encode a long CJK run to see.
		if len(label) > 2*63 {
			return false
		}
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
