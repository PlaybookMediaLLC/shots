package httpapi

import (
	"context"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// ContentBatchStore is bulk scheduling (RFC 042): durable batches of separate
// posts, each scheduled through its own draft.
type ContentBatchStore interface {
	CreateContentBatch(context.Context, product.Actor, product.ContentBatchInput) (*product.ContentBatchRecord, error)
	ListContentBatches(context.Context, product.Actor) ([]product.ContentBatchRecord, error)
	GetContentBatch(context.Context, product.Actor, string) (*product.ContentBatchRecord, error)
	ArchiveContentBatch(context.Context, product.Actor, string) error
	AddContentBatchItems(context.Context, product.Actor, string, []product.ContentBatchItemInput) (*product.ContentBatchRecord, error)
	UpdateContentBatchItem(context.Context, product.Actor, string, string, product.ContentBatchItemUpdate) (*product.ContentBatchItemRecord, error)
	UpdateContentBatchItems(context.Context, product.Actor, string, []product.ContentBatchItemPatch) (*product.ContentBatchRecord, error)
	RemoveContentBatchItem(context.Context, product.Actor, string, string) error
	CreateContentBatchItemDraft(context.Context, product.Actor, string, string, product.ContentDraftInput) (*product.ContentBatchItemRecord, error)
	ValidateContentBatch(context.Context, product.Actor, string, []product.BatchValidationRow) ([]product.BatchValidationResult, error)
}

func (s *Server) registerContentBatches(mux *http.ServeMux) {
	mux.Handle("GET /v1/content-batches", s.authenticateProduct(http.HandlerFunc(s.listContentBatches)))
	mux.Handle("POST /v1/content-batches", s.authenticateProduct(http.HandlerFunc(s.createContentBatch)))
	mux.Handle("GET /v1/content-batches/{id}", s.authenticateProduct(http.HandlerFunc(s.getContentBatch)))
	mux.Handle("POST /v1/content-batches/{id}/archive", s.authenticateProduct(http.HandlerFunc(s.archiveContentBatch)))
	mux.Handle("POST /v1/content-batches/{id}/items", s.authenticateProduct(http.HandlerFunc(s.addContentBatchItems)))
	mux.Handle("PATCH /v1/content-batches/{id}/items", s.authenticateProduct(http.HandlerFunc(s.updateContentBatchItems)))
	mux.Handle("PATCH /v1/content-batches/{id}/items/{itemId}", s.authenticateProduct(http.HandlerFunc(s.updateContentBatchItem)))
	mux.Handle("DELETE /v1/content-batches/{id}/items/{itemId}", s.authenticateProduct(http.HandlerFunc(s.removeContentBatchItem)))
	mux.Handle("POST /v1/content-batches/{id}/items/{itemId}/draft", s.authenticateProduct(http.HandlerFunc(s.createContentBatchItemDraft)))
	mux.Handle("POST /v1/content-batches/{id}/validate", s.authenticateProduct(http.HandlerFunc(s.validateContentBatch)))
}

func batchIDs(w http.ResponseWriter, r *http.Request, item bool) (string, string, bool) {
	id, itemID := r.PathValue("id"), r.PathValue("itemId")
	if !resourceIDPattern.MatchString(id) || item && !resourceIDPattern.MatchString(itemID) {
		writeError(w, http.StatusBadRequest, "invalid batch ID")
		return "", "", false
	}
	return id, itemID, true
}

func (s *Server) listContentBatches(w http.ResponseWriter, r *http.Request) {
	batches, err := s.configuration.ListContentBatches(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"batches": batches})
}

func (s *Server) createContentBatch(w http.ResponseWriter, r *http.Request) {
	var input product.ContentBatchInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid batch")
		return
	}
	batch, err := s.configuration.CreateContentBatch(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, batch)
}

func (s *Server) getContentBatch(w http.ResponseWriter, r *http.Request) {
	id, _, ok := batchIDs(w, r, false)
	if !ok {
		return
	}
	batch, err := s.configuration.GetContentBatch(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func (s *Server) archiveContentBatch(w http.ResponseWriter, r *http.Request) {
	id, _, ok := batchIDs(w, r, false)
	if !ok {
		return
	}
	if err := s.configuration.ArchiveContentBatch(r.Context(), workspaceActor(r), id); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) addContentBatchItems(w http.ResponseWriter, r *http.Request) {
	id, _, ok := batchIDs(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Items []product.ContentBatchItemInput `json:"items"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid batch items")
		return
	}
	batch, err := s.configuration.AddContentBatchItems(r.Context(), workspaceActor(r), id, input.Items)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func (s *Server) updateContentBatchItem(w http.ResponseWriter, r *http.Request) {
	id, itemID, ok := batchIDs(w, r, true)
	if !ok {
		return
	}
	var input product.ContentBatchItemUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid batch item")
		return
	}
	item, err := s.configuration.UpdateContentBatchItem(r.Context(), workspaceActor(r), id, itemID, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) updateContentBatchItems(w http.ResponseWriter, r *http.Request) {
	id, _, ok := batchIDs(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Items []product.ContentBatchItemPatch `json:"items"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid batch items")
		return
	}
	batch, err := s.configuration.UpdateContentBatchItems(r.Context(), workspaceActor(r), id, input.Items)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, batch)
}

func (s *Server) removeContentBatchItem(w http.ResponseWriter, r *http.Request) {
	id, itemID, ok := batchIDs(w, r, true)
	if !ok {
		return
	}
	if err := s.configuration.RemoveContentBatchItem(r.Context(), workspaceActor(r), id, itemID); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createContentBatchItemDraft(w http.ResponseWriter, r *http.Request) {
	id, itemID, ok := batchIDs(w, r, true)
	if !ok {
		return
	}
	var input product.ContentDraftInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid content draft")
		return
	}
	item, err := s.configuration.CreateContentBatchItemDraft(r.Context(), workspaceActor(r), id, itemID, input)
	if err != nil {
		writeContentDraftError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) validateContentBatch(w http.ResponseWriter, r *http.Request) {
	id, _, ok := batchIDs(w, r, false)
	if !ok {
		return
	}
	var input struct {
		Items []product.BatchValidationRow `json:"items"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid batch validation")
		return
	}
	results, err := s.configuration.ValidateContentBatch(r.Context(), workspaceActor(r), id, input.Items)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
