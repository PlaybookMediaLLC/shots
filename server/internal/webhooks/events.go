// Package webhooks delivers a workspace's events to the HTTPS endpoints it
// subscribes (RFC 024, closing the outbound half of RFC 015). Events are
// written to the transactional outbox with the change they describe; the
// dispatcher fans each out to matching subscriptions and delivers it, signed,
// at least once.
package webhooks

import (
	"context"
	"encoding/json"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/lucsky/cuid"
)

// SchemaVersion is the envelope's version; a breaking change bumps it.
const SchemaVersion = 1

// Event types a subscription can receive. The names are Screenshot Studio's
// own, stable wire identifiers.
const (
	DraftCreated             = "draft.created"
	DraftUpdated             = "draft.updated"
	DraftScheduled           = "draft.scheduled"
	DraftPlanned             = "draft.planned"
	DraftStatusChanged       = "draft.status_changed"
	DraftTagsChanged         = "draft.tags_changed"
	DraftPublished           = "draft.published"
	DraftDeleted             = "draft.deleted"
	PostCompleted            = "post.completed"
	ConnectionNeedsReconnect = "connection.needs_reconnect"
	// Test is sent only when an admin asks for a test delivery.
	Test = "webhook.test"
)

// EventTypes are the events a subscription can choose, in display order.
var EventTypes = []string{
	DraftCreated, DraftUpdated, DraftPublished, DraftScheduled, DraftPlanned,
	DraftStatusChanged, DraftTagsChanged, DraftDeleted,
	PostCompleted, ConnectionNeedsReconnect,
}

// KnownEvent reports whether kind is an event a subscription can choose.
func KnownEvent(kind string) bool {
	for _, known := range EventTypes {
		if known == kind {
			return true
		}
	}
	return false
}

// Resource is what an event is about.
type Resource struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

// Envelope is the body every delivery carries. Data is redacted by its
// emitter: identifiers, titles, statuses, tags, platforms and times, never
// draft bodies, comments, members or credentials.
type Envelope struct {
	Data          map[string]any `json:"data"`
	ID            string         `json:"id"`
	OccurredAt    time.Time      `json:"occurredAt"`
	Resource      Resource       `json:"resource"`
	SchemaVersion int            `json:"schemaVersion"`
	SocialSetID   *string        `json:"socialSetId"`
	Type          string         `json:"type"`
	WorkspaceID   string         `json:"workspaceId"`
}

// NewEnvelope builds an event with a fresh, stable ID.
func NewEnvelope(workspaceID, kind string, socialSetID *string, resource Resource, data map[string]any) Envelope {
	if data == nil {
		data = map[string]any{}
	}
	return Envelope{Data: data, ID: "evt_" + cuid.New(), OccurredAt: time.Now().UTC().Truncate(time.Millisecond),
		Resource: resource, SchemaVersion: SchemaVersion, SocialSetID: socialSetID, Type: kind, WorkspaceID: workspaceID}
}

// Emit writes the event to the outbox inside the caller's transaction, so it
// exists if and only if the change it describes commits.
func Emit(ctx context.Context, tx *ent.Tx, envelope Envelope) error {
	// A workspace webhook has no private-set owner identity.
	if envelope.SocialSetID != nil {
		visible, err := tx.SocialSet.Query().Where(socialset.ID(*envelope.SocialSetID), socialset.OrganizationID(envelope.WorkspaceID), socialset.VisibilityEQ(socialset.VisibilityWORKSPACE)).Exist(ctx)
		if err != nil {
			return err
		}
		if !visible {
			return nil
		}
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	payload := map[string]any{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return err
	}
	return tx.OutboxEvent.Create().SetID(envelope.ID).SetOrganizationID(envelope.WorkspaceID).SetType("webhook." + envelope.Type).
		SetAggregateType(envelope.Resource.Type).SetAggregateID(envelope.Resource.ID).SetPayload(payload).
		SetIdempotencyKey("webhook:" + envelope.ID).Exec(ctx)
}
