package upload

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Contract of the media normalization service (media-uploader schema/v1).
// The service knows nothing about the social API: URLs in, metadata out.

type MediaProcessorJob struct {
	Version   int                        `json:"version"`
	Type      string                     `json:"type"` // video | image
	Reference string                     `json:"reference"`
	Source    MediaProcessorSource       `json:"source"`
	Output    MediaProcessorOutput       `json:"output"`
	Thumbnail *MediaProcessorThumbnail   `json:"thumbnail,omitempty"`
	Rules     MediaProcessorRules        `json:"rules"`
	Limits    *MediaProcessorInputLimits `json:"limits,omitempty"`
}

type MediaProcessorSource struct {
	URL         string `json:"url"`
	ContentType string `json:"content_type,omitempty"`
}

type MediaProcessorOutput struct {
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
}

type MediaProcessorThumbnail struct {
	URL              string   `json:"url"`
	TimestampSeconds *float64 `json:"timestamp_seconds,omitempty"`
	ContentType      string   `json:"content_type,omitempty"` // image/jpeg
}

type MediaProcessorRules struct {
	ShortSideMin int                       `json:"short_side_min"`
	ShortSideMax int                       `json:"short_side_max"`
	LongSideMax  int                       `json:"long_side_max"`
	Video        *MediaProcessorVideoRules `json:"video,omitempty"`
	Image        *MediaProcessorImageRules `json:"image,omitempty"`
}

type MediaProcessorVideoRules struct {
	Container        string `json:"container,omitempty"`   // mp4
	VideoCodec       string `json:"video_codec,omitempty"` // h264
	Profile          string `json:"profile,omitempty"`
	PixelFormat      string `json:"pixel_format,omitempty"`
	FPSMax           *int   `json:"fps_max,omitempty"`
	Quality          *int   `json:"quality,omitempty"`
	AudioCodec       string `json:"audio_codec,omitempty"`
	AudioBitrateKbps *int   `json:"audio_bitrate_kbps,omitempty"`
	AudioSampleRate  *int   `json:"audio_sample_rate,omitempty"`
	Faststart        *bool  `json:"faststart,omitempty"`
}

type MediaProcessorImageRules struct {
	JPEGQuality *int  `json:"jpeg_quality,omitempty"`
	KeepFormat  *bool `json:"keep_format,omitempty"`
}

type MediaProcessorInputLimits struct {
	MaxInputBytes      *int64 `json:"max_input_bytes,omitempty"`
	MaxDurationSeconds *int   `json:"max_duration_seconds,omitempty"`
	TimeoutSeconds     *int   `json:"timeout_seconds,omitempty"`
}

type MediaProcessorResult struct {
	Version   int                         `json:"version"`
	Reference string                      `json:"reference"`
	Status    string                      `json:"status"` // completed | unchanged | failed
	Actions   []string                    `json:"actions"`
	Output    *MediaProcessorResultOutput `json:"output,omitempty"`
	Thumbnail *MediaProcessorResultThumb  `json:"thumbnail,omitempty"`
	Failure   *ProcessorFailure           `json:"failure,omitempty"`
}

type MediaProcessorResultOutput struct {
	Width           int      `json:"width"`
	Height          int      `json:"height"`
	DurationSeconds *float64 `json:"duration_seconds,omitempty"`
	Bytes           int64    `json:"bytes"`
	ContentType     string   `json:"content_type"`
}

type MediaProcessorResultThumb struct {
	Width  int   `json:"width"`
	Height int   `json:"height"`
	Bytes  int64 `json:"bytes"`
}

// MediaProcessorStatus is pending, completed with a Result, or failed: the
// queue itself failed (crash, expired job), retryable by the caller.
type MediaProcessorStatus[Result any] struct {
	Status string  `json:"status"` // pending | completed | failed
	Result *Result `json:"result,omitempty"`
	Error  string  `json:"error,omitempty"`
}

// MediaProcessor is IMediaProcessor.
type MediaProcessor[Job, Result any] interface {
	Submit(ctx context.Context, job Job) (string, error)
	Status(ctx context.Context, jobID string) (MediaProcessorStatus[Result], error)
}

// Contract of the ingest and clip jobs of the media service (media-uploader
// schema/v1, README 4.4 and 4.5). Same envelope and failure block as the
// normalization jobs: URLs in, metadata out.

type ProcessorFailure struct {
	Code       string  `json:"code"`
	Message    string  `json:"message"`
	Retryable  bool    `json:"retryable"`
	StderrTail *string `json:"stderr_tail,omitempty"`
}

type IngestJob struct {
	Version    int                        `json:"version"`
	Type       string                     `json:"type"` // ingest
	Reference  string                     `json:"reference"`
	Source     IngestSource               `json:"source"`
	Video      *URLTarget                 `json:"video,omitempty"`
	Audio      *IngestAudio               `json:"audio,omitempty"`
	Transcript *IngestTranscript          `json:"transcript,omitempty"`
	Limits     *MediaProcessorInputLimits `json:"limits,omitempty"`
}

type IngestSource struct {
	URL          string   `json:"url"`
	Via          string   `json:"via"` // direct | ytdlp | oxylabs
	MaxHeight    *int     `json:"max_height,omitempty"`
	StartSeconds *float64 `json:"start_seconds,omitempty"`
	EndSeconds   *float64 `json:"end_seconds,omitempty"`
}

type URLTarget struct {
	URL string `json:"url"`
}

type IngestAudio struct {
	URL              string `json:"url"`
	UnlessTranscript *bool  `json:"unless_transcript,omitempty"`
}

type IngestTranscript struct {
	URL       string   `json:"url"`
	Languages []string `json:"languages"`
}

// IngestResult: the transport may drop keys whose value is null, so a
// missing key is null.
type IngestResult struct {
	Version    int                     `json:"version"`
	Reference  string                  `json:"reference"`
	Status     string                  `json:"status"` // completed | failed
	Source     *IngestResultSource     `json:"source,omitempty"`
	Video      *IngestResultMedia      `json:"video,omitempty"`
	Audio      *IngestResultMedia      `json:"audio,omitempty"`
	Transcript *IngestResultTranscript `json:"transcript,omitempty"`
	Failure    *ProcessorFailure       `json:"failure,omitempty"`
}

type IngestResultSource struct {
	Title           *string     `json:"title,omitempty"`
	Description     *string     `json:"description,omitempty"`
	Uploader        *string     `json:"uploader,omitempty"`
	ThumbnailURL    *string     `json:"thumbnail_url,omitempty"`
	DurationSeconds *float64    `json:"duration_seconds,omitempty"`
	Trim            *IngestTrim `json:"trim,omitempty"`
}

type IngestTrim struct {
	StartSeconds float64 `json:"start_seconds"`
	EndSeconds   float64 `json:"end_seconds"`
}

type IngestResultMedia struct {
	Bytes           int64    `json:"bytes"`
	DurationSeconds *float64 `json:"duration_seconds,omitempty"`
}

type IngestResultTranscript struct {
	Language  string `json:"language"`
	Origin    string `json:"origin"` // auto_generated | uploader_provided
	WordLevel bool   `json:"word_level"`
	Segments  int    `json:"segments"`
	Words     int    `json:"words"`
}

type ClippingWord struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type ClippingSegment struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

// ClippingTranscript is the transcript file the ingest job writes; a
// transcription of the audio is stored in the same shape so everything
// downstream reads one format.
type ClippingTranscript struct {
	Version   int               `json:"version"`
	Language  string            `json:"language"`
	Origin    string            `json:"origin"` // auto_generated | uploader_provided | transcribed
	WordLevel bool              `json:"word_level"`
	Segments  []ClippingSegment `json:"segments"`
	Words     []ClippingWord    `json:"words"`
}

type ClipJob struct {
	Version   int           `json:"version"`
	Type      string        `json:"type"` // clip
	Reference string        `json:"reference"`
	Source    URLTarget     `json:"source"`
	Clips     []ClipJobClip `json:"clips"`
	Frame     ClipFrame     `json:"frame"`
	Captions  *ClipCaptions `json:"captions,omitempty"`
	Limits    *ClipLimits   `json:"limits,omitempty"`
}

type ClipJobClip struct {
	Reference    string         `json:"reference"`
	StartSeconds float64        `json:"start_seconds"`
	EndSeconds   float64        `json:"end_seconds"`
	Output       URLTarget      `json:"output"`
	Thumbnail    *ClipThumbnail `json:"thumbnail,omitempty"`
}

type ClipThumbnail struct {
	URL              string   `json:"url"`
	TimestampSeconds *float64 `json:"timestamp_seconds,omitempty"`
}

type ClipFrame struct {
	Width  int      `json:"width"`
	Height int      `json:"height"`
	Fit    string   `json:"fit"` // crop | blur
	FocusX *float64 `json:"focus_x,omitempty"`
	FocusY *float64 `json:"focus_y,omitempty"`
}

type ClipCaptions struct {
	Words []ClippingWord     `json:"words"`
	Style *ClipCaptionsStyle `json:"style,omitempty"`
}

type ClipCaptionsStyle struct {
	Font           string  `json:"font,omitempty"`
	HighlightColor *string `json:"highlight_color,omitempty"`
	Position       string  `json:"position,omitempty"` // top | middle | bottom
	MaxWords       *int    `json:"max_words,omitempty"`
	MaxChars       *int    `json:"max_chars,omitempty"`
	Uppercase      *bool   `json:"uppercase,omitempty"`
}

type ClipLimits struct {
	MaxInputBytes  *int64 `json:"max_input_bytes,omitempty"`
	MaxClipSeconds *int   `json:"max_clip_seconds,omitempty"`
	TimeoutSeconds *int   `json:"timeout_seconds,omitempty"`
}

type ClipResult struct {
	Version   int               `json:"version"`
	Reference string            `json:"reference"`
	Status    string            `json:"status"` // completed | partial | failed
	Clips     []ClipResultClip  `json:"clips"`
	Failure   *ProcessorFailure `json:"failure,omitempty"`
}

type ClipResultClip struct {
	Reference string             `json:"reference"`
	Status    string             `json:"status"` // completed | failed
	Output    *IngestResultMedia `json:"output,omitempty"`
	Thumbnail *struct {
		Bytes int64 `json:"bytes"`
	} `json:"thumbnail,omitempty"`
	Failure *ProcessorFailure `json:"failure,omitempty"`
}

// runpodBaseURL is overridden in tests.
var runpodBaseURL = "https://api.runpod.ai/v2/"

// RunPodMediaProcessor talks to a RunPod Serverless endpoint. RunPod wraps
// every request as {input} and every result as {id, status, output}. The
// worker returns failures as a normal result with status "failed" inside, so
// a RunPod-level FAILED is only an unhandled crash. Every job type of the
// service shares that envelope, so the endpoint decides what the job and
// result look like.
type RunPodMediaProcessor[Job, Result any] struct {
	apiKey  string
	baseURL string
}

func NewRunPodMediaProcessor[Job, Result any](apiKey, endpointID string) *RunPodMediaProcessor[Job, Result] {
	return &RunPodMediaProcessor[Job, Result]{apiKey: apiKey, baseURL: runpodBaseURL + endpointID}
}

func (p *RunPodMediaProcessor[Job, Result]) request(ctx context.Context, method, path string, body any, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := processorHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("RunPod %d: %s", res.StatusCode, truncate(string(data), 500))
	}
	return json.Unmarshal(data, out)
}

var processorHTTPClient = &http.Client{Timeout: 30 * time.Second}

// truncate is String.prototype.slice(0, n) (UTF-16 units approximated by
// runes).
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func (p *RunPodMediaProcessor[Job, Result]) Submit(ctx context.Context, job Job) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	if err := p.request(ctx, http.MethodPost, "/run", map[string]any{"input": job}, &out); err != nil {
		return "", err
	}
	if out.ID == "" {
		return "", errors.New("RunPod accepted the job without returning an id")
	}
	return out.ID, nil
}

func (p *RunPodMediaProcessor[Job, Result]) Status(ctx context.Context, jobID string) (MediaProcessorStatus[Result], error) {
	var out struct {
		Status string  `json:"status"`
		Output *Result `json:"output"`
		Error  any     `json:"error"`
	}
	if err := p.request(ctx, http.MethodGet, "/status/"+jobID, nil, &out); err != nil {
		return MediaProcessorStatus[Result]{}, err
	}
	switch out.Status {
	case "COMPLETED":
		return MediaProcessorStatus[Result]{Status: "completed", Result: out.Output}, nil
	case "FAILED", "CANCELLED", "TIMED_OUT":
		msg := out.Status
		if s, ok := out.Error.(string); ok && s != "" {
			msg = s
		} else if out.Error != nil && !ok {
			data, _ := json.Marshal(out.Error)
			msg = string(data)
		}
		return MediaProcessorStatus[Result]{Status: "failed", Error: msg}, nil
	}
	return MediaProcessorStatus[Result]{Status: "pending"}, nil
}
