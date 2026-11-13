package product

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/postdeletion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// PostDeleteScope lets an API key delete published posts from their platforms.
const PostDeleteScope = "post:delete"

// ErrPostDeletionNotStarted is a delete that was allowed and audited but whose
// workflow did not start. A repeated request is safe: it joins the run.
var ErrPostDeletionNotStarted = errors.New("The delete could not start. Try again: the post is deleted only once.")

// PostDeletionStarter starts the workflow that deletes a published post.
type PostDeletionStarter interface {
	StartDelete(ctx context.Context, organizationID, postID, requestedBy string) error
}

// WithPostDeletions sets what starts post deletions.
func (c *Configuration) WithPostDeletions(starter PostDeletionStarter) *Configuration {
	c.postDeletions = starter
	return c
}

// DeletionRequest is a started delete. Its workflow removes the post's parts
// with receipts.
type DeletionRequest struct {
	OrganizationID string `json:"organizationId"`
	PostID         string `json:"postId"`
	Platform       string `json:"platform"`
	RequestedBy    string `json:"requestedBy"`
}

// DeleteContentDraftPost checks that the actor may delete this live post (the
// people who may publish it, or a key with post:delete), records the audit
// entry, and starts the workflow that deletes it from its platform.
func (c *Configuration) DeleteContentDraftPost(ctx context.Context, actor Actor, postID string) (*DeletionRequest, error) {
	if c.postDeletions == nil {
		return nil, ErrPostDeletionNotStarted
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	post, err := c.draftPostWithAccess(ctx, tx, actor, postID, c.authorizeDeletion)
	if err != nil {
		return nil, err
	}
	if post.Status != scheduledpost.StatusPUBLISHED || post.RemotePostID == nil || *post.RemotePostID == "" {
		return nil, conflict("Only a published post can be deleted from its platform.")
	}
	// A key reaches only the accounts of shared social sets, as when it schedules.
	if err := requireSharedAccount(ctx, c.client, actor, post.Edges.ChannelConnection); err != nil {
		return nil, err
	}
	// A deleted post takes a new request only to retry a part still left.
	if post.DeletedAt != nil {
		left, err := tx.PostDeletion.Query().Where(postdeletion.ScheduledPostID(post.ID),
			postdeletion.StatusIn(postdeletion.StatusPending, postdeletion.StatusFailed)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !left {
			return nil, conflict("This post was already deleted from its platform.")
		}
	}
	// A new request retries a refused part, for example after a reconnect.
	if _, err := tx.PostDeletion.Update().Where(postdeletion.ScheduledPostID(post.ID), postdeletion.StatusEQ(postdeletion.StatusFailed)).
		SetStatus(postdeletion.StatusPending).ClearFailureCode().Save(ctx); err != nil {
		return nil, err
	}
	platform := post.Edges.ChannelConnection.Platform
	if err := appendConfigurationAudit(ctx, tx, actor, "post.delete_requested", "scheduled_post", post.ID,
		map[string]any{"platform": platform}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	request := &DeletionRequest{OrganizationID: actor.OrganizationID, PostID: post.ID, Platform: platform, RequestedBy: commentAuthorID(actor)}
	if err := c.postDeletions.StartDelete(ctx, request.OrganizationID, request.PostID, request.RequestedBy); err != nil {
		slog.ErrorContext(ctx, "post delete did not start", "postId", request.PostID, "error", err)
		return nil, ErrPostDeletionNotStarted
	}
	return request, nil
}

// authorizeDeletion admits the people who may publish, or a key with post:delete.
func (c *Configuration) authorizeDeletion(ctx context.Context, actor Actor) error {
	switch {
	case actor.IsSession():
		return c.authorizeRoles(ctx, actor, "owner", "admin", "publisher")
	case actor.Kind == "api_key":
		return c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, PostDeleteScope)
	}
	return publishing.ErrForbidden
}

// PostDeletionReceipt is one part of a delete: pending, done, failed or
// unsupported. FailureCode is a short code such as "http_403", never a
// provider message.
type PostDeletionReceipt struct {
	Attempts    int       `json:"attempts"`
	FailureCode *string   `json:"failureCode"`
	Key         string    `json:"key"`
	Kind        string    `json:"kind"`
	Status      string    `json:"status"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// deletionReceipts are the posts' delete parts by post, by key.
func (c *Configuration) deletionReceipts(ctx context.Context, posts ...*ent.ScheduledPost) (map[string][]PostDeletionReceipt, error) {
	ids := make([]string, len(posts))
	for index, post := range posts {
		ids[index] = post.ID
	}
	rows, err := c.client.PostDeletion.Query().Where(postdeletion.ScheduledPostIDIn(ids...)).
		Order(ent.Asc(postdeletion.FieldKey)).All(ctx)
	if err != nil {
		return nil, err
	}
	byPost := map[string][]PostDeletionReceipt{}
	for _, row := range rows {
		byPost[row.ScheduledPostID] = append(byPost[row.ScheduledPostID], PostDeletionReceipt{
			Attempts: row.Attempts, FailureCode: row.FailureCode, Key: row.Key, Kind: string(row.Kind),
			Status: string(row.Status), UpdatedAt: row.UpdatedAt,
		})
	}
	return byPost, nil
}
