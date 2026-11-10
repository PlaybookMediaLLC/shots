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
