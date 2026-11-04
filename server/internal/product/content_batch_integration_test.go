package product

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

// Bulk scheduling (RFC 042): batches of 100 photos, 100 videos and a mix
// survive a reload, stage per-item captions, media, accounts and times,
// become one draft each, are checked per item and account, and schedule the
// valid selections without touching the rest; a corrected item schedules its
// remaining account without duplicating the posts already queued.
func TestContentBatches(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, owner := w.ctx, w.owner
	objects := &derivativeObjects{recordingAssetObjects: recordingAssetObjects{exists: true}, files: map[string][]byte{}}
	repo := w.repo.WithObjectStore(objects).WithMonthlyMeter(&recordingMonthlyMeter{})
	// Three full batches schedule more posts than a Business month allows.
	subscribe(t, ctx, repo, w.org, "enterprise")
	upload := func(name, mime string, body []byte) string {
		t.Helper()
		signed, err := repo.SignAssetUpload(ctx, owner, AssetUploadInput{Bytes: len(body), ContentType: mime, FileName: name})
		if err != nil {
			t.Fatal(err)
		}
		objects.files[signed.Asset.ObjectKey] = body
		if _, err := repo.CompleteAssetUpload(ctx, owner, signed.Asset.ID, nil); err != nil {
			t.Fatal(err)
		}
		return signed.Asset.ID
	}
	var photoBytes bytes.Buffer
	if err := jpeg.Encode(&photoBytes, image.NewRGBA(image.Rect(0, 0, 1080, 1080)), nil); err != nil {
		t.Fatal(err)
	}
	clip, err := os.ReadFile("../mediavideo/testdata/portrait.mp4")
	if err != nil {
		t.Fatal(err)
	}
	photos, videos := []string{}, []string{}
	for i := 0; i < 3; i++ {
		photos = append(photos, upload(fmt.Sprintf("photo-%d.jpg", i), "image/jpeg", photoBytes.Bytes()))
		videos = append(videos, upload(fmt.Sprintf("clip-%d.mp4", i), "video/mp4", clip))
	}
	addCredential := socialCredentialFixture(t, ctx, w.db.SQL, w.org)
	connect := func(platform string) string {
		t.Helper()
		addCredential(platform+"-"+w.id, platform)
		connection, err := repo.auth.CreateConnection(ctx, publishing.Actor{Organization: w.org, UserID: owner.UserID, RequestID: owner.RequestID, Type: "USER"},
			publishing.CreateConnectionInput{ExternalAccountID: platform + "-" + w.id, Platform: platform, ProviderSettings: map[string]any{}, SecretReference: "SOCIAL_API_KEY"})
		if err != nil {
			t.Fatal(err)
		}
		return connection.ID
	}
	linkedin, threads, x := connect("linkedin"), connect("threads"), connect("x")
	// The X account's verified subscription grants its video allowance.
	none := "None"
	caps := socialidentity.XVerifiedAccountLimits("read-write", &none)
	capabilities, _ := json.Marshal(socialidentity.Capabilities{Version: 1, X: &caps})
	w.exec(t, `UPDATE "Integration" SET "verifiedCapabilities"=$2 WHERE id=$1`, "x-"+w.id, string(capabilities))
	day := time.Now().AddDate(0, 0, 3).UTC().Format("2006-01-02")
	item := func(batch string, i int, media string) ContentBatchItemInput {
		return ContentBatchItemInput{
			ImportKey: fmt.Sprintf("%s-item-%04d-key", batch, i),
			Caption:   fmt.Sprintf("Post %d — «%s»\nsecond line #batch", i, batch),
			Media:     []schema.BatchMedia{{AssetID: media}}, ChannelConnectionIDs: []string{linkedin, threads},
			Timing: schema.BatchTiming{Mode: "time", TimeZone: "Europe/Paris", LocalTime: fmt.Sprintf("%sT%02d:%02d", day, 8+i/10, (i%10)*5)},
		}
	}
	build := func(name string, pick func(int) string) *ContentBatchRecord {
		t.Helper()
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: name})
		if err != nil {
			t.Fatal(err)
		}
		items := make([]ContentBatchItemInput, contentBatchItemLimit)
		for i := range items {
			items[i] = item(name, i, pick(i))
		}
		if batch, err = repo.AddContentBatchItems(ctx, owner, batch.ID, items); err != nil || len(batch.Items) != contentBatchItemLimit {
			t.Fatalf("%s: %v", name, err)
		}
		return batch
	}
	draftAll := func(batch *ContentBatchRecord) {
		t.Helper()
		for _, entry := range batch.Items {
			record, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, entry.ID, ContentDraftInput{Title: "Item", PlainText: entry.Caption})
			if err != nil || record.Draft == nil || record.Draft.PlainText != entry.Caption {
				t.Fatalf("draft for %d: %+v %v", entry.Position, record, err)
			}
		}
	}
	scheduleAll := func(batch *ContentBatchRecord) {
		t.Helper()
		reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range reloaded.Items {
			targets := []ContentDraftScheduleTarget{}
			for _, channel := range entry.ChannelConnectionIDs {
				targets = append(targets, ContentDraftScheduleTarget{ChannelConnectionID: channel, Caption: entry.Draft.PlainText, AssetIDs: entry.Draft.AssetIDs})
			}
			if _, err := repo.ScheduleContentDraft(ctx, owner, *entry.DraftID, ScheduleContentDraftInput{Version: entry.Draft.Version,
				LocalTime: entry.Timing.LocalTime, TimeZone: entry.Timing.TimeZone, Targets: targets}); err != nil {
				t.Fatalf("item %d: %v", entry.Position, err)
			}
		}
	}

	t.Run("a hundred photos, a hundred videos and a mixed batch become two hundred posts each", func(t *testing.T) {
		for name, pick := range map[string]func(int) string{
			"photos": func(i int) string { return photos[i%3] },
			"videos": func(i int) string { return videos[i%3] },
			"mixed":  func(i int) string { return [][]string{photos, videos}[i%2][i%3] },
		} {
			batch := build(name, pick)
			draftAll(batch)
			scheduleAll(batch)
			reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID)
			if err != nil {
				t.Fatal(err)
			}
			posts := 0
			for i, entry := range reloaded.Items {
				if entry.Position != i || entry.Draft == nil || len(entry.Posts) != 2 || entry.Media[0].Status != "UPLOADED" {
					t.Fatalf("%s item %d: %+v", name, i, entry)
				}
				zone, _ := time.LoadLocation("Europe/Paris")
				if got := entry.Posts[0].ScheduledFor.In(zone).Format("2006-01-02T15:04"); got != entry.Timing.LocalTime || *entry.Posts[0].ScheduleTimeZone != "Europe/Paris" {
					t.Fatalf("%s item %d at %s, want %s", name, i, got, entry.Timing.LocalTime)
				}
				posts += len(entry.Posts)
			}
			if posts != 2*contentBatchItemLimit {
				t.Fatalf("%s: %d posts", name, posts)
			}
		}
	})

	t.Run("a reload restores staged items, retries add nothing, and a reused key with other content is refused", func(t *testing.T) {
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Resumable"})
		if err != nil {
			t.Fatal(err)
		}
		pending := item("resume", 0, "")
		pending.Media = []schema.BatchMedia{{FileName: "launch.mov", Bytes: 2048}}
		uploaded := item("resume", 1, photos[0])
		if _, err := repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{pending, uploaded}); err != nil {
			t.Fatal(err)
		}
		again, err := repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{pending, uploaded})
		if err != nil || len(again.Items) != 2 {
			t.Fatalf("retry: %d items %v", len(again.Items), err)
		}
		changed := uploaded
		changed.Caption = "Something else"
		if _, err := repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{changed}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("reused key: %v", err)
		}
		reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID)
		if err != nil || reloaded.Items[0].Media[0].Status != "local" || reloaded.Items[0].Media[0].FileName != "launch.mov" || reloaded.Items[1].Media[0].Status != "UPLOADED" {
			t.Fatalf("reloaded: %+v %v", reloaded, err)
		}
		// A staged file keeps its size in the record, so the item can be saved back unchanged.
		if body, _ := json.Marshal(reloaded.Items[0].Media[0]); !strings.Contains(string(body), `"bytes":2048`) {
			t.Fatalf("staged media record = %s", body)
		}
		if reloaded.Items[0].Media[0].Status != "local" {
			t.Fatalf("reloaded: %+v %v", reloaded, err)
		}
		// An unfinished upload cannot become a draft; once it completes it can.
		if _, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentDraftInput{PlainText: "x"}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("draft with an unfinished upload: %v", err)
		}
		signed, err := repo.SignAssetUpload(ctx, owner, AssetUploadInput{Bytes: 2048, ContentType: "video/quicktime", FileName: "launch.mov"})
		if err != nil {
			t.Fatal(err)
		}
		media := []schema.BatchMedia{{FileName: "launch.mov", Bytes: 2048, UploadAssetID: signed.Asset.ID}}
		if _, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentBatchItemUpdate{Media: &media}); err != nil {
			t.Fatal(err)
		}
		// The page is closed mid-upload: the reload shows the reserved upload as still pending.
		if reloaded, err = repo.GetContentBatch(ctx, owner, batch.ID); err != nil || reloaded.Items[0].Media[0].Status != "PENDING" {
			t.Fatalf("interrupted upload: %+v %v", reloaded.Items[0].Media, err)
		}
		media = []schema.BatchMedia{{AssetID: videos[0]}}
		if _, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentBatchItemUpdate{Media: &media}); err != nil {
			t.Fatal(err)
		}
		first, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentDraftInput{PlainText: pending.Caption})
		if err != nil {
			t.Fatal(err)
		}
		second, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentDraftInput{PlainText: pending.Caption})
		if err != nil || *second.DraftID != *first.DraftID {
			t.Fatalf("draft retry: %v", err)
		}
		caption := "edited"
		if _, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, reloaded.Items[0].ID, ContentBatchItemUpdate{Caption: &caption}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("staged edit after drafting: %v", err)
		}
		// An attachment swapped in the composer is what the batch shows from then on.
		swapped := []string{photos[1]}
		if _, err := repo.UpdateContentDraft(ctx, owner, *first.DraftID, ContentDraftUpdate{BaseVersion: first.Draft.Version, AssetIDs: &swapped}); err != nil {
			t.Fatal(err)
		}
		if reloaded, err = repo.GetContentBatch(ctx, owner, batch.ID); err != nil || len(reloaded.Items[0].Media) != 1 ||
			reloaded.Items[0].Media[0].AssetID != photos[1] || reloaded.Items[0].Media[0].MediaType != "image/jpeg" || reloaded.Items[0].Media[0].Status != "UPLOADED" {
			t.Fatalf("drafted item media: %+v %v", reloaded.Items[0].Media, err)
		}
		over := make([]ContentBatchItemInput, contentBatchItemLimit-1)
		for i := range over {
			over[i] = item("over", i, photos[0])
		}
		if _, err := repo.AddContentBatchItems(ctx, owner, batch.ID, over); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("%d items: %v", contentBatchItemLimit+1, err)
		}
	})

	t.Run("a bulk update applies to every item or to none", func(t *testing.T) {
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Captions"})
		if err != nil {
			t.Fatal(err)
		}
		inputs := []ContentBatchItemInput{item("bulk", 0, photos[0]), item("bulk", 1, photos[0]), item("bulk", 2, photos[0])}
		if batch, err = repo.AddContentBatchItems(ctx, owner, batch.ID, inputs); err != nil {
			t.Fatal(err)
		}
		caption := func(text string) *string { return &text }
		patch := func(i int, text string) ContentBatchItemPatch {
			return ContentBatchItemPatch{ItemID: batch.Items[i].ID, ContentBatchItemUpdate: ContentBatchItemUpdate{Caption: caption(text)}}
		}
		refused := map[string][]ContentBatchItemPatch{
			"an item twice": {patch(0, "One"), patch(0, "Two")},
			"a bad time": {patch(0, "One"), {ItemID: batch.Items[1].ID, ContentBatchItemUpdate: ContentBatchItemUpdate{
				Caption: caption("Two"), Timing: &schema.BatchTiming{Mode: "time", LocalTime: "tomorrow", TimeZone: "UTC"}}}},
			"an unknown item": {patch(0, "One"), {ItemID: "cmissingitem0000000000000", ContentBatchItemUpdate: ContentBatchItemUpdate{Caption: caption("Two")}}},
		}
		for name, patches := range refused {
			if _, err := repo.UpdateContentBatchItems(ctx, owner, batch.ID, patches); err == nil {
				t.Fatalf("%s was accepted", name)
			}
			reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID)
			if err != nil {
				t.Fatal(err)
			}
			for i, entry := range reloaded.Items {
				if entry.Caption != inputs[i].Caption {
					t.Fatalf("%s left item %d as %q", name, i, entry.Caption)
				}
			}
		}
		updated, err := repo.UpdateContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemPatch{patch(2, "Three"), patch(0, "One")})
		if err != nil {
			t.Fatal(err)
		}
		if updated.Items[0].Caption != "One" || updated.Items[1].Caption != inputs[1].Caption || updated.Items[2].Caption != "Three" {
			t.Fatalf("bulk update: %+v", updated.Items)
		}
		// The name an item came from survives as given, for caption CSVs.
		named := item("bulk", 3, photos[0])
		named.SourceKey = "Été 2026 – trip"
		withName, err := repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{named})
		if err != nil || withName.Items[3].SourceKey != "Été 2026 – trip" {
			t.Fatalf("source key: %+v %v", withName, err)
		}
		// A saved item reads back alone, with its media and posts.
		one, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, batch.Items[1].ID, ContentBatchItemUpdate{Caption: caption("Two")})
		if err != nil || one.ID != batch.Items[1].ID || one.Caption != "Two" || one.Media[0].Status != "UPLOADED" {
			t.Fatalf("single update: %+v %v", one, err)
		}
	})

	t.Run("two people saving the same item at once get one draft, again after it is deleted", func(t *testing.T) {
		w.addMember(t, "editor", "creator")
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Shared"})
		if err != nil {
			t.Fatal(err)
		}
		if batch, err = repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{item("shared", 0, photos[0])}); err != nil {
			t.Fatal(err)
		}
		entry := batch.Items[0]
		saveAtOnce := func() string {
			t.Helper()
			var wg sync.WaitGroup
			results := make([]*ContentBatchItemRecord, 2)
			errs := make([]error, 2)
			for i, actor := range []Actor{owner, w.actor("editor")} {
				wg.Add(1)
				go func() {
					defer wg.Done()
					results[i], errs[i] = repo.CreateContentBatchItemDraft(ctx, actor, batch.ID, entry.ID, ContentDraftInput{Title: "Shared", PlainText: entry.Caption})
				}()
			}
			wg.Wait()
			if errs[0] != nil || errs[1] != nil || results[0].DraftID == nil || results[1].DraftID == nil || *results[0].DraftID != *results[1].DraftID {
				t.Fatalf("concurrent drafts: %v %v", errs, results)
			}
			var drafts int
			if err := w.db.SQL.QueryRowContext(ctx, `SELECT count(*) FROM content_draft WHERE "organizationId"=$1 AND title='Shared'`, w.org).Scan(&drafts); err != nil || drafts != 1 {
				t.Fatalf("%d drafts for one item: %v", drafts, err)
			}
			return *results[0].DraftID
		}
		first := saveAtOnce()
		// Deleting the unscheduled draft in Write leaves the item ready to save again.
		if err := repo.DeleteContentDraft(ctx, owner, first); err != nil {
			t.Fatal(err)
		}
		if reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID); err != nil || reloaded.Items[0].DraftID != nil {
			t.Fatalf("item after its draft was deleted: %+v %v", reloaded.Items[0], err)
		}
		if second := saveAtOnce(); second == first {
			t.Fatalf("the deleted draft %s came back", first)
		}
	})

	t.Run("an edit committed while the item is being saved is not lost", func(t *testing.T) {
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Edited"})
		if err != nil {
			t.Fatal(err)
		}
		if batch, err = repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{item("edited", 0, photos[0]), item("edited", 1, photos[1])}); err != nil {
			t.Fatal(err)
		}
		// Another person's account change is mid-commit, holding the item, when the save starts.
		entry := batch.Items[0]
		tx, err := w.db.SQL.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		var blocker int
		if err := tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&blocker); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE content_batch_item SET "channelConnectionIds"=$2::jsonb WHERE id=$1`, entry.ID, `["`+linkedin+`"]`); err != nil {
			t.Fatal(err)
		}
		type saved struct {
			record *ContentBatchItemRecord
			err    error
		}
		done := make(chan saved, 1)
		go func() {
			record, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, entry.ID, ContentDraftInput{Title: "Edited", PlainText: entry.Caption})
			done <- saved{record, err}
		}()
		for {
			var blocked bool
			if err := w.db.SQL.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
				t.Fatal(err)
			}
			if blocked {
				break
			}
			select {
			case result := <-done:
				t.Fatalf("save did not wait for the edit: %+v %v", result.record, result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(5 * time.Millisecond):
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		result := <-done
		if result.err != nil || result.record.Draft == nil || strings.Join(result.record.Draft.ChannelConnectionIDs, ",") != linkedin ||
			strings.Join(result.record.ChannelConnectionIDs, ",") != linkedin {
			t.Fatalf("draft saved over a concurrent edit: %+v %v", result.record, result.err)
		}
		// A save built from the caption before another person's edit is refused, and links nothing.
		other := batch.Items[1]
		newer := "Newer caption"
		if _, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, other.ID, ContentBatchItemUpdate{Caption: &newer}); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, other.ID, ContentDraftInput{Title: "Edited", PlainText: other.Caption}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("stale save: %v", err)
		}
		if reloaded, err := repo.GetContentBatch(ctx, owner, batch.ID); err != nil || reloaded.Items[1].DraftID != nil || reloaded.Items[1].Caption != newer {
			t.Fatalf("item after a stale save: %+v %v", reloaded.Items[1], err)
		}
		if record, err := repo.CreateContentBatchItemDraft(ctx, owner, batch.ID, other.ID, ContentDraftInput{Title: "Edited", PlainText: newer}); err != nil || record.Draft.PlainText != newer {
			t.Fatalf("save after reload: %+v %v", record, err)
		}
	})

	t.Run("each item and account is checked apart, and correcting one keeps the rest", func(t *testing.T) {
		batch, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Partial"})
		if err != nil {
			t.Fatal(err)
		}
		// A long video is fine on LinkedIn and Threads but not in an X caption this long.
		long := item("partial", 0, videos[0])
		long.ChannelConnectionIDs = []string{linkedin, x}
		long.Caption = strings.Repeat("a", 300)
		skipped := item("partial", 1, photos[0])
		november := time.Date(time.Now().Year()+1, time.November, 1, 0, 0, 0, 0, time.UTC)
		for november.Weekday() != time.Sunday {
			november = november.AddDate(0, 0, 1)
		}
		skipped.Timing = schema.BatchTiming{Mode: "time", TimeZone: "America/New_York", LocalTime: november.Format("2006-01-02") + "T01:30"}
		batch, err = repo.AddContentBatchItems(ctx, owner, batch.ID, []ContentBatchItemInput{long, skipped})
		if err != nil {
			t.Fatal(err)
		}
		draftAll(batch)
		batch, _ = repo.GetContentBatch(ctx, owner, batch.ID)
		rows := []BatchValidationRow{}
		for _, entry := range batch.Items {
			targets := []ContentDraftScheduleTarget{}
			for _, channel := range entry.ChannelConnectionIDs {
				targets = append(targets, ContentDraftScheduleTarget{ChannelConnectionID: channel, Caption: entry.Draft.PlainText, AssetIDs: entry.Draft.AssetIDs})
			}
			rows = append(rows, BatchValidationRow{ItemID: entry.ID, Version: entry.Draft.Version, Targets: targets})
		}
		results, err := repo.ValidateContentBatch(ctx, owner, batch.ID, rows)
		if err != nil || len(results) != 4 {
			t.Fatalf("results: %+v %v", results, err)
		}
		verdict := map[string]string{}
		for _, result := range results {
			verdict[result.ItemID+"/"+result.ChannelConnectionID] = result.Error
		}
		first, second := batch.Items[0], batch.Items[1]
		if verdict[first.ID+"/"+linkedin] != "" || !strings.Contains(verdict[first.ID+"/"+x], "X post exceeds") ||
			!strings.Contains(verdict[second.ID+"/"+linkedin], "happens twice") {
			t.Fatalf("verdicts: %v", verdict)
		}
		// The person schedules only the valid selection.
		scheduled, err := repo.ScheduleContentDraft(ctx, owner, *first.DraftID, ScheduleContentDraftInput{Version: first.Draft.Version,
			LocalTime: first.Timing.LocalTime, TimeZone: first.Timing.TimeZone,
			Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: linkedin, Caption: first.Draft.PlainText, AssetIDs: first.Draft.AssetIDs}}})
		if err != nil {
			t.Fatal(err)
		}
		// Correcting the X post adds it; the LinkedIn post is neither cancelled nor repeated.
		short := ContentDraftScheduleTarget{ChannelConnectionID: x, Caption: "Short enough for X", AssetIDs: first.Draft.AssetIDs}
		for attempt := 0; attempt < 2; attempt++ {
			if _, err := repo.ScheduleContentDraft(ctx, owner, *first.DraftID, ScheduleContentDraftInput{Version: scheduled.Draft.Version, Add: true,
				LocalTime: first.Timing.LocalTime, TimeZone: first.Timing.TimeZone, Targets: []ContentDraftScheduleTarget{short}}); err != nil {
				t.Fatalf("correction attempt %d: %v", attempt, err)
			}
		}
		statuses := []string{}
		for _, post := range w.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(*first.DraftID)).AllX(ctx) {
			statuses = append(statuses, string(post.Status))
		}
		if strings.Join(statuses, ",") != "SCHEDULED,SCHEDULED" {
			t.Fatalf("posts after correction: %v", statuses)
		}
		// Choosing the later 1:30 resolves the repeated hour.
		later := schema.BatchTiming{Mode: "time", TimeZone: "America/New_York", LocalTime: second.Timing.LocalTime, Disambiguation: "later"}
		if _, err := repo.UpdateContentBatchItem(ctx, owner, batch.ID, second.ID, ContentBatchItemUpdate{Timing: &later}); err != nil {
			t.Fatal(err)
		}
		results, err = repo.ValidateContentBatch(ctx, owner, batch.ID, rows[1:])
		if err != nil || !results[0].Valid || results[0].ScheduledFor.Hour() != 6 {
			t.Fatalf("resolved repeat: %+v %v", results, err)
		}
	})

	t.Run("another workspace and a private set cannot see the batch", func(t *testing.T) {
		batches, err := repo.ListContentBatches(ctx, owner)
		if err != nil || len(batches) < 4 {
			t.Fatalf("list: %d %v", len(batches), err)
		}
		// There is no free plan, so the stranger subscribes to reach the tenant check.
		stranger := newTestWorkspace(t)
		subscribe(t, ctx, repo, stranger.org, "pro")
		if _, err := repo.GetContentBatch(ctx, stranger.owner, batches[0].ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("other workspace: %v", err)
		}
		private, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Mine", Visibility: "PRIVATE"})
		if err != nil {
			t.Fatal(err)
		}
		secret, err := repo.CreateContentBatch(ctx, owner, ContentBatchInput{Title: "Private", SocialSetID: private.ID})
		if err != nil {
			t.Fatal(err)
		}
		w.addMember(t, "colleague", "admin")
		if _, err := repo.GetContentBatch(ctx, w.actor("colleague"), secret.ID); !errors.Is(err, publishing.ErrNotFound) {
			t.Fatalf("private set: %v", err)
		}
		if err := repo.ArchiveContentBatch(ctx, owner, secret.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := repo.AddContentBatchItems(ctx, owner, secret.ID, []ContentBatchItemInput{item("closed", 0, photos[0])}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("closed batch: %v", err)
		}
	})
}
