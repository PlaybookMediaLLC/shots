package mastodon

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
)

// A delete sends DELETE /api/v1/statuses/{id} to the default instance; a record that is already gone reports 404.
func TestDeletePost(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.URL.RequestURI()+" "+r.Header.Get("Authorization"))
		if r.URL.RequestURI() == "/api/v1/statuses/43" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	t.Setenv("MASTODON_URL", srv.URL)
	account := &ent.Integration{Token: "tok"}
	if err := New().DeletePost(context.Background(), account, "42"); err != nil {
		t.Fatal(err)
	}
	var status interface{ HTTPStatus() int }
	if err := New().DeletePost(context.Background(), account, "43"); !errors.As(err, &status) || status.HTTPStatus() != 404 {
		t.Fatalf("missing record = %v", err)
	}
	if len(got) != 2 || got[0] != "DELETE /api/v1/statuses/42 Bearer tok" {
		t.Fatalf("requests %v", got)
	}
}
