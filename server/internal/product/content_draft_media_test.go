package product

import (
	"context"
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
)

func mediaRow(mime string, bytes, width, height, durationMs int) *ent.Asset {
	row := &ent.Asset{MediaType: mime, Bytes: bytes}
	if width > 0 {
		row.Width, row.Height = &width, &height
	}
	if durationMs > 0 {
		row.DurationMs = &durationMs
	}
	return row
}

// Each destination's published combinations, formats, sizes and lengths are
// refused with a reason, and supported ones pass, before anything is queued.
func TestDraftMediaFollowsEachDestination(t *testing.T) {
	photo := mediaRow("image/jpeg", 300_000, 1080, 1350, 0)
	png := mediaRow("image/png", 300_000, 1080, 1080, 0)
	gif := mediaRow("image/gif", 2_000_000, 480, 270, 0)
	mp4 := mediaRow("video/mp4", 20_000_000, 1080, 1920, 30_000)
	mov := mediaRow("video/quicktime", 20_000_000, 1080, 1920, 30_000)
	webm := mediaRow("video/webm", 20_000_000, 0, 0, 0)
	legacy := mediaRow("video/mp4", 20_000_000, 0, 0, 0)
	many := func(row *ent.Asset, n int) []*ent.Asset {
		rows := make([]*ent.Asset, n)
		for i := range rows {
			rows[i] = row
		}
		return rows
	}
	for _, tc := range []struct {
		name, channel string
		rows          []*ent.Asset
		refusal       string
	}{
		{"x four photos", "x", many(photo, 4), ""},
		{"x five photos", "x", many(photo, 5), "up to 4 attachments"},
		{"x photo and video", "x", []*ent.Asset{photo, mp4}, "on its own"},
		{"x gif alone", "x", []*ent.Asset{gif}, ""},
		{"x gif with photo", "x", []*ent.Asset{gif, photo}, "on its own"},
		{"x quicktime", "x", []*ent.Asset{mov}, "takes MP4 video"},
		{"linkedin twenty photos", "linkedin", many(photo, 20), ""},
		{"linkedin photos and gif", "linkedin", []*ent.Asset{photo, gif}, ""},
		{"linkedin short video", "linkedin", []*ent.Asset{mediaRow("video/mp4", 1_000_000, 720, 720, 2_000)}, "from 0:03 to 30:00"},
		{"linkedin long video", "linkedin", []*ent.Asset{mediaRow("video/mp4", 1_000_000, 720, 720, 1_800_001)}, "is 30:00"},
		{"linkedin quicktime", "linkedin", []*ent.Asset{mov}, "Export it as MP4"},
		{"linkedin unknown length", "linkedin", []*ent.Asset{legacy}, "couldn't read the length"},
		{"linkedin pdf attachment", "linkedin", []*ent.Asset{mediaRow("application/pdf", 1000, 0, 0, 0)}, "document option"},
		{"instagram empty", "instagram", nil, "needs at least one"},
		{"tiktok empty", "tiktok", nil, "needs one video"},
		{"instagram png is converted", "instagram", []*ent.Asset{png}, ""},
		{"instagram gif", "instagram", []*ent.Asset{gif}, "animation"},
		{"instagram narrow", "instagram", []*ent.Asset{mediaRow("image/jpeg", 1000, 300, 300, 0)}, "at least 320 pixels"},
		{"instagram tall", "instagram", []*ent.Asset{mediaRow("image/jpeg", 1000, 1000, 2000, 0)}, "Crop it"},
		{"instagram mixed carousel", "instagram", []*ent.Asset{photo, mov, png}, ""},
		{"instagram twenty-one", "instagram", many(photo, 21), "up to 20"},
		{"instagram short reel", "instagram", []*ent.Asset{mediaRow("video/mp4", 1000, 1080, 1920, 2_500)}, "from 0:03 to 15:00"},
		{"instagram large reel", "instagram", []*ent.Asset{mediaRow("video/mp4", 400_000_000, 1080, 1920, 30_000)}, "up to 300 MB"},
		{"threads mixed carousel", "threads", []*ent.Asset{photo, mp4}, ""},
		{"threads long video", "threads", []*ent.Asset{mediaRow("video/mp4", 1000, 1080, 1920, 300_001)}, "up to 5:00"},
		{"threads webm", "threads", []*ent.Asset{webm}, "MP4, MOV"},
		{"bluesky gif", "bluesky", []*ent.Asset{gif}, "animation"},
		{"bluesky photo and video", "bluesky", []*ent.Asset{photo, mp4}, "on its own"},
		{"mastodon webm without length", "mastodon", []*ent.Asset{webm}, ""},
		{"mastodon five photos", "mastodon", many(photo, 5), "up to 4"},
		{"mastodon large image", "mastodon", []*ent.Asset{mediaRow("image/png", 17_000_000, 100, 100, 0)}, "up to 16 MB"},
		{"mastodon audio", "mastodon", []*ent.Asset{mediaRow("audio/mpeg", 1000, 0, 0, 0)}, "can't publish audio/mpeg"},
		{"facebook text only", "facebook", nil, ""},
		{"facebook ten photos", "facebook", many(photo, 10), ""},
		{"facebook eleven photos", "facebook", many(photo, 11), "up to 10 attachments"},
		{"facebook photo and video", "facebook", []*ent.Asset{photo, mp4}, "on its own"},
		{"facebook quicktime", "facebook", []*ent.Asset{mov}, "takes MP4 video"},
		{"pinterest empty", "pinterest", nil, "Pinterest needs an image"},
		{"pinterest one photo", "pinterest", []*ent.Asset{photo}, ""},
		{"pinterest two photos", "pinterest", many(photo, 2), "up to 1 attachment"},
		{"pinterest video", "pinterest", []*ent.Asset{mp4}, "video"},
		{"google business text only", "gmb", nil, ""},
		{"google business one photo", "gmb", []*ent.Asset{photo}, ""},
		{"google business two photos", "gmb", many(photo, 2), "up to 1 attachment"},
		{"google business video", "gmb", []*ent.Asset{mp4}, "video"},
	} {
		err := checkDraftMedia(tc.channel, tc.rows)
		if tc.refusal == "" && err != nil || tc.refusal != "" && (err == nil || !strings.Contains(err.Error(), tc.refusal)) {
			t.Errorf("%s: err=%v, want %q", tc.name, err, tc.refusal)
		}
	}
}

func TestVideoDraftChannelsAcceptStandardPostsOnly(t *testing.T) {
	for _, channel := range []string{"tiktok", "youtube"} {
		if err := draftKindChannel("standard", channel); err != nil {
			t.Fatalf("%s standard draft: %v", channel, err)
		}
		for _, kind := range []string{"reply", "quote", "article"} {
			if err := draftKindChannel(kind, channel); err == nil {
				t.Fatalf("%s must reject %s", channel, kind)
			}
		}
	}
}

// Instagram's reel settings need one video, tags need a photo or a reel, and
// each cover follows its destination's published formats and size.
func TestOptionMediaFollowsEachDestination(t *testing.T) {
	photo := mediaRow("image/jpeg", 300_000, 1080, 1350, 0)
	reel := mediaRow("video/mp4", 20_000_000, 1080, 1920, 30_000)
	off := false
	ig := func(o postoptions.InstagramOptions) *postoptions.PublishOptions {
		return &postoptions.PublishOptions{Instagram: &o}
	}
	for _, tc := range []struct {
		name    string
		options *postoptions.PublishOptions
		rows    []*ent.Asset
		valid   bool
	}{
		{"grid choice on a reel", ig(postoptions.InstagramOptions{ShareToFeed: &off}), []*ent.Asset{reel}, true},
		{"grid choice on a photo", ig(postoptions.InstagramOptions{ShareToFeed: &off}), []*ent.Asset{photo}, false},
		{"trial on a carousel", ig(postoptions.InstagramOptions{TrialReel: true}), []*ent.Asset{reel, reel}, false},
		{"tags on a photo", ig(postoptions.InstagramOptions{UserTags: []string{"brand"}}), []*ent.Asset{photo}, true},
		{"tags on a carousel of videos", ig(postoptions.InstagramOptions{UserTags: []string{"brand"}}), []*ent.Asset{reel, reel}, false},
		{"collaborators on a carousel", ig(postoptions.InstagramOptions{Collaborators: []string{"partner"}}), []*ent.Asset{photo, reel}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkOptionMedia(context.Background(), nil, "org", "instagram", tc.options, tc.rows); (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
	for _, tc := range []struct {
		channel string
		cover   *ent.Asset
		valid   bool
	}{
		{"instagram", mediaRow("image/jpeg", 8_000_000, 1080, 1920, 0), true},
		{"instagram", mediaRow("image/png", 300_000, 1080, 1920, 0), false},
		{"instagram", mediaRow("image/jpeg", 8_000_001, 1080, 1920, 0), false},
		{"youtube", mediaRow("image/png", 2_097_152, 1280, 720, 0), true},
		{"youtube", mediaRow("image/png", 2_097_153, 1280, 720, 0), false},
		{"youtube", mediaRow("image/webp", 300_000, 1280, 720, 0), false},
		{"x", mediaRow("image/jpeg", 300_000, 1280, 720, 0), false},
	} {
		if err := checkCover(tc.channel, tc.cover); (err == nil) != tc.valid {
			t.Fatalf("%s %s %d bytes: valid=%v error=%v", tc.channel, tc.cover.MediaType, tc.cover.Bytes, tc.valid, err)
		}
	}
}

func TestAPinNeedsItsBoardOnlyWhenScheduled(t *testing.T) {
	// A draft saves while its pin has no board, or a link still being typed.
	if _, err := versionOptions("pinterest", &draftdoc.VersionOptions{Pinterest: &postoptions.PinterestOptions{Title: "Launch", Link: "shots.example"}}); err != nil {
		t.Fatalf("a pin being written did not save: %v", err)
	}
	if _, err := versionOptions("x", &draftdoc.VersionOptions{Pinterest: &postoptions.PinterestOptions{BoardID: "1"}}); err == nil {
		t.Fatal("a draft's X version stored Pinterest settings")
	}
	for _, options := range []*postoptions.PublishOptions{nil, {Pinterest: &postoptions.PinterestOptions{Title: "Launch"}},
		{Pinterest: &postoptions.PinterestOptions{BoardID: "1", Link: "shots.example"}}} {
		if checkPostOptions("pinterest", options, true) == nil {
			t.Fatalf("an incomplete pin was scheduled: %+v", options)
		}
	}
	if err := checkPostOptions("pinterest", &postoptions.PublishOptions{Pinterest: &postoptions.PinterestOptions{BoardID: "1", Link: "https://shots.example"}}, true); err != nil {
		t.Fatal(err)
	}
}

func TestInstagramOptionsBelongToInstagram(t *testing.T) {
	options := &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{Collaborators: []string{"partner"}}}
	if err := checkPostOptions("instagram", options, true); err != nil {
		t.Fatal(err)
	}
	if checkPostOptions("linkedin", options, true) == nil {
		t.Fatal("Instagram settings were accepted for LinkedIn")
	}
	bad := &postoptions.PublishOptions{Instagram: &postoptions.InstagramOptions{CoverAssetID: "../x"}}
	if checkPostOptions("instagram", bad, true) == nil {
		t.Fatal("a cover that is not an asset id was accepted")
	}
	if _, err := versionOptions("x", &draftdoc.VersionOptions{Instagram: &postoptions.InstagramOptions{UserTags: []string{"a"}}}); err == nil {
		t.Fatal("a draft's X version stored Instagram settings")
	}
	if _, err := versionOptions("instagram", &draftdoc.VersionOptions{Instagram: &postoptions.InstagramOptions{Collaborators: []string{"a", "b", "c", "d"}}}); err == nil {
		t.Fatal("a draft stored four collaborators")
	}
}

// A story is one image or video in its own limits: a 9:16 photo the feed
// refuses, a video up to a minute, never two files or a caption.
func TestStoriesFollowTheirOwnRules(t *testing.T) {
	portrait := mediaRow("image/jpeg", 300_000, 1080, 1920, 0)
	short := mediaRow("video/mp4", 20_000_000, 1080, 1920, 30_000)
	long := mediaRow("video/mp4", 20_000_000, 1080, 1920, 61_000)
	if checkDraftMedia("instagram", []*ent.Asset{portrait}) == nil {
		t.Fatal("the feed took a 9:16 photo")
	}
	for _, channel := range []string{"instagram", "facebook"} {
		for _, tc := range []struct {
			name  string
			rows  []*ent.Asset
			valid bool
		}{
			{"a 9:16 photo", []*ent.Asset{portrait}, true},
			{"a 30-second video", []*ent.Asset{short}, true},
			{"a 61-second video", []*ent.Asset{long}, false},
			{"two photos", []*ent.Asset{portrait, portrait}, false},
			{"a photo and a video", []*ent.Asset{portrait, short}, false},
			{"nothing", nil, false},
		} {
			if err := checkStoryMedia(channel, tc.rows); (err == nil) != tc.valid {
				t.Fatalf("%s %s: valid=%v error=%v", channel, tc.name, tc.valid, err)
			}
		}
	}
	if err := checkStoryMedia("instagram", []*ent.Asset{portrait, portrait}); err == nil || !strings.HasPrefix(err.Error(), "An Instagram story takes") {
		t.Fatalf("story wording: %v", err)
	}
	if err := checkStoryMedia("facebook", []*ent.Asset{mediaRow("video/quicktime", 1000, 1080, 1920, 30_000)}); err == nil || !strings.HasPrefix(err.Error(), "A Facebook story takes MP4") {
		t.Fatalf("a Facebook story took a MOV: %v", err)
	}
	if checkStoryMedia("x", []*ent.Asset{portrait}) == nil {
		t.Fatal("X took a story")
	}
	for channel, story := range map[string]*postoptions.PublishOptions{
		"instagram": {Instagram: &postoptions.InstagramOptions{Placement: "story"}},
		"facebook":  {Facebook: &postoptions.FacebookOptions{Placement: "story"}},
	} {
		commented := *story
		commented.FirstComment = "Link"
		for _, tc := range []struct {
			name   string
			target ContentDraftScheduleTarget
			valid  bool
		}{
			{"no caption", ContentDraftScheduleTarget{Options: story}, true},
			{"a caption", ContentDraftScheduleTarget{Caption: "Hello", Options: story}, false},
			{"a first comment", ContentDraftScheduleTarget{Options: &commented}, false},
		} {
			if err := checkStory(channel, tc.target); (err == nil) != tc.valid {
				t.Fatalf("%s %s: valid=%v error=%v", channel, tc.name, tc.valid, err)
			}
		}
	}
	if _, err := versionOptions("x", &draftdoc.VersionOptions{Facebook: &postoptions.FacebookOptions{Placement: "story"}}); err == nil {
		t.Fatal("a draft's X version stored a Facebook story")
	}
}
