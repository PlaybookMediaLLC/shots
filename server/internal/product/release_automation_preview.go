package product

import (
	"context"
	"errors"
	"slices"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacegithubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

type AutomationSource struct {
	Branch             string `json:"branch"`
	CollectUnmatched   bool   `json:"collectUnmatched"`
	ConnectionState    string `json:"connectionState"`
	ID                 string `json:"id"`
	Name               string `json:"name"`
	RepositoryID       string `json:"repositoryId"`
	Status             string `json:"status"`
	Mode               string `json:"mode"`
	Account            string `json:"account"`
	InstallationStatus string `json:"installationStatus"`
}
type AutomationChoice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// AutomationActionAvailability says whether the backend can execute an action
// for this workspace now, and if not, what has to be configured first.
type AutomationActionAvailability struct {
	Type      string `json:"type"`
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
}

type AutomationOverview struct {
	Definitions       []AutomationDefinition                  `json:"definitions"`
	Sources           []AutomationSource                      `json:"sources"`
	Brands            []AutomationChoice                      `json:"brands"`
	Destinations      []AutomationChoice                      `json:"destinations"`
	Surfaces          []AutomationChoice                      `json:"surfaces"`
	Fields            map[automation.Family]map[string]string `json:"fields"`
	ExecutorAvailable bool                                    `json:"executorAvailable"`
	Executor          AutomationExecutor                      `json:"executor"`
	Actions           []AutomationActionAvailability          `json:"actions"`
	LegacyRunCounts   map[string]int                          `json:"legacyRunCounts"`
	RunCounts         map[string]int                          `json:"runCounts"`
}

// automationActions reports the registered actions against live workers and
// workspace entitlements. Activation and every activity check them again.
func (c *Configuration) automationActions(ctx context.Context, org string, executor AutomationExecutor) ([]AutomationActionAvailability, error) {
	result := []AutomationActionAvailability{}
	for _, action := range []struct{ kind, feature string }{{"create_release", "release:create"}, {"create_campaign", "campaign:workflow"}, {"generate_copy", "campaign:workflow"},
		{"render_creatives", "campaign:workflow"}, {"render_code_visual", "campaign:workflow"}, {"create_canvas", "workspace:paid"}, {"submit_review", "release:create"}, {"classify", "release:create"}} {
		item := AutomationActionAvailability{Type: action.kind, Available: true}
		err := c.requireWorkspaceFeature(ctx, org, action.feature)
		var entitlement *FeatureNotEntitledError
		switch {
		case errors.As(err, &entitlement):
			item.Reason = "Your plan does not include this action. Upgrade to " + entitlement.RequiredPlan + " to use it."
		case err != nil:
			return nil, err
		case !executor.Available:
			item.Reason = "No workflow worker is running. You can save and test drafts; activation waits for a worker."
		case (action.kind == "generate_copy" || action.kind == "classify" || action.kind == "render_creatives" || action.kind == "render_code_visual" || action.kind == "create_canvas") && executor.SchemaVersion < 2:
			item.Reason = "Running workers predate workflow language version 2. Deploy the current product worker."
		case (action.kind == "generate_copy" || action.kind == "classify") && !slices.Contains(executor.Capabilities, automation.CapabilityAI):
			item.Reason = "No worker has an AI model provider and credit meter configured (OPENROUTER_API_KEY, REDIS_URL)."
		case (action.kind == "render_creatives" || action.kind == "render_code_visual") && !slices.Contains(executor.Capabilities, automation.CapabilityRender):
			item.Reason = "No worker can reach the design renderer (PLATFORM_WORKFLOW_RENDER_URL, PLATFORM_WORKFLOW_RENDER_KEY)."
		case action.kind == "create_canvas" && !slices.Contains(executor.Capabilities, automation.CapabilityCanvas):
			item.Reason = "No worker can reach the canvas builder (PLATFORM_WORKFLOW_RENDER_URL, PLATFORM_WORKFLOW_RENDER_KEY)."
		}
		item.Available = item.Reason == ""
		result = append(result, item)
	}
	return result, nil
}

func (c *Configuration) ReleaseAutomationOverview(ctx context.Context, actor Actor) (*AutomationOverview, error) {
	definitions, err := c.ListReleaseAutomations(ctx, actor)
	if err != nil {
		return nil, err
	}
	result := &AutomationOverview{Definitions: definitions, Sources: []AutomationSource{}, Brands: []AutomationChoice{}, Destinations: []AutomationChoice{}, Surfaces: []AutomationChoice{}, Fields: map[automation.Family]map[string]string{}}
	surfaces, err := c.client.ProductSurface.Query().Where(productsurface.OrganizationID(actor.OrganizationID)).Order(ent.Asc(productsurface.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, surface := range surfaces {
		result.Surfaces = append(result.Surfaces, AutomationChoice{ID: surface.ID, Name: surface.Name})
	}
	result.Executor, err = c.ReleaseAutomationExecutor(ctx)
	if err != nil {
		return nil, err
	}
	result.ExecutorAvailable = result.Executor.Available
	if result.Actions, err = c.automationActions(ctx, actor.OrganizationID, result.Executor); err != nil {
		return nil, err
	}
	if result.LegacyRunCounts, err = c.automationRunCounts(ctx, actor.OrganizationID, "legacy"); err != nil {
		return nil, err
	}
	if result.RunCounts, err = c.automationRunCounts(ctx, actor.OrganizationID, "automation"); err != nil {
		return nil, err
	}
	if err := c.attachLastRuns(ctx, actor.OrganizationID, result.Definitions); err != nil {
		return nil, err
	}
	for _, family := range []automation.Family{automation.Published, automation.Merged, automation.Deployed, automation.TagPushed, automation.MilestoneClosed} {
		result.Fields[family] = automation.FieldKinds(family)
	}
	sources, err := c.client.SourceApp.Query().Where(sourceapp.OrganizationID(actor.OrganizationID), sourceapp.Provider("github"), sourceapp.GithubInstallationIDNotNil()).Order(ent.Asc(sourceapp.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	installationIDs := make([]string, 0, len(sources))
	for _, source := range sources {
		installationIDs = append(installationIDs, *source.GithubInstallationID)
	}
	installations := map[string]*ent.GitHubInstallation{}
	linkedInstallations := map[string]bool{}
	if len(installationIDs) > 0 {
		rows, err := c.client.GitHubInstallation.Query().Where(githubinstallation.IDIn(installationIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			installations[row.ID] = row
		}
		links, err := c.client.WorkspaceGitHubInstallation.Query().Where(
			workspacegithubinstallation.OrganizationID(actor.OrganizationID),
			workspacegithubinstallation.GithubInstallationIDIn(installationIDs...),
		).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, link := range links {
			linkedInstallations[link.GithubInstallationID] = true
		}
	}
	for _, source := range sources {
		item := AutomationSource{ID: source.ID, Name: source.Name, Status: string(source.Status), Mode: "legacy", InstallationStatus: "DELETED"}
		item.CollectUnmatched = source.AutomationCollectUnmatched
		if source.Branch != nil {
			item.Branch = *source.Branch
		}
		if source.ExternalID != nil {
			item.RepositoryID = *source.ExternalID
		}
		if source.ReleaseAutomation {
			item.Mode = "automation"
		}
		if installation := installations[*source.GithubInstallationID]; installation != nil {
			item.Account, item.InstallationStatus = installation.AccountLogin, string(installation.Status)
		}
		linked := linkedInstallations[*source.GithubInstallationID]
		switch {
		case !linked:
			item.ConnectionState = "disconnected"
		case item.InstallationStatus == "DELETED":
			item.ConnectionState = "deleted"
		case item.InstallationStatus == "SUSPENDED":
			item.ConnectionState = "suspended"
		case source.Status != sourceapp.StatusACTIVE:
			item.ConnectionState = "repository_access_removed"
		default:
			item.ConnectionState = "connected"
		}
		result.Sources = append(result.Sources, item)
	}
	brands, err := c.client.BrandKit.Query().Where(brandkit.OrganizationID(actor.OrganizationID), brandkit.StatusEQ(brandkit.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, brand := range brands {
		result.Brands = append(result.Brands, AutomationChoice{ID: brand.ID, Name: brand.Name})
	}
	destinations, err := c.client.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, destination := range destinations {
		name := destination.Platform
		if destination.DisplayName != nil {
			name += " · " + *destination.DisplayName
		}
		result.Destinations = append(result.Destinations, AutomationChoice{ID: destination.ID, Name: name})
	}
	return result, nil
}

type AutomationPreviewInput struct {
	SourceAppID string            `json:"sourceAppId"`
	Graph       automation.Graph  `json:"graph"`
	EventID     string            `json:"eventId"`
	Example     *automation.Event `json:"example"`
	// AssumeIrrelevant previews AI relevance checks answering "not worth
	// marketing"; previews never call a model.
	AssumeIrrelevant bool `json:"assumeIrrelevant"`
}
type AutomationPreview struct {
	automation.Preview
	Evidence string `json:"evidence"`
}

// PreviewReleaseAutomation uses the production validator/evaluator and only
// reads tenant data. It never fetches GitHub or calls generation/domain actions.
func (c *Configuration) PreviewReleaseAutomation(ctx context.Context, actor Actor, input AutomationPreviewInput) (*AutomationPreview, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	source, err := c.client.SourceApp.Query().Where(sourceapp.ID(input.SourceAppID), sourceapp.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	var snapshot automation.Event
	evidence := "Administrator-supplied example; no external reads or actions."
	if input.EventID != "" {
		if input.Example != nil {
			return nil, ErrInvalidInput
		}
		event, err := c.client.ReleaseSourceEvent.Query().Where(releasesourceevent.ID(input.EventID), releasesourceevent.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		if event.SourceAppID != source.ID {
			return nil, ErrInvalidInput
		}
		snapshot = event.Snapshot
		for field, value := range event.Enrichment {
			snapshot.Fields[field] = value
		}
		evidence = "Recorded workspace event and its persisted enrichment; no data refreshed."
	} else {
		if input.Example == nil {
			return nil, ErrInvalidInput
		}
		snapshot = *input.Example
		if err := automation.ValidateEvent(snapshot); err != nil {
			return nil, ErrInvalidInput
		}
	}
	preview := automation.DryRunAssuming(input.Graph, snapshot, !input.AssumeIrrelevant)
	// Preview predicts activation, which opts the source into automation mode.
	source.ReleaseAutomation = true
	if filter := automationSourceFilter(source, snapshot); filter != "" && len(preview.Issues) == 0 {
		preview.Qualification = automation.Decision{Status: "evaluated", Match: false, Reason: filter}
		preview.Steps = []automation.Step{}
		preview.Outcome = "skipped"
	}
	if len(preview.Issues) == 0 {
		if err := c.automationResources(ctx, actor.OrganizationID, input.Graph); err != nil {
			if ent.IsNotFound(err) || errors.Is(err, publishing.ErrNotFound) {
				preview.Issues = append(preview.Issues, automation.Issue{Code: "resource_unavailable", Message: "A selected brand kit or destination is unavailable in this workspace."})
				preview.Outcome = "invalid"
			} else {
				return nil, err
			}
		}
	}
	return &AutomationPreview{Preview: preview, Evidence: evidence}, nil
}
