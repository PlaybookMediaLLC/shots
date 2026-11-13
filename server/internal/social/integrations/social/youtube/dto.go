package youtube

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/helpers"
)

// YouTube caps the combined length of all tags at 500 characters.
// Tags containing whitespace are wrapped in quotes by YouTube, which adds
// two extra characters per tag toward that limit.
const YoutubeTagsMaxLength = 500

// GetYoutubeTagsLength counts like JavaScript's string length (UTF-16 units).
func GetYoutubeTagsLength(tags []TagsSettings) int {
	total := 0
	for _, tag := range tags {
		label := ""
		if tag.Label != nil {
			label = *tag.Label
		}
		total += utf16Length(label)
		if strings.IndexFunc(label, unicode.IsSpace) >= 0 {
			total += 2
		}
	}
	return total
}

type TagsSettings struct {
	Value *string `json:"value"`
	Label *string `json:"label"`
}

// MediaDTO is a media reference.
type MediaDTO struct {
	ID        *string `json:"id"`
	Path      *string `json:"path"`
	Alt       string  `json:"alt,omitempty"`
	Thumbnail string  `json:"thumbnail,omitempty"`
}

// SettingsDTO is YoutubeSettingsDto.
type SettingsDTO struct {
	Title                   *string        `json:"title"`
	Type                    *string        `json:"type"`
	SelfDeclaredMadeForKids *string        `json:"selfDeclaredMadeForKids,omitempty"`
	Thumbnail               *MediaDTO      `json:"thumbnail,omitempty"`
	Tags                    []TagsSettings `json:"tags,omitempty"`
	ContainsSyntheticMedia  bool           `json:"containsSyntheticMedia,omitempty"`
}

// Validate reproduces class-validator: properties in declaration order, each
// property's constraints in class-validator's order (IsDefined first, then the
// decorators bottom-up), nested children after their parent.
func (d *SettingsDTO) Validate() []string {
	var out []string
	if d.Title == nil {
		out = append(out, "title should not be null or undefined",
			"title must be shorter than or equal to 100 characters",
			"title must be longer than or equal to 2 characters",
			"title must be a string")
	} else {
		if jsLength(*d.Title) > 100 {
			out = append(out, "title must be shorter than or equal to 100 characters")
		}
		if jsLength(*d.Title) < 2 {
			out = append(out, "title must be longer than or equal to 2 characters")
		}
	}

	if d.Type == nil {
		out = append(out, "type should not be null or undefined")
	}
	if d.Type == nil || !oneOf(*d.Type, "public", "private", "unlisted") {
		out = append(out, "type must be one of the following values: public, private, unlisted")
	}

	if d.SelfDeclaredMadeForKids != nil && !oneOf(*d.SelfDeclaredMadeForKids, "yes", "no") {
		out = append(out, "selfDeclaredMadeForKids must be one of the following values: yes, no")
	}

	if d.Thumbnail != nil {
		out = append(out, d.Thumbnail.Validate()...)
	}

	if d.Tags != nil {
		if GetYoutubeTagsLength(d.Tags) > YoutubeTagsMaxLength {
			out = append(out, fmt.Sprintf("The maximum allowed is %d characters in total for all tags.", YoutubeTagsMaxLength))
		}
		for _, tag := range d.Tags {
			if tag.Value == nil {
				out = append(out, "value must be a string")
			}
			if tag.Label == nil {
				out = append(out, "label must be a string")
			}
		}
	}
	return out
}

// Validate is MediaDto's validation.
func (m *MediaDTO) Validate() []string {
	var out []string
	if m.ID == nil {
		out = append(out, "id should not be null or undefined", "id must be a string")
	}
	path := ""
	if m.Path != nil {
		path = *m.Path
	} else {
		out = append(out, "path should not be null or undefined")
	}
	if !helpers.ValidURLExtension(path) {
		out = append(out, helpers.ValidURLExtensionMessage)
	}
	if !helpers.IsAllowedUploadPath(path) {
		out = append(out, helpers.ValidURLPathMessage())
	}
	if m.Path == nil {
		out = append(out, "path must be a string")
	}
	if m.Thumbnail != "" && !isURL(m.Thumbnail) {
		out = append(out, "thumbnail must be a URL address")
	}
	return out
}

func oneOf(value string, allowed ...string) bool {
	for _, a := range allowed {
		if value == a {
			return true
		}
	}
	return false
}

// jsLength is validator.js isLength's count: code points minus variation
// selectors.
func jsLength(s string) int {
	return utf8.RuneCountInString(s) - strings.Count(s, "️") - strings.Count(s, "︎")
}

func utf16Length(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

var (
	tldPattern   = regexp.MustCompile(`(?i)^([a-z\p{L}]{2,}|xn--[a-z0-9-]{2,})$`)
	labelPattern = regexp.MustCompile(`(?i)^[a-z0-9\p{L}]([a-z0-9\p{L}-]{0,61}[a-z0-9\p{L}])?$`)
)

// isURL approximates class-validator's @IsUrl() (validator.js isURL with
// default options: protocol optional, http/https/ftp, TLD required unless the
// host is an IP).
func isURL(value string) bool {
	if value == "" || len(value) >= 2083 || strings.ContainsAny(value, " \t\r\n<>") || strings.HasPrefix(value, "//") {
		return false
	}
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "ftp") {
		return false
	}
	host := u.Hostname()
	if net.ParseIP(host) != nil {
		return true
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 || !tldPattern.MatchString(labels[len(labels)-1]) {
		return false
	}
	for _, label := range labels {
		if !labelPattern.MatchString(label) {
			return false
		}
	}
	return true
}
