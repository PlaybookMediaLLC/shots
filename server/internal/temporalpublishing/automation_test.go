package temporalpublishing

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

func TestAutomationPlan(t *testing.T) {
	// 2026-03-07 20:00 in New York; the clocks go forward the next night.
	published := time.Date(2026, 3, 8, 1, 0, 0, 0, time.UTC)
	steps := automationPlan(PreparedPublication{
		Platform: "x",
		Options:  &postoptions.PublishOptions{FirstComment: "x has no first comment"},
		AutoActions: &postoptions.AutoActions{
			Retweets: []postoptions.RetweetRule{
				{AfterMinutes: 360},
				{Days: 1, At: "10:30", TimeZone: "America/New_York"},
				{At: "25:00", TimeZone: "America/New_York"},
			},
			UnretweetAfterMinutes: 720,
			PlugAtLikes:           100, PlugText: "Get the guide",
		},
	}, published)
	byKey := map[string][]AutomationStep{}
	for index, step := range steps {
		if index > 0 && step.At.Before(steps[index-1].At) {
			t.Fatalf("steps out of order at %d: %+v", index, steps)
		}
		byKey[step.Key] = append(byKey[step.Key], step)
	}
	if _, ok := byKey["first-comment"]; ok {
		t.Fatal("first comment planned for X")
	}
	if got := byKey["retweet:0"][0].At; !got.Equal(published.Add(6 * time.Hour)) {
		t.Fatalf("relative rule at %v", got)
	}
	// 10:30 the next day is after the spring-forward change: 14:30 UTC, not 15:30.
	if got := byKey["retweet:1"][0].At; !got.Equal(time.Date(2026, 3, 8, 14, 30, 0, 0, time.UTC)) {
		t.Fatalf("wall-clock rule at %v", got)
	}
	if _, ok := byKey["retweet:2"]; ok {
		t.Fatal("an invalid rule was planned")
	}
	if got := byKey["unretweet:1"][0]; !got.At.Equal(byKey["retweet:1"][0].At.Add(12*time.Hour)) || got.Rule != 1 {
		t.Fatalf("removal = %+v", got)
	}
	plug := byKey["plug"]
	if len(plug) != 66 || plug[0].At != published.Add(15*time.Minute) || !plug[len(plug)-1].Final ||
		plug[len(plug)-1].At != published.Add(plugWindow) || plug[0].Final {
		t.Fatalf("plug checks = %d, first %v, last %+v", len(plug), plug[0].At, plug[len(plug)-1])
	}
	linkedIn := automationPlan(PreparedPublication{
		Platform: "linkedin-page", Options: &postoptions.PublishOptions{FirstComment: "Link in the comments"},
	}, published)
	if len(linkedIn) != 1 || linkedIn[0].Kind != AutomationFirstComment || !linkedIn[0].At.Equal(published) {
		t.Fatalf("linkedin = %+v", linkedIn)
	}
	for _, platform := range []string{"instagram", "instagram-standalone"} {
		instagram := automationPlan(PreparedPublication{
			Platform: platform, Options: &postoptions.PublishOptions{FirstComment: "#launch"},
		}, published)
		if len(instagram) != 1 || instagram[0].Kind != AutomationFirstComment || !instagram[0].At.Equal(published) {
			t.Fatalf("%s = %+v", platform, instagram)
		}
	}
}

type receiptStore struct {
	activityStore
	receipts map[string]*receipt
}

type receipt struct {
	status, remoteID, code string
	attempts               int
}

func (s *receiptStore) PlanAutomations(_ context.Context, _, _ string, planned []publishing.AutomationReceipt) (map[string]string, error) {
	statuses := map[string]string{}
	for _, item := range planned {
		if s.receipts[item.Key] == nil {
			s.receipts[item.Key] = &receipt{status: ReceiptPending}
		}
		statuses[item.Key] = s.receipts[item.Key].status
	}
	return statuses, nil
}

func (s *receiptStore) AutomationReceipt(_ context.Context, _, key string) (string, string, error) {
	if s.receipts[key] == nil {
		return ReceiptSkipped, "", nil
	}
	return s.receipts[key].status, s.receipts[key].remoteID, nil
}

func (s *receiptStore) RecordAutomation(_ context.Context, _, key, status, remoteID, code string) (bool, error) {
	item := s.receipts[key]
	if item == nil || item.status != ReceiptPending {
		return false, nil
	}
	item.attempts++
	item.status, item.remoteID, item.code = status, remoteID, code
	return true, nil
}

type fakeAutomator struct {
	directProvider
	calls  []socialapi.AutomationInput
	result socialapi.AutomationResult
	err    error
}

func (f *fakeAutomator) Automate(_ context.Context, input socialapi.AutomationInput) (socialapi.AutomationResult, error) {
	f.calls = append(f.calls, input)
	return f.result, f.err
}

type httpError int

func (e httpError) Error() string   { return "provider said no, quoting the post" }
func (e httpError) HTTPStatus() int { return int(e) }

// A step acts once: a settled receipt (done, cancelled) stops it, a removal
// waits for its repost, an unmet threshold stays pending until the final
// check, and a failure keeps a code, never the provider's message.
func TestRunAutomation(t *testing.T) {
	ctx := context.Background()
	job := PreparedPublication{PostID: "post-1", Platform: "x",
		AutoActions: &postoptions.AutoActions{PlugAtLikes: 5, PlugMetric: "reposts", PlugText: "Get the guide"}}
	store := &receiptStore{receipts: map[string]*receipt{}}
	provider := &fakeAutomator{result: socialapi.AutomationResult{Done: true, RemoteID: "reply-1"}}
	activities := NewActivities(store, provider)
	run := func(step AutomationStep) AutomationResult {
		t.Helper()
		result, err := activities.RunAutomation(ctx, AutomationInput{Job: job, ProviderID: "remote-1", Step: step})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if _, err := activities.PlanAutomations(ctx, PlanAutomationsInput{Job: PreparedPublication{PostID: "post-1",
		AutoActions: &postoptions.AutoActions{
			Retweets: []postoptions.RetweetRule{{AfterMinutes: 60}, {AfterMinutes: 120}}, UnretweetAfterMinutes: 60,
			PlugAtLikes: 5, PlugText: "Get the guide",
		}}, PublishedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	if result := run(AutomationStep{Key: "unretweet:0", Kind: AutomationUnretweet, Rule: 0}); !result.Settled ||
		store.receipts["unretweet:0"].status != ReceiptSkipped || len(provider.calls) != 0 {
		t.Fatalf("removal before its repost: %+v %+v", result, store.receipts["unretweet:0"])
	}
	if result := run(AutomationStep{Key: "retweet:0", Kind: AutomationRetweet}); !result.Settled ||
		store.receipts["retweet:0"].status != ReceiptDone || provider.calls[0].RemotePostID != "remote-1" {
		t.Fatalf("repost: %+v", store.receipts["retweet:0"])
	}
	run(AutomationStep{Key: "retweet:0", Kind: AutomationRetweet})
	if len(provider.calls) != 1 {
		t.Fatalf("a done repost acted again: %d calls", len(provider.calls))
	}
	store.receipts["retweet:1"].status = ReceiptCancelled
	run(AutomationStep{Key: "retweet:1", Kind: AutomationRetweet})
	if len(provider.calls) != 1 {
		t.Fatal("a cancelled repost acted")
	}

	provider.result = socialapi.AutomationResult{}
	if result := run(AutomationStep{Key: "plug", Kind: AutomationPlug}); result.Settled ||
		store.receipts["plug"].status != ReceiptPending || store.receipts["plug"].attempts != 1 {
		t.Fatalf("unmet plug: %+v %+v", result, store.receipts["plug"])
	}
	last := provider.calls[len(provider.calls)-1]
	if last.Threshold != 5 || last.Metric != "reposts" || last.Text != "Get the guide" {
		t.Fatalf("plug request = %+v", last)
	}
	if result := run(AutomationStep{Final: true, Key: "plug", Kind: AutomationPlug}); !result.Settled ||
		store.receipts["plug"].status != ReceiptExpired {
		t.Fatalf("expired plug: %+v", store.receipts["plug"])
	}

	store.receipts["retweet:1"].status = ReceiptPending
	provider.err = httpError(403)
	run(AutomationStep{Key: "retweet:1", Kind: AutomationRetweet})
	if got := store.receipts["retweet:1"]; got.status != ReceiptFailed || got.code != "http_403" {
		t.Fatalf("failed repost: %+v", got)
	}
	store.receipts["first-comment"] = &receipt{status: ReceiptPending}
	provider.err = errors.Join(socialapi.ErrUnsupported)
	run(AutomationStep{Key: "first-comment", Kind: AutomationFirstComment})
	if got := store.receipts["first-comment"]; got.status != ReceiptSkipped || got.code != "unsupported" {
		t.Fatalf("unsupported: %+v", got)
	}
}
