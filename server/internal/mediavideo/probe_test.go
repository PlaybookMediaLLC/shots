package mediavideo

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"slices"
	"testing"
)

func TestProbeReadsDurationDisplaySizeAndCodecs(t *testing.T) {
	for _, tc := range []struct {
		file          string
		durationMs    int
		width, height int
		codecs        []string
	}{
		// moov after mdat, as most cameras write it.
		{"portrait.mp4", 4000, 240, 426, []string{"avc1", "mp4a"}},
		// moov before mdat (faststart).
		{"faststart.mp4", 3000, 320, 180, []string{"avc1"}},
		// A QuickTime movie whose 320x180 track is displayed a quarter turn.
		{"rotated.mov", 2500, 180, 320, []string{"avc1"}},
	} {
		body, err := os.ReadFile("testdata/" + tc.file)
		if err != nil {
			t.Fatal(err)
		}
		info, err := Probe(bytes.NewReader(body))
		if err != nil || info.DurationMs < tc.durationMs-50 || info.DurationMs > tc.durationMs+50 ||
			info.Width != tc.width || info.Height != tc.height || !slices.Equal(info.Codecs, tc.codecs) {
			t.Fatalf("%s: %+v err=%v", tc.file, info, err)
		}
		rangeInfo, err := ProbeRange(int64(len(body)), func(start, end int64) ([]byte, error) {
			return body[start : end+1], nil
		})
		if err != nil || rangeInfo.DurationMs != info.DurationMs || rangeInfo.Width != info.Width ||
			rangeInfo.Height != info.Height || !slices.Equal(rangeInfo.Codecs, info.Codecs) {
			t.Fatalf("%s ProbeRange mismatch: got %+v err=%v want %+v", tc.file, rangeInfo, err, info)
		}
	}
}

func TestProbeRejectsTruncatedAndForeignFiles(t *testing.T) {
	body, err := os.ReadFile("testdata/portrait.mp4")
	if err != nil {
		t.Fatal(err)
	}
	for name, input := range map[string][]byte{
		"truncated": body[:len(body)-200],
		"no moov":   body[:len(body)/3],
		"png":       []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
		"empty":     nil,
		"tiny box":  {0, 0, 0, 4, 'f', 't', 'y', 'p'},
	} {
		if _, err := Probe(bytes.NewReader(input)); err != ErrInvalid {
			t.Fatalf("%s: err=%v", name, err)
		}
		if _, err := ProbeRange(int64(len(input)), func(start, end int64) ([]byte, error) {
			return input[start : end+1], nil
		}); err != ErrInvalid {
			t.Fatalf("%s ProbeRange: err=%v", name, err)
		}
	}
}

func TestProbeRangeEdgeCases(t *testing.T) {
	t.Run("rejects 64-bit box size overflow", func(t *testing.T) {
		buf := make([]byte, 32)
		binary.BigEndian.PutUint32(buf[0:4], 1)
		copy(buf[4:8], "ftyp")
		binary.BigEndian.PutUint64(buf[8:16], math.MaxUint64)
		_, err := ProbeRange(int64(len(buf)), func(start, end int64) ([]byte, error) {
			return buf[start : end+1], nil
		})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("expected ErrInvalid on uint64 wraparound, got %v", err)
		}
	})

	t.Run("propagates transient storage errors unwrapped", func(t *testing.T) {
		transient := errors.New("s3 timeout")
		_, err := ProbeRange(1024, func(start, end int64) ([]byte, error) {
			return nil, transient
		})
		if !errors.Is(err, transient) || errors.Is(err, ErrInvalid) {
			t.Fatalf("expected unwrapped transient error, got %v", err)
		}
	})

	t.Run("stops early once moov and media data are found", func(t *testing.T) {
		body, err := os.ReadFile("testdata/faststart.mp4")
		if err != nil {
			t.Fatal(err)
		}
		// Append 100 trailing free boxes after faststart.mp4 to simulate fragmented tail.
		extended := append([]byte(nil), body...)
		for range 100 {
			box := make([]byte, 8)
			binary.BigEndian.PutUint32(box[0:4], 8)
			copy(box[4:8], "free")
			extended = append(extended, box...)
		}
		reads := 0
		info, err := ProbeRange(int64(len(extended)), func(start, end int64) ([]byte, error) {
			reads++
			return extended[start : end+1], nil
		})
		if err != nil || info.Width != 320 || info.Height != 180 {
			t.Fatalf("unexpected result: %+v err=%v", info, err)
		}
		if reads > 3 {
			t.Fatalf("expected early stop with <=3 range reads, got %d", reads)
		}
	})
}
