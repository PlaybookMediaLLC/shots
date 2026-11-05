package integration

import (
	"strings"
	"testing"
	"time"
)

func TestForgetProviderAccountErasesEveryWorkspacesCredentials(t *testing.T) {
	f := setup(t, "threads")
	repo := f.service.repo
	other := f.client.Organization.Create().SetName("Other workspace").SaveX(f.ctx)
	create := func(org, provider, internalID, token string) string {
		t.Helper()
		refresh := "refresh-" + token
		return f.client.Integration.Create().SetOrganizationID(org).SetInternalID(internalID).SetName("Alice").
			SetPicture("https://example.com/a.png").SetProviderIdentifier(provider).SetType("social").
			SetToken(token).SetRefreshToken(&refresh).SetProfile("alice").SaveX(f.ctx).ID
	}
	active := create(f.org.ID, "threads", "178414", "active-token")
	foreign := create(other.ID, "threads", "178414", "foreign-token")
	// A row someone already removed still holds its tokens.
	third := f.client.Organization.Create().SetName("Third workspace").SaveX(f.ctx)
	removed := create(third.ID, "threads", "178414", "removed-token")
	removedAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	f.client.Integration.UpdateOneID(removed).SetDeletedAt(removedAt).ExecX(f.ctx)
	// The same number on another network is a different person.
	fourth := f.client.Organization.Create().SetName("Fourth workspace").SaveX(f.ctx)
	sameID := create(fourth.ID, "instagram-standalone", "178414", "instagram-token")
	otherAccount := create(f.org.ID, "threads", "999", "other-token")

	found, err := repo.ProviderAccountIntegrationIDs(f.ctx, "threads", "178414")
	if err != nil || len(found) != 3 {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if err := repo.ForgetProviderAccount(f.ctx, "threads", "178414"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{active, foreign, removed} {
		row := f.client.Integration.GetX(f.ctx, id)
		if strings.Contains(row.Token, "token") || row.RefreshToken != nil && strings.Contains(*row.RefreshToken, "token") ||
			row.InternalID == "178414" || row.Name == "Alice" || row.Picture != nil || row.Profile != nil && *row.Profile == "alice" {
			t.Errorf("%s kept account data: %+v", id, row)
		}
		if row.DeletedAt == nil {
			t.Errorf("%s was left active", id)
		}
	}
	if row := f.client.Integration.GetX(f.ctx, removed); row.DeletedAt == nil || !row.DeletedAt.Equal(removedAt) {
		t.Errorf("the original removal time was lost: %v", row.DeletedAt)
	}
	for id, token := range map[string]string{sameID: "instagram-token", otherAccount: "other-token"} {
		if row := f.client.Integration.GetX(f.ctx, id); row.Token != token || row.DeletedAt != nil {
			t.Errorf("%s was changed: token=%q deleted=%v", id, row.Token, row.DeletedAt)
		}
	}
	// A retry finds nothing and is not an error.
	if found, err := repo.ProviderAccountIntegrationIDs(f.ctx, "threads", "178414"); err != nil || len(found) != 0 {
		t.Fatalf("after forgetting: found=%v err=%v", found, err)
	}
	if err := repo.ForgetProviderAccount(f.ctx, "threads", "178414"); err != nil {
		t.Fatal(err)
	}
}
