package product

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Workspace API keys as Better Auth stores them (lib/auth/server.ts): the
// key is "ss_" plus random characters, and the row holds its SHA-256 in
// unpadded base64url, the first characters in `start`, and the scopes as
// `{resource: [action]}` JSON in `permissions`.
const (
	apiKeyPrefix      = "ss_"
	apiKeyStartLength = 6
	apiKeyRandomBytes = 48
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
