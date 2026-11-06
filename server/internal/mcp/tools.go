package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/shotsapi"
)

// Per-key call limits. Every REST call with a key passes Better Auth's 60 a
// minute; a capture matches the web's 20 a minute for POST /api/screenshot.
const (
	callsPerKeyMinute    = 60
	capturesPerKeyMinute = 20
	callTimeout          = 60 * time.Second
)

// run executes a tool's domain call. It returns the REST response body, or
// a ready result for tools that answer with something other than JSON.
type run func(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error)

// shotsTool is one tool: the REST operation it mirrors and the domain call.
type shotsTool struct {
	operation   *shotsapi.Operation
	spec        *sdk.Tool
	input       *jsonschema.Resolved
	run         run
	perKeyLimit int
}

func boolPtr(value bool) *bool { return &value }

// readOnly, write, and destructive are the tool annotations clients use to
// decide what needs a confirmation.
var (
	readOnly    = sdk.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)}
	write       = sdk.ToolAnnotations{DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(false)}
	idempotent  = sdk.ToolAnnotations{DestructiveHint: boolPtr(false), IdempotentHint: true, OpenWorldHint: boolPtr(false)}
	destructive = sdk.ToolAnnotations{DestructiveHint: boolPtr(true), IdempotentHint: true, OpenWorldHint: boolPtr(false)}
	openWorld   = sdk.ToolAnnotations{ReadOnlyHint: true, DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)}
	// publishes marks a tool whose effect reaches a public social channel.
	publishes = sdk.ToolAnnotations{DestructiveHint: boolPtr(false), OpenWorldHint: boolPtr(true)}
)

// toolTable is the tool surface of RFC 026. Each tool is named after the
// operationId it mirrors; its schema, scope, plan gate, and quota come from
// that operation in the embedded OpenAPI document.
var toolTable = []struct {
	operationID string
	annotations sdk.ToolAnnotations
	perKeyLimit int
	run         run
	// description replaces the REST description where the tool answers
	// differently, so the agent is not told about a base64 body or a cache.
	description string
}{
	{"listReleases", readOnly, 0, listReleases, ""},
	{"createRelease", write, 0, createRelease, ""},
	{"createAssetUploadUrl", write, 0, createAssetUploadURL, ""},
	{"completeAssetUpload", idempotent, 0, completeAssetUpload, ""},
	{"createAssetDownloadUrl", readOnly, 0, createAssetDownloadURL, ""},
	{"deleteAsset", destructive, 0, deleteAsset, ""},
	{"captureScreenshot", openWorld, capturesPerKeyMinute, captureScreenshot,
		"Renders a public http(s) page and returns the image. Pages on private or local addresses are refused. Limited to 20 captures a minute per key."},
	{"listCampaigns", readOnly, 0, listCampaigns, ""},
	{"getCampaign", readOnly, 0, getCampaign, ""},
	{"createCampaign", write, 0, createCampaign, ""},
	{"listApprovals", readOnly, 0, listApprovals, ""},
	{"requestCampaignReview", write, 0, requestCampaignReview, ""},
	{"scheduleCampaignPost", publishes, 0, scheduleCampaignPost,
		"Schedules an approved campaign post on a channel connection that publishes its channel. The post must be `APPROVED` with an approved visual: the one it has, or `creativeVariantId`, an approved variant of this campaign’s designs. Scheduling never approves. The copy is checked against the brand profile and the channel’s character limit, and each new post counts against the monthly posts allowance. This server cannot read link previews, so it refuses a call without `skipLinkCheck: true`: check each link in the post first (GET /api/v1/link-preview with the same key), then call again with `skipLinkCheck: true`. The post publishes within a minute of its time. Requires the `post:schedule` scope."},
	{"listScheduledPosts", readOnly, 0, listScheduledPosts, ""},
	{"createScheduledPost", publishes, 0, createScheduledPost, ""},
	{"cancelScheduledPost", destructive, 0, cancelScheduledPost, ""},
	{"listSocialSets", readOnly, 0, listSocialSets, ""},
	{"getSocialSet", readOnly, 0, getSocialSet, ""},
	{"updateSocialSetQueue", write, 0, updateSocialSetQueue, ""},
	{"lookupSocialSetMentions", readOnly, 0, lookupSocialSetMentions, ""},
	{"listCalendarPosts", readOnly, 0, listCalendarPosts, ""},
	{"bestPostingTimes", readOnly, 0, bestPostingTimes, ""},
	{"listContentDrafts", readOnly, 0, listContentDrafts, ""},
	{"getContentDraft", readOnly, 0, getContentDraft, ""},
	{"createContentDraft", write, 0, createContentDraft, ""},
	{"createPost", publishes, 0, createPost, ""},
	{"updateContentDraft", write, 0, updateContentDraft, ""},
	{"deleteContentDraft", destructive, 0, deleteContentDraft, ""},
	{"listContentDraftPosts", readOnly, 0, listContentDraftPosts, ""},
	{"planContentDraft", write, 0, planContentDraft, ""},
	{"duplicateContentDraft", write, 0, duplicateContentDraft, ""},
	{"updateContentDraftProperties", write, 0, updateContentDraftProperties, ""},
	{"listContentDraftActivity", readOnly, 0, listContentDraftActivity, ""},
	{"listDraftComments", readOnly, 0, listDraftComments, ""},
	{"mutateDraftComment", destructive, 0, mutateDraftComment, ""},
}

func buildTools() ([]*shotsTool, error) {
	tools := make([]*shotsTool, 0, len(toolTable))
	for _, entry := range toolTable {
		operation, err := shotsapi.Lookup(entry.operationID)
		if err != nil {
			return nil, err
		}
		if operation.Scope == "" || operation.Entitlement.Feature == "" {
			return nil, fmt.Errorf("mcp: %s has no API-key scope or plan gate in the OpenAPI document", entry.operationID)
		}
		data, _ := json.Marshal(operation.InputSchema)
		var schema jsonschema.Schema
		if err := json.Unmarshal(data, &schema); err != nil {
			return nil, fmt.Errorf("mcp: %s input schema: %w", entry.operationID, err)
		}
		resolved, err := schema.Resolve(nil)
		if err != nil {
			return nil, fmt.Errorf("mcp: %s input schema: %w", entry.operationID, err)
		}
		annotations := entry.annotations
		annotations.Title = operation.Summary
		description := operation.Description
		if entry.description != "" {
			description = entry.description
		}
		spec := &sdk.Tool{Name: operation.ID, Title: operation.Summary, Description: operation.Summary + ". " + description,
			InputSchema: operation.InputSchema, Annotations: &annotations}
		if operation.OutputSchema != nil && entry.operationID != "captureScreenshot" {
			spec.OutputSchema = operation.OutputSchema
		}
		tools = append(tools, &shotsTool{operation: operation, spec: spec, input: resolved, run: entry.run,
			perKeyLimit: entry.perKeyLimit})
	}
	return tools, nil
}

// failure is a refused or failed call, reported with the REST error envelope.
type failure struct {
	status  int
	code    string
	message string
	hint    string
	extra   map[string]any
}

func (f *failure) Error() string { return f.message }

// statusDetails mirrors statusDetails in lib/api/platform-errors.ts.
var statusDetails = map[int]struct{ code, hint string }{
	400: {"invalid_request", "Check the arguments against the tool's input schema."},
	401: {"unauthorized", "Send a valid Shots workspace API key."},
	403: {"forbidden", "Use a key with the required scope on a workspace with plan access."},
	404: {"not_found", "Check the identifier; it must belong to this workspace."},
	409: {"conflict", "Reload the resource to see its current state, then retry."},
	429: {"rate_limited", "Wait for the indicated reset time, then retry."},
	500: {"internal_error", "Retry the request. If it keeps failing, contact support."},
	503: {"upstream_unavailable", "Retry later with exponential backoff."},
}

func failWith(status int, message string) *failure {
	details := statusDetails[status]
	return &failure{status: status, code: details.code, message: message, hint: details.hint}
}

// sentinelMessages replace the backend's internal wording when an error is
// a bare sentinel rather than a message written for the person.
var sentinelMessages = map[error]string{
	publishing.ErrUnauthorized: "The API key is not authorized.",
	publishing.ErrForbidden:    "This key or workspace may not do that.",
	publishing.ErrNotFound:     "Not found in this workspace.",
	publishing.ErrConflict:     "The resource is not in a state that allows this.",
	publishing.ErrInvalidState: "The resource is not in a state that allows this.",
	product.ErrInvalidInput:    "The input is invalid.",
}

func message(err error) string {
	if text, ok := sentinelMessages[err]; ok {
		return text
	}
	return err.Error()
}

// failureFor maps a domain error the way the REST API reports it.
func failureFor(err error) *failure {
	var refused *failure
	var notEntitled *product.FeatureNotEntitledError
	var exceeded *product.QuotaExceededError
	var prohibited *product.ProhibitedTermsError
	switch {
	case errors.As(err, &refused):
		return refused
	case errors.As(err, &notEntitled):
		return &failure{status: http.StatusForbidden, code: "workspace_feature_not_entitled", message: err.Error(),
			hint: fmt.Sprintf("Upgrade to %s or ask a workspace owner to review the contract entitlement.", notEntitled.RequiredPlan),
			extra: map[string]any{"feature": notEntitled.Feature, "currentPlan": notEntitled.CurrentPlan,
				"requiredPlan": notEntitled.RequiredPlan}}
	case errors.As(err, &exceeded):
		retryAfter := max(1, int(time.Until(exceeded.ResetAt).Seconds()+0.5))
		f := failWith(http.StatusTooManyRequests, fmt.Sprintf("The workspace has exceeded its %s plan quota.", exceeded.Quota))
		f.code, f.extra = "workspace_quota_exceeded", map[string]any{"limit": exceeded.Limit, "quota": exceeded.Quota, "retryAfter": retryAfter}
		return f
	case errors.As(err, &prohibited):
		f := failWith(http.StatusConflict, err.Error())
		f.extra = map[string]any{"matches": prohibited.Matches}
		return f
	case errors.Is(err, publishing.ErrUnauthorized):
		return failWith(http.StatusUnauthorized, message(err))
	case errors.Is(err, publishing.ErrForbidden):
		return failWith(http.StatusForbidden, message(err))
	case errors.Is(err, publishing.ErrNotFound):
		return failWith(http.StatusNotFound, message(err))
	case errors.Is(err, publishing.ErrConflict), errors.Is(err, publishing.ErrInvalidState):
		return failWith(http.StatusConflict, message(err))
	case errors.Is(err, publishing.ErrNotEligible), errors.Is(err, product.ErrInvalidInput), errors.Is(err, product.ErrObjectMissing):
		return failWith(http.StatusBadRequest, message(err))
	case errors.Is(err, product.ErrRateLimited), errors.Is(err, product.ErrStorageQuota), errors.Is(err, product.ErrQuotaExceeded):
		return failWith(http.StatusTooManyRequests, err.Error())
	case errors.Is(err, product.ErrStorageUnavailable), errors.Is(err, context.DeadlineExceeded):
		return failWith(http.StatusServiceUnavailable, "A required dependency is unavailable.")
	default:
		return failWith(http.StatusInternalServerError, "Internal server error.")
	}
}

func documentation() string {
	if frontend := strings.TrimRight(os.Getenv("FRONTEND_URL"), "/"); frontend != "" {
		return frontend + "/api-reference#errors"
	}
	return "https://shots.playbookmedia.io/api-reference#errors"
}

func (f *failure) result() *sdk.CallToolResult {
	body := map[string]any{"code": f.code, "documentation": documentation(), "error": f.message, "hint": f.hint,
		"message": f.message, "status": f.status}
	for key, value := range f.extra {
		body[key] = value
	}
	data, _ := json.Marshal(body)
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(data)}}, IsError: true}
}

func outcome(status int) string {
	switch {
	case status == 0:
		return "ok"
	case status == 401 || status == 403 || status == 429:
		return "denied"
	case status < 500:
		return "invalid"
	default:
		return "error"
	}
}

// limit counts a call against a per-key budget. An unavailable counter
// skips it: writes stay metered by the workspace quota, which fails closed.
func (s *Server) limit(ctx context.Context, bucket, keyID string, perMinute int) *failure {
	if s.config.Limiter == nil {
		return nil
	}
	now := time.Now()
	window := now.Truncate(time.Minute)
	count, err := s.config.Limiter.Increment(ctx, fmt.Sprintf("screenshot-studio:mcp:%s:%s:%d", bucket, keyID, window.Unix()), 1, time.Minute)
	if err != nil || count <= perMinute {
		return nil
	}
	f := failWith(http.StatusTooManyRequests, fmt.Sprintf("This key is limited to %d calls a minute.", perMinute))
	f.extra = map[string]any{"limit": perMinute, "retryAfter": max(1, int(window.Add(time.Minute).Sub(now).Seconds()+0.5))}
	return f
}

// authorize runs the checks requireTenantAccess runs for the REST operation,
// in its order: scope, workspace:use, the declared feature, then the quota.
func (s *Server) authorize(ctx context.Context, call principal, actor product.Actor, operation *shotsapi.Operation) error {
	if !call.key.HasScope(operation.Scope) {
		return failWith(http.StatusForbidden, fmt.Sprintf("This API key needs the %s scope.", operation.Scope))
	}
	features := []string{"workspace:use"}
	if operation.Entitlement.Feature != "workspace:use" {
		features = append(features, operation.Entitlement.Feature)
	}
	for _, feature := range features {
		decision, err := s.config.Product.GetFeatureDecision(ctx, actor, feature)
		if err != nil {
			return err
		}
		if !decision.Allowed {
			return &product.FeatureNotEntitledError{Feature: feature, CurrentPlan: decision.CurrentPlan, RequiredPlan: decision.RequiredPlan}
		}
	}
	if operation.Entitlement.Quota != "" {
		if _, err := s.config.Product.ConsumeWorkspaceQuota(ctx, actor, operation.Entitlement.Quota, 1); err != nil {
			return err
		}
	}
	return nil
}

// arguments decodes, defaults, and validates a call's arguments against the
// operation's schema, as route() parses a REST request.
func (t *shotsTool) arguments(raw json.RawMessage) (map[string]any, error) {
	args := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, failWith(http.StatusBadRequest, "The arguments must be a JSON object.")
		}
	}
	if err := t.input.ApplyDefaults(&args); err != nil {
		return nil, failWith(http.StatusBadRequest, "The arguments are invalid.")
	}
	if err := t.input.Validate(args); err != nil {
		return nil, failWith(http.StatusBadRequest, "The arguments are invalid: "+err.Error())
	}
	return args, nil
}

// call runs one tool call through the REST pipeline and logs it.
func (s *Server) call(ctx context.Context, call principal, tool *shotsTool, raw json.RawMessage) *sdk.CallToolResult {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	result, status := s.execute(ctx, call, tool, raw)
	slog.Info("shots.mcp_call", "requestId", call.requestID, "tool", tool.operation.ID, "client", call.client,
		"organizationId", call.key.OrganizationID, "keyId", call.key.ID, "outcome", outcome(status), "status", status,
		"durationMs", time.Since(started).Milliseconds())
	return result
}

func (s *Server) execute(ctx context.Context, call principal, tool *shotsTool, raw json.RawMessage) (*sdk.CallToolResult, int) {
	refuse := func(err error) (*sdk.CallToolResult, int) {
		f := failureFor(err)
		if f.status >= 500 {
			slog.Error("shots.mcp_call failed", "requestId", call.requestID, "tool", tool.operation.ID, "error", err)
		}
		return f.result(), f.status
	}
	if f := s.limit(ctx, "key", call.key.ID, callsPerKeyMinute); f != nil {
		return f.result(), f.status
	}
	if tool.perKeyLimit > 0 {
		if f := s.limit(ctx, tool.operation.ID, call.key.ID, tool.perKeyLimit); f != nil {
			return f.result(), f.status
		}
	}
	actor := call.key.Actor(call.requestID)
	if err := s.authorize(ctx, call, actor, tool.operation); err != nil {
		return refuse(err)
	}
	args, err := tool.arguments(raw)
	if err != nil {
		return refuse(err)
	}
	output, err := tool.run(ctx, s, actor, args)
	if err != nil {
		return refuse(err)
	}
	if ready, ok := output.(*sdk.CallToolResult); ok {
		return ready, 0
	}
	data, err := json.Marshal(output)
	if err != nil {
		return refuse(err)
	}
	var value any
	_ = json.Unmarshal(data, &value)
	value = shotsapi.Project(value, tool.operation.OutputSchema)
	data, _ = json.Marshal(value)
	result := &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: string(data)}}}
	if tool.spec.OutputSchema != nil {
		result.StructuredContent = value
	}
	return result, 0
}

// decode copies validated arguments into a domain input struct.
func decode(args map[string]any, target any) error {
	data, err := json.Marshal(args)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func stringArg(args map[string]any, name string) string {
	value, _ := args[name].(string)
	return value
}

func intArg(args map[string]any, name string) int {
	value, _ := args[name].(float64)
	return int(value)
}

func optionalString(args map[string]any, name string) *string {
	if value, ok := args[name].(string); ok {
		return &value
	}
	return nil
}

func listReleases(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	releases, err := s.config.Product.ListReleases(ctx, actor, intArg(args, "limit"))
	return map[string]any{"releases": releases}, err
}

func createRelease(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.CreateReleaseInput
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The release input is invalid.")
	}
	// Like POST /api/v1/releases, a call without a key gets a fresh one.
	if input.IdempotencyKey == "" {
		input.IdempotencyKey = uuid.NewString()
	}
	return s.config.Product.CreateRelease(ctx, actor, input)
}

func createAssetUploadURL(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.AssetUploadInput
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The asset metadata is invalid.")
	}
	return s.config.Product.SignAssetUpload(ctx, actor, input)
}

func completeAssetUpload(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	asset, err := s.config.Product.CompleteAssetUpload(ctx, actor, stringArg(args, "assetId"), optionalString(args, "sha256"))
	return map[string]any{"asset": asset}, err
}

func createAssetDownloadURL(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	downloadURL, err := s.config.Product.SignAssetDownload(ctx, actor, stringArg(args, "assetId"))
	return map[string]any{"downloadUrl": downloadURL}, err
}

func deleteAsset(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	result, err := s.config.Product.DeleteAsset(ctx, actor, stringArg(args, "assetId"))
	switch {
	case err != nil:
		return nil, err
	case result == product.AssetMissing:
		return nil, failWith(http.StatusNotFound, "Asset not found.")
	case result == product.AssetInUse:
		return nil, failWith(http.StatusConflict, "Asset is in use by a creative variant.")
	case result == product.AssetNotReady:
		return nil, failWith(http.StatusConflict, "Only uploaded assets can be deleted.")
	}
	return map[string]any{"accepted": true}, nil
}

// captureScreenshot renders a public page and answers with the image itself.
func captureScreenshot(ctx context.Context, s *Server, _ product.Actor, args map[string]any) (any, error) {
	pageURL := stringArg(args, "url")
	if !capture.PublicPageURL(pageURL) {
		return nil, failWith(http.StatusBadRequest, "Only public http(s) pages can be captured.")
	}
	if s.config.Capture == nil {
		return nil, failWith(http.StatusServiceUnavailable, "Screenshot capture is not configured.")
	}
	device, scheme := stringArg(args, "deviceType"), stringArg(args, "colorScheme")
	image, err := s.config.Capture.CaptureWith(ctx, pageURL, capture.Options{Mobile: device == "mobile", ColorScheme: scheme})
	if err != nil {
		slog.Warn("shots.mcp_capture failed", "error", err)
		return nil, failWith(http.StatusServiceUnavailable, "The screenshot service could not capture the page.")
	}
	mimeType := http.DetectContentType(image)
	if mimeType != "image/png" && mimeType != "image/jpeg" {
		return nil, failWith(http.StatusServiceUnavailable, "The screenshot service returned an unsupported image.")
	}
	summary, _ := json.Marshal(map[string]any{"colorScheme": scheme, "deviceType": device, "url": pageURL})
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.ImageContent{Data: image, MIMEType: mimeType},
		&sdk.TextContent{Text: string(summary)}}}, nil
}

func listCampaigns(ctx context.Context, s *Server, actor product.Actor, _ map[string]any) (any, error) {
	campaigns, err := s.config.Product.ListCampaigns(ctx, actor)
	return map[string]any{"data": campaigns, "pagination": map[string]any{"hasMore": false, "nextCursor": nil}}, err
}

func getCampaign(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.GetCampaign(ctx, actor, stringArg(args, "campaignId"))
}

func createCampaign(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.CreateCampaignInput
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The campaign input is invalid.")
	}
	campaign, err := s.config.Product.CreateCampaign(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return map[string]any{"campaign": campaign, "created": campaign.Created != nil && *campaign.Created}, nil
}

func listApprovals(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	page, err := s.config.Product.ListPendingApprovals(ctx, actor, intArg(args, "limit"), stringArg(args, "cursor"))
	if err != nil {
		return nil, err
	}
	return map[string]any{"data": page.Items,
		"pagination": map[string]any{"hasMore": page.NextCursor != nil, "nextCursor": page.NextCursor}}, nil
}

func requestCampaignReview(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input struct {
		PostIDs []string `json:"postIds"`
	}
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The post identifiers are invalid.")
	}
	return s.config.Product.TransitionCampaignPosts(ctx, actor, stringArg(args, "campaignId"),
		product.CampaignPostDecision{Decision: "submit", PostIDs: input.PostIDs})
}

// scheduleCampaignPost schedules approved copy. The REST route reads the
// post's links before it schedules, in the web tier; this server cannot, so
// it refuses rather than skip a check REST would run.
func scheduleCampaignPost(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	if skip, _ := args["skipLinkCheck"].(bool); !skip {
		return nil, failWith(http.StatusBadRequest, "This server cannot check link previews. Check each link in the post with GET /api/v1/link-preview, then call again with skipLinkCheck: true.")
	}
	var input product.ScheduleCampaignPostInput
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The schedule input is invalid.")
	}
	if input.ScheduledAt != nil && !input.ScheduledAt.After(time.Now()) {
		return nil, failWith(http.StatusBadRequest, "Scheduled time must be in the future.")
	}
	result, err := s.config.Product.ScheduleCampaignPost(ctx, actor, stringArg(args, "campaignId"), stringArg(args, "postId"), input)
	if err != nil {
		return nil, err
	}
	return result.Post, nil
}

func listScheduledPosts(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	limit := intArg(args, "limit")
	posts, err := s.config.Product.ListScheduledPosts(ctx, actor, limit)
	if err != nil {
		return nil, err
	}
	items := make([]any, 0, len(posts))
	for _, post := range posts {
		items = append(items, product.ScheduledPostView(post))
	}
	return map[string]any{"data": items, "pagination": map[string]any{"hasMore": len(posts) == limit, "nextCursor": nil}}, nil
}

func createScheduledPost(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input publishing.CreateScheduledPostInput
	if err := decode(args, &input); err != nil {
		return nil, failWith(http.StatusBadRequest, "The scheduled post input is invalid.")
	}
	// Like POST /api/v1/scheduled-posts, a call without a key gets a fresh one.
	if input.IdempotencyKey == "" {
		input.IdempotencyKey = uuid.NewString()
	}
	if !input.ScheduledFor.After(time.Now()) {
		return nil, failWith(http.StatusBadRequest, "Scheduled time must be in the future.")
	}
	result, err := s.config.Product.CreateScheduledPost(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	return map[string]any{"created": result.Created, "scheduledPost": product.ScheduledPostView(result.Post)}, nil
}

func cancelScheduledPost(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	post, err := s.config.Product.CancelScheduledPost(ctx, actor, stringArg(args, "scheduledPostId"))
	if err != nil {
		return nil, err
	}
	return map[string]any{"scheduledPost": product.ScheduledPostView(post)}, nil
}
