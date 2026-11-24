package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

func (s *Server) getReleaseQualification(w http.ResponseWriter, r *http.Request) {
	if !resourceIDPattern.MatchString(r.PathValue("id")) {
		writeError(w, http.StatusBadRequest, "invalid release ID")
		return
	}
	result, err := s.configuration.GetReleaseQualification(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getQualificationRevision(w http.ResponseWriter, r *http.Request) {
	if !resourceIDPattern.MatchString(r.PathValue("id")) || !resourceIDPattern.MatchString(r.PathValue("revisionId")) {
		writeError(w, http.StatusBadRequest, "invalid qualification revision ID")
		return
	}
	result, err := s.configuration.GetQualificationRevision(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("revisionId"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) createReleaseQualification(w http.ResponseWriter, r *http.Request) {
	var input product.CreateQualificationInput
	if !resourceIDPattern.MatchString(r.PathValue("id")) || decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release qualification request")
		return
	}
	result, err := s.configuration.CreateQualificationRevision(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
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

func (s *Server) decideReleaseQualification(w http.ResponseWriter, r *http.Request) {
	var input product.DecideQualificationInput
	if !resourceIDPattern.MatchString(r.PathValue("id")) || decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release qualification decision")
		return
	}
	result, err := s.configuration.DecideQualification(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
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

func (s *Server) listReleaseSources(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.ListReleaseSources(r.Context(), workspaceActor(r), r.URL.Query().Get("releaseId"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getReleaseSourceHistory(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetReleaseSourceHistory(r.Context(), workspaceActor(r), r.PathValue("id"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) selectReleaseSources(w http.ResponseWriter, r *http.Request) {
	var input product.SelectReleaseSourcesInput
	if decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release source selection")
		return
	}
	result, err := s.configuration.SelectReleaseSources(r.Context(), workspaceActor(r), r.Header.Get("Idempotency-Key"), input)
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

func (s *Server) getReleaseLineage(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetReleaseLineage(r.Context(), workspaceActor(r), r.PathValue("id"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) mergeRelease(w http.ResponseWriter, r *http.Request) {
	var input product.MergeReleaseInput
	if !resourceIDPattern.MatchString(r.PathValue("id")) || decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release merge request")
		return
	}
	result, err := s.configuration.MergeRelease(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
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

func (s *Server) splitRelease(w http.ResponseWriter, r *http.Request) {
	var input product.SplitReleaseInput
	if !resourceIDPattern.MatchString(r.PathValue("id")) || decodeJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release split request")
		return
	}
	result, err := s.configuration.SplitRelease(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
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
