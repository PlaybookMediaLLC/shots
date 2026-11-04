package httpapi

import (
	"context"
	"net/http"
	"os"
	"regexp"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialoauthstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type blueskyConnector interface {
	BeginBluesky(context.Context, socialapi.BeginBlueskyInput) (string, error)
	ExchangeBluesky(context.Context, string, string, string) (socialapi.OAuthExchange, error)
	VerifyBluesky(context.Context, socialapi.VerifyDestinationInput) (*socialidentity.Connection, error)
}

var blueskyState = regexp.MustCompile(`^[A-Za-z0-9_-]{32,512}$`)

func (s *Server) beginBluesky(w http.ResponseWriter, r *http.Request) {
	actor, session, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	var input struct {
		Operation            string `json:"operation"`
		CreationVisibility   string `json:"creationVisibility"`
		SocialSetID          string `json:"socialSetId"`
		ExpectedConnectionID string `json:"expectedConnectionId"`
		ReturnPath           string `json:"returnPath"`
	}
	if decodeJSON(r, &input) != nil || input.Operation == "" || (input.Operation != "CREATE_SET" && input.SocialSetID == "") || len(input.SocialSetID) > 160 || len(input.ExpectedConnectionID) > 160 || len(input.ReturnPath) > 200 {
		writeError(w, http.StatusBadRequest, "choose the owner and connection target")
		return
	}
	connector, available := s.verifier.(blueskyConnector)
	if os.Getenv("PLATFORM_SOCIAL_BLUESKY_ENABLED") != "true" || !available {
		writeError(w, http.StatusServiceUnavailable, "Bluesky connections are not enabled")
		return
	}
	options, binding, expected, ok := s.prepareConnectionStart(w, r, actor, session, oauthRequest{Provider: "bluesky", Operation: input.Operation, CreationVisibility: input.CreationVisibility,
		SocialSetID: input.SocialSetID, ExpectedConnectionID: input.ExpectedConnectionID, ReturnPath: input.ReturnPath})
	if !ok {
		return
	}
	state, err := connector.BeginBluesky(r.Context(), socialapi.BeginBlueskyInput{ExpectedGoOrganizationID: binding.GoOrganizationID, SecretReference: binding.SecretReference, ExpectedDestinationID: expected})
	if err != nil || !blueskyState.MatchString(state) {
		writeError(w, http.StatusServiceUnavailable, "Bluesky could not start this connection; please try again later")
		return
	}
	if err := s.store.StartOAuth(r.Context(), actor, session, state, "bluesky", binding.SecretReference, options); err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"state": state})
}

func (s *Server) connectBluesky(w http.ResponseWriter, r *http.Request) {
	actor, session, ok := oauthIdentity(w, r)
	if !ok {
		return
	}
	var input struct {
		State       string `json:"state"`
		Credentials *struct {
			Handle      string `json:"handle"`
			AppPassword string `json:"appPassword"`
		} `json:"credentials"`
	}
	if decodeJSON(r, &input) != nil || !blueskyState.MatchString(input.State) {
		writeError(w, http.StatusBadRequest, "invalid Bluesky connection attempt")
		return
	}
	// A browser workspace switch cannot retarget this attempt. Resolve the
	// original organization by its user/session-bound state, then reauthorize it.
	original, err := s.store.ResolveOAuthContext(r.Context(), actor.UserID, session, input.State, "bluesky")
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	actor.Organization = original.OrganizationID
	start, err := s.store.OAuthStart(r.Context(), actor, session, input.State, "bluesky", nil)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	var receipt *socialapi.OAuthExchange
	verifiedNow := false
	if start.ExchangeStatus == socialoauthstart.ExchangeStatusPENDING {
		if input.Credentials == nil || !socialidentity.BlueskyAppPasswordShape(input.Credentials.AppPassword) {
			writeError(w, http.StatusBadRequest, "enter a full Bluesky handle and dedicated app password")
			return
		}
		handle, err := socialidentity.BlueskyHandle(input.Credentials.Handle)
		if err != nil {
			writeError(w, http.StatusBadRequest, "enter the full Bluesky handle")
			return
		}
		connector, available := s.verifier.(blueskyConnector)
		binding, err := s.store.Binding(r.Context(), actor.Organization)
		if !available || os.Getenv("PLATFORM_SOCIAL_BLUESKY_ENABLED") != "true" || err != nil || binding == nil || binding.SecretReference != start.SecretReference {
			writeError(w, http.StatusServiceUnavailable, "Bluesky connections are unavailable for this workspace")
			return
		}
		receipt, err = s.store.ClaimOAuthExchange(r.Context(), actor, session, input.State, "bluesky")
		if err != nil {
			writeOAuthStoreError(w, err)
			return
		}
		if receipt == nil {
			connected, err := connector.ExchangeBluesky(r.Context(), input.State, handle, input.Credentials.AppPassword)
			if err != nil {
				writeError(w, http.StatusConflict, "Bluesky could not complete this attempt. Its result may be unknown; check the connection before starting again.")
				return
			}
			account, err := connector.VerifyBluesky(r.Context(), socialapi.VerifyDestinationInput{DestinationID: connected.ID, Platform: "bluesky", ExpectedGoOrganizationID: binding.GoOrganizationID, SecretReference: start.SecretReference})
			if err != nil || account.Validate("bluesky", connected.ID) != nil {
				writeError(w, http.StatusConflict, "Bluesky account verification is incomplete; check the connection before starting again")
				return
			}
			connected.Account = account
			verifiedNow = true
			if err := s.store.SaveOAuthExchange(r.Context(), actor, session, input.State, "bluesky", connected); err != nil {
				writeOAuthStoreError(w, err)
				return
			}
			receipt = &connected
		}
	} else {
		receipt, err = s.store.ClaimOAuthExchange(r.Context(), actor, session, input.State, "bluesky")
		if err != nil {
			writeOAuthStoreError(w, err)
			return
		}
	}
	if receipt == nil {
		writeError(w, http.StatusConflict, "the connection has no saved result")
		return
	}
	if !verifiedNow && start.ExchangeStatus != socialoauthstart.ExchangeStatusCOMPLETED {
		connector, available := s.verifier.(blueskyConnector)
		binding, err := s.store.Binding(r.Context(), actor.Organization)
		if !available || err != nil || binding == nil || binding.SecretReference != start.SecretReference {
			writeError(w, http.StatusServiceUnavailable, "Bluesky verification is unavailable; the saved result can be checked again later")
			return
		}
		account, err := connector.VerifyBluesky(r.Context(), socialapi.VerifyDestinationInput{DestinationID: receipt.ID, Platform: "bluesky", ExpectedGoOrganizationID: binding.GoOrganizationID, SecretReference: start.SecretReference})
		if err != nil || account.Validate("bluesky", receipt.ID) != nil || receipt.Account == nil || account.NativeID != receipt.Account.NativeID {
			writeError(w, http.StatusConflict, "the saved Bluesky connection is no longer valid")
			return
		}
	}
	connection, err := s.store.FinishOAuth(r.Context(), actor, session, input.State, "bluesky", receipt.ID)
	if err != nil {
		writeOAuthStoreError(w, err)
		return
	}
	path := original.ReturnPath
	if start.Operation == socialoauthstart.OperationCREATE_SET && connection.SocialSetID != nil {
		path = "/settings/publishing-brands/" + *connection.SocialSetID
	}
	writeJSON(w, http.StatusOK, map[string]any{"completed": true, "connectionId": connection.ID, "socialSetId": connection.SocialSetID, "organizationId": actor.Organization, "returnPath": path})
}
