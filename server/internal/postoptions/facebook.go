package postoptions

import "fmt"

// FacebookOptions are a Facebook Page post's settings beyond its text.
type FacebookOptions struct {
	// Placement "story" posts one image or video as a Page story, with no
	// text and no first comment.
	Placement string `json:"placement,omitempty"`
}

// Story reports whether the post is a Facebook Page story.
func (o *FacebookOptions) Story() bool { return o != nil && o.Placement == "story" }

// ValidateFacebookOptions checks Facebook settings belong to a Facebook post
// and hold on their own; scheduling checks a story against its media.
func ValidateFacebookOptions(channel string, o *FacebookOptions) error {
	if o == nil {
		return nil
	}
	if channel != "facebook" {
		return fmt.Errorf("a Page story is a Facebook setting")
	}
	if o.Placement != "" && o.Placement != "story" {
		return fmt.Errorf("a Facebook post goes to the Page's feed or, with placement story, to its stories")
	}
	return nil
}
