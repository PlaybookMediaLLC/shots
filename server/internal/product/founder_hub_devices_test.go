package product

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"sync"
	"testing"
	"time"
)

func TestFounderHubDeviceCommandsArePrivateAndClaimedOnlyOnce(t *testing.T) {
	expiry := time.Date(2026, 11, 10, 9, 0, 0, 0, time.FixedZone("EST", -5*60*60))
	if got := founderHubCommandRecord(&ent.PlatformFounderHubDeviceCommand{ExpiresAt: expiry}).ExpiresAt.Format(time.RFC3339); got != "2026-11-10T14:00:00Z" {
		t.Fatalf("command expiry must use the SDK's UTC wire format: %s", got)
	}
	w := newTestWorkspace(t)
	w.addMember(t, "viewer", "viewer")
	w.owner.OrganizationID = ""
	report := FounderHubDeviceReportInput{DeviceID: "desktop-a", Name: "Mac", Report: founderhub.DeviceReport{Platform: "macos", Microphones: []string{}, InstalledApps: []founderhub.InstalledApp{}, DefaultIgnoredApps: []string{}, Permissions: map[string]string{"microphone": "authorized"}}}
	if _, err := w.repo.ReportFounderHubDevice(w.ctx, w.owner, report); err != nil {
		t.Fatal(err)
	}
	input := founderhub.DeviceCommandInput{DeviceID: "desktop-a", Kind: "request-permission", Argument: "microphone"}
	if _, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.actor("viewer"), input); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-user request accepted: %v", err)
	}
	invalid := input
	invalid.Kind = "shell"
	invalid.Argument = "arbitrary command"
	if _, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, invalid); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("arbitrary command accepted: %v", err)
	}
	created, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.GetFounderHubDeviceCommand(w.ctx, w.actor("viewer"), created.ID); !errors.Is(err, publishing.ErrNotFound) {
		t.Fatalf("cross-user command visible: %v", err)
	}
	var wg sync.WaitGroup
	claimed := make(chan []FounderHubDeviceCommand, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			commands, err := w.repo.ReportFounderHubDevice(w.ctx, w.owner, report)
			if err != nil {
				t.Error(err)
			}
			claimed <- commands
		}()
	}
	wg.Wait()
	close(claimed)
	count := 0
	for commands := range claimed {
		count += len(commands)
	}
	if count != 1 {
		t.Fatalf("command delivered %d times", count)
	}
	result := FounderHubDeviceCommandResult{DeviceID: "desktop-b", Status: "succeeded"}
	if _, err := w.repo.FinishFounderHubDeviceCommand(w.ctx, w.owner, created.ID, result); !errors.Is(err, publishing.ErrConflict) {
		t.Fatalf("wrong device acknowledged: %v", err)
	}
	result.DeviceID = report.DeviceID
	if _, err := w.repo.FinishFounderHubDeviceCommand(w.ctx, w.owner, created.ID, result); err != nil {
		t.Fatal(err)
	}
	complete, err := w.repo.GetFounderHubDeviceCommand(w.ctx, w.owner, created.ID)
	if err != nil || complete.Status != "succeeded" {
		t.Fatalf("result not persisted: %v %v", complete, err)
	}
	key := base64.StdEncoding.EncodeToString(make([]byte, 65))
	envelope, err := json.Marshal(map[string]string{"publicKey": key, "iv": base64.StdEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	privateInput := founderhub.DeviceCommandInput{DeviceID: input.DeviceID, Kind: "auto-format", Argument: string(envelope)}
	if _, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, privateInput); !errors.Is(err, publishing.ErrForbidden) {
		t.Fatal("unpaid private action accepted", err)
	}
	subscribe(t, w.ctx, w.repo, w.org, "pro")
	if _, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, privateInput); !errors.Is(err, publishing.ErrConflict) {
		t.Fatal("unsupported desktop accepted private action", err)
	}
	report.Report.AutoFormatKey = key
	if _, err := w.repo.ReportFounderHubDevice(w.ctx, w.owner, report); err != nil {
		t.Fatal(err)
	}
	privateCommand, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, privateInput)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.repo.ReportFounderHubDevice(w.ctx, w.owner, report); err != nil {
		t.Fatal(err)
	}
	privateResult := FounderHubDeviceCommandResult{DeviceID: input.DeviceID, Status: "succeeded", Result: "readable example text"}
	if _, err := w.repo.FinishFounderHubDeviceCommand(w.ctx, w.owner, privateCommand.ID, privateResult); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("readable private result accepted", err)
	}
	responseEnvelope, err := json.Marshal(map[string]string{"iv": base64.StdEncoding.EncodeToString(make([]byte, 12)), "ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	privateResult.Result = string(responseEnvelope)
	privateComplete, err := w.repo.FinishFounderHubDeviceCommand(w.ctx, w.owner, privateCommand.ID, privateResult)
	if err != nil || privateComplete.Result != privateResult.Result {
		t.Fatal("encrypted result did not round trip", err)
	}
	expiring, err := w.repo.client.PlatformFounderHubDeviceCommand.Create().SetID(created.ID + "expired").SetUserID(w.owner.UserID).SetDeviceID(input.DeviceID).SetKind(input.Kind).SetArgument(input.Argument).SetExpiresAt(time.Now().Add(-time.Second)).Save(w.ctx)
	if err != nil {
		t.Fatal(err)
	}
	commands, err := w.repo.ReportFounderHubDevice(w.ctx, w.owner, report)
	if err != nil || len(commands) != 0 {
		t.Fatalf("expired command delivered: %v %v", commands, err)
	}
	expired, err := w.repo.GetFounderHubDeviceCommand(w.ctx, w.owner, expiring.ID)
	if err != nil || expired.Status != "expired" {
		t.Fatalf("expiration hidden: %v %v", expired, err)
	}

	queued := make(chan bool, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := w.repo.CreateFounderHubDeviceCommand(w.ctx, w.owner, input)
			if err != nil && !errors.Is(err, publishing.ErrConflict) {
				t.Error(err)
			}
			queued <- err == nil
		}()
	}
	wg.Wait()
	close(queued)
	accepted := 0
	for ok := range queued {
		if ok {
			accepted++
		}
	}
	if accepted != 4 {
		t.Fatalf("concurrent requests exceeded the device queue limit: %d", accepted)
	}
}
