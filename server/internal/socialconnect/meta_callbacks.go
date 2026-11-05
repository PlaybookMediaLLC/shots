package socialconnect

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

var (
	// ErrInvalidSignedRequest means the callback did not prove it came from Meta.
	ErrInvalidSignedRequest = errors.New("invalid signed request")
	// ErrMetaCallbackNotConfigured means this deployment lacks the app secret.
	ErrMetaCallbackNotConfigured = errors.New("meta callback is not configured")
)

// metaAppSecrets holds the secret Meta signs each provider's callbacks with.
// Facebook Login's Instagram flow is absent: the picker doesn't offer it, and
// its callback names a Facebook user, not the Instagram account we store.
var metaAppSecrets = map[string]string{
	"instagram-standalone": "INSTAGRAM_APP_SECRET",
	"threads":              "THREADS_APP_SECRET",
}

// VerifyMetaCallback returns the account a signed deauthorize or data deletion
// request names, once its signature proves Meta sent it.
func (c *Connector) VerifyMetaCallback(provider, signedRequest string) (string, error) {
	key, supported := metaAppSecrets[provider]
	if !supported {
		return "", ErrInvalidSignedRequest
	}
	secret := os.Getenv(key)
	if strings.TrimSpace(secret) == "" {
		return "", ErrMetaCallbackNotConfigured
	}
	return signedRequestUser(signedRequest, secret)
}

// ProviderAccountIntegrationIDs finds the account's integrations in every organization.
func (c *Connector) ProviderAccountIntegrationIDs(ctx context.Context, provider, accountID string) ([]string, error) {
	return c.integrations.ProviderAccountIntegrationIDs(ctx, provider, accountID)
}

// ForgetProviderAccount erases the account's stored tokens and profile.
func (c *Connector) ForgetProviderAccount(ctx context.Context, provider, accountID string) error {
	return c.integrations.ForgetProviderAccount(ctx, provider, accountID)
}

// signedRequestUser checks Meta's <signature>.<payload> format: an HMAC-SHA256
// of the encoded payload under the app secret, both base64url encoded.
func signedRequestUser(signedRequest, secret string) (string, error) {
	signature, payload, found := strings.Cut(signedRequest, ".")
	if !found || signature == "" || payload == "" {
		return "", ErrInvalidSignedRequest
	}
	provided, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(signature, "="))
	if err != nil {
		return "", ErrInvalidSignedRequest
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return "", ErrInvalidSignedRequest
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(payload, "="))
	if err != nil {
		return "", ErrInvalidSignedRequest
	}
	// json.Number takes user_id whether Meta sends it as a string or a number.
	var request struct {
		Algorithm string      `json:"algorithm"`
		UserID    json.Number `json:"user_id"`
	}
	if err := json.Unmarshal(decoded, &request); err != nil ||
		!strings.EqualFold(request.Algorithm, "HMAC-SHA256") || request.UserID == "" {
		return "", ErrInvalidSignedRequest
	}
	return request.UserID.String(), nil
}
