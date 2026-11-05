package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type planAnalyzeFake struct {
	fakeConfiguration
	actor   product.Actor
	command product.CalendarCommand
	query   product.AnalyticsQuery
	denied  bool

	noteRange string
}

func (f *planAnalyzeFake) MutateCalendar(_ context.Context, actor product.Actor, command product.CalendarCommand) (*product.CalendarResult, error) {
	f.actor, f.command = actor, command
	if f.denied {
		return nil, publishing.ErrForbidden
	}
	return &product.CalendarResult{Cancelled: []string{"old"}, Scheduled: []*ent.ScheduledPost{{ID: "new", OrganizationID: actor.OrganizationID, ScheduledFor: time.Now()}}}, nil
}
func (f *planAnalyzeFake) GetAnalytics(_ context.Context, actor product.Actor, id string, q product.AnalyticsQuery) (*product.AnalyticsReport, error) {
	f.actor, f.query = actor, q
	return &product.AnalyticsReport{AccountID: id}, nil
}
func (f *planAnalyzeFake) GetPublicAnalytics(_ context.Context, token string, q product.AnalyticsQuery) (*product.AnalyticsReport, error) {
	f.query = q
	return &product.AnalyticsReport{}, nil
}
func (f *planAnalyzeFake) ListCalendarNotes(_ context.Context, actor product.Actor, from, to string) ([]product.CalendarNote, error) {
	f.actor, f.noteRange = actor, from+".."+to
	return []product.CalendarNote{}, nil
}
func (f *planAnalyzeFake) CreateCalendarNote(_ context.Context, actor product.Actor, input product.CalendarNoteInput) (*product.CalendarNote, error) {
	f.actor = actor
	return &product.CalendarNote{ID: "note", Day: input.Day, Title: input.Title, Color: input.Color}, nil
}
func (f *planAnalyzeFake) UpdateCalendarNote(_ context.Context, actor product.Actor, id string, changes product.CalendarNoteChanges) (*product.CalendarNote, error) {
	f.actor = actor
	return &product.CalendarNote{ID: id, Title: changes.Title, Color: changes.Color}, nil
}
func (f *planAnalyzeFake) DeleteCalendarNote(_ context.Context, actor product.Actor, _ string) error {
	f.actor = actor
	if f.denied {
		return publishing.ErrForbidden
	}
	return nil
}
func TestCalendarNotesHTTP(t *testing.T) {
	config := &planAnalyzeFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	const note = "/v1/calendar/notes/c123456789012345678901234"
	for _, c := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodGet, "/v1/calendar/notes?from=2026-11-01&to=2026-11-30", "", 200},
		{http.MethodPost, "/v1/calendar/notes", `{"day":"2026-11-04","title":"Launch","color":"blue"}`, 201},
		{http.MethodPost, "/v1/calendar/notes", `{"organizationId":"foreign"}`, 400},
		{http.MethodPatch, note, `{"title":"Launch","color":"red"}`, 200},
		{http.MethodPatch, note, `{"day":"2026-11-05"}`, 400},
		{http.MethodDelete, note, "", 200},
		{http.MethodDelete, "/v1/calendar/notes/not%20an%20id", "", 400},
	} {
		if response := configurationRequest(handler, c.method, c.path, c.body); response.Code != c.status {
			t.Errorf("%s %s = %d, want %d: %s", c.method, c.path, response.Code, c.status, response.Body)
		}
	}
	if config.actor.OrganizationID != "org-1" || config.noteRange != "2026-11-01..2026-11-30" {
		t.Fatalf("actor=%+v range=%q", config.actor, config.noteRange)
	}
	config.denied = true
	if response := configurationRequest(handler, http.MethodDelete, note, ""); response.Code != 403 {
		t.Fatal(response.Code)
	}
}
func TestPlanAnalyzeHTTPAuthorityContracts(t *testing.T) {
	config, scheduler := &planAnalyzeFake{}, &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, &fakeVerifier{}, "secret", config)
	t.Run("P34 committed calendar result wakes replacement workflows", func(t *testing.T) {
		response := configurationRequest(handler, http.MethodPost, "/v1/calendar/mutations", `{"key":"one","action":"move","items":[]}`)
		if response.Code != 200 || config.actor.OrganizationID != "org-1" || config.command.Key != "one" || scheduler.cancelled != "old" || scheduler.started.PostID != "new" {
			t.Fatalf("response=%d actor=%+v scheduler=%+v", response.Code, config.actor, scheduler)
		}
	})
	t.Run("P35 denied action returns 403 and unknown payload fields fail", func(t *testing.T) {
		config.denied = true
		response := configurationRequest(handler, http.MethodPost, "/v1/calendar/mutations", `{"key":"two","action":"move","items":[]}`)
		if response.Code != 403 {
			t.Fatal(response.Code)
		}
		response = configurationRequest(handler, http.MethodPost, "/v1/calendar/mutations", `{"organizationId":"foreign"}`)
		if response.Code != 400 {
			t.Fatal(response.Code)
		}
	})
	t.Run("A12 query forwards exact scope and rejects malformed cutoff", func(t *testing.T) {
		response := configurationRequest(handler, http.MethodGet, "/v1/analytics/c123456789012345678901234?from=2026-01-01&to=2026-01-31&scope=replies&sort=likes&limit=2", "")
		if response.Code != 200 || config.query.Scope != "replies" || config.query.Limit != 2 || response.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("status=%d query=%+v", response.Code, config.query)
		}
		response = configurationRequest(handler, http.MethodGet, "/v1/analytics/c123456789012345678901234?asOf=invalid", "")
		if response.Code != 400 {
			t.Fatal(response.Code)
		}
	})
	t.Run("A37 public backend requires service authentication and prevents caching", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/v1/internal/analytics/token?limit=2", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 401 {
			t.Fatal(response.Code)
		}
		request.Header.Set("Authorization", "Bearer secret")
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 200 || response.Header().Get("Cache-Control") != "no-store, max-age=0" || config.query.Limit != 2 {
			t.Fatalf("status=%d query=%+v", response.Code, config.query)
		}
	})
}
