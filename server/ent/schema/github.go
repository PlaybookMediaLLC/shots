package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// GitHubInstallation is one installation of the platform's GitHub App on an
// account or organization. It is a platform record: workspaces link to it.
type GitHubInstallation struct{ ent.Schema }

func (GitHubInstallation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "github_installation"}}
}

func (GitHubInstallation) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.Int64("installation_id").StorageKey("installationId").Immutable(),
		field.String("account_login").StorageKey("accountLogin"),
		field.String("account_type").StorageKey("accountType"),
		field.String("repository_selection").StorageKey("repositorySelection").Default("selected"),
		field.Enum("status").StorageKey("status").Values("ACTIVE", "SUSPENDED", "DELETED").Default("ACTIVE"),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (GitHubInstallation) Indexes() []ent.Index {
	return []ent.Index{index.Fields("installation_id").Unique()}
}

// WorkspaceGitHubInstallation links a workspace to an installation whose
// repositories it may watch. Several workspaces may link the same installation.
type WorkspaceGitHubInstallation struct{ ent.Schema }

func (WorkspaceGitHubInstallation) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "workspace_github_installation"}}
}

func (WorkspaceGitHubInstallation) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("github_installation_id").StorageKey("githubInstallationId").Immutable(),
		field.String("connected_by_user_id").StorageKey("connectedByUserId").Immutable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (WorkspaceGitHubInstallation) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "github_installation_id").Unique()}
}

// GitHubInstallStart is a single-use grant tying a GitHub App install to the
// workspace, user, and session that began it.
type GitHubInstallStart struct{ ent.Schema }

func (GitHubInstallStart) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "github_install_start"}}
}

func (GitHubInstallStart) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("state").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("user_id").StorageKey("userId").Immutable(),
		field.String("session_id").StorageKey("sessionId").Immutable(),
		field.Time("expires_at").StorageKey("expiresAt").Immutable(),
		// The installations GitHub verified the user can reach, kept while they pick one.
		field.JSON("installation_ids", []int64{}).StorageKey("installationIds").Optional(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
	}
}

func (GitHubInstallStart) Indexes() []ent.Index {
	return []ent.Index{index.Fields("expires_at")}
}

// SourceChange is a merged pull request held until the source's next
// published release, which takes it as one of its features.
type SourceChange struct{ ent.Schema }

func (SourceChange) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "source_change"}}
}

func (SourceChange) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Immutable(),
		field.String("repository_id").StorageKey("repositoryId").Immutable(),
		field.Int("number").StorageKey("number").Immutable(),
		field.String("title").StorageKey("title"),
		field.String("body").StorageKey("body").Default(""),
		field.String("url").StorageKey("url"),
		field.String("author_login").StorageKey("authorLogin").Optional().Nillable(),
		field.JSON("labels", []string{}).StorageKey("labels").Default([]string{}),
		field.JSON("files", []string{}).StorageKey("files").Default([]string{}),
		field.JSON("image_urls", []string{}).StorageKey("imageUrls").Default([]string{}),
		field.Time("merged_at").StorageKey("mergedAt"),
		field.String("release_id").StorageKey("releaseId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (SourceChange) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("source_app_id", "repository_id", "number").Unique(),
		index.Fields("organization_id", "source_app_id", "release_id"),
	}
}

// DeploymentEvent is a successful production deployment and the product
// screenshots it triggered.
type DeploymentEvent struct{ ent.Schema }

func (DeploymentEvent) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "deployment_event"}}
}

func (DeploymentEvent) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("source_app_id").StorageKey("sourceAppId").Immutable(),
		field.String("external_id").StorageKey("externalId").Immutable(),
		field.String("environment").StorageKey("environment"),
		field.String("url").StorageKey("url").Optional().Nillable(),
		field.String("sha").StorageKey("sha").Optional().Nillable(),
		field.Enum("status").StorageKey("status").Values("RECEIVED", "CAPTURED", "PARTIAL", "SKIPPED", "FAILED").Default("RECEIVED"),
		field.String("failure_code").StorageKey("failureCode").Optional().Nillable(),
		field.JSON("asset_ids", []string{}).StorageKey("assetIds").Default([]string{}),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (DeploymentEvent) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("source_app_id", "external_id").Unique(),
		index.Fields("organization_id", "created_at"),
	}
}
