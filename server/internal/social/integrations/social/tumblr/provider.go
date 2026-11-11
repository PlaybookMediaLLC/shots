// Package tumblr is the Tumblr provider (NPF posts).
package tumblr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "tumblr"

// apiURL is TUMBLR_API_URL, overridden by tests.
var apiURL = "https://api.tumblr.com/v2"

const (
	userAgent          = "Shots/1.0 (+https://shots.playbookmedia.io)"
	textBlockLimit     = 4096
	defaultVideoWidth  = 540
	defaultVideoHeight = 405
)

var scopes = []string{"write", "offline_access"}

type Provider struct {
	*integrations.Base
}

var (
	_ integrations.Provider               = (*Provider)(nil)
	_ integrations.Reconnector            = (*Provider)(nil)
	_ integrations.PageInformationFetcher = (*Provider)(nil)
)

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "Tumblr",
		Editor:           "normal",
		Scopes:           scopes,
		IsBetweenSteps:   true,
		MaxConcurrentJob: 3,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 32768 }

func (p *Provider) SettingsDTO() any { return &TumblrDTO{} }

func isVideoPath(path string) bool { return helpers.HasExtension(path, "mp4") }

func (p *Provider) CheckValidity(_ context.Context, posts [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	if len(posts) == 0 {
		return "", nil
	}
	images, videos := 0, 0
	for _, item := range posts[0] {
		if isVideoPath(item.Path) {
			videos++
		} else {
			images++
		}
	}
	if images > 30 {
		return "Tumblr supports up to 30 images in one post.", nil
	}
	if videos > 1 {
		return "Tumblr supports one uploaded video in one post.", nil
	}
	return "", nil
}

func hasErrorCode(body string, code int) bool {
	return regexp.MustCompile(`(?:\b|\.)` + strconv.Itoa(code) + `\b`).MatchString(body)
}

var errorCodes = []struct {
	code    int
	kind    string
	message string
}{
	{8001, "bad-body", "Tumblr rejected the post content format."},
	{8002, "bad-body", "Tumblr rejected the reblog parent post information."},
	{8004, "bad-body", "Tumblr daily media upload limit reached."},
	{8005, "bad-body", "Tumblr rejected one of the uploaded media files."},
	{8006, "retry", "Tumblr had a media upload error."},
	{8008, "bad-body", "Tumblr does not allow uploaded videos in reblog content."},
	{8010, "bad-body", "Tumblr is still transcoding a video upload for this blog. Please try again later."},
	{8011, "bad-body", "Tumblr daily video upload limit reached."},
	{8016, "bad-body", "Tumblr rejected the ask content or layout."},
	{8022, "bad-body", "Tumblr blog queue limit reached."},
	{8009, "retry", "Tumblr had a video upload error."},
}

func handleErrors(body string, status int) *integrations.HandledError {
	if status == 401 || strings.Contains(body, "Unauthorized") || strings.Contains(body, "invalid_grant") || strings.Contains(body, "invalid_token") {
		return &integrations.HandledError{Type: "refresh-token", Value: "Please re-authenticate your Tumblr account."}
	}
	if strings.Contains(body, "daily posting limit") || hasErrorCode(body, 8023) {
		return &integrations.HandledError{Type: "bad-body", Value: "Tumblr daily posting limit reached."}
	}
	for _, e := range errorCodes {
		if hasErrorCode(body, e.code) {
			return &integrations.HandledError{Type: e.kind, Value: e.message}
		}
	}
	if status == 429 {
		return &integrations.HandledError{Type: "retry", Value: "Tumblr API rate limit reached."}
	}
	if status == 503 {
		return &integrations.HandledError{Type: "retry", Value: "Tumblr posting via the API is temporarily unavailable."}
	}
	return nil
}

// form encodes pairs in order, like URLSearchParams.
func form(pairs ...string) string {
	var b strings.Builder
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(url.QueryEscape(pairs[i]) + "=" + url.QueryEscape(pairs[i+1]))
	}
	return b.String()
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

type blog struct {
	Name      string `json:"name"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	Primary   bool   `json:"primary"`
	Followers int64  `json:"followers"`
}

type userInfo struct {
	Response *struct {
		User *struct {
			Name  string `json:"name"`
			Blogs []blog `json:"blogs"`
		} `json:"user"`
	} `json:"response"`
}

func (u *userInfo) user() (name string, blogs []blog) {
	if u.Response == nil || u.Response.User == nil {
		return "", nil
	}
	return u.Response.User.Name, u.Response.User.Blogs
}

func (p *Provider) requestToken(ctx context.Context, body string) (*tokenResponse, error) {
	res, err := p.Fetch(ctx, apiURL+"/oauth2/token", integrations.Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent":   userAgent,
		},
		Body: []byte(body),
	})
	if err != nil {
		return nil, err
	}
	var token tokenResponse
	return &token, res.JSON(&token)
}

func (p *Provider) getUserInfo(ctx context.Context, accessToken string) (*userInfo, error) {
	res, err := p.Fetch(ctx, apiURL+"/user/info", integrations.Request{
		Headers: map[string]string{"Authorization": "Bearer " + accessToken, "User-Agent": userAgent},
	})
	if err != nil {
		return nil, err
	}
	var info userInfo
	return &info, res.JSON(&info)
}

func getPrimaryBlog(blogs []blog) *blog {
	for i := range blogs {
		if blogs[i].Primary {
			return &blogs[i]
		}
	}
	if len(blogs) > 0 {
		return &blogs[0]
	}
	return nil
}

func getAvatarURL(blogName string) string {
	return apiURL + "/blog/" + url.QueryEscape(blogName+".tumblr.com") + "/avatar/128"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// tokenDetails builds the answer shared by authenticate and refreshToken.
func (p *Provider) tokenDetails(ctx context.Context, token *tokenResponse, refreshToken string) (*integrations.AuthTokenDetails, error) {
	info, err := p.getUserInfo(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	name, blogs := info.user()
	primary := getPrimaryBlog(blogs)
	details := &integrations.AuthTokenDetails{
		ID:           name,
		Name:         firstNonEmpty(name, "Tumblr"),
		AccessToken:  token.AccessToken,
		RefreshToken: refreshToken,
		ExpiresIn:    token.ExpiresIn,
		Username:     name,
	}
	if primary != nil {
		details.ID = firstNonEmpty(name, primary.Name)
		details.Name = firstNonEmpty(name, primary.Title, primary.Name, "Tumblr")
		details.Picture = getAvatarURL(primary.Name)
	}
	return details, nil
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	token, err := p.requestToken(ctx, form(
		"grant_type", "refresh_token",
		"refresh_token", refreshToken,
		"client_id", os.Getenv("TUMBLR_CLIENT_ID"),
		"client_secret", os.Getenv("TUMBLR_CLIENT_SECRET"),
	))
	if err != nil {
		return nil, err
	}
	return p.tokenDetails(ctx, token, firstNonEmpty(token.RefreshToken, refreshToken))
}

func redirectURI() string { return os.Getenv("FRONTEND_URL") + "/integrations/social/tumblr" }

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	query := form(
		"client_id", os.Getenv("TUMBLR_CLIENT_ID"),
		"response_type", "code",
		"scope", strings.Join(scopes, " "),
		"state", state,
		"redirect_uri", redirectURI(),
	)
	return &integrations.GenerateAuthURLResponse{
		URL:          "https://www.tumblr.com/oauth2/authorize?" + query,
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	token, err := p.requestToken(ctx, form(
		"grant_type", "authorization_code",
		"code", params.Code,
		"client_id", os.Getenv("TUMBLR_CLIENT_ID"),
		"client_secret", os.Getenv("TUMBLR_CLIENT_SECRET"),
		"redirect_uri", redirectURI(),
	))
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, token.Scope); err != nil {
		return nil, err
	}
	return p.tokenDetails(ctx, token, token.RefreshToken)
}

// Page is one blog of pages().
type Page struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Username  string      `json:"username"`
	Followers int64       `json:"followers"`
	Primary   bool        `json:"primary"`
	Picture   PagePicture `json:"picture"`
}

type PagePicture struct {
	Data struct {
		URL string `json:"url"`
	} `json:"data"`
}

// Pages lists the user's blogs for the between-steps picker.
func (p *Provider) Pages(ctx context.Context, accessToken string) ([]Page, error) {
	info, err := p.getUserInfo(ctx, accessToken)
	if err != nil {
		return nil, err
	}
	_, blogs := info.user()
	out := make([]Page, 0, len(blogs))
	for _, b := range blogs {
		page := Page{
			ID:        b.Name,
			Name:      firstNonEmpty(b.Title, b.Name),
			Username:  firstNonEmpty(b.URL, "https://"+b.Name+".tumblr.com/"),
			Followers: b.Followers,
			Primary:   b.Primary,
		}
		page.Picture.Data.URL = getAvatarURL(b.Name)
		out = append(out, page)
	}
	return out, nil
}

func (p *Provider) FetchPageInformation(ctx context.Context, accessToken string, data json.RawMessage) (*integrations.FetchPageInformationResult, error) {
	var input struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &input); err != nil {
		return nil, err
	}
	pages, err := p.Pages(ctx, accessToken)
	if err != nil {
		return nil, err
	}
	for _, page := range pages {
		if page.ID == input.ID {
			return &integrations.FetchPageInformationResult{
				ID: page.ID, Name: page.Name, AccessToken: accessToken, Picture: page.Picture.Data.URL, Username: page.Username,
			}, nil
		}
	}
	return nil, errors.New("Tumblr blog not found")
}

func (p *Provider) ReConnect(ctx context.Context, _, requiredID, accessToken string) (*integrations.AuthTokenDetails, error) {
	data, _ := json.Marshal(map[string]string{"id": requiredID})
	information, err := p.FetchPageInformation(ctx, accessToken, data)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID: information.ID, Name: information.Name, AccessToken: information.AccessToken,
		Picture: information.Picture, Username: information.Username,
	}, nil
}

// uploadMedia is TumblrUploadMedia.
type uploadMedia struct {
	Type       string `json:"type"`
	Identifier string `json:"identifier"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

// contentBlock is a TumblrContentBlock (text, link, image or video).
type contentBlock struct {
	Type     string  `json:"type"`
	Subtype  string  `json:"subtype,omitempty"`
	Text     *string `json:"text,omitempty"`
	URL      string  `json:"url,omitempty"`
	Provider string  `json:"provider,omitempty"`
	Media    any     `json:"media,omitempty"`
	AltText  string  `json:"alt_text,omitempty"`
}

type postPayload struct {
	Content   []contentBlock `json:"content"`
	State     string         `json:"state"`
	Tags      string         `json:"tags,omitempty"`
	SourceURL string         `json:"source_url,omitempty"`
}

type createPostResponse struct {
	Response *struct {
		ID       any    `json:"id"`
		IDString string `json:"id_string"`
		PostID   string `json:"post_id"`
	} `json:"response"`
}

func (r *createPostResponse) postID() string {
	if r.Response == nil {
		return ""
	}
	if id := firstNonEmpty(r.Response.IDString, r.Response.PostID); id != "" {
		return id
	}
	switch v := r.Response.ID.(type) {
	case string:
		return v
	case float64:
		if v != 0 {
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
	}
	return ""
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	post := posts[0]
	var settings TumblrDTO
	if len(post.Settings) > 0 {
		if err := json.Unmarshal(post.Settings, &settings); err != nil {
			return nil, err
		}
	}
	content, err := p.createContentBlocks(ctx, post, &settings)
	if err != nil {
		return nil, err
	}
	payload := postPayload{Content: content, State: "published"}
	if settings.Tags != nil {
		payload.Tags = *settings.Tags
	}
	if settings.SourceURL != nil && *settings.SourceURL != "" {
		payload.SourceURL = normalizeURL(*settings.SourceURL)
	}

	var response *createPostResponse
	if len(post.Media) > 0 {
		response, err = p.createMultipartPost(ctx, id, accessToken, payload, post.Media)
	} else {
		response, err = p.createJSONPost(ctx, id, accessToken, payload)
	}
	if err != nil {
		return nil, err
	}

	postID := response.postID()
	profile := "https://www.tumblr.com/" + id
	if integration != nil && integration.Profile != nil && *integration.Profile != "" {
		profile = *integration.Profile
	}
	return []integrations.PostResponse{{
		ID: post.ID, Status: "completed", PostID: postID,
		ReleaseURL: normalizeBlogURL(profile) + "/post/" + postID,
	}}, nil
}

func normalizeBlogURL(u string) string { return strings.TrimSuffix(normalizeURL(u), "/") }

func normalizeURL(u string) string {
	if strings.HasPrefix(u, "http") {
		return u
	}
	return "https://" + u
}

func getMediaURL(path string) string {
	if !strings.Contains(path, "http") {
		return os.Getenv("FRONTEND_URL") + "/" + path
	}
	return path
}

// mediaTypes covers what mime-types' lookup returns for post media, which
// Go's built-in table may lack.
var mediaTypes = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime",
}

func getMimeType(path string) string {
	ext := strings.ToLower(filepath.Ext(strings.Split(path, "?")[0]))
	if t, ok := mediaTypes[ext]; ok {
		return t
	}
	if t, _, _ := strings.Cut(mime.TypeByExtension(ext), ";"); t != "" {
		return t
	}
	return "application/octet-stream"
}

func (p *Provider) createJSONPost(ctx context.Context, blogName, accessToken string, payload postPayload) (*createPostResponse, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	res, err := p.Fetch(ctx, apiURL+"/blog/"+url.QueryEscape(blogName)+"/posts", integrations.Request{
		Method: http.MethodPost,
		Headers: map[string]string{
			"Authorization": "Bearer " + accessToken,
			"Content-Type":  "application/json",
			"User-Agent":    userAgent,
		},
		Body: body,
	})
	if err != nil {
		return nil, err
	}
	var out createPostResponse
	return &out, res.JSON(&out)
}

func (p *Provider) createMultipartPost(ctx context.Context, blogName, accessToken string, payload postPayload, media []integrations.MediaContent) (*createPostResponse, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	// Each media part is streamed from its source into the multipart request
	// (with its size from a HEAD request) so files are never held in memory.
	// RunStreamedUpload rebuilds the whole form per attempt (a consumed stream
	// can't be replayed) and keeps handleErrors classification.
	return integrations.RunStreamedUpload(ctx, p.Base, false, func() (*createPostResponse, error) {
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		var (
			readers []io.Reader
			closers []io.Closer
			length  int64
		)
		defer func() {
			for _, c := range closers {
				c.Close()
			}
		}()
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", `form-data; name="json"`)
		header.Set("Content-Type", "application/json")
		part, err := w.CreatePart(header)
		if err != nil {
			return nil, err
		}
		_, _ = part.Write(payloadJSON)

		for index, item := range media {
			mediaURL := getMediaURL(item.Path)
			fileSize, err := p.MediaSize(ctx, mediaURL, identifier)
			if err != nil {
				return nil, err
			}
			stream, err := p.MediaStream(ctx, mediaURL, identifier)
			if err != nil {
				return nil, err
			}
			closers = append(closers, stream)
			filename := item.Path[strings.LastIndex(item.Path, "/")+1:]
			if filename == "" {
				filename = fmt.Sprintf("media-%d", index)
			}
			header := textproto.MIMEHeader{}
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="media-%d"; filename="%s"`, index, filename))
			header.Set("Content-Type", getMimeType(item.Path))
			if _, err := w.CreatePart(header); err != nil {
				return nil, err
			}
			head := bytes.Clone(buf.Bytes())
			buf.Reset()
			readers = append(readers, bytes.NewReader(head), stream)
			length += int64(len(head)) + fileSize
		}
		_ = w.Close()
		readers = append(readers, &buf)
		length += int64(buf.Len())

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/blog/"+url.QueryEscape(blogName)+"/posts", io.MultiReader(readers...))
		if err != nil {
			return nil, err
		}
		req.ContentLength = length
		req.Header.Set("Content-Type", w.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("User-Agent", userAgent)
		res, err := integrations.Do(req)
		if err != nil {
			return nil, err
		}

		// A non-JSON 200 (proxy/WAF page) would publish the post with an
		// empty id.
		var out createPostResponse
		if json.Unmarshal(res.Body, &out) != nil || out.Response == nil {
			body := res.Text()
			if body == "" {
				body = "{}"
			}
			return nil, temporalx.BadBody(identifier, body, "{}", "Tumblr did not return a valid post response")
		}
		return &out, nil
	})
}

func (p *Provider) getVideoDimensions(ctx context.Context, media integrations.MediaContent) (int, int) {
	if media.Thumbnail == "" {
		return defaultVideoWidth, defaultVideoHeight
	}
	width, height, err := p.ImageDimensions(ctx, media.Thumbnail)
	if err != nil {
		return defaultVideoWidth, defaultVideoHeight
	}
	return width, height
}

func text(s string) *string { return &s }

func (p *Provider) createContentBlocks(ctx context.Context, post integrations.PostDetails, settings *TumblrDTO) ([]contentBlock, error) {
	content := []contentBlock{}

	if settings.Title != nil && *settings.Title != "" {
		content = append(content, contentBlock{Type: "text", Subtype: "heading1", Text: text(*settings.Title)})
	}

	content = append(content, textBlocks(post.Message)...)

	if settings.Link != nil && *settings.Link != "" {
		content = append(content, contentBlock{Type: "link", URL: normalizeURL(*settings.Link)})
	}

	for index, item := range post.Media {
		media := uploadMedia{Type: getMimeType(item.Path), Identifier: fmt.Sprintf("media-%d", index)}

		if isVideoPath(item.Path) {
			media.Width, media.Height = p.getVideoDimensions(ctx, item)
			content = append(content, contentBlock{Type: "video", Provider: "tumblr", Media: media})
			continue
		}

		width, height, err := p.ImageDimensions(ctx, item.Path)
		if err != nil {
			return nil, err
		}
		media.Width, media.Height = width, height
		content = append(content, contentBlock{Type: "image", Media: []uploadMedia{media}, AltText: item.Alt})
	}

	if len(content) == 0 {
		content = append(content, contentBlock{Type: "text", Text: text("")})
	}
	return content, nil
}

var paragraphs = regexp.MustCompile(`\n{2,}`)

func textBlocks(message string) []contentBlock {
	var out []contentBlock
	for _, part := range paragraphs.Split(message, -1) {
		for _, chunk := range chunkText(strings.TrimSpace(part)) {
			out = append(out, contentBlock{Type: "text", Text: text(chunk)})
		}
	}
	return out
}

// chunkText splits by code points, TUMBLR_TEXT_BLOCK_LIMIT per block.
func chunkText(s string) []string {
	runes := []rune(s)
	var chunks []string
	for i := 0; i < len(runes); i += textBlockLimit {
		chunks = append(chunks, string(runes[i:min(i+textBlockLimit, len(runes))]))
	}
	return chunks
}

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
