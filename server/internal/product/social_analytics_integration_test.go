package product

import (
	"context"
	"errors"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/lucsky/cuid"
)

type observationMetricsFixture struct {
	org     string
	calls   int
	failure error
}

func (f *observationMetricsFixture) PostMetrics(_ context.Context, org string, _ string, _ string, _ string, _ string) (postoptions.Metrics, error) {
	if f.org == "" || f.org == org {
		f.calls++
	}
	return postoptions.Metrics{"likes": 7}, f.failure
}
func (f *observationMetricsFixture) AccountMetrics(_ context.Context, org string, _ string, _ string, _ string) ([]schema.SocialMetricSeries, error) {
	if f.org == "" || f.org == org {
		f.calls++
	}
	return nil, postoptions.ErrMetricsUnavailable
}

func TestSocialAnalyticsObservations(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	draft, err := w.repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Analytics", PlainText: "Published text"})
	if err != nil {
		t.Fatal(err)
	}
	set, err := w.repo.defaultSocialSet(w.ctx, w.org)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := w.db.Client.ChannelConnection.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetExternalAccountID("analytics").SetPlatform("x").SetSecretReference("fixture").SetCreatedByUserID(w.owner.UserID).SetSocialSetID(set.ID).Save(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	post, err := w.db.Client.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetChannelConnectionID(connection.ID).SetContentDraftID(draft.ID).SetSocialSetID(set.ID).SetScheduledFor(time.Now().Add(-time.Hour)).SetPublishedAt(time.Now().Add(-time.Minute)).SetStatus(scheduledpost.StatusPUBLISHED).SetRemotePostID("remote").SetCaption("Published text").SetIdempotencyKey(cuid.New()).Save(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	// A post deleted from its platform is not read: the counts below stay one post and one account.
	if _, err := w.db.Client.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetChannelConnectionID(connection.ID).SetContentDraftID(draft.ID).SetSocialSetID(set.ID).SetScheduledFor(time.Now().Add(-time.Hour)).SetPublishedAt(time.Now().Add(-time.Minute)).SetStatus(scheduledpost.StatusPUBLISHED).SetRemotePostID("deleted").SetDeletedAt(time.Now()).SetCaption("Deleted text").SetIdempotencyKey(cuid.New()).Save(w.ctx); err != nil {
		t.Fatal(err)
	}
	provider := &observationMetricsFixture{org: w.org}
	w.repo.WithPostMetrics(provider)
	n, err := w.repo.CollectSocialAnalytics(w.ctx)
	if err != nil || n < 2 {
		t.Fatalf("collected %d: %v", n, err)
	}
	for batch := 0; batch < 30 && provider.calls < 2; batch++ {
		if _, err := w.repo.CollectSocialAnalytics(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if provider.calls != 2 {
		t.Fatalf("workspace observations=%d", provider.calls)
	}
	calls := provider.calls
	if _, err := w.repo.CollectSocialAnalytics(w.ctx); err != nil {
		t.Fatal(err)
	}
	if calls != provider.calls {
		t.Fatal("successful or unavailable observation read again on retry")
	}
	from, to := time.Now().Add(-24*time.Hour), time.Now().Add(time.Minute)
	rows, err := w.repo.ListSocialObservations(w.ctx, w.owner, set.ID, from, to)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows %+v: %v", rows, err)
	}
	for _, row := range rows {
		if row.Kind == "account" && (row.Status != "unavailable" || len(row.Metrics) != 0) {
			t.Fatal("unsupported metrics became zero")
		}
	}
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := w.repo.RecordDraftPostMetrics(w.ctx, w.owner, post.ID, postoptions.Metrics{"likes": 12})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	rows, err = w.repo.ListSocialObservations(w.ctx, w.owner, set.ID, from, to)
	if err != nil || len(rows) != 2 {
		t.Fatal("concurrent refresh duplicated daily observations", err)
	}
	if _, err := w.repo.RecordDraftPostMetrics(w.ctx, w.owner, post.ID, postoptions.Metrics{"likes": math.NaN()}); err == nil {
		t.Fatal("invalid metric accepted")
	}
	foreign := newTestWorkspace(t)
	subscribe(t, foreign.ctx, foreign.repo, foreign.org, "pro")
	if _, err := w.repo.ListSocialObservations(w.ctx, foreign.owner, set.ID, from, to); err == nil {
		t.Fatal("cross-workspace analytics exposed")
	}
	if _, err := w.repo.RecordDraftPostMetrics(w.ctx, foreign.owner, post.ID, postoptions.Metrics{"likes": 1}); err == nil {
		t.Fatal("cross-workspace metric write allowed")
	}
	// A failed read retains an explicit state and becomes due again after an hour.
	w.exec(t, `DELETE FROM platform_social_observation WHERE "subjectId"=$1`, post.ID)
	provider.failure = errors.New("rate limited")
	if _, err := w.repo.CollectSocialAnalytics(w.ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ = w.repo.ListSocialObservations(w.ctx, w.owner, set.ID, from, to)
	for _, row := range rows {
		if row.Kind == "post" && (row.Status != "failed" || len(row.Metrics) != 0) {
			t.Fatal("failed read fabricated values")
		}
	}
	w.exec(t, `UPDATE platform_social_observation SET "observedAt"=now()-interval '2 hours' WHERE "subjectId"=$1`, post.ID)
	provider.failure = nil
	if _, err := w.repo.CollectSocialAnalytics(w.ctx); err != nil {
		t.Fatal(err)
	}
	rows, _ = w.repo.ListSocialObservations(w.ctx, w.owner, set.ID, from, to)
	for _, row := range rows {
		if row.Kind == "post" && (row.Status != "available" || row.Metrics["likes"] != 7) {
			t.Fatal("read did not recover")
		}
	}
	if _, err := w.db.Client.ChannelConnection.UpdateOne(connection).SetStatus(channelconnection.StatusDISABLED).Save(w.ctx); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `DELETE FROM platform_social_observation WHERE "organizationId"=$1`, w.org)
	calls = provider.calls
	if _, err := w.repo.CollectSocialAnalytics(w.ctx); err != nil {
		t.Fatal(err)
	}
	if provider.calls != calls {
		t.Fatal("disconnected account was queried")
	}
}
