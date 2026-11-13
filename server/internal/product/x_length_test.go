package product

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
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
				if got, err := draftPostLength(channel, item.Text, nil); err != nil || got != want {
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
	}
	for _, c := range cases {
		if got := fitsXPost(c.text, c.extra, nil); got != c.want {
			t.Errorf("fitsXPost(%.12q…, %d) = %v, want %v", c.text, c.extra, got, c.want)
		}
	}
	if fitsXPost("a", 0, helpers.NewScanBudget(0)) {
		t.Error("text too complex to count fits")
	}
}

// 10 X targets of 25 posts, each slow to count but within its own limit,
// counted the way draftTargetConnections counts them (CheckXText, then
// draftPostLength, stopping at the first refusal): the shared budget refuses
// the request after about 2 s, where counting them all would take many more.
func TestOneRequestCountsWithinItsBudget(t *testing.T) {
	caps := socialidentity.XVerifiedAccountLimits("read-write", nil)
	budget := helpers.NewScanBudget(draftCountBudget)
	start := time.Now()
	var err error
	for i := 0; i < 250 && err == nil; i++ {
		text := fmt.Sprintf("https://%d.co/%s", i, strings.Repeat("a.", 2000)) // one TLD scan per dot
		if err = socialidentity.CheckXText(caps, text, budget); err == nil {
			_, err = draftPostLength("x", text, budget)
		}
	}
	if !errors.Is(err, helpers.ErrTextTooComplex) {
		t.Fatalf("counted every post: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("counting took %v, want about the %v budget", elapsed, draftCountBudget)
	}
}

// Dotted words without a TLD cost seconds of TLD scans; the link scan gives
// up within its budget and the caller refuses the text.
func TestDraftPostLengthRefusesTextTooComplexToCount(t *testing.T) {
	text := strings.Repeat(" https://"+strings.Repeat("a.", 25), 1<<20/59)
	for _, channel := range []string{"x", "mastodon"} {
		start := time.Now()
		_, err := draftPostLength(channel, text, helpers.NewScanBudget(100*time.Millisecond))
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Errorf("%s: took %v", channel, elapsed)
		}
		if !errors.Is(err, helpers.ErrTextTooComplex) {
			t.Errorf("%s: draftPostLength(%.12q…) error = %v, want ErrTextTooComplex", channel, text, err)
		}
	}
}
