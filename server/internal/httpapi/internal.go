package httpapi

import (
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/authstore"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/jackc/pgx/v5/pgconn"
)

// registerInternal exposes facade-only operations. They authenticate the web
// tier with the service token alone because they run before a session exists
// (the Better Auth adapter) or record effects of an auth change it made.
func (s *Server) registerInternal(mux *http.ServeMux) {
	mux.Handle("GET /v1/internal/founder-hub/users/{id}", s.authenticateService(http.HandlerFunc(s.founderHubProfile)))
	mux.Handle("POST /v1/internal/auth-store", s.authenticateService(http.HandlerFunc(s.executeAuthStore)))
	mux.Handle("POST /v1/internal/auth-events", s.authenticateService(http.HandlerFunc(s.recordAuthEvent)))
	mux.Handle("GET /v1/internal/workspaces/{id}/operational", s.authenticateService(http.HandlerFunc(s.workspaceOperational)))
	mux.Handle("GET /v1/internal/workspaces/{id}/seat", s.authenticateService(http.HandlerFunc(s.workspaceSeat)))
	mux.Handle("POST /v1/audit-events", s.authenticateProduct(http.HandlerFunc(s.appendAuditEvent)))
}

func (s *Server) founderHubProfile(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetFounderHubProfile(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) executeAuthStore(w http.ResponseWriter, r *http.Request) {
	var request authstore.Request
	if err := decodeJSON(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid auth store request")
		return
	}
	result, err := s.configuration.ExecuteAuthStore(r.Context(), request)
	var pgError *pgconn.PgError
	switch {
	case errors.Is(err, authstore.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.As(err, &pgError) && pgError.Code == "23505":
		writeError(w, http.StatusConflict, "the record already exists")
	case err != nil:
		writeStoreError(w, err)
	default:
		writeJSON(w, http.StatusOK, result)
	}
}

func (s *Server) recordAuthEvent(w http.ResponseWriter, r *http.Request) {
	var event product.AuthEvent
	if err := decodeJSON(r, &event); err != nil {
		writeError(w, http.StatusBadRequest, "invalid auth event")
		return
	}
	if err := s.configuration.RecordAuthEvent(r.Context(), event); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"recorded": true})
}

func (s *Server) workspaceOperational(w http.ResponseWriter, r *http.Request) {
	operational, err := s.configuration.WorkspaceOperational(r.Context(), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"operational": operational})
}

// workspaceSeat answers whether the workspace has a seat for one more member;
// invitations=true counts pending invitations as held seats.
func (s *Server) workspaceSeat(w http.ResponseWriter, r *http.Request) {
	if err := s.configuration.RequireSeat(r.Context(), r.PathValue("id"), r.URL.Query().Get("invitations") == "true"); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"available": true})
}

func (s *Server) appendAuditEvent(w http.ResponseWriter, r *http.Request) {
	var input product.AuditEventInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid audit event")
		return
	}
	if err := s.configuration.AppendAuditEvent(r.Context(), workspaceActor(r), input); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"recorded": true})
}
