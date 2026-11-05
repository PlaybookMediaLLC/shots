package browser

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/cdp"
)

// Provider allocates and closes isolated remote browsers.
type Provider interface {
	// Allocate starts a browser limited to these hosts for its whole life.
	Allocate(ctx context.Context, hosts []string, keepAlive time.Duration) (string, error)
	// Connect attaches a CDP client to a session.
	Connect(ctx context.Context, sessionID string) (*rod.Browser, error)
	// LiveView returns a link that lets a person use the session. It is a
	// bearer credential: return it only to the connecting user, and never log
	// or store it. Expiry is a deadline to connect, not a revocation.
	LiveView(ctx context.Context, sessionID string, connectWithin time.Duration) (string, error)
	// Close ends a session and every viewer attached to it.
	Close(ctx context.Context, sessionID string) error
}

// Cloudflare is Browser Run over its REST and CDP APIs. The token stays here;
// it never reaches a tenant row, a workflow, or a browser.
type Cloudflare struct {
	// Base is https://api.cloudflare.com/client/v4/accounts/<id>/browser-run.
	Base  string
	Token string
	HTTP  *http.Client
}

// FromEnvironment reads PLATFORM_CAPTURE_CDP_URL and
// PLATFORM_CAPTURE_CDP_TOKEN, separate from the design renderer's connection.
// It returns nil without both, which leaves authenticated capture off.
func FromEnvironment() *Cloudflare {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_CDP_URL")), "/")
	token := strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_CDP_TOKEN"))
	if base == "" || token == "" {
		return nil
	}
	return &Cloudflare{Base: base, Token: token, HTTP: &http.Client{Timeout: 30 * time.Second}}
}

func (c *Cloudflare) call(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.Base+path, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(request)
	if err != nil {
		// The transport error can carry the URL; report only that it failed.
		return &Failure{Code: ProviderUnavailable}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return &Failure{Code: ProviderUnavailable}
	}
	switch {
	case response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500:
		return &Failure{Code: ProviderUnavailable}
	case response.StatusCode == http.StatusNotFound && method == http.MethodDelete:
		return nil
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		// A bad or expired token is an outage to fix, not a verdict on the job.
		slog.Error("browser provider refused the capture token", "status", response.StatusCode)
		return &Failure{Code: ProviderUnavailable}
	case response.StatusCode >= 400:
		return fmt.Errorf("browser provider refused the request: %d", response.StatusCode)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	// Cloudflare wraps some answers in {"result": ...}.
	var wrapped struct {
		Result json.RawMessage `json:"result"`
	}
	if json.Unmarshal(data, &wrapped) == nil && len(wrapped.Result) > 0 && string(wrapped.Result) != "null" {
		data = wrapped.Result
	}
	return json.Unmarshal(data, out)
}

// Allocate starts a browser with immutable host guardrails.
func (c *Cloudflare) Allocate(ctx context.Context, hosts []string, keepAlive time.Duration) (string, error) {
	if len(hosts) == 0 {
		return "", errors.New("a browser session needs approved hosts")
	}
	query := url.Values{"keep_alive": {fmt.Sprint(keepAlive.Milliseconds())}, "targets": {"true"}}
	var out struct {
		SessionID string `json:"sessionId"`
	}
	body := map[string]any{"guardrails": map[string]any{"allowedDomains": hosts}}
	if err := c.call(ctx, http.MethodPost, "/devtools/browser?"+query.Encode(), body, &out); err != nil {
		return "", err
	}
	if out.SessionID == "" {
		return "", errors.New("browser provider returned no session")
	}
	return out.SessionID, nil
}

// Connect attaches with the bearer token in a header, never in the URL.
func (c *Cloudflare) Connect(ctx context.Context, sessionID string) (*rod.Browser, error) {
	address := strings.Replace(c.Base, "https://", "wss://", 1) + "/devtools/browser/" + url.PathEscape(sessionID)
	conn, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + c.Token}}})
	if err != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	conn.SetReadLimit(maxSocketMessage)
	browser := rod.New().Context(ctx).Client(cdp.New().Start(&socket{ctx: ctx, conn: conn})).NoDefaultDevice()
	if err := browser.Connect(); err != nil {
		_ = conn.CloseNow()
		return nil, &Failure{Code: ProviderUnavailable}
	}
	return browser, nil
}

// maxSocketMessage holds a full screenshot, base64-encoded, in one CDP message.
const maxSocketMessage = 64 << 20

// socket is rod's transport over a complete WebSocket client. Rod's own reader
// mishandled what Browser Run sends, and its client panics on any frame that is
// not JSON, which would take a worker down. Only JSON objects pass through here.
type socket struct {
	ctx  context.Context
	conn *websocket.Conn
}

func (s *socket) Send(data []byte) error { return s.conn.Write(s.ctx, websocket.MessageText, data) }

func (s *socket) Read() ([]byte, error) {
	for {
		_, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return nil, err
		}
		if len(data) > 0 && data[0] == '{' && json.Valid(data) {
			return data, nil
		}
	}
}

// LiveView returns a single-tab view of the session.
func (c *Cloudflare) LiveView(ctx context.Context, sessionID string, connectWithin time.Duration) (string, error) {
	var out struct {
		URL string `json:"devtoolsFrontendUrl"`
	}
	body := map[string]any{"mode": "tab", "expiresInMs": connectWithin.Milliseconds()}
	if err := c.call(ctx, http.MethodPost, "/devtools/browser/"+url.PathEscape(sessionID)+"/live_view", body, &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", errors.New("browser provider returned no live view")
	}
	return out.URL, nil
}

// Close is safe to repeat: a session already gone counts as closed.
func (c *Cloudflare) Close(ctx context.Context, sessionID string) error {
	return c.call(ctx, http.MethodDelete, "/devtools/browser/"+url.PathEscape(sessionID), nil, nil)
}
