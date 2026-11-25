package platformai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStructuredEncodesMultimodalImagesAndPreservesStringWithoutImages(t *testing.T) {
	var sent map[string]any
	httpClient := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			_ = json.NewDecoder(r.Body).Decode(&sent)
			body := `{"choices":[{"message":{"content":"{\"verified\":true,\"reason\":\"ok\"}"}}],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.001}}`
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewBufferString(body)), Header: http.Header{}}, nil
		}),
	}
	client := &Client{APIKey: "key", BaseURL: "https://openrouter.example/api/v1", HTTP: httpClient, Models: map[Role]string{RoleFast: "model-fast"}}

	var out struct {
		Verified bool   `json:"verified"`
		Reason   string `json:"reason"`
	}
	// With images (including an empty entry that must be skipped):
	_, err := client.Structured(context.Background(), Request{
		Role:       RoleFast,
		System:     "sys",
		Prompt:     "verify",
		Images:     []ImageInput{{MediaType: "image/jpeg", Base64: "abc123"}, {MediaType: "", Base64: ""}},
		Schema:     json.RawMessage(`{"type":"object"}`),
		SchemaName: "verify",
	}, &out)
	if err != nil || !out.Verified {
		t.Fatalf("multimodal err=%v out=%+v", err, out)
	}
	userMsg := sent["messages"].([]any)[1].(map[string]any)
	parts, ok := userMsg["content"].([]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("expected 2 multimodal content parts, got %#v", userMsg["content"])
	}
	imgPart := parts[1].(map[string]any)
	if imgPart["type"] != "image_url" || imgPart["image_url"].(map[string]any)["url"] != "data:image/jpeg;base64,abc123" {
		t.Fatalf("unexpected image part: %#v", imgPart)
	}

	// Without images: content stays a plain JSON string for broad model compatibility.
	sent = nil
	_, err = client.Structured(context.Background(), Request{
		Role:       RoleFast,
		System:     "sys",
		Prompt:     "plain",
		Schema:     json.RawMessage(`{"type":"object"}`),
		SchemaName: "verify",
	}, &out)
	if err != nil {
		t.Fatalf("plain err=%v", err)
	}
	userMsg = sent["messages"].([]any)[1].(map[string]any)
	if str, ok := userMsg["content"].(string); !ok || str != "plain" {
		t.Fatalf("expected plain string content, got %#v", userMsg["content"])
	}
}

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
