package pinterest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var (
	_ integrations.Provider      = New()
	_ integrations.PendingPoster = New()
	_ integrations.Analytics     = New()
	_ integrations.PostAnalytics = New()
)

func setup(t *testing.T, handler http.HandlerFunc) (*Provider, *httptest.Server) {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	saved, savedDelay := apiURL, pollDelay
	apiURL, pollDelay = srv.URL, 0
	t.Cleanup(func() { apiURL, pollDelay = saved, savedDelay })
	p := New()
	p.RetryDelay = 0
	return p, srv
}

func TestAuthenticate(t *testing.T) {
	t.Setenv("PINTEREST_CLIENT_ID", "cid")
	t.Setenv("PINTEREST_CLIENT_SECRET", "sec")
	t.Setenv("FRONTEND_URL", "https://app.example")
	scope := "boards:read,boards:write,pins:read,pins:write,user_accounts:read"
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v5/oauth/token":
			_ = r.ParseForm()
			if r.Header.Get("Authorization") != "Basic Y2lkOnNlYw==" || r.Form.Get("code") != "c" ||
				r.Form.Get("redirect_uri") != "https://app.example/integrations/social/pinterest" {
				t.Errorf("token request %v %v", r.Header, r.Form)
			}
			json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "refresh_token": "rt", "expires_in": 100, "scope": scope})
		case "/v5/user_account":
			w.Write([]byte(`{"id":"u1","profile_image":"pic","username":"jane"}`))
		}
	})
	details, err := p.Authenticate(context.Background(), integrations.AuthenticateParams{Code: "c"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if details.ID != "u1" || details.Name != "jane" || details.Username != "jane" || details.AccessToken != "at" || details.RefreshToken != "rt" || details.ExpiresIn != 100 || details.Picture != "pic" {
		t.Fatalf("got %+v", details)
	}

	scope = "boards:read"
	_, err = p.Authenticate(context.Background(), integrations.AuthenticateParams{Code: "c"}, nil)
	var scopesErr *integrations.NotEnoughScopes
	if !errors.As(err, &scopesErr) {
		t.Fatalf("want NotEnoughScopes, got %v", err)
	}
}

func TestGenerateAuthURL(t *testing.T) {
	t.Setenv("PINTEREST_CLIENT_ID", "cid")
	t.Setenv("FRONTEND_URL", "https://app.example")
	res, _ := New().GenerateAuthURL(context.Background(), nil)
	want := "https://www.pinterest.com/oauth/?client_id=cid&redirect_uri=https%3A%2F%2Fapp.example%2Fintegrations%2Fsocial%2Fpinterest" +
		"&response_type=code&scope=boards%3Aread%2Cboards%3Awrite%2Cpins%3Aread%2Cpins%3Awrite%2Cuser_accounts%3Aread&state=" + res.State
	if res.URL != want || len(res.State) != 6 || len(res.CodeVerifier) != 10 {
		t.Fatalf("got %s", res.URL)
	}
}

func TestPostImagesRunsHandshake(t *testing.T) {
	pins := 0
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v5/pins" {
			t.Errorf("unexpected %s", r.URL)
		}
		pins++
		body, _ := io.ReadAll(r.Body)
		want := `{"title":"T","description":"hello","board_id":"123","media_source":{"source_type":"multiple_image_urls","items":[{"url":"a.png"},{"url":"b.png"}]}}`
		if string(body) != want {
			t.Errorf("body %s", body)
		}
		w.Write([]byte(`{"id":"pin1"}`))
	})
	res, err := p.Post(context.Background(), "i", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "hello", Settings: json.RawMessage(`{"title":"T","board":"123"}`),
		Media: []integrations.MediaContent{{Path: "a.png"}, {Path: "b.png"}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if pins != 1 || res[0].PostID != "pin1" || res[0].ReleaseURL != "https://www.pinterest.com/pin/pin1" || res[0].Status != "success" {
		t.Fatalf("pins=%d %+v", pins, res[0])
	}
}

func TestPostPendingUploadsVideo(t *testing.T) {
	var form string
	var srvURL string
	p, srv := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v5/media":
			w.Write([]byte(`{"upload_url":"` + srvURL + `/s3","media_id":"m1","upload_parameters":{"key":"k","policy":"p","":"skip"}}`))
		case "/video.mp4":
			w.Header().Set("Content-Type", "video/mp4")
			w.Write([]byte("VIDEO"))
		case "/s3":
			if r.ContentLength <= 0 {
				t.Errorf("content length %d", r.ContentLength)
			}
			body, _ := io.ReadAll(r.Body)
			form = string(body)
			w.WriteHeader(204)
		}
	})
	srvURL = srv.URL
	res, err := p.PostPending(context.Background(), "i", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "m", Settings: json.RawMessage(`{"board":"1"}`),
		Media: []integrations.MediaContent{{Path: srv.URL + "/video.mp4"}, {Path: srv.URL + "/cover.png"}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key, policy, file := strings.Index(form, `name="key"`), strings.Index(form, `name="policy"`), strings.Index(form, `name="file"; filename="video.mp4"`)
	if key < 0 || policy < key || file < policy || !strings.Contains(form, "VIDEO") || strings.Contains(form, "skip") {
		t.Fatalf("form %q", form)
	}
	var data pendingData
	_ = json.Unmarshal(res[0].PendingData, &data)
	if data.MediaID != "m1" || data.CoverPath != srv.URL+"/cover.png" || data.Settings.Board != "1" || len(data.ImagePaths) != 2 {
		t.Fatalf("pending %+v", data)
	}
}

func TestCheckPostStatus(t *testing.T) {
	status := "failed"
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"` + status + `"}`))
	})
	check := func(raw string) (*integrations.PendingCheckResponse, error) {
		return p.CheckPostStatus(context.Background(), "tok", json.RawMessage(raw), nil)
	}

	if _, err := check(`{"mediaId":"","attempting":true,"confirmed":true}`); temporalx.FailureMessage(err) !=
		"Pinterest may have already published this pin, please check your account before posting again to avoid duplicates" {
		t.Fatalf("duplicate guard: %v", err)
	}
	if _, err := check(`{"mediaId":"m"}`); temporalx.FailureMessage(err) != "The file is corrupted and cannot be uploaded" {
		t.Fatalf("failed: %v", err)
	}
	status = "processing"
	if res, err := check(`{"mediaId":"m"}`); err != nil || res.Status != "pending" {
		t.Fatalf("processing: %+v %v", res, err)
	}
	status = "succeeded"
	res, err := check(`{"mediaId":"m","attempting":true}`)
	var data pendingData
	_ = json.Unmarshal(res.PendingData, &data)
	if err != nil || res.Status != "ready" || !data.Confirmed {
		t.Fatalf("witness: %+v %v", res, err)
	}
}

func TestCheckValidity(t *testing.T) {
	p := New()
	media := func(paths ...string) [][]integrations.ValidityMedia {
		var items []integrations.ValidityMedia
		for _, path := range paths {
			items = append(items, integrations.ValidityMedia{Path: path})
		}
		return [][]integrations.ValidityMedia{items}
	}
	for _, tc := range []struct {
		items [][]integrations.ValidityMedia
		want  string
	}{
		{nil, "Requires at least one media"},
		{media("1.png", "2.png", "3.png", "4.png", "5.png", "6.png"), "You can only have up to 5 media items"},
		{media("a.mp4"), "If posting a video you have to also include a cover image as second media"},
		{media("a.mp4", "b.png", "c.png"), "If posting a video you can only have two media items"},
		{media("a.mp4", "b.png"), ""},
	} {
		if got, _ := p.CheckValidity(context.Background(), tc.items, nil, nil); got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
	}
}

func TestHandleErrors(t *testing.T) {
	got := handleErrors(`{"message":"board_id: 'abc' does not match '^\\d+$'"}`, 400)
	if got == nil || got.Value != "The board ID must be a numeric string. Please check the board ID format." {
		t.Fatalf("got %+v", got)
	}
	if got := handleErrors("Unable to reach the URL", 400); got == nil || got.Type != "retry" {
		t.Fatalf("got %+v", got)
	}
}

func TestValidate(t *testing.T) {
	var d SettingsDTO
	if got := d.Validate(); len(got) != 4 || got[0] != "Board is required" {
		t.Fatalf("missing board: %q", got)
	}
	_ = json.Unmarshal([]byte(`{"board":"My board","link":"nope"}`), &d)
	got := d.Validate()
	if len(got) != 2 || got[0] != "link must be a URL address" || !strings.HasPrefix(got[1], "Board must be the numeric board id") {
		t.Fatalf("got %q", got)
	}
}

func TestAnErrorAnswerIsNeverReadAsNoBoards(t *testing.T) {
	status := http.StatusUnauthorized
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		w.Write([]byte(`{"code":2,"message":"Authentication failed."}`))
	})
	if boards, err := p.Boards(context.Background(), "revoked"); err == nil {
		t.Fatalf("a refused token listed boards %v", boards)
	}
	status = http.StatusOK
	if boards, err := p.Boards(context.Background(), "token"); err != nil || len(boards) != 0 {
		t.Fatalf("an account with no boards: %v %v", boards, err)
	}
}

func TestRefreshKeepsAPassingFailureApartFromARefusedGrant(t *testing.T) {
	t.Setenv("PINTEREST_CLIENT_ID", "cid")
	t.Setenv("PINTEREST_CLIENT_SECRET", "sec")
	status := http.StatusServiceUnavailable
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v5/oauth/token":
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]any{"access_token": "new", "refresh_token": "rotated", "expires_in": 100})
		case "/v5/user_account":
			w.Write([]byte(`{"id":"u1","username":"jane"}`))
		}
	})
	for _, passing := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		status = passing
		if _, err := p.RefreshToken(context.Background(), "old"); !errors.Is(err, integrations.ErrRefreshUnavailable) {
			t.Fatalf("%d: %v, want a retry on the next run", passing, err)
		}
	}
	status = http.StatusBadRequest
	if _, err := p.RefreshToken(context.Background(), "old"); err == nil || errors.Is(err, integrations.ErrRefreshUnavailable) {
		t.Fatalf("a refused grant: %v, want a reconnect", err)
	}
	status = http.StatusOK
	details, err := p.RefreshToken(context.Background(), "old")
	if err != nil || details.AccessToken != "new" || details.RefreshToken != "rotated" {
		t.Fatalf("refresh = %+v, %v; want the rotated refresh token kept", details, err)
	}
}
