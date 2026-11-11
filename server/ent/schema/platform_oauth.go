package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
)

type PlatformOAuthClient struct{ ent.Schema }

func (PlatformOAuthClient) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "oauthClient"}}
}
func (PlatformOAuthClient) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("client_id").StorageKey("clientId").Unique(),
		field.String("client_secret").StorageKey("clientSecret").Optional().Nillable().Sensitive(),
		field.Bool("disabled").StorageKey("disabled").Optional().Nillable(),
		field.Bool("skip_consent").StorageKey("skipConsent").Optional().Nillable(),
		field.Bool("enable_end_session").StorageKey("enableEndSession").Optional().Nillable(),
		field.String("subject_type").StorageKey("subjectType").Optional().Nillable(),
		field.String("scopes").StorageKey("scopes").Optional().Nillable(),
		field.String("user_id").StorageKey("userId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Optional().Nillable(),
		field.Time("updated_at").StorageKey("updatedAt").Optional().Nillable(),
		field.String("name").StorageKey("name").Optional().Nillable(),
		field.String("uri").StorageKey("uri").Optional().Nillable(),
		field.String("icon").StorageKey("icon").Optional().Nillable(),
		field.String("contacts").StorageKey("contacts").Optional().Nillable(),
		field.String("tos").StorageKey("tos").Optional().Nillable(),
		field.String("policy").StorageKey("policy").Optional().Nillable(),
		field.String("software_id").StorageKey("softwareId").Optional().Nillable(),
		field.String("software_version").StorageKey("softwareVersion").Optional().Nillable(),
		field.String("software_statement").StorageKey("softwareStatement").Optional().Nillable(),
		field.String("redirect_uris").StorageKey("redirectUris"),
		field.String("post_logout_redirect_uris").StorageKey("postLogoutRedirectUris").Optional().Nillable(),
		field.String("token_endpoint_auth_method").StorageKey("tokenEndpointAuthMethod").Optional().Nillable(),
		field.String("grant_types").StorageKey("grantTypes").Optional().Nillable(),
		field.String("response_types").StorageKey("responseTypes").Optional().Nillable(),
		field.Bool("public").StorageKey("public").Optional().Nillable(),
		field.String("type").StorageKey("type").Optional().Nillable(),
		field.Bool("require_p_k_c_e").StorageKey("requirePKCE").Optional().Nillable(),
		field.String("reference_id").StorageKey("referenceId").Optional().Nillable(),
		field.String("metadata").StorageKey("metadata").Optional().Nillable(),
	}
}

type PlatformOAuthRefreshToken struct{ ent.Schema }

func (PlatformOAuthRefreshToken) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "oauthRefreshToken"}}
}
func (PlatformOAuthRefreshToken) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("token").StorageKey("token").Unique().Sensitive(),
		field.String("client_id").StorageKey("clientId"),
		field.String("session_id").StorageKey("sessionId"),
		field.String("user_id").StorageKey("userId"),
		field.String("reference_id").StorageKey("referenceId").Optional().Nillable(),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("created_at").StorageKey("createdAt"),
		field.Time("revoked").StorageKey("revoked").Optional().Nillable(),
		field.Time("auth_time").StorageKey("authTime").Optional().Nillable(),
		field.String("scopes").StorageKey("scopes"),
	}
}

type PlatformOAuthAccessToken struct{ ent.Schema }

func (PlatformOAuthAccessToken) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "oauthAccessToken"}}
}
func (PlatformOAuthAccessToken) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("token").StorageKey("token").Unique().Sensitive(),
		field.String("client_id").StorageKey("clientId"),
		field.String("session_id").StorageKey("sessionId"),
		field.String("user_id").StorageKey("userId"),
		field.String("reference_id").StorageKey("referenceId").Optional().Nillable(),
		field.String("refresh_id").StorageKey("refreshId").Optional().Nillable(),
		field.Time("expires_at").StorageKey("expiresAt"),
		field.Time("created_at").StorageKey("createdAt"),
		field.String("scopes").StorageKey("scopes"),
	}
}

type PlatformOAuthConsent struct{ ent.Schema }

func (PlatformOAuthConsent) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "oauthConsent"}}
}
func (PlatformOAuthConsent) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("client_id").StorageKey("clientId"),
		field.String("user_id").StorageKey("userId"),
		field.String("reference_id").StorageKey("referenceId").Optional().Nillable(),
		field.String("scopes").StorageKey("scopes"),
		field.Time("created_at").StorageKey("createdAt"),
		field.Time("updated_at").StorageKey("updatedAt"),
	}
}

type PlatformOAuthJWK struct{ ent.Schema }

func (PlatformOAuthJWK) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "jwks"}}
}
func (PlatformOAuthJWK) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("public_key").StorageKey("publicKey"),
		field.String("private_key").StorageKey("privateKey").Sensitive(),
		field.Time("created_at").StorageKey("createdAt"),
		field.Time("expires_at").StorageKey("expiresAt").Optional().Nillable(),
	}
}
