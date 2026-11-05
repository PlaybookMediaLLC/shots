package publishing

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/lucsky/cuid"
)

func verifiedXReceipt(id string) schema.SocialOAuthExchange {
	now := time.Now()
	caps := socialidentity.XStandardPostLimits("read-write", nil)
	return schema.SocialOAuthExchange{ID: id, Account: &socialidentity.Connection{ID: id, Provider: "x", NativeID: "123456789", Active: true, VerifiedAt: &now,
		Verification: &socialidentity.Verification{AccountKey: "x:123456789", AccountKind: "profile", GrantedScopes: []string{"read-write"}, Capabilities: socialidentity.Capabilities{Version: 1, X: &caps}}}}
}

func TestOAuthReceiptsKeepOriginalContextAndIdentity(t *testing.T) {
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
		t.Fatalf("refusing %q: %v", name, err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	id := cuid.New()
	user, org, other, sessionID := "oauth-user-"+id, "oauth-org-"+id, "oauth-other-"+id, "oauth-session-"+id
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'OAuth fixture',$2,true,now(),now())`, user, user+"@example.test")
	exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Other fixture',$2,true,now(),now())`, "other-"+user, "other-"+user+"@example.test")
	for _, workspace := range []string{org, other} {
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'OAuth fixture',$1,now())`, workspace)
		exec(`INSERT INTO workspace_entitlement ("organizationId",plan,status,"updatedAt") VALUES ($1,'business','active',now())`, workspace)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'admin',now())`, workspace+"-member", workspace, user)
	}
	exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, sessionID, user, org)
	t.Cleanup(func() {
		tx, err := db.SQL.BeginTx(ctx, nil)
		if err != nil {
			t.Errorf("cleanup transaction: %v", err)
			return
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, `SET LOCAL shots.audit_retention='on'`); err != nil {
			t.Errorf("cleanup audit permission: %v", err)
			return
		}
		for _, workspace := range []string{org, other} {
			for _, table := range []string{"audit_log", "outbox_event", "social_oauth_start", "channel_connection", "social_set"} {
				if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE "organizationId"=$1`, workspace); err != nil {
					t.Errorf("cleanup %s: %v", table, err)
				}
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, workspace); err != nil {
				t.Errorf("cleanup: %v", err)
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM "user" WHERE id IN ($1,$2)`, user, "other-"+user); err != nil {
			t.Errorf("cleanup user: %v", err)
		}
		if err := tx.Commit(); err != nil {
			t.Errorf("cleanup commit: %v", err)
		}
	})
	repo := NewRepository(db.Client)
	actor := Actor{Organization: org, UserID: user, Type: "USER", RequestID: id}
	makeSet := func(private bool) *ent.SocialSet {
		t.Helper()
		builder := db.Client.SocialSet.Create().SetID(cuid.New()).SetOrganizationID(org).SetName("Original target").SetPublicSlug(cuid.New())
		if private {
			builder.SetVisibility(socialset.VisibilityPRIVATE).SetOwnerUserID(user)
		}
		set, err := builder.Save(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return set
	}
	begin := func(set *ent.SocialSet, expected *string) string {
		t.Helper()
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, org)
		state := cuid.New()
		if err := repo.StartOAuth(ctx, actor, sessionID, state, "x", "SOCIAL_OAUTH_FIXTURE", OAuthStartOptions{SocialSetID: &set.ID, ExpectedConnectionID: expected, ReturnPath: "/settings/publishing-brands/" + set.ID}); err != nil {
			t.Fatal(err)
		}
		return state
	}
	exchange := func(state, external string) {
		t.Helper()
		if receipt, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "x"); err != nil || receipt != nil {
			t.Fatalf("claim=%+v %v", receipt, err)
		}
		if err := repo.SaveOAuthExchange(ctx, actor, sessionID, state, "x", schema.SocialOAuthExchange{ID: external}); !errors.Is(err, ErrConflict) {
			t.Fatal("unverified X receipt accepted")
		}
		if err := repo.SaveOAuthExchange(ctx, actor, sessionID, state, "x", verifiedXReceipt(external)); err != nil {
			t.Fatal(err)
		}
	}
	finish := func(state, external string) (*ent.ChannelConnection, error) {
		return repo.FinishOAuth(ctx, actor, sessionID, state, "x", external)
	}
	beginCreation := func(visibility string) string {
		t.Helper()
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, org)
		state := cuid.New()
		if err := repo.StartOAuth(ctx, actor, sessionID, state, "x", "SOCIAL_OAUTH_FIXTURE", OAuthStartOptions{
			Operation: "CREATE_SET", CreationVisibility: visibility,
		}); err != nil {
			t.Fatal(err)
		}
		return state
	}
	setCount := func() int {
		t.Helper()
		count, err := db.Client.SocialSet.Query().Where(socialset.OrganizationID(org)).Count(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return count
	}

	t.Run("first connection creates one private set only at commitment", func(t *testing.T) {
		before := setCount()
		state := beginCreation("PRIVATE")
		external := "external-" + state
		exchange(state, external)
		if setCount() != before {
			t.Fatal("starting or exchanging created an empty set")
		}
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, other)
		results := make(chan *ent.ChannelConnection, 8)
		failures := make(chan error, 8)
		var wait sync.WaitGroup
		for range 8 {
			wait.Add(1)
			go func() {
				defer wait.Done()
				connection, err := finish(state, external)
				if err != nil {
					failures <- err
				} else {
					results <- connection
				}
			}()
		}
		wait.Wait()
		close(results)
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		var createdID string
		for connection := range results {
			if connection.OrganizationID != org || connection.SocialSetID == nil {
				t.Fatalf("connection lost the original ownership context: %+v", connection)
			}
			if createdID != "" && createdID != *connection.SocialSetID {
				t.Fatal("callback replay created another set")
			}
			createdID = *connection.SocialSetID
		}
		if setCount() != before+1 {
			t.Fatal("expected one new set")
		}
		created, err := db.Client.SocialSet.Get(ctx, createdID)
		if err != nil || created.Visibility != socialset.VisibilityPRIVATE || created.OwnerUserID == nil || *created.OwnerUserID != user ||
			len(created.PostingSlots) != 5 || len(created.DefaultPlatforms) != 1 || created.DefaultPlatforms[0] != "x" ||
			created.PrimaryPlatform == nil || *created.PrimaryPlatform != "x" || created.PublicProfile {
			t.Fatalf("invalid new publishing identity: %+v %v", created, err)
		}
		var audits int
		if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM audit_log WHERE "entityId"=$1 AND action='product.social_set_created'`, createdID).Scan(&audits); err != nil || audits != 1 {
			t.Fatalf("creation audits=%d %v", audits, err)
		}
		target, err := repo.ResolveOAuthContext(ctx, user, sessionID, state, "x")
		if err != nil || target.OrganizationID != org || target.SocialSetID == nil || *target.SocialSetID != createdID ||
			target.Operation != "CREATE_SET" || !target.Completed || target.ReturnPath != "/settings/publishing-brands/"+createdID {
			t.Fatalf("wrong creation receipt: %+v %v", target, err)
		}
		duplicate := beginCreation("WORKSPACE")
		exchange(duplicate, external)
		if _, err := finish(duplicate, external); !errors.Is(err, ErrAccountInAnotherSet) {
			t.Fatalf("already linked account created another set: %v", err)
		}
		if setCount() != before+1 {
			t.Fatal("duplicate identity left an empty set")
		}
	})
	t.Run("cancelled and expired first connections leave no set", func(t *testing.T) {
		before := setCount()
		state := beginCreation("WORKSPACE")
		if setCount() != before {
			t.Fatal("abandoned authorization created a set")
		}
		exec(`UPDATE social_oauth_start SET "expiresAt"=now()-interval '1 minute' WHERE state=$1`, state)
		if _, err := finish(state, "not-verified"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired first connection completed: %v", err)
		}
		if setCount() != before {
			t.Fatal("expired authorization created a set")
		}
	})
	t.Run("first connection rechecks membership and subscription before creating anything", func(t *testing.T) {
		before := setCount()
		state := beginCreation("WORKSPACE")
		external := "external-" + state
		exchange(state, external)
		exec(`UPDATE member SET role='publisher' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
		if _, err := finish(state, external); !errors.Is(err, ErrForbidden) {
			t.Fatalf("non-admin created a set: %v", err)
		}
		exec(`UPDATE member SET role='admin' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
		exec(`UPDATE workspace_entitlement SET status='suspended' WHERE "organizationId"=$1`, org)
		if _, err := finish(state, external); err == nil {
			t.Fatal("suspended plan created a set")
		}
		if setCount() != before {
			t.Fatal("failed commitment left an empty set")
		}
		exec(`UPDATE workspace_entitlement SET status='active' WHERE "organizationId"=$1`, org)
		connection, err := finish(state, external)
		if err != nil || connection.SocialSetID == nil || setCount() != before+1 {
			t.Fatalf("restored subscription could not recover the saved exchange: %+v %v", connection, err)
		}
		created, err := db.Client.SocialSet.Get(ctx, *connection.SocialSetID)
		if err != nil || created.Visibility != socialset.VisibilityWORKSPACE {
			t.Fatalf("lost explicit workspace ownership: %+v %v", created, err)
		}
	})

	t.Run("workspace switches and duplicate completions preserve one original connection", func(t *testing.T) {
		set := makeSet(true)
		state := begin(set, nil)
		external := "external-" + state
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, other)
		target, err := repo.ResolveOAuthContext(ctx, user, sessionID, state, "x")
		if err != nil || target.Completed || target.OrganizationID != org || target.SocialSetID == nil || *target.SocialSetID != set.ID || target.ReturnPath != "/settings/publishing-brands/"+set.ID {
			t.Fatalf("target=%+v %v", target, err)
		}
		if _, err := repo.ResolveOAuthContext(ctx, "another-user", sessionID, state, "x"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("another user resolves target: %v", err)
		}
		wrong := actor
		wrong.Organization = other
		if _, err := repo.OAuthStart(ctx, wrong, sessionID, state, "x", nil); !errors.Is(err, ErrNotFound) {
			t.Fatalf("other workspace read attempt: %v", err)
		}
		exchange(state, external)
		results := make(chan *ent.ChannelConnection, 8)
		failures := make(chan error, 8)
		var wait sync.WaitGroup
		for range 8 {
			wait.Add(1)
			go func() {
				defer wait.Done()
				connection, err := finish(state, external)
				if err != nil {
					failures <- err
				} else {
					results <- connection
				}
			}()
		}
		wait.Wait()
		close(results)
		close(failures)
		for err := range failures {
			t.Fatal(err)
		}
		var connectionID string
		for connection := range results {
			if connection.OrganizationID != org || connection.SocialSetID == nil || *connection.SocialSetID != set.ID {
				t.Fatalf("changed target: %+v", connection)
			}
			if connectionID != "" && connectionID != connection.ID {
				t.Fatal("duplicate connection")
			}
			connectionID = connection.ID
		}
		var audits int
		if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM audit_log WHERE "organizationId"=$1 AND "entityId"=$2 AND action='post.connection_created'`, org, connectionID).Scan(&audits); err != nil || audits != 1 {
			t.Fatalf("duplicate audit count=%d %v", audits, err)
		}
		exec(`UPDATE social_oauth_start SET "expiresAt"=now()-interval '1 hour' WHERE state=$1`, state)
		receipt, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "x")
		if err != nil || receipt == nil || !receipt.Completed || receipt.ID != external {
			t.Fatalf("completed replay=%+v %v", receipt, err)
		}
		if _, err := finish(state, "another-account"); !errors.Is(err, ErrConflict) {
			t.Fatalf("changed callback account: %v", err)
		}
		if err := db.Client.ChannelConnection.UpdateOneID(connectionID).SetStatus(channelconnection.StatusDISABLED).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := finish(state, external); !errors.Is(err, ErrConflict) {
			t.Fatalf("replay restored removed account: %v", err)
		}
	})
	t.Run("uncertain exchanges cannot consume a code twice", func(t *testing.T) {
		state := begin(makeSet(false), nil)
		if _, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "x"); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "x"); !errors.Is(err, ErrOAuthExchangeUncertain) {
			t.Fatalf("second exchange=%v", err)
		}
		if _, err := finish(state, "not-verified"); !errors.Is(err, ErrConflict) {
			t.Fatalf("unverified completion=%v", err)
		}
	})
	t.Run("reconnect checks the existing account before any product mutation", func(t *testing.T) {
		set := makeSet(false)
		state := begin(set, nil)
		external := "external-" + state
		exchange(state, external)
		connection, err := finish(state, external)
		if err != nil {
			t.Fatal(err)
		}
		reconnect := begin(set, &connection.ID)
		if _, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, reconnect, "x"); err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveOAuthExchange(ctx, actor, sessionID, reconnect, "x", verifiedXReceipt("wrong-account")); !errors.Is(err, ErrOAuthIdentityMismatch) {
			t.Fatalf("wrong reconnect identity=%v", err)
		}
		current, err := db.Client.ChannelConnection.Get(ctx, connection.ID)
		if err != nil || current.ExternalAccountID != external || current.SocialSetID == nil || *current.SocialSetID != set.ID {
			t.Fatalf("reconnect changed original: %+v %v", current, err)
		}
		reconnect = begin(set, &connection.ID)
		exchange(reconnect, external)
		restored, err := finish(reconnect, external)
		if err != nil || restored.ID != connection.ID {
			t.Fatalf("same identity reconnect=%+v %v", restored, err)
		}
	})
	t.Run("expired attempts create nothing", func(t *testing.T) {
		set := makeSet(false)
		state := begin(set, nil)
		exec(`UPDATE social_oauth_start SET "expiresAt"=now()-interval '1 minute' WHERE state=$1`, state)
		if _, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "x"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("expired claim=%v", err)
		}
		count, err := db.Client.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID)).Count(ctx)
		if err != nil || count != 0 {
			t.Fatalf("expired connection count=%d %v", count, err)
		}
	})
	t.Run("membership and target visibility are rechecked at commitment", func(t *testing.T) {
		set := makeSet(true)
		state := begin(set, nil)
		external := "external-" + state
		exchange(state, external)
		exec(`UPDATE member SET role='viewer' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
		if _, err := finish(state, external); !errors.Is(err, ErrForbidden) {
			t.Fatalf("downgraded member completed: %v", err)
		}
		exec(`UPDATE member SET role='admin' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
		if err := db.Client.SocialSet.UpdateOneID(set.ID).SetOwnerUserID("other-" + user).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := finish(state, external); !errors.Is(err, ErrNotFound) {
			t.Fatalf("lost private ownership completed: %v", err)
		}
		if err := db.Client.SocialSet.UpdateOneID(set.ID).SetOwnerUserID(user).SetDeletedAt(time.Now()).Exec(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := finish(state, external); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted target completed: %v", err)
		}
		start, err := db.Client.SocialOAuthStart.Get(ctx, state)
		if err != nil || start.ExchangeStatus != socialoauthstart.ExchangeStatusEXCHANGED {
			t.Fatalf("failed commitment consumed receipt: %+v %v", start, err)
		}
	})
	t.Run("Bluesky proof and profile commit with the original private set", func(t *testing.T) {
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, org)
		state, external := cuid.New(), cuid.New()
		opts := OAuthStartOptions{Operation: "CREATE_SET", CreationVisibility: "PRIVATE"}
		if _, err := repo.PrepareOAuth(ctx, actor, sessionID, "bluesky", opts); err != nil {
			t.Fatal(err)
		}
		if err := repo.StartOAuth(ctx, actor, sessionID, state, "bluesky", "SOCIAL_OAUTH_FIXTURE", opts); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ClaimOAuthExchange(ctx, actor, sessionID, state, "bluesky"); err != nil {
			t.Fatal(err)
		}
		if err := repo.SaveOAuthExchange(ctx, actor, sessionID, state, "bluesky", schema.SocialOAuthExchange{ID: external}); !errors.Is(err, ErrConflict) {
			t.Fatal("unverified Bluesky receipt accepted")
		}
		did, now := "did:plc:abcdefghijklmnopqrstuvwx", time.Now()
		account := &socialidentity.Connection{ID: external, Provider: "bluesky", NativeID: did, Name: "Verified profile", Handle: "me.bsky.social", Active: true, VerifiedAt: &now,
			Verification: &socialidentity.Verification{AccountKey: "bluesky:" + did, AccountKind: "profile", GrantedScopes: []string{"com.atproto.appPass"}, Capabilities: socialidentity.Capabilities{Version: 1, Bluesky: &socialidentity.BlueskyCapabilities{MaxTextGraphemes: 300, MaxTextBytes: 3000, MaxImages: 4, ImageMaxBytes: 2000000, MaxVideos: 1, VideoMaxBytes: 300000000}}}}
		if err := repo.SaveOAuthExchange(ctx, actor, sessionID, state, "bluesky", schema.SocialOAuthExchange{ID: external, Account: account}); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, other)
		connection, err := repo.FinishOAuth(ctx, actor, sessionID, state, "bluesky", external)
		if err != nil || connection.OrganizationID != org || connection.SocialSetID == nil || connection.DisplayName == nil || *connection.DisplayName != account.Name || connection.Handle == nil || *connection.Handle != account.Handle {
			t.Fatalf("verified profile did not commit: %v", err)
		}
		stored := db.Client.SocialOAuthStart.GetX(ctx, state)
		if stored.ExchangeReceipt.Account == nil || stored.ExchangeReceipt.Account.NativeID != did || stored.ExchangeReceipt.Account.Verification.AccountKey != "bluesky:"+did {
			t.Fatal("native identity proof was not retained in durable receipt")
		}
		replayed, err := repo.FinishOAuth(ctx, actor, sessionID, state, "bluesky", external)
		if err != nil || replayed.ID != connection.ID {
			t.Fatal("Bluesky completion replay duplicated identity")
		}
		exec(`UPDATE session SET "activeOrganizationId"=$2 WHERE id=$1`, sessionID, org)
		reconnect := OAuthStartOptions{Operation: "RECONNECT", SocialSetID: connection.SocialSetID, ExpectedConnectionID: &connection.ID}
		if original, err := repo.PrepareOAuth(ctx, actor, sessionID, "bluesky", reconnect); err != nil || original != external {
			t.Fatal("reconnect preparation lost adapter identity")
		}
		if _, err := repo.PrepareOAuth(ctx, actor, sessionID, "x", reconnect); !errors.Is(err, ErrConflict) {
			t.Fatal("reconnect accepted another provider")
		}
		exec(`UPDATE member SET role='viewer' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
		if _, err := repo.PrepareOAuth(ctx, actor, sessionID, "bluesky", reconnect); !errors.Is(err, ErrForbidden) {
			t.Fatal("revoked authority prepared reconnect")
		}
		exec(`UPDATE member SET role='admin' WHERE "organizationId"=$1 AND "userId"=$2`, org, user)
	})

}
