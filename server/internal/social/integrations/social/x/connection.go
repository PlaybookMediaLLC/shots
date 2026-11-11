package x

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

const errIdentity = integrations.AuthMessage("X account identity or permissions could not be verified. Reconnect and authorize read and write access.")

var xUsername = regexp.MustCompile(`^[A-Za-z0-9_]{1,15}$`)

// connectionRequest keeps OAuth exchanges and identity checks bounded, refuses
// redirects, and never returns provider response bodies in an authentication error.
func (c *client) connectionRequest(ctx context.Context, method, endpoint string, form url.Values) ([]byte, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, nil, errIdentity
	}
	params := req.URL.Query()
	for k, values := range form {
		params[k] = append(params[k], values...)
	}
	req.Header.Set("Authorization", oauthHeader(method, req.URL.Scheme+"://"+req.URL.Host+req.URL.Path, c.token, c.secret, params))
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	httpClient := *ssrf.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, integrations.ErrRefreshUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
		return nil, nil, integrations.ErrRefreshUnavailable
	}
	if response.StatusCode == http.StatusForbidden {
		// X answers 403 client-not-enrolled or client-forbidden when Shots' app
		// lacks v2 access: every account fails that way, so none is to blame.
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
		if bytes.Contains(body, []byte("client-not-enrolled")) || bytes.Contains(body, []byte("client-forbidden")) {
			return nil, nil, fmt.Errorf("%w: X refused the app's API access", integrations.ErrAppCredentialsRefused)
		}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, errIdentity
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return nil, nil, errIdentity
	}
	return data, response.Header, nil
}

func (c *client) connectionForm(ctx context.Context, endpoint string, form url.Values) (url.Values, error) {
	data, _, err := c.connectionRequest(ctx, http.MethodPost, endpoint, form)
	if err != nil {
		return nil, err
	}
	result, err := url.ParseQuery(string(data))
	if err != nil || !validCredential(result.Get("oauth_token")) || !validCredential(result.Get("oauth_token_secret")) ||
		len(result["oauth_token"]) != 1 || len(result["oauth_token_secret"]) != 1 {
		return nil, errIdentity
	}
	return result, nil
}

func validCredential(value string) bool {
	if value == "" || len(value) > 4096 {
		return false
	}
	for _, r := range value {
		if r < 33 || r > 126 || r == ':' {
			return false
		}
	}
	return true
}

func (c *client) verifiedIdentity(ctx context.Context, expectedID string) (*integrations.AuthTokenDetails, error) {
	if !validCredential(c.token) || !validCredential(c.secret) || !socialidentity.XAccountID(expectedID) {
		return nil, errIdentity
	}
	query := url.Values{"user.fields": {"username,name,profile_image_url,subscription_type"}}
	data, headers, err := c.connectionRequest(ctx, http.MethodGet, v2("users/me")+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	var result struct {
		Data struct {
			ID               string  `json:"id"`
			Name             string  `json:"name"`
			Username         string  `json:"username"`
			ProfileImageURL  string  `json:"profile_image_url"`
			SubscriptionType *string `json:"subscription_type"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(data, &result) != nil || len(result.Errors) != 0 || result.Data.ID != expectedID ||
		strings.TrimSpace(result.Data.Name) == "" || len(result.Data.Name) > 500 || !xUsername.MatchString(result.Data.Username) {
		return nil, errIdentity
	}
	levels := headers.Values("x-access-level")
	if len(levels) != 1 {
		return nil, errIdentity
	}
	level := strings.TrimSpace(levels[0])
	capabilities := socialidentity.XVerifiedAccountLimits(level, result.Data.SubscriptionType)
	proof := &socialidentity.Verification{AccountKey: "x:" + result.Data.ID, AccountKind: "profile", GrantedScopes: []string{level},
		Capabilities: socialidentity.Capabilities{Version: 1, X: &capabilities}}
	if proof.Validate(identifier, result.Data.ID) != nil {
		return nil, errIdentity
	}
	picture := result.Data.ProfileImageURL
	if parsed, err := url.Parse(picture); err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || len(picture) > 2048 {
		picture = ""
	}
	return &integrations.AuthTokenDetails{ID: result.Data.ID, AccessToken: c.token + ":" + c.secret,
		Name: result.Data.Name, Username: result.Data.Username, Picture: picture, NonExpiring: true, Verification: proof}, nil
}
