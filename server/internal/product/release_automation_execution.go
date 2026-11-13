package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationnode"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
	"github.com/lucsky/cuid"
)

type AutomationPlan struct {
	DefinitionID string           `json:"definitionId"`
	VersionID    string           `json:"versionId"`
	Graph        automation.Graph `json:"graph"`
}
type AutomationRunInput struct {
	CollectUnmatched  bool             `json:"collectUnmatched"`
	Event             automation.Event `json:"event"`
	Mode              string           `json:"mode"`
	Plans             []AutomationPlan `json:"plans"`
	SelectedVersionID *string          `json:"selectedVersionId"`
}

// LoadReleaseAutomation is an activity input snapshot, not a workflow-side DB read.
func (c *Configuration) LoadReleaseAutomation(ctx context.Context, org, id string, attempt int) (*AutomationRunInput, error) {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return nil, err
	}
	if run.RecoveryAttempt != attempt {
		return nil, ErrAutomationStopped
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		return nil, err
	}
	input := &AutomationRunInput{Event: event.Snapshot, Mode: event.Mode, Plans: []AutomationPlan{}, SelectedVersionID: run.VersionID, CollectUnmatched: event.CollectUnmatched}
	for field, value := range event.Enrichment {
		input.Event.Fields[field] = value
	}
	for _, versionID := range event.VersionIds {
		if run.VersionID != nil && *run.VersionID != versionID {
			continue
		}
		version, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(versionID), releaseautomationversion.OrganizationID(org)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if len(automation.Validate(version.Graph)) > 0 || automation.ContentHash(version.Graph) != version.ContentHash {
			return nil, ErrInvalidInput
		}
		input.Plans = append(input.Plans, AutomationPlan{DefinitionID: version.DefinitionID, VersionID: version.ID, Graph: version.Graph})
	}
	n, err := c.client.ReleaseAutomationRun.Update().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(org), releaseautomationrun.CancelRequested(false), releaseautomationrun.RecoveryAttempt(attempt), releaseautomationrun.StatusIn("queued", "running")).SetStatus("running").SetStartedAt(time.Now()).Save(ctx)
	if err == nil && n != 1 {
		err = ErrAutomationStopped
	}
	return input, err
}

// EnrichReleaseAutomation records bounded GitHub evidence once. Activity retry
// can repeat the read before its commit, but can never reinterpret absence as [].
func (c *Configuration) EnrichReleaseAutomation(ctx context.Context, org, id string, attempt int) (automation.Event, error) {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return automation.Event{}, err
	}
	source, err := c.automationCheckpoint(ctx, run, event)
	if err != nil {
		return automation.Event{}, err
	}
	snapshot := event.Snapshot
	for field, value := range event.Enrichment {
		snapshot.Fields[field] = value
	}
	if snapshot.Family != automation.Merged || snapshot.Fields["pr.files"].State == "available" {
		return snapshot, nil
	}
	reader, installation, err := c.readerFor(ctx, source)
	if err != nil {
		return automation.Event{}, err
	}
	if reader == nil {
		return automation.Event{}, ErrGitHubUnavailable
	}
	files, err := reader.PullRequestFiles(ctx, installation, snapshot.RepositoryID, snapshot.Number)
	if err != nil {
		return automation.Event{}, err
	}
	if len(files) > 3000 {
		return automation.Event{}, ErrInvalidInput
	}
	snapshot.Fields["pr.files"] = automation.StringValue(files...)
	if err := automation.ValidateEvent(snapshot); err != nil {
		return automation.Event{}, ErrInvalidInput
	}
	if err := c.client.ReleaseSourceEvent.UpdateOneID(event.ID).SetEnrichment(map[string]automation.Value{"pr.files": snapshot.Fields["pr.files"]}).SetEnrichedAt(time.Now()).Exec(ctx); err != nil {
		return automation.Event{}, err
	}
	return snapshot, nil
}

func (c *Configuration) SelectReleaseAutomation(ctx context.Context, org, id, versionID string, attempt int) error {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return err
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		return err
	}
	if !slices.Contains(event.VersionIds, versionID) || run.VersionID != nil && *run.VersionID != versionID {
		return ErrInvalidInput
	}
	version, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(versionID), releaseautomationversion.OrganizationID(org)).Only(ctx)
	if err != nil {
		return err
	}
	definition, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(version.DefinitionID), releaseautomation.OrganizationID(org), releaseautomation.SourceAppID(event.SourceAppID), releaseautomation.Enabled(true)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrAutomationStopped
	}
	if err != nil {
		return err
	}
	n, err := c.client.ReleaseAutomationRun.Update().Where(releaseautomationrun.ID(id), releaseautomationrun.OrganizationID(org), releaseautomationrun.CancelRequested(false), releaseautomationrun.RecoveryAttempt(attempt)).SetDefinitionID(definition.ID).SetVersionID(version.ID).SetReason(fmt.Sprintf("First matching definition in accepted priority order (position %d).", slices.Index(event.VersionIds, versionID)+1)).Save(ctx)
	if err == nil && n != 1 {
		return ErrAutomationStopped
	}
	return err
}

// AutomationNode executes one registered domain action, never chooses the next
// node. Input references are resolved from receipts owned by this same run.
func (c *Configuration) AutomationNode(ctx context.Context, org, id, nodeID string, decision *automation.Decision, attempt int) (outputs automation.Outputs, resultErr error) {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return automation.Outputs{}, err
	}
	source, err := c.automationCheckpoint(ctx, run, event)
	if err != nil {
		return automation.Outputs{}, err
	}
	if run.VersionID == nil {
		return automation.Outputs{}, ErrInvalidInput
	}
	version, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(*run.VersionID), releaseautomationversion.OrganizationID(org)).Only(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	node := automation.FindNode(version.Graph, nodeID)
	if node.ID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	prior, err := c.client.ReleaseAutomationNode.Query().Where(releaseautomationnode.OrganizationID(org), releaseautomationnode.RunID(id), releaseautomationnode.NodeID(nodeID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return automation.Outputs{}, err
	}
	if prior != nil && prior.Status == "completed" {
		return prior.Outputs, nil
	}
	key := "automation:" + id + ":" + nodeID
	if prior == nil {
		prior, err = c.client.ReleaseAutomationNode.Create().SetID(cuid.New()).SetOrganizationID(org).SetRunID(id).SetNodeID(nodeID).SetActionKey(key).Save(ctx)
		if err != nil {
			return automation.Outputs{}, err
		}
	} else {
		if err := prior.Update().SetStatus("running").AddAttempts(1).Exec(ctx); err != nil {
			return automation.Outputs{}, err
		}
	}
	defer func() {
		if resultErr != nil {
			failureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			_ = prior.Update().Where(releaseautomationnode.StatusNEQ("completed")).SetStatus("failed").SetFailureCode(automationFailureCode(resultErr)).Exec(failureCtx)
		}
	}()
	if node.Type == "condition" {
		if decision == nil {
			return outputs, ErrInvalidInput
		}
		snapshot := event.Snapshot
		for field, value := range event.Enrichment {
			snapshot.Fields[field] = value
		}
		expected := automation.Evaluate(*node.Condition, snapshot)
		if expected.Status != decision.Status || expected.Match != decision.Match {
			return outputs, ErrInvalidInput
		}
	}
	if node.Type == "action" || node.Type == "classify" {
		// Verify GitHub still grants repository access even if a revocation
		// webhook has not reached the platform yet.
		reader, installation, readErr := c.readerFor(ctx, source)
		if readErr != nil {
			return outputs, readErr
		}
		if reader == nil {
			return outputs, ErrGitHubUnavailable
		}
		if _, err := reader.Repository(ctx, installation, event.Snapshot.RepositoryID); err != nil {
			return outputs, err
		}
		if err := c.automationResources(ctx, org, version.Graph); err != nil {
			return outputs, err
		}
		if err := c.requireWorkspaceFeature(ctx, org, "release:create"); err != nil {
			return outputs, err
		}
	}
	if node.Type == "classify" {
		snapshot := event.Snapshot
		for field, value := range event.Enrichment {
			snapshot.Fields[field] = value
		}
		verdict, credits, err := c.automationJudge(ctx, org, prior, snapshot, node.Classify)
		if err != nil {
			return outputs, err
		}
		decision, outputs.CreditsCharged = &verdict, credits
	}
	if node.Type == "action" {
		actor := Actor{OrganizationID: org, Kind: "service", Display: "release-automation", RequestID: key}
		var input automation.Outputs
		if node.Action.Input != nil {
			previous, err := c.client.ReleaseAutomationNode.Query().Where(releaseautomationnode.OrganizationID(org), releaseautomationnode.RunID(id), releaseautomationnode.NodeID(node.Action.Input.NodeID), releaseautomationnode.Status("completed")).Only(ctx)
			if err != nil {
				return outputs, err
			}
			input = previous.Outputs
		}
		switch node.Action.Type {
		case "create_release":
			outputs, err = c.automationCreateRelease(ctx, actor, source, event, node.Action)
		case "create_campaign":
			outputs, err = c.automationCreateCampaign(ctx, actor, event, input, node.Action, key)
		case "generate_copy":
			outputs, err = c.automationGenerateCopy(ctx, actor, prior, event, input, node.Action)
		case "capture_product":
			outputs, err = c.automationCaptureProduct(ctx, org, event, input, node.Action)
		case "render_creatives":
			outputs, err = c.automationRenderCreatives(ctx, org, id, nodeID, event, input, node.Action)
		case "create_canvas":
			outputs, err = c.automationCreateCanvas(ctx, org, id, nodeID, input, node.Action)
		case "render_code_visual":
			outputs, err = c.automationRenderCodeVisual(ctx, org, id, nodeID, source, event, input, node.Action)
		case "submit_review":
			var result *CampaignPostTransition
			result, err = c.TransitionCampaignPosts(ctx, actor, input.CampaignID, CampaignPostDecision{Decision: "submit", PostIDs: input.PostIDs, IdempotencyKey: key})
			if err == nil {
				outputs = input
				outputs.PostIDs = result.PostIDs
				// Credits belong to the generation receipt that spent them.
				outputs.CreditsCharged = 0
			}
		default:
			err = ErrInvalidInput
		}
	}
	if err != nil {
		return outputs, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return outputs, err
	}
	defer tx.Rollback()
	// A timed-out activity can finish after recovery advanced another node.
	// Merge its real outputs under the run lock without erasing newer receipts.
	if err := tx.ReleaseAutomationRun.UpdateOneID(id).AddRecoveryAttempt(0).Exec(ctx); err != nil {
		return outputs, err
	}
	run, err = tx.ReleaseAutomationRun.Get(ctx, id)
	if err != nil {
		return outputs, err
	}
	update := tx.ReleaseAutomationNode.UpdateOneID(prior.ID).SetStatus("completed").SetOutputs(outputs).SetCompletedAt(time.Now()).SetFailureCode("")
	if decision != nil {
		update.SetDecision(*decision)
		if decision.Status != "evaluated" {
			update.SetStatus("needs_attention").SetFailureCode(decision.Status)
		}
	}
	if err := update.Exec(ctx); err != nil {
		return outputs, err
	}
	if outputs.ReleaseID != "" {
		run.Outputs.ReleaseID = outputs.ReleaseID
	}
	if outputs.CampaignID != "" {
		run.Outputs.CampaignID = outputs.CampaignID
		run.Outputs.PostIDs = outputs.PostIDs
		run.Outputs.BrandKitID, run.Outputs.BrandKitVersion, run.Outputs.DestinationIDs = outputs.BrandKitID, outputs.BrandKitVersion, outputs.DestinationIDs
	}
	if len(outputs.DesignIDs) > 0 {
		run.Outputs.DesignIDs, run.Outputs.RenderedAssetIDs = outputs.DesignIDs, outputs.RenderedAssetIDs
	}
	if outputs.CanvasID != "" {
		run.Outputs.CanvasID = outputs.CanvasID
	}
	if outputs.CodeProjectID != "" {
		run.Outputs.CodeProjectID = outputs.CodeProjectID
	}
	if outputs.CaptureID != "" {
		run.Outputs.CaptureID, run.Outputs.CaptureAssetID, run.Outputs.CaptureProof = outputs.CaptureID, outputs.CaptureAssetID, outputs.CaptureProof
	}
	if outputs.CreditsCharged > 0 {
		// Sum receipts rather than increment: a late duplicate completion of
		// the same node must not count its credits twice.
		completed, err := tx.ReleaseAutomationNode.Query().Where(releaseautomationnode.OrganizationID(org), releaseautomationnode.RunID(id), releaseautomationnode.Status("completed")).All(ctx)
		if err != nil {
			return outputs, err
		}
		run.Outputs.CreditsCharged = 0
		for _, receipt := range completed {
			run.Outputs.CreditsCharged += receipt.Outputs.CreditsCharged
		}
	}
	if err := tx.ReleaseAutomationRun.UpdateOneID(id).SetOutputs(run.Outputs).Exec(ctx); err != nil {
		return outputs, err
	}
	return outputs, tx.Commit()
}

// automationCreateRelease decides a release's contents from evidence only:
// the merged PR itself, PRs the notes reference, a milestone's assigned PRs,
// and, with include "unreleased", every collected change not yet released
// that merged before the event. Arrival order is never membership evidence.
func (c *Configuration) automationCreateRelease(ctx context.Context, actor Actor, source *ent.SourceApp, event *ent.ReleaseSourceEvent, action *automation.Action) (automation.Outputs, error) {
	e := event.Snapshot
	numbers := []int{}
	if e.Family == automation.Merged {
		numbers = append(numbers, e.Number)
	}
	if e.Family == automation.MilestoneClosed {
		reader, installation, err := c.readerFor(ctx, source)
		if err != nil {
			return automation.Outputs{}, err
		}
		if reader == nil {
			return automation.Outputs{}, ErrGitHubUnavailable
		}
		assigned, err := reader.MilestonePullRequests(ctx, installation, e.RepositoryID, e.Number)
		if errors.Is(err, githubapp.ErrIncompleteMilestone) {
			return automation.Outputs{}, ErrInvalidInput
		}
		if err != nil {
			return automation.Outputs{}, err
		}
		numbers = append(numbers, assigned...)
	}
	if action.Include == "unreleased" {
		pending, err := c.client.SourceChange.Query().Where(sourcechange.OrganizationID(actor.OrganizationID), sourcechange.SourceAppID(source.ID),
			sourcechange.RepositoryID(e.RepositoryID), sourcechange.ReleaseIDIsNil(), sourcechange.MergedAtLTE(e.OccurredAt)).
			Order(ent.Asc(sourcechange.FieldMergedAt)).Limit(githubapp.MaxMilestonePullRequests).All(ctx)
		if err != nil {
			return automation.Outputs{}, err
		}
		for _, change := range pending {
			if !slices.Contains(numbers, change.Number) {
				numbers = append(numbers, change.Number)
			}
		}
	}
	if e.Family == automation.Published || e.Family == automation.TagPushed {
		owner, repo, _ := strings.Cut(e.RepositoryName, "/")
		referenced := releasenotes.PullRequests(e.Notes, owner, repo)
		for _, feature := range releasenotes.Features(e.Notes) {
			referenced = append(referenced, feature.Number)
		}
		for _, number := range referenced {
			if number > 0 && !slices.Contains(numbers, number) {
				numbers = append(numbers, number)
			}
		}
	}
	benefit := releasenotes.Clean(firstNonEmpty(e.Notes, e.Title), 500)
	input := IngestSourceReleaseInput{SourceAppID: event.SourceAppID, EventID: e.SemanticKey, Title: e.Title, BenefitStatement: benefit, Notes: &e.Notes, RepositoryID: &e.RepositoryID, RepositoryName: &e.RepositoryName, Audience: &action.Audience, SourceURLs: []string{}, automationAssociation: &sourceReleaseAssociation{Numbers: numbers, Cutoff: e.OccurredAt}}
	if e.URL != "" {
		input.SourceURLs = append(input.SourceURLs, e.URL)
	}
	result, err := c.IngestSourceRelease(ctx, actor, input)
	if err != nil {
		return automation.Outputs{}, err
	}
	return automation.Outputs{ReleaseID: result.ReleaseID}, nil
}

func (c *Configuration) automationCreateCampaign(ctx context.Context, actor Actor, event *ent.ReleaseSourceEvent, input automation.Outputs, action *automation.Action, key string) (automation.Outputs, error) {
	if input.ReleaseID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "campaign:workflow"); err != nil {
		return automation.Outputs{}, err
	}
	brand, err := c.client.BrandKit.Query().Where(brandkit.ID(action.BrandKitID), brandkit.OrganizationID(actor.OrganizationID), brandkit.StatusEQ(brandkit.StatusACTIVE)).Only(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	destinations, err := c.client.ChannelConnection.Query().Where(channelconnection.IDIn(action.DestinationIDs...), channelconnection.OrganizationID(actor.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	if len(destinations) != len(action.DestinationIDs) {
		return automation.Outputs{}, publishing.ErrNotFound
	}
	posts := []CampaignPostInput{}
	profile, err := c.GetBrandProfile(ctx, actor.OrganizationID)
	if err != nil {
		return automation.Outputs{}, err
	}
	audience := action.Audience
	contextNotes := ""
	if profile != nil {
		if audience == "" {
			audience = releasenotes.Clean(profile.Audience, 1000)
		}
		contextNotes = releasenotes.Clean("Product: "+profile.ProductDescription+"\nVoice: "+profile.Tone+"\nCTA guidance: "+optionalText(profile.CtaConventions), 900)
	}
	// These are source-grounded drafts, with no model call or invented claims.
	copy := releasenotes.Clean(event.Snapshot.Title+"\n\n"+event.Snapshot.Notes, 8000)
	for _, id := range action.DestinationIDs {
		for _, destination := range destinations {
			if destination.ID == id {
				posts = append(posts, CampaignPostInput{Channel: destination.Platform, Copy: copy, CallToAction: &action.CallToAction})
			}
		}
	}
	style, _ := json.Marshal(map[string]any{"colors": brand.Definition["colors"], "typography": brand.Definition["typography"]})
	messaging := releasenotes.Clean(fmt.Sprintf("Brand kit: %s (version %d).\nVisual guidance: %s\n%s\nDestination connections: %s\nSource text requires human review; no generated claims.", brand.Name, brand.Version, style, contextNotes, strings.Join(action.DestinationIDs, ", ")), 2000)
	result, err := c.CreateCampaign(ctx, actor, CreateCampaignInput{Name: event.Snapshot.Title, Objective: "Review and communicate this release.", ReleaseID: &input.ReleaseID, Audience: &audience, Messaging: &messaging, IdempotencyKey: &key, Posts: posts})
	if err != nil {
		return automation.Outputs{}, err
	}
	outputs := automation.Outputs{ReleaseID: input.ReleaseID, CampaignID: result.ID, PostIDs: []string{}, BrandKitID: brand.ID, BrandKitVersion: brand.Version, DestinationIDs: action.DestinationIDs}
	for _, post := range result.Posts {
		outputs.PostIDs = append(outputs.PostIDs, post.ID)
	}
	return outputs, nil
}

// RunLegacyReleaseEvent preserves unconfigured sources' domain behavior while
// moving it behind durable event acceptance. No workflow definition is implied.
func (c *Configuration) RunLegacyReleaseEvent(ctx context.Context, org, id string, attempt int) error {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return err
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		return err
	}
	e := event.Snapshot
	actor := Actor{OrganizationID: org, Kind: "webhook", Display: event.SourceAppID, RequestID: event.DeliveryID}
	outputs := automation.Outputs{}
	switch e.Family {
	case automation.Published:
		urls := []string{}
		if e.URL != "" {
			urls = append(urls, e.URL)
		}
		result, err := c.IngestSourceRelease(ctx, actor, IngestSourceReleaseInput{SourceAppID: event.SourceAppID, EventID: e.SemanticKey, Title: e.Title, BenefitStatement: releasenotes.Clean(firstNonEmpty(e.Notes, e.Title), 500), Notes: &e.Notes, RepositoryID: &e.RepositoryID, RepositoryName: &e.RepositoryName, SourceURLs: urls})
		if err != nil {
			return err
		}
		outputs.ReleaseID = result.ReleaseID
	case automation.Merged:
		_, err := c.CollectAutomationChange(ctx, org, id, attempt)
		return err
	case automation.Deployed:
		if productionDeployment(e) {
			sha := eventString(e, "deployment.sha")
			_, err = c.IngestDeployment(ctx, actor, IngestDeploymentInput{SourceAppID: event.SourceAppID, EventID: event.DeliveryID, ExternalID: e.ObjectID, Environment: eventString(e, "deployment.environment"), SHA: &sha, URL: nonEmptyPointer(e.URL), DeployedAt: e.OccurredAt})
			if err != nil {
				return err
			}
		}
	}
	return c.client.ReleaseAutomationRun.UpdateOneID(id).SetOutputs(outputs).Exec(ctx)
}

func nonEmptyPointer(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// CollectAutomationChange records a merged PR or a deployment. For a
// deployment it returns how its commit compares with earlier ones (new,
// redeploy or rollback); only a new commit goes on to the workflow.
func (c *Configuration) CollectAutomationChange(ctx context.Context, org, id string, attempt int) (string, error) {
	run, event, err := c.automationAttempt(ctx, org, id, attempt)
	if err != nil {
		return "", err
	}
	if _, err := c.automationCheckpoint(ctx, run, event); err != nil {
		return "", err
	}
	e := event.Snapshot
	if e.Family == automation.Deployed && (event.Mode == "automation" || productionDeployment(e)) {
		sha := eventString(e, "deployment.sha")
		result, err := c.IngestDeployment(ctx, Actor{OrganizationID: org, Kind: "webhook", Display: event.SourceAppID, RequestID: event.DeliveryID}, IngestDeploymentInput{SourceAppID: event.SourceAppID, EventID: event.DeliveryID, ExternalID: e.ObjectID, Environment: eventString(e, "deployment.environment"), SHA: &sha, URL: nonEmptyPointer(e.URL), DeployedAt: e.OccurredAt})
		if err != nil {
			return "", err
		}
		return result.Kind, nil
	}
	if e.Family != automation.Merged {
		return "", nil
	}
	author := eventString(e, "pr.author")
	_, err = c.CollectSourceChange(ctx, Actor{OrganizationID: org, Kind: "webhook", Display: event.SourceAppID, RequestID: event.DeliveryID}, CollectSourceChangeInput{SourceAppID: event.SourceAppID, EventID: event.DeliveryID, RepositoryID: e.RepositoryID, Number: e.Number, Title: e.Title, Body: e.Notes, URL: e.URL, MergedAt: e.OccurredAt, AuthorLogin: nonEmptyPointer(author), Labels: e.Fields["pr.labels"].Values})
	return "", err
}

// automationFailureCode names why a node stopped, for run inspection.
func automationFailureCode(err error) string {
	var entitlement *FeatureNotEntitledError
	var prohibited *ProhibitedTermsError
	switch {
	case errors.Is(err, ErrQuotaExceeded):
		return "insufficient_credits"
	case errors.As(err, &entitlement):
		return "not_entitled"
	case errors.As(err, &prohibited):
		return "prohibited_terms"
	case errors.Is(err, ErrAutomationStopped):
		return "access_revoked"
	case errors.Is(err, ErrAutomationModelUnavailable):
		return "model_unavailable"
	case errors.Is(err, platformai.ErrSchema):
		return "model_output_invalid"
	case errors.Is(err, ErrAutomationRendererUnavailable):
		return "renderer_unavailable"
	case errors.Is(err, ErrCaptureMissing):
		return "capture_missing"
	case errors.Is(err, ErrCaptureUnavailable):
		return "capture_unavailable"
	case errors.Is(err, ErrDeploymentNotLive):
		return "waiting_for_deployment"
	case errors.Is(err, ErrDeploymentUnverified):
		return "deployment_unverified"
	case errors.Is(err, ErrCaptureRefused):
		return "capture_refused"
	case errors.Is(err, ErrCaptureNeedsAuth):
		return "needs_auth"
	case errors.Is(err, ErrCapturePending):
		return "capture_pending"
	case errors.Is(err, ErrCaptureSuperseded):
		return captureSuperseded
	case errors.Is(err, ErrInvalidInput), errors.Is(err, publishing.ErrNotFound), ent.IsNotFound(err):
		return "configuration_invalid"
	}
	return "action_failed"
}

// PermanentAutomationError identifies failures that retries cannot repair.
func PermanentAutomationError(err error) bool {
	var entitlement *FeatureNotEntitledError
	var prohibited *ProhibitedTermsError
	return errors.Is(err, ErrInvalidInput) || errors.Is(err, ErrQuotaExceeded) || errors.Is(err, ErrCaptureMissing) || errors.Is(err, ErrCaptureRefused) || errors.Is(err, ErrCaptureNeedsAuth) || errors.Is(err, ErrCaptureSuperseded) || errors.Is(err, ErrAutomationStopped) || errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrUnauthorized) || errors.Is(err, publishing.ErrNotFound) || errors.Is(err, publishing.ErrInvalidState) || ent.IsNotFound(err) || errors.As(err, &entitlement) || errors.As(err, &prohibited)
}
