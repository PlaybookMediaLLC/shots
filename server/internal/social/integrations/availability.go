package integrations

import (
	"net/url"
	"os"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/credentialcipher"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// ConnectionAvailability reads the adapter's current environment and registry.
// This is configuration readiness only: remote grants are checked at connection.
func (m *Manager) ConnectionAvailability() socialidentity.ConnectionAvailability {
	result := socialidentity.ConnectionAvailability{Version: 1, Providers: []socialidentity.ProviderAvailability{}}
	for _, id := range socialidentity.ConnectionProviders() {
		status, _ := m.ConnectionStatus(id)
		result.Providers = append(result.Providers, socialidentity.ProviderAvailability{Provider: id, Status: status})
	}
	return result
}

// ConnectionStatus reports readiness for the product's managed providers. The
// bool is false for unrelated legacy adapters whose connection policy is unchanged.
// Start endpoints call this again before registration or generating OAuth state.
func (m *Manager) ConnectionStatus(id string) (string, bool) {
	var keys []string
	callback := os.Getenv("FRONTEND_URL")
	switch id {
	case "x":
		keys = []string{"X_API_KEY", "X_API_SECRET"}
		if value := os.Getenv("X_URL"); value != "" {
			callback = value
		}
	case "linkedin", "linkedin-page":
		keys = []string{"LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"}
		if id == "linkedin-page" && os.Getenv("PLATFORM_LINKEDIN_PAGE_CLIENT_ID") != "" {
			keys = []string{"PLATFORM_LINKEDIN_PAGE_CLIENT_ID", "PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET"}
		}
	case "tiktok":
		keys = []string{"TIKTOK_CLIENT_ID", "TIKTOK_CLIENT_SECRET"}
	case "youtube":
		keys = []string{"YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"}
	case "threads":
		keys = []string{"THREADS_APP_ID", "THREADS_APP_SECRET"}
	case "instagram":
		keys = []string{"FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"}
	case "instagram-standalone":
		keys = []string{"INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"}
	case "mastodon":
		keys = []string{"MASTODON_CLIENT_ID", "MASTODON_CLIENT_SECRET"}
		// The product's legacy callback only accepts mastodon.social. Other
		// instances use the separately verified custom-server connection.
		if origin := os.Getenv("MASTODON_URL"); origin != "" && origin != "https://mastodon.social" {
			return "not_configured", true
		}
	case "mastodon-custom":
		if os.Getenv("PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED") != "true" {
			return "disabled", true
		}
	case "bluesky":
		if os.Getenv("PLATFORM_SOCIAL_BLUESKY_ENABLED") != "true" {
			return "disabled", true
		}
	case "substack":
		return "unsupported", true
	default:
		return "", false
	}
	if m == nil || m.GetSocialIntegration(id) == nil {
		return "unsupported", true
	}
	if m.IsHiddenProvider(id) {
		return "disabled", true
	}
	if credentialcipher.ValidateKey() != nil {
		return "not_configured", true
	}
	for _, key := range keys {
		if strings.TrimSpace(os.Getenv(key)) == "" {
			return "not_configured", true
		}
	}
	if id != "bluesky" && !validConnectionOrigin(callback) {
		return "not_configured", true
	}
	return "available", true
}

func validConnectionOrigin(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || strings.TrimSpace(raw) != raw {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}
