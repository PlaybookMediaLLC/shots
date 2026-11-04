package socialapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type staticAssetReader struct{ body []byte }

func (s staticAssetReader) Read(context.Context, string, string) ([]byte, error) { return s.body, nil }

func TestUploadAssetStagesMediaWithoutCreatingSecondPost(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.URL.Path != "/upload" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "token" {
			t.Fatalf("unexpected social request: %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "media-1", "path": "https://r2.example/media-1.png"})
	}))
	defer server.Close()
	client := New(server.URL, server.Client(), staticAssetReader{body: []byte("png")})
	path, err := client.UploadAsset(context.Background(), PublishInput{
		AssetMediaType: "image/png", AssetObjectKey: "org/org-1/image.png",
		OrganizationID: "org-1", SecretReference: "SOCIAL_API_KEY_TEST",
	})
	if err != nil || path != "https://r2.example/media-1.png" || requests != 1 {
		t.Fatalf("path=%q requests=%d err=%v", path, requests, err)
	}
}

func TestOAuthExchangeAndInstagramSelectionUseSocialCallbackEndpoints(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch r.URL.Path {
		case "/integrations/social-connect/instagram":
			if body["code"] != "code" || body["state"] != "state" {
				t.Fatalf("exchange body = %#v", body)
			}
			_ = json.NewEncoder(w).Encode(OAuthExchange{ID: "integration", Pages: []OAuthPage{{ID: "account", PageID: "page"}}})
		case "/integrations/public/provider/integration/connect":
			if body["id"] != "account" || body["pageId"] != "page" || body["state"] != "state" {
				t.Fatalf("selection body = %#v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]bool{"success": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := New(server.URL+"/public/v1", server.Client(), nil)
	connected, err := client.ExchangeOAuth(context.Background(), "instagram", "code", "state")
	if err != nil || connected.ID != "integration" || len(connected.Pages) != 1 {
		t.Fatalf("connected=%#v err=%v", connected, err)
	}
	if err := client.SelectInstagramPage(context.Background(), "integration", "account", "page", "state"); err != nil || requests != 2 {
		t.Fatalf("requests=%d err=%v", requests, err)
	}
}

func TestPublishUploadsAssetAndCreatesPost(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "token" {
			t.Fatalf("authorization header = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/upload":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, header, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			body, _ := io.ReadAll(file)
			if string(body) != "png" || header.Header.Get("Content-Type") != "image/png" {
				t.Fatalf("unexpected upload body or media type")
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "media-1", "path": "/media/1"})
		case "/posts":
			if r.Method == http.MethodGet {
				_ = json.NewEncoder(w).Encode(map[string]any{"posts": []any{map[string]string{
					"id": "post-1", "releaseId": "provider-post-1", "state": "PUBLISHED",
				}}})
				return
			}
			var payload map[string]any
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload["type"] != "now" {
				t.Fatalf("unexpected payload: %#v", payload)
			}
			// The thread is one value per post: the post, then its reply.
			values := payload["posts"].([]any)[0].(map[string]any)["value"].([]any)
			if len(values) != 2 || values[1].(map[string]any)["content"] != "and more" ||
				len(values[1].(map[string]any)["image"].([]any)) != 1 {
				t.Fatalf("unexpected thread: %#v", values)
			}
			_ = json.NewEncoder(w).Encode([]map[string]string{{"postId": "post-1", "integration": "destination-1"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := New(server.URL, &http.Client{Timeout: time.Second}, staticAssetReader{body: []byte("png")})
	id, err := client.Publish(context.Background(), PublishInput{
		AssetMediaType: "image/png", AssetObjectKey: "org/org-1/input/asset/1/file.png",
		Caption: "hello", DestinationID: "destination-1", OrganizationID: "org-1",
		Platform: "x", ProviderSettings: map[string]any{"visibility": "public"}, SecretReference: "SOCIAL_API_KEY_TEST",
		Replies: []publishing.PublishReply{{Caption: "and more",
			Assets: []publishing.MediaAsset{{MediaType: "image/png", ObjectKey: "org/org-1/input/asset/2/file.png"}}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "post-1" {
		t.Fatalf("id = %q", id)
	}
	status, err := client.Status(context.Background(), StatusInput{PostID: id, SecretReference: "SOCIAL_API_KEY_TEST"})
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "PUBLISHED" || status.ProviderPostID != "provider-post-1" {
		t.Fatalf("status = %#v", status)
	}
}

func TestVerifyDestinationRequiresBoundOrganizationAndActiveIntegration(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "token" {
			t.Fatalf("missing service credential")
		}
		switch r.URL.Path {
		case "/me":
			_ = json.NewEncoder(w).Encode(map[string]any{"organization": map[string]string{"id": "go-org-1"}})
		case "/integrations":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"id": "destination-1", "identifier": "instagram-standalone", "disabled": false},
				{"id": "destination-2", "identifier": "x", "disabled": true},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := New(server.URL, server.Client(), nil)
	input := VerifyDestinationInput{DestinationID: "destination-1", ExpectedGoOrganizationID: "go-org-1", Platform: "instagram-standalone", SecretReference: "SOCIAL_API_KEY_TEST"}
	if err := client.VerifyDestination(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	input.ExpectedGoOrganizationID = "another-org"
	if err := client.VerifyDestination(context.Background(), input); err == nil {
		t.Fatal("destination from another Go organization was accepted")
	}
	input.ExpectedGoOrganizationID = "go-org-1"
	input.DestinationID = "destination-2"
	input.Platform = "x"
	if err := client.VerifyDestination(context.Background(), input); err == nil {
		t.Fatal("disabled destination was accepted")
	}
}

func TestBeginOAuthRequiresBoundOrganization(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "token" {
			t.Fatal("missing service credential")
		}
		switch r.URL.Path {
		case "/me":
			_ = json.NewEncoder(w).Encode(map[string]any{"organization": map[string]string{"id": "go-org-1"}})
		case "/social/x", "/social/linkedin-page", "/social/tiktok", "/social/youtube":
			_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://api.x.com/oauth/authorize?oauth_token=test"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := New(server.URL, server.Client(), nil)
	for _, provider := range []string{"x", "linkedin-page", "tiktok", "youtube"} {
		t.Run(provider, func(t *testing.T) {
			input := BeginOAuthInput{ExpectedGoOrganizationID: "go-org-1", Provider: provider, SecretReference: "SOCIAL_API_KEY_TEST"}
			url, err := client.BeginOAuth(context.Background(), input)
			if err != nil || url != "https://api.x.com/oauth/authorize?oauth_token=test" {
				t.Fatalf("url=%q err=%v", url, err)
			}
			input.ExpectedGoOrganizationID = "another-org"
			if _, err := client.BeginOAuth(context.Background(), input); err == nil {
				t.Fatal("another Go organization started OAuth")
			}
		})
	}
}

func TestPublishAcceptsLegacyReceipt(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/upload" {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "media-1", "path": "/media/1"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "post-legacy"})
	}))
	defer server.Close()
	client := New(server.URL, &http.Client{Timeout: time.Second}, staticAssetReader{body: []byte("png")})
	id, err := client.Publish(context.Background(), PublishInput{
		AssetMediaType: "image/png", AssetObjectKey: "file.png", Caption: "hello",
		DestinationID: "destination-1", OrganizationID: "org-1", Platform: "x", SecretReference: "SOCIAL_API_KEY_TEST",
	})
	if err != nil || id != "post-legacy" {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestPublishClassifiesRateLimit(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/upload" {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "media-1", "path": "/media/1"})
			return
		}
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer server.Close()
	client := New(server.URL, &http.Client{Timeout: time.Second}, staticAssetReader{body: []byte("png")})
	_, err := client.Publish(context.Background(), PublishInput{
		AssetMediaType: "image/png", AssetObjectKey: "org/org-1/input/asset/1/file.png",
		Caption: "hello", DestinationID: "destination-1", OrganizationID: "org-1",
		Platform: "x", SecretReference: "SOCIAL_API_KEY_TEST",
	})
	providerErr, ok := err.(*Error)
	if !ok || providerErr.Status != http.StatusTooManyRequests || providerErr.UnknownDelivery {
		t.Fatalf("unexpected error: %#v", err)
	}
}

func TestPublishTreatsServerErrorAsUncertainDelivery(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "token")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/upload" {
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "media-1", "path": "/media/1"})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	client := New(server.URL, server.Client(), staticAssetReader{body: []byte("png")})
	_, err := client.Publish(context.Background(), PublishInput{
		AssetMediaType: "image/png", AssetObjectKey: "org/org-1/file.png",
		Caption: "hello", DestinationID: "destination-1", OrganizationID: "org-1",
		Platform: "x", SecretReference: "SOCIAL_API_KEY_TEST",
	})
	providerErr, ok := err.(*Error)
	if !ok || providerErr.Status != http.StatusInternalServerError || !providerErr.UnknownDelivery {
		t.Fatalf("unexpected error: %#v", err)
	}
}

func TestBeginCustomMastodonForwardsOnlyValidatedInstance(t *testing.T) {
	t.Setenv("SOCIAL_API_KEY_TEST", "fixture")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		switch r.URL.Path {
		case "/me":
			_, _ = w.Write([]byte(`{"organization":{"id":"bound-org"}}`))
		case "/social/mastodon-custom":
			if r.URL.Query().Get("instance") != "https://example.social" || len(r.URL.Query()) != 1 {
				t.Error("instance was not safely encoded")
			}
			_, _ = w.Write([]byte(`{"url":"https://example.social/oauth/authorize?state=fixture"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	}))
	defer server.Close()
	client := New(server.URL, server.Client(), nil)
	input := BeginOAuthInput{ExpectedGoOrganizationID: "bound-org", Provider: "mastodon-custom", SecretReference: "SOCIAL_API_KEY_TEST", InstanceOrigin: "https://example.social"}
	if _, err := client.BeginOAuth(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal("organization was not verified before registration")
	}
	for _, origin := range []string{"", "example.social", "http://example.social", "https://127.0.0.1", "https://example.social/?secret=1"} {
		input.InstanceOrigin = origin
		if _, err := client.BeginOAuth(context.Background(), input); err == nil {
			t.Errorf("accepted %s", origin)
		}
	}
	if calls != 2 {
		t.Fatal("invalid origin reached the social API")
	}
}
