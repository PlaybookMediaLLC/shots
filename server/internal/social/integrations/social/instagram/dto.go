package instagram

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Collaborators is one collaborator handle.
type Collaborators struct {
	Label *string `json:"label"`
}

// InstagramAudio is the Reel audio picked through audioSearch. The volumes
// stay raw: @Type(() => Number) coerces strings, and the publish call sends
// `+value`.
type InstagramAudio struct {
	ID          *string         `json:"id"`
	Title       string          `json:"title,omitempty"`
	Artist      string          `json:"artist,omitempty"`
	Image       string          `json:"image,omitempty"`
	AudioVolume json.RawMessage `json:"audio_volume,omitempty"`
	VideoVolume json.RawMessage `json:"video_volume,omitempty"`
}

// InstagramDTO holds the Instagram post settings.
type InstagramDTO struct {
	PostType           *string         `json:"post_type"` // post | story
	IsTrialReel        any             `json:"is_trial_reel,omitempty"`
	GraduationStrategy *string         `json:"graduation_strategy,omitempty"` // MANUAL | SS_PERFORMANCE
	Collaborators      []Collaborators `json:"collaborators,omitempty"`
	Audio              *InstagramAudio `json:"audio,omitempty"`
	// UserTags are usernames tagged on the reel or on the first photo.
	UserTags []string `json:"user_tags,omitempty"`
	// ShareToFeed false keeps a reel off the profile grid.
	ShareToFeed *bool `json:"share_to_feed,omitempty"`
}

// Validate returns the class-validator messages (flattened, nested
// paths prefixed) in declaration order.
func (d *InstagramDTO) Validate() []string {
	var out []string
	if d.PostType == nil {
		out = append(out, "post_type should not be null or undefined")
	}
	if d.PostType == nil || (*d.PostType != "post" && *d.PostType != "story") {
		out = append(out, "post_type must be one of the following values: post, story")
	}
	if d.GraduationStrategy != nil && *d.GraduationStrategy != "MANUAL" && *d.GraduationStrategy != "SS_PERFORMANCE" {
		out = append(out, "graduation_strategy must be one of the following values: MANUAL, SS_PERFORMANCE")
	}
	for i, c := range d.Collaborators {
		if c.Label == nil {
			prefix := fmt.Sprintf("collaborators.%d.label", i)
			out = append(out, prefix+" should not be null or undefined", prefix+" must be a string")
		}
	}
	if d.Audio != nil {
		if d.Audio.ID == nil {
			out = append(out, "audio.id should not be null or undefined", "audio.id must be a string")
		}
		out = append(out, volumeErrors("audio.audio_volume", d.Audio.AudioVolume)...)
		out = append(out, volumeErrors("audio.video_volume", d.Audio.VideoVolume)...)
	}
	return out
}

// volumeErrors is @IsOptional @Type(() => Number) @IsNumber @Min(0) @Max(100),
// messages in class-validator's (bottom-up) order.
func volumeErrors(path string, raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	n := JSNumber(raw)
	var out []string
	if math.IsNaN(n) || n > 100 {
		out = append(out, path+" must not be greater than 100")
	}
	if math.IsNaN(n) || n < 0 {
		out = append(out, path+" must not be less than 0")
	}
	if math.IsNaN(n) || math.IsInf(n, 0) {
		out = append(out, path+" must be a number conforming to the specified constraints")
	}
	return out
}

// JSNumber is JavaScript's `+value` for a raw JSON value (NaN when it does
// not convert).
func JSNumber(raw json.RawMessage) float64 {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return math.NaN()
	}
	switch n := v.(type) {
	case nil:
		return 0
	case float64:
		return n
	case bool:
		if n {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}
