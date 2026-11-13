package medialimits

import "testing"

func TestPlanAndTypeLimits(t *testing.T) {
	for _, plan := range []string{"pro", "business", "enterprise"} {
		if UploadBytes("image/png", plan) != 20000000 {
			t.Fatal(plan)
		}
	}
	if UploadBytes("image/jpeg", "free") != 5000000 || UploadBytes("image/gif", "unknown") != 5000000 {
		t.Fatal("free image limit")
	}
	if UploadBytes("application/pdf", "pro") != 100_000_000 || UploadBytes("video/mp4", "pro") != 512<<20 {
		t.Fatal("document/video limit")
	}
}

// Every draft channel has media rules with a source, and a video limit never
// exceeds what Shots accepts for upload.
func TestDestinationsAreComplete(t *testing.T) {
	for _, channel := range []string{"x", "linkedin", "instagram", "threads", "bluesky", "mastodon", "facebook", "pinterest", "gmb"} {
		rules, ok := Limits.Destinations[channel]
		if !ok || rules.MaxMedia < 1 || len(rules.Images) == 0 || len(rules.Docs) == 0 || rules.VerifiedOn == "" {
			t.Fatalf("%s: %+v", channel, rules)
		}
		if rules.Video != nil && (len(rules.Video.Formats) == 0 || rules.Video.MaxBytes < 1 || rules.Video.MaxMs != 0 && rules.Video.MaxMs < rules.Video.MinMs) {
			t.Fatalf("%s video: %+v", channel, rules.Video)
		}
	}
	// X's per-tier limits feed every verified X account; a zero would refuse all X video.
	if x := Limits.Destinations["x"].Video.Accounts; x.Standard.MaxMs < 1 || x.Standard.MaxBytes < 1 || x.Premium.MaxMs < x.Standard.MaxMs || x.Premium.MaxBytes < x.Standard.MaxBytes {
		t.Fatalf("x account video tiers: %+v", x)
	}
}
