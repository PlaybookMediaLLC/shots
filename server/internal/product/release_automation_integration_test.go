package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

type automationFixture struct {
	*testWorkspace
	source       *ent.SourceApp
	installation int64
	graph        automation.Graph
}

type automationCancelFixture struct{ AutomationDispatcher }

func (automationCancelFixture) Cancel(context.Context, string, int) error { return nil }

func TestAutomationQueuedCancellationUpdatesEventAndRun(t *testing.T) {
	f := newAutomationFixture(t)
	f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(99, "cancel-before-start")); err != nil {
		t.Fatal(err)
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	id := history[0].Run.ID
	if err := f.repo.CancelReleaseAutomationRun(f.ctx, f.owner, id); err != nil {
		t.Fatal(err)
	}
	f.repo.WithAutomationDispatcher(automationCancelFixture{})
	if err := f.repo.dispatchReleaseAutomation(f.ctx, f.org, id, true); err != nil {
		t.Fatal(err)
	}
	detail, err := f.repo.GetAutomationRun(f.ctx, f.owner, id)
	if err != nil || detail.Run.Status != "cancelled" || detail.Event.Disposition != "cancelled" {
		t.Fatalf("inconsistent cancellation: %+v %v", detail, err)
	}
}

func TestAutomationPRAndDeploymentCreateReviewableReleases(t *testing.T) {
	for _, family := range []automation.Family{automation.Merged, automation.Deployed} {
		t.Run(string(family), func(t *testing.T) {
			f := newAutomationFixture(t)
			f.graph.Family = family
			payload := map[string]any{"installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"}}
			name := "pull_request"
			if family == automation.Merged {
				f.graph.Qualification = automation.Condition{Group: "ALL", Children: []automation.Condition{{Field: "pr.base", Operator: "eq", Values: []string{"main"}}, {Field: "pr.labels", Operator: "contains", Values: []string{"release"}}, {Field: "pr.files", Operator: "glob", Values: []string{"app/billing/*"}}}}
				f.graph.Nodes[1].Condition = &automation.Condition{Field: "pr.bot", Operator: "is_false"}
				payload["action"] = "closed"
				payload["pull_request"] = map[string]any{"id": 900, "number": 90, "title": "Billing release", "body": "Simpler billing exports.", "html_url": "https://github.com/acme/app/pull/90", "merged": true, "merged_at": "2026-10-19T10:00:00Z", "base": map[string]any{"ref": "main"}, "user": map[string]any{"login": "author", "type": "User"}, "labels": []map[string]string{{"name": "release"}}}
			} else {
				name = "deployment_status"
				f.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
				f.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
				payload["deployment"] = map[string]any{"id": 901, "environment": "production", "sha": "abc123", "production_environment": true}
				payload["deployment_status"] = map[string]any{"id": 1901, "state": "success", "environment_url": "https://app.example.com", "created_at": "2026-10-19T10:00:00Z"}
			}
			active := f.activate(t)
			body, _ := json.Marshal(payload)
			input := AcceptGitHubEventInput{EventName: name, DeliveryID: "family-fixture", Body: body}
			if _, err := f.repo.AcceptGitHubEvent(f.ctx, input); err != nil {
				t.Fatal(err)
			}
			history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
			id := history[0].Run.ID
			loaded, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, id, 0)
			if err != nil {
				t.Fatal(err)
			}
			event := loaded.Event
			if family == automation.Merged {
				event, err = f.repo.EnrichReleaseAutomation(f.ctx, f.org, id, 0)
				if err != nil {
					t.Fatal(err)
				}
			}
			if decision := automation.Evaluate(f.graph.Qualification, event); decision.Status != "evaluated" || !decision.Match {
				t.Fatalf("qualification=%+v", decision)
			}
			if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, id, *active.ActiveVersionID, 0); err != nil {
				t.Fatal(err)
			}
			if _, err := f.repo.CollectAutomationChange(f.ctx, f.org, id, 0); err != nil {
				t.Fatal(err)
			}
			var output automation.Outputs
			for _, node := range []string{"release", "campaign", "review"} {
				output, err = f.repo.AutomationNode(f.ctx, f.org, id, node, nil, 0)
				if err != nil {
					t.Fatalf("%s: %v", node, err)
				}
			}
			if output.ReleaseID == "" || output.CampaignID == "" || len(output.PostIDs) != 1 {
				t.Fatalf("missing outputs: %+v", output)
			}
			if family == automation.Merged {
				change := f.db.Client.SourceChange.Query().Where(sourcechange.OrganizationID(f.org)).OnlyX(f.ctx)
				if change.ReleaseID == nil || *change.ReleaseID != output.ReleaseID {
					t.Fatal("PR lineage not attached")
				}
			} else if n := f.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(f.org)).CountX(f.ctx); n != 1 {
				t.Fatal("production capture intake was not preserved")
			}
			input.DeliveryID = "redelivery-another-id"
			again, err := f.repo.AcceptGitHubEvent(f.ctx, input)
			if err != nil || again.Duplicates != 1 {
				t.Fatalf("semantic duplicate=%+v %v", again, err)
			}
		})
	}
}

func TestAutomationLegacyDeploymentsRemainProductionOnly(t *testing.T) {
	for _, environment := range []string{"production", "staging"} {
		t.Run(environment, func(t *testing.T) {
			f := newAutomationFixture(t)
			body, err := json.Marshal(map[string]any{"installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app"},
				"deployment": map[string]any{"id": 902, "environment": environment, "sha": deployedSHA}, "deployment_status": map[string]any{"id": 1902, "state": "success", "created_at": time.Now().Format(time.RFC3339Nano)}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{EventName: "deployment_status", DeliveryID: "legacy-deployment", Body: body}); err != nil {
				t.Fatal(err)
			}
			event := f.db.Client.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(f.org)).OnlyX(f.ctx)
			if event.Mode != "legacy" {
				t.Fatalf("mode=%s", event.Mode)
			}
			if environment == "staging" {
				if event.Disposition != "skipped" || f.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(f.org)).CountX(f.ctx) != 0 {
					t.Fatal("unconfigured staging deployment was not skipped")
				}
				return
			}
			run := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.EventID(event.ID)).OnlyX(f.ctx)
			if err := f.repo.RunLegacyReleaseEvent(f.ctx, f.org, run.ID, 0); err != nil {
				t.Fatal(err)
			}
			if n := f.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(f.org), deploymentevent.Environment(environment)).CountX(f.ctx); n != 1 {
				t.Fatalf("production deployments=%d", n)
			}
		})
	}
}

func newAutomationFixture(t *testing.T) *automationFixture {
	t.Helper()
	w := newTestWorkspace(t)
	ctx := w.ctx
	subscribe(t, ctx, w.repo, w.org, "pro")
	installation := time.Now().UnixNano()
	w.exec(t, `INSERT INTO github_installation (id,"installationId","accountLogin","accountType") VALUES ($1,$2,'acme','Organization')`, "gi"+w.id, installation)
	w.exec(t, `INSERT INTO workspace_github_installation (id,"organizationId","githubInstallationId","connectedByUserId") VALUES ($1,$2,$3,$4)`, "link"+w.id, w.org, "gi"+w.id, w.owner.UserID)
	t.Cleanup(func() {
		_, _ = w.db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, w.org)
		_, _ = w.db.SQL.ExecContext(ctx, `DELETE FROM github_installation WHERE id=$1`, "gi"+w.id)
	})
	w.repo.WithGitHubApp(fakeReader{fakeGitHub: fakeGitHub{repos: map[int64][]githubapp.Repository{installation: {{ID: 1001, FullName: "acme/app", DefaultBranch: "main"}}}}, released: time.Now().UTC()})
	link, external := "link"+w.id, "1001"
	source, err := w.repo.CreateSourceApp(ctx, w.owner, CreateSourceAppInput{Name: "acme/app", Provider: "github", ExternalID: &external, GitHubConnectionID: &link, AllowedHosts: []string{"https://api.github.com"}})
	if err != nil {
		t.Fatal(err)
	}
	// This fixture models a source that existed before the production-policy migration.
	w.exec(t, `INSERT INTO github_production_policy (id,"organizationId","sourceAppId",revision,policy,"createdBy") VALUES ($1,$2,$3,0,'{"schemaVersion":0,"enabled":false}','migration')`, "legacy-"+source.ID, w.org, source.ID)
	brand, err := w.db.Client.BrandKit.Create().SetID("brand" + w.id).SetOrganizationID(w.org).SetName("Fixture brand").SetVersion(1).SetStatus("ACTIVE").SetDefinition(map[string]any{"schemaVersion": 1, "colors": map[string]any{"text": "#111111", "background": "#ffffff", "accent": "#ff0000"}, "typography": map[string]any{"headingFamily": "Inter"}}).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	channel, err := w.db.Client.ChannelConnection.Create().SetID("channel" + w.id).SetOrganizationID(w.org).SetExternalAccountID("fixture").SetSecretReference("fixture-only").SetCreatedByUserID(w.owner.UserID).Save(ctx)
	if err != nil {
		t.Fatal(err)
	}
	graph := automation.Graph{SchemaVersion: 1, Family: automation.Published, Qualification: automation.Condition{Field: "release.tag", Operator: "glob", Values: []string{"v*"}},
		Nodes: []automation.Node{{ID: "trigger", Type: "trigger"}, {ID: "condition", Type: "condition", Condition: &automation.Condition{Field: "release.prerelease", Operator: "is_false"}}, {ID: "release", Type: "action", Action: &automation.Action{Type: "create_release"}}, {ID: "campaign", Type: "action", Action: &automation.Action{Type: "create_campaign", Input: &automation.Reference{NodeID: "release", Output: "releaseId"}, BrandKitID: brand.ID, DestinationIDs: []string{channel.ID}}}, {ID: "review", Type: "action", Action: &automation.Action{Type: "submit_review", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}}}, {ID: "end", Type: "end", Outcome: "completed"}, {ID: "skip", Type: "end", Outcome: "skipped"}},
		Edges: []automation.Edge{{From: "trigger", To: "condition", Branch: "next"}, {From: "condition", To: "release", Branch: "true"}, {From: "condition", To: "skip", Branch: "false"}, {From: "release", To: "campaign", Branch: "next"}, {From: "campaign", To: "review", Branch: "next"}, {From: "review", To: "end", Branch: "next"}}}
	if err := w.repo.AdvertiseReleaseAutomationExecutor(ctx, "worker"+w.id); err != nil {
		t.Fatal(err)
	}
	return &automationFixture{testWorkspace: w, source: source, installation: installation, graph: graph}
}

func (f *automationFixture) activate(t *testing.T) *AutomationDefinition {
	t.Helper()
	draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Release", Priority: 10, Graph: f.graph, Layout: map[string]automation.Position{}})
	if err != nil {
		t.Fatal(err)
	}
	active, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision)
	if err != nil {
		t.Fatalf("activate: %v issues=%+v", err, draft.Issues)
	}
	return active
}

func (f *automationFixture) delivery(id int, delivery string) AcceptGitHubEventInput {
	body, _ := json.Marshal(map[string]any{"action": "published", "installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"}, "sender": map[string]any{"login": "author"}, "release": map[string]any{"id": id, "name": "Export improvements", "tag_name": fmt.Sprintf("v%d", id), "body": "Faster exports.", "published_at": "2026-10-19T10:00:00Z", "draft": false, "prerelease": false, "html_url": "https://github.com/acme/app/releases/tag/v1"}})
	return AcceptGitHubEventInput{DeliveryID: delivery, EventName: "release", Body: body}
}

func TestAutomationDurableAcceptancePinsVersionsAndDeduplicates(t *testing.T) {
	f := newAutomationFixture(t)
	active := f.activate(t)
	var group sync.WaitGroup
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			_, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(1, fmt.Sprintf("delivery-%d", i)))
			failures <- err
		}(i)
	}
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if err != nil || len(history) != 1 {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	if len(history[0].Event.VersionIDs) != 1 || history[0].Event.VersionIDs[0] != *active.ActiveVersionID {
		t.Fatal("acceptance did not pin version")
	}
	saved, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{ID: active.ID, SourceAppID: f.source.ID, Name: "Edited", ExpectedRevision: active.Revision, Graph: f.graph, Layout: map[string]automation.Position{}})
	if err != nil {
		t.Fatal(err)
	}
	newActive, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, saved.ID, saved.Revision)
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(1, "different-delivery-after-edit"))
	if err != nil || accepted.Duplicates != 1 {
		t.Fatalf("duplicate=%+v err=%v", accepted, err)
	}
	loaded, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, history[0].Run.ID, 0)
	if err != nil || len(loaded.Plans) != 1 || loaded.Plans[0].VersionID != *active.ActiveVersionID || loaded.Plans[0].VersionID == *newActive.ActiveVersionID {
		t.Fatalf("pinned=%+v err=%v", loaded, err)
	}
	other := newTestWorkspace(t)
	if _, err := f.repo.GetAutomationRun(f.ctx, other.owner, history[0].Run.ID); err == nil {
		t.Fatal("foreign history was exposed")
	}
	if err := f.repo.DisableReleaseAutomation(f.ctx, f.owner, newActive.ID, newActive.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, history[0].Run.ID, "trigger", nil, 0); !errors.Is(err, ErrAutomationStopped) {
		t.Fatalf("disabled run continued: %v", err)
	}
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(2, "after-disable")); err != nil {
		t.Fatal(err)
	}
	history, _ = f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if history[0].Run.Status != "skipped" || history[0].Event.Mode != "automation" {
		t.Fatalf("disabled source fell back: %+v", history[0])
	}
}

func TestAutomationActionsReuseReceiptsAndRequireHumanApproval(t *testing.T) {
	f := newAutomationFixture(t)
	active := f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(3, "action-delivery")); err != nil {
		t.Fatal(err)
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	runID := history[0].Run.ID
	if _, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, runID, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	var outputs automation.Outputs
	for _, node := range []string{"release", "campaign", "review"} {
		var err error
		outputs, err = f.repo.AutomationNode(f.ctx, f.org, runID, node, nil, 0)
		if err != nil {
			t.Fatalf("%s: %v", node, err)
		}
		again, err := f.repo.AutomationNode(f.ctx, f.org, runID, node, nil, 0)
		if err != nil || again.ReleaseID != outputs.ReleaseID || again.CampaignID != outputs.CampaignID {
			t.Fatalf("receipt %s changed: %+v %v", node, again, err)
		}
	}
	posts := f.db.Client.CampaignPost.Query().Where(campaignpost.OrganizationID(f.org), campaignpost.CampaignID(outputs.CampaignID)).AllX(f.ctx)
	releaseDetail, err := f.repo.GetRelease(f.ctx, f.owner, outputs.ReleaseID)
	if err != nil || releaseDetail.Notes == nil || *releaseDetail.Notes != "Faster exports." {
		t.Fatalf("release evidence unreadable: %+v %v", releaseDetail, err)
	}
	if len(posts) != 1 || posts[0].Status != campaignpost.StatusREADY_FOR_REVIEW {
		t.Fatalf("review posts=%+v", posts)
	}
	if _, err := f.repo.TransitionCampaignPosts(f.ctx, Actor{OrganizationID: f.org, Kind: "service"}, outputs.CampaignID, CampaignPostDecision{Decision: "approve"}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("service approved: %v", err)
	}
	events := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventCampaignPostsSubmitted)).AllX(f.ctx)
	if len(events) != 1 {
		t.Fatalf("review notifications duplicated: %d", len(events))
	}
	t.Setenv("RESEND_API_KEY", "fixture-only")
	t.Setenv("BETTER_AUTH_URL", "https://app.example.test")
	t.Setenv("PLATFORM_NOTIFICATION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	notify := notifications.New(f.db.SQL, f.db.Client)
	sends := 0
	notify.Send = func(_ context.Context, d notifications.Delivery, _ notifications.Envelope) (notifications.Outcome, error) {
		if d.EventID == events[0].ID {
			sends++
		}
		return notifications.Outcome{Status: "SUCCEEDED", Receipt: d.ID}, nil
	}
	for batch := 0; batch < 100 && sends == 0; batch++ {
		if err := notify.Process(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := notify.Process(f.ctx); err != nil {
		t.Fatal(err)
	}
	if sends != 1 {
		t.Fatalf("recipient sends: %d", sends)
	}
	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, runID, "succeeded", "", "Submitted for review.", 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, runID, "failed", "late", "Late finish.", 0); err != nil {
		t.Fatal(err)
	}
	run := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.ID(runID)).OnlyX(f.ctx)
	if run.Status != "succeeded" {
		t.Fatalf("late finish overwrote completed run: %s", run.Status)
	}
}

func TestAutomationDraftCASAndActivationValidation(t *testing.T) {
	f := newAutomationFixture(t)
	input := SaveAutomationInput{SourceAppID: f.source.ID, Name: "Incomplete", Graph: automation.Graph{SchemaVersion: 1, Family: automation.Published}, Layout: map[string]automation.Position{}}
	draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, input)
	if err != nil || len(draft.Issues) == 0 {
		t.Fatalf("incomplete draft=%+v err=%v", draft, err)
	}
	if _, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision); err == nil {
		t.Fatal("invalid graph activated")
	}
	input.ID = draft.ID
	input.ExpectedRevision = draft.Revision
	input.Graph = f.graph
	var group sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, input)
			results <- err
		}()
	}
	group.Wait()
	close(results)
	success, conflicts := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, publishing.ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("stale drafts overwrote: success=%d conflicts=%d", success, conflicts)
	}
}

func TestAutomationDraftPriorityAndActivationRace(t *testing.T) {
	f := newAutomationFixture(t)
	active := f.activate(t)
	saved, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{ID: active.ID, SourceAppID: f.source.ID, Name: "Draft priority", ExpectedRevision: active.Revision, Priority: 1, Graph: f.graph})
	if err != nil || saved.ActivePriority != 10 || saved.Priority != 1 {
		t.Fatalf("draft changed active ordering: %+v %v", saved, err)
	}
	var group sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, saved.ID, saved.Revision)
			results <- err
		}()
	}
	group.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, publishing.ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("activation race success=%d conflict=%d", success, conflict)
	}
}

func TestAutomationRecoveryFencesOldActivitiesAndRetainsReceipts(t *testing.T) {
	f := newAutomationFixture(t)
	active := f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(80, "recover")); err != nil {
		t.Fatal(err)
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	id := history[0].Run.ID
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, id, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	output, err := f.repo.AutomationNode(f.ctx, f.org, id, "release", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, id, "failed", "activity_failed", "Infrastructure failure", 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.RetryReleaseAutomationRun(f.ctx, f.owner, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, id, "campaign", nil, 0); !errors.Is(err, ErrAutomationStopped) {
		t.Fatalf("old activity continued: %v", err)
	}
	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, id, "failed", "late", "Old attempt", 0); err != nil {
		t.Fatal(err)
	}
	again, err := f.repo.AutomationNode(f.ctx, f.org, id, "release", nil, 1)
	if err != nil || again.ReleaseID != output.ReleaseID {
		t.Fatalf("receipt changed: %+v %v", again, err)
	}
	run := f.db.Client.ReleaseAutomationRun.GetX(f.ctx, id)
	if run.Status != "queued" || run.RecoveryAttempt != 1 {
		t.Fatalf("late finish changed recovery: %+v", run)
	}
	if err := f.repo.StopWatchingAutomationSource(f.ctx, f.owner, f.source.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, id, "campaign", nil, 1); !errors.Is(err, ErrAutomationStopped) {
		t.Fatalf("revoked source continued: %v", err)
	}
}

func TestAutomationAdminAndResourceBoundaries(t *testing.T) {
	f := newAutomationFixture(t)
	service := Actor{OrganizationID: f.org, Kind: "service"}
	if _, err := f.repo.SaveReleaseAutomation(f.ctx, service, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Forbidden", Graph: f.graph}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("service configured itself: %v", err)
	}
	other := newAutomationFixture(t)
	f.graph.Nodes[3].Action.BrandKitID = other.graph.Nodes[3].Action.BrandKitID
	draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Foreign brand", Graph: f.graph})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign resource activated: %v", err)
	}
}

func TestAutomationHistoricalBackfillCannotRunMarketing(t *testing.T) {
	f := newAutomationFixture(t)
	f.activate(t)
	if err := f.repo.backfillSource(f.ctx, f.org, f.source.ID); err != nil {
		t.Fatal(err)
	}
	history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if err != nil || len(history) == 0 {
		t.Fatalf("history=%d err=%v", len(history), err)
	}
	for _, item := range history {
		if item.Event.Snapshot.Origin != "historical" || item.Run.Status != "skipped" {
			t.Fatalf("backfill executed: %+v", item)
		}
		if item.Event.Snapshot.Family == automation.Published && item.Run.Outputs.ReleaseID == "" {
			t.Fatal("imported release lineage missing")
		}
	}
	if n := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(EventReleaseAutomationDispatch)).CountX(f.ctx); n != 0 {
		t.Fatalf("historical dispatches=%d", n)
	}
	result, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(2, "historical-redelivery"))
	if err != nil || result.Duplicates != 1 {
		t.Fatalf("historical redelivery=%+v %v", result, err)
	}
}

func TestAutomationLateChangesUseEvidenceAndOccurrenceTime(t *testing.T) {
	f := newAutomationFixture(t)
	f.activate(t)
	cutoff := time.Now().UTC()
	repoID, repoName := "1001", "acme/app"
	actor := Actor{OrganizationID: f.org, Kind: "service", Display: "release-automation"}
	input := IngestSourceReleaseInput{SourceAppID: f.source.ID, EventID: "release:1001:late", Title: "Release before PR delivery", BenefitStatement: "Faster exports", RepositoryID: &repoID, RepositoryName: &repoName, automationAssociation: &sourceReleaseAssociation{Numbers: []int{42, 44}, Cutoff: cutoff}}
	created, err := f.repo.IngestSourceRelease(f.ctx, actor, input)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		number   int
		merged   time.Time
		attached bool
	}{{42, cutoff.Add(-time.Hour), true}, {43, cutoff.Add(-time.Hour), false}, {44, cutoff.Add(time.Hour), false}} {
		change, err := f.repo.CollectSourceChange(f.ctx, Actor{OrganizationID: f.org, Kind: "webhook"}, CollectSourceChangeInput{SourceAppID: f.source.ID, RepositoryID: repoID, Number: test.number, Title: "feat: Faster exports", URL: fmt.Sprintf("https://github.com/acme/app/pull/%d", test.number), MergedAt: test.merged})
		if err != nil {
			t.Fatal(err)
		}
		row := f.db.Client.SourceChange.GetX(f.ctx, change.ChangeID)
		if test.attached && (row.ReleaseID == nil || *row.ReleaseID != created.ReleaseID) || !test.attached && row.ReleaseID != nil {
			t.Fatalf("PR %d incorrectly associated: %+v", test.number, row.ReleaseID)
		}
	}
}

func TestAutomationSharedInstallationFanoutIsAtomicAndScoped(t *testing.T) {
	a, b := newAutomationFixture(t), newAutomationFixture(t)
	a.activate(t)
	b.exec(t, `INSERT INTO workspace_github_installation (id,"organizationId","githubInstallationId","connectedByUserId") VALUES ($1,$2,$3,$4)`, "shared"+b.id, b.org, "gi"+a.id, b.owner.UserID)
	b.db.Client.SourceApp.UpdateOneID(b.source.ID).SetGithubInstallationID("gi" + a.id).ExecX(b.ctx)
	b.graph.Qualification.Values = []string{"nonmatching-*"}
	b.activate(t)
	// A failure in either tenant rolls back every receipt and dispatch intent.
	name := "reject_automation_" + a.id
	a.exec(t, fmt.Sprintf(`CREATE FUNCTION %s() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId"='%s' THEN RAISE EXCEPTION 'fixture tenant persistence failure'; END IF; RETURN NEW; END $$`, name, b.org))
	a.exec(t, fmt.Sprintf(`CREATE TRIGGER %s BEFORE INSERT ON release_source_event FOR EACH ROW EXECUTE FUNCTION %s()`, name, name))
	t.Cleanup(func() {
		_, _ = a.db.SQL.ExecContext(a.ctx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON release_source_event`, name))
		_, _ = a.db.SQL.ExecContext(a.ctx, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, name))
	})
	if _, err := a.repo.AcceptGitHubEvent(a.ctx, a.delivery(7, "failed-fanout")); err == nil {
		t.Fatal("fixture failure ignored")
	}
	if n := a.db.Client.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationIDIn(a.org, b.org)).CountX(a.ctx); n != 0 {
		t.Fatalf("partial fanout committed %d receipts", n)
	}
	a.exec(t, fmt.Sprintf(`DROP TRIGGER %s ON release_source_event`, name))
	a.exec(t, fmt.Sprintf(`DROP FUNCTION %s()`, name))
	accepted, err := a.repo.AcceptGitHubEvent(a.ctx, a.delivery(7, "recovered-fanout"))
	if err != nil || accepted.Handled != 2 {
		t.Fatalf("fanout=%+v err=%v", accepted, err)
	}
	for _, f := range []*automationFixture{a, b} {
		history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
		loaded, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, history[0].Run.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		decision := automation.Evaluate(loaded.Plans[0].Graph.Qualification, loaded.Event)
		if decision.Match != (f == a) {
			t.Fatalf("workspace rules crossed: %s %+v", f.org, decision)
		}
	}
	if err := a.repo.UnlinkGitHubInstallation(a.ctx, a.owner, "link"+a.id); err != nil {
		t.Fatal(err)
	}
	accepted, err = a.repo.AcceptGitHubEvent(a.ctx, a.delivery(8, "after-one-disconnect"))
	if err != nil || accepted.Handled != 1 {
		t.Fatalf("shared disconnect affected other tenant: %+v %v", accepted, err)
	}
}

func TestAutomationReviewNotificationUnknownDoesNotResend(t *testing.T) {
	w := newTestWorkspace(t)
	t.Setenv("RESEND_API_KEY", "fixture-only")
	t.Setenv("BETTER_AUTH_URL", "https://app.example.test")
	t.Setenv("PLATFORM_NOTIFICATION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	notify := notifications.New(w.db.SQL, w.db.Client)
	campaign, err := w.repo.CreateCampaign(w.ctx, w.owner, CreateCampaignInput{Name: "Review", Objective: "Adoption", Posts: []CampaignPostInput{{Channel: "x", Copy: "One"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.TransitionCampaignPosts(w.ctx, Actor{OrganizationID: w.org, Kind: "service"}, campaign.ID, CampaignPostDecision{Decision: "submit", IdempotencyKey: "fixture-review"}); err != nil {
		t.Fatal(err)
	}
	event := w.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(w.org), outboxevent.Type(EventCampaignPostsSubmitted)).OnlyX(w.ctx)
	sends := 0
	notify.Send = func(_ context.Context, d notifications.Delivery, _ notifications.Envelope) (notifications.Outcome, error) {
		if d.EventID == event.ID {
			sends++
			return notifications.Outcome{Status: "UNCERTAIN", Code: "ACKNOWLEDGEMENT_LOST"}, nil
		}
		return notifications.Outcome{Status: "SUCCEEDED", Receipt: d.ID}, nil
	}
	for batch := 0; batch < 100 && sends == 0; batch++ {
		if err := notify.Process(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := notify.Process(w.ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := w.db.SQL.QueryRow(`SELECT status FROM platform_notification_delivery WHERE event_id=$1 AND channel='email'`, event.ID).Scan(&status); err != nil || status != "UNCERTAIN" || sends != 1 {
		t.Fatalf("uncertain delivery: status=%s sends=%d err=%v", status, sends, err)
	}
}
