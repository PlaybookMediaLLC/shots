package product

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
)

// Code visuals render at most this many changed files, one slide each.
const automationCodeFiles = 3

// AutomationCodeVisualRequest asks the web to turn a merged pull request's
// changes into a Code Studio project, render it, and link the image to the
// run's campaign. The project ID is fixed per run and node, so a retry reuses it.
type AutomationCodeVisualRequest struct {
	OrganizationID string           `json:"organizationId"`
	CampaignID     string           `json:"campaignId"`
	RunID          string           `json:"runId"`
	NodeID         string           `json:"nodeId"`
	Title          string           `json:"title"`
	URL            string           `json:"url"`
	Repo           string           `json:"repo"`
	Files          []CodeImportFile `json:"files"`
}

// AutomationCodeVisual is the project and image a code visual request made.
type AutomationCodeVisual struct {
	ProjectID string `json:"projectId"`
	AssetID   string `json:"assetId"`
}

// AutomationCodeVisualizer renders code visuals; the web owns Code Studio.
type AutomationCodeVisualizer interface {
	RenderCode(ctx context.Context, request AutomationCodeVisualRequest) (*AutomationCodeVisual, error)
}

// RenderCode calls the web's signed code visual endpoint beside the renderer.
func (r *HTTPAutomationRenderer) RenderCode(ctx context.Context, request AutomationCodeVisualRequest) (*AutomationCodeVisual, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	target := strings.TrimSuffix(r.URL, "/workflow-renders") + "/workflow-code-visuals"
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("x-shots-signature", SignWorkflowRender(r.Key, body, time.Now()))
	response, err := r.HTTP.Do(httpRequest)
	if err != nil {
		return nil, errors.New("the code renderer is unreachable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 && response.StatusCode < 500 && response.StatusCode != http.StatusTooManyRequests {
		return nil, ErrRendererRefused
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the code renderer returned %d", response.StatusCode)
	}
	var result AutomationCodeVisual
	if err := json.Unmarshal(data, &result); err != nil || result.ProjectID == "" || result.AssetID == "" {
		return nil, errors.New("the code renderer returned an incomplete result")
	}
	return &result, nil
}

// automationRenderCodeVisual reads the merged pull request's diff, which the
// workflow owner allowed on this action (Code Studio source-code policy), and
// renders its first changed files into the run's campaign. Code reaches only
// the code project the web creates; the run records its ID, never code.
func (c *Configuration) automationRenderCodeVisual(ctx context.Context, org, runID, nodeID string, source *ent.SourceApp, event *ent.ReleaseSourceEvent,
	input automation.Outputs, action *automation.Action) (automation.Outputs, error) {
	visualizer, ok := c.automationRenderer.(AutomationCodeVisualizer)
	if !ok || c.codeReader == nil {
		return automation.Outputs{}, ErrAutomationRendererUnavailable
	}
	if !action.ReadSourceCode || input.CampaignID == "" {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err := c.requireWorkspaceFeature(ctx, org, "campaign:workflow"); err != nil {
		return automation.Outputs{}, err
	}
	snapshot := event.Snapshot
	owner, repo, found := strings.Cut(snapshot.RepositoryName, "/")
	if snapshot.Family != automation.Merged || snapshot.Number < 1 || !found {
		return automation.Outputs{}, invalid("Code visuals render from a merged pull request.")
	}
	_, installation, err := c.readerFor(ctx, source)
	if err != nil {
		return automation.Outputs{}, err
	}
	if installation == 0 {
		return automation.Outputs{}, ErrGitHubUnavailable
	}
	_, changed, err := c.codeReader.PullRequestChanges(ctx, installation, owner, repo, snapshot.Number)
	if err != nil {
		return automation.Outputs{}, codeImportError(err, true)
	}
	files, total := []CodeImportFile{}, 0
	for _, file := range changed {
		size := utf8.RuneCountInString(file.Patch)
		if file.Patch == "" || size > codeImportFileLimit || total+size > codeImportTotalLimit {
			continue
		}
		total += size
		files = append(files, CodeImportFile{Name: file.Filename, Patch: file.Patch, Status: file.Status})
		if len(files) == automationCodeFiles {
			break
		}
	}
	if len(files) == 0 {
		return automation.Outputs{}, invalid("The pull request has no text changes to show as code.")
	}
	title := strings.TrimSpace(snapshot.Title)
	if utf8.RuneCountInString(title) > 120 {
		title = strings.TrimSpace(string([]rune(title)[:119])) + "…"
	}
	visual, err := visualizer.RenderCode(ctx, AutomationCodeVisualRequest{OrganizationID: org, CampaignID: input.CampaignID, RunID: runID, NodeID: nodeID,
		Title: title, URL: snapshot.URL, Repo: snapshot.RepositoryName, Files: files})
	if errors.Is(err, ErrRendererRefused) {
		return automation.Outputs{}, ErrInvalidInput
	}
	if err != nil {
		return automation.Outputs{}, err
	}
	outputs := input
	outputs.CreditsCharged = 0
	outputs.CodeProjectID = visual.ProjectID
	outputs.RenderedAssetIDs = append(append([]string{}, input.RenderedAssetIDs...), visual.AssetID)
	return outputs, nil
}
