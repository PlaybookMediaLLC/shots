package maintenance

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// The product domain is what the worker and the ledger replay pass as Events.
var (
	_ ProductEvents         = (*product.Configuration)(nil)
	_ voiceSweeper          = (*product.Configuration)(nil)
	_ VoiceCommandSweeper   = (*product.Configuration)(nil)
	_ voiceDeletionReplayer = (*product.Configuration)(nil)
)

type voiceReplays struct {
	reviewEvents
	replayed []string
}

func (r *voiceReplays) ReplayVoiceDeletion(_ context.Context, kind, organizationID, id string) (bool, error) {
	r.replayed = append(r.replayed, kind+":"+organizationID+":"+id)
	return id != "gone", nil
}

// Voice ledger entries requested after the restore point go to the voice
// domain, and count when it deleted something again.
func TestReplayDeletionsHandsVoiceEntriesToTheVoiceDomain(t *testing.T) {
	restoredTo := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	records := []DeletionRecord{
		{Kind: "voice_note", OrganizationID: "a", ID: "note", EventID: "e1", RequestedAt: restoredTo.Add(time.Minute)},
		{Kind: "voice_audio", OrganizationID: "a", ID: "note", EventID: "e2", RequestedAt: restoredTo},
		{Kind: "voice_transcript", OrganizationID: "a", ID: "gone", EventID: "e3", RequestedAt: restoredTo.Add(time.Hour)},
	}
	replays := &voiceReplays{}
	if n, err := (&Store{Events: replays}).ReplayDeletions(context.Background(), records, restoredTo); err != nil || n != 1 ||
		strings.Join(replays.replayed, ",") != "voice_note:a:note,voice_transcript:a:gone" {
		t.Fatalf("replayed %d %v err=%v", n, replays.replayed, err)
	}
	if _, err := (&Store{Events: &reviewEvents{}}).ReplayDeletions(context.Background(), records, restoredTo); err == nil {
		t.Fatal("a voice entry was skipped without the voice domain")
	}
}
