package product

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/sqljson"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/asset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdrafttag"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/predicate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/draftdoc"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/lucsky/cuid"
)

// Content drafts (RFC 013): posts written by hand in the document editor.
// Reading needs any workspace role; writing needs the roles that edit
// artifacts. Every operation is plan-gated by contentDraftFeature.
const (
	contentDraftFeature       = "content:drafts"
	contentDraftTitleLimit    = 200
	contentDraftBodyLimit     = 1 << 20
	contentDraftTextLimit     = 100_000
	contentDraftAssetLimit    = 20
	contentDraftChannelLimit  = 10
	contentDraftThreadsLimit  = 256 << 10
	contentDraftUntitledTitle = "Untitled draft"
)

var (
	contentDraftEditRoles = []string{"owner", "admin", "creator"}
	// The same shape the HTTP layer accepts for path IDs: a cuid or a UUID.
	contentDraftRefPattern = regexp.MustCompile(`^(?:[a-z0-9]{10,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`)
)

// ContentDraftVersionConflictError refuses a write made against an older
// version. Current is the version the draft is at now.
type ContentDraftVersionConflictError struct{ Current int }

func (e *ContentDraftVersionConflictError) Error() string {
	return fmt.Sprintf("This draft was saved elsewhere since you opened it; it is now at version %d.", e.Current)
}

func (e *ContentDraftVersionConflictError) Unwrap() error { return publishing.ErrConflict }

// ContentDraftRecord is a draft as the API returns it. The collaboration
// state is not part of it.
type ContentDraftRecord struct {
	CollabGeneration     int               `json:"collabGeneration"`
	AssetIDs             []string          `json:"assetIds"`
	Body                 []any             `json:"body"`
	ChannelConnectionIDs []string          `json:"channelConnectionIds"`
	CreatedAt            time.Time         `json:"createdAt"`
	CreatedByUserID      *string           `json:"createdByUserId"`
	ChannelText          map[string]string `json:"channelText"`
	Discussions          map[string]any    `json:"discussions"`
	ID                   string            `json:"id"`
	OrganizationID       string            `json:"organizationId"`
	PlainText            string            `json:"plainText"`
	Status               string            `json:"status"`
	Title                string            `json:"title"`
	UpdatedAt            time.Time         `json:"updatedAt"`
	UpdatedByUserID      *string           `json:"updatedByUserId"`
	CalendarVersion      int               `json:"calendarVersion"`
	Version              int               `json:"version"`
	// Review before scheduling: none, pending, approved or changes_requested;
	// approval holds for ApprovedVersion only.
	ApprovedVersion  *int                `json:"approvedVersion"`
	ReviewNote       *string             `json:"reviewNote"`
	ReviewStatus     string              `json:"reviewStatus"`
	ReviewedByUserID *string             `json:"reviewedByUserId"`
	ShareToken       *string             `json:"shareToken"`
	GuestComments    []map[string]string `json:"guestComments"`
	// PublishedPosts counts the draft's live posts (lists only).
	PublishedPosts int `json:"publishedPosts"`
	// The draft's social set and what it copied from the set's defaults when
	// it was created (RFC 024); later changes to the set leave these alone.
	SuppressSlackOnPublish bool              `json:"suppressSlackOnPublish"`
	Engagement             schema.Engagement `json:"engagement"`
	NaturalPostingTime     bool              `json:"naturalPostingTime"`
	PlannedFor             *time.Time        `json:"plannedFor"`
	PrimaryPlatform        *string           `json:"primaryPlatform"`
	SocialSetID            *string           `json:"socialSetId"`
	// Write (RFC 025): the draft's kind and target, platform versions,
	// article, internal scratchpad, tags of its set, pin and plan zone.
	Article          *draftdoc.Article         `json:"article"`
	Kind             string                    `json:"kind"`
	PinnedAt         *time.Time                `json:"pinnedAt"`
	PlanTimeZone     *string                   `json:"planTimeZone"`
	PlatformVersions draftdoc.PlatformVersions `json:"platformVersions"`
	Scratchpad       string                    `json:"scratchpad"`
	SourceDraftID    *string                   `json:"sourceDraftId"`
	TagIDs           []string                  `json:"tagIds"`
	Target           *draftdoc.Target          `json:"target"`
	// Lists only: posts waiting to go out, the next one's time, and posts
	// that failed or whose outcome is unknown, which need attention.
	AttentionPosts int `json:"attentionPosts"`
	// CheckPosts are the attention posts whose outcome is unknown.
	CheckPosts  int        `json:"checkPosts"`
	NextPostAt  *time.Time `json:"nextPostAt"`
	QueuedPosts int        `json:"queuedPosts"`
}

// ContentDraftPage is one page of a workspace's drafts in the asked order.
// Pinned drafts come first, in Pinned, on the first page only.
type ContentDraftPage struct {
	Items      []ContentDraftRecord `json:"items"`
	NextCursor *string              `json:"nextCursor"`
	Pinned     []ContentDraftRecord `json:"pinned"`
}

// ContentDraftListQuery filters a draft list. Status is empty for every
// status except archived. View, when set, is a lifecycle tab: drafts (not
// yet live), posted (something went live), or archived. Sort is updated_desc
// (the default), updated_asc, created_desc or created_asc.
type ContentDraftListQuery struct {
	Cursor      string
	Kind        string
	Limit       int
	Search      string
	SocialSetID string
	Sort        string
	Status      string
	TagID       string
	View        string
}

// ContentDraftInput is a new draft. Every field is optional.
type ContentDraftInput struct {
	// ImportKey is an optional actor-bound receipt for retried batch imports.
	ImportKey            string            `json:"importKey"`
	RequestKey           string            `json:"requestKey"`
	AssetIDs             []string          `json:"assetIds"`
	Body                 []any             `json:"body"`
	ChannelConnectionIDs []string          `json:"channelConnectionIds"`
	ChannelText          map[string]string `json:"channelText"`
	Discussions          map[string]any    `json:"discussions"`
	PlainText            string            `json:"plainText"`
	Title                string            `json:"title"`
	// SocialSetID is the set the draft belongs to; empty is the workspace's
	// default set. Without ChannelConnectionIDs the draft starts with the
	// set's default platforms.
	SocialSetID string `json:"socialSetId"`
	// Write (RFC 025): the kind and its target, the platform the body is
	// written for (the set's primary when empty), versions, tags of the set.
	Article          *draftdoc.Article          `json:"article"`
	Kind             string                     `json:"kind"`
	PlatformVersions *draftdoc.PlatformVersions `json:"platformVersions"`
	PrimaryPlatform  string                     `json:"primaryPlatform"`
	Scratchpad       string                     `json:"scratchpad"`
	TagIDs           []string                   `json:"tagIds"`
	Target           *draftdoc.Target           `json:"target"`
}

// ContentDraftUpdate changes the fields it sets, based on BaseVersion.
// Status may move between draft and archived; scheduled is set by scheduling.
type ContentDraftUpdate struct {
	// CollabGeneration identifies a live editor projection. Omit for an external body replacement.
	CollabGeneration     *int               `json:"collabGeneration"`
	AssetIDs             *[]string          `json:"assetIds"`
	BaseVersion          int                `json:"baseVersion"`
	BaseCalendarVersion  int                `json:"baseCalendarVersion"`
	Body                 *[]any             `json:"body"`
	ChannelConnectionIDs *[]string          `json:"channelConnectionIds"`
	ChannelText          *map[string]string `json:"channelText"`
	Discussions          *map[string]any    `json:"discussions"`
	PlainText            *string            `json:"plainText"`
	Status               *string            `json:"status"`
	Title                *string            `json:"title"`
	// The draft's own choices, which start as copies of its set's defaults.
	NaturalPostingTime *bool   `json:"naturalPostingTime"`
	PrimaryPlatform    *string `json:"primaryPlatform"`
	// PlannedFor is RFC 3339, or empty to clear.
	PlannedFor *string `json:"plannedFor"`
	// Write (RFC 025): content that bumps the version like the body.
	Article          *draftdoc.Article          `json:"article"`
	PlatformVersions *draftdoc.PlatformVersions `json:"platformVersions"`
	Target           *draftdoc.Target           `json:"target"`
}

func contentDraftRecord(row *ent.ContentDraft) ContentDraftRecord {
	return ContentDraftRecord{CollabGeneration: row.CollabGeneration, AssetIDs: nonNilStrings(row.AssetIds), Body: nonNilBody(row.Body),
		ChannelConnectionIDs: nonNilStrings(row.ChannelConnectionIds), CreatedAt: row.CreatedAt,
		CreatedByUserID: row.CreatedByUserID, ChannelText: nonNilChannelText(row.ChannelText), Discussions: nonNilDiscussions(row.Discussions), ID: row.ID, OrganizationID: row.OrganizationID, PlainText: row.PlainText,
		Status: string(row.Status), Title: row.Title, UpdatedAt: row.UpdatedAt, UpdatedByUserID: row.UpdatedByUserID,
		Version: row.Version, CalendarVersion: row.CalendarVersion, ApprovedVersion: row.ApprovedVersion, ReviewNote: row.ReviewNote,
		ReviewStatus: string(row.ReviewStatus), ReviewedByUserID: row.ReviewedByUserID, ShareToken: row.ShareToken,
		GuestComments: nonNilComments(row.GuestComments), Engagement: row.Engagement,
		NaturalPostingTime: row.NaturalPostingTime, SuppressSlackOnPublish: row.SuppressSlackOnPublish, PlannedFor: row.PlannedFor, PrimaryPlatform: row.PrimaryPlatform,
		SocialSetID: row.SocialSetID, Article: row.Article, Kind: string(row.Kind), PinnedAt: row.PinnedAt,
		PlanTimeZone: row.PlanTimeZone, PlatformVersions: nonNilVersions(row.PlatformVersions), Scratchpad: row.Scratchpad,
		SourceDraftID: row.SourceDraftID, TagIDs: nonNilStrings(row.TagIds), Target: row.Target}
}

func nonNilVersions(doc draftdoc.PlatformVersions) draftdoc.PlatformVersions {
	if doc.Versions == nil {
		doc.Versions = []draftdoc.PlatformVersion{}
	}
	if doc.SchemaVersion == 0 {
		doc.SchemaVersion = draftdoc.SchemaVersion
	}
	return doc
}

func nonNilBody(body []any) []any {
	if body == nil {
		return []any{}
	}
	return body
}

func nonNilDiscussions(discussions map[string]any) map[string]any {
	if discussions == nil {
		return map[string]any{}
	}
	return discussions
}

func nonNilChannelText(text map[string]string) map[string]string {
	if text == nil {
		return map[string]string{}
	}
	return text
}

// contentDraftChannelText checks per-channel text: a draft channel each, and
// within contentDraftTextLimit. Empty text is dropped (the body applies).
func contentDraftChannelText(text map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for channel, value := range text {
		if _, ok := draftChannelLimits[channel]; !ok {
			return nil, invalid("Channel text is for a draft channel: x, linkedin, instagram, threads, bluesky or mastodon.")
		}
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if len(value) > contentDraftTextLimit {
			return nil, invalid("Keep each channel's text under the draft's text limit.")
		}
		out[channel] = value
	}
	return out, nil
}

// contentDraftDiscussions bounds the comment threads kept with a draft.
func contentDraftDiscussions(discussions map[string]any) (map[string]any, error) {
	if discussions == nil {
		return map[string]any{}, nil
	}
	encoded, err := json.Marshal(discussions)
	if err != nil || len(encoded) > contentDraftThreadsLimit {
		return nil, invalid("Keep the draft's comments under 256 KB.")
	}
	return discussions, nil
}

func contentDraftTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return contentDraftUntitledTitle, nil
	}
	if utf8.RuneCountInString(title) > contentDraftTitleLimit {
		return "", invalid(fmt.Sprintf("Use a title of up to %d characters.", contentDraftTitleLimit))
	}
	return title, nil
}

func contentDraftBody(body []any) ([]any, error) {
	if body == nil {
		return []any{}, nil
	}
	encoded, err := json.Marshal(body)
	if err != nil || len(encoded) > contentDraftBodyLimit {
		return nil, invalid("Keep the draft under 1 MB.")
	}
	return body, nil
}

func contentDraftText(text string) (string, error) {
	if utf8.RuneCountInString(text) > contentDraftTextLimit {
		return "", invalid("The draft's text is too long.")
	}
	return text, nil
}

// uniqueIDs drops duplicates, keeping the first occurrence's order.
func uniqueIDs(ids []string, limit int, what string) ([]string, error) {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if !contentDraftRefPattern.MatchString(id) {
			return nil, invalid(fmt.Sprintf("Every %s must be a valid ID.", what))
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	if len(out) > limit {
		return nil, invalid(fmt.Sprintf("Attach at most %d %ss.", limit, what))
	}
	return out, nil
}

// contentDraftAssets checks that every asset is an uploaded asset of this
// workspace, so a draft cannot point at another workspace's files.
func contentDraftAssets(ctx context.Context, tx *ent.Tx, organizationID string, ids []string) ([]string, error) {
	ids, err := uniqueIDs(ids, contentDraftAssetLimit, "asset")
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	count, err := tx.Asset.Query().Where(asset.IDIn(ids...), asset.OrganizationID(organizationID),
		asset.StatusEQ(asset.StatusUPLOADED)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count != len(ids) {
		return nil, invalid("Every image must be an uploaded asset of this workspace.")
	}
	return ids, nil
}

// contentDraftChannels checks that every channel is a connection of this
// workspace and, for a draft in a social set, an account of that set.
func contentDraftChannels(ctx context.Context, tx *ent.Tx, organizationID string, socialSetID *string, ids []string) ([]string, error) {
	ids, err := uniqueIDs(ids, contentDraftChannelLimit, "channel")
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	query := tx.ChannelConnection.Query().Where(channelconnection.IDIn(ids...), channelconnection.OrganizationID(organizationID))
	if socialSetID != nil {
		query.Where(channelconnection.SocialSetID(*socialSetID))
	}
	count, err := query.Count(ctx)
	if err != nil {
		return nil, err
	}
	if count != len(ids) {
		if socialSetID != nil {
			return nil, invalid("Every channel must be an account of the draft's social set.")
		}
		return nil, invalid("Every channel must be a connection of this workspace.")
	}
	return ids, nil
}

// contentDraftVisible reports whether actor may see draft: a draft in no set
// (written before RFC 024) is the workspace's, otherwise it follows its set.
func contentDraftVisible(ctx context.Context, client *ent.Client, actor Actor, draft *ent.ContentDraft) (bool, error) {
	if draft.SocialSetID == nil {
		return true, nil
	}
	set, err := client.SocialSet.Query().Where(socialset.ID(*draft.SocialSetID), socialset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if set.DeletedAt != nil {
		// A deleted set's archived drafts stay readable to whoever could see the set.
		copied := *set
		copied.DeletedAt = nil
		return socialSetVisible(&copied, actor), nil
	}
	return socialSetVisible(set, actor), nil
}

// visibleContentDraft loads a draft of the workspace that actor may see; any
// other draft, including one in someone else's private set, is not found.
func visibleContentDraft(ctx context.Context, client *ent.Client, actor Actor, id string) (*ent.ContentDraft, error) {
	draft, err := client.ContentDraft.Query().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	visible, err := contentDraftVisible(ctx, client, actor, draft)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, publishing.ErrNotFound
	}
	return draft, nil
}

// draftVisibilityPredicate keeps drafts in no set or in a set actor sees.
func (c *Configuration) draftVisibilityPredicate(ctx context.Context, actor Actor) (predicate.ContentDraft, error) {
	ids, err := c.visibleSocialSetIDs(ctx, actor)
	if err != nil {
		return nil, err
	}
	return contentdraft.Or(contentdraft.SocialSetIDIsNil(), contentdraft.SocialSetIDIn(ids...)), nil
}

// draftDefaults resolves a new draft's set and the defaults it copies: its
// set's default platforms that have an active account, in order, the primary
// platform among them, natural posting times and engagement defaults.
func (c *Configuration) draftDefaults(ctx context.Context, tx *ent.Tx, actor Actor, socialSetID string) (*ent.SocialSet, []string, *string, error) {
	var set *ent.SocialSet
	var err error
	if socialSetID == "" {
		if set, err = c.defaultSocialSet(ctx, actor.OrganizationID); err != nil {
			return nil, nil, nil, err
		}
		if !socialSetVisible(set, actor) {
			return nil, nil, nil, notFound("Social set not found.")
		}
	} else if set, err = visibleSocialSet(ctx, tx.Client(), actor, socialSetID); err != nil {
		return nil, nil, nil, err
	}
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, nil, nil, err
	}
	byPlatform := map[string]string{}
	for _, connection := range connections {
		byPlatform[socialplatform.Canonical(connection.Platform)] = connection.ID
	}
	channels := []string{}
	var primary *string
	for _, platform := range set.DefaultPlatforms {
		if id, ok := byPlatform[platform]; ok {
			channels = append(channels, id)
			if primary == nil || (set.PrimaryPlatform != nil && *set.PrimaryPlatform == platform) {
				value := platform
				primary = &value
			}
		}
	}
	return set, channels, primary, nil
}

// authorizeContentDrafts checks the role and the plan for a draft operation.
func (c *Configuration) authorizeContentDrafts(ctx context.Context, actor Actor, write bool) error {
	var err error
	if write {
		err = c.authorizeRoles(ctx, actor, contentDraftEditRoles...)
	} else {
		err = c.AuthorizeRead(ctx, actor)
	}
	if err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature)
}

// loadDraft reads a draft of the actor's workspace that the actor may see:
// one in another workspace or in someone else's private set is not found.
func (c *Configuration) loadDraft(ctx context.Context, actor Actor, id string) (*ent.ContentDraft, error) {
	return visibleContentDraft(ctx, c.client, actor, id)
}

// draftPrimary is the platform a draft's body is written for: its own, or X
// for a draft whose set had no default platform.
func draftPrimary(row *ent.ContentDraft) string {
	if row.PrimaryPlatform != nil && draftPlatformChannels[*row.PrimaryPlatform] != "" {
		return draftPlatformChannels[*row.PrimaryPlatform]
	}
	return "x"
}

// sameString reports whether two optional strings are equal.
func sameString(a, b *string) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

// draftTagIDs checks tag ids against the draft's set. Tags are behind the
// draft-tags experiment.
func (c *Configuration) draftTagIDs(ctx context.Context, tx *ent.Tx, actor Actor, setID string, ids []string) ([]string, error) {
	ids, err := uniqueIDs(ids, contentDraftTagLimit, "tag")
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	if err := c.requireExperiment(ctx, actor, ExperimentDraftTags); err != nil {
		return nil, err
	}
	count, err := tx.ContentDraftTag.Query().Where(contentdrafttag.IDIn(ids...), contentdrafttag.OrganizationID(actor.OrganizationID),
		contentdrafttag.SocialSetID(setID)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count != len(ids) {
		return nil, invalid("Every tag must belong to the draft's social set.")
	}
	return ids, nil
}

func (c *Configuration) CreateContentDraft(ctx context.Context, actor Actor, input ContentDraftInput) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result, err := c.createContentDraft(ctx, tx, actor, input)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}

// createContentDraft creates a draft in tx, so a caller can hold its own locks
// until the draft commits. The caller has authorized the actor.
func (c *Configuration) createContentDraft(ctx context.Context, tx *ent.Tx, actor Actor, input ContentDraftInput) (*ContentDraftRecord, error) {
	title, err := contentDraftTitle(input.Title)
	if err != nil {
		return nil, err
	}
	body, err := contentDraftBody(input.Body)
	if err != nil {
		return nil, err
	}
	text, err := contentDraftText(input.PlainText)
	if err != nil {
		return nil, err
	}
	discussions, err := contentDraftDiscussions(input.Discussions)
	if err != nil {
		return nil, err
	}
	channelText, err := contentDraftChannelText(input.ChannelText)
	if err != nil {
		return nil, err
	}
	scratchpad, err := draftScratchpad(input.Scratchpad)
	if err != nil {
		return nil, err
	}
	kind := input.Kind
	if kind == "" {
		kind = "standard"
	}
	receipt, fingerprint, err := draftImportIdentity(actor, input)
	if err != nil {
		return nil, err
	}
	if receipt != "" {
		if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, receipt); err != nil {
			return nil, err
		}
		saved, err := tx.PlatformDraftImport.Get(ctx, receipt)
		if err == nil {
			if saved.Fingerprint != fingerprint {
				return nil, conflict("This import key was already used for different content.")
			}
			row, err := visibleContentDraft(ctx, tx.Client(), actor, saved.DraftID)
			if err != nil {
				return nil, err
			}
			result := contentDraftRecord(row)
			return &result, nil
		}
		if !ent.IsNotFound(err) {
			return nil, err
		}
	}
	replay, creationHash, err := beginDraftCreation(ctx, tx, actor, input)
	if err != nil {
		return nil, err
	}
	if replay != nil {
		return replay, nil
	}
	target, err := draftTarget(kind, input.Target)
	if err != nil {
		return nil, err
	}
	if kind == "repurpose" {
		if err := seedRepurposedDraft(ctx, tx, actor, &input, target); err != nil {
			return nil, err
		}
		if body, err = contentDraftBody(input.Body); err != nil {
			return nil, err
		}
		if text, err = contentDraftText(input.PlainText); err != nil {
			return nil, err
		}
		if title, err = contentDraftTitle(input.Title); err != nil {
			return nil, err
		}
	}
	set, defaults, defaultPrimary, err := c.draftDefaults(ctx, tx, actor, input.SocialSetID)
	if err != nil {
		return nil, err
	}
	primary := input.PrimaryPlatform
	if primary == "" {
		primary = "x"
		// A set names a platform; the body is written for its channel.
		if defaultPrimary != nil && draftPlatformChannels[*defaultPrimary] != "" {
			primary = draftPlatformChannels[*defaultPrimary]
		}
		if kind == "reply" || kind == "article" {
			primary = "x"
		}
		if kind == "quote" {
			target, err := draftTarget(kind, input.Target)
			if err != nil {
				return nil, err
			}
			primary = target.Platform
		}
	}
	if err := draftKindChannel(kind, primary); err != nil {
		return nil, err
	}
	if err := draftTargetChannel(kind, primary, target); err != nil {
		return nil, err
	}
	article, err := draftArticle(kind, input.Article)
	if err != nil {
		return nil, err
	}
	versions := draftdoc.PlatformVersions{}
	if input.PlatformVersions != nil {
		versions = *input.PlatformVersions
	}
	if versions, err = draftPlatformVersions(versions, primary); err != nil {
		return nil, err
	}
	assets, err := contentDraftAssets(ctx, tx, actor.OrganizationID, append(append([]string{}, input.AssetIDs...), versionDocumentAssets(versions)...))
	if err != nil {
		return nil, err
	}
	assets = slices.DeleteFunc(assets, func(id string) bool {
		return slices.Contains(versionDocumentAssets(versions), id) && !slices.Contains(input.AssetIDs, id)
	})
	channels := defaults
	if input.ChannelConnectionIDs != nil {
		if channels, err = contentDraftChannels(ctx, tx, actor.OrganizationID, &set.ID, input.ChannelConnectionIDs); err != nil {
			return nil, err
		}
	} else if kind == "article" || kind == "reply" || kind == "quote" {
		// These kinds publish only on their primary platform.
		channels = slices.DeleteFunc(slices.Clone(channels), func(id string) bool {
			connection, err := tx.ChannelConnection.Get(ctx, id)
			return err != nil || draftPlatformChannels[connection.Platform] != primary
		})
	}
	tags, err := c.draftTagIDs(ctx, tx, actor, set.ID, input.TagIDs)
	if err != nil {
		return nil, err
	}
	draftID := cuid.New()
	if err = recordDiscussionActivity(ctx, tx, actor, &ent.ContentDraft{ID: draftID, Discussions: map[string]any{}}, discussions); err != nil {
		return nil, err
	}
	create := tx.ContentDraft.Create().SetID(draftID).SetOrganizationID(actor.OrganizationID).SetTitle(title).
		SetBody(body).SetPlainText(text).SetAssetIds(assets).SetChannelConnectionIds(channels).SetDiscussions(discussions).SetChannelText(channelText).
		SetSocialSetID(set.ID).SetPrimaryPlatform(primary).SetNaturalPostingTime(set.NaturalPostingTimes).
		SetEngagement(set.EngagementDefaults).
		SetKind(contentdraft.Kind(kind)).SetPlatformVersions(versions).SetScratchpad(scratchpad).SetTagIds(tags).
		SetNillableCreatedByUserID(projectActor(actor)).SetNillableUpdatedByUserID(projectActor(actor))
	if target != nil {
		create.SetTarget(target)
		if kind == "repurpose" && target.SourceDraftID != "" {
			create.SetSourceDraftID(target.SourceDraftID)
		}
	}
	if article != nil {
		create.SetArticle(article)
	}
	row, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if receipt != "" {
		if _, err := tx.PlatformDraftImport.Create().SetID(receipt).SetOrganizationID(actor.OrganizationID).SetDraftID(row.ID).SetFingerprint(fingerprint).Save(ctx); err != nil {
			return nil, err
		}
	}
	if err := rememberDraftMentions(ctx, tx, row); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_created", "content_draft", row.ID,
		map[string]any{"kind": kind, "socialSetId": set.ID}); err != nil {
		return nil, err
	}
	if err := emitDraftEvent(ctx, tx, row, webhooks.DraftCreated, nil); err != nil {
		return nil, err
	}
	if input.RequestKey != "" {
		if _, err = tx.CalendarMutation.Create().SetID(calendarReceiptID(actor, input.RequestKey)).SetOrganizationID(actor.OrganizationID).SetActorID(actor.UserID).SetInputHash(creationHash).SetResult(map[string]any{"draftId": row.ID}).Save(ctx); err != nil {
			return nil, err
		}
	}
	result := contentDraftRecord(row.Unwrap())
	return &result, nil
}

func (c *Configuration) GetContentDraft(ctx context.Context, actor Actor, id string) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	row, err := visibleContentDraft(ctx, c.client, actor, id)
	if err != nil {
		return nil, err
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// contentDraftOrder is a list's sort: the field, and newest or oldest first.
type contentDraftOrder struct {
	field string
	desc  bool
}

var contentDraftOrders = map[string]contentDraftOrder{
	"": {contentdraft.FieldUpdatedAt, true}, "updated_desc": {contentdraft.FieldUpdatedAt, true},
	"updated_asc": {contentdraft.FieldUpdatedAt, false}, "created_desc": {contentdraft.FieldCreatedAt, true},
	"created_asc": {contentdraft.FieldCreatedAt, false},
}

// draftPostExists matches drafts with a post in one of the statuses.
func draftPostExists(statuses ...string) predicate.ContentDraft {
	return func(s *sql.Selector) {
		posts := sql.Table(scheduledpost.Table)
		values := make([]any, 0, len(statuses))
		for _, status := range statuses {
			values = append(values, status)
		}
		s.Where(sql.Exists(sql.Select(posts.C(scheduledpost.FieldID)).From(posts).Where(sql.And(
			sql.ColumnsEQ(posts.C(scheduledpost.FieldContentDraftID), s.C(contentdraft.FieldID)),
			sql.In(posts.C(scheduledpost.FieldStatus), values...)))))
	}
}

// draftListFilters turns a list query into predicates.
func (c *Configuration) draftListFilters(ctx context.Context, actor Actor, query ContentDraftListQuery) ([]predicate.ContentDraft, error) {
	filters := []predicate.ContentDraft{contentdraft.OrganizationID(actor.OrganizationID)}
	var sets predicate.ContentDraft
	var err error
	if query.SocialSetID != "" {
		sets, err = c.draftSetFilter(ctx, actor, query.SocialSetID)
	} else {
		sets, err = c.draftVisibilityPredicate(ctx, actor)
	}
	if err != nil {
		return nil, err
	}
	filters = append(filters, sets)
	switch query.Status {
	case "":
		if query.View == "" {
			filters = append(filters, contentdraft.StatusNEQ(contentdraft.StatusArchived))
		}
	case "draft", "scheduled", "archived":
		filters = append(filters, contentdraft.StatusEQ(contentdraft.Status(query.Status)))
	default:
		return nil, invalid("Filter by draft, scheduled, or archived.")
	}
	switch query.View {
	case "":
	case "drafts":
		filters = append(filters, contentdraft.StatusNEQ(contentdraft.StatusArchived), contentdraft.Not(draftPostExists("PUBLISHED")))
	case "posted":
		filters = append(filters, contentdraft.StatusNEQ(contentdraft.StatusArchived), draftPostExists("PUBLISHED"))
	case "archived":
		filters = append(filters, contentdraft.StatusEQ(contentdraft.StatusArchived))
	default:
		return nil, invalid("A view is drafts, posted, or archived.")
	}
	if query.Kind != "" {
		if _, ok := draftKindChannels[query.Kind]; !ok {
			return nil, invalid("Filter by a draft kind.")
		}
		filters = append(filters, contentdraft.KindEQ(contentdraft.Kind(query.Kind)))
	}
	if search := strings.TrimSpace(query.Search); search != "" {
		if utf8.RuneCountInString(search) > 200 {
			return nil, invalid("Search for at most 200 characters.")
		}
		filters = append(filters, contentdraft.Or(contentdraft.TitleContainsFold(search), contentdraft.PlainTextContainsFold(search),
			contentdraft.ScratchpadContainsFold(search)))
	}
	if query.TagID != "" {
		if !contentDraftRefPattern.MatchString(query.TagID) {
			return nil, invalid("Filter by a valid tag.")
		}
		tag := query.TagID
		filters = append(filters, func(s *sql.Selector) {
			s.Where(sqljson.ValueContains(s.C(contentdraft.FieldTagIds), tag))
		})
	}
	return filters, nil
}

func (c *Configuration) ListContentDrafts(ctx context.Context, actor Actor, query ContentDraftListQuery) (*ContentDraftPage, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	if query.Limit < 1 || query.Limit > 100 {
		query.Limit = 24
	}
	order, ok := contentDraftOrders[query.Sort]
	if !ok {
		return nil, invalid("Sort by updated_desc, updated_asc, created_desc or created_asc.")
	}
	filters, err := c.draftListFilters(ctx, actor, query)
	if err != nil {
		return nil, err
	}
	page := &ContentDraftPage{Items: []ContentDraftRecord{}, Pinned: []ContentDraftRecord{}}
	var pinned []*ent.ContentDraft
	if query.Cursor == "" {
		pinned, err = c.client.ContentDraft.Query().Where(append(filters, contentdraft.PinnedAtNotNil())...).
			Order(ent.Desc(contentdraft.FieldPinnedAt), ent.Desc(contentdraft.FieldID)).Limit(50).All(ctx)
		if err != nil {
			return nil, err
		}
	}
	rows := c.client.ContentDraft.Query().Where(append(filters, contentdraft.PinnedAtIsNil())...)
	if query.Cursor != "" {
		at, id, err := decodeTimeCursor(query.Cursor)
		if err != nil {
			return nil, err
		}
		if order.desc {
			rows.Where(func(s *sql.Selector) {
				s.Where(sql.Or(sql.LT(s.C(order.field), at), sql.And(sql.EQ(s.C(order.field), at), sql.LT(s.C(contentdraft.FieldID), id))))
			})
		} else {
			rows.Where(func(s *sql.Selector) {
				s.Where(sql.Or(sql.GT(s.C(order.field), at), sql.And(sql.EQ(s.C(order.field), at), sql.GT(s.C(contentdraft.FieldID), id))))
			})
		}
	}
	direction := ent.Asc
	if order.desc {
		direction = ent.Desc
	}
	found, err := rows.Order(direction(order.field), direction(contentdraft.FieldID)).Limit(query.Limit + 1).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(found) > query.Limit {
		found = found[:query.Limit]
		last := found[len(found)-1]
		value := last.UpdatedAt
		if order.field == contentdraft.FieldCreatedAt {
			value = last.CreatedAt
		}
		next := encodeTimeCursor(value, last.ID)
		page.NextCursor = &next
	}
	all := append(append([]*ent.ContentDraft{}, pinned...), found...)
	summaries, err := c.draftPostSummaries(ctx, actor, all)
	if err != nil {
		return nil, err
	}
	for _, row := range pinned {
		page.Pinned = append(page.Pinned, summaries(row))
	}
	for _, row := range found {
		page.Items = append(page.Items, summaries(row))
	}
	return page, nil
}

// draftPostSummaries reads the posts of listed drafts once, for each row's
// live, queued and attention counts and next post time.
func (c *Configuration) draftPostSummaries(ctx context.Context, actor Actor, rows []*ent.ContentDraft) (func(*ent.ContentDraft) ContentDraftRecord, error) {
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	posts, err := c.client.ScheduledPost.Query().Where(scheduledpost.ContentDraftIDIn(ids...),
		scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.StatusIn(scheduledpost.StatusPUBLISHED,
			scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING, scheduledpost.StatusFAILED,
			scheduledpost.StatusUNKNOWN_DELIVERY)).Order(ent.Desc(scheduledpost.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	type summary struct {
		attention, check, published, queued int
		next                                *time.Time
	}
	byDraft := map[string]*summary{}
	// A failure needs attention only while it is its destination's newest
	// post: a retry is a new post, so the failure it replaced is history.
	seen := map[[2]string]bool{}
	for _, post := range posts {
		destination := [2]string{*post.ContentDraftID, post.ChannelConnectionID}
		replaced := seen[destination]
		seen[destination] = true
		item := byDraft[*post.ContentDraftID]
		if item == nil {
			item = &summary{}
			byDraft[*post.ContentDraftID] = item
		}
		switch post.Status {
		case scheduledpost.StatusPUBLISHED:
			item.published++
		case scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING:
			item.queued++
			if item.next == nil || post.ScheduledFor.Before(*item.next) {
				at := post.ScheduledFor
				item.next = &at
			}
		case scheduledpost.StatusUNKNOWN_DELIVERY:
			if !replaced {
				item.attention++
				item.check++
			}
		default:
			if !replaced {
				item.attention++
			}
		}
	}
	return func(row *ent.ContentDraft) ContentDraftRecord {
		record := contentDraftRecord(row)
		if item := byDraft[row.ID]; item != nil {
			record.AttentionPosts, record.CheckPosts, record.PublishedPosts, record.QueuedPosts, record.NextPostAt = item.attention, item.check, item.published, item.queued, item.next
		}
		return record
	}, nil
}

func encodeTimeCursor(at time.Time, id string) string {
	encoded, _ := json.Marshal(projectCursor{ID: id, Value: at.UTC().Format(time.RFC3339Nano)})
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func decodeTimeCursor(raw string) (time.Time, string, error) {
	var cursor projectCursor
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || json.Unmarshal(decoded, &cursor) != nil || cursor.ID == "" {
		return time.Time{}, "", invalid("The page cursor is not valid.")
	}
	at, err := time.Parse(time.RFC3339Nano, cursor.Value)
	if err != nil {
		return time.Time{}, "", invalid("The page cursor is not valid.")
	}
	return at, cursor.ID, nil
}

// applyContentDraftUpdate validates the fields an update sets onto the update builder.
func (c *Configuration) applyContentDraftUpdate(ctx context.Context, tx *ent.Tx, actor Actor, current *ent.ContentDraft,
	update *ent.ContentDraftUpdate, input ContentDraftUpdate) error {
	if input.PlannedFor != nil {
		if input.BaseCalendarVersion < 1 || input.BaseCalendarVersion != current.CalendarVersion {
			return conflict("The calendar changed. Reload before updating the date.")
		}
		if err := ensureDraftCanPlan(ctx, tx.Client(), current.ID); err != nil {
			return err
		}
		update.Where(contentdraft.CalendarVersion(input.BaseCalendarVersion))
		if current.Status != contentdraft.StatusDraft {
			return conflict("Unschedule or duplicate this content before planning it.")
		}
		update.AddCalendarVersion(1)
		if *input.PlannedFor == "" {
			update.ClearPlannedFor().ClearPlanTimeZone()
		} else {
			if err := ensurePlanningDestinations(ctx, tx.Client(), current); err != nil {
				return err
			}
			at, err := time.Parse(time.RFC3339, *input.PlannedFor)
			if err != nil || !at.After(time.Now()) {
				return invalid("Plan the draft for a future date and time.")
			}
			update.SetPlannedFor(at.UTC()).SetPlanTimeZone("UTC")
		}
	}
	if input.NaturalPostingTime != nil {
		update.SetNaturalPostingTime(*input.NaturalPostingTime)
	}
	if input.Title != nil {
		title, err := contentDraftTitle(*input.Title)
		if err != nil {
			return err
		}
		update.SetTitle(title)
	}
	if input.Body != nil {
		body, err := contentDraftBody(*input.Body)
		if err != nil {
			return err
		}
		if input.CollabGeneration != nil {
			if *input.CollabGeneration != current.CollabGeneration {
				return conflict("The draft body was replaced. Reload it before saving.")
			}
		} else if !sameJSON(body, current.Body) {
			update.ClearCollabState().AddCollabGeneration(1)
		}
		update.SetBody(body)
	}
	if input.PlainText != nil {
		text, err := contentDraftText(*input.PlainText)
		if err != nil {
			return err
		}
		update.SetPlainText(text)
	}
	primary := draftPrimary(current)
	if input.PrimaryPlatform != nil {
		if *input.PrimaryPlatform == "" {
			update.ClearPrimaryPlatform()
			primary = "x"
		} else {
			if _, ok := draftPlatformChannels[*input.PrimaryPlatform]; !ok {
				return invalid("The primary platform is a draft platform.")
			}
			primary = *input.PrimaryPlatform
			update.SetPrimaryPlatform(primary)
		}
		if err := draftKindChannel(string(current.Kind), primary); err != nil {
			return err
		}
	}
	versions := current.PlatformVersions
	if input.PlatformVersions != nil {
		versions = *input.PlatformVersions
	}
	if input.PlatformVersions != nil || input.PrimaryPlatform != nil {
		checked, err := draftPlatformVersions(versions, primary)
		if err != nil {
			return err
		}
		if _, err := contentDraftAssets(ctx, tx, actor.OrganizationID, versionDocumentAssets(checked)); err != nil {
			return err
		}
		update.SetPlatformVersions(checked)
	}
	if input.Target != nil {
		target, err := draftTarget(string(current.Kind), input.Target)
		if err != nil {
			return err
		}
		if err := draftTargetChannel(string(current.Kind), primary, target); err != nil {
			return err
		}
		if target == nil {
			update.ClearTarget()
		} else {
			update.SetTarget(target)
		}
	}
	if input.Article != nil {
		article, err := draftArticle(string(current.Kind), input.Article)
		if err != nil {
			return err
		}
		if article != nil && article.CoverAssetID != "" {
			if _, err := contentDraftAssets(ctx, tx, actor.OrganizationID, []string{article.CoverAssetID}); err != nil {
				return err
			}
		}
		update.SetArticle(article)
	}
	if input.AssetIDs != nil {
		assets, err := contentDraftAssets(ctx, tx, actor.OrganizationID, *input.AssetIDs)
		if err != nil {
			return err
		}
		update.SetAssetIds(assets)
	}
	if input.ChannelConnectionIDs != nil {
		channels, err := contentDraftChannels(ctx, tx, actor.OrganizationID, current.SocialSetID, *input.ChannelConnectionIDs)
		if err != nil {
			return err
		}
		update.SetChannelConnectionIds(channels)
	}
	if input.Discussions != nil {
		discussions, err := contentDraftDiscussions(*input.Discussions)
		if err != nil {
			return err
		}
		update.SetDiscussions(discussions)
	}
	if input.ChannelText != nil {
		channelText, err := contentDraftChannelText(*input.ChannelText)
		if err != nil {
			return err
		}
		update.SetChannelText(channelText)
	}
	if input.Status != nil {
		if *input.Status != "draft" && *input.Status != "archived" {
			return invalid("A draft can be set to draft or archived; scheduling sets scheduled.")
		}
		if *input.Status == "draft" {
			committed, err := hasDraftPublicationCommitment(ctx, tx.Client(), current.ID)
			if err != nil {
				return err
			}
			if committed {
				if current.Status != contentdraft.StatusArchived {
					return conflict("Unschedule active publications or duplicate published content before planning it.")
				}
				// Restore visibility without relabelling a retained publication as
				// uncommitted content. Planning commands keep their own guard.
				update.SetStatus(contentdraft.StatusScheduled)
				return nil
			}
		}
		update.SetStatus(contentdraft.Status(*input.Status))
	}
	return nil
}

func (c *Configuration) UpdateContentDraft(ctx context.Context, actor Actor, id string, input ContentDraftUpdate) (*ContentDraftRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	if input.BaseVersion < 1 {
		return nil, invalid("baseVersion is required.")
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return nil, err
	}
	previous, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	if input.Discussions != nil {
		if _, err := contentDraftDiscussions(*input.Discussions); err != nil {
			return nil, err
		}
		kept, err := keepOthersComments(ctx, tx, actor, previous.Discussions, *input.Discussions)
		if err != nil {
			return nil, err
		}
		input.Discussions = &kept
		if err = recordDiscussionActivity(ctx, tx, actor, previous, *input.Discussions); err != nil {
			return nil, err
		}
	}
	// The version check and the write are one statement, so two writers based
	// on the same version can never both succeed.
	update := tx.ContentDraft.Update().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID),
		contentdraft.Version(input.BaseVersion)).AddVersion(1).SetNillableUpdatedByUserID(projectActor(actor))
	if err := c.applyContentDraftUpdate(ctx, tx, actor, previous, update, input); err != nil {
		return nil, err
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, contentDraftMiss(ctx, tx, actor, id)
	}
	row, err := tx.ContentDraft.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if input.Body != nil || input.PlatformVersions != nil {
		if err := rememberDraftMentions(ctx, tx, row); err != nil {
			return nil, err
		}
	}
	if err := recordContentDraftRevision(ctx, tx, actor, row, false, "edit"); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_updated", "content_draft", id,
		draftChangeMetadata(previous, row)); err != nil {
		return nil, err
	}
	if err := emitDraftChanges(ctx, tx, previous, row); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if row.CollabGeneration != previous.CollabGeneration {
		// The body was replaced: the live room of the old generation closes.
		c.collabAccessChanged(ctx, actor.OrganizationID)
	}
	result := contentDraftRecord(row)
	return &result, nil
}

// draftChangeMetadata names what an update changed, for the activity
// timeline: never the text itself.
func draftChangeMetadata(before, after *ent.ContentDraft) map[string]any {
	changed := []string{}
	if before.Title != after.Title {
		changed = append(changed, "title")
	}
	if before.PlainText != after.PlainText || !sameJSON(before.Body, after.Body) || !sameJSON(before.ChannelText, after.ChannelText) {
		changed = append(changed, "content")
	}
	if !slices.Equal(before.AssetIds, after.AssetIds) {
		changed = append(changed, "media")
	}
	if before.NaturalPostingTime != after.NaturalPostingTime || !sameJSON(before.Engagement, after.Engagement) {
		changed = append(changed, "publishing_options")
	}
	if !slices.Equal(before.ChannelConnectionIds, after.ChannelConnectionIds) {
		changed = append(changed, "destinations")
	}
	if !sameJSON(before.PlatformVersions, after.PlatformVersions) || !sameString(before.PrimaryPlatform, after.PrimaryPlatform) {
		changed = append(changed, "platform_versions")
	}
	if before.Status != after.Status {
		changed = append(changed, "status:"+string(after.Status))
	}
	if !sameJSON(before.Target, after.Target) || !sameJSON(before.Article, after.Article) {
		changed = append(changed, "details")
	}
	return map[string]any{"version": after.Version, "changed": changed}
}

// sameJSON reports whether two values encode alike.
func sameJSON(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

// contentDraftMiss explains a guarded write that touched no row: the draft is
// not in this workspace, or it moved past the version the writer had.
func contentDraftMiss(ctx context.Context, tx *ent.Tx, actor Actor, id string) error {
	current, err := tx.ContentDraft.Query().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return publishing.ErrNotFound
	}
	if err != nil {
		return err
	}
	return &ContentDraftVersionConflictError{Current: current.Version}
}

func (c *Configuration) DeleteContentDraft(ctx context.Context, actor Actor, id string) error {
	return c.DeleteContentDraftAtVersion(ctx, actor, id, 0, 0)
}

// DeleteContentDraftAtVersion rejects stale calendar detail panels before deleting content.
func (c *Configuration) DeleteContentDraftAtVersion(ctx context.Context, actor Actor, id string, version, calendarVersion int) error {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return err
	}
	if _, err := c.loadDraft(ctx, actor, id); err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.PlatformExec(ctx, `SELECT id FROM content_draft WHERE id=$1 AND "organizationId"=$2 FOR UPDATE`, id, actor.OrganizationID); err != nil {
		return err
	}
	existing, err := visibleContentDraft(ctx, tx.Client(), actor, id)
	if err != nil {
		return err
	}
	if version > 0 && (existing.Version != version || existing.CalendarVersion != calendarVersion) {
		return conflict("This draft changed. Reload before deleting.")
	}
	count, err := tx.ContentDraft.Delete().Where(contentdraft.ID(id), contentdraft.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if ent.IsConstraintError(err) {
		// Its scheduled posts keep the draft they came from.
		return conflict("This draft has scheduled posts. Archive it instead.")
	}
	if err != nil {
		return err
	}
	if count == 0 {
		return publishing.ErrNotFound
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.content_draft_deleted", "content_draft", id); err != nil {
		return err
	}
	if err := emitDraftEvent(ctx, tx, existing, webhooks.DraftDeleted, nil); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	c.collabAccessChanged(ctx, actor.OrganizationID)
	return nil
}
