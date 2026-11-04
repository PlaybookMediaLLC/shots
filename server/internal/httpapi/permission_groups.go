package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// registerPermissionGroups exposes permission groups. Changes are rechecked as
// sensitive sessions in the product layer.
func (s *Server) registerPermissionGroups(mux *http.ServeMux) {
	mux.Handle("GET /v1/permission-groups", s.authenticateProduct(http.HandlerFunc(s.listPermissionGroups)))
	mux.Handle("POST /v1/permission-groups", s.authenticateProduct(http.HandlerFunc(s.createPermissionGroup)))
	mux.Handle("PUT /v1/permission-groups/{id}", s.authenticateProduct(http.HandlerFunc(s.updatePermissionGroup)))
	mux.Handle("DELETE /v1/permission-groups/{id}", s.authenticateProduct(http.HandlerFunc(s.deletePermissionGroup)))
	mux.Handle("PUT /v1/permission-groups/{id}/members", s.authenticateProduct(http.HandlerFunc(s.setPermissionGroupMembers)))
}

func (s *Server) listPermissionGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.configuration.ListPermissionGroups(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (s *Server) createPermissionGroup(w http.ResponseWriter, r *http.Request) {
	var input product.PermissionGroupInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	group, err := s.configuration.CreatePermissionGroup(r.Context(), workspaceActor(r), input, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, group)
}

// permissionGroupID reads a well-formed group id, or answers 404.
func permissionGroupID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, "permission group not found")
		return "", false
	}
	return id, true
}

func (s *Server) updatePermissionGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := permissionGroupID(w, r)
	if !ok {
		return
	}
	var input product.PermissionGroupInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	group, err := s.configuration.UpdatePermissionGroup(r.Context(), workspaceActor(r), id, input, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, group)
}

func (s *Server) deletePermissionGroup(w http.ResponseWriter, r *http.Request) {
	id, ok := permissionGroupID(w, r)
	if !ok {
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	if err := s.configuration.DeletePermissionGroup(r.Context(), workspaceActor(r), id, audit); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) setPermissionGroupMembers(w http.ResponseWriter, r *http.Request) {
	id, ok := permissionGroupID(w, r)
	if !ok {
		return
	}
	var input struct {
		MemberIDs []string `json:"memberIds"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	audit, ok := auditRequest(w, r)
	if !ok {
		return
	}
	group, err := s.configuration.SetPermissionGroupMembers(r.Context(), workspaceActor(r), id, input.MemberIDs, audit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, group)
}
