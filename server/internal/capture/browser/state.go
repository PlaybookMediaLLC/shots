package browser

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// State is the authentication a connection keeps: cookies and local storage
// for approved hosts only. A broad identity-provider session is left behind.
// Session storage, IndexedDB, device-bound sessions, and passkeys are not
// portable this way; an app relying on them fails Verify and stays unconnected.
type State struct {
	Cookies      []*proto.NetworkCookieParam  `json:"cookies"`
	LocalStorage map[string]map[string]string `json:"localStorage,omitempty"`
}

// Marshal and UnmarshalState keep the format in one place. The bytes are
// secrets: they go to sessionstate.Seal and nowhere else.
func (s *State) Marshal() ([]byte, error) { return json.Marshal(s) }

// UnmarshalState reads state opened by sessionstate.
func UnmarshalState(body []byte) (*State, error) {
	state := &State{}
	if err := json.Unmarshal(body, state); err != nil {
		return nil, errors.New("capture session state is unreadable")
	}
	return state, nil
}

func (s *State) canonical() (string, error) {
	if s == nil {
		return "", nil
	}
	cookies := make([]string, 0, len(s.Cookies))
	for _, cookie := range s.Cookies {
		body, err := json.Marshal(cookie)
		if err != nil {
			return "", err
		}
		cookies = append(cookies, string(body))
	}
	sort.Strings(cookies)
	body, err := json.Marshal(struct {
		Cookies []string
		Storage map[string]map[string]string
	}{cookies, s.LocalStorage})
	return string(body), err
}

// Same compares everything restored into the browser, ignoring cookie order.
// Renewed expiry and scope must survive even when the token value is unchanged.
func (s *State) Same(other *State) bool {
	left, leftErr := s.canonical()
	right, rightErr := other.canonical()
	return leftErr == nil && rightErr == nil && left == right
}

// cookieApproved keeps a cookie only if a browser would send it to an approved
// host: the host itself, a matching pattern, or a parent domain of an approved
// host. An identity provider's cookies match none of these.
func cookieApproved(domain string, hosts []string) bool {
	domain = strings.ToLower(strings.TrimPrefix(domain, "."))
	if HostApproved(domain, hosts) {
		return true
	}
	for _, host := range hosts {
		if strings.HasSuffix(strings.TrimPrefix(host, "*"), "."+domain) {
			return true
		}
	}
	return false
}

// exportState reads a context's cookies and each approved origin's storage.
func exportState(ctx context.Context, context_ *rod.Browser, page *rod.Page, target Target) (*State, error) {
	cookies, err := context_.Context(ctx).GetCookies()
	if err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	state := &State{Cookies: []*proto.NetworkCookieParam{}, LocalStorage: map[string]map[string]string{}}
	for _, cookie := range cookies {
		if !cookieApproved(cookie.Domain, target.Hosts) {
			continue
		}
		state.Cookies = append(state.Cookies, &proto.NetworkCookieParam{Name: cookie.Name, Value: cookie.Value, Domain: cookie.Domain, Path: cookie.Path,
			Secure: cookie.Secure, HTTPOnly: cookie.HTTPOnly, SameSite: cookie.SameSite, Expires: cookie.Expires})
	}
	result, err := page.Context(ctx).Eval(`() => { const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k) } return JSON.stringify(out) }`)
	if err != nil {
		return state, nil
	}
	values := map[string]string{}
	if err := json.Unmarshal([]byte(result.Value.Str()), &values); err == nil && len(values) > 0 {
		info, err := page.Info()
		if err != nil {
			return state, nil
		}
		if here, err := url.Parse(info.URL); err == nil && here.Scheme == "https" && HostApproved(here.Hostname(), target.Hosts) {
			state.LocalStorage[here.Scheme+"://"+here.Host] = values
		}
	}
	return state, nil
}

// DiscoveredRoute is a safe, same-origin navigation link observed after sign-in.
type DiscoveredRoute struct {
	Path  string `json:"path"`
	Label string `json:"label"`
}

// MergePrevious retains localStorage entries from other approved origins that
// were present before this run, so rotating tokens on one origin never wipes
// stored auth state for sibling approved origins.
func (s *State) MergePrevious(prev *State, hosts []string) {
	if s == nil || prev == nil || len(prev.LocalStorage) == 0 {
		return
	}
	if s.LocalStorage == nil {
		s.LocalStorage = map[string]map[string]string{}
	}
	for origin, entries := range prev.LocalStorage {
		if _, exists := s.LocalStorage[origin]; exists || len(entries) == 0 {
			continue
		}
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "https" || !HostApproved(parsed.Hostname(), hosts) {
			continue
		}
		copied := make(map[string]string, len(entries))
		for k, v := range entries {
			copied[k] = v
		}
		s.LocalStorage[origin] = copied
	}
}

// FilterBootstrapState validates and filters a customer-bootstrapped session
// payload so only cookies and localStorage for approved hosts are retained.
func FilterBootstrapState(raw *State, target Target) (*State, error) {
	if raw == nil {
		return nil, &Failure{Code: SessionRestoreFailed}
	}
	out := &State{Cookies: []*proto.NetworkCookieParam{}, LocalStorage: map[string]map[string]string{}}
	for _, cookie := range raw.Cookies {
		if cookie == nil || strings.TrimSpace(cookie.Name) == "" || !cookieApproved(cookie.Domain, target.Hosts) {
			continue
		}
		c := *cookie
		out.Cookies = append(out.Cookies, &c)
	}
	for origin, entries := range raw.LocalStorage {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "https" || !HostApproved(parsed.Hostname(), target.Hosts) || len(entries) == 0 {
			continue
		}
		canonical := parsed.Scheme + "://" + parsed.Host
		copied := make(map[string]string, len(entries))
		for k, v := range entries {
			copied[k] = v
		}
		out.LocalStorage[canonical] = copied
	}
	if len(out.Cookies) == 0 && len(out.LocalStorage) == 0 {
		return nil, &Failure{Code: SessionRestoreFailed}
	}
	return out, nil
}

// discoverRoutes extracts up to 25 safe same-origin navigation links from the
// signed-in page without leaking emails or account identifiers.
func discoverRoutes(ctx context.Context, page *rod.Page, target Target) []DiscoveredRoute {
	result, err := page.Context(ctx).Eval(`(identity, account) => {
		const visible = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
		const excluded = e => identity ? (!!e.closest(identity) || !!e.querySelector(identity)) : false;
		const accountPattern = account ? new RegExp(account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
		const clean = raw => {
			let label = (raw || '').trim().replace(/\s+/g, ' ').replace(/[^\s@]+@[^\s@]+/g, '').trim();
			if (accountPattern) label = label.replace(accountPattern, '').trim();
			return label.slice(0, 80);
		};
		const links = Array.from(document.querySelectorAll('nav a[href],[role=navigation] a[href],aside a[href],header a[href]'));
		const out = [];
		for (const a of links) {
			if (out.length >= 40) break;
			if (!visible(a) || excluded(a) || a.hasAttribute('download')) continue;
			const label = clean(a.innerText || a.getAttribute('aria-label') || '');
			if (!label || !a.href) continue;
			out.push({href: a.href, label});
		}
		return JSON.stringify(out);
	}`, target.IdentitySelector, target.ExpectedAccount)
	if err != nil {
		return nil
	}
	var raw []struct {
		Href  string `json:"href"`
		Label string `json:"label"`
	}
	if err := json.Unmarshal([]byte(result.Value.Str()), &raw); err != nil {
		return nil
	}
	seen := map[string]bool{}
	routes := []DiscoveredRoute{}
	for _, item := range raw {
		path, ok := navigationPath(item.Href, target.Origin)
		if !ok || seen[path] {
			continue
		}
		seen[path] = true
		routes = append(routes, DiscoveredRoute{Path: path, Label: item.Label})
		if len(routes) >= 25 {
			break
		}
	}
	return routes
}

// ExportConnected reads the state a person's sign-in left in the session's
// default context, from the tab they signed in with.
func ExportConnected(ctx context.Context, browser *rod.Browser, target Target) (*State, error) {
	state, _, err := ExportConnectedWithRoutes(ctx, browser, target)
	return state, err
}

// ExportConnectedWithRoutes exports the verified sign-in state and also collects
// safe top-level navigation routes observed on the signed-in page for guided setup.
func ExportConnectedWithRoutes(ctx context.Context, browser *rod.Browser, target Target) (*State, []DiscoveredRoute, error) {
	if err := target.Validate(); err != nil {
		return nil, nil, &Failure{Code: RecipeInvalid}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pages, err := browser.Context(ctx).Pages()
	if err != nil {
		return nil, nil, &Failure{Code: ProviderUnavailable}
	}
	if len(pages) == 0 {
		return nil, nil, ErrNoPages
	}
	var signedIn *rod.Page
	for _, page := range pages {
		info, err := page.Info()
		if err != nil {
			continue
		}
		if here, err := url.Parse(info.URL); err == nil && here.Scheme == "https" && HostApproved(here.Hostname(), target.Hosts) {
			live := &scope{page: page}
			// Another tab may still show sign-in; inspect the account before exporting.
			found, err := live.accountShown(ctx, target)
			if err != nil {
				return nil, nil, &Failure{Code: ProviderUnavailable}
			}
			if !found {
				continue
			}
			if err := live.checkIdentity(ctx, target, target.ProtectedPath); err != nil {
				continue
			}
			signedIn = page
			break
		}
	}
	if signedIn == nil {
		// Login may land elsewhere; verify the configured path without moving the person's tab.
		probe, err := openPage(ctx, browser, target.Hosts, nil)
		if err != nil {
			return nil, nil, err
		}
		defer probe.close()
		if err := probe.navigate(ctx, target, target.ProtectedPath, defaultStepTimeout*2); err != nil {
			return nil, nil, err
		}
		if err := probe.checkIdentity(ctx, target, target.ProtectedPath); err != nil {
			return nil, nil, err
		}
		if probe.privateResponse.Load() {
			return nil, nil, &Failure{Code: OriginRefused}
		}
		signedIn = probe.page
	}
	state, err := exportState(ctx, browser, signedIn, target)
	if err != nil {
		return nil, nil, err
	}
	if len(state.Cookies) == 0 && len(state.LocalStorage) == 0 {
		return nil, nil, &Failure{Code: SessionRestoreFailed}
	}
	routes := discoverRoutes(ctx, signedIn, target)
	return state, routes, nil
}

// OpenLogin points the session's browser at the app, ready for the person.
func OpenLogin(ctx context.Context, browser *rod.Browser, target Target) error {
	pages, err := browser.Context(ctx).Pages()
	if err != nil {
		return &Failure{Code: ProviderUnavailable}
	}
	var page *rod.Page
	if len(pages) > 0 {
		page = pages.First()
	} else if page, err = browser.Context(ctx).Page(proto.TargetCreateTarget{URL: "about:blank"}); err != nil {
		return &Failure{Code: ProviderUnavailable}
	}
	if err := page.Context(ctx).Navigate(target.Origin + target.ProtectedPath); err != nil {
		return &Failure{Code: PageFailed}
	}
	return nil
}
