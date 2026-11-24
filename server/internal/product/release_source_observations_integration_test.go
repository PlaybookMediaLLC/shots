package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourcebinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	fd "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
)

func enableSourceSelection(t *testing.T, w *testWorkspace) {
	t.Helper()
	enabled := true
	if _, err := w.repo.UpdateWorkspace(w.ctx, w.owner, UpdateWorkspaceInput{Name: "Source selection", Slug: w.org, ReleaseReadinessEnabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	qualificationFixtureCleanup(t, w)
	t.Cleanup(func() {
		w.exec(t, `UPDATE platform_release_source_binding SET "currentObservationId"=NULL,"selectedObservationId"=NULL WHERE "organizationId"=$1`, w.org)
		for _, table := range []string{"platform_release_lineage_binding", "platform_release_lineage", "platform_release_qualification_source", "platform_release_source_observation", "platform_release_source_binding"} {
			w.exec(t, `DELETE FROM `+table+` WHERE "organizationId"=$1`, w.org)
		}
	})
}

func TestSourceObservationGitHubHistoryOrderingAndReplay(t *testing.T) {
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	merged := time.Date(2026, 11, 19, 10, 0, 0, 123456789, time.UTC)
	updated := merged.Add(time.Hour)
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:1001:9", RepositoryID: "1001", RepositoryName: "acme/app", ObjectID: "9", Number: 9,
		OccurredAt: merged, SourceUpdatedAt: &updated, Origin: "historical", Title: "Original facts", URL: "https://github.com/acme/app/pull/9", Fields: map[string]automation.Value{"pr.base": automation.StringValue("main")}}
	sources := []*WebhookSource{webhookSource(f.source)}
	accept := func(delivery string) {
		t.Helper()
		if _, err := f.repo.acceptGitHubEvent(f.ctx, delivery, event, sources, nil); err != nil {
			t.Fatal(err)
		}
	}
	binding := func() *ent.ReleaseSourceBinding {
		return f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	}
	accept("backfill:" + f.source.ID)
	accept("backfill:" + f.source.ID)
	first := binding()
	if first.LastEventSequence != 1 || first.CanonicalReleaseID != nil {
		t.Fatalf("backfill created duplicate evidence or candidate: %+v", first)
	}
	old := f.db.Client.ReleaseSourceObservation.GetX(f.ctx, *first.CurrentObservationID)
	if old.ProviderEventID != nil || old.Origin != releasesourceobservation.OriginHISTORICAL || old.SourceUpdatedAt == nil || !old.SourceUpdatedAt.Equal(updated.Round(time.Microsecond)) {
		t.Fatalf("lost backfill provenance: %+v", old)
	}
	event.Origin, event.ObjectID, event.Title = "live", "9009", "Current facts"
	updated = merged.Add(3 * time.Hour)
	accept("newer")
	accept("newer")
	current := binding()
	if current.ID != first.ID || current.LastEventSequence != 2 || current.ChangeSequence != 2 || current.NeedsResolution {
		t.Fatalf("live/backfill identity or replay: %+v", current)
	}
	updated, event.Title = merged.Add(2*time.Hour), "Older facts arriving late"
	accept("older")
	late := binding()
	if late.LastEventSequence != 3 || late.ChangeSequence != 2 || *late.CurrentObservationID != *current.CurrentObservationID || late.NeedsResolution {
		t.Fatalf("old evidence replaced current facts: %+v", late)
	}
	updated, event.Title = merged.Add(3*time.Hour), "Conflicting facts at the same time"
	accept("equal-version")
	conflict := binding()
	if !conflict.NeedsResolution || conflict.ChangeSequence != 3 || *conflict.CurrentObservationID != *current.CurrentObservationID {
		t.Fatalf("ambiguous evidence invented an order: %+v", conflict)
	}
	event.SourceUpdatedAt, event.Title = nil, "Unknown source order"
	accept("unknown-version")
	if got := binding(); got.LastEventSequence != 5 || !got.NeedsResolution || *got.CurrentObservationID != *current.CurrentObservationID {
		t.Fatalf("unknown version replaced known facts: %+v", got)
	}
	event.Title = "A changed body for the same delivery"
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "unknown-version", event, sources, nil); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("delivery collision accepted: %v", err)
	}
	if n := f.db.Client.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(f.org)).CountX(f.ctx); n != 5 {
		t.Fatalf("retained observations=%d", n)
	}
	if n := f.db.Client.Release.Query().Where(release.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
		t.Fatalf("source retention created %d releases", n)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != 0 {
		t.Fatalf("historical/duplicate evidence dispatched %d workflows", n)
	}
	f.db.Client.SourceApp.UpdateOneID(f.source.ID).SetStatus(sourceapp.StatusARCHIVED).ExecX(f.ctx)
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "after-revocation", event, sources, nil); !errors.Is(err, publishing.ErrInvalidState) {
		t.Fatalf("archived source accepted: %v", err)
	}
	if got := binding(); got.LastEventSequence != 5 {
		t.Fatal("rejected intake changed the source")
	}
	page, err := f.repo.ListReleaseSources(f.ctx, f.owner, "", "")
	if err != nil || len(page.Items) != 1 || page.Items[0].Available || !page.Items[0].NeedsResolution || page.Items[0].Current.Snapshot.Title != "Current facts" {
		t.Fatalf("disconnected evidence disappeared or lost the conflict: %+v %v", page, err)
	}
	other := newAutomationFixture(t)
	if _, err := other.repo.GetReleaseSourceHistory(other.ctx, other.owner, first.ID, ""); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign source history exposed: %v", err)
	}
	f.exec(t, `DELETE FROM member WHERE "organizationId"=$1 AND "userId"=$2`, f.org, f.owner.UserID)
	if _, err := f.repo.GetReleaseSourceHistory(f.ctx, f.owner, first.ID, ""); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked member read source history: %v", err)
	}
}

func TestSourceObservationConcurrentDeliveriesAndOptIn(t *testing.T) {
	f := newAutomationFixture(t)
	at := time.Now().UTC()
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:1001:10", RepositoryID: "1001", ObjectID: "9010", Number: 10, OccurredAt: at, SourceUpdatedAt: &at,
		Origin: "live", Title: "Merged work", Fields: map[string]automation.Value{"pr.base": automation.StringValue("main")}}
	sources := []*WebhookSource{webhookSource(f.source)}
	if _, err := f.repo.acceptGitHubEvent(f.ctx, "disabled", event, sources, nil); err != nil {
		t.Fatal(err)
	}
	if n := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
		t.Fatal("unselected workspace opted in")
	}
	enableSourceSelection(t, f.testWorkspace)
	var wg sync.WaitGroup
	failures := make(chan error, 12)
	for i := range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := f.repo.acceptGitHubEvent(f.ctx, fmt.Sprintf("delivery-%d", i), event, sources, nil)
			failures <- err
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	b := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	if b.LastEventSequence != 12 || b.ChangeSequence != 1 || b.NeedsResolution {
		t.Fatalf("concurrent deliveries lost evidence or fabricated changes: %+v", b)
	}
	if n := f.db.Client.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(f.org)).CountX(f.ctx); n != 12 {
		t.Fatalf("concurrent observations=%d", n)
	}
	for i := 12; i < 52; i++ {
		if _, err := f.repo.acceptGitHubEvent(f.ctx, fmt.Sprintf("delivery-%d", i), event, sources, nil); err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.repo.GetReleaseSourceHistory(f.ctx, f.owner, b.ID, "")
	if err != nil || len(page.Items) != 50 || page.NextCursor == nil || *page.NextCursor != "3" || page.Items[0].Sequence != "52" || page.Source.Sequence != "52" {
		t.Fatalf("source history first page: %+v %v", page, err)
	}
	last, err := f.repo.GetReleaseSourceHistory(f.ctx, f.owner, b.ID, *page.NextCursor)
	if err != nil || len(last.Items) != 2 || last.NextCursor != nil || last.Items[0].Sequence != "2" || last.Items[1].Sequence != "1" {
		t.Fatalf("source history next page: %+v %v", last, err)
	}
	if _, err := f.repo.GetReleaseSourceHistory(f.ctx, f.owner, b.ID, "03"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("noncanonical history cursor accepted: %v", err)
	}
}

func TestSourceObservationEditedPRDoesNotDispatchAutomation(t *testing.T) {
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	body, err := json.Marshal(map[string]any{
		"action": "edited", "installation": map[string]any{"id": f.installation},
		"repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"},
		"pull_request": map[string]any{"id": 1234, "number": 12, "title": "Updated description", "body": "Corrected evidence", "merged": true,
			"merged_at": "2026-11-19T10:00:00Z", "updated_at": "2026-11-19T11:00:00Z", "base": map[string]any{"ref": "main"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := AcceptGitHubEventInput{DeliveryID: "edited-pr", EventName: "pull_request", Body: body}
	for range 2 {
		if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	b := f.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(f.org)).OnlyX(f.ctx)
	if b.LastEventSequence != 1 || b.ProviderObjectID != "12" || b.CanonicalReleaseID != nil {
		t.Fatalf("edited PR identity or replay: %+v", b)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != 0 {
		t.Fatalf("edited PR dispatched %d workflows", n)
	}
}

func TestSourceObservationFrontendRetainsUpdatesBeforeLegacyDedup(t *testing.T) {
	w, source := frontendTestSource(t)
	enableSourceSelection(t, w)
	at := time.Now().UTC()
	o := fd.Observation{Provider: "vercel", AccountID: "team1", ProjectID: "prj_web", Key: "first", ProviderEventID: "provider-first", DeploymentID: "dep1", RepositoryID: "1001", Environment: "production", Revision: "revision1", OccurredAt: at, Status: "ready", Build: "succeeded", Production: "active"}
	accept := func() {
		t.Helper()
		if err := w.repo.acceptFrontendObservation(w.ctx, w.org, source.ID, o, false); err != nil {
			t.Fatal(err)
		}
	}
	accept()
	accept()
	first := w.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(w.org)).OnlyX(w.ctx)
	o.Key, o.ProviderEventID, o.OccurredAt, o.Status = "older", "provider-older", at.Add(-time.Minute), "building"
	o.RepositoryID = ""
	accept()
	b := w.db.Client.ReleaseSourceBinding.Query().Where(releasesourcebinding.OrganizationID(w.org)).OnlyX(w.ctx)
	if b.LastEventSequence != 2 || b.ChangeSequence != 1 || *b.CurrentObservationID != *first.CurrentObservationID {
		t.Fatalf("frontend ordering or identity: %+v", b)
	}
	o.Status = "changed-body"
	if err := w.repo.acceptFrontendObservation(w.ctx, w.org, source.ID, o, false); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("legacy dedup hid a delivery collision: %v", err)
	}
	if n := w.db.Client.ReleaseSourceObservation.Query().Where(releasesourceobservation.OrganizationID(w.org)).CountX(w.ctx); n != 2 {
		t.Fatalf("frontend observations=%d", n)
	}
}

func TestSourceObservationAuthorityLockOrdering(t *testing.T) {
	f := newAutomationFixture(t)
	enableSourceSelection(t, f.testWorkspace)
	ctx, cancel := context.WithTimeout(f.ctx, 5*time.Second)
	defer cancel()
	intake, err := f.db.Client.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer intake.Rollback()
	source, err := lockAutomationSource(ctx, intake, f.org, f.source.ID)
	if err != nil {
		t.Fatal(err)
	}
	command, err := f.db.Client.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer command.Rollback()
	var pid int
	if err := command.PlatformQuery(ctx, `SELECT pg_backend_pid()`, nil, func(row entsql.ColumnScanner) error { return row.Scan(&pid) }); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := workspaceplan.LockWorkspace(ctx, command, f.org)
		if err == nil {
			_, err = lockAutomationSource(ctx, command, f.org, f.source.ID)
		}
		if err == nil {
			err = command.Commit()
		} else {
			_ = command.Rollback()
		}
		done <- err
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := f.db.SQL.QueryRowContext(ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("command completed before contending for the source: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	at := time.Now().UTC()
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:1001:20", RepositoryID: "1001", Number: 20, ObjectID: "9020", OccurredAt: at, SourceUpdatedAt: &at, Origin: "live", Title: "Retained under authority contention"}
	if err := retainGitHubReleaseSource(ctx, intake, source, "authority-race", event); err != nil {
		t.Fatal(err)
	}
	if err := intake.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("authority and source locks deadlocked: %v", err)
	}
}
