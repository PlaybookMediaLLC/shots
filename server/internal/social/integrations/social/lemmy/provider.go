// Package lemmy is the Lemmy provider.
package lemmy

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"go.temporal.io/sdk/temporal"
)

const identifier = "lemmy"

type Provider struct {
	*integrations.Base
}

var (
	_ integrations.Provider      = (*Provider)(nil)
	_ integrations.Commenter     = (*Provider)(nil)
	_ integrations.CustomFielder = (*Provider)(nil)
)

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier: identifier,
		Name:       "Lemmy",
		Editor:     "normal",
		Scopes:     []string{},
		// Lemmy instances typically have moderate limits
		MaxConcurrentJob: 3,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 10000 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "rate_limit_error"):
		return &integrations.HandledError{Type: "retry", Value: "Lemmy rate limit reached, please try again later"}
	case strings.Contains(body, "not_logged_in") || strings.Contains(body, "incorrect_login"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Lemmy session is no longer valid, please reconnect the channel"}
	case strings.Contains(body, "site_ban") || strings.Contains(body, `"error":"banned"`):
		return &integrations.HandledError{Type: "bad-body", Value: "This account is banned on the Lemmy instance"}
	case strings.Contains(body, "couldnt_find_community"):
		return &integrations.HandledError{Type: "bad-body", Value: "The selected Lemmy community no longer exists, please pick another one"}
	case strings.Contains(body, "blocked_url"):
		return &integrations.HandledError{Type: "bad-body", Value: "The Lemmy instance blocks the URL in this post"}
	case strings.Contains(body, `"error":"deleted"`):
		return &integrations.HandledError{Type: "bad-body", Value: "The selected Lemmy community or post was deleted"}
	case strings.Contains(body, `"error":"locked"`):
		return &integrations.HandledError{Type: "bad-body", Value: "This Lemmy post is locked, comments cannot be added"}
	}
	return nil
}

func (p *Provider) CheckValidity(_ context.Context, items [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	if len(items) == 0 || len(items[0]) == 0 {
		return "", nil
	}
	path := items[0][0].Path
	if !strings.Contains(path, "png") && !strings.Contains(path, "jpg") && !strings.Contains(path, "jpef") && !strings.Contains(path, "gif") {
		return "You can set only one picture for a cover", nil
	}
	return "", nil
}

func (p *Provider) CustomFields() []integrations.CustomField {
	return []integrations.CustomField{
		{
			Key: "service", Label: "Service", DefaultValue: "https://lemmy.world", Type: "text",
			Validation: `/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/`,
		},
		{Key: "identifier", Label: "Identifier", Validation: `/^.{3,}$/`, Type: "text"},
		{Key: "password", Label: "Password", Validation: `/^.{3,}$/`, Type: "password"},
	}
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{URL: state, CodeVerifier: ids.Secure(10), State: state}, nil
}

type credentials struct {
	Service    string `json:"service"`
	Identifier string `json:"identifier"`
	Password   string `json:"password"`
}

// decodeCode is JSON.parse(Buffer.from(code, 'base64').toString()).
func decodeCode(code string, v any) error {
	data, err := base64.StdEncoding.DecodeString(code)
	if err != nil {
		if data, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(code, "=")); err != nil {
			return err
		}
	}
	return json.Unmarshal(data, v)
}

func expiresIn(years int) int64 {
	now := time.Now()
	return now.AddDate(years, 0, 0).Unix() - now.Unix()
}

func loginBody(c credentials) []byte {
	body, _ := json.Marshal(map[string]string{"username_or_email": c.Identifier, "password": c.Password})
	return body
}

// raw is a plain fetch with the SSRF-safe dispatcher (no retry/classification).
func raw(ctx context.Context, method, rawURL string, headers map[string]string, body []byte) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	return res.StatusCode, data, err
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	var body credentials
	if err := decodeCode(params.Code, &body); err != nil {
		return nil, err
	}
	status, data, err := raw(ctx, http.MethodPost, body.Service+"/api/v3/user/login", map[string]string{"Content-Type": "application/json"}, loginBody(body))
	if err != nil {
		return nil, err
	}
	if status == http.StatusUnauthorized {
		return nil, integrations.AuthMessage("Invalid credentials")
	}
	var login struct {
		JWT string `json:"jwt"`
	}
	if err := json.Unmarshal(data, &login); err != nil {
		return nil, err
	}

	var user struct {
		PersonView *struct {
			Person struct {
				ID          json.Number `json:"id"`
				DisplayName string      `json:"display_name"`
				Name        string      `json:"name"`
				Avatar      string      `json:"avatar"`
			} `json:"person"`
		} `json:"person_view"`
	}
	_, data, err = raw(ctx, http.MethodGet, body.Service+"/api/v3/user?username="+url.QueryEscape(body.Identifier), map[string]string{"Authorization": "Bearer " + login.JWT}, nil)
	if err != nil || json.Unmarshal(data, &user) != nil || user.PersonView == nil {
		return nil, integrations.AuthMessage("Invalid credentials")
	}
	person := user.PersonView.Person
	name := person.DisplayName
	if name == "" {
		name = person.Name
	}
	return &integrations.AuthTokenDetails{
		RefreshToken: login.JWT,
		ExpiresIn:    expiresIn(100),
		AccessToken:  login.JWT,
		ID:           person.ID.String(),
		Name:         name,
		Picture:      person.Avatar,
		Username:     body.Identifier,
	}, nil
}

// failureJSON is `err.details?.[0]?.json || '{}'`.
func failureJSON(err error) string {
	var app *temporal.ApplicationError
	if errors.As(err, &app) && app.HasDetails() {
		var d temporalx.FailureDetails
		if app.Details(&d) == nil && d.JSON != "" {
			return d.JSON
		}
	}
	return "{}"
}

func (p *Provider) getJWTAndService(ctx context.Context, integration *ent.Integration) (jwt, service string, err error) {
	if integration == nil || integration.CustomInstanceDetails == nil {
		return "", "", errors.New("missing custom instance details")
	}
	decrypted, err := helpers.FixedDecryption(*integration.CustomInstanceDetails)
	if err != nil {
		return "", "", err
	}
	var body credentials
	if err := json.Unmarshal([]byte(decrypted), &body); err != nil {
		return "", "", err
	}

	login, err := p.Fetch(ctx, body.Service+"/api/v3/user/login", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    loginBody(body),
	})
	if err != nil {
		// The request body holds the stored password, so the failure is rebuilt
		// without it before it reaches the Temporal history and the Errors table.
		message := temporalx.FailureMessage(err)
		if message == "" {
			message = "Unknown Error"
		}
		switch temporalx.FailureType(err) {
		case temporalx.TypeBadBody:
			return "", "", temporalx.BadBody(identifier, failureJSON(err), "{}", message)
		case temporalx.TypeRefreshToken:
			return "", "", temporalx.RefreshToken(identifier, failureJSON(err), "{}", message)
		}
		return "", "", err
	}
	var res struct {
		JWT string `json:"jwt"`
	}
	if err := login.JSON(&res); err != nil {
		return "", "", err
	}
	return res.JWT, body.Service, nil
}

// jsNumber is JavaScript's unary plus on a string; nil stands for NaN
// (serialized as null).
func jsNumber(s *string) *float64 {
	if s == nil {
		return nil
	}
	t := strings.TrimSpace(*s)
	if t == "" {
		zero := 0.0
		return &zero
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return nil
	}
	return &n
}

func authHeaders(jwt string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + jwt, "Content-Type": "application/json"}
}

func joinResults(id string, postIDs, urls []string) []integrations.PostResponse {
	return []integrations.PostResponse{{
		ID:         id,
		PostID:     strings.Join(postIDs, ","),
		ReleaseURL: strings.Join(urls, ","),
		Status:     "published",
	}}
}

func (p *Provider) Post(ctx context.Context, _, _ string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	var settings SettingsDTO
	if len(firstPost.Settings) > 0 {
		if err := json.Unmarshal(firstPost.Settings, &settings); err != nil {
			return nil, err
		}
	}
	jwt, service, err := p.getJWTAndService(ctx, integration)
	if err != nil {
		return nil, err
	}

	var postIDs, urls []string
	for _, lemmy := range settings.Subreddit {
		value := &SettingsDTOInner{}
		if lemmy != nil && lemmy.Value != nil {
			value = lemmy.Value
		}
		body := struct {
			CommunityID     *float64 `json:"community_id"`
			Name            *string  `json:"name,omitempty"`
			Body            string   `json:"body"`
			URL             string   `json:"url,omitempty"`
			CustomThumbnail string   `json:"custom_thumbnail,omitempty"`
			NSFW            bool     `json:"nsfw"`
		}{CommunityID: jsNumber(value.ID), Name: value.Title, Body: firstPost.Message}
		if value.URL != nil && *value.URL != "" {
			body.URL = *value.URL
			if !strings.Contains(body.URL, "http") {
				body.URL = "https://" + body.URL
			}
		}
		if len(firstPost.Media) > 0 {
			body.CustomThumbnail = firstPost.Media[0].Path
		}
		data, _ := json.Marshal(body)
		res, err := p.Fetch(ctx, service+"/api/v3/post", integrations.Request{Method: http.MethodPost, Headers: authHeaders(jwt), Body: data})
		if err != nil {
			return nil, err
		}
		var out struct {
			PostView *struct {
				Post struct {
					ID json.Number `json:"id"`
				} `json:"post"`
			} `json:"post_view"`
		}
		if err := res.JSON(&out); err != nil {
			return nil, err
		}
		if out.PostView == nil {
			return nil, fmt.Errorf("Cannot read properties of undefined (reading 'post')")
		}
		postIDs = append(postIDs, out.PostView.Post.ID.String())
		urls = append(urls, service+"/post/"+out.PostView.Post.ID.String())
	}
	return joinResults(firstPost.ID, postIDs, urls), nil
}

func (p *Provider) Comment(ctx context.Context, _, postID, _, _ string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	commentPost := posts[0]
	jwt, service, err := p.getJWTAndService(ctx, integration)
	if err != nil {
		return nil, err
	}

	// postId can be comma-separated if posted to multiple communities
	var postIDs, urls []string
	for _, singlePostID := range strings.Split(postID, ",") {
		data, _ := json.Marshal(struct {
			PostID  *float64 `json:"post_id"`
			Content string   `json:"content"`
		}{jsNumber(&singlePostID), commentPost.Message})
		res, err := p.Fetch(ctx, service+"/api/v3/comment", integrations.Request{Method: http.MethodPost, Headers: authHeaders(jwt), Body: data})
		if err != nil {
			return nil, err
		}
		var out struct {
			CommentView *struct {
				Comment struct {
					ID json.Number `json:"id"`
				} `json:"comment"`
			} `json:"comment_view"`
		}
		if err := res.JSON(&out); err != nil {
			return nil, err
		}
		if out.CommentView == nil {
			return nil, fmt.Errorf("Cannot read properties of undefined (reading 'comment')")
		}
		postIDs = append(postIDs, out.CommentView.Comment.ID.String())
		urls = append(urls, service+"/comment/"+out.CommentView.Comment.ID.String())
	}
	return joinResults(commentPost.ID, postIDs, urls), nil
}

type Community struct {
	Title string          `json:"title"`
	Name  string          `json:"name"`
	ID    json.RawMessage `json:"id"`
}

// Subreddits is the "subreddits" @Tool: search communities by keyword.
func (p *Provider) Subreddits(ctx context.Context, data json.RawMessage, integration *ent.Integration) ([]Community, error) {
	// A missing word searches with an empty q (all communities by activity);
	// upstream interpolated it as the literal "undefined".
	var input struct {
		Word string `json:"word"`
	}
	_ = json.Unmarshal(data, &input)
	jwt, service, err := p.getJWTAndService(ctx, integration)
	if err != nil {
		return nil, err
	}
	res, err := p.Fetch(ctx, service+"/api/v3/search?type_=Communities&sort=Active&q="+url.QueryEscape(input.Word), integrations.Request{
		Headers: map[string]string{"Authorization": "Bearer " + jwt},
	})
	if err != nil {
		return nil, err
	}
	var out struct {
		Communities []struct {
			Community struct {
				Title string          `json:"title"`
				ID    json.RawMessage `json:"id"`
			} `json:"community"`
		} `json:"communities"`
	}
	if err := res.JSON(&out); err != nil {
		return nil, err
	}
	list := make([]Community, 0, len(out.Communities))
	for _, c := range out.Communities {
		list = append(list, Community{Title: c.Community.Title, Name: c.Community.Title, ID: c.Community.ID})
	}
	return list, nil
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"subreddits": func(ctx context.Context, _ string, data json.RawMessage, _ string, integration *ent.Integration) (any, error) {
			return p.Subreddits(ctx, data, integration)
		},
	}
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{{
		MethodName:  "subreddits",
		Description: "Search for Lemmy communities by keyword",
		DataSchema:  []integrations.ToolField{{Key: "word", Type: "string", Description: "Keyword to search for"}},
	}}
}
