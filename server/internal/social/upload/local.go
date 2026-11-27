package upload

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
)

// storageAllowedMime is what the storage providers accept (the media
// library list plus audio for generated voice tracks).
var storageAllowedMime = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/gif":  true,
	"image/webp": true,
	"image/avif": true,
	"image/bmp":  true,
	"image/tiff": true,
	"video/mp4":  true,
	"audio/mpeg": true,
	"audio/mp4":  true,
	"audio/wav":  true,
	"audio/ogg":  true,
}

// LocalStorage stores files on disk under UPLOAD_DIRECTORY, served by the
// frontend under /uploads.
type LocalStorage struct {
	uploadDirectory string
}

func NewLocalStorage(uploadDirectory string) *LocalStorage {
	return &LocalStorage{uploadDirectory: uploadDirectory}
}

// newFilePath puts files under /YYYY/MM/DD with a random name and creates
// the folder.
func (s *LocalStorage) newFilePath(ext string) (filename, filePath, publicPath string, err error) {
	now := time.Now()
	innerPath := fmt.Sprintf("/%d/%02d/%02d", now.Year(), int(now.Month()), now.Day())
	dir := s.uploadDirectory + innerPath
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", "", "", err
	}

	var name strings.Builder
	for range 32 {
		// Math.round(Math.random() * 16).toString(16)
		name.WriteString(strconv.FormatInt(int64(math.Round(rand.Float64()*16)), 16))
	}

	filename = name.String() + "." + ext
	return filename, dir + "/" + filename, os.Getenv("FRONTEND_URL") + "/uploads" + innerPath + "/" + filename, nil
}

// fetchSimple loads the body uploadSimple stores: a data URL or a safe
// public https URL.
func fetchSimple(ctx context.Context, path string) ([]byte, error) {
	if strings.HasPrefix(path, "data:") {
		if data, _, ok := ParseDataURL(path); ok {
			return data, nil
		}
	}
	if !ssrf.IsSafePublicHTTPSURL(ctx, path) {
		return nil, errors.New("Unsafe URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	// Profile URLs can come from a customer-selected Mastodon instance. Keep
	// the dial-time check even when self-hosters disable the general guard,
	// and never follow a public avatar's redirect onto a private network.
	res, err := ssrf.PublicClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	const maxSimpleBytes = 100 << 20
	data, err := io.ReadAll(io.LimitReader(res.Body, maxSimpleBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxSimpleBytes {
		return nil, errors.New("Media file exceeds 100 MiB limit.")
	}
	return data, nil
}

func (s *LocalStorage) UploadSimple(ctx context.Context, path string) (string, error) {
	body, err := fetchSimple(ctx, path)
	if err != nil {
		return "", err
	}

	// Never trust the claimed mime/extension (data URL header, remote
	// content-type, or URL path): sniff the real type from the bytes and
	// only accept the allow-list, otherwise an attacker could write an
	// arbitrary file (e.g. .html/.svg with embedded script) into the
	// publicly served uploads directory on the app's own origin.
	detected := DetectFileType(body)
	if detected == nil || !storageAllowedMime[detected.Mime] {
		return "", errors.New("Unsupported file type.")
	}

	_, filePath, publicURL, err := s.newFilePath(detected.Ext)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filePath, body, 0o644); err != nil {
		return "", err
	}
	return publicURL, nil
}

func (s *LocalStorage) UploadFile(ctx context.Context, file File) (*UploadedStream, error) {
	uploaded, err := func() (*UploadedStream, error) {
		detected := DetectFileType(file.Buffer)
		if detected == nil || !storageAllowedMime[detected.Mime] {
			return nil, errors.New("Unsupported file type.")
		}
		filename, filePath, path, err := s.newFilePath(detected.Ext)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(filePath, file.Buffer, 0o644); err != nil {
			return nil, err
		}
		return &UploadedStream{Filename: filename, Path: path, Mimetype: detected.Mime, Originalname: filename}, nil
	}()
	if err != nil {
		slog.Error("Error uploading file to Local Storage:", "error", err)
	}
	return uploaded, err
}

func (s *LocalStorage) UploadStream(ctx context.Context, body io.Reader, mimetype, ext string) (*UploadedStream, error) {
	uploaded, err := func() (*UploadedStream, error) {
		if !storageAllowedMime[mimetype] {
			return nil, errors.New("Unsupported file type.")
		}
		filename, filePath, path, err := s.newFilePath(ext)
		if err != nil {
			return nil, err
		}
		f, err := os.Create(filePath)
		if err != nil {
			return nil, err
		}
		_, err = io.Copy(f, body)
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			// Don't leave a truncated file behind (size cap hit, remote closed, ...)
			_ = s.RemoveFile(ctx, filePath)
			return nil, err
		}
		return &UploadedStream{Filename: filename, Path: path, Mimetype: mimetype, Originalname: filename}, nil
	}()
	if err != nil {
		slog.Error("Error streaming file to Local Storage:", "error", err)
	}
	return uploaded, err
}

// RemoveFile accepts either the public URL or the filesystem path.
func (s *LocalStorage) RemoveFile(ctx context.Context, filePath string) error {
	publicPrefix := os.Getenv("FRONTEND_URL") + "/uploads"
	localPath := filePath
	if strings.HasPrefix(filePath, publicPrefix) {
		localPath = s.uploadDirectory + filePath[len(publicPrefix):]
	}
	return os.Remove(localPath)
}
