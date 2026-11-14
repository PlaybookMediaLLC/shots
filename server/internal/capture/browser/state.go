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

// ExportConnected reads the state a person's sign-in left in the session's
// default context, from the tab they signed in with.
func ExportConnected(ctx context.Context, browser *rod.Browser, target Target) (*State, error) {
	if err := target.Validate(); err != nil {
		return nil, &Failure{Code: RecipeInvalid}
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	pages, err := browser.Context(ctx).Pages()
	if err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	if len(pages) == 0 {
		return nil, ErrNoPages
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
			found, err := live.evalBool(ctx, `(selector) => !!document.querySelector(selector)`, target.IdentitySelector)
			if err != nil {
				return nil, &Failure{Code: ProviderUnavailable}
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
			return nil, err
		}
		defer probe.close()
		if err := probe.navigate(ctx, target, target.ProtectedPath, defaultStepTimeout*2); err != nil {
			return nil, err
		}
		if err := probe.checkIdentity(ctx, target, target.ProtectedPath); err != nil {
			return nil, err
		}
		if probe.privateResponse.Load() {
			return nil, &Failure{Code: OriginRefused}
		}
		signedIn = probe.page
	}
	state, err := exportState(ctx, browser, signedIn, target)
	if err != nil {
		return nil, err
	}
	if len(state.Cookies) == 0 && len(state.LocalStorage) == 0 {
		return nil, &Failure{Code: SessionRestoreFailed}
	}
	return state, nil
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
