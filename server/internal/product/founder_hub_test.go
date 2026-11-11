package product

import (
	"errors"
	"slices"
	"strconv"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/authstore"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestFounderHubUsesLiveSessionAndMembershipWithStableLibraryIdentity(t *testing.T) {
	w, foreign := newTestWorkspace(t), newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	w.exec(t, `INSERT INTO "oauthRefreshToken" (id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes)
    VALUES ($1,$1,'shots-founder-hub',$2,$3,now()+interval '1 hour',now(),'["founder-hub","offline_access"]')`,
		"refresh_"+w.id, w.owner.SessionID, w.owner.UserID)
	actor := w.owner
	actor.OrganizationID = foreign.org
	if _, err := w.repo.GetFounderHubKeySession(w.ctx, actor); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE "oauthRefreshToken" SET revoked=now() WHERE id=$1`, "refresh_"+w.id)
	if _, err := w.repo.GetFounderHubKeySession(w.ctx, actor); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked grant authorized an API key: %v", err)
	}
	if _, err := w.repo.GetFounderHubSession(w.ctx, actor); err != nil {
		t.Fatalf("rotation invalidated a still-live short access token: %v", err)
	}
	w.exec(t, `UPDATE "oauthRefreshToken" SET revoked=NULL WHERE id=$1`, "refresh_"+w.id)
	first, err := w.repo.GetFounderHubSession(w.ctx, actor)
	if err != nil {
		t.Fatal(err)
	}
	if first.User.ID != w.owner.UserID || len(first.Workspaces) != 1 ||
		first.Workspaces[0].OrganizationID != w.org || !first.Workspaces[0].Features["workspace:paid"] {
		t.Fatalf("wrong identity or tenant: %+v", first)
	}
	authorization, err := w.repo.AuthorizeFounderHubSession(w.ctx, actor)
	if err != nil || authorization.UserID != actor.UserID || authorization.SessionID != actor.SessionID {
		t.Fatalf("lean authorization lost identity: %+v %v", authorization, err)
	}
	account, err := w.repo.GetFounderHubSettingsAccount(w.ctx, actor)
	if err != nil || len(account.Workspaces) != 1 || account.Workspaces[0].Name != first.Workspaces[0].Name || !account.Workspaces[0].Features["workspace:paid"] {
		t.Fatalf("settings account lost live workspace entitlement: %+v %v", account, err)
	}
	w.addMember(t, "successor", "admin")
	before, err := w.repo.GetFounderHubProfile(w.ctx, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := w.db.SQL.BeginTx(w.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(w.ctx, `UPDATE member SET role='viewer' WHERE "userId"=$1`, w.actor("successor").UserID); err != nil {
		t.Fatal(err)
	}
	during, err := w.repo.GetFounderHubProfile(w.ctx, actor.UserID)
	if err != nil || during.Revision != before.Revision {
		t.Fatalf("uncommitted authority leaked: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	w.exec(t, `UPDATE member SET role='viewer' WHERE "userId"=$1`, w.owner.UserID)
	w.exec(t, `UPDATE member SET role='owner' WHERE "userId"=$1`, w.actor("successor").UserID)
	current, err := w.repo.GetFounderHubSession(w.ctx, actor)
	if err != nil || current.AccountUserID != first.AccountUserID || current.Workspaces[0].WorkspaceID != first.Workspaces[0].WorkspaceID ||
		current.Workspaces[0].Role != "viewer" {
		t.Fatalf("identity or current role changed incorrectly: %+v %v", current, err)
	}
	oldRevision, _ := strconv.ParseInt(first.Revision, 10, 64)
	newRevision, _ := strconv.ParseInt(current.Revision, 10, 64)
	if newRevision <= oldRevision || len(current.Workspaces[0].Members) != 2 || current.Workspaces[0].OwnerUserID == first.AccountUserID {
		t.Fatal("authority change lost its revision, roster, or canonical owner")
	}
	w.exec(t, `INSERT INTO permission_group (id,"organizationId",name,"deniedPermissions","isDefault","createdAt","updatedAt")
      VALUES ($1,$2,'Blocked workspace','["workspace:read"]',true,now(),now())`, "group_"+w.id, w.org)
	current, err = w.repo.GetFounderHubSession(w.ctx, actor)
	if err != nil || len(current.Workspaces) != 1 || !slices.Contains(current.Workspaces[0].DeniedPermissions, "workspace:read") {
		t.Fatalf("private authority lost the actor's explicit denial: %+v %v", current, err)
	}
	account, err = w.repo.GetFounderHubSettingsAccount(w.ctx, actor)
	if err != nil || len(account.Workspaces) != 0 {
		t.Fatalf("settings granted paid access through a denied workspace: %+v %v", account, err)
	}
	foundDenied := false
	for _, member := range current.Workspaces[0].Members {
		if member.User.ID == actor.UserID && slices.Contains(member.DeniedPermissions, "workspace:read") {
			foundDenied = true
		}
	}
	if !foundDenied {
		t.Fatal("private roster treated a denied member as an outside guest")
	}
	w.exec(t, `INSERT INTO permission_group (id,"organizationId",name,"deniedPermissions","isDefault","createdAt","updatedAt")
      VALUES ($1,$2,'Read only','["artifact:edit"]',false,now(),now())`, "assigned_"+w.id, w.org)
	w.exec(t, `INSERT INTO permission_group_member ("memberId","permissionGroupId") SELECT id,$2 FROM member WHERE "userId"=$1 AND "organizationId"=$3`, actor.UserID, "assigned_"+w.id, w.org)
	current, err = w.repo.GetFounderHubSession(w.ctx, actor)
	if err != nil || !slices.Equal(current.Workspaces[0].DeniedPermissions, []string{"artifact:edit"}) || len(current.Workspaces[0].Owner.DeniedPermissions) != 0 {
		t.Fatalf("batched authority lost assigned permissions or owner exemption: %+v %v", current, err)
	}
	w.exec(t, `DELETE FROM member WHERE "userId"=$1`, w.owner.UserID)
	current, err = w.repo.GetFounderHubSession(w.ctx, actor)
	if err != nil || len(current.Workspaces) != 0 {
		t.Fatalf("removed membership remained: %+v %v", current, err)
	}
	w.exec(t, `UPDATE session SET "expiresAt"=now()-interval '1 hour' WHERE id=$1`, w.owner.SessionID)
	if _, err := w.repo.AuthorizeFounderHubSession(w.ctx, actor); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("lean authorization accepted an expired session: %v", err)
	}
	if _, err := w.repo.GetFounderHubSession(w.ctx, actor); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("expired session accepted: %v", err)
	}
	store := authstore.New(w.db.SQL)
	token, err := store.Execute(w.ctx, authstore.Request{Model: "oauthRefreshToken", Op: "findOne",
		Where: []authstore.Where{{Field: "token", Value: "refresh_" + w.id}}})
	if err != nil || token.Row != nil {
		t.Fatalf("expired session can refresh: %+v %v", token, err)
	}
}

func TestFounderHubConnectorRequiresCurrentScopedConsentAndGrant(t *testing.T) {
	w := newTestWorkspace(t)
	clientID := "connector_" + w.id
	scopes := `["founder-hub:meetings:read","offline_access"]`
	w.exec(t, `INSERT INTO "oauthClient" (id,"clientId","redirectUris",scopes) VALUES ($1,$1,'[]',$2)`, clientID, scopes)
	w.exec(t, `INSERT INTO "oauthConsent" (id,"clientId","userId",scopes,"createdAt","updatedAt") VALUES ($1,$1,$2,$3,now(),now())`, clientID, w.owner.UserID, scopes)
	w.exec(t, `INSERT INTO "oauthRefreshToken" (id,token,"clientId","sessionId","userId","expiresAt","createdAt",scopes)
      VALUES ($1,$1,$1,$2,$3,now()+interval '1 hour',now(),$4)`, clientID, w.owner.SessionID, w.owner.UserID, scopes)
	t.Cleanup(func() { w.exec(t, `DELETE FROM "oauthClient" WHERE id=$1`, clientID) })
	for _, mutation := range []string{
		`UPDATE "oauthConsent" SET scopes='["offline_access"]' WHERE "clientId"=$1`,
		`UPDATE "oauthRefreshToken" SET scopes='["offline_access"]' WHERE "clientId"=$1`,
		`UPDATE "oauthRefreshToken" SET revoked=now() WHERE "clientId"=$1`,
		`UPDATE "oauthClient" SET disabled=true WHERE "clientId"=$1`,
	} {
		if _, err := w.repo.GetFounderHubConnectorSession(w.ctx, w.owner, clientID); err != nil {
			t.Fatal(err)
		}
		w.exec(t, mutation, clientID)
		if _, err := w.repo.GetFounderHubConnectorSession(w.ctx, w.owner, clientID); !errors.Is(err, publishing.ErrUnauthorized) {
			t.Fatalf("revoked connector remained authorized: %v", err)
		}
		w.exec(t, `UPDATE "oauthConsent" SET scopes=$2 WHERE "clientId"=$1`, clientID, scopes)
		w.exec(t, `UPDATE "oauthRefreshToken" SET scopes=$2,revoked=NULL WHERE "clientId"=$1`, clientID, scopes)
		w.exec(t, `UPDATE "oauthClient" SET disabled=false WHERE "clientId"=$1`, clientID)
	}
	if _, err := w.repo.GetFounderHubSession(w.ctx, w.owner); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("connector authorized a native session: %v", err)
	}
}
