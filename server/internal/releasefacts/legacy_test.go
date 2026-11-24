package releasefacts

import (
	"encoding/json"
	"testing"
)

func TestLegacyClaimPathsAndStableReorder(t *testing.T) {
	raw := []byte(`{"summary":{"text":"Summary","sources":["S1"]},"capabilities":[{"name":"One","description":"Same","sources":["S1"]},{"name":"Two","description":"Same","sources":["S1"]}],"beforeAfter":[{"before":"Old","after":"New","sources":["brief"]}],"messaging":{"pillars":[],"positioning":{"statement":"Position","sources":["brief"]}}}`)
	claims, spec, err := LegacySpecClaims(raw)
	if err != nil || len(claims) != 5 {
		t.Fatalf("claims=%+v err=%v", claims, err)
	}
	for i := range claims {
		claims[i].ClaimID = "claim-" + claims[i].Path
		claims[i].ClaimVersionID = "version-" + claims[i].Path
	}
	content, err := BindSpecClaims(spec, claims)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(content, &decoded); err != nil {
		t.Fatal(err)
	}
	var capabilities []json.RawMessage
	if err := json.Unmarshal(decoded["capabilities"], &capabilities); err != nil {
		t.Fatal(err)
	}
	capabilities[0], capabilities[1] = capabilities[1], capabilities[0]
	decoded["capabilities"], err = json.Marshal(capabilities)
	if err != nil {
		t.Fatal(err)
	}
	reordered, err := json.Marshal(decoded)
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := LegacySpecClaims(reordered)
	if err != nil {
		t.Fatal(err)
	}
	if next[1].Path != "capabilities.0" || next[1].ClaimID != "claim-capabilities.1" || next[1].Text != "Two: Same" || next[3].Text != "Before: Old After: New" {
		t.Fatalf("reordered identities=%+v", next)
	}
	for _, invalid := range []string{`{"summary":{"text":"bad","claimId":"c"}}`, `{"summary":{"text":"\ud800"}}`, `{"summary":{"text":"first","text":"second"}}`} {
		if _, _, err := LegacySpecClaims([]byte(invalid)); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
}
