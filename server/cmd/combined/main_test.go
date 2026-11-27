package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishingEnvKeepsTenantCredentialsSeparate(t *testing.T) {
	environ := []string{
		"DATABASE_URL=postgresql://social:one@db:5432/screenshot_studio",
		"TEMPORAL_NAMESPACE=social-namespace",
		"TENANT_DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio",
		"TENANT_TEMPORAL_ADDRESS=tenant-temporal:7233",
		"TENANT_TEMPORAL_NAMESPACE=tenant-namespace",
		"TENANT_AUDIT_RETENTION_DATABASE_URL=retention-database",
		"TENANT_RUN_MAINTENANCE=true",
		"TENANT_RUN_CRON=true",
		"TENANT_PUBLISHING_SERVICE_TOKEN=private-token",
		"TENANT_PORT=9999",
	}
	result, err := publishingEnv(environ)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio", "TEMPORAL_NAMESPACE=tenant-namespace", "AUDIT_RETENTION_DATABASE_URL=retention-database", "PORT=8081"} {
		if !hasEntry(result, expected) {
			t.Errorf("missing %s", strings.SplitN(expected, "=", 2)[0])
		}
	}
	for _, forbidden := range []string{"DATABASE_URL=postgresql://social:one@db:5432/screenshot_studio", "TEMPORAL_NAMESPACE=social-namespace", "PORT=9999"} {
		if hasEntry(result, forbidden) {
			t.Errorf("unexpected %s", forbidden)
		}
	}
	if !hasEntry(withPort(result, "8082"), "PORT=8082") {
		t.Fatal("publishing API port is missing")
	}
}

func TestPublishingEnvSharesTelemetrySettings(t *testing.T) {
	environ := []string{
		"TENANT_DATABASE_URL=tenant-database", "TENANT_TEMPORAL_ADDRESS=tenant-temporal:7233",
		"TENANT_TEMPORAL_NAMESPACE=tenant-namespace", "TENANT_AUDIT_RETENTION_DATABASE_URL=retention-database",
		"TENANT_RUN_CRON=true", "TENANT_RUN_MAINTENANCE=true", "TENANT_PUBLISHING_SERVICE_TOKEN=private-token",
		"OTEL_ENABLED=true", "OTEL_SAMPLING_RATE=0.01", "TENANT_OTEL_SAMPLING_RATE=0.5", "SERVICE_VERSION=abc123",
	}
	result, err := publishingEnv(environ)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"OTEL_ENABLED=true", "OTEL_SAMPLING_RATE=0.5", "SERVICE_VERSION=abc123"} {
		if !hasEntry(result, expected) {
			t.Errorf("missing %s", expected)
		}
	}
	if hasEntry(result, "OTEL_SAMPLING_RATE=0.01") {
		t.Error("the TENANT_ twin must win")
	}
}

func TestPublishingEnvSharesSocialCredentials(t *testing.T) {
	environ := []string{
		"TENANT_DATABASE_URL=tenant-database", "TENANT_TEMPORAL_ADDRESS=tenant-temporal:7233",
		"TENANT_TEMPORAL_NAMESPACE=tenant-namespace", "TENANT_AUDIT_RETENTION_DATABASE_URL=retention-database",
		"TENANT_RUN_CRON=true", "TENANT_RUN_MAINTENANCE=true", "TENANT_PUBLISHING_SERVICE_TOKEN=private-token",
		"PLATFORM_SOCIAL_ENCRYPTION_KEY=sealing-key", "TIKTOK_CLIENT_ID=tiktok-client", "TEMPORAL_API_KEY=social-temporal",
		"THREADS_APP_SECRET=threads-secret",
	}
	result, err := publishingEnv(environ)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"PLATFORM_SOCIAL_ENCRYPTION_KEY=sealing-key", "TIKTOK_CLIENT_ID=tiktok-client", "THREADS_APP_SECRET=threads-secret"} {
		if !hasEntry(result, expected) {
			t.Errorf("missing %s", expected)
		}
	}
	if hasEntry(result, "TEMPORAL_API_KEY=social-temporal") {
		t.Error("the worker must not get the social Temporal key")
	}
}

func TestPublishingEnvRequiresMaintenance(t *testing.T) {
	base := []string{
		"TENANT_DATABASE_URL=tenant-database", "TENANT_TEMPORAL_ADDRESS=tenant-temporal:7233",
		"TENANT_TEMPORAL_NAMESPACE=tenant-namespace", "TENANT_AUDIT_RETENTION_DATABASE_URL=retention-database",
		"TENANT_RUN_CRON=true", "TENANT_RUN_MAINTENANCE=false",
		"TENANT_PUBLISHING_SERVICE_TOKEN=private-token",
	}
	if _, err := publishingEnv(base); err == nil || !strings.Contains(err.Error(), "TENANT_RUN_MAINTENANCE=true") {
		t.Fatalf("expected maintenance configuration failure, got %v", err)
	}
}

func hasEntry(entries []string, value string) bool {
	for _, entry := range entries {
		if entry == value {
			return true
		}
	}
	return false
}

func TestAPIEnvServesMCPWithTenantSettings(t *testing.T) {
	environ := []string{
		"DATABASE_URL=postgresql://social:one@db:5432/screenshot_studio",
		"TENANT_DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio",
		"JWT_SECRET=oauth-clients", "PLATFORM_MCP_URL=https://mcp.example/mcp", "LINKEDIN_CLIENT_ID=linkedin",
		"TENANT_SOCIAL_API_URL=http://127.0.0.1:3000/public/v1",
	}
	tenantEnv := []string{"DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio",
		"SOCIAL_API_URL=http://127.0.0.1:3000/public/v1", "PORT=8081"}
	result := apiEnv(environ, tenantEnv)
	for _, expected := range []string{"PORT=8082", "PUBLIC_PORT=3000", "DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio",
		"JWT_SECRET=oauth-clients", "PLATFORM_MCP_URL=https://mcp.example/mcp", "LINKEDIN_CLIENT_ID=linkedin"} {
		if !hasEntry(result, expected) {
			t.Errorf("missing %s", expected)
		}
	}
	for _, forbidden := range []string{"PORT=8081", "DATABASE_URL=postgresql://social:one@db:5432/screenshot_studio",
		"SOCIAL_API_URL=http://127.0.0.1:3000/public/v1", "TENANT_DATABASE_URL=postgresql://tenant:two@db:5432/screenshot_studio"} {
		if hasEntry(result, forbidden) {
			t.Errorf("unexpected %s", forbidden)
		}
	}
}

func TestDetectContainerMemoryLimitAndApply(t *testing.T) {
	t.Run("cgroup_v2_root_splits_80_percent_across_children", func(t *testing.T) {
		root := t.TempDir()
		procFile := filepath.Join(root, "proc_cgroup")
		if err := os.WriteFile(procFile, []byte("0::/\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "memory.max"), []byte("1073741824\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		mem := detectContainerMemoryLimit(root, procFile)
		if mem != 1073741824 {
			t.Fatalf("unexpected v2 memory limit: %d", mem)
		}
		workerEnv := applyMemoryLimit([]string{"PORT=8081"}, mem, 0.35)
		apiChildEnv := applyMemoryLimit([]string{"PORT=8082"}, mem, 0.45)
		if !hasEntry(workerEnv, "GOMEMLIMIT=375809638B") {
			t.Fatalf("unexpected worker env: %v", workerEnv)
		}
		if !hasEntry(apiChildEnv, "GOMEMLIMIT=483183820B") {
			t.Fatalf("unexpected api env: %v", apiChildEnv)
		}
	})

	t.Run("cgroup_v2_nested_path_picks_tightest_ancestor_limit", func(t *testing.T) {
		root := t.TempDir()
		podDir := filepath.Join(root, "kubepods.slice", "pod123")
		leafDir := filepath.Join(podDir, "container456")
		if err := os.MkdirAll(leafDir, 0o700); err != nil {
			t.Fatal(err)
		}
		procFile := filepath.Join(root, "proc_cgroup")
		if err := os.WriteFile(procFile, []byte("0::/kubepods.slice/pod123/container456\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(podDir, "memory.max"), []byte("536870912\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(leafDir, "memory.max"), []byte("max\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if mem := detectContainerMemoryLimit(root, procFile); mem != 536870912 {
			t.Fatalf("expected ancestor limit 536870912, got %d", mem)
		}
	})

	t.Run("unlimited_and_zero_leave_env_unchanged", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "memory.max"), []byte("max\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "memory"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "memory", "memory.limit_in_bytes"), []byte("9223372036854771712\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		mem := detectContainerMemoryLimit(root, filepath.Join(root, "missing"))
		if mem != 0 {
			t.Fatalf("unlimited sentinel should yield 0, got %d", mem)
		}
		unchanged := applyMemoryLimit([]string{"PORT=8081"}, mem, 0.35)
		if len(unchanged) != 1 || unchanged[0] != "PORT=8081" {
			t.Fatalf("expected env unchanged, got %v", unchanged)
		}
	})

	t.Run("small_container_keeps_proportional_80_percent_total_and_v1_fallback_works", func(t *testing.T) {
		root := t.TempDir()
		v1Dir := filepath.Join(root, "memory", "docker", "abc")
		if err := os.MkdirAll(v1Dir, 0o700); err != nil {
			t.Fatal(err)
		}
		procFile := filepath.Join(root, "proc_cgroup")
		if err := os.WriteFile(procFile, []byte("4:memory:/docker/abc\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(v1Dir, "memory.limit_in_bytes"), []byte("134217728\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		mem := detectContainerMemoryLimit(root, procFile)
		if mem != 134217728 {
			t.Fatalf("expected v1 128MiB, got %d", mem)
		}
		// 128 MiB < 256 MiB threshold: worker gets 35% (46976204B) and API gets 45% (60397977B), total 80%.
		workerEnv := applyMemoryLimit([]string{}, mem, 0.35)
		apiChildEnv := applyMemoryLimit([]string{}, mem, 0.45)
		if !hasEntry(workerEnv, "GOMEMLIMIT=46976204B") || !hasEntry(apiChildEnv, "GOMEMLIMIT=60397977B") {
			t.Fatalf("small container must stay within 80%% total: worker=%v api=%v", workerEnv, apiChildEnv)
		}
	})

	t.Run("publishingEnv_and_apiEnv_honor_operator_GOMEMLIMIT_symmetrically", func(t *testing.T) {
		base := []string{
			"TENANT_DATABASE_URL=db", "TENANT_TEMPORAL_ADDRESS=t:7233", "TENANT_TEMPORAL_NAMESPACE=ns",
			"TENANT_AUDIT_RETENTION_DATABASE_URL=rdb", "TENANT_PUBLISHING_SERVICE_TOKEN=tok",
			"TENANT_RUN_MAINTENANCE=true", "TENANT_RUN_CRON=true", "GOMEMLIMIT=256MiB",
		}
		tenantEnv, err := publishingEnv(base)
		if err != nil {
			t.Fatal(err)
		}
		workerEnv := applyMemoryLimit(tenantEnv, 1<<30, 0.35)
		apiChildEnv := applyMemoryLimit(apiEnv(base, tenantEnv), 1<<30, 0.45)
		if !hasEntry(workerEnv, "GOMEMLIMIT=256MiB") || !hasEntry(apiChildEnv, "GOMEMLIMIT=256MiB") {
			t.Fatalf("operator GOMEMLIMIT must apply symmetrically: worker=%v api=%v", workerEnv, apiChildEnv)
		}
	})
}
