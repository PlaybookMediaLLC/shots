package product

import (
	"context"
	"slices"
	"strings"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// seedRepurposedDraft starts from confirmed publication snapshots, never the
// source's private later edits, approval, discussions, or unfinished replies.
func seedRepurposedDraft(ctx context.Context, tx *ent.Tx, actor Actor, input *ContentDraftInput, target *draftdoc.Target) error {
	if target == nil || target.SourceDraftID == "" {
		return nil
	} // An external URL remains a reference for writing.
	source, err := visibleContentDraft(ctx, tx.Client(), actor, target.SourceDraftID)
	if err != nil {
		return err
	}
	query := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftID(source.ID), scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.RemotePostIDNotNil())
	if target.SourcePostID != "" {
		query.Where(scheduledpost.ID(target.SourcePostID))
	} else if string(source.Kind) != "reply" {
		query.Where(scheduledpost.ReplyToIsNil())
	}
	post, err := query.WithChannelConnection().Order(scheduledpost.ByPublishedAt(entsql.OrderDesc(), entsql.OrderNullsLast()), ent.Desc(scheduledpost.FieldCreatedAt)).First(ctx)
	if ent.IsNotFound(err) {
		if target.SourcePostID == "" {
			return conflict("Publish the source before repurposing its confirmed content.")
		}
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	if input.SocialSetID == "" && source.SocialSetID != nil {
		input.SocialSetID = *source.SocialSetID
	}
	target.SourcePostID = post.ID
	target.Platform = draftPlatformChannels[post.Edges.ChannelConnection.Platform]
	target.RemoteID = *post.RemotePostID
	// Explicit caller-authored content is not replaced, but its source is checked.
	if len(input.Body) > 0 || strings.TrimSpace(input.PlainText) != "" || len(input.AssetIDs) > 0 {
		return nil
	}
	type part struct {
		text    string
		assets  []string
		poll    *postoptions.Poll
		options *postoptions.PublishOptions
	}
	parts := []part{}
	appendPost := func(row *ent.ScheduledPost) {
		ids := row.AssetIds
		if len(ids) == 0 && row.AssetID != nil {
			ids = []string{*row.AssetID}
		}
		parts = append(parts, part{row.Caption, ids, &row.Poll, &row.PublishOptions})
		for _, reply := range row.Replies[:min(len(row.Replies), max(0, row.ThreadProgress.Posted))] {
			parts = append(parts, part{reply.Caption, reply.AssetIDs, reply.Poll, reply.Options})
		}
	}
	appendPost(post)
	if cover := post.PublishOptions.ArticleCoverAssetID; cover != "" && !slices.Contains(parts[0].assets, cover) {
		parts[0].assets = append(parts[0].assets, cover)
	}
	resumed, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.ContentDraftID(source.ID), scheduledpost.ChannelConnectionID(post.ChannelConnectionID), scheduledpost.StatusEQ(scheduledpost.StatusPUBLISHED), scheduledpost.ReplyToNotNil(), scheduledpost.CreatedAtGTE(post.CreatedAt)).Order(ent.Asc(scheduledpost.FieldCreatedAt)).Limit(1000).All(ctx)
	if err != nil {
		return err
	}
	tail := post.ThreadProgress.LastReplyID
	if tail == "" {
		tail = *post.RemotePostID
	}
	seen := map[string]bool{post.ID: true}
	for tail != "" {
		var next *ent.ScheduledPost
		for _, candidate := range resumed {
			if !seen[candidate.ID] && candidate.ReplyTo != nil && *candidate.ReplyTo == tail {
				next = candidate
				break
			}
		}
		if next == nil {
			break
		}
		seen[next.ID] = true
		appendPost(next)
		tail = next.ThreadProgress.LastReplyID
		if tail == "" && next.RemotePostID != nil {
			tail = *next.RemotePostID
		}
	}
	ids := []string{}
	for _, p := range parts {
		for _, id := range p.assets {
			if !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
		}
	}
	documentID := post.PublishOptions.DocumentAssetID
	if documentID != "" && !slices.Contains(ids, documentID) {
		ids = append(ids, documentID)
	}
	kinds, err := draftMediaKinds(ctx, tx.Asset, actor.OrganizationID, ids)
	if err != nil {
		return err
	}
	if len(kinds) != len(ids) {
		return conflict("Some published media is no longer available. Start a new draft and attach replacement media.")
	}
	body := []any{}
	texts := []string{}
	for _, p := range parts {
		settings := map[string]any{"type": "post_break", "children": []any{map[string]any{"text": ""}}}
		if p.poll != nil && len(p.poll.Options) > 0 {
			value := map[string]any{"options": p.poll.Options, "durationMinutes": p.poll.DurationMinutes, "multiple": p.poll.Multiple}
			if p.options != nil && p.options.PollQuestion != "" {
				value["question"] = p.options.PollQuestion
			}
			settings["poll"] = value
		}
		if p.options != nil {
			if p.options.ReplySettings != "" {
				settings["replySettings"] = p.options.ReplySettings
			}
			if p.options.QuoteFirstPost {
				settings["quoteFirstPost"] = true
			}
			if p.options.MadeWithAI || p.options.PaidPartnership {
				settings["disclosures"] = map[string]bool{"madeWithAi": p.options.MadeWithAI, "paidPartnership": p.options.PaidPartnership}
			}
		}
		body = append(body, settings)
		body = append(body, map[string]any{"type": "p", "children": []any{map[string]any{"text": p.text}}})
		texts = append(texts, p.text)
		for _, id := range p.assets {
			body = append(body, draftMediaBlock(kinds[id], id))
		}
	}
	if input.PrimaryPlatform == "" {
		input.PrimaryPlatform = target.Platform
	}
	if input.ChannelConnectionIDs == nil && source.SocialSetID != nil && (input.SocialSetID == "" || input.SocialSetID == *source.SocialSetID) {
		input.ChannelConnectionIDs = []string{post.ChannelConnectionID}
	}
	if input.PlatformVersions == nil {
		options := &draftdoc.VersionOptions{Visibility: post.PublishOptions.Visibility, FirstComment: post.PublishOptions.FirstComment}
		if documentID != "" {
			options.Document = &draftdoc.Document{AssetID: documentID, Title: post.PublishOptions.DocumentTitle}
		}
		if post.PublishOptions.CommunityID != "" {
			options.Community = &draftdoc.Community{ID: post.PublishOptions.CommunityID}
		}
		if post.PublishOptions.LinkPreview != nil {
			options.LinkPreviews = []postoptions.LinkPreview{*post.PublishOptions.LinkPreview}
		}
		input.PlatformVersions = &draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{{Channel: input.PrimaryPlatform, Mode: draftdoc.ModeSynced, Options: options}}}
	}
	input.Body, input.PlainText, input.AssetIDs = body, strings.Join(texts, "\n\n"), ids
	if strings.TrimSpace(input.Title) == "" {
		input.Title = source.Title
	}
	return nil
}

// draftMediaKinds is the Plate block type of each uploaded asset among ids. An
// asset that is missing or still uploading is absent, so callers compare lengths.
func draftMediaKinds(ctx context.Context, assets *ent.AssetClient, organizationID string, ids []string) (map[string]string, error) {
	kinds := map[string]string{}
	if len(ids) == 0 {
		return kinds, nil
	}
	media, err := assets.Query().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID), asset.StatusEQ(asset.StatusUPLOADED)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, item := range media {
		kind := "img"
		if strings.HasPrefix(item.MediaType, "video/") {
			kind = "video"
		}
		if item.MediaType == "application/pdf" {
			kind = "file"
		}
		kinds[item.ID] = kind
	}
	return kinds, nil
}

// draftMediaBlock is the body block that attaches an asset to a post.
func draftMediaBlock(kind, id string) map[string]any {
	return map[string]any{"type": kind, "assetId": id, "url": "/api/v1/assets/" + id + "/content", "children": []any{map[string]any{"text": ""}}}
}
