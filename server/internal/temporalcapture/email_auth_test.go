package temporalcapture

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

type authCalls struct{ request, check, apply int }

func emailAuthEnvironment(calls *authCalls, request *product.CaptureAuthStep, checks []product.CaptureAuthStep, applyErr error) *testsuite.TestWorkflowEnvironment {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(func(context.Context, Input) (*product.CaptureAuthStep, error) {
		calls.request++
		return request, nil
	}, activity.RegisterOptions{Name: RequestAuthActivity})
	env.RegisterActivityWithOptions(func(context.Context, Input) (*product.CaptureAuthStep, error) {
		step := checks[min(calls.check, len(checks)-1)]
		calls.check++
		return &step, nil
	}, activity.RegisterOptions{Name: CheckAuthActivity})
	env.RegisterActivityWithOptions(func(context.Context, Input) error {
		calls.apply++
		return applyErr
	}, activity.RegisterOptions{Name: ApplyAuthActivity})
	return env
}

func TestEmailAuthWorkflowWaitsDurablyThenAppliesOnce(t *testing.T) {
	calls := &authCalls{}
	env := emailAuthEnvironment(calls, &product.CaptureAuthStep{}, []product.CaptureAuthStep{{}, {}, {Matched: true}}, nil)
	started := env.Now()
	env.ExecuteWorkflow(EmailAuthWorkflow, Input{OrganizationID: "org", ID: "attempt"})
	if !env.IsWorkflowCompleted() || env.GetWorkflowError() != nil || calls.request != 1 || calls.check != 3 || calls.apply != 1 {
		t.Fatalf("err=%v calls=%+v", env.GetWorkflowError(), calls)
	}
	if waited := env.Now().Sub(started); waited < 2*emailAuthPoll {
		t.Fatalf("waited only %s", waited)
	}
}

func TestEmailAuthWorkflowWakesOnTheEmailSignal(t *testing.T) {
	calls := &authCalls{}
	env := emailAuthEnvironment(calls, &product.CaptureAuthStep{}, []product.CaptureAuthStep{{Matched: true}}, nil)
	env.RegisterDelayedCallback(func() { env.SignalWorkflow(EmailSignal, nil) }, time.Second)
	started := env.Now()
	env.ExecuteWorkflow(EmailAuthWorkflow, Input{OrganizationID: "org", ID: "attempt"})
	if env.GetWorkflowError() != nil || calls.apply != 1 || env.Now().Sub(started) >= emailAuthPoll {
		t.Fatalf("err=%v calls=%+v waited=%s", env.GetWorkflowError(), calls, env.Now().Sub(started))
	}
}

func TestEmailAuthWorkflowStopsWhenTheAttemptEnds(t *testing.T) {
	calls := &authCalls{}
	env := emailAuthEnvironment(calls, &product.CaptureAuthStep{Done: true}, []product.CaptureAuthStep{{}}, nil)
	env.ExecuteWorkflow(EmailAuthWorkflow, Input{OrganizationID: "org", ID: "attempt"})
	if env.GetWorkflowError() != nil || calls.check != 0 || calls.apply != 0 {
		t.Fatalf("a finished request went on: %+v", calls)
	}
	calls = &authCalls{}
	env = emailAuthEnvironment(calls, &product.CaptureAuthStep{}, []product.CaptureAuthStep{{}, {Done: true}}, nil)
	env.ExecuteWorkflow(EmailAuthWorkflow, Input{OrganizationID: "org", ID: "attempt"})
	if env.GetWorkflowError() != nil || calls.apply != 0 {
		t.Fatalf("an expired attempt applied: %+v", calls)
	}
}

// Neither browser step retries: a lost request may have sent an email, and a
// failed apply may have spent the link.
func TestEmailAuthWorkflowNeverRetriesBrowserSteps(t *testing.T) {
	calls := &authCalls{}
	env := emailAuthEnvironment(calls, &product.CaptureAuthStep{}, []product.CaptureAuthStep{{Matched: true}}, errors.New("browser gone"))
	env.ExecuteWorkflow(EmailAuthWorkflow, Input{OrganizationID: "org", ID: "attempt"})
	if env.GetWorkflowError() == nil || calls.apply != 1 {
		t.Fatalf("err=%v calls=%+v", env.GetWorkflowError(), calls)
	}
}
