package x

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

func uncertainMutation() error {
	return temporalx.UnknownDelivery(identifier, "X may have accepted this post or Article. Check the account and Article drafts before trying again to avoid duplicates.")
}

// mutationJSON sends a non-idempotent content mutation exactly once. A missing
// receipt is an uncertain outcome, never permission to resend the same request.
// Unlike the shared fetch helper, this does not retry responses or redirects.
func (c *client) mutationJSON(ctx context.Context, endpoint string, body, out any) error {
	if strings.TrimSpace(os.Getenv("X_API_KEY")) == "" || strings.TrimSpace(os.Getenv("X_API_SECRET")) == "" {
		return publishRejected("X application credentials are not configured. No publication request was sent.")
	}
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil {
			return publishRejected("The X publication request is invalid.")
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return publishRejected("The X publication destination is invalid.")
	}
	req.Header.Set("Authorization", signOAuth1(http.MethodPost, endpoint, c.token, c.secret))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	httpClient := *ssrf.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	temporalx.SetHeartbeatDetails(ctx, "x: send publication once")
	res, err := httpClient.Do(req)
	if err != nil {
		return uncertainMutation()
	}
	defer res.Body.Close()
	const maxReceiptBytes = 1 << 20
	data, err = io.ReadAll(io.LimitReader(res.Body, maxReceiptBytes+1))
	if err != nil || len(data) > maxReceiptBytes {
		return uncertainMutation()
	}
	// A server error or redirect can follow a committed mutation. The body
	// cannot override that ambiguity by claiming a retryable error.
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if res.StatusCode < 400 || res.StatusCode >= 500 || res.StatusCode == http.StatusRequestTimeout {
			return uncertainMutation()
		}
		handled := handleErrors(string(data), res.StatusCode)
		if res.StatusCode == http.StatusUnauthorized || handled != nil && handled.Type == "refresh-token" {
			return temporalx.RefreshToken(identifier, "{}", "{}", "X rejected this authorization. Reconnect the account.")
		}
		if res.StatusCode == http.StatusTooManyRequests || res.StatusCode == 420 {
			// X refused before creating anything, so a later attempt is safe.
			if res.Header.Get("x-user-limit-24hour-remaining") == "0" || res.Header.Get("x-app-limit-24hour-remaining") == "0" {
				return temporalx.DailyLimit(identifier, "X's daily posting limit was reached. Reschedule it after the limit resets.")
			}
			return temporalx.RateLimited(identifier, time.Until(integrations.RetryAt(res.Header, time.Now())), "X rate-limited this request.")
		}
		message := "X rejected this publication request. Review it before trying again."
		if handled != nil && handled.Value != "" {
			message = handled.Value
		}
		return publishRejected(message)
	}
	var envelope struct {
		Data   json.RawMessage   `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(data, &envelope) != nil || len(envelope.Data) == 0 || bytes.Equal(envelope.Data, []byte("null")) || len(envelope.Errors) != 0 {
		return uncertainMutation()
	}
	if json.Unmarshal(data, out) != nil {
		return uncertainMutation()
	}
	return nil
}
