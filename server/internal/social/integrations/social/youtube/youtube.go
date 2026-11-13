// Package youtube is the YouTube provider. googleapis calls are made over
// plain HTTP against the same REST endpoints (see googleapi).
package youtube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/youtube/googleapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "youtube"

// API roots (googleapis rootUrl for youtube v3 / youtubeAnalytics v2, and the
// resumable upload host). Tests point them at an httptest server.
var (
	youtubeAPI   = "https://youtube.googleapis.com"
	uploadAPI    = "https://www.googleapis.com"
	analyticsAPI = "https://youtubeanalytics.googleapis.com"
)

const (
	// YouTube requires chunk sizes to be a multiple of 256KB (except the last).
	youtubeChunkSize = 8 * 1024 * 1024
	// Keep each upload batch well below the 10-minute activity timeout, the
	// workflow calls finalizePost again for the remaining bytes.
	youtubeUploadBatch = 4 * time.Minute
)

var scopes = []string{
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/youtube",
	"https://www.googleapis.com/auth/youtube.force-ssl",
	"https://www.googleapis.com/auth/youtube.readonly",
	"https://www.googleapis.com/auth/youtube.upload",
	"https://www.googleapis.com/auth/yt-analytics.readonly",
}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "YouTube",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   true,
		MaxConcurrentJob: 200, // YouTube has strict upload quotas
		Rules:            "YouTube must have on video attachment, it cannot be empty",
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 5000 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"pages": func(ctx context.Context, token string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Pages(ctx, token)
		},
		"fetchPageInformation": func(ctx context.Context, token string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.FetchPageInformation(ctx, token, data)
		},
	}
}

func client() googleapi.OAuth2Client {
	return googleapi.OAuth2Client{
		ClientID:     os.Getenv("YOUTUBE_CLIENT_ID"),
		ClientSecret: os.Getenv("YOUTUBE_CLIENT_SECRET"),
		RedirectURI:  os.Getenv("FRONTEND_URL") + "/integrations/social/youtube",
	}
}

func (p *Provider) CheckValidity(_ context.Context, items [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	if len(items) == 0 || len(items[0]) != 1 {
		return "You need one media", nil
	}
	if !strings.Contains(items[0][0].Path, "mp4") {
		return "Item must be a video", nil
	}
	return "", nil
}

func badBody(value string) *integrations.HandledError {
	return &integrations.HandledError{Type: "bad-body", Value: value}
}

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "invalidTags"):
		return badBody("The maximum allowed is 500 characters in total.")
	case strings.Contains(body, "invalidTitle"):
		return badBody("We have uploaded your video but we could not set the title. Title is too long.")
	case strings.Contains(body, "invalidDescription"):
		return badBody("Your video description is invalid, it may contain disallowed characters such as < or >.")
	case strings.Contains(body, "invalidCategoryId"):
		return badBody("The selected video category is invalid.")
	case strings.Contains(body, "invalidPublishAt"):
		return badBody("The scheduled publishing time is invalid.")
	case strings.Contains(body, "invalidRecordingDetails"):
		return badBody("The recording details for the video are invalid.")
	case strings.Contains(body, "invalidVideoGameRating"):
		return badBody("The video game rating is invalid.")
	case strings.Contains(body, "invalidFilename"):
		return badBody("The video file name is invalid.")
	case strings.Contains(body, "defaultLanguageNotSet"):
		return badBody("We could not set the localized video details because no default language is set.")
	case strings.Contains(body, "invalidVideoMetadata"):
		return badBody("Some of the video details are invalid, please review the title, description and tags.")
	case strings.Contains(body, "mediaBodyRequired"):
		return badBody("The video file is missing or could not be read, please re-upload the video.")
	case strings.Contains(body, "imageFormatUnsupported"):
		return badBody("We have uploaded your video but the thumbnail format is not supported, please use JPEG or PNG.")
	case strings.Contains(body, "imageTooTall"):
		return badBody("We have uploaded your video but the thumbnail image is too tall.")
	case strings.Contains(body, "imageTooWide"):
		return badBody("We have uploaded your video but the thumbnail image is too wide.")
	case strings.Contains(body, "rateLimitExceeded"):
		return badBody("You are sending requests too quickly, please wait a little while and try again.")
	case strings.Contains(body, "failedPrecondition"):
		return badBody("We have uploaded your video but we could not set the thumbnail. Thumbnail size is too large.")
	case strings.Contains(body, "uploadLimitExceeded"):
		return badBody("You have reached your daily upload limit, please try again tomorrow.")
	case strings.Contains(body, "youtubeSignupRequired"):
		return badBody("You have to link your youtube account to your google account first.")
	case strings.Contains(body, "youtube.thumbnail"):
		return badBody("Your account is not verified, we have uploaded your video but we could not set the thumbnail. Please verify your account and try again.")
	case strings.Contains(body, "Unauthorized"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Token expired or invalid, please reconnect your YouTube account."}
	case strings.Contains(body, "UNAUTHENTICATED") || strings.Contains(body, "invalid_grant"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Please re-authenticate your YouTube account"}
	}
	return nil
}

// RefreshErrorMessage explains a failed refresh; the refresh error carries
// Google's body (error_subtype, error_description).
func (p *Provider) RefreshErrorMessage(err error) string {
	if err != nil && strings.Contains(err.Error(), "invalid_rapt") {
		return `because your organization's Google Workspace session policy invalidated its access. Ask your Google Workspace admin to mark Shots as a trusted app and turn on "Exempt trusted apps" (https://support.google.com/a/answer/9368756) to prevent this from happening again`
	}
	return ""
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	tokens, err := client().RefreshAccessToken(ctx, refreshToken)
	if err != nil {
		return nil, err
	}
	user, err := googleapi.GetUserInfo(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	refresh := tokens.RefreshToken
	if refresh == "" {
		refresh = refreshToken
	}
	return &integrations.AuthTokenDetails{
		AccessToken:  tokens.AccessToken,
		ExpiresIn:    tokens.ExpiresIn,
		RefreshToken: refresh,
		ID:           user.ID,
		Name:         user.Name,
		Picture:      user.Picture,
		Username:     "",
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(7)
	return &integrations.GenerateAuthURLResponse{
		URL:          client().GenerateAuthURL(state, scopes),
		CodeVerifier: ids.Secure(11),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	tokens, err := client().GetToken(ctx, params.Code)
	if err != nil {
		return nil, err
	}
	granted, err := googleapi.GetTokenScopes(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, granted); err != nil {
		return nil, err
	}
	user, err := googleapi.GetUserInfo(ctx, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		AccessToken:  tokens.AccessToken,
		ExpiresIn:    tokens.ExpiresIn,
		RefreshToken: tokens.RefreshToken,
		ID:           user.ID,
		Name:         user.Name,
		Picture:      user.Picture,
		Username:     "",
	}, nil
}

type channel struct {
	ID      string `json:"id"`
	Snippet *struct {
		Title      string `json:"title"`
		CustomURL  string `json:"customUrl"`
		Thumbnails struct {
			Default struct {
				URL string `json:"url"`
			} `json:"default"`
		} `json:"thumbnails"`
	} `json:"snippet"`
	Statistics *struct {
		SubscriberCount string `json:"subscriberCount"`
	} `json:"statistics"`
}

func (c channel) title() string {
	if c.Snippet == nil || c.Snippet.Title == "" {
		return "Unnamed Channel"
	}
	return c.Snippet.Title
}

func (c channel) picture() string {
	if c.Snippet == nil {
		return ""
	}
	return c.Snippet.Thumbnails.Default.URL
}

func (c channel) customURL() string {
	if c.Snippet == nil {
		return ""
	}
	return c.Snippet.CustomURL
}

// channelsList is youtube.channels.list; array params repeat like googleapis.
func channelsList(ctx context.Context, accessToken string, query url.Values) ([]channel, error) {
	var res struct {
		Items []channel `json:"items"`
	}
	if err := googleapi.Do(ctx, http.MethodGet, youtubeAPI+"/youtube/v3/channels?"+query.Encode(), accessToken, "", nil, &res); err != nil {
		return nil, err
	}
	return res.Items, nil
}

type Picture struct {
	Data struct {
		URL string `json:"url"`
	} `json:"data"`
}

// Page is one channel offered by pages().
type Page struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Picture         Picture `json:"picture"`
	Username        string  `json:"username"`
	SubscriberCount string  `json:"subscriberCount"`
}

func (p *Provider) Pages(ctx context.Context, accessToken string) ([]Page, error) {
	// Get all channels the user has access to
	channels, err := channelsList(ctx, accessToken, url.Values{"part": {"snippet", "contentDetails", "statistics"}, "mine": {"true"}})
	if err != nil {
		log.Println("Failed to fetch YouTube channels")
		return []Page{}, nil
	}
	out := make([]Page, 0, len(channels))
	for _, c := range channels {
		page := Page{ID: c.ID, Name: c.title(), Username: c.customURL(), SubscriberCount: "0"}
		page.Picture.Data.URL = c.picture()
		if c.Statistics != nil && c.Statistics.SubscriberCount != "" {
			page.SubscriberCount = c.Statistics.SubscriberCount
		}
		out = append(out, page)
	}
	return out, nil
}

func (p *Provider) FetchPageInformation(ctx context.Context, accessToken string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var params struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(data, &params)
	channels, err := channelsList(ctx, accessToken, url.Values{"part": {"snippet", "contentDetails", "statistics"}, "id": {params.ID}})
	if err == nil && len(channels) == 0 {
		err = errors.New("Channel not found")
	}
	if err != nil {
		log.Println("Failed to fetch YouTube channel information")
		return nil, err
	}
	c := channels[0]
	return &integrations.FetchPageInformationResult{
		ID:          c.ID,
		Name:        c.title(),
		AccessToken: accessToken,
		Picture:     c.picture(),
		Username:    c.customURL(),
	}, nil
}

func (p *Provider) ReConnect(ctx context.Context, _, requiredID, accessToken string) (*integrations.AuthTokenDetails, error) {
	// don't go through pages() here, it swallows the real Google error and an
	// empty list would be reported as a missing channel
	channels, err := channelsList(ctx, accessToken, url.Values{"part": {"id"}, "mine": {"true"}})
	if err != nil {
		return nil, err
	}
	found := false
	for _, c := range channels {
		if c.ID == requiredID {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("Channel not found")
	}
	data, _ := json.Marshal(map[string]string{"id": requiredID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:          information.ID,
		Name:        information.Name,
		AccessToken: information.AccessToken,
		Picture:     information.Picture,
		Username:    information.Username,
	}, nil
}

// ---------------------------------------------------------------------------
// RESUMABLE UPLOAD (no more videos.insert): YouTube only creates the video
// resource when the final byte of the session is received, so a failed or
// retried upload can never leave a video behind - and the session URI can
// always be asked whether the video was created (the "unknown outcome" cure).
// ---------------------------------------------------------------------------

// pendingData travels through the workflow history between postPending,
// checkPostStatus and finalizePost.
type pendingData struct {
	UploadURI     string `json:"uploadUri"`
	VideoSize     int64  `json:"videoSize"`
	Path          string `json:"path"`
	UploadedBytes int64  `json:"uploadedBytes"`
	Thumbnail     string `json:"thumbnail"`
	VideoID       string `json:"videoId,omitempty"`
}

func (d pendingData) raw() json.RawMessage {
	data, _ := json.Marshal(d)
	return data
}

// youtubeChunkStream returns a streaming body for the [start, end] byte range
// of the media so we never hold the whole file in memory.
func youtubeChunkStream(ctx context.Context, path string, start, end int64) (io.ReadCloser, error) {
	if !strings.HasPrefix(path, "http") {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		return struct {
			io.Reader
			io.Closer
		}{io.NewSectionReader(f, start, end-start+1), f}, nil
	}
	// identity encoding so the store keeps content-length and can answer
	// with the requested range: a transformed (compressed) response loses
	// its length, and a length-less object is answered with the full body.
	temporalx.SetHeartbeatDetails(ctx, fmt.Sprintf("youtube: read media %d-%d %s", start, end, temporalx.StripQuery(path)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
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
		return nil, temporalx.BadBody(identifier, "{}", "{}", "The media storage did not return the requested byte range, please try again")
	}
	return res.Body, nil
}

// rangeEnd parses "bytes=0-1234" into the next offset to send.
func rangeEnd(header string) int64 {
	_, last, _ := strings.Cut(header, "-")
	n, _ := strconv.ParseInt(last, 10, 64)
	return n + 1
}

type probeResult struct {
	videoID       string
	uploadedBytes int64
}

func videoID(body []byte) string {
	var res struct {
		ID any `json:"id"`
	}
	_ = json.Unmarshal(body, &res)
	if res.ID == nil {
		return "undefined"
	}
	return fmt.Sprint(res.ID)
}

// probeUploadSession asks the upload session for the truth: the created video
// when the upload completed, or the exact byte offset to resume from. It
// bypasses Fetch because the probe answers with 308 (Resume Incomplete).
func probeUploadSession(ctx context.Context, accessToken, uploadURI string, videoSize int64) (*probeResult, error) {
	temporalx.SetHeartbeatDetails(ctx, "youtube: probe resumable session")
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Range", fmt.Sprintf("bytes */%d", videoSize))
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, readErr := io.ReadAll(res.Body)

	if res.StatusCode == 200 || res.StatusCode == 201 {
		return &probeResult{videoID: videoID(body)}, nil
	}
	if res.StatusCode == 308 {
		r := res.Header.Get("Range")
		if r == "" {
			return &probeResult{}, nil
		}
		return &probeResult{uploadedBytes: rangeEnd(r)}, nil
	}

	text := string(body)
	if readErr != nil {
		text = "{}"
	}
	// Transient Google-side errors: the session stays resumable, so return a
	// plain error - the caller treats it as "probe again later" instead of
	// permanently failing a resumable upload.
	if res.StatusCode == 429 || res.StatusCode >= 500 {
		return nil, fmt.Errorf("YouTube upload status check failed with %d", res.StatusCode)
	}
	handled := handleErrors(text, res.StatusCode)
	// Fetch has the same 401 fallback: Google 401 bodies don't always match
	// the handleErrors strings
	if res.StatusCode == 401 || (handled != nil && handled.Type == "refresh-token") {
		return nil, temporalx.RefreshToken(identifier, text, "{}", "")
	}
	message := "Failed to check the video upload status"
	if handled != nil && handled.Value != "" {
		message = handled.Value
	}
	if res.StatusCode == 404 || res.StatusCode == 410 {
		message = "The upload session expired before the video was uploaded, please post again"
	}
	return nil, temporalx.BadBody(identifier, text, "{}", message)
}

func decodeSettings(raw json.RawMessage) SettingsDTO {
	var settings SettingsDTO
	_ = json.Unmarshal(raw, &settings)
	return settings
}

func (p *Provider) PostPending(ctx context.Context, _ string, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	settings := decodeSettings(firstPost.Settings)
	path := ""
	if len(firstPost.Media) > 0 {
		path = firstPost.Media[0].Path
	}
	videoSize, err := p.MediaSize(ctx, path, identifier)
	if err != nil {
		return nil, err
	}

	type snippet struct {
		Title       *string  `json:"title,omitempty"`
		Description string   `json:"description"`
		Tags        []string `json:"tags,omitempty"`
	}
	body := struct {
		Snippet snippet `json:"snippet"`
		Status  struct {
			PrivacyStatus           *string `json:"privacyStatus,omitempty"`
			SelfDeclaredMadeForKids bool    `json:"selfDeclaredMadeForKids"`
			ContainsSyntheticMedia  bool    `json:"containsSyntheticMedia"`
		} `json:"status"`
	}{Snippet: snippet{Title: settings.Title, Description: firstPost.Message}}
	for _, tag := range settings.Tags {
		label := ""
		if tag.Label != nil {
			label = *tag.Label
		}
		body.Snippet.Tags = append(body.Snippet.Tags, label)
	}
	body.Status.PrivacyStatus = settings.Type
	body.Status.SelfDeclaredMadeForKids = settings.SelfDeclaredMadeForKids != nil && *settings.SelfDeclaredMadeForKids == "yes"
	body.Status.ContainsSyntheticMedia = settings.ContainsSyntheticMedia
	payload, _ := json.Marshal(body)

	// Start a resumable upload session: nothing exists on the channel until
	// the final byte is received, so nothing here is irreversible yet - the
	// bytes themselves are streamed by finalizePost, outside this activity.
	session, err := p.Fetch(ctx, uploadAPI+"/upload/youtube/v3/videos?uploadType=resumable&part=id,snippet,status&notifySubscribers=true", integrations.Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization":           "Bearer " + accessToken,
			"Content-Type":            "application/json; charset=UTF-8",
			"X-Upload-Content-Type":   "video/mp4",
			"X-Upload-Content-Length": strconv.FormatInt(videoSize, 10),
		},
		Body: payload,
	})
	if err != nil {
		return nil, err
	}
	uploadURI := session.Header.Get("Location")
	if uploadURI == "" {
		return nil, temporalx.BadBody(identifier, "{}", "{}", "Could not start the video upload, please try again")
	}

	thumbnail := ""
	if settings.Thumbnail != nil && settings.Thumbnail.Path != nil {
		thumbnail = *settings.Thumbnail.Path
	}
	return []integrations.PostResponse{{
		ID:     firstPost.ID,
		Status: "pending",
		PendingData: pendingData{
			UploadURI: uploadURI,
			VideoSize: videoSize,
			Path:      path,
			Thumbnail: thumbnail,
		}.raw(),
	}}, nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	probe, err := probeUploadSession(ctx, accessToken, data.UploadURI, data.VideoSize)
	if err != nil {
		if t := temporalx.FailureType(err); t == temporalx.TypeRefreshToken || t == temporalx.TypeBadBody {
			return nil, err
		}
		// transient network error, the workflow will check again
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
	}

	// the upload completed: the video exists, only the thumbnail may be left
	if probe.videoID != "" {
		if data.Thumbnail != "" {
			data.VideoID = probe.videoID
			return &integrations.PendingCheckResponse{Status: "ready", PendingData: data.raw()}, nil
		}
		return &integrations.PendingCheckResponse{
			Status:     "completed",
			PostID:     probe.videoID,
			ReleaseURL: "https://www.youtube.com/watch?v=" + probe.videoID,
		}, nil
	}

	// bytes are still missing, finalizePost resumes from the exact offset
	data.UploadedBytes = probe.uploadedBytes
	return &integrations.PendingCheckResponse{Status: "ready", PendingData: data.raw()}, nil
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	id := data.VideoID

	if id == "" {
		// ask the session for the truth before sending anything - a previous
		// run may have died mid-chunk, or even completed without us knowing
		probe, err := probeUploadSession(ctx, accessToken, data.UploadURI, data.VideoSize)
		if err != nil {
			return nil, err
		}
		if probe.videoID != "" {
			id = probe.videoID
		} else {
			started := time.Now()
			uploaded := probe.uploadedBytes
			pending := func() *integrations.PendingCheckResponse {
				data.UploadedBytes = uploaded
				return &integrations.PendingCheckResponse{Status: "pending", PendingData: data.raw()}
			}

			for uploaded < data.VideoSize {
				// batch budget exhausted: hand back to the workflow, the next
				// finalizePost resumes from the offset the session reports
				if time.Since(started) > youtubeUploadBatch {
					return pending(), nil
				}

				end := min(uploaded+youtubeChunkSize, data.VideoSize) - 1
				next, videoID, err := uploadChunk(ctx, accessToken, data, uploaded, end)
				if err != nil {
					return nil, err
				}
				if videoID != "" {
					id = videoID
					break
				}
				// no committed range reported: don't guess the offset, let the
				// next probe find the truth
				if next < 0 {
					return pending(), nil
				}
				uploaded = next
			}

			if id == "" {
				// all bytes sent without a confirmation, the next check asks the session
				return pending(), nil
			}
		}
	}

	if data.Thumbnail != "" {
		if err := p.SetThumbnail(ctx, accessToken, id, data.Thumbnail); err != nil {
			return nil, err
		}
	}

	return &integrations.PendingCheckResponse{
		Status:     "completed",
		PostID:     id,
		ReleaseURL: "https://www.youtube.com/watch?v=" + id,
	}, nil
}

// uploadChunk sends bytes [start, end]. It returns the created video id when
// the upload completed, otherwise the next offset (-1 when the session did not
// report a committed range).
func uploadChunk(ctx context.Context, accessToken string, data pendingData, start, end int64) (int64, string, error) {
	body, err := youtubeChunkStream(ctx, data.Path, start, end)
	if err != nil {
		return 0, "", err
	}
	defer body.Close()

	temporalx.SetHeartbeatDetails(ctx, "youtube: upload chunk to google")
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, data.UploadURI, body)
	if err != nil {
		return 0, "", err
	}
	req.ContentLength = end - start + 1
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Content-Type", "video/mp4")
	req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, data.VideoSize))
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	text, readErr := io.ReadAll(res.Body)

	// more bytes expected, resume from the offset the session reports
	if res.StatusCode == 308 {
		r := res.Header.Get("Range")
		if r == "" {
			return -1, "", nil
		}
		return rangeEnd(r), "", nil
	}

	// final chunk received: the video now exists on the channel
	if res.StatusCode == 200 || res.StatusCode == 201 {
		return 0, videoID(text), nil
	}

	if readErr != nil {
		text = []byte("{}")
	}
	// Transient Google-side errors: the session stays resumable, a plain
	// error makes the workflow probe and resume instead of failing the
	// whole upload.
	if res.StatusCode == 429 || res.StatusCode >= 500 {
		return 0, "", fmt.Errorf("YouTube chunk upload failed with %d", res.StatusCode)
	}
	handled := handleErrors(string(text), res.StatusCode)
	if res.StatusCode == 401 || (handled != nil && handled.Type == "refresh-token") {
		return 0, "", temporalx.RefreshToken(identifier, string(text), "{}", "")
	}
	message := "Failed to upload the video to YouTube"
	if handled != nil && handled.Value != "" {
		message = handled.Value
	}
	return 0, "", temporalx.BadBody(identifier, string(text), "{}", message)
}

// SetThumbnail sets a live video's custom thumbnail, as a follow-up apart
// from the upload: its failure never fails the video.
func (p *Provider) SetThumbnail(ctx context.Context, accessToken, videoID, thumbnail string) error {
	_, err := integrations.RunInConcurrent(p.Base, func() (any, error) {
		return nil, setThumbnail(ctx, accessToken, videoID, thumbnail)
	})
	return err
}

// setThumbnail is youtube.thumbnails.set with the thumbnail streamed from the
// SSRF-safe client (media upload, no mime type like googleapis sends it).
func setThumbnail(ctx context.Context, accessToken, videoID, thumbnail string) error {
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, thumbnail, nil)
	if err != nil {
		return err
	}
	image, err := ssrf.Client().Do(get)
	if err != nil {
		return err
	}
	defer image.Body.Close()
	if image.StatusCode < 200 || image.StatusCode > 299 {
		data, _ := io.ReadAll(image.Body)
		return &googleapi.Error{Status: image.StatusCode, Body: string(data)}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		youtubeAPI+"/upload/youtube/v3/thumbnails/set?"+url.Values{"videoId": {videoID}, "uploadType": {"media"}}.Encode(), image.Body)
	if err != nil {
		return err
	}
	req.ContentLength = image.ContentLength
	req.Header.Set("Authorization", "Bearer "+accessToken)
	return googleapi.Send(req, nil)
}

// postTimeout caps the blocking Post below the 10-minute activity timeout of
// the old workflows, leaving room for one more full upload batch.
var postTimeout = 8*time.Minute - youtubeUploadBatch

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that still run and don't know how to resolve a `pending` response - they
// upload and set the thumbnail inside the activity like before.
func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	responses, err := p.PostPending(ctx, id, accessToken, posts, integration)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	if response.Status != "pending" {
		return responses, nil
	}

	data := response.PendingData
	started := time.Now()
	for {
		// failing here is safe (no video exists until the upload completes
		// and the abandoned session just expires), timing the activity out is not.
		if time.Since(started) > postTimeout {
			return nil, temporalx.BadBody(identifier, "{}", "{}", "The video upload took too long, please try a smaller video")
		}
		finalize, err := p.FinalizePost(ctx, accessToken, data, integration)
		if err != nil {
			return nil, err
		}
		if finalize.Status == "completed" {
			return []integrations.PostResponse{{
				ID:         response.ID,
				ReleaseURL: finalize.ReleaseURL,
				PostID:     finalize.PostID,
				Status:     "success",
			}}, nil
		}
		data = finalize.PendingData
	}
}

// Processing checks only read the known upload; an uncertain result never repeats it.
var processingPollInterval = 5 * time.Second

func (p *Provider) ConfirmVideo(ctx context.Context, token, videoID, channelID string) (string, error) {
	visibility := ""
	for attempt := 0; attempt < 12; attempt++ {
		var result struct {
			Items []struct {
				ID      string `json:"id"`
				Snippet struct {
					ChannelID string `json:"channelId"`
				} `json:"snippet"`
				Status struct {
					UploadStatus  string `json:"uploadStatus"`
					PrivacyStatus string `json:"privacyStatus"`
				} `json:"status"`
				Processing struct {
					Status string `json:"processingStatus"`
				} `json:"processingDetails"`
			} `json:"items"`
		}
		query := url.Values{"id": {videoID}, "part": {"snippet,status,processingDetails"}}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, youtubeAPI+"/youtube/v3/videos?"+query.Encode(), nil)
		if err != nil {
			return visibility, errors.New("YouTube processing request is unavailable")
		}
		request.Header.Set("Authorization", "Bearer "+token)
		if err := googleapi.Send(request, &result); err == nil && len(result.Items) == 1 {
			item := result.Items[0]
			if item.ID != videoID || item.Snippet.ChannelID != channelID {
				return visibility, errors.New("YouTube returned an unexpected video identity")
			}
			visibility = item.Status.PrivacyStatus
			if item.Status.UploadStatus == "processed" && item.Processing.Status == "succeeded" && (visibility == "public" || visibility == "private" || visibility == "unlisted") {
				return visibility, nil
			}
			if item.Status.UploadStatus == "failed" || item.Status.UploadStatus == "rejected" || item.Status.UploadStatus == "deleted" || item.Processing.Status == "failed" || item.Processing.Status == "terminated" {
				return visibility, errors.New("YouTube video processing did not succeed")
			}
		}
		if attempt < 11 {
			select {
			case <-ctx.Done():
				return visibility, errors.New("YouTube processing confirmation timed out")
			case <-time.After(processingPollInterval):
			}
		}
	}
	return visibility, errors.New("YouTube video processing remains unconfirmed")
}

// rawText renders a JSON scalar the way String(value) would.
func rawText(raw json.RawMessage) string {
	var s string
	if len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

func (p *Provider) Analytics(ctx context.Context, _ string, accessToken string, days int) ([]integrations.AnalyticsData, error) {
	endDate := time.Now().Format("2006-01-02")
	startDate := time.Now().AddDate(0, 0, -days).Format("2006-01-02")

	query := url.Values{
		"ids":        {"channel==MINE"},
		"startDate":  {startDate},
		"endDate":    {endDate},
		"metrics":    {"views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,subscribersLost"},
		"dimensions": {"day"},
		"sort":       {"day"},
	}
	var data struct {
		ColumnHeaders []struct {
			Name string `json:"name"`
		} `json:"columnHeaders"`
		Rows [][]json.RawMessage `json:"rows"`
	}
	if err := googleapi.Do(ctx, http.MethodGet, analyticsAPI+"/v2/reports?"+query.Encode(), accessToken, "", nil, &data); err != nil {
		return []integrations.AnalyticsData{}, nil
	}

	mapped := make([]map[string]string, 0, len(data.Rows))
	for _, row := range data.Rows {
		item := map[string]string{}
		for i, column := range data.ColumnHeaders {
			if i < len(row) {
				item[column.Name] = rawText(row[i])
			}
		}
		mapped = append(mapped, item)
	}

	series := []struct {
		label, column string
		average       bool
	}{
		{"Estimated Minutes Watched", "estimatedMinutesWatched", false},
		{"Average View Duration", "averageViewDuration", true},
		{"Average View Percentage", "averageViewPercentage", true},
		{"Subscribers Gained", "subscribersGained", false},
		{"Subscribers Lost", "subscribersLost", false},
		{"Likes", "likes", false},
	}
	out := make([]integrations.AnalyticsData, 0, len(series))
	for _, s := range series {
		var items []integrations.AnalyticsItem
		if data.Rows != nil {
			items = make([]integrations.AnalyticsItem, 0, len(mapped))
		}
		for _, row := range mapped {
			items = append(items, integrations.AnalyticsItem{Total: row[s.column], Date: row["day"]})
		}
		out = append(out, integrations.AnalyticsData{Label: s.label, Average: s.average, Data: items})
	}
	return out, nil
}

func (p *Provider) PostAnalytics(ctx context.Context, _ string, accessToken, postID string, _ int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")

	// Fetch video statistics
	var res struct {
		Items []struct {
			Statistics map[string]json.RawMessage `json:"statistics"`
		} `json:"items"`
	}
	query := url.Values{"part": {"statistics", "snippet"}, "id": {postID}}
	if err := googleapi.Do(ctx, http.MethodGet, youtubeAPI+"/youtube/v3/videos?"+query.Encode(), accessToken, "", nil, &res); err != nil {
		// Expired or revoked token, checkPostAnalytics refreshes it and retries once
		var gErr *googleapi.Error
		if errors.As(err, &gErr) && gErr.Status == 401 {
			body := gErr.Body
			if body == "" {
				body = "{}"
			}
			return nil, temporalx.RefreshToken(identifier, body, "{}", "")
		}
		log.Println("Error fetching YouTube post analytics:", err)
		return []integrations.AnalyticsData{}, nil
	}

	if len(res.Items) == 0 || res.Items[0].Statistics == nil {
		return []integrations.AnalyticsData{}, nil
	}
	stats := res.Items[0].Statistics
	out := []integrations.AnalyticsData{}
	for _, m := range [][2]string{
		{"viewCount", "Views"},
		{"likeCount", "Likes"},
		{"commentCount", "Comments"},
		{"favoriteCount", "Favorites"},
	} {
		if value, ok := stats[m[0]]; ok {
			out = append(out, integrations.AnalyticsData{
				Label: m[1],
				Data:  []integrations.AnalyticsItem{{Total: rawText(value), Date: today}},
			})
		}
	}
	return out, nil
}
