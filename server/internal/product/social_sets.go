package product

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"log/slog"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	entsql "entgo.io/ent/dialect/sql"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraft"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/contentdraftsettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/member"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/organization"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/scheduledpost"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialsetwritingsample"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/upload"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialplatform"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/workspaceroles"
	"github.com/lucsky/cuid"
)

// Social sets (RFC 024) are a workspace's publishing identities. A set is
// shared with the workspace or private to its owner; every read below filters
// by what the actor may see, so a private set is invisible rather than
// forbidden to everyone else. Mutations need a signed-in person.

var (
	socialSetManageRoles  = []string{"owner", "admin"}
	socialSetWritingRoles = []string{"owner", "admin", "creator"}
	socialSetColorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

const (
	socialSetNameLimit       = 80
	socialSetDefaultColor    = "#3b82f6"
	socialSetPlatformLimit   = 10
	socialSetEngagementLikes = 1_000_000
)

// AccountHealth is an account's state, read from the social service.
const (
	AccountConnected          = "connected"
	AccountUnverified         = "unverified"
	AccountReconnectRequired  = "reconnect_required"
	AccountExpired            = "expired"
	AccountRevoked            = "revoked"
	AccountRemoved            = "removed"
	AccountPermissionRequired = "permission_required"
)

// SocialAccount is one connected account as a set shows it.
type SocialAccount struct {
	TikTokCreator  *postoptions.TikTokCreator `json:"tiktokCreator,omitempty"`
	MastodonQuotes *bool                      `json:"mastodonQuotes"`
	PollLimits     *socialidentity.PollLimits `json:"pollLimits"`
	AvatarURL      *string                    `json:"avatarUrl"`
	CreatedAt      time.Time                  `json:"createdAt"`
	DisplayName    *string                    `json:"displayName"`
	Handle         *string                    `json:"handle"`
	// Health is connected, unverified, reconnect_required, expired, revoked, removed or permission_required.
	Health      string  `json:"health"`
	ID          string  `json:"id"`
	Platform    string  `json:"platform"`
	SocialSetID *string `json:"socialSetId"`
	// Premium is retained for display compatibility; explicit capabilities
	// govern text length and Articles independently.
	Premium       bool  `json:"premium"`
	XCaptionLimit *int  `json:"xCaptionLimit"`
	XArticles     *bool `json:"xArticles"`
	XQuotes       bool  `json:"xQuotes"`
}

// WritingAssistantRecord is a set's assistant with its derived status:
// not_configured, in_progress, configured, disabled or attention.
type WritingAssistantRecord struct {
	ConfiguredAt *time.Time        `json:"configuredAt"`
	SampleCount  int               `json:"sampleCount"`
	Status       string            `json:"status"`
	StyleGuide   schema.StyleGuide `json:"styleGuide"`
}

// SocialSetRecord is a set as the API returns it.
type SocialSetRecord struct {
	Accounts            []SocialAccount        `json:"accounts"`
	Color               string                 `json:"color"`
	CreatedAt           time.Time              `json:"createdAt"`
	DefaultPlatforms    []string               `json:"defaultPlatforms"`
	EngagementDefaults  schema.Engagement      `json:"engagementDefaults"`
	ID                  string                 `json:"id"`
	IsOwner             bool                   `json:"isOwner"`
	Name                string                 `json:"name"`
	NaturalPostingTimes bool                   `json:"naturalPostingTimes"`
	NeedsAttention      bool                   `json:"needsAttention"`
	OwnerUserID         *string                `json:"ownerUserId"`
	PostingSlots        []schema.QueueSlot     `json:"postingSlots"`
	PrimaryPlatform     *string                `json:"primaryPlatform"`
	PublicProfile       bool                   `json:"publicProfile"`
	PublicSlug          string                 `json:"publicSlug"`
	TimeZone            string                 `json:"timeZone"`
	UpdatedAt           time.Time              `json:"updatedAt"`
	Version             int                    `json:"version"`
	Visibility          string                 `json:"visibility"`
	WeeklySlotCount     int                    `json:"weeklySlotCount"`
	WritingAssistant    WritingAssistantRecord `json:"writingAssistant"`
}

// SocialSetList is the actor's sets, the workspace's accounts in no set, and
// private sets whose owner left the workspace (admins only, for clean-up).
type SocialSetList struct {
	Items      []SocialSetRecord   `json:"items"`
	Orphaned   []OrphanedSocialSet `json:"orphaned"`
	Unassigned []SocialAccount     `json:"unassigned"`
}

// OrphanedSocialSet is a private set whose owner is no longer a member.
type OrphanedSocialSet struct {
	AccountCount int    `json:"accountCount"`
	ID           string `json:"id"`
	Name         string `json:"name"`
}

// SocialSetInput creates a set.
type SocialSetInput struct {
	Color      string `json:"color"`
	Name       string `json:"name"`
	TimeZone   string `json:"timeZone"`
	Visibility string `json:"visibility"`
}

// SocialSetUpdate changes the fields it sets, based on BaseVersion.
type SocialSetUpdate struct {
	BaseVersion         int                 `json:"baseVersion"`
	Color               *string             `json:"color"`
	DefaultPlatforms    *[]string           `json:"defaultPlatforms"`
	EngagementDefaults  *schema.Engagement  `json:"engagementDefaults"`
	Name                *string             `json:"name"`
	NaturalPostingTimes *bool               `json:"naturalPostingTimes"`
	PostingSlots        *[]schema.QueueSlot `json:"postingSlots"`
	// PrimaryPlatform is one of the default platforms; empty clears it.
	PrimaryPlatform *string `json:"primaryPlatform"`
	PublicProfile   *bool   `json:"publicProfile"`
	TimeZone        *string `json:"timeZone"`
}

// SocialSetVersionConflictError refuses a write made against an older version.
type SocialSetVersionConflictError struct{ Current int }

func (e *SocialSetVersionConflictError) Error() string {
	return fmt.Sprintf("This social set was changed elsewhere; it is now at version %d. Reload to see the change.", e.Current)
}

func (e *SocialSetVersionConflictError) Unwrap() error { return publishing.ErrConflict }

func randomSlug() string {
	buffer := make([]byte, 12)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// socialSetVisible reports whether actor may see set: shared sets for every
// member and credential, private sets for their owner alone.
func socialSetVisible(set *ent.SocialSet, actor Actor) bool {
	if set == nil || set.DeletedAt != nil || set.OrganizationID != actor.OrganizationID {
		return false
	}
	if set.Visibility == socialset.VisibilityWORKSPACE {
		return true
	}
	return actor.IsSession() && set.OwnerUserID != nil && *set.OwnerUserID == actor.UserID
}

// visibleSocialSetPredicate filters a query to the sets actor may see.
func visibleSocialSetPredicate(actor Actor) []func(*entsql.Selector) {
	predicates := []func(*entsql.Selector){socialset.OrganizationID(actor.OrganizationID), socialset.DeletedAtIsNil()}
	if actor.IsSession() {
		predicates = append(predicates, socialset.Or(socialset.VisibilityEQ(socialset.VisibilityWORKSPACE), socialset.OwnerUserID(actor.UserID)))
	} else {
		predicates = append(predicates, socialset.VisibilityEQ(socialset.VisibilityWORKSPACE))
	}
	return predicates
}

func (c *Configuration) visibleSocialSets(ctx context.Context, client *ent.Client, actor Actor) ([]*ent.SocialSet, error) {
	query := client.SocialSet.Query()
	for _, predicate := range visibleSocialSetPredicate(actor) {
		query.Where(predicate)
	}
	return query.Order(ent.Asc(socialset.FieldCreatedAt), ent.Asc(socialset.FieldID)).All(ctx)
}

// visibleSocialSetIDs lists the IDs of the sets actor may see.
func (c *Configuration) visibleSocialSetIDs(ctx context.Context, actor Actor) ([]string, error) {
	sets, err := c.visibleSocialSets(ctx, c.client, actor)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(sets))
	for _, set := range sets {
		ids = append(ids, set.ID)
	}
	return ids, nil
}

// visibleSocialSet loads one set actor may see; any other set is not found.
func visibleSocialSet(ctx context.Context, client *ent.Client, actor Actor, id string) (*ent.SocialSet, error) {
	if !contentDraftRefPattern.MatchString(id) {
		return nil, notFound("Social set not found.")
	}
	set, err := client.SocialSet.Query().Where(socialset.ID(id), socialset.OrganizationID(actor.OrganizationID)).Only(ctx)
	if ent.IsNotFound(err) || (err == nil && !socialSetVisible(set, actor)) {
		return nil, notFound("Social set not found.")
	}
	return set, err
}

// defaultSocialSet is the workspace's oldest shared set. A workspace created
// after the RFC 024 migration gets one on first use, from the same rule the
// migration applied: its name, its time zone and its saved posting slots.
func (c *Configuration) defaultSocialSet(ctx context.Context, organizationID string) (*ent.SocialSet, error) {
	find := func(client *ent.Client) (*ent.SocialSet, error) {
		return client.SocialSet.Query().Where(socialset.OrganizationID(organizationID), socialset.DeletedAtIsNil(),
			socialset.VisibilityEQ(socialset.VisibilityWORKSPACE)).
			Order(ent.Asc(socialset.FieldCreatedAt), ent.Asc(socialset.FieldID)).First(ctx)
	}
	found, err := find(c.client)
	if err == nil || !ent.IsNotFound(err) {
		return found, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.PlatformExec(ctx, `SELECT pg_advisory_xact_lock(hashtext('social-set-default:' || $1))`, organizationID); err != nil {
		return nil, err
	}
	found, err = find(tx.Client())
	if err == nil {
		return found, tx.Commit()
	}
	if !ent.IsNotFound(err) {
		return nil, err
	}
	workspace, err := tx.Organization.Query().Where(organization.ID(organizationID)).Only(ctx)
	if err != nil {
		return nil, err
	}
	_, zone := c.workspaceZone(ctx, organizationID)
	slots := defaultQueueSlots
	if saved, err := tx.ContentDraftSettings.Query().Where(contentdraftsettings.ID(organizationID)).Only(ctx); err == nil {
		slots = saved.PostingSlots
	} else if !ent.IsNotFound(err) {
		return nil, err
	}
	name := strings.TrimSpace(workspace.Name)
	if name == "" {
		name = "Workspace"
	}
	created, err := tx.SocialSet.Create().SetID(cuid.New()).SetOrganizationID(organizationID).
		SetName(truncateRunes(name, socialSetNameLimit)).SetTimeZone(zone).SetPostingSlots(slots).
		SetPublicSlug(randomSlug()).Save(ctx)
	if err != nil {
		return nil, err
	}
	// Adopt the accounts that belong to no set yet: the oldest of each
	// platform, which also become the set's defaults for new drafts, in order.
	orphans, err := tx.ChannelConnection.Query().Where(channelconnection.OrganizationID(organizationID),
		channelconnection.SocialSetIDIsNil(), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).
		Order(ent.Asc(channelconnection.FieldCreatedAt), ent.Asc(channelconnection.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	platforms := []string{}
	for _, connection := range orphans {
		if oneOf(socialplatform.Canonical(connection.Platform), platforms...) {
			continue
		}
		if _, err := tx.ChannelConnection.UpdateOneID(connection.ID).SetSocialSetID(created.ID).Save(ctx); err != nil {
			return nil, err
		}
		platforms = append(platforms, socialplatform.Canonical(connection.Platform))
	}
	if len(platforms) > 0 {
		if created, err = tx.SocialSet.UpdateOneID(created.ID).SetDefaultPlatforms(platforms).
			SetPrimaryPlatform(platforms[0]).Save(ctx); err != nil {
			return nil, err
		}
	}
	return created.Unwrap(), tx.Commit()
}

// accountHealth folds the product's status and the social service's
// integration row into one state.
func accountHealth(status channelconnection.Status, exists, deleted, disabled, refresh, between bool, expires *time.Time, now time.Time) string {
	switch {
	case status == channelconnection.StatusDISABLED:
		return AccountRemoved
	case status == channelconnection.StatusREVOKED, exists && deleted:
		return AccountRevoked
	case !exists:
		return AccountUnverified
	case disabled, refresh:
		return AccountReconnectRequired
	case between:
		return AccountPermissionRequired
	case expires != nil && !expires.After(now):
		return AccountExpired
	}
	return AccountConnected
}

// socialTablesFound remembers that the social Integration table exists. A
// database that has it keeps it, so only a found table is remembered; a
// database without it is asked again on the next call.
var socialTablesFound atomic.Bool

func socialTablesPresent(ctx context.Context, client *ent.Client) (bool, error) {
	if socialTablesFound.Load() {
		return true, nil
	}
	var social bool
	err := client.PlatformQuery(ctx, `SELECT to_regclass('public."Integration"') IS NOT NULL`, nil, func(row entsql.ColumnScanner) error {
		return row.Scan(&social)
	})
	if social {
		socialTablesFound.Store(true)
	}
	return social, err
}

// connectionHealth requires a provider record in the bound social tenant.
// An active product row alone is not proof of usable provider credentials.
// Missing provider tables, bindings, or records leave the account unverified.
func connectionHealth(ctx context.Context, client *ent.Client, organizationID string, connections []*ent.ChannelConnection) (map[string]string, error) {
	health := make(map[string]string, len(connections))
	if len(connections) == 0 {
		return health, nil
	}
	ids := make([]string, 0, len(connections))
	for _, connection := range connections {
		ids = append(ids, connection.ID)
		health[connection.ID] = accountHealth(connection.Status, false, false, false, false, false, nil, time.Now())
	}
	if social, err := socialTablesPresent(ctx, client); err != nil || !social {
		return health, err
	}
	statuses := make(map[string]channelconnection.Status, len(connections))
	for _, connection := range connections {
		statuses[connection.ID] = connection.Status
	}
	query := `SELECT c.id, coalesce(i.id IS NOT NULL AND length(trim(i.token)) > 0
        AND platform_social_channel_v1(i."providerIdentifier") = platform_social_channel_v1(c.platform), false), coalesce(i."deletedAt" IS NOT NULL, false), coalesce(i.disabled, false),
		coalesce(i."refreshNeeded", false), coalesce(i."inBetweenSteps", false), i."tokenExpiration",
		coalesce(i."providerIdentifier", ''), coalesce(i."internalId", ''), i."verifiedAccountKey", i."verifiedAccountKind",
		i."verifiedScopes", i."verifiedCapabilities", i."identityVerifiedAt"
		FROM channel_connection c
		LEFT JOIN social_tenant_binding b ON b."organizationId" = c."organizationId"
		LEFT JOIN "Integration" i ON i.id = c."externalAccountId" AND i."organizationId" = b."goOrganizationId"
		WHERE c."organizationId" = $1 AND c.provider = 'social' AND c.id = ANY($2::text[])`
	now := time.Now()
	return health, client.PlatformQuery(ctx, query, []any{organizationID, "{" + strings.Join(ids, ",") + "}"}, func(row entsql.ColumnScanner) error {
		var id string
		var exists, deleted, disabled, refresh, between bool
		var expires *time.Time
		var provider, native string
		var key, kind *string
		var scopes, capabilities []byte
		var verified *time.Time
		if err := row.Scan(&id, &exists, &deleted, &disabled, &refresh, &between, &expires, &provider, &native, &key, &kind, &scopes, &capabilities, &verified); err != nil {
			return err
		}
		health[id] = accountHealth(statuses[id], exists, deleted, disabled, refresh, between, expires, now)
		if health[id] == AccountConnected && socialidentity.RequiresVerification(provider) {
			if key == nil || kind == nil || verified == nil {
				health[id] = AccountUnverified
				return nil
			}
			proof := socialidentity.Verification{AccountKey: *key, AccountKind: *kind}
			if json.Unmarshal(scopes, &proof.GrantedScopes) != nil || json.Unmarshal(capabilities, &proof.Capabilities) != nil || proof.Validate(provider, native) != nil {
				health[id] = AccountUnverified
			}
		}
		return nil
	})
}

func socialAccount(ctx context.Context, connection *ent.ChannelConnection, health string) SocialAccount {
	return SocialAccount{AvatarURL: BrowserAvatar(ctx, connection.AvatarURL), CreatedAt: connection.CreatedAt, DisplayName: connection.DisplayName,
		Handle: connection.Handle, Health: health, ID: connection.ID, Platform: connection.Platform, SocialSetID: connection.SocialSetID}
}

// BrowserAvatar returns a stored avatar as a link a browser can load. Connect
// copies avatars into the social bucket. When that bucket is private, only a
// signed link can read it, so the link is signed for a day. Other links pass
// through. An avatar that cannot be signed is dropped, and the initial shows.
// Only a plain link is signed, as the copy writes it: one with a user, a query
// or a fragment did not come from the copy and passes through unsigned.
func BrowserAvatar(ctx context.Context, stored *string) *string {
	if stored == nil {
		return nil
	}
	if u, err := url.Parse(*stored); err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return stored
	}
	signer, err := upload.NewPrivateMediaSigner()
	if err != nil {
		// Without the bucket settings, no link can be signed: keep the stored one.
		slog.WarnContext(ctx, "avatar links cannot be signed", "error", err)
		return stored
	}
	signed, err := signer.SignURL(ctx, *stored)
	if err != nil {
		slog.WarnContext(ctx, "avatar link not signed", "avatar", *stored, "error", err)
		return nil
	}
	return &signed
}

// workspaceAIEnabled reads the workspace AI switch.
func (c *Configuration) workspaceAIEnabled(ctx context.Context, organizationID string) bool {
	if c.requireWorkspaceFeature(ctx, organizationID, "workspace:paid") != nil {
		return false
	}
	settings, err := c.client.WorkspaceSettings.Get(ctx, organizationID)
	return err != nil || settings.AiAgentEnabled
}

func styleGuideEmpty(guide schema.StyleGuide) bool {
	return guide.Tone == "" && guide.Audience == "" && guide.Formatting == "" && len(guide.Terminology) == 0 &&
		len(guide.ProhibitedPhrases) == 0 && len(guide.Openings) == 0 && len(guide.Endings) == 0 && len(guide.PlatformGuidance) == 0
}

func writingAssistantRecord(set *ent.SocialSet, samples int, aiEnabled bool) WritingAssistantRecord {
	assistant := set.WritingAssistant
	status := "not_configured"
	switch {
	case assistant.Status == "disabled":
		status = "disabled"
	case assistant.Status == "configured" && !aiEnabled:
		status = "attention"
	case assistant.Status == "configured":
		status = "configured"
	case samples > 0 || !styleGuideEmpty(assistant.StyleGuide):
		status = "in_progress"
	}
	guide := assistant.StyleGuide
	guide.Terminology, guide.ProhibitedPhrases = nonNilStrings(guide.Terminology), nonNilStrings(guide.ProhibitedPhrases)
	guide.Openings, guide.Endings = nonNilStrings(guide.Openings), nonNilStrings(guide.Endings)
	if guide.PlatformGuidance == nil {
		guide.PlatformGuidance = map[string]string{}
	}
	return WritingAssistantRecord{ConfiguredAt: assistant.ConfiguredAt, SampleCount: samples, Status: status, StyleGuide: guide}
}

// socialSetRecords builds the records for sets, with their accounts and health.
func (c *Configuration) socialSetRecords(ctx context.Context, actor Actor, sets []*ent.SocialSet) ([]SocialSetRecord, error) {
	ids := make([]string, 0, len(sets))
	for _, set := range sets {
		ids = append(ids, set.ID)
	}
	// The writing samples and the AI switch do not depend on the accounts, so
	// they are read while the accounts are.
	samples := map[string]int{}
	var samplesErr error
	var aiEnabled bool
	var side sync.WaitGroup
	defer side.Wait()
	if len(ids) > 0 {
		side.Go(func() {
			var rows []*ent.SocialSetWritingSample
			rows, samplesErr = c.client.SocialSetWritingSample.Query().Where(socialsetwritingsample.SocialSetIDIn(ids...),
				socialsetwritingsample.OrganizationID(actor.OrganizationID)).All(ctx)
			for _, row := range rows {
				samples[row.SocialSetID]++
			}
		})
	}
	side.Go(func() { aiEnabled = c.workspaceAIEnabled(ctx, actor.OrganizationID) })
	connections, err := c.client.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID),
		channelconnection.SocialSetIDIn(ids...), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).
		Order(ent.Asc(channelconnection.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	health, err := connectionHealth(ctx, c.client, actor.OrganizationID, connections)
	if err != nil {
		return nil, err
	}
	built := make([]SocialAccount, len(connections))
	// Each standing reads the account's credentials, and TikTok's asks TikTok,
	// so the accounts are read together rather than one after another. Five at
	// a time keep a workspace with many accounts from taking every connection.
	var standings sync.WaitGroup
	slots := make(chan struct{}, 5)
	for i, connection := range connections {
		built[i] = socialAccount(ctx, connection, health[connection.ID])
		if (connection.Platform == "x" || connection.Platform == "mastodon-custom" || connection.Platform == "tiktok") && built[i].Health == AccountConnected {
			standings.Go(func() {
				slots <- struct{}{}
				defer func() { <-slots }()
				standing, account := c.accountStanding(ctx, connection), &built[i]
				account.Premium, account.XCaptionLimit, account.XArticles, account.PollLimits = standing.Premium, standing.XCaptionLimit, standing.XArticles, standing.PollLimits
				account.MastodonQuotes = standing.MastodonQuotes
				account.XQuotes = standing.XQuotes
				account.TikTokCreator = standing.TikTokCreator
			})
		}
	}
	standings.Wait()
	accounts := map[string][]SocialAccount{}
	for i, connection := range connections {
		accounts[*connection.SocialSetID] = append(accounts[*connection.SocialSetID], built[i])
	}
	side.Wait()
	if samplesErr != nil {
		return nil, samplesErr
	}
	records := make([]SocialSetRecord, 0, len(sets))
	for _, set := range sets {
		setAccounts := accounts[set.ID]
		if setAccounts == nil {
			setAccounts = []SocialAccount{}
		}
		attention := false
		for _, account := range setAccounts {
			attention = attention || account.Health != AccountConnected
		}
		records = append(records, SocialSetRecord{Accounts: setAccounts, Color: set.Color, CreatedAt: set.CreatedAt,
			DefaultPlatforms: nonNilStrings(set.DefaultPlatforms), EngagementDefaults: set.EngagementDefaults, ID: set.ID,
			IsOwner: set.OwnerUserID != nil && actor.IsSession() && *set.OwnerUserID == actor.UserID, Name: set.Name,
			NaturalPostingTimes: set.NaturalPostingTimes, NeedsAttention: attention, OwnerUserID: set.OwnerUserID,
			PostingSlots: nonNilSlots(set.PostingSlots), PrimaryPlatform: set.PrimaryPlatform, PublicProfile: set.PublicProfile,
			PublicSlug: set.PublicSlug, TimeZone: set.TimeZone, UpdatedAt: set.UpdatedAt, Version: set.Version,
			Visibility: string(set.Visibility), WeeklySlotCount: len(set.PostingSlots),
			WritingAssistant: writingAssistantRecord(set, samples[set.ID], aiEnabled)})
	}
	return records, nil
}

func nonNilSlots(slots []schema.QueueSlot) []schema.QueueSlot {
	if slots == nil {
		return []schema.QueueSlot{}
	}
	return slots
}

func (c *Configuration) socialSetRecord(ctx context.Context, actor Actor, set *ent.SocialSet) (*SocialSetRecord, error) {
	records, err := c.socialSetRecords(ctx, actor, []*ent.SocialSet{set})
	if err != nil {
		return nil, err
	}
	return &records[0], nil
}

// ListSocialSets lists the sets actor may see, oldest first, with accounts
// that belong to no set and, for owners and admins, private sets left behind
// by people who left the workspace.
func (c *Configuration) ListSocialSets(ctx context.Context, actor Actor) (*SocialSetList, error) {
	// A session's one role read gates both the list and, below, the orphaned
	// sets; a second check would read the session and membership again.
	var role string
	var err error
	if actor.IsSession() {
		if role, err = c.auth.AuthorizedRole(ctx, actor.OrganizationID, actor.UserID, actor.SessionID, readRoles...); err == nil {
			err = c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature)
		}
	} else {
		err = c.authorizeContentDrafts(ctx, actor, false)
	}
	if err != nil {
		return nil, err
	}
	// Keep legacy unassigned accounts usable without creating an empty brand
	// merely because someone opens the provider picker or settings list.
	legacyAccounts, err := c.client.ChannelConnection.Query().Where(channelconnection.OrganizationID(actor.OrganizationID),
		channelconnection.SocialSetIDIsNil(), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if legacyAccounts {
		if _, err := c.defaultSocialSet(ctx, actor.OrganizationID); err != nil {
			return nil, err
		}
	}
	sets, err := c.visibleSocialSets(ctx, c.client, actor)
	if err != nil {
		return nil, err
	}
	// The unassigned accounts and the orphaned sets do not depend on the sets'
	// records, so the three are read together. Unassigned accounts exist only
	// when the check above found some.
	list := &SocialSetList{Orphaned: []OrphanedSocialSet{}, Unassigned: []SocialAccount{}}
	var unassignedErr, orphansErr error
	var parts sync.WaitGroup
	if legacyAccounts {
		parts.Go(func() {
			unassignedErr = c.listUnassigned(ctx, actor.OrganizationID, list)
		})
	}
	if workspaceroles.Allows(role, "owner", "admin") {
		parts.Go(func() {
			list.Orphaned, orphansErr = c.orphanedSocialSets(ctx, actor.OrganizationID)
		})
	}
	records, err := c.socialSetRecords(ctx, actor, sets)
	parts.Wait()
	// The errors keep the order the reads had when they ran one after another.
	if err := cmp.Or(err, unassignedErr, orphansErr); err != nil {
		return nil, err
	}
	list.Items = records
	return list, nil
}

// listUnassigned adds the workspace's active accounts that belong to no set.
func (c *Configuration) listUnassigned(ctx context.Context, organizationID string, list *SocialSetList) error {
	unassigned, err := c.client.ChannelConnection.Query().Where(channelconnection.OrganizationID(organizationID),
		channelconnection.SocialSetIDIsNil(), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).
		Order(ent.Asc(channelconnection.FieldCreatedAt)).All(ctx)
	if err != nil {
		return err
	}
	health, err := connectionHealth(ctx, c.client, organizationID, unassigned)
	if err != nil {
		return err
	}
	for _, connection := range unassigned {
		list.Unassigned = append(list.Unassigned, socialAccount(ctx, connection, health[connection.ID]))
	}
	return nil
}

func (c *Configuration) orphanedSocialSets(ctx context.Context, organizationID string) ([]OrphanedSocialSet, error) {
	private, err := c.client.SocialSet.Query().Where(socialset.OrganizationID(organizationID), socialset.DeletedAtIsNil(),
		socialset.VisibilityEQ(socialset.VisibilityPRIVATE)).All(ctx)
	if err != nil {
		return nil, err
	}
	// One read finds which owners are still members, rather than one per set.
	owners := make([]string, 0, len(private))
	for _, set := range private {
		owners = append(owners, *set.OwnerUserID)
	}
	members := map[string]bool{}
	if len(owners) > 0 {
		ids, err := c.client.Member.Query().Where(member.OrganizationID(organizationID), member.UserIDIn(owners...)).
			Select(member.FieldUserID).Strings(ctx)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			members[id] = true
		}
	}
	orphans := []OrphanedSocialSet{}
	for _, set := range private {
		if members[*set.OwnerUserID] {
			continue
		}
		count, err := c.client.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
			channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
		if err != nil {
			return nil, err
		}
		orphans = append(orphans, OrphanedSocialSet{AccountCount: count, ID: set.ID, Name: set.Name})
	}
	return orphans, nil
}

// GetSocialSet returns one set actor may see.
func (c *Configuration) GetSocialSet(ctx context.Context, actor Actor, id string) (*SocialSetRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	set, err := visibleSocialSet(ctx, c.client, actor, id)
	if err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, set)
}

func socialSetName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > socialSetNameLimit {
		return "", invalid(fmt.Sprintf("Name the social set with 1 to %d characters.", socialSetNameLimit))
	}
	return name, nil
}

func socialSetColor(color string) (string, error) {
	color = strings.ToLower(strings.TrimSpace(color))
	if color == "" {
		return socialSetDefaultColor, nil
	}
	if !socialSetColorPattern.MatchString(color) {
		return "", invalid("Pick a colour as #rrggbb.")
	}
	return color, nil
}

// authorizeSocialSetManage checks a signed-in admin or owner.
func (c *Configuration) authorizeSocialSetManage(ctx context.Context, actor Actor) error {
	if err := c.authorizeDecision(ctx, actor, socialSetManageRoles...); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature)
}

// CreateSocialSet creates a set, shared with the workspace or private to the
// person creating it. Its schedule starts from the workspace's time zone.
func (c *Configuration) CreateSocialSet(ctx context.Context, actor Actor, input SocialSetInput) (*SocialSetRecord, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	name, err := socialSetName(input.Name)
	if err != nil {
		return nil, err
	}
	color, err := socialSetColor(input.Color)
	if err != nil {
		return nil, err
	}
	visibility := socialset.VisibilityWORKSPACE
	switch input.Visibility {
	case "", "WORKSPACE":
	case "PRIVATE":
		visibility = socialset.VisibilityPRIVATE
	default:
		return nil, invalid("A social set is shared with the workspace (WORKSPACE) or private to you (PRIVATE).")
	}
	_, zone := c.workspaceZone(ctx, actor.OrganizationID)
	if input.TimeZone != "" {
		if !validTimeZone(input.TimeZone) {
			return nil, invalid("Pick a time zone from the list, such as Europe/Paris.")
		}
		zone = input.TimeZone
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	create := tx.SocialSet.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(name).SetColor(color).
		SetVisibility(visibility).SetTimeZone(zone).SetPostingSlots(defaultQueueSlots).SetPublicSlug(randomSlug()).
		SetCreatedByUserID(actor.UserID).SetOwnerUserID(actor.UserID)
	created, err := create.Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_created", "social_set", created.ID,
		map[string]any{"visibility": string(visibility)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, created.Unwrap())
}

// validDefaultPlatforms checks the ordered defaults: distinct draft platforms,
// each with an active account in the set.
func validDefaultPlatforms(ctx context.Context, tx *ent.Tx, set *ent.SocialSet, platforms []string) ([]string, error) {
	if len(platforms) > socialSetPlatformLimit {
		return nil, invalid(fmt.Sprintf("Pick at most %d default platforms.", socialSetPlatformLimit))
	}
	connected, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, err
	}
	available := map[string]bool{}
	for _, connection := range connected {
		available[socialplatform.Canonical(connection.Platform)] = true
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(platforms))
	for _, platform := range platforms {
		if _, ok := draftPlatformChannels[platform]; !ok || seen[platform] {
			return nil, invalid("Each default platform is a distinct draft platform.")
		}
		if !available[platform] {
			return nil, invalid("Connect a " + platform + " account to this social set before making it a default.")
		}
		seen[platform] = true
		out = append(out, platform)
	}
	return out, nil
}

func validEngagement(engagement schema.Engagement) (schema.Engagement, error) {
	for _, rule := range []*schema.EngagementRule{&engagement.AutoRepost, &engagement.AutoPlug} {
		if !rule.Enabled {
			continue
		}
		if rule.AtLikes < 1 || rule.AtLikes > socialSetEngagementLikes {
			return engagement, invalid("Set the number of likes as a positive whole number.")
		}
	}
	engagement.AutoRepost.Text = ""
	engagement.AutoPlug.Text = strings.TrimSpace(engagement.AutoPlug.Text)
	if engagement.AutoPlug.Enabled && (engagement.AutoPlug.Text == "" || xLength(engagement.AutoPlug.Text) > 280) {
		return engagement, invalid("The auto-plug needs text that fits in one X post.")
	}
	return engagement, nil
}

// UpdateSocialSet saves the fields input sets. Admins and owners may change a
// set they can see; the write is guarded by its version.
func (c *Configuration) UpdateSocialSet(ctx context.Context, actor Actor, id string, input SocialSetUpdate) (*SocialSetRecord, error) {
	return c.updateSocialSet(ctx, actor, id, input, false)
}

func (c *Configuration) updateSocialSet(ctx context.Context, actor Actor, id string, input SocialSetUpdate, queueOnly bool) (*SocialSetRecord, error) {
	authorize := func(config *Configuration) error {
		if queueOnly {
			return config.authorizeSocialSetQueue(ctx, actor)
		}
		return config.authorizeSocialSetManage(ctx, actor)
	}
	if err := authorize(c); err != nil {
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
	if err := lockSocialSetAuthority(ctx, tx, actor, id); err != nil {
		return nil, err
	}
	if err := authorize(NewConfiguration(tx.Client())); err != nil {
		return nil, err
	}
	set, err := visibleSocialSet(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	update := tx.SocialSet.Update().Where(socialset.ID(set.ID), socialset.Version(input.BaseVersion)).AddVersion(1)
	changed := []string{}
	if input.Name != nil {
		name, err := socialSetName(*input.Name)
		if err != nil {
			return nil, err
		}
		update.SetName(name)
		changed = append(changed, "name")
	}
	if input.Color != nil {
		color, err := socialSetColor(*input.Color)
		if err != nil {
			return nil, err
		}
		update.SetColor(color)
		changed = append(changed, "color")
	}
	if input.TimeZone != nil {
		if !validTimeZone(*input.TimeZone) {
			return nil, invalid("Pick a time zone from the list, such as Europe/Paris.")
		}
		update.SetTimeZone(*input.TimeZone)
		changed = append(changed, "timeZone")
	}
	if input.PostingSlots != nil || (input.NaturalPostingTimes != nil && *input.NaturalPostingTimes) || input.EngagementDefaults != nil {
		if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, advancedSchedulingFeature); err != nil {
			return nil, err
		}
	}
	if input.PostingSlots != nil {
		slots, err := queueSlots(*input.PostingSlots)
		if err != nil {
			return nil, err
		}
		update.SetPostingSlots(slots)
		changed = append(changed, "postingSlots")
	}
	if input.NaturalPostingTimes != nil {
		update.SetNaturalPostingTimes(*input.NaturalPostingTimes)
		changed = append(changed, "naturalPostingTimes")
	}
	defaults := set.DefaultPlatforms
	if input.DefaultPlatforms != nil {
		if defaults, err = validDefaultPlatforms(ctx, tx, set, *input.DefaultPlatforms); err != nil {
			return nil, err
		}
		update.SetDefaultPlatforms(defaults)
		changed = append(changed, "defaultPlatforms")
	}
	primary := set.PrimaryPlatform
	if input.PrimaryPlatform != nil {
		primary = nil
		if *input.PrimaryPlatform != "" {
			value := *input.PrimaryPlatform
			primary = &value
		}
		changed = append(changed, "primaryPlatform")
	}
	if primary != nil && !oneOf(*primary, defaults...) {
		if input.PrimaryPlatform == nil {
			// The defaults changed under the primary: the first default takes over.
			primary = nil
		} else {
			return nil, invalid("The primary platform must be one of the default platforms.")
		}
	}
	if primary == nil && len(defaults) > 0 {
		first := defaults[0]
		primary = &first
	}
	if !queueOnly {
		if primary == nil {
			update.ClearPrimaryPlatform()
		} else {
			update.SetPrimaryPlatform(*primary)
		}
	}
	if input.EngagementDefaults != nil {
		engagement, err := validEngagement(*input.EngagementDefaults)
		if err != nil {
			return nil, err
		}
		update.SetEngagementDefaults(engagement)
		changed = append(changed, "engagementDefaults")
	}
	if input.PublicProfile != nil {
		update.SetPublicProfile(*input.PublicProfile)
		changed = append(changed, "publicProfile")
	}
	count, err := update.Save(ctx)
	if err != nil {
		return nil, err
	}
	if count == 0 {
		current, err := tx.SocialSet.Get(ctx, set.ID)
		if err != nil {
			return nil, err
		}
		return nil, &SocialSetVersionConflictError{Current: current.Version}
	}
	sort.Strings(changed)
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_updated", "social_set", set.ID,
		map[string]any{"fields": changed}); err != nil {
		return nil, err
	}
	for field, action := range map[string]string{"timeZone": "product.social_set_timezone_changed",
		"defaultPlatforms": "product.social_set_defaults_changed", "publicProfile": "product.social_set_public_profile_changed"} {
		if oneOf(field, changed...) {
			if err := appendConfigurationAudit(ctx, tx, actor, action, "social_set", set.ID); err != nil {
				return nil, err
			}
		}
	}
	saved, err := tx.SocialSet.Get(ctx, set.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, saved)
}

// ShareSocialSet moves a private set to the workspace ("Move to team"). Only
// its owner can, as a publisher, admin or owner of the workspace; from then on
// every member sees its accounts, schedule and drafts under their role.
func (c *Configuration) ShareSocialSet(ctx context.Context, actor Actor, id string) (*SocialSetRecord, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	set, err := visibleSocialSet(ctx, tx.Client(), actor, id)
	if err != nil {
		return nil, err
	}
	if set.Visibility != socialset.VisibilityPRIVATE {
		return nil, conflict("This social set is already shared with the workspace.")
	}
	if set.OwnerUserID == nil || *set.OwnerUserID != actor.UserID {
		return nil, forbidden("Only the person who owns a private social set can share it.")
	}
	count, err := tx.SocialSet.Update().Where(socialset.ID(set.ID), socialset.VisibilityEQ(socialset.VisibilityPRIVATE),
		socialset.OwnerUserID(actor.UserID)).SetVisibility(socialset.VisibilityWORKSPACE).AddVersion(1).Save(ctx)
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, conflict("This social set changed. Reload and try again.")
	}
	drafts, err := tx.ContentDraft.Query().Where(contentdraft.SocialSetID(set.ID)).Count(ctx)
	if err != nil {
		return nil, err
	}
	accounts, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_shared", "social_set", set.ID,
		map[string]any{"accounts": accounts, "drafts": drafts}); err != nil {
		return nil, err
	}
	saved, err := tx.SocialSet.Get(ctx, set.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, saved)
}

// SocialSetRemoval is what removing an account or deleting a set did: the
// queued posts it cancelled, whose workflows the caller must stop.
type SocialSetRemoval struct {
	CancelledPostIDs []string `json:"cancelledPostIds"`
	DraftsArchived   int      `json:"draftsArchived"`
}

// cancelQueuedPosts cancels the queued posts of the given connections; a post
// already publishing, or that may be live, refuses the whole operation.
func cancelQueuedPosts(ctx context.Context, tx *ent.Tx, actor Actor, connectionIDs []string, reason string) ([]string, error) {
	if len(connectionIDs) == 0 {
		return []string{}, nil
	}
	busy, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ChannelConnectionIDIn(connectionIDs...),
		scheduledpost.StatusIn(scheduledpost.StatusPROCESSING, scheduledpost.StatusUNKNOWN_DELIVERY)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if busy {
		return nil, conflict("A post is publishing, or may already be live, on this account. Wait for it to finish, then try again.")
	}
	return cancelPosts(ctx, tx, actor, connectionIDs, reason)
}

// cancelPosts cancels the posts still waiting to publish on these accounts.
func cancelPosts(ctx context.Context, tx *ent.Tx, actor Actor, connectionIDs []string, reason string) ([]string, error) {
	queued, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID),
		scheduledpost.ChannelConnectionIDIn(connectionIDs...),
		scheduledpost.StatusIn(scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED)).All(ctx)
	if err != nil {
		return nil, err
	}
	cancelled := make([]string, 0, len(queued))
	for _, post := range queued {
		count, err := tx.ScheduledPost.Update().Where(scheduledpost.ID(post.ID), scheduledpost.StatusIn(
			scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED)).SetStatus(scheduledpost.StatusCANCELLED).Save(ctx)
		if err != nil {
			return nil, err
		}
		if count != 1 {
			return nil, publishing.ErrConflict
		}
		if err := recordProductActivity(ctx, tx, actor, "post.cancelled", "post.cancelled", "scheduled_post", post.ID,
			map[string]any{"reason": reason}); err != nil {
			return nil, err
		}
		cancelled = append(cancelled, post.ID)
	}
	return cancelled, nil
}

// RemoveSocialSetAccount takes an account out of a set: its queued posts are
// cancelled, it is disabled so nothing further publishes through it, and its
// published posts and their receipts stay.
func (c *Configuration) RemoveSocialSetAccount(ctx context.Context, actor Actor, setID, connectionID string) (*SocialSetRemoval, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	set, err := visibleSocialSet(ctx, tx.Client(), actor, setID)
	if err != nil {
		return nil, err
	}
	connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(connectionID),
		channelconnection.OrganizationID(actor.OrganizationID), channelconnection.SocialSetID(set.ID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("That account is not in this social set.")
	}
	if err != nil {
		return nil, err
	}
	cancelled, err := removeAccount(ctx, tx, actor, connection, set)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SocialSetRemoval{CancelledPostIDs: cancelled}, nil
}

// removeAccount cancels an account's queued posts, refusing while one is
// publishing, disables it, takes its platform out of its set's defaults when
// it has a set, and audits the removal. The caller commits.
func removeAccount(ctx context.Context, tx *ent.Tx, actor Actor, connection *ent.ChannelConnection, set *ent.SocialSet) ([]string, error) {
	cancelled, err := cancelQueuedPosts(ctx, tx, actor, []string{connection.ID}, "account_removed")
	if err != nil {
		return nil, err
	}
	if _, err := tx.ChannelConnection.UpdateOneID(connection.ID).SetStatus(channelconnection.StatusDISABLED).Save(ctx); err != nil {
		return nil, err
	}
	if set == nil {
		return cancelled, appendConfigurationAudit(ctx, tx, actor, "product.channel_account_removed", "channel_connection", connection.ID,
			map[string]any{"cancelledPosts": len(cancelled)})
	}
	if err := dropAccountFromSetDefaults(ctx, tx, connection, set); err != nil {
		return nil, err
	}
	return cancelled, appendConfigurationAudit(ctx, tx, actor, "product.social_set_account_removed", "channel_connection", connection.ID,
		map[string]any{"cancelledPosts": len(cancelled), "socialSetId": set.ID})
}

// dropAccountFromSetDefaults stops a set defaulting to an account's platform.
func dropAccountFromSetDefaults(ctx context.Context, tx *ent.Tx, connection *ent.ChannelConnection, set *ent.SocialSet) error {
	defaults := make([]string, 0, len(set.DefaultPlatforms))
	for _, platform := range set.DefaultPlatforms {
		if socialplatform.Canonical(platform) != socialplatform.Canonical(connection.Platform) {
			defaults = append(defaults, platform)
		}
	}
	update := tx.SocialSet.UpdateOneID(set.ID).SetDefaultPlatforms(defaults).AddVersion(1)
	if set.PrimaryPlatform != nil && socialplatform.Canonical(*set.PrimaryPlatform) == socialplatform.Canonical(connection.Platform) {
		if len(defaults) > 0 {
			update.SetPrimaryPlatform(defaults[0])
		} else {
			update.ClearPrimaryPlatform()
		}
	}
	if _, err := update.Save(ctx); err != nil {
		return err
	}
	return nil
}

// AssignSocialSetAccount puts an account that belongs to no set into a set.
func (c *Configuration) AssignSocialSetAccount(ctx context.Context, actor Actor, setID, connectionID string) (*SocialSetRecord, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	set, err := visibleSocialSet(ctx, tx.Client(), actor, setID)
	if err != nil {
		return nil, err
	}
	connection, err := tx.ChannelConnection.Query().Where(channelconnection.ID(connectionID),
		channelconnection.OrganizationID(actor.OrganizationID), channelconnection.SocialSetIDIsNil(),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("That account is not available to add.")
	}
	if err != nil {
		return nil, err
	}
	taken, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.PlatformIn(socialplatform.Aliases(connection.Platform)...), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if taken {
		return nil, conflict("This social set already has a " + connection.Platform + " account. Remove it first.")
	}
	if _, err := tx.ChannelConnection.UpdateOneID(connection.ID).SetSocialSetID(set.ID).Save(ctx); err != nil {
		if ent.IsConstraintError(err) {
			return nil, conflict("This social set already has a " + connection.Platform + " account. Remove it first.")
		}
		return nil, err
	}
	platform := socialplatform.Canonical(connection.Platform)
	if !oneOf(platform, set.DefaultPlatforms...) {
		update := tx.SocialSet.UpdateOneID(set.ID).SetDefaultPlatforms(append(socialplatform.Defaults(set.DefaultPlatforms), platform)).AddVersion(1)
		if set.PrimaryPlatform == nil {
			update.SetPrimaryPlatform(platform)
		}
		if _, err := update.Save(ctx); err != nil {
			return nil, err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_account_added", "channel_connection", connection.ID,
		map[string]any{"socialSetId": set.ID}); err != nil {
		return nil, err
	}
	saved, err := tx.SocialSet.Get(ctx, set.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, saved)
}

// DeleteSocialSet removes a set. It is refused while any of its posts is
// queued or publishing, and for the workspace's last set. Otherwise its
// accounts are disabled, its drafts are archived and kept with their history,
// and the set is soft-deleted so its published posts stay explained.
func (c *Configuration) DeleteSocialSet(ctx context.Context, actor Actor, id, confirmation string) (*SocialSetRemoval, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	set, err := tx.SocialSet.Query().Where(socialset.ID(id), socialset.OrganizationID(actor.OrganizationID), socialset.DeletedAtIsNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Social set not found.")
	}
	if err != nil {
		return nil, err
	}
	admin := c.authorizeRoles(ctx, actor, "owner", "admin") == nil
	owner := set.OwnerUserID != nil && *set.OwnerUserID == actor.UserID
	switch {
	case socialSetVisible(set, actor) && set.Visibility == socialset.VisibilityPRIVATE && owner:
	case socialSetVisible(set, actor) && admin:
	case set.Visibility == socialset.VisibilityPRIVATE && admin:
		// An admin may clean up a private set only once its owner has left.
		stillMember, err := tx.Member.Query().Where(member.OrganizationID(actor.OrganizationID), member.UserID(*set.OwnerUserID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if stillMember {
			return nil, notFound("Social set not found.")
		}
	case socialSetVisible(set, actor):
		return nil, forbidden("Only a workspace owner or admin can delete a shared social set.")
	default:
		return nil, notFound("Social set not found.")
	}
	if strings.TrimSpace(confirmation) != set.Name {
		return nil, invalid("Type the social set's name to confirm.")
	}
	remaining, err := tx.SocialSet.Query().Where(socialset.OrganizationID(actor.OrganizationID), socialset.DeletedAtIsNil(),
		socialset.IDNEQ(set.ID), socialset.VisibilityEQ(socialset.VisibilityWORKSPACE)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !remaining && set.Visibility == socialset.VisibilityWORKSPACE {
		return nil, conflict("A workspace keeps at least one shared social set. Create another before deleting this one.")
	}
	connections, err := tx.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID)).IDs(ctx)
	if err != nil {
		return nil, err
	}
	live, err := tx.ScheduledPost.Query().Where(scheduledpost.OrganizationID(actor.OrganizationID), scheduledpost.Or(
		scheduledpost.SocialSetID(set.ID), scheduledpost.ChannelConnectionIDIn(connections...)),
		scheduledpost.StatusIn(scheduledpost.StatusDRAFT, scheduledpost.StatusSCHEDULED, scheduledpost.StatusPROCESSING,
			scheduledpost.StatusUNKNOWN_DELIVERY)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if live > 0 {
		return nil, conflict(fmt.Sprintf("This social set has %d queued or publishing posts. Cancel them first.", live))
	}
	if _, err := tx.ChannelConnection.Update().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.StatusEQ(channelconnection.StatusACTIVE)).SetStatus(channelconnection.StatusDISABLED).Save(ctx); err != nil {
		return nil, err
	}
	open, err := tx.ContentDraft.Query().Where(contentdraft.SocialSetID(set.ID), contentdraft.StatusNEQ(contentdraft.StatusArchived)).All(ctx)
	if err != nil {
		return nil, err
	}
	archived, err := tx.ContentDraft.Update().Where(contentdraft.SocialSetID(set.ID), contentdraft.StatusNEQ(contentdraft.StatusArchived)).
		SetStatus(contentdraft.StatusArchived).AddVersion(1).Save(ctx)
	if err != nil {
		return nil, err
	}
	for _, before := range open {
		after, err := tx.ContentDraft.Get(ctx, before.ID)
		if err != nil {
			return nil, err
		}
		if err := emitDraftChanges(ctx, tx, before, after); err != nil {
			return nil, err
		}
	}
	if _, err := tx.SocialSet.UpdateOneID(set.ID).SetDeletedAt(time.Now().UTC()).SetPublicProfile(false).AddVersion(1).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_deleted", "social_set", set.ID,
		map[string]any{"accountsDisabled": len(connections), "draftsArchived": archived}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SocialSetRemoval{CancelledPostIDs: []string{}, DraftsArchived: archived}, nil
}

// AuthorizeSocialSetConnection checks that actor may connect an account to
// the set before the provider is asked; an empty ID means the default set.
func (c *Configuration) AuthorizeSocialSetConnection(ctx context.Context, actor Actor, setID string) error {
	if setID == "" {
		return nil
	}
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return err
	}
	_, err := visibleSocialSet(ctx, c.client, actor, setID)
	return err
}

// CopyableSocialSet is a set of another workspace the actor may copy here.
type CopyableSocialSet struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName"`
}

// ListCopyableSocialSets lists sets of the actor's other workspaces that they
// can see and manage there, which they may copy into this one.
func (c *Configuration) ListCopyableSocialSets(ctx context.Context, actor Actor) ([]CopyableSocialSet, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	memberships, err := c.client.Member.Query().Where(member.UserID(actor.UserID), member.OrganizationIDNEQ(actor.OrganizationID),
		member.RoleIn(socialSetManageRoles...)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := []CopyableSocialSet{}
	for _, membership := range memberships {
		workspace, err := c.client.Organization.Get(ctx, membership.OrganizationID)
		if ent.IsNotFound(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		other := actor
		other.OrganizationID = membership.OrganizationID
		sets, err := c.visibleSocialSets(ctx, c.client, other)
		if err != nil {
			return nil, err
		}
		for _, set := range sets {
			items = append(items, CopyableSocialSet{ID: set.ID, Name: set.Name, WorkspaceID: workspace.ID, WorkspaceName: workspace.Name})
		}
	}
	return items, nil
}

// CopySocialSet copies another workspace's set into this one: its name,
// colour, schedule, defaults and style guide. Accounts are not copied; a set
// cannot carry another workspace's credentials, so they are connected again
// here. The copy starts private to the person who made it.
func (c *Configuration) CopySocialSet(ctx context.Context, actor Actor, sourceWorkspaceID, sourceSetID string) (*SocialSetRecord, error) {
	if err := c.authorizeSocialSetManage(ctx, actor); err != nil {
		return nil, err
	}
	if sourceWorkspaceID == actor.OrganizationID {
		return nil, invalid("Copy a social set from another workspace.")
	}
	allowed, err := c.client.Member.Query().Where(member.UserID(actor.UserID), member.OrganizationID(sourceWorkspaceID),
		member.RoleIn(socialSetManageRoles...)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	other := actor
	other.OrganizationID = sourceWorkspaceID
	var source *ent.SocialSet
	if allowed {
		source, err = visibleSocialSet(ctx, c.client, other, sourceSetID)
	}
	if !allowed || ent.IsNotFound(err) || source == nil {
		return nil, notFound("Social set not found.")
	}
	if err != nil {
		return nil, err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	assistant := source.WritingAssistant
	assistant.Status, assistant.ConfiguredAt = "", nil
	created, err := tx.SocialSet.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).SetName(source.Name).
		SetColor(source.Color).SetVisibility(socialset.VisibilityPRIVATE).SetOwnerUserID(actor.UserID).
		SetCreatedByUserID(actor.UserID).SetTimeZone(source.TimeZone).SetPostingSlots(nonNilSlots(source.PostingSlots)).
		SetNaturalPostingTimes(source.NaturalPostingTimes).SetEngagementDefaults(source.EngagementDefaults).
		SetWritingAssistant(assistant).SetPublicSlug(randomSlug()).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_copied", "social_set", created.ID,
		map[string]any{"sourceSocialSetId": source.ID, "sourceWorkspaceId": sourceWorkspaceID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return c.socialSetRecord(ctx, actor, created.Unwrap())
}
