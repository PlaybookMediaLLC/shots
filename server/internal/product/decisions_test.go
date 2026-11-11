package product

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// Approving and announcing are decisions a person makes. The
// backend refuses every other principal before it touches the database.
func TestDecisionsRefuseNonSessionActors(t *testing.T) {
	ctx := context.Background()
	repo := &Configuration{}
	entrypoints := map[string]func(Actor) error{
		"ReviewContentDraft": func(a Actor) error {
			_, err := repo.ReviewContentDraft(ctx, a, "draft", ContentDraftReviewInput{Version: 1, Action: "approve"})
			return err
		},
		"DecideCreativeVariant": func(a Actor) error {
			_, err := repo.DecideCreativeVariant(ctx, a, "variant", CreativeApprovalInput{Status: "APPROVED"})
			return err
		},
		"ApproveLaunchSpec": func(a Actor) error { _, err := repo.ApproveLaunchSpec(ctx, a, "spec"); return err },
		"ApproveLaunchPlan": func(a Actor) error { _, err := repo.ApproveLaunchPlan(ctx, a, "plan"); return err },
		"ScheduleAnnouncement": func(a Actor) error {
			_, err := repo.ScheduleAnnouncement(ctx, a, ScheduleAnnouncementInput{IdempotencyKey: "k", ReleaseDocumentID: "d"})
			return err
		},
		"CancelAnnouncement": func(a Actor) error { _, err := repo.CancelAnnouncement(ctx, a, "announcement"); return err },
		"TransitionCampaign": func(a Actor) error {
			_, err := repo.TransitionCampaign(ctx, a, "campaign", "APPROVED")
			return err
		},
		"ApproveCampaignAsset": func(a Actor) error { _, err := repo.ApproveCampaignAsset(ctx, a, "campaign", "asset"); return err },
		"ApproveCampaignDesign": func(a Actor) error {
			_, err := repo.ApproveCampaignDesign(ctx, a, "campaign", "design")
			return err
		},
	}
	for _, decision := range []string{"approve", "reject", "request_changes"} {
		entrypoints["TransitionCampaignPosts/"+decision] = func(a Actor) error {
			_, err := repo.TransitionCampaignPosts(ctx, a, "campaign", CampaignPostDecision{Decision: decision})
			return err
		}
	}
	for _, kind := range []string{"api_key", "support", "webhook", "service"} {
		actor := Actor{OrganizationID: "org", Kind: kind, KeyID: "key", GrantID: "grant", UserID: "user"}
		for name, call := range entrypoints {
			if err := call(actor); !errors.Is(err, publishing.ErrForbidden) {
				t.Errorf("%s as %s: err=%v, want ErrForbidden", name, kind, err)
			}
		}
	}
}

// Scheduling takes a publisher's session or a key with post:schedule (RFC
// 038), which the integration tests check. Every other principal is refused.
func TestSchedulingRefusesSupportWebhookAndServiceActors(t *testing.T) {
	ctx := context.Background()
	repo := &Configuration{}
	at := time.Now().Add(time.Hour)
	for _, kind := range []string{"support", "webhook", "service"} {
		actor := Actor{OrganizationID: "org", Kind: kind, GrantID: "grant", UserID: "user"}
		if _, err := repo.ScheduleCampaignPost(ctx, actor, "campaign", "post", ScheduleCampaignPostInput{ChannelConnectionID: "c"}); !errors.Is(err, publishing.ErrForbidden) {
			t.Errorf("ScheduleCampaignPost as %s: err=%v", kind, err)
		}
		if _, err := repo.CreateScheduledPost(ctx, actor, publishing.CreateScheduledPostInput{Caption: "Hi", IdempotencyKey: "k", ScheduledFor: at}); !errors.Is(err, publishing.ErrForbidden) {
			t.Errorf("CreateScheduledPost as %s: err=%v", kind, err)
		}
	}
}
