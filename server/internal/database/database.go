package database

import (
	"context"
	stdsql "database/sql"
	"fmt"
	"os"
	"strconv"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Product timestamps are timezone-less columns holding UTC (Prisma's
// timestamp(3)). Ent's time.Now defaults and pgx encode wall-clock time, so
// every process that opens the database must run on UTC.
func init() { time.Local = time.UTC }

// PoolConfig configures connection pool limits for OpenWithOptions.
type PoolConfig struct {
	MaxOpenConns    int
	MaxIdleConns    int
	ConnMaxLifetime time.Duration
	ConnMaxIdleTime time.Duration
}

// DefaultPoolConfig returns the default pool settings, overridden by
// DB_MAX_OPEN_CONNS, DB_MAX_IDLE_CONNS, DB_CONN_MAX_LIFETIME, and
// DB_CONN_MAX_IDLE_TIME when set to valid positive values.
func DefaultPoolConfig() PoolConfig {
	return PoolConfigFromEnv(15, 15)
}

// PoolConfigFromEnv builds a PoolConfig with caller-specified defaults,
// honoring DB_MAX_OPEN_CONNS, DB_MAX_IDLE_CONNS, DB_CONN_MAX_LIFETIME, and
// DB_CONN_MAX_IDLE_TIME overrides when present.
func PoolConfigFromEnv(defaultOpen, defaultIdle int) PoolConfig {
	cfg := PoolConfig{
		MaxOpenConns:    envPositiveInt("DB_MAX_OPEN_CONNS", defaultOpen),
		MaxIdleConns:    envPositiveInt("DB_MAX_IDLE_CONNS", defaultIdle),
		ConnMaxLifetime: envPositiveDuration("DB_CONN_MAX_LIFETIME", 30*time.Minute),
		ConnMaxIdleTime: envPositiveDuration("DB_CONN_MAX_IDLE_TIME", 5*time.Minute),
	}
	if cfg.MaxIdleConns > cfg.MaxOpenConns {
		cfg.MaxIdleConns = cfg.MaxOpenConns
	}
	return cfg
}

func envPositiveInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func envPositiveDuration(name string, fallback time.Duration) time.Duration {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

type Database struct {
	Client *ent.Client
	SQL    *stdsql.DB
}

func Open(ctx context.Context, databaseURL string) (*Database, error) {
	return OpenWithOptions(ctx, databaseURL, DefaultPoolConfig())
}

func OpenWithOptions(ctx context.Context, databaseURL string, pool PoolConfig) (*Database, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if pool.MaxOpenConns <= 0 {
		pool.MaxOpenConns = 15
	}
	if pool.MaxIdleConns <= 0 {
		pool.MaxIdleConns = min(10, pool.MaxOpenConns)
	}
	if pool.MaxIdleConns > pool.MaxOpenConns {
		pool.MaxIdleConns = pool.MaxOpenConns
	}
	if pool.ConnMaxIdleTime <= 0 {
		pool.ConnMaxIdleTime = 5 * time.Minute
	}
	if pool.ConnMaxLifetime <= 0 {
		pool.ConnMaxLifetime = 30 * time.Minute
	}
	db := telemetry.OpenDB("product", stdlib.GetConnector(*config, stdlib.OptionAfterConnect(func(_ context.Context, conn *pgx.Conn) error {
		socialdatabase.RegisterUTCTimestamps(conn.TypeMap())
		return nil
	})))
	db.SetConnMaxIdleTime(pool.ConnMaxIdleTime)
	db.SetConnMaxLifetime(pool.ConnMaxLifetime)
	db.SetMaxIdleConns(pool.MaxIdleConns)
	db.SetMaxOpenConns(pool.MaxOpenConns)

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}

	driver := entsql.OpenDB(dialect.Postgres, db)
	return &Database{Client: ent.NewClient(ent.Driver(driver)), SQL: db}, nil
}

func (d *Database) Close() error {
	if d == nil {
		return nil
	}
	return d.Client.Close()
}
