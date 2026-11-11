package x

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// publishingLimits binds the current stored identity to a fresh signed users/me
// response. Workflow payloads and editable settings cannot authorize a write.
// Callers reload the integration from the database before invoking the adapter.
func publishingLimits(ctx context.Context, token string, in *ent.Integration) (socialidentity.XCapabilities, error) {
	if in == nil || (in.ProviderIdentifier != "x" && in.ProviderIdentifier != "twitter") ||
		in.DeletedAt != nil || in.Disabled || in.RefreshNeeded || in.InBetweenSteps ||
		token == "" || token != in.Token || integrations.RequireVerifiedIdentity(in) != nil {
		return socialidentity.XCapabilities{}, publishRejected("Reconnect X to verify this account's identity and publishing permissions.")
	}
	identity, err := newClient(token).verifiedIdentity(ctx, in.InternalID)
	if err != nil {
		if errors.Is(err, integrations.ErrAppCredentialsRefused) {
			return socialidentity.XCapabilities{}, temporalx.AppAccess(identifier, "X refused Shots' app access, so nothing was sent. No account needs reconnecting.")
		}
		var authErr integrations.AuthMessage
		if errors.As(err, &authErr) {
			return socialidentity.XCapabilities{}, temporalx.RefreshToken(identifier, "{}", "{}", string(authErr))
		}
		// Rate limits, service failures and cancellation never fall back to the
		// stored subscription. They occur before a content mutation.
		return socialidentity.XCapabilities{}, err
	}
	return *identity.Verification.Capabilities.X, nil
}

func publishRejected(message string) error {
	return temporalx.PublicationRejected(identifier, message)
}

// AccountMaxLength gives admission checks the stored, tenant-bound allowance.
// Execution still rechecks the signed live account through publishingLimits.
func (p *Provider) AccountMaxLength(in *ent.Integration, settingsRaw json.RawMessage) (int, error) {
	if in == nil || (in.ProviderIdentifier != "x" && in.ProviderIdentifier != "twitter") ||
		in.DeletedAt != nil || in.Disabled || in.RefreshNeeded || in.InBetweenSteps ||
		in.Token == "" || integrations.RequireVerifiedIdentity(in) != nil {
		return 280, errors.New("Reconnect X to verify this account's identity and publishing permissions.")
	}
	caps := in.VerifiedCapabilities.X
	if str(decodeSettings(settingsRaw).PostType) == "article" {
		if caps.Articles == nil || !*caps.Articles {
			return 280, errors.New("This X account does not have verified Article publishing access.")
		}
		return 100000, nil
	}
	return caps.PostTextLimit(), nil
}

func checkPublishingContent(caps socialidentity.XCapabilities, message string, settings pendingSettings, mediaCount int, article bool) error {
	if err := socialidentity.CheckXPhotoTagIDs(settings.TaggedUserIDs); err != nil {
		return publishRejected(err.Error())
	}
	if len(settings.TaggedUserIDs) > 0 && (mediaCount == 0 || article) {
		return publishRejected("Photo tags require static images on a regular X post.")
	}
	if str(settings.QuoteTweetID) != "" && !socialidentity.XEnterpriseQuotesEnabled() {
		return publishRejected("X quote posts require verified Enterprise API access, which this connection has not established.")
	}
	if article {
		if caps.Articles == nil || !*caps.Articles {
			return publishRejected("This X account does not have verified Article publishing access.")
		}
		if strings.TrimSpace(str(settings.ArticleTitle)) == "" ||
			(str(settings.ArticleStatus) != "draft" && str(settings.ArticleStatus) != "published") {
			return publishRejected("Choose an X Article title and draft or published status.")
		}
		// This is the application's Article bound, not an inferred provider cap.
		plain := toTweetText(message)
		if !utf8.ValidString(message) || !helpers.ValidTweetText(plain, 100000) {
			return publishRejected("An X Article must contain valid text within the application's 100000 weighted-character limit.")
		}
		return nil
	}
	if err := socialidentity.CheckXText(caps, message); err != nil {
		return publishRejected(err.Error())
	}
	if message == "" && mediaCount == 0 {
		return publishRejected("Add text or media to the X post.")
	}
	if mediaCount > caps.MaxImages {
		return publishRejected("Choose up to four images, one GIF, or one video for each X post.")
	}
	return nil
}
