package product

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"testing"
)

func joined(parts ...[]byte) []byte { return bytes.Join(parts, nil) }

// wavFile builds a RIFF/WAVE file with the RIFF and data sizes as given, so a
// test can write what a killed recorder leaves behind; chunks go before data.
func wavFile(format, channels uint16, rate uint32, bits uint16, riffSize, dataSize uint32, data []byte, chunks ...[]byte) []byte {
	le16 := func(v uint16) []byte { return binary.LittleEndian.AppendUint16(nil, v) }
	le32 := func(v uint32) []byte { return binary.LittleEndian.AppendUint32(nil, v) }
	block := channels * bits / 8
	fmtChunk := joined([]byte("fmt "), le32(16), le16(format), le16(channels), le32(rate), le32(rate*uint32(block)), le16(block), le16(bits))
	body := joined(append([][]byte{[]byte("WAVE"), fmtChunk}, chunks...)...)
	body = joined(body, []byte("data"), le32(dataSize), data)
	return joined([]byte("RIFF"), le32(riffSize), body)
}

func TestDecodeWAV(t *testing.T) {
	second := make([]byte, 32000) // 16 kHz, mono, 16-bit
	list := joined([]byte("LIST"), binary.LittleEndian.AppendUint32(nil, 5), []byte("INFOx"), []byte{0})
	for _, test := range []struct {
		name       string
		data       []byte
		durationMs int
		rate       int
	}{
		{"normal", wavFile(1, 1, 16000, 16, 32036, 32000, second), 1000, 16000},
		{"a crash left both sizes at zero", wavFile(1, 1, 16000, 16, 0, 0, second), 1000, 16000},
		{"a crash left the data size larger than the file", wavFile(1, 1, 16000, 16, 0xFFFFFFFF, 0xFFFFFFFF, second), 1000, 16000},
		{"a padded chunk before the data", wavFile(1, 1, 16000, 16, 0, 32000, second, list), 1000, 16000},
		{"a chunk after the data", joined(wavFile(1, 1, 16000, 16, 0, 16000, second), list), 500, 16000},
		{"a partial last sample frame", wavFile(1, 1, 16000, 16, 0, 0, second[:32001-2]), 999, 16000},
		{"stereo 48 kHz", wavFile(1, 2, 48000, 16, 0, 0, make([]byte, 192000)), 1000, 48000},
		{"bad: not PCM", wavFile(3, 1, 16000, 32, 0, 0, make([]byte, 64000)), 0, 0},
		{"bad: truncated header", wavFile(1, 1, 16000, 16, 0, 0, second)[:20], 0, 0},
		{"bad: not RIFF", joined([]byte("RIFX"), wavFile(1, 1, 16000, 16, 0, 0, second)[4:]), 0, 0},
		{"bad: data before fmt", joined([]byte("RIFF\x00\x00\x00\x00WAVEdata\x00\x00\x00\x00"), second), 0, 0},
		{"bad: no samples", wavFile(1, 1, 16000, 16, 0, 0, nil), 0, 0},
		{"bad: no data chunk", wavFile(1, 1, 16000, 16, 0, 0, nil)[:36], 0, 0},
		{"bad: an impossible sample rate", wavFile(1, 1, 1000, 16, 0, 0, second), 0, 0},
		{"bad: AAC audio", joined([]byte{0xFF, 0xF1, 0x60, 0x40, 0x05, 0x7F, 0xFC}, make([]byte, 40)), 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			audio, err := decodeWAV(bytes.NewReader(test.data))
			if test.rate == 0 {
				if !errors.Is(err, ErrInvalidInput) {
					t.Fatalf("accepted %+v err=%v", audio, err)
				}
				return
			}
			if err != nil || audio.durationMs != test.durationMs || audio.sampleRateHz != test.rate {
				t.Fatalf("audio=%+v err=%v", audio, err)
			}
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("storage connection reset") }

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func digestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// The stored bytes, not the client's claims, decide: size, checksum, audio
// and the duration the server records (S4, S19).
func TestVerifyVoiceRun(t *testing.T) {
	run := wavFile(1, 1, 16000, 16, 0, 0, make([]byte, 6144)) // 192 ms
	audio, err := verifyVoiceRun(bytes.NewReader(run), int64(len(run)), digestOf(run))
	if err != nil || audio.durationMs != 192 || audio.sampleRateHz != 16000 {
		t.Fatalf("audio=%+v err=%v", audio, err)
	}
	for name, check := range map[string]func() error{
		"truncated": func() error {
			_, err := verifyVoiceRun(bytes.NewReader(run[:30]), int64(len(run)), digestOf(run))
			return err
		},
		"larger": func() error {
			_, err := verifyVoiceRun(bytes.NewReader(joined(run, []byte{0, 0})), int64(len(run)), digestOf(run))
			return err
		},
		"different bytes": func() error {
			other := joined(run)
			other[len(other)-1] = 1
			_, err := verifyVoiceRun(bytes.NewReader(other), int64(len(run)), digestOf(run))
			return err
		},
		"not audio": func() error {
			text := bytes.Repeat([]byte("not audio "), 10)
			_, err := verifyVoiceRun(bytes.NewReader(text), int64(len(text)), digestOf(text))
			return err
		},
		"over 31 minutes": func() error {
			// 8 kHz, 8-bit mono: 8000 bytes a second, streamed rather than held.
			size := int64(31*60+1) * 8000
			body := func() io.Reader {
				return io.MultiReader(bytes.NewReader(wavFile(1, 1, 8000, 8, 0, 0, nil)), io.LimitReader(zeros{}, size))
			}
			hash := sha256.New()
			total, _ := io.Copy(hash, body())
			_, err := verifyVoiceRun(body(), total, hex.EncodeToString(hash.Sum(nil)))
			return err
		},
	} {
		if err := check(); !errors.Is(err, ErrInvalidInput) {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	if _, err := verifyVoiceRun(failingReader{}, 10, digestOf(run)); err == nil || errors.Is(err, ErrInvalidInput) {
		t.Fatalf("a storage failure was reported as a bad file: %v", err)
	}
}
