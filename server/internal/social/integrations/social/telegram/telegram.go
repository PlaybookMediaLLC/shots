// Package telegram is the Telegram provider. node-telegram-bot-api is
// replaced by direct Bot API calls with the same parameters, including its
// upload of local files (a media path that exists on disk is sent as
// multipart, anything else is passed to Telegram as a URL).
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

const identifier = "telegram"

// Overridden by tests.
var (
	apiURL            = "https://api.telegram.org"
	deleteSuccessWait = 10 * time.Second
)

type Provider struct {
	*integrations.Base
}

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, nil)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier:       identifier,
		Name:             "Telegram",
		Editor:           "html",
		Scopes:           []string{},
		IsWeb3:           true,
		MaxConcurrentJob: 3, // Telegram has moderate bot API limits
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 4096 }

// APIError is node-telegram-bot-api's ETELEGRAM error: Telegram answered
// ok=false. Body is the parsed response.
type APIError struct {
	Body map[string]any
	Raw  []byte
}

func (e *APIError) Error() string {
	return fmt.Sprintf("ETELEGRAM: %v %v", e.Body["error_code"], e.Body["description"])
}

func (e *APIError) code() float64 {
	code, _ := e.Body["error_code"].(float64)
	return code
}

// file is a local file sent as multipart, like node-telegram-bot-api does for
// paths that exist on disk.
type file struct {
	field, path, filename, contentType string
}

// call invokes a Bot API method with TELEGRAM_TOKEN, as a form when there is
// no file and multipart otherwise, and decodes `result` into out.
func call(ctx context.Context, method string, params url.Values, files []file, out any) error {
	endpoint := apiURL + "/bot" + os.Getenv("TELEGRAM_TOKEN") + "/" + method
	var body bytes.Buffer
	contentType := "application/x-www-form-urlencoded"
	if len(files) == 0 {
		body.WriteString(params.Encode())
	} else {
		w := multipart.NewWriter(&body)
		for k, vs := range params {
			for _, v := range vs {
				if err := w.WriteField(k, v); err != nil {
					return err
				}
			}
		}
		for _, f := range files {
			data, err := os.ReadFile(f.path)
			if err != nil {
				return err
			}
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, f.field, f.filename))
			h.Set("Content-Type", f.contentType)
			part, err := w.CreatePart(h)
			if err != nil {
				return err
			}
			if _, err := part.Write(data); err != nil {
				return err
			}
		}
		if err := w.Close(); err != nil {
			return err
		}
		contentType = w.FormDataContentType()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return fmt.Errorf("EFATAL: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return fmt.Errorf("EFATAL: %w", err)
	}
	var envelope map[string]any
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("EPARSE: %s", raw)
	}
	if ok, _ := envelope["ok"].(bool); !ok {
		return &APIError{Body: envelope, Raw: raw}
	}
	if out == nil {
		return nil
	}
	result, _ := json.Marshal(envelope["result"])
	return json.Unmarshal(result, out)
}

type chat struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	Username string `json:"username"`
	Photo    *struct {
		BigFileID string `json:"big_file_id"`
	} `json:"photo"`
}

type message struct {
	MessageID int64  `json:"message_id"`
	Text      string `json:"text"`
	Chat      *chat  `json:"chat"`
}

type update struct {
	UpdateID    int64    `json:"update_id"`
	Message     *message `json:"message"`
	ChannelPost *message `json:"channel_post"`
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(17)
	return &integrations.GenerateAuthURLResponse{URL: state, CodeVerifier: ids.Secure(10), State: state}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	var c chat
	if err := call(ctx, "getChat", url.Values{"chat_id": {params.Code}}, nil, &c); err != nil {
		return nil, err
	}
	data, _ := json.Marshal(c)
	log.Println(string(data))
	if c.ID == 0 {
		return nil, integrations.AuthMessage("No chat found")
	}
	photo := ""
	if c.Photo != nil && c.Photo.BigFileID != "" {
		var f struct {
			FilePath string `json:"file_path"`
		}
		if err := call(ctx, "getFile", url.Values{"file_id": {c.Photo.BigFileID}}, nil, &f); err != nil {
			return nil, err
		}
		photo = apiURL + "/file/bot" + os.Getenv("TELEGRAM_TOKEN") + "/" + f.FilePath
	}
	// The id is chat.username for public groups/channels, chat.id for private
	// ones that have no username.
	id := c.Username
	if id == "" {
		id = strconv.FormatInt(c.ID, 10)
	}
	now := time.Now()
	return &integrations.AuthTokenDetails{
		ID:          id,
		Name:        c.Title,
		AccessToken: strconv.FormatInt(c.ID, 10),
		ExpiresIn:   now.AddDate(200, 0, 0).Unix() - now.Unix(),
		Picture:     photo,
		Username:    c.Username,
	}, nil
}

// BotIDQuery is the /integrations/telegram/updates query.
type BotIDQuery struct {
	ID   string `json:"id"`
	Word string `json:"word"`
}

// BotIDResult is {chatId}, {lastChatId} or {}.
type BotIDResult struct {
	ChatID     int64 `json:"chatId,omitempty"`
	LastChatID int64 `json:"lastChatId,omitempty"`
}

// GetBotID looks for the "/connect <word>" message in the bot's updates.
func (p *Provider) GetBotID(ctx context.Context, query BotIDQuery) (*BotIDResult, error) {
	params := url.Values{"allowed_updates": {`["message","channel_post"]`}}
	if query.ID != "" {
		params.Set("offset", query.ID)
	}
	var res []update
	if err := call(ctx, "getUpdates", params, nil, &res); err != nil {
		return nil, err
	}
	// message.text is for groups, channel_post.text is for channels
	command := "/connect " + query.Word
	var match *update
	for i := range res {
		u := &res[i]
		if (u.Message != nil && u.Message.Text == command && u.Message.Chat != nil && u.Message.Chat.ID != 0) ||
			(u.ChannelPost != nil && u.ChannelPost.Text == command && u.ChannelPost.Chat != nil && u.ChannelPost.Chat.ID != 0) {
			match = u
			break
		}
	}
	var chatID, connectMessageID int64
	if match != nil {
		if match.Message != nil && match.Message.Chat != nil && match.Message.Chat.ID != 0 {
			chatID = match.Message.Chat.ID
		} else if match.ChannelPost != nil && match.ChannelPost.Chat != nil {
			chatID = match.ChannelPost.Chat.ID
		}
		if match.Message != nil && match.Message.MessageID != 0 {
			connectMessageID = match.Message.MessageID
		} else if match.ChannelPost != nil {
			connectMessageID = match.ChannelPost.MessageID
		}
	}

	// Skipped while chatId is unknown, which avoids Telegram's "chat_id is empty".
	if chatID != 0 {
		var me struct {
			ID int64 `json:"id"`
		}
		if err := call(ctx, "getMe", url.Values{}, nil, &me); err != nil {
			return nil, err
		}
		chatIDText := strconv.FormatInt(chatID, 10)
		if !p.BotIsAdmin(ctx, chatID, me.ID) {
			go call(context.Background(), "sendMessage", url.Values{ //nolint:errcheck // fire and forget, like the TS
				"chat_id": {chatIDText},
				"text":    {"Connection Successful. I don't have admin privileges to delete these messages, please go ahead and remove them yourself."},
			}, nil, nil)
		} else {
			// Delete the message that triggered the connection
			if err := call(ctx, "deleteMessage", url.Values{"chat_id": {chatIDText}, "message_id": {strconv.FormatInt(connectMessageID, 10)}}, nil, nil); err != nil {
				return nil, err
			}
			var success message
			if err := call(ctx, "sendMessage", url.Values{"chat_id": {chatIDText}, "text": {"Connection Successful. Message will be deleted in 10 seconds."}}, nil, &success); err != nil {
				return nil, err
			}
			time.AfterFunc(deleteSuccessWait, func() {
				if call(context.Background(), "deleteMessage", url.Values{"chat_id": {chatIDText}, "message_id": {strconv.FormatInt(success.MessageID, 10)}}, nil, nil) == nil {
					log.Println("Success message deleted.")
				}
			})
		}
		return &BotIDResult{ChatID: chatID}, nil
	}
	if len(res) > 0 {
		return &BotIDResult{LastChatID: res[len(res)-1].UpdateID + 1}, nil
	}
	return &BotIDResult{}, nil
}

// BotIsAdmin reports whether the bot can delete messages in the chat.
func (p *Provider) BotIsAdmin(ctx context.Context, chatID, botID int64) bool {
	var member struct {
		Status            string `json:"status"`
		CanDeleteMessages bool   `json:"can_delete_messages"`
	}
	err := call(ctx, "getChatMember", url.Values{"chat_id": {strconv.FormatInt(chatID, 10)}, "user_id": {strconv.FormatInt(botID, 10)}}, nil, &member)
	if err != nil {
		log.Println("Error checking bot privileges:", err)
		return false
	}
	if member.Status == "administrator" || member.Status == "creator" {
		return member.CanDeleteMessages
	}
	return false
}

type processedMedia struct {
	kind, media, filename, contentType string
}

func processMedia(media []integrations.MediaContent) []processedMedia {
	frontendURL := os.Getenv("FRONTEND_URL")
	if frontendURL == "" {
		frontendURL = "http://localhost:5000"
	}
	storage := os.Getenv("STORAGE_PROVIDER")
	if storage == "" {
		storage = "local"
	}
	out := make([]processedMedia, 0, len(media))
	for _, m := range media {
		mediaURL := m.Path
		// local storage: post the file from disk
		if storage == "local" && strings.HasPrefix(mediaURL, frontendURL) {
			mediaURL = strings.Replace(mediaURL, frontendURL, "", 1)
		}
		// Media Telegram would reject as photo/video is sent as a document.
		mimeType := communityutil.MimeType(mediaURL)
		kind := "document"
		if strings.HasPrefix(mimeType, "image/") {
			kind = "photo"
		} else if strings.HasPrefix(mimeType, "video/") {
			kind = "video"
		}
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		out = append(out, processedMedia{kind: kind, media: mediaURL, filename: communityutil.LastSegment(m.Path), contentType: mimeType})
	}
	return out
}

// sendData is node-telegram-bot-api's _formatSendData: an existing local
// path becomes a file upload, anything else is sent as is.
func sendData(field, media, filename, contentType string) (file, bool) {
	if info, err := os.Stat(media); err != nil || info.IsDir() {
		return file{}, false
	}
	if filename == "" {
		filename = filepath.Base(media)
	}
	if contentType == "" {
		contentType = communityutil.MimeType(filename)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
	}
	return file{field: field, path: media, filename: filename, contentType: contentType}, true
}

var (
	paragraph = regexp.MustCompile(`<p>(.*?)</p>`)
	strong    = strings.NewReplacer("<strong>", "<b>", "</strong>", "</b>")
)

func (p *Provider) sendMessage(ctx context.Context, accessToken string, post integrations.PostDetails, replyToMessageID int64) (int64, error) {
	id, err := p.sendMessageInternal(ctx, accessToken, post, replyToMessageID)
	// A Telegram 400 is a permanent rejection of this request (caption too
	// long, media Telegram could not download, ...): retrying it can never
	// succeed, so surface it to the user instead.
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.code() == 400 {
		description, _ := apiErr.Body["description"].(string)
		description = strings.Replace(description, "Bad Request: ", "", 1)
		message := "Telegram rejected the post: " + description
		if description == "failed to get HTTP URL content" {
			message = "Telegram could not download your media file, please check the file and try again"
		}
		body, _ := json.Marshal(apiErr.Body)
		return 0, temporalx.BadBody("telegram-error", string(body), string(body), message)
	}
	return id, err
}

func (p *Provider) sendMessageInternal(ctx context.Context, accessToken string, post integrations.PostDetails, replyToMessageID int64) (int64, error) {
	text := strong.Replace(helpers.StripTags(post.Message, []string{"u", "strong", "p"}))
	text = paragraph.ReplaceAllString(text, "$1\n")
	media := processMedia(post.Media)
	reply := ""
	if replyToMessageID != 0 {
		reply = strconv.FormatInt(replyToMessageID, 10)
	}
	params := func(extra url.Values) url.Values {
		extra.Set("chat_id", accessToken)
		extra.Set("parse_mode", "HTML")
		if reply != "" {
			extra.Set("reply_to_message_id", reply)
		}
		return extra
	}

	// no media: a text message only
	if len(media) == 0 {
		var res message
		if err := call(ctx, "sendMessage", params(url.Values{"text": {text}}), nil, &res); err != nil {
			return 0, err
		}
		return res.MessageID, nil
	}

	// one media: the media with the text as caption
	if len(media) == 1 {
		m := media[0]
		form := params(url.Values{"caption": {text}})
		var files []file
		if f, ok := sendData(m.kind, m.media, m.filename, m.contentType); ok {
			files = append(files, f)
		} else {
			form.Set(m.kind, m.media)
		}
		method := map[string]string{"video": "sendVideo", "photo": "sendPhoto", "document": "sendDocument"}[m.kind]
		var res message
		if err := call(ctx, method, form, files, &res); err != nil {
			return 0, err
		}
		return res.MessageID, nil
	}

	// several media: media groups of at most 10, the caption on the first
	// item of the first group only
	var messageID int64
	for i, group := range chunkMedia(media, 10) {
		type inputMedia struct {
			Type      string `json:"type"`
			Caption   string `json:"caption,omitempty"`
			ParseMode string `json:"parse_mode"`
			Media     string `json:"media"`
		}
		var items []inputMedia
		var files []file
		for index, m := range group {
			item := inputMedia{Type: m.kind, ParseMode: "HTML", Media: m.media}
			if i == 0 && index == 0 {
				item.Caption = text
			}
			attachName := strconv.Itoa(index)
			if f, ok := sendData(attachName, m.media, "", ""); ok {
				files = append(files, f)
				item.Media = "attach://" + attachName
			}
			items = append(items, item)
		}
		encoded, err := json.Marshal(items)
		if err != nil {
			return 0, err
		}
		form := url.Values{"chat_id": {accessToken}, "media": {string(encoded)}}
		if reply != "" && i == 0 {
			form.Set("reply_to_message_id", reply)
		}
		var res []message
		if err := call(ctx, "sendMediaGroup", form, files, &res); err != nil {
			return 0, err
		}
		if i == 0 && len(res) > 0 {
			messageID = res[0].MessageID
		}
	}
	return messageID, nil
}

// chunkMedia splits media into groups of size (Telegram allows 10 per group).
func chunkMedia(media []processedMedia, size int) [][]processedMedia {
	var out [][]processedMedia
	for i := 0; i < len(media); i += size {
		out = append(out, media[i:min(i+size, len(media))])
	}
	return out
}

// releaseURL: private groups/channels have no public id, so the link is built
// from the chat id without its -100 prefix.
func releaseURL(id, accessToken string, messageID int64) string {
	if id == "undefined" {
		id = "c/" + strings.Replace(accessToken, "-100", "", 1)
	}
	return fmt.Sprintf("https://t.me/%s/%d", id, messageID)
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	first := posts[0]
	messageID, err := p.sendMessage(ctx, accessToken, first, 0)
	if err != nil {
		return nil, err
	}
	if messageID == 0 {
		return []integrations.PostResponse{}, nil
	}
	return []integrations.PostResponse{{
		ID: first.ID, PostID: strconv.FormatInt(messageID, 10), ReleaseURL: releaseURL(id, accessToken, messageID), Status: "completed",
	}}, nil
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	comment := posts[0]
	replyTo := lastCommentID
	if replyTo == "" {
		replyTo = postID
	}
	replyToID, _ := strconv.ParseInt(strings.TrimSpace(replyTo), 10, 64) // Number(): NaN means no reply
	messageID, err := p.sendMessage(ctx, accessToken, comment, replyToID)
	if err != nil {
		return nil, err
	}
	if messageID == 0 {
		return []integrations.PostResponse{}, nil
	}
	return []integrations.PostResponse{{
		ID: comment.ID, PostID: strconv.FormatInt(messageID, 10), ReleaseURL: releaseURL(id, accessToken, messageID), Status: "completed",
	}}, nil
}
