// Command combined-backend runs the product API and the product worker
// (publishing, maintenance and channel token refresh) in one App Platform
// service.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

const tenantPrefix = "TENANT_"

// socialCredentialKeys let the worker open sealed channel tokens and refresh
// them. Production sets them without a TENANT_ twin; see
// infra/digitalocean/consolidate-live-spec.py.
var socialCredentialKeys = []string{
	"PLATFORM_SOCIAL_ENCRYPTION_KEY", "PLATFORM_SOCIAL_ENCRYPTION_PREVIOUS_KEY",
	"LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "PLATFORM_LINKEDIN_PAGE_CLIENT_ID", "PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET",
	"X_API_KEY", "X_API_SECRET", "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
	"FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET",
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("combined backend stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	tenantEnv, err := publishingEnv(os.Environ())
	if err != nil {
		return err
	}
	children := []*exec.Cmd{
		exec.Command("/publishing-orchestrator"),
		exec.Command("/publishing-backend"),
	}
	children[0].Env = tenantEnv
	children[1].Env = apiEnv(os.Environ(), tenantEnv)
	started := make([]*exec.Cmd, 0, len(children))
	for _, child := range children {
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			terminate(started)
			for _, running := range started {
				_ = running.Wait()
			}
			return fmt.Errorf("start %s: %w", child.Path, err)
		}
		started = append(started, child)
		slog.Info("started backend process", "process", child.Path, "pid", child.Process.Pid)
	}

	server := &http.Server{Addr: ":3003", Handler: readinessHandler(), ReadHeaderTimeout: 5 * time.Second}
	serverErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()
	childExit := make(chan error, len(children))
	for _, child := range children {
		go func(child *exec.Cmd) {
			childExit <- fmt.Errorf("%s exited: %w", child.Path, child.Wait())
		}(child)
	}
	var reason error
	exited := 0
	select {
	case reason = <-childExit:
		exited++
	case reason = <-serverErr:
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = server.Shutdown(shutdownCtx)
	cancel()
	terminate(children)
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	for exited < len(children) {
		select {
		case <-childExit:
			exited++
		case <-timer.C:
			for _, child := range children {
				_ = child.Process.Kill()
			}
			for exited < len(children) {
				<-childExit
				exited++
			}
		}
	}
	if reason != nil {
		return reason
	}
	return nil
}

func publishingEnv(environ []string) ([]string, error) {
	result := []string{"TZ=UTC"}
	for _, item := range environ {
		key, value, ok := strings.Cut(item, "=")
		if !ok || !strings.HasPrefix(key, tenantPrefix) {
			continue
		}
		name := strings.TrimPrefix(key, tenantPrefix)
		if name != "PORT" {
			result = append(result, name+"="+value)
		}
	}
	// Both processes share the telemetry settings, the image's version and the
	// social credentials; a TENANT_ twin still wins.
	for _, item := range environ {
		key, _, _ := strings.Cut(item, "=")
		if (strings.HasPrefix(key, "OTEL_") || key == "SERVICE_VERSION" || slices.Contains(socialCredentialKeys, key)) && !hasEnv(result, key) {
			result = append(result, item)
		}
	}
	result = append(result, "PORT=8081")
	for _, key := range []string{"DATABASE_URL", "TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "AUDIT_RETENTION_DATABASE_URL", "PUBLISHING_SERVICE_TOKEN"} {
		if !hasEnv(result, key) {
			return nil, fmt.Errorf("TENANT_%s is required", key)
		}
	}
	for _, key := range []string{"RUN_MAINTENANCE", "RUN_CRON"} {
		if !hasValue(result, key, "true") {
			return nil, fmt.Errorf("TENANT_%s=true is required", key)
		}
	}
	return result, nil
}

// apiEnv is the product API's environment: the tenant settings plus the
// settings without a TENANT_ twin (social provider credentials, JWT_SECRET,
// PLATFORM_MCP_URL), which it needs to connect channels and serve MCP on the
// public port. Channels connect in process, so SOCIAL_API_URL is dropped.
func apiEnv(environ, tenantEnv []string) []string {
	result := []string{"PUBLIC_PORT=3000"}
	for _, item := range withPort(tenantEnv, "8082") {
		if !strings.HasPrefix(item, "SOCIAL_API_URL=") {
			result = append(result, item)
		}
	}
	for _, item := range environ {
		key, _, ok := strings.Cut(item, "=")
		if ok && !strings.HasPrefix(key, tenantPrefix) && !hasEnv(environ, tenantPrefix+key) && !hasEnv(result, key) {
			result = append(result, item)
		}
	}
	return result
}

func withPort(environ []string, port string) []string {
	result := make([]string, 0, len(environ))
	for _, item := range environ {
		if strings.HasPrefix(item, "PORT=") {
			result = append(result, "PORT="+port)
		} else {
			result = append(result, item)
		}
	}
	return result
}

func hasEnv(environ []string, key string) bool {
	for _, item := range environ {
		if strings.HasPrefix(item, key+"=") && len(item) > len(key)+1 {
			return true
		}
	}
	return false
}

func hasValue(environ []string, key, value string) bool {
	for _, item := range environ {
		if item == key+"="+value {
			return true
		}
	}
	return false
}

func terminate(children []*exec.Cmd) {
	for _, child := range children {
		if child.Process != nil {
			_ = child.Process.Signal(syscall.SIGTERM)
		}
	}
}

func readinessHandler() http.Handler {
	client := &http.Client{Timeout: 7 * time.Second}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		endpoints := []string{"http://127.0.0.1:8081/readyz", "http://127.0.0.1:8082/readyz"}
		results := make(chan bool, len(endpoints))
		var checks sync.WaitGroup
		for _, endpoint := range endpoints {
			checks.Add(1)
			go func() {
				defer checks.Done()
				request, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
				response, err := client.Do(request)
				if err != nil {
					results <- false
					return
				}
				_ = response.Body.Close()
				results <- response.StatusCode == http.StatusOK
			}()
		}
		checks.Wait()
		close(results)
		for ready := range results {
			if !ready {
				http.Error(w, "backend component unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
}
