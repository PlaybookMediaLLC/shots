package config

import "testing"

func TestLoadBackendRequiresServiceToken(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("PUBLISHING_SERVICE_TOKEN", "")
	if _, err := LoadBackend(); err == nil {
		t.Fatal("expected missing PUBLISHING_SERVICE_TOKEN to fail")
	}
}

func TestLoadOrchestratorRejectsInvalidTemporalConcurrency(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("STORAGE_API_URL", "http://storage")
	t.Setenv("STORAGE_BUCKET", "assets")
	t.Setenv("STORAGE_SERVICE_KEY", "service-key")
	t.Setenv("TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTORS", "0")
	if _, err := LoadOrchestrator(); err == nil {
		t.Fatal("expected nonpositive Temporal activity concurrency to fail")
	}
}

func TestLoadBackendRejectsInvalidTemporalTLS(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("PUBLISHING_SERVICE_TOKEN", "secret")
	t.Setenv("TEMPORAL_TLS", "sometimes")
	if _, err := LoadBackend(); err == nil {
		t.Fatal("expected invalid TEMPORAL_TLS to fail")
	}
}

func TestLoadOrchestratorReadsSocialWorkerControls(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("STORAGE_API_URL", "http://storage")
	t.Setenv("STORAGE_BUCKET", "assets")
	t.Setenv("STORAGE_SERVICE_KEY", "service-key")
	t.Setenv("EXCLUDE_QUEUE", "reddit, social, ")
	t.Setenv("WORKER_CONCURRENCY_DIVIDER", "3")
	t.Setenv("RUN_CRON", "true")
	cfg, err := LoadOrchestrator()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.RunCron || cfg.WorkerConcurrencyDivider != 3 || len(cfg.ExcludedQueues) != 2 || cfg.ExcludedQueues[1] != "social" {
		t.Fatalf("unexpected worker controls: %#v", cfg)
	}
}

func TestLoadTelemetryIsOffByDefault(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "")
	t.Setenv("OTEL_SAMPLING_RATE", "not-a-number")
	cfg, err := LoadTelemetry()
	if err != nil || cfg.Enabled {
		t.Fatalf("expected telemetry off without validating the rest, got %#v, %v", cfg, err)
	}
}

func TestLoadTelemetryDefaultsToOnePercent(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.axiom.co")
	cfg, err := LoadTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Traces || !cfg.Metrics || cfg.SamplingRate != 0.01 || cfg.SlowSpan.Seconds() != 2 || cfg.PromotedSpansPerSecond != 10 {
		t.Fatalf("unexpected defaults: %#v", cfg)
	}
}

func TestLoadTelemetryRejectsInvalidSettings(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"missing endpoint":   {"OTEL_EXPORTER_OTLP_ENDPOINT": ""},
		"rate above one":     {"OTEL_SAMPLING_RATE": "1.5"},
		"negative rate":      {"OTEL_SAMPLING_RATE": "-0.1"},
		"rate not a number":  {"OTEL_SAMPLING_RATE": "1%"},
		"rate NaN":           {"OTEL_SAMPLING_RATE": "NaN"},
		"zero batch delay":   {"OTEL_BSP_SCHEDULE_DELAY": "0"},
		"bad queue size":     {"OTEL_BSP_MAX_QUEUE_SIZE": "big"},
		"bad threshold":      {"OTEL_SLOW_SPAN_THRESHOLD": "2"},
		"negative promotion": {"OTEL_PROMOTED_SPANS_PER_SECOND": "-1"},
		"unknown exporter":   {"OTEL_TRACES_EXPORTER": "jaeger"},
		"enabled not bool":   {"OTEL_ENABLED": "yes"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("OTEL_ENABLED", "true")
			t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.axiom.co")
			for key, value := range env {
				t.Setenv(key, value)
			}
			if _, err := LoadTelemetry(); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestLoadTelemetryTurnsSignalsOffIndependently(t *testing.T) {
	t.Setenv("OTEL_ENABLED", "true")
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://api.axiom.co/v1/traces")
	t.Setenv("OTEL_METRICS_EXPORTER", "none")
	cfg, err := LoadTelemetry()
	if err != nil || !cfg.Traces || cfg.Metrics {
		t.Fatalf("expected traces only, got %#v, %v", cfg, err)
	}
}

func TestLoadOrchestratorRejectsInvalidRunCron(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("STORAGE_API_URL", "http://storage")
	t.Setenv("STORAGE_BUCKET", "assets")
	t.Setenv("STORAGE_SERVICE_KEY", "service-key")
	t.Setenv("RUN_CRON", "sometimes")
	if _, err := LoadOrchestrator(); err == nil {
		t.Fatal("expected invalid RUN_CRON to fail")
	}
}

func TestMaintenanceRequiresDedicatedDependencies(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://runtime")
	t.Setenv("STORAGE_API_URL", "http://storage")
	t.Setenv("STORAGE_BUCKET", "assets")
	t.Setenv("STORAGE_SERVICE_KEY", "key")
	t.Setenv("RUN_MAINTENANCE", "true")
	t.Setenv("AUDIT_DRAIN_ENCRYPTION_KEY", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
	t.Setenv("AUDIT_RETENTION_DATABASE_URL", "")
	if _, err := LoadOrchestrator(); err == nil {
		t.Fatal("maintenance accepted missing retention credentials")
	}
	t.Setenv("AUDIT_RETENTION_DATABASE_URL", "postgresql://retention")
	t.Setenv("RESEND_API_KEY", "resend-test")
	t.Setenv("AUTH_EMAIL_FROM", "test@example.invalid")
	t.Setenv("BETTER_AUTH_SECRET", "test-secret")
	t.Setenv("BETTER_AUTH_URL", "https://app.example")
	cfg, err := LoadOrchestrator()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.RunMaintenance || len(cfg.AuditDrainEncryptionKey) != 32 {
		t.Fatal("maintenance configuration not loaded")
	}
	t.Setenv("BETTER_AUTH_URL", "http://app.example")
	if _, err := LoadOrchestrator(); err == nil {
		t.Fatal("insecure unsubscribe origin accepted")
	}
	for _, origin := range []string{"http://localhost:4001", "http://127.0.0.1:4001", "http://[::1]:4001"} {
		t.Setenv("BETTER_AUTH_URL", origin)
		if _, err := LoadOrchestrator(); err != nil {
			t.Fatalf("local maintenance origin %s: %v", origin, err)
		}
	}
}
