package platformmigrations

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
)

func TestReleaseQualificationMigrationFreshAndUpgrade(t *testing.T) {
	uri := os.Getenv("PLATFORM_RELEASE_QUALIFICATION_TEST_DATABASE_URL")
	if uri == "" {
		t.Skip("requires an empty disposable release qualification migration database")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, uri)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var name string
	var existing bool
	if err := db.SQL.QueryRow(`SELECT current_database(),to_regclass('public.organization') IS NOT NULL`).Scan(&name, &existing); err != nil || !strings.Contains(name, "test") || existing {
		t.Fatal("requires an empty disposable test database")
	}
	if err := Apply(ctx, db.SQL); err != nil {
		t.Fatalf("fresh migration: %v", err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Only the fresh test database is restored to the immediately preceding schema.
	previous, err := os.ReadFile("sql/20261113100000_composer_video_options.sql")
	if err != nil {
		t.Fatal(err)
	}
	exec(string(previous)[strings.Index(string(previous), "CREATE OR REPLACE FUNCTION platform_asset_in_use_v1"):])
	exec(`DROP TABLE platform_kit_export, platform_kit_review_decision, platform_kit_source_pin, platform_kit_member, platform_kit_artifact_claim, platform_kit_artifact_revision, platform_release_kit_revision, platform_release_kit`)
	exec(`DROP FUNCTION platform_kit_revision_update_guard(), platform_kit_artifact_update_guard(), platform_kit_child_insert_guard(), platform_kit_export_update_guard()`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name='20261120130000_release_kits.sql'`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name='20261120140000_release_clearance_revocation.sql'`)
	exec(`DROP TRIGGER evidence_installation_access_fence ON github_installation`)
	exec(`DROP TRIGGER evidence_source_access_fence ON source_app`)
	exec(`DROP TRIGGER evidence_binding_fence ON platform_release_source_binding`)
	exec(`DROP FUNCTION platform_evidence_installation_fence(), platform_evidence_access_fence(), platform_evidence_binding_fence()`)
	exec(`DROP TABLE platform_claim_path_binding, platform_claim_verification, platform_claim_support, platform_claim_support_set, platform_release_claim_version, platform_release_claim, platform_evidence_clearance, platform_release_evidence, platform_evidence_version, platform_evidence_source`)
	exec(`DROP FUNCTION platform_evidence_version_update_guard(), platform_evidence_source_fence_guard()`)
	exec(`DROP INDEX release_spec_org_release_id`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name IN ('20261120120000_release_claim_evidence.sql','20261120121000_release_claim_import_progress.sql','20261120122000_release_access_evidence_fence.sql')`)
	exec(`DROP TABLE platform_release_lineage_binding, platform_release_lineage`)
	exec(`DROP TABLE platform_release_qualification_source, platform_release_source_binding, platform_release_source_observation`)
	exec(`DROP INDEX source_app_organization_id_id`)
	for _, table := range []string{"platform_release_readiness", "platform_readiness_command_receipt", "platform_release_qualification_decision", "platform_release_qualification_asset", "platform_release_qualification"} {
		exec(`DROP TABLE ` + table)
	}
	exec(`DROP FUNCTION platform_readiness_reject_revision_update()`)
	exec(`ALTER TABLE workspace_settings DROP COLUMN "releaseReadinessEnabled"`)
	exec(`DROP INDEX release_organization_id_id`)
	exec(`DROP INDEX asset_organization_id_id`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name='20261120090000_release_qualification.sql'`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name='20261120100000_release_source_selection.sql'`)
	exec(`DELETE FROM "_screenshot_studio_go_migrations" WHERE name='20261120110000_release_lineage.sql'`)
	exec(`INSERT INTO organization(id,name,slug,"createdAt") VALUES('existing','Existing workspace','existing',now())`)
	exec(`INSERT INTO workspace_settings("organizationId","updatedAt") VALUES('existing',now())`)
	exec(`INSERT INTO release(id,"organizationId",title,"benefitStatement",status,"updatedAt") VALUES('historical','existing','Old release','Old facts','READY','2026-11-01')`)
	exec(`INSERT INTO campaign(id,"organizationId","releaseId",name,objective,"updatedAt") VALUES('campaign','existing','historical','Existing campaign','Existing work',now())`)
	exec(`INSERT INTO campaign_post(id,"organizationId","campaignId",channel,copy,status,"updatedAt") VALUES('post','existing','campaign','x','Approved copy','APPROVED',now())`)
	if err := Apply(ctx, db.SQL); err != nil {
		t.Fatalf("representative upgrade: %v", err)
	}
	if err := Apply(ctx, db.SQL); err != nil {
		t.Fatalf("migration replay: %v", err)
	}
	var enabled bool
	var releaseStatus, postStatus, copy string
	var roots, decisions int
	if err := db.SQL.QueryRow(`SELECT (SELECT "releaseReadinessEnabled" FROM workspace_settings WHERE "organizationId"='existing'),(SELECT status FROM release WHERE id='historical'),(SELECT status FROM campaign_post WHERE id='post'),(SELECT copy FROM campaign_post WHERE id='post'),(SELECT count(*) FROM platform_release_readiness),(SELECT count(*) FROM platform_release_qualification_decision)`).Scan(&enabled, &releaseStatus, &postStatus, &copy, &roots, &decisions); err != nil || enabled || releaseStatus != "READY" || postStatus != "APPROVED" || copy != "Approved copy" || roots != 0 || decisions != 0 {
		t.Fatalf("upgrade changed historical meaning: enabled=%v release=%s post=%s copy=%q roots=%d decisions=%d err=%v", enabled, releaseStatus, postStatus, copy, roots, decisions, err)
	}
	for _, table := range []string{"platform_release_source_binding", "platform_release_source_observation", "platform_release_qualification_source", "platform_release_lineage", "platform_release_lineage_binding"} {
		var count int
		if err := db.SQL.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("upgrade invented source evidence in %s: %d %v", table, count, err)
		}
	}
	exec(`INSERT INTO organization(id,name,slug,"createdAt") VALUES('other','Other workspace','other',now())`)
	for _, org := range []string{"existing", "other"} {
		exec(`INSERT INTO source_app(id,"organizationId",name,provider,"allowedHosts","updatedAt") VALUES($1,$2,'Source','github','[]',now())`, "source-"+org, org)
		exec(`INSERT INTO platform_release_source_binding(id,"organizationId","sourceAppId",provider,"objectKind","repositoryId","providerObjectId") VALUES($1,$2,$3,'github','PULL_REQUEST','1001','9')`, "binding-"+org, org, "source-"+org)
		exec(`INSERT INTO platform_release_source_observation(id,"organizationId","sourceAppId","bindingId","eventKey",sequence,"bodySha256","occurredAt",origin,snapshot) VALUES($1,$2,$3,$4,'delivery',1,repeat('a',64),now(),'LIVE','{}')`, "observation-"+org, org, "source-"+org, "binding-"+org)
		exec(`UPDATE platform_release_source_binding SET "currentObservationId"=$1,"lastEventSequence"=1,"changeSequence"=1 WHERE id=$2`, "observation-"+org, "binding-"+org)
	}
	exec(`INSERT INTO platform_release_qualification(id,"organizationId","releaseId",version,"aggregateRevision",rollout,"sourceUrls",requirements,"authorKind","authorId") VALUES('facts','existing','historical',1,1,'UNKNOWN','[]','[]','session','historical-author')`)
	exec(`INSERT INTO platform_release_qualification_source(id,"organizationId","releaseId","qualificationRevisionId","bindingId","observationId") VALUES('evidence','existing','historical','facts','binding-existing','observation-existing')`)
	for _, query := range []string{
		`UPDATE platform_release_source_binding SET "sourceAppId"='source-other' WHERE id='binding-existing'`,
		`UPDATE platform_release_source_binding SET "currentObservationId"='observation-other' WHERE id='binding-existing'`,
		`UPDATE platform_release_source_binding SET "canonicalReleaseId"='historical' WHERE id='binding-other'`,
		`UPDATE platform_release_source_binding SET "selectedObservationId"='observation-existing' WHERE id='binding-existing'`,
		`UPDATE platform_release_source_binding SET "selectedChangeSequence"=2 WHERE id='binding-existing'`,
		`UPDATE platform_release_source_observation SET snapshot='{"title":"rewritten"}' WHERE id='observation-existing'`,
		`UPDATE platform_release_qualification_source SET "observationId"='observation-other' WHERE id='evidence'`,
		`INSERT INTO platform_release_qualification_source(id,"organizationId","releaseId","qualificationRevisionId","bindingId","observationId") VALUES('foreign','existing','historical','facts','binding-other','observation-other')`,
		`INSERT INTO platform_release_source_binding(id,"organizationId","sourceAppId",provider,"objectKind","repositoryId","providerObjectId") VALUES('duplicate','existing','source-existing','github','PULL_REQUEST','1001','9')`,
		`INSERT INTO platform_release_source_observation(id,"organizationId","sourceAppId","bindingId","eventKey",sequence,"bodySha256","occurredAt",origin,snapshot) VALUES('duplicate','existing','source-existing','binding-existing','delivery',2,repeat('b',64),now(),'LIVE','{}')`,
	} {
		if _, err := db.SQL.ExecContext(ctx, query); err == nil {
			t.Fatalf("source history constraint accepted: %s", query)
		}
	}
	exec(`INSERT INTO platform_release_source_binding(id,"organizationId","sourceAppId",provider,"objectKind","repositoryId","providerObjectId") VALUES('different-repository','existing','source-existing','github','PULL_REQUEST','1002','9')`)
	exec(`INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES('destination','existing','Grouped release','Reviewed grouping',now()),('foreign-release','other','Other release','Other facts',now())`)
	exec(`INSERT INTO platform_release_lineage(id,"organizationId",operation,"sourceReleaseId","destinationReleaseId","sourceRevision","destinationRevision",reason,"humanUserId","sessionId") VALUES('lineage','existing','MERGE','historical','destination',1,1,'One customer change','human','historical-session')`)
	exec(`INSERT INTO platform_release_lineage_binding(id,"organizationId","lineageId","bindingId") VALUES('moved','existing','lineage','binding-existing')`)
	for _, query := range []string{
		`INSERT INTO platform_release_lineage(id,"organizationId",operation,"sourceReleaseId","destinationReleaseId","sourceRevision","destinationRevision",reason,"humanUserId","sessionId") VALUES('foreign','existing','MERGE','historical','foreign-release',1,1,'Forbidden cross-tenant grouping','human','session')`,
		`INSERT INTO platform_release_lineage(id,"organizationId",operation,"sourceReleaseId","destinationReleaseId","sourceRevision","destinationRevision",reason,"humanUserId","sessionId") VALUES('self','existing','MERGE','historical','historical',1,1,'Self grouping','human','session')`,
		`INSERT INTO platform_release_lineage_binding(id,"organizationId","lineageId","bindingId") VALUES('foreign-binding','existing','lineage','binding-other')`,
		`INSERT INTO platform_release_lineage_binding(id,"organizationId","lineageId","bindingId") VALUES('foreign-lineage','other','lineage','binding-other')`,
		`INSERT INTO platform_release_lineage_binding(id,"organizationId","lineageId","bindingId") VALUES('duplicate-move','existing','lineage','binding-existing')`,
		`UPDATE platform_release_lineage SET reason='Rewritten' WHERE id='lineage'`,
		`UPDATE platform_release_lineage_binding SET "bindingId"='different-repository' WHERE id='moved'`,
		`DELETE FROM platform_release_source_binding WHERE id='binding-existing'`,
		`DELETE FROM platform_release_lineage WHERE id='lineage'`,
	} {
		if _, err := db.SQL.ExecContext(ctx, query); err == nil {
			t.Fatalf("lineage constraint accepted: %s", query)
		}
	}
}
