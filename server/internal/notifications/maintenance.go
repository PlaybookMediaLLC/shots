package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Maintain checks up to 50 installations per hourly run within its 30-second
// budget and removes only receipts whose source can no longer replay.
func (s *Service) Maintain(ctx context.Context) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `DELETE FROM platform_notification_delivery WHERE id IN (SELECT d.id FROM platform_notification_delivery d WHERE NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.id=d.event_id AND e."organizationId"=d."organizationId") ORDER BY d.id LIMIT 500 FOR UPDATE SKIP LOCKED)`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE platform_notification_delivery SET encrypted_payload='' WHERE status='UNCERTAIN' AND send_started_at<now()-interval '24 hours' AND encrypted_payload<>''`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM social_oauth_start WHERE provider='platform-slack' AND "expiresAt"<now()`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM social_oauth_start WHERE provider<>'platform-slack' AND (("exchangeStatus"='COMPLETED' AND "completedAt"<now()-interval '24 hours') OR ("exchangeStatus"<>'COMPLETED' AND "expiresAt"<now()-interval '24 hours'))`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM platform_slack_installation i WHERE NOT EXISTS(SELECT 1 FROM platform_slack_connection c WHERE c.installation_id=i.id) AND NOT EXISTS(SELECT 1 FROM platform_slack_personal_connection c WHERE c.installation_id=i.id)`); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	healthCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for range 50 {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if healthCtx.Err() != nil {
			return nil
		}
		var installation, team string
		err = s.DB.QueryRowContext(healthCtx, `UPDATE platform_slack_installation i SET checked_at=now() WHERE i.id=(SELECT s.id FROM platform_slack_installation s WHERE s.health='CONNECTED' AND (s.checked_at IS NULL OR s.checked_at<now()-interval '1 hour') AND (EXISTS(SELECT 1 FROM platform_slack_connection c WHERE c.installation_id=s.id) OR EXISTS(SELECT 1 FROM platform_slack_personal_connection c WHERE c.installation_id=s.id)) ORDER BY s.checked_at NULLS FIRST,s.id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING i.id,i.team_id`).Scan(&installation, &team)
		if errors.Is(err, sql.ErrNoRows) || (errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil) {
			return nil
		}
		if err != nil {
			return err
		}
		var encrypted, health string
		var expires sql.NullTime
		err = s.DB.QueryRowContext(healthCtx, `SELECT encrypted_credentials,health,expires_at FROM platform_slack_installation WHERE id=$1`, installation).Scan(&encrypted, &health, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return nil
		}
		if err != nil {
			return err
		}
		token, callErr := s.installationToken(healthCtx, installation, encrypted, health, expires)
		if callErr != nil {
			continue
		}
		result, callErr := s.slackAPI(healthCtx, token, "auth.test", map[string]any{})
		if callErr != nil {
			var provider *slackError
			if errors.As(callErr, &provider) && (provider.Code == "invalid_auth" || provider.Code == "token_revoked" || provider.Code == "account_inactive") {
				revokeCtx, revokeCancel := context.WithTimeout(ctx, 5*time.Second)
				err = s.revokeInstallation(revokeCtx, installation)
				revokeCancel()
				if err != nil {
					return err
				}
			}
			continue
		}
		var identity string
		if json.Unmarshal(result["team_id"], &identity) != nil || identity != team {
			revokeCtx, revokeCancel := context.WithTimeout(ctx, 5*time.Second)
			err = s.revokeInstallation(revokeCtx, installation)
			revokeCancel()
			if err != nil {
				return err
			}
		}
	}
	return nil
}
