package product

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/captureattempt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturerecipe"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

const (
	// EventCaptureJobDispatch and EventCaptureConnectionFinish start durable
	// capture work; their payloads hold only IDs.
	EventCaptureJobDispatch      = "capture_job.dispatch"
	EventCaptureConnectionFinish = "capture_connection.finish"

	captureLease        = 5 * time.Minute
	captureRunKeepAlive = 3 * time.Minute
	captureJobDeadline  = 30 * time.Minute
	// A person may take days to reconnect; no browser or lease waits for them.
	captureAuthDeadline = 7 * 24 * time.Hour
	// One active capture per workspace, RFC 007's first limit, keeps a stalled
	// page from taking browsers that other tenants need.
	captureTenantLimit = 1
	captureMaxBackoff  = 2 * time.Minute
)

func captureOutbox(ctx context.Context, tx *ent.Tx, org, kind, aggregateType, id, key string) error {
	return tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(org).SetType(kind).SetAggregateType(aggregateType).SetAggregateID(id).
		SetPayload(map[string]any{"id": id}).SetIdempotencyKey(kind + ":" + id + ":" + key).Exec(ctx)
}

func (c *Configuration) dispatchCaptureJob(ctx context.Context, org, id string) error {
	if c.captureDispatcher == nil {
		return ErrAuthenticatedCaptureUnavailable
	}
	job, err := c.client.CaptureJob.Query().Where(capturejob.ID(id), capturejob.OrganizationID(org)).Only(ctx)
	if ent.IsNotFound(err) {
		return ErrNotEligible
	}
	if err != nil {
		return err
	}
	return c.captureDispatcher.StartCaptureJob(ctx, org, id, job.ResumeCount)
}

func (c *Configuration) dispatchCaptureConnection(ctx context.Context, org, id string) error {
	if c.captureDispatcher == nil {
		return ErrAuthenticatedCaptureUnavailable
	}
	return c.captureDispatcher.StartCaptureConnection(ctx, org, id)
}

// CaptureJobRecord is a job's status: IDs and safe codes, no browser state.
type CaptureJobRecord struct {
	ID                string    `json:"id"`
	RecipeID          string    `json:"recipeId"`
	RecipeVersion     int       `json:"recipeVersion"`
	Kind              string    `json:"kind"`
	Phase             string    `json:"phase"`
	SurfaceID         *string   `json:"surfaceId"`
	ConnectionID      *string   `json:"connectionId"`
	DeploymentEventID *string   `json:"deploymentEventId"`
	ExpectedRevision  *string   `json:"expectedRevision"`
	SurfaceCaptureID  *string   `json:"surfaceCaptureId"`
	AssetID           *string   `json:"assetId"`
	FailureCode       *string   `json:"failureCode"`
	Attempts          int       `json:"attempts"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

func captureJobRecord(row *ent.CaptureJob) CaptureJobRecord {
	return CaptureJobRecord{ID: row.ID, RecipeID: row.RecipeID, RecipeVersion: row.RecipeVersion, Kind: string(row.Kind), Phase: string(row.Phase), SurfaceID: row.SurfaceID, ConnectionID: row.AppConnectionID,
		DeploymentEventID: row.DeploymentEventID, ExpectedRevision: row.ExpectedRevision, SurfaceCaptureID: row.SurfaceCaptureID, AssetID: row.AssetID, FailureCode: row.FailureCode, Attempts: row.Attempts, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func decodeCaptureRecipe(row *ent.CaptureRecipe) (browser.Recipe, error) {
	var recipe browser.Recipe
	body, err := json.Marshal(row.Definition)
	if err != nil {
		return recipe, err
	}
	return recipe, json.Unmarshal(body, &recipe)
}

// admitCaptureJob is the one way a capture job is created: a test, a person's
// or agent's request, the deployment trigger, and the workflow action all arrive
// here. The same key always finds the same job.
func admitCaptureJob(ctx context.Context, tx *ent.Tx, actor Actor, recipe *ent.CaptureRecipe, connection *ent.PlatformAppConnection, kind capturejob.Kind, deployment *ent.DeploymentEvent, key string, triggerRunID *string) (*ent.CaptureJob, error) {
	existing, err := tx.CaptureJob.Query().Where(capturejob.OrganizationID(actor.OrganizationID), capturejob.IdempotencyKey(key)).Only(ctx)
	if err == nil {
		return existing, nil
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	definition, err := decodeCaptureRecipe(recipe)
	if err != nil {
		return nil, err
	}
	create := tx.CaptureJob.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetRecipeID(recipe.ID).SetRecipeVersion(recipe.Version).SetKind(kind).SetIdempotencyKey(key).
		SetNillableSurfaceID(recipe.SurfaceID).SetNillableAppConnectionID(recipe.AppConnectionID).SetConnectionGeneration(connection.Generation).SetNillableRecipeHash(recipe.DefinitionHash).
		SetDeadlineAt(time.Now().UTC().Add(captureJobDeadline)).SetNillableTriggerRunID(triggerRunID)
	if actor.UserID != "" {
		create.SetRequestedByUserID(actor.UserID)
	}
	unproven := false
	if deployment != nil {
		create.SetDeploymentEventID(deployment.ID)
		// A release capture needs the deployed commit to compare the app against.
		if definition.Version != nil {
			if deployment.Sha == nil || *deployment.Sha == "" {
				unproven = true
			} else {
				create.SetExpectedRevision(*deployment.Sha)
			}
		}
	}
	if unproven {
		create.SetPhase(capturejob.PhaseFAILED).SetStatus(capturejob.StatusFAILED).SetFailureCode(string(browser.DeploymentUnverified))
	}
	job, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_job_admitted", "capture_job", job.ID, map[string]any{"kind": string(kind), "recipeVersion": recipe.Version}); err != nil {
		return nil, err
	}
	if !unproven {
		if err := captureOutbox(ctx, tx, actor.OrganizationID, EventCaptureJobDispatch, "capture_job", job.ID, "0"); err != nil {
			return nil, err
		}
	}
	return job, nil
}

// CaptureJobRequest asks for a capture now. Source and SourceID name an agent
// run, the same attribution a public capture records.
type CaptureJobRequest struct {
	Test     bool    `json:"test"`
	Source   string  `json:"source"`
	SourceID *string `json:"sourceId"`
}

// RequestCaptureJob runs a recipe now. A test may use a draft and never replaces
// the surface's current image; any other capture needs an active recipe.
func (c *Configuration) RequestCaptureJob(ctx context.Context, actor Actor, recipeID string, request CaptureJobRequest) (*CaptureJobRecord, error) {
	if (request.Source != "" && request.Source != "manual" && request.Source != "agent") || (request.SourceID != nil && (*request.SourceID == "" || utf8.RuneCountInString(*request.SourceID) > 128)) {
		return nil, ErrInvalidInput
	}
	test := request.Test
	var err error
	if test {
		err = c.authorizeAutomationAdmin(ctx, actor)
	} else {
		err = c.authorizeRoles(ctx, actor, launchEditRoles...)
	}
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	recipe, err := tx.CaptureRecipe.Query().Where(capturerecipe.ID(recipeID), capturerecipe.OrganizationID(actor.OrganizationID), capturerecipe.AppConnectionIDNotNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	kind := capturejob.KindManual
	if request.Source == "agent" {
		kind = capturejob.KindAgent
	}
	if test {
		kind = capturejob.KindTest
	}
	if recipe.Status == capturerecipe.StatusARCHIVED || (!test && recipe.Status != capturerecipe.StatusACTIVE) {
		return nil, publishing.ErrInvalidState
	}
	connection, err := tx.PlatformAppConnection.Query().Where(platformappconnection.ID(*recipe.AppConnectionID), platformappconnection.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if connection.Status == platformappconnection.StatusREVOKED {
		return nil, publishing.ErrInvalidState
	}
	job, err := admitCaptureJob(ctx, tx, actor, recipe, connection, kind, nil, string(kind)+":"+recipe.ID+":"+cuid.New(), request.SourceID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := captureJobRecord(job)
	return &record, nil
}

// activeRecipeVersion finds the version a workflow's recipe runs now. An owner
// activating a newer tested version replaces the one a workflow names; archiving
// leaves none, which stops the workflow. Each job still pins its version's exact
// bytes when it is admitted.
func activeRecipeVersion(ctx context.Context, recipes *ent.CaptureRecipeClient, org, id string) (*ent.CaptureRecipe, error) {
	named, err := recipes.Query().Where(capturerecipe.ID(id), capturerecipe.OrganizationID(org), capturerecipe.AppConnectionIDNotNil()).Only(ctx)
	if err != nil || named.Status == capturerecipe.StatusACTIVE {
		return named, err
	}
	return recipes.Query().Where(capturerecipe.OrganizationID(org), capturerecipe.Name(named.Name), capturerecipe.StatusEQ(capturerecipe.StatusACTIVE), capturerecipe.AppConnectionIDNotNil()).
		Order(ent.Desc(capturerecipe.FieldVersion)).First(ctx)
}

// admitDeploymentCaptures admits a job for each active recipe bound to the
// deployment's source and environment. A hostname match is never enough, and
// the payload's URL is never used. It returns the surfaces the jobs now own.
func (c *Configuration) admitDeploymentCaptures(ctx context.Context, deployment *ent.DeploymentEvent) (map[string]bool, error) {
	owned := map[string]bool{}
	connections, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.OrganizationID(deployment.OrganizationID), platformappconnection.SourceAppID(deployment.SourceAppID),
		platformappconnection.Environment(deployment.Environment), platformappconnection.StatusNEQ(platformappconnection.StatusREVOKED)).All(ctx)
	if err != nil || len(connections) == 0 {
		return owned, err
	}
	actor := Actor{OrganizationID: deployment.OrganizationID, Kind: "service", Display: "deployment", RequestID: deployment.ID}
	for _, connection := range connections {
		recipes, err := c.client.CaptureRecipe.Query().Where(capturerecipe.OrganizationID(deployment.OrganizationID), capturerecipe.AppConnectionID(connection.ID), capturerecipe.StatusEQ(capturerecipe.StatusACTIVE)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, recipe := range recipes {
			tx, err := c.client.Tx(ctx)
			if err != nil {
				return nil, err
			}
			if _, err := admitCaptureJob(ctx, tx, actor, recipe, connection, capturejob.KindDeployment, deployment, captureDeploymentKey(deployment.ID, recipe.ID, connection.Generation), nil); err != nil {
				_ = tx.Rollback()
				return nil, err
			}
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			if recipe.SurfaceID != nil {
				owned[*recipe.SurfaceID] = true
			}
		}
	}
	return owned, nil
}

func captureDeploymentKey(deploymentID, recipeID string, generation int) string {
	return fmt.Sprintf("deployment:%s:%s:%d", deploymentID, recipeID, generation)
}

// ListCaptureJobs shows recent jobs to any member.
func (c *Configuration) ListCaptureJobs(ctx context.Context, actor Actor) ([]CaptureJobRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.CaptureJob.Query().Where(capturejob.OrganizationID(actor.OrganizationID), capturejob.AppConnectionIDNotNil()).Order(ent.Desc(capturejob.FieldCreatedAt)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]CaptureJobRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, captureJobRecord(row))
	}
	return records, nil
}

// GetCaptureJob reads one job in the workspace.
func (c *Configuration) GetCaptureJob(ctx context.Context, actor Actor, id string) (*CaptureJobRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.CaptureJob.Query().Where(capturejob.ID(id), capturejob.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	record := captureJobRecord(row)
	return &record, nil
}

// CancelCaptureJob stops a job; a result arriving later cannot commit.
func (c *Configuration) CancelCaptureJob(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeAutomationAdmin(ctx, actor); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	n, err := tx.CaptureJob.Update().Where(capturejob.ID(id), capturejob.OrganizationID(actor.OrganizationID), capturejob.PhaseNotIn(capturejob.PhaseSUCCEEDED, capturejob.PhaseFAILED, capturejob.PhaseCANCELLED)).
		SetPhase(capturejob.PhaseCANCELLED).SetStatus(capturejob.StatusCANCELLED).SetFailureCode("cancelled").Save(ctx)
	if err != nil {
		return err
	}
	if n == 0 {
		exists, err := tx.CaptureJob.Query().Where(capturejob.ID(id), capturejob.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return err
		}
		if !exists {
			return publishing.ErrNotFound
		}
		return tx.Commit()
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_job_cancelled", "capture_job", id); err != nil {
		return err
	}
	return tx.Commit()
}

// CaptureJobOutcome tells the workflow whether to run the job again.
type CaptureJobOutcome struct {
	Done              bool `json:"done"`
	RetryAfterSeconds int  `json:"retryAfterSeconds"`
}

func captureDone() *CaptureJobOutcome { return &CaptureJobOutcome{Done: true} }

func captureRetry(attempts int) *CaptureJobOutcome {
	delay := 15 * time.Second << min(max(attempts-1, 0), 4)
	if delay > captureMaxBackoff {
		delay = captureMaxBackoff
	}
	return &CaptureJobOutcome{RetryAfterSeconds: int(delay / time.Second)}
}

// captureEligibility re-reads what authorizes a job. It runs before any
// external work and again before a result commits.
func (c *Configuration) captureEligibility(ctx context.Context, tx *ent.Tx, job *ent.CaptureJob) (string, error) {
	if err := c.auth.AuthorizeWorkspace(ctx, job.OrganizationID); err != nil {
		if errors.Is(err, publishing.ErrForbidden) || errors.Is(err, publishing.ErrUnauthorized) || errors.Is(err, publishing.ErrNotFound) {
			return "workspace_unavailable", nil
		}
		return "", err
	}
	if job.SurfaceID == nil {
		return "surface_missing", nil
	}
	surface, err := tx.ProductSurface.Query().Where(productsurface.ID(*job.SurfaceID), productsurface.OrganizationID(job.OrganizationID)).Exist(ctx)
	if err != nil {
		return "", err
	}
	if !surface {
		return "surface_missing", nil
	}
	recipe, err := tx.CaptureRecipe.Query().Where(capturerecipe.ID(job.RecipeID), capturerecipe.OrganizationID(job.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return "recipe_missing", nil
	}
	if err != nil {
		return "", err
	}
	if recipe.Status == capturerecipe.StatusARCHIVED {
		return "recipe_archived", nil
	}
	if job.DeploymentEventID != nil {
		deployment, err := tx.DeploymentEvent.Query().Where(deploymentevent.ID(*job.DeploymentEventID), deploymentevent.OrganizationID(job.OrganizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return "deployment_missing", nil
		}
		if err != nil {
			return "", err
		}
		active, err := tx.SourceApp.Query().Where(sourceapp.ID(deployment.SourceAppID), sourceapp.OrganizationID(job.OrganizationID), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Exist(ctx)
		if err != nil {
			return "", err
		}
		if !active {
			return "source_inactive", nil
		}
	}
	return "", nil
}

// captureClaim is what an attempt holds while it works outside a transaction.
type captureClaim struct {
	job        *ent.CaptureJob
	attempt    *ent.CaptureAttempt
	connection *ent.PlatformAppConnection
	recipe     *ent.CaptureRecipe
	token      int64
	// reusedAsset is an image an earlier attempt stored but did not commit.
	reusedAsset *ent.CaptureAttempt
}

func setCaptureJobTerminal(update *ent.CaptureJobUpdateOne, phase capturejob.Phase, code string) *ent.CaptureJobUpdateOne {
	status := map[capturejob.Phase]capturejob.Status{capturejob.PhaseFAILED: capturejob.StatusFAILED, capturejob.PhaseCANCELLED: capturejob.StatusCANCELLED, capturejob.PhaseSUCCEEDED: capturejob.StatusSUCCEEDED}[phase]
	update.SetPhase(phase).SetStatus(status)
	if code != "" {
		update.SetFailureCode(code)
	}
	return update
}

// claimCaptureJob checks eligibility and takes the connection's lease under one
// transaction. No remote call happens here.
func (c *Configuration) claimCaptureJob(ctx context.Context, org, id string) (*captureClaim, *CaptureJobOutcome, error) {
	now := time.Now().UTC()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback()
	job, err := tx.CaptureJob.Query().Where(capturejob.ID(id), capturejob.OrganizationID(org)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, captureDone(), nil
	}
	if err != nil {
		return nil, nil, err
	}
	switch job.Phase {
	case capturejob.PhaseSUCCEEDED, capturejob.PhaseFAILED, capturejob.PhaseCANCELLED, capturejob.PhaseNEEDS_AUTH:
		return nil, captureDone(), nil
	}
	end := func(phase capturejob.Phase, code string) (*captureClaim, *CaptureJobOutcome, error) {
		if err := setCaptureJobTerminal(job.Update(), phase, code).Exec(ctx); err != nil {
			return nil, nil, err
		}
		return nil, captureDone(), tx.Commit()
	}
	if job.DeadlineAt != nil && job.DeadlineAt.Before(now) {
		return end(capturejob.PhaseFAILED, "deadline_exceeded")
	}
	code, err := c.captureEligibility(ctx, tx, job)
	if err != nil {
		return nil, nil, err
	}
	if code != "" {
		return end(capturejob.PhaseCANCELLED, code)
	}
	if job.AppConnectionID == nil {
		return end(capturejob.PhaseFAILED, "connection_missing")
	}
	connection, err := lockCaptureConnection(ctx, tx, org, *job.AppConnectionID)
	if errors.Is(err, publishing.ErrNotFound) {
		return end(capturejob.PhaseCANCELLED, "connection_missing")
	}
	if err != nil {
		return nil, nil, err
	}
	switch {
	case connection.Status == platformappconnection.StatusREVOKED:
		return end(capturejob.PhaseCANCELLED, "connection_revoked")
	case job.ConnectionGeneration != connection.Generation:
		return end(capturejob.PhaseFAILED, "stale_authorization")
	case connection.StateExpiresAt != nil && connection.StateExpiresAt.Before(now):
		// Retention ends here: the state is deleted, not merely ignored.
		if err := connection.Update().SetStatus(platformappconnection.StatusNEEDS_AUTH).ClearStateCiphertext().ClearStateExpiresAt().Exec(ctx); err != nil {
			return nil, nil, err
		}
		fallthrough
	case connection.Status != platformappconnection.StatusREADY || connection.StateCiphertext == nil:
		if err := parkCaptureJob(ctx, tx, job, "needs_auth", now); err != nil {
			return nil, nil, err
		}
		return nil, captureDone(), tx.Commit()
	}
	busy := func() (*captureClaim, *CaptureJobOutcome, error) {
		return nil, captureRetry(job.Attempts + 1), tx.Commit()
	}
	if connection.LeaseExpiresAt != nil && connection.LeaseExpiresAt.After(now) && connection.LeaseJobID != nil && *connection.LeaseJobID != job.ID {
		return busy()
	}
	running, err := tx.CaptureAttempt.Query().Where(captureattempt.OrganizationID(org), captureattempt.StatusEQ(captureattempt.StatusRUNNING), captureattempt.CaptureJobIDNEQ(job.ID), captureattempt.StartedAtGT(now.Add(-captureLease))).Count(ctx)
	if err != nil {
		return nil, nil, err
	}
	if running >= captureTenantLimit {
		return busy()
	}
	recipe, err := tx.CaptureRecipe.Query().Where(capturerecipe.ID(job.RecipeID), capturerecipe.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, nil, err
	}
	// The pinned version must still be the bytes that were admitted.
	if job.RecipeHash != nil && (recipe.DefinitionHash == nil || *recipe.DefinitionHash != *job.RecipeHash) {
		return end(capturejob.PhaseFAILED, string(browser.RecipeInvalid))
	}
	reused, err := tx.CaptureAttempt.Query().Where(captureattempt.CaptureJobID(job.ID), captureattempt.AssetIDNotNil(), captureattempt.StatusNEQ(captureattempt.StatusSUCCEEDED)).Order(ent.Desc(captureattempt.FieldAttemptNumber)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, nil, err
	}
	token := connection.LeaseToken + 1
	if err := connection.Update().SetLeaseJobID(job.ID).SetLeaseToken(token).SetLeaseExpiresAt(now.Add(captureLease)).Exec(ctx); err != nil {
		return nil, nil, err
	}
	job, err = job.Update().SetPhase(capturejob.PhaseRUNNING).SetStatus(capturejob.StatusRUNNING).SetFencingToken(token).AddAttempts(1).Save(ctx)
	if err != nil {
		return nil, nil, err
	}
	attempt, err := tx.CaptureAttempt.Create().SetID(cuid.New()).SetOrganizationID(org).SetCaptureJobID(job.ID).SetRecipeID(job.RecipeID).SetRecipeVersion(job.RecipeVersion).SetSourceURL(connection.Origin).
		SetProvider("browser").SetStatus(captureattempt.StatusRUNNING).SetStartedAt(now).SetAttemptNumber(job.Attempts).SetFencingToken(token).Save(ctx)
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, nil, err
	}
	return &captureClaim{job: job, attempt: attempt, connection: connection, recipe: recipe, token: token, reusedAsset: reused}, nil, nil
}

// parkCaptureJob stops a job until a person signs in again. It holds no browser
// and no lease while it waits.
func parkCaptureJob(ctx context.Context, tx *ent.Tx, job *ent.CaptureJob, code string, now time.Time) error {
	if err := job.Update().SetPhase(capturejob.PhaseNEEDS_AUTH).SetStatus(capturejob.StatusQUEUED).SetFailureCode(code).SetDeadlineAt(now.Add(captureAuthDeadline)).Exec(ctx); err != nil {
		return err
	}
	if job.SurfaceID != nil {
		return activity.Emit(ctx, tx, job.OrganizationID, "capture.failed", "product_surface", *job.SurfaceID, "", "job:"+job.ID+":needs_auth", map[string]any{"background": true})
	}
	return nil
}

// resumeCaptureJobs repins unfinished jobs to the connection's new generation
// after a validated sign-in. A job parked for sign-in starts a new workflow.
func resumeCaptureJobs(ctx context.Context, tx *ent.Tx, org, connectionID string, generation int) error {
	parked, err := tx.CaptureJob.Query().Where(capturejob.OrganizationID(org), capturejob.AppConnectionID(connectionID), capturejob.PhaseIn(capturejob.PhaseNEEDS_AUTH, capturejob.PhaseQUEUED, capturejob.PhaseWAITING_DEPLOYMENT)).All(ctx)
	if err != nil {
		return err
	}
	for _, job := range parked {
		update := job.Update().SetConnectionGeneration(generation)
		if job.Phase == capturejob.PhaseNEEDS_AUTH {
			update.SetPhase(capturejob.PhaseQUEUED).SetStatus(capturejob.StatusQUEUED).ClearFailureCode().SetDeadlineAt(time.Now().UTC().Add(captureJobDeadline)).AddResumeCount(1)
			if err := captureOutbox(ctx, tx, org, EventCaptureJobDispatch, "capture_job", job.ID, fmt.Sprint(job.ResumeCount+1)); err != nil {
				return err
			}
		}
		if err := update.Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// RunCaptureJob performs one attempt: claim, browse, store, commit. Browser
// execution may repeat after a crash; the guarantee is one committed output.
func (c *Configuration) RunCaptureJob(ctx context.Context, org, id string) (*CaptureJobOutcome, error) {
	if !c.CaptureAvailable() {
		return nil, ErrAuthenticatedCaptureUnavailable
	}
	claim, outcome, err := c.claimCaptureJob(ctx, org, id)
	if err != nil || outcome != nil {
		return outcome, err
	}
	if claim.reusedAsset != nil {
		return c.commitCapture(ctx, claim, nil, *claim.reusedAsset.AssetID, claim.reusedAsset.ObservedRevision, false)
	}
	binding := captureBinding(claim.connection)
	binding.Generation = claim.job.ConnectionGeneration
	body, stale, err := c.captureKeys.Open(*claim.connection.StateCiphertext, binding)
	if err != nil {
		// Never fall back to anything: the person signs in again.
		return c.failCapture(ctx, claim, &browser.Failure{Code: browser.NeedsAuth})
	}
	state, err := browser.UnmarshalState(body)
	if err != nil {
		return c.failCapture(ctx, claim, &browser.Failure{Code: browser.NeedsAuth})
	}
	recipe, err := decodeCaptureRecipe(claim.recipe)
	if err != nil {
		return c.failCapture(ctx, claim, &browser.Failure{Code: browser.RecipeInvalid})
	}
	session, err := c.captureRunner.Allocate(ctx, claim.connection.Hosts, captureRunKeepAlive)
	if err != nil {
		return c.failCapture(ctx, claim, err)
	}
	// Recorded before browsing, so cleanup can reclaim it if this worker dies.
	if err := c.client.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetBrowserSessionID(session).Exec(ctx); err != nil {
		_ = c.captureRunner.Close(context.WithoutCancel(ctx), session)
		return nil, err
	}
	expected := ""
	if claim.job.ExpectedRevision != nil {
		expected = *claim.job.ExpectedRevision
	}
	result, runErr := c.captureRunner.Run(ctx, session, browser.RunInput{Target: captureTarget(claim.connection), Recipe: recipe, State: state, ExpectedRevision: expected})
	cleanup := context.WithoutCancel(ctx)
	if err := c.captureRunner.Close(cleanup, session); err == nil {
		if err := c.client.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetBrowserClosedAt(time.Now().UTC()).Exec(cleanup); err != nil {
			slog.Warn("capture browser close not recorded", "attempt", claim.attempt.ID)
		}
	}
	if runErr != nil {
		return c.failCapture(ctx, claim, runErr)
	}
	actor := Actor{OrganizationID: org, Kind: "service", Display: "capture", RequestID: claim.job.ID}
	if claim.job.RequestedByUserID != nil {
		actor.UserID = *claim.job.RequestedByUserID
	}
	stored, err := c.storeImage(ctx, actor, result.Image, http.DetectContentType(result.Image), "capture-"+claim.job.ID)
	if err != nil {
		return c.failCapture(ctx, claim, &browser.Failure{Code: browser.ProviderUnavailable})
	}
	update := c.client.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetAssetID(stored).SetRefusedRequests(result.RefusedRequests)
	var observed *string
	if result.ObservedRevision != "" {
		observed = &result.ObservedRevision
		update.SetObservedRevision(result.ObservedRevision)
	}
	if err := update.Exec(ctx); err != nil {
		return nil, err
	}
	var rotated *browser.State
	if result.State != nil {
		rotated = result.State
	} else if stale {
		rotated = state
	}
	return c.commitCapture(ctx, claim, rotated, stored, observed, stale)
}

// failCapture records why an attempt ended and releases the lease.
func (c *Configuration) failCapture(ctx context.Context, claim *captureClaim, cause error) (*CaptureJobOutcome, error) {
	code := browser.ProviderUnavailable
	var failure *browser.Failure
	if errors.As(cause, &failure) {
		code = failure.Code
	}
	ctx = context.WithoutCancel(ctx)
	now := time.Now().UTC()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	connection, err := lockCaptureConnection(ctx, tx, claim.job.OrganizationID, claim.connection.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetStatus(captureattempt.StatusFAILED).SetFailureCode(string(code)).SetCompletedAt(now).Exec(ctx); err != nil {
		return nil, err
	}
	job, err := tx.CaptureJob.Get(ctx, claim.job.ID)
	if err != nil {
		return nil, err
	}
	// Superseded by a cancellation, revocation, or a newer attempt: its record stands.
	if job.Phase != capturejob.PhaseRUNNING || job.FencingToken != claim.token {
		return captureDone(), tx.Commit()
	}
	if connection.LeaseJobID != nil && *connection.LeaseJobID == job.ID {
		if err := connection.Update().ClearLeaseJobID().ClearLeaseExpiresAt().Exec(ctx); err != nil {
			return nil, err
		}
	}
	outcome := captureDone()
	switch {
	case code == browser.NeedsAuth:
		// A sign-in generation is only downgraded by the attempt that used it.
		if connection.Status == platformappconnection.StatusREADY && connection.Generation == job.ConnectionGeneration {
			if err := connection.Update().SetStatus(platformappconnection.StatusNEEDS_AUTH).SetFailureCode(string(code)).Exec(ctx); err != nil {
				return nil, err
			}
		}
		if err := parkCaptureJob(ctx, tx, job, string(code), now); err != nil {
			return nil, err
		}
	case failure != nil && failure.Retryable() && (job.DeadlineAt == nil || job.DeadlineAt.After(now)):
		phase := capturejob.PhaseQUEUED
		if code == browser.WaitingForDeployment || code == browser.DeploymentUnverified {
			phase = capturejob.PhaseWAITING_DEPLOYMENT
		}
		if err := job.Update().SetPhase(phase).SetStatus(capturejob.StatusQUEUED).SetFailureCode(string(code)).Exec(ctx); err != nil {
			return nil, err
		}
		outcome = captureRetry(job.Attempts)
	default:
		if err := setCaptureJobTerminal(job.Update(), capturejob.PhaseFAILED, string(code)).Exec(ctx); err != nil {
			return nil, err
		}
		if job.SurfaceID != nil {
			if err := tx.ProductSurface.UpdateOneID(*job.SurfaceID).SetLastCaptureFailureCode(string(code)).Exec(ctx); err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			if err := activity.Emit(ctx, tx, job.OrganizationID, "capture.failed", "product_surface", *job.SurfaceID, "", "job:"+job.ID, map[string]any{"background": true}); err != nil {
				return nil, err
			}
		}
	}
	slog.Info("capture attempt failed", "job", job.ID, "code", string(code), "attempt", job.Attempts, "seconds", int(now.Sub(claim.job.CreatedAt).Seconds()))
	return outcome, tx.Commit()
}

// commitCapture finalizes one canonical result, or nothing. The fencing token,
// generation, status, and eligibility are all checked in this transaction, so
// an attempt that lost its authority cannot write anything.
func (c *Configuration) commitCapture(ctx context.Context, claim *captureClaim, rotated *browser.State, assetID string, observed *string, stale bool) (*CaptureJobOutcome, error) {
	org := claim.job.OrganizationID
	now := time.Now().UTC()
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	connection, err := lockCaptureConnection(ctx, tx, org, claim.connection.ID)
	if err != nil {
		return nil, err
	}
	job, err := tx.CaptureJob.Query().Where(capturejob.ID(claim.job.ID), capturejob.OrganizationID(org)).Only(ctx)
	if err != nil {
		return nil, err
	}
	// An attempt that lost its authority writes nothing but its own failure. It
	// still gives back a lease it holds, so other jobs need not wait for it to expire.
	lost := func(code string) (*CaptureJobOutcome, error) {
		if err := tx.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetStatus(captureattempt.StatusFAILED).SetFailureCode(code).SetCompletedAt(now).Exec(ctx); err != nil {
			return nil, err
		}
		if connection.LeaseToken == claim.token && connection.LeaseJobID != nil && *connection.LeaseJobID == job.ID {
			if err := connection.Update().ClearLeaseJobID().ClearLeaseExpiresAt().Exec(ctx); err != nil {
				return nil, err
			}
		}
		return captureDone(), tx.Commit()
	}
	if job.Phase != capturejob.PhaseRUNNING || job.FencingToken != claim.token || connection.LeaseToken != claim.token || connection.LeaseJobID == nil || *connection.LeaseJobID != job.ID {
		return lost("fenced")
	}
	if connection.Status != platformappconnection.StatusREADY || connection.Generation != job.ConnectionGeneration {
		if err := setCaptureJobTerminal(job.Update(), capturejob.PhaseFAILED, "stale_authorization").Exec(ctx); err != nil {
			return nil, err
		}
		return lost("stale_authorization")
	}
	code, err := c.captureEligibility(ctx, tx, job)
	if err != nil {
		return nil, err
	}
	if code != "" {
		if err := setCaptureJobTerminal(job.Update(), capturejob.PhaseCANCELLED, code).Exec(ctx); err != nil {
			return nil, err
		}
		return lost(code)
	}
	update := connection.Update().ClearLeaseJobID().ClearLeaseExpiresAt()
	// The lease serializes refresh; the revision guards the stored state besides.
	if rotated != nil && connection.StateRevision == claim.connection.StateRevision {
		body, err := rotated.Marshal()
		if err != nil {
			return nil, err
		}
		sealed, err := c.captureKeys.Seal(body, captureBinding(connection))
		if err != nil {
			return nil, err
		}
		update.SetStateCiphertext(sealed).AddStateRevision(1)
	}
	if err := update.Exec(ctx); err != nil {
		return nil, err
	}
	actor := Actor{OrganizationID: org, Kind: "service", Display: "capture", RequestID: job.ID}
	if job.RequestedByUserID != nil {
		actor.UserID = *job.RequestedByUserID
	}
	jobUpdate := setCaptureJobTerminal(job.Update(), capturejob.PhaseSUCCEEDED, "").SetAssetID(assetID).ClearFailureCode()
	if job.Kind == capturejob.KindTest {
		// A test proves the recipe. It never replaces the surface's current image.
		if err := tx.CaptureRecipe.UpdateOneID(job.RecipeID).SetTestedAt(now).Exec(ctx); err != nil {
			return nil, err
		}
	} else {
		receipt, err := c.recordJobCapture(ctx, tx, actor, job, assetID, observed)
		if err != nil {
			return nil, err
		}
		jobUpdate.SetSurfaceCaptureID(receipt.ID).SetAssetID(receipt.AssetID)
	}
	if err := jobUpdate.Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.CaptureAttempt.UpdateOneID(claim.attempt.ID).SetStatus(captureattempt.StatusSUCCEEDED).SetCompletedAt(now).SetAssetID(assetID).SetNillableObservedRevision(observed).Exec(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.capture_job_succeeded", "capture_job", job.ID, map[string]any{"kind": string(job.Kind), "recipeVersion": job.RecipeVersion, "rotatedState": rotated != nil && !stale}); err != nil {
		return nil, err
	}
	// Queue delay plus capture time, the measure the RFC asks for, with safe fields only.
	slog.Info("capture job succeeded", "job", job.ID, "kind", string(job.Kind), "attempts", job.Attempts, "seconds", int(now.Sub(job.CreatedAt).Seconds()))
	return captureDone(), tx.Commit()
}

// recordJobCapture adds the image to the surface's history through the same
// operation as every other capture. A receipt another job already committed
// for this deployment, page, and proof is the canonical one.
func (c *Configuration) recordJobCapture(ctx context.Context, tx *ent.Tx, actor Actor, job *ent.CaptureJob, assetID string, observed *string) (*ent.SurfaceCapture, error) {
	surface, err := tx.ProductSurface.Query().Where(productsurface.ID(*job.SurfaceID), productsurface.OrganizationID(job.OrganizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	source := surfacecapture.SourceManual
	sourceID := &job.ID
	if job.Kind == capturejob.KindAgent {
		source = surfacecapture.SourceAgent
		if job.TriggerRunID != nil {
			sourceID = job.TriggerRunID
		}
	}
	if job.DeploymentEventID != nil {
		source, sourceID = surfacecapture.SourceDeployment, job.DeploymentEventID
		query := tx.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(surface.ID), surfacecapture.SourceEQ(source), surfacecapture.SourceID(*sourceID))
		if observed != nil {
			query.Where(surfacecapture.ObservedRevision(*observed))
		} else {
			query.Where(surfacecapture.ObservedRevisionIsNil())
		}
		existing, err := query.First(ctx)
		if err == nil {
			return existing, nil
		}
		if !ent.IsNotFound(err) {
			return nil, err
		}
	}
	return recordCapture(ctx, tx, actor, surface, assetID, source, sourceID, observed)
}

// openCaptureSessions lists browsers a connection's attempts may still hold.
func openCaptureSessions(ctx context.Context, tx *ent.Tx, org, connectionID string) ([]string, error) {
	jobs, err := tx.CaptureJob.Query().Where(capturejob.OrganizationID(org), capturejob.AppConnectionID(connectionID), capturejob.PhaseEQ(capturejob.PhaseRUNNING)).IDs(ctx)
	if err != nil || len(jobs) == 0 {
		return nil, err
	}
	attempts, err := tx.CaptureAttempt.Query().Where(captureattempt.CaptureJobIDIn(jobs...), captureattempt.BrowserSessionIDNotNil(), captureattempt.BrowserClosedAtIsNil()).All(ctx)
	if err != nil {
		return nil, err
	}
	sessions := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		sessions = append(sessions, *attempt.BrowserSessionID)
	}
	return sessions, nil
}

// ReclaimCaptureResources closes browsers a crashed worker left open, ends
// sign-ins past their window, and fails jobs past their deadline. It is safe to
// run on every worker: each close is idempotent.
func (c *Configuration) ReclaimCaptureResources(ctx context.Context) error {
	now := time.Now().UTC()
	if c.captureRunner != nil {
		attempts, err := c.client.CaptureAttempt.Query().Where(captureattempt.BrowserSessionIDNotNil(), captureattempt.BrowserClosedAtIsNil(), captureattempt.StartedAtLT(now.Add(-captureLease))).Limit(50).All(ctx)
		if err != nil {
			return err
		}
		for _, attempt := range attempts {
			if err := c.captureRunner.Close(ctx, *attempt.BrowserSessionID); err != nil {
				slog.Warn("abandoned capture browser not closed", "attempt", attempt.ID)
				continue
			}
			if err := attempt.Update().SetBrowserClosedAt(now).Exec(ctx); err != nil {
				return err
			}
		}
		connections, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ConnectExpiresAtLT(now), platformappconnection.ConnectSessionIDNotNil()).Limit(50).All(ctx)
		if err != nil {
			return err
		}
		for _, connection := range connections {
			if err := c.captureRunner.Close(ctx, *connection.ConnectSessionID); err != nil {
				slog.Warn("expired capture sign-in not closed", "connection", connection.ID)
				continue
			}
			update := connection.Update().SetFailureCode("connect_expired").ClearConnectIntentID().ClearConnectUserID().ClearConnectSessionID().ClearConnectExpiresAt().ClearConnectPhase()
			if connection.Status == platformappconnection.StatusCONNECTING {
				update.SetStatus(platformappconnection.StatusNEEDS_AUTH)
			}
			if err := update.Exec(ctx); err != nil {
				return err
			}
		}
	}
	return c.client.CaptureJob.Update().Where(capturejob.DeadlineAtLT(now), capturejob.AppConnectionIDNotNil(), capturejob.PhaseNotIn(capturejob.PhaseSUCCEEDED, capturejob.PhaseFAILED, capturejob.PhaseCANCELLED)).
		SetPhase(capturejob.PhaseFAILED).SetStatus(capturejob.StatusFAILED).SetFailureCode("deadline_exceeded").Exec(ctx)
}
