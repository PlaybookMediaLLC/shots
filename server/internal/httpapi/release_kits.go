package httpapi

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"net/http"
)

func (s *Server) createReleaseKitRevision(w http.ResponseWriter, r *http.Request) {
	var input product.CreateReleaseKitInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid kit request")
		return
	}
	result, err := s.configuration.CreateReleaseKitRevision(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) prepareReleaseKit(w http.ResponseWriter, r *http.Request) {
	var input product.PrepareReleaseKitInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid kit request")
		return
	}
	result, err := s.configuration.PrepareReleaseKit(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("revisionId"), r.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	status := http.StatusAccepted
	if !result.Created {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) decideReleaseKit(w http.ResponseWriter, r *http.Request) {
	var input product.DecideReleaseKitInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid kit request")
		return
	}
	result, err := s.configuration.DecideReleaseKit(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("revisionId"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) requestKitExport(w http.ResponseWriter, r *http.Request) {
	var input product.RequestKitExportInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid kit request")
		return
	}
	result, err := s.configuration.RequestKitExport(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("revisionId"), r.Header.Get("Idempotency-Key"), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	status := http.StatusAccepted
	if !result.Created {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) getReleaseKit(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetReleaseKit(r.Context(), workspaceActor(r), r.PathValue("id"), r.URL.Query().Get("revisionId"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) getKitExport(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("download")
	if query != "" && query != "true" && query != "false" {
		writeError(w, http.StatusBadRequest, "invalid download option")
		return
	}
	result, err := s.configuration.GetKitExport(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("exportId"), query == "true")
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getKitArtifactPreview(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetKitArtifactPreview(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("revisionId"), r.PathValue("artifactId"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) readKitExportDownload(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
	}
	if decodeJSON(r, &input) != nil || len(input.Token) > 4096 {
		writeError(w, http.StatusBadRequest, "invalid download grant")
		return
	}
	body, err := s.configuration.ReadKitExportDownload(r.Context(), r.PathValue("id"), r.PathValue("exportId"), input.Token, r.Header.Get("X-Request-ID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="release-kit.zip"`)
	serveAssetBytes(w, r, body, "application/zip")
}
