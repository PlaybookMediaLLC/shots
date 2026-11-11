// Package founderhubmigrations preserves the Founder Hub storage contract in the Shots database.
package founderhubmigrations

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"regexp"
)

//go:embed sql/*.sql bootstrap.sql
var files embed.FS

// Keep the source/checksum intact while the runner owns the DDL and ledger transaction.
var transactionEnvelope = regexp.MustCompile(`(?s)^((?:\s*--[^\n]*\n)*\s*)BEGIN;(.*?)COMMIT;\s*$`)

// Bootstrap prepares isolated identity and storage roles before the object-storage engine starts.
func Bootstrap(ctx context.Context, db *sql.DB) error {
	script, err := files.ReadFile("bootstrap.sql")
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, string(script)); err != nil {
		return err
	}
	return tx.Commit()
}

// ConfigureLogins sets the two private engine credentials without granting either access to Shots product tables.
func ConfigureLogins(ctx context.Context, db *sql.DB, restPassword, storagePassword string) error {
	if restPassword == "" && storagePassword == "" {
		return nil
	}
	if len(restPassword) < 32 || len(storagePassword) < 32 {
		return errors.New("both Founder Hub database passwords must contain at least 32 bytes")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT set_config('shots.rest_password',$1,true), set_config('shots.storage_password',$2,true)", restPassword, storagePassword); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DO $$ BEGIN
		EXECUTE format('ALTER ROLE shots_hub_authenticator PASSWORD %L', current_setting('shots.rest_password'));
		EXECUTE format('ALTER ROLE shots_hub_storage PASSWORD %L', current_setting('shots.storage_password'));
	END $$;`); err != nil {
		return errors.New("could not configure private Founder Hub database logins")
	}
	return tx.Commit()
}

// Apply runs after Shots platform migrations and object-storage schema initialization.
func Apply(ctx context.Context, db *sql.DB) error {
	if err := Bootstrap(ctx, db); err != nil {
		return err
	}
	entries, err := files.ReadDir("sql")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := applyOne(ctx, db, entry.Name()); err != nil {
			return err
		}
	}
	return nil
}

func applyOne(ctx context.Context, db *sql.DB, name string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('shots-founder-hub-migrations')); SET LOCAL ROLE shots_hub_owner; SET LOCAL search_path = founder_hub, extensions;`); err != nil {
		return err
	}
	script, err := files.ReadFile("sql/" + name)
	if err != nil {
		return err
	}
	checksum := fmt.Sprintf("%x", sha256.Sum256(script))
	var appliedChecksum string
	err = tx.QueryRowContext(ctx, `SELECT checksum FROM founder_hub_private.schema_migrations WHERE name=$1`, name).Scan(&appliedChecksum)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		if appliedChecksum != checksum {
			return fmt.Errorf("Founder Hub migration %s changed after being applied", name)
		}
		return tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, transactionEnvelope.ReplaceAllString(string(script), "${1}${2}")); err != nil {
		return fmt.Errorf("Founder Hub migration %s: %w", name, err)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO founder_hub_private.schema_migrations(name,checksum) VALUES($1,$2)`, name, checksum); err != nil {
		return err
	}
	return tx.Commit()
}
