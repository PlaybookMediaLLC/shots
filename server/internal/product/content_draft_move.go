package product

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/lucsky/cuid"
)

// SwapContentDraftPosts atomically swaps two immutable commitments on the same
// account. Their ids are concurrency tokens: a replaced/claimed id cannot move.
func (c *Configuration) SwapContentDraftPosts(ctx context.Context, actor Actor, firstID, secondID string) ([]*MovedDraftPost, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
		return nil, err
	}
	if firstID == secondID {
		return nil, invalid("Choose two different posts.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// All overlapping swaps claim rows in the same order to avoid deadlocks.
	ids := []string{firstID, secondID}
	sort.Strings(ids)
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM scheduled_post WHERE id IN ($1,$2) AND "organizationId"=$3 ORDER BY id FOR UPDATE`, ids[0], ids[1], actor.OrganizationID); err != nil {
		return nil, err
	}
	posts := make([]*ent.ScheduledPost, 0, 2)
	for _, id := range ids {
		post, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(id), scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftIDNotNil()).WithChannelConnection().Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if err := requireVisibleDraftPost(ctx, tx.Client(), actor, post); err != nil {
			return nil, err
		}
		if post.Status != scheduledpost.StatusSCHEDULED || !post.ScheduledFor.After(time.Now().Add(time.Minute)) {
			return nil, conflict("Only future queued posts can swap.")
		}
		if post.Edges.ChannelConnection.Status != channelconnection.StatusACTIVE {
			return nil, conflict("Reconnect the account before moving this post.")
		}
		posts = append(posts, post)
	}
	if posts[0].ChannelConnectionID != posts[1].ChannelConnectionID || optionalText(posts[0].SocialSetID) != optionalText(posts[1].SocialSetID) {
		return nil, invalid("Only posts on the same account and social set can swap.")
	}
	slot := func(post *ent.ScheduledPost) time.Time {
		if post.SlotAt != nil {
			return *post.SlotAt
		}
		return post.ScheduledFor
	}
	result := make([]*MovedDraftPost, 0, 2)
	for index, post := range posts {
		moved, err := replaceQueuedDraftPost(ctx, tx, actor, post, slot(posts[1-index]))
		if err != nil {
			return nil, err
		}
		result = append(result, moved)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// replaceQueuedDraftPost replaces the timer's immutable publication snapshot.
// Its caller owns the transaction; no network request occurs inside it.
func replaceQueuedDraftPost(ctx context.Context, tx *ent.Tx, actor Actor, post *ent.ScheduledPost, at time.Time) (*MovedDraftPost, error) {
	return replaceQueuedDraftPostAt(ctx, tx, actor, post, at, false)
}

func replaceQueuedDraftPostAt(ctx context.Context, tx *ent.Tx, actor Actor, post *ent.ScheduledPost, at time.Time, immediate bool) (*MovedDraftPost, error) {
	if post.Edges.ChannelConnection.Status != channelconnection.StatusACTIVE {
		return nil, conflict("Reconnect the account before moving this post.")
	}
	// Retain this commitment's chosen jitter rather than randomizing on retry.
	offset := 0
	if !immediate && post.NaturalOffsetSeconds != nil {
		offset = *post.NaturalOffsetSeconds
	}
	execution := at.Add(time.Duration(offset) * time.Second)
	if !immediate && !execution.After(time.Now().Add(30*time.Second)) {
		return nil, invalid("The natural posting time is too soon. Pick a later slot.")
	}
	// A worker or another calendar request may have claimed this post since
	// the read. Only one caller may replace this immutable commitment.
	claimed, err := tx.ScheduledPost.Update().Where(scheduledpost.ID(post.ID),
		scheduledpost.StatusEQ(scheduledpost.StatusSCHEDULED)).SetStatus(scheduledpost.StatusCANCELLED).Save(ctx)
	if err != nil {
		return nil, err
	}
	if claimed != 1 {
		return nil, conflict("This post changed while you were moving it. Refresh the calendar.")
	}
	key := fmt.Sprintf("%s:moved:%d", post.IdempotencyKey, at.Unix())
	action := "post.moved"
	kind := "post.moved"
	if immediate {
		key = "publish-now:" + post.ID
		action = "post.publish_now"
		kind = "post.scheduled"
	}
	create := tx.ScheduledPost.Create().SetID(cuid.New()).SetOrganizationID(post.OrganizationID).
		SetNillableContentDraftID(post.ContentDraftID).SetNillableAssetID(post.AssetID).
		SetChannelConnectionID(post.ChannelConnectionID).SetScheduledFor(execution.UTC()).
		SetStatus(scheduledpost.StatusSCHEDULED).SetCaption(post.Caption).
		SetNillableSocialSetID(post.SocialSetID).SetScheduleMode(scheduledpost.ScheduleModeExplicit).SetSlotAt(at.UTC()).
		SetNaturalOffsetSeconds(offset).SetNillableScheduleTimeZone(post.ScheduleTimeZone).
		SetIdempotencyKey(key).SetNillableScheduledByUserID(schedulerID(actor)).
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
	if post.ReplyTo != nil {
		create.SetReplyTo(*post.ReplyTo)
	}
	if !post.PublishOptions.Empty() {
		create.SetPublishOptions(post.PublishOptions)
	}
	moved, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, kind, action, "scheduled_post", moved.ID,
		map[string]any{"from": post.ID, "scheduledFor": at.UTC()}); err != nil {
		return nil, err
	}
	movedPost := contentDraftPost(moved, post.Edges.ChannelConnection.Platform)
	if draft, err := tx.ContentDraft.Get(ctx, *post.ContentDraftID); err != nil {
		return nil, err
	} else if err := emitDraftEvent(ctx, tx, draft, webhooks.DraftScheduled, map[string]any{
		"posts": scheduledPostsData([]ContentDraftPost{movedPost}), "scheduleMode": "explicit"}); err != nil {
		return nil, err
	}
	return &MovedDraftPost{Cancelled: post.ID, Post: contentDraftPost(moved, post.Edges.ChannelConnection.Platform), Scheduled: moved}, nil
}
