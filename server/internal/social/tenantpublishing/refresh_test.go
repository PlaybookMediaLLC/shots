package tenantpublishing

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social"
	"github.com/lucsky/cuid"
)

// fakeThreads is the Threads adapter with a scripted token endpoint.
type fakeThreads struct {
	integrations.Provider
	calls map[string]int
}

func (f *fakeThreads) RefreshToken(_ context.Context, refreshToken string) (*integrations.AuthTokenDetails, error) {
	f.calls[refreshToken]++
	if refreshToken == "revoked" {
		return nil, errors.New("grant revoked")
	}
	return &integrations.AuthTokenDetails{AccessToken: "renewed-" + refreshToken, RefreshToken: refreshToken, ExpiresIn: 60 * 24 * 3600}, nil
}

func TestRefreshSocialTokensRenewsDueChannelsAndFlagsRevokedOnes(t *testing.T) {
	for _, provider := range []string{"threads", "linkedin-page", "youtube", "tiktok"} {
		t.Run(provider, func(t *testing.T) {
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
			productOrg, boundOrg, unboundOrg := "product_"+id, "social_"+id, "unbound_"+id
			for _, fixture := range []struct {
				query string
				args  []any
			}{
				{`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Product test',$2,now())`, []any{productOrg, id}},
				{`INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Social test',now()),($2,'Unbound test',now())`, []any{boundOrg, unboundOrg}},
				{`INSERT INTO social_tenant_binding ("organizationId","goOrganizationId","secretReference","createdAt") VALUES ($1,$2,'SOCIAL_API_KEY_TEST',now())`, []any{productOrg, boundOrg}},
			} {
				if _, err := db.SQL.ExecContext(ctx, fixture.query, fixture.args...); err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(func() {
				_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Integration" WHERE "organizationId" IN ($1,$2)`, boundOrg, unboundOrg)
				_, _ = db.SQL.ExecContext(ctx, `DELETE FROM social_tenant_binding WHERE "organizationId"=$1`, productOrg)
				_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "Organization" WHERE id IN ($1,$2)`, boundOrg, unboundOrg)
				_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, productOrg)
			})
			now := time.Now()
			channel := func(org, refresh string, expires time.Duration) string {
				return db.Client.Integration.Create().SetOrganizationID(org).SetName(refresh).SetType("social").
					SetProviderIdentifier(provider).SetInternalID(refresh + id).SetToken("old").SetRefreshToken(&refresh).
					SetTokenExpiration(now.Add(expires)).SaveX(ctx).ID
			}
			// The revoked channel expires first, so its failure precedes the due one.
			revoked := channel(boundOrg, "revoked", time.Minute)
			due := channel(boundOrg, "due", 10*time.Minute)
			later := channel(boundOrg, "later", 30*24*time.Hour)
			unbound := channel(unboundOrg, "unbound", 10*time.Minute)

			fake := &fakeThreads{Provider: social.NewManager().GetSocialIntegration(provider), calls: map[string]int{}}
			p := &Publisher{channels: db.Client, refresh: newRefresh(db.Client, integrations.NewManager([]integrations.Provider{fake})), now: time.Now}
			renewed, err := p.RefreshSocialTokens(ctx)
			if err != nil || renewed < 1 {
				t.Fatalf("renewed=%d err=%v", renewed, err)
			}

			rows := map[string]bool{}
			for _, row := range db.Client.Integration.Query().Where(integration.IDIn(revoked, due, later, unbound)).AllX(ctx) {
				rows[row.ID] = true
				switch row.ID {
				case revoked:
					if !row.RefreshNeeded || row.Token != "old" {
						t.Fatal("revoked channel was not flagged for reconnect")
					}
				case due:
					if row.Token != "renewed-due" || row.RefreshNeeded || row.TokenExpiration == nil || row.TokenExpiration.Before(now.Add(50*24*time.Hour)) {
						t.Fatal("due channel was not renewed after an earlier failure")
					}
				default:
					if row.Token != "old" || row.RefreshNeeded {
						t.Fatal("channel outside the window or workspace changed")
					}
				}
			}
			if len(rows) != 4 || fake.calls["revoked"] != 1 || fake.calls["due"] != 1 || fake.calls["later"] != 0 || fake.calls["unbound"] != 0 {
				t.Fatalf("rows=%d calls=%v", len(rows), fake.calls)
			}

		})
	}
}
