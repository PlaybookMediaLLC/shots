package maintenance

import "testing"

func TestWorkspaceCleanupRemovesPlanAnalyzeDataAndKeepsOtherTenants(t *testing.T) {
	s, _ := setup(t)
	for _, org := range []string{"a", "b"} {
		exec(t, s.DB, `INSERT INTO calendar_mutation(id,"organizationId","actorId","inputHash",result)
			VALUES($1,$2,'user','hash','{"drafts":[{"plainText":"private body","scratchpad":"private notes"}]}')`, "receipt-"+org, org)
		exec(t, s.DB, `INSERT INTO calendar_note(id,"organizationId",day,title,color,"createdByUserId")
			VALUES($1,$2,'2026-11-04','private note','blue','user')`, "note-"+org, org)
		exec(t, s.DB, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform)
			VALUES($1,$2,'social',$1,'test-only','user',now(),'x')`, "connection-"+org, org)
		exec(t, s.DB, `INSERT INTO analytics_account(id,"organizationId","publicToken") VALUES($1,$2,$3)`, "connection-"+org, org, "public-"+org)
		exec(t, s.DB, `INSERT INTO analytics_post(id,"organizationId","connectionId","remoteId",excerpt,"publishedAt")
			VALUES($1,$2,$3,'remote','provider post',now())`, "post-"+org, org, "connection-"+org)
		exec(t, s.DB, `INSERT INTO analytics_snapshot(id,"organizationId","connectionId","subjectId",kind,"observedAt",counters,"payloadHash")
			VALUES($1,$2,$3,'remote','post',now(),'{"likes":1}','hash')`, "snapshot-"+org, org, "connection-"+org)
	}
	exec(t, s.DB, `INSERT INTO workspace_deletion(id,"organizationId","requestedByUserId","scheduledFor","updatedAt")
		VALUES('due','a','user',now()-interval '1 day',now()),('future','b','user',now()+interval '14 days',now())`)
	if n := run(t, s, "workspace-cleanup"); n != 1 {
		t.Fatalf("purged %d workspaces", n)
	}
	expect(t, s.DB, "PURGED", `SELECT status FROM workspace_deletion WHERE id='due'`)
	expect(t, s.DB, 1, `SELECT count(*) FROM organization WHERE id='a'`)
	for _, table := range []string{"calendar_mutation", "calendar_note", "analytics_account", "analytics_post", "analytics_snapshot", "channel_connection"} {
		expect(t, s.DB, 0, `SELECT count(*) FROM "`+table+`" WHERE "organizationId"='a'`)
		expect(t, s.DB, 1, `SELECT count(*) FROM "`+table+`" WHERE "organizationId"='b'`)
	}
	expect(t, s.DB, 1, `SELECT count(*) FROM audit_log WHERE "organizationId"='a' AND action='product.workspace_purged'`)
	if n := run(t, s, "workspace-cleanup"); n != 0 {
		t.Fatalf("repeated purge processed %d workspaces", n)
	}
}
