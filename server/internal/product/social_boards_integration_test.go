package product

import (
	"context"
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

// boardReader answers as the tenant publisher does, and records which
// account it was asked for.
type boardReader struct {
	destination, secret string
}

func (*boardReader) AccountStanding(context.Context, string, string, string, string) (AccountStanding, error) {
	return AccountStanding{}, nil
}

func (b *boardReader) PinterestBoards(_ context.Context, _, destination, secret string) ([]PinterestBoard, error) {
	b.destination, b.secret = destination, secret
	return []PinterestBoard{{ID: "1001", Name: "Launch ideas"}}, nil
}

func TestPinterestBoardsAreReadThroughTheSetsOwnAccount(t *testing.T) {
	w := newTestWorkspace(t)
	ctx, repo, owner := w.ctx, w.repo, w.owner
	subscribe(t, ctx, repo, w.org, "pro")
	reader := &boardReader{}
	repo.WithAccountStanding(reader)
	set, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "Pins", Visibility: "PRIVATE"})
	if err != nil {
		t.Fatal(err)
	}
	empty, err := repo.CreateSocialSet(ctx, owner, SocialSetInput{Name: "No Pinterest"})
	if err != nil {
		t.Fatal(err)
	}
	w.db.Client.ChannelConnection.Create().SetID(cuid.New()).SetOrganizationID(w.org).SetPlatform("pinterest").
		SetExternalAccountID("pinterest-account").SetSecretReference("pinterest-secret").SetCreatedByUserID(owner.UserID).
		SetSocialSetID(set.ID).SaveX(ctx)

	boards, err := repo.LookupPinterestBoards(ctx, owner, set.ID)
	if err != nil || len(boards) != 1 || boards[0].ID != "1001" {
		t.Fatalf("boards=%+v err=%v", boards, err)
	}
	if reader.destination != "pinterest-account" || reader.secret != "pinterest-secret" {
		t.Fatalf("read through %q/%q, not the set's own account", reader.destination, reader.secret)
	}
	if _, err := repo.LookupPinterestBoards(ctx, owner, empty.ID); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("a set without Pinterest: %v, want a conflict", err)
	}
	// A member who cannot see the private set, and another workspace, find nothing.
	w.addMember(t, "writer", "creator")
	if _, err := repo.LookupPinterestBoards(ctx, w.actor("writer"), set.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("private set leaked: %v", err)
	}
	stranger := newTestWorkspace(t)
	subscribe(t, ctx, stranger.repo, stranger.org, "pro")
	stranger.repo.WithAccountStanding(reader)
	if _, err := stranger.repo.LookupPinterestBoards(ctx, stranger.owner, set.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("another workspace's set leaked: %v", err)
	}
}
