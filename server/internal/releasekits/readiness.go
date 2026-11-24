package releasekits

import (
	"cmp"
	"slices"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

type Blocker struct {
	Code         string  `json:"code"`
	ObjectID     string  `json:"objectId"`
	AudienceID   *string `json:"audienceId"`
	OwnerID      *string `json:"ownerId"`
	RepairAction string  `json:"repairAction"`
}

type Readiness struct {
	CanApprove        bool      `json:"canApprove"`
	CanExportApproved bool      `json:"canExportApproved"`
	CanRequestHandoff bool      `json:"canRequestHandoff"`
	ManifestHash      *string   `json:"manifestHash"`
	AggregateRevision string    `json:"aggregateRevision"`
	DependencyToken   string    `json:"dependencyToken"`
	PolicyVersion     int       `json:"policyVersion"`
	Blockers          []Blocker `json:"blockers"`
}

type ArtifactStatus struct {
	ID, AudienceID, Kind, Classification              string
	HasContent, HasOutput, HasClaims                  bool
	ClaimsVerified, EvidenceAvailable, SourcesCurrent bool
	AudienceSafe, ScreenshotReviewed                  bool
}

type Snapshot struct {
	RevisionID, ManifestHash, AggregateRevision, DependencyToken                 string
	OwnerID, ApproverID                                                          string
	Current, Qualified, QualificationCurrent, AvailabilityConfirmed              bool
	Prepared, CoverageApproved, CoverageAuthority, FinalApproved, FinalAuthority bool
	Requirements                                                                 []releasefacts.Audience
	Artifacts                                                                    []ArtifactStatus
	Omissions                                                                    []Omission
	// Dependency failures preserve source IDs for the authenticated repair view.
	DependencyBlockers []Blocker
}

// Evaluate has no clock, database or provider access. Missing final approval is
// an approved-use blocker, never a circular prerequisite for the first approval.
func Evaluate(s Snapshot) Readiness {
	r := Readiness{AggregateRevision: s.AggregateRevision, DependencyToken: s.DependencyToken, PolicyVersion: PolicyVersion, Blockers: []Blocker{}}
	if s.ManifestHash != "" {
		r.ManifestHash = &s.ManifestHash
	}
	add := func(code, id, audience, owner, action string) {
		b := Blocker{Code: code, ObjectID: id, RepairAction: action}
		if audience != "" {
			b.AudienceID = &audience
		}
		if owner != "" {
			b.OwnerID = &owner
		}
		r.Blockers = append(r.Blockers, b)
	}
	if !s.Current {
		add("REVISION_SUPERSEDED", s.RevisionID, "", s.OwnerID, "Review the current kit revision.")
	}
	if !s.Qualified || !s.QualificationCurrent {
		add("QUALIFICATION_REQUIRED", s.RevisionID, "", s.OwnerID, "Qualify the current release facts.")
	}
	if !s.AvailabilityConfirmed {
		add("AVAILABILITY_UNCONFIRMED", s.RevisionID, "", s.OwnerID, "Confirm availability and rollout conditions.")
	}
	if !s.Prepared || s.ManifestHash == "" {
		add("OUTPUT_INCOMPLETE", s.RevisionID, "", s.OwnerID, "Prepare all outputs before review.")
	}
	for _, a := range s.Artifacts {
		if !a.HasContent {
			add("MATERIAL_MISSING", a.ID, a.AudienceID, s.OwnerID, "Add the required material.")
		}
		if !a.HasOutput {
			add("OUTPUT_INCOMPLETE", a.ID, a.AudienceID, s.OwnerID, "Prepare the artifact output.")
		}
		if !a.HasClaims || !a.ClaimsVerified {
			add("CLAIM_UNVERIFIED", a.ID, a.AudienceID, s.OwnerID, "Link and verify every included assertion.")
		}
		if !a.EvidenceAvailable {
			add("EVIDENCE_UNAVAILABLE", a.ID, a.AudienceID, s.OwnerID, "Restore or replace unavailable evidence.")
		}
		if !a.SourcesCurrent {
			add("SOURCE_CHANGED", a.ID, a.AudienceID, s.OwnerID, "Review the changed source and prepare a new revision.")
		}
		if !a.AudienceSafe {
			add("AUDIENCE_LEAK", a.ID, a.AudienceID, s.OwnerID, "Remove private content or obtain audience clearance.")
		}
		if a.Kind == "SCREENSHOT" && !a.ScreenshotReviewed {
			add("SCREENSHOT_UNREVIEWED", a.ID, a.AudienceID, s.ApproverID, "Review the image, product state, crop, redaction and usage permission.")
		}
	}
	for _, requirement := range s.Requirements {
		for _, kind := range requirement.Materials {
			present := slices.ContainsFunc(s.Artifacts, func(a ArtifactStatus) bool { return a.AudienceID == requirement.ID && a.Kind == kind && a.HasContent })
			if !present {
				add("MATERIAL_MISSING", kind, requirement.ID, s.OwnerID, "Add the required material or revise qualification with an eligible omission.")
			}
		}
		for _, omission := range requirement.Omissions {
			present := slices.ContainsFunc(s.Omissions, func(o Omission) bool {
				return o.AudienceID == requirement.ID && o.Material == omission.Material && o.Reason == omission.Reason && o.OwnerID == s.OwnerID && o.Reason != "" && o.OwnerID != ""
			})
			if !present {
				add("MATERIAL_MISSING", omission.Material, requirement.ID, s.OwnerID, "Include the qualified omission and its accountable owner in the manifest.")
			}
		}
	}
	r.Blockers = append(r.Blockers, s.DependencyBlockers...)
	if !s.CoverageApproved {
		add("COVERAGE_UNREVIEWED", s.RevisionID, "", s.ApproverID, "Confirm coverage of all assertions, images and qualifiers.")
	}
	if !s.CoverageAuthority {
		add("APPROVER_REVOKED", s.RevisionID, "", s.ApproverID, "Assign an authorized reviewer and record a new review.")
	}
	r.CanApprove = len(r.Blockers) == 0
	if !s.FinalApproved {
		add("APPROVAL_REQUIRED", s.RevisionID, "", s.ApproverID, "Approve this exact manifest.")
	} else if !s.FinalAuthority {
		add("APPROVER_REVOKED", s.RevisionID, "", s.ApproverID, "Obtain approval from a currently authorized reviewer.")
	}
	r.CanExportApproved = len(r.Blockers) == 0
	r.CanRequestHandoff = r.CanExportApproved
	slices.SortFunc(r.Blockers, func(a, b Blocker) int {
		text := func(v *string) string {
			if v == nil {
				return ""
			}
			return *v
		}
		if n := cmp.Compare(text(a.AudienceID), text(b.AudienceID)); n != 0 {
			return n
		}
		if n := cmp.Compare(a.ObjectID, b.ObjectID); n != 0 {
			return n
		}
		return cmp.Compare(a.Code, b.Code)
	})
	return r
}
