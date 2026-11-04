package postoptions

import (
	"encoding/json"
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
	if c.Check(o, 5000) == nil {
		t.Fatal("unavailable privacy accepted")
	}
	var missing *TikTokCreator
	if missing.Check(o, 5000) == nil {
		t.Fatal("missing creator accepted")
	}
}
