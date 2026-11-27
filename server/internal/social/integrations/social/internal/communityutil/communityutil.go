// Package communityutil holds the JavaScript semantics the community
// providers (whop, telegram, skool, wordpress, listmonk, vk, twitch) rely on:
// slugify, encodeURIComponent, Buffer base64, String()/Number() coercion,
// mime lookups and plain fetch.
package communityutil

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"golang.org/x/text/unicode/norm"
)

// Option is the {id, name} shape the provider tools return to the frontend.
type Option struct {
	ID   any `json:"id"`
	Name any `json:"name"`
}

// DecodeSettings unmarshals a post's settings, treating empty/null as {}.
func DecodeSettings(raw json.RawMessage, v any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

// Fetch is a plain `fetch` (no SocialAbstract retry/classification) through
// the SSRF-safe client. Any status is returned.
func Fetch(ctx context.Context, method, rawURL string, headers map[string]string, body []byte) (*integrations.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := ssrf.Client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 10<<20))
	if err != nil {
		return nil, err
	}
	return &integrations.Response{Status: res.StatusCode, Header: res.Header, Body: data}, nil
}

// OK is Response.ok.
func OK(status int) bool { return status >= 200 && status <= 299 }

// StatusText is Response.statusText ("Not Found" from "404 Not Found").
func StatusText(res *http.Response) string {
	return strings.TrimPrefix(res.Status, strconv.Itoa(res.StatusCode)+" ")
}

// EncodeURIComponent is JavaScript's encodeURIComponent.
func EncodeURIComponent(s string) string {
	escaped := strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
	return strings.NewReplacer("%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(escaped)
}

// DecodeBase64 is Buffer.from(s, 'base64').toString(): both alphabets,
// invalid characters skipped, decoding stops at padding.
func DecodeBase64(s string) string {
	var clean strings.Builder
	for _, r := range s {
		switch {
		case r == '=':
			goto done
		case r == '-':
			clean.WriteByte('+')
		case r == '_':
			clean.WriteByte('/')
		case r == '+' || r == '/' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			clean.WriteRune(r)
		}
	}
done:
	text := clean.String()
	if len(text)%4 == 1 {
		text = text[:len(text)-1]
	}
	out, _ := base64.RawStdEncoding.DecodeString(text)
	return strings.ToValidUTF8(string(out), "�")
}

// JSString is String(v) for decoded JSON values (nil gives "").
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	}
	data, _ := json.Marshal(v)
	return string(data)
}

// JSNumber is Number(v); ok is false for NaN.
func JSNumber(v any) (float64, bool) {
	switch x := v.(type) {
	case nil:
		return 0, true
	case float64:
		return x, true
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	case string:
		t := strings.TrimSpace(x)
		if t == "" {
			return 0, true
		}
		f, err := strconv.ParseFloat(t, 64)
		if err != nil || math.IsNaN(f) {
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// Truthy is JavaScript truthiness for decoded JSON values.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case bool:
		return x
	}
	return true
}

// Substring16 is s.substring(0, n): n UTF-16 code units.
func Substring16(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// Length is validator.js isLength's count (class-validator MinLength):
// code points minus variation selectors.
func Length(s string) int {
	return utf8.RuneCountInString(s) - strings.Count(s, "️") - strings.Count(s, "︎")
}

// LastSegment is path.split('/').pop().
func LastSegment(p string) string {
	return p[strings.LastIndex(p, "/")+1:]
}

// Video types Go's builtin table lacks when the OS has no mime.types.
var videoTypes = map[string]string{
	".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".webm": "video/webm",
	".avi": "video/x-msvideo", ".mkv": "video/x-matroska", ".mpeg": "video/mpeg", ".mpg": "video/mpeg",
}

// MimeType is mime.getType / mime-types lookup: the type for the file
// extension, "" when unknown.
func MimeType(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if ext == "" {
		return ""
	}
	if t, ok := videoTypes[ext]; ok {
		return t
	}
	t, _, _ := strings.Cut(mime.TypeByExtension(ext), ";")
	return t
}

//go:embed charmap.json
var charMapJSON []byte

var charMap = func() map[string]string {
	m := map[string]string{}
	if err := json.Unmarshal(charMapJSON, &m); err != nil {
		panic(err)
	}
	return m
}()

// jsSpace is JavaScript's \s.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func word(r rune) bool {
	return r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
}

// Slugify is slugify(s, {lower: true, strict: true, trim: true}) (slugify 1.6.6).
func Slugify(s string) string {
	var out strings.Builder
	for _, r := range norm.NFC.String(s) {
		appendChar, ok := charMap[string(r)]
		if !ok {
			appendChar = string(r)
		}
		if appendChar == "-" {
			appendChar = " "
		}
		// The default remove pattern, then strict mode's [^A-Za-z0-9\s].
		for _, c := range appendChar {
			if (word(c) && c != '_') || jsSpace(c) {
				out.WriteRune(c)
			}
		}
	}
	var slug strings.Builder
	space := false
	for _, r := range strings.TrimFunc(out.String(), jsSpace) {
		if jsSpace(r) {
			space = true
			continue
		}
		if space {
			slug.WriteByte('-')
			space = false
		}
		slug.WriteRune(r)
	}
	return strings.ToLower(slug.String())
}
