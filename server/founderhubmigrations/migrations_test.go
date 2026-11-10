package founderhubmigrations

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func TestMigrationLedgerFailureRollsBackWrappedDDL(t *testing.T) {
	dsn := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set PUBLISHING_TEST_DATABASE_URL for the migration transaction regression")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	connection, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	tx, err := connection.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	script := "-- Original migration keeps its own envelope.\nBEGIN;\nCREATE TEMP TABLE hub_migration_rollback (id int PRIMARY KEY); INSERT INTO hub_migration_rollback VALUES (1);\nCOMMIT;\n"
	if _, err := tx.ExecContext(ctx, transactionEnvelope.ReplaceAllString(script, "${1}${2}")); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO hub_migration_rollback VALUES (1)"); err == nil {
		t.Fatal("expected a failed ledger write")
	}
	_ = tx.Rollback()
	var table sql.NullString
	if err := connection.QueryRowContext(ctx, "SELECT to_regclass('pg_temp.hub_migration_rollback')").Scan(&table); err != nil {
		t.Fatal(err)
	}
	if table.Valid {
		t.Fatal("migration DDL survived the failed ledger transaction")
	}
}
