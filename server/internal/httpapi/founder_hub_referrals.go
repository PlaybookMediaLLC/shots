package httpapi

import (
	"net/http"
)

type founderHubReferralClaimInput struct {
	Code string `json:"code"`
}

func (s *Server) getFounderHubReferralSummary(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.FounderHubReferralSummary(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, result, err)
}

func (s *Server) claimFounderHubReferral(w http.ResponseWriter, r *http.Request) {
	var input founderHubReferralClaimInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid referral claim")
		return
	}
	result, err := s.configuration.ClaimFounderHubReferral(r.Context(), workspaceActor(r), input.Code)
	respond(w, http.StatusOK, result, err)
}
