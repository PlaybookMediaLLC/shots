package product

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/agentauthorization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/apikey"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// AI agents reach a workspace through the MCP server with a workspace API
// key. A key the member pastes and a key minted by OAuth consent are the same
// credential (RFC 026): this file is the consent and the code exchange.

// APIKeyScopes mirrors apiKeyScopes in lib/auth/api-key-scopes.ts.
var APIKeyScopes = []string{"artifact:read", "asset:write", "draft:comment", "draft:write", "onboarding:run", "post:delete", "post:publish", "post:schedule", "queue:write", "release:create", "source:write", "upload:sign"}

// ErrInvalidGrant is an authorization code that is unknown, expired, used,
// or presented by another client, redirect URI, or PKCE verifier.
var ErrInvalidGrant = errors.New("invalid_grant")

const (
	agentCodePrefix   = "shc_"
	agentCodeLifetime = 10 * time.Minute
)

// AgentClient is a registered OAuth client of the MCP authorization server.
type AgentClient struct {
	ClientID string
	Name     string
	// RedirectURIs are a dynamic client's registered redirect URIs.
	RedirectURIs []string
	// RedirectURL is a static client's one redirect URL.
	RedirectURL string
	Dynamic     bool
	// Public clients authenticate with PKCE instead of a secret.
	Public bool
}

// AgentClients finds OAuth clients; the social backend owns their registry.
type AgentClients interface {
	// FindAgentClient returns nil when no client has this ID.
	FindAgentClient(ctx context.Context, clientID string) (*AgentClient, error)
}

// WithAgentClients enables agent consent.
func (c *Configuration) WithAgentClients(clients AgentClients) *Configuration {
	c.agentClients = clients
	return c
}

// AgentAuthorizationRequest is an OAuth authorization request as the consent
// page received it, plus the scopes and key lifetime the member chose.
type AgentAuthorizationRequest struct {
	ClientID            string   `json:"clientId"`
	RedirectURI         string   `json:"redirectUri"`
	CodeChallenge       *string  `json:"codeChallenge"`
	CodeChallengeMethod *string  `json:"codeChallengeMethod"`
	Resource            *string  `json:"resource"`
	Scopes              []string `json:"scopes"`
	ExpiresInDays       *int     `json:"expiresInDays"`
}

// AgentConsent is what the consent page shows: the client and where the
// code will be sent.
type AgentConsent struct {
	ClientID     string `json:"clientId"`
	ClientName   string `json:"clientName"`
	RedirectURI  string `json:"redirectUri"`
	RedirectHost string `json:"redirectHost"`
}

// AgentAuthorizationCode is the single-use code and the redirect it goes to.
type AgentAuthorizationCode struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirectUri"`
}

// AgentToken is the token response: an agent-issued workspace API key.
type AgentToken struct {
	AccessToken string
	Scopes      []string
	ExpiresAt   *time.Time
}

// authorizeAgentConsent admits a signed-in owner or admin: connecting an
// agent mints an API key, which only they may create.
func (c *Configuration) authorizeAgentConsent(ctx context.Context, actor Actor) error {
	if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	return c.Authorize(ctx, actor)
}

// DescribeAgentClient validates an authorization request before consent: the
// client exists, the redirect URI is one it registered, and a public client
// sent an S256 PKCE challenge.
func (c *Configuration) DescribeAgentClient(ctx context.Context, actor Actor, request AgentAuthorizationRequest) (*AgentConsent, error) {
	if err := c.authorizeAgentConsent(ctx, actor); err != nil {
		return nil, err
	}
	if c.agentClients == nil {
		return nil, ErrStorageUnavailable
	}
	if request.ClientID == "" || len(request.ClientID) > 200 || len(request.RedirectURI) > 2000 {
		return nil, invalid("The authorization request is incomplete.")
	}
	client, err := c.agentClients.FindAgentClient(ctx, request.ClientID)
	if err != nil {
		return nil, err
	}
	if client == nil {
		return nil, invalid("This application is not registered.")
	}
	redirect := client.RedirectURL
	if client.Dynamic {
		if !slices.Contains(client.RedirectURIs, request.RedirectURI) {
			return nil, invalid("The redirect URI is not one this application registered.")
		}
		redirect = request.RedirectURI
	} else if request.RedirectURI != "" && request.RedirectURI != client.RedirectURL {
		return nil, invalid("The redirect URI is not this application's.")
	}
	parsed, err := url.Parse(redirect)
	if err != nil || parsed.Scheme == "" || slices.Contains([]string{"javascript", "data", "blob", "file", "vbscript", "about"}, parsed.Scheme) {
		return nil, invalid("The redirect URI is not allowed.")
	}
	challenge := request.CodeChallenge != nil && *request.CodeChallenge != ""
	if client.Public && !challenge {
		return nil, invalid("This application must send a PKCE code challenge.")
	}
	if challenge && (request.CodeChallengeMethod == nil || *request.CodeChallengeMethod != "S256") {
		return nil, invalid("Only the S256 PKCE method is supported.")
	}
	host := parsed.Host
	if host == "" {
		host = parsed.Scheme + ":"
	}
	return &AgentConsent{ClientID: client.ClientID, ClientName: client.Name, RedirectURI: redirect, RedirectHost: host}, nil
}

// ApproveAgentAccess records a member's consent and returns a code the
// client exchanges, once and within ten minutes, for a workspace API key
// holding exactly the approved scopes.
func (c *Configuration) ApproveAgentAccess(ctx context.Context, actor Actor, request AgentAuthorizationRequest) (*AgentAuthorizationCode, error) {
	consent, err := c.DescribeAgentClient(ctx, actor, request)
	if err != nil {
		return nil, err
	}
	scopes := slices.Clone(request.Scopes)
	slices.Sort(scopes)
	scopes = slices.Compact(scopes)
	if len(scopes) == 0 {
		return nil, invalid("Choose at least one scope.")
	}
	for _, scope := range scopes {
		if !slices.Contains(APIKeyScopes, scope) {
			return nil, invalid(fmt.Sprintf("%s is not an API key scope.", scope))
		}
	}
	if request.ExpiresInDays != nil && (*request.ExpiresInDays < 1 || *request.ExpiresInDays > 365) {
		return nil, invalid("A key expires after 1 to 365 days.")
	}
	if request.Resource != nil && (len(*request.Resource) > 2000 || *request.Resource == "") {
		return nil, invalid("The resource indicator is invalid.")
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	code := agentCodePrefix + base64.RawURLEncoding.EncodeToString(random)
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	id := cuid.New()
	if _, err := tx.AgentAuthorization.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetUserID(actor.UserID).
		SetClientID(consent.ClientID).SetClientName(truncateRunes(consent.ClientName, 120)).SetRedirectURI(consent.RedirectURI).
		SetCodeHash(hashAgentCode(code)).SetNillableCodeChallenge(request.CodeChallenge).
		SetNillableCodeChallengeMethod(request.CodeChallengeMethod).SetScopes(scopes).SetNillableResource(request.Resource).
		SetNillableKeyExpiresInDays(request.ExpiresInDays).SetExpiresAt(time.Now().UTC().Add(agentCodeLifetime)).
		Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.agent_access_granted", "agent_authorization", id,
		map[string]any{"clientId": consent.ClientID, "clientName": consent.ClientName, "scopes": scopes}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &AgentAuthorizationCode{Code: code, RedirectURI: consent.RedirectURI}, nil
}

// ExchangeAgentCode trades a consent code for its workspace API key. The
// token endpoint has already authenticated clientID. A code that was already
// exchanged disables the key it produced: a replayed code means it leaked.
func (c *Configuration) ExchangeAgentCode(ctx context.Context, clientID, code, codeVerifier, redirectURI string) (*AgentToken, error) {
	if !strings.HasPrefix(code, agentCodePrefix) || len(code) > 128 {
		return nil, ErrInvalidGrant
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	grant, err := tx.AgentAuthorization.Query().Where(agentauthorization.CodeHash(hashAgentCode(code))).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, ErrInvalidGrant
	}
	if err != nil {
		return nil, err
	}
	if grant.ExchangedAt != nil {
		if grant.APIKeyID != nil {
			if err := tx.Apikey.Update().Where(apikey.ID(*grant.APIKeyID), apikey.ReferenceID(grant.OrganizationID)).
				SetEnabled(false).SetUpdatedAt(time.Now().UTC()).Exec(ctx); err != nil {
				return nil, err
			}
			if err := tx.Commit(); err != nil {
				return nil, err
			}
		}
		return nil, ErrInvalidGrant
	}
	if subtle.ConstantTimeCompare([]byte(grant.ClientID), []byte(clientID)) != 1 ||
		!time.Now().UTC().Before(grant.ExpiresAt) || (redirectURI != "" && redirectURI != grant.RedirectURI) ||
		!verifierMatches(grant.CodeChallenge, codeVerifier) {
		return nil, ErrInvalidGrant
	}
	var expiresAt *time.Time
	if grant.KeyExpiresInDays != nil {
		at := time.Now().UTC().AddDate(0, 0, *grant.KeyExpiresInDays)
		expiresAt = &at
	}
	key, row, err := mintAPIKey(ctx, tx, grant.OrganizationID, truncateRunes(grant.ClientName+" (AI agent)", 100), grant.Scopes,
		expiresAt, agentKeyMetadata{ClientID: grant.ClientID, ClientName: grant.ClientName, GrantID: grant.ID, Source: "agent"})
	if err != nil {
		return nil, err
	}
	claimed, err := tx.AgentAuthorization.Update().Where(agentauthorization.ID(grant.ID), agentauthorization.ExchangedAtIsNil()).
		SetExchangedAt(time.Now().UTC()).SetAPIKeyID(row.ID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if claimed != 1 {
		return nil, ErrInvalidGrant
	}
	// The member who consented is the actor of record for the key.
	consenter := Actor{OrganizationID: grant.OrganizationID, UserID: grant.UserID, Display: grant.ClientName}
	if err := appendConfigurationAudit(ctx, tx, consenter, "product.api_key_created", "api_key", row.ID,
		map[string]any{"clientId": grant.ClientID, "grantId": grant.ID, "scopes": grant.Scopes, "source": "agent"}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &AgentToken{AccessToken: key, Scopes: grant.Scopes, ExpiresAt: expiresAt}, nil
}

func hashAgentCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return hex.EncodeToString(sum[:])
}

// verifierMatches checks an S256 PKCE verifier. A grant without a challenge
// came from a confidential client, which proved itself with its secret.
func verifierMatches(challenge *string, verifier string) bool {
	if challenge == nil || *challenge == "" {
		return true
	}
	sum := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(sum[:])
	return verifier != "" && subtle.ConstantTimeCompare([]byte(computed), []byte(*challenge)) == 1
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}
