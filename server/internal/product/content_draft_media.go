package product

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mediavideo"
)

// Scheduling checks each post's media against its channel's published limits
// (medialimits.Destinations), so an unsupported combination is refused with a
// reason before it is queued, never dropped or left for the provider to
// reject. The composer reads the same rules.

var draftChannelLabels = map[string]string{
	"tiktok": "TikTok", "youtube": "YouTube", "x": "X", "linkedin": "LinkedIn", "instagram": "Instagram", "threads": "Threads", "bluesky": "Bluesky", "mastodon": "Mastodon",
}

// draftMediaLimit is how many attachments one post on a channel takes.
func draftMediaLimit(channel string) int {
	return medialimits.Limits.Destinations[channel].MaxMedia
}

// clock writes a duration as minutes and seconds, such as 2:05.
func clock(ms int) string {
	seconds := (ms + 500) / 1000
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

// formatNames writes MIME types as people know them: JPEG, PNG, MP4.
func formatNames(types []string) string {
	names := make([]string, len(types))
	for i, value := range types {
		name := strings.ToUpper(strings.TrimPrefix(strings.TrimPrefix(value, "image/"), "video/"))
		names[i] = map[string]string{"QUICKTIME": "MOV", "JPEG": "JPEG"}[name]
		if names[i] == "" {
			names[i] = name
		}
	}
	return strings.Join(names, ", ")
}

// draftMediaRows loads a post's assets in their order.
func draftMediaRows(ctx context.Context, client *ent.Client, organizationID string, ids []string) ([]*ent.Asset, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := client.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*ent.Asset, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	ordered := make([]*ent.Asset, 0, len(ids))
	for _, id := range ids {
		if byID[id] == nil {
			return nil, invalid("Every attachment must be an uploaded asset of this workspace.")
		}
		ordered = append(ordered, byID[id])
	}
	return ordered, nil
}

// checkDraftMedia checks one post's attachments, in order, for a channel.
func checkDraftMedia(channel string, rows []*ent.Asset) error {
	rules, ok := medialimits.Limits.Destinations[channel]
	if !ok {
		return nil
	}
	label := draftChannelLabels[channel]
	if len(rows) == 0 {
		if rules.RequiresMedia {
			if len(rules.Images) == 0 {
				return conflict(label + " needs one video. Add one to the post.")
			}
			return conflict(label + " needs at least one image or video. Add one to the post.")
		}
		return nil
	}
	if len(rows) > rules.MaxMedia {
		return invalid(fmt.Sprintf("%s takes up to %d attachments in one post; this one has %d. Remove some, or schedule them as separate posts.", label, rules.MaxMedia, len(rows)))
	}
	images, gifs, videos := 0, 0, 0
	for i, row := range rows {
		item := fmt.Sprintf("Attachment %d", i+1)
		switch {
		case row.MediaType == "image/gif":
			if rules.GIF == nil {
				return conflict(fmt.Sprintf("%s can't show a GIF's animation. Upload %s as an MP4 video, or remove it from the %s post.", label, strings.ToLower(item), label))
			}
			if row.Bytes > rules.GIF.MaxBytes {
				return conflict(fmt.Sprintf("%s takes GIFs up to %d MB; %s is %.1f MB.", label, rules.GIF.MaxBytes/1_000_000, strings.ToLower(item), float64(row.Bytes)/1_000_000))
			}
			gifs++
		case strings.HasPrefix(row.MediaType, "image/"):
			if !slices.Contains(rules.Images, row.MediaType) {
				return conflict(fmt.Sprintf("%s takes %s images; %s is %s.", label, formatNames(rules.Images), strings.ToLower(item), formatNames([]string{row.MediaType})))
			}
			if rules.ImageMaxBytes > 0 && row.Bytes > rules.ImageMaxBytes {
				return conflict(fmt.Sprintf("%s takes images up to %d MB; %s is %.1f MB.", label, rules.ImageMaxBytes>>20, strings.ToLower(item), float64(row.Bytes)/(1<<20)))
			}
			if row.Width != nil && row.Height != nil {
				if *row.Width < rules.MinImageWidth {
					return conflict(fmt.Sprintf("%s needs images at least %d pixels wide; %s is %d.", label, rules.MinImageWidth, strings.ToLower(item), *row.Width))
				}
				if ratio := float64(*row.Width) / float64(*row.Height); rules.Aspect != nil && (ratio < rules.Aspect.Min-0.005 || ratio > rules.Aspect.Max+0.005) {
					return conflict(fmt.Sprintf("%s takes images from 4:5 portrait to 1.91:1 landscape; %s is %d×%d. Crop it before scheduling.", label, strings.ToLower(item), *row.Width, *row.Height))
				}
			}
			images++
		case strings.HasPrefix(row.MediaType, "video/"):
			video := rules.Video
			if video == nil {
				return conflict(label + " doesn't take video here.")
			}
			if !slices.Contains(video.Formats, row.MediaType) {
				return conflict(fmt.Sprintf("%s takes %s video; %s is %s. Export it as MP4.", label, formatNames(video.Formats), strings.ToLower(item), formatNames([]string{row.MediaType})))
			}
			if row.Bytes > video.MaxBytes {
				return conflict(fmt.Sprintf("%s takes videos up to %d MB; %s is %d MB.", label, video.MaxBytes/1_000_000, strings.ToLower(item), row.Bytes/1_000_000))
			}
			if video.MinMs > 0 || video.MaxMs > 0 {
				if row.DurationMs == nil || *row.DurationMs == 0 {
					return conflict(fmt.Sprintf("Shots couldn't read the length of %s. Export it again as MP4 and upload it.", strings.ToLower(item)))
				}
				if duration := *row.DurationMs; duration < video.MinMs || video.MaxMs > 0 && duration > video.MaxMs {
					span := fmt.Sprintf("from %s to %s long", clock(video.MinMs), clock(video.MaxMs))
					if video.MaxMs == 0 {
						span = "at least " + clock(video.MinMs) + " long"
					} else if video.MinMs == 0 {
						span = "up to " + clock(video.MaxMs) + " long"
					}
					return conflict(fmt.Sprintf("%s takes videos %s; %s is %s. Trim it, or choose another destination.", label, span, strings.ToLower(item), clock(duration)))
				}
			}
			videos++
		case row.MediaType == "application/pdf":
			return conflict("A PDF goes to LinkedIn as a document. Use the document option instead of attaching it.")
		default:
			return conflict(fmt.Sprintf("%s can't publish %s files.", label, row.MediaType))
		}
	}
	if len(rows) > 1 && (gifs > 0 && rules.GIF.Alone || videos > 0 && rules.Video.Alone) {
		return conflict(fmt.Sprintf("%s posts a video or GIF on its own. Move the other attachments to a separate post.", label))
	}
	if !rules.Mixed && videos > 0 && images+gifs > 0 {
		return conflict(label + " can't mix images and video in one post.")
	}
	return nil
}

// probeDraftVideos reads the length of each referenced video uploaded before
// uploads recorded it, so scheduling can check it. It runs before the schedule
// transaction; a video whose container is unreadable stays unknown and is refused.
func (c *Configuration) probeDraftVideos(ctx context.Context, organizationID string, targets []ContentDraftScheduleTarget, fallback []string) error {
	ids := slices.Clone(fallback)
	for _, target := range targets {
		ids = append(ids, target.AssetIDs...)
		for _, reply := range target.Replies {
			ids = append(ids, reply.AssetIDs...)
		}
	}
	if len(ids) == 0 || c.objects == nil {
		return nil
	}
	rows, err := c.client.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED),
		asset.MediaTypeIn("video/mp4", "video/quicktime"), asset.DurationMsIsNil()).All(ctx)
	if err != nil {
		return err
	}
	for _, row := range rows {
		object, err := c.openObject(ctx, row.ObjectKey)
		if err != nil {
			return conflict("Media storage is unavailable. Retry before scheduling.")
		}
		info, err := mediavideo.Probe(object)
		object.Close()
		if err != nil {
			continue
		}
		if err := c.client.Asset.UpdateOneID(row.ID).Where(asset.OrganizationID(organizationID)).SetWidth(info.Width).SetHeight(info.Height).
			SetDurationMs(info.DurationMs).SetCodecs(strings.Join(info.Codecs, ",")).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

func derefInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}
