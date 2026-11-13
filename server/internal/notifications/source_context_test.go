package notifications

import (
	"context"
	"testing"

	"github.com/lucsky/cuid"
)

func TestNotificationSourceSurvivesMoveAndRedactsLostSourceAccess(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	setID, draftID, eventID := queueDraftNotification(t, f, "")
	var captured string
	if err := f.s.DB.QueryRow(`SELECT notification_social_set_id FROM outbox_event WHERE id=$1`, eventID).Scan(&captured); err != nil || captured != setID {
		t.Fatalf("event did not retain its source: %q %v", captured, err)
	}
	otherSet := cuid.New()
	execFixture(t, f, `INSERT INTO social_set(id,"organizationId",name,"publicSlug") VALUES($1,$2,'Queued brand',$1)`, otherSet, f.owner.OrganizationID)
	execFixture(t, f, `UPDATE content_draft SET "socialSetId"=$2 WHERE id=$1`, draftID, otherSet)
	page, err := f.s.ListFeed(ctx, f.creator, "activity", "")
	if err != nil || len(page.Items) != 1 || page.Items[0].SourceSocialSet == nil || page.Items[0].SourceSocialSet.ID != setID || page.Items[0].SourceSocialSet.Name != "Queued brand" {
		t.Fatalf("same-name destination replaced original source: %+v %v", page, err)
	}
	receipt := page.Items[0].ID
	execFixture(t, f, `UPDATE social_set SET name='Renamed source' WHERE id=$1`, setID)
	page, err = f.s.ListFeed(ctx, f.creator, "activity", "")
	if err != nil || page.Items[0].SourceSocialSet.Name != "Renamed source" {
		t.Fatal("source label did not use current authorized name", err)
	}
	// Source attribution is immutable even though its display name is live.
	if _, err = f.s.DB.Exec(`UPDATE outbox_event SET notification_social_set_id=$2 WHERE id=$1`, eventID, otherSet); err == nil {
		t.Fatal("event source was rewritten")
	}
	execFixture(t, f, `UPDATE social_set SET visibility='PRIVATE',"ownerUserId"=$2 WHERE id=$1`, setID, f.owner.UserID)
	if allowed, _, err := f.s.resource(ctx, f.creator.OrganizationID, f.creator.UserID, "content_draft", draftID); err != nil || !allowed {
		t.Fatal("control: destination draft should remain readable", err)
	}
	page, err = f.s.ListFeed(ctx, f.creator, "activity", "")
	if err != nil || len(page.Items) != 1 || page.Items[0].SourceSocialSet != nil || page.Items[0].Description != "This activity is no longer available." || page.Items[0].Href != "" {
		t.Fatalf("old source leaked through moved draft: %+v %v", page, err)
	}
	if target, err := f.s.Resolve(ctx, f.creator, receipt); err != nil || target != "" {
		t.Fatalf("old source receipt resolved through moved draft: %q %v", target, err)
	}
	var sends int
	f.s.Send = func(context.Context, Delivery, Envelope) (Outcome, error) {
		sends++
		return Outcome{Status: "SUCCEEDED"}, nil
	}
	if err := f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	if sends != 0 {
		t.Fatal("moving a resource bypassed queued source authority")
	}
	assertDeliveryOutcome(t, f, eventID, "email", "SKIPPED", "ACCESS_REMOVED", 1)
}

func TestNotificationEventCapturesSourceBeforeProjection(t *testing.T) {
	f := notificationFixture(t)
	t.Setenv("RESEND_API_KEY", "")
	ctx := context.Background()
	setID, draftID, _ := queueDraftNotification(t, f, "")
	// The next event is emitted with a real resource association, then the draft
	// moves before the worker projects it. Projection must use event-time source.
	tx, err := f.s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := emitSQL(ctx, tx, f.owner.OrganizationID, "member.mentioned", "content_draft", draftID, f.owner.UserID, map[string]any{"mentionedUserIds": []string{f.creator.UserID}}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	otherSet := cuid.New()
	execFixture(t, f, `INSERT INTO social_set(id,"organizationId",name,"publicSlug") VALUES($1,$2,'Destination',$1)`, otherSet, f.owner.OrganizationID)
	execFixture(t, f, `UPDATE content_draft SET "socialSetId"=$2 WHERE id=$1`, draftID, otherSet)
	if err := f.s.Process(ctx); err != nil {
		t.Fatal(err)
	}
	page, err := f.s.ListFeed(ctx, f.creator, "inbox", "")
	if err != nil || len(page.Items) != 1 || page.Items[0].Kind != "member.mentioned" || page.Items[0].SourceSocialSet == nil || page.Items[0].SourceSocialSet.ID != setID {
		t.Fatalf("late projection lost source: %+v %v", page, err)
	}
	for _, id := range []string{setID, cuid.New()} {
		if _, allowed, err := sourceSocialSet(ctx, f.s.DB, f.otherOrg, f.creator.UserID, id); err != nil || allowed {
			t.Fatal("foreign or missing source was authorized", err)
		}
	}
	execFixture(t, f, `UPDATE social_set SET "deletedAt"=now() WHERE id=$1`, setID)
	page, err = f.s.ListFeed(ctx, f.creator, "inbox", "")
	if err != nil || page.Items[0].SourceSocialSet != nil || page.Items[0].Href != "" {
		t.Fatal("deleted original source disclosed after resource move", err)
	}
}

func TestPrivateConnectionActivityDoesNotBypassSetOwnership(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	setID, connection := cuid.New(), cuid.New()
	execFixture(t, f, `INSERT INTO social_set(id,"organizationId",name,"publicSlug",visibility,"ownerUserId") VALUES($1,$2,'Private identity',$1,'PRIVATE',$3)`, setID, f.owner.OrganizationID, f.creator.UserID)
	execFixture(t, f, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","displayName","createdByUserId","socialSetId","secretReference","updatedAt") VALUES($1,$2,'social',$1,'Private account',$3,$4,'test-only',now())`, connection, f.owner.OrganizationID, f.creator.UserID, setID)
	if allowed, _, err := f.s.resource(ctx, f.owner.OrganizationID, f.owner.UserID, "channel_connection", connection); err != nil || allowed {
		t.Fatal("workspace owner could read another member's private connection event", err)
	}
	if allowed, _, err := f.s.resource(ctx, f.creator.OrganizationID, f.creator.UserID, "channel_connection", connection); err != nil || !allowed {
		t.Fatal("private owner could not read own connection event", err)
	}
	if private, err := f.s.privateEvent(ctx, occurrence{org: f.owner.OrganizationID, resourceType: "channel_connection", resourceID: connection}); err != nil || !private {
		t.Fatal("private connection was eligible for shared Slack", err)
	}
	execFixture(t, f, `UPDATE social_set SET "deletedAt"=now() WHERE id=$1`, setID)
	if allowed, _, err := f.s.resource(ctx, f.creator.OrganizationID, f.creator.UserID, "channel_connection", connection); err != nil || allowed {
		t.Fatal("deleted set retained connection activity access", err)
	}
}

// A notification opened after its resource changed resolves to nothing: the
// link is rechecked against the reader's current access, kind by kind.
func TestStaleNotificationsResolveToNothing(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	org := f.owner.OrganizationID
	// notify records an in-app notification about a resource for the reader.
	notify := func(reader Principal, kind, resourceID string) string {
		event, delivery := cuid.New(), cuid.New()
		execFixture(t, f, `INSERT INTO outbox_event(id,"organizationId",type,"aggregateType","aggregateId",payload,"idempotencyKey",notification_version,notification_fanned) VALUES($1,$2,'activity.test',$3,$4,'{}',$1,1,true)`, event, org, kind, resourceID)
		execFixture(t, f, `INSERT INTO platform_notification_delivery(id,"organizationId",event_id,kind,channel,destination,status) VALUES($1,$2,$3,'test','in_app',$4,'SUCCEEDED')`, delivery, org, event, reader.UserID)
		return delivery
	}
	resolves := func(reader Principal, delivery string) string {
		t.Helper()
		target, err := f.s.Resolve(ctx, reader, delivery)
		if err != nil {
			t.Fatal(err)
		}
		return target
	}
	setID, connection, draft, post := cuid.New(), cuid.New(), cuid.New(), cuid.New()
	execFixture(t, f, `INSERT INTO social_set(id,"organizationId",name,"publicSlug") VALUES($1,$2,'Shared brand',$1)`, setID, org)
	execFixture(t, f, `INSERT INTO content_draft(id,"organizationId",title,body,"plainText","assetIds","channelConnectionIds","createdByUserId","socialSetId") VALUES($1,$2,'Post draft','{}','','[]','[]',$3,$4)`, draft, org, f.owner.UserID, setID)
	execFixture(t, f, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt","socialSetId") VALUES($1,$2,'social',$1,'test-only',$3,now(),$4)`, connection, org, f.owner.UserID, setID)
	execFixture(t, f, `INSERT INTO scheduled_post(id,"organizationId","channelConnectionId","scheduledFor",caption,"idempotencyKey","updatedAt","socialSetId","contentDraftId") VALUES($1,$2,$3,now(),'post',$1,now(),$4,$5)`, post, org, connection, setID, draft)
	invitation := cuid.New()
	execFixture(t, f, `INSERT INTO invitation(id,"organizationId",email,"inviterId","expiresAt") VALUES($1,$2,'invitee@example.test',$3,now()+interval '1 day')`, invitation, org, f.owner.UserID)
	var creatorMember string
	if err := f.s.DB.QueryRow(`SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2`, org, f.creator.UserID).Scan(&creatorMember); err != nil {
		t.Fatal(err)
	}
	execFixture(t, f, `UPDATE member SET role='admin' WHERE id=$1`, creatorMember)

	campaign := notify(f.creator, "campaign", f.campaign)
	posted := notify(f.creator, "scheduled_post", post)
	invited := notify(f.creator, "invitation", invitation)
	ownMembership := notify(f.creator, "member", creatorMember)
	workspace := notify(f.creator, "workspace", org)
	for delivery, want := range map[string]string{campaign: "/campaigns/" + f.campaign + "/copy", posted: "/publish/" + draft, invited: "/settings/members", ownMembership: "/settings/members", workspace: "/settings/members"} {
		if got := resolves(f.creator, delivery); got != want {
			t.Fatalf("control: %s resolved to %q, want %q", delivery, got, want)
		}
	}

	// The campaign is deleted, the post's set turns private to someone else,
	// and the reader is no longer an admin.
	execFixture(t, f, `DELETE FROM campaign WHERE id=$1`, f.campaign)
	execFixture(t, f, `UPDATE social_set SET visibility='PRIVATE',"ownerUserId"=$2 WHERE id=$1`, setID, f.owner.UserID)
	execFixture(t, f, `UPDATE member SET role='creator' WHERE id=$1`, creatorMember)
	for name, delivery := range map[string]string{"deleted campaign": campaign, "post in another person's private set": posted, "invitation after a downgrade": invited, "workspace settings after a downgrade": workspace} {
		if got := resolves(f.creator, delivery); got != "" {
			t.Errorf("%s resolved to %q", name, got)
		}
	}
	// A member still opens their own membership, and the owner still opens the post.
	if got := resolves(f.creator, ownMembership); got != "/settings/members" {
		t.Errorf("own membership resolved to %q", got)
	}
	if got := resolves(f.owner, notify(f.owner, "scheduled_post", post)); got == "" {
		t.Error("the set's owner lost the post")
	}
	// Once removed, nothing resolves for the former member.
	execFixture(t, f, `DELETE FROM member WHERE id=$1`, creatorMember)
	if got, err := f.s.Resolve(ctx, f.creator, ownMembership); err == nil && got != "" {
		t.Errorf("a removed member resolved %q", got)
	}
}
