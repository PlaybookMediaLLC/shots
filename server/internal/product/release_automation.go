package product

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	releaseautomation "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationexecutor"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationversion"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacegithubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/lucsky/cuid"
)

type AutomationDefinition struct {
	ID              string                         `json:"id"`
	SourceAppID     string                         `json:"sourceAppId"`
	Name            string                         `json:"name"`
	Description     string                         `json:"description"`
	Priority        int                            `json:"priority"`
	ActivePriority  int                            `json:"activePriority"`
	Revision        int                            `json:"revision"`
	Archived        bool                           `json:"archived"`
	Enabled         bool                           `json:"enabled"`
	ActiveVersionID *string                        `json:"activeVersionId"`
	Draft           automation.Graph               `json:"draft"`
	Layout          map[string]automation.Position `json:"layout"`
	ModifiedBy      string                         `json:"modifiedBy"`
	UpdatedAt       time.Time                      `json:"updatedAt"`
	Issues          []automation.Issue             `json:"issues"`
	LastRun         *AutomationRunSummary          `json:"lastRun"`
	RecentRuns      int                            `json:"recentRuns"`
}

type SaveAutomationInput struct {
	ID               string                         `json:"id"`
	SourceAppID      string                         `json:"sourceAppId"`
	Name             string                         `json:"name"`
	Description      string                         `json:"description"`
	Priority         int                            `json:"priority"`
	ExpectedRevision int                            `json:"expectedRevision"`
	Graph            automation.Graph               `json:"graph"`
	Layout           map[string]automation.Position `json:"layout"`
}

func automationDefinition(row *ent.ReleaseAutomation) AutomationDefinition {
	return AutomationDefinition{ID: row.ID, SourceAppID: row.SourceAppID, Name: row.Name, Description: row.Description,
		Priority: row.Priority, ActivePriority: row.ActivePriority, Revision: row.Revision, Enabled: row.Enabled, Archived: row.Archived, ActiveVersionID: row.ActiveVersionID,
		Draft: row.Draft, Layout: row.Layout, ModifiedBy: row.ModifiedBy, UpdatedAt: row.UpdatedAt, Issues: automation.Validate(row.Draft)}
}

func (c *Configuration) authorizeAutomationAdmin(ctx context.Context, actor Actor) error {
	if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	return c.authorizeRoles(ctx, actor, "owner", "admin")
}

// lockAutomationSource serializes activation, draft edits, and event admission
// on the existing source row. No remote calls occur while this lock is held.
func lockAutomationSource(ctx context.Context, tx *ent.Tx, org, id string) (*ent.SourceApp, error) {
	n, err := tx.SourceApp.Update().Where(sourceapp.ID(id), sourceapp.OrganizationID(org)).SetUpdatedAt(time.Now()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, publishing.ErrNotFound
	}
	return tx.SourceApp.Query().Where(sourceapp.ID(id), sourceapp.OrganizationID(org)).Only(ctx)
}

func automationSourceAccess(ctx context.Context, client *ent.Client, source *ent.SourceApp) error {
	if source.Status != sourceapp.StatusACTIVE || source.Provider != "github" || source.GithubInstallationID == nil || source.ExternalID == nil {
		return publishing.ErrInvalidState
	}
	active, err := client.GitHubInstallation.Query().Where(githubinstallation.ID(*source.GithubInstallationID), githubinstallation.StatusEQ(githubinstallation.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return err
	}
	if !active {
		return publishing.ErrForbidden
	}
	linked, err := client.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.OrganizationID(source.OrganizationID), workspacegithubinstallation.GithubInstallationID(*source.GithubInstallationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !linked {
		return publishing.ErrForbidden
	}
	return nil
}

func (c *Configuration) ListReleaseAutomations(ctx context.Context, actor Actor) ([]AutomationDefinition, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.OrganizationID(actor.OrganizationID)).Order(ent.Asc(releaseautomation.FieldActivePriority), ent.Asc(releaseautomation.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := []AutomationDefinition{}
	for _, row := range rows {
		result = append(result, automationDefinition(row))
	}
	return result, nil
}

func (c *Configuration) SaveReleaseAutomation(ctx context.Context, actor Actor, input SaveAutomationInput) (*AutomationDefinition, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if input.Priority < 0 || input.Priority > 9999 {
		return nil, fmt.Errorf("%w: priority must be a whole number from 0 to 9999", ErrInvalidInput)
	}
	if !automation.BoundedDraft(input.Graph) {
		return nil, ErrInvalidInput
	}
	body, err := json.Marshal(input)
	if err != nil || len(body) > 128<<10 || strings.TrimSpace(input.Name) == "" || len(input.Name) > 160 || len(input.Description) > 2000 || input.Priority < 0 || input.Priority > 9999 || !automation.ValidFamily(input.Graph.Family) || len(input.Graph.Nodes) > automation.MaxNodes || len(input.Graph.Edges) > 128 || len(input.Layout) > automation.MaxNodes {
		return nil, ErrInvalidInput
	}
	for _, position := range input.Layout {
		if math.IsNaN(position.X) || math.IsNaN(position.Y) || math.Abs(position.X) > 100000 || math.Abs(position.Y) > 100000 {
			return nil, ErrInvalidInput
		}
	}
	if input.Layout == nil {
		input.Layout = map[string]automation.Position{}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, input.SourceAppID)
	if err != nil {
		return nil, err
	}
	if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
		return nil, err
	}
	id := input.ID
	if id == "" {
		if input.ExpectedRevision != 0 {
			return nil, publishing.ErrConflict
		}
		count, err := tx.ReleaseAutomation.Query().Where(releaseautomation.OrganizationID(actor.OrganizationID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		if count >= 200 {
			return nil, ErrQuotaExceeded
		}
		id = cuid.New()
		_, err = tx.ReleaseAutomation.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetSourceAppID(source.ID).SetName(strings.TrimSpace(input.Name)).SetDescription(input.Description).SetFamily(string(input.Graph.Family)).SetPriority(input.Priority).SetDraft(input.Graph).SetLayout(input.Layout).SetModifiedBy(actor.UserID).Save(ctx)
	} else {
		var count int
		count, err = tx.ReleaseAutomation.Update().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.SourceAppID(source.ID), releaseautomation.Family(string(input.Graph.Family)), releaseautomation.Archived(false), releaseautomation.Revision(input.ExpectedRevision)).SetName(strings.TrimSpace(input.Name)).SetDescription(input.Description).SetPriority(input.Priority).SetDraft(input.Graph).SetLayout(input.Layout).SetModifiedBy(actor.UserID).AddRevision(1).Save(ctx)
		if err == nil && count != 1 {
			return nil, publishing.ErrConflict
		}
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_saved", "release_automation", id); err != nil {
		return nil, err
	}
	row, err := tx.ReleaseAutomation.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := automationDefinition(row)
	return &result, nil
}

func (c *Configuration) automationResources(ctx context.Context, org string, graph automation.Graph) error {
	for _, node := range graph.Nodes {
		if node.Action != nil && node.Action.Type == "capture_product" {
			var owned bool
			var err error
			if node.Action.RecipeID != "" {
				_, err = activeRecipeVersion(ctx, c.client.CaptureRecipe, org, node.Action.RecipeID)
				owned = err == nil
				if ent.IsNotFound(err) {
					err = nil
				}
			} else {
				owned, err = c.client.ProductSurface.Query().Where(productsurface.ID(node.Action.SurfaceID), productsurface.OrganizationID(org)).Exist(ctx)
			}
			if err != nil {
				return err
			}
			if !owned {
				return publishing.ErrNotFound
			}
		}
		if node.Action == nil || node.Action.Type != "create_campaign" {
			continue
		}
		a := node.Action
		owned, err := c.client.BrandKit.Query().Where(brandkit.ID(a.BrandKitID), brandkit.OrganizationID(org), brandkit.StatusEQ(brandkit.StatusACTIVE)).Exist(ctx)
		if err != nil {
			return err
		}
		if !owned {
			return publishing.ErrNotFound
		}
		count, err := c.client.ChannelConnection.Query().Where(channelconnection.IDIn(a.DestinationIDs...), channelconnection.OrganizationID(org), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
		if err != nil {
			return err
		}
		if count != len(a.DestinationIDs) {
			return publishing.ErrNotFound
		}
	}
	return nil
}

// AutomationExecutor is the best live worker lease: the newest graph language
// and the capabilities, such as AI copy, that some running worker can execute.
type AutomationExecutor struct {
	Available     bool     `json:"available"`
	SchemaVersion int      `json:"schemaVersion"`
	Capabilities  []string `json:"capabilities"`
}

// Executor availability is reported from live workers' short capability leases.
func (c *Configuration) ReleaseAutomationExecutor(ctx context.Context) (AutomationExecutor, error) {
	leases, err := c.client.ReleaseAutomationExecutor.Query().Where(releaseautomationexecutor.ExpiresAtGT(time.Now())).All(ctx)
	result := AutomationExecutor{Capabilities: []string{}}
	if err != nil {
		return result, err
	}
	for _, lease := range leases {
		result.Available = true
		result.SchemaVersion = max(result.SchemaVersion, lease.SchemaVersion)
		for _, capability := range lease.Capabilities {
			if !slices.Contains(result.Capabilities, capability) {
				result.Capabilities = append(result.Capabilities, capability)
			}
		}
	}
	return result, nil
}

// automationExecutable requires one live lease that runs the graph's language
// and every capability it needs. Mixed fleets cannot combine two leases.
func (c *Configuration) automationExecutable(ctx context.Context, graph automation.Graph) (bool, error) {
	leases, err := c.client.ReleaseAutomationExecutor.Query().Where(releaseautomationexecutor.SchemaVersionGTE(graph.SchemaVersion), releaseautomationexecutor.ExpiresAtGT(time.Now())).All(ctx)
	if err != nil {
		return false, err
	}
	for _, lease := range leases {
		if !slices.ContainsFunc(requiredCapabilities(graph), func(capability string) bool { return !slices.Contains(lease.Capabilities, capability) }) {
			return true, nil
		}
	}
	return false, nil
}

// requiredCapabilities are the worker capabilities a graph's nodes need.
func requiredCapabilities(graph automation.Graph) []string {
	required := []string{}
	for _, n := range graph.Nodes {
		capability := ""
		switch {
		case n.Type == "classify", n.Action != nil && n.Action.Type == "generate_copy":
			capability = automation.CapabilityAI
		case n.Action != nil && (n.Action.Type == "render_creatives" || n.Action.Type == "render_code_visual"):
			capability = automation.CapabilityRender
		case n.Action != nil && n.Action.Type == "create_canvas":
			capability = automation.CapabilityCanvas
		case n.Action != nil && n.Action.Type == "capture_product" && n.Action.RecipeID != "":
			capability = automation.CapabilityBrowser
		case n.Action != nil && n.Action.Type == "capture_product":
			capability = automation.CapabilityCapture
		}
		if capability != "" && !slices.Contains(required, capability) {
			required = append(required, capability)
		}
	}
	return required
}

func (c *Configuration) ActivateReleaseAutomation(ctx context.Context, actor Actor, id string, revision int) (*AutomationDefinition, error) {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if row.Archived || row.Revision != revision {
		return nil, publishing.ErrConflict
	}
	if len(automation.Validate(row.Draft)) > 0 {
		return nil, ErrInvalidInput
	}
	available, err := c.automationExecutable(ctx, row.Draft)
	if err != nil {
		return nil, err
	}
	if !available {
		return nil, conflict("No running worker supports this workflow's language version and actions.")
	}
	if err := c.automationResources(ctx, actor.OrganizationID, row.Draft); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "release:create"); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, row.SourceAppID)
	if err != nil {
		return nil, err
	}
	if err := automationSourceAccess(ctx, tx.Client(), source); err != nil {
		return nil, err
	}
	versionID := cuid.New()
	activeCount, err := tx.ReleaseAutomation.Query().Where(releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.SourceAppID(source.ID), releaseautomation.Family(row.Family), releaseautomation.Enabled(true), releaseautomation.IDNEQ(id)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if activeCount >= 20 {
		return nil, conflict("At most 20 workflows can be active for one repository and event.")
	}
	_, err = tx.ReleaseAutomationVersion.Create().SetID(versionID).SetOrganizationID(actor.OrganizationID).SetDefinitionID(id).SetRevision(revision).SetGraph(row.Draft).SetContentHash(automation.ContentHash(row.Draft)).SetActivatedBy(actor.UserID).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	count, err := tx.ReleaseAutomation.Update().Where(releaseautomation.ID(id), releaseautomation.OrganizationID(actor.OrganizationID), releaseautomation.Archived(false), releaseautomation.Revision(revision)).SetActiveVersionID(versionID).SetActivePriority(row.Priority).SetEnabled(true).AddRevision(1).SetModifiedBy(actor.UserID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, publishing.ErrConflict
	}
	if err := tx.SourceApp.UpdateOneID(source.ID).SetReleaseAutomation(true).Exec(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_automation_activated", "release_automation", id, map[string]any{"versionId": versionID, "revision": revision}); err != nil {
		return nil, err
	}
	row, err = tx.ReleaseAutomation.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := automationDefinition(row)
	return &result, nil
}

// AdvertiseReleaseAutomationExecutor renews a capability lease only after a
// worker starts polling the queue. Expiry disables activation, not history.
func (c *Configuration) AdvertiseReleaseAutomationExecutor(ctx context.Context, id string, capabilities ...string) error {
	expires := time.Now().Add(time.Minute)
	if capabilities == nil {
		capabilities = []string{}
	}
	n, err := c.client.ReleaseAutomationExecutor.Update().Where(releaseautomationexecutor.ID(id)).SetExpiresAt(expires).SetCapabilities(capabilities).Save(ctx)
	if err != nil {
		return err
	}
	if n == 1 {
		return nil
	}
	return c.client.ReleaseAutomationExecutor.Create().SetID(id).SetSchemaVersion(automation.SchemaVersion).SetCapabilities(capabilities).SetExpiresAt(expires).Exec(ctx)
}

type AutomationVersion struct {
	ID           string           `json:"id"`
	DefinitionID string           `json:"definitionId"`
	Revision     int              `json:"revision"`
	Graph        automation.Graph `json:"graph"`
	ContentHash  string           `json:"contentHash"`
	ActivatedBy  string           `json:"activatedBy"`
	CreatedAt    time.Time        `json:"createdAt"`
}

func automationVersion(row *ent.ReleaseAutomationVersion) AutomationVersion {
	return AutomationVersion{ID: row.ID, DefinitionID: row.DefinitionID, Revision: row.Revision, Graph: row.Graph, ContentHash: row.ContentHash, ActivatedBy: row.ActivatedBy, CreatedAt: row.CreatedAt}
}

func (c *Configuration) GetReleaseAutomationVersion(ctx context.Context, actor Actor, id string) (*AutomationVersion, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.ID(id), releaseautomationversion.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	version := automationVersion(row)
	return &version, nil
}

// ListReleaseAutomationVersions returns a definition's immutable activated
// revisions, newest first. Runs name the version they executed.
func (c *Configuration) ListReleaseAutomationVersions(ctx context.Context, actor Actor, definitionID string) ([]AutomationVersion, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	exists, err := c.client.ReleaseAutomation.Query().Where(releaseautomation.ID(definitionID), releaseautomation.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, publishing.ErrNotFound
	}
	rows, err := c.client.ReleaseAutomationVersion.Query().Where(releaseautomationversion.OrganizationID(actor.OrganizationID), releaseautomationversion.DefinitionID(definitionID)).Order(ent.Desc(releaseautomationversion.FieldRevision)).Limit(100).All(ctx)
	if err != nil {
		return nil, err
	}
	result := []AutomationVersion{}
	for _, row := range rows {
		result = append(result, automationVersion(row))
	}
	return result, nil
}
