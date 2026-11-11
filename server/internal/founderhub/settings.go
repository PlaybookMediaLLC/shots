// Package founderhub owns Founder Hub configuration stored in Shots.
package founderhub

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"slices"
)

//go:embed settings.json
var catalogJSON []byte

type Setting struct {
	Type     string   `json:"type"`
	Scope    string   `json:"scope"`
	Section  string   `json:"section"`
	Label    string   `json:"label"`
	Default  any      `json:"default,omitempty"`
	Format   string   `json:"format,omitempty"`
	Options  []string `json:"options,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	ReadOnly bool     `json:"readOnly,omitempty"`
}

var Catalog = func() map[string]Setting {
	var settings map[string]Setting
	if err := json.Unmarshal(catalogJSON, &settings); err != nil {
		panic(err)
	}
	return settings
}()

// Browser preferences cannot choose native paths or forge device execution bookkeeping.
func RequiresNativeWrite(values map[string]any) bool {
	for key, value := range values {
		if Catalog[key].ReadOnly || key == "lock_app" || key == "automation_workflows" {
			return true
		}
		if key == "export_directory" || key == "automation_markdown_export_directory" || key == "local_stt_model_path" {
			if value != nil && value != "" {
				return true
			}
		}
	}
	return false
}

// Validate rejects unknown keys and cross-device writes before persistence.
func Validate(values map[string]any, deviceID string) error {
	if len(values) > len(Catalog) {
		return fmt.Errorf("too many settings")
	}
	for key, value := range values {
		definition, ok := Catalog[key]
		if !ok {
			return fmt.Errorf("unknown setting: %s", key)
		}
		if (definition.Scope == "device") != (deviceID != "") {
			return fmt.Errorf("incorrect scope for %s", key)
		}
		// Null resets a setting to its application default.
		if value == nil {
			continue
		}
		valid := false
		switch definition.Type {
		case "boolean":
			_, valid = value.(bool)
		case "number":
			number, ok := value.(float64)
			valid = ok && !math.IsNaN(number) && !math.IsInf(number, 0) && (definition.Min == nil || number >= *definition.Min) && (definition.Max == nil || number <= *definition.Max)
		case "string":
			text, ok := value.(string)
			valid = ok && len(text) <= 262144 && (len(definition.Options) == 0 || slices.Contains(definition.Options, text))
			if valid && definition.Format != "" {
				var items []any
				valid = json.Unmarshal([]byte(text), &items) == nil && items != nil && len(items) <= 10000
				if valid && definition.Format == "string-array" {
					for _, item := range items {
						if _, ok := item.(string); !ok {
							valid = false
							break
						}
					}
				}
			}
		}
		if !valid {
			return fmt.Errorf("invalid value for %s", key)
		}
	}
	return nil
}
