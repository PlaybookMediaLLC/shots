package browser

import (
	"context"
	"os"

	"encoding/json"
	"fmt"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func magicRecipe() LoginRecipe {
	return LoginRecipe{SchemaVersion: 1, Method: MagicLink, StartPath: "/login", EmailInput: "[data-testid=login-email]", RequestChallenge: "[data-testid=send]",
		ChallengeConfirmation: "[data-testid=sent]", SubmitPaths: []string{"/api/auth/email"}, LinkHosts: []string{"app.example.test"}, LinkPaths: []string{"/auth/callback"}}
}

func codeRecipe() LoginRecipe {
	return LoginRecipe{SchemaVersion: 1, Method: EmailCode, StartPath: "/login-code", EmailInput: "[data-testid=login-email]", RequestChallenge: "[data-testid=send]",
		SubmitPaths: []string{"/api/auth/email", "/api/auth/code"}, CodeInput: "[data-testid=code]", CodeLength: 6, SubmitCode: "[data-testid=verify]"}
}

func TestLoginRecipeAcceptsOnlyTypedFirstFactorSteps(t *testing.T) {
	if err := magicRecipe().Validate(); err != nil {
		t.Fatalf("magic link: %v", err)
	}
	if err := codeRecipe().Validate(); err != nil {
		t.Fatalf("email code: %v", err)
	}
	cases := map[string]func(*LoginRecipe){
		"schema":              func(r *LoginRecipe) { r.SchemaVersion = 2 },
		"method":              func(r *LoginRecipe) { r.Method = "PASSWORD" },
		"script selector":     func(r *LoginRecipe) { r.EmailInput = "<script>alert(1)</script>" },
		"external start":      func(r *LoginRecipe) { r.StartPath = "https://evil.example/login" },
		"logout start":        func(r *LoginRecipe) { r.StartPath = "/logout" },
		"no submit path":      func(r *LoginRecipe) { r.SubmitPaths = nil },
		"query submit path":   func(r *LoginRecipe) { r.SubmitPaths = []string{"/api?x=1"} },
		"wildcard link host":  func(r *LoginRecipe) { r.LinkHosts = []string{"*.example.test"} },
		"no link path":        func(r *LoginRecipe) { r.LinkPaths = nil },
		"code fields on link": func(r *LoginRecipe) { r.CodeInput = "#code" },
	}
	for name, change := range cases {
		recipe := magicRecipe()
		change(&recipe)
		if recipe.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	short := codeRecipe()
	short.CodeLength = 2
	if short.Validate() == nil {
		t.Error("two-digit code accepted")
	}
	linked := codeRecipe()
	linked.LinkHosts = []string{"app.example.test"}
	if linked.Validate() == nil {
		t.Error("link rules on a code recipe accepted")
	}
	a, _ := magicRecipe().Hash()
	changed := magicRecipe()
	changed.LinkPaths = []string{"/auth/other"}
	if b, _ := changed.Hash(); a == "" || a == b {
		t.Fatal("hash does not pin the recipe")
	}
}

func TestLoginRecipeApprovesOnlyExactLinks(t *testing.T) {
	recipe := magicRecipe()
	for raw, want := range map[string]bool{
		"https://app.example.test/auth/callback?token=abc":        true,
		"https://APP.example.test/auth/callback?token=abc":        true,
		"http://app.example.test/auth/callback?token=abc":         false,
		"https://app.example.test:8443/auth/callback?token=abc":   false,
		"https://user:pw@app.example.test/auth/callback":          false,
		"https://app.example.test.evil.example/auth/callback":     false,
		"https://evil.example/auth/callback":                      false,
		"https://app.example.test/auth/callback/../../admin":      false,
		"https://app.example.test/auth/other?token=abc":           false,
		"https://track.example.test/?u=https://app.example.test/": false,
	} {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := recipe.LinkAllowed(parsed); got != want {
			t.Errorf("%s: allowed=%v, want %v", raw, got, want)
		}
	}
}

func TestSecretsNeverPrintOrSerialize(t *testing.T) {
	link, code := NewSecretURL("https://app.example.test/auth/callback?token=top-secret"), NewSecretCode("123456")
	for _, printed := range []string{fmt.Sprint(link), fmt.Sprintf("%v %+v %#v %s", link, link, link, link), fmt.Sprint(code), fmt.Sprintf("%#v", code),
		fmt.Sprintf("%v", struct{ L SecretURL }{link})} {
		if strings.Contains(printed, "top-secret") || strings.Contains(printed, "123456") {
			t.Fatalf("secret printed: %s", printed)
		}
	}
	if _, err := json.Marshal(map[string]any{"link": link}); err == nil {
		t.Fatal("a link serialized")
	}
	if _, err := json.Marshal(code); err == nil {
		t.Fatal("a code serialized")
	}
}

// challengeApp is a synthetic app with first-factor email sign-in: a one-time
// link that needs the challenge cookie its request set, and a one-time code.
type challengeApp struct {
	server *httptest.Server
	port   string
	mu     sync.Mutex
	token  string
	code   string
	posts  map[string]int
	used   map[string]bool
}

func newChallengeApp(t *testing.T) *challengeApp {
	t.Helper()
	a := &challengeApp{posts: map[string]int{}, used: map[string]bool{}}
	page := func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html><body>"+body+"</body></html>")
	}
	send := `<input data-testid="login-email" type="email"><button data-testid="send" onclick="fetch('/api/auth/email',{method:'POST',body:document.querySelector('[data-testid=login-email]').value}).then(()=>document.body.insertAdjacentHTML('beforeend', NEXT))">Email me</button>`
	a.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		defer a.mu.Unlock()
		if r.Method == http.MethodPost {
			a.posts[r.URL.Path]++
		}
		switch r.URL.Path {
		case "/login":
			page(w, "<script>var NEXT='<div data-testid=sent>Check your email</div>'</script>"+send)
		case "/login-code":
			page(w, `<script>var NEXT='<input data-testid=code autocomplete=one-time-code><button data-testid=verify onclick="fetch(\'/api/auth/code\',{method:\'POST\',body:document.querySelector(\'[data-testid=code]\').value}).then(r=>{if(r.ok)location=\'/app\'})">Verify</button>'</script>`+send)
		case "/login-captcha":
			page(w, `<div class="g-recaptcha"></div>`+strings.ReplaceAll(send, "NEXT", "''"))
		case "/login-twice":
			page(w, "<script>var NEXT=''</script>"+send+send)
		case "/api/auth/email":
			a.token, a.code = fmt.Sprintf("tok-%d", len(a.used)+1), "482913"
			http.SetCookie(w, &http.Cookie{Name: "challenge", Value: "pkce", Path: "/", Secure: true, HttpOnly: true})
			w.WriteHeader(http.StatusNoContent)
		case "/auth/callback":
			cookie, err := r.Cookie("challenge")
			token := r.URL.Query().Get("token")
			if err != nil || cookie.Value != "pkce" || token == "" || token != a.token || a.used[token] {
				page(w, "<h1>This link expired</h1><a href=/login>Sign in</a>")
				return
			}
			a.used[token] = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "valid-email", Path: "/", Secure: true, HttpOnly: true})
			http.Redirect(w, r, "/app", http.StatusFound)
		case "/api/auth/code":
			body := make([]byte, 16)
			n, _ := r.Body.Read(body)
			if a.code == "" || string(body[:n]) != a.code || a.used["code"] {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			a.used["code"] = true
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "valid-email", Path: "/", Secure: true, HttpOnly: true})
			w.WriteHeader(http.StatusNoContent)
		case "/app":
			if cookie, err := r.Cookie("session"); err != nil || cookie.Value != "valid-email" {
				http.Redirect(w, r, "/login", http.StatusFound)
				return
			}
			page(w, `<header><div data-testid="account">c-test@capture-mail.example.test</div></header><main data-testid="ready">Ready</main>`)
		default:
			page(w, "<a href=/login>Sign in</a>")
		}
	}))
	t.Cleanup(a.server.Close)
	_, a.port, _ = net.SplitHostPort(a.server.Listener.Addr().String())
	previous := linkPortAllowed
	linkPortAllowed = func(port string) bool { return port == a.port }
	t.Cleanup(func() { linkPortAllowed = previous })
	return a
}

func (a *challengeApp) target() Target {
	return Target{Origin: "https://app.example.test:" + a.port, Hosts: []string{"app.example.test"}, ProtectedPath: "/app", IdentitySelector: "[data-testid=account]", ExpectedAccount: "c-test@capture-mail.example.test"}
}

func (a *challengeApp) posted(path string) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.posts[path]
}

func (a *challengeApp) issued() (string, string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.token, a.code
}

func TestRealBrowserSignsInWithAMagicLinkOnce(t *testing.T) {
	a := newChallengeApp(t)
	b := localBrowser(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	target, recipe := a.target(), magicRecipe()
	hosts := LoginHosts(target, nil, recipe)
	before := 0
	if err := RequestEmailChallenge(ctx, b, target, hosts, recipe, "c-test@capture-mail.example.test", func() error { before++; return nil }); err != nil {
		t.Fatal(err)
	}
	if before != 1 || a.posted("/api/auth/email") != 1 {
		t.Fatalf("beforeSubmit=%d sends=%d, want one of each", before, a.posted("/api/auth/email"))
	}
	token, _ := a.issued()
	// A link to a host the recipe never approved is refused before any request.
	failed(t, ApplyMagicLink(ctx, b, target, hosts, recipe, NewSecretURL("https://other.example.test:"+a.port+"/auth/callback?token="+token)), ChallengeHostRefused)
	link := NewSecretURL(target.Origin + "/auth/callback?token=" + token)
	if err := ApplyMagicLink(ctx, b, target, hosts, recipe, link); err != nil {
		t.Fatal(err)
	}
	state, err := ExportConnected(ctx, b, target)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range state.Cookies {
		if cookie.Name == "challenge" && cookie.Value != "pkce" {
			t.Fatal("unexpected cookie value")
		}
	}
	// A fresh browser, a separate process, proves the exported state.
	if err := Verify(ctx, localBrowser(t), target, state); err != nil {
		t.Fatalf("fresh-browser restore: %v", err)
	}
	// The same link again is spent: the app shows its expired page.
	failed(t, ApplyMagicLink(ctx, localBrowser(t), target, hosts, recipe, link), SignInIncomplete)
}

// sessionChrome is one provider session: a Chrome process that each call
// attaches to with a new connection, as Runner.attached does.
func sessionChrome(t *testing.T) func() *rod.Browser {
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
	t.Cleanup(func() { l.Kill(); l.Cleanup() })
	return func() *rod.Browser {
		b := rod.New().ControlURL(control).NoDefaultDevice()
		if err := b.Connect(); err != nil {
			t.Fatal(err)
		}
		return b
	}
}

func TestRealBrowserSignsInWithAnEmailCode(t *testing.T) {
	a := newChallengeApp(t)
	attach := sessionChrome(t)
	b := attach()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	target, recipe := a.target(), codeRecipe()
	hosts := LoginHosts(target, nil, recipe)
	if err := RequestEmailChallenge(ctx, b, target, hosts, recipe, "c-test@capture-mail.example.test", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	_, code := a.issued()
	if err := ApplyEmailCode(ctx, attach(), target, hosts, recipe, NewSecretCode(code)); err != nil {
		t.Fatal(err)
	}
	if a.posted("/api/auth/code") != 1 {
		t.Fatalf("code submitted %d times", a.posted("/api/auth/code"))
	}
	if _, err := ExportConnected(ctx, attach(), target); err != nil {
		t.Fatal(err)
	}
}

func TestRealBrowserRefusesAWrongCode(t *testing.T) {
	a := newChallengeApp(t)
	attach := sessionChrome(t)
	b := attach()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	target, recipe := a.target(), codeRecipe()
	hosts := LoginHosts(target, nil, recipe)
	if err := RequestEmailChallenge(ctx, b, target, hosts, recipe, "c-test@capture-mail.example.test", func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	failed(t, ApplyEmailCode(ctx, attach(), target, hosts, recipe, NewSecretCode("000000")), ChallengeExpired)
	if a.posted("/api/auth/code") != 1 {
		t.Fatalf("code submitted %d times, want once", a.posted("/api/auth/code"))
	}
}

func TestRealBrowserLeavesHumanChallengesToAPerson(t *testing.T) {
	a := newChallengeApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	target := a.target()
	for path, want := range map[string]Code{"/login-captcha": UnsupportedFactor, "/login-twice": LoginPageChanged} {
		recipe := magicRecipe()
		recipe.StartPath = path
		recipe.ChallengeConfirmation = ""
		called := false
		err := RequestEmailChallenge(ctx, localBrowser(t), target, LoginHosts(target, nil, recipe), recipe, "c-test@capture-mail.example.test", func() error { called = true; return nil })
		failed(t, err, want)
		if called {
			t.Fatalf("%s: the attempt advanced before a refusal", path)
		}
	}
	if a.posted("/api/auth/email") != 0 {
		t.Fatal("an email was requested from a page a person must handle")
	}
}
