package product

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The worker's code visual request goes to the web's signed endpoint beside the
// renderer, and a web refusal is final rather than retried.
func TestHTTPAutomationRendererRenderCode(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	var seen struct {
		path, signature string
		body            AutomationCodeVisualRequest
	}
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		seen.path, seen.signature = r.URL.Path, r.Header.Get("x-shots-signature")
		_ = json.Unmarshal(data, &seen.body)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"projectId":"cproject","assetId":"asset"}`))
	}))
	defer server.Close()
	renderer := &HTTPAutomationRenderer{URL: server.URL + "/api/internal/workflow-renders", Key: key, HTTP: server.Client()}
	request := AutomationCodeVisualRequest{OrganizationID: "org", CampaignID: "campaign", RunID: "run", NodeID: "code",
		Files: []CodeImportFile{{Name: "a.go", Patch: "@@ -1 +1 @@\n-a\n+b"}}}
	visual, err := renderer.RenderCode(context.Background(), request)
	if err != nil || visual.ProjectID != "cproject" || visual.AssetID != "asset" {
		t.Fatalf("visual=%+v err=%v", visual, err)
	}
	if seen.path != "/api/internal/workflow-code-visuals" || !strings.HasPrefix(seen.signature, "t=") || seen.body.Files[0].Patch == "" {
		t.Fatalf("request=%+v", seen)
	}
	status = http.StatusUnprocessableEntity
	if _, err := renderer.RenderCode(context.Background(), request); !errors.Is(err, ErrRendererRefused) {
		t.Fatalf("refusal=%v", err)
	}
	status = http.StatusBadGateway
	if _, err := renderer.RenderCode(context.Background(), request); err == nil || errors.Is(err, ErrRendererRefused) {
		t.Fatalf("an outage must be retryable: %v", err)
	}
}
