package platformmigrations

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
)

// Migrations apply in file-name order, and a database first migrated by
// Prisma is adopted by matching these names against _prisma_migrations, so
// every file must keep the timestamped "<14 digits>_<name>.sql" form.
func TestEmbeddedMigrationsAreTimestampOrdered(t *testing.T) {
	entries, err := files.ReadDir("sql")
	if err != nil || len(entries) == 0 {
		t.Fatalf("embedded migrations=%d err=%v", len(entries), err)
	}
	pattern := regexp.MustCompile(`^\d{14}_[a-z0-9_]+\.sql$`)
	previous := ""
	for _, entry := range entries {
		if !pattern.MatchString(entry.Name()) || entry.Name() <= previous {
			t.Fatalf("migration %q is misnamed or out of order after %q", entry.Name(), previous)
		}
		previous = entry.Name()
	}
}

func TestApplyFreshDatabaseAndIsIdempotent(t *testing.T) {
	url := os.Getenv("PLATFORM_MIGRATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PLATFORM_MIGRATION_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	if err := Apply(ctx, db.SQL); err != nil {
		t.Fatal(err)
	}
	if err := Apply(ctx, db.SQL); err != nil {
		t.Fatalf("repeat migration failed: %v", err)
	}
	entries, err := files.ReadDir("sql")
	if err != nil {
		t.Fatal(err)
	}
	var applied int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM "_screenshot_studio_go_migrations"`).Scan(&applied); err != nil || applied != len(entries) {
		t.Fatalf("applied migrations=%d err=%v", applied, err)
	}
}

func TestNavigationAttemptUpgradePreservesExistingJobs(t *testing.T) {
	uri := os.Getenv("PLATFORM_MIGRATION_TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("PLATFORM_MIGRATION_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, uri)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatal("upgrade requires a test database")
	}
	tx, err := db.SQL.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// A temporary table shadows the real table without altering any existing job.
	if _, err := tx.ExecContext(ctx, `CREATE TEMP TABLE capture_job (id text PRIMARY KEY, attempts integer, phase text) ON COMMIT DROP;
		INSERT INTO capture_job VALUES ('waiting',7,'WAITING_DEPLOYMENT'),('done',1,'SUCCEEDED')`); err != nil {
		t.Fatal(err)
	}
	script, err := files.ReadFile("sql/20261114030000_capture_navigation_attempts.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, string(script)); err != nil {
		t.Fatal(err)
	}
	var preserved int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM capture_job WHERE "navigationAttempts"=0 AND
		((id='waiting' AND attempts=7 AND phase='WAITING_DEPLOYMENT') OR (id='done' AND attempts=1 AND phase='SUCCEEDED'))`).Scan(&preserved); err != nil || preserved != 2 {
		t.Fatalf("existing jobs changed: count=%d err=%v", preserved, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO capture_job(id,attempts,phase) VALUES ('new',0,'QUEUED')`); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := tx.QueryRowContext(ctx, `SELECT "navigationAttempts" FROM capture_job WHERE id='new'`).Scan(&attempts); err != nil || attempts != 0 {
		t.Fatalf("new job counter=%d err=%v", attempts, err)
	}
}
