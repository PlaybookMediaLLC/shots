// Package videoprocessing implements server-side video normalization profiles
// and the isolated Temporal video transcoding worker (task queue: platform-video).
package videoprocessing

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
)

// VideoFacts describes the probed container and stream properties of an asset.
type VideoFacts struct {
	MediaType string
	Bytes     int
	Width     int
	Height    int
	Codecs    []string
}

// ProfileFor returns the encoding profile for a destination platform, falling
// back to the "standard" baseline H.264/AAC profile.
func ProfileFor(platform string) (string, medialimits.VideoProfile) {
	if p, ok := medialimits.Limits.VideoProfiles[platform]; ok {
		return platform, p
	}
	if p, ok := medialimits.Limits.VideoProfiles["standard"]; ok {
		return "standard", p
	}
	return "standard", medialimits.VideoProfile{
		MaxBytes:      300_000_000,
		MaxEdge:       1920,
		MaxFPS:        30,
		VideoCodec:    "h264",
		AudioCodec:    "aac",
		PixelFormat:   "yuv420p",
		CRF:           22,
		AudioBitrateK: 160,
	}
}

// ProfileHash returns a stable, deterministic SHA-256 fingerprint for an
// encoding profile so derived videos can be cached and reused across posts.
func ProfileHash(name string, profile medialimits.VideoProfile) string {
	b, _ := json.Marshal(struct {
		Version int                      `json:"v"`
		Name    string                   `json:"name"`
		Profile medialimits.VideoProfile `json:"profile"`
	}{Version: 1, Name: name, Profile: profile})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:12])
}

// NeedsTranscode returns false when the source asset is already a compliant
// MP4 with H.264 video, AAC audio (or silent), and within the profile's byte
// and edge bounds (zero-copy fast path).
func NeedsTranscode(facts VideoFacts, profile medialimits.VideoProfile) bool {
	if facts.MediaType != "video/mp4" {
		return true
	}
	if profile.MaxBytes > 0 && facts.Bytes > profile.MaxBytes {
		return true
	}
	if profile.MaxEdge > 0 && (facts.Width > profile.MaxEdge || facts.Height > profile.MaxEdge) {
		return true
	}
	hasH264 := false
	for _, codec := range facts.Codecs {
		c := strings.ToLower(strings.TrimSpace(codec))
		switch {
		case strings.HasPrefix(c, "avc1"), c == "h264", c == "h.264":
			hasH264 = true
		case strings.HasPrefix(c, "mp4a"), c == "aac":
			// Compatible audio codec.
		default:
			// HEVC, VP9, AV1, ProRes, PCM, Opus, etc. require normalization.
			return true
		}
	}
	return !hasH264
}
