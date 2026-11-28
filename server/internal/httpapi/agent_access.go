package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/agentclients"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// Agent consent (RFC 026): the web's OAuth consent page validates a request,
// then records a signed-in owner's or admin's approval. The code it returns
// is exchanged for a workspace API key at /oauth/token (NewAgentOAuth).
func (s *Server) registerAgentAccess(mux *http.ServeMux) {
	mux.Handle("POST /v1/agent-authorizations/preview", s.authenticateProduct(http.HandlerFunc(s.previewAgentAuthorization)))
	mux.Handle("POST /v1/agent-authorizations", s.authenticateProduct(http.HandlerFunc(s.approveAgentAuthorization)))
	mux.Handle("POST /v1/agent-authorizations/revoke-client", s.authenticateProduct(http.HandlerFunc(s.revokeAgentClient)))
	mux.Handle("GET /v1/api-keys/me", s.authenticateProduct(http.HandlerFunc(s.currentAPIKeyInfo)))
}

func (s *Server) previewAgentAuthorization(w http.ResponseWriter, r *http.Request) {
	var input product.AgentAuthorizationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid agent authorization request")
		return
	}
	consent, err := s.configuration.DescribeAgentClient(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, consent)
}

func (s *Server) approveAgentAuthorization(w http.ResponseWriter, r *http.Request) {
	var input product.AgentAuthorizationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid agent authorization request")
		return
	}
	code, err := s.configuration.ApproveAgentAccess(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, code)
}

func (s *Server) revokeAgentClient(w http.ResponseWriter, r *http.Request) {
	var input product.RevokeAgentClientInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid agent revocation request")
		return
	}
	result, err := s.configuration.RevokeAgentClient(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) currentAPIKeyInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.configuration.GetCurrentAPIKeyInfo(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, info)
}

// AgentClientRegistry registers and authenticates the MCP authorization
// server's OAuth clients.
type AgentClientRegistry interface {
	RegisterAgentClient(context.Context, agentclients.Registration) (*agentclients.RegisteredClient, error)
	AuthenticateAgentClient(ctx context.Context, clientID, secret string) (bool, error)
}

// AgentCodeExchanger trades a consent code for its workspace API key.
type AgentCodeExchanger interface {
	ExchangeAgentCode(ctx context.Context, clientID, code, codeVerifier, redirectURI string) (*product.AgentToken, error)
}

// NewAgentOAuth serves the MCP authorization server's endpoints, with the
// social backend's request and response formats: dynamic client registration
// (RFC 7591) and the token endpoint, which trades a consent code for a
// workspace API key. Agents call them from anywhere, browsers included, and
// send no cookies, so any origin may.
func NewAgentOAuth(clients AgentClientRegistry, codes AgentCodeExchanger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("OPTIONS /oauth/register", oauthPreflight)
	mux.HandleFunc("OPTIONS /oauth/token", oauthPreflight)
	mux.HandleFunc("POST /oauth/register", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		var request agentclients.Registration
		if err := decodeOAuthBody(r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client_metadata", "error_description": "The registration request is malformed."})
			return
		}
		client, err := clients.RegisterAgentClient(r.Context(), request)
		var refused *agentclients.RegistrationError
		switch {
		case errors.As(err, &refused):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": refused.Code, "error_description": refused.Description})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
		default:
			writeJSON(w, http.StatusCreated, client)
		}
	})
	mux.HandleFunc("POST /oauth/token", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		var body struct {
			GrantType    string `json:"grant_type"`
			Code         string `json:"code"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			CodeVerifier string `json:"code_verifier"`
			RedirectURI  string `json:"redirect_uri"`
		}
		if err := decodeOAuthBody(r, &body); err != nil || body.GrantType == "" || body.Code == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		if body.GrantType != "authorization_code" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported_grant_type"})
			return
		}
		// client_secret_basic sends the credentials in the Authorization
		// header; client_secret_post and public clients send them in the body.
		clientID, secret := basicCredentials(r.Header.Get("Authorization"))
		if clientID == "" {
			clientID = body.ClientID
		}
		if secret == "" {
			secret = body.ClientSecret
		}
		if clientID == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
			return
		}
		authenticated, err := clients.AuthenticateAgentClient(r.Context(), clientID, secret)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
			return
		}
		if !authenticated {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
			return
		}
		token, err := codes.ExchangeAgentCode(r.Context(), clientID, body.Code, body.CodeVerifier, body.RedirectURI)
		if errors.Is(err, product.ErrInvalidGrant) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
			return
		}
		response := map[string]any{"access_token": token.AccessToken, "token_type": "bearer", "scope": strings.Join(token.Scopes, " ")}
		if token.ExpiresAt != nil {
			response["expires_in"] = int(time.Until(*token.ExpiresAt).Seconds())
		}
		writeJSON(w, http.StatusOK, response)
	})
	return mux
}

func oauthPreflight(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.WriteHeader(http.StatusNoContent)
}

// decodeOAuthBody reads a JSON or form body; OAuth clients post token
// requests as forms. Unknown fields are ignored, as RFC 7591 requires.
func decodeOAuthBody(r *http.Request, target any) error {
	data, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err != nil {
		return err
	}
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/x-www-form-urlencoded") {
		values, err := url.ParseQuery(string(data))
		if err != nil {
			return err
		}
		fields := map[string]any{}
		for key, value := range values {
			if len(value) == 1 {
				fields[key] = value[0]
			} else {
				fields[key] = value
			}
		}
		data, _ = json.Marshal(fields)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	return json.Unmarshal(data, target)
}

// basicCredentials reads client_secret_basic (RFC 6749 §2.3.1):
// "Basic base64(urlencode(id):urlencode(secret))", padded or not, standard
// or URL-safe base64.
func basicCredentials(header string) (clientID, secret string) {
	const prefix = "basic "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", ""
	}
	encoded := strings.TrimSpace(header[len(prefix):])
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		decoded, err := encoding.DecodeString(encoded)
		if err != nil {
			continue
		}
		rawID, rawSecret, ok := strings.Cut(string(decoded), ":")
		id, errID := url.PathUnescape(rawID)
		secret, errSecret := url.PathUnescape(rawSecret)
		if !ok || id == "" || errID != nil || errSecret != nil {
			return "", ""
		}
		return id, secret
	}
	return "", ""
}
