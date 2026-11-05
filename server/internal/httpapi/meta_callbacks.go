package httpapi

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialconnect"
)

type metaCallbackSocial interface {
	VerifyMetaCallback(provider, signedRequest string) (string, error)
	ProviderAccountIntegrationIDs(ctx context.Context, provider, accountID string) ([]string, error)
	ForgetProviderAccount(ctx context.Context, provider, accountID string) error
}

type metaCallbackStore interface {
	RevokeProviderConnections(ctx context.Context, integrationIDs []string, confirmationCode string) ([]string, error)
}

func (s *Server) registerMetaCallbacks(mux *http.ServeMux) {
	mux.Handle("POST /v1/internal/meta-callbacks/{provider}", s.authenticateService(http.HandlerFunc(s.metaCallback)))
}

// metaCallback answers Meta's deauthorize and data deletion requests alike: both
// end the connections and erase the account's tokens and profile. Connections
// go first because erasing removes the ID that finds them, so a failure can be
// retried. An account we don't hold still gets a code, as Meta requires.
func (s *Server) metaCallback(w http.ResponseWriter, r *http.Request) {
	social, connected := s.verifier.(metaCallbackSocial)
	store, stored := s.configuration.(metaCallbackStore)
	frontend := strings.TrimSuffix(os.Getenv("FRONTEND_URL"), "/")
	if !connected || !stored || frontend == "" {
		writeError(w, http.StatusServiceUnavailable, "meta callbacks are unavailable")
		return
	}
	var in struct {
		SignedRequest string `json:"signedRequest"`
	}
	if decodeJSONLimit(r, &in, 16*1024) != nil {
		writeError(w, http.StatusBadRequest, "invalid signed request")
		return
	}
	provider := r.PathValue("provider")
	accountID, err := social.VerifyMetaCallback(provider, in.SignedRequest)
	if errors.Is(err, socialconnect.ErrMetaCallbackNotConfigured) {
		writeError(w, http.StatusServiceUnavailable, "meta callbacks are unavailable")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid signed request")
		return
	}
	integrationIDs, err := social.ProviderAccountIntegrationIDs(r.Context(), provider, accountID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	code := rand.Text()
	cancelled, err := store.RevokeProviderConnections(r.Context(), integrationIDs, code)
	s.stopCancelledPosts(r.Context(), cancelled)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if err := social.ForgetProviderAccount(r.Context(), provider, accountID); err != nil {
		writeStoreError(w, err)
		return
	}
	slog.Info("meta callback processed", "provider", provider, "integrations", len(integrationIDs), "confirmation_code", code)
	writeJSON(w, http.StatusOK, map[string]string{"url": frontend + "/data-deletion?code=" + code, "confirmation_code": code})
}
