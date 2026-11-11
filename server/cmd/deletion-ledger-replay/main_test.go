package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

// The replay reads back what the outbox wrote: every entry filed from the
// restore point's day to today, and none from the days before it.
func TestReadLedgerReadsEntriesFromTheRestoreDayOn(t *testing.T) {
	server := httptest.NewServer(gofakes3.New(s3mem.New(), gofakes3.WithAutoBucket(true)).Server())
	defer server.Close()
	store, err := media.NewS3Store(server.URL, "", "us-east-1", "tenant-assets", "test-key", "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	restoredTo := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	for id, requested := range map[string]time.Time{
		"day-before":   restoredTo.Add(-24 * time.Hour),
		"same-day-old": restoredTo.Add(-time.Hour),
		"after":        restoredTo.Add(time.Minute),
		"next-day":     restoredTo.Add(20 * time.Hour),
	} {
		body, err := json.Marshal(maintenance.DeletionRecord{Kind: "asset", OrganizationID: "org-1", ID: "asset-" + id, EventID: id, RequestedAt: requested})
		if err != nil {
			t.Fatal(err)
		}
		if err := media.NewTenantObjects(store).RecordDeletion(ctx, requested, id, body); err != nil {
			t.Fatal(err)
		}
	}
	records, err := readLedger(ctx, store, restoredTo, restoredTo.Add(21*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]maintenance.DeletionRecord{}
	for _, record := range records {
		found[record.EventID] = record
	}
	if len(records) != 3 || found["after"].ID != "asset-after" || !found["after"].RequestedAt.Equal(restoredTo.Add(time.Minute)) ||
		found["same-day-old"].Kind != "asset" || found["next-day"].OrganizationID != "org-1" {
		t.Fatalf("records: %+v", records)
	}
}
