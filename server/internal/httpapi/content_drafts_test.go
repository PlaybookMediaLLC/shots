package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

type contentDraftFake struct {
	fakeConfiguration
	update product.ContentDraftUpdate
}

func (f *contentDraftFake) UpdateContentDraft(_ context.Context, _ product.Actor, _ string, input product.ContentDraftUpdate) (*product.ContentDraftRecord, error) {
	f.update = input
	return nil, &product.ContentDraftVersionConflictError{Current: 5}
}

// A stale draft write answers 409 with the version the client must load.
func TestStaleContentDraftWriteReturnsCurrentVersion(t *testing.T) {
	config := &contentDraftFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodPatch, "/v1/content-drafts/c123456789012345678901234",
		`{"baseVersion":3,"title":"New"}`)
	var body struct {
		Code           string `json:"code"`
		CurrentVersion int    `json:"currentVersion"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || body.Code != "content_draft_version_conflict" || body.CurrentVersion != 5 ||
		config.update.BaseVersion != 3 || config.update.Title == nil || *config.update.Title != "New" {
		t.Fatalf("status=%d body=%+v update=%+v", response.Code, body, config.update)
	}
	if invalid := configurationRequest(handler, http.MethodGet, "/v1/content-drafts/not-an-id!", ""); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid draft ID status=%d", invalid.Code)
	}
	if unknown := configurationRequest(handler, http.MethodPatch, "/v1/content-drafts/c123456789012345678901234",
		`{"baseVersion":3,"organizationId":"other"}`); unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d", unknown.Code)
	}
}

type draftScheduleFake struct {
	fakeConfiguration
	input product.ScheduleContentDraftInput
}

func (f *draftScheduleFake) ScheduleContentDraft(_ context.Context, _ product.Actor, _ string, input product.ScheduleContentDraftInput) (*product.ScheduleContentDraftResult, error) {
	f.input = input
	return &product.ScheduleContentDraftResult{
		Cancelled: []string{"old-post"}, Created: true,
		Scheduled: []*ent.ScheduledPost{{ID: "new-post", OrganizationID: "org-1", ScheduledFor: input.ScheduledFor}},
	}, nil
}

// Scheduling stops the replaced workflow and starts one per new post.
func TestScheduleContentDraftStartsWorkflows(t *testing.T) {
	config, scheduler := &draftScheduleFake{}, &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, &fakeVerifier{}, "secret", config)
	at := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	response := configurationRequest(handler, http.MethodPost, "/v1/content-drafts/c123456789012345678901234/schedule",
		fmt.Sprintf(`{"scheduledFor":%q,"targets":[{"caption":"Hi","channelConnectionId":"c123456789012345678901235"}],"version":2}`, at.Format(time.RFC3339)))
	if response.Code != http.StatusCreated || config.input.Version != 2 || len(config.input.Targets) != 1 {
		t.Fatalf("status=%d body=%s input=%+v", response.Code, response.Body.String(), config.input)
	}
	if scheduler.cancelled != "old-post" || scheduler.started.PostID != "new-post" || !scheduler.started.ScheduledFor.Equal(at) {
		t.Fatalf("cancelled=%q started=%+v", scheduler.cancelled, scheduler.started)
	}
}

// A direct scheduled post names exactly one source.
func TestCreateScheduledPostRequiresExactlyOneSource(t *testing.T) {
	handler := New(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret")
	at := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	for _, source := range []string{``, `,"variantId":"v1","contentDraftId":"d1"`} {
		body := fmt.Sprintf(`{"caption":"hi","channelConnectionId":"c1","idempotencyKey":"k1","scheduledFor":%q%s}`, at, source)
		request := httptest.NewRequest(http.MethodPost, "/v1/scheduled-posts", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer secret")
		request.Header.Set("X-Organization-ID", "org-1")
		request.Header.Set("X-User-ID", "user-1")
		request.Header.Set("X-Session-ID", "session-1")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("source %q status=%d", source, response.Code)
		}
	}
}

type unreachableScheduler struct{ fakeScheduler }

func (*unreachableScheduler) Start(context.Context, temporalpublishing.ScheduleInput) error {
	return errors.New("temporal unavailable")
}
func (*unreachableScheduler) Cancel(context.Context, string) error {
	return errors.New("temporal unavailable")
}

// When Temporal cannot be reached the request fails, but says the schedule is
// saved: the dispatcher starts the due post, and a replaced post is never claimed.
func TestScheduleContentDraftReportsSavedScheduleWhenWorkflowWakeupFails(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &unreachableScheduler{}, &fakeVerifier{}, "secret", &draftScheduleFake{})
	at := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	response := configurationRequest(handler, http.MethodPost, "/v1/content-drafts/c123456789012345678901234/schedule",
		fmt.Sprintf(`{"scheduledFor":%q,"targets":[{"caption":"Hi","channelConnectionId":"c123456789012345678901235"}],"version":2}`, at.Format(time.RFC3339)))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "schedule is saved") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

type unstartedRunFake struct{ fakeConfiguration }

func (*unstartedRunFake) SubmitContentBatch(context.Context, product.Actor, string, product.BatchSubmitInput) (*product.BatchRunRecord, error) {
	return nil, product.ErrBatchRunNotStarted
}

// A run saved without its workflow answers as a failure saying a retry is safe.
func TestSubmitContentBatchSaysARetryIsSafeWhenTheWorkflowDoesNotStart(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &unstartedRunFake{})
	response := configurationRequest(handler, http.MethodPost, "/v1/content-batches/c123456789012345678901234/submit",
		`{"requestKey":"submit-request-key-0001","items":[{"itemId":"c123456789012345678901235","refusal":"No."}]}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "nothing is scheduled twice") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

type takenSlotFake struct{ fakeConfiguration }

func (*takenSlotFake) ScheduleContentDraft(context.Context, product.Actor, string, product.ScheduleContentDraftInput) (*product.ScheduleContentDraftResult, error) {
	return nil, &product.QueueSlotTakenError{Next: time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)}
}

// A reviewed queue slot that was taken answers 409 with the next free slot.
func TestScheduleContentDraftNamesNextFreeSlotOnConflict(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &takenSlotFake{})
	response := configurationRequest(handler, http.MethodPost, "/v1/content-drafts/c123456789012345678901234/schedule",
		`{"queue":true,"expectedQueueSlot":"2026-11-01T09:00:00Z","targets":[{"caption":"Hi","channelConnectionId":"c123456789012345678901235"}],"version":2}`)
	var body struct {
		Code          string `json:"code"`
		NextQueueSlot string `json:"nextQueueSlot"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || body.Code != "queue_slot_taken" || body.NextQueueSlot != "2026-11-02T09:00:00Z" {
		t.Fatalf("status=%d body=%+v", response.Code, body)
	}
}

type duplicateFake struct {
	fakeConfiguration
	input product.ScheduleContentDraftInput
}

func (f *duplicateFake) ScheduleContentDraft(_ context.Context, _ product.Actor, _ string, input product.ScheduleContentDraftInput) (*product.ScheduleContentDraftResult, error) {
	f.input = input
	return nil, &product.DuplicateContentError{Posts: []product.DuplicatePost{{
		At: time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC), ChannelConnectionID: "c123456789012345678901235", PostID: "p1", Status: "PUBLISHED",
	}}}
}

// A repeat on an account answers 409 with the posts it repeats, and the
// member's confirmation reaches the domain.
func TestScheduleContentDraftNamesTheDuplicatesItFound(t *testing.T) {
	fake := &duplicateFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", fake)
	response := configurationRequest(handler, http.MethodPost, "/v1/content-drafts/c123456789012345678901234/schedule",
		`{"confirmDuplicate":true,"scheduledFor":"2026-11-02T10:00:00Z","targets":[{"caption":"Hi","channelConnectionId":"c123456789012345678901235"}],"version":2}`)
	var body struct {
		Code       string                  `json:"code"`
		Duplicates []product.DuplicatePost `json:"duplicates"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || body.Code != "duplicate_content" || len(body.Duplicates) != 1 || body.Duplicates[0].PostID != "p1" || !fake.input.ConfirmDuplicate {
		t.Fatalf("status=%d body=%+v confirm=%v", response.Code, body, fake.input.ConfirmDuplicate)
	}
}
