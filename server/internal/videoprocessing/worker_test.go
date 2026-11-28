package videoprocessing

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func TestValidatePresignedURLAndSSRFGuards(t *testing.T) {
	// Reject http, userinfo, loopback, private, link-local metadata, reserved, and disallowed hosts.
	rejected := []struct {
		name    string
		url     string
		allowed []string
	}{
		{"plain http", "http://storage.example.com/v.mp4", nil},
		{"userinfo", "https://user:pass@storage.example.com/v.mp4", nil},
		{"loopback ipv4", "https://127.0.0.1/v.mp4", nil},
		{"metadata link-local", "https://169.254.169.254/latest/meta-data", nil},
		{"private rfc1918", "https://10.0.0.5/v.mp4", nil},
		{"cgnat", "https://100.64.0.1/v.mp4", nil},
		{"zero network", "https://0.1.2.3/v.mp4", nil},
		{"not in allowlist", "https://evil.example.net/v.mp4", []string{".r2.cloudflarestorage.com"}},
	}
	for _, tc := range rejected {
		if err := validatePresignedURL(tc.url, tc.allowed, false); err == nil {
			t.Errorf("%s: expected error for %q", tc.name, tc.url)
		}
	}

	// Accept valid HTTPS storage URLs matching allowlist.
	if err := validatePresignedURL("https://bucket.r2.cloudflarestorage.com/org/video.mp4?X-Amz-Signature=abc", []string{".r2.cloudflarestorage.com"}, false); err != nil {
		t.Fatalf("expected valid R2 URL to pass, got %v", err)
	}
}

func TestValidateVideoMagicBytes(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content []byte
		wantOK  bool
	}{
		{"mp4 ftyp", []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}, true},
		{"webm ebml", []byte{0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81}, true},
		{"html polyglot", []byte("<!doctype html><html><body>hi</body></html>"), false},
		{"hls playlist", []byte("#EXTM3U\n#EXT-X-TARGETDURATION:10\n"), false},
		{"empty file", nil, false},
	}
	for _, tc := range cases {
		p := filepath.Join(dir, tc.name+".bin")
		if err := os.WriteFile(p, tc.content, 0o600); err != nil {
			t.Fatal(err)
		}
		err := validateVideoMagicBytes(p)
		if tc.wantOK && err != nil {
			t.Errorf("%s: expected valid magic bytes, got %v", tc.name, err)
		}
		if !tc.wantOK {
			var appErr *temporal.ApplicationError
			if !errors.As(err, &appErr) || !appErr.NonRetryable() || appErr.Type() != "VIDEO_PROCESSING_FAILED" {
				t.Errorf("%s: expected non-retryable VIDEO_PROCESSING_FAILED, got %v", tc.name, err)
			}
		}
	}
}

func TestDefaultSafeHTTPClientBlocksRedirectsAndLoopbackDial(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
	}))
	defer srv.Close()

	client := defaultSafeHTTPClient()
	// Verify CheckRedirect refuses to follow redirects.
	err := client.CheckRedirect(httptest.NewRequest(http.MethodGet, srv.URL, nil), nil)
	if !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("expected CheckRedirect to return ErrUseLastResponse, got %v", err)
	}

	// Verify real DialContext blocks connecting to loopback (127.0.0.1) and downloadFile redacts presigned query secrets.
	secretURL := srv.URL + "/video.mp4?X-Amz-Signature=supersecretvalue123"
	dest := filepath.Join(t.TempDir(), "blocked.bin")
	err = downloadFile(context.Background(), client, secretURL, dest, 1024)
	if err == nil || !strings.Contains(err.Error(), "blocked non-public IP") {
		t.Fatalf("expected DialContext to reject loopback with 'blocked non-public IP', got %v", err)
	}
	if strings.Contains(err.Error(), "supersecretvalue123") {
		t.Fatalf("presigned URL signature leaked into error message: %v", err)
	}
}

func TestDownloadFileEnforcesLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("a"), 128))
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "out.bin")
	err := downloadFile(context.Background(), srv.Client(), srv.URL, dest, 64)
	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) || !appErr.NonRetryable() || appErr.Type() != "VIDEO_PROCESSING_FAILED" {
		t.Fatalf("expected non-retryable VIDEO_PROCESSING_FAILED on oversized download, got %v", err)
	}
}

func TestFFmpegArgsHardeningFlags(t *testing.T) {
	args := ffmpegArgs("/tmp/in.mp4", "/tmp/out.mp4", medialimits.VideoProfile{
		MaxBytes: 10_000_000,
		MaxEdge:  1920,
		MaxFPS:   60,
		CRF:      22,
	})
	for _, flag := range []string{"-protocol_whitelist", "-format_whitelist", "-fpsmax", "-t", "-sn", "-dn", "-fs", "-loglevel"} {
		if !slices.Contains(args, flag) {
			t.Errorf("expected hardened ffmpegArgs to contain %q, got %v", flag, args)
		}
	}
	protoIdx := slices.Index(args, "-protocol_whitelist")
	if protoIdx < 0 || protoIdx+1 >= len(args) || args[protoIdx+1] != "file" {
		t.Errorf("expected -protocol_whitelist file, got %v", args)
	}
	if slices.Contains(args, "-r") {
		t.Errorf("expected -fpsmax instead of CFR -r in ffmpegArgs, got %v", args)
	}
}

func TestWorkflowRetryPolicy(t *testing.T) {
	t.Run("non-retryable VIDEO_PROCESSING_FAILED stops on first attempt", func(t *testing.T) {
		var suite testsuite.WorkflowTestSuite
		env := suite.NewTestWorkflowEnvironment()
		attempts := 0
		env.RegisterActivityWithOptions(func(context.Context, TranscodeRequest) (TranscodeResult, error) {
			attempts++
			return TranscodeResult{}, temporal.NewNonRetryableApplicationError("bad container", "VIDEO_PROCESSING_FAILED", nil)
		}, activity.RegisterOptions{Name: ActivityName})
		env.ExecuteWorkflow(Workflow, TranscodeRequest{JobID: "job-nr"})
		if env.GetWorkflowError() == nil || attempts != 1 {
			t.Fatalf("expected 1 attempt and error for VIDEO_PROCESSING_FAILED, got attempts=%d err=%v", attempts, env.GetWorkflowError())
		}
	})

	t.Run("transient error retries up to MaximumAttempts=2", func(t *testing.T) {
		var suite testsuite.WorkflowTestSuite
		env := suite.NewTestWorkflowEnvironment()
		attempts := 0
		env.RegisterActivityWithOptions(func(context.Context, TranscodeRequest) (TranscodeResult, error) {
			attempts++
			if attempts == 1 {
				return TranscodeResult{}, errors.New("temporary network blip")
			}
			return TranscodeResult{OutputBytes: 42}, nil
		}, activity.RegisterOptions{Name: ActivityName})
		env.ExecuteWorkflow(Workflow, TranscodeRequest{JobID: "job-retry"})
		if err := env.GetWorkflowError(); err != nil {
			t.Fatalf("expected second attempt to succeed, got %v", err)
		}
		var res TranscodeResult
		if err := env.GetWorkflowResult(&res); err != nil || res.OutputBytes != 42 || attempts != 2 {
			t.Fatalf("expected 2 attempts and OutputBytes=42, got attempts=%d res=%+v err=%v", attempts, res, err)
		}
	})
}

func writeStubFFmpeg(t *testing.T, script string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fake-ffmpeg.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestActivitiesRunLifecycle(t *testing.T) {
	validMP4 := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0x00, 0x00, 0x00, 0x00}
	var uploaded []byte

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write(validMP4)
		case http.MethodPut:
			body, _ := io.ReadAll(r.Body)
			uploaded = body
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	// 1. Happy path with stub ffmpeg writing last arg.
	okBin := writeStubFFmpeg(t, `out=""; for a in "$@"; do out="$a"; done; printf 'ftypoutput123456' > "$out"`)
	acts := &Activities{
		FFmpegPath:           okBin,
		HTTP:                 srv.Client(),
		AllowInsecureForTest: true,
	}
	res, err := acts.Run(context.Background(), TranscodeRequest{
		JobID:        "job-1",
		SourceURL:    srv.URL + "/in.mp4",
		OutputPutURL: srv.URL + "/out.mp4",
		Profile:      medialimits.VideoProfile{MaxBytes: 1024, MaxEdge: 1920, MaxFPS: 30, CRF: 22},
	})
	if err != nil {
		t.Fatalf("expected happy path to succeed, got %v", err)
	}
	if res.OutputBytes != int64(len("ftypoutput123456")) || string(uploaded) != "ftypoutput123456" {
		t.Fatalf("unexpected upload result: res=%+v uploaded=%q", res, string(uploaded))
	}

	// 2. Oversized output returns non-retryable VIDEO_PROCESSING_FAILED.
	_, err = acts.Run(context.Background(), TranscodeRequest{
		JobID:        "job-2",
		SourceURL:    srv.URL + "/in.mp4",
		OutputPutURL: srv.URL + "/out.mp4",
		Profile:      medialimits.VideoProfile{MaxBytes: 4, MaxEdge: 1920, MaxFPS: 30, CRF: 22},
	})
	var appErr *temporal.ApplicationError
	if !errors.As(err, &appErr) || !appErr.NonRetryable() || appErr.Type() != "VIDEO_PROCESSING_FAILED" {
		t.Fatalf("expected non-retryable VIDEO_PROCESSING_FAILED for oversized output, got %v", err)
	}

	// 3. Non-zero FFmpeg exit returns non-retryable VIDEO_PROCESSING_FAILED.
	failBin := writeStubFFmpeg(t, `echo "corrupt stream" >&2; exit 1`)
	acts.FFmpegPath = failBin
	_, err = acts.Run(context.Background(), TranscodeRequest{
		JobID:        "job-3",
		SourceURL:    srv.URL + "/in.mp4",
		OutputPutURL: srv.URL + "/out.mp4",
		Profile:      medialimits.VideoProfile{MaxBytes: 1024},
	})
	if !errors.As(err, &appErr) || !appErr.NonRetryable() || appErr.Type() != "VIDEO_PROCESSING_FAILED" {
		t.Fatalf("expected non-retryable VIDEO_PROCESSING_FAILED on ffmpeg exit 1, got %v", err)
	}

	// 4. Context cancellation during FFmpeg returns retryable context error (NOT non-retryable).
	sleepBin := writeStubFFmpeg(t, `sleep 5`)
	acts.FFmpegPath = sleepBin
	acts.Timeout = 100 * time.Millisecond
	_, err = acts.Run(context.Background(), TranscodeRequest{
		JobID:        "job-4",
		SourceURL:    srv.URL + "/in.mp4",
		OutputPutURL: srv.URL + "/out.mp4",
		Profile:      medialimits.VideoProfile{MaxBytes: 1024},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected retryable context.DeadlineExceeded on timeout, got %v", err)
	}
}
