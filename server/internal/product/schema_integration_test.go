package product

import (
	"context"
	"os"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
)

// Every Ent projection must read the migrated table: a renamed or missing
// column fails here instead of at the first customer request.
func TestEntProjectionsMatchMigratedTables(t *testing.T) {
	url := os.Getenv("PUBLISHING_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PUBLISHING_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	c := db.Client
	queries := map[string]func() error{
		"release_automation":               func() error { _, err := c.ReleaseAutomation.Query().Limit(1).All(ctx); return err },
		"release_automation_version":       func() error { _, err := c.ReleaseAutomationVersion.Query().Limit(1).All(ctx); return err },
		"release_source_event":             func() error { _, err := c.ReleaseSourceEvent.Query().Limit(1).All(ctx); return err },
		"release_automation_run":           func() error { _, err := c.ReleaseAutomationRun.Query().Limit(1).All(ctx); return err },
		"release_automation_node":          func() error { _, err := c.ReleaseAutomationNode.Query().Limit(1).All(ctx); return err },
		"release_automation_executor":      func() error { _, err := c.ReleaseAutomationExecutor.Query().Limit(1).All(ctx); return err },
		"audit_drain":                      func() error { _, err := c.AuditDrain.Query().Limit(1).All(ctx); return err },
		"calendar_note":                    func() error { _, err := c.CalendarNote.Query().Limit(1).All(ctx); return err },
		"content_draft":                    func() error { _, err := c.ContentDraft.Query().Limit(1).All(ctx); return err },
		"content_batch":                    func() error { _, err := c.ContentBatch.Query().Limit(1).All(ctx); return err },
		"content_batch_item":               func() error { _, err := c.ContentBatchItem.Query().Limit(1).All(ctx); return err },
		"content_draft_revision":           func() error { _, err := c.ContentDraftRevision.Query().Limit(1).All(ctx); return err },
		"content_draft_tag":                func() error { _, err := c.ContentDraftTag.Query().Limit(1).All(ctx); return err },
		"content_draft_finisher":           func() error { _, err := c.ContentDraftFinisher.Query().Limit(1).All(ctx); return err },
		"post_automation_run":              func() error { _, err := c.PostAutomationRun.Query().Limit(1).All(ctx); return err },
		"organization_enterprise_settings": func() error { _, err := c.OrganizationEnterpriseSettings.Query().Limit(1).All(ctx); return err },
		"session":                          func() error { _, err := c.Session.Query().Limit(1).All(ctx); return err },
		"support_access_grant":             func() error { _, err := c.SupportAccessGrant.Query().Limit(1).All(ctx); return err },
		"user":                             func() error { _, err := c.User.Query().Limit(1).All(ctx); return err },
		"store_review":                     func() error { _, err := c.StoreReview.Query().Limit(1).All(ctx); return err },
		"store_review_comment":             func() error { _, err := c.StoreReviewComment.Query().Limit(1).All(ctx); return err },
		"store_publishing_credential":      func() error { _, err := c.StorePublishingCredential.Query().Limit(1).All(ctx); return err },
		"workspace_entitlement":            func() error { _, err := c.WorkspaceEntitlement.Query().Limit(1).All(ctx); return err },
		"outbox_event":                     func() error { _, err := c.OutboxEvent.Query().Limit(1).All(ctx); return err },
		"github_installation":              func() error { _, err := c.GitHubInstallation.Query().Limit(1).All(ctx); return err },
		"workspace_github_installation":    func() error { _, err := c.WorkspaceGitHubInstallation.Query().Limit(1).All(ctx); return err },
		"github_install_start":             func() error { _, err := c.GitHubInstallStart.Query().Limit(1).All(ctx); return err },
		"source_change":                    func() error { _, err := c.SourceChange.Query().Limit(1).All(ctx); return err },
		"deployment_event":                 func() error { _, err := c.DeploymentEvent.Query().Limit(1).All(ctx); return err },
		"apikey":                           func() error { _, err := c.Apikey.Query().Limit(1).All(ctx); return err },
		"audience_subscriber":              func() error { _, err := c.AudienceSubscriber.Query().Limit(1).All(ctx); return err },
		"audit_retention_policy":           func() error { _, err := c.AuditRetentionPolicy.Query().Limit(1).All(ctx); return err },
		"permission_group":                 func() error { _, err := c.PermissionGroup.Query().Limit(1).All(ctx); return err },
		"permission_group_member":          func() error { _, err := c.PermissionGroupMember.Query().Limit(1).All(ctx); return err },
		"billing_entitlement_event":        func() error { _, err := c.BillingEntitlementEvent.Query().Limit(1).All(ctx); return err },
		"campaign_plan":                    func() error { _, err := c.CampaignPlan.Query().Limit(1).All(ctx); return err },
		"campaign_revision":                func() error { _, err := c.CampaignRevision.Query().Limit(1).All(ctx); return err },
		"communication_attempt":            func() error { _, err := c.CommunicationAttempt.Query().Limit(1).All(ctx); return err },
		"communication_recipient":          func() error { _, err := c.CommunicationRecipient.Query().Limit(1).All(ctx); return err },
		"customer_communication":           func() error { _, err := c.CustomerCommunication.Query().Limit(1).All(ctx); return err },
		"launch_run":                       func() error { _, err := c.LaunchRun.Query().Limit(1).All(ctx); return err },
		"release_document":                 func() error { _, err := c.ReleaseDocument.Query().Limit(1).All(ctx); return err },
		"release_spec":                     func() error { _, err := c.ReleaseSpec.Query().Limit(1).All(ctx); return err },
		"screenshot_cache":                 func() error { _, err := c.ScreenshotCache.Query().Limit(1).All(ctx); return err },
		"share_link":                       func() error { _, err := c.ShareLink.Query().Limit(1).All(ctx); return err },
		"integration_connection":           func() error { _, err := c.IntegrationConnection.Query().Limit(1).All(ctx); return err },
		"brand_profile":                    func() error { _, err := c.BrandProfile.Query().Limit(1).All(ctx); return err },
		"product_surface":                  func() error { _, err := c.ProductSurface.Query().Limit(1).All(ctx); return err },
		"surface_capture":                  func() error { _, err := c.SurfaceCapture.Query().Limit(1).All(ctx); return err },
		"product_profile":                  func() error { _, err := c.ProductProfile.Query().Limit(1).All(ctx); return err },
		"launch_run_step":                  func() error { _, err := c.LaunchRunStep.Query().Limit(1).All(ctx); return err },
		"conversation":                     func() error { _, err := c.Conversation.Query().Limit(1).All(ctx); return err },
		"conversation_message":             func() error { _, err := c.ConversationMessage.Query().Limit(1).All(ctx); return err },
		"workspace_settings":               func() error { _, err := c.WorkspaceSettings.Query().Limit(1).All(ctx); return err },
		"onboarding_run":                   func() error { _, err := c.OnboardingRun.Query().Limit(1).All(ctx); return err },
		"page_knowledge":                   func() error { _, err := c.PageKnowledge.Query().Limit(1).All(ctx); return err },
		"ideal_customer_profile":           func() error { _, err := c.IdealCustomerProfile.Query().Limit(1).All(ctx); return err },
		"enrichment_record":                func() error { _, err := c.EnrichmentRecord.Query().Limit(1).All(ctx); return err },
		"user_preference":                  func() error { _, err := c.UserPreference.Query().Limit(1).All(ctx); return err },
		"account_deletion_request":         func() error { _, err := c.AccountDeletionRequest.Query().Limit(1).All(ctx); return err },
		"social_set":                       func() error { _, err := c.SocialSet.Query().Limit(1).All(ctx); return err },
		"social_set_writing_sample":        func() error { _, err := c.SocialSetWritingSample.Query().Limit(1).All(ctx); return err },
		"webhook_subscription":             func() error { _, err := c.WebhookSubscription.Query().Limit(1).All(ctx); return err },
		"webhook_delivery":                 func() error { _, err := c.WebhookDelivery.Query().Limit(1).All(ctx); return err },
		"webhook_delivery_attempt":         func() error { _, err := c.WebhookDeliveryAttempt.Query().Limit(1).All(ctx); return err },
		"channel_connection":               func() error { _, err := c.ChannelConnection.Query().Limit(1).All(ctx); return err },
		"scheduled_post":                   func() error { _, err := c.ScheduledPost.Query().Limit(1).All(ctx); return err },
		"social_oauth_start":               func() error { _, err := c.SocialOAuthStart.Query().Limit(1).All(ctx); return err },
		"platform_notification_preference": func() error { _, err := c.PlatformNotificationPreference.Query().Limit(1).All(ctx); return err },
	}
	for table, query := range queries {
		if err := query(); err != nil {
			t.Errorf("%s: %v", table, err)
		}
	}
}
