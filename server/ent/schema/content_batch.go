package schema

import (
	"time"

	"entgo.io/ent"
	"entgo.io/ent/dialect/entsql"
	"entgo.io/ent/schema"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// ContentBatch is a set of separate posts prepared together (RFC 042 bulk
// scheduling): up to 50 items in one social set, which survive a refresh or a
// closed tab. Each item becomes its own content draft, so review, scheduling
// and publication status stay on the draft and its scheduled posts.
type ContentBatch struct{ ent.Schema }

func (ContentBatch) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "content_batch"}}
}

func (ContentBatch) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		field.String("social_set_id").StorageKey("socialSetId").Immutable(),
		field.String("created_by_user_id").StorageKey("createdByUserId").Optional().Nillable().Immutable(),
		field.String("title"),
		field.Time("archived_at").StorageKey("archivedAt").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ContentBatch) Indexes() []ent.Index {
	return []ent.Index{index.Fields("organization_id", "created_at")}
}

// BatchMedia is one attachment of a batch item, in order: an uploaded asset,
// or a selected file that has not finished uploading (FileName, and the
// asset reserved for it once its upload starts).
type BatchMedia struct {
	AssetID       string `json:"assetId,omitempty"`
	FileName      string `json:"fileName,omitempty"`
	Bytes         int    `json:"bytes,omitempty"`
	UploadAssetID string `json:"uploadAssetId,omitempty"`
}

// BatchTiming is when an item is meant to go out: a local time in an IANA zone
// (Disambiguation picks a repeated hour), or the queue at a previewed slot.
type BatchTiming struct {
	Mode              string     `json:"mode,omitempty"`
	LocalTime         string     `json:"localTime,omitempty"`
	TimeZone          string     `json:"timeZone,omitempty"`
	Disambiguation    string     `json:"disambiguation,omitempty"`
	ExpectedQueueSlot *time.Time `json:"expectedQueueSlot,omitempty"`
}

// ContentBatchItem is one post of a batch. Its caption, media and accounts are
// staged here until its draft exists; after that the draft is the source of
// truth and the item keeps only its intended time and order.
type ContentBatchItem struct{ ent.Schema }

func (ContentBatchItem) Annotations() []schema.Annotation {
	return []schema.Annotation{entsql.Annotation{Table: "content_batch_item"}}
}

func (ContentBatchItem) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Immutable(),
		field.String("batch_id").StorageKey("batchId").Immutable(),
		field.String("organization_id").StorageKey("organizationId").Immutable(),
		// ImportKey is the client's retry key for the item and its draft.
		field.String("import_key").StorageKey("importKey").Immutable(),
		// Fingerprint is the creation input's digest: a reused key must match it.
		field.String("fingerprint").Immutable(),
		// SourceKey is the file or folder name the item came from, for caption CSVs.
		field.String("source_key").StorageKey("sourceKey").Default("").Immutable(),
		field.Int("position"),
		field.String("caption").Default(""),
		field.JSON("media", []BatchMedia{}).StorageKey("media"),
		field.JSON("channel_connection_ids", []string{}).StorageKey("channelConnectionIds"),
		field.JSON("timing", BatchTiming{}).StorageKey("timing"),
		field.String("draft_id").StorageKey("draftId").Optional().Nillable(),
		field.Time("created_at").StorageKey("createdAt").Default(time.Now).Immutable(),
		field.Time("updated_at").StorageKey("updatedAt").Default(time.Now).UpdateDefault(time.Now),
	}
}

func (ContentBatchItem) Indexes() []ent.Index {
	return []ent.Index{
		index.Fields("batch_id", "import_key").Unique(),
		index.Fields("batch_id", "position"),
		index.Fields("draft_id").Unique(),
	}
}
