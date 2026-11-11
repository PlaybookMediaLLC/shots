package product

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
)

// Voice audio checks (plan S4, S19): a run is ready only once the server has
// read the stored bytes, matched their size and SHA-256, and decoded them as
// audio to measure the duration it then uses for display and metering.

// voiceAudio is what the server decoded from a run.
type voiceAudio struct {
	durationMs   int
	sampleRateHz int
}

// voiceMaxRunMs refuses a run longer than any note may be, with a minute of
// slack over the 30-minute limit.
const voiceMaxRunMs = 31 * 60 * 1000

// verifyVoiceRun reads a stored run once: its exact size, its SHA-256 (hex)
// and its audio. A bad object is an invalid-input error; a storage read
// failure is returned as it is.
func verifyVoiceRun(object io.Reader, contentType string, size int64, digest string) (voiceAudio, error) {
	hash := sha256.New()
	limited := &io.LimitedReader{R: object, N: size + 1}
	reader := io.TeeReader(limited, hash)
	decode := decodeADTS
	if contentType == "audio/wav" {
		decode = decodeWAV
	}
	audio, decodeErr := decode(reader)
	if decodeErr != nil && !errors.Is(decodeErr, ErrInvalidInput) {
		return voiceAudio{}, decodeErr
	}
	// The decoder may stop early; the size and checksum cover every byte.
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return voiceAudio{}, err
	}
	if size+1-limited.N != size {
		return voiceAudio{}, invalid("The stored recording's size differs from the upload. Upload the run again.")
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return voiceAudio{}, invalid("The stored recording's checksum does not match. Upload the run again.")
	}
	if decodeErr != nil {
		return voiceAudio{}, decodeErr
	}
	if audio.durationMs > voiceMaxRunMs {
		return voiceAudio{}, invalid("This recording is longer than 31 minutes.")
	}
	return audio, nil
}

// adtsRates are the ADTS sampling frequencies by index; 13 to 15 are invalid.
var adtsRates = [...]int{96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350}

// decodeADTS reads AAC ADTS frames to the end of r. Every frame starts with
// the sync word, and a run keeps one sample rate (the recorder starts a new
// run on a format change). A final frame cut short, header or body, is what a
// killed recorder leaves behind: it is ignored, so the run plays to its last
// whole frame. Any other byte that is not a frame is refused.
func decodeADTS(r io.Reader) (voiceAudio, error) {
	notADTS := invalid("This recording is not ADTS AAC audio.")
	reader := bufio.NewReader(r)
	header := make([]byte, 7)
	rate, samples := 0, int64(0)
	for {
		n, err := io.ReadFull(reader, header)
		if errors.Is(err, io.ErrUnexpectedEOF) {
			if header[0] != 0xFF || (n > 1 && header[1]&0xF6 != 0xF0) {
				return voiceAudio{}, notADTS
			}
			break
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return voiceAudio{}, err
		}
		// 12-bit sync word, then layer 00.
		if header[0] != 0xFF || header[1]&0xF6 != 0xF0 {
			return voiceAudio{}, notADTS
		}
		index := int(header[2]>>2) & 0x0F
		if index >= len(adtsRates) {
			return voiceAudio{}, notADTS
		}
		if rate != 0 && adtsRates[index] != rate {
			return voiceAudio{}, invalid("This recording changes sample rate mid-run.")
		}
		rate = adtsRates[index]
		length := int(header[3]&0x03)<<11 | int(header[4])<<3 | int(header[5])>>5
		headerLength := 7
		if header[1]&0x01 == 0 {
			headerLength = 9 // a CRC follows the header
		}
		if length < headerLength {
			return voiceAudio{}, notADTS
		}
		if _, err := io.CopyN(io.Discard, reader, int64(length-len(header))); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return voiceAudio{}, err
		}
		// Each raw data block holds 1024 samples.
		samples += 1024 * int64(header[6]&0x03+1)
	}
	if samples == 0 {
		return voiceAudio{}, invalid("This recording holds no complete AAC frame.")
	}
	return voiceAudio{durationMs: int(samples * 1000 / int64(rate)), sampleRateHz: rate}, nil
}

// decodeWAV reads a RIFF/WAVE file of PCM samples (format 1) to its data
// chunk. A recorder killed mid-write leaves the RIFF and data sizes at 0, or
// larger than the file: the bytes present are then the data. The data is
// counted in whole sample frames; a partial last frame is ignored.
func decodeWAV(r io.Reader) (voiceAudio, error) {
	notWAV := invalid("This recording is not a PCM WAV file.")
	reader := bufio.NewReader(r)
	head := make([]byte, 12)
	if _, err := io.ReadFull(reader, head); err != nil {
		return voiceAudio{}, endOrError(err, notWAV)
	}
	if string(head[0:4]) != "RIFF" || string(head[8:12]) != "WAVE" {
		return voiceAudio{}, notWAV
	}
	rate, frameBytes := 0, int64(0)
	chunk := make([]byte, 8)
	for {
		if _, err := io.ReadFull(reader, chunk); err != nil {
			return voiceAudio{}, endOrError(err, notWAV)
		}
		id, size := string(chunk[0:4]), int64(binary.LittleEndian.Uint32(chunk[4:8]))
		switch id {
		case "fmt ":
			if size < 16 || size > 1024 {
				return voiceAudio{}, notWAV
			}
			body := make([]byte, size+size%2)
			if _, err := io.ReadFull(reader, body); err != nil {
				return voiceAudio{}, endOrError(err, notWAV)
			}
			format, channels := binary.LittleEndian.Uint16(body[0:2]), int64(binary.LittleEndian.Uint16(body[2:4]))
			rate = int(binary.LittleEndian.Uint32(body[4:8]))
			bits := int64(binary.LittleEndian.Uint16(body[14:16]))
			if format != 1 {
				return voiceAudio{}, invalid("This WAV file is not PCM audio.")
			}
			if channels < 1 || rate < 8000 || rate > 192000 || (bits != 8 && bits != 16 && bits != 24 && bits != 32) {
				return voiceAudio{}, notWAV
			}
			frameBytes = channels * bits / 8
		case "data":
			if frameBytes == 0 {
				return voiceAudio{}, notWAV
			}
			var present int64
			var err error
			if size == 0 {
				present, err = io.Copy(io.Discard, reader)
			} else {
				present, err = io.CopyN(io.Discard, reader, size)
			}
			if err != nil && !errors.Is(err, io.EOF) {
				return voiceAudio{}, err
			}
			frames := present / frameBytes
			if frames == 0 {
				return voiceAudio{}, invalid("This WAV file holds no audio.")
			}
			return voiceAudio{durationMs: int(frames * 1000 / int64(rate)), sampleRateHz: rate}, nil
		default:
			// Chunks such as LIST before the data are skipped, with their pad byte.
			if _, err := io.CopyN(io.Discard, reader, size+size%2); err != nil {
				return voiceAudio{}, endOrError(err, notWAV)
			}
		}
	}
}

// endOrError reports a stream that ended too early as bad, and passes any
// other read error through.
func endOrError(err, bad error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return bad
	}
	return err
}
