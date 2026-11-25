package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	goimage "image"
	_ "image/png"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	agentCallTimeout   = 45 * time.Second
	agentMaxBodyBytes  = 64 << 20
	agentBodyAllowance = 1 << 20
)

// AgentRunner optionally delegates AI-navigated captures (`Recipe.Navigation != nil`)
// to an external managed browser-agent sidecar (e.g. Browser Use / Stagehand /
// Browserbase worker) configured via PLATFORM_CAPTURE_AGENT_URL while delegating
// session allocation, Live View, verification, and non-AI recipes to the built-in
// CDP Runner. Any unconfigured or fallback response drops back cleanly to Runner.Run.
type AgentRunner struct {
	Runner
	AgentURL   string
	AgentToken string
	HTTP       *http.Client
}

func isLoopbackHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// AgentRunnerFromEnvironment wraps Runner when PLATFORM_CAPTURE_AGENT_URL is set.
// Non-loopback endpoints require HTTPS and a bearer token (PLATFORM_CAPTURE_AGENT_TOKEN)
// so decrypted customer session state is never transmitted over plaintext or unauthenticated hops.
func AgentRunnerFromEnvironment(provider Provider) *AgentRunner {
	base := Runner{Provider: provider}
	endpoint := strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_AGENT_URL"))
	if endpoint == "" {
		return nil
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return nil
	}
	token := strings.TrimSpace(os.Getenv("PLATFORM_CAPTURE_AGENT_TOKEN"))
	loopback := isLoopbackHost(parsed.Hostname())
	switch parsed.Scheme {
	case "https":
		if !loopback && token == "" {
			return nil
		}
	case "http":
		if !loopback {
			return nil
		}
	default:
		return nil
	}
	return &AgentRunner{
		Runner:     base,
		AgentURL:   strings.TrimRight(endpoint, "/"),
		AgentToken: token,
		HTTP: &http.Client{
			Timeout: agentCallTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}
}

type externalAgentRequest struct {
	SessionID        string   `json:"sessionId"`
	Origin           string   `json:"origin"`
	Hosts            []string `json:"hosts"`
	ProtectedPath    string   `json:"protectedPath"`
	IdentitySelector string   `json:"identitySelector,omitempty"`
	ExpectedAccount  string   `json:"expectedAccount"`
	ExpectedRevision string   `json:"expectedRevision,omitempty"`
	Recipe           Recipe   `json:"recipe"`
	State            *State   `json:"state,omitempty"`
}

type externalAgentSequence struct {
	ImageBase64 string `json:"imageBase64"`
}

type externalAgentResponse struct {
	Fallback          bool                    `json:"fallback,omitempty"`
	ImageBase64       string                  `json:"imageBase64"`
	SourcePath        string                  `json:"sourcePath"`
	ObservedRevision  string                  `json:"observedRevision,omitempty"`
	NavigationActions []NavigationAction      `json:"navigationActions,omitempty"`
	Focus             *Focus                  `json:"focus,omitempty"`
	Sequence          []externalAgentSequence `json:"sequence,omitempty"`
	State             *State                  `json:"state,omitempty"`
}

func decodeAgentPNG(encoded string, maxBytes int) ([]byte, int, int, bool) {
	if encoded == "" {
		return nil, 0, 0, false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 || len(raw) > maxBytes {
		return nil, 0, 0, false
	}
	cfg, format, err := goimage.DecodeConfig(bytes.NewReader(raw))
	if err != nil || format != "png" || cfg.Width <= 0 || cfg.Height <= 0 {
		return nil, 0, 0, false
	}
	return raw, cfg.Width, cfg.Height, true
}

func sanitizeAgentActions(raw []NavigationAction) []NavigationAction {
	if len(raw) == 0 {
		return nil
	}
	limit := MaxNavigationSteps + 1
	out := make([]NavigationAction, 0, min(len(raw), limit))
	for _, action := range raw {
		if len(out) >= limit {
			break
		}
		switch action.Kind {
		case "link", "tab", "button", "fill", "scroll", "frame":
		default:
			continue
		}
		if !ValidPath(action.Path) {
			continue
		}
		out = append(out, NavigationAction{Kind: action.Kind, Path: action.Path})
	}
	return out
}

// Run uses the external managed browser agent for AI-navigated recipes when
// configured, validates every returned image, revision proof, action trace, and
// focus box against the same browser invariants, and falls back to built-in CDP
// Runner.Run when declined or unavailable.
func (a *AgentRunner) Run(ctx context.Context, sessionID string, input RunInput) (*RunResult, error) {
	if a.AgentURL == "" || input.Recipe.Navigation == nil {
		return a.Runner.Run(ctx, sessionID, input)
	}
	if err := input.Target.Validate(); err != nil {
		return nil, &Failure{Code: RecipeInvalid}
	}
	if err := input.Recipe.Validate(); err != nil {
		return nil, &Failure{Code: RecipeInvalid}
	}
	if input.ExpectedRevision != "" && input.Recipe.Version == nil {
		return nil, &Failure{Code: DeploymentUnverified}
	}
	if ctx.Err() != nil {
		return nil, &Failure{Code: ProviderUnavailable}
	}
	if input.ReserveExternalRun != nil {
		if err := input.ReserveExternalRun(ctx); err != nil {
			return nil, err
		}
	}
	body, err := json.Marshal(externalAgentRequest{
		SessionID:        sessionID,
		Origin:           input.Target.Origin,
		Hosts:            input.Target.Hosts,
		ProtectedPath:    input.Target.ProtectedPath,
		IdentitySelector: input.Target.IdentitySelector,
		ExpectedAccount:  input.Target.ExpectedAccount,
		ExpectedRevision: input.ExpectedRevision,
		Recipe:           input.Recipe,
		State:            input.State,
	})
	if err != nil {
		return a.Runner.Run(ctx, sessionID, input)
	}
	reqCtx, cancel := context.WithTimeout(ctx, agentCallTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, a.AgentURL+"/v1/capture/run", bytes.NewReader(body))
	if err != nil {
		return a.Runner.Run(ctx, sessionID, input)
	}
	req.Header.Set("Content-Type", "application/json")
	if a.AgentToken != "" {
		req.Header.Set("Authorization", "Bearer "+a.AgentToken)
	}
	httpClient := a.HTTP
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: agentCallTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &Failure{Code: ProviderUnavailable}
		}
		return a.Runner.Run(ctx, sessionID, input)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return a.Runner.Run(ctx, sessionID, input)
	}
	if resp.StatusCode != http.StatusOK {
		slog.Warn("external capture agent rejected request; falling back to built-in CDP runner", "status", resp.StatusCode)
		return a.Runner.Run(ctx, sessionID, input)
	}
	scale := input.Recipe.Viewport.DeviceScale()
	shots := max(1, input.Recipe.SequenceShots)
	limit := min(int64(agentMaxBodyBytes), int64(shots)*int64(maxImageBytes*scale)*4/3+agentBodyAllowance)
	var out externalAgentResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, limit)).Decode(&out); err != nil {
		return a.Runner.Run(ctx, sessionID, input)
	}
	if out.Fallback {
		return a.Runner.Run(ctx, sessionID, input)
	}
	if input.ExpectedRevision != "" {
		if strings.TrimSpace(out.ObservedRevision) == "" {
			return nil, &Failure{Code: DeploymentUnverified}
		}
		if out.ObservedRevision != input.ExpectedRevision {
			return nil, &Failure{Code: WaitingForDeployment}
		}
	}
	imgBytes, width, height, ok := decodeAgentPNG(out.ImageBase64, maxImageBytes*scale)
	out.ImageBase64 = ""
	if !ok {
		return nil, &Failure{Code: ImageInvalid}
	}
	if input.Recipe.Crop != CropMarker {
		wantW := float64(input.Recipe.Viewport.Width * scale)
		wantH := float64(input.Recipe.Viewport.Height * scale)
		if math.Abs(float64(width)-wantW) > 2 || math.Abs(float64(height)-wantH) > 2 {
			return nil, &Failure{Code: ImageInvalid}
		}
	}
	sourcePath := out.SourcePath
	if !ValidPath(sourcePath) {
		sourcePath = input.Target.ProtectedPath
	}
	result := &RunResult{
		Image:             imgBytes,
		Width:             width,
		Height:            height,
		ObservedRevision:  out.ObservedRevision,
		SourcePath:        sourcePath,
		NavigationActions: sanitizeAgentActions(out.NavigationActions),
	}
	if out.Focus != nil &&
		!math.IsNaN(out.Focus.X) && !math.IsNaN(out.Focus.Y) && !math.IsNaN(out.Focus.W) && !math.IsNaN(out.Focus.H) &&
		!math.IsInf(out.Focus.X, 0) && !math.IsInf(out.Focus.Y, 0) && !math.IsInf(out.Focus.W, 0) && !math.IsInf(out.Focus.H, 0) &&
		out.Focus.X >= 0 && out.Focus.Y >= 0 && out.Focus.W > 0 && out.Focus.H > 0 &&
		out.Focus.X+out.Focus.W <= 1.001 && out.Focus.Y+out.Focus.H <= 1.001 &&
		out.Focus.W*out.Focus.H > 0.002 && out.Focus.W*out.Focus.H < 0.72 {
		result.Focus = &Focus{
			X: out.Focus.X,
			Y: out.Focus.Y,
			W: math.Min(out.Focus.W, 1-out.Focus.X),
			H: math.Min(out.Focus.H, 1-out.Focus.Y),
		}
	}
	if out.State != nil {
		if filtered, fErr := FilterBootstrapState(out.State, input.Target); fErr == nil {
			filtered.MergePrevious(input.State, input.Target.Hosts)
			if !filtered.Same(input.State) {
				result.State = filtered
			}
		}
	}
	maxIntermediate := max(0, input.Recipe.SequenceShots-1)
	for i := range out.Sequence {
		if len(result.Sequence) >= maxIntermediate {
			break
		}
		frameBytes, fw, fh, frameOK := decodeAgentPNG(out.Sequence[i].ImageBase64, maxImageBytes*scale)
		out.Sequence[i].ImageBase64 = ""
		if !frameOK {
			continue
		}
		result.Sequence = append(result.Sequence, SequenceShot{
			Image:  frameBytes,
			Width:  fw,
			Height: fh,
		})
	}
	return result, nil
}
