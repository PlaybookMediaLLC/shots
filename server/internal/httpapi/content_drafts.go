package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

// ContentDraftStore keeps a workspace's hand-written post drafts (RFC 013).
type ContentDraftStore interface {
	CreateContentDraft(context.Context, product.Actor, product.ContentDraftInput) (*product.ContentDraftRecord, error)
	GetContentDraft(context.Context, product.Actor, string) (*product.ContentDraftRecord, error)
	ListContentDrafts(context.Context, product.Actor, product.ContentDraftListQuery) (*product.ContentDraftPage, error)
	UpdateContentDraft(context.Context, product.Actor, string, product.ContentDraftUpdate) (*product.ContentDraftRecord, error)
	DeleteContentDraft(context.Context, product.Actor, string) error
	DeleteContentDraftAtVersion(context.Context, product.Actor, string, int, int) error
	ScheduleContentDraft(context.Context, product.Actor, string, product.ScheduleContentDraftInput) (*product.ScheduleContentDraftResult, error)
	CreatePost(context.Context, product.Actor, product.CreatePostInput) (*product.CreatePostResult, error)
	ListContentDraftPosts(context.Context, product.Actor, string) ([]product.ContentDraftPost, error)
	IssueContentDraftCollabToken(context.Context, product.Actor, string) (*product.CollabToken, error)
	WriteStore
	AuthorizeCollab(context.Context, string, string) (*product.CollabGrant, error)
	CollabEpochs(context.Context, []string) (int64, map[string]int64, error)
	LoadCollabState(context.Context, string, string) ([]byte, error)
	StoreCollabState(context.Context, string, string, []byte) error
}

func (s *Server) registerContentDrafts(mux *http.ServeMux) {
	mux.Handle("GET /v1/content-drafts", s.authenticateProduct(http.HandlerFunc(s.listContentDrafts)))
	mux.Handle("POST /v1/content-drafts", s.authenticateProduct(http.HandlerFunc(s.createContentDraft)))
	mux.Handle("GET /v1/content-drafts/{id}", s.authenticateProduct(http.HandlerFunc(s.getContentDraft)))
	mux.Handle("PATCH /v1/content-drafts/{id}", s.authenticateProduct(http.HandlerFunc(s.updateContentDraft)))
	mux.Handle("DELETE /v1/content-drafts/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteContentDraft)))
	mux.Handle("POST /v1/content-drafts/{id}/schedule", s.authenticateProduct(http.HandlerFunc(s.scheduleContentDraft)))
	mux.Handle("POST /v1/posts", s.authenticateProduct(http.HandlerFunc(s.createPost)))
	mux.Handle("GET /v1/content-drafts/{id}/posts", s.authenticateProduct(http.HandlerFunc(s.listContentDraftPosts)))
	mux.Handle("POST /v1/content-drafts/{id}/collab-token", s.authenticateProduct(http.HandlerFunc(s.issueCollabToken)))
	s.registerCollab(mux)
	s.registerContentDraftPlatform(mux)
	s.registerContentBatches(mux)
	s.registerWrite(mux)
}

// writeContentDraftError answers a stale write with the version the draft is
// at, so the client can load it instead of overwriting newer work.
func writeContentDraftError(w http.ResponseWriter, err error) {
	var stale *product.ContentDraftVersionConflictError
	if errors.As(err, &stale) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "content_draft_version_conflict", "currentVersion": stale.Current, "error": err.Error(),
		})
		return
	}
	var taken *product.QueueSlotTakenError
	if errors.As(err, &taken) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "queue_slot_taken", "nextQueueSlot": taken.Next.UTC().Format(time.RFC3339), "error": err.Error(),
		})
		return
	}
	writeStoreError(w, err)
}

func contentDraftID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid content draft ID")
		return "", false
	}
	return id, true
}

func (s *Server) listContentDrafts(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryLimit(r, 24, 100)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid content draft limit")
		return
	}
	query := r.URL.Query()
	if setID := query.Get("socialSetId"); setID != "" && !resourceIDPattern.MatchString(setID) {
		writeError(w, http.StatusBadRequest, "invalid social set ID")
		return
	}
	instant := func(name string) (*time.Time, bool) {
		if query.Get(name) == "" {
			return nil, true
		}
		at, err := time.Parse(time.RFC3339, query.Get(name))
		if err != nil {
			writeError(w, http.StatusBadRequest, name+" is an RFC 3339 time")
			return nil, false
		}
		at = at.UTC()
		return &at, true
	}
	from, ok := instant("from")
	if !ok {
		return
	}
	to, ok := instant("to")
	if !ok {
		return
	}
	page, err := s.configuration.ListContentDrafts(r.Context(), workspaceActor(r), product.ContentDraftListQuery{
		ConnectionID: query.Get("connectionId"), Cursor: query.Get("cursor"), From: from, Kind: query.Get("kind"), Limit: limit, Search: query.Get("search"),
		SocialSetID: query.Get("socialSetId"), Sort: query.Get("sort"), Status: query.Get("status"),
		TagID: query.Get("tagId"), To: to, View: query.Get("view"),
	})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) createContentDraft(w http.ResponseWriter, r *http.Request) {
	var input product.ContentDraftInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid content draft request")
		return
	}
	item, err := s.configuration.CreateContentDraft(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) getContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	item, err := s.configuration.GetContentDraft(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) updateContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	var input product.ContentDraftUpdate
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid content draft update")
		return
	}
	item, err := s.configuration.UpdateContentDraft(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeContentDraftError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) deleteContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	version, calendarVersion := 0, 0
	if r.URL.Query().Get("version") != "" || r.URL.Query().Get("calendarVersion") != "" {
		var e error
		version, e = strconv.Atoi(r.URL.Query().Get("version"))
		if e != nil || version < 1 {
			writeError(w, 400, "invalid version")
			return
		}
		calendarVersion, e = strconv.Atoi(r.URL.Query().Get("calendarVersion"))
		if e != nil || calendarVersion < 1 {
			writeError(w, 400, "invalid calendar revision")
			return
		}
	}
	if err := s.configuration.DeleteContentDraftAtVersion(r.Context(), workspaceActor(r), id, version, calendarVersion); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// scheduleContentDraft queues the draft to its channels, then stops the
// workflows of posts a reschedule replaced and starts the new ones. The posts
// are committed either way: a cancelled post is never claimed, and the
// once-a-minute dispatcher starts a due post whose wakeup failed here. A
// Temporal failure is still answered as one, saying the schedule is saved; a
// retry of the same request replays it.
func (s *Server) scheduleContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	var input product.ScheduleContentDraftInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid content draft schedule")
		return
	}
	result, err := s.configuration.ScheduleContentDraft(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeContentDraftError(w, err)
		return
	}
	var wakeup error
	for _, postID := range result.Cancelled {
		wakeup = errors.Join(wakeup, s.scheduler.Cancel(r.Context(), postID))
	}
	for _, post := range result.Scheduled {
		wakeup = errors.Join(wakeup, s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{
			OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor,
		}))
	}
	if wakeup != nil {
		slog.WarnContext(r.Context(), "scheduled post workflows were not woken", "draft", id, "error", wakeup)
		writeError(w, http.StatusServiceUnavailable,
			"The schedule is saved, but the publisher could not be reached. It starts within a minute; refresh to see it.")
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

// createPost writes and schedules a post in one call. A saved post whose
// workflow can't be woken still succeeds: the once-a-minute dispatcher starts
// it, and the caller already holds the post's ID.
func (s *Server) createPost(w http.ResponseWriter, r *http.Request) {
	var input product.CreatePostInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid post")
		return
	}
	result, err := s.configuration.CreatePost(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeContentDraftError(w, err)
		return
	}
	for _, post := range result.Scheduled {
		if err := s.scheduler.Start(r.Context(), temporalpublishing.ScheduleInput{
			OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor,
		}); err != nil {
			slog.WarnContext(r.Context(), "scheduled post workflow was not woken", "post", post.ID, "error", err)
		}
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

func (s *Server) listContentDraftPosts(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	posts, err := s.configuration.ListContentDraftPosts(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"posts": posts})
}

func (s *Server) issueCollabToken(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	token, err := s.configuration.IssueContentDraftCollabToken(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeCollabError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, token)
}
