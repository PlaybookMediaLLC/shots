package product

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// ContentDraftCommentInput changes comments only; author, timestamps and content
// nodes come from the server. BaseVersion makes a replay a conflict, not a second
// comment. Clients reconcile uncertain outcomes by reading the draft.
type DraftCommentAnchor struct {
	Platform string `json:"platform"`
	PostID   string `json:"postId"`
	Quote    string `json:"quote,omitempty"`
}

type ContentDraftCommentInput struct {
	Anchor         *DraftCommentAnchor `json:"anchor,omitempty"`
	Action         string              `json:"action"`
	BaseVersion    int                 `json:"baseVersion"`
	CommentID      string              `json:"commentId,omitempty"`
	ThreadID       string              `json:"threadId,omitempty"`
	Text           string              `json:"text,omitempty"`
	MentionUserIDs []string            `json:"mentionUserIds,omitempty"`
	Resolved       *bool               `json:"resolved,omitempty"`
}

var draftCommentID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func validateDraftComment(input ContentDraftCommentInput) error {
	if input.BaseVersion < 1 {
		return invalid("baseVersion is required.")
	}
	if input.ThreadID != "" && !draftCommentID.MatchString(input.ThreadID) {
		return invalid("Invalid discussion ID.")
	}
	if input.Anchor != nil && (input.Action != "add" || input.ThreadID != "" || !draftCommentID.MatchString(input.Anchor.PostID) || utf8.RuneCountInString(input.Anchor.Quote) > 5000) {
		return invalid("Anchor only a new discussion to a valid post or text span.")
	}
	switch input.Action {
	case "add", "edit":
		if !draftCommentID.MatchString(input.CommentID) || strings.TrimSpace(input.Text) == "" || utf8.RuneCountInString(input.Text) > 5000 || len(input.MentionUserIDs) > 20 || input.Resolved != nil {
			return invalid("Write a comment of 1–5,000 characters with a stable ID.")
		}
		if input.Action == "edit" && input.ThreadID == "" {
			return invalid("Choose the discussion to edit.")
		}
	case "delete":
		if !draftCommentID.MatchString(input.CommentID) || input.ThreadID == "" || input.Text != "" || len(input.MentionUserIDs) != 0 || input.Resolved != nil {
			return invalid("Choose the comment to delete.")
		}
	case "delete_thread":
		if input.ThreadID == "" || input.CommentID != "" || input.Text != "" || len(input.MentionUserIDs) != 0 || input.Resolved != nil {
			return invalid("Choose the discussion to delete.")
		}
	case "resolve":
		if input.ThreadID == "" || input.Resolved == nil || input.CommentID != "" || input.Text != "" || len(input.MentionUserIDs) != 0 {
			return invalid("Choose the discussion and its resolved state.")
		}
	default:
		return invalid("Unknown comment action.")
	}
	return nil
}

// commentAuthorID keeps an API key's comment identity distinct from every human.
// It never changes Actor.UserID, which also controls private-set visibility.
func commentAuthorID(actor Actor) string {
	if actor.Kind == "api_key" {
		return "api-key:" + actor.KeyID
	}
	return actor.UserID
}

func (c *Configuration) authorizeDraftComments(ctx context.Context, actor Actor) error {
	if actor.Kind == "api_key" {
		if actor.KeyID == "" || actor.UserID != "" {
			return publishing.ErrForbidden
		}
		if err := c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, "draft:comment"); err != nil {
			return err
		}
	} else if !actor.IsSession() {
		return publishing.ErrForbidden
	}
	return c.authorizeContentDrafts(ctx, actor, false)
}

// MutateContentDraftComment allows current members and explicitly scoped keys to
// comment without gaining document, publication or collaboration writes.
// The draft lock and version compare preserve simultaneous editor/comment saves.
func (c *Configuration) MutateContentDraftComment(ctx context.Context, actor Actor, id string, input ContentDraftCommentInput) (*ContentDraftRecord, error) {
	if err := c.authorizeDraftComments(ctx, actor); err != nil {
		return nil, err
	}
	if err := validateDraftComment(input); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Hold the authority rows until commitment: removal, session revocation and
	// workspace deletion cannot race past the final membership check.
	locks := []struct {
		sql  string
		args []any
	}{
		{`SELECT id FROM organization WHERE id=$1 FOR SHARE`, []any{actor.OrganizationID}},

		{`SELECT "organizationId" FROM workspace_entitlement WHERE "organizationId"=$1 FOR SHARE`, []any{actor.OrganizationID}},
	}
	if actor.IsSession() {
		locks = append(locks, struct {
			sql  string
			args []any
		}{`SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2 FOR SHARE`, []any{actor.OrganizationID, actor.UserID}}, struct {
			sql  string
			args []any
		}{`SELECT id FROM session WHERE id=$1 FOR SHARE`, []any{actor.SessionID}})
	} else {
		locks = append(locks, struct {
			sql  string
			args []any
		}{`SELECT id FROM apikey WHERE id=$1 AND "referenceId"=$2 FOR SHARE`, []any{actor.KeyID, actor.OrganizationID}})
	}
	for _, query := range locks {
		if _, err = tx.PlatformExec(ctx, query.sql, query.args...); err != nil {
			return nil, err
		}
	}
	if err = NewConfiguration(tx.Client()).authorizeDraftComments(ctx, actor); err != nil {
		return nil, err
	}
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	draft, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	if draft.SocialSetID != nil {
		if _, err = tx.PlatformExec(ctx, `SELECT id FROM social_set WHERE id=$1 AND "organizationId"=$2 FOR SHARE`, *draft.SocialSetID, actor.OrganizationID); err != nil {
			return nil, err
		}
		draft, err = visibleContentDraft(ctx, tx.Client(), actor, id)
		if err != nil {
			return nil, err
		}
	}
	if draft.Version != input.BaseVersion {
		return nil, publishing.ErrConflict
	}
	if input.Action == "add" {
		used, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(actor.OrganizationID), outboxevent.IdempotencyKey("activity:comment.created:"+id+":"+input.CommentID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if used {
			return nil, publishing.ErrConflict
		}
	}
	role := ""
	if actor.IsSession() {
		role, err = memberRole(ctx, tx.Client(), actor.OrganizationID, actor.UserID)
		if err != nil {
			return nil, err
		}
	}
	anchorText, err := draftCommentAnchorText(draft, input.Anchor)
	if err != nil {
		return nil, err
	}
	next, err := applyDraftComment(ctx, tx, actor, draft.Discussions, role, input)
	if err != nil {
		return nil, err
	}
	if input.Anchor != nil {
		for _, raw := range next["threads"].([]any) {
			thread := raw.(map[string]any)
			if thread["id"] == input.CommentID {
				thread["scope"], thread["platform"], thread["postId"], thread["documentContent"] = "post", input.Anchor.Platform, input.Anchor.PostID, anchorText
				if input.Anchor.Quote != "" {
					thread["scope"] = "text"
				}
			}
		}
	}
	if _, err = contentDraftDiscussions(next); err != nil {
		return nil, err
	}
	if err = recordDiscussionActivity(ctx, tx, actor, draft, next); err != nil {
		return nil, err
	}
	// Adding canonical member display records can increase the stored JSON size.
	if _, err = contentDraftDiscussions(next); err != nil {
		return nil, err
	}
	update := tx.ContentDraft.Update().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID), contentdraft.Version(input.BaseVersion)).SetDiscussions(next).AddVersion(1)
	// Comment-only changes do not alter the approved publication content.
	if draft.ApprovedVersion != nil && *draft.ApprovedVersion == draft.Version {
		update.SetApprovedVersion(draft.Version + 1)
	}
	if _, err = update.Save(ctx); err != nil {
		return nil, err
	}
	row, err := tx.ContentDraft.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err = appendConfigurationAudit(ctx, tx, actor, "product.content_draft_comment_"+input.Action, "content_draft", id, map[string]any{"commentId": input.CommentID, "threadId": input.ThreadID, "resolved": input.Resolved}); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

func applyDraftComment(ctx context.Context, tx *ent.Tx, actor Actor, stored map[string]any, role string, input ContentDraftCommentInput) (map[string]any, error) {
	// Clone JSON so activity compares the original, including rich content and
	// anchor metadata from the existing editor. Do not introduce another model.
	raw, err := json.Marshal(nonNilDiscussions(stored))
	if err != nil {
		return nil, err
	}
	var next map[string]any
	if err = json.Unmarshal(raw, &next); err != nil {
		return nil, err
	}
	threads, _ := next["threads"].([]any)
	var thread map[string]any
	threadIndex := -1
	for i, value := range threads {
		candidate, ok := value.(map[string]any)
		if !ok {
			return nil, invalid("Invalid discussion data.")
		}
		if candidate["id"] == input.ThreadID {
			thread, threadIndex = candidate, i
		}
		comments, _ := candidate["comments"].([]any)
		for _, value := range comments {
			comment, ok := value.(map[string]any)
			if !ok {
				return nil, invalid("Invalid comment data.")
			}
			if input.Action == "add" && comment["id"] == input.CommentID {
				return nil, publishing.ErrConflict
			}
		}
		if input.Action == "add" && input.ThreadID == "" && candidate["id"] == input.CommentID {
			return nil, publishing.ErrConflict
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if input.Action == "add" && input.ThreadID == "" {
		thread = map[string]any{"id": input.CommentID, "userId": commentAuthorID(actor), "createdAt": now, "isResolved": false, "scope": "draft", "comments": []any{}}
		threads = append(threads, thread)
		threadIndex = len(threads) - 1
	}
	if thread == nil {
		return nil, publishing.ErrNotFound
	}
	comments, _ := thread["comments"].([]any)
	if input.Action == "delete_thread" {
		admin := actor.IsSession() && (role == "owner" || role == "admin")
		if thread["userId"] != commentAuthorID(actor) && !admin {
			return nil, publishing.ErrForbidden
		}
		if actor.Kind == "api_key" {
			for _, raw := range comments {
				if raw.(map[string]any)["userId"] != commentAuthorID(actor) {
					return nil, publishing.ErrForbidden
				}
			}
		}
		next["threads"] = append(threads[:threadIndex], threads[threadIndex+1:]...)
		return next, nil
	}
	if input.Action == "resolve" {
		thread["isResolved"] = *input.Resolved
	} else {
		var rich []any
		if input.Action == "add" || input.Action == "edit" {
			children := []any{map[string]any{"text": strings.TrimSpace(input.Text)}}
			seen := map[string]bool{}
			for _, userID := range input.MentionUserIDs {
				if seen[userID] {
					continue
				}
				seen[userID] = true
				if _, err = memberRole(ctx, tx.Client(), actor.OrganizationID, userID); err != nil {
					return nil, invalid("Mention a current workspace member.")
				}
				person, err := tx.User.Get(ctx, userID)
				if err != nil {
					return nil, err
				}
				children = append(children, map[string]any{"text": " "}, map[string]any{"type": "mention", "key": userID, "value": person.Name, "children": []any{map[string]any{"text": ""}}})
			}
			rich = []any{map[string]any{"type": "p", "children": children}}
		}
		if input.Action == "add" {
			comments = append(comments, map[string]any{"id": input.CommentID, "userId": commentAuthorID(actor), "createdAt": now, "contentRich": rich, "isEdited": false})
		} else {
			found := false
			for i, value := range comments {
				comment, ok := value.(map[string]any)
				if !ok {
					return nil, invalid("Invalid comment data.")
				}
				if comment["id"] != input.CommentID {
					continue
				}
				found = true
				if comment["userId"] != commentAuthorID(actor) && !(input.Action == "delete" && (role == "owner" || role == "admin")) {
					return nil, publishing.ErrForbidden
				}
				if input.Action == "delete" {
					comments = append(comments[:i], comments[i+1:]...)
				} else {
					comment["contentRich"], comment["isEdited"], comment["updatedAt"] = rich, true, now
				}
				break
			}
			if !found {
				return nil, publishing.ErrNotFound
			}
		}
		thread["comments"] = comments
		if len(comments) == 0 {
			threads = append(threads[:threadIndex], threads[threadIndex+1:]...)
		}
	}
	next["threads"] = threads
	return next, nil
}

// draftCommentAnchorText validates a stable post identity and captures its text.
// A quote must identify one exact span. It never mutates the approved document.
func draftCommentAnchorText(draft *ent.ContentDraft, anchor *DraftCommentAnchor) (string, error) {
	if anchor == nil {
		return "", nil
	}
	body := draft.Body
	if anchor.Platform != draftPrimary(draft) {
		found := false
		for _, version := range draft.PlatformVersions.Versions {
			if version.Channel == anchor.Platform {
				found = true
				if version.Mode == "manual" {
					body = version.Body
				}
			}
		}
		if !found {
			return "", invalid("Choose an existing platform version.")
		}
	}
	text := []string{}
	found, inPost := false, false
	var nodeText func(any) string
	nodeText = func(value any) string {
		switch node := value.(type) {
		case map[string]any:
			if text, ok := node["text"].(string); ok {
				return text
			}
			if node["type"] == "mention" {
				if text, ok := node["value"].(string); ok {
					return "@" + text
				}
			}
			return nodeText(node["children"])
		case []any:
			result := ""
			for _, child := range node {
				result += nodeText(child)
			}
			return result
		}
		return ""
	}
	for _, raw := range body {
		node, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if node["type"] == "post_break" {
			inPost = node["id"] == anchor.PostID
			if inPost {
				found = true
			}
		} else if inPost {
			text = append(text, nodeText(raw))
		}
	}
	if !found {
		return "", invalid("The post no longer exists; reload the draft.")
	}
	whole := strings.Join(text, "\n")
	if anchor.Quote != "" {
		if strings.Count(whole, anchor.Quote) != 1 {
			return "", invalid("The quoted span must appear exactly once in the selected post.")
		}
		return anchor.Quote, nil
	}
	// Whole-post discussions need no unbounded copy of a long article.
	if runes := []rune(whole); len(runes) > 5000 {
		whole = string(runes[:5000])
	}
	return whole, nil
}

// ContentDraftCommentList is the existing discussion document, optionally filtered.
type ContentDraftCommentList struct {
	ID          string         `json:"id"`
	Version     int            `json:"version"`
	Discussions map[string]any `json:"discussions"`
}

// ListContentDraftComments reuses draft visibility; filters never reveal another set.
func (c *Configuration) ListContentDraftComments(ctx context.Context, actor Actor, id, status, platform string) (*ContentDraftCommentList, error) {
	if status != "" && status != "all" && status != "open" && status != "resolved" {
		return nil, invalid("Choose open, resolved, or all discussions.")
	}
	if platform != "" && draftPlatformChannels[platform] == "" {
		return nil, invalid("Choose a supported platform.")
	}
	if actor.Kind == "api_key" {
		if err := c.auth.AuthorizeAPIKeyScope(ctx, actor.OrganizationID, actor.KeyID, "artifact:read"); err != nil {
			return nil, err
		}
	}
	draft, err := c.GetContentDraft(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	threads := []any{}
	if all, ok := draft.Discussions["threads"].([]any); ok {
		for _, raw := range all {
			thread, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			resolved, _ := thread["isResolved"].(bool)
			channel, _ := thread["platform"].(string)
			if status == "open" && resolved || status == "resolved" && !resolved || platform != "" && channel != "" && channel != platform {
				continue
			}
			threads = append(threads, thread)
		}
	}
	users := draft.Discussions["users"]
	if users == nil {
		users = map[string]any{}
	}
	return &ContentDraftCommentList{ID: draft.ID, Version: draft.Version, Discussions: map[string]any{"threads": threads, "users": users}}, nil
}
