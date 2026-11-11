package founderhub

import "testing"

func TestCatalogDefaultsAndUntrustedValues(t *testing.T) {
	for key, setting := range Catalog {
		device := ""
		if setting.Scope == "device" {
			device = "desktop"
		}
		if err := Validate(map[string]any{key: setting.Default}, device); err != nil {
			t.Fatalf("default for %s: %v", key, err)
		}
	}
	for _, values := range []map[string]any{
		{"autostart": "yes"}, {"spoken_languages": "[1]"}, {"automation_workflows": "{}"}, {"floating_bar_opacity": float64(2)}, {"audio_retention": "1day"},
	} {
		if Validate(values, "desktop") == nil {
			t.Fatalf("accepted invalid input: %v", values)
		}
	}
}

func TestActivityInsightsCommandAcceptsOnlyKnownRanges(t *testing.T) {
	for _, value := range []string{"all", "30d", "7d"} {
		if !(DeviceCommandInput{Kind: "activity-insights", Argument: value}).Valid() {
			t.Fatalf("rejected range %q", value)
		}
	}
	for _, value := range []string{"", "365d", "all; DROP TABLE sessions"} {
		if (DeviceCommandInput{Kind: "activity-insights", Argument: value}).Valid() {
			t.Fatalf("accepted invalid range %q", value)
		}
	}
}

func TestActivityInsightsResultIsBoundedAndValidated(t *testing.T) {
	valid := `{"conversations":1,"totalConversations":1,"hours":1.5,"activeDays":2,"streak":2,"days":[{"key":"2026-11-09","count":2}],"weekdayCounts":[{"weekday":0,"count":1},{"weekday":1,"count":1},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`
	if !ValidActivityInsightsResult(valid) {
		t.Fatal("valid activity insights were rejected")
	}
	for _, invalid := range []string{
		`{"conversations":9007199254740992,"totalConversations":9007199254740992,"hours":1.5,"activeDays":1,"streak":1,"days":[],"weekdayCounts":[{"weekday":0,"count":0},{"weekday":1,"count":0},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
		`{"conversations":2,"totalConversations":1,"hours":1.5,"activeDays":1,"streak":1,"days":[],"weekdayCounts":[]}`,
		`{"conversations":null,"totalConversations":1,"hours":1.5,"activeDays":1,"streak":1,"days":[],"weekdayCounts":[{"weekday":0,"count":0},{"weekday":1,"count":0},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
		`{"conversations":1,"totalConversations":1,"hours":1.5,"activeDays":1,"streak":1,"days":null,"weekdayCounts":[{"weekday":0,"count":0},{"weekday":1,"count":0},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
		`{"conversations":1,"totalConversations":1,"hours":1.5,"activeDays":1,"streak":1,"days":[],"weekdayCounts":[{"count":0},{"weekday":1,"count":0},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
		`{"conversations":2,"totalConversations":3,"hours":1.5,"activeDays":0,"streak":0,"days":[],"weekdayCounts":[{"weekday":0,"count":1},{"weekday":0,"count":1},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
		`{"conversations":2,"totalConversations":3,"hours":1.5,"activeDays":0,"streak":0,"days":[],"weekdayCounts":[{"weekday":0,"count":-1},{"weekday":1,"count":1},{"weekday":2,"count":0},{"weekday":3,"count":0},{"weekday":4,"count":0},{"weekday":5,"count":0},{"weekday":6,"count":0}]}`,
	} {
		if ValidActivityInsightsResult(invalid) {
			t.Fatalf("invalid activity insights accepted: %s", invalid)
		}
	}
}

func TestOpenSettingsPageCommandAcceptsOnlyNativeDestinations(t *testing.T) {
	for _, value := range []string{"imports", "intelligence", "transcription"} {
		if !(DeviceCommandInput{Kind: "open-settings-page", Argument: value}).Valid() {
			t.Fatalf("rejected settings page %q", value)
		}
	}
	for _, value := range []string{"", "billing", "../imports", "imports;open"} {
		if (DeviceCommandInput{Kind: "open-settings-page", Argument: value}).Valid() {
			t.Fatalf("accepted invalid settings page %q", value)
		}
	}
}
