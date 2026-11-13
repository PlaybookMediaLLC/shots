package tenantpublishing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// automatingPoster is a provider with every follow-up (RFC 025).
type automatingPoster struct {
	fakePoster
	actions        []string
	likes, reposts int
}

func (f *automatingPoster) RetweetPost(_ context.Context, _ *socialent.Integration, id string) error {
	f.actions = append(f.actions, "retweet:"+id)
	return nil
}

func (f *automatingPoster) UnretweetPost(_ context.Context, _ *socialent.Integration, id string) error {
	f.actions = append(f.actions, "unretweet:"+id)
	return nil
}

func (f *automatingPoster) PostEngagement(context.Context, *socialent.Integration, string) (int, int, error) {
	return f.likes, f.reposts, nil
}

func (f *automatingPoster) ReplyTo(_ context.Context, _ *socialent.Integration, id, text string) (string, error) {
	f.actions = append(f.actions, "reply:"+id+":"+text)
	return "plug-reply-1", nil
}

type thumbnailPoster struct {
	fakePoster
	set []string
	err error
}

func (f *thumbnailPoster) SetThumbnail(_ context.Context, token, videoID, thumbnail string) error {
	f.set = append(f.set, token+">"+videoID+">"+thumbnail)
	return f.err
}

// A thumbnail is set on the live video with a freshly signed image, and a
// provider without thumbnails or a step without an image says so.
func TestAutomateSetsAThumbnail(t *testing.T) {
	p, _, _, _ := directFixture()
	provider := &thumbnailPoster{}
	p.resolve = func(string) poster { return provider }
	p.integrations = fakeIntegrations{&socialent.Integration{ID: "destination", OrganizationID: "social-org", ProviderIdentifier: "youtube", InternalID: "remote-user", Token: "private-token"}}
	input := socialapi.AutomationInput{DestinationID: "destination", OrganizationID: "product-org", Platform: "youtube", Kind: "thumbnail",
		RemotePostID: "vid1", SecretReference: "SOCIAL_API_KEY", Media: &publishing.MediaAsset{MediaType: "image/png", ObjectKey: "org/product-org/thumb.png"}}
	if result, err := p.Automate(context.Background(), input); err != nil || !result.Done ||
		len(provider.set) != 1 || provider.set[0] != "private-token>vid1>https://r2.example/private/image.png?fresh-signature" {
		t.Fatalf("result=%+v err=%v set=%v", result, err, provider.set)
	}
	provider.err = errors.New("youtube.thumbnail")
	if _, err := p.Automate(context.Background(), input); err == nil {
		t.Fatal("a refused thumbnail reported success")
	}
	input.Media = nil
	if _, err := p.Automate(context.Background(), input); !errors.Is(err, socialapi.ErrUnsupported) {
		t.Fatalf("no image = %v", err)
	}
	p.resolve = func(string) poster { return &fakePoster{} }
	input.Media = &publishing.MediaAsset{MediaType: "image/png", ObjectKey: "org/product-org/thumb.png"}
	if _, err := p.Automate(context.Background(), input); !errors.Is(err, socialapi.ErrUnsupported) {
		t.Fatalf("no thumbnails = %v", err)
	}
}

func TestAutomateRunsEachFollowUpOnTheProvider(t *testing.T) {
	p, _, _, _ := directFixture()
	provider := &automatingPoster{likes: 120, reposts: 4}
	p.resolve = func(string) poster { return provider }
	ctx := context.Background()
	input := socialapi.AutomationInput{DestinationID: "destination", OrganizationID: "product-org", Platform: "linkedin",
		RemotePostID: "remote-post-1", SecretReference: "SOCIAL_API_KEY"}
	run := func(change func(*socialapi.AutomationInput)) socialapi.AutomationResult {
		t.Helper()
		request := input
		change(&request)
		result, err := p.Automate(ctx, request)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := run(func(in *socialapi.AutomationInput) { in.Kind, in.Text = "first_comment", "Link in the comments" }); !result.Done ||
		result.RemoteID != "reply-1" || provider.replies[0] != "Link in the comments>remote-post-1" {
		t.Fatalf("first comment = %+v %v", result, provider.replies)
	}
	run(func(in *socialapi.AutomationInput) { in.Kind = "retweet" })
	run(func(in *socialapi.AutomationInput) { in.Kind = "unretweet" })
	// 4 reposts is under 5; 120 likes is over 100.
	if result := run(func(in *socialapi.AutomationInput) {
		in.Kind, in.Metric, in.Threshold, in.Text = "plug", "reposts", 5, "Guide"
	}); result.Done {
		t.Fatal("a plug went out under its repost threshold")
	}
	if result := run(func(in *socialapi.AutomationInput) { in.Kind, in.Threshold, in.Text = "plug", 100, "Guide" }); !result.Done || result.RemoteID != "plug-reply-1" {
		t.Fatalf("plug = %+v", result)
	}
	want := []string{"retweet:remote-post-1", "unretweet:remote-post-1", "reply:remote-post-1:Guide"}
	if len(provider.actions) != len(want) {
		t.Fatalf("actions = %v", provider.actions)
	}
	for index := range want {
		if provider.actions[index] != want[index] {
			t.Fatalf("actions = %v", provider.actions)
		}
	}
	// A provider without reposts says so rather than pretending.
	p.resolve = func(string) poster { return &fakePoster{} }
	if _, err := p.Automate(ctx, socialapi.AutomationInput{DestinationID: "destination", Kind: "retweet",
		OrganizationID: "product-org", Platform: "linkedin", SecretReference: "SOCIAL_API_KEY"}); !errors.Is(err, socialapi.ErrUnsupported) {
		t.Fatalf("unsupported = %v", err)
	}
}

// An image's description goes to the provider with the image.
func TestSignedMediaCarriesAltText(t *testing.T) {
	p, _, _, _ := directFixture()
	media, err := p.signedMedia(context.Background(), "product-org", []publishing.MediaAsset{
		{Alt: "A chart of signups", MediaType: "image/png", ObjectKey: "org/product-org/chart.png"},
	})
	if err != nil || len(media) != 1 || media[0].Alt != "A chart of signups" {
		t.Fatalf("media = %+v err=%v", media, err)
	}
}

type quotePoster struct {
	details []integrations.PostDetails
	err     error
	receipt bool
}

func (p *quotePoster) Post(_ context.Context, _, _ string, posts []integrations.PostDetails, _ *socialent.Integration) ([]integrations.PostResponse, error) {
	p.details = append(p.details, posts...)
	if p.err != nil {
		return nil, p.err
	}
	if !p.receipt {
		return nil, nil
	}
	return []integrations.PostResponse{{PostID: "urn:li:share:99", Status: "posted"}}, nil
}
func TestQuoteAutomationUsesNativeIdentityAndPreservesFailures(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		for _, state := range []string{"posted", "unknown", "missing receipt"} {
			t.Run(fmt.Sprintf("legacy=%t/%s", legacy, state), func(t *testing.T) {
				p, _, _, input := directFixture()
				provider := &quotePoster{receipt: state == "posted"}
				if state == "unknown" {
					provider.err = temporalx.UnknownDelivery("linkedin", "timeout")
				}
				p.resolve = func(string) poster { return provider }
				var done bool
				var err error
				if legacy {
					var result socialapi.AutoActionResult
					result, err = p.AutoAct(context.Background(), socialapi.AutoActionInput{OrganizationID: input.OrganizationID, DestinationID: input.DestinationID, Platform: input.Platform, SecretReference: input.SecretReference, RemotePostID: "urn:li:share:42", Quote: true, QuoteText: "A useful update", PostURL: "https://example.com/not-a-quote"})
					done = result.Quoted
				} else {
					var result socialapi.AutomationResult
					result, err = p.Automate(context.Background(), socialapi.AutomationInput{OrganizationID: input.OrganizationID, DestinationID: input.DestinationID, Platform: input.Platform, SecretReference: input.SecretReference, RemotePostID: "urn:li:share:42", Kind: "quote", Text: "A useful update"})
					done = result.Done
				}
				if done != (state == "posted") || (state != "posted" && temporalx.FailureType(err) != temporalx.TypeUnknownDelivery) {
					t.Fatalf("done=%t err=%v", done, err)
				}
				if len(provider.details) != 1 || provider.details[0].Message != "A useful update" {
					t.Fatalf("posts=%+v", provider.details)
				}
				var settings map[string]any
				_ = json.Unmarshal(provider.details[0].Settings, &settings)
				if settings["reshare_parent"] != "urn:li:share:42" {
					t.Fatalf("settings=%+v", settings)
				}
			})
		}
	}
}
func TestNativeQuoteSettingsAcrossSupportedProviders(t *testing.T) {
	for platform, key := range map[string]string{"x": "quote_tweet_id", "linkedin": "reshare_parent", "linkedin-page": "reshare_parent", "bluesky": "quote_uri", "mastodon-custom": "quote_uri"} {
		raw, err := nativeQuoteSettings(platform, json.RawMessage(`{}`), "confirmed-id")
		var settings map[string]any
		_ = json.Unmarshal(raw, &settings)
		if err != nil || settings[key] != "confirmed-id" {
			t.Fatalf("%s settings=%s err=%v", platform, raw, err)
		}
	}
	if _, err := nativeQuoteSettings("threads", json.RawMessage(`{}`), "123"); !errors.Is(err, socialapi.ErrUnsupported) {
		t.Fatal("unsupported provider substituted a link")
	}
}

type deletingPoster struct {
	automatingPoster
	answer error
}

func (f *deletingPoster) DeletePost(_ context.Context, _ *socialent.Integration, id string) error {
	f.actions = append(f.actions, "delete:"+id)
	return f.answer
}

// Deleting a record of a live post goes to the account's provider and passes
// the provider's answer back with its status; a platform without a delete
// call is unsupported.
func TestAutomateDeletesARecord(t *testing.T) {
	p, _, _, _ := directFixture()
	provider := &deletingPoster{answer: &integrations.HTTPError{Status: 404}}
	p.resolve = func(string) poster { return provider }
	ctx := context.Background()
	input := socialapi.AutomationInput{DestinationID: "destination", Kind: "delete", OrganizationID: "product-org",
		Platform: "linkedin", RemotePostID: "remote-post-1", SecretReference: "SOCIAL_API_KEY"}
	var status interface{ HTTPStatus() int }
	if _, err := p.Automate(ctx, input); !errors.As(err, &status) || status.HTTPStatus() != 404 {
		t.Fatalf("delete error = %v", err)
	}
	provider.answer = nil
	if result, err := p.Automate(ctx, input); err != nil || !result.Done {
		t.Fatalf("delete = %+v, %v", result, err)
	}
	if fmt.Sprint(provider.actions) != "[delete:remote-post-1 delete:remote-post-1]" {
		t.Fatalf("actions = %v", provider.actions)
	}
	p.resolve = func(string) poster { return &fakePoster{} }
	if _, err := p.Automate(ctx, input); !errors.Is(err, socialapi.ErrUnsupported) {
		t.Fatalf("delete on a platform without the call: %v", err)
	}
}
