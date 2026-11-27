package product

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"hash"
	"image"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mediadocument"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mediaimage"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/medialimits"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mediavideo"
)

// assetDecodeSem caps concurrent full image/PDF decodes during upload
// completion to avoid OOM spikes under concurrent large uploads.
var assetDecodeSem = make(chan struct{}, min(4, max(1, runtime.GOMAXPROCS(0))))

// Upload checks (RFC 025): an upload's bytes must be what it says it is,
// checked from storage when it completes, so a renamed file cannot pass as
// an image or a PDF. A PDF is also held to LinkedIn's document limits.

// objectOpener streams a stored object, to check an upload's bytes.
type objectOpener interface {
	Open(ctx context.Context, key string) (io.ReadCloser, error)
}

// openObject streams a stored object, or reads it whole from a store that cannot stream.
func (c *Configuration) openObject(ctx context.Context, key string) (io.ReadCloser, error) {
	if opener, ok := c.objects.(objectOpener); ok {
		return opener.Open(ctx, key)
	}
	data, err := c.objects.Read(ctx, key)
	if err != nil {
		return nil, err
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

// sniffedTypes are the media types whose first bytes are checked, and what
// net/http's sniffer reports for each.
var sniffedTypes = map[string]string{
	"image/gif": "image/gif", "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp",
	"video/mp4": "video/mp4", "video/webm": "video/webm",
}

// verifyAssetBytes checks an object's bytes against its declared type.
func verifyAssetBytes(mediaType string, object io.Reader) error {
	_, err := verifyAssetBytesWithDimensions(context.Background(), mediaType, object)
	return err
}

func acquireDecodeSlot(ctx context.Context) (func(), error) {
	select {
	case assetDecodeSem <- struct{}{}:
		return func() { <-assetDecodeSem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// verifyAssetBytesWithDimensions checks an object's bytes against its declared
// type and returns image dimensions when an image was inspected.
func verifyAssetBytesWithDimensions(ctx context.Context, mediaType string, object io.Reader) (*image.Config, error) {
	reader := bufio.NewReaderSize(object, 4096)
	head, _ := reader.Peek(512)
	if mediaType == "application/pdf" {
		if !bytes.HasPrefix(head, []byte("%PDF-")) {
			return nil, invalid("This file is not a PDF.")
		}
		release, err := acquireDecodeSlot(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		pages, known := countPDFPages(reader)
		if !known {
			return nil, invalid("This PDF is malformed, encrypted, or has an unreadable page tree.")
		}
		if pages > medialimits.Limits.PDFPages {
			return nil, invalid("LinkedIn takes documents of up to 300 pages; this one has " + strconv.Itoa(pages) + ".")
		}
		return nil, nil
	}
	want, checked := sniffedTypes[mediaType]
	if !checked {
		return nil, nil
	}
	got := http.DetectContentType(head)
	if !strings.HasPrefix(got, want) {
		return nil, invalid("This file's contents are not a " + mediaType + " file.")
	}
	if strings.HasPrefix(mediaType, "image/") {
		release, err := acquireDecodeSlot(ctx)
		if err != nil {
			return nil, err
		}
		defer release()
		data, err := io.ReadAll(io.LimitReader(reader, int64(medialimits.Limits.PaidImageBytes)+1))
		if err != nil {
			return nil, err
		}
		if len(data) > medialimits.Limits.PaidImageBytes {
			return nil, invalid("The image exceeds 20 MB.")
		}
		dimensions, err := decodeAssetDimensions(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		if mediaType == "image/gif" {
			if err := mediaimage.ValidateGIF(data, mediaimage.GIFLimits{MaxWidth: 65535, MaxHeight: 65535, MaxFrames: 1000, MaxCanvasPixels: 300000000}); err != nil {
				return nil, invalid(err.Error())
			}
			return dimensions, nil
		}
		if _, _, err := image.Decode(bytes.NewReader(data)); err != nil {
			return nil, invalid("The image is incomplete or cannot be decoded.")
		}
		return dimensions, nil
	}
	return nil, nil
}

// countPDFPages shares the same parser with the native document publisher.
func countPDFPages(object io.Reader) (int, bool) { return mediadocument.CountPages(object) }

// probedVideo are the containers whose movie header scheduling reads.
var probedVideo = map[string]bool{"video/mp4": true, "video/quicktime": true}

// partHashes hashes a stream in multipart upload parts.
type partHashes struct {
	current hash.Hash
	filled  int
	sums    []string
}

func (p *partHashes) Write(data []byte) (int, error) {
	written := len(data)
	for len(data) > 0 {
		if p.current == nil {
			p.current, p.filled = sha256.New(), 0
		}
		take := min(len(data), uploadPartBytes-p.filled)
		p.current.Write(data[:take])
		p.filled += take
		data = data[take:]
		if p.filled == uploadPartBytes {
			p.close()
		}
	}
	return written, nil
}

func (p *partHashes) close() {
	if p.current != nil {
		p.sums = append(p.sums, fmt.Sprintf("%x", p.current.Sum(nil)))
		p.current = nil
	}
}

// uploadedContent is what verification read: the bytes' SHA-256, image
// dimensions, and, for an MP4 or QuickTime movie, what the container holds.
type uploadedContent struct {
	dimensions *image.Config
	video      *mediavideo.Info
	sha256     string
}

// verifyUploadedContent consumes at most the reserved size plus one byte. Neither
// a dishonest Content-Length nor a caller-supplied checksum establishes readiness.
// partDigests, when given, are each upload part's expected SHA-256.
func verifyUploadedContent(ctx context.Context, source io.Reader, mediaType string, size int, digest *string, partDigests ...string) (uploadedContent, error) {
	hash := sha256.New()
	parts := &partHashes{}
	limited := &io.LimitedReader{R: source, N: int64(size) + 1}
	reader := bufio.NewReader(io.TeeReader(limited, io.MultiWriter(hash, parts)))
	dimensions, err := verifyAssetBytesWithDimensions(ctx, mediaType, reader)
	if err != nil {
		return uploadedContent{}, err
	}
	var video *mediavideo.Info
	var probeErr error
	if probedVideo[mediaType] {
		info, err := mediavideo.Probe(reader)
		video, probeErr = &info, err
	}
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return uploadedContent{}, err
	}
	if int64(size)+1-limited.N != int64(size) {
		return uploadedContent{}, invalid("The stored file size differs from the reserved upload. Upload the complete file again.")
	}
	if digest != nil && !strings.EqualFold(fmt.Sprintf("%x", hash.Sum(nil)), *digest) {
		return uploadedContent{}, invalid("The uploaded file checksum does not match. Upload the file again.")
	}
	parts.close()
	for i, want := range partDigests {
		if i >= len(parts.sums) || !strings.EqualFold(parts.sums[i], want) {
			return uploadedContent{}, invalid(fmt.Sprintf("Part %d of the upload differs from the file that was sent. Upload the file again.", i+1))
		}
	}
	if probeErr != nil {
		return uploadedContent{}, invalid("This file is not a complete MP4 or MOV video. Export it again and upload the whole file.")
	}
	return uploadedContent{dimensions: dimensions, video: video, sha256: fmt.Sprintf("%x", hash.Sum(nil))}, nil
}
