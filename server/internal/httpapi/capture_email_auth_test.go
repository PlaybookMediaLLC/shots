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

type emailAuthConfiguration struct {
	captureConfiguration
	unavailable bool
	recipe      product.SaveCaptureEmailAuthRecipeInput
	enabled     product.EnableCaptureEmailAuthInput
	headers     product.InboundEmailHeaders
	payload     string
}

func (c *emailAuthConfiguration) record(id string) (*product.CaptureEmailAuthRecord, error) {
	if c.unavailable {
		return nil, product.ErrCaptureEmailAuthUnavailable
	}
	return &product.CaptureEmailAuthRecord{ID: "config-1", ConnectionID: id, Status: "DRAFT", TestEmail: "c-x@mail.example.test", Revision: 1}, nil
}
func (c *emailAuthConfiguration) GetCaptureEmailAuth(_ context.Context, _ product.Actor, id string) (*product.CaptureEmailAuthRecord, error) {
	if id == "other" {
		return nil, publishing.ErrNotFound
	}
	return c.record(id)
}
func (c *emailAuthConfiguration) CreateCaptureEmailAuth(_ context.Context, _ product.Actor, id string) (*product.CaptureEmailAuthRecord, error) {
	return c.record(id)
}
func (c *emailAuthConfiguration) SaveCaptureEmailAuthRecipe(_ context.Context, _ product.Actor, id string, input product.SaveCaptureEmailAuthRecipeInput) (*product.CaptureEmailAuthRecord, error) {
	c.recipe = input
	return c.record(id)
}
func (c *emailAuthConfiguration) TestCaptureEmailAuth(_ context.Context, actor product.Actor, id string) (*product.CaptureAuthAttemptRecord, error) {
	c.actor = actor
	return &product.CaptureAuthAttemptRecord{ID: "attempt-1", ConnectionID: id, Mode: "TEST", State: "ADMITTED"}, nil
}
func (c *emailAuthConfiguration) EnableCaptureEmailAuth(_ context.Context, _ product.Actor, id string, input product.EnableCaptureEmailAuthInput) (*product.CaptureEmailAuthRecord, error) {
	c.enabled = input
	return c.record(id)
}
func (c *emailAuthConfiguration) PauseCaptureEmailAuth(_ context.Context, _ product.Actor, id string) (*product.CaptureEmailAuthRecord, error) {
	return c.record(id)
}
func (c *emailAuthConfiguration) RevokeCaptureEmailAuth(context.Context, product.Actor, string) error {
	return nil
}
func (c *emailAuthConfiguration) GetCaptureAuthAttempt(_ context.Context, _ product.Actor, id string) (*product.CaptureAuthAttemptRecord, error) {
	return &product.CaptureAuthAttemptRecord{ID: id, State: "WAITING_FOR_EMAIL", SafeMessage: "Waiting."}, nil
}
func (c *emailAuthConfiguration) CancelCaptureAuthAttempt(context.Context, product.Actor, string) error {
	return nil
}
func (c *emailAuthConfiguration) ReceiveCaptureAuthEmail(_ context.Context, headers product.InboundEmailHeaders, body []byte) (*product.InboundEmailResult, error) {
	c.headers, c.payload = headers, string(body)
	if headers.Signature == "bad" {
		return nil, product.ErrInboundSignature
	}
	return &product.InboundEmailResult{Outcome: "matched"}, nil
}

func TestCaptureEmailAuthRoutesAdaptTransportOntoTheDomain(t *testing.T) {
	config := &emailAuthConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	for _, call := range []struct {
		method, path, body string
		status             int
		contains           string
	}{
		{http.MethodGet, "/v1/capture/connections/c1/email-auth", "", http.StatusOK, `"testEmail":"c-x@mail.example.test"`},
		{http.MethodGet, "/v1/capture/connections/other/email-auth", "", http.StatusNotFound, ""},
		{http.MethodPost, "/v1/capture/connections/c1/email-auth", "", http.StatusCreated, `"status":"DRAFT"`},
		{http.MethodPut, "/v1/capture/connections/c1/email-auth/recipe", `{"expectedRevision":1,"recipe":{"schemaVersion":1,"method":"MAGIC_LINK"},"expectedSenders":["login@acme.test"]}`, http.StatusOK, ""},
		{http.MethodPut, "/v1/capture/connections/c1/email-auth/recipe", `{`, http.StatusBadRequest, ""},
		{http.MethodPost, "/v1/capture/connections/c1/email-auth/test", "", http.StatusAccepted, `"attempt"`},
		{http.MethodPost, "/v1/capture/connections/c1/email-auth/enable", `{"expectedRevision":1}`, http.StatusOK, ""},
		{http.MethodPost, "/v1/capture/connections/c1/email-auth/pause", "", http.StatusOK, ""},
		{http.MethodDelete, "/v1/capture/connections/c1/email-auth", "", http.StatusOK, `"revoked":true`},
		{http.MethodGet, "/v1/capture/auth-attempts/a1", "", http.StatusOK, `"safeMessage":"Waiting."`},
		{http.MethodPost, "/v1/capture/auth-attempts/a1/cancel", "", http.StatusOK, `"cancelled":true`},
	} {
		response := configurationRequest(handler, call.method, call.path, call.body)
		if response.Code != call.status || !strings.Contains(response.Body.String(), call.contains) {
			t.Errorf("%s %s: %d %s", call.method, call.path, response.Code, response.Body.String())
		}
	}
	if config.recipe.ExpectedRevision != 1 || config.recipe.ExpectedSenders[0] != "login@acme.test" || config.enabled.ExpectedRevision != 1 || config.actor.UserID != "user-1" {
		t.Fatalf("inputs not forwarded: %+v %+v %+v", config.recipe, config.enabled, config.actor)
	}
	config.unavailable = true
	if response := configurationRequest(handler, http.MethodGet, "/v1/capture/connections/c1/email-auth", ""); response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "email_auth_unavailable") {
		t.Fatalf("unavailable: %d %s", response.Code, response.Body.String())
	}
}

func TestCaptureEmailAuthWebhookIsServiceOnlyAndPassesExactBytes(t *testing.T) {
	config := &emailAuthConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	post := func(token, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/internal/capture-auth/resend", strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	payload := `{"type":"email.received","data":{"email_id":"em_1"}}`
	body := `{"payload":"{\"type\":\"email.received\",\"data\":{\"email_id\":\"em_1\"}}","svixId":"msg_1","svixTimestamp":"1","svixSignature":"v1,abc"}`
	if response := post("wrong", body); response.Code != http.StatusUnauthorized || config.payload != "" {
		t.Fatalf("without the service token: %d", response.Code)
	}
	if response := post("secret", body); response.Code != http.StatusOK || config.payload != payload || config.headers.ID != "msg_1" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("forwarded: %d %q %+v", response.Code, config.payload, config.headers)
	}
	if response := post("secret", strings.Replace(body, "v1,abc", "bad", 1)); response.Code != http.StatusUnauthorized {
		t.Fatalf("bad signature: %d", response.Code)
	}
	if response := post("secret", `{"payload":""}`); response.Code != http.StatusBadRequest {
		t.Fatalf("empty payload: %d", response.Code)
	}
}

type unavailableConnections struct{ captureConfiguration }

func (unavailableConnections) CreateCaptureConnection(context.Context, product.Actor, product.CreateCaptureConnectionInput) (*product.CaptureConnectionRecord, error) {
	return nil, product.ErrCaptureEmailAuthUnavailable
}

func TestCaptureConnectionWithATestAddressSaysWhenEmailSignInIsOff(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &unavailableConnections{})
	response := configurationRequest(handler, http.MethodPost, "/v1/capture/connections", `{"name":"A","assignTestEmail":true}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "email_auth_unavailable") {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
}
