package temporalpublishing

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
)

// Deleting a published post (docs/scheduling/post-delete): one workflow per
// post plans the parts, removes each with safe retries, then settles.
const (
	DeleteWorkflowName         = "PostDeleteWorkflowV1"
	PlanDeletionActivityName   = "PlanPostDeletion"
	DeletePartActivityName     = "DeletePostPart"
	SettleDeletionActivityName = "SettlePostDeletion"
	ReceiptUnsupported         = "unsupported"
	// deleteMaxAttempts bounds the retries of a transient answer; the last
	// one records the part failed, so no receipt stays pending.
	deleteMaxAttempts = 8
	// deleteMaxRetryDelay is the longest wait for a platform's reset: X's
	// 15-minute window. It is also the retry policy's MaximumInterval, which
	// the server applies to a requested delay. A later reset, such as a daily
	// cap, fails the part at once; a new request retries it.
	deleteMaxRetryDelay = 15 * time.Minute
)

// DeleteWorkflowID gives each post one delete run; a repeated request joins it.
func DeleteWorkflowID(postID string) string { return "post_delete_" + postID }

// DeleteWorkflowInput is a request to delete a published post.
type DeleteWorkflowInput struct {
	ActivityTaskQueue string
	MainTaskQueue     string
	OrganizationID    string
	PostID            string
	RequestedBy       string
}

// DeletePartInput removes one part through the post's connection.
type DeletePartInput struct {
	Plan publishing.DeletionPlan
	Part publishing.DeletionPart
}

type deletionStore interface {
	PlanDeletion(ctx context.Context, organizationID, postID, requestedBy string) (*publishing.DeletionPlan, error)
	RecordDeletion(ctx context.Context, postID, key, status, failureCode string) error
	SettleDeletion(ctx context.Context, postID string) (bool, error)
}

// PostDeleteWorkflow removes each pending part in order. A part that cannot
// be removed is recorded and the others continue. It plans twice: a reply or
// repost that a follow-up made while the first pass ran is in the second.
func PostDeleteWorkflow(ctx workflow.Context, input DeleteWorkflowInput) error {
	main := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue: queueOr(input.MainTaskQueue, DefaultWorkflowQueue), StartToCloseTimeout: time.Minute,
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 5},
	})
	social := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue: queueOr(input.ActivityTaskQueue, DefaultActivityQueue), StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 10 * time.Second, BackoffCoefficient: 2, MaximumInterval: deleteMaxRetryDelay,
			MaximumAttempts: deleteMaxAttempts,
		},
	})
	tried := map[string]bool{}
	for pass := 0; pass < 2; pass++ {
		var plan publishing.DeletionPlan
		if err := workflow.ExecuteActivity(main, PlanDeletionActivityName, input).Get(ctx, &plan); err != nil {
			return err
		}
		for _, part := range plan.Parts {
			if part.Status != ReceiptPending || tried[part.Key] {
				continue
			}
			tried[part.Key] = true
			parts := plan
			parts.Parts = nil
			_ = workflow.ExecuteActivity(social, DeletePartActivityName, DeletePartInput{Plan: parts, Part: part}).Get(ctx, nil)
		}
	}
	return workflow.ExecuteActivity(main, SettleDeletionActivityName, input.PostID).Get(ctx, nil)
}

func queueOr(queue, fallback string) string {
	if queue != "" {
		return queue
	}
	return fallback
}

// PlanDeletion records the post's parts and cancels its pending follow-ups.
func (a *Activities) PlanDeletion(ctx context.Context, input DeleteWorkflowInput) (*publishing.DeletionPlan, error) {
	store, ok := a.store.(deletionStore)
	if !ok {
		return nil, temporal.NewNonRetryableApplicationError("deletion is not available", "deletion_unavailable", nil)
	}
	plan, err := store.PlanDeletion(ctx, input.OrganizationID, input.PostID, input.RequestedBy)
	if errors.Is(err, publishing.ErrNotFound) || errors.Is(err, publishing.ErrInvalidState) {
		return nil, temporal.NewNonRetryableApplicationError(err.Error(), "deletion_refused", nil)
	}
	return plan, err
}

// DeletePart removes one part and records the outcome. A transient answer
// is retried by Temporal until the last attempt, which records it failed.
func (a *Activities) DeletePart(ctx context.Context, input DeletePartInput) error {
	store, hasStore := a.store.(deletionStore)
	if !hasStore {
		return nil
	}
	plan, part := input.Plan, input.Part
	// A repost is undone; a post, thread part or reply is deleted.
	kind := "delete"
	if part.Kind == "repost" {
		kind = AutomationUnretweet
	}
	err := socialapi.ErrUnsupported
	if actor, ok := a.provider.(automator); ok {
		_, err = actor.Automate(ctx, socialapi.AutomationInput{
			DestinationID: plan.DestinationID, Kind: kind, OrganizationID: plan.OrganizationID,
			Platform: plan.Platform, RemotePostID: part.RemoteID, SecretReference: plan.SecretReference,
		})
	}
	status, code, retry := deletionOutcome(err)
	wait := retryDelay(err, time.Now())
	if retry && wait > deleteMaxRetryDelay {
		retry, status = false, ReceiptFailed
	}
	if retry && activity.GetInfo(ctx).Attempt < deleteMaxAttempts {
		if err := store.RecordDeletion(ctx, plan.PostID, part.Key, ReceiptPending, code); err != nil {
			return err
		}
		return temporal.NewApplicationErrorWithOptions("the platform did not answer the delete; it will be retried",
			"delete_transient", temporal.ApplicationErrorOptions{NextRetryDelay: wait})
	}
	if retry {
		status = ReceiptFailed
	}
	return store.RecordDeletion(ctx, plan.PostID, part.Key, status, code)
}

// SettleDeletion marks the post deleted once its root is gone.
func (a *Activities) SettleDeletion(ctx context.Context, postID string) error {
	if store, ok := a.store.(deletionStore); ok {
		_, err := store.SettleDeletion(ctx, postID)
		return err
	}
	return nil
}

// retryDelay is the wait until a rate limit's reset (X's x-rate-limit-reset,
// a Retry-After header), with a second for clock skew. Only a 429 names a
// reset worth waiting for; zero keeps Temporal's backoff.
func retryDelay(err error, now time.Time) time.Duration {
	var limited interface {
		HTTPStatus() int
		RetryAt() time.Time
	}
	if !errors.As(err, &limited) || limited.HTTPStatus() != http.StatusTooManyRequests {
		return 0
	}
	if wait := limited.RetryAt().Sub(now); !limited.RetryAt().IsZero() && wait > 0 {
		return wait + time.Second
	}
	return 0
}

// deletionOutcome classifies a delete: gone (404, 410) counts as done; a
// timeout, a network failure, 429 or 5xx is transient; another status is a
// refusal; a platform without the call is unsupported. A coded error is
// Shots' own cause, such as a removed account, never the platform's answer,
// so it is not done.
func deletionOutcome(err error) (status, code string, retry bool) {
	if err == nil {
		return ReceiptDone, "", false
	}
	if errors.Is(err, socialapi.ErrUnsupported) {
		return ReceiptUnsupported, "unsupported", false
	}
	var coded *socialapi.Error
	if errors.As(err, &coded) && coded.Code != "" {
		return ReceiptFailed, coded.Code, false
	}
	var withStatus interface{ HTTPStatus() int }
	if errors.As(err, &withStatus) {
		switch answer := withStatus.HTTPStatus(); {
		case answer == 404 || answer == 410:
			return ReceiptDone, "", false
		case answer == 429 || answer >= 500:
			return ReceiptPending, "http_" + strconv.Itoa(answer), true
		case answer > 0:
			return ReceiptFailed, "http_" + strconv.Itoa(answer), false
		}
	}
	var network net.Error
	if errors.As(err, &network) || errors.Is(err, context.DeadlineExceeded) {
		return ReceiptPending, "network", true
	}
	return ReceiptFailed, "provider_error", false
}
