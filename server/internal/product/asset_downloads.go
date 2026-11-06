package product

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

const assetDownloadPurpose = "shots.asset-download.v1"
const assetDownloadDefaultLifetime = 2 * time.Minute

// How long a signed asset download URL stays valid. The browser suite proves
// that an expired URL is refused, and did it by sleeping out the default two
// minutes inside one test; PLATFORM_ASSET_DOWNLOAD_TTL lets the e2e stack ask
// for seconds instead. The ceiling keeps a misconfiguration from handing out a
// long-lived, unrevocable URL.
func assetDownloadLifetime() time.Duration {
	configured, err := time.ParseDuration(strings.TrimSpace(os.Getenv("PLATFORM_ASSET_DOWNLOAD_TTL")))
	if err != nil || configured <= 0 || configured > assetDownloadDefaultLifetime {
		return assetDownloadDefaultLifetime
	}
	return configured
}

type assetDownloadGrant struct {
	Actor     Actor  `json:"actor"`
	AssetID   string `json:"assetId"`
	ExpiresAt int64  `json:"expiresAt"`
}

// WithAssetDownloads derives a purpose-specific encryption key from the existing
// backend service secret. Grants reveal neither session IDs nor storage keys.
// Missing configuration fails closed instead of returning an unrevocable R2 URL.
func (c *Configuration) WithAssetDownloads(secret, origin string) *Configuration {
	c.assetDownloadCipher, c.assetDownloadOrigin = nil, ""
	u, err := url.Parse(origin)
	if len(secret) < 32 || err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(assetDownloadPurpose))
	block, _ := aes.NewCipher(mac.Sum(nil))
	c.assetDownloadCipher, _ = cipher.NewGCM(block)
	c.assetDownloadOrigin = u.Scheme + "://" + u.Host
	return c
}

func (c *Configuration) assetDownloadURL(actor Actor, assetID string) (string, error) {
	if c.assetDownloadCipher == nil || c.assetDownloadOrigin == "" {
		return "", ErrStorageUnavailable
	}
	actor.Display, actor.RequestID = "", ""
	grant := assetDownloadGrant{Actor: actor, AssetID: assetID, ExpiresAt: time.Now().Add(assetDownloadLifetime()).Unix()}
	token, err := c.sealAssetDownload(grant)
	if err != nil {
		return "", err
	}
	return c.assetDownloadOrigin + "/api/v1/assets/" + url.PathEscape(assetID) + "/content?downloadToken=" + token, nil
}

func (c *Configuration) sealAssetDownload(grant assetDownloadGrant) (string, error) {
	body, err := json.Marshal(grant)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, c.assetDownloadCipher.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := c.assetDownloadCipher.Seal(nonce, nonce, body, []byte(assetDownloadPurpose))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// ReadAssetDownload redeems one expiring grant through the original principal's
// current authorization. The web service's own authority cannot replace it.
func (c *Configuration) ReadAssetDownload(ctx context.Context, assetID, token, requestID string) ([]byte, string, error) {
	if c.assetDownloadCipher == nil {
		return nil, "", ErrStorageUnavailable
	}
	if len(token) > 4096 {
		return nil, "", publishing.ErrUnauthorized
	}
	sealed, err := base64.RawURLEncoding.DecodeString(token)
	n := c.assetDownloadCipher.NonceSize()
	if err != nil || len(sealed) < n+c.assetDownloadCipher.Overhead() {
		return nil, "", publishing.ErrUnauthorized
	}
	body, err := c.assetDownloadCipher.Open(nil, sealed[:n], sealed[n:], []byte(assetDownloadPurpose))
	if err != nil {
		return nil, "", publishing.ErrUnauthorized
	}
	var grant assetDownloadGrant
	now := time.Now().Unix()
	// The upper bound rejects a grant sealed with a longer lifetime than this
	// process issues, so shortening the TTL cannot be undone by an old token.
	if json.Unmarshal(body, &grant) != nil || grant.AssetID != assetID || grant.ExpiresAt <= now || grant.ExpiresAt > now+int64(assetDownloadDefaultLifetime.Seconds()) {
		return nil, "", publishing.ErrUnauthorized
	}
	grant.Actor.RequestID = requestID
	return c.ReadAsset(ctx, grant.Actor, assetID)
}

func (c *Configuration) authorizeAssetRead(ctx context.Context, actor Actor) error {
	if actor.Kind == "api_key" {
		return c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, "artifact:read")
	}
	return c.AuthorizeRead(ctx, actor)
}
