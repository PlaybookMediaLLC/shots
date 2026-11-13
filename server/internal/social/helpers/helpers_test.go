package helpers

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dlclark/regexp2"
)

// Readable spot checks; the exhaustive comparison against the npm packages
// lives in reference_test.go.

func TestStripHTMLValidationModes(t *testing.T) {
	cases := []struct {
		name, editor, in string
		opts             StripOptions
		want             string
	}{
		{"normal", "normal", `<p>Hello <strong>world</strong></p><p>a &amp; b</p>`, StripOptions{}, "Hello world\na & b"},
		{"normal replaceBold", "normal", `<p>Hi <strong>Bold 1</strong> <u>und</u></p><ul><li><p>one</p></li></ul>`,
			StripOptions{ReplaceBold: true}, "Hi 𝗕𝗼𝗹𝗱 𝟭 u̲n̲d̲\n- one\n"},
		{"normal none", "normal", `<p>a &lt;b&gt;</p><p>c</p>`, StripOptions{None: true}, "a <b>\nc"},
		{"normal without p is serialized only", "normal", `a & <b>x</b>`, StripOptions{}, "a &amp; <b>x</b>"},
		{"markdown", "markdown", `<h1>T</h1><p><strong>b</strong> <a href="https://a.com">l</a></p><ul><li><p>x</p></li></ul>`,
			StripOptions{}, "# T\n**b** [l](https://a.com)\n- x\n"},
		{"html mentions and inline images", "html",
			`<p>Hi <span data-mention-id="42" data-mention-label="ann">@ann</span></p><img src="https://i.co/a.png" alt="p"><img src="data:x">`,
			StripOptions{ConvertMention: testMention, InlineImages: true}, `<p>Hi @[@ann](42)</p><img src="https://i.co/a.png" alt="p">`},
		{"none", "none", `<p>Hi&nbsp;<strong>you</strong> &lt;3</p>`, StripOptions{}, "Hi you <3"},
		{"plain", "normal", `<p>raw</p>`, StripOptions{Plain: true}, "<p>raw</p>"},
	}
	for _, c := range cases {
		if got := StripHTMLValidation(c.editor, c.in, c.opts); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestStripTagsAllowed(t *testing.T) {
	if got := StripTags(`<p>a <b>b</b> <a href="x>y">c</a><!-- x --></p>`, []string{"a"}); got != `a b <a href="xy">c</a>` { // quoted '>' is dropped, as striptags does
		t.Errorf("got %q", got)
	}
}

func TestWeightedLength(t *testing.T) {
	cases := map[string]int{
		"hello":                            5,
		"日本語":                              6,  // CJK weighs 2
		"😀👍🏽":                              4,  // emoji sequences weigh 2 each
		"go to https://sample.com/a/b now": 33, // URLs count as 23
		"see sample.com":                   27, // bare domains too
		"mail a@sample.com":                17, // not emails
		"é.com x":                          25, // a domain from the start of text
		"https://a.co/" + strings.Repeat("(a)", 1000): 23, // a path of parenthesised groups
	}
	for in, want := range cases {
		if got, err := WeightedLength(in); err != nil || got != want {
			t.Errorf("WeightedLength(%q) = %d, %v, want %d", in, got, err, want)
		}
	}
	if start, end, err := TextSlicer("x", 5, "日本語日本語"); err != nil || start != 0 || end != 1 {
		t.Errorf("TextSlicer = %d,%d, %v", start, end, err)
	}
	if got, err := CountLength("threads", "é😀"); err != nil || got != 6 {
		t.Errorf("threads counts UTF-8 bytes, got %d, %v", got, err)
	}
	if got, err := CountLength("linkedin", "é😀"); err != nil || got != 3 {
		t.Errorf("others count UTF-16 units, got %d, %v", got, err)
	}
}

// regexp2 backtracked quadratically through domain-like words and through a
// URL path of parenthesised groups: "(a)" took 7 s and "((a))" 42 s. Both
// count now.
func TestLinkScanStopsOnCraftedText(t *testing.T) {
	scans := map[string]func(string) error{
		"WeightedLength": func(text string) error { _, err := WeightedLength(text); return err },
		"LinkSpans":      func(text string) error { _, err := LinkSpans(text); return err },
	}
	texts := map[string]string{
		"a.":         strings.Repeat("a.", 5000),
		"https://a.": "https://" + strings.Repeat("a.", 5000),
		"many words": strings.Repeat(" https://"+strings.Repeat("a.", 25), 200),
		"(a)":        "https://a.co/" + strings.Repeat("(a)", 8000),
		"((a))":      "https://a.co/" + strings.Repeat("((a))", 19000),
		// Too long to be a link: its ASCII domains, a TLD regex per dot, are not read.
		"xn--": "xn--a." + strings.Repeat("日a.", 50000) + "com",
	}
	for name, text := range texts {
		for scan, run := range scans {
			start := time.Now()
			err := run(text)
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Errorf("%s(%s) took %v", scan, name, elapsed)
			}
			if err != nil {
				t.Errorf("%s(%s) error = %v", scan, name, err)
			}
		}
	}
}

// A text longer than any caption gets no more time than the longest one: 1 MiB
// of slow words took 21 s while the budget grew with length.
func TestLinkScanBudgetStopsGrowingPastTheLongestCaption(t *testing.T) {
	text := strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59)
	start := time.Now()
	if _, err := WeightedLength(text); !errors.Is(err, ErrTextTooComplex) {
		t.Fatalf("WeightedLength error = %v", err)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Errorf("took %v, want about the 2.2 s budget of a 100,000-unit text", elapsed)
	}
}

// Within one word the scan checks its budget before each dot's TLD regex and
// before each match's ASCII domains, a TLD regex per dot again: a long dotted
// word, or a word of many bare domains, took over a second whatever the budget.
func TestLinkScanStopsWithinAWord(t *testing.T) {
	for name, text := range map[string]string{
		"dotted word":  strings.Repeat("a.", 50000),
		"bare domains": strings.Repeat(strings.Repeat("日a.", 1300)+"com(", 25),
	} {
		start := time.Now()
		if _, _, err := NewScanBudget(100*time.Millisecond).ParseTweet(text, 280); !errors.Is(err, ErrTextTooComplex) {
			t.Errorf("%s: error = %v", name, err)
		}
		if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
			t.Errorf("%s took %v of a 100 ms budget", name, elapsed)
		}
	}
}

// Mastodon counts only links with a protocol, so a dotted word without one is
// not scanned and cannot exhaust the budget.
func TestLinkSpansSkipsWordsWithoutAProtocol(t *testing.T) {
	text := "Docs at https://example.com and " + strings.Repeat("a.", 1000)
	spans, err := LinkSpans(text)
	if err != nil || len(spans) != 1 || text[spans[0][0]:spans[0][1]] != "https://example.com" {
		t.Fatalf("LinkSpans = %v, %v", spans, err)
	}
}

// One request's texts share its budget: once crafted texts spend it, the next
// scans stop at once, while a text counted before is not scanned again.
func TestScanBudgetIsSharedAcrossTexts(t *testing.T) {
	budget := NewScanBudget(500 * time.Millisecond)
	if spans, err := budget.LinkSpans("see https://example.com"); err != nil || len(spans) != 1 {
		t.Fatalf("before = %v, %v", spans, err)
	}
	words := strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59) // seconds unbounded
	start := time.Now()
	for i := range 20 {
		crafted := fmt.Sprintf("%d%s", i, words)
		if _, _, err := budget.ParseTweet(crafted, 280); !errors.Is(err, ErrTextTooComplex) {
			t.Fatalf("crafted %d: %v", i, err)
		}
	}
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Errorf("20 crafted texts took %v of a 500 ms budget", elapsed)
	}
	if spans, err := budget.LinkSpans("see https://example.com"); err != nil || len(spans) != 1 {
		t.Fatalf("after = %v, %v", spans, err)
	}
	// X counts bare domains, Mastodon does not: their scans are remembered apart.
	both := NewScanBudget(time.Second)
	if spans, err := both.LinkSpans("https://a.com b.com"); err != nil || len(spans) != 1 {
		t.Fatalf("spans = %v, %v", spans, err)
	}
	if weighted, _, err := both.ParseTweet("https://a.com b.com", 280); err != nil || weighted != 47 {
		t.Fatalf("weighted = %d, %v", weighted, err)
	}
}

// An X Article may weigh 100,000; dotted words and links throughout must not
// exhaust the budget.
func TestLinkScanCountsALongArticle(t *testing.T) {
	paragraph := "Version 2.4 ships today. See https://example.com/notes and docs.example.com for details, e.g. the new API.\n"
	article := strings.Repeat(paragraph, 850) // 90,950 characters weighing 95,200
	if valid, err := ValidTweetText(article, 100000); err != nil || !valid {
		t.Fatalf("ValidTweetText(article) = %v, %v", valid, err)
	}
}

// urlMatches must find what scanning the URL regex from every index finds.
func TestURLMatchesAreTheFullScans(t *testing.T) {
	// The classes urlMatches reads without the regex, as extractUrl spells them.
	class := func(source string) func(rune) bool {
		if !strings.Contains(extractURLSource, source) {
			t.Fatalf("extractUrl has no %s", source)
		}
		re := jsRegexp(`^`+source+`$`, regexp2.IgnoreCase)
		return func(c rune) bool { ok, _ := re.MatchRunes([]rune{c}); return ok }
	}
	domain := class(`[^/\!'#%&'\(\)*\+,\\\-\.\/:;<=>\?@\[\]\^_{|}~\$//\x09-\x0D\x20\x85\xA0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000//\uFFFE\uFEFF\uFFFF//\u202A-\u202E\u061C\u200E\u200F\u2066\u2067\u2068\u2069/]`)
	preceding := class(`[^A-Za-z0-9@\uff20$#\uff03\uFFFE\uFEFF\uFFFF]`)
	directional := class(`[\u202A-\u202E\u061C\u200E\u200F\u2066\u2067\u2068\u2069]`)
	const latinAccent = `\xC0-\xD6\xD8-\xF6\xF8-\xFF\u0100-\u024F\u0253\u0254\u0256\u0257\u0259\u025B\u0263\u0268\u026F\u0272\u0289\u028B\u02BB\u0300-\u036F\u1E00-\u1EFF`
	pathChar := class(`[a-z\u0400-\u04FF0-9!\*';:=\+,\.\$\/%#\[\]\-\u2013_~@\|&` + latinAccent + `]`)
	pathEndingChar := class(`[\+\-a-z\u0400-\u04FF0-9=_#\/` + latinAccent + `]`)
	queryChar := class(`[a-z0-9!?\*'@\(\);:&=\+\$\/%#\[\]\-_\.,~|]`)
	queryEndingChar := class(`[a-z0-9\-_&=#\/]`)
	for unit := rune(0); unit <= 0xffff; unit++ {
		c := unit
		if 0xd800 <= c && c <= 0xdfff {
			c += surrogateShift
		}
		if domainChar(c) != domain(c) {
			t.Errorf("domainChar(%U) = %v", c, domainChar(c))
		}
		if urlPrecedingChar(c) != (preceding(c) || directional(c)) {
			t.Errorf("urlPrecedingChar(%U) = %v", c, urlPrecedingChar(c))
		}
		if urlPathChar(c) != pathChar(c) || urlPathEndingChar(c) != pathEndingChar(c) {
			t.Errorf("urlPathChar(%U) = %v, urlPathEndingChar = %v", c, urlPathChar(c), urlPathEndingChar(c))
		}
		if urlQueryChar(c) != queryChar(c) || urlQueryEndingChar(c) != queryEndingChar(c) {
			t.Errorf("urlQueryChar(%U) = %v, urlQueryEndingChar = %v", c, urlQueryChar(c), urlQueryEndingChar(c))
		}
	}

	full := jsRegexp(extractURLSource, regexp2.IgnoreCase)
	asciiDomainAt := jsRegexp(`\G(?:`+validASCIIDomainSource+`)`, regexp2.IgnoreCase)
	if !strings.HasSuffix(validASCIIDomainSource, validTLDSource()) {
		t.Fatal("validAsciiDomain's TLDs are not validDomain's")
	}
	// matchEnd is where group of re's match at s ends, or -1.
	matchEnd := func(re *regexp2.Regexp, text []rune, s, group int) int {
		m, _ := re.FindRunesMatchStartingAt(text, s)
		if m == nil {
			return -1
		}
		return m.GroupByNumber(group).Index + m.GroupByNumber(group).Length
	}
	// validUrlPath, from its slash to the query.
	pathAt := jsRegexp(`\G`+extractURLSource[strings.Index(extractURLSource, `(\/(?:(?:`):strings.Index(extractURLSource, `(\?[`)], regexp2.IgnoreCase)
	// describe is a match from its start to its end, with its groups before
	// the path and its path; the query is what is left.
	describe := func(m *regexp2.Match, end int, path []rune) string {
		var b strings.Builder
		fmt.Fprintf(&b, "%d-%d ", m.Index, end)
		for _, g := range []int{2, 4, 5, 6} {
			fmt.Fprintf(&b, "%d+%d ", m.GroupByNumber(g).Index, m.GroupByNumber(g).Length)
		}
		return fmt.Sprintf("%s%q", b.String(), string(path))
	}
	tokens := []string{"a", "Z", "7", "日", "日本", "_", "-", ".", ".", " ", "/", "/", ":", ":80", "@", "＠", "#", "(", "(a)", "((a))", ")", "?x=1", "?", ".co/",
		"!", "~", "'", "=", "+", "&", "ж", "Ж", "é", "É", "\u0193", "\u2013",
		"http://", "HTTPS://", "https:/", "ttps://", "com", "co", "jp", "コム", "xn--p1ai", "t.co/a1",
		"\u0130", "\u212a", "\u202a", "\u00a0", "\ufeff", "😀", "3.5"}
	// Shapes the random texts miss.
	texts := []string{"é.com x", "x a-.b.com", "a.co/(a)b(c)(d)", "a.co/((a))x((b)", "a.co:8/@a/b(c)?d=(e", "a.co/b(c)d?e!"}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 8000 {
		var b strings.Builder
		for range 1 + rng.IntN(16) {
			b.WriteString(tokens[rng.IntN(len(tokens))])
		}
		texts = append(texts, b.String())
	}
	found, parens := 0, 0 // matches, and paths with balanced parentheses
	for _, raw := range texts {
		text := shiftSurrogates(utf16Units(raw))
		var want, got []string
		for m, _ := full.FindRunesMatch(text); m != nil; m, _ = full.FindNextMatch(m) {
			want = append(want, describe(m, m.Index+m.Length, m.GroupByNumber(7).Runes()))
			if slices.Contains(m.GroupByNumber(7).Runes(), ')') {
				parens++
			}
		}
		matches, err := urlMatches(text, time.Now().Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range matches {
			got = append(got, describe(m.Match, m.end, text[m.Index+m.Length:m.pathEnd]))
		}
		if !slices.Equal(got, want) {
			t.Errorf("urlMatches(%q)\n got %v\nwant %v", raw, got, want)
		}
		// A start the regex rejects would be skipped, so check every index.
		ends, err := urlEnds(text, time.Now().Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		for s, end := range ends {
			if want := matchEnd(extractURLAtRe, text, s, 5); end != want {
				t.Errorf("urlEnds(%q)[%d] = %d, want %d", raw, s, end, want)
			}
		}
		for s, end := range urlPathEnds(text) {
			if want := matchEnd(pathAt, text, s, 0); end != want {
				t.Errorf("urlPathEnds(%q)[%d] = %d, want %d", raw, s, end, want)
			}
		}
		for s, end := range asciiDomainEnds(text) {
			if want := matchEnd(asciiDomainAt, text, s, 0); end != want {
				t.Errorf("asciiDomainEnds(%q)[%d] = %d, want %d", raw, s, end, want)
			}
		}
		found += len(want)
	}
	if found < 1000 || parens < 100 {
		t.Fatalf("only %d matches, %d with parentheses in their path: the cases miss the regex", found, parens)
	}
}

// X Articles run to 100,000 characters.
func TestWeightedLengthOfLongText(t *testing.T) {
	prose := strings.Repeat("日本語の文章です。", 5556)
	japanese := prose + "3.5 https://sample.com/a " + prose
	var distinct strings.Builder // punycode's cost grows with distinct characters
	for c := rune(0x4e00); c < 0x4e00+20000; c++ {
		distinct.WriteRune(c)
	}
	for _, c := range []struct {
		text string
		want int
	}{
		{japanese, 2*2*utf8.RuneCountInString(prose) + len("3.5 ") + 23 + len(" ")},
		{strings.Repeat("a.", 5000), 10000},
		// Each "_b.co" matches, and is no link after "_", in one long chain.
		{"a.com." + strings.Repeat("a_b.co.", 2000), 24 + 7*2000},
		// A bare domain without an ASCII-only domain inside, plain and punycode.
		{strings.Repeat("a.", 2000) + "日本.com", 2*2000 + 8},
		{"xn--a." + strings.Repeat("a.", 2000) + "日本.com", 6 + 2*2000 + 8},
		{distinct.String() + ".com", 2*20000 + 4},
	} {
		start := time.Now()
		if got, err := WeightedLength(c.text); err != nil || got != c.want {
			t.Errorf("WeightedLength(%.20q…) = %d, %v, want %d", c.text, got, err, c.want)
		}
		// The full scan took minutes here; the bound leaves room for -race.
		if took := time.Since(start); took > 10*time.Second {
			t.Errorf("WeightedLength(%.20q…) took %v", c.text, took)
		}
	}
}

func TestStripLinks(t *testing.T) {
	in := "Read https://sample.com/x and sample.io/y"
	if !HasLinks(in) || StripLinks(in) != "Read and" {
		t.Errorf("got %v %q", HasLinks(in), StripLinks(in))
	}
	email := "write to user@sample.com"
	if HasLinks(email) || StripLinks(email) != email {
		t.Errorf("emails must stay: %v %q", HasLinks(email), StripLinks(email))
	}
}

func TestRemoveMarkdown(t *testing.T) {
	if got := RemoveMarkdown("# Title\n**bold** [link](https://x.com) `code`\n- item", nil); got != "Title\nbold link code\nitem" {
		t.Errorf("got %q", got)
	}
	except := []*regexp.Regexp{regexp.MustCompile(`\*\*keep\*\*`)}
	if got := RemoveMarkdown("**keep** and **drop**", except); got != "**keep** and drop" {
		t.Errorf("except: got %q", got)
	}
}

func TestSanitizePostContent(t *testing.T) {
	in := `<p dir="ltr">Hi <a href="javascript:x" target="_blank">x</a> <img src="data:x"><span data-mention-id="1" class="m">@a</span>&amp;</p>`
	want := `<p>Hi <a>x</a> <span data-mention-id="1" class="m">@a</span>&amp;</p>`
	if got := SanitizePostContent(in); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if got := PostContentPlainText(in); got != "Hi x @a&" {
		t.Errorf("plain text %q", got)
	}
}

func TestConfigurationChecker(t *testing.T) {
	for _, k := range []string{"JWT_SECRET", "MAIN_URL", "FRONTEND_URL", "NEXT_PUBLIC_BACKEND_URL", "BACKEND_INTERNAL_URL", "STORAGE_PROVIDER"} {
		t.Setenv(k, "")
	}
	t.Setenv("REDIS_URL", "rediss://x")
	t.Setenv("DATABASE_URL", "postgres://x/")
	t.Setenv("MAIN_URL", "example.com")
	t.Setenv("FRONTEND_URL", "https://app.example.com")

	c := &ConfigurationChecker{}
	c.ReadEnvFromProcess()
	c.Check()
	want := []string{
		"REDIS_URL must start with redis://",
		"DATABASE_URL should not end with /",
		"JWT_SECRET not set. ",
		"MAIN_URL is not a valid URL",
		"NEXT_PUBLIC_BACKEND_URL not set. ",
		"BACKEND_INTERNAL_URL not set. ",
		"STORAGE_PROVIDER not set. Needed to setup storage.",
	}
	if !c.HasIssues() || c.GetIssuesCount() != len(want) || !slices.Equal(c.GetIssues(), want) {
		t.Errorf("issues = %q", c.GetIssues())
	}
}

func TestMinifyPostsList(t *testing.T) {
	data := map[string]any{
		"posts": []map[string]any{{
			"id": "p1", "content": "c", "extra": 1, "tags": nil,
			"integration": map[string]any{"id": "i1", "providerIdentifier": "x", "picture": "pic"},
		}, {
			"id": "p2", "integration": nil,
			"tags": []any{map[string]any{"tag": map[string]any{"id": "t", "name": "n", "orgId": "o"}}},
		}},
		"total": 2, "page": 1, "limit": 10, "hasMore": false,
	}
	got, err := MinifyPostsList(data)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(got)
	want := `{"hm":false,"l":10,"p":[{"c":"c","extra":1,"i":"p1","n":{"i":"i1","p":"pic","pi":"x"}},{"i":"p2","n":null,"tg":[{"t":{"i":"t","n":"n","o":"o"}}]}],"pg":1,"t":2}`
	if string(raw) != want {
		t.Errorf("got %s", raw)
	}
}
