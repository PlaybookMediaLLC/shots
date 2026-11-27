package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/lucsky/cuid"
	"golang.org/x/time/rate"
)

const (
	// communicationChunkSize matches flush granularity so consent and workspace
	// operational status are re-verified every ~12.5s at default 2 req/s.
	communicationChunkSize = 25
	communicationMaxPerRun = 500
	communicationRunBudget = 6 * time.Minute
	communicationFlushSize = 25
)

func communicationRateLimit() rate.Limit {
	if raw := strings.TrimSpace(os.Getenv("RESEND_RATE_LIMIT_PER_SECOND")); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil && !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 {
			return rate.Limit(v)
		}
	}
	// Resend's default plan limit is 2 requests/second; paid plans can raise via env.
	return rate.Limit(2)
}

func pgTextArray(values []string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, v := range values {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		for j := 0; j < len(v); j++ {
			if v[j] == '\\' || v[j] == '"' {
				b.WriteByte('\\')
			}
			b.WriteByte(v[j])
		}
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}

func (s *Store) recoverCommunications(ctx context.Context) error {
	return transaction(ctx, s.DB, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE customer_communication c SET status='SCHEDULED',"updatedAt"=now() WHERE status='PROCESSING' AND "updatedAt"<now()-interval '15 minutes' AND NOT EXISTS(SELECT 1 FROM communication_attempt a WHERE a."customerCommunicationId"=c.id AND a."completedAt" IS NULL)`); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `UPDATE customer_communication c SET status='FAILED',"updatedAt"=now() WHERE status='PROCESSING' AND "updatedAt"<now()-interval '15 minutes' RETURNING id,"organizationId"`)
		if err != nil {
			return err
		}
		var uncertain [][2]string
		for rows.Next() {
			var v [2]string
			if err = rows.Scan(&v[0], &v[1]); err != nil {
				rows.Close()
				return err
			}
			uncertain = append(uncertain, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, v := range uncertain {
			if _, err = tx.ExecContext(ctx, `UPDATE communication_attempt SET "completedAt"=now(),"failureCode"='UNKNOWN_DELIVERY',outcome='FAILED' WHERE "customerCommunicationId"=$1 AND "completedAt" IS NULL`, v[0]); err != nil {
				return err
			}
			if err = audit(ctx, tx, v[1], "communication.delivery_recovery_required", "customer_communication", v[0], "FAILED", map[string]string{"failureCode": "UNKNOWN_DELIVERY"}); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) Communications(ctx context.Context) (int, error) {
	if err := s.recoverCommunications(ctx); err != nil {
		return 0, err
	}
	runDeadline := time.Now().Add(communicationRunBudget)
	if ctxDeadline, ok := ctx.Deadline(); ok {
		safe := ctxDeadline.Add(-45 * time.Second)
		if safe.Before(runDeadline) {
			runDeadline = safe
		}
	}
	candidates, err := ids(ctx, s.DB, `SELECT id FROM customer_communication WHERE channel='EMAIL' AND status='SCHEDULED' AND "scheduledFor"<=now() ORDER BY "scheduledFor" LIMIT 25`)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, id := range candidates {
		if !time.Now().Before(runDeadline) {
			break
		}
		// Fail before claiming if delivery is not configured, leaving mail retryable.
		if s.Mail == nil || s.Mail.APIKey == "" || s.Mail.From == "" || s.Mail.SigningSecret == "" {
			return total, fmt.Errorf("maintenance email configuration incomplete")
		}
		var org string
		err = s.DB.QueryRowContext(ctx, `UPDATE customer_communication SET status='PROCESSING',"updatedAt"=now() WHERE id=$1 AND status='SCHEDULED' AND "scheduledFor"<=now() RETURNING "organizationId"`, id).Scan(&org)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return total, err
		}
		ok, e := operational(ctx, s.DB, org)
		if e != nil {
			return total, e
		}
		if !ok {
			err = transaction(ctx, s.DB, func(tx *sql.Tx) error {
				if _, e := tx.ExecContext(ctx, `UPDATE customer_communication SET status='CANCELLED',"updatedAt"=now() WHERE id=$1 AND "organizationId"=$2`, id, org); e != nil {
					return e
				}
				return audit(ctx, tx, org, "communication.cancelled", "customer_communication", id, "SUCCEEDED", nil)
			})
			if err != nil {
				return total, err
			}
			continue
		}
		delivered, e := s.deliverCommunication(ctx, id, org, runDeadline)
		total += delivered
		if e != nil {
			return total, e
		}
	}
	return total, nil
}

func (s *Store) flushDeliveredRecipients(org string, recipientIDs, providerIDs []string) error {
	if len(recipientIDs) == 0 {
		return nil
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := s.DB.ExecContext(flushCtx,
		`UPDATE communication_recipient AS r SET "deliveredAt"=now(),"providerMessageId"=v.provider_id,"failureCode"=NULL
		 FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS provider_id) AS v
		 WHERE r.id=v.id AND r."organizationId"=$3`,
		pgTextArray(recipientIDs), pgTextArray(providerIDs), org)
	return err
}

func (s *Store) deliverCommunication(ctx context.Context, id, org string, runDeadline time.Time) (int, error) {
	var msg Message
	msg.OrganizationID = org
	err := s.DB.QueryRowContext(ctx, `SELECT o.name,r.title,r."benefitStatement",d."bodyMarkdown",COALESCE(c."ctaUrl",'') FROM customer_communication c JOIN organization o ON o.id=c."organizationId" JOIN release_document d ON d.id=c."releaseDocumentId" AND d."organizationId"=c."organizationId" JOIN release r ON r.id=d."releaseId" AND r."organizationId"=c."organizationId" WHERE c.id=$1 AND c."organizationId"=$2`, id, org).Scan(&msg.Product, &msg.Title, &msg.Benefit, &msg.Body, &msg.CTA)
	if err != nil {
		return 0, err
	}
	// gen_random_uuid generates IDs only; Prisma cuid fields accept arbitrary strings.
	_, err = s.DB.ExecContext(ctx, `INSERT INTO communication_recipient (id,"organizationId","customerCommunicationId","subscriberId",email) SELECT gen_random_uuid()::text,$1,$2,id,email FROM audience_subscriber WHERE "organizationId"=$1 AND "unsubscribedAt" IS NULL AND "suppressedAt" IS NULL ON CONFLICT ("customerCommunicationId",email) DO NOTHING`, org, id)
	if err != nil {
		return 0, err
	}
	attempt := cuid.New()
	var number int
	err = s.DB.QueryRowContext(ctx, `INSERT INTO communication_attempt (id,"organizationId","customerCommunicationId","attemptNumber") SELECT $1,$2,$3,COALESCE(MAX("attemptNumber"),0)+1 FROM communication_attempt WHERE "customerCommunicationId"=$3 RETURNING "attemptNumber"`, attempt, org, id).Scan(&number)
	if err != nil {
		return 0, err
	}

	// Burst of 1 with Wait on every send (including the first) sends the first
	// email immediately and spaces subsequent sends evenly at 1/limit.
	limiter := rate.NewLimiter(communicationRateLimit(), 1)
	delivered, failed, processed := 0, 0, 0
	unknown, exhausted, cancelled, budgetHit := false, false, false, false
	lastID := ""

	deliveredIDs := make([]string, 0, communicationFlushSize)
	providerIDs := make([]string, 0, communicationFlushSize)
	flush := func() error {
		if len(deliveredIDs) == 0 {
			return nil
		}
		err := s.flushDeliveredRecipients(org, deliveredIDs, providerIDs)
		deliveredIDs = deliveredIDs[:0]
		providerIDs = providerIDs[:0]
		return err
	}

	for !unknown && processed < communicationMaxPerRun && time.Now().Before(runDeadline) {
		ok, err := operational(ctx, s.DB, org)
		if err != nil {
			_ = flush()
			return delivered, err
		}
		if !ok {
			cancelled = true
			break
		}
		chunkLimit := min(communicationChunkSize, communicationMaxPerRun-processed)
		rows, err := s.DB.QueryContext(ctx,
			`SELECT r.id,r.email FROM communication_recipient r
			 JOIN audience_subscriber a ON a.id=r."subscriberId" AND a."organizationId"=r."organizationId" AND a.email=r.email
			 WHERE r."customerCommunicationId"=$1 AND r."organizationId"=$2 AND r."deliveredAt" IS NULL
			   AND a."unsubscribedAt" IS NULL AND a."suppressedAt" IS NULL AND r.id>$3
			 ORDER BY r.id LIMIT $4`,
			id, org, lastID, chunkLimit)
		if err != nil {
			_ = flush()
			return delivered, err
		}
		chunk := make([][2]string, 0, chunkLimit)
		for rows.Next() {
			var v [2]string
			if err = rows.Scan(&v[0], &v[1]); err != nil {
				rows.Close()
				_ = flush()
				return delivered, err
			}
			chunk = append(chunk, v)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			_ = flush()
			return delivered, err
		}
		if len(chunk) == 0 {
			exhausted = true
			break
		}
		for _, r := range chunk {
			if !time.Now().Before(runDeadline) {
				budgetHit = true
				break
			}
			if err := limiter.Wait(ctx); err != nil {
				_ = flush()
				return delivered, err
			}
			lastID = r[0]
			processed++
			msg.RecipientID = r[0]
			msg.Email = r[1]
			providerID, rejected, sendErr := s.Mail.Send(ctx, msg)
			if sendErr == nil {
				deliveredIDs = append(deliveredIDs, r[0])
				providerIDs = append(providerIDs, providerID)
				delivered++
				if ctx.Err() != nil {
					_ = flush()
					return delivered, ctx.Err()
				}
				if len(deliveredIDs) >= communicationFlushSize {
					if err := flush(); err != nil {
						return delivered, err
					}
				}
			} else {
				if ctx.Err() != nil {
					_ = flush()
					return delivered, ctx.Err()
				}
				if err := flush(); err != nil {
					return delivered, err
				}
				code := "PROVIDER_REJECTED"
				if !rejected {
					code = "UNKNOWN_DELIVERY"
					unknown = true
				}
				failed++
				if _, err = s.DB.ExecContext(ctx, `UPDATE communication_recipient SET "failureCode"=$2 WHERE id=$1 AND "organizationId"=$3`, r[0], code, org); err != nil {
					return delivered, err
				}
				if unknown {
					break
				}
			}
		}
		if err := flush(); err != nil {
			return delivered, err
		}
		// Heartbeat updatedAt so recovery never mistakes a large active send for a stalled one.
		if _, err := s.DB.ExecContext(ctx, `UPDATE customer_communication SET "updatedAt"=now() WHERE id=$1 AND "organizationId"=$2`, id, org); err != nil {
			return delivered, err
		}
		if len(chunk) < chunkLimit && !budgetHit && !unknown && !cancelled {
			exhausted = true
			break
		}
	}

	moreRemaining := false
	if !exhausted && !unknown && !cancelled && failed == 0 {
		if err := s.DB.QueryRowContext(ctx,
			`SELECT EXISTS(SELECT 1 FROM communication_recipient r
			 JOIN audience_subscriber a ON a.id=r."subscriberId" AND a."organizationId"=r."organizationId" AND a.email=r.email
			 WHERE r."customerCommunicationId"=$1 AND r."organizationId"=$2 AND r."deliveredAt" IS NULL
			   AND a."unsubscribedAt" IS NULL AND a."suppressedAt" IS NULL)`,
			id, org).Scan(&moreRemaining); err != nil {
			return delivered, err
		}
	}

	status, outcome, action := "DELIVERED", "SUCCEEDED", "communication.delivered"
	if moreRemaining {
		// Checkpoint partial progress cleanly; the next scheduled run resumes from undelivered rows.
		status = "SCHEDULED"
		outcome = "SUCCEEDED"
		action = "communication.chunk_delivered"
	}
	if failed > 0 {
		var priorFailed int
		if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM communication_attempt WHERE "customerCommunicationId"=$1 AND "organizationId"=$2 AND outcome='FAILED'`, id, org).Scan(&priorFailed); err != nil {
			return delivered, err
		}
		status = "SCHEDULED"
		outcome = "FAILED"
		action = "communication.partially_failed"
		if priorFailed+1 >= 3 {
			status = "FAILED"
		}
	}
	if unknown {
		status = "FAILED"
		outcome = "FAILED"
		action = "communication.delivery_recovery_required"
	}
	if cancelled {
		// Workspace deletion always cancels remaining delivery.
		status = "CANCELLED"
		outcome = "SUCCEEDED"
		action = "communication.cancelled"
	}
	err = transaction(ctx, s.DB, func(tx *sql.Tx) error {
		code := ""
		if unknown && !cancelled {
			code = "UNKNOWN_DELIVERY"
		}
		if _, e := tx.ExecContext(ctx, `UPDATE communication_attempt SET "completedAt"=now(),outcome=$2::"AttemptOutcome","failureCode"=NULLIF($3,'') WHERE id=$1`, attempt, outcome, code); e != nil {
			return e
		}
		if _, e := tx.ExecContext(ctx, `UPDATE customer_communication SET status=$2::"CustomerCommunicationStatus","updatedAt"=now() WHERE id=$1 AND "organizationId"=$3`, id, status, org); e != nil {
			return e
		}
		return audit(ctx, tx, org, action, "customer_communication", id, outcome, map[string]any{"attemptNumber": number, "delivered": delivered, "failed": failed, "failureCode": code, "remaining": moreRemaining})
	})
	return delivered, err
}
