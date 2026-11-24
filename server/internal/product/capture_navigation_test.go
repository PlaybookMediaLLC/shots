package product

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"net/http"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
)

func TestNavigationPromptStaysWithinItsBudget(t *testing.T) {
	// Each "<" is escaped to six bytes, so labels are as large as the page can make them.
	label := strings.Repeat("<", 120)
	view := browser.NavigationObservation{Path: "/reports", Headings: []string{"Reports"}, Ready: true}
	for range 12 {
		view.Current = append(view.Current, label)
	}
	for i := range 60 {
		view.Controls = append(view.Controls, browser.NavigationControl{ID: i, Kind: "tab", Label: fmt.Sprintf("Tab %d", i)})
	}
	sent := func(objective string, view browser.NavigationObservation) browser.NavigationObservation {
		t.Helper()
		prompt, ok := navigationPrompt(objective, "", view)
		if !ok || len(prompt) > 16_000 {
			t.Fatalf("ok=%v length=%d", ok, len(prompt))
		}
		var input struct {
			Observation browser.NavigationObservation `json:"untrustedObservation"`
		}
		if err := json.Unmarshal([]byte(prompt), &input); err != nil {
			t.Fatal(err)
		}
		return input.Observation
	}

	// Controls go first and keep their IDs.
	got := sent(strings.Repeat("<", 1000), view)
	if len(got.Controls) == 0 || len(got.Controls) == 60 || len(got.Current) != 12 || !got.Ready {
		t.Fatalf("controls=%d current=%d ready=%v", len(got.Controls), len(got.Current), got.Ready)
	}
	for i, control := range got.Controls {
		if control.ID != i || control.Label != fmt.Sprintf("Tab %d", i) {
			t.Fatalf("control %d became %+v", i, control)
		}
	}

	// Then context, before the headings that name the screen.
	for range 12 {
		view.Headings = append(view.Headings, label)
	}
	got = sent(strings.Repeat("<", 1000), view)
	if len(got.Controls) != 0 || len(got.Current) == 12 || len(got.Headings) != 13 {
		t.Fatalf("controls=%d current=%d headings=%d", len(got.Controls), len(got.Current), len(got.Headings))
	}
}

func browserCode(err error) browser.Code {
	var failure *browser.Failure
	if errors.As(err, &failure) {
		return failure.Code
	}
	return ""
}

type fakeVisionModel struct {
	fn func(ctx context.Context, req platformai.Request, out any) (platformai.Usage, error)
}

func (f fakeVisionModel) Structured(ctx context.Context, req platformai.Request, out any) (platformai.Usage, error) {
	return f.fn(ctx, req, out)
}

func makeTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestEncodeVisionPreviewDownscalesLargeImages(t *testing.T) {
	raw := makeTestPNG(t, 2560, 1440)
	mime, encoded, err := encodeVisionPreview(raw)
	if err != nil || mime != "image/jpeg" || encoded == "" {
		t.Fatalf("mime=%q err=%v", mime, err)
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(decoded))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width > maxVisionPreviewEdge || cfg.Height > maxVisionPreviewEdge {
		t.Fatalf("expected downscaled <= %d, got %dx%d", maxVisionPreviewEdge, cfg.Width, cfg.Height)
	}
	if _, _, err := encodeVisionPreview([]byte("not a png")); err == nil {
		t.Fatal("expected error for invalid image bytes")
	}
}

func TestVisionVerificationClassifiesAllOutcomes(t *testing.T) {
	pngBytes := makeTestPNG(t, 640, 360)

	t.Run("fails closed when AI unconfigured", func(t *testing.T) {
		cfg := &Configuration{}
		_, err := cfg.verifyCaptureWithVision(context.Background(), &captureClaim{
			job:    &ent.CaptureJob{OrganizationID: "org-1"},
			recipe: &ent.CaptureRecipe{Name: "Dashboard"},
		}, browser.Recipe{VerifyWithVision: true}, pngBytes)
		if browserCode(err) != browser.NavigationUnconfigured {
			t.Fatalf("got %v, want %s", err, browser.NavigationUnconfigured)
		}
	})

	t.Run("verified succeeds, extracts sanitized AI focus, and sanitizes NaN cost", func(t *testing.T) {
		var sawReq platformai.Request
		model := fakeVisionModel{fn: func(_ context.Context, req platformai.Request, out any) (platformai.Usage, error) {
			sawReq = req
			_ = json.Unmarshal([]byte(`{"verified":true,"reason":"ok","focus":{"x":0.1,"y":0.2,"w":0.5,"h":0.4}}`), out)
			return platformai.Usage{InputTokens: 100, OutputTokens: 20, CostUSD: math.NaN()}, nil
		}}
		usage, focus, err := runVisionVerification(context.Background(), model, "Dashboard", "Added chart", pngBytes)
		if err != nil || usage.CostUSD != 0 || len(sawReq.Images) != 1 || sawReq.MaxTokens != 1024 {
			t.Fatalf("err=%v usage=%+v images=%d maxTokens=%d", err, usage, len(sawReq.Images), sawReq.MaxTokens)
		}
		if focus == nil || math.Abs(focus.X-0.1) > 1e-6 || math.Abs(focus.W-0.5) > 1e-6 {
			t.Fatalf("expected AI focus box, got %+v", focus)
		}
	})

	t.Run("rejected returns non-retryable CaptureUnverified", func(t *testing.T) {
		model := fakeVisionModel{fn: func(_ context.Context, _ platformai.Request, out any) (platformai.Usage, error) {
			_ = json.Unmarshal([]byte(`{"verified":false,"reason":"login screen","focus":null}`), out)
			return platformai.Usage{InputTokens: 50, OutputTokens: 10}, nil
		}}
		_, _, err := runVisionVerification(context.Background(), model, "Dashboard", "", pngBytes)
		if browserCode(err) != browser.CaptureUnverified {
			t.Fatalf("got %v, want %s", err, browser.CaptureUnverified)
		}
		var f *browser.Failure
		if !errors.As(err, &f) || f.Retryable() {
			t.Fatalf("CaptureUnverified must be non-retryable: %v", err)
		}
	})

	t.Run("corrupt image returns ImageInvalid", func(t *testing.T) {
		model := fakeVisionModel{fn: func(context.Context, platformai.Request, any) (platformai.Usage, error) {
			t.Fatal("model should not be called for corrupt image")
			return platformai.Usage{}, nil
		}}
		_, _, err := runVisionVerification(context.Background(), model, "Dashboard", "", []byte("bad"))
		if browserCode(err) != browser.ImageInvalid {
			t.Fatalf("got %v, want %s", err, browser.ImageInvalid)
		}
	})

	t.Run("schema or 4xx refusal returns non-retryable NavigationInvalid while 503 returns NavigationUnavailable", func(t *testing.T) {
		for name, modelErr := range map[string]error{
			"schema": platformai.ErrSchema,
			"400":    &platformai.Error{Status: 400, Retryable: false},
		} {
			model := fakeVisionModel{fn: func(context.Context, platformai.Request, any) (platformai.Usage, error) {
				return platformai.Usage{}, modelErr
			}}
			_, _, err := runVisionVerification(context.Background(), model, "Dashboard", "", pngBytes)
			if browserCode(err) != browser.NavigationInvalid {
				t.Errorf("%s: got %v, want %s", name, err, browser.NavigationInvalid)
			}
		}
		model := fakeVisionModel{fn: func(context.Context, platformai.Request, any) (platformai.Usage, error) {
			return platformai.Usage{}, &platformai.Error{Status: 503, Retryable: true}
		}}
		_, _, err := runVisionVerification(context.Background(), model, "Dashboard", "", pngBytes)
		if browserCode(err) != browser.NavigationUnavailable {
			t.Fatalf("503: got %v, want %s", err, browser.NavigationUnavailable)
		}
	})
}

func TestSanitizeAIFocusAndBuildProposedRecipe(t *testing.T) {
	if sanitizeAIFocus(nil) != nil {
		t.Fatal("nil focus should stay nil")
	}
	if sanitizeAIFocus(&browser.Focus{X: 0, Y: 0, W: 0.99, H: 0.99}) != nil {
		t.Fatal("full-viewport box should be dropped")
	}
	if sanitizeAIFocus(&browser.Focus{X: 0.1, Y: 0.1, W: 0.01, H: 0.01}) != nil {
		t.Fatal("tiny box should be dropped")
	}
	if sanitizeAIFocus(&browser.Focus{X: math.NaN(), Y: 0.1, W: 0.4, H: 0.4}) != nil {
		t.Fatal("NaN box should be dropped")
	}
	if sanitizeAIFocus(&browser.Focus{X: math.Inf(1), Y: 0.1, W: 0.4, H: 0.4}) != nil {
		t.Fatal("Inf box should be dropped")
	}
	if clamped := sanitizeAIFocus(&browser.Focus{X: 0.6, Y: 0.2, W: 0.4005, H: 0.4}); clamped == nil || clamped.X+clamped.W > 1.0 {
		t.Fatalf("expected clamped focus within 1.0, got %+v", clamped)
	}
	if got := sanitizeAIFocus(&browser.Focus{X: 0.2, Y: 0.15, W: 0.5, H: 0.4}); got == nil || got.W != 0.5 {
		t.Fatalf("valid focus rejected: %+v", got)
	}

	// ViewportPNG must never serialize into navigationPrompt JSON text.
	promptJSON, ok := navigationPrompt("Show chart", "", browser.NavigationObservation{
		Path:        "/analytics",
		Ready:       true,
		ViewportPNG: []byte("SECRET_PNG_BYTES"),
	})
	if !ok || strings.Contains(promptJSON, "SECRET_PNG_BYTES") {
		t.Fatalf("ViewportPNG leaked into prompt text: ok=%v", ok)
	}

	routes := []map[string]string{
		{"path": "/dashboard", "label": "Dashboard"},
		{"path": "/analytics/cohorts", "label": "Cohorts"},
	}
	proposed := buildProposedRecipe("Show the dark mode cohorts walkthrough on mobile", "/dashboard", routes, 0, nil)
	if err := proposed.Definition.Validate(); err != nil {
		t.Fatalf("proposed recipe invalid: %v", err)
	}
	if proposed.Definition.Steps[0].Path != "/analytics/cohorts" || proposed.Definition.ColorScheme != browser.ColorSchemeDark ||
		proposed.Definition.Viewport.Width != 390 || proposed.Definition.SequenceShots != 3 ||
		proposed.Definition.Navigation == nil || !proposed.Definition.Navigation.UseVision || !proposed.Definition.Navigation.AllowSearchFill ||
		!proposed.Definition.VerifyWithVision || proposed.Definition.Markers[0] != browser.DefaultZeroConfigMarker {
		t.Fatalf("unexpected deterministic proposal: %+v", proposed.Definition)
	}
	// Model reply overrides safely and drops hostile paths or invalid enums.
	fromModel := buildProposedRecipe("Show billing", "/dashboard", routes, 0, &proposedRecipeReply{
		Name:          "  Invoice   table  ",
		Path:          "https://evil.example/phish",
		Objective:     "Open billing invoices",
		ColorScheme:   "neon",
		MaskStyle:     "invisible",
		Mobile:        false,
		SequenceShots: 2,
		Reasoning:     "Checked routes.",
	})
	if err := fromModel.Definition.Validate(); err != nil {
		t.Fatalf("model proposal invalid: %v", err)
	}
	if fromModel.Name != "Invoice table" || fromModel.Definition.Steps[0].Path != "/dashboard" || fromModel.Definition.ColorScheme != "" || fromModel.Definition.MaskStyle != browser.MaskStyleBlur || fromModel.Definition.SequenceShots != 2 {
		t.Fatalf("unexpected sanitized model proposal: %+v", fromModel)
	}
	// Explicit requestedShots overrides inference.
	override := buildProposedRecipe("Show billing", "/billing", nil, 4, nil)
	if override.Definition.SequenceShots != 4 || override.Definition.Viewport.Width != 1440 {
		t.Fatalf("expected 4 desktop shots, got %+v", override.Definition)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func strPtr(s string) *string { return &s }

func TestBootstrapConfigValidationAndSignedFetch(t *testing.T) {
	hosts := []string{"app.example.com"}
	validSecret := strPtr("0123456789abcdef-secret")

	if u, s, err := validateBootstrapConfig(strPtr("https://app.example.com/api/shots/bootstrap"), validSecret, hosts); err != nil || u == nil || *u != "https://app.example.com/api/shots/bootstrap" || s == "" {
		t.Fatalf("valid bootstrap failed: u=%v s=%q err=%v", u, s, err)
	}
	for name, tc := range map[string]struct {
		u *string
		s *string
	}{
		"http scheme":     {strPtr("http://app.example.com/bootstrap"), validSecret},
		"unapproved host": {strPtr("https://evil.example.com/bootstrap"), validSecret},
		"userinfo":        {strPtr("https://user:pass@app.example.com/bootstrap"), validSecret},
		"private ip":      {strPtr("https://127.0.0.1/bootstrap"), validSecret},
		"short secret":    {strPtr("https://app.example.com/bootstrap"), strPtr("too-short")},
		"missing secret":  {strPtr("https://app.example.com/bootstrap"), nil},
	} {
		if _, _, err := validateBootstrapConfig(tc.u, tc.s, hosts); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}

	target := browser.Target{Origin: "https://app.example.com", Hosts: hosts, ProtectedPath: "/dashboard", ExpectedAccount: "demo@example.com"}
	secret := []byte("bootstrap-signing-secret-123456")
	reqBody := []byte(`{"connectionId":"conn-1","environment":"production"}`)

	// Valid signed request + response
	client := &http.Client{
		Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			sig := r.Header.Get("x-shots-signature")
			tPart, v1Part, ok := strings.Cut(sig, ",v1=")
			stamp, ok2 := strings.CutPrefix(tPart, "t=")
			if !ok || !ok2 {
				t.Fatalf("bad signature header: %q", sig)
			}
			bodyBytes, _ := io.ReadAll(r.Body)
			mac := hmac.New(sha256.New, secret)
			mac.Write([]byte(stamp + "."))
			mac.Write(bodyBytes)
			if want := hex.EncodeToString(mac.Sum(nil)); v1Part != want {
				t.Fatalf("hmac mismatch: got %s want %s", v1Part, want)
			}
			resp := `{"cookies":[{"name":"sid","value":"ok","domain":"app.example.com"},{"name":"bad","value":"no","domain":"evil.example"}],"localStorage":{"https://app.example.com":{"theme":"dark"}}}`
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(resp)), Header: http.Header{}}, nil
		}),
	}
	state, err := fetchBootstrapState(context.Background(), client, "https://app.example.com/api/shots/bootstrap", secret, reqBody, target)
	if err != nil || len(state.Cookies) != 1 || state.Cookies[0].Name != "sid" {
		t.Fatalf("valid fetch failed: state=%+v err=%v", state, err)
	}

	// Non-200, redirect, oversized (>256 KiB), invalid JSON must all fail with SessionRestoreFailed.
	for name, resp := range map[string]*http.Response{
		"status 401": {StatusCode: http.StatusUnauthorized, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}},
		"redirect":   {StatusCode: http.StatusFound, Body: io.NopCloser(strings.NewReader(``)), Header: http.Header{"Location": []string{"https://evil.example"}}},
		"oversized":  {StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(bytes.Repeat([]byte("a"), maxBootstrapBodyBytes+10))), Header: http.Header{}},
		"bad json":   {StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`not-json`)), Header: http.Header{}},
	} {
		c := &http.Client{
			Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return resp, nil }),
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
		if _, err := fetchBootstrapState(context.Background(), c, "https://app.example.com/api/shots/bootstrap", secret, reqBody, target); browserCode(err) != browser.SessionRestoreFailed {
			t.Errorf("%s: got %v, want %s", name, err, browser.SessionRestoreFailed)
		}
	}
}

func TestFrontendWorkflowEventDistinguishesProductionAndStaging(t *testing.T) {
	prod := frontendWorkflowEvent(&ent.FrontendActivation{
		ID:       "act-prod",
		Snapshot: frontenddeploy.Observation{RepositoryID: "repo-1", DeploymentID: "dep-1", Environment: "production", Revision: "abc", URL: "https://app.example.com"},
	})
	if prod.Fields["deployment.production"].Boolean == nil || !*prod.Fields["deployment.production"].Boolean || prod.Title != "Production deployment reported successful" {
		t.Fatalf("prod event: %+v", prod)
	}
	staging := frontendWorkflowEvent(&ent.FrontendActivation{
		ID:       "act-stg",
		Snapshot: frontenddeploy.Observation{RepositoryID: "repo-1", DeploymentID: "dep-2", Environment: "staging", Revision: "def", URL: "https://stg.example.com"},
	})
	if staging.Fields["deployment.production"].Boolean == nil || *staging.Fields["deployment.production"].Boolean || staging.Title != "staging deployment reported successful" {
		t.Fatalf("staging event: %+v", staging)
	}
}
