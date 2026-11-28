package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestSettingsEnhancementsHTTPHandlers(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)

	// POST /v1/me/sessions/revoke-all returns 200 with revoked counts for session actors.
	revokeResp := configurationRequest(handler, http.MethodPost, "/v1/me/sessions/revoke-all", "")
	if revokeResp.Code != http.StatusOK {
		t.Fatalf("revoke-all expected 200, got %d body=%s", revokeResp.Code, revokeResp.Body.String())
	}
	var revokeBody map[string]int
	if err := json.Unmarshal(revokeResp.Body.Bytes(), &revokeBody); err != nil {
		t.Fatalf("decode revoke-all response: %v", err)
	}
	if revokeBody["revokedSessions"] != 1 {
		t.Fatalf("expected revokedSessions=1, got %v", revokeBody)
	}

	// PUT /v1/workspace/publishing-settings accepts valid integer, null clear, and boolean updates.
	setGoal := configurationRequest(handler, http.MethodPut, "/v1/workspace/publishing-settings", `{"weeklyPostingGoal":7,"processVideosOnServer":false}`)
	if setGoal.Code != http.StatusOK {
		t.Fatalf("set publishing settings expected 200, got %d body=%s", setGoal.Code, setGoal.Body.String())
	}
	var setBody struct {
		Settings struct {
			WeeklyPostingGoal     *int `json:"weeklyPostingGoal"`
			ProcessVideosOnServer bool `json:"processVideosOnServer"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(setGoal.Body.Bytes(), &setBody); err != nil {
		t.Fatalf("decode set publishing settings: %v", err)
	}
	if setBody.Settings.WeeklyPostingGoal == nil || *setBody.Settings.WeeklyPostingGoal != 7 || setBody.Settings.ProcessVideosOnServer {
		t.Fatalf("unexpected set publishing settings body: %+v", setBody.Settings)
	}

	clearGoal := configurationRequest(handler, http.MethodPut, "/v1/workspace/publishing-settings", `{"weeklyPostingGoal":null}`)
	if clearGoal.Code != http.StatusOK {
		t.Fatalf("clear weeklyPostingGoal expected 200, got %d body=%s", clearGoal.Code, clearGoal.Body.String())
	}
	var clearBody struct {
		Settings struct {
			WeeklyPostingGoal *int `json:"weeklyPostingGoal"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(clearGoal.Body.Bytes(), &clearBody); err != nil {
		t.Fatalf("decode clear publishing settings: %v", err)
	}
	if clearBody.Settings.WeeklyPostingGoal != nil {
		t.Fatalf("expected cleared weeklyPostingGoal=nil, got %v", *clearBody.Settings.WeeklyPostingGoal)
	}

	badJSON := configurationRequest(handler, http.MethodPut, "/v1/workspace/publishing-settings", `{"weeklyPostingGoal":"seven"}`)
	if badJSON.Code != http.StatusBadRequest {
		t.Fatalf("invalid weeklyPostingGoal JSON expected 400, got %d body=%s", badJSON.Code, badJSON.Body.String())
	}

	// GET /v1/workspace/weekly-goal-progress forwards weekStart query and returns 200.
	progressResp := configurationRequest(handler, http.MethodGet, "/v1/workspace/weekly-goal-progress?weekStart=sunday", "")
	if progressResp.Code != http.StatusOK || config.weeklyGoalWeekStart != "sunday" {
		t.Fatalf("weekly-goal-progress expected 200 and weekStart=sunday, got %d weekStart=%q body=%s", progressResp.Code, config.weeklyGoalWeekStart, progressResp.Body.String())
	}

	// POST /v1/internal/email/unsubscribe rejects empty token (400) and forwards valid payload (200).
	emptyUnsub := configurationRequest(handler, http.MethodPost, "/v1/internal/email/unsubscribe", `{"token":""}`)
	if emptyUnsub.Code != http.StatusBadRequest {
		t.Fatalf("empty unsubscribe token expected 400, got %d", emptyUnsub.Code)
	}
	validUnsub := configurationRequest(handler, http.MethodPost, "/v1/internal/email/unsubscribe", `{"token":"signed-token-value"}`)
	if validUnsub.Code != http.StatusOK || config.unsubscribeToken != "signed-token-value" {
		t.Fatalf("valid unsubscribe expected 200 and forwarded token, got %d token=%q body=%s", validUnsub.Code, config.unsubscribeToken, validUnsub.Body.String())
	}
	var unsubBody map[string]bool
	if err := json.Unmarshal(validUnsub.Body.Bytes(), &unsubBody); err != nil || !unsubBody["unsubscribed"] {
		t.Fatalf("expected {unsubscribed:true}, got %s", validUnsub.Body.String())
	}

	// Missing service bearer token must fail with 401.
	unauthReq := httptest.NewRequest(http.MethodPost, "/v1/internal/email/unsubscribe", strings.NewReader(`{"token":"signed-token-value"}`))
	unauthRec := httptest.NewRecorder()
	handler.ServeHTTP(unauthRec, unauthReq)
	if unauthRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated internal unsubscribe expected 401, got %d", unauthRec.Code)
	}

	// Verify forbidden error propagation on PUT /v1/workspace/publishing-settings.
	config.authorizationError = publishing.ErrForbidden
	forbiddenGoal := configurationRequest(handler, http.MethodPut, "/v1/workspace/publishing-settings", `{"weeklyPostingGoal":7}`)
	if forbiddenGoal.Code != http.StatusForbidden {
		t.Fatalf("forbidden publishing-settings update expected 403, got %d", forbiddenGoal.Code)
	}
	config.authorizationError = nil

	// POST /v1/me/sessions/revoke-all strictly requires session headers (rejects missing headers and API keys with 401).
	noUserReq := httptest.NewRequest(http.MethodPost, "/v1/me/sessions/revoke-all", nil)
	noUserReq.Header.Set("Authorization", "Bearer secret")
	noUserRec := httptest.NewRecorder()
	handler.ServeHTTP(noUserRec, noUserReq)
	if noUserRec.Code != http.StatusUnauthorized {
		t.Fatalf("sessionless revoke-all expected 401, got %d", noUserRec.Code)
	}

	apiKeyReq := httptest.NewRequest(http.MethodPost, "/v1/me/sessions/revoke-all", nil)
	apiKeyReq.Header.Set("Authorization", "Bearer secret")
	apiKeyReq.Header.Set("X-User-ID", "user-1")
	apiKeyReq.Header.Set("X-Principal-Kind", "api_key")
	apiKeyRec := httptest.NewRecorder()
	handler.ServeHTTP(apiKeyRec, apiKeyReq)
	if apiKeyRec.Code != http.StatusUnauthorized {
		t.Fatalf("api-key revoke-all expected 401, got %d", apiKeyRec.Code)
	}
}
