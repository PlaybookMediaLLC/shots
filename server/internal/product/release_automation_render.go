package product

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

// AutomationRenderRequest asks the web renderer to fill design templates
// with a product capture and render them into a campaign. Renders are
// idempotent per campaign, node, and template, so a retry reuses them.
type AutomationRenderRequest struct {
	OrganizationID string   `json:"organizationId"`
	CampaignID     string   `json:"campaignId"`
	RunID          string   `json:"runId"`
	NodeID         string   `json:"nodeId"`
	BrandKitID     string   `json:"brandKitId,omitempty"`
	CaptureAssetID string   `json:"captureAssetId"`
	Headline       string   `json:"headline"`
	Subheadline    string   `json:"subheadline,omitempty"`
	TemplateIDs    []string `json:"templateIds"`
}

// AutomationRender is one rendered creative.
type AutomationRender struct {
	TemplateID string `json:"templateId"`
	DesignID   string `json:"designId"`
	AssetID    string `json:"assetId"`
}

// AutomationRenderer renders campaign creatives; the web app owns the design
// templates, brand styling, and the headless renderer.
type AutomationRenderer interface {
	Render(ctx context.Context, request AutomationRenderRequest) ([]AutomationRender, error)
}

// WithAutomationRenderer enables the render_creatives action on this worker.
func (c *Configuration) WithAutomationRenderer(renderer AutomationRenderer) *Configuration {
	c.automationRenderer = renderer
	return c
}

// HTTPAutomationRenderer calls the web's internal render endpoint with an
// HMAC over the timestamp and exact body; the web rejects stale signatures.
type HTTPAutomationRenderer struct {
	URL string
	// CanvasURL is the canvas builder beside the renderer.
	CanvasURL string
	Key       []byte
	HTTP      *http.Client
}

// AutomationRendererFromEnvironment reads PLATFORM_WORKFLOW_RENDER_URL (the
// web app's base URL as the worker reaches it) and PLATFORM_WORKFLOW_RENDER_KEY.
// Without both the worker does not advertise rendering.
func AutomationRendererFromEnvironment() *HTTPAutomationRenderer {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("PLATFORM_WORKFLOW_RENDER_URL")), "/")
	key := strings.TrimSpace(os.Getenv("PLATFORM_WORKFLOW_RENDER_KEY"))
	if base == "" || len(key) < 32 {
		return nil
	}
	return &HTTPAutomationRenderer{URL: base + "/api/internal/workflow-renders", CanvasURL: base + "/api/internal/workflow-canvases",
		Key: []byte(key), HTTP: &http.Client{Timeout: 4 * time.Minute}}
}

// ErrRendererRefused is a render request the web rejected as invalid; retrying cannot help.
var ErrRendererRefused = errors.New("the renderer refused the request")

// SignWorkflowRender is the signature header value for a render request body.
func SignWorkflowRender(key, body []byte, at time.Time) string {
	stamp := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(stamp + "."))
	mac.Write(body)
	return "t=" + stamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func (r *HTTPAutomationRenderer) Render(ctx context.Context, request AutomationRenderRequest) ([]AutomationRender, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("x-shots-signature", SignWorkflowRender(r.Key, body, time.Now()))
	response, err := r.HTTP.Do(httpRequest)
	if err != nil {
		return nil, errors.New("the renderer is unreachable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 && response.StatusCode != http.StatusTooManyRequests {
		return nil, ErrRendererRefused
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the renderer returned %d", response.StatusCode)
	}
	var result struct {
		Renders []AutomationRender `json:"renders"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result.Renders, nil
}

// automationRenderCreatives renders the action's templates with the chosen
// surface's current product capture into the run's campaign. The renderer
// reuses designs and renders it already made for this node, so retries and
// lost acknowledgements never duplicate creatives.
func (c *Configuration) automationRenderCreatives(ctx context.Context, org, runID, nodeID string, event *ent.ReleaseSourceEvent, input automation.Outputs, action *automation.Action) (automation.Outputs, error) {
	if c.automationRenderer == nil {
		return automation.Outputs{}, ErrAutomationRendererUnavailable
	}
	if input.CampaignID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.requireWorkspaceFeature(ctx, org, "campaign:workflow"); err != nil {
		return automation.Outputs{}, err
	}
	// A capture taken earlier in this run wins, with no fallback to the latest
	// image; a graph without one keeps the meaning it was activated with.
	captureAssetID := input.CaptureAssetID
	if captureAssetID == "" {
		var err error
		if captureAssetID, err = c.currentCapture(ctx, org, action.SurfaceID); err != nil {
			return automation.Outputs{}, err
		}
	}
	headline := strings.TrimSpace(event.Snapshot.Title)
	if utf8.RuneCountInString(headline) > 60 {
		headline = strings.TrimSpace(string([]rune(headline)[:59])) + "…"
	}
	subheadline, _, _ := strings.Cut(releasenotes.Clean(event.Snapshot.Notes, 400), "\n")
	if utf8.RuneCountInString(subheadline) > 100 {
		subheadline = strings.TrimSpace(string([]rune(subheadline)[:99])) + "…"
	}
	renders, err := c.automationRenderer.Render(ctx, AutomationRenderRequest{OrganizationID: org, CampaignID: input.CampaignID, RunID: runID, NodeID: nodeID,
		BrandKitID: input.BrandKitID, CaptureAssetID: captureAssetID, Headline: headline, Subheadline: subheadline, TemplateIDs: action.TemplateIDs})
	if errors.Is(err, ErrRendererRefused) {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	if len(renders) != len(action.TemplateIDs) {
		return automation.Outputs{}, errors.New("the renderer returned an incomplete result")
	}
	outputs := input
	outputs.CreditsCharged = 0
	outputs.DesignIDs, outputs.RenderedAssetIDs = []string{}, []string{}
	for _, render := range renders {
		outputs.DesignIDs = append(outputs.DesignIDs, render.DesignID)
		outputs.RenderedAssetIDs = append(outputs.RenderedAssetIDs, render.AssetID)
	}
	return outputs, nil
}

// currentCapture is the newest current capture with an uploaded image, of one
// surface or of whichever surface was captured last.
func (c *Configuration) currentCapture(ctx context.Context, org, surfaceID string) (string, error) {
	query := c.client.SurfaceCapture.Query().Where(surfacecapture.OrganizationID(org), surfacecapture.SupersededAtIsNil())
	if surfaceID != "" {
		query.Where(surfacecapture.SurfaceID(surfaceID))
	}
	captures, err := query.Order(ent.Desc(surfacecapture.FieldCapturedAt), ent.Desc(surfacecapture.FieldID)).Limit(20).All(ctx)
	if err != nil {
		return "", err
	}
	for _, capture := range captures {
		uploaded, err := c.client.Asset.Query().Where(asset.ID(capture.AssetID), asset.OrganizationID(org), asset.StatusEQ(asset.StatusUPLOADED)).Exist(ctx)
		if err != nil {
			return "", err
		}
		if uploaded {
			return capture.AssetID, nil
		}
	}
	return "", ErrCaptureMissing
}

// ErrAutomationRendererUnavailable is retryable: another worker may render.
var ErrAutomationRendererUnavailable = errors.New("no renderer is configured on this worker")

// ErrCaptureMissing means no product surface has a current capture to show.
var ErrCaptureMissing = errors.New("no current product capture")
