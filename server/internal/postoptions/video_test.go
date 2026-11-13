package postoptions

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestYouTubeAudienceJSONPreservesUnselectedAndExplicitChoices(t *testing.T) {
	yes, no := true, false
	for _, tc := range []struct {
		name     string
		audience *bool
		want     string
	}{
		{"unselected", nil, `{"title":"Canary","privacy":"private"}`},
		{"not made for kids", &no, `{"title":"Canary","privacy":"private","madeForKids":false}`},
		{"made for kids", &yes, `{"title":"Canary","privacy":"private","madeForKids":true}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			encoded, err := json.Marshal(YouTubeOptions{Title: "Canary", Privacy: "private", MadeForKids: tc.audience})
			if err != nil || string(encoded) != tc.want {
				t.Fatalf("audience JSON = %s, error = %v; want %s", encoded, err, tc.want)
			}
			var decoded YouTubeOptions
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if err := ValidateVideoOptions("youtube", &decoded, nil, true); (err == nil) != (tc.audience != nil) {
				t.Fatalf("scheduling must require an explicit audience, got %v", err)
			}
		})
	}
}

func TestVideoOptionsRequireExplicitPlatformChoices(t *testing.T) {
	no := false
	youtube := &YouTubeOptions{Title: "Local canary", Privacy: "private", MadeForKids: &no}
	tiktok := &TikTokOptions{Privacy: "SELF_ONLY", Consent: true}
	for _, tc := range []struct {
		name, channel   string
		youtube         *YouTubeOptions
		tiktok          *TikTokOptions
		complete, valid bool
	}{
		{"youtube", "youtube", youtube, nil, true, true},
		{"tiktok", "tiktok", nil, tiktok, true, true},
		{"missing", "youtube", nil, nil, true, false},
		{"wrong platform", "linkedin", youtube, nil, true, false},
		{"draft", "youtube", &YouTubeOptions{}, nil, false, true},
		{"missing audience", "youtube", &YouTubeOptions{Title: "Local canary", Privacy: "private"}, nil, true, false},
		{"missing consent", "tiktok", nil, &TikTokOptions{Privacy: "SELF_ONLY"}, true, false},
		{"private sponsorship", "tiktok", nil, &TikTokOptions{Privacy: "SELF_ONLY", Consent: true, BrandedContent: true}, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := ValidateVideoOptions(tc.channel, tc.youtube, tc.tiktok, tc.complete); (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}

func TestTikTokCreatorRechecksAccountRestrictions(t *testing.T) {
	c := &TikTokCreator{Nickname: "test", PrivacyLevels: []string{"SELF_ONLY"}, MaxDurationSeconds: 10, DuetDisabled: true}
	o := &TikTokOptions{Privacy: "SELF_ONLY", Consent: true}
	if err := c.Check(o, 5000); err != nil {
		t.Fatal(err)
	}
	if c.Check(o, 11000) == nil || c.Check(o, 0) == nil {
		t.Fatal("unverified or long video accepted")
	}
	o.AllowDuet = true
	if c.Check(o, 5000) == nil {
		t.Fatal("disabled interaction accepted")
	}
	o.AllowDuet = false
	o.Privacy = "PUBLIC_TO_EVERYONE"
	// The post's options fix this, not a refresh of the account.
	if err := c.Check(o, 5000); err == nil || errors.Is(err, ErrCreatorPermissions) {
		t.Fatalf("unavailable privacy: %v", err)
	}
	var missing *TikTokCreator
	if missing.Check(o, 5000) == nil {
		t.Fatal("missing creator accepted")
	}
}

func TestYouTubeTagsCountAsYouTubeDoes(t *testing.T) {
	// Two tags: 4 + "a b" quoted (3+2) + one comma.
	if got := YouTubeTagsLength([]string{"news", "a b"}); got != 10 {
		t.Fatalf("length = %d, want 10", got)
	}
	if YouTubeTagsLength(nil) != 0 {
		t.Fatal("no tags have no length")
	}
	no := false
	base := YouTubeOptions{Title: "Launch", Privacy: "public", MadeForKids: &no}
	full := make([]string, 100) // 100×4 + 99 commas = 499
	for i := range full {
		full[i] = fmt.Sprintf("t%03d", i)
	}
	over := append(append([]string{}, full...), "x")
	draft := base
	draft.Tags = over
	if err := ValidateVideoOptions("youtube", &draft, nil, false); err != nil {
		t.Fatalf("a draft over the tag limit must still save: %v", err)
	}
	for _, tc := range []struct {
		name  string
		tags  []string
		valid bool
	}{
		{"499 characters", full, true},
		{"501 characters", append(append([]string{}, full...), "x"), false},
		{"500 with a quoted tag", append(append([]string{}, full[:99]...), "a b"), true},
		{"comma inside a tag", []string{"a,b"}, false},
		{"blank tag", []string{" "}, false},
		{"padded tag", []string{" launch"}, false},
		{"repeated tag", []string{"Launch", "launch"}, false},
		{"angle bracket", []string{"<b>"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := base
			options.Tags = tc.tags
			if err := ValidateVideoOptions("youtube", &options, nil, true); (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}
