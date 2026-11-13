package helpers

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
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
// URL path of parenthesised groups: without the budget each took seconds, and
// now each counts.
func TestLinkScanStopsOnCraftedText(t *testing.T) {
	liftTextBudget(t)
	scans := map[string]func(string) error{
		"WeightedLength": func(text string) error { _, err := WeightedLength(text); return err },
		"LinkSpans":      func(text string) error { _, err := LinkSpans(text); return err },
	}
	cases := map[string]string{
		"a.":         strings.Repeat("a.", 5000),
		"https://a.": "https://" + strings.Repeat("a.", 5000),
		"many words": strings.Repeat(" https://"+strings.Repeat("a.", 25), 200),
		"(a)":        "https://a.co/" + strings.Repeat("(a)", 8000),
		// Ending characters between the groups, and a port, or a colon
		// without one, before the path: each path is still read in one pass.
		"a(a)":     "https://a.co/" + strings.Repeat("a(a)", 8000),
		"port (a)": "https://a.co:80/" + strings.Repeat("(a)", 8000),
		"no port":  strings.Repeat("a.co:/(a)", 3000),
		// A long xn-- domain: its ASCII-only scan waits for the length check.
		"xn--": "https://xn--a." + strings.Repeat("a.日", 40000) + ".com",
	}
	for name, text := range cases {
		for scan, run := range scans {
			start := time.Now()
			if err := run(text); err != nil {
				t.Errorf("%s(%s) error = %v", scan, name, err)
			}
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Errorf("%s(%s) took %v", scan, name, elapsed)
			}
		}
	}
}

// liftTextBudget lifts each text's link-scan budget for a test that checks
// what a text counts, so a loaded machine cannot refuse a text that counts in
// a fraction of its budget unloaded. The tests that check refusals keep it,
// so a test that lifts it must not run in parallel.
func liftTextBudget(t *testing.T) {
	saved := linkScanPerUnit
	linkScanPerUnit = time.Second
	t.Cleanup(func() { linkScanPerUnit = saved })
}

// A text longer than any caption gets no more time than the longest one: 1 MiB
// of slow words took 21 s while the budget grew with length.
func TestLinkScanBudgetStopsGrowingPastTheLongestCaption(t *testing.T) {
	// Many words; one word, whose TLD checks stop too; and many bare domains,
	// each with an ASCII-only scan of a TLD check per label.
	words := strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59)
	for _, text := range []string{
		words,
		strings.Repeat("a.", 1<<19),
		strings.Repeat("!"+strings.Repeat("`a.", 1333)+"com", 1<<20/4003),
	} {
		start := time.Now()
		if _, err := WeightedLength(text); !errors.Is(err, ErrTextTooComplex) {
			t.Fatalf("WeightedLength(%.12q…) error = %v", text, err)
		}
		if elapsed := time.Since(start); elapsed > 4*time.Second {
			t.Errorf("%.12q… took %v, want about the 2.2 s budget of a 100,000-unit text", text, elapsed)
		}
	}
	// Mastodon's scan has the same cap.
	start := time.Now()
	if _, err := LinkSpans(words); !errors.Is(err, ErrTextTooComplex) {
		t.Fatalf("LinkSpans error = %v", err)
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Errorf("LinkSpans took %v, want about the 2.2 s budget of a 100,000-unit text", elapsed)
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
	start := time.Now()
	for i := range 20 {
		crafted := fmt.Sprintf("%d.%s", i, strings.Repeat("a.", 100_000)) // seconds unbounded
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
	describe := func(m *regexp2.Match) string {
		var b strings.Builder
		for _, g := range m.Groups() {
			fmt.Fprintf(&b, "%d+%d ", g.Index, g.Length)
		}
		return b.String()
	}
	// The path's segments: validUrlPath, cut from extractURLSource.
	pathAt := jsRegexp(`\G`+strings.TrimSuffix(sourceSpan(`\/(?:(?:`, `*)?(\?`), `)?(\?`), regexp2.IgnoreCase)
	tokens := []string{"a", "Z", "7", "日", "日本", "_", "-", ".", ".", " ", "/", ":", "@", "＠", "#", "(", "?x=1",
		"(a)", "((a)b)", ")", "!", "Ж", "é", ":80", "a.co:80/",
		"http://", "HTTPS://", "https:/", "ttps://", "com", "co", "jp", "コム", "xn--p1ai", "t.co/a1",
		"\u0130", "\u212a", "\u202a", "\u00a0", "\ufeff", "😀", "3.5"}
	texts := []string{"é.com x", "x a-.b.com"} // shapes the random texts miss
	rng := rand.New(rand.NewPCG(1, 2))
	for range 6000 {
		var b strings.Builder
		for range 1 + rng.IntN(16) {
			b.WriteString(tokens[rng.IntN(len(tokens))])
		}
		texts = append(texts, b.String())
	}
	found := 0
	for _, raw := range texts {
		text := shiftSurrogates(utf16Units(raw))
		var want, got []string
		for m, _ := full.FindRunesMatch(text); m != nil; m, _ = full.FindNextMatch(m) {
			want = append(want, describe(m))
		}
		written := slices.Clone(text)
		matches, err := urlMatches(text, time.Now().Add(time.Hour))
		if err != nil || !slices.Equal(text, written) {
			t.Fatalf("urlMatches(%q) changed the text or failed: %v", raw, err)
		}
		for _, m := range matches {
			got = append(got, describe(m))
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
		for s, c := range text {
			if c != '/' {
				continue
			}
			if got, want := urlPathEnd(text, s+1), matchEnd(pathAt, text, s, 0); got != want {
				t.Errorf("urlPathEnd(%q, %d) = %d, want %d", raw, s+1, got, want)
			}
		}
		for s, end := range asciiDomainEnds(text) {
			if want := matchEnd(asciiDomainAt, text, s, 0); end != want {
				t.Errorf("asciiDomainEnds(%q)[%d] = %d, want %d", raw, s, end, want)
			}
		}
		found += len(want)
	}
	if found < 1000 {
		t.Fatalf("only %d matches: the cases miss the regex", found)
	}
}

// X Articles run to 100,000 characters.
func TestWeightedLengthOfLongText(t *testing.T) {
	liftTextBudget(t)
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
		// A path of parenthesised groups, which regexp2 rescanned after each
		// one: one link, and past 4,096 characters no link at all.
		{"https://a.co/" + strings.Repeat("(a)", 1300), 23},
		// The longest link, and one character more.
		{"https://a.co/" + strings.Repeat("a", 4075), 23},
		{"https://a.co/" + strings.Repeat("a", 4076), 13 + 4076},
		{"https://a.co/" + strings.Repeat("(a)", 8000), 13 + 3*8000},
		{"https://a.co/" + strings.Repeat("((a))", 19000), 13 + 5*19000},
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

// emojiMatches must find what one scan of the twemoji regex finds, whatever
// the window.
func TestEmojiMatchesAreTheFullScan(t *testing.T) {
	if n := longestMatch(t, twemojiSource); n != twemojiMaxLength {
		t.Fatalf("a twemoji match spans up to %d units, not twemojiMaxLength", n)
	}
	tokens := []string{"\U0001F600", "\U0001F44D\U0001F3FD", "\U0001F1EB\U0001F1F7", "#\ufe0f\u20e3",
		"\U0001F468\u200d\U0001F469\u200d\U0001F467\u200d\U0001F466",             // a family, 11 units
		"\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F", // England's flag, 14
		"\U0001F468\u200d\u2764\ufe0f\u200d\U0001F468", "\u2764", "\u2642", "\u00a9", "7", "#",
		"\u20e3", "\ufe0f", "\ufe0e", "\u200d", "a", " ",
		// A profession, a sport and a gendered sequence, with and without a
		// skin tone; a pointing finger, before a variation selector or not;
		// and a lone skin tone.
		"\U0001F469\U0001F3FD\u200d\U0001F680", "\u26f9\U0001F3FD\u200d\u2642\ufe0f", "\U0001F3C3\u200d\u2640\ufe0f",
		"\u261d", "\U0001F3FD"}
	full := func(text []rune) map[int]int {
		want := map[int]int{}
		for m, _ := twemojiRe.FindRunesMatch(text); m != nil; m, _ = twemojiRe.FindNextMatch(m) {
			want[m.Index] = m.Length
		}
		return want
	}
	// A stuck loop fails in seconds: emojiMatches checks the deadline every pass.
	deadline := time.Now().Add(10 * time.Second)
	rng := rand.New(rand.NewPCG(3, 4))
	var all strings.Builder
	found, longest := 0, 0
	for range 2000 {
		var b strings.Builder
		for range 1 + rng.IntN(40) {
			b.WriteString(tokens[rng.IntN(len(tokens))])
		}
		all.WriteString(b.String())
		text := shiftSurrogates(utf16Units(b.String()))
		want := full(text)
		for _, window := range []int{twemojiMaxLength + 2, 23, 40} {
			if got, err := emojiMatches(text, window, deadline); err != nil || !maps.Equal(got, want) {
				t.Fatalf("emojiMatches(%q, %d) = %v, %v, want %v", b.String(), window, got, err, want)
			}
		}
		found += len(want)
		for _, n := range want {
			if n == twemojiMaxLength {
				longest++
			}
		}
	}
	// Only matches as long as twemojiMaxLength test the windows' margin.
	if found < 10000 || longest < 1000 {
		t.Fatalf("only %d matches, %d of them %d units: the tokens miss the regex", found, longest, twemojiMaxLength)
	}
	// And the windows production reads, over all the texts as one.
	text := shiftSurrogates(utf16Units(all.String()))
	if got, err := emojiMatches(text, emojiScanWindow, deadline); err != nil || !maps.Equal(got, full(text)) {
		t.Fatalf("emojiMatches of %d units = %v, not the full scan", len(text), err)
	}
}

// longestMatch is the most units a match of source can span, for a regex of
// \u escapes, classes, groups, alternation, ? and negative lookaheads only,
// as twemojiSource is: with no repetition, its longest path.
func longestMatch(t *testing.T, source string) int {
	i := 0
	var alternation func() int
	alternation = func() int {
		longest, n := 0, 0
		for i < len(source) {
			switch {
			case source[i] == '|':
				longest, n = max(longest, n), 0
				i++
			case source[i] == ')':
				i++
				return max(longest, n)
			case source[i] == '?':
				i++ // optional: no longer
			case strings.HasPrefix(source[i:], "(?!"):
				i += 3
				if alternation() > 1 { // spans nothing, but emojiMatches leaves it one unit
					t.Fatalf("a twemoji lookahead reads more than one unit")
				}
			case strings.HasPrefix(source[i:], "(?:"):
				i += 3
				n += alternation()
			case source[i] == '(':
				i++
				n += alternation()
			case source[i] == '[':
				for i++; source[i] != ']'; i++ {
					if source[i] == '\\' {
						i++
					}
				}
				i++
				n++
			case strings.HasPrefix(source[i:], `\u`):
				i += len(`\u0000`)
				n++
			default:
				t.Fatalf("longestMatch cannot read %q", source[i:min(i+10, len(source))])
			}
		}
		return max(longest, n)
	}
	return alternation()
}

// Each emoji window starts where the last stopped. Read from the text's start
// instead, the scan counted the same but took 1.8 s, not 0.14 s, on 100,000
// digits: 8 times the text must take about 8 times as long, not 64.
func TestEmojiScanIsLinear(t *testing.T) {
	scan := func(n int) time.Duration {
		text := shiftSurrogates(utf16Units(strings.Repeat("7", n)))
		best := time.Hour
		for range 3 {
			start := time.Now()
			if _, err := emojiMatches(text, emojiScanWindow, time.Now().Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			best = min(best, time.Since(start))
		}
		return best
	}
	if short, long := scan(1<<15), scan(1<<18); long > 20*short {
		t.Errorf("8 times the digits took %v against %v", long, short)
	}
}

// A twemoji regex call that fails, as a timeout would, is ErrTextTooComplex,
// not a count without its matches.
func TestEmojiScanErrorIsTextTooComplex(t *testing.T) {
	saved := twemojiRe
	t.Cleanup(func() { twemojiRe = saved })
	twemojiRe = regexp2.MustCompile(`(a+)+b`, 0) // exponential: the group keeps regexp2 from merging the loops
	twemojiRe.MatchTimeout = time.Millisecond
	if _, err := emojiMatches([]rune(strings.Repeat("a", 30)), emojiScanWindow, time.Now().Add(time.Hour)); err != ErrTextTooComplex {
		t.Fatalf("error = %v", err)
	}
}

// The emoji scan checks the budget between its regex calls: one call over
// 1 MiB of digits took 1.5 s, and 1 MiB of emoji 0.5 s, whatever the budget.
func TestEmojiScanStopsWithinItsBudget(t *testing.T) {
	for name, text := range map[string]string{
		"digits": strings.Repeat("7", 1<<20),
		"emoji":  strings.Repeat("\U0001F600", 1<<18),
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
