package emailauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// MaxBodyBytes caps the text and HTML an email may carry; a larger sign-in
// email is refused rather than parsed.
const MaxBodyBytes = 128 << 10

// maxResponseBytes bounds the provider response, attachments metadata included.
const maxResponseBytes = 1 << 20

// ErrProviderRead is a failed or refused provider read. Its text is fixed.
var ErrProviderRead = errors.New("received email could not be read")

// ErrTooLarge is an email over MaxBodyBytes.
var ErrTooLarge = errors.New("received email is too large")

// Email is a received message, held only in memory by the activity that
// consumes it. It has no JSON tags on purpose: it is never serialized.
type Email struct {
	ID        string
	From      string
	To        []string
	Text      string
	HTML      string
	CreatedAt time.Time
}

// Reader fetches one received email by provider ID.
type Reader interface {
	ReceivedEmail(ctx context.Context, emailID string) (*Email, error)
}

// Received is a received email's metadata from a listing: no body.
type Received struct {
	ID        string
	From      string
	To        []string
	CreatedAt time.Time
}

// Lister lists recently received emails, newest first. It backs up the
// webhook when a delivery is late or lost.
type Lister interface {
	RecentEmails(ctx context.Context, limit int) ([]Received, error)
}

// Resend reads the Resend Receiving API: GET /emails/receiving/{id}.
type Resend struct {
	APIKey  string
	BaseURL string
	HTTP    *http.Client
}

// ReceivedEmail fetches the message. It never follows a redirect and never
// returns provider text in its error.
func (r *Resend) ReceivedEmail(ctx context.Context, emailID string) (*Email, error) {
	if r == nil || r.APIKey == "" || emailID == "" || strings.ContainsAny(emailID, "/?#") {
		return nil, ErrProviderRead
	}
	base := r.BaseURL
	if base == "" {
		base = "https://api.resend.com"
	}
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/emails/receiving/"+url.PathEscape(emailID), nil)
	if err != nil {
		return nil, ErrProviderRead
	}
	request.Header.Set("Authorization", "Bearer "+r.APIKey)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrProviderRead
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, ErrProviderRead
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return nil, ErrProviderRead
	}
	var raw struct {
		ID        string   `json:"id"`
		From      string   `json:"from"`
		To        []string `json:"to"`
		Text      *string  `json:"text"`
		HTML      *string  `json:"html"`
		CreatedAt string   `json:"created_at"`
	}
	if err := json.Unmarshal(body, &raw); err != nil || raw.ID != emailID {
		return nil, ErrProviderRead
	}
	email := &Email{ID: raw.ID, From: raw.From, To: raw.To}
	if raw.Text != nil {
		email.Text = *raw.Text
	}
	if raw.HTML != nil {
		email.HTML = *raw.HTML
	}
	if len(email.Text)+len(email.HTML) > MaxBodyBytes {
		return nil, ErrTooLarge
	}
	if at, ok := parseTime(raw.CreatedAt); ok {
		email.CreatedAt = at
	}
	return email, nil
}

// RecentEmails lists the newest received emails: GET /emails/receiving?limit=n.
// Items it cannot read are skipped, never guessed at.
func (r *Resend) RecentEmails(ctx context.Context, limit int) ([]Received, error) {
	if r == nil || r.APIKey == "" || limit < 1 || limit > 100 {
		return nil, ErrProviderRead
	}
	base := r.BaseURL
	if base == "" {
		base = "https://api.resend.com"
	}
	client := r.HTTP
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/emails/receiving?limit="+url.QueryEscape(strconv.Itoa(limit)), nil)
	if err != nil {
		return nil, ErrProviderRead
	}
	request.Header.Set("Authorization", "Bearer "+r.APIKey)
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, ErrProviderRead
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, ErrProviderRead
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return nil, ErrProviderRead
	}
	var raw struct {
		Data []struct {
			ID        string   `json:"id"`
			From      string   `json:"from"`
			To        []string `json:"to"`
			CreatedAt string   `json:"created_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, ErrProviderRead
	}
	out := make([]Received, 0, len(raw.Data))
	for _, item := range raw.Data {
		at, ok := parseTime(item.CreatedAt)
		if item.ID == "" || len(item.To) == 0 || !ok {
			continue
		}
		out = append(out, Received{ID: item.ID, From: item.From, To: item.To, CreatedAt: at})
	}
	return out, nil
}

func parseTime(raw string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999-07", "2006-01-02 15:04:05.999999+00"} {
		if at, err := time.Parse(layout, raw); err == nil {
			return at.UTC(), true
		}
	}
	return time.Time{}, false
}
