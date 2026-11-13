package socialidentity

import (
	"errors"
	"unicode/utf8"

	"github.com/clipperhouse/uax29/v2/graphemes"
)

// BlueskyLexiconLimits returns the pinned post and embed contracts. Account and
// PDS-specific limits remain unknown until read from their authoritative APIs.
func BlueskyLexiconLimits() BlueskyCapabilities {
	return BlueskyCapabilities{MaxTextGraphemes: 300, MaxTextBytes: 3000, MaxImages: 4,
		ImageMaxBytes: 2000000, MaxVideos: 1, VideoMaxBytes: 300000000}
}

// GraphemeLength counts user-perceived characters (Unicode 17 grapheme
// clusters, as browsers' Intl.Segmenter does) rather than UTF-16 units.
func GraphemeLength(text string) int {
	count := 0
	for clusters := graphemes.FromString(text); clusters.Next(); {
		count++
	}
	return count
}

// CheckBlueskyText enforces both independent bounds without changing the text.
func CheckBlueskyText(text string) error {
	if !utf8.ValidString(text) || len(text) > 3000 || GraphemeLength(text) > 300 {
		return errors.New("Bluesky text must fit within 300 characters and 3,000 UTF-8 bytes")
	}
	return nil
}

// BlueskyMedia describes a stored asset or the actual bytes read before upload.
type BlueskyMedia struct {
	MIME  string
	Bytes int64
}

// CheckBlueskyMedia validates the complete selection before any upload. Video
// input goes through the video service; the PDS blob limit applies to its returned
// processed blob, not to the larger source file. Images go directly to the PDS.
func CheckBlueskyMedia(caps BlueskyCapabilities, media []BlueskyMedia) error {
	if err := caps.Validate(); err != nil {
		return err
	}
	images, videos := 0, 0
	for _, item := range media {
		if item.Bytes <= 0 {
			return errors.New("Bluesky media must be a nonempty file with a verified size")
		}
		switch item.MIME {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			images++
			limit := caps.ImageMaxBytes
			if caps.BlobUploadLimit != nil {
				limit = min(limit, *caps.BlobUploadLimit)
			}
			if item.Bytes > limit {
				return errors.New("A Bluesky image exceeds the 2 MB or account server upload limit; choose a smaller image")
			}
		case "video/mp4":
			videos++
			if item.Bytes > caps.VideoMaxBytes {
				return errors.New("A Bluesky video exceeds the 300 MB upload limit")
			}
			if caps.VideoCanUpload == nil || !*caps.VideoCanUpload {
				return errors.New("Bluesky video upload permission is unavailable for this account; verify access before scheduling a video")
			}
		default:
			return errors.New("Bluesky accepts images or one MP4 video; choose a supported file")
		}
	}
	if images > caps.MaxImages || videos > caps.MaxVideos || images > 0 && videos > 0 {
		return errors.New("Choose up to four images or one MP4 video for each Bluesky post")
	}
	return nil
}
