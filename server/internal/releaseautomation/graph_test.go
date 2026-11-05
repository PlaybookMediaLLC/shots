package releaseautomation

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func testGraph() Graph {
	return Graph{SchemaVersion: 1, Family: Published, Qualification: Condition{Field: "release.tag", Operator: "glob", Values: []string{"v*"}},
		Nodes: []Node{{ID: "start", Type: "trigger"}, {ID: "stable", Type: "condition", Condition: &Condition{Field: "release.prerelease", Operator: "is_false"}},
			{ID: "release", Type: "action", Action: &Action{Type: "create_release"}},
			{ID: "campaign", Type: "action", Action: &Action{Type: "create_campaign", Input: &Reference{NodeID: "release", Output: "releaseId"}, BrandKitID: "brand", DestinationIDs: []string{"channel"}}},
			{ID: "review", Type: "action", Action: &Action{Type: "submit_review", Input: &Reference{NodeID: "campaign", Output: "campaignId"}}}, {ID: "done", Type: "end", Outcome: "completed"}, {ID: "skip", Type: "end", Outcome: "skipped"}},
		Edges: []Edge{{"start", "stable", "next"}, {"stable", "release", "true"}, {"stable", "skip", "false"}, {"release", "campaign", "next"}, {"campaign", "review", "next"}, {"review", "done", "next"}}}
}

func TestPublishedReleasePreview(t *testing.T) {
	g := testGraph()
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
	e := Event{Family: Published, Fields: map[string]Value{"release.tag": StringValue("v1"), "release.prerelease": BoolValue(false)}}
	preview := DryRun(g, e)
	if preview.Outcome != "completed" || len(preview.Steps) != 6 {
		t.Fatalf("%+v", preview)
	}
	e.Fields["release.prerelease"] = BoolValue(true)
	if result := DryRun(g, e); result.Outcome != "skipped" || len(result.Steps) != 3 {
		t.Fatal(result)
	}
	delete(e.Fields, "release.prerelease")
	if result := DryRun(g, e); result.Outcome != "unresolved" {
		t.Fatal(result)
	}
	e.Family = Merged
	if DryRun(g, e).Qualification.Status != "not_applicable" {
		t.Fatal("wrong family accepted")
	}
}

func TestGraphRejectsUnsafeStructures(t *testing.T) {
	tests := []struct {
		name, code string
		change     func(*Graph)
	}{
		{"cycle", "cycle", func(g *Graph) { g.Edges[3].To = "release" }},
		{"unreachable", "unreachable", func(g *Graph) { g.Nodes = append(g.Nodes, Node{ID: "orphan", Type: "end", Outcome: "skipped"}) }},
		{"duplicate", "node_id", func(g *Graph) { g.Nodes[1].ID = "start" }},
		{"endpoint", "edge_endpoint", func(g *Graph) { g.Edges[0].To = "missing" }},
		{"branch", "condition_edges", func(g *Graph) { g.Edges[2].Branch = "true" }},
		{"cross branch", "unavailable_input", func(g *Graph) { g.Edges[2].To = "campaign"; g.Nodes = g.Nodes[:6] }},
		{"unknown action", "action", func(g *Graph) { g.Nodes[2].Action.Type = "publish" }},
		{"foreign field", "condition", func(g *Graph) { g.Nodes[1].Condition.Field = "pr.files" }},
		{"review continuation", "review_terminal", func(g *Graph) { g.Edges[5].To = "release" }},
		{"unsupported schema", "schema_version", func(g *Graph) { g.SchemaVersion = SchemaVersion + 1 }},
		{"generation in v1", "action", func(g *Graph) {
			g.Nodes[4].Action = &Action{Type: "generate_copy", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, CreditLimit: 10}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			g := testGraph()
			test.change(&g)
			issues := Validate(g)
			if !slices.ContainsFunc(issues, func(i Issue) bool { return i.Code == test.code }) {
				t.Fatalf("wanted %s: %+v", test.code, issues)
			}
		})
	}
}

func TestConditionOperators(t *testing.T) {
	for _, test := range []struct {
		operator string
		values   []string
		want     bool
	}{
		{"eq", []string{"v1.2"}, true}, {"ne", []string{"v1.2"}, false}, {"in", []string{"v1.2", "v2"}, true}, {"not_in", []string{"v2"}, true},
		{"contains", []string{"1."}, true}, {"not_contains", []string{"1."}, false}, {"starts_with", []string{"v"}, true}, {"glob", []string{"v?.[0-9]"}, true},
		{"exists", nil, true}, {"not_exists", nil, false},
	} {
		t.Run(test.operator, func(t *testing.T) {
			e := Event{Family: Published, Fields: map[string]Value{"release.tag": StringValue("v1.2")}}
			r := Evaluate(Condition{Field: "release.tag", Operator: test.operator, Values: test.values}, e)
			if r.Status != "evaluated" || r.Match != test.want {
				t.Fatal(r)
			}
		})
	}
	for _, operator := range []string{"is_true", "is_false"} {
		r := Evaluate(Condition{Field: "pr.bot", Operator: operator}, Event{Family: Merged, Fields: map[string]Value{"pr.bot": BoolValue(true)}})
		if r.Match != (operator == "is_true") {
			t.Fatal(r)
		}
	}
}

func TestGroupsCollectionsAndEnrichment(t *testing.T) {
	file := Condition{Field: "pr.files", Operator: "glob", Values: []string{"app/*"}}
	label := Condition{Field: "pr.labels", Operator: "contains", Values: []string{"release"}}
	c := Condition{Group: "ALL", Children: []Condition{file, {Group: "NOT", Children: []Condition{{Group: "ANY", Children: []Condition{label}}}}}}
	e := Event{Family: Merged, Fields: map[string]Value{"pr.files": StringValue("README.md", "app/index.ts"), "pr.labels": StringValue("release-candidate")}}
	if r := Evaluate(c, e); r.Status != "evaluated" || !r.Match {
		t.Fatal(r)
	}
	for _, state := range []string{"pending", "unavailable", "not_applicable", "missing"} {
		e.Fields["pr.files"] = Value{State: state}
		r := Evaluate(c, e)
		if r.Status != state || r.Match {
			t.Fatal(r)
		}
	}
	e.Fields["pr.files"] = StringValue()
	if r := Evaluate(file, e); r.Status != "evaluated" || r.Match {
		t.Fatal(r)
	}
	file.Operator = "ne"
	file.Values = []string{"x"}
	if !Evaluate(file, e).Match {
		t.Fatal("empty collection is universally unequal")
	}
	file.Operator = "glob"
	file.Values = []string{"**/*.ts"}
	if ValidateCondition(file, Merged) == "" {
		t.Fatal("undocumented glob accepted")
	}
	for i := 0; i < 9; i++ {
		c = Condition{Group: "NOT", Children: []Condition{c}}
	}
	if ValidateCondition(c, Merged) == "" {
		t.Fatal("unbounded condition")
	}
}

func TestNormalizeIdentityAndIgnoredEvents(t *testing.T) {
	body := []byte(`{"action":"published","installation":{"id":7},"repository":{"id":42,"full_name":"acme/app"},"release":{"id":19,"tag_name":"v1","name":"Release","body":"notes","published_at":"2026-10-19T10:00:00Z","prerelease":false}}`)
	installation, event, err := NormalizeGitHub("release", body)
	if err != nil || installation != 7 || event.SemanticKey != "release:42:19" || event.OccurredAt != time.Date(2026, 10, 19, 10, 0, 0, 0, time.UTC) {
		t.Fatalf("%+v %v", event, err)
	}
	for _, payload := range []string{`{"action":"edited"}`, `{"action":"closed","pull_request":{"merged":false}}`, `{"deployment_status":{"state":"failure"}}`} {
		for _, name := range []string{"release", "pull_request", "deployment_status"} {
			if (name == "release" && payload == `{"action":"edited"}`) || (name == "pull_request" && payload == `{"action":"closed","pull_request":{"merged":false}}`) || (name == "deployment_status" && payload == `{"deployment_status":{"state":"failure"}}`) {
				_, event, err := NormalizeGitHub(name, []byte(payload))
				if event != nil || err != nil {
					t.Fatal(name, err)
				}
			}
		}
	}
	if _, _, err := NormalizeGitHub("release", []byte(`{"action":"published"}`)); err == nil {
		t.Fatal("malformed supported event accepted")
	}
	if _, e, err := NormalizeGitHub("issues", []byte(`not json`)); e != nil || err != nil {
		t.Fatal("unsupported event parsed")
	}
	if _, _, err := NormalizeGitHub("push", []byte(`not json`)); err == nil {
		t.Fatal("malformed supported push accepted")
	}
}

func TestIncompleteDraftsStillHaveHardBounds(t *testing.T) {
	g := Graph{SchemaVersion: 1, Family: Published}
	if !BoundedDraft(g) || len(Validate(g)) == 0 {
		t.Fatal("incomplete bounded drafts must save but not activate")
	}
	for i := 0; i < 8; i++ {
		g.Qualification = Condition{Group: "NOT", Children: []Condition{g.Qualification}}
	}
	if BoundedDraft(g) {
		t.Fatal("deep draft accepted")
	}
	g = testGraph()
	g.Nodes[1].Condition = &Condition{Group: "ALL", Children: make([]Condition, 33)}
	if BoundedDraft(g) {
		t.Fatal("wide draft accepted")
	}
}

func TestNormalizeMergedPRAndDeploymentEvidence(t *testing.T) {
	pr := []byte(`{"action":"closed","installation":{"id":7},"repository":{"id":42,"full_name":"acme/app"},"pull_request":{"id":1234,"number":17,"title":"Export release","body":"Notes","merged":true,"merged_at":"2026-10-19T10:00:00Z","base":{"ref":"main"},"user":{"login":"robot[bot]","type":"Bot"},"labels":[{"name":"release"}]}}`)
	_, event, err := NormalizeGitHub("pull_request", pr)
	if err != nil || event.SemanticKey != "pr:42:17" || event.ObjectID != "1234" || event.Fields["pr.files"].State != "pending" || !*event.Fields["pr.bot"].Boolean || event.Fields["pr.labels"].Values[0] != "release" {
		t.Fatalf("PR=%+v err=%v", event, err)
	}
	deployment := []byte(`{"installation":{"id":7},"repository":{"id":42,"full_name":"acme/app"},"deployment":{"id":99,"environment":"staging","sha":"abc123","production_environment":true},"deployment_status":{"state":"success","environment":"production","created_at":"2026-10-19T10:00:00Z","environment_url":"https://example.com"}}`)
	_, event, err = NormalizeGitHub("deployment_status", deployment)
	if err != nil || event.SemanticKey != "deployment:42:99:success" || event.Fields["deployment.environment"].Values[0] != "production" || event.Fields["deployment.sha"].Values[0] != "abc123" {
		t.Fatalf("deployment=%+v err=%v", event, err)
	}
}

// generationGraph inserts paid copy generation between drafting and review.
func generationGraph() Graph {
	g := testGraph()
	g.SchemaVersion = 2
	g.Nodes = append(g.Nodes, Node{ID: "copy", Type: "action", Action: &Action{Type: "generate_copy", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, CreditLimit: 40}})
	g.Nodes[4].Action.Input.NodeID = "copy"
	g.Edges[4].To = "copy"
	g.Edges = append(g.Edges, Edge{"copy", "review", "next"})
	return g
}

func TestGenerationRequiresVersionTwoAndBudget(t *testing.T) {
	g := generationGraph()
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
	e := Event{Family: Published, Fields: map[string]Value{"release.tag": StringValue("v1"), "release.prerelease": BoolValue(false)}}
	preview := DryRun(g, e)
	if preview.Outcome != "completed" || len(preview.Steps) != 7 || preview.Steps[4].Action != "generate_copy" {
		t.Fatalf("%+v", preview)
	}
	for name, test := range map[string]struct {
		code   string
		change func(*Graph)
	}{
		"no budget":        {"action", func(g *Graph) { g.Nodes[7].Action.CreditLimit = 0 }},
		"over budget":      {"action", func(g *Graph) { g.Nodes[7].Action.CreditLimit = MaxCreditLimit + 1 }},
		"release input":    {"action", func(g *Graph) { g.Nodes[7].Action.Input = &Reference{NodeID: "release", Output: "releaseId"} }},
		"own destination":  {"action", func(g *Graph) { g.Nodes[7].Action.DestinationIDs = []string{"channel"} }},
		"budget elsewhere": {"action", func(g *Graph) { g.Nodes[2].Action.CreditLimit = 5 }},
		"too many": {"generation_limit", func(g *Graph) {
			for _, id := range []string{"copy2", "copy3"} {
				previous := g.Edges[len(g.Edges)-1]
				g.Nodes = append(g.Nodes, Node{ID: id, Type: "action", Action: &Action{Type: "generate_copy", Input: &Reference{NodeID: previous.From, Output: "campaignId"}, CreditLimit: 1}})
				g.Edges[len(g.Edges)-1].To = id
				g.Edges = append(g.Edges, Edge{id, "review", "next"})
				g.Nodes[4].Action.Input.NodeID = id
			}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			g := generationGraph()
			test.change(&g)
			if issues := Validate(g); !slices.ContainsFunc(issues, func(i Issue) bool { return i.Code == test.code }) {
				t.Fatalf("wanted %s: %+v", test.code, issues)
			}
		})
	}
}

func TestNormalizedPullRequestExposesNumberAndRepository(t *testing.T) {
	body := []byte(`{"action":"closed","installation":{"id":7},"repository":{"id":9,"full_name":"acme/app","default_branch":"main"},
		"pull_request":{"id":3,"number":42,"title":"Faster exports","merged":true,"merged_at":"2026-10-19T10:00:00Z","base":{"ref":"main"},"user":{"login":"dev","type":"User"},"labels":[]}}`)
	_, event, err := NormalizeGitHub("pull_request", body)
	if err != nil || event == nil {
		t.Fatal(err)
	}
	if got := event.Fields["pr.number"].Values; len(got) != 1 || got[0] != "42" {
		t.Fatal(got)
	}
	if got := event.Fields["repository.name"].Values; len(got) != 1 || got[0] != "acme/app" {
		t.Fatal(got)
	}
	if Evaluate(Condition{Field: "pr.number", Operator: "in", Values: []string{"41", "42"}}, *event).Match != true {
		t.Fatal("pr.number was not evaluated")
	}
}

// The web's workflow templates are generated into this shared fixture
// (test/workflow-contracts.test.ts); each must be executable as written.
func TestWorkflowTemplatesFixtureValidates(t *testing.T) {
	body, err := os.ReadFile("testdata/workflow-templates.json")
	if err != nil {
		t.Fatal(err)
	}
	templates := map[string]Graph{}
	if err := json.Unmarshal(body, &templates); err != nil {
		t.Fatal(err)
	}
	if len(templates) != 11 {
		t.Fatalf("templates=%d", len(templates))
	}
	for name, graph := range templates {
		if issues := Validate(graph); len(issues) > 0 {
			t.Errorf("%s: %+v", name, issues)
		}
	}
}

func TestTagPushesAndMilestonesDefineReleases(t *testing.T) {
	repo := `"installation":{"id":7},"repository":{"id":42,"full_name":"acme/app","html_url":"https://github.com/acme/app","pushed_at":1792491352},"sender":{"login":"dev"}`
	_, event, err := NormalizeGitHub("push", []byte(`{"ref":"refs/tags/v2.3.0","after":"0123456789abcdef","created":true,"deleted":false,"head_commit":{"message":"Ship billing exports (#12)","timestamp":"2026-10-19T10:00:00Z"},`+repo+`}`))
	if err != nil || event == nil || event.Family != TagPushed || event.SemanticKey != "tag:42:v2.3.0" || event.Title != "v2.3.0" {
		t.Fatalf("%+v %v", event, err)
	}
	if event.OccurredAt.Unix() != 1792491352 || event.URL != "https://github.com/acme/app/releases/tag/v2.3.0" {
		t.Fatalf("time=%s url=%s", event.OccurredAt, event.URL)
	}
	if got := event.Fields["version.level"].Values; len(got) != 1 || got[0] != "minor" {
		t.Fatalf("level=%v", got)
	}
	for _, ignored := range []string{
		`{"ref":"refs/heads/main","after":"0123456789abcdef","created":false,"deleted":false,` + repo + `}`,
		`{"ref":"refs/tags/v2.3.0","after":"0000000000000000","created":false,"deleted":true,` + repo + `}`,
		`{"ref":"refs/tags/v2.3.0","after":"0123456789abcdef","created":false,"deleted":false,` + repo + `}`,
	} {
		if _, e, err := NormalizeGitHub("push", []byte(ignored)); e != nil || err != nil {
			t.Fatalf("non-release push triggered: %s %v", ignored, err)
		}
	}
	_, milestone, err := NormalizeGitHub("milestone", []byte(`{"action":"closed","milestone":{"id":900,"number":3,"title":"v3","description":"Billing","open_issues":0,"closed_issues":12,"closed_at":"2026-10-19T10:00:00Z","html_url":"https://github.com/acme/app/milestone/3"},`+repo+`}`))
	if err != nil || milestone.Family != MilestoneClosed || milestone.Number != 3 || milestone.SemanticKey != "milestone:42:900" {
		t.Fatalf("%+v %v", milestone, err)
	}
	if !Evaluate(Condition{Field: "milestone.closed_items", Operator: "gte", Values: []string{"10"}}, *milestone).Match {
		t.Fatal("closed items comparison failed")
	}
	if Evaluate(Condition{Field: "version.level", Operator: "eq", Values: []string{"major"}}, *milestone).Match != true {
		t.Fatal("v3 is a major version")
	}
	if _, e, err := NormalizeGitHub("milestone", []byte(`{"action":"opened"}`)); e != nil || err != nil {
		t.Fatal("open milestone triggered")
	}
}

func TestVersionSemantics(t *testing.T) {
	for name, want := range map[string]string{"v1": "major", "2.0.0": "major", "v2.4": "minor", "v2.4.1": "patch", "v3.0.0-rc.1": "prerelease", "1.2.3+build.7": "patch"} {
		if got := versionFields(name)["version.level"]; got.State != "available" || got.Values[0] != want {
			t.Errorf("%s: %+v", name, got)
		}
	}
	for _, name := range []string{"release-2026", "latest", "v1.2.3.4"} {
		if got := versionFields(name)["version.level"]; got.State != "not_applicable" {
			t.Errorf("%s parsed as a version: %+v", name, got)
		}
	}
	e := Event{Family: TagPushed, Fields: versionFields("latest")}
	if decision := Evaluate(Condition{Field: "version.level", Operator: "in", Values: []string{"major", "minor"}}, e); decision.Status != "not_applicable" {
		t.Fatalf("non-version decided a branch: %+v", decision)
	}
}

func TestNumericOperatorsAndPullRequestSize(t *testing.T) {
	body := []byte(`{"action":"closed","installation":{"id":7},"repository":{"id":9,"full_name":"acme/app"},
		"pull_request":{"id":3,"number":42,"title":"feat: exports","merged":true,"merged_at":"2026-10-19T10:00:00Z","base":{"ref":"main"},"head":{"ref":"release/2.4"},"additions":420,"deletions":12,"changed_files":9,"commits":3,"user":{"login":"dev","type":"User"},"labels":[]}}`)
	_, e, err := NormalizeGitHub("pull_request", body)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		condition Condition
		want      bool
	}{
		{Condition{Field: "pr.additions", Operator: "gt", Values: []string{"200"}}, true},
		{Condition{Field: "pr.additions", Operator: "lte", Values: []string{"420.0"}}, true},
		{Condition{Field: "pr.changed_files", Operator: "lt", Values: []string{"5"}}, false},
		{Condition{Field: "pr.commits", Operator: "in", Values: []string{"1", "3"}}, true},
		{Condition{Field: "pr.head", Operator: "glob", Values: []string{"release/*"}}, true},
	} {
		if got := Evaluate(test.condition, *e); got.Status != "evaluated" || got.Match != test.want {
			t.Errorf("%+v: %+v", test.condition, got)
		}
	}
	for _, invalid := range []Condition{
		{Field: "pr.additions", Operator: "gt", Values: []string{"many"}},
		{Field: "pr.title", Operator: "gt", Values: []string{"1"}},
		{Field: "pr.additions", Operator: "contains", Values: []string{"1"}},
	} {
		if ValidateCondition(invalid, Merged) == "" {
			t.Errorf("invalid %+v accepted", invalid)
		}
	}
	g := testGraph()
	g.Family = Merged
	g.Qualification = Condition{Field: "pr.additions", Operator: "gt", Values: []string{"10"}}
	g.Nodes[1].Condition = &Condition{Field: "pr.bot", Operator: "is_false"}
	if !slices.ContainsFunc(Validate(g), func(i Issue) bool { return i.Code == "schema_version" }) {
		t.Fatal("v1 graph used a v2 operator")
	}
	g.SchemaVersion = 2
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
}

func TestClassifyNodesBranchOnAnAIVerdict(t *testing.T) {
	g := testGraph()
	g.SchemaVersion = 2
	g.Nodes[1] = Node{ID: "stable", Type: "classify", Classify: &Classify{Criteria: "Customer-visible features only.", Threshold: 0.7, CreditLimit: 5}}
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
	e := Event{Family: Published, Fields: map[string]Value{"release.tag": StringValue("v1")}}
	if p := DryRunAssuming(g, e, true); p.Outcome != "completed" || p.Steps[1].Decision.Status != "assumed" {
		t.Fatalf("%+v", p)
	}
	if p := DryRunAssuming(g, e, false); p.Outcome != "skipped" {
		t.Fatalf("%+v", p)
	}
	for name, change := range map[string]func(*Graph){
		"v1":           func(g *Graph) { g.SchemaVersion = 1 },
		"no criteria":  func(g *Graph) { g.Nodes[1].Classify.Criteria = "" },
		"low bar":      func(g *Graph) { g.Nodes[1].Classify.Threshold = 0.2 },
		"over budget":  func(g *Graph) { g.Nodes[1].Classify.CreditLimit = MaxClassifyCredits + 1 },
		"one branch":   func(g *Graph) { g.Edges = slices.Delete(g.Edges, 2, 3) },
		"misplaced":    func(g *Graph) { g.Nodes[2].Classify = &Classify{} },
		"render in v1": func(g *Graph) { g.SchemaVersion = 1; g.Nodes[1] = testGraph().Nodes[1] },
	} {
		t.Run(name, func(t *testing.T) {
			g := testGraph()
			g.SchemaVersion = 2
			g.Nodes[1] = Node{ID: "stable", Type: "classify", Classify: &Classify{Criteria: "Customer-visible features only.", Threshold: 0.7, CreditLimit: 5}}
			if name == "render in v1" {
				g.Nodes = append(g.Nodes, Node{ID: "art", Type: "action", Action: &Action{Type: "render_creatives", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch"}}})
				g.Edges[4].To = "art"
				g.Edges = append(g.Edges, Edge{"art", "review", "next"})
				g.Nodes[4].Action.Input.NodeID = "art"
			}
			change(&g)
			if len(Validate(g)) == 0 {
				t.Fatal("invalid AI check accepted")
			}
		})
	}
}

func TestRenderCreativesAndReleaseContents(t *testing.T) {
	g := testGraph()
	g.SchemaVersion = 2
	g.Nodes[2].Action.Include = "unreleased"
	g.Nodes = append(g.Nodes, Node{ID: "art", Type: "action", Action: &Action{Type: "render_creatives", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch", "layout-phone-duo"}}})
	g.Edges[4].To = "art"
	g.Edges = append(g.Edges, Edge{"art", "review", "next"})
	g.Nodes[4].Action.Input.NodeID = "art"
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
	for name, change := range map[string]func(*Graph){
		"bad include":    func(g *Graph) { g.Nodes[2].Action.Include = "everything" },
		"include in v1":  func(g *Graph) { g.SchemaVersion = 1 },
		"no templates":   func(g *Graph) { g.Nodes[7].Action.TemplateIDs = nil },
		"many templates": func(g *Graph) { g.Nodes[7].Action.TemplateIDs = []string{"a", "b", "c", "d"} },
		"bad template":   func(g *Graph) { g.Nodes[7].Action.TemplateIDs = []string{"../../etc"} },
		"misplaced":      func(g *Graph) { g.Nodes[3].Action.TemplateIDs = []string{"layout-browser-launch"} },
	} {
		t.Run(name, func(t *testing.T) {
			copy := g
			copy.Nodes = slices.Clone(g.Nodes)
			for i := range copy.Nodes {
				if copy.Nodes[i].Action != nil {
					action := *copy.Nodes[i].Action
					copy.Nodes[i].Action = &action
				}
			}
			change(&copy)
			if len(Validate(copy)) == 0 {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestCreateCanvas(t *testing.T) {
	g := testGraph()
	g.SchemaVersion = 2
	g.Nodes = append(g.Nodes, Node{ID: "board", Type: "action", Action: &Action{Type: "create_canvas", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, RecipeIDs: []string{"feature-announcement", "social-pack"}}})
	g.Edges[4].To = "board"
	g.Edges = append(g.Edges, Edge{"board", "review", "next"})
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
	preview := DryRun(g, Event{Family: Published, Fields: map[string]Value{"release.tag": StringValue("v1"), "release.prerelease": BoolValue(false)}})
	found := false
	for _, step := range preview.Steps {
		found = found || (step.Action == "create_canvas" && strings.Contains(step.Outcome, "2 templates"))
	}
	if !found {
		t.Fatalf("no canvas step in %+v", preview.Steps)
	}
	for name, change := range map[string]func(*Graph){
		"in v1":          func(g *Graph) { g.SchemaVersion = 1 },
		"no templates":   func(g *Graph) { g.Nodes[7].Action.RecipeIDs = nil },
		"many templates": func(g *Graph) { g.Nodes[7].Action.RecipeIDs = []string{"a", "b", "c", "d"} },
		"bad template":   func(g *Graph) { g.Nodes[7].Action.RecipeIDs = []string{"../../etc"} },
		"repeated":       func(g *Graph) { g.Nodes[7].Action.RecipeIDs = []string{"a", "a"} },
		"misplaced":      func(g *Graph) { g.Nodes[3].Action.RecipeIDs = []string{"social-pack"} },
		"brand config":   func(g *Graph) { g.Nodes[7].Action.BrandKitID = "brand" },
		"wrong input":    func(g *Graph) { g.Nodes[7].Action.Input = &Reference{NodeID: "review", Output: "reviewIds"} },
		"no input":       func(g *Graph) { g.Nodes[7].Action.Input = nil },
		"twice": func(g *Graph) {
			g.Nodes = append(g.Nodes, Node{ID: "board2", Type: "action", Action: &Action{Type: "create_canvas", Input: &Reference{NodeID: "release", Output: "releaseId"}, RecipeIDs: []string{"social-pack"}}})
			g.Edges[len(g.Edges)-1].To = "board2"
			g.Edges = append(g.Edges, Edge{"board2", "review", "next"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			copy := g
			copy.Nodes = slices.Clone(g.Nodes)
			copy.Edges = slices.Clone(g.Edges)
			for i := range copy.Nodes {
				if copy.Nodes[i].Action != nil {
					action := *copy.Nodes[i].Action
					copy.Nodes[i].Action = &action
				}
			}
			change(&copy)
			if len(Validate(copy)) == 0 {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	// A release output is enough: the canvas reads the release itself.
	g.Nodes[7].Action.Input = &Reference{NodeID: "release", Output: "releaseId"}
	if issues := Validate(g); len(issues) > 0 {
		t.Fatal(issues)
	}
}

// A code visual reads code only with the owner's consent, from a merged pull request.
func TestRenderCodeVisualNeedsConsentAndAPullRequest(t *testing.T) {
	build := func() Graph {
		g := testGraph()
		g.SchemaVersion = 2
		g.Family = Merged
		g.Qualification = Condition{Field: "pr.base", Operator: "eq", Values: []string{"main"}}
		g.Nodes[1] = Node{ID: "stable", Type: "condition", Condition: &Condition{Field: "pr.base", Operator: "eq", Values: []string{"main"}}}
		g.Nodes = append(g.Nodes, Node{ID: "code", Type: "action", Action: &Action{Type: "render_code_visual", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, ReadSourceCode: true}})
		g.Edges[4].To = "code"
		g.Edges = append(g.Edges, Edge{"code", "review", "next"})
		g.Nodes[4].Action.Input.NodeID = "code"
		return g
	}
	if issues := Validate(build()); len(issues) > 0 {
		t.Fatal(issues)
	}
	if outcome := DryRun(build(), Event{Family: Merged, Fields: map[string]Value{"pr.base": StringValue("main")}}).Steps; !slices.ContainsFunc(outcome, func(step Step) bool {
		return step.Action == "render_code_visual" && strings.Contains(step.Outcome, "reads no code")
	}) {
		t.Fatalf("dry run=%+v", outcome)
	}
	for name, change := range map[string]func(*Graph){
		"no consent":        func(g *Graph) { g.Nodes[7].Action.ReadSourceCode = false },
		"release trigger":   func(g *Graph) { g.Family = Published },
		"version one":       func(g *Graph) { g.SchemaVersion = 1 },
		"consent elsewhere": func(g *Graph) { g.Nodes[3].Action.ReadSourceCode = true },
		"twice": func(g *Graph) {
			g.Nodes = append(g.Nodes, Node{ID: "code2", Type: "action", Action: &Action{Type: "render_code_visual", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, ReadSourceCode: true}})
			g.Edges[len(g.Edges)-1].To = "code2"
			g.Edges = append(g.Edges, Edge{"code2", "review", "next"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			g := build()
			change(&g)
			if len(Validate(g)) == 0 {
				t.Fatal("invalid code visual accepted")
			}
		})
	}
}

// captureGraph is deployment → release → campaign → capture → render → review.
func captureGraph() Graph {
	g := testGraph()
	g.SchemaVersion, g.Family = 3, Deployed
	g.Qualification = Condition{Field: "deployment.environment", Operator: "eq", Values: []string{"production"}}
	g.Nodes[1].Condition = &Condition{Field: "deployment.state", Operator: "eq", Values: []string{"success"}}
	g.Nodes = append(g.Nodes,
		Node{ID: "capture", Type: "action", Action: &Action{Type: "capture_product", Input: &Reference{NodeID: "campaign", Output: "campaignId"}, SurfaceID: "surface", VersionPath: "/api/version"}},
		Node{ID: "art", Type: "action", Action: &Action{Type: "render_creatives", Input: &Reference{NodeID: "capture", Output: "campaignId"}, TemplateIDs: []string{"layout-browser-launch"}}})
	g.Edges[4].To = "capture"
	g.Edges = append(g.Edges, Edge{"capture", "art", "next"}, Edge{"art", "review", "next"})
	g.Nodes[4].Action.Input.NodeID = "art"
	return g
}

func TestCaptureProductLanguage(t *testing.T) {
	if issues := Validate(captureGraph()); len(issues) > 0 {
		t.Fatalf("issues=%+v", issues)
	}
	currentState := captureGraph()
	capture := FindNode(currentState, "capture").Action
	capture.VersionPath, capture.CurrentState = "", true
	if issues := Validate(currentState); len(issues) > 0 {
		t.Fatalf("explicit current state: %+v", issues)
	}
	for name, change := range map[string]func(*Graph, *Action){
		"older language": func(g *Graph, _ *Action) { g.SchemaVersion = 2 },
		"merge trigger":  func(g *Graph, _ *Action) { g.Family = Merged },
		"release unproven": func(g *Graph, a *Action) {
			g.Family, a.VersionPath, a.CurrentState = Published, "", true
		},
		"no surface":         func(_ *Graph, a *Action) { a.SurfaceID = "" },
		"no proof choice":    func(_ *Graph, a *Action) { a.VersionPath = "" },
		"both proof choices": func(_ *Graph, a *Action) { a.CurrentState = true },
		"another host":       func(_ *Graph, a *Action) { a.VersionPath = "https://evil.example/version" },
		"network path":       func(_ *Graph, a *Action) { a.VersionPath = "//evil.example/version" },
		"backslash path":     func(_ *Graph, a *Action) { a.VersionPath = `/\evil.example` },
		"no campaign":        func(_ *Graph, a *Action) { a.Input = nil },
		"foreign config":     func(_ *Graph, a *Action) { a.Audience = "everyone" },
		"second capture": func(g *Graph, _ *Action) {
			g.Nodes = append(g.Nodes, Node{ID: "again", Type: "action", Action: &Action{Type: "capture_product", Input: &Reference{NodeID: "capture", Output: "campaignId"}, SurfaceID: "surface", CurrentState: true}})
			g.Edges[len(g.Edges)-1] = Edge{"art", "again", "next"}
			g.Edges = append(g.Edges, Edge{"again", "review", "next"})
		},
	} {
		t.Run(name, func(t *testing.T) {
			g := captureGraph()
			for i := range g.Nodes {
				if g.Nodes[i].ID == "capture" {
					change(&g, g.Nodes[i].Action)
				}
			}
			if len(Validate(g)) == 0 {
				t.Fatal("an invalid capture was accepted")
			}
		})
	}
	// An authenticated recipe names its own page and proof, and needs nothing else.
	withRecipe := func(change func(*Action)) Graph {
		g := captureGraph()
		a := FindNode(g, "capture").Action
		a.SurfaceID, a.VersionPath, a.RecipeID = "", "", "recipe-1"
		change(a)
		return g
	}
	if issues := Validate(withRecipe(func(*Action) {})); len(issues) > 0 {
		t.Fatalf("recipe: %+v", issues)
	}
	if issues := Validate(withRecipe(func(a *Action) { a.CurrentState = true })); len(issues) > 0 {
		t.Fatalf("recipe without proof: %+v", issues)
	}
	if len(Validate(withRecipe(func(a *Action) { a.SurfaceID = "surface" }))) == 0 || len(Validate(withRecipe(func(a *Action) { a.VersionPath = "/v" }))) == 0 {
		t.Fatal("a recipe's page or proof was overridden")
	}
	// Other actions cannot carry version proof.
	g := testGraph()
	g.SchemaVersion = 3
	g.Nodes[2].Action.CurrentState = true
	if len(Validate(g)) == 0 {
		t.Fatal("version proof on create release was accepted")
	}
	g = testGraph()
	g.SchemaVersion = 3
	g.Nodes[2].Action.RecipeID = "recipe-1"
	if len(Validate(g)) == 0 {
		t.Fatal("a recipe on create release was accepted")
	}
	// Preview names the source a render will really use.
	preview := DryRun(captureGraph(), Event{Family: Deployed, Fields: map[string]Value{"deployment.environment": StringValue("production"), "deployment.state": StringValue("success")}})
	var rendered string
	for _, step := range preview.Steps {
		if step.Action == "render_creatives" {
			rendered = step.Outcome
		}
	}
	if !strings.Contains(rendered, "this deployment's capture") {
		t.Fatalf("steps=%+v", preview.Steps)
	}
}
