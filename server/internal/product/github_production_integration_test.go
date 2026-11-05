package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubdeliveryrecovery"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubrecoveryscan"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

type productionReader struct {
	fakeReader
	page              githubapp.DeliveryPage
	calls             atomic.Int32
	fail              bool
	permissionMissing bool
}

func (r *productionReader) ProductionCapabilities(context.Context, int64, string) (githubapp.ProductionCapabilities, error) {
	if r.fail {
		return githubapp.ProductionCapabilities{}, errors.New("fixture unavailable")
	}
	return githubapp.ProductionCapabilities{Actions: !r.permissionMissing, Deployments: !r.permissionMissing, Events: []string{"deployment_status", "workflow_run", "workflow_job"}, SubscriptionsKnown: true}, nil
}
func (r *productionReader) Workflows(context.Context, int64, string) ([]automation.GitHubWorkflow, error) {
	return []automation.GitHubWorkflow{{ID: 301, Name: "Web image", Path: ".github/workflows/web-image.yml", State: "active"}}, nil
}
func (r *productionReader) WorkflowJobs(context.Context, int64, string, int64, int) ([]githubapp.WorkflowJob, error) {
	return []githubapp.WorkflowJob{}, nil
}
func (r *productionReader) EnrichProductionEvidence(_ context.Context, e automation.GitHubEvidence) (automation.GitHubEvidence, error) {
	e.Workflow = automation.GitHubWorkflow{ID: 301, Name: "Web image", Path: ".github/workflows/web-image.yml"}
	e.Association = "run_attempt_api"
	return e, nil
}
func (r *productionReader) Deliveries(context.Context, string) (githubapp.DeliveryPage, error) {
	if r.fail {
		return githubapp.DeliveryPage{}, errors.New("fixture rate limit")
	}
	return r.page, nil
}
func (r *productionReader) Redeliver(context.Context, string) error { r.calls.Add(1); return nil }

func productionWorkspace(t *testing.T) (*automationFixture, *AutomationDefinition, automation.ProductionPolicy, *productionReader) {
	f := newAutomationFixture(t)
	f.graph.Family = automation.Deployed
	f.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	active := f.activate(t)
	reader := &productionReader{fakeReader: f.repo.github.(fakeReader)}
	f.repo.WithGitHubApp(reader)
	p := automation.ProductionPolicy{SchemaVersion: 1, Enabled: true, InstallationID: f.installation, RepositoryID: "1001", Environments: []string{"production"}, Signal: "deployment_status", TrustedAppIDs: []int64{900}, RequireChangeReceipt: true, DefinitionID: active.ID}
	if _, err := f.repo.SaveGitHubProduction(f.ctx, f.owner, f.source.ID, SaveProductionPolicyInput{Policy: p}); err != nil {
		t.Fatal(err)
	}
	return f, active, p, reader
}
func productionDelivery(t *testing.T, f *automationFixture, deployment, status int, state, delivery string, at time.Time) AcceptGitHubEventInput {
	t.Helper()
	body, err := os.ReadFile("../releaseautomation/testdata/deployment-status.json")
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]any
	_ = json.Unmarshal(body, &p)
	p["installation"].(map[string]any)["id"] = f.installation
	p["deployment"].(map[string]any)["id"] = deployment
	s := p["deployment_status"].(map[string]any)
	s["id"], s["state"], s["created_at"] = status, state, at.Format(time.RFC3339Nano)
	body, _ = json.Marshal(p)
	return AcceptGitHubEventInput{DeliveryID: delivery, EventName: "deployment_status", Body: body}
}
func TestProductionObservationAtomicPinsAndDeduplicates(t *testing.T) {
	f, active, p, _ := productionWorkspace(t)
	input := productionDelivery(t, f, 501, 601, "success", "production-concurrent", time.Now().Add(time.Second))
	var wg sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := f.repo.AcceptGitHubEvent(f.ctx, input); failures <- err }()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	rows := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).AllX(f.ctx)
	if len(rows) != 1 || rows[0].DuplicateCount != 7 || rows[0].WorkflowVersionID == nil || *rows[0].WorkflowVersionID != *active.ActiveVersionID {
		t.Fatalf("%+v", rows)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventGitHubObservation)).CountX(f.ctx); n != 1 {
		t.Fatalf("outbox=%d", n)
	}
	// Editing the policy cannot reinterpret this already accepted observation.
	p.Environments = []string{"staging"}
	if _, err := f.repo.SaveGitHubProduction(f.ctx, f.owner, f.source.ID, SaveProductionPolicyInput{ExpectedRevision: 1, Policy: p}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := f.repo.processGitHubObservation(f.ctx, f.org, rows[0].ID); err != nil {
			t.Fatal(err)
		}
	}
	observation := f.db.Client.GitHubObservation.GetX(f.ctx, rows[0].ID)
	if observation.Status != "matched" || observation.EventID == nil {
		t.Fatalf("%+v", observation)
	}
	run := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org), releaseautomationrun.EventID(*observation.EventID)).OnlyX(f.ctx)
	loaded, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, run.ID, 0)
	if err != nil || len(loaded.Plans) != 1 || loaded.Plans[0].VersionID != *active.ActiveVersionID {
		t.Fatalf("%+v %v", loaded, err)
	}
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, run.ID, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	first, err := f.repo.AutomationNode(f.ctx, f.org, run.ID, "release", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.repo.AutomationNode(f.ctx, f.org, run.ID, "release", nil, 0)
	if err != nil || again.ReleaseID != first.ReleaseID {
		t.Fatal("partial retry duplicated release", err)
	}
	// A second success observation of the same deployment preserves evidence,
	// but policy edits do not generate a second business event.
	input = productionDelivery(t, f, 501, 602, "success", "later-status", time.Now().Add(2*time.Second))
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
		t.Fatal(err)
	}
	history, err := f.repo.GetGitHubProduction(f.ctx, f.owner, f.source.ID, "")
	if err != nil || len(history.Observations) != 2 {
		t.Fatal(history, err)
	}
	if _, err := f.repo.GetGitHubProduction(f.ctx, newTestWorkspace(t).owner, f.source.ID, ""); err == nil {
		t.Fatal("foreign tenant read")
	}
}
func TestProductionOperationsOrderingAndHistoricalSafety(t *testing.T) {
	f, _, p, _ := productionWorkspace(t)
	now := time.Now().Add(time.Second)
	for _, item := range []struct {
		deployment, status int
		state              string
		offset             time.Duration
	}{{10, 11, "failure", time.Minute}, {10, 12, "success", 0}, {20, 21, "success", 0}, {30, 31, "success", 0}} {
		input := productionDelivery(t, f, item.deployment, item.status, item.state, "ordering", now.Add(item.offset))
		if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	rows := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).AllX(f.ctx)
	for _, row := range rows {
		if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 2 {
		for _, row := range f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).AllX(f.ctx) {
			t.Logf("status=%s origin=%s decision=%+v", row.Status, row.Origin, row.Decision)
		}
		t.Fatalf("separate same-SHA operations or old-status fence failed: %d", n)
	}
	previewBefore := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org)).CountX(f.ctx)
	if _, err := f.repo.PreviewGitHubProduction(f.ctx, f.owner, f.source.ID, ProductionPreviewInput{Policy: p, ObservationID: rows[0].ID}); err != nil {
		t.Fatal(err)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org)).CountX(f.ctx); n != previewBefore {
		t.Fatal("preview wrote an outbox event")
	}
	input := productionDelivery(t, f, 40, 41, "success", "historical", now.Add(-24*time.Hour))
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
		t.Fatal(err)
	}
	row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org), githubobservation.DeliveryID("historical")).OnlyX(f.ctx)
	if row.Status != "review_only" || row.Origin != "historical" {
		t.Fatal(row)
	}
}

func TestProductionConflictingTimestampsRequireReview(t *testing.T) {
	for _, tc := range []struct {
		name         string
		otherState   string
		otherOffset  time.Duration
		failureFirst bool
		wantStatus   string
		wantRuns     int
	}{
		{"equal timestamps", "failure", 100 * time.Microsecond, false, "needs_attention", 0},
		{"failure delivered first", "failure", 100 * time.Microsecond, true, "needs_attention", 0},
		{"timestamps round to the same millisecond", "failure", 400 * time.Microsecond, false, "needs_attention", 0},
		{"matching success statuses", "success", 100 * time.Microsecond, false, "matched", 1},
		{"older failure", "failure", -time.Millisecond, false, "matched", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, _, _, _ := productionWorkspace(t)
			base := time.Now().Add(time.Second).Truncate(time.Millisecond)
			success := productionDelivery(t, f, 501, 601, "success", "tied-success", base.Add(100*time.Microsecond))
			other := productionDelivery(t, f, 501, 602, tc.otherState, "tied-other", base.Add(tc.otherOffset))
			inputs := []AcceptGitHubEventInput{success, other}
			if tc.failureFirst {
				inputs[0], inputs[1] = inputs[1], inputs[0]
			}
			for _, input := range inputs {
				if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
					t.Fatal(err)
				}
			}
			successRow := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org), githubobservation.DeliveryID(success.DeliveryID)).OnlyX(f.ctx)
			otherRow := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org), githubobservation.DeliveryID(other.DeliveryID)).OnlyX(f.ctx)
			if tc.otherOffset >= 0 && !successRow.OccurredAt.Equal(*otherRow.OccurredAt) {
				t.Fatal("fixture timestamps must share their persisted millisecond")
			}
			// Both statuses are known before the success can dispatch, regardless of
			// their receipt order. A higher status ID is not an ordering guarantee.
			for _, row := range []*ent.GitHubObservation{successRow, otherRow} {
				if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
					t.Fatal(err)
				}
			}
			successRow = f.db.Client.GitHubObservation.GetX(f.ctx, successRow.ID)
			if successRow.Status != tc.wantStatus {
				t.Fatalf("success status=%s, want %s: %+v", successRow.Status, tc.wantStatus, successRow.Decision)
			}
			if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != tc.wantRuns {
				t.Fatalf("automation runs=%d, want %d", n, tc.wantRuns)
			}
			if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != tc.wantRuns {
				t.Fatalf("dispatch intents=%d, want %d", n, tc.wantRuns)
			}
			if tc.wantRuns == 0 && (successRow.EventID != nil || !strings.Contains(successRow.Decision.Reason, "same-time")) {
				t.Fatalf("ambiguous success created an event or lacks its ordering explanation: %+v", successRow)
			}
		})
	}
}

func TestProductionRecoveryIsBoundedAndSuppressesLiveEffects(t *testing.T) {
	f, _, _, reader := productionWorkspace(t)
	now := time.Now()
	reader.page = githubapp.DeliveryPage{Deliveries: []githubapp.Delivery{{ID: 987654, GUID: "recovery-" + f.id, InstallationID: f.installation, RepositoryID: 1001, Event: "deployment_status", DeliveredAt: now, StatusCode: 500}}}
	t.Cleanup(func() {
		_, _ = f.db.Client.GitHubDeliveryRecovery.Delete().Where(githubdeliveryrecovery.InstallationID(f.installation)).Exec(f.ctx)
	})
	state, err := f.repo.InspectGitHubRecovery(f.ctx, f.owner, f.source.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !state.Gap || state.LastCompleteAt == nil || reader.calls.Load() != 1 {
		t.Fatal(state, reader.calls.Load())
	}
	if _, err := f.repo.InspectGitHubRecovery(f.ctx, f.owner, f.source.ID, true); err != nil {
		t.Fatal(err)
	}
	if reader.calls.Load() != 1 {
		t.Fatal("ignored scan backoff")
	}
	input := productionDelivery(t, f, 50, 51, "success", "recovery-"+f.id, now.Add(time.Second))
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
		t.Fatal(err)
	}
	row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).OnlyX(f.ctx)
	if row.Status != "review_only" || row.Origin != "recovery" || row.EventID != nil {
		t.Fatal(row)
	}
	if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
		t.Fatal("recovery ran marketing")
	}
	// Exhaustion is bounded even after process restart/lease expiry.
	for i := 0; i < 4; i++ {
		f.db.Client.GitHubRecoveryScan.Update().Where(githubrecoveryscan.OrganizationID(f.org)).ClearNextAttemptAt().ExecX(f.ctx)
		f.db.Client.GitHubDeliveryRecovery.Update().Where(githubdeliveryrecovery.InstallationID(f.installation)).ClearNextAttemptAt().ExecX(f.ctx)
		if _, err := f.repo.InspectGitHubRecovery(f.ctx, f.owner, f.source.ID, true); err != nil {
			t.Fatal(err)
		}
	}
	if reader.calls.Load() != 3 {
		t.Fatalf("retry bound=%d", reader.calls.Load())
	}
	reader.fail = true
	f.db.Client.GitHubRecoveryScan.Update().Where(githubrecoveryscan.OrganizationID(f.org)).ClearNextAttemptAt().ExecX(f.ctx)
	state, err = f.repo.InspectGitHubRecovery(f.ctx, f.owner, f.source.ID, false)
	if err != nil || state.Status != "failed" || !state.Gap {
		t.Fatal(state, err)
	}
}

func TestProductionIndependentTenantsAndAtomicAcceptance(t *testing.T) {
	a, _, _, _ := productionWorkspace(t)
	b, _, policy, _ := productionWorkspace(t)
	b.exec(t, `INSERT INTO workspace_github_installation (id,"organizationId","githubInstallationId","connectedByUserId") VALUES ($1,$2,$3,$4)`, "shared"+b.id, b.org, "gi"+a.id, b.owner.UserID)
	b.db.Client.SourceApp.UpdateOneID(b.source.ID).SetGithubInstallationID("gi" + a.id).ExecX(b.ctx)
	policy.InstallationID = a.installation
	policy.Environments = []string{"staging"}
	if _, err := b.repo.SaveGitHubProduction(b.ctx, b.owner, b.source.ID, SaveProductionPolicyInput{ExpectedRevision: 1, Policy: policy}); err != nil {
		t.Fatal(err)
	}
	name := "reject_observation_" + a.id
	a.exec(t, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId"='%s' THEN RAISE EXCEPTION 'fixture persistence failure'; END IF; RETURN NEW; END $$`, name, b.org))
	a.exec(t, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON github_observation FOR EACH ROW EXECUTE FUNCTION %s()`, name, name))
	t.Cleanup(func() {
		_, _ = a.db.SQL.ExecContext(a.ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON github_observation`, name))
		_, _ = a.db.SQL.ExecContext(a.ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, name))
	})
	input := productionDelivery(t, a, 71, 72, "success", "atomic-production", time.Now().Add(time.Second))
	if _, err := a.repo.AcceptGitHubEvent(a.ctx, input); err == nil {
		t.Fatal("partial tenant failure acknowledged")
	}
	if n := a.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationIDIn(a.org, b.org)).CountX(a.ctx); n != 0 {
		t.Fatal("partial observation commit", n)
	}
	if n := a.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationIDIn(a.org, b.org), outboxevent.Type(EventGitHubObservation)).CountX(a.ctx); n != 0 {
		t.Fatal("partial outbox commit", n)
	}
	a.exec(t, fmt.Sprintf(`DROP TRIGGER %s ON github_observation`, name))
	if result, err := a.repo.AcceptGitHubEvent(a.ctx, input); err != nil || result.Handled != 2 {
		t.Fatal(result, err)
	}
	for _, f := range []*automationFixture{a, b} {
		row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).OnlyX(f.ctx)
		if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
			t.Fatal(err)
		}
		row = f.db.Client.GitHubObservation.GetX(f.ctx, row.ID)
		if (row.Status == "matched") != (f == a) {
			t.Fatalf("tenant policy crossed: %+v", row)
		}
	}
	foreign := b.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(b.org)).OnlyX(b.ctx)
	if _, err := a.repo.PreviewGitHubProduction(a.ctx, a.owner, a.source.ID, ProductionPreviewInput{Policy: policy, ObservationID: foreign.ID}); err == nil {
		t.Fatal("cross-tenant preview")
	}
}

func TestProductionUnavailableEvidenceAndRevocation(t *testing.T) {
	for _, kind := range []string{"transient", "permission", "suspended"} {
		t.Run(kind, func(t *testing.T) {
			f, _, _, reader := productionWorkspace(t)
			if _, err := f.repo.AcceptGitHubEvent(f.ctx, productionDelivery(t, f, 81, 82, "success", kind, time.Now().Add(time.Second))); err != nil {
				t.Fatal(err)
			}
			row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).OnlyX(f.ctx)
			switch kind {
			case "transient":
				reader.fail = true
			case "permission":
				reader.permissionMissing = true
			case "suspended":
				f.db.Client.GitHubInstallation.UpdateOneID("gi" + f.id).SetStatus(githubinstallation.StatusSUSPENDED).ExecX(f.ctx)
			}
			err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID)
			if kind == "transient" {
				if err == nil {
					t.Fatal("transient failure swallowed")
				}
				row = f.db.Client.GitHubObservation.GetX(f.ctx, row.ID)
				if row.Status != "received" {
					t.Fatal("retry not durable", row.Status)
				}
				reader.fail = false
				if err = f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
					t.Fatal(err)
				}
				if f.db.Client.GitHubObservation.GetX(f.ctx, row.ID).Status != "matched" {
					t.Fatal("restart did not recover")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				if f.db.Client.GitHubObservation.GetX(f.ctx, row.ID).Status != "needs_attention" {
					t.Fatal("missing access hidden")
				}
				if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 0 {
					t.Fatal("revoked evidence executed")
				}
			}
		})
	}
}

func TestProductionActionsAttemptsAreDistinctAndPinned(t *testing.T) {
	for _, signal := range []string{"workflow_run", "workflow_job"} {
		t.Run(signal, func(t *testing.T) {
			f, _, policy, _ := productionWorkspace(t)
			policy.Signal = signal
			policy.RequireChangeReceipt = false
			policy.TrustedAppIDs = nil
			policy.TrustActionsOutcome = true
			policy.Workflows = []automation.GitHubWorkflow{{ID: 301, Name: "Web image", Path: ".github/workflows/web-image.yml"}}
			if signal == "workflow_job" {
				policy.JobNames = []string{"deploy"}
			}
			if _, err := f.repo.SaveGitHubProduction(f.ctx, f.owner, f.source.ID, SaveProductionPolicyInput{ExpectedRevision: 1, Policy: policy}); err != nil {
				t.Fatal(err)
			}
			for attempt := 1; attempt <= 2; attempt++ {
				body, err := os.ReadFile("../releaseautomation/testdata/" + strings.ReplaceAll(signal, "_", "-") + ".json")
				if err != nil {
					t.Fatal(err)
				}
				var payload map[string]any
				_ = json.Unmarshal(body, &payload)
				payload["installation"].(map[string]any)["id"] = f.installation
				object := payload[signal].(map[string]any)
				object["run_attempt"] = attempt
				object["updated_at"] = time.Now().Add(time.Duration(attempt) * time.Second).Format(time.RFC3339Nano)
				object["completed_at"] = object["updated_at"]
				if signal == "workflow_job" {
					object["id"] = 700 + attempt
				}
				body, _ = json.Marshal(payload)
				input := AcceptGitHubEventInput{DeliveryID: fmt.Sprintf("attempt-%d", attempt), EventName: signal, Body: body}
				if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
					t.Fatal(err)
				}
			}
			rows := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).AllX(f.ctx)
			for _, row := range rows {
				if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
					t.Fatal(err)
				}
			}
			if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 2 {
				t.Fatal("same-SHA reruns merged", n)
			}
		})
	}
}

func TestProductionRecoveryOutsideRetentionShowsGap(t *testing.T) {
	f, _, _, reader := productionWorkspace(t)
	reader.page = githubapp.DeliveryPage{Deliveries: []githubapp.Delivery{{ID: 987655, GUID: "expired-" + f.id, InstallationID: f.installation, RepositoryID: 1001, Event: "deployment_status", DeliveredAt: time.Now().Add(-96 * time.Hour), StatusCode: 500}}}
	t.Cleanup(func() {
		_, _ = f.db.Client.GitHubDeliveryRecovery.Delete().Where(githubdeliveryrecovery.InstallationID(f.installation)).Exec(f.ctx)
	})
	state, err := f.repo.InspectGitHubRecovery(f.ctx, f.owner, f.source.ID, true)
	if err != nil || !state.Gap || reader.calls.Load() != 0 || len(state.Deliveries) != 1 || state.Deliveries[0].Status != "history_gap" {
		t.Fatal(state, err)
	}
}

func TestProductionPolicySignalChangeDoesNotDoubleDispatchRun(t *testing.T) {
	f, _, policy, _ := productionWorkspace(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, productionDelivery(t, f, 501, 601, "success", "deployment", time.Now().Add(time.Second))); err != nil {
		t.Fatal(err)
	}
	row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).OnlyX(f.ctx)
	if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
		t.Fatal(err)
	}
	policy.Signal = "workflow_run"
	policy.RequireChangeReceipt = false
	policy.TrustedAppIDs = nil
	policy.TrustActionsOutcome = true
	policy.Workflows = []automation.GitHubWorkflow{{ID: 301, Name: "Web image", Path: ".github/workflows/web-image.yml"}}
	if _, err := f.repo.SaveGitHubProduction(f.ctx, f.owner, f.source.ID, SaveProductionPolicyInput{ExpectedRevision: 1, Policy: policy}); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("../releaseautomation/testdata/workflow-run.json")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	payload["installation"].(map[string]any)["id"] = f.installation
	payload["workflow_run"].(map[string]any)["updated_at"] = time.Now().Add(2 * time.Second).Format(time.RFC3339Nano)
	body, _ = json.Marshal(payload)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "overlapping-run", EventName: "workflow_run", Body: body}); err != nil {
		t.Fatal(err)
	}
	row = f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org), githubobservation.DeliveryID("overlapping-run")).OnlyX(f.ctx)
	if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
		t.Fatal(err)
	}
	if f.db.Client.GitHubObservation.GetX(f.ctx, row.ID).Status != "needs_attention" {
		t.Fatal("overlap was silently merged or dispatched")
	}
	if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 1 {
		t.Fatal("overlap duplicated workflow", n)
	}
}

func TestProductionLateFirstReceiptCannotReplayOldLivePolicy(t *testing.T) {
	f, _, policy, _ := productionWorkspace(t)
	f.exec(t, `UPDATE github_production_policy SET "createdAt"=now()-interval '2 hours' WHERE "organizationId"=$1`, f.org)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, productionDelivery(t, f, 91, 92, "success", "delayed-first-receipt", time.Now().Add(-time.Hour))); err != nil {
		t.Fatal(err)
	}
	row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org)).OnlyX(f.ctx)
	if row.Status != "review_only" || row.EventID != nil || !strings.Contains(row.Decision.Reason, "15 minutes") {
		t.Fatal(row)
	}
	decision, err := f.repo.PreviewGitHubProduction(f.ctx, f.owner, f.source.ID, ProductionPreviewInput{Policy: policy, ObservationID: row.ID})
	if err != nil || decision.Status != "matched" {
		t.Fatal("delayed evidence was lost", decision, err)
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventGitHubObservation)).CountX(f.ctx); n != 0 {
		t.Fatal("historical automation queued", n)
	}
}

func TestProductionMigrationDoesNotRetriggerLegacyDeployment(t *testing.T) {
	f := newAutomationFixture(t)
	f.graph.Family = automation.Deployed
	f.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	active := f.activate(t)
	f.repo.WithGitHubApp(&productionReader{fakeReader: f.repo.github.(fakeReader)})
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, productionDelivery(t, f, 101, 102, "success", "legacy-deploy", time.Now())); err != nil {
		t.Fatal(err)
	}
	policy := automation.ProductionPolicy{SchemaVersion: 1, Enabled: true, InstallationID: f.installation, RepositoryID: "1001", Environments: []string{"production"}, Signal: "deployment_status", TrustedAppIDs: []int64{900}, RequireChangeReceipt: true, DefinitionID: active.ID}
	if _, err := f.repo.SaveGitHubProduction(f.ctx, f.owner, f.source.ID, SaveProductionPolicyInput{Policy: policy}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, productionDelivery(t, f, 101, 103, "success", "after-upgrade", time.Now().Add(time.Second))); err != nil {
		t.Fatal(err)
	}
	row := f.db.Client.GitHubObservation.Query().Where(githubobservation.OrganizationID(f.org), githubobservation.DeliveryID("after-upgrade")).OnlyX(f.ctx)
	if err := f.repo.processGitHubObservation(f.ctx, f.org, row.ID); err != nil {
		t.Fatal(err)
	}
	if f.db.Client.GitHubObservation.GetX(f.ctx, row.ID).Status != "duplicate" {
		t.Fatal("legacy operation requalified as new")
	}
	if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 1 {
		t.Fatal("migration activated a second run", n)
	}
}

func TestProductionHistoryRedactsLegacyURLWithoutRewritingSnapshot(t *testing.T) {
	row := &ent.ReleaseSourceEvent{Snapshot: automation.Event{URL: "https://app.example.com/?access_token=private#secret"}}
	view := automationEvent(row)
	if view.Snapshot.URL != "https://app.example.com/" || !strings.Contains(row.Snapshot.URL, "access_token") {
		t.Fatal("unsafe public projection or modified history")
	}
}
