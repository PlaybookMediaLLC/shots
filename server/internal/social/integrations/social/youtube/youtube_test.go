package youtube

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
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/youtube/googleapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var (
	_ integrations.Provider               = New()
	_ integrations.PendingPoster          = New()
	_ integrations.Reconnector            = New()
	_ integrations.Analytics              = New()
	_ integrations.PostAnalytics          = New()
	_ integrations.PageInformationFetcher = New()
	_ integrations.RefreshErrorMessager   = New()
)

func setup(t *testing.T, handler http.HandlerFunc) (*Provider, *httptest.Server) {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	saved := []string{youtubeAPI, uploadAPI, analyticsAPI, googleapi.TokenURL, googleapi.TokenInfoURL, googleapi.UserInfoURL}
	youtubeAPI, uploadAPI, analyticsAPI = srv.URL, srv.URL, srv.URL
	googleapi.TokenURL, googleapi.TokenInfoURL, googleapi.UserInfoURL = srv.URL+"/token", srv.URL+"/tokeninfo", srv.URL+"/userinfo"
	googleapi.RetryUnit = 0
	t.Cleanup(func() {
		youtubeAPI, uploadAPI, analyticsAPI = saved[0], saved[1], saved[2]
		googleapi.TokenURL, googleapi.TokenInfoURL, googleapi.UserInfoURL = saved[3], saved[4], saved[5]
	})
	p := New()
	p.RetryDelay = 0
	return p, srv
}

func TestAuthenticate(t *testing.T) {
	t.Setenv("YOUTUBE_CLIENT_ID", "cid")
	t.Setenv("YOUTUBE_CLIENT_SECRET", "secret")
	t.Setenv("FRONTEND_URL", "https://app.example")
	granted := strings.Join(scopes, " ")
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			if r.Form.Get("code") != "the-code" || r.Form.Get("grant_type") != "authorization_code" ||
				r.Form.Get("redirect_uri") != "https://app.example/integrations/social/youtube" || r.Form.Get("client_secret") != "secret" {
				t.Errorf("bad token form %v", r.Form)
			}
			w.Write([]byte(`{"access_token":"at","refresh_token":"rt","expires_in":3599}`))
		case "/tokeninfo":
			if r.Header.Get("Authorization") != "Bearer at" {
				t.Errorf("tokeninfo auth %q", r.Header.Get("Authorization"))
			}
			w.Write([]byte(`{"scope":"` + granted + `","expires_in":3599}`))
		case "/userinfo":
			w.Write([]byte(`{"id":"u1","name":"Jane","picture":"https://pic"}`))
		}
	})
	details, err := p.Authenticate(context.Background(), integrations.AuthenticateParams{Code: "the-code"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if details.AccessToken != "at" || details.RefreshToken != "rt" || details.ExpiresIn != 3599 || details.ID != "u1" || details.Name != "Jane" || details.Picture != "https://pic" {
		t.Fatalf("details %+v", details)
	}

	granted = "https://www.googleapis.com/auth/youtube"
	_, err = p.Authenticate(context.Background(), integrations.AuthenticateParams{Code: "the-code"}, nil)
	var scopesErr *integrations.NotEnoughScopes
	if !errors.As(err, &scopesErr) {
		t.Fatalf("want NotEnoughScopes, got %v", err)
	}
}

func TestGenerateAuthURL(t *testing.T) {
	t.Setenv("YOUTUBE_CLIENT_ID", "cid")
	t.Setenv("FRONTEND_URL", "https://app.example")
	res, _ := New().GenerateAuthURL(context.Background(), nil)
	want := "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent&state=" + res.State +
		"&redirect_uri=https%3A%2F%2Fapp.example%2Fintegrations%2Fsocial%2Fyoutube&scope=" +
		"https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile%20" +
		googleapi.EncodeURIComponent(strings.Join(scopes[1:], " ")) + "&response_type=code&client_id=cid"
	if res.URL != want || len(res.State) != 7 || len(res.CodeVerifier) != 11 {
		t.Fatalf("got %s", res.URL)
	}
}

func TestPostUploadsInChunksAndSetsThumbnail(t *testing.T) {
	video := []byte("0123456789")
	var thumbnailSet bool
	var srvURL string
	p, srv := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/video.mp4" && r.Method == http.MethodHead:
			w.Header().Set("Content-Length", "10")
		case r.URL.Path == "/video.mp4":
			if r.Header.Get("Range") != "bytes=0-9" {
				t.Errorf("range %q", r.Header.Get("Range"))
			}
			w.WriteHeader(http.StatusPartialContent)
			w.Write(video)
		case r.URL.Path == "/upload/youtube/v3/videos":
			if r.URL.Query().Get("uploadType") != "resumable" || r.Header.Get("X-Upload-Content-Length") != "10" {
				t.Errorf("session request %s %v", r.URL, r.Header)
			}
			body, _ := io.ReadAll(r.Body)
			want := `{"snippet":{"title":"My video","description":"hello","tags":["a b"]},"status":{"privacyStatus":"public","selfDeclaredMadeForKids":true}}`
			if string(body) != want {
				t.Errorf("session body %s", body)
			}
			w.Header().Set("Location", srvURL+"/session")
		case r.URL.Path == "/session" && r.Header.Get("Content-Range") == "bytes */10":
			w.WriteHeader(308) // probe: nothing uploaded yet
		case r.URL.Path == "/session":
			body, _ := io.ReadAll(r.Body)
			if r.Header.Get("Content-Range") != "bytes 0-9/10" || string(body) != string(video) {
				t.Errorf("chunk %q %q", r.Header.Get("Content-Range"), body)
			}
			w.Write([]byte(`{"id":"vid1"}`))
		case r.URL.Path == "/thumb.png":
			w.Write([]byte("png"))
		case r.URL.Path == "/upload/youtube/v3/thumbnails/set":
			body, _ := io.ReadAll(r.Body)
			thumbnailSet = r.URL.Query().Get("videoId") == "vid1" && r.URL.Query().Get("uploadType") == "media" && string(body) == "png"
			w.Write([]byte(`{}`))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL)
		}
	})
	srvURL = srv.URL
	settings, _ := json.Marshal(map[string]any{
		"title": "My video", "type": "public", "selfDeclaredMadeForKids": "yes",
		"tags":      []map[string]string{{"value": "a b", "label": "a b"}},
		"thumbnail": map[string]string{"id": "t", "path": srv.URL + "/thumb.png"},
	})
	res, err := p.Post(context.Background(), "i", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "hello", Settings: settings,
		Media: []integrations.MediaContent{{Type: "video", Path: srv.URL + "/video.mp4"}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res[0].PostID != "vid1" || res[0].ReleaseURL != "https://www.youtube.com/watch?v=vid1" || res[0].Status != "success" {
		t.Fatalf("got %+v", res[0])
	}
	if !thumbnailSet {
		t.Fatal("thumbnail was not set")
	}
}

func TestCheckPostStatus(t *testing.T) {
	status := 0
	p, srv := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if status == 308 {
			w.Header().Set("Range", "bytes=0-4")
		}
		w.WriteHeader(status)
		w.Write([]byte(`{"error":"x"}`))
	})
	raw := pendingData{UploadURI: srv.URL + "/session", VideoSize: 10, Path: "/v.mp4"}.raw()
	check := func() (*integrations.PendingCheckResponse, error) {
		return p.CheckPostStatus(context.Background(), "tok", raw, nil)
	}

	status = 308
	res, err := check()
	var data pendingData
	_ = json.Unmarshal(res.PendingData, &data)
	if err != nil || res.Status != "ready" || data.UploadedBytes != 5 {
		t.Fatalf("308: %+v %v", res, err)
	}

	status = 503
	if res, err := check(); err != nil || res.Status != "pending" {
		t.Fatalf("503: %+v %v", res, err)
	}

	status = 401
	if _, err := check(); temporalx.FailureType(err) != temporalx.TypeRefreshToken {
		t.Fatalf("401: %v", err)
	}

	status = 404
	if _, err := check(); temporalx.FailureType(err) != temporalx.TypeBadBody ||
		temporalx.FailureMessage(err) != "The upload session expired before the video was uploaded, please post again" {
		t.Fatalf("404: %v", err)
	}
}

func TestSessionErrorIsClassified(t *testing.T) {
	p, srv := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", "10")
			return
		}
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"errors":[{"reason":"invalidTitle"}]}}`))
	})
	_, err := p.PostPending(context.Background(), "i", "tok", []integrations.PostDetails{{
		Settings: json.RawMessage(`{"title":"t"}`), Media: []integrations.MediaContent{{Path: srv.URL + "/v.mp4"}},
	}}, nil)
	if temporalx.FailureType(err) != temporalx.TypeBadBody ||
		temporalx.FailureMessage(err) != "We have uploaded your video but we could not set the title. Title is too long." {
		t.Fatalf("got %v", err)
	}
}

func TestCheckValidity(t *testing.T) {
	p := New()
	for _, tc := range []struct {
		items [][]integrations.ValidityMedia
		want  string
	}{
		{nil, "You need one media"},
		{[][]integrations.ValidityMedia{{{Path: "a.png"}}}, "Item must be a video"},
		{[][]integrations.ValidityMedia{{{Path: "a.mp4"}, {Path: "b.mp4"}}}, "You need one media"},
		{[][]integrations.ValidityMedia{{{Path: "a.mp4"}}}, ""},
	} {
		if got, _ := p.CheckValidity(context.Background(), tc.items, nil, nil); got != tc.want {
			t.Errorf("%v: got %q want %q", tc.items, got, tc.want)
		}
	}
}

func TestValidate(t *testing.T) {
	var d SettingsDTO
	_ = json.Unmarshal([]byte(`{"type":"secret"}`), &d)
	got := d.Validate()
	if len(got) != 5 || got[0] != "title should not be null or undefined" || got[4] != "type must be one of the following values: public, private, unlisted" {
		t.Fatalf("got %q", got)
	}

	long := strings.Repeat("x", 250)
	_ = json.Unmarshal([]byte(`{"title":"ok title","type":"public","tags":[{"value":"a","label":"`+long+`"},{"value":"b","label":"`+long+`"},{"label":"c"}]}`), &d)
	got = d.Validate()
	if len(got) != 2 || got[0] != "The maximum allowed is 500 characters in total for all tags." || got[1] != "value must be a string" {
		t.Fatalf("got %q", got)
	}
}

func TestRefreshErrorMessage(t *testing.T) {
	err := &googleapi.Error{Status: 400, Body: `{"error":"invalid_grant","error_subtype":"invalid_rapt"}`}
	if !strings.HasPrefix(New().RefreshErrorMessage(err), "because your organization's Google Workspace") {
		t.Fatal("invalid_rapt not explained")
	}
	if New().RefreshErrorMessage(errors.New("other")) != "" {
		t.Fatal("unexpected message")
	}
}

func TestAnalyticsMarksAverages(t *testing.T) {
	p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"columnHeaders":[{"name":"day"},{"name":"averageViewDuration"},{"name":"likes"}],"rows":[["2025-01-01",12.5,3]]}`))
	})
	res, err := p.Analytics(context.Background(), "i", "tok", 7)
	if err != nil || len(res) != 6 {
		t.Fatalf("%+v %v", res, err)
	}
	for _, a := range res {
		if a.Average != (a.Label == "Average View Duration" || a.Label == "Average View Percentage") {
			t.Errorf("%s average=%v", a.Label, a.Average)
		}
	}
	if res[1].Data[0].Total != "12.5" || res[5].Data[0].Total != "3" || res[5].Data[0].Date != "2025-01-01" {
		t.Fatalf("data %+v %+v", res[1].Data, res[5].Data)
	}
}

func TestConfirmVideoRequiresProcessingAndSelectedChannel(t *testing.T) {
	savedInterval := processingPollInterval
	processingPollInterval = 0
	t.Cleanup(func() { processingPollInterval = savedInterval })
	for _, tc := range []struct {
		name, body string
		ok         bool
	}{
		{"processed", `{"items":[{"id":"video","snippet":{"channelId":"channel"},"status":{"uploadStatus":"processed","privacyStatus":"private"},"processingDetails":{"processingStatus":"succeeded"}}]}`, true},
		{"pending", `{"items":[{"id":"video","snippet":{"channelId":"channel"},"status":{"uploadStatus":"uploaded","privacyStatus":"private"},"processingDetails":{"processingStatus":"processing"}}]}`, false},
		{"wrong channel", `{"items":[{"id":"video","snippet":{"channelId":"other"},"status":{"uploadStatus":"processed","privacyStatus":"private"},"processingDetails":{"processingStatus":"succeeded"}}]}`, false},
		{"malformed", `{"items":null}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			p, _ := setup(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != http.MethodGet || r.URL.Query().Get("id") != "video" {
					t.Fatalf("unexpected mutation or identity")
				}
				io.WriteString(w, tc.body)
			})
			visibility, err := p.ConfirmVideo(context.Background(), "token", "video", "channel")
			if (err == nil) != tc.ok || tc.ok && visibility != "private" {
				t.Fatalf("visibility=%s err=%v", visibility, err)
			}
			if requests > 12 {
				t.Fatalf("unbounded checks: %d", requests)
			}
		})
	}
}
