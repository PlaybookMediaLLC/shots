package releaseautomation

import (
	"encoding/json"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

// MaxGitHubPayloadBytes matches the facade's byte budget; normalized snapshots
// remain small. GitHub.com caps webhook payloads at 25 MB.
const MaxGitHubPayloadBytes = 25 << 20

// ProductionPolicy is separate from the Shots graph language. Schema 0 is a
// migration-only marker for existing behavior; administrators can only save v1.
type ProductionPolicy struct {
	SchemaVersion        int              `json:"schemaVersion"`
	Enabled              bool             `json:"enabled"`
	InstallationID       int64            `json:"installationId"`
	RepositoryID         string           `json:"repositoryId"`
	Environments         []string         `json:"environments"`
	Refs                 []string         `json:"refs"`
	Signal               string           `json:"signal"`
	Workflows            []GitHubWorkflow `json:"workflows"`
	JobNames             []string         `json:"jobNames"`
	TrustedAppIDs        []int64          `json:"trustedAppIds"`
	RequireChangeReceipt bool             `json:"requireChangeReceipt"`
	TrustActionsOutcome  bool             `json:"trustActionsOutcome"`
	DefinitionID         string           `json:"definitionId"`
}

type GitHubWorkflow struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Path  string `json:"path"`
	State string `json:"state"`
}

// GitHubEvidence preserves observations, not claims about availability. Empty
// fields mean missing; no association is inferred from a SHA or timestamp.
type GitHubEvidence struct {
	SchemaVersion         int            `json:"schemaVersion"`
	EventName             string         `json:"eventName"`
	Action                string         `json:"action"`
	Key                   string         `json:"key"`
	ObjectKey             string         `json:"objectKey"`
	ObjectID              string         `json:"objectId"`
	ObservationID         string         `json:"observationId"`
	InstallationID        int64          `json:"installationId"`
	RepositoryID          string         `json:"repositoryId"`
	RepositoryName        string         `json:"repositoryName"`
	DefaultBranch         string         `json:"defaultBranch,omitempty"`
	ActorLogin            string         `json:"actorLogin,omitempty"`
	OccurredAt            time.Time      `json:"occurredAt"`
	State                 string         `json:"state"`
	Environment           string         `json:"environment"`
	DeploymentEnvironment string         `json:"deploymentEnvironment"`
	Production            *bool          `json:"production"`
	Ref                   string         `json:"ref"`
	SHA                   string         `json:"sha"`
	URL                   string         `json:"url"`
	AppID                 int64          `json:"appId"`
	Workflow              GitHubWorkflow `json:"workflow"`
	RunID                 int64          `json:"runId"`
	RunAttempt            int            `json:"runAttempt"`
	JobID                 int64          `json:"jobId"`
	JobName               string         `json:"jobName"`
	Association           string         `json:"association"`
	Conflict              bool           `json:"conflict"`
	ChangeReceipt         *bool          `json:"changeReceipt"`
	ReceiptRevision       string         `json:"receiptRevision"`
	ReceiptAppID          int64          `json:"receiptAppId"`
}

type ProductionCheck struct {
	Condition string `json:"condition"`
	Status    string `json:"status"`
	Reason    string `json:"reason"`
}

type ProductionDecision struct {
	Status   string            `json:"status"`
	Reason   string            `json:"reason"`
	Strength string            `json:"strength"`
	Checks   []ProductionCheck `json:"checks"`
}

func ValidateProductionPolicy(p ProductionPolicy) error {
	if p.SchemaVersion != 1 || p.InstallationID <= 0 || p.RepositoryID == "" || p.DefinitionID == "" || len(p.DefinitionID) > 100 || len(p.RepositoryID) > 64 {
		return ErrPayload
	}
	if !slices.Contains([]string{"deployment_status", "workflow_run", "workflow_job"}, p.Signal) || len(p.Environments) == 0 || len(p.Environments) > 20 || len(p.Refs) > 50 || len(p.Workflows) > 20 || len(p.JobNames) > 20 || len(p.TrustedAppIDs) > 20 {
		return ErrPayload
	}
	for _, items := range [][]string{p.Environments, p.Refs, p.JobNames} {
		for _, value := range items {
			if strings.TrimSpace(value) == "" || len(value) > 255 || strings.ContainsRune(value, 0) {
				return ErrPayload
			}
		}
	}
	for _, w := range p.Workflows {
		if w.ID <= 0 || w.Name == "" || len(w.Name) > 255 || !strings.HasPrefix(w.Path, ".github/workflows/") || len(w.Path) > 255 {
			return ErrPayload
		}
	}
	for _, environment := range p.Environments {
		if len(environment) > 100 {
			return ErrPayload
		}
	}
	for _, id := range p.TrustedAppIDs {
		if id <= 0 {
			return ErrPayload
		}
	}
	if p.Signal != "deployment_status" && (!p.TrustActionsOutcome || len(p.Workflows) == 0 || len(p.Environments) != 1) {
		return ErrPayload
	}
	if p.Signal == "workflow_job" && len(p.JobNames) == 0 {
		return ErrPayload
	}
	if len(p.JobNames) > 0 && len(p.Workflows) == 0 {
		return ErrPayload
	}
	// Receipts are only trusted from an explicitly selected reporting App.
	if p.RequireChangeReceipt && (p.Signal != "deployment_status" || len(p.TrustedAppIDs) == 0) {
		return ErrPayload
	}
	return nil
}

// EvaluateProduction is shared by live processing and read-only preview.
// Contradiction wins over missing evidence, which wins over match. Explicit
// environment aliases are authoritative; the provider flag never widens them.
func EvaluateProduction(p ProductionPolicy, e GitHubEvidence) ProductionDecision {
	d := ProductionDecision{Status: "matched", Strength: "reported_deployment", Checks: []ProductionCheck{}}
	add := func(condition, status, reason string) {
		d.Checks = append(d.Checks, ProductionCheck{condition, status, reason})
		if status == "not_matched" || status == "needs_attention" && d.Status == "matched" {
			d.Status = status
		}
	}
	equal := func(condition, got, want string) {
		if got == "" {
			add(condition, "needs_attention", "GitHub did not report this value.")
		} else if got != want {
			add(condition, "not_matched", "Observed value contradicts the policy.")
		} else {
			add(condition, "matched", "Observed value matches the policy.")
		}
	}
	member := func(condition, got string, want []string) {
		if len(want) == 0 {
			return
		}
		if got == "" {
			add(condition, "needs_attention", "GitHub did not report this value.")
		} else if !slices.Contains(want, got) {
			add(condition, "not_matched", "Observed value is outside the configured values.")
		} else {
			add(condition, "matched", "Observed value is explicitly configured.")
		}
	}
	if ValidateProductionPolicy(p) != nil {
		add("policy", "needs_attention", "Set a production policy for this repository.")
		d.Reason = d.Checks[0].Reason
		return d
	}
	equal("repository", e.RepositoryID, p.RepositoryID)
	equal("installation", strconv.FormatInt(e.InstallationID, 10), strconv.FormatInt(p.InstallationID, 10))
	equal("signal", e.EventName, p.Signal)
	equal("outcome", e.State, "success")
	if p.Signal != "deployment_status" {
		equal("completion", e.Action, "completed")
		if e.RunAttempt <= 0 {
			add("run_attempt", "needs_attention", "GitHub did not say which run attempt this was, so Shots did not assume the latest one.")
		}
	}
	if !p.Enabled {
		add("enabled", "not_matched", "This policy is paused.")
	}
	if e.Conflict {
		add("correlation", "needs_attention", "GitHub's identifiers conflict, so Shots did not guess a match.")
	}
	if p.Signal == "deployment_status" {
		member("environment", e.Environment, p.Environments)
		if e.Environment != "" && e.DeploymentEnvironment != "" && e.Environment != e.DeploymentEnvironment {
			add("environment_consistency", "needs_attention", "Deployment and status environments disagree.")
		}
		if e.Production != nil && !*e.Production && slices.Contains(p.Environments, e.Environment) {
			add("production_flag", "needs_attention", "GitHub explicitly marks this environment non-production.")
		}
	} else {
		d.Strength = "trusted_actions_outcome"
		add("environment", "matched", "You chose to count this Actions result as your production environment; GitHub did not report one.")
		add("limits", "matched", "You chose to trust this result. A success can mean nothing changed, and does not prove a new version is live.")
	}
	member("ref", e.Ref, p.Refs)
	if len(p.TrustedAppIDs) > 0 {
		if e.AppID == 0 {
			add("reporting_app", "needs_attention", "The reporting GitHub App identity is missing.")
		} else if !slices.Contains(p.TrustedAppIDs, e.AppID) {
			add("reporting_app", "not_matched", "The reporting App is not trusted by this policy.")
		} else {
			add("reporting_app", "matched", "Reporting App is explicitly trusted.")
		}
	}
	if len(p.Workflows) > 0 {
		if e.Workflow.ID == 0 || e.Association == "" {
			add("workflow", "needs_attention", "GitHub does not link this event to a workflow.")
		} else {
			i := slices.IndexFunc(p.Workflows, func(w GitHubWorkflow) bool { return w.ID == e.Workflow.ID })
			if i < 0 {
				add("workflow", "not_matched", "Workflow ID is not selected.")
			} else if e.Workflow.Path == "" {
				add("workflow", "needs_attention", "Workflow path is missing.")
			} else if p.Workflows[i].Path != e.Workflow.Path || p.Workflows[i].Name != e.Workflow.Name {
				add("workflow", "needs_attention", "Selected workflow was renamed or moved; review the selection.")
			} else {
				add("workflow", "matched", "The workflow matches by ID, name and path.")
			}
		}
	}
	if len(p.JobNames) > 0 {
		if e.JobID == 0 || e.Association == "" {
			add("job", "needs_attention", "GitHub does not link this event to a job.")
		} else {
			member("job", e.JobName, p.JobNames)
		}
	}
	if p.RequireChangeReceipt {
		if e.ReceiptAppID == 0 || !slices.Contains(p.TrustedAppIDs, e.ReceiptAppID) {
			add("receipt_reporter", "needs_attention", "The proof of change did not come from an app you trust.")
		}
		if e.ChangeReceipt == nil || e.ReceiptRevision == "" || e.SHA == "" {
			add("change_receipt", "needs_attention", "This needs proof from a trusted app (shots-deploy-v1) that this commit changed production. A success alone can mean nothing changed.")
		} else if !*e.ChangeReceipt {
			add("change_receipt", "not_matched", "The app reported that nothing changed.")
		} else if e.ReceiptRevision != e.SHA {
			add("change_receipt", "needs_attention", "The proof of change names a different commit from the deployment.")
		} else {
			add("change_receipt", "matched", "A trusted app confirms this commit changed production.")
			d.Strength = "trusted_change_receipt"
		}
	}
	d.Reason = "Configured production evidence matched. This does not verify live availability or approve customer claims."
	for _, c := range d.Checks {
		if c.Status == d.Status && d.Status != "matched" {
			d.Reason = c.Reason
			break
		}
	}
	return d
}

// NormalizeGitHubEvidence accepts deployment states and Actions lifecycle
// observations without pretending they are successful deployment business events.
func NormalizeGitHubEvidence(name string, body json.RawMessage) (*GitHubEvidence, error) {
	if len(body) > MaxGitHubPayloadBytes {
		return nil, ErrPayload
	}
	if !slices.Contains([]string{"deployment_status", "workflow_run", "workflow_job"}, name) {
		return nil, nil
	}
	type workflow struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
		Path string `json:"path"`
	}
	type run struct {
		ID         int64     `json:"id"`
		WorkflowID int64     `json:"workflow_id"`
		Name       string    `json:"name"`
		Path       string    `json:"path"`
		Attempt    int       `json:"run_attempt"`
		Status     string    `json:"status"`
		Conclusion string    `json:"conclusion"`
		SHA        string    `json:"head_sha"`
		Branch     string    `json:"head_branch"`
		Updated    time.Time `json:"updated_at"`
		Created    time.Time `json:"created_at"`
	}
	var p struct {
		githubRepository
		Action     string `json:"action"`
		Deployment struct {
			ID          int64  `json:"id"`
			Environment string `json:"environment"`
			SHA         string `json:"sha"`
			Ref         string `json:"ref"`
			Production  *bool  `json:"production_environment"`
			Task        string `json:"task"`
			App         struct {
				ID int64 `json:"id"`
			} `json:"performed_via_github_app"`
			Payload json.RawMessage `json:"payload"`
		} `json:"deployment"`
		Status struct {
			ID          int64     `json:"id"`
			State       string    `json:"state"`
			Environment string    `json:"environment"`
			URL         string    `json:"environment_url"`
			TargetURL   string    `json:"target_url"`
			Created     time.Time `json:"created_at"`
			App         struct {
				ID int64 `json:"id"`
			} `json:"performed_via_github_app"`
		} `json:"deployment_status"`
		Workflow workflow `json:"workflow"`
		Run      run      `json:"workflow_run"`
		Job      struct {
			ID         int64     `json:"id"`
			RunID      int64     `json:"run_id"`
			Attempt    int       `json:"run_attempt"`
			Name       string    `json:"name"`
			Status     string    `json:"status"`
			Conclusion string    `json:"conclusion"`
			SHA        string    `json:"head_sha"`
			Branch     string    `json:"head_branch"`
			Started    time.Time `json:"started_at"`
			Completed  time.Time `json:"completed_at"`
		} `json:"workflow_job"`
		Check struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"check_run"`
	}
	if json.Unmarshal(body, &p) != nil || p.Installation.ID <= 0 || p.Repository.ID <= 0 {
		return nil, ErrPayload
	}
	e := &GitHubEvidence{SchemaVersion: 1, EventName: name, Action: p.Action, InstallationID: p.Installation.ID, RepositoryID: strconv.FormatInt(p.Repository.ID, 10), RepositoryName: p.Repository.FullName, DefaultBranch: p.Repository.DefaultBranch, ActorLogin: p.Sender.Login}
	e.Workflow = GitHubWorkflow{ID: p.Workflow.ID, Name: p.Workflow.Name, Path: p.Workflow.Path}
	if p.Run.ID > 0 {
		e.RunID, e.RunAttempt = p.Run.ID, p.Run.Attempt
		if e.Workflow.ID > 0 && p.Run.WorkflowID > 0 && e.Workflow.ID != p.Run.WorkflowID {
			e.Conflict = true
		}
		if e.Workflow.ID == 0 {
			e.Workflow.ID = p.Run.WorkflowID
			e.Workflow.Name = p.Run.Name
			e.Workflow.Path = p.Run.Path
		}
		e.Association = "webhook"
	}
	switch name {
	case "deployment_status":
		if p.Deployment.ID <= 0 || p.Status.ID <= 0 || p.Status.State == "" || p.Status.Created.IsZero() {
			return nil, ErrPayload
		}
		e.ObjectID = strconv.FormatInt(p.Deployment.ID, 10)
		e.ObservationID = strconv.FormatInt(p.Status.ID, 10)
		e.ObjectKey = "deployment:" + e.RepositoryID + ":" + e.ObjectID
		e.Key = e.ObjectKey + ":status:" + e.ObservationID
		e.State, e.OccurredAt = p.Status.State, p.Status.Created
		e.Environment = p.Status.Environment
		if e.Environment == "" {
			e.Environment = p.Deployment.Environment
		}
		e.DeploymentEnvironment, e.Production = p.Deployment.Environment, p.Deployment.Production
		e.Ref, e.SHA, e.URL, e.AppID = p.Deployment.Ref, p.Deployment.SHA, SafeEvidenceURL(p.Status.URL), p.Status.App.ID
		if p.Status.URL == "" {
			e.URL = SafeEvidenceURL(p.Status.TargetURL)
		}
		e.ReceiptAppID = p.Deployment.App.ID
		e.JobID, e.JobName = p.Check.ID, p.Check.Name
		if e.JobID > 0 || e.Workflow.ID > 0 {
			e.Association = "webhook"
		}
		if p.Deployment.Task == "shots-deploy-v1" {
			var receipt struct {
				SchemaVersion int    `json:"schemaVersion"`
				Changed       *bool  `json:"changed"`
				Revision      string `json:"revision"`
			}
			if json.Unmarshal(p.Deployment.Payload, &receipt) == nil && receipt.SchemaVersion == 1 {
				e.ChangeReceipt, e.ReceiptRevision = receipt.Changed, receipt.Revision
			}
		}
	case "workflow_run":
		if p.Run.ID <= 0 || p.Action == "" || p.Run.Updated.IsZero() {
			return nil, ErrPayload
		}
		e.ObjectID = strconv.FormatInt(p.Run.ID, 10)
		e.ObservationID = strconv.Itoa(p.Run.Attempt)
		e.ObjectKey = fmt.Sprintf("run:%s:%s:%d", e.RepositoryID, e.ObjectID, p.Run.Attempt)
		e.State = p.Run.Conclusion
		if e.State == "" {
			e.State = p.Run.Status
		}
		e.OccurredAt, e.SHA, e.Ref = p.Run.Updated, p.Run.SHA, p.Run.Branch
		e.Key = e.ObjectKey + ":" + p.Action + ":" + e.State
	case "workflow_job":
		if p.Job.ID <= 0 || p.Job.RunID <= 0 || p.Action == "" {
			return nil, ErrPayload
		}
		e.ObjectID = strconv.FormatInt(p.Job.ID, 10)
		e.ObservationID = e.ObjectID
		e.ObjectKey = "job:" + e.RepositoryID + ":" + e.ObjectID
		e.State = p.Job.Conclusion
		if e.State == "" {
			e.State = p.Job.Status
		}
		e.OccurredAt = p.Job.Completed
		if e.OccurredAt.IsZero() {
			e.OccurredAt = p.Job.Started
		}
		// queued/waiting payloads can lack timestamps. Receipt time stays separate;
		// zero occurrence time is displayed as unknown and cannot qualify.
		e.SHA, e.Ref = p.Job.SHA, p.Job.Branch
		e.RunID, e.RunAttempt, e.JobID, e.JobName = p.Job.RunID, p.Job.Attempt, p.Job.ID, p.Job.Name
		e.Key = e.ObjectKey + ":" + p.Action + ":" + e.State
	}
	for _, s := range []string{e.RepositoryName, e.DefaultBranch, e.ActorLogin, e.Environment, e.DeploymentEnvironment, e.Ref, e.SHA, e.Workflow.Path, e.Workflow.Name, e.JobName, e.ReceiptRevision, e.State, e.Action} {
		if len(s) > 255 || strings.ContainsRune(s, 0) {
			return nil, ErrPayload
		}
	}
	if len(e.Action) > 64 || len(e.State) > 64 || len(e.RepositoryName) > 200 || len(e.SHA) > 64 || len(e.ReceiptRevision) > 64 {
		return nil, ErrPayload
	}
	return e, nil
}

// SafeEvidenceURL is the public projection of a provider link. Keep private URL
// credentials out of history responses without rewriting immutable snapshots.
func SafeEvidenceURL(value string) string {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(value) > 2000 {
		return ""
	}
	// Query strings may contain access tokens or signed storage credentials.
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// ProductionEvent adapts a qualified observation to the existing deployment
// graph contract. Its observation and policy remain separately inspectable.
func ProductionEvent(e GitHubEvidence, p ProductionPolicy) Event {
	environment := e.Environment
	if environment == "" && len(p.Environments) == 1 {
		environment = p.Environments[0]
	}
	action := "success"
	if e.EventName == "deployment_status" && e.Action != "" {
		action = e.Action
	}
	event := Event{Family: Deployed, SemanticKey: e.ObjectKey + ":qualified", RepositoryID: e.RepositoryID, RepositoryName: e.RepositoryName, DefaultBranch: e.DefaultBranch, ObjectID: e.ObjectID, OccurredAt: e.OccurredAt, Origin: "live", Title: "Production-qualified deployment evidence", Notes: "Configured production evidence matched. A reported outcome does not prove a new live revision or customer availability.", URL: e.URL, Fields: map[string]Value{"repository.id": StringValue(e.RepositoryID), "event.family": StringValue(string(Deployed)), "event.action": StringValue(action), "deployment.state": StringValue("success"), "deployment.environment": StringValue(environment)}}
	if e.RepositoryName != "" {
		event.Fields["repository.name"] = StringValue(e.RepositoryName)
	}
	if e.ActorLogin != "" {
		event.Fields["actor.login"] = StringValue(e.ActorLogin)
	}
	if e.SHA != "" {
		event.Fields["deployment.sha"] = StringValue(e.SHA)
	}
	if e.EventName != "deployment_status" {
		// Downstream capture/release association also uses ObjectID. Keep the
		// attempt and provider namespace there, so reruns cannot collapse later.
		event.ObjectID = e.ObjectKey
	}
	if e.Production != nil {
		event.Fields["deployment.production"] = BoolValue(*e.Production)
	}
	return event
}
