package product

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

// From approved copy to a scheduled post: approve a design render, schedule
// it on a matching channel, reschedule after a cancel, and keep approved copy
// from changing in place.
func TestCampaignPublishing(t *testing.T) {
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
	var name string
	if err := db.SQL.QueryRowContext(ctx, `SELECT current_database()`).Scan(&name); err != nil || !strings.Contains(name, "test") {
		t.Fatalf("refusing database %q: %v", name, err)
	}
	id := cuid.New()
	org, other := "org_"+id, "other_"+id
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.SQL.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("%v\n%s", err, query)
		}
	}
	meter := &recordingMonthlyMeter{}
	repo := NewConfiguration(db.Client).WithMonthlyMeter(meter)
	actors := map[string]Actor{}
	for _, organization := range []string{org, other} {
		userID := "user_" + organization
		exec(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Owner',$2,true,now(),now())`, userID, organization+"@example.test")
		exec(`INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,$1,$1,now())`, organization)
		exec(`INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
			"session_"+organization, userID, organization)
		exec(`INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'owner',now())`, "member_"+organization, organization, userID)
		actors[organization] = Actor{OrganizationID: organization, UserID: userID, SessionID: "session_" + organization, RequestID: "request_" + id}
		subscribe(t, ctx, repo, organization, "pro")
	}
	t.Cleanup(func() {
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM organization WHERE id=$1 OR id=$2`, org, other)
		_, _ = db.SQL.ExecContext(ctx, `DELETE FROM "user" WHERE id=$1 OR id=$2`, "user_"+org, "user_"+other)
	})
	owner, foreign := actors[org], actors[other]
	expect := func(err, kind error, what string) {
		t.Helper()
		if !errors.Is(err, kind) {
			t.Fatalf("%s: got %v, want %v", what, err, kind)
		}
	}

	releaseID := "release_" + id
	exec(`INSERT INTO release (id,"organizationId",title,"benefitStatement","updatedAt") VALUES ($1,$2,'Launch','Faster',now())`, releaseID, org)
	campaignA, campaignB, campaignC := "campaign_a_"+id, "campaign_b_"+id, "campaign_c_"+id
	exec(`INSERT INTO campaign (id,"organizationId",name,objective,"releaseId","updatedAt") VALUES ($1,$3,'A','Adoption',$4,now()),($2,$3,'B','Adoption',$4,now())`, campaignA, campaignB, org, releaseID)
	exec(`INSERT INTO campaign (id,"organizationId",name,objective,"updatedAt") VALUES ($1,$2,'No release','Adoption',now())`, campaignC, org)
	render, rerender, renderB, renderC := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, asset := range []string{render, rerender, renderB, renderC} {
		exec(`INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,width,height,status,"createdAt","updatedAt") VALUES ($1,$2,$3,'image/png',1,1600,900,'UPLOADED',now(),now())`,
			asset, org, "org/"+org+"/render/"+asset+".png")
	}
	hero, unrendered, designB, designC := "hero_"+id, "blank_"+id, "design_b_"+id, "design_c_"+id
	exec(`INSERT INTO design (id,"organizationId","campaignId",name,document,"renderedAssetId","updatedAt") VALUES ($1,$5,$6,'Hero','{"version":1}',$7,now()),($2,$5,$6,'Blank','{"version":1}',NULL,now()),($3,$5,$8,'B','{"version":1}',$9,now()),($4,$5,$10,'C','{"version":1}',$11,now())`,
		hero, unrendered, designB, designC, org, campaignA, render, campaignB, renderB, campaignC, renderC)
	linkedin, x, published := "post_li_"+id, "post_x_"+id, "post_pub_"+id
	calendarSet, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Campaign publishing"})
	if err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO campaign_post (id,"organizationId","campaignId",channel,copy,status,"updatedAt") VALUES ($1,$4,$5,'linkedin','Ship faster','READY_FOR_REVIEW',now()),($2,$4,$5,'x','Ship faster','READY_FOR_REVIEW',now()),($3,$4,$5,'linkedin','Shipped','PUBLISHED',now())`,
		linkedin, x, published, org, campaignA)
	connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: "li-" + id, Platform: "linkedin", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY", SocialSetID: &calendarSet.ID})
	if err != nil {
		t.Fatal(err)
	}

	// Approval records who approved the copy and when.
	if _, err := repo.TransitionCampaignPosts(ctx, owner, campaignA, CampaignPostDecision{Decision: "approve", PostIDs: []string{linkedin, x}}); err != nil {
		t.Fatal(err)
	}
	approvedPost, err := db.Client.CampaignPost.Get(ctx, linkedin)
	if err != nil || approvedPost.ApprovedAt == nil || approvedPost.ApprovedByUserID == nil || *approvedPost.ApprovedByUserID != owner.UserID {
		t.Fatalf("approved post=%+v err=%v", approvedPost, err)
	}

	// A design render becomes one approved variant, however often it is approved.
	approved, err := repo.ApproveCampaignDesign(ctx, owner, campaignA, hero)
	if err != nil || approved.Variant.Status != "APPROVED" || approved.Approval.Status != "APPROVED" ||
		approved.Variant.DesignID == nil || *approved.Variant.DesignID != hero || approved.Variant.SourceAssetID != render ||
		approved.Variant.AspectRatio != "16:9" || approved.Variant.BrandKitID != nil || approved.Variant.TemplateVersion != nil {
		t.Fatalf("design approval=%+v err=%v", approved, err)
	}
	variant := approved.Variant.ID
	again, err := repo.ApproveCampaignDesign(ctx, owner, campaignA, hero)
	if err != nil || again.Variant.ID != variant {
		t.Fatalf("repeat approval=%+v err=%v", again, err)
	}
	if n, err := db.Client.CreativeVariant.Query().Where(creativevariant.DesignID(hero)).Count(ctx); err != nil || n != 1 {
		t.Fatalf("variants per render=%d err=%v", n, err)
	}
	if n, err := db.Client.AuditLog.Query().Where(auditlog.OrganizationID(org), auditlog.Action("product.creative_variant_approved")).Count(ctx); err != nil || n != 1 {
		t.Fatalf("approval audits=%d err=%v", n, err)
	}
	_, err = repo.ApproveCampaignDesign(ctx, owner, campaignA, unrendered)
	expect(err, publishing.ErrConflict, "unrendered design approved")
	_, err = repo.ApproveCampaignDesign(ctx, owner, campaignC, designC)
	expect(err, publishing.ErrConflict, "design without a release approved")
	_, err = repo.ApproveCampaignDesign(ctx, foreign, campaignA, hero)
	expect(err, publishing.ErrNotFound, "foreign design approved")
	_, err = repo.ApproveCampaignDesign(ctx, owner, campaignB, hero)
	expect(err, publishing.ErrNotFound, "design approved through another campaign")

	// A re-render is a new image; the approved one stays as it was.
	exec(`UPDATE design SET "renderedAssetId"=$1 WHERE id=$2`, rerender, hero)
	designs, err := repo.ListCampaignDesigns(ctx, owner, campaignA)
	if err != nil || len(designs) != 2 {
		t.Fatalf("designs=%+v err=%v", designs, err)
	}
	for _, listed := range designs {
		switch listed.ID {
		case hero:
			if listed.ApprovedVariant == nil || listed.ApprovedVariant.ID != variant || listed.ApprovedVariant.SourceAssetID != render ||
				listed.RenderedAssetID == nil || *listed.RenderedAssetID == listed.ApprovedVariant.SourceAssetID {
				t.Fatalf("hero should show changed since approval: %+v", listed)
			}
		case unrendered:
			if listed.ApprovedVariant != nil {
				t.Fatalf("unrendered design has an approved variant: %+v", listed.ApprovedVariant)
			}
		}
	}

	at := time.Now().Add(2 * time.Hour)
	schedule := func(post string, variant *string) (*ScheduleCampaignPostResult, error) {
		return repo.ScheduleCampaignPost(ctx, owner, campaignA, post, ScheduleCampaignPostInput{
			ChannelConnectionID: connection.ID, CreativeVariantID: variant, ScheduledAt: &at})
	}
	otherCampaign, err := repo.ApproveCampaignDesign(ctx, owner, campaignB, designB)
	if err != nil {
		t.Fatal(err)
	}
	_, err = schedule(linkedin, &otherCampaign.Variant.ID)
	expect(err, publishing.ErrNotFound, "another campaign's variant scheduled")
	_, err = schedule(linkedin, nil)
	expect(err, publishing.ErrConflict, "post without a visual scheduled")
	_, err = schedule(x, &variant)
	expect(err, publishing.ErrConflict, "x post scheduled on a LinkedIn channel")

	first, err := schedule(linkedin, &variant)
	if err != nil || first.Post.Status != "SCHEDULED" || first.Post.CreativeVariantID == nil || *first.Post.CreativeVariantID != variant ||
		first.Post.ScheduledPostStatus == nil || *first.Post.ScheduledPostStatus != "SCHEDULED" {
		t.Fatalf("schedule=%+v err=%v", first, err)
	}
	firstID := first.ScheduledPost.ID
	// The workspace calendar includes authorized campaign commitments and
	// retains their campaign identity instead of inventing a draft id.
	calendar, err := repo.ListContentDraftPostsBetween(ctx, owner, at.Add(-time.Hour), at.Add(time.Hour), "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range calendar {
		if entry.ID == firstID {
			found = true
			if entry.CampaignID == nil || *entry.CampaignID != campaignA || entry.DraftID != "" {
				t.Fatalf("campaign identity lost: %+v", entry)
			}
		}
	}
	if !found {
		t.Fatal("scheduled campaign missing from calendar")
	}

	// The publish worker reads a design variant like any other.
	exec(`UPDATE scheduled_post SET status='PROCESSING',"triggerRunId"=$2 WHERE id=$1`, firstID, "run_"+id)
	job, err := repo.auth.LoadPublishJob(ctx, firstID, "run_"+id)
	if err != nil || !job.WorkspaceActive || job.AssetObjectKey != "org/"+org+"/render/"+render+".png" {
		t.Fatalf("publish job=%+v err=%v", job, err)
	}
	exec(`UPDATE scheduled_post SET status='SCHEDULED',"triggerRunId"=NULL WHERE id=$1`, firstID)

	edit := func(post, before string) error {
		t.Helper()
		tx, err := db.Client.Tx(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		quote := func(copy string) json.RawMessage {
			encoded, _ := json.Marshal(map[string]string{"copy": copy})
			return encoded
		}
		if _, _, err := applyLaunchChange(ctx, tx, owner, &ent.CampaignRevision{CampaignID: campaignA},
			revisionChange{TargetType: "post", TargetID: post, Before: quote(before), After: quote("Ship even faster")}, nil); err != nil {
			return err
		}
		return tx.Commit()
	}
	expect(edit(linkedin, "Ship faster"), publishing.ErrConflict, "live scheduled post edited")
	manual := "Ship even faster"
	_, err = repo.UpdateCampaignPost(ctx, owner, campaignA, linkedin, UpdateCampaignPostInput{ExpectedCopy: &first.Post.Copy, Copy: &manual})
	expect(err, publishing.ErrConflict, "live scheduled post edited by hand")
	expect(edit(published, "Shipped"), publishing.ErrConflict, "published post edited")

	// Cancel, then schedule again under a new idempotency key.
	if _, err := repo.auth.CancelScheduledPost(ctx, publishing.Actor{Organization: org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"}, firstID); err != nil {
		t.Fatal(err)
	}
	detail, err := repo.GetCampaign(ctx, owner, campaignA)
	if err != nil {
		t.Fatal(err)
	}
	for _, post := range detail.Posts {
		if post.ID == linkedin && (post.ScheduledPostStatus == nil || *post.ScheduledPostStatus != "CANCELLED" || post.ApprovedAt == nil) {
			t.Fatalf("cancelled post=%+v", post)
		}
	}
	// An agent's key reschedules it only with post:schedule, and only approved
	// copy: the key never approves (RFC 026).
	scheduler, reader, pending := "key_schedule_"+id, "key_read_"+id, "post_pending_"+id
	for key, permissions := range map[string]string{scheduler: `{"post":["schedule"]}`, reader: `{"artifact":["read"],"release":["create"]}`} {
		exec(`INSERT INTO apikey (id,"referenceId",key,enabled,permissions,"createdAt","updatedAt") VALUES ($1,$2,$1,true,$3,now(),now())`, key, org, permissions)
	}
	exec(`INSERT INTO campaign_post (id,"organizationId","campaignId",channel,copy,status,"updatedAt") VALUES ($1,$2,$3,'linkedin','Not yet','READY_FOR_REVIEW',now())`, pending, org, campaignA)
	agent := func(key, post string) (*ScheduleCampaignPostResult, error) {
		return repo.ScheduleCampaignPost(ctx, Actor{Kind: "api_key", KeyID: key, OrganizationID: org, Display: "Coding agent", RequestID: "agent_" + id},
			campaignA, post, ScheduleCampaignPostInput{ChannelConnectionID: connection.ID, ScheduledAt: &at})
	}
	_, err = agent(reader, linkedin)
	expect(err, publishing.ErrForbidden, "key without post:schedule scheduled")
	_, err = agent(scheduler, pending)
	expect(err, publishing.ErrConflict, "key scheduled copy no one approved")
	second, err := agent(scheduler, linkedin)
	if err != nil {
		t.Fatal(err)
	}
	if n, err := db.Client.AuditLog.Query().Where(auditlog.OrganizationID(org), auditlog.Action("product.campaign_post_scheduled"),
		auditlog.ActorTypeEQ(auditlog.ActorTypeSERVICE), auditlog.ActorDisplay("Coding agent"), auditlog.RequestID("agent_"+id)).Count(ctx); err != nil || n != 1 {
		t.Fatalf("agent schedule audits=%d err=%v", n, err)
	}
	if err != nil || second.ScheduledPost.ID == firstID || second.ScheduledPost.IdempotencyKey != "campaign-post:"+linkedin+":"+firstID ||
		second.Post.ScheduledPostID == nil || *second.Post.ScheduledPostID != second.ScheduledPost.ID {
		t.Fatalf("reschedule=%+v err=%v", second, err)
	}
	if retried, err := schedule(linkedin, nil); err != nil || retried.ScheduledPost.ID != second.ScheduledPost.ID {
		t.Fatalf("retried reschedule=%+v err=%v", retried, err)
	}

	// A post that may have reached the channel is never scheduled twice.
	exec(`UPDATE scheduled_post SET status='UNKNOWN_DELIVERY' WHERE id=$1`, second.ScheduledPost.ID)
	_, err = schedule(linkedin, nil)
	expect(err, publishing.ErrConflict, "unknown delivery rescheduled")
	expect(edit(linkedin, "Ship faster"), publishing.ErrConflict, "unknown delivery edited")

	// Edits send approved copy back to draft.
	exec(`UPDATE scheduled_post SET status='FAILED' WHERE id=$1`, second.ScheduledPost.ID)
	if err := edit(linkedin, "Ship faster"); err != nil {
		t.Fatal(err)
	}
	if err := edit(x, "Ship faster"); err != nil {
		t.Fatal(err)
	}
	for _, post := range []string{linkedin, x} {
		row, err := db.Client.CampaignPost.Get(ctx, post)
		if err != nil || row.Status != campaignpost.StatusDRAFT || row.ScheduledPostID != nil || row.ApprovedAt != nil ||
			row.ApprovedByUserID != nil || row.Copy != "Ship even faster" {
			t.Fatalf("edited post=%+v err=%v", row, err)
		}
	}

	// The same key schedules an approved variant directly, charged once. It sends
	// only copy a person approved, so the edits above took that away.
	key := func(id string) Actor {
		return Actor{Kind: "api_key", KeyID: id, OrganizationID: org, Display: "Coding agent", RequestID: "agent_" + id}
	}
	direct := publishing.CreateScheduledPostInput{Caption: "Ship even faster", ChannelConnectionID: connection.ID,
		IdempotencyKey: "agent-" + id, ScheduledFor: at, VariantID: variant}
	_, err = repo.CreateScheduledPost(ctx, key(reader), direct)
	expect(err, publishing.ErrForbidden, "key without post:schedule created a scheduled post")
	draft := direct
	draft.VariantID, draft.ContentDraftID = "", "draft_"+id
	_, err = repo.CreateScheduledPost(ctx, key(scheduler), draft)
	expect(err, publishing.ErrForbidden, "key scheduled a content draft")
	_, err = repo.CreateScheduledPost(ctx, key(scheduler), direct)
	expect(err, publishing.ErrForbidden, "key sent edited copy no one approved")
	old := direct
	old.Caption = "Ship faster"
	_, err = repo.CreateScheduledPost(ctx, key(scheduler), old)
	expect(err, publishing.ErrForbidden, "key sent copy whose approval the edit withdrew")
	exec(`UPDATE campaign_post SET status='APPROVED', "approvedAt"=now(), "approvedByUserId"=$1 WHERE id=$2`, owner.UserID, x)
	before := meter.used[monthlyMeterKey(QuotaPosts, org, time.Now().UTC())]
	created, err := repo.CreateScheduledPost(ctx, key(scheduler), direct)
	if err != nil || !created.Created {
		t.Fatalf("created=%+v err=%v", created, err)
	}
	if by := created.Post.ScheduledByUserID; by == nil || *by != "api-key:"+scheduler {
		t.Fatalf("a key's post records scheduledBy=%v, want the key", by)
	}
	replayed, err := repo.CreateScheduledPost(ctx, key(scheduler), direct)
	if err != nil || replayed.Created || replayed.Post.ID != created.Post.ID {
		t.Fatalf("replayed=%+v err=%v", replayed, err)
	}
	if used := meter.used[monthlyMeterKey(QuotaPosts, org, time.Now().UTC())] - before; used != 1 {
		t.Fatalf("posts charged=%d, want 1", used)
	}
}
