package product

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/calendarnote"
	"github.com/lucsky/cuid"
)

// CalendarNote is a date-only note, visible to everyone in the workspace.
type CalendarNote struct {
	ID        string    `json:"id"`
	Day       string    `json:"day"`
	Title     string    `json:"title"`
	Color     string    `json:"color"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// CalendarNoteInput creates a note.
type CalendarNoteInput struct {
	Day   string `json:"day"`
	Title string `json:"title"`
	Color string `json:"color"`
}

// CalendarNoteChanges edits a note. Its day stays: delete and add to move it.
type CalendarNoteChanges struct {
	Title string `json:"title"`
	Color string `json:"color"`
}

func calendarNoteRecord(row *ent.CalendarNote) CalendarNote {
	return CalendarNote{ID: row.ID, Day: row.Day.Format(time.DateOnly), Title: row.Title, Color: string(row.Color), CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
}

func calendarNoteFields(title, color string) (string, error) {
	title = strings.TrimSpace(title)
	if n := utf8.RuneCountInString(title); n < 1 || n > 120 {
		return "", invalid("A note's title is 1 to 120 characters.")
	}
	if calendarnote.ColorValidator(calendarnote.Color(color)) != nil {
		return "", invalid("Choose one of the note colors.")
	}
	return title, nil
}

// ListCalendarNotes reads the workspace's notes on the days from..to, inclusive.
func (c *Configuration) ListCalendarNotes(ctx context.Context, actor Actor, from, to string) ([]CalendarNote, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	first, err := time.Parse(time.DateOnly, from)
	if err != nil {
		return nil, invalid("Choose valid dates.")
	}
	last, err := time.Parse(time.DateOnly, to)
	if err != nil {
		return nil, invalid("Choose valid dates.")
	}
	if last.Before(first) || last.Sub(first) > 100*24*time.Hour {
		return nil, invalid("Ask for at most 100 days at a time.")
	}
	rows, err := c.client.CalendarNote.Query().Where(calendarnote.OrganizationID(actor.OrganizationID),
		calendarnote.DayGTE(first), calendarnote.DayLTE(last)).
		Order(ent.Asc(calendarnote.FieldDay), ent.Asc(calendarnote.FieldCreatedAt), ent.Asc(calendarnote.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	notes := make([]CalendarNote, 0, len(rows))
	for _, row := range rows {
		notes = append(notes, calendarNoteRecord(row))
	}
	return notes, nil
}

// CreateCalendarNote adds a note on a day. The audit records no title, which
// is the customer's free text.
func (c *Configuration) CreateCalendarNote(ctx context.Context, actor Actor, input CalendarNoteInput) (*CalendarNote, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	day, err := time.Parse(time.DateOnly, input.Day)
	if err != nil {
		return nil, invalid("Choose a valid date.")
	}
	title, err := calendarNoteFields(input.Title, input.Color)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.CalendarNote.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetDay(day).
		SetTitle(title).SetColor(calendarnote.Color(input.Color)).SetCreatedByUserID(actor.UserID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.calendar_note_created", "calendar_note", row.ID, map[string]any{"day": input.Day, "color": input.Color}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	note := calendarNoteRecord(row)
	return &note, nil
}

// UpdateCalendarNote changes a note's title and color.
func (c *Configuration) UpdateCalendarNote(ctx context.Context, actor Actor, id string, changes CalendarNoteChanges) (*CalendarNote, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	title, err := calendarNoteFields(changes.Title, changes.Color)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	count, err := tx.CalendarNote.Update().Where(calendarnote.ID(id), calendarnote.OrganizationID(actor.OrganizationID)).
		SetTitle(title).SetColor(calendarnote.Color(changes.Color)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, notFound("Calendar note not found.")
	}
	row, err := tx.CalendarNote.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.calendar_note_updated", "calendar_note", id, map[string]any{"day": row.Day.Format(time.DateOnly), "color": changes.Color}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	note := calendarNoteRecord(row)
	return &note, nil
}

// DeleteCalendarNote removes a note.
func (c *Configuration) DeleteCalendarNote(ctx context.Context, actor Actor, id string) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	count, err := tx.CalendarNote.Delete().Where(calendarnote.ID(id), calendarnote.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if count != 1 {
		return notFound("Calendar note not found.")
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.calendar_note_deleted", "calendar_note", id); err != nil {
		return err
	}
	return tx.Commit()
}
