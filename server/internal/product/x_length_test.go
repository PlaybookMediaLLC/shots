package product

import (
	"encoding/json"
	"errors"
	"maps"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
)

// The composer's platformCaptionLength reads the same cases
// (clients/apps/web/test/write-publication.test.ts): both sides must agree.
func TestDraftPostLengthMatchesTheComposer(t *testing.T) {
	data, err := os.ReadFile("testdata/caption-length-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Limits map[string]int
		Cases  []struct {
			Label   string
			Text    string
			Lengths map[string]int
		}
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if !maps.Equal(fixture.Limits, draftChannelLimits) {
		t.Fatalf("Go limits %v, fixture %v", draftChannelLimits, fixture.Limits)
	}
	for _, item := range fixture.Cases {
		t.Run(item.Label, func(t *testing.T) {
			if len(item.Lengths) != len(draftChannelLimits) {
				t.Fatalf("case covers %d of %d channels", len(item.Lengths), len(draftChannelLimits))
			}
			for channel, want := range item.Lengths {
				if got, err := draftPostLength(channel, item.Text); err != nil || got != want {
					t.Errorf("%s: draftPostLength(%q) = %d, %v, want %d", channel, item.Text, got, err, want)
				}
			}
		})
	}
}

func TestFitsXPost(t *testing.T) {
	cases := []struct {
		text  string
		extra int
		want  bool
	}{
		{"", 0, false},
		{"  ", 0, false},
		{strings.Repeat("a", 280), 0, true},
		{strings.Repeat("a", 281), 0, false},
		{strings.Repeat("a", 256), 1 + xLinkLength, true},
		{strings.Repeat("a", 257), 1 + xLinkLength, false},
		{"https://a.co/" + strings.Repeat("(a)", 8000), 0, false}, // too complex to count
	}
	for _, c := range cases {
		if got := fitsXPost(c.text, c.extra); got != c.want {
			t.Errorf("fitsXPost(%.12q…, %d) = %v, want %v", c.text, c.extra, got, c.want)
		}
	}
}

// A URL path of parenthesised groups costs seconds of backtracking; the link
// scan gives up within its budget and the caller refuses the text.
func TestDraftPostLengthRefusesTextTooComplexToCount(t *testing.T) {
	text := "https://a.co/" + strings.Repeat("(a)", 8000)
	for _, channel := range []string{"x", "mastodon"} {
		start := time.Now()
		_, err := draftPostLength(channel, text)
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("%s: took %v", channel, elapsed)
		}
		if !errors.Is(err, helpers.ErrTextTooComplex) {
			t.Errorf("%s: draftPostLength(%.12q…) error = %v, want ErrTextTooComplex", channel, text, err)
		}
	}
}
