package product

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

// Share links: only live links resolve, by token, and only within their
// workspace can they be changed. Integrations never list their credentials.
func TestShareLinksAndIntegrations(t *testing.T) {
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
	for _, organization := range []string{org, other} {
		if _, err := db.SQL.ExecContext(ctx, `INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		for _, table := range []string{"share_link", "integration_connection", "asset"} {
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM `+table+` WHERE "organizationId"=$1 OR "organizationId"=$2`, org, other)
		}
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, org, other)
	})
	addAsset := func(organization, mediaType string, status string) string {
		assetID := uuid.NewString()
		if _, err := db.Client.Asset.Create().SetID(assetID).SetOrganizationID(organization).
			SetObjectKey("tests/" + assetID).SetMediaType(mediaType).SetBytes(10).
			SetStatus(asset.Status(status)).Save(ctx); err != nil {
			t.Fatal(err)
		}
		return assetID
	}
	image := addAsset(org, "image/png", "UPLOADED")
	video := addAsset(org, "video/mp4", "UPLOADED")
	pending := addAsset(org, "image/png", "PENDING")
	foreign := addAsset(other, "image/png", "UPLOADED")

	repo := NewConfiguration(db.Client)
	actor := Actor{OrganizationID: org, Kind: "service"}
	stranger := Actor{OrganizationID: other, Kind: "service"}

	link, err := repo.CreateShareLink(ctx, actor, ShareLinkInput{AssetID: video, PosterAssetID: &image, Title: "  Launch  ", Access: "PUBLIC"})
	if err != nil || link.Title != "Launch" || len(link.Token) < 30 || link.MediaType != "video/mp4" {
		t.Fatalf("link=%+v err=%v", link, err)
	}
	resolved, err := repo.ResolveShareLink(ctx, link.Token)
	if err != nil || resolved.OrganizationID != org || resolved.PosterMediaType == nil || *resolved.PosterMediaType != "image/png" {
		t.Fatalf("resolved=%+v err=%v", resolved, err)
	}

	// A code embed keeps a frozen Code Studio document and resolves with it.
	embed, err := repo.CreateShareLink(ctx, actor, ShareLinkInput{AssetID: image, Title: "Snippet", Access: "PUBLIC", Code: codeFixture("const a = 1")})
	if err != nil {
		t.Fatal(err)
	}
	if resolved, err := repo.ResolveShareLink(ctx, embed.Token); err != nil || resolved.Code["kind"] != "code" {
		t.Fatalf("code embed=%+v err=%v", resolved, err)
	}
	if resolved, err := repo.ResolveShareLink(ctx, link.Token); err != nil || resolved.Code != nil {
		t.Fatalf("an image link carried code: %+v %v", resolved, err)
	}
	withLogo := codeFixture("x")
	withLogo["style"].(map[string]any)["footer"] = map[string]any{"logo": "asset:" + image}
	for name, input := range map[string]ShareLinkInput{
		"code with a private logo": {AssetID: image, Title: "x", Access: "PUBLIC", Code: withLogo},
		"a canvas as code":         {AssetID: image, Title: "x", Access: "PUBLIC", Code: canvasFixture()},
	} {
		if _, err := repo.CreateShareLink(ctx, actor, input); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}

	for name, input := range map[string]ShareLinkInput{
		"another workspace's asset": {AssetID: foreign, Title: "x", Access: "PUBLIC"},
		"an asset still uploading":  {AssetID: pending, Title: "x", Access: "PUBLIC"},
		"a video poster":            {AssetID: image, PosterAssetID: &video, Title: "x", Access: "PUBLIC"},
		"an unknown access":         {AssetID: image, Title: "x", Access: "FRIENDS"},
		"an expiry in the past":     {AssetID: image, Title: "x", Access: "PUBLIC", ExpiresAt: ptr(time.Now().Add(-time.Minute))},
		"no title":                  {AssetID: image, Title: " ", Access: "PUBLIC"},
	} {
		if _, err := repo.CreateShareLink(ctx, actor, input); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}

	if got, err := repo.GetShareLink(ctx, actor, link.ID); err != nil || got.Token != link.Token {
		t.Fatalf("get=%+v err=%v", got, err)
	}
	if _, err := repo.GetShareLink(ctx, stranger, link.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("stranger get: %v", err)
	}
	if _, err := repo.UpdateShareLink(ctx, stranger, link.ID, ShareLinkUpdate{Title: ptr("Mine")}); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("stranger update: %v", err)
	}
	if err := repo.RevokeShareLink(ctx, stranger, link.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("stranger revoke: %v", err)
	}
	updated, err := repo.UpdateShareLink(ctx, actor, link.ID, ShareLinkUpdate{Access: ptr("WORKSPACE"), AltText: ptr("A product tour"), ExpiresAt: ptr(time.Now().Add(time.Hour))})
	if err != nil || updated.Access != "WORKSPACE" || updated.AltText == nil || updated.ExpiresAt == nil {
		t.Fatalf("updated=%+v err=%v", updated, err)
	}

	// An expired link no longer resolves.
	if _, err := db.SQL.ExecContext(ctx, `UPDATE share_link SET "expiresAt"=now() - interval '1 second' WHERE id=$1`, link.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ResolveShareLink(ctx, link.Token); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("expired link resolved: %v", err)
	}
	if _, err := repo.UpdateShareLink(ctx, actor, link.ID, ShareLinkUpdate{ClearExpiry: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ResolveShareLink(ctx, link.Token); err != nil {
		t.Fatalf("link with expiry cleared: %v", err)
	}
	if err := repo.RevokeShareLink(ctx, actor, link.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.ResolveShareLink(ctx, link.Token); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("revoked link resolved: %v", err)
	}
	if _, _, err := repo.ShareLinkObjectURL(ctx, link.Token, "media"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("revoked link read: %v", err)
	}
	if _, err := repo.ResolveShareLink(ctx, "not-a-real-token-value-at-all"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("unknown token: %v", err)
	}
	if links, err := repo.ListShareLinks(ctx, stranger); err != nil || len(links) != 0 {
		t.Fatalf("stranger sees links=%+v err=%v", links, err)
	}

	if _, err := repo.SaveIntegration(ctx, actor, IntegrationInput{Provider: "SLACK", ExternalID: "T123", DisplayName: "Legacy", EncryptedCredentials: "v1.iv.tag.cipher"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("web Slack credentials accepted: %v", err)
	}
	saved, err := repo.SaveIntegration(ctx, actor, IntegrationInput{Provider: "NOTION", ExternalID: "T123", DisplayName: "Acme",
		EncryptedCredentials: "v1.iv.tag.cipher", Scopes: []string{"chat:write"}})
	if err != nil || saved.Provider != "NOTION" {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
	again, err := repo.SaveIntegration(ctx, actor, IntegrationInput{Provider: "NOTION", ExternalID: "T123", DisplayName: "Acme Inc",
		EncryptedCredentials: "v1.iv.tag.cipher2"})
	if err != nil || again.ID != saved.ID || again.DisplayName != "Acme Inc" {
		t.Fatalf("reconnect made a second connection: %+v err=%v", again, err)
	}
	if _, err := repo.SaveIntegration(ctx, actor, IntegrationInput{Provider: "DROPBOX", ExternalID: "x", DisplayName: "x", EncryptedCredentials: "x"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown provider: %v", err)
	}
	if _, err := repo.IntegrationCredentials(ctx, stranger, saved.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("stranger credentials: %v", err)
	}
	credentials, err := repo.IntegrationCredentials(ctx, actor, saved.ID)
	if err != nil || credentials.EncryptedCredentials != "v1.iv.tag.cipher2" {
		t.Fatalf("credentials=%+v err=%v", credentials, err)
	}
	if err := repo.UpdateIntegrationCredentials(ctx, actor, saved.ID, IntegrationCredentialsUpdate{EncryptedCredentials: "v1.refreshed"}); err != nil {
		t.Fatal(err)
	}
	if err := repo.DeleteIntegration(ctx, stranger, saved.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("stranger delete: %v", err)
	}
	if err := repo.DeleteIntegration(ctx, actor, saved.ID); err != nil {
		t.Fatal(err)
	}
	if items, err := repo.ListIntegrations(ctx, actor); err != nil || len(items) != 0 {
		t.Fatalf("items=%+v err=%v", items, err)
	}
}

func ptr[T any](value T) *T { return &value }
