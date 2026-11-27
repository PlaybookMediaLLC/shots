package database

import (
	"context"
	stdsql "database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
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

// PoolConfig configures connection pool limits and session timeouts for OpenWithOptions.
type PoolConfig struct {
	MaxOpenConns     int
	MaxIdleConns     int
	ConnMaxLifetime  time.Duration
	ConnMaxIdleTime  time.Duration
	StatementTimeout time.Duration
	IdleInTxTimeout  time.Duration
}

// DefaultPoolConfig returns the default pool settings, overridden by
// DB_MAX_OPEN_CONNS, DB_MAX_IDLE_CONNS, DB_CONN_MAX_LIFETIME,
// DB_CONN_MAX_IDLE_TIME, DB_STATEMENT_TIMEOUT, and DB_IDLE_IN_TX_TIMEOUT
// when set to valid positive values.
func DefaultPoolConfig() PoolConfig {
	return PoolConfigFromEnv(15, 15)
}

// PoolConfigFromEnv builds a PoolConfig with caller-specified defaults,
// honoring DB_MAX_OPEN_CONNS, DB_MAX_IDLE_CONNS, DB_CONN_MAX_LIFETIME,
// DB_CONN_MAX_IDLE_TIME, DB_STATEMENT_TIMEOUT, and DB_IDLE_IN_TX_TIMEOUT
// overrides when present.
func PoolConfigFromEnv(defaultOpen, defaultIdle int) PoolConfig {
	cfg := PoolConfig{
		MaxOpenConns:     envPositiveInt("DB_MAX_OPEN_CONNS", defaultOpen),
		MaxIdleConns:     envPositiveInt("DB_MAX_IDLE_CONNS", defaultIdle),
		ConnMaxLifetime:  envPositiveDuration("DB_CONN_MAX_LIFETIME", 30*time.Minute),
		ConnMaxIdleTime:  envPositiveDuration("DB_CONN_MAX_IDLE_TIME", 5*time.Minute),
		StatementTimeout: envPositiveDuration("DB_STATEMENT_TIMEOUT", 30*time.Second),
		IdleInTxTimeout:  envPositiveDuration("DB_IDLE_IN_TX_TIMEOUT", 30*time.Second),
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
	if err != nil || d < time.Millisecond {
		return fallback
	}
	return d
}

func dsnSetsParam(config *pgx.ConnConfig, name string) bool {
	if config == nil || config.RuntimeParams == nil {
		return false
	}
	if _, ok := config.RuntimeParams[name]; ok {
		return true
	}
	return strings.Contains(config.RuntimeParams["options"], name)
}

// sessionTimeoutSQL builds a single multi-statement SET command for session timeouts
// not already supplied in the DSN. Running via OptionAfterConnect avoids PostgreSQL
// startup RuntimeParams that PgBouncer transaction poolers may reject.
func sessionTimeoutSQL(config *pgx.ConnConfig, pool PoolConfig) string {
	var statements []string
	stmtTimeout := pool.StatementTimeout
	if stmtTimeout == 0 {
		stmtTimeout = 30 * time.Second
	}
	if stmtTimeout > 0 && !dsnSetsParam(config, "statement_timeout") {
		ms := max(int64(1), stmtTimeout.Milliseconds())
		statements = append(statements, fmt.Sprintf("SET statement_timeout = %d", ms))
	}
	idleTxTimeout := pool.IdleInTxTimeout
	if idleTxTimeout == 0 {
		idleTxTimeout = 30 * time.Second
	}
	if idleTxTimeout > 0 && !dsnSetsParam(config, "idle_in_transaction_session_timeout") {
		ms := max(int64(1), idleTxTimeout.Milliseconds())
		statements = append(statements, fmt.Sprintf("SET idle_in_transaction_session_timeout = %d", ms))
	}
	return strings.Join(statements, "; ")
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
	timeoutSQL := sessionTimeoutSQL(config, pool)
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
	db := telemetry.OpenDB("product", stdlib.GetConnector(*config, stdlib.OptionAfterConnect(func(connCtx context.Context, conn *pgx.Conn) error {
		socialdatabase.RegisterUTCTimestamps(conn.TypeMap())
		if timeoutSQL != "" {
			if _, err := conn.Exec(connCtx, timeoutSQL); err != nil {
				return fmt.Errorf("configure session timeouts: %w", err)
			}
		}
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
