package product

import (
	"context"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/approval"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandkit"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativetemplate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/creativevariant"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/release"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

var creativeAspectRatioPattern = regexp.MustCompile(`^\d+:\d+$`)

type CreateCreativeTemplateInput struct {
	Definition map[string]any `json:"definition"`
	Name       string         `json:"name"`
}

type CreativeTemplateRecord struct {
	CreatedAt  time.Time      `json:"createdAt"`
	Definition map[string]any `json:"definition"`
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Status     string         `json:"status"`
	Version    int            `json:"version"`
}

type CreateCreativeVariantInput struct {
	AspectRatio   string `json:"aspectRatio"`
	BrandKitID    string `json:"brandKitId"`
	ReleaseID     string `json:"releaseId"`
	SourceAssetID string `json:"sourceAssetId"`
	TemplateID    string `json:"templateId"`
}

// CreativeVariantRecord is a fixed image to publish: a design render (DesignID)
// or a brand kit and template version applied to a source asset.
type CreativeVariantRecord struct {
	AspectRatio     string  `json:"aspectRatio"`
	BrandKitID      *string `json:"brandKitId"`
	BrandKitVersion *int    `json:"brandKitVersion"`
	DesignID        *string `json:"designId"`
	ID              string  `json:"id"`
	ReleaseID       string  `json:"releaseId"`
	Revision        int     `json:"revision"`
	SourceAssetID   string  `json:"sourceAssetId"`
	Status          string  `json:"status"`
	TemplateID      *string `json:"templateId"`
	TemplateVersion *int    `json:"templateVersion"`
}

type CreativeApprovalInput struct {
	Reason *string `json:"reason"`
	Status string  `json:"status"`
}

type CreativeApprovalRecord struct {
	CreatedAt       time.Time  `json:"createdAt"`
	DecidedAt       *time.Time `json:"decidedAt"`
	DecidedByUserID *string    `json:"decidedByUserId"`
	ID              string     `json:"id"`
	OrganizationID  string     `json:"organizationId"`
	Reason          *string    `json:"reason"`
	Status          string     `json:"status"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	VariantID       string     `json:"variantId"`
}

type CreativeApprovalDecision struct {
	Approval CreativeApprovalRecord `json:"approval"`
	Variant  CreativeVariantRecord  `json:"variant"`
}

func creativeTemplateRecord(row *ent.CreativeTemplate) CreativeTemplateRecord {
	return CreativeTemplateRecord{CreatedAt: row.CreatedAt, Definition: row.Definition, ID: row.ID,
		Name: row.Name, Status: string(row.Status), Version: row.Version}
}

func creativeVariantRecord(row *ent.CreativeVariant) CreativeVariantRecord {
	return CreativeVariantRecord{AspectRatio: row.AspectRatio, BrandKitID: row.BrandKitID,
		BrandKitVersion: row.BrandKitVersion, DesignID: row.DesignID, ID: row.ID, ReleaseID: row.ReleaseID,
		Revision: row.Revision, SourceAssetID: row.SourceAssetID, Status: string(row.Status),
		TemplateID: row.TemplateID, TemplateVersion: row.TemplateVersion}
}

func creativeApprovalRecord(row *ent.Approval) CreativeApprovalRecord {
	return CreativeApprovalRecord{CreatedAt: row.CreatedAt, DecidedAt: row.DecidedAt,
		DecidedByUserID: row.DecidedByUserID, ID: row.ID, OrganizationID: row.OrganizationID,
		Reason: row.Reason, Status: string(row.Status), UpdatedAt: row.UpdatedAt, VariantID: row.VariantID}
}

func (c *Configuration) ListCreativeTemplates(ctx context.Context, actor Actor) ([]CreativeTemplateRecord, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.CreativeTemplate.Query().Where(creativetemplate.OrganizationID(actor.OrganizationID)).
		Order(ent.Asc(creativetemplate.FieldName), ent.Desc(creativetemplate.FieldVersion)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]CreativeTemplateRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, creativeTemplateRecord(row))
	}
	return items, nil
}

func (c *Configuration) CreateCreativeTemplate(ctx context.Context, actor Actor, input CreateCreativeTemplateInput) (*CreativeTemplateRecord, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > 100 || input.Definition == nil {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := requireStoryReusableAssets(ctx, tx, actor.OrganizationID, input.Definition); err != nil {
		return nil, err
	}
	current, err := tx.CreativeTemplate.Query().Where(creativetemplate.OrganizationID(actor.OrganizationID),
		creativetemplate.Name(input.Name)).Order(ent.Desc(creativetemplate.FieldVersion)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	version := 1
	if current != nil {
		version = current.Version + 1
	}
	row, err := tx.CreativeTemplate.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetName(input.Name).SetVersion(version).SetDefinition(input.Definition).
		SetStatus(creativetemplate.StatusACTIVE).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.creative_template_created", "creative_template", row.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeTemplateRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) CreateCreativeVariant(ctx context.Context, actor Actor, input CreateCreativeVariantInput) (*CreativeVariantRecord, error) {
	if err := c.authorizeRoles(ctx, actor,
		"owner", "admin", "creator"); err != nil {
		return nil, err
	}
	if !creativeAspectRatioPattern.MatchString(input.AspectRatio) || len(input.AspectRatio) > 16 ||
		input.BrandKitID == "" || input.ReleaseID == "" || input.TemplateID == "" {
		return nil, ErrInvalidInput
	}
	if _, err := uuid.Parse(input.SourceAssetID); err != nil {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM organization WHERE id=$1 FOR KEY SHARE`, actor.OrganizationID); err != nil {
		return nil, err
	}
	if err := requireCanonicalRelease(ctx, tx.Client(), actor.OrganizationID, input.ReleaseID); err != nil {
		return nil, err
	}
	assetOwned, err := tx.Asset.Query().Where(asset.ID(input.SourceAssetID), asset.OrganizationID(actor.OrganizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	brand, brandErr := tx.BrandKit.Query().Where(brandkit.ID(input.BrandKitID),
		brandkit.OrganizationID(actor.OrganizationID), brandkit.StatusEQ(brandkit.StatusACTIVE)).Only(ctx)
	linkedRelease, releaseErr := tx.Release.Query().Where(release.ID(input.ReleaseID),
		release.OrganizationID(actor.OrganizationID)).Only(ctx)
	template, templateErr := tx.CreativeTemplate.Query().Where(creativetemplate.ID(input.TemplateID),
		creativetemplate.OrganizationID(actor.OrganizationID), creativetemplate.StatusEQ(creativetemplate.StatusACTIVE)).Only(ctx)
	for _, queryErr := range []error{brandErr, releaseErr, templateErr} {
		if queryErr != nil && !ent.IsNotFound(queryErr) {
			return nil, queryErr
		}
	}
	if !assetOwned || brand == nil || linkedRelease == nil || template == nil {
		return nil, publishing.ErrNotFound
	}
	current, err := tx.CreativeVariant.Query().Where(creativevariant.ReleaseID(input.ReleaseID),
		creativevariant.AspectRatio(input.AspectRatio)).Order(ent.Desc(creativevariant.FieldRevision)).First(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	revision := 1
	if current != nil {
		revision = current.Revision + 1
	}
	row, err := tx.CreativeVariant.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetReleaseID(input.ReleaseID).SetSourceAssetID(input.SourceAssetID).
		SetBrandKitID(brand.ID).SetBrandKitVersion(brand.Version).
		SetTemplateID(template.ID).SetTemplateVersion(template.Version).
		SetRevision(revision).SetAspectRatio(input.AspectRatio).SetStatus(creativevariant.StatusDRAFT).
		SetCreatedByUserID(actor.UserID).Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	if _, err := tx.Approval.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetVariantID(row.ID).SetStatus(approval.StatusPENDING).Save(ctx); err != nil {
		return nil, err
	}
	if err := recordProductActivity(ctx, tx, actor, "variant.ready", "product.creative_variant_created", "creative_variant", row.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := creativeVariantRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) DecideCreativeVariant(ctx context.Context, actor Actor, id string, input CreativeApprovalInput) (*CreativeApprovalDecision, error) {
	if err := c.authorizeDecision(ctx, actor, creativeApproveRoles...); err != nil {
		return nil, err
	}
	if input.Status != "APPROVED" && input.Status != "REJECTED" ||
		(input.Reason != nil && utf8.RuneCountInString(*input.Reason) > 500) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	decision, err := decideVariantTx(ctx, tx, actor, id, input)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &CreativeApprovalDecision{Approval: creativeApprovalRecord(decision.approval.Unwrap()),
		Variant: creativeVariantRecord(decision.variant.Unwrap())}, nil
}

// creativeApproveRoles hold release:approve in the web role map.
var creativeApproveRoles = []string{"owner", "admin", "approver"}

type variantDecision struct {
	approval *ent.Approval
	variant  *ent.CreativeVariant
}

// decideVariantTx records an approve or reject decision on a variant and its
// audit event inside the caller's transaction. The caller has authorized the
// actor and validated the input.
func decideVariantTx(ctx context.Context, tx *ent.Tx, actor Actor, id string, input CreativeApprovalInput) (*variantDecision, error) {
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM creative_variant WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	variant, err := tx.CreativeVariant.Query().Where(creativevariant.ID(id),
		creativevariant.OrganizationID(actor.OrganizationID), creativevariant.StatusNEQ(creativevariant.StatusARCHIVED)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	decision, err := tx.Approval.Query().Where(approval.VariantID(id), approval.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	now := time.Now().UTC()
	var approved *ent.Approval
	if decision == nil {
		create := tx.Approval.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetVariantID(id).SetStatus(approval.Status(input.Status)).SetDecidedByUserID(actor.UserID).SetDecidedAt(now)
		if input.Reason != nil {
			create.SetReason(*input.Reason)
		}
		approved, err = create.Save(ctx)
	} else {
		update := tx.Approval.UpdateOneID(decision.ID).SetStatus(approval.Status(input.Status)).
			SetDecidedByUserID(actor.UserID).SetDecidedAt(now)
		if input.Reason != nil {
			update.SetReason(*input.Reason)
		} else {
			update.ClearReason()
		}
		approved, err = update.Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	to := creativevariant.StatusDRAFT
	if input.Status == "APPROVED" {
		to = creativevariant.StatusAPPROVED
	}
	updated, err := tx.CreativeVariant.UpdateOneID(variant.ID).SetStatus(to).Save(ctx)
	if err != nil {
		return nil, err
	}
	record := func() error {
		return appendConfigurationAudit(ctx, tx, actor, "product.creative_variant_approved", "creative_variant", id, map[string]any{"status": input.Status})
	}
	if decision == nil || string(decision.Status) != input.Status {
		record = func() error {
			return recordProductActivity(ctx, tx, actor, "variant.decided", "product.creative_variant_approved", "creative_variant", id, map[string]any{"status": input.Status})
		}
	}
	if err := record(); err != nil {
		return nil, err
	}
	return &variantDecision{approval: approved, variant: updated}, nil
}
