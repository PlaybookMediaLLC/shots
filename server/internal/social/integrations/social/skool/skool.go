// Package skool is the Skool provider: Skool community posts, connected
// with session cookies read by the Chrome extension.
package skool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/internal/communityutil"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "skool"

// apiURL is overridden by tests.
var apiURL = "https://api2.skool.com"

var extensionCookies = []integrations.ExtensionCookie{
	{Name: "client_id", Domain: ".skool.com"},
	{Name: "auth_token", Domain: ".skool.com"},
}

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

// SettingsDTO is SkoolDto.
type SettingsDTO struct {
	Group *string `json:"group"`
	Label *string `json:"label"`
	Title *string `json:"title"`
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
	required("group", d.Group)
	required("label", d.Label)
	required("title", d.Title)
	return errs
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:        identifier,
		Name:              "Skool",
		Editor:            "normal",
		Scopes:            []string{},
		IsChromeExtension: true,
		ExtensionCookies:  extensionCookies,
		MaxConcurrentJob:  1,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 5000 }

func (p *Provider) SettingsDTO() any { return &SettingsDTO{} }

func handleErrors(body string, _ int) *integrations.HandledError {
	if strings.Contains(body, "must be admin or level") {
		return &integrations.HandledError{Type: "bad-body", Value: "You can't post to this channel"}
	}
	if strings.Contains(body, "cannot post to this label") {
		return &integrations.HandledError{Type: "bad-body", Value: "Cannot post to this label"}
	}
	return nil
}

type cookies struct {
	ClientID  string `json:"client_id"`
	AuthToken string `json:"auth_token"`
}

func (c cookies) header() string {
	return "auth_token=" + c.AuthToken + "; client_id=" + c.ClientID
}

func getCookies(integration *ent.Integration) (cookies, error) {
	var out cookies
	if integration == nil || integration.CustomInstanceDetails == nil {
		return out, errors.New("jwt must be provided")
	}
	stored := *integration.CustomInstanceDetails
	// Current format: credentials stored as at-rest AES-encrypted JSON.
	if plain, err := helpers.FixedDecryption(stored); err == nil {
		if err := json.Unmarshal([]byte(plain), &out); err == nil {
			return out, nil
		}
	}
	// Legacy format: Skool accounts connected before the storage format was
	// changed kept their credentials as a signed JWT. Read those as-is so
	// already-connected accounts keep working without a reconnect.
	claims, err := helpers.VerifyJWT(stored)
	if err != nil {
		return cookies{}, err
	}
	out = cookies{ClientID: communityutil.JSString(claims["client_id"]), AuthToken: communityutil.JSString(claims["auth_token"])}
	return out, nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{URL: state, CodeVerifier: ids.Secure(10), State: state}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	details, err := p.authenticate(ctx, params.Code)
	if err != nil {
		var msg integrations.AuthMessage
		if errors.As(err, &msg) {
			return nil, msg
		}
		return nil, integrations.AuthMessage("Invalid cookie data")
	}
	return details, nil
}

func (p *Provider) authenticate(ctx context.Context, code string) (*integrations.AuthTokenDetails, error) {
	raw := []byte(communityutil.DecodeBase64(code))
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	var missing []string
	for _, c := range extensionCookies {
		if !communityutil.Truthy(parsed[c.Name]) {
			missing = append(missing, c.Name)
		}
	}
	if len(missing) > 0 {
		return nil, integrations.AuthMessage("Missing required cookies: " + strings.Join(missing, ", "))
	}
	c := cookies{ClientID: communityutil.JSString(parsed["client_id"]), AuthToken: communityutil.JSString(parsed["auth_token"])}
	res, err := communityutil.Fetch(ctx, http.MethodGet, apiURL+"/self", map[string]string{"Cookie": c.header()}, nil)
	if err != nil {
		return nil, err
	}
	var data struct {
		ID        any             `json:"id"`
		FirstName any             `json:"first_name"`
		LastName  any             `json:"last_name"`
		Name      any             `json:"name"`
		Metadata  *map[string]any `json:"metadata"`
	}
	if err := res.JSON(&data); err != nil {
		return nil, err
	}
	if data.Metadata == nil {
		return nil, errors.New("Cannot read properties of undefined (reading 'picture_profile')")
	}
	picture := ""
	if communityutil.Truthy((*data.Metadata)["picture_profile"]) {
		picture = communityutil.JSString((*data.Metadata)["picture_profile"])
	}
	// JSON.stringify(JSON.parse(code)): same keys in the same order.
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, err
	}
	accessToken, err := helpers.FixedEncryption(compact.String())
	if err != nil {
		return nil, err
	}
	now := time.Now()
	return &integrations.AuthTokenDetails{
		ExpiresIn:   now.AddDate(100, 0, 0).Unix() - now.Unix(),
		AccessToken: accessToken,
		ID:          communityutil.JSString(data.ID),
		Name:        jsConcat(data.FirstName) + " " + jsConcat(data.LastName),
		Picture:     picture,
		Username:    communityutil.JSString(data.Name),
	}, nil
}

// jsConcat is a value inside string concatenation (undefined stays visible).
func jsConcat(v any) string {
	if v == nil {
		return "undefined"
	}
	return communityutil.JSString(v)
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{
		{MethodName: "groups", Description: "Groups", DataSchema: []integrations.ToolField{}},
		{MethodName: "label", Description: "Label", DataSchema: []integrations.ToolField{}},
	}
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"groups": func(ctx context.Context, _ string, _ json.RawMessage, id string, integration *ent.Integration) (any, error) {
			return p.Groups(ctx, id, integration), nil
		},
		"label": func(ctx context.Context, _ string, data json.RawMessage, _ string, integration *ent.Integration) (any, error) {
			var params struct {
				ID any `json:"id"`
			}
			_ = json.Unmarshal(data, &params)
			return p.Label(ctx, communityutil.JSString(params.ID), integration), nil
		},
	}
}

type named struct {
	ID       any `json:"id"`
	Metadata struct {
		DisplayName any `json:"display_name"`
	} `json:"metadata"`
}

// Groups is the @Tool listing the user's groups; failures give [].
func (p *Provider) Groups(ctx context.Context, id string, integration *ent.Integration) []communityutil.Option {
	out := []communityutil.Option{}
	c, err := getCookies(integration)
	if err != nil {
		return out
	}
	res, err := communityutil.Fetch(ctx, http.MethodGet, apiURL+"/users/"+id+"/groups?offset=0&limit=30", map[string]string{"Cookie": c.header()}, nil)
	if err != nil {
		return out
	}
	var body struct {
		Groups []named `json:"groups"`
	}
	if res.JSON(&body) != nil {
		return out
	}
	for _, g := range body.Groups {
		out = append(out, communityutil.Option{ID: communityutil.JSString(g.ID), Name: g.Metadata.DisplayName})
	}
	return out
}

// Label is the @Tool listing a group's labels; failures give [].
func (p *Provider) Label(ctx context.Context, groupID string, integration *ent.Integration) []communityutil.Option {
	c, err := getCookies(integration)
	if err != nil {
		return []communityutil.Option{}
	}
	headers := map[string]string{"Cookie": c.header()}
	res, err := p.Fetch(ctx, apiURL+"/groups/"+groupID, integrations.Request{Headers: headers})
	if err != nil {
		return []communityutil.Option{}
	}
	var group struct {
		Metadata *struct {
			Labels string `json:"labels"`
		} `json:"metadata"`
	}
	if res.JSON(&group) != nil || group.Metadata == nil {
		return []communityutil.Option{}
	}
	if group.Metadata.Labels == "" {
		return []communityutil.Option{{ID: "none", Name: "Default Label"}}
	}
	// ponytail: sequential where TS used Promise.all; same result, slower with many labels.
	out := []communityutil.Option{}
	for _, labelID := range strings.Split(group.Metadata.Labels, ",") {
		res, err := p.Fetch(ctx, apiURL+"/labels/"+labelID, integrations.Request{Headers: headers})
		if err != nil {
			return []communityutil.Option{}
		}
		var label named
		if res.JSON(&label) != nil {
			return []communityutil.Option{}
		}
		out = append(out, communityutil.Option{ID: communityutil.JSString(label.ID), Name: label.Metadata.DisplayName})
	}
	return out
}

func (p *Provider) uploadMediaToSkool(ctx context.Context, media []integrations.MediaContent, userID string, c cookies) (string, error) {
	var fileIDs []string
	for _, item := range media {
		// Size and type come from a HEAD request; the PUT below streams the
		// bytes so the file is never buffered in memory.
		head, err := http.NewRequestWithContext(ctx, http.MethodHead, item.Path, nil)
		if err != nil {
			return "", err
		}
		head.Header.Set("Accept-Encoding", "identity")
		headRes, err := ssrf.Client().Do(head)
		if err != nil {
			return "", err
		}
		headRes.Body.Close()
		contentType := headRes.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		var contentLength int64
		fmt.Sscan(headRes.Header.Get("Content-Length"), &contentLength)
		if !communityutil.OK(headRes.StatusCode) || contentLength <= 0 {
			// A permanent condition - fail fast instead of letting Temporal retry
			return "", temporalx.BadBody(identifier, "{}", "{}", "Could not determine the media size for upload")
		}
		fileName := communityutil.LastSegment(item.Path)
		if fileName == "" {
			fileName = "file"
		}
		body, _ := json.Marshal(struct {
			FileName           string `json:"file_name"`
			ContentType        string `json:"content_type"`
			ContentLength      int64  `json:"content_length"`
			ContentDisposition string `json:"content_disposition"`
			Ref                string `json:"ref"`
			OwnerID            string `json:"owner_id"`
			LargeThumbnail     bool   `json:"large_thumbnail"`
		}{fileName, contentType, contentLength, "", "", userID, false})
		res, err := p.Fetch(ctx, apiURL+"/files", integrations.Request{
			Method:  http.MethodPost,
			Headers: map[string]string{"Content-Type": "application/json", "Cookie": c.header()},
			Body:    body,
		})
		if err != nil {
			return "", err
		}
		var created struct {
			WriteURL    string `json:"write_url"`
			ContentType string `json:"content_type"`
			ACL         string `json:"acl"`
			File        struct {
				ID any `json:"id"`
			} `json:"file"`
		}
		if err := res.JSON(&created); err != nil {
			return "", err
		}
		if err := put(ctx, item.Path, created.WriteURL, created.ContentType, created.ACL, contentLength); err != nil {
			return "", err
		}
		fileIDs = append(fileIDs, communityutil.JSString(created.File.ID))
	}
	return strings.Join(fileIDs, ","), nil
}

func put(ctx context.Context, mediaPath, writeURL, contentType, acl string, contentLength int64) error {
	get, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaPath, nil)
	if err != nil {
		return err
	}
	get.Header.Set("Accept-Encoding", "identity")
	file, err := ssrf.StreamingClient().Do(get)
	if err != nil {
		return err
	}
	defer file.Body.Close()
	if !communityutil.OK(file.StatusCode) {
		return fmt.Errorf("Failed to fetch media: %s", communityutil.StatusText(file))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, writeURL, file.Body)
	if err != nil {
		return err
	}
	req.ContentLength = contentLength
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("x-amz-acl", acl)
	res, err := ssrf.StreamingClient().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// A rejected PUT would otherwise publish the post with an empty
	// attachment - the file id exists but no bytes were stored.
	if !communityutil.OK(res.StatusCode) {
		text, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		if err != nil {
			text = []byte("{}")
		}
		return temporalx.BadBody(identifier, string(text), "{}", "Failed to upload the media file")
	}
	return nil
}

type metadata struct {
	Title       *string `json:"title,omitempty"`
	Content     string  `json:"content"`
	Attachments string  `json:"attachments"`
	Labels      *string `json:"labels,omitempty"`
	Action      int     `json:"action"`
	VideoIDs    string  `json:"video_ids"`
}

type skoolPost struct {
	PostType string   `json:"post_type"`
	GroupID  *string  `json:"group_id,omitempty"`
	RootID   string   `json:"root_id,omitempty"`
	ParentID string   `json:"parent_id,omitempty"`
	Metadata metadata `json:"metadata"`
}

func (p *Provider) create(ctx context.Context, c cookies, body skoolPost) (postID any, name string, err error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, "", err
	}
	res, err := p.Fetch(ctx, apiURL+"/posts?follow=true", integrations.Request{
		Method:  http.MethodPost,
		Headers: map[string]string{"Cookie": c.header()},
		Body:    data,
	})
	if err != nil {
		return nil, "", err
	}
	var out struct {
		ID   any `json:"id"`
		Name any `json:"name"`
	}
	if err := res.JSON(&out); err != nil {
		return nil, "", err
	}
	return out.ID, communityutil.JSString(out.Name), nil
}

func group(s SettingsDTO) string {
	if s.Group == nil {
		return "undefined"
	}
	return *s.Group
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	c, err := getCookies(integration)
	if err != nil {
		return nil, err
	}
	post := posts[0]
	var settings SettingsDTO
	if err := communityutil.DecodeSettings(post.Settings, &settings); err != nil {
		return nil, err
	}
	attachments, err := p.uploadMediaToSkool(ctx, post.Media, id, c)
	if err != nil {
		return nil, err
	}
	meta := metadata{Title: settings.Title, Content: post.Message, Attachments: attachments}
	if settings.Label != nil && *settings.Label != "" && *settings.Label != "none" {
		meta.Labels = settings.Label
	}
	postID, name, err := p.create(ctx, c, skoolPost{PostType: "generic", GroupID: settings.Group, Metadata: meta})
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         communityutil.JSString(postID),
		PostID:     communityutil.JSString(postID),
		ReleaseURL: "https://www.skool.com/" + group(settings) + "/" + name,
		Status:     "success",
	}}, nil
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, integration *ent.Integration) ([]integrations.PostResponse, error) {
	c, err := getCookies(integration)
	if err != nil {
		return nil, err
	}
	post := posts[0]
	var settings SettingsDTO
	if err := communityutil.DecodeSettings(post.Settings, &settings); err != nil {
		return nil, err
	}
	attachments, err := p.uploadMediaToSkool(ctx, post.Media, id, c)
	if err != nil {
		return nil, err
	}
	parentID := lastCommentID
	if parentID == "" {
		parentID = postID
	}
	finalID, name, err := p.create(ctx, c, skoolPost{
		PostType: "comment", GroupID: settings.Group, RootID: postID, ParentID: parentID,
		Metadata: metadata{Title: new(string), Content: post.Message, Attachments: attachments},
	})
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         id,
		PostID:     communityutil.JSString(finalID),
		ReleaseURL: "https://www.skool.com/" + group(settings) + "/" + name,
		Status:     "success",
	}}, nil
}
