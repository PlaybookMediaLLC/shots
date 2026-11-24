// Package releasekits defines immutable kit manifests and their deterministic gates.
package releasekits

const PolicyVersion = 1
const ExporterVersion = "shots-kit-v1"
const MaxArtifacts = 50
const MaxDocumentBytes = 1 << 20
const MaxBundleBytes = 100 << 20

type AssetPin struct {
	ID         string `json:"id"`
	SHA256     string `json:"sha256"`
	ObjectKey  string `json:"objectKey"`
	MediaType  string `json:"mediaType"`
	ByteLength int64  `json:"byteLength"`
}

// NativeSnapshot contains no live remote assets. The renderer receives only these bytes.
type NativeSnapshot struct {
	Kind     string     `json:"kind"`
	SourceID string     `json:"sourceId"`
	Revision string     `json:"revision"`
	Document string     `json:"document"`
	Markdown string     `json:"markdown"`
	Assets   []AssetPin `json:"assets"`
	OutputID string     `json:"outputId"`
}

type ClaimLink struct {
	NodeID         string `json:"nodeId"`
	ClaimID        string `json:"claimId"`
	ClaimVersionID string `json:"claimVersionId"`
	SupportSetID   string `json:"supportSetId"`
	VerificationID string `json:"verificationId"`
}

type SourcePin struct {
	SourceID             string   `json:"sourceId"`
	AcknowledgedSequence string   `json:"acknowledgedSequence"`
	EvidenceVersionIDs   []string `json:"evidenceVersionIds"`
}

type Artifact struct {
	ArtifactRevisionID string `json:"artifactRevisionId"`
	AudienceID         string `json:"audienceId"`
	Kind               string `json:"kind"`
	Classification     string `json:"classification"`
	FileName           string `json:"fileName"`
	SnapshotSHA256     string `json:"snapshotSha256"`
	OutputSHA256       string `json:"outputSha256"`
	ClaimMapSHA256     string `json:"claimMapSha256"`
}

type Omission struct {
	AudienceID string `json:"audienceId"`
	Material   string `json:"material"`
	OwnerID    string `json:"ownerId"`
	Reason     string `json:"reason"`
}

type Manifest struct {
	SchemaVersion           int         `json:"schemaVersion"`
	ReleaseID               string      `json:"releaseId"`
	KitRevisionID           string      `json:"kitRevisionId"`
	QualificationRevisionID string      `json:"qualificationRevisionId"`
	RequirementRevision     string      `json:"requirementRevision"`
	Artifacts               []Artifact  `json:"artifacts"`
	Omissions               []Omission  `json:"omissions"`
	SourcePins              []SourcePin `json:"sourcePins"`
	RendererVersion         string      `json:"rendererVersion"`
}

type File struct {
	Name       string `json:"name"`
	SHA256     string `json:"sha256"`
	ByteLength int    `json:"byteLength"`
}

// PublicIndex deliberately cannot hold source IDs, evidence, review notes or storage URLs.
type PublicIndex struct {
	SchemaVersion int      `json:"schemaVersion"`
	ReleaseID     string   `json:"releaseId"`
	KitRevisionID string   `json:"kitRevisionId"`
	AudienceIDs   []string `json:"audienceIds"`
	Files         []File   `json:"files"`
}
