package config

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Common struct {
	DatabaseURL string
	Port        int
}

type Temporal struct {
	APIKey            string
	ActivityTaskQueue string
	Address           string
	Namespace         string
	TLS               bool
	WorkflowTaskQueue string
}

type Backend struct {
	Common
	Temporal
	ActivityTimeout time.Duration
	MaxAttempts     int
	RetryDelay      time.Duration
	ServiceToken    string
}

type Orchestrator struct {
	Common
	Temporal
	ActivityConcurrency       int
	ActivityTimeout           time.Duration
	ExcludedQueues            []string
	MaxAttempts               int
	RetryDelay                time.Duration
	RunCron                   bool
	RunMaintenance            bool
	AuditRetentionDatabaseURL string
	AuditDrainEncryptionKey   []byte
	// WebhookEncryptionKey seals outbound webhook secrets (RFC 024); without
	// it outbound webhooks are unavailable.
	WebhookEncryptionKey     []byte
	ResendAPIKey             string
	EmailFrom                string
	AuthBaseURL              string
	AuthSecret               string
	CompanyPostalAddress     string
	WorkerConcurrencyDivider int
}

func LoadBackend() (Backend, error) {
	common, err := loadCommon(8080)
	if err != nil {
		return Backend{}, err
	}
	temporal, err := loadTemporal()
	if err != nil {
		return Backend{}, err
	}
	cfg := Backend{
		Common: common, Temporal: temporal,
		ActivityTimeout: envDuration("PUBLISHING_ACTIVITY_TIMEOUT", 30*time.Minute),
		MaxAttempts:     envInt("PUBLISHING_MAX_ATTEMPTS", 3),
		RetryDelay:      envDuration("PUBLISHING_RETRY_DELAY", 2*time.Minute),
		ServiceToken:    os.Getenv("PUBLISHING_SERVICE_TOKEN"),
	}
	if cfg.ServiceToken == "" {
		return Backend{}, fmt.Errorf("PUBLISHING_SERVICE_TOKEN is required")
	}
	if cfg.MaxAttempts < 1 || cfg.MaxAttempts > 10 {
		return Backend{}, fmt.Errorf("PUBLISHING_MAX_ATTEMPTS must be between 1 and 10")
	}
	if cfg.ActivityTimeout <= 0 || cfg.RetryDelay <= 0 {
		return Backend{}, fmt.Errorf("publishing activity timeout and retry delay must be positive")
	}
	return cfg, nil
}

func LoadOrchestrator() (Orchestrator, error) {
	common, err := loadCommon(8081)
	if err != nil {
		return Orchestrator{}, err
	}
	temporal, err := loadTemporal()
	if err != nil {
		return Orchestrator{}, err
	}
	runCron, err := envBool("RUN_CRON", false)
	if err != nil {
		return Orchestrator{}, err
	}
	runMaintenance, err := envBool("RUN_MAINTENANCE", false)
	if err != nil {
		return Orchestrator{}, err
	}
	cfg := Orchestrator{
		Common: common, Temporal: temporal,
		ActivityConcurrency:       envInt("TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTORS", 10),
		ActivityTimeout:           envDuration("PUBLISHING_ACTIVITY_TIMEOUT", 30*time.Minute),
		ExcludedQueues:            splitList(os.Getenv("EXCLUDE_QUEUE")),
		MaxAttempts:               envInt("PUBLISHING_MAX_ATTEMPTS", 3),
		RetryDelay:                envDuration("PUBLISHING_RETRY_DELAY", 2*time.Minute),
		RunCron:                   runCron,
		RunMaintenance:            runMaintenance,
		AuditRetentionDatabaseURL: os.Getenv("AUDIT_RETENTION_DATABASE_URL"),
		ResendAPIKey:              os.Getenv("RESEND_API_KEY"), EmailFrom: os.Getenv("AUTH_EMAIL_FROM"),
		AuthBaseURL: os.Getenv("BETTER_AUTH_URL"), AuthSecret: os.Getenv("BETTER_AUTH_SECRET"),
		CompanyPostalAddress:     os.Getenv("COMPANY_POSTAL_ADDRESS"),
		WorkerConcurrencyDivider: envInt("WORKER_CONCURRENCY_DIVIDER", 1),
	}
	if cfg.WebhookEncryptionKey, err = WebhookEncryptionKey(); err != nil {
		return Orchestrator{}, err
	}
	if cfg.RunMaintenance {
		cfg.AuditDrainEncryptionKey, err = base64.StdEncoding.DecodeString(os.Getenv("AUDIT_DRAIN_ENCRYPTION_KEY"))
		if err != nil || len(cfg.AuditDrainEncryptionKey) != 32 {
			return Orchestrator{}, fmt.Errorf("AUDIT_DRAIN_ENCRYPTION_KEY must encode 32 bytes")
		}
		if cfg.AuditRetentionDatabaseURL == "" {
			return Orchestrator{}, fmt.Errorf("AUDIT_RETENTION_DATABASE_URL is required for maintenance")
		}
		if cfg.ResendAPIKey == "" || cfg.EmailFrom == "" || cfg.AuthSecret == "" {
			return Orchestrator{}, fmt.Errorf("RESEND_API_KEY, AUTH_EMAIL_FROM and BETTER_AUTH_SECRET are required for maintenance")
		}
		u, err := url.Parse(cfg.AuthBaseURL)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
			(u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()))) {
			return Orchestrator{}, fmt.Errorf("BETTER_AUTH_URL must be HTTPS or a local loopback origin for maintenance")
		}
	}
	if cfg.ActivityConcurrency < 1 || cfg.ActivityConcurrency > 1000 {
		return Orchestrator{}, fmt.Errorf("TEMPORAL_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTORS must be between 1 and 1000")
	}
	if cfg.MaxAttempts < 1 || cfg.MaxAttempts > 10 {
		return Orchestrator{}, fmt.Errorf("PUBLISHING_MAX_ATTEMPTS must be between 1 and 10")
	}
	if cfg.ActivityTimeout <= 0 || cfg.RetryDelay <= 0 {
		return Orchestrator{}, fmt.Errorf("publishing activity timeout and retry delay must be positive")
	}
	if cfg.WorkerConcurrencyDivider < 1 || cfg.WorkerConcurrencyDivider > 1000 {
		return Orchestrator{}, fmt.Errorf("WORKER_CONCURRENCY_DIVIDER must be between 1 and 1000")
	}
	return cfg, nil
}

func loadTemporal() (Temporal, error) {
	tlsEnabled, err := envBool("TEMPORAL_TLS", false)
	if err != nil {
		return Temporal{}, err
	}
	return Temporal{
		APIKey:            os.Getenv("TEMPORAL_API_KEY"),
		ActivityTaskQueue: envString("TEMPORAL_SOCIAL_TASK_QUEUE", "social"),
		Address:           envString("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
		Namespace:         envString("TEMPORAL_NAMESPACE", "default"),
		TLS:               tlsEnabled,
		WorkflowTaskQueue: envString("TEMPORAL_TASK_QUEUE", "main"),
	}, nil
}

func envBool(name string, fallback bool) (bool, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return parsed, nil
}

func splitList(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func loadCommon(defaultPort int) (Common, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return Common{}, fmt.Errorf("DATABASE_URL is required")
	}
	return Common{
		DatabaseURL: databaseURL,
		Port:        envInt("PORT", defaultPort),
	}, nil
}

func envString(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

// Telemetry configures OpenTelemetry export (docs/observability.md). The SDK
// reads the exporter endpoint, headers, timeout, batching and queue size
// itself, from the standard OTEL_EXPORTER_OTLP_*, OTEL_BSP_* and
// OTEL_METRIC_EXPORT_* variables; LoadTelemetry only checks the numbers.
type Telemetry struct {
	Enabled bool
	// SamplingRate is the share of new traces that are kept whole.
	SamplingRate float64
	// Spans of the other traces are kept when they fail or run for at least
	// SlowSpan, up to PromotedSpansPerSecond. Zero keeps none of them.
	SlowSpan               time.Duration
	PromotedSpansPerSecond float64
	Traces                 bool
	Metrics                bool
}

// LoadTelemetry reads the telemetry settings. Telemetry is off unless
// OTEL_ENABLED=true.
func LoadTelemetry() (Telemetry, error) {
	enabled, err := envBool("OTEL_ENABLED", false)
	if err != nil || !enabled {
		return Telemetry{}, err
	}
	cfg := Telemetry{Enabled: true}
	if cfg.SamplingRate, err = envRatio("OTEL_SAMPLING_RATE", 0.01, 1); err != nil {
		return Telemetry{}, err
	}
	if cfg.PromotedSpansPerSecond, err = envRatio("OTEL_PROMOTED_SPANS_PER_SECOND", 10, 10000); err != nil {
		return Telemetry{}, err
	}
	cfg.SlowSpan = 2 * time.Second
	if value := os.Getenv("OTEL_SLOW_SPAN_THRESHOLD"); value != "" {
		if cfg.SlowSpan, err = time.ParseDuration(value); err != nil || cfg.SlowSpan < 0 {
			return Telemetry{}, fmt.Errorf("OTEL_SLOW_SPAN_THRESHOLD must be a duration such as 2s")
		}
	}
	for _, name := range []string{"OTEL_BSP_SCHEDULE_DELAY", "OTEL_BSP_EXPORT_TIMEOUT", "OTEL_BSP_MAX_QUEUE_SIZE",
		"OTEL_BSP_MAX_EXPORT_BATCH_SIZE", "OTEL_METRIC_EXPORT_INTERVAL", "OTEL_EXPORTER_OTLP_TIMEOUT"} {
		if value := os.Getenv(name); value != "" {
			if parsed, err := strconv.Atoi(value); err != nil || parsed <= 0 {
				return Telemetry{}, fmt.Errorf("%s must be a positive whole number", name)
			}
		}
	}
	if cfg.Traces, err = exporterEnabled("TRACES"); err != nil {
		return Telemetry{}, err
	}
	if cfg.Metrics, err = exporterEnabled("METRICS"); err != nil {
		return Telemetry{}, err
	}
	return cfg, nil
}

func envRatio(name string, fallback, maximum float64) (float64, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || !(parsed >= 0 && parsed <= maximum) {
		return 0, fmt.Errorf("%s must be a number from 0 to %g", name, maximum)
	}
	return parsed, nil
}

// exporterEnabled reads OTEL_TRACES_EXPORTER or OTEL_METRICS_EXPORTER: otlp
// (the default) needs an endpoint, none turns the signal off.
func exporterEnabled(signal string) (bool, error) {
	name := "OTEL_" + signal + "_EXPORTER"
	switch os.Getenv(name) {
	case "", "otlp":
		if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" && os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_ENDPOINT") == "" {
			return false, fmt.Errorf("OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED=true")
		}
		return true, nil
	case "none":
		return false, nil
	}
	return false, fmt.Errorf("%s must be otlp or none", name)
}

// WebhookEncryptionKey reads PLATFORM_WEBHOOK_ENCRYPTION_KEY, 32 bytes as
// base64. It is optional: unset, outbound webhooks are unavailable.
func WebhookEncryptionKey() ([]byte, error) {
	raw := os.Getenv("PLATFORM_WEBHOOK_ENCRYPTION_KEY")
	if raw == "" {
		return nil, nil
	}
	key, err := base64.StdEncoding.DecodeString(raw)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("PLATFORM_WEBHOOK_ENCRYPTION_KEY must encode 32 bytes")
	}
	return key, nil
}
