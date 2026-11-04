package product

import (
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/userpreference"
	"testing"
)

func TestNavigationPreferenceDefaultsAndExistingValues(t *testing.T) {
	if got := userPreferencesRecord(nil).Navigation; got != "expanded" {
		t.Fatalf("new user navigation = %q", got)
	}
	for _, value := range []userpreference.Navigation{userpreference.NavigationCompact, userpreference.NavigationDynamic, userpreference.NavigationExpanded} {
		got := userPreferencesRecord(&ent.UserPreference{Navigation: value, Version: 2})
		if got.Navigation != string(value) || got.Version != 2 {
			t.Fatalf("stored preference changed: %+v", got)
		}
	}
}

func TestTimeFormatPreferenceDefaultsRoundTripsAndRejectsUnknown(t *testing.T) {
	if got := userPreferencesRecord(nil).TimeFormat; got != "auto" {
		t.Fatalf("new user time format = %q", got)
	}
	if got := userPreferencesRecord(&ent.UserPreference{TimeFormat: userpreference.TimeFormat24h}).TimeFormat; got != "24h" {
		t.Fatalf("stored time format = %q", got)
	}
	configuration := &Configuration{}
	for _, value := range []string{"auto", "12h", "24h"} {
		current := defaultUserPreferences()
		if err := configuration.applyPreferenceUpdate(t.Context(), Actor{}, &current, UserPreferencesUpdate{TimeFormat: &value}); err != nil || current.TimeFormat != value {
			t.Fatalf("time format %q: %v, %+v", value, err, current)
		}
	}
	bad := "h12"
	current := defaultUserPreferences()
	if err := configuration.applyPreferenceUpdate(t.Context(), Actor{}, &current, UserPreferencesUpdate{TimeFormat: &bad}); err == nil || current.TimeFormat != "auto" {
		t.Fatalf("unknown time format accepted: %v, %+v", err, current)
	}
}
