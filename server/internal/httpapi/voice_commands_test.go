package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type voiceCommandFake struct {
	fakeConfiguration
	actor   product.Actor
	note    string
	draft   product.VoiceDraftInput
	confirm product.VoiceCommandConfirmInput
	err     error
}

func (f *voiceCommandFake) CreateVoiceDraft(_ context.Context, actor product.Actor, note string, input product.VoiceDraftInput) (*product.VoiceDraftResult, error) {
	f.actor, f.note, f.draft = actor, note, input
	if f.err != nil {
		return nil, f.err
	}
	return &product.VoiceDraftResult{ContentDraftID: "draft-1"}, nil
}

func (f *voiceCommandFake) ConfirmVoiceCommand(_ context.Context, actor product.Actor, note string, input product.VoiceCommandConfirmInput) (*product.VoiceCommandConfirmation, error) {
	f.actor, f.note, f.confirm = actor, note, input
	if f.err != nil {
		return nil, f.err
	}
	post := "post-1"
	return &product.VoiceCommandConfirmation{Outcome: "scheduled", ScheduledPostID: &post,
		Scheduled: []*ent.ScheduledPost{{ID: post, OrganizationID: actor.OrganizationID, ScheduledFor: time.Now().Add(time.Hour)}}}, nil
}

func TestVoiceCommandsHTTP(t *testing.T) {
	const note = "/v1/voice/notes/c123456789012345678901234"
	config := &voiceCommandFake{}
	scheduler := &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, &fakeVerifier{}, "secret", config)
	for _, c := range []struct {
		name, path, body string
		err              error
		status           int
	}{
		{"draft", note + "/draft", `{"transcriptRevisionId":"r1","intent":"launch_post","assetIds":["a1"]}`, nil, http.StatusCreated},
		{"draft with an unknown field", note + "/draft", `{"intent":"launch_post","publish":true}`, nil, http.StatusBadRequest},
		{"draft for a bad note ID", "/v1/voice/notes/not%20an%20id/draft", `{}`, nil, http.StatusBadRequest},
		{"draft without consent", note + "/draft", `{"intent":"launch_post"}`, publishing.ErrForbidden, http.StatusForbidden},
		{"draft the model could not write", note + "/draft", `{"intent":"launch_post"}`, product.ErrVoiceDraftFailed, http.StatusServiceUnavailable},
		{"confirm", note + "/command/confirm", `{"text":"Hi","channelConnectionId":"c1","localTime":"2026-11-12T10:00","timeZone":"UTC"}`, nil, http.StatusOK},
		{"confirm with an unknown field", note + "/command/confirm", `{"text":"Hi","scheduledPostId":"p1"}`, nil, http.StatusBadRequest},
		{"confirm a skipped time", note + "/command/confirm", `{"text":"Hi"}`, &product.LocalTimeError{Kind: "gap"}, http.StatusBadRequest},
		{"confirm a changed proposal", note + "/command/confirm", `{"text":"Hi"}`, publishing.ErrConflict, http.StatusConflict},
		{"confirm another member's note", note + "/command/confirm", `{"text":"Hi"}`, publishing.ErrNotFound, http.StatusNotFound},
	} {
		t.Run(c.name, func(t *testing.T) {
			config.err = c.err
			if response := configurationRequest(handler, http.MethodPost, c.path, c.body); response.Code != c.status {
				t.Fatalf("status=%d, want %d: %s", response.Code, c.status, response.Body)
			}
		})
	}
	if config.actor.OrganizationID != "org-1" || config.actor.UserID != "user-1" || config.note != "c123456789012345678901234" {
		t.Fatalf("actor=%+v note=%q", config.actor, config.note)
	}
	config.err = nil
	if response := configurationRequest(handler, http.MethodPost, note+"/draft", `{"transcriptRevisionId":"r1","intent":"launch_post","assetIds":["a1"]}`); response.Code != http.StatusCreated ||
		config.draft.TranscriptRevisionID != "r1" || len(config.draft.AssetIDs) != 1 {
		t.Fatalf("draft status=%d input=%+v", response.Code, config.draft)
	}
	response := configurationRequest(handler, http.MethodPost, note+"/command/confirm",
		`{"text":"Hi","channelConnectionId":"c1","localTime":"2026-11-12T10:00","timeZone":"UTC"}`)
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["outcome"] != "scheduled" || body["scheduledPostId"] != "post-1" ||
		scheduler.started.PostID != "post-1" || config.confirm.ChannelConnectionID != "c1" {
		t.Fatalf("confirm body=%v started=%+v err=%v", body, scheduler.started, err)
	}
	if _, leaked := body["Scheduled"]; leaked {
		t.Fatalf("workflow inputs leaked: %v", body)
	}
}

// A confirmed post whose workflow cannot be woken is still scheduled: the
// dispatcher starts it, so the confirm succeeds (plan 6.8).
func TestVoiceCommandConfirmWithoutTemporal(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &unreachableScheduler{}, &fakeVerifier{}, "secret", &voiceCommandFake{})
	response := configurationRequest(handler, http.MethodPost, "/v1/voice/notes/c123456789012345678901234/command/confirm", `{"text":"Hi"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d: %s", response.Code, response.Body)
	}
}
