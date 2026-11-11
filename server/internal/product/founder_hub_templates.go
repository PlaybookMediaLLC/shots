package product

import (
	"context"
	"reflect"
	"strconv"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	template "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformfounderhubtemplate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

type FounderHubTemplate struct {
	ID string `json:"id"`
	founderhub.TemplateContent
	Pinned    bool       `json:"pinned"`
	PinOrder  *int       `json:"pinOrder"`
	Version   int        `json:"version"`
	Seeded    bool       `json:"seeded"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt"`
}

type FounderHubTemplateUpdate struct {
	BaseVersion       *int                        `json:"baseVersion"`
	Content           *founderhub.TemplateContent `json:"content"`
	Pinned            *bool                       `json:"pinned"`
	Deleted           bool                        `json:"deleted"`
	ImportedUpdatedAt *time.Time                  `json:"importedUpdatedAt"`
	Native            bool                        `json:"-"`
}

type FounderHubTemplatePage struct {
	Items      []FounderHubTemplate `json:"items"`
	NextCursor string               `json:"nextCursor"`
	Revision   string               `json:"revision"`
	Unchanged  bool                 `json:"unchanged"`
}

func founderHubTemplateRecord(row *ent.PlatformFounderHubTemplate) FounderHubTemplate {
	return FounderHubTemplate{ID: row.TemplateID, TemplateContent: row.Content, Pinned: row.Pinned, PinOrder: row.PinOrder, Version: row.Version, Seeded: row.Seeded, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, DeletedAt: row.DeletedAt}
}

func (c *Configuration) ListFounderHubTemplates(ctx context.Context, actor Actor, cursor string, includeDeleted bool, revision string) (*FounderHubTemplatePage, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if cursor != "" && !founderHubDeviceID.MatchString(cursor) {
		return nil, ErrInvalidInput
	}
	identity, err := c.client.PlatformFounderHubUser.Get(ctx, actor.UserID)
	if err != nil {
		return nil, err
	}
	if !identity.TemplatesInitialized {
		if err := c.initializeFounderHubTemplates(ctx, actor.UserID); err != nil {
			return nil, err
		}
	}
	sum, err := c.client.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID)).Aggregate(func(s *entsql.Selector) string {
		return "COALESCE(SUM(" + s.C(template.FieldVersion) + "),0)"
	}).Int(ctx)
	if err != nil {
		return nil, err
	}
	currentRevision := strconv.Itoa(sum)
	if includeDeleted && cursor == "" && revision == currentRevision {
		return &FounderHubTemplatePage{Items: []FounderHubTemplate{}, Revision: currentRevision, Unchanged: true}, nil
	}
	query := c.client.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID), template.TemplateIDGT(cursor))
	if !includeDeleted {
		query.Where(template.DeletedAtIsNil())
	}
	rows, err := query.Order(ent.Asc(template.FieldTemplateID)).Limit(51).All(ctx)
	if err != nil {
		return nil, err
	}
	result := &FounderHubTemplatePage{Items: make([]FounderHubTemplate, 0, len(rows)), Revision: currentRevision}
	if len(rows) > 50 {
		rows = rows[:50]
		result.NextCursor = rows[49].TemplateID
	}
	for _, row := range rows {
		result.Items = append(result.Items, founderHubTemplateRecord(row))
	}
	return result, nil
}

func (c *Configuration) initializeFounderHubTemplates(ctx context.Context, userID string) error {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, userID); err != nil {
		return err
	}
	db := tx.Client()
	identity, err := db.PlatformFounderHubUser.Get(ctx, userID)
	if err != nil {
		return err
	}
	if !identity.TemplatesInitialized {
		for _, item := range founderhub.DefaultTemplates {
			exists, err := db.PlatformFounderHubTemplate.Query().Where(template.UserID(userID), template.TemplateID(item.ID)).Exist(ctx)
			if err != nil {
				return err
			}
			if !exists {
				if _, err := db.PlatformFounderHubTemplate.Create().SetID(cuid.New()).SetUserID(userID).SetTemplateID(item.ID).SetContent(item.Content).SetSeeded(true).Save(ctx); err != nil {
					return err
				}
			}
		}
		if _, err := db.PlatformFounderHubUser.UpdateOneID(userID).SetTemplatesInitialized(true).Save(ctx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (c *Configuration) UpdateFounderHubTemplate(ctx context.Context, actor Actor, id string, input FounderHubTemplateUpdate) (*FounderHubTemplate, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if !founderHubDeviceID.MatchString(id) || input.BaseVersion == nil || *input.BaseVersion < 0 || input.Content != nil && !input.Content.Valid() || input.Content == nil && input.Pinned == nil && !input.Deleted {
		return nil, ErrInvalidInput
	}
	if input.ImportedUpdatedAt != nil {
		if !input.Native {
			return nil, publishing.ErrForbidden
		}
		if _, err := c.AuthorizeFounderHubSession(ctx, actor); err != nil {
			return nil, err
		}
		if input.ImportedUpdatedAt.IsZero() || input.ImportedUpdatedAt.After(time.Now().Add(5*time.Minute)) {
			return nil, ErrInvalidInput
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// The owner lock covers first creation, the resource limit, and favorite ordering.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, actor.UserID); err != nil {
		return nil, err
	}
	db := tx.Client()
	row, err := db.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID), template.TemplateID(id)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if row == nil {
		if *input.BaseVersion != 0 {
			return nil, publishing.ErrConflict
		}
		if input.Content == nil || input.Deleted {
			return nil, ErrInvalidInput
		}
		count, err := db.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID), template.DeletedAtIsNil()).Count(ctx)
		if err != nil {
			return nil, err
		}
		if count >= 1000 {
			return nil, publishing.ErrConflict
		}
		// shortcut: retain 10,000 identities; add acknowledged tombstone compaction before raising this bound.
		retained, err := db.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		if retained >= 10000 {
			return nil, publishing.ErrConflict
		}
		create := db.PlatformFounderHubTemplate.Create().SetID(cuid.New()).SetUserID(actor.UserID).SetTemplateID(id).SetContent(*input.Content)
		if input.ImportedUpdatedAt != nil {
			create.SetUpdatedAt(*input.ImportedUpdatedAt)
		}
		row, err = create.Save(ctx)
		if err != nil {
			return nil, err
		}
	} else {
		if row.Version != *input.BaseVersion || row.DeletedAt != nil {
			return nil, publishing.ErrConflict
		}
		update := db.PlatformFounderHubTemplate.UpdateOneID(row.ID).AddVersion(1).SetSeeded(false)
		if input.ImportedUpdatedAt != nil && row.Seeded {
			update.SetUpdatedAt(*input.ImportedUpdatedAt)
		}
		if input.Content != nil && !reflect.DeepEqual(row.Content, *input.Content) {
			updatedAt := time.Now()
			if input.ImportedUpdatedAt != nil && row.Seeded {
				updatedAt = *input.ImportedUpdatedAt
			}
			update.SetContent(*input.Content).SetUpdatedAt(updatedAt)
		}
		if input.Deleted {
			update.SetDeletedAt(time.Now()).SetContent(founderhub.TemplateContent{
				Title: row.Content.Title, Icon: row.Content.Icon, Targets: []string{}, Sections: []founderhub.TemplateSection{},
			})
		}
		row, err = update.Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	if input.Pinned != nil && *input.Pinned != row.Pinned {
		update := db.PlatformFounderHubTemplate.UpdateOneID(row.ID).SetPinned(*input.Pinned).ClearPinOrder()
		if *input.Pinned {
			favorites, err := db.PlatformFounderHubTemplate.Query().Where(template.UserID(actor.UserID), template.Pinned(true), template.DeletedAtIsNil()).All(ctx)
			if err != nil {
				return nil, err
			}
			order := 0
			for _, item := range favorites {
				if item.PinOrder != nil && *item.PinOrder >= order {
					order = *item.PinOrder + 1
				}
			}
			update.SetPinOrder(order)
		}
		row, err = update.Save(ctx)
		if err != nil {
			return nil, err
		}
	}
	result := founderHubTemplateRecord(row)
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &result, nil
}
