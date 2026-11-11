package maintenance

import (
	"context"
	"database/sql"
	"errors"
)

// AccountDeletions carries out account deletion requests whose grace period
// has ended (RFC 024). A person who owns a live workspace again keeps the
// request open; it waits until they no longer do. Deletion signs the person out
// everywhere, removes their sign-in methods, preferences and memberships, and
// anonymizes the user row, which stays as the stable actor of audit history.
func (s *Store) AccountDeletions(ctx context.Context) (int, error) {
	var hubInstalled bool
	if err := s.DB.QueryRowContext(ctx, `SELECT to_regclass('founder_hub_identity.users') IS NOT NULL`).Scan(&hubInstalled); err != nil {
		return 0, err
	}
	ready := "true"
	if hubInstalled {
		ready = `NOT EXISTS (SELECT 1 FROM platform_founder_hub_user identity JOIN founder_hub_identity.users projected
			ON projected.id=identity."accountUserId" WHERE identity."userId"=request."userId")`
	}
	// Waiting for the upload horizon must not starve the next account's deletion claim.
	due, err := ids(ctx, s.DB, `SELECT id FROM account_deletion_request request WHERE
		((status='REQUESTED'
		AND NOT EXISTS (SELECT 1 FROM platform_account_attachment_blockers(request."userId"))
		AND NOT EXISTS (SELECT 1 FROM member m WHERE m."userId"=request."userId" AND m.role LIKE '%owner%'
			AND NOT EXISTS (SELECT 1 FROM workspace_deletion w WHERE w."organizationId"=m."organizationId" AND w.status IN ('PURGED','PROCESSING'))))
		OR (status='PROCESSING' AND `+ready+`)) AND "executeAfter" <= now() ORDER BY "executeAfter", id LIMIT 20`)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, id := range due {
		completed := false
		err := transaction(ctx, s.DB, func(tx *sql.Tx) error {
			// Authority projection holds the same lock; no in-flight snapshot can recreate a claimed account.
			if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(716268349103)`); err != nil {
				return err
			}
			var userID, status string
			err := tx.QueryRowContext(ctx, `SELECT "userId", status FROM account_deletion_request WHERE id=$1 AND status IN ('REQUESTED','PROCESSING') AND "executeAfter" <= now() FOR UPDATE`, id).Scan(&userID, &status)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			workspaceScope := `EXISTS (SELECT 1 FROM member WHERE "organizationId"=org.id AND "userId"=$1)`
			if hubInstalled {
				workspaceScope += ` OR EXISTS (SELECT 1 FROM founder_hub_private.shots_workspaces mapped
					JOIN founder_hub.workspaces workspace ON workspace.id=mapped.workspace_id
					JOIN platform_founder_hub_user identity ON identity."accountUserId"=workspace.owner_user_id
					WHERE mapped.shots_organization_id=org.id AND identity."userId"=$1)`
			}
			// Match workspace mutations' lock order without blocking audit foreign-key checks.
			if _, err := tx.ExecContext(ctx, `SELECT org.id FROM organization org WHERE `+workspaceScope+` ORDER BY org.id FOR NO KEY UPDATE`, userID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `SELECT 1 FROM "user" WHERE id=$1 FOR UPDATE`, userID); err != nil {
				return err
			}
			var owns bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM member m WHERE m."userId"=$1 AND m.role LIKE '%owner%'
				AND NOT EXISTS(SELECT 1 FROM workspace_deletion w WHERE w."organizationId"=m."organizationId" AND w.status IN ('PURGED','PROCESSING')))`, userID).Scan(&owns); err != nil {
				return err
			}
			if owns && status == "REQUESTED" {
				return nil
			}
			if _, err := tx.ExecContext(ctx, `UPDATE account_deletion_request SET status='PROCESSING' WHERE id=$1`, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM session WHERE "userId"=$1`, userID); err != nil {
				return err
			}
			ready, err := accountHubCleanupReady(ctx, tx, userID, status == "REQUESTED")
			if err != nil || !ready {
				return err
			}
			rows, err := tx.QueryContext(ctx, `SELECT "organizationId" FROM member WHERE "userId"=$1`, userID)
			if err != nil {
				return err
			}
			var workspaces []string
			for rows.Next() {
				var org string
				if err := rows.Scan(&org); err != nil {
					rows.Close()
					return err
				}
				workspaces = append(workspaces, org)
			}
			if err := rows.Close(); err != nil {
				return err
			}
			if err := rows.Err(); err != nil {
				return err
			}
			for _, statement := range []string{
				`DELETE FROM session WHERE "userId"=$1`,
				`DELETE FROM account WHERE "userId"=$1`,
				`DELETE FROM "twoFactor" WHERE "userId"=$1`,
				`DELETE FROM social_oauth_start WHERE "userId"=$1`,
				`DELETE FROM user_preference WHERE "userId"=$1`,
				`DELETE FROM platform_founder_hub_settings WHERE "userId"=$1`,
				`DELETE FROM platform_founder_hub_device_command WHERE "userId"=$1`,
				`DELETE FROM platform_founder_hub_device WHERE "userId"=$1`,
				`DELETE FROM platform_founder_hub_template WHERE "userId"=$1`,
				`DELETE FROM "oauthConsent" WHERE "userId"=$1`,
				`DELETE FROM apikey WHERE "referenceId"=$1`,
				`DELETE FROM member WHERE "userId"=$1`,
				`UPDATE "user" SET name='Deleted user', email='deleted-' || id || '@deleted.invalid', "emailVerified"=false,
					image=NULL, "twoFactorEnabled"=false, "updatedAt"=now() WHERE id=$1`,
				`UPDATE account_deletion_request SET status='COMPLETED', "completedAt"=now() WHERE "userId"=$1 AND status='PROCESSING'`,
			} {
				if _, err := tx.ExecContext(ctx, statement, userID); err != nil {
					return err
				}
			}
			for _, org := range workspaces {
				if err := audit(ctx, tx, org, "product.account_deleted", "user", userID, "SUCCEEDED", nil); err != nil {
					return err
				}
			}
			completed = true
			return nil
		})
		if err != nil {
			return count, err
		}
		if completed {
			count++
		}
	}
	return count, nil
}

func accountHubCleanupReady(ctx context.Context, tx *sql.Tx, userID string, begin bool) (bool, error) {
	var installed bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('founder_hub_identity.users') IS NOT NULL`).Scan(&installed); err != nil || !installed {
		return !installed, err
	}
	// The projection may never have been created for a Shots-only account.
	var accountID string
	err := tx.QueryRowContext(ctx, `SELECT identity."accountUserId" FROM platform_founder_hub_user identity
		JOIN founder_hub_identity.users projected ON projected.id=identity."accountUserId" WHERE identity."userId"=$1`, userID).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if begin {
		if err := reconcileHubCleanupOwnership(ctx, tx, accountID); err != nil {
			return false, err
		}
		if _, err := tx.ExecContext(ctx, `SELECT founder_hub.begin_account_deletion($1::uuid)`, accountID); err != nil {
			return false, err
		}
	}
	// The cleanup worker removes the projection only after Storage and replica checkpoints.
	return false, nil
}

func reconcileHubCleanupOwnership(ctx context.Context, tx *sql.Tx, accountID string) error {
	// Transfers can precede the next Hub request; the cache cannot decide which shared data to erase.
	rows, err := tx.QueryContext(ctx, `SELECT workspace.id, owner."accountUserId",
		jsonb_build_object('accountUserId',owner."accountUserId",'emailVerified',person."emailVerified",'createdAt',person."createdAt",
		'user',jsonb_build_object('id',person.id,'email',person.email,'name',person.name,'image',person.image)),
		mapped.workspace_id IS NOT NULL, org.id IS NOT NULL
		FROM founder_hub.workspaces workspace
		LEFT JOIN founder_hub_private.shots_workspaces mapped ON mapped.workspace_id=workspace.id
		LEFT JOIN organization org ON org.id=mapped.shots_organization_id
		LEFT JOIN member membership ON membership."organizationId"=org.id AND membership.role LIKE '%owner%'
		LEFT JOIN "user" person ON person.id=membership."userId"
		LEFT JOIN platform_founder_hub_user owner ON owner."userId"=person.id
		WHERE workspace.owner_user_id=$1::uuid AND workspace.kind='shared' ORDER BY workspace.id`, accountID)
	if err != nil {
		return err
	}
	var transfers []struct{ workspace, owner, snapshot string }
	seen := map[string]bool{}
	for rows.Next() {
		var workspace, snapshot string
		var owner sql.NullString
		var mapped, live bool
		if err := rows.Scan(&workspace, &owner, &snapshot, &mapped, &live); err != nil {
			rows.Close()
			return err
		}
		if !mapped || seen[workspace] || (live && !owner.Valid) {
			rows.Close()
			return errors.New("Founder Hub shared workspace has no unambiguous Shots owner")
		}
		seen[workspace] = true
		if live && owner.String != accountID {
			transfers = append(transfers, struct{ workspace, owner, snapshot string }{workspace, owner.String, snapshot})
		}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, transfer := range transfers {
		if _, err := tx.ExecContext(ctx, `SELECT founder_hub_private.project_shots_user($1::jsonb,revision) FROM platform_founder_hub_revision WHERE id='authority'`, transfer.snapshot); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE founder_hub.workspaces SET owner_user_id=$2::uuid,updated_at=now() WHERE id=$1::uuid`, transfer.workspace, transfer.owner); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO founder_hub.workspace_memberships(workspace_id,user_id,role) VALUES($1::uuid,$2::uuid,'owner')
			ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='owner',deleted_at=NULL,updated_at=now()`, transfer.workspace, transfer.owner); err != nil {
			return err
		}
	}
	var retainedAttachments bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM founder_hub.session_share_attachment_objects attachment
		JOIN founder_hub.session_shares share ON share.id=attachment.share_id
		JOIN founder_hub.workspaces workspace ON workspace.id=share.workspace_id
		WHERE attachment.owner_user_id=$1::uuid AND workspace.owner_user_id<>$1::uuid AND attachment.state<>'deleting')`, accountID).Scan(&retainedAttachments); err != nil {
		return err
	}
	if retainedAttachments {
		// shortcut: transferred shared attachments block deletion until their objects can move durably to the new owner.
		return errors.New("retained shared attachments must transfer before account deletion")
	}
	return nil
}
