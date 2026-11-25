package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	goimage "image"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/go-rod/rod/lib/proto"
)

// NavigationControl is an observed navigation choice, never model-supplied code.
type NavigationControl struct {
	ID       int    `json:"id"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Path     string `json:"path,omitempty"`
	selector string
}

// NavigationObservation contains paths, headings and navigation labels. Input
// values, account elements, masked content and sensitive URL queries never reach a model.
// Current names the selected tabs and open controls, which are not choices.
type NavigationObservation struct {
	Path      string              `json:"path"`
	Headings  []string            `json:"headings"`
	Current   []string            `json:"current"`
	Controls  []NavigationControl `json:"controls"`
	Ready     bool                `json:"ready"`
	CanScroll bool                `json:"canScroll,omitempty"`
	// ViewportPNG holds an optional Set-of-Mark annotated viewport screenshot
	// (with masked/identity regions covered) when Navigation.UseVision is enabled.
	// Excluded from JSON serialization so image bytes never enter prompt text or logs.
	ViewportPNG []byte `json:"-"`
	loading     bool
	contentHash string
	scrollY     int
}

// NavigationChoice must select an ID from the latest observation, fill a safe
// search/filter input, scroll, capture a proven destination, or stop. The
// browser revalidates every choice.
type NavigationChoice struct {
	Action    string `json:"action"`
	ControlID *int   `json:"controlId"`
	Value     string `json:"value,omitempty"`
}

// NavigationAction records the executed action without page text or secrets.
type NavigationAction struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
}

// NextNavigationAction is supplied by the product's existing model and meter.
type NextNavigationAction func(context.Context, NavigationObservation) (NavigationChoice, error)

const (
	NavigationUnavailable Code = "navigation_unavailable"
	// NavigationUnconfigured is final: this worker has no model or meter, so
	// retrying here until the job's deadline could never succeed.
	NavigationUnconfigured Code = "navigation_unconfigured"
	NavigationInvalid      Code = "navigation_invalid"
	NavigationFailed       Code = "navigation_failed"
	NavigationLimit        Code = "navigation_limit"
	NavigationBudget       Code = "navigation_budget"
	NavigationRetryLimit   Code = "navigation_retry_limit"
)

// navigationChecks are the checks observation and press share, so a label the
// model saw is exactly the label a press compares. identity, masks and account
// are in scope; e is an element. Only controls that open something are
// pressable: a menu, panel, dialog or disclosure, never a toggle, a grid row, a
// control in a form, one already open (pressing it closes what it opened), one
// that submits or resets, or one named for a risky action. The network policy refuses writes to other paths, but an allowed GET
// or POST path, or what a click stores in the session, can still change state,
// so the selection itself stays narrow.
const navigationChecks = `
 const pressableSelector = 'button[aria-haspopup],button[aria-expanded],[role=button][aria-haspopup],[role=button][aria-expanded],[role=menuitem][aria-haspopup],summary';
 const visionButtonSelector = pressableSelector + ',button[aria-label],[role=button][aria-label]';
 const searchSelector = 'input[type=search],input[role=searchbox],input[role=combobox],input[type=text][placeholder*="search" i],input[type=text][placeholder*="filter" i],input[type=text][aria-label*="search" i],input[type=text][aria-label*="filter" i],input:not([type])[placeholder*="search" i],input:not([type])[placeholder*="filter" i],input:not([type])[aria-label*="search" i],input:not([type])[aria-label*="filter" i]';
 const visible = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const excluded = e => { const selectors=[identity,...(masks || []),'form','[contenteditable=true]'].filter(Boolean).join(','); return !!e.closest(selectors) || !!e.querySelector(selectors); };
 const raw = e => e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '';
 const allText = e => [e.innerText, e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('title')].filter(Boolean).join(' ');
 const accountPattern = account ? new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
 const mentionsAccount = e => !!account && allText(e).toLowerCase().includes(account.toLowerCase());
 const text = e => { let label = raw(e).trim().replace(/\s+/g,' ').replace(/[^\s@]+@[^\s@]+/g,'[private]'); if (accountPattern) label = label.replace(accountPattern,'[account]'); return label.slice(0,120); };
 const riskyLabel = /\b(delete|remove|destroy|erase|trash|discard|sign[ -]?(out|off)|log[ -]?(out|off)|exit|end session|close account|unsubscribe|cancel|buy|purchase|pay|checkout|publish|send|submit|save|invite|confirm|revoke|leave|transfer|deactivate|disable|enable|reset|archive|approve|reject|merge|deploy|uninstall|disconnect|start|run|generate|retry|duplicate|switch|impersonate)\b/i;
 const visionRiskyLabel = /\b(create|add|clear|wipe|purge|export|toggle|close|pause|stop|mute|block|lock|unlock)\b/i;
 const sensitiveInput = /\b(password|passcode|secret|token|card|cvv|cvc|ssn|email|phone|billing|credit|iban|routing|account number|api key)\b/i;
 const pressable = (e, allowVisionButtons) => e.matches(allowVisionButtons ? visionButtonSelector : pressableSelector) &&
   !e.matches('a[href],input,[form],button[type=submit],button[type=reset],[role=switch],[role=checkbox],[role=radio],[role=option],[aria-checked],[aria-pressed],[aria-expanded=true],details[open]>summary') &&
   !e.closest('form,table,[role=grid],[role=treegrid],[role=row]') &&
   !riskyLabel.test(allText(e)) &&
   (!allowVisionButtons || e.matches(pressableSelector) || !visionRiskyLabel.test(allText(e)));
 const safeSearch = e => (e instanceof HTMLInputElement) &&
   (!e.type || e.type === 'text' || e.type === 'search') &&
   e.matches(searchSelector) &&
   !e.matches('[form]') &&
   !e.readOnly && !e.disabled &&
   !e.closest('form,[role=dialog] form') &&
   !sensitiveInput.test(allText(e) + ' ' + (e.name || '') + ' ' + (e.id || '') + ' ' + (e.getAttribute('autocomplete') || ''));
`

// observeNavigation offers navigation links, explicit tabs, safe pressable
// controls, and (when enabled) safe read-only search inputs, stopping at 60.
// All DOM reads happen before tagging elements with transient data-shots-nav
// attributes to avoid interleaved layout thrashing during waitNavigation polling.
const observeNavigation = `(identity, masks, markers, account, buttons, allowSearchFill, allowVisionButtons) => {` + navigationChecks + `
 const usable = e => visible(e) && !excluded(e) && !mentionsAccount(e) && !e.hasAttribute('download') && e.getAttribute('aria-disabled')!=='true' && !e.disabled && e.getAttribute('aria-selected')!=='true';
 const links = new Set(document.querySelectorAll('nav a[href],[role=navigation] a[href],aside a[href],[role=tab]'));
 const searches = new Set();
 const chosen = [];
 const picked = new Set();
 for (const e of links) { if (chosen.length >= 60) break; if (usable(e)) { chosen.push(e); picked.add(e); } }
 if (buttons) {
   const btnSel = allowVisionButtons ? visionButtonSelector : pressableSelector;
   for (const e of document.querySelectorAll(btnSel)) { if (chosen.length >= 60) break; if (!picked.has(e) && usable(e) && pressable(e, allowVisionButtons)) { chosen.push(e); picked.add(e); } }
 }
 if (buttons && allowSearchFill) {
   for (const e of document.querySelectorAll(searchSelector)) {
     if (chosen.length >= 60) break;
     if (!picked.has(e) && usable(e) && safeSearch(e)) { searches.add(e); chosen.push(e); picked.add(e); }
   }
 }
 const headings = Array.from(document.querySelectorAll('h1,h2,[role=heading]')).filter(e=>visible(e)&&!excluded(e)).slice(0,12).map(text);
 const current = Array.from(document.querySelectorAll('[role=tab][aria-selected=true],[aria-expanded=true],details[open]>summary')).filter(e=>e.matches('[role=tab],'+pressableSelector)&&!e.closest('table,[role=grid],[role=treegrid],[role=row]')&&visible(e)&&!excluded(e)&&!mentionsAccount(e)).slice(0,12).map(text).filter(Boolean);
 const loading = Array.from(document.querySelectorAll('[aria-busy=true],[role=progressbar]')).some(visible);
 const ready = markers.every(s=>Array.from(document.querySelectorAll(s)).some(visible));
 const main = document.querySelector('main,[role=main]') || document.body;
 let hash = 0;
 if (main) {
   const sample = (main.textContent || '').replace(/\s+/g, ' ').slice(0, 8000);
   for (let i = 0; i < sample.length; i++) { hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0; }
 }
 const scrollY = Math.round(window.scrollY || 0);
 const canScroll = (document.documentElement.scrollHeight - (scrollY + window.innerHeight)) > 120;
 const controls = chosen.map(e => ({kind:searches.has(e)?'search':e.getAttribute('role')==='tab'?'tab':links.has(e)?'link':'button',label:text(e),href:e.href || '',selector:''}));
 document.querySelectorAll('[data-shots-nav]').forEach(el => el.removeAttribute('data-shots-nav'));
 for (let i = 0; i < chosen.length; i++) {
   const id = 'c' + (i + 1);
   chosen[i].setAttribute('data-shots-nav', id);
   controls[i].selector = '[data-shots-nav="' + id + '"]';
 }
 return {headings,controls,current,loading,ready,contentHash:String(hash),scrollY,canScroll};
}`

// sensitiveQueryParam blocks query keys that may carry secrets or auth tokens.
func sensitiveQueryParam(key string) bool {
	lower := strings.ToLower(strings.TrimSpace(key))
	for _, blocked := range []string{"token", "code", "auth", "key", "secret", "password", "passwd", "session", "jwt", "ticket", "sig", "cookie", "nonce", "state", "email"} {
		if strings.Contains(lower, blocked) {
			return true
		}
	}
	return false
}

func navigationPath(raw, origin string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme+"://"+u.Host != origin || u.User != nil || u.Fragment != "" {
		return "", false
	}
	target := u.EscapedPath()
	if u.RawQuery != "" {
		q, err := url.ParseQuery(u.RawQuery)
		if err != nil || len(q) > 6 {
			return "", false
		}
		for k, vals := range q {
			if sensitiveQueryParam(k) {
				return "", false
			}
			for _, v := range vals {
				if strings.Contains(v, "@") || len(v) > 64 {
					return "", false
				}
			}
		}
		target += "?" + u.RawQuery
	}
	if !ValidPath(target) {
		return "", false
	}
	for _, segment := range strings.FieldsFunc(strings.ToLower(u.Path), func(r rune) bool { return r == '/' || r == '-' || r == '_' || r == '.' }) {
		switch segment {
		case "api", "auth", "login", "logout", "signin", "signout", "delete", "remove", "destroy", "checkout", "unsubscribe":
			return "", false
		}
	}
	return target, true
}

func (s *scope) observeNavigation(ctx context.Context, input RunInput, captureVision bool) (NavigationObservation, error) {
	view := NavigationObservation{Headings: []string{}, Current: []string{}, Controls: []NavigationControl{}}
	here, err := s.location()
	if err != nil || here.Scheme+"://"+here.Host != input.Target.Origin || s.privateResponse.Load() {
		return view, &Failure{Code: OriginRefused}
	}
	view.Path = here.EscapedPath()
	if err := s.checkIdentity(ctx, input.Target, view.Path); err != nil {
		return view, err
	}
	if safeWithQuery, ok := navigationPath(here.String(), input.Target.Origin); ok {
		view.Path = safeWithQuery
	}
	allMasks := append(slices.Clone(input.Recipe.Masks), input.Recipe.OptionalMasks...)
	allowSearch := input.Recipe.Navigation != nil && input.Recipe.Navigation.AllowSearchFill
	useVision := input.Recipe.Navigation != nil && input.Recipe.Navigation.UseVision
	// A recipe that allows POST paths may expose a write behind any control, so it navigates by links and tabs only.
	result, err := s.page.Context(ctx).Eval(observeNavigation, input.Target.IdentitySelector, allMasks, input.Recipe.Markers, input.Target.ExpectedAccount,
		len(input.Recipe.AllowedPostPaths) == 0, allowSearch, useVision)
	if err != nil {
		return view, &Failure{Code: PageFailed}
	}
	var snapshot struct {
		Headings    []string `json:"headings"`
		Current     []string `json:"current"`
		Ready       bool     `json:"ready"`
		Loading     bool     `json:"loading"`
		ContentHash string   `json:"contentHash"`
		ScrollY     int      `json:"scrollY"`
		CanScroll   bool     `json:"canScroll"`
		Controls    []struct {
			Kind, Label, Href, Selector string
		} `json:"controls"`
	}
	if err := json.Unmarshal([]byte(result.Value.JSON("", "")), &snapshot); err != nil {
		return view, &Failure{Code: PageFailed}
	}
	view.Headings, view.Current, view.Ready = snapshot.Headings, snapshot.Current, snapshot.Ready
	view.loading, view.contentHash, view.scrollY, view.CanScroll = snapshot.Loading, snapshot.ContentHash, snapshot.ScrollY, snapshot.CanScroll
	view.Ready = view.Ready && !view.loading
	currentFullPath := view.Path
	if here.RawQuery != "" {
		currentFullPath += "?" + here.RawQuery
	}
	for _, control := range snapshot.Controls {
		if control.Label == "" || (control.Kind != "link" && !ValidSelector(control.Selector)) {
			continue
		}
		path := ""
		if control.Kind == "link" {
			var allowed bool
			path, allowed = navigationPath(control.Href, input.Target.Origin)
			if !allowed || path == currentFullPath {
				continue
			}
		}
		view.Controls = append(view.Controls, NavigationControl{ID: len(view.Controls), Kind: control.Kind, Label: control.Label, Path: path, selector: control.Selector})
	}
	if captureVision && useVision {
		shot, shotErr := s.captureSetOfMarkScreenshot(ctx, input, view.Controls)
		if shotErr != nil {
			var failure *Failure
			if errors.As(shotErr, &failure) {
				return view, shotErr
			}
		} else {
			view.ViewportPNG = shot
		}
	}
	return view, nil
}

// captureOverlayScreenshot paints temporary mask overlays (and optional
// Set-of-Mark badges + PII covers for vision previews), takes the screenshot,
// and cleans up the overlay with a bounded timeout so hung tabs never stall
// workers and stray overlays never leak into final screenshots.
func (s *scope) captureOverlayScreenshot(ctx context.Context, attr string, masks []string, blur bool, badges []map[string]any, visionPrivacyAccount string, jpegPreview bool) (shot []byte, err error) {
	defer func() {
		if ctx.Err() != nil {
			return
		}
		cleanCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
		defer cancel()
		if _, cleanErr := s.page.Context(cleanCtx).Eval(`(attr) => document.querySelectorAll('[' + attr + ']').forEach(n => n.remove())`, attr); cleanErr != nil && err == nil {
			err = &Failure{Code: PageFailed}
		}
	}()
	_, err = s.page.Context(ctx).Eval(`(attr, masks, blur, badges, account, hideForms) => {
		document.querySelectorAll('[' + attr + ']').forEach(n => n.remove());
		const root = document.createElement('div');
		root.setAttribute(attr, '1');
		root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
		const addCover = (el, solidOnly) => {
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return;
			const cover = document.createElement('div');
			cover.style.cssText = (!solidOnly && blur ? 'backdrop-filter:blur(12px);background:rgba(15,23,42,0.18);' : 'background:#000;') +
				'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
			root.appendChild(cover);
		};
		for (const sel of (masks || [])) {
			for (const el of document.querySelectorAll(sel)) addCover(el, false);
		}
		if (hideForms) {
			for (const el of document.querySelectorAll('form,textarea,[contenteditable=true]')) addCover(el, true);
			for (const el of document.querySelectorAll('input')) {
				if (el.value && el.value.trim() !== '') addCover(el, true);
			}
			if (account) {
				const needle = account.toLowerCase();
				for (const el of document.querySelectorAll('header *,nav *,aside *,[role=banner] *,[role=navigation] *')) {
					if (el.children.length === 0 && (el.textContent || '').toLowerCase().includes(needle)) addCover(el, true);
				}
			}
		}
		for (const b of (badges || [])) {
			const el = document.querySelector(b.selector);
			if (!el) continue;
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
			const tag = document.createElement('div');
			tag.textContent = String(b.id);
			tag.style.cssText = 'position:fixed;background:#ef4444;color:#fff;font:700 11px/1 monospace;padding:2px 4px;border-radius:3px;border:1px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.4);left:' + Math.max(0, r.left) + 'px;top:' + Math.max(0, r.top) + 'px;';
			root.appendChild(tag);
		}
		document.documentElement.appendChild(root);
	}`, attr, masks, blur, badges, visionPrivacyAccount, jpegPreview)
	if err != nil {
		return nil, err
	}
	req := &proto.PageCaptureScreenshot{Format: proto.PageCaptureScreenshotFormatPng}
	if jpegPreview {
		q := 75
		req = &proto.PageCaptureScreenshot{Format: proto.PageCaptureScreenshotFormatJpeg, Quality: &q}
	}
	shot, err = s.page.Context(ctx).Screenshot(false, req)
	return shot, err
}

// captureSetOfMarkScreenshot paints temporary numbered badges over observed
// controls and covers masked/identity/form regions before taking a compact JPEG
// viewport preview for the vision model, then immediately removes overlays.
func (s *scope) captureSetOfMarkScreenshot(ctx context.Context, input RunInput, controls []NavigationControl) ([]byte, error) {
	allMasks := append(slices.Clone(input.Recipe.Masks), input.Recipe.OptionalMasks...)
	visionAccount := ""
	if input.Target.IdentitySelector != "" {
		allMasks = append(allMasks, input.Target.IdentitySelector)
	} else {
		visionAccount = strings.TrimSpace(input.Target.ExpectedAccount)
	}
	badges := make([]map[string]any, 0, len(controls))
	for _, c := range controls {
		if c.selector != "" {
			badges = append(badges, map[string]any{"id": c.ID, "selector": c.selector})
		}
	}
	return s.captureOverlayScreenshot(ctx, "data-shots-som", allMasks, false, badges, visionAccount, true)
}

// captureMaskedSequenceFrame takes an intermediate masked screenshot during a
// multi-shot AI flow only when origin, required masks, and forbidden-view checks
// all hold, without permanently altering the DOM before the next step.
func (s *scope) captureMaskedSequenceFrame(ctx context.Context, input RunInput) (*SequenceShot, error) {
	if s.privateResponse.Load() {
		return nil, &Failure{Code: OriginRefused}
	}
	here, err := s.location()
	if err != nil || here.Scheme+"://"+here.Host != input.Target.Origin {
		return nil, &Failure{Code: OriginRefused}
	}
	safe, err := s.evalBool(ctx, `(requiredMasks, forbidden) => {
		const vis = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
		for (const sel of (forbidden || [])) {
			if (Array.from(document.querySelectorAll(sel)).some(vis)) return false;
		}
		for (const sel of (requiredMasks || [])) {
			if (document.querySelectorAll(sel).length === 0) return false;
		}
		return true;
	}`, input.Recipe.Masks, input.Recipe.Forbidden)
	if err != nil || !safe {
		return nil, &Failure{Code: MaskMissing}
	}
	allMasks := append(slices.Clone(input.Recipe.Masks), input.Recipe.OptionalMasks...)
	shot, err := s.captureOverlayScreenshot(ctx, "data-shots-seq-mask", allMasks, input.Recipe.MaskStyle == MaskStyleBlur, nil, "", false)
	if err != nil {
		return nil, err
	}
	scale := input.Recipe.Viewport.DeviceScale()
	cfg, format, err := goimage.DecodeConfig(bytes.NewReader(shot))
	if err != nil || format != "png" || len(shot) > maxImageBytes*scale {
		return nil, &Failure{Code: ImageInvalid}
	}
	return &SequenceShot{Image: shot, Width: cfg.Width, Height: cfg.Height}, nil
}

// Wait for feature evidence, content update, or new navigation, not just a selected tab attribute.
func (s *scope) waitNavigation(ctx context.Context, input RunInput, before NavigationObservation) error {
	waitCtx, cancel := context.WithTimeout(ctx, defaultStepTimeout)
	defer cancel()
	for {
		view, err := s.observeNavigation(waitCtx, input, false)
		if err != nil {
			return err
		}
		changed := view.Path != before.Path || (!before.Ready && view.Ready) || !slices.Equal(view.Headings, before.Headings) ||
			(before.contentHash != "" && view.contentHash != "" && view.contentHash != before.contentHash) ||
			view.scrollY != before.scrollY
		for _, control := range view.Controls {
			if !slices.ContainsFunc(before.Controls, func(old NavigationControl) bool {
				return old.Kind == control.Kind && old.Label == control.Label && old.Path == control.Path
			}) {
				changed = true
			}
		}
		if !view.loading && changed {
			return nil
		}
		select {
		case <-waitCtx.Done():
			return &Failure{Code: NavigationFailed}
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// pressButton presses the observed control only if it still passes every check
// the observation applied and has the same label; the page may change while the
// model chooses.
func (s *scope) pressButton(ctx context.Context, input RunInput, selector, label string) error {
	allMasks := append(slices.Clone(input.Recipe.Masks), input.Recipe.OptionalMasks...)
	allowVisionButtons := input.Recipe.Navigation != nil && input.Recipe.Navigation.UseVision
	pressed, err := s.evalBool(ctx, `(selector, expected, identity, masks, account, allowVisionButtons) => {`+navigationChecks+`
		const e = document.querySelector(selector);
		if (!e || !pressable(e, allowVisionButtons) || excluded(e) || mentionsAccount(e) || !visible(e) || e.disabled || e.getAttribute('aria-disabled')==='true' || text(e) !== expected) return false;
		e.click(); return true;
	}`, selector, label, input.Target.IdentitySelector, allMasks, input.Target.ExpectedAccount, allowVisionButtons)
	if err != nil {
		return &Failure{Code: PageFailed}
	}
	if !pressed {
		return &Failure{Code: NavigationInvalid}
	}
	return nil
}

// validSearchValue keeps AI search/filter queries short, plain text, and free
// of URLs, emails, or control characters.
func validSearchValue(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) == 0 || len(trimmed) > 80 {
		return "", false
	}
	lower := strings.ToLower(trimmed)
	if strings.Contains(trimmed, "@") || strings.Contains(lower, "http://") || strings.Contains(lower, "https://") {
		return "", false
	}
	for _, r := range trimmed {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return trimmed, true
}

// fillSearch sets a safe read-only search/filter input without submitting any form.
func (s *scope) fillSearch(ctx context.Context, input RunInput, selector, label, value string) error {
	clean, ok := validSearchValue(value)
	if !ok {
		return &Failure{Code: NavigationInvalid}
	}
	allMasks := append(slices.Clone(input.Recipe.Masks), input.Recipe.OptionalMasks...)
	filled, err := s.evalBool(ctx, `(selector, expected, value, identity, masks, account) => {`+navigationChecks+`
		const e = document.querySelector(selector);
		if (!(e instanceof HTMLInputElement) || !safeSearch(e) || excluded(e) || mentionsAccount(e) || !visible(e) || text(e) !== expected) return false;
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
		if (setter) setter.call(e, value); else e.value = value;
		e.dispatchEvent(new Event('input', { bubbles: true }));
		e.dispatchEvent(new Event('change', { bubbles: true }));
		return true;
	}`, selector, label, clean, input.Target.IdentitySelector, allMasks, input.Target.ExpectedAccount)
	if err != nil {
		return &Failure{Code: PageFailed}
	}
	if !filled {
		return &Failure{Code: NavigationInvalid}
	}
	return nil
}

func (s *scope) navigateFeature(ctx context.Context, input RunInput) ([]NavigationAction, []SequenceShot, error) {
	if input.NextNavigation == nil {
		return nil, nil, &Failure{Code: NavigationUnavailable}
	}
	actions := []NavigationAction{}
	sequence := []SequenceShot{}
	maxIntermediate := max(0, input.Recipe.SequenceShots-1)
	// Capture an intermediate frame immediately before executing each action so
	// 0 actions -> 0 intermediate frames and k actions -> min(k, maxIntermediate)
	// distinct pre-action frames followed by the verified final capture.
	recordFrame := func() {
		if len(sequence) >= maxIntermediate {
			return
		}
		if frame, frameErr := s.captureMaskedSequenceFrame(ctx, input); frameErr == nil && frame != nil {
			sequence = append(sequence, *frame)
		}
	}
	seen := map[string]bool{}
	for step := 0; step <= input.Recipe.Navigation.MaxSteps; step++ {
		view, err := s.observeNavigation(ctx, input, true)
		if err != nil {
			return actions, sequence, err
		}
		modelCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		choice, err := input.NextNavigation(modelCtx, view)
		cancel()
		if err != nil {
			return actions, sequence, err
		}
		if choice.ControlID == nil {
			return actions, sequence, &Failure{Code: NavigationInvalid}
		}
		switch choice.Action {
		case "capture":
			if *choice.ControlID != -1 || !view.Ready {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			current, err := s.observeNavigation(ctx, input, false)
			if err != nil {
				return actions, sequence, err
			}
			if !current.Ready || current.Path != view.Path {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			framed, err := s.evalBool(ctx, `(selector) => {
				const e=Array.from(document.querySelectorAll(selector)).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
				if (!e) return false;
				e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
				const r=e.getBoundingClientRect();
				return r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth;
			}`, input.Recipe.Markers[0])
			if err != nil || !framed {
				return actions, sequence, &Failure{Code: MarkerMissing}
			}
			actions = append(actions, NavigationAction{Kind: "frame", Path: view.Path})
			return actions, sequence, nil
		case "stop":
			return actions, sequence, &Failure{Code: NavigationFailed}
		case "scroll":
			if *choice.ControlID != -1 || !view.CanScroll {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			if step == input.Recipe.Navigation.MaxSteps {
				return actions, sequence, &Failure{Code: NavigationLimit}
			}
			recordFrame()
			scrolled, err := s.evalBool(ctx, `() => {
				const before = window.scrollY || 0;
				window.scrollBy({top: Math.max(200, Math.round(window.innerHeight * 0.7)), behavior: 'instant'});
				return (window.scrollY || 0) > before;
			}`)
			if err != nil || !scrolled {
				return actions, sequence, &Failure{Code: NavigationFailed}
			}
			s.settle(ctx)
			actions = append(actions, NavigationAction{Kind: "scroll", Path: view.Path})
			continue
		case "fill":
			if !input.Recipe.Navigation.AllowSearchFill || len(input.Recipe.AllowedPostPaths) > 0 {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			if *choice.ControlID < 0 || *choice.ControlID >= len(view.Controls) {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			if step == input.Recipe.Navigation.MaxSteps {
				return actions, sequence, &Failure{Code: NavigationLimit}
			}
			control := view.Controls[*choice.ControlID]
			if control.Kind != "search" {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
			key := view.Path + ":fill:" + control.Label + ":" + strings.TrimSpace(choice.Value)
			if seen[key] {
				return actions, sequence, &Failure{Code: NavigationLimit}
			}
			seen[key] = true
			recordFrame()
			if err := s.fillSearch(ctx, input, control.selector, control.Label, choice.Value); err != nil {
				return actions, sequence, err
			}
			if err := s.waitNavigation(ctx, input, view); err != nil {
				return actions, sequence, err
			}
			s.settle(ctx)
			actions = append(actions, NavigationAction{Kind: "fill", Path: view.Path})
			continue
		case "select":
			if *choice.ControlID < 0 || *choice.ControlID >= len(view.Controls) {
				return actions, sequence, &Failure{Code: NavigationInvalid}
			}
		default:
			return actions, sequence, &Failure{Code: NavigationInvalid}
		}
		if step == input.Recipe.Navigation.MaxSteps {
			return actions, sequence, &Failure{Code: NavigationLimit}
		}
		control := view.Controls[*choice.ControlID]
		key := view.Path + ":" + control.Kind + ":" + control.Path + ":" + control.Label
		if seen[key] {
			return actions, sequence, &Failure{Code: NavigationLimit}
		}
		seen[key] = true
		recordFrame()
		switch control.Kind {
		case "link":
			err = s.navigate(ctx, input.Target, control.Path, defaultStepTimeout)
		case "tab":
			err = s.selectTab(ctx, Step{Selector: control.selector}, view.Path, control.Label)
		case "button":
			err = s.pressButton(ctx, input, control.selector, control.Label)
		default:
			return actions, sequence, &Failure{Code: NavigationInvalid}
		}
		if err != nil {
			return actions, sequence, err
		}
		if err := s.waitNavigation(ctx, input, view); err != nil {
			return actions, sequence, err
		}
		s.settle(ctx)
		path := control.Path
		if path == "" {
			path = view.Path
		}
		actions = append(actions, NavigationAction{Kind: control.Kind, Path: path})
	}
	return actions, sequence, &Failure{Code: NavigationLimit}
}
