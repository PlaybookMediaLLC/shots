package product

import (
	"context"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/brandprofile"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/channelconnection"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/schema"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialset"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/socialsetwritingsample"
	"github.com/lucsky/cuid"
)

// A social set's Writing Assistant (RFC 024) refines the workspace brand voice
// for one identity: its tone and audience, words to use and avoid, and
// samples of how it writes. AI help for a draft in the set reads the merged
// context below; the assistant suggests and the writer decides.

const (
	writingSampleLimit     = 20
	writingSampleTextLimit = 5000
	// writingContextSamples is how many samples, at most, reach the model.
	writingContextSamples    = 5
	writingContextSampleText = 1200
)

// WritingAssistantUpdate creates, turns off or on, or edits the style guide
// of a set's assistant, based on BaseVersion.
type WritingAssistantUpdate struct {
	// Action is create, disable or enable; empty only edits the style guide.
	Action      string             `json:"action"`
	BaseVersion int                `json:"baseVersion"`
	StyleGuide  *schema.StyleGuide `json:"styleGuide"`
}

// WritingSampleRecord is one sample as the API returns it.
type WritingSampleRecord struct {
	CreatedAt       time.Time `json:"createdAt"`
	CreatedByUserID *string   `json:"createdByUserId"`
	ID              string    `json:"id"`
	Source          string    `json:"source"`
	SourceDraftID   *string   `json:"sourceDraftId"`
	Text            string    `json:"text"`
}

// WritingSampleInput adds a sample: Text written in place, or DraftID to copy
// a draft of the same set.
type WritingSampleInput struct {
	DraftID string `json:"draftId"`
	Text    string `json:"text"`
}

// WritingContext is what AI help writes with for one draft: the workspace
// brand voice refined by the draft's set.
type WritingContext struct {
	Audience          string   `json:"audience"`
	Endings           []string `json:"endings"`
	Formatting        string   `json:"formatting"`
	Openings          []string `json:"openings"`
	PlatformGuidance  string   `json:"platformGuidance"`
	ProhibitedPhrases []string `json:"prohibitedPhrases"`
	Samples           []string `json:"samples"`
	SocialSetName     string   `json:"socialSetName"`
	// Source says whether the set's assistant shaped the context: brand or social_set.
	Source      string   `json:"source"`
	Terminology []string `json:"terminology"`
	Tone        string   `json:"tone"`
}

func trimList(values []string, items, length int, what string) ([]string, error) {
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if utf8.RuneCountInString(value) > length {
			return nil, invalid("Keep each " + what + " short.")
		}
		out = append(out, value)
	}
	if len(out) > items {
		return nil, invalid("Keep the " + what + " list short.")
	}
	return out, nil
}

func trimText(value string, length int, what string) (string, error) {
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > length {
		return "", invalid("Keep the " + what + " under " + strconv.Itoa(length) + " characters.")
	}
	return value, nil
}

// validStyleGuide bounds every field of a style guide.
func validStyleGuide(guide schema.StyleGuide) (schema.StyleGuide, error) {
	var err error
	if guide.Tone, err = trimText(guide.Tone, 300, "tone"); err != nil {
		return guide, err
	}
	if guide.Audience, err = trimText(guide.Audience, 300, "audience"); err != nil {
		return guide, err
	}
	if guide.Formatting, err = trimText(guide.Formatting, 600, "formatting guidance"); err != nil {
		return guide, err
	}
	if guide.Terminology, err = trimList(guide.Terminology, 30, 80, "preferred term"); err != nil {
		return guide, err
	}
	if guide.ProhibitedPhrases, err = trimList(guide.ProhibitedPhrases, 30, 80, "phrase to avoid"); err != nil {
		return guide, err
	}
	if guide.Openings, err = trimList(guide.Openings, 10, 280, "example opening"); err != nil {
		return guide, err
	}
	if guide.Endings, err = trimList(guide.Endings, 10, 280, "example ending"); err != nil {
		return guide, err
	}
	guidance := map[string]string{}
	for platform, text := range guide.PlatformGuidance {
		if _, ok := draftChannelLimits[platform]; !ok {
			return guide, invalid("Platform guidance is for x, linkedin, instagram, threads, bluesky or mastodon.")
		}
		if text, err = trimText(text, 600, "platform guidance"); err != nil {
			return guide, err
		}
		if text != "" {
			guidance[platform] = text
		}
	}
	guide.PlatformGuidance = guidance
	return guide, nil
}

// authorizeWriting checks a signed-in owner, admin or creator on a plan with drafts.
func (c *Configuration) authorizeWriting(ctx context.Context, actor Actor) error {
	if err := c.authorizeDecision(ctx, actor, socialSetWritingRoles...); err != nil {
		return err
	}
	return c.requireWorkspaceFeature(ctx, actor.OrganizationID, contentDraftFeature)
}

// UpdateWritingAssistant saves a set's assistant. Creating it needs the
// workspace AI switch on and something to learn from: a sample or a style
// guide.
func (c *Configuration) UpdateWritingAssistant(ctx context.Context, actor Actor, setID string, input WritingAssistantUpdate) (*SocialSetRecord, error) {
	if err := c.authorizeWriting(ctx, actor); err != nil {
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
	set, err := visibleSocialSet(ctx, tx.Client(), actor, setID)
	if err != nil {
		return nil, err
	}
	assistant := set.WritingAssistant
	if input.StyleGuide != nil {
		guide, err := validStyleGuide(*input.StyleGuide)
		if err != nil {
			return nil, err
		}
		assistant.StyleGuide = guide
	}
	switch input.Action {
	case "":
	case "create":
		if !c.workspaceAIEnabled(ctx, actor.OrganizationID) {
			return nil, conflict("AI is turned off for this workspace. An owner or admin can turn it on in General settings.")
		}
		samples, err := tx.SocialSetWritingSample.Query().Where(socialsetwritingsample.SocialSetID(set.ID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		if samples == 0 && styleGuideEmpty(assistant.StyleGuide) {
			return nil, invalid("Add a writing sample or fill in the style guide first, so the assistant has something to learn from.")
		}
		now := time.Now().UTC()
		assistant.Status, assistant.ConfiguredAt = "configured", &now
	case "disable":
		assistant.Status = "disabled"
	case "enable":
		if assistant.ConfiguredAt == nil {
			return nil, invalid("Create the assistant first.")
		}
		assistant.Status = "configured"
	default:
		return nil, invalid("The action is create, disable or enable.")
	}
	count, err := tx.SocialSet.Update().Where(socialset.ID(set.ID), socialset.Version(input.BaseVersion)).
		SetWritingAssistant(assistant).AddVersion(1).Save(ctx)
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
	if err := appendConfigurationAudit(ctx, tx, actor, "product.social_set_writing_updated", "social_set", set.ID,
		map[string]any{"action": input.Action, "styleGuide": input.StyleGuide != nil}); err != nil {
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

func writingSampleRecord(row *ent.SocialSetWritingSample) WritingSampleRecord {
	return WritingSampleRecord{CreatedAt: row.CreatedAt, CreatedByUserID: row.CreatedByUserID, ID: row.ID,
		Source: string(row.Source), SourceDraftID: row.SourceDraftID, Text: row.Text}
}

// ListWritingSamples lists a set's samples, newest first.
func (c *Configuration) ListWritingSamples(ctx context.Context, actor Actor, setID string) ([]WritingSampleRecord, error) {
	if err := c.authorizeContentDrafts(ctx, actor, false); err != nil {
		return nil, err
	}
	set, err := visibleSocialSet(ctx, c.client, actor, setID)
	if err != nil {
		return nil, err
	}
	rows, err := c.client.SocialSetWritingSample.Query().Where(socialsetwritingsample.SocialSetID(set.ID),
		socialsetwritingsample.OrganizationID(actor.OrganizationID)).
		Order(ent.Desc(socialsetwritingsample.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]WritingSampleRecord, 0, len(rows))
	for _, row := range rows {
		items = append(items, writingSampleRecord(row))
	}
	return items, nil
}

// AddWritingSample adds a sample to a set. A draft can be imported only from
// the same set, so no private draft of another set is ever read.
func (c *Configuration) AddWritingSample(ctx context.Context, actor Actor, setID string, input WritingSampleInput) (*WritingSampleRecord, error) {
	if err := c.authorizeWriting(ctx, actor); err != nil {
		return nil, err
	}
	set, err := visibleSocialSet(ctx, c.client, actor, setID)
	if err != nil {
		return nil, err
	}
	count, err := c.client.SocialSetWritingSample.Query().Where(socialsetwritingsample.SocialSetID(set.ID)).Count(ctx)
	if err != nil {
		return nil, err
	}
	if count >= writingSampleLimit {
		return nil, conflict("A social set keeps at most 20 writing samples. Remove one first.")
	}
	text := strings.TrimSpace(input.Text)
	source := socialsetwritingsample.SourceManual
	var sourceDraft *string
	if input.DraftID != "" {
		if text != "" {
			return nil, invalid("Add text, or import a draft, not both.")
		}
		draft, err := visibleContentDraft(ctx, c.client, actor, input.DraftID)
		if err != nil {
			return nil, err
		}
		if draft.SocialSetID == nil || *draft.SocialSetID != set.ID {
			return nil, invalid("Import a draft of this social set.")
		}
		text, source, sourceDraft = strings.TrimSpace(draft.PlainText), socialsetwritingsample.SourceDraft, &draft.ID
	}
	if text == "" {
		return nil, invalid("A writing sample needs text.")
	}
	text = truncateRunes(text, writingSampleTextLimit)
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := tx.SocialSetWritingSample.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetSocialSetID(set.ID).SetText(text).SetSource(source).SetNillableSourceDraftID(sourceDraft).
		SetCreatedByUserID(actor.UserID).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.writing_sample_added", "social_set", set.ID,
		map[string]any{"sampleId": row.ID, "source": string(source)}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	record := writingSampleRecord(row.Unwrap())
	return &record, nil
}

// DeleteWritingSample removes one sample.
func (c *Configuration) DeleteWritingSample(ctx context.Context, actor Actor, setID, sampleID string) error {
	if err := c.authorizeWriting(ctx, actor); err != nil {
		return err
	}
	set, err := visibleSocialSet(ctx, c.client, actor, setID)
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	count, err := tx.SocialSetWritingSample.Delete().Where(socialsetwritingsample.ID(sampleID),
		socialsetwritingsample.SocialSetID(set.ID), socialsetwritingsample.OrganizationID(actor.OrganizationID)).Exec(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return notFound("Writing sample not found.")
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.writing_sample_removed", "social_set", set.ID,
		map[string]any{"sampleId": sampleID}); err != nil {
		return err
	}
	return tx.Commit()
}

// mergeWritingContext refines the brand voice with a set's style guide. The
// brand's prohibited terms are kept and the set's added to them, so a set can
// never allow what the workspace forbids. The set's tone and audience replace
// the brand's when given; preferred terms are both lists.
func mergeWritingContext(brand *ent.BrandProfile, set *ent.SocialSet, samples []string, channel string) WritingContext {
	merged := WritingContext{Endings: []string{}, Openings: []string{}, ProhibitedPhrases: []string{}, Samples: []string{},
		Source: "brand", Terminology: []string{}}
	seen := map[string]bool{}
	addProhibited := func(term string) {
		key := strings.ToLower(strings.TrimSpace(term))
		if key != "" && !seen[key] {
			seen[key] = true
			merged.ProhibitedPhrases = append(merged.ProhibitedPhrases, strings.TrimSpace(term))
		}
	}
	if brand != nil {
		merged.Tone, merged.Audience = brand.Tone, brand.Audience
		for _, term := range brand.ProhibitedTerms {
			addProhibited(term.Term)
		}
	}
	if set == nil {
		return merged
	}
	merged.SocialSetName = set.Name
	if set.WritingAssistant.Status != "configured" {
		return merged
	}
	merged.Source = "social_set"
	guide := set.WritingAssistant.StyleGuide
	if guide.Tone != "" {
		merged.Tone = guide.Tone
	}
	if guide.Audience != "" {
		merged.Audience = guide.Audience
	}
	merged.Terminology = append(merged.Terminology, guide.Terminology...)
	for _, phrase := range guide.ProhibitedPhrases {
		addProhibited(phrase)
	}
	merged.Formatting = guide.Formatting
	merged.Openings = append(merged.Openings, guide.Openings...)
	merged.Endings = append(merged.Endings, guide.Endings...)
	merged.PlatformGuidance = guide.PlatformGuidance[channel]
	for _, sample := range samples {
		if len(merged.Samples) == writingContextSamples {
			break
		}
		merged.Samples = append(merged.Samples, truncateRunes(sample, writingContextSampleText))
	}
	return merged
}

// DraftWritingContext is the context AI help uses for a draft on a channel.
func (c *Configuration) DraftWritingContext(ctx context.Context, actor Actor, draftID, channel string) (*WritingContext, error) {
	if err := c.authorizeContentDrafts(ctx, actor, true); err != nil {
		return nil, err
	}
	draft, err := visibleContentDraft(ctx, c.client, actor, draftID)
	if err != nil {
		return nil, err
	}
	if _, ok := draftChannelLimits[channel]; !ok {
		return nil, invalid("Name a draft channel.")
	}
	brand, err := c.client.BrandProfile.Query().Where(brandprofile.OrganizationID(actor.OrganizationID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	var set *ent.SocialSet
	samples := []string{}
	if draft.SocialSetID != nil {
		if set, err = c.client.SocialSet.Get(ctx, *draft.SocialSetID); err != nil {
			return nil, err
		}
		rows, err := c.client.SocialSetWritingSample.Query().Where(socialsetwritingsample.SocialSetID(set.ID)).
			Order(ent.Desc(socialsetwritingsample.FieldCreatedAt)).Limit(writingContextSamples).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			samples = append(samples, row.Text)
		}
	}
	merged := mergeWritingContext(brand, set, samples, channel)
	return &merged, nil
}

// PublicAccount is a connected account as a public profile shows it.
type PublicAccount struct {
	AvatarURL   *string `json:"avatarUrl"`
	DisplayName *string `json:"displayName"`
	Handle      *string `json:"handle"`
	Platform    string  `json:"platform"`
}

// PublicProfile is everything a set's public page shows: no drafts, members,
// IDs or credentials.
type PublicProfile struct {
	Accounts []PublicAccount `json:"accounts"`
	Color    string          `json:"color"`
	Name     string          `json:"name"`
}

// GetPublicProfile reads a set's public profile by its slug. A set whose
// profile is off, or that was deleted, returns not found, so turning the
// profile off takes effect on the very next request.
func (c *Configuration) GetPublicProfile(ctx context.Context, slug string) (*PublicProfile, error) {
	if len(slug) != 24 || strings.Trim(slug, "0123456789abcdef") != "" {
		return nil, notFound("Profile not found.")
	}
	set, err := c.client.SocialSet.Query().Where(socialset.PublicSlug(slug), socialset.PublicProfile(true),
		socialset.DeletedAtIsNil()).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, notFound("Profile not found.")
	}
	if err != nil {
		return nil, err
	}
	connections, err := c.client.ChannelConnection.Query().Where(channelconnection.SocialSetID(set.ID),
		channelconnection.OrganizationID(set.OrganizationID), channelconnection.StatusEQ(channelconnection.StatusACTIVE)).
		Order(ent.Asc(channelconnection.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	profile := &PublicProfile{Accounts: []PublicAccount{}, Color: set.Color, Name: set.Name}
	for _, connection := range connections {
		profile.Accounts = append(profile.Accounts, PublicAccount{AvatarURL: BrowserAvatar(ctx, connection.AvatarURL),
			DisplayName: connection.DisplayName, Handle: connection.Handle, Platform: connection.Platform})
	}
	return profile, nil
}
