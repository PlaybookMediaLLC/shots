// Package vk is the VK provider: VK ID OAuth (PKCE) and wall posts.
package vk

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/internal/communityutil"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "vk"

// Overridden by tests.
var (
	idURL  = "https://id.vk.com"
	apiURL = "https://api.vk.com"
)

var scopes = []string{"vkid.personal_info", "email", "wall", "status", "docs", "photos", "video"}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, nil)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "VK",
		Editor:           "normal",
		Scopes:           scopes,
		MaxConcurrentJob: 5, // VK limits are per user token
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 2048 }

type field struct{ name, value string }

// form builds a multipart/form-data body (the TS sends FormData).
func form(fields ...field) ([]byte, string) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for _, f := range fields {
		_ = w.WriteField(f.name, f.value)
	}
	_ = w.Close()
	return buf.Bytes(), w.FormDataContentType()
}

func (p *Provider) postForm(ctx context.Context, url string, fields ...field) (*integrations.Response, error) {
	body, contentType := form(fields...)
	return p.Fetch(ctx, url, integrations.Request{Method: http.MethodPost, Headers: map[string]string{"Content-Type": contentType}, Body: body})
}

func redirectURI() string {
	frontend := os.Getenv("FRONTEND_URL")
	if !strings.Contains(frontend, "https") {
		return "https://redirectmeto.com/" + frontend + "/integrations/social/vk"
	}
	return frontend + "/integrations/social/vk"
}

// details exchanges the token form and reads the VK ID profile.
func (p *Provider) details(ctx context.Context, deviceID string, fields ...field) (*integrations.AuthTokenDetails, error) {
	res, err := p.postForm(ctx, idURL+"/oauth2/auth", fields...)
	if err != nil {
		return nil, err
	}
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken any    `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := res.JSON(&token); err != nil {
		return nil, err
	}
	res, err = p.postForm(ctx, idURL+"/oauth2/user_info",
		field{"client_id", os.Getenv("VK_ID")},
		field{"access_token", token.AccessToken},
	)
	if err != nil {
		return nil, err
	}
	var info struct {
		User *struct {
			UserID    any    `json:"user_id"`
			FirstName string `json:"first_name"`
			LastName  string `json:"last_name"`
			Avatar    string `json:"avatar"`
		} `json:"user"`
	}
	if err := res.JSON(&info); err != nil {
		return nil, err
	}
	if info.User == nil {
		return nil, errors.New("Cannot destructure property 'user_id' of undefined")
	}
	return &integrations.AuthTokenDetails{
		ID:           communityutil.JSString(info.User.UserID),
		Name:         info.User.FirstName + " " + info.User.LastName,
		AccessToken:  token.AccessToken,
		RefreshToken: jsConcat(token.RefreshToken) + "&&&&" + deviceID,
		ExpiresIn:    token.ExpiresIn,
		Picture:      info.User.Avatar,
		Username:     strings.ToLower(info.User.FirstName),
	}, nil
}

func jsConcat(v any) string {
	if v == nil {
		return "undefined"
	}
	return communityutil.JSString(v)
}

// split is `value.split('&&&&')` destructured into two (missing = "undefined").
func split(value string) (string, string) {
	first, second, ok := strings.Cut(value, "&&&&")
	if !ok {
		return first, "undefined"
	}
	second, _, _ = strings.Cut(second, "&&&&")
	return first, second
}

func (p *Provider) RefreshToken(ctx context.Context, refresh string) (*integrations.AuthTokenDetails, error) {
	oldRefreshToken, deviceID := split(refresh)
	return p.details(ctx, deviceID,
		field{"grant_type", "refresh_token"},
		field{"refresh_token", oldRefreshToken},
		field{"client_id", os.Getenv("VK_ID")},
		field{"device_id", deviceID},
		field{"state", ids.Secure(32)},
		field{"scope", strings.Join(scopes, " ")},
	)
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(32)
	random := make([]byte, 64)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	codeVerifier := base64.RawURLEncoding.EncodeToString(random)
	sum := sha256.Sum256([]byte(codeVerifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	return &integrations.GenerateAuthURLResponse{
		URL: "https://id.vk.com/authorize" +
			"?response_type=code" +
			"&client_id=" + os.Getenv("VK_ID") +
			"&code_challenge_method=S256" +
			"&code_challenge=" + challenge +
			"&redirect_uri=" + communityutil.EncodeURIComponent(redirectURI()) +
			"&state=" + state +
			"&scope=" + communityutil.EncodeURIComponent(strings.Join(scopes, " ")),
		CodeVerifier: codeVerifier,
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	code, deviceID := split(params.Code)
	return p.details(ctx, deviceID,
		field{"client_id", os.Getenv("VK_ID")},
		field{"grant_type", "authorization_code"},
		field{"code_verifier", params.CodeVerifier},
		field{"device_id", deviceID},
		field{"code", code},
		field{"redirect_uri", redirectURI()},
	)
}

type uploaded struct {
	id   string
	kind string
}

// ponytail: uploads run one after another where TS used Promise.all; same
// attachments in the same order.
func (p *Provider) uploadMedia(ctx context.Context, userID, accessToken string, post integrations.PostDetails) ([]uploaded, error) {
	out := []uploaded{}
	for _, media := range post.Media {
		item, err := p.uploadOne(ctx, userID, accessToken, media.Path)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, nil
}

func (p *Provider) uploadOne(ctx context.Context, userID, accessToken, path string) (uploaded, error) {
	isVideo := helpers.HasExtension(path, "mp4")
	serverURL := apiURL + "/method/photos.getWallUploadServer?owner_id=" + userID + "&access_token=" + accessToken + "&v=5.251"
	if isVideo {
		serverURL = apiURL + "/method/video.save?access_token=" + accessToken + "&v=5.251"
	}
	res, err := p.Fetch(ctx, serverURL, integrations.Request{})
	if err != nil {
		return uploaded{}, err
	}
	var all struct {
		Response *struct {
			UploadURL string `json:"upload_url"`
			VideoID   any    `json:"video_id"`
		} `json:"response"`
	}
	if err := res.JSON(&all); err != nil {
		return uploaded{}, err
	}
	if all.Response == nil {
		return uploaded{}, errors.New("Cannot read properties of undefined (reading 'upload_url')")
	}

	value, err := streamUpload(ctx, path, all.Response.UploadURL)
	if err != nil {
		return uploaded{}, err
	}
	if isVideo {
		return uploaded{id: communityutil.JSString(all.Response.VideoID), kind: "video"}, nil
	}

	body, contentType := form(
		field{"photo", jsConcat(value["photo"])},
		field{"server", jsConcat(value["server"])},
		field{"hash", jsConcat(value["hash"])},
	)
	saved, err := communityutil.Fetch(ctx, http.MethodPost, apiURL+"/method/photos.saveWallPhoto?access_token="+accessToken+"&v=5.251",
		map[string]string{"Content-Type": contentType}, body)
	if err != nil {
		return uploaded{}, err
	}
	var photos struct {
		Response []struct {
			ID any `json:"id"`
		} `json:"response"`
	}
	if err := saved.JSON(&photos); err != nil {
		return uploaded{}, err
	}
	if len(photos.Response) == 0 {
		return uploaded{}, errors.New("Cannot read properties of undefined (reading '0')")
	}
	return uploaded{id: communityutil.JSString(photos.Response[0].ID), kind: "photo"}, nil
}

// streamUpload GETs the media and streams it as the multipart `photo` field
// to the upload server (axios + form-data in TS), returning the JSON answer.
func streamUpload(ctx context.Context, mediaPath, uploadURL string) (map[string]any, error) {
	getReq, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaPath, nil)
	if err != nil {
		return nil, err
	}
	media, err := ssrf.StreamingClient().Do(getReq)
	if err != nil {
		return nil, err
	}
	defer media.Body.Close()
	if !communityutil.OK(media.StatusCode) {
		return nil, fmt.Errorf("Request failed with status code %d", media.StatusCode)
	}
	slash := communityutil.LastSegment(mediaPath)
	contentType := communityutil.MimeType(slash)
	if contentType == "" {
		contentType = media.Header.Get("Content-Type")
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	pr, pw := io.Pipe()
	w := multipart.NewWriter(pw)
	go func() {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="photo"; filename="%s"`, slash))
		h.Set("Content-Type", contentType)
		part, err := w.CreatePart(h)
		if err == nil {
			_, err = io.Copy(part, media.Body)
		}
		if err == nil {
			err = w.Close()
		}
		pw.CloseWithError(err)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, uploadURL, pr)
	if err != nil {
		pr.Close()
		return nil, err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, err := ssrf.StreamingClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	if !communityutil.OK(res.StatusCode) {
		return nil, fmt.Errorf("Request failed with status code %d", res.StatusCode)
	}
	var value map[string]any
	_ = json.Unmarshal(data, &value) // axios leaves a non-JSON body as text
	return value, nil
}

// checkAPIError: VK answers HTTP 200 with { error } instead of { response }
// on failures, so Fetch never sees them and the post used to be marked
// completed.
func (p *Provider) checkAPIError(raw []byte) error {
	var all struct {
		Error map[string]any `json:"error"`
	}
	if json.Unmarshal(raw, &all) != nil || all.Error == nil {
		return nil
	}
	message := "VK rejected the request"
	if communityutil.Truthy(all.Error["error_msg"]) {
		message = communityutil.JSString(all.Error["error_msg"])
	}
	code, _ := all.Error["error_code"].(float64)
	if code == 5 {
		return temporalx.RefreshToken(identifier, string(raw), "{}", message)
	}
	if slices.Contains([]float64{6, 9, 29}, code) {
		return errors.New(message)
	}
	return temporalx.BadBody(identifier, string(raw), "{}", message)
}

func attachments(userID string, list []uploaded) string {
	parts := make([]string, 0, len(list))
	for _, m := range list {
		parts = append(parts, m.kind+userID+"_"+m.id)
	}
	return strings.Join(parts, ",")
}

func (p *Provider) send(ctx context.Context, url string, fields []field) (map[string]any, error) {
	res, err := p.postForm(ctx, url, fields...)
	if err != nil {
		return nil, err
	}
	if err := p.checkAPIError(res.Body); err != nil {
		return nil, err
	}
	var all struct {
		Response map[string]any `json:"response"`
	}
	if err := res.JSON(&all); err != nil {
		return nil, err
	}
	return all.Response, nil
}

func (p *Provider) Post(ctx context.Context, userID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	first := posts[0]
	mediaList, err := p.uploadMedia(ctx, userID, accessToken, first)
	if err != nil {
		return nil, err
	}
	fields := []field{{"message", first.Message}}
	if len(mediaList) > 0 {
		fields = append(fields, field{"attachments", attachments(userID, mediaList)})
	}
	response, err := p.send(ctx, apiURL+"/method/wall.post?v=5.251&access_token="+accessToken+"&client_id="+os.Getenv("VK_ID"), fields)
	if err != nil {
		return nil, err
	}
	postID := jsConcat(response["post_id"])
	return []integrations.PostResponse{{
		ID:         first.ID,
		PostID:     postID,
		ReleaseURL: "https://vk.com/feed?w=wall" + userID + "_" + postID,
		Status:     "completed",
	}}, nil
}

func (p *Provider) Comment(ctx context.Context, userID, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	comment := posts[0]
	mediaList, err := p.uploadMedia(ctx, userID, accessToken, comment)
	if err != nil {
		return nil, err
	}
	fields := []field{{"message", comment.Message}, {"post_id", postID}}
	if len(mediaList) > 0 {
		fields = append(fields, field{"attachments", attachments(userID, mediaList)})
	}
	response, err := p.send(ctx, apiURL+"/method/wall.createComment?v=5.251&access_token="+accessToken+"&client_id="+os.Getenv("VK_ID"), fields)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         comment.ID,
		PostID:     jsConcat(response["comment_id"]),
		ReleaseURL: "https://vk.com/feed?w=wall" + userID + "_" + postID,
		Status:     "completed",
	}}, nil
}
