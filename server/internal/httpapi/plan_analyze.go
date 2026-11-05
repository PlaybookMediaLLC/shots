package httpapi

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"net/http"
	"strconv"
	"time"
)

type PlanAnalyzeStore interface {
	MutateCalendar(context.Context, product.Actor, product.CalendarCommand) (*product.CalendarResult, error)
	GetAnalytics(context.Context, product.Actor, string, product.AnalyticsQuery) (*product.AnalyticsReport, error)
	GetPublicAnalytics(context.Context, string, product.AnalyticsQuery) (*product.AnalyticsReport, error)
	UpdateAnalyticsSettings(context.Context, product.Actor, string, product.AnalyticsSettingsInput) (*product.AnalyticsSettings, error)
	RefreshAnalytics(context.Context, product.Actor, string) error
	ListCalendarNotes(context.Context, product.Actor, string, string) ([]product.CalendarNote, error)
	CreateCalendarNote(context.Context, product.Actor, product.CalendarNoteInput) (*product.CalendarNote, error)
	UpdateCalendarNote(context.Context, product.Actor, string, product.CalendarNoteChanges) (*product.CalendarNote, error)
	DeleteCalendarNote(context.Context, product.Actor, string) error
}

func (s *Server) registerPlanAnalyze(mux *http.ServeMux) {
	mux.Handle("POST /v1/calendar/mutations", s.authenticateProduct(http.HandlerFunc(s.calendarMutation)))
	mux.Handle("GET /v1/calendar/notes", s.authenticateProduct(http.HandlerFunc(s.listCalendarNotes)))
	mux.Handle("POST /v1/calendar/notes", s.authenticateProduct(http.HandlerFunc(s.createCalendarNote)))
	mux.Handle("PATCH /v1/calendar/notes/{id}", s.authenticateProduct(http.HandlerFunc(s.updateCalendarNote)))
	mux.Handle("DELETE /v1/calendar/notes/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteCalendarNote)))
	mux.Handle("GET /v1/analytics/{id}", s.authenticateProduct(http.HandlerFunc(s.getAnalytics)))
	mux.Handle("POST /v1/analytics/{id}/refresh", s.authenticateProduct(http.HandlerFunc(s.refreshAnalytics)))
	mux.Handle("PUT /v1/analytics/{id}/settings", s.authenticateProduct(http.HandlerFunc(s.analyticsSettings)))
	mux.Handle("GET /v1/internal/analytics/{token}", s.authenticateService(http.HandlerFunc(s.publicAnalytics)))
}
func (s *Server) calendarMutation(w http.ResponseWriter, r *http.Request) {
	var input product.CalendarCommand
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, "invalid calendar command")
		return
	}
	result, err := s.configuration.MutateCalendar(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	// Database commitment is the result. Wakeups are an optimization; the existing
	// recovery dispatcher safely starts durable scheduled rows after a transient failure.
	for _, id := range result.Cancelled {
		_ = s.scheduler.Cancel(r.Context(), id)
	}
	for _, post := range result.Scheduled {
		_ = s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor})
	}
	writeJSON(w, 200, result)
}
func (s *Server) listCalendarNotes(w http.ResponseWriter, r *http.Request) {
	notes, err := s.configuration.ListCalendarNotes(r.Context(), workspaceActor(r), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": notes})
}
func (s *Server) createCalendarNote(w http.ResponseWriter, r *http.Request) {
	var input product.CalendarNoteInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, "invalid calendar note")
		return
	}
	note, err := s.configuration.CreateCalendarNote(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 201, note)
}
func (s *Server) updateCalendarNote(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var changes product.CalendarNoteChanges
	if err := decodeJSON(r, &changes); err != nil {
		writeError(w, 400, "invalid calendar note")
		return
	}
	note, err := s.configuration.UpdateCalendarNote(r.Context(), workspaceActor(r), ids[0], changes)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, note)
}
func (s *Server) deleteCalendarNote(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteCalendarNote(r.Context(), workspaceActor(r), ids[0]); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true})
}
func readAnalyticsQuery(w http.ResponseWriter, r *http.Request) (product.AnalyticsQuery, bool) {
	params := r.URL.Query()
	q := product.AnalyticsQuery{From: params.Get("from"), To: params.Get("to"), TimeZone: params.Get("timeZone"), Grouping: params.Get("grouping"), Scope: params.Get("scope"), Sort: params.Get("sort"), Direction: params.Get("direction"), Cursor: params.Get("cursor")}
	if raw := params.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, 400, "invalid page size")
			return q, false
		}
		q.Limit = n
	}
	if raw := params.Get("asOf"); raw != "" {
		at, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeError(w, 400, "invalid observation cutoff")
			return q, false
		}
		q.AsOf = &at
	}
	return q, true
}
func (s *Server) getAnalytics(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	q, ok := readAnalyticsQuery(w, r)
	if !ok {
		return
	}
	report, err := s.configuration.GetAnalytics(r.Context(), workspaceActor(r), ids[0], q)
	w.Header().Set("Cache-Control", "private, no-store")
	respond(w, 200, report, err)
}
func (s *Server) refreshAnalytics(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	err := s.configuration.RefreshAnalytics(r.Context(), workspaceActor(r), ids[0])
	respond(w, 200, map[string]bool{"refreshed": err == nil}, err)
}
func (s *Server) analyticsSettings(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.AnalyticsSettingsInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, 400, "invalid analytics settings")
		return
	}
	result, err := s.configuration.UpdateAnalyticsSettings(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, 200, result, err)
}
func (s *Server) publicAnalytics(w http.ResponseWriter, r *http.Request) {
	q, ok := readAnalyticsQuery(w, r)
	if !ok {
		return
	}
	report, err := s.configuration.GetPublicAnalytics(r.Context(), r.PathValue("token"), q)
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	respond(w, 200, report, err)
}
