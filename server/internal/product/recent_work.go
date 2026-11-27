package product

import (
	"context"
	"sort"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformcreativeset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/project"
)

const (
	defaultRecentWorkLimit = 5
	maxRecentWorkLimit     = 20
)

// RecentWorkItem is the lightweight metadata projection for sidebar recents.
// It omits the document JSON payload so navigation bars never pull TOAST blobs.
type RecentWorkItem struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// RecentWorkPage holds the workspace's newest projects and canvases.
type RecentWorkPage struct {
	Items []RecentWorkItem `json:"items"`
}

func mergeRecentWork(projects, canvases []RecentWorkItem, limit int) []RecentWorkItem {
	merged := make([]RecentWorkItem, 0, len(projects)+len(canvases))
	merged = append(merged, projects...)
	merged = append(merged, canvases...)
	sort.Slice(merged, func(i, j int) bool {
		if !merged[i].UpdatedAt.Equal(merged[j].UpdatedAt) {
			return merged[i].UpdatedAt.After(merged[j].UpdatedAt)
		}
		if merged[i].ID != merged[j].ID {
			return merged[i].ID > merged[j].ID
		}
		return merged[i].Kind < merged[j].Kind
	})
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

// ListRecentWork returns the workspace's most recently updated screenshots and
// canvases without fetching their document columns.
func (c *Configuration) ListRecentWork(ctx context.Context, actor Actor, limit int) (*RecentWorkPage, error) {
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = defaultRecentWorkLimit
	} else if limit > maxRecentWorkLimit {
		limit = maxRecentWorkLimit
	}

	var (
		projectItems []RecentWorkItem
		canvasItems  []RecentWorkItem
	)
	err := runParallel(ctx, 2,
		func(ctx context.Context) error {
			rows, err := c.client.Project.Query().
				Where(project.OrganizationID(actor.OrganizationID)).
				Select(project.FieldID, project.FieldName, project.FieldUpdatedAt).
				Order(ent.Desc(project.FieldUpdatedAt), ent.Desc(project.FieldID)).
				Limit(limit).
				All(ctx)
			if err != nil {
				return err
			}
			items := make([]RecentWorkItem, 0, len(rows))
			for _, row := range rows {
				items = append(items, RecentWorkItem{
					ID:        row.ID,
					Kind:      "project",
					Name:      row.Name,
					UpdatedAt: row.UpdatedAt,
				})
			}
			projectItems = items
			return nil
		},
		func(ctx context.Context) error {
			rows, err := c.client.PlatformCreativeSet.Query().
				Where(
					platformcreativeset.OrganizationID(actor.OrganizationID),
					platformcreativeset.Archived(false),
					platformcreativeset.KindEQ(platformcreativeset.KindCanvas),
				).
				Select(
					platformcreativeset.FieldID,
					platformcreativeset.FieldName,
					platformcreativeset.FieldUpdatedAt,
				).
				Order(ent.Desc(platformcreativeset.FieldUpdatedAt), ent.Desc(platformcreativeset.FieldID)).
				Limit(limit).
				All(ctx)
			if err != nil {
				return err
			}
			items := make([]RecentWorkItem, 0, len(rows))
			for _, row := range rows {
				items = append(items, RecentWorkItem{
					ID:        row.ID,
					Kind:      "canvas",
					Name:      row.Name,
					UpdatedAt: row.UpdatedAt,
				})
			}
			canvasItems = items
			return nil
		},
	)
	if err != nil {
		return nil, err
	}

	return &RecentWorkPage{Items: mergeRecentWork(projectItems, canvasItems, limit)}, nil
}
