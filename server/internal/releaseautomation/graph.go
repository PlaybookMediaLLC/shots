package releaseautomation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

var nodeID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// templateID matches the web's design template catalog identifiers.
var templateID = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// BoundedDraft applies storage limits even when a draft is semantically incomplete.
func BoundedDraft(graph Graph) bool {
	if len(graph.Nodes) > MaxNodes || len(graph.Edges) > MaxNodes*2 {
		return false
	}
	var bounded func(Condition, int, *int) bool
	bounded = func(c Condition, depth int, count *int) bool {
		*count++
		if depth > 8 || *count > 128 || len(c.Children) > 32 || len(c.Values) > 50 {
			return false
		}
		for _, child := range c.Children {
			if !bounded(child, depth+1, count) {
				return false
			}
		}
		return true
	}
	count := 0
	if !bounded(graph.Qualification, 1, &count) {
		return false
	}
	for _, node := range graph.Nodes {
		count = 0
		if node.Condition != nil && !bounded(*node.Condition, 1, &count) {
			return false
		}
	}
	body, err := json.Marshal(graph)
	return err == nil && len(body) <= 32<<10
}

// Validate checks structure and input availability on every incoming path.
// Drafts may retain these issues; activation and execution must reject them.
func Validate(graph Graph) []Issue {
	issues := []Issue{}
	add := func(id, code, message string) { issues = append(issues, Issue{id, code, message}) }
	if !BoundedDraft(graph) {
		add("", "graph_size", "Use at most 32 KiB, 64 nodes, 128 edges, and condition depth 8.")
		return issues
	}
	if graph.SchemaVersion < 1 || graph.SchemaVersion > SchemaVersion {
		add("", "schema_version", "This executor does not support the graph schema.")
	}
	if !ValidFamily(graph.Family) {
		add("", "event_family", "Select a supported event family.")
	} else if graph.SchemaVersion < FamilyVersion(graph.Family) {
		add("", "schema_version", "This trigger requires workflow language version 2.")
	}
	if graph.SchemaVersion < 2 && usesV2Condition(graph) {
		add("", "schema_version", "These fields or comparison operators require workflow language version 2.")
	}
	if reason := ValidateCondition(graph.Qualification, graph.Family); reason != "" {
		add("", "qualification", reason)
	}
	if len(graph.Nodes) < 2 || len(graph.Nodes) > MaxNodes || len(graph.Edges) > MaxNodes*2 {
		add("", "graph_size", "Use 2–64 nodes and at most 128 edges.")
		return issues
	}
	nodes, outgoing, incoming := map[string]Node{}, map[string][]Edge{}, map[string][]string{}
	trigger, generations, classifiers, renders, canvases, codeVisuals := "", 0, 0, 0, 0, 0
	for _, n := range graph.Nodes {
		if _, ok := nodes[n.ID]; ok || !nodeID.MatchString(n.ID) {
			add(n.ID, "node_id", "Node IDs must be unique letters, numbers, underscores, or hyphens.")
		}
		nodes[n.ID] = n
		if n.Type != "condition" && n.Condition != nil || n.Type != "classify" && n.Classify != nil || n.Type != "action" && n.Action != nil || n.Type != "end" && n.Outcome != "" {
			add(n.ID, "node_config", "Configuration does not belong to this node type.")
		}
		switch n.Type {
		case "trigger":
			if trigger != "" {
				add(n.ID, "trigger_count", "A graph has exactly one trigger.")
			}
			trigger = n.ID
		case "condition":
			if n.Condition == nil {
				add(n.ID, "condition", "Configure a condition.")
			} else if reason := ValidateCondition(*n.Condition, graph.Family); reason != "" {
				add(n.ID, "condition", reason)
			}
		case "action":
			if reason := validateAction(n.Action, graph.SchemaVersion); reason != "" {
				add(n.ID, "action", reason)
			}
			if n.Action != nil && n.Action.Type == "generate_copy" {
				if generations++; generations > MaxGenerationNodes {
					add(n.ID, "generation_limit", fmt.Sprintf("A workflow can generate copy at most %d times per run.", MaxGenerationNodes))
				}
			}
			if n.Action != nil && n.Action.Type == "render_creatives" {
				if renders++; renders > 1 {
					add(n.ID, "render_limit", "A workflow can render creatives once per run.")
				}
			}
			if n.Action != nil && n.Action.Type == "create_canvas" {
				if canvases++; canvases > 1 {
					add(n.ID, "canvas_limit", "A workflow can create a canvas once per run.")
				}
			}
			if n.Action != nil && n.Action.Type == "render_code_visual" {
				if codeVisuals++; codeVisuals > 1 {
					add(n.ID, "code_visual_limit", "A workflow can render a code visual once per run.")
				}
				if graph.Family != Merged {
					add(n.ID, "code_visual_trigger", "Code visuals render from a merged pull request; use the pull request trigger.")
				}
			}
		case "classify":
			if reason := validateClassify(n.Classify, graph.SchemaVersion); reason != "" {
				add(n.ID, "classify", reason)
			}
			if classifiers++; classifiers > MaxClassifyNodes {
				add(n.ID, "classify_limit", fmt.Sprintf("A workflow can ask the AI at most %d times per run.", MaxClassifyNodes))
			}
		case "end":
			if n.Outcome != "completed" && n.Outcome != "skipped" {
				add(n.ID, "outcome", "Choose completed or intentionally skipped.")
			}
		default:
			add(n.ID, "node_type", "Unknown node type.")
		}
	}
	if trigger == "" {
		add("", "trigger_count", "A graph has exactly one trigger.")
	}
	for _, e := range graph.Edges {
		_, from := nodes[e.From]
		_, to := nodes[e.To]
		if !from || !to {
			add(e.From, "edge_endpoint", "Both edge endpoints must exist.")
			continue
		}
		outgoing[e.From] = append(outgoing[e.From], e)
		incoming[e.To] = append(incoming[e.To], e.From)
	}
	for _, n := range graph.Nodes {
		edges := outgoing[n.ID]
		switch n.Type {
		case "condition", "classify":
			if len(edges) != 2 || edges[0].Branch == edges[1].Branch || !slices.Contains([]string{"true", "false"}, edges[0].Branch) || !slices.Contains([]string{"true", "false"}, edges[1].Branch) {
				add(n.ID, "condition_edges", "Connect exactly one true and one false edge.")
			}
		case "trigger", "action":
			if len(edges) != 1 || edges[0].Branch != "next" {
				add(n.ID, "continuation", "Connect exactly one next edge.")
			}
		case "end":
			if len(edges) != 0 {
				add(n.ID, "terminal", "End nodes cannot have outgoing edges.")
			}
		}
		if n.Type == "trigger" && len(incoming[n.ID]) != 0 {
			add(n.ID, "trigger_input", "The trigger cannot have incoming edges.")
		}
		if n.Action != nil && n.Action.Type == "submit_review" && len(edges) == 1 && nodes[edges[0].To].Type != "end" {
			add(n.ID, "review_terminal", "This version ends after submitting for human review.")
		}
	}
	// DFS covers disconnected components as well, so even an unreachable cycle
	// is reported. Ordered slices keep validation and workflow replay stable.
	state, reachable := map[string]int{}, map[string]bool{}
	order := []string{}
	var visit func(string, bool)
	visit = func(id string, reached bool) {
		if reached {
			reachable[id] = true
		}
		if state[id] == 1 {
			add(id, "cycle", "Cycles are not supported.")
			return
		}
		if state[id] == 2 {
			return
		}
		state[id] = 1
		for _, e := range outgoing[id] {
			visit(e.To, reached)
		}
		state[id] = 2
		order = append(order, id)
	}
	if trigger != "" {
		visit(trigger, true)
	}
	for _, n := range graph.Nodes {
		if !reachable[n.ID] {
			add(n.ID, "unreachable", "Connect this node to the trigger.")
		}
		visit(n.ID, false)
	}
	if len(issues) > 0 {
		return issues
	}
	slices.Reverse(order)
	dominators := map[string]map[string]bool{}
	for _, id := range order {
		available := map[string]bool{}
		for i, parent := range incoming[id] {
			if i == 0 {
				for key := range dominators[parent] {
					available[key] = true
				}
				available[parent] = true
			} else {
				for key := range available {
					if key != parent && !dominators[parent][key] {
						delete(available, key)
					}
				}
			}
		}
		dominators[id] = available
		n := nodes[id]
		if n.Action == nil || n.Action.Input == nil {
			continue
		}
		ref := n.Action.Input
		producer, ok := nodes[ref.NodeID]
		if !ok || !available[ref.NodeID] || producer.Action == nil || outputOf(producer.Action.Type) != ref.Output {
			add(id, "unavailable_input", "The referenced output must be produced on every path to this action.")
		}
	}
	return issues
}

func outputOf(action string) string {
	switch action {
	case "create_release":
		return "releaseId"
	case "create_campaign", "generate_copy", "render_creatives", "render_code_visual":
		return "campaignId"
	case "submit_review":
		return "reviewIds"
	case "create_canvas":
		return "canvasId"
	}
	return ""
}

func validateAction(action *Action, version int) string {
	if action == nil {
		return "Choose an action."
	}
	if len(action.Audience) > 1000 || len(action.CallToAction) > 300 || len(action.BrandKitID) > 64 || len(action.DestinationIDs) > 10 {
		return "Action configuration exceeds its limit."
	}
	if action.CreditLimit != 0 && action.Type != "generate_copy" {
		return "Only copy generation spends AI credits."
	}
	if action.Include != "" && (action.Type != "create_release" || action.Include != "unreleased" || version < 2) {
		return "Release contents apply to create release in language version 2."
	}
	if len(action.TemplateIDs) > 0 && action.Type != "render_creatives" {
		return "Templates and surfaces belong to render creatives."
	}
	if action.SurfaceID != "" && action.Type != "render_creatives" && action.Type != "create_canvas" {
		return "Templates and surfaces belong to render creatives."
	}
	if len(action.RecipeIDs) > 0 && action.Type != "create_canvas" {
		return "Canvas templates belong to create canvas."
	}
	if action.ReadSourceCode && action.Type != "render_code_visual" {
		return "Only render code visual reads source code."
	}
	switch action.Type {
	case "create_release":
		if action.Input != nil || action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.CallToAction != "" {
			return "Create release accepts only an optional audience."
		}
	case "create_campaign":
		if action.Input == nil || action.Input.Output != "releaseId" {
			return "Create campaign requires a release output."
		}
		if action.BrandKitID == "" || len(action.DestinationIDs) == 0 {
			return "Select a brand kit and 1–10 destinations."
		}
		seen := map[string]bool{}
		for _, id := range action.DestinationIDs {
			if id == "" || len(id) > 64 || seen[id] {
				return "Destination IDs must be present and unique."
			}
			seen[id] = true
		}
	case "generate_copy":
		if version < 2 {
			return "Copy generation requires workflow language version 2."
		}
		if action.Input == nil || action.Input.Output != "campaignId" {
			return "Generate copy requires a campaign output."
		}
		if action.CreditLimit < 1 || action.CreditLimit > MaxCreditLimit {
			return fmt.Sprintf("Set an AI credit limit from 1 to %d.", MaxCreditLimit)
		}
		if action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.Audience != "" || action.CallToAction != "" {
			return "Generate copy uses the campaign's brand and destinations."
		}
	case "render_creatives":
		if version < 2 {
			return "Rendering creatives requires workflow language version 2."
		}
		if action.Input == nil || action.Input.Output != "campaignId" {
			return "Render creatives requires a campaign output."
		}
		if len(action.TemplateIDs) == 0 || len(action.TemplateIDs) > MaxRenderTemplates {
			return fmt.Sprintf("Choose 1–%d design templates.", MaxRenderTemplates)
		}
		seen := map[string]bool{}
		for _, id := range action.TemplateIDs {
			if !templateID.MatchString(id) || seen[id] {
				return "Template IDs must be unique catalog identifiers."
			}
			seen[id] = true
		}
		if len(action.SurfaceID) > 64 || action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.Audience != "" || action.CallToAction != "" {
			return "Render creatives uses the campaign's brand and a product surface."
		}
	case "create_canvas":
		if version < 2 {
			return "Creating a canvas requires workflow language version 2."
		}
		if action.Input == nil || (action.Input.Output != "releaseId" && action.Input.Output != "campaignId") {
			return "Create canvas requires a release or campaign output."
		}
		if len(action.RecipeIDs) == 0 || len(action.RecipeIDs) > MaxCanvasRecipes {
			return fmt.Sprintf("Choose 1–%d canvas templates.", MaxCanvasRecipes)
		}
		seen := map[string]bool{}
		for _, id := range action.RecipeIDs {
			if !templateID.MatchString(id) || seen[id] {
				return "Canvas template IDs must be unique catalog identifiers."
			}
			seen[id] = true
		}
		if len(action.SurfaceID) > 64 || action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.Audience != "" || action.CallToAction != "" {
			return "Create canvas uses the release and a product surface."
		}
	case "render_code_visual":
		if version < 2 {
			return "Rendering a code visual requires workflow language version 2."
		}
		if action.Input == nil || action.Input.Output != "campaignId" {
			return "Render code visual requires a campaign output."
		}
		if !action.ReadSourceCode {
			return "Allow this action to read the pull request's code; it renders the change as a code visual."
		}
		if action.SurfaceID != "" || action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.Audience != "" || action.CallToAction != "" {
			return "Render code visual uses the campaign and the merged pull request."
		}
	case "submit_review":
		if action.Input == nil || action.Input.Output != "campaignId" {
			return "Submit review requires a campaign output."
		}
		if action.BrandKitID != "" || len(action.DestinationIDs) > 0 || action.Audience != "" || action.CallToAction != "" {
			return "Submit review accepts only a campaign output."
		}
	default:
		return "This action is not supported by the executor."
	}
	return ""
}

func validateClassify(c *Classify, version int) string {
	switch {
	case c == nil:
		return "Describe what makes a change worth marketing."
	case version < 2:
		return "AI relevance checks require workflow language version 2."
	case len([]rune(strings.TrimSpace(c.Criteria))) < 10 || len([]rune(c.Criteria)) > 1000 || strings.ContainsRune(c.Criteria, 0):
		return "Criteria need 10–1,000 characters."
	case c.Threshold < 0.5 || c.Threshold > 0.99:
		return "Set a confidence threshold from 0.5 to 0.99."
	case c.CreditLimit < 1 || c.CreditLimit > MaxClassifyCredits:
		return fmt.Sprintf("Set an AI credit limit from 1 to %d.", MaxClassifyCredits)
	}
	return ""
}

// usesV2Condition finds version 2 fields or comparison operators anywhere.
func usesV2Condition(graph Graph) bool {
	var visit func(Condition) bool
	visit = func(c Condition) bool {
		if c.Field != "" && !v1Fields[c.Field] || slices.Contains([]string{"gt", "gte", "lt", "lte"}, c.Operator) {
			return true
		}
		return slices.ContainsFunc(c.Children, visit)
	}
	if visit(graph.Qualification) {
		return true
	}
	return slices.ContainsFunc(graph.Nodes, func(n Node) bool { return n.Condition != nil && visit(*n.Condition) })
}

// ContentHash excludes layout: moving a node cannot change execution semantics.
func ContentHash(graph Graph) string {
	body, _ := json.Marshal(graph)
	hash := sha256.Sum256(body)
	return hex.EncodeToString(hash[:])
}

func Trigger(graph Graph) string {
	for _, n := range graph.Nodes {
		if n.Type == "trigger" {
			return n.ID
		}
	}
	return ""
}
func Next(graph Graph, id, branch string) string {
	for _, e := range graph.Edges {
		if e.From == id && e.Branch == branch {
			return e.To
		}
	}
	return ""
}
func FindNode(graph Graph, id string) Node {
	for _, n := range graph.Nodes {
		if n.ID == id {
			return n
		}
	}
	return Node{}
}

// DryRun predicts control flow only. Actions are listed, never invoked. No
// action-output predicates exist in v1, so predicted IDs are never fabricated.
func DryRun(graph Graph, event Event) Preview { return DryRunAssuming(graph, event, true) }

// DryRunAssuming previews with AI relevance checks assumed to answer
// relevant; a preview never calls a model.
func DryRunAssuming(graph Graph, event Event, relevant bool) Preview {
	result := Preview{Issues: Validate(graph), Steps: []Step{}, Outcome: "invalid"}
	if len(result.Issues) > 0 {
		return result
	}
	if graph.Family != event.Family {
		result.Qualification = Decision{Status: "not_applicable", Reason: "The event belongs to another family."}
		return result
	}
	result.Qualification = Evaluate(graph.Qualification, event)
	if result.Qualification.Status != "evaluated" {
		result.Outcome = "unresolved"
		return result
	}
	if !result.Qualification.Match {
		result.Outcome = "no_match"
		return result
	}
	for id := Trigger(graph); id != ""; {
		n := FindNode(graph, id)
		step := Step{NodeID: id, Type: n.Type}
		branch := "next"
		switch n.Type {
		case "condition":
			decision := Evaluate(*n.Condition, event)
			step.Decision = &decision
			if decision.Status != "evaluated" {
				result.Steps = append(result.Steps, step)
				result.Outcome = "unresolved"
				return result
			}
			branch = "false"
			if decision.Match {
				branch = "true"
			}
		case "classify":
			step.Decision = &Decision{Status: "assumed", Match: relevant, Reason: "Preview assumes this AI verdict; execution asks the model and pays for one call."}
			branch = "false"
			if relevant {
				branch = "true"
			}
		case "action":
			step.Action = n.Action.Type
			step.Outcome = "Predicted action; output references remain unresolved until execution."
			if n.Action.Type == "submit_review" {
				step.Outcome = "Predicted review submission; human approval is required and this workflow ends."
			}
			if n.Action.Type == "generate_copy" {
				step.Outcome = fmt.Sprintf("Predicted paid copy generation of up to %d AI credits; preview never calls a model.", n.Action.CreditLimit)
			}
			if n.Action.Type == "render_creatives" {
				step.Outcome = fmt.Sprintf("Predicted render of %d creatives from the latest product capture; preview renders nothing.", len(n.Action.TemplateIDs))
			}
			if n.Action.Type == "create_canvas" {
				step.Outcome = fmt.Sprintf("Predicted canvas laid out from the release with %d templates; preview creates nothing.", len(n.Action.RecipeIDs))
			}
			if n.Action.Type == "render_code_visual" {
				step.Outcome = "Predicted code visual from the merged pull request's diff; preview reads no code and renders nothing."
			}
		case "end":
			step.Outcome = n.Outcome
			result.Outcome = n.Outcome
		}
		result.Steps = append(result.Steps, step)
		id = Next(graph, id, branch)
	}
	return result
}
