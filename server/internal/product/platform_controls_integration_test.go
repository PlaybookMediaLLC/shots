package product

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Audit drains and retention are sensitive owner/admin controls scoped to
// one workspace; source webhooks ingest one release per event; a
// dead-lettered event replays once; billing events apply once per version.
func TestAuditControlsAndSourceWebhooks(t *testing.T) {
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	org, other, userID, sessionID := "org_"+id, "other_"+id, "user_"+id, "session_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	count := func(query string, args ...any) int {
		t.Helper()
		var n int
		if err := db.SQL.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
		return n
	}
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, userID, id+"@example.test")
	for _, organization := range []string{org, other} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
	}
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, sessionID, userID, org)
	exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+id, org, userID)
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, userID)
	})

	repo := NewConfiguration(db.Client)
	subscribe(t, ctx, repo, org, "pro")
	subscribe(t, ctx, repo, other, "pro")
	owner := Actor{OrganizationID: org, UserID: userID, SessionID: sessionID, RequestID: "request_" + id}
	foreign := Actor{OrganizationID: other, Kind: "service"}
	request := AuditRequest{IPHash: "hash_" + id, UserAgentSummary: "test agent"}
	input := CreateAuditDrainInput{EncryptedSigningSecret: "iv.tag.body", Endpoint: "https://logs.example/ingest", Name: " SIEM ", Provider: "SPLUNK"}

	if _, err := repo.CreateAuditDrain(ctx, owner, input, request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("drain created without two-factor: %v", err)
	}
	exec(`UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1`, userID)
	if _, err := repo.CreateAuditDrain(ctx, Actor{OrganizationID: org, Kind: "service"}, input, request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("service caller created a drain: %v", err)
	}
	if _, err := repo.CreateAuditDrain(ctx, owner, CreateAuditDrainInput{EncryptedSigningSecret: "x", Endpoint: "ftp://logs", Name: "bad", Provider: "GENERIC"}, request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid drain accepted: %v", err)
	}
	drain, err := repo.CreateAuditDrain(ctx, owner, input, request)
	if err != nil || drain.Name != "SIEM" || drain.Provider != "SPLUNK" || !drain.Enabled {
		t.Fatalf("drain=%+v err=%v", drain, err)
	}
	if _, err := repo.CreateAuditDrain(ctx, owner, input, request); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("duplicate drain name: %v", err)
	}
	if drains, err := repo.ListAuditDrains(ctx, owner); err != nil || len(drains) != 1 || drains[0].ID != drain.ID {
		t.Fatalf("drains=%+v err=%v", drains, err)
	}
	if drains, err := repo.ListAuditDrains(ctx, foreign); err != nil || len(drains) != 0 {
		t.Fatalf("other workspace sees drains=%+v err=%v", drains, err)
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='audit.drain_created' AND "entityId"=$2 AND "ipHash"=$3`, org, drain.ID, request.IPHash); n != 1 {
		t.Fatalf("drain creation audits=%d", n)
	}

	if policy, err := repo.GetAuditRetention(ctx, owner); err != nil || policy.RetentionDays != 90 || policy.LegalHold {
		t.Fatalf("default retention=%+v err=%v", policy, err)
	}
	if _, err := repo.UpdateAuditRetention(ctx, owner, AuditRetention{RetentionDays: 7}, request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("short retention accepted: %v", err)
	}
	for _, days := range []int{120, 365} {
		if policy, err := repo.UpdateAuditRetention(ctx, owner, AuditRetention{LegalHold: true, RetentionDays: days}, request); err != nil || policy.RetentionDays != days {
			t.Fatalf("retention=%+v err=%v", policy, err)
		}
	}
	if policy, err := repo.GetAuditRetention(ctx, owner); err != nil || policy.RetentionDays != 365 || !policy.LegalHold {
		t.Fatalf("stored retention=%+v err=%v", policy, err)
	}
	if policy, err := repo.GetAuditRetention(ctx, foreign); err != nil || policy.RetentionDays != 90 {
		t.Fatalf("other workspace retention=%+v err=%v", policy, err)
	}
	// Every audited change after the drain exists is queued for it.
	if n := count(`SELECT count(*) FROM audit_drain_delivery d JOIN audit_outbox o ON o.id=d."outboxId" JOIN audit_log a ON a.id=o."auditLogId" WHERE d."drainId"=$1 AND a.action='audit.retention_changed' AND d.status='PENDING'`, drain.ID); n != 2 {
		t.Fatalf("queued retention deliveries=%d", n)
	}

	if err := repo.DeleteAuditDrain(ctx, Actor{OrganizationID: other, UserID: userID, SessionID: sessionID}, drain.ID, request); err == nil {
		t.Fatal("drain deleted through another workspace")
	}
	if err := repo.DeleteAuditDrain(ctx, owner, drain.ID, request); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteAuditDrain(ctx, owner, drain.ID, request); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if n := count(`SELECT count(*) FROM audit_drain_delivery WHERE "drainId"=$1`, drain.ID); n != 0 {
		t.Fatalf("deliveries outlived their drain: %d", n)
	}

	secret, branch, repoID := "SOURCE_SECRET", "develop", "repo-"+org
	source, err := repo.CreateSourceApp(ctx, owner, CreateSourceAppInput{AllowedHosts: []string{"https://api.github.com"}, Branch: &branch, ExternalID: &repoID, Name: "GitHub", Provider: "github", SecretReference: &secret})
	if err != nil {
		t.Fatal(err)
	}
	found, err := repo.GetWebhookSource(ctx, source.ID)
	if err != nil || found.OrganizationID != org || found.Provider != "github" || found.SecretReference == nil || *found.SecretReference != secret ||
		found.Branch == nil || *found.Branch != branch || found.ExternalID == nil || *found.ExternalID != repoID ||
		!found.IgnoreBotPullRequests || found.SkipPrereleases || found.IgnoredPullRequestAuthors == nil || len(found.IgnoredPullRequestAuthors) != 0 {
		t.Fatalf("webhook source=%+v err=%v", found, err)
	}
	off, on, authors := false, true, []string{"Snyk-Bot"}
	rules := UpdateSourceAppInput{ClearBranch: true, IgnoreBotPullRequests: &off, IgnoredPullRequestAuthors: &authors, SkipPrereleases: &on}
	if _, err := repo.UpdateSourceApp(ctx, Actor{OrganizationID: other, UserID: userID, SessionID: sessionID}, source.ID, rules); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign workspace updated the source: %v", err)
	}
	if _, err := repo.UpdateSourceApp(ctx, owner, source.ID, rules); err != nil {
		t.Fatal(err)
	}
	found, err = repo.GetWebhookSource(ctx, source.ID)
	if err != nil || found.Branch != nil || found.IgnoreBotPullRequests || !found.SkipPrereleases ||
		len(found.IgnoredPullRequestAuthors) != 1 || found.IgnoredPullRequestAuthors[0] != "Snyk-Bot" || *found.ExternalID != repoID {
		t.Fatalf("updated webhook source=%+v err=%v", found, err)
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='product.source_app_updated' AND "entityId"=$2`, org, source.ID); n != 1 {
		t.Fatalf("source update audits=%d", n)
	}
	// A partial update leaves every other rule as it was.
	if _, err := repo.UpdateSourceApp(ctx, owner, source.ID, UpdateSourceAppInput{Branch: &branch}); err != nil {
		t.Fatal(err)
	}
	if found, err = repo.GetWebhookSource(ctx, source.ID); err != nil || found.Branch == nil || *found.Branch != branch || !found.SkipPrereleases || found.IgnoreBotPullRequests {
		t.Fatalf("partial update source=%+v err=%v", found, err)
	}
	webhook := Actor{OrganizationID: org, Kind: "webhook", Display: source.ID, RequestID: "delivery-1"}
	release := IngestSourceReleaseInput{BenefitStatement: "Faster exports.", EventID: "delivery-1", SourceAppID: source.ID, Title: "v2"}
	if _, err := repo.IngestSourceRelease(ctx, owner, release); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("session ingested a webhook release: %v", err)
	}
	if _, err := repo.IngestSourceRelease(ctx, Actor{OrganizationID: other, Kind: "webhook", Display: source.ID}, release); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign workspace ingested through the source: %v", err)
	}
	first, err := repo.IngestSourceRelease(ctx, webhook, release)
	if err != nil || !first.Created {
		t.Fatalf("ingest=%+v err=%v", first, err)
	}
	replay, err := repo.IngestSourceRelease(ctx, webhook, release)
	if err != nil || replay.Created || replay.ReleaseID != first.ReleaseID {
		t.Fatalf("replay=%+v err=%v", replay, err)
	}
	// Postgres text cannot hold NUL: it is invalid input, not a failed insert.
	for _, nul := range []IngestSourceReleaseInput{
		{BenefitStatement: "Faster exports.", EventID: "nul-title", SourceAppID: source.ID, Title: "v\x002"},
		{BenefitStatement: "Faster\x00 exports.", EventID: "nul-benefit", SourceAppID: source.ID, Title: "v2"},
	} {
		if _, err := repo.IngestSourceRelease(ctx, webhook, nul); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("NUL release %q err=%v", nul.EventID, err)
		}
	}
	if n := count(`SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND type='release.ingested' AND "aggregateId"=$2 AND payload->>'sourceAppId'=$3`, org, first.ReleaseID, source.ID); n != 1 {
		t.Fatalf("ingest outbox events=%d", n)
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='product.release_ingested' AND "actorType"='WEBHOOK' AND "actorDisplay"=$2 AND "requestId"='delivery-1'`, org, source.ID); n != 1 {
		t.Fatalf("ingest audits=%d", n)
	}
	// A source that names a repository takes releases only from it; a release
	// without a repository (above) is not filtered.
	wrongRepo := "999"
	byRepo := func(repositoryID *string) (*SourceReleaseIngest, error) {
		return repo.IngestSourceRelease(ctx, Actor{OrganizationID: org, Kind: "webhook", Display: source.ID, RequestID: "delivery-repo"},
			IngestSourceReleaseInput{BenefitStatement: "Faster exports.", EventID: "release:" + *repositoryID + ":77", RepositoryID: repositoryID, SourceAppID: source.ID, Title: "v3"})
	}
	if _, err := byRepo(&wrongRepo); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("another repository's release was ingested: %v", err)
	}
	if own, err := byRepo(&repoID); err != nil || !own.Created {
		t.Fatalf("the source's repository release=%+v err=%v", own, err)
	}
	exec(`UPDATE source_app SET status='DRAFT' WHERE id=$1`, source.ID)
	if _, err := repo.GetWebhookSource(ctx, source.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("inactive source resolved: %v", err)
	}
	release.EventID = "delivery-2"
	if _, err := repo.IngestSourceRelease(ctx, webhook, release); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("inactive source ingested: %v", err)
	}

	var eventID string
	if err := db.SQL.QueryRowContext(ctx, `SELECT id FROM outbox_event WHERE "aggregateId"=$1`, first.ReleaseID).Scan(&eventID); err != nil {
		t.Fatal(err)
	}
	if err := repo.ReplayOutboxEvent(ctx, eventID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("replayed a live event: %v", err)
	}
	exec(`UPDATE outbox_event SET attempts=8,"deadLetteredAt"=now(),"lastError"='DISPATCH_FAILED' WHERE id=$1`, eventID)
	if err := repo.ReplayOutboxEvent(ctx, eventID); err != nil {
		t.Fatal(err)
	}
	if n := count(`SELECT count(*) FROM outbox_event WHERE id=$1 AND attempts=0 AND "deadLetteredAt" IS NULL AND "lastError" IS NULL AND "processingAt" IS NULL`, eventID); n != 1 {
		t.Fatal("replay did not reset the retry state")
	}
	if err := repo.ReplayOutboxEvent(ctx, eventID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("second replay: %v", err)
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='product.outbox_replayed' AND "entityId"=$2 AND "actorType"='SERVICE'`, org, eventID); n != 1 {
		t.Fatalf("replay audits=%d", n)
	}

	// Back to no subscription, so the contract is exercised from its default.
	exec(`DELETE FROM workspace_entitlement WHERE "organizationId"=$1`, org)
	exec(`DELETE FROM billing_entitlement_event WHERE "organizationId"=$1`, org)
	// The audit log is append-only; only a retention-flagged transaction deletes.
	retention, err := db.SQL.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := retention.ExecContext(ctx, `SET LOCAL shots.audit_retention = 'on'`); err != nil {
		t.Fatal(err)
	}
	if _, err := retention.ExecContext(ctx, `DELETE FROM audit_log WHERE "organizationId"=$1 AND action='billing.entitlement_changed'`, org); err != nil {
		t.Fatal(err)
	}
	if err := retention.Commit(); err != nil {
		t.Fatal(err)
	}
	if contract, err := repo.GetWorkspaceEntitlement(ctx, owner); err != nil || contract.Plan != "free" || contract.Version != 0 {
		t.Fatalf("default contract=%+v err=%v", contract, err)
	}
	if _, err := repo.GetWorkspaceEntitlement(ctx, Actor{OrganizationID: org, Kind: "service"}); err == nil {
		t.Fatal("service caller read the contract")
	}
	until, subscription := time.Now().Add(24*time.Hour).UTC(), "sub_"+id
	sync := EntitlementSyncInput{EventID: "evt-1", EventType: "subscription.updated", ExternalSubscriptionID: &subscription,
		FeatureOverrides: map[string]bool{"asset:delete": true}, OrganizationID: org, Plan: "enterprise",
		Provider: "billing-" + id, Status: "active", ValidUntil: &until}
	if _, err := repo.SyncWorkspaceEntitlement(ctx, EntitlementSyncInput{EventID: "evt-0", EventType: "x", OrganizationID: "missing_" + id,
		Plan: "pro", Provider: sync.Provider, Status: "active"}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("missing workspace: %v", err)
	}
	if _, err := repo.SyncWorkspaceEntitlement(ctx, EntitlementSyncInput{EventID: "evt-0", EventType: "x", OrganizationID: org,
		Plan: "platinum", Provider: sync.Provider, Status: "active"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown plan: %v", err)
	}
	for _, replayed := range []bool{false, true} {
		if result, err := repo.SyncWorkspaceEntitlement(ctx, sync); err != nil || result.Replayed != replayed || result.Version != 1 {
			t.Fatalf("sync replayed=%v result=%+v err=%v", replayed, result, err)
		}
	}
	stale := sync
	stale.EventID = "evt-stale"
	if _, err := repo.SyncWorkspaceEntitlement(ctx, stale); !errors.Is(err, publishing.ErrConflict) || !strings.Contains(err.Error(), "Current version is 1") {
		t.Fatalf("stale event: %v", err)
	}
	next := EntitlementSyncInput{EventID: "evt-2", EventType: "subscription.updated", ExpectedVersion: 1,
		OrganizationID: org, Plan: "pro", Provider: sync.Provider, Status: "past_due"}
	if result, err := repo.SyncWorkspaceEntitlement(ctx, next); err != nil || result.Version != 2 {
		t.Fatalf("next=%+v err=%v", result, err)
	}
	contract, err := repo.GetWorkspaceEntitlement(ctx, owner)
	if err != nil || contract.Plan != "pro" || contract.Status != "past_due" || contract.Version != 2 ||
		contract.ValidUntil != nil || contract.LastSyncedAt == nil {
		t.Fatalf("contract=%+v err=%v", contract, err)
	}
	if n := count(`SELECT count(*) FROM workspace_entitlement WHERE "organizationId"=$1 AND "externalSubscriptionId" IS NULL AND provider=$2`, org, sync.Provider); n != 1 {
		t.Fatal("the new contract kept the previous subscription")
	}
	if n := count(`SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='billing.entitlement_changed' AND "actorType"='SERVICE'`, org); n != 2 {
		t.Fatalf("entitlement audits=%d", n)
	}
	if n := count(`SELECT count(*) FROM billing_entitlement_event WHERE "organizationId"=$1`, org); n != 2 {
		t.Fatalf("billing receipts=%d", n)
	}
}
