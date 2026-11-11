package product

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/platformfounderhubsettings"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent/workspaceentitlement"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/founderhub"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/lucsky/cuid"
)

type FounderHubSettings struct {
	DeviceID   string         `json:"deviceId"`
	DeviceName string         `json:"deviceName"`
	Values     map[string]any `json:"values"`
	Version    int            `json:"version"`
	UpdatedAt  time.Time      `json:"updatedAt"`
}

type FounderHubSettingsUpdate struct {
	Native      bool           `json:"-"`
	DeviceID    string         `json:"deviceId"`
	DeviceName  string         `json:"deviceName"`
	Values      map[string]any `json:"values"`
	BaseVersion *int           `json:"baseVersion"`
}

var founderHubDeviceID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,160}$`)

type FounderHubSettingsWorkspace struct {
	Name     string          `json:"name"`
	Features map[string]bool `json:"features"`
}
type FounderHubSettingsAccount struct {
	Workspaces []FounderHubSettingsWorkspace `json:"workspaces"`
}

func (c *Configuration) GetFounderHubSettingsAccount(ctx context.Context, actor Actor) (*FounderHubSettingsAccount, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	memberships, err := c.ListWorkspaces(ctx, actor)
	if err != nil {
		return nil, err
	}
	result := &FounderHubSettingsAccount{Workspaces: []FounderHubSettingsWorkspace{}}
	for _, membership := range memberships {
		if membership.IsScheduledForDeletion {
			continue
		}
		denied, err := deniedPermissions(ctx, c.client, membership.ID, actor.UserID, membership.Role)
		if err != nil {
			return nil, err
		}
		if !slices.Contains(founderHubPermissions(membership.Role, denied), "workspace:read") {
			continue
		}
		entitlement, err := c.client.WorkspaceEntitlement.Query().Where(workspaceentitlement.ID(membership.ID)).Only(ctx)
		if err != nil && !ent.IsNotFound(err) {
			return nil, err
		}
		_, _, features := evaluateBootstrapEntitlement(entitlement, time.Now())
		result.Workspaces = append(result.Workspaces, FounderHubSettingsWorkspace{Name: membership.Name, Features: features})
	}
	return result, nil
}

func founderHubSettingsRecord(row *ent.PlatformFounderHubSettings) FounderHubSettings {
	return FounderHubSettings{DeviceID: row.DeviceID, DeviceName: row.DeviceName, Values: row.Values, Version: row.Version, UpdatedAt: row.UpdatedAt}
}

func (c *Configuration) ListFounderHubSettings(ctx context.Context, actor Actor) ([]FounderHubSettings, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	rows, err := c.client.PlatformFounderHubSettings.Query().Where(platformfounderhubsettings.UserID(actor.UserID)).Order(ent.Asc(platformfounderhubsettings.FieldDeviceID)).All(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]FounderHubSettings, 0, len(rows))
	for _, row := range rows {
		result = append(result, founderHubSettingsRecord(row))
	}
	return result, nil
}

func (c *Configuration) UpdateFounderHubSettings(ctx context.Context, actor Actor, input FounderHubSettingsUpdate) (*FounderHubSettings, error) {
	if !actor.IsSession() {
		return nil, publishing.ErrForbidden
	}
	if err := c.AuthorizeSession(ctx, actor); err != nil {
		return nil, err
	}
	if input.BaseVersion == nil || *input.BaseVersion < 0 || len(input.DeviceName) > 200 || input.Values == nil || input.DeviceID != "" && !founderHubDeviceID.MatchString(input.DeviceID) {
		return nil, ErrInvalidInput
	}
	if err := founderhub.Validate(input.Values, input.DeviceID); err != nil {
		return nil, ErrInvalidInput
	}
	if input.Native {
		if _, err := c.AuthorizeFounderHubSession(ctx, actor); err != nil {
			return nil, err
		}
	} else if founderhub.RequiresNativeWrite(input.Values) {
		return nil, publishing.ErrForbidden
	}
	row, err := c.client.PlatformFounderHubSettings.Query().Where(platformfounderhubsettings.UserID(actor.UserID), platformfounderhubsettings.DeviceID(input.DeviceID)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	version := 0
	values := map[string]any{}
	if row != nil {
		version, values = row.Version, row.Values
	}
	if version != *input.BaseVersion {
		return nil, publishing.ErrConflict
	}
	for key, value := range input.Values {
		if value == nil {
			delete(values, key)
		} else {
			values[key] = value
		}
	}
	encoded, err := json.Marshal(values)
	if err != nil || len(encoded) > 1048576 {
		return nil, ErrInvalidInput
	}
	if row == nil {
		tx, txErr := c.client.Tx(ctx)
		if txErr != nil {
			return nil, txErr
		}
		defer tx.Rollback()
		// Serialize new profiles so concurrent first syncs cannot bypass the device limit.
		if _, err := tx.PlatformExec(ctx, `SELECT id FROM "user" WHERE id=$1 FOR UPDATE`, actor.UserID); err != nil {
			return nil, err
		}
		if input.DeviceID != "" {
			count, err := tx.Client().PlatformFounderHubSettings.Query().Where(platformfounderhubsettings.UserID(actor.UserID), platformfounderhubsettings.DeviceIDNEQ("")).Count(ctx)
			if err != nil {
				return nil, err
			}
			if count >= 100 {
				return nil, publishing.ErrConflict
			}
		}
		row, err = tx.Client().PlatformFounderHubSettings.Create().SetID(cuid.New()).SetUserID(actor.UserID).SetDeviceID(input.DeviceID).SetDeviceName(input.DeviceName).SetValues(values).Save(ctx)
		if ent.IsConstraintError(err) {
			return nil, publishing.ErrConflict
		}
		if err == nil {
			err = tx.Commit()
		}
	} else {
		updated, updateErr := c.client.PlatformFounderHubSettings.Update().Where(platformfounderhubsettings.ID(row.ID), platformfounderhubsettings.UserID(actor.UserID), platformfounderhubsettings.Version(version)).SetDeviceName(input.DeviceName).SetValues(values).AddVersion(1).Save(ctx)
		if updateErr != nil {
			return nil, updateErr
		}
		if updated == 0 {
			return nil, publishing.ErrConflict
		}
		row, err = c.client.PlatformFounderHubSettings.Get(ctx, row.ID)
	}
	if err != nil {
		return nil, err
	}
	result := founderHubSettingsRecord(row)
	return &result, nil
}
