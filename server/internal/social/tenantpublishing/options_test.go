package tenantpublishing

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

func decode(t *testing.T, raw json.RawMessage) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPostSettingsMapEachPlatformsFields(t *testing.T) {
	base := map[string]any{"custom": "kept"}
	x, err := postSettings("x", base, &postoptions.PublishOptions{ReplySettings: "following", MadeWithAI: true,
		CommunityID: "1493446837214187523", QuoteRemoteID: "42"}, "")
	if err != nil {
		t.Fatal(err)
	}
	got := decode(t, x)
	if got["who_can_reply_post"] != "following" || got["made_with_ai"] != true || got["paid_partnership"] != nil ||
		got["community"] != "https://x.com/i/communities/1493446837214187523" || got["share_with_followers"] != false ||
		got["quote_tweet_id"] != "42" || got["custom"] != "kept" {
		t.Fatalf("x settings: %v", got)
	}
	if _, ok := base["who_can_reply_post"]; ok {
		t.Fatal("the connection's settings were changed")
	}
	plain := decode(t, must(postSettings("x", nil, nil, "")))
	if plain["who_can_reply_post"] != "everyone" || len(plain) != 1 {
		t.Fatalf("an X post without options lets everyone reply: %v", plain)
	}
	linkedin := decode(t, must(postSettings("linkedin", nil, &postoptions.PublishOptions{Visibility: "CONNECTIONS",
		DocumentTitle: "Deck", QuoteRemoteID: "urn:li:share:1", ReplySettings: "verified"}, "")))
	if linkedin["visibility"] != "CONNECTIONS" || linkedin["document_title"] != "Deck" || linkedin["reshare_parent"] != "urn:li:share:1" ||
		linkedin["who_can_reply_post"] != nil {
		t.Fatalf("linkedin settings: %v", linkedin)
	}
	audience := false
	for _, tc := range []struct {
		platform string
		options  *postoptions.PublishOptions
		want     map[string]any
	}{
		{"youtube", &postoptions.PublishOptions{YouTube: &postoptions.YouTubeOptions{Title: "Explicit title", Privacy: "unlisted", MadeForKids: &audience}}, map[string]any{"title": "Explicit title", "type": "unlisted", "selfDeclaredMadeForKids": "no", "containsSyntheticMedia": false}},
		{"youtube", &postoptions.PublishOptions{YouTube: &postoptions.YouTubeOptions{Title: "Explicit title", Privacy: "public", MadeForKids: &audience,
			Tags: []string{"launch", "screen shots"}, ContainsSyntheticMedia: true, ThumbnailAssetID: "thumb"}},
			map[string]any{"title": "Explicit title", "type": "public", "selfDeclaredMadeForKids": "no", "containsSyntheticMedia": true,
				"tags": []any{map[string]any{"value": "launch", "label": "launch"}, map[string]any{"value": "screen shots", "label": "screen shots"}}}},
		{"instagram-standalone", &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{Collaborators: []string{"partner"},
			UserTags: []string{"brand", "maker"}, ShareToFeed: &audience, TrialReel: true, CoverAssetID: "cover"}},
			map[string]any{"collaborators": []any{map[string]any{"label": "partner"}}, "user_tags": []any{"brand", "maker"},
				"share_to_feed": false, "is_trial_reel": true}},
		{"instagram-standalone", &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{TrialReel: true, TrialGraduation: "SS_PERFORMANCE"}},
			map[string]any{"is_trial_reel": true, "graduation_strategy": "SS_PERFORMANCE"}},
		{"tiktok", &postoptions.PublishOptions{TikTok: &postoptions.TikTokOptions{Privacy: "PUBLIC_TO_EVERYONE", AllowComments: true, AllowStitch: true, CommercialContent: true, BrandOrganic: true, MadeWithAI: true, Consent: true}}, map[string]any{"content_posting_method": "DIRECT_POST", "privacy_level": "PUBLIC_TO_EVERYONE", "comment": true, "duet": false, "stitch": true, "brand_organic_toggle": true, "brand_content_toggle": false, "video_made_with_ai": true, "autoAddMusic": "no"}},
	} {
		if got := decode(t, must(postSettings(tc.platform, nil, tc.options, ""))); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s settings: %v", tc.platform, got)
		}
	}

}

func TestInstagramSettingsRefuseInvalidOptions(t *testing.T) {
	// A stored snapshot is checked again before it reaches the adapter.
	if _, err := postSettings("instagram-standalone", nil, &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{
		Collaborators: []string{"a", "b", "c", "d"}}}, ""); err == nil {
		t.Fatal("four collaborators reached the adapter")
	}
}

func TestAFinisherQuotesTheFirstPostOnlyOnceItIsLive(t *testing.T) {
	finisher := &postoptions.PublishOptions{QuoteFirstPost: true}
	if _, err := postSettings("x", nil, finisher, ""); err == nil {
		t.Fatal("a quote of a post that does not exist yet was accepted")
	}
	after := decode(t, must(postSettings("x", nil, finisher, "1800")))
	if after["quote_tweet_id"] != "1800" {
		t.Fatalf("the finisher does not quote the live first post: %v", after)
	}
}

func TestArticleSettings(t *testing.T) {
	article := decode(t, must(postSettings("x", nil, &postoptions.PublishOptions{ArticleTitle: "Why"}, "")))
	if article["post_type"] != "article" || article["article_title"] != "Why" || article["article_status"] != "published" {
		t.Fatalf("article: %v", article)
	}
}

func TestAccountStandingRequiresVerifiedCapabilities(t *testing.T) {
	for _, subscription := range []string{"None", "Basic", "Premium", "PremiumPlus"} {
		t.Run(subscription, func(t *testing.T) {
			p, _, _, _ := directFixture()
			account := p.integrations.(fakeIntegrations).item
			verifiedDirectAccount(t, account, "x")
			editable := `[{"title":"Verified","value":true}]`
			account.AdditionalSettings = &editable
			standing, err := p.AccountStanding(context.Background(), "product-org", "destination", "x", "SOCIAL_API_KEY")
			if err != nil || standing.Premium || standing.XCaptionLimit == nil || *standing.XCaptionLimit != 280 || standing.XArticles != nil || standing.XVideoMaxSeconds != nil {
				t.Fatalf("editable settings granted access: %+v %v", standing, err)
			}
			caps := socialidentity.XVerifiedAccountLimits("read-write", &subscription)
			account.VerifiedCapabilities.X = &caps
			standing, err = p.AccountStanding(context.Background(), "product-org", "destination", "x", "SOCIAL_API_KEY")
			if err != nil || standing.Premium != (subscription != "None") || standing.XCaptionLimit == nil || *standing.XCaptionLimit != caps.PostTextLimit() || standing.XArticles == nil || *standing.XArticles != (subscription == "Premium" || subscription == "PremiumPlus") ||
				standing.XVideoMaxSeconds == nil || *standing.XVideoMaxSeconds != *caps.VideoMaxDurationSeconds {
				t.Fatalf("verified capabilities lost: %+v %v", standing, err)
			}
		})
	}
}

func must(raw json.RawMessage, err error) json.RawMessage {
	if err != nil {
		panic(err)
	}
	return raw
}

func TestBlueskyFinisherRequiresVerifiedRoot(t *testing.T) {
	options := &postoptions.PublishOptions{QuoteFirstPost: true}
	if _, err := postSettings("bluesky", nil, options, ""); err == nil {
		t.Fatal("unconfirmed root accepted")
	}
	root := "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/root"
	settings, err := postSettings("bluesky", nil, options, root)
	if err != nil || decode(t, settings)["quote_uri"] != root {
		t.Fatalf("lost root: %s %v", settings, err)
	}
}

func TestNativeFinisherTargetsUsePublishedRoot(t *testing.T) {
	for _, tc := range []struct{ platform, root, field, want string }{
		{"bluesky", "at://did:plc:alice/app.bsky.feed.post/3kroot", "quote_uri", "at://did:plc:alice/app.bsky.feed.post/3kroot"},
		{"mastodon", "123", "quote_uri", "123"},
		{"mastodon-custom", "456", "quote_uri", "456"},
	} {
		raw, err := postSettings(tc.platform, nil, &postoptions.PublishOptions{QuoteFirstPost: true}, tc.root)
		if err != nil {
			t.Fatal(err)
		}
		var settings map[string]any
		if err := json.Unmarshal(raw, &settings); err != nil {
			t.Fatal(err)
		}
		if settings[tc.field] != tc.want {
			t.Fatal(settings)
		}
	}
}
