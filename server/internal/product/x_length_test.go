package product

import (
	"encoding/json"
	"maps"
	"os"
	"testing"
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
				if got := draftPostLength(channel, item.Text); got != want {
					t.Errorf("%s: draftPostLength(%q) = %d, want %d", channel, item.Text, got, want)
				}
			}
		})
	}
}
