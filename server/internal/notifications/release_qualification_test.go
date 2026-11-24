package notifications

import (
	"context"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/lucsky/cuid"
)

func TestQualificationActivityReachesOnlyNamedMembersOnce(t *testing.T) {
	f := notificationFixture(t)
	ctx := context.Background()
	id := cuid.New()
	execFixture(t, f, `INSERT INTO release(id,"organizationId",title,"benefitStatement","updatedAt") VALUES($1,$2,'Release','Useful',now())`, id, f.owner.OrganizationID)
	// The unrelated campaign owner must not inherit this factual-review handoff.
	execFixture(t, f, `UPDATE campaign SET "releaseId"=$2 WHERE id=$1`, f.campaign, id)
	tx, err := f.s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = emitSQL(ctx, tx, f.owner.OrganizationID, "release.qualification_changed", "release", id, "", map[string]any{"recipientUserIds": []string{f.creator.UserID, "foreign-user"}, "state": "NEEDS_FACTS"}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = f.s.Process(ctx); err != nil {
			t.Fatal(err)
		}
	}
	var fanout bool
	var count, succeeded, skipped int
	var first, last string
	if err = f.s.DB.QueryRow(`SELECT e.notification_fanned, count(d.id),count(d.id) FILTER(WHERE d.channel='in_app' AND d.status='SUCCEEDED'),count(d.id) FILTER(WHERE d.channel IN ('email','slack_dm') AND d.status='SKIPPED'),coalesce(min(d.destination),''),coalesce(max(d.destination),'') FROM outbox_event e LEFT JOIN platform_notification_delivery d ON d.event_id=e.id WHERE e."organizationId"=$1 AND e."aggregateId"=$2 AND e.type='activity.release.qualification_changed' GROUP BY e.id`, f.owner.OrganizationID, id).Scan(&fanout, &count, &succeeded, &skipped, &first, &last); err != nil || !fanout || count != 3 || succeeded != 1 || skipped != 2 || first != f.creator.UserID || last != f.creator.UserID {
		t.Fatalf("fanout=%v receipts=%d succeeded=%d skipped=%d recipients=%s..%s err=%v", fanout, count, succeeded, skipped, first, last, err)
	}
	if got := href("release", id, nil); got != "/releases/"+id {
		t.Fatalf("review destination=%s", got)
	}
	definition, known := activity.Lookup("release.qualification_changed")
	if !known || !definition.Restricted || definition.EmailDefault {
		t.Fatalf("unsafe activity catalogue entry: %+v", definition)
	}
	if _, known := activity.Lookup("release.qualification_invented"); known {
		t.Fatal("unknown activity was admitted")
	}
}
