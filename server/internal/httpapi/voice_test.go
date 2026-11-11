package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// voiceFake records which voice operation a route reached and with what.
type voiceFake struct {
	fakeConfiguration
	err      error
	isNew    bool
	call     string
	noteID   string
	second   string
	runIndex int
	query    product.VoiceNoteListQuery
	patch    product.UpdateVoiceNoteInput
}

func (f *voiceFake) record(call string, ids ...string) {
	f.call = call
	if len(ids) > 0 {
		f.noteID = ids[0]
	}
	if len(ids) > 1 {
		f.second = ids[1]
	}
}

func (f *voiceFake) GetVoiceSettings(context.Context, product.Actor) (*product.VoiceSettings, error) {
	f.record("settings")
	return &product.VoiceSettings{MinAppVersion: "1.0.0"}, f.err
}
func (f *voiceFake) UpdateVoiceWorkspaceSettings(context.Context, product.Actor, product.VoiceWorkspaceFlagsInput) (*product.VoiceSettings, error) {
	f.record("workspace settings")
	return &product.VoiceSettings{}, f.err
}
func (f *voiceFake) UpdateVoiceMemberSettings(context.Context, product.Actor, product.VoiceMemberSettingsInput) (*product.VoiceSettings, error) {
	f.record("member settings")
	return &product.VoiceSettings{}, f.err
}
func (f *voiceFake) ListVoiceNoteIndex(context.Context, product.Actor) ([]product.VoiceNoteIndexEntry, error) {
	f.record("index")
	return []product.VoiceNoteIndexEntry{{ID: "note", ClientNoteID: "phone", Revision: 2, Deleted: true}}, f.err
}
func (f *voiceFake) ListVoiceNotes(_ context.Context, _ product.Actor, query product.VoiceNoteListQuery) (*product.VoiceNotePage, error) {
	f.record("list")
	f.query = query
	return &product.VoiceNotePage{Notes: []product.VoiceNoteListItem{}}, f.err
}
func (f *voiceFake) CreateVoiceNote(context.Context, product.Actor, product.CreateVoiceNoteInput) (*product.VoiceNoteDetail, bool, error) {
	f.record("create")
	return &product.VoiceNoteDetail{}, f.isNew, f.err
}
func (f *voiceFake) GetVoiceNote(_ context.Context, _ product.Actor, id string) (*product.VoiceNoteDetail, error) {
	f.record("get", id)
	return &product.VoiceNoteDetail{}, f.err
}
func (f *voiceFake) UpdateVoiceNote(_ context.Context, _ product.Actor, id string, input product.UpdateVoiceNoteInput) (*product.VoiceNoteDetail, error) {
	f.record("update", id)
	f.patch = input
	return &product.VoiceNoteDetail{}, f.err
}
func (f *voiceFake) DeleteVoiceNote(_ context.Context, _ product.Actor, id string) error {
	f.record("delete", id)
	return f.err
}
func (f *voiceFake) AddVoiceTranscript(_ context.Context, _ product.Actor, id string, _ product.AddVoiceTranscriptInput) (*product.VoiceTranscriptResult, bool, error) {
	f.record("transcript", id)
	return &product.VoiceTranscriptResult{}, f.isNew, f.err
}
func (f *voiceFake) RedactVoiceTranscript(_ context.Context, _ product.Actor, id, revisionID string) (*product.VoiceTranscriptRevision, error) {
	f.record("redact", id, revisionID)
	return &product.VoiceTranscriptRevision{}, f.err
}
func (f *voiceFake) SignVoiceRunUpload(_ context.Context, _ product.Actor, id string, runIndex int, _ product.VoiceRunUploadInput) (*product.VoiceRunUpload, error) {
	f.record("upload", id)
	f.runIndex = runIndex
	return &product.VoiceRunUpload{URL: "https://storage.example.test/put", Method: http.MethodPut, Headers: map[string]string{}}, f.err
}
func (f *voiceFake) CompleteVoiceRun(_ context.Context, _ product.Actor, id string, runIndex int) (*product.VoiceAudioRun, error) {
	f.record("complete", id)
	f.runIndex = runIndex
	return &product.VoiceAudioRun{Status: "available"}, f.err
}
func (f *voiceFake) SignVoiceRunAudio(_ context.Context, _ product.Actor, id string, runIndex int) (*product.VoiceRunAudio, error) {
	f.record("audio", id)
	f.runIndex = runIndex
	return &product.VoiceRunAudio{URL: "https://storage.example.test/get"}, f.err
}
func (f *voiceFake) DeleteVoiceAudio(_ context.Context, _ product.Actor, id string) error {
	f.record("delete audio", id)
	return f.err
}

func voiceRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org")
	request.Header.Set("X-User-ID", "user")
	request.Header.Set("X-Session-ID", "session")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// Every voice route of the contract (section 4, rows 1-15) reaches its
// operation with its path values and answers the contract's status.
func TestVoiceRoutesReachTheirOperations(t *testing.T) {
	note, revision := "cmnote0000000000000000001", "cmrevision000000000000001"
	for _, test := range []struct {
		method, path, body string
		isNew              bool
		call               string
		status             int
	}{
		{"GET", "/v1/voice/settings", "", false, "settings", 200},
		{"PUT", "/v1/voice/settings/workspace", `{"voiceNotes":true}`, false, "workspace settings", 200},
		{"PUT", "/v1/voice/settings/member", `{"remoteTextConsent":false}`, false, "member settings", 200},
		{"GET", "/v1/voice/notes/index", "", false, "index", 200},
		{"GET", "/v1/voice/notes?limit=5&cursor=abc", "", false, "list", 200},
		{"POST", "/v1/voice/notes", `{"clientNoteId":"phone","recordedAt":"2026-11-11T09:00:00Z","recordedTimeZone":"UTC"}`, true, "create", 201},
		{"POST", "/v1/voice/notes", `{"clientNoteId":"phone","recordedAt":"2026-11-11T09:00:00Z","recordedTimeZone":"UTC"}`, false, "create", 200},
		{"GET", "/v1/voice/notes/" + note, "", false, "get", 200},
		{"PATCH", "/v1/voice/notes/" + note, `{"expectedRevision":2,"projectId":null}`, false, "update", 200},
		{"DELETE", "/v1/voice/notes/" + note, "", false, "delete", 204},
		{"POST", "/v1/voice/notes/" + note + "/transcripts", `{"clientRevisionId":"r","origin":"on_device","text":"words","segments":[]}`, true, "transcript", 201},
		{"POST", "/v1/voice/notes/" + note + "/transcripts", `{"clientRevisionId":"r","origin":"on_device","text":"words","segments":[]}`, false, "transcript", 200},
		{"POST", "/v1/voice/notes/" + note + "/transcripts/" + revision + "/redact", "", false, "redact", 200},
		{"POST", "/v1/voice/notes/" + note + "/runs/3/upload", `{"contentType":"audio/aac","bytes":10,"sha256":"00","startOffsetMs":0}`, false, "upload", 200},
		{"POST", "/v1/voice/notes/" + note + "/runs/3/complete", "", false, "complete", 200},
		{"GET", "/v1/voice/notes/" + note + "/runs/3/audio", "", false, "audio", 200},
		{"DELETE", "/v1/voice/notes/" + note + "/audio", "", false, "delete audio", 204},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			fake := &voiceFake{isNew: test.isNew}
			handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", fake)
			response := voiceRequest(handler, test.method, test.path, test.body)
			if response.Code != test.status || fake.call != test.call {
				t.Fatalf("status=%d call=%q body=%s", response.Code, fake.call, response.Body.String())
			}
			if strings.Contains(test.path, note) && fake.noteID != note {
				t.Fatalf("note id=%q", fake.noteID)
			}
			if strings.Contains(test.path, "/runs/3/") && fake.runIndex != 3 {
				t.Fatalf("run index=%d", fake.runIndex)
			}
			if test.call == "redact" && fake.second != revision {
				t.Fatalf("revision id=%q", fake.second)
			}
		})
	}
	fake := &voiceFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", fake)
	response := voiceRequest(handler, "GET", "/v1/voice/notes/index", "")
	var index struct {
		Notes []map[string]any `json:"notes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &index); err != nil || len(index.Notes) != 1 || index.Notes[0]["clientNoteId"] != "phone" || index.Notes[0]["deleted"] != true {
		t.Fatalf("index body=%s err=%v", response.Body.String(), err)
	}
	voiceRequest(handler, "GET", "/v1/voice/notes?limit=5&cursor=abc", "")
	if fake.query != (product.VoiceNoteListQuery{Limit: 5, Cursor: "abc"}) {
		t.Fatalf("query=%+v", fake.query)
	}
	voiceRequest(handler, "PATCH", "/v1/voice/notes/"+note, `{"expectedRevision":2,"projectId":null}`)
	if fake.patch.ExpectedRevision != 2 || !fake.patch.ProjectID.Set || fake.patch.ProjectID.Value != nil {
		t.Fatalf("a null projectId must clear the project: %+v", fake.patch)
	}
	response = voiceRequest(handler, "POST", "/v1/voice/notes/"+note+"/runs/0/upload", `{"contentType":"audio/aac","bytes":1,"sha256":"00"}`)
	if !strings.Contains(response.Body.String(), `"method":"PUT"`) || response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("upload body=%s headers=%v", response.Body.String(), response.Header())
	}
}

// Domain errors map to the contract's status codes, and malformed paths and
// bodies never reach the domain.
func TestVoiceRouteStatusCodes(t *testing.T) {
	note := "cmnote0000000000000000001"
	for _, test := range []struct {
		name, method, path, body string
		err                      error
		status                   int
		reached                  bool
	}{
		{"an API key or a feature switched off", "POST", "/v1/voice/notes", `{"clientNoteId":"n"}`, publishing.ErrForbidden, 403, true},
		{"another member's note", "GET", "/v1/voice/notes/" + note, "", publishing.ErrNotFound, 404, true},
		{"a deleted note", "POST", "/v1/voice/notes/" + note + "/transcripts", `{"clientRevisionId":"r"}`, publishing.ErrConflict, 409, true},
		{"invalid input", "PATCH", "/v1/voice/notes/" + note, `{"expectedRevision":0}`, product.ErrInvalidInput, 400, true},
		{"a missing object", "POST", "/v1/voice/notes/" + note + "/runs/0/complete", "", product.ErrObjectMissing, 400, true},
		{"storage down", "GET", "/v1/voice/notes/" + note + "/runs/0/audio", "", product.ErrStorageUnavailable, 503, true},
		{"unknown fields", "POST", "/v1/voice/notes", `{"clientNoteId":"n","owner":"x"}`, nil, 400, false},
		{"a malformed note id", "GET", "/v1/voice/notes/NOT-AN-ID", "", nil, 400, false},
		{"a negative run index", "POST", "/v1/voice/notes/" + note + "/runs/-1/complete", "", nil, 400, false},
		{"a run index that is not a number", "GET", "/v1/voice/notes/" + note + "/runs/one/audio", "", nil, 400, false},
		{"a malformed revision id", "POST", "/v1/voice/notes/" + note + "/transcripts/x/redact", "", nil, 400, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			fake := &voiceFake{err: test.err}
			handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", fake)
			response := voiceRequest(handler, test.method, test.path, test.body)
			if response.Code != test.status || (fake.call != "") != test.reached {
				t.Fatalf("status=%d reached=%q body=%s", response.Code, fake.call, response.Body.String())
			}
		})
	}
	// The web facade's service token is required.
	fake := &voiceFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", fake)
	request := httptest.NewRequest("GET", "/v1/voice/settings", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || fake.call != "" {
		t.Fatalf("unauthenticated status=%d", response.Code)
	}
}
