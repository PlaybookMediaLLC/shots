// Package socialconnect connects social channels inside the product API. It
// runs the social public API's connection routes (social/:integration,
// integrations, integrations/:id/identity, connection-availability,
// social-connect and provider page selection) without the social-api process.
// A tenant's social organization comes from its binding, not an API key.
package socialconnect

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	productent "github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialtenantbinding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/credentialcipher"
	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/organizations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/instances"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/redis"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/upload"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Tenants resolves social organizations from the product's tenant bindings.
type Tenants interface {
	// Organization is the social organization bound to a secret reference.
	Organization(ctx context.Context, secretReference string) (string, error)
	// StateOrganization is the social organization of the tenant whose OAuth
	// attempt owns state.
	StateOrganization(ctx context.Context, state string) (string, error)
}

// EntTenants reads bindings and OAuth attempts from the product database.
type EntTenants struct{ Client *productent.Client }

// Organization implements Tenants.
func (t EntTenants) Organization(ctx context.Context, secretReference string) (string, error) {
	binding, err := t.Client.SocialTenantBinding.Query().Where(socialtenantbinding.SecretReference(secretReference)).Only(ctx)
	if err != nil {
		return "", err
	}
	return binding.GoOrganizationID, nil
}

// StateOrganization implements Tenants.
func (t EntTenants) StateOrganization(ctx context.Context, state string) (string, error) {
	start, err := t.Client.SocialOAuthStart.Get(ctx, state)
	if err != nil {
		return "", err
	}
	return t.Organization(ctx, start.SecretReference)
}

// Connector satisfies the product API's social connection interfaces in process.
type Connector struct {
	tenants       Tenants
	manager       *integrations.Manager
	integrations  *integration.Service
	organizations *organizations.Repository
	store         redis.Store
}

// Open reads social tables from the product database and OAuth state from
// REDIS_URL (in memory when unset). The caller owns the close function.
func Open(ctx context.Context, databaseURL string, product *productent.Client) (*Connector, func() error, error) {
	db, err := socialdatabase.Open(ctx, databaseURL)
	if err != nil {
		return nil, nil, err
	}
	store, err := redis.New()
	if err != nil {
		db.Close()
		return nil, nil, err
	}
	storage, err := upload.CreateStorage()
	if err != nil {
		db.Close()
		return nil, nil, err
	}
	manager := social.NewManager(notifications.New(db.SQL, nil))
	return &Connector{
		tenants: EntTenants{Client: product}, manager: manager, store: store,
		integrations:  integration.NewService(integration.NewRepository(db.Client, storage), nil, manager, nil, nil, store, storage),
		organizations: organizations.NewRepository(db.Client),
	}, db.Close, nil
}

var errMismatch = socialapi.NewError(http.StatusConflict, false, "social organization does not match this workspace")

// organization is the public API's API-key check: the reference's binding
// must name the expected organization.
func (c *Connector) organization(ctx context.Context, secretReference, expected string) (string, error) {
	organization, err := c.tenants.Organization(ctx, secretReference)
	if err != nil || organization == "" || organization != expected {
		return "", errMismatch
	}
	return organization, nil
}

// stateOrganization is the organization a begin stored for state; it must
// belong to the tenant whose OAuth attempt owns state.
func (c *Connector) stateOrganization(ctx context.Context, state string) (*ent.Organization, error) {
	stored, _, err := c.store.Get(ctx, "organization:"+state)
	if err != nil {
		return nil, err
	}
	expected, err := c.tenants.StateOrganization(ctx, state)
	if err != nil || stored == "" || stored != expected {
		return nil, errMismatch
	}
	org, err := c.organizations.GetOrgByID(ctx, stored)
	if err != nil {
		return nil, err
	}
	if org == nil {
		return nil, errors.New("organization not found")
	}
	return org, nil
}

// authURL is GET social/:integration: it stores the attempt's state for an hour.
func (c *Connector) authURL(ctx context.Context, organization, name, refresh, instance string) (string, error) {
	if err := credentialcipher.ValidateKey(); err != nil {
		return "", socialapi.NewError(http.StatusServiceUnavailable, false, "social credential storage is unavailable")
	}
	if !slices.Contains(c.manager.GetAllowedSocialsIntegrations(), name) {
		return "", socialapi.NewError(http.StatusBadRequest, false, "integration not allowed")
	}
	// A provider migrated via MIGRATE_PROVIDERS reconnects through its target.
	target := name
	if refresh != "" {
		if migrateTo := c.manager.GetMigrationTarget(name); migrateTo != "" {
			target = migrateTo
		}
	}
	if status, managed := c.manager.ConnectionStatus(target); managed && status != "available" {
		return "", socialapi.NewError(http.StatusServiceUnavailable, false, "this social connection is not available")
	}
	provider := c.manager.GetSocialIntegration(target)
	if provider == nil {
		return "", socialapi.NewError(http.StatusBadRequest, false, "integration not allowed")
	}
	var client *integrations.ClientInformation
	if external, ok := provider.(integrations.ExternalURLer); ok {
		origin, err := instances.Origin(instance)
		if err != nil {
			return "", socialapi.NewError(http.StatusBadRequest, false, instances.ErrInvalidOrigin.Error())
		}
		if client, err = external.ExternalURL(ctx, origin); err != nil {
			return "", err
		}
		if client == nil || client.ClientID == "" || client.ClientSecret == "" {
			return "", errors.New("instance registration did not return credentials")
		}
		client.InstanceURL = origin
	} else if instance != "" {
		return "", socialapi.NewError(http.StatusBadRequest, false, "this integration does not accept an instance server")
	}
	generated, err := provider.GenerateAuthURL(ctx, client)
	if err != nil {
		return "", err
	}
	if generated == nil || generated.State == "" || generated.CodeVerifier == "" || generated.URL == "" {
		return "", errors.New("provider returned incomplete authorization state")
	}
	values := [][2]string{}
	if client != nil {
		data, err := json.Marshal(client)
		if err != nil {
			return "", err
		}
		sealed, err := credentialcipher.Seal(string(data), "oauth-external:"+generated.State)
		if err != nil {
			return "", err
		}
		values = append(values, [2]string{"external:", sealed})
	}
	if refresh != "" {
		values = append(values, [2]string{"refresh:", refresh})
	}
	values = append(values, [2]string{"organization:", organization}, [2]string{"connection-provider:", target},
		[2]string{"login:", generated.CodeVerifier})
	for _, value := range values {
		if err := c.store.Set(ctx, value[0]+generated.State, value[1], time.Hour); err != nil {
			return "", err
		}
	}
	return generated.URL, nil
}

// BeginOAuth returns the provider's authorization URL.
func (c *Connector) BeginOAuth(ctx context.Context, input socialapi.BeginOAuthInput) (string, error) {
	organization, err := c.organization(ctx, input.SecretReference, input.ExpectedGoOrganizationID)
	if err != nil {
		return "", err
	}
	return c.authURL(ctx, organization, input.Provider, "", input.InstanceOrigin)
}

// BeginBluesky returns an opaque one-use credential state. A reconnect must
// keep the original account's native identity.
func (c *Connector) BeginBluesky(ctx context.Context, input socialapi.BeginBlueskyInput) (string, error) {
	organization, err := c.organization(ctx, input.SecretReference, input.ExpectedGoOrganizationID)
	if err != nil {
		return "", err
	}
	refresh := ""
	if input.ExpectedDestinationID != "" {
		account, err := c.identity(ctx, organization, input.ExpectedDestinationID)
		if err != nil {
			return "", err
		}
		if account.ID != input.ExpectedDestinationID || account.Provider != "bluesky" || !socialidentity.BlueskyDID(account.NativeID) {
			return "", socialapi.NewError(http.StatusConflict, false, "the original Bluesky account could not be verified")
		}
		refresh = account.NativeID
	}
	return c.authURL(ctx, organization, "bluesky", refresh, "")
}

// ExchangeBluesky connects a Bluesky account with its app password.
func (c *Connector) ExchangeBluesky(ctx context.Context, state, handle, password string) (socialapi.OAuthExchange, error) {
	data, err := json.Marshal(map[string]string{"identifier": handle, "password": password})
	if err != nil {
		return socialapi.OAuthExchange{}, err
	}
	return c.ExchangeOAuth(ctx, "bluesky", base64.StdEncoding.EncodeToString(data), state)
}

var errExpired = socialapi.NewError(http.StatusBadRequest, false, "This connection link expired or was already used, please connect the channel again")

func scopes(message string) error { return socialapi.NewError(http.StatusConflict, false, message) }

// ExchangeOAuth is POST /integrations/social-connect/:integration: it
// consumes the attempt's state and saves the connected account.
func (c *Connector) ExchangeOAuth(ctx context.Context, name, code, state string) (socialapi.OAuthExchange, error) {
	fail := socialapi.OAuthExchange{}
	if !slices.Contains(c.manager.GetAllowedSocialsIntegrations(), name) {
		return fail, socialapi.NewError(http.StatusBadRequest, false, "integration not allowed")
	}
	if err := credentialcipher.ValidateKey(); err != nil {
		return fail, err
	}
	provider := c.manager.GetSocialIntegration(name)
	_, hasCustomFields := provider.(integrations.CustomFielder)
	_, isExternal := provider.(integrations.ExternalURLer)
	info := provider.Info()

	bound, _, err := c.store.Get(ctx, "connection-provider:"+state)
	if err != nil {
		return fail, err
	}
	if bound != name {
		return fail, errExpired
	}
	org, err := c.stateOrganization(ctx, state)
	if err != nil {
		return fail, err
	}
	// Consume before touching any provider or per-attempt credential state.
	codeVerifier, _, err := c.store.Take(ctx, "login:"+state)
	if err != nil {
		return fail, err
	}
	if codeVerifier == "" {
		return fail, errExpired
	}
	details := ""
	if isExternal {
		if details, _, err = c.store.Take(ctx, "external:"+state); err != nil {
			return fail, err
		}
		if details, err = credentialcipher.Open(details, "oauth-external:"+state); err != nil {
			return fail, err
		}
	}
	refresh, _, err := c.store.Take(ctx, "refresh:"+state)
	if err != nil {
		return fail, err
	}

	auth := authenticate(ctx, name, provider, code, codeVerifier, details, refresh)
	if auth.Error != "" {
		return fail, scopes(auth.Error)
	}
	if auth.ID == "" {
		return fail, scopes("Invalid API key")
	}
	if auth.CredentialDetails != nil && refresh != "" && auth.ID != refresh {
		return fail, scopes("Choose the same account already connected to this social set.")
	}

	validName := auth.Name
	if validName == "" {
		if auth.Username != "" {
			validName = strings.Split(auth.Username, ".")[0]
		} else {
			id := []rune(auth.ID)
			validName = "Channel_" + string(id[:min(len(id), 8)])
		}
	}

	if os.Getenv("STRIPE_PUBLISHABLE_KEY") != "" && org.IsTrailing {
		previous, err := c.integrations.CheckPreviousConnections(ctx, org.ID, auth.ID)
		if err != nil {
			return fail, err
		}
		if previous {
			return fail, socialapi.NewError(http.StatusPreconditionFailed, false, "this account was connected before")
		}
	}

	migrationAuth := integrations.AuthTokenDetails{ID: auth.ID, Username: auth.Username}
	if refresh != "" && auth.ID != refresh {
		// A reconnect returning another id is the wrong account or a channel
		// migrating provider (MIGRATE_PROVIDERS); this runs after every check
		// that can reject the connect.
		if _, err := c.integrations.MigrateIntegration(ctx, org.ID, refresh, name, migrationAuth); err != nil {
			return fail, err
		}
	} else if refresh == "" {
		if _, err := c.integrations.MigrateIntegrationOnConnect(ctx, org.ID, name, migrationAuth); err != nil {
			return fail, err
		}
	}

	customInstanceDetails := ""
	switch {
	case auth.CredentialDetails != nil:
		customInstanceDetails, err = credentialcipher.Seal(*auth.CredentialDetails, "custom-instance")
	case details != "":
		customInstanceDetails, err = credentialcipher.Seal(details, "custom-instance")
	case hasCustomFields, info.IsChromeExtension:
		// The product's only credential form is Bluesky's standard base64.
		var decoded []byte
		if decoded, err = base64.StdEncoding.DecodeString(code); err == nil {
			customInstanceDetails, err = credentialcipher.Seal(string(decoded), "custom-instance")
		}
	}
	if err != nil {
		return fail, err
	}

	params := integration.CreateOrUpdateIntegrationParams{
		Verification:          auth.Verification,
		AdditionalSettings:    auth.AdditionalSettings,
		OneTimeToken:          info.OneTimeToken,
		Org:                   org.ID,
		Name:                  strings.TrimSpace(validName),
		Picture:               auth.Picture,
		Type:                  "social",
		InternalID:            auth.ID,
		Provider:              name,
		Token:                 auth.AccessToken,
		RefreshToken:          auth.RefreshToken,
		Username:              &auth.Username,
		IsBetweenSteps:        refresh == "" && info.IsBetweenSteps,
		CustomInstanceDetails: customInstanceDetails,
	}
	if auth.NonExpiring {
		zero := int64(0)
		params.ExpiresIn = &zero
	} else if auth.ExpiresIn != 0 {
		params.ExpiresIn = &auth.ExpiresIn
	}
	created, err := c.integrations.CreateOrUpdateIntegration(ctx, params)
	if err != nil {
		return fail, err
	}
	// The social refreshTokenWorkflow is not started: token refresh moves to a
	// product-worker job.

	result := socialapi.OAuthExchange{ID: created.ID}
	if info.IsBetweenSteps && refresh == "" {
		fetch := provider.Functions()["pages"]
		if fetch == nil {
			fetch = provider.Functions()["companies"]
		}
		if fetch != nil {
			if loaded, err := fetch(ctx, auth.AccessToken, nil, "", nil); err != nil {
				return fail, socialapi.NewError(http.StatusBadGateway, false, "provider account discovery failed")
			} else if loaded != nil {
				data, err := json.Marshal(loaded)
				if err == nil {
					err = json.Unmarshal(data, &result.Pages)
					if err == nil && (name == "linkedin-page" || name == "youtube") {
						for i := range result.Pages {
							result.Pages[i].PageID = result.Pages[i].ID
						}
					}
				}
				if err != nil {
					return fail, socialapi.NewError(http.StatusBadGateway, false, "social adapter returned invalid pages")
				}
			}
		}
	}
	return result, nil
}

// authenticate resolves the provider's tokens, folding every failure into
// AuthTokenDetails.Error.
func authenticate(ctx context.Context, name string, provider integrations.Provider, code, codeVerifier, details, refresh string) integrations.AuthTokenDetails {
	failed := func(message string) integrations.AuthTokenDetails {
		return integrations.AuthTokenDetails{Error: message, AdditionalSettings: []integrations.AdditionalSetting{}}
	}
	var client *integrations.ClientInformation
	if details != "" {
		if err := json.Unmarshal([]byte(details), &client); err != nil {
			slog.Error("Authentication failed for "+name+":", "error", err)
			return failed("Authentication failed")
		}
	}
	auth, err := provider.Authenticate(ctx, integrations.AuthenticateParams{Code: code, CodeVerifier: codeVerifier}, client)
	if err != nil {
		var message integrations.AuthMessage
		if errors.As(err, &message) {
			return failed(string(message))
		}
		var scopes *integrations.NotEnoughScopes
		if errors.As(err, &scopes) {
			return failed(scopes.Message)
		}
		slog.Error("Authentication failed for "+name+":", "error", err)
		return failed("Authentication failed")
	}
	if auth == nil {
		return failed("Authentication failed")
	}
	if reconnector, ok := provider.(integrations.Reconnector); ok && refresh != "" {
		newAuth, err := reconnector.ReConnect(ctx, auth.ID, refresh, auth.AccessToken)
		if err != nil {
			return failed(temporalx.FailureMessage(err))
		}
		// Keep the fresh refresh token and expiration from the new authentication.
		merged := integrations.AuthTokenDetails{}
		if newAuth != nil {
			merged = *newAuth
		}
		merged.RefreshToken = auth.RefreshToken
		merged.ExpiresIn = auth.ExpiresIn
		return merged
	}
	return *auth
}

// SelectInstagramPage is POST /integrations/public/provider/:id/connect.
func (c *Connector) SelectInstagramPage(ctx context.Context, integrationID, accountID, pageID, state string) error {
	org, err := c.stateOrganization(ctx, state)
	if err != nil {
		return err
	}
	data, err := json.Marshal(map[string]string{"id": accountID, "page": pageID, "pageId": pageID, "state": state})
	if err != nil {
		return err
	}
	result, err := c.integrations.SaveProviderPage(ctx, org.ID, integrationID, data)
	if err != nil {
		return err
	}
	if result == nil || !result.Success {
		return socialapi.NewError(http.StatusBadGateway, false, "social adapter did not connect the page")
	}
	return nil
}

// identity is GET integrations/:id/identity.
func (c *Connector) identity(ctx context.Context, organization, id string) (*socialidentity.Connection, error) {
	in, err := c.integrations.GetIntegrationByID(ctx, organization, id)
	if err != nil {
		return nil, err
	}
	if in == nil {
		return nil, socialapi.NewError(http.StatusNotFound, false, "Integration not found")
	}
	value := &socialidentity.Connection{ID: in.ID, Provider: in.ProviderIdentifier, NativeID: in.InternalID, Name: in.Name,
		Active:     in.DeletedAt == nil && !in.Disabled && !in.RefreshNeeded && !in.InBetweenSteps && (in.TokenExpiration == nil || in.TokenExpiration.After(time.Now())),
		VerifiedAt: in.IdentityVerifiedAt}
	if in.Profile != nil {
		value.Handle = *in.Profile
	}
	if in.Picture != nil {
		value.AvatarURL = *in.Picture
	}
	if in.VerifiedAccountKey != nil && in.VerifiedAccountKind != nil && in.VerifiedCapabilities != nil {
		proof := &socialidentity.Verification{AccountKey: *in.VerifiedAccountKey, AccountKind: *in.VerifiedAccountKind, GrantedScopes: in.VerifiedScopes, Capabilities: *in.VerifiedCapabilities}
		if proof.Validate(in.ProviderIdentifier, in.InternalID) == nil {
			value.Verification = proof
		}
	}
	return value, nil
}

func (c *Connector) verifiedIdentity(ctx context.Context, input socialapi.VerifyDestinationInput, provider string) (*socialidentity.Connection, error) {
	organization, err := c.organization(ctx, input.SecretReference, input.ExpectedGoOrganizationID)
	if err != nil {
		return nil, err
	}
	account, err := c.identity(ctx, organization, input.DestinationID)
	if err != nil {
		return nil, err
	}
	if account.Validate(provider, input.DestinationID) != nil {
		return nil, socialapi.NewError(http.StatusConflict, false, "account identity, grant or capabilities could not be verified")
	}
	return account, nil
}

// VerifyX reads the X account's native identity and observed OAuth grant.
func (c *Connector) VerifyX(ctx context.Context, input socialapi.VerifyDestinationInput) (*socialidentity.Connection, error) {
	if input.Platform != "x" || input.DestinationID == "" {
		return nil, socialapi.NewError(http.StatusConflict, false, "invalid X destination")
	}
	return c.verifiedIdentity(ctx, input, "x")
}

// VerifyBluesky reads the Bluesky account's native identity and publishing facts.
func (c *Connector) VerifyBluesky(ctx context.Context, input socialapi.VerifyDestinationInput) (*socialidentity.Connection, error) {
	if input.Platform != "bluesky" {
		return nil, socialapi.NewError(http.StatusConflict, false, "invalid Bluesky destination")
	}
	return c.verifiedIdentity(ctx, input, "bluesky")
}

// VerifyDestination requires an enabled integration of this platform in the
// tenant's organization.
func (c *Connector) VerifyDestination(ctx context.Context, input socialapi.VerifyDestinationInput) error {
	if input.Platform == "x" {
		_, err := c.VerifyX(ctx, input)
		return err
	}
	organization, err := c.organization(ctx, input.SecretReference, input.ExpectedGoOrganizationID)
	if err != nil {
		return err
	}
	list, err := c.integrations.GetIntegrationsList(ctx, organization)
	if err != nil {
		return err
	}
	for _, in := range list {
		if in.ID == input.DestinationID && in.ProviderIdentifier == input.Platform && !in.Disabled {
			return nil
		}
	}
	return socialapi.NewError(http.StatusNotFound, false, "Social destination was not found")
}

// Profiles reads every destination's name, handle and picture, by id.
func (c *Connector) Profiles(ctx context.Context, secretReference string) (map[string]socialapi.DestinationProfile, error) {
	organization, err := c.tenants.Organization(ctx, secretReference)
	if err != nil || organization == "" {
		return nil, errMismatch
	}
	list, err := c.integrations.GetIntegrationsList(ctx, organization)
	if err != nil {
		return nil, err
	}
	profiles := make(map[string]socialapi.DestinationProfile, len(list))
	for _, in := range list {
		profile := socialapi.DestinationProfile{Name: in.Name}
		if in.CustomName != nil && *in.CustomName != "" {
			profile.Name = *in.CustomName
		}
		// Only an absolute https picture can be shown; uploads paths are the social API's own.
		if in.Picture != nil && strings.HasPrefix(*in.Picture, "https://") {
			profile.AvatarURL = *in.Picture
		}
		if in.Profile != nil {
			profile.Handle = strings.TrimPrefix(*in.Profile, "@")
		}
		profiles[in.ID] = profile
	}
	return profiles, nil
}

// ConnectionAvailability reports which providers can be connected, after
// checking the reference belongs to organization.
func (c *Connector) ConnectionAvailability(ctx context.Context, organization, reference string) (*socialidentity.ConnectionAvailability, error) {
	if _, err := c.organization(ctx, reference, organization); err != nil {
		return nil, err
	}
	result := c.manager.ConnectionAvailability()
	if result.Validate() != nil {
		return nil, socialapi.NewError(http.StatusBadGateway, false, "social connection availability could not be verified")
	}
	return &result, nil
}
