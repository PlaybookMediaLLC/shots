package product

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/google/uuid"
)

func TestFounderHubSharedLibraryUsesShotsIdentityAndRevocableAccess(t *testing.T) {
	w, guest := newTestWorkspace(t), newTestWorkspace(t)
	var installed bool
	if err := w.db.SQL.QueryRowContext(w.ctx, `SELECT to_regprocedure('founder_hub.list_shared_resources(text)') IS NOT NULL`).Scan(&installed); err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("apply Founder Hub storage and domain migrations before running its integration tests")
	}
	input := FounderHubResourceAction{Action: "publish", ResourceType: "template", SourceID: "private-template", Title: "Review", Payload: json.RawMessage(`{"version":1,"template":{"title":"Review","description":"","category":"","icon":{"type":"emoji","value":"📝"},"targets":[],"sections":[]}}`)}
	if _, err := w.repo.FounderHubResourceAction(w.ctx, w.owner, input); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("unpaid sharing accepted", err)
	}
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	result, err := w.repo.FounderHubResourceAction(w.ctx, w.owner, input)
	if err != nil {
		t.Fatal(err)
	}
	var shares []struct {
		ID uuid.UUID `json:"share_id"`
	}
	if err := json.Unmarshal(result, &shares); err != nil || len(shares) != 1 {
		t.Fatalf("publish: %s %v", result, err)
	}
	shareID := shares[0].ID
	list := FounderHubResourceAction{Action: "list", ResourceType: "template"}
	result, err = guest.repo.FounderHubResourceAction(guest.ctx, guest.owner, list)
	if err != nil || string(result) != "[]" {
		t.Fatalf("private library leaked: %s %v", result, err)
	}
	if _, err := guest.repo.FounderHubResourceAction(guest.ctx, guest.owner, FounderHubResourceAction{Action: "delete", ShareID: &shareID}); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("foreign owner deleted a share", err)
	}
	person, err := guest.repo.GetCurrentUser(guest.ctx, guest.owner)
	if err != nil {
		t.Fatal(err)
	}
	result, err = w.repo.FounderHubResourceAction(w.ctx, w.owner, FounderHubResourceAction{Action: "invite", ShareID: &shareID, Email: person.Email})
	if err != nil {
		t.Fatal(err)
	}
	var grants []struct {
		ID uuid.UUID `json:"guest_id"`
	}
	if err := json.Unmarshal(result, &grants); err != nil || len(grants) != 1 {
		t.Fatalf("grant: %s %v", result, err)
	}
	result, err = guest.repo.FounderHubResourceAction(guest.ctx, guest.owner, list)
	if err != nil {
		t.Fatal(err)
	}
	var resources []struct {
		ID     uuid.UUID `json:"share_id"`
		Access string    `json:"access_kind"`
	}
	if err := json.Unmarshal(result, &resources); err != nil || len(resources) != 1 || resources[0].ID != shareID || resources[0].Access != "guest" {
		t.Fatalf("named guest access: %s %v", result, err)
	}
	if _, err := w.repo.FounderHubResourceAction(w.ctx, w.owner, FounderHubResourceAction{Action: "revoke", GuestID: &grants[0].ID}); err != nil {
		t.Fatal(err)
	}
	result, err = guest.repo.FounderHubResourceAction(guest.ctx, guest.owner, list)
	if err != nil || string(result) != "[]" {
		t.Fatalf("revoked guest retained access: %s %v", result, err)
	}
	w.exec(t, `UPDATE "session" SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, w.owner.SessionID)
	if _, err := w.repo.FounderHubResourceAction(w.ctx, w.owner, list); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatal("expired Shots session accepted", err)
	}
}
