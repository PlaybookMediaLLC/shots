package product

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/githubinstallstart"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/sourceapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspacegithubinstallation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/activity"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// ErrGitHubUnavailable means the GitHub App is not configured or GitHub failed.
var ErrGitHubUnavailable = errors.New("GitHub is unavailable")

// GitHubApp is what the product needs from the platform's GitHub App.
type GitHubApp interface {
	ExchangeCode(ctx context.Context, code string) (string, error)
	UserInstallations(ctx context.Context, userToken string) ([]githubapp.Installation, error)
	Installation(ctx context.Context, installationID int64) (githubapp.Installation, error)
	Repositories(ctx context.Context, installationID int64) ([]githubapp.Repository, error)
}

// WithGitHubApp enables connecting GitHub App installations.
func (c *Configuration) WithGitHubApp(app GitHubApp) *Configuration {
	c.github = app
	return c
}

const githubInstallStartTTL = time.Hour

// GitHubChoiceRequiredError means the user can reach several installations
// the workspace has not linked; they pick one of Choices to finish.
type GitHubChoiceRequiredError struct{ Choices []githubapp.Installation }

func (e *GitHubChoiceRequiredError) Error() string { return "choose a GitHub installation to link" }

// GitHubInstallationLink is an installation a workspace may watch repositories from.
type GitHubInstallationLink struct {
	AccountLogin        string    `json:"accountLogin"`
	AccountType         string    `json:"accountType"`
	CreatedAt           time.Time `json:"createdAt"`
	ID                  string    `json:"id"`
	InstallationID      int64     `json:"installationId"`
	RepositorySelection string    `json:"repositorySelection"`
	Status              string    `json:"status"`
}

func (c *Configuration) authorizeGitHubAdmin(ctx context.Context, actor Actor) error {
	if !actor.IsSession() || actor.UserID == "" || actor.SessionID == "" {
		return publishing.ErrForbidden
	}
	if c.github == nil {
		return ErrGitHubUnavailable
	}
	return c.authorizeRoles(ctx, actor, "owner", "admin")
}

// StartGitHubInstall begins connecting an installation to the actor's
// workspace. The returned state ties GitHub's return trip to this user,
// session, and workspace, and can be used once within the hour.
func (c *Configuration) StartGitHubInstall(ctx context.Context, actor Actor) (string, error) {
	if err := c.authorizeGitHubAdmin(ctx, actor); err != nil {
		return "", err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(random)
	_, err := c.client.GitHubInstallStart.Create().SetID(state).SetOrganizationID(actor.OrganizationID).
		SetUserID(actor.UserID).SetSessionID(actor.SessionID).SetExpiresAt(time.Now().Add(githubInstallStartTTL)).Save(ctx)
	return state, err
}

// CompleteGitHubInstall links an installation to the workspace once the
// user's own GitHub authorization shows they can access it. It finishes three
// ways: a code and the installation GitHub just installed (only a hint until
// verified); a code alone, for an installation the user already has, linked
// when it is the only one the workspace lacks; or, after that found several,
// the installation the user picked from the ones the code verified.
func (c *Configuration) CompleteGitHubInstall(ctx context.Context, actor Actor, state, code string, installationID int64) (*GitHubInstallationLink, error) {
	if err := c.authorizeGitHubAdmin(ctx, actor); err != nil {
		return nil, err
	}
	if state == "" || installationID < 0 || (code == "" && installationID == 0) {
		return nil, ErrInvalidInput
	}
	start, err := c.client.GitHubInstallStart.Query().Where(githubinstallstart.ID(state),
		githubinstallstart.OrganizationID(actor.OrganizationID), githubinstallstart.UserID(actor.UserID),
		githubinstallstart.SessionID(actor.SessionID), githubinstallstart.ExpiresAtGT(time.Now())).Only(ctx)
	if err != nil {
		return nil, errors.Join(publishing.ErrForbidden, ent.MaskNotFound(err))
	}
	if code == "" {
		if !slices.Contains(start.InstallationIds, installationID) {
			return nil, publishing.ErrForbidden
		}
	} else {
		userToken, err := c.github.ExchangeCode(ctx, code)
		if err != nil {
			return nil, publishing.ErrForbidden
		}
		reachable, err := c.github.UserInstallations(ctx, userToken)
		if err != nil {
			return nil, ErrGitHubUnavailable
		}
		if installationID == 0 {
			if installationID, err = c.chooseGitHubInstallation(ctx, actor, start, reachable); err != nil {
				return nil, err
			}
		} else if !slices.ContainsFunc(reachable, func(item githubapp.Installation) bool { return item.ID == installationID }) {
			return nil, publishing.ErrForbidden
		}
	}
	installation, err := c.github.Installation(ctx, installationID)
	if err != nil {
		return nil, ErrGitHubUnavailable
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// The grant is single-use: deleting it is the claim.
	claimed, err := tx.GitHubInstallStart.Delete().Where(githubinstallstart.ID(state),
		githubinstallstart.OrganizationID(actor.OrganizationID), githubinstallstart.UserID(actor.UserID),
		githubinstallstart.SessionID(actor.SessionID), githubinstallstart.ExpiresAtGT(time.Now())).Exec(ctx)
	if err != nil {
		return nil, err
	}
	if claimed != 1 {
		return nil, publishing.ErrForbidden
	}
	row, err := upsertGitHubInstallation(ctx, tx, installation)
	if err != nil {
		return nil, err
	}
	link, err := tx.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.OrganizationID(actor.OrganizationID),
		workspacegithubinstallation.GithubInstallationID(row.ID)).Only(ctx)
	if ent.IsNotFound(err) {
		link, err = tx.WorkspaceGitHubInstallation.Create().SetID(cuid.New()).SetOrganizationID(actor.OrganizationID).
			SetGithubInstallationID(row.ID).SetConnectedByUserID(actor.UserID).Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.github_installation_linked", "github_installation", row.ID,
		map[string]any{"accountLogin": row.AccountLogin, "installationId": row.InstallationID}); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return installationLink(link, row), nil
}

// chooseGitHubInstallation picks the one reachable installation the workspace
// has not linked. With several, the grant keeps them for the user to choose.
func (c *Configuration) chooseGitHubInstallation(ctx context.Context, actor Actor, start *ent.GitHubInstallStart, reachable []githubapp.Installation) (int64, error) {
	linked, err := c.client.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.OrganizationID(actor.OrganizationID)).
		Select(workspacegithubinstallation.FieldGithubInstallationID).Strings(ctx)
	if err != nil {
		return 0, err
	}
	known, err := c.client.GitHubInstallation.Query().Where(githubinstallation.IDIn(linked...)).All(ctx)
	if err != nil {
		return 0, err
	}
	choices := slices.DeleteFunc(slices.Clone(reachable), func(item githubapp.Installation) bool {
		return slices.ContainsFunc(known, func(row *ent.GitHubInstallation) bool { return row.InstallationID == item.ID })
	})
	switch len(choices) {
	case 0:
		return 0, publishing.ErrNotFound
	case 1:
		return choices[0].ID, nil
	}
	ids := make([]int64, len(choices))
	for i, choice := range choices {
		ids[i] = choice.ID
	}
	if err := start.Update().SetInstallationIds(ids).Exec(ctx); err != nil {
		return 0, err
	}
	return 0, &GitHubChoiceRequiredError{Choices: choices}
}

func upsertGitHubInstallation(ctx context.Context, tx *ent.Tx, installation githubapp.Installation) (*ent.GitHubInstallation, error) {
	status := githubinstallation.StatusACTIVE
	if installation.Suspended {
		status = githubinstallation.StatusSUSPENDED
	}
	selection := installation.RepositorySelection
	if selection == "" {
		selection = "selected"
	}
	row, err := tx.GitHubInstallation.Query().Where(githubinstallation.InstallationID(installation.ID)).Only(ctx)
	if ent.IsNotFound(err) {
		return tx.GitHubInstallation.Create().SetID(cuid.New()).SetInstallationID(installation.ID).
			SetAccountLogin(installation.AccountLogin).SetAccountType(installation.AccountType).
			SetRepositorySelection(selection).SetStatus(status).Save(ctx)
	}
	if err != nil {
		return nil, err
	}
	return row.Update().SetAccountLogin(installation.AccountLogin).SetAccountType(installation.AccountType).
		SetRepositorySelection(selection).SetStatus(status).Save(ctx)
}

func installationLink(link *ent.WorkspaceGitHubInstallation, row *ent.GitHubInstallation) *GitHubInstallationLink {
	return &GitHubInstallationLink{AccountLogin: row.AccountLogin, AccountType: row.AccountType, CreatedAt: link.CreatedAt,
		ID: link.ID, InstallationID: row.InstallationID, RepositorySelection: row.RepositorySelection, Status: string(row.Status)}
}

// ListGitHubInstallations lists the installations a workspace has linked.
func (c *Configuration) ListGitHubInstallations(ctx context.Context, organizationID string) ([]GitHubInstallationLink, error) {
	links, err := c.client.WorkspaceGitHubInstallation.Query().
		Where(workspacegithubinstallation.OrganizationID(organizationID)).
		Order(ent.Asc(workspacegithubinstallation.FieldCreatedAt)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]GitHubInstallationLink, 0, len(links))
	for _, link := range links {
		row, err := c.client.GitHubInstallation.Get(ctx, link.GithubInstallationID)
		if err != nil {
			return nil, err
		}
		result = append(result, *installationLink(link, row))
	}
	return result, nil
}

func (c *Configuration) linkedInstallation(ctx context.Context, organizationID, linkID string) (*ent.GitHubInstallation, error) {
	link, err := c.client.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.ID(linkID),
		workspacegithubinstallation.OrganizationID(organizationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c.client.GitHubInstallation.Get(ctx, link.GithubInstallationID)
}

// GitHubRepositories lists what a linked, active installation can read.
func (c *Configuration) GitHubRepositories(ctx context.Context, actor Actor, linkID string) ([]githubapp.Repository, error) {
	if c.github == nil {
		return nil, ErrGitHubUnavailable
	}
	if err := c.AuthorizeRead(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.linkedInstallation(ctx, actor.OrganizationID, linkID)
	if err != nil {
		return nil, err
	}
	if row.Status != githubinstallation.StatusACTIVE {
		return nil, publishing.ErrInvalidState
	}
	repositories, err := c.github.Repositories(ctx, row.InstallationID)
	if err != nil {
		return nil, ErrGitHubUnavailable
	}
	return repositories, nil
}

// UnlinkGitHubInstallation removes an installation from a workspace and
// archives the workspace's sources it delivered. Other workspaces keep theirs.
func (c *Configuration) UnlinkGitHubInstallation(ctx context.Context, actor Actor, linkID string) error {
	if err := c.authorizeGitHubAdmin(ctx, actor); err != nil {
		return err
	}
	row, err := c.linkedInstallation(ctx, actor.OrganizationID, linkID)
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.WorkspaceGitHubInstallation.Delete().Where(workspacegithubinstallation.ID(linkID),
		workspacegithubinstallation.OrganizationID(actor.OrganizationID)).Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.SourceApp.Update().Where(sourceapp.OrganizationID(actor.OrganizationID),
		sourceapp.GithubInstallationID(row.ID), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).
		SetStatus(sourceapp.StatusARCHIVED).Save(ctx); err != nil {
		return err
	}
	sources, err := tx.SourceApp.Query().Where(sourceapp.OrganizationID(actor.OrganizationID), sourceapp.GithubInstallationID(row.ID)).All(ctx)
	if err != nil {
		return err
	}
	for _, source := range sources {
		if err := cancelAutomationRuns(ctx, tx, source.OrganizationID, source.ID, nil); err != nil {
			return err
		}
	}
	if err := appendConfigurationAudit(ctx, tx, actor, "product.github_installation_unlinked", "github_installation", row.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// currentGitHubInstallation reads an installation as GitHub reports it now. A
// signed lifecycle event may be late or replayed (the signature does not cover
// its delivery ID or date it), so GitHub, not the event, decides its status.
func (c *Configuration) currentGitHubInstallation(ctx context.Context, installationID int64) (githubapp.Installation, error) {
	if c.github == nil {
		return githubapp.Installation{}, ErrGitHubUnavailable
	}
	current, err := c.github.Installation(ctx, installationID)
	if err != nil {
		return githubapp.Installation{}, ErrGitHubUnavailable
	}
	return current, nil
}

// RecordGitHubInstallation keeps an installation current after a lifecycle
// event, recording what GitHub reports now rather than the event's snapshot;
// it writes nothing when GitHub cannot be read. It never links a workspace:
// only a verified install does that.
func (c *Configuration) RecordGitHubInstallation(ctx context.Context, installation githubapp.Installation) error {
	current, err := c.currentGitHubInstallation(ctx, installation.ID)
	if err != nil {
		return err
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := upsertGitHubInstallation(ctx, tx, current); err != nil {
		return err
	}
	return tx.Commit()
}

// GitHubInstallationStatus is an installation's state from GitHub's lifecycle events.
type GitHubInstallationStatus string

const (
	GitHubInstallationActive    GitHubInstallationStatus = "ACTIVE"
	GitHubInstallationSuspended GitHubInstallationStatus = "SUSPENDED"
	GitHubInstallationDeleted   GitHubInstallationStatus = "DELETED"
)

// SetGitHubInstallationStatus records a suspension, resumption, or removal.
// A removed installation archives every workspace's sources it delivered.
// A removal is final (GitHub never reuses an installation ID); otherwise the
// status GitHub reports now is recorded, since the event may be old. Only a
// suspension, which restores nothing, applies when GitHub cannot be read.
func (c *Configuration) SetGitHubInstallationStatus(ctx context.Context, installationID int64, status GitHubInstallationStatus) (int, error) {
	if status != GitHubInstallationDeleted {
		current, err := c.currentGitHubInstallation(ctx, installationID)
		switch {
		case err == nil && current.Suspended:
			status = GitHubInstallationSuspended
		case err == nil:
			status = GitHubInstallationActive
		case status != GitHubInstallationSuspended:
			return 0, err
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	row, err := tx.GitHubInstallation.Query().Where(githubinstallation.InstallationID(installationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if row.Status == githubinstallation.StatusDELETED && status != GitHubInstallationDeleted {
		// A removal is final: a late suspension cannot change it.
		return 0, nil
	}
	if _, err := row.Update().SetStatus(githubinstallation.Status(status)).Save(ctx); err != nil {
		return 0, err
	}
	var archived []*ent.SourceApp
	if status == GitHubInstallationDeleted {
		archived, err = archiveGitHubSources(ctx, tx, row.ID, nil, "github_access_removed")
		if err != nil {
			return 0, err
		}
	}
	if status == GitHubInstallationSuspended {
		sources, err := tx.SourceApp.Query().Where(sourceapp.GithubInstallationID(row.ID)).All(ctx)
		if err != nil {
			return 0, err
		}
		for _, source := range sources {
			if err := cancelAutomationRuns(ctx, tx, source.OrganizationID, source.ID, nil); err != nil {
				return 0, err
			}
			if err := cancelSuspendedCaptureJobs(ctx, tx, source.OrganizationID, source.ID); err != nil {
				return 0, err
			}
		}
	}
	return len(archived), tx.Commit()
}

// RemoveGitHubRepositories archives every workspace's sources for repositories
// an installation can no longer read.
func (c *Configuration) RemoveGitHubRepositories(ctx context.Context, installationID int64, repositoryIDs []string) (int, error) {
	if len(repositoryIDs) == 0 {
		return 0, nil
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	row, err := tx.GitHubInstallation.Query().Where(githubinstallation.InstallationID(installationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	archived, err := archiveGitHubSources(ctx, tx, row.ID, repositoryIDs, "github_access_removed")
	if err != nil {
		return 0, err
	}
	return len(archived), tx.Commit()
}

// transferGitHubRepository handles a repository moving to another account.
// GitHub sends the event only to the new owner's installation, so a source
// still bound to the old one would stop hearing from it without a sign. Such
// sources are archived for a person to reconnect, which the workspace is told.
func (c *Configuration) transferGitHubRepository(ctx context.Context, delivery string, body []byte) (*GitHubEventAcceptance, error) {
	var payload struct {
		Action       string `json:"action"`
		Installation struct {
			ID int64 `json:"id"`
		} `json:"installation"`
		Repository struct {
			ID int64 `json:"id"`
		} `json:"repository"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Repository.ID <= 0 {
		return nil, ErrInvalidInput
	}
	result := &GitHubEventAcceptance{}
	if payload.Action != "transferred" {
		return result, nil
	}
	repository := strconv.FormatInt(payload.Repository.ID, 10)
	installations, err := c.client.SourceApp.Query().Where(sourceapp.Provider("github"), sourceapp.ExternalID(repository), sourceapp.StatusEQ(sourceapp.StatusACTIVE),
		sourceapp.GithubInstallationIDNotNil()).Unique(true).Select(sourceapp.FieldGithubInstallationID).Strings(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range installations {
		row, err := c.client.GitHubInstallation.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		if row.InstallationID == payload.Installation.ID {
			continue
		}
		// The signature does not date the event: GitHub, not a replay, decides.
		// An old installation that still reads the repository keeps it.
		if reader, ok := c.github.(GitHubReader); ok && row.Status == githubinstallation.StatusACTIVE {
			if _, err := reader.Repository(ctx, row.InstallationID, repository); err == nil {
				continue
			}
		}
		handled, err := func() (int, error) {
			tx, err := c.client.Tx(ctx)
			if err != nil {
				return 0, err
			}
			defer tx.Rollback()
			archived, err := archiveGitHubSources(ctx, tx, row.ID, []string{repository}, "repository_transferred")
			if err != nil {
				return 0, err
			}
			for _, source := range archived {
				if err := activity.Emit(ctx, tx, source.OrganizationID, "integration.reconnect_required", "source_app", source.ID, "", delivery+":"+source.ID,
					map[string]any{"reason": "repository_transferred"}); err != nil {
					return 0, err
				}
			}
			return len(archived), tx.Commit()
		}()
		if err != nil {
			return nil, err
		}
		result.Handled += handled
	}
	return result, nil
}

// archiveGitHubSources archives an installation's active sources, all of them
// or those for repositoryIDs, and stops their runs; reason goes to the audit.
func archiveGitHubSources(ctx context.Context, tx *ent.Tx, installationRowID string, repositoryIDs []string, reason string) ([]*ent.SourceApp, error) {
	query := tx.SourceApp.Query().Where(sourceapp.GithubInstallationID(installationRowID), sourceapp.StatusEQ(sourceapp.StatusACTIVE))
	if repositoryIDs != nil {
		query.Where(sourceapp.ExternalIDIn(repositoryIDs...))
	}
	sources, err := query.All(ctx)
	if err != nil {
		return nil, err
	}
	for _, source := range sources {
		if _, err := source.Update().SetStatus(sourceapp.StatusARCHIVED).Save(ctx); err != nil {
			return nil, err
		}
		if err := cancelAutomationRuns(ctx, tx, source.OrganizationID, source.ID, nil); err != nil {
			return nil, err
		}
		actor := Actor{OrganizationID: source.OrganizationID, Kind: "service", Display: "github"}
		if err := appendConfigurationAudit(ctx, tx, actor, "product.source_app_archived", "source_app", source.ID,
			map[string]any{"reason": reason}); err != nil {
			return nil, err
		}
	}
	return sources, nil
}

// GitHubSources lists every workspace's active source for a repository that
// an installation delivers, for fanning one App webhook out. A workspace that
// unlinked the installation, or a suspended one, receives nothing.
func (c *Configuration) GitHubSources(ctx context.Context, installationID int64, repositoryID string) ([]*WebhookSource, error) {
	row, err := c.client.GitHubInstallation.Query().Where(githubinstallation.InstallationID(installationID)).Only(ctx)
	if ent.IsNotFound(err) {
		return []*WebhookSource{}, nil
	}
	if err != nil {
		return nil, err
	}
	if row.Status != githubinstallation.StatusACTIVE {
		return []*WebhookSource{}, nil
	}
	sources, err := c.client.SourceApp.Query().Where(sourceapp.GithubInstallationID(row.ID),
		sourceapp.Provider("github"), sourceapp.ExternalID(repositoryID), sourceapp.StatusEQ(sourceapp.StatusACTIVE)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := []*WebhookSource{}
	for _, source := range sources {
		linked, err := c.client.WorkspaceGitHubInstallation.Query().Where(
			workspacegithubinstallation.OrganizationID(source.OrganizationID),
			workspacegithubinstallation.GithubInstallationID(row.ID)).Exist(ctx)
		if err != nil {
			return nil, err
		}
		if linked {
			result = append(result, webhookSource(source))
		}
	}
	return result, nil
}

// checkGitHubSource confirms a workspace may create a source on a linked,
// active installation for a repository that installation can read.
func (c *Configuration) checkGitHubSource(ctx context.Context, organizationID, installationRowID, repositoryID string) error {
	if c.github == nil {
		return ErrGitHubUnavailable
	}
	linked, err := c.client.WorkspaceGitHubInstallation.Query().Where(workspacegithubinstallation.OrganizationID(organizationID),
		workspacegithubinstallation.GithubInstallationID(installationRowID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !linked {
		return publishing.ErrForbidden
	}
	row, err := c.client.GitHubInstallation.Get(ctx, installationRowID)
	if err != nil {
		return err
	}
	if row.Status != githubinstallation.StatusACTIVE {
		return publishing.ErrInvalidState
	}
	repositories, err := c.github.Repositories(ctx, row.InstallationID)
	if err != nil {
		return ErrGitHubUnavailable
	}
	for _, repository := range repositories {
		if strconv.FormatInt(repository.ID, 10) == repositoryID {
			return nil
		}
	}
	return publishing.ErrForbidden
}
