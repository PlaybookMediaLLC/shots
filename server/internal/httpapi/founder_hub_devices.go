package httpapi

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"net/http"
)

func (s *Server) listFounderHubDevices(w http.ResponseWriter, r *http.Request) {
	items, err := s.configuration.ListFounderHubDevices(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, items, err)
}
func (s *Server) reportFounderHubDevice(w http.ResponseWriter, r *http.Request) {
	var input product.FounderHubDeviceReportInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid device report")
		return
	}
	items, err := s.configuration.ReportFounderHubDevice(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, items, err)
}
func (s *Server) createFounderHubDeviceCommand(w http.ResponseWriter, r *http.Request) {
	var input founderhub.DeviceCommandInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid device command")
		return
	}
	item, err := s.configuration.CreateFounderHubDeviceCommand(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusCreated, item, err)
}
func (s *Server) getFounderHubDeviceCommand(w http.ResponseWriter, r *http.Request) {
	item, err := s.configuration.GetFounderHubDeviceCommand(r.Context(), workspaceActor(r), r.PathValue("id"))
	respond(w, http.StatusOK, item, err)
}
func (s *Server) finishFounderHubDeviceCommand(w http.ResponseWriter, r *http.Request) {
	var input product.FounderHubDeviceCommandResult
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid command result")
		return
	}
	item, err := s.configuration.FinishFounderHubDeviceCommand(r.Context(), workspaceActor(r), r.PathValue("id"), input)
	respond(w, http.StatusOK, item, err)
}
