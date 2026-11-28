package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type platformControlsFake struct {
	ConfigurationStore
	actor   product.Actor
	created bool
}

func (f *platformControlsFake) AuthorizeRead(context.Context, product.Actor) error { return nil }
func (f *platformControlsFake) GetWebhookSource(_ context.Context, id string) (*product.WebhookSource, error) {
	return &product.WebhookSource{ID: id, OrganizationID: "org-1", Provider: "github"}, nil
}
func (f *platformControlsFake) IngestSourceRelease(_ context.Context, actor product.Actor, _ product.IngestSourceReleaseInput) (*product.SourceReleaseIngest, error) {
	f.actor = actor
	return &product.SourceReleaseIngest{Created: f.created, ReleaseID: "release-1"}, nil
}

func (f *platformControlsFake) ReplayOutboxEvent(_ context.Context, id string) error {
	if id != "cevent00000001" {
		return publishing.ErrNotFound
	}
	return nil
}
func (f *platformControlsFake) SyncWorkspaceEntitlement(_ context.Context, input product.EntitlementSyncInput) (*product.EntitlementSyncResult, error) {
	return &product.EntitlementSyncResult{Version: input.ExpectedVersion + 1}, nil
}

func (f *platformControlsFake) SyncWorkspaceAddon(_ context.Context, input product.AddonSyncInput) (*product.AddonSyncResult, error) {
	if input.ExpectedVersion == 99 {
		return nil, product.EntitlementConflictError{Current: 4}
	}
	return &product.AddonSyncResult{Version: input.ExpectedVersion + 1}, nil
}

func (f *platformControlsFake) GrantWorkspaceCredits(_ context.Context, input product.CreditGrantInput) (*product.CreditGrantResult, error) {
	if input.Credits <= 0 {
		return nil, product.ErrInvalidInput
	}
	return &product.CreditGrantResult{Balance: input.Credits}, nil
}

func TestOutboxReplayAndBillingSyncAreServiceOnly(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &platformControlsFake{})
	post := func(path, token, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	for path, want := range map[string]int{
		"/v1/internal/outbox-events/cevent00000001/replay": http.StatusOK,
		"/v1/internal/outbox-events/cevent00000002/replay": http.StatusNotFound,
		"/v1/internal/outbox-events/NOT-AN-ID/replay":      http.StatusNotFound,
	} {
		if code := post(path, "secret", "").Code; code != want {
			t.Errorf("%s: status %d want %d", path, code, want)
		}
	}
	billing := `{"eventId":"e1","eventType":"t","expectedVersion":2,"organizationId":"org-1","plan":"pro","provider":"p","status":"active","featureOverrides":{}}`
	if code := post("/v1/internal/billing/entitlements", "wrong", billing).Code; code != http.StatusUnauthorized {
		t.Fatalf("unsigned billing sync status %d", code)
	}
	if response := post("/v1/internal/billing/entitlements", "secret", billing); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":3`) {
		t.Fatalf("billing sync %d %s", response.Code, response.Body.String())
	}
	addon := `{"addonKey":"x_links","eventId":"e2","eventType":"t","expectedVersion":1,"organizationId":"org-1","provider":"stripe","status":"active"}`
	if code := post("/v1/internal/billing/addons", "wrong", addon).Code; code != http.StatusUnauthorized {
		t.Fatalf("unsigned addon sync status %d", code)
	}
	if code := post("/v1/internal/billing/addons", "secret", `{invalid`).Code; code != http.StatusBadRequest {
		t.Fatalf("invalid json addon sync status %d", code)
	}
	if response := post("/v1/internal/billing/addons", "secret", addon); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"version":2`) {
		t.Fatalf("addon sync %d %s", response.Code, response.Body.String())
	}
	addonConflict := `{"addonKey":"x_links","eventId":"e3","eventType":"t","expectedVersion":99,"organizationId":"org-1","provider":"stripe","status":"active"}`
	if response := post("/v1/internal/billing/addons", "secret", addonConflict); response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"currentVersion":4`) {
		t.Fatalf("addon conflict %d %s", response.Code, response.Body.String())
	}
	grant := `{"credits":500,"organizationId":"org-1","provider":"stripe","reference":"cs_1"}`
	if code := post("/v1/internal/billing/credit-grants", "wrong", grant).Code; code != http.StatusUnauthorized {
		t.Fatalf("unsigned credit grant status %d", code)
	}
	if response := post("/v1/internal/billing/credit-grants", "secret", grant); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"balance":500`) {
		t.Fatalf("credit grant %d %s", response.Code, response.Body.String())
	}
	if code := post("/v1/internal/billing/credit-grants", "secret", `{"credits":0}`).Code; code != http.StatusBadRequest {
		t.Fatalf("empty credit grant status %d", code)
	}
}

func TestWebhookSourceIsFacadeOnlyAndIngestReportsReplays(t *testing.T) {
	config := &platformControlsFake{created: true}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	lookup := func(token string) int {
		request := httptest.NewRequest(http.MethodGet, "/v1/internal/source-apps/csourceapp0001/webhook", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}
	if lookup("wrong") != http.StatusUnauthorized || lookup("secret") != http.StatusOK {
		t.Fatal("webhook source lookup must require the service token alone")
	}
	ingest := func() int {
		request := httptest.NewRequest(http.MethodPost, "/v1/source-releases",
			strings.NewReader(`{"eventId":"d1","sourceAppId":"csourceapp0001","title":"v2","benefitStatement":"Faster."}`))
		request.Header.Set("Authorization", "Bearer secret")
		request.Header.Set("X-Organization-ID", "org-1")
		request.Header.Set("X-Principal-Kind", "webhook")
		request.Header.Set("X-Principal-Display", "csourceapp0001")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}
	if code := ingest(); code != http.StatusCreated || config.actor.Kind != "webhook" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("ingest status=%d actor=%+v", code, config.actor)
	}
	config.created = false
	if code := ingest(); code != http.StatusOK {
		t.Fatalf("replayed ingest status=%d", code)
	}
}
