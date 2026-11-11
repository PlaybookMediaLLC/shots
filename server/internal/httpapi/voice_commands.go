package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

// VoiceCommandStore is the voice-to-draft and voice-command domain
// (docs/plans/voice-capture-implementation.md, section 4, rows 16 and 17).
// Both routes are session-only; the domain refuses any other credential.
type VoiceCommandStore interface {
	CreateVoiceDraft(context.Context, product.Actor, string, product.VoiceDraftInput) (*product.VoiceDraftResult, error)
	ConfirmVoiceCommand(context.Context, product.Actor, string, product.VoiceCommandConfirmInput) (*product.VoiceCommandConfirmation, error)
}

func (s *Server) registerVoiceCommands(mux *http.ServeMux) {
	mux.Handle("POST /v1/voice/notes/{id}/draft", s.authenticateProduct(http.HandlerFunc(s.createVoiceDraft)))
	mux.Handle("POST /v1/voice/notes/{id}/command/confirm", s.authenticateProduct(http.HandlerFunc(s.confirmVoiceCommand)))
}

func (s *Server) createVoiceDraft(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.VoiceDraftInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice draft")
		return
	}
	result, err := s.configuration.CreateVoiceDraft(r.Context(), workspaceActor(r), ids[0], input)
	if errors.Is(err, product.ErrVoiceDraftFailed) {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

// confirmVoiceCommand schedules a confirmed proposal, then wakes its post's
// workflow. A post whose workflow can't be woken is still scheduled: the
// once-a-minute dispatcher starts it, and a resent confirm returns the same
// outcome.
func (s *Server) confirmVoiceCommand(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.VoiceCommandConfirmInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice command confirmation")
		return
	}
	result, err := s.configuration.ConfirmVoiceCommand(r.Context(), workspaceActor(r), ids[0], input)
	if err != nil {
		writeContentDraftError(w, err)
		return
	}
	for _, post := range result.Scheduled {
		if err := s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{
			OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor,
		}); err != nil {
			slog.WarnContext(r.Context(), "scheduled post workflow was not woken", "post", post.ID, "error", err)
		}
	}
	writeJSON(w, http.StatusOK, result)
}
