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

	"github.com/lucsky/cuid"
	"golang.org/x/time/rate"
)

const (
	automationKindNoConnectedAccounts = "no_connected_accounts"
	automationKindInactivityNoPosts   = "inactivity_no_posts"
)

// AutomationUnsubscribeToken generates an HMAC-SHA256 token scoped to turning
// off lifecycle automation emails for userID.
func AutomationUnsubscribeToken(userID, secret string) string {
	payload := "automation:" + userID
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

var automationTemplate = template.Must(template.New("automation").Parse(
	`<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px;color:#222"><h1>{{.Title}}</h1><p>{{.Body}}</p><p><a href="{{.CTA}}">{{.CTALabel}}</a></p><hr><p style="font-size:12px;color:#666">You are receiving this reminder because Automation Emails are enabled in Shots. <a href="{{.Prefs}}">Manage email preferences</a> · <a href="{{.Unsubscribe}}">Unsubscribe</a></p>{{if .Postal}}<p style="font-size:12px;color:#666">{{.Postal}}</p>{{end}}</body></html>`,
))

type automationCandidate struct {
	userID        string
	email         string
	organization  string
	workspaceName string
	kind          string
	windowKey     string
}

func (m *Mailer) automationSecret() string {
	if m == nil {
		return ""
	}
	if s := strings.TrimSpace(m.AutomationSigningSecret); s != "" {
		return s
	}
	return strings.TrimSpace(m.SigningSecret)
}

// SendAutomationReminder delivers a single lifecycle reminder email with
// Resend idempotency and RFC 8058 one-click unsubscribe headers.
// rejected is true only on explicit provider refusal (429 / 4xx) or invalid
// local config; ambiguous 5xx / network outcomes return rejected=false so the
// claimed log row remains recorded and prevents duplicate sends on retry.
func (m *Mailer) SendAutomationReminder(ctx context.Context, idempotencyKey, userID, toEmail, title, bodyText, ctaPath, ctaLabel string) (receipt string, rejected bool, err error) {
	secret := m.automationSecret()
	if m == nil || m.APIKey == "" || m.From == "" || secret == "" {
		return "", true, fmt.Errorf("email configuration incomplete")
	}
	base, err := url.Parse(m.BaseURL)
	if err != nil || (base.Scheme != "https" && base.Scheme != "http") || base.Host == "" {
		return "", true, fmt.Errorf("email base URL invalid")
	}
	unsub := *base
	unsub.Path = "/api/v1/email/unsubscribe"
	unsub.RawQuery = url.Values{"token": {AutomationUnsubscribeToken(userID, secret)}}.Encode()

	prefs := *base
	prefs.Path = "/settings/notifications"
	prefs.RawQuery = ""

	cta := *base
	cta.Path = ctaPath
	cta.RawQuery = ""

	var htmlBuf bytes.Buffer
	if err := automationTemplate.Execute(&htmlBuf, map[string]any{
		"Title":       title,
		"Body":        bodyText,
		"CTA":         cta.String(),
		"CTALabel":    ctaLabel,
		"Prefs":       prefs.String(),
		"Unsubscribe": unsub.String(),
		"Postal":      m.PostalAddress,
	}); err != nil {
		return "", true, err
	}
	textPart := strings.Join([]string{
		title,
		bodyText,
		ctaLabel + ": " + cta.String(),
		"Manage preferences: " + prefs.String(),
		"Unsubscribe: " + unsub.String(),
		m.PostalAddress,
	}, "\n\n")
	payload, err := json.Marshal(map[string]any{
		"from":    m.From,
		"to":      []string{toEmail},
		"subject": title,
		"html":    htmlBuf.String(),
		"text":    textPart,
		"headers": map[string]string{
			"List-Unsubscribe":      "<" + unsub.String() + ">",
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			"X-Entity-Ref-ID":       idempotencyKey,
		},
	})
	if err != nil {
		return "", true, err
	}
	endpoint := m.Endpoint
	if endpoint == "" {
		endpoint = "https://api.resend.com/emails"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", true, err
	}
	req.Header.Set("Authorization", "Bearer "+m.APIKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "automation/"+idempotencyKey)
	client := m.HTTP
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, err := client.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("automation email delivery outcome unknown")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusTooManyRequests {
		return "", true, fmt.Errorf("automation email provider rate limited (429)")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", false, fmt.Errorf("automation email provider returned %d", res.StatusCode)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&out); err != nil || out.ID == "" {
		return "", false, fmt.Errorf("automation email provider response invalid")
	}
	return out.ID, false, nil
}

// AutomationReminders runs daily to send bounded, opt-out-respecting lifecycle
// reminders for workspaces with no connected accounts (>48h old, max 2 sends)
// or no recent scheduled/published posts (7+ days inactive, 14-day cooldown).
func (s *Store) AutomationReminders(ctx context.Context) (int, error) {
	if s.Mail == nil || s.Mail.APIKey == "" || s.Mail.From == "" || s.Mail.automationSecret() == "" {
		return 0, nil
	}
	now := time.Now().UTC()
	year, week := now.ISOWeek()
	windowKey := fmt.Sprintf("%04d-W%02d", year, week)

	var candidates []automationCandidate

	// Rule 1: workspaces >48h old with zero connected social accounts (owners/admins).
	noConnRows, err := s.DB.QueryContext(ctx, `
		SELECT u.id, u.email, o.id, o.name
		FROM member m
		JOIN "user" u ON u.id = m."userId"
		JOIN organization o ON o.id = m."organizationId"
		LEFT JOIN user_preference up ON up."userId" = u.id
		WHERE u."emailVerified" = true
		  AND COALESCE(u.banned, false) = false
		  AND COALESCE(up."emailNotifications", true) = true
		  AND COALESCE(up."automationEmails", true) = true
		  AND m.role IN ('owner', 'admin')
		  AND o."createdAt" <= now() - interval '48 hours'
		  AND NOT EXISTS (SELECT 1 FROM workspace_deletion wd WHERE wd."organizationId" = o.id AND wd.status <> 'CANCELLED')
		  AND NOT EXISTS (SELECT 1 FROM account_deletion_request ad WHERE ad."userId" = u.id AND ad.status IN ('REQUESTED', 'PROCESSING'))
		  AND NOT EXISTS (SELECT 1 FROM channel_connection cc WHERE cc."organizationId" = o.id)
		  AND (
		    SELECT count(*) FROM user_automation_email_log l
		    WHERE l."userId" = u.id AND l."organizationId" = o.id AND l.kind = $1
		  ) < 2
		  AND NOT EXISTS (
		    SELECT 1 FROM user_automation_email_log l
		    WHERE l."userId" = u.id AND l."organizationId" = o.id AND l.kind = $1
		      AND l."createdAt" >= now() - interval '14 days'
		  )
		ORDER BY o."createdAt" ASC, u.id ASC
		LIMIT 100
	`, automationKindNoConnectedAccounts)
	if err != nil {
		return 0, err
	}
	for noConnRows.Next() {
		var c automationCandidate
		if err := noConnRows.Scan(&c.userID, &c.email, &c.organization, &c.workspaceName); err != nil {
			noConnRows.Close()
			return 0, err
		}
		c.kind = automationKindNoConnectedAccounts
		c.windowKey = windowKey
		candidates = append(candidates, c)
	}
	if err := noConnRows.Err(); err != nil {
		noConnRows.Close()
		return 0, err
	}
	noConnRows.Close()

	// Rule 2: workspaces with connected accounts but zero scheduled or published
	// posts in the last 7 days (14-day cooldown per user/workspace). Split the
	// scheduled_post check into two indexed NOT EXISTS predicates.
	inactivityRows, err := s.DB.QueryContext(ctx, `
		SELECT u.id, u.email, o.id, o.name
		FROM member m
		JOIN "user" u ON u.id = m."userId"
		JOIN organization o ON o.id = m."organizationId"
		LEFT JOIN user_preference up ON up."userId" = u.id
		WHERE u."emailVerified" = true
		  AND COALESCE(u.banned, false) = false
		  AND COALESCE(up."emailNotifications", true) = true
		  AND COALESCE(up."automationEmails", true) = true
		  AND m.role IN ('owner', 'admin', 'publisher', 'writer_publisher')
		  AND o."createdAt" <= now() - interval '7 days'
		  AND NOT EXISTS (SELECT 1 FROM workspace_deletion wd WHERE wd."organizationId" = o.id AND wd.status <> 'CANCELLED')
		  AND NOT EXISTS (SELECT 1 FROM account_deletion_request ad WHERE ad."userId" = u.id AND ad.status IN ('REQUESTED', 'PROCESSING'))
		  AND EXISTS (SELECT 1 FROM channel_connection cc WHERE cc."organizationId" = o.id AND cc.status = 'ACTIVE')
		  AND NOT EXISTS (
		    SELECT 1 FROM scheduled_post sp
		    WHERE sp."organizationId" = o.id
		      AND sp.status IN ('SCHEDULED', 'PROCESSING', 'PUBLISHED', 'SENT_TO_APP')
		      AND sp."scheduledFor" >= now() - interval '7 days'
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM scheduled_post sp
		    WHERE sp."organizationId" = o.id
		      AND sp.status IN ('SCHEDULED', 'PROCESSING', 'PUBLISHED', 'SENT_TO_APP')
		      AND sp."createdAt" >= now() - interval '7 days'
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM user_automation_email_log l
		    WHERE l."userId" = u.id AND l."organizationId" = o.id AND l.kind = $1
		      AND l."createdAt" >= now() - interval '14 days'
		  )
		ORDER BY o."createdAt" ASC, u.id ASC
		LIMIT 100
	`, automationKindInactivityNoPosts)
	if err != nil {
		return 0, err
	}
	for inactivityRows.Next() {
		var c automationCandidate
		if err := inactivityRows.Scan(&c.userID, &c.email, &c.organization, &c.workspaceName); err != nil {
			inactivityRows.Close()
			return 0, err
		}
		c.kind = automationKindInactivityNoPosts
		c.windowKey = windowKey
		candidates = append(candidates, c)
	}
	if err := inactivityRows.Err(); err != nil {
		inactivityRows.Close()
		return 0, err
	}
	inactivityRows.Close()

	limiter := rate.NewLimiter(communicationRateLimit(), 1)
	sent := 0
	for _, c := range candidates {
		if err := ctx.Err(); err != nil {
			return sent, err
		}
		if err := limiter.Wait(ctx); err != nil {
			return sent, err
		}
		logID := cuid.New()
		// Claim the unique window BEFORE calling the external email provider so a
		// crash after sending never double-emails the user on retry.
		res, err := s.DB.ExecContext(ctx, `
			INSERT INTO user_automation_email_log (id, "userId", "organizationId", kind, "windowKey", status)
			VALUES ($1, $2, $3, $4, $5, 'PENDING')
			ON CONFLICT ("userId", "organizationId", kind, "windowKey") DO NOTHING
		`, logID, c.userID, c.organization, c.kind, c.windowKey)
		if err != nil {
			return sent, err
		}
		affected, _ := res.RowsAffected()
		if affected == 0 {
			continue
		}
		var title, bodyText, ctaPath, ctaLabel string
		if c.kind == automationKindNoConnectedAccounts {
			title = "Connect your first social account in " + c.workspaceName
			bodyText = "You haven't connected any social channels yet in " + c.workspaceName + ". Connect an account to start scheduling posts and filling your weekly queue."
			ctaPath = "/settings/channels"
			ctaLabel = "Connect accounts"
		} else {
			title = "Your publishing queue is empty in " + c.workspaceName
			bodyText = "You haven't scheduled or published any posts in the last 7 days for " + c.workspaceName + ". Draft a quick update to keep your publishing rhythm going."
			ctaPath = "/publish/calendar"
			ctaLabel = "Open publishing calendar"
		}
		idempotencyKey := fmt.Sprintf("%s:%s:%s:%s", c.userID, c.organization, c.kind, c.windowKey)
		receipt, rateLimited, sendErr := s.Mail.SendAutomationReminder(ctx, idempotencyKey, c.userID, c.email, title, bodyText, ctaPath, ctaLabel)
		finalizeCtx, cancelFinalize := context.WithTimeout(context.Background(), 5*time.Second)
		if sendErr != nil {
			if rateLimited {
				_, delErr := s.DB.ExecContext(finalizeCtx, `DELETE FROM user_automation_email_log WHERE id = $1`, logID)
				cancelFinalize()
				if delErr != nil {
					return sent, delErr
				}
				break
			}
			_, updErr := s.DB.ExecContext(finalizeCtx, `UPDATE user_automation_email_log SET status = 'FAILED' WHERE id = $1`, logID)
			cancelFinalize()
			if updErr != nil {
				return sent, updErr
			}
			continue
		}
		_, updErr := s.DB.ExecContext(finalizeCtx, `UPDATE user_automation_email_log SET status = 'SENT', "providerReceipt" = $2 WHERE id = $1`, logID, receipt)
		cancelFinalize()
		if updErr != nil {
			return sent, updErr
		}
		sent++
	}
	return sent, nil
}
