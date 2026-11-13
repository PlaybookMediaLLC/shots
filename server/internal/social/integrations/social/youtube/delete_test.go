package youtube

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
)

// A delete sends videos.delete with the channel token; a record that is already gone reports 404.
func TestDeletePost(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.URL.RequestURI()+" "+r.Header.Get("Authorization"))
		if r.URL.RequestURI() == "/youtube/v3/videos?id=gone" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	old := youtubeAPI
	youtubeAPI = srv.URL
	defer func() { youtubeAPI = old }()
	account := &ent.Integration{Token: "tok"}
	if err := New().DeletePost(context.Background(), account, "abc123"); err != nil {
		t.Fatal(err)
	}
	var status interface{ HTTPStatus() int }
	if err := New().DeletePost(context.Background(), account, "gone"); !errors.As(err, &status) || status.HTTPStatus() != 404 {
		t.Fatalf("missing record = %v", err)
	}
	if len(got) != 2 || got[0] != "DELETE /youtube/v3/videos?id=abc123 Bearer tok" {
		t.Fatalf("requests %v", got)
	}
}
