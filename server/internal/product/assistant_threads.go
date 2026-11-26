package product

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/assistantthread"
)

const (
	assistantThreadsKept       = 30
	assistantThreadEntries     = 200
	assistantThreadEntriesSize = 200_000
	assistantThreadTitleMax    = 120
)

// AssistantThreadRecord is one saved thread; a list leaves Entries out.
type AssistantThreadRecord struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Entries   json.RawMessage `json:"entries,omitempty"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

// SaveAssistantThreadInput replaces a thread's title and entries.
type SaveAssistantThreadInput struct {
	Title   string          `json:"title"`
	Entries json.RawMessage `json:"entries"`
}

func assistantThreadRecord(row *ent.AssistantThread, entries bool) AssistantThreadRecord {
	record := AssistantThreadRecord{ID: row.ID, Title: row.Title, UpdatedAt: row.UpdatedAt}
	if entries {
		record.Entries = row.Entries
	}
	return record
}

// ownThreads scopes every query to the signed-in person in this workspace.
func (c *Configuration) ownThreads(actor Actor) *ent.AssistantThreadQuery {
	return c.client.AssistantThread.Query().Where(
		assistantthread.OrganizationID(actor.OrganizationID),
		assistantthread.UserID(actor.UserID),
	)
}

// ListAssistantThreads returns the person's threads, newest first.
func (c *Configuration) ListAssistantThreads(ctx context.Context, actor Actor) ([]AssistantThreadRecord, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	// The entries stay in the database: a list shows titles only.
	rows, err := c.ownThreads(actor).Order(ent.Desc(assistantthread.FieldUpdatedAt)).Limit(assistantThreadsKept).
		Select(assistantthread.FieldID, assistantthread.FieldTitle, assistantthread.FieldUpdatedAt).
		All(ctx)
	if err != nil {
		return nil, err
	}
	records := make([]AssistantThreadRecord, 0, len(rows))
	for _, row := range rows {
		records = append(records, assistantThreadRecord(row, false))
	}
	return records, nil
}

// GetAssistantThread returns one of the person's threads with its entries.
func (c *Configuration) GetAssistantThread(ctx context.Context, actor Actor, id string) (*AssistantThreadRecord, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.ownThreads(actor).Where(assistantthread.ID(id)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, launchNotFound("Thread")
	}
	if err != nil {
		return nil, err
	}
	record := assistantThreadRecord(row, true)
	return &record, nil
}

// SaveAssistantThread creates or replaces one of the person's threads, and
// drops the oldest beyond the number kept. Another person's id is not found.
func (c *Configuration) SaveAssistantThread(ctx context.Context, actor Actor, id string, input SaveAssistantThreadInput) (*AssistantThreadRecord, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(input.Title)
	var entries []map[string]any
	if title == "" || utf8.RuneCountInString(title) > assistantThreadTitleMax ||
		len(input.Entries) > assistantThreadEntriesSize ||
		json.Unmarshal(input.Entries, &entries) != nil ||
		len(entries) == 0 || len(entries) > assistantThreadEntries {
		return nil, ErrInvalidInput
	}
	updated, err := c.client.AssistantThread.Update().Where(
		assistantthread.ID(id),
		assistantthread.OrganizationID(actor.OrganizationID),
		assistantthread.UserID(actor.UserID),
	).SetTitle(title).SetEntries(input.Entries).Save(ctx)
	if err != nil {
		return nil, err
	}
	if updated == 0 {
		err = c.client.AssistantThread.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
			SetUserID(actor.UserID).SetTitle(title).SetEntries(input.Entries).Exec(ctx)
		// The id is taken by a thread this person cannot see.
		if ent.IsConstraintError(err) {
			return nil, launchNotFound("Thread")
		}
		if err != nil {
			return nil, err
		}
		old, err := c.ownThreads(actor).Order(ent.Desc(assistantthread.FieldUpdatedAt)).Offset(assistantThreadsKept).IDs(ctx)
		if err != nil {
			return nil, err
		}
		if len(old) > 0 {
			if _, err := c.client.AssistantThread.Delete().Where(assistantthread.IDIn(old...)).Exec(ctx); err != nil {
				return nil, err
			}
		}
	}
	return c.GetAssistantThread(ctx, actor, id)
}

// DeleteAssistantThread removes one of the person's threads.
func (c *Configuration) DeleteAssistantThread(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return err
	}
	deleted, err := c.client.AssistantThread.Delete().Where(
		assistantthread.ID(id),
		assistantthread.OrganizationID(actor.OrganizationID),
		assistantthread.UserID(actor.UserID),
	).Exec(ctx)
	if err == nil && deleted == 0 {
		return launchNotFound("Thread")
	}
	return err
}
