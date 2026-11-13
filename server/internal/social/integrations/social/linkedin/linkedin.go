// Package linkedin is the LinkedIn provider (LinkedinProvider) and its
// settings DTO. linkedinpage embeds Provider and overrides what
// LinkedinPageProvider overrides.
package linkedin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

// APIURL and WWWURL are the LinkedIn hosts called over HTTP; tests point them
// at an httptest.Server. User-facing URLs (auth, release) stay literal.
var (
	APIURL = "https://api.linkedin.com"
	WWWURL = "https://www.linkedin.com"
)

const Rules = "LinkedIn can have maximum one attachment when selecting video, when choosing a carousel on LinkedIn minimum amount of attachment must be two, and only pictures, if uploading a video, LinkedIn can have only one attachment"

// Scopes are available through LinkedIn's self-service Sign In and Share
// products. Organization permissions require the separate Community Management
// product and must not be requested when connecting a personal profile.
var Scopes = []string{
	"openid",
	"profile",
	"w_member_social",
}

// PageScopes are Community Management (or Advertising API) permissions. LinkedIn
// grants Community Management only to an app with no other product, so a Page
// connection cannot use OpenID: it reads the member through r_basicprofile.
var PageScopes = []string{
	"r_basicprofile",
	"rw_organization_admin",
	"w_organization_social",
	"r_organization_social",
}

// Post types: who authors the post (urn:li:person vs urn:li:organization).
const (
	Personal = "personal"
	Company  = "company"
)

// LinkedinDTO is LinkedinDto. Fields are untyped so Validate can reproduce
// class-validator and assetBoolean can accept "true".
type LinkedinDTO struct {
	PostAsImagesCarousel any `json:"post_as_images_carousel,omitempty"`
	CarouselName         any `json:"carousel_name,omitempty"`
	// Visibility is PUBLIC (the default) or CONNECTIONS.
	Visibility any `json:"visibility,omitempty"`
	// DocumentTitle names an uploaded PDF document post.
	DocumentTitle any `json:"document_title,omitempty"`
	// ReshareParent reshares a post with this post's text as commentary.
	ReshareParent any `json:"reshare_parent,omitempty"`
}

func (d *LinkedinDTO) Validate() []string {
	var out []string
	if _, ok := d.PostAsImagesCarousel.(bool); d.PostAsImagesCarousel != nil && !ok {
		out = append(out, "post_as_images_carousel must be a boolean value")
	}
	if _, ok := d.CarouselName.(string); d.CarouselName != nil && !ok {
		out = append(out, "carousel_name must be a string")
	}
	if value, ok := d.Visibility.(string); d.Visibility != nil && (!ok || value != "PUBLIC" && value != "CONNECTIONS") {
		out = append(out, "visibility must be PUBLIC or CONNECTIONS")
	}
	if _, ok := d.DocumentTitle.(string); d.DocumentTitle != nil && !ok {
		out = append(out, "document_title must be a string")
	}
	if _, ok := d.ReshareParent.(string); d.ReshareParent != nil && !ok {
		out = append(out, "reshare_parent must be a string")
	}
	return out
}

func decodeSettings(raw json.RawMessage) LinkedinDTO {
	var dto LinkedinDTO
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &dto)
	}
	return dto
}

type Provider struct {
	*integrations.Base
	identifier string
}

func New() *Provider { return WithIdentifier("linkedin") }

// WithIdentifier builds the LinkedIn implementation for a provider extending
// it (linkedin-page), so its failures carry that identifier.
func WithIdentifier(identifier string) *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors), identifier: identifier}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       "linkedin",
		Name:             "LinkedIn",
		Editor:           "normal",
		Scopes:           Scopes,
		OneTimeToken:     true,
		RefreshWait:      true,
		MaxConcurrentJob: 8, // LinkedIn limits are daily budgets
		Rules:            Rules,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 3000 }

func (p *Provider) SettingsDTO() any { return &LinkedinDTO{} }

func (p *Provider) CheckValidity(_ context.Context, posts [][]integrations.ValidityMedia, settings json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	var first []integrations.ValidityMedia
	if len(posts) > 0 {
		first = posts[0]
	}
	hasVideo := slices.ContainsFunc(first, func(m integrations.ValidityMedia) bool { return strings.Contains(m.Path, "mp4") })
	if integrations.AssetBoolean(decodeSettings(settings).PostAsImagesCarousel) && (len(first) < 2 || hasVideo) {
		return "Carousel can only be created with 2 or more images and no videos.", nil
	}
	if len(first) > 1 && hasVideo {
		return "Can have maximum 1 media when selecting a video.", nil
	}
	for i := 1; i < len(posts); i++ {
		if len(posts[i]) > 0 {
			return "Comments can only contain text.", nil
		}
	}
	return "", nil
}

func handleErrors(body string, _ int) *integrations.HandledError {
	if strings.Contains(body, "Unable to obtain activity") {
		return &integrations.HandledError{Type: "retry", Value: "Unable to obtain activity"}
	}
	if strings.Contains(body, "resource is forbidden") || strings.Contains(body, "Service Unavailable") {
		return &integrations.HandledError{Type: "retry", Value: "Resource is forbidden"}
	}
	return nil
}

// Headers are the versioned REST headers most LinkedIn calls send.
func Headers(accessToken, contentType string) map[string]string {
	h := map[string]string{
		"X-Restli-Protocol-Version": "2.0.0",
		"LinkedIn-Version":          "202601",
		"Authorization":             "Bearer " + accessToken,
	}
	if contentType != "" {
		h["Content-Type"] = contentType
	}
	return h
}

// FetchJSON is `await (await fetch(url, init)).json()` for the calls the original app
// makes with the global fetch: no retries and no status classification.
func FetchJSON(ctx context.Context, method, url string, headers map[string]string, body []byte, out any) error {
	return fetchJSON(ctx, method, url, headers, body, out, false)
}

// FetchJSONChecked propagates HTTP failures for analytics callers.
func FetchJSONChecked(ctx context.Context, method, url string, headers map[string]string, body []byte, out any) error {
	return fetchJSON(ctx, method, url, headers, body, out, true)
}

func fetchJSON(ctx context.Context, method, url string, headers map[string]string, body []byte, out any, checked bool) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if checked {
		if err := integrations.CheckResponse(res); err != nil {
			return err
		}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// EncodeURIComponent is JavaScript's encodeURIComponent.
func EncodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

// LogoV2 is logoV2 projected with original~:playableStreams.
type LogoV2 struct {
	Original struct {
		Elements []struct {
			Identifiers []struct {
				Identifier string `json:"identifier"`
			} `json:"identifiers"`
		} `json:"elements"`
	} `json:"original~"`
}

// URL is logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier.
func (l *LogoV2) URL() string {
	if l == nil || len(l.Original.Elements) == 0 || len(l.Original.Elements[0].Identifiers) == 0 {
		return ""
	}
	return l.Original.Elements[0].Identifiers[0].Identifier
}

// Credentials returns the LinkedIn app of this adapter. The Page adapter uses
// its own Community Management app when one is set, else the shared app.
func (p *Provider) Credentials() (clientID, clientSecret string) {
	if p.identifier == "linkedin-page" && os.Getenv("PLATFORM_LINKEDIN_PAGE_CLIENT_ID") != "" {
		return os.Getenv("PLATFORM_LINKEDIN_PAGE_CLIENT_ID"), os.Getenv("PLATFORM_LINKEDIN_PAGE_CLIENT_SECRET")
	}
	return os.Getenv("LINKEDIN_CLIENT_ID"), os.Getenv("LINKEDIN_CLIENT_SECRET")
}

func (p *Provider) clientForm(extra url.Values) []byte {
	id, secret := p.Credentials()
	extra.Set("client_id", id)
	extra.Set("client_secret", secret)
	return []byte(extra.Encode())
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        any    `json:"scope"`
}

func requestToken(ctx context.Context, form []byte) (*tokenResponse, error) {
	var token tokenResponse
	err := FetchJSON(ctx, http.MethodPost, WWWURL+"/oauth/v2/accessToken",
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, form, &token)
	return &token, err
}

type userInfo struct {
	Name    string `json:"name"`
	Sub     string `json:"sub"`
	Picture string `json:"picture"`
}

func fetchUserInfo(ctx context.Context, accessToken string) (*userInfo, error) {
	var info userInfo
	err := FetchJSON(ctx, http.MethodGet, APIURL+"/v2/userinfo", map[string]string{"Authorization": "Bearer " + accessToken}, nil, &info)
	return &info, err
}

func fetchVanityName(ctx context.Context, accessToken string) (string, error) {
	var me struct {
		VanityName string `json:"vanityName"`
	}
	err := FetchJSON(ctx, http.MethodGet, APIURL+"/v2/me", map[string]string{"Authorization": "Bearer " + accessToken}, nil, &me)
	return me.VanityName, err
}

// member reads the authorizing member and vanity name. A Page app has
// r_basicprofile instead of OpenID, so it reads both from /v2/me.
func (p *Provider) member(ctx context.Context, accessToken string) (*userInfo, string, error) {
	if p.identifier == "linkedin-page" {
		var me struct {
			ID                 string `json:"id"`
			LocalizedFirstName string `json:"localizedFirstName"`
			LocalizedLastName  string `json:"localizedLastName"`
			VanityName         string `json:"vanityName"`
		}
		err := FetchJSON(ctx, http.MethodGet, APIURL+"/v2/me?projection=(id,localizedFirstName,localizedLastName,vanityName)",
			map[string]string{"Authorization": "Bearer " + accessToken}, nil, &me)
		return &userInfo{Sub: me.ID, Name: strings.TrimSpace(me.LocalizedFirstName + " " + me.LocalizedLastName)}, me.VanityName, err
	}
	info, err := fetchUserInfo(ctx, accessToken)
	if err != nil {
		return nil, "", err
	}
	vanityName, err := fetchVanityName(ctx, accessToken)
	return info, vanityName, err
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	token, err := requestToken(ctx, p.clientForm(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}))
	if err != nil {
		return nil, err
	}
	info, vanityName, err := p.member(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           info.Sub,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    token.ExpiresIn,
		Name:         info.Name,
		Picture:      info.Picture,
		Username:     vanityName,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	clientID, _ := p.Credentials()
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=" + clientID +
			"&redirect_uri=" + EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/linkedin") +
			"&state=" + state + "&scope=" + EncodeURIComponent(strings.Join(Scopes, " ")),
		CodeVerifier: ids.Secure(30),
		State:        state,
	}, nil
}

// ExchangeCode is authenticate's body after the redirect URI: code exchange,
// scope check, userinfo and vanity name.
func (p *Provider) ExchangeCode(ctx context.Context, code, redirectURI string) (*integrations.AuthTokenDetails, error) {
	return p.ExchangeCodeForScopes(ctx, code, redirectURI, Scopes)
}

func (p *Provider) ExchangeCodeForScopes(ctx context.Context, code, redirectURI string, scopes []string) (*integrations.AuthTokenDetails, error) {
	token, err := requestToken(ctx, p.clientForm(url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI},
	}))
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, token.Scope); err != nil {
		return nil, err
	}
	info, vanityName, err := p.member(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           info.Sub,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    token.ExpiresIn,
		Name:         info.Name,
		Picture:      info.Picture,
		Username:     vanityName,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	redirect := os.Getenv("FRONTEND_URL") + "/integrations/social/linkedin"
	if params.Refresh != "" {
		redirect += "?refresh=" + params.Refresh
	}
	return p.ExchangeCode(ctx, params.Code, redirect)
}

var companyURL = regexp.MustCompile(`^https?://(?:www\.)?linkedin\.com/company/([^/]+)/?$`)

type companyOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

type companyResult struct {
	Options *companyOption `json:"options,omitempty"`
}

var errNoElements = errors.New("LinkedIn did not return an organization lookup result")

// Company resolves a company page URL to a mention option.
func (p *Provider) Company(ctx context.Context, token string, data json.RawMessage) (any, error) {
	var in struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(data, &in)
	match := companyURL.FindStringSubmatch(in.URL)
	if match == nil {
		return nil, errors.New("Invalid LinkedIn company URL")
	}
	var out struct {
		Elements []struct {
			LocalizedName string      `json:"localizedName"`
			ID            json.Number `json:"id"`
		} `json:"elements"`
	}
	response, err := p.Fetch(ctx, APIURL+"/rest/organizations?q=vanityName&vanityName="+EncodeURIComponent(match[1]), integrations.Request{Method: http.MethodGet, Headers: Headers(token, "")})
	if err != nil {
		return nil, err
	}
	if err := response.JSON(&out); err != nil {
		return nil, err
	}
	if out.Elements == nil {
		return nil, errNoElements
	}
	result := companyResult{}
	if len(out.Elements) > 0 && organizationID.MatchString(out.Elements[0].ID.String()) && strings.TrimSpace(out.Elements[0].LocalizedName) != "" {
		e := out.Elements[0]
		result.Options = &companyOption{Label: e.LocalizedName, Value: p.MentionFormat(e.ID.String(), e.LocalizedName)}
	}
	return result, nil
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"company": func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Company(ctx, token, data)
		},
	}
}

func (p *Provider) Mention(ctx context.Context, token, query, _ string, _ *ent.Integration) ([]integrations.MentionResult, bool, error) {
	var out struct {
		Elements []struct {
			ID            json.Number `json:"id"`
			LocalizedName string      `json:"localizedName"`
			LogoV2        *LogoV2     `json:"logoV2"`
		} `json:"elements"`
	}
	query = strings.TrimSpace(query)
	if len(query) < 2 || len(query) > 100 {
		return nil, false, errors.New("Search an organization using 2 to 100 characters")
	}
	response, err := p.request(ctx, http.MethodGet, "/rest/organizations?q=vanityName&vanityName="+EncodeURIComponent(query)+"&projection=(elements*(id,localizedName,logoV2(original~:playableStreams)))", token, nil)
	if err != nil {
		return nil, false, err
	}
	if err := response.JSON(&out); err != nil {
		return nil, false, err
	}
	if out.Elements == nil {
		return nil, false, errNoElements
	}
	results := make([]integrations.MentionResult, 0, len(out.Elements))
	seen := map[string]bool{}
	for _, e := range out.Elements {
		if !organizationID.MatchString(e.ID.String()) || strings.TrimSpace(e.LocalizedName) == "" || seen[e.ID.String()] {
			continue
		}
		seen[e.ID.String()] = true
		results = append(results, integrations.MentionResult{ID: e.ID.String(), Label: e.LocalizedName, Image: e.LogoV2.URL()})
	}
	return results, false, nil
}

func (p *Provider) MentionFormat(idOrHandle, name string) string {
	if !organizationID.MatchString(idOrHandle) {
		return littleText.Replace(name)
	}
	return fmt.Sprintf("@[%s](urn:li:organization:%s)", littleText.Replace(name), idOrHandle)
}

var (
	companyMention = regexp.MustCompile(`@\[(?:\\.|[^\]\\])+]\(urn:li:(?:organization:[0-9]{1,30}|person:[A-Za-z0-9_-]{1,100})\)`)
	// One pass is the same as the TypeScript replace chain: the backslash is
	// escaped first and no later replacement produces a character it escapes.
	littleText = strings.NewReplacer(
		`\`, `\\`, `<`, `\<`, `>`, `\>`, `#`, `\#`, `~`, `\~`, `_`, `\_`, `|`, `\|`,
		`[`, `\[`, `]`, `\]`, `*`, `\*`, `(`, `\(`, `)`, `\)`, `{`, `\{`, `}`, `\}`, `@`, `\@`,
	)
)

// FixText escapes LinkedIn "little text" reserved characters everywhere except
// inside valid native organization and person mentions.
func FixText(text string) string {
	var out strings.Builder
	last := 0
	for _, loc := range companyMention.FindAllStringIndex(text, -1) {
		out.WriteString(littleText.Replace(text[last:loc[0]]))
		out.WriteString(text[loc[0]:loc[1]])
		last = loc[1]
	}
	out.WriteString(littleText.Replace(text[last:]))
	return out.String()
}
