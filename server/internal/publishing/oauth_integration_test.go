package publishing

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/lucsky/cuid"
)

func TestOAuthGrantAndConnectionUseEntInOnePublicSchema(t *testing.T) {
	for _, provider := range []string{"instagram", "linkedin-page", "youtube"} {
		t.Run(provider, func(t *testing.T) { testOAuthSelectionGrant(t, provider) })
	}
}

func testOAuthSelectionGrant(t *testing.T, provider string) {
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
	userID, organizationID, state := "user_"+id, "org_"+id, "state_"+id
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Test Publisher',$2,true,now(),now())`, userID, id+"@example.test"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, userID) })
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Test Organization',$2,now())`, organizationID, id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, organizationID) })
	if err := db.Client.WorkspaceEntitlement.Create().SetID(organizationID).SetPlan("pro").SetStatus("active").Exec(ctx); err != nil {
		t.Fatal(err)
	}
	repo := NewRepository(db.Client)
	actor := Actor{Organization: organizationID, UserID: userID, Type: "USER", RequestID: id}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$2,now(),now(),$3,$4)`, "session_"+id, "token_"+id, userID, organizationID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'publisher',now())`, "member_"+id, organizationID, userID); err != nil {
		t.Fatal(err)
	}
	if err := repo.AuthorizePublishing(ctx, organizationID, userID, "session_"+id); err != nil {
		t.Fatalf("publisher session rejected: %v", err)
	}
	if err := repo.AuthorizePublishing(ctx, organizationID, userID, "wrong-session"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("wrong session authorized: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE member SET role='viewer' WHERE id=$1`, "member_"+id); err != nil {
		t.Fatal(err)
	}
	if err := repo.AuthorizePublishing(ctx, organizationID, userID, "session_"+id); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer authorized to publish: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE member SET role='publisher' WHERE id=$1`, "member_"+id); err != nil {
		t.Fatal(err)
	}
	if err := repo.StartOAuth(ctx, actor, "session_"+id, state, provider, "SOCIAL_API_KEY_TEST", OAuthStartOptions{}); err != nil {
		if !errors.Is(err, ErrForbidden) {
			t.Fatal(err)
		}
	} else {
		t.Fatal("publisher started account authorization")
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE member SET role='admin' WHERE id=$1`, "member_"+id); err != nil {
		t.Fatal(err)
	}
	if err := repo.StartOAuth(ctx, actor, "session_"+id, state, provider, "SOCIAL_API_KEY_TEST", OAuthStartOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.OAuthStart(ctx, actor, "session-2", state, provider, nil); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("another session read OAuth grant: %v", err)
	}
	if _, err := repo.ClaimOAuthExchange(ctx, actor, "session_"+id, state, provider); err != nil {
		t.Fatal(err)
	}
	if err := repo.SaveOAuthExchange(ctx, actor, "session_"+id, state, provider, schema.SocialOAuthExchange{ID: "destination-1"}); err != nil {
		t.Fatal(err)
	}
	if err := repo.RememberInstagramIntegration(ctx, actor, "session_"+id, state, "destination-1", provider); err != nil {
		t.Fatal(err)
	}
	foreign := actor
	foreign.Organization = "another-tenant"
	if _, err := repo.OAuthStart(ctx, foreign, "session_"+id, state, provider, nil); err == nil {
		t.Fatal("another tenant read OAuth grant")
	}
	wrongDestination := "destination-2"
	if _, err := repo.OAuthStart(ctx, actor, "session_"+id, state, provider, &wrongDestination); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong destination matched OAuth grant: %v", err)
	}
	connection, err := repo.FinishOAuth(ctx, actor, "session_"+id, state, provider, "destination-1")
	if err != nil {
		t.Fatal(err)
	}
	if connection.OrganizationID != organizationID || connection.Platform != provider || connection.ExternalAccountID != "destination-1" {
		t.Fatalf("unexpected connection: %#v", connection)
	}
	receipt, err := repo.OAuthStart(ctx, actor, "session_"+id, state, provider, nil)
	if err != nil || receipt.ExchangeStatus != socialoauthstart.ExchangeStatusCOMPLETED {
		t.Fatalf("completed receipt missing: %+v %v", receipt, err)
	}
	replay, err := repo.FinishOAuth(ctx, actor, "session_"+id, state, provider, "destination-1")
	if err != nil || replay.ID != connection.ID {
		t.Fatalf("completion replay: %+v %v", replay, err)
	}
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO brand_kit (id,"organizationId",name,version,definition,status,"createdAt","updatedAt") VALUES ($1,$2,'Test Brand',1,'{}','ACTIVE',now(),now())`, []any{"brand_" + id, organizationID}},
		{`INSERT INTO creative_template (id,"organizationId",name,version,definition,status,"createdAt","updatedAt") VALUES ($1,$2,'Test Template',1,'{}','ACTIVE',now(),now())`, []any{"template_" + id, organizationID}},
		{`INSERT INTO release (id,"organizationId",title,"benefitStatement",status,"createdByUserId","createdAt","updatedAt") VALUES ($1,$2,'Test Release','Test publishing state','DRAFT',$3,now(),now())`, []any{"release_" + id, organizationID, userID}},
		{`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',now(),now())`, []any{"asset_" + id, organizationID, "org/" + organizationID + "/test.png"}},
		{`INSERT INTO creative_variant (id,"organizationId","releaseId","sourceAssetId","brandKitId","brandKitVersion","templateId","templateVersion",revision,"aspectRatio",status,"createdByUserId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,1,$6,1,1,'1:1','APPROVED',$7,now(),now())`, []any{"variant_" + id, organizationID, "release_" + id, "asset_" + id, "brand_" + id, "template_" + id, userID}},
		{`INSERT INTO approval (id,"organizationId","variantId",status,"decidedByUserId","decidedAt","createdAt","updatedAt") VALUES ($1,$2,$3,'APPROVED',$4,now(),now(),now())`, []any{"approval_" + id, organizationID, "variant_" + id, userID}},
	}
	for _, fixture := range fixtures {
		if _, err := db.SQL.ExecContext(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatal(err)
		}
	}
	created, err := repo.CreateScheduledPost(ctx, actor, CreateScheduledPostInput{
		Caption: "Test uncertain delivery", ChannelConnectionID: connection.ID,
		IdempotencyKey: id, ScheduledFor: time.Now().UTC().Add(time.Hour), VariantID: "variant_" + id,
	})
	if err != nil || !created.Created {
		t.Fatalf("Ent did not schedule post: created=%v err=%v", created.Created, err)
	}
	post, err := db.Client.ScheduledPost.UpdateOneID(created.Post.ID).
		SetStatus(scheduledpost.StatusPROCESSING).SetTriggerRunID("run-1").Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.StartAttempt(ctx, post, "run-1", 1); err != nil {
		t.Fatal(err)
	}
	if err := repo.FailUnknown(ctx, post.ID, "run-1", 1, "upload to https://media.example/x.png?X-Amz-Signature=secret timed out"); err != nil {
		t.Fatal(err)
	}
	post, err = db.Client.ScheduledPost.Get(ctx, post.ID)
	if err != nil || post.Status != scheduledpost.StatusUNKNOWN_DELIVERY {
		t.Fatalf("uncertain post status=%q err=%v", post.Status, err)
	}
	// The attempt keeps the provider's message without the signed query string.
	attempt, err := db.Client.PublicationAttempt.Query().Where(publicationattempt.ScheduledPostID(post.ID)).Only(ctx)
	if err != nil || attempt.ProviderMessage == nil || *attempt.ProviderMessage != "upload to https://media.example/x.png?REDACTED timed out" {
		t.Fatalf("attempt=%+v err=%v", attempt, err)
	}
	if _, err := repo.CancelScheduledPost(ctx, actor, post.ID); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("uncertain delivery could be cancelled: %v", err)
	}
}
