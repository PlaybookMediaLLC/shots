package temporalpublishing

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

type activityStore struct {
	retryAt *time.Time
	unknown bool
	// job is what LoadPublishJob returns; unsent and cancelled record the
	// failure code of a post that was never sent.
	job               publishing.PublishJob
	unsent, cancelled string
	// failed is the failure code Fail recorded.
	failed string
}

type quoteReceiptStore struct {
	activityStore
	progress  postoptions.ThreadProgress
	recordErr error
}

func (s *quoteReceiptStore) RecordThread(_ context.Context, _ string, progress postoptions.ThreadProgress) error {
	if s.recordErr != nil {
		return s.recordErr
	}
	s.progress = progress
	return nil
}

type quoteReceiptProvider struct{ directProvider }

func (quoteReceiptProvider) PublishThread(context.Context, socialapi.PublishInput) (socialapi.Receipt, error) {
	return socialapi.Receipt{PostID: "published-quote", Thread: postoptions.ThreadProgress{Quotes: []postoptions.QuoteReceipt{{PostID: "published-quote", State: "pending"}}}}, nil
}
func TestSinglePostQuoteReceiptIsRecordedWithoutRetryingPublication(t *testing.T) {
	store := &quoteReceiptStore{}
	result, err := NewActivities(store, quoteReceiptProvider{}).Submit(context.Background(), SubmitInput{Job: PreparedPublication{}})
	if err != nil || result.Outcome != OutcomePublished || result.ProviderID != "published-quote" || len(store.progress.Quotes) != 1 || store.progress.Quotes[0].State != "pending" {
		t.Fatalf("result=%#v progress=%#v err=%v", result, store.progress, err)
	}
}

func (s *activityStore) CancelIneligible(_ context.Context, _ *ent.ScheduledPost, reason, _ string) error {
	s.cancelled = reason
	return nil
}
func (s *activityStore) FailUnsent(_ context.Context, _ *ent.ScheduledPost, code, _ string) error {
	s.unsent = code
	return nil
}
func (s *activityStore) Claim(context.Context, string, string, time.Time) (bool, error) {
	return true, nil
}
func (s *activityStore) Complete(context.Context, *ent.ScheduledPost, publishing.Attempt, string, string) error {
	return nil
}
func (s *activityStore) Fail(_ context.Context, _ *ent.ScheduledPost, _ publishing.Attempt, code string, retryAt *time.Time, _ string) error {
	s.retryAt, s.failed = retryAt, code
	return nil
}
func (s *activityStore) FailUnknown(context.Context, string, string, int, string) error {
	s.unknown = true
	return nil
}
func (s *activityStore) LoadPublishJob(context.Context, string, string) (publishing.PublishJob, error) {
	return s.job, nil
}

// PostScheduledFor is the job's due time; a test without a job is due now.
func (s *activityStore) PostScheduledFor(context.Context, string, string) (time.Time, error) {
	if s.job.Post == nil {
		return time.Now(), nil
	}
	return s.job.Post.ScheduledFor, nil
}
func (s *activityStore) StartAttempt(context.Context, *ent.ScheduledPost, string, int) (publishing.Attempt, error) {
	return publishing.Attempt{ID: "attempt-1", Number: 1}, nil
}

type rateLimitedProvider struct{}

func (rateLimitedProvider) Publish(context.Context, socialapi.PublishInput) (string, error) {
	return "", &socialapi.Error{Status: 429, RetryAfter: 7 * time.Minute, ProviderMessage: "Too many requests"}
}

type uncertainProvider struct{}

type directProvider struct{}

func (directProvider) PublishesSynchronously() bool { return true }
func (directProvider) Publish(context.Context, socialapi.PublishInput) (string, error) {
	return "remote-post-1", nil
}
func (directProvider) Status(context.Context, socialapi.StatusInput) (socialapi.StatusResult, error) {
	panic("direct provider receipt must not be polled")
}

func TestSubmitActivityUsesDirectRemoteReceipt(t *testing.T) {
	activities := NewActivities(&activityStore{}, directProvider{})
	result, err := activities.Submit(context.Background(), SubmitInput{Job: PreparedPublication{}})
	if err != nil || result.Outcome != OutcomePublished || result.ProviderID != "remote-post-1" {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func (uncertainProvider) Publish(context.Context, socialapi.PublishInput) (string, error) {
	return "", &socialapi.Error{Status: 500, UnknownDelivery: true}
}
func (uncertainProvider) Status(context.Context, socialapi.StatusInput) (socialapi.StatusResult, error) {
	return socialapi.StatusResult{}, nil
}

func TestPublishActivityMarksUncertainDeliveryWithoutRetry(t *testing.T) {
	store := &activityStore{}
	activities := NewActivities(store, uncertainProvider{})
	result, err := activities.Publish(context.Background(), PublishInput{
		AttemptNumber: 1, Job: PreparedPublication{PostID: "post-1", OrganizationID: "org-1"},
		MaxAttempts: 3, RunID: "run-1",
	})
	if err != nil || !store.unknown || result.Outcome != OutcomeFailed || result.FailureCode != "UNKNOWN_DELIVERY" || store.retryAt != nil {
		t.Fatalf("result=%#v unknown=%v retryAt=%v err=%v", result, store.unknown, store.retryAt, err)
	}
}
func (rateLimitedProvider) Status(context.Context, socialapi.StatusInput) (socialapi.StatusResult, error) {
	return socialapi.StatusResult{}, nil
}

func TestPublishActivityReturnsDurableRateLimitRetry(t *testing.T) {
	store := &activityStore{}
	activities := NewActivities(store, rateLimitedProvider{})
	fixed := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	activities.now = func() time.Time { return fixed }
	result, err := activities.Publish(context.Background(), PublishInput{
		AttemptNumber: 1, Job: PreparedPublication{PostID: "post-1", OrganizationID: "org-1"},
		MaxAttempts: 3, RetryDelay: time.Minute, RunID: "run-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeRetry || result.NextAttempt != 2 || result.RetryAfter != time.Minute || store.retryAt == nil || !store.retryAt.Equal(fixed.Add(time.Minute)) {
		t.Fatalf("result=%#v retryAt=%v", result, store.retryAt)
	}
}

func TestSubmitActivityLeavesRateLimitRetryToWorkflow(t *testing.T) {
	activities := NewActivities(&activityStore{}, rateLimitedProvider{})
	result, err := activities.Submit(context.Background(), SubmitInput{Job: PreparedPublication{}})
	if err != nil {
		t.Fatal(err)
	}
	// The provider's retry guidance and message reach the workflow and the attempt.
	if result.Outcome != OutcomeRetry || result.FailureCode != "429" || result.RetryAfter != 7*time.Minute || result.ProviderMessage != "Too many requests" {
		t.Fatalf("result=%#v", result)
	}
}

// A claimed post is sent only when it is eligible and on time: missing media
// fails it as unsent, an ineligible one is cancelled with its reason, and one
// that could not start within the late window fails as MISSED_WINDOW. None of
// them reaches the provider.
func TestPrepareSendsOnlyEligibleOnTimePosts(t *testing.T) {
	now := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	connection := &ent.ChannelConnection{Platform: "x"}
	cases := []struct {
		name              string
		job               publishing.PublishJob
		ready             bool
		unsent, cancelled string
	}{
		{"on time", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now.Add(-time.Minute)}, Connection: connection, WorkspaceActive: true}, true, "", ""},
		{"late within the window", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now.Add(-LatePublicationWindow)}, Connection: connection, WorkspaceActive: true}, true, "", ""},
		{"past the window", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now.Add(-LatePublicationWindow - time.Second)}, Connection: connection, WorkspaceActive: true}, false, publishing.FailureMissedWindow, ""},
		{"media deleted", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now}, Connection: connection, Ineligible: publishing.FailureMediaUnavailable}, false, publishing.FailureMediaUnavailable, ""},
		{"approval withdrawn", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now}, Connection: connection, Ineligible: publishing.FailureChangesRequested}, false, "", publishing.FailureChangesRequested},
		{"account disconnected, even when late", publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now.Add(-48 * time.Hour)}, Connection: connection, Ineligible: publishing.FailureAccountUnavailable}, false, "", publishing.FailureAccountUnavailable},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			store := &activityStore{job: test.job}
			activities := NewActivities(store, directProvider{})
			activities.now = func() time.Time { return now }
			prepared, err := activities.Prepare(context.Background(), PrepareInput{PostID: "p", RunID: "run-1"})
			if err != nil || prepared.Ready != test.ready || store.unsent != test.unsent || store.cancelled != test.cancelled {
				t.Fatalf("prepared=%#v unsent=%q cancelled=%q err=%v", prepared, store.unsent, store.cancelled, err)
			}
		})
	}
}

// sendCounter counts the publications that reached the provider.
type sendCounter struct {
	directProvider
	sends int
}

func (p *sendCounter) Publish(context.Context, socialapi.PublishInput) (string, error) {
	p.sends++
	return "remote-post-1", nil
}

// The send checks the late window again: it runs on the activity queue, so
// a down or backlogged worker can start it hours after Prepare passed. Past
// the window it fails as MISSED_WINDOW without reaching the provider, on both
// send paths (Submit for V2, Publish for V1); within it, it still goes out.
func TestSendRechecksTheLatePublicationWindow(t *testing.T) {
	now := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	job := PreparedPublication{PostID: "p", OrganizationID: "org"}
	cases := []struct {
		name          string
		late          time.Duration
		sends         int
		outcome, code string
	}{
		{"within the window", LatePublicationWindow, 2, OutcomePublished, ""},
		{"past the window", LatePublicationWindow + time.Second, 0, OutcomeFailed, publishing.FailureMissedWindow},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			store := &activityStore{job: publishing.PublishJob{Post: &ent.ScheduledPost{ID: "p", ScheduledFor: now.Add(-test.late)}}}
			provider := &sendCounter{}
			activities := NewActivities(store, provider)
			activities.now = func() time.Time { return now }
			submitted, err := activities.Submit(context.Background(), SubmitInput{Job: job})
			if err != nil || submitted.Outcome != test.outcome || submitted.FailureCode != test.code {
				t.Fatalf("submit=%#v err=%v", submitted, err)
			}
			published, err := activities.Publish(context.Background(), PublishInput{AttemptNumber: 1, Job: job, MaxAttempts: 3, RunID: "run-1"})
			if err != nil || published.Outcome != test.outcome || published.FailureCode != test.code || store.failed != test.code || provider.sends != test.sends {
				t.Fatalf("publish=%#v failed=%q sends=%d err=%v", published, store.failed, provider.sends, err)
			}
		})
	}
}

type processingReceiptProvider struct{ directProvider }

func (processingReceiptProvider) PublishThread(context.Context, socialapi.PublishInput) (socialapi.Receipt, error) {
	return socialapi.Receipt{PostID: "video", Thread: postoptions.ThreadProgress{Publication: &postoptions.PublicationReceipt{RemoteID: "video", URL: "https://www.youtube.com/watch?v=video"}}}, socialapi.NewError(502, true, "processing pending")
}
func TestProcessingReceiptSurvivesUnknownDelivery(t *testing.T) {
	store := &quoteReceiptStore{}
	_, err := NewActivities(store, processingReceiptProvider{}).publish(context.Background(), socialapi.PublishInput{})
	if err == nil || store.progress.Publication == nil || store.progress.Publication.RemoteID != "video" {
		t.Fatalf("receipt lost: %#v %v", store.progress, err)
	}
}

func TestReceiptSurvivesStorageOutageWithoutResubmitting(t *testing.T) {
	store := &quoteReceiptStore{recordErr: context.DeadlineExceeded}
	activities := NewActivities(store, processingReceiptProvider{})
	result, err := activities.Submit(context.Background(), SubmitInput{})
	if err != nil || result.Outcome != OutcomeUnknown || result.ProviderID != "video" || result.Progress == nil {
		t.Fatalf("safe receipt lost: %#v %v", result, err)
	}
	input := MarkUnknownInput{PostID: "post", Progress: result.Progress}
	if err := activities.MarkUnknown(context.Background(), input); err == nil || store.unknown {
		t.Fatal("outcome must await receipt storage")
	}
	store.recordErr = nil
	if err := activities.MarkUnknown(context.Background(), input); err != nil || !store.unknown || store.progress.Publication.RemoteID != "video" {
		t.Fatalf("receipt recovery failed: %#v %v", store, err)
	}
}

func TestFailureCodeNamesTheCause(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		err  error
		want string
	}{
		{errMissedWindow, publishing.FailureMissedWindow},
		{socialapi.NewCodedError(409, "ACCOUNT_RECONNECT", "reconnect"), "ACCOUNT_RECONNECT"},
		{socialapi.NewError(400, false, "rejected"), "400"},
		{socialapi.NewError(0, false, "offline"), "NETWORK"},
		{socialapi.NewError(502, true, "unknown"), "UNKNOWN_DELIVERY"},
		{errors.New("no provider status"), "PUBLISHER_ERROR"},
	} {
		if got := failureCodeFor(ctx, PreparedPublication{}, test.err); got != test.want {
			t.Errorf("failureCodeFor(%v) = %q, want %q", test.err, got, test.want)
		}
	}
}
