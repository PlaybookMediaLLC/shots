package product

import (
	"slices"
	"testing"

	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

func intPtr(v int) *int { return &v }

func TestAssetAndTemplateAspectClass(t *testing.T) {
	if got := assetAspectClass(intPtr(1920), intPtr(1080)); got != "landscape" {
		t.Fatalf("1920x1080 = %q", got)
	}
	if got := assetAspectClass(intPtr(1080), intPtr(1920)); got != "portrait" {
		t.Fatalf("1080x1920 = %q", got)
	}
	if got := assetAspectClass(intPtr(1080), intPtr(1080)); got != "square" {
		t.Fatalf("1080x1080 = %q", got)
	}
	if got := assetAspectClass(nil, intPtr(1080)); got != "" {
		t.Fatalf("nil width = %q", got)
	}
	if got := templateAspectClass("layout-story-phone"); got != "portrait" {
		t.Fatalf("layout-story-phone = %q", got)
	}
	if got := templateAspectClass("layout-social-phone"); got != "square" {
		t.Fatalf("layout-social-phone = %q", got)
	}
	if got := templateAspectClass("layout-headline-spotlight"); got != "landscape" {
		t.Fatalf("layout-headline-spotlight = %q", got)
	}
}

func TestPickDraftMediaForChannelMatchesAspectAcrossAllBranches(t *testing.T) {
	aspects := map[string]string{
		"render-landscape": templateAspectClass("layout-headline-spotlight"),
		"render-square":    templateAspectClass("layout-social-phone"),
		"render-portrait":  templateAspectClass("layout-story-phone"),
	}

	t.Run("single capture multi template matches channel aspect", func(t *testing.T) {
		input := automation.Outputs{
			CaptureAssetID:   "cap-1",
			RenderedAssetIDs: []string{"render-landscape", "render-square", "render-portrait"},
		}
		cases := map[string]string{
			"x":         "render-landscape",
			"linkedin":  "render-landscape",
			"instagram": "render-square",
			"threads":   "render-square",
			"tiktok":    "render-portrait",
			"pinterest": "render-portrait",
		}
		for channel, want := range cases {
			got := pickDraftMediaForChannel(input, channel, aspects)
			if !slices.Equal(got, []string{want}) {
				t.Errorf("channel %s: got %v, want [%s]", channel, got, want)
			}
		}
		// Empty aspect map falls back to first render.
		if got := pickDraftMediaForChannel(input, "tiktok", nil); !slices.Equal(got, []string{"render-landscape"}) {
			t.Errorf("nil aspect fallback: got %v", got)
		}
	})

	t.Run("render without capture node selects aspect-matched render and preserves all candidates", func(t *testing.T) {
		input := automation.Outputs{
			RenderedAssetIDs: []string{"render-landscape", "render-square", "render-portrait"},
		}
		if got := automationDraftCandidateMedia(input); !slices.Equal(got, input.RenderedAssetIDs) {
			t.Fatalf("candidates=%v", got)
		}
		if got := pickDraftMediaForChannel(input, "instagram", aspects); !slices.Equal(got, []string{"render-square"}) {
			t.Fatalf("instagram=%v", got)
		}
		if got := pickDraftMediaForChannel(input, "tiktok", aspects); !slices.Equal(got, []string{"render-portrait"}) {
			t.Fatalf("tiktok=%v", got)
		}
	})

	t.Run("multi capture attaches one render per captured change", func(t *testing.T) {
		input := automation.Outputs{
			CaptureAssetIDs:  []string{"cap-1", "cap-2"},
			RenderedAssetIDs: []string{"render-1", "render-2"},
		}
		if got := pickDraftMediaForChannel(input, "instagram", aspects); !slices.Equal(got, []string{"render-1", "render-2"}) {
			t.Fatalf("multi capture=%v", got)
		}
	})

	t.Run("capture only without renders falls back to captures", func(t *testing.T) {
		input := automation.Outputs{CaptureAssetID: "cap-1"}
		if got := automationDraftCandidateMedia(input); !slices.Equal(got, []string{"cap-1"}) {
			t.Fatalf("candidates=%v", got)
		}
		if got := pickDraftMediaForChannel(input, "x", nil); !slices.Equal(got, []string{"cap-1"}) {
			t.Fatalf("capture only=%v", got)
		}
	})
}
