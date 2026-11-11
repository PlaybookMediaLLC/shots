package httpapi

import (
	"net/http"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// The launch pipeline: specs, plans, generated posts, AI revisions, and
// background runs. Roles are checked per operation in the product layer.
func (s *Server) registerLaunch(mux *http.ServeMux) {
	handle := func(pattern string, handler http.HandlerFunc) {
		mux.Handle(pattern, s.authenticateProduct(handler))
	}
	handle("GET /v1/launch/brand", s.getLaunchBrand)
	handle("GET /v1/launch/preferences", s.getLaunchPreferences)
	handle("GET /v1/launch/campaigns/{id}", s.getLaunchCampaign)
	handle("GET /v1/launch/campaigns/{id}/plans", s.listLaunchPlans)
	handle("POST /v1/launch/campaigns/{id}/plans", s.saveLaunchPlan)
	handle("GET /v1/launch/campaigns/{id}/plans/{planId}", s.getLaunchPlan)
	handle("POST /v1/launch/campaigns/{id}/posts", s.saveLaunchPosts)
	handle("GET /v1/launch/campaigns/{id}/revisions", s.listLaunchRevisions)
	handle("POST /v1/launch/campaigns/{id}/revisions", s.createLaunchRevision)
	handle("GET /v1/launch/campaigns/{id}/runs", s.listLaunchRuns)
	handle("POST /v1/launch/campaigns/{id}/runs", s.startLaunchRun)
	handle("GET /v1/launch/releases/{id}/specs", s.listLaunchSpecs)
	handle("POST /v1/launch/releases/{id}/specs", s.saveLaunchSpec)
	handle("GET /v1/launch/specs/{id}", s.getLaunchSpec)
	handle("POST /v1/launch/specs/{id}/approve", s.approveLaunchSpec)
	handle("POST /v1/launch/plans/{id}/approve", s.approveLaunchPlan)
	handle("GET /v1/launch/revisions/{id}", s.getLaunchRevision)
	handle("POST /v1/launch/revisions/{id}/apply", s.applyLaunchRevision)
	handle("POST /v1/launch/revisions/{id}/discard", s.discardLaunchRevision)
	handle("POST /v1/launch/runs", s.startAgentRun)
	handle("GET /v1/launch/runs/{id}", s.getLaunchRun)
	handle("GET /v1/launch/runs/{id}/steps", s.listLaunchRunSteps)
	handle("POST /v1/launch/runs/{id}/steps", s.appendLaunchRunStep)
	handle("POST /v1/launch/runs/{id}/finish", s.finishLaunchRun)
	handle("POST /v1/launch/runs/{id}/heartbeat", s.heartbeatLaunchRun)
	handle("POST /v1/launch/runs/{id}/cancel", s.cancelLaunchRun)
	handle("PUT /v1/launch/designs/{id}/critique", s.setLaunchDesignCritique)
}

// launchID reads a path ID, answering 400 when it is not a cuid.
func launchID(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	id := r.PathValue(name)
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid "+name)
		return "", false
	}
	return id, true
}

func launchBody(w http.ResponseWriter, r *http.Request, target any) bool {
	if err := decodeJSON(r, target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid launch request")
		return false
	}
	return true
}

func writeLaunch(w http.ResponseWriter, status int, value any, err error) {
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, status, value)
}

func (s *Server) getLaunchBrand(w http.ResponseWriter, r *http.Request) {
	kit, profile, err := s.configuration.GetLaunchBrand(r.Context(), workspaceActor(r))
	response := map[string]any{"kit": nil, "profile": nil}
	if kit != nil {
		response["kit"] = brandKitResponse(kit)
	}
	if profile != nil {
		response["profile"] = brandProfileResponse(profile)
		response["voice"] = product.WorkspaceVoice(profile)
	}
	writeLaunch(w, http.StatusOK, response, err)
}

func (s *Server) getLaunchPreferences(w http.ResponseWriter, r *http.Request) {
	result, err := s.configuration.GetLaunchPreferences(r.Context(), workspaceActor(r))
	writeLaunch(w, http.StatusOK, result, err)
}

func (s *Server) getLaunchCampaign(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetLaunchCampaign(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) listLaunchPlans(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		plans, err := s.configuration.ListLaunchPlans(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"plans": plans}, err)
	}
}

func (s *Server) saveLaunchPlan(w http.ResponseWriter, r *http.Request) {
	var input product.SaveLaunchPlanInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.SaveLaunchPlan(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

func (s *Server) getLaunchPlan(w http.ResponseWriter, r *http.Request) {
	campaignID, ok := launchID(w, r, "id")
	if !ok {
		return
	}
	if id, ok := launchID(w, r, "planId"); ok {
		result, err := s.configuration.GetLaunchPlan(r.Context(), workspaceActor(r), campaignID, id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) saveLaunchPosts(w http.ResponseWriter, r *http.Request) {
	var input product.SaveLaunchPostsInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.SaveLaunchPosts(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

func (s *Server) listLaunchRevisions(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		revisions, err := s.configuration.ListLaunchRevisions(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"revisions": revisions}, err)
	}
}

func (s *Server) createLaunchRevision(w http.ResponseWriter, r *http.Request) {
	var input product.CreateLaunchRevisionInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.CreateLaunchRevision(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

func (s *Server) listLaunchRuns(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		runs, err := s.configuration.ListLaunchRuns(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"runs": runs}, err)
	}
}

func (s *Server) startLaunchRun(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Kind string `json:"kind"`
	}
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.StartLaunchRun(r.Context(), workspaceActor(r), id, input.Kind)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

// startAgentRun starts an agent or conversation run, with or without a campaign.
func (s *Server) startAgentRun(w http.ResponseWriter, r *http.Request) {
	var input product.StartAgentRunInput
	if !launchBody(w, r, &input) {
		return
	}
	if input.CampaignID != nil && !resourceIDPattern.MatchString(*input.CampaignID) {
		writeError(w, http.StatusBadRequest, "invalid campaignId")
		return
	}
	result, err := s.configuration.StartAgentRun(r.Context(), workspaceActor(r), input)
	writeLaunch(w, http.StatusCreated, result, err)
}

func (s *Server) listLaunchRunSteps(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		steps, err := s.configuration.ListLaunchRunSteps(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"steps": steps}, err)
	}
}

func (s *Server) appendLaunchRunStep(w http.ResponseWriter, r *http.Request) {
	var input product.LaunchRunStepInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.AppendLaunchRunStep(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

func (s *Server) listLaunchSpecs(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		specs, err := s.configuration.ListLaunchSpecs(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]any{"specs": specs}, err)
	}
}

func (s *Server) saveLaunchSpec(w http.ResponseWriter, r *http.Request) {
	var input product.SaveLaunchSpecInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.SaveLaunchSpec(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusCreated, result, err)
	}
}

func (s *Server) getLaunchSpec(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetLaunchSpec(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) approveLaunchSpec(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.ApproveLaunchSpec(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) approveLaunchPlan(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.ApproveLaunchPlan(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) getLaunchRevision(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetLaunchRevision(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) applyLaunchRevision(w http.ResponseWriter, r *http.Request) {
	var input product.ApplyLaunchRevisionInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		result, err := s.configuration.ApplyLaunchRevision(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) discardLaunchRevision(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.DiscardLaunchRevision(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) getLaunchRun(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		result, err := s.configuration.GetLaunchRun(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, result, err)
	}
}

func (s *Server) finishLaunchRun(w http.ResponseWriter, r *http.Request) {
	var input product.FinishLaunchRunInput
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		err := s.configuration.FinishLaunchRun(r.Context(), workspaceActor(r), id, input)
		writeLaunch(w, http.StatusOK, map[string]bool{"updated": true}, err)
	}
}

func (s *Server) heartbeatLaunchRun(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		running, err := s.configuration.HeartbeatLaunchRun(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]bool{"running": running}, err)
	}
}

func (s *Server) cancelLaunchRun(w http.ResponseWriter, r *http.Request) {
	if id, ok := launchID(w, r, "id"); ok {
		cancelled, err := s.configuration.CancelLaunchRun(r.Context(), workspaceActor(r), id)
		writeLaunch(w, http.StatusOK, map[string]bool{"cancelled": cancelled}, err)
	}
}

func (s *Server) setLaunchDesignCritique(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Critique map[string]any `json:"critique"`
	}
	if id, ok := launchID(w, r, "id"); ok && launchBody(w, r, &input) {
		err := s.configuration.SetLaunchDesignCritique(r.Context(), workspaceActor(r), id, input.Critique)
		writeLaunch(w, http.StatusOK, map[string]bool{"updated": true}, err)
	}
}
