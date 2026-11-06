package mcp

import (
	"context"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// Draft tools use the same domain authority as REST. Planning is deliberately
// separate from publishing. createPost is the one tool that puts new text on a
// channel, behind the opt-in post:publish scope; a stored draft is still
// scheduled by a person, and no tool approves.
func listContentDrafts(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.ListContentDrafts(ctx, actor, product.ContentDraftListQuery{
		Cursor: stringArg(args, "cursor"), Kind: stringArg(args, "kind"), Limit: intArg(args, "limit"),
		Search: stringArg(args, "search"), SocialSetID: stringArg(args, "socialSetId"), Sort: stringArg(args, "sort"),
		Status: stringArg(args, "status"), TagID: stringArg(args, "tagId"), View: stringArg(args, "view"),
	})
}
func getContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.GetContentDraft(ctx, actor, stringArg(args, "id"))
}
func createContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.ContentDraftInput
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.CreateContentDraft(ctx, actor, input)
}
func createPost(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.CreatePostInput
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.CreatePost(ctx, actor, input)
}
func updateContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.ContentDraftUpdate
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.UpdateContentDraft(ctx, actor, stringArg(args, "id"), input)
}
func deleteContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	err := s.config.Product.DeleteContentDraft(ctx, actor, stringArg(args, "id"))
	return map[string]bool{"deleted": true}, err
}
func listContentDraftPosts(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	posts, err := s.config.Product.ListContentDraftPosts(ctx, actor, stringArg(args, "id"))
	return map[string]any{"posts": posts}, err
}
func planContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.ContentDraftPlanInput
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.PlanContentDraft(ctx, actor, stringArg(args, "id"), input)
}
func duplicateContentDraft(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.DuplicateContentDraft(ctx, actor, stringArg(args, "id"))
}
func updateContentDraftProperties(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.ContentDraftPropertiesInput
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.UpdateContentDraftProperties(ctx, actor, stringArg(args, "id"), input)
}
func listContentDraftActivity(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	items, err := s.config.Product.ListContentDraftActivity(ctx, actor, stringArg(args, "id"))
	return map[string]any{"items": items}, err
}

func listSocialSets(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.ListSocialSets(ctx, actor)
}
func getSocialSet(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.GetSocialSet(ctx, actor, stringArg(args, "id"))
}

func updateSocialSetQueue(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.SocialSetQueueUpdate
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	return s.config.Product.UpdateSocialSetQueue(ctx, actor, stringArg(args, "id"), input)
}

func lookupSocialSetMentions(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	items, err := s.config.Product.LookupMentions(ctx, actor, stringArg(args, "id"), stringArg(args, "channel"), stringArg(args, "q"))
	return map[string]any{"items": items}, err
}
func bestPostingTimes(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	items, err := s.config.Product.BestPostingTimes(ctx, actor, stringArg(args, "socialSetId"))
	return map[string]any{"items": items}, err
}
func listCalendarPosts(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input struct {
		From        time.Time `json:"from"`
		To          time.Time `json:"to"`
		SocialSetID string    `json:"socialSetId"`
	}
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	items, err := s.config.Product.ListContentDraftPostsBetween(ctx, actor, input.From, input.To, input.SocialSetID)
	return map[string]any{"items": items}, err
}

func listDraftComments(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	return s.config.Product.ListContentDraftComments(ctx, actor, stringArg(args, "id"), stringArg(args, "status"), stringArg(args, "platform"))
}
func mutateDraftComment(ctx context.Context, s *Server, actor product.Actor, args map[string]any) (any, error) {
	var input product.ContentDraftCommentInput
	if err := decode(args, &input); err != nil {
		return nil, err
	}
	draft, err := s.config.Product.MutateContentDraftComment(ctx, actor, stringArg(args, "id"), input)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": draft.ID, "version": draft.Version, "discussions": draft.Discussions, "approvedVersion": draft.ApprovedVersion, "reviewStatus": draft.ReviewStatus, "reviewNote": draft.ReviewNote, "reviewedByUserId": draft.ReviewedByUserID}, nil
}
