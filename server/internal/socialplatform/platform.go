// Package socialplatform maps adapter identifiers to a publishing platform slot.
// Adapter identifiers remain intact on connections and OAuth receipts.
package socialplatform

// Canonical is the editor/default/slot key, independent of the OAuth adapter.
func Canonical(provider string) string {
	switch provider {
	case "twitter":
		return "x"
	case "instagram-standalone":
		return "instagram"
	case "linkedin-page":
		return "linkedin"
	case "mastodon-custom", "mastodoncustom":
		return "mastodon"
	default:
		return provider
	}
}

// Adapter is the OAuth adapter a stored platform connects through. Legacy
// names of one adapter collapse; distinct adapters that share a slot, such as
// linkedin and linkedin-page, stay distinct.
func Adapter(platform string) string {
	switch platform {
	case "twitter":
		return "x"
	case "mastodoncustom":
		return "mastodon-custom"
	default:
		return platform
	}
}

// Aliases is the full adapter family occupying the same social-set slot.
func Aliases(provider string) []string {
	switch Canonical(provider) {
	case "x":
		return []string{"x", "twitter"}
	case "instagram":
		return []string{"instagram", "instagram-standalone"}
	case "linkedin":
		return []string{"linkedin", "linkedin-page"}
	case "mastodon":
		return []string{"mastodon", "mastodon-custom", "mastodoncustom"}
	default:
		return []string{provider}
	}
}

// Defaults preserves first-seen order while collapsing adapter aliases.
func Defaults(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = Canonical(value)
		if !seen[value] {
			out = append(out, value)
			seen[value] = true
		}
	}
	return out
}
