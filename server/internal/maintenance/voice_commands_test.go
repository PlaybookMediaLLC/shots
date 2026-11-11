package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

type voiceCommandSweeper struct {
	reviewEvents
	swept int
}

func (s *voiceCommandSweeper) SweepVoiceCommands(context.Context) (int, error) {
	s.swept++
	return 3, nil
}

func TestVoiceCommandsJobRunsTheProductSweep(t *testing.T) {
	sweeper := &voiceCommandSweeper{}
	if n, err := (&Store{Events: sweeper}).VoiceCommands(context.Background()); err != nil || n != 3 || sweeper.swept != 1 {
		t.Fatalf("n=%d err=%v swept=%d", n, err, sweeper.swept)
	}
	// Events without the sweep, as in a process with no product domain, do nothing.
	if n, err := (&Store{Events: &reviewEvents{}}).VoiceCommands(context.Background()); err != nil || n != 0 {
		t.Fatalf("no sweeper n=%d err=%v", n, err)
	}
	// The job is registered: it reaches the database lock instead of being unknown.
	db, err := sql.Open("pgx", "postgres://localhost/unused")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (&Store{DB: db, Events: sweeper}).Run(ctx, "voice-commands"); !errors.Is(err, context.Canceled) {
		t.Fatalf("voice-commands job err=%v", err)
	}
}
