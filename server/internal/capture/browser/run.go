package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	goimage "image"
	_ "image/png"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// Code is a safe failure reason: no URL, page text, or provider message.
type Code string

const (
	NeedsAuth            Code = "needs_auth"
	WrongAccount         Code = "wrong_account"
	WaitingForDeployment Code = "waiting_for_deployment"
	DeploymentUnverified Code = "deployment_unverified"
	MarkerMissing        Code = "marker_missing"
	ForbiddenView        Code = "forbidden_view"
	MaskMissing          Code = "mask_missing"
	OriginRefused        Code = "origin_refused"
	RecipeInvalid        Code = "recipe_invalid"
	ImageInvalid         Code = "image_invalid"
	PageFailed           Code = "page_failed"
	ProviderUnavailable  Code = "provider_unavailable"
)

// Failure carries only a safe code, so logs and API responses cannot leak.
type Failure struct{ Code Code }

func (f *Failure) Error() string { return string(f.Code) }

// Retryable reports whether trying again later could succeed on its own.
func (f *Failure) Retryable() bool {
	return f.Code == WaitingForDeployment || f.Code == DeploymentUnverified || f.Code == ProviderUnavailable || f.Code == PageFailed
}

const (
	defaultStepTimeout = 10 * time.Second
	maxImageBytes      = 20 << 20
	maxReportBytes     = 64 << 10
	// RunDeadline bounds one attempt, whatever the recipe or page does.
	RunDeadline = 90 * time.Second
)

// Target says which browser state may run where.
type Target struct {
	// Origin is the app's scheme and host, such as https://staging.example.com.
	Origin string
	// Hosts are the approved hosts: the app and its API and CDN.
	Hosts []string
	// Identity proves the signed-in account: the element's text must contain
	// ExpectedAccount. An app-owned signal, not a generic "dashboard" label.
	IdentitySelector string
	ExpectedAccount  string
	// ProtectedPath is a page only a signed-in user reaches.
	ProtectedPath string
}

// Validate refuses a target that would let a browser leave its approved hosts.
func (t Target) Validate() error {
	origin, err := url.Parse(t.Origin)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.User != nil || !capture.PublicPageURL(t.Origin) {
		return errors.New("Use the app's https origin, such as https://app.example.com.")
	}
	if len(t.Hosts) == 0 || len(t.Hosts) > MaxHosts {
		return errors.New("Approve 1–10 hosts.")
	}
	for _, host := range t.Hosts {
		if !ValidHost(host) {
			return errors.New("Approved hosts must be public host names, such as app.example.com or *.example.com.")
		}
	}
	if !HostApproved(origin.Hostname(), t.Hosts) {
		return errors.New("The app's own host must be approved.")
	}
	if !ValidPath(t.ProtectedPath) {
		return errors.New("Set a page only a signed-in user can reach.")
	}
	if !ValidSelector(t.IdentitySelector) || t.ExpectedAccount == "" || len(t.ExpectedAccount) > 200 {
		return errors.New("Name the element that shows the signed-in account, and what it must say.")
	}
	return nil
}

// HostApproved matches a host against exact names and *.example.com patterns.
func HostApproved(host string, approved []string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, pattern := range approved {
		if suffix, ok := strings.CutPrefix(pattern, "*"); ok {
			if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
				return true
			}
		} else if host == pattern {
			return true
		}
	}
	return false
}

// requestAllowed is the browser's own network policy. Guardrails are the
// outer boundary; this one adds methods and refuses literal private addresses.
func requestAllowed(method, raw string, hosts, postPaths []string) bool {
	target, err := url.Parse(raw)
	if err != nil {
		return false
	}
	switch target.Scheme {
	case "data", "blob":
		return true
	case "https":
	default:
		return false
	}
	if target.User != nil {
		return false
	}
	if address, err := netip.ParseAddr(target.Hostname()); err == nil && !publicnet.IsPublic(address) {
		return false
	}
	if !HostApproved(target.Hostname(), hosts) {
		return false
	}
	switch method {
	case "GET", "HEAD", "OPTIONS":
		return true
	case "POST":
		for _, path := range postPaths {
			if target.Path == path {
				return true
			}
		}
	}
	return false
}

// lockdown removes the APIs that the request policy below cannot see, before
// any page script runs, in every frame. Chrome's Network.setBlockedURLs was
// tested and does not stop a WebSocket. A worker has its own globals, so workers
// go too. This is a client-side control, not an egress boundary: guardrails and
// network controls outside the browser remain the boundary.
const lockdown = `(function(){
  var refuse = function(){ throw new DOMException('Blocked by capture policy', 'SecurityError') };
  ['WebSocket','WebTransport','RTCPeerConnection','webkitRTCPeerConnection','Worker','SharedWorker'].forEach(function(name){
    try { Object.defineProperty(window, name, {value: refuse, writable: false, configurable: false}) } catch (e) {}
  });
  try { Object.defineProperty(window, 'open', {value: function(){ return null }, writable: false, configurable: false}) } catch (e) {}
  try { if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'register', {value: function(){ return Promise.reject(new DOMException('Blocked by capture policy', 'SecurityError')) }, writable: false, configurable: false}) } catch (e) {}
})()`

// addressAllowed judges the address a response actually came from. Browser Run
// reports [::1] for every response, because its browser reaches the network
// through a local proxy, so loopback is no evidence of anything, and on that
// provider this check cannot see a rebinding at all: its guardrails and network
// isolation are the control there. It catches a browser that connects directly.
// A variable so a test can apply the strict rule to its loopback server.
var addressAllowed = func(address netip.Addr) bool { return address.IsLoopback() || publicnet.IsPublic(address) }

// Scope is an isolated browser context under the run's network policy.
type scope struct {
	page    *rod.Page
	context *rod.Browser
	refused atomic.Int32
	// refusedDocument means a page itself was refused, not just something on it.
	refusedDocument atomic.Bool
	// privateResponse catches DNS rebinding: an approved name that answered from
	// a private address. Names pass the request policy, so this is seen on the
	// response, and a result is then refused rather than prevented in advance.
	privateResponse atomic.Bool
	close           func()
}

// open builds a fresh isolated context: no service workers, WebSockets, or
// workers, no downloads, and every HTTP request held against the host and
// method policy.
func open(ctx context.Context, browser *rod.Browser, hosts, postPaths []string) (*scope, error) {
	isolated, err := browser.Context(ctx).Incognito()
	if err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	page, err := isolated.Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	s := &scope{page: page, context: isolated}
	for _, setup := range []func() error{
		func() error { return proto.NetworkEnable{}.Call(page) },
		func() error { return proto.NetworkSetBypassServiceWorker{Bypass: true}.Call(page) },
		func() error { _, err := page.EvalOnNewDocument(lockdown); return err },
		func() error {
			return proto.BrowserSetDownloadBehavior{Behavior: proto.BrowserSetDownloadBehaviorBehaviorDeny, BrowserContextID: isolated.BrowserContextID}.Call(browser)
		},
	} {
		if err := setup(); err != nil {
			return nil, &Failure{Code: ProviderUnavailable}
		}
	}
	router := page.HijackRequests()
	if err := router.Add("*", "", func(hijack *rod.Hijack) {
		if requestAllowed(hijack.Request.Method(), hijack.Request.URL().String(), hosts, postPaths) {
			hijack.ContinueRequest(&proto.FetchContinueRequest{})
			return
		}
		s.refused.Add(1)
		if hijack.Request.Type() == proto.NetworkResourceTypeDocument {
			s.refusedDocument.Store(true)
		}
		hijack.Response.Fail(proto.NetworkErrorReasonBlockedByClient)
	}); err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	go router.Run()
	// A dialog would stall the page until its deadline; nothing here answers yes.
	go page.Context(ctx).EachEvent(func(e *proto.NetworkResponseReceived) {
		if address, err := netip.ParseAddr(strings.Trim(e.Response.RemoteIPAddress, "[]")); err == nil && !addressAllowed(address) {
			s.privateResponse.Store(true)
		}
	}, func(*proto.PageJavascriptDialogOpening) {
		_ = proto.PageHandleJavaScriptDialog{Accept: false}.Call(page)
	})()
	s.close = func() {
		_ = router.Stop()
		_ = page.Close()
		_ = proto.TargetDisposeBrowserContext{BrowserContextID: isolated.BrowserContextID}.Call(browser)
	}
	return s, nil
}

func (s *scope) restore(state *State) error {
	if state == nil {
		return nil
	}
	if len(state.Cookies) > 0 {
		if err := s.context.SetCookies(state.Cookies); err != nil {
			return &Failure{Code: ProviderUnavailable}
		}
	}
	if len(state.LocalStorage) > 0 {
		encoded, err := json.Marshal(state.LocalStorage)
		if err != nil {
			return err
		}
		// Runs before the app's scripts, once per tab, so the app's own rotated
		// tokens are not overwritten on the next navigation.
		if _, err := s.page.EvalOnNewDocument(`(function(s){try{var v=s[location.origin];if(!v||sessionStorage.getItem('__shots_restored'))return;for(var k in v)localStorage.setItem(k,v[k]);sessionStorage.setItem('__shots_restored','1')}catch(e){}})(` + string(encoded) + `)`); err != nil {
			return &Failure{Code: ProviderUnavailable}
		}
	}
	return nil
}

func (s *scope) location() (*url.URL, error) {
	info, err := s.page.Info()
	if err != nil {
		return nil, &Failure{Code: PageFailed}
	}
	return url.Parse(info.URL)
}

func (s *scope) evalBool(ctx context.Context, script string, args ...any) (bool, error) {
	result, err := s.page.Context(ctx).Eval(script, args...)
	if err != nil {
		return false, err
	}
	return result.Value.Bool(), nil
}

// signedOut sees a sign-in page however the app got there.
func (s *scope) signedOut(ctx context.Context, requested string) bool {
	if capture.IsSignInPath(requested) {
		return false
	}
	if here, err := s.location(); err == nil && capture.IsSignInPath(here.Path) {
		return true
	}
	password, err := s.evalBool(ctx, `() => !!document.querySelector('input[type=password]')`)
	return err == nil && password
}

// waitFor polls for an element, so a page with persistent connections needs no
// network-idle test. A missing element on a sign-in page means the session is
// gone, not that the recipe is broken.
func (s *scope) waitFor(ctx context.Context, selector string, timeout time.Duration, requested string, missing Code) error {
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		found, err := s.evalBool(waitCtx, `(selector) => !!document.querySelector(selector)`, selector)
		if err == nil && found {
			return nil
		}
		if s.signedOut(waitCtx, requested) {
			return &Failure{Code: NeedsAuth}
		}
		select {
		case <-waitCtx.Done():
			if s.signedOut(ctx, requested) {
				return &Failure{Code: NeedsAuth}
			}
			return &Failure{Code: missing}
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func stepTimeout(step Step) time.Duration {
	if step.TimeoutMs > 0 {
		return time.Duration(step.TimeoutMs) * time.Millisecond
	}
	return defaultStepTimeout
}

func (s *scope) navigate(ctx context.Context, target Target, path string, timeout time.Duration) error {
	navigateCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	page := s.page.Context(navigateCtx)
	// A redirect to a refused host fails the navigation itself. Refused analytics
	// on a page that merely timed out is a retryable failure, not a refusal.
	failed := func() error {
		if s.refusedDocument.Load() {
			return &Failure{Code: OriginRefused}
		}
		return &Failure{Code: PageFailed}
	}
	if err := page.Navigate(target.Origin + path); err != nil {
		return failed()
	}
	if err := page.WaitLoad(); err != nil {
		return failed()
	}
	here, err := s.location()
	if err != nil {
		return &Failure{Code: PageFailed}
	}
	// A failed navigation to a blocked host lands on Chrome's error page.
	if here.Scheme == "chrome-error" || (here.Scheme == "https" && !HostApproved(here.Hostname(), target.Hosts)) {
		return failed()
	}
	if s.signedOut(ctx, path) {
		return &Failure{Code: NeedsAuth}
	}
	return nil
}

func (s *scope) checkIdentity(ctx context.Context, target Target, requested string) error {
	// No account shown at all is a sign-in, MFA, or CAPTCHA screen under another
	// name: only a person can get past it. Another account's name is WrongAccount.
	if err := s.waitFor(ctx, target.IdentitySelector, defaultStepTimeout, requested, NeedsAuth); err != nil {
		return err
	}
	matches, err := s.evalBool(ctx, `(selector, expected) => (document.querySelector(selector).textContent || '').includes(expected)`, target.IdentitySelector, target.ExpectedAccount)
	if err != nil {
		return &Failure{Code: PageFailed}
	}
	if !matches {
		return &Failure{Code: WrongAccount}
	}
	return nil
}

// proveRevision asks the signed-in app which commit it runs.
func (s *scope) proveRevision(ctx context.Context, check *VersionCheck, sha string) (string, error) {
	var report string
	if check.Path != "" {
		result, err := s.page.Context(ctx).Eval(`(path, limit) => fetch(path, {credentials: 'include', cache: 'no-store'}).then((r) => r.ok ? r.text() : '').then((t) => t.slice(0, limit)).catch(() => '')`, check.Path, maxReportBytes)
		if err != nil {
			return "", &Failure{Code: PageFailed}
		}
		report = result.Value.Str()
	} else {
		result, err := s.page.Context(ctx).Eval(`(selector) => { const e = document.querySelector(selector); return e ? (e.getAttribute('content') || e.textContent || '') : '' }`, check.Selector)
		if err != nil {
			return "", &Failure{Code: PageFailed}
		}
		report = result.Value.Str()
	}
	switch capture.CompareRevision(report, sha) {
	case capture.RevisionMatches:
		return sha, nil
	case capture.RevisionOther:
		return "", &Failure{Code: WaitingForDeployment}
	}
	return "", &Failure{Code: DeploymentUnverified}
}

// settle waits for fonts and images, bounded, rather than one fixed sleep.
func (s *scope) settle(ctx context.Context) {
	settleCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, _ = s.page.Context(settleCtx).Eval(`() => Promise.all([document.fonts ? document.fonts.ready : null,
		...Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((done) => { i.onload = i.onerror = done }))]).then(() => true)`)
}

func (s *scope) applyMasks(ctx context.Context, masks []string) error {
	for _, selector := range masks {
		painted, err := s.evalBool(ctx, `(selector) => {
			const found = Array.from(document.querySelectorAll(selector));
			found.forEach((e) => { e.style.setProperty('background', '#000', 'important'); e.style.setProperty('color', '#000', 'important');
				e.style.setProperty('filter', 'brightness(0)', 'important'); e.style.setProperty('border-color', '#000', 'important') });
			return found.length > 0 }`, selector)
		if err != nil || !painted {
			return &Failure{Code: MaskMissing}
		}
	}
	return nil
}

// RunInput is one attempt at one recipe. ExpectedRevision is empty only for a
// capture explicitly labeled as the current state.
type RunInput struct {
	Target           Target
	Recipe           Recipe
	State            *State
	ExpectedRevision string
}

// RunResult is a verified image and, when the app rotated tokens, new state.
type RunResult struct {
	Image            []byte
	Width, Height    int
	ObservedRevision string
	State            *State
	RefusedRequests  int
}

// Run restores state into a fresh context and executes the recipe, refusing
// sign-in pages, the wrong account, an unproven version, missing markers and
// missing masks. No browser is left open between steps of a person's waiting.
func Run(ctx context.Context, browser *rod.Browser, input RunInput) (*RunResult, error) {
	if err := input.Target.Validate(); err != nil {
		return nil, &Failure{Code: RecipeInvalid}
	}
	if err := input.Recipe.Validate(); err != nil {
		return nil, &Failure{Code: RecipeInvalid}
	}
	if input.ExpectedRevision != "" && input.Recipe.Version == nil {
		return nil, &Failure{Code: DeploymentUnverified}
	}
	ctx, cancel := context.WithTimeout(ctx, RunDeadline)
	defer cancel()
	s, err := open(ctx, browser, input.Target.Hosts, input.Recipe.AllowedPostPaths)
	if err != nil {
		return nil, err
	}
	defer s.close()
	if err := s.page.Context(ctx).SetViewport(&proto.EmulationSetDeviceMetricsOverride{Width: input.Recipe.Viewport.Width, Height: input.Recipe.Viewport.Height, DeviceScaleFactor: 1}); err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	if err := s.restore(input.State); err != nil {
		return nil, err
	}
	requested := ""
	identified := false
	for _, step := range input.Recipe.Steps {
		switch step.Kind {
		case StepNavigate:
			requested = step.Path
			if err := s.navigate(ctx, input.Target, step.Path, stepTimeout(step)); err != nil {
				return nil, err
			}
			if !identified {
				if err := s.checkIdentity(ctx, input.Target, requested); err != nil {
					return nil, err
				}
				identified = true
			}
		case StepWaitFor:
			if err := s.waitFor(ctx, step.Selector, stepTimeout(step), requested, MarkerMissing); err != nil {
				return nil, err
			}
		case StepSelectTab:
			if err := s.selectTab(ctx, step, requested); err != nil {
				return nil, err
			}
		}
	}
	result := &RunResult{}
	if input.ExpectedRevision != "" {
		if result.ObservedRevision, err = s.proveRevision(ctx, input.Recipe.Version, input.ExpectedRevision); err != nil {
			return nil, err
		}
	}
	for _, marker := range input.Recipe.Markers {
		if err := s.waitFor(ctx, marker, defaultStepTimeout, requested, MarkerMissing); err != nil {
			return nil, err
		}
	}
	for _, selector := range input.Recipe.Forbidden {
		present, err := s.evalBool(ctx, `(selector) => !!document.querySelector(selector)`, selector)
		if err != nil || present {
			return nil, &Failure{Code: ForbiddenView}
		}
	}
	s.settle(ctx)
	if s.privateResponse.Load() {
		return nil, &Failure{Code: OriginRefused}
	}
	if err := s.applyMasks(ctx, input.Recipe.Masks); err != nil {
		return nil, err
	}
	shot, err := s.page.Context(ctx).Screenshot(false, &proto.PageCaptureScreenshot{Format: proto.PageCaptureScreenshotFormatPng})
	if err != nil {
		return nil, &Failure{Code: PageFailed}
	}
	config, _, err := goimage.DecodeConfig(bytes.NewReader(shot))
	if err != nil || len(shot) > maxImageBytes || config.Width != input.Recipe.Viewport.Width || config.Height != input.Recipe.Viewport.Height {
		return nil, &Failure{Code: ImageInvalid}
	}
	result.Image, result.Width, result.Height = shot, config.Width, config.Height
	result.RefusedRequests = int(s.refused.Load())
	// A failed export keeps the state already stored; the capture still stands.
	if rotated, err := exportState(ctx, s.context, s.page, input.Target); err == nil && !rotated.Same(input.State) {
		result.State = rotated
	}
	return result, nil
}

// selectTab clicks only an element that declares itself a tab.
func (s *scope) selectTab(ctx context.Context, step Step, requested string) error {
	if err := s.waitFor(ctx, step.Selector, stepTimeout(step), requested, MarkerMissing); err != nil {
		return err
	}
	isTab, err := s.evalBool(ctx, `(selector) => { const e = document.querySelector(selector); return e.getAttribute('role') === 'tab' || e.hasAttribute('aria-selected') }`, step.Selector)
	if err != nil || !isTab {
		return &Failure{Code: RecipeInvalid}
	}
	clicked, err := s.evalBool(ctx, `(selector) => { document.querySelector(selector).click(); return true }`, step.Selector)
	if err != nil || !clicked {
		return &Failure{Code: PageFailed}
	}
	return nil
}

// Verify restores state into a fresh context and proves it reaches a protected
// page as the expected account. Only this makes a connection ready: a person's
// "Done" alone is not proof.
func Verify(ctx context.Context, browser *rod.Browser, target Target, state *State) error {
	if err := target.Validate(); err != nil {
		return &Failure{Code: RecipeInvalid}
	}
	ctx, cancel := context.WithTimeout(ctx, RunDeadline)
	defer cancel()
	s, err := open(ctx, browser, target.Hosts, nil)
	if err != nil {
		return err
	}
	defer s.close()
	if err := s.restore(state); err != nil {
		return err
	}
	if err := s.navigate(ctx, target, target.ProtectedPath, defaultStepTimeout*2); err != nil {
		return err
	}
	if err := s.checkIdentity(ctx, target, target.ProtectedPath); err != nil {
		return err
	}
	if s.privateResponse.Load() {
		return &Failure{Code: OriginRefused}
	}
	return nil
}

// ErrNoPages means the person closed the browser before finishing.
var ErrNoPages = fmt.Errorf("the sign-in browser has no open page")
