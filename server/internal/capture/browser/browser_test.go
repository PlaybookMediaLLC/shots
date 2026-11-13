package browser

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	"github.com/coder/websocket"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/cdp"
	"github.com/go-rod/rod/lib/launcher"
)

func init() {
	// The synthetic app serves from loopback; one test puts the real rule back.
	addressAllowed = func(netip.Addr) bool { return true }
}

func validRecipe() Recipe {
	return Recipe{SchemaVersion: 1, Viewport: Viewport{Width: 800, Height: 600}, Steps: []Step{{Kind: StepNavigate, Path: "/dashboard"}}, Markers: []string{"[data-testid=ready]"}}
}

// Browser Run reports [::1] for every response through its local proxy, so
// loopback must not fail a run. Measured on the real provider, 2026-11-04.
func TestResponseAddressPolicyToleratesTheProvidersProxy(t *testing.T) {
	rule := func(address netip.Addr) bool { return address.IsLoopback() || publicnet.IsPublic(address) }
	for value, want := range map[string]bool{"::1": true, "127.0.0.1": true, "8.8.8.8": true, "2606:4700:4700::1111": true,
		"10.0.0.1": false, "169.254.169.254": false, "192.168.1.1": false, "100.64.0.1": false, "fd00::1": false} {
		if rule(netip.MustParseAddr(value)) != want {
			t.Errorf("%s = %v", value, !want)
		}
	}
}

func TestRecipeAcceptsOnlyTheTypedLanguage(t *testing.T) {
	if err := validRecipe().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Recipe){
		"version":        func(r *Recipe) { r.SchemaVersion = 2 },
		"too wide":       func(r *Recipe) { r.Viewport.Width = 4000 },
		"no steps":       func(r *Recipe) { r.Steps = nil },
		"many steps":     func(r *Recipe) { r.Steps = append(r.Steps, make([]Step, MaxSteps)...) },
		"wait first":     func(r *Recipe) { r.Steps[0] = Step{Kind: StepWaitFor, Selector: "a"} },
		"script step":    func(r *Recipe) { r.Steps = append(r.Steps, Step{Kind: "EVALUATE", Selector: "a"}) },
		"other host":     func(r *Recipe) { r.Steps[0].Path = "https://evil.example/x" },
		"network path":   func(r *Recipe) { r.Steps[0].Path = "//evil.example/x" },
		"dot segments":   func(r *Recipe) { r.Steps[0].Path = "/a/../b" },
		"long timeout":   func(r *Recipe) { r.Steps[0].TimeoutMs = MaxStepTimeoutMs + 1 },
		"no marker":      func(r *Recipe) { r.Markers = nil },
		"script marker":  func(r *Recipe) { r.Markers = []string{"a{}</style><script>"} },
		"script mask":    func(r *Recipe) { r.Masks = []string{"a;alert(1)"} },
		"two proofs":     func(r *Recipe) { r.Version = &VersionCheck{Path: "/v", Selector: "a"} },
		"empty proof":    func(r *Recipe) { r.Version = &VersionCheck{} },
		"open post path": func(r *Recipe) { r.AllowedPostPaths = []string{"/graphql?x=1"} },
	} {
		recipe := validRecipe()
		recipe.Steps = append([]Step{}, recipe.Steps...)
		change(&recipe)
		if recipe.Validate() == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	first, _ := validRecipe().Hash()
	changed := validRecipe()
	changed.Masks = []string{".email"}
	if second, _ := changed.Hash(); first == second || first == "" {
		t.Fatal("a changed recipe kept its hash")
	}
}

func TestTargetAndRequestPolicy(t *testing.T) {
	good := Target{Origin: "https://app.example.com", Hosts: []string{"app.example.com", "*.cdn.example.com"}, ProtectedPath: "/dashboard", IdentitySelector: "#me", ExpectedAccount: "demo"}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*Target){
		"http":       func(t *Target) { t.Origin = "http://app.example.com" },
		"path":       func(t *Target) { t.Origin = "https://app.example.com/x" },
		"private":    func(t *Target) { t.Origin = "https://10.0.0.1"; t.Hosts = []string{"10.0.0.1"} },
		"unapproved": func(t *Target) { t.Hosts = []string{"other.example.com"} },
		"host port":  func(t *Target) { t.Hosts = []string{"app.example.com:443"} },
		"host url":   func(t *Target) { t.Hosts = []string{"https://app.example.com"} },
		"star":       func(t *Target) { t.Hosts = []string{"*"} },
		"identity":   func(t *Target) { t.ExpectedAccount = "" },
	} {
		target := good
		change(&target)
		if target.Validate() == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	hosts, posts := good.Hosts, []string{"/graphql"}
	for _, c := range []struct {
		method, url string
		want        bool
	}{
		{"GET", "https://app.example.com/x", true}, {"GET", "https://a.cdn.example.com/i.png", true}, {"GET", "data:image/png;base64,AA", true},
		{"GET", "https://cdn.example.com/x", false}, {"GET", "https://evil.example/x", false}, {"GET", "http://app.example.com/x", false},
		{"GET", "https://169.254.169.254/latest", false}, {"GET", "https://user:p@app.example.com/", false}, {"GET", "file:///etc/passwd", false},
		{"POST", "https://app.example.com/graphql", true}, {"POST", "https://app.example.com/mutate", false},
		{"DELETE", "https://app.example.com/graphql", false}, {"PUT", "https://app.example.com/x", false},
	} {
		if got := requestAllowed(c.method, c.url, hosts, posts); got != c.want {
			t.Errorf("%s %s = %v", c.method, c.url, got)
		}
	}
}

// protectedApp is a synthetic app: a cookie plus a local-storage token sign a
// user in, and it records every host and method that reaches it.
type protectedApp struct {
	server  *httptest.Server
	port    string
	mu      sync.Mutex
	reached map[string]int
	account atomic.Value
	commit  atomic.Value
	expired atomic.Bool
	rotate  atomic.Bool
}

func (a *protectedApp) hit(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.reached[key]++
}

func (a *protectedApp) count(key string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.reached[key]
}

func newProtectedApp(t *testing.T) *protectedApp {
	t.Helper()
	a := &protectedApp{reached: map[string]int{}}
	a.account.Store("acme-demo")
	a.commit.Store("abcdef1234567890")
	a.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		a.hit(host)
		if r.Header.Get("Upgrade") != "" {
			a.hit("websocket")
		}
		a.hit(r.Method + " " + r.URL.Path)
		if host != "app.example.test" {
			_, _ = w.Write([]byte("<html>another host</html>"))
			return
		}
		signed := false
		if cookie, err := r.Cookie("session"); err == nil && strings.HasPrefix(cookie.Value, "valid") && !a.expired.Load() {
			signed = true
		}
		w.Header().Set("Content-Type", "text/html")
		switch r.URL.Path {
		case "/login":
			fmt.Fprint(w, `<form method="post" action="/session"><input id="email" name="email"><input id="password" type="password" name="password"><button id="go">Sign in</button></form>`)
		case "/session":
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "valid-1", Path: "/", Secure: true, HttpOnly: true})
			fmt.Fprint(w, `<script>localStorage.setItem('token','local-secret');location='/dashboard'</script>`)
		case "/challenge":
			fmt.Fprint(w, `<html><div id="captcha">Prove you are human</div></html>`)
		case "/dashboard", "/signed-in-tabs", "/assets", "/probe", "/away-link":
			if !signed {
				http.Redirect(w, r, "/login", http.StatusFound)
				return
			}
			if a.rotate.Load() {
				http.SetCookie(w, &http.Cookie{Name: "session", Value: "valid-2", Path: "/", Secure: true, HttpOnly: true})
			}
			extra := ""
			switch r.URL.Path {
			case "/signed-in-tabs":
				extra = `<button id="plain">not a tab</button><button id="tab" role="tab" onclick="document.body.insertAdjacentHTML('beforeend','<div id=tabbed></div>')">Reports</button>`
			case "/assets":
				extra = fmt.Sprintf(`<img src="https://other.example.test:%s/pixel.png"><iframe src="https://other.example.test:%s/frame"></iframe>
<script>alert('blocking dialog');window.open('https://other.example.test:'+location.port+'/popup');fetch('https://other.example.test:%s/fetch').catch(()=>{});try{new WebSocket('wss://app.example.test:%s/socket')}catch(e){};try{new Worker('data:text/javascript,new WebSocket("wss://app.example.test:'+location.port+'/worker-socket")')}catch(e){};fetch('/mutate',{method:'POST'}).catch(()=>{});fetch('/graphql',{method:'POST'}).catch(()=>{})</script>`, a.port, a.port, a.port, a.port)
			}
			fmt.Fprintf(w, `<body style="background:#fff"><script>if(!localStorage.getItem('token'))location='/login'</script><div data-testid="account">%s</div><div data-testid="ready">Ready</div>
<div data-testid="secret" style="position:absolute;left:100px;top:100px;width:200px;height:100px;background:#0f0">private@acme.test</div><meta name="build" content="%s">%s</body>`, a.account.Load(), a.commit.Load(), extra)
		case "/api/version":
			fmt.Fprintf(w, `{"commit":%q}`, a.commit.Load())
		case "/leave":
			http.Redirect(w, r, fmt.Sprintf("https://other.example.test:%s/landing", a.port), http.StatusFound)
		default:
			fmt.Fprint(w, "<html>ok</html>")
		}
	}))
	t.Cleanup(a.server.Close)
	_, a.port, _ = net.SplitHostPort(a.server.Listener.Addr().String())
	return a
}

func (a *protectedApp) target() Target {
	return Target{Origin: "https://app.example.test:" + a.port, Hosts: []string{"app.example.test"}, ProtectedPath: "/dashboard", IdentitySelector: "[data-testid=account]", ExpectedAccount: "acme-demo"}
}

// localBrowser launches a separate Chrome process, the way each provider
// session is a separate browser; test hosts resolve to the local app.
func localBrowser(t *testing.T) *rod.Browser {
	t.Helper()
	bin := os.Getenv("CAPTURE_TEST_CHROME")
	if bin == "" {
		bin, _ = launcher.LookPath()
	}
	if bin == "" {
		t.Skip("no Chrome: set CAPTURE_TEST_CHROME")
	}
	l := launcher.New().Bin(bin).Headless(true).Leakless(false).Set("ignore-certificate-errors").
		Set("host-resolver-rules", "MAP app.example.test 127.0.0.1, MAP other.example.test 127.0.0.1")
	control, err := l.Launch()
	if err != nil {
		t.Fatal(err)
	}
	browser := rod.New().ControlURL(control).NoDefaultDevice()
	if err := browser.Connect(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = browser.Close(); l.Kill(); l.Cleanup() })
	return browser
}

// signIn plays the person in Live View, then exports what they left behind.
func signIn(t *testing.T, a *protectedApp) *State {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	browser := localBrowser(t)
	target := a.target()
	if err := OpenLogin(ctx, browser, target); err != nil {
		t.Fatal(err)
	}
	pages, err := browser.Pages()
	if err != nil || len(pages) == 0 {
		t.Fatalf("pages=%d err=%v", len(pages), err)
	}
	page := pages.First().Context(ctx)
	if err := page.WaitLoad(); err != nil {
		t.Fatal(err)
	}
	form, err := page.Element("#email")
	if err != nil {
		t.Fatal(err)
	}
	_ = form.Input("demo@acme.test")
	// Submit after the call returns: a CDP call still waiting when the page
	// navigates fails with "Inspected target navigated or closed".
	if _, err := page.Eval(`() => { setTimeout(() => document.querySelector('form').submit()) }`); err != nil {
		t.Fatal(err)
	}
	// The submit and /session's own redirect each navigate; a search that
	// overlaps one fails the same way, so look again until the context ends.
	for {
		_, err := page.Element("[data-testid=ready]")
		if err == nil {
			break
		}
		if !errors.Is(err, &cdp.Error{Code: -32000, Message: "Inspected target navigated or closed"}) {
			t.Fatal(err)
		}
	}
	state, err := ExportConnected(ctx, browser, target)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func failed(t *testing.T, err error, want Code) {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != want {
		t.Fatalf("err=%v, want %s", err, want)
	}
}

func TestRealBrowserFreshSessionCapture(t *testing.T) {
	a := newProtectedApp(t)
	state := signIn(t, a)
	if len(state.Cookies) != 1 || state.Cookies[0].Value != "valid-1" || state.LocalStorage[a.target().Origin]["token"] != "local-secret" {
		t.Fatalf("exported cookies=%d storage=%v", len(state.Cookies), state.LocalStorage)
	}
	// Browser A is gone. A different process restores the state and reaches the
	// protected page as the expected account.
	browser := localBrowser(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	target := a.target()
	if err := Verify(ctx, browser, target, state); err != nil {
		t.Fatalf("restore in a fresh browser: %v", err)
	}
	recipe := validRecipe()
	recipe.Masks = []string{"[data-testid=secret]"}
	recipe.Version = &VersionCheck{Path: "/api/version"}
	result, err := Run(ctx, browser, RunInput{Target: target, Recipe: recipe, State: state, ExpectedRevision: "abcdef1234567890"})
	if err != nil {
		t.Fatal(err)
	}
	if result.ObservedRevision != "abcdef1234567890" || result.Width != 800 || result.Height != 600 {
		t.Fatalf("result=%+v", result)
	}
	decoded, _, err := image.Decode(bytes.NewReader(result.Image))
	if err != nil {
		t.Fatal(err)
	}
	// The private field was green; masked, it holds no green at all.
	for x := 100; x < 300; x += 20 {
		for y := 100; y < 200; y += 20 {
			if r, g, b, _ := decoded.At(x, y).RGBA(); r != 0 || g != 0 || b != 0 {
				t.Fatalf("mask leaked at %d,%d: %d %d %d", x, y, r, g, b)
			}
		}
	}
	if r, g, b, _ := decoded.At(700, 500).RGBA(); r == 0 && g == 0 && b == 0 {
		t.Fatal("the screenshot is blank")
	}
	// A DOM build marker proves the version as well as an endpoint.
	recipe.Version = &VersionCheck{Selector: "meta[name=build]"}
	if result, err := Run(ctx, browser, RunInput{Target: target, Recipe: recipe, State: state, ExpectedRevision: "abcdef1234567890"}); err != nil || result.ObservedRevision == "" {
		t.Fatalf("dom proof: %+v %v", result, err)
	}
	// Each run is isolated: the same browser with no state is signed out.
	if err := Verify(ctx, browser, target, nil); err == nil {
		t.Fatal("a fresh context inherited another run's session")
	} else {
		failed(t, err, NeedsAuth)
	}
	// The app rotates its session token: the run hands back the new state.
	a.rotate.Store(true)
	rotated, err := Run(ctx, browser, RunInput{Target: target, Recipe: validRecipe(), State: state})
	if err != nil {
		t.Fatal(err)
	}
	if rotated.State == nil || rotated.State.Same(state) {
		t.Fatalf("rotated state=%+v", rotated.State)
	}
	found := false
	for _, cookie := range rotated.State.Cookies {
		found = found || cookie.Value == "valid-2"
	}
	if !found {
		t.Fatal("the rotated token was not exported")
	}
	a.rotate.Store(false)
	// Unchanged credentials write no new revision.
	if again, err := Run(ctx, browser, RunInput{Target: target, Recipe: validRecipe(), State: rotated.State}); err != nil || again.State != nil {
		t.Fatalf("state=%+v err=%v", again, err)
	}
}

func TestRealBrowserRefusesWhatItCannotClaim(t *testing.T) {
	a := newProtectedApp(t)
	state := signIn(t, a)
	browser := localBrowser(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	target := a.target()
	run := func(change func(*Recipe), revision string) error {
		recipe := validRecipe()
		change(&recipe)
		_, err := Run(ctx, browser, RunInput{Target: target, Recipe: recipe, State: state, ExpectedRevision: revision})
		return err
	}
	// Version proof: another commit waits; no report is unverified; no check at all is refused.
	version := func(r *Recipe) { r.Version = &VersionCheck{Path: "/api/version"} }
	failed(t, run(version, "1111111111111111"), WaitingForDeployment)
	failed(t, run(func(r *Recipe) { r.Version = &VersionCheck{Path: "/nothing"} }, "abcdef1234567890"), DeploymentUnverified)
	failed(t, run(func(*Recipe) {}, "abcdef1234567890"), DeploymentUnverified)
	// The screen itself.
	failed(t, run(func(r *Recipe) {
		r.Markers = []string{"#never"}
		r.Steps = append(r.Steps, Step{Kind: StepWaitFor, Selector: "#never", TimeoutMs: 400})
	}, ""), MarkerMissing)
	failed(t, run(func(r *Recipe) { r.Forbidden = []string{"[data-testid=ready]"} }, ""), ForbiddenView)
	failed(t, run(func(r *Recipe) { r.Masks = []string{"#moved-away"} }, ""), MaskMissing)
	// Only a declared tab can be clicked, and it works.
	failed(t, run(func(r *Recipe) {
		r.Steps = []Step{{Kind: StepNavigate, Path: "/signed-in-tabs"}, {Kind: StepSelectTab, Selector: "#plain"}}
	}, ""), RecipeInvalid)
	if err := run(func(r *Recipe) {
		r.Steps = []Step{{Kind: StepNavigate, Path: "/signed-in-tabs"}, {Kind: StepSelectTab, Selector: "#tab"}, {Kind: StepWaitFor, Selector: "#tabbed"}}
	}, ""); err != nil {
		t.Fatalf("tab: %v", err)
	}
	// The wrong account in the same session.
	a.account.Store("someone-else")
	failed(t, run(func(*Recipe) {}, ""), WrongAccount)
	a.account.Store("acme-demo")
	// An MFA or CAPTCHA screen shows no account: only a person can get past it.
	challenged := target
	challenged.ProtectedPath = "/challenge"
	failed(t, Verify(ctx, browser, challenged, state), NeedsAuth)
	// An expired session lands on the login page: never a screenshot of it.
	a.expired.Store(true)
	failed(t, run(func(*Recipe) {}, ""), NeedsAuth)
	failed(t, Verify(ctx, browser, target, state), NeedsAuth)
	a.expired.Store(false)
}

func TestRealBrowserStaysOnApprovedHosts(t *testing.T) {
	a := newProtectedApp(t)
	state := signIn(t, a)
	browser := localBrowser(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	target := a.target()
	recipe := validRecipe()
	recipe.Steps = []Step{{Kind: StepNavigate, Path: "/assets"}}
	recipe.AllowedPostPaths = []string{"/graphql"}
	result, err := Run(ctx, browser, RunInput{Target: target, Recipe: recipe, State: state})
	if err != nil {
		t.Fatal(err)
	}
	// Give the page's fire-and-forget requests time to fail or arrive.
	time.Sleep(500 * time.Millisecond)
	if result.RefusedRequests == 0 {
		t.Fatal("no request was refused")
	}
	if n := a.count("other.example.test"); n != 0 {
		t.Fatalf("an unapproved host was reached %d times", n)
	}
	if n := a.count("websocket"); n != 0 {
		t.Fatalf("a WebSocket connected %d times", n)
	}
	if n := a.count("POST /mutate"); n != 0 {
		t.Fatal("an unapproved POST reached the app")
	}
	if a.count("POST /graphql") != 1 {
		t.Fatalf("the approved read-only POST did not arrive: %d", a.count("POST /graphql"))
	}
	// A redirect off the approved hosts ends the run, and no auth state follows it.
	recipe = validRecipe()
	recipe.Steps = []Step{{Kind: StepNavigate, Path: "/leave"}}
	_, err = Run(ctx, browser, RunInput{Target: target, Recipe: recipe, State: state})
	failed(t, err, OriginRefused)
	if n := a.count("other.example.test"); n != 0 {
		t.Fatalf("a redirect reached an unapproved host %d times", n)
	}
	// DNS rebinding: an approved name that answers from a private address. Here
	// the test's resolver maps the app's name to loopback, as a rebinding would.
	addressAllowed = publicnet.IsPublic
	t.Cleanup(func() { addressAllowed = func(netip.Addr) bool { return true } })
	_, err = Run(ctx, browser, RunInput{Target: target, Recipe: validRecipe(), State: state})
	failed(t, err, OriginRefused)
	failed(t, Verify(ctx, browser, target, state), OriginRefused)
	addressAllowed = func(netip.Addr) bool { return true }
	// Exported state keeps only approved hosts' cookies.
	if cookieApproved("idp.example.org", target.Hosts) || !cookieApproved(".app.example.test", target.Hosts) {
		t.Fatal("cookie host policy")
	}
	// A parent-domain cookie is sent to the approved host, so it is part of the session.
	if !cookieApproved(".example.test", target.Hosts) || cookieApproved(".other.test", target.Hosts) || cookieApproved("ple.test", target.Hosts) {
		t.Fatal("parent domain cookie policy")
	}
}

// A frame that is not a JSON object must not reach rod, whose client panics on
// it. Browser Run really does send such frames.
func TestSocketPassesOnlyJSONObjectsToRod(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		for _, frame := range []string{"", "not json", "[1]", `{"partial":`, `{"id":1}`} {
			if err := conn.Write(r.Context(), websocket.MessageText, []byte(frame)); err != nil {
				return
			}
		}
		_, _, _ = conn.Read(r.Context())
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	got, err := (&socket{ctx: ctx, conn: conn}).Read()
	if err != nil || string(got) != `{"id":1}` {
		t.Fatalf("got=%q err=%v", got, err)
	}
}

// A rejected token is an outage: retryable, with no text from the provider.
func TestProviderRefusalIsARetryableOutage(t *testing.T) {
	status := http.StatusUnauthorized
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"errors":[{"message":"secret provider detail"}]}`))
	}))
	defer server.Close()
	provider := &Cloudflare{Base: server.URL, Token: "dummy", HTTP: server.Client()}
	for _, code := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusBadGateway} {
		status = code
		_, err := provider.Allocate(context.Background(), []string{"app.example.com"}, time.Minute)
		var failure *Failure
		if !errors.As(err, &failure) || !failure.Retryable() || strings.Contains(err.Error(), "secret") {
			t.Errorf("%d: %v", code, err)
		}
	}
	status = http.StatusBadRequest
	if _, err := provider.Allocate(context.Background(), []string{"app.example.com"}, time.Minute); err == nil || strings.Contains(err.Error(), "secret") {
		t.Errorf("400: %v", err)
	}
	if _, err := provider.Allocate(context.Background(), nil, time.Minute); err == nil {
		t.Error("a session with no approved hosts was allocated")
	}
}
