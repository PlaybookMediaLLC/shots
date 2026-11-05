package integrations

import (
	"os"
	"slices"
	"strings"
)

// Manager is IntegrationManager over the registered social providers.
type Manager struct {
	providers []Provider
}

func NewManager(providers []Provider) *Manager { return &Manager{providers: providers} }

// Providers returns every registered provider, hidden ones included.
func (m *Manager) Providers() []Provider { return m.providers }

func envList(name string) []string {
	var out []string
	for _, item := range strings.Split(os.Getenv(name), ",") {
		out = append(out, strings.TrimSpace(item))
	}
	return out
}

// IsHiddenProvider reads HIDDEN_PROVIDERS ("tiktok,x").
func (m *Manager) IsHiddenProvider(identifier string) bool {
	return slices.Contains(envList("HIDDEN_PROVIDERS"), identifier)
}

// HiddenProviderWorkspaces reads PLATFORM_SOCIAL_HIDDEN_PROVIDER_WORKSPACES: the
// product workspaces that can still connect hidden providers, as a provider's
// app reviewers must before the provider opens to every customer.
func (m *Manager) HiddenProviderWorkspaces() []string {
	return slices.DeleteFunc(envList("PLATFORM_SOCIAL_HIDDEN_PROVIDER_WORKSPACES"), func(id string) bool { return id == "" })
}

func migrations() [][2]string {
	var out [][2]string
	for _, item := range envList("MIGRATE_PROVIDERS") {
		from, to, _ := strings.Cut(item, ":")
		out = append(out, [2]string{from, to})
	}
	return out
}

// GetMigrationTarget reads MIGRATE_PROVIDERS ("tiktok:tiktok-business").
func (m *Manager) GetMigrationTarget(identifier string) string {
	for _, pair := range migrations() {
		if pair[0] == identifier && pair[1] != "" {
			if pair[1] != identifier && slices.Contains(m.GetAllowedSocialsIntegrations(), pair[1]) {
				return pair[1]
			}
			return ""
		}
	}
	return ""
}

// GetMigrationSources returns the providers whose channels a fresh connect of
// identifier should adopt.
func (m *Manager) GetMigrationSources(identifier string) []string {
	out := []string{}
	allowed := m.GetAllowedSocialsIntegrations()
	for _, pair := range migrations() {
		if pair[1] == identifier && pair[0] != "" && pair[0] != identifier && slices.Contains(allowed, pair[0]) {
			out = append(out, pair[0])
		}
	}
	return out
}

// SocialIntegrationInfo is one entry of getAllIntegrations().social.
type SocialIntegrationInfo struct {
	Name              string            `json:"name"`
	Identifier        string            `json:"identifier"`
	ToolTip           *string           `json:"toolTip,omitempty"`
	Editor            string            `json:"editor"`
	IsExternal        bool              `json:"isExternal"`
	IsWeb3            bool              `json:"isWeb3"`
	IsChromeExtension bool              `json:"isChromeExtension"`
	ExtensionCookies  []ExtensionCookie `json:"extensionCookies,omitempty"`
	CustomFields      []CustomField     `json:"customFields,omitempty"`
}

type AllIntegrations struct {
	Social  []SocialIntegrationInfo `json:"social"`
	Article []any                   `json:"article"`
}

func (m *Manager) GetAllIntegrations() AllIntegrations {
	out := AllIntegrations{Social: []SocialIntegrationInfo{}, Article: []any{}}
	for _, p := range m.providers {
		info := p.Info()
		if m.IsHiddenProvider(info.Identifier) {
			continue
		}
		item := SocialIntegrationInfo{
			Name: info.Name, Identifier: info.Identifier, Editor: info.Editor,
			IsWeb3: info.IsWeb3, IsChromeExtension: info.IsChromeExtension, ExtensionCookies: info.ExtensionCookies,
		}
		if info.ToolTip != "" {
			item.ToolTip = &info.ToolTip
		}
		_, item.IsExternal = p.(ExternalURLer)
		if cf, ok := p.(CustomFielder); ok {
			item.CustomFields = cf.CustomFields()
			if item.CustomFields == nil {
				item.CustomFields = []CustomField{}
			}
		}
		out.Social = append(out.Social, item)
	}
	return out
}

// GetAllTools maps provider identifier to its @Tool list.
func (m *Manager) GetAllTools() map[string][]Tool {
	out := map[string][]Tool{}
	for _, p := range m.providers {
		tools := p.Tools()
		if tools == nil {
			tools = []Tool{}
		}
		out[p.Info().Identifier] = tools
	}
	return out
}

// GetAllRulesDescription maps provider identifier to its @Rules text.
func (m *Manager) GetAllRulesDescription() map[string]string {
	out := map[string]string{}
	for _, p := range m.providers {
		out[p.Info().Identifier] = p.Info().Rules
	}
	return out
}

type ProviderPlugs struct {
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
	Plugs      []Plug `json:"plugs"`
}

// GetAllPlugs lists the enabled global plugs of every provider that has any.
func (m *Manager) GetAllPlugs() []ProviderPlugs {
	out := []ProviderPlugs{}
	for _, p := range m.providers {
		var plugs []Plug
		for _, plug := range p.Plugs() {
			if !plug.Disabled {
				plugs = append(plugs, plug)
			}
		}
		if len(plugs) > 0 {
			out = append(out, ProviderPlugs{Name: p.Info().Name, Identifier: p.Info().Identifier, Plugs: plugs})
		}
	}
	return out
}

// GetInternalPlugs lists a provider's enabled @PostPlug entries.
func (m *Manager) GetInternalPlugs(identifier string) []InternalPlug {
	out := []InternalPlug{}
	p := m.GetSocialIntegration(identifier)
	if p == nil {
		return out
	}
	for _, plug := range p.InternalPlugs() {
		if !plug.Disabled {
			out = append(out, plug)
		}
	}
	return out
}

func (m *Manager) GetAllowedSocialsIntegrations() []string {
	out := make([]string, 0, len(m.providers))
	for _, p := range m.providers {
		out = append(out, p.Info().Identifier)
	}
	return out
}

// GetSocialIntegration returns nil for an unknown identifier.
func (m *Manager) GetSocialIntegration(identifier string) Provider {
	for _, p := range m.providers {
		if p.Info().Identifier == identifier {
			return p
		}
	}
	return nil
}
