package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

type fakeConfiguration struct {
	// Embedded so a test only implements the operations it exercises.
	ConfigurationStore
	authorizationError  error
	readError           error
	createdWorkspace    product.CreateWorkspaceInput
	profile             *ent.BrandProfile
	profileOrganization string
	actor               product.Actor
	brandKit            product.CreateBrandKitInput
	auditQuery          product.AuditLogQuery
	releaseUpdate       product.UpdateReleaseInput
	founderHubError     error
	founderHubActor     *product.Actor
}

func (f *fakeConfiguration) Authorize(_ context.Context, actor product.Actor) error {
	f.actor = actor
	return f.authorizationError
}
func (f *fakeConfiguration) AuthorizeRead(_ context.Context, actor product.Actor) error {
	f.actor = actor
	return f.readError
}
func (f *fakeConfiguration) AuthorizeSession(context.Context, product.Actor) error { return nil }
func (f *fakeConfiguration) GetFounderHubSession(context.Context, product.Actor) (*product.FounderHubSession, error) {
	return nil, nil
}

func (f *fakeConfiguration) AuthorizeFounderHubSession(_ context.Context, actor product.Actor) (*product.FounderHubAuthorization, error) {
	f.founderHubActor = &actor
	return nil, f.founderHubError
}
func (f *fakeConfiguration) GetFounderHubSettingsAccount(context.Context, product.Actor) (*product.FounderHubSettingsAccount, error) {
	return nil, nil
}
func (f *fakeConfiguration) GetFounderHubProfile(context.Context, string) (*product.FounderHubProfile, error) {
	return nil, nil
}
func (f *fakeConfiguration) GetFounderHubKeySession(context.Context, product.Actor) (*product.FounderHubSession, error) {
	return nil, nil
}
func (f *fakeConfiguration) GetFounderHubConnectorSession(context.Context, product.Actor, string) (*product.FounderHubSession, error) {
	return nil, nil
}
func (f *fakeConfiguration) RevokeFounderHubSession(context.Context, product.Actor) error { return nil }
func (f *fakeConfiguration) AuthorizeSensitive(_ context.Context, actor product.Actor) error {
	f.actor = actor
	return f.authorizationError
}
func (f *fakeConfiguration) CreateWorkspace(_ context.Context, _ product.Actor, input product.CreateWorkspaceInput) (*product.Workspace, error) {
	f.createdWorkspace = input
	return &product.Workspace{ID: "workspace-1", Name: input.Name, Slug: input.Slug}, nil
}
func (f *fakeConfiguration) ListWorkspaces(context.Context, product.Actor) ([]product.ListedWorkspace, error) {
	return []product.ListedWorkspace{{ID: "workspace-1", Name: "Workspace", Slug: "workspace", Role: "owner"}}, nil
}
func (f *fakeConfiguration) SetActiveWorkspace(context.Context, product.Actor, string) error {
	return nil
}
func (f *fakeConfiguration) GetWorkspace(context.Context, string) (*product.Workspace, error) {
	return &product.Workspace{ID: "workspace-1", Name: "Workspace", Slug: "workspace"}, nil
}
func (f *fakeConfiguration) UpdateWorkspace(_ context.Context, _ product.Actor, input product.UpdateWorkspaceInput) (*product.Workspace, error) {
	return &product.Workspace{ID: "workspace-1", Name: input.Name, Slug: input.Slug}, nil
}
func (f *fakeConfiguration) ListMembers(context.Context, string) ([]product.WorkspaceMember, error) {
	return []product.WorkspaceMember{}, nil
}
func (f *fakeConfiguration) ListInvitations(context.Context, string) ([]product.WorkspaceInvitation, error) {
	return []product.WorkspaceInvitation{}, nil
}
func (f *fakeConfiguration) UpdateMemberRole(_ context.Context, _ product.Actor, memberID, role string) (*product.WorkspaceMember, error) {
	return &product.WorkspaceMember{ID: memberID, Role: role}, nil
}
func (f *fakeConfiguration) RemoveMember(context.Context, product.Actor, string) (*product.WorkspaceMember, error) {
	return &product.WorkspaceMember{}, nil
}
func (f *fakeConfiguration) LeaveWorkspace(context.Context, product.Actor) (*product.WorkspaceMember, error) {
	return &product.WorkspaceMember{}, nil
}
func (f *fakeConfiguration) TransferOwnership(context.Context, product.Actor, string) error {
	return nil
}
func (f *fakeConfiguration) RequestDeletion(_ context.Context, actor product.Actor, _ string) (*ent.WorkspaceDeletion, error) {
	return &ent.WorkspaceDeletion{ID: "deletion-1", OrganizationID: actor.OrganizationID}, nil
}
func (f *fakeConfiguration) CancelDeletion(context.Context, product.Actor) (*ent.WorkspaceDeletion, error) {
	return &ent.WorkspaceDeletion{ID: "deletion-1", OrganizationID: "org-1"}, nil
}
func (f *fakeConfiguration) InviteMember(_ context.Context, _ product.Actor, email, role string) (*product.InvitationDetail, error) {
	return &product.InvitationDetail{WorkspaceInvitation: product.WorkspaceInvitation{ID: "invitation-1", Email: email, Role: &role}}, nil
}
func (f *fakeConfiguration) ResendInvitation(context.Context, product.Actor, string) (*product.InvitationDetail, error) {
	return &product.InvitationDetail{}, nil
}
func (f *fakeConfiguration) RevokeInvitation(context.Context, product.Actor, string) error {
	return nil
}

func (f *fakeConfiguration) CancelInvitation(context.Context, product.Actor, string) (*product.RecipientInvitation, error) {
	return &product.RecipientInvitation{}, nil
}
func (f *fakeConfiguration) GetRecipientInvitation(context.Context, product.Actor, string) (*product.RecipientInvitation, error) {
	return &product.RecipientInvitation{}, nil
}
func (f *fakeConfiguration) RespondInvitation(context.Context, product.Actor, string, string) (*product.InvitationResponse, error) {
	return &product.InvitationResponse{}, nil
}
func (f *fakeConfiguration) Bootstrap(context.Context, product.Actor) (*product.BootstrapSnapshot, error) {
	return &product.BootstrapSnapshot{}, nil
}
func (f *fakeConfiguration) GetCurrentUser(context.Context, product.Actor) (*product.CurrentUser, error) {
	return &product.CurrentUser{ID: "user-1", Email: "user@example.test", Name: "Test User"}, nil
}
func (f *fakeConfiguration) GetActiveAccess(context.Context, product.Actor) (*product.ActiveAccess, error) {
	return &product.ActiveAccess{OrganizationID: "org-1", Role: "owner"}, nil
}
func (f *fakeConfiguration) VerifySupportGrant(_ context.Context, _ product.Actor, organizationID, _ string) (*product.SupportGrantAccess, error) {
	return &product.SupportGrantAccess{GrantID: "grant-1", OrganizationID: organizationID}, nil
}
func (f *fakeConfiguration) RequireEnterpriseFeature(context.Context, product.Actor, string) error {
	return nil
}
func (f *fakeConfiguration) ListAssets(context.Context, product.Actor, product.AssetListOptions) (*product.AssetPage, error) {
	return &product.AssetPage{Assets: []product.AssetListItem{}}, nil
}
func (f *fakeConfiguration) DeleteAsset(context.Context, product.Actor, string) (product.AssetDeletionResult, error) {
	return product.AssetDeleted, nil
}
func (f *fakeConfiguration) SignAssetUpload(context.Context, product.Actor, product.AssetUploadInput) (*product.AssetUploadResult, error) {
	return &product.AssetUploadResult{Asset: product.AssetRecord{ID: "asset-1", Status: "PENDING"}, UploadURL: "https://media.example.test/upload"}, nil
}
func (f *fakeConfiguration) CompleteAssetUpload(context.Context, product.Actor, string, *string, ...string) (*product.AssetRecord, error) {
	return &product.AssetRecord{ID: "asset-1", Status: "UPLOADED"}, nil
}
func (f *fakeConfiguration) SignAssetDownload(context.Context, product.Actor, string) (string, error) {
	return "https://media.example.test/download", nil
}

func (f *fakeConfiguration) ReadAssetDownload(context.Context, string, string, string) ([]byte, string, error) {
	return []byte("asset bytes"), "image/png", nil
}
func (f *fakeConfiguration) StoreGeneratedAsset(context.Context, product.Actor, product.GeneratedAssetInput) (*product.GeneratedAssetRecord, error) {
	return &product.GeneratedAssetRecord{ID: "asset-2", MediaType: "image/png", ObjectKey: "org/org-1/derived/asset-2/1/render.png"}, nil
}
func (f *fakeConfiguration) ConsumeWorkspaceQuota(context.Context, product.Actor, string, int) (int, error) {
	return 29, nil
}
func (f *fakeConfiguration) ChargeMonthlyQuota(context.Context, string, string, int) (func(), error) {
	return func() {}, nil
}
func (f *fakeConfiguration) ListReleases(context.Context, product.Actor, int) ([]product.ReleaseListItem, error) {
	return []product.ReleaseListItem{}, nil
}
func (f *fakeConfiguration) GetRelease(context.Context, product.Actor, string) (*product.ReleaseDetail, error) {
	return &product.ReleaseDetail{ID: "release-1", Title: "Launch", SourceURLs: []string{}}, nil
}
func (f *fakeConfiguration) CreateRelease(context.Context, product.Actor, product.CreateReleaseInput) (*product.ReleaseCreation, error) {
	return &product.ReleaseCreation{Created: true, Release: product.ReleaseSummary{ID: "release-1", Title: "Launch"}}, nil
}
func (f *fakeConfiguration) UpdateRelease(_ context.Context, _ product.Actor, _ string, input product.UpdateReleaseInput) (*product.ReleaseDetail, error) {
	f.releaseUpdate = input
	return &product.ReleaseDetail{ID: "release-1", Title: "Updated", SourceURLs: []string{}}, nil
}
func (f *fakeConfiguration) ListCampaigns(context.Context, product.Actor) ([]product.CampaignItem, error) {
	return []product.CampaignItem{}, nil
}
func (f *fakeConfiguration) ListPendingApprovals(_ context.Context, actor product.Actor, limit int, cursor string) (*product.ApprovalPage, error) {
	f.actor = actor
	next := cursor + "-next"
	return &product.ApprovalPage{Items: []product.PendingApproval{}, NextCursor: &next}, nil
}
func (f *fakeConfiguration) DescribeAgentClient(_ context.Context, actor product.Actor, request product.AgentAuthorizationRequest) (*product.AgentConsent, error) {
	f.actor = actor
	return &product.AgentConsent{ClientID: request.ClientID, ClientName: "Claude", RedirectURI: request.RedirectURI, RedirectHost: "claude.ai"}, nil
}
func (f *fakeConfiguration) ApproveAgentAccess(_ context.Context, actor product.Actor, request product.AgentAuthorizationRequest) (*product.AgentAuthorizationCode, error) {
	f.actor = actor
	if len(request.Scopes) == 0 {
		return nil, product.ErrInvalidInput
	}
	return &product.AgentAuthorizationCode{Code: "shc_code", RedirectURI: request.RedirectURI}, nil
}
func (f *fakeConfiguration) GetCampaign(context.Context, product.Actor, string) (*product.CampaignDetail, error) {
	return &product.CampaignDetail{CampaignItem: product.CampaignItem{ID: "campaign-1", Name: "Launch"}}, nil
}
func (f *fakeConfiguration) CreateCampaign(context.Context, product.Actor, product.CreateCampaignInput) (*product.CampaignDetail, error) {
	return &product.CampaignDetail{CampaignItem: product.CampaignItem{ID: "campaign-1", Name: "Launch"}}, nil
}
func (f *fakeConfiguration) TransitionCampaign(context.Context, product.Actor, string, string) (*product.CampaignTransition, error) {
	return &product.CampaignTransition{ID: "campaign-1", Status: "READY_FOR_REVIEW"}, nil
}
func (f *fakeConfiguration) TransitionCampaignPosts(context.Context, product.Actor, string, product.CampaignPostDecision) (*product.CampaignPostTransition, error) {
	return &product.CampaignPostTransition{PostIDs: []string{"post-1"}, Status: "APPROVED"}, nil
}
func (f *fakeConfiguration) ScheduleCampaignPost(context.Context, product.Actor, string, string, product.ScheduleCampaignPostInput) (*product.ScheduleCampaignPostResult, error) {
	return &product.ScheduleCampaignPostResult{Post: product.CampaignPostItem{ID: "post-1", Status: "SCHEDULED"},
		ScheduledPost: &ent.ScheduledPost{ID: "scheduled-1", OrganizationID: "org-1", Status: "SCHEDULED"}}, nil
}
func (f *fakeConfiguration) CreateDesign(context.Context, product.Actor, product.CreateDesignInput) (*product.DesignRecord, error) {
	return &product.DesignRecord{ID: "design-1", Name: "Canary"}, nil
}
func (f *fakeConfiguration) GetDesign(context.Context, product.Actor, string) (*product.DesignRecord, error) {
	return &product.DesignRecord{ID: "design-1", Name: "Canary"}, nil
}
func (f *fakeConfiguration) UpdateDesignDocument(context.Context, product.Actor, string, map[string]any) error {
	return nil
}
func (f *fakeConfiguration) SetDesignRender(context.Context, product.Actor, string, string, *string) error {
	return nil
}
func (f *fakeConfiguration) ListCampaignDesigns(context.Context, product.Actor, string) ([]product.DesignRecord, error) {
	return []product.DesignRecord{}, nil
}
func (f *fakeConfiguration) GetEntitlementSummary(context.Context, product.Actor) (*product.EntitlementSummary, error) {
	return &product.EntitlementSummary{Plan: "free", Status: "active", Features: map[string]bool{"asset:read": true}}, nil
}
func (f *fakeConfiguration) GetFeatureDecision(context.Context, product.Actor, string) (*product.FeatureDecision, error) {
	return &product.FeatureDecision{Allowed: true, CurrentPlan: "free", RequiredPlan: "free"}, nil
}
func (f *fakeConfiguration) ListCreativeTemplates(context.Context, product.Actor) ([]product.CreativeTemplateRecord, error) {
	return []product.CreativeTemplateRecord{}, nil
}
func (f *fakeConfiguration) CreateCreativeTemplate(context.Context, product.Actor, product.CreateCreativeTemplateInput) (*product.CreativeTemplateRecord, error) {
	return &product.CreativeTemplateRecord{ID: "template-1", Name: "Canary", Version: 1}, nil
}
func (f *fakeConfiguration) CreateCreativeVariant(context.Context, product.Actor, product.CreateCreativeVariantInput) (*product.CreativeVariantRecord, error) {
	return &product.CreativeVariantRecord{ID: "variant-1", Status: "DRAFT"}, nil
}
func (f *fakeConfiguration) ApproveCampaignDesign(_ context.Context, _ product.Actor, _, designID string) (*product.CreativeApprovalDecision, error) {
	return &product.CreativeApprovalDecision{Variant: product.CreativeVariantRecord{ID: "variant-1", DesignID: &designID, Status: "APPROVED"}}, nil
}
func (f *fakeConfiguration) HeartbeatLaunchRun(context.Context, product.Actor, string) (bool, error) {
	return true, nil
}
func (f *fakeConfiguration) CancelLaunchRun(context.Context, product.Actor, string) (bool, error) {
	return false, publishing.ErrNotFound
}
func (f *fakeConfiguration) DecideCreativeVariant(context.Context, product.Actor, string, product.CreativeApprovalInput) (*product.CreativeApprovalDecision, error) {
	return &product.CreativeApprovalDecision{Variant: product.CreativeVariantRecord{ID: "variant-1", Status: "APPROVED"}}, nil
}
func (f *fakeConfiguration) ListAuditLogs(_ context.Context, actor product.Actor, query product.AuditLogQuery) (*product.AuditLogPage, error) {
	f.actor, f.auditQuery = actor, query
	return &product.AuditLogPage{Items: []product.AuditLogItem{}}, nil
}
func (f *fakeConfiguration) ListBrandKits(context.Context, string) ([]*ent.BrandKit, error) {
	return []*ent.BrandKit{{ID: "kit-1", OrganizationID: "org-1", Name: "Main", Version: 2, Definition: map[string]any{}}}, nil
}
func (f *fakeConfiguration) CreateBrandKit(_ context.Context, actor product.Actor, input product.CreateBrandKitInput) (*ent.BrandKit, error) {
	f.brandKit = input
	return &ent.BrandKit{ID: "kit-2", OrganizationID: actor.OrganizationID, Name: input.Name, Version: 1, Definition: input.Definition}, nil
}
func (f *fakeConfiguration) GetBrandProfile(_ context.Context, organizationID string) (*ent.BrandProfile, error) {
	f.profileOrganization = organizationID
	return f.profile, nil
}
func (f *fakeConfiguration) UpsertBrandProfile(_ context.Context, actor product.Actor, input product.UpsertBrandProfileInput) (*ent.BrandProfile, error) {
	return &ent.BrandProfile{ID: "profile-1", OrganizationID: actor.OrganizationID, Audience: input.Audience, ProductDescription: input.ProductDescription, Tone: input.Tone}, nil
}
func (f *fakeConfiguration) UpdateSourceApp(_ context.Context, actor product.Actor, id string, input product.UpdateSourceAppInput) (*ent.SourceApp, error) {
	if id != "source00001" {
		return nil, publishing.ErrNotFound
	}
	updated := &ent.SourceApp{ID: id, OrganizationID: actor.OrganizationID, IgnoredPullRequestAuthors: []string{}}
	if !input.ClearBranch {
		updated.Branch = input.Branch
	}
	if input.IgnoreBotPullRequests != nil {
		updated.IgnoreBotPullRequests = *input.IgnoreBotPullRequests
	}
	if input.IgnoredPullRequestAuthors != nil {
		updated.IgnoredPullRequestAuthors = *input.IgnoredPullRequestAuthors
	}
	return updated, nil
}

func (f *fakeConfiguration) CreateSourceApp(_ context.Context, actor product.Actor, input product.CreateSourceAppInput) (*ent.SourceApp, error) {
	return &ent.SourceApp{ID: "source-1", OrganizationID: actor.OrganizationID, Name: input.Name, Provider: input.Provider, AllowedHosts: input.AllowedHosts}, nil
}
func (f *fakeConfiguration) ListProductSurfaces(context.Context, string) ([]*ent.ProductSurface, error) {
	return []*ent.ProductSurface{{ID: "surface-1", OrganizationID: "org-1", Name: "Main", URL: "https://example.test", FeatureTags: []string{}, ScreenshotAssetIds: []string{}}}, nil
}
func (f *fakeConfiguration) CreateProductSurface(_ context.Context, actor product.Actor, input product.CreateProductSurfaceInput) (*ent.ProductSurface, error) {
	return &ent.ProductSurface{ID: "surface-1", OrganizationID: actor.OrganizationID, Name: input.Name, URL: input.URL, Environment: input.Environment, FeatureTags: input.FeatureTags, ScreenshotAssetIds: input.ScreenshotAssetIDs}, nil
}
func (f *fakeConfiguration) UpdateProductSurface(_ context.Context, actor product.Actor, id string, input product.UpdateProductSurfaceInput) (*ent.ProductSurface, error) {
	return &ent.ProductSurface{ID: id, OrganizationID: actor.OrganizationID, Name: *input.Name, URL: "https://example.test", FeatureTags: []string{}, ScreenshotAssetIds: []string{}}, nil
}
func (f *fakeConfiguration) DeleteProductSurface(context.Context, product.Actor, string) error {
	return nil
}

func configurationRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	request.Header.Set("X-Request-ID", "request-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestAuditRouteValidatesAndScopesQuery(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	invalid := configurationRequest(handler, http.MethodGet, "/v1/audit-logs?limit=101", "")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid query status=%d", invalid.Code)
	}
	valid := configurationRequest(handler, http.MethodGet, "/v1/audit-logs?limit=2&outcome=FAILED&search=launch", "")
	if valid.Code != http.StatusOK || config.actor.OrganizationID != "org-1" || config.auditQuery.Limit != 2 ||
		config.auditQuery.Outcome != "FAILED" || config.auditQuery.Search != "launch" {
		t.Fatalf("audit query status=%d actor=%+v query=%+v", valid.Code, config.actor, config.auditQuery)
	}
}

func TestReleaseRoutesValidateAndPreserveNullableUpdate(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	if response := configurationRequest(handler, http.MethodGet, "/v1/releases?limit=101", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid release limit status=%d", response.Code)
	}
	created := configurationRequest(handler, http.MethodPost, "/v1/releases", `{"title":"Launch","benefitStatement":"News","idempotencyKey":"key-1"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create release status=%d body=%s", created.Code, created.Body.String())
	}
	updated := configurationRequest(handler, http.MethodPatch, "/v1/releases/c123456789012345678901234", `{"audience":null,"productSurfaceId":null}`)
	if updated.Code != http.StatusOK {
		t.Fatalf("update release status=%d body=%s", updated.Code, updated.Body.String())
	}
	if !config.releaseUpdate.Audience.Set || config.releaseUpdate.Audience.Value != nil ||
		!config.releaseUpdate.ProductSurfaceID.Set || config.releaseUpdate.ProductSurfaceID.Value != nil {
		t.Fatalf("nullable fields lost: %+v", config.releaseUpdate)
	}
	invalid := configurationRequest(handler, http.MethodGet, "/v1/releases/invalid-id", "")
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid release ID status=%d", invalid.Code)
	}
}

func TestCampaignRoutesRejectInvalidIDsAndRequireSession(t *testing.T) {
	scheduler := &fakeScheduler{}
	handler := NewWithConfiguration(&fakeStore{}, scheduler, &fakeVerifier{}, "secret", &fakeConfiguration{})
	if response := configurationRequest(handler, http.MethodGet, "/v1/campaigns/invalid-id", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid campaign ID status=%d", response.Code)
	}
	created := configurationRequest(handler, http.MethodPost, "/v1/campaigns", `{"name":"Launch","objective":"Announce"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create campaign status=%d body=%s", created.Code, created.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/campaigns", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest && response.Code != http.StatusUnauthorized {
		t.Fatalf("campaign read without scope status=%d", response.Code)
	}
	scheduled := configurationRequest(handler, http.MethodPost,
		"/v1/campaigns/c123456789012345678901234/posts/c123456789012345678901234/schedule",
		`{"channelConnectionId":"connection-1"}`)
	if scheduled.Code != http.StatusOK || scheduler.started.PostID != "scheduled-1" {
		t.Fatalf("campaign schedule status=%d workflow=%+v body=%s", scheduled.Code, scheduler.started, scheduled.Body.String())
	}
	if response := configurationRequest(handler, http.MethodPost,
		"/v1/campaigns/c123456789012345678901234/designs/not-a-design/approval", ""); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid design ID status=%d", response.Code)
	}
	approved := configurationRequest(handler, http.MethodPost,
		"/v1/campaigns/c123456789012345678901234/designs/d123456789012345678901234/approval", "")
	if approved.Code != http.StatusOK || !strings.Contains(approved.Body.String(), `"designId":"d123456789012345678901234"`) {
		t.Fatalf("design approval status=%d body=%s", approved.Code, approved.Body.String())
	}
}

func TestLaunchRunLeaseRoutes(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &fakeConfiguration{})
	beat := configurationRequest(handler, http.MethodPost, "/v1/launch/runs/c123456789012345678901234/heartbeat", "")
	if beat.Code != http.StatusOK || !strings.Contains(beat.Body.String(), `"running":true`) {
		t.Fatalf("heartbeat status=%d body=%s", beat.Code, beat.Body.String())
	}
	if cancel := configurationRequest(handler, http.MethodPost, "/v1/launch/runs/c123456789012345678901234/cancel", ""); cancel.Code != http.StatusNotFound {
		t.Fatalf("cancel of an unknown run status=%d", cancel.Code)
	}
	if invalid := configurationRequest(handler, http.MethodPost, "/v1/launch/runs/bad/cancel", ""); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid run ID status=%d", invalid.Code)
	}
}

// Agent run and conversation routes reject malformed input before the store.
func TestAgentAndConversationRoutesValidateInput(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &fakeConfiguration{})
	for _, request := range []struct{ method, path, body string }{
		{http.MethodPost, "/v1/launch/runs", `{"kind":"agent","campaignId":"../x"}`},
		{http.MethodPost, "/v1/launch/runs", `{"kind":"agent","workspaceId":"other"}`},
		{http.MethodPost, "/v1/launch/runs/bad/steps", `{"index":0,"kind":"model","status":"SUCCEEDED"}`},
		{http.MethodGet, "/v1/launch/runs/bad/steps", ""},
		{http.MethodGet, "/v1/conversations?limit=500", ""},
		{http.MethodGet, "/v1/conversations?campaignId=../x", ""},
		{http.MethodPost, "/v1/conversations", `{"campaignId":"../x"}`},
		{http.MethodPatch, "/v1/conversations/c123456789012345678901234", `{"campaignId":"../x"}`},
		{http.MethodPost, "/v1/conversations/c123456789012345678901234/messages", `{"role":"user","kind":"text","content":"x","launchRunId":"../x"}`},
	} {
		if response := configurationRequest(handler, request.method, request.path, request.body); response.Code != http.StatusBadRequest {
			t.Errorf("%s %s status=%d body=%s", request.method, request.path, response.Code, response.Body.String())
		}
	}
}

func TestActiveAccessRequiresSession(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &fakeConfiguration{})
	valid := configurationRequest(handler, http.MethodGet, "/v1/access", "")
	if valid.Code != http.StatusOK || !strings.Contains(valid.Body.String(), `"organizationId":"org-1"`) {
		t.Fatalf("active access status=%d body=%s", valid.Code, valid.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/access", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous active access status=%d", response.Code)
	}
}

func TestConfigurationRechecksBrandPermission(t *testing.T) {
	config := &fakeConfiguration{authorizationError: publishing.ErrForbidden}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodPost, "/v1/brand-kits", `{"name":"Main","definition":{}}`)
	if response.Code != http.StatusForbidden || config.brandKit.Name != "" {
		t.Fatalf("unprivileged write: status=%d input=%#v", response.Code, config.brandKit)
	}
	if config.actor.SessionID != "session-1" || config.actor.OrganizationID != "org-1" {
		t.Fatalf("backend did not receive scoped actor: %#v", config.actor)
	}
}

func TestConfigurationRoutesPreserveProductShape(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	created := configurationRequest(handler, http.MethodPost, "/v1/brand-kits", `{"name":" Main ","definition":{"palette":["blue"]},"publish":true}`)
	if created.Code != http.StatusCreated || config.brandKit.Name != "Main" || !config.brandKit.Publish {
		t.Fatalf("create status=%d body=%s input=%#v", created.Code, created.Body, config.brandKit)
	}
	listed := configurationRequest(handler, http.MethodGet, "/v1/brand-kits", "")
	var value struct {
		BrandKits []struct {
			OrganizationID string `json:"organizationId"`
			Version        int    `json:"version"`
		} `json:"brandKits"`
	}
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &value) != nil || len(value.BrandKits) != 1 || value.BrandKits[0].OrganizationID != "org-1" || value.BrandKits[0].Version != 2 {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body)
	}
	profile := configurationRequest(handler, http.MethodGet, "/v1/brand-profile", "")
	if profile.Code != http.StatusOK || !strings.Contains(profile.Body.String(), `"brandProfile":null`) {
		t.Fatalf("missing profile status=%d body=%s", profile.Code, profile.Body)
	}
	badSource := configurationRequest(handler, http.MethodPost, "/v1/source-apps", `{"name":"Source","provider":"generic","allowedHosts":["file:///etc/passwd"]}`)
	if badSource.Code != http.StatusBadRequest {
		t.Fatalf("unsafe source URL status=%d body=%s", badSource.Code, badSource.Body)
	}
	// The backend requests surface pages when a deployment lands: no private
	// or credentialed address is saved.
	for _, page := range []string{"https://127.0.0.1/dummy", "https://[::1]/dummy", "https://10.1.2.3/dummy",
		"https://169.254.169.254/dummy", "http://localhost:8080/", "https://user:secret@app.example.com/"} {
		if got := configurationRequest(handler, http.MethodPost, "/v1/product-surfaces", `{"name":"Main","url":"`+page+`","environment":"production","featureTags":[],"screenshotAssetIds":[]}`); got.Code != http.StatusBadRequest {
			t.Errorf("surface %s status=%d body=%s", page, got.Code, got.Body)
		}
	}
	if got := configurationRequest(handler, http.MethodPost, "/v1/product-surfaces", `{"name":"Main","url":"https://app.example.com/","environment":"production","featureTags":[],"screenshotAssetIds":[]}`); got.Code != http.StatusCreated {
		t.Fatalf("public surface status=%d body=%s", got.Code, got.Body)
	}
	// Branch length counts characters, as the web schema does: 255 multi-byte runes fit.
	for branch, want := range map[string]int{
		`"main"`: http.StatusCreated, `"` + strings.Repeat("枝", 255) + `"`: http.StatusCreated,
		`"` + strings.Repeat("枝", 256) + `"`: http.StatusBadRequest, `" "`: http.StatusBadRequest,
	} {
		got := configurationRequest(handler, http.MethodPost, "/v1/source-apps", `{"name":"Source","provider":"github","allowedHosts":["https://api.github.com"],"branch":`+branch+`}`)
		if got.Code != want {
			t.Fatalf("branch %.20s status=%d want=%d body=%s", branch, got.Code, want, got.Body)
		}
	}
	tooMany := `"` + strings.Repeat(`a","`, 100) + `a"`
	for field, want := range map[string]int{
		`"branch":"refs/heads/main"`: http.StatusBadRequest, `"branch":"my branch"`: http.StatusBadRequest,
		`"branch":"release/2026.10"`:                                 http.StatusCreated,
		`"ignoredPullRequestAuthors":["dependabot[bot]","Snyk-Bot"]`: http.StatusCreated,
		`"ignoredPullRequestAuthors":["bad login!"]`:                 http.StatusBadRequest,
		`"ignoredPullRequestAuthors":[` + tooMany + `]`:              http.StatusBadRequest,
		`"ignoreBotPullRequests":false,"skipPrereleases":true`:       http.StatusCreated,
	} {
		got := configurationRequest(handler, http.MethodPost, "/v1/source-apps", `{"name":"Source","provider":"github","allowedHosts":["https://api.github.com"],`+field+`}`)
		if got.Code != want {
			t.Fatalf("create %.40s status=%d want=%d body=%s", field, got.Code, want, got.Body)
		}
	}
	for _, c := range []struct {
		path, body string
		want       int
		has        string
	}{
		{"/v1/source-apps/source00001", `{"branch":null}`, http.StatusOK, `"branch":null`},
		{"/v1/source-apps/source00001", `{"branch":"develop"}`, http.StatusOK, `"branch":"develop"`},
		{"/v1/source-apps/source00001", `{"ignoreBotPullRequests":false}`, http.StatusOK, `"ignoreBotPullRequests":false`},
		{"/v1/source-apps/source00001", `{"ignoredPullRequestAuthors":[]}`, http.StatusOK, `"ignoredPullRequestAuthors":[]`},
		{"/v1/source-apps/source00001", `{}`, http.StatusBadRequest, ""},
		{"/v1/source-apps/source00001", `{"branch":"refs/heads/main"}`, http.StatusBadRequest, ""},
		{"/v1/source-apps/source00001", `{"branch":7}`, http.StatusBadRequest, ""},
		{"/v1/source-apps/source00001", `{"ignoredPullRequestAuthors":["no spaces allowed"]}`, http.StatusBadRequest, ""},
		{"/v1/source-apps/source00001", `{"provider":"gitlab"}`, http.StatusBadRequest, ""},
		{"/v1/source-apps/source99999", `{"branch":"main"}`, http.StatusNotFound, ""},
		{"/v1/source-apps/x", `{"branch":"main"}`, http.StatusBadRequest, ""},
	} {
		got := configurationRequest(handler, http.MethodPatch, c.path, c.body)
		if got.Code != c.want || !strings.Contains(got.Body.String(), c.has) {
			t.Fatalf("update %s %s status=%d want=%d body=%s", c.path, c.body, got.Code, c.want, got.Body)
		}
	}
}

func TestWorkspaceRoutesRequireSessionAndRecheckUpdates(t *testing.T) {
	config := &fakeConfiguration{authorizationError: publishing.ErrForbidden}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	created := configurationRequest(handler, http.MethodPost, "/v1/workspaces", `{"name":" New Workspace ","slug":"new-workspace"}`)
	if created.Code != http.StatusCreated || !strings.Contains(created.Body.String(), `"name":"New Workspace"`) {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body)
	}
	listed := configurationRequest(handler, http.MethodGet, "/v1/workspaces", "")
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"workspaces"`) {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body)
	}
	invalid := configurationRequest(handler, http.MethodPost, "/v1/workspaces", `{"name":"New Workspace","slug":"UPPER"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid slug status=%d", invalid.Code)
	}
	// Where the creator heard about Shots reaches the domain as sent; its fields stay closed.
	answered := configurationRequest(handler, http.MethodPost, "/v1/workspaces", `{"name":"New Workspace","slug":"new-workspace","heardAbout":{"source":"other","detail":"A talk"}}`)
	if answered.Code != http.StatusCreated || config.createdWorkspace.HeardAbout == nil ||
		*config.createdWorkspace.HeardAbout != (product.SignupSourceInput{Source: "other", Detail: "A talk"}) {
		t.Fatalf("answered create status=%d input=%+v", answered.Code, config.createdWorkspace.HeardAbout)
	}
	unknown := configurationRequest(handler, http.MethodPost, "/v1/workspaces", `{"name":"New Workspace","slug":"new-workspace","heardAbout":{"source":"x","campaign":"spring"}}`)
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown answer field status=%d", unknown.Code)
	}
	denied := configurationRequest(handler, http.MethodPatch, "/v1/workspace", `{"name":"Workspace","slug":"workspace"}`)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("update status=%d body=%s", denied.Code, denied.Body)
	}
	transfer := configurationRequest(handler, http.MethodPost, "/v1/workspace/transfer-ownership", `{"memberId":"member-2"}`)
	if transfer.Code != http.StatusForbidden || config.actor.UserID != "user-1" || config.actor.SessionID != "session-1" {
		t.Fatalf("sensitive transfer status=%d actor=%#v", transfer.Code, config.actor)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/workspaces", nil)
	request.Header.Set("X-User-ID", "user-1")
	request.Header.Set("X-Session-ID", "session-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing service token status=%d", response.Code)
	}
}

type choosingConfiguration struct{ fakeConfiguration }

func (choosingConfiguration) CompleteGitHubInstall(context.Context, product.Actor, string, string, int64) (*product.GitHubInstallationLink, error) {
	return nil, &product.GitHubChoiceRequiredError{Choices: []githubapp.Installation{{ID: 7, AccountLogin: "acme", AccountType: "Organization"}}}
}

func TestGitHubCompletionAsksForAChoice(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &choosingConfiguration{})
	response := configurationRequest(handler, http.MethodPost, "/v1/github/connections/complete", `{"code":"c","installationId":0,"state":"s"}`)
	var body struct {
		Choices []githubapp.Installation `json:"choices"`
		Code    string                   `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusConflict ||
		body.Code != "github_installation_choice_required" || len(body.Choices) != 1 || body.Choices[0].AccountLogin != "acme" {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

type brandRulesConfiguration struct {
	fakeConfiguration
	profile product.UpsertBrandProfileInput
}

func (c *brandRulesConfiguration) UpsertBrandProfile(_ context.Context, actor product.Actor, input product.UpsertBrandProfileInput) (*ent.BrandProfile, error) {
	c.profile = input
	return &ent.BrandProfile{ID: "profile-1", OrganizationID: actor.OrganizationID, ProhibitedTerms: input.ProhibitedTerms}, nil
}

func (c *brandRulesConfiguration) CreateCampaign(context.Context, product.Actor, product.CreateCampaignInput) (*product.CampaignDetail, error) {
	return nil, &product.ProhibitedTermsError{Matches: []product.TermMatch{{Term: "Acme", Reason: "Competitor", MatchMode: "word"}}}
}

func TestBrandProfileTakesLegacyTermsAndBlockedCopyIsAConflict(t *testing.T) {
	config := &brandRulesConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	saved := configurationRequest(handler, http.MethodPost, "/v1/brand-profile",
		`{"audience":"Devs","productDescription":"Studio","tone":"Clear","prohibitedTerms":["Acme",{"term":"cheap","reason":"Off brand","matchMode":"phrase"}]}`)
	if saved.Code != http.StatusOK || len(config.profile.ProhibitedTerms) != 2 || config.profile.ProhibitedTerms[0].Term != "Acme" ||
		config.profile.ProhibitedTerms[1].MatchMode != "phrase" || !strings.Contains(saved.Body.String(), `"reason":"Off brand"`) {
		t.Fatalf("profile status=%d body=%s input=%+v", saved.Code, saved.Body, config.profile)
	}
	blocked := configurationRequest(handler, http.MethodPost, "/v1/campaigns", `{"name":"Launch","objective":"Adoption"}`)
	var body struct {
		Code    string              `json:"code"`
		Matches []product.TermMatch `json:"matches"`
	}
	if blocked.Code != http.StatusConflict || json.Unmarshal(blocked.Body.Bytes(), &body) != nil || body.Code != "brand_prohibited_terms" ||
		len(body.Matches) != 1 || body.Matches[0].Reason != "Competitor" {
		t.Fatalf("blocked status=%d body=%s", blocked.Code, blocked.Body)
	}
}

type submittingConfiguration struct {
	fakeConfiguration
	decision product.CampaignPostDecision
}

func (c *submittingConfiguration) TransitionCampaignPosts(_ context.Context, actor product.Actor, _ string, input product.CampaignPostDecision) (*product.CampaignPostTransition, error) {
	c.actor, c.decision = actor, input
	return &product.CampaignPostTransition{PostIDs: input.PostIDs, Status: "READY_FOR_REVIEW"}, nil
}

func (c *submittingConfiguration) UpdateCampaignPost(_ context.Context, _ product.Actor, _, postID string, input product.UpdateCampaignPostInput) (*product.CampaignPostItem, error) {
	return &product.CampaignPostItem{ID: postID, Copy: *input.Copy, Status: "DRAFT"}, nil
}

func TestUpdateCampaignPostRoute(t *testing.T) {
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", &submittingConfiguration{})
	path := "/v1/campaigns/c123456789012345678901234/posts/p123456789012345678901234"
	if edited := configurationRequest(handler, http.MethodPatch, path, `{"expectedCopy":"a","copy":"b"}`); edited.Code != http.StatusOK ||
		!strings.Contains(edited.Body.String(), `"copy":"b"`) {
		t.Fatalf("edit status=%d body=%s", edited.Code, edited.Body)
	}
	if bad := configurationRequest(handler, http.MethodPatch, path, `{"expectedCopy":"a","status":"APPROVED"}`); bad.Code != http.StatusBadRequest {
		t.Fatalf("status smuggled into an edit: %d", bad.Code)
	}
}

func TestSubmitRouteOnlySubmits(t *testing.T) {
	config := &submittingConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodPost, "/v1/campaigns/c123456789012345678901234/posts/submit", `{"postIds":["p1"]}`)
	if response.Code != http.StatusOK || config.decision.Decision != "submit" || len(config.decision.PostIDs) != 1 {
		t.Fatalf("submit status=%d body=%s decision=%+v", response.Code, response.Body, config.decision)
	}
	if smuggled := configurationRequest(handler, http.MethodPost, "/v1/campaigns/c123456789012345678901234/posts/submit", `{"decision":"approve"}`); smuggled.Code != http.StatusBadRequest {
		t.Fatalf("decision in a submit body status=%d", smuggled.Code)
	}
}

type surfaceLookupConfiguration struct {
	fakeConfiguration
	lookup product.FindSurfacesInput
}

func (c *surfaceLookupConfiguration) FindSurfacesForFeature(_ context.Context, _ product.Actor, input product.FindSurfacesInput) ([]product.SurfaceMatch, error) {
	c.lookup = input
	asset := "asset-1"
	return []product.SurfaceMatch{{CurrentCaptureAssetID: &asset, Reason: product.SurfaceMatchTag, Score: 100,
		Surface: &ent.ProductSurface{ID: "surface-1", Slug: "approvals", FeatureTags: []string{}, ScreenshotAssetIds: []string{}}}}, nil
}

func TestSurfaceLookupReadsFeatureTagsAndLimit(t *testing.T) {
	config := &surfaceLookupConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodGet, "/v1/product-surfaces/match?feature=approvals&tag=a&tag=b&limit=3", "")
	if response.Code != http.StatusOK || config.lookup.Feature != "approvals" || len(config.lookup.Tags) != 2 || config.lookup.Limit != 3 ||
		!strings.Contains(response.Body.String(), `"currentCaptureAssetId":"asset-1"`) || !strings.Contains(response.Body.String(), `"slug":"approvals"`) {
		t.Fatalf("lookup status=%d body=%s input=%+v", response.Code, response.Body, config.lookup)
	}
	if bad := configurationRequest(handler, http.MethodGet, "/v1/product-surfaces/match?feature=x&limit=many", ""); bad.Code != http.StatusBadRequest {
		t.Fatalf("bad limit status=%d", bad.Code)
	}
}

func TestApprovalQueueRouteValidatesItsQuery(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	page := configurationRequest(handler, http.MethodGet, "/v1/approvals?limit=10&cursor=c123456789012345678901234", "")
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `"nextCursor":"c123456789012345678901234-next"`) ||
		config.actor.OrganizationID != "org-1" {
		t.Fatalf("queue status=%d body=%s actor=%+v", page.Code, page.Body.String(), config.actor)
	}
	for _, query := range []string{"?limit=ten", "?cursor=../../etc"} {
		if response := configurationRequest(handler, http.MethodGet, "/v1/approvals"+query, ""); response.Code != http.StatusBadRequest {
			t.Fatalf("%s status=%d", query, response.Code)
		}
	}
}

func TestAgentAuthorizationRoutes(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	request := `{"clientId":"pcd_claude","redirectUri":"https://claude.ai/cb","scopes":["artifact:read"]}`
	preview := configurationRequest(handler, http.MethodPost, "/v1/agent-authorizations/preview", request)
	if preview.Code != http.StatusOK || !strings.Contains(preview.Body.String(), `"redirectHost":"claude.ai"`) || config.actor.SessionID != "session-1" {
		t.Fatalf("preview status=%d body=%s", preview.Code, preview.Body.String())
	}
	approved := configurationRequest(handler, http.MethodPost, "/v1/agent-authorizations", request)
	if approved.Code != http.StatusCreated || !strings.Contains(approved.Body.String(), `"code":"shc_code"`) {
		t.Fatalf("approve status=%d body=%s", approved.Code, approved.Body.String())
	}
	if refused := configurationRequest(handler, http.MethodPost, "/v1/agent-authorizations", `{"clientId":"x","scopes":[]}`); refused.Code != http.StatusBadRequest {
		t.Fatalf("no scopes status=%d", refused.Code)
	}
	if unknown := configurationRequest(handler, http.MethodPost, "/v1/agent-authorizations", `{"clientId":"x","admin":true}`); unknown.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status=%d", unknown.Code)
	}
}

func TestWritingDefaultsAreScopedAndExcludeProfileDetails(t *testing.T) {
	config := &fakeConfiguration{authorizationError: publishing.ErrForbidden, profile: &ent.BrandProfile{Tone: "Direct", Audience: "Creators", ProductDescription: "Private product facts"}}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	response := configurationRequest(handler, http.MethodGet, "/v1/brand-profile?view=writing-defaults&organizationId=org-2", "")
	if response.Code != http.StatusOK || config.profileOrganization != "org-1" || !strings.Contains(response.Body.String(), `"tone":"Direct"`) || strings.Contains(response.Body.String(), "Private product facts") {
		t.Fatalf("defaults leaked or wrong tenant: %d %s org=%s", response.Code, response.Body, config.profileOrganization)
	}
	var fields map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 3 {
		t.Fatalf("unexpected defaults: %s", response.Body)
	}
	full := configurationRequest(handler, http.MethodGet, "/v1/brand-profile", "")
	if full.Code != http.StatusForbidden {
		t.Fatalf("full profile readable: %d", full.Code)
	}
	config.profileOrganization = ""
	config.readError = publishing.ErrForbidden
	denied := configurationRequest(handler, http.MethodGet, "/v1/brand-profile?view=writing-defaults", "")
	if denied.Code != http.StatusForbidden || config.profileOrganization != "" {
		t.Fatal("read continued after membership rejection")
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/brand-profile?view=writing-defaults", nil)
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, request)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unsigned request allowed: %d", unauthenticated.Code)
	}
}

func TestWritingDefaultsRejectMachineCredentials(t *testing.T) {
	config := &fakeConfiguration{}
	handler := NewWithConfiguration(&fakeStore{}, &fakeScheduler{}, &fakeVerifier{}, "secret", config)
	request := httptest.NewRequest(http.MethodGet, "/v1/brand-profile?view=writing-defaults", nil)
	request.Header.Set("Authorization", "Bearer secret")
	request.Header.Set("X-Organization-ID", "org-1")
	request.Header.Set("X-Principal-Kind", "api_key")
	request.Header.Set("X-API-Key-ID", "key-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || config.profileOrganization != "" {
		t.Fatalf("machine read allowed: %d %s", response.Code, response.Body)
	}
}

func (f *fakeConfiguration) ApproveCampaignAsset(ctx context.Context, actor product.Actor, campaignID, assetID string) (*product.CreativeApprovalDecision, error) {
	return f.ApproveCampaignDesign(ctx, actor, campaignID, assetID)
}

func (f *fakeConfiguration) ListFounderHubTemplates(context.Context, product.Actor, string, bool, string) (*product.FounderHubTemplatePage, error) {
	return &product.FounderHubTemplatePage{Items: []product.FounderHubTemplate{}}, nil
}
func (f *fakeConfiguration) FounderHubResourceAction(context.Context, product.Actor, product.FounderHubResourceAction) (json.RawMessage, error) {
	return json.RawMessage("[]"), nil
}
func (f *fakeConfiguration) FounderHubShareWorkspaces(context.Context, product.Actor) ([]product.FounderHubShareWorkspace, error) {
	return []product.FounderHubShareWorkspace{}, nil
}
func (f *fakeConfiguration) UpdateFounderHubTemplate(context.Context, product.Actor, string, product.FounderHubTemplateUpdate) (*product.FounderHubTemplate, error) {
	return &product.FounderHubTemplate{}, nil
}
func (f *fakeConfiguration) ListFounderHubSettings(context.Context, product.Actor) ([]product.FounderHubSettings, error) {
	return nil, nil
}
func (f *fakeConfiguration) UpdateFounderHubSettings(context.Context, product.Actor, product.FounderHubSettingsUpdate) (*product.FounderHubSettings, error) {
	return nil, nil
}
