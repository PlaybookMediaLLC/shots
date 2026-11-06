package product

import (
	"context"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
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

// CreateScheduledPost schedules an approved variant, or for a session a
// content draft, to a channel connection and charges the monthly posts
// allowance. A replay of the same idempotency
// key returns the first post and is not charged again.
func (c *Configuration) CreateScheduledPost(ctx context.Context, actor Actor,
	input publishing.CreateScheduledPostInput) (publishing.CreateScheduledPostResult, error) {
	input.Caption = strings.TrimSpace(input.Caption)
	if input.Caption == "" || input.IdempotencyKey == "" || !input.ScheduledFor.After(time.Now()) {
		return publishing.CreateScheduledPostResult{}, ErrInvalidInput
	}
	if err := c.authorizeScheduling(ctx, actor); err != nil {
		return publishing.CreateScheduledPostResult{}, err
	}
	// A content draft has no approval step, so only a person schedules one
	// (RFC 013). A key schedules approved campaign variants only.
	if input.ContentDraftID != "" && !actor.IsSession() {
		return publishing.CreateScheduledPostResult{}, publishing.ErrForbidden
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
