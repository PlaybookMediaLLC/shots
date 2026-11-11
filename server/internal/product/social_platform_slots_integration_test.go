package product

import (
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestSocialPlatformAliasesKeepOneSlotAndDraftDefaults(t *testing.T) {
	for _, pair := range [][2]string{{"mastodon-custom", "mastodon"}, {"linkedin-page", "linkedin"}, {"instagram-standalone", "instagram"}, {"twitter", "x"}} {
		t.Run(pair[0], func(t *testing.T) {
			w := newTestWorkspace(t)
			ctx, repo, owner := w.ctx, w.repo.WithMonthlyMeter(&recordingMonthlyMeter{}), w.owner
			subscribe(t, ctx, repo, w.org, "pro")
			set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Aliases"})
			if err != nil {
				t.Fatal(err)
			}
			add := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
			actor := publishing.Actor{Organization: w.org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"}
			add(pair[0]+w.id, pair[0])
			connection, err := repo.auth.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: pair[0] + w.id, Platform: pair[0], ProviderSettings: map[string]any{}, SecretReference: "FIXTURE", SocialSetID: &set.ID})
			if err != nil {
				t.Fatal(err)
			}
			current, err := repo.GetSocialSet(ctx, owner, set.ID)
			if err != nil || len(current.DefaultPlatforms) != 1 || current.DefaultPlatforms[0] != pair[1] || current.PrimaryPlatform == nil || *current.PrimaryPlatform != pair[1] || len(current.Accounts) != 1 || current.Accounts[0].Health != AccountConnected {
				t.Fatalf("alias defaults or health=%+v err=%v", current, err)
			}
			defaults := []string{pair[1]}
			if _, err := repo.UpdateSocialSet(ctx, owner, set.ID, SocialSetUpdate{BaseVersion: current.Version, DefaultPlatforms: &defaults, PrimaryPlatform: &pair[1]}); err != nil {
				t.Fatal(err)
			}
			draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Keep account identity", SocialSetID: set.ID})
			if err != nil || len(draft.ChannelConnectionIDs) != 1 || draft.ChannelConnectionIDs[0] != connection.ID || draft.PrimaryPlatform == nil || *draft.PrimaryPlatform != pair[1] {
				t.Fatalf("alias draft=%+v err=%v", draft, err)
			}
			_, err = repo.auth.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: pair[1] + w.id, Platform: pair[1], ProviderSettings: map[string]any{}, SecretReference: "FIXTURE", SocialSetID: &set.ID})
			if !errors.Is(err, publishing.ErrSocialSetSlotTaken) {
				t.Fatalf("second adapter occupied platform: %v", err)
			}
			if _, err := repo.RemoveSocialSetAccount(ctx, owner, set.ID, connection.ID); err != nil {
				t.Fatal(err)
			}
			after, err := repo.GetSocialSet(ctx, owner, set.ID)
			if err != nil || len(after.DefaultPlatforms) != 0 || after.PrimaryPlatform != nil {
				t.Fatalf("removed alias left defaults=%+v err=%v", after, err)
			}
			saved, err := repo.GetContentDraft(ctx, owner, draft.ID)
			if err != nil || len(saved.ChannelConnectionIDs) != 1 || saved.ChannelConnectionIDs[0] != connection.ID {
				t.Fatal("account removal rewrote historical draft")
			}
		})
	}
}

func TestChosenAccountsDecideANewDraftsMainPlatform(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo.WithMonthlyMeter(&recordingMonthlyMeter{}), w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Main platform"})
	if err != nil {
		t.Fatal(err)
	}
	add := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
	actor := publishing.Actor{Organization: w.org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"}
	ids := map[string]string{}
	for _, platform := range []string{"tiktok", "x"} {
		add(platform+w.id, platform)
		connection, err := repo.auth.CreateConnection(ctx, actor, publishing.CreateConnectionInput{ExternalAccountID: platform + w.id, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "FIXTURE", SocialSetID: &set.ID})
		if err != nil {
			t.Fatal(err)
		}
		ids[platform] = connection.ID
	}
	current, err := repo.GetSocialSet(ctx, owner, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	defaults, tiktok := []string{"tiktok", "x"}, "tiktok"
	if _, err := repo.UpdateSocialSet(ctx, owner, set.ID, SocialSetUpdate{BaseVersion: current.Version, DefaultPlatforms: &defaults, PrimaryPlatform: &tiktok}); err != nil {
		t.Fatal(err)
	}
	draft, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "X only", SocialSetID: set.ID, ChannelConnectionIDs: []string{ids["x"]}})
	if err != nil || draft.PrimaryPlatform == nil || *draft.PrimaryPlatform != "x" || len(draft.ChannelConnectionIDs) != 1 || draft.ChannelConnectionIDs[0] != ids["x"] {
		t.Fatalf("X-only draft opened on another platform: %+v err=%v", draft, err)
	}
	both, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Defaults", SocialSetID: set.ID})
	if err != nil || both.PrimaryPlatform == nil || *both.PrimaryPlatform != "tiktok" || len(both.ChannelConnectionIDs) != 2 {
		t.Fatalf("set defaults changed: %+v err=%v", both, err)
	}
}
