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
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	tenantPrefix      = "TENANT_"
	minChildMemLimit  = 64 << 20  // 64 MiB floor when container RAM >= 256 MiB
	minFloorContainer = 256 << 20 // below 256 MiB, strictly keep 35%/45% proportional shares
	cgroupUnlimitedV1 = int64(1) << 60
)

// socialCredentialKeys let the worker open sealed channel tokens and refresh
// them. Production sets them without a TENANT_ twin; see
// infra/digitalocean/consolidate-live-spec.py.
var socialCredentialKeys = []string{
	"PLATFORM_SOCIAL_ENCRYPTION_KEY", "PLATFORM_SOCIAL_ENCRYPTION_PREVIOUS_KEY",
	"LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "PLATFORM_LINKEDIN_PAGE_CLIENT_ID", "PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET",
	"X_API_KEY", "X_API_SECRET", "TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET",
	"FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET",
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
	memLimit := detectContainerMemoryLimit("/sys/fs/cgroup", "/proc/self/cgroup")
	children := []*exec.Cmd{
		exec.Command("/publishing-orchestrator"),
		exec.Command("/publishing-backend"),
	}
	// Go 1.26 natively sets cgroup-aware GOMAXPROCS; budget 80% of container RAM
	// across both Go child processes (35% worker, 45% API), leaving 20% headroom.
	children[0].Env = applyMemoryLimit(tenantEnv, memLimit, 0.35)
	children[1].Env = applyMemoryLimit(apiEnv(os.Environ(), tenantEnv), memLimit, 0.45)
	if memLimit > 0 {
		slog.Info("configured combined backend memory limits", "container_memory_bytes", memLimit)
	}
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
	// Both processes share the telemetry settings, the image's version, explicit
	// GOMEMLIMIT overrides, and the social credentials; a TENANT_ twin still wins.
	for _, item := range environ {
		key, _, _ := strings.Cut(item, "=")
		if (strings.HasPrefix(key, "OTEL_") || key == "SERVICE_VERSION" || key == "GOMEMLIMIT" || slices.Contains(socialCredentialKeys, key)) && !hasEnv(result, key) {
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

func parseMemoryFile(path string) int64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	text := strings.TrimSpace(string(raw))
	if text == "" || text == "max" {
		return 0
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil || n <= 0 || n >= cgroupUnlimitedV1 {
		return 0
	}
	return n
}

func minPositiveMemory(root, relPath, filename string) int64 {
	clean := filepath.Clean("/" + strings.TrimSpace(relPath))
	var lowest int64
	for {
		dir := root
		if clean != "/" && clean != "." {
			dir = filepath.Join(root, strings.TrimPrefix(clean, "/"))
		}
		if n := parseMemoryFile(filepath.Join(dir, filename)); n > 0 && (lowest == 0 || n < lowest) {
			lowest = n
		}
		if clean == "/" || clean == "." {
			break
		}
		clean = filepath.Dir(clean)
	}
	return lowest
}

// detectContainerMemoryLimit resolves the tightest finite Linux cgroup v2 or v1
// memory limit along the process's cgroup hierarchy (supporting both private
// cgroup namespaces and host-namespaced nested pod/container cgroups).
func detectContainerMemoryLimit(cgroupRoot, procSelfCgroup string) int64 {
	v2Path, v1MemPath := "/", "/"
	if raw, err := os.ReadFile(procSelfCgroup); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			parts := strings.SplitN(line, ":", 3)
			if len(parts) != 3 {
				continue
			}
			if parts[0] == "0" && parts[1] == "" {
				v2Path = parts[2]
			} else if slices.Contains(strings.Split(parts[1], ","), "memory") {
				v1MemPath = parts[2]
			}
		}
	}
	if n := minPositiveMemory(cgroupRoot, v2Path, "memory.max"); n > 0 {
		return n
	}
	return minPositiveMemory(filepath.Join(cgroupRoot, "memory"), v1MemPath, "memory.limit_in_bytes")
}

// applyMemoryLimit injects GOMEMLIMIT into a child environment when a finite
// container memory limit was detected and the operator did not already set it.
func applyMemoryLimit(environ []string, containerMemoryBytes int64, memoryShare float64) []string {
	result := slices.Clone(environ)
	if containerMemoryBytes > 0 && memoryShare > 0 && !hasEnv(result, "GOMEMLIMIT") {
		budget := int64(float64(containerMemoryBytes) * memoryShare)
		if containerMemoryBytes >= minFloorContainer && budget < minChildMemLimit {
			budget = minChildMemLimit
		}
		result = append(result, fmt.Sprintf("GOMEMLIMIT=%dB", budget))
	}
	return result
}
