package releasefacts

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// SpecClaimPath is a compatibility address within one immutable spec version.
// Stable identity travels on the claim object, so moving an array element keeps it.
type SpecClaimPath struct {
	Path           string
	Text           string
	ClaimID        string
	ClaimVersionID string
	Object         map[string]json.RawMessage
}

func LegacySpecClaims(content []byte) ([]SpecClaimPath, map[string]json.RawMessage, error) {
	var spec map[string]json.RawMessage
	if len(content) > 1024*1024 || json.Unmarshal(content, &spec) != nil || spec == nil {
		return nil, nil, errors.New("invalid release spec")
	}
	if _, err := CanonicalJSON(content); err != nil {
		return nil, nil, err
	}
	claims := []SpecClaimPath{}
	add := func(path string, raw json.RawMessage, fields []string, join string) error {
		if len(raw) == 0 {
			return nil
		}
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil || object == nil {
			return errors.New("invalid spec claim")
		}
		parts := []string{}
		for _, field := range fields {
			var text string
			if json.Unmarshal(object[field], &text) != nil {
				return errors.New("invalid spec claim text")
			}
			parts = append(parts, text)
		}
		text := strings.Join(parts, join)
		if path == "messaging.positioning" && strings.TrimSpace(text) == "" {
			return nil
		}
		if strings.HasPrefix(path, "beforeAfter.") {
			text = "Before: " + parts[0] + " After: " + parts[1]
		}
		if len(text) > MaxClaimTextBytes || strings.TrimSpace(text) == "" {
			return errors.New("spec claim exceeds limit")
		}
		entry := SpecClaimPath{Path: path, Text: text, Object: object}
		for key, target := range map[string]*string{"claimId": &entry.ClaimID, "claimVersionId": &entry.ClaimVersionID} {
			if value, ok := object[key]; ok {
				if json.Unmarshal(value, target) != nil || *target == "" {
					return errors.New("invalid stable claim identity")
				}
			}
		}
		if (entry.ClaimID == "") != (entry.ClaimVersionID == "") {
			return errors.New("incomplete stable claim identity")
		}
		claims = append(claims, entry)
		return nil
	}
	if err := add("summary", spec["summary"], []string{"text"}, ""); err != nil {
		return nil, nil, err
	}
	for _, section := range []struct {
		name   string
		fields []string
		join   string
	}{
		{"problem", []string{"text"}, ""}, {"audience", []string{"segment", "need"}, ": "}, {"whatChanged", []string{"text"}, ""}, {"capabilities", []string{"name", "description"}, ": "},
		{"beforeAfter", []string{"before", "after"}, ""}, {"proofPoints", []string{"text"}, ""}, {"limitations", []string{"text"}, ""}, {"faqs", []string{"question", "answer"}, " "},
	} {
		if _, ok := spec[section.name]; !ok {
			continue
		}
		var values []json.RawMessage
		if json.Unmarshal(spec[section.name], &values) != nil || values == nil {
			return nil, nil, errors.New("invalid spec section")
		}
		for i, value := range values {
			if err := add(fmt.Sprintf("%s.%d", section.name, i), value, section.fields, section.join); err != nil {
				return nil, nil, err
			}
		}
	}
	if raw, ok := spec["messaging"]; ok {
		var messaging map[string]json.RawMessage
		if json.Unmarshal(raw, &messaging) != nil || messaging == nil {
			return nil, nil, errors.New("invalid messaging")
		}
		var pillars []json.RawMessage
		if raw, ok := messaging["pillars"]; ok {
			if json.Unmarshal(raw, &pillars) != nil {
				return nil, nil, errors.New("invalid messaging pillars")
			}
		}
		for i, raw := range pillars {
			if err := add(fmt.Sprintf("messaging.pillars.%d", i), raw, []string{"title", "message"}, ": "); err != nil {
				return nil, nil, err
			}
		}
		if err := add("messaging.positioning", messaging["positioning"], []string{"statement"}, ""); err != nil {
			return nil, nil, err
		}
	}
	if len(claims) > MaxClaimsPerSpec {
		return nil, nil, errors.New("too many spec claims")
	}
	return claims, spec, nil
}

// BindSpecClaims writes identities only in a new spec, before its transaction
// commits. Old approved content is never rewritten by the migration adapter.
func BindSpecClaims(spec map[string]json.RawMessage, claims []SpecClaimPath) (json.RawMessage, error) {
	for _, claim := range claims {
		if claim.ClaimID == "" || claim.ClaimVersionID == "" {
			return nil, errors.New("missing stable claim identity")
		}
		id, err := json.Marshal(claim.ClaimID)
		if err != nil {
			return nil, err
		}
		version, err := json.Marshal(claim.ClaimVersionID)
		if err != nil {
			return nil, err
		}
		claim.Object["claimId"], claim.Object["claimVersionId"] = id, version
		raw, err := json.Marshal(claim.Object)
		if err != nil {
			return nil, err
		}
		parts := strings.Split(claim.Path, ".")
		if len(parts) == 1 {
			spec[parts[0]] = raw
			continue
		}
		if parts[0] == "messaging" {
			var messaging map[string]json.RawMessage
			if err := json.Unmarshal(spec["messaging"], &messaging); err != nil {
				return nil, err
			}
			if parts[1] == "positioning" {
				messaging["positioning"] = raw
			} else {
				var list []json.RawMessage
				if err := json.Unmarshal(messaging["pillars"], &list); err != nil {
					return nil, err
				}
				var index int
				if _, err := fmt.Sscanf(parts[2], "%d", &index); err != nil || index < 0 || index >= len(list) {
					return nil, errors.New("invalid claim path")
				}
				list[index] = raw
				encoded, err := json.Marshal(list)
				if err != nil {
					return nil, err
				}
				messaging["pillars"] = encoded
			}
			encoded, err := json.Marshal(messaging)
			if err != nil {
				return nil, err
			}
			spec["messaging"] = encoded
		} else {
			var list []json.RawMessage
			if err := json.Unmarshal(spec[parts[0]], &list); err != nil {
				return nil, err
			}
			var index int
			if _, err := fmt.Sscanf(parts[1], "%d", &index); err != nil || index < 0 || index >= len(list) {
				return nil, errors.New("invalid claim path")
			}
			list[index] = raw
			encoded, err := json.Marshal(list)
			if err != nil {
				return nil, err
			}
			spec[parts[0]] = encoded
		}
	}
	return json.Marshal(spec)
}

// ClaimImportProgress is committed with each bounded legacy import batch.
type ClaimImportProgress struct {
	Cursor         string   `json:"cursor"`
	Imported       int      `json:"imported"`
	Skipped        int      `json:"skipped"`
	Invalid        int      `json:"invalid"`
	Done           bool     `json:"done"`
	InvalidSpecIDs []string `json:"invalidSpecIds"`
}
