package httpapi

import (
	"context"
	"errors"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// ProjectStore keeps a workspace's cloud projects and their version history.
type ProjectStore interface {
	CreateProject(context.Context, product.Actor, string, map[string]any) (*product.ProjectRecord, error)
	GetProject(context.Context, product.Actor, string) (*product.ProjectRecord, error)
	ListProjects(context.Context, product.Actor, product.ProjectListQuery) (*product.ProjectPage, error)
	ListRecentWork(context.Context, product.Actor, int) (*product.RecentWorkPage, error)
	RenameProject(context.Context, product.Actor, string, string) (*product.ProjectRecord, error)
	UpdateProjectDocument(context.Context, product.Actor, string, product.ProjectDocumentWrite) (*product.ProjectWriteResult, error)
	DuplicateProject(context.Context, product.Actor, string, *string) (*product.ProjectRecord, error)
	DeleteProject(context.Context, product.Actor, string) error
	ListProjectVersions(context.Context, product.Actor, string) ([]product.ProjectVersionRecord, error)
	GetProjectVersion(context.Context, product.Actor, string, string) (*product.ProjectVersionRecord, error)
	CreateProjectVersion(context.Context, product.Actor, string, string) (*product.ProjectVersionRecord, error)
	RestoreProjectVersion(context.Context, product.Actor, string, string, int) (*product.ProjectRecord, error)
}

func (s *Server) registerProjects(mux *http.ServeMux) {
	mux.Handle("GET /v1/recent-work", s.authenticateProduct(http.HandlerFunc(s.listRecentWork)))
	mux.Handle("GET /v1/projects", s.authenticateProduct(http.HandlerFunc(s.listProjects)))
	mux.Handle("POST /v1/projects", s.authenticateProduct(http.HandlerFunc(s.createProject)))
	mux.Handle("GET /v1/projects/{id}", s.authenticateProduct(http.HandlerFunc(s.getProject)))
	mux.Handle("PATCH /v1/projects/{id}", s.authenticateProduct(http.HandlerFunc(s.renameProject)))
	mux.Handle("DELETE /v1/projects/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteProject)))
	mux.Handle("PUT /v1/projects/{id}/document", s.authenticateProduct(http.HandlerFunc(s.updateProjectDocument)))
	mux.Handle("POST /v1/projects/{id}/duplicate", s.authenticateProduct(http.HandlerFunc(s.duplicateProject)))
	mux.Handle("GET /v1/projects/{id}/versions", s.authenticateProduct(http.HandlerFunc(s.listProjectVersions)))
	mux.Handle("POST /v1/projects/{id}/versions", s.authenticateProduct(http.HandlerFunc(s.createProjectVersion)))
	mux.Handle("GET /v1/projects/{id}/versions/{versionId}", s.authenticateProduct(http.HandlerFunc(s.getProjectVersion)))
	mux.Handle("POST /v1/projects/{id}/versions/{versionId}/restore", s.authenticateProduct(http.HandlerFunc(s.restoreProjectVersion)))
}

// projectPathID reads a path ID, answering 400 when it is malformed.
func projectPathID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := r.PathValue(name)
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid project ID")
		return "", false
	}
	return id, true
}

// writeProjectError answers a stale write with the revision the project is at,
// so the client can load it instead of overwriting newer work.
func writeProjectError(w http.ResponseWriter, err error) {
	var stale *product.ProjectRevisionConflictError
	if errors.As(err, &stale) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "project_revision_conflict", "currentRevision": stale.Current, "error": err.Error(),
		})
		return
	}
	writeStoreError(w, err)
}

func (s *Server) listRecentWork(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryLimit(r, 5, 20)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid recent-work limit")
		return
	}
	page, err := s.configuration.ListRecentWork(r.Context(), workspaceActor(r), limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryLimit(r, 24, 100)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid project limit")
		return
	}
	query := r.URL.Query()
	page, err := s.configuration.ListProjects(r.Context(), workspaceActor(r), product.ProjectListQuery{
		Cursor: query.Get("cursor"), Limit: limit, Search: query.Get("search"), Sort: query.Get("sort"),
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Document map[string]any `json:"document"`
		Name     string         `json:"name"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid project request")
		return
	}
	item, err := s.configuration.CreateProject(r.Context(), workspaceActor(r), input.Name, input.Document)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getProject(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	item, err := s.configuration.GetProject(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) renameProject(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid project name")
		return
	}
	item, err := s.configuration.RenameProject(r.Context(), workspaceActor(r), id, input.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteProject(r.Context(), workspaceActor(r), id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) updateProjectDocument(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	var input product.ProjectDocumentWrite
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid project document")
		return
	}
	result, err := s.configuration.UpdateProjectDocument(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) duplicateProject(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
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
	item, err := s.configuration.DuplicateProject(r.Context(), workspaceActor(r), id, input.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) listProjectVersions(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	items, err := s.configuration.ListProjectVersions(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": items})
}

func (s *Server) createProjectVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid version name")
		return
	}
	item, err := s.configuration.CreateProjectVersion(r.Context(), workspaceActor(r), id, input.Name)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getProjectVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	versionID, ok := projectPathID(w, r, "versionId")
	if !ok {
		return
	}
	item, err := s.configuration.GetProjectVersion(r.Context(), workspaceActor(r), id, versionID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) restoreProjectVersion(w http.ResponseWriter, r *http.Request) {
	id, ok := projectPathID(w, r, "id")
	if !ok {
		return
	}
	versionID, ok := projectPathID(w, r, "versionId")
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
	item, err := s.configuration.RestoreProjectVersion(r.Context(), workspaceActor(r), id, versionID, input.BaseRevision)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}
