// Command deletion-ledger-replay deletes again what a database restore
// brought back: every deletion in the R2 deletion ledger requested after the
// restore point. Run it against the restored database before the app is
// reopened (docs/deployment.md, "Restoring the database").
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
)

func main() {
	since := flag.String("since", "", "the restore point, RFC 3339 (2026-11-10T12:00:00Z)")
	flag.Parse()
	restoredTo, err := time.Parse(time.RFC3339, *since)
	if err != nil {
		log.Fatal("-since must be the restore point in RFC 3339")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	store, err := media.NewS3StoreFromEnvironment()
	if err != nil || store == nil {
		log.Fatalf("R2 settings are required: %v", err)
	}
	records, err := readLedger(ctx, store, restoredTo, time.Now())
	if err != nil {
		log.Fatal(err)
	}
	db, err := database.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	replayed, err := (&maintenance.Store{DB: db.SQL}).ReplayDeletions(ctx, records, restoredTo)
	if err != nil {
		log.Fatalf("replayed %d of %d ledger entries, then: %v", replayed, len(records), err)
	}
	log.Printf("ledger entries=%d deleted_again=%d", len(records), replayed)
}

type ledgerStore interface {
	List(context.Context, string) ([]string, error)
	Read(context.Context, string) ([]byte, error)
}

// readLedger reads every ledger entry filed on the restore point's UTC day
// or later; ReplayDeletions skips those requested before the restore point.
func readLedger(ctx context.Context, store ledgerStore, restoredTo, now time.Time) ([]maintenance.DeletionRecord, error) {
	records := []maintenance.DeletionRecord{}
	for day := restoredTo.UTC().Truncate(24 * time.Hour); !day.After(now); day = day.Add(24 * time.Hour) {
		keys, err := store.List(ctx, media.DeletionLedgerDay(day))
		if err != nil {
			return nil, err
		}
		for _, key := range keys {
			body, err := store.Read(ctx, key)
			if err != nil {
				return nil, fmt.Errorf("read %s: %w", key, err)
			}
			var record maintenance.DeletionRecord
			if err := json.Unmarshal(body, &record); err != nil {
				return nil, fmt.Errorf("parse %s: %w", key, err)
			}
			records = append(records, record)
		}
	}
	return records, nil
}
