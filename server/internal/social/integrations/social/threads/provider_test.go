package threads

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func setup(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	old, oldLoaded, oldPoll := graphURL, loadedDelay, pollInterval
	graphURL, loadedDelay, pollInterval = srv.URL, 0, 0
	t.Cleanup(func() { graphURL, loadedDelay, pollInterval = old, oldLoaded, oldPoll })
}

func TestAuthenticate(t *testing.T) {
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/oauth/access_token":
			if r.URL.Query().Get("code") != "c" {
				t.Errorf("code %q", r.URL.Query().Get("code"))
			}
			w.Write([]byte(`{"access_token":"short"}`))
		case "/access_token":
			if r.URL.Query().Get("access_token") != "short" {
				t.Errorf("exchange %s", r.URL.RawQuery)
			}
			w.Write([]byte(`{"access_token":"long"}`))
		case "/v1.0/me":
			w.Write([]byte(`{"id":"u1","username":"bob","threads_profile_picture_url":"pic"}`))
		}
	})
	got, err := New().Authenticate(context.Background(), integrations.AuthenticateParams{Code: "c"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "u1" || got.Name != "bob" || got.Username != "bob" || got.AccessToken != "long" || got.RefreshToken != "long" || got.Picture != "pic" || got.ExpiresIn < 57*86400 {
		t.Fatalf("%+v", got)
	}
}

func TestPostText(t *testing.T) {
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/u1/threads":
			if err := r.ParseMultipartForm(1 << 20); err != nil || r.FormValue("media_type") != "TEXT" || r.FormValue("text") != "hello" || r.FormValue("access_token") != "tok" {
				t.Errorf("form %v %v", err, r.MultipartForm)
			}
			w.Write([]byte(`{"id":"c1"}`))
		case "/v1.0/c1":
			w.Write([]byte(`{"status":"FINISHED"}`))
		case "/v1.0/u1/threads_publish":
			if r.URL.Query().Get("creation_id") != "c1" {
				t.Errorf("publish %s", r.URL.RawQuery)
			}
			w.Write([]byte(`{"id":"t1"}`))
		case "/v1.0/t1":
			w.Write([]byte(`{"id":"t1","permalink":"https://threads.net/t/1"}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	})
	got, err := New().Post(context.Background(), "u1", "tok", []integrations.PostDetails{{ID: "p1", Message: "hello"}}, &ent.Integration{InternalID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if got[0].PostID != "t1" || got[0].Status != "success" || got[0].ReleaseURL != "https://threads.net/t/1" {
		t.Fatalf("%+v", got)
	}
}

func TestExpiredTokenIsRefreshToken(t *testing.T) {
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"Error validating access token: Session has expired"}}`))
	})
	_, err := New().PostPending(context.Background(), "u1", "tok", []integrations.PostDetails{{ID: "p1", Message: "hello"}}, nil)
	if temporalx.FailureType(err) != temporalx.TypeRefreshToken || temporalx.FailureMessage(err) != "Threads access token expired" {
		t.Fatalf("%v", err)
	}
}

func TestContainerErrorIsBadBody(t *testing.T) {
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"ERROR","error_message":"UNKNOWN"}`))
	})
	_, err := New().CheckPostStatus(context.Background(), "tok", json.RawMessage(`{"step":"container","containerId":"c1"}`), &ent.Integration{})
	if temporalx.FailureMessage(err) != "Threads could not process the media, please check the media format and try again" {
		t.Fatalf("%v", err)
	}
}

func TestCheckPostStatusPublishedCompletes(t *testing.T) {
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"PUBLISHED"}`))
	})
	profile := "bob"
	got, err := New().CheckPostStatus(context.Background(), "tok", json.RawMessage(`{"step":"container","containerId":"c1"}`), &ent.Integration{Profile: &profile})
	if err != nil || got.Status != "completed" || got.PostID != "c1" || got.ReleaseURL != "https://www.threads.net/@bob" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestCarouselFlow(t *testing.T) {
	children := 0
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/u1/threads":
			q := r.URL.Query()
			if q.Get("media_type") == "CAROUSEL" {
				if q.Get("children") != "m0,m1" {
					t.Errorf("children %q", q.Get("children"))
				}
				w.Write([]byte(`{"id":"car"}`))
				return
			}
			if q.Get("is_carousel_item") != "true" || q.Get("image_url") == "" {
				t.Errorf("child %s", r.URL.RawQuery)
			}
			w.Write([]byte(`{"id":"m` + string(rune('0'+children)) + `"}`))
			children++
		default:
			w.Write([]byte(`{"status":"FINISHED"}`))
		}
	})
	p := New()
	integration := &ent.Integration{InternalID: "u1"}
	res, err := p.PostPending(context.Background(), "u1", "tok", []integrations.PostDetails{{ID: "p1", Message: "m", Media: []integrations.MediaContent{{Path: "https://x/a.png"}, {Path: "https://x/b.png"}}}}, integration)
	if err != nil {
		t.Fatal(err)
	}
	check, err := p.CheckPostStatus(context.Background(), "tok", res[0].PendingData, integration)
	if err != nil || check.Status != "ready" {
		t.Fatalf("%+v %v", check, err)
	}
	fin, err := p.FinalizePost(context.Background(), "tok", check.PendingData, integration)
	if err != nil || fin.Status != "pending" || string(fin.PendingData) != `{"step":"container","containerId":"car"}` {
		t.Fatalf("%+v %v", fin, err)
	}
}

// A mixed carousel keeps its order, and a video is sent as one by its stored
// type even when the signed URL names a QuickTime file.
func TestMixedCarouselSendsVideoByType(t *testing.T) {
	var children []string
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.URL.Path != "/v1.0/u1/threads" {
			w.Write([]byte(`{"status":"FINISHED"}`))
			return
		}
		if q.Get("media_type") == "CAROUSEL" {
			w.Write([]byte(`{"id":"car"}`))
			return
		}
		children = append(children, q.Get("media_type")+":"+q.Get("image_url")+q.Get("video_url"))
		w.Write([]byte(`{"id":"m` + strconv.Itoa(len(children)) + `"}`))
	})
	_, err := New().PostPending(context.Background(), "u1", "tok", []integrations.PostDetails{{ID: "p1", Message: "m", Media: []integrations.MediaContent{
		{Path: "https://x/a.png", Type: "image"}, {Path: "https://x/clip.mov?X-Amz-Signature=s", Type: "video"}}}}, &ent.Integration{InternalID: "u1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(children, " ") != "IMAGE:https://x/a.png VIDEO:https://x/clip.mov?X-Amz-Signature=s" {
		t.Fatalf("children %v", children)
	}
}

func TestCapitalize(t *testing.T) {
	if capitalize("vIEWS") != "Views" || number(12.0) != "12" {
		t.Fatal(capitalize("vIEWS"), number(12.0))
	}
}

func TestPollContainerAndReplyKeepNativeOptions(t *testing.T) {
	creates, publishes := 0, 0
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/u1/threads":
			creates++
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			if r.FormValue("media_type") != "TEXT" || r.FormValue("auto_publish_text") != "" {
				t.Error("poll bypassed container lifecycle")
			}
			var poll map[string]string
			if err := json.Unmarshal([]byte(r.FormValue("poll_attachment")), &poll); err != nil || poll["option_a"] != "Yes" || poll["option_b"] != "No" || len(poll) != 2 {
				t.Errorf("wrong poll: %v %v", poll, err)
			}
			if creates == 2 && r.FormValue("reply_to_id") != "root" {
				t.Error("reply relationship lost")
			}
			w.Write([]byte(`{"id":"c1"}`))
		case "/v1.0/c1":
			w.Write([]byte(`{"status":"FINISHED"}`))
		case "/v1.0/u1/threads_publish":
			publishes++
			w.Write([]byte(`{"id":"p1"}`))
		case "/v1.0/p1":
			w.Write([]byte(`{"permalink":"https://www.threads.net/@me/post/p1"}`))
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})
	p := New()
	post := integrations.PostDetails{ID: "poll", Message: "Choose", Poll: &integrations.PollDetails{Options: []string{"Yes", "No"}, DurationMinutes: 1440}}
	if _, err := p.Post(context.Background(), "u1", "tok", []integrations.PostDetails{post}, &ent.Integration{InternalID: "u1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Comment(context.Background(), "u1", "root", "", "tok", []integrations.PostDetails{post}, &ent.Integration{InternalID: "u1"}); err != nil {
		t.Fatal(err)
	}
	if creates != 2 || publishes != 2 {
		t.Fatalf("mutations: %d %d", creates, publishes)
	}
	post.Poll.DurationMinutes = 60
	if _, err := p.PostPending(context.Background(), "u1", "tok", []integrations.PostDetails{post}, &ent.Integration{InternalID: "u1"}); err == nil || creates != 2 {
		t.Fatal("invalid poll mutated provider")
	}
	post.Poll.DurationMinutes = 1440
	post.Media = []integrations.MediaContent{{Path: "https://example.com/image.png"}}
	if _, err := p.PostPending(context.Background(), "u1", "tok", []integrations.PostDetails{post}, &ent.Integration{InternalID: "u1"}); err == nil || creates != 2 {
		t.Fatal("media poll mutated provider")
	}
}

// The reply is live once threads_publish answers: a rate limit on reading its
// permalink must not fail it, or the publication would be resent.
func TestReplyPublishedWhenPermalinkIsRateLimited(t *testing.T) {
	publishes := 0
	setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/u1/threads":
			w.Write([]byte(`{"id":"c1"}`))
		case "/v1.0/c1":
			w.Write([]byte(`{"status":"FINISHED"}`))
		case "/v1.0/u1/threads_publish":
			publishes++
			w.Write([]byte(`{"id":"r1"}`))
		case "/v1.0/r1":
			w.WriteHeader(http.StatusTooManyRequests)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
		}
	})
	p := New()
	p.RetryDelay = 0
	profile := "me"
	got, err := p.Comment(context.Background(), "u1", "root", "", "tok", []integrations.PostDetails{{ID: "reply", Message: "more"}}, &ent.Integration{InternalID: "u1", Profile: &profile})
	if err != nil || publishes != 1 || len(got) != 1 || got[0].PostID != "r1" || got[0].ReleaseURL != "https://www.threads.net/@me" {
		t.Fatalf("got=%+v err=%v publishes=%d", got, err, publishes)
	}
}

func TestPostAnalyticsFailureIsNotEmptySuccess(t *testing.T) {
	setup(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":{"message":"permission denied"}}`))
	})
	if _, err := New().PostAnalytics(context.Background(), "u1", "tok", "p1", 0); err == nil {
		t.Fatal("permission failure was hidden")
	}
}

func TestPostAnalyticsPreservesZeroAndMissing(t *testing.T) {
	setup(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":[{"name":"views","values":[{"value":0}]},{"name":"likes","values":[]}]}`))
	})
	got, err := New().PostAnalytics(context.Background(), "u1", "tok", "p1", 0)
	if err != nil || len(got) != 1 || got[0].Data[0].Total != "0" {
		t.Fatalf("counters=%+v error=%v", got, err)
	}
}
