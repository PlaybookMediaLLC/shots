package product

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

var releaseMarkup = regexp.MustCompile(`(?i)</?[a-z!][^>]*>`)

type CreateReleaseInput struct {
	Audience         *string  `json:"audience"`
	BenefitStatement string   `json:"benefitStatement"`
	Description      *string  `json:"description"`
	IdempotencyKey   string   `json:"idempotencyKey"`
	ProductSurfaceID *string  `json:"productSurfaceId"`
	SourceURLs       []string `json:"sourceUrls"`
	Title            string   `json:"title"`
}

type OptionalValue[T any] struct {
	Set   bool
	Value *T
}

func (v *OptionalValue[T]) UnmarshalJSON(data []byte) error {
	v.Set = true
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		v.Value = nil
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	v.Value = &value
	return nil
}

type UpdateReleaseInput struct {
	Audience         OptionalValue[string]   `json:"audience"`
	BenefitStatement OptionalValue[string]   `json:"benefitStatement"`
	Description      OptionalValue[string]   `json:"description"`
	ProductSurfaceID OptionalValue[string]   `json:"productSurfaceId"`
	SourceURLs       OptionalValue[[]string] `json:"sourceUrls"`
	Title            OptionalValue[string]   `json:"title"`
}

type ReleaseSummary struct {
	ID               string  `json:"id"`
	ProductSurfaceID *string `json:"productSurfaceId"`
	Status           string  `json:"status"`
	Title            string  `json:"title"`
}

type ReleaseCreation struct {
	Created bool           `json:"created"`
	Release ReleaseSummary `json:"release"`
}

type ReleaseListItem struct {
	BenefitStatement string    `json:"benefitStatement"`
	CreatedAt        time.Time `json:"createdAt"`
	// Features and ScreenshotAssetIDs are what a source's release shipped and showed.
	Features           []releasenotes.Feature `json:"features"`
	ID                 string                 `json:"id"`
	ScreenshotAssetIDs []string               `json:"screenshotAssetIds"`
	ProductSurfaceID   *string                `json:"productSurfaceId"`
	Status             string                 `json:"status"`
	Title              string                 `json:"title"`
	UpdatedAt          time.Time              `json:"updatedAt"`
}

type ReleaseSurface struct {
	Environment string `json:"environment"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	URL         string `json:"url"`
}

type ReleaseDetail struct {
	CanonicalReleaseID string                 `json:"canonicalReleaseId"`
	Audience           *string                `json:"audience"`
	BenefitStatement   string                 `json:"benefitStatement"`
	CreatedAt          time.Time              `json:"createdAt"`
	Description        *string                `json:"description"`
	Notes              *string                `json:"notes"`
	Features           []releasenotes.Feature `json:"features"`
	ScreenshotAssetIDs []string               `json:"screenshotAssetIds"`
	ID                 string                 `json:"id"`
	ProductSurface     *ReleaseSurface        `json:"productSurface"`
	ProductSurfaceID   *string                `json:"productSurfaceId"`
	SourceURLs         []string               `json:"sourceUrls"`
	Status             string                 `json:"status"`
	Title              string                 `json:"title"`
	UpdatedAt          time.Time              `json:"updatedAt"`
}

func releaseSummary(row *ent.Release) ReleaseSummary {
	return ReleaseSummary{ID: row.ID, ProductSurfaceID: row.ProductSurfaceID,
		Status: string(row.Status), Title: row.Title}
}

func releaseListItem(row *ent.Release) ReleaseListItem {
	features, screenshots := row.Features, row.ScreenshotAssetIds
	if features == nil {
		features = []releasenotes.Feature{}
	}
	if screenshots == nil {
		screenshots = []string{}
	}
	return ReleaseListItem{BenefitStatement: row.BenefitStatement, CreatedAt: row.CreatedAt, Features: features,
		ID: row.ID, ProductSurfaceID: row.ProductSurfaceID, ScreenshotAssetIDs: screenshots, Status: string(row.Status),
		Title: row.Title, UpdatedAt: row.UpdatedAt}
}

// Postgres text cannot hold NUL; letting one through fails the insert as a 5xx.
func validReleaseText(value string, max int) bool {
	return utf8.RuneCountInString(value) <= max && !releaseMarkup.MatchString(value) && !strings.ContainsRune(value, 0)
}

func validReleaseURLs(values []string) bool {
	if len(values) > 20 {
		return false
	}
	for _, value := range values {
		if len(value) > 2000 {
			return false
		}
		u, err := url.Parse(value)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return false
		}
	}
	return true
}

func validReleaseBrief(title, benefit string, audience, description *string, urls []string) bool {
	if title == "" || utf8.RuneCountInString(title) > 160 || utf8.RuneCountInString(benefit) > 500 ||
		strings.ContainsRune(title+benefit, 0) ||
		(strings.TrimSpace(benefit) == "" && len(urls) == 0) || !validReleaseURLs(urls) {
		return false
	}
	return (audience == nil || validReleaseText(*audience, 1000)) &&
		(description == nil || validReleaseText(*description, 10000))
}

func (c *Configuration) ListReleases(ctx context.Context, actor Actor, limit int, searches ...string) ([]ReleaseListItem, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, ErrInvalidInput
	}
	query := c.client.Release.Query().Where(release.OrganizationID(actor.OrganizationID))
	if len(searches) > 0 {
		search := strings.TrimSpace(searches[0])
		if utf8.RuneCountInString(search) > 200 || strings.ContainsRune(search, 0) {
			return nil, ErrInvalidInput
		}
		query.Where(release.TitleContainsFold(search))
	}
	rows, err := query.Order(ent.Desc(release.FieldUpdatedAt), ent.Desc(release.FieldID)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ReleaseListItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, releaseListItem(row))
	}
	return items, nil
}

func (c *Configuration) GetRelease(ctx context.Context, actor Actor, id string) (*ReleaseDetail, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Release.Query().Where(release.ID(id), release.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	canonical, err := canonicalReleaseID(ctx, c.client, actor.OrganizationID, id)
	if err != nil {
		return nil, err
	}
	detail := &ReleaseDetail{
		CanonicalReleaseID: canonical,
		Audience:           row.Audience, BenefitStatement: row.BenefitStatement, CreatedAt: row.CreatedAt,
		Description: row.Description, ID: row.ID, ProductSurfaceID: row.ProductSurfaceID,
		Notes: row.Notes, Features: row.Features, ScreenshotAssetIDs: row.ScreenshotAssetIds,
		SourceURLs: row.SourceUrls, Status: string(row.Status), Title: row.Title, UpdatedAt: row.UpdatedAt,
	}
	if detail.SourceURLs == nil {
		detail.SourceURLs = []string{}
	}
	if detail.Features == nil {
		detail.Features = []releasenotes.Feature{}
	}
	if detail.ScreenshotAssetIDs == nil {
		detail.ScreenshotAssetIDs = []string{}
	}
	if row.ProductSurfaceID != nil {
		surface, err := c.client.ProductSurface.Query().Where(productsurface.ID(*row.ProductSurfaceID),
			productsurface.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if surface != nil {
			detail.ProductSurface = &ReleaseSurface{Environment: surface.Environment,
				ID: surface.ID, Name: surface.Name, URL: surface.URL}
		}
	}
	return detail, nil
}

func (c *Configuration) CreateRelease(ctx context.Context, actor Actor, input CreateReleaseInput) (*ReleaseCreation, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "release:create"); err != nil {
		return nil, err
	}
	input.Title = strings.TrimSpace(input.Title)
	input.BenefitStatement = strings.TrimSpace(input.BenefitStatement)
	if !validReleaseBrief(input.Title, input.BenefitStatement, input.Audience, input.Description, input.SourceURLs) ||
		input.IdempotencyKey == "" || len(input.IdempotencyKey) > 128 {
		return nil, ErrInvalidInput
	}
	for attempt := 0; attempt < 3; attempt++ {
		tx, err := c.client.Tx(ctx)
		if err != nil {
			return nil, err
		}
		existing, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(actor.OrganizationID),
			outboxevent.IdempotencyKey(input.IdempotencyKey)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			_ = tx.Rollback()
			return nil, err
		}
		if existing != nil {
			if existing.AggregateType != "release" {
				_ = tx.Rollback()
				return nil, publishing.ErrConflict
			}
			row, err := tx.Release.Query().Where(release.ID(existing.AggregateID),
				release.OrganizationID(actor.OrganizationID)).Only(ctx)
			_ = tx.Rollback()
			if err != nil {
				return nil, err
			}
			return &ReleaseCreation{Created: false, Release: releaseSummary(row)}, nil
		}
		row, err := createReleaseInTx(ctx, tx, actor, input)
		if ent.IsConstraintError(err) {
			_ = tx.Rollback()
			continue
		}
		if err != nil {
			_ = tx.Rollback()
			return nil, err
		}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.release_created", "release", row.ID,
			map[string]any{"productSurfaceId": input.ProductSurfaceID}); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return &ReleaseCreation{Created: true, Release: releaseSummary(row.Unwrap())}, nil
	}
	return nil, publishing.ErrConflict
}

// Callers validate the brief and authorize before committing this row with their other effects.
func createReleaseInTx(ctx context.Context, tx *ent.Tx, actor Actor, input CreateReleaseInput) (*ent.Release, error) {
	if input.ProductSurfaceID != nil {
		owned, err := tx.ProductSurface.Query().Where(productsurface.ID(*input.ProductSurfaceID), productsurface.OrganizationID(actor.OrganizationID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if !owned {
			return nil, publishing.ErrNotFound
		}
	}
	// Release IDs are UUIDs, as the web created them and webhooks still do.
	id := uuid.NewString()
	create := tx.Release.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
		SetTitle(input.Title).SetBenefitStatement(input.BenefitStatement).SetSourceUrls(input.SourceURLs)
	if input.Audience != nil && *input.Audience != "" {
		create.SetAudience(*input.Audience)
	}
	if input.Description != nil && *input.Description != "" {
		create.SetDescription(*input.Description)
	}
	if input.ProductSurfaceID != nil {
		create.SetProductSurfaceID(*input.ProductSurfaceID)
	}
	if actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("release.created").SetAggregateType("release").SetAggregateID(id).
		SetPayload(map[string]any{"releaseId": id, "actorUserId": actor.UserID}).SetIdempotencyKey(input.IdempotencyKey).Exec(ctx); err != nil {
		return nil, err
	}
	return row, nil
}

func (c *Configuration) UpdateRelease(ctx context.Context, actor Actor, id string, input UpdateReleaseInput) (*ReleaseDetail, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if actor.IsSession() {
		if err := lockWorkspaceMembership(ctx, tx, actor); err != nil {
			return nil, err
		}
	}
	if err := NewConfiguration(tx.Client()).authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM organization WHERE id=$1 FOR KEY SHARE`, actor.OrganizationID); err != nil {
		return nil, err
	}
	if err := requireCanonicalRelease(ctx, tx.Client(), actor.OrganizationID, id); err != nil {
		return nil, err
	}
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM release WHERE "organizationId"=$1 AND id=$2 FOR UPDATE`, actor.OrganizationID, id); err != nil {
		return nil, err
	}
	if err := mutableReleaseCampaigns(ctx, tx, actor, id); err != nil {
		return nil, err
	}
	current, err := tx.Release.Query().Where(release.ID(id), release.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	title, benefit, audience, description, urls := current.Title, current.BenefitStatement,
		current.Audience, current.Description, current.SourceUrls
	fields := make([]string, 0, 6)
	if input.Title.Set {
		if input.Title.Value == nil {
			return nil, ErrInvalidInput
		}
		title = strings.TrimSpace(*input.Title.Value)
		fields = append(fields, "title")
	}
	if input.BenefitStatement.Set {
		if input.BenefitStatement.Value == nil {
			return nil, ErrInvalidInput
		}
		benefit = strings.TrimSpace(*input.BenefitStatement.Value)
		fields = append(fields, "benefitStatement")
	}
	if input.Audience.Set {
		audience = input.Audience.Value
		fields = append(fields, "audience")
	}
	if input.Description.Set {
		description = input.Description.Value
		fields = append(fields, "description")
	}
	if input.SourceURLs.Set {
		if input.SourceURLs.Value == nil {
			return nil, ErrInvalidInput
		}
		urls = *input.SourceURLs.Value
		fields = append(fields, "sourceUrls")
	}
	if !validReleaseBrief(title, benefit, audience, description, urls) {
		return nil, ErrInvalidInput
	}
	var surfaceID *string = current.ProductSurfaceID
	if input.ProductSurfaceID.Set {
		surfaceID = input.ProductSurfaceID.Value
		fields = append(fields, "productSurfaceId")
		if surfaceID != nil {
			owned, err := tx.ProductSurface.Query().Where(productsurface.ID(*surfaceID),
				productsurface.OrganizationID(actor.OrganizationID)).Exist(ctx)
			if err != nil {
				return nil, err
			}
			if !owned {
				return nil, publishing.ErrNotFound
			}
		}
	}
	update := tx.Release.UpdateOneID(id).SetTitle(title).SetBenefitStatement(benefit).SetSourceUrls(urls)
	if audience == nil || *audience == "" {
		update.ClearAudience()
	} else {
		update.SetAudience(*audience)
	}
	if description == nil || *description == "" {
		update.ClearDescription()
	} else {
		update.SetDescription(*description)
	}
	if surfaceID == nil {
		update.ClearProductSurfaceID()
	} else {
		update.SetProductSurfaceID(*surfaceID)
	}
	if _, err := update.Save(ctx); err != nil {
		return nil, err
	}
	// Titles are part of the factual brief; a no-op save must not invalidate review.
	if title != current.Title || benefit != current.BenefitStatement || optionalText(audience) != optionalText(current.Audience) ||
		optionalText(description) != optionalText(current.Description) || optionalText(surfaceID) != optionalText(current.ProductSurfaceID) || !slices.Equal(urls, current.SourceUrls) {
		if err := invalidateReleaseQualification(ctx, tx, actor, id); err != nil {
			return nil, err
		}
	}
	slices.Sort(fields)
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_updated", "release", id,
		map[string]any{"fields": strings.Join(fields, ",")}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.GetRelease(ctx, actor, id)
}
