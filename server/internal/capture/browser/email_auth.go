package browser

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

// Email sign-in codes (RFC 007A section 9). Each is a stable, safe reason: none
// carries page text, a link, a code, or provider detail.
const (
	LoginPageChanged          Code = "login_page_changed"
	UnsupportedFactor         Code = "unsupported_factor"
	ChallengeHostRefused      Code = "challenge_host_refused"
	ChallengeExpired          Code = "challenge_expired"
	ChallengeConsumedUnknown  Code = "challenge_consumed_unknown"
	BrowserLost               Code = "browser_lost"
	SessionRestoreUnsupported Code = "session_restore_unsupported"
)

// LoginMethod is the first-factor email sign-in a login recipe automates.
type LoginMethod string

const (
	// MagicLink signs in by opening a one-time link from the email.
	MagicLink LoginMethod = "MAGIC_LINK"
	// EmailCode signs in by entering a one-time code from the email.
	EmailCode LoginMethod = "EMAIL_CODE"
)

// LoginRecipeSchemaVersion is the only login recipe format this code runs.
const LoginRecipeSchemaVersion = 1

const (
	maxSubmitPaths   = 5
	maxLinkRules     = 10
	loginStepTimeout = 15 * time.Second
	challengeSettle  = 2 * time.Second
	minCodeLength    = 4
	maxCodeLength    = 10
)

// LoginRecipe is an owner-approved, typed sign-in: fixed selectors and paths,
// never a script, and never chosen by a model. A login recipe may submit the
// forms it names; a capture recipe may not, so neither is ever the other.
type LoginRecipe struct {
	SchemaVersion int         `json:"schemaVersion"`
	Method        LoginMethod `json:"method"`
	// StartPath is the sign-in page on the connection's origin.
	StartPath string `json:"startPath"`
	// EmailInput and RequestChallenge each match exactly one visible element.
	EmailInput       string `json:"emailInput"`
	RequestChallenge string `json:"requestChallenge"`
	// ChallengeConfirmation, when set, must appear after the request, such as
	// a "Check your email" panel.
	ChallengeConfirmation string `json:"challengeConfirmation,omitempty"`
	// SubmitPaths are the only paths the sign-in may POST to.
	SubmitPaths []string `json:"submitPaths"`
	// LinkHosts and LinkPaths bound the one link a MAGIC_LINK email may hold.
	LinkHosts []string `json:"linkHosts,omitempty"`
	LinkPaths []string `json:"linkPaths,omitempty"`
	// CodeInput matches one field, or CodeLength segmented fields.
	CodeInput  string `json:"codeInput,omitempty"`
	CodeLength int    `json:"codeLength,omitempty"`
	// SubmitCode is the button that sends the code; without it Enter does.
	SubmitCode string `json:"submitCode,omitempty"`
}

// Validate reports why a login recipe cannot run, in words for its owner.
func (r LoginRecipe) Validate() error {
	if r.SchemaVersion != LoginRecipeSchemaVersion {
		return errors.New("Use login recipe schema version 1.")
	}
	if !ValidPath(r.StartPath) || signsOut(r.StartPath) {
		return errors.New("Set the sign-in page path, such as /login.")
	}
	for _, selector := range []string{r.EmailInput, r.RequestChallenge} {
		if !ValidSelector(selector) {
			return errors.New("Name the email field and the send button with CSS selectors, such as [data-testid=login-email].")
		}
	}
	if r.ChallengeConfirmation != "" && !ValidSelector(r.ChallengeConfirmation) {
		return errors.New("The confirmation must be a CSS selector.")
	}
	if len(r.SubmitPaths) == 0 || len(r.SubmitPaths) > maxSubmitPaths {
		return errors.New("Approve 1–5 paths the sign-in form may submit to.")
	}
	for _, path := range r.SubmitPaths {
		if !ValidPath(path) || strings.ContainsAny(path, "?#") || signsOut(path) {
			return errors.New("Submit paths must be plain paths, such as /api/auth/email.")
		}
	}
	switch r.Method {
	case MagicLink:
		if len(r.LinkHosts) == 0 || len(r.LinkHosts) > maxLinkRules || len(r.LinkPaths) == 0 || len(r.LinkPaths) > maxLinkRules {
			return errors.New("Approve 1–10 exact hosts and paths the sign-in link may use.")
		}
		for _, host := range r.LinkHosts {
			// A link host is exact: a wildcard would admit any tracking subdomain.
			if !ValidHost(host) || strings.HasPrefix(host, "*") {
				return errors.New("Link hosts must be exact host names, such as auth.example.com.")
			}
		}
		for _, path := range r.LinkPaths {
			if !ValidPath(path) || strings.ContainsAny(path, "?#") {
				return errors.New("Link paths must be plain paths, such as /auth/callback.")
			}
		}
		if r.CodeInput != "" || r.CodeLength != 0 || r.SubmitCode != "" {
			return errors.New("A magic-link recipe has no code fields.")
		}
	case EmailCode:
		if !ValidSelector(r.CodeInput) {
			return errors.New("Name the code field with a CSS selector.")
		}
		if r.CodeLength < minCodeLength || r.CodeLength > maxCodeLength {
			return errors.New("Codes are 4–10 digits long.")
		}
		if r.SubmitCode != "" && !ValidSelector(r.SubmitCode) {
			return errors.New("The code button must be a CSS selector.")
		}
		if len(r.LinkHosts) > 0 || len(r.LinkPaths) > 0 {
			return errors.New("An email-code recipe has no link rules.")
		}
	default:
		return errors.New("Choose MAGIC_LINK or EMAIL_CODE.")
	}
	return nil
}

// Hash pins the exact approved bytes an attempt runs.
func (r LoginRecipe) Hash() (string, error) {
	body, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:]), nil
}

// LinkAllowed reports whether a sign-in link is one this recipe approved:
// https, no credentials or port, an exact host, and an exact path.
func (r LoginRecipe) LinkAllowed(link *url.URL) bool {
	if link == nil || link.Scheme != "https" || link.User != nil || !linkPortAllowed(link.Port()) || link.Opaque != "" {
		return false
	}
	return slices.Contains(r.LinkHosts, strings.ToLower(link.Hostname())) && slices.Contains(r.LinkPaths, link.EscapedPath())
}

// linkPortAllowed admits the default https port only. A variable so a test
// can serve its synthetic app on a random port.
var linkPortAllowed = func(port string) bool { return port == "" || port == "443" }

// SecretURL holds a one-time sign-in link. It prints and marshals as redacted,
// so a log line, error, or JSON result cannot carry it by mistake.
type SecretURL struct{ value string }

// NewSecretURL wraps a link parsed from an email.
func NewSecretURL(raw string) SecretURL { return SecretURL{value: raw} }

func (SecretURL) String() string   { return "<redacted>" }
func (SecretURL) GoString() string { return "<redacted>" }
func (SecretURL) MarshalJSON() ([]byte, error) {
	return nil, errors.New("a sign-in link is never serialized")
}
func (s SecretURL) Empty() bool { return s.value == "" }

// SecretCode holds a one-time sign-in code, redacted like SecretURL.
type SecretCode struct{ value string }

// NewSecretCode wraps a code parsed from an email.
func NewSecretCode(raw string) SecretCode { return SecretCode{value: raw} }

func (SecretCode) String() string   { return "<redacted>" }
func (SecretCode) GoString() string { return "<redacted>" }
func (SecretCode) MarshalJSON() ([]byte, error) {
	return nil, errors.New("a sign-in code is never serialized")
}
func (s SecretCode) Empty() bool { return s.value == "" }

// blockerScript sees a challenge only a person may answer: a password, a
// CAPTCHA, a passkey prompt, or an SMS or authenticator code field.
const blockerScript = `() => {
	const visible = e => !!e && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
	if ([...document.querySelectorAll('input[type=password]')].some(visible)) return 'password';
	if (document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile')) return 'captcha';
	return '';
}`

// LoginHosts is every host a sign-in browser may reach: the app, its approved
// sign-in hosts, and the hosts a magic link may open.
func LoginHosts(target Target, loginHosts []string, recipe LoginRecipe) []string {
	hosts := slices.Clone(target.Hosts)
	for _, host := range append(slices.Clone(loginHosts), recipe.LinkHosts...) {
		if !slices.Contains(hosts, host) {
			hosts = append(hosts, host)
		}
	}
	return hosts
}

// exactlyOne finds the one visible, enabled element a selector names. None or
// several means the page changed since the owner approved the recipe.
func exactlyOne(ctx context.Context, page *rod.Page, selector string) (*rod.Element, error) {
	waitCtx, cancel := context.WithTimeout(ctx, loginStepTimeout)
	defer cancel()
	for {
		elements, err := page.Context(waitCtx).Elements(selector)
		if err == nil {
			var shown []*rod.Element
			for _, element := range elements {
				if visible, err := element.Visible(); err == nil && visible {
					shown = append(shown, element)
				}
			}
			if len(shown) == 1 {
				if disabled, err := shown[0].Disabled(); err == nil && !disabled {
					// The element carries waitCtx, which ends on return.
					return shown[0].Context(ctx), nil
				}
			}
			if len(shown) > 1 {
				return nil, &Failure{Code: LoginPageChanged}
			}
		}
		select {
		case <-waitCtx.Done():
			return nil, &Failure{Code: LoginPageChanged}
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (s *scope) blocked(ctx context.Context) bool {
	result, err := s.page.Context(ctx).Eval(blockerScript)
	return err == nil && result.Value.Str() != ""
}

// onApprovedHost reports whether the tab is on an approved https host.
func (s *scope) onApprovedHost(hosts []string) bool {
	here, err := s.location()
	return err == nil && here.Scheme == "https" && HostApproved(here.Hostname(), hosts)
}

// RequestEmailChallenge opens the sign-in page in the session's own context,
// fills in the test address, and asks for one email. beforeSubmit runs just
// before the click, so the attempt is durably waiting before any email can
// exist. The tab stays open: a code is typed into it, and a link may need its
// cookies. The click is never repeated: a second email is worse than none.
func RequestEmailChallenge(ctx context.Context, browser *rod.Browser, target Target, hosts []string, recipe LoginRecipe, recipient string, beforeSubmit func() error) error {
	if err := recipe.Validate(); err != nil {
		return &Failure{Code: RecipeInvalid}
	}
	ctx, cancel := context.WithTimeout(ctx, RunDeadline)
	defer cancel()
	page, err := browser.Context(ctx).Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return &Failure{Code: ProviderUnavailable}
	}
	s, stop, err := guard(ctx, browser, page, hosts, recipe.SubmitPaths)
	if err != nil {
		_ = page.Close()
		return err
	}
	defer stop()
	loadCtx, cancelLoad := context.WithTimeout(ctx, loginStepTimeout*2)
	defer cancelLoad()
	if err := page.Context(loadCtx).Navigate(target.Origin + recipe.StartPath); err != nil {
		return &Failure{Code: PageFailed}
	}
	if err := page.Context(loadCtx).WaitLoad(); err != nil || !s.onApprovedHost(hosts) {
		if s.refusedDocument.Load() {
			return &Failure{Code: OriginRefused}
		}
		return &Failure{Code: PageFailed}
	}
	if s.blocked(ctx) {
		return &Failure{Code: UnsupportedFactor}
	}
	field, err := exactlyOne(ctx, page, recipe.EmailInput)
	if err != nil {
		return err
	}
	if kind, err := field.Attribute("type"); err != nil || (kind != nil && *kind == "hidden") {
		return &Failure{Code: LoginPageChanged}
	}
	if err := field.Context(ctx).SelectAllText(); err != nil {
		return &Failure{Code: PageFailed}
	}
	if err := field.Context(ctx).Input(recipient); err != nil {
		return &Failure{Code: PageFailed}
	}
	button, err := exactlyOne(ctx, page, recipe.RequestChallenge)
	if err != nil {
		return err
	}
	if err := beforeSubmit(); err != nil {
		return err
	}
	if err := button.Context(ctx).Click(proto.InputMouseButtonLeft, 1); err != nil {
		// The click may have sent the email; the caller must not click again.
		return &Failure{Code: ChallengeConsumedUnknown}
	}
	return awaitChallengeScreen(ctx, s, recipe)
}

// awaitChallengeScreen confirms the app asked for an email, not a password.
func awaitChallengeScreen(ctx context.Context, s *scope, recipe LoginRecipe) error {
	selector := recipe.ChallengeConfirmation
	if selector == "" && recipe.Method == EmailCode {
		selector = recipe.CodeInput
	}
	if selector == "" {
		// No marker approved: give the request a moment, then refuse a
		// password or CAPTCHA the click revealed.
		select {
		case <-ctx.Done():
			return &Failure{Code: BrowserLost}
		case <-time.After(challengeSettle):
		}
		if s.blocked(ctx) {
			return &Failure{Code: UnsupportedFactor}
		}
		return nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, loginStepTimeout)
	defer cancel()
	for {
		if found, err := s.evalBool(waitCtx, `(selector) => !!document.querySelector(selector)`, selector); err == nil && found {
			return nil
		}
		if s.blocked(waitCtx) {
			return &Failure{Code: UnsupportedFactor}
		}
		select {
		case <-waitCtx.Done():
			return &Failure{Code: LoginPageChanged}
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// ApplyMagicLink opens the one approved link once, in a new tab of the same
// context that asked for it, so any challenge cookie it set still applies. No
// HEAD request or server-side fetch comes first: either could spend the link.
func ApplyMagicLink(ctx context.Context, browser *rod.Browser, target Target, hosts []string, recipe LoginRecipe, link SecretURL) error {
	parsed, err := url.Parse(link.value)
	if err != nil || !recipe.LinkAllowed(parsed) {
		return &Failure{Code: ChallengeHostRefused}
	}
	ctx, cancel := context.WithTimeout(ctx, RunDeadline)
	defer cancel()
	page, err := browser.Context(ctx).Page(proto.TargetCreateTarget{URL: "about:blank"})
	if err != nil {
		return &Failure{Code: BrowserLost}
	}
	s, stop, err := guard(ctx, browser, page, hosts, recipe.SubmitPaths)
	if err != nil {
		_ = page.Close()
		return err
	}
	defer stop()
	loadCtx, cancelLoad := context.WithTimeout(ctx, loginStepTimeout*2)
	defer cancelLoad()
	// Errors below never wrap the navigation error: its text holds the link.
	if err := page.Context(loadCtx).Navigate(link.value); err != nil {
		return &Failure{Code: ChallengeConsumedUnknown}
	}
	_ = page.Context(loadCtx).WaitLoad()
	if s.refusedDocument.Load() || !s.onApprovedHost(hosts) {
		return &Failure{Code: ChallengeHostRefused}
	}
	if s.blocked(ctx) {
		return &Failure{Code: UnsupportedFactor}
	}
	return proveSignedIn(ctx, s, target)
}

// ApplyEmailCode types the code once into the tab that asked for it and
// submits it once.
func ApplyEmailCode(ctx context.Context, browser *rod.Browser, target Target, hosts []string, recipe LoginRecipe, code SecretCode) error {
	if recipe.Method != EmailCode || len(code.value) != recipe.CodeLength {
		return &Failure{Code: RecipeInvalid}
	}
	ctx, cancel := context.WithTimeout(ctx, RunDeadline)
	defer cancel()
	pages, err := browser.Context(ctx).Pages()
	if err != nil {
		return &Failure{Code: BrowserLost}
	}
	var page *rod.Page
	for _, candidate := range pages {
		// A page object may still carry the context of the call that opened it.
		candidate = candidate.Context(ctx)
		info, err := candidate.Info()
		if err != nil {
			continue
		}
		here, err := url.Parse(info.URL)
		if err != nil || here.Scheme != "https" || !HostApproved(here.Hostname(), hosts) {
			continue
		}
		if found, err := candidate.Context(ctx).Elements(recipe.CodeInput); err == nil && len(found) > 0 {
			page = candidate
			break
		}
	}
	if page == nil {
		// The tab moved on or closed: a late code has nowhere safe to go.
		return &Failure{Code: BrowserLost}
	}
	s, stop, err := guard(ctx, browser, page, hosts, recipe.SubmitPaths)
	if err != nil {
		return err
	}
	defer stop()
	if s.blocked(ctx) {
		return &Failure{Code: UnsupportedFactor}
	}
	fields, err := page.Context(ctx).Elements(recipe.CodeInput)
	if err != nil {
		return &Failure{Code: LoginPageChanged}
	}
	switch len(fields) {
	case 1:
		if err := fields[0].Context(ctx).Input(code.value); err != nil {
			return &Failure{Code: ChallengeConsumedUnknown}
		}
	case recipe.CodeLength:
		for i, field := range fields {
			if err := field.Context(ctx).Input(code.value[i : i+1]); err != nil {
				return &Failure{Code: ChallengeConsumedUnknown}
			}
		}
	default:
		return &Failure{Code: LoginPageChanged}
	}
	if recipe.SubmitCode != "" {
		button, err := exactlyOne(ctx, page, recipe.SubmitCode)
		if err != nil {
			return err
		}
		if err := button.Context(ctx).Click(proto.InputMouseButtonLeft, 1); err != nil {
			return &Failure{Code: ChallengeConsumedUnknown}
		}
	} else if err := page.Context(ctx).Keyboard.Type(input.Enter); err != nil {
		return &Failure{Code: ChallengeConsumedUnknown}
	}
	// Wait for the code step to end; a code field still there means the app
	// refused or expired the code.
	waitCtx, cancelWait := context.WithTimeout(ctx, loginStepTimeout)
	defer cancelWait()
	for {
		present, err := s.evalBool(waitCtx, `(selector) => [...document.querySelectorAll(selector)].some(e => e.checkVisibility())`, recipe.CodeInput)
		if err == nil && !present {
			break
		}
		select {
		case <-waitCtx.Done():
			return &Failure{Code: ChallengeExpired}
		case <-time.After(200 * time.Millisecond):
		}
	}
	if s.blocked(ctx) {
		return &Failure{Code: UnsupportedFactor}
	}
	return proveSignedIn(ctx, s, target)
}

// proveSignedIn checks the configured protected page shows the expected
// account in the browser that signed in. A fresh browser proves it again.
func proveSignedIn(ctx context.Context, s *scope, target Target) error {
	if err := s.navigate(ctx, target, target.ProtectedPath, loginStepTimeout*2); err != nil {
		var failure *Failure
		if errors.As(err, &failure) && failure.Code == NeedsAuth {
			return &Failure{Code: SignInIncomplete}
		}
		return err
	}
	if err := s.checkIdentity(ctx, target, target.ProtectedPath); err != nil {
		var failure *Failure
		if errors.As(err, &failure) && failure.Code == NeedsAuth {
			return &Failure{Code: SignInIncomplete}
		}
		return err
	}
	return nil
}

// RequestEmailChallenge asks the app for one sign-in email in the session.
func (r Runner) RequestEmailChallenge(ctx context.Context, sessionID string, target Target, hosts []string, recipe LoginRecipe, recipient string, beforeSubmit func() error) error {
	err := r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error {
		return RequestEmailChallenge(ctx, browser, target, hosts, recipe, recipient, beforeSubmit)
	})
	return lostIfDisconnected(err)
}

// ApplyMagicLink opens the sign-in link in the session that asked for it.
func (r Runner) ApplyMagicLink(ctx context.Context, sessionID string, target Target, hosts []string, recipe LoginRecipe, link SecretURL) error {
	err := r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error {
		return ApplyMagicLink(ctx, browser, target, hosts, recipe, link)
	})
	return lostIfDisconnected(err)
}

// ApplyEmailCode enters the sign-in code in the session that asked for it.
func (r Runner) ApplyEmailCode(ctx context.Context, sessionID string, target Target, hosts []string, recipe LoginRecipe, code SecretCode) error {
	err := r.attached(ctx, sessionID, func(ctx context.Context, browser *rod.Browser) error {
		return ApplyEmailCode(ctx, browser, target, hosts, recipe, code)
	})
	return lostIfDisconnected(err)
}

// lostIfDisconnected turns a failed attach into a safe code: the provider
// error may name the session, and a session that is gone cannot be resumed.
func lostIfDisconnected(err error) error {
	if err == nil {
		return nil
	}
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}
	return &Failure{Code: BrowserLost}
}
