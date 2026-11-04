package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func (s *Store) WorkspaceCleanup(ctx context.Context) (int, error) {
	// Purges are idempotent: a crash before the transaction commits can resume.
	if _, err := s.DB.ExecContext(ctx, `UPDATE workspace_deletion SET status='PENDING',"processingAt"=NULL,"updatedAt"=now() WHERE status='PROCESSING' AND "processingAt"<now()-interval '15 minutes'`); err != nil {
		return 0, err
	}
	candidates, err := ids(ctx, s.DB, `SELECT id FROM workspace_deletion WHERE status='PENDING' AND "scheduledFor"<=now() ORDER BY "scheduledFor" LIMIT 10`)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, id := range candidates {
		var org string
		err = s.DB.QueryRowContext(ctx, `UPDATE workspace_deletion SET status='PROCESSING',"processingAt"=now(),"updatedAt"=now(),"lastError"=NULL WHERE id=$1 AND status='PENDING' AND "scheduledFor"<=now() RETURNING "organizationId"`, id).Scan(&org)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return count, err
		}
		err = s.purgeWorkspace(ctx, id, org)
		if ctx.Err() != nil {
			return count, ctx.Err()
		}
		if err != nil {
			if _, e := s.DB.ExecContext(ctx, `UPDATE workspace_deletion SET status='PENDING',"processingAt"=NULL,"updatedAt"=now(),"lastError"='PURGE_FAILED' WHERE id=$1 AND status='PROCESSING'`, id); e != nil {
				return count, e
			}
			return count, fmt.Errorf("workspace purge failed")
		}
		count++
	}
	return count, nil
}
func (s *Store) purgeWorkspace(ctx context.Context, id, org string) error {
	// A run still going would write pages back after the purge deleted them.
	if s.Onboarding != nil {
		if err := s.Onboarding.Cancel(ctx, org); err != nil {
			return err
		}
	}
	keys, err := ids(ctx, s.DB, `SELECT "objectKey" FROM asset WHERE "organizationId"=$1`, org)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if err = s.Objects.Delete(ctx, org, key); err != nil {
			return err
		}
	}
	return transaction(ctx, s.DB, func(tx *sql.Tx) error {
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM workspace_deletion WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, org).Scan(&status); err != nil {
			return err
		}
		if status != "PROCESSING" {
			return fmt.Errorf("workspace deletion state changed")
		}
		// Keep the organization tombstone and audit evidence. Delete platform data
		// children before parents; tenant predicates apply even to cascading tables.
		// These tables were added by a newer web release. Delete them when
		// present while retaining compatibility during a rolling web upgrade.
		// Mutation receipts embed drafts and cannot rely on the retained organization tombstone.
		for _, table := range []string{"frontend_observation", "frontend_activation", "frontend_source", "calendar_mutation", "analytics_snapshot", "analytics_post", "analytics_account", "platform_notification_inbox", "platform_notification_preference", "platform_notification_seen_action", "platform_notification_delivery", "platform_notification_policy", "platform_slack_connection", "github_observation", "github_production_policy", "github_recovery_scan", "release_automation_node", "release_automation_run", "release_source_event", "release_automation_version", "release_automation", "social_oauth_start", "social_tenant_binding", "github_install_start", "workspace_github_installation", "source_change", "deployment_event", "surface_capture", "product_profile", "conversation_message", "conversation", "launch_run_step", "page_knowledge", "enrichment_record", "ideal_customer_profile", "onboarding_run"} {
			var exists bool
			if err := tx.QueryRowContext(ctx, `SELECT to_regclass($1) IS NOT NULL`, table).Scan(&exists); err != nil {
				return err
			}
			if exists {
				if _, err := tx.ExecContext(ctx, `DELETE FROM "`+table+`" WHERE "organizationId"=$1`, org); err != nil {
					return err
				}
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM platform_slack_installation i WHERE NOT EXISTS(SELECT 1 FROM platform_slack_connection c WHERE c.installation_id=i.id)`); err != nil {
			return err
		}
		tables := []string{"store_review_comment", "store_review", "store_publishing_credential", "permission_group", "audit_drain", "audit_retention_policy", "communication_recipient", "communication_attempt", "customer_communication", "launch_run", "campaign_revision", "campaign_plan", "release_spec", "campaign_post", "content_angle", "campaign_asset", "campaign", "publication_attempt", "scheduled_post", "content_draft_revision", "content_draft", "channel_connection", "social_set_writing_sample", "social_set", "content_draft_settings", "webhook_delivery_attempt", "webhook_delivery", "webhook_subscription", "approval", "creative_variant", "design", "release_document", "capture_job", "capture", "asset", "creative_template", "capture_recipe", "source_app", "brand_kit", "brand_profile", "product_surface", "release", "audience_subscriber", "support_access_grant", "outbox_event", "organization_enterprise_settings", "workspace_settings", "invitation", "member"}
		for _, table := range tables {
			if _, err := tx.ExecContext(ctx, `DELETE FROM "`+table+`" WHERE "organizationId"=$1`, org); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM apikey WHERE "referenceId"=$1`, org); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM "ssoProvider" WHERE "organizationId"=$1`, org); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM "scimProvider" WHERE "organizationId"=$1`, org); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM session WHERE "activeOrganizationId"=$1`, org); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE organization SET name=$2,slug=$3,logo=NULL,metadata=NULL WHERE id=$1`, org, "Deleted workspace "+org[:min(8, len(org))], "deleted-"+strings.ToLower(org)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_deletion SET status='PURGED',"processingAt"=NULL,"purgedAt"=now(),"updatedAt"=now() WHERE id=$1`, id); err != nil {
			return err
		}
		return audit(ctx, tx, org, "product.workspace_purged", "workspace_deletion", id, "SUCCEEDED", nil)
	})
}
