package platformai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStructuredDecodesTheReplyAndItsCost(t *testing.T) {
	var sent map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("request %s %s", r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&sent)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"` + "```json\\n{\\\"name\\\":\\\"Acme\\\"}\\n```" + `"}}],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.0123}}`))
	}))
	defer server.Close()
	client := &Client{APIKey: "key", BaseURL: server.URL, HTTP: server.Client(), Models: map[Role]string{RoleFast: "model-fast"}}
	var out struct{ Name string }
	usage, err := client.Structured(context.Background(), Request{Role: RoleFast, Schema: json.RawMessage(`{}`), SchemaName: "s", System: "sys", Prompt: "p"}, &out)
	if err != nil || out.Name != "Acme" || usage.Tokens() != 120 || usage.CostMicros() != 12_300 {
		t.Fatalf("out=%+v usage=%+v err=%v", out, usage, err)
	}
	system := sent["messages"].([]any)[0].(map[string]any)["content"].(string)
	if sent["model"] != "model-fast" || sent["response_format"].(map[string]any)["type"] != "json_schema" ||
		!strings.HasPrefix(system, "sys") || !strings.HasSuffix(system, "JSON Schema:\n{}") {
		t.Fatalf("sent %+v", sent)
	}
	// The web's provider rules: no endpoint that stores prompts, none that drops the schema.
	if provider, _ := sent["provider"].(map[string]any); provider["data_collection"] != "deny" || provider["require_parameters"] != true {
		t.Fatalf("provider rules sent %+v", sent["provider"])
	}
	// Claude 5.5 models reject a non-default temperature.
	if _, ok := sent["temperature"]; ok || sent["reasoning"].(map[string]any)["effort"] != "low" {
		t.Fatalf("sampling and reasoning sent %+v", sent)
	}
}

func TestStructuredClassifiesFailures(t *testing.T) {
	for status, retryable := range map[int]bool{429: true, 503: true, 400: false, 404: false} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) }))
		client := &Client{APIKey: "key", BaseURL: server.URL, HTTP: server.Client()}
		var out any
		_, err := client.Structured(context.Background(), Request{}, &out)
		var providerErr *Error
		if !errors.As(err, &providerErr) || providerErr.Retryable != retryable {
			t.Fatalf("status %d: %v", status, err)
		}
		server.Close()
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"not json"}}]}`))
	}))
	defer server.Close()
	var out any
	if _, err := (&Client{BaseURL: server.URL, HTTP: server.Client()}).Structured(context.Background(), Request{}, &out); !errors.Is(err, ErrSchema) {
		t.Fatalf("schema mismatch: %v", err)
	}
}

func TestFromEnvironmentNeedsAKeyAndIgnoresTheOverrideInProduction(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "")
	if FromEnvironment() != nil {
		t.Fatal("a client without a key")
	}
	t.Setenv("OPENROUTER_API_KEY", "key")
	t.Setenv("OPENROUTER_BASE_URL", "http://fake/api/v1/")
	t.Setenv("PLATFORM_AI_MODEL_FAST", "pinned")
	if c := FromEnvironment(); c.BaseURL != "http://fake/api/v1" || c.Models[RoleFast] != "pinned" || c.Models[RoleDeep] != defaultModels[RoleDeep] {
		t.Fatalf("client %+v", c)
	}
	t.Setenv("NODE_ENV", "production")
	if c := FromEnvironment(); c.BaseURL != defaultBaseURL {
		t.Fatalf("production used the override: %s", c.BaseURL)
	}
}
