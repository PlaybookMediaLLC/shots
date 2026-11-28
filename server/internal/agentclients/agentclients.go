// Package agentclients is the client registry of the MCP authorization server
// (RFC 026): the social backend's OAuthApp table, which the agent consent
// screen reads and the product API's /oauth endpoints register and
// authenticate against. Both backends share the database.
package agentclients

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/agentauthorization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	social "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/oauthapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
)

const (
	maxRegisteredRedirectURIs   = 20
	maxRegisteredRedirectURILen = 2000
	pruneAbandonedInterval      = time.Hour
	pruneAbandonedTimeout       = 5 * time.Second
)

// Registry implements product.AgentClients.
type Registry struct {
	client     *social.Client
	pruneMu    sync.Mutex
	pruning    bool
	lastPruned time.Time
}

// New reads clients through db, the shared PostgreSQL database.
func New(db *sql.DB) *Registry {
	return &Registry{client: social.NewClient(social.Driver(entsql.OpenDB(dialect.Postgres, db)))}
}

// FindAgentClient returns the live client with clientID, or nil.
func (r *Registry) FindAgentClient(ctx context.Context, clientID string) (*product.AgentClient, error) {
	app, err := r.client.OAuthApp.Query().Where(oauthapp.ClientID(clientID), oauthapp.DeletedAtIsNil()).First(ctx)
	if social.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var redirects []string
	if app.RedirectUris != nil && *app.RedirectUris != "" {
		if err := json.Unmarshal([]byte(*app.RedirectUris), &redirects); err != nil {
			return nil, err
		}
	}
	public := app.Dynamic && app.TokenEndpointAuthMethod != nil && *app.TokenEndpointAuthMethod == "none"
	return &product.AgentClient{ClientID: app.ClientID, Name: app.Name, RedirectURIs: redirects,
		RedirectURL: app.RedirectURL, Dynamic: app.Dynamic, Public: public}, nil
}

// Registration is an RFC 7591 dynamic client registration request. Other
// metadata a client sends is ignored.
type Registration struct {
	RedirectURIs            []string `json:"redirect_uris"`
	ClientName              *string  `json:"client_name,omitempty"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method,omitempty"`
	GrantTypes              []string `json:"grant_types,omitempty"`
}

// RegisteredClient is the RFC 7591 registration response. ClientSecret is
// returned only here; the table keeps it encrypted.
type RegisteredClient struct {
	ClientID                string   `json:"client_id"`
	ClientSecret            string   `json:"client_secret,omitempty"`
	ClientSecretExpiresAt   *int     `json:"client_secret_expires_at,omitempty"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	Scope                   string   `json:"scope"`
}

// RegistrationError is a refused registration; Code is the RFC 7591 error.
type RegistrationError struct{ Code, Description string }

func (e *RegistrationError) Error() string { return e.Description }

func invalidRedirect(description string) error {
	return &RegistrationError{Code: "invalid_redirect_uri", Description: description}
}

// browserSchemes would run in the consent page's origin instead of leaving
// it, so they can never be a redirect_uri.
var browserSchemes = []string{"javascript", "data", "blob", "file", "vbscript", "about"}

var specialSchemes = []string{"http", "https", "ws", "wss", "ftp"}

// verifiedDomains is DCR_VERIFIED_DOMAINS: the hosts web callbacks may use.
// Empty means open registration.
func verifiedDomains() []string {
	var out []string
	for _, domain := range strings.Split(os.Getenv("DCR_VERIFIED_DOMAINS"), ",") {
		if d := strings.ToLower(strings.TrimSpace(domain)); d != "" {
			out = append(out, d)
		}
	}
	return out
}

// checkRedirectURI admits https, http on loopback, and private-use schemes
// (RFC 8252 §7.1, cursor://...). Web callbacks must be on a verified domain
// when DCR_VERIFIED_DOMAINS is set.
func checkRedirectURI(uri string, verified []string) error {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme == "" || (slices.Contains(specialSchemes, u.Scheme) && u.Host == "") {
		return invalidRedirect("Invalid redirect_uri: " + uri)
	}
	if slices.Contains(browserSchemes, u.Scheme) {
		return invalidRedirect(fmt.Sprintf(`redirect_uri scheme "%s:" is not allowed`, u.Scheme))
	}
	host := strings.ToLower(u.Hostname())
	loopback := u.Scheme == "http" && slices.Contains([]string{"localhost", "127.0.0.1", "::1"}, host)
	if u.Scheme == "http" && !loopback {
		return invalidRedirect("redirect_uris must use https or a private-use scheme (http is allowed for loopback only)")
	}
	// Loopback and private-use callbacks never leave the user's machine.
	if u.Scheme != "https" || len(verified) == 0 {
		return nil
	}
	for _, domain := range verified {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return nil
		}
	}
	return invalidRedirect(fmt.Sprintf(`redirect_uri host "%s" is not a verified domain`, host))
}

// RegisterAgentClient registers a dynamic client in the OAuthApp table. A
// confidential client gets a secret, stored with the social backend's fixed
// encryption so clients registered before the move keep authenticating.
func (r *Registry) RegisterAgentClient(ctx context.Context, request Registration) (*RegisteredClient, error) {
	if len(request.RedirectURIs) == 0 {
		return nil, &RegistrationError{Code: "invalid_client_metadata", Description: "redirect_uris is required"}
	}
	if len(request.RedirectURIs) > maxRegisteredRedirectURIs {
		return nil, &RegistrationError{Code: "invalid_client_metadata", Description: fmt.Sprintf("At most %d redirect_uris are allowed", maxRegisteredRedirectURIs)}
	}
	verified := verifiedDomains()
	redirectURIs := make([]string, 0, len(request.RedirectURIs))
	for _, uri := range request.RedirectURIs {
		uri = strings.TrimSpace(uri)
		if len(uri) > maxRegisteredRedirectURILen {
			return nil, &RegistrationError{Code: "invalid_redirect_uri", Description: "redirect_uri is too long"}
		}
		if err := checkRedirectURI(uri, verified); err != nil {
			return nil, err
		}
		redirectURIs = append(redirectURIs, uri)
	}
	if len(request.GrantTypes) > 0 && !slices.Contains(request.GrantTypes, "authorization_code") {
		return nil, &RegistrationError{Code: "invalid_client_metadata", Description: "Only the authorization_code grant type is supported"}
	}
	r.maybePruneAbandoned(ctx)

	method := "client_secret_post"
	if request.TokenEndpointAuthMethod == "none" || request.TokenEndpointAuthMethod == "client_secret_basic" {
		method = request.TokenEndpointAuthMethod
	}
	out := &RegisteredClient{ClientID: "pcd_" + ids.Secure(32), ClientName: "MCP Client", RedirectURIs: redirectURIs,
		TokenEndpointAuthMethod: method, GrantTypes: []string{"authorization_code"}, ResponseTypes: []string{"code"},
		Scope: strings.Join(product.APIKeyScopes, " ")}
	if request.ClientName != nil {
		if name := []rune(strings.TrimSpace(*request.ClientName)); len(name) > 0 {
			out.ClientName = string(name[:min(len(name), 100)])
		}
	}
	var sealed *string
	if method != "none" {
		out.ClientSecret, out.ClientSecretExpiresAt = "pcs_"+ids.Secure(48), new(int)
		encrypted, err := helpers.FixedEncryption(out.ClientSecret)
		if err != nil {
			return nil, err
		}
		sealed = &encrypted
	}
	redirects, err := json.Marshal(redirectURIs)
	if err != nil {
		return nil, err
	}
	app, err := r.client.OAuthApp.Create().SetName(out.ClientName).SetRedirectURL(redirectURIs[0]).SetRedirectUris(string(redirects)).
		SetClientID(out.ClientID).SetNillableClientSecret(sealed).SetTokenEndpointAuthMethod(method).SetDynamic(true).Save(ctx)
	if err != nil {
		return nil, err
	}
	out.ClientIDIssuedAt = app.CreatedAt.Unix()
	return out, nil
}

// maybePruneAbandoned runs pruneAbandoned at most once per hour, single-flight,
// with a bounded timeout so public registration bursts cannot exhaust the DB pool.
func (r *Registry) maybePruneAbandoned(ctx context.Context) {
	now := time.Now()
	r.pruneMu.Lock()
	if r.pruning || (!r.lastPruned.IsZero() && now.Sub(r.lastPruned) < pruneAbandonedInterval) {
		r.pruneMu.Unlock()
		return
	}
	r.pruning = true
	r.lastPruned = now
	r.pruneMu.Unlock()

	go func() {
		defer func() {
			r.pruneMu.Lock()
			r.pruning = false
			r.pruneMu.Unlock()
		}()
		pruneCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), pruneAbandonedTimeout)
		defer cancel()
		_, _ = r.pruneAbandoned(pruneCtx)
	}()
}

// pruneAbandoned deletes dynamic clients nobody authorized within 30 days:
// registration precedes consent, so abandoned flows leave clients behind.
// The web consent page records its grants in agent_authorization, which the
// social backend's prune did not check.
func (r *Registry) pruneAbandoned(ctx context.Context) (int, error) {
	notConsented := func(s *entsql.Selector) {
		t := entsql.Table(agentauthorization.Table)
		s.Where(entsql.NotExists(entsql.Select(t.C(agentauthorization.FieldID)).From(t).
			Where(entsql.ColumnsEQ(t.C(agentauthorization.FieldClientID), s.C(oauthapp.FieldClientID)))))
	}
	return r.client.OAuthApp.Delete().Where(oauthapp.Dynamic(true), oauthapp.CreatedAtLT(time.Now().Add(-30*24*time.Hour)),
		oauthapp.Not(oauthapp.HasAuthorizations()), oauthapp.Not(oauthapp.HasSelfHostedAuthorizations()), notConsented).Exec(ctx)
}

// AuthenticateAgentClient reports whether secret authenticates clientID at
// the token endpoint. A public client proves itself with PKCE instead.
func (r *Registry) AuthenticateAgentClient(ctx context.Context, clientID, secret string) (bool, error) {
	app, err := r.client.OAuthApp.Query().Where(oauthapp.ClientID(clientID), oauthapp.DeletedAtIsNil()).First(ctx)
	if social.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if app.Dynamic && app.TokenEndpointAuthMethod != nil && *app.TokenEndpointAuthMethod == "none" {
		return true, nil
	}
	if secret == "" || app.ClientSecret == nil || *app.ClientSecret == "" {
		return false, nil
	}
	encrypted, err := helpers.FixedEncryption(secret)
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare([]byte(*app.ClientSecret), []byte(encrypted)) == 1, nil
}
