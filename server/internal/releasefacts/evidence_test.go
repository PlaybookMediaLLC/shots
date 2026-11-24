package releasefacts

import (
	"math"
	"strings"
	"testing"
)

func TestEvidenceTextSelectorsPinUTF8Bytes(t *testing.T) {
	text := "A café is not available to all plans."
	selector := EvidenceSelector{Kind: "TEXT_SPAN", StartByte: 2, EndByte: 7, ContextSHA256: ByteHash([]byte(text)), QuoteSHA256: ByteHash([]byte("café"))}
	if err := selector.ValidateText(text); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*EvidenceSelector){
		func(s *EvidenceSelector) { s.StartByte = -1 },
		func(s *EvidenceSelector) { s.StartByte = 6 },
		func(s *EvidenceSelector) { s.EndByte = 6 },
		func(s *EvidenceSelector) { s.EndByte = len(text) + 1 },
		func(s *EvidenceSelector) { s.QuoteSHA256 = ByteHash([]byte("irrelevant")) },
		func(s *EvidenceSelector) { s.ContextSHA256 = ByteHash([]byte(strings.ReplaceAll(text, "not ", ""))) },
		func(s *EvidenceSelector) { s.Width = 1 },
		func(s *EvidenceSelector) { s.Kind = "IMAGE_REGION" },
	} {
		invalid := selector
		change(&invalid)
		if err := invalid.ValidateText(text); err == nil {
			t.Errorf("invalid selector accepted: %+v", invalid)
		}
	}
}

func TestEvidenceNormalizationDoesNotEraseMeaning(t *testing.T) {
	got, err := NormalizeEvidenceText("cafe\u0301\r\nnot  20%\r  code\tcolumn")
	if err != nil || got != "café\nnot  20%\n  code\tcolumn" {
		t.Fatalf("normalized %q, %v", got, err)
	}
	for _, text := range []string{"", " \n", "\xff", "hidden\x00text", strings.Repeat("x", MaxEvidenceTextBytes+1)} {
		if _, err := NormalizeEvidenceText(text); err == nil {
			t.Error("invalid evidence accepted")
		}
	}
}

func TestEvidenceImageSelectorPinsBoundsAndRedaction(t *testing.T) {
	hash := ByteHash([]byte("reviewed-image"))
	s := EvidenceSelector{Kind: "IMAGE_REGION", ContextSHA256: hash, X: 10, Y: 20, Width: 30, Height: 40, RedactionID: "redacted-version"}
	if err := s.ValidateImage(hash, 40, 60, "redacted-version"); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*EvidenceSelector){
		func(s *EvidenceSelector) { s.X = -1 },
		func(s *EvidenceSelector) { s.Width = math.MaxInt },
		func(s *EvidenceSelector) { s.Height++ },
		func(s *EvidenceSelector) { s.RedactionID = "original-private-image" },
		func(s *EvidenceSelector) { s.ContextSHA256 = ByteHash([]byte("new-image")) },
		func(s *EvidenceSelector) { s.EndByte = 1 },
	} {
		invalid := s
		change(&invalid)
		if err := invalid.ValidateImage(hash, 40, 60, "redacted-version"); err == nil {
			t.Errorf("invalid image selector accepted: %+v", invalid)
		}
	}
}
