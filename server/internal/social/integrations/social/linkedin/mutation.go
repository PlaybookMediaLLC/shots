package linkedin

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
)

var postURN = regexp.MustCompile(`^urn:li:(?:share|ugcPost):[0-9]{1,30}$`)
var commentURN = regexp.MustCompile(`^urn:li:comment:\(urn:li:(?:activity|share|ugcPost):[0-9]{1,30},[0-9]{1,30}\)$`)
var commentObject = regexp.MustCompile(`^urn:li:(?:activity|share|ugcPost):[0-9]{1,30}$`)

// mutate performs exactly one provider mutation. A transport error or server
// failure may follow a committed write and must require reconciliation.
func (p *Provider) mutate(ctx context.Context, endpoint, token string, body []byte) (*integrations.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, APIURL+endpoint, bytes.NewReader(body))
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
		if response.StatusCode == http.StatusUnauthorized {
			return nil, temporalx.RefreshToken(p.identifier, "{}", "{}", "Reconnect LinkedIn before retrying this rejected request.")
		}
		if response.StatusCode == http.StatusTooManyRequests {
			return nil, temporalx.RateLimited(p.identifier, time.Until(integrations.RetryAt(response.Header, time.Now())), "LinkedIn rate-limited this request.")
		}
		return nil, temporalx.BadBody(p.identifier, "{}", "{}", "LinkedIn rejected this request. Check permissions, content and account limits before retrying.")
	}
	return unknown()
}

func (p *Provider) postReceipt(response *integrations.Response) (string, error) {
	id := strings.TrimSpace(response.Header.Get("x-restli-id"))
	if !postURN.MatchString(id) {
		return "", temporalx.UnknownDelivery(p.identifier, "LinkedIn accepted the request without a valid post receipt. Check the account before resending.")
	}
	return id, nil
}
