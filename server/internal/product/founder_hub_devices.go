package product

import (
	"context"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	d "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformfounderhubdevice"
	cmd "github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformfounderhubdevicecommand"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
	"time"
)

type FounderHubDevice struct {
	DeviceID   string                  `json:"deviceId"`
	Name       string                  `json:"name"`
	Report     founderhub.DeviceReport `json:"report"`
	ReportedAt time.Time               `json:"reportedAt"`
}
type FounderHubDeviceReportInput struct {
	DeviceID string                  `json:"deviceId"`
	Name     string                  `json:"name"`
	Report   founderhub.DeviceReport `json:"report"`
}
type FounderHubDeviceCommand struct {
	ID string `json:"id"`
	founderhub.DeviceCommandInput
	Status    string    `json:"status"`
	Error     string    `json:"error"`
	Result    string    `json:"result"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type FounderHubDeviceCommandResult struct {
	DeviceID string `json:"deviceId"`
	Status   string `json:"status"`
	Error    string `json:"error"`
	Result   string `json:"result"`
}

func founderHubCommandRecord(row *ent.PlatformFounderHubDeviceCommand) FounderHubDeviceCommand {
	status := row.Status
	if (status == "pending" || status == "running") && time.Now().After(row.ExpiresAt) {
		status = "expired"
	}
	return FounderHubDeviceCommand{ID: row.ID, DeviceCommandInput: founderhub.DeviceCommandInput{DeviceID: row.DeviceID, Kind: row.Kind, Argument: row.Argument}, Status: status, Error: row.Error, Result: row.Result, ExpiresAt: row.ExpiresAt.UTC()}
}

func (c *Configuration) ListFounderHubDevices(ctx context.Context, actor Actor) ([]FounderHubDevice, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.PlatformFounderHubDevice.Query().Where(d.UserID(actor.UserID)).Order(ent.Asc(d.FieldName)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]FounderHubDevice, 0, len(rows))
	for _, row := range rows {
		result = append(result, FounderHubDevice{DeviceID: row.DeviceID, Name: row.Name, Report: row.Report, ReportedAt: row.ReportedAt})
	}
	return result, nil
}

func (c *Configuration) ReportFounderHubDevice(ctx context.Context, actor Actor, input FounderHubDeviceReportInput) ([]FounderHubDeviceCommand, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if !founderHubDeviceID.MatchString(input.DeviceID) || len(input.Name) > 200 || !input.Report.Valid() {
		return nil, ErrInvalidInput
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Serialize registration so concurrent devices cannot exceed the account limit.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, actor.UserID); err != nil {
		return nil, err
	}
	db := tx.Client()
	row, err := db.PlatformFounderHubDevice.Query().Where(d.UserID(actor.UserID), d.DeviceID(input.DeviceID)).Only(ctx)
	if ent.IsNotFound(err) {
		count, countErr := db.PlatformFounderHubDevice.Query().Where(d.UserID(actor.UserID)).Count(ctx)
		if countErr != nil {
			return nil, countErr
		}
		if count >= 100 {
			return nil, publishing.ErrConflict
		}
		row, err = db.PlatformFounderHubDevice.Create().SetID(cuid.New()).SetUserID(actor.UserID).SetDeviceID(input.DeviceID).SetName(input.Name).SetReport(input.Report).Save(ctx)
		if ent.IsConstraintError(err) {
			row, err = db.PlatformFounderHubDevice.Query().Where(d.UserID(actor.UserID), d.DeviceID(input.DeviceID)).Only(ctx)
		}
	}
	if err != nil {
		return nil, err
	}
	if _, err = db.PlatformFounderHubDevice.UpdateOneID(row.ID).SetName(input.Name).SetReport(input.Report).SetReportedAt(time.Now()).Save(ctx); err != nil {
		return nil, err
	}
	// A lost delivery is never retried: opening OS dialogs twice is not idempotent.
	rows, err := db.PlatformFounderHubDeviceCommand.Query().Where(cmd.UserID(actor.UserID), cmd.DeviceID(input.DeviceID), cmd.Status("pending"), cmd.ExpiresAtGT(time.Now())).Order(ent.Asc(cmd.FieldCreatedAt)).Limit(1).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]FounderHubDeviceCommand, 0, 1)
	for _, command := range rows {
		claimed, err := db.PlatformFounderHubDeviceCommand.Update().Where(cmd.ID(command.ID), cmd.UserID(actor.UserID), cmd.Status("pending"), cmd.ExpiresAtGT(time.Now())).SetStatus("running").Save(ctx)
		if err != nil {
			return nil, err
		}
		if claimed == 1 {
			command.Status = "running"
			result = append(result, founderHubCommandRecord(command))
		}
	}
	if _, err := db.PlatformFounderHubDeviceCommand.Delete().Where(cmd.UserID(actor.UserID), cmd.DeviceID(input.DeviceID), cmd.ExpiresAtLT(time.Now().Add(-24*time.Hour))).Exec(ctx); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (c *Configuration) CreateFounderHubDeviceCommand(ctx context.Context, actor Actor, input founderhub.DeviceCommandInput) (*FounderHubDeviceCommand, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if !founderHubDeviceID.MatchString(input.DeviceID) || !input.Valid() {
		return nil, ErrInvalidInput
	}
	if input.Kind == "auto-format" || input.Kind == "cloudsync-status" || input.Kind == "cloudsync-now" || input.Kind == "cloudsync-log" {
		account, err := c.GetFounderHubSettingsAccount(ctx, actor)
		if err != nil {
			return nil, err
		}
		paid := false
		for _, workspace := range account.Workspaces {
			paid = paid || workspace.Features["workspace:paid"]
		}
		if !paid {
			return nil, publishing.ErrForbidden
		}
	}
	tx, err := c.client.Tx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Hold the device lock across the queue limit check and insertion.
	if _, err := tx.PlatformExec(ctx, `SELECT id FROM platform_founder_hub_device WHERE "userId"=$1 AND "deviceId"=$2 FOR UPDATE`, actor.UserID, input.DeviceID); err != nil {
		return nil, err
	}
	db := tx.Client()
	device, err := db.PlatformFounderHubDevice.Query().Where(d.UserID(actor.UserID), d.DeviceID(input.DeviceID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if time.Since(device.ReportedAt) > time.Minute {
		return nil, publishing.ErrConflict
	}
	if (input.Kind == "cloudsync-status" || input.Kind == "cloudsync-now" || input.Kind == "cloudsync-log") && !device.Report.SupportsCloudsyncSettings {
		return nil, publishing.ErrConflict
	}
	if (input.Kind == "auto-format" || input.Kind == "dictation-status" || input.Kind == "cloudsync-log") && device.Report.AutoFormatKey == "" {
		return nil, publishing.ErrConflict
	}
	pending, err := db.PlatformFounderHubDeviceCommand.Query().Where(cmd.UserID(actor.UserID), cmd.DeviceID(input.DeviceID), cmd.StatusIn("pending", "running"), cmd.ExpiresAtGT(time.Now())).Count(ctx)
	if err != nil {
		return nil, err
	}
	if pending >= 4 {
		return nil, publishing.ErrConflict
	}
	row, err := db.PlatformFounderHubDeviceCommand.Create().SetID(cuid.New()).SetUserID(actor.UserID).SetDeviceID(input.DeviceID).SetKind(input.Kind).SetArgument(input.Argument).SetExpiresAt(time.Now().Add(2 * time.Minute)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := founderHubCommandRecord(row)
	return &result, nil
}

func (c *Configuration) GetFounderHubDeviceCommand(ctx context.Context, actor Actor, id string) (*FounderHubDeviceCommand, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	row, err := c.client.PlatformFounderHubDeviceCommand.Query().Where(cmd.ID(id), cmd.UserID(actor.UserID)).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	result := founderHubCommandRecord(row)
	return &result, nil
}

func (c *Configuration) FinishFounderHubDeviceCommand(ctx context.Context, actor Actor, id string, input FounderHubDeviceCommandResult) (*FounderHubDeviceCommand, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if !founderHubDeviceID.MatchString(input.DeviceID) || (input.Status != "succeeded" && input.Status != "failed") || len(input.Error) > 1000 {
		return nil, ErrInvalidInput
	}
	row, err := c.client.PlatformFounderHubDeviceCommand.Query().Where(cmd.ID(id), cmd.UserID(actor.UserID), cmd.DeviceID(input.DeviceID), cmd.Status("running"), cmd.ExpiresAtGT(time.Now())).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, publishing.ErrConflict
	}
	if err != nil {
		return nil, err
	}
	switch row.Kind {
	case "auto-format", "dictation-status", "cloudsync-log":
		if input.Status == "succeeded" && !founderhub.ValidPrivateAction(input.Result, false) {
			return nil, ErrInvalidInput
		}
		if input.Status == "failed" && input.Result != "" {
			return nil, ErrInvalidInput
		}
	case "cloudsync-status":
		if input.Status == "succeeded" && !founderhub.ValidCloudsyncStatusResult(input.Result) {
			return nil, ErrInvalidInput
		}
		if input.Status == "failed" && input.Result != "" {
			return nil, ErrInvalidInput
		}
	default:
		if input.Result != "" {
			return nil, ErrInvalidInput
		}
	}
	updated, err := c.client.PlatformFounderHubDeviceCommand.Update().Where(cmd.ID(row.ID), cmd.Status("running"), cmd.ExpiresAtGT(time.Now())).SetStatus(input.Status).SetError(input.Error).SetResult(input.Result).Save(ctx)
	if err != nil {
		return nil, err
	}
	if updated == 0 {
		return nil, publishing.ErrConflict
	}
	return c.GetFounderHubDeviceCommand(ctx, actor, id)
}
