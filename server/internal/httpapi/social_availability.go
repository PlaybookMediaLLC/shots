package httpapi

import (
	"context"
	"net/http"
	"os"
	"slices"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

type connectionAvailabilityReader interface {
	ConnectionAvailability(context.Context, string, string) (*socialidentity.ConnectionAvailability, error)
}

func (s *Server) socialConnectionCapacity(w http.ResponseWriter, r *http.Request) {
	capacity, err := s.configuration.GetChannelCapacity(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, capacity)
}

func (s *Server) socialConnectionAvailability(w http.ResponseWriter, r *http.Request) {
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "this request does not accept a workspace or provider override")
		return
	}
	actor := workspaceActor(r)
	decision, err := s.configuration.GetFeatureDecision(r.Context(), actor, "content:drafts")
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if decision == nil || !decision.Allowed {
		denied := &product.FeatureNotEntitledError{Feature: "content:drafts", RequiredPlan: "pro"}
		if decision != nil {
			denied.CurrentPlan = decision.CurrentPlan
		}
		writeStoreError(w, denied)
		return
	}
	binding, err := s.store.Binding(r.Context(), actor.OrganizationID)
	reader, supported := s.verifier.(connectionAvailabilityReader)
	if err != nil || binding == nil || !supported {
		writeError(w, http.StatusServiceUnavailable, "Social connections are unavailable for this workspace")
		return
	}
	result, err := reader.ConnectionAvailability(r.Context(), binding.GoOrganizationID, binding.SecretReference)
	if err != nil || result == nil || result.Validate() != nil {
		writeError(w, http.StatusServiceUnavailable, "Connection availability could not be checked. Please try again.")
		return
	}
	// The product and adapter must both enable a staged connection method.
	// Do not mutate a reader's snapshot when applying this deployment's gates.
	catalog := *result
	catalog.Providers = slices.Clone(result.Providers)
	for i, item := range catalog.Providers {
		if item.Provider == "bluesky" && os.Getenv("PLATFORM_SOCIAL_BLUESKY_ENABLED") != "true" || item.Provider == "mastodon-custom" && os.Getenv("PLATFORM_SOCIAL_CUSTOM_MASTODON_ENABLED") != "true" {
			catalog.Providers[i].Status = "disabled"
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, catalog)
}
