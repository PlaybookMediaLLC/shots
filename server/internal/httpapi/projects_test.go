package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

type projectFake struct {
	fakeConfiguration
	write           product.ProjectDocumentWrite
	recentWorkLimit int
	recentWorkPage  *product.RecentWorkPage
	recentWorkErr   error
}

func (f *projectFake) UpdateProjectDocument(_ context.Context, _ product.Actor, _ string, input product.ProjectDocumentWrite) (*product.ProjectWriteResult, error) {
	f.write = input
	return nil, &product.ProjectRevisionConflictError{Current: 7}
}

func (f *projectFake) ListRecentWork(_ context.Context, _ product.Actor, limit int) (*product.RecentWorkPage, error) {
	f.recentWorkLimit = limit
	if f.recentWorkErr != nil {
		return nil, f.recentWorkErr
	}
	return f.recentWorkPage, nil
}

// A stale document write answers 409 with the revision the client must load.
func TestStaleProjectWriteReturnsCurrentRevision(t *testing.T) {
	config := &projectFake{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodPut, "/v1/projects/c123456789012345678901234/document",
		`{"baseRevision":3,"document":{"version":2,"image":{"src":null}}}`)
	var body struct {
		Code            string `json:"code"`
		CurrentRevision int    `json:"currentRevision"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusConflict || body.Code != "project_revision_conflict" || body.CurrentRevision != 7 ||
		config.write.BaseRevision != 3 {
		t.Fatalf("status=%d body=%+v write=%+v", response.Code, body, config.write)
	}
	if invalid := configurationRequest(handler, http.MethodGet, "/v1/projects/not-an-id", ""); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid project ID status=%d", invalid.Code)
	}
}

func TestListRecentWorkEndpoint(t *testing.T) {
	config := &projectFake{
		recentWorkPage: &product.RecentWorkPage{
			Items: []product.RecentWorkItem{
				{ID: "p1", Kind: "project", Name: "Hero"},
				{ID: "c1", Kind: "canvas", Name: "Launch Board"},
			},
		},
	}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)

	// Default limit = 5.
	res := configurationRequest(handler, http.MethodGet, "/v1/recent-work", "")
	if res.Code != http.StatusOK || config.recentWorkLimit != 5 {
		t.Fatalf("default status=%d limit=%d", res.Code, config.recentWorkLimit)
	}
	var payload product.RecentWorkPage
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) != 2 || payload.Items[0].ID != "p1" || payload.Items[1].Kind != "canvas" {
		t.Fatalf("payload=%+v", payload)
	}

	// Valid custom limit.
	res = configurationRequest(handler, http.MethodGet, "/v1/recent-work?limit=12", "")
	if res.Code != http.StatusOK || config.recentWorkLimit != 12 {
		t.Fatalf("custom status=%d limit=%d", res.Code, config.recentWorkLimit)
	}

	// Out-of-bounds and non-numeric limits rejected with 400.
	for _, path := range []string{"/v1/recent-work?limit=0", "/v1/recent-work?limit=21", "/v1/recent-work?limit=abc"} {
		bad := configurationRequest(handler, http.MethodGet, path, "")
		if bad.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d, want 400", path, bad.Code)
		}
	}

	// Store error mapped through writeStoreError.
	config.recentWorkErr = product.ErrInvalidInput
	errRes := configurationRequest(handler, http.MethodGet, "/v1/recent-work", "")
	if errRes.Code != http.StatusBadRequest {
		t.Fatalf("error status=%d, want 400", errRes.Code)
	}
}
