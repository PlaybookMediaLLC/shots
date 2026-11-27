package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

type conversationViewFake struct {
	fakeConfiguration
	gotID string
	view  *product.ConversationView
	err   error
}

func (f *conversationViewFake) GetConversationView(_ context.Context, _ product.Actor, id string) (*product.ConversationView, error) {
	f.gotID = id
	if f.err != nil {
		return nil, f.err
	}
	return f.view, nil
}

func TestGetConversationViewRoute(t *testing.T) {
	const conversationID = "c123456789012345678901234"
	config := &conversationViewFake{
		view: &product.ConversationView{
			Conversation: product.ConversationRecord{ID: conversationID, Title: "Launch Plan", Status: "ACTIVE"},
			Messages:     []product.ConversationMessageRecord{{ID: "m1", ConversationID: conversationID, Role: "USER", Kind: "TEXT", Content: "Ship v2"}},
			Runs: []product.ConversationRunView{
				{
					Run:   product.LaunchRunRecord{ID: "run-1", Status: "COMPLETED"},
					Steps: []product.LaunchRunStepRecord{{ID: "step-1", RunID: "run-1", Index: 0}},
				},
			},
		},
	}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)

	unauthReq := httptest.NewRequest(http.MethodGet, "/v1/conversations/"+conversationID+"/view", nil)
	unauthRes := httptest.NewRecorder()
	handler.ServeHTTP(unauthRes, unauthReq)
	if unauthRes.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", unauthRes.Code)
	}

	if invalid := configurationRequest(handler, http.MethodGet, "/v1/conversations/not-valid-id!/view", ""); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid ID status = %d, want 400", invalid.Code)
	}

	ok := configurationRequest(handler, http.MethodGet, "/v1/conversations/"+conversationID+"/view", "")
	if ok.Code != http.StatusOK {
		t.Fatalf("valid status = %d, body = %s", ok.Code, ok.Body.String())
	}
	var payload product.ConversationView
	if err := json.NewDecoder(ok.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if config.gotID != conversationID || payload.Conversation.ID != conversationID || len(payload.Messages) != 1 || len(payload.Runs) != 1 || len(payload.Runs[0].Steps) != 1 {
		t.Fatalf("unexpected payload: gotID=%q payload=%+v", config.gotID, payload)
	}
}
