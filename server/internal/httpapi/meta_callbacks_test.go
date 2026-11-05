package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialconnect"
)

type metaSocial struct {
	fakeVerifier
	verifyErr error
	forgotten string
	calls     []string
	forgetErr error
}

func (m *metaSocial) VerifyMetaCallback(provider, signedRequest string) (string, error) {
	if m.verifyErr != nil {
		return "", m.verifyErr
	}
	return "account-" + signedRequest, nil
}

func (m *metaSocial) ProviderAccountIntegrationIDs(context.Context, string, string) ([]string, error) {
	return []string{"integration-1"}, nil
}

func (m *metaSocial) ForgetProviderAccount(_ context.Context, provider, accountID string) error {
	m.calls = append(m.calls, "forget")
	m.forgotten = provider + "/" + accountID
	return m.forgetErr
}

type metaConfiguration struct {
	fakeConfiguration
	social    *metaSocial
	revoked   []string
	revokeErr error
}

func (m *metaConfiguration) RevokeProviderConnections(_ context.Context, ids []string, code string) ([]string, error) {
	m.social.calls = append(m.social.calls, "revoke")
	m.revoked = ids
	return []string{"post-9"}, m.revokeErr
}

func metaRequest(handler http.Handler, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/internal/meta-callbacks/threads", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestMetaCallbackRevokesThenForgets(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://shots.example/")
	social := &metaSocial{}
	config := &metaConfiguration{social: social}
	scheduler := &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, social, "secret", config)

	if response := metaRequest(handler, "wrong", `{"signedRequest":"a.b"}`); response.Code != http.StatusUnauthorized || len(social.calls) != 0 {
		t.Fatalf("no service token: status=%d calls=%v", response.Code, social.calls)
	}
	response := metaRequest(handler, "secret", `{"signedRequest":"a.b"}`)
	body := response.Body.String()
	if response.Code != http.StatusOK || !regexp.MustCompile(`"url":"https://shots\.example/data-deletion\?code=[A-Z2-7]+"`).MatchString(body) ||
		!strings.Contains(body, `"confirmation_code":"`) {
		t.Fatalf("status=%d body=%s", response.Code, body)
	}
	// Forgetting removes the ID that finds the connections, so it must come last.
	if strings.Join(social.calls, ",") != "revoke,forget" || social.forgotten != "threads/account-a.b" ||
		len(config.revoked) != 1 || scheduler.cancelled != "post-9" {
		t.Fatalf("calls=%v forgotten=%q revoked=%v cancelled=%q", social.calls, social.forgotten, config.revoked, scheduler.cancelled)
	}
}

func TestMetaCallbackRejectsAnUnprovenRequest(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://shots.example")
	for name, want := range map[string]struct {
		err    error
		status int
	}{
		"bad signature": {socialconnect.ErrInvalidSignedRequest, http.StatusBadRequest},
		"no app secret": {socialconnect.ErrMetaCallbackNotConfigured, http.StatusServiceUnavailable},
	} {
		social := &metaSocial{verifyErr: want.err}
		handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, social, "secret", &metaConfiguration{social: social})
		if response := metaRequest(handler, "secret", `{"signedRequest":"a.b"}`); response.Code != want.status || len(social.calls) != 0 {
			t.Errorf("%s: status=%d calls=%v", name, response.Code, social.calls)
		}
	}
}

func TestMetaCallbackDoesNotForgetWhenRevokingFails(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://shots.example")
	social := &metaSocial{}
	config := &metaConfiguration{social: social, revokeErr: errors.New("database down")}
	scheduler := &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, social, "secret", config)
	response := metaRequest(handler, "secret", `{"signedRequest":"a.b"}`)
	if response.Code < 500 || social.forgotten != "" {
		t.Fatalf("status=%d forgotten=%q: a retry could no longer find the connections", response.Code, social.forgotten)
	}
	// Posts cancelled before the failure stay cancelled, so their workflows must stop.
	if scheduler.cancelled != "post-9" {
		t.Fatalf("a cancelled post kept its workflow: %q", scheduler.cancelled)
	}
}
