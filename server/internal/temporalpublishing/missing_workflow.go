package temporalpublishing

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const missingPostIterationsPerRun = 24

func MissingPostWorkflow(ctx workflow.Context) error {
	activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           workflow.GetInfo(ctx).TaskQueueName,
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Minute,
			BackoffCoefficient: 1,
			MaximumAttempts:    3,
		},
	})
	version := workflow.GetVersion(ctx, "missing-post-continue-as-new", workflow.DefaultVersion, 1)
	for iteration := 0; ; iteration++ {
		if err := workflow.ExecuteActivity(activityCtx, RecoverActivityName).Get(ctx, nil); err != nil {
			if version == workflow.DefaultVersion || temporal.IsCanceledError(err) {
				return err
			}
			workflow.GetLogger(ctx).Error("missing-post recovery iteration failed; retrying next hour", "error", err)
		}
		if err := workflow.Sleep(ctx, time.Hour); err != nil {
			return err
		}
		if version >= 1 && (iteration+1 >= missingPostIterationsPerRun || workflow.GetInfo(ctx).GetContinueAsNewSuggested()) {
			return workflow.NewContinueAsNewError(ctx, MissingWorkflowName)
		}
	}
}
