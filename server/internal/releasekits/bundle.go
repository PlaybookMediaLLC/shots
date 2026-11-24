package releasekits

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releasefacts"
)

func SafeFileName(name string) bool {
	if name == "" || len(name) > 240 || !utf8.ValidString(name) || strings.Contains(name, "\\") || path.IsAbs(name) || path.Clean(name) != name {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || part == "." || part == "" || strings.HasPrefix(part, ".") {
			return false
		}
	}
	for _, c := range name {
		if unicode.IsControl(c) || strings.ContainsRune(":*?\"<>|", c) {
			return false
		}
	}
	return slices.Contains([]string{".md", ".png", ".jpg", ".webp", ".json"}, path.Ext(name))
}

// Bundle fixes entry order, time, mode and compression. It never receives the
// internal manifest, so private lineage cannot accidentally become a public index.
func Bundle(index PublicIndex, files map[string][]byte) ([]byte, error) {
	if len(files) == 0 || len(files) > MaxArtifacts || len(index.Files) != len(files) {
		return nil, errors.New("invalid bundle file count")
	}
	index.Files = append([]File{}, index.Files...)
	slices.SortFunc(index.Files, func(a, b File) int { return strings.Compare(a.Name, b.Name) })
	index.AudienceIDs = slices.Clone(index.AudienceIDs)
	slices.Sort(index.AudienceIDs)
	names, total := map[string]bool{}, 0
	for _, file := range index.Files {
		body, ok := files[file.Name]
		if !ok || !SafeFileName(file.Name) || file.Name == "manifest.json" || names[file.Name] || file.ByteLength != len(body) || file.SHA256 != releasefacts.ByteHash(body) {
			return nil, errors.New("invalid bundle file")
		}
		names[file.Name] = true
		total += len(body)
		if total > MaxBundleBytes {
			return nil, errors.New("bundle exceeds 100 MiB")
		}
	}
	manifest, err := json.Marshal(index)
	if err != nil {
		return nil, err
	}
	if total+len(manifest) > MaxBundleBytes {
		return nil, errors.New("bundle exceeds 100 MiB")
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	all := append([]File{}, index.Files...)
	all = append(all, File{Name: "manifest.json"})
	slices.SortFunc(all, func(a, b File) int { return strings.Compare(a.Name, b.Name) })
	for _, file := range all {
		header := &zip.FileHeader{Name: file.Name, Method: zip.Store}
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		header.SetMode(0644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return nil, err
		}
		body := files[file.Name]
		if file.Name == "manifest.json" {
			body = manifest
		}
		if _, err := io.Copy(entry, bytes.NewReader(body)); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
