package browser

import (
	"context"
	"encoding/json"
	"net/url"
	"slices"
	"strings"
	"time"
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
	Path        string              `json:"path"`
	Headings    []string            `json:"headings"`
	Current     []string            `json:"current"`
	Controls    []NavigationControl `json:"controls"`
	Ready       bool                `json:"ready"`
	CanScroll   bool                `json:"canScroll,omitempty"`
	loading     bool
	contentHash string
	scrollY     int
}

// NavigationChoice must select an ID from the latest observation, capture a
// proven destination, or stop. The browser revalidates every choice.
type NavigationChoice struct {
	Action    string `json:"action"`
	ControlID *int   `json:"controlId"`
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
 const visible = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const excluded = e => { const selectors=[identity,...(masks || []),'form','[contenteditable=true]'].filter(Boolean).join(','); return !!e.closest(selectors) || !!e.querySelector(selectors); };
 const raw = e => e.innerText || e.getAttribute('aria-label') || '';
 const accountPattern = account ? new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
 const mentionsAccount = e => !!account && raw(e).toLowerCase().includes(account.toLowerCase());
 const text = e => { let label = raw(e).trim().replace(/\s+/g,' ').replace(/[^\s@]+@[^\s@]+/g,'[private]'); if (accountPattern) label = label.replace(accountPattern,'[account]'); return label.slice(0,120); };
 const pressable = e => e.matches(pressableSelector) &&
   !e.matches('a[href],input,[form],button[type=submit],button[type=reset],[role=switch],[role=checkbox],[role=radio],[role=option],[aria-checked],[aria-pressed],[aria-expanded=true],details[open]>summary') &&
   !e.closest('form,table,[role=grid],[role=treegrid],[role=row]') &&
   !/\b(delete|remove|destroy|erase|trash|discard|sign[ -]?(out|off)|log[ -]?(out|off)|exit|end session|close account|unsubscribe|cancel|buy|purchase|pay|checkout|publish|send|submit|save|invite|confirm|revoke|leave|transfer|deactivate|disable|enable|reset|archive|approve|reject|merge|deploy|uninstall|disconnect|start|run|generate|retry|duplicate|switch|impersonate)\b/i.test(raw(e));
`

// observeNavigation offers navigation links, explicit tabs and, when allowed,
// pressable controls, stopping at 60. Links navigate directly, so their click
// handlers cannot submit forms or open other windows. All DOM reads happen
// before tagging elements with transient data-shots-nav attributes to avoid
// interleaved layout thrashing during waitNavigation polling.
const observeNavigation = `(identity, masks, markers, account, buttons) => {` + navigationChecks + `
 const usable = e => visible(e) && !excluded(e) && !mentionsAccount(e) && !e.hasAttribute('download') && e.getAttribute('aria-disabled')!=='true' && !e.disabled && e.getAttribute('aria-selected')!=='true';
 const links = new Set(document.querySelectorAll('nav a[href],[role=navigation] a[href],aside a[href],[role=tab]'));
 const chosen = [];
 for (const e of links) { if (chosen.length >= 60) break; if (usable(e)) chosen.push(e); }
 if (buttons) for (const e of document.querySelectorAll(pressableSelector)) { if (chosen.length >= 60) break; if (!links.has(e) && pressable(e) && usable(e)) chosen.push(e); }
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
 const controls = chosen.map(e => ({kind:e.getAttribute('role')==='tab'?'tab':links.has(e)?'link':'button',label:text(e),href:e.href || '',selector:''}));
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

func (s *scope) observeNavigation(ctx context.Context, input RunInput) (NavigationObservation, error) {
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
	// A recipe that allows POST paths may expose a write behind any control, so it navigates by links and tabs only.
	result, err := s.page.Context(ctx).Eval(observeNavigation, input.Target.IdentitySelector, allMasks, input.Recipe.Markers, input.Target.ExpectedAccount,
		len(input.Recipe.AllowedPostPaths) == 0)
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
	return view, nil
}

// Wait for feature evidence, content update, or new navigation, not just a selected tab attribute.
func (s *scope) waitNavigation(ctx context.Context, input RunInput, before NavigationObservation) error {
	waitCtx, cancel := context.WithTimeout(ctx, defaultStepTimeout)
	defer cancel()
	for {
		view, err := s.observeNavigation(waitCtx, input)
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
	pressed, err := s.evalBool(ctx, `(selector, expected, identity, masks, account) => {`+navigationChecks+`
		const e = document.querySelector(selector);
		if (!e || !pressable(e) || excluded(e) || mentionsAccount(e) || !visible(e) || e.disabled || e.getAttribute('aria-disabled')==='true' || text(e) !== expected) return false;
		e.click(); return true;
	}`, selector, label, input.Target.IdentitySelector, allMasks, input.Target.ExpectedAccount)
	if err != nil {
		return &Failure{Code: PageFailed}
	}
	if !pressed {
		return &Failure{Code: NavigationInvalid}
	}
	return nil
}

func (s *scope) navigateFeature(ctx context.Context, input RunInput) ([]NavigationAction, error) {
	if input.NextNavigation == nil {
		return nil, &Failure{Code: NavigationUnavailable}
	}
	actions := []NavigationAction{}
	seen := map[string]bool{}
	for step := 0; step <= input.Recipe.Navigation.MaxSteps; step++ {
		view, err := s.observeNavigation(ctx, input)
		if err != nil {
			return actions, err
		}
		modelCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		choice, err := input.NextNavigation(modelCtx, view)
		cancel()
		if err != nil {
			return actions, err
		}
		if choice.ControlID == nil {
			return actions, &Failure{Code: NavigationInvalid}
		}
		switch choice.Action {
		case "capture":
			if *choice.ControlID != -1 || !view.Ready {
				return actions, &Failure{Code: NavigationInvalid}
			}
			current, err := s.observeNavigation(ctx, input)
			if err != nil {
				return actions, err
			}
			if !current.Ready || current.Path != view.Path {
				return actions, &Failure{Code: NavigationInvalid}
			}
			framed, err := s.evalBool(ctx, `(selector) => {
				const e=Array.from(document.querySelectorAll(selector)).find(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
				if (!e) return false;
				e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
				const r=e.getBoundingClientRect();
				return r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth;
			}`, input.Recipe.Markers[0])
			if err != nil || !framed {
				return actions, &Failure{Code: MarkerMissing}
			}
			actions = append(actions, NavigationAction{Kind: "frame", Path: view.Path})
			return actions, nil
		case "stop":
			return actions, &Failure{Code: NavigationFailed}
		case "scroll":
			if *choice.ControlID != -1 || !view.CanScroll {
				return actions, &Failure{Code: NavigationInvalid}
			}
			if step == input.Recipe.Navigation.MaxSteps {
				return actions, &Failure{Code: NavigationLimit}
			}
			scrolled, err := s.evalBool(ctx, `() => {
				const before = window.scrollY || 0;
				window.scrollBy({top: Math.max(200, Math.round(window.innerHeight * 0.7)), behavior: 'instant'});
				return (window.scrollY || 0) > before;
			}`)
			if err != nil || !scrolled {
				return actions, &Failure{Code: NavigationFailed}
			}
			s.settle(ctx)
			actions = append(actions, NavigationAction{Kind: "scroll", Path: view.Path})
			continue
		case "select":
			if *choice.ControlID < 0 || *choice.ControlID >= len(view.Controls) {
				return actions, &Failure{Code: NavigationInvalid}
			}
		default:
			return actions, &Failure{Code: NavigationInvalid}
		}
		if step == input.Recipe.Navigation.MaxSteps {
			return actions, &Failure{Code: NavigationLimit}
		}
		control := view.Controls[*choice.ControlID]
		key := view.Path + ":" + control.Kind + ":" + control.Path + ":" + control.Label
		if seen[key] {
			return actions, &Failure{Code: NavigationLimit}
		}
		seen[key] = true
		switch control.Kind {
		case "link":
			err = s.navigate(ctx, input.Target, control.Path, defaultStepTimeout)
		case "tab":
			err = s.selectTab(ctx, Step{Selector: control.selector}, view.Path, control.Label)
		case "button":
			err = s.pressButton(ctx, input, control.selector, control.Label)
		default:
			return actions, &Failure{Code: NavigationInvalid}
		}
		if err != nil {
			return actions, err
		}
		if err := s.waitNavigation(ctx, input, view); err != nil {
			return actions, err
		}
		s.settle(ctx)
		path := control.Path
		if path == "" {
			path = view.Path
		}
		actions = append(actions, NavigationAction{Kind: control.Kind, Path: path})
	}
	return actions, &Failure{Code: NavigationLimit}
}
