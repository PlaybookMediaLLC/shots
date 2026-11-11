package temporalreleaseautomation

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

type executionFixture struct {
	loaded    product.AutomationRunInput
	selected  string
	nodes     []string
	collected int
	kind      string
	legacy    int
	finish    Finish
	enrich    func() (automation.Event, error)
	node      func(NodeInput) error
}

func testGraph() automation.Graph {
	return automation.Graph{SchemaVersion: 1, Family: automation.Published,
		Qualification: automation.Condition{Field: "release.tag", Operator: "glob", Values: []string{"v*"}},
		Nodes:         []automation.Node{{ID: "start", Type: "trigger"}, {ID: "stable", Type: "condition", Condition: &automation.Condition{Field: "release.prerelease", Operator: "is_false"}}, {ID: "release", Type: "action", Action: &automation.Action{Type: "create_release"}}, {ID: "end", Type: "end", Outcome: "completed"}, {ID: "skip", Type: "end", Outcome: "skipped"}},
		Edges:         []automation.Edge{{From: "start", To: "stable", Branch: "next"}, {From: "stable", To: "release", Branch: "true"}, {From: "stable", To: "skip", Branch: "false"}, {From: "release", To: "end", Branch: "next"}},
	}
}

func fixture() *executionFixture {
	return &executionFixture{loaded: product.AutomationRunInput{Mode: "automation", Event: automation.Event{Family: automation.Published, Origin: "live", Fields: map[string]automation.Value{"release.tag": automation.StringValue("v1"), "release.prerelease": automation.BoolValue(false)}}, Plans: []product.AutomationPlan{{DefinitionID: "definition-1", VersionID: "version-1", Graph: testGraph()}, {DefinitionID: "definition-2", VersionID: "version-2", Graph: testGraph()}}}}
}

func environment(t *testing.T, f *executionFixture) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	env.RegisterActivityWithOptions(func(context.Context, Input) (product.AutomationRunInput, error) { return f.loaded, nil }, activity.RegisterOptions{Name: LoadActivity})
	env.RegisterActivityWithOptions(func(_ context.Context, input Selection) error { f.selected = input.VersionID; return nil }, activity.RegisterOptions{Name: SelectActivity})
	env.RegisterActivityWithOptions(func(_ context.Context, input NodeInput) (automation.Outputs, error) {
		f.nodes = append(f.nodes, input.NodeID)
		if f.node != nil {
			return automation.Outputs{}, f.node(input)
		}
		return automation.Outputs{}, nil
	}, activity.RegisterOptions{Name: NodeActivity})
	env.RegisterActivityWithOptions(func(context.Context, Input) (automation.Event, error) { return f.enrich() }, activity.RegisterOptions{Name: EnrichActivity})
	if f.kind == "" {
		// A worker from before deployment kinds returns no result.
		env.RegisterActivityWithOptions(func(context.Context, Input) error { f.collected++; return nil }, activity.RegisterOptions{Name: CollectActivity})
	} else {
		env.RegisterActivityWithOptions(func(context.Context, Input) (string, error) { f.collected++; return f.kind, nil }, activity.RegisterOptions{Name: CollectActivity})
	}
	env.RegisterActivityWithOptions(func(context.Context, Input) error { f.legacy++; return nil }, activity.RegisterOptions{Name: LegacyActivity})
	env.RegisterActivityWithOptions(func(_ context.Context, value Finish) error { f.finish = value; return nil }, activity.RegisterOptions{Name: FinishActivity})
	return env
}

func TestInterpreterFirstMatchAndBranches(t *testing.T) {
	for _, prerelease := range []bool{false, true} {
		f := fixture()
		f.loaded.Event.Fields["release.prerelease"] = automation.BoolValue(prerelease)
		env := environment(t, f)
		env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
		if err := env.GetWorkflowError(); err != nil {
			t.Fatal(err)
		}
		want := []string{"start", "stable", "release", "end"}
		status := "succeeded"
		if prerelease {
			want = []string{"start", "stable", "skip"}
			status = "skipped"
		}
		if f.selected != "version-1" || !reflect.DeepEqual(f.nodes, want) || f.finish.Status != status {
			t.Fatalf("selection=%s nodes=%v finish=%+v", f.selected, f.nodes, f.finish)
		}
	}
}

func TestInterpreterMissingEvidenceNeverTakesFalseBranch(t *testing.T) {
	f := fixture()
	f.loaded.Event.Fields["release.prerelease"] = automation.Value{State: "missing"}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	if f.finish.Status != "needs_attention" || !reflect.DeepEqual(f.nodes, []string{"start", "stable"}) {
		t.Fatalf("nodes=%v finish=%+v", f.nodes, f.finish)
	}
}

func TestInterpreterRetriesSameLogicalNode(t *testing.T) {
	f := fixture()
	attempts := 0
	f.node = func(input NodeInput) error {
		if input.Run.Attempt != 2 || input.Run.RunID != "run" {
			t.Errorf("identity changed: %+v", input)
		}
		if input.NodeID == "release" {
			attempts++
			if attempts == 1 {
				return errors.New("database unavailable")
			}
		}
		return nil
	}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run", Attempt: 2})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 || f.finish.Status != "succeeded" {
		t.Fatalf("attempts=%d finish=%+v", attempts, f.finish)
	}
}

func TestInterpreterRevokedAccessStopsActions(t *testing.T) {
	f := fixture()
	f.node = func(input NodeInput) error {
		if input.NodeID == "release" {
			return temporal.NewNonRetryableApplicationError("revoked", StoppedError, nil)
		}
		return nil
	}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() == nil || f.finish.Status != "cancelled" || len(f.nodes) != 3 {
		t.Fatalf("nodes=%v finish=%+v", f.nodes, f.finish)
	}
}

func TestInterpreterHistoricalAndLegacySeparation(t *testing.T) {
	f := fixture()
	f.loaded.Event.Origin = "historical"
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() != nil || f.finish.Status != "skipped" || len(f.nodes) > 0 {
		t.Fatalf("historical ran actions: %+v", f)
	}
	f = fixture()
	f.loaded.Mode = "legacy"
	env = environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() != nil || f.legacy != 1 || len(f.nodes) > 0 {
		t.Fatalf("legacy used graph: %+v", f)
	}
}

func TestInterpreterFailedEnrichmentStopsBeforeSelection(t *testing.T) {
	f := fixture()
	f.loaded.Event.Family = automation.Merged
	f.loaded.Event.Fields = map[string]automation.Value{"pr.files": {State: "pending"}}
	g := testGraph()
	g.Family = automation.Merged
	g.Qualification = automation.Condition{Field: "pr.files", Operator: "glob", Values: []string{"src/*"}}
	g.Nodes[1].Condition = &automation.Condition{Field: "pr.files", Operator: "exists"}
	f.loaded.Plans = []product.AutomationPlan{{VersionID: "version-1", Graph: g}}
	f.enrich = func() (automation.Event, error) {
		return automation.Event{}, temporal.NewNonRetryableApplicationError("incomplete", PermanentError, nil)
	}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() == nil || f.selected != "" || len(f.nodes) > 0 || f.finish.Status != "needs_attention" {
		t.Fatalf("failed evidence executed: %+v", f)
	}
}

func TestInterpreterCancellationPersistsOutcome(t *testing.T) {
	f := fixture()
	env := environment(t, f)
	env.OnActivity(LoadActivity, mock.Anything, mock.Anything).Return(func(context.Context, Input) (product.AutomationRunInput, error) { return f.loaded, nil }).After(time.Minute)
	env.RegisterDelayedCallback(env.CancelWorkflow, time.Second)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() == nil || f.finish.Status != "cancelled" || len(f.nodes) > 0 {
		t.Fatalf("cancelled workflow: %+v", f)
	}
}

func TestInterpreterUnmatchedPRCollectionPolicy(t *testing.T) {
	for _, collect := range []bool{false, true} {
		f := fixture()
		f.loaded.Plans = nil
		f.loaded.Event.Family = automation.Merged
		f.loaded.CollectUnmatched = collect
		env := environment(t, f)
		env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
		want := 0
		if collect {
			want = 1
		}
		if env.GetWorkflowError() != nil || f.collected != want || f.finish.Status != "skipped" || len(f.nodes) != 0 {
			t.Fatalf("policy=%t fixture=%+v", collect, f)
		}
	}
}

func TestInterpreterDeploymentCaptureSurvivesNoMatch(t *testing.T) {
	f := fixture()
	f.loaded.Plans = nil
	f.loaded.Event.Family = automation.Deployed
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() != nil || f.collected != 1 || f.finish.Status != "skipped" {
		t.Fatalf("capture=%+v", f)
	}
}

func TestInterpreterExhaustedRetriesStopLaterNodes(t *testing.T) {
	f := fixture()
	attempts := 0
	f.node = func(input NodeInput) error {
		if input.NodeID == "release" {
			attempts++
			return errors.New("temporary database failure")
		}
		return nil
	}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() == nil || attempts != 4 || f.finish.Status != "failed" || f.finish.Code != "activity_failed" || f.nodes[len(f.nodes)-1] != "release" {
		t.Fatalf("attempts=%d fixture=%+v", attempts, f)
	}
}

// A version 2 graph runs copy generation as one node activity with its own
// bounded retry policy; a transient failure is retried, an unpaid budget is not.
func TestInterpreterRetriesGenerationWithinItsBudget(t *testing.T) {
	graph := testGraph()
	graph.SchemaVersion = 2
	graph.Nodes = append(graph.Nodes,
		automation.Node{ID: "campaign", Type: "action", Action: &automation.Action{Type: "create_campaign", Input: &automation.Reference{NodeID: "release", Output: "releaseId"}, BrandKitID: "brand", DestinationIDs: []string{"x"}}},
		automation.Node{ID: "copy", Type: "action", Action: &automation.Action{Type: "generate_copy", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, CreditLimit: 25}})
	graph.Edges[3] = automation.Edge{From: "release", To: "campaign", Branch: "next"}
	graph.Edges = append(graph.Edges, automation.Edge{From: "campaign", To: "copy", Branch: "next"}, automation.Edge{From: "copy", To: "end", Branch: "next"})
	if issues := automation.Validate(graph); len(issues) > 0 {
		t.Fatal(issues)
	}
	for _, test := range []struct {
		name     string
		failure  error
		attempts int
		status   string
	}{
		{"transient", errors.New("provider timeout"), 2, "succeeded"},
		{"insufficient credits", temporal.NewNonRetryableApplicationError("Automation configuration requires attention", PermanentError, nil), 1, "needs_attention"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := fixture()
			f.loaded.Plans = []product.AutomationPlan{{DefinitionID: "definition-1", VersionID: "version-1", Graph: graph}}
			attempts := 0
			f.node = func(input NodeInput) error {
				if input.NodeID != "copy" {
					return nil
				}
				if attempts++; attempts == 1 {
					return test.failure
				}
				return nil
			}
			env := environment(t, f)
			env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
			if attempts != test.attempts || f.finish.Status != test.status {
				t.Fatalf("attempts=%d finish=%+v nodes=%v", attempts, f.finish, f.nodes)
			}
		})
	}
}

// An AI relevance check picks the branch from the verdict its activity
// recorded; the interpreter never re-asks on replay.
func TestInterpreterBranchesOnTheRecordedAIVerdict(t *testing.T) {
	graph := testGraph()
	graph.SchemaVersion = 2
	graph.Nodes[1] = automation.Node{ID: "stable", Type: "classify", Classify: &automation.Classify{Criteria: "Customer-visible features only.", Threshold: 0.7, CreditLimit: 5}}
	if issues := automation.Validate(graph); len(issues) > 0 {
		t.Fatal(issues)
	}
	for _, worthy := range []bool{true, false} {
		f := fixture()
		f.loaded.Plans = []product.AutomationPlan{{DefinitionID: "definition-1", VersionID: "version-1", Graph: graph}}
		env := environment(t, f)
		asked := 0
		env.RegisterActivityWithOptions(func(_ context.Context, input NodeInput) (automation.Decision, error) {
			asked++
			f.nodes = append(f.nodes, input.NodeID)
			return automation.Decision{Status: "evaluated", Match: worthy, Reason: "AI verdict"}, nil
		}, activity.RegisterOptions{Name: ClassifyActivity})
		env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
		want, status := []string{"start", "stable", "release", "end"}, "succeeded"
		if !worthy {
			want, status = []string{"start", "stable", "skip"}, "skipped"
		}
		if asked != 1 || !reflect.DeepEqual(f.nodes, want) || f.finish.Status != status {
			t.Fatalf("worthy=%v asked=%d nodes=%v finish=%+v", worthy, asked, f.nodes, f.finish)
		}
	}
}

// Only a new commit starts a workflow. A redeploy or rollback is collected,
// which captures it, but selects no workflow and runs no node.
func TestInterpreterRedeploysAndRollbacksStartNoWorkflow(t *testing.T) {
	production := automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	graph := testGraph()
	graph.Family, graph.Qualification, graph.Nodes[1].Condition = automation.Deployed, production, &production
	for _, kind := range []string{"redeploy", "rollback", "new"} {
		f := fixture()
		f.kind = kind
		f.loaded.Event = automation.Event{Family: automation.Deployed, Origin: "live", Fields: map[string]automation.Value{"deployment.environment": automation.StringValue("production")}}
		f.loaded.Plans = []product.AutomationPlan{{DefinitionID: "definition-1", VersionID: "version-1", Graph: graph}}
		env := environment(t, f)
		env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
		if err := env.GetWorkflowError(); err != nil {
			t.Fatal(err)
		}
		if kind == "new" {
			if f.selected != "version-1" || len(f.nodes) == 0 || f.finish.Status != "succeeded" {
				t.Fatalf("new commit: %+v", f)
			}
			continue
		}
		if f.collected != 1 || f.selected != "" || len(f.nodes) != 0 || f.finish.Status != "skipped" || f.finish.Code != kind {
			t.Fatalf("%s started a workflow: %+v", kind, f)
		}
	}
}

// A run whose deployment a newer one superseded ends as superseded, keeping
// what it completed; the product error maps to that outcome.
func TestInterpreterSupersededCaptureEndsTheRun(t *testing.T) {
	f := fixture()
	f.node = func(input NodeInput) error {
		if input.NodeID == "release" {
			return activityError(product.ErrCaptureSuperseded)
		}
		return nil
	}
	env := environment(t, f)
	env.ExecuteWorkflow(WorkflowName, Input{OrganizationID: "org", RunID: "run"})
	if env.GetWorkflowError() == nil || f.finish.Status != "cancelled" || f.finish.Code != "superseded" || f.nodes[len(f.nodes)-1] != "release" {
		t.Fatalf("fixture=%+v", f)
	}
	var app *temporal.ApplicationError
	if !errors.As(activityError(product.ErrCaptureSuperseded), &app) || app.Type() != SupersededError || !app.NonRetryable() {
		t.Fatalf("mapped=%v", app)
	}
}
