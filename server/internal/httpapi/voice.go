package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// VoiceStore is the voice notes domain the voice routes serve
// (docs/plans/voice-capture-implementation.md, section 4). Every operation is
// for the signed-in member's own notes; the domain refuses an API key.
type VoiceStore interface {
	GetVoiceSettings(context.Context, product.Actor) (*product.VoiceSettings, error)
	UpdateVoiceWorkspaceSettings(context.Context, product.Actor, product.VoiceWorkspaceFlagsInput) (*product.VoiceSettings, error)
	UpdateVoiceMemberSettings(context.Context, product.Actor, product.VoiceMemberSettingsInput) (*product.VoiceSettings, error)
	ListVoiceNoteIndex(context.Context, product.Actor) ([]product.VoiceNoteIndexEntry, error)
	ListVoiceNotes(context.Context, product.Actor, product.VoiceNoteListQuery) (*product.VoiceNotePage, error)
	CreateVoiceNote(context.Context, product.Actor, product.CreateVoiceNoteInput) (*product.VoiceNoteDetail, bool, error)
	GetVoiceNote(context.Context, product.Actor, string) (*product.VoiceNoteDetail, error)
	UpdateVoiceNote(context.Context, product.Actor, string, product.UpdateVoiceNoteInput) (*product.VoiceNoteDetail, error)
	DeleteVoiceNote(context.Context, product.Actor, string) error
	AddVoiceTranscript(context.Context, product.Actor, string, product.AddVoiceTranscriptInput) (*product.VoiceTranscriptResult, bool, error)
	RedactVoiceTranscript(context.Context, product.Actor, string, string) (*product.VoiceTranscriptRevision, error)
	SignVoiceRunUpload(context.Context, product.Actor, string, int, product.VoiceRunUploadInput) (*product.VoiceRunUpload, error)
	CompleteVoiceRun(context.Context, product.Actor, string, int) (*product.VoiceAudioRun, error)
	SignVoiceRunAudio(context.Context, product.Actor, string, int) (*product.VoiceRunAudio, error)
	DeleteVoiceAudio(context.Context, product.Actor, string) error
}

func (s *Server) registerVoice(mux *http.ServeMux) {
	handle := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, s.authenticateProduct(handler))
	}
	handle("GET /v1/voice/settings", s.getVoiceSettings)
	handle("PUT /v1/voice/settings/workspace", s.updateVoiceWorkspaceSettings)
	handle("PUT /v1/voice/settings/member", s.updateVoiceMemberSettings)
	handle("GET /v1/voice/notes/index", s.voiceNoteIndex)
	handle("GET /v1/voice/notes", s.listVoiceNotes)
	handle("POST /v1/voice/notes", s.createVoiceNote)
	handle("GET /v1/voice/notes/{id}", s.getVoiceNote)
	handle("PATCH /v1/voice/notes/{id}", s.updateVoiceNote)
	handle("DELETE /v1/voice/notes/{id}", s.deleteVoiceNote)
	handle("POST /v1/voice/notes/{id}/transcripts", s.addVoiceTranscript)
	handle("POST /v1/voice/notes/{id}/transcripts/{revisionId}/redact", s.redactVoiceTranscript)
	handle("POST /v1/voice/notes/{id}/runs/{runIndex}/upload", s.signVoiceRunUpload)
	handle("POST /v1/voice/notes/{id}/runs/{runIndex}/complete", s.completeVoiceRun)
	handle("GET /v1/voice/notes/{id}/runs/{runIndex}/audio", s.voiceRunAudio)
	handle("DELETE /v1/voice/notes/{id}/audio", s.deleteVoiceAudio)
}

// created answers 201 for a new record and 200 for an idempotent replay.
func created(isNew bool) int {
	if isNew {
		return http.StatusCreated
	}
	return http.StatusOK
}

// voiceRun reads the note id and run index from the path.
func voiceRun(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return "", 0, false
	}
	runIndex, err := strconv.Atoi(r.PathValue("runIndex"))
	if err != nil || runIndex < 0 {
		writeError(w, http.StatusBadRequest, "invalid runIndex")
		return "", 0, false
	}
	return ids[0], runIndex, true
}

func (s *Server) getVoiceSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.configuration.GetVoiceSettings(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, settings, err)
}

func (s *Server) updateVoiceWorkspaceSettings(w http.ResponseWriter, r *http.Request) {
	var input product.VoiceWorkspaceFlagsInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice settings")
		return
	}
	settings, err := s.configuration.UpdateVoiceWorkspaceSettings(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, settings, err)
}

func (s *Server) updateVoiceMemberSettings(w http.ResponseWriter, r *http.Request) {
	var input product.VoiceMemberSettingsInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice settings")
		return
	}
	settings, err := s.configuration.UpdateVoiceMemberSettings(r.Context(), workspaceActor(r), input)
	respond(w, http.StatusOK, settings, err)
}

func (s *Server) voiceNoteIndex(w http.ResponseWriter, r *http.Request) {
	notes, err := s.configuration.ListVoiceNoteIndex(r.Context(), workspaceActor(r))
	respond(w, http.StatusOK, map[string]any{"notes": notes}, err)
}

func (s *Server) listVoiceNotes(w http.ResponseWriter, r *http.Request) {
	query := product.VoiceNoteListQuery{Cursor: r.URL.Query().Get("cursor")}
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid page size")
			return
		}
		query.Limit = limit
	}
	page, err := s.configuration.ListVoiceNotes(r.Context(), workspaceActor(r), query)
	respond(w, http.StatusOK, page, err)
}

func (s *Server) createVoiceNote(w http.ResponseWriter, r *http.Request) {
	var input product.CreateVoiceNoteInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice note")
		return
	}
	note, isNew, err := s.configuration.CreateVoiceNote(r.Context(), workspaceActor(r), input)
	respond(w, created(isNew), note, err)
}

func (s *Server) getVoiceNote(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	note, err := s.configuration.GetVoiceNote(r.Context(), workspaceActor(r), ids[0])
	respond(w, http.StatusOK, note, err)
}

func (s *Server) updateVoiceNote(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.UpdateVoiceNoteInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid voice note")
		return
	}
	note, err := s.configuration.UpdateVoiceNote(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, http.StatusOK, note, err)
}

func (s *Server) deleteVoiceNote(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteVoiceNote(r.Context(), workspaceActor(r), ids[0]); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) addVoiceTranscript(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.AddVoiceTranscriptInput
	// A 100,000-character transcript and its segments exceed the default 1 MB.
	if err := decodeJSONLimit(r, &input, 4<<20); err != nil {
		writeError(w, http.StatusBadRequest, "invalid transcript")
		return
	}
	result, isNew, err := s.configuration.AddVoiceTranscript(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, created(isNew), result, err)
}

func (s *Server) redactVoiceTranscript(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "revisionId")
	if !ok {
		return
	}
	revision, err := s.configuration.RedactVoiceTranscript(r.Context(), workspaceActor(r), ids[0], ids[1])
	respond(w, http.StatusOK, revision, err)
}

func (s *Server) signVoiceRunUpload(w http.ResponseWriter, r *http.Request) {
	noteID, runIndex, ok := voiceRun(w, r)
	if !ok {
		return
	}
	var input product.VoiceRunUploadInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid upload")
		return
	}
	upload, err := s.configuration.SignVoiceRunUpload(r.Context(), workspaceActor(r), noteID, runIndex, input)
	w.Header().Set("Cache-Control", "private, no-store")
	respond(w, http.StatusOK, upload, err)
}

// voiceCompleteWriteTimeout outlasts the server's 30-second write timeout:
// complete reads back and decodes a run of up to 200 MB in the request.
const voiceCompleteWriteTimeout = 5 * time.Minute

func (s *Server) completeVoiceRun(w http.ResponseWriter, r *http.Request) {
	noteID, runIndex, ok := voiceRun(w, r)
	if !ok {
		return
	}
	// The telemetry wrappers unwrap to the connection (TestVoiceCompleteOutlastsTheWriteTimeout).
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(voiceCompleteWriteTimeout)); err != nil {
		slog.WarnContext(r.Context(), "voice run check keeps the server's write deadline", "error", err)
	}
	run, err := s.configuration.CompleteVoiceRun(r.Context(), workspaceActor(r), noteID, runIndex)
	respond(w, http.StatusOK, run, err)
}

func (s *Server) voiceRunAudio(w http.ResponseWriter, r *http.Request) {
	noteID, runIndex, ok := voiceRun(w, r)
	if !ok {
		return
	}
	audio, err := s.configuration.SignVoiceRunAudio(r.Context(), workspaceActor(r), noteID, runIndex)
	w.Header().Set("Cache-Control", "private, no-store")
	respond(w, http.StatusOK, audio, err)
}

func (s *Server) deleteVoiceAudio(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	if err := s.configuration.DeleteVoiceAudio(r.Context(), workspaceActor(r), ids[0]); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
