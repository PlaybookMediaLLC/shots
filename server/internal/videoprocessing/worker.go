package videoprocessing

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	TaskQueue    = "platform-video"
	WorkflowName = "video-transcode-v1"
	ActivityName = "video-transcode-run-v1"

	maxDurationSeconds = 7500 // ~2h05m hard ceiling to bound pathological timestamps
	heartbeatInterval  = 30 * time.Second
)

var sharedSafeHTTPClient = defaultSafeHTTPClient()

// TranscodeRequest carries ONLY short-lived presigned URLs and profile settings
// so the isolated video-worker holds zero database or provider credentials.
type TranscodeRequest struct {
	JobID          string                   `json:"jobId"`
	OrganizationID string                   `json:"organizationId"`
	SourceURL      string                   `json:"sourceUrl"`
	OutputPutURL   string                   `json:"outputPutUrl"`
	ProfileName    string                   `json:"profileName"`
	Profile        medialimits.VideoProfile `json:"profile"`
}

// TranscodeResult reports the produced derivative's verified size and elapsed time.
type TranscodeResult struct {
	OutputBytes int64 `json:"outputBytes"`
	ElapsedMs   int64 `json:"elapsedMs"`
}

// Activities executes sandboxed FFmpeg normalization against presigned URLs.
type Activities struct {
	FFmpegPath           string
	HTTP                 *http.Client
	Timeout              time.Duration
	AllowedHosts         []string
	AllowInsecureForTest bool
}

// Register binds VideoTranscodeWorkflowV1 and its activity to a Temporal worker.
func Register(w worker.Worker, act *Activities) {
	w.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterActivityWithOptions(act.Run, activity.RegisterOptions{Name: ActivityName})
}

// Workflow orchestrates one bounded, non-retrying-on-corrupt-media video transcode.
func Workflow(ctx workflow.Context, req TranscodeRequest) (TranscodeResult, error) {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout:    10 * time.Minute,
		ScheduleToCloseTimeout: 30 * time.Minute,
		HeartbeatTimeout:       2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:        5 * time.Second,
			MaximumInterval:        time.Minute,
			MaximumAttempts:        2,
			NonRetryableErrorTypes: []string{"VIDEO_PROCESSING_FAILED"},
		},
	})
	var res TranscodeResult
	err := workflow.ExecuteActivity(ctx, ActivityName, req).Get(ctx, &res)
	return res, err
}

// ffmpegArgs builds deterministic, sandboxed FFmpeg flags: local file protocol
// only, strict container demuxer whitelist, no stdin, single video+audio stream
// mapping, bounded duration, H.264 yuv420p + AAC-LC + faststart MP4.
func ffmpegArgs(inputPath, outputPath string, profile medialimits.VideoProfile) []string {
	maxEdge := profile.MaxEdge
	if maxEdge <= 0 {
		maxEdge = 1920
	}
	crf := profile.CRF
	if crf <= 0 || crf > 35 {
		crf = 22
	}
	audioK := profile.AudioBitrateK
	if audioK <= 0 {
		audioK = 160
	}
	maxFPS := profile.MaxFPS
	if maxFPS <= 0 {
		maxFPS = 30
	}
	// Scale down only if larger than maxEdge while keeping even dimensions required by yuv420p.
	scaleFilter := fmt.Sprintf("scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2", maxEdge, maxEdge)
	args := []string{
		"-y",
		"-nostdin",
		"-loglevel", "error",
		"-nostats",
		"-protocol_whitelist", "file",
		"-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm",
		"-i", inputPath,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-sn",
		"-dn",
		"-t", strconv.Itoa(maxDurationSeconds),
		"-vf", scaleFilter,
		"-fpsmax", strconv.Itoa(maxFPS),
		"-c:v", "libx264",
		"-preset", "medium",
		"-crf", strconv.Itoa(crf),
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-b:a", fmt.Sprintf("%dk", audioK),
		"-ac", "2",
		"-ar", "48000",
		"-movflags", "+faststart",
		"-map_metadata", "-1",
		"-max_muxing_queue_size", "1024",
		"-threads", "2",
	}
	if profile.MaxBytes > 0 {
		// Stop encoding immediately past MaxBytes+1 so oversized outputs still trip the explicit limit check below.
		args = append(args, "-fs", strconv.FormatInt(int64(profile.MaxBytes)+1, 10))
	}
	return append(args, outputPath)
}

func (a *Activities) resolvedAllowedHosts() []string {
	if len(a.AllowedHosts) > 0 {
		return a.AllowedHosts
	}
	raw := strings.TrimSpace(os.Getenv("VIDEO_WORKER_ALLOWED_HOSTS"))
	if raw == "" {
		return nil
	}
	var hosts []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.ToLower(strings.TrimSpace(part)); trimmed != "" {
			hosts = append(hosts, trimmed)
		}
	}
	return hosts
}

func isBlockedIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	return !publicnet.IsPublic(addr.Unmap())
}

func hostMatchesAllowlist(host string, allowed []string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	for _, entry := range allowed {
		e := strings.ToLower(strings.TrimSpace(entry))
		if e == "" {
			continue
		}
		if strings.HasPrefix(e, ".") {
			if strings.HasSuffix(h, e) && len(h) > len(e) {
				return true
			}
			continue
		}
		if h == e {
			return true
		}
	}
	return false
}

func validatePresignedURL(rawURL string, allowedHosts []string, allowInsecure bool) error {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return errors.New("malformed presigned URL")
	}
	if u.User != nil {
		return errors.New("presigned URL must not contain userinfo")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && (!allowInsecure || scheme != "http") {
		return fmt.Errorf("presigned URL scheme %q is not allowed", u.Scheme)
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("presigned URL missing hostname")
	}
	if len(allowedHosts) > 0 && !hostMatchesAllowlist(host, allowedHosts) {
		return fmt.Errorf("presigned URL host %q is not in allowed hosts", host)
	}
	if !allowInsecure {
		if ip := net.ParseIP(host); ip != nil && isBlockedIP(ip) {
			return fmt.Errorf("presigned URL IP %q is blocked", host)
		}
	}
	return nil
}

func defaultSafeHTTPClient() *http.Client {
	dialer := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("no IP addresses resolved for %q", host)
			}
			// Reject the entire host if any resolved address is non-public (blocks mixed-record rebinding).
			for _, ipAddr := range ips {
				if isBlockedIP(ipAddr.IP) {
					return nil, fmt.Errorf("blocked non-public IP %s for host %q", ipAddr.IP.String(), host)
				}
			}
			var lastErr error
			for _, ipAddr := range ips {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ipAddr.IP.String(), port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
			}
			return nil, lastErr
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          10,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 2 * time.Second,
	}
	return &http.Client{
		Timeout:   3 * time.Minute,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func validateVideoMagicBytes(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var header [12]byte
	n, err := io.ReadFull(f, header[:])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return err
	}
	// ISO BMFF (MP4, MOV, M4V, 3GP): "ftyp" box tag at offset 4.
	if n >= 8 && string(header[4:8]) == "ftyp" {
		return nil
	}
	// EBML (WebM, Matroska): 0x1A 0x45 0xDF 0xA3 at offset 0.
	if n >= 4 && header[0] == 0x1a && header[1] == 0x45 && header[2] == 0xdf && header[3] == 0xa3 {
		return nil
	}
	return temporal.NewNonRetryableApplicationError("unsupported video container", "VIDEO_PROCESSING_FAILED", nil)
}

func redactHTTPError(op string, err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return fmt.Errorf("%s failed: %w", op, urlErr.Err)
	}
	return fmt.Errorf("%s failed: %w", op, err)
}

func safeRecordHeartbeat(ctx context.Context, detail string) {
	defer func() {
		_ = recover()
	}()
	activity.RecordHeartbeat(ctx, detail)
}

func startHeartbeat(ctx context.Context) func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				safeRecordHeartbeat(ctx, "processing")
			}
		}
	}()
	return func() { close(done) }
}

// Run downloads the source via signed GET, verifies container magic bytes,
// transcodes in an isolated temp dir, verifies output bounds, and uploads via signed PUT.
func (a *Activities) Run(ctx context.Context, req TranscodeRequest) (TranscodeResult, error) {
	started := time.Now()
	timeout := a.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	stopHeartbeat := startHeartbeat(runCtx)
	defer stopHeartbeat()

	allowedHosts := a.resolvedAllowedHosts()
	if err := validatePresignedURL(req.SourceURL, allowedHosts, a.AllowInsecureForTest); err != nil {
		return TranscodeResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("invalid source URL: %v", err),
			"VIDEO_PROCESSING_FAILED",
			err,
		)
	}
	if err := validatePresignedURL(req.OutputPutURL, allowedHosts, a.AllowInsecureForTest); err != nil {
		return TranscodeResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("invalid output URL: %v", err),
			"VIDEO_PROCESSING_FAILED",
			err,
		)
	}

	dir, err := os.MkdirTemp("", "shots-video-*")
	if err != nil {
		return TranscodeResult{}, err
	}
	defer os.RemoveAll(dir)

	inputPath := filepath.Join(dir, "input.bin")
	outputPath := filepath.Join(dir, "output.mp4")

	client := a.HTTP
	if client == nil {
		client = sharedSafeHTTPClient
	}
	if err := downloadFile(runCtx, client, req.SourceURL, inputPath, int64(medialimits.Limits.VideoBytes)); err != nil {
		return TranscodeResult{}, err
	}
	if err := validateVideoMagicBytes(inputPath); err != nil {
		return TranscodeResult{}, err
	}
	safeRecordHeartbeat(runCtx, "transcoding")

	bin := a.FFmpegPath
	if bin == "" {
		bin = "ffmpeg"
	}
	cmd := exec.CommandContext(runCtx, bin, ffmpegArgs(inputPath, outputPath, req.Profile)...)
	cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin"}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		if runCtx.Err() != nil {
			// Worker shutdown or activity timeout is retryable; do not misclassify as corrupt media.
			return TranscodeResult{}, runCtx.Err()
		}
		return TranscodeResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("video transcode failed: %v", err),
			"VIDEO_PROCESSING_FAILED",
			err,
		)
	}

	// Reclaim input disk space immediately before uploading the derivative.
	_ = os.Remove(inputPath)

	stat, err := os.Stat(outputPath)
	if err != nil || stat.Size() == 0 {
		return TranscodeResult{}, temporal.NewNonRetryableApplicationError(
			"transcoded video output is empty",
			"VIDEO_PROCESSING_FAILED",
			err,
		)
	}
	if req.Profile.MaxBytes > 0 && stat.Size() > int64(req.Profile.MaxBytes) {
		return TranscodeResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("transcoded video exceeds destination limit (%d > %d bytes)", stat.Size(), req.Profile.MaxBytes),
			"VIDEO_PROCESSING_FAILED",
			nil,
		)
	}

	safeRecordHeartbeat(runCtx, "uploading")
	if err := uploadFile(runCtx, client, req.OutputPutURL, outputPath, stat.Size()); err != nil {
		return TranscodeResult{}, err
	}
	return TranscodeResult{
		OutputBytes: stat.Size(),
		ElapsedMs:   time.Since(started).Milliseconds(),
	}, nil
}

func downloadFile(ctx context.Context, client *http.Client, rawURL, dest string, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return redactHTTPError("build source download request", err)
	}
	res, err := client.Do(req)
	if err != nil {
		return redactHTTPError("download source", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("download source returned %d", res.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(f, io.LimitReader(res.Body, limit+1))
	if copyErr != nil {
		_ = f.Close()
		return copyErr
	}
	if n > limit {
		_ = f.Close()
		return temporal.NewNonRetryableApplicationError("source video exceeds maximum size", "VIDEO_PROCESSING_FAILED", nil)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func uploadFile(ctx context.Context, client *http.Client, rawURL, src string, size int64) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, rawURL, f)
	if err != nil {
		return redactHTTPError("build derivative upload request", err)
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", "video/mp4")
	res, err := client.Do(req)
	if err != nil {
		return redactHTTPError("upload derivative", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("upload derivative returned %d", res.StatusCode)
	}
	return nil
}
