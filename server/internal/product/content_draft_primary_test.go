package product

import "testing"

func TestNewDraftPrimaryStaysOnAPublishingPlatform(t *testing.T) {
	for _, test := range []struct {
		name      string
		preferred string
		platforms []string
		want      string
	}{
		{"set default is published", "threads", []string{"x", "threads"}, "threads"},
		{"switched-off TikTok gives way to X", "tiktok", []string{"x", "threads"}, "x"},
		{"X-only draft", "tiktok", []string{"x"}, "x"},
		{"no X: first chosen", "tiktok", []string{"linkedin", "threads"}, "linkedin"},
		{"unknown platform skipped", "tiktok", []string{"", "bluesky"}, "bluesky"},
		{"nothing chosen keeps the default", "tiktok", nil, "tiktok"},
	} {
		if got := primaryAmong(test.preferred, test.platforms); got != test.want {
			t.Errorf("%s: primaryAmong(%q, %v) = %q, want %q", test.name, test.preferred, test.platforms, got, test.want)
		}
	}
}
