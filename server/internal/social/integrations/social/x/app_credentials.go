package x

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// VerifyAppCredentials checks Shots' own X app keys with app-only auth. X
// signs every user request with these keys as well as the account's token
// (OAuth 1.0a), so a refused request alone cannot say which one failed: when
// the keys are refused or cannot be checked, the account is not to blame.
func (p *Provider) VerifyAppCredentials(ctx context.Context) error {
	key, secret := strings.TrimSpace(os.Getenv("X_API_KEY")), strings.TrimSpace(os.Getenv("X_API_SECRET"))
	if key == "" || secret == "" {
		return errors.New("X application credentials are not configured")
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
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return fmt.Errorf("X app credentials could not be checked: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("X refused the app credentials (status %d)", res.StatusCode)
	}
	return nil
}
