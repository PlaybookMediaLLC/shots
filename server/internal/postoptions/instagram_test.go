package postoptions

import (
	"strings"
	"testing"
)

func TestInstagramOptionsLimits(t *testing.T) {
	names := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = "account_" + string(rune('a'+i))
		}
		return out
	}
	off := false
	for _, tc := range []struct {
		name    string
		options *InstagramOptions
		valid   bool
	}{
		{"none", nil, true},
		{"three collaborators", &InstagramOptions{Collaborators: names(3)}, true},
		{"four collaborators", &InstagramOptions{Collaborators: names(4)}, false},
		{"twenty tags", &InstagramOptions{UserTags: names(20)}, true},
		{"twenty-one tags", &InstagramOptions{UserTags: names(21)}, false},
		{"handle with @", &InstagramOptions{UserTags: []string{"@brand"}}, false},
		{"handle too long", &InstagramOptions{Collaborators: []string{strings.Repeat("a", 31)}}, false},
		{"same handle twice", &InstagramOptions{UserTags: []string{"Brand", "brand"}}, false},
		{"trial on performance", &InstagramOptions{TrialReel: true, TrialGraduation: "SS_PERFORMANCE"}, true},
		{"graduation without a trial", &InstagramOptions{TrialGraduation: "MANUAL"}, false},
		{"unknown graduation", &InstagramOptions{TrialReel: true, TrialGraduation: "AUTO"}, false},
		{"off the grid", &InstagramOptions{ShareToFeed: &off}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.options.Validate(); (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestInstagramReelSettingsNeedAReel(t *testing.T) {
	off := false
	for _, o := range []*InstagramOptions{{CoverAssetID: "c"}, {ShareToFeed: &off}, {TrialReel: true}} {
		if !o.Reel() {
			t.Fatalf("%+v must need a reel", o)
		}
	}
	if (&InstagramOptions{Collaborators: []string{"a"}, UserTags: []string{"b"}}).Reel() {
		t.Fatal("collaborators and tags apply to photos too")
	}
}

func TestCoverAsset(t *testing.T) {
	if got := CoverAsset(&YouTubeOptions{ThumbnailAssetID: "thumb"}, nil); got != "thumb" {
		t.Fatal(got)
	}
	if got := CoverAsset(nil, &InstagramOptions{CoverAssetID: "cover"}); got != "cover" {
		t.Fatal(got)
	}
	if got := CoverAsset(&YouTubeOptions{}, nil); got != "" {
		t.Fatal(got)
	}
}
