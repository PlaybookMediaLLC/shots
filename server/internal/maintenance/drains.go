package maintenance

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
)

type DrainSender struct {
	Key  []byte
	HTTP *http.Client
}

// Validate the actual address dialed, including DNS rebinding. Never forward
// drain credentials through a redirect or an environment HTTP proxy.
func NewDrainSender(key []byte) *DrainSender {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		a, err := netip.ParseAddr(host)
		if err != nil {
			return fmt.Errorf("invalid drain address")
		}
		a = a.Unmap()
		if !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() || netip.MustParsePrefix("100.64.0.0/10").Contains(a) || netip.MustParsePrefix("198.18.0.0/15").Contains(a) {
			return fmt.Errorf("private drain address blocked")
		}
		return nil
	}}
	transport := telemetry.UntracedTransport.Clone()
	transport.Proxy = nil
	transport.DialContext = dialer.DialContext
	return &DrainSender{Key: key, HTTP: &http.Client{Transport: transport, Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func decryptSecret(key []byte, encoded string) (string, error) {
	parts := strings.Split(encoded, ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("invalid drain secret")
	}
	decoded := make([][]byte, 3)
	for i, p := range parts {
		b, err := base64.RawURLEncoding.DecodeString(p)
		if err != nil {
			return "", fmt.Errorf("invalid drain secret")
		}
		decoded[i] = b
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(decoded[0]) != gcm.NonceSize() || len(decoded[1]) != gcm.Overhead() {
		return "", fmt.Errorf("invalid drain secret")
	}
	plain, err := gcm.Open(nil, decoded[0], append(decoded[2], decoded[1]...), nil)
	return string(plain), err
}
func (d *DrainSender) send(ctx context.Context, endpoint, provider, encrypted string, body []byte) (int, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return 0, fmt.Errorf("invalid drain endpoint")
	}
	secret, err := decryptSecret(d.Key, encrypted)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/cloudevents+json")
	switch provider {
	case "SPLUNK":
		req.Header.Set("Authorization", "Splunk "+secret)
	case "DATADOG":
		req.Header.Set("dd-api-key", secret)
	default:
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		req.Header.Set("x-shots-signature", hex.EncodeToString(mac.Sum(nil)))
	}
	response, err := d.HTTP.Do(req)
	if err != nil {
		return 0, fmt.Errorf("drain transport failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("drain rejected delivery")
	}
	return response.StatusCode, nil
}

func drainRetryDelay(attempts int) int {
	shift := min(max(0, attempts-1), 7)
	base := min(3600, 30*(1<<shift))
	// ±25% jitter spreads synchronized retries after a SIEM outage.
	minDelay := max(1, base*3/4)
	spread := max(1, base/2)
	return minDelay + rand.IntN(spread+1)
}

func (s *Store) deliverDrainOne(ctx context.Context, id string) (delivered bool, sendFailed bool, err error) {
	var attempts int
	err = s.DB.QueryRowContext(ctx, `UPDATE audit_drain_delivery SET status='PROCESSING',"attemptCount"="attemptCount"+1,"updatedAt"=now() WHERE id=$1 AND status='PENDING' AND "attemptCount"<8 RETURNING "attemptCount"`, id).Scan(&attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	var endpoint, provider, encrypted, org, logID, action, actorType, entityType, outcome, requestID string
	var actorDisplay, actorUser, entityID *string
	var metadata json.RawMessage
	var created time.Time
	err = s.DB.QueryRowContext(ctx, `SELECT d.endpoint,d.provider,d."encryptedSigningSecret",a."organizationId",a.id,a.action,a."actorType",a."actorDisplay",a."actorUserId",a."entityType",a."entityId",a.outcome,a."requestId",a.metadata,a."createdAt" FROM audit_drain_delivery x JOIN audit_drain d ON d.id=x."drainId" JOIN audit_outbox o ON o.id=x."outboxId" JOIN audit_log a ON a.id=o."auditLogId" WHERE x.id=$1 AND d.enabled AND d."organizationId"=a."organizationId"`, id).Scan(&endpoint, &provider, &encrypted, &org, &logID, &action, &actorType, &actorDisplay, &actorUser, &entityType, &entityID, &outcome, &requestID, &metadata, &created)
	status := 0
	if err == nil {
		body, e := json.Marshal(map[string]any{"specversion": "1.0", "id": logID, "source": "screenshot-studio/organizations/" + org, "time": created.UTC().Format("2006-01-02T15:04:05.000Z"), "type": "com.screenshot-studio.audit." + action, "data": map[string]any{"action": action, "actor": map[string]any{"display": actorDisplay, "type": actorType, "userId": actorUser}, "entity": map[string]any{"id": entityID, "type": entityType}, "metadata": metadata, "outcome": outcome, "organizationId": org, "requestId": requestID}})
		if e != nil {
			return false, false, e
		}
		status, err = s.Drains.send(ctx, endpoint, provider, encrypted, body)
	}
	if ctx.Err() != nil {
		return false, false, ctx.Err()
	}
	if err == nil {
		_, err = s.DB.ExecContext(ctx, `UPDATE audit_drain_delivery SET status='DELIVERED',"deliveredAt"=now(),"updatedAt"=now(),"responseCode"=$2,"lastError"=NULL WHERE id=$1`, id, status)
		return err == nil, false, err
	}
	delay := drainRetryDelay(attempts)
	_, err = s.DB.ExecContext(ctx, `UPDATE audit_drain_delivery SET status=CASE WHEN "attemptCount">=8 THEN 'FAILED'::"AuditDrainDeliveryStatus" ELSE 'PENDING'::"AuditDrainDeliveryStatus" END,"updatedAt"=now(),"lastError"='DELIVERY_FAILED',"responseCode"=NULLIF($2,0),"nextAttemptAt"=now()+make_interval(secs=>$3) WHERE id=$1`, id, status, delay)
	return false, true, err
}

func (s *Store) AuditDrains(ctx context.Context) (int, error) {
	_, err := s.DB.ExecContext(ctx, `UPDATE audit_drain_delivery SET status=CASE WHEN "attemptCount">=8 THEN 'FAILED'::"AuditDrainDeliveryStatus" ELSE 'PENDING'::"AuditDrainDeliveryStatus" END,"updatedAt"=now(),"lastError"='INTERRUPTED' WHERE status='PROCESSING' AND "updatedAt"<now()-interval '10 minutes'`)
	if err != nil {
		return 0, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT d.id, d."drainId" FROM audit_drain_delivery d JOIN audit_drain r ON r.id=d."drainId" WHERE d.status='PENDING' AND d."attemptCount"<8 AND d."nextAttemptAt"<=now() AND r.enabled ORDER BY d."nextAttemptAt" LIMIT 100`)
	if err != nil {
		return 0, err
	}
	byDrain := map[string][]string{}
	drainOrder := []string{}
	for rows.Next() {
		var id, drainID string
		if err = rows.Scan(&id, &drainID); err != nil {
			rows.Close()
			return 0, err
		}
		if _, exists := byDrain[drainID]; !exists {
			drainOrder = append(drainOrder, drainID)
		}
		byDrain[drainID] = append(byDrain[drainID], id)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	if err = rows.Close(); err != nil {
		return 0, err
	}
	if len(drainOrder) == 0 {
		return 0, nil
	}
	// Dispatch distinct drains concurrently (up to 4 workers) while keeping
	// deliveries within each drain ordered and failing fast on a dead SIEM.
	workers := min(4, len(drainOrder))
	jobs := make(chan []string, len(drainOrder))
	for _, drainID := range drainOrder {
		jobs <- byDrain[drainID]
	}
	close(jobs)
	var wg sync.WaitGroup
	var mu sync.Mutex
	count := 0
	var firstErr error
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for batch := range jobs {
				for _, id := range batch {
					if ctx.Err() != nil {
						return
					}
					ok, failed, err := s.deliverDrainOne(ctx, id)
					mu.Lock()
					if ok {
						count++
					}
					if err != nil && firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					if err != nil {
						return
					}
					if failed {
						break
					}
				}
			}
		}()
	}
	wg.Wait()
	if firstErr == nil && ctx.Err() != nil {
		return count, ctx.Err()
	}
	return count, firstErr
}
