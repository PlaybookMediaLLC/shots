package x

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/mediaresize"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/ssrf"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
	_ "golang.org/x/image/webp"
)

// mediaFacts describe the exact staged bytes uploaded by this adapter. Pending
// facts are checked against fresh account limits before attaching their IDs.
type mediaFacts struct {
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	VideoCodec string `json:"videoCodec,omitempty"`
	MIME       string `json:"mime"`
	Bytes      int64  `json:"bytes"`
	DurationMS int64  `json:"durationMs,omitempty"`
}

type stagedMedia struct {
	file    *os.File
	facts   mediaFacts
	alt     string
	entryID string
}

func (m stagedMedia) close() {
	_ = m.file.Close()
	_ = os.Remove(m.file.Name())
}

func checkMediaFacts(caps socialidentity.XCapabilities, facts []mediaFacts, article bool) error {
	media := make([]socialidentity.XMedia, len(facts))
	for i, f := range facts {
		media[i] = socialidentity.XMedia{MIME: f.MIME, Bytes: f.Bytes}
		if article && f.MIME != "image/png" && f.MIME != "image/jpeg" && f.MIME != "image/webp" {
			return publishRejected("X Articles support static PNG, JPEG or WebP images. Choose another attachment.")
		}
		if f.MIME == "video/mp4" && (caps.VideoMaxDurationSeconds == nil || f.DurationMS < 500 || f.DurationMS > int64(*caps.VideoMaxDurationSeconds)*1000) {
			return publishRejected("The video duration exceeds this X account's verified allowance or is shorter than 0.5 seconds.")
		}
		if article {
			if err := socialidentity.CheckXMedia(caps, media[i:i+1]); err != nil {
				return publishRejected(err.Error())
			}
		}
	}
	if !article {
		if err := socialidentity.CheckXMedia(caps, media); err != nil {
			return publishRejected(err.Error())
		}
	}
	return nil
}

// stageMedia reads a single GET (including presigned URLs) or regular local
// file, inspects its real type, and copies it into a private immutable upload
// snapshot. Size bounds apply even to chunked or dishonest HTTP responses.
func stageMedia(ctx context.Context, source string, caps socialidentity.XCapabilities, article bool) (_ stagedMedia, err error) {
	if err := ctx.Err(); err != nil {
		return stagedMedia{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	var reader io.ReadCloser
	parsed, parseErr := url.Parse(source)
	if parseErr != nil || parsed.User != nil {
		return stagedMedia{}, publishRejected("Choose a valid X media source.")
	}
	if parsed.Scheme == "http" || parsed.Scheme == "https" {
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if e != nil {
			return stagedMedia{}, publishRejected("The X media source could not be read.")
		}
		req.Header.Set("Accept-Encoding", "identity")
		client := *ssrf.Client()
		client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		res, e := client.Do(req)
		if e != nil {
			if ctx.Err() != nil {
				return stagedMedia{}, ctx.Err()
			}
			// Shots could not read its own media, before any X call: no post was sent.
			return stagedMedia{}, publishRejected("The X media source is unavailable. Nothing was sent to X; retry when the media can be read.")
		}
		reader = res.Body
		if res.StatusCode != http.StatusOK {
			_ = reader.Close()
			return stagedMedia{}, publishRejected("The complete X media source could not be read. Redirects and partial responses are not accepted.")
		}
	} else {
		if parsed.Scheme != "" || strings.HasPrefix(source, "//") {
			return stagedMedia{}, publishRejected("Choose a valid X media source.")
		}
		file, e := os.OpenFile(source, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if e != nil {
			return stagedMedia{}, publishRejected("The X media file could not be read.")
		}
		info, e := file.Stat()
		if e != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			return stagedMedia{}, publishRejected("Choose a regular X media file.")
		}
		reader = file
	}
	defer reader.Close()
	prefix := make([]byte, 512)
	n, e := io.ReadFull(contextMediaReader{ctx: ctx, reader: reader}, prefix)
	if e != nil && e != io.EOF && e != io.ErrUnexpectedEOF {
		return stagedMedia{}, publishRejected("The X media source could not be read.")
	}
	prefix = prefix[:n]
	mime := http.DetectContentType(prefix)
	limit := caps.ImageMaxBytes
	switch mime {
	case "image/png", "image/jpeg", "image/webp":
	case "image/gif":
		limit = caps.GIFMaxBytes
	case "video/mp4":
		if caps.VideoMaxBytes == nil {
			return stagedMedia{}, publishRejected("Reconnect X to verify this account's video limits.")
		}
		limit = *caps.VideoMaxBytes
	default:
		return stagedMedia{}, publishRejected("X supports JPEG, PNG, WebP, GIF or MP4 files. The selected file's contents do not match a supported format.")
	}
	if article && (mime == "image/gif" || mime == "video/mp4") {
		return stagedMedia{}, publishRejected("X Articles support static PNG, JPEG or WebP images.")
	}
	readLimit := limit
	if mediaresize.Static(mime) {
		readLimit = max(limit, mediaresize.MaxSourceBytes)
	}
	file, e := os.CreateTemp("", "shots-x-media-*")
	if e != nil {
		return stagedMedia{}, errors.New("Temporary X media storage is unavailable")
	}
	item := stagedMedia{file: file, facts: mediaFacts{MIME: mime}}
	defer func() {
		if err != nil {
			item.close()
		}
	}()
	size, e := io.Copy(file, io.LimitReader(io.MultiReader(bytes.NewReader(prefix), contextMediaReader{ctx: ctx, reader: reader}), readLimit+1))
	if ctx.Err() != nil {
		return stagedMedia{}, ctx.Err()
	}
	if e != nil {
		return stagedMedia{}, errors.New("The complete X media source could not be stored")
	}
	if size == 0 || size > readLimit {
		return stagedMedia{}, publishRejected("The X media file exceeds this account's verified size limit.")
	}
	item.facts.Bytes = size
	if mime == "video/mp4" {
		item.facts.DurationMS, err = inspectMP4(ctx, file, size, &item.facts)
	} else {
		data, e := io.ReadAll(io.NewSectionReader(file, 0, size))
		if e != nil {
			return stagedMedia{}, publishRejected("The X image could not be read.")
		}
		if size > limit {
			resized, resizedMIME, e := mediaresize.Fit(data, mime, limit)
			if e != nil {
				return stagedMedia{}, publishRejected(e.Error())
			}
			if e = file.Truncate(0); e != nil {
				return stagedMedia{}, e
			}
			if _, e = file.Seek(0, io.SeekStart); e != nil {
				return stagedMedia{}, e
			}
			if _, e = file.Write(resized); e != nil {
				return stagedMedia{}, e
			}
			data = resized
			mime = resizedMIME
			item.facts.Bytes = int64(len(data))
			item.facts.MIME = mime
		}
		err = inspectImage(data, mime)
	}
	if err != nil {
		return stagedMedia{}, err
	}
	if err = checkMediaFacts(caps, []mediaFacts{item.facts}, article); err != nil {
		return stagedMedia{}, err
	}
	return item, nil
}

func inspectImage(data []byte, mime string) error {
	if mime == "image/gif" {
		return inspectGIF(data)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || "image/"+format != mime {
		return publishRejected("Choose a valid PNG, JPEG or WebP image for X.")
	}
	// Inspect containers without allocating a bitmap from untrusted dimensions.
	if err := checkImageContainer(data, mime); err != nil {
		return err
	}
	return nil
}

// Local reads also stop between chunks when the activity is cancelled.
type contextMediaReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextMediaReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func checkPhotoTagFacts(ids []string, facts []mediaFacts) error {
	media := make([]socialidentity.XMedia, len(facts))
	for i, f := range facts {
		media[i] = socialidentity.XMedia{MIME: f.MIME, Bytes: f.Bytes}
	}
	if err := socialidentity.CheckXPhotoTags(ids, media); err != nil {
		return publishRejected(err.Error())
	}
	return nil
}
