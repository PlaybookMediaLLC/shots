package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/instances"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type oauthRequest struct {
	Provider      string `json:"provider"`
	State         string `json:"state"`
	IntegrationID string `json:"integrationId"`
	// SocialSetID is the set the account joins (RFC 024); empty is the default set.
	SocialSetID          string `json:"socialSetId"`
	ExpectedConnectionID string `json:"expectedConnectionId"`
	ReturnPath           string `json:"returnPath"`
	Operation            string `json:"operation"`
	CreationVisibility   string `json:"creationVisibility"`
	InstanceServer       string `json:"instanceServer"`
}

func (s *Server) authenticateOAuthCallback(next http.Handler) http.Handler {
	return s.authenticateWithOptions(next, false, true, func(ctx context.Context, actor product.Actor) error {
		_, err := s.store.AuthorizeSession(ctx, actor.UserID, actor.SessionID)
		return err
	})
}

func (s *Server) socialOAuthContext(w http.ResponseWriter, r *http.Request) {
	input, ok := decodeOAuthRequest(w, r, true, false)
	if !ok {
		return
	}
	actor := requestActor(r)
	result, err := s.store.ResolveOAuthContext(r.Context(), actor.UserID, actor.SessionID, input.State, input.Provider)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func oauthIdentity(w http.ResponseWriter, r *http.Request) (publishing.Actor, string, bool) {
	actor, ok := actorFromRequest(w, r, true)
	if !ok {
		return publishing.Actor{}, "", false
	}
	sessionID := r.Header.Get("X-Session-ID")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "X-Session-ID is required")
		return publishing.Actor{}, "", false
	}
	return actor, sessionID, true
}

func validOAuthProvider(provider string) bool {
	return provider == "x" || provider == "instagram" || provider == "instagram-standalone" || provider == "linkedin" || provider == "linkedin-page" || provider == "tiktok" || provider == "youtube" ||
		provider == "threads" || provider == "mastodon" || provider == "mastodon-custom" || provider == "facebook" || provider == "pinterest" ||
		e2eAuthorizationHost(provider) != ""
}

func decodeOAuthRequest(w http.ResponseWriter, r *http.Request, requireState, requireIntegration bool) (oauthRequest, bool) {
	var input oauthRequest
	if err := decodeJSON(r, &input); err != nil || !validOAuthProvider(input.Provider) ||
		(requireState && (input.State == "" || len(input.State) > 512)) || len(input.SocialSetID) > 160 || len(input.ExpectedConnectionID) > 160 || len(input.ReturnPath) > 200 || len(input.InstanceServer) > 2048 ||
		(requireIntegration && (input.IntegrationID == "" || len(input.IntegrationID) > 160)) {
		writeError(w, http.StatusBadRequest, "invalid social OAuth request")
		return oauthRequest{}, false
	}
	return input, true
}

func validatedAuthorizationURL(raw, provider string, instanceOrigin ...string) (string, string, error) {
	u, err := url.Parse(raw)
	e2eHost := e2eAuthorizationHost(provider)
	if err != nil || u == nil || (u.Scheme != "https" && e2eHost == "") || u.User != nil || u.Fragment != "" {
		return "", "", errors.New("invalid authorization URL")
	}
	host := map[string]string{
		"x": "api.x.com", "instagram": "www.facebook.com", "instagram-standalone": "www.instagram.com", "linkedin": "www.linkedin.com",
		"linkedin-page": "www.linkedin.com", "tiktok": "www.tiktok.com", "youtube": "accounts.google.com",
		"threads": "www.threads.net", "mastodon": "mastodon.social", "facebook": "www.facebook.com", "pinterest": "www.pinterest.com", "e2e": e2eHost,
	}[provider]
	if e2eHost != "" {
		host = e2eHost
	}
	if provider == "mastodon-custom" {
		if len(instanceOrigin) != 1 {
			return "", "", errors.New("missing instance origin")
		}
		origin, err := instances.Origin(instanceOrigin[0])
		if err != nil || origin != instanceOrigin[0] || u.Scheme+"://"+u.Host != origin || u.Path != "/oauth/authorize" || u.RawPath != "" {
			return "", "", errors.New("unexpected instance authorization URL")
		}
		host = u.Host
	}
	if u.Host != host {
		return "", "", errors.New("unexpected authorization host")
	}
	key := "state"
	if provider == "x" {
		key = "oauth_token"
	}
	state := strings.TrimSpace(u.Query().Get(key))
	if state == "" || len(state) > 512 {
		return "", "", errors.New("missing authorization state")
	}
	return u.String(), state, nil
}

type socialOAuthExchanger interface {
	ExchangeOAuth(context.Context, string, string, string) (socialapi.OAuthExchange, error)
	SelectInstagramPage(context.Context, string, string, string, string) error
}

type xIdentityVerifier interface {
	VerifyX(context.Context, socialapi.VerifyDestinationInput) (*socialidentity.Connection, error)
}

type oauthExchangeRequest struct {
	Provider string `json:"provider"`
	State    string `json:"state"`
	Code     string `json:"code"`
}

func (s *Server) exchangeSocialOAuth(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	var input oauthExchangeRequest
	if decodeJSON(r, &input) != nil || !validOAuthProvider(input.Provider) || input.State == "" || len(input.State) > 512 || input.Code == "" || len(input.Code) > 2048 {
		writeError(w, http.StatusBadRequest, "invalid social OAuth callback")
		return
	}
	start, err := s.store.OAuthStart(r.Context(), actor, sessionID, input.State, input.Provider, nil)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusEXCHANGED || start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED {
		receipt, err := s.store.ClaimOAuthExchange(r.Context(), actor, sessionID, input.State, input.Provider)
		if err != nil {
			writeOAuthStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, receipt)
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.Organization)
	exchanger, supported := s.verifier.(socialOAuthExchanger)
	if err != nil || binding == nil || binding.SecretReference != start.SecretReference || !supported {
		writeError(w, http.StatusConflict, "social connection is unavailable for this workspace")
		return
	}
	xVerifier, verifiesX := s.verifier.(xIdentityVerifier)
	if input.Provider == "x" && !verifiesX {
		writeError(w, http.StatusServiceUnavailable, "X account verification is unavailable")
		return
	}
	receipt, err := s.store.ClaimOAuthExchange(r.Context(), actor, sessionID, input.State, input.Provider)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	if receipt != nil {
		writeJSON(w, http.StatusOK, receipt)
		return
	}
	connected, err := exchanger.ExchangeOAuth(r.Context(), input.Provider, input.Code, input.State)
	if err != nil {
		writeError(w, http.StatusBadGateway, "social provider rejected the callback")
		return
	}
	if input.Provider == "x" {
		account, err := xVerifier.VerifyX(r.Context(), socialapi.VerifyDestinationInput{
			DestinationID: connected.ID, Platform: "x", ExpectedGoOrganizationID: binding.GoOrganizationID, SecretReference: start.SecretReference,
		})
		if err != nil || account.Validate("x", connected.ID) != nil {
			writeError(w, http.StatusConflict, "X account identity or read and write access could not be verified")
			return
		}
		connected.Account = account
	}
	if err := s.store.SaveOAuthExchange(r.Context(), actor, sessionID, input.State, input.Provider, connected); err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, connected)
}

type oauthPageRequest struct {
	Provider      string `json:"provider"`
	State         string `json:"state"`
	IntegrationID string `json:"integrationId"`
	AccountID     string `json:"accountId"`
	PageID        string `json:"pageId"`
}

func (s *Server) selectSocialOAuthPage(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	var input oauthPageRequest
	if decodeJSON(r, &input) != nil || input.State == "" || len(input.State) > 512 ||
		input.IntegrationID == "" || len(input.IntegrationID) > 160 || input.AccountID == "" ||
		len(input.AccountID) > 160 || input.PageID == "" || len(input.PageID) > 160 {
		writeError(w, http.StatusBadRequest, "invalid account selection")
		return
	}
	if input.Provider == "" {
		input.Provider = "instagram"
	}
	if !socialidentity.RequiresPageSelection(input.Provider) {
		writeError(w, http.StatusBadRequest, "provider does not support account selection")
		return
	}
	start, err := s.store.OAuthStart(r.Context(), actor, sessionID, input.State, input.Provider, &input.IntegrationID)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED {
		writeJSON(w, http.StatusOK, map[string]bool{"selected": true})
		return
	}
	allowed := false
	for _, page := range start.ExchangeReceipt.Pages {
		if page.ID == input.AccountID && page.PageID == input.PageID {
			allowed = true
			break
		}
	}
	if !allowed {
		writeError(w, http.StatusBadRequest, "choose an account offered by this authorization")
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.Organization)
	exchanger, supported := s.verifier.(socialOAuthExchanger)
	if err != nil || binding == nil || binding.SecretReference != start.SecretReference || !supported {
		writeError(w, http.StatusConflict, "social connection is unavailable for this workspace")
		return
	}
	if err := exchanger.SelectInstagramPage(r.Context(), input.IntegrationID, input.AccountID, input.PageID, input.State); err != nil {
		writeError(w, http.StatusBadGateway, "provider account selection failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"selected": true})
}

func (s *Server) beginSocialOAuth(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	input, ok := decodeOAuthRequest(w, r, false, false)
	if !ok {
		return
	}
	instanceOrigin := ""
	if input.Provider == "mastodon-custom" {
		if os.Getenv("PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED") != "true" {
			writeError(w, http.StatusServiceUnavailable, "custom Mastodon authorization is not enabled")
			return
		}
		var err error
		instanceOrigin, err = instances.Origin(input.InstanceServer)
		if err != nil {
			writeError(w, http.StatusBadRequest, instances.ErrInvalidOrigin.Error())
			return
		}
	} else if input.InstanceServer != "" {
		writeError(w, http.StatusBadRequest, "this provider does not accept an instance server")
		return
	}
	options, binding, _, ok := s.prepareConnectionStart(w, r, actor, sessionID, input)
	if !ok {
		return
	}
	if s.verifier == nil {
		writeError(w, http.StatusServiceUnavailable, "social OAuth is unavailable")
		return
	}
	raw, err := s.verifier.BeginOAuth(r.Context(), socialapi.BeginOAuthInput{
		ExpectedGoOrganizationID: binding.GoOrganizationID,
		Provider:                 input.Provider, SecretReference: binding.SecretReference,
		InstanceOrigin: instanceOrigin,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "social OAuth is unavailable")
		return
	}
	authorizationURL, state, err := validatedAuthorizationURL(raw, input.Provider, instanceOrigin)
	if err != nil {
		writeError(w, http.StatusBadGateway, "social provider returned an invalid authorization URL")
		return
	}
	if err := s.store.StartOAuth(r.Context(), actor, sessionID, state, input.Provider, binding.SecretReference, options); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"url": authorizationURL})
}

func (s *Server) verifySocialOAuth(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	input, ok := decodeOAuthRequest(w, r, true, false)
	if !ok {
		return
	}
	var expected *string
	if input.IntegrationID != "" {
		expected = &input.IntegrationID
	}
	if _, err := s.store.OAuthStart(r.Context(), actor, sessionID, input.State, input.Provider, expected); err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"valid": true})
}

func (s *Server) rememberSocialOAuth(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	input, ok := decodeOAuthRequest(w, r, true, true)
	if !ok {
		return
	}
	if !socialidentity.RequiresPageSelection(input.Provider) {
		writeError(w, http.StatusBadRequest, "provider does not support account selection")
		return
	}
	if err := s.store.RememberInstagramIntegration(r.Context(), actor, sessionID, input.State, input.IntegrationID, input.Provider); err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"saved": true})
}

func (s *Server) completeSocialOAuth(w http.ResponseWriter, r *http.Request) {
	actor, sessionID, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	input, ok := decodeOAuthRequest(w, r, true, true)
	if !ok {
		return
	}
	var expected *string
	if socialidentity.RequiresPageSelection(input.Provider) {
		expected = &input.IntegrationID
	}
	start, err := s.store.OAuthStart(r.Context(), actor, sessionID, input.State, input.Provider, expected)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusCOMPLETED {
		connection, err := s.store.FinishOAuth(r.Context(), actor, sessionID, input.State, input.Provider, input.IntegrationID)
		if err != nil {
			writeOAuthStoreError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, connectionResponse(r.Context(), connection))
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.Organization)
	if err != nil || binding == nil || binding.SecretReference != start.SecretReference || s.verifier == nil {
		writeError(w, http.StatusConflict, "social connection is unavailable for this workspace")
		return
	}
	if err := s.verifier.VerifyDestination(r.Context(), socialapi.VerifyDestinationInput{
		DestinationID: input.IntegrationID, ExpectedGoOrganizationID: binding.GoOrganizationID,
		Platform: input.Provider, SecretReference: start.SecretReference,
	}); err != nil {
		writeError(w, http.StatusConflict, "social destination could not be verified")
		return
	}
	if s.configuration != nil {
		if err := s.configuration.RequireChannel(r.Context(), actor.Organization, input.IntegrationID); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	connection, err := s.store.FinishOAuth(r.Context(), actor, sessionID, input.State, input.Provider, input.IntegrationID)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, connectionResponse(r.Context(), connection))
}

func writeOAuthStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, publishing.ErrNotFound) {
		writeError(w, http.StatusForbidden, "social connection expired; please start again")
		return
	}
	if errors.Is(err, publishing.ErrOAuthExchangeUncertain) || errors.Is(err, publishing.ErrOAuthIdentityMismatch) {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	writeStoreError(w, err)
}

func (s *Server) prepareConnectionStart(w http.ResponseWriter, r *http.Request, actor publishing.Actor, sessionID string, input oauthRequest) (publishing.OAuthStartOptions, *ent.SocialTenantBinding, string, bool) {
	var socialSetID *string
	if input.SocialSetID != "" {
		if s.configuration == nil {
			writeError(w, http.StatusServiceUnavailable, "social sets are unavailable")
			return publishing.OAuthStartOptions{}, nil, "", false
		}
		if err := s.configuration.AuthorizeSocialSetConnection(r.Context(), workspaceActor(r), input.SocialSetID); err != nil {
			writeStoreError(w, err)
			return publishing.OAuthStartOptions{}, nil, "", false
		}
		socialSetID = &input.SocialSetID
	}
	options := publishing.OAuthStartOptions{SocialSetID: socialSetID, ReturnPath: input.ReturnPath,
		Operation: input.Operation, CreationVisibility: input.CreationVisibility}
	if input.ExpectedConnectionID != "" {
		options.ExpectedConnectionID = &input.ExpectedConnectionID
	}
	if err := publishing.ValidateOAuthStartOptions(options); err != nil {
		writeError(w, http.StatusBadRequest, "choose one connection operation and its owner or target")
		return publishing.OAuthStartOptions{}, nil, "", false
	}
	if options.Operation == "CREATE_SET" && s.configuration != nil {
		if err := s.configuration.RequireChannel(r.Context(), actor.Organization, ""); err != nil {
			writeStoreError(w, err)
			return publishing.OAuthStartOptions{}, nil, "", false
		}
	}
	expected, err := s.store.PrepareOAuth(r.Context(), actor, sessionID, input.Provider, options)
	if err != nil {
		writeStoreError(w, err)
		return publishing.OAuthStartOptions{}, nil, "", false
	}
	binding, err := s.store.Binding(r.Context(), actor.Organization)
	if err != nil {
		writeStoreError(w, err)
		return publishing.OAuthStartOptions{}, nil, "", false
	}
	return options, binding, expected, true
}
