// Package mcp is the Shots MCP server (RFC 026): Streamable HTTP endpoints
// whose tools call the same domain services as the /v1 API, authenticated by
// workspace API keys. An OAuth access token is such a key, minted when a
// member approves an agent, so every call resolves to one workspace and key.
// It started as a port of the original app's start.mcp.ts and keeps its mounts and
// RFC 9728 metadata. The product API serves it on its public port, next to the
// OAuth endpoints in internal/httpapi.
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// mounts maps each MCP endpoint to the authorization server its RFC 9728
// metadata names. They serve the same tools: /mcp for API keys and any OAuth
// client, the others for the Claude and ChatGPT directories.
var mounts = map[string]string{
	"/mcp":               "/mcp-oauth-dynamic",
	"/mcp-oauth-dynamic": "/mcp-oauth-dynamic",
	"/mcp-oauth-claude":  "/mcp-oauth-dynamic",
	"/mcp-oauth-chatgpt": "/mcp-oauth-chatgpt",
}

// maxRequestBytes bounds one MCP request body.
const maxRequestBytes = 1 << 20

// Capturer takes the screenshot behind captureScreenshot.
type Capturer interface {
	CaptureWith(ctx context.Context, pageURL string, options capture.Options) ([]byte, error)
}

// Config is what the server needs from the platform.
type Config struct {
	Product *product.Configuration
	Capture Capturer
	// Limiter counts calls per key; nil skips the per-key limits, and writes
	// are still metered by the workspace quota, which fails closed.
	Limiter product.QuotaCounter
}

type authorizationServer struct {
	issuer       string
	registration bool
}

// Server is the MCP endpoints and their tools.
type Server struct {
	config               Config
	tools                []*shotsTool
	baseURL              string
	frontendURL          string
	enableOIDC           bool
	scopes               []string
	authorizationServers map[string]authorizationServer
}

// publicBaseURL is where clients reach the server: PLATFORM_MCP_URL without
// its /mcp.
func publicBaseURL() string {
	return strings.TrimSuffix(strings.TrimRight(os.Getenv("PLATFORM_MCP_URL"), "/"), "/mcp")
}

// New builds the server. It fails when a tool's operation is missing from the
// embedded OpenAPI document, so a contract change cannot ship a broken tool.
func New(config Config) (*Server, error) {
	tools, err := buildTools()
	if err != nil {
		return nil, err
	}
	base := publicBaseURL()
	s := &Server{config: config, tools: tools, baseURL: base, frontendURL: strings.TrimRight(os.Getenv("FRONTEND_URL"), "/"),
		enableOIDC: strings.TrimSpace(os.Getenv("OPENAI_OAUTH_CLIENT_ID")) != ""}
	if s.enableOIDC {
		s.scopes = append(s.scopes, "openid", "email")
	}
	s.scopes = append(s.scopes, product.APIKeyScopes...)
	// Two RFC 8414 path-based issuers backed by the same endpoints.
	// /mcp-oauth-chatgpt does not advertise registration, so the ChatGPT app
	// uses its predefined client; /mcp-oauth-dynamic keeps DCR for Claude,
	// Cursor, and every other self-registering client.
	s.authorizationServers = map[string]authorizationServer{
		"/mcp-oauth-chatgpt": {issuer: base + "/mcp-oauth-chatgpt", registration: false},
		"/mcp-oauth-dynamic": {issuer: base + "/mcp-oauth-dynamic", registration: true},
	}
	return s, nil
}

type metadata struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	RegistrationEndpoint              string   `json:"registration_endpoint,omitempty"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	GrantTypesSupported               []string `json:"grant_types_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
	ScopesSupported                   []string `json:"scopes_supported"`
	SubjectTypesSupported             []string `json:"subject_types_supported,omitempty"`
	ClaimsSupported                   []string `json:"claims_supported,omitempty"`
}

// authorizationServerMetadata is the RFC 8414 metadata of a path-based
// issuer. The person consents on the Shots web app.
func (s *Server) authorizationServerMetadata(server authorizationServer) metadata {
	m := metadata{
		Issuer:                            server.issuer,
		AuthorizationEndpoint:             s.frontendURL + "/oauth/authorize",
		TokenEndpoint:                     s.baseURL + "/oauth/token",
		ResponseTypesSupported:            []string{"code"},
		GrantTypesSupported:               []string{"authorization_code"},
		TokenEndpointAuthMethodsSupported: []string{"client_secret_basic", "client_secret_post", "none"},
		CodeChallengeMethodsSupported:     []string{"S256"},
		ScopesSupported:                   s.scopes,
	}
	if server.registration {
		m.RegistrationEndpoint = s.baseURL + "/oauth/register"
	}
	return m
}

func (s *Server) resourceMetadataURL(mount string) string {
	return s.baseURL + "/.well-known/oauth-protected-resource" + mount
}

func (s *Server) resourceMetadata(mount string) ProtectedResourceMetadata {
	return ProtectedResourceMetadata{
		Resource:               s.baseURL + mount,
		AuthorizationServers:   []string{s.authorizationServers[mounts[mount]].issuer},
		ScopesSupported:        product.APIKeyScopes,
		BearerMethodsSupported: []string{"header"},
		ResourceName:           "Shots",
		ResourceDocumentation:  s.frontendURL + "/docs/agents",
	}
}

func corsAll(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "*")
	h.Set("Access-Control-Allow-Headers", "*")
	h.Set("Access-Control-Expose-Headers", "*")
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// Handler serves the MCP routes and hands every other request to next.
func (s *Server) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/.well-known/openai-apps-challenge" || strings.HasPrefix(path, "/.well-known/openai-apps-challenge/"):
			if challenge := os.Getenv("OPENAI_APP_CHALLANGE"); challenge != "" {
				w.Header().Set("Content-Type", "text/plain")
				_, _ = w.Write([]byte(challenge))
				return
			}

		case strings.HasPrefix(path, "/.well-known/oauth-protected-resource/"):
			// Only the MCP mounts are protected resources; the root stays 404.
			mount := strings.TrimPrefix(path, "/.well-known/oauth-protected-resource")
			if _, ok := mounts[mount]; ok && (r.Method == http.MethodGet || r.Method == http.MethodOptions) {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				if r.Method == http.MethodOptions {
					w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.Header().Set("Cache-Control", "max-age=3600")
				writeJSON(w, http.StatusOK, s.resourceMetadata(mount))
				return
			}

		case strings.HasPrefix(path, "/.well-known/oauth-authorization-server/"), strings.HasPrefix(path, "/.well-known/openid-configuration/"):
			oidc := strings.HasPrefix(path, "/.well-known/openid-configuration/")
			rest := strings.TrimPrefix(strings.TrimPrefix(path, "/.well-known/oauth-authorization-server"), "/.well-known/openid-configuration")
			server, ok := s.authorizationServers[rest]
			if ok && (!oidc || s.enableOIDC) {
				w.Header().Set("Access-Control-Allow-Origin", "*")
				if r.Method == http.MethodOptions {
					w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
					w.WriteHeader(http.StatusNoContent)
					return
				}
				m := s.authorizationServerMetadata(server)
				if oidc {
					m.SubjectTypesSupported = []string{"public"}
					m.ClaimsSupported = []string{"sub", "email", "email_verified"}
				}
				w.Header().Set("Cache-Control", "max-age=3600")
				writeJSON(w, http.StatusOK, m)
				return
			}

		default:
			if mount := strings.TrimSuffix(path, "/"); mounts[mount] != "" {
				// The route a ServeMux would set: telemetry names the span and
				// the request metric after it.
				r.Pattern = mount
				s.serveMCP(w, r, mount)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// requestIDPattern matches the web's requestIdSchema: a caller's
// X-Request-Id is kept when it is short and free of separators.
var requestIDPattern = regexp.MustCompile(`^[\w.:-]{1,128}$`)

func requestID(r *http.Request) string {
	if supplied := strings.TrimSpace(r.Header.Get("X-Request-Id")); requestIDPattern.MatchString(supplied) {
		return supplied
	}
	return uuid.NewString()
}

// clientName names the calling agent for logs: the OAuth client an
// agent-issued key was minted for, else the User-Agent's product token.
func clientName(key *product.AgentKey, r *http.Request) string {
	if key.ClientName != "" {
		return key.ClientName
	}
	agent := strings.TrimSpace(r.UserAgent())
	if i := strings.IndexAny(agent, " /"); i > 0 {
		agent = agent[:i]
	}
	if agent == "" {
		return "unknown"
	}
	if len(agent) > 64 {
		agent = agent[:64]
	}
	return agent
}

// principal is who one MCP request acts as.
type principal struct {
	key       *product.AgentKey
	requestID string
	client    string
}

func (s *Server) challenge(w http.ResponseWriter, mount string, params ...Param) {
	w.Header().Set("WWW-Authenticate", GenerateWWWAuthenticateHeader(s.resourceMetadataURL(mount), params...))
	code, description := "unauthorized", "Send a Shots workspace API key as a Bearer token, or connect through OAuth."
	for _, p := range params {
		switch p.Key {
		case "error":
			code = p.Value
		case "error_description":
			description = p.Value
		}
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": code, "error_description": description})
}

// serveMCP authenticates the workspace API key, then serves one stateless
// Streamable HTTP request with the tools that key may call.
func (s *Server) serveMCP(w http.ResponseWriter, r *http.Request, mount string) {
	corsAll(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	token := ExtractBearerToken(r.Header.Get("Authorization"))
	if token == "" {
		token = strings.TrimSpace(r.Header.Get("X-API-Key"))
	}
	if token == "" {
		s.challenge(w, mount)
		return
	}
	key, err := s.config.Product.VerifyAPIKey(r.Context(), token)
	switch {
	case errors.Is(err, publishing.ErrUnauthorized):
		s.challenge(w, mount, Param{"error", "invalid_token"},
			Param{"error_description", "The API key is not valid, enabled, and unexpired."})
		return
	case errors.Is(err, publishing.ErrForbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden", "error_description": "This workspace is unavailable."})
		return
	case err != nil:
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "temporarily_unavailable",
			"error_description": "A required dependency is unavailable."})
		return
	}
	call := principal{key: key, requestID: requestID(r), client: clientName(key, r)}
	w.Header().Set("X-Request-Id", call.requestID)
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	// Clients that only accept JSON still get served.
	r.Header.Set("Accept", "application/json, text/event-stream")
	server := s.build(call)
	sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, &sdk.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		DisableLocalhostProtection: true,
	}).ServeHTTP(w, r)
}

// instructions tell an agent what Shots is and where its authority ends.
const instructions = `Shots writes, schedules, and publishes social posts to a workspace's connected accounts, and turns a software release into a reviewed launch.
To post: listSocialSets gives the accounts (accounts[].id); for media, createAssetUploadUrl, PUT the bytes to the returned URL, then completeAssetUpload; createPost then writes and schedules or publishes it in one call. It needs the post:publish scope. Confirm the text, the accounts, and the time with the user first, because it goes out to public accounts. Reuse the same idempotencyKey when retrying, and never post again after an unclear result: read listContentDraftPosts instead. A post can take up to a minute to start.
createContentDraft saves a draft for a person to review instead. Private social sets are not visible here; if no account is listed, ask the user to connect one in a shared set in Shots.
Only a person approves, in the Shots app; no tool can. With post:schedule you may schedule campaign posts a person approved, and cancel scheduled posts. listScheduledPosts shows the schedule.
With post:delete, deleteContentDraftPost deletes a published post from its platform, with its thread parts, replies and reposts. Confirm the post with the user first: the delete cannot be undone on the platform. Read listContentDraftPosts for each part's receipt.`

// build makes the MCP server for one request, with the tools the key's
// scopes allow.
func (s *Server) build(call principal) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{Name: "shots", Title: "Shots", Version: "1.0.0"},
		&sdk.ServerOptions{Instructions: instructions, Capabilities: &sdk.ServerCapabilities{Tools: &sdk.ToolCapabilities{}}})
	for _, tool := range s.tools {
		if !call.key.HasScope(tool.operation.Scope) {
			continue
		}
		server.AddTool(tool.spec, func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
			return s.call(ctx, call, tool, req.Params.Arguments), nil
		})
	}
	return server
}
