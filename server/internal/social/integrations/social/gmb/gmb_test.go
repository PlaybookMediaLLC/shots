package gmb

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var (
	_ integrations.Provider               = New()
	_ integrations.Reconnector            = New()
	_ integrations.Analytics              = New()
	_ integrations.PostAnalytics          = New()
	_ integrations.PageInformationFetcher = New()
)

func setup(t *testing.T, handler http.HandlerFunc) *Provider {
	t.Helper()
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	saved := [4]string{accountsAPI, informationAPI, localPostsAPI, performanceAPI}
	accountsAPI, informationAPI, localPostsAPI, performanceAPI = srv.URL, srv.URL, srv.URL, srv.URL
	t.Cleanup(func() {
		accountsAPI, informationAPI, localPostsAPI, performanceAPI = saved[0], saved[1], saved[2], saved[3]
	})
	p := New()
	p.RetryDelay = 0
	return p
}

func TestPostEvent(t *testing.T) {
	p := setup(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v4/accounts/1/locations/2/localPosts" || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("unexpected %s %v", r.URL, r.Header)
		}
		body, _ := io.ReadAll(r.Body)
		want := `{"languageCode":"en","summary":"hi","topicType":"EVENT","callToAction":{"actionType":"BOOK","url":"https://x.com"},` +
			`"media":[{"mediaFormat":"PHOTO","sourceUrl":"https://img/a.png"}],` +
			`"event":{"title":"Launch","schedule":{"startDate":{"year":2025,"month":3,"day":4},"endDate":{"year":2025,"month":3,"day":5},"startTime":{"hours":9,"minutes":30,"seconds":0,"nanos":0}}}}`
		if string(body) != want {
			t.Errorf("body\n%s\nwant\n%s", body, want)
		}
		w.Write([]byte(`{"name":"accounts/1/locations/2/localPosts/9"}`))
	})
	settings := json.RawMessage(`{"topicType":"EVENT","callToActionType":"BOOK","callToActionUrl":"https://x.com","eventTitle":"Launch","eventStartDate":"2025-03-04","eventEndDate":"2025-03-05","eventStartTime":"09:30"}`)
	res, err := p.Post(context.Background(), "accounts/1/locations/2", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "hi", Settings: settings, Media: []integrations.MediaContent{{Type: "image", Path: "https://img/a.png"}},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res[0].PostID != "accounts/1/locations/2/localPosts/9" || res[0].ReleaseURL != "https://business.google.com/locations/2" {
		t.Fatalf("got %+v", res[0])
	}
}

func TestPostRejected(t *testing.T) {
	p := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"name":"x","state":"REJECTED"}`))
	})
	_, err := p.Post(context.Background(), "accounts/1/locations/2", "tok", []integrations.PostDetails{{Message: "hi"}}, nil)
	if temporalx.FailureType(err) != temporalx.TypeBadBody ||
		temporalx.FailureMessage(err) != "Google rejected this post for a content policy violation. Please review the post content and try again." {
		t.Fatalf("got %v", err)
	}
}

func TestPostPermissionDenied(t *testing.T) {
	p := setup(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`{"error":{"status":"PERMISSION_DENIED"}}`))
	})
	_, err := p.Post(context.Background(), "accounts/1/locations/2", "tok", []integrations.PostDetails{{Message: "hi"}}, nil)
	if temporalx.FailureType(err) != temporalx.TypeRefreshToken {
		t.Fatalf("got %v", err)
	}
}

func TestPagesPaginatesAndPicksProfilePhoto(t *testing.T) {
	p := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/accounts":
			if r.URL.Query().Get("pageToken") == "" {
				w.Write([]byte(`{"accounts":[{"name":"accounts/1"}],"nextPageToken":"n"}`))
				return
			}
			w.Write([]byte(`{"accounts":[{"name":"accounts/2"}]}`))
		case "/v1/accounts/1/locations":
			if r.URL.Query().Get("readMask") != "name,title,storefrontAddress,metadata" {
				t.Errorf("readMask %q", r.URL.RawQuery)
			}
			w.Write([]byte(`{"locations":[{"name":"locations/10","title":"Shop"}]}`))
		case "/v1/accounts/2/locations":
			w.Write([]byte(`{"locations":[{"name":"locations/20"}]}`))
		case "/v1/locations/10/media":
			w.Write([]byte(`{"mediaItems":[{"mediaFormat":"PHOTO","googleUrl":"first"},{"mediaFormat":"PHOTO","googleUrl":"profile","locationAssociation":{"category":"PROFILE"}}]}`))
		default:
			w.Write([]byte(`{}`))
		}
	})
	pages, err := p.Pages(context.Background(), "tok")
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 2 || pages[0].ID != "accounts/1/locations/10" || pages[0].Name != "Shop" || pages[0].Picture.Data.URL != "profile" ||
		pages[1].Name != "Unnamed Location" || pages[1].LocationName != "locations/20" {
		t.Fatalf("got %+v", pages)
	}
}

func TestCheckValidity(t *testing.T) {
	p := New()
	for _, tc := range []struct {
		items    [][]integrations.ValidityMedia
		settings string
		want     string
	}{
		{[][]integrations.ValidityMedia{{{Path: "a.png"}, {Path: "b.png"}}}, `{}`, "Google My Business posts can only have one image"},
		{[][]integrations.ValidityMedia{{{Path: "a.mp4"}}}, `{}`, "Google My Business posts do not support video attachments"},
		{nil, `{"topicType":"EVENT"}`, "Event posts require an event title"},
		{nil, `{}`, ""},
	} {
		if got, _ := p.CheckValidity(context.Background(), tc.items, json.RawMessage(tc.settings), nil); got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
	}
}

func TestFormatDateAndTime(t *testing.T) {
	d := formatDate("2025-01-31")
	if *d.Year != 2025 || *d.Month != 1 || *d.Day != 31 {
		t.Fatalf("got %d-%d-%d", *d.Year, *d.Month, *d.Day)
	}
	now := time.Now()
	if d := formatDate(""); *d.Year != now.Year() || *d.Day != now.Day() {
		t.Fatal("empty date should be today")
	}
	if d := formatDate("garbage"); d.Year != nil {
		t.Fatal("invalid date should serialize as null")
	}
	if tm := formatTime("7:xx"); tm.Hours != 7 || tm.Minutes != 0 {
		t.Fatalf("got %+v", tm)
	}
}

func TestValidate(t *testing.T) {
	var d SettingsDTO
	_ = json.Unmarshal([]byte(`{"topicType":"","callToActionType":"BOOK","callToActionUrl":"not a url","offerRedeemUrl":"https://ok.com"}`), &d)
	got := d.Validate()
	if len(got) != 2 || got[0] != "topicType must be one of the following values: STANDARD, EVENT, OFFER" || got[1] != "callToActionUrl must be a URL address" {
		t.Fatalf("got %q", got)
	}
}

func TestALocationChosenInShotsIsFoundByItsID(t *testing.T) {
	p := setup(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/locations/10":
			w.Write([]byte(`{"name":"locations/10","title":"Shop"}`))
		default:
			w.Write([]byte(`{}`))
		}
	})
	// Shots passes the chosen location's id only; its location is in the path.
	info, err := p.FetchPageInformation(context.Background(), "tok", json.RawMessage(`{"id":"accounts/1/locations/10","page":"accounts/1/locations/10"}`))
	if err != nil || info.ID != "accounts/1/locations/10" || info.Name != "Shop" {
		t.Fatalf("info=%+v err=%v", info, err)
	}
	for _, id := range []string{"", "accounts/1", "accounts/1/locations/10/extra"} {
		if _, err := p.FetchPageInformation(context.Background(), "tok", json.RawMessage(`{"id":"`+id+`"}`)); err == nil {
			t.Fatalf("%q was taken for a location", id)
		}
	}
}
