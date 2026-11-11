package product

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaign"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignasset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/campaignpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentangle"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/productsurface"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Channels are lowercase identifiers such as `x`, `linkedin`, or `product_hunt`.
var campaignChannelPattern = regexp.MustCompile(`^[a-z0-9_-]+$`)

type CampaignAngleInput struct {
	Hook  string `json:"hook"`
	Title string `json:"title"`
}

type CampaignPostInput struct {
	AngleIndex   *int    `json:"angleIndex"`
	CallToAction *string `json:"callToAction"`
	Channel      string  `json:"channel"`
	Copy         string  `json:"copy"`
}

type CreateCampaignInput struct {
	Angles   []CampaignAngleInput `json:"angles"`
	Audience *string              `json:"audience"`
	Feature  *string              `json:"feature"`
	// IdempotencyKey makes a retried create return the first campaign.
	IdempotencyKey   *string             `json:"idempotencyKey"`
	Messaging        *string             `json:"messaging"`
	Name             string              `json:"name"`
	Objective        string              `json:"objective"`
	Posts            []CampaignPostInput `json:"posts"`
	ProductSurfaceID *string             `json:"productSurfaceId"`
	ReleaseID        *string             `json:"releaseId"`
}

type CampaignReleaseLink struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type CampaignItem struct {
	Audience         *string              `json:"audience"`
	CreatedAt        time.Time            `json:"createdAt"`
	CreatedByUserID  *string              `json:"createdByUserId"`
	Feature          *string              `json:"feature"`
	ID               string               `json:"id"`
	Messaging        *string              `json:"messaging"`
	Name             string               `json:"name"`
	Objective        string               `json:"objective"`
	OrganizationID   string               `json:"organizationId"`
	ProductSurfaceID *string              `json:"productSurfaceId"`
	Release          *CampaignReleaseLink `json:"release"`
	ReleaseID        *string              `json:"releaseId"`
	Status           string               `json:"status"`
	UpdatedAt        time.Time            `json:"updatedAt"`
}

type CampaignAngle struct {
	CampaignID     string    `json:"campaignId"`
	CreatedAt      time.Time `json:"createdAt"`
	Hook           string    `json:"hook"`
	ID             string    `json:"id"`
	OrganizationID string    `json:"organizationId"`
	Position       int       `json:"position"`
	Title          string    `json:"title"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

type CampaignPostItem struct {
	AngleID           *string          `json:"angleId"`
	ApprovedAt        *time.Time       `json:"approvedAt"`
	ApprovedByUserID  *string          `json:"approvedByUserId"`
	CallToAction      *string          `json:"callToAction"`
	CampaignID        string           `json:"campaignId"`
	Channel           string           `json:"channel"`
	Claims            []map[string]any `json:"claims"`
	Copy              string           `json:"copy"`
	CreatedAt         time.Time        `json:"createdAt"`
	CreativeVariantID *string          `json:"creativeVariantId"`
	ID                string           `json:"id"`
	OrganizationID    string           `json:"organizationId"`
	Phase             *string          `json:"phase"`
	PlanItemKey       *string          `json:"planItemKey"`
	PlanVersion       *int             `json:"planVersion"`
	ReviewNote        *string          `json:"reviewNote"`
	ScheduledAt       *time.Time       `json:"scheduledAt"`
	ScheduledPostID   *string          `json:"scheduledPostId"`
	// ScheduledPostStatus is the delivery state of ScheduledPostID.
	ScheduledPostStatus *string   `json:"scheduledPostStatus"`
	SpecVersion         *int      `json:"specVersion"`
	Status              string    `json:"status"`
	Title               *string   `json:"title"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type CampaignAssetItem struct {
	Asset struct {
		Height    *int   `json:"height"`
		ID        string `json:"id"`
		MediaType string `json:"mediaType"`
		ObjectKey string `json:"objectKey"`
		Width     *int   `json:"width"`
	} `json:"asset"`
	AssetID        string    `json:"assetId"`
	CampaignID     string    `json:"campaignId"`
	Caption        *string   `json:"caption"`
	CreatedAt      time.Time `json:"createdAt"`
	ID             string    `json:"id"`
	Kind           string    `json:"kind"`
	OrganizationID string    `json:"organizationId"`
	PlanAssetKey   *string   `json:"planAssetKey"`
	PlanVersion    *int      `json:"planVersion"`
	VariantLabel   *string   `json:"variantLabel"`
}

type CampaignReleaseDetail struct {
	Audience         *string   `json:"audience"`
	BenefitStatement string    `json:"benefitStatement"`
	Description      *string   `json:"description"`
	ID               string    `json:"id"`
	SourceURLs       []string  `json:"sourceUrls"`
	Status           string    `json:"status"`
	Title            string    `json:"title"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

type CampaignDetail struct {
	CampaignItem
	// Created is set by CreateCampaign: false when an idempotency key replayed.
	Created        *bool                  `json:"created,omitempty"`
	Angles         []CampaignAngle        `json:"angles"`
	Assets         []CampaignAssetItem    `json:"assets"`
	Posts          []CampaignPostItem     `json:"posts"`
	ProductSurface *ReleaseSurface        `json:"productSurface"`
	Release        *CampaignReleaseDetail `json:"release"`
}

func campaignItem(row *ent.Campaign) CampaignItem {
	return CampaignItem{Audience: row.Audience, CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID,
		Feature: row.Feature, ID: row.ID, Messaging: row.Messaging, Name: row.Name, Objective: row.Objective,
		OrganizationID: row.OrganizationID, ProductSurfaceID: row.ProductSurfaceID, ReleaseID: row.ReleaseID,
		Status: string(row.Status), UpdatedAt: row.UpdatedAt}
}

func campaignPostItem(post *ent.CampaignPost) CampaignPostItem {
	claims := post.Claims
	if claims == nil {
		claims = []map[string]any{}
	}
	return CampaignPostItem{AngleID: post.AngleID, ApprovedAt: post.ApprovedAt, ApprovedByUserID: post.ApprovedByUserID,
		CallToAction: post.CallToAction,
		CampaignID:   post.CampaignID, Channel: post.Channel, Claims: claims, Copy: post.Copy, CreatedAt: post.CreatedAt,
		CreativeVariantID: post.CreativeVariantID, ID: post.ID, OrganizationID: post.OrganizationID,
		Phase: post.Phase, PlanItemKey: post.PlanItemKey, PlanVersion: post.PlanVersion,
		ReviewNote: post.ReviewNote, ScheduledAt: post.ScheduledAt, ScheduledPostID: post.ScheduledPostID,
		SpecVersion: post.SpecVersion, Status: string(post.Status), Title: post.Title, UpdatedAt: post.UpdatedAt}
}

func (c *Configuration) ListCampaigns(ctx context.Context, actor Actor) ([]CampaignItem, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.Campaign.Query().Where(campaign.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(campaign.FieldCreatedAt), ent.Desc(campaign.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]CampaignItem, 0, len(rows))
	for _, row := range rows {
		item := campaignItem(row)
		if row.ReleaseID != nil {
			linked, err := c.client.Release.Query().Where(release.ID(*row.ReleaseID), release.OrganizationID(actor.OrganizationID)).Only(ctx)
			if err != nil && !ent.IsNotFound(err) {
				return nil, err
			}
			if linked != nil {
				item.Release = &CampaignReleaseLink{ID: linked.ID, Title: linked.Title}
			}
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Configuration) GetCampaign(ctx context.Context, actor Actor, id string) (*CampaignDetail, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.Campaign.Query().Where(campaign.ID(id), campaign.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	detail := &CampaignDetail{CampaignItem: campaignItem(row), Angles: []CampaignAngle{}, Assets: []CampaignAssetItem{}, Posts: []CampaignPostItem{}}
	if row.ReleaseID != nil {
		linked, err := c.client.Release.Query().Where(release.ID(*row.ReleaseID), release.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if linked != nil {
			detail.Release = &CampaignReleaseDetail{Audience: linked.Audience, BenefitStatement: linked.BenefitStatement,
				Description: linked.Description, ID: linked.ID, SourceURLs: linked.SourceUrls, Status: string(linked.Status),
				Title: linked.Title, UpdatedAt: linked.UpdatedAt}
		}
	}
	if row.ProductSurfaceID != nil {
		surface, err := c.client.ProductSurface.Query().Where(productsurface.ID(*row.ProductSurfaceID),
			productsurface.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if surface != nil {
			detail.ProductSurface = &ReleaseSurface{Environment: surface.Environment, ID: surface.ID, Name: surface.Name, URL: surface.URL}
		}
	}
	angles, err := c.client.ContentAngle.Query().Where(contentangle.CampaignID(id), contentangle.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(contentangle.FieldPosition)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, angle := range angles {
		detail.Angles = append(detail.Angles, CampaignAngle{CampaignID: id, CreatedAt: angle.CreatedAt,
			Hook: angle.Hook, ID: angle.ID, OrganizationID: actor.OrganizationID,
			Position: angle.Position, Title: angle.Title, UpdatedAt: angle.UpdatedAt})
	}
	posts, err := c.client.CampaignPost.Query().Where(campaignpost.CampaignID(id), campaignpost.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(campaignpost.FieldCreatedAt), ent.Asc(campaignpost.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	scheduledIDs := []string{}
	for _, post := range posts {
		if post.ScheduledPostID != nil {
			scheduledIDs = append(scheduledIDs, *post.ScheduledPostID)
		}
	}
	scheduled, err := c.client.ScheduledPost.Query().Where(scheduledpost.IDIn(scheduledIDs...),
		scheduledpost.OrganizationID(actor.OrganizationID)).All(ctx)
	if err != nil {
		return nil, err
	}
	delivery := make(map[string]*ent.ScheduledPost, len(scheduled))
	for _, row := range scheduled {
		delivery[row.ID] = row
	}
	for _, post := range posts {
		item := campaignPostItem(post)
		if post.ScheduledPostID != nil && delivery[*post.ScheduledPostID] != nil {
			item = scheduledCampaignPostItem(post, delivery[*post.ScheduledPostID])
		}
		detail.Posts = append(detail.Posts, item)
	}
	links, err := c.client.CampaignAsset.Query().Where(campaignasset.CampaignID(id), campaignasset.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(campaignasset.FieldCreatedAt), ent.Asc(campaignasset.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, link := range links {
		media, err := c.client.Asset.Query().Where(asset.ID(link.AssetID), asset.OrganizationID(actor.OrganizationID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		if media == nil {
			continue
		}
		item := CampaignAssetItem{AssetID: link.AssetID, CampaignID: id, Caption: link.Caption,
			CreatedAt: link.CreatedAt, ID: link.ID, Kind: link.Kind, OrganizationID: actor.OrganizationID,
			PlanAssetKey: link.PlanAssetKey, PlanVersion: link.PlanVersion, VariantLabel: link.VariantLabel}
		item.Asset.Height, item.Asset.ID, item.Asset.MediaType = media.Height, media.ID, media.MediaType
		item.Asset.ObjectKey, item.Asset.Width = media.ObjectKey, media.Width
		detail.Assets = append(detail.Assets, item)
	}
	return detail, nil
}

// campaignPostTexts lists the copy and calls to action checked against the brand.
func campaignPostTexts(posts []CampaignPostInput) []string {
	texts := make([]string, 0, 2*len(posts))
	for _, post := range posts {
		texts = append(texts, post.Copy, optionalText(post.CallToAction))
	}
	return texts
}

func validCampaignCreate(input CreateCampaignInput) bool {
	if input.IdempotencyKey != nil && (*input.IdempotencyKey == "" || len(*input.IdempotencyKey) > 128) {
		return false
	}
	if strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > 160 ||
		strings.TrimSpace(input.Objective) == "" || utf8.RuneCountInString(input.Objective) > 500 ||
		len(input.Angles) > 20 || len(input.Posts) > 50 {
		return false
	}
	for _, optional := range []struct {
		value *string
		max   int
	}{
		{input.Audience, 1000}, {input.Feature, 500}, {input.Messaging, 2000},
	} {
		if optional.value != nil && utf8.RuneCountInString(*optional.value) > optional.max {
			return false
		}
	}
	for _, angle := range input.Angles {
		if strings.TrimSpace(angle.Hook) == "" || utf8.RuneCountInString(angle.Hook) > 1000 ||
			strings.TrimSpace(angle.Title) == "" || utf8.RuneCountInString(angle.Title) > 200 {
			return false
		}
	}
	for _, post := range input.Posts {
		if post.AngleIndex != nil && (*post.AngleIndex < 0 || *post.AngleIndex >= len(input.Angles)) ||
			!campaignChannelPattern.MatchString(post.Channel) || len(post.Channel) > 64 ||
			strings.TrimSpace(post.Copy) == "" || utf8.RuneCountInString(post.Copy) > 10000 ||
			(post.CallToAction != nil && utf8.RuneCountInString(*post.CallToAction) > 300) {
			return false
		}
	}
	return true
}

func (c *Configuration) CreateCampaign(ctx context.Context, actor Actor, input CreateCampaignInput) (*CampaignDetail, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	input.Name, input.Objective = strings.TrimSpace(input.Name), strings.TrimSpace(input.Objective)
	if input.IdempotencyKey != nil {
		key := strings.TrimSpace(*input.IdempotencyKey)
		input.IdempotencyKey = &key
	}
	if !validCampaignCreate(input) {
		return nil, ErrInvalidInput
	}
	if replayed, err := c.replayCampaign(ctx, actor, input.IdempotencyKey); replayed != nil || err != nil {
		return replayed, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var linkedRelease *ent.Release
	if input.ReleaseID != nil {
		linkedRelease, err = tx.Release.Query().Where(release.ID(*input.ReleaseID), release.OrganizationID(actor.OrganizationID)).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, publishing.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
	}
	surfaceID := input.ProductSurfaceID
	if surfaceID == nil && linkedRelease != nil {
		surfaceID = linkedRelease.ProductSurfaceID
	}
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
	if err := requireAllowedCopy(ctx, tx.Client(), actor.OrganizationID, nil, campaignPostTexts(input.Posts)...); err != nil {
		return nil, err
	}
	organization, err := tx.Organization.Get(ctx, actor.OrganizationID)
	if err != nil {
		return nil, err
	}
	id := cuid.New()
	create := tx.Campaign.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetName(input.Name).
		SetObjective(input.Objective)
	if input.Audience != nil && *input.Audience != "" {
		create.SetAudience(*input.Audience)
	}
	if input.Feature != nil && *input.Feature != "" {
		create.SetFeature(*input.Feature)
	}
	if input.Messaging != nil && *input.Messaging != "" {
		create.SetMessaging(*input.Messaging)
	}
	if linkedRelease != nil {
		create.SetReleaseID(linkedRelease.ID)
	}
	if surfaceID != nil {
		create.SetProductSurfaceID(*surfaceID)
	}
	if actor.UserID != "" {
		create.SetCreatedByUserID(actor.UserID)
	}
	create.SetNillableIdempotencyKey(input.IdempotencyKey)
	if _, err := create.Save(ctx); err != nil {
		// A concurrent create with the same key won; return its campaign.
		if ent.IsConstraintError(err) && input.IdempotencyKey != nil {
			_ = tx.Rollback()
			return c.replayCampaign(ctx, actor, input.IdempotencyKey)
		}
		return nil, err
	}
	angleIDs := make([]string, 0, len(input.Angles))
	for position, angle := range input.Angles {
		angleID := cuid.New()
		if _, err := tx.ContentAngle.Create().SetID(angleID).SetOrganizationID(actor.OrganizationID).
			SetCampaignID(id).SetTitle(angle.Title).SetHook(angle.Hook).SetPosition(position).Save(ctx); err != nil {
			return nil, err
		}
		angleIDs = append(angleIDs, angleID)
	}
	for _, post := range input.Posts {
		createPost := tx.CampaignPost.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetCampaignID(id).SetChannel(post.Channel).SetCopy(post.Copy).SetStatus(campaignpost.StatusDRAFT)
		if post.AngleIndex != nil {
			createPost.SetAngleID(angleIDs[*post.AngleIndex])
		}
		if post.CallToAction != nil && *post.CallToAction != "" {
			createPost.SetCallToAction(*post.CallToAction)
		}
		if _, err := createPost.Save(ctx); err != nil {
			return nil, err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_created", "campaign", id,
		map[string]any{"angleCount": len(input.Angles), "postCount": len(input.Posts),
			"productSurfaceId": surfaceID, "releaseId": input.ReleaseID,
			"workspaceAgeSeconds": int(time.Since(organization.CreatedAt).Seconds() + 0.5)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	detail, err := c.GetCampaign(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	created := true
	detail.Created = &created
	return detail, nil
}

// replayCampaign returns the campaign an earlier create with this
// idempotency key made in the workspace, or nil when there is none.
func (c *Configuration) replayCampaign(ctx context.Context, actor Actor, key *string) (*CampaignDetail, error) {
	if key == nil {
		return nil, nil
	}
	id, err := c.client.Campaign.Query().Where(campaign.OrganizationID(actor.OrganizationID),
		campaign.IdempotencyKey(*key)).OnlyID(ctx)
	if ent.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	detail, err := c.GetCampaign(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	created := false
	detail.Created = &created
	return detail, nil
}

// UpdateCampaignPostInput is a person's edit to a post. ExpectedCopy is the
// copy the edit was made against. A nil field is unchanged; an empty call to
// action or title clears it.
type UpdateCampaignPostInput struct {
	CallToAction *string `json:"callToAction"`
	Copy         *string `json:"copy"`
	ExpectedCopy *string `json:"expectedCopy"`
	Title        *string `json:"title"`
}

// UpdateCampaignPost edits a post's copy, call to action, or title with the
// rules an applied revision follows: an approved post returns to draft, a
// live post cannot change, prohibited terms are refused, and an edit made
// against older copy is a conflict. It needs release:create.
func (c *Configuration) UpdateCampaignPost(ctx context.Context, actor Actor, campaignID, postID string, input UpdateCampaignPostInput) (*CampaignPostItem, error) {
	if err := c.authorizeRoles(ctx, actor, launchEditRoles...); err != nil {
		return nil, err
	}
	if input.ExpectedCopy == nil || (input.Copy == nil && input.CallToAction == nil && input.Title == nil) ||
		(input.Copy != nil && (strings.TrimSpace(*input.Copy) == "" || utf8.RuneCountInString(*input.Copy) > 10000)) ||
		studioTooLong(input.CallToAction, 300) || studioTooLong(input.Title, 200) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := mutableCampaign(ctx, tx, actor, campaignID); err != nil {
		return nil, err
	}
	post, err := tx.CampaignPost.Query().Where(campaignpost.ID(postID), campaignpost.CampaignID(campaignID),
		campaignpost.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	stale := conflict("This post changed since you opened it. Reload it to see the latest copy.")
	if err := revisePost(ctx, tx, post, *input.ExpectedCopy, stale,
		postRevision{CallToAction: input.CallToAction, Copy: input.Copy, Title: input.Title}); err != nil {
		return nil, err
	}
	updated, err := tx.CampaignPost.Get(ctx, post.ID)
	if err != nil {
		return nil, err
	}
	fields := []string{}
	for name, value := range map[string]*string{"callToAction": input.CallToAction, "copy": input.Copy, "title": input.Title} {
		if value != nil {
			fields = append(fields, name)
		}
	}
	slices.Sort(fields)
	if err := appendConfigurationAudit(ctx, tx, actor, "product.campaign_post_edited", "campaign_post", post.ID,
		map[string]any{"campaignId": campaignID, "fields": strings.Join(fields, ","), "from": string(post.Status),
			"to": string(updated.Status)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	item := campaignPostItem(updated)
	return &item, nil
}
