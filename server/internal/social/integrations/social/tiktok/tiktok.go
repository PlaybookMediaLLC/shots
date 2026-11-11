// Package tiktok is the TikTok provider (the TikTok
// Content Posting API app) and the shared TikTokDto settings.
package tiktok

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

// apiURL is the TikTok API host; tests point it at an httptest.Server.
var apiURL = "https://open.tiktokapis.com"

// pollInterval is the legacy blocking post's wait between status checks.
var pollInterval = 20 * time.Second

// TikTok video chunk constraints: a chunk must be between 5MB and 64MB.
// When the whole file fits in a single chunk (<= 64MB) we upload it in one
// request; otherwise we split it into 10MB chunks (the final chunk carries
// the remainder, which TikTok allows to exceed chunk_size).
var (
	maxSingleChunk int64 = 64 * 1024 * 1024
	chunkSize      int64 = 10 * 1024 * 1024
)

var rules = strings.Join([]string{
	"TikTok can have one video or one picture or multiple pictures, it cannot be without an attachment.",
	"content_posting_method=DIRECT_POST publishes the post to the account. content_posting_method=UPLOAD does NOT publish: it only sends the media to the user inbox of the TikTok app, where the user must manually complete and publish it within 24 hours or it is discarded. Use DIRECT_POST unless the user explicitly asks to review or edit the post inside the TikTok app first.",
	"With content_posting_method=UPLOAD, TikTok ignores every setting except the title / post content. Never tell the user that video_made_with_ai, privacy_level, duet, stitch, comment, autoAddMusic, brand_content_toggle or brand_organic_toggle will be applied in UPLOAD mode - they are silently discarded. If the user asks for any of those settings, tell them it requires DIRECT_POST.",
	"video_made_with_ai, duet and stitch apply to video posts only. TikTok has no equivalent field for photo posts, so those settings are discarded when the attachment is a picture.",
}, " ")

var scopes = []string{
	"video.list",
	"user.info.basic",
	"video.publish",
	"video.upload",
	"user.info.profile",
	"user.info.stats",
}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase("tiktok", handleErrors)}
}

var (
	_ integrations.Provider          = (*Provider)(nil)
	_ integrations.PendingPoster     = (*Provider)(nil)
	_ integrations.Analytics         = (*Provider)(nil)
	_ integrations.PostAnalytics     = (*Provider)(nil)
	_ integrations.MissingFinder     = (*Provider)(nil)
	_ integrations.ReleaseIDResolver = (*Provider)(nil)
	_ integrations.ReleaseURLer      = (*Provider)(nil)
)

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       "tiktok",
		Name:             "Tiktok",
		Editor:           "normal",
		Scopes:           scopes,
		ConvertToJPEG:    true,
		MaxConcurrentJob: 10000,
		Rules:            rules,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2000 }

func (p *Provider) SettingsDTO() any { return &TikTokDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"maxVideoLength": func(ctx context.Context, accessToken string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.MaxVideoLength(ctx, accessToken)
		},
	}
}

func (p *Provider) CheckValidity(ctx context.Context, items [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	var firstItems []integrations.ValidityMedia
	if len(items) > 0 {
		firstItems = items[0]
	}
	if len(firstItems) == 0 {
		return "No video / images selected", nil
	}
	hasMP4 := false
	for _, m := range firstItems {
		if strings.Contains(m.Path, "mp4") {
			hasMP4 = true
		}
	}
	if len(firstItems) > 1 && hasMP4 {
		return "Only pictures are supported when selecting multiple items", nil
	} else if len(firstItems) != 1 && strings.Contains(firstItems[0].Path, "mp4") {
		return "You need one media", nil
	}

	// TikTok fails the whole photo post when a single image is oversized, and
	// the status only says `picture_size_check_failed` without naming it.
	if !hasMP4 {
		for i, m := range firstItems {
			width, height, err := p.ImageDimensions(ctx, m.Path)
			if err != nil {
				return "", err
			}
			if min(width, height) > 1080 {
				return fmt.Sprintf("Image %d is %dx%d, TikTok allows a maximum of 1080px on the shorter side", i+1, width, height), nil
			}
		}
	}
	return "", nil
}

type errorRule struct{ needle, kind, value string }

var errorRules = []errorRule{
	// Authentication/Authorization errors - require re-authentication
	{"access_token_invalid", "refresh-token", "Access token invalid, please re-authenticate your TikTok account"},
	{"scope_not_authorized", "bad-body", "Missing required permissions, please re-authenticate with all scopes"},
	{"scope_permission_missed", "bad-body", "Additional permissions required, please re-authenticate"},
	// Rate limiting errors
	{"rate_limit_exceeded", "bad-body", "TikTok API rate limit exceeded, please try again later"},
	{"file_format_check_failed", "bad-body", "File format is invalid, please check video specifications"},
	{"app_version_check_failed", "bad-body", "In order to use the TikTok upload feature, you have to update your app to the latest version"},
	{"duration_check_failed", "bad-body", "Video duration is invalid, please check video specifications"},
	{"frame_rate_check_failed", "bad-body", "Video frame rate is invalid, please check video specifications"},
	{"video_pull_failed", "bad-body", "Failed to pull video from URL, please check the URL"},
	{"photo_pull_failed", "bad-body", "Failed to pull photo from URL, please check the URL"},
	{"spam_risk_user_banned_from_posting", "bad-body", "Account banned from posting, please check TikTok account status"},
	{"spam_risk_text", "bad-body", "TikTok detected potential spam in the post text"},
	{"spam_risk_too_many_posts", "bad-body", "TikTok says your daily post limit reached, please try again tomorrow"},
	{"spam_risk_too_many_pending_share", "bad-body", "TikTok limits pending posts to 5 within any 24-hour period. Please check your TikTok inbox in the TikTok mobile app and try again after 24 hours."},
	{"spam_risk", "bad-body", "TikTok detected potential spam"},
	// TikTok limits how many users of this app can post per day: refreshing
	// the token cannot help, the channel must be re-connected (and can be
	// migrated to another app via MIGRATE_PROVIDERS).
	{"reached_active_user_cap", "disconnect", "TikTok daily user limit reached, please re-connect your account"},
	{"unaudited_client_can_only_post_to_private_accounts", "bad-body", "App not approved for public posting, contact support"},
	{"url_ownership_unverified", "bad-body", "You have to upload the picture/video to Shots when sending a URL"},
	{"privacy_level_option_mismatch", "bad-body", "Privacy level mismatch, please check privacy settings"},
	// Content/Format validation errors
	{"invalid_file_upload", "bad-body", "Invalid file format or specifications not met"},
	{"invalid_params", "bad-body", "Invalid request parameters, please check content format"},
	// Server errors
	{"internal", "bad-body", "There is a problem with TikTok servers, please try again later"},
	// Generic TikTok API errors
	{"picture_size_check_failed", "bad-body", "Media size not supported by TikTok: images up to 1080px on the shorter side, videos at least 360px on both sides"},
	{"TikTok API error", "bad-body", "TikTok API error, please try again"},
}

func handleErrors(body string, _ int) *integrations.HandledError {
	for _, r := range errorRules {
		if strings.Contains(body, r.needle) {
			return &integrations.HandledError{Type: r.kind, Value: r.value}
		}
	}
	// Fall back to parent class error handling
	return nil
}

func redirectURI() string {
	frontend := os.Getenv("FRONTEND_URL")
	prefix := ""
	if frontend != "" && !strings.Contains(frontend, "https") {
		prefix = "https://redirectmeto.com/"
	}
	return prefix + frontend + "/integrations/social/tiktok"
}

func encodeURIComponent(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

// plainFetch is the global fetch (no SSRF guard, fixed TikTok hosts) followed
// by .json().
func plainFetch(ctx context.Context, method, target string, headers map[string]string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
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
	return json.NewDecoder(res.Body).Decode(out)
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Scope        any    `json:"scope"`
}

type userInfo struct {
	AvatarURL   string `json:"avatar_url"`
	DisplayName string `json:"display_name"`
	OpenID      string `json:"open_id"`
	Username    string `json:"username"`
}

func (p *Provider) token(ctx context.Context, values url.Values) (*tokenResponse, error) {
	var token tokenResponse
	err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/oauth/token/",
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, []byte(values.Encode()), &token)
	return &token, err
}

func (p *Provider) user(ctx context.Context, accessToken string) (*userInfo, error) {
	var info struct {
		Data *struct {
			User *userInfo `json:"user"`
		} `json:"data"`
	}
	if err := plainFetch(ctx, http.MethodGet, apiURL+"/v2/user/info/?fields=open_id,avatar_url,display_name,union_id,username",
		map[string]string{"Authorization": "Bearer " + accessToken}, nil, &info); err != nil {
		return nil, err
	}
	if info.Data == nil || info.Data.User == nil || info.Data.User.OpenID == "" {
		return nil, errors.New("tiktok: user info response has no user")
	}
	return info.Data.User, nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, url.Values{
		"client_key":    {os.Getenv("TIKTOK_CLIENT_ID")},
		"client_secret": {os.Getenv("TIKTOK_CLIENT_SECRET")},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	})
	if err != nil {
		return nil, err
	}
	user, err := p.user(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		RefreshToken: token.RefreshToken,
		ExpiresIn:    int64((23 * time.Hour).Seconds()),
		AccessToken:  token.AccessToken,
		ID:           strings.ReplaceAll(user.OpenID, "-", ""),
		Name:         user.DisplayName,
		Picture:      user.AvatarURL,
		Username:     user.Username,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(16)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.tiktok.com/v2/auth/authorize/" +
			"?client_key=" + os.Getenv("TIKTOK_CLIENT_ID") +
			"&redirect_uri=" + encodeURIComponent(redirectURI()) +
			"&state=" + state +
			"&response_type=code" +
			"&scope=" + encodeURIComponent(strings.Join(scopes, ",")),
		CodeVerifier: state,
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, url.Values{
		"client_key":    {os.Getenv("TIKTOK_CLIENT_ID")},
		"client_secret": {os.Getenv("TIKTOK_CLIENT_SECRET")},
		"code":          {params.Code},
		"grant_type":    {"authorization_code"},
		"code_verifier": {params.CodeVerifier},
		"redirect_uri":  {redirectURI()},
	})
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, token.Scope); err != nil {
		return nil, err
	}
	user, err := p.user(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           strings.ReplaceAll(user.OpenID, "-", ""),
		Name:         user.DisplayName,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    int64((23 * time.Hour).Seconds()),
		Picture:      user.AvatarURL,
		Username:     user.Username,
	}, nil
}

type MaxVideoLengthResult struct {
	MaxDurationSeconds any `json:"maxDurationSeconds,omitempty"`
}

func (p *Provider) MaxVideoLength(ctx context.Context, accessToken string) (*MaxVideoLengthResult, error) {
	var info struct {
		Data *struct {
			MaxVideoPostDurationSec any `json:"max_video_post_duration_sec"`
		} `json:"data"`
	}
	if err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/post/publish/creator_info/query/", map[string]string{
		"Content-Type":  "application/json; charset=UTF-8",
		"Authorization": "Bearer " + accessToken,
	}, nil, &info); err != nil {
		return nil, err
	}
	if info.Data == nil {
		return nil, errors.New("tiktok: creator info response has no data")
	}
	return &MaxVideoLengthResult{MaxDurationSeconds: info.Data.MaxVideoPostDurationSec}, nil
}

type pendingData struct {
	PublishID string `json:"publishId"`
}

func (p *Provider) statusFetch(ctx context.Context, accessToken, publishID string) (*integrations.Response, error) {
	body, _ := json.Marshal(map[string]string{"publish_id": publishID})
	return p.Fetch(ctx, apiURL+"/v2/post/publish/status/fetch/", integrations.Request{
		Method:    http.MethodPost,
		Retryable: true, // a read sent as POST
		Headers: map[string]string{
			"Content-Type":  "application/json; charset=UTF-8",
			"Authorization": "Bearer " + accessToken,
		},
		Body: body,
	})
}

func isTokenOrDisconnect(err error) bool {
	t := temporalx.FailureType(err)
	return t == temporalx.TypeRefreshToken || t == temporalx.TypeDisconnect
}

// CheckPostStatus is a single status check for a publish_id, no loops and no
// timers: `post` returns a `pending` PostResponse right after the upload, and
// the post workflow polls this method with durable timers, so a stuck/retried
// check can never re-run the publish and duplicate the post.
func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending pendingData
	_ = json.Unmarshal(raw, &pending)
	stillPending := &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}

	res, err := p.statusFetch(ctx, accessToken, pending.PublishID)
	var post map[string]any
	if err == nil {
		err = json.Unmarshal(res.Body, &post)
	}
	if err != nil {
		if isTokenOrDisconnect(err) {
			return nil, err
		}
		// Transient API error while checking the status: the post may already
		// be live, so keep polling instead of failing it - if the API stays
		// broken the caller exhausts its checks and warns the user properly.
		return stillPending, nil
	}
	publicPostID := parsePublicPostID(res.Body)

	status, _ := field(post, "data", "status").(string)
	switch status {
	case "SEND_TO_USER_INBOX":
		// the id stays 'missing' until the user publishes the draft - the
		// publish id rides in the URL fragment so resolveReleaseId can ask later
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			ReleaseURL: "https://www.tiktok.com/messages?lang=en#" + pending.PublishID,
			PostID:     "missing",
		}, nil
	case "PUBLISH_COMPLETE":
		// Moderation may finish before TikTok exposes the native receipt.
		if publicPostID == "" {
			return stillPending, nil
		}
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			ReleaseURL: postURL(integration, pending.PublishID, publicPostID),
			PostID:     publicPostID,
		}, nil
	case "FAILED":
		text := compact(res.Body)
		value := ""
		if handled := handleErrors(text, 200); handled != nil {
			value = handled.Value
		}
		return nil, temporalx.BadBody("tiktok-error-upload", text, text, value)
	}
	return stillPending, nil
}

func profile(integration *ent.Integration) string {
	if integration == nil || integration.Profile == nil {
		return ""
	}
	return *integration.Profile
}

// photo posts (p_pub_... / p_inbox_...) live under /photo/, TikTok rejects
// /video/ for them
func postURL(integration *ent.Integration, publishID, postID string) string {
	kind := "video"
	if strings.HasPrefix(publishID, "p_") {
		kind = "photo"
	}
	return "https://www.tiktok.com/@" + profile(integration) + "/" + kind + "/" + postID
}

// TikTok returns publicaly_available_post_id as an int64, which JSON.parse
// rounds past 2^53 - pull the digits out of the raw body before parsing.
var publicPostIDPattern = regexp.MustCompile(`"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)`)

func parsePublicPostID(raw []byte) string {
	if m := publicPostIDPattern.FindSubmatch(raw); m != nil {
		return string(m[1])
	}
	return ""
}

// UPLOAD does not publish - it only drops the media into the user's TikTok
// inbox - so only an explicit UPLOAD selects it. A missing value (drafts, or
// any caller that skipped the setting) publishes instead of silently landing
// in the inbox.
func contentPostingMethod(s *TikTokDTO) string {
	if s.ContentPostingMethod != nil && *s.ContentPostingMethod == "UPLOAD" {
		return "UPLOAD"
	}
	return "DIRECT_POST"
}

func postingMethod(method string, isPhoto bool) string {
	if isPhoto {
		return "/content/init/"
	}
	if method == "UPLOAD" {
		return "/inbox/video/init/"
	}
	return "/video/init/"
}

func firstMedia(post integrations.PostDetails) *integrations.MediaContent {
	if len(post.Media) == 0 {
		return nil
	}
	return &post.Media[0]
}

func mediaPath(post integrations.PostDetails) string {
	if m := firstMedia(post); m != nil {
		return m.Path
	}
	return ""
}

// sliceRunes is String.prototype.slice(0, n).
func sliceRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func buildPostInfoBody(post integrations.PostDetails, s *TikTokDTO) map[string]any {
	isPhoto := !helpers.HasExtension(mediaPath(post), "mp4")
	info := map[string]any{}
	if isPhoto && s.Title != "" {
		info["title"] = s.Title
	}
	if !isPhoto && post.Message != "" {
		info["title"] = post.Message
	}
	if isPhoto {
		info["description"] = post.Message
	}
	if contentPostingMethod(s) != "DIRECT_POST" {
		return map[string]any{"post_info": info}
	}

	if isPhoto && s.Title != "" {
		info["title"] = sliceRunes(s.Title, 90)
	}
	privacy := "PUBLIC_TO_EVERYONE"
	if s.PrivacyLevel != nil && *s.PrivacyLevel != "" {
		privacy = *s.PrivacyLevel
	}
	info["privacy_level"] = privacy
	info["disable_comment"] = !integrations.AssetBoolean(s.Comment)
	info["brand_content_toggle"] = integrations.AssetBoolean(s.BrandContentToggle)
	info["brand_organic_toggle"] = integrations.AssetBoolean(s.BrandOrganicToggle)
	if isPhoto {
		info["auto_add_music"] = s.AutoAddMusic != nil && *s.AutoAddMusic == "yes"
	} else {
		info["disable_duet"] = !integrations.AssetBoolean(s.Duet)
		info["disable_stitch"] = !integrations.AssetBoolean(s.Stitch)
		info["is_aigc"] = integrations.AssetBoolean(s.VideoMadeWithAI)
		if m := firstMedia(post); m != nil && m.ThumbnailTimestamp != nil {
			info["video_cover_timestamp_ms"] = *m.ThumbnailTimestamp
		}
	}
	return map[string]any{"post_info": info}
}

// ChunkPlan returns TikTok's chunk_size and total_chunk_count for a video.
func ChunkPlan(videoSize int64) (size, count int64) {
	if videoSize <= maxSingleChunk {
		return videoSize, 1
	}
	return chunkSize, videoSize / chunkSize
}

// chunkStream returns a streaming body for the [start, end] byte range of the
// media so we never hold the whole file in memory: a ranged GET for remote
// URLs, a ranged read for local files.
func chunkStream(ctx context.Context, path string, start, end int64) (io.ReadCloser, error) {
	if strings.HasPrefix(path, "http") {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
		if err != nil {
			return nil, err
		}
		// identity encoding so the store keeps content-length and can answer
		// with the requested range, matching every other media read
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
		req.Header.Set("Accept-Encoding", "identity")
		res, err := ssrf.Client().Do(req)
		if err != nil {
			return nil, err
		}
		// A store that ignores Range (200 with the full file) or answers with an
		// error page would corrupt the upload at this offset.
		if res.StatusCode != http.StatusPartialContent {
			res.Body.Close()
			return nil, temporalx.BadBody("tiktok-error-upload", "{}", "{}", "The media storage did not return the requested byte range, please try again")
		}
		return res.Body, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return struct {
		io.Reader
		io.Closer
	}{io.NewSectionReader(f, start, end-start+1), f}, nil
}

// uploadVideoBytes streams the video bytes to the upload_url returned by the
// init call. It does not go through Fetch because chunked uploads answer with
// 206 (Partial Content), which Fetch would treat as an error.
func (p *Provider) uploadVideoBytes(ctx context.Context, uploadURL, path string, videoSize int64, contentType string) error {
	size, count := ChunkPlan(videoSize)
	for i := int64(0); i < count; i++ {
		start := i * size
		end := start + size - 1
		if i == count-1 {
			end = videoSize - 1
		}
		if err := uploadChunk(ctx, uploadURL, path, start, end, videoSize, contentType); err != nil {
			return err
		}
	}
	return nil
}

func uploadChunk(ctx context.Context, uploadURL, path string, start, end, videoSize int64, contentType string) error {
	body, err := chunkStream(ctx, path, start, end)
	if err != nil {
		return err
	}
	defer body.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, body)
	if err != nil {
		return err
	}
	req.ContentLength = end - start + 1
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, videoSize))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == 200 || res.StatusCode == 201 || res.StatusCode == 206 {
		return nil
	}
	text := "{}"
	if data, err := io.ReadAll(res.Body); err == nil {
		text = string(data)
	}
	value := "Failed to upload the video to TikTok"
	if handled := handleErrors(text, res.StatusCode); handled != nil && handled.Value != "" {
		value = handled.Value
	}
	return temporalx.BadBody("tiktok-error-upload", text, text, value)
}

func buildSourceInfoBody(post integrations.PostDetails, s *TikTokDTO, videoSize int64) map[string]any {
	// TikTok photo posts only support PULL_FROM_URL, there is no FILE_UPLOAD
	// path for photos, so this branch keeps pulling from the URL.
	if !helpers.HasExtension(mediaPath(post), "mp4") {
		mode := "MEDIA_UPLOAD"
		if contentPostingMethod(s) == "DIRECT_POST" {
			mode = "DIRECT_POST"
		}
		source := map[string]any{"source": "PULL_FROM_URL", "photo_cover_index": 0}
		if post.Media != nil {
			images := make([]string, 0, len(post.Media))
			for _, m := range post.Media {
				images = append(images, m.Path)
			}
			source["photo_images"] = images
		}
		return map[string]any{"post_mode": mode, "media_type": "PHOTO", "source_info": source}
	}
	// Videos are streamed from the signed URL: TikTok can pull only from a
	// verified domain, and a presigned R2 URL lives on the R2 API host.
	size, count := ChunkPlan(videoSize)
	return map[string]any{"source_info": map[string]any{
		"source":            "FILE_UPLOAD",
		"video_size":        videoSize,
		"chunk_size":        size,
		"total_chunk_count": count,
	}}
}

func decodeSettings(raw json.RawMessage) *TikTokDTO {
	s := &TikTokDTO{}
	// Unmarshal keeps filling the other fields past a type mismatch, the
	// closest equivalent of reading the untyped settings object.
	_ = json.Unmarshal(raw, s)
	return s
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, errors.New("tiktok: no post to publish")
	}
	firstPost := posts[0]
	settings := decodeSettings(firstPost.Settings)
	isPhoto := !helpers.HasExtension(mediaPath(firstPost), "mp4")
	videoPath := mediaPath(firstPost)

	// For videos we only need the total size up front (HEAD / stat) so we can
	// init the upload; the bytes themselves are streamed later, never fully
	// loaded into memory.
	var videoSize int64
	if !isPhoto {
		size, err := p.MediaSize(ctx, videoPath, "tiktok-error-upload")
		if err != nil {
			return nil, err
		}
		videoSize = size
	}

	body := buildPostInfoBody(firstPost, settings)
	for k, v := range buildSourceInfoBody(firstPost, settings, videoSize) {
		body[k] = v
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/v2/post/publish"+postingMethod(contentPostingMethod(settings), isPhoto), bytes.NewReader(payload))
	if err != nil {
		return nil, errors.New("TikTok publish request is unavailable")
	}
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("Authorization", "Bearer "+accessToken)
	// An init response can be lost after TikTok accepts it. Never repeat this mutation.
	res, err := integrations.Do(request)
	if err != nil {
		var rejected *integrations.ResponseError
		if errors.As(err, &rejected) && rejected.Status == http.StatusUnauthorized {
			return nil, temporalx.RefreshToken("tiktok", "{}", "{}", "TikTok credentials must be refreshed")
		}
		if errors.As(err, &rejected) && rejected.Status >= 400 && rejected.Status < 500 && rejected.Status != 408 {
			var response struct {
				Error struct{ Code string } `json:"error"`
			}
			if json.Unmarshal(rejected.Body, &response) == nil {
				for _, rule := range errorRules {
					if response.Error.Code == rule.needle {
						// Only fixed codes are safe: provider messages can echo credentials or signed URLs.
						slog.WarnContext(ctx, "TikTok rejected publication", "provider_error_code", rule.needle)
						return nil, temporalx.PublicationRejected("tiktok", rule.value)
					}
				}
			}
			return nil, temporalx.PublicationRejected("tiktok", "TikTok rejected the publish request; check the account grant and verified media domain")
		}
		return nil, temporalx.UnknownDelivery("tiktok", "TikTok publish acceptance is unknown; reconcile before resending")
	}
	var init struct {
		Data *struct {
			PublishID string `json:"publish_id"`
			UploadURL string `json:"upload_url"`
		} `json:"data"`
	}
	if err := res.JSON(&init); err != nil {
		return nil, err
	}
	if init.Data == nil || init.Data.PublishID == "" {
		return nil, temporalx.UnknownDelivery("tiktok", "TikTok returned no publish identity; reconcile before resending")
	}

	// Videos: stream the bytes to the upload_url returned by the init call.
	if !isPhoto && init.Data.UploadURL != "" && videoSize > 0 {
		err := p.uploadVideoBytes(ctx, init.Data.UploadURL, videoPath, videoSize, "video/mp4")
		// An explicit rejection from TikTok: the post won't publish, fail it.
		// A network error here is ambiguous - TikTok may have received all the
		// bytes and still publish. Return pending and let checkPostStatus
		// deliver TikTok's own verdict instead of letting the caller retry the
		// publish.
		if kind := temporalx.FailureType(err); kind == temporalx.TypeBadBody || kind == temporalx.TypeRateLimited {
			return nil, err
		}
	}

	// The publish is now irreversible on TikTok's side: return `pending` so the
	// workflow polls checkPostStatus instead of blocking (and possibly timing
	// out and re-posting) inside this activity.
	pending, _ := json.Marshal(pendingData{PublishID: init.Data.PublishID})
	return []integrations.PostResponse{{
		ID:          firstPost.ID,
		Status:      "pending",
		PendingData: pending,
	}}, nil
}

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that still run (scheduled posts sleep inside them until publish time) and
// don't know how to resolve a `pending` response - they keep polling inside
// the activity exactly like before.
func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	responses, err := p.PostPending(ctx, id, accessToken, posts, integration)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	started := time.Now()
	for range 27 { // ~9 minutes at 20s interval
		check, err := p.CheckPostStatus(ctx, accessToken, response.PendingData, integration)
		if err != nil {
			return nil, temporalx.UnknownDelivery("tiktok", "TikTok accepted the request but its result could not be confirmed")
		}
		if check.Status == "completed" {
			return []integrations.PostResponse{{
				ID:         response.ID,
				ReleaseURL: check.ReleaseURL,
				PostID:     check.PostID,
				Status:     "success",
			}}, nil
		}
		// Cap below the 10-minute activity timeout of the old workflows using
		// this method: failing here (non-retryable) is safe, timing the activity
		// out is not - a retried activity would publish the post again.
		if time.Since(started) > 8*time.Minute {
			break
		}
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return nil, temporalx.UnknownDelivery("tiktok", "TikTok accepted the request but confirmation was interrupted")
		}
	}
	return nil, temporalx.UnknownDelivery("tiktok", "TikTok accepted the request but its final receipt is not available")
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	result, err := p.analytics(ctx, accessToken)
	if err != nil {
		slog.Error("Error fetching TikTok analytics:", "err", err)
		return []integrations.AnalyticsData{}, nil
	}
	return result, nil
}

func (p *Provider) analytics(ctx context.Context, accessToken string) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")
	result := []integrations.AnalyticsData{}

	// Get user stats (follower_count, following_count, likes_count, video_count)
	var userStatsData map[string]any
	if err := plainFetch(ctx, http.MethodGet, apiURL+"/v2/user/info/?fields=follower_count,following_count,likes_count,video_count",
		map[string]string{"Authorization": "Bearer " + accessToken}, nil, &userStatsData); err != nil {
		return nil, err
	}
	if userStats, ok := field(userStatsData, "data", "user").(map[string]any); ok {
		result = appendPresent(result, userStats, today, "follower_count", "Followers", "following_count", "Following", "likes_count", "Total Likes", "video_count", "Videos")
	}

	// Get recent videos and aggregate their stats
	headers := map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + accessToken}
	var videoListData map[string]any
	if err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/video/list/?fields=id", headers, []byte(`{"max_count":20}`), &videoListData); err != nil {
		return nil, err
	}
	videos, _ := field(videoListData, "data", "videos").([]any)
	if len(videos) == 0 {
		return result, nil
	}
	videoIDs := make([]any, 0, len(videos))
	for _, v := range videos {
		videoIDs = append(videoIDs, field(v, "id"))
	}

	// Query video details to get engagement metrics
	query, _ := json.Marshal(map[string]any{"filters": map[string]any{"video_ids": videoIDs}})
	var videoQueryData map[string]any
	if err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count", headers, query, &videoQueryData); err != nil {
		return nil, err
	}
	details, _ := field(videoQueryData, "data", "videos").([]any)
	if len(details) == 0 {
		return result, nil
	}
	var views, likes, comments, shares float64
	for _, video := range details {
		views += number(field(video, "view_count"))
		likes += number(field(video, "like_count"))
		comments += number(field(video, "comment_count"))
		shares += number(field(video, "share_count"))
	}
	return append(result,
		stat("Views", views, today),
		stat("Recent Likes", likes, today),
		stat("Recent Comments", comments, today),
		stat("Recent Shares", shares, today),
	), nil
}

func (p *Provider) Missing(ctx context.Context, id, accessToken string) ([]integrations.MissingPost, error) {
	out := []integrations.MissingPost{}
	res, err := p.Fetch(ctx, apiURL+"/v2/video/list/?fields=id,cover_image_url,title", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + accessToken},
		Body:    []byte(`{"max_count":20}`),
	})
	var data map[string]any
	if err == nil {
		err = res.JSON(&data)
	}
	if err != nil {
		slog.Error("Error fetching TikTok missing content:", "err", err)
		return out, nil
	}
	videos, _ := field(data, "data", "videos").([]any)
	for _, v := range videos {
		coverURL, _ := field(v, "cover_image_url").(string)
		out = append(out, integrations.MissingPost{ID: jsString(field(v, "id")), URL: coverURL})
	}
	return out, nil
}

// ResolveReleaseID: posts published before moderation finished keep their
// publish_id (v_pub_file~... / p_pub_url~...) as releaseId - resolve it to the
// post id.
func (p *Provider) ResolveReleaseID(ctx context.Context, accessToken, releaseID string, integration *ent.Integration, settings json.RawMessage, releaseURL string) (*integrations.ReleaseIDResolution, error) {
	// a draft sent to the inbox (UPLOAD) is stored as 'missing' with its
	// publish id in the URL fragment
	draft := releaseID == "missing"
	publishID := releaseID
	if draft {
		publishID = ""
		if parts := strings.Split(releaseURL, "#"); len(parts) > 1 {
			publishID = parts[1]
		}
	}
	if !strings.Contains(publishID, "_pub_") && !strings.Contains(publishID, "_inbox_") {
		return nil, nil
	}

	// TikTok only gives a post id to posts published for public viewership
	// (a draft ignores the privacy setting, the user picks it in the app)
	if !draft && privateLevel(settings) {
		return &integrations.ReleaseIDResolution{Unavailable: true}, nil
	}

	res, err := p.statusFetch(ctx, accessToken, publishID)
	if err != nil {
		return nil, err
	}
	if !json.Valid(res.Body) {
		return nil, errors.New("tiktok: invalid publish status response")
	}
	publicPostID := parsePublicPostID(res.Body)
	if publicPostID == "" {
		// a draft with no public post (not published yet, or published as
		// non-public) keeps opening the inbox instead of asking to retry
		if draft {
			return nil, nil
		}
		return &integrations.ReleaseIDResolution{Pending: true}, nil
	}
	return &integrations.ReleaseIDResolution{
		PostID:     publicPostID,
		ReleaseURL: postURL(integration, publishID, publicPostID),
	}, nil
}

func privateLevel(settings json.RawMessage) bool {
	var s struct {
		PrivacyLevel any `json:"privacy_level"`
	}
	_ = json.Unmarshal(settings, &s)
	return s.PrivacyLevel == "SELF_ONLY" || s.PrivacyLevel == "MUTUAL_FOLLOW_FRIENDS"
}

func (p *Provider) ReleaseURL(ctx context.Context, accessToken, releaseID string, _ *ent.Integration) (string, error) {
	body, _ := json.Marshal(map[string]any{"filters": map[string]any{"video_ids": []string{releaseID}}})
	res, err := p.Fetch(ctx, apiURL+"/v2/video/query/?fields=id,share_url", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + accessToken},
		Body:    body,
	})
	if err != nil {
		return "", err
	}
	var data map[string]any
	if err := res.JSON(&data); err != nil {
		return "", err
	}
	videos, _ := field(data, "data", "videos").([]any)
	if len(videos) == 0 {
		return "", nil
	}
	// share_url carries tracking params (the app's client key among them)
	shareURL, _ := field(videos[0], "share_url").(string)
	return strings.Split(shareURL, "?")[0], nil
}

func (p *Provider) PostAnalytics(ctx context.Context, integrationID, accessToken, postID string, fromDate int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")
	// Query video details using the video ID
	body, _ := json.Marshal(map[string]any{"filters": map[string]any{"video_ids": []string{postID}}})
	var data map[string]any
	if err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count",
		map[string]string{"Content-Type": "application/json", "Authorization": "Bearer " + accessToken}, body, &data); err != nil {
		slog.Error("Error fetching TikTok post analytics:", "err", err)
		return []integrations.AnalyticsData{}, nil
	}
	videos, _ := field(data, "data", "videos").([]any)
	if len(videos) == 0 {
		return []integrations.AnalyticsData{}, nil
	}
	video, _ := videos[0].(map[string]any)
	if video == nil {
		return []integrations.AnalyticsData{}, nil
	}
	return appendPresent([]integrations.AnalyticsData{}, video, today,
		"view_count", "Views", "like_count", "Likes", "comment_count", "Comments", "share_count", "Shares"), nil
}

// appendPresent adds one stat per (key, label) pair whose key is present
// (`!== undefined`) in source.
func appendPresent(result []integrations.AnalyticsData, source map[string]any, today string, pairs ...string) []integrations.AnalyticsData {
	for i := 0; i+1 < len(pairs); i += 2 {
		if v, ok := source[pairs[i]]; ok {
			result = append(result, integrations.AnalyticsData{
				Label: pairs[i+1],
				Data:  []integrations.AnalyticsItem{{Total: jsString(v), Date: today}},
			})
		}
	}
	return result
}

func stat(label string, total float64, today string) integrations.AnalyticsData {
	return integrations.AnalyticsData{Label: label, Data: []integrations.AnalyticsItem{{Total: jsString(total), Date: today}}}
}

// field walks nested JSON objects (TypeScript's `a?.b?.c`).
func field(v any, keys ...string) any {
	for _, k := range keys {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

// number is `value || 0` for a JSON number.
func number(v any) float64 {
	n, _ := v.(float64)
	return n
}

// jsString is JavaScript's String(value) for decoded JSON values.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprint(v)
}

// compact is JSON.stringify(JSON.parse(body)) without reordering keys.
func compact(body []byte) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, body); err != nil {
		return string(body)
	}
	return buf.String()
}

// CreatorInfo fetches the current account choices before a creator reviews or sends a video.
func (p *Provider) CreatorInfo(ctx context.Context, token string) (*postoptions.TikTokCreator, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var reply struct {
		Data *struct {
			Nickname        string   `json:"creator_nickname"`
			PrivacyLevels   []string `json:"privacy_level_options"`
			MaxDuration     int      `json:"max_video_post_duration_sec"`
			CommentDisabled bool     `json:"comment_disabled"`
			DuetDisabled    bool     `json:"duet_disabled"`
			StitchDisabled  bool     `json:"stitch_disabled"`
		} `json:"data"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := plainFetch(ctx, http.MethodPost, apiURL+"/v2/post/publish/creator_info/query/", map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json"}, nil, &reply); err != nil {
		return nil, errors.New("TikTok creator information is unavailable")
	}
	if reply.Error.Code != "ok" || reply.Data == nil || reply.Data.Nickname == "" || reply.Data.MaxDuration <= 0 || len(reply.Data.PrivacyLevels) == 0 {
		return nil, errors.New("TikTok has not granted publishing access for this account")
	}
	d := reply.Data
	return &postoptions.TikTokCreator{Nickname: d.Nickname, PrivacyLevels: d.PrivacyLevels, MaxDurationSeconds: d.MaxDuration, CommentDisabled: d.CommentDisabled, DuetDisabled: d.DuetDisabled, StitchDisabled: d.StitchDisabled}, nil
}
