package socialconnect

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/dbtest"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/redis"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

type fakeTenants struct{ references, states, workspaces map[string]string }

func (f fakeTenants) WorkspaceOrganization(_ context.Context, workspace string) (string, error) {
	if organization, ok := f.workspaces[workspace]; ok {
		return organization, nil
	}
	return "", errors.New("binding not found")
}

func (f fakeTenants) Organization(_ context.Context, reference string) (string, error) {
	if organization, ok := f.references[reference]; ok {
		return organization, nil
	}
	return "", errors.New("binding not found")
}

func (f fakeTenants) StateOrganization(_ context.Context, state string) (string, error) {
	if organization, ok := f.states[state]; ok {
		return organization, nil
	}
	return "", errors.New("oauth start not found")
}

type fakeProvider struct {
	*integrations.Base
	authenticated bool
}

func (*fakeProvider) Info() integrations.Info { return integrations.Info{Identifier: "x", Name: "X"} }
func (*fakeProvider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int {
	return 280
}
func (*fakeProvider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	return &integrations.GenerateAuthURLResponse{URL: "https://api.x.com/oauth/authorize?oauth_token=state-1", CodeVerifier: "verifier-1", State: "state-1"}, nil
}
func (f *fakeProvider) Authenticate(context.Context, integrations.AuthenticateParams, *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	f.authenticated = true
	return &integrations.AuthTokenDetails{ID: "native-1", AccessToken: "token"}, nil
}
func (*fakeProvider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return nil, errors.New("unused")
}
func (*fakeProvider) Post(context.Context, string, string, []integrations.PostDetails, *ent.Integration) ([]integrations.PostResponse, error) {
	return nil, errors.New("unused")
}

func oauthConnector(t *testing.T) (*Connector, *fakeProvider, redis.Store) {
	t.Setenv("PLATFORM_SOCIAL_ENCRYPTION_KEY", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
	t.Setenv("X_API_KEY", "key")
	t.Setenv("X_API_SECRET", "secret")
	t.Setenv("X_URL", "")
	t.Setenv("FRONTEND_URL", "https://app.example.test")
	provider := &fakeProvider{Base: integrations.NewBase("x", nil)}
	store := redis.NewMemory()
	return &Connector{
		tenants: fakeTenants{references: map[string]string{"SOCIAL_KEY_A": "org-a"}, states: map[string]string{}},
		manager: integrations.NewManager([]integrations.Provider{provider}), store: store,
	}, provider, store
}

func TestHiddenProviderOpensOnlyToExemptWorkspaces(t *testing.T) {
	ctx := context.Background()
	connector, _, _ := oauthConnector(t)
	connector.tenants = fakeTenants{
		references: map[string]string{"SOCIAL_KEY_A": "org-a", "SOCIAL_KEY_B": "org-b"},
		workspaces: map[string]string{"workspace-a": "org-a", "workspace-b": "org-b"},
	}
	t.Setenv("HIDDEN_PROVIDERS", "x")
	begin := func(organization, reference string) error {
		_, err := connector.BeginOAuth(ctx, socialapi.BeginOAuthInput{ExpectedGoOrganizationID: organization, Provider: "x", SecretReference: reference})
		return err
	}
	status := func(organization, reference string) string {
		catalog, err := connector.ConnectionAvailability(ctx, organization, reference)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range catalog.Providers {
			if item.Provider == "x" {
				return item.Status
			}
		}
		t.Fatal("x missing from catalog")
		return ""
	}
	for _, list := range []string{"", " , ", "workspace-unknown"} {
		t.Setenv("PLATFORM_SOCIAL_HIDDEN_PROVIDER_WORKSPACES", list)
		if begin("org-a", "SOCIAL_KEY_A") == nil || status("org-a", "SOCIAL_KEY_A") != "disabled" {
			t.Fatalf("list %q opened a hidden provider", list)
		}
	}
	t.Setenv("PLATFORM_SOCIAL_HIDDEN_PROVIDER_WORKSPACES", "workspace-unknown, workspace-a")
	if err := begin("org-a", "SOCIAL_KEY_A"); err != nil || status("org-a", "SOCIAL_KEY_A") != "available" {
		t.Fatalf("exempt workspace stayed hidden: %v", err)
	}
	if begin("org-b", "SOCIAL_KEY_B") == nil || status("org-b", "SOCIAL_KEY_B") != "disabled" {
		t.Fatal("exemption reached another workspace")
	}
}

func TestBeginOAuthStoresStateAndReturnsProviderURL(t *testing.T) {
	ctx := context.Background()
	connector, _, store := oauthConnector(t)
	url, err := connector.BeginOAuth(ctx, socialapi.BeginOAuthInput{ExpectedGoOrganizationID: "org-a", Provider: "x", SecretReference: "SOCIAL_KEY_A"})
	if err != nil || url != "https://api.x.com/oauth/authorize?oauth_token=state-1" {
		t.Fatalf("begin = %q, %v", url, err)
	}
	for key, want := range map[string]string{"organization:state-1": "org-a", "connection-provider:state-1": "x", "login:state-1": "verifier-1"} {
		if got, _, _ := store.Get(ctx, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	// A reference bound to another organization cannot begin for this one.
	if _, err := connector.BeginOAuth(ctx, socialapi.BeginOAuthInput{ExpectedGoOrganizationID: "org-b", Provider: "x", SecretReference: "SOCIAL_KEY_A"}); err == nil {
		t.Fatal("begin accepted another organization's reference")
	}
}

func TestExchangeRejectsStateFromAnotherOrganization(t *testing.T) {
	ctx := context.Background()
	connector, provider, store := oauthConnector(t)
	if _, err := connector.BeginOAuth(ctx, socialapi.BeginOAuthInput{ExpectedGoOrganizationID: "org-a", Provider: "x", SecretReference: "SOCIAL_KEY_A"}); err != nil {
		t.Fatal(err)
	}
	// The product OAuth attempt that owns the state belongs to org-b's tenant.
	connector.tenants = fakeTenants{states: map[string]string{"state-1": "org-b"}}
	_, err := connector.ExchangeOAuth(ctx, "x", "code", "state-1")
	var rejected *socialapi.Error
	if !errors.As(err, &rejected) || rejected.Status != http.StatusConflict {
		t.Fatalf("exchange = %v, want a conflict", err)
	}
	if provider.authenticated {
		t.Fatal("the provider was called for another organization's state")
	}
	if verifier, _, _ := store.Get(ctx, "login:state-1"); verifier != "verifier-1" {
		t.Fatal("a rejected exchange consumed the attempt")
	}
}

func TestListingAndVerificationStayInTheTenantOrganization(t *testing.T) {
	client := dbtest.Open(t)
	ctx := context.Background()
	orgA := client.Organization.Create().SetName("A").SaveX(ctx)
	orgB := client.Organization.Create().SetName("B").SaveX(ctx)
	own := client.Integration.Create().SetOrganization(orgA).SetInternalID("a1").SetName("Alpha").SetProfile("@alpha").
		SetProviderIdentifier("linkedin").SetType("social").SetToken("token-a").SaveX(ctx)
	other := client.Integration.Create().SetOrganization(orgB).SetInternalID("b1").SetName("Beta").
		SetProviderIdentifier("linkedin").SetType("social").SetToken("token-b").SaveX(ctx)
	otherX := client.Integration.Create().SetOrganization(orgB).SetInternalID("b2").SetName("Beta X").
		SetProviderIdentifier("x").SetType("social").SetToken("token-bx").SaveX(ctx)
	manager := integrations.NewManager(nil)
	connector := &Connector{
		tenants: fakeTenants{references: map[string]string{"SOCIAL_KEY_A": orgA.ID}}, manager: manager,
		integrations: integration.NewService(integration.NewRepository(client, nil), nil, manager, nil, nil, redis.NewMemory(), nil),
	}

	profiles, err := connector.Profiles(ctx, "SOCIAL_KEY_A")
	if err != nil || len(profiles) != 1 || profiles[own.ID] != (socialapi.DestinationProfile{Name: "Alpha", Handle: "alpha"}) {
		t.Fatalf("profiles = %+v, %v", profiles, err)
	}
	input := socialapi.VerifyDestinationInput{DestinationID: own.ID, Platform: "linkedin", ExpectedGoOrganizationID: orgA.ID, SecretReference: "SOCIAL_KEY_A"}
	if err := connector.VerifyDestination(ctx, input); err != nil {
		t.Fatalf("own destination: %v", err)
	}
	input.DestinationID = other.ID
	var missing *socialapi.Error
	if err := connector.VerifyDestination(ctx, input); !errors.As(err, &missing) || missing.Status != http.StatusNotFound {
		t.Fatalf("another organization's destination = %v, want not found", err)
	}
	input.DestinationID, input.Platform = otherX.ID, "x"
	if _, err := connector.VerifyX(ctx, input); err == nil {
		t.Fatal("verified another organization's X account")
	}
	input.ExpectedGoOrganizationID = orgB.ID
	if err := connector.VerifyDestination(ctx, input); err == nil {
		t.Fatal("a reference verified another organization's destinations")
	}
}
