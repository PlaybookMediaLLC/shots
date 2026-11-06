package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/shotsapi"
)

func newUnitServer(t *testing.T) *httptest.Server {
	t.Helper()
	t.Setenv("PLATFORM_MCP_URL", "https://api.shots.test/mcp")
	t.Setenv("FRONTEND_URL", "https://shots.test")
	t.Setenv("OPENAI_OAUTH_CLIENT_ID", "")
	s, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler(http.NotFoundHandler()))
	t.Cleanup(ts.Close)
	return ts
}

func get(t *testing.T, url string, header ...string) (*http.Response, string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, url, nil)
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response, string(body)
}

// The tool surface is RFC 026's, and every schema is the one generated from
// the REST operation it names: there is no second spec to drift.
func TestToolsMirrorTheirOpenAPIOperations(t *testing.T) {
	tools, err := buildTools()
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range tools {
		names = append(names, tool.spec.Name)
		operation, err := shotsapi.Lookup(tool.spec.Name)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(tool.spec.InputSchema, operation.InputSchema) {
			t.Errorf("%s input schema is not the generated one", tool.spec.Name)
		}
		if operation.Scope == "" || !slices.Contains(product.APIKeyScopes, operation.Scope) {
			t.Errorf("%s scope %q is not an API key scope", tool.spec.Name, operation.Scope)
		}
		readOnly := operation.Method == http.MethodGet || tool.spec.Name == "captureScreenshot"
		if tool.spec.Annotations.ReadOnlyHint != readOnly {
			t.Errorf("%s readOnlyHint=%v", tool.spec.Name, tool.spec.Annotations.ReadOnlyHint)
		}
		destructive := *tool.spec.Annotations.DestructiveHint
		if destructive != (operation.Method == http.MethodDelete || tool.spec.Name == "cancelScheduledPost" || tool.spec.Name == "mutateDraftComment") {
			t.Errorf("%s destructiveHint=%v", tool.spec.Name, destructive)
		}
	}
	want := []string{"listReleases", "createRelease", "createAssetUploadUrl", "completeAssetUpload", "createAssetDownloadUrl",
		"deleteAsset", "captureScreenshot", "listCampaigns", "getCampaign", "createCampaign", "listApprovals", "requestCampaignReview",
		"scheduleCampaignPost", "listScheduledPosts", "createScheduledPost", "cancelScheduledPost", "listSocialSets", "getSocialSet", "updateSocialSetQueue", "lookupSocialSetMentions", "listCalendarPosts", "bestPostingTimes", "listContentDrafts", "getContentDraft", "createContentDraft", "createPost", "updateContentDraft", "deleteContentDraft", "listContentDraftPosts", "planContentDraft", "duplicateContentDraft", "updateContentDraftProperties", "listContentDraftActivity", "listDraftComments", "mutateDraftComment"}
	if !slices.Equal(names, want) {
		t.Fatalf("tools=%v", names)
	}
	// Scheduling reaches a public channel, and needs its own opt-in scope.
	for _, tool := range tools {
		switch tool.spec.Name {
		case "scheduleCampaignPost", "createScheduledPost", "cancelScheduledPost":
			if tool.operation.Scope != product.PostScheduleScope {
				t.Errorf("%s scope=%q", tool.spec.Name, tool.operation.Scope)
			}
		}
		if tool.spec.Name == "createPost" && tool.operation.Scope != product.PostPublishScope {
			t.Errorf("createPost scope=%q", tool.operation.Scope)
		}
		if publishes := tool.spec.Name == "scheduleCampaignPost" || tool.spec.Name == "createScheduledPost" || tool.spec.Name == "createPost"; publishes && !*tool.spec.Annotations.OpenWorldHint {
			t.Errorf("%s must carry openWorldHint", tool.spec.Name)
		}
	}
	// Approving stays human-only (RFC 019).
	for _, absent := range []string{"decideCampaignApproval", "transitionCampaign", "scheduleContentDraft", "reviewContentDraft"} {
		if slices.Contains(names, absent) {
			t.Fatalf("%s must not be an agent tool", absent)
		}
	}
}

// The mounts are routed without a ServeMux, so the handler sets the pattern a
// mux would: telemetry names the span and the request metric after it.
func TestMCPRequestsCarryTheirRoute(t *testing.T) {
	t.Setenv("PLATFORM_MCP_URL", "https://api.shots.test/mcp")
	t.Setenv("FRONTEND_URL", "https://shots.test")
	t.Setenv("OPENAI_OAUTH_CLIENT_ID", "")
	s, err := New(Config{})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/mcp-oauth-claude/", nil)
	s.Handler(http.NotFoundHandler()).ServeHTTP(httptest.NewRecorder(), request)
	if request.Pattern != "/mcp-oauth-claude" {
		t.Fatalf("pattern %q", request.Pattern)
	}
}

func TestProtectedResourceMetadataAndChallenges(t *testing.T) {
	ts := newUnitServer(t)

	response, body := get(t, ts.URL+"/.well-known/oauth-protected-resource/mcp")
	var resource ProtectedResourceMetadata
	if response.StatusCode != 200 || json.Unmarshal([]byte(body), &resource) != nil {
		t.Fatalf("metadata: %d %s", response.StatusCode, body)
	}
	if resource.Resource != "https://api.shots.test/mcp" ||
		!slices.Equal(resource.AuthorizationServers, []string{"https://api.shots.test/mcp-oauth-dynamic"}) ||
		!slices.Equal(resource.ScopesSupported, product.APIKeyScopes) {
		t.Fatalf("metadata=%+v", resource)
	}
	_, body = get(t, ts.URL+"/.well-known/oauth-protected-resource/mcp-oauth-chatgpt")
	if !strings.Contains(body, `"authorization_servers":["https://api.shots.test/mcp-oauth-chatgpt"]`) {
		t.Fatalf("chatgpt metadata=%s", body)
	}

	response, body = get(t, ts.URL+"/.well-known/oauth-authorization-server/mcp-oauth-dynamic")
	var issuer metadata
	_ = json.Unmarshal([]byte(body), &issuer)
	if response.StatusCode != 200 || issuer.AuthorizationEndpoint != "https://shots.test/oauth/authorize" ||
		issuer.TokenEndpoint != "https://api.shots.test/oauth/token" ||
		issuer.RegistrationEndpoint != "https://api.shots.test/oauth/register" ||
		!slices.Equal(issuer.ScopesSupported, product.APIKeyScopes) {
		t.Fatalf("issuer: %d %s", response.StatusCode, body)
	}
	if _, body = get(t, ts.URL+"/.well-known/oauth-authorization-server/mcp-oauth-chatgpt"); strings.Contains(body, "registration_endpoint") {
		t.Fatalf("the ChatGPT issuer advertised registration: %s", body)
	}

	// No credential: 401 with the RFC 9728 pointer, so OAuth clients start the flow.
	for _, mount := range []string{"/mcp", "/mcp-oauth-claude", "/mcp-oauth-chatgpt", "/mcp-oauth-dynamic"} {
		response, body = get(t, ts.URL+mount)
		want := `Bearer resource_metadata="https://api.shots.test/.well-known/oauth-protected-resource` + mount + `"`
		if response.StatusCode != 401 || response.Header.Get("WWW-Authenticate") != want || !strings.Contains(body, `"error":"unauthorized"`) {
			t.Fatalf("%s: %d %q %s", mount, response.StatusCode, response.Header.Get("WWW-Authenticate"), body)
		}
	}
	// A original-app-style key in the URL path, the SSE transport, and the root
	// well-known document are not served.
	for _, path := range []string{"/mcp/some-key", "/sse/some-key", "/message/some-key", "/mcp-oauth",
		"/.well-known/oauth-protected-resource"} {
		if response, _ := get(t, ts.URL+path); response.StatusCode != 404 {
			t.Fatalf("%s: %d", path, response.StatusCode)
		}
	}
}

func TestRequestIDsAndClientNames(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	request.Header.Set("X-Request-Id", "trace:1.2-3")
	request.Header.Set("User-Agent", "claude-code/1.0.80 (cli)")
	if requestID(request) != "trace:1.2-3" {
		t.Fatal("a valid request ID was replaced")
	}
	if clientName(&product.AgentKey{}, request) != "claude-code" {
		t.Fatal("the user agent product was not used")
	}
	if clientName(&product.AgentKey{ClientName: "Claude"}, request) != "Claude" {
		t.Fatal("an agent key's OAuth client was not used")
	}
	request.Header.Set("X-Request-Id", "ss_secret key")
	if id := requestID(request); id == "ss_secret key" || len(id) != 36 {
		t.Fatalf("an unsafe request ID was kept: %q", id)
	}
}

type countingLimiter struct{ counts map[string]int }

func (c *countingLimiter) Increment(_ context.Context, key string, amount int, _ time.Duration) (int, error) {
	c.counts[key] += amount
	return c.counts[key], nil
}

type brokenLimiter struct{}

func (brokenLimiter) Increment(context.Context, string, int, time.Duration) (int, error) {
	return 0, errors.New("redis down")
}

// A key gets the calls a REST key gets a minute; an unavailable counter skips
// the per-key limit, since writes stay metered by the workspace quota.
func TestPerKeyLimit(t *testing.T) {
	s := &Server{config: Config{Limiter: &countingLimiter{counts: map[string]int{}}}}
	for i := 0; i < callsPerKeyMinute; i++ {
		if f := s.limit(context.Background(), "key", "key_1", callsPerKeyMinute); f != nil {
			t.Fatalf("call %d refused", i+1)
		}
	}
	f := s.limit(context.Background(), "key", "key_1", callsPerKeyMinute)
	if f == nil || f.code != "rate_limited" || f.status != 429 || f.extra["retryAfter"].(int) < 1 {
		t.Fatalf("call over the limit: %+v", f)
	}
	if s.limit(context.Background(), "key", "key_2", callsPerKeyMinute) != nil {
		t.Fatal("one key's calls limited another")
	}
	s.config.Limiter = brokenLimiter{}
	if s.limit(context.Background(), "key", "key_1", callsPerKeyMinute) != nil {
		t.Fatal("an unavailable counter refused a call")
	}
}

func TestDomainErrorsUseTheRESTEnvelope(t *testing.T) {
	for err, want := range map[error]string{
		publishing.ErrNotFound: "not_found", publishing.ErrForbidden: "forbidden", publishing.ErrConflict: "conflict",
		product.ErrInvalidInput: "invalid_request", product.ErrStorageUnavailable: "upstream_unavailable",
		&product.FeatureNotEntitledError{Feature: "asset:delete", CurrentPlan: "free", RequiredPlan: "pro"}:      "workspace_feature_not_entitled",
		&product.QuotaExceededError{Limit: 300, Quota: "api:write:minute", ResetAt: time.Now().Add(time.Minute)}: "workspace_quota_exceeded",
		errors.New("boom"): "internal_error",
	} {
		f := failureFor(err)
		var body map[string]any
		_ = json.Unmarshal([]byte(f.result().Content[0].(*sdk.TextContent).Text), &body)
		if body["code"] != want || body["error"] != body["message"] || body["hint"] == "" || body["status"] != float64(f.status) {
			t.Errorf("%v: %v", err, body)
		}
	}
	if f := failureFor(publishing.ErrNotFound); strings.Contains(f.message, "publishing") {
		t.Fatalf("an internal sentinel leaked: %q", f.message)
	}
}
