package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

func TestPrivateMediaSigningAndObjectExistence(t *testing.T) {
	exists := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.URL.Path != "/tenant-assets/org/org-1/input/asset-1/1/image.png" {
			t.Errorf("unexpected object request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if !exists {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	store, err := NewS3Store(server.URL, "https://browser.example", "us-east-1", "tenant-assets", "test-key", "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	key := "org/org-1/input/asset-1/1/image.png"
	upload, err := store.SignUpload(context.Background(), key, "image/png")
	if err != nil || !strings.HasPrefix(upload, "https://browser.example/tenant-assets/"+key+"?") || !strings.Contains(upload, "X-Amz-Signature=") || !strings.Contains(upload, "if-none-match") {
		t.Fatalf("upload URL=%q err=%v", upload, err)
	}
	download, err := store.SignDownload(context.Background(), key)
	if err != nil || !strings.Contains(download, "X-Amz-Signature=") {
		t.Fatalf("download URL=%q err=%v", download, err)
	}
	delivery, err := NewTenantObjects(store).SignDelivery(context.Background(), "org-1", key)
	if err != nil || !strings.HasPrefix(delivery, server.URL+"/tenant-assets/"+key+"?") || !strings.Contains(delivery, "X-Amz-Expires=86400") {
		t.Fatalf("delivery URL=%q err=%v", delivery, err)
	}
	if found, err := store.Exists(context.Background(), key); err != nil || found {
		t.Fatalf("missing object found=%v err=%v", found, err)
	}
	exists = true
	if found, err := store.Exists(context.Background(), key); err != nil || !found {
		t.Fatalf("existing object found=%v err=%v", found, err)
	}
}

func TestTenantObjectAccessRejectsForeignAndUnsafeKeys(t *testing.T) {
	objects := NewTenantObjects(&S3Store{})
	for _, key := range []string{
		"org/org-2/input/asset-1/1/image.png",
		"org/org-1/../asset-1/image.png",
		"org/org-1/input/asset-1/1/image space.png",
	} {
		if _, err := objects.Read(context.Background(), "org-1", key); err == nil {
			t.Errorf("unsafe object read accepted: %q", key)
		}
		if err := objects.Delete(context.Background(), "org-1", key); err == nil {
			t.Errorf("unsafe object delete accepted: %q", key)
		}
		if _, err := objects.SignDelivery(context.Background(), "org-1", key); err == nil {
			t.Errorf("unsafe object delivery accepted: %q", key)
		}
	}
	for _, id := range []string{"", "..", "event/../org-1", "event 1"} {
		if err := objects.RecordDeletion(context.Background(), time.Now(), id, []byte(`{}`)); err == nil {
			t.Errorf("unsafe deletion ledger entry accepted: %q", id)
		}
	}
}

func TestEnvironmentDeliveryEndpointPreservesInternalStorage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Errorf("unexpected request method: %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	t.Setenv("R2_ENDPOINT", server.URL)
	t.Setenv("R2_BROWSER_ENDPOINT", "https://browser.example")
	t.Setenv("R2_REGION", "us-east-1")
	t.Setenv("R2_BUCKET_NAME", "tenant-assets")
	t.Setenv("R2_ACCESS_KEY_ID", "test-key")
	t.Setenv("R2_SECRET_ACCESS_KEY", "test-secret")
	for _, endpoint := range []string{"", "https://delivery.example", "https://delivery.example?invalid=true"} {
		t.Run(endpoint, func(t *testing.T) {
			t.Setenv("R2_DELIVERY_ENDPOINT", endpoint)
			store, err := NewS3StoreFromEnvironment()
			if strings.Contains(endpoint, "?") {
				if err == nil {
					t.Fatal("invalid delivery endpoint accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if found, err := store.Exists(context.Background(), "org/org-1/input/asset-1/1/video.mp4"); err != nil || !found {
				t.Fatalf("internal storage check: found=%v err=%v", found, err)
			}
			delivery, err := store.SignDelivery(context.Background(), "org/org-1/input/asset-1/1/video.mp4")
			if endpoint == "" {
				endpoint = server.URL
			}
			if err != nil || !strings.HasPrefix(delivery, endpoint+"/tenant-assets/") || !strings.Contains(delivery, "X-Amz-Expires=86400") {
				t.Fatal("delivery did not use the configured origin and expiry")
			}
			upload, err := store.SignUpload(context.Background(), "org/org-1/input/asset-1/1/video.mp4", "video/mp4")
			if err != nil || !strings.HasPrefix(upload, "https://browser.example/") {
				t.Fatal("delivery configuration changed the browser upload origin")
			}
		})
	}
}

// A large file goes in parts through signed URLs; the server lists and
// completes them, and an abort after completion is not an error.
func TestMultipartUploadThroughSignedParts(t *testing.T) {
	server := httptest.NewServer(gofakes3.New(s3mem.New(), gofakes3.WithAutoBucket(true)).Server())
	defer server.Close()
	store, err := NewS3Store(server.URL, server.URL, "us-east-1", "tenant-assets", "test-key", "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "org/org-1/input/asset-1/1/clip.mp4"
	uploadID, err := store.CreateMultipartUpload(ctx, key, "video/mp4")
	if err != nil || uploadID == "" {
		t.Fatalf("upload=%q err=%v", uploadID, err)
	}
	parts := [][]byte{bytes.Repeat([]byte("a"), 5<<20), []byte("tail")}
	put := func(number int, body []byte) {
		t.Helper()
		url, err := store.SignUploadPart(ctx, key, uploadID, number, int64(len(body)))
		if err != nil || !strings.Contains(url, "partNumber="+strconv.Itoa(number)) || !strings.Contains(url, "content-length") {
			t.Fatalf("part URL=%q err=%v", url, err)
		}
		request, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
		response, err := http.DefaultClient.Do(request)
		if err != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("part %d: %v %v", number, response, err)
		}
		response.Body.Close()
	}
	put(2, parts[1])
	put(1, []byte("a part sent before a dropped connection"))
	put(1, parts[0]) // sent again; storage keeps the latest
	listed, err := store.ListUploadedParts(ctx, key, uploadID)
	if err != nil || len(listed) != 2 || listed[0].Number != 1 || listed[0].Bytes != 5<<20 || listed[1].Bytes != 4 || listed[0].ETag == "" {
		t.Fatalf("parts=%+v err=%v", listed, err)
	}
	if exists, _ := store.Exists(ctx, key); exists {
		t.Fatal("an unfinished upload is not an object")
	}
	if err := store.CompleteMultipartUpload(ctx, key, uploadID, listed); err != nil {
		t.Fatal(err)
	}
	object, err := store.Open(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := io.ReadAll(object)
	object.Close()
	if !bytes.Equal(stored, append(append([]byte{}, parts[0]...), parts[1]...)) {
		t.Fatalf("stored %d bytes", len(stored))
	}
	if err := store.AbortMultipartUpload(ctx, key, uploadID); err != nil {
		t.Fatalf("abort after completion: %v", err)
	}
}

// A voice run's upload URL signs its length and SHA-256 as headers, so
// storage refuses a larger or different file; the checksum must not ride in
// the query string, where storage may ignore it.
func TestChecksummedUploadSignsLengthAndChecksumAsHeaders(t *testing.T) {
	server := httptest.NewServer(gofakes3.New(s3mem.New(), gofakes3.WithAutoBucket(true)).Server())
	defer server.Close()
	store, err := NewS3Store(server.URL, server.URL, "us-east-1", "tenant-assets", "test-key", "test-secret")
	if err != nil {
		t.Fatal(err)
	}
	key := "voice/org-1/note-1/0-abc.wav"
	body := []byte("WAV bytes")
	digest := sha256.Sum256(body)
	url, headers, err := store.SignChecksummedUpload(context.Background(), key, "audio/wav", int64(len(body)), digest[:], 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := neturl.Parse(url)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Has("x-amz-checksum-sha256") || parsed.Query().Get("X-Amz-Expires") != "900" {
		t.Fatalf("query=%v", parsed.Query())
	}
	signed := parsed.Query().Get("X-Amz-SignedHeaders")
	for _, name := range []string{"content-length", "content-type", "if-none-match", "x-amz-checksum-sha256"} {
		if !strings.Contains(signed, name) {
			t.Fatalf("%s is not signed: %q", name, signed)
		}
	}
	if headers.Get("Host") != "" || headers.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(digest[:]) ||
		headers.Get("If-None-Match") != "*" || headers.Get("Content-Type") != "audio/wav" || headers.Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("headers=%v", headers)
	}
	request, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	for name, values := range headers {
		if name != "Content-Length" { // net/http sets it from the body
			request.Header[name] = values
		}
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("upload with the signed headers: %v %v", response, err)
	}
	response.Body.Close()
	download, err := store.SignDownloadFor(context.Background(), key, time.Hour)
	if err != nil || !strings.Contains(download, "X-Amz-Expires=3600") {
		t.Fatalf("download=%q err=%v", download, err)
	}
}
