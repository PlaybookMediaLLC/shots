//go:build e2e

package httpapi

import (
	"net/url"
	"os"
)

// e2eAuthorizationHost is the fake provider's host (SOCIAL_E2E_URL), so the
// social gate connects its "e2e" destinations through the real OAuth routes.
func e2eAuthorizationHost(provider string) string {
	if provider != "e2e" && provider != "youtube" && provider != "tiktok" && provider != "facebook" && provider != "pinterest" {
		return ""
	}
	endpoint, err := url.Parse(os.Getenv("SOCIAL_E2E_URL"))
	if err != nil {
		return ""
	}
	return endpoint.Host
}
