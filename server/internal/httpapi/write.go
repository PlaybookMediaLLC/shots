package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// WriteStore is the Write workspace (RFC 025): a social set's tags, thread
// finishers and mention lookups, and a draft's properties, plan, copies,
// recovered backups, activity and follow-ups.
type WriteStore interface {
	LookupPeopleMentions(context.Context, product.Actor, string, string) ([]product.Mention, error)
	LookupCommunities(context.Context, product.Actor, string, string) ([]product.Community, error)
	LookupMentions(ctx context.Context, actor product.Actor, setID, channel, query string) ([]product.Mention, error)
	SetAssetAltText(ctx context.Context, actor product.Actor, assetID, altText string) (*product.AssetAltText, error)
	ListContentDraftTags(context.Context, product.Actor, string) ([]product.ContentDraftTagRecord, error)
	CreateContentDraftTag(context.Context, product.Actor, string, product.ContentDraftTagInput) (*product.ContentDraftTagRecord, error)
	UpdateContentDraftTag(context.Context, product.Actor, string, string, product.ContentDraftTagInput) (*product.ContentDraftTagRecord, error)
	DeleteContentDraftTag(context.Context, product.Actor, string, string) error
	ListContentDraftFinishers(context.Context, product.Actor, string) ([]product.ContentDraftFinisherRecord, error)
	CreateContentDraftFinisher(context.Context, product.Actor, string, product.ContentDraftFinisherInput) (*product.ContentDraftFinisherRecord, error)
	UpdateContentDraftFinisher(context.Context, product.Actor, string, string, product.ContentDraftFinisherInput) (*product.ContentDraftFinisherRecord, error)
	DeleteContentDraftFinisher(context.Context, product.Actor, string, string) error
	UpdateContentDraftProperties(context.Context, product.Actor, string, product.ContentDraftPropertiesInput) (*product.ContentDraftRecord, error)
	PlanContentDraft(context.Context, product.Actor, string, product.ContentDraftPlanInput) (*product.ContentDraftRecord, error)
	DuplicateContentDraft(context.Context, product.Actor, string) (*product.ContentDraftCopyResult, error)
	DuplicateContentDraftWithKey(context.Context, product.Actor, string, string) (*product.ContentDraftCopyResult, error)
	CopyContentDraftToSet(context.Context, product.Actor, string, product.ContentDraftCopyInput) (*product.ContentDraftCopyResult, error)
	RecoverContentDraftRevision(context.Context, product.Actor, string, string) (*product.ContentDraftCopyResult, error)
	ListContentDraftActivity(context.Context, product.Actor, string) ([]product.ContentDraftActivity, error)
	ListPlannedContentDrafts(context.Context, product.Actor, time.Time, time.Time, string) ([]product.ContentDraftRecord, error)
	RetryContentDraftPost(context.Context, product.Actor, string) (*product.MovedDraftPost, error)
	ReconcileContentDraftPost(context.Context, product.Actor, string, product.ReconcileInput) (*product.ContentDraftPost, error)
	CancelContentDraftPostAutomations(context.Context, product.Actor, string) (*product.ContentDraftPost, error)
	DeleteContentDraftPost(context.Context, product.Actor, string) (*product.DeletionRequest, error)
}

func (s *Server) registerWrite(mux *http.ServeMux) {
	mux.Handle("GET /v1/social-sets/{id}/mentions", s.authenticateProduct(http.HandlerFunc(s.lookupMentions)))
	mux.Handle("GET /v1/social-sets/{id}/communities", s.authenticateProduct(http.HandlerFunc(s.lookupCommunities)))
	mux.Handle("PUT /v1/assets/{id}/alt-text", s.authenticateProduct(http.HandlerFunc(s.setAssetAltText)))
	mux.Handle("GET /v1/social-sets/{id}/tags", s.authenticateProduct(http.HandlerFunc(s.listDraftTags)))
	mux.Handle("POST /v1/social-sets/{id}/tags", s.authenticateProduct(http.HandlerFunc(s.createDraftTag)))
	mux.Handle("PATCH /v1/social-sets/{id}/tags/{itemId}", s.authenticateProduct(http.HandlerFunc(s.updateDraftTag)))
	mux.Handle("DELETE /v1/social-sets/{id}/tags/{itemId}", s.authenticateProduct(http.HandlerFunc(s.deleteDraftTag)))
	mux.Handle("GET /v1/social-sets/{id}/finishers", s.authenticateProduct(http.HandlerFunc(s.listDraftFinishers)))
	mux.Handle("POST /v1/social-sets/{id}/finishers", s.authenticateProduct(http.HandlerFunc(s.createDraftFinisher)))
	mux.Handle("PATCH /v1/social-sets/{id}/finishers/{itemId}", s.authenticateProduct(http.HandlerFunc(s.updateDraftFinisher)))
	mux.Handle("DELETE /v1/social-sets/{id}/finishers/{itemId}", s.authenticateProduct(http.HandlerFunc(s.deleteDraftFinisher)))
	mux.Handle("PATCH /v1/content-drafts/{id}/properties", s.authenticateProduct(http.HandlerFunc(s.updateDraftProperties)))
	mux.Handle("POST /v1/content-drafts/{id}/plan", s.authenticateProduct(http.HandlerFunc(s.planContentDraft)))
	mux.Handle("POST /v1/content-drafts/{id}/duplicate", s.authenticateProduct(http.HandlerFunc(s.duplicateContentDraft)))
	mux.Handle("POST /v1/content-drafts/{id}/copy", s.authenticateProduct(http.HandlerFunc(s.copyContentDraft)))
	mux.Handle("POST /v1/content-drafts/{id}/revisions/{revisionId}/recover", s.authenticateProduct(http.HandlerFunc(s.recoverContentDraft)))
	mux.Handle("GET /v1/content-drafts/{id}/activity", s.authenticateProduct(http.HandlerFunc(s.contentDraftActivity)))
	mux.Handle("GET /v1/content-draft-plans", s.authenticateProduct(http.HandlerFunc(s.listPlannedContentDrafts)))
	mux.Handle("POST /v1/content-draft-posts/{id}/retry", s.authenticateProduct(http.HandlerFunc(s.retryContentDraftPost)))
	mux.Handle("POST /v1/content-draft-posts/{id}/reconcile", s.authenticateProduct(http.HandlerFunc(s.reconcileContentDraftPost)))
	mux.Handle("POST /v1/content-draft-posts/{id}/automations/cancel", s.authenticateProduct(http.HandlerFunc(s.cancelContentDraftPostAutomations)))
	mux.Handle("POST /v1/content-draft-posts/{id}/delete", s.authenticateProduct(http.HandlerFunc(s.deleteContentDraftPost)))
}

// pathIDs reads path values that must be resource IDs.
func pathIDs(w http.ResponseWriter, r *http.Request, names ...string) ([]string, bool) {
	values := make([]string, 0, len(names))
	for _, name := range names {
		value := r.PathValue(name)
		if !resourceIDPattern.MatchString(value) {
			writeError(w, http.StatusBadRequest, "invalid "+name)
			return nil, false
		}
		values = append(values, value)
	}
	return values, true
}

func (s *Server) listDraftTags(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	tags, err := s.configuration.ListContentDraftTags(r.Context(), workspaceActor(r), ids[0])
	respond(w, http.StatusOK, map[string]any{"items": tags}, err)
}

func (s *Server) createDraftTag(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.ContentDraftTagInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid tag")
		return
	}
	tag, err := s.configuration.CreateContentDraftTag(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, http.StatusCreated, tag, err)
}

func (s *Server) updateDraftTag(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "itemId")
	if !ok {
		return
	}
	var input product.ContentDraftTagInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid tag")
		return
	}
	tag, err := s.configuration.UpdateContentDraftTag(r.Context(), workspaceActor(r), ids[0], ids[1], input)
	respond(w, http.StatusOK, tag, err)
}

func (s *Server) deleteDraftTag(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "itemId")
	if !ok {
		return
	}
	err := s.configuration.DeleteContentDraftTag(r.Context(), workspaceActor(r), ids[0], ids[1])
	respond(w, http.StatusOK, map[string]bool{"deleted": true}, err)
}

func (s *Server) listDraftFinishers(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	finishers, err := s.configuration.ListContentDraftFinishers(r.Context(), workspaceActor(r), ids[0])
	respond(w, http.StatusOK, map[string]any{"items": finishers}, err)
}

func (s *Server) createDraftFinisher(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.ContentDraftFinisherInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid finisher")
		return
	}
	finisher, err := s.configuration.CreateContentDraftFinisher(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, http.StatusCreated, finisher, err)
}

func (s *Server) updateDraftFinisher(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "itemId")
	if !ok {
		return
	}
	var input product.ContentDraftFinisherInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid finisher")
		return
	}
	finisher, err := s.configuration.UpdateContentDraftFinisher(r.Context(), workspaceActor(r), ids[0], ids[1], input)
	respond(w, http.StatusOK, finisher, err)
}

func (s *Server) deleteDraftFinisher(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "itemId")
	if !ok {
		return
	}
	err := s.configuration.DeleteContentDraftFinisher(r.Context(), workspaceActor(r), ids[0], ids[1])
	respond(w, http.StatusOK, map[string]bool{"deleted": true}, err)
}

func (s *Server) updateDraftProperties(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	var input product.ContentDraftPropertiesInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid draft properties")
		return
	}
	draft, err := s.configuration.UpdateContentDraftProperties(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusOK, draft, err)
}

func (s *Server) planContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	var input product.ContentDraftPlanInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid plan")
		return
	}
	draft, err := s.configuration.PlanContentDraft(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusOK, draft, err)
}

func (s *Server) duplicateContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	result, err := s.configuration.DuplicateContentDraftWithKey(r.Context(), workspaceActor(r), id, r.URL.Query().Get("requestKey"))
	respond(w, http.StatusCreated, result, err)
}

func (s *Server) copyContentDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	var input product.ContentDraftCopyInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid copy")
		return
	}
	result, err := s.configuration.CopyContentDraftToSet(r.Context(), workspaceActor(r), id, input)
	respond(w, http.StatusCreated, result, err)
}

func (s *Server) recoverContentDraft(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id", "revisionId")
	if !ok {
		return
	}
	result, err := s.configuration.RecoverContentDraftRevision(r.Context(), workspaceActor(r), ids[0], ids[1])
	respond(w, http.StatusCreated, result, err)
}

func (s *Server) contentDraftActivity(w http.ResponseWriter, r *http.Request) {
	id, ok := contentDraftID(w, r)
	if !ok {
		return
	}
	items, err := s.configuration.ListContentDraftActivity(r.Context(), workspaceActor(r), id)
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

func (s *Server) listPlannedContentDrafts(w http.ResponseWriter, r *http.Request) {
	from, fromErr := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	to, toErr := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	if fromErr != nil || toErr != nil {
		writeError(w, http.StatusBadRequest, "from and to are RFC 3339 times")
		return
	}
	setID := r.URL.Query().Get("socialSetId")
	if setID != "" && !resourceIDPattern.MatchString(setID) {
		writeError(w, http.StatusBadRequest, "invalid social set ID")
		return
	}
	items, err := s.configuration.ListPlannedContentDrafts(r.Context(), workspaceActor(r), from, to, setID)
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

// retryContentDraftPost publishes one failed destination again and starts
// its workflow; the draft's other posts are left as they are.
func (s *Server) retryContentDraftPost(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	retried, err := s.configuration.RetryContentDraftPost(r.Context(), workspaceActor(r), ids[0])
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if s.startMovedPost(w, r, retried) {
		writeJSON(w, http.StatusCreated, retried)
	}
}

// reconcileContentDraftPost records what a person found for a post whose
// outcome was unknown. Nothing is sent to the platform.
func (s *Server) reconcileContentDraftPost(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input product.ReconcileInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid reconciliation")
		return
	}
	post, err := s.configuration.ReconcileContentDraftPost(r.Context(), workspaceActor(r), ids[0], input)
	respond(w, http.StatusOK, map[string]any{"post": post}, err)
}

// cancelContentDraftPostAutomations stops a live post's pending follow-ups.
func (s *Server) cancelContentDraftPostAutomations(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	post, err := s.configuration.CancelContentDraftPostAutomations(r.Context(), workspaceActor(r), ids[0])
	respond(w, http.StatusOK, map[string]any{"post": post}, err)
}

// deleteContentDraftPost starts deleting a live post from its platform. The
// workflow removes its parts with receipts; 202 means it was started.
func (s *Server) deleteContentDraftPost(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	request, err := s.configuration.DeleteContentDraftPost(r.Context(), workspaceActor(r), ids[0])
	if errors.Is(err, product.ErrPostDeletionNotStarted) {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"deletion": request})
}

// lookupMentions finds what the set's account for a channel can mention.
func (s *Server) lookupCommunities(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	items, err := s.configuration.LookupCommunities(r.Context(), workspaceActor(r), ids[0], r.URL.Query().Get("q"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) lookupMentions(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	query := r.URL.Query()
	var items []product.Mention
	var err error
	if query.Get("kind") == "person" && query.Get("channel") == "linkedin" {
		items, err = s.configuration.LookupPeopleMentions(r.Context(), workspaceActor(r), ids[0], query.Get("q"))
	} else if kind := query.Get("kind"); kind != "" && kind != "organization" && kind != "person" {
		writeStoreError(w, product.ErrInvalidInput)
		return
	} else {
		items, err = s.configuration.LookupMentions(r.Context(), workspaceActor(r), ids[0], query.Get("channel"), query.Get("q"))
	}
	respond(w, http.StatusOK, map[string]any{"items": items}, err)
}

// setAssetAltText describes an image; it is posted with the image.
func (s *Server) setAssetAltText(w http.ResponseWriter, r *http.Request) {
	ids, ok := pathIDs(w, r, "id")
	if !ok {
		return
	}
	var input struct {
		AltText string `json:"altText"`
	}
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid alt text")
		return
	}
	saved, err := s.configuration.SetAssetAltText(r.Context(), workspaceActor(r), ids[0], input.AltText)
	respond(w, http.StatusOK, saved, err)
}
