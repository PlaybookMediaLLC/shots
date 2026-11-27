package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"strings"
	"time"
)

type InvitationMessage struct {
	Email            string
	InvitationID     string
	InviterName      string
	OrganizationName string
}

type InvitationMailer interface {
	SendInvitation(context.Context, InvitationMessage) error
}

// EnvInvitationMailer uses the same Resend or webhook transport as the
// existing authentication email flow. The backend owns delivery after cutover.
type EnvInvitationMailer struct{}

func (EnvInvitationMailer) SendInvitation(ctx context.Context, message InvitationMessage) error {
	base := strings.TrimSpace(os.Getenv("BETTER_AUTH_URL"))
	if base == "" {
		return fmt.Errorf("BETTER_AUTH_URL is required for invitation delivery")
	}
	acceptURL, err := url.Parse(base)
	if err != nil || acceptURL.Scheme == "" || acceptURL.Host == "" {
		return fmt.Errorf("invalid BETTER_AUTH_URL")
	}
	acceptURL.Path = "/accept-invitation"
	acceptURL.RawQuery = url.Values{"invitationId": {message.InvitationID}}.Encode()
	subject := "Join " + message.OrganizationName + " on Shots"
	text := fmt.Sprintf("%s invited you to the %s workspace on Shots. Accept the invitation: %s",
		message.InviterName, message.OrganizationName, acceptURL.String())
	htmlBody := fmt.Sprintf("<p>%s invited you to join %s on Shots.</p><p><a href=\"%s\">Accept invitation</a></p><p>%s</p>",
		html.EscapeString(message.InviterName), html.EscapeString(message.OrganizationName),
		html.EscapeString(acceptURL.String()), html.EscapeString(acceptURL.String()))
	err = deliverEmail(ctx, message.Email, subject, text, htmlBody)
	if errors.Is(err, errEmailNotConfigured) {
		return fmt.Errorf("invitation email is not configured")
	}
	return err
}

// errEmailNotConfigured means neither Resend nor the email webhook is set.
var errEmailNotConfigured = errors.New("email is not configured")

// deliverEmail sends one message through Resend when RESEND_API_KEY is set,
// otherwise through AUTH_EMAIL_WEBHOOK_URL, the auth email transport.
func deliverEmail(ctx context.Context, to, subject, text, htmlBody string) error {
	from := strings.TrimSpace(os.Getenv("AUTH_EMAIL_FROM"))
	if from == "" {
		from = "Shots <noreply@playbookmedia.io>"
	}
	if _, err := mail.ParseAddress(from); err != nil {
		return fmt.Errorf("invalid AUTH_EMAIL_FROM: %w", err)
	}
	endpoint := strings.TrimSpace(os.Getenv("AUTH_EMAIL_WEBHOOK_URL"))
	payload := map[string]any{"to": to, "subject": subject, "text": text, "html": htmlBody}
	headers := map[string]string{"Content-Type": "application/json"}
	if key := strings.TrimSpace(os.Getenv("RESEND_API_KEY")); key != "" {
		endpoint = "https://api.resend.com/emails"
		payload["to"] = []string{to}
		payload["from"] = from
		headers["Authorization"] = "Bearer " + key
	}
	if endpoint == "" {
		return errEmailNotConfigured
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return fmt.Errorf("invalid email endpoint")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := invitationMailClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("email delivery failed (%d): %s", response.StatusCode, strings.TrimSpace(string(detail)))
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	return nil
}

var invitationMailClient = &http.Client{Timeout: 15 * time.Second}
