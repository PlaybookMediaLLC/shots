package product

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMergeRecentWorkOrdersAndTruncates(t *testing.T) {
	base := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

	t.Run("mixed ordering, ID tie-break, and truncation", func(t *testing.T) {
		projects := []RecentWorkItem{
			{ID: "p3", Kind: "project", Name: "P3", UpdatedAt: base.Add(3 * time.Minute)},
			{ID: "p1", Kind: "project", Name: "P1", UpdatedAt: base.Add(1 * time.Minute)},
		}
		canvases := []RecentWorkItem{
			{ID: "c4", Kind: "canvas", Name: "C4", UpdatedAt: base.Add(4 * time.Minute)},
			{ID: "c2", Kind: "canvas", Name: "C2", UpdatedAt: base.Add(3 * time.Minute)},
			{ID: "c0", Kind: "canvas", Name: "C0", UpdatedAt: base},
		}

		got := mergeRecentWork(projects, canvases, 3)
		if len(got) != 3 {
			t.Fatalf("len = %d, want 3", len(got))
		}
		wantIDs := []string{"c4", "p3", "c2"}
		for i, want := range wantIDs {
			if got[i].ID != want {
				t.Fatalf("got[%d].ID = %q, want %q (full: %+v)", i, got[i].ID, want, got)
			}
		}
	})

	t.Run("empty slices serialize as non-nil JSON array", func(t *testing.T) {
		got := mergeRecentWork(nil, nil, 5)
		if got == nil || len(got) != 0 {
			t.Fatalf("got = %#v, want non-nil empty slice", got)
		}
		encoded, err := json.Marshal(RecentWorkPage{Items: got})
		if err != nil {
			t.Fatal(err)
		}
		if string(encoded) != `{"items":[]}` {
			t.Fatalf("json = %s, want {\"items\":[]}", encoded)
		}
	})

	t.Run("fewer items than limit keeps all", func(t *testing.T) {
		got := mergeRecentWork(
			[]RecentWorkItem{{ID: "p1", Kind: "project", Name: "P1", UpdatedAt: base}},
			nil,
			5,
		)
		if len(got) != 1 || got[0].ID != "p1" {
			t.Fatalf("got = %+v", got)
		}
	})

	t.Run("equal timestamp and equal ID break deterministically by kind", func(t *testing.T) {
		got := mergeRecentWork(
			[]RecentWorkItem{{ID: "same", Kind: "project", Name: "Proj", UpdatedAt: base}},
			[]RecentWorkItem{{ID: "same", Kind: "canvas", Name: "Canv", UpdatedAt: base}},
			5,
		)
		if len(got) != 2 || got[0].Kind != "canvas" || got[1].Kind != "project" {
			t.Fatalf("got = %+v", got)
		}
	})
}

func TestIsBuiltinOrMediaSource(t *testing.T) {
	t.Setenv("NEXT_PUBLIC_R2_PUBLIC_URL", "https://cdn.custom-r2.example/")

	allowed := []string{
		"/backgrounds/mesh.webp",
		"backgrounds/mesh.webp",
		"/r2-assets/static/demo/abc.webp",
		"https://assets.screenshot-studio.com/static/demo/abc.webp",
		"https://shots-assets.oppulence.io/static/demo/abc.webp",
		"https://cdn.custom-r2.example/static/demo/abc.webp",
	}
	for _, ref := range allowed {
		if !isBuiltinOrMediaSource(ref) {
			t.Errorf("isBuiltinOrMediaSource(%q) = false, want true", ref)
		}
	}

	rejected := []string{
		"",
		"http://assets.screenshot-studio.com/static/demo/abc.webp",
		"https://cdn.custom-r2.example.evil.com/static/demo/abc.webp",
		"https://evil.example/static/demo/abc.webp",
		"https://user@assets.screenshot-studio.com/static/demo/abc.webp",
		"https://assets.screenshot-studio.com/static/../secret.webp",
		"/static/../secret.webp",
		"https://assets.screenshot-studio.com",
	}
	for _, ref := range rejected {
		if isBuiltinOrMediaSource(ref) {
			t.Errorf("isBuiltinOrMediaSource(%q) = true, want false", ref)
		}
	}
}
