// Package whitelabel holds an organization's app branding: the name, logo,
// favicon and colors that replace Shots' own in the signed-in app.
package whitelabel

import (
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Settings is the stored branding. An empty field keeps the Shots default.
type Settings struct {
	AccentColor  string `json:"accentColor,omitempty"`
	BrandName    string `json:"brandName,omitempty"`
	FaviconURL   string `json:"faviconUrl,omitempty"`
	LogoURL      string `json:"logoUrl,omitempty"`
	PrimaryColor string `json:"primaryColor,omitempty"`
}

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// Normalize trims the settings and reports whether they are valid: a name of
// at most 64 characters, #rrggbb colors, and https image URLs. Colors and URLs
// reach the page's CSS and markup, so nothing else is accepted.
func Normalize(input Settings) (Settings, bool) {
	s := Settings{
		AccentColor:  strings.TrimSpace(input.AccentColor),
		BrandName:    strings.TrimSpace(input.BrandName),
		FaviconURL:   strings.TrimSpace(input.FaviconURL),
		LogoURL:      strings.TrimSpace(input.LogoURL),
		PrimaryColor: strings.TrimSpace(input.PrimaryColor),
	}
	ok := utf8.RuneCountInString(s.BrandName) <= 64 &&
		validColor(s.AccentColor) && validColor(s.PrimaryColor) &&
		validImageURL(s.FaviconURL) && validImageURL(s.LogoURL)
	return s, ok
}

func validColor(value string) bool { return value == "" || hexColor.MatchString(value) }

func validImageURL(value string) bool {
	if value == "" {
		return true
	}
	parsed, err := url.Parse(value)
	return err == nil && len(value) <= 2000 && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}
