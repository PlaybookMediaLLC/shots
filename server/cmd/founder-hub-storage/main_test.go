package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPrivateStorageTransport(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/upload/resumable/a%20b?part=2" || r.Header.Get("Authorization") != "Bearer private-token" ||
			r.Header.Get("Tus-Resumable") != "1.0.0" || r.Header.Get("Upload-Offset") != "0" {
			t.Errorf("upload contract not preserved: %s", r.URL.RequestURI())
		}
		payload, _ := io.ReadAll(r.Body)
		if string(payload) != "encrypted attachment" {
			t.Errorf("upload changed: %q", payload)
		}
		w.Header().Set("Location", "http://"+r.Host+"/upload/resumable/a%20b?part=3")
		w.Header().Set("Upload-Offset", "20")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()
	app, err := handler(upstream.URL, upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPatch, "/storage/v1/upload/resumable/a%20b?part=2", strings.NewReader("encrypted attachment"))
	request.Header.Set("Authorization", "Bearer private-token")
	request.Header.Set("Tus-Resumable", "1.0.0")
	request.Header.Set("Upload-Offset", "0")
	response := httptest.NewRecorder()
	app.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || response.Header().Get("Location") != "/storage/v1/upload/resumable/a%20b?part=3" ||
		response.Header().Get("Upload-Offset") != "20" || response.Body.String() != "encrypted attachment" {
		t.Fatalf("upload response changed: %d %v %q", response.Code, response.Header(), response.Body.String())
	}
}
