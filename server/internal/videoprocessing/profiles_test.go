package videoprocessing

import (
	"slices"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
)

func TestProfileHashDeterministic(t *testing.T) {
	p := medialimits.VideoProfile{
		MaxBytes:      300_000_000,
		MaxEdge:       1920,
		MaxFPS:        30,
		VideoCodec:    "h264",
		AudioCodec:    "aac",
		PixelFormat:   "yuv420p",
		CRF:           22,
		AudioBitrateK: 160,
	}
	h1 := ProfileHash("x", p)
	h2 := ProfileHash("x", p)
	if h1 != h2 || len(h1) != 24 {
		t.Fatalf("expected stable 24-char hex hash, got %q and %q", h1, h2)
	}
	hOther := ProfileHash("tiktok", p)
	if h1 == hOther {
		t.Fatalf("expected different platform hashes to differ")
	}
}

func TestNeedsTranscodeZeroCopyAndViolations(t *testing.T) {
	p := medialimits.VideoProfile{
		MaxBytes:      100_000_000,
		MaxEdge:       1920,
		MaxFPS:        30,
		VideoCodec:    "h264",
		AudioCodec:    "aac",
		PixelFormat:   "yuv420p",
		CRF:           22,
		AudioBitrateK: 160,
	}

	compliant := VideoFacts{
		MediaType: "video/mp4",
		Bytes:     20_000_000,
		Width:     1280,
		Height:    720,
		Codecs:    []string{"avc1.640028", "mp4a.40.2"},
	}
	if NeedsTranscode(compliant, p) {
		t.Fatalf("expected compliant video to skip transcode (zero-copy)")
	}

	cases := []struct {
		name  string
		facts VideoFacts
	}{
		{"quicktime container", func() VideoFacts { f := compliant; f.MediaType = "video/quicktime"; return f }()},
		{"hevc codec", func() VideoFacts { f := compliant; f.Codecs = []string{"hvc1", "mp4a.40.2"}; return f }()},
		{"oversized width", func() VideoFacts { f := compliant; f.Width = 3840; return f }()},
		{"oversized bytes", func() VideoFacts { f := compliant; f.Bytes = 150_000_000; return f }()},
		{"missing video codec", func() VideoFacts { f := compliant; f.Codecs = []string{"mp4a.40.2"}; return f }()},
	}
	for _, tc := range cases {
		if !NeedsTranscode(tc.facts, p) {
			t.Errorf("%s: expected NeedsTranscode=true", tc.name)
		}
	}
}

func TestFFmpegArgsSandboxed(t *testing.T) {
	p := medialimits.VideoProfile{
		MaxBytes:      200_000_000,
		MaxEdge:       1920,
		MaxFPS:        60,
		VideoCodec:    "h264",
		AudioCodec:    "aac",
		PixelFormat:   "yuv420p",
		CRF:           22,
		AudioBitrateK: 160,
	}
	args := ffmpegArgs("/tmp/in.mp4", "/tmp/out.mp4", p)
	for _, required := range []string{"-nostdin", "-protocol_whitelist", "file", "-map_metadata", "-1", "-movflags", "+faststart", "-pix_fmt", "yuv420p"} {
		if !slices.Contains(args, required) {
			t.Errorf("expected sandboxed ffmpeg args to contain %q, got %v", required, args)
		}
	}
}
