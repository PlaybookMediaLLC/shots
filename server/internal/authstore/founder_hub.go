package authstore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// ConfigureFounderHubWeb replaces the fixed client's redirect allowlist without enabling a disabled client.
func ConfigureFounderHubWeb(ctx context.Context, db executor, origin string) error {
	redirects := []string{
		"anarlog://auth/callback", "anarlog-dev://auth/callback",
		"anarlog-staging://auth/callback", "anarlog-nightly://auth/callback",
		"http://127.0.0.1/auth/callback",
	}
	if origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" ||
			(parsed.Path != "" && parsed.Path != "/") || strings.ContainsAny(origin, "#*") ||
			(parsed.Scheme != "https" && !(parsed.Scheme == "http" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"))) {
			return fmt.Errorf("FOUNDER_HUB_WEB_ORIGIN must be an HTTPS origin or an explicit loopback HTTP origin")
		}
		parsed.Path = "/callback/shots/"
		parsed.RawPath = ""
		redirects = append(redirects, parsed.String())
	}
	encoded, err := json.Marshal(redirects)
	if err != nil {
		return err
	}
	result, err := db.ExecContext(ctx, `UPDATE "oauthClient" SET "redirectUris"=$1 WHERE id='platform-founder-hub' AND "clientId"='shots-founder-hub'`, string(encoded))
	if err != nil {
		return fmt.Errorf("configure Founder Hub redirects: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return fmt.Errorf("Founder Hub OAuth client is missing; apply platform migrations first")
	}
	return nil
}
