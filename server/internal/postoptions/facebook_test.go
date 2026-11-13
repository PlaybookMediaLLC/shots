package postoptions

import "testing"

func TestAFacebookStoryIsAFacebookSetting(t *testing.T) {
	story := &FacebookOptions{Placement: "story"}
	if err := ValidateFacebookOptions("facebook", story); err != nil || !story.Story() {
		t.Fatalf("story refused: %v", err)
	}
	if ValidateFacebookOptions("facebook", &FacebookOptions{Placement: "reel"}) == nil {
		t.Fatal("an unknown placement was accepted")
	}
	if ValidateFacebookOptions("instagram", story) == nil {
		t.Fatal("a Facebook story was accepted on Instagram")
	}
	for name, options := range map[string]*PublishOptions{
		"instagram": {Instagram: &InstagramOptions{Placement: "story"}},
		"facebook":  {Facebook: story},
	} {
		if !options.Story() {
			t.Fatalf("%s story not recognized", name)
		}
	}
	var none *PublishOptions
	if none.Story() || (&PublishOptions{Facebook: &FacebookOptions{}}).Story() {
		t.Fatal("a feed post read as a story")
	}
}
