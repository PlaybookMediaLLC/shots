package socialidentity

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
)

// CheckXPoll checks the exact choices and duration without rewriting them.
// Media and Article combinations are excluded by the product's X poll contract.
func CheckXPoll(options []string, minutes, mediaCount int, article bool) error {
	if article || mediaCount != 0 {
		return errors.New("An X poll cannot include media or be an Article.")
	}
	if len(options) < 2 || len(options) > 4 {
		return errors.New("An X poll needs 2 to 4 choices.")
	}
	if minutes < 5 || minutes > 10080 {
		return errors.New("An X poll stays open 5 minutes to 7 days.")
	}
	for _, choice := range options {
		if !utf8.ValidString(choice) || strings.TrimSpace(choice) == "" || utf8.RuneCountInString(choice) > 25 {
			return errors.New("Each X poll choice needs 1 to 25 valid characters.")
		}
	}
	return nil
}

// CheckXText validates the actual text without truncation or link removal.
// The caller ensures a post with empty text has selected media.
func CheckXText(caps XCapabilities, text string) error {
	if err := caps.Validate(); err != nil {
		return err
	}
	if !utf8.ValidString(text) {
		return errors.New("X post text must be valid UTF-8.")
	}
	if text == "" {
		return nil
	}
	limit := caps.PostTextLimit()
	length, err := helpers.WeightedLength(text)
	if err != nil {
		return errors.New("The X post is too long or too complex to count. Shorten it.")
	}
	if length > limit {
		return fmt.Errorf("The X post exceeds this account's verified limit of %d weighted characters.", limit)
	}
	if valid, err := helpers.ValidTweetText(text, limit); err != nil {
		return errors.New("The X post is too long or too complex to count. Shorten it.")
	} else if !valid {
		return errors.New("The X post contains characters the platform cannot publish.")
	}
	return nil
}

// XMedia contains persisted or inspected source facts, never filename guesses.
type XMedia struct {
	MIME  string
	Bytes int64
	// DurationMs is a video's recorded length; zero is unknown.
	DurationMs int
}

// CheckXMedia rejects unsupported selections using known MIME, size and
// recorded video length. It does not inspect source bytes or image dimensions.
func CheckXMedia(caps XCapabilities, media []XMedia) error {
	if err := caps.Validate(); err != nil {
		return err
	}
	if len(media) > caps.MaxImages {
		return errors.New("Choose up to four images, one GIF, or one video for each X post.")
	}
	for _, item := range media {
		var limit int64
		switch item.MIME {
		case "image/jpeg", "image/png", "image/webp":
			limit = caps.ImageMaxBytes
		case "image/gif":
			if len(media) != 1 {
				return errors.New("An X GIF must be the post's only media attachment.")
			}
			limit = caps.GIFMaxBytes
		case "video/mp4":
			if len(media) != 1 {
				return errors.New("An X video must be the post's only media attachment.")
			}
			if caps.VideoMaxBytes == nil || caps.VideoMaxDurationSeconds == nil {
				return errors.New("Reconnect X to verify this account's video limits.")
			}
			limit = *caps.VideoMaxBytes
			if item.DurationMs > *caps.VideoMaxDurationSeconds*1000 {
				// Round up, so a refused video never reads as exactly the limit (20:00.5 is 20:01).
				seconds := (item.DurationMs + 999) / 1000
				return fmt.Errorf("This X account takes videos up to %d minutes; this one is %d:%02d. Trim it before scheduling.",
					*caps.VideoMaxDurationSeconds/60, seconds/60, seconds%60)
			}
		default:
			return errors.New("X supports JPEG, PNG, WebP, GIF, or MP4 attachments.")
		}
		if item.Bytes < 1 || item.Bytes > limit {
			return fmt.Errorf("An X %s attachment must have a known size no greater than %d bytes.", item.MIME, limit)
		}
	}
	return nil
}
