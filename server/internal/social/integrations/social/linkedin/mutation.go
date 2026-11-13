package linkedin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
)

var postURN = regexp.MustCompile(`^urn:li:(?:share|ugcPost):[0-9]{1,30}$`)
var commentURN = regexp.MustCompile(`^urn:li:comment:\(urn:li:(?:activity|share|ugcPost):[0-9]{1,30},[0-9]{1,30}\)$`)
var commentObject = regexp.MustCompile(`^urn:li:(?:activity|share|ugcPost):[0-9]{1,30}$`)

// mutate performs exactly one provider mutation. A transport error or server
// failure may follow a committed write and must require reconciliation.
func (p *Provider) mutate(ctx context.Context, endpoint, token string, body []byte) (*integrations.Response, error) {
	return p.request(ctx, http.MethodPost, endpoint, token, body)
}

// request also serves mention reads, without retrying a permission refusal.
func (p *Provider) request(ctx context.Context, method, endpoint, token string, body []byte) (*integrations.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, APIURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, v := range Headers(token, "application/json") {
		req.Header.Set(k, v)
	}
	client := *ssrf.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	unknown := func() (*integrations.Response, error) {
		if method == http.MethodGet {
			return nil, fmt.Errorf("LinkedIn lookup did not return a complete response")
		}
		return nil, temporalx.UnknownDelivery(p.identifier, "LinkedIn may have accepted this request. Reconcile its outcome before sending again.")
	}
	if err != nil {
		return unknown()
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return unknown()
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return &integrations.Response{Status: response.StatusCode, Header: response.Header, Body: data}, nil
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 && response.StatusCode != http.StatusRequestTimeout {
		message := responseMessage(response.StatusCode, data, token)
		var rejected error
		if response.StatusCode == http.StatusUnauthorized {
			rejected = temporalx.RefreshToken(p.identifier, "{}", "{}", message)
		} else if response.StatusCode == http.StatusTooManyRequests {
			rejected = temporalx.RateLimited(p.identifier, time.Until(integrations.RetryAt(response.Header, time.Now())), message)
		} else {
			rejected = temporalx.PublicationRejected(p.identifier, message)
		}
		return nil, &responseError{status: response.StatusCode, cause: rejected}
	}
	if method == http.MethodGet {
		return nil, &responseError{status: response.StatusCode, cause: fmt.Errorf("LinkedIn lookup failed (HTTP %d)", response.StatusCode)}
	}
	return unknown()
}

// Preserve the status without losing Temporal's definite/unknown classification.
type responseError struct {
	status int
	cause  error
}

func (e *responseError) Error() string   { return temporalx.FailureMessage(e.cause) }
func (e *responseError) Unwrap() error   { return e.cause }
func (e *responseError) HTTPStatus() int { return e.status }

func responseMessage(status int, data []byte, token string) string {
	var detail struct {
		Message          string      `json:"message"`
		Code             string      `json:"code"`
		ServiceErrorCode json.Number `json:"serviceErrorCode"`
	}
	message := fmt.Sprintf("LinkedIn rejected the request (HTTP %d)", status)
	if json.Unmarshal(data, &detail) == nil {
		if detail.Code != "" {
			message += ": " + detail.Code
		}
		if detail.ServiceErrorCode != "" {
			message += " (serviceErrorCode " + detail.ServiceErrorCode.String() + ")"
		}
		if detail.Message != "" {
			message += ": " + detail.Message
		}
	}
	if token != "" {
		message = strings.ReplaceAll(message, token, "[REDACTED]")
	}
	return temporalx.Truncate(telemetry.Scrub(message), 1000)
}

func (p *Provider) postReceipt(response *integrations.Response) (string, error) {
	id := strings.TrimSpace(response.Header.Get("x-restli-id"))
	if !postURN.MatchString(id) {
		return "", temporalx.UnknownDelivery(p.identifier, "LinkedIn accepted the request without a valid post receipt. Check the account before resending.")
	}
	return id, nil
}
