package temporalpublishing

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// A gone record is deleted, a busy platform is retried, a refusal keeps its
// status, and a platform without the call is unsupported.
func TestDeletionOutcome(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status string
		code   string
		retry  bool
	}{
		{nil, ReceiptDone, "", false},
		{httpError(404), ReceiptDone, "", false},
		{httpError(410), ReceiptDone, "", false},
		{httpError(429), ReceiptPending, "http_429", true},
		{httpError(503), ReceiptPending, "http_503", true},
		{httpError(403), ReceiptFailed, "http_403", false},
		{socialapi.ErrUnsupported, ReceiptUnsupported, "unsupported", false},
		{socialapi.NewCodedError(404, publishing.FailureAccountReconnect, "gone"), ReceiptFailed, publishing.FailureAccountReconnect, false},
		{socialapi.NewCodedError(409, publishing.FailureAccountReconnect, "expired"), ReceiptFailed, publishing.FailureAccountReconnect, false},
		{&net.OpError{Op: "dial", Err: errors.New("refused")}, ReceiptPending, "network", true},
		{context.DeadlineExceeded, ReceiptPending, "network", true},
		{errors.New("not a LinkedIn post"), ReceiptFailed, "provider_error", false},
	} {
		status, code, retry := deletionOutcome(tc.err)
		if status != tc.status || code != tc.code || retry != tc.retry {
			t.Errorf("%v: got %s %s %v", tc.err, status, code, retry)
		}
	}
}

// The repository the worker wires in keeps the deletion store; if it drifted,
// every part would silently record unsupported.
var _ deletionStore = (*publishing.Repository)(nil)

type deletionReceipts struct {
	activityStore
	mu     sync.Mutex
	status map[string]string
	code   map[string]string
	tries  map[string]int
	plan   publishing.DeletionPlan
	late   []publishing.DeletionPart
	plans  int
	settle int
}

// PlanDeletion answers with the receipts recorded so far; the second plan
// also has the late part, as when a follow-up lands during the first pass.
func (s *deletionReceipts) PlanDeletion(context.Context, string, string, string) (*publishing.DeletionPlan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plans++
	plan := s.plan
	plan.Parts = nil
	for _, part := range s.plan.Parts {
		if status, ok := s.status[part.Key]; ok {
			part.Status = status
		}
		plan.Parts = append(plan.Parts, part)
	}
	if s.plans > 1 {
		plan.Parts = append(plan.Parts, s.late...)
	}
	return &plan, nil
}

func (s *deletionReceipts) RecordDeletion(_ context.Context, _, key, status, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tries[key]++
	s.status[key], s.code[key] = status, code
	return nil
}

func (s *deletionReceipts) SettleDeletion(context.Context, string) (bool, error) {
	s.settle++
	return true, nil
}

type scriptedDeleter struct {
	directProvider
	mu      sync.Mutex
	answers map[string][]error
	calls   []socialapi.AutomationInput
}

func (d *scriptedDeleter) Automate(_ context.Context, in socialapi.AutomationInput) (socialapi.AutomationResult, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, in)
	key := in.Kind + ":" + in.RemotePostID
	answers := d.answers[key]
	if len(answers) == 0 {
		return socialapi.AutomationResult{Done: true}, nil
	}
	d.answers[key] = answers[1:]
	return socialapi.AutomationResult{}, answers[0]
}

// The workflow removes each pending part in order, retries a busy platform,
// keeps going after a refusal, skips a settled part, records a part that
// stays busy through the last attempt as failed, deletes a reply that landed
// during the first pass, and then settles.
func TestPostDeleteWorkflow(t *testing.T) {
	store := &deletionReceipts{status: map[string]string{}, code: map[string]string{}, tries: map[string]int{},
		plan: publishing.DeletionPlan{PostID: "post-1", Platform: "x", DestinationID: "conn-1", Parts: []publishing.DeletionPart{
			{Key: "thread:2", Kind: "post", RemoteID: "busy", Status: ReceiptPending},
			{Key: "plug", Kind: "post", RemoteID: "reply", Status: ReceiptPending},
			{Key: "repost:retweet:0", Kind: "repost", RemoteID: "root", Status: ReceiptPending},
			{Key: "thread:1", Kind: "post", RemoteID: "gone", Status: ReceiptDone},
			{Key: "root", Kind: "post", RemoteID: "root", Status: ReceiptPending},
		}},
		late: []publishing.DeletionPart{{Key: "first-comment", Kind: "post", RemoteID: "comment", Status: ReceiptPending}}}
	deleter := &scriptedDeleter{answers: map[string][]error{
		"delete:busy":    {httpError(503), httpError(503), httpError(503), httpError(503), httpError(503), httpError(503), httpError(503), httpError(503)},
		"delete:reply":   {httpError(503), nil},
		"unretweet:root": {httpError(403)},
	}}
	activities := NewActivities(store, deleter)
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(activities.PlanDeletion, activity.RegisterOptions{Name: PlanDeletionActivityName})
	env.RegisterActivityWithOptions(activities.DeletePart, activity.RegisterOptions{Name: DeletePartActivityName})
	env.RegisterActivityWithOptions(activities.SettleDeletion, activity.RegisterOptions{Name: SettleDeletionActivityName})
	env.ExecuteWorkflow(PostDeleteWorkflow, DeleteWorkflowInput{OrganizationID: "org-1", PostID: "post-1", RequestedBy: "user-1"})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"thread:2": ReceiptFailed, "plug": ReceiptDone, "repost:retweet:0": ReceiptFailed,
		"root": ReceiptDone, "first-comment": ReceiptDone}
	for key, status := range want {
		if store.status[key] != status {
			t.Errorf("%s = %s, want %s", key, store.status[key], status)
		}
	}
	if store.tries["thread:2"] != deleteMaxAttempts || store.code["thread:2"] != "http_503" || store.tries["plug"] != 2 ||
		store.code["repost:retweet:0"] != "http_403" || store.tries["repost:retweet:0"] != 1 || store.plans != 2 || store.settle != 1 {
		t.Fatalf("tries %v codes %v plans %d settle %d", store.tries, store.code, store.plans, store.settle)
	}
	// 8 busy tries, 2 for the reply, the repost, the root, then the late reply.
	last := deleter.calls[len(deleter.calls)-1]
	// A repost part is undone, every other part deleted.
	repost := deleter.calls[deleteMaxAttempts+2]
	if len(deleter.calls) != deleteMaxAttempts+5 || last.RemotePostID != "comment" || last.Kind != "delete" ||
		repost.Kind != "unretweet" || repost.RemotePostID != "root" ||
		deleter.calls[deleteMaxAttempts+3].RemotePostID != "root" || deleter.calls[0].DestinationID != "conn-1" {
		t.Fatalf("calls %+v", deleter.calls)
	}
}

type resetError struct {
	at     time.Time
	status int
}

func (e resetError) Error() string      { return "rate limited" }
func (e resetError) HTTPStatus() int    { return e.status }
func (e resetError) RetryAt() time.Time { return e.at }

// A rate limit that names its reset is retried a second after it; any other
// answer keeps Temporal's backoff.
func TestDeleteRetryWaitsForThePlatformReset(t *testing.T) {
	now := time.Date(2026, 11, 13, 16, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		err  error
		want time.Duration
	}{
		{resetError{now.Add(90 * time.Second), 429}, 91 * time.Second},
		{fmt.Errorf("wrapped: %w", resetError{now.Add(3 * time.Hour), 429}), 3*time.Hour + time.Second},
		{resetError{now.Add(-time.Minute), 429}, 0},
		{resetError{time.Time{}, 429}, 0},
		{resetError{now.Add(10 * time.Minute), 503}, 0},
		{httpError(503), 0},
	} {
		if got := retryDelay(tc.err, now); got != tc.want {
			t.Errorf("%v: got %v, want %v", tc.err, got, tc.want)
		}
	}
}

// DeletePart asks Temporal to wait for the reset, fails a part at once when
// the reset is further away than X's window, and fails a removed account.
func TestDeletePartWaitsForTheResetOrFails(t *testing.T) {
	store := &deletionReceipts{status: map[string]string{}, code: map[string]string{}, tries: map[string]int{}}
	reset := time.Now().Add(2 * time.Minute)
	deleter := &scriptedDeleter{answers: map[string][]error{
		"delete:soon":  {resetError{reset, 429}},
		"delete:later": {resetError{time.Now().Add(6 * time.Hour), 429}},
		"delete:gone":  {socialapi.NewCodedError(404, publishing.FailureAccountReconnect, "removed")},
	}}
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	activities := NewActivities(store, deleter)
	env.RegisterActivityWithOptions(activities.DeletePart, activity.RegisterOptions{Name: DeletePartActivityName})
	part := func(id string) DeletePartInput {
		return DeletePartInput{Plan: publishing.DeletionPlan{PostID: "post-1", Platform: "x"},
			Part: publishing.DeletionPart{Key: id, Kind: "post", RemoteID: id, Status: ReceiptPending}}
	}
	_, err := env.ExecuteActivity(DeletePartActivityName, part("soon"))
	var retry *temporal.ApplicationError
	if !errors.As(err, &retry) || retry.NextRetryDelay() < time.Minute || retry.NextRetryDelay() > deleteMaxRetryDelay {
		t.Fatalf("soon: %v", err)
	}
	if store.status["soon"] != ReceiptPending || store.code["soon"] != "http_429" {
		t.Fatalf("soon receipt %s %s", store.status["soon"], store.code["soon"])
	}
	if _, err := env.ExecuteActivity(DeletePartActivityName, part("later")); err != nil {
		t.Fatalf("later: %v", err)
	}
	if store.status["later"] != ReceiptFailed || store.code["later"] != "http_429" || store.tries["later"] != 1 {
		t.Fatalf("later receipt %s %s after %d tries", store.status["later"], store.code["later"], store.tries["later"])
	}
	// A removed account is Shots' own refusal: failed, never counted as deleted.
	if _, err := env.ExecuteActivity(DeletePartActivityName, part("gone")); err != nil || store.status["gone"] != ReceiptFailed ||
		store.code["gone"] != publishing.FailureAccountReconnect {
		t.Fatalf("gone: %v %s %s", err, store.status["gone"], store.code["gone"])
	}
}
