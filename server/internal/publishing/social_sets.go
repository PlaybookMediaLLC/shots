package publishing

import (
	"context"
	"errors"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdrafttag"
	"slices"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/webhooksubscription"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
)

// ErrSocialSetSlotTaken refuses a second active account of one platform in a
// social set (RFC 024).
var ErrSocialSetSlotTaken = errors.New("this social set already has an account on that platform; remove it first")

// ErrAccountInAnotherSet refuses connecting an account that is already
// active in a different social set of the workspace.
var ErrAccountInAnotherSet = errors.New("this account is already connected to another social set in this workspace; manage it from that set")

// ErrAccountRemovedFromAnotherSet refuses moving an account that another set
// still holds while it is removed or revoked there: that set's drafts and
// history name it.
var ErrAccountRemovedFromAnotherSet = errors.New("this account is not active in another social set of this workspace; whoever manages that set can reconnect it")

// holdingSocialSet locks and returns the set that still holds an account: its
// live set, or a deleted private set of another person, whose history stays
// theirs. An account no set holds may join the set it is connected to.
func holdingSocialSet(ctx context.Context, tx *ent.Tx, actor Actor, connection *ent.ChannelConnection) (*string, error) {
	if connection.SocialSetID == nil {
		return nil, nil
	}
	holds := false
	err := tx.PlatformQuery(ctx, `SELECT "deletedAt" IS NULL OR (visibility='PRIVATE' AND "ownerUserId" IS DISTINCT FROM $3)
		FROM social_set WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, []any{*connection.SocialSetID, connection.OrganizationID, actor.UserID},
		func(row entsql.ColumnScanner) error { return row.Scan(&holds) })
	if err != nil || !holds {
		return nil, err
	}
	return connection.SocialSetID, nil
}

// targetSocialSet picks the set a new or reconnected account joins: the one
// the connection started from, or else the workspace's default set when it
// has no account on that platform yet. An account that fits nowhere stays in
// no set until someone adds it to one.
func targetSocialSet(ctx context.Context, tx *ent.Tx, organizationID, platform string, requested *string) (*string, error) {
	if requested != nil {
		set, err := tx.SocialSet.Query().Where(socialset.ID(*requested), socialset.OrganizationID(organizationID),
			socialset.DeletedAtIsNil()).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		taken, err := platformTaken(ctx, tx, set.ID, platform)
		if err != nil {
			return nil, err
		}
		if taken {
			return nil, ErrSocialSetSlotTaken
		}
		return &set.ID, nil
	}
	set, err := tx.SocialSet.Query().Where(socialset.OrganizationID(organizationID), socialset.DeletedAtIsNil(),
		socialset.VisibilityEQ(socialset.VisibilityWORKSPACE)).
		Order(ent.Asc(socialset.FieldCreatedAt), ent.Asc(socialset.FieldID)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	taken, err := platformTaken(ctx, tx, set.ID, platform)
	if err != nil || taken {
		return nil, err
	}
	return &set.ID, nil
}

func platformTaken(ctx context.Context, tx *ent.Tx, setID, platform string) (bool, error) {
	return tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(setID), channelconnection.PlatformIn(socialplatform.Aliases(platform)...),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
}

// enableDefaultPlatform makes a newly connected platform one of the set's
// new-draft defaults, and its primary when it has none.
func enableDefaultPlatform(ctx context.Context, tx *ent.Tx, setID *string, platform string) error {
	if setID == nil {
		return nil
	}
	set, err := tx.SocialSet.Get(ctx, *setID)
	if err != nil {
		return err
	}
	platform = socialplatform.Canonical(platform)
	defaults := socialplatform.Defaults(set.DefaultPlatforms)
	if !slices.Contains(defaults, platform) {
		defaults = append(defaults, platform)
	}
	primary := platform
	if set.PrimaryPlatform != nil {
		primary = socialplatform.Canonical(*set.PrimaryPlatform)
	}
	if slices.Equal(defaults, set.DefaultPlatforms) && set.PrimaryPlatform != nil && *set.PrimaryPlatform == primary {
		return nil
	}
	update := tx.SocialSet.UpdateOneID(set.ID).SetDefaultPlatforms(defaults).SetPrimaryPlatform(primary).AddVersion(1)
	_, err = update.Save(ctx)
	return err
}

// EmitDraftPublished writes a draft.published webhook event (RFC 024) in the
// transaction that marks a draft's post live: the draft's identity and the
// live post, never its text. post must be the stored row; providerPostID may
// be empty when a person confirmed the post live without its URL.
func EmitDraftPublished(ctx context.Context, tx *ent.Tx, post *ent.ScheduledPost, providerPostID string) error {
	if post.ContentDraftID == nil {
		return nil
	}
	subscribed, err := tx.WebhookSubscription.Query().Where(webhooksubscription.OrganizationID(post.OrganizationID),
		webhooksubscription.Enabled(true)).Exist(ctx)
	if err != nil || !subscribed {
		return err
	}
	// Only what the event carries: the full row holds collaboration state up to 5 MiB.
	draft, err := tx.ContentDraft.Query().Where(contentdraft.ID(*post.ContentDraftID)).
		Select(contentdraft.FieldID, contentdraft.FieldOrganizationID, contentdraft.FieldSocialSetID,
			contentdraft.FieldStatus, contentdraft.FieldTagIds, contentdraft.FieldTitle).Only(ctx)
	if err != nil {
		return err
	}
	connection, err := tx.ChannelConnection.Get(ctx, post.ChannelConnectionID)
	if err != nil {
		return err
	}
	tagRows, err := tx.ContentDraftTag.Query().Where(contentdrafttag.IDIn(draft.TagIds...),
		contentdrafttag.OrganizationID(draft.OrganizationID)).All(ctx)
	if err != nil {
		return err
	}
	names := map[string]string{}
	for _, row := range tagRows {
		names[row.ID] = row.Name
	}
	tags := []map[string]string{}
	for _, id := range draft.TagIds {
		if name, ok := names[id]; ok {
			tags = append(tags, map[string]string{"id": id, "name": name})
		}
	}
	data := map[string]any{
		"draft": map[string]any{"id": draft.ID, "socialSetId": draft.SocialSetID, "status": string(draft.Status),
			"tags": tags, "title": draft.Title},
		"post": map[string]any{"id": post.ID, "platform": connection.Platform, "publishedAt": time.Now().UTC(),
			"remotePostId": nonEmpty(providerPostID), "url": postoptions.LivePostURL(connection.Platform, &providerPostID)},
	}
	return webhooks.Emit(ctx, tx, webhooks.NewEnvelope(post.OrganizationID, webhooks.DraftPublished, draft.SocialSetID,
		webhooks.Resource{ID: draft.ID, Type: "draft"}, data))
}

// PostConnectionActive reports whether the account a post went out on is
// still active; a removed or revoked account takes no further action.
func (r *Repository) PostConnectionActive(ctx context.Context, postID string) (bool, error) {
	post, err := r.client.ScheduledPost.Query().Where(scheduledpost.ID(postID)).WithChannelConnection().Only(ctx)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return post.Edges.ChannelConnection != nil && post.Edges.ChannelConnection.Status == channelconnection.StatusACTIVE, nil
}

// RecordAutoAction records a live post's follow-up that went out, once per
// post and kind, as activity for notifications.
func (r *Repository) RecordAutoAction(ctx context.Context, postID, kind string) error {
	post, err := r.client.ScheduledPost.Get(ctx, postID)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	tx, err := r.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	payload := map[string]any{}
	if post.ContentDraftID != nil {
		payload["contentDraftId"] = *post.ContentDraftID
	}
	if err := activity.Emit(ctx, tx, post.OrganizationID, kind, "scheduled_post", post.ID, "", kind+":"+post.ID, payload); err != nil {
		return err
	}
	return tx.Commit()
}
