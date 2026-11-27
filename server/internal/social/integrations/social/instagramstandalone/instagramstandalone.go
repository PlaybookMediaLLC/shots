// Package instagramstandalone is the Instagram (direct login) provider: Instagram
// accounts connected with Instagram Login. Publishing, comments and insights
// delegate to the instagram provider on the graph.instagram.com host; only
// auth, validation and metadata differ.
package instagramstandalone

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/facebook"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/instagram"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

const host = "graph.instagram.com"

var scopes = []string{
	"instagram_business_basic",
	"instagram_business_content_publish",
	"instagram_business_manage_comments",
	"instagram_business_manage_insights",
}

var _ interface {
	integrations.Provider
	integrations.PendingPoster
	integrations.Commenter
	integrations.Analytics
	integrations.PostAnalytics
} = (*Provider)(nil)

// Provider extends SocialAbstract (not InstagramProvider) in TypeScript and
// delegates to a private instagram instance, so the instagram provider is
// composed, not embedded: its pages/audio functions are not exposed here.
type Provider struct {
	*integrations.Base
	ig *instagram.Provider
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase("instagram-standalone", instagram.HandleErrors), ig: instagram.New()}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       "instagram-standalone",
		Name:             "Instagram\n(Standalone)",
		Editor:           "normal",
		Scopes:           scopes,
		RefreshCron:      true,
		MaxConcurrentJob: 200, // Instagram standalone has stricter limits
		ConvertToJPEG:    true,
		Rules:            instagram.Rules,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2200 }

func (p *Provider) SettingsDTO() any { return &instagram.InstagramDTO{} }

func (p *Provider) CheckValidity(_ context.Context, posts [][]integrations.ValidityMedia, raw json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	var firstPost []integrations.ValidityMedia
	if len(posts) > 0 {
		firstPost = posts[0]
	}
	if len(firstPost) == 0 {
		return "Should have at least one media", nil
	}
	if integrations.AssetBoolean(instagram.SettingsOf(raw).IsTrialReel) {
		if len(firstPost) > 1 {
			return "Trial Reels can only have one video", nil
		}
		if !instagram.HasVideo(firstPost) {
			return "Trial Reels must be a video", nil
		}
	}
	return "", nil
}

// Instagram requires an HTTPS callback. Never send an authorization code
// through a third-party redirect service to reach a local HTTP frontend.
func redirectURI() (string, error) {
	frontend, err := url.Parse(os.Getenv("FRONTEND_URL"))
	if err != nil || frontend.Scheme != "https" || frontend.Hostname() == "" || strings.HasSuffix(frontend.Host, ":") || frontend.User != nil ||
		(frontend.Path != "" && frontend.Path != "/") || frontend.ForceQuery || frontend.RawQuery != "" || frontend.Fragment != "" {
		return "", errors.New("FRONTEND_URL must be an HTTPS origin for Instagram OAuth")
	}
	if strings.Contains(frontend.Hostname(), ":") &&
		(!strings.HasPrefix(frontend.Host, "[") || net.ParseIP(frontend.Hostname()) == nil) {
		return "", errors.New("FRONTEND_URL must be an HTTPS origin for Instagram OAuth")
	}
	if port := frontend.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("FRONTEND_URL must be an HTTPS origin for Instagram OAuth")
		}
	}
	return strings.TrimSuffix(frontend.String(), "/") + "/integrations/social/instagram-standalone", nil
}

// flexID accepts a JSON string or number id.
type flexID string

func (f *flexID) UnmarshalJSON(data []byte) error {
	var s string
	if json.Unmarshal(data, &s) == nil {
		*f = flexID(s)
		return nil
	}
	if string(data) != "null" {
		*f = flexID(data)
	}
	return nil
}

type me struct {
	UserID            flexID `json:"user_id"`
	Name              string `json:"name"`
	Username          string `json:"username"`
	ProfilePictureURL string `json:"profile_picture_url"`
}

func (p *Provider) me(ctx context.Context, accessToken string) (*me, error) {
	var m me
	err := facebook.GetJSON(ctx, "https://graph.instagram.com/"+facebook.MetaGraphAPIVersion+"/me?fields=user_id,username,name,profile_picture_url&access_token="+accessToken, &m)
	return &m, err
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	var refreshed struct {
		AccessToken string `json:"access_token"`
	}
	if err := facebook.GetJSON(ctx, "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token="+refreshToken, &refreshed); err != nil {
		return nil, err
	}
	m, err := p.me(ctx, refreshed.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           string(m.UserID),
		Name:         m.Name,
		AccessToken:  refreshed.AccessToken,
		RefreshToken: refreshed.AccessToken,
		ExpiresIn:    facebook.ExpiresInDays(58),
		Picture:      m.ProfilePictureURL,
		Username:     m.Username,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	callback, err := redirectURI()
	if err != nil {
		return nil, err
	}
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.instagram.com/oauth/authorize?enable_fb_login=0&client_id=" + os.Getenv("INSTAGRAM_APP_ID") +
			"&redirect_uri=" + facebook.EncodeURIComponent(callback) +
			"&response_type=code&scope=" + facebook.EncodeURIComponent(strings.Join(scopes, ",")) +
			"&state=" + state,
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	callback, err := redirectURI()
	if err != nil {
		return nil, err
	}
	var form bytes.Buffer
	writer := multipart.NewWriter(&form)
	for _, field := range [][2]string{
		{"client_id", os.Getenv("INSTAGRAM_APP_ID")},
		{"client_secret", os.Getenv("INSTAGRAM_APP_SECRET")},
		{"grant_type", "authorization_code"},
		{"redirect_uri", callback},
		{"code", params.Code},
	} {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.instagram.com/oauth/access_token", &form)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var getAccessToken struct {
		AccessToken string `json:"access_token"`
		Permissions any    `json:"permissions"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&getAccessToken); err != nil {
		return nil, err
	}

	var exchanged struct {
		AccessToken string `json:"access_token"`
	}
	if err := facebook.GetJSON(ctx, "https://graph.instagram.com/access_token"+
		"?grant_type=ig_exchange_token"+
		"&client_id="+os.Getenv("INSTAGRAM_APP_ID")+
		"&client_secret="+os.Getenv("INSTAGRAM_APP_SECRET")+
		"&access_token="+getAccessToken.AccessToken, &exchanged); err != nil {
		return nil, err
	}

	if err := p.CheckScopes(scopes, getAccessToken.Permissions); err != nil {
		return nil, err
	}

	m, err := p.me(ctx, exchanged.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           string(m.UserID),
		Name:         m.Name,
		AccessToken:  exchanged.AccessToken,
		RefreshToken: exchanged.AccessToken,
		ExpiresIn:    facebook.ExpiresInDays(58),
		Picture:      m.ProfilePictureURL,
		Username:     m.Username,
	}, nil
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.ig.PostOn(ctx, id, accessToken, posts, integration, host)
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.ig.PostPendingOn(ctx, id, accessToken, posts, integration, host)
}

// the graph domain travels inside pendingData, so these are pure delegations
func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	return p.ig.CheckPostStatus(ctx, accessToken, pendingData, integration)
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, pendingData json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	return p.ig.FinalizePost(ctx, accessToken, pendingData, integration)
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	return p.ig.CommentOn(ctx, id, postID, lastCommentID, accessToken, posts, integration, host)
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	return p.ig.AnalyticsOn(ctx, id, accessToken, days, host)
}

func (p *Provider) PostAnalytics(ctx context.Context, integrationID, accessToken, postID string, fromDate int64) ([]integrations.AnalyticsData, error) {
	return p.ig.PostAnalyticsOn(ctx, integrationID, accessToken, postID, fromDate, host)
}
