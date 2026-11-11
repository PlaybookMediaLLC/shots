package product

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestFounderHubReferralSummaryUsesShotsSessionIdentity(t *testing.T) {
	w := newTestWorkspace(t)
	result, err := w.repo.FounderHubReferralSummary(w.ctx, w.owner)
	if err != nil {
		t.Fatal(err)
	}
	var summary struct {
		Enabled   bool            `json:"enabled"`
		Eligible  bool            `json:"eligible"`
		Code      *string         `json:"code"`
		Accepted  int             `json:"accepted"`
		Remaining int             `json:"remaining"`
		Invites   json.RawMessage `json:"invites"`
	}
	if err := json.Unmarshal(result, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Remaining < 0 || !json.Valid(summary.Invites) {
		t.Fatalf("invalid referral summary: %s", result)
	}
}

func TestFounderHubReferralClaimRejectsMalformedCode(t *testing.T) {
	_, err := (&Configuration{}).ClaimFounderHubReferral(t.Context(), Actor{}, "not-a-referral-code")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("malformed code error = %v", err)
	}
}
