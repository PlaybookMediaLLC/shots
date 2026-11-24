package httpapi

import (
	"bytes"
	"encoding/json"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
	"io"
	"net/http"
)

// Validate original bytes before encoding/json can replace malformed Unicode.
func decodeReadinessJSON(r *http.Request, target any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if err != nil {
		return err
	}
	if len(raw) > 1024*1024 {
		return product.ErrInvalidInput
	}
	if _, err := releasefacts.CanonicalJSON(raw); err != nil {
		return product.ErrInvalidInput
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeReadinessMutation(w http.ResponseWriter, result *product.ReadinessMutation, err error) {
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

func (s *Server) createReleaseEvidence(w http.ResponseWriter, r *http.Request) {
	var input product.CreateReleaseEvidenceInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.CreateReleaseEvidence(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) linkReleaseEvidence(w http.ResponseWriter, r *http.Request) {
	var input product.LinkReleaseEvidenceInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.LinkReleaseEvidence(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) changeEvidenceAccess(w http.ResponseWriter, r *http.Request) {
	var input product.ChangeEvidenceAccessInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.ChangeEvidenceAccess(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) saveReleaseClaim(w http.ResponseWriter, r *http.Request) {
	var input product.SaveReleaseClaimInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.SaveReleaseClaim(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) setClaimSupports(w http.ResponseWriter, r *http.Request) {
	var input product.SetClaimSupportsInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.SetClaimSupports(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("claimId"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) verifyReleaseClaim(w http.ResponseWriter, r *http.Request) {
	var input product.VerifyReleaseClaimInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.VerifyReleaseClaim(r.Context(), workspaceActor(r), r.PathValue("id"), r.PathValue("claimId"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) importReleaseSpecClaims(w http.ResponseWriter, r *http.Request) {
	var input product.ImportReleaseSpecInput
	if decodeReadinessJSON(r, &input) != nil {
		writeError(w, http.StatusBadRequest, "invalid release readiness request")
		return
	}
	result, err := s.configuration.ImportReleaseSpecClaims(r.Context(), workspaceActor(r), r.PathValue("id"), r.Header.Get("Idempotency-Key"), input)
	writeReadinessMutation(w, result, err)
}

func (s *Server) listReleaseEvidence(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.ListReleaseEvidence(r.Context(), workspaceActor(r), r.PathValue("id"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) listReleaseClaims(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.ListReleaseClaims(r.Context(), workspaceActor(r), r.PathValue("id"), r.URL.Query().Get("cursor"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
