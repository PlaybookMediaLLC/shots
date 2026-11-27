package database

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestPoolConfigFromEnvDefaultsAndOverrides(t *testing.T) {
	t.Setenv("DB_MAX_OPEN_CONNS", "")
	t.Setenv("DB_MAX_IDLE_CONNS", "")
	t.Setenv("DB_CONN_MAX_LIFETIME", "")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "")
	t.Setenv("DB_STATEMENT_TIMEOUT", "")
	t.Setenv("DB_IDLE_IN_TX_TIMEOUT", "")

	cfg := PoolConfigFromEnv(15, 10)
	if cfg.MaxOpenConns != 15 || cfg.MaxIdleConns != 10 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.ConnMaxLifetime != 30*time.Minute || cfg.ConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("unexpected default durations: %+v", cfg)
	}
	if cfg.StatementTimeout != 30*time.Second || cfg.IdleInTxTimeout != 30*time.Second {
		t.Fatalf("unexpected default session timeouts: %+v", cfg)
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "8")
	t.Setenv("DB_MAX_IDLE_CONNS", "12")
	t.Setenv("DB_CONN_MAX_LIFETIME", "15m")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "2m")
	t.Setenv("DB_STATEMENT_TIMEOUT", "45s")
	t.Setenv("DB_IDLE_IN_TX_TIMEOUT", "15s")

	cfg = PoolConfigFromEnv(15, 10)
	if cfg.MaxOpenConns != 8 || cfg.MaxIdleConns != 8 {
		t.Fatalf("expected idle clamped to max open (8): %+v", cfg)
	}
	if cfg.ConnMaxLifetime != 15*time.Minute || cfg.ConnMaxIdleTime != 2*time.Minute {
		t.Fatalf("unexpected overridden durations: %+v", cfg)
	}
	if cfg.StatementTimeout != 45*time.Second || cfg.IdleInTxTimeout != 15*time.Second {
		t.Fatalf("unexpected overridden session timeouts: %+v", cfg)
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "-5")
	t.Setenv("DB_MAX_IDLE_CONNS", "abc")
	t.Setenv("DB_CONN_MAX_LIFETIME", "bad")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "0s")
	t.Setenv("DB_STATEMENT_TIMEOUT", "500us")
	t.Setenv("DB_IDLE_IN_TX_TIMEOUT", "-1s")

	cfg = PoolConfigFromEnv(12, 6)
	if cfg.MaxOpenConns != 12 || cfg.MaxIdleConns != 6 || cfg.ConnMaxLifetime != 30*time.Minute || cfg.ConnMaxIdleTime != 5*time.Minute ||
		cfg.StatementTimeout != 30*time.Second || cfg.IdleInTxTimeout != 30*time.Second {
		t.Fatalf("invalid or sub-ms env should fall back to defaults: %+v", cfg)
	}
}

func TestSessionTimeoutSQLPreservesDSNAndBoundsSubMillisecond(t *testing.T) {
	cfg, err := pgx.ParseConfig("postgres://user:pass@localhost:5432/db")
	if err != nil {
		t.Fatal(err)
	}
	if got := sessionTimeoutSQL(cfg, PoolConfig{}); got != "SET statement_timeout = 30000; SET idle_in_transaction_session_timeout = 30000" {
		t.Fatalf("unexpected default SQL: %q", got)
	}

	// Sub-millisecond positive values clamp to 1ms, never 0 (which disables timeouts in Postgres).
	if got := sessionTimeoutSQL(&pgx.ConnConfig{}, PoolConfig{StatementTimeout: 500 * time.Microsecond, IdleInTxTimeout: -1}); got != "SET statement_timeout = 1" {
		t.Fatalf("unexpected clamped/opt-out SQL: %q", got)
	}

	// DSN RuntimeParams and options=-c overrides take precedence.
	explicit, err := pgx.ParseConfig("postgres://user:pass@localhost:5432/db?statement_timeout=120000&idle_in_transaction_session_timeout=60000")
	if err != nil {
		t.Fatal(err)
	}
	if got := sessionTimeoutSQL(explicit, PoolConfig{StatementTimeout: 30 * time.Second, IdleInTxTimeout: 10 * time.Second}); got != "" {
		t.Fatalf("DSN params must suppress SET SQL, got %q", got)
	}

	viaOptions, err := pgx.ParseConfig("postgres://user:pass@localhost:5432/db?options=-c%20statement_timeout%3D90000")
	if err != nil {
		t.Fatal(err)
	}
	if got := sessionTimeoutSQL(viaOptions, PoolConfig{StatementTimeout: 30 * time.Second, IdleInTxTimeout: 10 * time.Second}); got != "SET idle_in_transaction_session_timeout = 10000" {
		t.Fatalf("DSN options=-c statement_timeout must suppress statement_timeout only, got %q", got)
	}
}
