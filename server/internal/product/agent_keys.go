package product

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Workspace API keys as Better Auth stores them (lib/auth/server.ts): the
// key is "ss_" plus random characters, and the row holds its SHA-256 in
// unpadded base64url, the first characters in `start`, and the scopes as
// `{resource: [action]}` JSON in `permissions`.
const (
	apiKeyPrefix              = "ss_"
	apiKeyStartLength         = 6
	apiKeyRandomBytes         = 48
	apiKeyLastRequestInterval = 5 * time.Minute
	apiKeyTouchTimeout        = 250 * time.Millisecond
	apiKeyTouchCacheCap       = 4096
)

var (
	apiKeyTouchMu    sync.Mutex
	apiKeyTouchCache = map[string]time.Time{}
)

// AgentKey is a verified workspace API key: the principal behind an MCP call.
type AgentKey struct {
	ID             string
	OrganizationID string
	Display        string
	// Scopes are the API-key scopes, such as artifact:read.
	Scopes []string
	// ClientName is the OAuth client an agent-issued key was minted for, "" otherwise.
	ClientName string
}

// CurrentAPIKeyInfo describes the calling workspace API key and its workspace
// for CLI setup and REST credential checks, with zero secret fields.
type CurrentAPIKeyInfo struct {
	Key       APIKeySummary        `json:"key"`
	Workspace APIKeyWorkspaceBrief `json:"workspace"`
}

// APIKeySummary is the redacted identity and scope set of one API key.
type APIKeySummary struct {
	ID        string     `json:"id"`
	Name      *string    `json:"name"`
	Prefix    *string    `json:"prefix"`
	Start     *string    `json:"start"`
	Scopes    []string   `json:"scopes"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

// APIKeyWorkspaceBrief names the workspace an API key belongs to.
type APIKeyWorkspaceBrief struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

// Actor is the principal domain operations authorize against.
func (k *AgentKey) Actor(requestID string) Actor {
	return Actor{Kind: "api_key", KeyID: k.ID, OrganizationID: k.OrganizationID, Display: k.Display, RequestID: requestID}
}

// HasScope reports whether the key was issued with scope.
func (k *AgentKey) HasScope(scope string) bool { return slices.Contains(k.Scopes, scope) }

type agentKeyMetadata struct {
	ClientID   string `json:"clientId,omitempty"`
	ClientName string `json:"clientName,omitempty"`
	GrantID    string `json:"grantId,omitempty"`
	Source     string `json:"source,omitempty"`
}

func hashAPIKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// scopesOf turns Better Auth's permission JSON into scopes: {"release":["create"]}
// is release:create.
func scopesOf(permissions *string) []string {
	var parsed map[string][]string
	if permissions == nil || json.Unmarshal([]byte(*permissions), &parsed) != nil {
		return nil
	}
	scopes := []string{}
	for resource, actions := range parsed {
		for _, action := range actions {
			scopes = append(scopes, resource+":"+action)
		}
	}
	slices.Sort(scopes)
	return scopes
}

func permissionsOf(scopes []string) string {
	parsed := map[string][]string{}
	for _, scope := range scopes {
		resource, action, _ := strings.Cut(scope, ":")
		parsed[resource] = append(parsed[resource], action)
	}
	data, _ := json.Marshal(parsed)
	return string(data)
}

// VerifyAPIKey resolves a raw workspace API key. An unknown, disabled, or
// expired key, or one whose workspace is being deleted, is ErrUnauthorized
// or ErrForbidden, exactly as the REST API refuses it.
func (c *Configuration) VerifyAPIKey(ctx context.Context, key string) (*AgentKey, error) {
	if !strings.HasPrefix(key, apiKeyPrefix) || len(key) > 256 {
		return nil, publishing.ErrUnauthorized
	}
	row, err := c.client.Apikey.Query().Where(apikey.Key(hashAPIKey(key))).Only(ctx)
	if ent.IsNotFound(err) || ent.IsNotSingular(err) {
		return nil, publishing.ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if err := c.auth.AuthorizeVerifiedAPIKey(ctx, row); err != nil {
		return nil, err
	}
	c.touchAPIKeyLastRequest(ctx, row)
	display := "Organization API key"
	if row.Name != nil && *row.Name != "" {
		display = *row.Name
	} else if row.Start != nil {
		display = *row.Start
	}
	var metadata agentKeyMetadata
	if row.Metadata != nil {
		_ = json.Unmarshal([]byte(*row.Metadata), &metadata)
	}
	return &AgentKey{ID: row.ID, OrganizationID: row.ReferenceID, Display: display, Scopes: scopesOf(row.Permissions),
		ClientName: metadata.ClientName}, nil
}

// touchAPIKeyLastRequest records recent MCP activity with a 5-minute debounce
// (both in-process per key and conditionally in SQL) so parallel agent tool
// bursts never stampede row locks on the apikey table.
func (c *Configuration) touchAPIKeyLastRequest(ctx context.Context, row *ent.Apikey) {
	now := time.Now().UTC()
	if row.LastRequest != nil && now.Sub(*row.LastRequest) < apiKeyLastRequestInterval {
		return
	}
	apiKeyTouchMu.Lock()
	if prev, ok := apiKeyTouchCache[row.ID]; ok && now.Sub(prev) < apiKeyLastRequestInterval {
		apiKeyTouchMu.Unlock()
		return
	}
	if len(apiKeyTouchCache) >= apiKeyTouchCacheCap {
		cutoff := now.Add(-apiKeyLastRequestInterval)
		for k, ts := range apiKeyTouchCache {
			if ts.Before(cutoff) {
				delete(apiKeyTouchCache, k)
			}
		}
		if len(apiKeyTouchCache) >= apiKeyTouchCacheCap {
			apiKeyTouchCache = map[string]time.Time{}
		}
	}
	apiKeyTouchCache[row.ID] = now
	apiKeyTouchMu.Unlock()

	touchCtx, cancel := context.WithTimeout(ctx, apiKeyTouchTimeout)
	defer cancel()
	cutoff := now.Add(-apiKeyLastRequestInterval)
	_, _ = c.client.Apikey.Update().
		Where(
			apikey.ID(row.ID),
			apikey.ReferenceID(row.ReferenceID),
			apikey.Or(apikey.LastRequestIsNil(), apikey.LastRequestLT(cutoff)),
		).
		SetLastRequest(now).
		Save(touchCtx)
}

// GetCurrentAPIKeyInfo returns redacted metadata about the calling API key and
// its workspace. Session callers are refused because this endpoint describes
// an API key credential.
func (c *Configuration) GetCurrentAPIKeyInfo(ctx context.Context, actor Actor) (*CurrentAPIKeyInfo, error) {
	if actor.Kind != "api_key" || actor.KeyID == "" {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Apikey.Query().
		Where(apikey.ID(actor.KeyID), apikey.ReferenceID(actor.OrganizationID)).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	org, err := c.client.Organization.Query().
		Where(organization.ID(actor.OrganizationID)).
		Select(organization.FieldID, organization.FieldName, organization.FieldSlug).
		Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	scopes := scopesOf(row.Permissions)
	if scopes == nil {
		scopes = []string{}
	}
	return &CurrentAPIKeyInfo{
		Key: APIKeySummary{
			ID:        row.ID,
			Name:      row.Name,
			Prefix:    row.Prefix,
			Start:     row.Start,
			Scopes:    scopes,
			ExpiresAt: row.ExpiresAt,
		},
		Workspace: APIKeyWorkspaceBrief{
			ID:   org.ID,
			Name: org.Name,
			Slug: org.Slug,
		},
	}, nil
}

// mintAPIKey creates a workspace API key in tx and returns the raw key, which
// exists only in this return value.
func mintAPIKey(ctx context.Context, tx *ent.Tx, organizationID, name string, scopes []string,
	expiresAt *time.Time, metadata agentKeyMetadata) (string, *ent.Apikey, error) {
	random := make([]byte, apiKeyRandomBytes)
	if _, err := rand.Read(random); err != nil {
		return "", nil, err
	}
	key := apiKeyPrefix + base64.RawURLEncoding.EncodeToString(random)
	encodedMetadata, _ := json.Marshal(metadata)
	now := time.Now().UTC()
	row, err := tx.Apikey.Create().SetID(cuid.New()).SetName(name).SetStart(key[:apiKeyStartLength]).
		SetPrefix(apiKeyPrefix).SetKey(hashAPIKey(key)).SetReferenceID(organizationID).SetEnabled(true).
		SetPermissions(permissionsOf(scopes)).SetMetadata(string(encodedMetadata)).SetNillableExpiresAt(expiresAt).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx)
	if err != nil {
		return "", nil, err
	}
	return key, row, nil
}
