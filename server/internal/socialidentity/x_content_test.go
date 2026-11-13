package socialidentity

import (
	"strings"
	"testing"
)

func TestXContentUsesVerifiedLimitsWithoutChangingContent(t *testing.T) {
	standard := XStandardPostLimits("read-write", nil)
	for _, text := range []string{strings.Repeat("a", 281), "bad\ufefftext", string([]byte{0xff}), strings.Repeat("example.com ", 12)} {
		if CheckXText(standard, text) == nil {
			t.Fatalf("invalid X text accepted: %q", text)
		}
	}
	for _, text := range []string{"", strings.Repeat("e\u0301", 280), strings.Repeat("🇫🇷", 140), strings.Repeat("a", 280)} {
		if err := CheckXText(standard, text); err != nil {
			t.Fatalf("valid X text refused: %v", err)
		}
	}
	basic := "Basic"
	premium := XVerifiedAccountLimits("read-write", &basic)
	if CheckXText(premium, strings.Repeat("a", 25000)) != nil || CheckXText(premium, strings.Repeat("a", 25001)) == nil || premium.Articles == nil || *premium.Articles {
		t.Fatal("long posts and Articles must be independent")
	}
	// 24,013 characters fit the premium limit; only the link scan refuses them.
	if CheckXText(premium, "https://a.co/"+strings.Repeat("(a)", 8000)) == nil {
		t.Fatal("text too complex to count must be refused")
	}
	for _, media := range [][]XMedia{
		{{MIME: "image/png", Bytes: 5000001}},
		{{MIME: "image/gif", Bytes: 1}, {MIME: "image/png", Bytes: 1}},
		{{MIME: "video/mp4", Bytes: 1}},
		{{MIME: "image/svg+xml", Bytes: 1}},
		{{MIME: "image/png", Bytes: 0}},
		{{MIME: "image/png", Bytes: 1}, {MIME: "image/png", Bytes: 1}, {MIME: "image/png", Bytes: 1}, {MIME: "image/png", Bytes: 1}, {MIME: "image/png", Bytes: 1}},
	} {
		if CheckXMedia(standard, media) == nil {
			t.Fatalf("unsupported selection accepted: %+v", media)
		}
	}
	if CheckXMedia(standard, []XMedia{{MIME: "image/png", Bytes: 5000000}, {MIME: "image/webp", Bytes: 1}}) != nil || CheckXMedia(standard, []XMedia{{MIME: "image/gif", Bytes: 15000000}}) != nil {
		t.Fatal("supported original images refused")
	}
	// A verified account's video allowance bounds the recorded length; an unknown length is left to the publisher.
	none := "None"
	twenty := XVerifiedAccountLimits("read-write", &none)
	if CheckXMedia(twenty, []XMedia{{MIME: "video/mp4", Bytes: 1, DurationMs: 1_200_000}}) != nil ||
		CheckXMedia(twenty, []XMedia{{MIME: "video/mp4", Bytes: 1}}) != nil ||
		CheckXMedia(twenty, []XMedia{{MIME: "video/mp4", Bytes: 1, DurationMs: 1_200_001}}) == nil {
		t.Fatal("video length was not checked against the account allowance")
	}
	// The composer repeats these words (clients/apps/web/lib/write/batch.ts, publication.ts).
	if err := CheckXMedia(twenty, []XMedia{{MIME: "video/mp4", Bytes: 1, DurationMs: 1_200_999}}); err == nil ||
		err.Error() != "This X account takes videos up to 20 minutes; this one is 20:01. Trim it before scheduling." {
		t.Fatalf("over-length wording: %v", err)
	}
	if err := CheckXMedia(XStandardPostLimits("read-write", nil), []XMedia{{MIME: "video/mp4", Bytes: 1}}); err == nil ||
		err.Error() != "Reconnect X to verify this account's video limits." {
		t.Fatalf("unverified wording: %v", err)
	}
}
