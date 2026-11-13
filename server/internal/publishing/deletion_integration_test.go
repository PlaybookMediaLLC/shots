package publishing

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/lucsky/cuid"
)

// A plan cancels pending follow-ups, lists each part once, and a replay
// keeps the receipts. The post is deleted only when its root is done.
func TestPostDeletionLifecycle(t *testing.T) {
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
	var databaseName string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil || !strings.Contains(databaseName, "test") {
		t.Fatalf("refusing database %q: %v", databaseName, err)
	}
	id := cuid.New()
	org, user, post := "org_"+id, "user_"+id, "post_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Deletion',$2,true,now(),now())`, user, id+"@example.test")
	t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, user) })
	exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Deletion',$2,now())`, org, id)
	t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, org) })
	exec(`INSERT INTO channel_connection (id,"organizationId",provider,"externalAccountId","secretReference",status,"createdByUserId","createdAt","updatedAt",platform,"providerSettings")
		VALUES ($1,$2,'social','destination','SOCIAL_API_KEY','ACTIVE',$3,now(),now(),'x','{}'::jsonb)`, "connection_"+id, org, user)
	exec(`INSERT INTO content_draft (id,"organizationId",title,body,"plainText","assetIds","channelConnectionIds")
		VALUES ($1,$2,'Going away','[]'::jsonb,'Going away','[]'::jsonb,'[]'::jsonb)`, "draft_"+id, org)
	exec(`INSERT INTO scheduled_post (id,"organizationId","contentDraftId","channelConnectionId","scheduledFor",status,caption,"idempotencyKey","updatedAt")
		VALUES ($1,$2,$3,$4,now(),'SCHEDULED','Going away',$1,now())`, post, org, "draft_"+id, "connection_"+id)
	run := func(key, kind, status, remote string) {
		exec(`INSERT INTO post_automation_run (id,"organizationId","scheduledPostId",key,kind,status,"dueAt","remoteId") VALUES ($1,$2,$3,$4,$5,$6,now(),NULLIF($7,''))`,
			key+"_"+id, org, post, key, kind, status, remote)
	}
	run("plug", "plug", "done", "reply-1")
	run("retweet:0", "retweet", "done", "")
	run("retweet:1", "retweet", "pending", "")
	repo := NewRepository(db.Client)
	if _, err := repo.PlanDeletion(ctx, org, post, user); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("scheduled post: %v", err)
	}
	if _, err := repo.PlanDeletion(ctx, "org_other", post, user); !errors.Is(err, ErrNotFound) {
		t.Fatalf("another workspace: %v", err)
	}
	exec(`UPDATE scheduled_post SET status='PUBLISHED', "remotePostId"='root-1' WHERE id=$1`, post)
	plan, err := repo.PlanDeletion(ctx, org, post, user)
	if err != nil {
		t.Fatal(err)
	}
	var keys []string
	for _, part := range plan.Parts {
		if part.Status != "pending" {
			t.Fatalf("part %+v", part)
		}
		keys = append(keys, part.Key+"="+part.RemoteID)
	}
	if strings.Join(keys, ",") != "plug=reply-1,repost:retweet:0=root-1,root=root-1" || plan.DestinationID != "destination" || plan.Platform != "x" {
		t.Fatalf("plan %+v keys %v", plan, keys)
	}
	var pending string
	if err := db.SQL.QueryRowContext(ctx, `SELECT status FROM post_automation_run WHERE id=$1`, "retweet:1_"+id).Scan(&pending); err != nil || pending != "cancelled" {
		t.Fatalf("pending follow-up %q: %v", pending, err)
	}
	if err := repo.RecordDeletion(ctx, post, "plug", "done", ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordDeletion(ctx, post, "repost:retweet:0", "failed", "http_403"); err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordDeletion(ctx, post, "root", "pending", "http_503"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := repo.SettleDeletion(ctx, post); deleted || err != nil {
		t.Fatalf("settled with the root pending: %v %v", deleted, err)
	}
	// A replayed plan keeps each receipt, and adds a reply that landed since.
	run("first-comment", "first_comment", "done", "comment-1")
	again, err := repo.PlanDeletion(ctx, org, post, user)
	if err != nil {
		t.Fatal(err)
	}
	status := map[string]string{}
	for _, part := range again.Parts {
		status[part.Key] = part.Status
	}
	if status["plug"] != "done" || status["repost:retweet:0"] != "failed" || status["root"] != "pending" || status["first-comment"] != "pending" || len(again.Parts) != 4 {
		t.Fatalf("replanned %v", status)
	}
	if err := repo.RecordDeletion(ctx, post, "root", "done", ""); err != nil {
		t.Fatal(err)
	}
	if err := repo.RecordDeletion(ctx, post, "root", "failed", "late"); err != nil {
		t.Fatal(err)
	}
	// The root is done after a busy answer: it keeps its tries, not the old code.
	var attempts int
	var rootStatus string
	var rootCode *string
	if err := db.SQL.QueryRowContext(ctx, `SELECT status, attempts, "failureCode" FROM post_deletion WHERE "scheduledPostId"=$1 AND key='root'`, post).Scan(&rootStatus, &attempts, &rootCode); err != nil || rootStatus != "done" || attempts != 2 || rootCode != nil {
		t.Fatalf("root %s after %d attempts, code %v: %v", rootStatus, attempts, rootCode, err)
	}
	if deleted, err := repo.SettleDeletion(ctx, post); !deleted || err != nil {
		t.Fatalf("not settled: %v %v", deleted, err)
	}
	var deletedAt *string
	if err := db.SQL.QueryRowContext(ctx, `SELECT "deletedAt"::text FROM scheduled_post WHERE id=$1`, post).Scan(&deletedAt); err != nil || deletedAt == nil {
		t.Fatalf("deletedAt %v: %v", deletedAt, err)
	}
}
