package helpers

import (
	"encoding/json"
	"os"
	"testing"
)

// reference.json holds outputs of the real npm packages (parse5, striptags,
// twitter-text, remove-markdown, DOMPurify, tldts) run through the TS helper
// bodies; see testdata/reference.js.
type reference struct {
	Strip []struct {
		Type, Val                         string
		ReplaceBold, None, Plain, Mention bool
		InlineImages                      bool
		Want                              string
	}
	StripTags []struct {
		HTML    string `json:"html"`
		Allowed []string
		Want    string
	}
	Weighted []struct {
		Text string
		Want int
	}
	Slicer []struct {
		Type, Text string
		End, Want  int
	}
	Count []struct {
		Type, Text string
		Want       int
	}
	Links []struct {
		Text  string
		Has   bool
		Strip string
	}
	Markdown []struct{ Text, Want string }
	Sanitize []struct{ Value, Want, Plain string }
	Cookie   []struct{ Domain, Want string }
}

func loadReference(t *testing.T) reference {
	t.Helper()
	raw, err := os.ReadFile("testdata/reference.json")
	if err != nil {
		t.Fatal(err)
	}
	var ref reference
	if err := json.Unmarshal(raw, &ref); err != nil {
		t.Fatal(err)
	}
	return ref
}

func testMention(id, name string) string { return "@[" + name + "](" + id + ")" }

func TestReferenceStripHTMLValidation(t *testing.T) {
	for _, c := range loadReference(t).Strip {
		opts := StripOptions{ReplaceBold: c.ReplaceBold, None: c.None, Plain: c.Plain, InlineImages: c.InlineImages}
		if c.Mention {
			opts.ConvertMention = testMention
		}
		if got := StripHTMLValidation(c.Type, c.Val, opts); got != c.Want {
			t.Errorf("StripHTMLValidation(%q, %q, %+v)\n got %q\nwant %q", c.Type, c.Val, c, got, c.Want)
		}
	}
}

func TestReferenceStripTags(t *testing.T) {
	for _, c := range loadReference(t).StripTags {
		if got := StripTags(c.HTML, c.Allowed); got != c.Want {
			t.Errorf("StripTags(%q, %v) = %q, want %q", c.HTML, c.Allowed, got, c.Want)
		}
	}
}

func TestReferenceTwitterText(t *testing.T) {
	ref := loadReference(t)
	for _, c := range ref.Weighted {
		if got, err := WeightedLength(c.Text); err != nil || got != c.Want {
			t.Errorf("WeightedLength(%q) = %d, %v, want %d", c.Text, got, err, c.Want)
		}
	}
	for _, c := range ref.Slicer {
		if start, end, err := TextSlicer(c.Type, c.End, c.Text); err != nil || start != 0 || end != c.Want {
			t.Errorf("TextSlicer(%q, %d, %q) = %d,%d, %v, want 0,%d", c.Type, c.End, c.Text, start, end, err, c.Want)
		}
	}
	for _, c := range ref.Count {
		if got, err := CountLength(c.Type, c.Text); err != nil || got != c.Want {
			t.Errorf("CountLength(%q, %q) = %d, %v, want %d", c.Type, c.Text, got, err, c.Want)
		}
	}
}

func TestReferenceLinks(t *testing.T) {
	for _, c := range loadReference(t).Links {
		if got := HasLinks(c.Text); got != c.Has {
			t.Errorf("HasLinks(%q) = %v, want %v", c.Text, got, c.Has)
		}
		if got := StripLinks(c.Text); got != c.Strip {
			t.Errorf("StripLinks(%q) = %q, want %q", c.Text, got, c.Strip)
		}
	}
}

func TestReferenceRemoveMarkdown(t *testing.T) {
	for _, c := range loadReference(t).Markdown {
		if got := RemoveMarkdown(c.Text, nil); got != c.Want {
			t.Errorf("RemoveMarkdown(%q)\n got %q\nwant %q", c.Text, got, c.Want)
		}
	}
}

func TestReferenceSanitize(t *testing.T) {
	for _, c := range loadReference(t).Sanitize {
		if got := SanitizePostContent(c.Value); got != c.Want {
			t.Errorf("SanitizePostContent(%q)\n got %q\nwant %q", c.Value, got, c.Want)
		}
		if got := PostContentPlainText(c.Value); got != c.Plain {
			t.Errorf("PostContentPlainText(%q) = %q, want %q", c.Value, got, c.Plain)
		}
	}
}

func TestReferenceCookieDomain(t *testing.T) {
	for _, c := range loadReference(t).Cookie {
		if got := GetCookieURLFromDomain(c.Domain); got != c.Want {
			t.Errorf("GetCookieURLFromDomain(%q) = %q, want %q", c.Domain, got, c.Want)
		}
	}
}
