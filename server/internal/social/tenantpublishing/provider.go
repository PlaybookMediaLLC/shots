// Package tenantpublishing calls the social provider adapters from the tenant
// Temporal worker. The canonical scheduled_post is the only local post state.
package tenantpublishing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	managedslack "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social/slack"

	productent "github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/articlebody"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	socialdatabase "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database"
	socialintegration "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/database/integration"
	socialent "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ent/integration"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations/social"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

type BindingLookup interface {
	Binding(context.Context, string) (*productent.SocialTenantBinding, error)
}

type IntegrationLookup interface {
	FindIntegration(context.Context, string, string, string) (*socialent.Integration, error)
}

type MediaSigner interface {
	SignDelivery(context.Context, string, string) (string, error)
}

type poster interface {
	Post(context.Context, string, string, []integrations.PostDetails, *socialent.Integration) ([]integrations.PostResponse, error)
}

type Publisher struct {
	bindings     BindingLookup
	integrations IntegrationLookup
	signer       MediaSigner
	resolve      func(string) poster
	now          func() time.Time
	// channels and refresh renew expiring credentials (RefreshSocialTokens).
	channels *socialent.Client
	refresh  *socialintegration.RefreshIntegrationService
}

func New(bindings BindingLookup, socialClient *socialent.Client, signer MediaSigner, lifecycle ...managedslack.Lifecycle) *Publisher {
	manager := social.NewManager(lifecycle...)
	return &Publisher{
		bindings: bindings, integrations: EntIntegrationLookup{Client: socialClient},
		signer: signer, resolve: func(platform string) poster { return manager.GetSocialIntegration(platform) }, now: time.Now,
		channels: socialClient, refresh: newRefresh(socialClient, manager),
	}
}

// OpenShared reads social integrations from the same DSN as canonical product
// data. The caller owns the returned close function.
func OpenShared(ctx context.Context, databaseURL string, bindings BindingLookup, signer MediaSigner) (*Publisher, func() error, error) {
	db, err := socialdatabase.Open(ctx, databaseURL)
	if err != nil {
		return nil, nil, err
	}
	return New(bindings, db.Client, signer, notifications.New(db.SQL, nil)), db.Close, nil
}

type EntIntegrationLookup struct{ Client *socialent.Client }

func (r EntIntegrationLookup) FindIntegration(ctx context.Context, orgID, destinationID, platform string) (*socialent.Integration, error) {
	item, err := r.Client.Integration.Query().Where(
		integration.ID(destinationID), integration.OrganizationID(orgID),
		integration.ProviderIdentifier(platform), integration.DeletedAtIsNil(),
	).Only(ctx)
	if socialent.IsNotFound(err) {
		// The account was removed on the social side: reconnecting it is the fix.
		return nil, socialapi.NewCodedError(http.StatusNotFound, publishing.FailureAccountReconnect, "social destination was not found")
	}
	return item, err
}

// PublishesSynchronously tells the Temporal activity that Publish returns the
// real provider receipt, so it must complete the canonical attempt directly.
func (*Publisher) PublishesSynchronously() bool { return true }

func (p *Publisher) Publish(ctx context.Context, input socialapi.PublishInput) (string, error) {
	receipt, err := p.PublishThread(ctx, input)
	return receipt.PostID, err
}

// account resolves the workspace's connected account and its provider for a
// publication, refusing a credential that is not the workspace's or has lapsed.
func (p *Publisher) account(ctx context.Context, organizationID, destinationID, platform, secretReference string,
	providerSettings map[string]any) (*socialent.Integration, poster, json.RawMessage, error) {
	return p.resolveAccount(ctx, organizationID, destinationID, platform, secretReference, providerSettings, true)
}

// analyticsAccount shares credential/tenant checks without applying the narrower publishing rollout gate.
func (p *Publisher) analyticsAccount(ctx context.Context, organizationID, destinationID, platform, secretReference string) (*socialent.Integration, poster, json.RawMessage, error) {
	return p.resolveAccount(ctx, organizationID, destinationID, platform, secretReference, nil, false)
}

func (p *Publisher) resolveAccount(ctx context.Context, organizationID, destinationID, platform, secretReference string,
	providerSettings map[string]any, publication bool) (*socialent.Integration, poster, json.RawMessage, error) {
	if p.bindings == nil || p.integrations == nil || p.signer == nil || p.resolve == nil {
		return nil, nil, nil, socialapi.NewCodedError(http.StatusServiceUnavailable, publishing.FailurePublisherUnavailable, "direct publisher is not configured")
	}
	binding, err := p.bindings.Binding(ctx, organizationID)
	if err != nil {
		return nil, nil, nil, socialapi.NewCodedError(http.StatusConflict, publishing.FailurePublisherUnavailable, "workspace has no social connection binding")
	}
	if binding == nil || binding.SecretReference != secretReference {
		return nil, nil, nil, socialapi.NewError(http.StatusForbidden, false, "social credential does not belong to workspace")
	}
	account, err := p.integrations.FindIntegration(ctx, binding.GoOrganizationID, destinationID, platform)
	if err != nil {
		return nil, nil, nil, err
	}
	expired := account != nil && account.TokenExpiration != nil && !account.TokenExpiration.After(p.currentTime())
	if account == nil || account.ID != destinationID || account.OrganizationID != binding.GoOrganizationID || account.ProviderIdentifier != platform || account.DeletedAt != nil || account.InBetweenSteps || account.Disabled || account.RefreshNeeded || account.Token == "" || expired {
		// A lapsed token nothing can renew needs a person; one with a refresh
		// token is the maintenance refresh's to renew (or to flag when it cannot).
		if expired && account.ID == destinationID && account.RefreshToken == nil && !account.RefreshNeeded {
			p.requireReconnect(ctx, account)
		}
		return nil, nil, nil, socialapi.NewCodedError(http.StatusConflict, publishing.FailureAccountReconnect, "social credentials have expired or been disabled")
	}
	if integrations.RequireVerifiedIdentity(account) != nil {
		return nil, nil, nil, socialapi.NewCodedError(http.StatusConflict, publishing.FailureAccountReconnect, "reconnect this account to verify its identity, publishing permissions and limits")
	}
	provider := p.resolve(platform)
	if provider == nil || (publication && !directPlatformAllowed(platform)) {
		return nil, nil, nil, socialapi.NewError(http.StatusBadRequest, false, "social provider is unsupported")
	}
	if providerSettings == nil {
		providerSettings = map[string]any{}
	}
	settings, err := json.Marshal(providerSettings)
	if err != nil {
		return nil, nil, nil, socialapi.NewError(http.StatusBadRequest, false, "invalid provider settings")
	}
	return account, provider, settings, nil
}

// appVerifier is a provider that signs requests with Shots' own app keys as
// well as the account's token, so a refused token may be the app's fault.
type appVerifier interface {
	VerifyAppCredentials(ctx context.Context) error
}

// requireReconnect flags a channel whose credentials the provider refused or
// that lapsed with nothing to renew them, so the workspace hears of it
// (integration.reconnect_required, raised by the Integration trigger) rather
// than only through this post. It uses the refresh's own conditional write: a
// reconnect or refresh since the account was read wins. A failed flag never
// changes the post's outcome, which is already decided; it is logged.
func (p *Publisher) requireReconnect(ctx context.Context, account *socialent.Integration) {
	if p.refresh == nil || account == nil {
		return
	}
	if err := p.refresh.RequireReconnect(ctx, account); err != nil && !errors.Is(err, socialintegration.ErrRefreshChanged) {
		slog.WarnContext(ctx, "could not flag a channel for reconnection", "integration_id", account.ID, "error", err)
	}
}

// pollDetails rounds positive durations to whole hours for legacy providers.
// Invalid choices and durations must reach provider validation, not disappear.
func pollDetails(poll *postoptions.Poll) *integrations.PollDetails {
	if poll == nil {
		return nil
	}
	hours := 0
	if poll.DurationMinutes > 0 {
		hours = 1 + (poll.DurationMinutes-1)/60
	}
	return &integrations.PollDetails{Options: poll.Options, Duration: hours}
}

// publicationOutcome maps a provider failure: a definite refusal, a rate limit
// the workflow retries durably, reconnect, or an outcome the remote account
// must be checked for before any retry. The provider's message rides along
// for the attempt record.
func publicationOutcome(err error) *socialapi.Error {
	if temporalx.FailureType(err) == "" && errors.Is(err, helpers.ErrTextTooComplex) {
		// Shots, not the platform, ran out of time counting the text before it
		// sent anything, most likely under load: the post retries, and stops
		// with this cause if its text can never be counted.
		retry := socialapi.NewCodedError(http.StatusTooManyRequests, publishing.FailurePublisherError,
			"Shots could not finish checking this post's text in time, so nothing was sent. If this keeps happening, shorten the post or remove some links.")
		retry.ProviderMessage = retry.Error()
		return retry
	}
	var mapped *socialapi.Error
	switch temporalx.FailureType(err) {
	case temporalx.TypeRateLimited:
		mapped = socialapi.NewError(http.StatusTooManyRequests, false, "The platform rate-limited the publication; nothing was created.")
		mapped.RetryAfter = temporalx.RetryAfter(err)
	case temporalx.TypeDailyLimit:
		mapped = socialapi.NewCodedError(http.StatusConflict, publishing.FailureProviderDailyLimit, "The account reached the platform's daily posting limit; nothing was created.")
	case temporalx.TypePublicationRejected:
		mapped = socialapi.NewError(http.StatusBadRequest, false, "The platform rejected the publication. Review its text, media and publishing configuration before retrying.")
	case temporalx.TypeAppAccess:
		return appAccessRefused(err)
	case temporalx.TypeRefreshToken, temporalx.TypeDisconnect:
		mapped = socialapi.NewCodedError(http.StatusConflict, publishing.FailureAccountReconnect, "social credentials must be reconnected")
	default:
		// The provider may have accepted the post before the call failed. A
		// reconciliation step must inspect the remote account before retrying.
		mapped = socialapi.NewError(http.StatusBadGateway, true, "social publication outcome is unknown")
	}
	mapped.ProviderMessage = temporalx.FailureMessage(err)
	return mapped
}

// appAccessRefused is a definite failure of Shots' own app credentials or
// access: nothing was created and no account is flagged. The saved message
// says so before the platform's own words, which may tell a person to reconnect.
func appAccessRefused(err error) *socialapi.Error {
	refused := socialapi.NewCodedError(http.StatusServiceUnavailable, publishing.FailurePublisherUnavailable,
		"The platform refused Shots' app credentials, so nothing was sent. No account needs reconnecting.")
	refused.ProviderMessage = refused.Error() + " The platform said: " + temporalx.FailureMessage(err)
	return refused
}

// PublishThread publishes the post, or answers ReplyTo when it resumes a
// thread, then its replies; the receipt says how far the thread got.
func (p *Publisher) PublishThread(ctx context.Context, input socialapi.PublishInput) (socialapi.Receipt, error) {
	if input.OrganizationID == "" || input.DestinationID == "" || input.Platform == "" || input.PostID == "" {
		return socialapi.Receipt{}, socialapi.NewError(http.StatusBadRequest, false, "incomplete publication request")
	}
	account, provider, settings, err := p.account(ctx, input.OrganizationID, input.DestinationID, input.Platform,
		input.SecretReference, input.ProviderSettings)
	if err != nil {
		return socialapi.Receipt{}, err
	}
	// A content draft post without an image publishes as text (RFC 013); a
	// LinkedIn document goes out as the post's one media (RFC 025).
	var youtubeOptions *postoptions.YouTubeOptions
	var tiktokOptions *postoptions.TikTokOptions
	if input.Options != nil {
		youtubeOptions, tiktokOptions = input.Options.YouTube, input.Options.TikTok
	}
	if err := postoptions.ValidateVideoOptions(input.Platform, youtubeOptions, tiktokOptions, true); err != nil {
		return socialapi.Receipt{}, socialapi.NewCodedError(http.StatusBadRequest, publishing.FailurePostOptions, err.Error())
	}
	assets := input.Media()
	if input.Platform == "tiktok" || input.Platform == "youtube" {
		if len(assets) != 1 || assets[0].MediaType != "video/mp4" || len(input.Replies) > 0 || input.ReplyTo != "" || input.Poll != nil {
			return socialapi.Receipt{}, socialapi.NewCodedError(http.StatusBadRequest, publishing.FailureMediaUnsupported, "choose one MP4 video")
		}
	}
	if input.Platform == "tiktok" {
		reader, ok := provider.(interface {
			CreatorInfo(context.Context, string) (*postoptions.TikTokCreator, error)
		})
		if !ok {
			return socialapi.Receipt{}, socialapi.NewError(http.StatusBadRequest, false, "TikTok creator information unavailable")
		}
		creator, err := reader.CreatorInfo(ctx, account.Token)
		if err != nil {
			return socialapi.Receipt{}, socialapi.NewCodedError(http.StatusBadGateway, publishing.FailureProviderPermissions, "TikTok creator information unavailable")
		}
		duration := 0
		if assets[0].DurationMs != nil {
			duration = *assets[0].DurationMs
		}
		if err := creator.Check(input.Options.TikTok, duration); err != nil {
			code := publishing.FailurePostOptions
			switch {
			case errors.Is(err, postoptions.ErrVideoTooLong):
				code = publishing.FailureVideoTooLong
			case errors.Is(err, postoptions.ErrCreatorPermissions):
				code = publishing.FailureProviderPermissions
			}
			return socialapi.Receipt{}, socialapi.NewCodedError(http.StatusBadRequest, code, err.Error())
		}
	}
	if input.Document != nil {
		assets = []publishing.MediaAsset{*input.Document}
	}
	media, err := p.signedMedia(ctx, input.OrganizationID, assets)
	if err != nil {
		return socialapi.Receipt{}, err
	}
	if settings, err = postSettings(input.Platform, input.ProviderSettings, input.Options, ""); err != nil {
		return socialapi.Receipt{}, socialapi.NewError(http.StatusBadRequest, false, "invalid post settings")
	}
	if settings, err = p.articleCover(ctx, input, settings); err != nil {
		return socialapi.Receipt{}, socialapi.NewError(http.StatusServiceUnavailable, false, "article cover could not be signed")
	}
	// Signing media can take time. Reload the grant immediately before handoff,
	// allowing credential refresh but never a different destination identity.
	account, provider, err = p.publicationAccount(ctx, input, account)
	if err != nil {
		return socialapi.Receipt{}, err
	}
	message := input.Caption
	if input.Options != nil && input.Options.ArticleHTML != "" {
		signed := map[string]string{}
		for i, asset := range assets {
			if i < len(media) {
				signed[asset.AssetID] = media[i].Path
			}
		}
		message, err = articlebody.Render(input.Options.ArticleHTML, signed)
		if err != nil {
			return socialapi.Receipt{}, socialapi.NewError(http.StatusBadRequest, false, err.Error())
		}
		// Images are now in the article body; do not append them a second time.
		media = nil
	}
	details := []integrations.PostDetails{{
		ID: input.PostID, Message: message, Settings: settings, Media: media, Poll: pollFor(input.Poll, input.Options),
	}}
	var response []integrations.PostResponse
	if input.ReplyTo != "" {
		commenter, ok := provider.(integrations.Commenter)
		if !ok {
			return socialapi.Receipt{}, socialapi.NewError(http.StatusBadRequest, false, "this provider cannot continue a thread")
		}
		response, err = commenter.Comment(ctx, account.InternalID, input.ReplyTo, "", account.Token, details, account)
		if err == nil && len(response) == 1 && response[0].PostID != "" && response[0].Status == "" {
			response[0].Status = "posted"
		}
	} else {
		response, err = provider.Post(ctx, account.InternalID, account.Token, details, account)
	}
	if err != nil {
		kind := temporalx.FailureType(err)
		// A provider that signs with Shots' app keys too (X) refuses every
		// account when the keys are bad: that is not this account's to fix.
		if verifier, ok := provider.(appVerifier); ok && kind == temporalx.TypeRefreshToken {
			if appErr := verifier.VerifyAppCredentials(ctx); appErr != nil {
				if errors.Is(appErr, integrations.ErrAppCredentialsRefused) {
					slog.ErrorContext(ctx, "provider refused the app credentials; every post to it fails until they are fixed", "platform", input.Platform, "error", appErr)
					return socialapi.Receipt{}, appAccessRefused(err)
				}
				// The check itself failed, so the cause is unknown. The refusal
				// proves nothing was created, so the post retries durably.
				slog.WarnContext(ctx, "could not check the provider's app credentials", "platform", input.Platform, "error", appErr)
				unchecked := socialapi.NewCodedError(http.StatusTooManyRequests, publishing.FailurePublisherUnavailable,
					"The platform refused the request and Shots could not yet tell whether its app credentials or the account's token are at fault. Nothing was sent; it retries.")
				unchecked.ProviderMessage = unchecked.Error() + " The platform said: " + temporalx.FailureMessage(err)
				return socialapi.Receipt{}, unchecked
			}
		}
		// A disconnect, or a refused token nothing can renew, needs a person. A
		// token with a refresh token is the maintenance refresh's to renew, or to
		// flag when the provider refuses that too.
		if kind == temporalx.TypeDisconnect || kind == temporalx.TypeRefreshToken && account.RefreshToken == nil {
			p.requireReconnect(ctx, account)
		}
		return socialapi.Receipt{}, publicationOutcome(err)
	}
	if len(response) != 1 || response[0].PostID == "" ||
		response[0].Status != "posted" && response[0].Status != "success" && response[0].Status != "completed" {
		return socialapi.Receipt{}, socialapi.NewError(http.StatusBadGateway, true, "provider returned no confirmed post receipt")
	}
	if input.Platform == "tiktok" {
		id := response[0].PostID
		if id == "" || strings.Trim(id, "0123456789") != "" || !strings.Contains(response[0].ReleaseURL, "/video/"+id) {
			return socialapi.Receipt{}, socialapi.NewError(http.StatusBadGateway, true, "TikTok has not returned a final video receipt")
		}
	}
	var publication *postoptions.PublicationReceipt
	// Threads and Instagram ids do not make a link, so the provider's own address is kept.
	if input.Platform == "tiktok" || input.Platform == "youtube" || input.Platform == "threads" ||
		input.Platform == "instagram" || input.Platform == "instagram-standalone" {
		publication = &postoptions.PublicationReceipt{RemoteID: response[0].PostID, URL: response[0].ReleaseURL}
	}
	if input.Platform == "youtube" {
		checker, ok := provider.(interface {
			ConfirmVideo(context.Context, string, string, string) (string, error)
		})
		if !ok {
			return socialapi.Receipt{PostID: response[0].PostID, Thread: postoptions.ThreadProgress{Publication: publication}}, socialapi.NewError(http.StatusBadGateway, true, "YouTube processing could not be confirmed")
		}
		visibility, confirmErr := checker.ConfirmVideo(ctx, account.Token, response[0].PostID, account.InternalID)
		publication.Visibility = visibility
		if confirmErr != nil {
			return socialapi.Receipt{PostID: response[0].PostID, Thread: postoptions.ThreadProgress{Publication: publication}}, publicationOutcome(confirmErr)
		}
	}
	if input.Platform == "tiktok" {
		publication.Visibility = tiktokOptions.Privacy
	}
	progress := p.postReplies(ctx, provider, account, input, response[0].PostID)
	progress.Publication = publication
	if response[0].QuoteState != "" {
		progress.Quotes = append(progress.Quotes, postoptions.QuoteReceipt{PostID: response[0].PostID, State: response[0].QuoteState})
	}
	return socialapi.Receipt{PostID: response[0].PostID, Thread: progress}, nil
}

func (p *Publisher) publicationAccount(ctx context.Context, input socialapi.PublishInput, expected *socialent.Integration) (*socialent.Integration, poster, error) {
	current, provider, _, err := p.account(ctx, input.OrganizationID, input.DestinationID, input.Platform, input.SecretReference, input.ProviderSettings)
	if err != nil {
		return nil, nil, err
	}
	if current.InternalID != expected.InternalID || current.OrganizationID != expected.OrganizationID {
		return nil, nil, socialapi.NewCodedError(http.StatusConflict, publishing.FailureAccountReconnect, "social destination identity changed before publication")
	}
	return current, provider, nil
}

// metricNames maps provider analytics labels to the draft's metric names.
var metricNames = map[string]string{
	"impressions": "impressions", "likes": "likes", "retweets": "reposts", "reposts": "reposts",
	"replies": "replies", "comments": "replies", "quotes": "quotes", "bookmarks": "bookmarks",
	"shares": "reposts", "reactions": "likes", "views": "views",
	"profile clicks": "profileClicks", "profile_clicks": "profileClicks", "url clicks": "linkClicks", "link clicks": "linkClicks", "url_link_clicks": "linkClicks",
}

// PostMetrics reads a live post's engagement through its provider; a
// provider without post analytics has none.
func (p *Publisher) PostMetrics(ctx context.Context, organizationID, destinationID, platform, secretReference,
	remotePostID string) (postoptions.Metrics, error) {
	account, provider, _, err := p.analyticsAccount(ctx, organizationID, destinationID, platform, secretReference)
	if err != nil {
		return nil, err
	}
	reader, ok := provider.(integrations.PostAnalytics)
	if !ok {
		return nil, postoptions.ErrMetricsUnavailable
	}
	series, err := reader.PostAnalytics(ctx, account.InternalID, account.Token, remotePostID, 0)
	if err != nil {
		return nil, err
	}
	metrics := postoptions.Metrics{}
	for _, item := range series {
		name, known := metricNames[strings.ToLower(item.Label)]
		if !known || len(item.Data) == 0 {
			continue
		}
		var total float64
		if _, err := fmt.Sscan(fmt.Sprint(item.Data[len(item.Data)-1].Total), &total); err == nil {
			if _, exists := metrics[name]; !exists {
				metrics[name] = total
			}
		}
	}
	if len(metrics) == 0 {
		return nil, postoptions.ErrMetricsUnavailable
	}
	return metrics, nil
}

// autoActor is a provider's like-gated follow-ups (X).
type autoActor interface {
	AutoRepostPost(context.Context, *socialent.Integration, string, map[string]string) (bool, error)
	AutoPlugPost(context.Context, *socialent.Integration, string, map[string]string) (bool, error)
}

// AutoAct runs a live post's follow-ups that are due: a repost and a plug
// reply once it has enough likes, and a native quote. Provider errors must not
// be mistaken for a completed quote.
func (p *Publisher) AutoAct(ctx context.Context, input socialapi.AutoActionInput) (socialapi.AutoActionResult, error) {
	result := socialapi.AutoActionResult{Plugged: !input.Plug, Quoted: !input.Quote, Reposted: !input.Repost}
	account, provider, settings, err := p.account(ctx, input.OrganizationID, input.DestinationID, input.Platform,
		input.SecretReference, nil)
	if err != nil {
		return result, err
	}
	auto, ok := provider.(autoActor)
	if input.Repost {
		result.Reposted = !ok
		if ok {
			done, err := auto.AutoRepostPost(ctx, account, input.RemotePostID, map[string]string{"likesAmount": fmt.Sprint(input.RepostAtLikes)})
			result.Reposted = err == nil && done
			if temporalx.FailureType(err) == temporalx.TypeUnknownDelivery {
				return result, err
			}
		}
	}
	if input.Plug {
		result.Plugged = !ok
		if ok {
			done, err := auto.AutoPlugPost(ctx, account, input.RemotePostID,
				map[string]string{"likesAmount": fmt.Sprint(input.PlugAtLikes), "post": input.PlugText})
			result.Plugged = err == nil && done
			if temporalx.FailureType(err) == temporalx.TypeUnknownDelivery {
				return result, err
			}
		}
	}
	if input.Quote {
		settings, err = nativeQuoteSettings(input.Platform, settings, input.RemotePostID)
		if err != nil {
			return result, err
		}
		posted, err := provider.Post(ctx, account.InternalID, account.Token, []integrations.PostDetails{{
			ID: input.RemotePostID + "-quote", Message: strings.TrimSpace(input.QuoteText), Settings: settings,
		}}, account)
		if err != nil {
			return result, err
		}
		if firstPostID(posted) == "" {
			return result, temporalx.UnknownDelivery(input.Platform, "The provider returned no quote receipt. Reconcile before resending.")
		}
		result.Quoted = true
	}
	return result, nil
}

// postReplies posts a thread's later posts, each answering the one before.
// The first post is already live, so a reply that fails ends the thread
// there rather than retrying the publication (which would post the first
// again). The progress it returns is kept on the post, and the composer
// offers to post the rest.
func (p *Publisher) postReplies(ctx context.Context, provider poster, account *socialent.Integration,
	input socialapi.PublishInput, postID string) postoptions.ThreadProgress {
	progress := postoptions.ThreadProgress{Total: len(input.Replies)}
	if len(input.Replies) == 0 {
		return progress
	}
	commenter, ok := provider.(integrations.Commenter)
	if !ok {
		slog.WarnContext(ctx, "provider cannot post thread replies", "platform", input.Platform, "post", input.PostID)
		return progress
	}
	last := ""
	for index, reply := range input.Replies {
		media, err := p.signedMedia(ctx, input.OrganizationID, reply.Assets)
		// A reply has only its own settings: never the first post's
		// community, quote or article.
		var replySettings json.RawMessage
		if err == nil {
			replySettings, err = postSettings(input.Platform, input.ProviderSettings, nil, "")
		}
		if err == nil && reply.Options != nil {
			// The first post is live now, so a reply quoting it can name it.
			replySettings, err = postSettings(input.Platform, input.ProviderSettings, reply.Options, postID)
		}
		if err == nil {
			account, provider, err = p.publicationAccount(ctx, input, account)
			if err == nil {
				commenter, ok = provider.(integrations.Commenter)
				if !ok {
					err = errors.New("provider cannot continue thread replies")
				}
			}
		}
		if err == nil {
			var response []integrations.PostResponse
			response, err = commenter.Comment(ctx, account.InternalID, postID, last, account.Token, []integrations.PostDetails{{
				ID: fmt.Sprintf("%s-reply-%d", input.PostID, index+1), Message: reply.Caption, Settings: replySettings, Media: media, Poll: pollFor(reply.Poll, reply.Options),
			}}, account)
			if err == nil && (len(response) == 0 || response[0].PostID == "") {
				err = errors.New("provider returned no reply receipt")
			}
			if err == nil {
				last = response[0].PostID
				if response[0].QuoteState != "" {
					progress.Quotes = append(progress.Quotes, postoptions.QuoteReceipt{PostID: last, State: response[0].QuoteState})
				}
				progress.Posted, progress.LastReplyID = index+1, last
				progress.Receipts = append(progress.Receipts, postoptions.ThreadReceipt{RemoteID: last, Position: index + 1, PublishedAt: p.currentTime()})
				continue
			}
		}
		slog.ErrorContext(ctx, "thread reply was not posted", "post", input.PostID, "reply", index+1, "error", err)
		return progress
	}
	return progress
}

// signedMedia signs each private file for the provider to fetch, in order.
func (p *Publisher) signedMedia(ctx context.Context, organizationID string, assets []publishing.MediaAsset) ([]integrations.MediaContent, error) {
	var media []integrations.MediaContent
	for _, asset := range assets {
		path, err := p.signer.SignDelivery(ctx, organizationID, asset.ObjectKey)
		if err != nil {
			return nil, socialapi.NewError(http.StatusServiceUnavailable, false, "private asset could not be signed")
		}
		mediaType := "image"
		if strings.HasPrefix(asset.MediaType, "video/") {
			mediaType = "video"
		}
		media = append(media, integrations.MediaContent{Alt: asset.Alt, Type: mediaType, Path: path})
	}
	return media, nil
}

func (p *Publisher) Status(context.Context, socialapi.StatusInput) (socialapi.StatusResult, error) {
	return socialapi.StatusResult{}, socialapi.NewError(http.StatusConflict, false, "direct provider receipts do not require local status polling")
}

func (p *Publisher) currentTime() time.Time {
	if p.now != nil {
		return p.now().UTC()
	}
	return time.Now().UTC()
}
