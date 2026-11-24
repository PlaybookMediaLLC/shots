package releasefacts

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// CanonicalHash implements RFC 8785 for the readiness contract's safe-integer
// JSON subset. Fractional numbers are not part of a readiness manifest.
func CanonicalHash(domain string, value any) (string, []byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", nil, err
	}
	canonical, err := CanonicalJSON(raw)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(append([]byte(domain+"\n"), canonical...))
	return hex.EncodeToString(digest[:]), canonical, nil
}

// CanonicalJSON rejects duplicate keys, invalid Unicode and unsupported numbers
// instead of changing their meaning while constructing a review identity.
func CanonicalJSON(raw []byte) ([]byte, error) {
	if !utf8.Valid(raw) || !validJSONSurrogates(raw) {
		return nil, errors.New("invalid JSON Unicode")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	result, err := canonicalJSONValue(d, 0)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("unexpected trailing JSON")
	}
	return result, nil
}

func canonicalJSONValue(d *json.Decoder, depth int) ([]byte, error) {
	if depth > 64 {
		return nil, errors.New("JSON is too deeply nested")
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch v := t.(type) {
	case nil:
		return []byte("null"), nil
	case bool:
		return []byte(strconv.FormatBool(v)), nil
	case string:
		return canonicalJSONString(v), nil
	case json.Number:
		n, err := strconv.ParseInt(string(v), 10, 64)
		if err != nil || n < -9007199254740991 || n > 9007199254740991 {
			return nil, errors.New("readiness JSON numbers must be safe integers")
		}
		return []byte(strconv.FormatInt(n, 10)), nil
	case json.Delim:
		switch v {
		case '[':
			out := []byte{'['}
			for d.More() {
				if len(out) > 1 {
					out = append(out, ',')
				}
				item, err := canonicalJSONValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, item...)
			}
			if end, err := d.Token(); err != nil || end != json.Delim(']') {
				return nil, errors.New("invalid JSON array")
			}
			return append(out, ']'), nil
		case '{':
			values := map[string][]byte{}
			keys := []string{}
			for d.More() {
				keyToken, err := d.Token()
				key, ok := keyToken.(string)
				if err != nil || !ok {
					return nil, errors.New("invalid JSON object key")
				}
				if _, exists := values[key]; exists {
					return nil, errors.New("duplicate JSON object key")
				}
				value, err := canonicalJSONValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				keys, values[key] = append(keys, key), value
			}
			if end, err := d.Token(); err != nil || end != json.Delim('}') {
				return nil, errors.New("invalid JSON object")
			}
			slices.SortFunc(keys, func(a, b string) int { return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b))) })
			out := []byte{'{'}
			for i, key := range keys {
				if i > 0 {
					out = append(out, ',')
				}
				out = append(out, canonicalJSONString(key)...)
				out = append(out, ':')
				out = append(out, values[key]...)
			}
			return append(out, '}'), nil
		}
	}
	return nil, errors.New("invalid JSON value")
}

func canonicalJSONString(value string) []byte {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\t':
			out.WriteString(`\t`)
		case '\n':
			out.WriteString(`\n`)
		case '\f':
			out.WriteString(`\f`)
		case '\r':
			out.WriteString(`\r`)
		default:
			if r < 0x20 {
				out.WriteString(`\u00`)
				out.WriteByte("0123456789abcdef"[r>>4])
				out.WriteByte("0123456789abcdef"[r&15])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return []byte(out.String())
}

func validJSONSurrogates(raw []byte) bool {
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if i >= len(raw) || raw[i] != 'u' || i+4 >= len(raw) {
			continue
		}
		first, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		i += 4
		if first < 0xd800 || first > 0xdfff {
			continue
		}
		if first > 0xdbff || i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return false
		}
		second, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || second < 0xdc00 || second > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}
