package instagram

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func setup(t *testing.T, mux *http.ServeMux) *Provider {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	old := origin
	origin = func(string) string { return srv.URL }
	t.Cleanup(func() { origin = old })
	p := New()
	p.RetryDelay = 0
	return p
}

func TestCarouselPendingFlow(t *testing.T) {
	statuses := map[string][]string{
		"c1":  {"IN_PROGRESS", "FINISHED"},
		"c2":  {"FINISHED"},
		"car": {"IN_PROGRESS", "FINISHED"},
	}
	var calls []string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/ig1/media", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("media_type") == "CAROUSEL" {
			if q.Get("children") != "c1,c2" || q.Get("collaborators") != `["bob"]` || q.Get("caption") != "Hi (there)!" {
				t.Errorf("carousel query %s", r.URL.RawQuery)
			}
			calls = append(calls, "carousel")
			w.Write([]byte(`{"id":"car"}`))
			return
		}
		if q.Get("is_carousel_item") != "true" || q.Has("collaborators") || q.Has("caption") {
			t.Errorf("child query %s", r.URL.RawQuery)
		}
		if q.Get("access_token") != "page" {
			t.Errorf("token %s", q.Get("access_token"))
		}
		if q.Get("image_url") == "https://cdn/1.jpg" {
			w.Write([]byte(`{"id":"c1"}`))
			return
		}
		w.Write([]byte(`{"id":"c2"}`))
	})
	mux.HandleFunc("GET /v25.0/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if r.URL.Query().Get("fields") == "permalink" {
			w.Write([]byte(`{"permalink":"https://instagram.com/p/` + id + `"}`))
			return
		}
		if r.URL.Query().Get("access_token") != "user" {
			t.Errorf("status check must use the user token")
		}
		list := statuses[id]
		status := list[0]
		if len(list) > 1 {
			statuses[id] = list[1:]
		}
		w.Write([]byte(`{"status_code":"` + status + `"}`))
	})
	mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, "publish:"+r.URL.Query().Get("creation_id"))
		w.Write([]byte(`{"id":"m1"}`))
	})
	p := setup(t, mux)
	ctx := context.Background()
	integration := &ent.Integration{InternalID: "ig1"}

	res, err := p.PostPending(ctx, "ig1", "page___user", []integrations.PostDetails{{
		ID: "post", Message: "Hi (there)!",
		Settings: json.RawMessage(`{"post_type":"post","collaborators":[{"label":"@@bob"}]}`),
		Media:    []integrations.MediaContent{{Path: "https://cdn/1.jpg"}, {Path: "https://cdn/2.jpg"}},
	}}, integration)
	if err != nil {
		t.Fatal(err)
	}
	if string(res[0].PendingData) != `{"type":"graph.facebook.com","postType":"carousel","containers":["c1","c2"],"message":"Hi (there)!","collaborators":["bob"]}` {
		t.Fatalf("pendingData %s", res[0].PendingData)
	}

	data := res[0].PendingData
	var steps []string
	for i := 0; i < 10; i++ {
		check, err := p.CheckPostStatus(ctx, "page___user", data, integration)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, "check:"+check.Status)
		if check.Status == "pending" {
			data = check.PendingData
			continue
		}
		result, err := p.FinalizePost(ctx, "page___user", check.PendingData, integration)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, "finalize:"+result.Status)
		if result.Status == "completed" {
			if result.PostID != "m1" || result.ReleaseURL != "https://instagram.com/p/m1" {
				t.Fatalf("%+v", result)
			}
			break
		}
		data = result.PendingData
	}
	if got := strings.Join(steps, " "); got != "check:pending check:ready finalize:pending check:pending check:ready finalize:completed" {
		t.Fatalf("steps %s", got)
	}
	if strings.Join(calls, ",") != "carousel,publish:car" {
		t.Fatalf("calls %v", calls)
	}
}

func TestSingleReelQuery(t *testing.T) {
	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/ig1/media", func(w http.ResponseWriter, r *http.Request) {
		query = r.URL.RawQuery
		w.Write([]byte(`{"id":"c1"}`))
	})
	p := setup(t, mux)
	ts := int64(1500)
	res, err := p.PostPending(context.Background(), "ig1", "page", []integrations.PostDetails{{
		ID: "post", Message: "a b",
		Settings: json.RawMessage(`{"post_type":"post","is_trial_reel":"true","audio":{"id":"a1","audio_volume":"40"}}`),
		Media:    []integrations.MediaContent{{Path: "https://cdn/v.mp4", ThumbnailTimestamp: &ts}},
	}}, &ent.Integration{})
	if err != nil {
		t.Fatal(err)
	}
	want := "video_url=https%3A%2F%2Fcdn%2Fv.mp4&media_type=REELS&thumb_offset=1500" +
		"&trial_params=%7B%22graduation_strategy%22%3A%22MANUAL%22%7D" +
		"&audio_configuration=%7B%22audio_id%22%3A%22a1%22%2C%22audio_volume%22%3A40%7D" +
		"&access_token=page&caption=a%20b"
	if query != want {
		t.Fatalf("query\n got %s\nwant %s", query, want)
	}
	if !strings.Contains(string(res[0].PendingData), `"postType":"single"`) {
		t.Fatalf("%s", res[0].PendingData)
	}
}

func TestSignedMediaURLsReachGraphIntact(t *testing.T) {
	imageURL := "https://r2.example/bucket/photo.jpg?X-Amz-Date=20261013T000000Z&X-Amz-Signature=abc%2Fdef"
	videoURL := "https://r2.example/bucket/clip.mp4?X-Amz-Date=20261013T000000Z&X-Amz-Signature=video"
	coverURL := "https://r2.example/bucket/cover.jpg?X-Amz-Date=20261013T000000Z&X-Amz-Signature=cover"
	movieURL := "https://r2.example/bucket/clip.mov?X-Amz-Date=20261013T000000Z&X-Amz-Signature=movie"
	tests := []struct {
		name, host, field, mediaURL, coverURL, kind string
	}{
		{"facebook-login-image", FacebookHost, "image_url", imageURL, "", ""},
		{"instagram-login-image", "graph.instagram.com", "image_url", imageURL, "", ""},
		{"reel-with-cover", FacebookHost, "video_url", videoURL, coverURL, ""},
		// The stored type, not the file name, makes a QuickTime upload a Reel.
		{"quicktime-reel", "graph.instagram.com", "video_url", movieURL, "", "video"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("POST /v25.0/ig1/media", func(w http.ResponseWriter, r *http.Request) {
				query := r.URL.Query()
				if got := query.Get(test.field); got != test.mediaURL {
					t.Errorf("%s = %q, want %q", test.field, got, test.mediaURL)
				}
				if got := query.Get("cover_url"); got != test.coverURL {
					t.Errorf("cover_url = %q, want %q", got, test.coverURL)
				}
				if query.Has("X-Amz-Date") || query.Has("X-Amz-Signature") {
					t.Errorf("signature escaped the media URL: %s", r.URL.RawQuery)
				}
				w.Write([]byte(`{"id":"c1"}`))
			})
			p := setup(t, mux)
			_, err := p.PostPendingOn(context.Background(), "ig1", "page", []integrations.PostDetails{{
				ID: "post", Media: []integrations.MediaContent{{Path: test.mediaURL, Thumbnail: test.coverURL, Type: test.kind}},
			}}, &ent.Integration{}, test.host)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestContainerErrorDisconnects(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v25.0/c1", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status_code":"ERROR","status":"Session key is malformed"}`))
	})
	p := setup(t, mux)
	_, err := p.CheckPostStatus(context.Background(), "tok", json.RawMessage(`{"type":"graph.facebook.com","postType":"single","containers":["c1"],"message":""}`), &ent.Integration{})
	if temporalx.FailureType(err) != temporalx.TypeDisconnect {
		t.Fatalf("got %v", err)
	}
}

func TestPublishErrorClassified(t *testing.T) {
	mux := http.NewServeMux()
	requests := 0
	mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"error_subcode":2207042}}`))
	})
	p := setup(t, mux)
	_, err := p.FinalizePost(context.Background(), "tok", json.RawMessage(`{"type":"graph.facebook.com","postType":"single","containers":["c1"],"message":""}`), &ent.Integration{InternalID: "ig1"})
	// The daily cap is a definite refusal with its reason, sent once.
	if temporalx.FailureType(err) != temporalx.TypeDailyLimit || temporalx.FailureMessage(err) != "You have reached the maximum of 25 posts per day, allowed for your account" || requests != 1 {
		t.Fatalf("got %v after %d requests", err, requests)
	}
}

// Once one story is live, any later failure leaves the outcome unknown: a
// resend would post that story again.
func TestStoriesFailingAfterTheFirstAreUnknown(t *testing.T) {
	for _, test := range []struct{ name, failing string }{
		{"second publish rate limited", "POST /v25.0/ig1/media_publish"},
		{"second status read rate limited", "GET /v25.0/s2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			published := map[string]int{}
			mux := http.NewServeMux()
			mux.HandleFunc("GET /v25.0/{id}", func(w http.ResponseWriter, r *http.Request) {
				if test.failing == "GET /v25.0/"+r.PathValue("id") {
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
				w.Write([]byte(`{"status_code":"FINISHED"}`))
			})
			mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
				id := r.URL.Query().Get("creation_id")
				if id == "s2" && test.failing == "POST /v25.0/ig1/media_publish" {
					w.WriteHeader(http.StatusTooManyRequests)
					return
				}
				published[id]++
				w.Write([]byte(`{"id":"m-` + id + `"}`))
			})
			p := setup(t, mux)
			_, err := p.FinalizePost(context.Background(), "tok", json.RawMessage(`{"type":"graph.facebook.com","postType":"stories","containers":["s1","s2"],"message":""}`), &ent.Integration{InternalID: "ig1"})
			if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || published["s1"] != 1 || published["s2"] != 0 {
				t.Fatalf("err=%v published=%v", err, published)
			}
		})
	}
}

// The comment is live once its POST answers: a rate limit on reading the
// parent's permalink must not fail it, or the publication would be resent.
func TestCommentPublishedWhenPermalinkIsRateLimited(t *testing.T) {
	comments := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v25.0/media1/comments", func(w http.ResponseWriter, r *http.Request) {
		comments++
		w.Write([]byte(`{"id":"c9"}`))
	})
	mux.HandleFunc("GET /v25.0/media1", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	})
	p := setup(t, mux)
	profile := "me"
	got, err := p.Comment(context.Background(), "ig1", "media1", "", "tok", []integrations.PostDetails{{ID: "reply", Message: "more"}}, &ent.Integration{Profile: &profile})
	if err != nil || comments != 1 || len(got) != 1 || got[0].PostID != "c9" || got[0].ReleaseURL != "https://www.instagram.com/me" {
		t.Fatalf("got=%+v err=%v comments=%d", got, err, comments)
	}
}

// A story that fails after an earlier story went live leaves the post partly
// published: a whole-post retry would post the first story again.
func TestLaterStoryFailureAfterALiveStoryIsUnknown(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v25.0/{container}", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status_code":"FINISHED"}`))
	})
	published := 0
	mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
		if published++; published == 1 {
			w.Write([]byte(`{"id":"story-1"}`))
			return
		}
		w.WriteHeader(400)
		w.Write([]byte(`{"error":{"error_subcode":2207042}}`))
	})
	p := setup(t, mux)
	_, err := p.FinalizePost(context.Background(), "tok", json.RawMessage(`{"type":"graph.facebook.com","postType":"stories","containers":["c1","c2"],"message":""}`), &ent.Integration{InternalID: "ig1"})
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || published != 2 {
		t.Fatalf("got %v after %d publish requests", err, published)
	}
}

// A status read that fails after an earlier story went live is as ambiguous
// as a failed publish: a definite outcome would invite posting it again.
func TestStatusFailureAfterALiveStoryIsUnknown(t *testing.T) {
	mux := http.NewServeMux()
	reads := 0
	mux.HandleFunc("GET /v25.0/{container}", func(w http.ResponseWriter, r *http.Request) {
		if reads++; reads == 1 {
			w.Write([]byte(`{"status_code":"FINISHED"}`))
			return
		}
		w.WriteHeader(401)
		w.Write([]byte(`{"error":{"message":"session has been invalidated"}}`))
	})
	mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"id":"story-1"}`))
	})
	p := setup(t, mux)
	_, err := p.FinalizePost(context.Background(), "tok", json.RawMessage(`{"type":"graph.facebook.com","postType":"stories","containers":["c1","c2"],"message":""}`), &ent.Integration{InternalID: "ig1"})
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery {
		t.Fatalf("got %v", err)
	}
}

// A container stays invisible until media_publish, so only it may be sent
// again after a server error; media_publish is sent once.
func TestOnlyContainersAreResentAfterAServerError(t *testing.T) {
	mux := http.NewServeMux()
	containers, publishes := 0, 0
	mux.HandleFunc("POST /v25.0/ig1/media", func(w http.ResponseWriter, r *http.Request) {
		if containers++; containers == 1 {
			w.WriteHeader(500)
			return
		}
		w.Write([]byte(`{"id":"c1"}`))
	})
	mux.HandleFunc("POST /v25.0/ig1/media_publish", func(w http.ResponseWriter, r *http.Request) {
		publishes++
		w.WriteHeader(500)
	})
	p := setup(t, mux)
	if id, err := p.postID(context.Background(), origin("")+"/v25.0/ig1/media?image_url=x&access_token=tok"); err != nil || id != "c1" || containers != 2 {
		t.Fatalf("container id=%q err=%v requests=%d", id, err, containers)
	}
	_, err := p.postID(context.Background(), origin("")+"/v25.0/ig1/media_publish?creation_id=c1&access_token=tok")
	if temporalx.FailureType(err) != temporalx.TypeUnknownDelivery || publishes != 1 {
		t.Fatalf("media_publish err=%v requests=%d", err, publishes)
	}
}

func TestCheckValidity(t *testing.T) {
	p := New()
	media := func(paths ...string) [][]integrations.ValidityMedia {
		var out []integrations.ValidityMedia
		for _, path := range paths {
			out = append(out, integrations.ValidityMedia{Path: path})
		}
		return [][]integrations.ValidityMedia{out}
	}
	cases := []struct {
		posts    [][]integrations.ValidityMedia
		settings string
		want     string
	}{
		{nil, `{}`, "Should have at least one media"},
		{media("a.jpg"), `{"is_trial_reel":true}`, "Trial Reels must be a video"},
		{media("a.mp4"), `{"post_type":"story","audio":{"id":"x"}}`, "Audio can only be added to Reels, not to Stories"},
		{media("a.mp4"), `{"post_type":"post","audio":{"id":"x"}}`, ""},
	}
	for _, c := range cases {
		if got, _ := p.CheckValidity(context.Background(), c.posts, json.RawMessage(c.settings), nil); got != c.want {
			t.Errorf("%s: got %q want %q", c.settings, got, c.want)
		}
	}
}

func TestInstagramDTOValidate(t *testing.T) {
	var dto InstagramDTO
	if err := json.Unmarshal([]byte(`{"graduation_strategy":"X","collaborators":[{}],"audio":{"audio_volume":"abc","video_volume":50}}`), &dto); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"post_type should not be null or undefined",
		"post_type must be one of the following values: post, story",
		"graduation_strategy must be one of the following values: MANUAL, SS_PERFORMANCE",
		"collaborators.0.label should not be null or undefined",
		"collaborators.0.label must be a string",
		"audio.id should not be null or undefined",
		"audio.id must be a string",
		"audio.audio_volume must not be greater than 100",
		"audio.audio_volume must not be less than 0",
		"audio.audio_volume must be a number conforming to the specified constraints",
	}
	if got := dto.Validate(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
}

func TestPostAnalyticsFailureIsNotEmptySuccess(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"error":{"message":"permission denied"}}`))
	})
	p := setup(t, mux)
	if _, err := p.PostAnalytics(context.Background(), "u1", "tok", "p1", 0); err == nil {
		t.Fatal("permission failure was hidden")
	}
}

func TestPostAnalyticsPreservesZeroAndMissing(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"data":[{"name":"views","values":[{"value":0}]},{"name":"likes","values":[]}]}`))
	})
	p := setup(t, mux)
	got, err := p.PostAnalytics(context.Background(), "u1", "tok", "p1", 0)
	if err != nil || len(got) != 1 || got[0].Data[0].Total != "0" {
		t.Fatalf("counters=%+v error=%v", got, err)
	}
}
