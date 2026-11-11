package product

import (
	"errors"
	"fmt"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"sync"
	"testing"
)

func TestFounderHubSettingsArePrivateVersionedAndDeviceScoped(t *testing.T) {
	w := newTestWorkspace(t)
	w.addMember(t, "viewer", "viewer")
	w.owner.OrganizationID = ""
	input := FounderHubSettingsUpdate{DeviceID: "desktop-a", DeviceName: "Mac", BaseVersion: ptr(0), Values: map[string]any{"autostart": true, "spoken_languages": "[\"fr\"]"}}
	saved, err := w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input)
	if err != nil || saved.Version != 1 {
		t.Fatalf("save: %v %v", saved, err)
	}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("stale write accepted: %v", err)
	}
	input.BaseVersion = ptr(1)
	input.Values = map[string]any{"autostart": nil}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); err != nil {
		t.Fatal(err)
	}
	profiles, err := w.repo.ListFounderHubSettings(w.ctx, w.owner)
	if err != nil || len(profiles) != 1 || profiles[0].Values["autostart"] != nil || profiles[0].Values["spoken_languages"] != "[\"fr\"]" {
		t.Fatalf("persisted patch: %v %v", profiles, err)
	}
	other, err := w.repo.ListFounderHubSettings(w.ctx, w.actor("viewer"))
	if err != nil || len(other) != 0 {
		t.Fatalf("cross-user leak: %v %v", other, err)
	}
	input.BaseVersion = ptr(0)
	input.DeviceID = "desktop-b"
	input.Values = map[string]any{"autostart": false}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); err != nil {
		t.Fatal(err)
	}
	input.Values = map[string]any{"theme": "dark"}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("account setting accepted as device setting", err)
	}
	input.DeviceID = ""
	input.Values = map[string]any{"unknown": true}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("unknown setting accepted", err)
	}
	input.Values = map[string]any{"theme": "dark"}
	if _, err = w.repo.UpdateFounderHubSettings(w.ctx, w.owner, input); err != nil {
		t.Fatal(err)
	}
	actor := w.owner
	actor.SessionID = "revoked-session"
	if _, err = w.repo.ListFounderHubSettings(w.ctx, actor); !errors.Is(err, publishing.ErrUnauthorized) {
		t.Fatal("invalid session accepted", err)
	}
}

func TestFounderHubDeviceProfilesCannotExceedLimitDuringConcurrentFirstSync(t *testing.T) {
	w := newTestWorkspace(t)
	for i := range 99 {
		if _, err := w.repo.client.PlatformFounderHubSettings.Create().SetID(fmt.Sprintf("%s-profile-%d", w.id, i)).SetUserID(w.owner.UserID).SetDeviceID(fmt.Sprintf("desktop-%d", i)).SetValues(map[string]any{}).Save(w.ctx); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	accepted := make(chan bool, 3)
	for i := range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := w.repo.UpdateFounderHubSettings(w.ctx, w.owner, FounderHubSettingsUpdate{DeviceID: fmt.Sprintf("new-%d", i), BaseVersion: ptr(0), Values: map[string]any{"autostart": true}})
			if err != nil && !errors.Is(err, publishing.ErrConflict) {
				t.Error(err)
			}
			accepted <- err == nil
		}()
	}
	wg.Wait()
	close(accepted)
	count := 0
	for ok := range accepted {
		if ok {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("concurrent first syncs accepted %d profiles beyond 99", count)
	}
	if _, err := w.repo.UpdateFounderHubSettings(w.ctx, w.owner, FounderHubSettingsUpdate{BaseVersion: ptr(0), Values: map[string]any{"theme": "dark"}}); err != nil {
		t.Fatalf("device limit blocked account preferences: %v", err)
	}
	if _, err := w.repo.UpdateFounderHubSettings(w.ctx, w.owner, FounderHubSettingsUpdate{DeviceID: "desktop-0", BaseVersion: ptr(1), Values: map[string]any{"autostart": false}}); err != nil {
		t.Fatalf("device limit blocked an existing profile: %v", err)
	}
}
