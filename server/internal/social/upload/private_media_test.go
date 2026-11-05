package upload

import (
	"context"
	"net/url"
	"strings"
	"testing"
	"time"
)

func privateMediaEnv(t *testing.T) {
	t.Helper()
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "true")
	t.Setenv("STORAGE_PROVIDER", "cloudflare")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "account")
	t.Setenv("CLOUDFLARE_ACCESS_KEY", "test-access")
	t.Setenv("CLOUDFLARE_SECRET_ACCESS_KEY", "test-secret")
	t.Setenv("CLOUDFLARE_BUCKETNAME", "social-media")
	t.Setenv("CLOUDFLARE_BUCKET_URL", "https://account.r2.cloudflarestorage.com/social-media")
}

func TestPrivateMediaSignsAtPublishTime(t *testing.T) {
	privateMediaEnv(t)
	signer, err := NewPrivateMediaSigner()
	if err != nil {
		t.Fatal(err)
	}
	stored := "https://account.r2.cloudflarestorage.com/social-media/old/image.png"
	signed, err := signer.SignURL(context.Background(), stored)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(signed)
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/social-media/old/image.png" || u.Query().Get("X-Amz-Expires") != "86400" || u.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("private R2 URL was not signed for 24 hours: path=%q expires=%q signature=%t", u.Path, u.Query().Get("X-Amz-Expires"), u.Query().Get("X-Amz-Signature") != "")
	}
	if strings.Contains(stored, "X-Amz-") {
		t.Fatal("the stored URL must remain stable and unsigned")
	}

	// One file keeps one link for the hour, so a browser can cache it.
	start := time.Now().UTC()
	again, err := signer.SignURL(context.Background(), stored)
	if err != nil {
		t.Fatal(err)
	}
	if date := u.Query().Get("X-Amz-Date"); !strings.HasSuffix(date, "0000Z") {
		t.Fatalf("the link must be signed as of the start of the hour, got X-Amz-Date=%q", date)
	}
	if again != signed && start.Truncate(time.Hour).Equal(time.Now().UTC().Truncate(time.Hour)) {
		t.Fatal("two links for one file in the same hour must be the same")
	}

	refreshed, err := signer.SignURL(context.Background(), stored+"?X-Amz-Expires=1&X-Amz-Signature=expired")
	if err != nil {
		t.Fatal(err)
	}
	refreshURL, _ := url.Parse(refreshed)
	if refreshURL.Query().Get("X-Amz-Expires") != "86400" || refreshURL.Query().Get("X-Amz-Signature") == "expired" {
		t.Fatal("an old signed URL must be refreshed")
	}
}

func TestPrivateMediaLeavesOtherURLsAlone(t *testing.T) {
	privateMediaEnv(t)
	signer, err := NewPrivateMediaSigner()
	if err != nil {
		t.Fatal(err)
	}
	for _, original := range []string{
		"https://other.example/social-media/image.png",
		"https://account.r2.cloudflarestorage.com/social-media-other/image.png",
		"/tmp/image.png",
		"",
	} {
		got, err := signer.SignURL(context.Background(), original)
		if err != nil || got != original {
			t.Fatalf("unexpected change to %q: %q, %v", original, got, err)
		}
		if _, err := signer.SignManagedURL(context.Background(), original); err == nil {
			t.Fatalf("direct publication accepted unmanaged media %q", original)
		}
	}
}

func TestPrivateMediaRequiresCredentialsAndOmitsPublicACL(t *testing.T) {
	privateMediaEnv(t)
	if privateMediaACL() != "" {
		t.Fatal("private uploads must not request public-read")
	}
	t.Setenv("CLOUDFLARE_SECRET_ACCESS_KEY", "")
	if _, err := NewPrivateMediaSigner(); err == nil {
		t.Fatal("missing private-bucket credentials must fail closed")
	}
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
	if signer, err := NewPrivateMediaSigner(); err != nil || signer != nil || privateMediaACL() == "" {
		t.Fatal("public-bucket behavior should be unchanged")
	}
}
