package tenantpublishing

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	productent "github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/x"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/lucsky/cuid"
)

// A token the provider refuses at publish time, or one that lapsed with
// nothing to renew it, fails the post as ACCOUNT_RECONNECT and flags the
// channel, so the workspace gets integration.reconnect_required. A lapsed
// token with a refresh token stays the maintenance refresh's to renew.
func TestRefusedOrLapsedCredentialsAskTheWorkspaceToReconnect(t *testing.T) {
	databaseURL := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	if os.Getenv("PLATFORM_SOCIAL_ENCRYPTION_KEY") == "" {
		t.Setenv("PLATFORM_SOCIAL_ENCRYPTION_KEY", "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=")
	}
	ctx := context.Background()
	db, err := socialdatabase.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	productOrg, boundOrg := "product_"+id, "social_"+id
	for _, fixture := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Product test',$1,now())`, []any{productOrg}},
		{`INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Social test',now())`, []any{boundOrg}},
		{`INSERT INTO social_tenant_binding ("organizationId","goOrganizationId","secretReference","createdAt") VALUES ($1,$2,'SOCIAL_API_KEY',now())`, []any{productOrg, boundOrg}},
	} {
		if _, err := db.SQL.ExecContext(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM outbox_event WHERE "organizationId"=$1`, productOrg)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Integration" WHERE "organizationId"=$1`, boundOrg)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM social_tenant_binding WHERE "organizationId"=$1`, productOrg)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Organization" WHERE id=$1`, boundOrg)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, productOrg)
	})
	reconnectEvents := func() int {
		t.Helper()
		var count int
		if err := db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM outbox_event WHERE "organizationId"=$1 AND type='activity.integration.reconnect_required'`,
			productOrg).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	for _, tc := range []struct {
		name         string
		expiresIn    time.Duration
		refreshToken *string
		providerErr  error
		// appCheck, when set, makes the provider sign with Shots' app keys (as
		// X does) and answers the check of those keys.
		appCheck      func() error
		reconnected   bool
		wantFlag      bool
		wantProvider  int
		wantNewEvents int
	}{
		{"the provider refuses the token", time.Hour, nil, temporalx.RefreshToken("linkedin", "{}", "{}", "revoked"), nil, false, true, 1, 1},
		{"the provider disconnects the account", time.Hour, nil, temporalx.Disconnect("linkedin", "{}", "{}", "gone"), nil, false, true, 1, 1},
		{"a reconnect after the read wins", time.Hour, nil, temporalx.RefreshToken("linkedin", "{}", "{}", "revoked"), nil, true, false, 1, 0},
		{"a refused token the refresh can still renew", time.Hour, new("refresh"), temporalx.RefreshToken("linkedin", "{}", "{}", "expired"), nil, false, false, 1, 0},
		{"the token lapsed with nothing to renew it", -time.Minute, nil, nil, nil, false, true, 0, 1},
		{"the token lapsed but can be renewed", -time.Minute, new("refresh"), nil, nil, false, false, 0, 0},
		{"X refuses the account while the app keys are good", time.Hour, nil, temporalx.RefreshToken("x", "{}", "{}", "revoked"), appKeys(nil), false, true, 1, 1},
		// Bad app keys fail every X account the same way; none is the account's to fix.
		{"X refuses the app keys", time.Hour, nil, temporalx.RefreshToken("x", "{}", "{}", "unauthorized"), appKeys(integrations.ErrAppCredentialsRefused), false, false, 1, 0},
		// A check that cannot run proves nothing either way: no flag, and the post retries.
		{"the app keys cannot be checked", time.Hour, nil, temporalx.RefreshToken("x", "{}", "{}", "unauthorized"), appKeys(errors.New("token endpoint timed out")), false, false, 1, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native := "remote-" + cuid.New()
			channel := db.Client.Integration.Create().SetOrganizationID(boundOrg).SetName(tc.name).SetType("social").
				SetProviderIdentifier("linkedin").SetInternalID(native).SetToken("private-token").
				SetRefreshToken(tc.refreshToken).SetTokenExpiration(time.Now().Add(tc.expiresIn)).SaveX(ctx)
			fake := &fakePoster{err: tc.providerErr, expectedNativeID: native}
			var provider poster = fake
			if tc.appCheck != nil {
				provider = appSigningPoster{fakePoster: fake, check: tc.appCheck}
			}
			lookup := &reconnectingLookup{EntIntegrationLookup: EntIntegrationLookup{Client: db.Client}}
			if tc.reconnected {
				// A person reconnects between the publisher's last read and the refusal.
				lookup.afterSecond = func() { db.Client.Integration.UpdateOneID(channel.ID).SetToken("reconnected").ExecX(ctx) }
			}
			p := &Publisher{
				bindings:     fakeBindings{&productent.SocialTenantBinding{GoOrganizationID: boundOrg, SecretReference: "SOCIAL_API_KEY"}},
				integrations: lookup, signer: &fakeSigner{},
				resolve: func(string) poster { return provider }, channels: db.Client, now: time.Now,
				refresh: newRefresh(db.Client, social.NewManager()),
			}
			before := reconnectEvents()
			_, err := p.PublishThread(ctx, socialapi.PublishInput{
				OrganizationID: productOrg, DestinationID: channel.ID, Platform: "linkedin", PostID: "canonical-post-1",
				SecretReference: "SOCIAL_API_KEY", Caption: "Canary",
			})
			want, status := publishing.FailureAccountReconnect, http.StatusConflict
			if tc.appCheck != nil && tc.appCheck() != nil {
				// Refused keys fail definitely; an unchecked refusal retries (429).
				want, status = publishing.FailurePublisherUnavailable, http.StatusServiceUnavailable
				if !errors.Is(tc.appCheck(), integrations.ErrAppCredentialsRefused) {
					status = http.StatusTooManyRequests
				}
			}
			var refused *socialapi.Error
			if !errors.As(err, &refused) || refused.Code != want || refused.Status != status || refused.UnknownDelivery {
				t.Fatalf("err=%#v, want %s %d", err, want, status)
			}
			// The saved message says no account is at fault, and keeps the platform's own words for support.
			if want == publishing.FailurePublisherUnavailable &&
				(!strings.Contains(refused.ProviderMessage, "unauthorized") || strings.Contains(refused.ProviderMessage, "Reconnect")) {
				t.Fatalf("provider message=%q", refused.ProviderMessage)
			}
			flagged := db.Client.Integration.GetX(ctx, channel.ID).RefreshNeeded
			if flagged != tc.wantFlag || fake.calls != tc.wantProvider || reconnectEvents()-before != tc.wantNewEvents {
				t.Fatalf("flagged=%v provider calls=%d events=%d", flagged, fake.calls, reconnectEvents()-before)
			}
		})
	}
}

// appSigningPoster is a provider that signs with Shots' app keys too, as X does.
type appSigningPoster struct {
	*fakePoster
	check func() error
}

func (p appSigningPoster) VerifyAppCredentials(context.Context) error { return p.check() }

// appKeys answers an app-key check with err (nil: the keys are good).
func appKeys(err error) func() error { return func() error { return err } }

// X is such a provider, so its refused tokens are checked against the app keys.
var _ appVerifier = x.New()

// reconnectingLookup runs afterSecond once the publisher has re-read the
// account just before its handoff to the provider.
type reconnectingLookup struct {
	EntIntegrationLookup
	calls       int
	afterSecond func()
}

func (l *reconnectingLookup) FindIntegration(ctx context.Context, orgID, destinationID, platform string) (*socialent.Integration, error) {
	item, err := l.EntIntegrationLookup.FindIntegration(ctx, orgID, destinationID, platform)
	if l.calls++; l.calls == 2 && l.afterSecond != nil {
		l.afterSecond()
	}
	return item, err
}
