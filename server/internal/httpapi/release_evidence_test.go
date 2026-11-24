package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

func TestReadinessDecoderPreservesCanonicalInputBoundary(t *testing.T) {
	for _, body := range []string{
		`{"text":"\ud800"}`, `{"text":"one","text":"two"}`, `{"unrecognized":true}`, `{"text":1.5}`, `{"text":"` + strings.Repeat("x", 1024*1024) + `"}`,
	} {
		request := httptest.NewRequest("POST", "/", strings.NewReader(body))
		var input product.CreateReleaseEvidenceInput
		if err := decodeReadinessJSON(request, &input); err == nil {
			t.Fatalf("accepted malformed input of %d bytes", len(body))
		}
	}
	request := httptest.NewRequest("POST", "/", strings.NewReader(`{"text":"\ud83d\ude00","expectedRevision":"9223372036854775807"}`))
	var input product.CreateReleaseEvidenceInput
	if err := decodeReadinessJSON(request, &input); err != nil || input.Text != "😀" || input.ExpectedRevision != "9223372036854775807" {
		t.Fatalf("valid input=%+v err=%v", input, err)
	}
}
