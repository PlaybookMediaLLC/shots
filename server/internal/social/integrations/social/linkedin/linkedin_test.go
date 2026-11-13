package linkedin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var (
	_ integrations.Provider         = (*Provider)(nil)
	_ integrations.PendingPoster    = (*Provider)(nil)
	_ integrations.Commenter        = (*Provider)(nil)
	_ integrations.MentionFormatter = (*Provider)(nil)
)

type call struct {
	method, path string
	header       http.Header
	body         []byte
}

// fake serves every LinkedIn endpoint from one server and records the calls.
type fake struct {
	mu     sync.Mutex
	calls  []call
	routes map[string]http.HandlerFunc // "METHOD /path"
}

func (f *fake) find(method, path string) []call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []call
	for _, c := range f.calls {
		if c.method == method && c.path == path {
			out = append(out, c)
		}
	}
	return out
}

func newFake(t *testing.T, routes map[string]http.HandlerFunc) (*fake, *httptest.Server) {
	if routes == nil {
		routes = map[string]http.HandlerFunc{}
	}
	f := &fake{routes: routes}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, call{r.Method, r.URL.Path, r.Header.Clone(), body})
		f.mu.Unlock()
		if h, ok := routes[r.Method+" "+r.URL.Path]; ok {
			h(w, r)
			return
		}
		t.Errorf("unexpected call %s %s", r.Method, r.URL.String())
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	apiURL, wwwURL := APIURL, WWWURL
	APIURL, WWWURL = srv.URL, srv.URL
	t.Cleanup(func() { APIURL, WWWURL = apiURL, wwwURL })
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	return f, srv
}

func jsonReply(v any) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) { _ = json.NewEncoder(w).Encode(v) }
}

func pngBytes(t *testing.T, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFixText(t *testing.T) {
	got := FixText("Hi (all) @[Acme](urn:li:organization:42) #tag_x *b*")
	want := `Hi \(all\) @[Acme](urn:li:organization:42) \#tag\_x \*b\*`
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
	if got := FixText(`a\b`); got != `a\\b` {
		t.Fatalf("got %q", got)
	}
}

func TestCheckValidity(t *testing.T) {
	p := New()
	img := integrations.ValidityMedia{Path: "a.png"}
	vid := integrations.ValidityMedia{Path: "a.mp4"}
	cases := []struct {
		posts    [][]integrations.ValidityMedia
		settings string
		want     string
	}{
		{[][]integrations.ValidityMedia{{img}}, `{"post_as_images_carousel":true}`, "Carousel can only be created with 2 or more images and no videos."},
		{[][]integrations.ValidityMedia{{img, img}}, `{"post_as_images_carousel":"true"}`, ""},
		{[][]integrations.ValidityMedia{{img, vid}}, `{}`, "Can have maximum 1 media when selecting a video."},
		{[][]integrations.ValidityMedia{{img}, {img}}, `{}`, "Comments can only contain text."},
		{nil, ``, ""},
	}
	for i, c := range cases {
		got, _ := p.CheckValidity(context.Background(), c.posts, json.RawMessage(c.settings), nil)
		if got != c.want {
			t.Errorf("case %d: got %q want %q", i, got, c.want)
		}
	}
}

func TestDTOValidate(t *testing.T) {
	dto := &LinkedinDTO{}
	_ = json.Unmarshal([]byte(`{"post_as_images_carousel":"yes","carousel_name":3}`), dto)
	got := dto.Validate()
	if len(got) != 2 || got[0] != "post_as_images_carousel must be a boolean value" || got[1] != "carousel_name must be a string" {
		t.Fatalf("got %v", got)
	}
	if got := (&LinkedinDTO{PostAsImagesCarousel: true, CarouselName: "x"}).Validate(); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestEncodeURIComponent(t *testing.T) {
	if got := EncodeURIComponent("urn:li:share:1 (a)!*'~"); got != "urn%3Ali%3Ashare%3A1%20(a)!*'~" {
		t.Fatalf("got %q", got)
	}
}

func TestAuthenticate(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://app.example")
	t.Setenv("LINKEDIN_CLIENT_ID", "cid")
	t.Setenv("LINKEDIN_CLIENT_SECRET", "secret")
	f, _ := newFake(t, map[string]http.HandlerFunc{
		"POST /oauth/v2/accessToken": jsonReply(map[string]any{
			"access_token": "at", "refresh_token": "rt", "expires_in": 5184000, "scope": strings.Join(Scopes, ","),
		}),
		"GET /v2/userinfo": jsonReply(map[string]any{"name": "Jane", "sub": "abc", "picture": "https://pic"}),
		"GET /v2/me":       jsonReply(map[string]any{"vanityName": "jane"}),
	})
	got, err := New().Authenticate(context.Background(), integrations.AuthenticateParams{Code: "code", Refresh: "r1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := integrations.AuthTokenDetails{ID: "abc", Name: "Jane", AccessToken: "at", RefreshToken: "rt", ExpiresIn: 5184000, Picture: "https://pic", Username: "jane"}
	if !reflect.DeepEqual(*got, want) {
		t.Fatalf("got %+v", got)
	}
	form := string(f.find("POST", "/oauth/v2/accessToken")[0].body)
	for _, part := range []string{"grant_type=authorization_code", "code=code", "client_id=cid", "client_secret=secret",
		"redirect_uri=https%3A%2F%2Fapp.example%2Fintegrations%2Fsocial%2Flinkedin%3Frefresh%3Dr1"} {
		if !strings.Contains(form, part) {
			t.Errorf("form %q missing %q", form, part)
		}
	}
}

func TestAuthenticateMissingScopes(t *testing.T) {
	newFake(t, map[string]http.HandlerFunc{
		"POST /oauth/v2/accessToken": jsonReply(map[string]any{"access_token": "at", "scope": "openid,profile"}),
	})
	_, err := New().Authenticate(context.Background(), integrations.AuthenticateParams{Code: "code"}, nil)
	if _, ok := err.(*integrations.NotEnoughScopes); !ok {
		t.Fatalf("got %v", err)
	}
}

func TestGenerateAuthURL(t *testing.T) {
	t.Setenv("FRONTEND_URL", "https://app.example")
	t.Setenv("LINKEDIN_CLIENT_ID", "cid")
	got, _ := New().GenerateAuthURL(context.Background(), nil)
	want := "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=cid&redirect_uri=https%3A%2F%2Fapp.example%2Fintegrations%2Fsocial%2Flinkedin&state=" +
		got.State + "&scope=openid%20profile%20w_member_social"
	if got.URL != want || len(got.State) != 6 || len(got.CodeVerifier) != 30 {
		t.Fatalf("got %+v", got)
	}
}

// TestPostImage runs the legacy blocking Post: upload, one grace cycle, the
// arm/confirm handshake and the create.
func TestPostImage(t *testing.T) {
	pollInterval = 0
	f, srv := newFake(t, nil)
	f.routes["GET /media/a.png"] = func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(pngBytes(t, 4, 3)) }
	f.routes["POST /rest/images"] = jsonReply(map[string]any{"value": map[string]any{
		"uploadUrl": srv.URL + "/upload", "image": "urn:li:image:1",
	}})
	f.routes["PUT /upload"] = func(w http.ResponseWriter, _ *http.Request) {}
	f.routes["POST /rest/posts"] = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-restli-id", "urn:li:share:9")
		w.WriteHeader(http.StatusCreated)
	}

	got, err := New().Post(context.Background(), "person1", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "Hello (world)", Media: []integrations.MediaContent{{Type: "image", Path: srv.URL + "/media/a.png"}},
	}}, &ent.Integration{})
	if err != nil {
		t.Fatal(err)
	}
	want := integrations.PostResponse{ID: "p1", PostID: "urn:li:share:9", ReleaseURL: "https://www.linkedin.com/feed/update/urn:li:share:9", Status: "posted"}
	if len(got) != 1 || got[0].ID != want.ID || got[0].PostID != want.PostID || got[0].ReleaseURL != want.ReleaseURL || got[0].Status != want.Status {
		t.Fatalf("got %+v", got)
	}

	initCall := f.find("POST", "/rest/images")[0]
	if initCall.header.Get("LinkedIn-Version") != "202601" || initCall.header.Get("X-Restli-Protocol-Version") != "2.0.0" {
		t.Errorf("headers %v", initCall.header)
	}
	if string(initCall.body) != `{"initializeUploadRequest":{"owner":"urn:li:person:person1"}}` {
		t.Errorf("init body %s", initCall.body)
	}
	if _, err := png.Decode(bytes.NewReader(f.find("PUT", "/upload")[0].body)); err != nil {
		t.Errorf("uploaded image is not a png: %v", err)
	}
	var payload map[string]any
	_ = json.Unmarshal(f.find("POST", "/rest/posts")[0].body, &payload)
	if payload["author"] != "urn:li:person:person1" || payload["commentary"] != `Hello \(world\)` ||
		payload["content"].(map[string]any)["media"].(map[string]any)["id"] != "urn:li:image:1" {
		t.Errorf("payload %v", payload)
	}
}

func TestCheckPostStatusProcessingFailed(t *testing.T) {
	newFake(t, map[string]http.HandlerFunc{
		"GET /rest/videos/urn:li:video:1": jsonReply(map[string]any{"status": "PROCESSING_FAILED", "processingFailureReason": "bad codec"}),
	})
	data, _ := json.Marshal(pendingData{Poll: []pollMedia{{URN: "urn:li:video:1", Endpoint: "videos"}}})
	_, err := New().CheckPostStatus(context.Background(), "tok", data, nil)
	if temporalx.FailureType(err) != temporalx.TypeBadBody || temporalx.FailureMessage(err) != "LinkedIn video processing failed: bad codec" {
		t.Fatalf("got %v", err)
	}
}

func TestCheckPostStatusStalls(t *testing.T) {
	newFake(t, map[string]http.HandlerFunc{"GET /rest/images/urn:li:image:1": jsonReply(map[string]any{})})
	p := New()
	data, _ := json.Marshal(pendingData{Poll: []pollMedia{{URN: "urn:li:image:1", Endpoint: "images"}}, StatusStalls: 3})
	res, err := p.CheckPostStatus(context.Background(), "tok", data, nil)
	if err != nil || res.Status != "pending" || !strings.Contains(string(res.PendingData), `"statusStalls":4`) {
		t.Fatalf("got %+v %v", res, err)
	}
	data, _ = json.Marshal(pendingData{Poll: []pollMedia{{URN: "urn:li:image:1", Endpoint: "images"}}, StatusStalls: 10})
	_, err = p.CheckPostStatus(context.Background(), "tok", data, nil)
	if temporalx.FailureMessage(err) != "LinkedIn kept failing the media status check, nothing was published, please try again" {
		t.Fatalf("got %v", err)
	}
	data, _ = json.Marshal(pendingData{Attempting: true, Confirmed: true})
	if _, err = p.CheckPostStatus(context.Background(), "tok", data, nil); temporalx.FailureType(err) != temporalx.TypeBadBody {
		t.Fatalf("got %v", err)
	}
}

func TestCreatePostRejected(t *testing.T) {
	newFake(t, map[string]http.HandlerFunc{
		"POST /rest/posts": func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"message":"bad"}`))
		},
	})
	data, _ := json.Marshal(pendingData{AuthorID: "1", PostType: Company, Message: "x", MediaIDs: []string{}, Attempting: true, Confirmed: true})
	_, err := New().FinalizePost(context.Background(), "tok", data, nil)
	if temporalx.FailureType(err) != temporalx.TypePublicationRejected {
		t.Fatalf("got %v", err)
	}
}

func TestComment(t *testing.T) {
	f, _ := newFake(t, map[string]http.HandlerFunc{
		"POST /rest/socialActions/urn:li:share:9/comments": jsonReply(map[string]any{"object": "urn:li:activity:9", "id": "5"}),
	})
	got, err := New().Comment(context.Background(), "person1", "urn:li:share:9", "", "tok", []integrations.PostDetails{{ID: "c1", Message: "nice"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].ReleaseURL != "https://www.linkedin.com/feed/update/urn:li:activity:9?commentUrn=urn%3Ali%3Acomment%3A(urn%3Ali%3Aactivity%3A9%2C5)" {
		t.Fatalf("got %+v", got)
	}
	if v := f.find("POST", "/rest/socialActions/urn:li:share:9/comments")[0].header.Get("LinkedIn-Version"); v != Headers("", "")["LinkedIn-Version"] {
		t.Fatalf("version %q", v)
	}
}

// A delete removes a post or a comment as its author; a missing post reports 404.
func TestDeletePost(t *testing.T) {
	var actors []string
	deleted := func(w http.ResponseWriter, r *http.Request) {
		actors = append(actors, r.URL.Query().Get("actor"))
		w.WriteHeader(http.StatusNoContent)
	}
	f, _ := newFake(t, map[string]http.HandlerFunc{
		"DELETE /rest/posts/urn:li:share:9":                    deleted,
		"DELETE /rest/socialActions/urn:li:share:9/comments/5": deleted,
		"DELETE /rest/posts/urn:li:share:8":                    func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) },
	})
	ctx, member := context.Background(), &ent.Integration{Token: "tok", InternalID: "person1"}
	if err := New().DeletePost(ctx, member, "urn:li:share:9"); err != nil {
		t.Fatal(err)
	}
	if h := f.find("DELETE", "/rest/posts/urn:li:share:9")[0].header; h.Get("X-RestLi-Method") != "DELETE" || h.Get("Authorization") != "Bearer tok" {
		t.Fatalf("headers %v", h)
	}
	if err := New().DeletePost(ctx, member, "urn:li:comment:(urn:li:share:9,5)"); err != nil {
		t.Fatal(err)
	}
	if err := WithIdentifier("linkedin-page").DeletePost(ctx, &ent.Integration{Token: "tok", InternalID: "106"}, "urn:li:comment:(urn:li:share:9,5)"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actors, []string{"", "urn:li:person:person1", "urn:li:organization:106"}) {
		t.Fatalf("actors %v", actors)
	}
	var status interface{ HTTPStatus() int }
	if err := New().DeletePost(ctx, member, "urn:li:share:8"); !errors.As(err, &status) || status.HTTPStatus() != 404 {
		t.Fatalf("missing post = %v", err)
	}
}

func TestBuildPDF(t *testing.T) {
	pdf := buildPDF([]pdfImage{{jpeg: []byte("A"), width: 10, height: 20}, {jpeg: []byte("B"), width: 20, height: 20}}, 20, 20)
	s := string(pdf)
	if !strings.HasPrefix(s, "%PDF-1.3") || !strings.Contains(s, "/Count 2") || !strings.HasSuffix(s, "%%EOF\n") {
		t.Fatalf("bad pdf: %s", s)
	}
	// the narrow image is fitted and centered
	if !strings.Contains(s, "q 10.0000 0 0 20.0000 5.0000 0.0000 cm /I0 Do Q") {
		t.Fatalf("bad placement: %s", s)
	}
	// every xref offset points at its object
	xref := s[strings.Index(s, "xref\n"):]
	for i, line := range strings.Split(xref, "\n")[3:9] {
		off, _ := strconv.Atoi(line[:10])
		if !strings.HasPrefix(s[off:], strconv.Itoa(i+1)+" 0 obj") {
			t.Fatalf("xref %d wrong", i+1)
		}
	}
}

func TestPostPendingCarousel(t *testing.T) {
	f, srv := newFake(t, nil)
	f.routes["GET /media/a.png"] = func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(pngBytes(t, 4, 3)) }
	f.routes["GET /media/b.png"] = func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(pngBytes(t, 8, 8)) }
	f.routes["POST /rest/documents"] = jsonReply(map[string]any{"value": map[string]any{
		"uploadUrl": srv.URL + "/upload", "document": "urn:li:document:1",
	}})
	f.routes["PUT /upload"] = func(w http.ResponseWriter, _ *http.Request) {}

	got, err := New().PostPendingAs(context.Background(), "org1", "tok", []integrations.PostDetails{{
		ID: "p1", Message: "deck", Settings: json.RawMessage(`{"post_as_images_carousel":true,"carousel_name":"Q3"}`),
		Media: []integrations.MediaContent{{Path: srv.URL + "/media/a.png"}, {Path: srv.URL + "/media/b.png"}},
	}}, Company)
	if err != nil {
		t.Fatal(err)
	}
	var data pendingData
	_ = json.Unmarshal(got[0].PendingData, &data)
	if got[0].Status != "pending" || !data.IsPdf || data.PdfTitle != "Q3" || data.PostType != Company ||
		len(data.MediaIDs) != 1 || data.MediaIDs[0] != "urn:li:document:1" ||
		len(data.Poll) != 1 || data.Poll[0].Endpoint != "documents" || data.GraceChecks != 0 {
		t.Fatalf("got %s", got[0].PendingData)
	}
	put := f.find("PUT", "/upload")[0]
	if put.header.Get("Content-Type") != "application/pdf" || !bytes.HasPrefix(put.body, []byte("%PDF")) ||
		!bytes.Contains(put.body, []byte("/MediaBox [0 0 8 8]")) {
		t.Fatalf("upload %v %q", put.header, put.body[:40])
	}
}

func TestVideoUpload(t *testing.T) {
	f, srv := newFake(t, nil)
	video := bytes.Repeat([]byte{1}, 2*1024*1024+10)
	f.routes["HEAD /media/v.mp4"] = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(video)))
	}
	f.routes["GET /media/v.mp4"] = func(w http.ResponseWriter, r *http.Request) {
		http.ServeContent(w, r, "v.mp4", time.Time{}, bytes.NewReader(video))
	}
	f.routes["POST /rest/videos"] = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("action") == "finalizeUpload" {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"value": map[string]any{
			"video": "urn:li:video:1", "uploadInstructions": []any{map[string]any{"uploadUrl": srv.URL + "/upload"}},
		}})
	}
	n := 0
	f.routes["PUT /upload"] = func(w http.ResponseWriter, _ *http.Request) {
		n++
		w.Header().Set("etag", "e"+strconv.Itoa(n))
	}
	up, err := New().uploadPicture(context.Background(), srv.URL+"/media/v.mp4", "tok", "p1", nil, Personal, true)
	if err != nil {
		t.Fatal(err)
	}
	if up.ID != "urn:li:video:1" || up.Poll == nil || up.Poll.Endpoint != "videos" {
		t.Fatalf("got %+v", up)
	}
	puts := f.find("PUT", "/upload")
	if len(puts) != 2 || len(puts[0].body) != 2*1024*1024 || len(puts[1].body) != 10 {
		t.Fatalf("chunks %d", len(puts))
	}
	calls := f.find("POST", "/rest/videos")
	if !strings.Contains(string(calls[0].body), `"fileSizeBytes":2097162`) ||
		string(calls[1].body) != `{"finalizeUploadRequest":{"uploadToken":"","uploadedPartIds":["e1","e2"],"video":"urn:li:video:1"}}` {
		t.Fatalf("bodies %s / %s", calls[0].body, calls[1].body)
	}
}
