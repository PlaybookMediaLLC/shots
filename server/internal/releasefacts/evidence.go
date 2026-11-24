package releasefacts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const MaxEvidenceTextBytes = 256 * 1024
const MaxClaimTextBytes = 4 * 1024
const MaxEvidenceRationaleBytes = 8 * 1024
const MaxClaimsPerSpec = 100
const MaxClaimSupports = 20

var EvidenceAccessClasses = []string{"PRIVATE_SOURCE", "INTERNAL_MATERIAL", "CUSTOMER_CLEARED"}
var EvidenceOrigins = []string{"HUMAN", "PROVIDER", "AI"}
var ClaimDecisions = []string{"SUPPORTED", "CONTRADICTED", "UNRESOLVED", "WITHDRAWN"}
var SupportRelations = []string{"SUPPORTS", "CONTRADICTS", "CONTEXT"}

// ClaimQualifiers are part of the immutable claim hash, including explicit
// limitations when there are none. Empty qualifiers cannot support approval.
type ClaimQualifiers struct {
	Audience     string `json:"audience"`
	Availability string `json:"availability"`
	Eligibility  string `json:"eligibility"`
	Limitations  string `json:"limitations"`
}

func (q ClaimQualifiers) Complete() bool {
	for _, value := range []string{q.Audience, q.Availability, q.Eligibility, q.Limitations} {
		if strings.TrimSpace(value) == "" || len(value) > MaxClaimTextBytes || !utf8.ValidString(value) {
			return false
		}
	}
	return true
}

// EvidenceSelector addresses exactly the retained UTF-8 bytes or image pixels.
// The image hash includes the approved redaction version, never a live URL.
type EvidenceSelector struct {
	Kind          string `json:"kind"`
	StartByte     int    `json:"startByte,omitempty"`
	EndByte       int    `json:"endByte,omitempty"`
	QuoteSHA256   string `json:"quoteSha256,omitempty"`
	ContextSHA256 string `json:"contextSha256"`
	X             int    `json:"x,omitempty"`
	Y             int    `json:"y,omitempty"`
	Width         int    `json:"width,omitempty"`
	Height        int    `json:"height,omitempty"`
	RedactionID   string `json:"redactionId,omitempty"`
}

func ByteHash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// NormalizeEvidenceText changes only Unicode and line endings. Numbers,
// negation, code/table whitespace and rollout qualifiers retain their meaning.
func NormalizeEvidenceText(raw string) (string, error) {
	if !utf8.ValidString(raw) || len(raw) == 0 || len(raw) > MaxEvidenceTextBytes || strings.ContainsRune(raw, 0) {
		return "", errors.New("evidence must contain bounded UTF-8 text")
	}
	text := norm.NFC.String(strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\r", "\n"))
	if strings.TrimSpace(text) == "" || len(text) > MaxEvidenceTextBytes {
		return "", errors.New("evidence must contain bounded UTF-8 text")
	}
	return text, nil
}

func (s EvidenceSelector) ValidateText(text string) error {
	if s.Kind != "TEXT_SPAN" || !utf8.ValidString(text) || s.StartByte < 0 || s.EndByte <= s.StartByte || s.EndByte > len(text) ||
		(s.StartByte > 0 && !utf8.RuneStart(text[s.StartByte])) || (s.EndByte < len(text) && !utf8.RuneStart(text[s.EndByte])) ||
		s.ContextSHA256 != ByteHash([]byte(text)) || s.QuoteSHA256 != ByteHash([]byte(text[s.StartByte:s.EndByte])) ||
		s.X != 0 || s.Y != 0 || s.Width != 0 || s.Height != 0 || s.RedactionID != "" {
		return errors.New("selector does not match the retained evidence bytes")
	}
	return nil
}

func (s EvidenceSelector) ValidateImage(hash string, width, height int, redactionID string) error {
	if s.Kind != "IMAGE_REGION" || width <= 0 || height <= 0 || s.X < 0 || s.Y < 0 || s.Width <= 0 || s.Height <= 0 ||
		s.X >= width || s.Y >= height || s.Width > width-s.X || s.Height > height-s.Y || s.ContextSHA256 != hash ||
		s.RedactionID != redactionID || s.StartByte != 0 || s.EndByte != 0 || s.QuoteSHA256 != "" {
		return errors.New("selector does not match the retained image version")
	}
	return nil
}

// SupportReference is part of a canonical sorted support set; a source URL
// alone cannot establish support or authorize a human verification decision.
type SupportReference struct {
	EvidenceVersionID string           `json:"evidenceVersionId"`
	EvidenceSHA256    string           `json:"evidenceSha256"`
	SourceID          string           `json:"sourceId"`
	SourceSequence    string           `json:"sourceSequence"`
	Relation          string           `json:"relation"`
	Selector          EvidenceSelector `json:"selector"`
	ExclusionReason   string           `json:"exclusionReason"`
}
