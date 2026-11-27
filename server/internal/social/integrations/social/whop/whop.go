// Package whop is the Whop provider: forum posts on Whop experiences.
package whop

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/internal/communityutil"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "whop"

// Overridden by tests.
var (
	apiURL       = "https://api.whop.com"
	pollInterval = 5 * time.Second
)

var scopes = []string{"openid", "profile", "email", "forum:post:create", "forum:read", "company:basic:read"}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

// SettingsDTO is WhopDto.
type SettingsDTO struct {
	Company    *string `json:"company"`
	Experience *string `json:"experience"`
	Title      *string `json:"title,omitempty"`
}

// Validate reproduces class-validator: IsDefined first, then the remaining
// decorators bottom-up.
func (d *SettingsDTO) Validate() []string {
	var errs []string
	required := func(name string, v *string) {
		if v == nil {
			errs = append(errs, name+" should not be null or undefined", name+" must be a string")
		}
		if v == nil || communityutil.Length(*v) < 1 {
			errs = append(errs, name+" must be longer than or equal to 1 characters")
		}
	}
	required("company", d.Company)
	required("experience", d.Experience)
	return errs
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "Whop",
		Editor:           "markdown",
		Scopes:           scopes,
		ToolTip:          "Schedule posts to forums",
		MaxConcurrentJob: 3, // Whop limits are per token
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 50000 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "invalid_grant"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Invalid token, please re-authenticate"}
	case strings.Contains(body, "insufficient_scope"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Insufficient permissions, please re-authenticate with required scopes"}
	case strings.Contains(body, "invalid_request"):
		return &integrations.HandledError{Type: "bad-body", Value: "Invalid request parameters"}
	case strings.Contains(body, "not_found"):
		return &integrations.HandledError{Type: "bad-body", Value: "Forum or experience not found"}
	}
	return nil
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	ExpiresIn        int64  `json:"expires_in"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type userInfo struct {
	Sub               string `json:"sub"`
	Name              string `json:"name"`
	PreferredUsername string `json:"preferred_username"`
	Picture           string `json:"picture"`
}

func postJSON(ctx context.Context, url string, body any) (*integrations.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return communityutil.Fetch(ctx, http.MethodPost, url, map[string]string{"Content-Type": "application/json"}, data)
}

func (p *Provider) details(ctx context.Context, token tokenResponse) (*integrations.AuthTokenDetails, error) {
	res, err := communityutil.Fetch(ctx, http.MethodGet, apiURL+"/oauth/userinfo", map[string]string{"Authorization": "Bearer " + token.AccessToken}, nil)
	if err != nil {
		return nil, err
	}
	var user userInfo
	if err := res.JSON(&user); err != nil {
		return nil, err
	}
	name := user.Name
	if name == "" {
		name = user.PreferredUsername
	}
	expires := token.ExpiresIn
	if expires == 0 {
		expires = 3600
	}
	return &integrations.AuthTokenDetails{
		ID:           user.Sub,
		Name:         name,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    expires,
		Picture:      user.Picture,
		Username:     user.PreferredUsername,
	}, nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	res, err := postJSON(ctx, apiURL+"/oauth/token", map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     os.Getenv("WHOP_CLIENT_ID"),
	})
	if err != nil {
		return nil, err
	}
	var token tokenResponse
	if err := res.JSON(&token); err != nil {
		return nil, err
	}
	return p.details(ctx, token)
}

func base64URL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	codeVerifier := base64URL(random)
	sum := sha256.Sum256([]byte(codeVerifier))
	codeChallenge := base64URL(sum[:])
	nonce := ids.Secure(16)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://api.whop.com/oauth/authorize" +
			"?response_type=code" +
			"&client_id=" + os.Getenv("WHOP_CLIENT_ID") +
			"&redirect_uri=" + communityutil.EncodeURIComponent(os.Getenv("FRONTEND_URL")+"/integrations/social/whop") +
			"&scope=" + communityutil.EncodeURIComponent(strings.Join(scopes, " ")) +
			"&state=" + state +
			"&nonce=" + nonce +
			"&code_challenge=" + codeChallenge +
			"&code_challenge_method=S256",
		CodeVerifier: codeVerifier,
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	redirectURI := os.Getenv("FRONTEND_URL") + "/integrations/social/whop"
	if params.Refresh != "" {
		redirectURI += "?refresh=" + params.Refresh
	}
	res, err := postJSON(ctx, apiURL+"/oauth/token", map[string]string{
		"grant_type":    "authorization_code",
		"code":          params.Code,
		"redirect_uri":  redirectURI,
		"client_id":     os.Getenv("WHOP_CLIENT_ID"),
		"code_verifier": params.CodeVerifier,
	})
	if err != nil {
		return nil, err
	}
	var token tokenResponse
	if err := res.JSON(&token); err != nil {
		return nil, err
	}
	if token.Error != "" {
		reason := token.ErrorDescription
		if reason == "" {
			reason = token.Error
		}
		return nil, integrations.AuthMessage("Authentication failed: " + reason)
	}
	return p.details(ctx, token)
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{
		{MethodName: "companies", Description: "Companies", DataSchema: []integrations.ToolField{}},
		{MethodName: "experiences", Description: "Experiences", DataSchema: []integrations.ToolField{}},
	}
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"companies": func(ctx context.Context, token string, _ json.RawMessage, id string, _ *ent.Integration) (any, error) {
			return p.Companies(ctx, token), nil
		},
		"experiences": func(ctx context.Context, token string, data json.RawMessage, id string, _ *ent.Integration) (any, error) {
			var params struct {
				ID any `json:"id"`
			}
			_ = json.Unmarshal(data, &params)
			return p.Experiences(ctx, token, params.ID), nil
		},
	}
}

func (p *Provider) list(ctx context.Context, token, url string) []map[string]any {
	res, err := communityutil.Fetch(ctx, http.MethodGet, url, map[string]string{"Authorization": "Bearer " + token}, nil)
	if err != nil {
		return nil
	}
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := res.JSON(&body); err != nil {
		return nil
	}
	return body.Data
}

// Companies is the @Tool listing the user's companies; failures give [].
func (p *Provider) Companies(ctx context.Context, accessToken string) []communityutil.Option {
	out := []communityutil.Option{}
	for _, company := range p.list(ctx, accessToken, apiURL+"/api/v1/companies?first=50") {
		out = append(out, communityutil.Option{ID: company["id"], Name: company["title"]})
	}
	return out
}

// Experiences is the @Tool listing a company's forums; failures give [].
func (p *Provider) Experiences(ctx context.Context, accessToken string, companyID any) []communityutil.Option {
	out := []communityutil.Option{}
	if !communityutil.Truthy(companyID) {
		return out
	}
	for _, forum := range p.list(ctx, accessToken, apiURL+"/api/v1/forums?company_id="+communityutil.JSString(companyID)+"&first=50") {
		experience, _ := forum["experience"].(map[string]any)
		id, name := forum["id"], forum["id"]
		if communityutil.Truthy(experience["id"]) {
			id = experience["id"]
		}
		if communityutil.Truthy(experience["name"]) {
			name = experience["name"]
		}
		out = append(out, communityutil.Option{ID: id, Name: name})
	}
	return out
}

type attachment struct {
	ID string `json:"id"`
}

func (p *Provider) uploadMediaToWhop(ctx context.Context, media []integrations.MediaContent, accessToken string) ([]attachment, error) {
	attachments := []attachment{}
	for _, item := range media {
		// The size comes from a HEAD request; the PUT below streams the bytes
		// so the file is never buffered in memory.
		contentLength, err := p.MediaSize(ctx, item.Path, identifier)
		if err != nil {
			return nil, err
		}
		fileName := communityutil.LastSegment(item.Path)
		if fileName == "" {
			fileName = "file"
		}
		created, err := p.fetchJSON(ctx, apiURL+"/api/v1/files", integrations.Request{
			Method:  http.MethodPost,
			Headers: map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json"},
			Body:    mustJSON(map[string]string{"filename": fileName}),
		})
		if err != nil {
			return nil, err
		}
		fileID := communityutil.JSString(created["id"])
		if uploadURL := communityutil.JSString(created["upload_url"]); uploadURL != "" {
			headers, _ := created["upload_headers"].(map[string]any)
			if err := p.put(ctx, item.Path, uploadURL, contentLength, headers); err != nil {
				return nil, err
			}
			if err := p.waitReady(ctx, fileID, accessToken); err != nil {
				return nil, err
			}
		}
		attachments = append(attachments, attachment{ID: fileID})
	}
	return attachments, nil
}

func (p *Provider) put(ctx context.Context, mediaPath, uploadURL string, contentLength int64, uploadHeaders map[string]any) error {
	getReq, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaPath, nil)
	if err != nil {
		return err
	}
	getReq.Header.Set("Accept-Encoding", "identity")
	file, err := ssrf.StreamingClient().Do(getReq)
	if err != nil {
		return err
	}
	defer file.Body.Close()
	if !communityutil.OK(file.StatusCode) {
		return fmt.Errorf("Failed to fetch media: %s", communityutil.StatusText(file))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, file.Body)
	if err != nil {
		return err
	}
	// Whop's own upload_headers win if they ever include a length.
	req.ContentLength = contentLength
	for k, v := range uploadHeaders {
		if strings.EqualFold(k, "Content-Length") {
			if n, err := strconv.ParseInt(communityutil.JSString(v), 10, 64); err == nil {
				req.ContentLength = n
			}
			continue
		}
		req.Header.Set(k, communityutil.JSString(v))
	}
	res, err := ssrf.StreamingClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// A rejected PUT leaves the file pending forever - fail fast instead of
	// burning the ~9 minute status poll.
	if !communityutil.OK(res.StatusCode) {
		text, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if err != nil {
			text = []byte("{}")
		}
		return temporalx.BadBody(identifier, string(text), "{}", "Failed to upload the media file")
	}
	return nil
}

func (p *Provider) waitReady(ctx context.Context, fileID, accessToken string) error {
	const maxAttempts = 108 // ~9 minutes at 5s interval
	for attempts := 0; ; attempts++ {
		if attempts >= maxAttempts {
			return errors.New("File upload timed out")
		}
		status, err := p.fetchJSON(ctx, apiURL+"/api/v1/files/"+fileID, integrations.Request{
			Headers: map[string]string{"Authorization": "Bearer " + accessToken},
		})
		if err != nil {
			return err
		}
		switch communityutil.JSString(status["upload_status"]) {
		case "ready":
			return nil
		case "failed":
			return errors.New("File upload failed")
		}
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return err
		}
	}
}

func mustJSON(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}

func (p *Provider) fetchJSON(ctx context.Context, url string, req integrations.Request) (map[string]any, error) {
	res, err := p.Fetch(ctx, url, req)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := res.JSON(&out); err != nil {
		return nil, err
	}
	return out, nil
}

type forumPost struct {
	ExperienceID *string      `json:"experience_id,omitempty"`
	Content      string       `json:"content"`
	Title        string       `json:"title,omitempty"`
	ParentID     string       `json:"parent_id,omitempty"`
	Attachments  []attachment `json:"attachments,omitempty"`
}

func (p *Provider) createForumPost(ctx context.Context, accessToken string, post integrations.PostDetails, parentID string) (*SettingsDTO, string, error) {
	var settings SettingsDTO
	if err := communityutil.DecodeSettings(post.Settings, &settings); err != nil {
		return nil, "", err
	}
	attachments, err := p.uploadMediaToWhop(ctx, post.Media, accessToken)
	if err != nil {
		return nil, "", err
	}
	body := forumPost{ExperienceID: settings.Experience, Content: post.Message, ParentID: parentID, Attachments: attachments}
	if parentID == "" && settings.Title != nil {
		body.Title = *settings.Title
	}
	data, err := p.fetchJSON(ctx, apiURL+"/api/v1/forum_posts", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json"},
		Body:    mustJSON(body),
	})
	if err != nil {
		return nil, "", err
	}
	return &settings, communityutil.JSString(data["id"]), nil
}

func experience(s *SettingsDTO) string {
	if s.Experience == nil {
		return "undefined"
	}
	return *s.Experience
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	post := posts[0]
	settings, postID, err := p.createForumPost(ctx, accessToken, post, "")
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         post.ID,
		PostID:     postID,
		ReleaseURL: "https://whop.com/experiences/" + experience(settings) + "/" + postID,
		Status:     "success",
	}}, nil
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	post := posts[0]
	replyToID := lastCommentID
	if replyToID == "" {
		replyToID = postID
	}
	settings, newID, err := p.createForumPost(ctx, accessToken, post, replyToID)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         post.ID,
		PostID:     newID,
		ReleaseURL: "https://whop.com/experiences/" + experience(settings) + "/" + postID,
		Status:     "success",
	}}, nil
}
