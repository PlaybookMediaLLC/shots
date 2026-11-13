package product

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
	"github.com/lucsky/cuid"
)

// Recovering a draft post (RFC 025). Each destination is its own scheduled
// post, so one that failed is retried alone and the others are left as they
// are. A post whose outcome is unknown may already be live: it is never
// retried until a person has checked the platform and said which it is.

var (
	xStatusID       = regexp.MustCompile(`/status/([0-9]{1,30})`)
	linkedInURN     = regexp.MustCompile(`urn:li:(?:share|ugcPost|activity):[0-9]{1,30}`)
	tikTokVideoPath = regexp.MustCompile(`^/@([A-Za-z0-9_.]{1,24})/video/([1-9][0-9]{0,29})/?$`)
	youTubeVideoID  = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	// postLinks are the links a person may give for a live post on platforms
	// with no id parser here, kept as the post's id: its exact hosts (never a
	// link-redirect host), a post's path (an optional first group names the
	// account), and whether the query is part of the address or tracking.
	postLinks = map[string]struct {
		hosts []string
		path  *regexp.Regexp
		query bool
	}{
		"threads": {[]string{"threads.net", "www.threads.net", "threads.com", "www.threads.com"},
			regexp.MustCompile(`^/@([A-Za-z0-9_.]{1,30})/post/[A-Za-z0-9_-]{1,64}/?$`), false},
		"instagram": {[]string{"instagram.com", "www.instagram.com"},
			regexp.MustCompile(`^/(?:[A-Za-z0-9_.]{1,30}/)?(?:p|reel|tv)/[A-Za-z0-9_-]{1,64}/?$`), false},
		"facebook": {[]string{"facebook.com", "www.facebook.com", "m.facebook.com"},
			regexp.MustCompile(`^/(?:[A-Za-z0-9.]{1,80}/(?:posts|videos)/[A-Za-z0-9]{1,64}|permalink\.php|story\.php|reel/[0-9]{1,30}|stories/[0-9]{1,30}|share/[prv]/[A-Za-z0-9]{1,32})/?$`), true},
		"pinterest": {[]string{"pinterest.com", "www.pinterest.com"}, regexp.MustCompile(`^/pin/[0-9]{1,30}/?$`), false},
		"gmb":       {[]string{"local.google.com", "business.google.com"}, regexp.MustCompile(`^/(?:place|locations/[0-9]{1,30})/?$`), true},
	}
)

// namesOtherAccount reports whether a link names an account other than the
// connection's, when its handle is known.
func namesOtherAccount(connection *ent.ChannelConnection, name string) bool {
	return connection.Handle != nil && *connection.Handle != "" && !strings.EqualFold(strings.TrimPrefix(*connection.Handle, "@"), name)
}

// draftPostForRecovery loads a draft post the actor may see, for a publisher.
func (c *Configuration) draftPostForRecovery(ctx context.Context, tx *ent.Tx, actor Actor, postID string) (*ent.ScheduledPost, error) {
	return c.draftPostWithAccess(ctx, tx, actor, postID, c.authorizeScheduling)
}

// draftPostWithAccess loads a draft post of the actor's workspace after
// authorize, for an action on a post that is already scheduled or live.
func (c *Configuration) draftPostWithAccess(ctx context.Context, tx *ent.Tx, actor Actor, postID string,
	authorize func(context.Context, Actor) error) (*ent.ScheduledPost, error) {
	if err := authorize(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(postID), scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ContentDraftIDNotNil()).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := c.loadDraft(ctx, actor, *post.ContentDraftID); err != nil {
		return nil, err
	}
	return post, nil
}

// RetryContentDraftPost publishes a failed post again, now, as a new post
// with the same snapshot. Only a post that failed is retried: one that is
// live, queued, publishing, or of unknown outcome is not. Each retry has its
// own idempotency key, so a double click retries once.
func (c *Configuration) RetryContentDraftPost(ctx context.Context, actor Actor, postID string) (*MovedDraftPost, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	post, err := c.draftPostForRecovery(ctx, tx, actor, postID)
	if err != nil {
		return nil, err
	}
	switch post.Status {
	case scheduledpost.StatusFAILED:
	case scheduledpost.StatusUNKNOWN_DELIVERY:
		return nil, conflict("This post may already be live. Check the channel, then say whether it went out before retrying.")
	default:
		return nil, conflict("Only a failed post is retried; this one is " + strings.ToLower(string(post.Status)) + ".")
	}
	// Retries count from the original post: a retry of a retry is the next one.
	original := post.IdempotencyKey
	if index := strings.Index(original, ":retry:"); index >= 0 {
		original = original[:index]
	}
	retries, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(*post.ContentDraftID),
		scheduledpost.ChannelConnectionID(post.ChannelConnectionID), scheduledpost.IdempotencyKeyHasPrefix(original+":retry:")).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, retry := range retries {
		if retry.ID != post.ID && retry.Status != scheduledpost.StatusFAILED && retry.Status != scheduledpost.StatusCANCELLED {
			return nil, conflict("This post was already retried; that retry is " + strings.ToLower(string(retry.Status)) + ".")
		}
	}
	// A newer post to this account (a retry or a new schedule) replaced this
	// one: retrying the old one could publish the same text twice.
	replaced, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(*post.ContentDraftID),
		scheduledpost.ChannelConnectionID(post.ChannelConnectionID), scheduledpost.CreatedAtGT(post.CreatedAt),
		scheduledpost.StatusNEQ(scheduledpost.StatusCANCELLED)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if replaced {
		return nil, conflict("A newer post to this account replaced this one. Retry the newest one instead.")
	}
	key := fmt.Sprintf("%s:retry:%d", original, len(retries)+1)
	create := tx.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(post.OrganizationID).
		SetNillableContentDraftID(post.ContentDraftID).SetNillableAssetID(post.AssetID).
		SetChannelConnectionID(post.ChannelConnectionID).SetNillableSocialSetID(post.SocialSetID).SetScheduledFor(time.Now().UTC()).
		SetNillableScheduleTimeZone(post.ScheduleTimeZone).
		SetStatus(scheduledpost.StatusSCHEDULED).SetCaption(post.Caption).SetIdempotencyKey(key).
		SetNillableScheduledByUserID(schedulerID(actor)).
		SetNillableApprovedByUserID(post.ApprovedByUserID).SetNillableApprovedVersion(post.ApprovedVersion)
	if len(post.AssetIds) > 0 {
		create.SetAssetIds(post.AssetIds)
	}
	if len(post.Replies) > 0 {
		create.SetReplies(post.Replies)
	}
	if !post.AutoActions.Empty() {
		create.SetAutoActions(post.AutoActions)
	}
	if len(post.Poll.Options) > 0 {
		create.SetPoll(post.Poll)
	}
	if !post.PublishOptions.Empty() {
		create.SetPublishOptions(post.PublishOptions)
	}
	if post.ReplyTo != nil {
		create.SetReplyTo(*post.ReplyTo)
	}
	retried, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This post is already being retried.")
	}
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "post.scheduled", "post.retried", "scheduled_post", retried.ID,
		map[string]any{"contentDraftId": *post.ContentDraftID, "from": post.ID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &MovedDraftPost{Post: contentDraftPost(retried, post.Edges.ChannelConnection.Platform), Scheduled: retried}, nil
}

// ReconcileInput is what a person found on the platform for a post of
// unknown outcome: it is live (with its URL, when they have it), or it is not.
type ReconcileInput struct {
	Live bool   `json:"live"`
	URL  string `json:"url"`
}

// ReconcileContentDraftPost settles a post whose outcome was unknown. Live
// marks it published, with the platform id read from its URL; not live marks
// it failed, so it can be retried. Nothing is sent to the platform.
func (c *Configuration) ReconcileContentDraftPost(ctx context.Context, actor Actor, postID string, input ReconcileInput) (*ContentDraftPost, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	post, err := c.draftPostForRecovery(ctx, tx, actor, postID)
	if err != nil {
		return nil, err
	}
	if post.Status != scheduledpost.StatusUNKNOWN_DELIVERY {
		return nil, conflict("Only a post whose outcome is unknown is reconciled; this one is " + strings.ToLower(string(post.Status)) + ".")
	}
	update := tx.ScheduledPost.Update().Where(scheduledpost.ID(post.ID), scheduledpost.StatusEQ(scheduledpost.StatusUNKNOWN_DELIVERY))
	action := "post.reconciled_not_live"
	if input.Live {
		if input.URL == "" && (post.Edges.ChannelConnection.Platform == "tiktok" || post.Edges.ChannelConnection.Platform == "youtube") {
			return nil, invalid("Enter the live video's URL to confirm its publication.")
		}
		action = "post.reconciled_live"
		update.SetStatus(scheduledpost.StatusPUBLISHED).SetPublishedAt(time.Now().UTC())
		remote := ""
		switch platform := socialplatform.Canonical(post.Edges.ChannelConnection.Platform); {
		case input.URL == "":
		case platform == "x":
			if match := xStatusID.FindStringSubmatch(input.URL); match != nil {
				remote = match[1]
			}
		case platform == "linkedin":
			remote = linkedInURN.FindString(input.URL)
		case platform == "tiktok" || platform == "youtube":
			parsed, err := url.Parse(input.URL)
			if err != nil || parsed.Scheme != "https" || parsed.User != nil {
				return nil, invalid("That URL is not a post on this channel.")
			}
			receipt := postoptions.PublicationReceipt{}
			if platform == "tiktok" && (parsed.Host == "www.tiktok.com" || parsed.Host == "tiktok.com") {
				if match := tikTokVideoPath.FindStringSubmatch(parsed.EscapedPath()); match != nil {
					if namesOtherAccount(post.Edges.ChannelConnection, match[1]) {
						return nil, invalid("That URL is not a post on this channel.")
					}
					remote = match[2]
					receipt.URL = "https://www.tiktok.com/@" + match[1] + "/video/" + remote
					if options := post.PublishOptions.TikTok; options != nil {
						receipt.Visibility = options.Privacy
					}
				}
			}
			if platform == "youtube" {
				switch {
				case (parsed.Host == "www.youtube.com" || parsed.Host == "youtube.com") && parsed.Path == "/watch":
					remote = parsed.Query().Get("v")
				case parsed.Host == "youtu.be":
					remote = strings.TrimPrefix(parsed.EscapedPath(), "/")
				}
				if !youTubeVideoID.MatchString(remote) {
					remote = ""
				} else {
					receipt.URL = "https://www.youtube.com/watch?v=" + remote
					if options := post.PublishOptions.YouTube; options != nil {
						receipt.Visibility = options.Privacy
					}
				}
			}
			if remote != "" {
				receipt.RemoteID = remote
				progress := post.ThreadProgress
				progress.Publication = &receipt
				update.SetThreadProgress(progress)
			}
		case platform == "bluesky":
			// Kept as an at:// URI, as the worker keeps it. shortcut: a link naming
			// the account by DID passes unchecked, as the connection records no DID.
			if uri, err := socialidentity.BlueskyPostURI(input.URL); err == nil {
				if actor, _, _ := strings.Cut(strings.TrimPrefix(uri, "at://"), "/"); socialidentity.BlueskyDID(actor) || !namesOtherAccount(post.Edges.ChannelConnection, actor) {
					remote = uri
				}
			}
		case platform == "mastodon":
			// shortcut: any instance's status link passes, as the connection does not record its instance; check it once it does.
			if parsed, err := url.Parse(input.URL); err == nil && socialidentity.MastodonStatusURL(input.URL) {
				remote = parsed.String()
			}
		default:
			link, known := postLinks[platform]
			parsed, err := url.Parse(input.URL)
			if !known || err != nil || parsed.Scheme != "https" || parsed.User != nil || !slices.Contains(link.hosts, strings.ToLower(parsed.Host)) {
				break
			}
			match := link.path.FindStringSubmatch(parsed.EscapedPath())
			if match == nil || len(match) > 1 && namesOtherAccount(post.Edges.ChannelConnection, match[1]) {
				break
			}
			parsed.Host, parsed.Fragment, parsed.RawFragment = strings.ToLower(parsed.Host), "", ""
			if !link.query {
				parsed.RawQuery = ""
			}
			remote = parsed.String()
		}
		if input.URL != "" && remote == "" {
			return nil, invalid("That URL is not a post on this channel.")
		}
		if remote != "" {
			update.SetRemotePostID(remote)
		}
		update.ClearFailureCode()
	} else {
		update.SetStatus(scheduledpost.StatusFAILED).SetFailureCode(publishing.FailureNotLive)
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, publishing.ErrConflict
	}
	if err := appendConfigurationAudit(ctx, tx, actor, action, "scheduled_post", post.ID,
		map[string]any{"contentDraftId": *post.ContentDraftID}); err != nil {
		return nil, err
	}
	updated, err := tx.ScheduledPost.Get(ctx, post.ID)
	if err != nil {
		return nil, err
	}
	if input.Live {
		if err := publishing.EmitDraftPublished(ctx, tx, updated, optionalText(updated.RemotePostID)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftPost(updated, post.Edges.ChannelConnection.Platform)
	return &result, nil
}
