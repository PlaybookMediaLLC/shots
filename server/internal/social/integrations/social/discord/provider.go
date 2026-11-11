// Package discord is the Discord provider.
package discord

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path"
	"regexp"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
)

const identifier = "discord"

// apiBase is overridden by tests.
var apiBase = "https://discord.com"

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, handleErrors)}
}

var scopes = []string{"identify", "guilds"}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "Discord",
		Editor:           "markdown",
		Scopes:           scopes,
		MaxConcurrentJob: 5, // Discord has generous rate limits for webhook posting
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 1980 }

func (p *Provider) SettingsDTO() any { return &DiscordDto{} }

func basicAuth() string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(os.Getenv("DISCORD_CLIENT_ID")+":"+os.Getenv("DISCORD_CLIENT_SECRET")))
}

func bot() string { return "Bot " + os.Getenv("DISCORD_BOT_TOKEN_ID") }

func redirectURI() string { return os.Getenv("FRONTEND_URL") + "/integrations/social/discord" }

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	ExpiresIn    int64  `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
	Guild        struct {
		ID string `json:"id"`
	} `json:"guild"`
}

type application struct {
	Name string `json:"name"`
	Bot  struct {
		ID       string `json:"id"`
		Avatar   string `json:"avatar"`
		Username string `json:"username"`
	} `json:"bot"`
}

func (p *Provider) token(ctx context.Context, form url.Values) (*tokenResponse, error) {
	res, err := p.Fetch(ctx, apiBase+"/api/oauth2/token", integrations.Request{
		Method: "POST",
		Body:   []byte(form.Encode()),
		Headers: map[string]string{
			"Content-Type":  "application/x-www-form-urlencoded",
			"Authorization": basicAuth(),
		},
	})
	if err != nil {
		return nil, err
	}
	var token tokenResponse
	return &token, res.JSON(&token)
}

func (p *Provider) application(ctx context.Context, accessToken string) (*application, error) {
	res, err := p.Fetch(ctx, apiBase+"/api/oauth2/@me", integrations.Request{
		Headers: map[string]string{"Authorization": "Bearer " + accessToken},
	})
	if err != nil {
		return nil, err
	}
	var me struct {
		Application application `json:"application"`
	}
	return &me.Application, res.JSON(&me)
}

func (p *Provider) RefreshToken(ctx context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, url.Values{"refresh_token": {refreshToken}, "grant_type": {"refresh_token"}})
	if err != nil {
		return nil, err
	}
	app, err := p.application(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		RefreshToken: token.RefreshToken,
		ExpiresIn:    token.ExpiresIn,
		AccessToken:  token.AccessToken,
		Name:         app.Name,
	}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	return &integrations.GenerateAuthURLResponse{
		URL: "https://discord.com/oauth2/authorize?client_id=" + os.Getenv("DISCORD_CLIENT_ID") +
			"&permissions=377957124096&response_type=code&redirect_uri=" + url.QueryEscape(redirectURI()) +
			"&integration_type=0&scope=bot+identify+guilds&state=" + state,
		CodeVerifier: ids.Secure(10),
		State:        state,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	token, err := p.token(ctx, url.Values{
		"code":         {params.Code},
		"grant_type":   {"authorization_code"},
		"redirect_uri": {redirectURI()},
	})
	if err != nil {
		return nil, err
	}
	if err := p.CheckScopes(scopes, strings.Split(token.Scope, " ")); err != nil {
		return nil, err
	}
	app, err := p.application(ctx, token.AccessToken)
	if err != nil {
		return nil, err
	}
	return &integrations.AuthTokenDetails{
		ID:           token.Guild.ID,
		Name:         app.Name,
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		ExpiresIn:    token.ExpiresIn,
		Picture:      "https://cdn.discordapp.com/avatars/" + app.Bot.ID + "/" + app.Bot.Avatar + ".png",
		Username:     app.Bot.Username,
	}, nil
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{{MethodName: "channels", Description: "Channels", DataSchema: []integrations.ToolField{}}}
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"channels": func(ctx context.Context, accessToken string, _ json.RawMessage, internalID string, _ *ent.Integration) (any, error) {
			return p.Channels(ctx, accessToken, internalID)
		},
	}
}

type Channel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (p *Provider) Channels(ctx context.Context, _ string, id string) ([]Channel, error) {
	res, err := p.Fetch(ctx, apiBase+"/api/guilds/"+id+"/channels", integrations.Request{
		Headers: map[string]string{"Authorization": bot()},
	})
	if err != nil {
		return nil, err
	}
	var list []struct {
		ID   json.Number `json:"id"`
		Name string      `json:"name"`
		Type int         `json:"type"`
	}
	if err := res.JSON(&list); err != nil {
		return nil, err
	}
	out := []Channel{}
	for _, c := range list {
		if c.Type == 0 || c.Type == 5 || c.Type == 15 {
			out = append(out, Channel{ID: c.ID.String(), Name: c.Name})
		}
	}
	return out, nil
}

var mentionTag = regexp.MustCompile(`\[\[\[(@.*?)]]]`)

type attachment struct {
	ID          int    `json:"id"`
	Description string `json:"description"`
	Filename    string `json:"filename"`
}

type messagePayload struct {
	Content     string       `json:"content"`
	Attachments []attachment `json:"attachments,omitempty"`
}

func filename(p string) string { return p[strings.LastIndex(p, "/")+1:] }

// sendMessageWithMedia builds the multipart message and streams each
// attachment straight from its source (size from a HEAD request) so files are
// never buffered in memory. RunStreamedUpload rebuilds the whole form per
// attempt (a consumed stream can't be replayed) and keeps handleErrors
// classification.
func (p *Provider) sendMessageWithMedia(ctx context.Context, channel, message string, media []integrations.MediaContent) (string, error) {
	return integrations.RunStreamedUpload(ctx, p.Base, false, func() (string, error) {
		payload := messagePayload{Content: mentionTag.ReplaceAllString(message, "<$1>")}
		if media != nil {
			payload.Attachments = []attachment{}
			for i, m := range media {
				payload.Attachments = append(payload.Attachments, attachment{ID: i, Description: fmt.Sprintf("Picture %d", i), Filename: filename(m.Path)})
			}
		}
		// JSON.stringify does not escape <, > and & (the mentions are <@id>).
		var payloadJSON bytes.Buffer
		enc := json.NewEncoder(&payloadJSON)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(payload); err != nil {
			return "", err
		}

		// The form is a list of segments so its Content-Length is known
		// (form-data's knownLength) while the files stay streamed.
		var segments []io.Reader
		var length int64
		var buf bytes.Buffer
		w := multipart.NewWriter(&buf)
		flush := func() {
			segments = append(segments, bytes.NewReader(bytes.Clone(buf.Bytes())))
			length += int64(buf.Len())
			buf.Reset()
		}
		_ = w.WriteField("payload_json", strings.TrimSuffix(payloadJSON.String(), "\n"))
		for i, item := range media {
			size, err := p.MediaSize(ctx, item.Path, identifier)
			if err != nil {
				return "", err
			}
			stream, err := p.MediaStream(ctx, item.Path, identifier)
			if err != nil {
				return "", err
			}
			defer stream.Close()
			contentType := mime.TypeByExtension(path.Ext(filename(item.Path)))
			if contentType == "" {
				contentType = "application/octet-stream"
			}
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files[%d]"; filename="%s"`, i, filename(item.Path)))
			h.Set("Content-Type", contentType)
			if _, err := w.CreatePart(h); err != nil {
				return "", err
			}
			flush()
			segments = append(segments, io.LimitReader(stream, size))
			length += size
		}
		if err := w.Close(); err != nil {
			return "", err
		}
		flush()

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBase+"/api/channels/"+channel+"/messages", io.MultiReader(segments...))
		if err != nil {
			return "", err
		}
		req.ContentLength = length
		req.Header.Set("Content-Type", w.FormDataContentType())
		req.Header.Set("Authorization", bot())
		res, err := integrations.Do(req)
		if err != nil {
			return "", err
		}
		var data struct {
			ID string `json:"id"`
		}
		return data.ID, res.JSON(&data)
	})
}

type settings struct {
	Channel string `json:"channel"`
}

func channelOf(raw json.RawMessage) string {
	var s settings
	_ = json.Unmarshal(raw, &s)
	return s.Channel
}

func (p *Provider) Post(ctx context.Context, id, _ string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	first := posts[0]
	channel := channelOf(first.Settings)
	messageID, err := p.sendMessageWithMedia(ctx, channel, first.Message, first.Media)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         first.ID,
		ReleaseURL: "https://discord.com/channels/" + id + "/" + channel + "/" + messageID,
		PostID:     messageID,
		Status:     "success",
	}}, nil
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, _ string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	commentPost := posts[0]
	channel := channelOf(commentPost.Settings)

	// For Discord, comments go in a thread created from the original message
	// on the first comment.
	threadChannel := channel
	if lastCommentID == "" {
		body, _ := json.Marshal(map[string]any{"name": "Thread", "auto_archive_duration": 1440})
		res, err := p.Fetch(ctx, apiBase+"/api/channels/"+channel+"/messages/"+postID+"/threads", integrations.Request{
			Method:  "POST",
			Headers: map[string]string{"Authorization": bot(), "Content-Type": "application/json"},
			Body:    body,
		})
		if err != nil {
			return nil, err
		}
		var thread struct {
			ID string `json:"id"`
		}
		if err := res.JSON(&thread); err != nil {
			return nil, err
		}
		threadChannel = thread.ID
	}

	messageID, err := p.sendMessageWithMedia(ctx, threadChannel, commentPost.Message, commentPost.Media)
	if err != nil {
		return nil, err
	}
	return []integrations.PostResponse{{
		ID:         commentPost.ID,
		ReleaseURL: "https://discord.com/channels/" + id + "/" + threadChannel + "/" + messageID,
		PostID:     messageID,
		Status:     "success",
	}}, nil
}

func (p *Provider) ChangeNickname(ctx context.Context, id, _, name string) (string, error) {
	body, _ := json.Marshal(map[string]string{"nick": name})
	res, err := p.Fetch(ctx, apiBase+"/api/guilds/"+id+"/members/@me", integrations.Request{
		Method:  "PATCH",
		Headers: map[string]string{"Authorization": bot(), "Content-Type": "application/json"},
		Body:    body,
	})
	if err != nil {
		return "", err
	}
	var ignored any
	if err := res.JSON(&ignored); err != nil {
		return "", err
	}
	return name, nil
}

func (p *Provider) Mention(ctx context.Context, _, query, id string, _ *ent.Integration) ([]integrations.MentionResult, bool, error) {
	headers := map[string]string{"Authorization": bot(), "Content-Type": "application/json"}
	res, err := p.Fetch(ctx, apiBase+"/api/guilds/"+id+"/roles", integrations.Request{Headers: headers})
	if err != nil {
		return nil, false, err
	}
	var roles []struct {
		ID   json.Number `json:"id"`
		Name string      `json:"name"`
	}
	if err := res.JSON(&roles); err != nil {
		return nil, false, err
	}

	res, err = p.Fetch(ctx, apiBase+"/api/guilds/"+id+"/members/search?query="+url.QueryEscape(query), integrations.Request{Headers: headers})
	if err != nil {
		return nil, false, err
	}
	var members []struct {
		User struct {
			ID         json.Number `json:"id"`
			GlobalName string      `json:"global_name"`
			Username   string      `json:"username"`
			Avatar     *string     `json:"avatar"`
		} `json:"user"`
	}
	if err := res.JSON(&members); err != nil {
		return nil, false, err
	}

	q := strings.ToLower(query)
	out := []integrations.MentionResult{}
	for _, special := range []string{"here", "everyone"} {
		if strings.Contains(special, q) {
			out = append(out, integrations.MentionResult{ID: special, Label: special, DoNotCache: true})
		}
	}
	for _, role := range roles {
		if !strings.Contains(strings.ToLower(role.Name), q) || role.Name == "@everyone" || role.Name == "@here" {
			continue
		}
		label := ""
		if parts := strings.Split(role.Name, "@"); len(parts) > 1 {
			label = parts[1]
		}
		out = append(out, integrations.MentionResult{ID: "&" + role.ID.String(), Label: label, DoNotCache: true})
	}
	for _, m := range members {
		label := m.User.GlobalName
		if label == "" {
			label = m.User.Username
		}
		avatar := "null"
		if m.User.Avatar != nil {
			avatar = *m.User.Avatar
		}
		out = append(out, integrations.MentionResult{
			ID:    m.User.ID.String(),
			Label: label,
			Image: "https://cdn.discordapp.com/avatars/" + m.User.ID.String() + "/" + avatar + ".png",
		})
	}
	return out, false, nil
}

func (p *Provider) MentionFormat(idOrHandle, name string) string {
	if name == "@here" || name == "@everyone" {
		return name
	}
	return "[[[@" + strings.Replace(idOrHandle, "@", "", 1) + "]]]"
}

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "50001"):
		return &integrations.HandledError{Type: "bad-body", Value: "Bot doesn't have access to this channel"}
	case strings.Contains(body, "50013"):
		return &integrations.HandledError{Type: "bad-body", Value: "Bot lacks permission to send messages in this channel"}
	case strings.Contains(body, "10003"):
		return &integrations.HandledError{Type: "bad-body", Value: "Channel no longer exists"}
	case strings.Contains(body, "40005"):
		return &integrations.HandledError{Type: "bad-body", Value: "Attachment exceeds Discord's size limit"}
	case strings.Contains(body, "20028"):
		return &integrations.HandledError{Type: "retry", Value: "Rate limited by Discord"}
	}
	return nil
}
