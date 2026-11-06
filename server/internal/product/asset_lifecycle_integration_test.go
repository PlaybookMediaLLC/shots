package product

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

// Simultaneous uploads reserve storage one at a time: with room for one file,
// exactly one of many concurrent reservations succeeds.
func TestConcurrentUploadsCannotExceedStorage(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	repo := w.repo.WithObjectStore(&recordingAssetObjects{exists: true})
	// Fill the Pro plan's storage to ten bytes short, in rows the int column can hold.
	room := storageLimits["pro"] - 10
	for i := 0; room > 0; i++ {
		bytes := min(room, 2_000_000_000)
		w.exec(t, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,"updatedAt") VALUES ($1,$2,$3,'video/mp4',$4,'UPLOADED',now())`,
			fmt.Sprintf("filler-%d-%s", i, w.id), w.org, fmt.Sprintf("org/%s/input/filler-%d/1/f.mp4", w.org, i), bytes)
		room -= bytes
	}
	var wg sync.WaitGroup
	results := make([]error, 8)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, results[i] = repo.SignAssetUpload(w.ctx, w.owner, AssetUploadInput{Bytes: 6, ContentType: "image/png", FileName: fmt.Sprintf("p%d.png", i)})
		}()
	}
	wg.Wait()
	admitted := 0
	for _, err := range results {
		switch {
		case err == nil:
			admitted++
		case !errors.Is(err, ErrStorageQuota):
			t.Fatal(err)
		}
	}
	if admitted != 1 {
		t.Fatalf("%d reservations admitted with room for one", admitted)
	}
}

// Deleting an asset waits for everything that still needs it: an unarchived
// draft, a post that has not finished, and a bulk batch item.
func TestDeletingAnAssetKeepsMediaThatIsStillNeeded(t *testing.T) {
	w := newTestWorkspace(t)
	subscribe(t, w.ctx, w.repo, w.org, "business")
	repo := w.repo.WithObjectStore(&recordingAssetObjects{exists: true}).WithMonthlyMeter(&recordingMonthlyMeter{})
	uploaded := func(name string) string {
		id := uuid.NewString()
		w.exec(t, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,width,height,"updatedAt") VALUES ($1,$2,$3,'image/png',10,'UPLOADED',800,800,now())`,
			id, w.org, "org/"+w.org+"/input/"+id+"/1/a.png")
		return id
	}
	inDraft, inPost, inBatch, free := uploaded("draft"), uploaded("post"), uploaded("batch"), uploaded("free")
	draft, err := repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Uses it", PlainText: "Uses it", AssetIDs: []string{inDraft}})
	if err != nil {
		t.Fatal(err)
	}
	addCredential := socialCredentialFixture(t, w.ctx, w.db.SQL, w.org)
	addCredential("li-"+w.id, "linkedin")
	connection, err := repo.auth.CreateConnection(w.ctx, publishing.Actor{Organization: w.org, UserID: w.owner.UserID, RequestID: w.owner.RequestID, Type: "USER"},
		publishing.CreateConnectionInput{ExternalAccountID: "li-" + w.id, Platform: "linkedin", ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
	if err != nil {
		t.Fatal(err)
	}
	queued, err := repo.CreateContentDraft(w.ctx, w.owner, ContentDraftInput{Title: "Queued", PlainText: "Queued", AssetIDs: []string{inPost}})
	if err != nil {
		t.Fatal(err)
	}
	scheduled, err := repo.ScheduleContentDraft(w.ctx, w.owner, queued.ID, ScheduleContentDraftInput{Version: queued.Version, ScheduledFor: time.Now().Add(time.Hour),
		Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: connection.ID, Caption: "Queued", AssetIDs: []string{inPost}}}})
	if err != nil {
		t.Fatal(err)
	}
	// The draft that queued the post is archived: the post alone keeps the media.
	archived := "archived"
	if _, err := repo.UpdateContentDraft(w.ctx, w.owner, queued.ID, ContentDraftUpdate{BaseVersion: scheduled.Draft.Version, Status: &archived}); err != nil {
		t.Fatal(err)
	}
	set, err := repo.defaultSocialSet(w.ctx, w.org)
	if err != nil {
		t.Fatal(err)
	}
	w.exec(t, `INSERT INTO content_batch (id,"organizationId","socialSetId",title) VALUES ($1,$2,$3,'Batch')`, "batch-"+w.id, w.org, set.ID)
	w.exec(t, `INSERT INTO content_batch_item (id,"batchId","organizationId","importKey",fingerprint,position,media) VALUES ($1,$2,$3,'retention-import-key','f',0,jsonb_build_array(jsonb_build_object('assetId',$4::text)))`,
		"item-"+w.id, "batch-"+w.id, w.org, inBatch)
	for name, id := range map[string]string{"draft": inDraft, "queued post": inPost, "batch": inBatch} {
		if result, err := repo.DeleteAsset(w.ctx, w.owner, id); err != nil || result != AssetInUse {
			t.Fatalf("%s: %s %v", name, result, err)
		}
	}
	// A poster is listed only on its video, and is deleted with it.
	poster := "poster-" + w.id
	w.exec(t, `INSERT INTO asset (id,"organizationId","parentAssetId","objectKey","mediaType",bytes,status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,'image/jpeg',1,'UPLOADED',now(),now())`,
		poster, w.org, free, "org/"+w.org+"/poster/"+poster+"/1/poster.jpg")
	library, err := repo.ListAssets(w.ctx, w.owner, AssetListOptions{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range library.Assets {
		if item.ID == poster {
			t.Fatal("a poster was listed as its own asset")
		}
		if item.ID == free {
			found = item.PosterAssetID == poster
		}
	}
	if !found {
		t.Fatalf("the video does not name its poster: %+v", library.Assets)
	}
	if result, err := repo.DeleteAsset(w.ctx, w.owner, free); err != nil || result != AssetDeleted {
		t.Fatalf("unused asset: %s %v", result, err)
	}
	if row := w.db.Client.Asset.GetX(w.ctx, poster); row.Status != asset.StatusDELETED {
		t.Fatalf("poster status %s after deleting its video", row.Status)
	}
	// Once the post is published and the draft no longer shows it, it can go.
	w.exec(t, `UPDATE scheduled_post SET status='PUBLISHED' WHERE id=$1`, scheduled.Posts[0].ID)
	if result, err := repo.DeleteAsset(w.ctx, w.owner, inPost); err != nil || result != AssetDeleted {
		t.Fatalf("published media: %s %v", result, err)
	}
	if row := w.db.Client.Asset.GetX(w.ctx, inDraft); row.Status != asset.StatusUPLOADED {
		t.Fatalf("draft media status %s", row.Status)
	}
	_ = draft
}
