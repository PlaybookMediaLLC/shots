package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// captureEmailAuthStore is unattended email sign-in (RFC 007A). Handlers only
// adapt transport: roles, tenancy, and every fence live in the product package.
type captureEmailAuthStore interface {
	GetCaptureEmailAuth(context.Context, product.Actor, string) (*product.CaptureEmailAuthRecord, error)
	CreateCaptureEmailAuth(context.Context, product.Actor, string) (*product.CaptureEmailAuthRecord, error)
	SaveCaptureEmailAuthRecipe(context.Context, product.Actor, string, product.SaveCaptureEmailAuthRecipeInput) (*product.CaptureEmailAuthRecord, error)
	TestCaptureEmailAuth(context.Context, product.Actor, string) (*product.CaptureAuthAttemptRecord, error)
	EnableCaptureEmailAuth(context.Context, product.Actor, string, product.EnableCaptureEmailAuthInput) (*product.CaptureEmailAuthRecord, error)
	PauseCaptureEmailAuth(context.Context, product.Actor, string) (*product.CaptureEmailAuthRecord, error)
	RevokeCaptureEmailAuth(context.Context, product.Actor, string) error
	GetCaptureAuthAttempt(context.Context, product.Actor, string) (*product.CaptureAuthAttemptRecord, error)
	CancelCaptureAuthAttempt(context.Context, product.Actor, string) error
	ReceiveCaptureAuthEmail(context.Context, product.InboundEmailHeaders, []byte) (*product.InboundEmailResult, error)
}

// maxInboundEmailWebhook bounds the forwarded delivery: the event carries
// metadata only, never the email body.
const maxInboundEmailWebhook = 64 << 10

func (s *Server) registerCaptureEmailAuth(mux *http.ServeMux) {
	store, ok := s.configuration.(captureEmailAuthStore)
	if !ok {
		return
	}
	authenticated := func(pattern string, handler func(http.ResponseWriter, *http.Request, captureEmailAuthStore)) {
		mux.Handle(pattern, s.authenticateProduct(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler(w, r, store) })))
	}
	authenticated("GET /v1/capture/connections/{id}/email-auth", getCaptureEmailAuth)
	authenticated("POST /v1/capture/connections/{id}/email-auth", createCaptureEmailAuth)
	authenticated("DELETE /v1/capture/connections/{id}/email-auth", revokeCaptureEmailAuth)
	authenticated("PUT /v1/capture/connections/{id}/email-auth/recipe", saveCaptureEmailAuthRecipe)
	authenticated("POST /v1/capture/connections/{id}/email-auth/test", testCaptureEmailAuth)
	authenticated("POST /v1/capture/connections/{id}/email-auth/enable", enableCaptureEmailAuth)
	authenticated("POST /v1/capture/connections/{id}/email-auth/pause", pauseCaptureEmailAuth)
	authenticated("GET /v1/capture/auth-attempts/{id}", getCaptureAuthAttempt)
	authenticated("POST /v1/capture/auth-attempts/{id}/cancel", cancelCaptureAuthAttempt)
	// Resend calls the web facade, which forwards the exact bytes here; this
	// handler verifies Resend's signature itself before reading anything.
	mux.Handle("POST /v1/internal/capture-auth/resend", s.authenticateService(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { receiveCaptureAuthEmail(w, r, store) })))
}

func writeEmailAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, product.ErrInboundSignature):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"code": "invalid_signature", "error": "The webhook signature did not verify."})
	default:
		writeCaptureError(w, err)
	}
}

func getCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	record, err := store.GetCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"emailAuth": record})
}

func createCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	record, err := store.CreateCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"emailAuth": record})
}

func saveCaptureEmailAuthRecipe(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	var input product.SaveCaptureEmailAuthRecipeInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	record, err := store.SaveCaptureEmailAuthRecipe(r.Context(), workspaceActor(r), r.PathValue("id"), input)
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"emailAuth": record})
}

func testCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	attempt, err := store.TestCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"attempt": attempt})
}

func enableCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	var input product.EnableCaptureEmailAuthInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	record, err := store.EnableCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id"), input)
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"emailAuth": record})
}

func pauseCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	record, err := store.PauseCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"emailAuth": record})
}

func revokeCaptureEmailAuth(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	if err := store.RevokeCaptureEmailAuth(r.Context(), workspaceActor(r), r.PathValue("id")); err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func getCaptureAuthAttempt(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	attempt, err := store.GetCaptureAuthAttempt(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"attempt": attempt})
}

func cancelCaptureAuthAttempt(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	if err := store.CancelCaptureAuthAttempt(r.Context(), workspaceActor(r), r.PathValue("id")); err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
}

// receiveCaptureAuthEmail takes Resend's delivery as the web received it. The
// payload string is the exact signed body. Nothing here logs it.
func receiveCaptureAuthEmail(w http.ResponseWriter, r *http.Request, store captureEmailAuthStore) {
	w.Header().Set("Cache-Control", "no-store")
	var input struct {
		Payload   string `json:"payload"`
		ID        string `json:"svixId"`
		Timestamp string `json:"svixTimestamp"`
		Signature string `json:"svixSignature"`
	}
	if decodeJSONLimit(r, &input, 2*maxInboundEmailWebhook) != nil || input.Payload == "" || len(input.Payload) > maxInboundEmailWebhook {
		writeError(w, http.StatusBadRequest, "invalid delivery")
		return
	}
	result, err := store.ReceiveCaptureAuthEmail(r.Context(), product.InboundEmailHeaders{ID: input.ID, Timestamp: input.Timestamp, Signature: input.Signature}, []byte(input.Payload))
	if err != nil {
		writeEmailAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
