// Package farcaster is the Farcaster provider. The
// @neynar/nodejs-sdk calls are made directly against the Neynar REST API.
package farcaster

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/skip2/go-qrcode"
)

const identifier = "wrapcast"

// neynarURL is the SDK's BASE_PATH, overridden by tests.
var neynarURL = "https://api.neynar.com"

// sdkVersion is the @neynar/nodejs-sdk version the original app pins (x-sdk-version).
const sdkVersion = "3.137.0"

type Provider struct {
	*integrations.Base
}

var (
	_ integrations.Provider  = (*Provider)(nil)
	_ integrations.Commenter = (*Provider)(nil)
)

func New() *Provider {
	return &Provider{Base: integrations.NewBase(identifier, nil)}
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier: identifier,
		Name:       "Farcaster",
		Editor:     "normal",
		Scopes:     []string{},
		IsWeb3:     true,
		// Farcaster has moderate limits
		MaxConcurrentJob: 3,
		Rules:            "Farcaster/Warpcast can only accept pictures",
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 800 }

func (p *Provider) SettingsDTO() any { return &FarcasterDTO{} }

func (p *Provider) CheckValidity(_ context.Context, list [][]integrations.ValidityMedia, _ json.RawMessage, _ []integrations.AdditionalSetting) (string, error) {
	for _, item := range list {
		for _, field := range item {
			if strings.Contains(field.Path, "mp4") {
				return "Can only accept images", nil
			}
		}
	}
	return "", nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	// The frontend splits `<clientId>||<state>` for Neynar's sign-in. Without
	// a client id there is nothing to sign in with (upstream rendered the
	// literal "undefined"), so the connect request fails instead.
	clientID := os.Getenv("NEYNAR_CLIENT_ID")
	if clientID == "" {
		return nil, errors.New("NEYNAR_CLIENT_ID is not set")
	}
	state := ids.Secure(17)
	return &integrations.GenerateAuthURLResponse{URL: clientID + "||" + state, CodeVerifier: ids.Secure(10), State: state}, nil
}

func apiKey() string {
	if key := os.Getenv("NEYNAR_SECRET_KEY"); key != "" {
		return key
	}
	return "00000000-000-0000-000-000000000000"
}

// neynar is one NeynarAPIClient call. Like axios, any non-2xx answer fails
// with "Request failed with status code N".
func neynar(ctx context.Context, method, path string, query url.Values, body, out any) error {
	target := neynarURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", apiKey())
	req.Header.Set("x-sdk-version", sdkVersion)
	req.Header.Set("x-sdk", "node")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := farcasterHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("Request failed with status code %d", res.StatusCode)
	}
	return json.Unmarshal(data, out)
}

var farcasterHTTPClient = &http.Client{Timeout: 30 * time.Second}

type Signer struct {
	SignerUUID  string `json:"signerUuid"`
	ApprovalURL string `json:"approvalUrl"`
	QRCode      string `json:"qrCode"`
}

// CreateSigner backs POST /auth/farcaster/signer: a Neynar signer registered
// for the app FID, pending the user's approval.
func (p *Provider) CreateSigner(ctx context.Context) (*Signer, error) {
	if os.Getenv("NEYNAR_APP_FID") == "" || os.Getenv("NEYNAR_APP_MNEMONIC") == "" {
		return nil, errors.New("Farcaster is not configured: set NEYNAR_APP_FID and NEYNAR_APP_MNEMONIC")
	}

	var signer struct {
		SignerUUID string `json:"signer_uuid"`
		PublicKey  string `json:"public_key"`
	}
	if err := neynar(ctx, http.MethodPost, "/v2/farcaster/signer/", nil, nil, &signer); err != nil {
		return nil, err
	}
	appFid, err := strconv.ParseUint(strings.TrimSpace(os.Getenv("NEYNAR_APP_FID")), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("The number %s cannot be converted to a BigInt because it is not an integer", os.Getenv("NEYNAR_APP_FID"))
	}
	deadline := time.Now().Unix() + 24*60*60
	key, err := hex.DecodeString(strings.TrimPrefix(signer.PublicKey, "0x"))
	if err != nil {
		return nil, err
	}
	account, err := mnemonicToKey(os.Getenv("NEYNAR_APP_MNEMONIC"))
	if err != nil {
		return nil, err
	}
	signature := signTypedData(account, appFid, key, uint64(deadline))

	type sponsor struct {
		SponsoredByNeynar bool `json:"sponsored_by_neynar"`
	}
	body := struct {
		SignerUUID string   `json:"signer_uuid"`
		AppFid     uint64   `json:"app_fid"`
		Deadline   int64    `json:"deadline"`
		Signature  string   `json:"signature"`
		Sponsor    *sponsor `json:"sponsor,omitempty"`
	}{SignerUUID: signer.SignerUUID, AppFid: appFid, Deadline: deadline, Signature: signature}
	if os.Getenv("NEYNAR_SPONSOR_SIGNERS") == "true" {
		body.Sponsor = &sponsor{SponsoredByNeynar: true}
	}
	var registered struct {
		SignerUUID        string `json:"signer_uuid"`
		SignerApprovalURL string `json:"signer_approval_url"`
	}
	if err := neynar(ctx, http.MethodPost, "/v2/farcaster/signer/signed_key/", nil, body, &registered); err != nil {
		return nil, err
	}

	// qrcode's toDataURL defaults: PNG, error correction M, 4px modules.
	png, err := qrcode.Encode(registered.SignerApprovalURL, qrcode.Medium, -4)
	if err != nil {
		return nil, err
	}
	return &Signer{
		SignerUUID:  registered.SignerUUID,
		ApprovalURL: registered.SignerApprovalURL,
		QRCode:      "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	}, nil
}

type SignerStatus struct {
	Status string `json:"status"`
	Code   string `json:"code,omitempty"`
}

// SignerStatus backs GET /auth/farcaster/signer: once approved, code is the
// base64 payload Authenticate expects.
func (p *Provider) SignerStatus(ctx context.Context, signerUUID string) (*SignerStatus, error) {
	var signer struct {
		Status string          `json:"status"`
		Fid    json.RawMessage `json:"fid,omitempty"`
	}
	if err := neynar(ctx, http.MethodGet, "/v2/farcaster/signer/", url.Values{"signer_uuid": {signerUUID}}, nil, &signer); err != nil {
		return nil, err
	}
	if signer.Status != "approved" {
		return &SignerStatus{Status: signer.Status}, nil
	}

	var bulk struct {
		Users []struct {
			Username    string `json:"username,omitempty"`
			DisplayName string `json:"display_name,omitempty"`
			PfpURL      string `json:"pfp_url,omitempty"`
		} `json:"users"`
	}
	if err := neynar(ctx, http.MethodGet, "/v2/farcaster/user/bulk/", url.Values{"fids": {string(signer.Fid)}}, nil, &bulk); err != nil {
		return nil, err
	}
	if len(bulk.Users) == 0 {
		return nil, errors.New("Cannot read properties of undefined (reading 'username')")
	}
	user := bulk.Users[0]
	code, err := json.Marshal(struct {
		SignerUUID  string          `json:"signer_uuid"`
		Fid         json.RawMessage `json:"fid,omitempty"`
		Username    string          `json:"username,omitempty"`
		DisplayName string          `json:"display_name,omitempty"`
		PfpURL      string          `json:"pfp_url,omitempty"`
	}{signerUUID, signer.Fid, user.Username, user.DisplayName, user.PfpURL})
	if err != nil {
		return nil, err
	}
	return &SignerStatus{Status: signer.Status, Code: base64.StdEncoding.EncodeToString(code)}, nil
}

func (p *Provider) Authenticate(_ context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	raw, err := base64.StdEncoding.DecodeString(params.Code)
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(params.Code, "=")); err != nil {
			return nil, err
		}
	}
	var data struct {
		Fid         json.RawMessage `json:"fid"`
		DisplayName string          `json:"display_name"`
		SignerUUID  string          `json:"signer_uuid"`
		PfpURL      string          `json:"pfp_url"`
		Username    string          `json:"username"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, err
	}
	now := time.Now()
	return &integrations.AuthTokenDetails{
		ID:           strings.Trim(string(data.Fid), `"`),
		Name:         data.DisplayName,
		AccessToken:  data.SignerUUID,
		RefreshToken: "",
		ExpiresIn:    now.AddDate(200, 0, 0).Unix() - now.Unix(),
		Picture:      data.PfpURL,
		Username:     data.Username,
	}, nil
}

type embed struct {
	URL string `json:"url"`
}

func embeds(media []integrations.MediaContent) []embed {
	out := []embed{}
	for _, m := range media {
		out = append(out, embed{URL: m.Path})
	}
	return out
}

type cast struct {
	Cast struct {
		Hash   string `json:"hash"`
		Author struct {
			Username string `json:"username"`
		} `json:"author"`
	} `json:"cast"`
}

type castBody struct {
	Embeds     []embed `json:"embeds"`
	SignerUUID string  `json:"signer_uuid"`
	Text       string  `json:"text"`
	ChannelID  string  `json:"channel_id,omitempty"`
	Parent     string  `json:"parent,omitempty"`
}

func publishAll(ctx context.Context, id string, bodies []castBody) ([]integrations.PostResponse, error) {
	var postIDs, urls []string
	for _, body := range bodies {
		var data cast
		if err := neynar(ctx, http.MethodPost, "/v2/farcaster/cast/", nil, body, &data); err != nil {
			return nil, err
		}
		urls = append(urls, "https://warpcast.com/"+data.Cast.Author.Username+"/"+data.Cast.Hash)
		postIDs = append(postIDs, data.Cast.Hash)
	}
	return []integrations.PostResponse{{
		ID:         id,
		PostID:     strings.Join(postIDs, ","),
		ReleaseURL: strings.Join(urls, ","),
		Status:     "published",
	}}, nil
}

func (p *Provider) Post(ctx context.Context, _, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	firstPost := posts[0]
	var settings FarcasterDTO
	if len(firstPost.Settings) > 0 {
		if err := json.Unmarshal(firstPost.Settings, &settings); err != nil {
			return nil, err
		}
	}

	// no channel picked: one cast without a channel
	channels := settings.Subreddit
	if len(channels) == 0 {
		channels = []*FarcasterValue{nil}
	}
	var bodies []castBody
	for _, channel := range channels {
		body := castBody{Embeds: embeds(firstPost.Media), SignerUUID: accessToken, Text: firstPost.Message}
		if channel != nil && channel.Value != nil && channel.Value.ID != nil {
			body.ChannelID = *channel.Value.ID
		}
		bodies = append(bodies, body)
	}
	return publishAll(ctx, firstPost.ID, bodies)
}

func (p *Provider) Comment(ctx context.Context, _, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	commentPost := posts[0]
	// postId can be comma-separated if posted to multiple channels
	parent := lastCommentID
	if parent == "" {
		parent = postID
	}
	var bodies []castBody
	for _, parentHash := range strings.Split(parent, ",") {
		bodies = append(bodies, castBody{Embeds: embeds(commentPost.Media), SignerUUID: accessToken, Text: commentPost.Message, Parent: parentHash})
	}
	return publishAll(ctx, commentPost.ID, bodies)
}

type Channel struct {
	Title string `json:"title"`
	Name  string `json:"name"`
	ID    string `json:"id"`
}

// Subreddits is the "subreddits" @Tool: search channels.
func (p *Provider) Subreddits(ctx context.Context, data json.RawMessage) ([]Channel, error) {
	var input struct {
		Word string `json:"word"`
	}
	_ = json.Unmarshal(data, &input)
	var search struct {
		Channels []struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		} `json:"channels"`
	}
	if err := neynar(ctx, http.MethodGet, "/v2/farcaster/channel/search/", url.Values{"q": {input.Word}, "limit": {"10"}}, nil, &search); err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(search.Channels))
	for _, c := range search.Channels {
		out = append(out, Channel{Title: c.Name, Name: c.Name, ID: c.ID})
	}
	return out, nil
}

func (p *Provider) Functions() map[string]integrations.Function {
	return map[string]integrations.Function{
		"subreddits": func(ctx context.Context, _ string, data json.RawMessage, _ string, _ *ent.Integration) (any, error) {
			return p.Subreddits(ctx, data)
		},
	}
}

func (p *Provider) Tools() []integrations.Tool {
	return []integrations.Tool{{
		MethodName:  "subreddits",
		Description: "Search channels",
		DataSchema:  []integrations.ToolField{{Key: "word", Type: "string", Description: "Search word"}},
	}}
}
