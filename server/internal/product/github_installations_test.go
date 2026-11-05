package product

import (
	"context"
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
)

// downGitHub is a GitHub App whose installation lookup fails.
type downGitHub struct{ fakeGitHub }

func (downGitHub) Installation(context.Context, int64) (githubapp.Installation, error) {
	return githubapp.Installation{}, errors.New("github returned 502")
}

// An event that would restore an installation's access fails closed when
// GitHub cannot confirm its current state. The configuration has no database,
// so any write would panic.
func TestRestoringInstallationEventsNeedGitHubsCurrentState(t *testing.T) {
	ctx := context.Background()
	snapshot := githubapp.Installation{ID: 7, AccountLogin: "acme", AccountType: "Organization"}
	for name, repo := range map[string]*Configuration{
		"no App":      NewConfiguration(nil),
		"GitHub down": NewConfiguration(nil).WithGitHubApp(downGitHub{}),
	} {
		if err := repo.RecordGitHubInstallation(ctx, snapshot); !errors.Is(err, ErrGitHubUnavailable) {
			t.Errorf("%s: created event err=%v", name, err)
		}
		if _, err := repo.SetGitHubInstallationStatus(ctx, 7, GitHubInstallationActive); !errors.Is(err, ErrGitHubUnavailable) {
			t.Errorf("%s: resumption err=%v", name, err)
		}
	}
}
