package founderhub

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"strings"
	"time"
)

type InstalledApp struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type DeviceReport struct {
	Platform                   string            `json:"platform"`
	Version                    string            `json:"version"`
	Identifier                 string            `json:"identifier"`
	Locale                     string            `json:"locale"`
	Timezone                   string            `json:"timezone"`
	AppStore                   bool              `json:"appStore"`
	LockAvailable              bool              `json:"lockAvailable"`
	HomeDirectory              string            `json:"homeDirectory"`
	DownloadsDirectory         string            `json:"downloadsDirectory"`
	Microphones                []string          `json:"microphones"`
	InstalledApps              []InstalledApp    `json:"installedApps"`
	DefaultIgnoredApps         []string          `json:"defaultIgnoredApps"`
	Permissions                map[string]string `json:"permissions"`
	SupportsCloudsyncSettings  bool              `json:"supportsCloudsyncSettings,omitempty"`
	SupportsAIProviderSettings bool              `json:"supportsAIProviderSettings,omitempty"`
	SupportsCloudsyncRecovery  bool              `json:"supportsCloudsyncRecovery,omitempty"`
	SupportsSettingsNavigation bool              `json:"supportsSettingsNavigation,omitempty"`
	AutoFormatKey              string            `json:"autoFormatKey,omitempty"`
}

func (report DeviceReport) Valid() bool {
	if report.AutoFormatKey != "" && !validEncoded(report.AutoFormatKey, 65, 65) {
		return false
	}
	if report.Platform != "macos" && report.Platform != "windows" && report.Platform != "linux" {
		return false
	}
	if len(report.Version) > 100 || len(report.Identifier) > 200 || len(report.Locale) > 100 || len(report.Timezone) > 100 || len(report.HomeDirectory) > 4096 || len(report.DownloadsDirectory) > 4096 || len(report.Microphones) > 256 || len(report.InstalledApps) > 10000 || len(report.DefaultIgnoredApps) > 1000 {
		return false
	}
	for _, value := range report.Microphones {
		if len(value) > 1000 {
			return false
		}
	}
	for _, app := range report.InstalledApps {
		if len(app.ID) > 1000 || len(app.Name) > 1000 {
			return false
		}
	}
	for _, value := range report.DefaultIgnoredApps {
		if len(value) > 1000 {
			return false
		}
	}
	for permission, status := range report.Permissions {
		if !ValidPermission(permission) {
			return false
		}
		if status != "authorized" && status != "denied" && status != "neverRequested" && status != "unknown" {
			return false
		}
	}
	encoded, err := json.Marshal(report)
	return err == nil && len(encoded) <= 1048576
}

func ValidPermission(value string) bool {
	switch value {
	case "microphone", "systemAudio", "accessibility", "calendar", "screenRecording", "reminders", "contacts", "inputMonitoring":
		return true
	}
	return false
}

type DeviceCommandInput struct {
	DeviceID       string `json:"deviceId"`
	ExpectedUserID string `json:"expectedUserId,omitempty"`
	Kind           string `json:"kind"`
	Argument       string `json:"argument"`
}

type CloudsyncStatusResult struct {
	CloudsyncEnabled     *bool   `json:"cloudsync_enabled"`
	Configured           *bool   `json:"configured"`
	Running              *bool   `json:"running"`
	ActivityPaused       *bool   `json:"activity_paused"`
	DeferredForCapture   *bool   `json:"deferred_for_capture"`
	LastSyncAtMS         *int64  `json:"last_sync_at_ms"`
	HasUnsentChanges     *bool   `json:"has_unsent_changes"`
	LastErrorKind        *string `json:"last_error_kind"`
	ConsecutiveFailures  *int    `json:"consecutive_failures"`
	RecoveryPending      *bool   `json:"recovery_pending"`
	RecoveryDelayed      *bool   `json:"recovery_delayed"`
	ConflictedNotes      *int    `json:"conflicted_notes"`
	PendingUpdateRecords *int    `json:"pending_update_records"`
	TooLargeRecords      *int    `json:"too_large_records"`
}

func ValidCloudsyncStatusResult(value string) bool {
	if len(value) == 0 || len(value) > 4096 {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &fields) != nil || len(fields) != 14 {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	var status CloudsyncStatusResult
	if decoder.Decode(&status) != nil || decoder.Decode(new(any)) != io.EOF {
		return false
	}
	if status.CloudsyncEnabled == nil || status.Configured == nil || status.Running == nil || status.ActivityPaused == nil || status.DeferredForCapture == nil || status.ConsecutiveFailures == nil || status.RecoveryPending == nil || status.RecoveryDelayed == nil || status.ConflictedNotes == nil || status.PendingUpdateRecords == nil || status.TooLargeRecords == nil {
		return false
	}
	if *status.ConsecutiveFailures < 0 || *status.ConflictedNotes < 0 || *status.PendingUpdateRecords < 0 || *status.TooLargeRecords < 0 || (status.LastSyncAtMS != nil && (*status.LastSyncAtMS < 0 || *status.LastSyncAtMS > 8640000000000000)) {
		return false
	}
	if status.LastErrorKind != nil && *status.LastErrorKind != "transient" && *status.LastErrorKind != "auth" && *status.LastErrorKind != "fatal" {
		return false
	}
	return true
}

type ActivityInsightsResult struct {
	Conversations      *int                    `json:"conversations"`
	TotalConversations *int                    `json:"totalConversations"`
	Hours              *float64                `json:"hours"`
	ActiveDays         *int                    `json:"activeDays"`
	Streak             *int                    `json:"streak"`
	Days               *[]ActivityInsightDay   `json:"days"`
	WeekdayCounts      *[]ActivityWeekdayCount `json:"weekdayCounts"`
}

type ActivityInsightDay struct {
	Key   *string `json:"key"`
	Count *int    `json:"count"`
}

type ActivityWeekdayCount struct {
	Weekday *int `json:"weekday"`
	Count   *int `json:"count"`
}

const maxSafeJSONInteger int64 = 1<<53 - 1

func ValidActivityInsightsResult(value string) bool {
	if len(value) == 0 || len(value) > 65536 {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &fields) != nil || len(fields) != 7 {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	var result ActivityInsightsResult
	if decoder.Decode(&result) != nil || decoder.Decode(new(any)) != io.EOF {
		return false
	}
	if result.Conversations == nil || result.TotalConversations == nil || result.Hours == nil ||
		result.ActiveDays == nil || result.Streak == nil || result.Days == nil || result.WeekdayCounts == nil {
		return false
	}
	if *result.Conversations < 0 || int64(*result.Conversations) > maxSafeJSONInteger ||
		*result.TotalConversations < *result.Conversations || int64(*result.TotalConversations) > maxSafeJSONInteger ||
		math.IsNaN(*result.Hours) || math.IsInf(*result.Hours, 0) || *result.Hours < 0 ||
		*result.ActiveDays < 0 || int64(*result.ActiveDays) > maxSafeJSONInteger ||
		*result.Streak < 0 || int64(*result.Streak) > maxSafeJSONInteger ||
		len(*result.Days) > 400 || len(*result.WeekdayCounts) != 7 {
		return false
	}
	previousDay := ""
	for _, day := range *result.Days {
		if day.Key == nil || day.Count == nil || *day.Count < 0 || int64(*day.Count) > maxSafeJSONInteger || len(*day.Key) != len("2006-01-02") {
			return false
		}
		parsed, err := time.Parse("2006-01-02", *day.Key)
		if err != nil || parsed.Format("2006-01-02") != *day.Key || (previousDay != "" && *day.Key <= previousDay) {
			return false
		}
		previousDay = *day.Key
	}
	seenWeekdays := [7]bool{}
	for _, day := range *result.WeekdayCounts {
		if day.Weekday == nil || day.Count == nil || *day.Weekday < 0 || *day.Weekday > 6 || seenWeekdays[*day.Weekday] || *day.Count < 0 || int64(*day.Count) > maxSafeJSONInteger {
			return false
		}
		seenWeekdays[*day.Weekday] = true
	}
	return true
}

func (input DeviceCommandInput) Valid() bool {
	if len(input.ExpectedUserID) > 200 {
		return false
	}
	switch input.Kind {
	case "auto-format", "dictation-status", "cloudsync-log", "ai-provider", "cloudsync-recovery":
		return ValidPrivateAction(input.Argument, true)
	case "choose-export-directory", "open-export-directory", "show-release-notes", "dictation-retry", "dictation-cancel", "show-dictation-shortcut", "cloudsync-status", "cloudsync-now":
		return input.Argument == ""
	case "open-settings-page":
		return input.Argument == "imports" || input.Argument == "intelligence" || input.Argument == "transcription"
	case "activity-insights":
		return input.Argument == "all" || input.Argument == "30d" || input.Argument == "7d"
	case "request-permission", "open-permission":
		return ValidPermission(input.Argument)
	case "set-lock":
		return input.Argument == "true" || input.Argument == "false"
	case "preview-sound":
		return input.Argument == "ready" || input.Argument == "success" || input.Argument == "chime" || input.Argument == "sparkle" || input.Argument == "bloom"
	}
	return false
}

func validEncoded(value string, min, max int) bool {
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) >= min && len(decoded) <= max
}

func ValidPrivateAction(value string, request bool) bool {
	if len(value) > 201000 {
		return false
	}
	var envelope struct {
		PublicKey  string `json:"publicKey,omitempty"`
		IV         string `json:"iv"`
		Ciphertext string `json:"ciphertext"`
	}
	decoder := json.NewDecoder(bytes.NewBufferString(value))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || decoder.Decode(new(any)) != io.EOF {
		return false
	}
	return ((request && validEncoded(envelope.PublicKey, 65, 65)) || (!request && envelope.PublicKey == "")) && validEncoded(envelope.IV, 12, 12) && validEncoded(envelope.Ciphertext, 16, 150000)
}
