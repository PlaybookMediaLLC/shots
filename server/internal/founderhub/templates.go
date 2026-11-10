package founderhub

import (
	_ "embed"
	"encoding/json"
	"regexp"
)

//go:embed default-templates.json
var defaultTemplatesJSON []byte

type defaultTemplate struct {
	ID      string          `json:"id"`
	Content TemplateContent `json:"content"`
}

var DefaultTemplates = func() []defaultTemplate {
	var data struct {
		Templates []defaultTemplate `json:"templates"`
	}
	if err := json.Unmarshal(defaultTemplatesJSON, &data); err != nil {
		panic(err)
	}
	return data.Templates
}()

type TemplateIcon struct {
	Type  string `json:"type"`
	Value string `json:"value"`
	Color string `json:"color,omitempty"`
}

type TemplateSection struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

type TemplateContent struct {
	Title       string            `json:"title"`
	Description string            `json:"description"`
	Category    string            `json:"category"`
	Icon        TemplateIcon      `json:"icon"`
	Targets     []string          `json:"targets"`
	Sections    []TemplateSection `json:"sections"`
}

var templateColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func (t TemplateContent) Valid() bool {
	if len(t.Title) > 1000 || len(t.Description) > 262144 || len(t.Category) > 200 || len(t.Targets) > 1000 || len(t.Sections) > 1000 || t.Targets == nil || t.Sections == nil {
		return false
	}
	if t.Icon.Type != "icon" && t.Icon.Type != "emoji" || t.Icon.Value == "" || len(t.Icon.Value) > 100 || t.Icon.Type == "icon" && !templateColor.MatchString(t.Icon.Color) {
		return false
	}
	for _, target := range t.Targets {
		if len(target) > 1000 {
			return false
		}
	}
	for _, section := range t.Sections {
		if len(section.Title) > 1000 || len(section.Description) > 262144 {
			return false
		}
	}
	encoded, err := json.Marshal(t)
	return err == nil && len(encoded) <= 1048576
}
