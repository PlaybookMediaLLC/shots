package httpapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/google/uuid"
)

var sourceProviderPattern = regexp.MustCompile(`^[a-z0-9_-]+$`)
var secretReferencePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

// A branch name as GitHub reports it in pull_request.base.ref; a full ref or
// a character Git forbids would never match a delivery.
var sourceBranchPattern = regexp.MustCompile(`^[^\s~^:?*\[\\]+$`)

// A GitHub login, or an App bot login such as dependabot[bot].
var pullRequestAuthorPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$`)

func validSourceBranch(branch *string) bool {
	return branch == nil || (sourceBranchPattern.MatchString(*branch) && !strings.HasPrefix(*branch, "refs/") &&
		utf8.RuneCountInString(*branch) <= 255)
}

func validPullRequestAuthors(authors []string) bool {
	if len(authors) > 100 {
		return false
	}
	for _, author := range authors {
		if !pullRequestAuthorPattern.MatchString(author) {
			return false
		}
	}
	return true
}

func (s *Server) registerConfiguration(mux *http.ServeMux) {
	mux.Handle("GET /v1/social-connection-availability", s.authenticateWithOptions(http.HandlerFunc(s.socialConnectionAvailability), true, true, s.configuration.Authorize))
	mux.Handle("GET /v1/social-connection-capacity", s.authenticateConnections(http.HandlerFunc(s.socialConnectionCapacity)))
	mux.Handle("GET /v1/social-instances/mastodon", s.authenticateWithOptions(http.HandlerFunc(s.previewMastodonInstance), true, true, s.configuration.Authorize))
	mux.Handle("GET /v1/brand-kits", s.authenticateProduct(http.HandlerFunc(s.listBrandKits)))
	mux.Handle("POST /v1/brand-kits", s.authenticateProduct(http.HandlerFunc(s.createBrandKit)))
	mux.Handle("GET /v1/brand-profile", s.authenticateProduct(http.HandlerFunc(s.getBrandProfile)))
	mux.Handle("POST /v1/brand-profile", s.authenticateProduct(http.HandlerFunc(s.upsertBrandProfile)))
	mux.Handle("GET /v1/product-profile", s.authenticateProduct(http.HandlerFunc(s.getProductProfile)))
	mux.Handle("POST /v1/product-profile", s.authenticateProduct(http.HandlerFunc(s.upsertProductProfile)))
	mux.Handle("POST /v1/source-apps", s.authenticateProduct(http.HandlerFunc(s.createSourceApp)))
	mux.Handle("PATCH /v1/source-apps/{id}", s.authenticateProduct(http.HandlerFunc(s.updateSourceApp)))
	mux.Handle("GET /v1/product-surfaces", s.authenticateProduct(http.HandlerFunc(s.listProductSurfaces)))
	mux.Handle("POST /v1/product-surfaces", s.authenticateProduct(http.HandlerFunc(s.createProductSurface)))
	mux.Handle("PATCH /v1/product-surfaces/{id}", s.authenticateProduct(http.HandlerFunc(s.updateProductSurface)))
	mux.Handle("DELETE /v1/product-surfaces/{id}", s.authenticateProduct(http.HandlerFunc(s.deleteProductSurface)))
	mux.Handle("GET /v1/product-surfaces/match", s.authenticateProduct(http.HandlerFunc(s.findProductSurfaces)))
	mux.Handle("GET /v1/product-surfaces/{id}/captures", s.authenticateProduct(http.HandlerFunc(s.listSurfaceCaptures)))
	mux.Handle("POST /v1/product-surfaces/{id}/captures", s.authenticateProduct(http.HandlerFunc(s.recordSurfaceCapture)))
}

func (s *Server) configurationActor(w http.ResponseWriter, r *http.Request) (product.Actor, bool) {
	actor := requestActor(r)
	if err := s.configuration.Authorize(r.Context(), actor); err != nil {
		writeStoreError(w, err)
		return product.Actor{}, false
	}
	return actor, true
}

func (s *Server) productReadActor(w http.ResponseWriter, r *http.Request) (product.Actor, bool) {
	actor := requestActor(r)
	if err := s.configuration.AuthorizeRead(r.Context(), actor); err != nil {
		writeStoreError(w, err)
		return product.Actor{}, false
	}
	return actor, true
}

// listBrandKits is open to every member: the editor applies brand kits.
// Creating, renaming, and archiving them stays with owners and admins.
func (s *Server) listBrandKits(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.productReadActor(w, r)
	if !ok {
		return
	}
	kits, err := s.configuration.ListBrandKits(r.Context(), actor.OrganizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]any, 0, len(kits))
	for _, kit := range kits {
		items = append(items, brandKitResponse(kit))
	}
	writeJSON(w, http.StatusOK, map[string]any{"brandKits": items})
}

func (s *Server) createBrandKit(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input product.CreateBrandKitInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	// The definition itself is validated by the product layer.
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 100 || input.Definition == nil {
		writeError(w, http.StatusBadRequest, "name and definition are required")
		return
	}
	kit, err := s.configuration.CreateBrandKit(r.Context(), actor, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, brandKitResponse(kit))
}

func (s *Server) getBrandProfile(w http.ResponseWriter, r *http.Request) {
	// Writers can inspect inherited guidance without access to the editable profile.
	if r.URL.Query().Get("view") == "writing-defaults" {
		if actor := requestActor(r); actor.Kind != "session" && actor.Kind != "" {
			writeError(w, http.StatusForbidden, "sign in to read writing defaults")
			return
		}
		actor, ok := s.productReadActor(w, r)
		if !ok {
			return
		}
		profile, err := s.configuration.GetBrandProfile(r.Context(), actor.OrganizationID)
		if err != nil {
			writeStoreError(w, err)
			return
		}
		tone, audience := "", ""
		terms := []string{}
		if profile != nil {
			tone, audience = profile.Tone, profile.Audience
			for _, term := range profile.ProhibitedTerms {
				terms = append(terms, term.Term)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"tone": tone, "audience": audience, "prohibitedPhrases": terms})
		return
	}
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	profile, err := s.configuration.GetBrandProfile(r.Context(), actor.OrganizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if profile == nil {
		writeJSON(w, http.StatusOK, map[string]any{"brandProfile": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"brandProfile": brandProfileResponse(profile)})
}

func (s *Server) upsertBrandProfile(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input product.UpsertBrandProfileInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Audience = strings.TrimSpace(input.Audience)
	input.ProductDescription = strings.TrimSpace(input.ProductDescription)
	input.Tone = strings.TrimSpace(input.Tone)
	input.Tagline = product.TrimOptional(input.Tagline)
	input.CtaConventions = product.TrimOptional(input.CtaConventions)
	if input.Audience == "" || utf8.RuneCountInString(input.Audience) > 1000 ||
		input.ProductDescription == "" || utf8.RuneCountInString(input.ProductDescription) > 2000 ||
		input.Tone == "" || utf8.RuneCountInString(input.Tone) > 500 ||
		len(input.PreferredStyles) > 50 ||
		(input.Tagline != nil && utf8.RuneCountInString(*input.Tagline) > 200) ||
		(input.CtaConventions != nil && utf8.RuneCountInString(*input.CtaConventions) > 1000) {
		writeError(w, http.StatusBadRequest, "invalid brand profile")
		return
	}
	// Prohibited terms are normalized and bounded in the product layer.
	for _, value := range input.PreferredStyles {
		if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 100 {
			writeError(w, http.StatusBadRequest, "invalid brand profile term")
			return
		}
	}
	if input.PreferredStyles == nil {
		input.PreferredStyles = []string{}
	}
	if input.SocialHandles == nil {
		input.SocialHandles = map[string]string{}
	}
	for _, value := range input.SocialHandles {
		if utf8.RuneCountInString(strings.TrimSpace(value)) > 160 {
			writeError(w, http.StatusBadRequest, "invalid social handle")
			return
		}
	}
	profile, err := s.configuration.UpsertBrandProfile(r.Context(), actor, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, brandProfileResponse(profile))
}

func (s *Server) getProductProfile(w http.ResponseWriter, r *http.Request) {
	profile, err := s.configuration.GetProductProfile(r.Context(), workspaceActor(r))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"productProfile": profile})
}

// upsertProductProfile validates and applies the change in the product layer.
func (s *Server) upsertProductProfile(w http.ResponseWriter, r *http.Request) {
	var input product.UpsertProductProfileInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	profile, err := s.configuration.UpsertProductProfile(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

func (s *Server) createSourceApp(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input product.CreateSourceAppInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Provider = strings.ToLower(strings.TrimSpace(input.Provider))
	if input.Provider == "" {
		input.Provider = "generic"
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 100 ||
		len(input.Provider) > 64 || !sourceProviderPattern.MatchString(input.Provider) ||
		len(input.AllowedHosts) < 1 || len(input.AllowedHosts) > 50 ||
		(input.ExternalID != nil && (strings.TrimSpace(*input.ExternalID) == "" || utf8.RuneCountInString(*input.ExternalID) > 160)) ||
		!validSourceBranch(input.Branch) || !validPullRequestAuthors(input.IgnoredPullRequestAuthors) ||
		(input.GitHubConnectionID != nil && !resourceIDPattern.MatchString(*input.GitHubConnectionID)) ||
		(input.SecretReference != nil && !secretReferencePattern.MatchString(*input.SecretReference)) {
		writeError(w, http.StatusBadRequest, "invalid source app")
		return
	}
	for _, host := range input.AllowedHosts {
		u, err := url.Parse(host)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			writeError(w, http.StatusBadRequest, "invalid allowed host URL")
			return
		}
	}
	created, err := s.configuration.CreateSourceApp(r.Context(), actor, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, sourceAppResponse(created))
}

func (s *Server) updateSourceApp(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid source app ID")
		return
	}
	// Branch is raw so an explicit null (follow the default branch) differs from absent.
	var body struct {
		Branch                    json.RawMessage `json:"branch"`
		IgnoreBotPullRequests     *bool           `json:"ignoreBotPullRequests"`
		IgnoredPullRequestAuthors *[]string       `json:"ignoredPullRequestAuthors"`
		SkipPrereleases           *bool           `json:"skipPrereleases"`
	}
	if err := decodeJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input := product.UpdateSourceAppInput{IgnoreBotPullRequests: body.IgnoreBotPullRequests,
		IgnoredPullRequestAuthors: body.IgnoredPullRequestAuthors, SkipPrereleases: body.SkipPrereleases}
	switch {
	case len(body.Branch) == 0:
	case string(body.Branch) == "null":
		input.ClearBranch = true
	default:
		if err := json.Unmarshal(body.Branch, &input.Branch); err != nil {
			writeError(w, http.StatusBadRequest, "invalid source app")
			return
		}
	}
	unchanged := len(body.Branch) == 0 && input.IgnoreBotPullRequests == nil &&
		input.IgnoredPullRequestAuthors == nil && input.SkipPrereleases == nil
	if unchanged || !validSourceBranch(input.Branch) ||
		(input.IgnoredPullRequestAuthors != nil && !validPullRequestAuthors(*input.IgnoredPullRequestAuthors)) {
		writeError(w, http.StatusBadRequest, "invalid source app")
		return
	}
	updated, err := s.configuration.UpdateSourceApp(r.Context(), actor, id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sourceAppResponse(updated))
}

func brandKitResponse(v *ent.BrandKit) map[string]any {
	return map[string]any{
		"id": v.ID, "organizationId": v.OrganizationID, "name": v.Name,
		"version": v.Version, "definition": v.Definition, "status": v.Status,
		"createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt,
	}
}

func brandProfileResponse(v *ent.BrandProfile) map[string]any {
	return map[string]any{
		"id": v.ID, "organizationId": v.OrganizationID,
		"productDescription": v.ProductDescription, "audience": v.Audience,
		"tone": v.Tone, "tagline": v.Tagline, "ctaConventions": v.CtaConventions,
		"prohibitedTerms": v.ProhibitedTerms, "preferredStyles": v.PreferredStyles,
		"socialHandles": v.SocialHandles, "createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt,
	}
}

func sourceAppResponse(v *ent.SourceApp) map[string]any {
	return map[string]any{
		"id": v.ID, "organizationId": v.OrganizationID, "name": v.Name,
		"provider": v.Provider, "externalId": v.ExternalID, "branch": v.Branch,
		"ignoreBotPullRequests": v.IgnoreBotPullRequests, "skipPrereleases": v.SkipPrereleases,
		"ignoredPullRequestAuthors": v.IgnoredPullRequestAuthors, "allowedHosts": v.AllowedHosts,
		"secretReference": v.SecretReference, "status": v.Status, "createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt,
	}
}

func (s *Server) listProductSurfaces(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.productReadActor(w, r)
	if !ok {
		return
	}
	surfaces, err := s.configuration.ListProductSurfaces(r.Context(), actor.OrganizationID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]any, 0, len(surfaces))
	for _, surface := range surfaces {
		items = append(items, productSurfaceResponse(surface))
	}
	writeJSON(w, http.StatusOK, map[string]any{"productSurfaces": items})
}

func (s *Server) createProductSurface(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	var input product.CreateProductSurfaceInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.URL = strings.TrimSpace(input.URL)
	if input.Environment == "" {
		input.Environment = "production"
	}
	if input.FeatureTags == nil {
		input.FeatureTags = []string{}
	}
	if input.ScreenshotAssetIDs == nil {
		input.ScreenshotAssetIDs = []string{}
	}
	if !validSurfaceName(input.Name) || !validSurfaceURL(input.URL) || !validSurfaceEnvironment(input.Environment) ||
		!validSurfaceDescription(input.Description) || !validSurfaceTags(input.FeatureTags) || !validSurfaceAssets(input.ScreenshotAssetIDs) {
		writeError(w, http.StatusBadRequest, "invalid product surface")
		return
	}
	surface, err := s.configuration.CreateProductSurface(r.Context(), actor, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, productSurfaceResponse(surface))
}

func (s *Server) updateProductSurface(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid product surface ID")
		return
	}
	var input product.UpdateProductSurfaceInput
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if input.Name != nil {
		trimmed := strings.TrimSpace(*input.Name)
		input.Name = &trimmed
	}
	if input.URL != nil {
		trimmed := strings.TrimSpace(*input.URL)
		input.URL = &trimmed
	}
	if (input.Name != nil && !validSurfaceName(*input.Name)) ||
		(input.URL != nil && !validSurfaceURL(*input.URL)) ||
		(input.Environment != nil && !validSurfaceEnvironment(*input.Environment)) ||
		!validSurfaceDescription(input.Description) ||
		(input.FeatureTags != nil && !validSurfaceTags(*input.FeatureTags)) ||
		(input.ScreenshotAssetIDs != nil && !validSurfaceAssets(*input.ScreenshotAssetIDs)) {
		writeError(w, http.StatusBadRequest, "invalid product surface")
		return
	}
	surface, err := s.configuration.UpdateProductSurface(r.Context(), actor, id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, productSurfaceResponse(surface))
}

func (s *Server) deleteProductSurface(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.configurationActor(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid product surface ID")
		return
	}
	if err := s.configuration.DeleteProductSurface(r.Context(), actor, id); err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// resourceIDPattern bounds path and body IDs: cuids, and the UUIDs used for
// releases and workspaces. Ownership is still checked against the workspace.
var resourceIDPattern = regexp.MustCompile(`^(?:[a-z0-9]{10,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)

func validSurfaceName(value string) bool {
	return value != "" && utf8.RuneCountInString(value) <= 160
}
func validSurfaceURL(value string) bool {
	if len(value) > 2000 {
		return false
	}
	u, err := url.Parse(value)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != ""
}
func validSurfaceEnvironment(value string) bool {
	return value == "production" || value == "staging" || value == "demo" || value == "development"
}
func validSurfaceDescription(value *string) bool {
	return value == nil || utf8.RuneCountInString(*value) <= 1000
}
func validSurfaceTags(values []string) bool {
	if len(values) > 50 {
		return false
	}
	for _, value := range values {
		if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 100 {
			return false
		}
	}
	return true
}
func validSurfaceAssets(values []string) bool {
	if len(values) > 50 {
		return false
	}
	for _, value := range values {
		if _, err := uuid.Parse(value); err != nil {
			return false
		}
	}
	return true
}

func productSurfaceResponse(v *ent.ProductSurface) map[string]any {
	return map[string]any{
		"id": v.ID, "organizationId": v.OrganizationID, "name": v.Name, "slug": v.Slug, "url": v.URL,
		"environment": v.Environment, "description": v.Description,
		"featureTags": v.FeatureTags, "screenshotAssetIds": v.ScreenshotAssetIds,
		"lastCapturedAt": v.LastCapturedAt, "lastCaptureFailureCode": v.LastCaptureFailureCode,
		"createdAt": v.CreatedAt, "updatedAt": v.UpdatedAt,
	}
}

// findProductSurfaces ranks surfaces for ?feature= and repeated ?tag=.
func (s *Server) findProductSurfaces(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	input := product.FindSurfacesInput{Feature: strings.TrimSpace(query.Get("feature")), Tags: query["tag"]}
	if raw := query.Get("limit"); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid limit")
			return
		}
		input.Limit = limit
	}
	if utf8.RuneCountInString(input.Feature) > 500 || !validSurfaceTags(input.Tags) {
		writeError(w, http.StatusBadRequest, "invalid surface lookup")
		return
	}
	matches, err := s.configuration.FindSurfacesForFeature(r.Context(), workspaceActor(r), input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]any, 0, len(matches))
	for _, match := range matches {
		items = append(items, map[string]any{"surface": productSurfaceResponse(match.Surface), "reason": match.Reason,
			"score": match.Score, "currentCaptureAssetId": match.CurrentCaptureAssetID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"matches": items})
}

func (s *Server) listSurfaceCaptures(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid product surface ID")
		return
	}
	captures, err := s.configuration.ListSurfaceCaptures(r.Context(), workspaceActor(r), id)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"captures": captures})
}

func (s *Server) recordSurfaceCapture(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !resourceIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, "invalid product surface ID")
		return
	}
	var input product.RecordSurfaceCaptureInput
	if err := decodeJSON(r, &input); err != nil || !validSurfaceAssets([]string{input.AssetID}) {
		writeError(w, http.StatusBadRequest, "invalid surface capture")
		return
	}
	capture, err := s.configuration.RecordSurfaceCapture(r.Context(), workspaceActor(r), id, input)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, capture)
}
