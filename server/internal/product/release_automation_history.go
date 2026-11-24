package product

import (
	"context"
	"strconv"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releaseautomationrun"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/releasesourceevent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasenotes"
)

// Historical receipts reserve the same semantic identity as live deliveries,
// so connecting a repository cannot later replay its history as marketing work.
func (c *Configuration) recordHistoricalRelease(ctx context.Context, source *ent.SourceApp, repository githubapp.Repository, release githubapp.Release) error {
	id, repo := strconv.FormatInt(release.ID, 10), strconv.FormatInt(repository.ID, 10)
	event := automation.Event{Family: automation.Published, SemanticKey: "release:" + repo + ":" + id, RepositoryID: repo, RepositoryName: repository.FullName, ObjectID: id, OccurredAt: release.PublishedAt, Origin: "historical", Title: releasenotes.Clean(firstNonEmpty(release.Name, release.TagName), 160), Notes: releasenotes.Clean(release.Body, MaxReleaseNotesRunes), URL: release.HTMLURL, DefaultBranch: repository.DefaultBranch,
		Fields: map[string]automation.Value{"repository.id": automation.StringValue(repo), "repository.name": automation.StringValue(repository.FullName), "event.family": automation.StringValue(string(automation.Published)), "event.action": automation.StringValue("published"), "release.tag": automation.StringValue(firstNonEmpty(release.TagName, release.Name)), "release.title": automation.StringValue(releasenotes.Clean(firstNonEmpty(release.Name, release.TagName), 160)), "release.prerelease": automation.BoolValue(release.Prerelease)}}
	return c.recordHistoricalEvent(ctx, source, event)
}

func (c *Configuration) recordHistoricalPR(ctx context.Context, source *ent.SourceApp, repository githubapp.Repository, pr githubapp.PullRequest) error {
	if pr.MergedAt == nil {
		return ErrInvalidInput
	}
	repo, number := strconv.FormatInt(repository.ID, 10), strconv.Itoa(pr.Number)
	labels := []string{}
	for _, label := range pr.Labels {
		labels = append(labels, label.Name)
	}
	base := firstNonEmpty(pr.Base.Ref, repository.DefaultBranch)
	event := automation.Event{Family: automation.Merged, SemanticKey: "pr:" + repo + ":" + number, RepositoryID: repo, RepositoryName: repository.FullName, ObjectID: number, Number: pr.Number, OccurredAt: *pr.MergedAt, Origin: "historical", Title: releasenotes.Clean(pr.Title, 160), Notes: releasenotes.Clean(pr.Body, MaxChangeBodyRunes), URL: pr.HTMLURL, DefaultBranch: repository.DefaultBranch,
		Fields: map[string]automation.Value{"repository.id": automation.StringValue(repo), "repository.name": automation.StringValue(repository.FullName), "event.family": automation.StringValue(string(automation.Merged)), "event.action": automation.StringValue("closed"), "pr.number": automation.StringValue(number), "pr.title": automation.StringValue(releasenotes.Clean(pr.Title, 160)), "pr.base": automation.StringValue(base), "pr.author": automation.StringValue(pr.User.Login), "pr.bot": automation.BoolValue(pr.User.Type == "Bot"), "pr.labels": automation.StringValue(labels...), "pr.files": {State: "pending"}}}
	if pr.UpdatedAt != nil && !pr.UpdatedAt.IsZero() {
		event.SourceUpdatedAt = pr.UpdatedAt
	}
	return c.recordHistoricalEvent(ctx, source, event)
}

func (c *Configuration) recordHistoricalEvent(ctx context.Context, source *ent.SourceApp, event automation.Event) error {
	if err := automation.ValidateEvent(event); err != nil {
		return ErrInvalidInput
	}
	_, err := c.acceptGitHubEvent(ctx, "backfill:"+source.ID, event, []*WebhookSource{webhookSource(source)}, nil)
	return err
}

func (c *Configuration) recordHistoricalReleaseOutput(ctx context.Context, org, sourceID, semanticKey, releaseID string) error {
	event, err := c.client.ReleaseSourceEvent.Query().Where(releasesourceevent.OrganizationID(org), releasesourceevent.SourceAppID(sourceID), releasesourceevent.SemanticKey(semanticKey)).Only(ctx)
	if err != nil {
		return err
	}
	if event.Snapshot.Origin != "historical" {
		return nil
	}
	_, err = c.client.ReleaseAutomationRun.Update().Where(releaseautomationrun.OrganizationID(org), releaseautomationrun.EventID(event.ID), releaseautomationrun.Status("skipped")).SetOutputs(automation.Outputs{ReleaseID: releaseID}).Save(ctx)
	return err
}
