package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// captureStore is the authenticated capture domain. Handlers adapt transport
// onto it: every rule, role, and tenant check lives in the product package.
type captureStore interface {
	CaptureAvailable() bool
	CreateCaptureConnection(context.Context, product.Actor, product.CreateCaptureConnectionInput) (*product.CaptureConnectionRecord, error)
	ListCaptureConnections(context.Context, product.Actor) ([]product.CaptureConnectionRecord, error)
	StartCaptureConnect(context.Context, product.Actor, string) (*product.CaptureConnectStart, error)
	RefreshCaptureConnect(context.Context, product.Actor, string) (*product.CaptureConnectStart, error)
	FinishCaptureConnect(context.Context, product.Actor, string, string) error
	RevokeCaptureConnection(context.Context, product.Actor, string) error
	CreateCaptureRecipe(context.Context, product.Actor, product.CreateCaptureRecipeInput) (*product.CaptureRecipeRecord, error)
	ListCaptureRecipes(context.Context, product.Actor) ([]product.CaptureRecipeRecord, error)
	ActivateCaptureRecipe(context.Context, product.Actor, string) (*product.CaptureRecipeRecord, error)
	ArchiveCaptureRecipe(context.Context, product.Actor, string) error
	RequestCaptureJob(context.Context, product.Actor, string, product.CaptureJobRequest) (*product.CaptureJobRecord, error)
	ListCaptureJobs(context.Context, product.Actor) ([]product.CaptureJobRecord, error)
	GetCaptureJob(context.Context, product.Actor, string) (*product.CaptureJobRecord, error)
	CancelCaptureJob(context.Context, product.Actor, string) error
}

func (s *Server) registerCapture(mux *http.ServeMux) {
	store, ok := s.configuration.(captureStore)
	if !ok {
		return
	}
	authenticated := func(pattern string, handler func(http.ResponseWriter, *http.Request, captureStore)) {
		mux.Handle(pattern, s.authenticateProduct(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler(w, r, store) })))
	}
	authenticated("GET /v1/capture", captureOverview)
	authenticated("POST /v1/capture/connections", createCaptureConnection)
	authenticated("POST /v1/capture/connections/{id}/connect", startCaptureConnect)
	authenticated("POST /v1/capture/connections/{id}/connect/refresh", refreshCaptureConnect)
	authenticated("POST /v1/capture/connections/{id}/connect/finish", finishCaptureConnect)
	authenticated("POST /v1/capture/connections/{id}/revoke", revokeCaptureConnection)
	authenticated("POST /v1/capture/recipes", createCaptureRecipe)
	authenticated("POST /v1/capture/recipes/{id}/activate", activateCaptureRecipe)
	authenticated("POST /v1/capture/recipes/{id}/archive", archiveCaptureRecipe)
	authenticated("POST /v1/capture/recipes/{id}/jobs", requestCaptureJob)
	authenticated("GET /v1/capture/jobs/{id}", getCaptureJob)
	authenticated("POST /v1/capture/jobs/{id}/cancel", cancelCaptureJob)
}

// writeCaptureError gives a browser failure its safe code, and otherwise
// follows the shared error mapping.
func writeCaptureError(w http.ResponseWriter, err error) {
	var failure *browser.Failure
	switch {
	case errors.As(err, &failure):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": string(failure.Code), "error": "The browser provider could not start this session."})
	case errors.Is(err, product.ErrAuthenticatedCaptureUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "capture_unavailable", "error": err.Error()})
	default:
		writeStoreError(w, err)
	}
}

func captureOverview(w http.ResponseWriter, r *http.Request, store captureStore) {
	actor := workspaceActor(r)
	connections, err := store.ListCaptureConnections(r.Context(), actor)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	recipes, err := store.ListCaptureRecipes(r.Context(), actor)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	jobs, err := store.ListCaptureJobs(r.Context(), actor)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"available": store.CaptureAvailable(), "connections": connections, "recipes": recipes, "jobs": jobs})
}

func createCaptureConnection(w http.ResponseWriter, r *http.Request, store captureStore) {
	var input product.CreateCaptureConnectionInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	connection, err := store.CreateCaptureConnection(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"connection": connection})
}

// startCaptureConnect returns a Live View link once. It is a bearer credential,
// so nothing may cache it, and nothing beyond this response may carry it.
func startCaptureConnect(w http.ResponseWriter, r *http.Request, store captureStore) {
	start, err := store.StartCaptureConnect(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	writeJSON(w, http.StatusOK, start)
}

func finishCaptureConnect(w http.ResponseWriter, r *http.Request, store captureStore) {
	var input struct {
		IntentID string `json:"intentId"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := store.FinishCaptureConnect(r.Context(), workspaceActor(r), r.PathValue("id"), input.IntentID); err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"accepted": true})
}

func refreshCaptureConnect(w http.ResponseWriter, r *http.Request, store captureStore) {
	start, err := store.RefreshCaptureConnect(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	writeJSON(w, http.StatusOK, start)
}

func revokeCaptureConnection(w http.ResponseWriter, r *http.Request, store captureStore) {
	if err := store.RevokeCaptureConnection(r.Context(), workspaceActor(r), r.PathValue("id")); err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

func createCaptureRecipe(w http.ResponseWriter, r *http.Request, store captureStore) {
	var input product.CreateCaptureRecipeInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	recipe, err := store.CreateCaptureRecipe(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"recipe": recipe})
}

func activateCaptureRecipe(w http.ResponseWriter, r *http.Request, store captureStore) {
	recipe, err := store.ActivateCaptureRecipe(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recipe": recipe})
}

func archiveCaptureRecipe(w http.ResponseWriter, r *http.Request, store captureStore) {
	if err := store.ArchiveCaptureRecipe(r.Context(), workspaceActor(r), r.PathValue("id")); err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"archived": true})
}

func requestCaptureJob(w http.ResponseWriter, r *http.Request, store captureStore) {
	var input product.CaptureJobRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	job, err := store.RequestCaptureJob(r.Context(), workspaceActor(r), r.PathValue("id"), input)
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"job": job})
}

func getCaptureJob(w http.ResponseWriter, r *http.Request, store captureStore) {
	job, err := store.GetCaptureJob(r.Context(), workspaceActor(r), r.PathValue("id"))
	if err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": job})
}

func cancelCaptureJob(w http.ResponseWriter, r *http.Request, store captureStore) {
	if err := store.CancelCaptureJob(r.Context(), workspaceActor(r), r.PathValue("id")); err != nil {
		writeCaptureError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"cancelled": true})
}
