package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	_ "golang.org/x/image/webp"
)

// HandledError is a provider's classification of a failed response
// (SocialAbstract.handleErrors).
type HandledError struct {
	Type  string // refresh-token | bad-body | retry | disconnect | limit
	Value string
}

// ErrorHandler classifies a non-2xx response body; nil means unclassified.
type ErrorHandler func(body string, status int) *HandledError

// Base is SocialAbstract. Providers embed *Base built with NewBase and pass
// their handleErrors override, since Go has no virtual dispatch.
type Base struct {
	identifier string
	handle     ErrorHandler
	// RetryDelay is the pause between retries (timer(5000)); tests shorten it.
	RetryDelay time.Duration
}

func NewBase(identifier string, handle ErrorHandler) *Base {
	return &Base{identifier: identifier, handle: handle, RetryDelay: 5 * time.Second}
}

func (b *Base) handleErrors(body string, status int) *HandledError {
	if b.handle == nil {
		return nil
	}
	return b.handle(body, status)
}

// HandleErrors exposes the provider classification to generic code.
func (b *Base) HandleErrors(body string, status int) *HandledError {
	return b.handleErrors(body, status)
}

// NotEnoughScopes is thrown when the user did not grant every scope; the
// connect endpoint answers 409 {msg}.
type NotEnoughScopes struct{ Message string }

func (e *NotEnoughScopes) Error() string { return e.Message }

func notEnoughScopes() error {
	return &NotEnoughScopes{Message: "Not enough scopes, when choosing a provider, please add all the scopes"}
}

// CheckScopes accepts got as []string or a comma/space separated string.
func (b *Base) CheckScopes(required []string, got any) error {
	var list []string
	switch v := got.(type) {
	case []string:
		list = v
	case []any:
		for _, item := range v {
			list = append(list, fmt.Sprint(item))
		}
	case string:
		decoded := v
		if unescaped, err := url.PathUnescape(v); err == nil {
			decoded = unescaped
		}
		sep := " "
		if strings.Contains(decoded, ",") {
			sep = ","
		}
		list = strings.Split(decoded, sep)
	default:
		return notEnoughScopes()
	}
	for _, scope := range required {
		found := false
		for _, g := range list {
			if g == scope {
				found = true
				break
			}
		}
		if !found {
			return notEnoughScopes()
		}
	}
	return nil
}

// Request is one outbound call made through Fetch. Body must be replayable,
// so it is bytes rather than a reader.
type Request struct {
	Method  string
	Headers map[string]string
	Body    []byte
	// Client overrides the SSRF-safe client (for providers with fixed hosts
	// that need a custom transport).
	Client *http.Client
	// Retryable marks a write that is safe to resend after a server error: a
	// read sent as POST, a write the provider deduplicates (Idempotency-Key),
	// or a step that stays invisible until a later publish call.
	Retryable bool
}

// Response is a fully read response.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// JSON decodes the body (TypeScript's `.json()`).
func (r *Response) JSON(v any) error { return json.Unmarshal(r.Body, v) }

// Text returns the body as a string.
func (r *Response) Text() string { return string(r.Body) }

// Fetch is SocialAbstract.fetch: it returns 200/201 responses and otherwise
// retries 429, rate-limit bodies and `retry` classifications up to three
// times, then maps the failure to Disconnect, RefreshToken, DailyLimit,
// RateLimited or BadBody. RateLimited and DailyLimit (nothing was created)
// come only from a refused write; a read's failures stay BadBody, since a
// read may follow a write that committed. An unclassified 500 is retried for
// reads and Retryable writes; on any other write it is UnknownDelivery after
// one request. A transport error is returned as-is and never resent.
func (b *Base) Fetch(ctx context.Context, url string, req Request) (*Response, error) {
	return b.fetch(ctx, url, req, 0, "", false)
}

// fetch sends req; resent says an earlier send of this write may have
// committed (a 500 or a `retry` answer), so a later limit proves nothing.
func (b *Base) fetch(ctx context.Context, url string, req Request, retries int, message string, resent bool) (*Response, error) {
	temporalx.SetHeartbeatDetails(ctx, "fetch "+temporalx.StripQuery(url))
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if req.Body != nil {
		body = bytes.NewReader(req.Body)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	client := req.Client
	if client == nil {
		client = ssrf.Client()
	}
	res, err := client.Do(httpReq)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode == http.StatusOK || res.StatusCode == http.StatusCreated {
		if readErr != nil {
			return nil, readErr
		}
		return &Response{Status: res.StatusCode, Header: res.Header, Body: data}, nil
	}
	text := string(data)
	if readErr != nil || text == "" {
		text = "{}"
	}
	requestBody := string(req.Body)
	if requestBody == "" {
		requestBody = "{}"
	}
	handled := b.handleErrors(text, res.StatusCode)
	// A refused write created nothing, so its limits are definite. A read may
	// follow a write that already committed, so its failures stay ambiguous.
	write := method != http.MethodGet && method != http.MethodHead
	if handled != nil && handled.Type == "limit" && !write {
		handled = &HandledError{Type: "bad-body", Value: handled.Value}
	}
	serverError := res.StatusCode == http.StatusInternalServerError && handled == nil
	if res.StatusCode == http.StatusInternalServerError && write && !req.Retryable {
		// A write may have committed before the server failed: never resend it.
		return nil, temporalx.UnknownDelivery(b.identifier, "The platform failed while handling this request and may have accepted it. Check the account before sending again.")
	}
	if handled != nil && handled.Type == "limit" {
		if resent {
			return nil, ambiguousResend(b.identifier)
		}
		// A daily cap does not clear by retrying.
		return nil, b.classify(text, requestBody, res.StatusCode, handled)
	}
	rateLimited := rateLimitedResponse(res.StatusCode, text)
	if retries > 2 {
		if rateLimited && write && resent {
			return nil, ambiguousResend(b.identifier)
		}
		if rateLimited && write {
			retryAt := RetryAt(res.Header, time.Now())
			return nil, temporalx.RateLimited(b.identifier, time.Until(retryAt), message)
		}
		return nil, temporalx.BadBody(b.identifier, text, requestBody, message)
	}
	value := "Unknown Error"
	if handled != nil && handled.Value != "" {
		value = handled.Value
	}
	if rateLimited || serverError || (handled != nil && handled.Type == "retry") {
		if err := b.Sleep(ctx, b.RetryDelay); err != nil {
			return nil, err
		}
		ambiguous := write && (serverError || handled != nil && handled.Type == "retry")
		return b.fetch(ctx, url, req, retries+1, value, resent || ambiguous)
	}
	return nil, b.classify(text, requestBody, res.StatusCode, handled)
}

// ambiguousResend ends a write resent after an answer that may have followed a
// commit: the limit that stopped the resend says nothing about the first send.
func ambiguousResend(identifier string) error {
	return temporalx.UnknownDelivery(identifier, "The platform may have accepted an earlier attempt before limiting the retry. Check the account before sending again.")
}

// rateLimitedResponse is a provider asking to slow down, by status or by body.
func rateLimitedResponse(status int, text string) bool {
	return status == http.StatusTooManyRequests || strings.Contains(text, "rate_limit_exceeded") || strings.Contains(text, "Rate limit")
}

func (b *Base) classify(text, requestBody string, status int, handled *HandledError) error {
	handledValue := ""
	if handled != nil {
		handledValue = handled.Value
	}
	if handled != nil && handled.Type == "disconnect" {
		return temporalx.Disconnect(b.identifier, text, requestBody, handledValue)
	}
	if handled != nil && handled.Type == "limit" {
		return temporalx.DailyLimit(b.identifier, handledValue)
	}
	if (status == http.StatusUnauthorized && (handled == nil || handled.Type == "refresh-token")) ||
		(handled != nil && handled.Type == "refresh-token") {
		return temporalx.RefreshToken(b.identifier, text, requestBody, handledValue)
	}
	message := "Unknown Error"
	if handledValue != "" {
		message = handledValue
	}
	return temporalx.BadBody(b.identifier, text, requestBody, message)
}

// Sleep waits d or until ctx ends (TypeScript's timer()).
func (b *Base) Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ResponseError carries a failed response from a streamed upload (the
// equivalent of an axios error with err.response).
type ResponseError struct {
	Status int
	Body   []byte
}

func (e *ResponseError) Error() string { return fmt.Sprintf("status %d: %s", e.Status, e.Body) }

// Do sends req with the SSRF-safe client and turns a non-2xx answer into a
// ResponseError, for use inside RunStreamedUpload.
func Do(req *http.Request) (*Response, error) {
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &ResponseError{Status: res.StatusCode, Body: data}
	}
	return &Response{Status: res.StatusCode, Header: res.Header, Body: data}, nil
}

// RunStreamedUpload is SocialAbstract.runStreamedUpload: fn rebuilds the
// streamed request on every attempt; ResponseErrors are retried and
// classified like a Fetch write, other errors are returned untouched.
// retryable is Request.Retryable: an upload that stays invisible until a
// later publish call may be resent after a server error; a post may not.
func RunStreamedUpload[T any](ctx context.Context, b *Base, retryable bool, fn func() (T, error)) (T, error) {
	for retries := 0; ; retries++ {
		value, err := fn()
		var respErr *ResponseError
		if err == nil || !errors.As(err, &respErr) {
			return value, err
		}
		status := respErr.Status
		if status == 0 {
			status = 500
		}
		text := string(respErr.Body)
		if text == "" {
			text = "{}"
		}
		handled := b.handleErrors(text, status)
		if status == 500 && !retryable {
			// A server error may follow a committed post: never resend it.
			return value, temporalx.UnknownDelivery(b.identifier, "The platform failed while handling this upload and may have accepted it. Check the account before sending again.")
		}
		if handled != nil && handled.Type == "limit" {
			return value, b.classify(text, "{}", status, handled)
		}
		rateLimited := rateLimitedResponse(status, text)
		serverError := status == 500 && handled == nil
		if retries <= 2 && (rateLimited || serverError || (handled != nil && handled.Type == "retry")) {
			if err := b.Sleep(ctx, b.RetryDelay); err != nil {
				return value, err
			}
			continue
		}
		if rateLimited {
			return value, temporalx.RateLimited(b.identifier, 0, "Rate limited")
		}
		return value, b.classify(text, "{}", status, handled)
	}
}

// RunInConcurrent is SocialAbstract.runInConcurrent: errors from fn (SDK
// calls without a response) are classified with handleErrors(err, 200).
func RunInConcurrent[T any](b *Base, fn func() (T, error)) (T, error) {
	value, err := fn()
	if err == nil {
		return value, nil
	}
	// Like TypeScript, a failure thrown inside fn is reclassified too: only
	// handleErrors decides, everything else becomes BadBody "Unknown Error".
	text := err.Error()
	if data, marshalErr := json.Marshal(err); marshalErr == nil && string(data) != "{}" {
		text = string(data)
	}
	handled := b.handleErrors(text, 200)
	message := "Unknown Error"
	if handled != nil && handled.Value != "" {
		message = handled.Value
	}
	if handled != nil && handled.Type == "refresh-token" {
		return value, temporalx.RefreshToken("", "{}", "{}", message)
	}
	if handled != nil && handled.Type == "disconnect" {
		return value, temporalx.Disconnect("", text, "{}", message)
	}
	return value, temporalx.BadBody("", text, "{}", message)
}

// MediaReadTimeout bounds a stalled media read (MEDIA_READ_TIMEOUT).
const MediaReadTimeout = 2 * time.Minute

func readFailed(identifier string, details any) error {
	return temporalx.BadBody(identifier, details, "{}", "We could not read the media for this post, so it was not published")
}

// ReadOrFetch reads a local file or downloads a URL into memory, retrying a
// stalled read once.
func (b *Base) ReadOrFetch(ctx context.Context, path string) ([]byte, error) {
	return b.ReadOrFetchBounded(ctx, path, 0)
}

// ReadOrFetchBounded enforces the destination byte ceiling on the actual stream,
// including local files and responses without a trustworthy Content-Length.
// A zero limit preserves the legacy unbounded reader for existing callers.
func (b *Base) ReadOrFetchBounded(ctx context.Context, path string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(path, "http") {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		return readMediaBytes(file, limit)
	}
	for attempt := 0; ; attempt++ {
		data, err := b.get(ctx, path, nil, limit)
		if err == nil || !isTimeout(err) {
			return data, err
		}
		if attempt > 0 {
			return nil, readFailed("", map[string]any{"timeoutMs": MediaReadTimeout.Milliseconds(), "path": temporalx.StripQuery(path)})
		}
	}
}

func isTimeout(err error) bool {
	return errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "Client.Timeout")
}

func (b *Base) get(ctx context.Context, url string, headers map[string]string, limits ...int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, MediaReadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("media request failed with status %d", res.StatusCode)
	}
	var limit int64
	if len(limits) > 0 {
		limit = limits[0]
	}
	return readMediaBytes(res.Body, limit)
}

func readMediaBytes(reader io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		return io.ReadAll(reader)
	}
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err == nil && int64(len(data)) > limit {
		return nil, errors.New("The media exceeds the destination's byte limit.")
	}
	return data, err
}

// MediaSize returns the byte size of a URL or local file. An R2 presigned GET
// URL cannot be used with HEAD because the HTTP method is part of its signature.
func (b *Base) MediaSize(ctx context.Context, path, identifier string) (int64, error) {
	if !strings.HasPrefix(path, "http") {
		info, err := os.Stat(path)
		if err != nil {
			return 0, err
		}
		return info.Size(), nil
	}
	temporalx.SetHeartbeatDetails(ctx, "media size "+temporalx.StripQuery(path))
	method := http.MethodHead
	if u, err := url.Parse(path); err == nil && u.Query().Has("X-Amz-Signature") {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, path, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept-Encoding", "identity")
	if method == http.MethodGet {
		req.Header.Set("Range", "bytes=0-0")
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return 0, err
	}
	res.Body.Close()
	length, _ := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64)
	if res.StatusCode == http.StatusPartialContent {
		_, total, ok := strings.Cut(res.Header.Get("Content-Range"), "/")
		if !ok {
			length = 0
		} else {
			length, _ = strconv.ParseInt(total, 10, 64)
		}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 || length <= 0 {
		return 0, temporalx.BadBody(identifier, "{}", "{}", "Could not determine the media size for upload")
	}
	return length, nil
}

// MediaChunk reads the inclusive byte range [start, end], retrying a stall once.
func (b *Base) MediaChunk(ctx context.Context, path string, start, end int64, identifier string) ([]byte, error) {
	if !strings.HasPrefix(path, "http") {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		buf := make([]byte, end-start+1)
		n, err := f.ReadAt(buf, start)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		return buf[:n], nil
	}
	temporalx.SetHeartbeatDetails(ctx, fmt.Sprintf("media chunk %d-%d %s", start, end, temporalx.StripQuery(path)))
	for attempt := 0; ; attempt++ {
		data, err := b.rangeRead(ctx, path, start, end, identifier)
		if err == nil || !isTimeout(err) {
			return data, err
		}
		if attempt > 0 {
			return nil, readFailed(identifier, map[string]any{"timeoutMs": MediaReadTimeout.Milliseconds(), "start": start, "end": end})
		}
	}
}

func (b *Base) rangeRead(ctx context.Context, path string, start, end int64, identifier string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, MediaReadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	req.Header.Set("Accept-Encoding", "identity")
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusPartialContent {
		return nil, temporalx.BadBody(identifier, "{}", "{}", fmt.Sprintf("Media server did not honor the range request (status %d)", res.StatusCode))
	}
	return io.ReadAll(res.Body)
}

// MediaStream opens the media for streaming; the caller closes it.
func (b *Base) MediaStream(ctx context.Context, path, identifier string) (io.ReadCloser, error) {
	if !strings.HasPrefix(path, "http") {
		return os.Open(path)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept-Encoding", "identity")
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		res.Body.Close()
		return nil, temporalx.BadBody(identifier, "{}", "{}", "Could not read the media for upload")
	}
	return res.Body, nil
}

// ImageDimensions reads an image's pixel size; relative paths resolve
// against FRONTEND_URL like posts.service.updateMedia.
func (b *Base) ImageDimensions(ctx context.Context, path string) (width, height int, err error) {
	url := path
	if !strings.Contains(path, "http") {
		url = os.Getenv("FRONTEND_URL") + "/" + path
	}
	temporalx.SetHeartbeatDetails(ctx, "read media "+temporalx.StripQuery(url))
	data, err := b.ReadOrFetch(ctx, url)
	if err != nil {
		return 0, 0, err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, err
	}
	return cfg.Width, cfg.Height, nil
}

// AssetBoolean accepts true/"true" (SocialAbstract.assetBoolean).
func AssetBoolean(value any) bool {
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.ToLower(v) == "true"
	}
	return false
}

// Defaults for the SocialAbstract methods providers may override.

func (b *Base) CheckValidity(context.Context, [][]ValidityMedia, json.RawMessage, []AdditionalSetting) (string, error) {
	return "", nil
}

func (b *Base) CheckPostStatus(context.Context, string, json.RawMessage, *ent.Integration) (*PendingCheckResponse, error) {
	return nil, temporalx.BadBody(b.identifier, `{"error":"checkPostStatus is not implemented for this provider"}`, "{}", "Unknown Error")
}

func (b *Base) FinalizePost(context.Context, string, json.RawMessage, *ent.Integration) (*PendingCheckResponse, error) {
	return nil, temporalx.BadBody(b.identifier, `{"error":"finalizePost is not implemented for this provider"}`, "{}", "Unknown Error")
}

func (b *Base) MigrationMatch(auth AuthTokenDetails, integration *ent.Integration) bool {
	return auth.Username != "" && integration.Profile != nil && auth.Username == *integration.Profile
}

func (b *Base) Mention(context.Context, string, string, string, *ent.Integration) ([]MentionResult, bool, error) {
	return nil, true, nil
}

func (b *Base) SettingsDTO() any               { return nil }
func (b *Base) Functions() map[string]Function { return nil }
func (b *Base) Tools() []Tool                  { return nil }
func (b *Base) Plugs() []Plug                  { return nil }
func (b *Base) InternalPlugs() []InternalPlug  { return nil }
