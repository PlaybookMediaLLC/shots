package product

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

func qualifiedFactsFixture() releasefacts.Facts {
	owner, reviewer, availability, exclusions := "owner", "reviewer", "Available to all workspaces", "No exclusions"
	ready := time.Date(2026, time.November, 20, 12, 0, 0, 0, time.UTC)
	return releasefacts.Facts{
		OwnerUserID: &owner, FactReviewerUserID: &reviewer, Rollout: "GENERAL", Availability: &availability,
		Exclusions: &exclusions, ReadyAt: &ready, SourceURLs: []string{"https://example.com/release"}, SourceAssetIDs: []string{},
		Requirements: []releasefacts.Audience{{ID: "sales", Kind: "SALES", Materials: []string{"FACT_SHEET", "SALES_NOTES"}, Omissions: []releasefacts.Omission{}}},
	}
}

func TestQualificationDraftKeepsUnknownFacts(t *testing.T) {
	empty := releasefacts.Facts{Rollout: "UNKNOWN"}
	if !validQualificationFacts(empty) {
		t.Fatal("an incomplete draft must be saveable")
	}
	missing := qualificationMissingFacts(empty, "QUALIFIED", 0)
	reasons := []string{}
	for _, blocker := range missing {
		reasons = append(reasons, blocker.Reason)
	}
	for _, reason := range []string{"OWNER_REQUIRED", "REVIEWER_REQUIRED", "SOURCE_REQUIRED", "AUDIENCE_REQUIRED", "ROLLOUT_UNKNOWN", "AVAILABILITY_REQUIRED", "EXCLUSIONS_REQUIRED"} {
		if !slices.Contains(reasons, reason) {
			t.Errorf("missing stable blocker %s: %v", reason, reasons)
		}
	}
	complete := qualifiedFactsFixture()
	if !validQualificationFacts(complete) || len(qualificationMissingFacts(complete, "QUALIFIED", 0)) != 0 {
		t.Fatal("complete manual facts were rejected")
	}
	complete.Requirements, complete.ReadyAt, complete.Availability, complete.Exclusions = nil, nil, nil, nil
	complete.Rollout = "UNKNOWN"
	for _, decision := range []string{"DEFERRED", "NO_COMMUNICATION"} {
		if missing := qualificationMissingFacts(complete, decision, 0); len(missing) != 0 {
			t.Fatalf("%s incorrectly requires a communication scope: %+v", decision, missing)
		}
	}
}

func TestQualificationRolloutIsExplicit(t *testing.T) {
	f := qualifiedFactsFixture()
	f.Rollout, f.ReadyAt = "PLANNED", nil
	missing := qualificationMissingFacts(f, "QUALIFIED", 0)
	if len(missing) != 1 || missing[0].Reason != "PLANNED_AVAILABILITY_REQUIRED" {
		t.Fatalf("planned availability: %+v", missing)
	}
	planned := "Planned for December; not generally available yet"
	f.PlannedAvailability = &planned
	if missing := qualificationMissingFacts(f, "QUALIFIED", 0); len(missing) != 0 {
		t.Fatalf("a planned release must retain an unknown actual ready time: %+v", missing)
	}
	f.Rollout = "LIMITED"
	missing = qualificationMissingFacts(f, "QUALIFIED", 0)
	if len(missing) != 2 || missing[0].Reason != "ELIGIBILITY_REQUIRED" || missing[1].Reason != "READY_TIME_REQUIRED" {
		t.Fatalf("limited rollout facts: %+v", missing)
	}
}

func TestQualificationFactsRejectInvalidAndOversizedScopes(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*releasefacts.Facts)
	}{
		{"invented rollout", func(f *releasefacts.Facts) { f.Rollout = "CONFIRMED_BY_AI" }},
		{"blank exclusion", func(f *releasefacts.Facts) { v := "  "; f.Exclusions = &v }},
		{"unattributed human brief", func(f *releasefacts.Facts) { v := "Released"; f.HumanBrief = &v }},
		{"duplicate source", func(f *releasefacts.Facts) { f.SourceURLs = append(f.SourceURLs, f.SourceURLs[0]) }},
		{"script source", func(f *releasefacts.Facts) { f.SourceURLs = []string{"javascript:alert(1)"} }},
		{"malformed asset reference", func(f *releasefacts.Facts) { f.SourceAssetIDs = []string{"asset,another-asset"} }},
		{"unicode audience reference", func(f *releasefacts.Facts) { f.Requirements[0].ID = "salesé" }},
		{"unknown material", func(f *releasefacts.Facts) { f.Requirements[0].Materials = []string{"ANYTHING"} }},
		{"duplicate audience", func(f *releasefacts.Facts) { f.Requirements = append(f.Requirements, f.Requirements[0]) }},
		{"required and omitted", func(f *releasefacts.Facts) {
			f.Requirements[0].Omissions = []releasefacts.Omission{{Material: "FACT_SHEET", Reason: "Not needed"}}
		}},
		{"unjustified omission", func(f *releasefacts.Facts) {
			f.Requirements[0].Omissions = []releasefacts.Omission{{Material: "FAQ", Reason: ""}}
		}},
		{"unnamed other audience", func(f *releasefacts.Facts) { f.Requirements[0].Kind = "OTHER" }},
		{"source limit", func(f *releasefacts.Facts) {
			for i := 0; i < 200; i++ {
				f.SourceAssetIDs = append(f.SourceAssetIDs, fmt.Sprintf("asset-%d", i))
			}
		}},
		{"audience limit", func(f *releasefacts.Facts) {
			for i := 0; i < 20; i++ {
				f.Requirements = append(f.Requirements, releasefacts.Audience{ID: fmt.Sprintf("audience-%d", i), Kind: "SALES"})
			}
		}},
		{"material limit", func(f *releasefacts.Facts) {
			for i := 0; i < 9; i++ {
				f.Requirements = append(f.Requirements, releasefacts.Audience{ID: fmt.Sprintf("audience-%d", i), Kind: "SALES", Materials: slices.Clone(releasefacts.MaterialKinds)})
			}
		}},
		{"oversized rationale", func(f *releasefacts.Facts) { v := strings.Repeat("x", 4001); f.Rationale = &v }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := qualifiedFactsFixture()
			tc.edit(&f)
			if validQualificationFacts(f) {
				t.Fatal("invalid facts accepted")
			}
		})
	}
}

func TestReleaseLineageInputBounds(t *testing.T) {
	for _, revision := range []string{"", "01", "-1", "9223372036854775808"} {
		if _, err := lineageParticipants([]ReleaseLineageParticipant{{ReleaseID: "release-1", ExpectedRevision: revision}}); err == nil {
			t.Fatalf("accepted revision %q", revision)
		}
	}
	ids := make([]string, 200)
	for i := range ids {
		ids[i] = fmt.Sprintf("binding-%03d", i)
	}
	if result, err := lineageBindingIDs(ids); err != nil || len(result) != 200 {
		t.Fatalf("200 sources: %v", err)
	}
	for _, invalid := range [][]string{append(append([]string{}, ids...), "binding-200"), {"duplicate", "duplicate"}, {"bad id"}} {
		if _, err := lineageBindingIDs(invalid); err == nil {
			t.Fatal("invalid source set accepted")
		}
	}
	repo := &Configuration{}
	actor := Actor{OrganizationID: "org", UserID: "user", SessionID: "session"}
	for _, reason := range []string{"", " ", "bad\x00reason"} {
		if _, err := repo.MergeRelease(context.Background(), actor, "release-1", "key", MergeReleaseInput{ExpectedRevision: "0", Sources: []ReleaseLineageParticipant{{ReleaseID: "release-2", ExpectedRevision: "0"}}, Reason: reason}); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("invalid reason: %v", err)
		}
	}
	if _, err := repo.SplitRelease(context.Background(), actor, "release-1", "key", SplitReleaseInput{ExpectedRevision: "0", Reason: "Split", Groups: []ReleaseSplitGroup{{BindingIDs: []string{"binding-1"}, NewRelease: ReleaseSourceBrief{Title: "First", BenefitStatement: "Useful"}}, {BindingIDs: []string{"binding-1"}, NewRelease: ReleaseSourceBrief{Title: "Second", BenefitStatement: "Useful"}}}}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("overlapping groups: %v", err)
	}
}
