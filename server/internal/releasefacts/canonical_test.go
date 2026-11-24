package releasefacts

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestReadinessCanonicalJSON(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{`{"z":[],"a":{"c":null,"b":true}}`, `{"a":{"b":true,"c":null},"z":[]}`},
		{`{"n":-0,"max":9007199254740991}`, `{"max":9007199254740991,"n":0}`},
		{`{"\ufffd":1,"\ud83d\ude00":2,"a":3}`, "{\"a\":3,\"😀\":2,\"�\":1}"},
		{`{"text":"\u003c\u0026\u2028\u2029\b\t\n\f\r\u0000"}`, "{\"text\":\"<&\u2028\u2029\\b\\t\\n\\f\\r\\u0000\"}"},
		{`["\\ud800","\ud800\udc00","é"]`, `["\\ud800","𐀀","é"]`},
	} {
		got, err := CanonicalJSON([]byte(tc.raw))
		if err != nil || string(got) != tc.want {
			t.Errorf("canonical(%s)=%s, %v; want %s", tc.raw, got, err, tc.want)
		}
		again, err := CanonicalJSON(got)
		if err != nil || !bytes.Equal(again, got) {
			t.Errorf("canonical bytes are not stable: %s, %v", again, err)
		}
	}
	for _, raw := range []string{`{"x":1,"x":2}`, `{"x":1,"\u0078":2}`, `"\ud800"`, `"\udc00"`, `"\ud800\u0061"`,
		`1.2`, `1e2`, `9007199254740992`, `-9007199254740992`, `{} {}`, `{"x":]}`, "\"\xff\"", strings.Repeat("[", 66) + strings.Repeat("]", 66)} {
		if got, err := CanonicalJSON([]byte(raw)); err == nil {
			t.Errorf("accepted invalid input %q as %s", raw, got)
		}
	}
	a, canonical, err := CanonicalHash("shots.claim.v1", json.RawMessage(`{"z":2,"a":1}`))
	b, _, otherErr := CanonicalHash("shots.claim.v1", map[string]int{"a": 1, "z": 2})
	c, _, domainErr := CanonicalHash("shots.kit.v1", map[string]int{"a": 1, "z": 2})
	if err != nil || otherErr != nil || domainErr != nil || a != b || a == c || a != ByteHash(append([]byte("shots.claim.v1\n"), canonical...)) {
		t.Fatalf("hash identity mismatch: %s %s %s; errors %v %v %v", a, b, c, err, otherErr, domainErr)
	}
}

func TestReadinessCrossLanguageVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct{ Raw, Canonical, Domain, SHA256 string }
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		hash, canonical, err := CanonicalHash(vector.Domain, json.RawMessage(vector.Raw))
		if err != nil || hash != vector.SHA256 || string(canonical) != vector.Canonical {
			t.Fatalf("vector %s: %s %s %v", vector.Raw, canonical, hash, err)
		}
	}
}
