package publishing

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/publicationattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
)

func TestSecretReferenceValidation(t *testing.T) {
	t.Parallel()
	tests := map[string]bool{
		"SOCIAL_API_KEY":             true,
		"SOCIAL_API_KEY_CUSTOMER_12": true,
		"SOCIAL_OAUTH_TOKEN":         true,
		"SOCIAL_OAUTH_TOKEN_TEAM":    true,
		"SOCIAL_API_KEY_":            false,
		"SOCIAL_api_key":             false,
		"DATABASE_URL":               false,
		"SOCIAL_OTHER":               false,
	}
	for value, expected := range tests {
		if actual := IsSecretReference(value); actual != expected {
			t.Fatalf("IsSecretReference(%q) = %v, want %v", value, actual, expected)
		}
	}
}

func TestEntMappingsMatchPrismaTables(t *testing.T) {
	t.Parallel()
	if channelconnection.Table != "channel_connection" || scheduledpost.Table != "scheduled_post" || publicationattempt.Table != "publication_attempt" {
		t.Fatalf("publishing Ent tables do not match Prisma mappings")
	}
	if channelconnection.FieldOrganizationID != "organizationId" || scheduledpost.FieldScheduledFor != "scheduledFor" || publicationattempt.FieldProviderPostID != "providerPostId" {
		t.Fatalf("publishing Ent columns do not match Prisma storage keys")
	}
}

func TestProviderFailureCode(t *testing.T) {
	t.Parallel()
	if got := ProviderFailureCode(429, false); got != "429" {
		t.Fatalf("got %q", got)
	}
	if got := ProviderFailureCode(0, true); got != "UNKNOWN_DELIVERY" {
		t.Fatalf("got %q", got)
	}
}

func TestContentIdempotencyKeyNamesTheRequestContent(t *testing.T) {
	at := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	input := CreateScheduledPostInput{Caption: "Ship it", ChannelConnectionID: "c1", VariantID: "v1", ScheduledFor: at}
	retry := input
	retry.Caption, retry.ScheduledFor = " Ship it ", at.In(time.FixedZone("EST", -5*3600))
	if key := ContentIdempotencyKey(input); key != ContentIdempotencyKey(retry) || len(key) > 128 || !strings.HasPrefix(key, "content:") {
		t.Fatalf("a retried request got another key: %q", key)
	}
	for name, change := range map[string]func(*CreateScheduledPostInput){
		"caption":    func(in *CreateScheduledPostInput) { in.Caption = "Ship it twice" },
		"time":       func(in *CreateScheduledPostInput) { in.ScheduledFor = at.Add(time.Minute) },
		"connection": func(in *CreateScheduledPostInput) { in.ChannelConnectionID = "c2" },
		"source":     func(in *CreateScheduledPostInput) { in.VariantID, in.ContentDraftID = "", "d1" },
	} {
		other := input
		change(&other)
		if ContentIdempotencyKey(other) == ContentIdempotencyKey(input) {
			t.Fatalf("a different %s shares the key", name)
		}
	}
}

func TestReplayAnswersAKeyWithItsFirstPost(t *testing.T) {
	at := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	variant := "v1"
	post := &ent.ScheduledPost{ID: "p1", Caption: "Ship it", ScheduledFor: at, VariantID: &variant}
	keyed := CreateScheduledPostInput{Caption: "Ship it", ChannelConnectionID: "c1", IdempotencyKey: "client-key", VariantID: "v1", ScheduledFor: at}
	// A retry that recomputed its time or edited its caption still gets the first post.
	for _, retry := range []CreateScheduledPostInput{keyed,
		{Caption: "Ship it", ChannelConnectionID: "c1", IdempotencyKey: "client-key", VariantID: "v1", ScheduledFor: at.Add(time.Minute)},
		{Caption: "Ship it again", ChannelConnectionID: "c1", IdempotencyKey: "client-key", VariantID: "v1", ScheduledFor: at},
	} {
		if result, err := replayScheduledPost(post, retry); err != nil || result.Created || result.Post != post {
			t.Fatalf("a retry did not replay: %+v %v", result, err)
		}
	}
	cancelled := *post
	cancelled.Status = scheduledpost.StatusCANCELLED
	if result, err := replayScheduledPost(&cancelled, keyed); err != nil || result.Post != &cancelled {
		t.Fatalf("a caller's key replays its cancelled post: %+v %v", result, err)
	}
	named := keyed
	named.IdempotencyKey = ContentIdempotencyKey(keyed)
	if _, err := replayScheduledPost(&cancelled, named); !errors.Is(err, ErrConflict) {
		t.Fatalf("a content key answered with a cancelled post: %v", err)
	}
}

func TestRedactProviderMessageDropsCredentialsAndSignedURLs(t *testing.T) {
	for in, want := range map[string]string{
		"fetch https://cdn.example/a.png?X-Amz-Signature=abc failed": "fetch https://cdn.example/a.png?REDACTED failed",
		"token rejected: access_token=EAAG123&x=1":                   "token rejected: access_token=REDACTED&x=1",
		"client_secret=abc123 and api_key=k1 refused":                "client_secret=REDACTED and api_key=REDACTED refused",
		"Authorization: Bearer abc.def-ghi refused":                  "Authorization: Bearer REDACTED refused",
		"Basic dXNlcjpwYXNz refused at https://user:pass@host/x":     "Basic REDACTED refused at https://REDACTED@host/x",
		"oauth_token=abc and app_secret=def":                         "oauth_token=REDACTED and app_secret=REDACTED",
		`{"error":"bad","access_token":"EAAG"}`:                      `{"error":"bad","access_token":"REDACTED"}`,
		"  Image   is too\nlarge ":                                   "Image is too large",
		"You have reached the maximum of 25 posts per day":           "You have reached the maximum of 25 posts per day",
	} {
		if got := RedactProviderMessage(in); got != want {
			t.Fatalf("RedactProviderMessage(%q) = %q, want %q", in, got, want)
		}
	}
	if got := []rune(RedactProviderMessage(strings.Repeat("x", 900))); len(got) != maxMessageLen+1 {
		t.Fatalf("long message kept %d runes", len(got))
	}
}
