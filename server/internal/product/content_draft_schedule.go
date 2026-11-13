package product

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/articlebody"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/thread"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/lucsky/cuid"
)

// Scheduling a content draft (RFC 013) creates one canonical scheduled post
// per channel, through the same scheduled_post queue and Temporal workflow as
// campaign posts. The web serializes the draft per channel; the backend
// re-checks each caption before anything is queued.

// draftPlatformChannels maps a connection's platform to the channel whose
// limit applies (campaignChannelLimits). Other platforms cannot take a draft.
var draftPlatformChannels = map[string]string{
	"x": "x", "linkedin": "linkedin", "instagram": "instagram", "instagram-standalone": "instagram",
	"threads": "threads", "bluesky": "bluesky", "mastodon": "mastodon",
	"tiktok": "tiktok", "youtube": "youtube", "twitter": "x", "linkedin-page": "linkedin", "mastodon-custom": "mastodon", "mastodoncustom": "mastodon",
}

// EnableE2EDraftPlatform lets the local provider fixture's "e2e" connections
// take drafts as X does, for end-to-end tests. Production never calls it;
// the direct publisher refuses the platform outside e2e builds regardless.
func EnableE2EDraftPlatform() {
	draftPlatformChannels["e2e"] = "x"
}

// draftChannelLimits is each channel's caption limit; the composer holds the
// same numbers (DRAFT_CHANNEL_LIMITS in lib/content-drafts/serialize.ts).
var draftChannelLimits = map[string]int{
	"tiktok": 2000, "youtube": 5000, "bluesky": 300, "instagram": 2200, "linkedin": 3000, "mastodon": 500, "threads": 500, "x": 280,
}

// ContentDraftScheduleTarget is one channel and the caption serialized for it.
type ContentDraftScheduleTarget struct {
	// AssetIDs are the post's images in order: the draft's, with its table and
	// math blocks rendered among them. Omitted, the post takes the draft's.
	AssetIDs            []string `json:"assetIds"`
	Caption             string   `json:"caption"`
	ChannelConnectionID string   `json:"channelConnectionId"`
	// Replies are a thread's later posts, posted as replies to the first.
	// Only a channel that publishes threads (X) takes them.
	Replies []thread.Reply `json:"replies"`
	// AutoActions follow the post once live (X only).
	AutoActions *postoptions.AutoActions `json:"autoActions"`
	// Poll asks a question with the post (X, LinkedIn).
	Poll *postoptions.Poll `json:"poll"`
	// Options are the first post's settings beyond its text (RFC 025).
	Options *postoptions.PublishOptions `json:"options"`
	// ReplyTo is the live X post a reply draft answers.
	ReplyTo string `json:"replyTo"`
}

// draftThreadChannels publish a thread's later posts as replies.
var draftThreadChannels = map[string]bool{"x": true, "threads": true, "bluesky": true, "mastodon": true}

// contentDraftReplyLimit caps a thread: the first post and this many replies.
const contentDraftReplyLimit = 24

// ScheduleContentDraftInput schedules the draft at Version to every target:
// at ScheduledFor, or with Queue at the draft's set's next free slot, which
// the backend reserves. NaturalPostingTime overrides the draft's own choice
// for this schedule.
type ScheduleContentDraftInput struct {
	ExpectedQueueSlot   *time.Time                   `json:"expectedQueueSlot"`
	BaseCalendarVersion int                          `json:"baseCalendarVersion"`
	NaturalPostingTime  *bool                        `json:"naturalPostingTime"`
	Queue               bool                         `json:"queue"`
	ScheduledFor        time.Time                    `json:"scheduledFor"`
	Targets             []ContentDraftScheduleTarget `json:"targets"`
	Version             int                          `json:"version"`
	// Write (RFC 025): publish now, or a wall time in a zone (the set's when
	// empty), resolved here; Disambiguation picks a repeated hour.
	Disambiguation string `json:"disambiguation"`
	LocalTime      string `json:"localTime"`
	PublishNow     bool   `json:"publishNow"`
	TimeZone       string `json:"timeZone"`
	// Add schedules these channels beside the draft's live posts instead of
	// replacing them, so correcting one destination leaves the others queued.
	Add bool `json:"add"`
	// ConfirmDuplicate is a member's answer to DuplicateContentError: schedule
	// the same post to an account again within a day.
	ConfirmDuplicate bool `json:"confirmDuplicate"`
}

// duplicateWindow is how close in time an account's identical posts count as a repeat.
const duplicateWindow = 24 * time.Hour

// DuplicatePost is an account's queued or published post with the same text and media.
type DuplicatePost struct {
	At                  time.Time `json:"at"`
	ChannelConnectionID string    `json:"channelConnectionId"`
	PostID              string    `json:"postId"`
	Status              string    `json:"status"`
}

// DuplicateContentError asks a member to confirm a post an account already
// has queued or published within a day: platforms treat repeats as spam, and
// a second schedule of one post is the usual cause of a double post.
type DuplicateContentError struct {
	Posts []DuplicatePost
}

func (e *DuplicateContentError) Error() string {
	return "The same text and media is already queued or published on this account within a day. Confirm to schedule it again."
}

func (e *DuplicateContentError) Unwrap() error { return publishing.ErrConflict }

// sameCaption compares captions as a reader does: spacing and case aside.
func sameCaption(a, b string) bool {
	return strings.EqualFold(strings.Join(strings.Fields(a), " "), strings.Join(strings.Fields(b), " "))
}

// recentDuplicates lists each target account's live posts within
// duplicateWindow of at that carry the target's text and media.
func recentDuplicates(ctx context.Context, tx *ent.Tx, organizationID string, at time.Time,
	targets []ContentDraftScheduleTarget, images map[string][]string) ([]DuplicatePost, error) {
	byConnection := make(map[string]ContentDraftScheduleTarget, len(targets))
	ids := make([]string, 0, len(targets))
	for _, target := range targets {
		byConnection[target.ChannelConnectionID] = target
		ids = append(ids, target.ChannelConnectionID)
	}
	from, to := at.Add(-duplicateWindow), at.Add(duplicateWindow)
	// A post publishes at most an hour after its time (the late window), so one
	// range on scheduledFor finds every candidate through the tenant's index.
	rows, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(organizationID), scheduledpost.ChannelConnectionIDIn(ids...),
		// UNKNOWN_DELIVERY may be live: the likeliest double post of all.
		scheduledpost.StatusIn(scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING, scheduledpost.StatusPUBLISHED, scheduledpost.StatusUNKNOWN_DELIVERY),
		scheduledpost.ScheduledForGT(from.Add(-time.Hour)), scheduledpost.ScheduledForLT(to)).
		Select(scheduledpost.FieldID, scheduledpost.FieldChannelConnectionID, scheduledpost.FieldCaption, scheduledpost.FieldAssetIds,
			scheduledpost.FieldScheduledFor, scheduledpost.FieldPublishedAt, scheduledpost.FieldStatus).
		Order(ent.Asc(scheduledpost.FieldScheduledFor)).All(ctx)
	if err != nil {
		return nil, err
	}
	var duplicates []DuplicatePost
	for _, row := range rows {
		target := byConnection[row.ChannelConnectionID]
		if !sameCaption(row.Caption, target.Caption) || !slices.Equal(row.AssetIds, images[row.ChannelConnectionID]) {
			continue
		}
		when := row.ScheduledFor
		if row.PublishedAt != nil {
			when = *row.PublishedAt
		}
		if !when.After(from) || !when.Before(to) {
			continue
		}
		duplicates = append(duplicates, DuplicatePost{At: when.UTC(), ChannelConnectionID: row.ChannelConnectionID, PostID: row.ID, Status: string(row.Status)})
	}
	return duplicates, nil
}

// naturalOffsetLimit bounds a natural posting time's offset: four minutes.
const naturalOffsetLimit = 240

// naturalOffset is a natural posting time's offset in seconds, within four
// minutes either side. It is derived from the draft, its version and the base
// instant, and stored with each post, so the same scheduling intent always
// lands on the same instant across reloads, retries and recoveries.
func naturalOffset(draftID string, version int, base time.Time) int {
	sum := sha256.Sum256([]byte(fmt.Sprintf("natural-time:%s:%d:%d", draftID, version, base.Unix())))
	return int(binary.BigEndian.Uint32(sum[:4])%(2*naturalOffsetLimit+1)) - naturalOffsetLimit
}

// AccountStanding is a display projection of verified connection capabilities.
// Scheduling independently rechecks the current proof in its transaction.
type AccountStanding struct {
	TikTokCreator  *postoptions.TikTokCreator `json:"tiktokCreator,omitempty"`
	MastodonQuotes *bool                      `json:"mastodonQuotes"`
	PollLimits     *socialidentity.PollLimits `json:"pollLimits"`
	Premium        bool                       `json:"premium"`
	XCaptionLimit  *int                       `json:"xCaptionLimit"`
	XArticles      *bool                      `json:"xArticles"`
	XQuotes        bool                       `json:"xQuotes"`
	// XVideoMaxSeconds is the verified account's X video length; nil is unverified.
	XVideoMaxSeconds *int `json:"xVideoMaxSeconds"`
}

// AccountStandingReader reads an account's standing from its platform
// connection (the direct social publisher).
type AccountStandingReader interface {
	AccountStanding(ctx context.Context, organizationID, destinationID, platform, secretReference string) (AccountStanding, error)
}

// WithAccountStanding sets the account standing reader. Without one, every
// account is standard: 280 characters on X and no articles.
func (c *Configuration) WithAccountStanding(reader AccountStandingReader) *Configuration {
	c.accounts = reader
	return c
}

// accountStanding reads a connection's standing; unknown is standard.
func (c *Configuration) accountStanding(ctx context.Context, connection *ent.ChannelConnection) AccountStanding {
	if c.accounts == nil {
		return AccountStanding{}
	}
	standing, err := c.accounts.AccountStanding(ctx, connection.OrganizationID, connection.ExternalAccountID,
		connection.Platform, connection.SecretReference)
	if err != nil {
		return AccountStanding{}
	}
	return standing
}

// ContentDraftPost is a scheduled post made from a draft, with its status.
type ContentDraftPost struct {
	Caption             string    `json:"caption"`
	ChannelConnectionID string    `json:"channelConnectionId"`
	CreatedAt           time.Time `json:"createdAt"`
	ID                  string    `json:"id"`
	Platform            string    `json:"platform"`
	ScheduledFor        time.Time `json:"scheduledFor"`
	Status              string    `json:"status"`
	// How the instant was chosen (RFC 024): queue or explicit, the instant
	// before any natural offset, the offset, and the time zone it was read in.
	NaturalOffsetSeconds *int       `json:"naturalOffsetSeconds"`
	ScheduleMode         *string    `json:"scheduleMode"`
	ScheduleTimeZone     *string    `json:"scheduleTimeZone"`
	SlotAt               *time.Time `json:"slotAt"`
	SocialSetID          *string    `json:"socialSetId"`
	// Once live: the post on its platform, and its engagement as last read.
	Metrics   postoptions.Metrics `json:"metrics"`
	MetricsAt *time.Time          `json:"metricsAt"`
	URL       *string             `json:"url"`
	// A thread: how many replies it has and how many went out.
	Replies        int                        `json:"replies"`
	ThreadProgress postoptions.ThreadProgress `json:"threadProgress"`
	// Its follow-ups once live (RFC 025), each with its receipt.
	Automations []PostAutomation `json:"automations"`
	// Why it did not publish (failed, outcome unknown, or cancelled by the
	// worker), and when its provider confirmed it.
	FailureCode *string    `json:"failureCode"`
	PublishedAt *time.Time `json:"publishedAt"`
}

// livePostURL is a live post's address on its platform, where one can be
// built from its id.
func livePostURL(platform string, remoteID *string) *string {
	return postoptions.LivePostURL(platform, remoteID)
}

// ScheduleContentDraftResult is the draft after scheduling and its new posts.
// Created is false for a replay of a schedule already made at this version.
type ScheduleContentDraftResult struct {
	Created bool               `json:"created"`
	Draft   ContentDraftRecord `json:"draft"`
	Posts   []ContentDraftPost `json:"posts"`
	// Cancelled are live posts a reschedule replaced; their workflows must stop.
	Cancelled []string `json:"-"`
	// Scheduled are the posts whose workflows must run (started idempotently).
	Scheduled []*ent.ScheduledPost `json:"-"`
}

// contentDraftPostKey is the idempotency key of a draft's post on a channel
// at a version: a double submit replays the same posts instead of new ones.
func contentDraftPostKey(draftID, connectionID string, version int) string {
	return fmt.Sprintf("content-draft:%s:%s:v%d", draftID, connectionID, version)
}

// scheduleIntent fingerprints when a request asks to publish. A retry under the
// same post keys replays only the same intent; another time is a conflict.
func scheduleIntent(input ScheduleContentDraftInput) string {
	utc := func(at *time.Time) *time.Time {
		if at == nil || at.IsZero() {
			return nil
		}
		value := at.UTC()
		return &value
	}
	raw, _ := json.Marshal(struct {
		Disambiguation, LocalTime, TimeZone string
		ExpectedQueueSlot, ScheduledFor     *time.Time
		NaturalPostingTime                  *bool
		PublishNow, Queue                   bool
	}{input.Disambiguation, input.LocalTime, input.TimeZone, utc(input.ExpectedQueueSlot), utc(&input.ScheduledFor),
		input.NaturalPostingTime, input.PublishNow, input.Queue})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

// QueueSlotTakenError is a reviewed queue slot that another schedule took or
// that the set's schedule no longer offers. Next is its next free slot, for
// the person to review; nothing was scheduled.
type QueueSlotTakenError struct{ Next time.Time }

func (e *QueueSlotTakenError) Error() string {
	return "The queue slot you reviewed is no longer free. Review the next free slot and confirm again."
}

func (e *QueueSlotTakenError) Unwrap() error { return publishing.ErrConflict }

func contentDraftPost(post *ent.ScheduledPost, platform string) ContentDraftPost {
	var mode *string
	if post.ScheduleMode != nil {
		value := string(*post.ScheduleMode)
		mode = &value
	}
	postURL := postoptions.PostURL(platform, post.RemotePostID, post.ThreadProgress)
	return ContentDraftPost{Caption: post.Caption, ChannelConnectionID: post.ChannelConnectionID,
		CreatedAt: post.CreatedAt, ID: post.ID, Platform: platform, ScheduledFor: post.ScheduledFor,
		Status: string(post.Status), Metrics: post.Metrics, MetricsAt: post.MetricsAt,
		URL: postURL, Replies: len(post.Replies), ThreadProgress: post.ThreadProgress,
		NaturalOffsetSeconds: post.NaturalOffsetSeconds, ScheduleMode: mode, ScheduleTimeZone: post.ScheduleTimeZone,
		SlotAt: post.SlotAt, SocialSetID: post.SocialSetID, Automations: []PostAutomation{},
		FailureCode: post.FailureCode, PublishedAt: post.PublishedAt}
}

// validateDraftTargets checks the shape of a schedule before any lookup.
func validateDraftTargets(input ScheduleContentDraftInput) error {
	if input.Version < 1 {
		return invalid("version is required.")
	}
	if len(input.Targets) == 0 || len(input.Targets) > contentDraftChannelLimit {
		return invalid(fmt.Sprintf("Pick 1 to %d channels.", contentDraftChannelLimit))
	}
	if input.PublishNow && input.Queue {
		return invalid("Publish now, or add to the queue: not both.")
	}
	if input.Disambiguation != "" && input.Disambiguation != "earlier" && input.Disambiguation != "later" {
		return invalid("A repeated local time is the earlier or the later one.")
	}
	if !input.Queue && !input.PublishNow && input.LocalTime == "" && !input.ScheduledFor.After(time.Now()) {
		return invalid("Pick a time in the future.")
	}
	seen := map[string]bool{}
	for _, target := range input.Targets {
		if !contentDraftRefPattern.MatchString(target.ChannelConnectionID) || seen[target.ChannelConnectionID] {
			return invalid("Each channel must be a distinct, valid connection.")
		}
		seen[target.ChannelConnectionID] = true
		if strings.TrimSpace(target.Caption) == "" && len(target.AssetIDs) == 0 && (target.Options == nil || target.Options.DocumentAssetID == "") {
			return invalid("Every channel needs a caption.")
		}
	}
	return nil
}

// draftTargetConnections loads and checks every target's connection: the
// workspace's, active, on a platform that takes drafts, and within that
// channel's caption limit. It also returns each target's images, up to the
// channel's limit and all the workspace's uploads. Instagram posts need one.
func (c *Configuration) draftTargetConnections(ctx context.Context, tx *ent.Tx, draft *ent.ContentDraft, targets []ContentDraftScheduleTarget,
	draftImages []string) (map[string]*ent.ChannelConnection, map[string][]string, error) {
	organizationID := draft.OrganizationID
	connections := make(map[string]*ent.ChannelConnection, len(targets))
	images := make(map[string][]string, len(targets))
	if err := checkDraftKindTargets(string(draft.Kind), targets); err != nil {
		return nil, nil, err
	}
	// Every caption, reply and follow-up of the request counts within one budget.
	budget := helpers.NewScanBudget(draftCountBudget)
	loaded := make([]*ent.ChannelConnection, 0, len(targets))
	for _, target := range targets {
		connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(target.ChannelConnectionID),
			channelconnection.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, nil, err
		}
		if connection.Platform == "instagram" {
			// The publisher has no verified path for Facebook Login accounts yet.
			return nil, nil, conflict("Instagram accounts connected through Facebook Login can't publish from Shots yet. Reconnect this account with Instagram Login.")
		}
		if draft.SocialSetID != nil && (connection.SocialSetID == nil || *connection.SocialSetID != *draft.SocialSetID) {
			return nil, nil, conflict("A selected account is not in this draft's social set.")
		}
		if connection.Status != channelconnection.StatusACTIVE || connection.Provider != "social" {
			return nil, nil, conflict("A selected account was removed from its social set. Pick another, or reconnect it.")
		}
		loaded = append(loaded, connection)
		channel, ok := draftPlatformChannels[connection.Platform]
		if !ok {
			return nil, nil, conflict("A " + connection.Platform + " channel cannot publish a draft.")
		}
		ids := draftImages
		if target.AssetIDs != nil {
			ids = target.AssetIDs
		}
		if err := checkLinkPreviewMedia(target.Options, len(ids)); err != nil {
			return nil, nil, err
		}
		if distinctAssetCount(ids) != len(ids) {
			return nil, nil, invalid("Each attachment in a post must be distinct. Move the copy to another post or apply a distinct edit.")
		}
		if err := checkPostOptions(channel, target.Options, true); err != nil {
			return nil, nil, err
		}
		if channel == "bluesky" {
			if err := checkBlueskyTarget(ctx, tx, connection, target, ids); err != nil {
				return nil, nil, err
			}
		}
		if channel == "mastodon" {
			if err := checkMastodonPolls(ctx, tx, connection, target, ids); err != nil {
				return nil, nil, err
			}
		}
		limit := draftChannelLimits[channel]
		if channel == "x" && connection.Platform != "e2e" {
			caps, err := checkXTarget(ctx, tx, connection, target, ids, draft.Kind == contentdraft.KindArticle, budget)
			if err != nil {
				return nil, nil, err
			}
			limit = caps.PostTextLimit()
		}
		if len(ids) > draftMediaLimit(channel) {
			return nil, nil, invalid("Too many attachments for " + channel + ". Remove attachments before scheduling.")
		}
		if target.AssetIDs != nil {
			if ids, err = contentDraftAssets(ctx, tx, organizationID, ids); err != nil {
				return nil, nil, err
			}
		}
		rows, err := draftMediaRows(ctx, tx.Client(), organizationID, ids)
		if err != nil {
			return nil, nil, err
		}
		if err := checkDraftMedia(channel, rows); err != nil {
			return nil, nil, err
		}
		if channel == "tiktok" {
			standing := c.accountStanding(ctx, connection)
			duration := 0
			if len(rows) == 1 && rows[0].DurationMs != nil {
				duration = *rows[0].DurationMs
			}
			if err := standing.TikTokCreator.Check(target.Options.TikTok, duration); err != nil {
				return nil, nil, conflict(err.Error())
			}
		}
		if channel == "instagram" && len(ids) == 0 {
			return nil, nil, conflict("Instagram needs an image. Add one to the draft first.")
		}
		if draft.Kind == contentdraft.KindArticle {
			// This is the application's article-size bound, not an X entitlement.
			limit = 100_000
		}
		length, err := draftPostLength(channel, target.Caption, budget)
		if err != nil {
			return nil, nil, conflict(fmt.Sprintf("The %s caption is too long or too complex to count. Shorten it.", channel))
		}
		if length > limit {
			return nil, nil, conflict(fmt.Sprintf("The %s caption is %d characters; the limit is %d.", channel, length, limit))
		}
		if err := checkDraftReplies(ctx, tx, organizationID, channel, limit, target.Replies, budget); err != nil {
			return nil, nil, err
		}
		media := len(ids)
		if target.Options != nil && target.Options.DocumentAssetID != "" {
			if err := checkDraftDocument(ctx, tx, organizationID, target.Options.DocumentAssetID); err != nil {
				return nil, nil, err
			}
			if len(ids) > 0 {
				return nil, nil, invalid("A LinkedIn document goes alone: remove the images or the document.")
			}
			media++
		}
		if err := checkPoll(channel, target.Poll, target.Options, media); err != nil {
			return nil, nil, err
		}
		if err := checkDraftExtras(channel, target, budget); err != nil {
			return nil, nil, err
		}
		connections[target.ChannelConnectionID] = connection
		images[target.ChannelConnectionID] = ids
	}
	health, err := connectionHealth(ctx, tx.Client(), organizationID, loaded)
	if err != nil {
		return nil, nil, err
	}
	for _, connection := range loaded {
		if health[connection.ID] != AccountConnected {
			name := connection.Platform
			if connection.Handle != nil {
				name = *connection.Handle
			}
			return nil, nil, conflict(name + " needs attention before it can publish: " + strings.ReplaceAll(health[connection.ID], "_", " ") +
				". Reconnect it from the social set's settings.")
		}
	}
	return connections, images, nil
}

// checkDraftExtras checks a target's follow-ups: X only, and sensible.
func checkDraftExtras(channel string, target ContentDraftScheduleTarget, budget *helpers.ScanBudget) error {
	if target.AutoActions != nil && !target.AutoActions.Empty() {
		actions := *target.AutoActions
		if channel != "x" {
			return invalid("Auto reposts, replies and quotes are for X posts.")
		}
		if actions.RepostAtLikes < 0 || actions.PlugAtLikes < 0 || actions.QuoteAfterHours < 0 ||
			actions.RepostAtLikes > 1_000_000 || actions.PlugAtLikes > 1_000_000 || actions.QuoteAfterHours > 24*30 {
			return invalid("Set like counts and hours as small positive numbers.")
		}
		if actions.PlugAtLikes > 0 && !fitsXPost(actions.PlugText, 0, budget) {
			return invalid("The auto reply needs text that fits in one X post.")
		}
		if actions.QuoteAfterHours > 0 && !fitsXPost(actions.QuoteText, 1+xLinkLength, budget) {
			return invalid("The quote needs text that fits in one X post with the link.")
		}
		if actions.PlugMetric != "" && actions.PlugMetric != "likes" && actions.PlugMetric != "reposts" {
			return invalid("An auto plug waits for likes or reposts.")
		}
		if err := checkRetweetRules(actions); err != nil {
			return err
		}
	}
	return nil
}

// checkRetweetRules checks automatic reposts (RFC 025): at most five, each
// a duration after publishing (up to 30 days) or a wall-clock time up to 30
// days later in a real time zone, and a removal delay of up to a week.
func checkRetweetRules(actions postoptions.AutoActions) error {
	if len(actions.Retweets) > 5 {
		return invalid("Add up to five automatic reposts.")
	}
	if actions.UnretweetAfterMinutes < 0 || actions.UnretweetAfterMinutes > 7*24*60 {
		return invalid("Remove automatic reposts within a week, or keep them.")
	}
	for _, rule := range actions.Retweets {
		if rule.At == "" && (rule.AfterMinutes < 1 || rule.AfterMinutes > 30*24*60 || rule.Days != 0 || rule.TimeZone != "") {
			return invalid("Repost between one minute and 30 days after publishing.")
		}
		if rule.At != "" && (rule.AfterMinutes != 0 || rule.Days < 0 || rule.Days > 30) {
			return invalid("Repost at a time of day up to 30 days after publishing.")
		}
		if _, err := rule.When(time.Now()); err != nil {
			return invalid("Each repost needs a time like 10:30 and a time zone like Europe/Paris.")
		}
	}
	return nil
}

// checkDraftKindTargets checks a kind's targets: an article goes to one X
// account and nowhere else; a reply answers an X post; a quote names the
// post it quotes. Each says what it needs.
func checkDraftKindTargets(kind string, targets []ContentDraftScheduleTarget) error {
	for _, target := range targets {
		options := target.Options
		if options == nil {
			options = &postoptions.PublishOptions{}
		}
		switch kind {
		case "article":
			assets := map[string]string{}
			for _, id := range target.AssetIDs {
				assets[id] = ""
			}
			if options.ArticleHTML != "" {
				if _, err := articlebody.Render(options.ArticleHTML, assets); err != nil {
					return invalid(err.Error())
				}
			}
			if len(targets) != 1 {
				return invalid("An article goes to one X account and cannot go to other platforms with it.")
			}
			if strings.TrimSpace(options.ArticleTitle) == "" {
				return invalid("Give the article a title.")
			}
			if len(target.Replies) > 0 || target.Poll != nil && len(target.Poll.Options) > 0 {
				return invalid("An article has no thread and no poll.")
			}
		case "reply":
			if !numericID.MatchString(target.ReplyTo) {
				return invalid("A reply names the X post it answers.")
			}
		case "quote":
			if options.QuoteRemoteID == "" {
				return invalid("A quote names the post it quotes.")
			}
		default:
			if target.ReplyTo != "" || options.ArticleTitle != "" || options.ArticleHTML != "" {
				return invalid("Only a reply answers a post, and only an article has a title.")
			}
		}
	}
	return nil
}

// checkDraftDocument checks a LinkedIn document is an uploaded PDF of the workspace.
func checkDraftDocument(ctx context.Context, tx *ent.Tx, organizationID, assetID string) error {
	found, err := tx.Asset.Query().Where(asset.ID(assetID), asset.OrganizationID(organizationID),
		asset.StatusEQ(asset.StatusUPLOADED), asset.MediaType("application/pdf")).Exist(ctx)
	if err != nil {
		return err
	}
	if !found {
		return invalid("The document must be an uploaded PDF of this workspace.")
	}
	return nil
}

// checkDraftReplies checks a thread's later posts: a thread channel, at most
// contentDraftReplyLimit, each within the limit with text or an image, and
// every image an upload of the workspace, up to the channel's image limit.
func checkDraftReplies(ctx context.Context, tx *ent.Tx, organizationID, channel string, limit int, replies []thread.Reply, budget *helpers.ScanBudget) error {
	if len(replies) == 0 {
		return nil
	}
	if !draftThreadChannels[channel] {
		return invalid("Only X, Threads, Bluesky and Mastodon post a thread; send " + channel + " one post.")
	}
	if len(replies) > contentDraftReplyLimit {
		return invalid(fmt.Sprintf("A thread can have at most %d replies.", contentDraftReplyLimit))
	}
	for index := range replies {
		reply := &replies[index]
		reply.Caption = strings.TrimSpace(reply.Caption)
		length, err := draftPostLength(channel, reply.Caption, budget)
		if err != nil {
			return conflict(fmt.Sprintf("Post %d is too long or too complex to count. Shorten it.", index+2))
		}
		if length > limit {
			return conflict(fmt.Sprintf("Post %d is %d characters; the %s limit is %d.", index+2, length, channel, limit))
		}
		if err := checkLinkPreviewMedia(reply.Options, len(reply.AssetIDs)); err != nil {
			return err
		}
		if err := checkPostOptions(channel, reply.Options, false); err != nil {
			return err
		}
		if err := checkPoll(channel, reply.Poll, reply.Options, len(reply.AssetIDs)); err != nil {
			return err
		}
		if distinctAssetCount(reply.AssetIDs) != len(reply.AssetIDs) {
			return invalid("Each attachment in a reply must be distinct.")
		}
		if len(reply.AssetIDs) > draftMediaLimit(channel) {
			return invalid("Too many attachments for " + channel + ".")
		}
		ids, err := contentDraftAssets(ctx, tx, organizationID, reply.AssetIDs)
		if err != nil {
			return err
		}
		rows, err := draftMediaRows(ctx, tx.Client(), organizationID, ids)
		if err != nil {
			return err
		}
		if err := checkDraftMedia(channel, rows); err != nil {
			return fmt.Errorf("Post %d: %w", index+2, err)
		}
		if reply.Caption == "" && len(ids) == 0 {
			return invalid(fmt.Sprintf("Post %d is empty.", index+2))
		}
		reply.AssetIDs = ids
	}
	return nil
}

// replayDraftSchedule returns the posts already made for these targets at this
// version: all of them for a replay, none for a new schedule. Some but not all
// means the targets changed without a save, which is refused.
func replayDraftSchedule(ctx context.Context, tx *ent.Tx, draft *ent.ContentDraft, input ScheduleContentDraftInput) ([]*ent.ScheduledPost, error) {
	keys := make([]string, 0, len(input.Targets))
	for _, target := range input.Targets {
		keys = append(keys, contentDraftPostKey(draft.ID, target.ChannelConnectionID, input.Version))
	}
	existing, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draft.ID),
		scheduledpost.IdempotencyKeyIn(keys...)).WithChannelConnection().All(ctx)
	if err != nil || len(existing) == 0 {
		return nil, err
	}
	if len(existing) != len(keys) {
		return nil, conflict("This draft was already scheduled to other channels at this version. Reload it and try again.")
	}
	intent := scheduleIntent(input)
	for _, post := range existing {
		if post.ScheduleIntent != nil && *post.ScheduleIntent != intent {
			return nil, conflict("This version was already scheduled for another time. Reload to see the current schedule, then change it.")
		}
	}
	// A replay answers in the targets' order, as the first answer did; the query has none.
	slices.SortFunc(existing, func(a, b *ent.ScheduledPost) int {
		return slices.Index(keys, a.IdempotencyKey) - slices.Index(keys, b.IdempotencyKey)
	})
	return existing, nil
}

// cancelLiveDraftPosts withdraws queued commitments for a reschedule or review.
// A post already publishing, or that may be live, blocks the transaction.
func cancelLiveDraftPosts(ctx context.Context, tx *ent.Tx, actor Actor, draftID, reason string) ([]string, error) {
	live, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID), scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.StatusIn(
		scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING,
		scheduledpost.StatusUNKNOWN_DELIVERY)).All(ctx)
	if err != nil {
		return nil, err
	}
	cancelled := make([]string, 0, len(live))
	for _, post := range live {
		if post.Status == scheduledpost.StatusPROCESSING || post.Status == scheduledpost.StatusUNKNOWN_DELIVERY {
			return nil, conflict("A post from this draft is publishing or may already be live. Check the channel before changing its schedule or review.")
		}
		update := tx.ScheduledPost.Update().Where(scheduledpost.ID(post.ID), scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.StatusIn(
			scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED)).SetStatus(scheduledpost.StatusCANCELLED)
		if reason == publishing.FailureChangesRequested {
			update.SetFailureCode(reason)
		}
		count, err := update.Save(ctx)
		if err != nil {
			return nil, err
		}
		if count != 1 {
			return nil, publishing.ErrConflict
		}
		if err := recordProductActivity(ctx, tx, actor, "post.cancelled", "post.cancelled", "scheduled_post", post.ID,
			map[string]any{"contentDraftId": draftID, "reason": reason}); err != nil {
			return nil, err
		}
		cancelled = append(cancelled, post.ID)
	}
	return cancelled, nil
}

// liveDraftChannels is the channels of the draft's queued posts, which an
// added schedule keeps. A target that already has one is refused: change that
// post with Reschedule instead of queuing a second.
func liveDraftChannels(ctx context.Context, tx *ent.Tx, draftID string, targets []ContentDraftScheduleTarget) ([]string, error) {
	live, err := tx.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID), scheduledpost.StatusIn(
		scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING,
		scheduledpost.StatusUNKNOWN_DELIVERY, scheduledpost.StatusPUBLISHED)).All(ctx)
	if err != nil {
		return nil, err
	}
	kept := []string{}
	for _, post := range live {
		for _, target := range targets {
			if target.ChannelConnectionID == post.ChannelConnectionID {
				return nil, conflict("This draft already has a post on a selected account. Reschedule that post instead of adding another.")
			}
		}
		if post.Status != scheduledpost.StatusPUBLISHED && !slices.Contains(kept, post.ChannelConnectionID) {
			kept = append(kept, post.ChannelConnectionID)
		}
	}
	return kept, nil
}

// ScheduleContentDraft queues the draft at input.Version to every target.
// Scheduling snapshots each caption, so later edits to the draft do not
// change queued posts; scheduling again cancels them and queues new ones.
// prepareDraftMedia gives each target the media its provider will receive:
// images oriented and sized for it, and the length of each video read.
// Scheduling and its preflight both check what this leaves.
func (c *Configuration) prepareDraftMedia(ctx context.Context, actor Actor, input *ScheduleContentDraftInput, fallback []string) error {
	input.Targets = slices.Clone(input.Targets)
	for i := range input.Targets {
		target := &input.Targets[i]
		target.AssetIDs = slices.Clone(target.AssetIDs)
		target.Replies = slices.Clone(target.Replies)
		for j := range target.Replies {
			target.Replies[j].AssetIDs = slices.Clone(target.Replies[j].AssetIDs)
		}
	}
	if err := c.prepareDraftImages(ctx, actor, input.Targets, fallback); err != nil {
		return err
	}
	return c.probeDraftVideos(ctx, actor.OrganizationID, input.Targets, fallback)
}

func (c *Configuration) ScheduleContentDraft(ctx context.Context, actor Actor, draftID string,
	input ScheduleContentDraftInput) (*ScheduleContentDraftResult, error) {
	if err := c.authorizeDecision(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	return c.scheduleContentDraft(ctx, actor, draftID, input)
}

// scheduleContentDraft schedules a draft for an actor the caller has authorized.
func (c *Configuration) scheduleContentDraft(ctx context.Context, actor Actor, draftID string,
	input ScheduleContentDraftInput) (*ScheduleContentDraftResult, error) {
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	if err := validateDraftTargets(input); err != nil {
		return nil, err
	}
	loadedDraft, err := c.loadDraft(ctx, actor, draftID)
	if err != nil {
		return nil, err
	}
	if loadedDraft.Version == input.Version {
		if err := c.prepareDraftMedia(ctx, actor, &input, loadedDraft.AssetIds); err != nil {
			return nil, err
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM organization WHERE id=$1 FOR SHARE`, actor.OrganizationID); err != nil {
		return nil, err
	}
	// One schedule of a draft at a time: a concurrent double submit waits, then replays.
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('content-draft-schedule:' || $1))`, draftID); err != nil {
		return nil, err
	}
	draft, err := visibleContentDraft(ctx, tx.Client(), actor, draftID)
	if err != nil {
		return nil, err
	}
	// Share-lock the media so a concurrent deletion waits and then sees these posts.
	media := slices.Clone(draft.AssetIds)
	for _, target := range input.Targets {
		media = append(media, target.AssetIDs...)
		for _, reply := range target.Replies {
			media = append(media, reply.AssetIDs...)
		}
		if target.Options != nil {
			media = append(media, target.Options.DocumentAssetID, target.Options.ArticleCoverAssetID)
		}
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM asset WHERE "organizationId"=$1 AND id = ANY($2::text[]) FOR SHARE`,
		actor.OrganizationID, "{"+strings.Join(slices.DeleteFunc(media, func(id string) bool { return !contentDraftRefPattern.MatchString(id) }), ",")+"}"); err != nil {
		return nil, err
	}
	if replay, err := replayDraftSchedule(ctx, tx, draft, input); err != nil || replay != nil {
		if err != nil {
			return nil, err
		}
		result := &ScheduleContentDraftResult{Draft: contentDraftRecord(draft)}
		for _, post := range replay {
			result.Posts = append(result.Posts, contentDraftPost(post, post.Edges.ChannelConnection.Platform))
			if post.Status == scheduledpost.StatusSCHEDULED {
				result.Scheduled = append(result.Scheduled, post)
			}
		}
		return result, tx.Commit()
	}
	if draft.Status == contentdraft.StatusArchived {
		return nil, conflict("Restore this draft before scheduling it.")
	}
	if input.BaseCalendarVersion > 0 && draft.CalendarVersion != input.BaseCalendarVersion {
		return nil, conflict("The calendar changed. Reload before scheduling.")
	}
	if draft.Version != input.Version {
		return nil, &ContentDraftVersionConflictError{Current: draft.Version}
	}
	if err := c.requireDraftApproval(ctx, draft); err != nil {
		return nil, err
	}
	bound := *c
	bound.client = tx.Client()
	if err := bound.requireDraftSchedulingPlan(ctx, actor, draft, input); err != nil {
		return nil, err
	}
	reason := "schedule"
	if input.PublishNow {
		reason = "publish"
	}
	if err := recordContentDraftRevision(ctx, tx, actor, draft, true, reason); err != nil {
		return nil, err
	}
	set, err := c.draftSocialSet(ctx, tx, draft)
	if err != nil {
		return nil, err
	}
	connections, images, err := c.draftTargetConnections(ctx, tx, draft, input.Targets, draft.AssetIds)
	if err != nil {
		return nil, err
	}
	// Captions are the stored draft's at input.Version, so an approval binds the
	// text: for the route and batch runs the web serializes them from the draft it
	// read at that version and takes no text from its callers; CreatePost and voice
	// confirm make the draft from them. Alt text and the browser-rendered table
	// images are not bound: publishing reads alt text from the asset when it posts.
	captions := make([]string, 0, len(input.Targets))
	for _, target := range input.Targets {
		captions = append(captions, target.Caption)
		for _, reply := range target.Replies {
			captions = append(captions, reply.Caption)
		}
	}
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, &set.ID, captions...); err != nil {
		return nil, err
	}
	// Who approved the version these posts carry, if anyone did.
	var approvedBy *string
	var approvedVersion *int
	if draft.ReviewStatus == contentdraft.ReviewStatusApproved && draft.ApprovedVersion != nil && *draft.ApprovedVersion == draft.Version {
		approvedBy, approvedVersion = draft.ReviewedByUserID, draft.ApprovedVersion
	}
	var cancelled, kept []string
	if input.Add {
		kept, err = liveDraftChannels(ctx, tx, draft.ID, input.Targets)
	} else {
		cancelled, err = cancelLiveDraftPosts(ctx, tx, actor, draft.ID, "rescheduled")
	}
	if err != nil {
		return nil, err
	}
	placement, err := placeDraftSchedule(ctx, tx, set, draft, input, time.Now())
	if err != nil {
		return nil, err
	}
	// A member confirms a repeat; an API key's caller owns its own idempotency.
	if actor.IsSession() && !input.ConfirmDuplicate {
		duplicates, err := recentDuplicates(ctx, tx, actor.OrganizationID, placement.at, input.Targets, images)
		if err != nil {
			return nil, err
		}
		if len(duplicates) > 0 {
			return nil, &DuplicateContentError{Posts: duplicates}
		}
	}
	refund, err := c.ChargeMonthlyQuota(ctx, actor.OrganizationID, QuotaPosts, len(input.Targets))
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		if !committed {
			refund()
		}
	}()
	result := &ScheduleContentDraftResult{Cancelled: cancelled, Created: true}
	intent := scheduleIntent(input)
	channelIDs := make([]string, 0, len(input.Targets))
	for _, target := range input.Targets {
		create := tx.ScheduledPost.Create()
		if ids := images[target.ChannelConnectionID]; len(ids) > 0 {
			create.SetAssetID(ids[0]).SetAssetIds(ids)
		}
		if len(target.Replies) > 0 {
			create.SetReplies(target.Replies)
		}
		if target.AutoActions != nil && !target.AutoActions.Empty() {
			create.SetAutoActions(*target.AutoActions)
		}
		if target.Poll != nil && len(target.Poll.Options) > 0 {
			create.SetPoll(*target.Poll)
		}
		if target.Options != nil && !target.Options.Empty() {
			create.SetPublishOptions(*target.Options)
		}
		if target.ReplyTo != "" {
			create.SetReplyTo(target.ReplyTo)
		}
		post, err := create.SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetContentDraftID(draft.ID).SetChannelConnectionID(target.ChannelConnectionID).
			SetSocialSetID(set.ID).SetScheduleMode(placement.mode).SetSlotAt(placement.base).
			SetNaturalOffsetSeconds(placement.offset).SetScheduleTimeZone(placement.zone).SetScheduleIntent(intent).
			SetScheduledFor(placement.at).SetStatus(scheduledpost.StatusSCHEDULED).
			SetCaption(strings.TrimSpace(target.Caption)).
			SetNillableScheduledByUserID(schedulerID(actor)).
			SetNillableApprovedByUserID(approvedBy).SetNillableApprovedVersion(approvedVersion).
			SetIdempotencyKey(contentDraftPostKey(draft.ID, target.ChannelConnectionID, input.Version)).Save(ctx)
		if err != nil {
			if ent.IsConstraintError(err) {
				return nil, publishing.ErrConflict
			}
			return nil, err
		}
		if err := recordProductActivity(ctx, tx, actor, "post.scheduled", "post.scheduled", "scheduled_post", post.ID,
			map[string]any{"contentDraftId": draft.ID}); err != nil {
			return nil, err
		}
		result.Posts = append(result.Posts, contentDraftPost(post, connections[target.ChannelConnectionID].Platform))
		result.Scheduled = append(result.Scheduled, post.Unwrap())
		channelIDs = append(channelIDs, target.ChannelConnectionID)
	}
	// A scheduled draft is no longer only planned. Scheduling changes no
	// content, so an approval of this version carries to the next.
	update := tx.ContentDraft.Update().Where(contentdraft.ID(draft.ID), contentdraft.Version(input.Version), contentdraft.CalendarVersion(draft.CalendarVersion)).
		SetStatus(contentdraft.StatusScheduled).SetChannelConnectionIds(append(kept, channelIDs...)).AddVersion(1).AddCalendarVersion(1).
		ClearPlannedFor().ClearPlanTimeZone().
		SetNillableUpdatedByUserID(projectActor(actor))
	if draft.ApprovedVersion != nil && *draft.ApprovedVersion == draft.Version {
		update.SetApprovedVersion(draft.Version + 1)
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, contentDraftMiss(ctx, tx, actor, draft.ID)
	}
	postIDs := make([]string, 0, len(result.Posts))
	for _, post := range result.Posts {
		postIDs = append(postIDs, post.ID)
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_scheduled", "content_draft", draft.ID,
		map[string]any{"cancelledPostIds": cancelled, "scheduledPostIds": postIDs, "version": input.Version,
			"scheduledFor": placement.at.Format(time.RFC3339), "reason": reason, "timeZone": placement.zone, "added": input.Add}); err != nil {
		return nil, err
	}
	updated, err := tx.ContentDraft.Get(ctx, draft.ID)
	if err != nil {
		return nil, err
	}
	if err := emitDraftEvent(ctx, tx, updated, webhooks.DraftScheduled,
		map[string]any{"posts": scheduledPostsData(result.Posts), "scheduleMode": string(placement.mode)}); err != nil {
		return nil, err
	}
	if err := emitDraftChanges(ctx, tx, draft, updated); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	committed = true
	result.Draft = contentDraftRecord(updated)
	return result, nil
}

// draftSocialSet is the draft's set, or for a draft written before RFC 024,
// the workspace's default set.
func (c *Configuration) draftSocialSet(ctx context.Context, tx *ent.Tx, draft *ent.ContentDraft) (*ent.SocialSet, error) {
	if draft.SocialSetID == nil {
		return c.defaultSocialSet(ctx, draft.OrganizationID)
	}
	return tx.SocialSet.Get(ctx, *draft.SocialSetID)
}

// draftPlacement is where a schedule lands and why.
type draftPlacement struct {
	at, base time.Time
	mode     scheduledpost.ScheduleMode
	offset   int
	// zone is the time zone the instant was chosen in.
	zone string
}

// placeDraftSchedule picks a schedule's instant. A queued draft takes the
// slot the person reviewed, or else the set's next free slot, under the set's
// advisory lock held until the transaction ends, so a concurrent request
// waits and then sees this one's posts. A reviewed slot that is no longer
// free is refused, never silently moved. A natural posting time adds the
// draft's stored offset; an offset that would land in the past is mirrored
// forward.
func placeDraftSchedule(ctx context.Context, tx *ent.Tx, set *ent.SocialSet, draft *ent.ContentDraft,
	input ScheduleContentDraftInput, now time.Time) (draftPlacement, error) {
	placement := draftPlacement{base: input.ScheduledFor.UTC(), mode: scheduledpost.ScheduleModeExplicit, zone: set.TimeZone}
	if input.TimeZone != "" && !input.Queue {
		if _, err := time.LoadLocation(input.TimeZone); err != nil {
			return placement, invalid("Schedule in an IANA time zone, such as Europe/Paris.")
		}
		placement.zone = input.TimeZone
	}
	// Write (RFC 025): publish now goes out now, with no offset; a wall time
	// is resolved in its zone (the set's when it names none), refusing a time
	// the clocks skip and asking which of a repeated hour.
	if input.PublishNow {
		placement.base, placement.at = now.UTC(), now.UTC()
		return placement, nil
	}
	if input.LocalTime != "" {
		resolved, err := resolveLocalTime(input.LocalTime, placement.zone, input.Disambiguation)
		if err != nil {
			return placement, err
		}
		if !resolved.After(now) {
			return placement, invalid("Pick a time in the future.")
		}
		placement.base = resolved.UTC()
	}
	if input.Queue {
		if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('social-set-queue:' || $1))`, set.ID); err != nil {
			return placement, err
		}
		free, err := freeQueueSlots(ctx, tx.Client(), set, now)
		if err != nil {
			return placement, err
		}
		slot := free[0]
		if input.ExpectedQueueSlot != nil {
			if !slices.ContainsFunc(free, input.ExpectedQueueSlot.Equal) {
				return placement, &QueueSlotTakenError{Next: free[0]}
			}
			slot = input.ExpectedQueueSlot.UTC()
		}
		placement.base, placement.mode = slot, scheduledpost.ScheduleModeQueue
	}
	natural := draft.NaturalPostingTime
	if input.NaturalPostingTime != nil {
		natural = *input.NaturalPostingTime
	}
	if natural {
		placement.offset = naturalOffset(draft.ID, input.Version, placement.base)
	}
	placement.at = placement.base.Add(time.Duration(placement.offset) * time.Second)
	if !placement.at.After(now.Add(30 * time.Second)) {
		placement.offset = max(placement.offset, -placement.offset)
		placement.at = placement.base.Add(time.Duration(placement.offset) * time.Second)
	}
	if !placement.at.After(now.Add(30 * time.Second)) {
		if !natural {
			return placement, invalid("Pick a time at least 30 seconds in the future.")
		}
		placement.offset = int(now.Add(31*time.Second).Sub(placement.base).Seconds()) + 1
		if placement.offset > naturalOffsetLimit {
			return placement, invalid("Pick a later natural posting time.")
		}
		placement.at = placement.base.Add(time.Duration(placement.offset) * time.Second)
	}
	return placement, nil
}

// ListContentDraftPosts lists every post scheduled from a draft, newest first.
func (c *Configuration) ListContentDraftPosts(ctx context.Context, actor Actor, draftID string) ([]ContentDraftPost, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := visibleContentDraft(ctx, c.client, actor, draftID); err != nil {
		return nil, err
	}
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID),
		scheduledpost.OrganizationID(actor.OrganizationID)).WithChannelConnection().
		Order(ent.Desc(scheduledpost.FieldCreatedAt), ent.Desc(scheduledpost.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	automations, err := c.postAutomations(ctx, posts...)
	if err != nil {
		return nil, err
	}
	items := make([]ContentDraftPost, 0, len(posts))
	for _, post := range posts {
		item := contentDraftPost(post, post.Edges.ChannelConnection.Platform)
		if found := automations[post.ID]; found != nil {
			item.Automations = found
		}
		items = append(items, item)
	}
	return items, nil
}

func distinctAssetCount(ids []string) int {
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	return len(seen)
}
