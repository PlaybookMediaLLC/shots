package socialidentity

// ConnectionProviders is the product connection catalog, including unavailable
// branches and the legacy adapters needed to reconnect existing accounts.
func ConnectionProviders() []string {
	return []string{"x", "linkedin", "linkedin-page", "tiktok", "youtube", "threads", "mastodon", "mastodon-custom", "bluesky", "instagram", "instagram-standalone", "substack", "facebook", "pinterest"}
}

// ProviderAvailability describes configuration readiness, never account health
// or proof that a provider has approved this deployment or a particular user.
type ProviderAvailability struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
}

// ConnectionAvailability contains no credentials, app identifiers or internal
// configuration names. Missing providers are not assumed to be available.
type ConnectionAvailability struct {
	Version   int                    `json:"version"`
	Providers []ProviderAvailability `json:"providers"`
}

// Validate rejects partial, duplicate, unrecognized or ambiguous catalogs.
func (a ConnectionAvailability) Validate() error {
	expected := map[string]bool{}
	for _, id := range ConnectionProviders() {
		expected[id] = true
	}
	if a.Version != 1 || len(a.Providers) != len(expected) {
		return ErrInvalid
	}
	for _, item := range a.Providers {
		if !expected[item.Provider] {
			return ErrInvalid
		}
		delete(expected, item.Provider)
		switch item.Status {
		case "available", "not_configured", "disabled", "unsupported":
		default:
			return ErrInvalid
		}
	}
	return nil
}

// RequiresPageSelection identifies OAuth adapters with an intermediate destination choice.
func RequiresPageSelection(provider string) bool {
	return provider == "instagram" || provider == "linkedin-page" || provider == "youtube" || provider == "facebook"
}
