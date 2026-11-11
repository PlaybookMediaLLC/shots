package product

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandprofile"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationnode"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/lucsky/cuid"
)

// scriptedCopyModel answers every requested post and records what it was sent.
type scriptedCopyModel struct {
	calls   int
	prompts []string
	systems []string
}

func (m *scriptedCopyModel) Structured(_ context.Context, request platformai.Request, out any) (platformai.Usage, error) {
	m.calls++
	m.prompts, m.systems = append(m.prompts, request.Prompt), append(m.systems, request.System)
	posts := []map[string]string{}
	for _, line := range strings.Split(request.Prompt, "\n") {
		if id, ok := strings.CutPrefix(line, "- postId "); ok {
			posts = append(posts, map[string]string{"postId": strings.SplitN(id, ":", 2)[0], "copy": "Exports now finish faster. Try them today."})
		}
	}
	body, _ := json.Marshal(map[string]any{"posts": posts})
	return platformai.Usage{CostUSD: 0.042, InputTokens: 900, OutputTokens: 80}, json.Unmarshal(body, out)
}

// generationFixture runs release → campaign → generate_copy → review on v2.
func generationFixture(t *testing.T) (*automationFixture, *scriptedCopyModel, *recordingMonthlyMeter) {
	t.Helper()
	f := newAutomationFixture(t)
	f.graph.SchemaVersion = 2
	f.graph.Nodes = append(f.graph.Nodes, automation.Node{ID: "copy", Type: "action", Action: &automation.Action{Type: "generate_copy", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, CreditLimit: 25}})
	f.graph.Nodes[4].Action.Input.NodeID = "copy"
	f.graph.Edges[4].To = "copy"
	f.graph.Edges = append(f.graph.Edges, automation.Edge{From: "copy", To: "review", Branch: "next"})
	model, meter := &scriptedCopyModel{}, &recordingMonthlyMeter{}
	f.repo.WithAutomationModel(model).WithMonthlyMeter(meter)
	return f, model, meter
}

func (f *automationFixture) runUntil(t *testing.T, active *AutomationDefinition, delivery string, release int, nodes ...string) (string, error) {
	t.Helper()
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(release, delivery)); err != nil {
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
	for _, node := range nodes {
		if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, node, nil, 0); err != nil {
			return runID, err
		}
	}
	return runID, nil
}

func TestAutomationGenerationNeedsCapableWorkerAndChargesOnce(t *testing.T) {
	f, model, meter := generationFixture(t)
	f.exec(t, `DELETE FROM release_automation_executor`)
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "base-"+f.id); err != nil {
		t.Fatal(err)
	}
	draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Generated", Priority: 1, Graph: f.graph, Layout: map[string]automation.Position{}})
	if err != nil || len(draft.Issues) > 0 {
		t.Fatalf("draft=%+v err=%v", draft, err)
	}
	if _, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("activated without an AI-capable worker: %v", err)
	}
	tagline := "Ship it, show it"
	if _, err := f.repo.UpsertBrandProfile(f.ctx, f.owner, UpsertBrandProfileInput{Audience: "Engineers", ProductDescription: "Exports",
		Tone: "Direct", Tagline: &tagline, SocialHandles: map[string]string{"x": "@shots"}}); err != nil {
		t.Fatal(err)
	}
	overview, err := f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	for _, action := range overview.Actions {
		if action.Type == "generate_copy" && (action.Available || !strings.Contains(action.Reason, "OPENROUTER_API_KEY")) {
			t.Fatalf("generation availability=%+v", action)
		}
	}
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "ai-"+f.id, f.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	active, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	runID, err := f.runUntil(t, active, "generation", 21, "release", "campaign", "copy")
	if err != nil {
		t.Fatal(err)
	}
	// A lost acknowledgement re-runs the node: the stored output and the
	// charge flag are reused, so the model and the meter see it once.
	f.exec(t, `UPDATE release_automation_node SET status='running' WHERE "runId"=$1 AND "nodeId"='copy'`, runID)
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "copy", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if model.calls != 1 || outputs.CreditsCharged != 5 {
		t.Fatalf("model calls=%d credits=%d", model.calls, outputs.CreditsCharged)
	}
	// The copy is written in the one brand voice, rendered from the merged context.
	profile, err := f.db.Client.BrandProfile.Query().Where(brandprofile.OrganizationID(f.org)).Only(f.ctx)
	if err != nil && !ent.IsNotFound(err) {
		t.Fatal(err)
	}
	if want := voicePrompt(WorkspaceVoice(profile)); !strings.Contains(model.prompts[0], want) {
		t.Fatalf("the automation prompt lacks the brand voice %q:\n%s", want, model.prompts[0])
	}
	var charged int64
	for key, used := range meter.used {
		if strings.HasPrefix(key, QuotaAICredits+":"+f.org) {
			charged += used
		}
	}
	if charged != 5 {
		t.Fatalf("meter charged %d credits", charged)
	}
	post := f.db.Client.CampaignPost.Query().Where(campaignpost.OrganizationID(f.org), campaignpost.CampaignID(outputs.CampaignID)).OnlyX(f.ctx)
	if post.Copy != "Exports now finish faster. Try them today." || post.Status != campaignpost.StatusDRAFT {
		t.Fatalf("post=%q %s", post.Copy, post.Status)
	}
	if !strings.Contains(model.prompts[0], "<source trust=\"untrusted\">") || strings.Contains(model.systems[0], "Faster exports.") {
		t.Fatal("untrusted release notes left their fence")
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "review", nil, 0); err != nil {
		t.Fatal(err)
	}
	run := f.db.Client.ReleaseAutomationRun.GetX(f.ctx, runID)
	if run.Outputs.CreditsCharged != 5 || f.db.Client.CampaignPost.GetX(f.ctx, post.ID).Status != campaignpost.StatusREADY_FOR_REVIEW {
		t.Fatalf("run outputs=%+v", run.Outputs)
	}
}

func TestAutomationGenerationRefusesWithoutCredits(t *testing.T) {
	f, model, meter := generationFixture(t)
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "ai-"+f.id, f.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	active := f.activate(t)
	// The pro allowance is spent and no credit pack was bought.
	meter.used = map[string]int64{monthlyMeterKey(QuotaAICredits, f.org, time.Now()): int64(planQuotas["pro"][QuotaAICredits]) - 10}
	runID, err := f.runUntil(t, active, "no-credits", 22, "release", "campaign", "copy")
	if !errors.Is(err, ErrQuotaExceeded) || !PermanentAutomationError(err) || model.calls != 0 {
		t.Fatalf("err=%v calls=%d", err, model.calls)
	}
	node := f.db.Client.ReleaseAutomationNode.Query().Where(releaseautomationnode.RunID(runID), releaseautomationnode.NodeID("copy")).OnlyX(f.ctx)
	if node.Status != "failed" || node.FailureCode != "insufficient_credits" || node.Charged {
		t.Fatalf("node=%+v", node)
	}
}

func TestAutomationHistoryFiltersVersionsAndNotificationsStayInTenant(t *testing.T) {
	f := newAutomationFixture(t)
	first := f.activate(t)
	firstRun, err := f.runUntil(t, first, "filter-1", 31)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{ID: first.ID, SourceAppID: f.source.ID, Name: "Release v2", Priority: 10, ExpectedRevision: first.Revision, Graph: f.graph, Layout: map[string]automation.Position{}})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, saved.ID, saved.Revision)
	if err != nil {
		t.Fatal(err)
	}
	secondRun, err := f.runUntil(t, second, "filter-2", 32)
	if err != nil {
		t.Fatal(err)
	}
	versions, err := f.repo.ListReleaseAutomationVersions(f.ctx, f.owner, first.ID)
	if err != nil || len(versions) != 2 || versions[0].ID != *second.ActiveVersionID || versions[0].Revision <= versions[1].Revision {
		t.Fatalf("versions=%+v err=%v", versions, err)
	}
	for name, test := range map[string]struct {
		filter AutomationHistoryFilter
		want   []string
	}{
		"limited":       {AutomationHistoryFilter{Limit: 1}, []string{secondRun}},
		"first version": {AutomationHistoryFilter{VersionID: *first.ActiveVersionID}, []string{firstRun}},
		"definition":    {AutomationHistoryFilter{DefinitionID: first.ID}, []string{secondRun, firstRun}},
		"family":        {AutomationHistoryFilter{Family: automation.Published, SourceAppID: f.source.ID}, []string{secondRun, firstRun}},
		"other family":  {AutomationHistoryFilter{Family: automation.Merged}, nil},
		"other source":  {AutomationHistoryFilter{SourceAppID: "missing"}, nil},
		"status":        {AutomationHistoryFilter{Status: "running"}, []string{secondRun, firstRun}},
		"before cursor": {AutomationHistoryFilter{Before: secondRun}, []string{firstRun}},
		"future window": {AutomationHistoryFilter{Since: new(time.Now().Add(time.Hour))}, nil},
	} {
		t.Run(name, func(t *testing.T) {
			items, err := f.repo.ListAutomationHistory(f.ctx, f.owner, test.filter)
			if err != nil {
				t.Fatal(err)
			}
			got := []string{}
			for _, item := range items {
				got = append(got, item.Run.ID)
			}
			if strings.Join(got, ",") != strings.Join(test.want, ",") {
				t.Fatalf("got %v want %v", got, test.want)
			}
		})
	}
	items, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{VersionID: *second.ActiveVersionID})
	if len(items) != 1 || items[0].Run.VersionRevision == nil || *items[0].Run.VersionRevision != versions[0].Revision {
		t.Fatalf("run version revision missing: %+v", items)
	}
	if _, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Status: "approved"}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown status accepted: %v", err)
	}

	for _, limit := range []int{-1, 51} {
		if _, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Limit: limit}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid limit %d accepted: %v", limit, err)
		}
	}

	other := newTestWorkspace(t)
	if _, err := f.repo.ListReleaseAutomationVersions(f.ctx, other.owner, first.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("foreign versions exposed: %v", err)
	}
	if foreign, err := f.repo.ListAutomationHistory(f.ctx, other.owner, AutomationHistoryFilter{DefinitionID: first.ID}); err != nil || len(foreign) != 0 {
		t.Fatalf("foreign runs exposed: %+v %v", foreign, err)
	}

	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, firstRun, "succeeded", "", "Done.", 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.FinishReleaseAutomation(f.ctx, f.org, secondRun, "needs_attention", "missing", "Evidence missing.", 0); err != nil {
		t.Fatal(err)
	}
	for kind, runID := range map[string]string{"activity.workflow.completed": firstRun, "activity.workflow.needs_attention": secondRun} {
		events := f.db.Client.OutboxEvent.Query().Where(outboxevent.OrganizationID(f.org), outboxevent.Type(kind)).AllX(f.ctx)
		if len(events) != 1 || events[0].AggregateID != runID || events[0].AggregateType != "release_automation_run" {
			t.Fatalf("%s events=%+v", kind, events)
		}
	}
	overview, err := f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	if overview.RunCounts["succeeded"] != 1 || overview.RunCounts["needs_attention"] != 1 || overview.Definitions[0].RecentRuns != 2 ||
		overview.Definitions[0].LastRun == nil || overview.Definitions[0].LastRun.ID != secondRun {
		t.Fatalf("counts=%+v definition=%+v", overview.RunCounts, overview.Definitions[0])
	}
	if n := f.db.Client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(f.org)).CountX(f.ctx); n != 2 {
		t.Fatalf("runs=%d", n)
	}
}

func TestAutomationSourceBranchFiltersMergedPullRequests(t *testing.T) {
	f := newAutomationFixture(t)
	f.graph.SchemaVersion, f.graph.Family = 2, automation.Merged
	f.graph.Qualification = automation.Condition{Field: "pr.number", Operator: "exists"}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "pr.bot", Operator: "is_false"}
	f.activate(t)
	member := f.actor("owner")
	member.Kind = "api_key"
	if err := f.repo.SetReleaseAutomationMode(f.ctx, member, f.source.ID, true, nil, new("release")); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("API key configured a source: %v", err)
	}
	if err := f.repo.SetReleaseAutomationMode(f.ctx, f.owner, f.source.ID, true, nil, new("bad..name")); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid branch accepted: %v", err)
	}
	if err := f.repo.SetReleaseAutomationMode(f.ctx, f.owner, f.source.ID, true, nil, new("release")); err != nil {
		t.Fatal(err)
	}
	merged := func(number int, base string) AcceptGitHubEventInput {
		body, _ := json.Marshal(map[string]any{"action": "closed", "installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"},
			"pull_request": map[string]any{"id": 5000 + number, "number": number, "title": "Branch change", "merged": true, "merged_at": "2026-10-19T10:00:00Z", "base": map[string]any{"ref": base}, "user": map[string]any{"login": "dev", "type": "User"}, "labels": []any{}}})
		return AcceptGitHubEventInput{DeliveryID: base, EventName: "pull_request", Body: body}
	}
	for _, base := range []string{"main", "release"} {
		if _, err := f.repo.AcceptGitHubEvent(f.ctx, merged(len(base), base)); err != nil {
			t.Fatal(err)
		}
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Family: automation.Merged})
	statuses := map[string]string{}
	for _, item := range history {
		statuses[item.Event.Snapshot.Fields["pr.base"].Values[0]] = item.Run.Status
	}
	if statuses["main"] != "skipped" || statuses["release"] != "queued" {
		t.Fatalf("branch filter statuses=%v", statuses)
	}
	overview, _ := f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if overview.Sources[0].Branch != "release" {
		t.Fatalf("branch not reported: %+v", overview.Sources[0])
	}
}

// scriptedJudge answers relevance checks with a fixed verdict.
type scriptedJudge struct {
	worthy     bool
	confidence float64
	calls      int
	prompts    []string
}

func (m *scriptedJudge) Structured(_ context.Context, request platformai.Request, out any) (platformai.Usage, error) {
	m.calls++
	m.prompts = append(m.prompts, request.Prompt)
	body, _ := json.Marshal(map[string]any{"marketingWorthy": m.worthy, "confidence": m.confidence, "rationale": "Customers see faster exports."})
	return platformai.Usage{CostUSD: 0.012}, json.Unmarshal(body, out)
}

func TestAutomationAIRelevanceChecksBranchOnceAndBillOnce(t *testing.T) {
	for _, test := range []struct {
		name       string
		worthy     bool
		confidence float64
		match      bool
	}{{"worthy", true, 0.91, true}, {"below threshold", true, 0.55, false}, {"not worthy", false, 0.95, false}} {
		t.Run(test.name, func(t *testing.T) {
			f := newAutomationFixture(t)
			judge, meter := &scriptedJudge{worthy: test.worthy, confidence: test.confidence}, &recordingMonthlyMeter{}
			f.repo.WithAutomationModel(judge).WithMonthlyMeter(meter)
			if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "ai-"+f.id, f.repo.AutomationCapabilities()...); err != nil {
				t.Fatal(err)
			}
			f.graph.SchemaVersion = 2
			f.graph.Nodes[1] = automation.Node{ID: "condition", Type: "classify", Classify: &automation.Classify{Criteria: "Only customer-visible product changes.", Threshold: 0.7, CreditLimit: 3}}
			active := f.activate(t)
			runID, err := f.runUntil(t, active, "relevance", 41)
			if err != nil {
				t.Fatal(err)
			}
			verdict, err := f.repo.AutomationClassify(f.ctx, f.org, runID, "condition", 0)
			if err != nil || verdict.Match != test.match || verdict.Score == nil || *verdict.Score != test.confidence {
				t.Fatalf("verdict=%+v err=%v", verdict, err)
			}
			// A lost acknowledgement re-runs the node: the stored verdict and
			// charge flag are reused.
			f.exec(t, `UPDATE release_automation_node SET status='running' WHERE "runId"=$1 AND "nodeId"='condition'`, runID)
			again, err := f.repo.AutomationClassify(f.ctx, f.org, runID, "condition", 0)
			if err != nil || again.Match != verdict.Match || judge.calls != 1 {
				t.Fatalf("again=%+v calls=%d err=%v", again, judge.calls, err)
			}
			var charged int64
			for key, used := range meter.used {
				if strings.HasPrefix(key, QuotaAICredits+":"+f.org) {
					charged += used
				}
			}
			if charged != 2 {
				t.Fatalf("charged %d credits", charged)
			}
			if !strings.Contains(judge.prompts[0], "<change trust=\"untrusted\">") || !strings.Contains(judge.prompts[0], "Only customer-visible product changes.") {
				t.Fatal("criteria or fence missing from the prompt")
			}
		})
	}
}

func TestAutomationTagPushReleasesBundleUnreleasedChanges(t *testing.T) {
	f := newAutomationFixture(t)
	f.graph.SchemaVersion, f.graph.Family = 2, automation.TagPushed
	f.graph.Qualification = automation.Condition{Field: "version.level", Operator: "in", Values: []string{"major", "minor"}}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "tag.name", Operator: "glob", Values: []string{"v*"}}
	f.graph.Nodes[2].Action.Include = "unreleased"
	if err := f.repo.SetReleaseAutomationMode(f.ctx, f.owner, f.source.ID, true, new(true), nil); err != nil {
		t.Fatal(err)
	}
	active := f.activate(t)
	merged := func(number int, at string) {
		body, _ := json.Marshal(map[string]any{"action": "closed", "installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"},
			"pull_request": map[string]any{"id": 7000 + number, "number": number, "title": "feat: change " + strconv.Itoa(number), "html_url": "https://github.com/acme/app/pull/" + strconv.Itoa(number), "merged": true, "merged_at": at, "base": map[string]any{"ref": "main"}, "user": map[string]any{"login": "dev", "type": "User"}, "labels": []any{}}})
		if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "pr-" + strconv.Itoa(number), EventName: "pull_request", Body: body}); err != nil {
			t.Fatal(err)
		}
		history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Family: automation.Merged})
		for _, item := range history {
			if item.Event.Snapshot.Number == number {
				if _, err := f.repo.CollectAutomationChange(f.ctx, f.org, item.Run.ID, 0); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	merged(11, "2026-10-19T09:00:00Z")
	merged(12, "2026-10-19T09:30:00Z")
	merged(13, "2026-10-21T09:00:00Z") // merged after the tag: belongs to the next release
	push := func(tag string) AcceptGitHubEventInput {
		body, _ := json.Marshal(map[string]any{"ref": "refs/tags/" + tag, "after": "0123456789abcdef", "created": true, "deleted": false, "installation": map[string]any{"id": f.installation},
			"repository": map[string]any{"id": 1001, "full_name": "acme/app", "html_url": "https://github.com/acme/app", "pushed_at": time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC).Unix()}, "head_commit": map[string]any{"message": "Release " + tag}})
		return AcceptGitHubEventInput{DeliveryID: tag, EventName: "push", Body: body}
	}
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, push("v2.1.0")); err != nil {
		t.Fatal(err)
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Family: automation.TagPushed})
	if len(history) != 1 || history[0].Run.Status != "queued" {
		t.Fatalf("tag history=%+v", history)
	}
	runID := history[0].Run.ID
	if _, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, runID, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "release", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	attached := f.db.Client.SourceChange.Query().Where(sourcechange.OrganizationID(f.org), sourcechange.ReleaseID(outputs.ReleaseID)).AllX(f.ctx)
	numbers := []int{}
	for _, change := range attached {
		numbers = append(numbers, change.Number)
	}
	slices.Sort(numbers)
	if !slices.Equal(numbers, []int{11, 12}) {
		t.Fatalf("release took %v", numbers)
	}
	// A legacy source records nothing for tag pushes.
	if err := f.repo.SetReleaseAutomationMode(f.ctx, f.owner, f.source.ID, false, nil, nil); err != nil {
		t.Fatal(err)
	}
	accepted, err := f.repo.AcceptGitHubEvent(f.ctx, push("v2.2.0"))
	if err != nil || accepted.Handled != 0 {
		t.Fatalf("legacy tag push=%+v %v", accepted, err)
	}
}

func TestAutomationMilestoneReleasesTakeAssignedPullRequests(t *testing.T) {
	f := newAutomationFixture(t)
	f.graph.SchemaVersion, f.graph.Family = 2, automation.MilestoneClosed
	f.graph.Qualification = automation.Condition{Field: "milestone.closed_items", Operator: "gte", Values: []string{"1"}}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "milestone.open_items", Operator: "eq", Values: []string{"0"}}
	active := f.activate(t)
	for _, number := range []int{90, 92} {
		body, _ := json.Marshal(map[string]any{"action": "closed", "installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app", "default_branch": "main"},
			"pull_request": map[string]any{"id": 8000 + number, "number": number, "title": "feat: billing", "html_url": "https://github.com/acme/app/pull/" + strconv.Itoa(number), "merged": true, "merged_at": "2026-10-19T09:00:00Z", "base": map[string]any{"ref": "main"}, "user": map[string]any{"login": "dev", "type": "User"}, "labels": []any{}}})
		if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "m-pr-" + strconv.Itoa(number), EventName: "pull_request", Body: body}); err != nil {
			t.Fatal(err)
		}
	}
	prs, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Family: automation.Merged})
	for _, item := range prs {
		if _, err := f.repo.CollectAutomationChange(f.ctx, f.org, item.Run.ID, 0); err != nil {
			t.Fatal(err)
		}
	}
	body, _ := json.Marshal(map[string]any{"action": "closed", "installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app"},
		"milestone": map[string]any{"id": 77001, "number": 4, "title": "v3.0", "description": "Billing", "open_issues": 0, "closed_issues": 2, "closed_at": "2026-10-20T00:00:00Z", "html_url": "https://github.com/acme/app/milestone/4"}})
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "milestone-4", EventName: "milestone", Body: body}); err != nil {
		t.Fatal(err)
	}
	history, _ := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Family: automation.MilestoneClosed})
	runID := history[0].Run.ID
	if _, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, runID, *active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "release", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	attached := f.db.Client.SourceChange.Query().Where(sourcechange.OrganizationID(f.org), sourcechange.ReleaseID(outputs.ReleaseID)).AllX(f.ctx)
	if len(attached) != 1 || attached[0].Number != 90 {
		t.Fatalf("milestone release took %+v (fixture milestone holds #90, #91)", attached)
	}
}

// recordingRenderer stands in for the web renderer and records requests.
type recordingRenderer struct{ requests []AutomationRenderRequest }

func (r *recordingRenderer) Render(_ context.Context, request AutomationRenderRequest) ([]AutomationRender, error) {
	r.requests = append(r.requests, request)
	renders := []AutomationRender{}
	for _, template := range request.TemplateIDs {
		renders = append(renders, AutomationRender{TemplateID: template, DesignID: "design-" + template, AssetID: "asset-" + template})
	}
	return renders, nil
}

func TestAutomationRenderCreativesUsesTheCurrentCapture(t *testing.T) {
	f := newAutomationFixture(t)
	renderer := &recordingRenderer{}
	f.repo.WithAutomationRenderer(renderer)
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "render-"+f.id, f.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	f.graph.SchemaVersion = 2
	f.graph.Nodes = append(f.graph.Nodes, automation.Node{ID: "art", Type: "action", Action: &automation.Action{Type: "render_creatives", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch", "layout-phone-duo"}}})
	f.graph.Nodes[4].Action.Input.NodeID = "art"
	f.graph.Edges[4].To = "art"
	f.graph.Edges = append(f.graph.Edges, automation.Edge{From: "art", To: "review", Branch: "next"})
	active := f.activate(t)
	runID, err := f.runUntil(t, active, "render-missing", 51, "release", "campaign")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "art", nil, 0); !errors.Is(err, ErrCaptureMissing) || !PermanentAutomationError(err) {
		t.Fatalf("rendered without a capture: %v", err)
	}
	node := f.db.Client.ReleaseAutomationNode.Query().Where(releaseautomationnode.RunID(runID), releaseautomationnode.NodeID("art")).OnlyX(f.ctx)
	if node.FailureCode != "capture_missing" || len(renderer.requests) != 0 {
		t.Fatalf("node=%+v requests=%d", node, len(renderer.requests))
	}
	surface, captureAsset := "surface"+f.id, "capture"+f.id
	f.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'App','app','https://app.example.com','[]','[]',now(),now())`, surface, f.org)
	if err := f.db.Client.Asset.Create().SetID(captureAsset).SetOrganizationID(f.org).SetObjectKey("org/" + f.org + "/capture/" + captureAsset + "/1/screen.png").SetMediaType("image/png").SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO surface_capture (id,"organizationId","surfaceId","assetId",source,"capturedAt") VALUES ($1,$2,$3,$4,'manual',now())`, "sc"+f.id, f.org, surface, captureAsset)
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "art", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	request := renderer.requests[0]
	if request.CaptureAssetID != captureAsset || request.CampaignID != outputs.CampaignID || request.OrganizationID != f.org || request.NodeID != "art" || request.Headline != "Export improvements" || request.BrandKitID == "" {
		t.Fatalf("request=%+v", request)
	}
	if !slices.Equal(outputs.DesignIDs, []string{"design-layout-browser-launch", "design-layout-phone-duo"}) || len(outputs.PostIDs) != 1 {
		t.Fatalf("outputs=%+v", outputs)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "art", nil, 0); err != nil || len(renderer.requests) != 1 {
		t.Fatalf("completed render repeated: %v %d", err, len(renderer.requests))
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "review", nil, 0); err != nil {
		t.Fatal(err)
	}
	run := f.db.Client.ReleaseAutomationRun.GetX(f.ctx, runID)
	if len(run.Outputs.RenderedAssetIDs) != 2 {
		t.Fatalf("run outputs=%+v", run.Outputs)
	}
}

// recordingCanvases stands in for the web canvas builder and records requests.
type recordingCanvases struct{ requests []AutomationCanvasRequest }

func (r *recordingCanvases) BuildCanvas(_ context.Context, request AutomationCanvasRequest) (string, error) {
	r.requests = append(r.requests, request)
	return "c" + strings.Repeat("a", 24), nil
}

func TestAutomationCreateCanvasLaysOutTheRelease(t *testing.T) {
	f := newAutomationFixture(t)
	f.graph.SchemaVersion = 2
	f.graph.Nodes = append(f.graph.Nodes, automation.Node{ID: "board", Type: "action", Action: &automation.Action{Type: "create_canvas", Input: &automation.Reference{NodeID: "campaign", Output: "campaignId"}, RecipeIDs: []string{"feature-announcement", "social-pack"}}})
	f.graph.Nodes[4].Action.Input.NodeID = "campaign"
	f.graph.Edges[4].To = "board"
	f.graph.Edges = append(f.graph.Edges, automation.Edge{From: "board", To: "review", Branch: "next"})
	if slices.Contains(requiredCapabilities(f.graph), automation.CapabilityCanvas) == false {
		t.Fatal("a canvas node does not require the canvas capability")
	}
	canvases := &recordingCanvases{}
	f.repo.WithAutomationCanvases(canvases)
	if !slices.Contains(f.repo.AutomationCapabilities(), automation.CapabilityCanvas) {
		t.Fatal("a worker with a canvas builder does not advertise it")
	}
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "canvas-"+f.id, f.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	active := f.activate(t)
	runID, err := f.runUntil(t, active, "canvas-run", 52, "release", "campaign")
	if err != nil {
		t.Fatal(err)
	}
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "board", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	request := canvases.requests[0]
	if request.OrganizationID != f.org || request.NodeID != "board" || request.RunID != runID || request.ReleaseID == "" ||
		request.CampaignID != outputs.CampaignID || !slices.Equal(request.RecipeIDs, []string{"feature-announcement", "social-pack"}) || request.CaptureAssetID != "" {
		t.Fatalf("request=%+v", request)
	}
	if outputs.CanvasID != "c"+strings.Repeat("a", 24) {
		t.Fatalf("outputs=%+v", outputs)
	}
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "board", nil, 0); err != nil || len(canvases.requests) != 1 {
		t.Fatalf("completed canvas repeated: %v %d", err, len(canvases.requests))
	}
	run := f.db.Client.ReleaseAutomationRun.GetX(f.ctx, runID)
	if run.Outputs.CanvasID != outputs.CanvasID {
		t.Fatalf("run outputs=%+v", run.Outputs)
	}
}

func TestAutomationCreateCanvasNeedsABuilder(t *testing.T) {
	f := newAutomationFixture(t)
	if _, err := f.repo.automationCreateCanvas(f.ctx, f.org, "run", "board", automation.Outputs{ReleaseID: "r"}, &automation.Action{Type: "create_canvas", RecipeIDs: []string{"social-pack"}}); !errors.Is(err, ErrAutomationCanvasesUnavailable) {
		t.Fatalf("built without a builder: %v", err)
	}
	f.repo.WithAutomationCanvases(&recordingCanvases{})
	if _, err := f.repo.automationCreateCanvas(f.ctx, f.org, "run", "board", automation.Outputs{}, &automation.Action{Type: "create_canvas", RecipeIDs: []string{"social-pack"}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("built without a release: %v", err)
	}
}

func TestAutomationArchiveRetainsHistoryAndEnforcesOwnership(t *testing.T) {
	f := newAutomationFixture(t)
	active := f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(730, "archive-queued")); err != nil {
		t.Fatal(err)
	}
	other := newTestWorkspace(t)
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, other.owner, active.ID, active.Revision, true); err == nil {
		t.Fatal("foreign archive accepted")
	}
	f.addMember(t, "member", "member")
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, f.actor("member"), active.ID, active.Revision, true); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("member archive: %v", err)
	}
	machine := f.owner
	machine.Kind = "api_key"
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, machine, active.ID, active.Revision, true); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("API key archive: %v", err)
	}
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, f.owner, active.ID, active.Revision-1, true); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("stale archive: %v", err)
	}
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, f.owner, active.ID, active.Revision, true); err != nil {
		t.Fatal(err)
	}
	definitions, err := f.repo.ListReleaseAutomations(f.ctx, f.owner)
	if err != nil || len(definitions) != 1 || !definitions[0].Archived || definitions[0].Enabled {
		t.Fatalf("archived definitions: %+v %v", definitions, err)
	}
	history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if err != nil || len(history) != 1 || !history[0].Run.CancelRequested {
		t.Fatalf("pending cancellation: %+v %v", history, err)
	}
	versions, err := f.repo.ListReleaseAutomationVersions(f.ctx, f.owner, active.ID)
	if err != nil || len(versions) != 1 {
		t.Fatalf("history lost: %+v %v", versions, err)
	}
	archived := definitions[0]
	if _, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, archived.ID, archived.Revision); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived activation: %v", err)
	}
	if _, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{ID: archived.ID, SourceAppID: f.source.ID, Name: "Stale edit", ExpectedRevision: archived.Revision, Graph: f.graph}); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("archived edit: %v", err)
	}
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, f.owner, archived.ID, archived.Revision, false); err != nil {
		t.Fatal(err)
	}
	restored, _ := f.repo.ListReleaseAutomations(f.ctx, f.owner)
	if restored[0].Archived || restored[0].Enabled {
		t.Fatal("restore activated a workflow")
	}
}

func TestAutomationHistorySeparatesLegacyAndRejectsInvalidDates(t *testing.T) {
	f := newAutomationFixture(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(731, "legacy-summary")); err != nil {
		t.Fatal(err)
	}
	f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(732, "automation-summary")); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"legacy", "automation"} {
		items, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Mode: mode})
		if err != nil || len(items) != 1 || items[0].Event.Mode != mode {
			t.Fatalf("mode %s: %+v %v", mode, items, err)
		}
	}
	overview, err := f.repo.ReleaseAutomationOverview(f.ctx, f.owner)
	if err != nil || overview.RunCounts["queued"] != 1 || overview.LegacyRunCounts["queued"] != 1 {
		t.Fatalf("summary: %+v %v", overview, err)
	}
	now, before := time.Now(), time.Now().Add(-time.Hour)
	if _, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{Since: &now, Until: &before}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("inverted range accepted: %v", err)
	}
}

func TestAutomationArchivingUnusedDraftDoesNotCancelOtherWorkflows(t *testing.T) {
	f := newAutomationFixture(t)
	f.activate(t)
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, f.delivery(733, "unrelated-queued")); err != nil {
		t.Fatal(err)
	}
	draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Unused copy", Graph: f.graph})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.repo.ArchiveReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision, true); err != nil {
		t.Fatal(err)
	}
	history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if err != nil || len(history) != 1 || history[0].Run.CancelRequested {
		t.Fatalf("unrelated run cancelled: %+v %v", history, err)
	}
}

// captureFixture runs deployment → release → campaign → capture → render.
type captureFixture struct {
	*automationFixture
	active   *AutomationDefinition
	renderer *recordingRenderer
	capturer *countingCapturer
	surface  string
	// version is what the app's version endpoint answers; empty is a 404.
	version atomic.Value
}

type countingCapturer struct {
	fakeCapturer
	calls atomic.Int32
}

func (c *countingCapturer) Capture(ctx context.Context, page string) ([]byte, error) {
	c.calls.Add(1)
	return c.fakeCapturer.Capture(ctx, page)
}

func newCaptureFixture(t *testing.T, page string, action automation.Action) *captureFixture {
	t.Helper()
	f := &captureFixture{automationFixture: newAutomationFixture(t), renderer: &recordingRenderer{}, surface: "surface" + cuid.New()[:12]}
	f.version.Store("")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/version":
			version := f.version.Load().(string)
			if version == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(`{"commit":"` + version + `"}`))
		case "/dashboard":
			http.Redirect(w, r, "/login?next=/dashboard", http.StatusFound)
		case "/login":
			_, _ = w.Write([]byte(`<form><input name="email"><input type="password" name="p"></form>`))
		default:
			_, _ = w.Write([]byte("<html>the product</html>"))
		}
	}))
	t.Cleanup(server.Close)
	f.capturer = &countingCapturer{fakeCapturer: fakeCapturer{shot: testPNG(t, 40)}}
	f.repo.WithObjectStore(&recordingAssetObjects{}).WithCapturer(f.capturer).WithAutomationRenderer(f.renderer)
	f.repo.web = routedClient(server)
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	f.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'App','app',$3,'[]','[]',now(),now())`,
		f.surface, f.org, "https://example.com:"+port+page)
	if err := f.repo.AdvertiseReleaseAutomationExecutor(f.ctx, "capture-worker"+f.id, f.repo.AutomationCapabilities()...); err != nil {
		t.Fatal(err)
	}
	f.graph.SchemaVersion, f.graph.Family = 3, automation.Deployed
	f.graph.Qualification = automation.Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	f.graph.Nodes[1].Condition = &automation.Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	action.Type, action.SurfaceID = "capture_product", f.surface
	action.Input = &automation.Reference{NodeID: "campaign", Output: "campaignId"}
	f.graph.Nodes = append(f.graph.Nodes, automation.Node{ID: "capture", Type: "action", Action: &action},
		automation.Node{ID: "art", Type: "action", Action: &automation.Action{Type: "render_creatives", Input: &automation.Reference{NodeID: "capture", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch"}}})
	f.graph.Nodes[4].Action.Input.NodeID = "art"
	f.graph.Edges[4].To = "capture"
	f.graph.Edges = append(f.graph.Edges, automation.Edge{From: "capture", To: "art", Branch: "next"}, automation.Edge{From: "art", To: "review", Branch: "next"})
	f.active = f.activate(t)
	return f
}

const deployedSHA = "abcdef1234567890abcdef1234567890abcdef12"

// deploy delivers a successful deployment and runs the workflow to its campaign.
func (f *captureFixture) deploy(t *testing.T, id int, environment string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"installation": map[string]any{"id": f.installation}, "repository": map[string]any{"id": 1001, "full_name": "acme/app"},
		"deployment":        map[string]any{"id": id, "sha": deployedSHA, "environment": environment},
		"deployment_status": map[string]any{"id": id + 1000, "state": "success", "created_at": time.Now().Format(time.RFC3339Nano)}})
	if _, err := f.repo.AcceptGitHubEvent(f.ctx, AcceptGitHubEventInput{DeliveryID: "deployment-" + strconv.Itoa(id), EventName: "deployment_status", Body: body}); err != nil {
		t.Fatal(err)
	}
	history, err := f.repo.ListAutomationHistory(f.ctx, f.owner, AutomationHistoryFilter{})
	if err != nil || len(history) == 0 {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	runID := history[0].Run.ID
	if _, err := f.repo.LoadReleaseAutomation(f.ctx, f.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := f.repo.CollectAutomationChange(f.ctx, f.org, runID, 0); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.SelectReleaseAutomation(f.ctx, f.org, runID, *f.active.ActiveVersionID, 0); err != nil {
		t.Fatal(err)
	}
	for _, node := range []string{"release", "campaign"} {
		if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, node, nil, 0); err != nil {
			t.Fatalf("%s: %v", node, err)
		}
	}
	return runID
}

func (f *captureFixture) failureCode(t *testing.T, runID, node string) string {
	t.Helper()
	return f.db.Client.ReleaseAutomationNode.Query().Where(releaseautomationnode.RunID(runID), releaseautomationnode.NodeID(node)).OnlyX(f.ctx).FailureCode
}

func TestAutomationCaptureProductProvesTheDeployment(t *testing.T) {
	f := newCaptureFixture(t, "/app", automation.Action{VersionPath: "/api/version"})
	runID := f.deploy(t, 700, "production")
	deployment := f.db.Client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(f.org)).OnlyX(f.ctx)

	// No answer proves nothing; another commit means the deployment is not live.
	// Both retry, and neither captures.
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "capture", nil, 0); !errors.Is(err, ErrDeploymentUnverified) || PermanentAutomationError(err) || f.failureCode(t, runID, "capture") != "deployment_unverified" {
		t.Fatalf("no version endpoint: %v", err)
	}
	f.version.Store("1111111111111111111111111111111111111111")
	if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "capture", nil, 0); !errors.Is(err, ErrDeploymentNotLive) || PermanentAutomationError(err) || f.failureCode(t, runID, "capture") != "waiting_for_deployment" {
		t.Fatalf("older commit live: %v", err)
	}
	if f.capturer.calls.Load() != 0 {
		t.Fatal("a page was captured without version proof")
	}

	// The legacy capture ran first and may show the old page: its receipt is
	// not this workflow's proof, though it stays in history.
	unproven, older := "unproven"+f.id, "older"+f.id
	if err := f.db.Client.Asset.Create().SetID(older).SetOrganizationID(f.org).SetObjectKey("org/" + f.org + "/capture/" + older + "/1/screen.png").SetMediaType("image/png").SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO surface_capture (id,"organizationId","surfaceId","assetId",source,"sourceId","capturedAt") VALUES ($1,$2,$3,$4,'deployment',$5,now())`, unproven, f.org, f.surface, older, deployment.ID)

	// The app reports the commit, short form included: the capture is bound to it.
	f.version.Store(deployedSHA[:12])
	outputs, err := f.repo.AutomationNode(f.ctx, f.org, runID, "capture", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	receipt := f.db.Client.SurfaceCapture.GetX(f.ctx, outputs.CaptureID)
	if outputs.CaptureProof != automation.CaptureProofVersion || outputs.CaptureAssetID != receipt.AssetID || receipt.AssetID == older || outputs.CampaignID == "" ||
		receipt.ObservedRevision == nil || *receipt.ObservedRevision != deployedSHA || *receipt.SourceID != deployment.ID || receipt.OrganizationID != f.org || f.capturer.calls.Load() != 1 {
		t.Fatalf("outputs=%+v receipt=%+v calls=%d", outputs, receipt, f.capturer.calls.Load())
	}
	if run := f.db.Client.ReleaseAutomationRun.GetX(f.ctx, runID); run.Outputs.CaptureID != outputs.CaptureID || run.Outputs.CaptureProof != automation.CaptureProofVersion {
		t.Fatalf("run outputs=%+v", run.Outputs)
	}
	// The proven image supersedes the unproven one.
	if row := f.db.Client.SurfaceCapture.GetX(f.ctx, unproven); row.SupersededAt == nil || receipt.SupersededAt != nil {
		t.Fatalf("unproven=%+v proven=%+v", row, receipt)
	}

	// A crash after the commit: a retry reuses the receipt even though a newer
	// commit is live by then, and takes no second screenshot.
	f.version.Store("2222222222222222222222222222222222222222")
	event := f.db.Client.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(f.org)).OnlyX(f.ctx)
	action := automation.FindNode(f.graph, "capture").Action
	retried, err := f.repo.automationCaptureProduct(f.ctx, f.org, event, automation.Outputs{CampaignID: outputs.CampaignID}, action)
	if err != nil || retried.CaptureID != outputs.CaptureID || f.capturer.calls.Load() != 1 {
		t.Fatalf("retried=%+v err=%v calls=%d", retried, err, f.capturer.calls.Load())
	}

	// A newer image appears before the render: the render still shows this
	// deployment's capture, not the latest.
	manual := "manual" + f.id
	if err := f.db.Client.Asset.Create().SetID(manual).SetOrganizationID(f.org).SetObjectKey("org/" + f.org + "/capture/" + manual + "/1/screen.png").SetMediaType("image/png").SetBytes(100).SetStatus(asset.StatusUPLOADED).Exec(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE surface_capture SET "supersededAt"=now() WHERE "surfaceId"=$1 AND "supersededAt" IS NULL`, f.surface)
	f.exec(t, `INSERT INTO surface_capture (id,"organizationId","surfaceId","assetId",source,"capturedAt") VALUES ($1,$2,$3,$4,'manual',now())`, manual, f.org, f.surface, manual)
	rendered, err := f.repo.AutomationNode(f.ctx, f.org, runID, "art", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.renderer.requests) != 1 || f.renderer.requests[0].CaptureAssetID != outputs.CaptureAssetID || rendered.CaptureID != outputs.CaptureID || len(rendered.DesignIDs) != 1 {
		t.Fatalf("requests=%+v rendered=%+v", f.renderer.requests, rendered)
	}
}

func TestAutomationCaptureProductLabelsCurrentStateAndRefusesWhatItCannotShow(t *testing.T) {
	t.Run("current state is labeled and claims no revision", func(t *testing.T) {
		f := newCaptureFixture(t, "/app", automation.Action{CurrentState: true})
		outputs, err := f.repo.AutomationNode(f.ctx, f.org, f.deploy(t, 710, "production"), "capture", nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		if outputs.CaptureProof != automation.CaptureProofCurrentState || f.db.Client.SurfaceCapture.GetX(f.ctx, outputs.CaptureID).ObservedRevision != nil {
			t.Fatalf("outputs=%+v", outputs)
		}
	})
	t.Run("a sign-in redirect is never recorded as the page", func(t *testing.T) {
		f := newCaptureFixture(t, "/dashboard", automation.Action{CurrentState: true})
		runID := f.deploy(t, 720, "production")
		if _, err := f.repo.AutomationNode(f.ctx, f.org, runID, "capture", nil, 0); !errors.Is(err, ErrCaptureRefused) || !PermanentAutomationError(err) || f.failureCode(t, runID, "capture") != "capture_refused" {
			t.Fatalf("sign-in page: %v", err)
		}
		if n := f.db.Client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(f.surface)).CountX(f.ctx); n != 0 || f.capturer.calls.Load() != 0 {
			t.Fatalf("captures=%d calls=%d", n, f.capturer.calls.Load())
		}
	})
	t.Run("a surface registered at its sign-in page is that page", func(t *testing.T) {
		f := newCaptureFixture(t, "/login", automation.Action{CurrentState: true})
		if _, err := f.repo.AutomationNode(f.ctx, f.org, f.deploy(t, 730, "production"), "capture", nil, 0); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("a deployment that was not recorded has nothing to bind to", func(t *testing.T) {
		f := newCaptureFixture(t, "/app", automation.Action{CurrentState: true})
		if _, err := f.repo.AutomationNode(f.ctx, f.org, f.deploy(t, 740, "staging"), "capture", nil, 0); !errors.Is(err, ErrCaptureRefused) {
			t.Fatalf("staging deployment: %v", err)
		}
	})
	t.Run("another workspace's surface cannot be activated", func(t *testing.T) {
		f := newCaptureFixture(t, "/app", automation.Action{CurrentState: true})
		other := newTestWorkspace(t)
		theirs := "theirs" + other.id
		other.exec(t, `INSERT INTO product_surface (id,"organizationId",name,slug,url,"featureTags","screenshotAssetIds","createdAt","updatedAt") VALUES ($1,$2,'Theirs','theirs','https://theirs.example.com','[]','[]',now(),now())`, theirs, other.org)
		for i := range f.graph.Nodes {
			if f.graph.Nodes[i].ID == "capture" {
				f.graph.Nodes[i].Action.SurfaceID = theirs
			}
		}
		draft, err := f.repo.SaveReleaseAutomation(f.ctx, f.owner, SaveAutomationInput{SourceAppID: f.source.ID, Name: "Theirs", Priority: 20, Graph: f.graph, Layout: map[string]automation.Position{}})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.repo.ActivateReleaseAutomation(f.ctx, f.owner, draft.ID, draft.Revision); err == nil {
			t.Fatal("activated a workflow that captures another workspace's surface")
		}
	})
}

func TestAutomationCaptureProductNeedsACapableWorker(t *testing.T) {
	f := newAutomationFixture(t)
	f.repo.WithObjectStore(&recordingAssetObjects{}).WithCapturer(fakeCapturer{})
	if !slices.Contains(f.repo.AutomationCapabilities(), automation.CapabilityCapture) {
		t.Fatal("a worker that can capture does not advertise it")
	}
	if slices.Contains(NewConfiguration(f.db.Client).AutomationCapabilities(), automation.CapabilityCapture) {
		t.Fatal("a worker that cannot capture advertised it")
	}
	if got := requiredCapabilities(automation.Graph{Nodes: []automation.Node{{Type: "action", Action: &automation.Action{Type: "capture_product"}}}}); !slices.Equal(got, []string{automation.CapabilityCapture}) {
		t.Fatalf("required=%v", got)
	}
}
