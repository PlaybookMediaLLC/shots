package httpapi

import "net/http"

// VoiceStore is the voice notes domain the voice routes serve
// (docs/plans/voice-capture-implementation.md, section 4).
type VoiceStore interface{}

func (s *Server) registerVoice(mux *http.ServeMux) {}
