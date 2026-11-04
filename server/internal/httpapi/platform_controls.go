package httpapi

import (
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
)

// registerPlatformControls exposes audit drains, audit retention, source
// webhook ingestion, outbox replay, and billing entitlements. Drain, retention,
// and contract reads are rechecked as sensitive sessions in the product layer.
func (s *Server) registerPlatformControls(mux *http.ServeMux) {
	mux.Handle("GET /v1/audit-drains", s.authenticateProduct(http.HandlerFunc(s.listAuditDrains)))
	mux.Handle("POST /v1/audit-drains", s.authenticateProduct(http.HandlerFunc(s.createAuditDrain)))
	mux.Handle("DELETE /v1/audit-drains/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteAuditDrain)))
	mux.Handle("GET /v1/audit-retention", s.authenticateProduct(http.HandlerFunc(s.getAuditRetention)))
	mux.Handle("PUT /v1/audit-retention", s.authenticateProduct(http.HandlerFunc(s.updateAuditRetention)))
	mux.Handle("GET /v1/whitelabel", s.authenticateProduct(http.HandlerFunc(s.getWhitelabel)))
	mux.Handle("PUT /v1/whitelabel", s.authenticateProduct(http.HandlerFunc(s.updateWhitelabel)))
	mux.Handle("GET /v1/internal/source-apps/{id}/webhook", s.authenticateService(http.HandlerFunc(s.getWebhookSource)))
	mux.Handle("POST /v1/source-releases", s.authenticateProduct(http.HandlerFunc(s.ingestSourceRelease)))
	mux.Handle("POST /v1/internal/outbox-events/{id}/replay", s.authenticateService(http.HandlerFunc(s.replayOutboxEvent)))
	mux.Handle("POST /v1/internal/billing/entitlements", s.authenticateService(http.HandlerFunc(s.syncWorkspaceEntitlement)))
	mux.Handle("POST /v1/internal/billing/credit-grants", s.authenticateService(http.HandlerFunc(s.grantWorkspaceCredits)))
	mux.Handle("GET /v1/entitlements/contract", s.authenticateProduct(http.HandlerFunc(s.getWorkspaceEntitlement)))
}

func auditRequest(w http.ResponseWriter, r *http.Request) (product.AuditRequest, bool) {
	request := product.AuditRequest{IPHash: r.Header.Get("X-Audit-IP-Hash"), UserAgentSummary: r.Header.Get("X-Audit-User-Agent-Summary")}
	if len(request.IPHash) > 128 || len(request.UserAgentSummary) > 300 {
		writeError(w, http.StatusBadRequest, "invalid audit context")
		return request, false
	}
	return request, true
}

func (s *Server) listAuditDrains(w http.ResponseWriter, r *http.Request) {
	drains, err := s.configuration.ListAuditDrains(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"drains": drains})
}

func (s *Server) createAuditDrain(w http.ResponseWriter, r *http.Request) {
	var input product.CreateAuditDrainInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	drain, err := s.configuration.CreateAuditDrain(r.Context(), workspaceActor(r), input, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"drain": drain})
}

func (s *Server) deleteAuditDrain(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "audit drain not found")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	if err := s.configuration.DeleteAuditDrain(r.Context(), workspaceActor(r), id, audit); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) getAuditRetention(w http.ResponseWriter, r *http.Request) {
	policy, err := s.configuration.GetAuditRetention(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (s *Server) updateAuditRetention(w http.ResponseWriter, r *http.Request) {
	var input product.AuditRetention
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	policy, err := s.configuration.UpdateAuditRetention(r.Context(), workspaceActor(r), input, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}

func (s *Server) getWhitelabel(w http.ResponseWriter, r *http.Request) {
	settings, err := s.configuration.GetWhitelabel(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) updateWhitelabel(w http.ResponseWriter, r *http.Request) {
	var input whitelabel.Settings
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	settings, err := s.configuration.UpdateWhitelabel(r.Context(), workspaceActor(r), input, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) getWebhookSource(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "source app not found")
		return
	}
	source, err := s.configuration.GetWebhookSource(r.Context(), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, source)
}

func (s *Server) ingestSourceRelease(w http.ResponseWriter, r *http.Request) {
	var input product.IngestSourceReleaseInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	result, err := s.configuration.IngestSourceRelease(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

func (s *Server) replayOutboxEvent(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "dead-lettered outbox event not found")
		return
	}
	if err := s.configuration.ReplayOutboxEvent(r.Context(), id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"replayed": true})
}

func (s *Server) syncWorkspaceEntitlement(w http.ResponseWriter, r *http.Request) {
	var input product.EntitlementSyncInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid billing event")
		return
	}
	result, err := s.configuration.SyncWorkspaceEntitlement(r.Context(), input)
	var conflict product.EntitlementConflictError
	if errors.As(err, &conflict) {
		// The billing facade retries against the current version.
		writeJSON(w, http.StatusConflict, map[string]any{"currentVersion": conflict.Current, "error": conflict.Error()})
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// grantWorkspaceCredits adds a paid AI credit pack once per provider reference.
func (s *Server) grantWorkspaceCredits(w http.ResponseWriter, r *http.Request) {
	var input product.CreditGrantInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid credit grant")
		return
	}
	result, err := s.configuration.GrantWorkspaceCredits(r.Context(), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getWorkspaceEntitlement(w http.ResponseWriter, r *http.Request) {
	entitlement, err := s.configuration.GetWorkspaceEntitlement(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entitlement": entitlement})
}
