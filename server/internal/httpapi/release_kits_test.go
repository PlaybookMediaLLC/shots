package httpapi

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasekits"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type kitConfiguration struct {
	fakeConfiguration
	releaseID, revisionID, key string
	input                      product.PrepareReleaseKitInput
	replay                     bool
	failure                    error
}

func (f *kitConfiguration) PrepareReleaseKit(_ context.Context, actor product.Actor, releaseID, revisionID, key string, input product.PrepareReleaseKitInput) (*product.ReadinessMutation, error) {
	f.actor, f.releaseID, f.revisionID, f.key, f.input = actor, releaseID, revisionID, key, input
	if f.failure != nil {
		return nil, f.failure
	}
	return &product.ReadinessMutation{Created: !f.replay, Revision: "9007199254740993", ID: revisionID}, nil
}
func (f *kitConfiguration) GetKitArtifactPreview(_ context.Context, actor product.Actor, releaseID, revisionID, artifactID string) (*product.KitArtifactPreview, error) {
	f.actor, f.releaseID, f.revisionID = actor, releaseID, revisionID
	return &product.KitArtifactPreview{Body: []byte("Private preview"), MediaType: "text/markdown; charset=utf-8"}, nil
}
func TestReleaseKitHTTPPreservesSnapshotCommandAndBlockers(t *testing.T) {
	config := &kitConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		for key, value := range map[string]string{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-User-ID": "user-1", "X-Session-ID": "session-1", "Idempotency-Key": "same-freeze"} {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	body := `{"expectedRevision":"9007199254740992","snapshots":[{"artifactRevisionId":"artifact-1","snapshotSha256":"` + strings.Repeat("a", 64) + `"}]}`
	path := "/v1/releases/release-1/kits/revision-1/prepare"
	if response := call("POST", path, body); response.Code != http.StatusAccepted || config.releaseID != "release-1" || config.revisionID != "revision-1" || config.key != "same-freeze" || config.input.ExpectedRevision != "9007199254740992" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("prepare mapping: %d %+v", response.Code, config)
	}
	config.replay = true
	if response := call("POST", path, body); response.Code != http.StatusOK {
		t.Fatalf("retry=%d", response.Code)
	}
	for _, invalid := range []string{`{"expectedRevision":9007199254740992}`, `{"organizationId":"foreign"}`, `{"snapshots":[{"artifactRevisionId":"\ud800"}]}`} {
		if response := call("POST", path, invalid); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid command accepted: %d", response.Code)
		}
	}
	config.failure = &product.KitReadinessError{Reason: "SOURCE_CHANGED", CurrentRevision: "9", Blockers: []releasekits.Blocker{{Code: "SOURCE_CHANGED", ObjectID: "source-1", RepairAction: "Review the changed source."}}}
	response := call("POST", path, body)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"blockers"`) || !strings.Contains(response.Body.String(), "SOURCE_CHANGED") {
		t.Fatalf("conflict lost repair: %d %s", response.Code, response.Body)
	}
	preview := call("GET", "/v1/releases/release-1/kits/revision-1/artifacts/artifact-1/preview", "")
	if preview.Code != http.StatusOK || preview.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("preview=%d cache=%s", preview.Code, preview.Header().Get("Cache-Control"))
	}
}
