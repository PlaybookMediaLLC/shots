package product

import (
	"context"
	"encoding/json"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignplan"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentangle"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/design"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/launchrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasespec"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// The launch pipeline: versioned release specs and campaign plans, AI
// revision proposals, generated posts with provenance, and background runs
// (docs/launch-intelligence.md). Every read is scoped to the actor's
// workspace and every audited write is audited in the same transaction.

// launchError carries the message a reviewer sees; kind picks the status.
type launchError struct {
	kind    error
	message string
}

func (e launchError) Error() string { return e.message }
func (e launchError) Unwrap() error { return e.kind }

func launchNotFound(what string) error {
	return launchError{publishing.ErrNotFound, what + " not found."}
}

var (
	errLaunchStale     = launchError{publishing.ErrConflict, "This changed since the proposal was made. Ask for a new revision."}
	errLaunchDecided   = launchError{publishing.ErrConflict, "This proposal was already decided."}
	errLaunchRunActive = launchError{publishing.ErrConflict, "This step is already running for the campaign."}
	errLaunchRelated   = launchError{ErrInvalidInput, "Unknown related change."}

	// release:create and release:approve in lib/auth/permissions.ts.
	launchEditRoles    = []string{"owner", "admin", "creator"}
	launchApproveRoles = []string{"owner", "admin", "approver"}
	launchRunKinds     = []string{"spec", "plan", "produce", "revision"}
)

// A run that stopped heartbeating (the web server restarted mid-run) counts
// as failed after launchRunHeartbeatStaleAfter, or after launchRunStaleAfter
// when it never sent a heartbeat, so it no longer blocks a new run.
const (
	launchRunHeartbeatStaleAfter = 2 * time.Minute
	launchRunStaleAfter          = 20 * time.Minute
)

func launchUserID(actor Actor) *string {
	if actor.IsSession() && actor.UserID != "" {
		return &actor.UserID
	}
	return nil
}

func launchTruncate(value string, max int) string {
	if utf8.RuneCountInString(value) <= max {
		return value
	}
	return string([]rune(value)[:max])
}

// launchMetadata adds the caller's flat audit metadata over the base fields.
func launchMetadata(base, extra map[string]any) map[string]any {
	for key, value := range extra {
		base[key] = value
	}
	return base
}

func launchObject(value json.RawMessage) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(value, &object) == nil && object != nil
}

func validLaunchOrigin(origin string) bool {
	return origin == "ai" || origin == "human" || origin == "revision"
}

// ------------------------------------------------------------- context --

type LaunchRelease struct {
	Audience         *string `json:"audience"`
	BenefitStatement string  `json:"benefitStatement"`
	CreatedByUserID  *string `json:"createdByUserId"`
	Description      *string `json:"description"`
	// Features and Notes are what a source said about the release in full.
	Features   []releasenotes.Feature `json:"features"`
	Notes      *string                `json:"notes"`
	ID         string                 `json:"id"`
	SourceURLs []string               `json:"sourceUrls"`
	Title      string                 `json:"title"`
}

// LaunchCampaign is what the AI stages read about a campaign.
type LaunchCampaign struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Objective      string          `json:"objective"`
	ProductSurface *ReleaseSurface `json:"productSurface"`
	Release        *LaunchRelease  `json:"release"`
}

func (c *Configuration) GetLaunchCampaign(ctx context.Context, actor Actor, id string) (*LaunchCampaign, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Campaign.Query().Where(campaign.ID(id), campaign.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Campaign")
	}
	if err != nil {
		return nil, err
	}
	result := &LaunchCampaign{ID: row.ID, Name: row.Name, Objective: row.Objective}
	if row.ProductSurfaceID != nil {
		surface, err := c.client.ProductSurface.Query().Where(productsurface.ID(*row.ProductSurfaceID),
			productsurface.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if surface != nil {
			result.ProductSurface = &ReleaseSurface{Environment: surface.Environment, ID: surface.ID, Name: surface.Name, URL: surface.URL}
		}
	}
	if row.ReleaseID != nil {
		linked, err := c.client.Release.Query().Where(release.ID(*row.ReleaseID), release.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if linked != nil {
			urls := linked.SourceUrls
			if urls == nil {
				urls = []string{}
			}
			result.Release = &LaunchRelease{Audience: linked.Audience, BenefitStatement: linked.BenefitStatement,
				CreatedByUserID: linked.CreatedByUserID, Description: linked.Description, Features: linked.Features, ID: linked.ID, Notes: linked.Notes,
				SourceURLs: urls, Title: linked.Title}
		}
	}
	return result, nil
}

// GetLaunchBrand returns the newest active brand kit and the brand voice.
// Any member may read them: every launch stage writes in the brand.
func (c *Configuration) GetLaunchBrand(ctx context.Context, actor Actor) (*ent.BrandKit, *ent.BrandProfile, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, nil, err
	}
	kit, err := c.client.BrandKit.Query().Where(brandkit.OrganizationID(actor.OrganizationID), brandkit.StatusEQ(brandkit.StatusACTIVE)).
		Order(ent.Desc(brandkit.FieldUpdatedAt), ent.Desc(brandkit.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, nil, err
	}
	profile, err := c.GetBrandProfile(ctx, actor.OrganizationID)
	if err != nil {
		return nil, nil, err
	}
	return kit, profile, nil
}

// WorkspaceVoice is the brand voice for writing that belongs to no social set
// (launch copy, campaign studio, store screenshots): the one WritingContext
// format, from the brand profile alone.
func WorkspaceVoice(profile *ent.BrandProfile) WritingContext {
	return mergeWritingContext(profile, nil, nil, "")
}

// --------------------------------------------------------------- specs --

type LaunchSpec struct {
	ApprovedAt    *time.Time      `json:"approvedAt"`
	ChangeSummary *string         `json:"changeSummary"`
	Content       json.RawMessage `json:"content"`
	CreatedAt     time.Time       `json:"createdAt"`
	ID            string          `json:"id"`
	ModelID       *string         `json:"modelId"`
	Origin        string          `json:"origin"`
	ReleaseID     string          `json:"releaseId"`
	Sources       json.RawMessage `json:"sources"`
	Status        string          `json:"status"`
	Version       int             `json:"version"`
}

func launchSpec(row *ent.ReleaseSpec) LaunchSpec {
	return LaunchSpec{ApprovedAt: row.ApprovedAt, ChangeSummary: row.ChangeSummary, Content: row.Content,
		CreatedAt: row.CreatedAt, ID: row.ID, ModelID: row.ModelID, Origin: row.Origin, ReleaseID: row.ReleaseID,
		Sources: row.Sources, Status: string(row.Status), Version: row.Version}
}

type SaveLaunchSpecInput struct {
	ChangeSummary string          `json:"changeSummary"`
	Content       json.RawMessage `json:"content"`
	Metadata      map[string]any  `json:"metadata"`
	ModelID       *string         `json:"modelId"`
	Origin        string          `json:"origin"`
	Sources       json.RawMessage `json:"sources"`
}

// ListLaunchSpecs returns a release's 30 newest spec versions, newest first.
func (c *Configuration) ListLaunchSpecs(ctx context.Context, actor Actor, releaseID string) ([]LaunchSpec, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.ReleaseSpec.Query().Where(releasespec.OrganizationID(actor.OrganizationID),
		releasespec.ReleaseID(releaseID)).Order(ent.Desc(releasespec.FieldVersion)).Limit(30).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]LaunchSpec, 0, len(rows))
	for _, row := range rows {
		items = append(items, launchSpec(row))
	}
	return items, nil
}

func (c *Configuration) GetLaunchSpec(ctx context.Context, actor Actor, id string) (*LaunchSpec, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.ReleaseSpec.Query().Where(releasespec.ID(id), releasespec.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Spec")
	}
	if err != nil {
		return nil, err
	}
	result := launchSpec(row)
	return &result, nil
}

// SaveLaunchSpec stores a new spec version for the release.
func (c *Configuration) SaveLaunchSpec(ctx context.Context, actor Actor, releaseID string, input SaveLaunchSpecInput) (*LaunchSpec, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if len(input.Sources) == 0 {
		input.Sources = json.RawMessage("[]")
	}
	var sources []json.RawMessage
	if !validLaunchOrigin(input.Origin) || !launchObject(input.Content) || json.Unmarshal(input.Sources, &sources) != nil || sources == nil {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableReleaseCampaigns(ctx, tx, actor, releaseID); err != nil {
		return nil, err
	}
	exists, err := tx.Release.Query().Where(release.ID(releaseID), release.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, launchNotFound("Release")
	}
	version := 1
	last, err := tx.ReleaseSpec.Query().Where(releasespec.ReleaseID(releaseID)).Order(ent.Desc(releasespec.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if last != nil {
		version = last.Version + 1
	}
	row, err := tx.ReleaseSpec.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetReleaseID(releaseID).
		SetVersion(version).SetOrigin(input.Origin).SetContent(input.Content).SetSources(input.Sources).
		SetChangeSummary(launchTruncate(input.ChangeSummary, 500)).SetNillableModelID(input.ModelID).
		SetNillableCreatedByUserID(launchUserID(actor)).SetCreatedAt(time.Now().UTC()).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	action := "product.release_spec_updated"
	if input.Origin == "ai" {
		action = "product.release_spec_generated"
	}
	if err := appendConfigurationAudit(ctx, tx, actor, action, "release_spec", row.ID, launchMetadata(map[string]any{
		"origin": input.Origin, "releaseId": releaseID, "version": row.Version}, input.Metadata)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchSpec(row)
	return &result, nil
}

// ApproveLaunchSpec approves one version and supersedes the release's
// previously approved one.
func (c *Configuration) ApproveLaunchSpec(ctx context.Context, actor Actor, id string) (*LaunchSpec, error) {
	if err := c.authorizeDecision(ctx, actor, launchApproveRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM release_spec WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	spec, err := tx.ReleaseSpec.Query().Where(releasespec.ID(id), releasespec.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Spec")
	}
	if err != nil {
		return nil, err
	}
	if err := mutableReleaseCampaigns(ctx, tx, actor, spec.ReleaseID); err != nil {
		return nil, err
	}
	if spec.Status == releasespec.StatusAPPROVED {
		result := launchSpec(spec)
		return &result, nil
	}
	if _, err := tx.ReleaseSpec.Update().Where(releasespec.ReleaseID(spec.ReleaseID), releasespec.IDNEQ(spec.ID),
		releasespec.StatusEQ(releasespec.StatusAPPROVED)).SetStatus(releasespec.StatusSUPERSEDED).Save(ctx); err != nil {
		return nil, err
	}
	update := tx.ReleaseSpec.UpdateOneID(spec.ID).SetStatus(releasespec.StatusAPPROVED).SetApprovedAt(time.Now().UTC())
	if userID := launchUserID(actor); userID != nil {
		update.SetApprovedByUserID(*userID)
	} else {
		update.ClearApprovedByUserID()
	}
	row, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "brief.approved", "product.release_spec_approved", "release_spec", spec.ID,
		map[string]any{"version": spec.Version}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchSpec(row)
	return &result, nil
}

// --------------------------------------------------------------- plans --

type LaunchPlan struct {
	ApprovedAt    *time.Time      `json:"approvedAt"`
	CampaignID    string          `json:"campaignId"`
	ChangeSummary *string         `json:"changeSummary"`
	Content       json.RawMessage `json:"content"`
	CreatedAt     time.Time       `json:"createdAt"`
	ID            string          `json:"id"`
	ModelID       *string         `json:"modelId"`
	Origin        string          `json:"origin"`
	SpecID        *string         `json:"specId"`
	Status        string          `json:"status"`
	Version       int             `json:"version"`
}

func launchPlan(row *ent.CampaignPlan) LaunchPlan {
	return LaunchPlan{ApprovedAt: row.ApprovedAt, CampaignID: row.CampaignID, ChangeSummary: row.ChangeSummary,
		Content: row.Content, CreatedAt: row.CreatedAt, ID: row.ID, ModelID: row.ModelID, Origin: row.Origin,
		SpecID: row.SpecID, Status: string(row.Status), Version: row.Version}
}

type SaveLaunchPlanInput struct {
	ChangeSummary string          `json:"changeSummary"`
	Content       json.RawMessage `json:"content"`
	Metadata      map[string]any  `json:"metadata"`
	ModelID       *string         `json:"modelId"`
	Origin        string          `json:"origin"`
	SpecID        *string         `json:"specId"`
}

// ListLaunchPlans returns a campaign's 30 newest plan versions, newest first.
func (c *Configuration) ListLaunchPlans(ctx context.Context, actor Actor, campaignID string) ([]LaunchPlan, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.CampaignPlan.Query().Where(campaignplan.OrganizationID(actor.OrganizationID),
		campaignplan.CampaignID(campaignID)).Order(ent.Desc(campaignplan.FieldVersion)).Limit(30).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]LaunchPlan, 0, len(rows))
	for _, row := range rows {
		items = append(items, launchPlan(row))
	}
	return items, nil
}

func (c *Configuration) GetLaunchPlan(ctx context.Context, actor Actor, campaignID, id string) (*LaunchPlan, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.CampaignPlan.Query().Where(campaignplan.ID(id), campaignplan.CampaignID(campaignID),
		campaignplan.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Plan")
	}
	if err != nil {
		return nil, err
	}
	result := launchPlan(row)
	return &result, nil
}

// SaveLaunchPlan stores a new plan version for the campaign.
func (c *Configuration) SaveLaunchPlan(ctx context.Context, actor Actor, campaignID string, input SaveLaunchPlanInput) (*LaunchPlan, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if !validLaunchOrigin(input.Origin) || !launchObject(input.Content) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	exists, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, launchNotFound("Campaign")
	}
	if input.SpecID != nil {
		owned, err := tx.ReleaseSpec.Query().Where(releasespec.ID(*input.SpecID), releasespec.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !owned {
			return nil, launchNotFound("Spec")
		}
	}
	version := 1
	last, err := tx.CampaignPlan.Query().Where(campaignplan.CampaignID(campaignID)).Order(ent.Desc(campaignplan.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if last != nil {
		version = last.Version + 1
	}
	row, err := tx.CampaignPlan.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
		SetVersion(version).SetOrigin(input.Origin).SetContent(input.Content).SetNillableSpecID(input.SpecID).
		SetChangeSummary(launchTruncate(input.ChangeSummary, 500)).SetNillableModelID(input.ModelID).
		SetNillableCreatedByUserID(launchUserID(actor)).SetCreatedAt(time.Now().UTC()).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	action := "product.campaign_plan_updated"
	if input.Origin == "ai" {
		action = "product.campaign_plan_generated"
	}
	if err := appendConfigurationAudit(ctx, tx, actor, action, "campaign_plan", row.ID, launchMetadata(map[string]any{
		"campaignId": campaignID, "origin": input.Origin, "version": row.Version}, input.Metadata)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchPlan(row)
	return &result, nil
}

// ApproveLaunchPlan approves one version and supersedes the campaign's
// previously approved one.
func (c *Configuration) ApproveLaunchPlan(ctx context.Context, actor Actor, id string) (*LaunchPlan, error) {
	if err := c.authorizeDecision(ctx, actor, launchApproveRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM campaign_plan WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	plan, err := tx.CampaignPlan.Query().Where(campaignplan.ID(id), campaignplan.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Plan")
	}
	if err != nil {
		return nil, err
	}
	if err := mutableCampaign(ctx, tx, actor, plan.CampaignID); err != nil {
		return nil, err
	}
	if plan.Status == campaignplan.StatusAPPROVED {
		result := launchPlan(plan)
		return &result, nil
	}
	if _, err := tx.CampaignPlan.Update().Where(campaignplan.CampaignID(plan.CampaignID), campaignplan.IDNEQ(plan.ID),
		campaignplan.StatusEQ(campaignplan.StatusAPPROVED)).SetStatus(campaignplan.StatusSUPERSEDED).Save(ctx); err != nil {
		return nil, err
	}
	update := tx.CampaignPlan.UpdateOneID(plan.ID).SetStatus(campaignplan.StatusAPPROVED).SetApprovedAt(time.Now().UTC())
	if userID := launchUserID(actor); userID != nil {
		update.SetApprovedByUserID(*userID)
	} else {
		update.ClearApprovedByUserID()
	}
	row, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "plan.approved", "product.campaign_plan_approved", "campaign_plan", plan.ID,
		map[string]any{"campaignId": plan.CampaignID, "version": plan.Version}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchPlan(row)
	return &result, nil
}

// --------------------------------------------------------------- posts --

type LaunchAngleInput struct {
	Hook  string `json:"hook"`
	Key   string `json:"key"`
	Title string `json:"title"`
}

type LaunchPostInput struct {
	AngleKey     string           `json:"angleKey"`
	CallToAction string           `json:"callToAction"`
	Channel      string           `json:"channel"`
	Claims       []map[string]any `json:"claims"`
	Copy         string           `json:"copy"`
	Phase        string           `json:"phase"`
	Title        string           `json:"title"`
}

type SaveLaunchPostsInput struct {
	Angles      []LaunchAngleInput `json:"angles"`
	Metadata    map[string]any     `json:"metadata"`
	PlanVersion int                `json:"planVersion"`
	Posts       []LaunchPostInput  `json:"posts"`
	SpecVersion int                `json:"specVersion"`
}

type LaunchPostsResult struct {
	AngleCount int `json:"angleCount"`
	PostCount  int `json:"postCount"`
}

// SaveLaunchPosts saves generated copy with its provenance. Plan angles
// become content angles (appended, so an earlier run's posts keep theirs)
// and each post records its angle key, phase, and spec and plan versions.
func (c *Configuration) SaveLaunchPosts(ctx context.Context, actor Actor, campaignID string, input SaveLaunchPostsInput) (*LaunchPostsResult, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if len(input.Posts) == 0 || len(input.Posts) > 100 || len(input.Angles) > 20 {
		return nil, ErrInvalidInput
	}
	for _, post := range input.Posts {
		if !campaignChannelPattern.MatchString(post.Channel) || strings.TrimSpace(post.Copy) == "" {
			return nil, ErrInvalidInput
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	exists, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, launchNotFound("Campaign")
	}
	texts := make([]string, 0, 3*len(input.Posts))
	for _, post := range input.Posts {
		texts = append(texts, post.Title, post.Copy, post.CallToAction)
	}
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, nil, texts...); err != nil {
		return nil, err
	}
	position := 0
	last, err := tx.ContentAngle.Query().Where(contentangle.CampaignID(campaignID)).Order(ent.Desc(contentangle.FieldPosition)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if last != nil {
		position = last.Position + 1
	}
	angleIDs := map[string]string{}
	for _, angle := range input.Angles {
		if !slices.ContainsFunc(input.Posts, func(post LaunchPostInput) bool { return post.AngleKey == angle.Key }) {
			continue
		}
		id := cuid.New()
		if _, err := tx.ContentAngle.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
			SetHook(angle.Hook).SetPosition(position).SetTitle(angle.Key + " · " + angle.Title).Save(ctx); err != nil {
			if ent.IsConstraintError(err) {
				return nil, publishing.ErrConflict
			}
			return nil, err
		}
		position++
		angleIDs[angle.Key] = id
	}
	channels := []string{}
	builders := make([]*ent.CampaignPostCreate, 0, len(input.Posts))
	for _, post := range input.Posts {
		claims := post.Claims
		if claims == nil {
			claims = []map[string]any{}
		}
		create := tx.CampaignPost.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
			SetChannel(post.Channel).SetClaims(claims).SetCopy(post.Copy).SetPhase(post.Phase).SetPlanItemKey(post.AngleKey).
			SetPlanVersion(input.PlanVersion).SetSpecVersion(input.SpecVersion).SetStatus(campaignpost.StatusDRAFT)
		if id, ok := angleIDs[post.AngleKey]; ok {
			create.SetAngleID(id)
		}
		if post.CallToAction != "" {
			create.SetCallToAction(post.CallToAction)
		}
		if post.Title != "" {
			create.SetTitle(post.Title)
		}
		builders = append(builders, create)
		if !slices.Contains(channels, post.Channel) {
			channels = append(channels, post.Channel)
		}
	}
	if _, err := tx.CampaignPost.CreateBulk(builders...).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_copy_generated", "campaign", campaignID,
		launchMetadata(map[string]any{"angleCount": len(angleIDs), "channels": strings.Join(channels, ","),
			"postCount": len(input.Posts), "specVersion": input.SpecVersion}, input.Metadata)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &LaunchPostsResult{AngleCount: len(angleIDs), PostCount: len(input.Posts)}, nil
}

// ----------------------------------------------------------- revisions --

type LaunchRevision struct {
	CampaignID string          `json:"campaignId"`
	Comment    string          `json:"comment"`
	CreatedAt  time.Time       `json:"createdAt"`
	DecidedAt  *time.Time      `json:"decidedAt"`
	ID         string          `json:"id"`
	ModelID    *string         `json:"modelId"`
	Proposal   json.RawMessage `json:"proposal"`
	Status     string          `json:"status"`
	TargetID   string          `json:"targetId"`
	TargetKey  *string         `json:"targetKey"`
	TargetType string          `json:"targetType"`
}

func launchRevision(row *ent.CampaignRevision) LaunchRevision {
	return LaunchRevision{CampaignID: row.CampaignID, Comment: row.Comment, CreatedAt: row.CreatedAt,
		DecidedAt: row.DecidedAt, ID: row.ID, ModelID: row.ModelID, Proposal: row.Proposal, Status: string(row.Status),
		TargetID: row.TargetID, TargetKey: row.TargetKey, TargetType: row.TargetType}
}

// revisionChange is one change in a stored proposal (RevisionChange in
// lib/launch/spec-schema.ts).
type revisionChange struct {
	After      json.RawMessage `json:"after"`
	Before     json.RawMessage `json:"before"`
	Label      string          `json:"label"`
	TargetID   string          `json:"targetId"`
	TargetKey  *string         `json:"targetKey"`
	TargetType string          `json:"targetType"`
}

type revisionProposal struct {
	Primary revisionChange   `json:"primary"`
	Related []revisionChange `json:"related"`
}

type CreateLaunchRevisionInput struct {
	Comment  string          `json:"comment"`
	ModelID  *string         `json:"modelId"`
	Proposal json.RawMessage `json:"proposal"`
}

type ApplyLaunchRevisionInput struct {
	// The patched document for each design change, computed by the web
	// facade, which owns the design document format.
	DesignDocuments map[string]map[string]any `json:"designDocuments"`
	Related         []int                     `json:"related"`
}

type LaunchRevisionApplied struct {
	DesignIDs []string       `json:"designIds"`
	Revision  LaunchRevision `json:"revision"`
}

func (c *Configuration) CreateLaunchRevision(ctx context.Context, actor Actor, campaignID string, input CreateLaunchRevisionInput) (*LaunchRevision, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	var proposal revisionProposal
	if strings.TrimSpace(input.Comment) == "" || json.Unmarshal(input.Proposal, &proposal) != nil ||
		!slices.Contains([]string{"spec_section", "post", "design", "plan"}, proposal.Primary.TargetType) ||
		proposal.Primary.TargetID == "" {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	exists, err := tx.Campaign.Query().Where(campaign.ID(campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, launchNotFound("Campaign")
	}
	now := time.Now().UTC()
	row, err := tx.CampaignRevision.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetCampaignID(campaignID).
		SetComment(input.Comment).SetNillableModelID(input.ModelID).SetProposal(input.Proposal).
		SetTargetID(proposal.Primary.TargetID).SetNillableTargetKey(proposal.Primary.TargetKey).
		SetTargetType(proposal.Primary.TargetType).SetNillableCreatedByUserID(launchUserID(actor)).
		SetCreatedAt(now).SetUpdatedAt(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_revision_proposed", "campaign_revision", row.ID,
		map[string]any{"campaignId": campaignID, "related": len(proposal.Related), "targetType": proposal.Primary.TargetType}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchRevision(row)
	return &result, nil
}

// ListLaunchRevisions returns a campaign's 50 newest proposals.
func (c *Configuration) ListLaunchRevisions(ctx context.Context, actor Actor, campaignID string) ([]LaunchRevision, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.CampaignRevision.Query().Where(campaignrevision.OrganizationID(actor.OrganizationID),
		campaignrevision.CampaignID(campaignID)).Order(ent.Desc(campaignrevision.FieldCreatedAt)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]LaunchRevision, 0, len(rows))
	for _, row := range rows {
		items = append(items, launchRevision(row))
	}
	return items, nil
}

func (c *Configuration) GetLaunchRevision(ctx context.Context, actor Actor, id string) (*LaunchRevision, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.CampaignRevision.Query().Where(campaignrevision.ID(id),
		campaignrevision.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Revision")
	}
	if err != nil {
		return nil, err
	}
	result := launchRevision(row)
	return &result, nil
}

// decideLaunchRevision loads a proposal and marks it decided. The update is
// conditional on PROPOSED, so a concurrent decision waits on the row and
// then finds it already decided.
func decideLaunchRevision(ctx context.Context, tx *ent.Tx, actor Actor, id string, status campaignrevision.Status) (*ent.CampaignRevision, error) {
	row, err := tx.CampaignRevision.Query().Where(campaignrevision.ID(id), campaignrevision.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Revision")
	}
	if err != nil {
		return nil, err
	}
	if err := mutableCampaign(ctx, tx, actor, row.CampaignID); err != nil {
		return nil, err
	}
	if row.Status != campaignrevision.StatusPROPOSED {
		return nil, errLaunchDecided
	}
	updated, err := tx.CampaignRevision.UpdateOneID(row.ID).Where(campaignrevision.StatusEQ(campaignrevision.StatusPROPOSED)).
		SetStatus(status).SetDecidedAt(time.Now().UTC()).SetNillableDecidedByUserID(launchUserID(actor)).Save(ctx)
	if ent.IsNotFound(err) {
		return nil, errLaunchDecided
	}
	return updated, err
}

// ApplyLaunchRevision applies the primary change and the chosen related
// changes, all or nothing, and returns the designs that need a new render.
func (c *Configuration) ApplyLaunchRevision(ctx context.Context, actor Actor, id string, input ApplyLaunchRevisionInput) (*LaunchRevisionApplied, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	revision, err := decideLaunchRevision(ctx, tx, actor, id, campaignrevision.StatusAPPLIED)
	if err != nil {
		return nil, err
	}
	var proposal revisionProposal
	if err := json.Unmarshal(revision.Proposal, &proposal); err != nil {
		return nil, err
	}
	chosen := make([]revisionChange, 0, len(input.Related))
	for _, index := range input.Related {
		if index < 0 || index >= len(proposal.Related) {
			return nil, errLaunchRelated
		}
		chosen = append(chosen, proposal.Related[index])
	}
	designIDs := []string{}
	var specVersions *[2]int
	for _, change := range append([]revisionChange{proposal.Primary}, chosen...) {
		designID, versions, err := applyLaunchChange(ctx, tx, actor, revision, change, input.DesignDocuments)
		if err != nil {
			return nil, err
		}
		if designID != "" {
			designIDs = append(designIDs, designID)
		}
		if versions != nil {
			specVersions = versions
		}
	}
	if specVersions != nil && revision.TargetKey != nil {
		if err := moveLaunchPosts(ctx, tx, revision, *specVersions, chosen); err != nil {
			return nil, err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_revision_applied", "campaign_revision", revision.ID,
		map[string]any{"campaignId": revision.CampaignID, "relatedApplied": len(chosen), "targetType": revision.TargetType}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &LaunchRevisionApplied{DesignIDs: designIDs, Revision: launchRevision(revision)}, nil
}

// applyLaunchChange applies one change of a proposal. Each target is
// guarded against edits made after the proposal: a post's copy, a newer spec
// or plan version, or a design's updatedAt.
func applyLaunchChange(ctx context.Context, tx *ent.Tx, actor Actor, revision *ent.CampaignRevision, change revisionChange, documents map[string]map[string]any) (string, *[2]int, error) {
	organizationID := actor.OrganizationID
	switch change.TargetType {
	case "post":
		post, err := tx.CampaignPost.Query().Where(campaignpost.ID(change.TargetID), campaignpost.CampaignID(revision.CampaignID),
			campaignpost.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return "", nil, launchNotFound("Post")
		}
		if err != nil {
			return "", nil, err
		}
		var before struct {
			Copy string `json:"copy"`
		}
		_ = json.Unmarshal(change.Before, &before)
		if post.Copy != before.Copy {
			return "", nil, errLaunchStale
		}
		var after struct {
			CallToAction string           `json:"callToAction"`
			Claims       []map[string]any `json:"claims"`
			Copy         string           `json:"copy"`
			Title        string           `json:"title"`
		}
		if json.Unmarshal(change.After, &after) != nil {
			return "", nil, ErrInvalidInput
		}
		if after.Claims == nil {
			after.Claims = []map[string]any{}
		}
		return "", nil, revisePost(ctx, tx, post, before.Copy, errLaunchStale, postRevision{CallToAction: &after.CallToAction,
			Claims: after.Claims, Copy: &after.Copy, Title: &after.Title})
	case "spec_section":
		spec, err := tx.ReleaseSpec.Query().Where(releasespec.ID(change.TargetID), releasespec.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return "", nil, launchNotFound("Spec")
		}
		if err != nil {
			return "", nil, err
		}
		newer, err := tx.ReleaseSpec.Query().Where(releasespec.ReleaseID(spec.ReleaseID), releasespec.VersionGT(spec.Version)).Exist(ctx)
		if err != nil {
			return "", nil, err
		}
		if newer {
			return "", nil, errLaunchStale
		}
		var content map[string]json.RawMessage
		if change.TargetKey == nil || len(change.After) == 0 || json.Unmarshal(spec.Content, &content) != nil || content == nil {
			return "", nil, ErrInvalidInput
		}
		section := *change.TargetKey
		content[section] = change.After
		merged, err := json.Marshal(content)
		if err != nil {
			return "", nil, err
		}
		created, err := tx.ReleaseSpec.Create().SetID(cuid.New()).SetOrganizationID(organizationID).SetReleaseID(spec.ReleaseID).
			SetVersion(spec.Version + 1).SetOrigin("revision").SetContent(merged).SetSources(spec.Sources).
			SetChangeSummary(launchTruncate("Revised "+strings.ToLower(change.Label)+": "+revision.Comment, 500)).
			SetNillableCreatedByUserID(launchUserID(actor)).SetCreatedAt(time.Now().UTC()).Save(ctx)
		if ent.IsConstraintError(err) {
			return "", nil, errLaunchStale
		}
		if err != nil {
			return "", nil, err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.release_spec_updated", "release_spec", created.ID,
			map[string]any{"origin": "revision", "section": section, "version": created.Version}); err != nil {
			return "", nil, err
		}
		return "", &[2]int{spec.Version, created.Version}, nil
	case "plan":
		plan, err := tx.CampaignPlan.Query().Where(campaignplan.ID(change.TargetID), campaignplan.CampaignID(revision.CampaignID),
			campaignplan.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return "", nil, launchNotFound("Plan")
		}
		if err != nil {
			return "", nil, err
		}
		newer, err := tx.CampaignPlan.Query().Where(campaignplan.CampaignID(revision.CampaignID), campaignplan.VersionGT(plan.Version)).Exist(ctx)
		if err != nil {
			return "", nil, err
		}
		if newer {
			return "", nil, errLaunchStale
		}
		if !launchObject(change.After) {
			return "", nil, ErrInvalidInput
		}
		created, err := tx.CampaignPlan.Create().SetID(cuid.New()).SetOrganizationID(organizationID).SetCampaignID(revision.CampaignID).
			SetVersion(plan.Version + 1).SetOrigin("revision").SetContent(change.After).SetNillableSpecID(plan.SpecID).
			SetChangeSummary(launchTruncate("Revised: "+revision.Comment, 500)).
			SetNillableCreatedByUserID(launchUserID(actor)).SetCreatedAt(time.Now().UTC()).Save(ctx)
		if ent.IsConstraintError(err) {
			return "", nil, errLaunchStale
		}
		if err != nil {
			return "", nil, err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_plan_updated", "campaign_plan", created.ID,
			map[string]any{"origin": "revision", "version": created.Version}); err != nil {
			return "", nil, err
		}
		return "", nil, nil
	case "design":
		row, err := tx.Design.Query().Where(design.ID(change.TargetID), design.CampaignID(revision.CampaignID),
			design.OrganizationID(organizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return "", nil, launchNotFound("Design")
		}
		if err != nil {
			return "", nil, err
		}
		var before struct {
			UpdatedAt time.Time `json:"updatedAt"`
		}
		if json.Unmarshal(change.Before, &before) != nil ||
			!before.UpdatedAt.Truncate(time.Millisecond).Equal(row.UpdatedAt.Truncate(time.Millisecond)) {
			return "", nil, errLaunchStale
		}
		document, ok := documents[row.ID]
		if !ok {
			return "", nil, ErrInvalidInput
		}
		// The renderer signs whatever a design names: only this workspace's assets.
		if err := requireDesignAssets(ctx, tx, organizationID, document); err != nil {
			return "", nil, err
		}
		// The old render no longer matches; the next render replaces it.
		if err := tx.Design.UpdateOneID(row.ID).SetDocument(document).ClearCritique().ClearRenderKey().Exec(ctx); err != nil {
			return "", nil, err
		}
		return row.ID, nil, nil
	}
	return "", nil, ErrInvalidInput
}

// postRevision is an edit to a post. A nil field is unchanged; an empty call
// to action or title clears it.
type postRevision struct {
	CallToAction *string
	Claims       []map[string]any
	Copy         *string
	Title        *string
}

// revisePost edits a post's copy under the review rules. expectedCopy is the
// copy the edit was made against; a mismatch returns stale. Approved copy
// never changes in place: an edit sends it back to draft and clears the
// approval, and a post that may be live cannot be edited. The result must
// pass the brand's prohibited terms.
func revisePost(ctx context.Context, tx *ent.Tx, post *ent.CampaignPost, expectedCopy string, stale error, edit postRevision) error {
	if post.Copy != expectedCopy {
		return stale
	}
	copyText, title, callToAction := post.Copy, optionalText(post.Title), optionalText(post.CallToAction)
	if edit.Copy != nil {
		copyText = *edit.Copy
	}
	if edit.Title != nil {
		title = *edit.Title
	}
	if edit.CallToAction != nil {
		callToAction = *edit.CallToAction
	}
	if strings.TrimSpace(copyText) == "" {
		return ErrInvalidInput
	}
	if err := requireAllowedCopy(ctx, tx.Client(), post.OrganizationID, nil, title, copyText, callToAction); err != nil {
		return err
	}
	update := tx.CampaignPost.UpdateOneID(post.ID).Where(campaignpost.Copy(expectedCopy)).SetCopy(copyText)
	if edit.Claims != nil {
		update.SetClaims(edit.Claims)
	}
	switch post.Status {
	case campaignpost.StatusPUBLISHED:
		return conflict("This post is published and can no longer be edited.")
	case campaignpost.StatusSCHEDULED:
		if post.ScheduledPostID != nil {
			dead, err := tx.ScheduledPost.Query().Where(scheduledpost.ID(*post.ScheduledPostID),
				scheduledpost.OrganizationID(post.OrganizationID),
				scheduledpost.StatusIn(scheduledpost.StatusCANCELLED, scheduledpost.StatusFAILED)).Exist(ctx)
			if err != nil {
				return err
			}
			if !dead {
				return conflict("Cancel the scheduled post first.")
			}
		}
		update.SetStatus(campaignpost.StatusDRAFT).ClearScheduledPostID().ClearScheduledAt().
			ClearApprovedAt().ClearApprovedByUserID()
	case campaignpost.StatusAPPROVED:
		update.SetStatus(campaignpost.StatusDRAFT).ClearApprovedAt().ClearApprovedByUserID()
	case campaignpost.StatusNEEDS_CHANGES, campaignpost.StatusREJECTED:
		// Revised copy goes back through review.
		update.SetStatus(campaignpost.StatusDRAFT)
	}
	if callToAction == "" {
		update.ClearCallToAction()
	} else {
		update.SetCallToAction(callToAction)
	}
	if title == "" {
		update.ClearTitle()
	} else {
		update.SetTitle(title)
	}
	err := update.Exec(ctx)
	if ent.IsNotFound(err) {
		// The copy changed between the read and the write.
		return stale
	}
	return err
}

// moveLaunchPosts moves posts to a revised spec version when their claims
// still mean the same thing: posts updated with the revision, and posts that
// cite nothing in the revised section. Posts that cite the revised section
// and were not updated stay on the version they were written from.
func moveLaunchPosts(ctx context.Context, tx *ent.Tx, revision *ent.CampaignRevision, versions [2]int, chosen []revisionChange) error {
	updated := []string{}
	for _, change := range chosen {
		if change.TargetType == "post" {
			updated = append(updated, change.TargetID)
		}
	}
	posts, err := tx.CampaignPost.Query().Where(campaignpost.CampaignID(revision.CampaignID),
		campaignpost.OrganizationID(revision.OrganizationID),
		// An updated post may come from an earlier version whose claims still held.
		campaignpost.Or(campaignpost.SpecVersion(versions[0]), campaignpost.IDIn(updated...))).All(ctx)
	if err != nil {
		return err
	}
	citesSection := func(claims []map[string]any) bool {
		return slices.ContainsFunc(claims, func(claim map[string]any) bool {
			ref, ok := claim["ref"].(string)
			section, _, _ := strings.Cut(ref, ".")
			return ok && section == *revision.TargetKey
		})
	}
	movable := []string{}
	for _, post := range posts {
		if slices.Contains(updated, post.ID) ||
			(post.SpecVersion != nil && *post.SpecVersion == versions[0] && !citesSection(post.Claims)) {
			movable = append(movable, post.ID)
		}
	}
	if len(movable) == 0 {
		return nil
	}
	return tx.CampaignPost.Update().Where(campaignpost.IDIn(movable...)).SetSpecVersion(versions[1]).Exec(ctx)
}

func (c *Configuration) DiscardLaunchRevision(ctx context.Context, actor Actor, id string) (*LaunchRevision, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	revision, err := decideLaunchRevision(ctx, tx, actor, id, campaignrevision.StatusDISCARDED)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_revision_discarded", "campaign_revision", revision.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchRevision(revision)
	return &result, nil
}

// SetLaunchDesignCritique stores the review of a design's latest render.
func (c *Configuration) SetLaunchDesignCritique(ctx context.Context, actor Actor, id string, critique map[string]any) error {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return err
	}
	if critique == nil {
		return ErrInvalidInput
	}
	count, err := c.client.Design.Update().Where(design.ID(id), design.OrganizationID(actor.OrganizationID)).SetCritique(critique).Save(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return launchNotFound("Design")
	}
	return nil
}

// --------------------------------------------------------- preferences --

type LaunchApprovedExample struct {
	Channel string  `json:"channel"`
	Copy    string  `json:"copy"`
	Title   *string `json:"title"`
}

type LaunchRejectedExample struct {
	Channel    string  `json:"channel"`
	Copy       string  `json:"copy"`
	ReviewNote *string `json:"reviewNote"`
	Status     string  `json:"status"`
}

type LaunchRevisionExample struct {
	Comment    string          `json:"comment"`
	Proposal   json.RawMessage `json:"proposal"`
	TargetType string          `json:"targetType"`
}

type LaunchPreferenceExamples struct {
	Approved  []LaunchApprovedExample `json:"approved"`
	Rejected  []LaunchRejectedExample `json:"rejected"`
	Revisions []LaunchRevisionExample `json:"revisions"`
}

// GetLaunchPreferences returns the workspace's review history, newest
// first: approved and rejected posts and applied revisions.
func (c *Configuration) GetLaunchPreferences(ctx context.Context, actor Actor) (*LaunchPreferenceExamples, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	result := &LaunchPreferenceExamples{Approved: []LaunchApprovedExample{}, Rejected: []LaunchRejectedExample{},
		Revisions: []LaunchRevisionExample{}}
	approved, err := c.client.CampaignPost.Query().Where(campaignpost.OrganizationID(actor.OrganizationID),
		campaignpost.StatusIn(campaignpost.StatusAPPROVED, campaignpost.StatusSCHEDULED, campaignpost.StatusPUBLISHED)).
		Order(ent.Desc(campaignpost.FieldUpdatedAt)).Limit(40).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, post := range approved {
		result.Approved = append(result.Approved, LaunchApprovedExample{post.Channel, post.Copy, post.Title})
	}
	rejected, err := c.client.CampaignPost.Query().Where(campaignpost.OrganizationID(actor.OrganizationID),
		campaignpost.StatusIn(campaignpost.StatusREJECTED, campaignpost.StatusNEEDS_CHANGES)).
		Order(ent.Desc(campaignpost.FieldUpdatedAt)).Limit(8).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, post := range rejected {
		result.Rejected = append(result.Rejected, LaunchRejectedExample{post.Channel, post.Copy, post.ReviewNote, string(post.Status)})
	}
	revisions, err := c.client.CampaignRevision.Query().Where(campaignrevision.OrganizationID(actor.OrganizationID),
		campaignrevision.StatusEQ(campaignrevision.StatusAPPLIED)).
		Order(ent.Desc(campaignrevision.FieldDecidedAt)).Limit(8).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, revision := range revisions {
		result.Revisions = append(result.Revisions, LaunchRevisionExample{revision.Comment, revision.Proposal, revision.TargetType})
	}
	return result, nil
}

// ---------------------------------------------------------------- runs --

type LaunchRunRecord struct {
	// CampaignID is null for an agent run that has no campaign yet.
	CampaignID *string    `json:"campaignId"`
	CostCents  int        `json:"costCents"`
	Error      *string    `json:"error"`
	FinishedAt *time.Time `json:"finishedAt"`
	// HeartbeatAt is the last time the worker reported it was alive.
	HeartbeatAt *time.Time `json:"heartbeatAt"`
	ID          string     `json:"id"`
	Kind        string     `json:"kind"`
	ResultID    *string    `json:"resultId"`
	StartedAt   time.Time  `json:"startedAt"`
	Status      string     `json:"status"`
	StepCount   int        `json:"stepCount"`
	Summary     *string    `json:"summary"`
	TokensIn    int        `json:"tokensIn"`
	TokensOut   int        `json:"tokensOut"`
}

func launchRunRecord(row *ent.LaunchRun) LaunchRunRecord {
	return LaunchRunRecord{CampaignID: row.CampaignID, CostCents: row.CostCents, Error: row.Error, FinishedAt: row.FinishedAt,
		HeartbeatAt: row.HeartbeatAt, ID: row.ID, Kind: row.Kind, ResultID: row.ResultID, StartedAt: row.StartedAt,
		Status: string(row.Status), StepCount: row.StepCount, Summary: row.Summary, TokensIn: row.TokensIn, TokensOut: row.TokensOut}
}

// FinishLaunchRunInput ends a run. The counters are an agent run's totals;
// an omitted counter is left as it is.
type FinishLaunchRunInput struct {
	CostCents *int    `json:"costCents"`
	Error     *string `json:"error"`
	ResultID  *string `json:"resultId"`
	Status    string  `json:"status"`
	StepCount *int    `json:"stepCount"`
	Summary   *string `json:"summary"`
	TokensIn  *int    `json:"tokensIn"`
	TokensOut *int    `json:"tokensOut"`
}

// StartLaunchRun records a background AI run. One run of each kind per
// campaign at a time, except revisions. It needs the workspace's AI switch on.
func (c *Configuration) StartLaunchRun(ctx context.Context, actor Actor, campaignID, kind string) (*LaunchRunRecord, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if !slices.Contains(launchRunKinds, kind) {
		return nil, ErrInvalidInput
	}
	if err := c.RequireAIAgent(ctx, actor); err != nil {
		return nil, err
	}
	return c.startLaunchRun(ctx, actor, &campaignID, kind)
}

// startLaunchRun records a run once the caller authorized it. A run without
// a campaign holds no slot.
func (c *Configuration) startLaunchRun(ctx context.Context, actor Actor, campaignID *string, kind string) (*LaunchRunRecord, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if campaignID != nil && kind != "conversation" {
		if err := mutableCampaign(ctx, tx, actor, *campaignID); err != nil {
			return nil, err
		}
	}
	now := time.Now().UTC()
	if campaignID != nil {
		exists, err := tx.Campaign.Query().Where(campaign.ID(*campaignID), campaign.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, launchNotFound("Campaign")
		}
	}
	if campaignID != nil && kind != "revision" {
		// A dead run gives up its slot here; the partial unique index on
		// running runs then admits exactly one of concurrent starts.
		expired, err := tx.LaunchRun.Query().Where(launchrun.CampaignID(*campaignID), launchrun.Kind(kind),
			launchrun.OrganizationID(actor.OrganizationID), launchrun.StatusEQ(launchrun.StatusRUNNING),
			launchrun.Or(launchrun.HeartbeatAtLT(now.Add(-launchRunHeartbeatStaleAfter)),
				launchrun.And(launchrun.HeartbeatAtIsNil(), launchrun.StartedAtLT(now.Add(-launchRunStaleAfter))))).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, run := range expired {
			changed, err := tx.LaunchRun.Update().Where(launchrun.ID(run.ID), launchrun.StatusEQ(launchrun.StatusRUNNING), launchrun.Or(launchrun.HeartbeatAtLT(now.Add(-launchRunHeartbeatStaleAfter)), launchrun.And(launchrun.HeartbeatAtIsNil(), launchrun.StartedAtLT(now.Add(-launchRunStaleAfter))))).SetStatus(launchrun.StatusFAILED).SetFinishedAt(now).SetError("The run stopped responding.").Save(ctx)
			if err != nil {
				return nil, err
			}
			if changed > 0 {
				if err = activity.Emit(ctx, tx, actor.OrganizationID, "generation.failed", "launch_run", run.ID, "", run.ID, map[string]any{"background": true}); err != nil {
					return nil, err
				}
			}
		}
	}
	row, err := tx.LaunchRun.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetNillableCampaignID(campaignID).
		SetKind(kind).SetNillableCreatedByUserID(launchUserID(actor)).SetStartedAt(now).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, errLaunchRunActive
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := launchRunRecord(row)
	return &result, nil
}

func (c *Configuration) FinishLaunchRun(ctx context.Context, actor Actor, id string, input FinishLaunchRunInput) error {
	if _, err := c.authorizeLaunchRun(ctx, actor, id); err != nil {
		return err
	}
	// CANCELLED is set only by CancelLaunchRun.
	status := launchrun.Status(input.Status)
	if status != launchrun.StatusSUCCEEDED && status != launchrun.StatusFAILED && status != launchrun.StatusBUDGET_EXHAUSTED {
		return ErrInvalidInput
	}
	for _, counter := range []*int{input.CostCents, input.StepCount, input.TokensIn, input.TokensOut} {
		if counter != nil && *counter < 0 {
			return ErrInvalidInput
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Only a running run finishes; a cancelled or expired one stays as it is.
	count, err := tx.LaunchRun.Update().Where(launchrun.ID(id), launchrun.OrganizationID(actor.OrganizationID),
		launchrun.StatusEQ(launchrun.StatusRUNNING)).
		SetStatus(status).SetFinishedAt(time.Now().UTC()).SetNillableResultID(input.ResultID).
		SetNillableSummary(input.Summary).SetNillableError(input.Error).
		SetNillableCostCents(input.CostCents).SetNillableStepCount(input.StepCount).
		SetNillableTokensIn(input.TokensIn).SetNillableTokensOut(input.TokensOut).Save(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return c.launchRunExists(ctx, actor, id)
	}
	kind := map[launchrun.Status]string{launchrun.StatusSUCCEEDED: "generation.completed", launchrun.StatusFAILED: "generation.failed", launchrun.StatusBUDGET_EXHAUSTED: "generation.budget_exhausted"}[status]
	if err = activity.Emit(ctx, tx, actor.OrganizationID, kind, "launch_run", id, "", id, map[string]any{"background": true}); err != nil {
		return err
	}
	return tx.Commit()
}

// HeartbeatLaunchRun records that a run's worker is alive and reports whether
// the run is still RUNNING. A worker stops when it is not.
func (c *Configuration) HeartbeatLaunchRun(ctx context.Context, actor Actor, id string) (bool, error) {
	if _, err := c.authorizeLaunchRun(ctx, actor, id); err != nil {
		return false, err
	}
	count, err := c.client.LaunchRun.Update().Where(launchrun.ID(id), launchrun.OrganizationID(actor.OrganizationID),
		launchrun.StatusEQ(launchrun.StatusRUNNING)).SetHeartbeatAt(time.Now().UTC()).Save(ctx)
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, c.launchRunExists(ctx, actor, id)
	}
	return true, nil
}

// CancelLaunchRun stops a running run and reports whether it did. The worker
// sees it on its next heartbeat and stops. An agent run ends CANCELLED; a
// pipeline run ends FAILED with "Cancelled.", which is what the web released
// with SDK 0.1.13 renders.
func (c *Configuration) CancelLaunchRun(ctx context.Context, actor Actor, id string) (bool, error) {
	if _, err := c.authorizeLaunchRun(ctx, actor, id); err != nil {
		return false, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	running := []predicate.LaunchRun{launchrun.ID(id), launchrun.OrganizationID(actor.OrganizationID), launchrun.StatusEQ(launchrun.StatusRUNNING)}
	count, err := tx.LaunchRun.Update().Where(append(running, launchrun.KindIn(agentRunKinds...))...).
		SetStatus(launchrun.StatusCANCELLED).SetFinishedAt(now).SetError("Cancelled.").Save(ctx)
	if err == nil && count == 0 {
		count, err = tx.LaunchRun.Update().Where(append(running, launchrun.KindNotIn(agentRunKinds...))...).
			SetStatus(launchrun.StatusFAILED).SetFinishedAt(now).SetError("Cancelled.").Save(ctx)
	}
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, c.launchRunExists(ctx, actor, id)
	}
	if err = activity.Emit(ctx, tx, actor.OrganizationID, "generation.cancelled", "launch_run", id, actor.UserID, id, nil); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// launchRunExists answers nil for a run of this workspace, else not found.
func (c *Configuration) launchRunExists(ctx context.Context, actor Actor, id string) error {
	exists, err := c.client.LaunchRun.Query().Where(launchrun.ID(id), launchrun.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return launchNotFound("Run")
	}
	return nil
}

func (c *Configuration) GetLaunchRun(ctx context.Context, actor Actor, id string) (*LaunchRunRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.LaunchRun.Query().Where(launchrun.ID(id), launchrun.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Run")
	}
	if err != nil {
		return nil, err
	}
	result := launchRunRecord(row)
	return &result, nil
}

// ListLaunchRuns returns a campaign's 40 newest runs.
func (c *Configuration) ListLaunchRuns(ctx context.Context, actor Actor, campaignID string) ([]LaunchRunRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.LaunchRun.Query().Where(launchrun.OrganizationID(actor.OrganizationID), launchrun.CampaignID(campaignID)).
		Order(ent.Desc(launchrun.FieldStartedAt)).Limit(40).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]LaunchRunRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, launchRunRecord(row))
	}
	return items, nil
}
