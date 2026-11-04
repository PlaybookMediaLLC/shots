package integrations

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type availabilityProvider struct {
	Provider
	id string
}

func (p availabilityProvider) Info() Info { return Info{Identifier: p.id} }

func configuredManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("PLATFORM_SOCIAL_ENCRYPTION_KEY", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
	t.Setenv("PLATFORM_SOCIAL_BLUESKY_ENABLED", "true")
	t.Setenv("PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED", "true")
	t.Setenv("FRONTEND_URL", "https://shots.example")
	t.Setenv("X_URL", "")
	t.Setenv("MASTODON_URL", "")
	t.Setenv("HIDDEN_PROVIDERS", "")
	for _, key := range []string{"TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "X_API_KEY", "X_API_SECRET", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "THREADS_APP_ID", "THREADS_APP_SECRET", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "MASTODON_CLIENT_ID", "MASTODON_CLIENT_SECRET"} {
		t.Setenv(key, "private-configuration-canary")
	}
	var providers []Provider
	for _, id := range socialidentity.ConnectionProviders() {
		if id != "substack" {
			providers = append(providers, availabilityProvider{id: id})
		}
	}
	return NewManager(providers)
}

func TestConnectionReadinessRequiresCompleteConfiguration(t *testing.T) {
	m := configuredManager(t)
	catalog := m.ConnectionAvailability()
	if catalog.Validate() != nil {
		t.Fatal("invalid catalog")
	}
	for _, item := range catalog.Providers {
		want := "available"
		if item.Provider == "substack" {
			want = "unsupported"
		}
		if item.Status != want {
			t.Fatalf("%s: %s", item.Provider, item.Status)
		}
	}
	encoded, err := json.Marshal(catalog)
	if err != nil || strings.Contains(string(encoded), "canary") || strings.Contains(string(encoded), "CLIENT_SECRET") {
		t.Fatal("configuration leaked")
	}
	for _, tc := range []struct{ provider, key string }{
		{"tiktok", "TIKTOK_CLIENT_ID"}, {"tiktok", "TIKTOK_CLIENT_SECRET"},
		{"youtube", "YOUTUBE_CLIENT_ID"}, {"youtube", "YOUTUBE_CLIENT_SECRET"},
		{"x", "X_API_KEY"}, {"x", "X_API_SECRET"},
		{"linkedin", "LINKEDIN_CLIENT_ID"}, {"linkedin-page", "LINKEDIN_CLIENT_SECRET"},
		{"threads", "THREADS_APP_ID"}, {"threads", "THREADS_APP_SECRET"},
		{"instagram", "FACEBOOK_APP_ID"}, {"instagram", "FACEBOOK_APP_SECRET"},
		{"instagram-standalone", "INSTAGRAM_APP_ID"}, {"instagram-standalone", "INSTAGRAM_APP_SECRET"},
		{"mastodon", "MASTODON_CLIENT_ID"}, {"mastodon", "MASTODON_CLIENT_SECRET"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			t.Setenv(tc.key, "  ")
			if status, managed := m.ConnectionStatus(tc.provider); !managed || status != "not_configured" {
				t.Fatalf("missing config accepted: %s", status)
			}
		})
	}
}

func TestConnectionReadinessGatesAndOrigins(t *testing.T) {
	m := configuredManager(t)
	for _, tc := range []struct{ name, key, value, provider, want string }{
		{"encryption", "PLATFORM_SOCIAL_ENCRYPTION_KEY", "invalid", "x", "not_configured"},
		{"blue encryption", "PLATFORM_SOCIAL_ENCRYPTION_KEY", "", "bluesky", "not_configured"},
		{"blue gate", "PLATFORM_SOCIAL_BLUESKY_ENABLED", "false", "bluesky", "disabled"},
		{"custom gate", "PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED", "", "mastodon-custom", "disabled"},
		{"hidden", "HIDDEN_PROVIDERS", "threads, x ", "x", "disabled"},
		{"legacy server", "MASTODON_URL", "https://another.social", "mastodon", "not_configured"},
		{"missing callback", "FRONTEND_URL", "", "x", "not_configured"},
		{"insecure callback", "FRONTEND_URL", "http://shots.example", "threads", "not_configured"},
		{"callback userinfo", "FRONTEND_URL", "https://user:secret@shots.example", "linkedin", "not_configured"},
		{"callback path", "FRONTEND_URL", "https://shots.example/another", "instagram", "not_configured"},
		{"callback query", "FRONTEND_URL", "https://shots.example?override=1", "x", "not_configured"},
		{"local callback", "FRONTEND_URL", "http://localhost:3460", "x", "available"},
		{"local ipv6", "FRONTEND_URL", "http://[::1]:3460", "threads", "available"},
		{"invalid X override", "X_URL", "not-an-origin", "x", "not_configured"},
		{"valid X override", "X_URL", "https://callback.example", "x", "available"},
		{"blue no callback", "FRONTEND_URL", "", "bluesky", "available"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.key, tc.value)
			if status, managed := m.ConnectionStatus(tc.provider); !managed || status != tc.want {
				t.Fatalf("got %s, want %s", status, tc.want)
			}
		})
	}
	if status, managed := NewManager(nil).ConnectionStatus("x"); !managed || status != "unsupported" {
		t.Fatal("missing registration accepted")
	}
	if _, managed := m.ConnectionStatus("unrelated-provider"); managed {
		t.Fatal("legacy adapter policy changed")
	}
	var absent *Manager
	if absent.ConnectionAvailability().Validate() != nil {
		t.Fatal("nil manager produced invalid catalog")
	}
}
