package product

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// Media scheduling (RFC 042): an upload records what it holds, each
// destination's media rules are checked before anything is queued, and a
// schedule is one idempotent operation per draft version, time and account.
func TestMediaScheduling(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, owner := w.ctx, w.owner
	meter := &recordingMonthlyMeter{}
	objects := &derivativeObjects{recordingAssetObjects: recordingAssetObjects{exists: true}, files: map[string][]byte{}}
	repo := w.repo.WithObjectStore(objects).WithMonthlyMeter(meter)
	subscribe(t, ctx, repo, w.org, "business")
	upload := func(name, mime string, body []byte) string {
		t.Helper()
		digest := fmt.Sprintf("%x", sha256.Sum256(body))
		signed, err := repo.SignAssetUpload(ctx, owner, AssetUploadInput{Bytes: len(body), ContentType: mime, FileName: name, SHA256: &digest})
		if err != nil {
			t.Fatal(err)
		}
		objects.files[signed.Asset.ObjectKey] = body
		if _, err := repo.CompleteAssetUpload(ctx, owner, signed.Asset.ID, &digest); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return signed.Asset.ID
	}
	read := func(name string) []byte {
		t.Helper()
		body, err := os.ReadFile("../mediavideo/testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	var photoBytes bytes.Buffer
	if err := jpeg.Encode(&photoBytes, image.NewRGBA(image.Rect(0, 0, 800, 1000)), nil); err != nil {
		t.Fatal(err)
	}
	photo := upload("photo.jpg", "image/jpeg", photoBytes.Bytes())
	video := upload("portrait.mp4", "video/mp4", read("portrait.mp4"))
	movie := upload("rotated.mov", "video/quicktime", read("rotated.mov"))

	t.Run("uploads record a video's length, display size and codecs", func(t *testing.T) {
		for id, want := range map[string]string{video: "240x426 4000ms avc1,mp4a", movie: "180x320 2500ms avc1"} {
			row := w.db.Client.Asset.GetX(ctx, id)
			got := fmt.Sprintf("%dx%d %dms %s", *row.Width, *row.Height, *row.DurationMs/100*100, *row.Codecs)
			if got != want {
				t.Fatalf("%s: %s, want %s", row.MediaType, got, want)
			}
		}
		// A renamed file is not a movie, and an incomplete one is refused.
		signed, err := repo.SignAssetUpload(ctx, owner, AssetUploadInput{Bytes: photoBytes.Len(), ContentType: "video/quicktime", FileName: "fake.mov"})
		if err != nil {
			t.Fatal(err)
		}
		objects.files[signed.Asset.ObjectKey] = photoBytes.Bytes()
		if _, err := repo.CompleteAssetUpload(ctx, owner, signed.Asset.ID, nil); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("renamed image accepted as a movie: %v", err)
		}
		if row := w.db.Client.Asset.GetX(ctx, signed.Asset.ID); row.Status != asset.StatusFAILED {
			t.Fatalf("refused upload status %s", row.Status)
		}
	})

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
	x, linkedin, threads, instagram, facebookInstagram := connect("x"), connect("linkedin"), connect("threads"), connect("instagram-standalone"), connect("instagram")
	draft := func(text string, assets ...string) *ContentDraftRecord {
		t.Helper()
		record, err := repo.CreateContentDraft(ctx, owner, ContentDraftInput{PlainText: text, Title: text, AssetIDs: assets})
		if err != nil {
			t.Fatal(err)
		}
		return record
	}
	at := time.Now().Add(3 * time.Hour).UTC().Truncate(time.Second)
	target := func(connection, caption string, assets ...string) ContentDraftScheduleTarget {
		return ContentDraftScheduleTarget{ChannelConnectionID: connection, Caption: caption, AssetIDs: assets}
	}
	schedule := func(d *ContentDraftRecord, input ScheduleContentDraftInput) (*ScheduleContentDraftResult, error) {
		if input.Version == 0 {
			input.Version = d.Version
		}
		if input.ScheduledFor.IsZero() && input.LocalTime == "" && !input.Queue {
			input.ScheduledFor = at
		}
		return repo.ScheduleContentDraft(ctx, owner, d.ID, input)
	}
	posts := func(draftID string) []string {
		t.Helper()
		rows, err := w.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID)).Order(scheduledpost.ByCreatedAt()).All(ctx)
		if err != nil {
			t.Fatal(err)
		}
		states := make([]string, len(rows))
		for i, row := range rows {
			states[i] = row.ChannelConnectionID + ":" + string(row.Status)
		}
		return states
	}

	t.Run("each destination's video rules are enforced with a reason", func(t *testing.T) {
		d := draft("Clip", video)
		if _, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(linkedin, "LinkedIn", movie)}}); err == nil || !strings.Contains(err.Error(), "Export it as MP4") {
			t.Fatalf("LinkedIn QuickTime err=%v", err)
		}
		if _, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(linkedin, "LinkedIn", photo, video)}}); err == nil || !strings.Contains(err.Error(), "on its own") {
			t.Fatalf("LinkedIn mixed err=%v", err)
		}
		if _, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(facebookInstagram, "Reel", video)}}); err == nil || !strings.Contains(err.Error(), "Instagram Login") {
			t.Fatalf("Facebook-login Instagram err=%v", err)
		}
		// One video post to three destinations; a mixed carousel where it is allowed.
		result, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{
			target(linkedin, "LinkedIn video", video), target(threads, "Threads video", movie), target(instagram, "Reel", video)}})
		if err != nil || len(result.Posts) != 3 {
			t.Fatalf("video schedule: %+v %v", result, err)
		}
		carousel := draft("Carousel", photo, movie)
		if _, err := schedule(carousel, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(threads, "Mixed", photo, movie)}}); err != nil {
			t.Fatalf("Threads mixed carousel: %v", err)
		}
		post := w.db.Client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(carousel.ID)).OnlyX(ctx)
		if strings.Join(post.AssetIds, ",") != photo+","+movie {
			t.Fatalf("attachment order %v", post.AssetIds)
		}
	})

	t.Run("a rotated photo is checked as it is shown, in preflight as in scheduling", func(t *testing.T) {
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 1080, 1500)), nil); err != nil {
			t.Fatal(err)
		}
		// EXIF orientation 6: stored 1080×1500, too tall for Instagram; shown 1500×1080.
		exif := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0}
		marker := []byte{0xff, 0xe1, 0, 0}
		binary.BigEndian.PutUint16(marker[2:], uint16(len(exif)+2))
		body := append(append(append(append([]byte{}, encoded.Bytes()[:2]...), marker...), exif...), encoded.Bytes()[2:]...)
		rotated := upload("rotated.jpg", "image/jpeg", body)
		d := draft("Rotated", rotated)
		input := ScheduleContentDraftInput{Version: d.Version, ScheduledFor: at, Targets: []ContentDraftScheduleTarget{target(instagram, "Rotated", rotated)}}
		if err := repo.ValidateContentDraftSchedule(ctx, owner, d.ID, input); err != nil {
			t.Fatalf("preflight: %v", err)
		}
		if _, err := schedule(d, input); err != nil {
			t.Fatalf("schedule: %v", err)
		}
	})

	t.Run("a video uploaded before lengths were recorded is read before scheduling", func(t *testing.T) {
		legacy := upload("legacy.mp4", "video/mp4", read("faststart.mp4"))
		w.exec(t, `UPDATE asset SET "durationMs"=NULL, codecs=NULL WHERE id=$1`, legacy)
		if _, err := schedule(draft("Legacy", legacy), ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(linkedin, "Legacy", legacy)}}); err != nil {
			t.Fatal(err)
		}
		if row := w.db.Client.Asset.GetX(ctx, legacy); row.DurationMs == nil || *row.DurationMs != 3000 {
			t.Fatalf("legacy length not recorded: %v", row.DurationMs)
		}
	})

	t.Run("adding a destination keeps the queued ones and charges only the new one", func(t *testing.T) {
		d := draft("Partial", photo)
		first, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(x, "On X", photo)}})
		if err != nil {
			t.Fatal(err)
		}
		before := meter.used
		used := map[string]int64{}
		for key, value := range before {
			used[key] = value
		}
		added, err := schedule(d, ScheduleContentDraftInput{Add: true, Version: first.Draft.Version, Targets: []ContentDraftScheduleTarget{target(linkedin, "On LinkedIn", photo)}})
		if err != nil || !added.Created || len(added.Cancelled) != 0 {
			t.Fatalf("add: %+v %v", added, err)
		}
		if got := posts(d.ID); strings.Join(got, " ") != x+":SCHEDULED "+linkedin+":SCHEDULED" {
			t.Fatalf("posts after add: %v", got)
		}
		charged := int64(0)
		for key, value := range meter.used {
			charged += value - used[key]
		}
		if charged != 1 {
			t.Fatalf("add charged %d posts", charged)
		}
		if ids := w.db.Client.ContentDraft.GetX(ctx, d.ID).ChannelConnectionIds; len(ids) != 2 {
			t.Fatalf("draft channels %v", ids)
		}
		again, err := schedule(d, ScheduleContentDraftInput{Add: true, Version: added.Draft.Version, Targets: []ContentDraftScheduleTarget{target(x, "On X twice", photo)}})
		if err == nil || !strings.Contains(err.Error(), "already has a post") {
			t.Fatalf("second post on the same account: %+v %v", again, err)
		}
	})

	t.Run("a retry replays, a different time conflicts, and concurrent submits make one post", func(t *testing.T) {
		d := draft("Once", photo)
		input := ScheduleContentDraftInput{Version: d.Version, ScheduledFor: at, Targets: []ContentDraftScheduleTarget{target(x, "Once", photo), target(linkedin, "Once", photo)}}
		var wg sync.WaitGroup
		results := make([]*ScheduleContentDraftResult, 6)
		failures := make([]error, 6)
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i], failures[i] = repo.ScheduleContentDraft(ctx, owner, d.ID, input)
			}()
		}
		wg.Wait()
		created := 0
		for i, result := range results {
			if failures[i] != nil {
				t.Fatalf("concurrent submit %d: %v", i, failures[i])
			}
			if result.Created {
				created++
			}
		}
		if created != 1 || len(posts(d.ID)) != 2 {
			t.Fatalf("created=%d posts=%v", created, posts(d.ID))
		}
		later := input
		later.ScheduledFor = at.Add(time.Hour)
		if _, err := repo.ScheduleContentDraft(ctx, owner, d.ID, later); err == nil || !strings.Contains(err.Error(), "another time") {
			t.Fatalf("reused version with another time: %v", err)
		}
		// Identical content in a second draft waits for the member to confirm the repeat.
		twin := draft("Once", photo)
		var duplicate *DuplicateContentError
		if _, err := schedule(twin, ScheduleContentDraftInput{ScheduledFor: at, Targets: input.Targets}); !errors.As(err, &duplicate) || len(posts(twin.ID)) != 0 {
			t.Fatalf("unconfirmed second post with identical content: %v %v", err, posts(twin.ID))
		}
		if _, err := schedule(twin, ScheduleContentDraftInput{ScheduledFor: at, Targets: input.Targets, ConfirmDuplicate: true}); err != nil || len(posts(twin.ID)) != 2 {
			t.Fatalf("confirmed second post with identical content: %v %v", err, posts(twin.ID))
		}
	})

	t.Run("a local time keeps its zone and refuses skipped or repeated times", func(t *testing.T) {
		year := time.Now().Year() + 1
		d := draft("Zoned", photo)
		in := func(local, disambiguation string) ScheduleContentDraftInput {
			return ScheduleContentDraftInput{LocalTime: local, TimeZone: "America/New_York", Disambiguation: disambiguation, Targets: []ContentDraftScheduleTarget{target(x, "Zoned", photo)}}
		}
		sunday := func(month time.Month, nth int) time.Time {
			day := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC)
			for day.Weekday() != time.Sunday {
				day = day.AddDate(0, 0, 1)
			}
			return day.AddDate(0, 0, 7*(nth-1))
		}
		var clocks *LocalTimeError
		if _, err := schedule(d, in(sunday(time.March, 2).Format("2006-01-02")+"T02:30", "")); !errors.As(err, &clocks) || clocks.Kind != "gap" {
			t.Fatalf("spring gap: %v", err)
		}
		november := sunday(time.November, 1)
		repeated := november.Format("2006-01-02") + "T01:30"
		if _, err := schedule(d, in(repeated, "")); !errors.As(err, &clocks) || clocks.Kind != "ambiguous" {
			t.Fatalf("repeated hour: %v", err)
		}
		result, err := schedule(d, in(repeated, "later"))
		if err != nil {
			t.Fatal(err)
		}
		post := w.db.Client.ScheduledPost.GetX(ctx, result.Posts[0].ID)
		if *post.ScheduleTimeZone != "America/New_York" || !post.SlotAt.Equal(time.Date(year, time.November, november.Day(), 6, 30, 0, 0, time.UTC)) {
			t.Fatalf("zone=%v slot=%v", *post.ScheduleTimeZone, post.SlotAt)
		}
		// Editing the draft afterwards changes neither the queued post's time nor its state.
		title := "Edited later"
		if _, err := repo.UpdateContentDraft(ctx, owner, d.ID, ContentDraftUpdate{BaseVersion: result.Draft.Version, Title: &title}); err != nil {
			t.Fatal(err)
		}
		if after := w.db.Client.ScheduledPost.GetX(ctx, post.ID); !after.ScheduledFor.Equal(post.ScheduledFor) || after.Status != scheduledpost.StatusSCHEDULED || after.Caption != "Zoned" {
			t.Fatalf("edit changed the queued post: %+v", after)
		}
	})

	t.Run("Instagram and YouTube options follow the media, and a missing thumbnail never stops the video", func(t *testing.T) {
		youtube := connect("youtube")
		off, no := false, false
		reelOnly := ContentDraftScheduleTarget{ChannelConnectionID: instagram, Caption: "Trial", AssetIDs: []string{photo},
			Options: &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{TrialReel: true}}}
		if _, err := schedule(draft("Trial", photo), ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{reelOnly}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a trial on a photo: %v", err)
		}
		reel := draft("Options reel", video)
		result, err := schedule(reel, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: instagram, Caption: "Options reel", AssetIDs: []string{video},
			Options: &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{CoverAssetID: photo, ShareToFeed: &off, UserTags: []string{"brand"}}}}}})
		if err != nil {
			t.Fatal(err)
		}
		load := func(id string) publishing.PublishJob {
			t.Helper()
			w.exec(t, `UPDATE scheduled_post SET status='PROCESSING', "triggerRunId"='run-options' WHERE id=$1`, id)
			job, err := publishing.NewRepository(w.db.Client).LoadPublishJob(ctx, id, "run-options")
			if err != nil {
				t.Fatal(err)
			}
			return job
		}
		if job := load(result.Posts[0].ID); job.Cover == nil || job.Cover.AssetID != photo || job.Options.Instagram == nil || *job.Options.Instagram.ShareToFeed {
			t.Fatalf("reel job = %+v", job)
		}

		// A thumbnail over YouTube's 2 MB is refused before scheduling.
		noise := image.NewRGBA(image.Rect(0, 0, 1280, 720))
		if _, err := rand.Read(noise.Pix); err != nil {
			t.Fatal(err)
		}
		var big bytes.Buffer
		if err := png.Encode(&big, noise); err != nil {
			t.Fatal(err)
		}
		if big.Len() <= 2_097_152 {
			t.Fatalf("the fixture is %d bytes, not over 2 MB", big.Len())
		}
		large := upload("large.png", "image/png", big.Bytes())
		options := func(thumbnail string) *postoptions.PublishOptions {
			return &postoptions.PublishOptions{YouTube: &postoptions.YouTubeOptions{Title: "Launch", Privacy: "private", MadeForKids: &no,
				Tags: []string{"launch"}, ThumbnailAssetID: thumbnail}}
		}
		clip := draft("Options clip", video)
		if _, err := schedule(clip, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: youtube, Caption: "Options clip", AssetIDs: []string{video},
			Options: options(large)}}}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("an oversized thumbnail: %v", err)
		}
		scheduled, err := schedule(clip, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: youtube, Caption: "Options clip", AssetIDs: []string{video},
			Options: options(photo)}}})
		if err != nil {
			t.Fatal(err)
		}
		// The thumbnail is gone by the time the video goes out: the video still does.
		w.exec(t, `UPDATE asset SET status='DELETED' WHERE id=$1`, photo)
		t.Cleanup(func() { w.exec(t, `UPDATE asset SET status='UPLOADED' WHERE id=$1`, photo) })
		if job := load(scheduled.Posts[0].ID); !job.WorkspaceActive || job.Ineligible != "" || job.Cover != nil || len(job.Assets) != 1 {
			t.Fatalf("a missing thumbnail stopped the video: %+v", job)
		}
		w.exec(t, `UPDATE asset SET status='UPLOADED' WHERE id=$1`, photo)

		// A cover from another workspace is refused when the draft is saved.
		other := newTestWorkspace(t)
		foreign := "foreign-" + other.id
		other.exec(t, `INSERT INTO asset (id,"organizationId","objectKey","mediaType",bytes,status,width,height,"updatedAt") VALUES ($1,$2,$3,'image/jpeg',10,'UPLOADED',1080,1920,now())`,
			foreign, other.org, "org/"+other.org+"/input/"+foreign+"/1/a.jpg")
		versions := &draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{{Channel: "instagram", Mode: draftdoc.ModeSynced,
			Options: &draftdoc.VersionOptions{Instagram: &postoptions.InstagramOptions{CoverAssetID: foreign}}}}}
		current, err := repo.GetContentDraft(ctx, owner, reel.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.UpdateContentDraft(ctx, owner, reel.ID, ContentDraftUpdate{BaseVersion: current.Version, PlatformVersions: versions}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("another workspace's cover: %v", err)
		}
	})

	t.Run("an Instagram story is one image or video with no caption", func(t *testing.T) {
		story := func() *postoptions.PublishOptions {
			return &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{Placement: "story"}}
		}
		d := draft("Story day", photo)
		if _, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: instagram, Caption: "Story day",
			AssetIDs: []string{photo}, Options: story()}}}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("a story with a caption: %v", err)
		}
		if _, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: instagram,
			AssetIDs: []string{photo, video}, Options: story()}}}); err == nil {
			t.Fatal("a story of two files was scheduled")
		}
		result, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: instagram,
			AssetIDs: []string{photo}, Options: story()}}})
		if err != nil {
			t.Fatal(err)
		}
		post := w.db.Client.ScheduledPost.GetX(ctx, result.Posts[0].ID)
		if post.Caption != "" || post.PublishOptions.Instagram == nil || !post.PublishOptions.Instagram.Story() {
			t.Fatalf("story post = caption %q options %+v", post.Caption, post.PublishOptions.Instagram)
		}
		// Facebook Login accounts stay blocked, story or not.
		if _, err := schedule(draft("Story blocked", photo), ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{{ChannelConnectionID: facebookInstagram,
			AssetIDs: []string{photo}, Options: story()}}}); !errors.Is(err, publishing.ErrConflict) {
			t.Fatalf("a Facebook Login story: %v", err)
		}
	})

	t.Run("asking for changes after scheduling stops the queued post", func(t *testing.T) {
		required := true
		if _, err := repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &required}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			off := false
			_, _ = repo.UpdateContentDraftSettings(ctx, owner, ContentDraftSettingsUpdate{RequireApproval: &off})
		})
		d := draft("Reviewed", photo)
		if _, err := repo.ReviewContentDraft(ctx, owner, d.ID, ContentDraftReviewInput{Version: d.Version, Action: "approve"}); err != nil {
			t.Fatal(err)
		}
		result, err := schedule(d, ScheduleContentDraftInput{Targets: []ContentDraftScheduleTarget{target(x, "Reviewed", photo)}})
		if err != nil {
			t.Fatal(err)
		}
		// Adding a destination needs no new review: scheduling changed no content.
		if _, err := schedule(d, ScheduleContentDraftInput{Add: true, Version: result.Draft.Version, Targets: []ContentDraftScheduleTarget{target(linkedin, "Reviewed", photo)}}); err != nil {
			t.Fatalf("add after approval: %v", err)
		}
		load := func() publishing.PublishJob {
			t.Helper()
			w.exec(t, `UPDATE scheduled_post SET status='PROCESSING', "triggerRunId"='run-review' WHERE id=$1`, result.Posts[0].ID)
			job, err := publishing.NewRepository(w.db.Client).LoadPublishJob(ctx, result.Posts[0].ID, "run-review")
			if err != nil {
				t.Fatal(err)
			}
			return job
		}
		if !load().WorkspaceActive {
			t.Fatal("an approved post was held")
		}
		w.exec(t, `UPDATE scheduled_post SET status='SCHEDULED', "triggerRunId"=NULL WHERE id=$1`, result.Posts[0].ID)
		current, err := repo.GetContentDraft(ctx, owner, d.ID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := repo.ReviewContentDraft(ctx, owner, d.ID, ContentDraftReviewInput{Version: current.Version, Action: "changes", Note: "Not this week"}); err != nil {
			t.Fatal(err)
		}
		if claimed, err := repo.auth.Claim(ctx, result.Posts[0].ID, "after-rejection", time.Now().Add(24*time.Hour)); err != nil || claimed {
			t.Fatalf("a post whose approval was withdrawn was claimed: %v %v", claimed, err)
		}
	})
}
