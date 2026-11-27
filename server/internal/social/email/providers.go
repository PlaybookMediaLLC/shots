package email

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"strconv"
	"strings"
	"time"
)

var emailHTTPClient = &http.Client{Timeout: 15 * time.Second}

// Provider is EmailInterface.
type Provider interface {
	Name() string
	ValidateEnvKeys() []string
	SendEmail(ctx context.Context, to, subject, html, emailFromName, emailFromAddress, replyTo string) (any, error)
}

// EmptyProvider logs nothing and sends nothing.
type EmptyProvider struct{}

func (EmptyProvider) Name() string              { return "no provider" }
func (EmptyProvider) ValidateEnvKeys() []string { return []string{} }
func (EmptyProvider) SendEmail(_ context.Context, to, subject, html, _, _, _ string) (any, error) {
	return fmt.Sprintf("No email provider found, email was supposed to be sent to %s with subject: %s and %s, html", to, subject, html), nil
}

// resendURL is overridden in tests.
var resendURL = "https://api.resend.com"

// ResendProvider sends through the Resend HTTP API.
type ResendProvider struct{}

func (ResendProvider) Name() string              { return "resend" }
func (ResendProvider) ValidateEnvKeys() []string { return []string{"RESEND_API_KEY"} }

func (ResendProvider) SendEmail(ctx context.Context, to, subject, html, emailFromName, emailFromAddress, replyTo string) (any, error) {
	payload := map[string]any{
		"from":    emailFromName + " <" + emailFromAddress + ">",
		"to":      to,
		"subject": subject,
		"html":    html,
	}
	if replyTo != "" {
		payload["reply_to"] = replyTo
	}
	body, _ := json.Marshal(payload)

	key := os.Getenv("RESEND_API_KEY")
	if key == "" {
		key = "re_132"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, resendURL+"/emails", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")

	res, err := emailHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))

	// The SDK returns API errors (like 429 rate limits) instead of throwing;
	// they are errors here so SendEmailSync retries the send
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var apiErr struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &apiErr) != nil || apiErr.Name == "" {
			apiErr.Name, apiErr.Message = "application_error", "Internal server error. We are unable to process your request right now, please try again later."
		}
		return nil, fmt.Errorf("%s: %s", apiErr.Name, apiErr.Message)
	}

	var sent map[string]any
	_ = json.Unmarshal(data, &sent)
	return map[string]any{"data": sent, "error": nil}, nil
}

// NodeMailerProvider sends over SMTP with the EMAIL_* settings of the
// nodemailer transport.
type NodeMailerProvider struct{}

func (NodeMailerProvider) Name() string { return "nodemailer" }
func (NodeMailerProvider) ValidateEnvKeys() []string {
	return []string{"EMAIL_HOST", "EMAIL_PORT", "EMAIL_SECURE", "EMAIL_USER", "EMAIL_PASS"}
}

// plainAuth is AUTH PLAIN without net/smtp's refusal to authenticate over
// an unencrypted connection, which nodemailer does not have.
type plainAuth struct{ user, pass string }

func (a plainAuth) Start(*smtp.ServerInfo) (string, []byte, error) {
	return "PLAIN", []byte("\x00" + a.user + "\x00" + a.pass), nil
}

func (a plainAuth) Next(_ []byte, more bool) ([]byte, error) {
	if more {
		return nil, errors.New("unexpected server challenge")
	}
	return nil, nil
}

func (p NodeMailerProvider) SendEmail(ctx context.Context, to, subject, html, emailFromName, emailFromAddress, _ string) (any, error) {
	return p.SendMessage(ctx, to, subject, html, html, emailFromName, emailFromAddress)
}

// SendMessage preserves the legacy SMTP settings while carrying a real plaintext alternative.
func (NodeMailerProvider) SendMessage(ctx context.Context, to, subject, text, html, emailFromName, emailFromAddress string) (map[string]any, error) {
	host := os.Getenv("EMAIL_HOST")
	secure := os.Getenv("EMAIL_SECURE") == "true"
	// +process.env.EMAIL_PORT is NaN when unset, which nodemailer replaces
	// with its default port
	port, err := strconv.Atoi(os.Getenv("EMAIL_PORT"))
	if err != nil {
		port = 587
		if secure {
			port = 465
		}
	}
	if host == "" {
		host = "localhost"
	}
	address := net.JoinHostPort(host, strconv.Itoa(port))

	dialer := &net.Dialer{Timeout: 2 * time.Minute}
	var conn net.Conn
	if secure {
		conn, err = (&tls.Dialer{NetDialer: dialer, Config: &tls.Config{ServerName: host}}).DialContext(ctx, "tcp", address)
	} else {
		conn, err = dialer.DialContext(ctx, "tcp", address)
	}
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	client, err := smtp.NewClient(conn, host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	defer client.Close()

	// nodemailer upgrades a plain connection with STARTTLS whenever the
	// server offers it
	if !secure {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: host}); err != nil {
				return nil, err
			}
		}
	}
	if user := os.Getenv("EMAIL_USER"); user != "" {
		if err := client.Auth(plainAuth{user: user, pass: os.Getenv("EMAIL_PASS")}); err != nil {
			return nil, err
		}
	}

	messageID := "<" + randomHex(16) + "@" + domainOf(emailFromAddress) + ">"
	if err := client.Mail(emailFromAddress); err != nil {
		return nil, err
	}
	if err := client.Rcpt(to); err != nil {
		return nil, err
	}
	w, err := client.Data()
	if err != nil {
		return nil, err
	}
	if _, err := w.Write(buildAlternativeMessage(emailFromName, emailFromAddress, to, subject, text, html, messageID)); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	_ = client.Quit()

	return map[string]any{
		"accepted":  []string{to},
		"rejected":  []string{},
		"envelope":  map[string]any{"from": emailFromAddress, "to": []string{to}},
		"messageId": messageID,
	}, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func domainOf(address string) string {
	if i := strings.LastIndex(address, "@"); i >= 0 {
		return address[i+1:]
	}
	return "localhost"
}

// buildMessage is the multipart/alternative message nodemailer builds for
// {from, to, subject, text: html, html}.
func buildMessage(fromName, fromAddress, to, subject, html, messageID string) []byte {
	return buildAlternativeMessage(fromName, fromAddress, to, subject, html, html, messageID)
}
func buildAlternativeMessage(fromName, fromAddress, to, subject, text, html, messageID string) []byte {
	boundary := "--_NmP-" + randomHex(8) + "-Part_1"
	var b strings.Builder
	header := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	header("From", mime.QEncoding.Encode("utf-8", fromName)+" <"+fromAddress+">")
	header("To", to)
	header("Subject", mime.QEncoding.Encode("utf-8", subject))
	header("Message-ID", messageID)
	header("Date", time.Now().UTC().Format(time.RFC1123Z))
	header("MIME-Version", "1.0")
	header("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	for _, contentType := range []string{"text/plain", "text/html"} {
		b.WriteString("--" + boundary + "\r\n")
		header("Content-Type", contentType+"; charset=utf-8")
		header("Content-Transfer-Encoding", "base64")
		b.WriteString("\r\n")
		body := html
		if contentType == "text/plain" {
			body = text
		}
		b.WriteString(encodeBase64Lines(body))
	}
	b.WriteString("--" + boundary + "--\r\n")
	return []byte(b.String())
}

func encodeBase64Lines(s string) string {
	enc := base64.StdEncoding.EncodeToString([]byte(s))
	var out strings.Builder
	for len(enc) > 76 {
		out.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	out.WriteString(enc + "\r\n")
	return out.String()
}
