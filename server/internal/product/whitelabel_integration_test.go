package product

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
	"github.com/lucsky/cuid"
)

// Branding is an enterprise control for fresh two-factor admins, scoped to one
// workspace, audited, and applied only while the plan grants it.
func TestWhitelabelSettings(t *testing.T) {
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
	org, other, ownerID, viewerID := "org_"+id, "other_"+id, "owner_"+id, "viewer_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	for _, organization := range []string{org, other} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
	}
	for _, person := range []struct{ id, role string }{{ownerID, "owner"}, {viewerID, "viewer"}} {
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$1,$2,true,true,now(),now())`, person.id, person.id+"@example.test")
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "session_"+person.id, person.id, org)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+person.id, org, person.id, person.role)
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1 OR id=$2`, ownerID, viewerID)
	})

	repo := NewConfiguration(db.Client)
	owner := Actor{OrganizationID: org, UserID: ownerID, SessionID: "session_" + ownerID, RequestID: "request_" + id}
	viewer := Actor{OrganizationID: org, UserID: viewerID, SessionID: "session_" + viewerID, RequestID: "request_" + id}
	request := AuditRequest{IPHash: "hash_" + id, UserAgentSummary: "test agent"}
	brand := whitelabel.Settings{BrandName: " Acme ", PrimaryColor: "#0A66FF", LogoURL: "https://cdn.acme.test/logo.png"}

	subscribe(t, ctx, repo, org, "business")
	var notEntitled *FeatureNotEntitledError
	if _, err := repo.UpdateWhitelabel(ctx, owner, brand, request); !errors.As(err, &notEntitled) || notEntitled.RequiredPlan != "enterprise" {
		t.Fatalf("business plan branded the app: %v", err)
	}
	setPlan := func(plan string) {
		t.Helper()
		exec(`UPDATE workspace_entitlement SET plan=$1 WHERE "organizationId"=$2`, plan, org)
	}
	setPlan("enterprise")

	if settings, err := repo.GetWhitelabel(ctx, owner); err != nil || *settings != (whitelabel.Settings{}) {
		t.Fatalf("default=%+v err=%v", settings, err)
	}
	if _, err := repo.UpdateWhitelabel(ctx, viewer, brand, request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("viewer branded the app: %v", err)
	}
	if _, err := repo.UpdateWhitelabel(ctx, owner, whitelabel.Settings{PrimaryColor: "red"}, request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid color accepted: %v", err)
	}
	for range 2 {
		if settings, err := repo.UpdateWhitelabel(ctx, owner, brand, request); err != nil || settings.BrandName != "Acme" {
			t.Fatalf("updated=%+v err=%v", settings, err)
		}
	}
	if settings, err := repo.GetWhitelabel(ctx, viewer); err != nil || settings.BrandName != "Acme" || settings.LogoURL != brand.LogoURL {
		t.Fatalf("member read=%+v err=%v", settings, err)
	}
	if settings, err := repo.GetWhitelabel(ctx, Actor{OrganizationID: other, Kind: "service"}); err != nil || settings.BrandName != "" {
		t.Fatalf("other workspace=%+v err=%v", settings, err)
	}
	var audits int
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action='organization.whitelabel_changed' AND "ipHash"=$2`, org, request.IPHash).Scan(&audits); err != nil || audits != 2 {
		t.Fatalf("audits=%d err=%v", audits, err)
	}

	page, err := repo.PageAccess(ctx, viewer)
	if err != nil || page.Whitelabel == nil || page.Whitelabel.BrandName != "Acme" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	// A lapsed plan stops applying the branding and keeps it stored.
	setPlan("pro")
	if page, err = repo.PageAccess(ctx, viewer); err != nil || page.Whitelabel != nil {
		t.Fatalf("lapsed page=%+v err=%v", page, err)
	}
	if settings, err := repo.GetWhitelabel(ctx, owner); err != nil || settings.BrandName != "Acme" {
		t.Fatalf("lapsed read=%+v err=%v", settings, err)
	}
}
