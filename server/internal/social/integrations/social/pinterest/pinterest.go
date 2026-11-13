// Package pinterest is the Pinterest provider.
package pinterest

import (
	"bytes"
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "pinterest"

// apiURL is the Pinterest API root; tests point it at an httptest server.
var apiURL = "https://api.pinterest.com"

var (
	// postTimeout caps the blocking Post below the 10-minute activity timeout
	// of the old workflows; pollDelay is the wait between processing checks.
	postTimeout = 8 * time.Minute
	pollDelay   = 20 * time.Second
)

var scopes = []string{
	"boards:read",
	"boards:write",
	"pins:read",
	"pins:write",
	"user_accounts:read",
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
		Name:             "Pinterest",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   false,
		MaxConcurrentJob: 10, // Pinterest limits are per user
		Rules:            "Pinterest requires at least one media, if posting a video, you must have two attachment, one for video, one for the cover picture, When posting a video, there can be only one, if posting images, there can be maximum 5",
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 500 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"boards": func(ctx context.Context, token string, _ json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Boards(ctx, token)
		},
	}
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{{MethodName: "boards", Description: "List of boards", DataSchema: []integrations.ToolField{}}}
}

func (p *Provider) CheckValidity(ctx context.Context, items [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	var firstItem []integrations.ValidityMedia
	if len(items) > 0 {
		firstItem = items[0]
	}
	isMp4, isPicture := false, false
	for _, item := range firstItem {
		if strings.Contains(item.Path, "mp4") {
			isMp4 = true
		} else {
			isPicture = true
		}
	}
	if len(firstItem) == 0 {
		return "Requires at least one media", nil
	}
	if len(firstItem) > 5 {
		return "You can only have up to 5 media items", nil
	}
	if isMp4 && len(firstItem) != 2 && !isPicture {
		return "If posting a video you have to also include a cover image as second media", nil
	}
	if isMp4 && len(firstItem) > 2 {
		return "If posting a video you can only have two media items", nil
	}

	if len(firstItem) > 1 && !isMp4 {
		sizes := make([][2]int, len(firstItem))
		for i, item := range firstItem {
			w, h, err := p.ImageDimensions(ctx, item.Path)
			if err != nil {
				return "", err
			}
			sizes[i] = [2]int{w, h}
		}
		for _, size := range sizes {
			if size != sizes[0] {
				return "Requires all images to have the same width and height", nil
			}
		}
	}
	return "", nil
}

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "constraint: maxItems=5"):
		return &integrations.HandledError{Type: "bad-body", Value: "You can upload a maximum of 5 images per post on Pinterest."}
	case strings.Contains(body, "Unable to reach the URL"):
		return &integrations.HandledError{Type: "retry", Value: "Pinterest was unable to reach the URL provided. Please check the link and try again."}
	case strings.Contains(body, "does not match '^") && strings.Contains(body, "d+$'"):
		return &integrations.HandledError{Type: "bad-body", Value: "The board ID must be a numeric string. Please check the board ID format."}
	case strings.Contains(body, "Board not found"):
		return &integrations.HandledError{Type: "bad-body", Value: "The specified board was not found. Please check the board ID."}
	case strings.Contains(body, "You are not permitted to access that resource"):
		return &integrations.HandledError{Type: "bad-body", Value: "The connected Pinterest account is not permitted to post to this board. Please check the board ID and that the account owns or can write to the board."}
	case strings.Contains(body, "cover_image_url or cover_image_content_type"):
		return &integrations.HandledError{Type: "bad-body", Value: "When uploading a video, you must add also an image to be used as a cover image."}
	}
	return nil
}

// statusError is a Pinterest answer outside 2xx: its JSON is an error, never data.
type statusError struct{ status int }

func (e statusError) Error() string { return fmt.Sprintf("pinterest answered %d", e.status) }

// request reads a JSON answer, and refuses one outside 2xx, so an error body
// never reads as an empty list or an empty token.
func request(ctx context.Context, method, rawURL string, headers map[string]string, body []byte, out any) error {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
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
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return statusError{res.StatusCode}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// refreshFailure keeps a refused grant apart from a passing failure: a
// throttled, failing or unreachable Pinterest is retried on the next run
// rather than asking the person to reconnect.
func refreshFailure(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var status statusError
	if errors.As(err, &status) && status.status != http.StatusTooManyRequests && status.status < 500 {
		return err
	}
	return integrations.ErrRefreshUnavailable
}

// form encodes ordered pairs like URLSearchParams.
func form(pairs ...[2]string) []byte {
	parts := make([]string, len(pairs))
	for i, pair := range pairs {
		parts[i] = url.QueryEscape(pair[0]) + "=" + url.QueryEscape(pair[1])
	}
	return []byte(strings.Join(parts, "&"))
}

func basicAuth() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(os.Getenv("PINTEREST_CLIENT_ID")+":"+os.Getenv("PINTEREST_CLIENT_SECRET")))
}

func redirectURI() string {
	return os.Getenv("FRONTEND_URL") + "/integrations/social/pinterest"
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        any    `json:"scope"`
}

func (p *Provider) token(ctx context.Context, body []byte) (*tokenResponse, error) {
	var token tokenResponse
	err := request(ctx, http.MethodPost, apiURL+"/v5/oauth/token", map[string]string{
		"Content-Type":  "application/x-www-form-urlencoded",
		"Authorization": basicAuth(),
	}, body, &token)
	if err != nil {
		return nil, err
	}
	return &token, nil
}

type userAccount struct {
	ID           string `json:"id"`
	ProfileImage string `json:"profile_image"`
	Username     string `json:"username"`
}

func (p *Provider) userAccount(ctx context.Context, accessToken string) (*userAccount, error) {
	var user userAccount
	if err := request(ctx, http.MethodGet, apiURL+"/v5/user_account", map[string]string{"Authorization": "Bearer " + accessToken}, nil, &user); err != nil {
		return nil, err
	}
	return &user, nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, form(
		[2]string{"grant_type", "refresh_token"},
		[2]string{"refresh_token", refreshToken},
		[2]string{"scope", strings.Join(scopes, ",")},
		[2]string{"redirect_uri", redirectURI()},
	))
	if err != nil {
		return nil, refreshFailure(ctx, err)
	}
	user, err := p.userAccount(ctx, token.AccessToken)
	if err != nil {
		return nil, refreshFailure(ctx, err)
	}
	return &integrations.AuthTokenDetails{
		ID:          user.ID,
		Name:        user.Username,
		AccessToken: token.AccessToken,
		// Pinterest may rotate the refresh token; keep the newest it gave.
		RefreshToken: cmp.Or(token.RefreshToken, refreshToken),
		ExpiresIn:    token.ExpiresIn,
		Picture:      user.ProfileImage,
		Username:     user.Username,
	}, nil
}

func encodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://www.pinterest.com/oauth/?client_id=" + os.Getenv("PINTEREST_CLIENT_ID") +
			"&redirect_uri=" + encodeURIComponent(redirectURI()) +
			"&response_type=code&scope=" + encodeURIComponent("boards:read,boards:write,pins:read,pins:write,user_accounts:read") +
			"&state=" + state,
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, form(
		[2]string{"grant_type", "authorization_code"},
		[2]string{"code", params.Code},
		[2]string{"redirect_uri", redirectURI()},
	))
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, token.Scope); err != nil {
		return nil, err
	}
	user, err := p.userAccount(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           user.ID,
		Name:         user.Username,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    token.ExpiresIn,
		Picture:      user.ProfileImage,
		Username:     user.Username,
	}, nil
}

type Board struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

// Boards is the @Tool "List of boards".
func (p *Provider) Boards(ctx context.Context, accessToken string) ([]Board, error) {
	var res struct {
		Items []Board `json:"items"`
	}
	if err := request(ctx, http.MethodGet, apiURL+"/v5/boards?page_size=250", map[string]string{"Authorization": "Bearer " + accessToken}, nil, &res); err != nil {
		return nil, err
	}
	if res.Items == nil {
		return []Board{}, nil
	}
	return res.Items, nil
}

// pendingData travels through the workflow history between postPending,
// checkPostStatus and finalizePost - keep it small JSON (the media id and the
// pin content).
type pendingData struct {
	MediaID  string `json:"mediaId"` // empty for image-only pins (no asynchronous processing)
	Message  string `json:"message"`
	Settings struct {
		Link          string `json:"link,omitempty"`
		Title         string `json:"title,omitempty"`
		DominantColor string `json:"dominant_color,omitempty"`
		Board         string `json:"board"`
	} `json:"settings"`
	ImagePaths []string `json:"imagePaths"`
	CoverPath  string   `json:"coverPath,omitempty"`
	// Arm -> confirm -> publish handshake (same as the Facebook story flow):
	// finalizePost arms without mutating, checkPostStatus witnesses, and only a
	// witnessed attempt runs the create - so a create that dies with an unknown
	// outcome is detected instead of run again (Pinterest has no idempotency
	// key).
	Attempting bool `json:"attempting,omitempty"`
	Confirmed  bool `json:"confirmed,omitempty"`
}

func (d pendingData) raw() json.RawMessage {
	data, _ := json.Marshal(d)
	return data
}

// orderedParams reads a JSON object keeping its key order (Object.keys).
func orderedParams(raw json.RawMessage) ([][2]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("Cannot convert undefined or null to object")
	}
	var out [][2]string
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		var value any
		if err := dec.Decode(&value); err != nil {
			return nil, err
		}
		out = append(out, [2]string{key.(string), fmt.Sprint(value)})
	}
	return out, nil
}

// uploadVideo streams the video into Pinterest's upload form (form-data with
// the media response as the file part, like axios + form-data).
func uploadVideo(ctx context.Context, uploadURL string, params [][2]string, videoPath string) error {
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, videoPath, nil)
	if err != nil {
		return err
	}
	video, err := ssrf.Client().Do(get)
	if err != nil {
		return err
	}
	defer video.Body.Close()
	if video.StatusCode < 200 || video.StatusCode > 299 {
		return fmt.Errorf("Request failed with status code %d", video.StatusCode)
	}

	var head bytes.Buffer
	writer := multipart.NewWriter(&head)
	for _, param := range params {
		if param[0] == "" {
			continue
		}
		if err := writer.WriteField(param[0], param[1]); err != nil {
			return err
		}
	}
	// form-data names an http response part after its request path and types
	// it from the response header, then the file name, then octet-stream.
	filename := path.Base(get.URL.RequestURI())
	contentType := video.Header.Get("Content-Type")
	if contentType == "" {
		contentType = mime.TypeByExtension(path.Ext(filename))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	partHeader := textproto.MIMEHeader{}
	partHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	partHeader.Set("Content-Type", contentType)
	if _, err := writer.CreatePart(partHeader); err != nil {
		return err
	}
	pre := bytes.Clone(head.Bytes())
	head.Reset()
	if err := writer.Close(); err != nil {
		return err
	}
	post := bytes.Clone(head.Bytes())

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, io.MultiReader(bytes.NewReader(pre), video.Body, bytes.NewReader(post)))
	if err != nil {
		return err
	}
	req.ContentLength = -1
	if video.ContentLength >= 0 {
		req.ContentLength = int64(len(pre)) + video.ContentLength + int64(len(post))
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("Request failed with status code %d", res.StatusCode)
	}
	return nil
}

func (p *Provider) PostPending(ctx context.Context, _ string, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	var findMp4, picture *integrations.MediaContent
	for i := range firstPost.Media {
		m := &firstPost.Media[i]
		if helpers.HasExtension(m.Path, "mp4") {
			if findMp4 == nil {
				findMp4 = m
			}
		} else if picture == nil {
			picture = m
		}
	}

	// Upload the video now; the processing wait moves to checkPostStatus and
	// the pin itself is only created by finalizePost, so nothing here is
	// irreversible - a failure leaves only an orphaned media upload.
	mediaID := ""
	if findMp4 != nil {
		res, err := p.Fetch(ctx, apiURL+"/v5/media", integrations.Request{
			Method: http.MethodPost,
			Body:   []byte(`{"media_type":"video"}`),
			Headers: map[string]string{
				"Content-Type":  "application/json",
				"Authorization": "Bearer " + accessToken,
			},
		})
		if err != nil {
			return nil, err
		}
		var media struct {
			UploadURL        string          `json:"upload_url"`
			MediaID          string          `json:"media_id"`
			UploadParameters json.RawMessage `json:"upload_parameters"`
		}
		if err := res.JSON(&media); err != nil {
			return nil, err
		}
		params, err := orderedParams(media.UploadParameters)
		if err != nil {
			return nil, err
		}
		if err := uploadVideo(ctx, media.UploadURL, params, findMp4.Path); err != nil {
			return nil, err
		}
		mediaID = media.MediaID
	}

	var settings SettingsDTO
	_ = json.Unmarshal(firstPost.Settings, &settings)
	data := pendingData{MediaID: mediaID, Message: firstPost.Message, ImagePaths: []string{}}
	data.Settings.Link = settings.Link
	data.Settings.Title = settings.Title
	data.Settings.DominantColor = settings.DominantColor
	if settings.Board != nil {
		data.Settings.Board = *settings.Board
	}
	for _, m := range firstPost.Media {
		data.ImagePaths = append(data.ImagePaths, m.Path)
	}
	if picture != nil {
		data.CoverPath = picture.Path
	}

	return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: data.raw()}}, nil
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	// A confirmed create attempt died without reporting its result: Pinterest
	// gives no way to ask whether that pin was created, so never run the
	// create again - stop with an explicit warning instead.
	if data.Attempting && data.Confirmed {
		return nil, temporalx.BadBody(identifier, "{}", "{}",
			"Pinterest may have already published this pin, please check your account before posting again to avoid duplicates")
	}

	// witness the armed create so finalizePost knows the attempt is uniquely
	// accounted for before it mutates anything
	witness := func() *integrations.PendingCheckResponse {
		if data.Attempting && !data.Confirmed {
			data.Confirmed = true
			return &integrations.PendingCheckResponse{Status: "ready", PendingData: data.raw()}
		}
		return &integrations.PendingCheckResponse{Status: "ready", PendingData: raw}
	}

	// Image-only pins have no asynchronous processing step.
	if data.MediaID == "" {
		return witness(), nil
	}

	var mediafile struct {
		Status string `json:"status"`
	}
	res, err := p.Fetch(ctx, apiURL+"/v5/media/"+data.MediaID, integrations.Request{
		Method:  http.MethodGet,
		Headers: map[string]string{"Authorization": "Bearer " + accessToken},
	})
	if err == nil {
		err = res.JSON(&mediafile)
	}
	if err != nil {
		if temporalx.FailureType(err) == temporalx.TypeRefreshToken {
			return nil, err
		}
		// Transient status-check error: the media may finish processing just
		// fine, keep polling - if Pinterest stays broken the workflow exhausts
		// its checks and warns the user properly.
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
	}

	if mediafile.Status == "failed" {
		return nil, temporalx.BadBody(identifier, "{}", "{}", "The file is corrupted and cannot be uploaded")
	}
	if mediafile.Status != "succeeded" {
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: raw}, nil
	}
	return witness(), nil
}

type pinBody struct {
	Link          string `json:"link,omitempty"`
	Title         string `json:"title,omitempty"`
	Description   string `json:"description"`
	DominantColor string `json:"dominant_color,omitempty"`
	BoardID       string `json:"board_id"`
	MediaSource   any    `json:"media_source"`
}

type urlItem struct {
	URL string `json:"url"`
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var data pendingData
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	// Create with an arm -> confirm -> publish handshake: the create only runs
	// after checkPostStatus witnessed the intent, so a run that dies
	// mid-create is detectable and the pin is never published twice.
	if !data.Attempting || !data.Confirmed {
		data.Attempting, data.Confirmed = true, false
		return &integrations.PendingCheckResponse{Status: "pending", PendingData: data.raw()}, nil
	}

	body := pinBody{
		Link:          data.Settings.Link,
		Title:         data.Settings.Title,
		Description:   data.Message,
		DominantColor: data.Settings.DominantColor,
		BoardID:       data.Settings.Board,
	}
	switch {
	case data.MediaID != "":
		body.MediaSource = struct {
			SourceType    string `json:"source_type"`
			MediaID       string `json:"media_id"`
			CoverImageURL string `json:"cover_image_url,omitempty"`
		}{"video_id", data.MediaID, data.CoverPath}
	case len(data.ImagePaths) == 1:
		body.MediaSource = struct {
			SourceType string `json:"source_type"`
			URL        string `json:"url"`
		}{"image_url", data.ImagePaths[0]}
	default:
		items := make([]urlItem, 0, len(data.ImagePaths))
		for _, path := range data.ImagePaths {
			items = append(items, urlItem{path})
		}
		body.MediaSource = struct {
			SourceType string    `json:"source_type"`
			Items      []urlItem `json:"items"`
		}{"multiple_image_urls", items}
	}
	payload, _ := json.Marshal(body)

	res, err := p.Fetch(ctx, apiURL+"/v5/pins", integrations.Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization": "Bearer " + accessToken,
			"Content-Type":  "application/json",
		},
		Body: payload,
	})
	if err != nil {
		return nil, err
	}
	var pin struct {
		ID string `json:"id"`
	}
	if err := res.JSON(&pin); err != nil {
		return nil, err
	}
	return &integrations.PendingCheckResponse{
		Status:     "completed",
		PostID:     pin.ID,
		ReleaseURL: "https://www.pinterest.com/pin/" + pin.ID,
	}, nil
}

// Post is the old blocking behavior, kept for workflow versions before v1.0.6
// that still run and don't know how to resolve a `pending` response - they
// wait for the processing and create the pin inside the activity like before.
func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	responses, err := p.PostPending(ctx, id, accessToken, posts, integration)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	data := response.PendingData
	started := time.Now()

	for {
		// failing here is safe (the pin is only created once the media is
		// ready), timing the activity out is not - a retried activity would
		// upload and publish again.
		if time.Since(started) > postTimeout {
			return nil, temporalx.BadBody(identifier, "{}", "{}", "The file took too long to process, please try again")
		}

		check, err := p.CheckPostStatus(ctx, accessToken, data, integration)
		if err != nil {
			return nil, err
		}
		if check.Status == "pending" {
			data = check.PendingData
			if err := p.Sleep(ctx, pollDelay); err != nil {
				return nil, err
			}
			continue
		}

		result := check
		if check.Status == "ready" {
			if result, err = p.FinalizePost(ctx, accessToken, check.PendingData, integration); err != nil {
				return nil, err
			}
		}
		if result.Status == "completed" {
			return []integrations.PostResponse{{
				ID:         response.ID,
				PostID:     result.PostID,
				ReleaseURL: result.ReleaseURL,
				Status:     "success",
			}}, nil
		}

		// finalize only armed the handshake (nothing to wait for), loop
		// straight into the witnessing check
		data = result.PendingData
	}
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
	until := time.Now().Format("2006-01-02")
	// Pinterest analytics only cover the last 90 days (89 for a UTC safety margin)
	since := time.Now().AddDate(0, 0, -min(days, 89)).Format("2006-01-02")

	var res struct {
		All *struct {
			DailyMetrics []struct {
				Date    string                     `json:"date"`
				Metrics map[string]json.RawMessage `json:"metrics"`
			} `json:"daily_metrics"`
		} `json:"all"`
	}
	err := request(ctx, http.MethodGet, apiURL+"/v5/user_account/analytics?start_date="+since+"&end_date="+until, map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Content-Type":  "application/json",
	}, nil, &res)
	if err != nil {
		return nil, err
	}
	if res.All == nil || res.All.DailyMetrics == nil {
		return nil, errors.New("Cannot read properties of undefined (reading 'daily_metrics')")
	}

	acc := []integrations.AnalyticsData{
		{Label: "Pin click rate", Data: []integrations.AnalyticsItem{}},
		{Label: "Impressions", Data: []integrations.AnalyticsItem{}},
		{Label: "Pin Clicks", Data: []integrations.AnalyticsItem{}},
		{Label: "Engagement", Data: []integrations.AnalyticsItem{}},
		{Label: "Saves", Data: []integrations.AnalyticsItem{}},
	}
	keys := []string{"PIN_CLICK_RATE", "IMPRESSION", "PIN_CLICK", "ENGAGEMENT", "SAVE"}
	for _, item := range res.All.DailyMetrics {
		if _, ok := item.Metrics["PIN_CLICK_RATE"]; !ok {
			continue
		}
		for i, key := range keys {
			acc[i].Data = append(acc[i].Data, integrations.AnalyticsItem{Date: item.Date, Total: rawText(item.Metrics[key])})
		}
	}
	return acc, nil
}

func (p *Provider) PostAnalytics(ctx context.Context, _ string, accessToken, postID string, _ int64) ([]integrations.AnalyticsData, error) {
	today := time.Now().Format("2006-01-02")
	// Pinterest only serves pin analytics for the last 90 days (89 for a UTC safety margin)
	since := time.Now().AddDate(0, 0, -89).Format("2006-01-02")

	// Fetch pin analytics from Pinterest API
	var data struct {
		All *struct {
			SummaryMetrics map[string]json.RawMessage `json:"summary_metrics"`
		} `json:"all"`
	}
	err := request(ctx, http.MethodGet, apiURL+"/v5/pins/"+postID+"/analytics?start_date="+since+"&end_date="+today+"&metric_types=IMPRESSION,PIN_CLICK,OUTBOUND_CLICK,SAVE", map[string]string{
		"Authorization": "Bearer " + accessToken,
		"Content-Type":  "application/json",
	}, nil, &data)
	if err != nil {
		log.Println("Error fetching Pinterest post analytics:", err)
		return []integrations.AnalyticsData{}, nil
	}

	result := []integrations.AnalyticsData{}
	if data.All == nil {
		return result, nil
	}

	// The requested metric types are period metrics: Pinterest returns them
	// in summary_metrics, never in lifetime_metrics (that only ever carries
	// TOTAL_COMMENTS / TOTAL_REACTIONS).
	for _, m := range [][2]string{
		{"IMPRESSION", "Impressions"},
		{"PIN_CLICK", "Pin Clicks"},
		{"OUTBOUND_CLICK", "Outbound Clicks"},
		{"SAVE", "Saves"},
	} {
		if value, ok := data.All.SummaryMetrics[m[0]]; ok {
			result = append(result, integrations.AnalyticsData{
				Label: m[1],
				Data:  []integrations.AnalyticsItem{{Total: rawText(value), Date: today}},
			})
		}
	}
	return result, nil
}
