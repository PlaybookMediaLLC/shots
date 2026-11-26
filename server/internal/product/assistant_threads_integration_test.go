package product

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

func TestAssistantThreadsStayPrivateAndBounded(t *testing.T) {
	w := newTestWorkspace(t)
	w.addMember(t, "viewer", "viewer")
	viewer := w.actor("viewer")
	input := SaveAssistantThreadInput{Title: "Launch hero", Entries: json.RawMessage(`[{"kind":"user","text":"hi"}]`)}

	saved, err := w.repo.SaveAssistantThread(w.ctx, w.owner, "thread-1", input)
	if err != nil || saved.Title != "Launch hero" || len(saved.Entries) == 0 {
		t.Fatal("create", saved, err)
	}
	input.Title = "Renamed"
	if saved, err = w.repo.SaveAssistantThread(w.ctx, w.owner, "thread-1", input); err != nil || saved.Title != "Renamed" {
		t.Fatal("replace", saved, err)
	}

	// Another member of the same workspace cannot read or replace it.
	if _, err := w.repo.GetAssistantThread(w.ctx, viewer, "thread-1"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("read", err)
	}
	if _, err := w.repo.SaveAssistantThread(w.ctx, viewer, "thread-1", input); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("overwrite", err)
	}
	if err := w.repo.DeleteAssistantThread(w.ctx, viewer, "thread-1"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("delete another's", err)
	}
	if items, err := w.repo.ListAssistantThreads(w.ctx, viewer); err != nil || len(items) != 0 {
		t.Fatal("list", items, err)
	}

	if _, err := w.repo.SaveAssistantThread(w.ctx, w.owner, "gone", input); err != nil {
		t.Fatal(err)
	}
	if err := w.repo.DeleteAssistantThread(w.ctx, w.owner, "gone"); err != nil {
		t.Fatal("delete own", err)
	}
	if _, err := w.repo.GetAssistantThread(w.ctx, w.owner, "gone"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("deleted thread remains", err)
	}

	for _, entries := range []string{`[]`, `{}`, `[1]`, `"x"`} {
		bad := SaveAssistantThreadInput{Title: "x", Entries: json.RawMessage(entries)}
		if _, err := w.repo.SaveAssistantThread(w.ctx, w.owner, "thread-bad", bad); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("accepted %s: %v", entries, err)
		}
	}

	for n := range assistantThreadsKept + 2 {
		if _, err := w.repo.SaveAssistantThread(w.ctx, w.owner, fmt.Sprintf("more-%d", n), input); err != nil {
			t.Fatal(err)
		}
	}
	items, err := w.repo.ListAssistantThreads(w.ctx, w.owner)
	if err != nil || len(items) != assistantThreadsKept || len(items[0].Entries) != 0 {
		t.Fatal("kept", len(items), err)
	}
	if _, err := w.repo.GetAssistantThread(w.ctx, w.owner, "thread-1"); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatal("the oldest thread was kept", err)
	}
}
