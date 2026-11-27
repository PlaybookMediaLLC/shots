package webhooks

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/lucsky/cuid"
)

// MaxAttempts is the retry budget of an automatic delivery; a manual replay
// is tried once.
const MaxAttempts = 8

// Backoff is the wait after each failed attempt, before the next.
var Backoff = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute,
	time.Hour, 3 * time.Hour, 6 * time.Hour}

// Safe error classes a delivery can record; none carries response bodies,
// URLs or secrets.
const (
	ErrorResourcePrivate    = "resource_private"
	ErrorBlockedDestination = "blocked_destination"
	ErrorConnection         = "connection"
	ErrorDNS                = "dns"
	ErrorHTTPStatus         = "http_status"
	ErrorInvalidEndpoint    = "invalid_endpoint"
	ErrorRedirect           = "redirect_refused"
	ErrorSecret             = "secret_unavailable"
	ErrorTimeout            = "timeout"
	ErrorTLS                = "tls"
)

// Dispatcher turns outbox events into deliveries and delivers them.
type Dispatcher struct {
	DB   *sql.DB
	Key  []byte
	HTTP *http.Client
	// Workers bounds concurrent deliveries; one per subscription at a time.
	Workers int
}

// NewDispatcher is a dispatcher with the safe delivery client.
func NewDispatcher(db *sql.DB, key []byte) *Dispatcher {
	return &Dispatcher{DB: db, Key: key, HTTP: NewHTTPClient(), Workers: 8}
}

// Run drains ready outbox webhook events and due deliveries for up to window,
// exiting immediately once idle so empty runs do not pin a maintenance worker
// slot or advisory-lock connection.
func (d *Dispatcher) Run(ctx context.Context, window time.Duration) (int, error) {
	deadline := time.Now().Add(window)
	total := 0
	for {
		fanned, err := d.Fanout(ctx)
		if err != nil {
			return total, err
		}
		sent, attempted, err := d.deliverBatch(ctx)
		if err != nil {
			return total, err
		}
		total += fanned + sent
		if (fanned == 0 && attempted == 0) || !time.Now().Before(deadline) {
			return total, nil
		}
		if ctx.Err() != nil {
			return total, nil
		}
	}
}

// Fanout creates one delivery per enabled subscription that chose the event,
// and marks the outbox event done, in one transaction. A repeat cannot
// duplicate a delivery: (subscription, event) is unique.
func (d *Dispatcher) Fanout(ctx context.Context) (int, error) {
	tx, err := d.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id, "organizationId", type, payload::text FROM outbox_event
		WHERE type LIKE 'webhook.%' AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL
		ORDER BY "createdAt", id LIMIT 100 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return 0, err
	}
	type event struct{ id, org, kind, body string }
	var events []event
	for rows.Next() {
		var e event
		if err := rows.Scan(&e.id, &e.org, &e.kind, &e.body); err != nil {
			rows.Close()
			return 0, err
		}
		e.kind = strings.TrimPrefix(e.kind, "webhook.")
		events = append(events, e)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	created := 0
	for _, e := range events {
		result, err := tx.ExecContext(ctx, `INSERT INTO webhook_delivery (id, "organizationId", "subscriptionId", "eventId", "eventType", body)
			SELECT 'whd' || substr(md5(s.id || ':' || $3), 1, 24), s."organizationId", s.id, $3, $4, $5
			FROM webhook_subscription s WHERE s."organizationId" = $1 AND s.enabled AND s.events ? $2
			ON CONFLICT ("subscriptionId", "eventId") DO NOTHING`, e.org, e.kind, e.id, e.kind, e.body)
		if err != nil {
			return 0, err
		}
		count, _ := result.RowsAffected()
		created += int(count)
		if _, err := tx.ExecContext(ctx, `UPDATE outbox_event SET "deliveredAt" = now(), "processingAt" = NULL WHERE id = $1`, e.id); err != nil {
			return 0, err
		}
	}
	return created, tx.Commit()
}

// claim is a delivery leased to this worker.
type claim struct {
	attempts                                    int
	body, eventID, eventType, id, org, sub, url string
	manual                                      bool
	secrets                                     []string
}

// Deliver sends the next due delivery of each subscription, at most Workers
// at once. A worker that dies mid-send leaves a lease that expires; the
// delivery is then tried again, so a receiver may see it twice and should
// deduplicate on the event ID.
func (d *Dispatcher) Deliver(ctx context.Context) (int, error) {
	sent, _, err := d.deliverBatch(ctx)
	return sent, err
}

func (d *Dispatcher) deliverBatch(ctx context.Context) (int, int, error) {
	if _, err := d.DB.ExecContext(ctx, `UPDATE webhook_delivery SET status = 'PENDING', "leaseUntil" = NULL, "updatedAt" = now()
		WHERE status = 'SENDING' AND "leaseUntil" < now()`); err != nil {
		return 0, 0, err
	}
	rows, err := d.DB.QueryContext(ctx, `SELECT DISTINCT ON (d."subscriptionId") d.id FROM webhook_delivery d
		JOIN webhook_subscription s ON s.id = d."subscriptionId"
		WHERE d.status = 'PENDING' AND d."nextAttemptAt" <= now() AND s.enabled
		  AND NOT EXISTS (SELECT 1 FROM webhook_delivery x WHERE x."subscriptionId" = d."subscriptionId" AND x.status = 'SENDING')
		ORDER BY d."subscriptionId", d."createdAt", d.id LIMIT 50`)
	if err != nil {
		return 0, 0, err
	}
	var due []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, 0, err
		}
		due = append(due, id)
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	if len(due) == 0 {
		return 0, 0, nil
	}
	workers := max(d.Workers, 1)
	queue := make(chan string)
	var wait sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	sent := 0
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for id := range queue {
				ok, err := d.deliverOne(ctx, id)
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				if ok {
					sent++
				}
				mu.Unlock()
			}
		}()
	}
	for _, id := range due {
		queue <- id
	}
	close(queue)
	wait.Wait()
	return sent, len(due), firstErr
}

func (d *Dispatcher) deliverOne(ctx context.Context, id string) (bool, error) {
	var c claim
	var previous sql.NullString
	var previousExpires sql.NullTime
	var current string
	err := d.DB.QueryRowContext(ctx, `UPDATE webhook_delivery d SET status = 'SENDING', attempts = d.attempts + 1,
			"leaseUntil" = now() + interval '2 minutes', "updatedAt" = now()
		FROM webhook_subscription s
		WHERE d.id = $1 AND d.status = 'PENDING' AND s.id = d."subscriptionId"
		RETURNING d.id, d."organizationId", d."subscriptionId", d."eventId", d."eventType", d.body, d.attempts, d.manual,
			s.url, s."encryptedSecret", s."previousEncryptedSecret", s."previousSecretExpiresAt"`, id).
		Scan(&c.id, &c.org, &c.sub, &c.eventID, &c.eventType, &c.body, &c.attempts, &c.manual, &c.url, &current, &previous, &previousExpires)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	started := time.Now()
	status, class := 0, ""
	var envelope Envelope
	if err := json.Unmarshal([]byte(c.body), &envelope); err != nil {
		return false, err
	}
	visible := true
	if envelope.SocialSetID != nil {
		if err := d.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM social_set WHERE id=$1 AND "organizationId"=$2 AND visibility='WORKSPACE')`, *envelope.SocialSetID, c.org).Scan(&visible); err != nil {
			return false, err
		}
	}
	if !visible {
		class = ErrorResourcePrivate
	} else if secret, err := Open(d.Key, current); err != nil {
		class = ErrorSecret
	} else {
		c.secrets = []string{secret}
		if previous.Valid && previousExpires.Valid && previousExpires.Time.After(time.Now()) {
			if old, err := Open(d.Key, previous.String); err == nil {
				c.secrets = append(c.secrets, old)
			}
		}
		status, class = d.send(ctx, c)
	}
	return class == "", d.record(ctx, c, started, status, class)
}

// send posts the body once and classifies the outcome.
func (d *Dispatcher) send(ctx context.Context, c claim) (int, string) {
	u, err := url.Parse(c.url)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" {
		return 0, ErrorInvalidEndpoint
	}
	timestamp := time.Now().UTC().Format(time.RFC3339)
	signatures := make([]string, 0, len(c.secrets))
	for _, secret := range c.secrets {
		signatures = append(signatures, Sign(secret, c.eventID, timestamp, []byte(c.body)))
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewReader([]byte(c.body)))
	if err != nil {
		return 0, ErrorInvalidEndpoint
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "ScreenshotStudio-Webhooks/1")
	request.Header.Set("X-Shots-Event", c.eventType)
	request.Header.Set("X-Shots-Event-Id", c.eventID)
	request.Header.Set("X-Shots-Delivery", c.id)
	request.Header.Set("X-Shots-Timestamp", timestamp)
	request.Header.Set("X-Shots-Signature", strings.Join(signatures, ","))
	response, err := d.HTTP.Do(request)
	if err != nil {
		return 0, classify(err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		return response.StatusCode, ""
	case response.StatusCode >= 300 && response.StatusCode < 400:
		return response.StatusCode, ErrorRedirect
	}
	return response.StatusCode, ErrorHTTPStatus
}

func classify(err error) string {
	var dnsError *net.DNSError
	var netError net.Error
	var certificate *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	switch {
	case errors.Is(err, errBlockedDestination):
		return ErrorBlockedDestination
	case errors.As(err, &dnsError):
		return ErrorDNS
	case errors.As(err, &certificate), errors.As(err, &unknownAuthority), errors.As(err, &hostname):
		return ErrorTLS
	case errors.As(err, &netError) && netError.Timeout(), errors.Is(err, context.DeadlineExceeded):
		return ErrorTimeout
	}
	return ErrorConnection
}

// record keeps the attempt and decides what happens next: done, retried
// after the backoff, or stopped for a manual replay.
func (d *Dispatcher) record(ctx context.Context, c claim, started time.Time, status int, class string) error {
	tx, err := d.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	outcome := "SUCCEEDED"
	if class != "" {
		outcome = "FAILED"
	}
	var responseStatus any
	if status > 0 {
		responseStatus = status
	}
	var errorClass any
	if class != "" {
		errorClass = class
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO webhook_delivery_attempt (id, "organizationId", "deliveryId", "attemptNumber",
		"startedAt", "durationMs", outcome, "responseStatus", "errorClass") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT ("deliveryId", "attemptNumber") DO NOTHING`,
		cuid.New(), c.org, c.id, c.attempts, started.UTC(), int(time.Since(started).Milliseconds()), outcome, responseStatus, errorClass); err != nil {
		return err
	}
	switch {
	case class == "":
		_, err = tx.ExecContext(ctx, `UPDATE webhook_delivery SET status = 'SUCCEEDED', "leaseUntil" = NULL, "lastAttemptAt" = $2,
			"responseStatus" = $3, "errorClass" = NULL, "updatedAt" = now() WHERE id = $1`, c.id, started.UTC(), responseStatus)
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE webhook_subscription SET "lastSuccessAt" = $2 WHERE id = $1`, c.sub, started.UTC())
		}
	case c.manual || c.attempts >= MaxAttempts || class == ErrorResourcePrivate:
		_, err = tx.ExecContext(ctx, `UPDATE webhook_delivery SET status = 'DEAD', "leaseUntil" = NULL, "lastAttemptAt" = $2,
			"responseStatus" = $3, "errorClass" = $4, "updatedAt" = now() WHERE id = $1`, c.id, started.UTC(), responseStatus, errorClass)
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE webhook_subscription SET "lastFailureAt" = $2 WHERE id = $1`, c.sub, started.UTC())
		}
	default:
		wait := Backoff[min(c.attempts-1, len(Backoff)-1)]
		_, err = tx.ExecContext(ctx, `UPDATE webhook_delivery SET status = 'PENDING', "leaseUntil" = NULL, "lastAttemptAt" = $2,
			"responseStatus" = $3, "errorClass" = $4, "nextAttemptAt" = $5, "updatedAt" = now() WHERE id = $1`,
			c.id, started.UTC(), responseStatus, errorClass, time.Now().UTC().Add(wait))
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE webhook_subscription SET "lastFailureAt" = $2 WHERE id = $1`, c.sub, started.UTC())
		}
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
