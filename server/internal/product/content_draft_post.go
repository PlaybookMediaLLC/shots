package product

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/thread"
)

// A new post's outcome.
const (
	PostStatusAwaitingApproval = "awaiting_approval"
	PostStatusPublishing       = "publishing"
	PostStatusScheduled        = "scheduled"
)

// postDraftVersion is the version CreatePost schedules: the one a new draft
// starts at. Holding it fixed makes a retry replay the first schedule even
// though scheduling moved the draft to the next version.
const postDraftVersion = 1

// PostPart is one post of a thread: its text and attachments.
type PostPart struct {
	AssetIDs []string `json:"assetIds"`
	Text     string   `json:"text"`
}

// PostOptions are the settings a new post can carry on a platform.
type PostOptions struct {
	FirstComment string                        `json:"firstComment"`
	Pinterest    *postoptions.PinterestOptions `json:"pinterest"`
	TikTok       *postoptions.TikTokOptions    `json:"tiktok"`
	Visibility   string                        `json:"visibility"`
	YouTube      *postoptions.YouTubeOptions   `json:"youtube"`
}

// PostPlatform is what one platform posts instead of the shared text, and its
// settings.
type PostPlatform struct {
	Options *PostOptions `json:"options"`
	Posts   []PostPart   `json:"posts"`
}

// CreatePostInput is a new post, or thread, for one or more accounts of a
// social set, and when it goes out: exactly one of PublishNow, Queue,
// LocalTime and ScheduledFor.
type CreatePostInput struct {
	ChannelConnectionIDs []string                `json:"channelConnectionIds"`
	Disambiguation       string                  `json:"disambiguation"`
	IdempotencyKey       string                  `json:"idempotencyKey"`
	LocalTime            string                  `json:"localTime"`
	Platforms            map[string]PostPlatform `json:"platforms"`
	Posts                []PostPart              `json:"posts"`
	PublishNow           bool                    `json:"publishNow"`
	Queue                bool                    `json:"queue"`
	ScheduledFor         time.Time               `json:"scheduledFor"`
	TimeZone             string                  `json:"timeZone"`
	Title                string                  `json:"title"`
}

// CreatePostResult is the post's draft and each account's post. A workspace
// that requires approval gets the draft alone, with ReviewPath.
type CreatePostResult struct {
	Created    bool               `json:"created"`
	Draft      ContentDraftRecord `json:"draft"`
	Posts      []ContentDraftPost `json:"posts"`
	ReviewPath string             `json:"reviewPath,omitempty"`
	Status     string             `json:"status"`
	// Scheduled are the posts whose workflows the caller may wake; a due post
	// also starts within a minute without it.
	Scheduled []*ent.ScheduledPost `json:"-"`
}

// postPlan is a validated post: the draft to create and what each account posts.
type postPlan struct {
	draft   ContentDraftInput
	setID   string
	targets []ContentDraftScheduleTarget
}

// paragraphBreak is where the composer's text starts a new paragraph.
var paragraphBreak = regexp.MustCompile(`\n{2,}`)

// CreatePost writes a post and schedules or publishes it in one call: the path
// for API keys and agents, which hold finished text rather than a composer's
// document. It needs post:publish, and it is the only way a key can put a draft
// on a channel; ScheduleContentDraft stays with people. A workspace that
// requires approval keeps that rule: the draft waits for review and nothing is
// queued. Everything a schedule checks is checked before the draft exists, so a
// refused post leaves nothing behind.
func (c *Configuration) CreatePost(ctx context.Context, actor Actor, input CreatePostInput) (*CreatePostResult, error) {
	ctx = withDraftCountBudget(ctx) // checkPost, then scheduleContentDraft
	if err := c.authorizePublishing(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	plan, err := c.planPost(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	// The caller's Idempotency-Key guards its retries; a repeat warning would
	// arrive after the draft exists, and createPost has no one to confirm it.
	schedule := ScheduleContentDraftInput{
		Disambiguation: input.Disambiguation, LocalTime: input.LocalTime, PublishNow: input.PublishNow, Queue: input.Queue,
		ScheduledFor: input.ScheduledFor, Targets: plan.targets, TimeZone: input.TimeZone, Version: postDraftVersion,
		ConfirmDuplicate: true,
	}
	if err := c.checkPost(ctx, actor, plan, schedule); err != nil {
		return nil, err
	}
	record, err := c.CreateContentDraft(ctx, actor, plan.draft)
	if err != nil {
		return nil, err
	}
	draft, err := c.loadDraft(ctx, actor, record.ID)
	if err != nil {
		return nil, err
	}
	if draft.Status != contentdraft.StatusScheduled {
		waiting, err := c.draftAwaitsApproval(ctx, draft)
		if err != nil {
			return nil, err
		}
		if waiting {
			return &CreatePostResult{Draft: *record, Posts: []ContentDraftPost{}, ReviewPath: "/publish/" + draft.ID, Status: PostStatusAwaitingApproval}, nil
		}
	}
	scheduled, err := c.scheduleContentDraft(ctx, actor, draft.ID, schedule)
	if err != nil {
		return nil, err
	}
	status := PostStatusScheduled
	if input.PublishNow {
		status = PostStatusPublishing
	}
	return &CreatePostResult{Created: scheduled.Created, Draft: scheduled.Draft, Posts: scheduled.Posts, Scheduled: scheduled.Scheduled, Status: status}, nil
}

// planPost checks the input against the workspace and turns it into a draft
// and its targets. An account the key can't see is not found, the same as one
// that doesn't exist.
func (c *Configuration) planPost(ctx context.Context, actor Actor, input CreatePostInput) (*postPlan, error) {
	if len(input.ChannelConnectionIDs) == 0 {
		return nil, invalid("Pick at least one account.")
	}
	if len(input.Posts) == 0 {
		return nil, invalid("Write at least one post.")
	}
	if input.IdempotencyKey == "" {
		return nil, invalid("A post needs an idempotency key, so a retry can't post twice.")
	}
	if whens := len(slices.DeleteFunc([]bool{input.PublishNow, input.Queue, input.LocalTime != "", !input.ScheduledFor.IsZero()},
		func(set bool) bool { return !set })); whens != 1 {
		return nil, invalid("Say when with exactly one of publishNow, queue, localTime and scheduledFor.")
	}
	query := c.client.ChannelConnection.Query().Where(channelconnection.IDIn(input.ChannelConnectionIDs...),
		channelconnection.OrganizationID(actor.OrganizationID))
	rows, err := query.Clone().All(ctx)
	if err != nil {
		return nil, err
	}
	// An account from before social sets joins the default set on its first use.
	if slices.ContainsFunc(rows, func(row *ent.ChannelConnection) bool { return row.SocialSetID == nil }) {
		if _, err := c.defaultSocialSet(ctx, actor.OrganizationID); err != nil {
			return nil, err
		}
		if rows, err = query.Clone().All(ctx); err != nil {
			return nil, err
		}
	}
	connections := make(map[string]*ent.ChannelConnection, len(rows))
	for _, row := range rows {
		connections[row.ID] = row
	}
	channels := make([]string, 0, len(input.ChannelConnectionIDs))
	setID := ""
	for _, id := range input.ChannelConnectionIDs {
		connection := connections[id]
		if connection == nil {
			return nil, publishing.ErrNotFound
		}
		channel, ok := draftPlatformChannels[connection.Platform]
		if !ok {
			return nil, conflict("A " + connection.Platform + " account cannot take this post.")
		}
		if connection.SocialSetID == nil {
			return nil, conflict("This account is not in a social set. Add it to one in Shots.")
		}
		if setID != "" && setID != *connection.SocialSetID {
			return nil, invalid("These accounts are in different social sets. Make one post for each set.")
		}
		setID = *connection.SocialSetID
		channels = append(channels, channel)
	}
	if _, err := visibleSocialSet(ctx, c.client, actor, setID); err != nil {
		return nil, err
	}
	for channel := range input.Platforms {
		if !slices.Contains(channels, channel) {
			return nil, invalid("platforms." + channel + " has no matching account in channelConnectionIds.")
		}
	}
	postsFor := func(channel string) []PostPart {
		if override := input.Platforms[channel].Posts; len(override) > 0 {
			return override
		}
		return input.Posts
	}
	assetIDs := []string{}
	for _, channel := range channels {
		for _, part := range postsFor(channel) {
			for _, id := range part.AssetIDs {
				if !slices.Contains(assetIDs, id) {
					assetIDs = append(assetIDs, id)
				}
			}
		}
	}
	kinds, err := draftMediaKinds(ctx, c.client.Asset, actor.OrganizationID, assetIDs)
	if err != nil {
		return nil, err
	}
	if len(kinds) != len(assetIDs) {
		return nil, invalid("Attach assets from this workspace that have finished uploading.")
	}
	targets := make([]ContentDraftScheduleTarget, 0, len(channels))
	for at, id := range input.ChannelConnectionIDs {
		targets = append(targets, postTarget(id, postsFor(channels[at]), input.Platforms[channels[at]].Options))
	}
	primary := channels[0]
	primaryPosts := postsFor(primary)
	versions := []draftdoc.PlatformVersion{}
	for _, channel := range channels {
		options := input.Platforms[channel].Options.version()
		seen := slices.ContainsFunc(versions, func(version draftdoc.PlatformVersion) bool { return version.Channel == channel })
		switch {
		case seen:
		case channel != primary && !samePostParts(postsFor(channel), primaryPosts):
			versions = append(versions, draftdoc.PlatformVersion{Channel: channel, Mode: draftdoc.ModeManual, Body: postBody(postsFor(channel), kinds),
				ForkedFromVersion: postDraftVersion, Options: options})
		case options != nil:
			versions = append(versions, draftdoc.PlatformVersion{Channel: channel, Mode: draftdoc.ModeSynced, Options: options})
		}
	}
	texts := make([]string, 0, len(primaryPosts))
	for _, part := range primaryPosts {
		texts = append(texts, part.Text)
	}
	return &postPlan{setID: setID, targets: targets, draft: ContentDraftInput{
		AssetIDs: assetIDs, Body: postBody(primaryPosts, kinds), ChannelConnectionIDs: input.ChannelConnectionIDs,
		ImportKey: input.IdempotencyKey, PlainText: strings.Join(texts, "\n\n"), PrimaryPlatform: primary,
		PlatformVersions: &draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: versions},
		SocialSetID:      setID, Title: input.Title,
	}}, nil
}

// checkPost runs a schedule's checks without changing anything but the media
// derivatives scheduling reuses.
func (c *Configuration) checkPost(ctx context.Context, actor Actor, plan *postPlan, schedule ScheduleContentDraftInput) error {
	if err := validateDraftTargets(schedule); err != nil {
		return err
	}
	if err := c.prepareDraftMedia(ctx, actor, &schedule, nil); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	captions := []string{}
	for _, target := range schedule.Targets {
		captions = append(captions, target.Caption)
		for _, reply := range target.Replies {
			captions = append(captions, reply.Caption)
		}
	}
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, &plan.setID, captions...); err != nil {
		return err
	}
	_, _, err = c.draftTargetConnections(ctx, tx, &ent.ContentDraft{OrganizationID: actor.OrganizationID, SocialSetID: &plan.setID,
		Kind: contentdraft.KindStandard}, schedule.Targets, nil)
	return err
}

// postTarget is what one account posts. Its attachments are always set, so a
// post without any doesn't take the draft's.
func postTarget(connectionID string, posts []PostPart, options *PostOptions) ContentDraftScheduleTarget {
	target := ContentDraftScheduleTarget{AssetIDs: append([]string{}, posts[0].AssetIDs...), Caption: posts[0].Text,
		ChannelConnectionID: connectionID, Options: options.publish()}
	for _, part := range posts[1:] {
		target.Replies = append(target.Replies, thread.Reply{AssetIDs: append([]string{}, part.AssetIDs...), Caption: part.Text})
	}
	return target
}

// postBody is the Plate value of a thread, as the composer writes plain text:
// a break before each post and one block per paragraph, then its media.
func postBody(posts []PostPart, kinds map[string]string) []any {
	body := []any{}
	for _, part := range posts {
		body = append(body, map[string]any{"type": "post_break", "children": []any{map[string]any{"text": ""}}})
		for _, paragraph := range paragraphBreak.Split(strings.TrimSpace(part.Text), -1) {
			body = append(body, map[string]any{"type": "p", "children": []any{map[string]any{"text": paragraph}}})
		}
		for _, id := range part.AssetIDs {
			body = append(body, draftMediaBlock(kinds[id], id))
		}
	}
	return body
}

func samePostParts(a, b []PostPart) bool {
	return slices.EqualFunc(a, b, func(x, y PostPart) bool { return x.Text == y.Text && slices.Equal(x.AssetIDs, y.AssetIDs) })
}

// publish is the options as a scheduled post carries them.
func (o *PostOptions) publish() *postoptions.PublishOptions {
	if o == nil {
		return nil
	}
	return &postoptions.PublishOptions{FirstComment: o.FirstComment, Pinterest: o.Pinterest, TikTok: o.TikTok, Visibility: o.Visibility, YouTube: o.YouTube}
}

// version is the options as a draft's platform version stores them.
func (o *PostOptions) version() *draftdoc.VersionOptions {
	if o == nil {
		return nil
	}
	return &draftdoc.VersionOptions{FirstComment: o.FirstComment, Pinterest: o.Pinterest, TikTok: o.TikTok, Visibility: o.Visibility, YouTube: o.YouTube}
}
