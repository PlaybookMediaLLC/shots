package socialapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/instances"
)

type AssetReader interface {
	Read(context.Context, string, string) ([]byte, error)
}

type Client struct {
	assetReader AssetReader
	baseURL     string
	httpClient  *http.Client
}

type PublishInput struct {
	// AssetMediaType and AssetObjectKey are the single asset of a job prepared
	// before Assets existed; Media reads either.
	AssetMediaType string
	AssetObjectKey string
	Assets         []publishing.MediaAsset
	// Replies follow the post as a thread, each answering the one before.
	Replies []publishing.PublishReply
	// ReplyTo is the live post a resumed thread answers.
	ReplyTo string
	Poll    *postoptions.Poll
	// Options are the post's settings beyond its text (RFC 025); Document is
	// a LinkedIn PDF and Cover an X article's cover.
	Options          *postoptions.PublishOptions
	Document         *publishing.MediaAsset
	Cover            *publishing.MediaAsset
	Caption          string
	DestinationID    string
	OrganizationID   string
	Platform         string
	PostID           string
	ProviderSettings map[string]any
	SecretReference  string
}

// Receipt is a publication's outcome: the post's id and, for a thread, how
// many replies went out.
type Receipt struct {
	PostID string
	Thread postoptions.ThreadProgress
}

// AutoActionInput asks for a live post's follow-ups: the ones still due.
type AutoActionInput struct {
	DestinationID   string
	OrganizationID  string
	Platform        string
	SecretReference string
	RemotePostID    string
	PostURL         string
	Repost          bool
	RepostAtLikes   int
	Plug            bool
	PlugAtLikes     int
	PlugText        string
	Quote           bool
	QuoteText       string
}

// AutoActionResult reports the follow-ups that are done.
type AutoActionResult struct {
	Plugged  bool
	Quoted   bool
	Reposted bool
}

// AutomationInput is one follow-up of a live post (RFC 025). Kind is a
// temporalpublishing step kind; Threshold and Metric gate a plug or a
// like-gated repost; Text is a first comment, plug or quote.
type AutomationInput struct {
	DestinationID   string
	Kind            string
	Metric          string
	OrganizationID  string
	Platform        string
	RemotePostID    string
	SecretReference string
	Text            string
	Threshold       int
	// Media is the image a thumbnail step sets.
	Media *publishing.MediaAsset
}

// AutomationResult is a follow-up's outcome: Done when it acted (RemoteID
// is what it posted, if anything); not done when its threshold is not met.
type AutomationResult struct {
	Done     bool
	RemoteID string
}

// ErrUnsupported is a follow-up the account's platform cannot do.
var ErrUnsupported = errors.New("the platform does not support this follow-up")

// DeleteInput is one part of deleting a published post: Kind post deletes
// RemoteID, Kind repost undoes the account's repost of RemoteID.
type DeleteInput struct {
	DestinationID   string
	Kind            string
	OrganizationID  string
	Platform        string
	RemoteID        string
	SecretReference string
}

// Media is every file to publish, in order.
func (input PublishInput) Media() []publishing.MediaAsset {
	if len(input.Assets) > 0 {
		return input.Assets
	}
	if input.AssetObjectKey == "" {
		return nil
	}
	return []publishing.MediaAsset{{MediaType: input.AssetMediaType, ObjectKey: input.AssetObjectKey}}
}

// uploadAll stages each file with the social API, in order.
func (c *Client) uploadAll(ctx context.Context, token, organizationID string, media []publishing.MediaAsset) ([]any, error) {
	images := []any{}
	for _, file := range media {
		asset, err := c.assetReader.Read(ctx, organizationID, file.ObjectKey)
		if err != nil {
			return nil, &Error{message: "tenant asset is unavailable: " + err.Error()}
		}
		upload, err := c.upload(ctx, token, file.ObjectKey, file.MediaType, asset)
		if err != nil {
			return nil, err
		}
		images = append(images, upload)
	}
	return images, nil
}

type StatusInput struct {
	PostID          string
	SecretReference string
}

type StatusResult struct {
	ProviderPostID string
	State          string
}

type VerifyDestinationInput struct {
	DestinationID            string
	ExpectedGoOrganizationID string
	Platform                 string
	SecretReference          string
}

type BeginOAuthInput struct {
	ExpectedGoOrganizationID string
	Provider                 string
	SecretReference          string
	InstanceOrigin           string
}

type OAuthPage = schema.SocialOAuthPage

type OAuthExchange = schema.SocialOAuthExchange

type Error struct {
	Status          int
	UnknownDelivery bool
	// Code names a known cause, such as ACCOUNT_RECONNECT, for the failure
	// receipt to keep; empty when only the status is known.
	Code string
	// RetryAfter is the provider's retry guidance on a 429; zero when none.
	RetryAfter time.Duration
	// ProviderMessage is the provider's own explanation, kept on the attempt
	// for support (redacted there); Error() is Shots' message.
	ProviderMessage string
	message         string
}

func (e *Error) Error() string { return e.message }

// HTTPStatus is the error's status, for receipts that keep a code only.
func (e *Error) HTTPStatus() int { return e.Status }

func NewError(status int, unknownDelivery bool, message string) *Error {
	return &Error{Status: status, UnknownDelivery: unknownDelivery, message: message}
}

// NewCodedError is a definite refusal with a named cause: the post was not
// published, so the receipt keeps the cause instead of only the status.
func NewCodedError(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, message: message}
}

func New(baseURL string, httpClient *http.Client, assetReader AssetReader) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), httpClient: httpClient, assetReader: assetReader}
}

func (c *Client) BeginOAuth(ctx context.Context, input BeginOAuthInput) (string, error) {
	switch input.Provider {
	case "x", "instagram", "instagram-standalone", "linkedin", "linkedin-page", "tiktok", "youtube", "threads", "mastodon", "mastodon-custom",
		"facebook", "pinterest", "gmb":
	default:
		return "", &Error{Status: http.StatusBadRequest, message: "unsupported social provider"}
	}
	if input.Provider == "mastodon-custom" {
		origin, err := instances.Origin(input.InstanceOrigin)
		if err != nil || origin != input.InstanceOrigin {
			return "", &Error{Status: http.StatusBadRequest, message: "invalid instance origin"}
		}
	} else if input.InstanceOrigin != "" {
		return "", &Error{Status: http.StatusBadRequest, message: "this provider does not accept an instance server"}
	}
	if !publishing.IsSecretReference(input.SecretReference) {
		return "", &Error{Status: http.StatusConflict, message: "invalid social API credential reference"}
	}
	token := os.Getenv(input.SecretReference)
	if token == "" {
		return "", &Error{Status: http.StatusServiceUnavailable, message: "Social API credentials are unavailable"}
	}
	var me struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	if err := c.getJSON(ctx, token, "me", &me); err != nil {
		return "", err
	}
	if me.Organization.ID == "" || me.Organization.ID != input.ExpectedGoOrganizationID {
		return "", &Error{Status: http.StatusConflict, message: "Social API organization does not match this workspace"}
	}
	var result struct {
		URL string `json:"url"`
	}
	endpoint := "social/" + input.Provider
	if input.InstanceOrigin != "" {
		endpoint += "?" + url.Values{"instance": {input.InstanceOrigin}}.Encode()
	}
	if err := c.getJSON(ctx, token, endpoint, &result); err != nil {
		return "", err
	}
	if result.URL == "" {
		return "", &Error{Status: http.StatusBadGateway, message: "Social API returned an invalid authorization URL"}
	}
	return result.URL, nil
}

// ExchangeOAuth forwards a provider callback to the social adapter. The
// product backend checks the session-bound OAuth state before calling it.
func (c *Client) ExchangeOAuth(ctx context.Context, provider, code, state string) (OAuthExchange, error) {
	var result OAuthExchange
	err := c.postOAuthJSON(ctx, "/integrations/social-connect/"+url.PathEscape(provider),
		map[string]string{"code": code, "state": state, "timezone": "0"}, &result)
	if err != nil {
		return OAuthExchange{}, err
	}
	if result.ID == "" {
		return OAuthExchange{}, NewError(http.StatusBadGateway, false, "social adapter returned no connection")
	}
	return result, nil
}

func (c *Client) SelectInstagramPage(ctx context.Context, integrationID, accountID, pageID, state string) error {
	var result struct {
		Success bool `json:"success"`
	}
	err := c.postOAuthJSON(ctx, "/integrations/public/provider/"+url.PathEscape(integrationID)+"/connect",
		map[string]string{"id": accountID, "pageId": pageID, "state": state}, &result)
	if err != nil {
		return err
	}
	if !result.Success {
		return NewError(http.StatusBadGateway, false, "social adapter did not connect the page")
	}
	return nil
}

func (c *Client) postOAuthJSON(ctx context.Context, endpoint string, input, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(endpoint), bytes.NewReader(data))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return NewError(http.StatusServiceUnavailable, false, "social adapter is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return NewError(response.StatusCode, false, "social adapter rejected the callback")
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
		return NewError(http.StatusBadGateway, false, "social adapter returned invalid JSON")
	}
	return nil
}

func (c *Client) VerifyDestination(ctx context.Context, input VerifyDestinationInput) error {
	if input.Platform == "x" {
		_, err := c.VerifyX(ctx, input)
		return err
	}
	if !publishing.IsSecretReference(input.SecretReference) {
		return &Error{Status: http.StatusConflict, message: "invalid social API credential reference"}
	}
	token := os.Getenv(input.SecretReference)
	if token == "" {
		return &Error{Status: http.StatusConflict, message: "Social API credentials are unavailable"}
	}
	var me struct {
		Organization struct {
			ID string `json:"id"`
		} `json:"organization"`
	}
	if err := c.getJSON(ctx, token, "me", &me); err != nil {
		return err
	}
	if me.Organization.ID == "" || me.Organization.ID != input.ExpectedGoOrganizationID {
		return &Error{Status: http.StatusConflict, message: "Social API organization does not match this workspace"}
	}
	var integrations []struct {
		ID         string `json:"id"`
		Identifier string `json:"identifier"`
		Disabled   bool   `json:"disabled"`
	}
	if err := c.getJSON(ctx, token, "integrations", &integrations); err != nil {
		return err
	}
	for _, integration := range integrations {
		if integration.ID == input.DestinationID && integration.Identifier == input.Platform && !integration.Disabled {
			return nil
		}
	}
	return &Error{Status: http.StatusNotFound, message: "Social destination was not found"}
}

// DestinationProfile is a connected account as its platform shows it.
type DestinationProfile struct {
	AvatarURL string
	Handle    string
	Name      string
}

// Profiles reads every destination's name, handle and picture, by id.
func (c *Client) Profiles(ctx context.Context, secretReference string) (map[string]DestinationProfile, error) {
	if !publishing.IsSecretReference(secretReference) {
		return nil, &Error{Status: http.StatusConflict, message: "invalid social API credential reference"}
	}
	token := os.Getenv(secretReference)
	if token == "" {
		return nil, &Error{Status: http.StatusConflict, message: "Social API credentials are unavailable"}
	}
	var integrations []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
		Profile string `json:"profile"`
	}
	if err := c.getJSON(ctx, token, "integrations", &integrations); err != nil {
		return nil, err
	}
	profiles := make(map[string]DestinationProfile, len(integrations))
	for _, integration := range integrations {
		avatar := integration.Picture
		// Only an absolute https picture can be shown; uploads paths are the social API's own.
		if !strings.HasPrefix(avatar, "https://") {
			avatar = ""
		}
		profiles[integration.ID] = DestinationProfile{
			AvatarURL: avatar, Handle: strings.TrimPrefix(integration.Profile, "@"), Name: integration.Name,
		}
	}
	return profiles, nil
}

func (c *Client) getJSON(ctx context.Context, token, relative string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint(relative), nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return &Error{Status: http.StatusServiceUnavailable, message: "Social destination is unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return &Error{Status: response.StatusCode, message: "Social destination is unavailable"}
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(target); err != nil {
		return &Error{Status: http.StatusBadGateway, message: "Social API returned an invalid destination response"}
	}
	return nil
}

func (c *Client) Publish(ctx context.Context, input PublishInput) (string, error) {
	for _, reply := range input.Replies {
		if reply.Poll != nil {
			return "", NewError(http.StatusUnprocessableEntity, false, "thread polls require the direct publishing adapter")
		}
	}
	if !publishing.IsSecretReference(input.SecretReference) {
		return "", &Error{Code: publishing.FailurePublisherUnavailable, message: "invalid social API credential reference"}
	}
	token, ok := os.LookupEnv(input.SecretReference)
	if !ok || token == "" {
		return "", &Error{Code: publishing.FailurePublisherUnavailable, message: "Social API credentials are unavailable"}
	}
	// A content draft post without an image publishes as text (RFC 013).
	images, err := c.uploadAll(ctx, token, input.OrganizationID, input.Media())
	if err != nil {
		return "", err
	}
	// social API posts a thread from the value list: the post, then each reply.
	values := []any{map[string]any{"content": input.Caption, "image": images}}
	for _, reply := range input.Replies {
		replyImages, err := c.uploadAll(ctx, token, input.OrganizationID, reply.Assets)
		if err != nil {
			return "", err
		}
		values = append(values, map[string]any{"content": reply.Caption, "image": replyImages})
	}
	settings := make(map[string]any, len(input.ProviderSettings)+1)
	for key, value := range input.ProviderSettings {
		settings[key] = value
	}
	settings["__type"] = input.Platform
	payload := map[string]any{
		"date": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "shortLink": false, "tags": []string{}, "type": "now",
		"posts": []any{map[string]any{
			"integration": map[string]string{"id": input.DestinationID},
			"settings":    settings,
			"value":       values,
		}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("posts"), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", &Error{UnknownDelivery: true, message: "Social API post outcome is unknown: " + err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return "", &Error{Status: response.StatusCode, UnknownDelivery: response.StatusCode >= 500, message: fmt.Sprintf("Social API post failed with status %d", response.StatusCode)}
	}
	var result json.RawMessage
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return "", &Error{UnknownDelivery: true, message: "Social API returned an invalid post receipt"}
	}
	var current []struct {
		PostID string `json:"postId"`
	}
	if json.Unmarshal(result, &current) == nil && len(current) > 0 && current[0].PostID != "" {
		return current[0].PostID, nil
	}
	var legacy struct {
		ID     string `json:"id"`
		PostID string `json:"postId"`
	}
	if json.Unmarshal(result, &legacy) == nil {
		if legacy.PostID != "" {
			return legacy.PostID, nil
		}
		if legacy.ID != "" {
			return legacy.ID, nil
		}
	}
	return "", &Error{UnknownDelivery: true, message: "Social API returned an invalid post receipt"}
}

// UploadAsset stages media for the provider adapters without creating a
// second post. The returned path is signed immediately before publication.
func (c *Client) UploadAsset(ctx context.Context, input PublishInput) (string, error) {
	if !publishing.IsSecretReference(input.SecretReference) {
		return "", NewError(http.StatusConflict, false, "invalid social credential reference")
	}
	token := os.Getenv(input.SecretReference)
	if token == "" {
		return "", NewError(http.StatusConflict, false, "social credentials are unavailable")
	}
	if c.assetReader == nil {
		return "", NewError(http.StatusServiceUnavailable, false, "asset reader is unavailable")
	}
	asset, err := c.assetReader.Read(ctx, input.OrganizationID, input.AssetObjectKey)
	if err != nil {
		return "", NewError(http.StatusNotFound, false, "tenant asset is unavailable: "+err.Error())
	}
	uploaded, err := c.upload(ctx, token, input.AssetObjectKey, input.AssetMediaType, asset)
	if err != nil {
		return "", err
	}
	path, _ := uploaded["path"].(string)
	if path == "" {
		return "", NewError(http.StatusBadGateway, false, "media upload returned no path")
	}
	return path, nil
}

func (c *Client) Status(ctx context.Context, input StatusInput) (StatusResult, error) {
	if !publishing.IsSecretReference(input.SecretReference) {
		return StatusResult{}, &Error{Code: publishing.FailurePublisherUnavailable, message: "invalid social API credential reference"}
	}
	token, ok := os.LookupEnv(input.SecretReference)
	if !ok || token == "" {
		return StatusResult{}, &Error{Code: publishing.FailurePublisherUnavailable, message: "Social API credentials are unavailable"}
	}
	now := time.Now().UTC()
	query := url.Values{
		"startDate": []string{now.Add(-48 * time.Hour).Format(time.RFC3339)},
		"endDate":   []string{now.Add(24 * time.Hour).Format(time.RFC3339)},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint("posts")+"?"+query.Encode(), nil)
	if err != nil {
		return StatusResult{}, err
	}
	request.Header.Set("Authorization", token)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return StatusResult{}, &Error{message: "Social API status is unavailable: " + err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return StatusResult{}, &Error{Status: response.StatusCode, message: fmt.Sprintf("Social API status failed with status %d", response.StatusCode)}
	}
	var result struct {
		Posts []struct {
			ID         string `json:"id"`
			ReleaseID  string `json:"releaseId"`
			ReleaseURL string `json:"releaseURL"`
			State      string `json:"state"`
		} `json:"posts"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
		return StatusResult{}, &Error{message: "Social API returned an invalid status response"}
	}
	for _, post := range result.Posts {
		if post.ID == input.PostID {
			return StatusResult{ProviderPostID: post.ReleaseID, State: strings.ToUpper(post.State)}, nil
		}
	}
	return StatusResult{}, &Error{Status: http.StatusNotFound, message: "Social API post status was not found"}
}

func (c *Client) upload(ctx context.Context, token, objectKey, mediaType string, content []byte) (map[string]any, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	filename := strings.ReplaceAll(path.Base(objectKey), `"`, "")
	headers := make(textproto.MIMEHeader)
	headers.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	headers.Set("Content-Type", mediaType)
	part, err := writer.CreatePart(headers)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(content); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint("upload"), &body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, &Error{message: "Social API upload is unavailable: " + err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, &Error{Status: response.StatusCode, message: fmt.Sprintf("Social API upload failed with status %d", response.StatusCode)}
	}
	var result struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil || result.ID == "" || result.Path == "" {
		return nil, &Error{message: "Social API returned an invalid upload receipt"}
	}
	return map[string]any{"id": result.ID, "path": result.Path}, nil
}

func (c *Client) endpoint(relative string) string {
	base, _ := url.Parse(c.baseURL + "/")
	endpoint, _ := base.Parse(relative)
	return endpoint.String()
}
