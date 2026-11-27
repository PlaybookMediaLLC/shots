package product

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"regexp"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/screenshotcache"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// The screenshot cache is global, not tenant data: it maps the SHA-256 of a
// normalized capture key to the stored screenshot object. Only the web facade
// reaches it, so these operations take no actor.

// sha256Hex matches a hex SHA-256 digest: a cache URL hash or a design render key.
var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func screenshotCacheObjectKey(hash string) string { return "screenshots/" + hash + ".png" }

func (c *Configuration) PutScreenshotCacheObject(ctx context.Context, hash string, body []byte) error {
	if !sha256Hex.MatchString(hash) || len(body) == 0 || len(body) > 10<<20 || http.DetectContentType(body) != "image/png" {
		return ErrInvalidInput
	}
	if c.objects == nil {
		return ErrStorageUnavailable
	}
	if err := c.objects.Put(ctx, screenshotCacheObjectKey(hash), "image/png", bytes.NewReader(body)); err != nil {
		return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return nil
}

func (c *Configuration) GetScreenshotCacheObject(ctx context.Context, hash string) ([]byte, error) {
	if _, err := c.GetScreenshotCache(ctx, hash); err != nil {
		return nil, err
	}
	if c.objects == nil {
		return nil, ErrStorageUnavailable
	}
	body, err := c.objects.Read(ctx, screenshotCacheObjectKey(hash))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
	}
	return body, nil
}

type ScreenshotCacheEntry struct {
	CloudinaryPublicID string    `json:"cloudinaryPublicId"`
	CloudinaryURL      string    `json:"cloudinaryUrl"`
	CreatedAt          time.Time `json:"createdAt"`
	URL                string    `json:"url"`
	URLHash            string    `json:"urlHash"`
}

type ScreenshotCacheInput struct {
	CloudinaryPublicID string `json:"cloudinaryPublicId"`
	CloudinaryURL      string `json:"cloudinaryUrl"`
	URL                string `json:"url"`
}

// ScreenshotCacheFilter selects entries by exact normalized URL or by age.
// Exactly one of the two applies.
type ScreenshotCacheFilter struct {
	CreatedBefore *time.Time `json:"createdBefore"`
	URLs          []string   `json:"urls"`
}

func screenshotCacheEntry(row *ent.ScreenshotCache) ScreenshotCacheEntry {
	return ScreenshotCacheEntry{CloudinaryPublicID: row.CloudinaryPublicID, CloudinaryURL: row.CloudinaryURL,
		CreatedAt: row.CreatedAt, URL: row.URL, URLHash: row.URLHash}
}

func screenshotCacheWhere(filter ScreenshotCacheFilter) (predicate.ScreenshotCache, error) {
	switch {
	case filter.CreatedBefore != nil && len(filter.URLs) == 0:
		return screenshotcache.CreatedAtLT(*filter.CreatedBefore), nil
	case filter.CreatedBefore == nil && len(filter.URLs) > 0 && len(filter.URLs) <= 100:
		return screenshotcache.URLIn(filter.URLs...), nil
	}
	return nil, ErrInvalidInput
}

func (c *Configuration) GetScreenshotCache(ctx context.Context, hash string) (*ScreenshotCacheEntry, error) {
	if !sha256Hex.MatchString(hash) {
		return nil, ErrInvalidInput
	}
	row, err := c.client.ScreenshotCache.Query().Where(screenshotcache.URLHash(hash)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	entry := screenshotCacheEntry(row)
	return &entry, nil
}

// PutScreenshotCache upserts the entry for hash. An update keeps createdAt,
// as the Prisma upsert it replaces did, so re-storing never extends an
// entry's age.
func (c *Configuration) PutScreenshotCache(ctx context.Context, hash string, input ScreenshotCacheInput) (*ScreenshotCacheEntry, error) {
	if !sha256Hex.MatchString(hash) || input.URL == "" || input.CloudinaryPublicID == "" || input.CloudinaryURL == "" {
		return nil, ErrInvalidInput
	}
	update := func() (int, error) {
		return c.client.ScreenshotCache.Update().Where(screenshotcache.URLHash(hash)).SetURL(input.URL).
			SetCloudinaryPublicID(input.CloudinaryPublicID).SetCloudinaryURL(input.CloudinaryURL).Save(ctx)
	}
	changed, err := update()
	if err == nil && changed == 0 {
		err = c.client.ScreenshotCache.Create().SetID(cuid.New()).SetURLHash(hash).SetURL(input.URL).
			SetCloudinaryPublicID(input.CloudinaryPublicID).SetCloudinaryURL(input.CloudinaryURL).Exec(ctx)
		if ent.IsConstraintError(err) {
			// A concurrent capture inserted the hash first; this write lands as its update.
			changed, err = update()
			if err == nil && changed == 0 {
				err = publishing.ErrConflict
			}
		}
	}
	if ent.IsConstraintError(err) {
		// The object key already belongs to another entry.
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	return c.GetScreenshotCache(ctx, hash)
}

// DeleteScreenshotCache is idempotent: a missing entry is already deleted.
func (c *Configuration) DeleteScreenshotCache(ctx context.Context, hash string) error {
	if !sha256Hex.MatchString(hash) {
		return ErrInvalidInput
	}
	if c.objects != nil {
		if err := c.objects.Delete(ctx, screenshotCacheObjectKey(hash)); err != nil {
			return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
		}
	}
	_, err := c.client.ScreenshotCache.Delete().Where(screenshotcache.URLHash(hash)).Exec(ctx)
	return err
}

func (c *Configuration) ListScreenshotCache(ctx context.Context, filter ScreenshotCacheFilter) ([]ScreenshotCacheEntry, error) {
	where, err := screenshotCacheWhere(filter)
	if err != nil {
		return nil, err
	}
	rows, err := c.client.ScreenshotCache.Query().Where(where).Order(ent.Asc(screenshotcache.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	entries := make([]ScreenshotCacheEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, screenshotCacheEntry(row))
	}
	return entries, nil
}

// PurgeScreenshotCache removes each object before deleting its cache row,
// chunked in batches of 100 with bounded parallel storage deletes.
func (c *Configuration) PurgeScreenshotCache(ctx context.Context, filter ScreenshotCacheFilter) (int, error) {
	where, err := screenshotCacheWhere(filter)
	if err != nil {
		return 0, err
	}
	if c.objects == nil {
		return c.client.ScreenshotCache.Delete().Where(where).Exec(ctx)
	}
	const (
		purgeBatchSize = 100
		deleteWorkers  = 8
	)
	total := 0
	for {
		if ctx.Err() != nil {
			return total, ctx.Err()
		}
		rows, err := c.client.ScreenshotCache.Query().Where(where).
			Select(screenshotcache.FieldID, screenshotcache.FieldURLHash).
			Limit(purgeBatchSize).All(ctx)
		if err != nil {
			return total, err
		}
		if len(rows) == 0 {
			return total, nil
		}
		ids := make([]string, 0, len(rows))
		tasks := make([]func(context.Context) error, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
			hash := row.URLHash
			tasks = append(tasks, func(taskCtx context.Context) error {
				if err := c.objects.Delete(taskCtx, screenshotCacheObjectKey(hash)); err != nil {
					if ctx.Err() != nil {
						return ctx.Err()
					}
					return fmt.Errorf("%w: %v", ErrStorageUnavailable, err)
				}
				return nil
			})
		}
		if err := runParallel(ctx, deleteWorkers, tasks...); err != nil {
			return total, err
		}
		deleted, err := c.client.ScreenshotCache.Delete().Where(screenshotcache.IDIn(ids...)).Exec(ctx)
		if err != nil {
			return total, err
		}
		total += deleted
		if len(rows) < purgeBatchSize {
			return total, nil
		}
	}
}
