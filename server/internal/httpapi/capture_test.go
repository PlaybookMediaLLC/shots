package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type captureConfiguration struct {
	fakeConfiguration
	startErr   error
	actor      product.Actor
	connection product.CreateCaptureConnectionInput
	recipe     product.CreateCaptureRecipeInput
	intent     string
	test       bool
}

func (c *captureConfiguration) CaptureAvailable() bool { return true }
func (c *captureConfiguration) CreateCaptureConnection(_ context.Context, actor product.Actor, input product.CreateCaptureConnectionInput) (*product.CaptureConnectionRecord, error) {
	c.actor, c.connection = actor, input
	return &product.CaptureConnectionRecord{ID: "connection-1", Name: input.Name, Status: "CONNECTING"}, nil
}
func (c *captureConfiguration) ListCaptureConnections(context.Context, product.Actor) ([]product.CaptureConnectionRecord, error) {
	return []product.CaptureConnectionRecord{{ID: "connection-1", Status: "READY"}}, nil
}
func (c *captureConfiguration) StartCaptureConnect(_ context.Context, actor product.Actor, _ string) (*product.CaptureConnectStart, error) {
	c.actor = actor
	if c.startErr != nil {
		return nil, c.startErr
	}
	return &product.CaptureConnectStart{IntentID: "intent-1", LiveViewURL: "https://live.example/view?jwt=dummy", ExpiresAt: time.Now()}, nil
}
func (c *captureConfiguration) FinishCaptureConnect(_ context.Context, _ product.Actor, _ string, intent string) error {
	c.intent = intent
	if intent == "stale" {
		return publishing.ErrConflict
	}
	return nil
}
func (c *captureConfiguration) RevokeCaptureConnection(context.Context, product.Actor, string) error {
	return nil
}
func (c *captureConfiguration) CreateCaptureRecipe(_ context.Context, _ product.Actor, input product.CreateCaptureRecipeInput) (*product.CaptureRecipeRecord, error) {
	c.recipe = input
	return &product.CaptureRecipeRecord{ID: "recipe-1", Version: 1, Status: "DRAFT"}, nil
}
func (c *captureConfiguration) ListCaptureRecipes(context.Context, product.Actor) ([]product.CaptureRecipeRecord, error) {
	return []product.CaptureRecipeRecord{}, nil
}
func (c *captureConfiguration) ActivateCaptureRecipe(context.Context, product.Actor, string) (*product.CaptureRecipeRecord, error) {
	return &product.CaptureRecipeRecord{ID: "recipe-1", Status: "ACTIVE"}, nil
}
func (c *captureConfiguration) ArchiveCaptureRecipe(context.Context, product.Actor, string) error {
	return nil
}
func (c *captureConfiguration) RequestCaptureJob(_ context.Context, _ product.Actor, _ string, request product.CaptureJobRequest) (*product.CaptureJobRecord, error) {
	c.test = request.Test
	return &product.CaptureJobRecord{ID: "job-1", Phase: "QUEUED"}, nil
}
func (c *captureConfiguration) ListCaptureJobs(context.Context, product.Actor) ([]product.CaptureJobRecord, error) {
	return []product.CaptureJobRecord{}, nil
}
func (c *captureConfiguration) GetCaptureJob(_ context.Context, _ product.Actor, id string) (*product.CaptureJobRecord, error) {
	if id != "job-1" {
		return nil, publishing.ErrNotFound
	}
	return &product.CaptureJobRecord{ID: id, Phase: "RUNNING"}, nil
}
func (c *captureConfiguration) CancelCaptureJob(context.Context, product.Actor, string) error {
	return nil
}

func TestCaptureRoutesAdaptTransportOntoTheDomain(t *testing.T) {
	config := &captureConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	overview := configurationRequest(handler, http.MethodGet, "/v1/capture", "")
	if overview.Code != http.StatusOK || !strings.Contains(overview.Body.String(), `"available":true`) || !strings.Contains(overview.Body.String(), `"connection-1"`) {
		t.Fatalf("overview=%d %s", overview.Code, overview.Body)
	}
	created := configurationRequest(handler, http.MethodPost, "/v1/capture/connections", `{"name":"Demo","environment":"staging","origin":"https://staging.example.com","hosts":["staging.example.com"],"loginHosts":[],"protectedPath":"/app","identitySelector":"#me","expectedAccount":"demo"}`)
	if created.Code != http.StatusCreated || config.connection.Origin != "https://staging.example.com" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("create=%d %s %+v", created.Code, created.Body, config.connection)
	}
	// The Live View link is a bearer credential: nothing may cache or refer it.
	connect := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect", "")
	if connect.Code != http.StatusOK || connect.Header().Get("Cache-Control") != "no-store" || connect.Header().Get("Referrer-Policy") != "no-referrer" || !strings.Contains(connect.Body.String(), `"liveViewUrl"`) {
		t.Fatalf("connect=%d headers=%v", connect.Code, connect.Header())
	}
	if finish := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect/finish", `{"intentId":"intent-1"}`); finish.Code != http.StatusAccepted || config.intent != "intent-1" {
		t.Fatalf("finish=%d", finish.Code)
	}
	if replay := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect/finish", `{"intentId":"stale"}`); replay.Code != http.StatusConflict {
		t.Fatalf("replay=%d", replay.Code)
	}
	if bad := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect/finish", `{`); bad.Code != http.StatusBadRequest {
		t.Fatalf("bad=%d", bad.Code)
	}
	recipe := configurationRequest(handler, http.MethodPost, "/v1/capture/recipes", `{"name":"Dashboard","surfaceId":"s","connectionId":"c","definition":{"schemaVersion":1,"viewport":{"width":800,"height":600},"steps":[{"kind":"NAVIGATE","path":"/app"}],"markers":["#ready"],"version":{"path":"/api/version"}}}`)
	if recipe.Code != http.StatusCreated || config.recipe.Definition.Version == nil || config.recipe.Definition.Steps[0].Kind != browser.StepNavigate {
		t.Fatalf("recipe=%d %s %+v", recipe.Code, recipe.Body, config.recipe)
	}
	if job := configurationRequest(handler, http.MethodPost, "/v1/capture/recipes/recipe-1/jobs", `{"test":true}`); job.Code != http.StatusAccepted || !config.test {
		t.Fatalf("job=%d", job.Code)
	}
	for path, want := range map[string]int{"/v1/capture/connections/connection-1/revoke": http.StatusOK, "/v1/capture/recipes/recipe-1/activate": http.StatusOK, "/v1/capture/recipes/recipe-1/archive": http.StatusOK, "/v1/capture/jobs/job-1/cancel": http.StatusOK} {
		if got := configurationRequest(handler, http.MethodPost, path, ""); got.Code != want {
			t.Errorf("%s=%d", path, got.Code)
		}
	}
	if got := configurationRequest(handler, http.MethodGet, "/v1/capture/jobs/other", ""); got.Code != http.StatusNotFound {
		t.Fatalf("other job=%d", got.Code)
	}
	// A failure reaches the caller as a safe code, never provider text.
	config.startErr = &browser.Failure{Code: browser.ProviderUnavailable}
	failed := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect", "")
	if failed.Code != http.StatusServiceUnavailable || !strings.Contains(failed.Body.String(), `"provider_unavailable"`) {
		t.Fatalf("failed=%d %s", failed.Code, failed.Body)
	}
	config.startErr = product.ErrAuthenticatedCaptureUnavailable
	if off := configurationRequest(handler, http.MethodPost, "/v1/capture/connections/connection-1/connect", ""); off.Code != http.StatusServiceUnavailable || !strings.Contains(off.Body.String(), `"capture_unavailable"`) {
		t.Fatalf("off=%d %s", off.Code, off.Body)
	}
	if !errors.Is(config.startErr, product.ErrAuthenticatedCaptureUnavailable) {
		t.Fatal("sentinel changed")
	}
}
