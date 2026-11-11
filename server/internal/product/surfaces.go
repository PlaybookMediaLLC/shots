package product

import (
	"context"
	"maps"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/surfacecapture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// The product asset map (docs/rfcs/018-product-asset-map.md): stable surface
// slugs, capture rows with supersession, and a deterministic feature lookup.

// surfaceScreenshotLimit bounds the compatibility copy of capture asset IDs
// kept on product_surface.screenshotAssetIds.
const surfaceScreenshotLimit = 50

// surfaceSlug makes a URL-safe slug of at most 64 characters from a name.
func surfaceSlug(name string) string {
	var builder strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r)) {
			builder.WriteRune(r)
			dash = false
		} else if !dash && builder.Len() > 0 {
			builder.WriteByte('-')
			dash = true
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if len(slug) > 64 {
		slug = strings.TrimRight(slug[:64], "-")
	}
	if slug == "" {
		return "surface"
	}
	return slug
}

// freeSurfaceSlug returns the name's slug, numbered when another surface of
// the workspace already has it.
func freeSurfaceSlug(ctx context.Context, tx *ent.Tx, organizationID, name string) (string, error) {
	base := surfaceSlug(name)
	taken, err := tx.ProductSurface.Query().Where(productsurface.OrganizationID(organizationID),
		productsurface.Or(productsurface.Slug(base), productsurface.SlugHasPrefix(base+"-"))).
		Select(productsurface.FieldSlug).Strings(ctx)
	if err != nil {
		return "", err
	}
	slug := base
	for n := 2; slices.Contains(taken, slug); n++ {
		slug = base + "-" + strconv.Itoa(n)
	}
	return slug, nil
}

// SurfaceCaptureRecord is one capture of a product surface.
type SurfaceCaptureRecord struct {
	AssetID      string     `json:"assetId"`
	CapturedAt   time.Time  `json:"capturedAt"`
	ID           string     `json:"id"`
	Source       string     `json:"source"`
	SourceID     *string    `json:"sourceId"`
	SupersededAt *time.Time `json:"supersededAt"`
	SurfaceID    string     `json:"surfaceId"`
}

func surfaceCaptureRecord(row *ent.SurfaceCapture) SurfaceCaptureRecord {
	return SurfaceCaptureRecord{AssetID: row.AssetID, CapturedAt: row.CapturedAt, ID: row.ID, Source: string(row.Source),
		SourceID: row.SourceID, SupersededAt: row.SupersededAt, SurfaceID: row.SurfaceID}
}

// recordCapture makes assetID the surface's current capture: the previous one
// is superseded, never removed, and the surface's freshness is updated.
func recordCapture(ctx context.Context, tx *ent.Tx, actor Actor, surface *ent.ProductSurface, assetID string,
	source surfacecapture.Source, sourceID, observedRevision *string) (*ent.SurfaceCapture, error) {
	now := time.Now().UTC()
	// Locking the surface makes concurrent captures of it choose the current
	// image one at a time, each adding to what the last one left.
	surface, err := tx.ProductSurface.UpdateOneID(surface.ID).SetUpdatedAt(now).Save(ctx)
	if err != nil {
		return nil, err
	}
	current := true
	if source == surfacecapture.SourceDeployment && sourceID != nil {
		if current, err = newestDeploymentCapture(ctx, tx, surface.ID, *sourceID); err != nil {
			return nil, err
		}
	}
	if current {
		if err := tx.SurfaceCapture.Update().Where(surfacecapture.SurfaceID(surface.ID), surfacecapture.SupersededAtIsNil()).
			SetSupersededAt(now).Exec(ctx); err != nil {
			return nil, err
		}
	}
	create := tx.SurfaceCapture.Create().SetID(cuid.New()).SetOrganizationID(surface.OrganizationID).
		SetSurfaceID(surface.ID).SetAssetID(assetID).SetSource(source).SetNillableSourceID(sourceID).
		SetNillableObservedRevision(observedRevision).SetCapturedAt(now)
	if !current {
		// History only: a newer deployment's image stays current.
		create.SetSupersededAt(now)
	}
	created, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		// Another capture of this surface, or this deployment's receipt for it, committed first.
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if current {
		screenshots := append(slices.Clone(surface.ScreenshotAssetIds), assetID)
		if len(screenshots) > surfaceScreenshotLimit {
			screenshots = screenshots[len(screenshots)-surfaceScreenshotLimit:]
		}
		if err := tx.ProductSurface.UpdateOneID(surface.ID).SetLastCapturedAt(now).ClearLastCaptureFailureCode().
			SetScreenshotAssetIds(screenshots).Exec(ctx); err != nil {
			return nil, err
		}
	}
	human := ""
	background := source != surfacecapture.SourceManual
	if actor.IsSession() && !background {
		human = actor.UserID
	}
	occurrence := created.ID
	if source == surfacecapture.SourceDeployment && sourceID != nil {
		occurrence = *sourceID + ":" + surface.ID
	}
	if err = activity.Emit(ctx, tx, surface.OrganizationID, "capture.completed", "product_surface", surface.ID, human, occurrence, map[string]any{"requestedByUserId": actor.UserID, "background": background}); err != nil {
		return nil, err
	}
	return created, nil
}

// newestDeploymentCapture reports whether a deployment's capture may become
// the surface's current image: an older deployment that finishes late never
// replaces a newer deployment's. Deployments are ordered by the provider's
// deployment time, then as Shots received them.
func newestDeploymentCapture(ctx context.Context, tx *ent.Tx, surfaceID, deploymentID string) (bool, error) {
	current, err := tx.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(surfaceID), surfacecapture.SupersededAtIsNil(),
		surfacecapture.SourceEQ(surfacecapture.SourceDeployment), surfacecapture.SourceIDNotNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	rows, err := tx.DeploymentEvent.Query().Where(deploymentevent.IDIn(deploymentID, *current.SourceID)).All(ctx)
	if err != nil {
		return false, err
	}
	var mine, theirs *ent.DeploymentEvent
	for _, row := range rows {
		if row.ID == deploymentID {
			mine = row
		} else {
			theirs = row
		}
	}
	if mine == nil || theirs == nil {
		return true, nil
	}
	if !theirs.DeployedAt.Equal(mine.DeployedAt) {
		return theirs.DeployedAt.Before(mine.DeployedAt), nil
	}
	return !theirs.CreatedAt.After(mine.CreatedAt) && (theirs.CreatedAt.Before(mine.CreatedAt) || theirs.ID < mine.ID), nil
}

// RecordSurfaceCaptureInput attaches an uploaded image to a surface as its
// current capture. Deployment captures are recorded by the worker only.
type RecordSurfaceCaptureInput struct {
	AssetID  string  `json:"assetId"`
	Source   string  `json:"source"`
	SourceID *string `json:"sourceId"`
}

// RecordSurfaceCapture records an agent, release, or manual capture. It
// needs release:create, the role that creates and updates surfaces.
func (c *Configuration) RecordSurfaceCapture(ctx context.Context, actor Actor, surfaceID string, input RecordSurfaceCaptureInput) (*SurfaceCaptureRecord, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	source := surfacecapture.Source(input.Source)
	if (source != surfacecapture.SourceAgent && source != surfacecapture.SourceRelease && source != surfacecapture.SourceManual) ||
		(input.SourceID != nil && (*input.SourceID == "" || utf8.RuneCountInString(*input.SourceID) > 128)) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	surface, err := tx.ProductSurface.Query().Where(productsurface.ID(surfaceID), productsurface.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	image, err := tx.Asset.Query().Where(asset.ID(input.AssetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Asset not found.")
	}
	if err != nil {
		return nil, err
	}
	if image.Status != asset.StatusUPLOADED || !strings.HasPrefix(image.MediaType, "image/") {
		return nil, invalid("A capture must be an uploaded image.")
	}
	created, err := recordCapture(ctx, tx, actor, surface, image.ID, source, input.SourceID, nil)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.surface_captured", "product_surface", surface.ID,
		map[string]any{"assetId": image.ID, "captureId": created.ID, "source": input.Source}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := surfaceCaptureRecord(created)
	return &record, nil
}

// ListSurfaceCaptures returns a surface's 50 newest captures, current first.
func (c *Configuration) ListSurfaceCaptures(ctx context.Context, actor Actor, surfaceID string) ([]SurfaceCaptureRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	owned, err := c.client.ProductSurface.Query().Where(productsurface.ID(surfaceID), productsurface.OrganizationID(actor.OrganizationID)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !owned {
		return nil, publishing.ErrNotFound
	}
	rows, err := c.client.SurfaceCapture.Query().Where(surfacecapture.SurfaceID(surfaceID), surfacecapture.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(surfacecapture.FieldCapturedAt), ent.Desc(surfacecapture.FieldID)).Limit(50).All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]SurfaceCaptureRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, surfaceCaptureRecord(row))
	}
	return records, nil
}

// Match reasons, strongest first.
const (
	SurfaceMatchTag      = "tag"
	SurfaceMatchName     = "name"
	SurfaceMatchTokens   = "token_overlap"
	SurfaceMatchFallback = "fallback"
)

// FindSurfacesInput names a feature, optionally with tags, to look up.
type FindSurfacesInput struct {
	Feature string
	Limit   int
	Tags    []string
}

// SurfaceMatch is a surface for a feature, why it matched, and its score
// (100 for a tag, 90 for a slug or name, 10-70 by token overlap, 0 for the
// labelled fallback).
type SurfaceMatch struct {
	CurrentCaptureAssetID *string
	Reason                string
	Score                 int
	Surface               *ent.ProductSurface
}

// surfaceStopWords are left out of token overlap: they say nothing about a screen.
var surfaceStopWords = map[string]bool{"the": true, "and": true, "for": true, "our": true, "your": true, "with": true,
	"new": true, "feature": true, "features": true, "page": true, "screen": true, "market": true, "launch": true, "show": true}

// surfaceTokens lowercases text into words of two or more letters, without
// stop words or a plural s.
func surfaceTokens(texts ...string) map[string]bool {
	tokens := map[string]bool{}
	for _, text := range texts {
		for _, word := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if len(word) > 3 && strings.HasSuffix(word, "s") && !strings.HasSuffix(word, "ss") {
				word = strings.TrimSuffix(word, "s")
			}
			if utf8.RuneCountInString(word) >= 2 && !surfaceStopWords[word] {
				tokens[word] = true
			}
		}
	}
	return tokens
}

// matchSurface scores one surface for a feature; ok is false for no match.
func matchSurface(surface *ent.ProductSurface, feature string, tags []string) (string, int, bool) {
	wanted := map[string]bool{}
	for _, tag := range append(slices.Clone(tags), feature) {
		if tag = strings.ToLower(strings.TrimSpace(tag)); tag != "" {
			wanted[tag] = true
		}
	}
	want := surfaceTokens(feature)
	// A tag matches when it is one of the tags asked for, or every word of it
	// is in the feature ("approvals" in "market the approvals feature").
	for _, tag := range surface.FeatureTags {
		words := surfaceTokens(tag)
		if wanted[strings.ToLower(strings.TrimSpace(tag))] ||
			(len(words) > 0 && !slices.ContainsFunc(slices.Collect(maps.Keys(words)), func(word string) bool { return !want[word] })) {
			return SurfaceMatchTag, 100, true
		}
	}
	trimmed := strings.TrimSpace(feature)
	if trimmed != "" && (surfaceSlug(trimmed) == surface.Slug || strings.EqualFold(trimmed, surface.Name)) {
		return SurfaceMatchName, 90, true
	}
	if len(want) == 0 {
		return "", 0, false
	}
	path := ""
	if parsed, err := url.Parse(surface.URL); err == nil {
		path = parsed.Path
	}
	have := surfaceTokens(append([]string{surface.Name, surface.Slug, path, optionalText(surface.Description)}, surface.FeatureTags...)...)
	overlap := 0
	for token := range want {
		if have[token] {
			overlap++
		}
	}
	// At least a third of the feature's words must name the surface.
	if overlap == 0 || 3*overlap < len(want) {
		return "", 0, false
	}
	return SurfaceMatchTokens, 10 + 60*overlap/len(want), true
}

// isHomepage reports whether a surface is a site root.
func isHomepage(surface *ent.ProductSurface) bool {
	parsed, err := url.Parse(surface.URL)
	return err == nil && (parsed.Path == "" || parsed.Path == "/")
}

// FindSurfacesForFeature ranks the workspace's surfaces for a feature with
// no model involved: tags, then slug or name, then token overlap. With no
// match it returns the homepage, labelled as a fallback, so a caller can say
// it found no screen rather than market the homepage as the feature.
func (c *Configuration) FindSurfacesForFeature(ctx context.Context, actor Actor, input FindSurfacesInput) ([]SurfaceMatch, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if input.Limit <= 0 {
		input.Limit = 5
	}
	if strings.TrimSpace(input.Feature) == "" && len(input.Tags) == 0 || input.Limit > 20 {
		return nil, ErrInvalidInput
	}
	surfaces, err := c.client.ProductSurface.Query().Where(productsurface.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(productsurface.FieldCreatedAt), ent.Asc(productsurface.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	matches := []SurfaceMatch{}
	for _, surface := range surfaces {
		if reason, score, ok := matchSurface(surface, input.Feature, input.Tags); ok {
			matches = append(matches, SurfaceMatch{Reason: reason, Score: score, Surface: surface})
		}
	}
	slices.SortStableFunc(matches, func(a, b SurfaceMatch) int { return b.Score - a.Score })
	if len(matches) == 0 && len(surfaces) > 0 {
		fallback := surfaces[0]
		for _, surface := range surfaces {
			if isHomepage(surface) && (!isHomepage(fallback) || surface.Environment == "production" && fallback.Environment != "production") {
				fallback = surface
			}
		}
		matches = append(matches, SurfaceMatch{Reason: SurfaceMatchFallback, Score: 0, Surface: fallback})
	}
	if len(matches) > input.Limit {
		matches = matches[:input.Limit]
	}
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		ids = append(ids, match.Surface.ID)
	}
	current, err := c.client.SurfaceCapture.Query().Where(surfacecapture.OrganizationID(actor.OrganizationID),
		surfacecapture.SurfaceIDIn(ids...), surfacecapture.SupersededAtIsNil()).All(ctx)
	if err != nil {
		return nil, err
	}
	for i := range matches {
		// A screenshot set by hand on the surface, until it has a capture row.
		if ids := matches[i].Surface.ScreenshotAssetIds; len(ids) > 0 {
			matches[i].CurrentCaptureAssetID = &ids[len(ids)-1]
		}
		for _, capture := range current {
			if capture.SurfaceID == matches[i].Surface.ID {
				matches[i].CurrentCaptureAssetID = &capture.AssetID
			}
		}
	}
	return matches, nil
}
