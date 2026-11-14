package product

import (
	"context"
	"errors"
	"fmt"
	"net/url"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/capturejob"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformappconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publicnet"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

var (
	// ErrCaptureUnavailable is retryable: another worker may capture.
	ErrCaptureUnavailable = errors.New("no capture service is configured on this worker")
	// ErrDeploymentNotLive is retryable: the app reports another commit for now.
	ErrDeploymentNotLive = errors.New("the deployed commit is not live yet")
	// ErrDeploymentUnverified is retryable: the app has not reported any commit.
	ErrDeploymentUnverified = errors.New("the app did not report its deployed commit")
	// ErrCaptureRefused is permanent: the page cannot show this deployment.
	ErrCaptureRefused = errors.New("this page cannot be captured for the deployment")
	// ErrCaptureNeedsAuth stops the run until a person signs in again; retrying
	// the run then finds the resumed job's result.
	ErrCaptureNeedsAuth = errors.New("the app connection needs a person to sign in again")
	// ErrCapturePending is retryable: the durable job has not finished yet.
	ErrCapturePending = errors.New("the capture job has not finished")
	// ErrCaptureSuperseded ends the run: a newer deployment replaced this one
	// before its capture ran, and the newer one captures for itself.
	ErrCaptureSuperseded = errors.New("a newer deployment superseded this capture")
)

// automationCaptureProduct gives a run the capture of its own deployment, so
// rendering shows that and never whichever image happens to be latest. With
// version proof the app must report the deployment's commit first, and a
// retry reuses the proven receipt. Otherwise the output is labeled as the
// page's current state, which claims nothing about the deployment.
func (c *Configuration) automationCaptureProduct(ctx context.Context, org string, event *ent.ReleaseSourceEvent, input automation.Outputs, action *automation.Action) (automation.Outputs, error) {
	if input.CampaignID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.requireWorkspaceFeature(ctx, org, "campaign:workflow"); err != nil {
		return automation.Outputs{}, err
	}
	if action.RecipeID != "" {
		outputs, err := c.automationAuthenticatedCapture(ctx, org, event, input, action)
		if err != nil {
			return automation.Outputs{}, err
		}
		return c.linkAutomationCapture(ctx, org, event.ID, outputs)
	}
	if c.capture == nil || c.objects == nil {
		return automation.Outputs{}, ErrCaptureUnavailable
	}
	surface, err := c.client.ProductSurface.Query().Where(productsurface.ID(action.SurfaceID), productsurface.OrganizationID(org)).Only(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	deployment, err := c.automationDeployment(ctx, org, event, surface.Environment)
	if err != nil {
		return automation.Outputs{}, err
	}
	if deployment.Environment != surface.Environment {
		return automation.Outputs{}, ErrCaptureRefused
	}
	var revision *string
	proof := automation.CaptureProofCurrentState
	if action.VersionPath != "" {
		if deployment.Sha == nil || *deployment.Sha == "" {
			return automation.Outputs{}, ErrDeploymentUnverified
		}
		revision, proof = deployment.Sha, automation.CaptureProofVersion
	}
	receipt, err := c.deploymentReceipt(ctx, deployment, surface.ID, revision)
	if ent.IsNotFound(err) {
		receipt, err = c.takeAutomationCapture(ctx, deployment, surface, action, revision)
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	outputs := input
	outputs.CreditsCharged = 0
	outputs.CaptureID, outputs.CaptureAssetID, outputs.CaptureProof = receipt.ID, receipt.AssetID, proof
	return c.linkAutomationCapture(ctx, org, event.ID, outputs)
}

func (c *Configuration) linkAutomationCapture(ctx context.Context, org, eventID string, outputs automation.Outputs) (automation.Outputs, error) {
	actor := Actor{OrganizationID: org, Kind: "service", Display: "release-automation", RequestID: eventID}
	link, err := c.LinkCampaignAsset(ctx, actor, outputs.CampaignID, outputs.CaptureAssetID, LinkCampaignAssetInput{Kind: "product-shot", preserveExisting: true})
	if err != nil {
		return automation.Outputs{}, err
	}
	if link.AssetStatus != "UPLOADED" {
		return automation.Outputs{}, ErrCaptureRefused
	}
	return outputs, nil
}

// automationDeployment finds the deployment a run's capture is for. A deployment
// event names it; the collect activity recorded it before any node ran, and any
// other deployment has no record to bind to. A published release names only a
// tag, and can arrive before its code is live: the tag resolves to an immutable
// commit, and the run waits for a deployment of that commit. A release's
// target_commitish is not immutable, and a delay proves nothing. A non-empty
// environment limits a release to that environment's deployments.
func (c *Configuration) automationDeployment(ctx context.Context, org string, event *ent.ReleaseSourceEvent, environment string) (*ent.DeploymentEvent, error) {
	e := event.Snapshot
	query := c.client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(org), deploymentevent.SourceAppID(event.SourceAppID))
	switch e.Family {
	case automation.Deployed:
		row, err := query.Where(deploymentevent.ExternalID(e.ObjectID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, ErrCaptureRefused
		}
		return row, err
	case automation.Published:
		source, err := c.client.SourceApp.Query().Where(sourceapp.ID(event.SourceAppID), sourceapp.OrganizationID(org)).Only(ctx)
		if err != nil {
			return nil, err
		}
		reader, installation, err := c.readerFor(ctx, source)
		if err != nil {
			return nil, err
		}
		tag := eventString(e, "release.tag")
		if reader == nil || tag == "" {
			return nil, ErrCaptureRefused
		}
		sha, err := reader.CommitForRef(ctx, installation, e.RepositoryID, tag)
		if err != nil {
			return nil, err
		}
		if sha == "" {
			return nil, ErrDeploymentUnverified
		}
		if environment != "" {
			query.Where(deploymentevent.Environment(environment))
		}
		row, err := query.Where(deploymentevent.Sha(sha)).Order(ent.Desc(deploymentevent.FieldCreatedAt), ent.Desc(deploymentevent.FieldID)).First(ctx)
		if ent.IsNotFound(err) {
			return nil, ErrDeploymentNotLive
		}
		return row, err
	}
	return nil, ErrCaptureRefused
}

// automationAuthenticatedCapture admits the one job for this deployment and
// recipe, and reports its exact result. The run never holds a browser, and never
// falls back to another image while the job runs or waits for a person.
func (c *Configuration) automationAuthenticatedCapture(ctx context.Context, org string, event *ent.ReleaseSourceEvent, input automation.Outputs, action *automation.Action) (automation.Outputs, error) {
	if !c.CaptureAvailable() {
		return automation.Outputs{}, ErrAuthenticatedCaptureUnavailable
	}
	recipe, err := activeRecipeVersion(ctx, c.client.CaptureRecipe, org, action.RecipeID)
	if ent.IsNotFound(err) {
		return automation.Outputs{}, ErrCaptureRefused
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	connection, err := c.client.PlatformAppConnection.Query().Where(platformappconnection.ID(*recipe.AppConnectionID), platformappconnection.OrganizationID(org)).Only(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	definition, err := decodeCaptureRecipe(recipe)
	if err != nil {
		return automation.Outputs{}, err
	}
	// The connection is bound to one source: the event must come from it.
	if connection.SourceAppID == nil || *connection.SourceAppID != event.SourceAppID || connection.Status == platformappconnection.StatusREVOKED ||
		(definition.Version == nil && !action.CurrentState) {
		return automation.Outputs{}, ErrCaptureRefused
	}
	deployment, err := c.automationDeployment(ctx, org, event, connection.Environment)
	if err != nil {
		return automation.Outputs{}, err
	}
	// And to one environment: a staging session never captures production.
	if deployment.Environment != connection.Environment {
		return automation.Outputs{}, ErrCaptureRefused
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return automation.Outputs{}, err
	}
	defer tx.Rollback()
	// Older jobs for this deployment and recipe count: a reconnect raises the
	// generation in the key, and repins the unfinished job rather than losing it.
	job, err := tx.CaptureJob.Query().Where(capturejob.OrganizationID(org), capturejob.DeploymentEventID(deployment.ID), capturejob.RecipeID(recipe.ID)).Order(ent.Desc(capturejob.FieldCreatedAt)).First(ctx)
	if ent.IsNotFound(err) {
		actor := Actor{OrganizationID: org, Kind: "service", Display: "release-automation", RequestID: event.ID}
		job, err = admitCaptureJob(ctx, tx, actor, recipe, connection, capturejob.KindDeployment, deployment, captureDeploymentKey(deployment.ID, recipe.ID, connection.Generation), nil)
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	if err := tx.Commit(); err != nil {
		return automation.Outputs{}, err
	}
	switch job.Phase {
	case capturejob.PhaseSUCCEEDED:
		if job.SurfaceCaptureID == nil || job.AssetID == nil {
			return automation.Outputs{}, ErrCaptureRefused
		}
		outputs := input
		outputs.CreditsCharged = 0
		outputs.CaptureID, outputs.CaptureAssetID, outputs.CaptureProof = *job.SurfaceCaptureID, *job.AssetID, automation.CaptureProofCurrentState
		if job.ExpectedRevision != nil {
			outputs.CaptureProof = automation.CaptureProofVersion
		}
		return outputs, nil
	case capturejob.PhaseNEEDS_AUTH:
		return automation.Outputs{}, ErrCaptureNeedsAuth
	case capturejob.PhaseFAILED, capturejob.PhaseCANCELLED:
		if job.FailureCode != nil && *job.FailureCode == captureSuperseded {
			return automation.Outputs{}, ErrCaptureSuperseded
		}
		return automation.Outputs{}, ErrCaptureRefused
	}
	return automation.Outputs{}, ErrCapturePending
}

// deploymentReceipt finds a page's capture for a deployment. With a revision,
// only a capture proven against that commit counts: one taken without proof
// may show the page from before the deployment went live.
func (c *Configuration) deploymentReceipt(ctx context.Context, deployment *ent.DeploymentEvent, surfaceID string, revision *string) (*ent.SurfaceCapture, error) {
	query := c.client.SurfaceCapture.Query().Where(surfacecapture.OrganizationID(deployment.OrganizationID), surfacecapture.SurfaceID(surfaceID),
		surfacecapture.SourceEQ(surfacecapture.SourceDeployment), surfacecapture.SourceID(deployment.ID))
	if revision != nil {
		query.Where(surfacecapture.ObservedRevision(*revision))
	}
	return query.Order(ent.Desc(surfacecapture.FieldCapturedAt), ent.Desc(surfacecapture.FieldID)).First(ctx)
}

func (c *Configuration) takeAutomationCapture(ctx context.Context, deployment *ent.DeploymentEvent, surface *ent.ProductSurface, action *automation.Action, revision *string) (*ent.SurfaceCapture, error) {
	page, err := url.Parse(surface.URL)
	if err != nil || !capture.PublicPageURL(surface.URL) {
		return nil, ErrCaptureRefused
	}
	if action.VersionPath != "" {
		if err := c.proveDeployedRevision(ctx, page.Scheme+"://"+page.Host+action.VersionPath, *revision); err != nil {
			return nil, err
		}
	}
	if err := c.ready(ctx, surface.URL); errors.Is(err, errUnsafeDeploymentURL) || errors.Is(err, publicnet.ErrBlocked) {
		return nil, ErrCaptureRefused
	} else if err != nil {
		return nil, ErrDeploymentNotLive
	}
	receipt, code, err := c.captureDeploymentSurface(ctx, deployment, surface, "workflow-capture", revision)
	switch code {
	case "":
		return receipt, err
	case "capture_login_page", "deployment_url_refused":
		return nil, ErrCaptureRefused
	}
	return nil, fmt.Errorf("%s: %w", code, err)
}

// proveDeployedRevision asks the app which commit it runs. Another commit means
// the deployment is not live here yet; no answer proves nothing either way.
func (c *Configuration) proveDeployedRevision(ctx context.Context, versionURL, sha string) error {
	answer, err := c.probePage(ctx, versionURL)
	if errors.Is(err, errUnsafeDeploymentURL) || errors.Is(err, publicnet.ErrBlocked) {
		return ErrCaptureRefused
	}
	if err != nil {
		return ErrDeploymentUnverified
	}
	requested, err := url.Parse(versionURL)
	if err != nil || answer.status != 200 || !sameOrigin(requested, answer.final) {
		return ErrDeploymentUnverified
	}
	switch capture.CompareRevision(string(answer.body), sha) {
	case capture.RevisionMatches:
		return nil
	case capture.RevisionOther:
		return ErrDeploymentNotLive
	}
	return ErrDeploymentUnverified
}
