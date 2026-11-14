package browser

import (
	"context"
	"encoding/json"
	"net/url"
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

// NavigationObservation contains headings and navigation labels only. Input
// values, account elements, masked content and URL queries never reach a model.
type NavigationObservation struct {
	Path     string              `json:"path"`
	Headings []string            `json:"headings"`
	Controls []NavigationControl `json:"controls"`
	Ready    bool                `json:"ready"`
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
	NavigationInvalid     Code = "navigation_invalid"
	NavigationFailed      Code = "navigation_failed"
	NavigationLimit       Code = "navigation_limit"
	NavigationBudget      Code = "navigation_budget"
	NavigationRetryLimit  Code = "navigation_retry_limit"
)

// No arbitrary click: only navigation links and explicit tabs. Links navigate
// directly, so their click handlers cannot submit forms or open other windows.
const observeNavigation = `(identity, masks, markers) => {
 const visible = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
 const excluded = e => { const selectors=[identity,...(masks || []),'form','[contenteditable=true]'].join(','); return !!e.closest(selectors) || !!e.querySelector(selectors); };
 const text = e => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g,' ').replace(/[^\s@]+@[^\s@]+/g,'[private]').slice(0,120);
 const selector = e => { const parts=[]; while(e && e.tagName!=='HTML' && parts.length<12) {
   const siblings=Array.from(e.parentElement.children);
   parts.unshift(':nth-child('+(siblings.indexOf(e)+1)+')'); e=e.parentElement;
 } const path=parts.join('>'); return document.querySelectorAll(path).length===1?path:''; };
 const controls = Array.from(document.querySelectorAll('nav a[href],[role=navigation] a[href],[role=tab]'))
   .filter(e => visible(e) && !excluded(e) && !e.hasAttribute('download') && e.getAttribute('aria-disabled')!=='true' && !e.disabled && e.getAttribute('aria-selected')!=='true')
   .slice(0,60).map(e => ({kind:e.getAttribute('role')==='tab'?'tab':'link',label:text(e),href:e.href || '',selector:selector(e)}));
 return {headings:Array.from(document.querySelectorAll('h1,h2,[role=heading]')).filter(e=>visible(e)&&!excluded(e)).slice(0,12).map(text),controls,
   ready:markers.every(s=>Array.from(document.querySelectorAll(s)).some(visible))};
}`

func navigationPath(raw, origin string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme+"://"+u.Host != origin || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !ValidPath(u.EscapedPath()) {
		return "", false
	}
	for _, segment := range strings.FieldsFunc(strings.ToLower(u.Path), func(r rune) bool { return r == '/' || r == '-' || r == '_' || r == '.' }) {
		switch segment {
		case "api", "auth", "login", "logout", "signin", "signout", "delete", "remove", "destroy", "checkout", "unsubscribe":
			return "", false
		}
	}
	return u.EscapedPath(), true
}

func (s *scope) observeNavigation(ctx context.Context, input RunInput) (NavigationObservation, error) {
	view := NavigationObservation{Headings: []string{}, Controls: []NavigationControl{}}
	here, err := s.location()
	if err != nil || here.Scheme+"://"+here.Host != input.Target.Origin || s.privateResponse.Load() {
		return view, &Failure{Code: OriginRefused}
	}
	view.Path = here.EscapedPath()
	if err := s.checkIdentity(ctx, input.Target, view.Path); err != nil {
		return view, err
	}
	result, err := s.page.Context(ctx).Eval(observeNavigation, input.Target.IdentitySelector, input.Recipe.Masks, input.Recipe.Markers)
	if err != nil {
		return view, &Failure{Code: PageFailed}
	}
	var snapshot struct {
		Headings []string `json:"headings"`
		Ready    bool     `json:"ready"`
		Controls []struct {
			Kind, Label, Href, Selector string
		} `json:"controls"`
	}
	if err := json.Unmarshal([]byte(result.Value.JSON("", "")), &snapshot); err != nil {
		return view, &Failure{Code: PageFailed}
	}
	view.Headings, view.Ready = snapshot.Headings, snapshot.Ready
	for _, control := range snapshot.Controls {
		if control.Label == "" || (control.Kind == "tab" && !ValidSelector(control.Selector)) {
			continue
		}
		path := ""
		if control.Kind == "link" {
			var allowed bool
			path, allowed = navigationPath(control.Href, input.Target.Origin)
			if !allowed || path == view.Path {
				continue
			}
		}
		view.Controls = append(view.Controls, NavigationControl{ID: len(view.Controls), Kind: control.Kind, Label: control.Label, Path: path, selector: control.Selector})
	}
	return view, nil
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
				const e=document.querySelector(selector);
				if (!e || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
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
		key := view.Path + ":" + control.Kind + ":" + control.Path + ":" + control.selector
		if seen[key] {
			return actions, &Failure{Code: NavigationLimit}
		}
		seen[key] = true
		switch control.Kind {
		case "link":
			err = s.navigate(ctx, input.Target, control.Path, defaultStepTimeout)
		case "tab":
			err = s.selectTab(ctx, Step{Selector: control.selector}, view.Path, control.Label)
		default:
			return actions, &Failure{Code: NavigationInvalid}
		}
		if err != nil {
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
