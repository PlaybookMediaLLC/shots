package product

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Groups only subtract, never touch an owner, stay inside one workspace, and
// keep applying after the plan lapses until an admin deletes them.
func TestPermissionGroups(t *testing.T) {
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
	org, other := "org_"+id, "other_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	for _, organization := range []string{org, other} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
	}
	person := func(role, organization string) (Actor, string) {
		t.Helper()
		userID := role + "_" + organization
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","twoFactorEnabled","createdAt","updatedAt") VALUES ($1,$1,$2,true,true,now(),now())`, userID, userID+"@example.test")
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "session_"+userID, userID, organization)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())`, "member_"+userID, organization, userID, role)
		return Actor{OrganizationID: organization, UserID: userID, SessionID: "session_" + userID, RequestID: "request_" + id}, "member_" + userID
	}
	owner, ownerMember := person("owner", org)
	admin, adminMember := person("admin", org)
	creator, creatorMember := person("creator", org)
	publisher, publisherMember := person("publisher", org)
	foreignOwner, foreignMember := person("owner", other)
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id LIKE '%' || $1`, id)
	})

	repo := NewConfiguration(db.Client)
	request := AuditRequest{IPHash: "hash_" + id, UserAgentSummary: "test agent"}
	denied := func(actor Actor) []string {
		t.Helper()
		access, err := repo.GetActiveAccess(ctx, actor)
		if err != nil {
			t.Fatal(err)
		}
		page, err := repo.PageAccess(ctx, actor)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(access.DeniedPermissions, page.DeniedPermissions) {
			t.Fatalf("access=%v page=%v", access.DeniedPermissions, page.DeniedPermissions)
		}
		return access.DeniedPermissions
	}
	publishing_ := PermissionGroupInput{DeniedPermissions: []string{"publish:manage", "publish:manage"}, Name: " No publishing "}

	subscribe(t, ctx, repo, org, "business")
	subscribe(t, ctx, repo, other, "enterprise")
	var notEntitled *FeatureNotEntitledError
	if _, err := repo.CreatePermissionGroup(ctx, owner, publishing_, request); !errors.As(err, &notEntitled) {
		t.Fatalf("business plan created a group: %v", err)
	}
	exec(`UPDATE workspace_entitlement SET plan='enterprise' WHERE "organizationId"=$1`, org)

	if len(denied(publisher)) != 0 {
		t.Fatal("a workspace without groups restricts nobody")
	}
	if _, err := repo.CreatePermissionGroup(ctx, creator, publishing_, request); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("creator created a group: %v", err)
	}
	if _, err := repo.CreatePermissionGroup(ctx, owner, PermissionGroupInput{DeniedPermissions: []string{"made:up"}, Name: "Bad"}, request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown permission accepted: %v", err)
	}
	group, err := repo.CreatePermissionGroup(ctx, admin, publishing_, request)
	if err != nil || group.Name != "No publishing" || !slices.Equal(group.DeniedPermissions, []string{"publish:manage"}) {
		t.Fatalf("group=%+v err=%v", group, err)
	}
	if _, err := repo.CreatePermissionGroup(ctx, owner, publishing_, request); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("duplicate name: %v", err)
	}

	// Assignment is scoped to the workspace, and the group to its owner.
	if _, err := repo.SetPermissionGroupMembers(ctx, owner, group.ID, []string{foreignMember}, request); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("foreign member assigned: %v", err)
	}
	if _, err := repo.SetPermissionGroupMembers(ctx, foreignOwner, group.ID, nil, request); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign owner reached the group: %v", err)
	}
	if err := repo.DeletePermissionGroup(ctx, foreignOwner, group.ID, request); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign owner deleted the group: %v", err)
	}
	if groups, err := repo.ListPermissionGroups(ctx, foreignOwner); err != nil || len(groups) != 0 {
		t.Fatalf("foreign groups=%+v err=%v", groups, err)
	}
	if _, err := repo.SetPermissionGroupMembers(ctx, owner, group.ID, []string{publisherMember, ownerMember}, request); err != nil {
		t.Fatal(err)
	}
	if got := denied(publisher); !slices.Equal(got, []string{"publish:manage"}) {
		t.Fatalf("publisher denied=%v", got)
	}
	if got := denied(owner); len(got) != 0 {
		t.Fatalf("owner restricted: %v", got)
	}
	if got := denied(creator); len(got) != 0 {
		t.Fatalf("unassigned member restricted: %v", got)
	}

	// Member commands refuse a denied admin however they arrive, and the
	// refused admin keeps every permission the group does not name.
	noInvites := PermissionGroupInput{DeniedPermissions: []string{"member:invite", "member:remove"}, Name: "No invites"}
	limited, err := repo.CreatePermissionGroup(ctx, owner, noInvites, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.SetPermissionGroupMembers(ctx, owner, limited.ID, []string{adminMember}, request); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.InviteMember(ctx, admin, "invitee_"+id+"@example.test", "viewer"); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("denied admin invited: %v", err)
	}
	if _, err := repo.RemoveMember(ctx, admin, publisherMember); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("denied admin removed a member: %v", err)
	}
	if _, err := repo.UpdateMemberRole(ctx, admin, publisherMember, "publisher"); errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("group refused a permission it does not deny: %v", err)
	}
	if err := repo.DeletePermissionGroup(ctx, owner, limited.ID, request); err != nil {
		t.Fatal(err)
	}

	// The default covers whoever has no group; a second default is refused.
	readOnly := PermissionGroupInput{DeniedPermissions: []string{"artifact:edit"}, IsDefault: true, Name: "Read only"}
	fallback, err := repo.CreatePermissionGroup(ctx, owner, readOnly, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpdatePermissionGroup(ctx, owner, group.ID, PermissionGroupInput{IsDefault: true, Name: "No publishing"}, request); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("second default: %v", err)
	}
	if got := denied(creator); !slices.Equal(got, []string{"artifact:edit"}) {
		t.Fatalf("default denied=%v", got)
	}
	if got := denied(publisher); !slices.Equal(got, []string{"publish:manage"}) {
		t.Fatalf("assigned member took the default: %v", got)
	}
	if writable, err := collabWritable(ctx, db.Client, org, creator.UserID, "creator"); err != nil || writable {
		t.Fatalf("group did not close live editing: writable=%v err=%v", writable, err)
	}

	// Moving a member takes them out of their previous group.
	if _, err := repo.SetPermissionGroupMembers(ctx, owner, fallback.ID, []string{publisherMember, creatorMember}, request); err != nil {
		t.Fatal(err)
	}
	if got := denied(publisher); !slices.Equal(got, []string{"artifact:edit"}) {
		t.Fatalf("moved member denied=%v", got)
	}
	groups, err := repo.ListPermissionGroups(ctx, owner)
	if err != nil || len(groups) != 2 || !slices.Equal(groups[0].MemberIDs, []string{ownerMember}) || len(groups[1].MemberIDs) != 2 {
		t.Fatalf("groups=%+v err=%v", groups, err)
	}

	// A lapsed plan keeps restricting and blocks changes, but can delete.
	exec(`UPDATE workspace_entitlement SET plan='pro' WHERE "organizationId"=$1`, org)
	if got := denied(creator); !slices.Equal(got, []string{"artifact:edit"}) {
		t.Fatalf("lapsed plan widened access: %v", got)
	}
	if _, err := repo.UpdatePermissionGroup(ctx, owner, fallback.ID, readOnly, request); !errors.As(err, &notEntitled) {
		t.Fatalf("lapsed plan changed a group: %v", err)
	}
	if err := repo.DeletePermissionGroup(ctx, owner, fallback.ID, request); err != nil {
		t.Fatal(err)
	}
	if got := denied(creator); len(got) != 0 {
		t.Fatalf("deleted group still applies: %v", got)
	}

	// Leaving the workspace removes the assignment.
	exec(`DELETE FROM member WHERE id=$1`, ownerMember)
	var left int
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM permission_group_member WHERE "memberId"=$1`, ownerMember).Scan(&left); err != nil || left != 0 {
		t.Fatalf("assignment outlived the member: %d %v", left, err)
	}

	var audits int
	if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND action LIKE 'permission_group.%' AND "ipHash"=$2`, org, request.IPHash).Scan(&audits); err != nil || audits != 8 {
		t.Fatalf("audits=%d err=%v", audits, err)
	}
}
