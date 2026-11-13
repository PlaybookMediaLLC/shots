package tenantpublishing

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// The follow-ups a provider can do (RFC 025); each is optional.
type (
	reposter interface {
		RetweetPost(ctx context.Context, integration *socialent.Integration, postID string) error
		UnretweetPost(ctx context.Context, integration *socialent.Integration, postID string) error
	}
	engagementReader interface {
		// PostEngagement is a post's like and repost counts.
		PostEngagement(ctx context.Context, integration *socialent.Integration, postID string) (likes, reposts int, err error)
	}
	replier interface {
		// ReplyTo posts text as a reply to postID and returns the reply's id.
		ReplyTo(ctx context.Context, integration *socialent.Integration, postID, text string) (string, error)
	}
)

// Automate runs one follow-up of a live post: a first comment, a thumbnail, a repost or
// its removal, a plug or like-gated repost once its threshold is met, a
// quote, or the delete of one of its records. Thresholds count likes unless Metric is reposts. A platform that
// cannot do the step reports socialapi.ErrUnsupported.
func (p *Publisher) Automate(ctx context.Context, input socialapi.AutomationInput) (socialapi.AutomationResult, error) {
	account, provider, settings, err := p.account(ctx, input.OrganizationID, input.DestinationID, input.Platform,
		input.SecretReference, nil)
	if err != nil {
		return socialapi.AutomationResult{}, err
	}
	post := input.RemotePostID
	switch input.Kind {
	case "first_comment":
		commenter, ok := provider.(integrations.Commenter)
		if !ok {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		posted, err := commenter.Comment(ctx, account.InternalID, post, "", account.Token, []integrations.PostDetails{{
			ID: post + "-first-comment", Message: input.Text, Settings: settings,
		}}, account)
		if err != nil {
			return socialapi.AutomationResult{}, err
		}
		return socialapi.AutomationResult{Done: true, RemoteID: firstPostID(posted)}, nil
	case "thumbnail":
		setter, ok := provider.(interface {
			SetThumbnail(ctx context.Context, accessToken, videoID, thumbnail string) error
		})
		if !ok || input.Media == nil {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		media, err := p.signedMedia(ctx, input.OrganizationID, []publishing.MediaAsset{*input.Media})
		if err != nil || len(media) == 0 {
			return socialapi.AutomationResult{}, cmp.Or(err, errors.New("the thumbnail could not be signed"))
		}
		return socialapi.AutomationResult{Done: true}, setter.SetThumbnail(ctx, account.Token, post, media[0].Path)
	case "retweet", "unretweet":
		reposts, ok := provider.(reposter)
		if !ok {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		if input.Kind == "retweet" {
			err = reposts.RetweetPost(ctx, account, post)
		} else {
			err = reposts.UnretweetPost(ctx, account, post)
		}
		return socialapi.AutomationResult{Done: err == nil}, err
	case "plug", "repost_at_likes":
		reader, ok := provider.(engagementReader)
		if !ok {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		likes, reposts, err := reader.PostEngagement(ctx, account, post)
		if err != nil {
			return socialapi.AutomationResult{}, err
		}
		count := likes
		if input.Metric == "reposts" {
			count = reposts
		}
		if count < input.Threshold {
			return socialapi.AutomationResult{}, nil
		}
		if input.Kind == "repost_at_likes" {
			reposter, ok := provider.(reposter)
			if !ok {
				return socialapi.AutomationResult{}, socialapi.ErrUnsupported
			}
			err := reposter.RetweetPost(ctx, account, post)
			return socialapi.AutomationResult{Done: err == nil}, err
		}
		replies, ok := provider.(replier)
		if !ok {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		id, err := replies.ReplyTo(ctx, account, post, input.Text)
		return socialapi.AutomationResult{Done: err == nil, RemoteID: id}, err
	case "quote":
		settings, err = nativeQuoteSettings(input.Platform, settings, post)
		if err != nil {
			return socialapi.AutomationResult{}, err
		}
		posted, err := provider.Post(ctx, account.InternalID, account.Token, []integrations.PostDetails{{
			ID: post + "-quote", Message: strings.TrimSpace(input.Text), Settings: settings,
		}}, account)
		if err != nil {
			return socialapi.AutomationResult{}, err
		}
		if firstPostID(posted) == "" {
			return socialapi.AutomationResult{}, temporalx.UnknownDelivery(input.Platform, "The provider returned no quote receipt. Reconcile before resending.")
		}
		return socialapi.AutomationResult{Done: true, RemoteID: firstPostID(posted)}, nil
	case "delete":
		// A part of a post Shots deletes (#557); the provider's error keeps its
		// HTTP status, so the delete workflow can classify it.
		deleter, ok := provider.(integrations.PostDeleter)
		if !ok {
			return socialapi.AutomationResult{}, socialapi.ErrUnsupported
		}
		err := deleter.DeletePost(ctx, account, post)
		return socialapi.AutomationResult{Done: err == nil}, err
	}
	return socialapi.AutomationResult{}, socialapi.ErrUnsupported
}

// Native quotes must carry the provider's reference, never a URL appended to
// ordinary text. Unsupported providers fail before making any mutation.
func nativeQuoteSettings(platform string, raw json.RawMessage, post string) (json.RawMessage, error) {
	switch platform {
	case "x", "linkedin", "linkedin-page", "bluesky", "mastodon", "mastodon-custom":
	default:
		return nil, socialapi.ErrUnsupported
	}
	if strings.TrimSpace(post) == "" {
		return nil, socialapi.ErrUnsupported
	}
	var base map[string]any
	if err := json.Unmarshal(raw, &base); err != nil {
		return nil, err
	}
	return postSettings(platform, base, &postoptions.PublishOptions{QuoteRemoteID: post}, "")
}

func firstPostID(posted []integrations.PostResponse) string {
	if len(posted) == 0 {
		return ""
	}
	return posted[0].PostID
}
