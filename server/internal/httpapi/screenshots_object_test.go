package httpapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type cacheObjectConfiguration struct {
	fakeConfiguration
	body []byte
}

func (c *cacheObjectConfiguration) PutScreenshotCacheObject(_ context.Context, _ string, body []byte) error {
	c.body = append([]byte(nil), body...)
	return nil
}

func (c *cacheObjectConfiguration) GetScreenshotCacheObject(context.Context, string) ([]byte, error) {
	return c.body, nil
}

func TestScreenshotCacheObjectRequiresServiceAuthAndPreservesBytes(t *testing.T) {
	config := &cacheObjectConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	path := "/v1/internal/screenshot-cache/" + string(bytes.Repeat([]byte{'a'}, 64)) + "/object"
	call := func(method string, body []byte, authorize bool, contentType string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, bytes.NewReader(body))
		if authorize {
			request.Header.Set("Authorization", "Bearer secret")
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if response := call(http.MethodPut, []byte("png"), false, "image/png"); response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized upload returned %d", response.Code)
	}
	if response := call(http.MethodPut, []byte("png"), true, "text/plain"); response.Code != http.StatusBadRequest {
		t.Fatalf("wrong content type returned %d", response.Code)
	}
	image := []byte{137, 80, 78, 71, 13, 10, 26, 10}
	if response := call(http.MethodPut, image, true, "image/png"); response.Code != http.StatusOK || !bytes.Equal(config.body, image) {
		t.Fatalf("upload returned %d; saved %v", response.Code, config.body)
	}
	response := call(http.MethodGet, nil, true, "")
	var result struct {
		Base64 string `json:"base64"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Base64 != base64.StdEncoding.EncodeToString(image) {
		t.Fatalf("download returned %d: %s", response.Code, response.Body.String())
	}
	pngReq := httptest.NewRequest(http.MethodGet, path, nil)
	pngReq.Header.Set("Authorization", "Bearer secret")
	pngReq.Header.Set("Accept", "image/png")
	pngRes := httptest.NewRecorder()
	handler.ServeHTTP(pngRes, pngReq)
	if pngRes.Code != http.StatusOK || pngRes.Header().Get("Content-Type") != "image/png" || pngRes.Header().Get("Content-Length") != "8" || !bytes.Equal(pngRes.Body.Bytes(), image) {
		t.Fatalf("raw png download returned %d type=%q len=%q body=%v", pngRes.Code, pngRes.Header().Get("Content-Type"), pngRes.Header().Get("Content-Length"), pngRes.Body.Bytes())
	}

	jpegBytes := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10}
	config.body = jpegBytes
	jpgReq := httptest.NewRequest(http.MethodGet, path, nil)
	jpgReq.Header.Set("Authorization", "Bearer secret")
	jpgReq.Header.Set("Accept", "image/png")
	jpgRes := httptest.NewRecorder()
	handler.ServeHTTP(jpgRes, jpgReq)
	if jpgRes.Code != http.StatusOK || jpgRes.Header().Get("Content-Type") != "image/jpeg" || jpgRes.Header().Get("Content-Length") != "6" || !bytes.Equal(jpgRes.Body.Bytes(), jpegBytes) {
		t.Fatalf("raw jpeg download returned %d type=%q len=%q body=%v", jpgRes.Code, jpgRes.Header().Get("Content-Type"), jpgRes.Header().Get("Content-Length"), jpgRes.Body.Bytes())
	}
}
