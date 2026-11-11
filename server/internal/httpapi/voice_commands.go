package httpapi

import "net/http"

// VoiceCommandStore is the voice-to-draft and voice-command domain
// (docs/plans/voice-capture-implementation.md, section 4).
type VoiceCommandStore interface{}

func (s *Server) registerVoiceCommands(mux *http.ServeMux) {}
