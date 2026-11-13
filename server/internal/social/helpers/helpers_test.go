package helpers

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
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

// regexp2 backtracks quadratically through domain-like words: without the
// budget each of these took seconds to minutes.
func TestLinkScanStopsOnCraftedText(t *testing.T) {
	scans := map[string]func(string) error{
		"WeightedLength": func(text string) error { _, err := WeightedLength(text); return err },
		"LinkSpans":      func(text string) error { _, err := LinkSpans(text); return err },
	}
	cases := map[string]string{
		"a.":         strings.Repeat("a.", 5000),
		"https://a.": "https://" + strings.Repeat("a.", 5000),
		// Each word is far below a call's timeout: only the text's deadline stops them.
		"many words": strings.Repeat(" https://"+strings.Repeat("a.", 25), 200),
	}
	for name, text := range cases {
		for scan, run := range scans {
			start := time.Now()
			err := run(text)
			if elapsed := time.Since(start); elapsed > time.Second {
				t.Errorf("%s(%s) took %v", scan, name, elapsed)
			}
			// Without "://" LinkSpans has no link to find and skips the scan.
			noProtocol := scan == "LinkSpans" && !strings.Contains(text, "://")
			if noProtocol && err != nil || !noProtocol && !errors.Is(err, ErrTextTooComplex) {
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
		crafted := fmt.Sprintf("https://%d.%s", i, strings.Repeat("a.", 150))
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
