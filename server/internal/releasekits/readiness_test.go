package releasekits

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"slices"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

func readySnapshot() Snapshot {
	return Snapshot{RevisionID: "kit-revision", ManifestHash: "hash", AggregateRevision: "9", DependencyToken: "dependency", OwnerID: "owner", ApproverID: "reviewer",
		Current: true, Qualified: true, QualificationCurrent: true, AvailabilityConfirmed: true, Prepared: true, CoverageApproved: true, CoverageAuthority: true, FinalApproved: true, FinalAuthority: true,
		Requirements: []releasefacts.Audience{{ID: "sales", Materials: []string{"SALES_NOTES"}}}, Artifacts: []ArtifactStatus{{ID: "notes", AudienceID: "sales", Kind: "SALES_NOTES", Classification: "INTERNAL_MATERIAL", HasContent: true, HasOutput: true, HasClaims: true, ClaimsVerified: true, EvidenceAvailable: true, SourcesCurrent: true, AudienceSafe: true, ScreenshotReviewed: true}}}
}

func TestReadinessGatesAndApprovalEligibility(t *testing.T) {
	if got := Evaluate(readySnapshot()); !got.CanApprove || !got.CanExportApproved || !got.CanRequestHandoff || len(got.Blockers) != 0 {
		t.Fatalf("ready=%+v", got)
	}
	for _, tc := range []struct {
		name, code string
		change     func(*Snapshot)
	}{
		{"qualification", "QUALIFICATION_REQUIRED", func(s *Snapshot) { s.Qualified = false }},
		{"qualification changed", "QUALIFICATION_REQUIRED", func(s *Snapshot) { s.QualificationCurrent = false }},
		{"availability", "AVAILABILITY_UNCONFIRMED", func(s *Snapshot) { s.AvailabilityConfirmed = false }},
		{"replacement", "REVISION_SUPERSEDED", func(s *Snapshot) { s.Current = false }},
		{"missing material", "MATERIAL_MISSING", func(s *Snapshot) { s.Artifacts = nil }},
		{"partial render", "OUTPUT_INCOMPLETE", func(s *Snapshot) { s.Artifacts[0].HasOutput = false }},
		{"unsupported included fact", "CLAIM_UNVERIFIED", func(s *Snapshot) { s.Artifacts[0].ClaimsVerified = false }},
		{"missing link", "CLAIM_UNVERIFIED", func(s *Snapshot) { s.Artifacts[0].HasClaims = false }},
		{"revoked evidence", "EVIDENCE_UNAVAILABLE", func(s *Snapshot) { s.Artifacts[0].EvidenceAvailable = false }},
		{"source fence before worker", "SOURCE_CHANGED", func(s *Snapshot) { s.Artifacts[0].SourcesCurrent = false }},
		{"private source", "AUDIENCE_LEAK", func(s *Snapshot) { s.Artifacts[0].AudienceSafe = false }},
		{"unreviewed image", "SCREENSHOT_UNREVIEWED", func(s *Snapshot) { s.Artifacts[0].Kind = "SCREENSHOT"; s.Artifacts[0].ScreenshotReviewed = false }},
		{"missing human coverage", "COVERAGE_UNREVIEWED", func(s *Snapshot) { s.CoverageApproved = false }},
		{"revoked coverage", "APPROVER_REVOKED", func(s *Snapshot) { s.CoverageAuthority = false }},
		{"missing final approval", "APPROVAL_REQUIRED", func(s *Snapshot) { s.FinalApproved = false }},
		{"revoked final approver", "APPROVER_REVOKED", func(s *Snapshot) { s.FinalAuthority = false }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := readySnapshot()
			tc.change(&s)
			r := Evaluate(s)
			if r.CanExportApproved || r.CanRequestHandoff || !slices.ContainsFunc(r.Blockers, func(b Blocker) bool { return b.Code == tc.code }) {
				t.Fatalf("gate=%+v", r)
			}
			if tc.code == "APPROVAL_REQUIRED" && !r.CanApprove {
				t.Fatal("approval requires itself")
			}
		})
	}
	// An omission covers only the exact omission already reviewed in qualification.
	s := readySnapshot()
	s.Requirements[0].Omissions = []releasefacts.Omission{{Material: "FAQ", Reason: "No additional questions"}}
	s.Omissions = []Omission{{AudienceID: "sales", Material: "FAQ", OwnerID: "owner", Reason: "No additional questions"}}
	if got := Evaluate(s); !got.CanExportApproved {
		t.Fatalf("qualified omission=%+v", got)
	}
	s.Omissions[0].Reason = "Different"
	if got := Evaluate(s); got.CanApprove {
		t.Fatal("unreviewed omission accepted")
	}
	s = readySnapshot()
	s.Requirements[0].Materials = nil
	s.Artifacts[0].ClaimsVerified = false
	if got := Evaluate(s); got.CanApprove {
		t.Fatal("optional included assertion bypassed verification")
	}
}

func TestBundleStableBytesAndSafePublicIndex(t *testing.T) {
	files := map[string][]byte{"sales/notes.md": []byte("Approved facts\n"), "customer/faq.md": []byte("# Questions\n")}
	idx := PublicIndex{SchemaVersion: 1, ReleaseID: "release", KitRevisionID: "revision", AudienceIDs: []string{"sales", "customer"}}
	for name, body := range files {
		idx.Files = append(idx.Files, File{Name: name, SHA256: releasefacts.ByteHash(body), ByteLength: len(body)})
	}
	one, err := Bundle(idx, files)
	if err != nil {
		t.Fatal(err)
	}
	slices.Reverse(idx.Files)
	slices.Reverse(idx.AudienceIDs)
	two, err := Bundle(idx, files)
	if err != nil || !bytes.Equal(one, two) {
		t.Fatal("retry changed approved bytes", err)
	}
	r, err := zip.NewReader(bytes.NewReader(one), int64(len(one)))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range r.File {
		if f.Mode().Perm() != 0644 || f.Modified.Year() != 1980 || f.Method != zip.Store {
			t.Fatalf("unstable metadata: %+v", f.FileHeader)
		}
		if f.Name == "manifest.json" {
			in, err := f.Open()
			if err != nil {
				t.Fatal(err)
			}
			raw, err := io.ReadAll(in)
			in.Close()
			if err != nil {
				t.Fatal(err)
			}
			var manifest map[string]json.RawMessage
			if err := json.Unmarshal(raw, &manifest); err != nil {
				t.Fatal(err)
			}
			if len(manifest) != 5 {
				t.Fatalf("unexpected public metadata: %s", raw)
			}
		}
	}
	for _, bad := range []string{"../secret.md", "/file.md", "a/../b.md", "a\\b.md", "run.exe", "x\x00.md", ".hidden.md", "a//b.md", "a.md/../b.md"} {
		if SafeFileName(bad) {
			t.Fatalf("unsafe path=%q", bad)
		}
	}
	idx.Files[0].SHA256 = "changed"
	if _, err := Bundle(idx, files); err == nil {
		t.Fatal("changed stored output accepted")
	}
}
