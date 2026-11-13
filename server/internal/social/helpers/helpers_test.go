package helpers

import (
	"encoding/json"
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
	}
	for in, want := range cases {
		if got := WeightedLength(in); got != want {
			t.Errorf("WeightedLength(%q) = %d, want %d", in, got, want)
		}
	}
	if start, end := TextSlicer("x", 5, "日本語日本語"); start != 0 || end != 1 {
		t.Errorf("TextSlicer = %d,%d", start, end)
	}
	if got := CountLength("threads", "é😀"); got != 6 {
		t.Errorf("threads counts UTF-8 bytes, got %d", got)
	}
	if got := CountLength("linkedin", "é😀"); got != 3 {
		t.Errorf("others count UTF-16 units, got %d", got)
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
	describe := func(m *regexp2.Match) string {
		var b strings.Builder
		for _, g := range m.Groups() {
			fmt.Fprintf(&b, "%d+%d ", g.Index, g.Length)
		}
		return b.String()
	}
	tokens := []string{"a", "Z", "7", "日本", "_", "-", ".", ".", " ", "/", ":", "@", "＠", "#", "(", "?x=1",
		"http://", "HTTPS://", "https:/", "com", "co", "jp", "コム", "xn--p1ai", "t.co/a1",
		"\u0130", "\u212a", "\u202a", "\u00a0", "\ufeff", "😀", "3.5"}
	rng := rand.New(rand.NewPCG(1, 2))
	found := 0
	for range 5000 {
		var b strings.Builder
		for range 1 + rng.IntN(16) {
			b.WriteString(tokens[rng.IntN(len(tokens))])
		}
		text := shiftSurrogates(utf16Units(b.String()))
		var want, got []string
		for m, _ := full.FindRunesMatch(text); m != nil; m, _ = full.FindNextMatch(m) {
			want = append(want, describe(m))
		}
		next := urlMatches(text)
		for m := next(0); m != nil; m = next(m.Index + m.Length) {
			got = append(got, describe(m))
		}
		if !slices.Equal(got, want) {
			t.Errorf("urlMatches(%q)\n got %v\nwant %v", b.String(), got, want)
		}
		// A start the regex rejects would be skipped, so check every index.
		for s, start := range urlStarts(text) {
			if m, _ := extractURLAtRe.FindRunesMatchStartingAt(text, s); start != (m != nil) {
				t.Errorf("urlStarts(%q)[%d] = %v", b.String(), s, start)
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
	prose := strings.Repeat("日本語の文章です。", 5556)
	japanese := prose + "3.5 https://sample.com/a " + prose
	for _, c := range []struct {
		text string
		want int
	}{
		{japanese, 2*2*utf8.RuneCountInString(prose) + len("3.5 ") + 23 + len(" ")},
		{strings.Repeat("a.", 5000), 10000},
	} {
		start := time.Now()
		if got := WeightedLength(c.text); got != c.want {
			t.Errorf("WeightedLength(%.20q…) = %d, want %d", c.text, got, c.want)
		}
		if took := time.Since(start); took > time.Second {
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
