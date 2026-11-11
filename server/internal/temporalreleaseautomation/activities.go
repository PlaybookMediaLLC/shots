package temporalreleaseautomation

import (
	"context"
	"errors"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
)

type Activities struct{ Store *product.Configuration }

func temporalError(err error, target **temporal.ApplicationError) bool { return errors.As(err, target) }

func activityError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, product.ErrAutomationStopped) {
		return temporal.NewNonRetryableApplicationError("Automation access withdrawn", StoppedError, nil)
	}
	if errors.Is(err, product.ErrCaptureSuperseded) {
		return temporal.NewNonRetryableApplicationError("A newer deployment superseded this run", SupersededError, nil)
	}
	var github githubapp.StatusError
	if errors.As(err, &github) && !github.RateLimited && (github.Status == 401 || github.Status == 403 || github.Status == 404) {
		return temporal.NewNonRetryableApplicationError("Repository access requires attention", PermanentError, nil)
	}
	if product.PermanentAutomationError(err) || errors.Is(err, githubapp.ErrIncompleteFiles) {
		return temporal.NewNonRetryableApplicationError("Automation configuration requires attention", PermanentError, nil)
	}
	// Provider/database errors can contain private URLs or query parameters.
	return temporal.NewApplicationError("Release automation activity failed", "ReleaseAutomationInfrastructure")
}

func (a *Activities) Load(ctx context.Context, input Input) (*product.AutomationRunInput, error) {
	result, err := a.Store.LoadReleaseAutomation(ctx, input.OrganizationID, input.RunID, input.Attempt)
	return result, activityError(err)
}
func (a *Activities) Enrich(ctx context.Context, input Input) (automation.Event, error) {
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx)
			}
		}
	}()
	result, err := a.Store.EnrichReleaseAutomation(ctx, input.OrganizationID, input.RunID, input.Attempt)
	return result, activityError(err)
}
func (a *Activities) Select(ctx context.Context, input Selection) error {
	return activityError(a.Store.SelectReleaseAutomation(ctx, input.Run.OrganizationID, input.Run.RunID, input.VersionID, input.Run.Attempt))
}
func (a *Activities) Node(ctx context.Context, input NodeInput) (automation.Outputs, error) {
	result, err := a.Store.AutomationNode(ctx, input.Run.OrganizationID, input.Run.RunID, input.NodeID, input.Decision, input.Run.Attempt)
	return result, activityError(err)
}
func (a *Activities) Classify(ctx context.Context, input NodeInput) (automation.Decision, error) {
	result, err := a.Store.AutomationClassify(ctx, input.Run.OrganizationID, input.Run.RunID, input.NodeID, input.Run.Attempt)
	return result, activityError(err)
}
func (a *Activities) Legacy(ctx context.Context, input Input) error {
	return activityError(a.Store.RunLegacyReleaseEvent(ctx, input.OrganizationID, input.RunID, input.Attempt))
}
func (a *Activities) Collect(ctx context.Context, input Input) (string, error) {
	kind, err := a.Store.CollectAutomationChange(ctx, input.OrganizationID, input.RunID, input.Attempt)
	return kind, activityError(err)
}
func (a *Activities) Finish(ctx context.Context, input Finish) error {
	return activityError(a.Store.FinishReleaseAutomation(ctx, input.Run.OrganizationID, input.Run.RunID, input.Status, input.Code, input.Reason, input.Run.Attempt))
}
