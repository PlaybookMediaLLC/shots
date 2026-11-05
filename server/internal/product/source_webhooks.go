package product

import (
	"context"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/deploymentevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/outboxevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourcechange"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
	"github.com/google/uuid"
	"github.com/lucsky/cuid"
)

// WebhookSource is what the web facade needs to verify a source webhook
// before any tenant is known. The secret itself stays in the facade's
// environment; only its reference name leaves the database.
type WebhookSource struct {
	Branch                    *string  `json:"branch"`
	ExternalID                *string  `json:"externalId"`
	GitHubInstallationID      *string  `json:"githubInstallationId"`
	ID                        string   `json:"id"`
	IgnoreBotPullRequests     bool     `json:"ignoreBotPullRequests"`
	IgnoredPullRequestAuthors []string `json:"ignoredPullRequestAuthors"`
	OrganizationID            string   `json:"organizationId"`
	Provider                  string   `json:"provider"`
	SecretReference           *string  `json:"secretReference"`
	SkipPrereleases           bool     `json:"skipPrereleases"`
}

type IngestSourceReleaseInput struct {
	// Only the internal automation activity supplies explicit membership evidence.
	automationAssociation *sourceReleaseAssociation
	Audience              *string `json:"audience"`
	BenefitStatement      string  `json:"benefitStatement"`
	Description           *string `json:"description"`
	EventID               string  `json:"eventId"`
	// Notes are the release notes in full; features and linked PRs are read from them.
	Notes *string `json:"notes"`
	// RepositoryID scopes which collected changes the release takes; RepositoryName
	// (owner/repo) recognises the repository's PR links in the notes.
	RepositoryID   *string  `json:"repositoryId"`
	RepositoryName *string  `json:"repositoryName"`
	SourceAppID    string   `json:"sourceAppId"`
	SourceURLs     []string `json:"sourceUrls"`
	Title          string   `json:"title"`
}

type sourceReleaseAssociation struct {
	Numbers []int
	Cutoff  time.Time
}

type SourceReleaseIngest struct {
	Created   bool   `json:"created"`
	ReleaseID string `json:"releaseId"`
}

// MaxReleaseNotesRunes bounds the notes a release stores; GitHub allows 125,000 characters.
const MaxReleaseNotesRunes = 50_000

// GetWebhookSource is facade-only: it runs before the webhook signature, and
// therefore the tenant, is established.
func (c *Configuration) GetWebhookSource(ctx context.Context, sourceAppID string) (*WebhookSource, error) {
	row, err := c.client.SourceApp.Query().Where(sourceapp.ID(sourceAppID), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return webhookSource(row), nil
}

func webhookSource(row *ent.SourceApp) *WebhookSource {
	return &WebhookSource{Branch: row.Branch, ExternalID: row.ExternalID, GitHubInstallationID: row.GithubInstallationID, ID: row.ID,
		IgnoreBotPullRequests: row.IgnoreBotPullRequests, IgnoredPullRequestAuthors: nonNilStrings(row.IgnoredPullRequestAuthors),
		OrganizationID: row.OrganizationID, Provider: row.Provider, SecretReference: row.SecretReference,
		SkipPrereleases: row.SkipPrereleases}
}

// ignoresAuthor applies a source's author rules to a login from release notes
// or a pull request; logins are case-insensitive.
func ignoresAuthor(source *ent.SourceApp, login string) bool {
	login = strings.ToLower(login)
	if login == "" {
		return false
	}
	if source.IgnoreBotPullRequests && strings.HasSuffix(login, "[bot]") {
		return true
	}
	for _, author := range source.IgnoredPullRequestAuthors {
		if strings.ToLower(author) == login {
			return true
		}
	}
	return false
}

// IngestSourceRelease creates one release per source event. The release takes
// the source's collected changes, its outbox event, and the audit record in
// one transaction; a replayed event returns the release it created.
func (c *Configuration) IngestSourceRelease(ctx context.Context, actor Actor, input IngestSourceReleaseInput) (*SourceReleaseIngest, error) {
	if actor.Kind != "webhook" && !(actor.Kind == "service" && input.automationAssociation != nil) {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor); err != nil {
		return nil, err
	}
	if err := c.requireWorkspaceFeature(ctx, actor.OrganizationID, "release:create"); err != nil {
		return nil, err
	}
	input.Title = strings.TrimSpace(input.Title)
	input.BenefitStatement = strings.TrimSpace(input.BenefitStatement)
	if input.SourceURLs == nil {
		input.SourceURLs = []string{}
	}
	if input.Notes != nil {
		notes := releasenotes.Clean(*input.Notes, MaxReleaseNotesRunes)
		input.Notes = &notes
	}
	if input.SourceAppID == "" || input.EventID == "" || len(input.EventID) > 255 ||
		(input.RepositoryID != nil && (*input.RepositoryID == "" || len(*input.RepositoryID) > 64)) ||
		(input.RepositoryName != nil && (!strings.Contains(*input.RepositoryName, "/") || len(*input.RepositoryName) > 200)) ||
		!validReleaseBrief(input.Title, input.BenefitStatement, input.Audience, input.Description, input.SourceURLs) {
		return nil, ErrInvalidInput
	}
	key := "source:" + input.SourceAppID + ":" + input.EventID
	for attempt := 0; attempt < 3; attempt++ {
		result, err := c.ingestSourceRelease(ctx, actor, input, key)
		if ent.IsConstraintError(err) {
			continue
		}
		return result, err
	}
	return nil, publishing.ErrConflict
}

func (c *Configuration) ingestSourceRelease(ctx context.Context, actor Actor, input IngestSourceReleaseInput, key string) (*SourceReleaseIngest, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, input.SourceAppID)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if source.Status != sourceapp.StatusACTIVE {
		return nil, publishing.ErrNotFound
	}
	if source.ReleaseAutomation && input.automationAssociation == nil {
		return nil, conflict("This source uses release automation; legacy release intake is disabled.")
	}
	// A source that names a repository takes releases only from it.
	if source.ExternalID != nil && input.RepositoryID != nil && *input.RepositoryID != *source.ExternalID {
		return nil, invalid("This release is from a different repository than the source's.")
	}
	existing, err := tx.OutboxEvent.Query().Where(outboxevent.OrganizationID(actor.OrganizationID),
		outboxevent.IdempotencyKey(key)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if existing != nil {
		return &SourceReleaseIngest{Created: false, ReleaseID: existing.AggregateID}, nil
	}
	id := uuid.NewString()
	features, err := releaseFeatures(ctx, tx, source, input, id)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{"releaseId": id, "sourceAppId": input.SourceAppID, "actorUserId": actor.UserID}
	if evidence := input.automationAssociation; evidence != nil {
		payload["associationNumbers"] = evidence.Numbers
		payload["associationCutoff"] = evidence.Cutoff.Format(time.RFC3339Nano)
		payload["associationRepository"] = optionalText(input.RepositoryID)
	}
	// A GitHub release keeps its ID, so the worker can read its signed screenshots.
	if parts := strings.Split(input.EventID, ":"); len(parts) == 3 && parts[0] == "release" {
		if releaseID, err := strconv.ParseInt(parts[2], 10, 64); err == nil {
			payload["githubReleaseId"] = releaseID
		}
	}
	_, err = tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("release.ingested").SetAggregateType("release").SetAggregateID(id).
		SetPayload(payload).
		SetIdempotencyKey(key).Save(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Release.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetTitle(input.Title).
		SetBenefitStatement(input.BenefitStatement).SetNillableAudience(input.Audience).
		SetNillableDescription(input.Description).SetSourceUrls(input.SourceURLs).
		SetNillableNotes(input.Notes).SetFeatures(features).Save(ctx); err != nil {
		return nil, err
	}
	// The release takes every change merged since the source's last release.
	attach := tx.SourceChange.Update().Where(sourcechange.OrganizationID(actor.OrganizationID),
		sourcechange.SourceAppID(source.ID), sourcechange.ReleaseIDIsNil())
	if input.RepositoryID != nil {
		attach.Where(sourcechange.RepositoryID(*input.RepositoryID))
	}
	if evidence := input.automationAssociation; evidence != nil {
		attach.Where(sourcechange.NumberIn(evidence.Numbers...), sourcechange.MergedAtLTE(evidence.Cutoff))
	}
	if _, err = attach.SetReleaseID(id).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.release_ingested", "release", id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SourceReleaseIngest{Created: true, ReleaseID: id}, nil
}

// releaseFeatures lists what a release shipped: the features in its notes,
// then each collected change the notes do not already name, without the
// authors the source ignores.
func releaseFeatures(ctx context.Context, tx *ent.Tx, source *ent.SourceApp, input IngestSourceReleaseInput, releaseID string) ([]releasenotes.Feature, error) {
	features := []releasenotes.Feature{}
	named := map[int]bool{}
	if input.Notes != nil {
		for _, feature := range releasenotes.Features(*input.Notes) {
			if !ignoresAuthor(source, feature.Author) {
				features = append(features, feature)
				named[feature.Number] = feature.Number != 0
			}
		}
		if input.RepositoryName != nil {
			owner, repo, _ := strings.Cut(*input.RepositoryName, "/")
			for _, number := range releasenotes.PullRequests(*input.Notes, owner, repo) {
				named[number] = true
			}
		}
	}
	pending := tx.SourceChange.Query().Where(sourcechange.OrganizationID(source.OrganizationID),
		sourcechange.SourceAppID(source.ID), sourcechange.ReleaseIDIsNil())
	if input.RepositoryID != nil {
		pending.Where(sourcechange.RepositoryID(*input.RepositoryID))
	}
	if evidence := input.automationAssociation; evidence != nil {
		pending.Where(sourcechange.NumberIn(evidence.Numbers...), sourcechange.MergedAtLTE(evidence.Cutoff))
	}
	changes, err := pending.Order(ent.Asc(sourcechange.FieldMergedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, change := range changes {
		if named[change.Number] || len(features) == releasenotes.MaxFeatures {
			continue
		}
		author := ""
		if change.AuthorLogin != nil {
			author = *change.AuthorLogin
		}
		kind, title := releasenotes.Title(change.Title)
		features = append(features, releasenotes.Feature{Kind: kind, Title: title, Number: change.Number, URL: change.URL, Author: author})
	}
	return features, nil
}

// CollectSourceChangeInput is a pull request merged into a source's branch.
type CollectSourceChangeInput struct {
	AuthorLogin  *string   `json:"authorLogin"`
	Body         string    `json:"body"`
	EventID      string    `json:"eventId"`
	Labels       []string  `json:"labels"`
	MergedAt     time.Time `json:"mergedAt"`
	Number       int       `json:"number"`
	RepositoryID string    `json:"repositoryId"`
	SourceAppID  string    `json:"sourceAppId"`
	Title        string    `json:"title"`
	URL          string    `json:"url"`
}

type SourceChangeCollect struct {
	ChangeID string `json:"changeId"`
	Created  bool   `json:"created"`
}

// MaxChangeBodyRunes bounds a stored pull request description.
const MaxChangeBodyRunes = 10_000

// CollectSourceChange holds a merged pull request until the source's next
// release takes it. Each PR is collected once per source; a redelivery
// returns the change it created.
func (c *Configuration) CollectSourceChange(ctx context.Context, actor Actor, input CollectSourceChangeInput) (*SourceChangeCollect, error) {
	if actor.Kind != "webhook" {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor); err != nil {
		return nil, err
	}
	input.Title = releasenotes.Clean(input.Title, 300)
	input.Body = releasenotes.Clean(input.Body, MaxChangeBodyRunes)
	if input.Labels == nil {
		input.Labels = []string{}
	}
	if input.SourceAppID == "" || input.RepositoryID == "" || len(input.RepositoryID) > 64 || input.Number < 1 ||
		input.Title == "" || !validReleaseURLs([]string{input.URL}) || input.MergedAt.IsZero() || len(input.Labels) > 50 ||
		(input.AuthorLogin != nil && (*input.AuthorLogin == "" || len(*input.AuthorLogin) > 100)) {
		return nil, ErrInvalidInput
	}
	for _, label := range input.Labels {
		if label == "" || utf8.RuneCountInString(label) > 100 {
			return nil, ErrInvalidInput
		}
	}
	for attempt := 0; attempt < 3; attempt++ {
		result, err := c.collectSourceChange(ctx, actor, input)
		if ent.IsConstraintError(err) {
			continue
		}
		return result, err
	}
	return nil, publishing.ErrConflict
}

func (c *Configuration) collectSourceChange(ctx context.Context, actor Actor, input CollectSourceChangeInput) (*SourceChangeCollect, error) {
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	source, err := lockAutomationSource(ctx, tx, actor.OrganizationID, input.SourceAppID)
	if err != nil {
		return nil, err
	}
	if source.Status != sourceapp.StatusACTIVE {
		return nil, publishing.ErrNotFound
	}
	existing, err := tx.SourceChange.Query().Where(sourcechange.OrganizationID(actor.OrganizationID),
		sourcechange.SourceAppID(input.SourceAppID), sourcechange.RepositoryID(input.RepositoryID),
		sourcechange.Number(input.Number)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if existing != nil {
		return &SourceChangeCollect{ChangeID: existing.ID, Created: false}, nil
	}
	id := cuid.New()
	if _, err = tx.SourceChange.Create().SetID(id).SetOrganizationID(actor.OrganizationID).SetSourceAppID(input.SourceAppID).
		SetRepositoryID(input.RepositoryID).SetNumber(input.Number).SetTitle(input.Title).SetBody(input.Body).
		SetURL(input.URL).SetNillableAuthorLogin(input.AuthorLogin).SetLabels(input.Labels).
		SetImageUrls(releasenotes.Images(input.Body)).SetMergedAt(input.MergedAt).Save(ctx); err != nil {
		return nil, err
	}
	if err := associateLateSourceChange(ctx, tx, actor, source, input, id); err != nil {
		return nil, err
	}
	if _, err = tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("source_change.collected").SetAggregateType("source_change").SetAggregateID(id).
		SetPayload(map[string]any{"changeId": id, "sourceAppId": input.SourceAppID, "actorUserId": actor.UserID}).
		SetIdempotencyKey("change:" + input.SourceAppID + ":" + input.RepositoryID + ":" + strconv.Itoa(input.Number)).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.source_change_collected", "source_change", id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &SourceChangeCollect{ChangeID: id, Created: true}, nil
}

// IngestDeploymentInput is a deployment GitHub reports as live in production.
type IngestDeploymentInput struct {
	Environment string  `json:"environment"`
	EventID     string  `json:"eventId"`
	ExternalID  string  `json:"externalId"`
	SHA         *string `json:"sha"`
	SourceAppID string  `json:"sourceAppId"`
	URL         *string `json:"url"`
}

type DeploymentIngest struct {
	Created      bool   `json:"created"`
	DeploymentID string `json:"deploymentId"`
}

// IngestDeployment records a production deployment once; capturing the
// product it shipped is the worker's job.
func (c *Configuration) IngestDeployment(ctx context.Context, actor Actor, input IngestDeploymentInput) (*DeploymentIngest, error) {
	if actor.Kind != "webhook" {
		return nil, publishing.ErrForbidden
	}
	if err := c.authorizeRoles(ctx, actor); err != nil {
		return nil, err
	}
	if input.SourceAppID == "" || input.ExternalID == "" || len(input.ExternalID) > 100 ||
		input.Environment == "" || utf8.RuneCountInString(input.Environment) > 100 ||
		(input.URL != nil && !validDeploymentURL(*input.URL)) || (input.SHA != nil && len(*input.SHA) > 64) {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	active, err := tx.SourceApp.Query().Where(sourceapp.ID(input.SourceAppID),
		sourceapp.OrganizationID(actor.OrganizationID), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !active {
		return nil, publishing.ErrNotFound
	}
	id := cuid.New()
	created, err := tx.DeploymentEvent.Create().SetID(id).SetOrganizationID(actor.OrganizationID).
		SetSourceAppID(input.SourceAppID).SetExternalID(input.ExternalID).SetEnvironment(input.Environment).
		SetNillableURL(input.URL).SetNillableSha(input.SHA).Save(ctx)
	if ent.IsConstraintError(err) {
		row, findErr := c.client.DeploymentEvent.Query().Where(deploymentevent.OrganizationID(actor.OrganizationID),
			deploymentevent.SourceAppID(input.SourceAppID), deploymentevent.ExternalID(input.ExternalID)).Only(ctx)
		if findErr != nil {
			return nil, findErr
		}
		return &DeploymentIngest{Created: false, DeploymentID: row.ID}, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.OutboxEvent.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
		SetType("deployment.succeeded").SetAggregateType("deployment_event").SetAggregateID(created.ID).
		SetPayload(map[string]any{"deploymentId": created.ID, "sourceAppId": input.SourceAppID, "actorUserId": actor.UserID}).
		SetIdempotencyKey("deployment:" + input.SourceAppID + ":" + input.ExternalID).Save(ctx); err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.deployment_received", "deployment_event", created.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &DeploymentIngest{Created: true, DeploymentID: created.ID}, nil
}

// validDeploymentURL accepts an HTTPS address without credentials. A private
// address is still recorded, because the deployment happened; capturing it is
// refused, and the readiness request checks the address it actually dials.
func validDeploymentURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && len(value) <= 2000 && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}
