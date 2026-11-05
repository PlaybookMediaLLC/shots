package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type availabilityVerifier struct {
	*fakeVerifier
	catalog                 *socialidentity.ConnectionAvailability
	err                     error
	organization, reference string
	calls                   int
}

func (v *availabilityVerifier) ConnectionAvailability(_ context.Context, organization, reference string) (*socialidentity.ConnectionAvailability, error) {
	v.organization, v.reference = organization, reference
	v.calls++
	return v.catalog, v.err
}

type availabilityStore struct {
	*fakeStore
	organization string
}

func (s *availabilityStore) Binding(ctx context.Context, organization string) (*ent.SocialTenantBinding, error) {
	s.organization = organization
	return s.fakeStore.Binding(ctx, organization)
}

type availabilityConfiguration struct {
	*fakeConfiguration
	denied bool
}

func (c *availabilityConfiguration) GetFeatureDecision(ctx context.Context, actor product.Actor, feature string) (*product.FeatureDecision, error) {
	if c.denied {
		return &product.FeatureDecision{Allowed: false, CurrentPlan: "free", RequiredPlan: "pro"}, nil
	}
	return c.fakeConfiguration.GetFeatureDecision(ctx, actor, feature)
}

func TestSocialAvailabilityScopesBindingAndCombinesRolloutGates(t *testing.T) {
	catalog := &socialidentity.ConnectionAvailability{Version: 1}
	for _, id := range socialidentity.ConnectionProviders() {
		catalog.Providers = append(catalog.Providers, socialidentity.ProviderAvailability{Provider: id, Status: "available"})
	}
	verifier := &availabilityVerifier{fakeVerifier: &fakeVerifier{}, catalog: catalog}
	store := &availabilityStore{fakeStore: &fakeStore{}}
	config := &availabilityConfiguration{fakeConfiguration: &fakeConfiguration{}}
	handler := NewWithConfiguration(store, &fakeScheduler{}, verifier, "secret", config)
	for _, enabled := range []string{"false", "true"} {
		t.Setenv("PLATFORM_SOCIAL_BLUESKY_ENABLED", enabled)
		t.Setenv("PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED", enabled)
		w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability", "")
		var result socialidentity.ConnectionAvailability
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Validate() != nil || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("catalog: %d %s", w.Code, w.Body)
		}
		for _, item := range result.Providers {
			want := "available"
			if enabled == "false" && (item.Provider == "bluesky" || item.Provider == "mastodon-custom") {
				want = "disabled"
			}
			if item.Status != want {
				t.Fatalf("gate %s: %s", item.Provider, item.Status)
			}
		}
	}
	if store.organization != "org-1" || verifier.organization != "go-org-1" || verifier.reference != "SOCIAL_API_KEY" || config.actor.OrganizationID != "org-1" {
		t.Fatal("catalog escaped original tenant")
	}
	catalog.Providers[0].Status = "disabled"
	w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability", "")
	if !strings.Contains(w.Body.String(), `"provider":"x","status":"disabled"`) {
		t.Fatal("product overrode adapter disable")
	}
	before := verifier.calls
	for _, query := range []string{"?organizationId=foreign", "?provider=x", "?unexpected=1"} {
		if w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability"+query, ""); w.Code != 400 {
			t.Fatal("query override accepted")
		}
	}
	config.denied = true
	if w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability", ""); w.Code != 403 {
		t.Fatalf("feature denial: %d", w.Code)
	}
	config.denied = false
	config.authorizationError = publishing.ErrForbidden
	if w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability", ""); w.Code != 403 {
		t.Fatalf("role denial: %d", w.Code)
	}
	if verifier.calls != before {
		t.Fatal("denied request reached adapter")
	}
}

func TestSocialAvailabilityFailsClosedForSessionAndDependencies(t *testing.T) {
	verifier := &availabilityVerifier{fakeVerifier: &fakeVerifier{}}
	store := &availabilityStore{fakeStore: &fakeStore{}}
	handler := NewWithConfiguration(store, &fakeScheduler{}, verifier, "secret", &fakeConfiguration{})
	for _, headers := range []map[string]string{
		{},
		{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-User-ID": "user-1"},
		{"Authorization": "Bearer secret", "X-Organization-ID": "org-1", "X-API-Key-ID": "api-key"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/v1/social-connection-availability", nil)
		for key, value := range headers {
			r.Header.Set(key, value)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code < 400 || verifier.calls != 0 {
			t.Fatal("sessionless request read availability")
		}
	}
	for _, tc := range []struct {
		bindingError, adapterError error
		catalog                    *socialidentity.ConnectionAvailability
	}{
		{bindingError: errors.New("private-binding-canary")},
		{adapterError: errors.New("private-provider-canary")},
		{},
		{catalog: &socialidentity.ConnectionAvailability{Version: 1}},
	} {
		store.bindingError, verifier.err, verifier.catalog = tc.bindingError, tc.adapterError, tc.catalog
		w := configurationRequest(handler, http.MethodGet, "/v1/social-connection-availability", "")
		if w.Code != 503 || strings.Contains(w.Body.String(), "canary") {
			t.Fatalf("dependency status: %d", w.Code)
		}
	}
}

type capacityConfiguration struct {
	fakeConfiguration
	actor product.Actor
}

func (c *capacityConfiguration) GetChannelCapacity(_ context.Context, actor product.Actor) (*product.ChannelCapacity, error) {
	c.actor = actor
	limit := 15
	return &product.ChannelCapacity{Held: 3, Limit: &limit}, nil
}

func TestSocialConnectionCapacity(t *testing.T) {
	config := &capacityConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodGet, "/v1/social-connection-capacity", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"held":3`) || !strings.Contains(response.Body.String(), `"limit":15`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if config.actor.OrganizationID != "org-1" {
		t.Fatalf("actor=%+v", config.actor)
	}
}
