package temporalpublishing

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// A live post's follow-ups (RFC 025): its first comment or YouTube thumbnail, reposts at
// set times and their removal, a plug reply once it has enough engagement,
// and the RFC 013 like-gated repost and quote. Each step has a receipt keyed
// by post and step, written before the step acts again, so a retried
// activity or a replayed workflow never posts twice; cancelling marks the
// pending receipts and the steps then do nothing.

const (
	PlanAutomationsActivityName = "PlanPostAutomations"
	RunAutomationActivityName   = "RunPostAutomation"
)

// The step kinds; they match post_automation_run.kind.
const (
	AutomationFirstComment  = "first_comment"
	AutomationRetweet       = "retweet"
	AutomationUnretweet     = "unretweet"
	AutomationPlug          = "plug"
	AutomationRepostAtLikes = "repost_at_likes"
	AutomationQuote         = "quote"
	AutomationThumbnail     = "thumbnail"
)

// Receipt states; they match post_automation_run.status.
const (
	ReceiptPending   = "pending"
	ReceiptDone      = "done"
	ReceiptFailed    = "failed"
	ReceiptSkipped   = "skipped"
	ReceiptCancelled = "cancelled"
	ReceiptExpired   = "expired"
)

// plugWindow is how long a plug waits for its threshold before it expires.
const plugWindow = 48 * time.Hour

// AutomationStep is one try of a follow-up. Engagement-gated steps (a plug,
// a like-gated repost) are tried several times under one key; Final marks
// the last try, after which an unmet threshold expires.
type AutomationStep struct {
	At    time.Time
	Final bool
	Key   string
	Kind  string
	Rule  int
}

// PlanAutomationsInput asks for a live post's follow-ups.
type PlanAutomationsInput struct {
	Job         PreparedPublication
	ProviderID  string
	PublishedAt time.Time
}

// AutomationInput runs one step.
type AutomationInput struct {
	Job        PreparedPublication
	ProviderID string
	Step       AutomationStep
}

// AutomationResult says whether the step's key is settled: done, failed,
// skipped, cancelled or expired. An unsettled key is tried at its next step.
type AutomationResult struct {
	Settled bool
}

// automationStore keeps the receipts.
type automationStore interface {
	// PlanAutomations records a pending receipt per key (once) and returns
	// every key's status.
	PlanAutomations(ctx context.Context, organizationID, postID string, receipts []publishing.AutomationReceipt) (map[string]string, error)
	AutomationReceipt(ctx context.Context, postID, key string) (status, remoteID string, err error)
	// RecordAutomation settles a pending receipt, or counts a try when
	// status is pending. It reports false when the receipt was no longer
	// pending (cancelled meanwhile), so the step's result is not recorded.
	RecordAutomation(ctx context.Context, postID, key, status, remoteID, failureCode string) (bool, error)
}

// automator runs a step against the platform.
type automator interface {
	Automate(context.Context, socialapi.AutomationInput) (socialapi.AutomationResult, error)
}

// automationPlan is a live post's follow-up steps, soonest first. Rules
// whose time cannot be worked out (a bad zone) are left out: validation
// refuses them before scheduling, so only a stored, stale rule lands here.
func automationPlan(job PreparedPublication, publishedAt time.Time) []AutomationStep {
	var steps []AutomationStep
	if job.Options != nil && strings.TrimSpace(job.Options.FirstComment) != "" &&
		(strings.HasPrefix(job.Platform, "linkedin") || strings.HasPrefix(job.Platform, "instagram") || job.Platform == "facebook") {
		steps = append(steps, AutomationStep{At: publishedAt, Key: "first-comment", Kind: AutomationFirstComment})
	}
	if job.Platform == "youtube" && job.Options != nil && job.Options.YouTube != nil && job.Options.YouTube.ThumbnailAssetID != "" {
		steps = append(steps, AutomationStep{At: publishedAt, Key: "thumbnail", Kind: AutomationThumbnail})
	}
	actions := job.AutoActions
	if actions == nil {
		return steps
	}
	for index, rule := range actions.Retweets {
		at, err := rule.When(publishedAt)
		if err != nil || at.Before(publishedAt) {
			continue
		}
		key := strconv.Itoa(index)
		steps = append(steps, AutomationStep{At: at, Key: "retweet:" + key, Kind: AutomationRetweet, Rule: index})
		if actions.UnretweetAfterMinutes > 0 {
			steps = append(steps, AutomationStep{
				At: at.Add(time.Duration(actions.UnretweetAfterMinutes) * time.Minute), Key: "unretweet:" + key,
				Kind: AutomationUnretweet, Rule: index,
			})
		}
	}
	if actions.PlugAtLikes > 0 && strings.TrimSpace(actions.PlugText) != "" {
		steps = append(steps, gatedChecks(publishedAt, "plug", AutomationPlug, plugChecks())...)
	}
	if actions.RepostAtLikes > 0 {
		steps = append(steps, gatedChecks(publishedAt, "repost-at-likes", AutomationRepostAtLikes, autoActionChecks)...)
	}
	if actions.QuoteAfterHours > 0 {
		steps = append(steps, AutomationStep{
			At: publishedAt.Add(time.Duration(actions.QuoteAfterHours) * time.Hour), Key: "quote", Kind: AutomationQuote,
		})
	}
	sort.SliceStable(steps, func(i, j int) bool { return steps[i].At.Before(steps[j].At) })
	return steps
}

// plugChecks are when a plug's threshold is checked: every 15 minutes for
// the first six hours, when engagement moves fastest, then hourly until the
// plug window closes.
func plugChecks() []time.Duration {
	var checks []time.Duration
	for at := 15 * time.Minute; at <= 6*time.Hour; at += 15 * time.Minute {
		checks = append(checks, at)
	}
	for at := 7 * time.Hour; at <= plugWindow; at += time.Hour {
		checks = append(checks, at)
	}
	return checks
}

func gatedChecks(publishedAt time.Time, key, kind string, checks []time.Duration) []AutomationStep {
	steps := make([]AutomationStep, len(checks))
	for index, wait := range checks {
		steps[index] = AutomationStep{At: publishedAt.Add(wait), Key: key, Kind: kind, Final: index == len(checks)-1}
	}
	return steps
}

// PlanAutomations records the post's follow-ups and returns the steps
// still to run: a step whose receipt is settled (a replayed workflow, a
// cancelled automation) is dropped.
func (a *Activities) PlanAutomations(ctx context.Context, input PlanAutomationsInput) ([]AutomationStep, error) {
	store, ok := a.store.(automationStore)
	steps := automationPlan(input.Job, input.PublishedAt)
	if !ok || len(steps) == 0 {
		return nil, nil
	}
	receipts := make([]publishing.AutomationReceipt, len(steps))
	for index, step := range steps {
		receipts[index] = publishing.AutomationReceipt{DueAt: step.At, Key: step.Key, Kind: step.Kind}
	}
	statuses, err := store.PlanAutomations(ctx, input.Job.OrganizationID, input.Job.PostID, receipts)
	if err != nil {
		return nil, err
	}
	pending := steps[:0]
	for _, step := range steps {
		if statuses[step.Key] == ReceiptPending {
			pending = append(pending, step)
		}
	}
	return pending, nil
}

// RunAutomation runs one step unless its receipt is settled. A removal runs
// only after its repost is done. A gated step whose threshold is not met
// stays pending until its final try, then expires. A failed step is not
// retried into a duplicate; its receipt keeps the failure code.
func (a *Activities) RunAutomation(ctx context.Context, input AutomationInput) (AutomationResult, error) {
	store, hasStore := a.store.(automationStore)
	actor, hasActor := a.provider.(automator)
	if !hasStore {
		return AutomationResult{Settled: true}, nil
	}
	step, postID := input.Step, input.Job.PostID
	status, _, err := store.AutomationReceipt(ctx, postID, step.Key)
	if err != nil {
		return AutomationResult{}, err
	}
	if status != ReceiptPending {
		return AutomationResult{Settled: true}, nil
	}
	settle := func(status, remoteID, code string) (AutomationResult, error) {
		_, err := store.RecordAutomation(ctx, postID, step.Key, status, remoteID, code)
		return AutomationResult{Settled: status != ReceiptPending}, err
	}
	if !hasActor {
		return settle(ReceiptSkipped, "", "unsupported")
	}
	request := socialapi.AutomationInput{
		DestinationID: input.Job.DestinationID, Kind: step.Kind, OrganizationID: input.Job.OrganizationID,
		Platform: input.Job.Platform, RemotePostID: input.ProviderID, SecretReference: input.Job.SecretReference,
	}
	actions := input.Job.AutoActions
	switch step.Kind {
	case AutomationFirstComment:
		if input.Job.Options != nil {
			request.Text = input.Job.Options.FirstComment
		}
	case AutomationThumbnail:
		if input.Job.Cover == nil {
			// The image was gone when the post went out; the video is live without it.
			return settle(ReceiptSkipped, "", "media_unavailable")
		}
		request.Media = input.Job.Cover
	case AutomationUnretweet:
		repost, _, err := store.AutomationReceipt(ctx, postID, "retweet:"+strconv.Itoa(step.Rule))
		if err != nil {
			return AutomationResult{}, err
		}
		if repost != ReceiptDone {
			return settle(ReceiptSkipped, "", "repost_not_done")
		}
	case AutomationPlug:
		if actions != nil {
			request.Threshold, request.Metric, request.Text = actions.PlugAtLikes, actions.PlugMetric, actions.PlugText
		}
	case AutomationRepostAtLikes:
		if actions != nil {
			request.Threshold, request.Metric = actions.RepostAtLikes, "likes"
		}
	case AutomationQuote:
		if actions != nil {
			request.Text = actions.QuoteText
		}
	}
	result, err := actor.Automate(ctx, request)
	if err != nil {
		if errors.Is(err, socialapi.ErrUnsupported) {
			return settle(ReceiptSkipped, "", "unsupported")
		}
		return settle(ReceiptFailed, "", automationFailureCode(err))
	}
	if !result.Done {
		if step.Final {
			return settle(ReceiptExpired, "", "threshold_not_reached")
		}
		return settle(ReceiptPending, "", "")
	}
	return settle(ReceiptDone, result.RemoteID, "")
}

// automationFailureCode is a short code for a receipt: the provider's HTTP
// status when it has one. Never the message, which may quote the post.
func automationFailureCode(err error) string {
	var failure *temporal.ApplicationError
	if errors.As(err, &failure) && failure.Type() == FailureUnknownDelivery {
		return "UNKNOWN_DELIVERY"
	}
	var status interface{ HTTPStatus() int }
	if errors.As(err, &status) && status.HTTPStatus() > 0 {
		return "http_" + strconv.Itoa(status.HTTPStatus())
	}
	return "provider_error"
}

// runAutomations runs a live post's follow-ups in order: each step waits
// for its time, then runs once; a key settles at its first settled step.
// A step's activity failing outright leaves its key pending for its next
// step, if any. The post is live either way.
func runAutomations(ctx workflow.Context, input WorkflowInput, job PreparedPublication, providerID string) {
	mainCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue: mainQueue(input), StartToCloseTimeout: time.Minute,
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	var steps []AutomationStep
	if err := workflow.ExecuteActivity(mainCtx, PlanAutomationsActivityName, PlanAutomationsInput{
		Job: job, ProviderID: providerID, PublishedAt: workflow.Now(ctx),
	}).Get(ctx, &steps); err != nil {
		workflow.GetLogger(ctx).Error("follow-ups were not planned; the post is live without them", "post", job.PostID, "error", err)
		return
	}
	stepCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue: input.ActivityTaskQueue, StartToCloseTimeout: 2 * time.Minute,
		// One retry for a dropped connection; the receipt makes it safe.
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 2},
	})
	settled := map[string]bool{}
	for _, step := range steps {
		if settled[step.Key] {
			continue
		}
		if wait := step.At.Sub(workflow.Now(ctx)); wait > 0 {
			if err := workflow.Sleep(ctx, wait); err != nil {
				return
			}
		}
		var result AutomationResult
		if err := workflow.ExecuteActivity(stepCtx, RunAutomationActivityName, AutomationInput{
			Job: job, ProviderID: providerID, Step: step,
		}).Get(ctx, &result); err != nil {
			continue
		}
		settled[step.Key] = result.Settled
	}
}

func mainQueue(input WorkflowInput) string {
	if input.MainTaskQueue != "" {
		return input.MainTaskQueue
	}
	return DefaultWorkflowQueue
}
