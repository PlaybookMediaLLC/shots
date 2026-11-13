package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/brand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

type recordingInvitationMailer struct{ messages []InvitationMessage }

func (m *recordingInvitationMailer) SendInvitation(_ context.Context, message InvitationMessage) error {
	m.messages = append(m.messages, message)
	return nil
}

type recordingAssetObjects struct {
	exists  bool
	key     string
	written []byte
	// Uploads are signed concurrently in TestConcurrentUploadsCannotExceedStorage.
	mu sync.Mutex
}

type recordingQuotaCounter struct{ count int }

func (q *recordingQuotaCounter) Increment(_ context.Context, _ string, amount int, _ time.Duration) (int, error) {
	q.count += amount
	return q.count, nil
}

// recordingMonthlyMeter mirrors quota.MonthlyMeter's semantics in memory:
// it records overruns and reports Reached once usage is over the limit.
type recordingMonthlyMeter struct{ used map[string]int64 }

func (m *recordingMonthlyMeter) Meter(_ context.Context, key string, amount, limit int64) (quota.MonthlyUsage, error) {
	if m.used == nil {
		m.used = map[string]int64{}
	}
	m.used[key] += amount
	used := m.used[key]
	return quota.MonthlyUsage{Used: min(used, limit), Remaining: max(limit-used, 0), Reached: used > limit}, nil
}

func (o *recordingAssetObjects) SignUpload(_ context.Context, key, _ string) (string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.key = key
	return "https://storage.example.test/upload", nil
}
func (o *recordingAssetObjects) SignDownload(_ context.Context, key string) (string, error) {
	o.key = key
	return "https://storage.example.test/download", nil
}
func (o *recordingAssetObjects) Exists(_ context.Context, key string) (bool, error) {
	o.key = key
	return o.exists, nil
}
func (o *recordingAssetObjects) Put(_ context.Context, key, _ string, body io.Reader) error {
	o.key = key
	content, err := io.ReadAll(body)
	o.written = content
	return err
}
func (o *recordingAssetObjects) Copy(_ context.Context, _, to string) error {
	o.key = to
	return nil
}
func (o *recordingAssetObjects) Read(_ context.Context, key string) ([]byte, error) {
	o.key = key
	return o.written, nil
}
func (o *recordingAssetObjects) Delete(_ context.Context, key string) error {
	o.key = key
	return nil
}

func TestConfigurationUsesOneTenantScopedEntDatabase(t *testing.T) {
	databaseURL := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var databaseName string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&databaseName); err != nil || !strings.Contains(databaseName, "test") {
		t.Fatalf("refusing database %q: %v", databaseName, err)
	}
	id := cuid.New()
	userID, orgID, otherOrgID := "user_"+id, "org_"+id, "other_"+id
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Product Owner',$2,true,now(),now())`, []any{userID, id + "@example.test"}},
		{`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Product Workspace',$2,now())`, []any{orgID, id}},
		{`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Other Workspace',$2,now())`, []any{otherOrgID, "other-" + id}},
		{`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$2,now(),now(),$3,$4)`, []any{"session_" + id, "token_" + id, userID, orgID}},
		{`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, []any{"member_" + id, orgID, userID}},
	}
	for _, fixture := range fixtures {
		if _, err := db.SQL.ExecContext(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, orgID, otherOrgID)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1`, userID)
	})
	mailer := &recordingInvitationMailer{}
	repo := NewConfiguration(db.Client).WithInvitationMailer(mailer)
	quotaCounter := &recordingQuotaCounter{}
	repo.WithQuotaCounter(quotaCounter)
	actor := Actor{OrganizationID: orgID, UserID: userID, SessionID: "session_" + id, RequestID: "request_" + id}
	entitlements, err := repo.GetEntitlementSummary(ctx, actor)
	if err != nil || entitlements.Plan != "free" || entitlements.Features["asset:read"] || entitlements.Features["workspace:use"] || entitlements.Features["content:drafts"] {
		t.Fatalf("workspace entitlements=%+v err=%v", entitlements, err)
	}
	decision, err := repo.GetFeatureDecision(ctx, actor, "asset:delete")
	if err != nil || decision.Allowed || decision.CurrentPlan != "free" || decision.RequiredPlan != "pro" {
		t.Fatalf("feature decision=%+v err=%v", decision, err)
	}
	if _, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 0); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("unsubscribed workspace has AI credits: %v", err)
	}
	subscribe(t, ctx, repo, orgID, "pro")
	meter := &recordingMonthlyMeter{}
	repo.WithMonthlyMeter(meter)
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 0); err != nil || remaining != 600 {
		t.Fatalf("AI credit peek remaining=%d err=%v", remaining, err)
	}
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 40); err != nil || remaining != 560 {
		t.Fatalf("AI credits remaining=%d err=%v", remaining, err)
	}
	// Web images older than the credit meter still meter AI credits.
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, "generation:monthly", 10); err != nil || remaining != 550 {
		t.Fatalf("legacy generation quota remaining=%d err=%v", remaining, err)
	}
	var exceeded *QuotaExceededError
	if _, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 551); !errors.As(err, &exceeded) ||
		exceeded.Quota != QuotaAICredits || exceeded.Limit != 600 || !exceeded.ResetAt.Equal(nextMonthStart(time.Now())) {
		t.Fatalf("AI credit overrun accepted: %v", err)
	}
	if _, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 0); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("exhausted AI credits read as available: %v", err)
	}
	// Purchased packs pay for usage past the allowance, once per provider reference.
	pack := CreditGrantInput{Credits: 500, OrganizationID: orgID, Provider: "stripe", Reference: "cs_" + id}
	if result, err := repo.GrantWorkspaceCredits(ctx, pack); err != nil || result.Replayed || result.Balance != 500 {
		t.Fatalf("credit grant=%+v err=%v", result, err)
	}
	if result, err := repo.GrantWorkspaceCredits(ctx, pack); err != nil || !result.Replayed || result.Balance != 500 {
		t.Fatalf("replayed credit grant=%+v err=%v", result, err)
	}
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 0); err != nil || remaining != 500 {
		t.Fatalf("AI credits with a pack remaining=%d err=%v", remaining, err)
	}
	if summary, err := repo.GetEntitlementSummary(ctx, actor); err != nil || summary.CreditBalance != 500 {
		t.Fatalf("entitlement summary with a pack=%+v err=%v", summary, err)
	}
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 30); err != nil || remaining != 470 {
		t.Fatalf("AI credits drawn from a pack remaining=%d err=%v", remaining, err)
	}
	if _, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaAICredits, 471); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("a call past the pack err=%v", err)
	}
	if balance, err := repo.creditBalance(ctx, orgID); err != nil || balance != 0 {
		t.Fatalf("pack balance after overrun=%d err=%v", balance, err)
	}
	if _, err := repo.GrantWorkspaceCredits(ctx, CreditGrantInput{Credits: 500, OrganizationID: "missing_" + id, Provider: "stripe", Reference: "cs_missing_" + id}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("grant to a missing workspace err=%v", err)
	}
	if _, err := repo.GrantWorkspaceCredits(ctx, CreditGrantInput{OrganizationID: orgID, Provider: "stripe", Reference: "cs_empty_" + id}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty grant err=%v", err)
	}
	refund, err := repo.ChargeMonthlyQuota(ctx, orgID, QuotaPosts, 4)
	if err != nil {
		t.Fatalf("post charge: %v", err)
	}
	refund()
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaPosts, 0); err != nil || remaining != 250 {
		t.Fatalf("refunded posts remaining=%d err=%v", remaining, err)
	}
	if _, err := repo.ChargeMonthlyQuota(ctx, orgID, QuotaPosts, 251); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("post overrun accepted: %v", err)
	}
	if remaining, err := repo.ConsumeWorkspaceQuota(ctx, actor, QuotaPosts, 0); err != nil || remaining != 250 {
		t.Fatalf("a refused post charge used the allowance: remaining=%d err=%v", remaining, err)
	}
	if _, err := repo.ConsumeWorkspaceQuota(ctx, actor, "unknown:monthly", 1); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown quota accepted: %v", err)
	}
	if err := repo.AuthorizeSession(ctx, actor); err != nil {
		t.Fatalf("session rejected: %v", err)
	}
	currentUser, err := repo.GetCurrentUser(ctx, actor)
	if err != nil || currentUser.ID != userID || currentUser.Email != id+"@example.test" {
		t.Fatalf("current user=%+v err=%v", currentUser, err)
	}
	activeAccess, err := repo.GetActiveAccess(ctx, actor)
	if err != nil || activeAccess.OrganizationID != orgID || activeAccess.Role != "owner" {
		t.Fatalf("active access=%+v err=%v", activeAccess, err)
	}
	if _, err := db.SQL.ExecContext(ctx,
		`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId") VALUES ($1,now()+interval '1 hour',$2,now(),now(),$3)`,
		"unselected_session_"+id, "unselected_token_"+id, userID); err != nil {
		t.Fatal(err)
	}
	unselectedAccess, err := repo.GetActiveAccess(ctx, Actor{UserID: userID, SessionID: "unselected_session_" + id})
	if err != nil || unselectedAccess.OrganizationID != orgID {
		t.Fatalf("first workspace activation=%+v err=%v", unselectedAccess, err)
	}
	if _, err := db.SQL.ExecContext(ctx,
		`INSERT INTO support_access_grant (id,"organizationId","userId",purpose,scope,"expiresAt","createdAt") VALUES ($1,$2,$3,'Support review','metadata:read',now()+interval '1 hour',now())`,
		"grant_"+id, otherOrgID, userID); err != nil {
		t.Fatal(err)
	}
	grant, err := repo.VerifySupportGrant(ctx, actor, otherOrgID, "metadata:read")
	if err != nil || grant.GrantID != "grant_"+id {
		t.Fatalf("support grant=%+v err=%v", grant, err)
	}
	if _, err := repo.VerifySupportGrant(ctx, actor, otherOrgID, "metadata:write"); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("incorrect support scope authorized: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE support_access_grant SET "revokedAt"=now() WHERE id=$1`, "grant_"+id); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.VerifySupportGrant(ctx, actor, otherOrgID, "metadata:read"); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("revoked support grant authorized: %v", err)
	}
	for _, entry := range []struct{ assetID, organizationID, status, age string }{
		{"asset_old_" + id, orgID, "UPLOADED", "1 hour"},
		{"asset_new_" + id, orgID, "UPLOADED", "0 seconds"},
		{"asset_pending_" + id, orgID, "PENDING", "0 seconds"},
		{"asset_other_" + id, otherOrgID, "UPLOADED", "0 seconds"},
	} {
		if _, err := db.SQL.ExecContext(ctx,
			`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',100,$4,now()-$5::interval,now())`,
			entry.assetID, entry.organizationID, "org/"+entry.organizationID+"/input/"+entry.assetID+"/1/image.png", entry.status, entry.age); err != nil {
			t.Fatal(err)
		}
	}
	assetPage, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1})
	if err != nil || len(assetPage.Assets) != 1 || assetPage.Assets[0].ID != "asset_new_"+id || assetPage.NextCursor == nil {
		t.Fatalf("first asset page=%+v err=%v", assetPage, err)
	}
	// Deleting the boundary row must not strand the rest of the library.
	if _, err := db.SQL.ExecContext(ctx, `DELETE FROM asset WHERE id=$1`, "asset_new_"+id); err != nil {
		t.Fatal(err)
	}
	olderPage, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Cursor: *assetPage.NextCursor})
	if err != nil || len(olderPage.Assets) != 1 || olderPage.Assets[0].ID != "asset_old_"+id || olderPage.NextCursor != nil {
		t.Fatalf("second asset page=%+v err=%v", olderPage, err)
	}
	if _, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Cursor: "asset_other_" + id}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("cross-tenant asset cursor accepted: %v", err)
	}
	// Filters run before LIMIT, including media older than the initial page.
	for _, videoID := range []string{"video_a_" + id, "video_b_" + id} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$1,'video/mp4',100,'UPLOADED','2020-01-01',now())`, videoID, orgID); err != nil {
			t.Fatal(err)
		}
	}
	videos, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Type: "video", Sort: "oldest"})
	if err != nil || len(videos.Assets) != 1 || videos.Assets[0].ID != "video_a_"+id || videos.NextCursor == nil {
		t.Fatalf("oldest video=%+v err=%v", videos, err)
	}
	nextVideo, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Type: "video", Sort: "oldest", Cursor: *videos.NextCursor})
	if err != nil || len(nextVideo.Assets) != 1 || nextVideo.Assets[0].ID != "video_b_"+id || nextVideo.NextCursor != nil {
		t.Fatalf("tied video=%+v err=%v", nextVideo, err)
	}
	oldest, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Sort: "oldest"})
	if err != nil || oldest.Assets[0].ID != "video_a_"+id {
		t.Fatalf("global oldest=%+v err=%v", oldest, err)
	}
	images, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 100, Type: "image"})
	if err != nil || len(images.Assets) != 1 || images.Assets[0].ID != "asset_old_"+id {
		t.Fatalf("filtered images=%+v err=%v", images, err)
	}
	if _, err := repo.ListAssets(ctx, actor, AssetListOptions{Limit: 1, Type: "image", Cursor: *videos.NextCursor}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("mismatched cursor: %v", err)
	}
	// Restore the shared fixture for the creative-variant checks below.
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$1,'image/png',100,'UPLOADED',now(),now())`, "asset_new_"+id, orgID); err != nil {
		t.Fatal(err)
	}
	if result, err := repo.DeleteAsset(ctx, actor, "asset_other_"+id); err != nil || result != AssetMissing {
		t.Fatalf("foreign asset deletion disclosed ownership: result=%s err=%v", result, err)
	}
	objects := &recordingAssetObjects{}
	repo.WithObjectStore(objects).WithAssetDownloads(strings.Repeat("a", 32), "https://shots.example.test")
	var uploaded bytes.Buffer
	if err := png.Encode(&uploaded, image.NewRGBA(image.Rect(0, 0, 1200, 900))); err != nil {
		t.Fatal(err)
	}
	signed, err := repo.SignAssetUpload(ctx, actor, AssetUploadInput{
		Bytes: uploaded.Len(), Classification: "input", ContentType: "image/png", FileName: "canary.png",
	})
	if err != nil || signed.Asset.Status != "PENDING" || signed.UploadURL == "" || !strings.HasPrefix(objects.key, "org/"+orgID+"/input/") {
		t.Fatalf("signed asset=%+v key=%q err=%v", signed, objects.key, err)
	}
	if _, err := repo.CompleteAssetUpload(ctx, actor, signed.Asset.ID, nil); !errors.Is(err, ErrObjectMissing) {
		t.Fatalf("missing upload completed: %v", err)
	}
	objects.exists = true
	objects.written = uploaded.Bytes()
	completed, err := repo.CompleteAssetUpload(ctx, actor, signed.Asset.ID, nil)
	if err != nil || completed.Status != "UPLOADED" {
		t.Fatalf("completed asset=%+v err=%v", completed, err)
	}
	var width, height int
	if err := db.SQL.QueryRowContext(ctx, `SELECT width,height FROM asset WHERE id=$1`, signed.Asset.ID).Scan(&width, &height); err != nil || width != 1200 || height != 900 {
		t.Fatalf("saved dimensions %dx%d: %v", width, height, err)
	}
	// Viewing a legacy image repairs its missing metadata from the actual stored bytes.
	if _, _, err := repo.ReadAsset(ctx, actor, "asset_old_"+id); err != nil {
		t.Fatal(err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT width,height FROM asset WHERE id=$1`, "asset_old_"+id).Scan(&width, &height); err != nil || width != 1200 || height != 900 {
		t.Fatalf("backfilled dimensions %dx%d: %v", width, height, err)
	}
	if _, err := repo.CompleteAssetUpload(ctx, actor, signed.Asset.ID, nil); err != nil {
		t.Fatalf("repeat asset completion: %v", err)
	}
	if signedURL, err := repo.SignAssetDownload(ctx, actor, signed.Asset.ID); err != nil || !strings.HasPrefix(signedURL, "https://shots.example.test/api/v1/assets/"+signed.Asset.ID+"/content?downloadToken=") {
		t.Fatalf("asset download URL=%q err=%v", signedURL, err)
	}
	var uploadEvents int
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND "aggregateId"=$2 AND type='asset.uploaded'`, orgID, signed.Asset.ID).Scan(&uploadEvents); err != nil || uploadEvents != 1 {
		t.Fatalf("asset uploaded outbox count=%d err=%v", uploadEvents, err)
	}
	canvas := image.NewRGBA(image.Rect(0, 0, 1, 1))
	canvas.Set(0, 0, color.RGBA{R: 255, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatal(err)
	}
	generatedInput := GeneratedAssetInput{
		Body: encoded.Bytes(), Classification: "derived", ContentType: "image/png", FileName: "render.png",
		Width: 1, Height: 1, ParentAssetID: signed.Asset.ID,
	}
	badDimensions := generatedInput
	badDimensions.Width = 2
	if _, err := repo.StoreGeneratedAsset(ctx, actor, badDimensions); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid generated dimensions accepted: %v", err)
	}
	foreignParent := generatedInput
	foreignParent.ParentAssetID = "asset_other_" + id
	if _, err := repo.StoreGeneratedAsset(ctx, actor, foreignParent); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign parent accepted: %v", err)
	}
	generated, err := repo.StoreGeneratedAsset(ctx, actor, generatedInput)
	if err != nil || generated.MediaType != "image/png" || !bytes.Equal(objects.written, encoded.Bytes()) {
		t.Fatalf("generated asset=%+v stored=%d err=%v", generated, len(objects.written), err)
	}
	if body, mediaType, err := repo.ReadAsset(ctx, actor, generated.ID); err != nil || mediaType != "image/png" || !bytes.Equal(body, encoded.Bytes()) {
		t.Fatalf("backend asset read: mediaType=%q err=%v", mediaType, err)
	}
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND "aggregateId"=$2 AND type='asset.uploaded'`, orgID, generated.ID).Scan(&uploadEvents); err != nil || uploadEvents != 1 {
		t.Fatalf("generated asset outbox count=%d err=%v", uploadEvents, err)
	}
	workspace, err := repo.CreateWorkspace(ctx, actor, CreateWorkspaceInput{Name: "Second Workspace", Slug: "second-" + id})
	if err != nil || workspace.WorkspaceSettings == nil || workspace.CreatedAt.IsZero() {
		t.Fatalf("workspace creation=%v err=%v", workspace, err)
	}
	secondActor := Actor{OrganizationID: workspace.ID, UserID: userID, SessionID: actor.SessionID, RequestID: actor.RequestID}
	if _, _, err := repo.ReadAsset(ctx, secondActor, generated.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant asset bytes were visible: %v", err)
	}
	firstUpload := AssetUploadInput{Bytes: 1, Classification: "input", ContentType: "image/png", FileName: "first.png"}
	var notEntitled *FeatureNotEntitledError
	if _, err := repo.SignAssetUpload(ctx, secondActor, firstUpload); !errors.As(err, &notEntitled) ||
		notEntitled.Feature != "asset:create" || notEntitled.CurrentPlan != "free" || notEntitled.RequiredPlan != "pro" {
		t.Fatalf("unsubscribed workspace upload allowed: %v", err)
	}
	subscribe(t, ctx, repo, workspace.ID, "pro")
	if result, err := repo.SignAssetUpload(ctx, secondActor, firstUpload); err != nil || result.Asset.Status != "PENDING" {
		t.Fatalf("first upload in empty workspace=%+v err=%v", result, err)
	}
	t.Cleanup(func() { _, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, workspace.ID) })
	workspaces, err := repo.ListWorkspaces(ctx, actor)
	if err != nil || len(workspaces) != 2 || workspaces[1].ID != workspace.ID || workspaces[1].Role != "owner" {
		t.Fatalf("workspace list=%v err=%v", workspaces, err)
	}
	bootstrap, err := repo.Bootstrap(ctx, actor)
	if err != nil || bootstrap.User.ID != userID || bootstrap.Organization.ID != orgID ||
		bootstrap.Role != "owner" || len(bootstrap.Organizations) != 2 ||
		bootstrap.Counters.Approvals != 0 || bootstrap.Counters.Attention != 0 ||
		!bootstrap.Entitlements.Features["asset:read"] || !bootstrap.Entitlements.Features["workspace:use"] {
		t.Fatalf("bootstrap=%+v err=%v", bootstrap, err)
	}
	if _, err := db.SQL.ExecContext(ctx,
		`UPDATE workspace_entitlement SET "featureOverrides"='{"asset:update":false}' WHERE "organizationId"=$1`, orgID); err != nil {
		t.Fatal(err)
	}
	bootstrap, err = repo.Bootstrap(ctx, actor)
	if err != nil || bootstrap.Entitlements.Plan != "pro" || bootstrap.Entitlements.Features["asset:update"] || !bootstrap.Entitlements.Features["asset:delete"] {
		t.Fatalf("bootstrap entitlement override=%+v err=%v", bootstrap, err)
	}
	if err := repo.SetActiveWorkspace(ctx, actor, otherOrgID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant activation succeeded: %v", err)
	}
	if err := repo.SetActiveWorkspace(ctx, actor, workspace.ID); err != nil {
		t.Fatalf("owned workspace activation failed: %v", err)
	}
	updated, err := repo.UpdateWorkspace(ctx, Actor{OrganizationID: workspace.ID, UserID: userID, SessionID: actor.SessionID, RequestID: actor.RequestID},
		UpdateWorkspaceInput{Name: "Renamed Workspace", Slug: "renamed-" + id, Locale: stringPointer("fr-CA")})
	if err != nil || updated.Name != "Renamed Workspace" || updated.WorkspaceSettings.Locale != "fr-CA" {
		t.Fatalf("workspace update=%v err=%v", updated, err)
	}
	fetched, err := repo.GetWorkspace(ctx, workspace.ID)
	if err != nil || fetched.Name != "Renamed Workspace" {
		t.Fatalf("workspace fetch=%v err=%v", fetched, err)
	}
	if err := repo.SetActiveWorkspace(ctx, actor, orgID); err != nil {
		t.Fatal(err)
	}
	if result, err := repo.DeleteAsset(ctx, actor, "asset_pending_"+id); err != nil || result != AssetNotReady {
		t.Fatalf("pending asset deletion result=%s err=%v", result, err)
	}
	if result, err := repo.DeleteAsset(ctx, actor, "asset_old_"+id); err != nil || result != AssetDeleted {
		t.Fatalf("asset deletion result=%s err=%v", result, err)
	}
	if result, err := repo.DeleteAsset(ctx, actor, "asset_old_"+id); err != nil || result != AssetMissing {
		t.Fatalf("repeat asset deletion result=%s err=%v", result, err)
	}
	var deletionEvents int
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND "aggregateId"=$2 AND type='asset.deleted'`, orgID, "asset_old_"+id).Scan(&deletionEvents); err != nil || deletionEvents != 1 {
		t.Fatalf("asset deletion outbox count=%d err=%v", deletionEvents, err)
	}
	members, err := repo.ListMembers(ctx, orgID)
	if err != nil || len(members) != 1 || members[0].User.Email != id+"@example.test" {
		t.Fatalf("workspace members=%v err=%v", members, err)
	}
	if _, err := db.SQL.ExecContext(ctx,
		`INSERT INTO invitation (id,"organizationId",email,role,status,"expiresAt","createdAt","inviterId") VALUES ($1,$2,$3,'viewer','pending',now()+interval '1 day',now(),$4),($5,$2,$6,'viewer','pending',now()-interval '1 day',now(),$4)`,
		"inv_pending_"+id, orgID, "pending-"+id+"@example.test", userID,
		"inv_expired_"+id, "expired-"+id+"@example.test"); err != nil {
		t.Fatal(err)
	}
	invitations, err := repo.ListInvitations(ctx, orgID)
	if err != nil || len(invitations) != 1 || invitations[0].ID != "inv_pending_"+id {
		t.Fatalf("workspace invitations=%v err=%v", invitations, err)
	}
	if err := repo.Authorize(ctx, actor); err != nil {
		t.Fatalf("owner session rejected: %v", err)
	}
	if err := repo.Authorize(ctx, Actor{OrganizationID: otherOrgID, UserID: userID, SessionID: actor.SessionID}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("wrong tenant authorized: %v", err)
	}
	// A legacy definition (no schemaVersion, colors.foreground) is saved canonically.
	kit, err := repo.CreateBrandKit(ctx, actor, CreateBrandKitInput{Name: "Main", Definition: map[string]any{
		"colors":     map[string]any{"foreground": "#111111", "background": "#FFFFFF", "accent": "#3366ff", "primary": "#000000"},
		"typography": map[string]any{"headingFamily": "inter"}}, Publish: true})
	if err != nil || kit.Version != 1 || kit.Definition["schemaVersion"] != 1 ||
		kit.Definition["colors"].(map[string]any)["text"] != "#111111" || kit.Definition["colors"].(map[string]any)["primary"] != nil {
		t.Fatalf("first kit=%+v err=%v", kit, err)
	}
	logoID, foreignLogoID := uuid.NewString(), uuid.NewString()
	for _, row := range []struct{ id, org, status string }{{logoID, orgID, "UPLOADED"}, {foreignLogoID, otherOrgID, "UPLOADED"}} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,$4,now(),now())`,
			row.id, row.org, "logos/"+row.id, row.status); err != nil {
			t.Fatal(err)
		}
	}
	definition := func(logo string) map[string]any {
		return map[string]any{"schemaVersion": float64(1),
			"colors":     map[string]any{"text": "#111111", "background": "#ffffff", "accent": "#3366FF"},
			"typography": map[string]any{"headingFamily": "inter", "bodyFamily": "lora"},
			"logo":       map[string]any{"primaryAssetId": logo}}
	}
	second, err := repo.CreateBrandKit(ctx, actor, CreateBrandKitInput{Name: "Main", Definition: definition(logoID)})
	if err != nil || second.Version != 2 || second.Definition["logo"].(map[string]any)["primaryAssetId"] != logoID {
		t.Fatalf("second kit=%+v err=%v", second, err)
	}
	for name, bad := range map[string]map[string]any{
		"foreign logo": definition(foreignLogoID), "missing logo": definition(uuid.NewString()),
		"bad hex":     {"colors": map[string]any{"text": "red", "background": "#ffffff", "accent": "#ffffff"}, "typography": map[string]any{"headingFamily": "inter"}},
		"no font":     {"colors": map[string]any{"text": "#000000", "background": "#ffffff", "accent": "#ffffff"}, "typography": map[string]any{}},
		"version two": {"schemaVersion": float64(2), "colors": map[string]any{"text": "#000000", "background": "#ffffff", "accent": "#ffffff"}, "typography": map[string]any{"headingFamily": "inter"}},
	} {
		if _, err := repo.CreateBrandKit(ctx, actor, CreateBrandKitInput{Name: "Main", Definition: bad}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s kit accepted: %v", name, err)
		}
	}
	var terms []brand.ProhibitedTerm
	if err := json.Unmarshal([]byte(`["Acme",{"term":"cheap","reason":"Off brand","matchMode":"phrase"}]`), &terms); err != nil {
		t.Fatal(err)
	}
	profile, err := repo.UpsertBrandProfile(ctx, actor, UpsertBrandProfileInput{
		Audience: "Developers", ProductDescription: "Screenshot Studio", Tone: "Clear",
		PreferredStyles: []string{}, ProhibitedTerms: terms, SocialHandles: map[string]string{},
	})
	if err != nil || profile.OrganizationID != orgID || len(profile.ProhibitedTerms) != 2 ||
		profile.ProhibitedTerms[0] != (brand.ProhibitedTerm{Term: "Acme", MatchMode: "word"}) || profile.ProhibitedTerms[1].Reason != "Off brand" {
		t.Fatalf("profile=%v err=%v", profile, err)
	}
	// A row still holding the legacy string array reads as word-mode terms.
	if _, err := db.SQL.ExecContext(ctx, `UPDATE brand_profile SET "prohibitedTerms"='["Acme", "cheap"]' WHERE "organizationId"=$1`, orgID); err != nil {
		t.Fatal(err)
	}
	if legacy, err := repo.GetBrandProfile(ctx, orgID); err != nil || len(legacy.ProhibitedTerms) != 2 || legacy.ProhibitedTerms[1].MatchMode != "word" {
		t.Fatalf("legacy profile=%+v err=%v", legacy, err)
	}
	if _, err := repo.UpsertBrandProfile(ctx, actor, UpsertBrandProfileInput{Audience: "Developers", ProductDescription: "Screenshot Studio", Tone: "Clear",
		ProhibitedTerms: []brand.ProhibitedTerm{{Term: "Acme", MatchMode: "regex"}}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown match mode accepted: %v", err)
	}
	if _, err := repo.UpsertBrandProfile(ctx, actor, UpsertBrandProfileInput{Audience: "Developers", ProductDescription: "Screenshot Studio", Tone: "Clear",
		PreferredStyles: []string{}, ProhibitedTerms: terms, SocialHandles: map[string]string{}}); err != nil {
		t.Fatal(err)
	}
	source, err := repo.CreateSourceApp(ctx, actor, CreateSourceAppInput{
		Name: "GitHub", Provider: "github", AllowedHosts: []string{"https://github.com"},
	})
	if err != nil || source.OrganizationID != orgID {
		t.Fatalf("source app=%v err=%v", source, err)
	}
	surface, err := repo.CreateProductSurface(ctx, actor, CreateProductSurfaceInput{
		Name: "App", URL: "https://example.test", Environment: "production",
		FeatureTags: []string{"launch"}, ScreenshotAssetIDs: []string{},
	})
	if err != nil || surface.OrganizationID != orgID {
		t.Fatalf("surface=%v err=%v", surface, err)
	}
	releaseInput := CreateReleaseInput{
		Title: "October launch", BenefitStatement: "Faster approvals",
		IdempotencyKey: "release-" + id, ProductSurfaceID: &surface.ID,
	}
	if _, err := repo.CreateRelease(ctx, actor, CreateReleaseInput{
		Title: "Foreign surface", BenefitStatement: "Test", IdempotencyKey: "foreign-" + id,
		ProductSurfaceID: stringPointer("other-surface-" + id),
	}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign product surface accepted for release: %v", err)
	}
	createdRelease, err := repo.CreateRelease(ctx, actor, releaseInput)
	if err != nil || !createdRelease.Created || createdRelease.Release.ProductSurfaceID == nil {
		t.Fatalf("release creation=%+v err=%v", createdRelease, err)
	}
	retriedRelease, err := repo.CreateRelease(ctx, actor, releaseInput)
	if err != nil || retriedRelease.Created || retriedRelease.Release.ID != createdRelease.Release.ID {
		t.Fatalf("idempotent release=%+v err=%v", retriedRelease, err)
	}
	detail, err := repo.GetRelease(ctx, actor, createdRelease.Release.ID)
	if err != nil || detail.ProductSurface == nil || detail.ProductSurface.ID != surface.ID {
		t.Fatalf("release detail=%+v err=%v", detail, err)
	}
	var releaseUpdate UpdateReleaseInput
	if err := json.Unmarshal([]byte(`{"description":null,"title":"Updated launch"}`), &releaseUpdate); err != nil {
		t.Fatal(err)
	}
	updatedRelease, err := repo.UpdateRelease(ctx, actor, createdRelease.Release.ID, releaseUpdate)
	if err != nil || updatedRelease.Description != nil || updatedRelease.Title != "Updated launch" {
		t.Fatalf("updated release=%+v err=%v", updatedRelease, err)
	}
	listedReleases, err := repo.ListReleases(ctx, actor, 10)
	if err != nil || len(listedReleases) != 1 || listedReleases[0].ID != createdRelease.Release.ID {
		t.Fatalf("release list=%+v err=%v", listedReleases, err)
	}
	newName := "App 2"
	changed, err := repo.UpdateProductSurface(ctx, actor, surface.ID, UpdateProductSurfaceInput{Name: &newName})
	if err != nil || changed.Name != newName {
		t.Fatalf("updated surface=%v err=%v", changed, err)
	}
	kits, err := repo.ListBrandKits(ctx, otherOrgID)
	if err != nil || len(kits) != 0 {
		t.Fatalf("cross-tenant brand kits=%v err=%v", kits, err)
	}
	surfaces, err := repo.ListProductSurfaces(ctx, otherOrgID)
	if err != nil || len(surfaces) != 0 {
		t.Fatalf("cross-tenant surfaces=%v err=%v", surfaces, err)
	}
	if err := repo.DeleteProductSurface(ctx, Actor{OrganizationID: otherOrgID}, surface.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant delete succeeded: %v", err)
	}
	if _, err := repo.CreateCampaign(ctx, actor, CreateCampaignInput{
		Name: "Foreign release", Objective: "Test", ReleaseID: stringPointer("foreign-release-" + id),
	}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign release accepted for campaign: %v", err)
	}
	angleIndex := 0
	createdCampaign, err := repo.CreateCampaign(ctx, actor, CreateCampaignInput{
		Name: "Launch campaign", Objective: "Announce the release", ReleaseID: &createdRelease.Release.ID,
		Angles: []CampaignAngleInput{{Title: "New workflow", Hook: "Less review time"}},
		Posts:  []CampaignPostInput{{AngleIndex: &angleIndex, Channel: "linkedin", Copy: "A faster way to review."}},
	})
	if err != nil || len(createdCampaign.Angles) != 1 || len(createdCampaign.Posts) != 1 ||
		createdCampaign.ProductSurface == nil || createdCampaign.ProductSurface.ID != surface.ID ||
		createdCampaign.Release == nil || createdCampaign.Release.ID != createdRelease.Release.ID ||
		createdCampaign.Posts[0].AngleID == nil || *createdCampaign.Posts[0].AngleID != createdCampaign.Angles[0].ID {
		t.Fatalf("campaign create=%+v err=%v", createdCampaign, err)
	}
	encodedCampaign, err := json.Marshal(createdCampaign)
	if err != nil || !strings.Contains(string(encodedCampaign), `"benefitStatement":"Faster approvals"`) {
		t.Fatalf("campaign release detail missing from JSON: %s err=%v", encodedCampaign, err)
	}
	listedCampaigns, err := repo.ListCampaigns(ctx, actor)
	if err != nil || len(listedCampaigns) != 1 || listedCampaigns[0].ID != createdCampaign.ID ||
		listedCampaigns[0].Release == nil {
		t.Fatalf("campaign list=%+v err=%v", listedCampaigns, err)
	}
	if _, err := repo.GetCampaign(ctx, Actor{OrganizationID: otherOrgID, UserID: userID, SessionID: actor.SessionID},
		createdCampaign.ID); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("cross-tenant campaign read succeeded: %v", err)
	}
	if _, err := repo.TransitionCampaign(ctx, actor, createdCampaign.ID, "APPROVED"); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("invalid campaign transition accepted: %v", err)
	}
	ready, err := repo.TransitionCampaign(ctx, actor, createdCampaign.ID, "READY_FOR_REVIEW")
	if err != nil || ready.Status != "READY_FOR_REVIEW" {
		t.Fatalf("campaign review transition=%+v err=%v", ready, err)
	}
	if _, err := repo.TransitionCampaignPosts(ctx, actor, createdCampaign.ID, CampaignPostDecision{
		Decision: "approve", PostIDs: []string{createdCampaign.Posts[0].ID},
	}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("unsubmitted post approved: %v", err)
	}
	submitted, err := repo.TransitionCampaignPosts(ctx, actor, createdCampaign.ID, CampaignPostDecision{
		Decision: "submit", PostIDs: []string{createdCampaign.Posts[0].ID},
	})
	if err != nil || submitted.Status != "READY_FOR_REVIEW" || len(submitted.PostIDs) != 1 {
		t.Fatalf("post submit=%+v err=%v", submitted, err)
	}
	approved, err := repo.TransitionCampaignPosts(ctx, actor, createdCampaign.ID, CampaignPostDecision{
		Decision: "approve", PostIDs: []string{createdCampaign.Posts[0].ID},
	})
	if err != nil || approved.Status != "APPROVED" || len(approved.PostIDs) != 1 {
		t.Fatalf("post approval=%+v err=%v", approved, err)
	}
	if err := repo.DeleteProductSurface(ctx, actor, surface.ID); err != nil {
		t.Fatal(err)
	}
	var auditCount int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE "organizationId"=$1 AND "requestId"=$2`, orgID, actor.RequestID).Scan(&auditCount); err != nil || auditCount != 18 {
		t.Fatalf("audit count=%d err=%v", auditCount, err)
	}
	connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: orgID, UserID: userID, RequestID: actor.RequestID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: "canary", Platform: "linkedin", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
	if err != nil {
		t.Fatal(err)
	}
	templateID, variantID := "template_"+id, "variant_"+id
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO creative_template (id,"organizationId",name,version,definition,status,"createdAt","updatedAt") VALUES ($1,$2,'Canary',1,'{}','ACTIVE',now(),now())`, []any{templateID, orgID}},
		{`INSERT INTO creative_variant (id,"organizationId","releaseId","sourceAssetId","brandKitId","brandKitVersion","templateId","templateVersion",revision,"aspectRatio",status,"createdByUserId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,1,$6,1,1,'1:1','APPROVED',$7,now(),now())`, []any{variantID, orgID, createdRelease.Release.ID, "asset_new_" + id, kit.ID, templateID, userID}},
		{`INSERT INTO approval (id,"organizationId","variantId",status,"decidedByUserId","decidedAt","createdAt","updatedAt") VALUES ($1,$2,$3,'APPROVED',$4,now(),now(),now())`, []any{"approval_" + id, orgID, variantID, userID}},
	} {
		if _, err := db.SQL.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE campaign_post SET "creativeVariantId"=$1 WHERE id=$2`, variantID, createdCampaign.Posts[0].ID); err != nil {
		t.Fatal(err)
	}
	scheduleTime := time.Now().Add(2 * time.Hour)
	if _, err := repo.ScheduleCampaignPost(ctx, actor, createdCampaign.ID, createdCampaign.Posts[0].ID,
		ScheduleCampaignPostInput{ChannelConnectionID: "foreign-connection", ScheduledAt: &scheduleTime}); !errors.Is(err, publishing.ErrNotEligible) {
		t.Fatalf("foreign destination scheduled: %v", err)
	}
	scheduledCampaignPost, err := repo.ScheduleCampaignPost(ctx, actor, createdCampaign.ID, createdCampaign.Posts[0].ID,
		ScheduleCampaignPostInput{ChannelConnectionID: connection.ID, ScheduledAt: &scheduleTime})
	if err != nil || scheduledCampaignPost.Post.Status != "SCHEDULED" || scheduledCampaignPost.ScheduledPost.ID == "" {
		t.Fatalf("campaign schedule=%+v err=%v", scheduledCampaignPost, err)
	}
	retriedSchedule, err := repo.ScheduleCampaignPost(ctx, actor, createdCampaign.ID, createdCampaign.Posts[0].ID,
		ScheduleCampaignPostInput{ChannelConnectionID: connection.ID, ScheduledAt: &scheduleTime})
	if err != nil || retriedSchedule.ScheduledPost.ID != scheduledCampaignPost.ScheduledPost.ID {
		t.Fatalf("duplicate campaign schedule=%+v err=%v", retriedSchedule, err)
	}
	var scheduleCount int
	if err := db.SQL.QueryRowContext(ctx, `SELECT COUNT(*) FROM scheduled_post WHERE "organizationId"=$1 AND "idempotencyKey"=$2`,
		orgID, "campaign-post:"+createdCampaign.Posts[0].ID).Scan(&scheduleCount); err != nil || scheduleCount != 1 {
		t.Fatalf("canonical schedule count=%d err=%v", scheduleCount, err)
	}
	designAssetID, foreignDesignAssetID := uuid.NewString(), uuid.NewString()
	for _, entry := range []struct{ assetID, owner string }{{designAssetID, orgID}, {foreignDesignAssetID, otherOrgID}} {
		if _, err := db.SQL.ExecContext(ctx,
			`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,'UPLOADED',now(),now())`,
			entry.assetID, entry.owner, "org/"+entry.owner+"/input/"+entry.assetID+"/1/image.png"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.CreateDesign(ctx, actor, CreateDesignInput{Name: "Foreign image", Document: map[string]any{
		"version": float64(1), "image": map[string]any{"src": "asset:" + foreignDesignAssetID},
	}}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign design image accepted: %v", err)
	}
	document := map[string]any{"version": float64(1), "image": map[string]any{"src": "asset:" + designAssetID}, "overlays": []any{}}
	createdDesign, err := repo.CreateDesign(ctx, actor, CreateDesignInput{CampaignID: &createdCampaign.ID,
		Document: document, Name: "Launch visual"})
	if err != nil || createdDesign.CampaignID == nil || *createdDesign.CampaignID != createdCampaign.ID {
		t.Fatalf("design creation=%+v err=%v", createdDesign, err)
	}
	if err := repo.SetDesignRender(ctx, actor, createdDesign.ID, foreignDesignAssetID, nil); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign render asset accepted: %v", err)
	}
	if err := repo.SetDesignRender(ctx, actor, createdDesign.ID, designAssetID, nil); err != nil {
		t.Fatalf("set design render: %v", err)
	}
	listedDesigns, err := repo.ListCampaignDesigns(ctx, actor, createdCampaign.ID)
	if err != nil || len(listedDesigns) != 1 || listedDesigns[0].RenderedAsset == nil || listedDesigns[0].RenderedAsset.ID != designAssetID {
		t.Fatalf("campaign designs=%+v err=%v", listedDesigns, err)
	}
	creativeTemplate, err := repo.CreateCreativeTemplate(ctx, actor, CreateCreativeTemplateInput{
		Name: "Launch layout", Definition: map[string]any{"title": "Launch"},
	})
	if err != nil || creativeTemplate.Version != 1 || creativeTemplate.Status != "ACTIVE" {
		t.Fatalf("creative template=%+v err=%v", creativeTemplate, err)
	}
	if _, err := repo.CreateCreativeVariant(ctx, actor, CreateCreativeVariantInput{
		AspectRatio: "1:1", BrandKitID: kit.ID, ReleaseID: createdRelease.Release.ID,
		SourceAssetID: foreignDesignAssetID, TemplateID: creativeTemplate.ID,
	}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign creative source accepted: %v", err)
	}
	creativeVariant, err := repo.CreateCreativeVariant(ctx, actor, CreateCreativeVariantInput{
		AspectRatio: "1:1", BrandKitID: kit.ID, ReleaseID: createdRelease.Release.ID,
		SourceAssetID: designAssetID, TemplateID: creativeTemplate.ID,
	})
	if err != nil || creativeVariant.Status != "DRAFT" || creativeVariant.Revision != 2 {
		t.Fatalf("creative variant=%+v err=%v", creativeVariant, err)
	}
	approvalDecision, err := repo.DecideCreativeVariant(ctx, actor, creativeVariant.ID, CreativeApprovalInput{Status: "APPROVED"})
	if err != nil || approvalDecision.Variant.Status != "APPROVED" || approvalDecision.Approval.Status != "APPROVED" {
		t.Fatalf("creative approval=%+v err=%v", approvalDecision, err)
	}
	eligibleVariant, err := repo.auth.IsEligible(ctx, orgID, creativeVariant.ID, connection.ID)
	if err != nil || !eligibleVariant {
		t.Fatalf("approved variant not publishable: eligible=%v err=%v", eligibleVariant, err)
	}
	firstPage, err := repo.ListAuditLogs(ctx, actor, AuditLogQuery{Limit: 2, Search: "product"})
	if err != nil || len(firstPage.Items) != 2 || firstPage.NextCursor == nil {
		t.Fatalf("first audit page=%+v err=%v", firstPage, err)
	}
	secondPage, err := repo.ListAuditLogs(ctx, actor, AuditLogQuery{Limit: 2, Cursor: *firstPage.NextCursor, Search: "product"})
	if err != nil || len(secondPage.Items) != 2 || secondPage.Items[0].ID == firstPage.Items[1].ID {
		t.Fatalf("second audit page=%+v err=%v", secondPage, err)
	}
	if _, err := repo.ListAuditLogs(ctx, Actor{OrganizationID: otherOrgID, UserID: userID, SessionID: actor.SessionID}, AuditLogQuery{Limit: 2}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("cross-tenant audit read succeeded: %v", err)
	}
	if _, err := repo.InviteMember(ctx, actor, id+"@example.test", "viewer"); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("existing member invite accepted: %v", err)
	}
	invited, err := repo.InviteMember(ctx, actor, "invite-"+id+"@example.test", "viewer")
	if err != nil || invited.Organization.Name != "Product Workspace" || len(mailer.messages) != 1 {
		t.Fatalf("workspace invite=%v mail=%v err=%v", invited, mailer.messages, err)
	}
	resent, err := repo.ResendInvitation(ctx, actor, invited.ID)
	if err != nil || resent.ID != invited.ID || len(mailer.messages) != 2 {
		t.Fatalf("workspace invite resend=%v mail=%v err=%v", resent, mailer.messages, err)
	}
	// Use a real administrator session in the foreign workspace so this tests
	// resource scoping after authentication, rather than an unauthenticated call.
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "other_member_"+id, otherOrgID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL.ExecContext(ctx, `INSERT INTO session (id,token,"expiresAt","createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,$1,now()+interval '1 hour',now(),now(),$2,$3)`, "other_session_"+id, userID, otherOrgID); err != nil {
		t.Fatal(err)
	}
	if err := repo.RevokeInvitation(ctx, Actor{OrganizationID: otherOrgID, UserID: userID, SessionID: "other_session_" + id}, invited.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-tenant invitation revoke succeeded: %v", err)
	}
	if err := repo.RevokeInvitation(ctx, actor, invited.ID); err != nil {
		t.Fatalf("workspace invitation revoke: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE member SET role='viewer' WHERE id=$1`, "member_"+id); err != nil {
		t.Fatal(err)
	}
	if err := repo.Authorize(ctx, actor); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer authorized to manage brand: %v", err)
	}
	activeAccess, err = repo.GetActiveAccess(ctx, actor)
	if err != nil || activeAccess.Role != "viewer" {
		t.Fatalf("viewer access=%+v err=%v", activeAccess, err)
	}
	if _, err := repo.ListAuditLogs(ctx, actor, AuditLogQuery{Limit: 2}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer authorized to read audits: %v", err)
	}
	secondUserID, thirdUserID := "second_user_"+id, "third_user_"+id
	for _, person := range []struct{ id, email string }{
		{secondUserID, "second-" + id + "@example.test"},
		{thirdUserID, "third-" + id + "@example.test"},
	} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Test Member',$2,true,now(),now())`, person.id, person.email); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1 OR id=$2`, secondUserID, thirdUserID)
	})
	for _, person := range []struct{ memberID, userID string }{
		{"second_member_" + id, secondUserID}, {"third_member_" + id, thirdUserID},
	} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'viewer',now())`, person.memberID, workspace.ID, person.userID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$2,now(),now(),$3,$4)`,
			"session_"+person.userID, "token_"+person.userID, person.userID, workspace.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.SetActiveWorkspace(ctx, actor, workspace.ID); err != nil {
		t.Fatal(err)
	}
	workspaceActor := Actor{OrganizationID: workspace.ID, UserID: userID, SessionID: actor.SessionID, RequestID: actor.RequestID}
	changedMember, err := repo.UpdateMemberRole(ctx, workspaceActor, "second_member_"+id, "publisher")
	if err != nil || changedMember.Role != "publisher" {
		t.Fatalf("member role update=%v err=%v", changedMember, err)
	}
	if _, err := repo.RemoveMember(ctx, workspaceActor, "third_member_"+id); err != nil {
		t.Fatalf("member removal: %v", err)
	}
	if err := repo.AuthorizeSession(ctx, Actor{UserID: thirdUserID, SessionID: "session_" + thirdUserID}); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("removed member session survived: %v", err)
	}
	if err := repo.AuthorizeSensitive(ctx, workspaceActor); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("ownership transfer without 2FA allowed: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx, `UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := repo.AuthorizeSensitive(ctx, workspaceActor); err != nil {
		t.Fatalf("fresh owner with 2FA rejected: %v", err)
	}
	if _, err := db.SQL.ExecContext(ctx,
		`INSERT INTO organization_enterprise_settings ("organizationId","ssoEnabled","scimEnabled","createdAt","updatedAt") VALUES ($1,true,false,now(),now())`, workspace.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.RequireEnterpriseFeature(ctx, workspaceActor, "ssoEnabled"); err != nil {
		t.Fatalf("enabled SSO rejected: %v", err)
	}
	if err := repo.RequireEnterpriseFeature(ctx, workspaceActor, "scimEnabled"); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("disabled SCIM authorized: %v", err)
	}
	if _, err := repo.RequestDeletion(ctx, workspaceActor, "wrong name"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("incorrect deletion confirmation accepted: %v", err)
	}
	deletion, err := repo.RequestDeletion(ctx, workspaceActor, "Renamed Workspace")
	if err != nil || deletion.Status != "PENDING" {
		t.Fatalf("deletion request=%v err=%v", deletion, err)
	}
	pendingWorkspaces, err := repo.ListWorkspaces(ctx, workspaceActor)
	if err != nil {
		t.Fatal(err)
	}
	foundRecovery := false
	for _, item := range pendingWorkspaces {
		if item.ID == workspace.ID && item.IsScheduledForDeletion && item.WorkspaceDeletion != nil &&
			item.WorkspaceDeletion.RequestedByUserID == userID &&
			item.WorkspaceDeletion.ScheduledFor.Sub(deletion.ScheduledFor).Abs() < time.Millisecond {
			foundRecovery = true
		}
	}
	if !foundRecovery {
		t.Fatalf("owner cannot recover pending workspace: %+v", pendingWorkspaces)
	}
	if _, err := repo.GetActiveAccess(ctx, workspaceActor); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("pending workspace retained operational access: %v", err)
	}
	if err := repo.AuthorizeSensitive(ctx, workspaceActor); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("scheduled-for-deletion workspace remained writable: %v", err)
	}
	restored, err := repo.CancelDeletion(ctx, workspaceActor)
	if err != nil || restored.Status != "CANCELLED" || restored.CancelledAt == nil {
		t.Fatalf("deletion cancellation=%v err=%v", restored, err)
	}
	if err := repo.AuthorizeSensitive(ctx, workspaceActor); err != nil {
		t.Fatalf("cancelled workspace remained blocked: %v", err)
	}
	if err := repo.TransferOwnership(ctx, workspaceActor, "second_member_"+id); err != nil {
		t.Fatalf("ownership transfer: %v", err)
	}
	if _, err := repo.LeaveWorkspace(ctx, workspaceActor); err != nil {
		t.Fatalf("former owner could not leave: %v", err)
	}
	if err := repo.AuthorizeSession(ctx, workspaceActor); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("departed member session survived: %v", err)
	}
}

func stringPointer(value string) *string { return &value }
