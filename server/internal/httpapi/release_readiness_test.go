package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

type qualificationConfiguration struct {
	fakeConfiguration
	input        product.CreateQualificationInput
	key          string
	created      bool
	failure      error
	sourceInput  product.SelectReleaseSourcesInput
	queryRelease string
	cursor       string
	mergeInput   product.MergeReleaseInput
	splitInput   product.SplitReleaseInput
}

func (f *qualificationConfiguration) SelectReleaseSources(_ context.Context, actor product.Actor, key string, input product.SelectReleaseSourcesInput) (*product.ReleaseSourceSelection, error) {
	f.actor, f.sourceInput, f.key = actor, input, key
	if f.failure != nil {
		return nil, f.failure
	}
	return &product.ReleaseSourceSelection{Created: f.created, ReleaseID: "release-1", Revision: "9007199254740993"}, nil
}

func (f *qualificationConfiguration) ListReleaseSources(_ context.Context, actor product.Actor, releaseID, cursor string) (*product.ReleaseSourcePage, error) {
	f.actor, f.queryRelease, f.cursor = actor, releaseID, cursor
	return &product.ReleaseSourcePage{Items: []product.ReleaseSource{}}, nil
}

func TestSourceSelectionHTTPContract(t *testing.T) {
	config := &qualificationConfiguration{created: true}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		for key, value := range map[string]string{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-User-ID": "user-1", "X-Session-ID": "session-1", "Idempotency-Key": "same-choice"} {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if response := call(http.MethodGet, "/v1/release-sources?releaseId=release-1&cursor=source-2", ""); response.Code != http.StatusOK || config.queryRelease != "release-1" || config.cursor != "source-2" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("source page mapping: %d %+v", response.Code, config)
	}
	body := `{"releaseId":null,"newRelease":{"title":"Change","benefitStatement":"Useful outcome"},"expectedRevision":"0","sources":[{"bindingId":"source-1","observationId":"observation-1","expectedSequence":"9007199254740993"}]}`
	response := call(http.MethodPost, "/v1/release-sources/selections", body)
	if response.Code != http.StatusCreated || config.key != "same-choice" || config.sourceInput.Sources[0].ExpectedSequence != "9007199254740993" {
		t.Fatalf("selection mapping: %d %+v", response.Code, config)
	}
	config.created = false
	if response := call(http.MethodPost, "/v1/release-sources/selections", body); response.Code != http.StatusOK {
		t.Fatalf("selection replay: %d", response.Code)
	}
	for _, invalid := range []string{`{"organizationId":"foreign"}`, `{"sources":[{"expectedSequence":1}]}`, `{"newRelease":{"title":"Change","actor":"forged"}}`} {
		if response := call(http.MethodPost, "/v1/release-sources/selections", invalid); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid source selection: %d %s", response.Code, invalid)
		}
	}
	releaseID := "release-existing"
	config.failure = &product.SourceSelectionError{Reason: "SOURCE_ALREADY_ASSOCIATED", ReleaseID: &releaseID}
	response = call(http.MethodPost, "/v1/release-sources/selections", body)
	var result struct {
		Details product.SourceSelectionError `json:"details"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusConflict || result.Details.ReleaseID == nil || *result.Details.ReleaseID != releaseID {
		t.Fatalf("association conflict lost repair: %d %s %v", response.Code, response.Body, err)
	}
	config.failure = &product.SourceSelectionError{Reason: "SOURCE_UNAVAILABLE"}
	if response := call(http.MethodPost, "/v1/release-sources/selections", body); response.Code != http.StatusForbidden {
		t.Fatalf("source access failure: %d", response.Code)
	}
}

func (f *qualificationConfiguration) CreateQualificationRevision(_ context.Context, actor product.Actor, id, key string, input product.CreateQualificationInput) (*releasefacts.Result, error) {
	f.actor, f.input, f.key = actor, input, key
	if f.failure != nil {
		return nil, f.failure
	}
	return &releasefacts.Result{Created: f.created, Revision: "9007199254740993", QualificationRevisionID: "revision-1"}, nil
}

func TestQualificationHTTPContract(t *testing.T) {
	config := &qualificationConfiguration{created: true}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	call := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/releases/c123456789012345678901234/qualification/revisions", strings.NewReader(body))
		for key, value := range map[string]string{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-User-ID": "user-1", "X-Session-ID": "session-1", "Idempotency-Key": "same-command"} {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	body := `{"expectedRevision":"9007199254740992","facts":{"rollout":"UNKNOWN"}}`
	response := call(body)
	if response.Code != http.StatusCreated || config.key != "same-command" || config.input.ExpectedRevision != "9007199254740992" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("request mapping: %d %+v", response.Code, config)
	}
	config.created = false
	if response = call(body); response.Code != http.StatusOK {
		t.Fatalf("replay=%d", response.Code)
	}
	for _, invalid := range []string{`{"expectedRevision":1,"facts":{}}`, `{"expectedRevision":"0","humanUserId":"someone","facts":{}}`, `{"expectedRevision":"0","facts":{"rollout":"UNKNOWN","actor":"someone"}}`} {
		if response := call(invalid); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid shape accepted: %d %s", response.Code, invalid)
		}
	}
	config.failure = &product.QualificationError{Reason: "MISSING_FACTS", CurrentRevision: "2", Blockers: []product.QualificationBlocker{{Field: "rollout", Reason: "ROLLOUT_UNKNOWN", RepairAction: "REVISE_FACTS"}}}
	response = call(body)
	var result struct {
		Code    string                     `json:"code"`
		Details product.QualificationError `json:"details"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusConflict || result.Code != "conflict" || len(result.Details.Blockers) != 1 || result.Details.Blockers[0].Reason != "ROLLOUT_UNKNOWN" {
		t.Fatalf("structured conflict: %d %s %v", response.Code, response.Body, err)
	}
}

func (f *qualificationConfiguration) MergeRelease(_ context.Context, actor product.Actor, id, key string, input product.MergeReleaseInput) (*product.ReleaseLineageResult, error) {
	f.actor, f.queryRelease, f.key, f.mergeInput = actor, id, key, input
	if f.failure != nil {
		return nil, f.failure
	}
	return &product.ReleaseLineageResult{Created: f.created, ReleaseID: id, Releases: []releasefacts.ReleaseReference{{ReleaseID: id, Revision: "9007199254740993"}, {ReleaseID: "release-old", Revision: "2"}}, LineageIDs: []string{"lineage-1"}}, nil
}
func (f *qualificationConfiguration) SplitRelease(_ context.Context, actor product.Actor, id, key string, input product.SplitReleaseInput) (*product.ReleaseLineageResult, error) {
	f.actor, f.queryRelease, f.key, f.splitInput = actor, id, key, input
	if f.failure != nil {
		return nil, f.failure
	}
	return &product.ReleaseLineageResult{Created: f.created, ReleaseID: id, Releases: []releasefacts.ReleaseReference{{ReleaseID: id, Revision: "9007199254740993"}, {ReleaseID: "release-new", Revision: "1"}}, LineageIDs: []string{"lineage-1"}}, nil
}
func (f *qualificationConfiguration) GetReleaseLineage(_ context.Context, actor product.Actor, id, cursor string) (*product.ReleaseLineageHistory, error) {
	f.actor, f.queryRelease, f.cursor = actor, id, cursor
	return &product.ReleaseLineageHistory{Items: []product.ReleaseLineageEntry{}}, nil
}
func TestReleaseLineageHTTPContract(t *testing.T) {
	config := &qualificationConfiguration{created: true}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	call := func(method, suffix, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/v1/releases/c123456789012345678901234/qualification/"+suffix, strings.NewReader(body))
		for key, value := range map[string]string{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-User-ID": "user-1", "X-Session-ID": "session-1", "Idempotency-Key": "same-grouping"} {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	merge := `{"expectedRevision":"9007199254740992","sources":[{"releaseId":"release-old","expectedRevision":"1"}],"bindingIds":["binding-1"],"reason":"Shared rollout"}`
	split := `{"expectedRevision":"9007199254740992","groups":[{"bindingIds":["binding-1"],"newRelease":{"title":"Separate rollout","benefitStatement":"A useful change"}}],"reason":"Separate rollout"}`
	for operation, body := range map[string]string{"merge": merge, "split": split} {
		config.created = true
		response := call(http.MethodPost, operation, body)
		var result product.ReleaseLineageResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusCreated || result.Releases[0].Revision != "9007199254740993" || config.key != "same-grouping" || config.actor.SessionID != "session-1" || config.queryRelease != "c123456789012345678901234" {
			t.Fatalf("%s mapping: %d %s %v", operation, response.Code, response.Body, err)
		}
		config.created = false
		if response := call(http.MethodPost, operation, body); response.Code != http.StatusOK {
			t.Fatalf("%s replay: %d", operation, response.Code)
		}
		for _, invalid := range []string{`{"organizationId":"foreign"}`, `{"expectedRevision":1}`, strings.Replace(body, `"bindingIds":["binding-1"]`, `"bindingIds":["binding-1"],"actor":"forged"`, 1)} {
			if response := call(http.MethodPost, operation, invalid); response.Code != http.StatusBadRequest {
				t.Fatalf("%s invalid accepted: %d %s", operation, response.Code, invalid)
			}
		}
	}
	if config.mergeInput.ExpectedRevision != "9007199254740992" || config.splitInput.Groups[0].NewRelease.Title != "Separate rollout" {
		t.Fatal("grouping payload lost")
	}
	if response := call(http.MethodGet, "lineage?cursor=history-1", ""); response.Code != http.StatusOK || config.cursor != "history-1" {
		t.Fatalf("history mapping: %d", response.Code)
	}
	canonical := "release-current"
	config.failure = &product.QualificationError{Reason: "CANONICAL_RELEASE_CHANGED", CurrentRevision: "3", CanonicalReleaseID: &canonical, Blockers: []product.QualificationBlocker{}}
	response := call(http.MethodPost, "merge", merge)
	var failure struct {
		Details product.QualificationError `json:"details"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != http.StatusConflict || failure.Details.CanonicalReleaseID == nil || *failure.Details.CanonicalReleaseID != canonical {
		t.Fatalf("repair destination lost: %d %s %v", response.Code, response.Body, err)
	}
}
