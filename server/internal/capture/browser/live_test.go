package browser

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
	"github.com/go-rod/rod"
)

// These tests are the RFC's provider spike. They call the real browser provider
// and run only when given PLATFORM_CAPTURE_CDP_URL, PLATFORM_CAPTURE_CDP_TOKEN,
// and CAPTURE_LIVE_ORIGIN. They never print a token, a Live View link, or state.

func liveProvider(t *testing.T) (*Cloudflare, *url.URL) {
	t.Helper()
	provider := FromEnvironment()
	raw := os.Getenv("CAPTURE_LIVE_ORIGIN")
	if provider == nil || raw == "" {
		t.Skip("set PLATFORM_CAPTURE_CDP_URL, PLATFORM_CAPTURE_CDP_TOKEN, and CAPTURE_LIVE_ORIGIN")
	}
	origin, err := url.Parse(raw)
	if err != nil || origin.Scheme != "https" {
		t.Fatal("CAPTURE_LIVE_ORIGIN must be an https origin")
	}
	return provider, origin
}

// TestLiveProviderSession needs no sign-in: allocation, CDP auth, guardrails,
// the Live View link, and closing.
func TestLiveProviderSession(t *testing.T) {
	provider, origin := liveProvider(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	session, err := provider.Allocate(ctx, []string{origin.Hostname()}, 2*time.Minute)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	closed := false
	defer func() {
		if !closed {
			_ = provider.Close(context.Background(), session)
		}
	}()
	connectCtx, disconnect := context.WithCancel(ctx)
	defer disconnect()
	browser, err := provider.Connect(connectCtx, session)
	if err != nil {
		t.Fatalf("connect with the bearer header: %v", err)
	}
	target := Target{Origin: origin.Scheme + "://" + origin.Host, Hosts: []string{origin.Hostname()}, ProtectedPath: "/", IdentitySelector: "body", ExpectedAccount: "x"}
	if err := OpenLogin(ctx, browser, target); err != nil {
		t.Fatalf("open the app: %v", err)
	}
	pages, err := browser.Pages()
	if err != nil || len(pages) == 0 {
		t.Fatalf("pages=%d err=%v", len(pages), err)
	}
	page := pages.First().Context(ctx)
	_ = page.WaitLoad()
	info, err := page.Info()
	if err != nil {
		t.Fatal(err)
	}
	here, err := url.Parse(info.URL)
	if err != nil || here.Hostname() != origin.Hostname() {
		t.Fatalf("the app did not load through guardrails: host=%q", here.Hostname())
	}
	t.Logf("app reached through guardrails; path=%s signIn=%v", here.Path, capture.IsSignInPath(here.Path))

	// The guardrail: a host off the allowlist must not load.
	if err := page.Navigate("https://example.com/"); err == nil {
		_ = page.WaitLoad()
	}
	text, err := page.Eval(`() => document.body ? document.body.innerText : ''`)
	if err == nil && strings.Contains(text.Value.Str(), "Example Domain") {
		t.Fatal("guardrails let an unapproved host load")
	}
	t.Log("an unapproved host did not load")

	// What the provider itself does with a WebSocket, which its documentation
	// does not state. The result is recorded rather than asserted; the runner's
	// lockdown does not rely on it.
	if err := page.Navigate(target.Origin + "/"); err == nil {
		_ = page.WaitLoad()
	}
	socket, err := page.Eval(`() => new Promise((done) => { try { const s = new WebSocket('wss://echo.websocket.org/'); s.onopen = () => done('opened'); s.onerror = () => done('failed'); setTimeout(() => done('timeout'), 5000) } catch (e) { done('threw') } })`)
	if err == nil {
		t.Logf("a WebSocket to an unapproved host, without the runner's lockdown: %s", socket.Value.Str())
	}

	link, err := provider.LiveView(ctx, session, time.Minute)
	if err != nil || !strings.HasPrefix(link, "https://") {
		t.Fatalf("live view: empty=%v err=%v", link == "", err)
	}
	t.Log("a Live View link was issued")
	disconnect()
	// The session outlives its CDP connection, the property a sign-in relies on.
	again, err := provider.Connect(ctx, session)
	if err != nil {
		t.Fatalf("the session did not survive a dropped connection: %v", err)
	}
	if _, err := again.Pages(); err != nil {
		t.Fatalf("reconnected pages: %v", err)
	}
	if err := provider.Close(ctx, session); err != nil {
		t.Fatalf("close: %v", err)
	}
	closed = true
	if err := provider.Close(ctx, session); err != nil {
		t.Fatalf("a repeated close must be safe: %v", err)
	}
}

// TestLiveRunnerOnPublicPage runs the whole runner on the real provider with no
// sign-in: an isolated context, request interception, the lockdown, identity and
// marker checks, a mask, and a screenshot, against the app's public sign-in page.
func TestLiveRunnerOnPublicPage(t *testing.T) {
	raw := os.Getenv("CAPTURE_LIVE_PUBLIC")
	dir := os.Getenv("CAPTURE_LIVE_DIR")
	if raw == "" || dir == "" {
		t.Skip("set CAPTURE_LIVE_PUBLIC and CAPTURE_LIVE_DIR")
	}
	provider, origin := liveProvider(t)
	var config struct {
		Target
		Recipe Recipe `json:"recipe"`
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	config.Target.Origin = origin.Scheme + "://" + origin.Host
	config.Target.Hosts = liveHosts(origin, "CAPTURE_LIVE_HOSTS")
	runner := Runner{Provider: provider}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	session, err := runner.Allocate(ctx, config.Target.Hosts, 3*time.Minute)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer func() { _ = runner.Close(context.Background(), session) }()
	started := time.Now()
	result, err := runner.Run(ctx, session, RunInput{Target: config.Target, Recipe: config.Recipe})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	t.Logf("captured %dx%d, %d bytes, in %s; refused requests=%d", result.Width, result.Height, len(result.Image), time.Since(started).Round(time.Millisecond), result.RefusedRequests)
	if err := os.WriteFile(filepath.Join(dir, "spike-public.png"), result.Image, 0o600); err != nil {
		t.Fatal(err)
	}
	// The same page with no account element is what a signed-out run sees.
	wrong := config.Target
	wrong.IdentitySelector = "[data-testid=no-such-account]"
	if err := runner.Verify(ctx, session, wrong, nil); err == nil {
		t.Fatal("a page without the account passed")
	} else {
		t.Logf("a page without the account: %v", err)
	}
}

// liveStage is what the sign-in stage leaves for the capture stage, sealed.
func liveKeys(t *testing.T, dir string) *sessionstate.Keys {
	t.Helper()
	path := filepath.Join(dir, "spike.key")
	key, err := os.ReadFile(path)
	if err != nil {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, key, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keys, err := sessionstate.NewKeys(key)
	if err != nil {
		t.Fatal(err)
	}
	return keys
}

func liveBinding(origin *url.URL) sessionstate.Binding {
	return sessionstate.Binding{Organization: "spike", Connection: origin.Hostname(), Environment: "spike", Generation: 1}
}

func liveHosts(origin *url.URL, name string) []string {
	hosts := []string{origin.Hostname()}
	for _, host := range strings.Split(os.Getenv(name), ",") {
		if host = strings.TrimSpace(host); host != "" {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

// TestLiveSignIn hands a person a Live View link through a private file, waits
// for them to leave the sign-in page, seals the state, and reports which page
// and test IDs they landed on so a recipe can be written. It looks at nothing
// but the URL until the person has finished, and records no screenshot of it.
func TestLiveSignIn(t *testing.T) {
	dir := os.Getenv("CAPTURE_LIVE_DIR")
	if dir == "" {
		t.Skip("set CAPTURE_LIVE_DIR")
	}
	provider, origin := liveProvider(t)
	ctx, cancel := context.WithTimeout(context.Background(), 14*time.Minute)
	defer cancel()
	session, err := provider.Allocate(ctx, liveHosts(origin, "CAPTURE_LIVE_LOGIN_HOSTS"), 14*time.Minute)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer func() { _ = provider.Close(context.Background(), session) }()
	target := Target{Origin: origin.Scheme + "://" + origin.Host, Hosts: []string{origin.Hostname()}, ProtectedPath: "/", IdentitySelector: "body", ExpectedAccount: "x"}
	connectCtx, disconnect := context.WithCancel(ctx)
	defer disconnect()
	browser, err := provider.Connect(connectCtx, session)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := OpenLogin(ctx, browser, target); err != nil {
		t.Fatalf("open: %v", err)
	}
	link, err := provider.LiveView(ctx, session, 10*time.Minute)
	if err != nil {
		t.Fatalf("live view: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "live-view-link.txt"), []byte(link), 0o600); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(filepath.Join(dir, "live-view-link.txt"))
	t.Log("the Live View link is ready; waiting for the sign-in")
	var signedIn *rod.Page
	for signedIn == nil {
		select {
		case <-ctx.Done():
			t.Fatal("nobody signed in within the window")
		case <-time.After(3 * time.Second):
		}
		pages, err := browser.Pages()
		if err != nil {
			continue
		}
		for _, page := range pages {
			info, err := page.Info()
			if err != nil {
				continue
			}
			here, err := url.Parse(info.URL)
			if err == nil && here.Hostname() == origin.Hostname() && !capture.IsSignInPath(here.Path) && here.Path != "/" {
				signedIn = page.Context(ctx)
			}
		}
	}
	_ = signedIn.WaitLoad()
	time.Sleep(4 * time.Second)
	info, _ := signedIn.Info()
	here, _ := url.Parse(info.URL)
	ids, err := signedIn.Eval(`() => JSON.stringify(Array.from(document.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')).slice(0, 80))`)
	if err == nil {
		t.Logf("signed-in page=%s testids=%s", here.Path, ids.Value.Str())
	}
	state, err := ExportConnected(ctx, browser, target)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	names := []string{}
	for _, cookie := range state.Cookies {
		names = append(names, cookie.Name)
	}
	storage := 0
	for _, values := range state.LocalStorage {
		storage += len(values)
	}
	t.Logf("exported cookie names=%v localStorage entries=%d", names, storage)
	body, err := state.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := liveKeys(t, dir).Seal(body, liveBinding(origin))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "spike-state.sealed"), []byte(sealed), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestLiveRestoreAndCapture is the RFC's gate: the login browser is gone, and a
// new session restores the state, proves the account, and captures the screen.
func TestLiveRestoreAndCapture(t *testing.T) {
	dir := os.Getenv("CAPTURE_LIVE_DIR")
	raw := os.Getenv("CAPTURE_LIVE_RECIPE")
	if dir == "" || raw == "" {
		t.Skip("set CAPTURE_LIVE_DIR and CAPTURE_LIVE_RECIPE")
	}
	provider, origin := liveProvider(t)
	var config struct {
		Target
		Recipe           Recipe `json:"recipe"`
		ExpectedRevision string `json:"expectedRevision"`
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	config.Target.Origin = origin.Scheme + "://" + origin.Host
	config.Target.Hosts = liveHosts(origin, "CAPTURE_LIVE_HOSTS")
	sealed, err := os.ReadFile(filepath.Join(dir, "spike-state.sealed"))
	if err != nil {
		t.Fatal(err)
	}
	body, _, err := liveKeys(t, dir).Open(string(sealed), liveBinding(origin))
	if err != nil {
		t.Fatal(err)
	}
	state, err := UnmarshalState(body)
	if err != nil {
		t.Fatal(err)
	}
	runner := Runner{Provider: provider}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	session, err := runner.Allocate(ctx, config.Target.Hosts, 3*time.Minute)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer func() { _ = runner.Close(context.Background(), session) }()
	if err := runner.Verify(ctx, session, config.Target, state); err != nil {
		t.Fatalf("restore in a fresh session: %v", err)
	}
	t.Log("a fresh session restored the state and proved the account")
	started := time.Now()
	result, err := runner.Run(ctx, session, RunInput{Target: config.Target, Recipe: config.Recipe, State: state, ExpectedRevision: config.ExpectedRevision})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	t.Logf("captured %dx%d, %d bytes, in %s; refused requests=%d; observed revision=%q; rotated state=%v", result.Width, result.Height, len(result.Image), time.Since(started).Round(time.Millisecond), result.RefusedRequests, result.ObservedRevision, result.State != nil)
	if bytes.Equal(result.Image, nil) {
		t.Fatal("no image")
	}
	if err := os.WriteFile(filepath.Join(dir, "spike-capture.png"), result.Image, 0o600); err != nil {
		t.Fatal(err)
	}
}
