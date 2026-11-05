package product

import (
	"context"
	"errors"
	"slices"
	"time"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubdeliveryrecovery"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubproductionpolicy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/lucsky/cuid"
)

const EventGitHubObservation = "github.observation"

type ProductionPolicyVersion struct {
	ID        string                      `json:"id"`
	Revision  int                         `json:"revision"`
	Policy    automation.ProductionPolicy `json:"policy"`
	CreatedAt time.Time                   `json:"createdAt"`
}
type SaveProductionPolicyInput struct {
	ExpectedRevision int                         `json:"expectedRevision"`
	Policy           automation.ProductionPolicy `json:"policy"`
}
type GitHubObservationView struct {
	ID                string                        `json:"id"`
	DeliveryID        string                        `json:"deliveryId"`
	Evidence          automation.GitHubEvidence     `json:"evidence"`
	PolicyID          *string                       `json:"policyId"`
	WorkflowVersionID *string                       `json:"workflowVersionId"`
	EventID           *string                       `json:"eventId"`
	Status            string                        `json:"status"`
	Origin            string                        `json:"origin"`
	Decision          automation.ProductionDecision `json:"decision"`
	Duplicates        int                           `json:"duplicates"`
	ReceivedAt        time.Time                     `json:"receivedAt"`
	ProcessedAt       *time.Time                    `json:"processedAt"`
	RunID             *string                       `json:"runId"`
	DispatchStatus    string                        `json:"dispatchStatus"`
}

type GitHubProductionState struct {
	Policies     []ProductionPolicyVersion `json:"policies"`
	Observations []GitHubObservationView   `json:"observations"`
	NextCursor   string                    `json:"nextCursor"`
}

func latestProductionPolicy(ctx context.Context, client *ent.Client, org, source string) (*ent.GitHubProductionPolicy, error) {
	row, err := client.GitHubProductionPolicy.Query().Where(githubproductionpolicy.OrganizationID(org), githubproductionpolicy.SourceAppID(source)).Order(ent.Desc(githubproductionpolicy.FieldRevision)).First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	return row, err
}
func (c *Configuration) productionSource(ctx context.Context, actor Actor, id string) (*ent.SourceApp, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.SourceApp.Query().Where(sourceapp.OrganizationID(actor.OrganizationID), sourceapp.ID(id), sourceapp.Provider("github")).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	return row, err
}
func (c *Configuration) GetGitHubProduction(ctx context.Context, actor Actor, sourceID, cursor string) (*GitHubProductionState, error) {
	if _, err := c.productionSource(ctx, actor, sourceID); err != nil {
		return nil, err
	}
	policies, err := c.client.GitHubProductionPolicy.Query().Where(githubproductionpolicy.OrganizationID(actor.OrganizationID), githubproductionpolicy.SourceAppID(sourceID)).Order(ent.Desc(githubproductionpolicy.FieldRevision)).Limit(100).All(ctx)
	if err != nil {
		return nil, err
	}
	q := c.client.GitHubObservation.Query().Where(githubobservation.OrganizationID(actor.OrganizationID), githubobservation.SourceAppID(sourceID))
	if cursor != "" {
		q.Where(githubobservation.IDLT(cursor))
	}
	rows, err := q.Order(ent.Desc(githubobservation.FieldID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &GitHubProductionState{Policies: []ProductionPolicyVersion{}, Observations: []GitHubObservationView{}}
	for _, p := range policies {
		result.Policies = append(result.Policies, ProductionPolicyVersion{p.ID, p.Revision, p.Policy, p.CreatedAt})
	}
	if len(rows) > 50 {
		rows = rows[:50]
		result.NextCursor = rows[49].ID
	}
	// Always include revisions pinned by this page, even beyond the latest 100.
	missing := []string{}
	for _, r := range rows {
		if r.PolicyID != nil && !slices.ContainsFunc(policies, func(p *ent.GitHubProductionPolicy) bool { return p.ID == *r.PolicyID }) {
			missing = append(missing, *r.PolicyID)
		}
	}
	if len(missing) > 0 {
		pinned, err := c.client.GitHubProductionPolicy.Query().Where(githubproductionpolicy.OrganizationID(actor.OrganizationID), githubproductionpolicy.SourceAppID(sourceID), githubproductionpolicy.IDIn(missing...)).Order(ent.Desc(githubproductionpolicy.FieldRevision)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, p := range pinned {
			result.Policies = append(result.Policies, ProductionPolicyVersion{p.ID, p.Revision, p.Policy, p.CreatedAt})
		}
	}
	for _, r := range rows {
		e := r.Evidence
		if r.Enrichment != nil {
			e = *r.Enrichment
		}
		view := GitHubObservationView{ID: r.ID, DeliveryID: r.DeliveryID, Evidence: e, PolicyID: r.PolicyID, WorkflowVersionID: r.WorkflowVersionID, EventID: r.EventID, Status: r.Status, Origin: r.Origin, Decision: r.Decision, Duplicates: r.DuplicateCount, ReceivedAt: r.ReceivedAt, ProcessedAt: r.ProcessedAt}
		if r.EventID != nil {
			run, err := c.client.ReleaseAutomationRun.Query().Where(releaseautomationrun.OrganizationID(actor.OrganizationID), releaseautomationrun.EventID(*r.EventID)).Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			if run != nil {
				view.RunID = &run.ID
				view.DispatchStatus = run.Status
			}
		} else if r.Status == "received" {
			work, err := c.client.OutboxEvent.Query().Where(outboxevent.OrganizationID(actor.OrganizationID), outboxevent.Type(EventGitHubObservation), outboxevent.AggregateID(r.ID)).Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			view.DispatchStatus = "pending"
			if work != nil && work.DeadLetteredAt != nil {
				view.DispatchStatus = "failed"
				view.Status = "needs_attention"
				view.Decision.Reason = "Shots could not process this event after several tries. Ask whoever runs this Shots server to check it."
			} else if work != nil && work.Attempts > 0 {
				view.DispatchStatus = "retrying"
			}
		}
		result.Observations = append(result.Observations, view)
	}
	return result, nil
}
func (c *Configuration) SaveGitHubProduction(ctx context.Context, actor Actor, sourceID string, input SaveProductionPolicyInput) (*ProductionPolicyVersion, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if automation.ValidateProductionPolicy(input.Policy) != nil {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, sourceID)
	if err != nil {
		return nil, err
	}
	if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
		return nil, err
	}
	installation, err := tx.GitHubInstallation.Get(ctx, *source.GithubInstallationID)
	if err != nil {
		return nil, err
	}
	if input.Policy.InstallationID != installation.InstallationID || input.Policy.RepositoryID != *source.ExternalID {
		return nil, publishing.ErrForbidden
	}
	prior, err := latestProductionPolicy(ctx, tx.Client(), actor.OrganizationID, sourceID)
	if err != nil {
		return nil, err
	}
	revision := 0
	if prior != nil {
		revision = prior.Revision
	}
	if revision != input.ExpectedRevision {
		return nil, publishing.ErrConflict
	}
	definition, err := tx.ReleaseAutomation.Query().Where(releaseautomation.ID(input.Policy.DefinitionID), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.SourceAppID(sourceID), releaseautomation.Family(string(automation.Deployed)), releaseautomation.Archived(false)).Only(ctx)
	if err != nil {
		return nil, errors.Join(ErrInvalidInput, err)
	}
	if input.Policy.Enabled && (!definition.Enabled || definition.ActiveVersionID == nil) {
		return nil, conflict("Activate the selected Shots deployment workflow before enabling the production policy.")
	}
	row, err := tx.GitHubProductionPolicy.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSourceAppID(sourceID).SetRevision(revision + 1).SetPolicy(input.Policy).SetCreatedBy(actor.UserID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.github_production_policy_saved", "github_production_policy", row.ID, map[string]any{"revision": row.Revision, "enabled": row.Policy.Enabled}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ProductionPolicyVersion{row.ID, row.Revision, row.Policy, row.CreatedAt}, nil
}

type ProductionPreviewInput struct {
	Policy        automation.ProductionPolicy `json:"policy"`
	ObservationID string                      `json:"observationId"`
	Example       *automation.GitHubEvidence  `json:"example"`
}

func (c *Configuration) PreviewGitHubProduction(ctx context.Context, actor Actor, sourceID string, input ProductionPreviewInput) (automation.ProductionDecision, error) {
	source, err := c.productionSource(ctx, actor, sourceID)
	if err != nil {
		return automation.ProductionDecision{}, err
	}
	if source.ExternalID == nil || input.Policy.RepositoryID != *source.ExternalID || automation.ValidateProductionPolicy(input.Policy) != nil {
		return automation.ProductionDecision{}, ErrInvalidInput
	}
	var evidence automation.GitHubEvidence
	if input.ObservationID != "" {
		row, err := c.client.GitHubObservation.Query().Where(githubobservation.ID(input.ObservationID), githubobservation.OrganizationID(actor.OrganizationID), githubobservation.SourceAppID(sourceID)).Only(ctx)
		if err != nil {
			return automation.ProductionDecision{}, err
		}
		evidence = row.Evidence
		if row.Enrichment != nil {
			evidence = *row.Enrichment
		}
	} else if input.Example != nil {
		evidence = *input.Example
	} else {
		return automation.ProductionDecision{}, ErrInvalidInput
	}
	return automation.EvaluateProduction(input.Policy, evidence), nil
}

// Called under the same source lock/transaction as legacy intake. Returning
// true is permitted only for explicitly migrated legacy sources.
func recordGitHubObservation(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, delivery, origin string, e automation.GitHubEvidence) (legacy, duplicate bool, err error) {
	policy, err := latestProductionPolicy(ctx, tx.Client(), source.OrganizationID, source.ID)
	if err != nil {
		return false, false, err
	}
	legacy = policy != nil && policy.Policy.SchemaVersion == 0
	frontend, err := tx.FrontendSource.Query().Where(frontendsource.OrganizationID(source.OrganizationID), frontendsource.Or(frontendsource.ID(source.ID), frontendsource.GithubSourceID(source.ID))).Exist(ctx)
	if err != nil {
		return false, false, err
	}
	if frontend {
		legacy = false
	}
	prior, err := tx.GitHubObservation.Query().Where(githubobservation.OrganizationID(source.OrganizationID), githubobservation.SourceAppID(source.ID), githubobservation.SemanticKey(e.Key)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return false, false, err
	}
	if prior != nil {
		return legacy, true, prior.Update().AddDuplicateCount(1).Exec(ctx)
	}
	create := tx.GitHubObservation.Create().SetID(cuid.New()).SetOrganizationID(source.OrganizationID).SetSourceAppID(source.ID).SetDeliveryID(delivery).SetSemanticKey(e.Key).SetObjectKey(e.ObjectKey).SetEvidence(e).SetOrigin(origin)
	if !e.OccurredAt.IsZero() {
		create.SetOccurredAt(e.OccurredAt)
	}
	// GitHub provides no authenticated redelivery header. A very late first
	// receipt must be review-only even when its policy predates the occurrence.
	if policy != nil && policy.Policy.SchemaVersion == 1 && !e.OccurredAt.IsZero() && (e.OccurredAt.Before(policy.CreatedAt) || e.OccurredAt.Before(time.Now().Add(-15*time.Minute))) {
		origin = "historical"
		create.SetOrigin(origin)
	}
	status := "received"
	decision := automation.ProductionDecision{Status: "needs_attention", Reason: "Set a production policy for this repository. No workflow ran.", Checks: []automation.ProductionCheck{}}
	if policy != nil {
		create.SetPolicyID(policy.ID)
		if legacy {
			status = "legacy"
			decision.Reason = "Counted by the older production rule, not by a policy."
		} else {
			definition, err := tx.ReleaseAutomation.Query().Where(releaseautomation.ID(policy.Policy.DefinitionID), releaseautomation.OrganizationID(source.OrganizationID), releaseautomation.SourceAppID(source.ID), releaseautomation.Enabled(true), releaseautomation.Archived(false)).Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return false, false, err
			}
			if definition != nil && definition.ActiveVersionID != nil {
				create.SetWorkflowVersionID(*definition.ActiveVersionID)
			}
		}
	} else {
		status = "needs_attention"
	}
	// Retain repository evidence and its pinned GitHub policy while the
	// explicitly selected frontend policy owns new deployment side effects.
	// Previously queued GitHub observations keep their original processing.
	if frontend {
		status = "not_matched"
		decision.Status = "not_matched"
		decision.Reason = "A host connected under Deployments handles this repository's new deployments."
	}
	if origin != "live" {
		status = "review_only"
		decision.Reason = "A past or recovered event, kept for review. No workflow ran."
		if origin == "historical" {
			decision.Reason = "This event is older than the policy, or arrived more than 15 minutes late, so it is kept for review. No workflow ran."
		}
	}
	create.SetStatus(status).SetDecision(decision)
	if status != "received" {
		create.SetProcessedAt(time.Now())
	}
	row, err := create.Save(ctx)
	if err != nil {
		return false, false, err
	}
	if status == "received" {
		err = tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(source.OrganizationID).SetType(EventGitHubObservation).SetAggregateType("github_observation").SetAggregateID(row.ID).SetPayload(map[string]any{"observationId": row.ID}).SetIdempotencyKey("github-observation:" + row.ID).Exec(ctx)
	}
	return legacy, false, err
}

// processGitHubObservation performs slow provider reads outside the acceptance
// transaction, then commits the decision, business event, run and outbox together.
func (c *Configuration) processGitHubObservation(ctx context.Context, org, id string) error {
	observation, err := c.client.GitHubObservation.Query().Where(githubobservation.ID(id), githubobservation.OrganizationID(org)).Only(ctx)
	if err != nil {
		return err
	}
	if observation.Status != "received" {
		return nil
	}
	var policy *ent.GitHubProductionPolicy
	if observation.PolicyID != nil {
		policy, err = c.client.GitHubProductionPolicy.Query().Where(githubproductionpolicy.ID(*observation.PolicyID), githubproductionpolicy.OrganizationID(org), githubproductionpolicy.SourceAppID(observation.SourceAppID)).Only(ctx)
		if err != nil {
			return err
		}
	}
	if policy == nil {
		return ErrInvalidInput
	}
	evidence := observation.Evidence
	// A job webhook references a run, not a workflow ID. Read the exact attempt;
	// never borrow the latest rerun, or search for a matching commit.
	var enrichmentFailure bool
	accessSource, accessErr := c.client.SourceApp.Get(ctx, observation.SourceAppID)
	accessValid := accessErr == nil && automationSourceAccess(ctx, c.client, accessSource) == nil
	var selectionFailure bool
	if accessValid && policy.Policy.Enabled && evidence.EventName == policy.Policy.Signal {
		if reader, ok := c.github.(GitHubProductionReader); ok {
			caps, readErr := reader.ProductionCapabilities(ctx, evidence.InstallationID, evidence.RepositoryID)
			if transientGitHubEvidenceError(readErr) {
				return c.retryProductionEvidence(ctx, observation)
			}
			selectionFailure = readErr != nil || !caps.SubscriptionsKnown || !slices.Contains(caps.Events, policy.Policy.Signal) || policy.Policy.Signal == "deployment_status" && !caps.Deployments || (policy.Policy.Signal != "deployment_status" || len(policy.Policy.Workflows) > 0) && !caps.Actions
			if len(policy.Policy.Workflows) > 0 {
				workflows, readErr := reader.Workflows(ctx, evidence.InstallationID, evidence.RepositoryID)
				if transientGitHubEvidenceError(readErr) {
					return c.retryProductionEvidence(ctx, observation)
				}
				selectionFailure = selectionFailure || readErr != nil
				for _, selected := range policy.Policy.Workflows {
					selectionFailure = selectionFailure || !slices.ContainsFunc(workflows, func(w automation.GitHubWorkflow) bool {
						return w.ID == selected.ID && w.Name == selected.Name && w.Path == selected.Path && w.State == "active"
					})
				}
			}
		} else {
			selectionFailure = true
		}
	}
	if accessValid && policy.Policy.Enabled && policy.Policy.Signal == "workflow_job" && evidence.EventName == "workflow_job" && evidence.RunAttempt > 0 {
		if reader, ok := c.github.(GitHubProductionReader); ok {
			enriched, readErr := reader.EnrichProductionEvidence(ctx, evidence)
			if transientGitHubEvidenceError(readErr) {
				return c.retryProductionEvidence(ctx, observation)
			}
			if readErr != nil {
				enrichmentFailure = true
			} else {
				evidence = enriched
			}
		} else {
			enrichmentFailure = true
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, org, observation.SourceAppID)
	if err != nil {
		return err
	}
	observation, err = tx.GitHubObservation.Get(ctx, id)
	if err != nil {
		return err
	}
	if observation.Status != "received" {
		return nil
	}
	decision := automation.EvaluateProduction(policy.Policy, evidence)
	attention := func(reason string) {
		decision.Status = "needs_attention"
		decision.Reason = reason
		decision.Checks = append(decision.Checks, automation.ProductionCheck{Condition: "execution", Status: "needs_attention", Reason: reason})
	}
	if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
		attention("Installation or repository access was revoked; reconnect and review this observation.")
	}
	if selectionFailure {
		attention("Repository permissions, event subscription, or selected workflow identity is unavailable or changed. Refresh the GitHub selection and review.")
	}
	if enrichmentFailure {
		attention("Actions evidence could not be read. Check Actions read permission, repository access, and GitHub availability.")
	}
	if policy.Policy.Enabled && observation.WorkflowVersionID == nil {
		attention("The selected Shots workflow had no active version when this event was received.")
	}
	if evidence.OccurredAt.IsZero() {
		attention("Provider occurrence time is missing.")
	}
	// Compare stored timestamps at PostgreSQL's precision and exclude this row;
	// nanosecond JSON timestamps can round upward on the relational projection.
	// Distinct states sharing a stored timestamp have no supported ordering.
	// Status IDs and arrival order cannot break that tie safely.
	occurred := evidence.OccurredAt
	if observation.OccurredAt != nil {
		occurred = *observation.OccurredAt
	}
	orderingConflict, err := tx.GitHubObservation.Query().Where(
		githubobservation.IDNEQ(observation.ID),
		githubobservation.OrganizationID(org),
		githubobservation.SourceAppID(source.ID),
		githubobservation.ObjectKey(evidence.ObjectKey),
		githubobservation.Or(
			githubobservation.OccurredAtGT(occurred),
			githubobservation.And(githubobservation.OccurredAtEQ(occurred), func(s *sql.Selector) {
				s.Where(sqljson.ValueNEQ(githubobservation.FieldEvidence, evidence.State, sqljson.Path("state")))
			}),
		),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if orderingConflict {
		attention("A newer or conflicting same-time observation of this operation is already known; this delayed or ambiguously ordered status cannot start automation.")
	}
	if decision.Status == "matched" && evidence.RunID > 0 && evidence.RunAttempt > 0 && evidence.Association != "" {
		// Policies choose one canonical signal. A policy edit can overlap an
		// already-qualified signal from the same provider run attempt. That is
		// evidence of possible overlap, not proof that two deployments are one.
		overlap, err := tx.GitHubObservation.Query().Where(githubobservation.OrganizationID(org), githubobservation.SourceAppID(source.ID), githubobservation.EventIDNotNil(), func(s *sql.Selector) {
			s.Where(sqljson.ValueEQ(githubobservation.FieldEvidence, evidence.RunID, sqljson.Path("runId")))
			s.Where(sqljson.ValueEQ(githubobservation.FieldEvidence, evidence.RunAttempt, sqljson.Path("runAttempt")))
			s.Where(sqljson.ValueNEQ(githubobservation.FieldEvidence, evidence.EventName, sqljson.Path("eventName")))
		}).Exist(ctx)
		if err != nil {
			return err
		}
		if overlap {
			attention("Another signal from this exact GitHub run attempt already qualified under an earlier policy. Review whether it represents the same deployment; no second workflow was started.")
		}
	}
	update := observation.Update().SetEnrichment(&evidence).SetDecision(decision).SetStatus(decision.Status).SetProcessedAt(time.Now())
	if observation.Origin != "live" {
		update.SetStatus("review_only")
	} else if decision.Status == "matched" {
		event := automation.ProductionEvent(evidence, policy.Policy)
		event.Production = &automation.ProductionQualification{ObservationID: observation.ID, PolicyID: policy.ID, PolicyRevision: policy.Revision, Strength: decision.Strength}
		if err := automation.ValidateEvent(event); err != nil {
			return err
		}
		keys := []string{event.SemanticKey}
		if evidence.EventName == "deployment_status" {
			keys = append(keys, evidence.ObjectKey+":success")
		}
		prior, err := tx.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(org), releasesourceevent.SourceAppID(source.ID), releasesourceevent.SemanticKeyIn(keys...)).First(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		captured := false
		if evidence.EventName == "deployment_status" {
			captured, err = tx.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(org), deploymentevent.SourceAppID(source.ID), deploymentevent.ExternalID(evidence.ObjectID)).Exist(ctx)
			if err != nil {
				return err
			}
		}
		if prior != nil {
			update.SetStatus("duplicate").SetEventID(prior.ID)
		} else if captured {
			decision.Reason = "Shots already recorded this deployment for a product capture. No new workflow started."
			update.SetStatus("duplicate").SetDecision(decision)
		} else {
			version, err := tx.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(*observation.WorkflowVersionID), releaseautomationversion.OrganizationID(org), releaseautomationversion.DefinitionID(policy.Policy.DefinitionID)).Only(ctx)
			if err != nil {
				return err
			}
			if version.Graph.Family != automation.Deployed {
				return ErrInvalidInput
			}
			eventID, runID := cuid.New(), cuid.New()
			if err := tx.ReleaseSourceEvent.Create().SetID(eventID).SetOrganizationID(org).SetSourceAppID(source.ID).SetSemanticKey(event.SemanticKey).SetDeliveryID(observation.DeliveryID).SetSnapshot(event).SetVersionIds([]string{version.ID}).SetMode("automation").SetDisposition("queued").SetReason("Production policy " + policy.ID + " matched; selected Shots workflow version pinned at receipt.").Exec(ctx); err != nil {
				return err
			}
			if err := tx.ReleaseAutomationRun.Create().SetID(runID).SetOrganizationID(org).SetEventID(eventID).SetWorkflowID("release-automation-" + runID).SetStatus("queued").SetReason(decision.Reason).Exec(ctx); err != nil {
				return err
			}
			if err := automationOutbox(ctx, tx, org, runID, EventReleaseAutomationDispatch, 0); err != nil {
				return err
			}
			update.SetEventID(eventID)
		}
	}
	if err := update.Exec(ctx); err != nil {
		return err
	}
	if err := appendConfigurationAudit(ctx, tx, Actor{OrganizationID: org, Kind: "service", Display: "github", RequestID: id}, "product.github_production_decided", "github_observation", id, map[string]any{"status": decision.Status, "policyId": policy.ID}); err != nil {
		return err
	}
	return tx.Commit()
}

type GitHubProductionReader interface {
	ProductionCapabilities(context.Context, int64, string) (githubapp.ProductionCapabilities, error)
	Workflows(context.Context, int64, string) ([]automation.GitHubWorkflow, error)
	WorkflowJobs(context.Context, int64, string, int64, int) ([]githubapp.WorkflowJob, error)
	EnrichProductionEvidence(context.Context, automation.GitHubEvidence) (automation.GitHubEvidence, error)
}

func transientGitHubEvidenceError(err error) bool {
	if err == nil || errors.Is(err, githubapp.ErrIncompleteEvidence) {
		return false
	}
	var status githubapp.StatusError
	if errors.As(err, &status) {
		return status.RateLimited || status.Status >= 500
	}
	return true
}

func (c *Configuration) retryProductionEvidence(ctx context.Context, observation *ent.GitHubObservation) error {
	work, err := c.client.OutboxEvent.Query().Where(outboxevent.OrganizationID(observation.OrganizationID), outboxevent.Type(EventGitHubObservation), outboxevent.AggregateID(observation.ID)).Only(ctx)
	if err != nil {
		return err
	}
	decision := automation.ProductionDecision{Status: "needs_attention", Reason: "GitHub is unavailable or rate limited right now. Shots will retry; no workflow has run.", Checks: []automation.ProductionCheck{}}
	update := c.client.GitHubObservation.Update().Where(githubobservation.ID(observation.ID), githubobservation.OrganizationID(observation.OrganizationID), githubobservation.Status("received")).SetDecision(decision)
	if work.Attempts >= 8 {
		decision.Reason = "GitHub stayed unavailable after eight tries. Check access and this event. No workflow ran."
		update.SetDecision(decision).SetStatus("needs_attention").SetProcessedAt(time.Now())
	}
	if err := update.Exec(ctx); err != nil {
		return err
	}
	if work.Attempts >= 8 {
		return nil
	}
	return errors.New("GitHub evidence unavailable; bounded retry pending")
}

type GitHubProductionCatalog struct {
	Access         string                            `json:"access"`
	Reason         string                            `json:"reason"`
	InstallationID int64                             `json:"installationId"`
	RepositoryID   string                            `json:"repositoryId"`
	Capabilities   *githubapp.ProductionCapabilities `json:"capabilities"`
	Workflows      []automation.GitHubWorkflow       `json:"workflows"`
	Jobs           []githubapp.WorkflowJob           `json:"jobs"`
}

func (c *Configuration) GitHubProductionCatalog(ctx context.Context, actor Actor, sourceID string, runID int64, attempt int) (*GitHubProductionCatalog, error) {
	source, err := c.productionSource(ctx, actor, sourceID)
	if err != nil {
		return nil, err
	}
	result := &GitHubProductionCatalog{Access: "unavailable", Workflows: []automation.GitHubWorkflow{}, Jobs: []githubapp.WorkflowJob{}}
	if err := automationSourceAccess(ctx, c.client, source); err != nil {
		result.Reason = "The Shots GitHub App is suspended or disconnected, or the repository was removed."
		return result, nil
	}
	installation, err := c.client.GitHubInstallation.Query().Where(githubinstallation.ID(*source.GithubInstallationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	result.InstallationID, result.RepositoryID = installation.InstallationID, *source.ExternalID
	reader, ok := c.github.(GitHubProductionReader)
	if !ok {
		result.Reason = "This server has no GitHub App configured."
		return result, nil
	}
	caps, err := reader.ProductionCapabilities(ctx, installation.InstallationID, *source.ExternalID)
	if err != nil {
		result.Reason = "Shots could not read what it can access in this repository. Check access and try again."
		return result, nil
	}
	result.Capabilities = &caps
	result.Access = "active"
	if caps.Actions {
		result.Workflows, err = reader.Workflows(ctx, installation.InstallationID, *source.ExternalID)
		if err != nil {
			result.Access = "needs_attention"
			result.Reason = "Workflow list is incomplete or unavailable; check Actions read permission and retry."
		}
	}
	if runID > 0 && attempt > 0 && caps.Actions {
		result.Jobs, err = reader.WorkflowJobs(ctx, installation.InstallationID, *source.ExternalID, runID, attempt)
		if err != nil {
			result.Access = "needs_attention"
			result.Reason = "Job list for this run attempt is incomplete or unavailable."
		}
	}
	return result, nil
}

func (c *Configuration) githubDeliveryOrigin(ctx context.Context, delivery string) (string, error) {
	recovered, err := c.client.GitHubDeliveryRecovery.Query().Where(githubdeliveryrecovery.GUID(delivery), githubdeliveryrecovery.Recovery(true)).Exist(ctx)
	if err != nil {
		return "", err
	}
	if recovered {
		return "recovery", nil
	}
	return "live", nil
}
