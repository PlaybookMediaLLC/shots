package database

import (
	"context"
	stdsql "database/sql"
	"fmt"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

// Product timestamps are timezone-less columns holding UTC (Prisma's
// timestamp(3)). Ent's time.Now defaults and pgx encode wall-clock time, so
// every process that opens the database must run on UTC.
func init() { time.Local = time.UTC }

type Database struct {
	Client *ent.Client
	SQL    *stdsql.DB
}

func Open(ctx context.Context, databaseURL string) (*Database, error) {
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db := telemetry.OpenDB("product", stdlib.GetConnector(*config))
	db.SetConnMaxIdleTime(5 * time.Minute)
	db.SetConnMaxLifetime(30 * time.Minute)
	// A page loads up to 15 backend reads at once. With fewer idle connections
	// than open ones, each burst opened new connections (about 200 ms each to
	// the database) and closed them right after.
	db.SetMaxIdleConns(20)
	db.SetMaxOpenConns(20)

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
