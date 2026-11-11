package product

import (
	"context"
	"encoding/json"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendactivation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendobservation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/frontendsource"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	fd "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/frontenddeploy"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	ra "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/lucsky/cuid"
)

type FrontendSourceInput struct {
	GitHubSourceID string    `json:"githubSourceId"`
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Revision       int       `json:"revision"`
	Provider       string    `json:"provider"`
	AccountID      string    `json:"accountId"`
	ProjectID      string    `json:"projectId"`
	Token          string    `json:"token"`
	Secret         string    `json:"secret"`
	Enabled        bool      `json:"enabled"`
	Policy         fd.Policy `json:"policy"`
}
type FrontendSourceRecord struct {
	GitHubSourceID string     `json:"githubSourceId"`
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Provider       string     `json:"provider"`
	AccountID      string     `json:"accountId"`
	ProjectID      string     `json:"projectId"`
	Revision       int        `json:"revision"`
	Enabled        bool       `json:"enabled"`
	Policy         fd.Policy  `json:"policy"`
	HasToken       bool       `json:"hasToken"`
	HasSecret      bool       `json:"hasSecret"`
	BaselineAt     time.Time  `json:"baselineAt"`
	EffectiveAt    time.Time  `json:"effectiveAt"`
	LastPollAt     *time.Time `json:"lastPollAt"`
	Health         string     `json:"health"`
}
type FrontendActivationEvidence struct {
	Observation fd.Observation `json:"observation"`
	Decision    fd.Decision    `json:"decision"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}
type FrontendEvidenceRecord struct {
	Current       *FrontendActivationEvidence `json:"current"`
	ID            string                      `json:"id"`
	SourceID      string                      `json:"sourceId"`
	PolicyVersion int                         `json:"policyVersion"`
	Policy        fd.Policy                   `json:"policy"`
	Observation   fd.Observation              `json:"observation"`
	Decision      fd.Decision                 `json:"decision"`
	Historical    bool                        `json:"historical"`
	ReceivedAt    time.Time                   `json:"receivedAt"`
	ProcessedAt   time.Time                   `json:"processedAt"`
}

func frontendRecord(s *ent.FrontendSource, name string) FrontendSourceRecord {
	return FrontendSourceRecord{GitHubSourceID: s.GithubSourceID, ID: s.ID, Name: name, Provider: s.Provider, AccountID: s.AccountID, ProjectID: s.ProjectID, Revision: s.Revision, Enabled: s.Enabled, Policy: s.Policy, HasToken: s.EncryptedToken != "", HasSecret: s.EncryptedSecret != "", BaselineAt: s.BaselineAt, EffectiveAt: s.EffectiveAt, LastPollAt: s.LastPollAt, Health: s.Health}
}

func (c *Configuration) FrontendSources(ctx context.Context, actor Actor) ([]FrontendSourceRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.FrontendSource.Query().Where(frontendsource.OrganizationID(actor.OrganizationID)).Order(ent.Asc(frontendsource.FieldID)).Limit(100).All(ctx)
	if err != nil {
		return nil, err
	}
	out := []FrontendSourceRecord{}
	for _, s := range rows {
		src, err := c.client.SourceApp.Query().Where(sourceapp.ID(s.ID), sourceapp.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		out = append(out, frontendRecord(s, src.Name))
	}
	return out, nil
}

func (c *Configuration) SaveFrontendSource(ctx context.Context, actor Actor, in FrontendSourceInput) (*FrontendSourceRecord, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if fd.ValidatePolicy(in.Policy) != nil || !slices.Contains([]string{"github", "vercel", "netlify", "cloudflare_pages", "cloudflare_workers"}, in.Provider) || in.Name == "" || len(in.Name) > 160 || in.AccountID == "" || in.ProjectID == "" || len(in.AccountID) > 100 || len(in.ProjectID) > 200 || len(in.Token) > 8000 || len(in.Secret) > 8000 || strings.ContainsAny(in.AccountID+in.ProjectID, "/\\?#\r\n") {
		return nil, ErrInvalidInput
	}
	if in.ID == "" {
		if in.Provider == "github" {
			return nil, invalid("Choose a connected GitHub repository.")
		}
		if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "source-app:create"); err != nil {
			return nil, err
		}
	}
	token, secret := "", ""
	var err error
	if in.Token != "" {
		token, err = webhooks.Seal(c.webhookKey, in.Token)
		if err != nil {
			return nil, err
		}
	}
	if in.Secret != "" {
		if len(in.Secret) < 16 {
			return nil, invalid("Use a webhook secret of at least 16 characters.")
		}
		secret, err = webhooks.Seal(c.webhookKey, in.Secret)
		if err != nil {
			return nil, err
		}
	}
	if in.Token != "" {
		if err := (fd.Client{HTTP: c.frontendHTTP}).Verify(ctx, in.Provider, in.AccountID, in.ProjectID, in.Token); err != nil {
			return nil, invalid("Provider project access could not be verified; check the account, project and read permissions.")
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var source *ent.SourceApp
	if in.ID == "" {
		source, err = tx.SourceApp.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(in.Name).SetProvider(in.Provider).SetExternalID(in.ProjectID).SetAllowedHosts([]string{}).SetPlatformOwnerUserID(actor.UserID).SetStatus(sourceapp.StatusACTIVE).Save(ctx)
	} else {
		source, err = lockAutomationSource(ctx, tx, actor.OrganizationID, in.ID)
	}
	if err != nil {
		return nil, err
	}
	if source.Status != sourceapp.StatusACTIVE {
		return nil, publishing.ErrNotFound
	}
	if in.Provider == "github" {
		if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
			return nil, err
		}
		install, err := tx.GitHubInstallation.Get(ctx, *source.GithubInstallationID)
		if err != nil {
			return nil, err
		}
		if in.ProjectID != *source.ExternalID || in.AccountID != strconv.FormatInt(install.InstallationID, 10) {
			return nil, publishing.ErrForbidden
		}
	}
	linked := source
	if in.GitHubSourceID != "" {
		linked, err = tx.SourceApp.Query().Where(sourceapp.ID(in.GitHubSourceID), sourceapp.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, publishing.ErrNotFound
		}
		if err := automationSourceAccess(ctx, tx.Client(), linked); err != nil {
			return nil, err
		}
	} else if source.Provider == "github" {
		in.GitHubSourceID = source.ID
	}
	if in.Provider == "github" && in.GitHubSourceID != source.ID {
		return nil, ErrInvalidInput
	}
	if in.Policy.WorkflowVersionID != "" {
		v, err := tx.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(in.Policy.WorkflowVersionID), releaseautomationversion.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, publishing.ErrNotFound
		}
		d, err := tx.ReleaseAutomation.Query().Where(releaseautomation.ID(v.DefinitionID), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.SourceAppID(linked.ID), releaseautomation.Archived(false)).Only(ctx)
		if err != nil || d == nil || v.Graph.Family != ra.Deployed {
			return nil, invalid("Choose a deployment workflow version belonging to this source.")
		}
		if err := automationSourceAccess(ctx, tx.Client(), linked); err != nil {
			return nil, err
		}
	}
	prior, err := tx.FrontendSource.Query().Where(frontendsource.ID(source.ID), frontendsource.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	now := time.Now().UTC()
	var saved *ent.FrontendSource
	if prior == nil {
		if in.Revision != 0 {
			return nil, publishing.ErrConflict
		}
		if in.Provider != "github" && token == "" {
			return nil, invalid("A read-only provider token is required for verification and recovery.")
		}
		if (in.Provider == "vercel" || in.Provider == "netlify") && secret == "" {
			return nil, invalid("Configure the provider webhook signing secret.")
		}
		saved, err = tx.FrontendSource.Create().SetID(source.ID).SetOrganizationID(actor.OrganizationID).SetGithubSourceID(in.GitHubSourceID).SetProvider(in.Provider).SetAccountID(in.AccountID).SetProjectID(in.ProjectID).SetPolicy(in.Policy).SetEnabled(in.Enabled).SetEncryptedToken(token).SetEncryptedSecret(secret).SetBaselineAt(now).SetEffectiveAt(now).Save(ctx)
	} else {
		if in.Revision != prior.Revision {
			return nil, publishing.ErrConflict
		}
		if in.GitHubSourceID != prior.GithubSourceID || in.Provider != prior.Provider || in.AccountID != prior.AccountID || in.ProjectID != prior.ProjectID {
			return nil, invalid("Connect a new source to change the provider project identity.")
		}
		u := prior.Update().SetPolicy(in.Policy).SetRevision(prior.Revision + 1).SetEnabled(in.Enabled).SetEffectiveAt(now).SetUpdatedAt(now)
		if token != "" {
			u.SetEncryptedToken(token)
		}
		if secret != "" {
			u.SetEncryptedSecret(secret)
		}
		saved, err = u.Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.SourceApp.UpdateOne(source).SetName(in.Name).Exec(ctx); err != nil {
		return nil, err
	}
	source.Name = in.Name
	if err := appendConfigurationAudit(ctx, tx, actor, "product.frontend_policy_saved", "frontend_source", source.ID, map[string]any{"version": saved.Revision, "policy": in.Policy, "enabled": in.Enabled}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	r := frontendRecord(saved, source.Name)
	return &r, nil
}

func (c *Configuration) FrontendHistory(ctx context.Context, actor Actor, sourceID string) ([]FrontendEvidenceRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	exists, err := c.client.FrontendSource.Query().Where(frontendsource.ID(sourceID), frontendsource.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, publishing.ErrNotFound
	}
	rows, err := c.client.FrontendObservation.Query().Where(frontendobservation.OrganizationID(actor.OrganizationID), frontendobservation.SourceID(sourceID)).Order(ent.Desc(frontendobservation.FieldReceivedAt), ent.Desc(frontendobservation.FieldID)).Limit(100).All(ctx)
	if err != nil {
		return nil, err
	}
	keys := []string{}
	for _, r := range rows {
		if key := frontendActivationKey(r.Snapshot); key != "" {
			keys = append(keys, key)
		}
	}
	current := map[string]*FrontendActivationEvidence{}
	if len(keys) > 0 {
		activations, e := c.client.FrontendActivation.Query().Where(frontendactivation.OrganizationID(actor.OrganizationID), frontendactivation.SourceID(sourceID), frontendactivation.ActivationKeyIn(keys...)).All(ctx)
		if e != nil {
			return nil, e
		}
		for _, a := range activations {
			current[a.ActivationKey] = &FrontendActivationEvidence{Observation: a.Snapshot, Decision: a.Decision, UpdatedAt: a.UpdatedAt}
		}
	}
	out := []FrontendEvidenceRecord{}
	for _, r := range rows {
		out = append(out, FrontendEvidenceRecord{Current: current[frontendActivationKey(r.Snapshot)], ID: r.ID, SourceID: r.SourceID, PolicyVersion: r.PolicyVersion, Policy: r.Policy, Observation: r.Snapshot, Decision: r.Decision, Historical: r.Historical, ReceivedAt: r.ReceivedAt, ProcessedAt: r.ProcessedAt})
	}
	return out, nil
}

// AcceptFrontendWebhook authenticates before parsing, then commits evidence and
// alert/workflow intents before acknowledging. Secrets never reach the facade.
func (c *Configuration) AcceptFrontendWebhook(ctx context.Context, id, signature string, body []byte) error {
	s, err := c.client.FrontendSource.Get(ctx, id)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	secret, err := webhooks.Open(c.webhookKey, s.EncryptedSecret)
	if err != nil {
		return err
	}
	if !fd.VerifyWebhook(s.Provider, secret, signature, body) {
		return publishing.ErrUnauthorized
	}
	o, err := fd.NormalizeWebhook(s.Provider, body)
	if err != nil {
		return ErrInvalidInput
	}
	if o.ProjectID != s.ProjectID || o.AccountID != "" && o.AccountID != s.AccountID {
		return publishing.ErrForbidden
	}
	return c.acceptFrontendObservation(ctx, s.OrganizationID, s.ID, o, false)
}

func (c *Configuration) acceptFrontendObservation(ctx context.Context, org, id string, o fd.Observation, historical bool) error {
	for attempt := 0; attempt < 3; attempt++ {
		err := c.frontendObservationTx(ctx, org, id, o, historical)
		if ent.IsConstraintError(err) {
			continue
		}
		return err
	}
	return publishing.ErrConflict
}

func (c *Configuration) frontendObservationTx(ctx context.Context, org, id string, o fd.Observation, historical bool) error {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.FrontendSource.Update().Where(frontendsource.ID(id), frontendsource.OrganizationID(org)).AddRevision(0).Save(ctx)
	if err != nil {
		return err
	}
	s, err := tx.FrontendSource.Query().Where(frontendsource.ID(id), frontendsource.OrganizationID(org)).Only(ctx)
	if err != nil {
		return err
	}
	src, err := tx.SourceApp.Query().Where(sourceapp.ID(id), sourceapp.OrganizationID(org), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Only(ctx)
	if err != nil {
		return err
	}
	if err := c.authorizeRoles(ctx, Actor{OrganizationID: org, Kind: "service"}); err != nil {
		return err
	}
	if o.Provider == "github" {
		if s.GithubSourceID != "" && s.GithubSourceID != src.ID {
			src, err = tx.SourceApp.Query().Where(sourceapp.ID(s.GithubSourceID), sourceapp.OrganizationID(org)).Only(ctx)
			if err != nil {
				return err
			}
		}
		if err := automationSourceAccess(ctx, tx.Client(), src); err != nil {
			return err
		}
	}
	// A workflow linked to a repository must not consume a different repository's
	// deployment merely because both projects are configured in one workspace.
	expectedRepository, linkProblem := "", ""
	if s.GithubSourceID != "" {
		linked, e := tx.SourceApp.Query().Where(sourceapp.ID(s.GithubSourceID), sourceapp.OrganizationID(org)).Only(ctx)
		if e != nil && !ent.IsNotFound(e) {
			return e
		}
		if linked == nil || automationSourceAccess(ctx, tx.Client(), linked) != nil {
			linkProblem = "The linked GitHub source is unavailable; reconnect it before qualifying this deployment."
		} else if linked.ExternalID != nil {
			expectedRepository = *linked.ExternalID
		}
	}
	evaluate := func(p fd.Policy, event fd.Observation) fd.Decision {
		d := fd.Evaluate(p, event, time.Now().UTC())
		if event.Provider != s.Provider || d.State == "not_matched" || d.State == "failed" {
			return d
		}
		reason := linkProblem
		if expectedRepository != "" && event.RepositoryID != "" && event.RepositoryID != expectedRepository {
			reason = "Provider repository evidence conflicts with the linked GitHub source."
		}
		if p.WorkflowVersionID != "" && (event.RepositoryID == "" || event.RepositoryID != expectedRepository) {
			reason = "The selected Shots workflow requires deployment evidence tied to its GitHub repository."
		}
		if reason != "" {
			d.State = "needs_attention"
			d.Reason = reason
		}
		return d
	}
	seen, err := tx.FrontendObservation.Query().Where(frontendobservation.SourceID(id), frontendobservation.OrganizationID(org), frontendobservation.EventKey(o.Key)).Exist(ctx)
	if err != nil {
		return err
	}
	if seen {
		return nil
	}
	now := time.Now().UTC()
	eventTime := o.OccurredAt
	if o.ActivationObservedAt != nil {
		eventTime = *o.ActivationObservedAt
	}
	historical = historical || !s.Enabled || !eventTime.After(s.EffectiveAt) || eventTime.After(now.Add(5*time.Minute))
	incomingHistorical := historical
	// A successful staging/preview activation does not supersede production,
	// including when production is still waiting on its required checks.
	if !eventTime.After(now.Add(5*time.Minute)) && o.Provider == s.Provider && o.Environment != "" && slices.Contains(s.Policy.Environments, o.Environment) && (o.Production == "active" || s.Provider == "cloudflare_workers" && o.Production == "pending" && o.ActivationID != "") {
		previous, _ := time.Parse(time.RFC3339Nano, s.Checkpoint["latestActivationAt"])
		if eventTime.After(previous) {
			s.Checkpoint["latestActivationAt"] = eventTime.Format(time.RFC3339Nano)
			if err := s.Update().SetCheckpoint(s.Checkpoint).Exec(ctx); err != nil {
				return err
			}
		}
	}
	policy, version := s.Policy, s.Revision
	decision := evaluate(policy, o)
	if o.Provider != s.Provider {
		decision = fd.Decision{State: "not_matched", Reason: "Related GitHub observation; the configured hosting provider is authoritative for activation.", Checks: "not_configured"}
	}
	if o.DeploymentID != "" && o.Provider == s.Provider {
		key := frontendActivationKey(o)
		a, err := tx.FrontendActivation.Query().Where(frontendactivation.SourceID(id), frontendactivation.OrganizationID(org), frontendactivation.ActivationKey(key)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return err
		}
		if a != nil {
			policy, version, historical = a.Policy, a.PolicyVersion, historical || a.Historical
			if incomingHistorical && !a.Historical {
				// Keep recovered evidence in the immutable receipt; it cannot
				// replace live state or lend checks to a later live observation.
				decision = evaluate(policy, o)
			} else if o.OccurredAt.Before(a.Snapshot.OccurredAt) {
				decision = fd.Decision{State: "not_matched", Reason: "Out-of-order evidence retained; a newer observation already determines this activation."}
			} else {
				o.Checks = mergeFrontendChecks(a.Snapshot.Checks, frontendRelevantChecks(policy, o, o.Checks))
				decision = evaluate(policy, o)
				a, err = a.Update().SetSnapshot(o).SetCommitSha(o.Revision).SetDecision(decision).SetUpdatedAt(now).Save(ctx)
			}
		} else {
			// Prior check observations can arrive before a promotion; use only the
			// exact repository/revision or deployment identity in the evaluator.
			rows, e := tx.FrontendObservation.Query().Where(frontendobservation.OrganizationID(org), frontendobservation.SourceID(id), frontendobservation.Historical(false)).Order(ent.Desc(frontendobservation.FieldReceivedAt)).Limit(500).All(ctx)
			if e != nil {
				return e
			}
			for _, r := range rows {
				o.Checks = mergeFrontendChecks(frontendRelevantChecks(policy, o, o.Checks), frontendRelevantChecks(policy, o, r.Snapshot.Checks))
			}
			decision = evaluate(policy, o)
			a, err = tx.FrontendActivation.Create().SetID(cuid.New()).SetOrganizationID(org).SetSourceID(id).SetActivationKey(key).SetCommitSha(o.Revision).SetSnapshot(o).SetPolicy(policy).SetPolicyVersion(version).SetDecision(decision).SetHistorical(historical).Save(ctx)
		}
		if err != nil {
			return err
		}
		if !historical && !o.OccurredAt.Before(a.Snapshot.OccurredAt) {
			if err := c.emitFrontendDecision(ctx, tx, s, a); err != nil {
				return err
			}
		}
	}
	// Later checks reevaluate only this source's exact revision or deployment.
	if len(o.Checks) > 0 {
		targets := []predicate.FrontendActivation{}
		for _, check := range o.Checks {
			if check.Revision != "" && check.RepositoryID != "" {
				targets = append(targets, frontendactivation.And(frontendactivation.CommitSha(check.Revision), func(s *sql.Selector) {
					s.Where(sqljson.ValueEQ(frontendactivation.FieldSnapshot, check.RepositoryID, sqljson.Path("repositoryId")))
				}))
			}
			if check.DeploymentID != "" {
				targets = append(targets, func(s *sql.Selector) {
					s.Where(sqljson.ValueEQ(frontendactivation.FieldSnapshot, check.DeploymentID, sqljson.Path("deploymentId")))
				})
			}
		}
		cursor := ""
		for len(targets) > 0 {
			activations, err := tx.FrontendActivation.Query().Where(frontendactivation.OrganizationID(org), frontendactivation.SourceID(id), frontendactivation.IDGT(cursor), frontendactivation.Or(targets...)).Order(ent.Asc(frontendactivation.FieldID)).Limit(100).All(ctx)
			if err != nil {
				return err
			}
			for _, a := range activations {
				if historical && !a.Historical {
					continue
				}
				snapshot := a.Snapshot
				checks := []fd.Check{}
				for _, check := range o.Checks {
					if check.Revision != "" && check.Revision == snapshot.Revision && check.RepositoryID == snapshot.RepositoryID || check.DeploymentID != "" && check.DeploymentID == snapshot.DeploymentID {
						checks = append(checks, check)
					}
				}
				if len(checks) == 0 {
					continue
				}
				snapshot.Checks = mergeFrontendChecks(snapshot.Checks, frontendRelevantChecks(a.Policy, snapshot, checks))
				d := evaluate(a.Policy, snapshot)
				a, err = a.Update().SetSnapshot(snapshot).SetDecision(d).SetUpdatedAt(now).Save(ctx)
				if err != nil {
					return err
				}
				if err := c.emitFrontendDecision(ctx, tx, s, a); err != nil {
					return err
				}
				decision = d
			}
			if len(activations) < 100 {
				break
			}
			cursor = activations[len(activations)-1].ID
		}
	}
	if _, err = tx.FrontendObservation.Create().SetID(cuid.New()).SetOrganizationID(org).SetSourceID(id).SetEventKey(o.Key).SetSnapshot(o).SetPolicy(policy).SetPolicyVersion(version).SetDecision(decision).SetHistorical(historical).SetOccurredAt(o.OccurredAt).SetReceivedAt(now).SetProcessedAt(now).Save(ctx); err != nil {
		return err
	}
	return tx.Commit()
}

func frontendActivationKey(o fd.Observation) string {
	if o.DeploymentID == "" {
		return ""
	}
	identity := o.ActivationID
	if identity == "" {
		identity = o.ActivationKey
	}
	if identity == "" {
		identity = "unconfirmed"
	}
	return o.Provider + ":" + o.DeploymentID + ":" + identity
}

func frontendRelevantChecks(p fd.Policy, o fd.Observation, checks []fd.Check) []fd.Check {
	out := []fd.Check{}
	for _, check := range checks {
		for _, rule := range p.Checks {
			if rule.Name != check.Name || rule.Source != check.Source || rule.AppID != check.AppID {
				continue
			}
			if rule.Scope == "deployment" && check.DeploymentID != "" && check.DeploymentID == o.DeploymentID || rule.Scope == "commit" && o.RepositoryID != "" && check.RepositoryID == o.RepositoryID && check.Revision != "" && check.Revision == o.Revision {
				out = append(out, check)
				break
			}
		}
	}
	return out
}

// Keep conflicting results at the newest timestamp. Arrival order must never
// turn two contradictory conclusions into a passing check.
func mergeFrontendChecks(old, added []fd.Check) []fd.Check {
	all := append(append([]fd.Check{}, old...), added...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].OccurredAt.After(all[j].OccurredAt) })
	out := []fd.Check{}
	for _, c := range all {
		keep := true
		for _, p := range out {
			if p.Source == c.Source && p.Name == c.Name && p.AppID == c.AppID && p.RepositoryID == c.RepositoryID && p.Revision == c.Revision && p.DeploymentID == c.DeploymentID {
				if p.OccurredAt.After(c.OccurredAt) || (p.Status == c.Status && p.Conclusion == c.Conclusion) {
					keep = false
					break
				}
			}
		}
		if keep {
			out = append(out, c)
		}
	}
	// Provider payloads and API pages are bounded upstream; retain conflicting
	// evidence even when it crosses the usual result count.
	return out
}

func (c *Configuration) emitFrontendDecision(ctx context.Context, tx *ent.Tx, s *ent.FrontendSource, a *ent.FrontendActivation) error {
	if !s.Enabled || a.Historical {
		return nil
	}
	// Delayed checks or webhook delivery cannot announce an activation already
	// superseded for this frontend. Separate projects have separate source locks.
	if frontendActivationSuperseded(s, a) {
		return nil
	}
	d := a.Decision
	kind := "frontend." + d.State
	if d.State == "matched" {
		kind = "frontend.succeeded"
		if d.Checks == "passed" {
			kind = "frontend.checks_passed"
		}
	}
	wanted := slices.Contains(a.Policy.Alerts, d.State)
	if a.Snapshot.Rollback && slices.Contains(a.Policy.Alerts, "rollback") {
		wanted = true
		kind = "frontend.rollback"
	}
	if wanted {
		if err := activity.Emit(ctx, tx, s.OrganizationID, kind, "frontend_activation", a.ID, "", a.ID, nil); err != nil {
			return err
		}
	}
	if d.State == "matched" && a.Policy.WorkflowVersionID != "" {
		return c.frontendWorkflow(ctx, tx, s, a)
	}
	return nil
}

func frontendActivationTime(o fd.Observation) time.Time {
	if o.ActivationObservedAt != nil {
		return *o.ActivationObservedAt
	}
	return o.OccurredAt
}

func frontendActivationSuperseded(s *ent.FrontendSource, a *ent.FrontendActivation) bool {
	newest, _ := time.Parse(time.RFC3339Nano, s.Checkpoint["latestActivationAt"])
	return a.Snapshot.Production == "active" && newest.After(frontendActivationTime(a.Snapshot))
}

func (c *Configuration) frontendWorkflow(ctx context.Context, tx *ent.Tx, s *ent.FrontendSource, a *ent.FrontendActivation) error {
	// A policy chooses an immutable existing workflow. Normal interpreter guards,
	// cancellation, approval and generation budgets remain in force.
	v, err := tx.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(a.Policy.WorkflowVersionID), releaseautomationversion.OrganizationID(s.OrganizationID)).Only(ctx)
	if err != nil {
		return err
	}
	d, err := tx.ReleaseAutomation.Query().Where(releaseautomation.ID(v.DefinitionID), releaseautomation.OrganizationID(s.OrganizationID), releaseautomation.SourceAppID(frontendGitHubSourceID(s))).Only(ctx)
	if err != nil {
		return err
	}
	if d.Archived || !d.Enabled {
		return nil
	}
	e := frontendWorkflowEvent(a)
	// Stable IDs and unique event keys make a crash/retry reuse the same run.
	eventID, runID := "frontend-event-"+a.ID, "frontend-run-"+a.ID
	exists, err := tx.ReleaseSourceEvent.Query().Where(releasesourceevent.ID(eventID), releasesourceevent.OrganizationID(s.OrganizationID)).Exist(ctx)
	if err != nil || exists {
		return err
	}
	if _, err := tx.ReleaseSourceEvent.Create().SetID(eventID).SetOrganizationID(s.OrganizationID).SetSourceAppID(frontendGitHubSourceID(s)).SetSemanticKey(e.SemanticKey).SetDeliveryID(a.Snapshot.ProviderEventID).SetSnapshot(e).SetVersionIds([]string{v.ID}).SetMode("automation").SetDisposition("queued").SetReason(a.Decision.Reason).Save(ctx); err != nil {
		return err
	}
	if _, err := tx.ReleaseAutomationRun.Create().SetID(runID).SetOrganizationID(s.OrganizationID).SetEventID(eventID).SetWorkflowID("release-automation-" + runID).Save(ctx); err != nil {
		return err
	}
	return automationOutbox(ctx, tx, s.OrganizationID, runID, EventReleaseAutomationDispatch, 0)
}

// frontendWorkflowEvent sets the repository and action fields that
// NormalizeGitHub and ProductionEvent set for a successful deployment: workflow
// conditions read only Fields, and an absent field selects no branch. It occurs
// when it went live: a restored older deployment keeps its artifact's own time,
// and only the activation time tells the rollback from a redelivery.
func frontendWorkflowEvent(a *ent.FrontendActivation) ra.Event {
	return ra.Event{Family: ra.Deployed, SemanticKey: "frontend:" + a.ID, RepositoryID: a.Snapshot.RepositoryID, ObjectID: a.Snapshot.DeploymentID, OccurredAt: frontendActivationTime(a.Snapshot), Origin: "live", Title: "Production deployment reported successful", Notes: a.Decision.Reason, URL: a.Snapshot.URL, Fields: map[string]ra.Value{"repository.id": ra.StringValue(a.Snapshot.RepositoryID), "deployment.environment": ra.StringValue(a.Snapshot.Environment), "deployment.state": ra.StringValue("success"), "deployment.production": ra.BoolValue(true), "deployment.sha": ra.StringValue(a.Snapshot.Revision), "event.family": ra.StringValue(string(ra.Deployed)), "event.action": ra.StringValue("success")}}
}

// acceptGitHubFrontend observes the same authenticated envelope for each opted-in
// source. Other GitHub families continue through the existing release pipeline.
func (c *Configuration) acceptGitHubFrontend(ctx context.Context, in AcceptGitHubEventInput) (GitHubEventAcceptance, error) {
	result := GitHubEventAcceptance{}
	if !slices.Contains([]string{"deployment_status", "workflow_run", "workflow_job", "check_run", "status"}, in.EventName) {
		return result, nil
	}
	var header struct {
		Installation struct {
			ID int64 `json:"id"`
		} `json:"installation"`
		Repository struct {
			ID json.Number `json:"id"`
		} `json:"repository"`
	}
	if len(in.Body) > ra.MaxGitHubPayloadBytes || json.Unmarshal(in.Body, &header) != nil {
		return result, ErrInvalidInput
	}
	sources, err := c.GitHubSources(ctx, header.Installation.ID, header.Repository.ID.String())
	if err != nil {
		return result, err
	}
	origin, err := c.githubDeliveryOrigin(ctx, in.DeliveryID)
	if err != nil {
		return result, err
	}
	for _, source := range sources {
		linked, err := c.client.FrontendSource.Query().Where(frontendsource.OrganizationID(source.OrganizationID), frontendsource.Or(frontendsource.ID(source.ID), frontendsource.GithubSourceID(source.ID))).All(ctx)
		if err != nil {
			return result, err
		}
		if len(linked) == 0 {
			continue
		}
		o, err := fd.NormalizeGitHub(in.EventName, in.DeliveryID, in.Body)
		if err != nil {
			return result, ErrInvalidInput
		}
		for _, frontend := range linked {
			seen, e := c.client.FrontendObservation.Query().Where(frontendobservation.OrganizationID(source.OrganizationID), frontendobservation.SourceID(frontend.ID), frontendobservation.EventKey(o.Key)).Exist(ctx)
			if e != nil {
				return result, e
			}
			if err := c.acceptFrontendObservation(ctx, source.OrganizationID, frontend.ID, o, origin != "live"); err != nil {
				return result, err
			}
			if seen {
				result.Duplicates++
			} else {
				result.Handled++
			}
		}
	}
	return result, nil
}

func frontendGitHubSourceID(s *ent.FrontendSource) string {
	if s.GithubSourceID != "" {
		return s.GithubSourceID
	}
	return s.ID
}
