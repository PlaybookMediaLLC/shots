// Package moltbook is the Moltbook provider and its MoltbookDto.
package moltbook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf16"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// moltbookAPIBase is MOLTBOOK_API_BASE; overridden by tests.
var moltbookAPIBase = "https://www.moltbook.com/api/v1"

// MoltbookDto is the provider settings DTO.
type MoltbookDto struct {
	Submolt *string `json:"submolt,omitempty"`
}

// Validate: submolt is @IsOptional @IsString, which decoding already enforces.
func (d *MoltbookDto) Validate() []string { return nil }

type Provider struct{ *integrations.Base }

var (
	_ integrations.Provider  = (*Provider)(nil)
	_ integrations.Commenter = (*Provider)(nil)
)

func New() *Provider { return &Provider{Base: integrations.NewBase("moltbook", nil)} }

func (p *Provider) Info() integrations.Info {
	// Moltbook: 100 requests/minute
	return integrations.Info{Identifier: "moltbook", Name: "Moltbook", Editor: "normal", Scopes: []string{}, IsWeb3: true, MaxConcurrentJob: 100}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 300 }

func (p *Provider) SettingsDTO() any { return &MoltbookDto{} }

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{URL: state, CodeVerifier: ids.Secure(10), State: state}, nil
}

// Agent is a Moltbook agent as returned by register and /agents/me.
type Agent struct {
	ID               any    `json:"id,omitempty"`
	Name             string `json:"name,omitempty"`
	DisplayName      string `json:"display_name,omitempty"`
	APIKey           string `json:"api_key,omitempty"`
	ClaimURL         string `json:"claim_url,omitempty"`
	VerificationCode string `json:"verification_code,omitempty"`
}

type envelope struct {
	Success bool            `json:"success"`
	Error   string          `json:"error"`
	Agent   *Agent          `json:"agent"`
	Post    json.RawMessage `json:"post"`
	Comment json.RawMessage `json:"comment"`
}

// request is the SSRF-safe axios call: a non-2xx status is an error with
// axios's message, and the body is decoded into out when it is JSON.
func request(ctx context.Context, method, url string, headers map[string]string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("Request failed with status code %d", res.StatusCode)
	}
	// A non-JSON body leaves out zero-valued, like reading fields off a string.
	json.Unmarshal(data, out)
	return nil
}

// RegisterAgent is called by POST /integrations/moltbook/register.
func (p *Provider) RegisterAgent(ctx context.Context, name, description string) (*Agent, error) {
	var data envelope
	err := request(ctx, http.MethodPost, moltbookAPIBase+"/agents/register",
		map[string]string{"Content-Type": "application/json"},
		map[string]string{"name": name, "description": description}, &data)
	if err != nil {
		return nil, err
	}
	if !data.Success {
		return nil, errors.New(or(data.Error, "Registration failed"))
	}
	if data.Agent == nil {
		return &Agent{}, nil
	}
	return data.Agent, nil
}

// CheckAgentStatus is called by GET /integrations/moltbook/status; it
// returns the raw response body (the controller reads `status`).
func (p *Provider) CheckAgentStatus(ctx context.Context, apiKey string) (map[string]any, error) {
	var data map[string]any
	err := request(ctx, http.MethodGet, moltbookAPIBase+"/agents/status",
		map[string]string{"Authorization": "Bearer " + apiKey}, nil, &data)
	return data, err
}

func (p *Provider) GetAgentProfile(ctx context.Context, apiKey string) (*Agent, error) {
	var data envelope
	err := request(ctx, http.MethodGet, moltbookAPIBase+"/agents/me",
		map[string]string{"Authorization": "Bearer " + apiKey}, nil, &data)
	if err != nil {
		return nil, err
	}
	if !data.Success {
		return nil, errors.New(or(data.Error, "Failed to get profile"))
	}
	if data.Agent == nil {
		return nil, errors.New("Cannot read properties of undefined (reading 'name')")
	}
	return data.Agent, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	apiKey := params.Code
	profile, err := p.GetAgentProfile(ctx, apiKey)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	return &integrations.AuthTokenDetails{
		ID:          or(profile.Name, jsString(profile.ID)),
		Name:        or(profile.DisplayName, profile.Name),
		AccessToken: apiKey,
		ExpiresIn:   now.AddDate(200, 0, 0).Unix() - now.Unix(),
		Username:    profile.Name,
	}, nil
}

func authHeaders(accessToken string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": "application/json"}
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	results := []integrations.PostResponse{}
	for _, post := range posts {
		var settings MoltbookDto
		if len(post.Settings) > 0 {
			json.Unmarshal(post.Settings, &settings)
		}
		submolt := "general"
		if settings.Submolt != nil && *settings.Submolt != "" {
			submolt = *settings.Submolt
		}
		postData := struct {
			Submolt string `json:"submolt"`
			Title   string `json:"title"`
			Content string `json:"content"`
		}{Submolt: submolt, Title: slice(post.Message, 100), Content: post.Message}

		var data envelope
		if err := request(ctx, http.MethodPost, moltbookAPIBase+"/posts", authHeaders(accessToken), postData, &data); err != nil {
			return nil, err
		}
		if !data.Success {
			return nil, errors.New(or(data.Error, "Failed to create post"))
		}
		postID := objectID(data.Post)
		results = append(results, integrations.PostResponse{
			ID:         post.ID,
			PostID:     postID,
			ReleaseURL: "https://www.moltbook.com/post/" + postID,
			Status:     "completed",
		})
	}
	return results, nil
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	results := []integrations.PostResponse{}
	for _, post := range posts {
		commentData := struct {
			Content  string `json:"content"`
			ParentID string `json:"parent_id,omitempty"`
		}{Content: post.Message, ParentID: lastCommentID}

		var data envelope
		if err := request(ctx, http.MethodPost, moltbookAPIBase+"/posts/"+postID+"/comments", authHeaders(accessToken), commentData, &data); err != nil {
			return nil, err
		}
		if !data.Success {
			return nil, errors.New(or(data.Error, "Failed to create comment"))
		}
		results = append(results, integrations.PostResponse{
			ID:         post.ID,
			PostID:     objectID(data.Comment),
			ReleaseURL: "https://www.moltbook.com/post/" + postID,
			Status:     "completed",
		})
	}
	return results, nil
}

// objectID is String(obj.id).
func objectID(raw json.RawMessage) string {
	var obj struct {
		ID any `json:"id"`
	}
	json.Unmarshal(raw, &obj)
	if obj.ID == nil {
		return "undefined"
	}
	return jsString(obj.ID)
}

func or(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// slice is String.prototype.slice(0, n) over UTF-16 code units.
func slice(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// jsString is String(value) for JSON scalars.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	data, _ := json.Marshal(v)
	return string(data)
}
