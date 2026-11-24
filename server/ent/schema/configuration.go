package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/brand"
)

// BrandKit maps the canonical product table. The backend is its sole writer.
type BrandKit struct{ ent.Schema }

func (BrandKit) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "brand_kit"}}
}
func (BrandKit) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("name").StorageKey("name"),
		field.Int("version").StorageKey("version"),
		field.JSON("definition", map[string]any{}).StorageKey("definition"),
		field.Enum("status").StorageKey("status").Values("DRAFT", "ACTIVE", "ARCHIVED").Default("DRAFT"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (BrandKit) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "name", "version").Unique(), index.Fields("organization_id", "created_at")}
}

// BrandProfile stores the editable workspace writing guidance.
type BrandProfile struct{ ent.Schema }

func (BrandProfile) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "brand_profile"}}
}
func (BrandProfile) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("product_description").StorageKey("productDescription"),
		field.String("audience").StorageKey("audience"),
		field.String("tone").StorageKey("tone"),
		field.String("tagline").StorageKey("tagline").Optional().Nillable(),
		field.String("cta_conventions").StorageKey("ctaConventions").Optional().Nillable(),
		// Structured terms; a legacy bare string decodes as a word-mode term.
		field.JSON("prohibited_terms", []brand.ProhibitedTerm{}).StorageKey("prohibitedTerms"),
		field.JSON("preferred_styles", []string{}).StorageKey("preferredStyles"),
		field.JSON("social_handles", map[string]string{}).StorageKey("socialHandles"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (BrandProfile) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id").Unique()}
}

// SourceApp is the canonical source integration configuration.
type SourceApp struct{ ent.Schema }

func (SourceApp) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "source_app"}}
}
func (SourceApp) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("platform_owner_user_id").StorageKey("platformOwnerUserId").Optional().Nillable(),
		field.String("name").StorageKey("name"),
		field.String("provider").StorageKey("provider").Default("generic"),
		field.String("external_id").StorageKey("externalId").Optional().Nillable(),
		field.String("secret_reference").StorageKey("secretReference").Optional().Nillable().Sensitive(),
		field.JSON("allowed_hosts", []string{}).StorageKey("allowedHosts"),
		// Merges into this branch are collected; nil follows the repository's default branch.
		field.String("branch").StorageKey("branch").Optional().Nillable(),
		// Pull requests opened by a bot account (Dependabot, Renovate) are not releases.
		field.Bool("ignore_bot_pull_requests").StorageKey("ignoreBotPullRequests").Default(true),
		// Further pull request author logins to ignore, matched case-insensitively.
		field.JSON("ignored_pull_request_authors", []string{}).StorageKey("ignoredPullRequestAuthors").Default([]string{}),
		// A GitHub pre-release is published like any release; skipped only when asked.
		field.Bool("skip_prereleases").StorageKey("skipPrereleases").Default(false),
		// Sticky opt-in: disabling every definition never restores legacy intake.
		field.Bool("release_automation").StorageKey("releaseAutomation").Default(false),
		field.Bool("automation_collect_unmatched").StorageKey("automationCollectUnmatched").Default(true),
		// The GitHub App installation that delivers this source's events; nil for a hand-made webhook.
		field.String("github_installation_id").StorageKey("githubInstallationId").Optional().Nillable(),
		field.Enum("status").StorageKey("status").Values("DRAFT", "ACTIVE", "ARCHIVED").Default("DRAFT"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}
func (SourceApp) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "id").Unique(),
		index.Fields("organization_id", "name").Unique(),
		index.Fields("organization_id", "provider", "external_id").Unique(),
		index.Fields("provider", "external_id"),
		index.Fields("organization_id", "created_at"),
	}
}
