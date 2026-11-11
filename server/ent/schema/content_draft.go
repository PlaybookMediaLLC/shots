package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
)

// ContentDraft is a post a user writes by hand in the document editor, keeps
// as a draft, and schedules to one or more channels (RFC 013). Every write
// bumps version, so a writer holding an older version is refused instead of
// overwriting newer work.
type ContentDraft struct{ ent.Schema }

func (ContentDraft) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "content_draft"}}
}

func (ContentDraft) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").StorageKey("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("title").StorageKey("title"),
		// Plate JSON: the editor's value, a list of block nodes.
		field.JSON("body", []any{}).StorageKey("body"),
		field.String("plain_text").StorageKey("plainText"),
		field.JSON("asset_ids", []string{}).StorageKey("assetIds"),
		field.JSON("channel_connection_ids", []string{}).StorageKey("channelConnectionIds"),
		// Comment threads on the body, and the people who wrote them.
		field.JSON("discussions", map[string]any{}).StorageKey("discussions").Default(map[string]any{}),
		// Text a channel posts instead of the body's, by channel (x, linkedin, instagram).
		field.JSON("channel_text", map[string]string{}).StorageKey("channelText").Default(map[string]string{}),
		field.Enum("status").StorageKey("status").Values("draft", "scheduled", "archived").Default("draft"),
		// Review before scheduling, when the workspace asks for it: approval
		// holds for approved_version only, so an edit after it needs another.
		field.Enum("review_status").StorageKey("reviewStatus").Values("none", "pending", "approved", "changes_requested").Default("none"),
		field.Int("approved_version").StorageKey("approvedVersion").Optional().Nillable(),
		field.String("reviewed_by_user_id").StorageKey("reviewedByUserId").Optional().Nillable(),
		field.String("review_note").StorageKey("reviewNote").Optional().Nillable(),
		// A read-and-comment link for people outside the workspace: on while set.
		field.String("share_token").StorageKey("shareToken").Optional().Nillable(),
		// Comments left through that link: name, text and when.
		field.JSON("guest_comments", []map[string]string{}).StorageKey("guestComments").Default([]map[string]string{}),
		field.Int("calendar_version").StorageKey("calendarVersion").Default(1),
		field.Int("version").StorageKey("version").Default(1),
		// The set the draft belongs to (RFC 024), and what it copied from the
		// set when it was created: copies, so changing the set's defaults
		// never changes an existing draft.
		field.String("social_set_id").StorageKey("socialSetId").Optional().Nillable(),
		field.String("primary_platform").StorageKey("primaryPlatform").Optional().Nillable(),
		field.Bool("natural_posting_time").StorageKey("naturalPostingTime").Default(false),
		field.JSON("engagement", Engagement{}).StorageKey("engagement").Default(Engagement{}),
		// A calendar placement without scheduling: nothing publishes from it.
		field.Time("planned_for").StorageKey("plannedFor").Optional().Nillable(),
		// Write (RFC 025): standard (a post or thread), reply, quote, repurpose or article.
		field.Enum("kind").StorageKey("kind").Values("standard", "reply", "quote", "repurpose", "article").Default("standard").Immutable(),
		// The post a reply answers or a quote embeds, or a repurposed draft's source.
		field.JSON("target", &draftdoc.Target{}).StorageKey("target").Optional(),
		// Each platform's version: synced from the primary body or its own.
		field.JSON("platform_versions", draftdoc.PlatformVersions{}).StorageKey("platformVersions").
			Default(draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{}}),
		field.JSON("article", &draftdoc.Article{}).StorageKey("article").Optional(),
		// Internal: never part of a post.
		field.String("scratchpad").StorageKey("scratchpad").Default(""),
		// A delivery preference, never approval or publication content.
		field.Bool("suppress_slack_on_publish").StorageKey("suppressSlackOnPublish").Default(false),
		// Tags of the draft's set (content_draft_tag), by id.
		field.JSON("tag_ids", []string{}).StorageKey("tagIds").Default([]string{}),
		field.Time("pinned_at").StorageKey("pinnedAt").Optional().Nillable(),
		// The zone a planned time was chosen in.
		field.String("plan_time_zone").StorageKey("planTimeZone").Optional().Nillable(),
		// The draft this one was duplicated, copied or recovered from.
		field.String("source_draft_id").StorageKey("sourceDraftId").Optional().Nillable().Immutable(),
		// The voice transcript revision this draft was made from. No foreign
		// key: the draft keeps its text after the note is deleted, and the
		// source then reads as removed (voice plan, V5 and K15).
		field.String("source_voice_revision_id").StorageKey("sourceVoiceRevisionId").Optional().Nillable().Immutable(),
		// The campaign an edited campaign visual was published from
		// (campaign_publish_draft.go). The draft publishes through Publish
		// like any other; this only keeps the campaign it came from reachable.
		field.String("campaign_id").StorageKey("campaignId").Optional().Nillable().Immutable(),
		// Yjs document state, written only by the collaboration service.
		// External body replacements invalidate cached rooms and projections.
		field.Int("collab_generation").StorageKey("collabGeneration").Default(0).NonNegative(),
		field.Bytes("collab_state").StorageKey("collabState").Optional().Nillable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable(),
		field.String("updated_by_user_id").StorageKey("updatedByUserId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ContentDraft) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("organization_id", "updated_at"),
		index.Fields("social_set_id", "updated_at"),
		index.Fields("organization_id", "campaign_id"),
	}
}
