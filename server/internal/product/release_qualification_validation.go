package product

import (
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

// QualificationBlocker names the fact to repair without exposing its content.
type QualificationBlocker struct {
	Field        string  `json:"field"`
	Reason       string  `json:"reason"`
	ObjectID     *string `json:"objectId"`
	OwnerUserID  *string `json:"ownerUserId"`
	RepairAction string  `json:"repairAction"`
}

func qualificationID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' || character == '-') {
			return false
		}
	}
	return true
}

func qualificationCommandKey(value string) bool {
	return strings.TrimSpace(value) == value && value != "" && len(value) <= 128 && utf8.ValidString(value) && !strings.ContainsAny(value, "\x00\r\n\t")
}

func qualificationText(value *string, limit int) bool {
	return value == nil || (strings.TrimSpace(*value) != "" && utf8.ValidString(*value) && validReleaseText(*value, limit))
}

func validQualificationFacts(f releasefacts.Facts) bool {
	if !slices.Contains(releasefacts.Rollouts, f.Rollout) || len(f.Requirements) > 20 || len(f.SourceURLs)+len(f.SourceAssetIDs) > 200 {
		return false
	}
	for _, id := range []*string{f.OwnerUserID, f.FactReviewerUserID, f.HumanBriefAuthorUserID} {
		if id != nil && !qualificationID(*id) {
			return false
		}
	}
	for _, text := range []*string{f.Rationale, f.Availability, f.Exclusions, f.Eligibility, f.PlannedAvailability} {
		if !qualificationText(text, 4000) {
			return false
		}
	}
	if !qualificationText(f.HumanBrief, 10000) || (f.HumanBrief == nil) != (f.HumanBriefAuthorUserID == nil) {
		return false
	}
	if f.ReadyAt != nil && (f.ReadyAt.IsZero() || f.ReadyAt.Year() < 1 || f.ReadyAt.Year() > 9999) {
		return false
	}
	sources := make(map[string]bool, len(f.SourceURLs)+len(f.SourceAssetIDs))
	for _, value := range f.SourceURLs {
		if sources[value] || !validReleaseURLs([]string{value}) || strings.TrimSpace(value) != value {
			return false
		}
		sources[value] = true
	}
	for _, id := range f.SourceAssetIDs {
		if sources[id] || !qualificationID(id) {
			return false
		}
		sources[id] = true
	}
	audiences := make(map[string]bool, len(f.Requirements))
	materialCount := 0
	for _, audience := range f.Requirements {
		if !qualificationID(audience.ID) || audiences[audience.ID] || !slices.Contains(releasefacts.AudienceKinds, audience.Kind) ||
			!qualificationText(audience.Label, 160) || (audience.Kind == "OTHER" && audience.Label == nil) {
			return false
		}
		audiences[audience.ID] = true
		materials := make(map[string]bool, len(audience.Materials)+len(audience.Omissions))
		for _, kind := range audience.Materials {
			if materials[kind] || !slices.Contains(releasefacts.MaterialKinds, kind) {
				return false
			}
			materials[kind] = true
		}
		for _, omission := range audience.Omissions {
			if materials[omission.Material] || !slices.Contains(releasefacts.MaterialKinds, omission.Material) || !qualificationText(&omission.Reason, 4000) {
				return false
			}
			materials[omission.Material] = true
		}
		materialCount += len(materials)
		if materialCount > 50 {
			return false
		}
	}
	return true
}

func qualificationMissingFacts(f releasefacts.Facts, decision string, selectedSources int) []QualificationBlocker {
	missing := []QualificationBlocker{}
	add := func(field, reason string, objectID *string) {
		missing = append(missing, QualificationBlocker{Field: field, Reason: reason, ObjectID: objectID, OwnerUserID: f.OwnerUserID, RepairAction: "REVISE_FACTS"})
	}
	if f.OwnerUserID == nil {
		add("ownerUserId", "OWNER_REQUIRED", nil)
	}
	if f.FactReviewerUserID == nil {
		add("factReviewerUserId", "REVIEWER_REQUIRED", nil)
	}
	if len(f.SourceURLs)+len(f.SourceAssetIDs)+selectedSources == 0 && f.HumanBrief == nil {
		add("sources", "SOURCE_REQUIRED", nil)
	}
	if decision != "QUALIFIED" {
		return missing
	}
	if len(f.Requirements) == 0 {
		add("requirements", "AUDIENCE_REQUIRED", nil)
	}
	for _, audience := range f.Requirements {
		if len(audience.Materials) == 0 {
			add("requirements", "MATERIAL_REQUIRED", &audience.ID)
		}
	}
	if f.Rollout == "UNKNOWN" {
		add("rollout", "ROLLOUT_UNKNOWN", nil)
	}
	if f.Rollout == "WITHDRAWN" {
		add("rollout", "ROLLOUT_WITHDRAWN", nil)
	}
	if f.Availability == nil {
		add("availability", "AVAILABILITY_REQUIRED", nil)
	}
	if f.Exclusions == nil {
		add("exclusions", "EXCLUSIONS_REQUIRED", nil)
	}
	if f.Rollout == "LIMITED" && f.Eligibility == nil {
		add("eligibility", "ELIGIBILITY_REQUIRED", nil)
	}
	if f.Rollout == "PLANNED" && f.PlannedAvailability == nil {
		add("plannedAvailability", "PLANNED_AVAILABILITY_REQUIRED", nil)
	}
	if (f.Rollout == "GENERAL" || f.Rollout == "LIMITED") && f.ReadyAt == nil {
		add("readyAt", "READY_TIME_REQUIRED", nil)
	}
	return missing
}
