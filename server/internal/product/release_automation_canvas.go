package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

// AutomationCanvasRequest asks the web to lay out a canvas from a release
// with canvas templates and store it in the workspace. The web derives the
// canvas from the run and node, so a retry finds the canvas it already made.
type AutomationCanvasRequest struct {
	OrganizationID string   `json:"organizationId"`
	RunID          string   `json:"runId"`
	NodeID         string   `json:"nodeId"`
	ReleaseID      string   `json:"releaseId"`
	CampaignID     string   `json:"campaignId,omitempty"`
	CaptureAssetID string   `json:"captureAssetId,omitempty"`
	RecipeIDs      []string `json:"recipeIds"`
}

// AutomationCanvasBuilder lays out canvases; the web app owns the canvas
// templates, so canvases from automation match the ones people make.
type AutomationCanvasBuilder interface {
	BuildCanvas(ctx context.Context, request AutomationCanvasRequest) (string, error)
}

// WithAutomationCanvases enables the create_canvas action on this worker.
func (c *Configuration) WithAutomationCanvases(builder AutomationCanvasBuilder) *Configuration {
	c.automationCanvases = builder
	return c
}

// BuildCanvas posts a signed request to the web's internal canvas endpoint,
// beside the render endpoint and under the same key.
func (r *HTTPAutomationRenderer) BuildCanvas(ctx context.Context, request AutomationCanvasRequest) (string, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, r.CanvasURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("x-shots-signature", SignWorkflowRender(r.Key, body, time.Now()))
	response, err := r.HTTP.Do(httpRequest)
	if err != nil {
		return "", errors.New("the canvas builder is unreachable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return "", err
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 && response.StatusCode != http.StatusTooManyRequests {
		return "", ErrRendererRefused
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the canvas builder returned %d", response.StatusCode)
	}
	var result struct {
		CanvasID string `json:"canvasId"`
	}
	if err := json.Unmarshal(data, &result); err != nil || result.CanvasID == "" {
		return "", errors.New("the canvas builder returned no canvas")
	}
	return result.CanvasID, nil
}

// automationCreateCanvas lays out a canvas from the run's release. Screenshots
// come from the release; without any, the chosen surface's current capture
// is used when there is one.
func (c *Configuration) automationCreateCanvas(ctx context.Context, org, runID, nodeID string, input automation.Outputs, action *automation.Action) (automation.Outputs, error) {
	if c.automationCanvases == nil {
		return automation.Outputs{}, ErrAutomationCanvasesUnavailable
	}
	if input.ReleaseID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.requireWorkspaceFeature(ctx, org, "workspace:paid"); err != nil {
		return automation.Outputs{}, err
	}
	capture := input.CaptureAssetID
	if capture == "" {
		var err error
		if capture, err = c.currentCapture(ctx, org, action.SurfaceID); err != nil && !errors.Is(err, ErrCaptureMissing) {
			return automation.Outputs{}, err
		}
	}
	canvasID, err := c.automationCanvases.BuildCanvas(ctx, AutomationCanvasRequest{OrganizationID: org, RunID: runID, NodeID: nodeID,
		ReleaseID: input.ReleaseID, CampaignID: input.CampaignID, CaptureAssetID: capture, RecipeIDs: action.RecipeIDs})
	if errors.Is(err, ErrRendererRefused) {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	outputs := input
	outputs.CreditsCharged = 0
	outputs.CanvasID = canvasID
	return outputs, nil
}

// ErrAutomationCanvasesUnavailable is retryable: another worker may build it.
var ErrAutomationCanvasesUnavailable = errors.New("no canvas builder is configured on this worker")
