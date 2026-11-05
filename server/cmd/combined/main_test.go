package main

import (
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
