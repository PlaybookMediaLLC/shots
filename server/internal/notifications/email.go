package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"html"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	socialemail "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/email"
)

func resendConfigured() bool { return strings.TrimSpace(os.Getenv("RESEND_API_KEY")) != "" }
func emailConfigured() bool {
	return resendConfigured() || strings.TrimSpace(os.Getenv("AUTH_EMAIL_WEBHOOK_URL")) != "" || os.Getenv("EMAIL_PROVIDER") == "nodemailer" && os.Getenv("EMAIL_HOST") != ""
}
func renderEmail(e *Envelope) {
	prefs := appURL("/settings/notifications")
	summary := e.Text
	if summary == "" {
		summary = e.Subject
	}
	e.Text = summary + "\n\nWorkspace: " + e.Workspace + "\n\nOpen activity: " + e.Href + "\nNotification preferences: " + prefs
	e.HTML = "<p>" + html.EscapeString(summary) + "</p><p>Workspace: " + html.EscapeString(e.Workspace) + "</p><p><a href=\"" + html.EscapeString(e.Href) + "\">Open activity</a></p><p><a href=\"" + html.EscapeString(prefs) + "\">Notification preferences</a></p>"
}
func retryAfter(value string) time.Duration {
	if n, err := strconv.Atoi(value); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(value); err == nil && time.Until(t) > 0 {
		return time.Until(t)
	}
	return time.Minute
}
func (s *Service) send(ctx context.Context, d Delivery, e Envelope) (Outcome, error) {
	if d.Channel == "slack_dm" {
		return s.sendPersonalSlack(ctx, d, e)
	}
	if d.Channel == "slack" {
		return s.sendSlack(ctx, d, e)
	}
	if d.Channel != "email" {
		return Outcome{Status: "SKIPPED", Code: "UNSUPPORTED_CHANNEL"}, nil
	}
	if !emailConfigured() {
		return Outcome{Status: "SKIPPED", Code: "EMAIL_NOT_CONFIGURED"}, nil
	}
	from := e.From
	if from == "" {
		from = emailFrom()
	}
	if e.Transport != "" && (e.Transport != emailTransport() || e.Endpoint != s.emailEndpoint()) {
		return Outcome{Status: "BLOCKED", Code: "EMAIL_CONFIGURATION_CHANGED"}, nil
	}
	sender, err := mail.ParseAddress(from)
	if err != nil {
		return Outcome{Status: "BLOCKED", Code: "INVALID_SENDER"}, nil
	}
	if _, err = mail.ParseAddress(e.To); err != nil {
		return Outcome{Status: "BLOCKED", Code: "INVALID_RECIPIENT"}, nil
	}
	endpoint := s.emailEndpoint()
	resend := resendConfigured()
	payload := map[string]any{"to": e.To, "subject": e.Subject, "text": e.Text, "html": e.HTML}
	if resend {
		if d.sendStartedAt.Valid && time.Since(d.sendStartedAt.Time) >= 24*time.Hour {
			return Outcome{Status: "UNCERTAIN", Code: "IDEMPOTENCY_WINDOW_EXPIRED"}, nil
		}
		endpoint = strings.TrimRight(s.EmailBase, "/") + "/emails"
		payload["from"] = from
		payload["to"] = []string{e.To}
	} else if emailTransport() == "smtp" && os.Getenv("EMAIL_PROVIDER") == "nodemailer" {
		// SMTP has no provider idempotency contract; any transport error needs reconciliation.
		sent, err := (socialemail.NodeMailerProvider{}).SendMessage(ctx, e.To, e.Subject, e.Text, e.HTML, sender.Name, sender.Address)
		if err != nil {
			return Outcome{Status: "UNCERTAIN", Code: "SMTP_UNCERTAIN"}, nil
		}
		receipt, _ := sent["messageId"].(string)
		return Outcome{Status: "SUCCEEDED", Receipt: receipt}, nil
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return Outcome{Status: "BLOCKED", Code: "EMAIL_ENDPOINT_INVALID"}, nil
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return Outcome{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Outcome{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	if resend {
		req.Header.Set("Authorization", "Bearer "+os.Getenv("RESEND_API_KEY"))
		req.Header.Set("Idempotency-Key", deliveryKey(d))
	}
	response, err := s.HTTP.Do(req)
	if err != nil {
		if resend {
			return Outcome{Status: "UNCERTAIN", Code: "RESEND_ACCEPTANCE_UNCERTAIN"}, nil
		}
		return Outcome{Status: "UNCERTAIN", Code: "EMAIL_TRANSPORT_UNCERTAIN"}, nil
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if readErr != nil {
		return Outcome{Status: "UNCERTAIN", Code: "EMAIL_RESPONSE_UNCERTAIN"}, nil
	}
	if response.StatusCode == http.StatusTooManyRequests {
		return Outcome{Status: "PENDING", Code: "RATE_LIMITED", RetryAfter: retryAfter(response.Header.Get("Retry-After"))}, nil
	}
	if response.StatusCode >= 500 {
		if resend {
			return Outcome{Status: "UNCERTAIN", Code: "RESEND_ACCEPTANCE_UNCERTAIN"}, nil
		}
		return Outcome{Status: "UNCERTAIN", Code: "EMAIL_SERVER_UNCERTAIN"}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Outcome{Status: "BLOCKED", Code: "EMAIL_REQUEST_REJECTED"}, nil
	}
	receipt := ""
	if resend {
		var result struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(data, &result) != nil || result.ID == "" {
			return Outcome{Status: "UNCERTAIN", Code: "EMAIL_RESPONSE_UNCERTAIN"}, nil
		}
		receipt = result.ID
	}
	return Outcome{Status: "SUCCEEDED", Receipt: receipt}, nil
}

func emailFrom() string {
	if from := strings.TrimSpace(os.Getenv("AUTH_EMAIL_FROM")); from != "" {
		return from
	}
	return "Shots <noreply@playbookmedia.io>"
}
func emailTransport() string {
	if resendConfigured() {
		return "resend"
	}
	if os.Getenv("AUTH_EMAIL_WEBHOOK_URL") != "" {
		return "webhook"
	}
	return "smtp"
}
func (s *Service) emailEndpoint() string {
	switch emailTransport() {
	case "resend":
		return strings.TrimRight(s.EmailBase, "/") + "/emails"
	case "webhook":
		return os.Getenv("AUTH_EMAIL_WEBHOOK_URL")
	default:
		return os.Getenv("EMAIL_HOST") + ":" + os.Getenv("EMAIL_PORT") + ":" + os.Getenv("EMAIL_USER")
	}
}
