// Package googleapi is the slice of googleapis / google-auth-library the
// YouTube and Google My Business providers use, called over plain HTTP:
// OAuth2Client (generateAuthUrl, getToken, refreshAccessToken, getTokenInfo),
// oauth2 v2 userinfo, and the gaxios request/retry behavior behind them.
package googleapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// Endpoints (OAuth2Client statics and the oauth2 v2 root). Tests point them
// at an httptest server.
var (
	AuthURL      = "https://accounts.google.com/o/oauth2/v2/auth"
	TokenURL     = "https://oauth2.googleapis.com/token"
	TokenInfoURL = "https://oauth2.googleapis.com/tokeninfo"
	UserInfoURL  = "https://www.googleapis.com/oauth2/v2/userinfo"
	// RetryUnit scales gaxios' retry backoff ((2^n-1)/2 seconds).
	RetryUnit = time.Second
)

// Error is a failed Google call (GaxiosError). Body is the raw response, so
// handleErrors and refreshErrorMessage can match on it.
type Error struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

func (e *Error) Error() string {
	return fmt.Sprintf("Request failed with status code %d: %s", e.Status, e.Body)
}

// EncodeURIComponent is JavaScript's encodeURIComponent (and Node's
// querystring.escape).
func EncodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").
		Replace(url.QueryEscape(s))
}

// Do sends a request and decodes a 2xx JSON answer into out (when non-nil).
// Like gaxios with retry enabled, 408, 429 and 5xx answers and transport
// errors are retried three times with exponential backoff.
func Do(ctx context.Context, method, rawURL, accessToken, contentType string, body []byte, out any) error {
	for attempt := 0; ; attempt++ {
		err := do(ctx, method, rawURL, accessToken, contentType, body, out)
		if err == nil || attempt >= 3 || !retryable(err) {
			return err
		}
		delay := time.Duration(float64(RetryUnit) * (float64(int(1)<<(attempt+1)) - 1) / 2)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

func retryable(err error) bool {
	e, ok := err.(*Error)
	if !ok {
		return true // transport error
	}
	return e.Status == 408 || e.Status == 429 || (e.Status >= 500 && e.Status <= 599)
}

func do(ctx context.Context, method, rawURL, accessToken, contentType string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return err
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return Send(req, out)
}

// Send runs a prepared request (no retry) and decodes a 2xx JSON answer.
func Send(req *http.Request, out any) error {
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return &Error{Status: res.StatusCode, Body: string(data)}
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// OAuth2Client is google.auth.OAuth2 for one app.
type OAuth2Client struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

// GenerateAuthURL is generateAuthUrl({access_type: 'offline', prompt:
// 'consent', state, redirect_uri, scope}); parameters keep the library's order.
func (c OAuth2Client) GenerateAuthURL(state string, scopes []string) string {
	pairs := [][2]string{
		{"access_type", "offline"},
		{"prompt", "consent"},
		{"state", state},
		{"redirect_uri", c.RedirectURI},
		{"scope", strings.Join(scopes, " ")},
		{"response_type", "code"},
		{"client_id", c.ClientID},
	}
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = EncodeURIComponent(p[0]) + "=" + EncodeURIComponent(p[1])
	}
	return AuthURL + "?" + strings.Join(parts, "&")
}

// Tokens is the token endpoint answer.
type Tokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (c OAuth2Client) token(ctx context.Context, form [][2]string) (*Tokens, error) {
	parts := make([]string, len(form))
	for i, p := range form {
		parts[i] = EncodeURIComponent(p[0]) + "=" + EncodeURIComponent(p[1])
	}
	var tokens Tokens
	if err := Do(ctx, http.MethodPost, TokenURL, "", "application/x-www-form-urlencoded", []byte(strings.Join(parts, "&")), &tokens); err != nil {
		return nil, err
	}
	return &tokens, nil
}

// GetToken exchanges an authorization code (client.getToken(code)).
func (c OAuth2Client) GetToken(ctx context.Context, code string) (*Tokens, error) {
	return c.token(ctx, [][2]string{
		{"client_id", c.ClientID},
		{"code", code},
		{"grant_type", "authorization_code"},
		{"redirect_uri", c.RedirectURI},
		{"client_secret", c.ClientSecret},
	})
}

// RefreshAccessToken is client.refreshAccessToken() with only a refresh token set.
func (c OAuth2Client) RefreshAccessToken(ctx context.Context, refreshToken string) (*Tokens, error) {
	return c.token(ctx, [][2]string{
		{"refresh_token", refreshToken},
		{"client_id", c.ClientID},
		{"client_secret", c.ClientSecret},
		{"grant_type", "refresh_token"},
	})
}

// GetTokenScopes is client.getTokenInfo(accessToken).scopes.
func GetTokenScopes(ctx context.Context, accessToken string) ([]string, error) {
	var info struct {
		Scope string `json:"scope"`
	}
	if err := Do(ctx, http.MethodPost, TokenInfoURL, accessToken, "application/x-www-form-urlencoded;charset=UTF-8", nil, &info); err != nil {
		return nil, err
	}
	return strings.Split(info.Scope, " "), nil
}

// UserInfo is oauth2 v2 userinfo.get().
type UserInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Picture string `json:"picture"`
}

func GetUserInfo(ctx context.Context, accessToken string) (*UserInfo, error) {
	var user UserInfo
	if err := Do(ctx, http.MethodGet, UserInfoURL, accessToken, "", nil, &user); err != nil {
		return nil, err
	}
	return &user, nil
}
