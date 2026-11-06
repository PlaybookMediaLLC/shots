package mcp

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	platformdb "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
)

// memoryMeter meters the monthly posts allowance without Redis.
type memoryMeter struct {
	sync.Mutex
	used map[string]int64
}

func (m *memoryMeter) Meter(_ context.Context, key string, amount, limit int64) (quota.MonthlyUsage, error) {
	m.Lock()
	defer m.Unlock()
	if m.used == nil {
		m.used = map[string]int64{}
	}
	m.used[key] += amount
	used := m.used[key]
	return quota.MonthlyUsage{Used: min(used, limit), Remaining: max(limit-used, 0), Reached: used > limit}, nil
}

type memoryCounter struct {
	sync.Mutex
	counts map[string]int
}

func (c *memoryCounter) Increment(_ context.Context, key string, amount int, _ time.Duration) (int, error) {
	c.Lock()
	defer c.Unlock()
	if c.counts == nil {
		c.counts = map[string]int{}
	}
	c.counts[key] += amount
	return c.counts[key], nil
}

func (c *memoryCounter) consumed(prefix string) int {
	c.Lock()
	defer c.Unlock()
	total := 0
	for key, count := range c.counts {
		if strings.HasPrefix(key, prefix) {
			total += count
		}
	}
	return total
}

type memoryObjects struct{}

func (memoryObjects) SignUpload(_ context.Context, key, _ string) (string, error) {
	return "https://storage.test/upload/" + key, nil
}
func (memoryObjects) SignDownload(_ context.Context, key string) (string, error) {
	return "https://storage.test/download/" + key, nil
}
func (memoryObjects) Exists(context.Context, string) (bool, error)         { return true, nil }
func (memoryObjects) Put(context.Context, string, string, io.Reader) error { return nil }
func (memoryObjects) Delete(context.Context, string) error                 { return nil }

func (memoryObjects) Read(context.Context, string) ([]byte, error) {
	var body bytes.Buffer
	err := png.Encode(&body, image.NewRGBA(image.Rect(0, 0, 1, 1)))
	return body.Bytes(), err
}

type fakeCapture struct{ pages []string }

func (f *fakeCapture) CaptureWith(ctx context.Context, pageURL string, _ capture.Options) ([]byte, error) {
	f.pages = append(f.pages, pageURL)
	return (memoryObjects{}).Read(ctx, "")
}

// fixture is two paying workspaces and one without a plan, each with keys.
type fixture struct {
	t        *testing.T
	ctx      context.Context
	db       *platformdb.Database
	product  *product.Configuration
	counter  *memoryCounter
	capture  *fakeCapture
	server   *httptest.Server
	id       string
	orgs     map[string]string
	keys     map[string]string
	keyNames map[string]string
}

func hashKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	t.Setenv("PLATFORM_CAMPAIGN_WORKFLOW", "")
	t.Setenv("PLATFORM_MCP_URL", "https://api.shots.test/mcp")
	t.Setenv("FRONTEND_URL", "https://shots.test")
	ctx := context.Background()
	db, err := platformdb.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	f := &fixture{t: t, ctx: ctx, db: db, counter: &memoryCounter{}, capture: &fakeCapture{}, id: cuid.New(),
		orgs: map[string]string{}, keys: map[string]string{}, keyNames: map[string]string{}}
	f.product = product.NewConfiguration(db.Client).WithObjectStore(memoryObjects{}).WithQuotaCounter(f.counter).
		WithMonthlyMeter(&memoryMeter{}).WithAssetDownloads(strings.Repeat("m", 32), "https://shots.test")
	for _, workspace := range []string{"a", "b", "free"} {
		org := "org_" + workspace + "_" + f.id
		f.orgs[workspace] = org
		f.exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, org)
		if workspace != "free" {
			f.exec(`INSERT INTO workspace_entitlement ("organizationId", plan, status, "updatedAt") VALUES ($1,'pro','active',now())`, org)
		}
	}
	t.Cleanup(func() {
		for _, org := range f.orgs {
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM apikey WHERE "referenceId"=$1`, org)
			_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1`, org)
		}
	})
	all := `{"artifact":["read"],"asset":["write"],"release":["create"],"source":["write"],"upload":["sign"]}`
	f.key("a", "a", all, true)
	f.key("a-read", "a", `{"artifact":["read"]}`, true)
	f.key("a-schedule", "a", strings.Replace(all, "}", `,"post":["schedule"]}`, 1), true)
	f.key("a-off", "a", all, false)
	f.key("b", "b", all, true)
	f.key("free", "free", all, true)
	s, err := New(Config{Product: f.product, Capture: f.capture, Limiter: f.counter})
	if err != nil {
		t.Fatal(err)
	}
	f.server = httptest.NewServer(s.Handler(http.NotFoundHandler()))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.SQL.ExecContext(f.ctx, query, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, query)
	}
}

func (f *fixture) key(label, workspace, permissions string, enabled bool) {
	raw := "ss_" + label + "_" + f.id
	id := "key_" + strings.ReplaceAll(label, "-", "_") + "_" + f.id
	f.keys[label], f.keyNames[label] = raw, "Key "+label
	f.exec(`INSERT INTO apikey (id,"referenceId",key,name,start,prefix,enabled,permissions,"createdAt","updatedAt")
		VALUES ($1,$2,$3,$4,$5,'ss_',$6,$7,now(),now())`, id, f.orgs[workspace], hashKey(raw), f.keyNames[label], raw[:6], enabled, permissions)
}

func (f *fixture) actor(label string) product.Actor {
	key, err := f.product.VerifyAPIKey(f.ctx, f.keys[label])
	if err != nil {
		f.t.Fatalf("%s: %v", label, err)
	}
	return key.Actor("fixture-" + f.id)
}

type headers map[string]string

func (h headers) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	for name, value := range h {
		request.Header.Set(name, value)
	}
	return http.DefaultTransport.RoundTrip(request)
}

func (f *fixture) session(label string, extra ...string) *sdk.ClientSession {
	f.t.Helper()
	set := headers{"Authorization": "Bearer " + f.keys[label]}
	for i := 0; i+1 < len(extra); i += 2 {
		set[extra[i]] = extra[i+1]
	}
	client := sdk.NewClient(&sdk.Implementation{Name: "shots-test", Version: "1"}, nil)
	session, err := client.Connect(f.ctx, &sdk.StreamableClientTransport{Endpoint: f.server.URL + "/mcp",
		HTTPClient: &http.Client{Transport: set}, DisableStandaloneSSE: true}, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { _ = session.Close() })
	return session
}

// call runs a tool and returns its JSON body and whether it was an error.
func (f *fixture) call(session *sdk.ClientSession, tool string, args map[string]any) (map[string]any, bool) {
	f.t.Helper()
	result, err := session.CallTool(f.ctx, &sdk.CallToolParams{Name: tool, Arguments: args})
	if err != nil {
		f.t.Fatalf("%s: %v", tool, err)
	}
	body := map[string]any{}
	for _, content := range result.Content {
		if text, ok := content.(*sdk.TextContent); ok {
			_ = json.Unmarshal([]byte(text.Text), &body)
		}
	}
	if !result.IsError && result.StructuredContent != nil {
		f.checkOutput(tool, result.StructuredContent)
	}
	return body, result.IsError
}

// checkOutput validates a result against the REST operation's response
// schema: an agent gets exactly what the API documents.
func (f *fixture) checkOutput(tool string, value any) {
	f.t.Helper()
	tools, _ := buildTools()
	for _, candidate := range tools {
		if candidate.spec.Name != tool || candidate.spec.OutputSchema == nil {
			continue
		}
		data, _ := json.Marshal(candidate.spec.OutputSchema)
		var schema jsonschema.Schema
		_ = json.Unmarshal(data, &schema)
		resolved, err := schema.Resolve(nil)
		if err != nil {
			f.t.Fatalf("%s output schema: %v", tool, err)
		}
		encoded, _ := json.Marshal(value)
		var instance any
		_ = json.Unmarshal(encoded, &instance)
		if err := resolved.Validate(instance); err != nil {
			f.t.Fatalf("%s output does not match the REST response schema: %v\n%s", tool, err, encoded)
		}
	}
}

func refusedWith(t *testing.T, tool string, body map[string]any, isError bool, code string) {
	t.Helper()
	if !isError || body["code"] != code {
		t.Fatalf("%s: want %s, got isError=%v %v", tool, code, isError, body)
	}
}

// seed creates workspace B's records through the domain, the way REST would.
func (f *fixture) seed(label string) (releaseID, campaignID, assetID string) {
	f.t.Helper()
	actor := f.actor(label)
	created, err := f.product.CreateRelease(f.ctx, actor, product.CreateReleaseInput{Title: "Release " + label,
		BenefitStatement: "Faster exports", IdempotencyKey: "seed-" + label + f.id})
	if err != nil {
		f.t.Fatal(err)
	}
	campaign, err := f.product.CreateCampaign(f.ctx, actor, product.CreateCampaignInput{Name: "Campaign " + label,
		Objective: "Adoption", Posts: []product.CampaignPostInput{{Channel: "x", Copy: "Post " + label}}})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.product.TransitionCampaignPosts(f.ctx, actor, campaign.ID, product.CampaignPostDecision{Decision: "submit"}); err != nil {
		f.t.Fatal(err)
	}
	imageBytes, err := (memoryObjects{}).Read(f.ctx, "")
	if err != nil {
		f.t.Fatal(err)
	}
	upload, err := f.product.SignAssetUpload(f.ctx, actor, product.AssetUploadInput{Bytes: len(imageBytes), ContentType: "image/png", FileName: "b.png"})
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.product.CompleteAssetUpload(f.ctx, actor, upload.Asset.ID, nil); err != nil {
		f.t.Fatal(err)
	}
	return created.Release.ID, campaign.ID, upload.Asset.ID
}

func ids(items any, path ...string) []string {
	found := []string{}
	list, _ := items.([]any)
	for _, item := range list {
		value := item
		for _, key := range path {
			value = value.(map[string]any)[key]
		}
		found = append(found, fmt.Sprint(value))
	}
	return found
}

func TestMCPAssetDownloadGrantIsRevocableAcrossServices(t *testing.T) {
	f := newFixture(t)
	_, _, assetID := f.seed("a")
	body, isError := f.call(f.session("a-read"), "createAssetDownloadUrl", map[string]any{"assetId": assetID})
	if isError {
		t.Fatalf("MCP download grant failed: %v", body)
	}
	raw, _ := body["downloadUrl"].(string)
	link, err := url.Parse(raw)
	if err != nil || link.Host != "shots.test" || link.Path != "/api/v1/assets/"+assetID+"/content" || link.Query().Get("downloadToken") == "" {
		t.Fatal("MCP did not return an application download grant")
	}
	// A separately configured product API must accept the MCP-issued grant.
	reader := product.NewConfiguration(f.db.Client).WithObjectStore(memoryObjects{}).
		WithAssetDownloads(strings.Repeat("m", 32), "https://shots.test")
	token := link.Query().Get("downloadToken")
	if _, _, err := reader.ReadAssetDownload(f.ctx, assetID, token, "mcp-download-allowed"); err != nil {
		t.Fatal("product API refused MCP grant", err)
	}
	f.exec(`UPDATE apikey SET enabled=false WHERE id=$1`, f.actor("a-read").KeyID)
	if _, _, err := reader.ReadAssetDownload(f.ctx, assetID, token, "mcp-download-revoked"); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatalf("revoked MCP key still authorized its grant: %v", err)
	}
}

// A key from workspace A reaches only A's records through every tool, and
// every identifier from workspace B is not found.
func TestEveryToolIsTenantIsolated(t *testing.T) {
	f := newFixture(t)
	otherRelease, otherCampaign, otherAsset := f.seed("b")
	ownRelease, ownCampaign, _ := f.seed("a")
	session := f.session("a")

	listed, err := session.ListTools(f.ctx, nil)
	if err != nil || len(listed.Tools) != 23 {
		t.Fatalf("tools/list: %d %v", len(listed.Tools), err)
	}

	body, isError := f.call(session, "listReleases", map[string]any{})
	releases := ids(body["releases"], "id")
	if isError || !slices.Contains(releases, ownRelease) || slices.Contains(releases, otherRelease) {
		t.Fatalf("listReleases: %v", body)
	}
	body, isError = f.call(session, "createRelease", map[string]any{"title": "Agent release", "benefitStatement": "Clearer"})
	created := body["release"].(map[string]any)["id"].(string)
	if isError || body["created"] != true ||
		f.db.Client.Release.Query().Where(release.ID(created), release.OrganizationID(f.orgs["a"])).CountX(f.ctx) != 1 {
		t.Fatalf("createRelease: %v", body)
	}

	imageBytes, err := (memoryObjects{}).Read(f.ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	body, isError = f.call(session, "createAssetUploadUrl", map[string]any{"bytes": len(imageBytes), "contentType": "image/png", "fileName": "a.png"})
	ownAsset := body["asset"].(map[string]any)["id"].(string)
	if isError || f.db.Client.Asset.Query().Where(asset.ID(ownAsset), asset.OrganizationID(f.orgs["a"])).CountX(f.ctx) != 1 {
		t.Fatalf("createAssetUploadUrl: %v", body)
	}
	if body, isError = f.call(session, "completeAssetUpload", map[string]any{"assetId": ownAsset}); isError {
		t.Fatalf("completeAssetUpload: %v", body)
	}
	if body, isError = f.call(session, "createAssetDownloadUrl", map[string]any{"assetId": ownAsset}); isError || body["downloadUrl"] == "" {
		t.Fatalf("createAssetDownloadUrl: %v", body)
	}
	for _, tool := range []string{"completeAssetUpload", "createAssetDownloadUrl", "deleteAsset"} {
		body, isError = f.call(session, tool, map[string]any{"assetId": otherAsset})
		refusedWith(t, tool, body, isError, "not_found")
	}
	if f.db.Client.Asset.Query().Where(asset.ID(otherAsset), asset.StatusEQ(asset.StatusUPLOADED)).CountX(f.ctx) != 1 {
		t.Fatal("workspace B's asset changed")
	}

	body, isError = f.call(session, "listCampaigns", map[string]any{})
	campaigns := ids(body["data"], "id")
	if isError || !slices.Contains(campaigns, ownCampaign) || slices.Contains(campaigns, otherCampaign) {
		t.Fatalf("listCampaigns: %v", body)
	}
	if body, isError = f.call(session, "getCampaign", map[string]any{"campaignId": ownCampaign}); isError || body["id"] != ownCampaign {
		t.Fatalf("getCampaign: %v", body)
	}
	body, isError = f.call(session, "getCampaign", map[string]any{"campaignId": otherCampaign})
	refusedWith(t, "getCampaign", body, isError, "not_found")

	body, isError = f.call(session, "createCampaign", map[string]any{"name": "Agent campaign", "objective": "Adoption",
		"posts": []any{map[string]any{"channel": "linkedin", "copy": "Draft"}}, "idempotencyKey": "agent-" + f.id})
	agentCampaign := body["campaign"].(map[string]any)
	if isError || body["created"] != true || agentCampaign["organizationId"] != f.orgs["a"] {
		t.Fatalf("createCampaign: %v", body)
	}
	if _, has := agentCampaign["created"]; has {
		t.Fatal("a field outside the REST contract reached the agent")
	}
	body, _ = f.call(session, "createCampaign", map[string]any{"name": "Agent campaign", "objective": "Adoption",
		"idempotencyKey": "agent-" + f.id})
	if body["created"] != false || body["campaign"].(map[string]any)["id"] != agentCampaign["id"] {
		t.Fatalf("idempotent replay: %v", body)
	}

	body, isError = f.call(session, "listApprovals", map[string]any{})
	queued := ids(body["data"], "campaign", "id")
	if isError || !slices.Contains(queued, ownCampaign) || slices.Contains(queued, otherCampaign) {
		t.Fatalf("listApprovals: %v", body)
	}
	body, isError = f.call(session, "requestCampaignReview", map[string]any{"campaignId": otherCampaign})
	refusedWith(t, "requestCampaignReview", body, isError, "not_found")
	if body, isError = f.call(session, "requestCampaignReview", map[string]any{"campaignId": agentCampaign["id"]}); isError ||
		body["status"] != "READY_FOR_REVIEW" {
		t.Fatalf("requestCampaignReview: %v", body)
	}
	if f.db.Client.CampaignPost.Query().Where(campaignpost.CampaignID(otherCampaign),
		campaignpost.StatusEQ(campaignpost.StatusREADY_FOR_REVIEW)).CountX(f.ctx) != 1 {
		t.Fatal("workspace B's posts changed")
	}

	result, err := session.CallTool(f.ctx, &sdk.CallToolParams{Name: "captureScreenshot",
		Arguments: map[string]any{"url": "https://example.com/pricing", "deviceType": "mobile"}})
	if err != nil || result.IsError || len(result.Content) != 2 || result.Content[0].(*sdk.ImageContent).MIMEType != "image/png" {
		t.Fatalf("captureScreenshot: %+v %v", result, err)
	}
	body, isError = f.call(session, "captureScreenshot", map[string]any{"url": "http://169.254.169.254/latest"})
	refusedWith(t, "captureScreenshot", body, isError, "invalid_request")
	if slices.Contains(f.capture.pages, "http://169.254.169.254/latest") {
		t.Fatal("a private address was sent to the screenshot service")
	}

	// Writes consumed the workspace's REST write quota.
	if f.counter.consumed("screenshot-studio:quota:api:write:minute:"+f.orgs["a"]) < 6 {
		t.Fatalf("write quota: %v", f.counter.counts)
	}
	// Deleting comes last: it is the one destructive tool.
	if body, isError = f.call(session, "deleteAsset", map[string]any{"assetId": ownAsset}); isError || body["accepted"] != true {
		t.Fatalf("deleteAsset: %v", body)
	}
}

func post(t *testing.T, url string, header ...string) (*http.Response, string) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodPost, url, bytes.NewBufferString(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for i := 0; i+1 < len(header); i += 2 {
		request.Header.Set(header[i], header[i+1])
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	return response, string(body)
}

func TestUnauthenticatedAndInvalidKeysAreRefused(t *testing.T) {
	f := newFixture(t)
	for name, header := range map[string][]string{
		"no credential":           nil,
		"unknown key":             {"Authorization", "Bearer ss_unknown_" + f.id},
		"disabled key":            {"Authorization", "Bearer " + f.keys["a-off"]},
		"a social OAuth token":    {"Authorization", "Bearer pos_" + f.id},
		"a key hash, not the key": {"Authorization", "Bearer " + hashKey(f.keys["a"])},
		"a key in X-API-Key, bad": {"X-API-Key", "ss_bad"},
	} {
		response, body := post(t, f.server.URL+"/mcp", header...)
		if response.StatusCode != http.StatusUnauthorized || !strings.Contains(response.Header.Get("WWW-Authenticate"), "resource_metadata=") {
			t.Fatalf("%s: %d %s", name, response.StatusCode, body)
		}
	}
	if response, body := post(t, f.server.URL+"/mcp", "X-API-Key", f.keys["a"]); response.StatusCode != http.StatusOK {
		t.Fatalf("X-API-Key: %d %s", response.StatusCode, body)
	}
}

// A call blocked by a plan gate is refused with the REST envelope: 403,
// workspace_feature_not_entitled, and the feature and plans requireTenantAccess
// reports.
func TestEntitlementRefusalMatchesREST(t *testing.T) {
	f := newFixture(t)
	body, isError := f.call(f.session("free"), "listReleases", map[string]any{})
	refusedWith(t, "listReleases", body, isError, "workspace_feature_not_entitled")
	if body["status"] != float64(403) || body["feature"] != "workspace:use" || body["currentPlan"] != "free" ||
		body["requiredPlan"] != "pro" {
		t.Fatalf("free workspace: %v", body)
	}
	// A contract override that withholds the campaign workflow refuses the
	// campaign tools, and only them.
	f.exec(`UPDATE workspace_entitlement SET "featureOverrides"='{"campaign:workflow":false,"asset:create":false}' WHERE "organizationId"=$1`, f.orgs["a"])
	session := f.session("a")
	body, isError = f.call(session, "listCampaigns", map[string]any{})
	refusedWith(t, "listCampaigns", body, isError, "workspace_feature_not_entitled")
	if body["feature"] != "campaign:workflow" || body["currentPlan"] != "pro" {
		t.Fatalf("campaign override: %v", body)
	}
	body, isError = f.call(session, "createAssetUploadUrl", map[string]any{"bytes": 1, "contentType": "image/png", "fileName": "x.png"})
	refusedWith(t, "createAssetUploadUrl", body, isError, "workspace_feature_not_entitled")
	if body["feature"] != "asset:create" {
		t.Fatalf("asset override: %v", body)
	}
	if _, isError = f.call(session, "listReleases", map[string]any{}); isError {
		t.Fatal("an override for other features refused releases")
	}
}

// A key sees only the tools its scopes allow; agents never see a decision tool.
func TestScopesLimitTheToolList(t *testing.T) {
	f := newFixture(t)
	session := f.session("a-read")
	listed, err := session.ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	// The SDK lists tools by name.
	want := []string{"bestPostingTimes", "captureScreenshot", "createAssetDownloadUrl", "getCampaign", "getContentDraft", "getSocialSet", "listApprovals", "listCalendarPosts", "listCampaigns", "listContentDraftActivity", "listContentDraftPosts", "listContentDrafts", "listDraftComments", "listReleases", "listScheduledPosts", "listSocialSets", "lookupSocialSetMentions"}
	if !slices.Equal(names, want) {
		t.Fatalf("read-only key tools=%v", names)
	}
	if _, err := session.CallTool(f.ctx, &sdk.CallToolParams{Name: "createRelease", Arguments: map[string]any{"title": "x"}}); err == nil {
		t.Fatal("a read-only key called createRelease")
	}
}

// A mutation through MCP is audited in its transaction with the call's
// request ID and the key as the actor.
func TestMutationsAreAuditedWithTheRequestID(t *testing.T) {
	f := newFixture(t)
	requestID := "mcp-audit-" + f.id
	session := f.session("a", "X-Request-Id", requestID)
	body, isError := f.call(session, "createCampaign", map[string]any{"name": "Audited", "objective": "Adoption"})
	if isError {
		t.Fatalf("createCampaign: %v", body)
	}
	id := body["campaign"].(map[string]any)["id"].(string)
	row, err := f.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(f.orgs["a"]), auditlog.EntityID(id),
		auditlog.Action("product.campaign_created")).Only(f.ctx)
	if err != nil || row.RequestID != requestID || row.ActorDisplay == nil || *row.ActorDisplay != f.keyNames["a"] {
		t.Fatalf("audit: %+v %v", row, err)
	}
}

// approvedPost makes what a person would have approved in workspace A: a
// LinkedIn post with an approved visual, another post still in review, and
// an active LinkedIn connection. Approving goes through a session; no key can.
func (f *fixture) approvedPost() (campaignID, approved, pending, variantID, connectionID string) {
	f.t.Helper()
	org, userID := f.orgs["a"], "user_"+f.id
	f.exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, userID, userID+"@example.test")
	f.t.Cleanup(func() { _, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "user" WHERE id=$1`, userID) })
	f.exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`, "session_"+f.id, userID, org)
	f.exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+f.id, org, userID)
	owner := product.Actor{OrganizationID: org, UserID: userID, SessionID: "session_" + f.id, RequestID: "owner-" + f.id}
	// The tools' schemas take only cuid identifiers, as REST does.
	releaseID, campaignID, render, design := cuid.New(), cuid.New(), uuid.NewString(), cuid.New()
	approved, pending = cuid.New(), cuid.New()
	f.exec(`INSERT INTO release (id,"organizationId",title,"benefitStatement","updatedAt") VALUES ($1,$2,'Launch','Faster',now())`, releaseID, org)
	f.exec(`INSERT INTO campaign (id,"organizationId",name,objective,"releaseId","updatedAt") VALUES ($1,$2,'Launch','Adoption',$3,now())`, campaignID, org, releaseID)
	f.exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,width,height,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,1600,900,'UPLOADED',now(),now())`,
		render, org, "org/"+org+"/render/"+render+".png")
	f.exec(`INSERT INTO design (id,"organizationId","campaignId",name,document,"renderedAssetId","updatedAt") VALUES ($1,$2,$3,'Hero','{"version":1}',$4,now())`, design, org, campaignID, render)
	f.exec(`INSERT INTO campaign_post (id,"organizationId","campaignId",channel,copy,status,"updatedAt") VALUES ($1,$3,$4,'linkedin','Ship faster','READY_FOR_REVIEW',now()),($2,$3,$4,'linkedin','Not yet','READY_FOR_REVIEW',now())`,
		approved, pending, org, campaignID)
	if _, err := f.product.TransitionCampaignPosts(f.ctx, owner, campaignID, product.CampaignPostDecision{Decision: "approve", PostIDs: []string{approved}}); err != nil {
		f.t.Fatal(err)
	}
	visual, err := f.product.ApproveCampaignDesign(f.ctx, owner, campaignID, design)
	if err != nil {
		f.t.Fatal(err)
	}
	connection, err := publishing.NewRepository(f.db.Client).CreateConnection(f.ctx, publishing.Actor{Organization: org, UserID: userID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: "li-" + f.id, Platform: "linkedin", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
	if err != nil {
		f.t.Fatal(err)
	}
	return campaignID, approved, pending, visual.Variant.ID, connection.ID
}

// A key with post:schedule schedules what a person approved, in its own
// workspace, and cancels it; a key without the scope never sees the tools.
func TestSchedulingToolsTakeOnlyApprovedContent(t *testing.T) {
	f := newFixture(t)
	_, otherCampaign, _ := f.seed("b")
	campaignID, approved, pending, variantID, connectionID := f.approvedPost()
	listed, err := f.session("a").ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name == "scheduleCampaignPost" || tool.Name == "createScheduledPost" || tool.Name == "cancelScheduledPost" {
			t.Fatalf("a key without post:schedule lists %s", tool.Name)
		}
	}

	requestID := "mcp-schedule-" + f.id
	session := f.session("a-schedule", "X-Request-Id", requestID)
	at := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	schedule := func(campaign, post string, skip bool) (map[string]any, bool) {
		return f.call(session, "scheduleCampaignPost", map[string]any{"campaignId": campaign, "postId": post,
			"channelConnectionId": connectionID, "creativeVariantId": variantID, "scheduledAt": at, "skipLinkCheck": skip})
	}
	body, isError := schedule(campaignID, approved, false)
	refusedWith(t, "scheduleCampaignPost without skipLinkCheck", body, isError, "invalid_request")
	body, isError = schedule(campaignID, pending, true)
	refusedWith(t, "scheduleCampaignPost on copy in review", body, isError, "conflict")
	body, isError = schedule(otherCampaign, approved, true)
	refusedWith(t, "scheduleCampaignPost in workspace B", body, isError, "not_found")
	body, isError = schedule(campaignID, approved, true)
	if isError || body["status"] != "SCHEDULED" || body["scheduledPostStatus"] != "SCHEDULED" {
		t.Fatalf("scheduleCampaignPost: %v", body)
	}
	fromCampaign := body["scheduledPostId"].(string)
	row, err := f.db.Client.AuditLog.Query().Where(auditlog.OrganizationID(f.orgs["a"]), auditlog.EntityID(approved),
		auditlog.Action("product.campaign_post_scheduled")).Only(f.ctx)
	if err != nil || row.RequestID != requestID || row.ActorDisplay == nil || *row.ActorDisplay != f.keyNames["a-schedule"] {
		t.Fatalf("audit: %+v %v", row, err)
	}

	direct := map[string]any{"caption": "Ship faster", "channelConnectionId": connectionID, "variantId": variantID,
		"scheduledFor": at, "idempotencyKey": "agent-" + f.id}
	body, isError = f.call(session, "createScheduledPost", direct)
	created := body["scheduledPost"].(map[string]any)
	if isError || body["created"] != true || created["status"] != "SCHEDULED" {
		t.Fatalf("createScheduledPost: %v", body)
	}
	if body, _ = f.call(session, "createScheduledPost", direct); body["created"] != false ||
		body["scheduledPost"].(map[string]any)["id"] != created["id"] {
		t.Fatalf("idempotent replay: %v", body)
	}

	body, isError = f.call(f.session("b"), "listScheduledPosts", map[string]any{})
	if isError || len(ids(body["data"], "id")) != 0 {
		t.Fatalf("workspace B sees workspace A's schedule: %v", body)
	}
	body, isError = f.call(f.session("b"), "listScheduledPosts", map[string]any{"limit": 10})
	if isError || len(ids(body["data"], "id")) != 0 {
		t.Fatalf("workspace B with a limit: %v", body)
	}
	body, isError = f.call(session, "listScheduledPosts", map[string]any{})
	if listedIDs := ids(body["data"], "id"); isError || !slices.Contains(listedIDs, fromCampaign) || !slices.Contains(listedIDs, created["id"].(string)) {
		t.Fatalf("listScheduledPosts: %v", body)
	}

	f.key("b-schedule", "b", `{"artifact":["read"],"post":["schedule"]}`, true)
	body, isError = f.call(f.session("b-schedule"), "cancelScheduledPost", map[string]any{"scheduledPostId": created["id"]})
	refusedWith(t, "cancelScheduledPost from workspace B", body, isError, "not_found")
	body, isError = f.call(session, "cancelScheduledPost", map[string]any{"scheduledPostId": created["id"]})
	if isError || body["scheduledPost"].(map[string]any)["status"] != "CANCELLED" {
		t.Fatalf("cancelScheduledPost: %v", body)
	}
}

// post:schedule schedules what a person approved, so a key can't send its own
// text by reusing an approved visual, or reach an account in a private set. A
// person who schedules still writes the caption.
func TestScheduleKeyOnlySendsApprovedCopy(t *testing.T) {
	f := newFixture(t)
	campaignID, approved, _, variantID, connectionID := f.approvedPost()
	session := f.session("a-schedule")
	at := time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	direct := func(caption, key string) (map[string]any, bool) {
		return f.call(session, "createScheduledPost", map[string]any{"caption": caption, "channelConnectionId": connectionID,
			"variantId": variantID, "scheduledFor": at, "idempotencyKey": key + f.id})
	}
	scheduled := func() int {
		count, err := f.db.Client.ScheduledPost.Query().Where(scheduledpost.OrganizationID(f.orgs["a"])).Count(f.ctx)
		if err != nil {
			t.Fatal(err)
		}
		return count
	}
	body, isError := direct("Unreviewed text from an agent", "own-")
	refusedWith(t, "createScheduledPost with its own caption", body, isError, "forbidden")
	if count := scheduled(); count != 0 {
		t.Fatalf("scheduled %d posts", count)
	}
	// Surrounding space doesn't make approved copy new text.
	if body, isError = direct("  Ship faster  ", "approved-"); isError || body["created"] != true {
		t.Fatalf("approved copy: %v", body)
	}
	// Once approval is withdrawn, the copy is no longer approved.
	f.exec(`UPDATE campaign_post SET "approvedAt"=NULL WHERE id=$1`, approved)
	body, isError = direct("Ship faster", "withdrawn-")
	refusedWith(t, "createScheduledPost after approval was withdrawn", body, isError, "forbidden")
	f.exec(`UPDATE campaign_post SET "approvedAt"=now() WHERE id=$1`, approved)

	owner := product.Actor{OrganizationID: f.orgs["a"], UserID: "user_" + f.id, SessionID: "session_" + f.id, RequestID: "owner-" + f.id}
	person, err := f.product.CreateScheduledPost(f.ctx, owner, publishing.CreateScheduledPostInput{Caption: "A person wrote this", ChannelConnectionID: connectionID,
		IdempotencyKey: "person-" + f.id, ScheduledFor: time.Now().Add(24 * time.Hour), VariantID: variantID})
	if err != nil || !person.Created {
		t.Fatalf("person's caption: %+v %v", person, err)
	}

	setID := cuid.New()
	f.exec(`INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","ownerUserId","createdAt","updatedAt") VALUES ($1,$2,'Mine','PRIVATE',$1,$3,now(),now())`, setID, f.orgs["a"], owner.UserID)
	f.exec(`UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, setID, connectionID)
	body, isError = direct("Ship faster", "private-")
	refusedWith(t, "createScheduledPost to a private set", body, isError, "not_found")
	body, isError = f.call(session, "scheduleCampaignPost", map[string]any{"campaignId": campaignID, "postId": approved,
		"channelConnectionId": connectionID, "creativeVariantId": variantID, "scheduledAt": at, "skipLinkCheck": true})
	refusedWith(t, "scheduleCampaignPost to a private set", body, isError, "not_found")
}

// createPost needs its own opt-in scope: a key with post:schedule doesn't even
// see it. With the scope it posts to the workspace's accounts, retries replay,
// and another workspace's account is not found.
func TestCreatePostToolTakesItsOwnScope(t *testing.T) {
	f := newFixture(t)
	f.key("a-publish", "a", `{"artifact":["read"],"post":["publish"]}`, true)
	f.key("b-publish", "b", `{"artifact":["read"],"post":["publish"]}`, true)
	listed := func(label string) bool {
		list, err := f.session(label).ListTools(f.ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		return slices.ContainsFunc(list.Tools, func(tool *sdk.Tool) bool { return tool.Name == "createPost" })
	}
	if listed("a-schedule") || listed("a") {
		t.Fatal("createPost is listed without post:publish")
	}
	if !listed("a-publish") {
		t.Fatal("createPost is not listed with post:publish")
	}
	_, _, _, _, connectionID := f.approvedPost()
	setID := cuid.New()
	f.exec(`INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","createdAt","updatedAt") VALUES ($1,$2,'Shared','WORKSPACE',$1,now(),now())`, setID, f.orgs["a"])
	f.exec(`UPDATE channel_connection SET "socialSetId"=$1 WHERE id=$2`, setID, connectionID)
	// The account has a live credential behind it, so it can publish.
	remote := "social-" + f.id
	f.exec(`INSERT INTO "Organization" (id,name,"updatedAt") VALUES ($1,'Fixture',now())`, remote)
	f.exec(`INSERT INTO social_tenant_binding ("organizationId","goOrganizationId","secretReference") VALUES ($1,$2,$3)`, f.orgs["a"], remote, "SOCIAL_FIXTURE_"+f.id)
	f.exec(`INSERT INTO "Integration" (id,"internalId","organizationId",name,"providerIdentifier",type,token) VALUES ($1,$1,$2,'Fixture','linkedin','social','fixture-only-credential')`, "li-"+f.id, remote)
	t.Cleanup(func() {
		_, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "Integration" WHERE "organizationId"=$1`, remote)
		_, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM social_tenant_binding WHERE "organizationId"=$1`, f.orgs["a"])
		_, _ = f.db.SQL.ExecContext(f.ctx, `DELETE FROM "Organization" WHERE id=$1`, remote)
	})
	args := map[string]any{
		"channelConnectionIds": []string{connectionID}, "idempotencyKey": "agent-post-" + f.id,
		"posts": []map[string]any{{"text": "Posted by an agent"}}, "scheduledFor": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339),
	}
	foreign, failed := f.call(f.session("b-publish"), "createPost", args)
	refusedWith(t, "createPost", foreign, failed, "not_found")
	session := f.session("a-publish")
	missing, failed := f.call(session, "createPost", map[string]any{"channelConnectionIds": []string{connectionID}, "posts": []map[string]any{{"text": "No key"}}, "publishNow": true})
	if !failed {
		t.Fatalf("no idempotency key: %v", missing)
	}
	body, failed := f.call(session, "createPost", args)
	if failed {
		t.Fatalf("create: %v", body)
	}
	if body["status"] != "scheduled" || body["created"] != true {
		t.Fatalf("result: %v", body)
	}
	replay, failed := f.call(session, "createPost", args)
	if failed || replay["created"] != false {
		t.Fatalf("replay: %v", replay)
	}
	posts, failed := f.call(session, "listContentDraftPosts", map[string]any{"id": body["draft"].(map[string]any)["id"]})
	if failed || len(posts["posts"].([]any)) != 1 {
		t.Fatalf("posts: %v", posts)
	}
}

func TestDraftToolsShareRESTAuthority(t *testing.T) {
	f := newFixture(t)
	f.key("a-draft", "a", `{"artifact":["read"],"draft":["write"]}`, true)
	session := f.session("a-draft")
	body, failed := f.call(session, "createContentDraft", map[string]any{"title": "Agent draft", "plainText": "Human review required"})
	if failed {
		t.Fatalf("create: %v", body)
	}
	id, ok := body["id"].(string)
	if !ok {
		t.Fatalf("missing draft: %v", body)
	}
	foreign, failed := f.call(f.session("b"), "getContentDraft", map[string]any{"id": id})
	refusedWith(t, "getContentDraft", foreign, failed, "not_found")
	body, failed = f.call(session, "updateContentDraft", map[string]any{"id": id, "baseVersion": 1, "title": "Edited by agent"})
	if failed {
		t.Fatalf("update: %v", body)
	}
	_, failed = f.call(session, "updateContentDraft", map[string]any{"id": id, "baseVersion": 1, "title": "Stale"})
	if !failed {
		t.Fatal("stale version accepted")
	}
	_, _, _, _, connectionID := f.approvedPost()
	f.db.Client.ContentDraft.UpdateOneID(id).SetChannelConnectionIds([]string{connectionID}).SaveX(f.ctx)
	body, failed = f.call(session, "planContentDraft", map[string]any{"id": id, "plannedFor": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339), "timeZone": "UTC"})
	if failed {
		t.Fatalf("plan: %v", body)
	}
	body, failed = f.call(session, "listContentDraftPosts", map[string]any{"id": id})
	if failed || len(ids(body["posts"], "id")) != 0 {
		t.Fatalf("planning published: %v", body)
	}
	list, err := session.ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range list.Tools {
		if tool.Name == "scheduleContentDraft" || tool.Name == "reviewContentDraft" {
			t.Fatal("agent approval/publication exposed")
		}
	}
}

func TestDraftQueueAndSetsKeepPrivateScope(t *testing.T) {
	f := newFixture(t)
	session := f.session("a-read")
	publicID, privateID := cuid.New(), cuid.New()
	ownerID := "private-owner-" + f.id
	f.exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Private owner',$2,true,now(),now())`, ownerID, ownerID+"@example.test")
	t.Cleanup(func() {
		f.exec(`DELETE FROM social_set WHERE id=$1`, privateID)
		f.exec(`DELETE FROM "user" WHERE id=$1`, ownerID)
	})
	f.exec(`INSERT INTO social_set (id,"organizationId",name,visibility,"publicSlug","ownerUserId","createdAt","updatedAt") VALUES ($1,$2,'Public','WORKSPACE',$1,NULL,now(),now()),($3,$2,'Private','PRIVATE',$3,$4,now(),now())`, publicID, f.orgs["a"], privateID, ownerID)
	body, isError := f.call(session, "listSocialSets", map[string]any{})
	if isError {
		t.Fatal(body)
	}
	raw, _ := json.Marshal(body)
	if !strings.Contains(string(raw), publicID) || strings.Contains(string(raw), privateID) {
		t.Fatal("set visibility", string(raw))
	}
	for _, id := range []string{privateID, cuid.New()} {
		body, isError = f.call(session, "getSocialSet", map[string]any{"id": id})
		if !isError {
			t.Fatal("private or foreign set read", body)
		}
		body, isError = f.call(session, "listCalendarPosts", map[string]any{"socialSetId": id, "from": time.Now().UTC().Format(time.RFC3339), "to": time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)})
		if !isError {
			t.Fatal("private queue read", body)
		}
	}
	foreign, denied := f.call(f.session("b"), "getSocialSet", map[string]any{"id": publicID})
	if !denied {
		t.Fatal("foreign set read", foreign)
	}
	body, isError = f.call(session, "getSocialSet", map[string]any{"id": publicID})
	if isError || body["id"] != publicID {
		t.Fatal(body)
	}
	body, isError = f.call(session, "listCalendarPosts", map[string]any{"socialSetId": publicID, "from": time.Now().UTC().Format(time.RFC3339), "to": time.Now().Add(101 * 24 * time.Hour).UTC().Format(time.RFC3339)})
	if !isError {
		t.Fatal("unbounded queue range", body)
	}
}

func TestQueueToolRequiresExplicitScopeAndRejectsIdentityFields(t *testing.T) {
	f := newFixture(t)
	f.key("queue", "a", `{"artifact":["read"],"queue":["write"]}`, true)
	setID := cuid.New()
	f.exec(`INSERT INTO social_set(id,"organizationId",name,visibility,"publicSlug","createdAt","updatedAt") VALUES($1,$2,'Queue','WORKSPACE',$1,now(),now())`, setID, f.orgs["a"])
	session := f.session("queue")
	input := map[string]any{"id": setID, "baseVersion": 1, "postingSlots": []any{map[string]any{"weekday": 1, "time": "09:15"}}, "naturalPostingTimes": true}
	body, failed := f.call(session, "updateSocialSetQueue", input)
	if failed || body["naturalPostingTimes"] != true || body["version"] != float64(2) {
		t.Fatal(body)
	}
	body, failed = f.call(session, "updateSocialSetQueue", input)
	refusedWith(t, "updateSocialSetQueue", body, failed, "conflict")
	input["baseVersion"] = 2
	input["name"] = "Cannot rename"
	if result, err := session.CallTool(f.ctx, &sdk.CallToolParams{Name: "updateSocialSetQueue", Arguments: input}); err == nil && !result.IsError {
		t.Fatal("queue tool accepted identity field")
	}
	listed, err := f.session("a-read").ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name == "updateSocialSetQueue" {
			t.Fatal("read key gained queue writes")
		}
	}
}

func TestDraftCommentToolsRequireSeparateScope(t *testing.T) {
	f := newFixture(t)
	f.key("writer", "a", `{"artifact":["read"],"draft":["write"]}`, true)
	session := f.session("writer")
	draft, failed := f.call(session, "createContentDraft", map[string]any{"title": "Reviewable", "plainText": "Keep publishing human"})
	if failed {
		t.Fatal(draft)
	}
	args := map[string]any{"id": draft["id"], "action": "add", "baseVersion": draft["version"], "commentId": "agent-review", "text": "Please verify the claim."}
	tools, err := session.ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "mutateDraftComment" {
			t.Fatal("comment scope was implicitly granted")
		}
	}
	f.key("commenter", "a", `{"artifact":["read"],"draft":["comment"]}`, true)
	commenter := f.session("commenter")
	body, failed := f.call(commenter, "mutateDraftComment", args)
	if failed {
		t.Fatal(body)
	}
	if body["plainText"] != nil || body["body"] != nil {
		t.Fatal("comment result leaked unrelated fields", body)
	}
	body, failed = f.call(commenter, "listDraftComments", map[string]any{"id": draft["id"], "status": "open"})
	if failed {
		t.Fatal(body)
	}
	discussions := body["discussions"].(map[string]any)
	if len(discussions["threads"].([]any)) != 1 {
		t.Fatal("MCP comment did not persist", body)
	}
	body, failed = f.call(commenter, "mutateDraftComment", args)
	refusedWith(t, "uncertain replay", body, failed, "conflict")
	tools, err = commenter.ListTools(f.ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == "updateContentDraft" || tool.Name == "scheduleContentDraft" || tool.Name == "reviewContentDraft" {
			t.Fatal("commenter acquired content or publishing authority")
		}
	}
}
