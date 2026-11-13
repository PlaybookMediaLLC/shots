package product

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// transferFixture is a workspace with a set to move, and a destination its
// owner administers.
type transferFixture struct {
	*testWorkspace
	repo        *Configuration
	objects     *voiceObjects
	destination string
	arrived     Actor
}

func newTransferFixture(t *testing.T) *transferFixture {
	t.Helper()
	w := newTestWorkspace(t)
	objects := &voiceObjects{stored: map[string][]byte{}}
	f := &transferFixture{testWorkspace: w, repo: w.repo.WithObjectStore(objects), objects: objects, destination: "dest_" + w.id}
	subscribe(t, w.ctx, f.repo, w.org, "business")
	w.exec(t, `INSERT INTO organization (id,name,slug,"createdAt") VALUES ($1,'Destination',$1,now())`, f.destination)
	t.Cleanup(func() { _, _ = w.db.SQL.ExecContext(w.ctx, `DELETE FROM organization WHERE id=$1`, f.destination) })
	w.exec(t, `INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,'admin',now())`,
		"member_dest_"+w.id, f.destination, w.owner.UserID)
	w.exec(t, `INSERT INTO session (id,"expiresAt",token,"createdAt","updatedAt","userId","activeOrganizationId") VALUES ($1,now()+interval '1 hour',$1,now(),now(),$2,$3)`,
		"session_dest_"+w.id, w.owner.UserID, f.destination)
	subscribe(t, w.ctx, f.repo, f.destination, "business")
	f.arrived = Actor{OrganizationID: f.destination, UserID: w.owner.UserID, SessionID: "session_dest_" + w.id, RequestID: "arrived_" + w.id}
	return f
}

func (f *transferFixture) value(t *testing.T, query string, args ...any) string {
	t.Helper()
	var value string
	if err := f.db.SQL.QueryRowContext(f.ctx, query, args...).Scan(&value); err != nil {
		t.Fatalf("%v\n%s", err, query)
	}
	return value
}

// A set moves with its drafts, backups, comments, tags and files; its queued
// posts are cancelled; its accounts and published history stay behind.
func TestSocialSetMovesToAnotherWorkspace(t *testing.T) {
	f := newTransferFixture(t)
	ctx, owner, repo := f.ctx, f.owner, f.repo
	if _, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Stays"}); err != nil {
		t.Fatal(err)
	}
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Brand"})
	if err != nil {
		t.Fatal(err)
	}
	account := "cc_" + f.id
	f.exec(t, `INSERT INTO channel_connection(id,"organizationId",provider,"externalAccountId","secretReference","createdByUserId","updatedAt",platform,"socialSetId",status)
		VALUES($1,$2,'social',$1,'test-only',$3,now(),'x',$4,'ACTIVE')`, account, f.org, owner.UserID, set.ID)
	file := cuid.New()
	key := "org/" + f.org + "/input/" + file + "/1/launch.png"
	f.objects.stored[key] = []byte("png")
	f.exec(t, `INSERT INTO asset(id,"organizationId","objectKey","mediaType",bytes,status,width,height,"createdAt","updatedAt") VALUES($1,$2,$3,'image/png',3,'UPLOADED',1,1,now(),now())`,
		file, f.org, key)
	tag, err := repo.CreateContentDraftTag(ctx, owner, set.ID, ContentDraftTagInput{Name: ptr("Launch")})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Queued", SocialSetID: set.ID, PlainText: "first"})
	if err != nil {
		t.Fatal(err)
	}
	title := "Queued, edited"
	if _, err := repo.UpdateContentDraft(ctx, owner, queued.ID, ContentDraftUpdate{BaseVersion: 1, Title: &title}); err != nil {
		t.Fatal(err)
	}
	f.exec(t, `UPDATE content_draft SET "assetIds"=$2::jsonb, body=$3::jsonb, "tagIds"=$4::jsonb, discussions='{"threads":[{"id":"t1","comments":[{"id":"c1","text":"Ship it"}]}]}' WHERE id=$1`,
		queued.ID, `["`+file+`"]`, `[{"type":"img","assetId":"`+file+`","children":[{"text":""}]}]`, `["`+tag.ID+`"]`)
	published, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{Title: "Published", SocialSetID: set.ID})
	if err != nil {
		t.Fatal(err)
	}
	post := func(draft, status string) string {
		id := cuid.New()
		f.exec(t, `INSERT INTO scheduled_post(id,"organizationId","channelConnectionId","scheduledFor",caption,"idempotencyKey","updatedAt","socialSetId","contentDraftId",status)
			VALUES($1,$2,$3,now()+interval '1 day','post',$1,now(),$4,$5,$6)`, id, f.org, account, set.ID, draft, status)
		return id
	}
	queuedPost, livePost := post(queued.ID, "SCHEDULED"), post(published.ID, "PUBLISHED")

	// A notification about the draft, read in the source workspace.
	event, delivery := cuid.New(), cuid.New()
	f.exec(t, `INSERT INTO outbox_event(id,"organizationId",type,"aggregateType","aggregateId",payload,"idempotencyKey",notification_version,notification_fanned) VALUES($1,$2,'activity.post.published','content_draft',$3,'{}',$1,1,true)`,
		event, f.org, queued.ID)
	f.exec(t, `INSERT INTO platform_notification_delivery(id,"organizationId",event_id,kind,channel,destination,status) VALUES($1,$2,$3,'post.published','in_app',$4,'SUCCEEDED')`,
		delivery, f.org, event, owner.UserID)
	inbox := notifications.New(f.db.SQL, f.db.Client)
	reader := notifications.Principal{OrganizationID: f.org, UserID: owner.UserID, SessionID: owner.SessionID}
	if target, err := inbox.Resolve(ctx, reader, delivery); err != nil || target == "" {
		t.Fatalf("control: the notification opens %q: %v", target, err)
	}

	preview, err := repo.PreviewSocialSetTransfer(ctx, owner, set.ID)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Blocked != "" || len(preview.Destinations) != 1 || preview.Destinations[0].OrganizationID != f.destination ||
		preview.Drafts != 2 || preview.QueuedPosts != 1 || preview.PublishedPosts != 1 || len(preview.Accounts) != 1 ||
		preview.MediaFiles != 1 || preview.MediaBytes != 3 {
		t.Fatalf("preview=%+v", preview)
	}
	move := SocialSetTransferInput{DestinationOrganizationID: f.destination, Version: preview.Version}

	// Refusals change nothing.
	if _, err := repo.TransferSocialSet(ctx, owner, set.ID, SocialSetTransferInput{DestinationOrganizationID: f.destination, Version: preview.Version + 1}); err == nil ||
		!strings.Contains(err.Error(), "changed since you previewed") {
		t.Fatalf("stale version: %v", err)
	}
	key2 := Actor{OrganizationID: f.org, Kind: "api_key", KeyID: "key_" + f.id}
	if _, err := repo.TransferSocialSet(ctx, key2, set.ID, move); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("a key moved a set: %v", err)
	}
	f.exec(t, `UPDATE member SET role='creator' WHERE id=$1`, "member_dest_"+f.id)
	if _, err := repo.TransferSocialSet(ctx, owner, set.ID, move); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatalf("moved into a workspace the person does not administer: %v", err)
	}
	if preview, err := repo.PreviewSocialSetTransfer(ctx, owner, set.ID); err != nil || len(preview.Destinations) != 0 ||
		!strings.Contains(preview.NoDestination, "not an owner or admin of another workspace") {
		t.Fatalf("no destination: %+v %v", preview, err)
	}
	f.exec(t, `UPDATE member SET role='admin' WHERE id=$1`, "member_dest_"+f.id)
	f.exec(t, `UPDATE scheduled_post SET status='PROCESSING' WHERE id=$1`, livePost)
	if _, err := repo.TransferSocialSet(ctx, owner, set.ID, move); err == nil || !strings.Contains(err.Error(), "publishing") {
		t.Fatalf("moved while publishing: %v", err)
	}
	f.exec(t, `UPDATE scheduled_post SET status='PUBLISHED' WHERE id=$1`, livePost)
	if got := f.value(t, `SELECT "organizationId" FROM social_set WHERE id=$1`, set.ID); got != f.org {
		t.Fatalf("a refused move changed the set: %s", got)
	}

	result, err := repo.TransferSocialSet(ctx, owner, set.ID, move)
	if err != nil {
		t.Fatal(err)
	}
	if result.SocialSetID != set.ID || result.MovedDrafts != 2 || len(result.CancelledPostIDs) != 1 || result.CancelledPostIDs[0] != queuedPost {
		t.Fatalf("result=%+v", result)
	}
	// The set, its drafts, backups, comments and tags are the destination's now.
	for query, want := range map[string]string{
		`SELECT "organizationId"||':'||version FROM social_set WHERE id=$1`:                                                                                       f.destination + ":" + strconv.Itoa(preview.Version+1),
		`SELECT count(*)::text FROM content_draft WHERE "socialSetId"=$1 AND "organizationId"=$2`:                                                                 "2",
		`SELECT count(*)::text FROM content_draft_tag WHERE "socialSetId"=$1 AND "organizationId"=$2`:                                                             "1",
		`SELECT count(*)::text FROM content_draft_revision r JOIN content_draft d ON d.id=r."contentDraftId" WHERE d."socialSetId"=$1 AND r."organizationId"<>$2`: "0",
	} {
		args := []any{set.ID, f.destination}
		if !strings.Contains(query, "$2") {
			args = args[:1]
		}
		if got := f.value(t, query, args...); got != want {
			t.Errorf("%s = %s, want %s", query, got, want)
		}
	}
	moved, err := repo.GetContentDraft(ctx, f.arrived, queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if moved.Title != "Queued, edited" || len(moved.TagIDs) != 1 || moved.TagIDs[0] != tag.ID || len(moved.AssetIDs) != 1 || moved.AssetIDs[0] == file ||
		!strings.Contains(string(encode(t, moved.Discussions)), "Ship it") || len(moved.ChannelConnectionIDs) != 0 {
		t.Fatalf("moved draft=%+v", moved)
	}
	// Its file is a copy in the destination's library; the source keeps its own.
	copyKey := f.value(t, `SELECT "objectKey" FROM asset WHERE id=$1 AND "organizationId"=$2`, moved.AssetIDs[0], f.destination)
	if !strings.HasPrefix(copyKey, "org/"+f.destination+"/") || string(f.objects.stored[copyKey]) != "png" ||
		!strings.Contains(string(encode(t, moved.Body)), moved.AssetIDs[0]) {
		t.Fatalf("copy %s body=%s", copyKey, encode(t, moved.Body))
	}
	if got := f.value(t, `SELECT "organizationId" FROM asset WHERE id=$1`, file); got != f.org {
		t.Fatalf("the source's file moved: %s", got)
	}
	if _, err := repo.GetContentDraft(ctx, owner, queued.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("the source still reads a moved draft: %v", err)
	}
	// The destination's history of the draft starts with its arrival.
	history, err := repo.ListContentDraftActivity(ctx, f.arrived, queued.ID, "")
	if err != nil || len(history.Items) != 1 || history.Items[0].Action != "product.content_draft_moved_in" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	// The account, the cancelled and published posts stay, with a copy of
	// their draft, in a deleted copy of the set.
	remnant := f.value(t, `SELECT "socialSetId" FROM channel_connection WHERE id=$1 AND "organizationId"=$2 AND status='DISABLED'`, account, f.org)
	if got := f.value(t, `SELECT name||':'||("deletedAt" IS NOT NULL) FROM social_set WHERE id=$1 AND "organizationId"=$2`, remnant, f.org); got != "Brand:true" {
		t.Fatalf("remnant=%s", got)
	}
	for _, id := range []string{queuedPost, livePost} {
		got := f.value(t, `SELECT p.status||':'||p."socialSetId"||':'||d."organizationId" FROM scheduled_post p JOIN content_draft d ON d.id=p."contentDraftId" WHERE p.id=$1 AND p."organizationId"=$2`, id, f.org)
		want := map[string]string{queuedPost: "CANCELLED", livePost: "PUBLISHED"}[id] + ":" + remnant + ":" + f.org
		if got != want {
			t.Errorf("post %s = %s, want %s", id, got, want)
		}
	}
	for org, action := range map[string]string{f.org: "product.social_set_moved_out", f.destination: "product.social_set_moved_in"} {
		if got := f.value(t, `SELECT count(*)::text FROM audit_log WHERE "organizationId"=$1 AND action=$2 AND "entityId"=$3`, org, action, set.ID); got != "1" {
			t.Errorf("%s audit %s = %s", org, action, got)
		}
	}
	// The source's notification about a moved draft opens nothing.
	if target, err := inbox.Resolve(ctx, reader, delivery); err != nil || target != "" {
		t.Fatalf("a moved draft's notification opens %q: %v", target, err)
	}
	// A repeat finds nothing to move: the set is in one workspace.
	if _, err := repo.TransferSocialSet(ctx, owner, set.ID, move); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("a repeated move: %v", err)
	}
}

// Moves raced at one version move a set once, and the source keeps a shared set.
func TestSocialSetMoveRacesMoveItOnce(t *testing.T) {
	f := newTransferFixture(t)
	ctx, owner, repo := f.ctx, f.owner, f.repo
	shared, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Shared"})
	if err != nil {
		t.Fatal(err)
	}
	if preview, err := repo.PreviewSocialSetTransfer(ctx, owner, shared.ID); err != nil || !strings.Contains(preview.Blocked, "at least one shared profile") {
		t.Fatalf("the only shared set: %+v %v", preview, err)
	}
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Raced"})
	if err != nil {
		t.Fatal(err)
	}
	move := SocialSetTransferInput{DestinationOrganizationID: f.destination, Version: set.Version}
	var wait sync.WaitGroup
	errs := make([]error, 4)
	for index := range errs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, errs[index] = repo.TransferSocialSet(ctx, owner, set.ID, move)
		}()
	}
	wait.Wait()
	succeeded := 0
	for _, err := range errs {
		if err == nil {
			succeeded++
		} else if !errors.Is(err, publishing.ErrNotFound) && !errors.Is(err, publishing.ErrConflict) {
			t.Errorf("a raced move failed oddly: %v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d moves succeeded: %v", succeeded, errs)
	}
	if got := f.value(t, `SELECT count(*)::text FROM social_set WHERE name='Raced' AND "organizationId"=$1 AND "deletedAt" IS NOT NULL`, f.org); got != "1" {
		t.Fatalf("remnants=%s", got)
	}
	if got := f.value(t, `SELECT "organizationId" FROM social_set WHERE id=$1`, set.ID); got != f.destination {
		t.Fatalf("set is in %s", got)
	}
}

func encode(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
