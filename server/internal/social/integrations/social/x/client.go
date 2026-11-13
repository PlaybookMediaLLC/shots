package x

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// apiBase is twitter-api-v2's API prefix host; tests point it at a fake server.
var apiBase = "https://api.x.com"

func v2(path string) string { return apiBase + "/2/" + path }

// pct is RFC 3986 percent-encoding, as OAuth 1.0a requires.
func pct(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }

func nonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// oauthSignature is the HMAC-SHA1 signature over the method, the URL without
// its query, and every oauth/query/form parameter.
func oauthSignature(method, baseURL string, params url.Values, consumerSecret, tokenSecret string) string {
	pairs := make([][2]string, 0, len(params))
	for k, values := range params {
		for _, v := range values {
			pairs = append(pairs, [2]string{pct(k), pct(v)})
		}
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i][0] != pairs[j][0] {
			return pairs[i][0] < pairs[j][0]
		}
		return pairs[i][1] < pairs[j][1]
	})
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = p[0] + "=" + p[1]
	}
	base := strings.ToUpper(method) + "&" + pct(strings.Split(baseURL, "?")[0]) + "&" + pct(strings.Join(parts, "&"))
	mac := hmac.New(sha1.New, []byte(pct(consumerSecret)+"&"+pct(tokenSecret)))
	mac.Write([]byte(base))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// oauthHeader builds the OAuth 1.0a Authorization header with the app keys
// (X_API_KEY / X_API_SECRET); extra are the signed query / form parameters.
// signOAuth1 in the provider is this with no extra parameters.
func oauthHeader(method, rawURL, token, tokenSecret string, extra url.Values) string {
	oauth := map[string]string{
		"oauth_consumer_key":     os.Getenv("X_API_KEY"),
		"oauth_nonce":            nonce(),
		"oauth_signature_method": "HMAC-SHA1",
		"oauth_timestamp":        strconv.FormatInt(time.Now().Unix(), 10),
		"oauth_version":          "1.0",
	}
	if token != "" {
		oauth["oauth_token"] = token
	}
	all := url.Values{}
	for k, v := range extra {
		all[k] = append([]string(nil), v...)
	}
	for k, v := range oauth {
		all.Set(k, v)
	}
	oauth["oauth_signature"] = oauthSignature(method, rawURL, all, os.Getenv("X_API_SECRET"), tokenSecret)
	keys := make([]string, 0, len(oauth))
	for k := range oauth {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = pct(k) + `="` + pct(oauth[k]) + `"`
	}
	return "OAuth " + strings.Join(parts, ", ")
}

// signOAuth1 is the provider's own signer for the raw fetch calls.
func signOAuth1(method, rawURL, accessToken, accessSecret string) string {
	return oauthHeader(method, rawURL, accessToken, accessSecret, nil)
}

// splitToken splits the stored "accessToken:accessSecret".
func splitToken(token string) (string, string) {
	parts := strings.Split(token, ":")
	if len(parts) < 2 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

// apiResponseError is twitter-api-v2's ApiResponseError; it marshals like its
// toJSON() so handleErrors sees the same text.
type apiResponseError struct {
	Type      string            `json:"type"`
	Code      int               `json:"code"`
	Err       bool              `json:"error"`
	Headers   map[string]string `json:"headers"`
	RateLimit *rateLimit        `json:"rateLimit,omitempty"`
	Data      any               `json:"data"`
}

type rateLimit struct {
	Limit     int64 `json:"limit"`
	Remaining int64 `json:"remaining"`
	Reset     int64 `json:"reset"`
}

func (e *apiResponseError) Error() string { return fmt.Sprintf("Request failed with code %d", e.Code) }

// rateLimitError is ApiResponseError.rateLimitError.
func (e *apiResponseError) rateLimitError() bool { return e.Code == 420 || e.Code == 429 }

// HTTPStatus is the response's status, for receipts that keep a code only.
func (e *apiResponseError) HTTPStatus() int { return e.Code }

// RetryAt exposes the provider reset without leaking the response payload.
func (e *apiResponseError) RetryAt() time.Time {
	if e.RateLimit != nil && e.RateLimit.Reset > 0 {
		return time.Unix(e.RateLimit.Reset, 0)
	}
	if seconds, err := strconv.Atoi(e.Headers["retry-after"]); err == nil && seconds > 0 {
		return time.Now().Add(time.Duration(seconds) * time.Second)
	}
	return time.Time{}
}

func newAPIError(res *http.Response, body []byte) *apiResponseError {
	e := &apiResponseError{Type: "response", Code: res.StatusCode, Err: true, Headers: map[string]string{}}
	for k, v := range res.Header {
		e.Headers[strings.ToLower(k)] = strings.Join(v, ", ")
	}
	if limit := res.Header.Get("x-rate-limit-limit"); limit != "" {
		e.RateLimit = &rateLimit{}
		e.RateLimit.Limit, _ = strconv.ParseInt(limit, 10, 64)
		e.RateLimit.Remaining, _ = strconv.ParseInt(res.Header.Get("x-rate-limit-remaining"), 10, 64)
		e.RateLimit.Reset, _ = strconv.ParseInt(res.Header.Get("x-rate-limit-reset"), 10, 64)
	}
	var data any
	if json.Unmarshal(body, &data) == nil {
		e.Data = data
	} else if len(body) > 0 {
		e.Data = string(body)
	}
	return e
}

// client is the slice of twitter-api-v2's TwitterApi (OAuth 1.0a user
// context) the provider uses.
type client struct {
	token, secret string
}

func newClient(accessToken string) *client {
	token, secret := splitToken(accessToken)
	return &client{token: token, secret: secret}
}

// do signs and sends req; signed are the url-encoded body params, which
// take part in the signature with the query params. JSON and multipart bodies
// are not signed.
func (c *client) do(req *http.Request, signed url.Values) ([]byte, error) {
	params := req.URL.Query()
	for k, v := range signed {
		params[k] = append(params[k], v...)
	}
	base := req.URL.Scheme + "://" + req.URL.Host + req.URL.Path
	req.Header.Set("Authorization", oauthHeader(req.Method, base, c.token, c.secret, params))
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, newAPIError(res, body)
	}
	return body, nil
}

func decodeInto(data []byte, out any) error {
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// get is v2.get(endpoint, query).
func (c *client) get(ctx context.Context, endpoint string, query url.Values, out any) error {
	u := endpoint
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	data, err := c.do(req, nil)
	if err != nil {
		return err
	}
	return decodeInto(data, out)
}

// postJSON is a v2 POST (JSON body mode); a nil body sends none.
func (c *client) postJSON(ctx context.Context, endpoint string, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json; charset=UTF-8")
	}
	data, err := c.do(req, nil)
	if err != nil {
		return err
	}
	return decodeInto(data, out)
}

// postForm is the url-encoded POST of the oauth endpoints, which answer
// url-encoded too.
func (c *client) postForm(ctx context.Context, endpoint string, form url.Values) (url.Values, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	data, err := c.do(req, form)
	if err != nil {
		return nil, err
	}
	return url.ParseQuery(string(data))
}

// appendChunk is POST media/upload/:id/append with forceBodyMode form-data.
func (c *client) appendChunk(ctx context.Context, mediaID string, index int, chunk []byte) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("segment_index", strconv.Itoa(index))
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", `form-data; name="media"; filename="blob"`)
	h.Set("Content-Type", "application/octet-stream")
	part, err := w.CreatePart(h)
	if err != nil {
		return err
	}
	if _, err := part.Write(chunk); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, v2("media/upload/"+mediaID+"/append"), &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", w.FormDataContentType())
	_, err = c.do(req, nil)
	return err
}

type processingInfo struct {
	State           string `json:"state,omitempty"`
	CheckAfterSecs  int    `json:"check_after_secs,omitempty"`
	ProgressPercent int    `json:"progress_percent,omitempty"`
	Error           *struct {
		Message string `json:"message,omitempty"`
	} `json:"error,omitempty"`
}

type mediaResponse struct {
	Data struct {
		ID             string          `json:"id"`
		ProcessingInfo *processingInfo `json:"processing_info"`
	} `json:"data"`
}

// mediaStatus is v2.get('media/upload', { command: 'STATUS', media_id }).
func (c *client) mediaStatus(ctx context.Context, mediaID string) (*processingInfo, error) {
	var status mediaResponse
	err := c.get(ctx, v2("media/upload"), url.Values{"command": {"STATUS"}, "media_id": {mediaID}}, &status)
	return status.Data.ProcessingInfo, err
}

const uploadChunkSize = 1024 * 1024

type user struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Username        string `json:"username"`
	Verified        bool   `json:"verified"`
	ProfileImageURL string `json:"profile_image_url"`
}

// me is v2.me(options).
func (c *client) me(ctx context.Context, query url.Values) (*user, error) {
	var res struct {
		Data user `json:"data"`
	}
	if err := c.get(ctx, v2("users/me"), query, &res); err != nil {
		return nil, err
	}
	return &res.Data, nil
}

// tweetEngagement is a tweet's public like and retweet counts. The
// liking_users count it replaces stopped at one page (100 users).
func (c *client) tweetEngagement(ctx context.Context, tweetID string) (likes, retweets int, err error) {
	var res struct {
		Data struct {
			PublicMetrics struct {
				LikeCount    int `json:"like_count"`
				RetweetCount int `json:"retweet_count"`
			} `json:"public_metrics"`
		} `json:"data"`
	}
	err = c.get(ctx, v2("tweets/"+tweetID), url.Values{"tweet.fields": {"public_metrics"}}, &res)
	return res.Data.PublicMetrics.LikeCount, res.Data.PublicMetrics.RetweetCount, err
}

// setAltText is POST /2/media/metadata: a media's description, at most
// 1,000 characters.
func (c *client) setAltText(ctx context.Context, mediaID, alt string) error {
	if runes := []rune(alt); len(runes) > 1000 {
		alt = string(runes[:1000])
	}
	return c.postJSON(ctx, v2("media/metadata"), map[string]any{
		"id": mediaID, "metadata": map[string]any{"alt_text": map[string]string{"text": alt}},
	}, nil)
}

// retweet is v2.retweet(loggedUserId, tweetId).
func (c *client) retweet(ctx context.Context, userID, tweetID string) error {
	return c.postJSON(ctx, v2("users/"+userID+"/retweets"), map[string]string{"tweet_id": tweetID}, nil)
}

// unretweet is DELETE /2/users/:id/retweets/:source_tweet_id.
func (c *client) unretweet(ctx context.Context, userID, tweetID string) error {
	return c.delete(ctx, v2("users/"+userID+"/retweets/"+tweetID))
}

// deleteTweet is DELETE /2/tweets/:id. An already deleted post answers 404.
func (c *client) deleteTweet(ctx context.Context, tweetID string) error {
	return c.delete(ctx, v2("tweets/"+url.PathEscape(tweetID)))
}

func (c *client) delete(ctx context.Context, endpoint string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	_, err = c.do(req, nil)
	return err
}
