// Package mastodon is the Mastodon provider. The
// dynamic* methods take the instance URL so mastodoncustom can reuse them.
package mastodon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ids"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

const identifier = "mastodon"

// Scopes is the scope list shared with mastodoncustom.
var Scopes = []string{"write:statuses", "profile", "write:media", "read:search", "read:statuses"}

// Poll cadence of the blocking DynamicPost, shortened by tests.
var (
	pollInterval = 20 * time.Second
	pollTimeout  = 8 * time.Minute
)

type Provider struct {
	*integrations.Base
	identifier string
	client     *http.Client
}

var (
	_ integrations.Provider      = (*Provider)(nil)
	_ integrations.PendingPoster = (*Provider)(nil)
	_ integrations.Commenter     = (*Provider)(nil)
)

func New() *Provider { return NewFor(identifier) }

// NewFor builds the provider under a subclass identifier (mastodon-custom), so
// fetch failures carry it the way `this.identifier` does in TypeScript.
func NewFor(id string) *Provider {
	return &Provider{Base: integrations.NewBase(id, handleErrors), identifier: id}
}

// NewForWithClient keeps custom-instance credential requests on the supplied
// transport, including media uploads and delayed publishing activities.
func NewForWithClient(id string, client *http.Client) *Provider {
	p := NewFor(id)
	p.client = client
	return p
}

func (p *Provider) instanceClient() *http.Client {
	if p.client != nil {
		return p.client
	}
	return ssrf.Client()
}

// Fetch applies the instance transport to requests made by the shared adapter.
func (p *Provider) Fetch(ctx context.Context, url string, req integrations.Request) (*integrations.Response, error) {
	req.Client = p.instanceClient()
	return p.Base.Fetch(ctx, url, req)
}

func (p *Provider) Info() integrations.Info {
	return integrations.Info{
		Identifier: identifier,
		Name:       "Mastodon",
		Editor:     "normal",
		Scopes:     Scopes,
		// Mastodon limits are per user, not per app
		MaxConcurrentJob: 10,
	}
}

func (p *Provider) MaxLength([]integrations.AdditionalSetting, json.RawMessage) int { return 500 }

func handleErrors(body string, _ int) *integrations.HandledError {
	switch {
	case strings.Contains(body, "Your login is currently disabled"):
		return &integrations.HandledError{Type: "refresh-token", Value: "Your login is currently disabled"}
	case strings.Contains(body, "not finished processing"):
		return &integrations.HandledError{Type: "bad-body", Value: "The media was still processing when the post was published, please try again"}
	case strings.Contains(body, "could not be found"):
		return &integrations.HandledError{Type: "bad-body", Value: "The uploaded media expired before the post was published, please post again"}
	}
	return nil
}

func (p *Provider) RefreshToken(context.Context, string) (*integrations.AuthTokenDetails, error) {
	return &integrations.AuthTokenDetails{}, nil
}

// DefaultURL is MASTODON_URL or mastodon.social.
func DefaultURL() string {
	if v := os.Getenv("MASTODON_URL"); v != "" {
		return v
	}
	return "https://mastodon.social"
}

// EncodeURIComponent is JavaScript's encodeURIComponent.
func EncodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

func (p *Provider) GenerateURLDynamic(customURL, state, clientID, url string) string {
	return customURL + "/oauth/authorize?client_id=" + clientID + "&response_type=code&redirect_uri=" +
		EncodeURIComponent(url+"/integrations/social/mastodon") + "&scope=" + strings.Join(Scopes, "+") + "&state=" + state
}

func (p *Provider) GenerateAuthURL(context.Context, *integrations.ClientInformation) (*integrations.GenerateAuthURLResponse, error) {
	state := ids.Secure(6)
	url := p.GenerateURLDynamic(DefaultURL(), state, os.Getenv("MASTODON_CLIENT_ID"), os.Getenv("FRONTEND_URL"))
	return &integrations.GenerateAuthURLResponse{URL: url, CodeVerifier: ids.Secure(10), State: state}, nil
}

// Form builds a multipart/form-data body (FormData) from ordered pairs.
func Form(pairs ...string) (body []byte, contentType string) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for i := 0; i+1 < len(pairs); i += 2 {
		_ = w.WriteField(pairs[i], pairs[i+1])
	}
	_ = w.Close()
	return buf.Bytes(), w.FormDataContentType()
}

func (p *Provider) DynamicAuthenticate(ctx context.Context, clientID, clientSecret, url, code string) (*integrations.AuthTokenDetails, error) {
	body, contentType := Form(
		"client_id", clientID,
		"client_secret", clientSecret,
		"code", code,
		"grant_type", "authorization_code",
		"redirect_uri", os.Getenv("FRONTEND_URL")+"/integrations/social/mastodon",
		"scope", strings.Join(Scopes, " "),
	)
	res, err := p.Fetch(ctx, url+"/oauth/token", integrations.Request{Method: http.MethodPost, Headers: map[string]string{"Content-Type": contentType}, Body: body})
	if err != nil {
		return nil, err
	}
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := res.JSON(&token); err != nil {
		return nil, err
	}

	res, err = p.Fetch(ctx, url+"/api/v1/accounts/verify_credentials", integrations.Request{
		Headers: map[string]string{"Authorization": "Bearer " + token.AccessToken},
	})
	if err != nil {
		return nil, err
	}
	var me struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Acct        string `json:"acct"`
		Avatar      string `json:"avatar"`
		Username    string `json:"username"`
	}
	if err := res.JSON(&me); err != nil {
		return nil, err
	}
	name := me.DisplayName
	if name == "" {
		name = me.Acct
	}
	now := time.Now()
	// Mastodon tokens do not expire and come without a refresh token;
	// upstream returned the string "null", which was stored as a token.
	return &integrations.AuthTokenDetails{
		ID:           me.ID,
		Name:         name,
		AccessToken:  token.AccessToken,
		RefreshToken: "",
		ExpiresIn:    now.AddDate(100, 0, 0).Unix() - now.Unix(),
		Picture:      me.Avatar,
		Username:     me.Username,
	}, nil
}

func (p *Provider) Authenticate(ctx context.Context, params integrations.AuthenticateParams, _ *integrations.ClientInformation) (*integrations.AuthTokenDetails, error) {
	return p.DynamicAuthenticate(ctx, os.Getenv("MASTODON_CLIENT_ID"), os.Getenv("MASTODON_CLIENT_SECRET"), DefaultURL(), params.Code)
}

// UploadFile streams the file straight from storage into the Mastodon upload
// request instead of buffering it in memory. Both requests use the SSRF-safe
// client because the URLs are not fully under our control, and the whole
// request is rebuilt per attempt by RunStreamedUpload since a consumed stream
// can't be replayed.
func (p *Provider) UploadFile(ctx context.Context, instanceURL, fileURL, accessToken, alt string) (string, error) {
	// The media stays invisible until a status uses it, so a resend is safe.
	return integrations.RunStreamedUpload(ctx, p.Base, true, func() (string, error) {
		temporalx.SetHeartbeatDetails(ctx, "mastodon: read media "+temporalx.StripQuery(fileURL))
		fileReq, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL, nil)
		if err != nil {
			return "", err
		}
		// identity encoding so content-length matches the streamed bytes
		fileReq.Header.Set("Accept-Encoding", "identity")
		mediaClient := ssrf.Client()
		if p.client != nil {
			mediaClient = ssrf.PublicClient()
		}
		fileRes, err := mediaClient.Do(fileReq)
		if err != nil {
			return "", err
		}
		defer fileRes.Body.Close()
		if fileRes.StatusCode < 200 || fileRes.StatusCode > 299 {
			return "", fmt.Errorf("Failed to fetch media: %s", strings.TrimPrefix(fileRes.Status, strconv.Itoa(fileRes.StatusCode)+" "))
		}
		contentLength, _ := strconv.ParseInt(fileRes.Header.Get("Content-Length"), 10, 64)

		filename := path.Base("/" + fileURL)
		filename, _, _ = strings.Cut(filename, "?")
		if filename == "" || filename == "/" {
			filename = "file"
		}
		// The stored object's type is authoritative; a minimal image may lack a MIME table.
		partType := fileRes.Header.Get("Content-Type")
		if !strings.HasPrefix(partType, "image/") && !strings.HasPrefix(partType, "video/") && !strings.HasPrefix(partType, "audio/") {
			partType = mime.TypeByExtension(path.Ext(filename))
		}
		if partType == "" {
			partType = "application/octet-stream"
		}

		// The multipart framing around the streamed file is built up front so
		// the exact Content-Length is known: some Mastodon front-ends reject
		// chunked multipart.
		var framing bytes.Buffer
		w := multipart.NewWriter(&framing)
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(filename)))
		header.Set("Content-Type", partType)
		if _, err := w.CreatePart(header); err != nil {
			return "", err
		}
		prefixLength := framing.Len()
		if alt != "" {
			_ = w.WriteField("description", alt)
		}
		_ = w.Close()
		prefix := framing.Bytes()[:prefixLength]
		suffix := framing.Bytes()[prefixLength:]

		temporalx.SetHeartbeatDetails(ctx, "mastodon: upload media")
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, instanceURL+"/api/v1/media",
			io.MultiReader(bytes.NewReader(prefix), fileRes.Body, bytes.NewReader(suffix)))
		if err != nil {
			return "", err
		}
		req.ContentLength = -1
		if contentLength > 0 {
			req.ContentLength = int64(len(prefix)) + contentLength + int64(len(suffix))
		}
		req.Header.Set("Content-Type", w.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+accessToken)
		res, err := p.instanceClient().Do(req)
		if err != nil {
			return "", err
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 && res.StatusCode != 201 && res.StatusCode != 202 {
			if len(data) == 0 {
				data = []byte("{}")
			}
			return "", &integrations.ResponseError{Status: res.StatusCode, Body: data}
		}
		var media struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(data, &media); err != nil {
			return "", err
		}
		return media.ID, nil
	})
}

// PendingData travels through the workflow history between PostPending,
// CheckPostStatus and FinalizePost - keep it small JSON (the instance url,
// media ids and the status content). The url makes CheckPostStatus /
// FinalizePost work the same for the default instance and custom instances.
type PendingData struct {
	QuoteID        string      `json:"quoteId,omitempty"`
	Poll           *NativePoll `json:"poll,omitempty"`
	URL            string      `json:"url"`
	Message        string      `json:"message"`
	MediaIDs       []string    `json:"mediaIds"`
	IdempotencyKey string      `json:"idempotencyKey"`
}

func (p *Provider) uploadAll(ctx context.Context, url, accessToken string, media []integrations.MediaContent) ([]string, error) {
	out := []string{}
	for _, m := range media {
		id, err := p.UploadFile(ctx, url, m.Path, accessToken, m.Alt)
		if err != nil {
			return nil, err
		}
		if id != "" {
			out = append(out, id)
		}
	}
	return out, nil
}

func (p *Provider) DynamicPostPending(ctx context.Context, _, accessToken, url string, posts []integrations.PostDetails) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, fmt.Errorf("Choose a post to publish")
	}
	firstPost := posts[0]
	quote, err := p.quoteTarget(ctx, url, accessToken, firstPost.Settings)
	if err != nil {
		return nil, err
	}
	poll, err := p.checkedPoll(ctx, url, firstPost.Poll, len(firstPost.Media))
	if err != nil {
		return nil, err
	}

	// Upload the media now; a 202 means the instance is still processing it
	// (videos, large GIFs) and attaching it to a status too early fails with
	// 422 - the wait moves to CheckPostStatus. The status itself is only
	// created by FinalizePost, so nothing here is irreversible.
	mediaIDs, err := p.uploadAll(ctx, url, accessToken, firstPost.Media)
	if err != nil {
		return nil, err
	}
	pending, _ := json.Marshal(PendingData{
		QuoteID: quote, Poll: poll,
		URL:      url,
		Message:  firstPost.Message,
		MediaIDs: mediaIDs,
		// Statuses POSTs are deduplicated by Mastodon via Idempotency-Key.
		// Generated once per publish run: it rides pendingData through the
		// workflow history, so finalize retries within this run dedupe - but
		// an edited post re-published in a fresh run gets a new key (the db
		// post id alone would silently return the old status).
		IdempotencyKey: firstPost.ID + "-" + ids.Make(5),
	})
	return []integrations.PostResponse{{ID: firstPost.ID, Status: "pending", PendingData: pending}}, nil
}

func pendingResponse(status string, data json.RawMessage) *integrations.PendingCheckResponse {
	return &integrations.PendingCheckResponse{Status: status, PendingData: data}
}

func (p *Provider) CheckPostStatus(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending PendingData
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}
	// Text-only statuses have no asynchronous processing step.
	if len(pending.MediaIDs) == 0 {
		return pendingResponse("ready", raw), nil
	}

	// GET /api/v1/media/:id answers 206 while the media is still processing
	// and 200 once it is ready - exactly the pending/ready split. Fetch treats
	// 206 as an error, so use the raw SSRF-safe client (the instance URL is
	// user-influenced for custom instances).
	for _, mediaID := range pending.MediaIDs {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pending.URL+"/api/v1/media/"+mediaID, nil)
		if err != nil {
			return pendingResponse("pending", raw), nil
		}
		req.Header.Set("Authorization", "Bearer "+accessToken)
		res, err := p.instanceClient().Do(req)
		if err != nil {
			// Transient status-check error: the media may finish processing
			// just fine, keep polling - if the instance stays broken the
			// workflow exhausts its checks and warns the user properly.
			return pendingResponse("pending", raw), nil
		}
		body, readErr := io.ReadAll(res.Body)
		res.Body.Close()
		text := string(body)
		if readErr != nil {
			text = "{}"
		}

		switch {
		case res.StatusCode == 206:
			return pendingResponse("pending", raw), nil
		case res.StatusCode == 401:
			return nil, temporalx.RefreshToken(p.identifier, text, "{}", "")
		case res.StatusCode == 404 || res.StatusCode == 410:
			// The media GET only sees UNATTACHED media: after a finalize whose
			// outcome was lost, an already-published status makes its media
			// 404 here. Never conclude "expired, post again" (that instruction
			// is the duplicate path) - keep checking the remaining media (a
			// later 206 still wins) and let the idempotent finalize either
			// dedupe into the existing status or get Mastodon's verdict.
			continue
		case res.StatusCode == 422:
			return nil, temporalx.BadBody(p.identifier, text, "{}", "The uploaded media expired before the post was published, please post again")
		case res.StatusCode != 200:
			// Unknown answer on a read-only check: treat as transient.
			return pendingResponse("pending", raw), nil
		}
	}
	return pendingResponse("ready", raw), nil
}

func (p *Provider) FinalizePost(ctx context.Context, accessToken string, raw json.RawMessage, _ *ent.Integration) (*integrations.PendingCheckResponse, error) {
	var pending PendingData
	if err := json.Unmarshal(raw, &pending); err != nil {
		return nil, err
	}
	pairs := []string{"status", pending.Message, "visibility", "public"}
	if pending.QuoteID != "" {
		if _, err := p.checkedQuote(ctx, pending.URL, accessToken, pending.QuoteID); err != nil {
			return nil, err
		}
		pairs = append(pairs, "quoted_status_id", pending.QuoteID)
	}
	if pending.Poll != nil {
		if _, err := p.checkedPoll(ctx, pending.URL, &integrations.PollDetails{Options: pending.Poll.Options, DurationMinutes: pending.Poll.Minutes, Multiple: pending.Poll.Multiple}, len(pending.MediaIDs)); err != nil {
			return nil, err
		}
	}
	pairs = append(pairs, pollPairs(pending.Poll)...)
	for _, file := range pending.MediaIDs {
		pairs = append(pairs, "media_ids[]", file)
	}
	body, contentType := Form(pairs...)
	headers := map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": contentType}
	// Mastodon deduplicates statuses POSTs on this key (kept for about an
	// hour): a finalize retry after an unknown outcome returns the
	// already-created status instead of publishing twice. Guarded so a
	// missing key never dedupes against an unrelated post.
	if pending.IdempotencyKey != "" {
		headers["Idempotency-Key"] = pending.IdempotencyKey
	}
	res, err := p.Fetch(ctx, pending.URL+"/api/v1/statuses", integrations.Request{Method: http.MethodPost, Headers: headers, Body: body,
		Retryable: pending.IdempotencyKey != ""})
	if err != nil {
		return nil, err
	}
	var post struct {
		ID    string `json:"id"`
		Quote *struct {
			State string `json:"state"`
		} `json:"quote"`
	}
	if err := res.JSON(&post); err != nil {
		return nil, err
	}
	if !statusID.MatchString(post.ID) {
		return nil, fmt.Errorf("Mastodon returned no confirmed status ID; check the account before retrying")
	}
	if pending.QuoteID != "" {
		state := "unconfirmed"
		if post.Quote != nil {
			state = post.Quote.State
		}
		slog.Info("Mastodon native quote submitted", "status_id", post.ID, "quote_state", state)
	}
	state := ""
	if post.Quote != nil {
		state = post.Quote.State
	}
	return &integrations.PendingCheckResponse{Status: "completed", PostID: post.ID, ReleaseURL: pending.URL + "/statuses/" + post.ID, QuoteState: confirmedQuoteState(pending.QuoteID != "", state)}, nil
}

// DynamicPost is the old blocking behavior, kept for workflow versions before
// v1.0.6 that don't know how to resolve a `pending` response - they wait for
// the media processing and create the status inside the activity like before.
func (p *Provider) DynamicPost(ctx context.Context, id, accessToken, url string, posts []integrations.PostDetails) ([]integrations.PostResponse, error) {
	responses, err := p.DynamicPostPending(ctx, id, accessToken, url, posts)
	if err != nil {
		return nil, err
	}
	response := responses[0]
	pending := response.PendingData
	started := time.Now()
	completed := func(postID, releaseURL, quoteState string) []integrations.PostResponse {
		return []integrations.PostResponse{{ID: response.ID, PostID: postID, ReleaseURL: releaseURL, Status: "completed", QuoteState: quoteState}}
	}

	for {
		// A nil integration is safe here: CheckPostStatus and FinalizePost
		// read everything from pendingData (including the instance url) -
		// keep it that way if either method ever grows an integration
		// dependency.
		check, err := p.CheckPostStatus(ctx, accessToken, pending, nil)
		if err != nil {
			return nil, err
		}
		switch check.Status {
		case "ready":
			finalize, err := p.FinalizePost(ctx, accessToken, check.PendingData, nil)
			if err != nil {
				return nil, err
			}
			if finalize.Status == "completed" {
				return completed(finalize.PostID, finalize.ReleaseURL, finalize.QuoteState), nil
			}
			pending = finalize.PendingData
		case "completed":
			return completed(check.PostID, check.ReleaseURL, check.QuoteState), nil
		default:
			pending = check.PendingData
		}

		// Cap below the 10-minute activity timeout of the old workflows using
		// this method: failing here is safe (the status is only created once
		// the media is ready), timing the activity out is not - a retried
		// activity would upload and publish again.
		if time.Since(started) > pollTimeout {
			return nil, temporalx.BadBody(p.identifier, "{}", "{}", "The media took too long to process, please try again")
		}
		if err := p.Sleep(ctx, pollInterval); err != nil {
			return nil, err
		}
	}
}

func (p *Provider) DynamicComment(ctx context.Context, _, postID, lastCommentID, accessToken, url string, posts []integrations.PostDetails) ([]integrations.PostResponse, error) {
	if len(posts) == 0 {
		return nil, fmt.Errorf("Choose a reply to publish")
	}
	commentPost := posts[0]
	quote, err := p.quoteTarget(ctx, url, accessToken, commentPost.Settings)
	if err != nil {
		return nil, err
	}
	poll, err := p.checkedPoll(ctx, url, commentPost.Poll, len(commentPost.Media))
	if err != nil {
		return nil, err
	}
	replyToID := lastCommentID
	if replyToID == "" {
		replyToID = postID
	}
	mediaIDs, err := p.uploadAll(ctx, url, accessToken, commentPost.Media)
	if err != nil {
		return nil, err
	}
	pairs := []string{"status", commentPost.Message, "visibility", "public", "in_reply_to_id", replyToID}
	if quote != "" {
		pairs = append(pairs, "quoted_status_id", quote)
	}
	pairs = append(pairs, pollPairs(poll)...)
	for _, file := range mediaIDs {
		pairs = append(pairs, "media_ids[]", file)
	}
	body, contentType := Form(pairs...)
	res, err := p.Fetch(ctx, url+"/api/v1/statuses", integrations.Request{
		Method:    http.MethodPost,
		Headers:   map[string]string{"Authorization": "Bearer " + accessToken, "Content-Type": contentType, "Idempotency-Key": "shots-reply-" + commentPost.ID},
		Body:      body,
		Retryable: true, // Mastodon deduplicates on the Idempotency-Key.
	})
	if err != nil {
		return nil, err
	}
	var post struct {
		ID    string `json:"id"`
		Quote *struct {
			State string `json:"state"`
		} `json:"quote"`
	}
	if err := res.JSON(&post); err != nil {
		return nil, err
	}
	state := ""
	if post.Quote != nil {
		state = post.Quote.State
	}
	return []integrations.PostResponse{{ID: commentPost.ID, PostID: post.ID, ReleaseURL: url + "/statuses/" + post.ID, Status: "completed", QuoteState: confirmedQuoteState(quote != "", state)}}, nil
}

func (p *Provider) Post(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.DynamicPost(ctx, id, accessToken, DefaultURL(), posts)
}

func (p *Provider) PostPending(ctx context.Context, id, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.DynamicPostPending(ctx, id, accessToken, DefaultURL(), posts)
}

func (p *Provider) Comment(ctx context.Context, id, postID, lastCommentID, accessToken string, posts []integrations.PostDetails, _ *ent.Integration) ([]integrations.PostResponse, error) {
	return p.DynamicComment(ctx, id, postID, lastCommentID, accessToken, DefaultURL(), posts)
}
