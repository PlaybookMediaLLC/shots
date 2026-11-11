package product

import (
	"context"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// PostScheduleScope is the API-key scope that schedules and cancels posts
// (RFC 026). It schedules only what a person already approved.
const PostScheduleScope = "post:schedule"

// PostPublishScope is the opt-in API-key scope that publishes new posts with
// no person in between. post:schedule never implies it: keys issued with that
// scope were promised they could only schedule what a person approved.
const PostPublishScope = "post:publish"

// authorizePublishing admits a publisher's session, or an API key the backend
// itself finds was issued with post:publish. It guards CreatePost only.
func (c *Configuration) authorizePublishing(ctx context.Context, actor Actor) error {
	switch {
	case actor.IsSession():
		return c.authorizeRoles(ctx, actor, "owner", "admin", "publisher")
	case actor.Kind == "api_key":
		return c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, PostPublishScope)
	}
	return publishing.ErrForbidden
}

// authorizeScheduling admits a publisher's session, or an API key the backend
// itself finds was issued with post:schedule. Approving stays with a person:
// the scheduling paths accept only approved posts and variants.
func (c *Configuration) authorizeScheduling(ctx context.Context, actor Actor) error {
	switch {
	case actor.IsSession():
		return c.authorizeRoles(ctx, actor, "owner", "admin", "publisher")
	case actor.Kind == "api_key":
		return c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, PostScheduleScope)
	}
	return publishing.ErrForbidden
}

// requireKeySchedule holds a key to what post:schedule promises: it sends what a
// person approved. Approving a visual doesn't approve words, so the caption must
// be the copy of an approved campaign post that uses this visual. New text takes
// CreatePost and post:publish. A person still writes their own caption. A variant
// or account that doesn't qualify is left for the repository to refuse.
func (c *Configuration) requireKeySchedule(ctx context.Context, actor Actor, input publishing.CreateScheduledPostInput) error {
	connection, err := c.client.ChannelConnection.Query().Where(channelconnection.ID(input.ChannelConnectionID),
		channelconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if connection != nil {
		if err := requireSharedAccount(ctx, c.client, actor, connection); err != nil {
			return err
		}
	}
	variant, err := c.client.CreativeVariant.Query().Where(creativevariant.ID(input.VariantID),
		creativevariant.OrganizationID(actor.OrganizationID), creativevariant.StatusEQ(creativevariant.StatusAPPROVED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	uses := []predicate.CampaignPost{campaignpost.CreativeVariantID(variant.ID)}
	if variant.DesignID != nil {
		designs, err := c.client.Design.Query().Where(design.ID(*variant.DesignID), design.OrganizationID(actor.OrganizationID)).All(ctx)
		if err != nil {
			return err
		}
		for _, row := range designs {
			if row.CampaignID != nil {
				uses = append(uses, campaignpost.CampaignID(*row.CampaignID))
			}
		}
	}
	posts, err := c.client.CampaignPost.Query().Where(campaignpost.OrganizationID(actor.OrganizationID),
		campaignpost.ApprovedAtNotNil(), campaignpost.Or(uses...)).All(ctx)
	if err != nil {
		return err
	}
	for _, post := range posts {
		if strings.TrimSpace(post.Copy) == input.Caption {
			return nil
		}
	}
	return forbidden("A key with post:schedule sends only text a person approved: use the approved copy of a campaign post for this visual. To post new text, use createPost, which needs post:publish.")
}

// requireSharedAccount keeps a key out of a private social set's accounts: not
// found, the same as another workspace's account. People keep their own access.
func requireSharedAccount(ctx context.Context, client *ent.Client, actor Actor, connection *ent.ChannelConnection) error {
	if actor.IsSession() || connection.SocialSetID == nil {
		return nil
	}
	_, err := visibleSocialSet(ctx, client, actor, *connection.SocialSetID)
	return err
}

// CreateScheduledPost schedules an approved variant to a channel connection
// and charges the monthly posts allowance. A replay of the same idempotency
// key returns the first post and is not charged again. A content draft is
// refused: ScheduleContentDraft checks its approval and sends its stored text,
// and this path would skip both (plan F1).
func (c *Configuration) CreateScheduledPost(ctx context.Context, actor Actor,
	input publishing.CreateScheduledPostInput) (publishing.CreateScheduledPostResult, error) {
	input.Caption = strings.TrimSpace(input.Caption)
	if input.IdempotencyKey == "" {
		// No key: name the request by its content, so a retry replays instead of posting twice.
		input.IdempotencyKey = publishing.ContentIdempotencyKey(input)
	}
	if input.Caption == "" || !input.ScheduledFor.After(time.Now()) {
		return publishing.CreateScheduledPostResult{}, ErrInvalidInput
	}
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	// A key schedules approved campaign variants only.
	if input.ContentDraftID != "" && !actor.IsSession() {
		return publishing.CreateScheduledPostResult{}, publishing.ErrForbidden
	}
	if input.ContentDraftID != "" {
		return publishing.CreateScheduledPostResult{}, conflict("Schedule a content draft from the draft (POST /api/v1/content-drafts/{id}/schedule): it checks the draft's approval and sends its stored text.")
	}
	// The caption is the caller's: hold it to the brand's terms and those of
	// the account's social set, as every other write path does.
	connection, err := c.client.ChannelConnection.Query().Where(channelconnection.ID(input.ChannelConnectionID),
		channelconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.CreateScheduledPostResult{}, publishing.ErrNotFound
	}
	if err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	// A key's private-set refusal comes first: it answers not found, so a
	// prohibited-phrase message cannot reveal the set.
	if !actor.IsSession() {
		if err := c.requireKeySchedule(ctx, actor, input); err != nil {
			return publishing.CreateScheduledPostResult{}, err
		}
	}
	// A retry of a key that already scheduled replays it, even if a term was
	// prohibited since; only new copy is checked.
	replay, err := c.client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ChannelConnectionID(input.ChannelConnectionID), scheduledpost.IdempotencyKey(input.IdempotencyKey)).Exist(ctx)
	if err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	if !replay {
		if err := requireAllowedCopy(ctx, c.client, actor.OrganizationID, connection.SocialSetID, input.Caption); err != nil {
			return publishing.CreateScheduledPostResult{}, err
		}
	}
	// The legacy variant scheduler stays paid; free content drafts use the
	// versioned draft scheduling path with its account/seat and option checks.
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "workspace:paid"); err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	refund, err := c.ChargeMonthlyQuota(ctx, actor.OrganizationID, QuotaPosts, 1)
	if err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	result, err := c.auth.CreateScheduledPost(ctx, actor.auditActor(), input)
	if err != nil || !result.Created {
		refund()
	}
	return result, err
}

// ListScheduledPosts reads the schedule, newest first, for a publisher's
// session or an API key. The caller checked the key's artifact:read scope, as
// for every read.
func (c *Configuration) ListScheduledPosts(ctx context.Context, actor Actor, limit int) ([]*ent.ScheduledPost, error) {
	if !actor.IsSession() && actor.Kind != "api_key" {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor, "owner", "admin", "publisher"); err != nil {
		return nil, err
	}
	return c.auth.ListScheduledPosts(ctx, actor.OrganizationID, !actor.IsSession(), limit)
}

// CancelScheduledPost cancels a post that has not started publishing. Its
// workflow, if one is waiting, ends at its claim, which needs SCHEDULED.
func (c *Configuration) CancelScheduledPost(ctx context.Context, actor Actor, id string) (*ent.ScheduledPost, error) {
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return nil, err
	}
	return c.auth.CancelScheduledPost(ctx, actor.auditActor(), id)
}

// ScheduledPostView is a scheduled post as /v1 and MCP return it, with its
// channel connection when it was loaded.
func ScheduledPostView(post *ent.ScheduledPost) map[string]any {
	response := map[string]any{
		"id": post.ID, "caption": post.Caption, "channelConnectionId": post.ChannelConnectionID,
		"createdAt": post.CreatedAt, "scheduledFor": post.ScheduledFor, "status": post.Status,
		"updatedAt": post.UpdatedAt, "variantId": post.VariantID, "contentDraftId": post.ContentDraftID,
	}
	if connection, err := post.Edges.ChannelConnectionOrErr(); err == nil {
		response["channelConnection"] = map[string]any{
			"externalAccountId": connection.ExternalAccountID,
			"platform":          connection.Platform,
			"provider":          connection.Provider,
		}
	}
	return response
}
