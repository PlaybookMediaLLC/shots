// Package tiktokbusiness is the TikTok Business provider
// (the TikTok Business API v1.3 app). Settings reuse tiktok.TikTokDTO.
package tiktokbusiness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/tiktok"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

// baseURL is the Business API root; tests point it at an httptest.Server.
var baseURL = "https://business-api.tiktok.com/open_api/v1.3"

// pollInterval is the legacy blocking post's wait between status checks.
var pollInterval = 20 * time.Second

var rules = strings.Join([]string{
	"TikTok Business can have one video or one picture or multiple pictures (up to 35), it cannot be without an attachment.",
	"content_posting_method=DIRECT_POST publishes the post to the account. content_posting_method=UPLOAD does NOT publish: it only saves the media as a draft in the user inbox of the TikTok app, where the user must manually complete and publish it. Use DIRECT_POST unless the user explicitly asks to review or edit the post inside the TikTok app first.",
	"With content_posting_method=UPLOAD, TikTok ignores every setting except the title / post content. Never tell the user that video_made_with_ai, privacy_level, duet, stitch, comment, autoAddMusic, brand_content_toggle or brand_organic_toggle will be applied in UPLOAD mode - they are silently discarded. If the user asks for any of those settings, tell them it requires DIRECT_POST.",
	"video_made_with_ai, duet and stitch apply to video posts only. privacy_level and autoAddMusic apply to photo posts only - the TikTok Business API has no privacy field for video posts, so those settings are discarded when the attachment is a video.",
	"The music setting attaches a commercial music library track (found via the musicSearch function) to a video or photo post, and the location setting tags the post with a location (found via the locationSearch function). Both apply only with content_posting_method=DIRECT_POST. music.audio_volume / music.video_volume (0-100, default 50) apply to video posts only. For photos, autoAddMusic=yes attaches a RANDOM commercial music library track and overrides any music selection - use autoAddMusic=no when the user wants a specific track.",
	"Media is pulled by TikTok from its URL, so the media must be upload to Shots and the media domain must be a verified URL property of the TikTok Business app.",
}, " ")

var scopes = []string{
	"user.info.basic",
	"user.info.username",
	"user.info.stats",
	"video.list",
	"video.upload",
	"video.publish",
}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase("tiktok-business", handleErrors)}
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
		Identifier:       "tiktok-business",
		Name:             "TikTok",
		Editor:           "normal",
		Scopes:           scopes,
		ConvertToJPEG:    true,
		MaxConcurrentJob: 10000,
		Rules:            rules,
	}
}

// MaxLength is the Business API caption limit for videos (photos allow 4,000).
func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2200 }

func (p *Provider) SettingsDTO() any { return &tiktok.TikTokDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"musicSearch": func(ctx context.Context, accessToken string, data json.RawMessage, internalID string, _ *ent.Integration) (any, error) {
			var input MusicSearchInput
			_ = json.Unmarshal(data, &input)
			return p.MusicSearch(ctx, accessToken, input, internalID)
		},
		"locationSearch": func(ctx context.Context, accessToken string, data json.RawMessage, internalID string, _ *ent.Integration) (any, error) {
			var input LocationSearchInput
			_ = json.Unmarshal(data, &input)
			return p.LocationSearch(ctx, accessToken, input, internalID)
		},
	}
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{
		{
			MethodName:  "musicSearch",
			Description: `Load commercial music library tracks that can be attached to a post via the "music" setting`,
			DataSchema: []integrations.ToolField{{
				Key:         "genre",
				Type:        "string",
				Description: "Genre to filter the tracks by (for example POP, ROCK, ELECTRONIC), leave empty for all genres",
			}},
		},
		{
			MethodName:  "locationSearch",
			Description: `Search location tags that can be attached to a post via the "location" setting`,
			DataSchema: []integrations.ToolField{{
				Key:         "q",
				Type:        "string",
				Description: "Search query for the location",
			}},
		},
	}
}

// The TikTok developer portal only accepts redirect URLs that end with "/"
// for Business apps, so the trailing slash here is not cosmetic - the
// redirect_uri sent on the token exchange must match the registered one.
func redirectURI() string {
	frontend := os.Getenv("FRONTEND_URL")
	prefix := ""
	if frontend != "" && !strings.Contains(frontend, "https") {
		prefix = "https://redirectmeto.com/"
	}
	return prefix + frontend + "/integrations/social/tiktok-business/"
}

func encodeURIComponent(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func jsonParam(v any) string {
	data, _ := json.Marshal(v)
	return encodeURIComponent(string(data))
}

func (p *Provider) CheckValidity(_ context.Context, items [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
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
	if len(firstItems) > 35 {
		return "You can select up to 35 pictures", nil
	}
	return "", nil
}

type errorRule struct{ needle, kind, value string }

const tokenInvalid = "Access token invalid, please re-authenticate your TikTok account"
const rateLimited = "TikTok API rate limit exceeded, please try again later"

var errorRules = []errorRule{
	// Authentication/Authorization errors - require re-authentication.
	// The Business API answers HTTP 200 with a non-zero `code`, so token
	// problems are detected from the body, not the status code.
	{"access_token_invalid", "refresh-token", tokenInvalid},
	{"Access token is incorrect", "refresh-token", tokenInvalid},
	{"Access token has expired", "refresh-token", tokenInvalid},
	{"auth_removed", "refresh-token", tokenInvalid},
	// Rate limiting errors
	{"rate_limit_exceeded", "bad-body", rateLimited},
	{"Too many requests", "bad-body", rateLimited},
	{"file_format_check_failed", "bad-body", "File format is invalid, please check video specifications"},
	{"duration_check_failed", "bad-body", "Video duration is invalid, please check video specifications"},
	{"frame_rate_check_failed", "bad-body", "Video frame rate is invalid, please check video specifications"},
	{"video_pull_failed", "bad-body", "Failed to pull video from URL, please check the URL"},
	{"photo_pull_failed", "bad-body", "Failed to pull photo from URL, please check the URL"},
	{"spam_risk_user_banned_from_posting", "bad-body", "Account banned from posting, please check TikTok account status"},
	{"spam_risk_text", "bad-body", "TikTok detected potential spam in the post text"},
	{"spam_risk_too_many_posts", "bad-body", "TikTok says your daily post limit reached, please try again tomorrow"},
	{"spam_risk", "bad-body", "TikTok detected potential spam"},
	// Unlike the legacy app there is no migration target configured for this
	// provider, so the cap stays a failed post (re-connecting cannot reset a
	// daily quota) - if this app is ever migrated too, switch to 'disconnect'.
	{"reached_active_user_cap", "bad-body", "TikTok daily user limit reached, please try again tomorrow"},
	{"url_ownership_unverified", "bad-body", "The media domain is not a verified URL property of the TikTok app"},
	{"publish_cancelled", "bad-body", "TikTok cancelled the upload, please try again"},
	{"picture_size_check_failed", "bad-body", "Video must be at least 360p, Picture must not exceed 1080x1920"},
	// Content/Format validation errors
	{"invalid_params", "bad-body", "Invalid request parameters, please check content format"},
	// Server errors
	{"internal", "bad-body", "There is a problem with TikTok servers, please try again later"},
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

func handledValue(text string) string {
	if h := handleErrors(text, 200); h != nil {
		return h.Value
	}
	return ""
}

// envelope is the Business API {code, message, data} wrapper. Raw keeps the
// compacted body for error details (JSON.stringify of the parsed response).
type envelope struct {
	Code    *float64       `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data"`
	Raw     string         `json:"-"`
}

func (e *envelope) ok() bool { return e.Code != nil && *e.Code == 0 }

func parseEnvelope(body []byte) (*envelope, error) {
	var env envelope
	// a non-object `data` must not fail the parse, only the fields we read
	var loose struct {
		Code    *float64        `json:"code"`
		Message any             `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &loose); err != nil {
		return nil, err
	}
	env.Code = loose.Code
	env.Message, _ = loose.Message.(string)
	_ = json.Unmarshal(loose.Data, &env.Data)
	var buf bytes.Buffer
	if json.Compact(&buf, body) == nil {
		env.Raw = buf.String()
	} else {
		env.Raw = string(body)
	}
	return &env, nil
}

// get is this.fetch GET with the Business `Access-Token` header.
func (p *Provider) get(ctx context.Context, target, accessToken string) (*integrations.Response, error) {
	return p.Fetch(ctx, target, integrations.Request{
		Method:  http.MethodGet,
		Headers: map[string]string{"Access-Token": accessToken},
	})
}

func (p *Provider) getEnvelope(ctx context.Context, target, accessToken string) (*envelope, error) {
	res, err := p.get(ctx, target, accessToken)
	if err != nil {
		return nil, err
	}
	return parseEnvelope(res.Body)
}

// throwIfTokenError surfaces token/disconnect classifications of a non-zero
// code; anything else is left to the caller.
func throwIfTokenError(env *envelope) error {
	if env.ok() {
		return nil
	}
	h := handleErrors(env.Raw, 200)
	if h != nil && h.Type == "refresh-token" {
		return temporalx.RefreshToken("tiktok-business", env.Raw, "{}", h.Value)
	}
	if h != nil && h.Type == "disconnect" {
		return temporalx.Disconnect("tiktok-business", env.Raw, "{}", h.Value)
	}
	return nil
}

// fallback is TypeScript's `a || b || c` over strings.
func fallback(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

type userInformation struct {
	DisplayName  string
	ProfileImage string
	Username     string
}

// Every Business API endpoint (except OAuth) authenticates with the
// `Access-Token` header and wraps the payload in {code, message, data} -
// errors come back as HTTP 200 with a non-zero code.
func (p *Provider) fetchUserInformation(ctx context.Context, accessToken, businessID string) (*userInformation, error) {
	information, err := p.getEnvelope(ctx, baseURL+"/business/get/?business_id="+encodeURIComponent(businessID)+
		"&fields="+jsonParam([]string{"username", "display_name", "profile_image"}), accessToken)
	if err != nil {
		return nil, err
	}
	// A non-zero code arrives as HTTP 200: without this check the auth flow
	// would "succeed" with an undefined name/picture/profile and create a
	// broken channel.
	if !information.ok() {
		return nil, temporalx.BadBody("tiktok-business", information.Raw, "{}",
			fallback(handledValue(information.Raw), information.Message, "Could not load the TikTok business account"))
	}
	str := func(k string) string { s, _ := information.Data[k].(string); return s }
	return &userInformation{DisplayName: str("display_name"), ProfileImage: str("profile_image"), Username: str("username")}, nil
}

// oauth posts to the OAuth endpoints with the global fetch and checks the
// HTTP 200 + non-zero code envelope.
func (p *Provider) oauth(ctx context.Context, path string, payload map[string]string, failure string) (accessToken, refreshToken, openID string, scope any, err error) {
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return "", "", "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return "", "", "", nil, err
	}
	defer res.Body.Close()
	var raw bytes.Buffer
	if _, err := raw.ReadFrom(io.LimitReader(res.Body, 1<<20)); err != nil {
		return "", "", "", nil, err
	}
	response, err := parseEnvelope(raw.Bytes())
	if err != nil {
		return "", "", "", nil, err
	}
	accessToken, _ = response.Data["access_token"].(string)
	if !response.ok() || accessToken == "" {
		return "", "", "", nil, temporalx.BadBody("tiktok-business", response.Raw, "{}",
			fallback(handledValue(response.Raw), response.Message, failure))
	}
	refreshToken, _ = response.Data["refresh_token"].(string)
	openID, _ = response.Data["open_id"].(string)
	return accessToken, refreshToken, openID, response.Data["scope"], nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	// OAuth failures also arrive as HTTP 200 with a non-zero code and no data.
	accessToken, newRefresh, openID, _, err := p.oauth(ctx, "/tt_user/oauth2/refresh_token/", map[string]string{
		"client_id":     os.Getenv("TIKTOK_BUSINESS_CLIENT_ID"),
		"client_secret": os.Getenv("TIKTOK_BUSINESS_CLIENT_SECRET"),
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	}, "Could not refresh the TikTok access token")
	if err != nil {
		return nil, err
	}
	user, err := p.fetchUserInformation(ctx, accessToken, openID)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		RefreshToken: newRefresh,
		ExpiresIn:    int64((23 * time.Hour).Seconds()),
		AccessToken:  accessToken,
		// open_id is stored verbatim: it doubles as the business_id parameter of
		// every Business API call, so it must not be normalized.
		ID:       openID,
		Name:     user.DisplayName,
		Picture:  user.ProfileImage,
		Username: user.Username,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(16)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.tiktok.com/v2/auth/authorize/" +
			"?client_key=" + os.Getenv("TIKTOK_BUSINESS_CLIENT_ID") +
			"&redirect_uri=" + encodeURIComponent(redirectURI()) +
			"&state=" + state +
			"&response_type=code" +
			"&disable_auto_auth=1" +
			"&scope=" + encodeURIComponent(strings.Join(scopes, ",")),
		CodeVerifier: state,
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	// Same HTTP 200 + non-zero code envelope as the refresh call: an expired
	// auth_code or mismatched redirect_uri must surface TikTok's reason.
	accessToken, refreshToken, openID, scope, err := p.oauth(ctx, "/tt_user/oauth2/token/", map[string]string{
		"client_id":     os.Getenv("TIKTOK_BUSINESS_CLIENT_ID"),
		"client_secret": os.Getenv("TIKTOK_BUSINESS_CLIENT_SECRET"),
		"grant_type":    "authorization_code",
		"auth_code":     params.Code,
		"redirect_uri":  redirectURI(),
	}, "Could not authenticate the TikTok business account")
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, scope); err != nil {
		return nil, err
	}
	user, err := p.fetchUserInformation(ctx, accessToken, openID)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           openID,
		Name:         user.DisplayName,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    int64((23 * time.Hour).Seconds()),
		Picture:      user.ProfileImage,
		Username:     user.Username,
	}, nil
}

type pendingData struct {
	PublishID string `json:"publishId"`
}

func (p *Provider) statusURL(integration *ent.Integration, publishID string) string {
	internalID := ""
	if integration != nil {
		internalID = integration.InternalID
	}
	return baseURL + "/business/publish/status/?business_id=" + encodeURIComponent(internalID) +
		"&publish_id=" + encodeURIComponent(publishID)
}

func isTokenOrDisconnect(err error) bool {
	t := temporalx.FailureType(err)
	return t == temporalx.TypeRefreshToken || t == temporalx.TypeDisconnect
}

// CheckPostStatus is a single status check for a publish_id, no loops and no
// timers: `post` returns a `pending` PostResponse right after the publish
// call, and the post workflow polls this method with durable timers, so a
// stuck/retried check can never re-run the publish and duplicate the post.
func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, integration *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending pendingData
	_ = json.Unmarshal(raw, &pending)
	stillPending := &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}

	res, err := p.get(ctx, p.statusURL(integration, pending.PublishID), accessToken)
	var post *envelope
	if err == nil {
		post, err = parseEnvelope(res.Body)
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

	// Errors arrive as HTTP 200 with a non-zero code, invisible to Fetch: a
	// token error must surface as RefreshToken, anything else is treated as
	// transient and keeps polling (same rationale as above).
	if !post.ok() {
		if err := throwIfTokenError(post); err != nil {
			return nil, err
		}
		return stillPending, nil
	}

	status, _ := post.Data["status"].(string)
	switch status {
	case "SEND_TO_USER_INBOX":
		// the id stays 'missing' until the user publishes the draft - the
		// share id rides in the URL fragment so resolveReleaseId can ask later
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			ReleaseURL: "https://www.tiktok.com/messages?lang=en#" + pending.PublishID,
			PostID:     "missing",
		}, nil
	case "PUBLISH_COMPLETE":
		// post_ids can lag up to 3 minutes behind PUBLISH_COMPLETE, and never
		// shows up at all for non-public posts - fall back to the profile URL
		// and keep the share_id (resolveReleaseId fixes it later).
		publicPostID := parsePublicPostID(res.Body)
		if publicPostID == "" {
			return &integrations.PendingCheckResponse{
				Status:     "completed",
				ReleaseURL: "https://www.tiktok.com/@" + profile(integration),
				PostID:     pending.PublishID,
			}, nil
		}
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			ReleaseURL: postURL(integration, pending.PublishID, publicPostID),
			PostID:     publicPostID,
		}, nil
	case "FAILED":
		reason := ""
		if r := post.Data["reason"]; r != nil && r != "" && r != false && r != float64(0) {
			reason = jsString(r)
		}
		return nil, temporalx.BadBody("tiktok-business-error-upload", post.Raw, post.Raw, handledValue(reason+" "+post.Raw))
	}
	return stillPending, nil
}

// UPLOAD does not publish - it only drops the media into the user's TikTok
// inbox as a draft - so only an explicit UPLOAD selects it. A missing value
// (drafts, or any caller that skipped the setting) publishes instead of
// silently landing in the inbox.
func isDraft(s *tiktok.TikTokDTO) bool {
	return s.ContentPostingMethod != nil && *s.ContentPostingMethod == "UPLOAD"
}

func addLocation(info map[string]any, s *tiktok.TikTokDTO) {
	if s.Location != nil && s.Location.ID != nil && *s.Location.ID != "" {
		info["location_id"] = *s.Location.ID
		if s.Location.Name != nil {
			info["location_name"] = *s.Location.Name
		}
	}
}

// volume is `typeof v !== 'undefined' ? +v : 50`; NaN serializes as null.
func volume(v any) any {
	if v == nil {
		return 50
	}
	n := tiktok.ToNumber(v)
	if n != n {
		return nil
	}
	return n
}

// The Business API is PULL_FROM_URL only: TikTok downloads the media from its
// URL, there is no FILE_UPLOAD / chunked upload variant of these endpoints.
func buildVideoBody(businessID string, post integrations.PostDetails, s *tiktok.TikTokDTO) map[string]any {
	body := map[string]any{"business_id": businessID}
	if len(post.Media) > 0 {
		m := post.Media[0]
		body["video_url"] = m.Path
		if m.Thumbnail != "" {
			body["custom_thumbnail_url"] = m.Thumbnail
		} else if m.ThumbnailTimestamp != nil && *m.ThumbnailTimestamp != 0 {
			body["thumbnail_offset"] = *m.ThumbnailTimestamp
		}
	}
	info := map[string]any{
		// The video endpoint has no privacy_level field - unlike photos,
		// videos publish with the account default.
		"is_brand_organic":   integrations.AssetBoolean(s.BrandOrganicToggle),
		"is_branded_content": integrations.AssetBoolean(s.BrandContentToggle),
	}
	if post.Message != "" {
		info["caption"] = post.Message
	}
	if isDraft(s) {
		info["upload_to_draft"] = true
	} else {
		info["disable_comment"] = !integrations.AssetBoolean(s.Comment)
		info["disable_duet"] = !integrations.AssetBoolean(s.Duet)
		info["disable_stitch"] = !integrations.AssetBoolean(s.Stitch)
		info["is_ai_generated"] = integrations.AssetBoolean(s.VideoMadeWithAI)
		addLocation(info, s)
		// The API defaults both volumes to 0 (muted) - the TikTok app defaults
		// to 50, so a selected track without explicit volumes follows the app
		// behavior instead of publishing a silent post.
		if s.Music != nil && s.Music.ID != nil && *s.Music.ID != "" {
			info["music_sound_info"] = map[string]any{
				"music_sound_id":              *s.Music.ID,
				"music_sound_volume":          volume(s.Music.AudioVolume),
				"video_original_sound_volume": volume(s.Music.VideoVolume),
			}
		}
	}
	body["post_info"] = info
	return body
}

// pickRandomMusicID: autoAddMusic picks a random commercial-library track
// instead of TikTok's auto_add_music flag, so the attached music is chosen by
// the social API rather than silently by TikTok. Returns "" when the trending list is
// empty or unavailable - the photo body then falls back to auto_add_music.
func (p *Provider) pickRandomMusicID(ctx context.Context, accessToken, businessID string) (string, error) {
	tracks, err := p.MusicSearch(ctx, accessToken, MusicSearchInput{}, businessID)
	if err != nil || len(tracks) == 0 {
		return "", err
	}
	return tracks[rand.IntN(len(tracks))].ID, nil
}

func (p *Provider) buildPhotoBody(ctx context.Context, businessID string, post integrations.PostDetails, s *tiktok.TikTokDTO, accessToken string) (map[string]any, error) {
	draft := isDraft(s)
	autoAddMusic := s.AutoAddMusic != nil && *s.AutoAddMusic == "yes"

	// Random music wins over an explicitly selected track: the UI hides the
	// music selector while "add random music" is on, so a stale selection must
	// not silently override it.
	musicID := ""
	if autoAddMusic {
		if !draft {
			id, err := p.pickRandomMusicID(ctx, accessToken, businessID)
			if err != nil {
				return nil, err
			}
			musicID = id
		}
	} else if s.Music != nil && s.Music.ID != nil {
		musicID = *s.Music.ID
	}

	body := map[string]any{"business_id": businessID, "photo_cover_index": 0}
	if post.Media != nil {
		images := make([]string, 0, len(post.Media))
		for _, m := range post.Media {
			images = append(images, m.Path)
		}
		body["photo_images"] = images
	}
	info := map[string]any{
		"is_brand_organic":   integrations.AssetBoolean(s.BrandOrganicToggle),
		"is_branded_content": integrations.AssetBoolean(s.BrandContentToggle),
	}
	if s.Title != "" {
		r := []rune(s.Title)
		info["title"] = string(r[:min(len(r), 90)])
	}
	if post.Message != "" {
		info["caption"] = post.Message
	}
	if draft {
		info["is_draft"] = true
	} else {
		privacy := "PUBLIC_TO_EVERYONE"
		if s.PrivacyLevel != nil && *s.PrivacyLevel != "" {
			privacy = *s.PrivacyLevel
		}
		info["privacy_level"] = privacy
		info["disable_comment"] = !integrations.AssetBoolean(s.Comment)
		// TikTok's own recommended-music flag is only a fallback for when no
		// track could be picked from the trending list.
		info["auto_add_music"] = musicID == "" && autoAddMusic
		addLocation(info, s)
		// Unlike videos, the photo music_sound_info has no volume fields.
		if musicID != "" {
			info["music_sound_info"] = map[string]any{"music_sound_id": musicID}
		}
	}
	body["post_info"] = info
	return body, nil
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, errors.New("tiktok-business: no post to publish")
	}
	firstPost := posts[0]
	settings := &tiktok.TikTokDTO{}
	// Unmarshal keeps filling the other fields past a type mismatch, the
	// closest equivalent of reading the untyped settings object.
	_ = json.Unmarshal(firstPost.Settings, settings)
	path := ""
	if len(firstPost.Media) > 0 {
		path = firstPost.Media[0].Path
	}
	isPhoto := !helpers.HasExtension(path, "mp4")

	var body map[string]any
	endpoint := "/business/video/publish/"
	if isPhoto {
		endpoint = "/business/photo/publish/"
		b, err := p.buildPhotoBody(ctx, id, firstPost, settings, accessToken)
		if err != nil {
			return nil, err
		}
		body = b
	} else {
		body = buildVideoBody(id, firstPost, settings)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	res, err := p.Fetch(ctx, baseURL+endpoint, integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Content-Type": "application/json", "Access-Token": accessToken},
		Body:    payload,
	})
	if err != nil {
		return nil, err
	}
	publish, err := parseEnvelope(res.Body)
	if err != nil {
		return nil, err
	}

	// The Business API reports failures as HTTP 200 with a non-zero code, so
	// Fetch cannot catch them - classify the body here.
	shareID, _ := publish.Data["share_id"].(string)
	if !publish.ok() || shareID == "" {
		h := handleErrors(publish.Raw, 200)
		if h != nil && h.Type == "refresh-token" {
			return nil, temporalx.RefreshToken("tiktok-business", publish.Raw, string(payload), h.Value)
		}
		if h != nil && h.Type == "disconnect" {
			return nil, temporalx.Disconnect("tiktok-business", publish.Raw, string(payload), h.Value)
		}
		return nil, temporalx.BadBody("tiktok-business-error-upload", publish.Raw, string(payload),
			fallback(handledValue(publish.Raw), publish.Message, "TikTok refused the post"))
	}

	// The publish is now irreversible on TikTok's side: return `pending` so the
	// workflow polls checkPostStatus instead of blocking (and possibly timing
	// out and re-posting) inside this activity.
	pending, _ := json.Marshal(pendingData{PublishID: shareID})
	return []integrations.PostResponse{{
		ID:          firstPost.ID,
		Status:      "pending",
		PendingData: pending,
	}}, nil
}

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that still run and don't know how to resolve a `pending` response - they
// keep polling inside the activity exactly like before.
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
			return nil, err
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
			return nil, err
		}
	}
	return nil, temporalx.BadBody("tiktok-business-error-upload", "{}", "{}", "TikTok refused to publish your post")
}

type MusicSearchInput struct {
	Genre string `json:"genre"`
}

type MusicTrack struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Artist     string  `json:"artist"`
	Image      string  `json:"image"`
	Duration   float64 `json:"duration"`
	PreviewURL string  `json:"previewUrl"`
}

// MusicSearch: the trending list has no text search parameter - genre /
// country / date range are the only filters - so the UI filters the returned
// list locally.
func (p *Provider) MusicSearch(ctx context.Context, accessToken string, data MusicSearchInput, id string) ([]MusicTrack, error) {
	target := baseURL + "/discovery/cml/trending_list/?business_id=" + encodeURIComponent(id)
	if data.Genre != "" {
		target += "&genre=" + encodeURIComponent(data.Genre)
	}
	music, err := p.getEnvelope(ctx, target, accessToken)
	if err != nil {
		return nil, err
	}
	// Errors arrive as HTTP 200 with a non-zero code, invisible to Fetch: a
	// token error must surface as RefreshToken so the function endpoint
	// refreshes and retries, anything else just returns no tracks.
	tracks := []MusicTrack{}
	if !music.ok() {
		if h := handleErrors(music.Raw, 200); h != nil && h.Type == "refresh-token" {
			return nil, temporalx.RefreshToken("tiktok-business", music.Raw, "{}", h.Value)
		}
		return tracks, nil
	}
	list, _ := music.Data["list"].([]any)
	for _, track := range list {
		str := func(keys ...string) string { s, _ := field(track, keys...).(string); return s }
		// music_sound_id only accepts a song_clip_id: the publish endpoints
		// reject a commercial_music_id with the generic 51065 "Something is
		// wrong" error (verified against the live API). Chart tracks sometimes
		// have no full_duration_song_clip - their 30-day trending clip is the
		// only publishable id (tracks with neither are filtered out below).
		id := fallback(str("full_duration_song_clip", "song_clip_id"), str("trending_song_clip", "song_clip_id"))
		if id == "" {
			continue
		}
		duration := number(field(track, "duration"))
		if duration == 0 {
			duration = number(field(track, "trending_song_clip", "duration"))
		}
		tracks = append(tracks, MusicTrack{
			ID:         id,
			Title:      str("commercial_music_name"),
			Artist:     str("artist"),
			Image:      str("thumbnail_url"),
			Duration:   duration * 1000,
			PreviewURL: fallback(str("preview_url"), str("trending_song_clip", "preview_url")),
		})
	}
	return tracks, nil
}

type LocationSearchInput struct {
	Q string `json:"q"`
}

type LocationResult struct {
	ID      any    `json:"id,omitempty"`
	Name    string `json:"name"`
	Address string `json:"address"`
}

func (p *Provider) LocationSearch(ctx context.Context, accessToken string, data LocationSearchInput, id string) ([]LocationResult, error) {
	out := []LocationResult{}
	if data.Q == "" {
		return out, nil
	}
	q := []rune(data.Q)
	locations, err := p.getEnvelope(ctx, baseURL+"/business/publish/location/?business_id="+encodeURIComponent(id)+
		"&search_query="+encodeURIComponent(string(q[:min(len(q), 100)])), accessToken)
	if err != nil {
		return nil, err
	}
	// Same HTTP 200 + non-zero code envelope as musicSearch.
	if !locations.ok() {
		if h := handleErrors(locations.Raw, 200); h != nil && h.Type == "refresh-token" {
			return nil, temporalx.RefreshToken("tiktok-business", locations.Raw, "{}", h.Value)
		}
		return out, nil
	}
	list, _ := locations.Data["locations"].([]any)
	for _, location := range list {
		name, _ := field(location, "location_name").(string)
		address, _ := field(location, "location_address").(string)
		out = append(out, LocationResult{ID: field(location, "location_id"), Name: name, Address: address})
	}
	return out, nil
}

func (p *Provider) loadVideoList(ctx context.Context, accessToken, businessID string, fields []string) ([]any, error) {
	videoListData, err := p.getEnvelope(ctx, baseURL+"/business/video/list/?business_id="+encodeURIComponent(businessID)+
		"&fields="+jsonParam(fields)+"&max_count=20", accessToken)
	if err != nil {
		return nil, err
	}
	// Same HTTP 200 + non-zero code envelope: a token error must surface as
	// RefreshToken so the analytics/missing callers refresh and retry instead
	// of silently showing empty data until the user reconnects.
	if err := throwIfTokenError(videoListData); err != nil {
		return nil, err
	}
	videos, _ := videoListData.Data["videos"].([]any)
	return videos, nil
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

// post_ids holds int64 ids that exceed Number.MAX_SAFE_INTEGER, so the id
// must be read from the raw body instead of the parsed JSON
var publicPostIDPattern = regexp.MustCompile(`"post_ids"\s*:\s*\[\s*"?(\d+)"?`)

func parsePublicPostID(body []byte) string {
	if m := publicPostIDPattern.FindSubmatch(body); m != nil {
		return string(m[1])
	}
	return ""
}

// swallow logs and drops every error except RefreshToken / Disconnect, which
// the callers catch to refresh and retry - swallowing those would leave the
// panel empty until a manual reconnect.
func swallow(message string, err error) error {
	if isTokenOrDisconnect(err) {
		return err
	}
	slog.Error(message, "err", err)
	return nil
}

func (p *Provider) Analytics(ctx context.Context, id, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	result, err := p.analytics(ctx, id, accessToken)
	if err != nil {
		return []integrations.AnalyticsData{}, swallow("Error fetching TikTok Business analytics:", err)
	}
	return result, nil
}

func (p *Provider) analytics(ctx context.Context, id, accessToken string) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")
	result := []integrations.AnalyticsData{}

	// Real-time account stats (followers, following, likes, videos)
	userStatsData, err := p.getEnvelope(ctx, baseURL+"/business/get/?business_id="+encodeURIComponent(id)+
		"&fields="+jsonParam([]string{"followers_count", "following_count", "total_likes", "videos_count"}), accessToken)
	if err != nil {
		return nil, err
	}
	if err := throwIfTokenError(userStatsData); err != nil {
		return nil, err
	}
	if userStats := userStatsData.Data; userStats != nil {
		result = appendPresent(result, userStats, today,
			"followers_count", "Followers", "following_count", "Following", "total_likes", "Total Likes", "videos_count", "Videos")
	}

	// Recent posts with their lifetime engagement, aggregated
	videos, err := p.loadVideoList(ctx, accessToken, id, []string{"item_id", "likes", "comments", "shares", "video_views"})
	if err != nil {
		return nil, err
	}
	if len(videos) == 0 {
		return result, nil
	}
	var views, likes, comments, shares float64
	for _, video := range videos {
		views += number(field(video, "video_views"))
		likes += number(field(video, "likes"))
		comments += number(field(video, "comments"))
		shares += number(field(video, "shares"))
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
	videos, err := p.loadVideoList(ctx, accessToken, id, []string{"item_id", "thumbnail_url"})
	if err != nil {
		return out, swallow("Error fetching TikTok Business missing content:", err)
	}
	for _, v := range videos {
		thumbnail, _ := field(v, "thumbnail_url").(string)
		out = append(out, integrations.MissingPost{ID: jsString(field(v, "item_id")), URL: thumbnail})
	}
	return out, nil
}

// ResolveReleaseID: posts saved before post_ids became available keep their
// share_id (v_pub_... / p_pub_...) as releaseId - resolve it to the public
// post id.
func (p *Provider) ResolveReleaseID(ctx context.Context, accessToken, releaseID string, integration *ent.Integration, settings json.RawMessage, releaseURL string) (*integrations.ReleaseIDResolution, error) {
	// a draft sent to the inbox (UPLOAD) is stored as 'missing' with its
	// share id in the URL fragment
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

	// privacy_level only applies to photo posts here (and not to a draft, the
	// user picks it in the app), and TikTok only gives a post id to posts
	// published for public viewership
	if !draft && strings.HasPrefix(publishID, "p_pub_") && privateLevel(settings) {
		return &integrations.ReleaseIDResolution{Unavailable: true}, nil
	}

	res, err := p.get(ctx, p.statusURL(integration, publishID), accessToken)
	if err != nil {
		return nil, err
	}
	env, err := parseEnvelope(res.Body)
	if err != nil {
		return nil, err
	}
	if err := throwIfTokenError(env); err != nil {
		return nil, err
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

// ReleaseURL is for a post connected by hand: /video/<id> also reaches photo
// posts, TikTok redirects it to /photo/<id>
func (p *Provider) ReleaseURL(_ context.Context, _, releaseID string, integration *ent.Integration) (string, error) {
	return "https://www.tiktok.com/@" + profile(integration) + "/video/" + releaseID, nil
}

func (p *Provider) PostAnalytics(ctx context.Context, integrationID, accessToken, postID string, fromDate int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")
	videoQueryData, err := p.getEnvelope(ctx, baseURL+"/business/video/list/?business_id="+encodeURIComponent(integrationID)+
		"&fields="+jsonParam([]string{"item_id", "likes", "comments", "shares", "video_views"})+
		"&filters="+jsonParam(map[string]any{"video_ids": []string{postID}}), accessToken)
	if err == nil {
		err = throwIfTokenError(videoQueryData)
	}
	if err != nil {
		return []integrations.AnalyticsData{}, swallow("Error fetching TikTok Business post analytics:", err)
	}
	videos, _ := videoQueryData.Data["videos"].([]any)
	if len(videos) == 0 {
		return []integrations.AnalyticsData{}, nil
	}
	video, _ := videos[0].(map[string]any)
	if video == nil {
		return []integrations.AnalyticsData{}, nil
	}
	return appendPresent([]integrations.AnalyticsData{}, video, today,
		"video_views", "Views", "likes", "Likes", "comments", "Comments", "shares", "Shares"), nil
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
