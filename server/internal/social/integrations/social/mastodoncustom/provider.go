// Package mastodoncustom connects Mastodon accounts on a verified public instance.
package mastodoncustom

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/instances"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/mastodon"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

const identifier = "mastodon-custom"

// read:accounts also works on instances predating Mastodon 4.3's profile scope.
var scopes = []string{"read:accounts", "read:search", "read:statuses", "write:statuses", "write:media"}
var accountID = regexp.MustCompile(`^[0-9]{1,80}$`)
var accountName = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)
var errConnection = errors.New("Mastodon connection could not be verified; reconnect on the selected server")

// Provider reuses Mastodon's publishing behavior, with a public-only transport
// and an instance origin checked again before every credential-bearing call.
type Provider struct {
	*mastodon.Provider
	client *http.Client
}

var (
	_ integrations.Provider      = (*Provider)(nil)
	_ integrations.PendingPoster = (*Provider)(nil)
	_ integrations.Commenter     = (*Provider)(nil)
	_ integrations.ExternalURLer = (*Provider)(nil)
)

func New() *Provider { return newProvider(ssrf.PublicClient()) }

func newProvider(client *http.Client) *Provider {
	guarded := credentialClient(client)
	return &Provider{Provider: mastodon.NewForWithClient(identifier, guarded), client: guarded}
}

func (p *Provider) Info() integrations.Info {
	info := p.Provider.Info()
	info.Identifier = identifier
	info.Name = "Mastodon instance"
	info.Scopes = append([]string(nil), scopes...)
	info.MaxConcurrentJob = 5
	return info
}

func callbackURL() string {
	return strings.TrimRight(os.Getenv("FRONTEND_URL"), "/") + "/integrations/social/" + identifier
}

// ExternalURL registers a confidential OAuth client only on the selected origin.
func (p *Provider) ExternalURL(ctx context.Context, raw string) (*integrations.ClientInformation, error) {
	origin, err := instances.Origin(raw)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"client_name": {"Screenshot Studio"}, "redirect_uris": {callbackURL()},
		"scopes": {strings.Join(scopes, " ")}, "website": {os.Getenv("FRONTEND_URL")},
	}
	var app struct {
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if err := p.requestJSON(ctx, origin+"/api/v1/apps", form, "", &app); err != nil {
		return nil, err
	}
	if !validCredential(app.ClientID) || !validCredential(app.ClientSecret) {
		return nil, errConnection
	}
	return &integrations.ClientInformation{ClientID: app.ClientID, ClientSecret: app.ClientSecret, InstanceURL: origin}, nil
}

func validateClient(client *integrations.ClientInformation) (string, error) {
	if client == nil || !validCredential(client.ClientID) || !validCredential(client.ClientSecret) {
		return "", errConnection
	}
	return instances.Origin(client.InstanceURL)
}

func validCredential(value string) bool {
	return value != "" && len(value) <= 8192 && !strings.ContainsAny(value, " \r\n\t")
}

func (p *Provider) GenerateAuthURL(_ context.Context, client *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	origin, err := validateClient(client)
	if err != nil {
		return nil, err
	}
	state, verifier := ids.Secure(32), ids.Secure(64)
	challenge := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"client_id": {client.ClientID}, "response_type": {"code"}, "redirect_uri": {callbackURL()},
		"scope": {strings.Join(scopes, " ")}, "state": {state},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"},
	}
	return &integrations.GenerateAuthURLResponse{URL: origin + "/oauth/authorize?" + query.Encode(), CodeVerifier: verifier, State: state}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, client *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	origin, err := validateClient(client)
	if err != nil {
		return nil, err
	}
	if !validCredential(params.Code) || len(params.CodeVerifier) < 43 || len(params.CodeVerifier) > 128 {
		return nil, errConnection
	}
	// Discover limits before consuming the single-use authorization code. A
	// failed public lookup must not leave an exchanged token without a record.
	capabilities, err := p.instanceCapabilities(ctx, origin)
	if err != nil {
		return nil, err
	}
	form := url.Values{
		"client_id": {client.ClientID}, "client_secret": {client.ClientSecret}, "code": {params.Code},
		"grant_type": {"authorization_code"}, "redirect_uri": {callbackURL()},
		"code_verifier": {params.CodeVerifier}, "scope": {strings.Join(scopes, " ")},
	}
	var token struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		Scope       string `json:"scope"`
	}
	if err := p.requestJSON(ctx, origin+"/oauth/token", form, "", &token); err != nil {
		return nil, err
	}
	if !validCredential(token.AccessToken) || !strings.EqualFold(token.TokenType, "Bearer") {
		return nil, errConnection
	}
	// Mastodon scopes are hierarchical: an existing broad read/write grant
	// covers the narrowly requested account, status and media permissions.
	granted := strings.Fields(token.Scope)
	for _, required := range []string{"read:accounts", "write:statuses", "write:media"} {
		found := false
		for _, scope := range granted {
			if scope == required || scope == strings.SplitN(required, ":", 2)[0] {
				found = true
			}
		}
		if !found {
			return nil, &integrations.NotEnoughScopes{Message: "Mastodon did not grant the account, status, and media permissions required to connect"}
		}
	}
	var me struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Acct        string `json:"acct"`
		Avatar      string `json:"avatar"`
		Username    string `json:"username"`
	}
	if err := p.requestJSON(ctx, origin+"/api/v1/accounts/verify_credentials", nil, token.AccessToken, &me); err != nil {
		return nil, err
	}
	if !accountID.MatchString(me.ID) || !accountName.MatchString(me.Username) || me.Acct != me.Username {
		return nil, errConnection
	}
	name := strings.TrimSpace(me.DisplayName)
	if name == "" {
		name = me.Username
	}
	avatar, parseErr := url.Parse(me.Avatar)
	if parseErr != nil || avatar.Scheme != "https" || avatar.Hostname() == "" || avatar.User != nil {
		me.Avatar = ""
	}
	key := "mastodon:" + strings.TrimPrefix(origin, "https://") + ":" + me.ID
	verification := &socialidentity.Verification{
		AccountKey: key, AccountKind: "profile", GrantedScopes: granted, Capabilities: capabilities,
	}
	if err := verification.Validate(identifier, key); err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID: key, Verification: verification,
		Name: name, AccessToken: token.AccessToken, NonExpiring: true,
		Picture: me.Avatar, Username: me.Username + "@" + strings.TrimPrefix(origin, "https://"),
	}, nil
}

// instanceURL fails closed: a missing or corrupted custom credential can never
// redirect an existing token to the operator's default Mastodon server.
func instanceURL(integration *ent.Integration) (string, error) {
	if integration == nil || integration.CustomInstanceDetails == nil {
		return "", errConnection
	}
	decrypted, err := helpers.FixedDecryption(*integration.CustomInstanceDetails)
	if err != nil {
		return "", errConnection
	}
	var details integrations.ClientInformation
	if json.Unmarshal([]byte(decrypted), &details) != nil {
		return "", errConnection
	}
	return validateClient(&details)
}

func publishingOrigin(integration *ent.Integration, posts []integrations.PostDetails) (string, error) {
	origin, err := instanceURL(integration)
	if err != nil || len(posts) == 0 {
		return "", temporalx.BadBody(identifier, "{}", "{}", errConnection.Error())
	}
	return origin, nil
}

// DeletePost deletes a status on the connection's own instance; the embedded
// default-instance delete must never reach another server.
func (p *Provider) DeletePost(ctx context.Context, integration *ent.Integration, id string) error {
	origin, err := instanceURL(integration)
	if err != nil {
		return err
	}
	return mastodon.DeleteStatus(ctx, p.client, origin, integration.Token, id)
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	origin, err := publishingOrigin(integration, posts)
	if err != nil {
		return nil, err
	}
	return p.DynamicPost(ctx, id, accessToken, origin, posts)
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	origin, err := publishingOrigin(integration, posts)
	if err != nil {
		return nil, err
	}
	return p.DynamicPostPending(ctx, id, accessToken, origin, posts)
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	origin, err := publishingOrigin(integration, posts)
	if err != nil {
		return nil, err
	}
	return p.DynamicComment(ctx, id, postID, lastCommentID, accessToken, origin, posts)
}

func validatePending(raw json.RawMessage, integration *ent.Integration) error {
	origin, err := instanceURL(integration)
	var pending mastodon.PendingData
	if err != nil || json.Unmarshal(raw, &pending) != nil || pending.URL != origin {
		return temporalx.BadBody(identifier, "{}", "{}", errConnection.Error())
	}
	return nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	if err := validatePending(raw, integration); err != nil {
		return nil, err
	}
	return p.Provider.CheckPostStatus(ctx, accessToken, raw, integration)
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	if err := validatePending(raw, integration); err != nil {
		return nil, err
	}
	return p.Provider.FinalizePost(ctx, accessToken, raw, integration)
}
