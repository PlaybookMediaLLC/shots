package product

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceplan"
	"github.com/lucsky/cuid"
)

func TestSocialCapacityCommitsUnderWorkspaceLock(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo := w.ctx, w.repo.auth
	subscribe(t, ctx, w.repo, w.org, "pro")
	actor := publishing.Actor{Organization: w.org, UserID: w.owner.UserID, Type: "USER", RequestID: w.id}
	makeSet := func() string {
		t.Helper()
		set, err := w.repo.CreateSocialSet(ctx, w.owner, SocialSetInput{Name: "Capacity fixture"})
		if err != nil {
			t.Fatal(err)
		}
		return set.ID
	}
	prepare := func(external, set string, expected *string) string {
		t.Helper()
		state := cuid.New()
		if err := repo.StartOAuth(ctx, actor, w.owner.SessionID, state, "x", "SOCIAL_API_KEY", publishing.OAuthStartOptions{SocialSetID: &set, ExpectedConnectionID: expected}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ClaimOAuthExchange(ctx, actor, w.owner.SessionID, state, "x"); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		caps := socialidentity.XStandardPostLimits("read-write", nil)
		account := &socialidentity.Connection{ID: external, Provider: "x", NativeID: "123456789", Active: true, VerifiedAt: &now,
			Verification: &socialidentity.Verification{AccountKey: "x:123456789", AccountKind: "profile", GrantedScopes: []string{"read-write"}, Capabilities: socialidentity.Capabilities{Version: 1, X: &caps}}}
		if err := repo.SaveOAuthExchange(ctx, actor, w.owner.SessionID, state, "x", schema.SocialOAuthExchange{ID: external, Account: account}); err != nil {
			t.Fatal(err)
		}
		return state
	}
	create := func(external, set string) (*ent.ChannelConnection, error) {
		return repo.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: external, Platform: "x", SecretReference: "SOCIAL_API_KEY", ProviderSettings: map[string]any{}, SocialSetID: &set})
	}
	baseSet := makeSet()
	base, err := create("base-"+w.id, baseSet)
	if err != nil {
		t.Fatal(err)
	}
	for range proChannels - 2 {
		if _, err := create(cuid.New(), makeSet()); err != nil {
			t.Fatal(err)
		}
	}

	// Both OAuth and direct connection writers compete for the last slot.
	type candidate struct{ external, set, state string }
	candidates := make([]candidate, 10)
	for i := range candidates {
		candidates[i] = candidate{external: cuid.New(), set: makeSet()}
		if i%2 == 0 {
			candidates[i].state = prepare(candidates[i].external, candidates[i].set, nil)
		}
	}
	start := make(chan struct{})
	results := make(chan error, len(candidates))
	var wg sync.WaitGroup
	for _, item := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			var err error
			if item.state == "" {
				_, err = create(item.external, item.set)
			} else {
				_, err = repo.FinishOAuth(ctx, actor, w.owner.SessionID, item.state, "x", item.external)
			}
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	succeeded, rejected := 0, 0
	for err := range results {
		var limit *PlanLimitError
		if err == nil {
			succeeded++
		} else if errors.As(err, &limit) && limit.Limit == proChannels {
			rejected++
		} else {
			t.Fatalf("unexpected connection result: %v", err)
		}
	}
	if succeeded != 1 || rejected != 9 {
		t.Fatalf("last-slot race: succeeded=%d rejected=%d", succeeded, rejected)
	}
	if count, err := w.db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(w.org), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx); err != nil || count != proChannels {
		t.Fatalf("active connections=%d %v", count, err)
	}
	if count, err := w.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(w.org), auditlog.Action("post.connection_created")).Count(ctx); err != nil || count != proChannels {
		t.Fatalf("connection audit count=%d %v", count, err)
	}
	for _, item := range candidates {
		if item.state == "" {
			continue
		}
		attempt, err := w.db.Client.SocialOAuthStart.Get(ctx, item.state)
		if err != nil {
			t.Fatal(err)
		}
		count, err := w.db.Client.ChannelConnection.Query().Where(channelconnection.OrganizationID(w.org), channelconnection.ExternalAccountID(item.external)).Count(ctx)
		if err != nil || (count == 0 && attempt.ExchangeStatus != socialoauthstart.ExchangeStatusEXCHANGED) {
			t.Fatalf("failed commitment consumed OAuth receipt: %+v %v", attempt, err)
		}
	}

	// A removed account has to obtain capacity again, even if its identity is known.
	if err := w.db.Client.ChannelConnection.UpdateOneID(base.ID).SetStatus(channelconnection.StatusDISABLED).Exec(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := create("replacement-"+w.id, makeSet()); err != nil {
		t.Fatal(err)
	}
	state := prepare(base.ExternalAccountID, baseSet, &base.ID)
	var atLimit *PlanLimitError
	if err := w.repo.RequireChannel(ctx, w.org, base.ExternalAccountID); !errors.As(err, &atLimit) {
		t.Fatalf("removed account bypassed preflight: %v", err)
	}
	if _, err := repo.FinishOAuth(ctx, actor, w.owner.SessionID, state, "x", base.ExternalAccountID); !errors.As(err, &atLimit) {
		t.Fatalf("restoration bypassed capacity: %v", err)
	}
	unchanged, err := w.db.Client.ChannelConnection.Get(ctx, base.ID)
	if err != nil || unchanged.Status != channelconnection.StatusDISABLED {
		t.Fatalf("failed restore changed account: %+v %v", unchanged, err)
	}

	// Billing and connection writes use the same lock. A callback waiting on a
	// suspension must see that suspension before it commits its connection.
	if err := w.db.Client.ChannelConnection.UpdateOneID(base.ID).SetStatus(channelconnection.StatusACTIVE).Exec(ctx); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.RequireChannel(ctx, w.org, base.ExternalAccountID); err != nil {
		t.Fatalf("already-active account cannot reconnect above a downgraded plan's limit: %v", err)
	}
	tx, err := w.db.Client.Tx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := workspaceplan.LockWorkspace(ctx, tx, w.org); err != nil {
		t.Fatal(err)
	}
	if err := tx.WorkspaceEntitlement.UpdateOneID(w.org).SetStatus("suspended").Exec(ctx); err != nil {
		t.Fatal(err)
	}
	waiting := make(chan error, 1)
	go func() {
		_, err := repo.FinishOAuth(ctx, actor, w.owner.SessionID, state, "x", base.ExternalAccountID)
		waiting <- err
	}()
	blockedCtx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := w.repo.SyncWorkspaceEntitlement(blockedCtx, EntitlementSyncInput{EventID: "blocked-" + w.id, EventType: "test.billing", ExpectedVersion: 1, OrganizationID: w.org, Plan: "enterprise", Status: "active", Provider: "test"}); err == nil {
		t.Fatal("billing update escaped workspace lock")
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-waiting; !errors.As(err, &atLimit) || !atLimit.Inactive {
		t.Fatalf("callback ignored committed suspension: %v", err)
	}
}

func TestSocialCapacityDoesNotReuseAnotherProvidersSlot(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	external := "same-id-" + w.id
	for i := range proChannels {
		id := cuid.New()
		if i == 0 {
			id = external
		}
		if err := w.db.Client.ChannelConnection.Create().SetID(cuid.New()).SetOrganizationID(w.org).
			SetProvider("other-provider").SetExternalAccountID(id).SetPlatform("x").
			SetSecretReference("SOCIAL_API_KEY").SetCreatedByUserID(w.owner.UserID).Exec(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	actor := publishing.Actor{Organization: w.org, UserID: w.owner.UserID, Type: "USER", RequestID: w.id}
	_, err := w.repo.auth.CreateConnection(w.ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: external, Platform: "x", SecretReference: "SOCIAL_API_KEY", ProviderSettings: map[string]any{}})
	var limit *PlanLimitError
	if !errors.As(err, &limit) {
		t.Fatalf("another provider's identifier bypassed capacity: %v", err)
	}
}

func TestChannelCapacityCountsActiveAccountsAgainstThePlan(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner

	// Without a subscription a workspace connects nothing.
	capacity, err := repo.GetChannelCapacity(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Held != 0 || capacity.Limit == nil || *capacity.Limit != 0 {
		t.Fatalf("free capacity: %+v", capacity)
	}

	subscribe(t, ctx, repo, w.org, "pro")
	connect := func(id, status string) {
		t.Helper()
		w.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,status)
			VALUES($1,$2,'social',$1,'test-only',$3,now(),'x',$4)`, id+w.id, w.org, owner.UserID, status)
	}
	connect("active", "ACTIVE")
	connect("second", "ACTIVE")
	connect("removed", "DISABLED")
	capacity, err = repo.GetChannelCapacity(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Held != 2 || capacity.Limit == nil || *capacity.Limit != 15 {
		t.Fatalf("pro capacity counts active accounts only: %+v", capacity)
	}

	if err := w.db.Client.WorkspaceEntitlement.UpdateOneID(w.org).SetPlan("enterprise").Exec(ctx); err != nil {
		t.Fatal(err)
	}
	capacity, err = repo.GetChannelCapacity(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if capacity.Held != 2 || capacity.Limit != nil {
		t.Fatalf("enterprise capacity: %+v", capacity)
	}
}
