package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// CreativeSetStore keeps a workspace's cloud creativeSets and their version history.
type CreativeSetStore interface {
	DeleteCanvas(context.Context, product.Actor, string) error
	DeleteStoreProject(context.Context, product.Actor, string) error
	IssueCreativeSetCollabToken(context.Context, product.Actor, string) (*product.CollabToken, error)
	AttachCreativeSetDelivery(context.Context, product.Actor, string, product.CreativeSetHandoffInput) (*product.CreativeSetHandoffResult, error)
	CreateCreativeSet(context.Context, product.Actor, string, string, map[string]any) (*product.CreativeSetRecord, error)
	GetCreativeSet(context.Context, product.Actor, string) (*product.CreativeSetRecord, error)
	ListCreativeSets(context.Context, product.Actor, product.CreativeSetListQuery) (*product.CreativeSetPage, error)
	RenameCreativeSet(context.Context, product.Actor, string, string) (*product.CreativeSetRecord, error)
	UpdateCreativeSetDocument(context.Context, product.Actor, string, product.CreativeSetDocumentWrite) (*product.CreativeSetWriteResult, error)
	DuplicateCreativeSet(context.Context, product.Actor, string, *string) (*product.CreativeSetRecord, error)
	ArchiveCreativeSet(context.Context, product.Actor, string, ...bool) error
	ListCreativeSetVersions(context.Context, product.Actor, string) ([]product.CreativeSetVersionRecord, error)
	GetCreativeSetVersion(context.Context, product.Actor, string, string) (*product.CreativeSetVersionRecord, error)
	CreateCreativeSetVersion(context.Context, product.Actor, string, string, ...int) (*product.CreativeSetVersionRecord, error)
	RestoreCreativeSetVersion(context.Context, product.Actor, string, string, int) (*product.CreativeSetRecord, error)
}

func (s *Server) registerCreativeSets(mux *http.ServeMux) {
	mux.Handle("DELETE /v1/canvases/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteCanvas)))
	mux.Handle("DELETE /v1/store-projects/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteStoreProject)))
	mux.Handle("POST /v1/creative-sets/{id}/collab-token", s.authenticateProduct(http.HandlerFunc(s.issueCreativeSetCollabToken)))
	mux.Handle("POST /v1/creative-sets/{id}/campaign", s.authenticateProduct(http.HandlerFunc(s.attachCreativeSetDelivery)))
	mux.Handle("GET /v1/creative-sets", s.authenticateProduct(http.HandlerFunc(s.listCreativeSets)))
	mux.Handle("POST /v1/creative-sets", s.authenticateProduct(http.HandlerFunc(s.createCreativeSet)))
	mux.Handle("GET /v1/creative-sets/{id}", s.authenticateProduct(http.HandlerFunc(s.getCreativeSet)))
	mux.Handle("PATCH /v1/creative-sets/{id}", s.authenticateProduct(http.HandlerFunc(s.renameCreativeSet)))
	mux.Handle("POST /v1/creative-sets/{id}/archive", s.authenticateProduct(http.HandlerFunc(s.archiveCreativeSet)))
	mux.Handle("PUT /v1/creative-sets/{id}/document", s.authenticateProduct(http.HandlerFunc(s.updateCreativeSetDocument)))
	mux.Handle("POST /v1/creative-sets/{id}/duplicate", s.authenticateProduct(http.HandlerFunc(s.duplicateCreativeSet)))
	mux.Handle("GET /v1/creative-sets/{id}/versions", s.authenticateProduct(http.HandlerFunc(s.listCreativeSetVersions)))
	mux.Handle("POST /v1/creative-sets/{id}/versions", s.authenticateProduct(http.HandlerFunc(s.createCreativeSetVersion)))
	mux.Handle("GET /v1/creative-sets/{id}/versions/{versionId}", s.authenticateProduct(http.HandlerFunc(s.getCreativeSetVersion)))
	mux.Handle("POST /v1/creative-sets/{id}/versions/{versionId}/restore", s.authenticateProduct(http.HandlerFunc(s.restoreCreativeSetVersion)))
}

func (s *Server) attachCreativeSetDelivery(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	var input product.CreativeSetHandoffInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid delivery request")
		return
	}
	result, err := s.configuration.AttachCreativeSetDelivery(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeCreativeSetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// creativeSetPathID reads a path ID, answering 400 when it is malformed.
func creativeSetPathID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := r.PathValue(name)
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid creativeSet ID")
		return "", false
	}
	return id, true
}

// writeCreativeSetError answers a stale write with the revision the creativeSet is at,
// so the client can load it instead of overwriting newer work.
func writeCreativeSetError(w http.ResponseWriter, err error) {
	var stale *product.CreativeSetRevisionConflictError
	if errors.As(err, &stale) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "creativeSet_revision_conflict", "currentRevision": stale.Current, "error": err.Error(),
		})
		return
	}
	writeStoreError(w, err)
}

func (s *Server) listCreativeSets(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryLimit(r, 24, 100)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid creativeSet limit")
		return
	}
	query := r.URL.Query()
	if value := query.Get("archived"); value != "" && value != "true" && value != "false" {
		writeError(w, http.StatusBadRequest, "invalid archived filter")
		return
	}
	page, err := s.configuration.ListCreativeSets(r.Context(), workspaceActor(r), product.CreativeSetListQuery{
		Archived: query.Get("archived") == "true",
		Cursor:   query.Get("cursor"), Kind: query.Get("kind"), Limit: limit, Search: query.Get("search"), Sort: query.Get("sort"),
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) createCreativeSet(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ID       string         `json:"id"`
		Document map[string]any `json:"document"`
		Name     string         `json:"name"`
	}
	if err := decodeJSONLimit(r, &input, 8<<20); err != nil || !resourceIDPattern.MatchString(input.ID) {
		writeError(w, http.StatusBadRequest, "invalid creativeSet request")
		return
	}
	item, err := s.configuration.CreateCreativeSet(r.Context(), workspaceActor(r), input.ID, input.Name, input.Document)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getCreativeSet(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	item, err := s.configuration.GetCreativeSet(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) renameCreativeSet(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid creativeSet name")
		return
	}
	item, err := s.configuration.RenameCreativeSet(r.Context(), workspaceActor(r), id, input.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) archiveCreativeSet(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	value := r.URL.Query().Get("archived")
	if value != "" && value != "true" && value != "false" {
		writeError(w, http.StatusBadRequest, "invalid archived state")
		return
	}
	archived := value != "false"
	if err := s.configuration.ArchiveCreativeSet(r.Context(), workspaceActor(r), id, archived); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"archived": archived})
}

func (s *Server) updateCreativeSetDocument(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	var input product.CreativeSetDocumentWrite
	if err := decodeJSONLimit(r, &input, 8<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid creativeSet document")
		return
	}
	result, err := s.configuration.UpdateCreativeSetDocument(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeCreativeSetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) duplicateCreativeSet(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name *string `json:"name"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid duplicate request")
		return
	}
	item, err := s.configuration.DuplicateCreativeSet(r.Context(), workspaceActor(r), id, input.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) listCreativeSetVersions(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	items, err := s.configuration.ListCreativeSetVersions(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": items})
}

func (s *Server) createCreativeSetVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name         string `json:"name"`
		BaseRevision int    `json:"baseRevision"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid version name")
		return
	}
	item, err := s.configuration.CreateCreativeSetVersion(r.Context(), workspaceActor(r), id, input.Name, input.BaseRevision)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getCreativeSetVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	versionID, ok := creativeSetPathID(w, r, "versionId")
	if !ok {
		return
	}
	item, err := s.configuration.GetCreativeSetVersion(r.Context(), workspaceActor(r), id, versionID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) restoreCreativeSetVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	versionID, ok := creativeSetPathID(w, r, "versionId")
	if !ok {
		return
	}
	var input struct {
		BaseRevision int `json:"baseRevision"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid restore request")
		return
	}
	item, err := s.configuration.RestoreCreativeSetVersion(r.Context(), workspaceActor(r), id, versionID, input.BaseRevision)
	if err != nil {
		writeCreativeSetError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) issueCreativeSetCollabToken(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	token, err := s.configuration.IssueCreativeSetCollabToken(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeCollabError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, token)
}

func (s *Server) deleteCanvas(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteCanvas(r.Context(), workspaceActor(r), id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) deleteStoreProject(w http.ResponseWriter, r *http.Request) {
	id, ok := creativeSetPathID(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteStoreProject(r.Context(), workspaceActor(r), id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}
