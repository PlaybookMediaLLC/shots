package maintenance

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Mailer struct {
	APIKey, From, BaseURL, SigningSecret, AutomationSigningSecret, PostalAddress string
	HTTP                                                                         *http.Client
	Endpoint                                                                     string
}
type Message struct{ OrganizationID, Product, Title, Benefit, Body, CTA, RecipientID, Email string }

func unsubscribeToken(org, email, secret string) string {
	payload := org + ":" + email
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

var announcement = template.Must(template.New("announcement").Parse(`<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#222"><p>{{.Product}}</p><h1>{{.Title}}</h1><p>{{.Benefit}}</p>{{range .Paragraphs}}<p>{{.}}</p>{{end}}{{if .CTA}}<p><a href="{{.CTA}}">See what changed</a></p>{{end}}<hr><p><a href="{{.Unsubscribe}}">Unsubscribe</a></p>{{if .Postal}}<p>{{.Postal}}</p>{{end}}</body></html>`))

// rejected is true only when the provider explicitly refused the request.
// Network errors, malformed success responses and 5xx are ambiguous; never
// automatically resend those messages after a worker restart.
func (m *Mailer) Send(ctx context.Context, msg Message) (messageID string, rejected bool, err error) {
	if m.APIKey == "" || m.From == "" || m.SigningSecret == "" {
		return "", true, fmt.Errorf("email configuration incomplete")
	}
	u, e := url.Parse(m.BaseURL)
	if e != nil || u.Scheme != "https" || u.Host == "" {
		return "", true, fmt.Errorf("email base URL invalid")
	}
	u.Path = "/api/unsubscribe"
	u.RawQuery = url.Values{"token": {unsubscribeToken(msg.OrganizationID, msg.Email, m.SigningSecret)}}.Encode()
	cta := msg.CTA
	if cta != "" {
		c, e := url.Parse(cta)
		if e != nil || (c.Scheme != "https" && c.Scheme != "http") || c.Host == "" {
			cta = ""
		}
	}
	paragraphs := []string{}
	for _, block := range strings.Split(strings.ReplaceAll(msg.Body, "\r\n", "\n"), "\n\n") {
		lines := strings.Split(block, "\n")
		for i, line := range lines {
			line = strings.TrimLeft(line, "#")
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") {
				line = "• " + line[2:]
			}
			lines[i] = line
		}
		if p := strings.TrimSpace(strings.Join(lines, " ")); p != "" {
			paragraphs = append(paragraphs, p)
		}
	}
	var html bytes.Buffer
	data := map[string]any{"Product": msg.Product, "Title": msg.Title, "Benefit": msg.Benefit, "Paragraphs": paragraphs, "CTA": cta, "Unsubscribe": u.String(), "Postal": m.PostalAddress}
	if e = announcement.Execute(&html, data); e != nil {
		return "", true, e
	}
	body, e := json.Marshal(map[string]any{"from": m.From, "to": []string{msg.Email}, "subject": msg.Title, "html": html.String(), "text": strings.Join([]string{msg.Product, msg.Title, msg.Benefit, strings.Join(paragraphs, "\n\n"), cta, "Unsubscribe: " + u.String(), m.PostalAddress}, "\n\n"), "headers": map[string]string{"List-Unsubscribe": "<" + u.String() + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Entity-Ref-ID": msg.RecipientID}})
	if e != nil {
		return "", true, e
	}
	endpoint := m.Endpoint
	if endpoint == "" {
		endpoint = "https://api.resend.com/emails"
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if e != nil {
		return "", true, e
	}
	req.Header.Set("Authorization", "Bearer "+m.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "communication/"+msg.RecipientID)
	client := m.HTTP
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, e := client.Do(req)
	if e != nil {
		return "", false, fmt.Errorf("email delivery outcome unknown")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", res.StatusCode >= 400 && res.StatusCode < 500 && res.StatusCode != 408, fmt.Errorf("email provider returned %d", res.StatusCode)
	}
	var response struct {
		ID string `json:"id"`
	}
	if e = json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&response); e != nil || response.ID == "" {
		return "", false, fmt.Errorf("email delivery outcome unknown")
	}
	return response.ID, false, nil
}
