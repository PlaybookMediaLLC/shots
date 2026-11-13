package product

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/auditlog"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftfinisher"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftrevision"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdrafttag"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/user"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// Write (RFC 025): a draft's organizing properties, its plan, duplicating
// and copying it, recovering a backup as a new draft, its activity, and the
// tags and thread finishers of a social set.

const (
	contentDraftTagNameLimit   = 40
	contentDraftSetTagLimit    = 100
	contentDraftFinisherLength = 25_000
)

var tagColors = []string{"gray", "red", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink"}

// ContentDraftPropertiesInput changes a draft's organizing properties. They
// are not content: the version, and so any approval, stays.
type ContentDraftPropertiesInput struct {
	AddTagIDs              []string `json:"addTagIds"`
	Pinned                 *bool    `json:"pinned"`
	RemoveTagIDs           []string `json:"removeTagIds"`
	Scratchpad             *string  `json:"scratchpad"`
	SuppressSlackOnPublish *bool    `json:"suppressSlackOnPublish"`
}

// UpdateContentDraftProperties pins, tags or annotates a draft. Tags are
// added and removed by id, so two people tagging at once both count.
func (c *Configuration) UpdateContentDraftProperties(ctx context.Context, actor Actor, id string, input ContentDraftPropertiesInput) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if _, err := c.loadDraft(ctx, actor, id); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	draft, err := tx.ContentDraft.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	update := tx.ContentDraft.UpdateOneID(id)
	changed := []string{}
	if input.SuppressSlackOnPublish != nil && *input.SuppressSlackOnPublish != draft.SuppressSlackOnPublish {
		update.SetSuppressSlackOnPublish(*input.SuppressSlackOnPublish)
		changed = append(changed, "publish_slack_preference")
	}
	if input.Pinned != nil {
		if *input.Pinned && draft.PinnedAt == nil {
			update.SetPinnedAt(time.Now().UTC())
			changed = append(changed, "pinned")
		} else if !*input.Pinned && draft.PinnedAt != nil {
			update.ClearPinnedAt()
			changed = append(changed, "unpinned")
		}
	}
	if input.Scratchpad != nil {
		text, err := draftScratchpad(*input.Scratchpad)
		if err != nil {
			return nil, err
		}
		if text != draft.Scratchpad {
			update.SetScratchpad(text)
			changed = append(changed, "scratchpad")
		}
	}
	if len(input.AddTagIDs) > 0 || len(input.RemoveTagIDs) > 0 {
		set, err := c.draftWriteSet(ctx, tx.Client(), draft)
		if err != nil {
			return nil, err
		}
		if err := c.requireExperiment(ctx, actor, ExperimentDraftTags); err != nil {
			return nil, err
		}
		added, err := c.draftTagIDs(ctx, tx, actor, set.ID, input.AddTagIDs)
		if err != nil {
			return nil, err
		}
		tags := slices.DeleteFunc(append([]string{}, draft.TagIds...), func(tag string) bool { return slices.Contains(input.RemoveTagIDs, tag) })
		for _, tag := range added {
			if !slices.Contains(tags, tag) {
				tags = append(tags, tag)
			}
		}
		if len(tags) > contentDraftTagLimit {
			return nil, invalid(fmt.Sprintf("A draft can have at most %d tags.", contentDraftTagLimit))
		}
		if !slices.Equal(tags, draft.TagIds) {
			update.SetTagIds(tags)
			changed = append(changed, "tags")
		}
	}
	if len(changed) == 0 {
		result := contentDraftRecord(draft)
		return &result, tx.Commit()
	}
	// Properties are not content: updatedAt stays, so the list order does too.
	update.SetUpdatedAt(draft.UpdatedAt)
	row, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_properties_updated", "content_draft", id,
		map[string]any{"changed": changed}); err != nil {
		return nil, err
	}
	if err := emitDraftChanges(ctx, tx, draft, row); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// ContentDraftPlanInput puts a draft on the calendar at a time, or takes it
// off with a null time. A plan never publishes anything.
type ContentDraftPlanInput struct {
	BaseCalendarVersion int        `json:"baseCalendarVersion"`
	PlannedFor          *time.Time `json:"plannedFor"`
	TimeZone            string     `json:"timeZone"`
}

// PlanContentDraft sets or clears the draft's planned time. Planning makes no
// scheduled post, so a planned draft cannot publish when its time passes.
// The plan is kept as a backup, like a schedule.
func (c *Configuration) PlanContentDraft(ctx context.Context, actor Actor, id string, input ContentDraftPlanInput) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	draft, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	if draft.Status != contentdraft.StatusDraft {
		return nil, conflict("Only an unpublished draft can be planned. Unschedule or duplicate this content first.")
	}
	if err := ensureDraftCanPlan(ctx, tx.Client(), id); err != nil {
		return nil, err
	}
	// Legacy clients may initialize an untouched calendar placement. Never
	// infer the current revision for an existing plan: that would let a stale
	// client overwrite a teammate's date, including plans predating this field.
	if input.BaseCalendarVersion == 0 && draft.CalendarVersion == 1 && draft.PlannedFor == nil {
		input.BaseCalendarVersion = 1
	}
	if input.BaseCalendarVersion < 1 || input.BaseCalendarVersion != draft.CalendarVersion {
		return nil, conflict("The calendar changed. Reload before placing this draft.")
	}
	update := tx.ContentDraft.Update().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID), contentdraft.CalendarVersion(input.BaseCalendarVersion), contentdraft.Version(draft.Version)).AddCalendarVersion(1).SetUpdatedAt(draft.UpdatedAt)
	metadata := map[string]any{}
	if input.PlannedFor == nil {
		update.ClearPlannedFor().ClearPlanTimeZone()
		metadata["cleared"] = true
	} else {
		if err := ensurePlanningDestinations(ctx, tx.Client(), draft); err != nil {
			return nil, err
		}
		if !input.PlannedFor.After(time.Now()) {
			return nil, invalid("Plan the draft for a time in the future.")
		}
		zone := strings.TrimSpace(input.TimeZone)
		if _, err := time.LoadLocation(zone); zone == "" || err != nil {
			return nil, invalid("Plan the draft in an IANA time zone, such as Europe/Paris.")
		}
		update.SetPlannedFor(input.PlannedFor.UTC()).SetPlanTimeZone(zone)
		metadata["plannedFor"], metadata["timeZone"] = input.PlannedFor.UTC().Format(time.RFC3339), zone
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, publishing.ErrConflict
	}
	row, err := tx.ContentDraft.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if input.PlannedFor != nil {
		if err := recordContentDraftRevision(ctx, tx, actor, row, true, "plan"); err != nil {
			return nil, err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_planned", "content_draft", id, metadata); err != nil {
		return nil, err
	}
	if err := emitDraftChanges(ctx, tx, draft, row); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// ContentDraftCopyInput copies a draft into a social set. TagMode match
// keeps tags whose names the destination set has; drop leaves them behind.
type ContentDraftCopyInput struct {
	SocialSetID *string `json:"socialSetId"`
	TagMode     string  `json:"tagMode"`
}

// ContentDraftCopyResult is the new draft and what did not come with it.
type ContentDraftCopyResult struct {
	Draft ContentDraftRecord `json:"draft"`
	// Dropped names what the destination could not take: platforms the set
	// has no account for, and tags it has no match for.
	Dropped []string `json:"dropped"`
}

// copyDraft makes a new draft from content: a new id at version 1, a plain
// draft with no share link, guest comments, discussions, review, plan,
// scheduled posts, live session or pin. It records where it came from.
func (c *Configuration) copyDraft(ctx context.Context, tx *ent.Tx, actor Actor, source *ent.ContentDraft, content draftContent,
	set *ent.SocialSet, tags []string, reason string) (*ent.ContentDraft, []string, error) {
	dropped := []string{}
	sourceSet, err := c.draftWriteSet(ctx, tx.Client(), source)
	if err != nil {
		return nil, nil, err
	}
	sameSet := sourceSet.ID == set.ID
	// Destinations: the same platforms, on the destination set's accounts.
	sourceConnections, err := tx.ChannelConnection.Query().Where(channelconnection.IDIn(source.ChannelConnectionIds...),
		channelconnection.OrganizationID(actor.OrganizationID)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	setConnections, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.OrganizationID(actor.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	channels := []string{}
	available := map[string]bool{}
	for _, connection := range setConnections {
		available[draftPlatformChannels[connection.Platform]] = true
	}
	for _, connection := range sourceConnections {
		channel := draftPlatformChannels[connection.Platform]
		if sameSet {
			channels = append(channels, connection.ID)
			continue
		}
		matched := false
		for _, candidate := range setConnections {
			if draftPlatformChannels[candidate.Platform] == channel && !slices.Contains(channels, candidate.ID) {
				channels, matched = append(channels, candidate.ID), true
				break
			}
		}
		if !matched {
			dropped = append(dropped, "platform:"+channel)
		}
	}
	versions := draftdoc.PlatformVersions{SchemaVersion: draftdoc.SchemaVersion, Versions: []draftdoc.PlatformVersion{}}
	for _, version := range content.versions.Versions {
		if available[version.Channel] || sameSet {
			versions.Versions = append(versions.Versions, version)
		} else if !slices.Contains(dropped, "platform:"+version.Channel) {
			dropped = append(dropped, "platform:"+version.Channel)
		}
	}
	assets, err := contentDraftAssets(ctx, tx, actor.OrganizationID, content.assetIDs)
	if err != nil {
		return nil, nil, conflict("An image in this draft was deleted, so it cannot be copied.")
	}
	create := tx.ContentDraft.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetTitle(content.title).
		SetBody(content.body).SetPlainText(content.plainText).SetAssetIds(assets).SetChannelConnectionIds(channels).
		SetChannelText(content.channelText).SetKind(contentdraft.Kind(content.kind)).SetPrimaryPlatform(content.primary).
		SetPlatformVersions(versions).SetScratchpad(content.scratchpad).SetTagIds(tags).SetSourceDraftID(source.ID).
		SetSocialSetID(set.ID).SetNillableCreatedByUserID(projectActor(actor)).SetNillableUpdatedByUserID(projectActor(actor))
	// Within its set a copy keeps the draft's own choices; in another set it
	// takes that set's defaults, as a new draft there would.
	if sameSet {
		create.SetEngagement(source.Engagement).SetNaturalPostingTime(source.NaturalPostingTime)
	} else {
		create.SetEngagement(set.EngagementDefaults).SetNaturalPostingTime(set.NaturalPostingTimes)
	}
	if content.target != nil {
		create.SetTarget(content.target)
	}
	if content.article != nil {
		create.SetArticle(content.article)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, nil, err
	}
	if err := rememberDraftMentions(ctx, tx, row); err != nil {
		return nil, nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_created", "content_draft", row.ID,
		map[string]any{"kind": content.kind, "socialSetId": set.ID, "sourceDraftId": source.ID, "reason": reason}); err != nil {
		return nil, nil, err
	}
	return row.Unwrap(), dropped, nil
}

// draftContent is what a copy carries: the writing, never the draft's
// publication, sharing, review or discussion state.
type draftContent struct {
	article     *draftdoc.Article
	assetIDs    []string
	body        []any
	channelText map[string]string
	kind        string
	plainText   string
	primary     string
	scratchpad  string
	target      *draftdoc.Target
	title       string
	versions    draftdoc.PlatformVersions
}

func contentOf(draft *ent.ContentDraft) draftContent {
	return draftContent{article: draft.Article, assetIDs: nonNilStrings(draft.AssetIds), body: nonNilBody(draft.Body),
		channelText: nonNilChannelText(draft.ChannelText), kind: string(draft.Kind), plainText: draft.PlainText,
		primary: draftPrimary(draft), scratchpad: draft.Scratchpad, target: draft.Target, title: draft.Title,
		versions: nonNilVersions(draft.PlatformVersions)}
}

// copiedTitle marks a copy's title, within the title limit.
func copiedTitle(title, mark string) string {
	next := strings.TrimSpace(title + " " + mark)
	if utf8.RuneCountInString(next) > contentDraftTitleLimit {
		next = string([]rune(next)[:contentDraftTitleLimit])
	}
	return next
}

// DuplicateContentDraft copies a draft within its social set.
func (c *Configuration) DuplicateContentDraft(ctx context.Context, actor Actor, id string) (*ContentDraftCopyResult, error) {
	return c.DuplicateContentDraftWithKey(ctx, actor, id, "")
}

// DuplicateContentDraftWithKey makes retries of a published-content reuse safe.
func (c *Configuration) DuplicateContentDraftWithKey(ctx context.Context, actor Actor, id, key string) (*ContentDraftCopyResult, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	source, err := c.loadDraft(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	set, err := c.draftWriteSet(ctx, c.client, source)
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	replay, hash, err := beginDraftReuse(ctx, tx, actor, id, key)
	if err != nil {
		return nil, err
	}
	if replay != nil {
		return replay, nil
	}
	content := contentOf(source)
	content.title = copiedTitle(source.Title, "(copy)")
	row, dropped, err := c.copyDraft(ctx, tx, actor, source, content, set, nonNilStrings(source.TagIds), "duplicate")
	if err != nil {
		return nil, err
	}
	result := &ContentDraftCopyResult{Draft: contentDraftRecord(row), Dropped: dropped}
	if key != "" {
		data, _ := json.Marshal(result)
		saved := map[string]any{}
		_ = json.Unmarshal(data, &saved)
		if _, err := tx.CalendarMutation.Create().SetID(calendarReceiptID(actor, key)).SetOrganizationID(actor.OrganizationID).SetActorID(actor.UserID).SetInputHash(hash).SetResult(saved).Save(ctx); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

// CopyContentDraftToSet copies a draft into another social set the actor may
// write in. Destinations become the set's accounts on the same platforms;
// tags are matched by name or dropped, as asked.
func (c *Configuration) CopyContentDraftToSet(ctx context.Context, actor Actor, id string, input ContentDraftCopyInput) (*ContentDraftCopyResult, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if input.TagMode != "match" && input.TagMode != "drop" {
		return nil, invalid("Choose whether tags are matched by name or dropped.")
	}
	source, err := c.loadDraft(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	setID := ""
	if input.SocialSetID != nil {
		setID = *input.SocialSetID
	}
	set, err := c.writeSet(ctx, actor, setID)
	if err != nil {
		return nil, err
	}
	if err := draftKindChannel(string(source.Kind), draftPrimary(source)); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	tags := []string{}
	dropped := []string{}
	if len(source.TagIds) > 0 {
		sourceTags, err := tx.ContentDraftTag.Query().Where(contentdrafttag.IDIn(source.TagIds...),
			contentdrafttag.OrganizationID(actor.OrganizationID)).All(ctx)
		if err != nil {
			return nil, err
		}
		targetTags, err := tx.ContentDraftTag.Query().Where(contentdrafttag.SocialSetID(set.ID),
			contentdrafttag.OrganizationID(actor.OrganizationID)).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, tag := range sourceTags {
			matched := false
			if input.TagMode == "match" {
				for _, candidate := range targetTags {
					if strings.EqualFold(candidate.Name, tag.Name) {
						tags, matched = append(tags, candidate.ID), true
						break
					}
				}
			}
			if !matched {
				dropped = append(dropped, "tag:"+tag.Name)
			}
		}
	}
	row, droppedPlatforms, err := c.copyDraft(ctx, tx, actor, source, contentOf(source), set, tags, "copy")
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ContentDraftCopyResult{Draft: contentDraftRecord(row), Dropped: append(droppedPlatforms, dropped...)}, nil
}

// RecoverContentDraftRevision makes a new draft from a backup. The source
// draft is left exactly as it is, and the new one has no publication state.
func (c *Configuration) RecoverContentDraftRevision(ctx context.Context, actor Actor, draftID, revisionID string) (*ContentDraftCopyResult, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	source, err := c.loadDraft(ctx, actor, draftID)
	if err != nil {
		return nil, err
	}
	revision, err := c.client.ContentDraftRevision.Query().Where(contentdraftrevision.ID(revisionID),
		contentdraftrevision.ContentDraftID(draftID), contentdraftrevision.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	set, err := c.draftWriteSet(ctx, c.client, source)
	if err != nil {
		return nil, err
	}
	content := contentOf(source)
	content.title = copiedTitle(revision.Title, "(recovered)")
	content.body, content.plainText = nonNilBody(revision.Body), revision.PlainText
	content.assetIDs = assetsInBody(revision.Body)
	if revision.PlatformVersions.SchemaVersion != 0 {
		content.versions = nonNilVersions(revision.PlatformVersions)
	}
	if revision.Article != nil {
		content.article = revision.Article
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, dropped, err := c.copyDraft(ctx, tx, actor, source, content, set, nonNilStrings(source.TagIds), "recovery")
	if err != nil {
		return nil, err
	}
	if err := recordContentDraftRevision(ctx, tx, actor, row, true, "recovery"); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_recovered", "content_draft", draftID,
		map[string]any{"revisionId": revisionID, "newDraftId": row.ID, "version": revision.Version}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ContentDraftCopyResult{Draft: contentDraftRecord(row), Dropped: dropped}, nil
}

// assetsInBody lists the uploaded images and videos a Plate body holds, in order.
func assetsInBody(body []any) []string {
	ids := []string{}
	var walk func(any)
	walk = func(node any) {
		switch value := node.(type) {
		case []any:
			for _, child := range value {
				walk(child)
			}
		case map[string]any:
			if id, ok := value["assetId"].(string); ok && id != "" && !slices.Contains(ids, id) {
				ids = append(ids, id)
			}
			walk(value["children"])
		}
	}
	walk(body)
	return ids
}

// ContentDraftActivity is one event in a draft's history: who did what and
// when, with references only, never the draft's text.
type ContentDraftActivity struct {
	Action    string         `json:"action"`
	ActorName *string        `json:"actorName"`
	ActorType string         `json:"actorType"`
	ActorID   *string        `json:"actorUserId"`
	At        time.Time      `json:"at"`
	EntityID  string         `json:"entityId"`
	ID        string         `json:"id"`
	Metadata  map[string]any `json:"metadata"`
	// Source is who or what made the change: person, api, mcp, workflow,
	// callback, support, or automation for any other service.
	Source string `json:"source"`
}

// ContentDraftActivityPage is one page of a draft's history, newest first.
type ContentDraftActivityPage struct {
	Items      []ContentDraftActivity `json:"items"`
	NextCursor *string                `json:"nextCursor"`
}

// contentDraftActivityPageSize is how many events a page of history holds.
const contentDraftActivityPageSize = 50

// activitySource labels who or what made an audited change, from the row's
// actor type and the safe source label automated writers record.
func activitySource(row *ent.AuditLog) string {
	switch row.ActorType {
	case auditlog.ActorTypeUSER:
		return "person"
	case auditlog.ActorTypeSUPPORT:
		return "support"
	case auditlog.ActorTypeWEBHOOK:
		return "callback"
	}
	if source, _ := row.Metadata["actorSource"].(string); slices.Contains([]string{"api", "mcp", "workflow", "callback"}, source) {
		return source
	}
	return "automation"
}

// activityMetadataKeys are the metadata a timeline may show.
var activityMetadataKeys = []string{"action", "cancelledPostIds", "changed", "cleared", "fields", "from", "kind", "newDraftId",
	"plannedFor", "posted", "reason", "revisionId", "scheduledFor", "scheduledPostIds", "socialSetId", "sourceDraftId",
	"timeZone", "version", "enabled", "contentDraftId", "failureCode", "outcome"}

// ListContentDraftActivity reads a page of a draft's history from the audit
// log: the draft's own events and those of the posts scheduled from it, newest
// first (by time, then id). cursor is the previous page's NextCursor, or empty.
// Reading a draft writes nothing, so viewing is never activity.
func (c *Configuration) ListContentDraftActivity(ctx context.Context, actor Actor, draftID, cursor string) (*ContentDraftActivityPage, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := c.loadDraft(ctx, actor, draftID); err != nil {
		return nil, err
	}
	postIDs, err := c.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftID(draftID),
		scheduledpost.OrganizationID(actor.OrganizationID)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	query := c.client.AuditLog.Query().Where(auditlog.OrganizationID(actor.OrganizationID), auditlog.Or(
		auditlog.And(auditlog.EntityType("content_draft"), auditlog.EntityID(draftID)),
		auditlog.And(auditlog.EntityType("scheduled_post"), auditlog.EntityIDIn(postIDs...))))
	if cursor != "" {
		at, id, err := decodeTimeCursor(cursor)
		if err != nil {
			return nil, err
		}
		query.Where(auditlog.Or(auditlog.CreatedAtLT(at), auditlog.And(auditlog.CreatedAt(at), auditlog.IDLT(id))))
	}
	rows, err := query.Order(ent.Desc(auditlog.FieldCreatedAt), ent.Desc(auditlog.FieldID)).
		Limit(contentDraftActivityPageSize + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	page := &ContentDraftActivityPage{}
	if len(rows) > contentDraftActivityPageSize {
		rows = rows[:contentDraftActivityPageSize]
		last := rows[len(rows)-1]
		next := encodeTimeCursor(last.CreatedAt, last.ID)
		page.NextCursor = &next
	}
	people := map[string]*string{}
	for _, row := range rows {
		if row.ActorUserID != nil {
			people[*row.ActorUserID] = nil
		}
	}
	ids := make([]string, 0, len(people))
	for id := range people {
		ids = append(ids, id)
	}
	users, err := c.client.User.Query().Where(user.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, person := range users {
		name := person.Name
		people[person.ID] = &name
	}
	items := make([]ContentDraftActivity, 0, len(rows))
	for _, row := range rows {
		metadata := map[string]any{}
		for _, key := range activityMetadataKeys {
			if value, ok := row.Metadata[key]; ok {
				metadata[key] = value
			}
		}
		item := ContentDraftActivity{Action: row.Action, ActorType: string(row.ActorType), ActorID: row.ActorUserID,
			At: row.CreatedAt, ID: row.ID, Metadata: metadata, Source: activitySource(row)}
		if row.EntityID != nil {
			item.EntityID = *row.EntityID
		}
		if row.ActorUserID != nil {
			item.ActorName = people[*row.ActorUserID]
		}
		items = append(items, item)
	}
	page.Items = items
	return page, nil
}

// ContentDraftTagRecord is a set's tag.
type ContentDraftTagRecord struct {
	Color       string    `json:"color"`
	CreatedAt   time.Time `json:"createdAt"`
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	SocialSetID string    `json:"socialSetId"`
}

// ContentDraftTagInput names and colours a tag.
type ContentDraftTagInput struct {
	Color *string `json:"color"`
	Name  *string `json:"name"`
}

func tagRecord(row *ent.ContentDraftTag) ContentDraftTagRecord {
	return ContentDraftTagRecord{Color: row.Color, CreatedAt: row.CreatedAt, ID: row.ID, Name: row.Name, SocialSetID: row.SocialSetID}
}

// visibleSet reads a set the actor may see, by id.
func (c *Configuration) visibleSet(ctx context.Context, actor Actor, setID string) (*ent.SocialSet, error) {
	return visibleSocialSet(ctx, c.client, actor, setID)
}

// ListContentDraftTags lists a set's tags, oldest first.
func (c *Configuration) ListContentDraftTags(ctx context.Context, actor Actor, setID string) ([]ContentDraftTagRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	rows, err := c.client.ContentDraftTag.Query().Where(contentdrafttag.SocialSetID(setID),
		contentdrafttag.OrganizationID(actor.OrganizationID)).Order(ent.Asc(contentdrafttag.FieldCreatedAt), ent.Asc(contentdrafttag.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ContentDraftTagRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, tagRecord(row))
	}
	return items, nil
}

func tagFields(input ContentDraftTagInput, create bool) (string, string, error) {
	name, color := "", ""
	if input.Name != nil {
		name = strings.TrimSpace(*input.Name)
		if name == "" || utf8.RuneCountInString(name) > contentDraftTagNameLimit {
			return "", "", invalid(fmt.Sprintf("Name the tag in 1 to %d characters.", contentDraftTagNameLimit))
		}
	} else if create {
		return "", "", invalid("Name the tag.")
	}
	if input.Color != nil {
		if !slices.Contains(tagColors, *input.Color) {
			return "", "", invalid("Pick one of the tag colours: " + strings.Join(tagColors, ", ") + ".")
		}
		color = *input.Color
	}
	return name, color, nil
}

// CreateContentDraftTag adds a tag to a set; names are unique within a set.
func (c *Configuration) CreateContentDraftTag(ctx context.Context, actor Actor, setID string, input ContentDraftTagInput) (*ContentDraftTagRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	name, color, err := tagFields(input, true)
	if err != nil {
		return nil, err
	}
	count, err := c.client.ContentDraftTag.Query().Where(contentdrafttag.SocialSetID(setID)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count >= contentDraftSetTagLimit {
		return nil, conflict(fmt.Sprintf("A set can have up to %d tags.", contentDraftSetTagLimit))
	}
	create := c.client.ContentDraftTag.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSocialSetID(setID).SetName(name)
	if color != "" {
		create.SetColor(color)
	}
	row, err := create.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This set already has a tag named " + name + ".")
	}
	if err != nil {
		return nil, err
	}
	result := tagRecord(row)
	return &result, nil
}

// UpdateContentDraftTag renames or recolours a set's tag.
func (c *Configuration) UpdateContentDraftTag(ctx context.Context, actor Actor, setID, tagID string, input ContentDraftTagInput) (*ContentDraftTagRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	name, color, err := tagFields(input, false)
	if err != nil {
		return nil, err
	}
	update := c.client.ContentDraftTag.Update().Where(contentdrafttag.ID(tagID), contentdrafttag.SocialSetID(setID),
		contentdrafttag.OrganizationID(actor.OrganizationID))
	if name != "" {
		update.SetName(name)
	}
	if color != "" {
		update.SetColor(color)
	}
	count, err := update.Save(ctx)
	if ent.IsConstraintError(err) {
		return nil, conflict("This set already has a tag named " + name + ".")
	}
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, publishing.ErrNotFound
	}
	row, err := c.client.ContentDraftTag.Get(ctx, tagID)
	if err != nil {
		return nil, err
	}
	result := tagRecord(row)
	return &result, nil
}

// DeleteContentDraftTag removes a tag and takes it off the set's drafts.
func (c *Configuration) DeleteContentDraftTag(ctx context.Context, actor Actor, setID, tagID string) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	count, err := tx.ContentDraftTag.Delete().Where(contentdrafttag.ID(tagID), contentdrafttag.SocialSetID(setID),
		contentdrafttag.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return publishing.ErrNotFound
	}
	// Untag in place: the drafts' versions and order stay.
	if _, err := tx.PlatformExec(ctx, `UPDATE content_draft SET "tagIds" = "tagIds" - $1 WHERE "organizationId"=$2 AND "tagIds" ? $1`,
		tagID, actor.OrganizationID); err != nil {
		return err
	}
	return tx.Commit()
}

// ContentDraftFinisherRecord is a set's thread finisher.
type ContentDraftFinisherRecord struct {
	CreatedAt      time.Time `json:"createdAt"`
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	QuoteFirstPost bool      `json:"quoteFirstPost"`
	SocialSetID    string    `json:"socialSetId"`
	Text           string    `json:"text"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// ContentDraftFinisherInput writes a finisher.
type ContentDraftFinisherInput struct {
	Name           *string `json:"name"`
	QuoteFirstPost *bool   `json:"quoteFirstPost"`
	Text           *string `json:"text"`
}

func finisherRecord(row *ent.ContentDraftFinisher) ContentDraftFinisherRecord {
	return ContentDraftFinisherRecord{CreatedAt: row.CreatedAt, ID: row.ID, Name: row.Name, QuoteFirstPost: row.QuoteFirstPost,
		SocialSetID: row.SocialSetID, Text: row.Text, UpdatedAt: row.UpdatedAt}
}

// ListContentDraftFinishers lists a set's finishers, oldest first.
func (c *Configuration) ListContentDraftFinishers(ctx context.Context, actor Actor, setID string) ([]ContentDraftFinisherRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	rows, err := c.client.ContentDraftFinisher.Query().Where(contentdraftfinisher.SocialSetID(setID),
		contentdraftfinisher.OrganizationID(actor.OrganizationID)).Order(ent.Asc(contentdraftfinisher.FieldCreatedAt), ent.Asc(contentdraftfinisher.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ContentDraftFinisherRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, finisherRecord(row))
	}
	return items, nil
}

func finisherFields(input ContentDraftFinisherInput, create bool) error {
	if create && (input.Name == nil || input.Text == nil) {
		return invalid("A finisher has a name and text.")
	}
	if input.Name != nil {
		if name := strings.TrimSpace(*input.Name); name == "" || utf8.RuneCountInString(name) > 80 {
			return invalid("Name the finisher in 1 to 80 characters.")
		}
	}
	if input.Text != nil {
		if text := strings.TrimSpace(*input.Text); text == "" || utf8.RuneCountInString(text) > contentDraftFinisherLength {
			return invalid("Write the finisher's text, under 25,000 characters.")
		}
	}
	return nil
}

// CreateContentDraftFinisher adds a finisher to a set.
func (c *Configuration) CreateContentDraftFinisher(ctx context.Context, actor Actor, setID string, input ContentDraftFinisherInput) (*ContentDraftFinisherRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	if err := finisherFields(input, true); err != nil {
		return nil, err
	}
	create := c.client.ContentDraftFinisher.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetSocialSetID(setID).
		SetName(strings.TrimSpace(*input.Name)).SetText(strings.TrimSpace(*input.Text))
	if input.QuoteFirstPost != nil {
		create.SetQuoteFirstPost(*input.QuoteFirstPost)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	result := finisherRecord(row)
	return &result, nil
}

// UpdateContentDraftFinisher edits a set's finisher.
func (c *Configuration) UpdateContentDraftFinisher(ctx context.Context, actor Actor, setID, finisherID string, input ContentDraftFinisherInput) (*ContentDraftFinisherRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return nil, err
	}
	if err := finisherFields(input, false); err != nil {
		return nil, err
	}
	update := c.client.ContentDraftFinisher.Update().Where(contentdraftfinisher.ID(finisherID), contentdraftfinisher.SocialSetID(setID),
		contentdraftfinisher.OrganizationID(actor.OrganizationID))
	if input.Name != nil {
		update.SetName(strings.TrimSpace(*input.Name))
	}
	if input.Text != nil {
		update.SetText(strings.TrimSpace(*input.Text))
	}
	if input.QuoteFirstPost != nil {
		update.SetQuoteFirstPost(*input.QuoteFirstPost)
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, publishing.ErrNotFound
	}
	row, err := c.client.ContentDraftFinisher.Get(ctx, finisherID)
	if err != nil {
		return nil, err
	}
	result := finisherRecord(row)
	return &result, nil
}

// DeleteContentDraftFinisher removes a set's finisher.
func (c *Configuration) DeleteContentDraftFinisher(ctx context.Context, actor Actor, setID, finisherID string) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	if _, err := c.visibleSet(ctx, actor, setID); err != nil {
		return err
	}
	count, err := c.client.ContentDraftFinisher.Delete().Where(contentdraftfinisher.ID(finisherID), contentdraftfinisher.SocialSetID(setID),
		contentdraftfinisher.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return publishing.ErrNotFound
	}
	return nil
}
