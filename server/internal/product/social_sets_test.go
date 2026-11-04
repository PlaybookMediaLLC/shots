package product

import (
	"context"
	"net/url"
	"testing"
)

func TestBrowserAvatarSignsOnlyPrivateBucketLinks(t *testing.T) {
	ctx := context.Background()
	stored := "https://account.r2.cloudflarestorage.com/social-media/avatar.jpg"
	external := "https://cdn.example/avatar.jpg"
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "")
	if got := BrowserAvatar(ctx, &stored); got == nil || *got != stored {
		t.Fatalf("a public bucket link must pass through, got %v", got)
	}

	t.Setenv("SOCIAL_PRIVATE_MEDIA", "true")
	t.Setenv("STORAGE_PROVIDER", "cloudflare")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "account")
	t.Setenv("CLOUDFLARE_ACCESS_KEY", "test-access")
	t.Setenv("CLOUDFLARE_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("CLOUDFLARE_BUCKETNAME", "social-media")
	t.Setenv("CLOUDFLARE_BUCKET_URL", "https://account.r2.cloudflarestorage.com/social-media")
	signed := BrowserAvatar(ctx, &stored)
	if signed == nil {
		t.Fatal("a private bucket avatar must get a signed link")
	}
	u, err := url.Parse(*signed)
	if err != nil || u.Path != "/social-media/avatar.jpg" || u.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("the private bucket avatar was not signed: %q", *signed)
	}
	if got := BrowserAvatar(ctx, &external); got == nil || *got != external {
		t.Fatalf("an external avatar must pass through, got %v", got)
	}
	if BrowserAvatar(ctx, nil) != nil {
		t.Fatal("no avatar must stay no avatar")
	}
	// The copy never writes a user, a query or a fragment: such a link names a
	// file the copy did not make, so it is never signed.
	for _, planted := range []string{
		stored + "?imagedelivery.net",
		stored + "#imagedelivery.net",
		"https://imagedelivery.net@account.r2.cloudflarestorage.com/social-media/avatar.jpg",
	} {
		if got := BrowserAvatar(ctx, &planted); got == nil || *got != planted {
			t.Fatalf("a planted link must pass through unsigned, got %v", got)
		}
	}

	t.Setenv("CLOUDFLARE_BUCKETNAME", "")
	if got := BrowserAvatar(ctx, &external); got == nil || *got != external {
		t.Fatalf("bucket settings that cannot sign must not drop other avatars, got %v", got)
	}
}
