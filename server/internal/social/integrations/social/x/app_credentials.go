package x

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// VerifyAppCredentials checks Shots' own X app keys with app-only auth. X
// signs every user request with these keys as well as the account's token
// (OAuth 1.0a), so a refused request alone cannot say which one failed: when
// the keys are refused or cannot be checked, the account is not to blame.
func (p *Provider) VerifyAppCredentials(ctx context.Context) error {
	// The keys as the signer sends them (client.go): a stray newline that
	// breaks signing must fail here too, not pass as "the account's fault".
	key, secret := os.Getenv("X_API_KEY"), os.Getenv("X_API_SECRET")
	if strings.TrimSpace(key) == "" || strings.TrimSpace(secret) == "" {
		return fmt.Errorf("%w: X application credentials are not configured", integrations.ErrAppCredentialsRefused)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBase+"/oauth2/token",
		strings.NewReader(url.Values{"grant_type": {"client_credentials"}}.Encode()))
	if err != nil {
		return err
	}
	req.SetBasicAuth(url.QueryEscape(key), url.QueryEscape(secret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
	// A redirect is not X answering for the keys.
	client := *ssrf.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("X app credentials could not be checked: %w", err)
	}
	defer res.Body.Close()
	// Drained, so the connection is reused for the next check.
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
	switch res.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("%w (X answered %d)", integrations.ErrAppCredentialsRefused, res.StatusCode)
	}
	// A rate limit or outage says nothing about the keys.
	return fmt.Errorf("X app credentials could not be checked (status %d)", res.StatusCode)
}
