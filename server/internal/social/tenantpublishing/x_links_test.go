package tenantpublishing

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	productent "github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

type fakeXLinkPolicy struct {
	allow          bool
	shadow         bool
	remainingSlots int
	reason         string
	nextSlot       *time.Time
	err            error
	calls          []string
	refunds        int
}

func (f *fakeXLinkPolicy) PrepareXLinkSend(_ context.Context, _ string, _ *string, partKey, idempotencyKey string, _ int) (XLinkDecision, error) {
	f.calls = append(f.calls, partKey+":"+idempotencyKey)
	if f.err != nil {
		return XLinkDecision{}, f.err
	}
	if f.remainingSlots > 0 {
		if len(f.calls) > f.remainingSlots {
			return XLinkDecision{AllowLinks: false, Limit: 40, Reason: "quota_exceeded", NextSlotAt: f.nextSlot}, nil
		}
		return XLinkDecision{
			AllowLinks:    true,
			QuotaConsumed: true,
			Refund:        func() { f.refunds++ },
		}, nil
	}
	if f.allow {
		if f.shadow {
			return XLinkDecision{AllowLinks: true, QuotaConsumed: false}, nil
		}
		return XLinkDecision{
			AllowLinks:    true,
			QuotaConsumed: true,
			Refund:        func() { f.refunds++ },
		}, nil
	}
	return XLinkDecision{AllowLinks: false, Limit: 40, Reason: f.reason, NextSlotAt: f.nextSlot}, nil
}

type fakeXLinkRecorder struct {
	stripped int
	consumed bool
}

func (r *fakeXLinkRecorder) RecordXLinkOutcome(_ context.Context, _ string, linksStripped int, quotaConsumed bool) error {
	r.stripped += linksStripped
	if quotaConsumed {
		r.consumed = true
	}
	return nil
}

type xLinksPoster struct {
	postedMessages  []string
	commentMessages []string
	replyMessages   []string
	err             error
}

func (p *xLinksPoster) Post(_ context.Context, _, _ string, posts []integrations.PostDetails, _ *socialent.Integration) ([]integrations.PostResponse, error) {
	if p.err != nil {
		return nil, p.err
	}
	p.postedMessages = append(p.postedMessages, posts[0].Message)
	return []integrations.PostResponse{{ID: posts[0].ID, PostID: "tweet-1", Status: "posted"}}, nil
}

func (p *xLinksPoster) Comment(_ context.Context, _, _, _, _ string, posts []integrations.PostDetails, _ *socialent.Integration) ([]integrations.PostResponse, error) {
	if p.err != nil {
		return nil, p.err
	}
	p.commentMessages = append(p.commentMessages, posts[0].Message)
	return []integrations.PostResponse{{ID: posts[0].ID, PostID: "reply-1", Status: "posted"}}, nil
}

func (p *xLinksPoster) PostEngagement(context.Context, *socialent.Integration, string) (int, int, error) {
	return 100, 10, nil
}

func (p *xLinksPoster) ReplyTo(_ context.Context, _ *socialent.Integration, _, text string) (string, error) {
	if p.err != nil {
		return "", p.err
	}
	p.replyMessages = append(p.replyMessages, text)
	return "plug-1", nil
}

func newXLinkTestPublisher(t *testing.T, platform string, p poster, policy XLinkPolicy, recorder XLinkOutcomeRecorder) *Publisher {
	t.Helper()
	integration := &socialent.Integration{
		ID:                 "dest-1",
		OrganizationID:     "social-org-1",
		ProviderIdentifier: platform,
		InternalID:         "remote-user",
		Token:              "private-token",
	}
	if platform == "x" {
		verifiedDirectAccount(t, integration, "x")
	}
	return (&Publisher{
		bindings:     fakeBindings{item: &productent.SocialTenantBinding{ID: "org-1", GoOrganizationID: "social-org-1", SecretReference: "sec-1"}},
		integrations: fakeIntegrations{item: integration},
		signer:       &fakeSigner{},
		resolve:      func(string) poster { return p },
		now:          time.Now,
	}).WithXLinkPolicy(policy).WithXLinkRecorder(recorder)
}

func TestXLinksDefaultStrippingAndQuota(t *testing.T) {
	ctx := context.Background()

	t.Run("strips links by default when add-on is off", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		recorder := &fakeXLinkRecorder{}
		pub := newXLinkTestPublisher(t, "x", poster, policy, recorder)

		_, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-1",
			SecretReference: "sec-1", Caption: "Check out https://shots.playbookmedia.io and shots.studio/demo!",
			Replies: []publishing.PublishReply{{Caption: "More at example.com/thread"}},
		})
		if err != nil {
			t.Fatalf("PublishThread() error = %v", err)
		}
		if len(poster.postedMessages) != 1 || poster.postedMessages[0] != "Check out and !" {
			t.Fatalf("root posted = %q", poster.postedMessages)
		}
		if len(poster.commentMessages) != 1 || poster.commentMessages[0] != "More at" {
			t.Fatalf("reply posted = %q", poster.commentMessages)
		}
		if recorder.stripped != 3 || recorder.consumed {
			t.Fatalf("recorder = %+v, want stripped=3 consumed=false", recorder)
		}
	})

	t.Run("link-only tweet without media fails cleanly pre-send", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pub := newXLinkTestPublisher(t, "x", poster, policy, nil)

		_, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-empty",
			SecretReference: "sec-1", Caption: "https://shots.playbookmedia.io",
		})
		var apiErr *socialapi.Error
		if !errors.As(err, &apiErr) || apiErr.Code != publishing.FailureXLinkStrippedEmpty || apiErr.Status != http.StatusBadRequest {
			t.Fatalf("got err = %v, want FailureXLinkStrippedEmpty 400", err)
		}
		if len(poster.postedMessages) != 0 {
			t.Fatalf("expected zero provider calls, got %d", len(poster.postedMessages))
		}
	})

	t.Run("link-only tweet with media publishes media cleanly", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pub := newXLinkTestPublisher(t, "x", poster, policy, nil)

		_, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-media",
			SecretReference: "sec-1", Caption: "https://shots.playbookmedia.io",
			Assets: []publishing.MediaAsset{{MediaType: "image/png", ObjectKey: "org/org-1/img.png"}},
		})
		if err != nil {
			t.Fatalf("PublishThread() error = %v", err)
		}
		if len(poster.postedMessages) != 1 || poster.postedMessages[0] != "" {
			t.Fatalf("expected empty text with media, got %q", poster.postedMessages)
		}
	})

	t.Run("preserves links and consumes slot when add-on is on", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: true}
		recorder := &fakeXLinkRecorder{}
		pub := newXLinkTestPublisher(t, "x", poster, policy, recorder)

		caption := "Read https://shots.playbookmedia.io/changelog"
		_, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-keep",
			SecretReference: "sec-1", Caption: caption,
		})
		if err != nil {
			t.Fatalf("PublishThread() error = %v", err)
		}
		if len(poster.postedMessages) != 1 || poster.postedMessages[0] != caption {
			t.Fatalf("posted = %q, want %q", poster.postedMessages, caption)
		}
		if !recorder.consumed || recorder.stripped != 0 || policy.refunds != 0 {
			t.Fatalf("recorder=%+v refunds=%d", recorder, policy.refunds)
		}
	})

	t.Run("refunds slot on definite pre-send failure but not on unknown delivery", func(t *testing.T) {
		poster := &xLinksPoster{err: temporalx.PublicationRejected("x", "rejected")}
		policy := &fakeXLinkPolicy{allow: true}
		pub := newXLinkTestPublisher(t, "x", poster, policy, nil)
		if _, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-fail",
			SecretReference: "sec-1", Caption: "https://shots.playbookmedia.io",
		}); err == nil {
			t.Fatal("expected error")
		}
		if policy.refunds != 1 {
			t.Fatalf("expected refund on definite rejection, got %d", policy.refunds)
		}

		posterUnknown := &xLinksPoster{err: errors.New("connection reset mid-request")}
		policyUnknown := &fakeXLinkPolicy{allow: true}
		pubUnknown := newXLinkTestPublisher(t, "x", posterUnknown, policyUnknown, nil)
		if _, err := pubUnknown.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-unknown",
			SecretReference: "sec-1", Caption: "https://shots.playbookmedia.io",
		}); err == nil {
			t.Fatal("expected error")
		}
		if policyUnknown.refunds != 0 {
			t.Fatalf("must NOT refund on unknown delivery, got %d", policyUnknown.refunds)
		}
	})

	t.Run("fails pre-send when 40-post rolling quota is exhausted", func(t *testing.T) {
		next := time.Date(2026, 12, 15, 12, 0, 0, 0, time.UTC)
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "quota_exceeded", nextSlot: &next}
		pub := newXLinkTestPublisher(t, "x", poster, policy, nil)

		_, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-cap",
			SecretReference: "sec-1", Caption: "Launch https://shots.playbookmedia.io",
		})
		var apiErr *socialapi.Error
		if !errors.As(err, &apiErr) || apiErr.Code != publishing.FailureXLinkQuotaExceeded || !strings.Contains(apiErr.Error(), "Dec 15, 2026") {
			t.Fatalf("got err = %v, want FailureXLinkQuotaExceeded with next slot date", err)
		}
		if len(poster.postedMessages) != 0 {
			t.Fatalf("expected zero provider calls when quota exceeded")
		}
	})

	t.Run("strips links in automate first_comment, plug, and quote", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pub := newXLinkTestPublisher(t, "x", poster, policy, nil)

		if _, err := pub.Automate(ctx, socialapi.AutomationInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", SecretReference: "sec-1",
			RemotePostID: "root-1", Kind: "first_comment", Text: "Details at https://example.com/1",
		}); err != nil {
			t.Fatalf("first_comment error = %v", err)
		}
		if _, err := pub.Automate(ctx, socialapi.AutomationInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", SecretReference: "sec-1",
			RemotePostID: "root-1", Kind: "plug", Threshold: 10, Text: "Grab it at example.com/plug",
		}); err != nil {
			t.Fatalf("plug error = %v", err)
		}
		if _, err := pub.Automate(ctx, socialapi.AutomationInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", SecretReference: "sec-1",
			RemotePostID: "root-1", Kind: "quote", Text: "ICYMI https://example.com/quote",
		}); err != nil {
			t.Fatalf("quote error = %v", err)
		}
		if poster.commentMessages[0] != "Details at" || poster.replyMessages[0] != "Grab it at" || poster.postedMessages[0] != "ICYMI" {
			t.Fatalf("got comment=%q reply=%q quote=%q", poster.commentMessages, poster.replyMessages, poster.postedMessages)
		}
	})

	t.Run("leaves linkedin links and x articles untouched", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pubLI := newXLinkTestPublisher(t, "linkedin", poster, policy, nil)
		if _, err := pubLI.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "linkedin", PostID: "li-1",
			SecretReference: "sec-1", Caption: "See https://example.com",
		}); err != nil {
			t.Fatalf("linkedin error = %v", err)
		}
		if len(policy.calls) != 0 || poster.postedMessages[0] != "See https://example.com" {
			t.Fatalf("linkedin should not trigger x link stripping: calls=%v msg=%q", policy.calls, poster.postedMessages)
		}

		posterArt := &xLinksPoster{}
		policyArt := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pubArt := newXLinkTestPublisher(t, "x", posterArt, policyArt, nil)
		if _, err := pubArt.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "art-1",
			SecretReference: "sec-1", Caption: "Read https://example.com",
			Options: &postoptions.PublishOptions{ArticleHTML: "<p>Read <a href=\"https://example.com\">example.com</a></p>"},
		}); err != nil {
			t.Fatalf("article error = %v", err)
		}
		if len(policyArt.calls) != 0 {
			t.Fatalf("x article should not trigger tweet link stripping: calls=%v", policyArt.calls)
		}
	})

	t.Run("multi-reply thread pre-validates quota and empty replies before sending root", func(t *testing.T) {
		posterQuota := &xLinksPoster{}
		policyQuota := &fakeXLinkPolicy{remainingSlots: 1}
		pubQuota := newXLinkTestPublisher(t, "x", posterQuota, policyQuota, nil)
		_, err := pubQuota.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "thread-cap",
			SecretReference: "sec-1", Caption: "Part 1 https://example.com/1",
			Replies: []publishing.PublishReply{{Caption: "Part 2 https://example.com/2"}},
		})
		var apiErr *socialapi.Error
		if !errors.As(err, &apiErr) || apiErr.Code != publishing.FailureXLinkQuotaExceeded {
			t.Fatalf("got err = %v, want FailureXLinkQuotaExceeded", err)
		}
		if len(posterQuota.postedMessages) != 0 {
			t.Fatalf("root tweet must NOT be sent when reply exceeds quota, sent=%d", len(posterQuota.postedMessages))
		}
		if policyQuota.refunds != 1 {
			t.Fatalf("expected root slot to be refunded when reply pre-validation failed, refunds=%d", policyQuota.refunds)
		}

		posterEmpty := &xLinksPoster{}
		policyEmpty := &fakeXLinkPolicy{allow: false, reason: "addon_disabled"}
		pubEmpty := newXLinkTestPublisher(t, "x", posterEmpty, policyEmpty, nil)
		_, err = pubEmpty.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "thread-empty",
			SecretReference: "sec-1", Caption: "Root with text",
			Replies: []publishing.PublishReply{{Caption: "https://example.com/only-link"}},
		})
		if !errors.As(err, &apiErr) || apiErr.Code != publishing.FailureXLinkStrippedEmpty {
			t.Fatalf("got err = %v, want FailureXLinkStrippedEmpty", err)
		}
		if len(posterEmpty.postedMessages) != 0 {
			t.Fatalf("root tweet must NOT be sent when reply would strip to empty, sent=%d", len(posterEmpty.postedMessages))
		}
	})

	t.Run("fail-closed allowlist never refunds ambiguous errors in Automate", func(t *testing.T) {
		for _, kind := range []string{"first_comment", "plug", "quote"} {
			for _, rawErr := range []error{errors.New("connection reset"), temporalx.BadBody("x", nil, nil, "timeout reading body")} {
				poster := &xLinksPoster{err: rawErr}
				policy := &fakeXLinkPolicy{allow: true}
				pub := newXLinkTestPublisher(t, "x", poster, policy, nil)
				if _, err := pub.Automate(ctx, socialapi.AutomationInput{
					OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", SecretReference: "sec-1",
					RemotePostID: "root-ambig", Kind: kind, Threshold: 10, Text: "Link https://example.com",
				}); err == nil {
					t.Fatalf("kind=%s err=%v: expected error", kind, rawErr)
				}
				if policy.refunds != 0 {
					t.Fatalf("kind=%s err=%v: must NOT refund ambiguous error, got refunds=%d", kind, rawErr, policy.refunds)
				}
			}
		}
		// Definite rejection in Automate MUST refund.
		posterRej := &xLinksPoster{err: temporalx.PublicationRejected("x", "rejected")}
		policyRej := &fakeXLinkPolicy{allow: true}
		pubRej := newXLinkTestPublisher(t, "x", posterRej, policyRej, nil)
		if _, err := pubRej.Automate(ctx, socialapi.AutomationInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", SecretReference: "sec-1",
			RemotePostID: "root-rej", Kind: "first_comment", Text: "Link https://example.com",
		}); err == nil {
			t.Fatal("expected rejection error")
		}
		if policyRej.refunds != 1 {
			t.Fatalf("expected 1 refund on definite Automate rejection, got %d", policyRej.refunds)
		}
	})

	t.Run("shadow mode allows links without recording quotaConsumed and policy error returns 429", func(t *testing.T) {
		poster := &xLinksPoster{}
		policy := &fakeXLinkPolicy{allow: true, shadow: true}
		recorder := &fakeXLinkRecorder{}
		pub := newXLinkTestPublisher(t, "x", poster, policy, recorder)
		if _, err := pub.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-shadow",
			SecretReference: "sec-1", Caption: "See https://example.com",
		}); err != nil {
			t.Fatalf("shadow publish error = %v", err)
		}
		if recorder.consumed {
			t.Fatal("shadow mode must NOT record quotaConsumed=true")
		}

		policyErr := &fakeXLinkPolicy{err: errors.New("postgres down")}
		pubErr := newXLinkTestPublisher(t, "x", &xLinksPoster{}, policyErr, nil)
		_, err := pubErr.PublishThread(ctx, socialapi.PublishInput{
			OrganizationID: "org-1", DestinationID: "dest-1", Platform: "x", PostID: "post-err",
			SecretReference: "sec-1", Caption: "See https://example.com",
		})
		var apiErr *socialapi.Error
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTooManyRequests || apiErr.Code != publishing.FailurePublisherUnavailable {
			t.Fatalf("got err=%v, want 429 FailurePublisherUnavailable", err)
		}
	})
}
