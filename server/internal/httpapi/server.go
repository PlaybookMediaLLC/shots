package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/authstore"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/whitelabel"
)

type Store interface {
	Ping(context.Context) error
	AuthorizePublishing(context.Context, string, string, string) error
	AuthorizeConnections(context.Context, string, string, string) error
	AuthorizeAPIKeyScope(context.Context, string, string, string) error
	Binding(context.Context, string) (*ent.SocialTenantBinding, error)
	StartOAuth(context.Context, publishing.Actor, string, string, string, string, publishing.OAuthStartOptions) error
	PrepareOAuth(context.Context, publishing.Actor, string, string, publishing.OAuthStartOptions) (string, error)
	AuthorizeSession(context.Context, string, string) (*ent.Session, error)
	ResolveOAuthContext(context.Context, string, string, string, string) (*publishing.OAuthContext, error)
	ClaimOAuthExchange(context.Context, publishing.Actor, string, string, string) (*schema.SocialOAuthExchange, error)
	SaveOAuthExchange(context.Context, publishing.Actor, string, string, string, schema.SocialOAuthExchange) error
	OAuthStart(context.Context, publishing.Actor, string, string, string, *string) (*ent.SocialOAuthStart, error)
	RememberInstagramIntegration(context.Context, publishing.Actor, string, string, string, ...string) error
	FinishOAuth(context.Context, publishing.Actor, string, string, string, string) (*ent.ChannelConnection, error)
	CreateConnection(context.Context, publishing.Actor, publishing.CreateConnectionInput) (*ent.ChannelConnection, error)
	ListConnections(context.Context, string) ([]*ent.ChannelConnection, error)
	SetConnectionProfile(ctx context.Context, id, name, handle, avatar string) (*ent.ChannelConnection, error)
	CreateScheduledPost(context.Context, publishing.Actor, publishing.CreateScheduledPostInput) (publishing.CreateScheduledPostResult, error)
	ListScheduledPosts(context.Context, string, bool, int) ([]*ent.ScheduledPost, error)
	CancelScheduledPost(context.Context, publishing.Actor, string) (*ent.ScheduledPost, error)
}

type DestinationVerifier interface {
	VerifyDestination(context.Context, socialapi.VerifyDestinationInput) error
	BeginOAuth(context.Context, socialapi.BeginOAuthInput) (string, error)
}

type WorkflowScheduler interface {
	Cancel(context.Context, string) error
	Ping(context.Context) error
	Start(context.Context, temporalpublishing.ScheduleInput) error
}

type ConfigurationStore interface {
	PlanAnalyzeStore
	ProjectStore
	CreativeSetStore
	ContentDraftStore
	ContentDraftPlatformStore
	ContentBatchStore
	SettingsPlatformStore
	WebhookStore
	LibraryStore
	SharingStore
	GetCampaignAsset(context.Context, product.Actor, string, string) (*product.CampaignAssetLink, error)
	LinkCampaignAsset(context.Context, product.Actor, string, string, product.LinkCampaignAssetInput) (*product.CampaignAssetLink, error)
	CreateCampaignPublishDraft(context.Context, product.Actor, string, product.CampaignPublishDraftInput) (*product.ContentDraftRecord, error)
	SaveCampaignCopy(context.Context, product.Actor, string, product.SaveCampaignCopyInput) error
	ReplaceDesign(context.Context, product.Actor, string, product.ReplaceDesignInput) error
	GetLaunchCampaign(context.Context, product.Actor, string) (*product.LaunchCampaign, error)
	GetLaunchBrand(context.Context, product.Actor) (*ent.BrandKit, *ent.BrandProfile, error)
	ListLaunchSpecs(context.Context, product.Actor, string) ([]product.LaunchSpec, error)
	GetLaunchSpec(context.Context, product.Actor, string) (*product.LaunchSpec, error)
	SaveLaunchSpec(context.Context, product.Actor, string, product.SaveLaunchSpecInput) (*product.LaunchSpec, error)
	ApproveLaunchSpec(context.Context, product.Actor, string) (*product.LaunchSpec, error)
	ListLaunchPlans(context.Context, product.Actor, string) ([]product.LaunchPlan, error)
	GetLaunchPlan(context.Context, product.Actor, string, string) (*product.LaunchPlan, error)
	SaveLaunchPlan(context.Context, product.Actor, string, product.SaveLaunchPlanInput) (*product.LaunchPlan, error)
	ApproveLaunchPlan(context.Context, product.Actor, string) (*product.LaunchPlan, error)
	SaveLaunchPosts(context.Context, product.Actor, string, product.SaveLaunchPostsInput) (*product.LaunchPostsResult, error)
	CreateLaunchRevision(context.Context, product.Actor, string, product.CreateLaunchRevisionInput) (*product.LaunchRevision, error)
	ListLaunchRevisions(context.Context, product.Actor, string) ([]product.LaunchRevision, error)
	GetLaunchRevision(context.Context, product.Actor, string) (*product.LaunchRevision, error)
	ApplyLaunchRevision(context.Context, product.Actor, string, product.ApplyLaunchRevisionInput) (*product.LaunchRevisionApplied, error)
	DiscardLaunchRevision(context.Context, product.Actor, string) (*product.LaunchRevision, error)
	SetLaunchDesignCritique(context.Context, product.Actor, string, map[string]any) error
	GetLaunchPreferences(context.Context, product.Actor) (*product.LaunchPreferenceExamples, error)
	StartLaunchRun(context.Context, product.Actor, string, string) (*product.LaunchRunRecord, error)
	FinishLaunchRun(context.Context, product.Actor, string, product.FinishLaunchRunInput) error
	HeartbeatLaunchRun(context.Context, product.Actor, string) (bool, error)
	CancelLaunchRun(context.Context, product.Actor, string) (bool, error)
	GetLaunchRun(context.Context, product.Actor, string) (*product.LaunchRunRecord, error)
	ListLaunchRuns(context.Context, product.Actor, string) ([]product.LaunchRunRecord, error)
	StartAgentRun(context.Context, product.Actor, product.StartAgentRunInput) (*product.LaunchRunRecord, error)
	AppendLaunchRunStep(context.Context, product.Actor, string, product.LaunchRunStepInput) (*product.LaunchRunStepRecord, error)
	ListLaunchRunSteps(context.Context, product.Actor, string) ([]product.LaunchRunStepRecord, error)
	CreateConversation(context.Context, product.Actor, product.CreateConversationInput) (*product.ConversationRecord, error)
	ListConversations(context.Context, product.Actor, product.ListConversationsInput) ([]product.ConversationRecord, error)
	GetConversation(context.Context, product.Actor, string) (*product.ConversationDetail, error)
	AppendConversationMessage(context.Context, product.Actor, string, product.AppendConversationMessageInput) (*product.ConversationMessageRecord, error)
	UpdateConversation(context.Context, product.Actor, string, product.UpdateConversationInput) (*product.ConversationRecord, error)
	ListAuditDrains(context.Context, product.Actor) ([]product.AuditDrainRecord, error)
	CreateAuditDrain(context.Context, product.Actor, product.CreateAuditDrainInput, product.AuditRequest) (*product.AuditDrainRecord, error)
	DeleteAuditDrain(context.Context, product.Actor, string, product.AuditRequest) error
	GetAuditRetention(context.Context, product.Actor) (*product.AuditRetention, error)
	UpdateAuditRetention(context.Context, product.Actor, product.AuditRetention, product.AuditRequest) (*product.AuditRetention, error)
	ListPermissionGroups(context.Context, product.Actor) ([]product.PermissionGroupRecord, error)
	CreatePermissionGroup(context.Context, product.Actor, product.PermissionGroupInput, product.AuditRequest) (*product.PermissionGroupRecord, error)
	UpdatePermissionGroup(context.Context, product.Actor, string, product.PermissionGroupInput, product.AuditRequest) (*product.PermissionGroupRecord, error)
	DeletePermissionGroup(context.Context, product.Actor, string, product.AuditRequest) error
	SetPermissionGroupMembers(context.Context, product.Actor, string, []string, product.AuditRequest) (*product.PermissionGroupRecord, error)
	GetWhitelabel(context.Context, product.Actor) (*whitelabel.Settings, error)
	UpdateWhitelabel(context.Context, product.Actor, whitelabel.Settings, product.AuditRequest) (*whitelabel.Settings, error)
	GetWebhookSource(context.Context, string) (*product.WebhookSource, error)
	IngestSourceRelease(context.Context, product.Actor, product.IngestSourceReleaseInput) (*product.SourceReleaseIngest, error)
	CollectSourceChange(context.Context, product.Actor, product.CollectSourceChangeInput) (*product.SourceChangeCollect, error)
	IngestDeployment(context.Context, product.Actor, product.IngestDeploymentInput) (*product.DeploymentIngest, error)
	StartGitHubInstall(context.Context, product.Actor) (string, error)
	CompleteGitHubInstall(context.Context, product.Actor, string, string, int64) (*product.GitHubInstallationLink, error)
	ListGitHubInstallations(context.Context, string) ([]product.GitHubInstallationLink, error)
	UnlinkGitHubInstallation(context.Context, product.Actor, string) error
	GitHubRepositories(context.Context, product.Actor, string) ([]githubapp.Repository, error)
	GitHubSources(context.Context, int64, string) ([]*product.WebhookSource, error)
	RecordGitHubInstallation(context.Context, githubapp.Installation) error
	SetGitHubInstallationStatus(context.Context, int64, product.GitHubInstallationStatus) (int, error)
	RemoveGitHubRepositories(context.Context, int64, []string) (int, error)
	ReplayOutboxEvent(context.Context, string) error
	SyncWorkspaceEntitlement(context.Context, product.EntitlementSyncInput) (*product.EntitlementSyncResult, error)
	GrantWorkspaceCredits(context.Context, product.CreditGrantInput) (*product.CreditGrantResult, error)
	GetWorkspaceEntitlement(context.Context, product.Actor) (*product.WorkspaceEntitlementRecord, error)
	ListAnnouncements(context.Context, product.Actor, int) ([]product.AnnouncementListItem, error)
	GetAudienceReach(context.Context, product.Actor) (int, error)
	ScheduleAnnouncement(context.Context, product.Actor, product.ScheduleAnnouncementInput) (*product.AnnouncementSchedule, error)
	CancelAnnouncement(context.Context, product.Actor, string) (bool, error)
	ListAudienceSubscribers(context.Context, product.Actor, bool, int) ([]product.AudienceSubscriberRecord, error)
	AddAudienceSubscribers(context.Context, product.Actor, []product.AudienceSubscriberInput) (*product.AudienceAddition, error)
	UnsubscribeAudienceMember(context.Context, product.Actor, string) error
	GetScreenshotCache(context.Context, string) (*product.ScreenshotCacheEntry, error)
	GetScreenshotCacheObject(context.Context, string) ([]byte, error)
	PutScreenshotCacheObject(context.Context, string, []byte) error
	PutScreenshotCache(context.Context, string, product.ScreenshotCacheInput) (*product.ScreenshotCacheEntry, error)
	DeleteScreenshotCache(context.Context, string) error
	ListScreenshotCache(context.Context, product.ScreenshotCacheFilter) ([]product.ScreenshotCacheEntry, error)
	PurgeScreenshotCache(context.Context, product.ScreenshotCacheFilter) (int, error)
	FindAssets(context.Context, product.Actor, []string, string) ([]product.RenderAsset, error)
	FindDesignRender(context.Context, product.Actor, string) (*product.RenderAsset, error)
	ExecuteAuthStore(context.Context, authstore.Request) (*authstore.Result, error)
	RecordAuthEvent(context.Context, product.AuthEvent) error
	AppendAuditEvent(context.Context, product.Actor, product.AuditEventInput) error
	WorkspaceOperational(context.Context, string) (bool, error)
	RequireSeat(context.Context, string, bool) error
	RequireChannel(context.Context, string, string) error
	Authorize(context.Context, product.Actor) error
	AuthorizeRead(context.Context, product.Actor) error
	AuthorizeSession(context.Context, product.Actor) error
	AuthorizeSensitive(context.Context, product.Actor) error
	ListBrandKits(context.Context, string) ([]*ent.BrandKit, error)
	CreateBrandKit(context.Context, product.Actor, product.CreateBrandKitInput) (*ent.BrandKit, error)
	GetBrandProfile(context.Context, string) (*ent.BrandProfile, error)
	UpsertBrandProfile(context.Context, product.Actor, product.UpsertBrandProfileInput) (*ent.BrandProfile, error)
	GetProductProfile(context.Context, product.Actor) (*product.ProductProfileRecord, error)
	UpsertProductProfile(context.Context, product.Actor, product.UpsertProductProfileInput) (*product.ProductProfileRecord, error)
	GetIdealCustomerProfile(context.Context, product.Actor) (*product.IdealCustomerProfileRecord, error)
	UpsertIdealCustomerProfile(context.Context, product.Actor, product.UpsertIdealCustomerProfileInput) (*product.IdealCustomerProfileRecord, error)
	GetOnboardingRun(context.Context, product.Actor, string) (*product.OnboardingRunRecord, error)
	LatestOnboardingRun(context.Context, product.Actor) (*product.OnboardingRunRecord, error)
	ListOnboardingEnrichment(context.Context, product.Actor, string) ([]product.EnrichmentRecordRecord, error)
	CreateSourceApp(context.Context, product.Actor, product.CreateSourceAppInput) (*ent.SourceApp, error)
	UpdateSourceApp(context.Context, product.Actor, string, product.UpdateSourceAppInput) (*ent.SourceApp, error)
	ListProductSurfaces(context.Context, string) ([]*ent.ProductSurface, error)
	CreateProductSurface(context.Context, product.Actor, product.CreateProductSurfaceInput) (*ent.ProductSurface, error)
	UpdateProductSurface(context.Context, product.Actor, string, product.UpdateProductSurfaceInput) (*ent.ProductSurface, error)
	DeleteProductSurface(context.Context, product.Actor, string) error
	FindSurfacesForFeature(context.Context, product.Actor, product.FindSurfacesInput) ([]product.SurfaceMatch, error)
	ListSurfaceCaptures(context.Context, product.Actor, string) ([]product.SurfaceCaptureRecord, error)
	RecordSurfaceCapture(context.Context, product.Actor, string, product.RecordSurfaceCaptureInput) (*product.SurfaceCaptureRecord, error)
	CreateWorkspace(context.Context, product.Actor, product.CreateWorkspaceInput) (*product.Workspace, error)
	ListWorkspaces(context.Context, product.Actor) ([]product.ListedWorkspace, error)
	SetActiveWorkspace(context.Context, product.Actor, string) error
	GetWorkspace(context.Context, string) (*product.Workspace, error)
	UpdateWorkspace(context.Context, product.Actor, product.UpdateWorkspaceInput) (*product.Workspace, error)
	ListMembers(context.Context, string) ([]product.WorkspaceMember, error)
	ListInvitations(context.Context, string) ([]product.WorkspaceInvitation, error)
	UpdateMemberRole(context.Context, product.Actor, string, string) (*product.WorkspaceMember, error)
	RemoveMember(context.Context, product.Actor, string) (*product.WorkspaceMember, error)
	LeaveWorkspace(context.Context, product.Actor) (*product.WorkspaceMember, error)
	TransferOwnership(context.Context, product.Actor, string) error
	RequestDeletion(context.Context, product.Actor, string) (*ent.WorkspaceDeletion, error)
	CancelDeletion(context.Context, product.Actor) (*ent.WorkspaceDeletion, error)
	InviteMember(context.Context, product.Actor, string, string) (*product.InvitationDetail, error)
	ResendInvitation(context.Context, product.Actor, string) (*product.InvitationDetail, error)
	RevokeInvitation(context.Context, product.Actor, string) error
	CancelInvitation(context.Context, product.Actor, string) (*product.RecipientInvitation, error)
	GetRecipientInvitation(context.Context, product.Actor, string) (*product.RecipientInvitation, error)
	RespondInvitation(context.Context, product.Actor, string, string) (*product.InvitationResponse, error)
	Bootstrap(context.Context, product.Actor) (*product.BootstrapSnapshot, error)
	PageAccess(context.Context, product.Actor) (*product.PageAccessSnapshot, error)
	GetCurrentUser(context.Context, product.Actor) (*product.CurrentUser, error)
	GetActiveAccess(context.Context, product.Actor) (*product.ActiveAccess, error)
	VerifySupportGrant(context.Context, product.Actor, string, string) (*product.SupportGrantAccess, error)
	RequireEnterpriseFeature(context.Context, product.Actor, string) error
	ListAssets(context.Context, product.Actor, product.AssetListOptions) (*product.AssetPage, error)
	DeleteAsset(context.Context, product.Actor, string) (product.AssetDeletionResult, error)
	SignAssetUpload(context.Context, product.Actor, product.AssetUploadInput) (*product.AssetUploadResult, error)
	CompleteAssetUpload(context.Context, product.Actor, string, *string, ...string) (*product.AssetRecord, error)
	SignAssetUploadParts(context.Context, product.Actor, string, []int) (*product.AssetUploadParts, error)
	SignAssetDownload(context.Context, product.Actor, string) (string, error)
	ReadAsset(context.Context, product.Actor, string) ([]byte, string, error)
	ReadAssetDownload(context.Context, string, string, string) ([]byte, string, error)
	StoreGeneratedAsset(context.Context, product.Actor, product.GeneratedAssetInput) (*product.GeneratedAssetRecord, error)
	ConsumeWorkspaceQuota(context.Context, product.Actor, string, int) (int, error)
	CreateScheduledPost(context.Context, product.Actor, publishing.CreateScheduledPostInput) (publishing.CreateScheduledPostResult, error)
	ListReleases(context.Context, product.Actor, int) ([]product.ReleaseListItem, error)
	GetRelease(context.Context, product.Actor, string) (*product.ReleaseDetail, error)
	CreateRelease(context.Context, product.Actor, product.CreateReleaseInput) (*product.ReleaseCreation, error)
	UpdateRelease(context.Context, product.Actor, string, product.UpdateReleaseInput) (*product.ReleaseDetail, error)
	ListCampaigns(context.Context, product.Actor) ([]product.CampaignItem, error)
	ListPendingApprovals(context.Context, product.Actor, int, string) (*product.ApprovalPage, error)
	DescribeAgentClient(context.Context, product.Actor, product.AgentAuthorizationRequest) (*product.AgentConsent, error)
	ApproveAgentAccess(context.Context, product.Actor, product.AgentAuthorizationRequest) (*product.AgentAuthorizationCode, error)
	GetCampaign(context.Context, product.Actor, string) (*product.CampaignDetail, error)
	CreateCampaign(context.Context, product.Actor, product.CreateCampaignInput) (*product.CampaignDetail, error)
	TransitionCampaign(context.Context, product.Actor, string, string) (*product.CampaignTransition, error)
	TransitionCampaignPosts(context.Context, product.Actor, string, product.CampaignPostDecision) (*product.CampaignPostTransition, error)
	ScheduleCampaignPost(context.Context, product.Actor, string, string, product.ScheduleCampaignPostInput) (*product.ScheduleCampaignPostResult, error)
	UpdateCampaignPost(context.Context, product.Actor, string, string, product.UpdateCampaignPostInput) (*product.CampaignPostItem, error)
	CreateDesign(context.Context, product.Actor, product.CreateDesignInput) (*product.DesignRecord, error)
	CreateStoreReview(context.Context, product.Actor, product.CreateStoreReviewInput) (*product.StoreReviewRecord, error)
	ListStoreReviews(context.Context, product.Actor, string) ([]product.StoreReviewRecord, error)
	GetStoreReview(context.Context, product.Actor, string) (*product.StoreReviewRecord, error)
	GetSharedStoreReview(context.Context, product.Actor, string, string) (*product.StoreReviewRecord, error)
	RevokeStoreReview(context.Context, product.Actor, string) error
	AddStoreReviewComment(context.Context, product.Actor, string, product.AddStoreReviewCommentInput) (*product.StoreReviewComment, error)
	ResolveStoreReviewComment(context.Context, product.Actor, string, string, bool) error
	CreateStorePublishingCredential(context.Context, product.Actor, product.CreateStorePublishingCredentialInput) (*product.StorePublishingCredential, error)
	ListStorePublishingCredentials(context.Context, product.Actor) ([]product.StorePublishingCredential, error)
	GetStorePublishingCredentialSecret(context.Context, product.Actor, string) (*product.StorePublishingCredentialSecret, error)
	DeleteStorePublishingCredential(context.Context, product.Actor, string) error
	GetDesign(context.Context, product.Actor, string) (*product.DesignRecord, error)
	UpdateDesignDocument(context.Context, product.Actor, string, map[string]any) error
	SetDesignRender(context.Context, product.Actor, string, string, *string) error
	ListCampaignDesigns(context.Context, product.Actor, string) ([]product.DesignRecord, error)
	ApproveCampaignAsset(context.Context, product.Actor, string, string) (*product.CreativeApprovalDecision, error)
	ApproveCampaignDesign(context.Context, product.Actor, string, string) (*product.CreativeApprovalDecision, error)
	GetEntitlementSummary(context.Context, product.Actor) (*product.EntitlementSummary, error)
	GetFeatureDecision(context.Context, product.Actor, string) (*product.FeatureDecision, error)
	ListCreativeTemplates(context.Context, product.Actor) ([]product.CreativeTemplateRecord, error)
	CreateCreativeTemplate(context.Context, product.Actor, product.CreateCreativeTemplateInput) (*product.CreativeTemplateRecord, error)
	CreateCreativeVariant(context.Context, product.Actor, product.CreateCreativeVariantInput) (*product.CreativeVariantRecord, error)
	DecideCreativeVariant(context.Context, product.Actor, string, product.CreativeApprovalInput) (*product.CreativeApprovalDecision, error)
	ListAuditLogs(context.Context, product.Actor, product.AuditLogQuery) (*product.AuditLogPage, error)
}

type Server struct {
	configuration ConfigurationStore
	onboarding    OnboardingService
	scheduler     WorkflowScheduler
	serviceToken  string
	store         Store
	verifier      DestinationVerifier
}

func New(store Store, scheduler WorkflowScheduler, verifier DestinationVerifier, serviceToken string) http.Handler {
	return NewWithConfiguration(store, scheduler, verifier, serviceToken, nil)
}

func NewWithConfiguration(store Store, scheduler WorkflowScheduler, verifier DestinationVerifier, serviceToken string, configuration ConfigurationStore) http.Handler {
	return NewWithOnboarding(store, scheduler, verifier, serviceToken, configuration, nil)
}

// NewWithOnboarding also serves the onboarding agent's runs.
func NewWithOnboarding(store Store, scheduler WorkflowScheduler, verifier DestinationVerifier, serviceToken string, configuration ConfigurationStore, onboarding OnboardingService) http.Handler {
	s := &Server{store: store, scheduler: scheduler, verifier: verifier, serviceToken: serviceToken, configuration: configuration, onboarding: onboarding}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.Handle("GET /v1/channel-connections", s.authenticate(http.HandlerFunc(s.listConnections)))
	mux.Handle("POST /v1/channel-connections", s.authenticateConnections(http.HandlerFunc(s.createConnection)))
	mux.Handle("POST /v1/social-oauth/context", s.authenticateOAuthCallback(http.HandlerFunc(s.socialOAuthContext)))
	mux.Handle("POST /v1/social-oauth/begin", s.authenticateConnections(http.HandlerFunc(s.beginSocialOAuth)))
	mux.Handle("POST /v1/social-connections/bluesky/begin", s.authenticateConnections(http.HandlerFunc(s.beginBluesky)))
	mux.Handle("POST /v1/social-connections/bluesky/connect", s.authenticateOAuthCallback(http.HandlerFunc(s.connectBluesky)))
	mux.Handle("POST /v1/social-oauth/exchange", s.authenticateOAuthCallback(http.HandlerFunc(s.exchangeSocialOAuth)))
	mux.Handle("POST /v1/social-oauth/page", s.authenticateOAuthCallback(http.HandlerFunc(s.selectSocialOAuthPage)))
	mux.Handle("POST /v1/social-oauth/verify", s.authenticateOAuthCallback(http.HandlerFunc(s.verifySocialOAuth)))
	mux.Handle("POST /v1/social-oauth/remember", s.authenticateOAuthCallback(http.HandlerFunc(s.rememberSocialOAuth)))
	mux.Handle("POST /v1/social-oauth/complete", s.authenticateOAuthCallback(http.HandlerFunc(s.completeSocialOAuth)))
	mux.Handle("GET /v1/scheduled-posts", s.authenticatePublishing("artifact:read", s.listScheduledPosts))
	mux.Handle("POST /v1/scheduled-posts", s.authenticatePublishing(product.PostScheduleScope, s.createScheduledPost))
	mux.Handle("POST /v1/scheduled-posts/{id}/cancel", s.authenticatePublishing(product.PostScheduleScope, s.cancelScheduledPost))
	if configuration != nil {
		s.registerConfiguration(mux)
		s.registerWorkspace(mux)
		s.registerInternal(mux)
		s.registerCampaignAssets(mux)
		s.registerStoreScreenshots(mux)
		s.registerLaunch(mux)
		s.registerConversations(mux)
		s.registerPlatformControls(mux)
		s.registerPermissionGroups(mux)
		s.registerGitHub(mux)
		s.registerReleaseAutomation(mux)
		s.registerCapture(mux)
		s.registerFrontendDeployments(mux)
		s.registerMetaCallbacks(mux)
		s.registerAnnouncements(mux)
		s.registerAgentAccess(mux)
		s.registerScreenshots(mux)
		s.registerRender(mux)
		s.registerProjects(mux)
		s.registerCreativeSets(mux)
		s.registerContentDrafts(mux)
		s.registerSettingsPlatform(mux)
		s.registerWebhooks(mux)
		s.registerLibrary(mux)
		s.registerSharing(mux)
		s.registerPlanAnalyze(mux)
		s.registerNotifications(mux)
		s.registerOnboarding(mux)
	}
	return requestLogging(mux)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "publishing-backend"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	if err := s.scheduler.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "Temporal is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return s.authenticateWithOptions(next, true, true, func(ctx context.Context, actor product.Actor) error {
		return s.store.AuthorizePublishing(ctx, actor.OrganizationID, actor.UserID, actor.SessionID)
	})
}

func (s *Server) authenticateConnections(next http.Handler) http.Handler {
	return s.authenticateWithOptions(next, true, true, func(ctx context.Context, actor product.Actor) error {
		return s.store.AuthorizeConnections(ctx, actor.OrganizationID, actor.UserID, actor.SessionID)
	})
}

// authenticatePublishing admits a publisher's session, or an API key the
// backend itself finds was issued with scope: agents may read and change the
// schedule, while only a person approves what is on it (RFC 026).
func (s *Server) authenticatePublishing(scope string, next http.HandlerFunc) http.Handler {
	return s.authenticateWithOptions(next, true, false, func(ctx context.Context, actor product.Actor) error {
		switch {
		case actor.IsSession():
			return s.store.AuthorizePublishing(ctx, actor.OrganizationID, actor.UserID, actor.SessionID)
		case actor.Kind == "api_key":
			return s.store.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, scope)
		}
		return publishing.ErrForbidden
	})
}

// authenticateProduct admits a session, API key, support grant, or service
// caller for the named workspace. Each request is reauthorized in the backend.
func (s *Server) authenticateProduct(next http.Handler) http.Handler {
	return s.authenticateWithOptions(next, true, false, s.configuration.AuthorizeRead)
}

func (s *Server) authenticateSession(next http.Handler) http.Handler {
	return s.authenticateWithOptions(next, false, true, s.configuration.AuthorizeSession)
}

// authenticateService admits only the web facade itself, for operations that
// run before a session exists (the auth adapter) or on its behalf.
func (s *Server) authenticateService(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.serviceAuthenticated(w, r) {
			next.ServeHTTP(w, r)
		}
	})
}

func (s *Server) serviceAuthenticated(w http.ResponseWriter, r *http.Request) bool {
	if s.serviceToken == "" {
		writeError(w, http.StatusServiceUnavailable, "service authentication is not configured")
		return false
	}
	provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.serviceToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

// requestActor reads the principal the web facade forwards. The service token
// authenticates the facade; these headers only name who it acts for, and the
// backend rechecks that principal before any tenant operation.
func requestActor(r *http.Request) product.Actor {
	return product.Actor{
		OrganizationID: r.Header.Get("X-Organization-ID"),
		UserID:         r.Header.Get("X-User-ID"),
		SessionID:      r.Header.Get("X-Session-ID"),
		RequestID:      r.Header.Get("X-Request-ID"),
		Kind:           r.Header.Get("X-Principal-Kind"),
		KeyID:          r.Header.Get("X-API-Key-ID"),
		GrantID:        r.Header.Get("X-Support-Grant-ID"),
		Display:        r.Header.Get("X-Principal-Display"),
	}
}

func (s *Server) authenticateWithOptions(next http.Handler, organizationRequired, sessionOnly bool, authorize func(context.Context, product.Actor) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.serviceAuthenticated(w, r) {
			return
		}
		actor := requestActor(r)
		if organizationRequired && actor.OrganizationID == "" {
			writeError(w, http.StatusBadRequest, "X-Organization-ID is required")
			return
		}
		if actor.IsSession() && (actor.UserID == "" || actor.SessionID == "") {
			writeError(w, http.StatusUnauthorized, "a publishing session is required")
			return
		}
		if sessionOnly && !actor.IsSession() {
			writeError(w, http.StatusUnauthorized, "a signed-in session is required")
			return
		}
		var memo publishing.AuthorizationMemo
		if err := authorize(publishing.RecordAuthorization(r.Context(), &memo), actor); err != nil {
			writeStoreError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(publishing.ReplayAuthorization(r.Context(), &memo)))
	})
}

type connectionRequest struct {
	ExternalAccountID string         `json:"externalAccountId"`
	Platform          string         `json:"platform"`
	ProviderSettings  map[string]any `json:"providerSettings"`
	SecretReference   string         `json:"secretReference"`
}

func (s *Server) createConnection(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorFromRequest(w, r, true)
	if !ok {
		return
	}
	var input connectionRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.ExternalAccountID = strings.TrimSpace(input.ExternalAccountID)
	input.Platform = strings.ToLower(strings.TrimSpace(input.Platform))
	input.SecretReference = strings.TrimSpace(input.SecretReference)
	if input.Platform == "" {
		input.Platform = "x"
	}
	if input.SecretReference == "" {
		input.SecretReference = "SOCIAL_API_KEY"
	}
	if input.ProviderSettings == nil {
		input.ProviderSettings = map[string]any{}
	}
	if input.ExternalAccountID == "" || len([]rune(input.ExternalAccountID)) > 160 ||
		len(input.Platform) > 64 || !platformPattern.MatchString(input.Platform) ||
		!publishing.IsSecretReference(input.SecretReference) {
		writeError(w, http.StatusBadRequest, "externalAccountId and a valid social secretReference are required")
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.Organization)
	if err != nil {
		if errors.Is(err, publishing.ErrNotFound) {
			writeError(w, http.StatusConflict, "Social publishing is not configured for this workspace")
		} else {
			writeStoreError(w, err)
		}
		return
	}
	if binding.SecretReference != input.SecretReference {
		writeError(w, http.StatusConflict, "Social publishing is not configured for this workspace")
		return
	}
	if s.verifier == nil {
		writeError(w, http.StatusServiceUnavailable, "destination verification is unavailable")
		return
	}
	if err := s.verifier.VerifyDestination(r.Context(), socialapi.VerifyDestinationInput{
		DestinationID: input.ExternalAccountID, ExpectedGoOrganizationID: binding.GoOrganizationID,
		Platform: input.Platform, SecretReference: input.SecretReference,
	}); err != nil {
		providerErr := &socialapi.Error{}
		if errors.As(err, &providerErr) && providerErr.Status == http.StatusNotFound {
			writeError(w, http.StatusNotFound, "Social destination was not found")
		} else {
			writeError(w, http.StatusConflict, "Social destination could not be verified")
		}
		return
	}
	if s.configuration != nil {
		if err := s.configuration.RequireChannel(r.Context(), actor.Organization, input.ExternalAccountID); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	connection, err := s.store.CreateConnection(r.Context(), actor, publishing.CreateConnectionInput{
		ExternalAccountID: input.ExternalAccountID,
		Platform:          input.Platform,
		ProviderSettings:  input.ProviderSettings,
		SecretReference:   input.SecretReference,
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, connectionResponse(r.Context(), connection))
}

func (s *Server) listConnections(w http.ResponseWriter, r *http.Request) {
	organizationID := r.Header.Get("X-Organization-ID")
	connections, err := s.store.ListConnections(r.Context(), organizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	connections = s.fillProfiles(r.Context(), organizationID, connections)
	var states map[string]product.ChannelAccountState
	if s.configuration != nil {
		if states, err = s.configuration.ChannelAccountStates(r.Context(), organizationID, connections); err != nil {
			writeStoreError(w, err)
			return
		}
	}
	items := make([]any, 0, len(connections))
	for _, connection := range connections {
		items = append(items, connectionWithState(r.Context(), connection, states))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// destinationProfiles reads accounts' names, handles and avatars (social API).
type destinationProfiles interface {
	Profiles(ctx context.Context, secretReference string) (map[string]socialapi.DestinationProfile, error)
}

// fillProfiles names connections that have no name yet, from one social API
// call; connections made before names were stored get them on first list.
// Best effort: without the social API the connections are returned as they are.
func (s *Server) fillProfiles(ctx context.Context, organizationID string, connections []*ent.ChannelConnection) []*ent.ChannelConnection {
	profiler, ok := s.verifier.(destinationProfiles)
	missing := false
	for _, connection := range connections {
		missing = missing || connection.DisplayName == nil && connection.Status == channelconnection.StatusACTIVE
	}
	if !ok || !missing {
		return connections
	}
	binding, err := s.store.Binding(ctx, organizationID)
	if err != nil {
		return connections
	}
	profiles, err := profiler.Profiles(ctx, binding.SecretReference)
	if err != nil {
		slog.WarnContext(ctx, "channel profiles unavailable", "organization", organizationID, "error", err)
		return connections
	}
	for index, connection := range connections {
		profile, found := profiles[connection.ExternalAccountID]
		if connection.DisplayName != nil || !found || profile.Name == "" && profile.Handle == "" {
			continue
		}
		if named, err := s.store.SetConnectionProfile(ctx, connection.ID, profile.Name, profile.Handle, profile.AvatarURL); err == nil {
			connections[index] = named
		}
	}
	return connections
}

type scheduledPostRequest struct {
	Caption             string    `json:"caption"`
	ChannelConnectionID string    `json:"channelConnectionId"`
	IdempotencyKey      string    `json:"idempotencyKey"`
	ScheduledFor        time.Time `json:"scheduledFor"`
	// Exactly one source: a campaign variant or a content draft (RFC 013).
	ContentDraftID string `json:"contentDraftId"`
	VariantID      string `json:"variantId"`
}

func (s *Server) createScheduledPost(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorFromRequest(w, r, true)
	if !ok {
		return
	}
	var input scheduledPostRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Caption = strings.TrimSpace(input.Caption)
	input.IdempotencyKey = strings.TrimSpace(input.IdempotencyKey)
	if input.Caption == "" || len([]rune(input.Caption)) > 3000 || input.ChannelConnectionID == "" || input.ScheduledFor.IsZero() {
		writeError(w, http.StatusBadRequest, "caption, channelConnectionId, and scheduledFor are required")
		return
	}
	if (input.VariantID == "") == (input.ContentDraftID == "") {
		writeError(w, http.StatusBadRequest, "exactly one of variantId and contentDraftId is required")
		return
	}
	if len(input.IdempotencyKey) > 128 {
		writeError(w, http.StatusBadRequest, "idempotencyKey must not exceed 128 characters")
		return
	}
	if !input.ScheduledFor.After(time.Now()) {
		writeError(w, http.StatusBadRequest, "scheduledFor must be in the future")
		return
	}
	create := publishing.CreateScheduledPostInput{
		Caption: input.Caption, ChannelConnectionID: input.ChannelConnectionID,
		ContentDraftID: input.ContentDraftID, IdempotencyKey: input.IdempotencyKey, ScheduledFor: input.ScheduledFor,
		VariantID: input.VariantID,
	}
	var result publishing.CreateScheduledPostResult
	var err error
	if s.configuration != nil {
		// The domain charges the monthly posts allowance, for REST and MCP alike.
		result, err = s.configuration.CreateScheduledPost(r.Context(), requestActor(r), create)
	} else {
		result, err = s.store.CreateScheduledPost(r.Context(), actor, create)
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if result.Post.Status == scheduledpost.StatusSCHEDULED {
		if err := s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{
			OrganizationID: result.Post.OrganizationID,
			PostID:         result.Post.ID,
			ScheduledFor:   result.Post.ScheduledFor,
		}); err != nil {
			writeError(w, http.StatusServiceUnavailable, "could not start publishing workflow")
			return
		}
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"created": result.Created, "scheduledPost": product.ScheduledPostView(result.Post)})
}

func (s *Server) listScheduledPosts(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "limit must be between 1 and 100")
			return
		}
		limit = parsed
	}
	posts, err := s.store.ListScheduledPosts(r.Context(), r.Header.Get("X-Organization-ID"), !requestActor(r).IsSession(), limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]any, 0, len(posts))
	for _, post := range posts {
		items = append(items, product.ScheduledPostView(post))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

var platformPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

func (s *Server) cancelScheduledPost(w http.ResponseWriter, r *http.Request) {
	actor, ok := actorFromRequest(w, r, true)
	if !ok {
		return
	}
	post, err := s.store.CancelScheduledPost(r.Context(), actor, r.PathValue("id"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := s.scheduler.Cancel(r.Context(), post.ID); err != nil {
		writeError(w, http.StatusServiceUnavailable, "could not cancel publishing workflow")
		return
	}
	writeJSON(w, http.StatusOK, product.ScheduledPostView(post))
}

func actorFromRequest(w http.ResponseWriter, r *http.Request, requireUser bool) (publishing.Actor, bool) {
	userID, actorType := r.Header.Get("X-User-ID"), "USER"
	if !requestActor(r).IsSession() {
		// An API key has no user; the audit records it as a service by its name.
		requireUser, actorType = false, "SERVICE"
	}
	if requireUser && userID == "" {
		writeError(w, http.StatusBadRequest, "X-User-ID is required")
		return publishing.Actor{}, false
	}
	requestID := r.Header.Get("X-Request-ID")
	if requestID == "" {
		requestID = fmt.Sprintf("backend-%d", time.Now().UnixNano())
	}
	// The SDK names the actor in X-Principal-Display; the scheduled post audit
	// rows (post.scheduled, post.cancelled) record it.
	return publishing.Actor{
		Display: r.Header.Get("X-Principal-Display"), Organization: r.Header.Get("X-Organization-ID"),
		RequestID: requestID, Type: actorType, UserID: userID,
	}, true
}

func connectionResponse(ctx context.Context, connection *ent.ChannelConnection) map[string]any {
	return map[string]any{
		"id": connection.ID, "externalAccountId": connection.ExternalAccountID,
		"platform": connection.Platform, "provider": connection.Provider,
		"providerSettings": connection.ProviderSettings, "status": connection.Status,
		"createdAt": connection.CreatedAt, "updatedAt": connection.UpdatedAt,
		"displayName": connection.DisplayName, "handle": connection.Handle, "avatarUrl": product.BrowserAvatar(ctx, connection.AvatarURL),
		"socialSetId": connection.SocialSetID,
	}
}

// connectionWithState adds an account's health and queued-post count, when
// the product configuration could read them.
func connectionWithState(ctx context.Context, connection *ent.ChannelConnection, states map[string]product.ChannelAccountState) map[string]any {
	response := connectionResponse(ctx, connection)
	if state, ok := states[connection.ID]; ok {
		response["health"] = state.Health
		response["queuedPosts"] = state.QueuedPosts
	}
	return response
}

func decodeJSON(r *http.Request, target any) error {
	return decodeJSONLimit(r, target, 1<<20)
}

func decodeJSONLimit(r *http.Request, target any, limit int64) error {
	r.Body = http.MaxBytesReader(nil, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain one JSON object")
	}
	return nil
}

// writeQuotaExceeded tells a client which quota ran out, its limit, and
// when it resets, so a 429 can be explained instead of retried blindly.
func writeQuotaExceeded(w http.ResponseWriter, exceeded *product.QuotaExceededError) {
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"error": exceeded.Error(), "limit": exceeded.Limit, "quota": exceeded.Quota,
		"resetAt": exceeded.ResetAt.UnixMilli(),
	})
}

func writeStoreError(w http.ResponseWriter, err error) {
	var notEntitled *product.FeatureNotEntitledError
	var exceeded *product.QuotaExceededError
	var prohibited *product.ProhibitedTermsError
	var atLimit *product.PlanLimitError
	switch {
	case errors.As(err, &prohibited):
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "brand_prohibited_terms", "error": err.Error(), "matches": prohibited.Matches,
		})
	case errors.As(err, &notEntitled):
		writeJSON(w, http.StatusForbidden, map[string]string{
			"code": "workspace_feature_not_entitled", "currentPlan": notEntitled.CurrentPlan,
			"error": err.Error(), "feature": notEntitled.Feature, "requiredPlan": notEntitled.RequiredPlan,
		})
	case errors.As(err, &atLimit):
		writeJSON(w, http.StatusForbidden, map[string]any{
			"code": "plan_limit_reached", "currentPlan": atLimit.Plan, "error": err.Error(),
			"limit": atLimit.Limit, "name": atLimit.Name,
		})
	case errors.Is(err, product.ErrWebhooksUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"code": "webhooks_unavailable", "error": err.Error()})
	case errors.Is(err, publishing.ErrSocialSetSlotTaken), errors.Is(err, publishing.ErrAccountInAnotherSet):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, publishing.ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, err.Error())
	case errors.Is(err, publishing.ErrForbidden):
		writeError(w, http.StatusForbidden, err.Error())
	case errors.Is(err, publishing.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, publishing.ErrConflict), errors.Is(err, publishing.ErrInvalidState):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, publishing.ErrNotEligible), errors.Is(err, product.ErrInvalidInput):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, product.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, err.Error())
	case errors.Is(err, product.ErrStorageQuota):
		writeError(w, http.StatusTooManyRequests, err.Error())
	case errors.As(err, &exceeded):
		writeQuotaExceeded(w, exceeded)
	case errors.Is(err, product.ErrQuotaExceeded):
		writeError(w, http.StatusTooManyRequests, err.Error())
	case errors.Is(err, product.ErrObjectMissing):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, product.ErrGitHubUnavailable):
		writeError(w, http.StatusServiceUnavailable, "GitHub is unavailable")
	case errors.Is(err, product.ErrStorageUnavailable):
		writeError(w, http.StatusServiceUnavailable, "media storage is unavailable")
	default:
		writeError(w, http.StatusInternalServerError, "internal server error")
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		fmt.Printf("method=%s path=%s duration=%s\n", r.Method, r.URL.Path, time.Since(started).Round(time.Millisecond))
	})
}
