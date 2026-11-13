package x

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/integrations"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/temporalx"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialidentity"
)

func videoFixture(t *testing.T, total int) []byte {
	t.Helper()
	data, err := os.ReadFile("testdata/sample.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if total > len(data) {
		padding := make([]byte, total-len(data))
		if len(padding) < 8 {
			t.Fatal("fixture padding needs a box header")
		}
		binary.BigEndian.PutUint32(padding, uint32(len(padding)))
		copy(padding[4:8], "free")
		data = append(data, padding...)
	}
	return data
}

func TestStageRealMP4(t *testing.T) {
	data := videoFixture(t, 0)
	source := t.TempDir() + "/video.bin"
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("Premium"))
	item, err := stageMedia(context.Background(), source, caps, false)
	if err != nil {
		t.Fatal(err)
	}
	defer item.close()
	if err := os.WriteFile(source, []byte("source replaced after staging"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("MP4 duration=%d size=%d", item.facts.DurationMS, item.facts.Bytes)
	saved, err := os.ReadFile(item.file.Name())
	if err != nil || !bytes.Equal(saved, data) || item.facts.MIME != "video/mp4" || item.facts.DurationMS < 500 {
		t.Fatal("video source changed or facts missing")
	}
}

func gifFixture(t *testing.T, frames int) []byte {
	t.Helper()
	g := &gif.GIF{Config: image.Config{Width: 1, Height: 1, ColorModel: color.Palette{color.Black, color.White}}}
	for i := 0; i < frames; i++ {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, 1, 1), color.Palette{color.Black, color.White}))
		g.Delay = append(g.Delay, 1)
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, g); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestMediaUploadsOriginalBytesAndCategory(t *testing.T) {
	var jpegData bytes.Buffer
	if err := jpeg.Encode(&jpegData, image.NewRGBA(image.Rect(0, 0, 2048, 10)), nil); err != nil {
		t.Fatal(err)
	}
	webp, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, mime, category string
		data                 []byte
	}{
		{"PNG", "image/png", "tweet_image", pngBytes()},
		{"JPEG", "image/jpeg", "tweet_image", jpegData.Bytes()},
		{"WebP", "image/webp", "tweet_image", webp},
		{"GIF", "image/gif", "tweet_gif", gifFixture(t, 2)},
		{"MP4", "video/mp4", "tweet_video", videoFixture(t, uploadChunkSize+10)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
			temp := t.TempDir()
			t.Setenv("TMPDIR", temp)
			calls, done := fakePublishingX(t, func(r recorded) (int, string) {
				switch r.path {
				case "/misleading.jpeg":
					return 200, string(tc.data)
				case "/2/media/upload/initialize", "/2/media/upload/11/finalize":
					return 200, `{"data":{"id":"11"}}`
				case "/2/media/upload/11/append":
					return 200, `{}`
				}
				t.Errorf("unexpected request: %s", r.path)
				return 404, `{}`
			})
			defer done()
			res, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{ID: "article-cover", Message: "Media", Media: []integrations.MediaContent{{Type: "image", Path: apiBase + "/misleading.jpeg?X-Amz-Signature=private"}}}}, publishingAccount())
			if err != nil {
				t.Fatal(err)
			}
			var uploaded bytes.Buffer
			var init struct {
				MIME     string `json:"media_type"`
				Category string `json:"media_category"`
				Bytes    int    `json:"total_bytes"`
			}
			gets := 0
			for _, r := range *calls {
				if r.path == "/misleading.jpeg" {
					gets++
					if r.method != "GET" || r.query.Get("X-Amz-Signature") != "private" {
						t.Fatal("signed URL changed")
					}
				}
				if r.path == "/2/media/upload/initialize" {
					if err := json.Unmarshal(r.body, &init); err != nil {
						t.Fatal(err)
					}
				}
				if strings.HasSuffix(r.path, "/append") {
					_, params, err := mime.ParseMediaType(r.contentType)
					if err != nil {
						t.Fatal(err)
					}
					parts := multipart.NewReader(bytes.NewReader(r.body), params["boundary"])
					for {
						part, err := parts.NextPart()
						if err == io.EOF {
							break
						}
						if err != nil {
							t.Fatal(err)
						}
						if part.FormName() == "media" {
							if _, err := io.Copy(&uploaded, part); err != nil {
								t.Fatal(err)
							}
						}
					}
				}
			}
			if gets != 1 || !bytes.Equal(uploaded.Bytes(), tc.data) || init.MIME != tc.mime || init.Category != tc.category || init.Bytes != len(tc.data) {
				t.Fatalf("media changed: reads=%d init=%+v bytes=%d", gets, init, uploaded.Len())
			}
			var pending pendingData
			if json.Unmarshal(res[0].PendingData, &pending) != nil || pending.CoverMediaID != "" || len(pending.MediaIDs) != 1 || len(pending.MediaFacts) != 1 || pending.MediaFacts[0].Bytes != int64(len(tc.data)) || pending.MediaFacts[0].MIME != tc.mime {
				t.Fatal("missing upload facts")
			}
			if files, _ := filepath.Glob(filepath.Join(temp, "shots-x-media-*")); len(files) != 0 {
				t.Fatal("staged media leaked")
			}
		})
	}
}

func TestArticleMediaRemainDistinctAndPreserveCoverAlt(t *testing.T) {
	t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
	id := 10
	calls, done := fakePublishingX(t, func(r recorded) (int, string) {
		switch {
		case r.path == "/pic.png":
			return 200, string(pngBytes())
		case strings.HasSuffix(r.path, "/initialize"):
			id++
			return 200, `{"data":{"id":"` + strconv.Itoa(id) + `"}}`
		case strings.HasSuffix(r.path, "/append"), r.path == "/2/media/metadata":
			return 200, `{}`
		case strings.HasSuffix(r.path, "/finalize"):
			return 200, `{"data":{"id":"` + strconv.Itoa(id) + `"}}`
		default:
			t.Errorf("unexpected request: %s", r.path)
			return 404, `{}`
		}
	})
	defer done()
	source := apiBase + "/pic.png"
	post := integrations.PostDetails{ID: "inline-0", Message: `<p>Hello</p><img src="` + source + `">`,
		Media:    []integrations.MediaContent{{Path: source}},
		Settings: marshal(XDto{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("draft"), ArticleCover: &MediaDto{Path: ptr(source), Alt: ptr("The cover description")}}),
	}
	results, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{post}, publishingAccount())
	if err != nil {
		t.Fatal(err)
	}
	var pending pendingData
	if json.Unmarshal(results[0].PendingData, &pending) != nil || len(pending.MediaIDs) != 1 || pending.MediaIDs[0] != "11" || pending.CoverMediaID != "12" || pending.InlineMediaIDs[source] != "13" || len(pending.MediaFacts) != 3 {
		t.Fatalf("media roles mixed: %+v", pending)
	}
	found := false
	for _, r := range *calls {
		if r.path != "/2/media/metadata" {
			continue
		}
		var metadata struct {
			ID       string `json:"id"`
			Metadata struct {
				AltText struct {
					Text string `json:"text"`
				} `json:"alt_text"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal(r.body, &metadata); err != nil {
			t.Fatal(err)
		}
		if metadata.ID != "12" || metadata.Metadata.AltText.Text != "The cover description" {
			t.Fatalf("cover alt changed: %s", r.body)
		}
		found = true
	}
	if !found {
		t.Fatal("cover alt omitted")
	}
}

func TestInvalidMediaSelectionMakesNoProviderMutation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		files   [][]byte
		article bool
		cover   bool
	}{
		{name: "five images", files: [][]byte{pngBytes(), pngBytes(), pngBytes(), pngBytes(), pngBytes()}},
		{name: "GIF with image", files: [][]byte{gifFixture(t, 2), pngBytes()}},
		{name: "video with image", files: [][]byte{videoFixture(t, 0), pngBytes()}},
		{name: "invalid second file", files: [][]byte{pngBytes(), []byte("not an image")}},
		{name: "oversized actual PNG", files: [][]byte{append(pngBytes(), make([]byte, 20000001)...)}},
		{name: "truncated PNG", files: [][]byte{pngBytes()[:len(pngBytes())-1]}},
		{name: "bad PNG CRC", files: [][]byte{append(append([]byte(nil), pngBytes()[:len(pngBytes())-1]...), 0)}},
		{name: "GIF Article", files: [][]byte{gifFixture(t, 2)}, article: true},
		{name: "video Article", files: [][]byte{videoFixture(t, 0)}, article: true},
		{name: "invalid Article cover", files: [][]byte{pngBytes(), []byte("bad cover")}, article: true, cover: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SOCIAL_PRIVATE_MEDIA", "false")
			temp := t.TempDir()
			t.Setenv("TMPDIR", temp)
			var mutations atomic.Int32
			calls, done := fakePublishingX(t, func(r recorded) (int, string) { mutations.Add(1); return 500, `{}` })
			defer done()
			post := integrations.PostDetails{ID: "p", Message: "hello"}
			for i, data := range tc.files {
				file := filepath.Join(temp, string(rune('a'+i))+".png")
				if err := os.WriteFile(file, data, 0600); err != nil {
					t.Fatal(err)
				}
				if tc.cover && i == len(tc.files)-1 {
					post.Settings = marshal(XDto{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("draft"), ArticleCover: &MediaDto{Path: ptr(file)}})
				} else {
					post.Media = append(post.Media, integrations.MediaContent{Path: file})
				}
			}
			if tc.article && !tc.cover {
				post.Settings = marshal(XDto{PostType: ptr("article"), ArticleTitle: ptr("Title"), ArticleStatus: ptr("draft")})
			}
			_, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{post}, publishingAccount())
			if temporalx.FailureType(err) != temporalx.TypePublicationRejected || mutations.Load() != 0 || len(*calls) != 1 {
				t.Fatalf("invalid media was uploaded: %v calls=%d", err, len(*calls))
			}
			if files, _ := filepath.Glob(filepath.Join(temp, "shots-x-media-*")); len(files) != 0 {
				t.Fatal("staged media leaked after failure")
			}
		})
	}
}

func TestMediaSourceRejectsRedirectsSSRFAndCancellation(t *testing.T) {
	var arrived atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { arrived.Add(1); _, _ = w.Write(pngBytes()) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
	t.Setenv("DISABLE_SSRF_PROTECTION", "true")
	if _, err := stageMedia(context.Background(), redirect.URL+"?secret=canary", caps, false); err == nil || strings.Contains(err.Error(), "canary") {
		t.Fatalf("redirect permitted or leaked: %v", err)
	}
	t.Setenv("DISABLE_SSRF_PROTECTION", "false")
	// An unreadable source fails before any X call, so it is a definite rejection, not an unknown delivery.
	if _, err := stageMedia(context.Background(), target.URL, caps, false); temporalx.FailureType(err) != temporalx.TypePublicationRejected {
		t.Fatalf("private network permitted or not a definite rejection: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := stageMedia(ctx, target.URL, caps, false); err != context.Canceled {
		t.Fatalf("cancellation lost: %v", err)
	}
	if arrived.Load() != 0 {
		t.Fatal("unsafe media target reached")
	}
}

func TestGIFFullAnimationLimits(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		frames, width, height int
		valid                 bool
	}{
		{"350 frames", 350, 1, 1, true}, {"351 frames", 351, 1, 1, false},
		{"canvas bound", 1, 1280, 1080, true}, {"width overflow", 1, 1281, 1080, false},
		{"pixel budget", 218, 1280, 1080, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := gifFixture(t, tc.frames)
			binary.LittleEndian.PutUint16(data[6:8], uint16(tc.width))
			binary.LittleEndian.PutUint16(data[8:10], uint16(tc.height))
			if err := inspectGIF(data); (err == nil) != tc.valid {
				t.Fatalf("GIF acceptance=%v: %v", tc.valid, err)
			}
		})
	}
	data := gifFixture(t, 2)
	if inspectGIF(data[:len(data)-1]) == nil {
		t.Fatal("truncated GIF accepted")
	}
}

// Common GIF encoders omit the LZW end code while retaining every frame pixel
// and the enclosing sub-block/trailer. Match Go's GIF decoder for that case only.
func TestGIFCompletePixelsWithoutLZWEndCode(t *testing.T) {
	data, err := base64.StdEncoding.DecodeString("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := gif.DecodeAll(bytes.NewReader(data)); err != nil {
		t.Fatalf("invalid fixture: %v", err)
	}
	if err := inspectGIF(data); err != nil {
		t.Fatalf("complete GIF rejected: %v", err)
	}
	incomplete := append([]byte(nil), data...)
	binary.LittleEndian.PutUint16(incomplete[6:8], 2)
	binary.LittleEndian.PutUint16(incomplete[24:26], 2)
	if inspectGIF(incomplete) == nil {
		t.Fatal("missing frame pixels accepted")
	}
	corrupt := append([]byte(nil), data...)
	corrupt[29] = 0xff
	if inspectGIF(corrupt) == nil {
		t.Fatal("invalid LZW codes accepted")
	}
}

func TestPendingMediaNeedsFactsAndCurrentVideoAllowance(t *testing.T) {
	calls, done := fakeX(t, func(r recorded) (int, string) {
		if r.path == "/2/users/me" {
			return 200, `{"data":{"id":"1","name":"Me","username":"me","subscription_type":"None"}}`
		}
		t.Error("unsupported pending media sent")
		return 500, `{}`
	})
	defer done()
	for _, tc := range []pendingData{
		{MediaIDs: []string{"11"}},
		{MediaIDs: []string{"11"}, MediaFacts: []mediaFacts{{MIME: "video/mp4", Bytes: 1024, DurationMS: 1200001}}},
		{MediaIDs: []string{""}, MediaFacts: []mediaFacts{{MIME: "image/png", Bytes: 100}}},
	} {
		tc.Message = "hi"
		tc.Attempting = true
		tc.Confirmed = true
		if _, err := New().FinalizePost(context.Background(), "a:b", marshal(tc), publishingAccount()); temporalx.FailureType(err) != temporalx.TypePublicationRejected {
			t.Fatalf("pending bypass: %v", err)
		}
	}
	if len(*calls) != 3 {
		t.Fatal("unexpected mutation")
	}
}

func TestMissingOrMismatchedUploadIDStops(t *testing.T) {
	for _, tc := range []struct {
		name, init, final string
		calls             int
	}{
		{"missing init", `{"data":{}}`, `{}`, 2},
		{"unsafe init", `{"data":{"id":"../tweets"}}`, `{}`, 2},
		{"missing finalize", `{"data":{"id":"11"}}`, `{}`, 4},
		{"wrong finalize", `{"data":{"id":"11"}}`, `{"data":{"id":"12"}}`, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls, done := fakePublishingX(t, func(r recorded) (int, string) {
				if strings.HasSuffix(r.path, "/initialize") {
					return 200, tc.init
				}
				if strings.HasSuffix(r.path, "/finalize") {
					return 200, tc.final
				}
				return 200, `{}`
			})
			defer done()
			source := t.TempDir() + "/image.png"
			if err := os.WriteFile(source, pngBytes(), 0600); err != nil {
				t.Fatal(err)
			}
			_, err := New().PostPending(context.Background(), "1", "a:b", []integrations.PostDetails{{ID: "p", Message: "hello", Media: []integrations.MediaContent{{Path: source}}}}, publishingAccount())
			if temporalx.FailureType(err) != temporalx.TypeBadBody || len(*calls) != tc.calls {
				t.Fatalf("bad receipt accepted: %v calls=%d", err, len(*calls))
			}
		})
	}
}

func TestVideoMetadataRejectsTruncationAndDurationOverflow(t *testing.T) {
	data := videoFixture(t, 0)
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{"truncated", data[:len(data)-1]},
		{"only header", data[:24]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := t.TempDir() + "/video.mp4"
			if err := os.WriteFile(source, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
			if _, err := stageMedia(context.Background(), source, caps, false); err == nil {
				t.Fatal("incomplete MP4 accepted")
			}
		})
	}
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
	for _, ms := range []int64{499, 1200001} {
		if checkMediaFacts(caps, []mediaFacts{{MIME: "video/mp4", Bytes: 1000, DurationMS: ms}}, false) == nil {
			t.Fatal("invalid duration accepted")
		}
	}
	for _, ms := range []int64{500, 1200000} {
		if err := checkMediaFacts(caps, []mediaFacts{{MIME: "video/mp4", Bytes: 1000, DurationMS: ms}}, false); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMP4InspectsActualTimingDimensionsAndCodecs(t *testing.T) {
	for _, tc := range []struct {
		name, box string
		mutate    func([]byte, int)
	}{
		{"too long", "mvhd", func(data []byte, at int) {
			scale := binary.BigEndian.Uint32(data[at+16 : at+20])
			binary.BigEndian.PutUint32(data[at+20:at+24], scale*1201)
		}},
		{"zero clock", "mdhd", func(data []byte, at int) { binary.BigEndian.PutUint32(data[at+16:at+20], 0) }},
		{"frame rate", "stts", func(data []byte, at int) { binary.BigEndian.PutUint32(data[at+16:at+20], 1) }},
		{"tiny dimensions", "avc1", func(data []byte, at int) { binary.BigEndian.PutUint16(data[at+28:at+30], 31) }},
		{"unsupported codec", "avc1", func(data []byte, at int) { copy(data[at:at+4], "hvc1") }},
		{"surround audio", "mp4a", func(data []byte, at int) { binary.BigEndian.PutUint16(data[at+20:at+22], 6) }},
		{"oversized box", "moov", func(data []byte, at int) { binary.BigEndian.PutUint32(data[at-4:at], 0xffffffff) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := videoFixture(t, 0)
			at := bytes.Index(data, []byte(tc.box))
			if tc.box == "avc1" {
				at = bytes.LastIndex(data, []byte(tc.box))
			}
			if at < 4 {
				t.Fatal("missing fixture box")
			}
			tc.mutate(data, at)
			file := filepath.Join(t.TempDir(), "video.mp4")
			if err := os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
			if item, err := stageMedia(context.Background(), file, caps, false); err == nil {
				item.close()
				t.Fatal("invalid MP4 accepted")
			}
		})
	}
}

func FuzzInspectGIF(f *testing.F) {
	f.Add([]byte("GIF89a"))
	seed, _ := base64.StdEncoding.DecodeString("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")
	f.Add(seed)
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 15000000 {
			t.Skip()
		}
		_ = inspectGIF(data)
	})
}

func FuzzInspectMP4(f *testing.F) {
	seed, err := os.ReadFile("testdata/sample.mp4")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(seed)
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 1<<20 {
			t.Skip()
		}
		file, err := os.CreateTemp(t.TempDir(), "video-*")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
		_, _ = inspectMP4(context.Background(), file, int64(len(data)))
	})
}

// This verifies Shots' staged bytes and technical facts, not X's published resolution.
func TestTenMinute1080pSourcePreservedWithoutPremium(t *testing.T) {
	source := "testdata/ten-minute-1080p.mp4"
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
	item, err := stageMedia(context.Background(), source, caps, false)
	if err != nil {
		t.Fatal(err)
	}
	defer item.close()
	if item.facts.DurationMS != 600000 || item.facts.Width != 1920 || item.facts.Height != 1080 || item.facts.VideoCodec != "h264" {
		t.Fatalf("source facts lost: %+v", item.facts)
	}
	staged, err := os.ReadFile(item.file.Name())
	if err != nil || !bytes.Equal(staged, data) {
		t.Fatal("source was reduced or altered")
	}
}

func TestOversizeStaticImageIsResizedWithoutChangingSource(t *testing.T) {
	source := append(pngBytes(), make([]byte, 5000001)...)
	path := t.TempDir() + "/large.png"
	if err := os.WriteFile(path, source, 0600); err != nil {
		t.Fatal(err)
	}
	caps := socialidentity.XVerifiedAccountLimits("read-write", ptr("None"))
	staged, err := stageMedia(context.Background(), path, caps, false)
	if err != nil {
		t.Fatal(err)
	}
	defer staged.close()
	uploaded, err := os.ReadFile(staged.file.Name())
	if err != nil || len(uploaded) == 0 || int64(len(uploaded)) > caps.ImageMaxBytes || staged.facts.Bytes != int64(len(uploaded)) {
		t.Fatalf("invalid resized image: %+v %v", staged.facts, err)
	}
	if _, _, err := image.Decode(bytes.NewReader(uploaded)); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(original, source) {
		t.Fatal("workspace original was changed")
	}
}
