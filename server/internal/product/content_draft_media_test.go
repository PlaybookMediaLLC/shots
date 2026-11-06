package product

import (
	"strings"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
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
