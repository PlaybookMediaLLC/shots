// Package activity defines committed workspace activity, separate from audit history.
package activity

import (
	"context"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/lucsky/cuid"
	"maps"
)

type Definition struct {
	MandatoryFailure bool     `json:"mandatoryFailure"`
	Emitter          string   `json:"emitter"`
	AccessCheck      string   `json:"accessCheck"`
	Sensitivity      string   `json:"sensitivity"`
	Channels         []string `json:"channels"`
	Description      string   `json:"description"`
	Destination      string   `json:"destination"`
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	Group            string   `json:"group"`
	Audience         string   `json:"audience"`
	Restricted       bool     `json:"restricted"`
	EmailDefault     bool     `json:"emailDefault"`
}

var Catalogue = catalogue([]Definition{
	{ID: "frontend.connection_attention", Label: "Frontend connection needs attention", Group: "deployments", Audience: "workspace"},
	{ID: "frontend.succeeded", Label: "Production deployment reported successful", Group: "deployments", Audience: "workspace"},
	{ID: "frontend.checks_passed", Label: "Production deployment reported successful; required checks passed", Group: "deployments", Audience: "workspace"},
	{ID: "frontend.failed", Label: "Production deployment or required checks failed", Group: "deployments", Audience: "workspace"},
	{ID: "frontend.needs_attention", Label: "Production deployment needs attention", Group: "deployments", Audience: "workspace"},
	{ID: "frontend.rollback", Label: "Production rollback reported; inspect activation evidence", Group: "deployments", Audience: "workspace"},
	{ID: "release.created", Label: "Release created", Group: "releases", Audience: "creators", Restricted: false, EmailDefault: false},
	{ID: "release.ingested", Label: "Release received", Group: "releases", Audience: "creators", Restricted: false, EmailDefault: false},
	{ID: "source_change.collected", Label: "Repository changes received", Group: "releases", Audience: "creators", Restricted: false, EmailDefault: false},
	{ID: "source_app.connected", Label: "Repository connected", Group: "integrations", Audience: "admins", Restricted: false, EmailDefault: false},
	{ID: "deployment.succeeded", Label: "Deployment received", Group: "captures", Audience: "creators", Restricted: false, EmailDefault: false},
	{ID: "capture.completed", Label: "Capture ready", Group: "captures", Audience: "owner", Restricted: false, EmailDefault: false},
	{ID: "capture.failed", Label: "Capture needs attention", Group: "captures", Audience: "operators", Restricted: true, EmailDefault: false},
	{ID: "asset.uploaded", Label: "Asset ready", Group: "assets", Audience: "owner", Restricted: false, EmailDefault: false},
	{ID: "asset.generated", Label: "Generated asset ready", Group: "assets", Audience: "owner", Restricted: false, EmailDefault: false},
	{ID: "generation.completed", Label: "Generation finished", Group: "generation", Audience: "owner", Restricted: false, EmailDefault: false},
	{ID: "generation.failed", Label: "Generation needs attention", Group: "generation", Audience: "operators", Restricted: true, EmailDefault: false},
	{ID: "generation.budget_exhausted", Label: "Generation reached its budget", Group: "generation", Audience: "operators", Restricted: true, EmailDefault: false},
	{ID: "generation.cancelled", Label: "Generation cancelled", Group: "generation", Audience: "owner", Restricted: false, EmailDefault: false},
	{ID: "campaign_posts.submitted", Label: "Campaign posts need review", Group: "reviews", Audience: "approvers", Restricted: true, EmailDefault: true},
	{ID: "campaign_posts.decided", Label: "Campaign review decision", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: true},
	{ID: "variant.ready", Label: "Creative asset ready for review", Group: "reviews", Audience: "approvers", Restricted: true, EmailDefault: false},
	{ID: "variant.decided", Label: "Creative asset review decision", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "brief.approved", Label: "Brief approved", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "plan.approved", Label: "Plan approved", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "draft.review_requested", Label: "Draft needs review", Group: "reviews", Audience: "draft_reviewers", Restricted: true, EmailDefault: false},
	{ID: "draft.approved", Label: "Draft approved", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "draft.changes_requested", Label: "Draft changes requested", Group: "reviews", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "comment.created", Label: "Reply to your comment", Group: "comments", Audience: "participants", Restricted: true, EmailDefault: false},
	{ID: "comment.on_your_draft", Label: "New comment on your draft", Group: "comments", Audience: "owner", Restricted: true, EmailDefault: false},
	{ID: "comment.resolved", Label: "Comment resolved", Group: "comments", Audience: "participants", Restricted: true, EmailDefault: false},
	{ID: "member.mentioned", Label: "You were mentioned", Group: "mentions", Audience: "mentioned", Restricted: true, EmailDefault: false},
	{ID: "post.scheduled", Label: "Post scheduled", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.moved", Label: "Post rescheduled", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.cancelled", Label: "Post cancelled", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.published", Label: "Post published", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.sent_to_app", Label: "Post sent to the app to finish", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.auto_repost_published", Label: "Auto-retweet published", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.auto_plug_published", Label: "Auto-plug published", Group: "publishing", Audience: "publishers", Restricted: false, EmailDefault: false},
	{ID: "post.publish_failed", Label: "Publishing needs attention", Group: "publishing", Audience: "operators", Restricted: true, EmailDefault: false},
	{ID: "post.publish_recovery_required", Label: "Publishing result needs review", Group: "publishing", Audience: "operators", Restricted: true, EmailDefault: false},
	{ID: "integration.connected", Label: "Integration connected", Group: "integrations", Audience: "admins", Restricted: false, EmailDefault: false},
	{ID: "integration.disconnected", Label: "Integration disconnected", Group: "integrations", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "integration.reconnect_required", Label: "Integration needs reconnection", Group: "integrations", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "invitation.created", Label: "Member invited", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "invitation.revoked", Label: "Invitation revoked", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "member.joined", Label: "Member joined", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "member.removed", Label: "Member removed", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "member.left", Label: "Member left", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "member.role_changed", Label: "Member role changed", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "workspace.ownership_transferred", Label: "Workspace owner changed", Group: "membership", Audience: "admins", Restricted: true, EmailDefault: false},
	{ID: "workflow.completed", Label: "Workflow run completed", Group: "workflows", Audience: "admins", Restricted: false, EmailDefault: false},
	{ID: "workflow.needs_attention", Label: "Workflow run needs attention", Group: "workflows", Audience: "operators", Restricted: true, EmailDefault: false},
})

func Lookup(kind string) (Definition, bool) {
	for _, d := range Catalogue {
		if d.ID == kind {
			return d, true
		}
	}
	return Definition{}, false
}

// Emit belongs inside the business transaction; payload contains references, never credentials.
func Emit(ctx context.Context, tx *ent.Tx, org, kind, resourceType, resourceID, actorID, key string, payload map[string]any) error {
	if _, ok := Lookup(kind); !ok {
		return fmt.Errorf("unknown workspace activity %q", kind)
	}
	payload = maps.Clone(payload)
	if payload == nil {
		payload = map[string]any{}
	}
	payload["actorUserId"] = actorID
	id := cuid.New()
	if key == "" {
		key = id
	}
	exists, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(org), outboxevent.IdempotencyKey("activity:"+kind+":"+key)).Exist(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return tx.OutboxEvent.Create().SetID(id).SetOrganizationID(org).SetType("activity." + kind).
		SetAggregateType(resourceType).SetAggregateID(resourceID).SetPayload(payload).
		SetIdempotencyKey("activity:" + kind + ":" + key).Exec(ctx)
}

func catalogue(definitions []Definition) []Definition {
	sources := map[string]string{
		"frontend.connection_attention": "saveFrontendPollState", "frontend.succeeded": "emitFrontendDecision", "frontend.checks_passed": "emitFrontendDecision", "frontend.failed": "emitFrontendDecision", "frontend.needs_attention": "emitFrontendDecision", "frontend.rollback": "emitFrontendDecision",
		"release.created": "CreateRelease", "release.ingested": "IngestSourceRelease", "source_change.collected": "CollectSourceChange", "source_app.connected": "CreateSourceApp", "deployment.succeeded": "IngestDeployment",
		"capture.completed": "recordCapture", "capture.failed": "handleDeploymentEvent", "asset.uploaded": "CompleteAssetUpload", "asset.generated": "StoreGeneratedAsset",
		"generation.completed": "FinishLaunchRun", "generation.failed": "FinishLaunchRun / expired-run recovery", "generation.budget_exhausted": "FinishLaunchRun", "generation.cancelled": "CancelLaunchRun",
		"campaign_posts.submitted": "TransitionCampaignPosts", "campaign_posts.decided": "TransitionCampaignPosts", "variant.ready": "CreateCreativeVariant / SaveDesign", "variant.decided": "decideVariantTx", "brief.approved": "ApproveLaunchSpec", "plan.approved": "ApproveLaunchPlan",
		"draft.review_requested": "ReviewContentDraft", "draft.approved": "ReviewContentDraft", "draft.changes_requested": "ReviewContentDraft", "comment.created": "recordDiscussionActivity / AddGuestComment / AddStoreReviewComment", "comment.on_your_draft": "recordDiscussionActivity", "comment.resolved": "recordDiscussionActivity / ResolveStoreReviewComment", "member.mentioned": "recordDiscussionActivity",
		"post.scheduled": "ScheduleContentDraft / publishing.Repository.Schedule", "post.moved": "MoveContentDraft / publishing.Repository.Schedule", "post.cancelled": "CancelContentDraftSchedule / publishing.Repository.Cancel", "post.published": "publishing.Repository.Complete", "post.sent_to_app": "publishing.Repository.Complete", "post.auto_repost_published": "publishing.Repository.RecordAutoAction", "post.auto_plug_published": "publishing.Repository.RecordAutoAction", "post.publish_failed": "publishing.Repository.Fail", "post.publish_recovery_required": "publishing.Repository.MarkUnknown",
		"integration.connected": "SaveIntegration / FinishOAuth / Slack callback / provider health recovery", "integration.disconnected": "DeleteIntegration / Slack Disconnect", "integration.reconnect_required": "Slack / social provider committed health transition", "invitation.created": "CreateInvitation", "invitation.revoked": "RevokeInvitation", "member.joined": "membership transaction trigger", "member.removed": "RemoveMember / membership transaction trigger", "member.left": "LeaveWorkspace", "member.role_changed": "ChangeMemberRole / membership transaction trigger", "workspace.ownership_transferred": "TransferWorkspaceOwnership",
		"workflow.completed": "FinishReleaseAutomation", "workflow.needs_attention": "FinishReleaseAutomation",
	}
	destinations := map[string]string{"deployments": "deployment evidence", "releases": "release intake or associated campaign", "captures": "product page", "assets": "asset or campaign", "generation": "campaign run", "reviews": "campaign step or draft editor", "comments": "resource discussion", "mentions": "resource discussion", "publishing": "draft calendar or campaign", "integrations": "integration or source settings", "membership": "member settings", "workflows": "workflow run"}
	for i := range definitions {
		d := &definitions[i]
		d.MandatoryFailure = d.ID == "post.publish_failed" || d.ID == "post.publish_recovery_required"
		d.Emitter = sources[d.ID]
		d.Destination = destinations[d.Group]
		d.AccessCheck = "Current workspace membership and current access to the referenced resource"
		d.Channels = []string{"in_app", "email"}
		d.Sensitivity = "coarse"
		if d.Restricted {
			d.Sensitivity = "restricted"
		} else {
			d.Channels = append(d.Channels, "slack")
		}
		d.Description = d.Label + " after the business transition commits."
	}
	return definitions
}
