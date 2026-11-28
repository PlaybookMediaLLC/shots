// Command video-worker runs the isolated Temporal worker for server-side video
// normalization on the `platform-video` task queue. It holds zero database or
// social-provider credentials and operates solely on short-lived presigned URLs.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/videoprocessing"
	"go.temporal.io/sdk/worker"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	temporalCfg, err := config.LoadTemporal()
	if err != nil {
		logger.Error("invalid Temporal configuration", "error", err)
		os.Exit(1)
	}
	client, err := temporalpublishing.Dial(ctx, temporalpublishing.ConnectionConfig{
		Address:   temporalCfg.Address,
		Namespace: temporalCfg.Namespace,
		APIKey:    temporalCfg.APIKey,
		TLS:       temporalCfg.TLS,
	})
	// Scrub Temporal API credentials from process environment before any FFmpeg subprocess can run.
	_ = os.Unsetenv("TEMPORAL_API_KEY")
	if err != nil {
		logger.Error("failed to connect to Temporal", "error", err)
		os.Exit(1)
	}
	defer client.Close()

	w := worker.New(client, videoprocessing.TaskQueue, worker.Options{
		MaxConcurrentActivityExecutionSize: 2,
		BackgroundActivityContext:          ctx,
		WorkerStopTimeout:                  30 * time.Second,
	})
	videoprocessing.Register(w, &videoprocessing.Activities{
		FFmpegPath: os.Getenv("FFMPEG_PATH"),
	})

	logger.Info("starting isolated video-worker", "taskQueue", videoprocessing.TaskQueue)
	if err := w.Run(worker.InterruptCh()); err != nil {
		logger.Error("video-worker stopped with error", "error", err)
		os.Exit(1)
	}
}
