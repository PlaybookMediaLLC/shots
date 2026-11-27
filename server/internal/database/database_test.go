package database

import (
	"testing"
	"time"
)

func TestPoolConfigFromEnvDefaultsAndOverrides(t *testing.T) {
	t.Setenv("DB_MAX_OPEN_CONNS", "")
	t.Setenv("DB_MAX_IDLE_CONNS", "")
	t.Setenv("DB_CONN_MAX_LIFETIME", "")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "")

	cfg := PoolConfigFromEnv(15, 10)
	if cfg.MaxOpenConns != 15 || cfg.MaxIdleConns != 10 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.ConnMaxLifetime != 30*time.Minute || cfg.ConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("unexpected default durations: %+v", cfg)
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "8")
	t.Setenv("DB_MAX_IDLE_CONNS", "12")
	t.Setenv("DB_CONN_MAX_LIFETIME", "15m")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "2m")

	cfg = PoolConfigFromEnv(15, 10)
	if cfg.MaxOpenConns != 8 || cfg.MaxIdleConns != 8 {
		t.Fatalf("expected idle clamped to max open (8): %+v", cfg)
	}
	if cfg.ConnMaxLifetime != 15*time.Minute || cfg.ConnMaxIdleTime != 2*time.Minute {
		t.Fatalf("unexpected overridden durations: %+v", cfg)
	}

	t.Setenv("DB_MAX_OPEN_CONNS", "-5")
	t.Setenv("DB_MAX_IDLE_CONNS", "abc")
	t.Setenv("DB_CONN_MAX_LIFETIME", "bad")
	t.Setenv("DB_CONN_MAX_IDLE_TIME", "0s")

	cfg = PoolConfigFromEnv(12, 6)
	if cfg.MaxOpenConns != 12 || cfg.MaxIdleConns != 6 || cfg.ConnMaxLifetime != 30*time.Minute || cfg.ConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("invalid env should fall back to defaults: %+v", cfg)
	}
}
