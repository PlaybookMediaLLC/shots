package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

type fakeStore struct {
	connections         []*ent.ChannelConnection
	connection          publishing.CreateConnectionInput
	scheduled           publishing.CreateScheduledPostInput
	oauthState          string
	oauthSession        string
	oauthProvider       string
	oauthReceipt        *schema.SocialOAuthExchange
	oauthStatus         socialoauthstart.ExchangeStatus
	oauthOptions        publishing.OAuthStartOptions
	authError           error
	connectionAuthError error
	bindingError        error
	keyScope            string
	cancelActor         publishing.Actor
}

type fakeVerifier struct {
	input         socialapi.VerifyDestinationInput
	beginCalls    int
	exchangeCalls int
	pageCalls     int
	beginInput    socialapi.BeginOAuthInput
	beginURL      string
}

func (f *fakeVerifier) Profiles(context.Context, string) (map[string]socialapi.DestinationProfile, error) {
	return map[string]socialapi.DestinationProfile{"social-x": {Handle: "shots_app", Name: "Shots"}}, nil
}

func (f *fakeVerifier) VerifyDestination(_ context.Context, input socialapi.VerifyDestinationInput) error {
	f.input = input
	return nil
}
func (f *fakeVerifier) BeginOAuth(_ context.Context, input socialapi.BeginOAuthInput) (string, error) {
	f.beginCalls++
	f.beginInput = input
	if f.beginURL != "" {
		return f.beginURL, nil
	}
	return "https://api.x.com/oauth/authorize?oauth_token=test-state", nil
}
func (f *fakeVerifier) ExchangeOAuth(_ context.Context, provider, code, state string) (socialapi.OAuthExchange, error) {
	f.exchangeCalls++
	if provider != "x" || code != "test-code" || state != "test-state" {
		return socialapi.OAuthExchange{}, fmt.Errorf("unexpected OAuth exchange")
	}
	return socialapi.OAuthExchange{ID: "destination-1"}, nil
}
func (f *fakeVerifier) SelectInstagramPage(context.Context, string, string, string, string) error {
	f.pageCalls++
	return nil
}

type fakeScheduler struct {
	cancelled string
	started   temporalpublishing.ScheduleInput
}

func (f *fakeScheduler) Ping(context.Context) error { return nil }
func (f *fakeScheduler) Start(_ context.Context, input temporalpublishing.ScheduleInput) error {
	f.started = input
	return nil
}
func (f *fakeScheduler) Cancel(_ context.Context, postID string) error {
	f.cancelled = postID
	return nil
}

func (f *fakeStore) Ping(context.Context) error { return nil }
func (f *fakeStore) AuthorizePublishing(context.Context, string, string, string) error {
	return f.authError
}
func (f *fakeStore) AuthorizeConnections(context.Context, string, string, string) error {
	if f.connectionAuthError != nil {
		return f.connectionAuthError
	}
	return f.authError
}

func TestAccountMutationsRequireAdministrationBeforeProviderCalls(t *testing.T) {
	for _, path := range []string{"/v1/channel-connections", "/v1/social-oauth/begin", "/v1/social-connections/bluesky/begin"} {
		store := &fakeStore{connectionAuthError: publishing.ErrForbidden}
		verifier := &fakeVerifier{}
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer secret")
		request.Header.Set("X-Organization-ID", "org-1")
		request.Header.Set("X-User-ID", "publisher")
		request.Header.Set("X-Session-ID", "session-1")
		response := httptest.NewRecorder()
		New(store, &fakeScheduler{}, verifier, "secret").ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || verifier.beginCalls != 0 || store.connection.ExternalAccountID != "" {
			t.Fatalf("%s escaped account administration: status=%d calls=%d", path, response.Code, verifier.beginCalls)
		}
	}
}
func (f *fakeStore) AuthorizeAPIKeyScope(_ context.Context, _, _, scope string) error {
	f.keyScope = scope
	return f.authError
}
func (f *fakeStore) Binding(context.Context, string) (*ent.SocialTenantBinding, error) {
	if f.bindingError != nil {
		return nil, f.bindingError
	}
	return &ent.SocialTenantBinding{GoOrganizationID: "go-org-1", SecretReference: "SOCIAL_API_KEY"}, nil
}
func (f *fakeStore) StartOAuth(_ context.Context, _ publishing.Actor, session, state, provider, _ string, options publishing.OAuthStartOptions) error {
	f.oauthState = state
	f.oauthSession = session
	f.oauthProvider = provider
	f.oauthOptions = options
	f.oauthStatus = socialoauthstart.ExchangeStatusPENDING
	return nil
}

func (f *fakeStore) PrepareOAuth(_ context.Context, _ publishing.Actor, _, _ string, options publishing.OAuthStartOptions) (string, error) {
	if f.authError != nil {
		return "", f.authError
	}
	if err := publishing.ValidateOAuthStartOptions(options); err != nil {
		return "", err
	}
	return "", nil
}

func TestSocialOAuthCreationBindsOwnerAndRejectsMixedIntent(t *testing.T) {
	for _, test := range []struct {
		body, visibility string
		status           int
	}{
		{`{"provider":"x","operation":"CREATE_SET","creationVisibility":"PRIVATE"}`, "PRIVATE", http.StatusCreated},
		{`{"provider":"x","operation":"CREATE_SET","creationVisibility":"WORKSPACE"}`, "WORKSPACE", http.StatusCreated},
		{`{"provider":"x","operation":"CREATE_SET"}`, "", http.StatusBadRequest},
		{`{"provider":"x","operation":"CREATE_SET","creationVisibility":"PRIVATE","expectedConnectionId":"existing"}`, "", http.StatusBadRequest},
		{`{"provider":"x","operation":"ADD_ACCOUNT","creationVisibility":"PRIVATE"}`, "", http.StatusBadRequest},
		{`{"provider":"x","operation":"REPLACE"}`, "", http.StatusBadRequest},
	} {
		t.Run(test.body, func(t *testing.T) {
			store, verifier := &fakeStore{}, &fakeVerifier{}
			request := httptest.NewRequest(http.MethodPost, "/v1/social-oauth/begin", strings.NewReader(test.body))
			request.Header.Set("Authorization", "Bearer secret")
			request.Header.Set("X-Organization-ID", "original-workspace")
			request.Header.Set("X-User-ID", "original-user")
			request.Header.Set("X-Session-ID", "original-session")
			response := httptest.NewRecorder()
			New(store, &fakeScheduler{}, verifier, "secret").ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			if test.status == http.StatusCreated {
				if store.oauthOptions.Operation != "CREATE_SET" || store.oauthOptions.CreationVisibility != test.visibility || store.oauthSession != "original-session" {
					t.Fatalf("lost creation context: %+v", store.oauthOptions)
				}
			} else if verifier.beginCalls != 0 || store.oauthState != "" {
				t.Fatal("invalid intent reached the provider")
			}
		})
	}
}
func (f *fakeStore) OAuthStart(_ context.Context, _ publishing.Actor, session, state, provider string, _ *string) (*ent.SocialOAuthStart, error) {
	if state != f.oauthState || session != f.oauthSession || provider != f.oauthProvider {
		return nil, publishing.ErrNotFound
	}
	start := &ent.SocialOAuthStart{SecretReference: "SOCIAL_API_KEY", ExchangeStatus: f.oauthStatus}
	if f.oauthReceipt != nil {
		start.ExchangeReceipt = *f.oauthReceipt
	}
	return start, nil
}
func (f *fakeStore) AuthorizeSession(context.Context, string, string) (*ent.Session, error) {
	return &ent.Session{}, f.authError
}
func (f *fakeStore) ResolveOAuthContext(ctx context.Context, user, session, state, provider string) (*publishing.OAuthContext, error) {
	if _, err := f.OAuthStart(ctx, publishing.Actor{}, session, state, provider, nil); err != nil {
		return nil, err
	}
	return &publishing.OAuthContext{OrganizationID: "org-1"}, nil
}
func (f *fakeStore) ClaimOAuthExchange(ctx context.Context, actor publishing.Actor, session, state, provider string) (*schema.SocialOAuthExchange, error) {
	if _, err := f.OAuthStart(ctx, actor, session, state, provider, nil); err != nil {
		return nil, err
	}
	if f.oauthReceipt != nil {
		return f.oauthReceipt, nil
	}
	if f.oauthStatus == socialoauthstart.ExchangeStatusEXCHANGING {
		return nil, publishing.ErrOAuthExchangeUncertain
	}
	f.oauthStatus = socialoauthstart.ExchangeStatusEXCHANGING
	return nil, nil
}
func (f *fakeStore) SaveOAuthExchange(_ context.Context, _ publishing.Actor, _, _, _ string, result schema.SocialOAuthExchange) error {
	f.oauthReceipt = &result
	f.oauthStatus = socialoauthstart.ExchangeStatusEXCHANGED
	return nil
}
func (f *fakeStore) RememberInstagramIntegration(context.Context, publishing.Actor, string, string, string, ...string) error {
	return nil
}
func (f *fakeStore) FinishOAuth(context.Context, publishing.Actor, string, string, string, string) (*ent.ChannelConnection, error) {
	f.oauthStatus = socialoauthstart.ExchangeStatusCOMPLETED
	return &ent.ChannelConnection{ID: "connection-1", ProviderSettings: map[string]any{}}, nil
}

func TestSocialOAuthBoundToSessionAndCompletesThroughEnt(t *testing.T) {
	store := &fakeStore{}
	verifier := &fakeVerifier{}
	handler := New(store, &fakeScheduler{}, verifier, "secret")
	call := func(path, session, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer secret")
		request.Header.Set("X-Organization-ID", "org-1")
		request.Header.Set("X-User-ID", "user-1")
		request.Header.Set("X-Session-ID", session)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	begin := call("/v1/social-oauth/begin", "session-1", `{"provider":"x"}`)
	if begin.Code != http.StatusCreated || store.oauthState != "test-state" {
		t.Fatalf("begin status=%d body=%s state=%s", begin.Code, begin.Body, store.oauthState)
	}
	wrongSession := call("/v1/social-oauth/verify", "session-2", `{"provider":"x","state":"test-state"}`)
	if wrongSession.Code != http.StatusForbidden {
		t.Fatalf("another session verified OAuth: %d", wrongSession.Code)
	}
	wrongExchange := call("/v1/social-oauth/exchange", "session-2", `{"provider":"x","state":"test-state","code":"test-code"}`)
	if wrongExchange.Code != http.StatusForbidden || verifier.exchangeCalls != 0 {
		t.Fatalf("another session exchanged OAuth: status=%d calls=%d", wrongExchange.Code, verifier.exchangeCalls)
	}
	exchanged := call("/v1/social-oauth/exchange", "session-1", `{"provider":"x","state":"test-state","code":"test-code"}`)
	if exchanged.Code != http.StatusOK || verifier.exchangeCalls != 1 || !strings.Contains(exchanged.Body.String(), `"id":"destination-1"`) {
		t.Fatalf("exchange status=%d body=%s calls=%d", exchanged.Code, exchanged.Body, verifier.exchangeCalls)
	}
	replay := call("/v1/social-oauth/exchange", "session-1", `{"provider":"x","state":"test-state","code":"test-code"}`)
	if replay.Code != http.StatusOK || verifier.exchangeCalls != 1 {
		t.Fatalf("exchange replay=%d calls=%d", replay.Code, verifier.exchangeCalls)
	}
	verified := call("/v1/social-oauth/verify", "session-1", `{"provider":"x","state":"test-state"}`)
	if verified.Code != http.StatusOK {
		t.Fatalf("verify status=%d body=%s", verified.Code, verified.Body)
	}
	completed := call("/v1/social-oauth/complete", "session-1", `{"provider":"x","state":"test-state","integrationId":"destination-1"}`)
	if completed.Code != http.StatusOK || verifier.input.DestinationID != "destination-1" {
		t.Fatalf("complete status=%d body=%s destination=%s", completed.Code, completed.Body, verifier.input.DestinationID)
	}
}

func TestOAuthExchangeRecoveryWithoutProviderConfiguration(t *testing.T) {
	for _, status := range []socialoauthstart.ExchangeStatus{socialoauthstart.ExchangeStatusPENDING, socialoauthstart.ExchangeStatusEXCHANGED, socialoauthstart.ExchangeStatusCOMPLETED} {
		for _, missingBinding := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/missingBinding=%t", status, missingBinding), func(t *testing.T) {
				store := &fakeStore{oauthState: "saved-state", oauthSession: "session-1", oauthProvider: "x", oauthStatus: status}
				if status != socialoauthstart.ExchangeStatusPENDING {
					store.oauthReceipt = &schema.SocialOAuthExchange{ID: "saved-destination"}
				}
				handler := New(store, &fakeScheduler{}, nil, "secret")
				if missingBinding {
					store.bindingError = publishing.ErrNotFound
					handler = New(store, &fakeScheduler{}, &fakeVerifier{}, "secret")
				}
				request := httptest.NewRequest(http.MethodPost, "/v1/social-oauth/exchange", strings.NewReader(`{"provider":"x","state":"saved-state","code":"already-used-code"}`))
				request.Header.Set("Authorization", "Bearer secret")
				request.Header.Set("X-Organization-ID", "org-1")
				request.Header.Set("X-User-ID", "user-1")
				request.Header.Set("X-Session-ID", "session-1")
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				if status == socialoauthstart.ExchangeStatusPENDING {
					if response.Code != http.StatusConflict || store.oauthStatus != status {
						t.Fatalf("unavailable provider consumed pending attempt: status=%d state=%s", response.Code, store.oauthStatus)
					}
				} else if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"saved-destination"`) {
					t.Fatalf("saved result was not recovered: status=%d body=%s", response.Code, response.Body)
				}
			})
		}
	}
}

func TestAuthorizationURLRejectsWrongHost(t *testing.T) {
	if _, _, err := validatedAuthorizationURL("https://evil.example/oauth?oauth_token=test", "x"); err == nil {
		t.Fatal("accepted authorization URL from another host")
	}
	url, state, err := validatedAuthorizationURL("https://www.linkedin.com/oauth/v2/authorization?state=linked-state", "linkedin")
	if err != nil || state != "linked-state" || url == "" {
		t.Fatalf("LinkedIn authorization URL: url=%q state=%q err=%v", url, state, err)
	}
}
func (f *fakeStore) CreateConnection(_ context.Context, _ publishing.Actor, input publishing.CreateConnectionInput) (*ent.ChannelConnection, error) {
	f.connection = input
	return &ent.ChannelConnection{ID: "connection-1", Platform: input.Platform, ProviderSettings: input.ProviderSettings}, nil
}
func (f *fakeStore) ListConnections(context.Context, string) ([]*ent.ChannelConnection, error) {
	return f.connections, nil
}
func (f *fakeStore) SetConnectionProfile(_ context.Context, id, name, handle, avatar string) (*ent.ChannelConnection, error) {
	return &ent.ChannelConnection{ID: id, DisplayName: &name, Handle: &handle, AvatarURL: &avatar, Status: "ACTIVE"}, nil
}
func (f *fakeStore) CreateScheduledPost(_ context.Context, actor publishing.Actor, input publishing.CreateScheduledPostInput) (publishing.CreateScheduledPostResult, error) {
	f.scheduled = input
	return publishing.CreateScheduledPostResult{Created: true, Post: &ent.ScheduledPost{ID: "post-1", OrganizationID: actor.Organization, Caption: input.Caption, ScheduledFor: input.ScheduledFor, Status: "SCHEDULED"}}, nil
}
func (f *fakeStore) ListScheduledPosts(context.Context, string, bool, int) ([]*ent.ScheduledPost, error) {
	return nil, nil
}
func (f *fakeStore) CancelScheduledPost(_ context.Context, actor publishing.Actor, _ string) (*ent.ScheduledPost, error) {
	f.cancelActor = actor
	return &ent.ScheduledPost{ID: "post-1"}, nil
}

func TestServiceAuthentication(t *testing.T) {
	handler := New(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret")
	request := httptest.NewRequest(http.MethodGet, "/v1/channel-connections", nil)
	request.Header.Set("X-Organization-ID", "org-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestServiceAuthenticationFailsClosedWithoutConfiguredToken(t *testing.T) {
	handler := New(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "")
	request := httptest.NewRequest(http.MethodGet, "/v1/channel-connections", nil)
	request.Header.Set("X-Organization-ID", "org-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestPublishingRequestRequiresAnAuthorizedSession(t *testing.T) {
	store := &fakeStore{authError: publishing.ErrForbidden}
	handler := New(store, &fakeScheduler{}, &fakeVerifier{}, "secret")
	request := httptest.NewRequest(http.MethodGet, "/v1/scheduled-posts", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("request without session status=%d", response.Code)
	}
	request.Header.Set("X-Session-ID", "session-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("request without publishing permission status=%d", response.Code)
	}
}

func TestScheduledPostsAdmitAnAPIKeyWithTheScope(t *testing.T) {
	store := &fakeStore{}
	handler := New(store, &fakeScheduler{}, &fakeVerifier{}, "secret")
	send := func(method, path string) int {
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("Authorization", "Bearer secret")
		request.Header.Set("X-Organization-ID", "org-1")
		request.Header.Set("X-Principal-Kind", "api_key")
		request.Header.Set("X-API-Key-ID", "key-1")
		request.Header.Set("X-Principal-Display", "Coding agent")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response.Code
	}
	if code := send(http.MethodGet, "/v1/scheduled-posts"); code != http.StatusOK || store.keyScope != "artifact:read" {
		t.Fatalf("list status=%d scope=%q", code, store.keyScope)
	}
	if code := send(http.MethodPost, "/v1/scheduled-posts/post-1/cancel"); code != http.StatusOK || store.keyScope != "post:schedule" {
		t.Fatalf("cancel status=%d scope=%q", code, store.keyScope)
	}
	if store.cancelActor.Type != "SERVICE" || store.cancelActor.Display != "Coding agent" || store.cancelActor.UserID != "" {
		t.Fatalf("a key cancels as a named service: %#v", store.cancelActor)
	}
	store.authError = publishing.ErrForbidden
	if code := send(http.MethodPost, "/v1/scheduled-posts/post-1/cancel"); code != http.StatusForbidden {
		t.Fatalf("a key without post:schedule status=%d", code)
	}
}

func TestCreateScheduledPost(t *testing.T) {
	store := &fakeStore{}
	scheduler := &fakeScheduler{}
	handler := New(store, scheduler, &fakeVerifier{}, "secret")
	scheduledFor := time.Now().UTC().Add(24 * time.Hour).Truncate(time.Second)
	body := fmt.Sprintf(`{"caption":"hello","channelConnectionId":"connection-1","idempotencyKey":"request-1","scheduledFor":%q,"variantId":"variant-1"}`, scheduledFor.Format(time.RFC3339))
	request := httptest.NewRequest(http.MethodPost, "/v1/scheduled-posts", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if store.scheduled.Caption != "hello" || !store.scheduled.ScheduledFor.Equal(scheduledFor) {
		t.Fatalf("unexpected scheduled input: %#v", store.scheduled)
	}
	if scheduler.started.PostID != "post-1" || scheduler.started.OrganizationID != "org-1" {
		t.Fatalf("workflow was not started for the scheduled post: %#v", scheduler.started)
	}
}

func TestCreateConnectionAppliesSocialDefaults(t *testing.T) {
	store := &fakeStore{}
	verifier := &fakeVerifier{}
	handler := New(store, &fakeScheduler{}, verifier, "secret")
	request := httptest.NewRequest(http.MethodPost, "/v1/channel-connections", strings.NewReader(`{"externalAccountId":"account-1"}`))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if store.connection.Platform != "x" || store.connection.SecretReference != "SOCIAL_API_KEY" {
		t.Fatalf("unexpected connection defaults: %#v", store.connection)
	}
	if verifier.input.DestinationID != "account-1" || verifier.input.ExpectedGoOrganizationID != "go-org-1" {
		t.Fatalf("destination was not verified against the tenant binding: %#v", verifier.input)
	}
}

func TestCreateScheduledPostRejectsPastTime(t *testing.T) {
	handler := New(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret")
	body := `{"caption":"hello","channelConnectionId":"connection-1","idempotencyKey":"request-1","scheduledFor":"2020-01-01T00:00:00Z","variantId":"variant-1"}`
	request := httptest.NewRequest(http.MethodPost, "/v1/scheduled-posts", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestListConnectionsNamesAccountsFromSocialAPI(t *testing.T) {
	store := &fakeStore{connections: []*ent.ChannelConnection{{ID: "c1", ExternalAccountID: "social-x", Platform: "x", Status: "ACTIVE"}}}
	handler := New(store, &fakeScheduler{}, &fakeVerifier{}, "secret")
	request := httptest.NewRequest(http.MethodGet, "/v1/channel-connections", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"displayName":"Shots"`) ||
		!strings.Contains(response.Body.String(), `"handle":"shots_app"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestListConnectionsSignsPrivateBucketAvatars(t *testing.T) {
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "true")
	t.Setenv("STORAGE_PROVIDER", "cloudflare")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "account")
	t.Setenv("CLOUDFLARE_ACCESS_KEY", "test-access")
	t.Setenv("CLOUDFLARE_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("CLOUDFLARE_BUCKETNAME", "social-media")
	t.Setenv("CLOUDFLARE_BUCKET_URL", "https://account.r2.cloudflarestorage.com/social-media")
	name, avatar := "Shots", "https://account.r2.cloudflarestorage.com/social-media/avatar.jpg"
	store := &fakeStore{connections: []*ent.ChannelConnection{{ID: "c1", ExternalAccountID: "social-x", Platform: "x", Status: "ACTIVE", DisplayName: &name, AvatarURL: &avatar}}}
	handler := New(store, &fakeScheduler{}, &fakeVerifier{}, "secret")
	request := httptest.NewRequest(http.MethodGet, "/v1/channel-connections", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	// A browser can load only a signed link to the private bucket.
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `/social-media/avatar.jpg?X-Amz-Algorithm=`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestVideoAndPageOAuthAuthorizationHosts(t *testing.T) {
	for provider, host := range map[string]string{"linkedin-page": "www.linkedin.com", "tiktok": "www.tiktok.com", "youtube": "accounts.google.com"} {
		t.Run(provider, func(t *testing.T) {
			if !validOAuthProvider(provider) {
				t.Fatal("provider missing")
			}
			if _, state, err := validatedAuthorizationURL("https://"+host+"/oauth?state=bound-state", provider); err != nil || state != "bound-state" {
				t.Fatalf("state=%q error=%v", state, err)
			}
			if _, _, err := validatedAuthorizationURL("https://"+host+".evil.example/oauth?state=bound-state", provider); err == nil {
				t.Fatal("untrusted host accepted")
			}
		})
	}
}

func TestOAuthSelectionOnlyAcceptsOfferedPagesAndChannels(t *testing.T) {
	for _, provider := range []string{"linkedin-page", "youtube", "instagram"} {
		t.Run(provider, func(t *testing.T) {
			store := &fakeStore{oauthState: "state", oauthSession: "session", oauthProvider: provider, oauthStatus: socialoauthstart.ExchangeStatusEXCHANGED,
				oauthReceipt: &schema.SocialOAuthExchange{ID: "integration", Pages: []schema.SocialOAuthPage{{ID: "offered", PageID: "page"}}}}
			verifier := &fakeVerifier{}
			handler := New(store, &fakeScheduler{}, verifier, "secret")
			call := func(account, page, session string) int {
				request := httptest.NewRequest(http.MethodPost, "/v1/social-oauth/page", strings.NewReader(fmt.Sprintf(`{"provider":%q,"state":"state","integrationId":"integration","accountId":%q,"pageId":%q}`, provider, account, page)))
				request.Header.Set("Authorization", "Bearer secret")
				request.Header.Set("X-Organization-ID", "org-1")
				request.Header.Set("X-User-ID", "user-1")
				request.Header.Set("X-Session-ID", session)
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, request)
				return response.Code
			}
			if got := call("arbitrary", "page", "session"); got != http.StatusBadRequest {
				t.Fatalf("arbitrary account status=%d", got)
			}
			if got := call("offered", "arbitrary", "session"); got != http.StatusBadRequest {
				t.Fatalf("arbitrary page status=%d", got)
			}
			if got := call("offered", "page", "other-session"); got != http.StatusForbidden {
				t.Fatalf("foreign session status=%d", got)
			}
			if verifier.pageCalls != 0 {
				t.Fatal("invalid selection reached provider")
			}
			if got := call("offered", "page", "session"); got != http.StatusOK {
				t.Fatalf("offered selection status=%d", got)
			}
			store.oauthStatus = socialoauthstart.ExchangeStatusCOMPLETED
			if got := call("offered", "page", "session"); got != http.StatusOK || verifier.pageCalls != 1 {
				t.Fatal("completion replay repeated selection")
			}
		})
	}
}
