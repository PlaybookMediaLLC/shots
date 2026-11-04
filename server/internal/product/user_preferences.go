package product

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/userpreference"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

// User preferences (RFC 024) belong to the person, not the workspace: the same
// row answers in every workspace they belong to, and only they can change it.

// tipPattern is a help tip's ID: lowercase words joined by hyphens.
var tipPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

const maxDismissedTips = 100

// UserPreferences is a person's preferences as the API returns them.
type UserPreferences struct {
	AccentColor        string          `json:"accentColor"`
	DeveloperMode      bool            `json:"developerMode"`
	DismissedTips      []string        `json:"dismissedTips"`
	EmailNotifications bool            `json:"emailNotifications"`
	Experiments        map[string]bool `json:"experiments"`
	Navigation         string          `json:"navigation"`
	ShowScrollbars     bool            `json:"showScrollbars"`
	TextDirection      string          `json:"textDirection"`
	Theme              string          `json:"theme"`
	// TimeFormat is the clock times read on: auto (the browser locale's), 12h or 24h.
	TimeFormat string `json:"timeFormat"`
	// TimeZone is the display time zone; nil follows the browser.
	TimeZone  *string    `json:"timeZone"`
	UpdatedAt *time.Time `json:"updatedAt"`
	Version   int        `json:"version"`
	WeekStart string     `json:"weekStart"`
}

// UserPreferencesUpdate changes the fields it sets. BaseVersion, when set,
// refuses the save if the preferences changed since that version.
type UserPreferencesUpdate struct {
	AccentColor        *string `json:"accentColor"`
	BaseVersion        *int    `json:"baseVersion"`
	DeveloperMode      *bool   `json:"developerMode"`
	EmailNotifications *bool   `json:"emailNotifications"`
	Navigation         *string `json:"navigation"`
	ShowScrollbars     *bool   `json:"showScrollbars"`
	TextDirection      *string `json:"textDirection"`
	Theme              *string `json:"theme"`
	TimeFormat         *string `json:"timeFormat"`
	// TimeZone sets the display time zone; an empty string follows the browser.
	TimeZone  *string `json:"timeZone"`
	WeekStart *string `json:"weekStart"`
	// DismissTip hides one help tip; ResetTips shows every tip again.
	DismissTip *string `json:"dismissTip"`
	ResetTips  bool    `json:"resetTips"`
	// Experiments opts in or out of experiments by ID.
	Experiments map[string]bool `json:"experiments"`
}

// UserPreferencesConflictError refuses a save made against an older version.
type UserPreferencesConflictError struct{ Current int }

func (e *UserPreferencesConflictError) Error() string {
	return "Your preferences changed in another window. Reload to see them."
}

func (e *UserPreferencesConflictError) Unwrap() error { return publishing.ErrConflict }

func defaultUserPreferences() UserPreferences {
	return UserPreferences{DismissedTips: []string{}, EmailNotifications: true, Experiments: map[string]bool{},
		Navigation: "expanded", ShowScrollbars: true, TextDirection: "ltr", Theme: "dark", TimeFormat: "auto", WeekStart: "monday"}
}

func userPreferencesRecord(row *ent.UserPreference) UserPreferences {
	if row == nil {
		return defaultUserPreferences()
	}
	updated := row.UpdatedAt
	return UserPreferences{AccentColor: row.AccentColor, DeveloperMode: row.DeveloperMode, DismissedTips: nonNilStrings(row.DismissedTips),
		EmailNotifications: row.EmailNotifications, Experiments: nonNilFlags(row.Experiments),
		Navigation: string(row.Navigation), ShowScrollbars: row.ShowScrollbars, TextDirection: string(row.TextDirection),
		Theme: string(row.Theme), TimeFormat: string(row.TimeFormat), TimeZone: row.TimeZone, UpdatedAt: &updated, Version: row.Version,
		WeekStart: string(row.WeekStart)}
}

func nonNilFlags(flags map[string]bool) map[string]bool {
	if flags == nil {
		return map[string]bool{}
	}
	return flags
}

// authorizePerson admits a signed-in person who is a member of the workspace
// the request names; preferences are never read or written by a credential.
func (c *Configuration) authorizePerson(ctx context.Context, actor Actor) error {
	if !actor.IsSession() || actor.UserID == "" {
		return publishing.ErrForbidden
	}
	return c.AuthorizeRead(ctx, actor)
}

// GetUserPreferences returns the signed-in person's preferences, or the
// defaults when they never saved any.
func (c *Configuration) GetUserPreferences(ctx context.Context, actor Actor) (*UserPreferences, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.UserPreference.Get(ctx, actor.UserID)
	if ent.IsNotFound(err) {
		preferences := defaultUserPreferences()
		return &preferences, nil
	}
	if err != nil {
		return nil, err
	}
	preferences := userPreferencesRecord(row)
	return &preferences, nil
}

// validTimeZone reports whether name is an IANA zone the backend can load.
func validTimeZone(name string) bool {
	if name == "" || name == "Local" || strings.ContainsAny(name, " \\") || len(name) > 64 {
		return false
	}
	_, err := time.LoadLocation(name)
	return err == nil
}

func oneOf(value string, allowed ...string) bool {
	for _, item := range allowed {
		if value == item {
			return true
		}
	}
	return false
}

// applyPreferenceUpdate validates input and applies it to current.
func (c *Configuration) applyPreferenceUpdate(ctx context.Context, actor Actor, current *UserPreferences, input UserPreferencesUpdate) error {
	if input.AccentColor != nil {
		color := strings.ToLower(*input.AccentColor)
		if color != "" && !regexp.MustCompile(`^#[0-9a-f]{6}$`).MatchString(color) {
			return invalid("Accent color must be a six-digit hex color, or empty for the default.")
		}
		current.AccentColor = color
	}
	if input.Theme != nil {
		if !oneOf(*input.Theme, "light", "dark", "system") {
			return invalid("Theme is light, dark or system.")
		}
		current.Theme = *input.Theme
	}
	if input.Navigation != nil {
		if !oneOf(*input.Navigation, "compact", "dynamic", "expanded") {
			return invalid("Navigation is compact, dynamic or expanded.")
		}
		current.Navigation = *input.Navigation
	}
	if input.WeekStart != nil {
		if !oneOf(*input.WeekStart, "monday", "sunday") {
			return invalid("The week starts on monday or sunday.")
		}
		current.WeekStart = *input.WeekStart
	}
	if input.TimeFormat != nil {
		if !oneOf(*input.TimeFormat, "auto", "12h", "24h") {
			return invalid("Time format is auto, 12h or 24h.")
		}
		current.TimeFormat = *input.TimeFormat
	}
	if input.TextDirection != nil {
		if !oneOf(*input.TextDirection, "ltr", "rtl") {
			return invalid("Text direction is ltr or rtl.")
		}
		current.TextDirection = *input.TextDirection
	}
	if input.TimeZone != nil {
		if *input.TimeZone == "" {
			current.TimeZone = nil
		} else if !validTimeZone(*input.TimeZone) {
			return invalid("Pick a time zone from the list, such as Europe/Paris.")
		} else {
			zone := *input.TimeZone
			current.TimeZone = &zone
		}
	}
	if input.ShowScrollbars != nil {
		current.ShowScrollbars = *input.ShowScrollbars
	}
	if input.DeveloperMode != nil {
		current.DeveloperMode = *input.DeveloperMode
	}
	if input.EmailNotifications != nil {
		current.EmailNotifications = *input.EmailNotifications
	}
	if input.ResetTips {
		current.DismissedTips = []string{}
	}
	if input.DismissTip != nil {
		tip := *input.DismissTip
		if len(tip) > 64 || !tipPattern.MatchString(tip) {
			return invalid("A help tip is named by its ID.")
		}
		if !oneOf(tip, current.DismissedTips...) {
			if len(current.DismissedTips) >= maxDismissedTips {
				current.DismissedTips = current.DismissedTips[1:]
			}
			current.DismissedTips = append(current.DismissedTips, tip)
		}
	}
	for id, on := range input.Experiments {
		if err := c.checkExperimentChoice(ctx, actor, id, on); err != nil {
			return err
		}
		if current.Experiments == nil {
			current.Experiments = map[string]bool{}
		}
		current.Experiments[id] = on
	}
	return nil
}

// UpdateUserPreferences saves the signed-in person's preferences. The write is
// guarded by the version it read, so two windows saving at once cannot lose a
// change: the slower one retries on the newer row.
func (c *Configuration) UpdateUserPreferences(ctx context.Context, actor Actor, input UserPreferencesUpdate) (*UserPreferences, error) {
	if err := c.authorizePerson(ctx, actor); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 3; attempt++ {
		row, err := c.client.UserPreference.Get(ctx, actor.UserID)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		current := userPreferencesRecord(row)
		if input.BaseVersion != nil && *input.BaseVersion != current.Version {
			return nil, &UserPreferencesConflictError{Current: current.Version}
		}
		before := current
		before.Experiments = map[string]bool{}
		for id, on := range current.Experiments {
			before.Experiments[id] = on
		}
		if err := c.applyPreferenceUpdate(ctx, actor, &current, input); err != nil {
			return nil, err
		}
		if row == nil {
			created, err := c.client.UserPreference.Create().SetID(actor.UserID).SetNillableTimeZone(current.TimeZone).
				SetAccentColor(current.AccentColor).SetTheme(userpreference.Theme(current.Theme)).SetNavigation(userpreference.Navigation(current.Navigation)).
				SetWeekStart(userpreference.WeekStart(current.WeekStart)).SetTimeFormat(userpreference.TimeFormat(current.TimeFormat)).
				SetTextDirection(userpreference.TextDirection(current.TextDirection)).
				SetShowScrollbars(current.ShowScrollbars).SetDeveloperMode(current.DeveloperMode).
				SetEmailNotifications(current.EmailNotifications).SetDismissedTips(current.DismissedTips).
				SetExperiments(current.Experiments).Save(ctx)
			if ent.IsConstraintError(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			result := userPreferencesRecord(created)
			c.auditExperimentChanges(ctx, actor, before.Experiments, result.Experiments)
			return &result, nil
		}
		update := c.client.UserPreference.Update().Where(userpreference.ID(actor.UserID), userpreference.Version(current.Version)).
			SetAccentColor(current.AccentColor).SetTheme(userpreference.Theme(current.Theme)).SetNavigation(userpreference.Navigation(current.Navigation)).
			SetWeekStart(userpreference.WeekStart(current.WeekStart)).SetTimeFormat(userpreference.TimeFormat(current.TimeFormat)).
			SetTextDirection(userpreference.TextDirection(current.TextDirection)).
			SetShowScrollbars(current.ShowScrollbars).SetDeveloperMode(current.DeveloperMode).
			SetEmailNotifications(current.EmailNotifications).SetDismissedTips(current.DismissedTips).
			SetExperiments(current.Experiments).AddVersion(1)
		if current.TimeZone == nil {
			update.ClearTimeZone()
		} else {
			update.SetTimeZone(*current.TimeZone)
		}
		count, err := update.Save(ctx)
		if err != nil {
			return nil, err
		}
		if count == 0 {
			if input.BaseVersion != nil {
				return nil, &UserPreferencesConflictError{Current: current.Version + 1}
			}
			continue
		}
		saved, err := c.client.UserPreference.Get(ctx, actor.UserID)
		if err != nil {
			return nil, err
		}
		result := userPreferencesRecord(saved)
		c.auditExperimentChanges(ctx, actor, before.Experiments, result.Experiments)
		return &result, nil
	}
	return nil, &UserPreferencesConflictError{}
}

// auditExperimentChanges records each experiment a person turned on or off in
// the workspace they were working in. A failure to audit is not a failure to save.
func (c *Configuration) auditExperimentChanges(ctx context.Context, actor Actor, before, after map[string]bool) {
	for id, on := range after {
		if before[id] == on {
			continue
		}
		action := "product.experiment_disabled"
		if on {
			action = "product.experiment_enabled"
		}
		_ = c.auditNow(ctx, actor, action, "experiment", id, map[string]any{"scope": "user"})
	}
}
